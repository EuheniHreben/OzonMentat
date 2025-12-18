// ozonCapabilityScanner.js
// Скрипт-сканнер: проверяет, какие метрики реально доступны через /v1/analytics/data
//
// Запуск:
//   node ozonCapabilityScanner.js
//   node ozonCapabilityScanner.js ordered_units revenue session_view
//
// Результат:
//   - выводит в консоль состояние по каждой метрике
//   - сохраняет карту возможностей в ozonMetricsCapabilities.json

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { ozonPost } = require("./ozonApi");
const { DAYS } = require("./config");

// --------- Кандидаты метрик, которые нас интересуют по воронке ---------
//
// Ты можешь дополнять этот список любыми подозрительными названиями.
// Скрипт покажет, что реально отрабатывает.
const DEFAULT_METRICS = [
  // то, что уже знаем
  "ordered_units",
  "revenue",
  "hits_view",
  "hits_view_search",
  "hits_view_pdp",
  "session_view",

  // гипотетические "элементы воронки"
  "add_to_cart",
  "add_to_cart_count",
  "add_to_basket",
  "to_cart",
  "basket",

  // возможные варианты из других док / старых версий
  "cart_adds",
  "conversion_to_cart",
  "conversion_to_purchase",
  "product_page_view",
];

// --------- Вспомогалки ---------

function formatDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function buildDateRange(days) {
  const today = new Date();
  const dateTo = formatDate(today);

  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1));
  const dateFrom = formatDate(from);

  return { dateFrom, dateTo };
}

// Аккуратный парсер ответа analytics/data
function extractRows(json) {
  const data =
    (json.result && Array.isArray(json.result.data) && json.result.data) ||
    json.data ||
    [];
  return data;
}

// --------- Тест одной метрики ---------

async function testMetric(metricName, opts = {}) {
  const days = opts.days || 7; // можно играться (7 / 30)
  const { dateFrom, dateTo } = buildDateRange(days);

  const body = {
    date_from: dateFrom,
    date_to: dateTo,
    metrics: [metricName],
    dimension: ["sku"],
    limit: 10,
    offset: 0,
  };

  console.log(`\n=== Тест метрики "${metricName}" ===`);

  try {
    const json = await ozonPost("/v1/analytics/data", body);
    const rows = extractRows(json);

    if (!rows.length) {
      console.log("Ответ OK, но данных нет (0 строк).");
      return {
        ok: true,
        hasData: false,
        error: null,
        sample: [],
      };
    }

    console.log(`Ответ OK, строк: ${rows.length}`);

    const sample = rows.slice(0, 3).map((row, i) => {
      const dims = row.dimensions || row.dimension || [];
      const metrics = row.metrics || [];
      const sku =
        (dims[0] && (dims[0].id || dims[0].value || "")) || "UNKNOWN_SKU";
      const value = metrics && metrics.length > 0 ? Number(metrics[0] || 0) : 0;

      console.log(`  [${i}] sku=${sku}, metric=${metricName}, value=${value}`);

      return { sku, metric: metricName, value };
    });

    return {
      ok: true,
      hasData: true,
      error: null,
      sample,
    };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);

    console.log("❌ Ошибка при запросе:");
    console.log("   " + msg);

    let type = "unknown";

    if (msg.includes("OZON 429")) {
      type = "rate_limit";
    } else if (
      msg.includes("Request validation error") &&
      msg.includes("AnalyticsGetDataRequest.Metrics")
    ) {
      // Это ровно то, что ты видел на add_to_cart / product_page_view и т.п.
      type = "invalid_metric";
    } else if (msg.includes("OZON 400")) {
      type = "bad_request";
    }

    return {
      ok: false,
      hasData: false,
      error: {
        type,
        message: msg,
      },
      sample: [],
    };
  }
}

// --------- Основной скрипт ---------

async function main() {
  // Метрики можно передавать через аргументы:
  // node ozonCapabilityScanner.js ordered_units session_view
  const args = process.argv.slice(2);
  const metrics = args.length ? args : DEFAULT_METRICS;

  console.log("Проверяю метрики:", metrics.join(", "));

  const results = {};
  const daysToUse = 30; // для сканера можно взять побольше период

  for (const metric of metrics) {
    // Небольшая задержка, чтобы не ловить 429 от Ozon каждую секунду
    // (если захочешь — увеличь timeout)
    /* eslint-disable no-await-in-loop */
    const res = await testMetric(metric, { days: daysToUse });
    results[metric] = {
      source: "/v1/analytics/data",
      days: daysToUse,
      ...res,
    };

    if (res.error && res.error.type === "rate_limit") {
      console.log(
        "⚠️ Поймали 429 (rate limit). Немного приторможу перед следующей метрикой."
      );
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      // маленькая пауза из уважения к API
      await new Promise((r) => setTimeout(r, 300));
    }
    /* eslint-enable no-await-in-loop */
  }

  const outPath = path.join(process.cwd(), "ozonMetricsCapabilities.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");

  console.log(
    `\n✅ Карта возможностей сохранена в: ${outPath}\n` +
      `   Теперь можно на основе неё проектировать новые слои воронки.`
  );
}

// Запуск
main().catch((e) => {
  console.error("Фатальная ошибка сканера:", e);
  process.exit(1);
});
