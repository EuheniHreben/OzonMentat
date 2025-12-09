const fs = require("fs");
const path = require("path");
const Excel = require("exceljs");

const {
  DEMAND_FACTOR,
  DAYS,
  DAYS_LONG,
  MIN_STOCK_DEFAULT,
  PACK_SIZE_DEFAULT,
  SALES_SMOOTHING_ALPHA,
  SPIKE_MULTIPLIER,
  SPIKE_CAP_MULTIPLIER,
  SALES_HISTORY_FILE,
  MAX_DAYS_OF_STOCK,
  MAX_LOADER_HISTORY_DAYS,
} = require("./config");

const { getStocksMap, getSalesMap } = require("./ozonApi");
const productInfo = require("./productInfo");

// дефолтный конфиг, если runtime не передали
const defaultConfig = {
  DEMAND_FACTOR,
  DAYS,
  DAYS_LONG,
  MIN_STOCK_DEFAULT,
  PACK_SIZE_DEFAULT,
  SALES_SMOOTHING_ALPHA,
  SPIKE_MULTIPLIER,
  SPIKE_CAP_MULTIPLIER,
  MAX_DAYS_OF_STOCK,
  MAX_LOADER_HISTORY_DAYS,
};

const DISABLED_FILE = path.join(__dirname, "loaderDisabled.json");

// 🔎 файл истории прогрузок
const LOADER_HISTORY_FILE = path.join(__dirname, "loaderHistory.json");

// кэш для поиска по offer_id
let productsByOfferIdCache = null;

function getProductByOfferId(offerId) {
  const key = String(offerId || "").trim();
  if (!key) return null;

  if (!productsByOfferIdCache) {
    productsByOfferIdCache = {};
    const all =
      typeof productInfo.getAll === "function" ? productInfo.getAll() : [];
    for (const p of all) {
      if (p && p.offer_id) {
        productsByOfferIdCache[String(p.offer_id).trim()] = p;
      }
    }
  }

  return productsByOfferIdCache[key] || null;
}

// --- Автоматический подбор коэффициента спроса для SKU ---
function autoDemandFactor({
  base,
  smoothed,
  prevSmoothed,
  weekSalesEff,
  spikeFlag,
  ozon_stock,
}) {
  let k = Number(base) || 1.5;

  const prev = prevSmoothed > 0 ? prevSmoothed : weekSalesEff;
  let trend = 0;
  if (prev > 0) {
    trend = (weekSalesEff - prev) / prev; // относительный рост/падение
  }

  if (spikeFlag) {
    k *= 0.7;
  }

  if (!spikeFlag && trend > 0.3 && ozon_stock < weekSalesEff) {
    k *= 1.4;
  } else if (!spikeFlag && trend > 0.15 && ozon_stock < weekSalesEff * 1.2) {
    k *= 1.2;
  }

  if (trend < -0.3 || weekSalesEff === 0) {
    k *= 0.7;
  }

  if (k < 0.5) k = 0.5;
  if (k > 3) k = 3;

  return Number(k.toFixed(2));
}

function loadDisabledMap() {
  try {
    if (!fs.existsSync(DISABLED_FILE)) return {};
    const raw = fs.readFileSync(DISABLED_FILE, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.warn("❌ Не удалось прочитать loaderDisabled.json:", e.message);
    return {};
  }
}

// 👉 добавляем запись об очередной прогрузке в loaderHistory.json
// Логика: храним не больше N последних ДНЕЙ, где N задаётся конфигом.
function appendLoaderHistory(entry, maxDaysFromConfig) {
  try {
    let history = [];

    if (fs.existsSync(LOADER_HISTORY_FILE)) {
      const raw = fs.readFileSync(LOADER_HISTORY_FILE, "utf8");
      if (raw.trim()) {
        history = JSON.parse(raw);
      }
    }

    const ts = entry.timestamp || new Date().toISOString();
    const todayDate = ts.slice(0, 10); // YYYY-MM-DD

    if (history.length > 0) {
      const last = history[history.length - 1];
      let lastDate = null;

      if (last && last.timestamp) {
        lastDate = String(last.timestamp).slice(0, 10);
      }

      if (lastDate === todayDate) {
        // уже есть запись за этот день — заменяем её свежей
        history[history.length - 1] = entry;
      } else {
        // новый день — добавляем запись
        history.push(entry);
      }
    } else {
      history.push(entry);
    }

    const limit =
      Number(maxDaysFromConfig) && Number(maxDaysFromConfig) > 0
        ? Number(maxDaysFromConfig)
        : MAX_LOADER_HISTORY_DAYS;

    if (history.length > limit) {
      history = history.slice(-limit);
    }

    fs.writeFileSync(
      LOADER_HISTORY_FILE,
      JSON.stringify(history, null, 2),
      "utf8"
    );
  } catch (e) {
    console.warn("❌ Не удалось обновить loaderHistory.json:", e.message);
  }
}

/**
 * Чтение Excel из public/cut.
 * Берём **все** .xlsx-файлы в папке.
 * В каждом ищем строку заголовков по словам "артикул" и "количество/кол-во/qty".
 * Возвращаем map: { skuKey: qty }, где qty — сумма по всем файлам.
 */
async function readCutReservations() {
  const resultMap = {};

  try {
    const dir = path.join(__dirname, "public", "cut");
    if (!fs.existsSync(dir)) return {};

    const allFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".xlsx"));
    if (!allFiles.length) return {};

    console.log(
      `✔️ Найдено cut-файлов в public/cut: ${allFiles.length} (буду суммировать все)`
    );

    for (const fileName of allFiles) {
      const fullPath = path.join(dir, fileName);

      try {
        const workbook = new Excel.Workbook();
        await workbook.xlsx.readFile(fullPath);
        const sheet = workbook.worksheets[0];
        if (!sheet) continue;

        // 1) Находим строку заголовков и номера колонок "артикул" и "количество"
        let headerRowIndex = null;
        let artColIndex = null;
        let qtyColIndex = null;

        sheet.eachRow((row, rowNumber) => {
          if (headerRowIndex != null) return; // уже нашли

          let foundArt = null;
          let foundQty = null;

          row.eachCell((cell, colNumber) => {
            const raw =
              (cell && (cell.text || cell.value)) != null
                ? String(cell.text || cell.value)
                    .trim()
                    .toLowerCase()
                : "";

            if (!raw) return;

            if (!foundArt && (raw.includes("артикул") || raw.includes("sku"))) {
              foundArt = colNumber;
            }

            if (
              !foundQty &&
              (raw.includes("колич") ||
                raw.includes("кол-во") ||
                raw.includes("qty"))
            ) {
              foundQty = colNumber;
            }
          });

          if (foundArt != null && foundQty != null) {
            headerRowIndex = rowNumber;
            artColIndex = foundArt;
            qtyColIndex = foundQty;
          }
        });

        if (
          headerRowIndex == null ||
          artColIndex == null ||
          qtyColIndex == null
        ) {
          console.warn(
            `⚠️ cut-файл "${fileName}": не удалось найти заголовки 'артикул' и 'количество' — пропускаю файл`
          );
          continue;
        }

        const lastRow = sheet.rowCount;

        for (let r = headerRowIndex + 1; r <= lastRow; r++) {
          const row = sheet.getRow(r);
          if (!row) continue;

          const artCell = row.getCell(artColIndex);
          const qtyCell = row.getCell(qtyColIndex);

          const rawArt = String(
            (artCell && (artCell.text || artCell.value)) || ""
          ).trim();
          if (!rawArt) continue;

          let qtyRaw =
            qtyCell && (qtyCell.value != null ? qtyCell.value : qtyCell.text);
          if (qtyRaw && typeof qtyRaw === "object" && "result" in qtyRaw) {
            qtyRaw = qtyRaw.result;
          }

          const qty = Number(qtyRaw);
          if (!Number.isFinite(qty) || qty <= 0) continue;

          // пробуем трактовать как sku
          let skuKey = null;

          const bySku = productInfo.getBySku(rawArt);
          if (bySku && bySku.sku != null) {
            skuKey = String(bySku.sku);
          } else {
            // пробуем как offer_id
            const byOffer = getProductByOfferId(rawArt);
            if (byOffer && byOffer.sku != null) {
              skuKey = String(byOffer.sku);
            }
          }

          if (!skuKey) {
            console.warn(
              `⚠️ cut-файл "${fileName}": не удалось сопоставить артикул "${rawArt}" с sku из products.csv`
            );
            continue;
          }

          resultMap[skuKey] = (resultMap[skuKey] || 0) + qty;
        }
      } catch (eFile) {
        console.warn(
          `❌ Ошибка чтения cut-файла "${fileName}":`,
          eFile.message
        );
      }
    }

    console.log(
      `✔️ cut-файлы: суммарно зарезервированных позиций: ${
        Object.keys(resultMap).length
      }`
    );

    return resultMap;
  } catch (e) {
    console.warn("❌ Ошибка чтения cut-файлов из public/cut:", e.message);
    return resultMap;
  }
}

async function runLoader(runtimeConfig = {}) {
  const cfg = { ...defaultConfig, ...runtimeConfig };

  const disabledMap = loadDisabledMap();

  console.log(`✔️ Тяну продажи за последние ${cfg.DAYS} дней из аналитики...`);
  const salesShortMap = await getSalesMap(cfg.DAYS);

  console.log(
    `✔️ Тяну продажи за последние ${cfg.DAYS_LONG} дней (вторая шкала)...`
  );
  const salesLongMap =
    cfg.DAYS_LONG && cfg.DAYS_LONG !== cfg.DAYS
      ? await getSalesMap(cfg.DAYS_LONG)
      : salesShortMap;

  console.log("✔️ Тяну остатки и товары в пути из Ozon (аналитика складов)...");
  const stocksMap = await getStocksMap();

  console.log("✔️ Читаю зарезервированные поставки из public/cut...");
  const futureInTransitMap = await readCutReservations();

  // теперь прогрузчик работает по ВСЕМ товарам из products.csv
  const allProducts =
    typeof productInfo.getAll === "function" ? productInfo.getAll() : [];

  if (!allProducts.length) {
    console.log(
      "Нет товаров в products.csv (productInfo.getAll вернул пустой массив)."
    );
    return {
      shipment: [],
      allItems: [],
      updated: new Date().toISOString(),
      fileName: null,
    };
  }

  console.log(
    `✔️ Найдено товаров в products.csv для расчёта: ${allProducts.length}`
  );

  const historyPath = path.join(
    __dirname,
    SALES_HISTORY_FILE || "salesHistory.json"
  );

  let salesHistory = {};

  try {
    if (fs.existsSync(historyPath)) {
      const raw = fs.readFileSync(historyPath, "utf8");
      salesHistory = raw.trim() ? JSON.parse(raw) : {};
    }
  } catch (e) {
    console.warn("❌ Не удалось прочитать историю продаж:", e.message);
    salesHistory = {};
  }

  const shipment = [];
  const allItems = [];

  for (const product of allProducts) {
    const skuKey = String(product.sku || "").trim();
    if (!skuKey || !product.offer_id) {
      continue;
    }

    const stockInfo = stocksMap[skuKey] || {
      ozon_stock: 0,
      in_transit: 0,
    };

    const salesShort = salesShortMap[skuKey] || 0;
    const salesLong = salesLongMap[skuKey] || 0;

    const ozon_stock = stockInfo.ozon_stock || 0;
    const inTransitApi = stockInfo.in_transit || 0;
    const inTransitCut = futureInTransitMap[skuKey] || 0;

    // ИТОГОВОЕ "в пути" = то, что уже в Ozon, + то, что зарезервировано в cut-файлах
    const in_transit = inTransitApi + inTransitCut;

    const hasAnyData =
      salesShort > 0 ||
      salesLong > 0 ||
      ozon_stock > 0 ||
      inTransitApi > 0 ||
      inTransitCut > 0;

    const prevSmoothed =
      salesHistory[skuKey] && typeof salesHistory[skuKey].smoothed === "number"
        ? salesHistory[skuKey].smoothed
        : salesShort;

    const alpha = cfg.SALES_SMOOTHING_ALPHA;
    let smoothed = prevSmoothed;

    if (alpha > 0 && alpha < 1) {
      smoothed = prevSmoothed + alpha * (salesShort - prevSmoothed);
    } else {
      smoothed = salesShort;
    }

    let weekSalesEffective = salesShort;
    let spikeFlag = false;

    if (
      smoothed > 0 &&
      cfg.SPIKE_MULTIPLIER > 0 &&
      cfg.SPIKE_CAP_MULTIPLIER > 0 &&
      salesShort > smoothed * cfg.SPIKE_MULTIPLIER
    ) {
      spikeFlag = true;
      weekSalesEffective = Math.round(smoothed * cfg.SPIKE_CAP_MULTIPLIER);
    } else {
      weekSalesEffective = salesShort;
    }

    salesHistory[skuKey] = {
      lastWeekSales: salesShort,
      smoothed,
    };

    const min_stock =
      typeof product.min_stock === "number" && product.min_stock > 0
        ? product.min_stock
        : cfg.MIN_STOCK_DEFAULT;

    const pack_size =
      typeof product.pack_size === "number" && product.pack_size > 0
        ? product.pack_size
        : cfg.PACK_SIZE_DEFAULT;

    const demand_factor = autoDemandFactor({
      base: cfg.DEMAND_FACTOR,
      smoothed,
      prevSmoothed,
      weekSalesEff: weekSalesEffective,
      spikeFlag,
      ozon_stock,
    });

    let target_demand = Math.ceil(weekSalesEffective * demand_factor);

    const avgPerDay = weekSalesEffective / 7;

    if (avgPerDay > 0 && cfg.MAX_DAYS_OF_STOCK > 0) {
      const capByDays = Math.ceil(avgPerDay * cfg.MAX_DAYS_OF_STOCK);
      if (target_demand > capByDays) {
        console.warn(
          `SKU ${skuKey}: target_demand=${target_demand} > лимита по дням (${capByDays} при ${cfg.MAX_DAYS_OF_STOCK} днях), режу до лимита`
        );
        target_demand = capByDays;
      }
    }

    const target = Math.max(target_demand, min_stock);

    let need_raw = target - ozon_stock - in_transit;
    if (need_raw < 0) need_raw = 0;

    const NeedGoods =
      pack_size > 0 ? Math.ceil(need_raw / pack_size) * pack_size : 0;

    // по умолчанию отключены те, по кому нет данных вообще
    let isDisabled =
      !hasAnyData ||
      !!product.disabled ||
      !!(disabledMap && disabledMap[skuKey]);

    let includedInShipment = false;

    if (!isDisabled && NeedGoods > 0) {
      includedInShipment = true;

      shipment.push({
        sku: skuKey,
        offer_id: product.offer_id,
        name: product.name || "",
        barcode: product.barcode,
        ozon_stock,
        in_transit,
        week_sales_raw: salesShort,
        week_sales_long_raw: salesLong,
        week_sales_effective: weekSalesEffective,
        spike: spikeFlag,
        demand_factor,
        target_demand: Number(target_demand.toFixed(1)),
        need_raw: Number(need_raw.toFixed(1)),
        NeedGoods,
      });
    }

    allItems.push({
      sku: skuKey,
      offer_id: product.offer_id,
      name: product.name || "",
      barcode: product.barcode,
      ozon_stock,
      in_transit,
      week_sales_raw: salesShort,
      week_sales_long_raw: salesLong,
      week_sales_effective: weekSalesEffective,
      spike: spikeFlag,
      demand_factor,
      target_demand: Number(target_demand.toFixed(1)),
      need_raw: Number(need_raw.toFixed(1)),
      NeedGoods,
      disabled: isDisabled,
      included: includedInShipment,
      noData: !hasAnyData,
      in_transit_api: inTransitApi,
      in_transit_cut: inTransitCut,
    });
  }

  try {
    fs.writeFileSync(
      historyPath,
      JSON.stringify(salesHistory, null, 2),
      "utf8"
    );
  } catch (e) {
    console.warn("❌ Не удалось сохранить историю продаж:", e.message);
  }

  const now = new Date();
  const timestamp = now.toISOString();

  appendLoaderHistory(
    {
      timestamp,
      config: cfg,
      items: allItems,
    },
    cfg.MAX_LOADER_HISTORY_DAYS
  );

  if (!shipment.length) {
    console.log("По текущим данным ничего довозить не нужно 😎");
    return {
      shipment: [],
      allItems,
      updated: timestamp,
      fileName: null,
    };
  }

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");

  const fileName = `Ozon Palantir Ru ${dd}-${mm}-${yyyy}.xlsx`;

  const exportsDir = path.join(__dirname, "exports");
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }
  const supplyPath = path.join(exportsDir, fileName);

  const workbookOut = new Excel.Workbook();
  const sheetOut = workbookOut.addWorksheet("Поставка");

  sheetOut.addRow(["артикул", "имя (необязательно)", "количество"]);

  for (const row of shipment) {
    sheetOut.addRow([row.offer_id, "", row.NeedGoods]);
  }

  sheetOut.getRow(1).font = { bold: true };
  sheetOut.columns.forEach((col) => {
    col.width = 40;
  });

  await workbookOut.xlsx.writeFile(supplyPath);

  console.log(`✔️ Excel-файл для поставки создан: ${supplyPath}`);
  console.log("✔️ Можно загружать в Ozon");

  return {
    shipment,
    allItems,
    updated: timestamp,
    fileName,
  };
}

module.exports = {
  runLoader,
};
