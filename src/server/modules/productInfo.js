// productInfo.js
// Единый источник информации о товарах из products.csv

const fs = require("fs");
const path = require("path");

let productsBySku = null;
let allProducts = null;

/**
 * Парсим одну CSV-строку с учётом кавычек.
 * Поддерживает ; и , в качестве разделителя.
 */
function parseCsvLine(line, delimiter) {
  const res = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      // экранированная кавычка внутри поля: ""
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      res.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }

  res.push(cur);
  return res;
}

/**
 * Определяем разделитель по первой строке (заголовку).
 * Берём тот, который даёт больше колонок.
 */
function detectDelimiter(headerLine) {
  const candidates = [";", ","];
  let bestDelim = ";";
  let bestCount = 0;

  for (const d of candidates) {
    const cols = parseCsvLine(headerLine, d);
    if (cols.length > bestCount) {
      bestCount = cols.length;
      bestDelim = d;
    }
  }

  return bestDelim;
}

// ✅ FIX: корректный путь к data/products.csv от корня проекта
function resolveProductsPath() {
  // src/server/modules/productInfo.js -> projectRoot = ../../../
  const projectRoot = path.resolve(__dirname, "..", "..", "..");

  const primary = path.join(projectRoot, "data", "products.csv");
  if (fs.existsSync(primary)) return primary;

  // fallback: как было раньше — рядом с модулем (на случай старой структуры)
  const fallback = path.join(__dirname, "products.csv");
  if (fs.existsSync(fallback)) return fallback;

  // если нет — всё равно вернём primary (чтобы в логе был понятный путь)
  return primary;
}

function loadProductsOnce() {
  if (productsBySku) return;

  productsBySku = {};
  allProducts = [];

  const filePath = resolveProductsPath();

  if (!fs.existsSync(filePath)) {
    console.warn("⚠️ productInfo: файл products.csv не найден:", filePath);
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    console.warn("⚠️ productInfo: products.csv пустой:", filePath);
    return;
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return;

  // первая строка — заголовок
  let headerLine = lines[0].replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(headerLine);

  // ✅ FIX: нормализуем заголовки (SKU/Sku/ sku / BOM / пробелы)
  const headers = parseCsvLine(headerLine, delimiter).map((h) =>
    String(h).trim().toLowerCase()
  );

  const idx = (name) => headers.indexOf(String(name).trim().toLowerCase());

  const skuIdx = idx("sku");
  const offerIdx = idx("offer_id");
  const nameIdx = idx("name");
  const barcodeIdx = idx("barcode");
  const disabledIdx = idx("disabled");
  const minStockIdx = idx("min_stock");
  const packSizeIdx = idx("pack_size");

  const parseNum = (val) => {
    if (val == null || val === "") return undefined;
    const n = Number(String(val).replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cols = parseCsvLine(line, delimiter);

    const get = (ix) =>
      ix >= 0 && ix < cols.length ? String(cols[ix]).trim() : "";

    const skuRaw = get(skuIdx);
    if (!skuRaw) continue;

    const skuKey = String(skuRaw).trim();

    const offer_id = offerIdx >= 0 ? get(offerIdx) : "";
    const name = nameIdx >= 0 ? get(nameIdx) : "";
    const barcode = barcodeIdx >= 0 ? get(barcodeIdx) : "";
    const disabledRaw = disabledIdx >= 0 ? get(disabledIdx).toLowerCase() : "";

    const minStockRaw = minStockIdx >= 0 ? get(minStockIdx) : "";
    const packSizeRaw = packSizeIdx >= 0 ? get(packSizeIdx) : "";

    const product = {
      sku: Number.isFinite(Number(skuRaw)) ? Number(skuRaw) : skuKey,
      offer_id: offer_id || null,
      name,
      barcode,
      disabled:
        disabledRaw === "1" ||
        disabledRaw === "true" ||
        disabledRaw === "yes" ||
        disabledRaw === "да",
      min_stock: parseNum(minStockRaw),
      pack_size: parseNum(packSizeRaw),
    };

    productsBySku[skuKey] = product;
    allProducts.push(product);
  }

  console.log(
    `ℹ️ productInfo: загружено товаров из products.csv: ${allProducts.length}`
  );
}

function getBySku(sku) {
  loadProductsOnce();
  if (!productsBySku) return null;
  const key = String(sku || "").trim();
  if (!key) return null;
  return productsBySku[key] || null;
}

function getAll() {
  loadProductsOnce();
  return allProducts ? allProducts.slice() : [];
}

module.exports = {
  getBySku,
  getAll,
};
