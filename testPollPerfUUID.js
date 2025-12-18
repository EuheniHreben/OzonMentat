// testPollPerfUUID.js
require("dotenv").config();

const {
  PERF_BASE_URL,
  PERF_CLIENT_ID,
  PERF_CLIENT_SECRET,
} = require("./config");

if (!PERF_CLIENT_ID || !PERF_CLIENT_SECRET) {
  console.error("❌ Нет PERF_CLIENT_ID / PERF_CLIENT_SECRET");
  process.exit(1);
}

let token = null;
let expAt = 0;

async function getToken() {
  const now = Date.now();
  if (token && now < expAt - 60_000) return token;

  const res = await fetch(`${PERF_BASE_URL}/api/client/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: PERF_CLIENT_ID,
      client_secret: PERF_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`token ${res.status}: ${text}`);

  const json = JSON.parse(text);
  token = json.access_token;
  expAt = now + Number(json.expires_in || 1800) * 1000;
  return token;
}

async function perfFetch(method, path, bodyOrQuery) {
  const t = await getToken();

  let url = `${PERF_BASE_URL}${path}`;
  const headers = { Authorization: `Bearer ${t}` };

  let body = undefined;

  if (method === "GET" && bodyOrQuery && typeof bodyOrQuery === "object") {
    const qs = Object.entries(bodyOrQuery)
      .map(
        ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`
      )
      .join("&");
    url += `?${qs}`;
    headers.Accept = "application/json";
  }

  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(bodyOrQuery || {});
  }

  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  return { status: res.status, text };
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, delta) {
  const x = new Date(d);
  x.setDate(x.getDate() + delta);
  return x;
}

async function main() {
  console.log("PERF_BASE_URL:", PERF_BASE_URL);

  // 1) campaigns
  const camps = await perfFetch("GET", "/api/client/campaign", {
    advObjectType: "SKU",
  });
  console.log("\n/campaign status:", camps.status);
  const campsJson = JSON.parse(camps.text || "{}");
  const first = campsJson?.list?.[0];
  if (!first) {
    console.log("⚠️ list пустой");
    return;
  }
  console.log("first campaign:", {
    id: first.id,
    title: first.title,
    state: first.state,
  });

  // 2) request report -> UUID
  const today = new Date();
  const dateTo = fmtDate(today);
  const dateFrom = fmtDate(addDays(today, -7));

  const reqBody = {
    campaigns: [String(first.id)],
    dateFrom,
    dateTo,
    groupBy: "SKU",
  };

  const req = await perfFetch("POST", "/api/client/statistics/json", reqBody);
  console.log("\n/statistics/json status:", req.status);
  console.log("body:", req.text);

  const reqJson = JSON.parse(req.text || "{}");
  const uuid = reqJson.UUID || reqJson.uuid;
  if (!uuid) {
    console.log("⚠️ UUID не найден в ответе");
    return;
  }
  console.log("\nUUID =", uuid);

  // 3) пробуем варианты "забрать по UUID"
  const tries = [
    ["GET", "/api/client/statistics/json", { UUID: uuid }],
    ["POST", "/api/client/statistics/json", { UUID: uuid }],
    ["GET", "/api/client/statistics/report", { UUID: uuid }],
    ["POST", "/api/client/statistics/report", { UUID: uuid }],
    ["GET", `/api/client/statistics/${encodeURIComponent(uuid)}`, null],
  ];

  for (const [m, p, payload] of tries) {
    const r = await perfFetch(m, p, payload);
    console.log(`\n=== TRY ${m} ${p} ===`);
    console.log("status:", r.status);
    console.log("text:", (r.text || "").slice(0, 300));
  }
}

main().catch((e) => console.error("Fatal:", e));
