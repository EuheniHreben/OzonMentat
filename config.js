// config.js
// Глобальный конфиг проекта: Ozon, спрос, история, Google Sheets

require("dotenv").config();

const CLIENT_ID = process.env.OZON_CLIENT_ID;
const API_KEY = process.env.OZON_API_KEY;

if (!CLIENT_ID || !API_KEY) {
  throw new Error(
    "Не заданы OZON_CLIENT_ID или OZON_API_KEY в переменных окружения (.env)"
  );
}

module.exports = {
  // креды Ozon
  CLIENT_ID,
  API_KEY,
  BASE_URL: "https://api-seller.ozon.ru",

  // 🔢 Базовые настройки спроса
  DEMAND_FACTOR: 1.5,

  // Период 1 (короткий, базовый)
  DAYS: 7,

  // Период 2 (длинный, для сравнения в прогрузчике)
  DAYS_LONG: 30,

  MIN_STOCK_DEFAULT: 4,
  PACK_SIZE_DEFAULT: 2,
  MAX_DAYS_OF_STOCK: 30,

  // 📈 Сглаживание продаж и защита от всплесков
  SALES_SMOOTHING_ALPHA: 0.5,
  SPIKE_MULTIPLIER: 3,
  SPIKE_CAP_MULTIPLIER: 1.5,

  // История продаж (для сглаживания)
  SALES_HISTORY_FILE: "salesHistory.json",

  // 👉 Google Sheets (ценовой модуль — пока не используем, но задел оставляем)
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || "",
  GOOGLE_PRICING_RANGE: process.env.GOOGLE_PRICING_RANGE || "Лист1!A2:G999",
  PRICING_CACHE_FILE: process.env.PRICING_CACHE_FILE || "pricingData.json",
  PRICING_TTL_MS:
    Number(process.env.PRICING_TTL_MS) || 60 * 60 * 1000 /* 1 час */,

  // 🧾 История прогрузчика и воронки
  MAX_LOADER_HISTORY_DAYS: 200,
  MAX_FUNNEL_HISTORY_DAYS: 120,
};
