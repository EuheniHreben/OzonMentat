// scripts/check-ads.js
// Запуск: node scripts/check-ads.js
// Опционально: BASE_URL=http://localhost:3000 node scripts/check-ads.js

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function fetchJson(url) {
  const t0 = Date.now();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const ms = Date.now() - t0;

  let text = "";
  try {
    text = await res.text();
  } catch {}

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // не JSON — оставим text
  }

  return { url, status: res.status, ms, json, text };
}

function pickField(obj, candidates) {
  for (const k of candidates) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return k;
  }
  return null;
}

function summarizeRows(rows) {
  const total = rows.length;

  const spendField = pickField(rows[0], [
    "ad_spend",
    "ads_spend",
    "spend",
    "cost",
    "adSpend",
    "adsCost",
  ]);

  const drrField = pickField(rows[0], ["drr", "acos", "drr_pct", "ad_drr"]);
  const ctrField = pickField(rows[0], ["ctr", "ad_ctr", "ctr_pct"]);
  const convField = pickField(rows[0], [
    "conv",
    "conversion",
    "cvr",
    "conv_pct",
  ]);

  const spendVals = spendField
    ? rows
        .map((r) => Number(r?.[spendField] ?? 0))
        .filter((n) => Number.isFinite(n))
    : [];

  const withSpend = spendVals.filter((n) => n > 0).length;
  const spendSum = spendVals.reduce((a, b) => a + b, 0);

  return {
    total,
    fieldsDetected: { spendField, drrField, ctrField, convField },
    withSpend,
    spendSum,
  };
}

function printTopKeys(row) {
  if (!row || typeof row !== "object") return;
  const keys = Object.keys(row).sort();
  console.log("Поля первой строки (alphabetical):");
  console.log(keys.join(", "));
}

async function main() {
  console.log(`BASE_URL = ${BASE_URL}`);

  // 1) Проверим конфиг рекламы (вдруг всё “выключилось” настройкой/флагом)
  const cfg = await fetchJson(`${BASE_URL}/api/config/ads`);
  console.log("\n=== /api/config/ads ===");
  console.log(`HTTP ${cfg.status} · ${cfg.ms}ms`);
  if (cfg.json?.ok) {
    console.log("ok: true");
  } else {
    console.log("Ответ:", cfg.json ?? cfg.text?.slice(0, 400));
  }

  // 2) Проверим funnel 7 и 30 дней (таблица рекламы у тебя зависит от этих данных) :contentReference[oaicite:1]{index=1}
  for (const days of [7, 30]) {
    const r = await fetchJson(`${BASE_URL}/api/funnel?days=${days}`);
    console.log(`\n=== /api/funnel?days=${days} ===`);
    console.log(`HTTP ${r.status} · ${r.ms}ms`);

    const j = r.json;
    if (!j) {
      console.log(
        "❌ Не JSON. Первые 400 символов:",
        (r.text || "").slice(0, 400)
      );
      continue;
    }

    if (j.ok !== true || !Array.isArray(j.rows)) {
      console.log("❌ ok!=true или rows не массив");
      console.log("Ответ:", j);
      continue;
    }

    console.log(`ok: true · rows: ${j.rows.length}`);
    if ("adsEnabled" in j) console.log(`adsEnabled: ${String(j.adsEnabled)}`);
    if (j.warning) console.log(`warning: ${j.warning}`);

    if (j.rows.length === 0) continue;

    const s = summarizeRows(j.rows);
    console.log("detected fields:", s.fieldsDetected);
    console.log(`rows with spend > 0: ${s.withSpend}/${s.total}`);
    console.log(
      `total spend sum: ${Math.round(s.spendSum).toLocaleString("ru-RU")} ₽`
    );

    // если внезапно “ноль строк с расходом” — выведем ключи первой строки, чтобы сразу увидеть переименования
    if (s.withSpend === 0) {
      console.log("\n⚠️ spend > 0 нет ни в одной строке.");
      console.log("Это почти всегда значит одно из трёх:");
      console.log(
        "1) реклама реально не подмешивается (adsEnabled=false / флаг / cooldown / ошибки);"
      );
      console.log(
        "2) поле ad_spend переименовали (например spend/cost), а фронт ждёт ad_spend; :contentReference[oaicite:2]{index=2}"
      );
      console.log("3) теперь расходы приходят в другой сущности/эндпоинте.");
      console.log("");
      printTopKeys(j.rows[0]);
    }
  }

  console.log("\nГотово.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
