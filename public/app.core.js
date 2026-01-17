// public/app.js
// =====================================================
// Global state
// =====================================================

const GRAPH_ENABLED = true;

let allRows = [];
let filteredRows = [];
let currentSort = { field: null, dir: 1 };
let periodDays = 7;

// поиск + фильтры
let searchQuery = "";
let currentPriority = "all"; // funnel only

// реклама: фильтр по статусу
let currentAdsStatus = "all";

// конфиг с бэка (для дефолтной мин. партии)
let RuntimeConfig = null;

// конфиги модулей (funnel/ads)
let FunnelConfig = null;
let AdsConfig = null;

// маленький график
let skuChart = null;
let skuChartReqId = 0;

// прогрузчик
let loaderItems = [];

// =====================================================
// Instant start cache (SWR)
// =====================================================
const LOCAL_CACHE_VERSION = 1;
const FUNNEL_CACHE_TTL_MS = 15 * 60 * 1000; // "свежее" окно (можешь менять)

function getStoreIdSafe() {
  try {
    return window.Store?.getActiveStore?.() || "default";
  } catch {
    return "default";
  }
}

function funnelCacheKey(days) {
  return `cache:v${LOCAL_CACHE_VERSION}:funnel:${getStoreIdSafe()}:days:${days}`;
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    return parsed; // { ts, rows }
  } catch {
    return null;
  }
}

function writeCache(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // если переполнен localStorage — молча игнорим
  }
}

function isFresh(ts, ttlMs) {
  return Number.isFinite(ts) && Date.now() - ts < ttlMs;
}

function setFunnelStatus(text) {
  const statusEl = document.getElementById("funnel-status");
  if (statusEl) statusEl.textContent = text || "";
}

// =====================================================
// Disabled SKU (единый источник правды — прогрузчик)
// =====================================================
let DisabledSkuMap = {}; // { [sku]: true }
let DisabledSkuMapLoaded = false;

async function refreshDisabledSkuMap() {
  if (
    !window.DataService ||
    typeof DataService.loadDisabledSkus !== "function"
  ) {
    console.warn("DataService.loadDisabledSkus недоступен");
    DisabledSkuMap = {};
    DisabledSkuMapLoaded = true;
    return DisabledSkuMap;
  }

  const json = await DataService.loadDisabledSkus();
  if (json && json.ok) {
    DisabledSkuMap = json.disabled || {};
    DisabledSkuMapLoaded = true;
    return DisabledSkuMap;
  }

  console.warn("Не удалось загрузить disabled SKU map:", json);
  DisabledSkuMap = {};
  DisabledSkuMapLoaded = true;
  return DisabledSkuMap;
}

async function ensureDisabledSkuMapLoaded() {
  if (DisabledSkuMapLoaded) return DisabledSkuMap;
  return await refreshDisabledSkuMap();
}
let loaderFiltered = [];
let loaderSort = { field: null, dir: 1 };

let disabledCollapsed = true;
let shipmentCollapsed = false;
let activeCollapsed = true;

// реклама
let adsRows = [];
let adsFiltered = [];
let adsSort = { field: null, dir: 1 };

// активная строка (подсветка) для боковой панели
let activeFunnelOfferId = null;
let activeAdsOfferId = null;

// ключи localStorage (сортировка)
const SORT_KEYS = {
  funnelField: "sort:funnel:field",
  funnelDir: "sort:funnel:dir",
  loaderField: "sort:loader:field",
  loaderDir: "sort:loader:dir",
  adsField: "sort:ads:field",
  adsDir: "sort:ads:dir",
};

// =====================================================
// 3-цветные дельты (воронка/панель)
// =====================================================
const DELTA_MINOR_ABS = 0.05; // 5% (пока не используется — оставил на будущее)
const DELTA_MAJOR_ABS = 0.15; // 15%

function classifyDeltaClass(change, { inverse = false } = {}) {
  const num = typeof change === "number" ? change : 0;

  // 0% и “нет числа” — жёлтый
  if (!Number.isFinite(num) || num === 0) return "metric-mid";

  const abs = Math.abs(num);
  const positiveIsGood = !inverse;

  if (abs < DELTA_MAJOR_ABS) return "metric-mid";

  if (num > 0) return positiveIsGood ? "metric-up" : "metric-down";
  return positiveIsGood ? "metric-down" : "metric-up";
}

// =====================================================
// Utils
// =====================================================
function normStr(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ");
}

function formatNumber(n) {
  if (n === null || n === undefined) return "-";
  const num = Number(n);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString("ru-RU");
}

function formatPercent(p) {
  if (p === null || p === undefined) return "-";
  const num = Number(p);
  if (!Number.isFinite(num)) return "-";
  return num.toFixed(1) + "%";
}

function levelFromEmoji(emoji) {
  if (emoji === "🟥") return "bad";
  if (emoji === "🟨") return "warn";
  return "good";
}

function extractValue(row, field) {
  if (!row || !field) return 0;

  // спец-кейс: если попросили сортировать по status (виртуальное поле)
  if (field === "status") {
    const st = evaluateAdsStatus(row);
    // порядок уровней: bad > warn > immature > neutral > good
    const weight = { bad: 4, warn: 3, immature: 2, neutral: 1, good: 0 };
    return weight[st.level] ?? 0;
  }

  const val = row[field];

  if (typeof val === "number") return val;
  if (typeof val === "string") return val.toLowerCase();

  // ✅ FIX: аккуратная сортировка для null/undefined/объектов
  if (val == null) return 0;
  if (typeof val === "boolean") return val ? 1 : 0;

  try {
    // если это что-то вроде { value: ... } — берём value
    if (typeof val === "object" && "value" in val) {
      const v = val.value;
      if (typeof v === "number") return v;
      if (typeof v === "string") return v.toLowerCase();
    }
  } catch {}

  return 0;
}

// =====================================================
// Module configs (front defaults + getters)
// =====================================================
const DEFAULT_FUNNEL_CONFIG = {
  CTR_LOW: 0.03,
  CONV_LOW: 0.05,
  REFUND_WARN: 0.05,
  REFUND_BAD: 0.1,
  DRR_WARN: 0.3,
  DRR_BAD: 0.5,
  MATURITY_THRESHOLDS: {
    IMPRESSIONS: 200,
    CLICKS_FOR_CTR: 10,
    CLICKS_FOR_CONV: 25,
    ORDERS_FOR_CONV: 2,
    ORDERS_FOR_REFUND: 5,
  },
};

const DEFAULT_ADS_CONFIG = {
  ADS_THRESH: {
    CTR_LOW: 0.03,
    CTR_BAD: 0.015,
    CONV_LOW: 0.05,

    DRR_WARN: 0.3,
    DRR_BAD: 0.5,
    DRR_GOOD: 0.25,

    STOCK_BAD_DAYS: 3,
    STOCK_WARN_DAYS: 7,

    NO_ORDER_CLICKS_WARN: 25,
    NO_ORDER_CLICKS_BAD: 60,

    SPEND_WITHOUT_REVENUE_WARN: 700,
    SPEND_WITHOUT_REVENUE_BAD: 1500,
  },
  ADS_MIN_DATA: {
    IMPRESSIONS: 800,
    CLICKS: 20,
    SPEND: 300,
  },
  MIN_STOCK_DAYS_TO_RUN: 3,
  MIN_STOCK_DAYS_TO_SCALE: 7,
};

function getFunnelConfig() {
  const cfg = FunnelConfig || window.FunnelConfig;
  return {
    ...DEFAULT_FUNNEL_CONFIG,
    ...(cfg || {}),
    MATURITY_THRESHOLDS: {
      ...DEFAULT_FUNNEL_CONFIG.MATURITY_THRESHOLDS,
      ...((cfg && cfg.MATURITY_THRESHOLDS) || {}),
    },
  };
}

function getAdsConfig() {
  const cfg = AdsConfig || window.AdsConfig;
  return {
    ...DEFAULT_ADS_CONFIG,
    ...(cfg || {}),
    ADS_THRESH: {
      ...DEFAULT_ADS_CONFIG.ADS_THRESH,
      ...((cfg && cfg.ADS_THRESH) || {}),
    },
    ADS_MIN_DATA: {
      ...DEFAULT_ADS_CONFIG.ADS_MIN_DATA,
      ...((cfg && cfg.ADS_MIN_DATA) || {}),
    },
  };
}

// NOTE:
// setActiveRow() is a pure UI concern and lives in app.ui.js.
// In core we keep only data/state logic.

// =====================================================
// Остатки: цветовой маркер (как в боковой панели)
// =====================================================
function classifyStockLevel(row) {
  const stock = Number(row?.ozon_stock || 0);
  const orders = Number(row?.orders || 0);
  const days = Number(periodDays || 7);

  if (!stock && !orders) return { level: "warn", text: "—" };
  if (!stock && orders > 0) return { level: "bad", text: "0" };
  if (stock > 0 && orders === 0) return { level: "good", text: String(stock) };

  const dailyOrders = orders / Math.max(days, 1);
  if (dailyOrders <= 0) return { level: "good", text: String(stock) };

  const daysOfStock = stock / dailyOrders;

  if (daysOfStock <= 3) return { level: "bad", text: String(stock) };
  if (daysOfStock <= 7) return { level: "warn", text: String(stock) };
  return { level: "good", text: String(stock) };
}

// ------------------------------
// Store switcher (UI only for now)
// ------------------------------
function initStoreSwitcher() {
  const btn = document.getElementById("store-switch-btn");
  const menu = document.getElementById("store-menu");
  if (!btn || !menu) return;

  const STORAGE_KEY = "activeStore";
  const stores = Array.from(menu.querySelectorAll(".store-item"));

  const setActiveStore = (storeId, label) => {
    btn.textContent = label || "🏬 Магазин";
    try {
      localStorage.setItem(STORAGE_KEY, storeId);
    } catch {}
  };

  // restore
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const found = stores.find((b) => b.dataset.store === saved);
      if (found) setActiveStore(saved, found.textContent.trim());
    }
  } catch {}

  const closeMenu = () => menu.classList.add("hidden");
  const toggleMenu = () => menu.classList.toggle("hidden");

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  stores.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = item.dataset.store || "";
      const label = item.textContent.trim();
      setActiveStore(id, label);
      closeMenu();

      // placeholder на будущее: здесь будет переключение токена/магазина + reload
      // loadFunnel();
    });
  });

  document.addEventListener("click", () => closeMenu());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
}

// Дедупликация одинаковых запросов (store + period)
const funnelInFlight = new Map();

let autoRefreshTimer = null;

const AUTO_REFRESH_AFTER_SUCCESS_MS = 60 * 60 * 1000; // 30 минут (или 60*60*1000)

function stopAutoRefresh() {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  autoRefreshTimer = null;
}

function scheduleNextAutoRefresh(reason = "normal") {
  stopAutoRefresh();

  // оффлайн — пробуем чаще, но без спама
  if (navigator.onLine === false) {
    autoRefreshTimer = setTimeout(
      () => scheduleNextAutoRefresh("offline"),
      60 * 1000,
    );
    return;
  }

  const last = Number(REFRESH_UI.lastSuccessAt || 0);
  const base = last > 0 ? last : Date.now(); // если успеха не было — считаем от сейчас
  const nextAt = base + AUTO_REFRESH_AFTER_SUCCESS_MS;
  const delay = Math.max(1000, nextAt - Date.now());

  autoRefreshTimer = setTimeout(async () => {
    // вкладка скрыта — не дёргаем API, но и не крутимся каждую секунду
    if (document.hidden) {
      autoRefreshTimer = setTimeout(
        () => scheduleNextAutoRefresh("hidden"),
        5 * 60 * 1000, // 5 минут
      );
      return;
    }

    // оффлайн или уже идёт запрос
    if (navigator.onLine === false || funnelInFlight.size > 0) {
      autoRefreshTimer = setTimeout(
        () => scheduleNextAutoRefresh("blocked"),
        60 * 1000,
      );
      return;
    }

    try {
      await loadFunnel({ background: true });
      // lastSuccessAt обновляется внутри loadFunnel
    } finally {
      // следующий цикл — уже от нового lastSuccessAt
      scheduleNextAutoRefresh("success");
    }
  }, delay);
}

// =====================================================
// Loading dots animation (обновляю. .. ...)
// =====================================================
let refreshDotsTimer = null;
let refreshDotsCount = 0;

function startLoadingDots() {
  stopLoadingDots();

  refreshDotsTimer = setInterval(() => {
    refreshDotsCount = (refreshDotsCount % 3) + 1;
    renderRefreshButtons();
  }, 900); // скорость "дыхания"
}

function stopLoadingDots() {
  if (refreshDotsTimer) {
    clearInterval(refreshDotsTimer);
    refreshDotsTimer = null;
  }
  refreshDotsCount = 0;
}

// =====================================================
// Refresh UI (дорого-богато): кнопка = действие + статус
// =====================================================
const REFRESH_UI = {
  state: "idle", // idle | loading | ok | error | cache | cache_error
  bg: false,
  lastSuccessAt: null, // timestamp ms
  lastCacheAt: null, // timestamp ms (когда показали кэш/его ts)
  lastErrorAt: null,
  lastErrorMsg: "",
  timer: null,
};

const REFRESH_UI_KEYS = {
  lastSuccessAt: "refresh:lastSuccessAt",
};

function restoreRefreshUi() {
  try {
    const v = localStorage.getItem(REFRESH_UI_KEYS.lastSuccessAt);
    if (v) REFRESH_UI.lastSuccessAt = Number(v) || null;
  } catch {}
}

function persistLastSuccess(ts) {
  try {
    localStorage.setItem(REFRESH_UI_KEYS.lastSuccessAt, String(ts));
  } catch {}
}

function pluralRu(n, one, few, many) {
  // 1 минута, 2-4 минуты, 5+ минут
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatAgo(ts) {
  if (!ts || !Number.isFinite(ts)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins} ${pluralRu(mins, "мин", "мин", "мин")}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${pluralRu(hours, "ч", "ч", "ч")}`;
  const days = Math.floor(hours / 24);
  return `${days} ${pluralRu(days, "д", "д", "д")}`;
}

function setRefreshUiState(next) {
  const prevState = REFRESH_UI.state;

  Object.assign(REFRESH_UI, next);

  // управление анимацией точек
  if (REFRESH_UI.state === "loading") {
    startLoadingDots();
  } else if (prevState === "loading") {
    stopLoadingDots();
  }

  renderRefreshButtons();
}

function getRefreshButtons() {
  const btn1 = document.getElementById("reload-btn");
  const btn2 = document.getElementById("reload-btn-ads");
  return [btn1, btn2].filter(Boolean);
}

function renderRefreshButtons() {
  const btns = getRefreshButtons();
  if (!btns.length) return;

  const { state, bg, lastSuccessAt, lastCacheAt, lastErrorAt } = REFRESH_UI;

  let text = "Обновить";
  let title = "Обновить данные";
  let soft = false;
  let disabled = false;

  if (state === "loading") {
    const dots = ".".repeat(refreshDotsCount || 1);
    text = "Обновляю" + dots;
    title = bg ? "Фоновое обновление…" : "Обновление…";
    soft = bg;
    disabled = !bg;
  } else if (state === "ok") {
    const ago = formatAgo(lastSuccessAt);
    text = ago ? `Обновлено · ${ago}` : "Обновлено";
    title = lastSuccessAt
      ? `Последнее успешное обновление: ${new Date(
          lastSuccessAt,
        ).toLocaleString("ru-RU")}`
      : "Последнее успешное обновление";
  } else if (state === "cache") {
    const ago = formatAgo(lastCacheAt);
    text = ago ? `кэш · ${ago}` : "кэш";
    title = lastCacheAt
      ? `Показан кэш (ts): ${new Date(lastCacheAt).toLocaleString("ru-RU")}`
      : "Показан кэш";
  } else if (state === "cache_error") {
    const ago = formatAgo(lastErrorAt);
    text = `ошибка сети · кэш`;
    title = `Сеть не ответила (${ago || "только что"}). Показываю кэш.`;
  } else if (state === "error") {
    const ago = formatAgo(lastErrorAt);
    text = `ошибка сети`;
    title = `Сеть не ответила (${ago || "только что"}).`;
  } else {
    // idle
    if (lastSuccessAt) {
      const ago = formatAgo(lastSuccessAt);
      text = `Обновлено · ${ago}`;
      title = `Последнее успешное обновление: ${new Date(
        lastSuccessAt,
      ).toLocaleString("ru-RU")}`;
    }
  }

  btns.forEach((b) => {
    b.dataset.originalText ??= b.textContent;

    b.textContent = text;
    b.title = title;

    b.classList.toggle("loading", state === "loading");
    b.classList.toggle("loading-soft", state === "loading" && soft);

    b.disabled = disabled;
  });
}

function startRefreshUiTicker() {
  if (REFRESH_UI.timer) clearInterval(REFRESH_UI.timer);
  REFRESH_UI.timer = setInterval(() => {
    // просто перерисуем текст типа "12 мин" раз в минуту
    renderRefreshButtons();
  }, 60 * 1000);
}

// === Auto refresh: resume when tab becomes visible ===
let visibilityHookInited = false;

function initAutoRefreshVisibilityHook() {
  if (visibilityHookInited) return;
  visibilityHookInited = true;

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleNextAutoRefresh("tab-visible");
    }
  });
}

// =====================================================
// Init
// =====================================================

function setReloadButtonState(isLoading, { soft = false, text } = {}) {
  const btn = document.getElementById("reload-btn");
  const btnAds = document.getElementById("reload-btn-ads"); // добавим ниже
  const targets = [btn, btnAds].filter(Boolean);

  targets.forEach((b) => {
    if (isLoading) {
      b.dataset.originalText ??= b.textContent;
      b.textContent = text || "обновление…";

      // manual: жёстко блокируем, background: нет
      b.disabled = !soft;
      b.classList.add("loading");
      b.classList.toggle("loading-soft", !!soft);
    } else {
      b.textContent = text || b.dataset.originalText || "Обновить данные";
      b.disabled = false;
      b.classList.remove("loading", "loading-soft");
    }
  });
}

// =====================================================
// Unified refresh UI (button = status for all refresh types)
// =====================================================
function setRefreshButtonState({
  isLoading,
  mode = "background",
  text,
  time,
} = {}) {
  const btn = document.getElementById("reload-btn");
  if (!btn) return;

  // исходный текст сохраняем один раз
  btn.dataset.originalText ??= btn.textContent || "Обновить данные";

  // режимы:
  // manual   -> блокируем + "обновление…" (как сейчас)
  // background -> не блокируем, но показываем состояние
  const isManual = mode === "manual";

  if (isLoading) {
    btn.classList.add("refreshing");
    btn.classList.toggle("refreshing-bg", !isManual);

    // текст можно подставлять свой
    btn.textContent = text || (isManual ? "обновление…" : "обновляю… (фон)");

    // ручное — блокируем, фон — нет
    btn.disabled = isManual;
  } else {
    btn.classList.remove("refreshing", "refreshing-bg");

    // после обновления красиво показать время
    const base = btn.dataset.originalText || "Обновить данные";
    if (time) btn.textContent = `${base} · ${time}`;
    else btn.textContent = base;

    btn.disabled = false;
  }
}

// =====================================================
// Sort state
// =====================================================
function loadSortState() {
  try {
    const fField = localStorage.getItem(SORT_KEYS.funnelField);
    const fDir = localStorage.getItem(SORT_KEYS.funnelDir);
    if (fField) {
      currentSort.field = fField;
      const d = parseInt(fDir, 10);
      currentSort.dir = d === -1 ? -1 : 1;
    }

    const lField = localStorage.getItem(SORT_KEYS.loaderField);
    const lDir = localStorage.getItem(SORT_KEYS.loaderDir);
    if (lField) {
      loaderSort.field = lField;
      const d2 = parseInt(lDir, 10);
      loaderSort.dir = d2 === -1 ? -1 : 1;
    }

    const aField = localStorage.getItem(SORT_KEYS.adsField);
    const aDir = localStorage.getItem(SORT_KEYS.adsDir);
    if (aField) {
      adsSort.field = aField;
      const d3 = parseInt(aDir, 10);
      adsSort.dir = d3 === -1 ? -1 : 1;
    }
  } catch (e) {
    console.warn("Не удалось восстановить сортировку:", e.message);
  }
}

function saveFunnelSortState() {
  try {
    if (currentSort.field) {
      localStorage.setItem(SORT_KEYS.funnelField, currentSort.field);
      localStorage.setItem(SORT_KEYS.funnelDir, String(currentSort.dir));
    }
  } catch {}
}

function saveLoaderSortState() {
  try {
    if (loaderSort.field) {
      localStorage.setItem(SORT_KEYS.loaderField, loaderSort.field);
      localStorage.setItem(SORT_KEYS.loaderDir, String(loaderSort.dir));
    }
  } catch {}
}

function saveAdsSortState() {
  try {
    if (adsSort.field) {
      localStorage.setItem(SORT_KEYS.adsField, adsSort.field);
      localStorage.setItem(SORT_KEYS.adsDir, String(adsSort.dir));
    }
  } catch {}
}

// =====================================================
// Tabs
// =====================================================
function getActiveTab() {
  const adsTab = document.getElementById("tab-ads");
  if (adsTab && adsTab.classList.contains("tab-active")) return "ads";

  const loaderTab = document.getElementById("tab-loader");
  if (loaderTab && loaderTab.classList.contains("tab-active")) return "loader";

  return "funnel";
}

function setPageTitle(tab) {
  const el = document.getElementById("page-title");
  if (!el) return;

  if (tab === "funnel") el.textContent = "📊 Воронка";
  else if (tab === "loader") el.textContent = "📦 Прогрузчик";
  else if (tab === "ads") el.textContent = "📣 Реклама";
}

function showTab(tab) {
  const vf = document.getElementById("view-funnel");
  const vl = document.getElementById("view-loader");
  const va = document.getElementById("view-ads");

  document
    .querySelectorAll(".tab-chip")
    .forEach((t) => t.classList.remove("tab-active"));

  if (tab === "funnel") {
    if (vf) vf.classList.remove("hidden");
    if (vl) vl.classList.add("hidden");
    if (va) va.classList.add("hidden");
    const tf = document.getElementById("tab-funnel");
    if (tf) tf.classList.add("tab-active");
  } else if (tab === "loader") {
    if (vl) vl.classList.remove("hidden");
    if (vf) vf.classList.add("hidden");
    if (va) va.classList.add("hidden");
    const tl = document.getElementById("tab-loader");
    if (tl) tl.classList.add("tab-active");
    updateCutFolderButton();
  } else if (tab === "ads") {
    if (va) va.classList.remove("hidden");
    if (vf) vf.classList.add("hidden");
    if (vl) vl.classList.add("hidden");
    const ta = document.getElementById("tab-ads");
    if (ta) ta.classList.add("tab-active");
  }

  setPageTitle(tab);
  hideDetails();
}

// =====================================================
// API / funnel
// =====================================================

function hydrateFunnelFromCache() {
  const key = funnelCacheKey(periodDays);
  const cached = readCache(key);
  if (!cached) return false;

  allRows = cached.rows;

  // Store (не обязателен)
  try {
    if (window.Store && typeof Store.applyFunnel === "function") {
      Store.applyFunnel(allRows, { timestamp: cached.ts || Date.now() });
    }
  } catch (_) {}

  applyFunnelFiltersAndRender();
  buildAdsFromFunnel();

  const fresh = isFresh(cached.ts, FUNNEL_CACHE_TTL_MS);

  setFunnelStatus(
    fresh
      ? "🧠 мгновенный старт · данные свежие"
      : "🧠 мгновенный старт · данные могут быть устаревшими · обновляю…",
  );

  // ✅ Кнопка = статус: показываем, что сейчас отображается кэш
  // Если кэш "свежий" — можем считать это "ok" UX-ом (данные релевантны)
  setRefreshUiState({
    state: fresh ? "ok" : "cache",
    bg: false,
    lastCacheAt: cached.ts || Date.now(),
  });

  return true;
}

async function loadFunnel(opts = {}) {
  const { background = false, force = false } = opts;

  // 0) DataService guard (важно!)
  const ds = window.DataService;
  if (!ds || typeof ds.loadFunnel !== "function") {
    console.error(
      "DataService.loadFunnel недоступен. Проверь подключение dataService.js",
    );
    setFunnelStatus("🔌 DataService не найден");

    setRefreshUiState({
      state: "error",
      bg: false,
      lastErrorAt: Date.now(),
      lastErrorMsg: "DataService.loadFunnel missing",
    });

    return;
  }

  // 1) Мгновенный старт из кэша (если не фон и не force)
  if (!background && !force) {
    try {
      hydrateFunnelFromCache();
    } catch (_) {}
  }

  const storeId =
    typeof getStoreIdSafe === "function" ? getStoreIdSafe() : "default";
  const inflightKey = `funnel:${storeId}:days:${periodDays}`;

  // 2) Дедупликация
  if (!force && funnelInFlight.has(inflightKey)) {
    return funnelInFlight.get(inflightKey);
  }

  const promise = (async () => {
    try {
      // 3) UI: кнопка и статус
      setRefreshUiState({ state: "loading", bg: !!background });

      if (!background) {
        setFunnelStatus("⏳ обновление данных…");
      } else {
        setFunnelStatus("🧠 мгновенный старт · обновляю…");
      }

      // 4) Запрос данных
      const json = await ds.loadFunnel(periodDays);

      // 🔧 Фоллбэки на разные форматы ответа
      const rows = Array.isArray(json?.rows)
        ? json.rows
        : Array.isArray(json?.items)
          ? json.items
          : Array.isArray(json?.data)
            ? json.data
            : Array.isArray(json)
              ? json
              : [];

      const isOk =
        (json && json.ok === true) ||
        (json && json.ok == null && Array.isArray(rows)) ||
        Array.isArray(json); // если вернули сразу массив

      if (!isOk) {
        if (!background) setFunnelStatus("⚠️ данные временно недоступны");

        setRefreshUiState({
          state: "error",
          bg: false,
          lastErrorAt: Date.now(),
          lastErrorMsg: "data not ok",
        });

        return;
      }

      // 5) Применяем данные
      allRows = rows;

      // 6) Кэшируем последний успешный снимок
      const ts = Date.now();
      try {
        writeCache(funnelCacheKey(periodDays), { ts, rows: allRows });
      } catch (_) {}

      // 7) Store (не обязателен)
      try {
        if (window.Store && typeof Store.applyFunnel === "function") {
          Store.applyFunnel(allRows, { timestamp: ts });
        }
      } catch (_) {}

      // 8) Рендер
      applyFunnelFiltersAndRender();
      buildAdsFromFunnel();

      // 9) Статус
      setFunnelStatus(
        "✅ Обновлено · " + new Date(ts).toLocaleTimeString("ru-RU"),
      );

      // ✅ Кнопка = статус: "обновлено · X мин"
      REFRESH_UI.lastSuccessAt = ts;
      persistLastSuccess(ts);

      setRefreshUiState({
        state: "ok",
        bg: false,
        lastSuccessAt: ts,
      });

      scheduleNextAutoRefresh();
    } catch (err) {
      console.error("Ошибка загрузки /api/funnel:", err);

      const now = Date.now();

      if (background) {
        setFunnelStatus(
          "🧠 мгновенный старт · сеть не ответила · показываю кэш",
        );

        setRefreshUiState({
          state: "cache_error",
          bg: false,
          lastErrorAt: now,
          lastErrorMsg: String(err?.message || "network"),
        });
      } else {
        setFunnelStatus("🔌 ошибка соединения");

        setRefreshUiState({
          state: "error",
          bg: false,
          lastErrorAt: now,
          lastErrorMsg: String(err?.message || "network"),
        });
      }
    } finally {
      funnelInFlight.delete(inflightKey);

      // ❌ больше не трогаем setReloadButtonState — кнопкой управляет REFRESH_UI
      // renderRefreshButtons() вызовется из setRefreshUiState()
    }
  })();

  funnelInFlight.set(inflightKey, promise);
  return promise;
}

// =====================================================
// Funnel filters/sort/render
// =====================================================
function applyFunnelFiltersAndRender() {
  let rows = Array.isArray(allRows) ? allRows.slice() : [];

  if (currentPriority && currentPriority !== "all") {
    rows = rows.filter((r) => r.priority === currentPriority);
  }

  if (searchQuery && searchQuery.trim()) {
    rows = rows.filter((r) => matchesSearch(r, searchQuery));
  }

  filteredRows = rows;

  if (currentSort.field) sortFunnelRowsInPlace();

  renderTable(filteredRows);
  updateSortIndicators();
  hideDetails();
}

function sortFunnelRowsInPlace() {
  if (!currentSort.field) return;

  const field = currentSort.field;
  const dir = currentSort.dir || 1;

  filteredRows.sort((a, b) => {
    const v1 = extractValue(a, field);
    const v2 = extractValue(b, field);
    if (v1 < v2) return -1 * dir;
    if (v1 > v2) return 1 * dir;
    return 0;
  });
}

function sortBy(field) {
  if (!field) return;

  if (currentSort.field === field) currentSort.dir *= -1;
  else {
    currentSort.field = field;
    currentSort.dir = 1;
  }

  sortFunnelRowsInPlace();
  saveFunnelSortState();

  renderTable(filteredRows);
  updateSortIndicators();
}

function sortLoaderBy(field) {
  if (!field) return;

  if (loaderSort.field === field) loaderSort.dir *= -1;
  else {
    loaderSort.field = field;
    loaderSort.dir = 1;
  }

  saveLoaderSortState();
  applyLoaderFiltersAndRender();
}

function sortAdsBy(field) {
  if (!field) return;

  if (adsSort.field === field) adsSort.dir *= -1;
  else {
    adsSort.field = field;
    adsSort.dir = 1;
  }

  saveAdsSortState();
  applyAdsFiltersAndRender();
}

function updateSortIndicators() {
  document.querySelectorAll("#funnel-table thead th.sortable").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.field === currentSort.field) {
      th.classList.add(currentSort.dir === 1 ? "sort-asc" : "sort-desc");
    }
  });

  document.querySelectorAll("#loader-table thead th.sortable").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.field === loaderSort.field) {
      th.classList.add(loaderSort.dir === 1 ? "sort-asc" : "sort-desc");
    }
  });

  document.querySelectorAll("#ads-table thead th.sortable").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.field === adsSort.field) {
      th.classList.add(adsSort.dir === 1 ? "sort-asc" : "sort-desc");
    }
  });
}

// =====================================================
// Search (умный: цифры и текст)
// =====================================================
function extractOfferNumbers(row) {
  // ✅ добавил sku тоже, чтобы поиск по цифрам в SKU работал
  const base = `${row.offer_id || ""} ${row.sku || ""} ${row.name || ""}`;
  const nums = [];
  const re = /\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(base)) !== null) {
    nums.push(m[0].replace(",", ".").toLowerCase());
  }
  return nums;
}

function matchesSearch(row, queryRaw) {
  const q = (queryRaw || "").trim().toLowerCase();
  if (!q) return true;

  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;

  const bigStr =
    `${row.offer_id || ""} ${row.sku || ""} ${row.name || ""}`.toLowerCase();

  const numericTokens = [];
  const textTokens = [];

  for (const t of tokens) {
    const tNorm = t.replace(",", ".").toLowerCase();

    // ✅ числовой токен только если он ЦЕЛИКОМ число
    if (/^\d+(?:[.]\d+)?$/.test(tNorm)) numericTokens.push(tNorm);
    else textTokens.push(tNorm);
  }

  // текстовые токены ищем как подстроку
  for (const t of textTokens) {
    if (!bigStr.includes(t)) return false;
  }

  // если числовых токенов нет — достаточно совпадения текста
  if (numericTokens.length === 0) return true;

  // числовые токены должны совпасть с любым найденным числом (точно)
  const offerNums = extractOfferNumbers(row);
  for (const t of numericTokens) {
    const found = offerNums.some((n) => n === t);
    if (!found) return false;
  }

  return true;
}

const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");

function syncSearchClear() {
  searchClear.style.display = searchInput.value.trim() ? "block" : "none";
}

searchInput.addEventListener("input", () => {
  syncSearchClear();
  // тут уже вызывается твоя фильтрация
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  syncSearchClear();

  // ⚠️ важно: триггерим тот же путь, что и обычный ввод
  searchInput.dispatchEvent(new Event("input", { bubbles: true }));

  searchInput.focus();
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && searchInput.value) {
    searchInput.value = "";
    syncSearchClear();
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
});

syncSearchClear();

// =====================================================
// Copy icon for offer_id
// =====================================================

// =====================================================
// Funnel render
// =====================================================

// =====================================================
// Mini chart (optional)
// =====================================================

// =====================================================
// Deltas helpers (details panel)
// =====================================================

// =====================================================
// Layer statuses (details panel)
// =====================================================

function evaluateFunnelLayers(row) {
  const impressions = Number(row?.impressions || 0);
  const clicks = Number(row?.clicks || 0);
  const orders = Number(row?.orders || 0);

  const ad_spend = Number(row?.ad_spend || 0);
  const refundRate = Number(row?.refund_rate || 0);
  const drr = Number(row?.drr || 0);
  const stock = Number(row?.ozon_stock || 0);

  const cfg = getFunnelConfig();
  const CTR_LOW = Number(cfg.CTR_LOW || 0);
  const CONV_LOW = Number(cfg.CONV_LOW || 0);
  const REFUND_WARN = Number(cfg.REFUND_WARN || 0);
  const REFUND_BAD = Number(cfg.REFUND_BAD || 0);
  const DRR_WARN = Number(cfg.DRR_WARN || 0);
  const DRR_BAD = Number(cfg.DRR_BAD || 0);

  // maturity comes from backend (if present)
  const m = row?.funnel_maturity || null;
  const th = m?.thresholds || cfg.MATURITY_THRESHOLDS;

  const infoTraffic = {
    statusClass: "info",
    text: "⏳ Мало данных",
    title: `Нужно: ≥${th.IMPRESSIONS} показов или ≥${th.CLICKS_FOR_CTR} кликов`,
  };

  const infoIntent = {
    statusClass: "info",
    text: "⏳ Мало данных",
    title: `Нужно: ≥${th.CLICKS_FOR_CONV} кликов или ≥${th.ORDERS_FOR_CONV} заказов`,
  };

  const infoPost = {
    statusClass: "info",
    text: "⏳ Мало данных",
    title: `Нужно: ≥${th.ORDERS_FOR_REFUND} заказов`,
  };

  // 1) Показы / трафик (есть ли вообще жизнь)
  let traffic = { statusClass: "ok", text: "ОК" };

  if (impressions === 0 && clicks === 0 && orders === 0) {
    traffic = { statusClass: "bad", text: "Нет трафика" };
  } else if (m && !m.trafficOk) {
    traffic = infoTraffic;
  } else {
    traffic = { statusClass: "ok", text: "ОК" };
  }

  // 2) Переходы в карточку (CTR / клики)
  let interest = { statusClass: "ok", text: "ОК" };

  if (impressions > 0 && clicks === 0) {
    if (m && !m.trafficOk) interest = infoTraffic;
    else interest = { statusClass: "bad", text: "Показы есть, кликов нет" };
  } else if (m && !m.trafficOk) {
    interest = infoTraffic;
  } else if ((row.ctr || 0) < CTR_LOW && impressions > 0) {
    interest = { statusClass: "warn", text: "Низкий CTR" };
  }

  // 3) Намерение к покупке (заказы / конверсия)
  let intent = { statusClass: "ok", text: "ОК" };

  if (clicks === 0 && impressions > 0) {
    // кликов нет — намерение пока не оцениваем
    intent = { statusClass: "info", text: "—", title: "Сначала нужны клики" };
  } else if (m && !m.cardOk) {
    intent = infoIntent;
  } else if (clicks > 0 && orders === 0 && clicks >= 25) {
    intent = { statusClass: "bad", text: "Клики есть, заказов нет" };
  } else if ((row.conv || 0) < CONV_LOW && clicks > 0) {
    intent = { statusClass: "warn", text: "Низкая конверсия" };
  }

  // 4) Возвраты
  let post = { statusClass: "ok", text: "ОК" };

  if (m && !m.postOk) {
    post = infoPost;
  } else if (refundRate >= REFUND_BAD) {
    post = { statusClass: "bad", text: "Критично много возвратов" };
  } else if (refundRate >= REFUND_WARN) {
    post = { statusClass: "warn", text: "Повышенные возвраты" };
  }

  // 5) Реклама (DRR)
  let ads = { statusClass: "ok", text: "ОК" };

  if (!ad_spend || ad_spend === 0) {
    ads = { statusClass: "ok", text: "Реклама не активна" };
  } else if (drr >= DRR_BAD) {
    ads = { statusClass: "bad", text: "DRR слишком высокий" };
  } else if (drr >= DRR_WARN) {
    ads = { statusClass: "warn", text: "DRR повышенный" };
  }

  // 6) Остатки
  let stockLayer = { statusClass: "ok", text: "ОК", daysOfStock: null };

  if (!stock && !orders) {
    stockLayer = {
      statusClass: "info",
      text: "⏳ Нет данных по спросу",
      title: "Остаток есть/нет — но спрос ещё не сформирован",
      daysOfStock: null,
    };
  } else if (!stock && orders > 0) {
    stockLayer = {
      statusClass: "bad",
      text: "Товар закончился",
      daysOfStock: 0,
    };
  } else if (stock > 0 && orders === 0) {
    stockLayer = {
      statusClass: "info",
      text: "⏳ Спрос неясен",
      title: "Заказов нет — дней запаса оценить нельзя",
      daysOfStock: null,
    };
  } else {
    const days = Number(periodDays || 7);
    const dailyOrders = orders / Math.max(days, 1);
    if (dailyOrders > 0) {
      const daysOfStock = stock / dailyOrders;
      stockLayer.daysOfStock = daysOfStock;

      if (daysOfStock <= 3) {
        stockLayer = {
          ...stockLayer,
          statusClass: "bad",
          text: "Закончится ≤ 3 дней",
        };
      } else if (daysOfStock <= 7) {
        stockLayer = {
          ...stockLayer,
          statusClass: "warn",
          text: "Мало запаса (≤ 7 дн.)",
        };
      } else {
        stockLayer = { ...stockLayer, statusClass: "ok", text: "Запас здоров" };
      }
    }
  }

  return { traffic, interest, intent, post, ads, stock: stockLayer };
}

// =====================================================
// Details panel
// =====================================================
function getMinBatchStorageKey(row) {
  const offer = row.offer_id || "";
  const sku = row.sku || "";
  return `minBatch:${offer || sku}`;
}

function getSkuKey(row) {
  return String(row?.sku || "").trim();
}

async function bindParticipateToggle(row) {
  const cb = document.getElementById("d-participate");
  if (!cb) return;

  const skuKey = getSkuKey(row);

  // ✅ Если SKU отключён в справочнике (products.csv), честно показываем это.
  // В этом случае тумблер из воронки не должен "переопределять" справочник,
  // иначе будет путаница: в прогрузчике отключено, а в воронке как будто включено.
  if (row && row.disabled) {
    cb.checked = false;
    cb.disabled = true;
    cb.title = "Отключено в products.csv (справочник товаров)";
    cb.onchange = null;
    return;
  }

  // ✅ Если по SKU вообще нет данных/остатков (как в прогрузчике: hasAnyData=false),
  // прогрузчик отключает такие позиции автоматически. Воронка показывает это честно.
  const inferredNoData =
    Number(row?.impressions || 0) <= 0 &&
    Number(row?.clicks || 0) <= 0 &&
    Number(row?.orders || 0) <= 0 &&
    Number(row?.revenue || 0) <= 0 &&
    Number(row?.ad_spend || 0) <= 0 &&
    Number(row?.ozon_stock || 0) <= 0;

  if (inferredNoData) {
    // Тут мы не знаем про in_transit, поэтому это эвристика.
    // Если нужно будет — добавим точный флаг с бэка.
    cb.checked = false;
    cb.disabled = true;
    cb.title = "Нет данных/остатков — прогрузчик отключает автоматически";
    cb.onchange = null;
    return;
  }

  // если SKU не задан — лучше честно отключить управление
  if (!skuKey) {
    cb.checked = true;
    cb.disabled = true;
    cb.title = "SKU не найден — управление участием недоступно";
    cb.onchange = null;
    return;
  }

  cb.disabled = true;
  cb.title = "Синхронизировано с прогрузчиком";

  // снять предыдущий обработчик, чтобы не плодить запросы
  cb.onchange = null;

  // Подтянуть карту disabled и выставить состояние
  // Всегда подтягиваем свежую карту: в прогрузчике её могли менять в другой вкладке
  await refreshDisabledSkuMap();
  const disabledNow = !!DisabledSkuMap[skuKey];
  cb.checked = !disabledNow;
  cb.disabled = false;

  cb.onchange = async () => {
    const participate = !!cb.checked;

    // optimistic UI, но с защитой
    cb.disabled = true;

    try {
      const json = await DataService.setSkuDisabled(skuKey, !participate);
      if (!json || !json.ok) {
        // откат
        cb.checked = !participate;
        console.warn("Не удалось сохранить участие SKU в прогрузке:", json);
        alert(
          "Не удалось сохранить настройку участия в прогрузке. Проверь соединение и попробуй ещё раз.",
        );
        return;
      }

      // сервер возвращает актуальную карту
      DisabledSkuMap = json.disabled || {};
      DisabledSkuMapLoaded = true;

      // обновить title на всякий
      cb.title = "Синхронизировано с прогрузчиком";
    } catch (e) {
      cb.checked = !participate;
      console.warn("Ошибка при сохранении disabled SKU:", e);
      alert(
        "Ошибка при сохранении настройки участия в прогрузке. Попробуй ещё раз.",
      );
    } finally {
      cb.disabled = false;
    }
  };
}

// =====================================================
// Loader (frontend)
// =====================================================
async function runLoader() {
  const status = document.getElementById("loader-status");
  if (status) status.textContent = "Запрашиваю данные у ассистента...";

  try {
    const json = await DataService.runLoader();

    if (!json.ok) {
      console.error("API /api/loader/run error:", json.error);
      if (status)
        status.textContent =
          "Ошибка прогрузки: " + (json.error || "см. консоль");
      return;
    }

    loaderItems = Array.isArray(json.items) ? json.items : [];

    if (window.Store && typeof Store.applyLoader === "function") {
      Store.applyLoader(loaderItems, { timestamp: Date.now() });
    }

    applyLoaderFiltersAndRender();

    const updatedText = json.updated || "сейчас";
    const fileName = json.fileName || "";

    if (status) {
      if (fileName) {
        const encoded = encodeURIComponent(fileName);
        status.innerHTML =
          "Обновлено: " +
          updatedText +
          `, Excel: <a href="/exports/${encoded}" target="_blank">${fileName}</a>`;
      } else {
        status.textContent = "Обновлено: " + updatedText;
      }
    }
  } catch (e) {
    console.error("Ошибка прогрузки:", e);
    if (status) status.textContent = "Ошибка соединения с сервером";
  }
}

async function openCutFolder() {
  try {
    const res = await fetch("/api/loader/open-cut-folder", { method: "POST" });
    if (!res.ok)
      console.error("API /api/loader/open-cut-folder error:", res.status);
  } catch (e) {
    console.error("Ошибка при открытии папки:", e);
  }
}

function applyLoaderFiltersAndRender() {
  let rows = Array.isArray(loaderItems) ? loaderItems.slice() : [];

  if (searchQuery && searchQuery.trim())
    rows = rows.filter((r) => matchesSearch(r, searchQuery));

  // FIX: убираем O(N²) и нормализуем ключи
  const funnelByOffer = new Map();
  const funnelBySku = new Map();

  if (Array.isArray(allRows) && allRows.length) {
    for (const r of allRows) {
      if (r && r.offer_id) funnelByOffer.set(normStr(r.offer_id), r);
      if (r && r.sku != null) funnelBySku.set(String(r.sku).trim(), r);
    }

    rows = rows.map((row) => {
      const offerKey = row.offer_id ? normStr(row.offer_id) : "";
      const skuKey = row.sku != null ? String(row.sku).trim() : "";

      const match =
        (offerKey && funnelByOffer.get(offerKey)) ||
        (skuKey && funnelBySku.get(skuKey)) ||
        null;

      if (match) {
        return {
          ...row,
          orders: match.orders ?? row.orders ?? 0,
          revenue: match.revenue ?? row.revenue ?? 0,
        };
      }
      return row;
    });
  }

  if (loaderSort.field) {
    const field = loaderSort.field;
    const dir = loaderSort.dir || 1;

    rows.sort((a, b) => {
      const v1 = extractValue(a, field);
      const v2 = extractValue(b, field);
      if (v1 < v2) return -1 * dir;
      if (v1 > v2) return 1 * dir;
      return 0;
    });
  }

  loaderFiltered = rows;
  renderLoaderTable(loaderFiltered);
  updateSortIndicators();
}

async function toggleSkuDisabled(sku, included) {
  const skuKey = String(sku || "").trim();
  if (!skuKey) return;

  const res = await fetch("/api/loader/disabled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku: skuKey, disabled: !included }),
  });

  let json = null;
  try {
    json = await res.json();
  } catch {}

  if (!res.ok || !json || !json.ok) {
    const text = !res.ok ? await res.text().catch(() => "") : "";
    console.error("toggle disabled failed:", res.status, text, json);
    throw new Error("server-not-ok");
  }

  // ✅ синхронизируем общий кэш disabled-карты, чтобы воронка сразу видела изменения
  DisabledSkuMap = json.disabled || {};
  DisabledSkuMapLoaded = true;

  if (Array.isArray(loaderItems)) {
    loaderItems = loaderItems.map((row) => {
      if (String(row.sku) === skuKey) return { ...row, disabled: !included };
      return row;
    });
    applyLoaderFiltersAndRender();
  }
}

// =====================================================
// Config modal (Loader / Funnel / Ads)
// =====================================================
function initConfigModal() {
  const modal = document.getElementById("config-modal");
  const backdrop = document.getElementById("config-backdrop");
  const closeBtn = document.getElementById("config-close");
  const saveBtn = document.getElementById("config-save");
  const resetBtn = document.getElementById("config-reset");

  const btnLoader = document.getElementById("loader-settings");
  const btnFunnel = document.getElementById("funnel-settings");
  const btnAds = document.getElementById("ads-settings");

  const tabLoader = document.getElementById("cfg-tab-loader");
  const tabFunnel = document.getElementById("cfg-tab-funnel");
  const tabAds = document.getElementById("cfg-tab-ads");

  if (!modal || !backdrop || !saveBtn) return;

  let activeModule = "loader";

  const openModal = async (moduleKey) => {
    activeModule = moduleKey || "loader";
    modal.classList.remove("hidden");
    setConfigTab(activeModule);
    await loadModuleConfig(activeModule);
  };

  const closeModal = () => modal.classList.add("hidden");

  // open buttons
  if (btnLoader)
    btnLoader.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal("loader");
    });

  if (btnFunnel)
    btnFunnel.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal("funnel");
    });

  if (btnAds)
    btnAds.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal("ads");
    });

  // tabs
  if (tabLoader) tabLoader.addEventListener("click", () => openModal("loader"));
  if (tabFunnel) tabFunnel.addEventListener("click", () => openModal("funnel"));
  if (tabAds) tabAds.addEventListener("click", () => openModal("ads"));

  backdrop.addEventListener("click", closeModal);

  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeModal();
    });
  }

  saveBtn.addEventListener("click", async () => {
    const data = collectModuleConfig(activeModule);

    try {
      const res = await fetch(`/api/config/${activeModule}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const json = await res.json();
      if (!json.ok || !json.config) {
        alert("Не удалось сохранить конфиг: " + (json.error || "см. консоль"));
        return;
      }

      // обновить локальные/глобальные ссылки
      if (activeModule === "loader") {
        RuntimeConfig = json.config;
        window.RuntimeConfig = RuntimeConfig;
        applyLoaderConfigSideEffects(RuntimeConfig);
      }
      if (activeModule === "funnel") {
        FunnelConfig = json.config;
        window.FunnelConfig = FunnelConfig;
      }
      if (activeModule === "ads") {
        AdsConfig = json.config;
        window.AdsConfig = AdsConfig;
      }

      // ✅ СРАЗУ пересчитать текущий модуль
      // (используем тот же механизм, что и кнопки "Обновить данные")
      try {
        if (activeModule === "funnel") {
          const btn = document.getElementById("reload-btn");
          if (btn) btn.click();
        } else if (activeModule === "ads") {
          const btn = document.getElementById("reload-btn-ads");
          if (btn) btn.click();
        } else if (activeModule === "loader") {
          // если у прогрузчика есть своя "обновить данные" — кликни её.
          // если нет — просто оставим (побочки уже применены через applyLoaderConfigSideEffects)
          const btn = document.getElementById("reload-btn-loader");
          if (btn) btn.click();
        }
      } catch (e) {
        console.warn("Не удалось авто-пересчитать модуль после сохранения:", e);
      }

      closeModal();
    } catch (err) {
      console.error("Ошибка сохранения конфига:", err);
      alert("Ошибка сохранения конфига (см. консоль)");
    }
  });

  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      const moduleName =
        activeModule === "ads"
          ? "Реклама"
          : activeModule === "funnel"
            ? "Воронка"
            : "Прогрузчик";

      const ok = confirm(
        `Точно сбросить настройки модуля «${moduleName}» к дефолту?\n\nТекущие значения будут потеряны.`,
      );
      if (!ok) return;

      try {
        const res = await fetch(`/api/config/${activeModule}/reset`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        const json = await res.json().catch(() => null);
        if (!res.ok || !json || !json.ok) {
          alert(
            "Не удалось сбросить конфиг: " +
              ((json && json.error) || "см. консоль"),
          );
          return;
        }

        // После reset перезагружаем конфиг, чтобы:
        // 1) обновить инпуты
        // 2) обновить RuntimeConfig / FunnelConfig / AdsConfig
        await loadModuleConfig(activeModule);
      } catch (err) {
        console.error("Ошибка сброса конфига:", err);
        alert("Ошибка сброса конфига (см. консоль)");
      }
    });
  }
}

function setConfigTab(moduleKey) {
  const tabs = {
    loader: document.getElementById("cfg-tab-loader"),
    funnel: document.getElementById("cfg-tab-funnel"),
    ads: document.getElementById("cfg-tab-ads"),
  };
  const views = {
    loader: document.getElementById("cfg-view-loader"),
    funnel: document.getElementById("cfg-view-funnel"),
    ads: document.getElementById("cfg-view-ads"),
  };

  Object.values(tabs).forEach((t) => t && t.classList.remove("tab-active"));
  Object.values(views).forEach((v) => v && v.classList.add("hidden"));

  if (tabs[moduleKey]) tabs[moduleKey].classList.add("tab-active");
  if (views[moduleKey]) views[moduleKey].classList.remove("hidden");
}

async function loadModuleConfig(moduleKey) {
  try {
    const res = await fetch(`/api/config/${moduleKey}`);
    const json = await res.json();
    if (!json.ok || !json.config) return;

    const cfg = json.config;

    if (moduleKey === "loader") {
      RuntimeConfig = cfg;
      window.RuntimeConfig = cfg;

      setInputValue("cfg-demand", cfg.DEMAND_FACTOR);
      setInputValue("cfg-days", cfg.DAYS);
      setInputValue("cfg-days-long", cfg.DAYS_LONG);
      setInputValue("cfg-min-stock", cfg.MIN_STOCK_DEFAULT);
      setInputValue("cfg-pack-size", cfg.PACK_SIZE_DEFAULT);
      setInputValue("cfg-alpha", cfg.SALES_SMOOTHING_ALPHA);
      setInputValue("cfg-spike-mult", cfg.SPIKE_MULTIPLIER);
      setInputValue("cfg-spike-cap", cfg.SPIKE_CAP_MULTIPLIER);
      setInputValue("cfg-max-days", cfg.MAX_DAYS_OF_STOCK);
      setInputValue("cfg-max-loader-history", cfg.MAX_LOADER_HISTORY_DAYS);
      setInputValue("cfg-max-funnel-history", cfg.MAX_FUNNEL_HISTORY_DAYS);

      applyLoaderConfigSideEffects(cfg);
      return;
    }

    if (moduleKey === "funnel") {
      FunnelConfig = cfg;
      window.FunnelConfig = cfg;

      setInputValue("cfg-funnel-ctr-low", cfg.CTR_LOW);
      setInputValue("cfg-funnel-conv-low", cfg.CONV_LOW);
      setInputValue("cfg-funnel-refund-warn", cfg.REFUND_WARN);
      setInputValue("cfg-funnel-refund-bad", cfg.REFUND_BAD);
      setInputValue("cfg-funnel-drr-warn", cfg.DRR_WARN);
      setInputValue("cfg-funnel-drr-bad", cfg.DRR_BAD);

      const th = cfg.MATURITY_THRESHOLDS || {};
      setInputValue("cfg-funnel-mat-imp", th.IMPRESSIONS);
      setInputValue("cfg-funnel-mat-clicks-ctr", th.CLICKS_FOR_CTR);
      setInputValue("cfg-funnel-mat-clicks-conv", th.CLICKS_FOR_CONV);
      setInputValue("cfg-funnel-mat-orders-conv", th.ORDERS_FOR_CONV);
      setInputValue("cfg-funnel-mat-orders-ref", th.ORDERS_FOR_REFUND);
      return;
    }

    if (moduleKey === "ads") {
      AdsConfig = cfg;
      window.AdsConfig = cfg;

      const th = cfg.ADS_THRESH || {};
      const md = cfg.ADS_MIN_DATA || {};

      setInputValue("cfg-ads-drr-good", th.DRR_GOOD);
      setInputValue("cfg-ads-drr-warn", th.DRR_WARN);
      setInputValue("cfg-ads-drr-bad", th.DRR_BAD);
      setInputValue("cfg-ads-ctr-low", th.CTR_LOW);
      setInputValue("cfg-ads-conv-low", th.CONV_LOW);

      setInputValue("cfg-ads-min-imp", md.IMPRESSIONS);
      setInputValue("cfg-ads-min-clicks", md.CLICKS);
      setInputValue("cfg-ads-min-spend", md.SPEND);

      setInputValue("cfg-ads-min-stock-run", cfg.MIN_STOCK_DAYS_TO_RUN);
      setInputValue("cfg-ads-min-stock-scale", cfg.MIN_STOCK_DAYS_TO_SCALE);
      return;
    }
  } catch (e) {
    console.error("Ошибка загрузки конфига:", e);
  }
}

function applyLoaderConfigSideEffects(cfg) {
  // обновить подписи/tooltip в таблице прогрузчика (как было раньше)

  const salesTh = document.querySelector(
    '#loader-table thead th[data-field="week_sales_raw"]',
  );
  if (salesTh) {
    salesTh.innerHTML = `Продажи<br><small>за ${cfg.DAYS} д</small>`;
    salesTh.title = `Сколько штук продано за последние ${cfg.DAYS} дней по данным аналитики Ozon.`;
  }

  const salesLongTh = document.querySelector(
    '#loader-table thead th[data-field="week_sales_long_raw"]',
  );
  if (salesLongTh) {
    salesLongTh.innerHTML = `Продажи<br><small>за ${cfg.DAYS_LONG} д</small>`;
    salesLongTh.title = `Сколько штук продано за последние ${cfg.DAYS_LONG} дней (вторая шкала для сравнения тренда).`;
  }

  const smoothTh = document.querySelector(
    '#loader-table thead th[data-field="week_sales_effective"]',
  );
  if (smoothTh) {
    smoothTh.title =
      "Продажи за период 1 с учётом экспоненциального сглаживания (alpha) и защиты от всплесков.";
  }

  const targetTh = document.querySelector(
    '#loader-table thead th[data-field="target_demand"]',
  );
  if (targetTh) {
    targetTh.innerHTML = `Цель спроса`;
    targetTh.title =
      "Расчётная потребность: минимальный из лимита по дням и эффективных продаж × кэфф. спроса, но не ниже минимального запаса.";
  }

  const demandTh = document.querySelector(
    '#loader-table thead th[data-field="demand_factor"]',
  );
  if (demandTh) {
    demandTh.innerHTML = `Кэфф. спроса<br><small>база ${cfg.DEMAND_FACTOR}</small>`;
    demandTh.title =
      "Фактический коэффициент спроса для SKU: адаптация базового кэффа под тренд продаж, остатки и всплески.";
  }

  const needTh = document.querySelector(
    '#loader-table thead th[data-field="need_raw"]',
  );
  if (needTh) {
    needTh.title =
      "Сколько единиц нужно довезти: цель спроса − остатки на складе − товары в пути (может быть 0).";
  }

  const supplyTh = document.querySelector(
    '#loader-table thead th[data-field="NeedGoods"]',
  );
  if (supplyTh) {
    supplyTh.title =
      "Фактическая рекомендация к поставке: расчёт, округлённый вверх до кратности упаковки.";
  }
}

function setInputValue(id, value) {
  const input = document.getElementById(id);
  if (input && value !== undefined) input.value = value;
}

function collectLoaderConfigFromInputs() {
  const read = (id) => {
    const el = document.getElementById(id);
    if (!el) return undefined;
    const val = String(el.value || "").replace(",", ".");
    const num = Number(val);
    return Number.isFinite(num) ? num : undefined;
  };

  const map = {
    DEMAND_FACTOR: "cfg-demand",
    DAYS: "cfg-days",
    DAYS_LONG: "cfg-days-long",
    MIN_STOCK_DEFAULT: "cfg-min-stock",
    PACK_SIZE_DEFAULT: "cfg-pack-size",
    SALES_SMOOTHING_ALPHA: "cfg-alpha",
    SPIKE_MULTIPLIER: "cfg-spike-mult",
    SPIKE_CAP_MULTIPLIER: "cfg-spike-cap",
    MAX_DAYS_OF_STOCK: "cfg-max-days",
    MAX_LOADER_HISTORY_DAYS: "cfg-max-loader-history",
    MAX_FUNNEL_HISTORY_DAYS: "cfg-max-funnel-history",
  };

  const data = {};
  Object.entries(map).forEach(([key, id]) => {
    const v = read(id);
    if (v !== undefined) data[key] = v;
  });

  return data;
}

function collectModuleConfig(moduleKey) {
  if (moduleKey === "loader") return collectLoaderConfigFromInputs();

  const read = (id) => {
    const el = document.getElementById(id);
    if (!el) return undefined;
    const val = String(el.value || "").replace(",", ".");
    const num = Number(val);
    return Number.isFinite(num) ? num : undefined;
  };

  if (moduleKey === "funnel") {
    const data = {
      CTR_LOW: read("cfg-funnel-ctr-low"),
      CONV_LOW: read("cfg-funnel-conv-low"),
      REFUND_WARN: read("cfg-funnel-refund-warn"),
      REFUND_BAD: read("cfg-funnel-refund-bad"),
      DRR_WARN: read("cfg-funnel-drr-warn"),
      DRR_BAD: read("cfg-funnel-drr-bad"),
      MATURITY_THRESHOLDS: {
        IMPRESSIONS: read("cfg-funnel-mat-imp"),
        CLICKS_FOR_CTR: read("cfg-funnel-mat-clicks-ctr"),
        CLICKS_FOR_CONV: read("cfg-funnel-mat-clicks-conv"),
        ORDERS_FOR_CONV: read("cfg-funnel-mat-orders-conv"),
        ORDERS_FOR_REFUND: read("cfg-funnel-mat-orders-ref"),
      },
    };

    // убрать undefined, чтобы не затирать значения случайно
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
    if (data.MATURITY_THRESHOLDS) {
      Object.keys(data.MATURITY_THRESHOLDS).forEach((k) => {
        if (data.MATURITY_THRESHOLDS[k] === undefined)
          delete data.MATURITY_THRESHOLDS[k];
      });
    }
    return data;
  }

  if (moduleKey === "ads") {
    const ADS_THRESH = {
      DRR_GOOD: read("cfg-ads-drr-good"),
      DRR_WARN: read("cfg-ads-drr-warn"),
      DRR_BAD: read("cfg-ads-drr-bad"),
      CTR_LOW: read("cfg-ads-ctr-low"),
      CONV_LOW: read("cfg-ads-conv-low"),
    };
    Object.keys(ADS_THRESH).forEach(
      (k) => ADS_THRESH[k] === undefined && delete ADS_THRESH[k],
    );

    const ADS_MIN_DATA = {
      IMPRESSIONS: read("cfg-ads-min-imp"),
      CLICKS: read("cfg-ads-min-clicks"),
      SPEND: read("cfg-ads-min-spend"),
    };
    Object.keys(ADS_MIN_DATA).forEach(
      (k) => ADS_MIN_DATA[k] === undefined && delete ADS_MIN_DATA[k],
    );

    const data = {
      ADS_THRESH,
      ADS_MIN_DATA,
      MIN_STOCK_DAYS_TO_RUN: read("cfg-ads-min-stock-run"),
      MIN_STOCK_DAYS_TO_SCALE: read("cfg-ads-min-stock-scale"),
    };
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
    return data;
  }

  return {};
}

// =====================================================
// Tooltips (funnel columns)
// =====================================================
function initFunnelTooltips() {
  const map = {
    impressions: "Сколько раз товар показали пользователям в выдаче/рекламе.",
    clicks: "Сколько раз пользователи открывали карточку товара из выдачи.",
    ctr: "Отношение кликов к показам: клики / показы, в процентах.",
    orders: "Сколько заказов было оформлено за выбранный период.",
    conv: "Конверсия: заказы / клики, в процентах.",
    revenue: "Суммарная выручка по заказам за период.",
    ad_spend:
      "Сколько рублей потрачено на рекламу (подтягивается из Performance API).",
    drr: "DRR = затраты на рекламу / выручку. Чем ниже, тем лучше.",
    avg_check: "Средний чек: выручка / число заказов.",
    ozon_stock: "Остатки на складах Ozon, доступные к продаже (без резервов).",
    returns: "Количество возвратов за период.",
    refund_rate:
      "Доля возвратов от числа заказов: возвраты / заказы, в процентах.",
  };

  document.querySelectorAll("#funnel-table thead th.sortable").forEach((th) => {
    const field = th.dataset.field;
    if (field && map[field]) th.title = map[field];
  });
}

// =====================================================
// Cut folder button status
// =====================================================
async function updateCutFolderButton() {
  const btn = document.getElementById("loader-open-cut-folder");
  if (!btn) return;

  try {
    const res = await fetch("/api/loader/cut-status");
    const json = await res.json();

    if (!json.ok) {
      console.error("cut-status response not ok:", json);
      return;
    }

    if (json.hasFile) {
      btn.classList.add("btn-green");
      btn.classList.remove("btn-gray");
      btn.title = "В папке есть файлы резки";
    } else {
      btn.classList.add("btn-gray");
      btn.classList.remove("btn-green");
      btn.title = "Папка резки пустая";
    }
  } catch (e) {
    console.error("Ошибка проверки cut-папки:", e);
  }
}

// =====================================================
// ADS module (управленческий экран)
// =====================================================

function hasEnoughAdsData(row) {
  const cfg = getAdsConfig();
  const ADS_MIN_DATA = cfg.ADS_MIN_DATA;
  const imp = Number(row?.impressions || 0);
  const clicks = Number(row?.clicks || 0);
  const spend = Number(row?.ad_spend || 0);
  return (
    imp >= ADS_MIN_DATA.IMPRESSIONS ||
    clicks >= ADS_MIN_DATA.CLICKS ||
    spend >= ADS_MIN_DATA.SPEND
  );
}

// Возвращает: { level: "bad"|"warn"|"good"|"neutral"|"immature", label, title }
function evaluateAdsStatus(row) {
  const cfg = getAdsConfig();
  const ADS_THRESH = cfg.ADS_THRESH;
  const ADS_MIN_DATA = cfg.ADS_MIN_DATA;
  const MIN_STOCK_DAYS_TO_RUN = Number(cfg.MIN_STOCK_DAYS_TO_RUN || 0);
  const MIN_STOCK_DAYS_TO_SCALE = Number(cfg.MIN_STOCK_DAYS_TO_SCALE || 0);

  const STOCK_BAD_DAYS =
    MIN_STOCK_DAYS_TO_RUN > 0
      ? MIN_STOCK_DAYS_TO_RUN
      : ADS_THRESH.STOCK_BAD_DAYS;
  const STOCK_WARN_DAYS =
    MIN_STOCK_DAYS_TO_SCALE > 0
      ? MIN_STOCK_DAYS_TO_SCALE
      : ADS_THRESH.STOCK_WARN_DAYS;
  const spend = Number(row?.ad_spend || 0);
  const revenue = Number(row?.revenue || 0);
  const drr = Number(row?.drr || 0);

  const impressions = Number(row?.impressions || 0);
  const clicks = Number(row?.clicks || 0);

  const ctr = Number(row?.ctr || 0);
  const conv = Number(row?.conv || 0);

  const orders = Number(row?.orders || 0);
  const stock = Number(row?.ozon_stock || 0);

  // 0) нет расхода
  if (!spend || spend <= 0) {
    return {
      level: "neutral",
      label: "⚪ Нет расхода",
      title: "Реклама не тратится",
    };
  }

  // 1) мало данных — отдельный уровень (и отдельный цвет в UI)
  if (!hasEnoughAdsData(row)) {
    return {
      level: "immature",
      label: "Мало данных",
      title: `Сырые данные: показы ${impressions}, клики ${clicks}, расход ${formatNumber(
        spend,
      )} ₽ (порог: ≥${ADS_MIN_DATA.IMPRESSIONS} показов или ≥${
        ADS_MIN_DATA.CLICKS
      } кликов или ≥${ADS_MIN_DATA.SPEND} ₽)`,
    };
  }

  // 2) дни запаса
  let daysOfStock = null;
  if (stock > 0 && orders > 0) {
    const days = Number(periodDays || 7);
    const daily = orders / Math.max(days, 1);
    if (daily > 0) daysOfStock = stock / daily;
  }

  // 3) жёсткие стопы
  if (stock <= 0 && orders > 0) {
    return {
      level: "bad",
      label: "🟥 Нет товара",
      title: "Остаток 0 при наличии спроса — реклама будет вредить",
    };
  }

  if (daysOfStock != null && daysOfStock <= (STOCK_BAD_DAYS ?? 0)) {
    return {
      level: "bad",
      label: "🟥 Закончится",
      title: `Дней запаса ≈ ${daysOfStock.toFixed(1)} (≤ ${STOCK_BAD_DAYS})`,
    };
  }

  // мягкий стоп по запасу: реклама может быть эффективной, но вредно разгонять при низком запасе
  if (
    daysOfStock != null &&
    MIN_STOCK_DAYS_TO_RUN > 0 &&
    daysOfStock < MIN_STOCK_DAYS_TO_RUN
  ) {
    return {
      level: "warn",
      label: "🟨 Мало запаса",
      title: `Дней запаса ≈ ${daysOfStock.toFixed(
        1,
      )} (< ${MIN_STOCK_DAYS_TO_RUN}). Лучше не разгонять рекламу.`,
    };
  }

  if (drr >= ADS_THRESH.DRR_BAD) {
    return {
      level: "bad",
      label: "🟥 Лить нельзя",
      title: `DRR ${(drr * 100).toFixed(1)}% ≥ ${(
        ADS_THRESH.DRR_BAD * 100
      ).toFixed(0)}%`,
    };
  }

  // 4) кликов много — заказов нет
  if (orders === 0 && clicks >= ADS_THRESH.NO_ORDER_CLICKS_BAD) {
    return {
      level: "bad",
      label: "🟥 Слив (без заказов)",
      title: `Кликов ${clicks}, заказов 0 — карточка/цена/оффер не конвертит`,
    };
  }

  if (orders === 0 && clicks >= ADS_THRESH.NO_ORDER_CLICKS_WARN) {
    return {
      level: "warn",
      label: "🟨 Кликов много, заказов нет",
      title: `Кликов ${clicks}, заказов 0 — проверь цену, фото, оффер, доставку`,
    };
  }

  // 5) расход заметный — выручки нет
  if (revenue <= 0 && spend >= ADS_THRESH.SPEND_WITHOUT_REVENUE_BAD) {
    return {
      level: "bad",
      label: "🟥 Расход без продаж",
      title: `Расход ${formatNumber(spend)} ₽, выручка 0`,
    };
  }

  if (revenue <= 0 && spend >= ADS_THRESH.SPEND_WITHOUT_REVENUE_WARN) {
    return {
      level: "warn",
      label: "🟨 Расход без продаж",
      title: `Расход ${formatNumber(
        spend,
      )} ₽, выручка 0 — дай время/проверь атрибуцию`,
    };
  }

  // 6) предупреждения
  const problems = [];

  if (drr >= ADS_THRESH.DRR_WARN)
    problems.push(`DRR ${(drr * 100).toFixed(1)}%`);

  if (impressions >= 1000 && ctr > 0 && ctr < ADS_THRESH.CTR_BAD) {
    problems.push(`очень низкий CTR ${(ctr * 100).toFixed(2)}%`);
  } else if (ctr > 0 && ctr < ADS_THRESH.CTR_LOW) {
    problems.push(`низкий CTR ${(ctr * 100).toFixed(1)}%`);
  }

  if (conv > 0 && conv < ADS_THRESH.CONV_LOW)
    problems.push(`низкая Conv ${(conv * 100).toFixed(1)}%`);

  if (daysOfStock != null && daysOfStock <= STOCK_WARN_DAYS) {
    problems.push(`мало запаса (${daysOfStock.toFixed(1)} дн.)`);
  }

  if (problems.length) {
    return {
      level: "warn",
      label: "🟨 Требует внимания",
      title: problems.join(" • "),
    };
  }

  // 7) можно масштабировать
  if (orders > 0 && drr > 0 && drr < ADS_THRESH.DRR_GOOD) {
    if (daysOfStock == null || daysOfStock > STOCK_WARN_DAYS) {
      return {
        level: "good",
        label: "🟩 Можно масштабировать",
        title: `DRR ${(drr * 100).toFixed(1)}% < ${(
          ADS_THRESH.DRR_GOOD * 100
        ).toFixed(0)}% и запас ок`,
      };
    }
  }

  return {
    level: "neutral",
    label: "⚪ Норма",
    title: "Нет явных красных/жёлтых флагов",
  };
}

function buildAdsFromFunnel() {
  adsRows = Array.isArray(allRows)
    ? allRows.filter((r) => Number(r?.ad_spend || 0) > 0)
    : [];
  applyAdsFiltersAndRender();
}

function applyAdsFiltersAndRender() {
  let rows = Array.isArray(adsRows) ? adsRows.slice() : [];

  if (searchQuery && searchQuery.trim())
    rows = rows.filter((r) => matchesSearch(r, searchQuery));

  // фильтр по статусу
  if (currentAdsStatus && currentAdsStatus !== "all") {
    rows = rows.filter(
      (row) => evaluateAdsStatus(row).level === currentAdsStatus,
    );
  }

  if (adsSort.field) {
    const field = adsSort.field;
    const dir = adsSort.dir || 1;

    rows.sort((a, b) => {
      const v1 = extractValue(a, field);
      const v2 = extractValue(b, field);
      if (v1 < v2) return -1 * dir;
      if (v1 > v2) return 1 * dir;
      return 0;
    });
  } else {
    // дефолт: “сжигание” = spend * drr
    rows.sort((a, b) => {
      const lossA = Number(a?.ad_spend || 0) * Number(a?.drr || 0);
      const lossB = Number(b?.ad_spend || 0) * Number(b?.drr || 0);
      return lossB - lossA;
    });
  }

  adsFiltered = rows;
  renderAdsTable(adsFiltered);
  updateSortIndicators();
}
