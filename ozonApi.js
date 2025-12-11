// ozonApi.js
//
// Обёртки над Ozon API:
//  - ozonPost
//  - getStocksMap
//  - getSalesMap / getWeekSalesMap
//  - getAnalyticsBySku
//  - getOrdersRevenue
//  - getReturns
//  - getImpressionsClicks
//  - getAdSpend (заглушка)

const { CLIENT_ID, API_KEY, BASE_URL, DAYS } = require("./config");

// В Node 18+ fetch есть глобально.
// Если Node 16 — нужно установить node-fetch и раскомментировать строку ниже:
// const fetch = global.fetch || require("node-fetch");

async function ozonPost(path, body) {
  const res = await fetch(BASE_URL + path, {
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
    throw new Error(`OZON ${res.status}: ${text}`);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(
      `Ошибка парсинга JSON от OZON: ${e.message}\nОтвет: ${text}`
    );
  }
}

// -------------------- Остатки + товары в пути --------------------

async function getStocksMap() {
  const map = {};
  const LIMIT = 1000;
  let offset = 0;

  while (true) {
    const body = {
      limit: LIMIT,
      offset,
      warehouse_type: "ALL",
    };

    const json = await ozonPost("/v2/analytics/stock_on_warehouses", body);

    const rows =
      (json.result && Array.isArray(json.result.rows) && json.result.rows) ||
      [];

    if (!rows.length) break;

    for (const row of rows) {
      const skuKey = String(row.sku || "").trim();
      if (!skuKey) continue;

      const free = Number(row.free_to_sell_amount || 0);
      const promised = Number(row.promised_amount || 0);
      const reserved = Number(row.reserved_amount || 0);

      if (!map[skuKey]) {
        map[skuKey] = {
          ozon_stock: 0,
          in_transit: 0,
          reserved: 0,
        };
      }

      map[skuKey].ozon_stock += free;
      map[skuKey].in_transit += promised;
      map[skuKey].reserved += reserved;
    }

    if (rows.length < LIMIT) break;
    offset += LIMIT;
  }

  return map;
}

// -------------------- Продажи за период (ordered_units) --------------------

function formatDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function getSalesMap(days) {
  const today = new Date();
  const dateTo = formatDate(today);

  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1));
  const dateFrom = formatDate(from);

  const body = {
    date_from: dateFrom,
    date_to: dateTo,
    metrics: ["ordered_units"], // <-- ВАЖНО: всегда есть metrics
    dimension: ["sku"],
    limit: 1000,
    offset: 0,
  };

  const json = await ozonPost("/v1/analytics/data", body);

  const map = {};
  const data =
    (json.result && Array.isArray(json.result.data) && json.result.data) ||
    json.data ||
    [];

  for (const row of data) {
    const dims = row.dimensions || row.dimension || [];
    const metrics = row.metrics || [];

    if (!dims.length || !metrics.length) continue;

    const skuKey = String(dims[0].id || dims[0].value || "").trim();
    const orderedUnits = Number(metrics[0] || 0);

    if (!skuKey) continue;
    map[skuKey] = (map[skuKey] || 0) + orderedUnits;
  }

  return map;
}

// для обратной совместимости с местами, где ждут "недельные" продажи
async function getWeekSalesMap() {
  return getSalesMap(DAYS);
}

// -------------------- Общий хелпер для аналитики по SKU --------------------

async function getAnalyticsBySku(metricsList) {
  const resultMap = {};

  const today = new Date();
  const dateTo = formatDate(today);

  const from = new Date(today);
  from.setDate(from.getDate() - (DAYS - 1));
  const dateFrom = formatDate(from);

  const LIMIT = 1000;
  let offset = 0;

  const body = {
    date_from: dateFrom,
    date_to: dateTo,
    metrics: metricsList, // например ["ordered_units", "revenue"]
    dimension: ["sku"],
    limit: LIMIT,
    offset: 0,
  };

  while (true) {
    body.offset = offset;

    const json = await ozonPost("/v1/analytics/data", body);

    const data =
      (json.result && Array.isArray(json.result.data) && json.result.data) ||
      json.data ||
      [];

    if (!data.length) break;

    for (const row of data) {
      const dims = row.dimensions || row.dimension || [];
      const metrics = row.metrics || [];

      if (!dims.length || !metrics.length) continue;

      const skuKey = String(dims[0].id || dims[0].value || "").trim();
      if (!skuKey) continue;

      if (!resultMap[skuKey]) {
        resultMap[skuKey] = {};
      }

      for (let i = 0; i < metrics.length && i < metricsList.length; i++) {
        const metricName = metricsList[i];
        const value = Number(metrics[i] || 0);
        resultMap[skuKey][metricName] =
          (resultMap[skuKey][metricName] || 0) + value;
      }
    }

    if (data.length < LIMIT) break;
    offset += LIMIT;
  }

  return resultMap;
}

// -------------------- Заказы + выручка --------------------

async function getOrdersRevenue() {
  const metricsList = ["ordered_units", "revenue"];

  const raw = await getAnalyticsBySku(metricsList);
  const map = {};

  for (const [sku, obj] of Object.entries(raw)) {
    const orders = Number(obj["ordered_units"] || 0);
    const revenue = Number(obj["revenue"] || 0);

    map[sku] = { orders, revenue };
  }

  return map;
}

// -------------------- Возвраты --------------------
// Если метрика returns не включена — просто будут нули.

async function getReturns() {
  const metricsList = ["returns"];

  let raw = {};
  try {
    raw = await getAnalyticsBySku(metricsList);
  } catch (e) {
    console.warn("⚠️ Не удалось получить returns, считаю возвраты = 0");
    return {};
  }

  const map = {};

  for (const [sku, obj] of Object.entries(raw)) {
    const returns = Number(obj["returns"] || 0);
    map[sku] = { returns };
  }

  return map;
}

// -------------------- Показы/клики --------------------

async function getImpressionsClicks() {
  const metricsList = ["hits_view", "hits_view_search", "hits_view_pdp"];

  let raw = {};
  try {
    raw = await getAnalyticsBySku(metricsList);
  } catch (e) {
    console.warn(
      "⚠️ Не удалось получить hits_view*/hits_view_pdp, считаю показы/клики = 0. Ошибка:",
      e.message || String(e)
    );
    return {};
  }

  const map = {};

  for (const [sku, obj] of Object.entries(raw)) {
    const impressionsSearch = Number(obj["hits_view_search"] || 0);
    const impressionsAll = Number(obj["hits_view"] || 0);
    const pdpViews = Number(obj["hits_view_pdp"] || 0);

    const impressions = impressionsSearch || impressionsAll;

    map[sku] = {
      impressions,
      clicks: pdpViews,
      impressions_all: impressionsAll,
      impressions_search: impressionsSearch,
      pdp_views: pdpViews,
    };
  }

  return map;
}

// -------------------- Реклама (заглушка) --------------------

async function getAdSpend() {
  console.warn(
    "⚠️ getAdSpend: реклама пока не подключена (нужен Performance API). Возвращаю нули."
  );
  return {};
}

module.exports = {
  ozonPost,
  getStocksMap,
  getSalesMap,
  getWeekSalesMap,
  getOrdersRevenue,
  getReturns,
  getImpressionsClicks,
  getAdSpend,
};
