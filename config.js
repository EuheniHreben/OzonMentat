// config.js
require("dotenv").config();

// ===============================
// 🔐 Секреты (ТОЛЬКО из .env)
// ===============================
const CLIENT_ID = process.env.OZON_CLIENT_ID;
const API_KEY = process.env.OZON_API_KEY;

if (!CLIENT_ID || !API_KEY) {
  throw new Error(
    "Не заданы OZON_CLIENT_ID или OZON_API_KEY в переменных окружения (.env)"
  );
}

const PERF_CLIENT_ID = process.env.OZON_PERF_CLIENT_ID || "";
const PERF_CLIENT_SECRET = process.env.OZON_PERF_CLIENT_SECRET || "";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || "";

// ===============================
// 🌐 API URLs
// ===============================
const BASE_URL = "https://api-seller.ozon.ru";
const PERF_BASE_URL =
  process.env.OZON_PERF_BASE_URL || "https://api-performance.ozon.ru";

// ===============================
// 🧠 Поведение системы (CONFIG)
// ===============================
const ADS_ENABLED = process.env.ADS_ENABLED !== "0";

// анти-спам и защита API
const FUNNEL_MIN_REFRESH_MS = Number(
  process.env.FUNNEL_MIN_REFRESH_MS || 25_000
);
const ADS_COOLDOWN_MS = Number(process.env.ADS_COOLDOWN_MS || 60_000);

// кэш рекламы
const AD_CACHE_TTL_MS = Number(process.env.AD_CACHE_TTL_MS || 30 * 60 * 1000);

// ===============================
// 📊 Базовые настройки спроса
// ===============================
const DEMAND_FACTOR = 1.5;
const DAYS = 7;
const DAYS_LONG = 30;
const MIN_STOCK_DEFAULT = 4;
const PACK_SIZE_DEFAULT = 2;
const MAX_DAYS_OF_STOCK = 30;

// сглаживание / всплески
const SALES_SMOOTHING_ALPHA = 0.5;
const SPIKE_MULTIPLIER = 3;
const SPIKE_CAP_MULTIPLIER = 1.5;

// ===============================
// 📁 Файлы и история
// ===============================
const SALES_HISTORY_FILE = "salesHistory.json";

const PRICING_CACHE_FILE = process.env.PRICING_CACHE_FILE || "pricingData.json";
const PRICING_TTL_MS = Number(process.env.PRICING_TTL_MS) || 60 * 60 * 1000;

const MAX_LOADER_HISTORY_DAYS = 200;
const MAX_FUNNEL_HISTORY_DAYS = 120;

// ===============================
// 📤 Экспорт
// ===============================
module.exports = {
  // креды
  CLIENT_ID,
  API_KEY,

  // URLs
  BASE_URL,
  PERF_BASE_URL,

  // реклама / performance
  PERF_CLIENT_ID,
  PERF_CLIENT_SECRET,
  ADS_ENABLED,
  ADS_COOLDOWN_MS,
  AD_CACHE_TTL_MS,

  // анти-спам
  FUNNEL_MIN_REFRESH_MS,

  // спрос
  DEMAND_FACTOR,
  DAYS,
  DAYS_LONG,
  MIN_STOCK_DEFAULT,
  PACK_SIZE_DEFAULT,
  MAX_DAYS_OF_STOCK,

  SALES_SMOOTHING_ALPHA,
  SPIKE_MULTIPLIER,
  SPIKE_CAP_MULTIPLIER,

  // файлы
  SALES_HISTORY_FILE,
  GOOGLE_SHEET_ID,
  PRICING_CACHE_FILE,
  PRICING_TTL_MS,

  MAX_LOADER_HISTORY_DAYS,
  MAX_FUNNEL_HISTORY_DAYS,
};
