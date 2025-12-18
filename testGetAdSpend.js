// testGetAdSpend.js
require("dotenv").config();

const { getAdSpend } = require("./ozonApi");

const WATCH = [
  "2354071804",
  "2354085122",
  "2899071764",
];

function topKeys(obj, n = 20) {
  return Object.keys(obj || {}).slice(0, n);
}

async function main() {
  const days = 7;

  console.log("ENV PERF_BASE_URL:", process.env.OZON_PERF_BASE_URL || "https://api-performance.ozon.ru");
  console.log("Using days:", days);

  const map = await getAdSpend(days);

  const keys = Object.keys(map || {});
  console.log("\n✅ getAdSpend() returned keys:", keys.length);
  console.log("Sample keys:", keys.slice(0, 20));

  // сколько реально не нулевых по spend
  const nonZero = keys.filter((k) => Number(map[k]?.ad_spend || 0) > 0);
  console.log("Non-zero spend SKUs:", nonZero.length);
  console.log("Non-zero sample:", nonZero.slice(0, 20).map((k) => [k, map[k]]));

  console.log("\n--- WATCH SKUs ---");
  for (const sku of WATCH) {
    console.log(sku, "=>", map[sku] || null);
  }

  // если вдруг spend не в ad_spend, а лежит иначе — покажем первые записи целиком
  console.log("\n--- FIRST 5 ENTRIES (raw) ---");
  keys.slice(0, 5).forEach((k) => {
    console.log(k, map[k]);
  });

  if (keys.length === 0) {
    console.log("\n⚠️ Map is empty. Значит getAdSpend() не смог распарсить отчёты или вернул пустоту из-за ошибок/лимитов.");
    console.log("Дальше: включим принты прямо внутри ozonApi.getAdSpend() (следующий шаг, если надо).");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
});
