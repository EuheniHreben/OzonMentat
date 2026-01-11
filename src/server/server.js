require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");

const { buildFunnel, getDailySalesPoints } = require("./modules/funnel");
const { runLoader, openCutFolder } = require("./modules/loader");

const {
  ROOT_DIR,
  DATA_DIR,
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

// ✅ Устойчивые пути (на случай, если структура проекта отличается)
const PUBLIC_DIR = fs.existsSync(path.join(ROOT_DIR, "public"))
  ? path.join(ROOT_DIR, "public")
  : path.join(__dirname, "../../public");

const DATA_DIR_EFFECTIVE = fs.existsSync(DATA_DIR)
  ? DATA_DIR
  : path.join(__dirname, "../../data");

app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// 📁 exports (в /data)
const exportsDir = path.join(DATA_DIR_EFFECTIVE, "exports");
if (!fs.existsSync(exportsDir)) {
  fs.mkdirSync(exportsDir, { recursive: true });
}
app.use("/exports", express.static(exportsDir));

const CUT_DIR = path.join(PUBLIC_DIR, "cut");

// =====================================================
// Runtime-configs (loader / funnel / ads)
// =====================================================
const CONFIG_DIR = DATA_DIR_EFFECTIVE;

const CONFIG_FILES = {
  loader: path.join(CONFIG_DIR, "loaderConfig.json"),
  funnel: path.join(CONFIG_DIR, "funnelConfig.json"),
  ads: path.join(CONFIG_DIR, "adsConfig.json"),
};

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

const defaultFunnelConfig = {
  CTR_LOW: 0.03,
  CONV_LOW: 0.05,
  REFUND_WARN: 0.05,
  REFUND_BAD: 0.1,
  DRR_WARN: 0.3,
  DRR_BAD: 0.5,
  MATURITY_THRESHOLDS: {
    IMPRESSIONS: 200,
    CLICKS_FOR_CTR: 10,
    CLICKS_FOR_CONV: 25,
    ORDERS_FOR_CONV: 2,
    ORDERS_FOR_REFUND: 5,
  },
};

const defaultAdsConfig = {
  ADS_THRESH: {
    CTR_LOW: 0.03,
    CTR_BAD: 0.015,
    CONV_LOW: 0.05,

    DRR_WARN: 0.3,
    DRR_BAD: 0.5,
    DRR_GOOD: 0.25,

    STOCK_BAD_DAYS: 3,
    STOCK_WARN_DAYS: 7,

    NO_ORDER_CLICKS_WARN: 25,
    NO_ORDER_CLICKS_BAD: 60,

    SPEND_WITHOUT_REVENUE_WARN: 700,
    SPEND_WITHOUT_REVENUE_BAD: 1500,
  },
  ADS_MIN_DATA: {
    IMPRESSIONS: 800,
    CLICKS: 20,
    SPEND: 300,
  },
  MIN_STOCK_DAYS_TO_RUN: 3,
  MIN_STOCK_DAYS_TO_SCALE: 7,
};

function loadJsonConfig(filePath, defaults) {
  try {
    if (!fs.existsSync(filePath)) return { ...defaults };
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return { ...defaults };
    const json = JSON.parse(raw);
    // shallow merge + nested for known objects
    const merged = { ...defaults, ...json };
    if (defaults.MATURITY_THRESHOLDS) {
      merged.MATURITY_THRESHOLDS = {
        ...defaults.MATURITY_THRESHOLDS,
        ...(json.MATURITY_THRESHOLDS || {}),
      };
    }
    if (defaults.ADS_THRESH) {
      merged.ADS_THRESH = {
        ...defaults.ADS_THRESH,
        ...(json.ADS_THRESH || {}),
      };
    }
    if (defaults.ADS_MIN_DATA) {
      merged.ADS_MIN_DATA = {
        ...defaults.ADS_MIN_DATA,
        ...(json.ADS_MIN_DATA || {}),
      };
    }
    return merged;
  } catch (e) {
    console.warn("⚠️ Не удалось прочитать конфиг:", filePath, e.message);
    return { ...defaults };
  }
}

function loadModuleConfig(moduleKey) {
  if (moduleKey === "loader")
    return loadJsonConfig(CONFIG_FILES.loader, defaultLoaderConfig);
  if (moduleKey === "funnel")
    return loadJsonConfig(CONFIG_FILES.funnel, defaultFunnelConfig);
  if (moduleKey === "ads")
    return loadJsonConfig(CONFIG_FILES.ads, defaultAdsConfig);
  return null;
}

function saveJsonConfig(filePath, defaults, patch) {
  const current = loadJsonConfig(filePath, defaults);
  const updated = { ...current, ...patch };
  // nested merges
  if (defaults.MATURITY_THRESHOLDS && patch.MATURITY_THRESHOLDS) {
    updated.MATURITY_THRESHOLDS = {
      ...current.MATURITY_THRESHOLDS,
      ...patch.MATURITY_THRESHOLDS,
    };
  }
  if (defaults.ADS_THRESH && patch.ADS_THRESH) {
    updated.ADS_THRESH = { ...current.ADS_THRESH, ...patch.ADS_THRESH };
  }
  if (defaults.ADS_MIN_DATA && patch.ADS_MIN_DATA) {
    updated.ADS_MIN_DATA = { ...current.ADS_MIN_DATA, ...patch.ADS_MIN_DATA };
  }
  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

function saveModuleConfig(moduleKey, patch) {
  if (moduleKey === "loader")
    return saveJsonConfig(CONFIG_FILES.loader, defaultLoaderConfig, patch);
  if (moduleKey === "funnel")
    return saveJsonConfig(CONFIG_FILES.funnel, defaultFunnelConfig, patch);
  if (moduleKey === "ads")
    return saveJsonConfig(CONFIG_FILES.ads, defaultAdsConfig, patch);
  return null;
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
// 🧩 Единый источник правды: disabled-SKU хранится в /data
const DISABLED_FILE = path.join(DATA_DIR_EFFECTIVE, "loaderDisabled.json");

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

  const runtimeConfig = loadModuleConfig("loader");
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
    const runtimeConfig = loadModuleConfig("loader");
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
// Унифицированный API (как у прогрузчика):
// GET  /api/config/:module   -> { ok, config }
// POST /api/config/:module   -> { ok, config }
// POST /api/config/:module/reset -> { ok, config }
app.get("/api/config/:module", (req, res) => {
  const moduleKey = String(req.params.module || "").trim();
  const cfg = loadModuleConfig(moduleKey);
  if (!cfg) return res.status(404).json({ ok: false, error: "unknown-module" });
  return res.json({ ok: true, config: cfg });
});

app.post("/api/config/:module/reset", (req, res) => {
  try {
    const moduleKey = String(req.params.module || "").trim();
    const filePath = CONFIG_FILES[moduleKey];
    if (!filePath)
      return res.status(404).json({ ok: false, error: "unknown-module" });

    // перезаписать файл дефолтами (без merge)
    let defaults = null;
    if (moduleKey === "loader") defaults = defaultLoaderConfig;
    if (moduleKey === "funnel") defaults = defaultFunnelConfig;
    if (moduleKey === "ads") defaults = defaultAdsConfig;
    if (!defaults)
      return res.status(404).json({ ok: false, error: "unknown-module" });

    fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), "utf8");
    return res.json({ ok: true, config: { ...defaults } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/config/:module", (req, res) => {
  try {
    const moduleKey = String(req.params.module || "").trim();
    if (!CONFIG_FILES[moduleKey])
      return res.status(404).json({ ok: false, error: "unknown-module" });

    // ✅ базовый clamp
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

    let patch = {};

    if (moduleKey === "loader") {
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

      for (const key of allowedKeys) {
        if (key in (req.body || {})) {
          const val = Number(req.body[key]);
          if (Number.isFinite(val))
            patch[key] = rules[key] ? rules[key](val) : val;
        }
      }
    }

    if (moduleKey === "funnel") {
      const b = req.body || {};
      const num = (v, min, max) =>
        Number.isFinite(Number(v)) ? clamp(Number(v), min, max) : undefined;

      patch = {
        CTR_LOW: num(b.CTR_LOW, 0, 1),
        CONV_LOW: num(b.CONV_LOW, 0, 1),
        REFUND_WARN: num(b.REFUND_WARN, 0, 1),
        REFUND_BAD: num(b.REFUND_BAD, 0, 1),
        DRR_WARN: num(b.DRR_WARN, 0, 10),
        DRR_BAD: num(b.DRR_BAD, 0, 10),
      };

      const mt = b.MATURITY_THRESHOLDS || {};
      const int = (v, min, max) =>
        Number.isFinite(Number(v))
          ? clamp(Math.round(Number(v)), min, max)
          : undefined;
      const mtPatch = {
        IMPRESSIONS: int(mt.IMPRESSIONS, 0, 1_000_000),
        CLICKS_FOR_CTR: int(mt.CLICKS_FOR_CTR, 0, 1_000_000),
        CLICKS_FOR_CONV: int(mt.CLICKS_FOR_CONV, 0, 1_000_000),
        ORDERS_FOR_CONV: int(mt.ORDERS_FOR_CONV, 0, 1_000_000),
        ORDERS_FOR_REFUND: int(mt.ORDERS_FOR_REFUND, 0, 1_000_000),
      };
      Object.keys(mtPatch).forEach(
        (k) => mtPatch[k] === undefined && delete mtPatch[k]
      );
      if (Object.keys(mtPatch).length) patch.MATURITY_THRESHOLDS = mtPatch;
    }

    if (moduleKey === "ads") {
      const b = req.body || {};
      const num = (v, min, max) =>
        Number.isFinite(Number(v)) ? clamp(Number(v), min, max) : undefined;
      const int = (v, min, max) =>
        Number.isFinite(Number(v))
          ? clamp(Math.round(Number(v)), min, max)
          : undefined;

      const th = b.ADS_THRESH || {};
      const md = b.ADS_MIN_DATA || {};

      const thPatch = {
        DRR_GOOD: num(th.DRR_GOOD, 0, 10),
        DRR_WARN: num(th.DRR_WARN, 0, 10),
        DRR_BAD: num(th.DRR_BAD, 0, 10),
        CTR_LOW: num(th.CTR_LOW, 0, 1),
        CTR_BAD: num(th.CTR_BAD, 0, 1),
        CONV_LOW: num(th.CONV_LOW, 0, 1),
        STOCK_BAD_DAYS: int(th.STOCK_BAD_DAYS, 0, 365),
        STOCK_WARN_DAYS: int(th.STOCK_WARN_DAYS, 0, 365),
        NO_ORDER_CLICKS_WARN: int(th.NO_ORDER_CLICKS_WARN, 0, 1_000_000),
        NO_ORDER_CLICKS_BAD: int(th.NO_ORDER_CLICKS_BAD, 0, 1_000_000),
        SPEND_WITHOUT_REVENUE_WARN: int(
          th.SPEND_WITHOUT_REVENUE_WARN,
          0,
          1_000_000_000
        ),
        SPEND_WITHOUT_REVENUE_BAD: int(
          th.SPEND_WITHOUT_REVENUE_BAD,
          0,
          1_000_000_000
        ),
      };
      Object.keys(thPatch).forEach(
        (k) => thPatch[k] === undefined && delete thPatch[k]
      );

      const mdPatch = {
        IMPRESSIONS: int(md.IMPRESSIONS, 0, 1_000_000_000),
        CLICKS: int(md.CLICKS, 0, 1_000_000_000),
        SPEND: int(md.SPEND, 0, 1_000_000_000),
      };
      Object.keys(mdPatch).forEach(
        (k) => mdPatch[k] === undefined && delete mdPatch[k]
      );

      patch = {
        ADS_THRESH: thPatch,
        ADS_MIN_DATA: mdPatch,
        MIN_STOCK_DAYS_TO_RUN: int(b.MIN_STOCK_DAYS_TO_RUN, 0, 365),
        MIN_STOCK_DAYS_TO_SCALE: int(b.MIN_STOCK_DAYS_TO_SCALE, 0, 365),
      };
      Object.keys(patch).forEach(
        (k) => patch[k] === undefined && delete patch[k]
      );
      if (patch.ADS_THRESH && Object.keys(patch.ADS_THRESH).length === 0)
        delete patch.ADS_THRESH;
      if (patch.ADS_MIN_DATA && Object.keys(patch.ADS_MIN_DATA).length === 0)
        delete patch.ADS_MIN_DATA;
    }

    const updated = saveModuleConfig(moduleKey, patch);
    return res.json({ ok: true, config: updated });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/loader/config", (req, res) => {
  const cfg = loadModuleConfig("loader");
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

    const updated = saveModuleConfig("loader", patch);
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
