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

const DEBUG_ADS = String(process.env.DEBUG_ADS || "") === "1";

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
// Utils: числа / даты
// =====================================================
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;

  if (typeof v === "string") {
    const cleaned = v
      .replace(/\u00A0/g, " ")
      .replace(/\u202F/g, " ")
      .trim();

    const m = cleaned.match(/-?\d[\d\s.,]*/);
    if (!m) return 0;

    const numLike = m[0].replace(/\s+/g, "").replace(",", ".");
    const n = Number(numLike);
    return Number.isFinite(n) ? n : 0;
  }

  if (typeof v === "object") {
    if ("value" in v) return toNum(v.value);
    if ("amount" in v) return toNum(v.amount);
  }

  return 0;
}

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
        map[sku][m] = (map[sku][m] || 0) + toNum(row.metrics?.[i]);
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
    out[sku] = toNum(v.ordered_units);
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
      orders: toNum(v.ordered_units),
      revenue: toNum(v.revenue),
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
    out[sku] = toNum(v.returns);
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
      impressions: toNum(v.hits_view_search),
      clicks: toNum(v.hits_view_pdp),
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
      map[sku].ozon_stock += toNum(r.free_to_sell_amount);
      map[sku].in_transit += toNum(r.promised_amount);
    }

    if (rows.length < LIMIT) break;
    offset += LIMIT;
  }

  return map;
}

// =====================================================
// Performance API — LOCK + TOKEN + HELPERS
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

  const json = await res.json().catch(() => ({}));
  if (!json.access_token) return null;

  perfToken = json.access_token;
  perfTokenExpiresAt = now + Number(json.expires_in || 1800) * 1000;
  return perfToken;
}

async function perfFetch(method, pathUrl, body) {
  return withPerfLock(async () => {
    const token = await getPerfToken();
    if (!token) return { ok: false, status: 0, text: "NO_TOKEN" };

    const url = `${PERF_BASE_URL}${pathUrl}`;

    let attempt = 0;
    while (true) {
      attempt++;

      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          Accept: "application/json",
        },
        body: method === "POST" ? JSON.stringify(body || {}) : undefined,
      });

      if (res.status === 429) {
        if (attempt >= 8) {
          const text = await res.text().catch(() => "");
          return { ok: false, status: 429, text };
        }
        await sleep(1500 * attempt);
        continue;
      }

      const text = await res.text().catch(() => "");
      if (!res.ok) return { ok: false, status: res.status, text };

      return { ok: true, status: res.status, text };
    }
  });
}

async function perfGetJson(pathUrl) {
  const r = await perfFetch("GET", pathUrl);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text || "{}");
  } catch {
    return null;
  }
}

async function perfPostJson(pathUrl, body) {
  const r = await perfFetch("POST", pathUrl, body);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text || "{}");
  } catch {
    return null;
  }
}

// =====================================================
// Performance API — REPORT LIFECYCLE
// =====================================================
async function waitReportOk(uuid, { timeoutMs = 120_000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const st = await perfGetJson(
      `/api/client/statistics/${encodeURIComponent(uuid)}`
    );
    const state = st?.state || "";

    if (state === "OK" || state === "ERROR") return st;
    await sleep(1200);
  }

  return { UUID: uuid, state: "TIMEOUT" };
}

async function downloadReportByLink(linkPath) {
  const absUrl = linkPath.startsWith("http")
    ? linkPath
    : `${PERF_BASE_URL}${linkPath}`;

  const token = await getPerfToken();
  if (!token) return null;

  const res = await fetch(absUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) return null;

  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
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
    const hasAny = cached.map && Object.keys(cached.map).length > 0;
    if (hasAny) return cached.map;
    if (DEBUG_ADS) console.log("[ads] cache hit but empty -> rebuilding");
  }

  if (!PERF_CLIENT_ID || !PERF_CLIENT_SECRET) return {};

  try {
    const campaignsResp = await perfGetJson(
      "/api/client/campaign?advObjectType=SKU"
    );
    const list = campaignsResp?.list || [];
    const ids = list.map((c) => String(c.id || "").trim()).filter(Boolean);

    if (!ids.length) {
      adSpendCache.set(key, { ts: Date.now(), map: {} });
      saveAdCacheToDisk();
      return {};
    }

    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));

    const map = {};

    for (const campaigns of chunks) {
      const created = await perfPostJson("/api/client/statistics/json", {
        campaigns,
        dateFrom,
        dateTo,
        groupBy: "SKU",
      });

      const uuid = created?.UUID || created?.uuid;
      if (!uuid) {
        await sleep(1200);
        continue;
      }

      const st = await waitReportOk(uuid, { timeoutMs: 120_000 });
      if (st?.state !== "OK" || !st?.link) {
        await sleep(1200);
        continue;
      }

      const reportJson = await downloadReportByLink(st.link);
      if (!reportJson) {
        await sleep(1200);
        continue;
      }

      for (const campaignKey of Object.keys(reportJson)) {
        const rep = reportJson?.[campaignKey]?.report;
        if (!rep) continue;

        if (DEBUG_ADS) {
          const totalSpend = toNum(rep?.totals?.moneySpent);
          if (totalSpend > 0)
            console.log("[ads] campaign has spend:", campaignKey, totalSpend);
        }

        const rows = rep.rows;
        if (!Array.isArray(rows)) continue;

        for (const r of rows) {
          const sku = String(r?.sku || "").trim();
          if (!sku) continue;

          if (!map[sku]) map[sku] = { ad_spend: 0, clicks: 0, impressions: 0 };

          const spend =
            toNum(r?.moneySpent) ||
            toNum(r?.spend) ||
            toNum(r?.spent) ||
            toNum(r?.money_spent);

          const clicks =
            toNum(r?.clicks) || toNum(r?.click) || toNum(r?.openCard) || 0;

          const impr =
            toNum(r?.views) || toNum(r?.impressions) || toNum(r?.shows) || 0;

          map[sku].ad_spend += spend;
          map[sku].clicks += clicks;
          map[sku].impressions += impr;
        }
      }

      await sleep(900);
    }

    adSpendCache.set(key, { ts: Date.now(), map });
    saveAdCacheToDisk();
    return map;
  } catch (e) {
    if (DEBUG_ADS) console.log("[ads] ERROR:", e?.message || e);
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
