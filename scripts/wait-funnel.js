// scripts/wait-funnel.js
// Запуск:
//   node scripts/wait-funnel.js
//   BASE_URL=http://localhost:3000 DAYS=7 node scripts/wait-funnel.js
//   BASE_URL=http://localhost:3000 DAYS=30 INTERVAL=1500 TIMEOUT=45000 node scripts/wait-funnel.js

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const DAYS = Number(process.env.DAYS || 7);
const INTERVAL = Number(process.env.INTERVAL || 1500);
const TIMEOUT = Number(process.env.TIMEOUT || 45000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = `${BASE_URL}/api/funnel?days=${DAYS}`;
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`Polling: ${url}`);
  console.log(`INTERVAL=${INTERVAL}ms TIMEOUT=${TIMEOUT}ms\n`);

  const t0 = Date.now();
  let attempt = 0;

  while (Date.now() - t0 < TIMEOUT) {
    attempt += 1;

    let res, text, json;
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
      text = await res.text();
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
    } catch (e) {
      console.log(`#${attempt} FAIL: ${e?.cause?.code || e.message}`);
      await sleep(INTERVAL);
      continue;
    }

    const ms = Date.now() - t0;

    if (!json) {
      console.log(
        `#${attempt} ${res.status} (not json) ${ms}ms: ${text.slice(0, 120)}...`
      );
      await sleep(INTERVAL);
      continue;
    }

    if (json.ok === true && Array.isArray(json.rows)) {
      console.log(`#${attempt} ✅ READY ${ms}ms: rows=${json.rows.length}`);
      // небольшая проверка рекламы
      const withSpend = json.rows.filter(
        (r) => Number(r?.ad_spend || 0) > 0
      ).length;
      console.log(
        `adsEnabled=${String(
          json.adsEnabled
        )} · rows with ad_spend>0 = ${withSpend}`
      );
      return;
    }

    if (json.pending) {
      console.log(`#${attempt} ⏳ PENDING ${ms}ms: ${json.message || "..."}`);
    } else {
      console.log(`#${attempt} ❌ NOT READY ${ms}ms:`, json);
      return;
    }

    await sleep(INTERVAL);
  }

  console.log(
    `\n🧱 TIMEOUT: pending дольше ${TIMEOUT}ms — сборка, вероятно, зависла или падает.`
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
