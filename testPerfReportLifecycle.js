// testPerfReportLifecycle.js
require("dotenv").config();

const PERF_BASE_URL =
  process.env.OZON_PERF_BASE_URL || "https://api-performance.ozon.ru";
const PERF_CLIENT_ID = process.env.OZON_PERF_CLIENT_ID;
const PERF_CLIENT_SECRET = process.env.OZON_PERF_CLIENT_SECRET;

if (!PERF_CLIENT_ID || !PERF_CLIENT_SECRET) {
  console.error("❌ Нет PERF_CLIENT_ID/SECRET");
  process.exit(1);
}

function resolveUrl(maybeRelative) {
  const s = String(maybeRelative || "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return `${PERF_BASE_URL}${s}`;
  return `${PERF_BASE_URL}/${s}`;
}

async function getPerfToken() {
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
  if (!json.access_token) throw new Error("no access_token");
  return json.access_token;
}

async function perfGet(path, query) {
  const token = await getPerfToken();
  const url = resolveUrl(path) + (query ? `?${query}` : "");

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text || "{}");
  } catch {}
  return { status: res.status, json, text };
}

async function perfPost(path, body) {
  const token = await getPerfToken();
  const url = resolveUrl(path);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body || {}),
  });

  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text || "{}");
  } catch {}
  return { status: res.status, json, text };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadReport(link) {
  const token = await getPerfToken();
  const url = resolveUrl(link);

  console.log("\n--- DOWNLOAD LINK ---");
  console.log("url:", url);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "*/*",
    },
  });

  console.log("download status:", res.status);
  const ctype = res.headers.get("content-type");
  const disp = res.headers.get("content-disposition");
  console.log("content-type:", ctype);
  console.log("content-disposition:", disp);

  const buf = Buffer.from(await res.arrayBuffer());
  console.log("bytes:", buf.length);

  const head = buf.slice(0, 300).toString("utf8");
  console.log("\n--- FIRST 300 BYTES (utf8) ---\n", head);

  const sig = buf.slice(0, 4).toString("hex");
  console.log("signature(hex):", sig, "(zip=504b0304)");

  return buf;
}

async function main() {
  console.log("PERF_BASE_URL:", PERF_BASE_URL);

  const camp = await perfGet("/api/client/campaign", "advObjectType=SKU");
  console.log("campaign status:", camp.status);
  const ids = (camp.json?.list || []).map((x) => x.id).filter(Boolean);
  console.log("campaigns:", ids.length);
  if (!ids.length) return;

  const chunk = ids.slice(0, 10);
  console.log("using chunk size:", chunk.length);

  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const fromD = new Date(today);
  fromD.setDate(fromD.getDate() - 7);
  const from = fromD.toISOString().slice(0, 10);

  const create = await perfPost("/api/client/statistics/json", {
    campaigns: chunk,
    dateFrom: from,
    dateTo: to,
    groupBy: "SKU",
  });

  console.log("create status:", create.status);
  console.log("create body:", create.json);

  const uuid = create.json?.UUID;
  if (!uuid) return;

  console.log("UUID:", uuid);

  for (let i = 1; i <= 40; i++) {
    const st = await perfGet(`/api/client/statistics/${uuid}`);
    const state = st.json?.state || st.json?.status || "???";
    const link = st.json?.link || null;

    console.log(
      `#${i} state=${state} updatedAt=${st.json?.updatedAt || "-"} link=${
        link ? "YES" : "NO"
      }`
    );

    if (link) {
      console.log("\nFULL LINK:\n", link);
      await downloadReport(link);
      break;
    }

    await sleep(1200);
  }
}

main().catch((e) => console.error("Fatal:", e));
