require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  CLIENT_ID,
  API_KEY,
  BASE_URL,
  DAYS,
  PERF_BASE_URL,
  PERF_CLIENT_ID,
  PERF_CLIENT_SECRET,
  AD_CACHE_TTL_MS,
} = require("./config");

// =====================================================
// Seller API — базовый POST
// =====================================================
async function ozonPost(pathUrl, body) {
  const url = `${BASE_URL}${pathUrl}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Client-Id": CLIENT_ID,
      "Api-Key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`OZON ${res.status} ${pathUrl}: ${text.slice(0, 500)}`);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// =====================================================
// Даты
// =====================================================
function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(date, delta) {
  const d = new Date(date);
  d.setDate(d.getDate() + delta);
  return d;
}

// =====================================================
// Analytics by SKU
// =====================================================
async function analyticsBySku({ dateFrom, dateTo, metrics }) {
  const LIMIT = 1000;
  let offset = 0;
  const map = {};

  while (true) {
    const body = {
      date_from: dateFrom,
      date_to: dateTo,
      metrics,
      dimension: ["sku"],
      limit: LIMIT,
      offset,
    };

    const json = await ozonPost("/v1/analytics/data", body);
    const data = json?.result?.data || [];

    if (!data.length) break;

    for (const row of data) {
      const sku = String(row.dimensions?.[0]?.id || "").trim();
      if (!sku) continue;

      if (!map[sku]) map[sku] = {};
      metrics.forEach((m, i) => {
        map[sku][m] = (map[sku][m] || 0) + Number(row.metrics?.[i] || 0);
      });
    }

    if (data.length < LIMIT) break;
    offset += LIMIT;
  }

  return map;
}

// =====================================================
// Продажи / возвраты / показы
// =====================================================
async function getSalesMap(days = DAYS) {
  const to = formatDate(new Date());
  const from = formatDate(addDays(new Date(), -(days - 1)));

  const raw = await analyticsBySku({
    dateFrom: from,
    dateTo: to,
    metrics: ["ordered_units"],
  });

  const out = {};
  for (const [sku, v] of Object.entries(raw)) {
    out[sku] = Number(v.ordered_units || 0);
  }
  return out;
}

async function getWeekSalesMap(days = DAYS) {
  const to = formatDate(new Date());
  const from = formatDate(addDays(new Date(), -(days - 1)));

  const raw = await analyticsBySku({
    dateFrom: from,
    dateTo: to,
    metrics: ["ordered_units", "revenue"],
  });

  const out = {};
  for (const [sku, v] of Object.entries(raw)) {
    out[sku] = {
      orders: Number(v.ordered_units || 0),
      revenue: Number(v.revenue || 0),
    };
  }
  return out;
}

async function getReturns(days = DAYS) {
  const to = formatDate(new Date());
  const from = formatDate(addDays(new Date(), -(days - 1)));

  const raw = await analyticsBySku({
    dateFrom: from,
    dateTo: to,
    metrics: ["returns"],
  });

  const out = {};
  for (const [sku, v] of Object.entries(raw)) {
    out[sku] = Number(v.returns || 0);
  }
  return out;
}

async function getImpressionsClicks(days = DAYS) {
  const to = formatDate(new Date());
  const from = formatDate(addDays(new Date(), -(days - 1)));

  const raw = await analyticsBySku({
    dateFrom: from,
    dateTo: to,
    metrics: ["hits_view_search", "hits_view_pdp"],
  });

  const out = {};
  for (const [sku, v] of Object.entries(raw)) {
    out[sku] = {
      impressions: Number(v.hits_view_search || 0),
      clicks: Number(v.hits_view_pdp || 0),
    };
  }
  return out;
}

// =====================================================
// Остатки
// =====================================================
async function getStocksMap() {
  const LIMIT = 1000;
  let offset = 0;
  const map = {};

  while (true) {
    const json = await ozonPost("/v2/analytics/stock_on_warehouses", {
      limit: LIMIT,
      offset,
      warehouse_type: "ALL",
    });

    const rows = json?.result?.rows || [];
    if (!rows.length) break;

    for (const r of rows) {
      const sku = String(r.sku || "").trim();
      if (!sku) continue;

      if (!map[sku]) map[sku] = { ozon_stock: 0, in_transit: 0 };
      map[sku].ozon_stock += Number(r.free_to_sell_amount || 0);
      map[sku].in_transit += Number(r.promised_amount || 0);
    }

    if (rows.length < LIMIT) break;
    offset += LIMIT;
  }

  return map;
}

// =====================================================
// Performance API — LOCK + TOKEN
// =====================================================
let perfToken = null;
let perfTokenExpiresAt = 0;
let perfLock = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withPerfLock(fn) {
  const next = perfLock.then(fn, fn);
  perfLock = next.catch(() => {});
  return next;
}

async function getPerfToken() {
  const now = Date.now();
  if (perfToken && now < perfTokenExpiresAt - 60_000) return perfToken;
  if (!PERF_CLIENT_ID || !PERF_CLIENT_SECRET) return null;

  const res = await fetch(`${PERF_BASE_URL}/api/client/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: PERF_CLIENT_ID,
      client_secret: PERF_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  const json = await res.json();
  if (!json.access_token) return null;

  perfToken = json.access_token;
  perfTokenExpiresAt = now + Number(json.expires_in || 3600) * 1000;
  return perfToken;
}

async function perfPost(pathUrl, body) {
  return withPerfLock(async () => {
    const token = await getPerfToken();
    if (!token) return null;

    let attempt = 0;
    while (true) {
      attempt++;
      const res = await fetch(`${PERF_BASE_URL}${pathUrl}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
      });

      if (res.status === 429) {
        if (attempt >= 5) return null;
        await sleep(5000 * attempt);
        continue;
      }

      if (!res.ok) return null;
      return res.json();
    }
  });
}

// =====================================================
// Реклама — КЭШ + ДИСК
// =====================================================
const adSpendCache = new Map();
const AD_CACHE_FILE = path.join(__dirname, "adSpendCache.json");

let diskCacheLoaded = false;

function loadAdCacheFromDisk() {
  try {
    if (!fs.existsSync(AD_CACHE_FILE)) return;
    const raw = fs.readFileSync(AD_CACHE_FILE, "utf8");
    const json = JSON.parse(raw);
    for (const [k, v] of Object.entries(json)) {
      adSpendCache.set(k, v);
    }
  } catch {}
}

function saveAdCacheToDisk() {
  try {
    fs.writeFileSync(
      AD_CACHE_FILE,
      JSON.stringify(Object.fromEntries(adSpendCache.entries()), null, 2),
      "utf8"
    );
  } catch {}
}

// =====================================================
// getAdSpend (ПО SKU)
// =====================================================
async function getAdSpend(days = DAYS) {
  const today = new Date();
  const dateTo = formatDate(today);
  const dateFrom = formatDate(addDays(today, -(days - 1)));
  const key = `ads:${days}:${dateFrom}:${dateTo}`;

  if (!diskCacheLoaded) {
    diskCacheLoaded = true;
    loadAdCacheFromDisk();
  }

  const cached = adSpendCache.get(key);
  if (cached && Date.now() - cached.ts < AD_CACHE_TTL_MS) {
    return cached.map;
  }

  if (!PERF_CLIENT_ID || !PERF_CLIENT_SECRET) return {};

  try {
    const campaignsResp = await perfPost("/api/client/campaign", {
      advObjectType: "SKU",
    });

    const list = campaignsResp?.list || [];
    const ids = list.map((c) => c.id).filter(Boolean);

    if (!ids.length) {
      adSpendCache.set(key, { ts: Date.now(), map: {} });
      saveAdCacheToDisk();
      return {};
    }

    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) {
      chunks.push(ids.slice(i, i + 10));
    }

    const map = {};

    for (const campaigns of chunks) {
      const stats = await perfPost("/api/client/statistics/json", {
        campaigns,
        dateFrom,
        dateTo,
        groupBy: "SKU",
      });

      const rows = stats?.rows || [];
      for (const r of rows) {
        const sku = String(r.sku || "").trim();
        if (!sku) continue;

        if (!map[sku]) map[sku] = { ad_spend: 0, clicks: 0, impressions: 0 };

        map[sku].ad_spend += Number(r.spend || 0);
        map[sku].clicks += Number(r.clicks || 0);
        map[sku].impressions += Number(r.impressions || 0);
      }

      await sleep(1500);
    }

    adSpendCache.set(key, { ts: Date.now(), map });
    saveAdCacheToDisk();
    return map;
  } catch (e) {
    adSpendCache.set(key, { ts: Date.now(), map: {} });
    saveAdCacheToDisk();
    return {};
  }
}

// =====================================================
// EXPORT
// =====================================================
module.exports = {
  ozonPost,
  analyticsBySku,

  getImpressionsClicks,
  getStocksMap,

  getSalesMap,
  getWeekSalesMap,
  getReturns,

  getAdSpend,
};
