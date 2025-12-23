require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");

const { buildFunnel, getDailySalesPoints } = require("./modules/funnel");
const { runLoader, openCutFolder } = require("./modules/loader");

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

  ADS_ENABLED,
  FUNNEL_MIN_REFRESH_MS,
  ADS_COOLDOWN_MS,
} = require("./config/config");

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "../../public")));
app.use(express.json());

const exportsDir = path.join(__dirname, "../../data/exports");
if (!fs.existsSync(exportsDir)) {
  fs.mkdirSync(exportsDir, { recursive: true });
}
app.use("/exports", express.static(exportsDir));

const CUT_DIR = path.join(__dirname, "../../public/cut");

// =====================================================
// Runtime-config
// =====================================================
const CONFIG_FILE = path.join(__dirname, "../../data/loaderConfig.json");

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

// =====================================================
// Funnel smart guard (keyed)
// =====================================================
const CACHE_TTL_MS = 60 * 1000;

const funnelCache = new Map(); // key -> { rows, ts }
const funnelInFlight = new Map(); // key -> Promise
const funnelNextAllowedAt = new Map(); // key -> ts

let adsCooldownUntil = 0;

function funnelKey({ days, adsEnabled }) {
  return `${days}|ads:${adsEnabled ? 1 : 0}`;
}

// =====================================================
// Disabled SKU
// =====================================================
const DISABLED_FILE = path.join(__dirname, "../../data/loaderDisabled.json");

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

// =====================================================
// API: FUNNEL
// =====================================================
app.get("/api/funnel", async (req, res) => {
  const days = Number(req.query.days) || 7;
  const now = Date.now();

  const runtimeConfig = loadRuntimeConfig();
  const maxHistoryDays = runtimeConfig.MAX_FUNNEL_HISTORY_DAYS;

  const adsEnabled = !!ADS_ENABLED && now >= adsCooldownUntil;
  const key = funnelKey({ days, adsEnabled });

  const cached = funnelCache.get(key);
  const nextAllowedAt = funnelNextAllowedAt.get(key) || 0;

  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return res.json({
      ok: true,
      rows: cached.rows,
      cached: true,
      note: "cache-ttl",
      adsEnabled,
    });
  }

  if (now < nextAllowedAt && cached) {
    const waitMs = nextAllowedAt - now;
    return res.json({
      ok: true,
      rows: cached.rows,
      cached: true,
      stale: true,
      adsEnabled,
      warning: `Частое обновление — показан кэш. Следующая сборка через ~${Math.ceil(
        waitMs / 1000
      )}с`,
    });
  }

  if (funnelInFlight.has(key)) {
    if (cached) {
      return res.json({
        ok: true,
        rows: cached.rows,
        cached: true,
        stale: true,
        adsEnabled,
        warning: "Сборка уже идёт — показан последний кэш",
      });
    }

    return res.status(202).json({
      ok: false,
      pending: true,
      message: "Сборка уже идёт, попробуй обновить через пару секунд",
      adsEnabled,
    });
  }

  funnelNextAllowedAt.set(key, now + FUNNEL_MIN_REFRESH_MS);

  const p = (async () => {
    try {
      const rows = await buildFunnel({
        days,
        maxHistoryDays,
        adsEnabled,
      });

      funnelCache.set(key, { rows, ts: Date.now() });

      return {
        ok: true,
        rows,
        cached: false,
        adsEnabled,
      };
    } catch (e) {
      const msg = String(e?.message || e);

      if (msg.includes("Performance") && msg.includes("429")) {
        adsCooldownUntil = Date.now() + ADS_COOLDOWN_MS;
      }

      if (msg.includes("OZON 429")) {
        const c = funnelCache.get(key);
        if (c) {
          return {
            ok: true,
            rows: c.rows,
            cached: true,
            stale: true,
            adsEnabled,
            warning: "OZON 429: показан кэш",
          };
        }
        return { ok: false, rateLimit: true, error: msg, adsEnabled };
      }

      return { ok: false, error: msg, adsEnabled };
    } finally {
      funnelInFlight.delete(key);
    }
  })();

  funnelInFlight.set(key, p);

  const result = await p;

  if (!result.ok) {
    if (result.rateLimit) return res.status(429).json(result);
    return res.status(500).json(result);
  }

  return res.json(result);
});

// ✅ NEW: API: FUNNEL DAILY SALES (для графика в боковой панели)
app.get("/api/funnel/daily-sales", async (req, res) => {
  try {
    const sku = String(req.query.sku || "").trim();
    const days = Number(req.query.days) || 14;

    if (!sku) {
      return res.status(400).json({ ok: false, error: "sku не задан" });
    }

    const points = await getDailySalesPoints(sku, days);
    return res.json({ ok: true, points });
  } catch (e) {
    console.error("❌ /api/funnel/daily-sales error:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// =====================================================
// API: LOADER
// =====================================================
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

app.post("/api/loader/open-cut-folder", (req, res) => {
  try {
    openCutFolder();
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ open-cut-folder:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/loader/cut-status", (req, res) => {
  try {
    if (!fs.existsSync(CUT_DIR)) {
      return res.json({ ok: true, hasFile: false, files: [] });
    }
    const files = fs.readdirSync(CUT_DIR).filter((f) => !f.startsWith("."));
    res.json({ ok: true, hasFile: files.length > 0, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================================
// API: CONFIG
// =====================================================
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

    // ✅ NEW: защита от “убийственных” значений
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const rules = {
      DEMAND_FACTOR: (v) => clamp(v, 0.2, 5),
      DAYS: (v) => clamp(Math.round(v), 1, 60),
      DAYS_LONG: (v) => clamp(Math.round(v), 1, 180),
      MIN_STOCK_DEFAULT: (v) => clamp(Math.round(v), 0, 999999),
      PACK_SIZE_DEFAULT: (v) => clamp(Math.round(v), 1, 999999),
      SALES_SMOOTHING_ALPHA: (v) => clamp(v, 0, 1),
      SPIKE_MULTIPLIER: (v) => clamp(v, 1, 50),
      SPIKE_CAP_MULTIPLIER: (v) => clamp(v, 0.1, 20),
      MAX_DAYS_OF_STOCK: (v) => clamp(Math.round(v), 1, 365),
      MAX_LOADER_HISTORY_DAYS: (v) => clamp(Math.round(v), 1, 5000),
      MAX_FUNNEL_HISTORY_DAYS: (v) => clamp(Math.round(v), 1, 5000),
    };

    const patch = {};
    for (const key of allowedKeys) {
      if (key in req.body) {
        const val = Number(req.body[key]);
        if (Number.isFinite(val)) {
          patch[key] = rules[key] ? rules[key](val) : val;
        }
      }
    }

    const updated = saveRuntimeConfig(patch);
    res.json({ ok: true, config: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================================
// API: DISABLED SKU
// =====================================================
app.get("/api/loader/disabled", (req, res) => {
  const map = loadDisabledMap();
  res.json({ ok: true, disabled: map });
});

app.post("/api/loader/disabled", (req, res) => {
  try {
    const { sku, disabled } = req.body || {};
    const skuKey = String(sku || "").trim();
    if (!skuKey)
      return res.status(400).json({ ok: false, error: "sku не задан" });

    const map = loadDisabledMap();
    if (disabled) map[skuKey] = true;
    else delete map[skuKey];

    saveDisabledMap(map);
    res.json({ ok: true, disabled: map });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================================
app.listen(PORT, () => {
  console.log(`🚀 Dashboard доступен на http://localhost:${PORT}`);
});
