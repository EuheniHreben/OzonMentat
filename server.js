require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");

// воронка
const { buildFunnel } = require("./funnel");
// прогрузчик
const { runLoader } = require("./loader");

// базовый конфиг (дефолты)
const {
  DEMAND_FACTOR,
  DAYS,
  DAYS_LONG,
  MIN_STOCK_DEFAULT,
  PACK_SIZE_DEFAULT,
  SALES_SMOOTHING_ALPHA,
  SPIKE_MULTIPLIER,
  SPIKE_CAP_MULTIPLIER,
  MAX_DAYS_OF_STOCK,
  MAX_LOADER_HISTORY_DAYS,
  MAX_FUNNEL_HISTORY_DAYS,
} = require("./config");

const app = express();
const PORT = 3000;

// статика
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// отдельная статика для Excel
const exportsDir = path.join(__dirname, "exports");
if (!fs.existsSync(exportsDir)) {
  fs.mkdirSync(exportsDir, { recursive: true });
}
app.use("/exports", express.static(exportsDir));

// ------------------------------
//  runtime-конфиг для прогрузчика/истории
// ------------------------------
const CONFIG_FILE = path.join(__dirname, "loaderConfig.json");

const defaultLoaderConfig = {
  DEMAND_FACTOR,
  DAYS,
  DAYS_LONG,
  MIN_STOCK_DEFAULT,
  PACK_SIZE_DEFAULT,
  SALES_SMOOTHING_ALPHA,
  SPIKE_MULTIPLIER,
  SPIKE_CAP_MULTIPLIER,
  MAX_DAYS_OF_STOCK,
  MAX_LOADER_HISTORY_DAYS,
  MAX_FUNNEL_HISTORY_DAYS,
};

function loadRuntimeConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...defaultLoaderConfig };
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    if (!raw.trim()) return { ...defaultLoaderConfig };
    const json = JSON.parse(raw);
    return { ...defaultLoaderConfig, ...json };
  } catch (e) {
    console.warn("⚠️ Не удалось прочитать loaderConfig.json:", e.message);
    return { ...defaultLoaderConfig };
  }
}

function saveRuntimeConfig(patch) {
  const current = loadRuntimeConfig();
  const updated = { ...current, ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

// 🔁 простой кэш результата /api/funnel
let lastFunnel = null;
let lastFunnelTs = 0;
let lastFunnelDays = null;
const CACHE_TTL_MS = 60 * 1000; // 60 секунд

// ------------------------------
//   Файл с disabled SKU для прогрузчика
// ------------------------------
const DISABLED_FILE = path.join(__dirname, "loaderDisabled.json");

function loadDisabledMap() {
  try {
    if (!fs.existsSync(DISABLED_FILE)) return {};
    const raw = fs.readFileSync(DISABLED_FILE, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.warn("⚠️ Не удалось прочитать loaderDisabled.json:", e.message);
    return {};
  }
}

function saveDisabledMap(map) {
  try {
    fs.writeFileSync(DISABLED_FILE, JSON.stringify(map, null, 2), "utf8");
  } catch (e) {
    console.warn("⚠️ Не удалось сохранить loaderDisabled.json:", e.message);
  }
}

// ------------------------------
//   Воронка
// ------------------------------
app.get("/api/funnel", async (req, res) => {
  const days = Number(req.query.days) || 7;
  const now = Date.now();

  const runtimeConfig = loadRuntimeConfig();
  const maxHistoryDays = runtimeConfig.MAX_FUNNEL_HISTORY_DAYS;

  if (
    lastFunnel &&
    lastFunnelDays === days &&
    now - lastFunnelTs < CACHE_TTL_MS
  ) {
    return res.json({
      ok: true,
      rows: lastFunnel,
      cached: true,
    });
  }

  try {
    const rows = await buildFunnel({ days, maxHistoryDays });

    lastFunnel = rows;
    lastFunnelTs = Date.now();
    lastFunnelDays = days;

    return res.json({
      ok: true,
      rows,
      cached: false,
    });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);

    console.error("❌ /api/funnel error:", msg);

    if (msg.includes("OZON 429")) {
      if (lastFunnel) {
        return res.json({
          ok: true,
          rows: lastFunnel,
          cached: true,
          stale: true,
          warning: "OZON 429: показаны кэшированные данные",
        });
      }

      return res.status(429).json({
        ok: false,
        rateLimit: true,
        error: msg,
      });
    }

    return res.status(500).json({
      ok: false,
      error: msg,
    });
  }
});

// ------------------------------
//   Прогрузчик
// ------------------------------
app.post("/api/loader/run", async (req, res) => {
  try {
    const runtimeConfig = loadRuntimeConfig();
    const result = await runLoader(runtimeConfig);

    const fileUrl = result.fileName
      ? `/exports/${encodeURIComponent(result.fileName)}`
      : null;

    return res.json({
      ok: true,
      updated: result.updated,
      fileName: result.fileName,
      fileUrl,
      items: result.allItems || result.shipment || [],
      config: runtimeConfig,
    });
  } catch (e) {
    console.error("❌ /api/loader/run error:", e);
    res.status(500).json({
      ok: false,
      error: e.message || String(e),
    });
  }
});

// ------------------------------
//   Конфиг прогрузчика (GET/POST)
// ------------------------------
app.get("/api/loader/config", (req, res) => {
  const cfg = loadRuntimeConfig();
  res.json({ ok: true, config: cfg });
});

app.post("/api/loader/config", (req, res) => {
  try {
    const allowedKeys = [
      "DEMAND_FACTOR",
      "DAYS",
      "DAYS_LONG",
      "MIN_STOCK_DEFAULT",
      "PACK_SIZE_DEFAULT",
      "SALES_SMOOTHING_ALPHA",
      "SPIKE_MULTIPLIER",
      "SPIKE_CAP_MULTIPLIER",
      "MAX_DAYS_OF_STOCK",
      "MAX_LOADER_HISTORY_DAYS",
      "MAX_FUNNEL_HISTORY_DAYS",
    ];

    const patch = {};

    for (const key of allowedKeys) {
      if (key in req.body) {
        const val = Number(req.body[key]);
        if (Number.isFinite(val)) {
          patch[key] = val;
        }
      }
    }

    const updated = saveRuntimeConfig(patch);
    res.json({ ok: true, config: updated });
  } catch (e) {
    console.error("❌ /api/loader/config error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ------------------------------
//   Вкл/выкл SKU для прогрузчика
// ------------------------------
app.get("/api/loader/disabled", (req, res) => {
  const map = loadDisabledMap();
  res.json({ ok: true, disabled: map });
});

app.post("/api/loader/disabled", (req, res) => {
  try {
    const { sku, disabled } = req.body || {};
    const skuKey = String(sku || "").trim();

    if (!skuKey) {
      return res.status(400).json({ ok: false, error: "sku не задан" });
    }

    const map = loadDisabledMap();

    if (disabled) {
      map[skuKey] = true;
    } else {
      delete map[skuKey];
    }

    saveDisabledMap(map);
    res.json({ ok: true, disabled: map });
  } catch (e) {
    console.error("❌ /api/loader/disabled error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dashboard доступен на http://localhost:${PORT}`);
});
