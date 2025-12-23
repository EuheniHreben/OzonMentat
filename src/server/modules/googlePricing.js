// googlePricing.js
//
// Модуль для чтения себестоимости/маржи из Google Sheets.
// - Забирает данные через Google Sheets API
// - Кладёт в локальный JSON-кэш (pricingData.json)
// - Отдаёт map по sku/offer_id
//
// Зависимости:
//   - npm install googleapis
//   - .env: GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON
//

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const {
  GOOGLE_SHEET_ID,
  GOOGLE_PRICING_RANGE,
  PRICING_CACHE_FILE,
  PRICING_TTL_MS,
} = require("./config");

// Внутренний in-memory кэш
let cache = null;
let cacheTs = 0;

// Путь к файлу кэша
const CACHE_PATH = path.join(__dirname, PRICING_CACHE_FILE);

/**
 * Безопасный парс чисел (учитываем запятые)
 */
function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const s = String(value).trim().replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Загружает кэш из файла (если он уже есть)
 */
function loadFromFile() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return {};
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.warn("⚠️ Не удалось прочитать pricingData.json:", e.message);
    return {};
  }
}

/**
 * Сохраняет map в файл-кэш
 */
function saveToFile(map) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(map, null, 2), "utf8");
  } catch (e) {
    console.warn("⚠️ Не удалось сохранить pricingData.json:", e.message);
  }
}

/**
 * Прямой запрос в Google Sheets.
 * Ожидаемый формат строк:
 *  A: sku
 *  B: offer_id
 *  C: cost_price
 *  D: logistics
 *  E: min_price
 *  F: max_price
 *  G: target_margin
 */
async function fetchFromGoogle() {
  if (!GOOGLE_SHEET_ID) {
    throw new Error(
      "GOOGLE_SHEET_ID не задан. Укажи ID таблицы в .env или config.js"
    );
  }

  const svcJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!svcJson) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON не задан. Нужен JSON сервисного аккаунта (в одну строку)."
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(svcJson);
  } catch (e) {
    throw new Error(
      "Не удалось распарсить GOOGLE_SERVICE_ACCOUNT_JSON: " + e.message
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: GOOGLE_PRICING_RANGE,
  });

  const rows = res.data.values || [];

  const map = {};

  // возможен заголовок в первой строке — если он есть, просто пропусти его
  for (const row of rows) {
    // если используется строка заголовков, их можно узнать по первым значениям
    // но проще: предполагаем, что в диапазоне уже шапка вырезана (A2:G...)
    const [
      sku,
      offer_id,
      cost_price,
      logistics,
      min_price,
      max_price,
      target_margin,
    ] = row;

    // пропускаем пустые
    if (!sku && !offer_id) continue;

    const skuKey = sku ? String(sku).trim() : "";
    const offerKey = offer_id ? String(offer_id).trim() : "";

    const obj = {
      sku: skuKey || null,
      offer_id: offerKey || null,
      cost_price: toNumber(cost_price),
      logistics: toNumber(logistics),
      min_price: toNumber(min_price),
      max_price: toNumber(max_price),
      target_margin: toNumber(target_margin), // например 0.3 = 30%
    };

    // Основной ключ — sku (как в аналитике Ozon)
    if (skuKey) {
      map[skuKey] = obj;
    }

    // Дополнительно мапим по offer_id, чтобы можно было искать и по нему
    if (offerKey && !map[offerKey]) {
      map[offerKey] = obj;
    }
  }

  saveToFile(map);
  cache = map;
  cacheTs = Date.now();

  console.log(
    `✔️ Загрузил ${Object.keys(map).length} ценовых записей из Google Sheets`
  );

  return map;
}

/**
 * Основная функция для получения pricingMap.
 *
 * Возвращает объект:
 * {
 *   "123456789": {
 *      sku: "123456789",
 *      offer_id: "PLENKA-3X10-200",
 *      cost_price: 120.5,
 *      logistics: 35,
 *      min_price: 210,
 *      max_price: 340,
 *      target_margin: 0.3
 *   },
 *   ...
 * }
 */
async function getPricingMap(options = {}) {
  const { forceRefresh = false } = options;
  const now = Date.now();

  // Если есть кэш и он свежий — используем
  if (!forceRefresh && cache && now - cacheTs < PRICING_TTL_MS) {
    return cache;
  }

  // Если кэш пустой или просрочен — пробуем сначала файл
  if (!cache) {
    cache = loadFromFile();
    cacheTs = now;
  }

  // Пытаемся обновиться с Google
  try {
    return await fetchFromGoogle();
  } catch (e) {
    console.warn("⚠️ Не удалось обновить цены из Google Sheets:", e.message);
    // если упали — возвращаем то, что есть (память / файл)
    return cache || {};
  }
}

/**
 * Синхронная загрузка из файла (без обращения в Google),
 * может быть полезна при старте, если интернет/доступа нет.
 */
function getPricingMapSync() {
  if (cache) return cache;
  cache = loadFromFile();
  cacheTs = Date.now();
  return cache;
}

/**
 * Удобный хелпер: получить цены по sku или offer_id
 */
async function getPricingForKey(key, options = {}) {
  const map = await getPricingMap(options);
  return map[String(key)] || null;
}

module.exports = {
  getPricingMap,
  getPricingMapSync,
  getPricingForKey,
};
