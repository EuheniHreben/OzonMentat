// funnel.js

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
} = require("./config");

const FUNNEL_HISTORY_FILE = path.join(__dirname, "funnelHistory.json");

// пороги
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

      if (!map[skuKey]) {
        map[skuKey] = { orders: 0, revenue: 0, returns: 0 };
      }

      map[skuKey].orders += Number(metrics[0] || 0);
      map[skuKey].revenue += Number(metrics[1] || 0);
      map[skuKey].returns += Number(metrics[2] || 0);
    }

    if (data.length < LIMIT) break;
    offset += LIMIT;
  }

  return map;
}

function safeDiv(num, den) {
  if (!den || den === 0) return 0;
  return num / den;
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
    };
  }

  if (ad_spend > 0 && orders === 0) {
    stage = "реклама";
    mainProblem = "реклама тратится, заказов нет";
    recommendation =
      "остановить/урезать кампанию, проверить ключи и креативы, цену и конкурентов";
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
    };
  }

  if (
    orders >= THRESHOLDS.minOrdersForStats &&
    refund_rate >= THRESHOLDS.refundBad
  ) {
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
    };
  }

  if (refund_rate >= THRESHOLDS.refundWarn) {
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
    };
  }

  if (impressions >= THRESHOLDS.minImpressions) {
    if (clicks === 0) {
      stage = "показы";
      mainProblem = "показы есть, кликов нет";
      recommendation =
        "работать с первым фото, ценой, названием; проверить промо и позицию в выдаче";
      priority = "высокий";
      tags.push("CTR", "Витрина");
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
      };
    }

    if (ctr < THRESHOLDS.ctrLow) {
      stage = "показы";
      mainProblem = "низкий CTR (карточку мало открывают)";
      recommendation =
        "прокачать главное фото, название, цену и бейджи; посмотреть выдачу конкурентов";
      priority = "средний";
      tags.push("CTR");
    }
  }

  if (clicks >= THRESHOLDS.minClicks) {
    if (orders === 0) {
      stage = "карточка";
      mainProblem = "кликов много, заказов нет";
      recommendation =
        "перепроверить цену, описание, фото, отзывы и конкурентов; возможно, товар смотрят как эталон";
      priority = "высокий";
      tags.push("Конверсия", "Карточка");
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
      };
    }

    if (conv < THRESHOLDS.convLow) {
      stage = "карточка";
      mainProblem = "низкая конверсия в заказ";
      recommendation =
        "усилить фото внутри карточки, блок преимуществ, ответы на страхи, поиграть с ценой и промо";
      priority = "средний";
      tags.push("Конверсия");
    }
  }

  if (orders > 0 && orders < THRESHOLDS.minOrdersForStats) {
    stage = "наблюдение";
    mainProblem = "мало данных для уверенных выводов";
    recommendation =
      "дать карточке дособрать статистику, аккуратно следить за отзывами и динамикой";
    priority = "низкий";
    tags.push("Наблюдение");
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
    };
  }

  if (
    orders >= THRESHOLDS.minOrdersForStats &&
    drrColor === "🟩" &&
    refundColor === "🟩"
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
    };
  }

  if (stage === "неопределено") {
    stage = "общий анализ";
  }

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
  };
}

// сохранение снимка
async function saveFunnelSnapshot(dateKey, days, rows, maxHistoryDays) {
  let history = {};
  try {
    if (fs.existsSync(FUNNEL_HISTORY_FILE)) {
      const raw = await fs.promises.readFile(FUNNEL_HISTORY_FILE, "utf8");
      if (raw.trim()) {
        history = JSON.parse(raw);
      }
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
    for (let i = 0; i < excess; i++) {
      delete history[dateKeys[i]];
    }
  }

  try {
    await fs.promises.writeFile(
      FUNNEL_HISTORY_FILE,
      JSON.stringify(history, null, 2),
      "utf8"
    );
  } catch (e) {
    console.warn("⚠️ Не удалось сохранить funnelHistory.json:", e.message);
  }
}

// главный конструктор воронки
async function buildFunnel({ days = 7, maxHistoryDays } = {}) {
  console.log(`✔️ Строю воронку за последние ${days} дней...`);

  const today = new Date();
  const curTo = formatDate(today);
  const curFrom = formatDate(addDays(today, -(days - 1)));

  const prevToDate = addDays(today, -days);
  const prevTo = formatDate(prevToDate);
  const prevFrom = formatDate(addDays(prevToDate, -(days - 1)));

  // текущий период
  const curMetrics = await getPeriodMetrics(curFrom, curTo);
  // прошлый период
  const prevMetrics = await getPeriodMetrics(prevFrom, prevTo);

  // показы/клики
  const mapViews = await getImpressionsClicks();
  // реклама (пока заглушка)
  const mapAds = await getAdSpend();
  // остатки
  const stocksMap = await getStocksMap();

  const rows = [];

  // 🔥 ГЛАВНОЕ ИЗМЕНЕНИЕ:
  // теперь воронка строится по ВСЕМ товарам из products.csv,
  // даже если по ним нет продаж/показов/остатков в аналитике.
  const allProducts =
    typeof productInfo.getAll === "function" ? productInfo.getAll() : [];

  if (!allProducts.length) {
    console.warn(
      "⚠️ buildFunnel: productInfo.getAll() вернул пустой список — воронка будет пустой"
    );
    return [];
  }

  for (const product of allProducts) {
    const skuKey = String(product.sku || "").trim();
    if (!skuKey || !product.offer_id) {
      continue;
    }

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
    const refund_rate = safeDiv(returns, orders);

    const prevRefundRate = safeDiv(prevReturns, prevOrders);

    const problem = classifyProblemSmart({
      impressions,
      clicks,
      orders,
      revenue,
      ad_spend,
      drr,
      refund_rate,
    });

    rows.push({
      sku: skuKey,
      offer_id: product.offer_id,
      name: product.name || "",

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

module.exports = {
  buildFunnel,
};
