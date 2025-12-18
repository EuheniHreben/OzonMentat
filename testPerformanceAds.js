// testPerformanceAds.js
require("dotenv").config();

const PERF_BASE_URL =
  process.env.OZON_PERF_BASE_URL || "https://api-performance.ozon.ru";
const PERF_CLIENT_ID = process.env.OZON_PERF_CLIENT_ID;
const PERF_CLIENT_SECRET = process.env.OZON_PERF_CLIENT_SECRET;

if (!PERF_CLIENT_ID || !PERF_CLIENT_SECRET) {
  console.error(
    "❌ Нет OZON_PERF_CLIENT_ID или OZON_PERF_CLIENT_SECRET в .env (Performance API)."
  );
  process.exit(1);
}

async function getPerfToken() {
  const url = `${PERF_BASE_URL}/api/client/token`;

  const body = {
    client_id: PERF_CLIENT_ID,
    client_secret: PERF_CLIENT_SECRET,
    grant_type: "client_credentials",
  };

  console.log("\n--- getPerfToken ---");
  console.log("URL:", url);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Raw body:", text.slice(0, 400));

  if (!res.ok) {
    throw new Error(`Token error ${res.status}: ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text || "{}");
  } catch (e) {
    throw new Error("Не удалось распарсить ответ токена: " + e.message);
  }

  if (!json.access_token) {
    throw new Error("В ответе нет access_token");
  }

  return json.access_token;
}

async function perfGet(path, query = "") {
  const token = await getPerfToken();
  const url = `${PERF_BASE_URL}${path}${query ? "?" + query : ""}`;

  console.log("\n--- perfGet ---");
  console.log("URL:", url);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Raw response:", text.slice(0, 400));

  if (!res.ok) {
    throw new Error(`Performance API error ${res.status}: ${text}`);
  }

  return JSON.parse(text || "{}");
}

async function perfPost(path, body) {
  const token = await getPerfToken();

  const url = `${PERF_BASE_URL}${path}`;
  console.log("\n--- perfPost ---");
  console.log("URL:", url);
  console.log("Body:", JSON.stringify(body, null, 2));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Raw response:", text.slice(0, 400));

  if (!res.ok) {
    throw new Error(`Performance API error ${res.status}: ${text}`);
  }

  return JSON.parse(text || "{}");
}

async function main() {
  console.log("Node version:", process.version);
  console.log("Performance API base url:", PERF_BASE_URL);
  console.log("Client-ID (perf):", PERF_CLIENT_ID);

  // 1) Получаем список кампаний
  const campaignsResp = await perfGet(
    "/api/client/campaign",
    "advObjectType=SKU"
  );

  console.log("\n✅ Кампании (фрагмент):");
  console.dir(campaignsResp, { depth: 3 });

  const firstCampaign = campaignsResp.list?.[0];
  if (!firstCampaign) {
    console.log("⚠️ Кампаний не найдено (list пустой).");
    return;
  }

  const campaignId = firstCampaign.id;
  console.log("\nБерём campaignId:", campaignId);

  // 2) Запрашиваем статистику по кампании
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - 7);
  const from = fromDate.toISOString().slice(0, 10);

  const body = {
    campaigns: [campaignId],     // обязательный параметр
    dateFrom: from,
    dateTo: to,
    groupBy: "DATE",             // как в примере из статьи
  };

  const stats = await perfPost("/api/client/statistics/json", body);

  console.log("\n✅ Ответ statistics/json (фрагмент):");
  console.dir(stats, { depth: 4 });
}

main().catch((e) => {
  console.error("Fatal:", e);
});
