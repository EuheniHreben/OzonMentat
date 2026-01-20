// funnel.js (fixed for new structure)

const fs = require("fs");
const path = require("path");

const {
  ozonPost,
  getImpressionsClicks,
  getAdSpend,
  getStocksMap,
} = require("./ozonApi");

const productInfo = require("./productInfo");

const {
  DAYS,
  MAX_FUNNEL_HISTORY_DAYS: DEFAULT_MAX_FUNNEL_HISTORY_DAYS,
} = require("../config/config");

// История теперь лежит в /data
const FUNNEL_HISTORY_FILE = path.join(
  __dirname,
  "../../../data/funnelHistory.json",
);

// ✅ История снапшотов остатков (факт). Используется для графиков остатков.
const STOCK_SNAPSHOTS_FILE = path.join(
  __dirname,
  "../../../data/stockSnapshots.json",
);

/**
 * Runtime funnel config (from /data/funnelConfig.json)
 * Нужен чтобы UI-настройки применялись без перезапуска
 */
const FUNNEL_CONFIG_FILE = path.join(
  __dirname,
  "../../../data/funnelConfig.json",
);

// ------------------------------
// Пороги “минимальной достоверности” (как ADS_MIN_DATA, но для воронки)
// ------------------------------
const FUNNEL_MIN_DATA = {
  IMPRESSIONS: 200,
  CLICKS_FOR_CTR: 10,
  CLICKS_FOR_CONV: 25,
  ORDERS_FOR_CONV: 2,
  ORDERS_FOR_REFUND: 5,
};

// =====================================================
// Stock snapshots (FACT)
// =====================================================
function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJsonSafe(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    return true;
  } catch (e) {
    console.warn("⚠️ Не удалось записать JSON:", filePath, e.message);
    return false;
  }
}

function appendStockSnapshot(stocksMap, { maxDays = 180 } = {}) {
  // stocksMap: { [sku]: { ozon_stock, in_transit } }
  const ts = new Date().toISOString();

  const items = [];
  for (const [sku, v] of Object.entries(stocksMap || {})) {
    const skuKey = String(sku || "").trim();
    if (!skuKey) continue;
    const ozon_stock = Number(v?.ozon_stock || 0);
    const in_transit = Number(v?.in_transit || 0);
    items.push({ sku: skuKey, ozon_stock, in_transit });
  }

  const next = { timestamp: ts, items };

  const arr = readJsonSafe(STOCK_SNAPSHOTS_FILE, []);
  const snaps = Array.isArray(arr) ? arr : [];

  // анти-дубликат: если уже есть снапшот в эту минуту — заменим последний
  const last = snaps[snaps.length - 1];
  if (
    last?.timestamp &&
    String(last.timestamp).slice(0, 16) === ts.slice(0, 16)
  ) {
    snaps[snaps.length - 1] = next;
  } else {
    snaps.push(next);
  }

  // trim по дням (грубая обрезка по timestamp)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(1, Number(maxDays) || 180));
  const cutoffIso = cutoff.toISOString();
  const trimmed = snaps.filter((s) => String(s.timestamp || "") >= cutoffIso);

  writeJsonSafe(STOCK_SNAPSHOTS_FILE, trimmed);
}

const THRESHOLDS = {
  minImpressions: 100,
  minClicks: 30,
  minOrdersForStats: 5,

  ctrLow: 0.03,
  convLow: 0.05,

  refundWarn: 0.05,
  refundBad: 0.1,

  drrWarn: 0.3,
  drrBad: 0.5,
};

const DEFAULT_FUNNEL_CONFIG = {
  CTR_LOW: THRESHOLDS.ctrLow,
  CONV_LOW: THRESHOLDS.convLow,
  REFUND_WARN: THRESHOLDS.refundWarn,
  REFUND_BAD: THRESHOLDS.refundBad,
  DRR_WARN: THRESHOLDS.drrWarn,
  DRR_BAD: THRESHOLDS.drrBad,
  MATURITY_THRESHOLDS: { ...FUNNEL_MIN_DATA },
};

function loadFunnelRuntimeConfig() {
  const cfg = readJsonSafe(FUNNEL_CONFIG_FILE, null);
  if (!cfg || typeof cfg !== "object") return { ...DEFAULT_FUNNEL_CONFIG };

  return {
    ...DEFAULT_FUNNEL_CONFIG,
    ...cfg,
    MATURITY_THRESHOLDS: {
      ...DEFAULT_FUNNEL_CONFIG.MATURITY_THRESHOLDS,
      ...((cfg && cfg.MATURITY_THRESHOLDS) || {}),
    },
  };
}

function applyFunnelRuntimeConfig(cfg) {
  // thresholds
  THRESHOLDS.ctrLow = clamp(cfg.CTR_LOW, 0, 1);
  THRESHOLDS.convLow = clamp(cfg.CONV_LOW, 0, 1);
  THRESHOLDS.refundWarn = clamp(cfg.REFUND_WARN, 0, 1);
  THRESHOLDS.refundBad = clamp(cfg.REFUND_BAD, 0, 1);
  THRESHOLDS.drrWarn = clamp(cfg.DRR_WARN, 0, 10);
  THRESHOLDS.drrBad = clamp(cfg.DRR_BAD, 0, 10);

  // maturity thresholds
  const mt = cfg.MATURITY_THRESHOLDS || {};
  const asInt = (v, def) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(0, Math.round(n));
  };

  FUNNEL_MIN_DATA.IMPRESSIONS = asInt(
    mt.IMPRESSIONS,
    FUNNEL_MIN_DATA.IMPRESSIONS,
  );
  FUNNEL_MIN_DATA.CLICKS_FOR_CTR = asInt(
    mt.CLICKS_FOR_CTR,
    FUNNEL_MIN_DATA.CLICKS_FOR_CTR,
  );
  FUNNEL_MIN_DATA.CLICKS_FOR_CONV = asInt(
    mt.CLICKS_FOR_CONV,
    FUNNEL_MIN_DATA.CLICKS_FOR_CONV,
  );
  FUNNEL_MIN_DATA.ORDERS_FOR_CONV = asInt(
    mt.ORDERS_FOR_CONV,
    FUNNEL_MIN_DATA.ORDERS_FOR_CONV,
  );
  FUNNEL_MIN_DATA.ORDERS_FOR_REFUND = asInt(
    mt.ORDERS_FOR_REFUND,
    FUNNEL_MIN_DATA.ORDERS_FOR_REFUND,
  );
}

function ensureRuntimeConfigApplied() {
  try {
    const cfg = loadFunnelRuntimeConfig();
    applyFunnelRuntimeConfig(cfg);
  } catch (e) {
    // не падаем — просто останемся на дефолтах
  }
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(date, delta) {
  const d = new Date(date);
  d.setDate(d.getDate() + delta);
  return d;
}

function relDiff(cur, prev) {
  if (!prev || prev === 0) return 0;
  return (cur - prev) / prev;
}

function safeDiv(num, den) {
  if (!den || den === 0) return 0;
  return num / den;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

// ------------------------------
// Maturity helpers (коридор адекватности)
// ------------------------------
function getFunnelMaturity({ impressions = 0, clicks = 0, orders = 0 } = {}) {
  const imp = Number(impressions || 0);
  const clk = Number(clicks || 0);
  const ord = Number(orders || 0);

  const trafficOk =
    imp >= FUNNEL_MIN_DATA.IMPRESSIONS || clk >= FUNNEL_MIN_DATA.CLICKS_FOR_CTR;

  const cardOk =
    clk >= FUNNEL_MIN_DATA.CLICKS_FOR_CONV ||
    ord >= FUNNEL_MIN_DATA.ORDERS_FOR_CONV;

  const postOk = ord >= FUNNEL_MIN_DATA.ORDERS_FOR_REFUND;

  const overallOk = trafficOk || cardOk || postOk;

  return {
    overallOk,
    trafficOk,
    cardOk,
    postOk,
    thresholds: FUNNEL_MIN_DATA,
  };
}

// Универсальный парсер ответа /v1/analytics/data
function pickAnalyticsRows(json) {
  const data =
    (json &&
      json.result &&
      Array.isArray(json.result.data) &&
      json.result.data) ||
    (json && Array.isArray(json.data) && json.data) ||
    [];
  return Array.isArray(data) ? data : [];
}

function getDim(row, idx) {
  const dims = row.dimensions || row.dimension || [];
  const d = dims[idx];
  if (!d) return "";
  return String(d.id ?? d.value ?? d.name ?? "").trim();
}

function getMetric(row, idx) {
  const metrics = row.metrics || [];
  return Number(metrics[idx] || 0);
}

async function getPeriodMetrics(dateFrom, dateTo) {
  const LIMIT = 1000;
  let offset = 0;

  const metricsList = ["ordered_units", "revenue", "returns"];
  const map = {};

  while (true) {
    const body = {
      date_from: dateFrom,
      date_to: dateTo,
      metrics: metricsList,
      dimension: ["sku"],
      limit: LIMIT,
      offset,
    };

    const json = await ozonPost("/v1/analytics/data", body);
    const data = pickAnalyticsRows(json);

    if (!data.length) break;

    for (const row of data) {
      const skuKey = getDim(row, 0);
      if (!skuKey) continue;

      if (!map[skuKey]) map[skuKey] = { orders: 0, revenue: 0, returns: 0 };

      map[skuKey].orders += getMetric(row, 0);
      map[skuKey].revenue += getMetric(row, 1);
      map[skuKey].returns += getMetric(row, 2);
    }

    if (data.length < LIMIT) break;
    offset += LIMIT;
  }

  return map;
}

// ✅ daily sales: точки по дням для конкретного SKU
async function getDailySalesPoints(sku, days = 14) {
  const skuKey = String(sku || "").trim();
  if (!skuKey) return [];

  const today = new Date();
  const dateTo = formatDate(today);
  const dateFrom = formatDate(addDays(today, -(days - 1)));

  const candidates = [
    {
      date_from: dateFrom,
      date_to: dateTo,
      metrics: ["ordered_units"],
      dimension: ["day"],
      filters: [{ field: "sku", values: [skuKey] }],
      limit: 1000,
      offset: 0,
    },
    {
      date_from: dateFrom,
      date_to: dateTo,
      metrics: ["ordered_units"],
      dimension: ["day"],
      filter: { sku: [skuKey] },
      limit: 1000,
      offset: 0,
    },
    {
      date_from: dateFrom,
      date_to: dateTo,
      metrics: ["ordered_units"],
      dimension: ["sku", "day"],
      limit: 1000,
      offset: 0,
    },
  ];

  let rows = null;
  let used = null;

  for (const body of candidates) {
    try {
      const json = await ozonPost("/v1/analytics/data", body);
      const data = pickAnalyticsRows(json);
      if (Array.isArray(data) && data.length) {
        rows = data;
        used = body;
        break;
      }
    } catch (e) {}
  }

  if (!rows) return [];

  const map = new Map();

  for (const row of rows) {
    if (
      used.dimension &&
      used.dimension.length === 1 &&
      used.dimension[0] === "day"
    ) {
      const dayKey = getDim(row, 0);
      if (!dayKey) continue;
      const orders = getMetric(row, 0);
      map.set(dayKey, (map.get(dayKey) || 0) + orders);
      continue;
    }

    const skuDim = getDim(row, 0);
    const dayDim = getDim(row, 1);
    if (!skuDim || !dayDim) continue;
    if (String(skuDim) !== skuKey) continue;

    const orders = getMetric(row, 0);
    map.set(dayDim, (map.get(dayDim) || 0) + orders);
  }

  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = formatDate(addDays(today, -i));
    points.push({ date: d, orders: Number(map.get(d) || 0) });
  }

  return points;
}

// ✅ Дневные продажи + возвраты по SKU (нужно для приблизительной реконструкции остатков)
// Возвращает массив длины days: [{date, orders, returns}]
async function getDailyOrdersReturnsPoints(sku, days = 30) {
  const skuKey = String(sku || "").trim();
  if (!skuKey) return [];

  const today = new Date();
  const dateTo = formatDate(today);
  const dateFrom = formatDate(addDays(today, -(days - 1)));

  const metrics = ["ordered_units", "returns"];

  const candidates = [
    {
      date_from: dateFrom,
      date_to: dateTo,
      metrics,
      dimension: ["day"],
      filters: [{ field: "sku", values: [skuKey] }],
      limit: 1000,
      offset: 0,
    },
    {
      date_from: dateFrom,
      date_to: dateTo,
      metrics,
      dimension: ["day"],
      filter: { sku: [skuKey] },
      limit: 1000,
      offset: 0,
    },
    {
      date_from: dateFrom,
      date_to: dateTo,
      metrics,
      dimension: ["sku", "day"],
      limit: 1000,
      offset: 0,
    },
  ];

  let rows = null;
  let used = null;

  for (const body of candidates) {
    try {
      const json = await ozonPost("/v1/analytics/data", body);
      const data = pickAnalyticsRows(json);
      if (Array.isArray(data) && data.length) {
        rows = data;
        used = body;
        break;
      }
    } catch (e) {}
  }

  if (!rows) {
    // fallback: только заказы
    const onlyOrders = await getDailySalesPoints(skuKey, days);
    return (onlyOrders || []).map((p) => ({
      date: p.date,
      orders: Number(p.orders || 0),
      returns: 0,
    }));
  }

  const map = new Map(); // day -> {orders, returns}

  for (const row of rows) {
    // вариант dimension: ["day"]
    if (
      used.dimension &&
      used.dimension.length === 1 &&
      used.dimension[0] === "day"
    ) {
      const dayKey = getDim(row, 0);
      if (!dayKey) continue;
      const orders = getMetric(row, 0);
      const ret = getMetric(row, 1);
      const prev = map.get(dayKey) || { orders: 0, returns: 0 };
      map.set(dayKey, {
        orders: prev.orders + orders,
        returns: prev.returns + ret,
      });
      continue;
    }

    // вариант dimension: ["sku","day"]
    const skuDim = getDim(row, 0);
    const dayDim = getDim(row, 1);
    if (!skuDim || !dayDim) continue;
    if (String(skuDim) !== skuKey) continue;

    const orders = getMetric(row, 0);
    const ret = getMetric(row, 1);
    const prev = map.get(dayDim) || { orders: 0, returns: 0 };
    map.set(dayDim, {
      orders: prev.orders + orders,
      returns: prev.returns + ret,
    });
  }

  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = formatDate(addDays(today, -i));
    const v = map.get(d) || { orders: 0, returns: 0 };
    points.push({
      date: d,
      orders: Number(v.orders || 0),
      returns: Number(v.returns || 0),
    });
  }

  return points;
}

// диагностика
function classifyProblemSmart(params) {
  const {
    impressions = 0,
    clicks = 0,
    orders = 0,
    revenue = 0,
    ad_spend = 0,
    drr = 0,
    refund_rate = 0,
  } = params;

  const ctr = safeDiv(clicks, impressions);
  const conv = safeDiv(orders, clicks);

  const drrColor =
    drr > THRESHOLDS.drrBad ? "🟥" : drr > THRESHOLDS.drrWarn ? "🟨" : "🟩";

  const refundColor =
    refund_rate > THRESHOLDS.refundBad
      ? "🟥"
      : refund_rate > THRESHOLDS.refundWarn
        ? "🟨"
        : "🟩";

  let mainProblem = "нужен ручной разбор";
  let recommendation = "посмотреть цену, фото, описание, конкурентов";
  let stage = "неопределено";
  let priority = "средний";
  const tags = [];

  const maturity = getFunnelMaturity({ impressions, clicks, orders });

  if (
    impressions === 0 &&
    clicks === 0 &&
    orders === 0 &&
    revenue === 0 &&
    ad_spend === 0
  ) {
    stage = "нет данных";
    mainProblem = "нет трафика и продаж";
    recommendation =
      "проверить, опубликован ли товар, цену, скидки и категорию";
    priority = "низкий";
    tags.push("Ассортимент", "Публикация");
    return {
      mainProblem,
      recommendation,
      stage,
      priority,
      tags,
      drrColor,
      refundColor,
      ctr,
      conv,
      maturity,
    };
  }

  if (ad_spend > 0 && orders === 0) {
    stage = "реклама";
    mainProblem = "реклама тратится, заказов нет";
    recommendation =
      "урезать/остановить кампанию, проверить ключи/креативы, цену и конкурентов";
    priority = "высокий";
    tags.push("Реклама", "DRR");
    return {
      mainProblem,
      recommendation,
      stage,
      priority,
      tags,
      drrColor,
      refundColor,
      ctr,
      conv,
      maturity,
    };
  }

  if (!maturity.overallOk) {
    stage = "наблюдение";
    mainProblem = "мало данных для уверенных выводов";
    recommendation =
      "дать карточке набрать показы/клики/заказы; пока не резать по CTR/Conv/возвратам";
    priority = "низкий";
    tags.push("Наблюдение", "Мало данных");
    return {
      mainProblem,
      recommendation,
      stage,
      priority,
      tags,
      drrColor,
      refundColor,
      ctr,
      conv,
      maturity,
    };
  }

  if (maturity.postOk && refund_rate >= THRESHOLDS.refundBad) {
    stage = "послепродажа";
    mainProblem = "критично много возвратов";
    recommendation =
      "изучить причины возвратов и отзывы, поправить описание/фото/комплектацию/упаковку";
    priority = "высокий";
    tags.push("Возвраты", "Качество", "Ожидания");
    return {
      mainProblem,
      recommendation,
      stage,
      priority,
      tags,
      drrColor,
      refundColor,
      ctr,
      conv,
      maturity,
    };
  }

  if (maturity.postOk && refund_rate >= THRESHOLDS.refundWarn) {
    stage = "послепродажа";
    mainProblem = "повышенный уровень возвратов";
    recommendation =
      "проверить, не вводят ли в заблуждение фото/описание, есть ли повторяющиеся жалобы";
    priority = "средний";
    tags.push("Возвраты");
  }

  if (revenue > 0 && ad_spend > 0 && drr >= THRESHOLDS.drrBad) {
    stage = "реклама";
    mainProblem = "высокий DRR (реклама съедает маржу)";
    recommendation =
      "снизить ставки, отключить неэффективные кампании/фразы, усилить органику, поиграть ценой";
    priority = "высокий";
    tags.push("Реклама", "DRR");
    return {
      mainProblem,
      recommendation,
      stage,
      priority,
      tags,
      drrColor,
      refundColor,
      ctr,
      conv,
      maturity,
    };
  }

  if (maturity.trafficOk) {
    if (impressions > 0 && clicks === 0) {
      // Переходы в карточку: пользователь видит превью, но не кликает
      stage = "переходы";
      mainProblem = "показы есть, кликов нет";
      recommendation =
        "усилить главное фото/превью, название и цену на превью; проверить позицию в выдаче и бейджи";
      priority = "высокий";
      tags.push("Переходы", "CTR", "Превью");
      return {
        mainProblem,
        recommendation,
        stage,
        priority,
        tags,
        drrColor,
        refundColor,
        ctr,
        conv,
        maturity,
      };
    }

    if (ctr < THRESHOLDS.ctrLow) {
      // Дробим причины плохого CTR:
      // 1) если карточка конвертит (conv норм) — вероятнее слабое превью/главное фото
      // 2) если и CTR, и конверсия низкие — чаще цена/ожидание (особенно в склейках с одинаковыми фото)
      // 3) если данных по конверсии мало — не делаем сильных выводов, вероятнее релевантность/витрина
      stage = "переходы";

      // если по карточке ещё мало данных — не обвиняем цену/конверсию
      if (!maturity.cardOk) {
        mainProblem = "низкий CTR (мало кликов)";
        recommendation =
          "сначала добери клики (или показы): проверь релевантность названия/тегов/категории и качество превью; потом уже делай выводы про конверсию";
        priority = "низкий";
        tags.push("Переходы", "CTR", "Релевантность", "Мало данных");
      } else if (conv >= THRESHOLDS.convLow) {
        mainProblem = "слабое превью (не кликают)";
        recommendation =
          "карточка продаёт, но в неё не заходят — усили главное фото/обложку, бейджи, читаемость, УТП на превью";
        priority = "средний";
        tags.push("Переходы", "CTR", "Превью");
      } else {
        mainProblem = "цена/ожидание ломают клики";
        recommendation =
          "низкий CTR + низкая конверсия: проверь цену и промо (особенно если фото одинаковые в склейке), сравни с конкурентами и соседними SKU";
        priority = "средний";
        tags.push("Переходы", "Цена", "CTR", "Оффер");
      }
    }
  } else {
    if (stage === "неопределено") {
      stage = "наблюдение";
      mainProblem = "мало данных по трафику (CTR пока не показатель)";
      recommendation = `добрать статистику: ≥${FUNNEL_MIN_DATA.IMPRESSIONS} показов или ≥${FUNNEL_MIN_DATA.CLICKS_FOR_CTR} кликов`;
      priority = "низкий";
      tags.push("Мало данных");
    }
  }

  if (maturity.cardOk) {
    if (clicks > 0 && orders === 0) {
      stage = "намерение";
      mainProblem = "клики есть, заказов нет";
      recommendation =
        "проверь цену/промо, доставку и оффер; затем — фото/описание/отзывы. Если CTR норм — чаще проблема не в превью, а в цене/условиях";
      priority = "высокий";
      tags.push("Намерение", "Конверсия", "Цена/оффер");
      return {
        mainProblem,
        recommendation,
        stage,
        priority,
        tags,
        drrColor,
        refundColor,
        ctr,
        conv,
        maturity,
      };
    }

    if (conv < THRESHOLDS.convLow) {
      stage = "намерение";
      mainProblem = "низкая конверсия в покупку";
      recommendation =
        "если CTR норм — начни с цены/промо/доставки и оффера; затем усили карточку (фото внутри, преимущества, ответы на страхи, отзывы)";
      priority = "средний";
      tags.push("Намерение", "Конверсия");
    }
  } else {
    if (stage === "неопределено") {
      stage = "наблюдение";
      mainProblem = "мало данных по карточке (конверсия пока не показатель)";
      recommendation = `добрать статистику: ≥${FUNNEL_MIN_DATA.CLICKS_FOR_CONV} кликов или ≥${FUNNEL_MIN_DATA.ORDERS_FOR_CONV} заказов`;
      priority = "низкий";
      tags.push("Мало данных");
    }
  }

  // Масштабировать можно только если и переходы (CTR), и намерение (конверсия) в норме.
  if (
    maturity.postOk &&
    drrColor === "🟩" &&
    refundColor === "🟩" &&
    ctr >= THRESHOLDS.ctrLow &&
    conv >= THRESHOLDS.convLow
  ) {
    stage = "масштабирование";
    mainProblem = "карточка здорова, можно усиливать";
    recommendation =
      "следить за остатками, тестировать повышение цены/усиление рекламы и расширение ассортимента вокруг SKU";
    priority = "средний";
    tags.push("Масштабировать");
    return {
      mainProblem,
      recommendation,
      stage,
      priority,
      tags,
      drrColor,
      refundColor,
      ctr,
      conv,
      maturity,
    };
  }

  if (stage === "неопределено") stage = "общий анализ";

  return {
    mainProblem,
    recommendation,
    stage,
    priority,
    tags,
    drrColor,
    refundColor,
    ctr,
    conv,
    maturity,
  };
}

async function saveFunnelSnapshot(dateKey, days, rows, maxHistoryDays) {
  let history = {};
  try {
    if (fs.existsSync(FUNNEL_HISTORY_FILE)) {
      const raw = await fs.promises.readFile(FUNNEL_HISTORY_FILE, "utf8");
      if (raw.trim()) history = JSON.parse(raw);
    }
  } catch (e) {
    console.warn("⚠️ Не удалось прочитать funnelHistory.json:", e.message);
    history = {};
  }

  if (!history[dateKey]) history[dateKey] = {};
  history[dateKey][String(days)] = rows;

  const limit =
    Number(maxHistoryDays) && Number(maxHistoryDays) > 0
      ? Number(maxHistoryDays)
      : DEFAULT_MAX_FUNNEL_HISTORY_DAYS;

  const dateKeys = Object.keys(history).sort();
  if (dateKeys.length > limit) {
    const excess = dateKeys.length - limit;
    for (let i = 0; i < excess; i++) delete history[dateKeys[i]];
  }

  try {
    await fs.promises.writeFile(
      FUNNEL_HISTORY_FILE,
      JSON.stringify(history, null, 2),
      "utf8",
    );
  } catch (e) {
    console.warn("⚠️ Не удалось сохранить funnelHistory.json:", e.message);
  }
}

async function buildFunnel({
  days = 7,
  maxHistoryDays,
  adsEnabled = true,
} = {}) {
  console.log(`✔️ Строю воронку за последние ${days} дней...`);

  const today = new Date();
  const curTo = formatDate(today);
  const curFrom = formatDate(addDays(today, -(days - 1)));

  const prevToDate = addDays(today, -days);
  const prevTo = formatDate(prevToDate);
  const prevFrom = formatDate(addDays(prevToDate, -(days - 1)));

  const curMetrics = await getPeriodMetrics(curFrom, curTo);
  const prevMetrics = await getPeriodMetrics(prevFrom, prevTo);

  const mapViews = await getImpressionsClicks(days);

  let mapAds = {};
  if (adsEnabled) {
    mapAds = await getAdSpend(days);
  }

  const stocksMap = await getStocksMap();

  // ✅ Фиксируем факт-остатки (снапшот) при каждом обновлении воронки.
  // Это даёт честную историю остатков без привязки к прогрузчику.
  try {
    appendStockSnapshot(stocksMap);
  } catch (e) {
    console.warn("⚠️ Не удалось сохранить stock snapshot:", e.message);
  }

  const rows = [];

  const allProducts =
    typeof productInfo.getAll === "function" ? productInfo.getAll() : [];

  if (!allProducts.length) {
    console.warn("⚠️ buildFunnel: products.csv пустой -> []");
    return [];
  }

  for (const product of allProducts) {
    const skuKey = String(product.sku || "").trim();
    if (!skuKey || !product.offer_id) continue;

    const cur = curMetrics[skuKey] || {};
    const prev = prevMetrics[skuKey] || {};
    const v = mapViews[skuKey] || {};
    const a = mapAds[skuKey] || {};
    const s = stocksMap[skuKey] || {};

    const impressions = v.impressions || 0;
    const clicks = v.clicks || 0;

    const orders = cur.orders || 0;
    const revenue = cur.revenue || 0;
    const returns = cur.returns || 0;

    const prevOrders = prev.orders || 0;
    const prevRevenue = prev.revenue || 0;
    const prevReturns = prev.returns || 0;

    const ad_spend = a.ad_spend || 0;
    const ozon_stock = s.ozon_stock || 0;

    const drr = safeDiv(ad_spend, revenue);
    const avg_check = safeDiv(revenue, orders);

    const refund_rate_raw = safeDiv(returns, orders);
    const refund_rate = clamp(refund_rate_raw, 0, 1);

    const prevRefundRate = clamp(safeDiv(prevReturns, prevOrders), 0, 1);

    const problem = classifyProblemSmart({
      impressions,
      clicks,
      orders,
      revenue,
      ad_spend,
      drr,
      refund_rate,
    });

    const funnel_maturity =
      problem.maturity || getFunnelMaturity({ impressions, clicks, orders });

    rows.push({
      sku: skuKey,
      offer_id: product.offer_id,
      name: product.name || "",

      // ✅ Признак ручного отключения в products.csv
      // Используется UI (воронка), чтобы честно показывать "не участвует" и
      // не давать ложный тумблер там, где отключение задано в справочнике.
      disabled: !!product.disabled,

      impressions,
      clicks,
      orders,
      revenue: Number(revenue.toFixed(0)),
      ozon_stock,
      ad_spend: Number(ad_spend.toFixed(0)),
      drr,
      avg_check: Number(avg_check.toFixed(0)),
      returns,
      refund_rate,

      stage: problem.stage,
      priority: problem.priority,
      mainProblem: problem.mainProblem,
      recommendation: problem.recommendation,
      drrColor: problem.drrColor,
      refundColor: problem.refundColor,
      ctr: problem.ctr,
      conv: problem.conv,

      funnel_maturity,

      orders_prev: prevOrders,
      orders_change: relDiff(orders, prevOrders),

      revenue_prev: prevRevenue,
      revenue_change: relDiff(revenue, prevRevenue),

      refund_prev: prevRefundRate,
      refund_change: relDiff(refund_rate, prevRefundRate),
    });
  }

  rows.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));

  await saveFunnelSnapshot(curTo, days, rows, maxHistoryDays);

  return rows;
}

/**
 * Быстрый пересчёт стадий/цветов/рекомендаций на уже готовых rows
 * (без походов в OZON). Используется, чтобы "Сохранить" применялось мгновенно
 * и не ловить 429 от частых пересборок.
 */
function reclassifyFunnelRows(inputRows) {
  ensureRuntimeConfigApplied();

  const rows = Array.isArray(inputRows) ? inputRows : [];
  return rows.map((r) => {
    const impressions = Number(r.impressions || 0);
    const clicks = Number(r.clicks || 0);
    const orders = Number(r.orders || 0);
    const revenue = Number(r.revenue || 0);
    const ad_spend = Number(r.ad_spend || 0);
    const returns = Number(r.returns || 0);

    const drr = safeDiv(ad_spend, revenue);
    const refund_rate = clamp(safeDiv(returns, orders), 0, 1);

    const problem = classifyProblemSmart({
      impressions,
      clicks,
      orders,
      revenue,
      ad_spend,
      drr,
      refund_rate,
    });

    const funnel_maturity =
      problem.maturity || getFunnelMaturity({ impressions, clicks, orders });

    return {
      ...r,
      drr,
      refund_rate,
      stage: problem.stage,
      priority: problem.priority,
      mainProblem: problem.mainProblem,
      recommendation: problem.recommendation,
      drrColor: problem.drrColor,
      refundColor: problem.refundColor,
      ctr: problem.ctr,
      conv: problem.conv,
      funnel_maturity,
    };
  });
}

module.exports = {
  buildFunnel,
  reclassifyFunnelRows,
  getDailySalesPoints,
  getDailyOrdersReturnsPoints,
};
