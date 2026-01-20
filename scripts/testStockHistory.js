// scripts/testStockHistory.js
// Usage:
//   node scripts/testStockHistory.js 2026-01-01 2026-01-19
//
// Optional env:
//   OFFER_ID=2248096987  (to filter one offer_id in output)

const fs = require("fs");
const path = require("path");

// Подключаем твой ozonPost (он уже умеет ходить с Client-Id / Api-Key)
const { ozonPost } = require("../src/server/modules/ozonApi");

function iso(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function getArgsRange() {
  const a = process.argv[2];
  const b = process.argv[3];

  // по умолчанию последние 30 дней
  const to = b ? iso(b) : iso(new Date());
  const from = a ? iso(a) : iso(new Date(Date.now() - 29 * 24 * 3600 * 1000));

  return { from, to };
}

async function main() {
  const { from, to } = getArgsRange();
  const limit = 1000;
  const offerId = process.env.OFFER_ID ? String(process.env.OFFER_ID) : null;

  console.log("[test] range:", from, "->", to);

  // Вариант A (новый): с date_from/date_to.
  // В документах/нотификациях всплывают именно эти поля. :contentReference[oaicite:2]{index=2}
  // Точная форма "filter" может отличаться, поэтому пробуем 2 формы.
  const payloads = [
    {
      name: "A1: date_from/date_to + warehouse_type",
      body: {
        date_from: from,
        date_to: to,
        warehouse_type: "ALL",
        limit,
        offset: 0,
      },
    },
    {
      name: "A2: filter.date_from/date_to (если у метода именно filter)",
      body: {
        filter: { date_from: from, date_to: to, warehouse_type: "ALL" },
        limit,
        offset: 0,
      },
    },

    // Вариант B (старый): как у тебя сейчас в getStocksMap()
    { name: "B: legacy", body: { warehouse_type: "ALL", limit, offset: 0 } },
  ];

  let lastErr = null;

  for (const p of payloads) {
    try {
      console.log("\n[test] trying:", p.name);
      const json = await ozonPost("/v2/analytics/stock_on_warehouses", p.body);

      // Сохраняем “сыро” для анализа структуры
      const outPath = path.join(
        process.cwd(),
        `stock_on_warehouses_${p.name.replace(/[^a-z0-9]+/gi, "_")}.json`,
      );
      fs.writeFileSync(outPath, JSON.stringify(json, null, 2), "utf8");
      console.log("[ok] saved:", outPath);

      // Быстрый “срез” по структуре
      const rows = json?.result?.rows || [];
      console.log("[ok] rows:", rows.length);

      if (rows.length) {
        const sample = rows[0];
        console.log("[sample keys]:", Object.keys(sample));

        // если нужно — фильтруем по offer_id (если поле есть)
        if (offerId) {
          const filtered = rows.filter(
            (r) => String(r.offer_id || r.offerId || "") === offerId,
          );
          console.log(
            "[filter] by OFFER_ID =",
            offerId,
            "->",
            filtered.length,
            "rows",
          );
          const out2 = path.join(
            process.cwd(),
            `stock_rows_offer_${offerId}.json`,
          );
          fs.writeFileSync(
            out2,
            JSON.stringify(filtered.slice(0, 200), null, 2),
            "utf8",
          );
          console.log("[ok] saved:", out2);
        }
      }

      // Если получили ответ — дальше не надо
      return;
    } catch (e) {
      lastErr = e;
      console.log("[fail]", e.message);
    }
  }

  throw lastErr || new Error("All payload variants failed");
}

main().catch((e) => {
  console.error("\n[FINAL ERROR]", e.message);
  process.exit(1);
});
