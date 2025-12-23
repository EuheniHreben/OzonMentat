// public/app.js
// =====================================================
// Global state
// =====================================================

const GRAPH_ENABLED = false;

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

// маленький график
let skuChart = null;

// прогрузчик
let loaderItems = [];
let loaderFiltered = [];
let loaderSort = { field: null, dir: 1 };

let disabledCollapsed = true;
let shipmentCollapsed = false;
let activeCollapsed = true;

// реклама
let adsRows = [];
let adsFiltered = [];
let adsSort = { field: null, dir: 1 };

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

// =====================================================
// Init
// =====================================================

document.addEventListener("DOMContentLoaded", () => {
  loadSortState();
  initStoreSwitcher();

  // ✅ FIX: если вдруг скрипты подключились не в том порядке
  if (!window.DataService) {
    console.error("DataService не найден. Проверь подключение /dataService.js");
  }

  loadFunnel();
  setPageTitle(getActiveTab());

  const reloadBtn = document.getElementById("reload-btn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", () => {
      withFakeProgress(reloadBtn, () => loadFunnel());
    });
  }

  const tabFunnel = document.getElementById("tab-funnel");
  const tabLoader = document.getElementById("tab-loader");
  const tabAds = document.getElementById("tab-ads");

  if (tabFunnel) tabFunnel.addEventListener("click", () => showTab("funnel"));
  if (tabLoader) tabLoader.addEventListener("click", () => showTab("loader"));
  if (tabAds) tabAds.addEventListener("click", () => showTab("ads"));

  // период (общий): влияет и на воронку, и на рекламу
  document.querySelectorAll(".period-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document
        .querySelectorAll(".period-chip")
        .forEach((c) => c.classList.remove("period-active"));
      chip.classList.add("period-active");

      periodDays = Number(chip.dataset.days || 7);
      loadFunnel();
    });
  });

  // приоритет (воронка)
  document.querySelectorAll(".priority-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document
        .querySelectorAll(".priority-chip")
        .forEach((c) => c.classList.remove("priority-active"));
      chip.classList.add("priority-active");

      currentPriority = chip.dataset.prio || "all";
      applyFunnelFiltersAndRender();
    });
  });

  // статус (реклама)
  document.querySelectorAll(".ads-status-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document
        .querySelectorAll(".ads-status-chip")
        .forEach((c) => c.classList.remove("priority-active"));
      chip.classList.add("priority-active");

      currentAdsStatus = chip.dataset.status || "all";
      applyAdsFiltersAndRender();
    });
  });

  // сортировка воронки
  document.querySelectorAll("#funnel-table thead th.sortable").forEach((th) => {
    th.addEventListener("click", () => sortBy(th.dataset.field));
  });

  // сортировка прогрузчика
  document.querySelectorAll("#loader-table thead th.sortable").forEach((th) => {
    th.addEventListener("click", () => sortLoaderBy(th.dataset.field));
  });

  // сортировка рекламы
  document.querySelectorAll("#ads-table thead th.sortable").forEach((th) => {
    th.addEventListener("click", () => sortAdsBy(th.dataset.field));
  });

  // запуск прогрузчика
  const loaderBtn = document.getElementById("loader-run");
  const loaderSound = document.getElementById("loader-sound");

  if (loaderBtn) {
    loaderBtn.addEventListener("click", () => {
      if (loaderSound) {
        loaderSound.currentTime = 0;
        loaderSound.volume = 1;
        loaderSound.play().catch((err) => console.warn("Audio blocked:", err));
      }
      withFakeProgress(loaderBtn, () => runLoader());
    });
  }

  const openCutFolderBtn = document.getElementById("loader-open-cut-folder");
  if (openCutFolderBtn) {
    openCutFolderBtn.addEventListener("click", () => {
      withFakeProgress(openCutFolderBtn, () => openCutFolder());
    });
  }

  // боковая панель закрытие
  const closeBtn = document.getElementById("details-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideDetails();
    });
  }

  document.addEventListener("click", (e) => {
    const panel = document.getElementById("details-panel");
    if (!panel || !panel.classList.contains("visible")) return;
    if (!panel.contains(e.target)) hideDetails();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideDetails();
  });

  // поиск
  const searchInput = document.getElementById("search-input");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value || "";
      applyFunnelFiltersAndRender();
      applyLoaderFiltersAndRender();
      applyAdsFiltersAndRender();
    });
  }

  initConfigModal();
  loadRuntimeConfig();
  initFunnelTooltips();
});

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

  if (tab === "funnel") el.textContent = "📊 Воронка по SKU";
  else if (tab === "loader") el.textContent = "📦 Прогрузчик поставок";
  else if (tab === "ads") el.textContent = "📣 Реклама по SKU";
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
async function loadFunnel() {
  try {
    const json = await DataService.loadFunnel(periodDays);

    // ✅ FIX: statusEl реально появится только если ты добавишь элемент в HTML
    const statusEl = document.getElementById("funnel-status");
    if (statusEl) {
      const parts = [];
      if (json && json.cached) parts.push("🧠 кэш");
      if (json && json.stale) parts.push("⏳ частое обновление");
      if (json && json.adsEnabled === false) parts.push("📣 реклама off");
      if (json && json.warning) parts.push("⚠️ " + json.warning);
      statusEl.textContent = parts.length ? parts.join(" · ") : "";
    }

    const hasRows = json && Array.isArray(json.rows);
    const isOk = json && (json.ok === true || (json.ok == null && hasRows));

    if (!isOk) {
      if (json && json.rateLimit) {
        console.warn("API /api/funnel rate limit:", json);
        alert(
          "OZON вернул лимит запросов (429).\n" +
            "Дай API немного отдохнуть и попробуй ещё раз через 30–60 секунд."
        );
        return;
      }

      console.warn("⚠️ Funnel: невалидный ответ / временный сбой", json);
      if (statusEl)
        statusEl.textContent = "⏳ Временный сбой данных — попробуй ещё раз";
      hideDetails();
      return;
    }

    allRows = hasRows ? json.rows : [];

    if (window.Store && typeof Store.applyFunnel === "function") {
      Store.applyFunnel(allRows, { timestamp: Date.now() });
    }

    applyFunnelFiltersAndRender();
    buildAdsFromFunnel();
  } catch (err) {
    console.error("Ошибка загрузки /api/funnel:", err);

    const statusEl = document.getElementById("funnel-status");
    if (statusEl) statusEl.textContent = "🔌 Ошибка соединения с сервером";

    hideDetails();
  }
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
  const base = `${row.offer_id || ""} ${row.name || ""}`;
  const nums = [];
  const re = /\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(base)) !== null)
    nums.push(m[0].replace(",", ".").toLowerCase());
  return nums;
}

function matchesSearch(row, queryRaw) {
  const q = (queryRaw || "").trim().toLowerCase();
  if (!q) return true;

  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;

  const bigStr = `${row.offer_id || ""} ${row.sku || ""} ${
    row.name || ""
  }`.toLowerCase();

  const numericTokens = [];
  const textTokens = [];

  for (const t of tokens) {
    if (/\d/.test(t)) numericTokens.push(t);
    else textTokens.push(t);
  }

  for (const t of textTokens) {
    if (!bigStr.includes(t)) return false;
  }

  if (numericTokens.length === 0) return true;

  const offerNums = extractOfferNumbers(row);
  for (const t of numericTokens) {
    const tNorm = t.replace(",", ".").toLowerCase();
    const found = offerNums.some((n) => n === tNorm);
    if (!found) return false;
  }

  return true;
}

// =====================================================
// Copy icon for offer_id
// =====================================================
function makeCopyIcon(textToCopy) {
  const copySpan = document.createElement("span");
  copySpan.className = "copy-icon";
  copySpan.textContent = "⧉";
  copySpan.title = "Скопировать артикул";

  copySpan.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!textToCopy) return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(String(textToCopy))
        .then(() => {
          const original = copySpan.textContent;
          copySpan.textContent = "✓";
          copySpan.classList.add("copied");
          setTimeout(() => {
            copySpan.textContent = original;
            copySpan.classList.remove("copied");
          }, 600);
        })
        .catch(() => {});
    }
  });

  return copySpan;
}

function createOfferCellTD(offerId) {
  const td = document.createElement("td");
  td.classList.add("offer-td");

  const wrapper = document.createElement("div");
  wrapper.className = "offer-cell";

  const spanText = document.createElement("span");
  spanText.className = "offer-text";
  spanText.textContent = offerId || "-";

  const copySpan = makeCopyIcon(offerId);

  wrapper.appendChild(spanText);
  wrapper.appendChild(copySpan);
  td.appendChild(wrapper);

  return td;
}

// =====================================================
// Funnel render
// =====================================================
function renderTable(rows) {
  const tbody = document.querySelector("#funnel-table tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.dataset.sku = row.sku;
    tr.dataset.offerId = row.offer_id || "";

    tr.addEventListener("click", (ev) => {
      ev.stopPropagation();
      showDetails(row);
    });

    const ctrPercent = row.ctr ? row.ctr * 100 : 0;
    const convPercent = row.conv ? row.conv * 100 : 0;
    const drrPercent = row.drr ? row.drr * 100 : 0;
    const refundPercent = row.refund_rate ? row.refund_rate * 100 : 0;

    const drrLevel = levelFromEmoji(row.drrColor);
    const refundLevel = levelFromEmoji(row.refundColor);

    const stockInfo = classifyStockLevel(row);

    const cells = [
      index + 1,
      row.offer_id || "-",
      formatNumber(row.impressions || 0),
      formatNumber(row.clicks || 0),
      formatPercent(ctrPercent),
      formatNumber(row.orders || 0),
      formatPercent(convPercent),
      formatNumber(row.revenue || 0),
      formatNumber(row.ad_spend || 0),
      formatPercent(drrPercent),
      formatNumber(row.avg_check || 0),
      formatNumber(row.ozon_stock || 0),
      formatNumber(row.returns || 0),
      formatPercent(refundPercent),
      row.priority || "-",
    ];

    cells.forEach((value, idx) => {
      if (idx === 1) {
        tr.appendChild(createOfferCellTD(row.offer_id || "-"));
        return;
      }

      const td = document.createElement("td");
      const span = document.createElement("span");
      span.textContent = value;

      const m = row?.funnel_maturity;
      if (m) {
        if (idx === 4 && !m.trafficOk) {
          span.classList.add("level-info");
          span.title = `Мало данных для CTR: ≥${
            m.thresholds?.IMPRESSIONS ?? 200
          } показов или ≥${m.thresholds?.CLICKS_FOR_CTR ?? 10} кликов`;
        }
        if (idx === 6 && !m.cardOk) {
          span.classList.add("level-info");
          span.title = `Мало данных для конверсии: ≥${
            m.thresholds?.CLICKS_FOR_CONV ?? 25
          } кликов или ≥${m.thresholds?.ORDERS_FOR_CONV ?? 2} заказов`;
        }
        if (idx === 13 && !m.postOk) {
          span.classList.add("level-info");
          span.title = `Мало данных по возвратам: ≥${
            m.thresholds?.ORDERS_FOR_REFUND ?? 5
          } заказов`;
        }
      }

      if (idx === 5 && row.orders_prev !== undefined) {
        span.classList.add(
          classifyDeltaClass(row.orders_change, { inverse: false })
        );
      }

      if (idx === 7 && row.revenue_prev !== undefined) {
        span.classList.add(
          classifyDeltaClass(row.revenue_change, { inverse: false })
        );
      }

      if (idx === 13 && row.refund_prev !== undefined) {
        span.classList.add(
          classifyDeltaClass(row.refund_change, { inverse: true })
        );
      }

      if (idx === 9) {
        if (drrLevel === "good") span.classList.add("level-good");
        else if (drrLevel === "warn") span.classList.add("level-warn");
        else span.classList.add("level-bad");
      }

      if (idx === 13) {
        if (refundLevel === "good") span.classList.add("level-good");
        else if (refundLevel === "warn") span.classList.add("level-warn");
        else span.classList.add("level-bad");
      }

      if (idx === 11) {
        if (stockInfo.level === "good") span.classList.add("level-good");
        else if (stockInfo.level === "warn") span.classList.add("level-warn");
        else span.classList.add("level-bad");

        const stock = Number(row?.ozon_stock || 0);
        const orders = Number(row?.orders || 0);
        const days = Number(periodDays || 7);

        if (stock > 0 && orders > 0) {
          const daily = orders / Math.max(days, 1);
          const dos = daily > 0 ? stock / daily : null;
          if (dos != null && Number.isFinite(dos)) {
            span.title = `Дней запаса ≈ ${dos.toFixed(
              1
            )} (порог: ≤3 плохо, ≤7 внимание)`;
          }
        }
      }

      td.appendChild(span);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

// =====================================================
// Mini chart (optional)
// =====================================================
function drawSkuChart(points) {
  if (!GRAPH_ENABLED) return;
  const canvas = document.getElementById("sku-chart");
  if (!canvas || typeof Chart === "undefined") return;

  const ctx = canvas.getContext("2d");

  if (skuChart) {
    skuChart.destroy();
    skuChart = null;
  }

  const safePoints = Array.isArray(points) ? points : [];
  const labels = safePoints.map((p) => (p.date || "").slice(5)); // MM-DD
  const data = safePoints.map((p) => Number(p.orders || 0));

  skuChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{ label: "Заказано, шт", data, borderWidth: 1 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: "#fff" },
          grid: { color: "rgba(255,255,255,0.1)" },
        },
        y: {
          ticks: { color: "#fff" },
          grid: { color: "rgba(255,255,255,0.1)" },
        },
      },
    },
  });
}

async function loadDailySalesChart(row) {
  const skuKey = String(row?.sku || row?.offer_id || "").trim();
  if (!skuKey) return drawSkuChart([]);

  drawSkuChart([]);

  try {
    const days = 14;
    const res = await fetch(
      `/api/funnel/daily-sales?sku=${encodeURIComponent(skuKey)}&days=${days}`
    );
    const json = await res.json();

    if (!json.ok || !Array.isArray(json.points)) return drawSkuChart([]);
    drawSkuChart(json.points);
  } catch (e) {
    console.error("Ошибка загрузки дневного графика:", e);
    drawSkuChart([]);
  }
}

// =====================================================
// Deltas helpers (details panel)
// =====================================================
function setDelta(id, change, inverse = false) {
  const el = document.getElementById(id);
  if (!el) return;

  const num = typeof change === "number" ? change : 0;

  if (!Number.isFinite(num) || num === 0) {
    el.textContent = " (0%)";
    el.classList.remove("metric-up", "metric-down", "metric-mid");
    el.classList.add("metric-mid");
    return;
  }

  const p = num * 100;
  const sign = p > 0 ? "+" : "";
  el.textContent = ` (${sign}${p.toFixed(1)}%)`;

  el.classList.remove("metric-up", "metric-down", "metric-mid");
  el.classList.add(classifyDeltaClass(num, { inverse }));
}

// =====================================================
// Layer statuses (details panel)
// =====================================================
function setLayerStatus(layerKey, data) {
  const statusEl = document.getElementById(`d-layer-${layerKey}-status`);
  const layerEl = document.querySelector(
    `.funnel-layer[data-layer="${layerKey}"]`
  );
  if (!statusEl || !layerEl || !data) return;

  statusEl.textContent = data.text || "";
  if (data.title) statusEl.title = data.title;
  else statusEl.removeAttribute("title");

  statusEl.classList.remove("ok", "warn", "bad", "info");
  layerEl.classList.remove("layer-ok", "layer-warn", "layer-bad", "layer-info");

  if (data.statusClass) {
    statusEl.classList.add(data.statusClass);

    if (data.statusClass === "ok") layerEl.classList.add("layer-ok");
    else if (data.statusClass === "warn") layerEl.classList.add("layer-warn");
    else if (data.statusClass === "bad") layerEl.classList.add("layer-bad");
    else if (data.statusClass === "info") layerEl.classList.add("layer-info");
  }
}

function evaluateFunnelLayers(row) {
  const impressions = Number(row?.impressions || 0);
  const clicks = Number(row?.clicks || 0);
  const orders = Number(row?.orders || 0);

  const ad_spend = Number(row?.ad_spend || 0);
  const refundRate = Number(row?.refund_rate || 0);
  const drr = Number(row?.drr || 0);
  const stock = Number(row?.ozon_stock || 0);

  const CTR_LOW = 0.03;
  const CONV_LOW = 0.05;
  const REFUND_WARN = 0.05;
  const REFUND_BAD = 0.1;
  const DRR_WARN = 0.3;
  const DRR_BAD = 0.5;

  const m = row?.funnel_maturity || null;
  const th = m?.thresholds || {
    IMPRESSIONS: 200,
    CLICKS_FOR_CTR: 10,
    CLICKS_FOR_CONV: 25,
    ORDERS_FOR_CONV: 2,
    ORDERS_FOR_REFUND: 5,
  };

  const infoTraffic = {
    statusClass: "info",
    text: "⏳ Мало данных",
    title: `Нужно: ≥${th.IMPRESSIONS} показов или ≥${th.CLICKS_FOR_CTR} кликов`,
  };

  const infoCard = {
    statusClass: "info",
    text: "⏳ Мало данных",
    title: `Нужно: ≥${th.CLICKS_FOR_CONV} кликов или ≥${th.ORDERS_FOR_CONV} заказов`,
  };

  const infoPost = {
    statusClass: "info",
    text: "⏳ Мало данных",
    title: `Нужно: ≥${th.ORDERS_FOR_REFUND} заказов`,
  };

  let traffic = { statusClass: "ok", text: "ОК" };

  if (impressions === 0 && clicks === 0 && orders === 0) {
    traffic = { statusClass: "bad", text: "Нет трафика" };
  } else if (m && !m.trafficOk) {
    traffic = infoTraffic;
  } else if ((row.ctr || 0) < CTR_LOW) {
    traffic = { statusClass: "warn", text: "Низкий CTR" };
  }

  let card = { statusClass: "ok", text: "ОК" };

  if (clicks === 0 && impressions > 0) {
    if (m && !m.trafficOk) card = infoTraffic;
    else card = { statusClass: "bad", text: "Показы есть, кликов нет" };
  } else if (m && !m.cardOk) {
    card = infoCard;
  } else if (clicks > 0 && orders === 0 && clicks >= 25) {
    card = { statusClass: "bad", text: "Клики есть, заказов нет" };
  } else if ((row.conv || 0) < CONV_LOW && clicks > 0) {
    card = { statusClass: "warn", text: "Низкая конверсия" };
  }

  let post = { statusClass: "ok", text: "ОК" };

  if (m && !m.postOk) {
    post = infoPost;
  } else if (refundRate >= REFUND_BAD) {
    post = { statusClass: "bad", text: "Критично много возвратов" };
  } else if (refundRate >= REFUND_WARN) {
    post = { statusClass: "warn", text: "Повышенные возвраты" };
  }

  let ads = { statusClass: "ok", text: "ОК" };

  if (!ad_spend || ad_spend === 0) {
    ads = { statusClass: "ok", text: "Реклама не активна" };
  } else if (drr >= DRR_BAD) {
    ads = { statusClass: "bad", text: "DRR слишком высокий" };
  } else if (drr >= DRR_WARN) {
    ads = { statusClass: "warn", text: "DRR повышенный" };
  }

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

  return { traffic, card, post, ads, stock: stockLayer };
}

// =====================================================
// Details panel
// =====================================================
function getMinBatchStorageKey(row) {
  const offer = row.offer_id || "";
  const sku = row.sku || "";
  return `minBatch:${offer || sku}`;
}

function showDetails(row) {
  const panel = document.getElementById("details-panel");
  if (!panel) return;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  set("details-title", row.offer_id || "-");
  set("d-period", periodDays + " дней");

  set("d-imp", formatNumber(row.impressions || 0));
  set("d-clicks", formatNumber(row.clicks || 0));
  set("d-ctr", formatPercent((row.ctr || 0) * 100));
  set("d-orders", formatNumber(row.orders || 0));
  set("d-conv", formatPercent((row.conv || 0) * 100));
  set("d-revenue", formatNumber(row.revenue || 0));
  set("d-drr", formatPercent((row.drr || 0) * 100));
  set("d-stock", formatNumber(row.ozon_stock || 0));
  set("d-returns", formatNumber(row.returns || 0));
  set("d-refund", formatPercent((row.refund_rate || 0) * 100));
  set("d-adspend", formatNumber(row.ad_spend || 0));

  set("d-diagnosis", row.mainProblem || row.diagnosis || "-");
  set("d-rec", row.recommendation || "-");

  setDelta("d-orders-delta", row.orders_change);
  setDelta("d-revenue-delta", row.revenue_change);
  setDelta("d-refund-delta", row.refund_change, true);

  if (row.conv_vs_avg_long !== undefined)
    setDelta("d-conv-delta", row.conv_vs_avg_long);
  if (row.drr_vs_avg_long !== undefined)
    setDelta("d-drr-delta", row.drr_vs_avg_long, true);

  const minInput = document.getElementById("d-min-batch");
  if (minInput) {
    const key = getMinBatchStorageKey(row);

    const baseDefault =
      RuntimeConfig && RuntimeConfig.MIN_STOCK_DEFAULT != null
        ? Number(RuntimeConfig.MIN_STOCK_DEFAULT)
        : 0;

    let saved = localStorage.getItem(key);
    let valNum = saved != null && saved !== "" ? Number(saved) : baseDefault;
    if (!Number.isFinite(valNum) || valNum < 0) valNum = baseDefault;

    minInput.value = valNum;

    minInput.onchange = () => {
      const v = Number(minInput.value);
      if (Number.isFinite(v) && v >= 0) localStorage.setItem(key, String(v));
      else minInput.value = baseDefault;
    };
  }

  const layers = evaluateFunnelLayers(row);
  setLayerStatus("traffic", layers.traffic);
  setLayerStatus("card", layers.card);
  setLayerStatus("post", layers.post);
  setLayerStatus("ads", layers.ads);
  setLayerStatus("stock", layers.stock);

  if (layers.stock && typeof layers.stock.daysOfStock === "number")
    set("d-stock-days", layers.stock.daysOfStock.toFixed(1) + " дн.");
  else set("d-stock-days", "—");

  if (GRAPH_ENABLED) loadDailySalesChart(row);

  panel.classList.add("visible");
}

function hideDetails() {
  const panel = document.getElementById("details-panel");
  if (panel) panel.classList.remove("visible");
}

// =====================================================
// Fake progress for buttons
// =====================================================
function withFakeProgress(btn, asyncFn) {
  if (!btn) return asyncFn();

  let fill = btn.querySelector(".btn-progress-fill");
  if (!fill) {
    fill = document.createElement("div");
    fill.className = "btn-progress-fill";
    btn.prepend(fill);
  }

  if (btn.classList.contains("btn-loading")) return;

  btn.classList.add("btn-loading");
  btn.disabled = true;

  return Promise.resolve()
    .then(asyncFn)
    .catch((e) => console.error("Ошибка при выполнении действия кнопки:", e))
    .finally(() => {
      btn.classList.remove("btn-loading");
      btn.disabled = false;
    });
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

function renderLoaderTable(items) {
  const tbody = document.querySelector("#loader-table tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  if (!Array.isArray(items) || !items.length) return;

  const inShipment = [];
  const activeNoShipment = [];
  const disabled = [];

  items.forEach((row) => {
    if (row.disabled) disabled.push(row);
    else if (row.included) inShipment.push(row);
    else activeNoShipment.push(row);
  });

  let index = 1;

  const addSpacer = () => {
    const tr = document.createElement("tr");
    tr.classList.add("loader-group-spacer");
    const td = document.createElement("td");
    td.colSpan = 14;
    tr.appendChild(td);
    tbody.appendChild(tr);
  };

  const addGroupHeader = (label, opts = {}) => {
    const tr = document.createElement("tr");
    tr.classList.add("loader-group-header");
    const td = document.createElement("td");
    td.colSpan = 14;

    const span = document.createElement("span");

    if (opts.collapsible) {
      const icon = document.createElement("span");
      icon.textContent = opts.collapsed ? "▶" : "▼";
      span.appendChild(icon);

      const text = document.createElement("span");
      text.textContent =
        opts.count != null ? `${label} (${opts.count})` : label;
      span.appendChild(text);

      td.addEventListener("click", () => {
        if (typeof opts.onToggle === "function") {
          opts.onToggle();
          renderLoaderTable(loaderFiltered);
        }
      });
      td.style.cursor = "pointer";
    } else {
      span.textContent = label;
    }

    td.appendChild(span);
    tr.appendChild(td);
    tbody.appendChild(tr);
  };

  const addRow = (row) => {
    const tr = document.createElement("tr");
    if (row.disabled) tr.classList.add("row-disabled");

    const smoothText =
      (row.week_sales_effective || 0) + (row.spike ? " (!)" : "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !row.disabled;

    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      const prev = checkbox.checked;
      checkbox.disabled = true;

      toggleSkuDisabled(row.sku, checkbox.checked)
        .catch(() => {
          checkbox.checked = !prev; // rollback
        })
        .finally(() => {
          checkbox.disabled = false;
        });
    });

    const cells = [
      index++,
      row.offer_id || "-",
      checkbox,
      formatNumber(row.orders || 0),
      formatNumber(row.revenue || 0),
      formatNumber(row.ozon_stock || 0),
      formatNumber(row.in_transit || 0),
      formatNumber(row.week_sales_raw || 0),
      formatNumber(row.week_sales_long_raw || 0),
      smoothText,
      formatNumber(row.target_demand || 0),
      row.demand_factor != null ? row.demand_factor.toFixed(2) : "-",
      formatNumber(row.need_raw || 0),
      formatNumber(row.NeedGoods || 0),
    ];

    cells.forEach((val, idx) => {
      if (idx === 1) {
        tr.appendChild(createOfferCellTD(row.offer_id || "-"));
        return;
      }

      const td = document.createElement("td");

      if (idx === 2 && val instanceof HTMLElement) {
        td.appendChild(val);
      } else {
        const span = document.createElement("span");
        span.textContent = val;

        if (idx === 9) {
          if (row.spike) span.classList.add("metric-down");
          else span.classList.add("metric-up");
        }

        td.appendChild(span);
      }

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  };

  if (inShipment.length) {
    addGroupHeader("В поставке", {
      collapsible: true,
      collapsed: shipmentCollapsed,
      count: inShipment.length,
      onToggle: () => (shipmentCollapsed = !shipmentCollapsed),
    });
    if (!shipmentCollapsed) inShipment.forEach(addRow);
  }

  if (activeNoShipment.length) {
    if (inShipment.length) addSpacer();

    addGroupHeader("Активные (без поставки)", {
      collapsible: true,
      collapsed: activeCollapsed,
      count: activeNoShipment.length,
      onToggle: () => (activeCollapsed = !activeCollapsed),
    });
    if (!activeCollapsed) activeNoShipment.forEach(addRow);
  }

  if (disabled.length) {
    if (inShipment.length || activeNoShipment.length) addSpacer();

    addGroupHeader("Отключены", {
      collapsible: true,
      collapsed: disabledCollapsed,
      count: disabled.length,
      onToggle: () => (disabledCollapsed = !disabledCollapsed),
    });
    if (!disabledCollapsed) disabled.forEach(addRow);
  }
}

async function toggleSkuDisabled(sku, included) {
  const skuKey = String(sku || "").trim();
  if (!skuKey) return;

  const res = await fetch("/api/loader/disabled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku: skuKey, disabled: !included }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("toggle disabled failed:", res.status, text);
    throw new Error("server-not-ok");
  }

  if (Array.isArray(loaderItems)) {
    loaderItems = loaderItems.map((row) => {
      if (String(row.sku) === skuKey) return { ...row, disabled: !included };
      return row;
    });
    applyLoaderFiltersAndRender();
  }
}

// =====================================================
// Loader config modal
// =====================================================
function initConfigModal() {
  const cfgBtn = document.getElementById("loader-settings");
  const modal = document.getElementById("config-modal");
  const backdrop = document.getElementById("config-backdrop");
  const closeBtn = document.getElementById("config-close");
  const saveBtn = document.getElementById("config-save");

  if (!cfgBtn || !modal || !backdrop || !saveBtn) return;

  const openModal = () => {
    modal.classList.remove("hidden");
    loadRuntimeConfig();
  };

  const closeModal = () => modal.classList.add("hidden");

  cfgBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openModal();
  });

  backdrop.addEventListener("click", closeModal);

  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeModal();
    });
  }

  saveBtn.addEventListener("click", async () => {
    const data = collectConfigFromInputs();

    try {
      const res = await fetch("/api/loader/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();

      if (!json.ok) {
        alert("Не удалось сохранить конфиг: " + (json.error || "см. консоль"));
        return;
      }

      RuntimeConfig = json.config || RuntimeConfig;
      window.RuntimeConfig = RuntimeConfig;

      closeModal();
    } catch (err) {
      console.error("Ошибка сохранения конфига:", err);
      alert("Ошибка сохранения конфига (см. консоль)");
    }
  });
}

async function loadRuntimeConfig() {
  try {
    const res = await fetch("/api/loader/config");
    const json = await res.json();
    if (!json.ok || !json.config) return;

    const cfg = json.config;

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

    const salesTh = document.querySelector(
      '#loader-table thead th[data-field="week_sales_raw"]'
    );
    if (salesTh) {
      salesTh.innerHTML = `Продажи<br><small>за ${cfg.DAYS} д</small>`;
      salesTh.title = `Сколько штук продано за последние ${cfg.DAYS} дней по данным аналитики Ozon.`;
    }

    const salesLongTh = document.querySelector(
      '#loader-table thead th[data-field="week_sales_long_raw"]'
    );
    if (salesLongTh) {
      salesLongTh.innerHTML = `Продажи<br><small>за ${cfg.DAYS_LONG} д</small>`;
      salesLongTh.title = `Сколько штук продано за последние ${cfg.DAYS_LONG} дней (вторая шкала для сравнения тренда).`;
    }

    const smoothTh = document.querySelector(
      '#loader-table thead th[data-field="week_sales_effective"]'
    );
    if (smoothTh) {
      smoothTh.title =
        "Продажи за период 1 с учётом экспоненциального сглаживания (alpha) и защиты от всплесков.";
    }

    const targetTh = document.querySelector(
      '#loader-table thead th[data-field="target_demand"]'
    );
    if (targetTh) {
      targetTh.innerHTML = `Цель спроса`;
      targetTh.title =
        "Расчётная потребность: минимальный из лимита по дням и эффективных продаж × кэфф. спроса, но не ниже минимального запаса.";
    }

    const demandTh = document.querySelector(
      '#loader-table thead th[data-field="demand_factor"]'
    );
    if (demandTh) {
      demandTh.innerHTML = `Кэфф. спроса<br><small>база ${cfg.DEMAND_FACTOR}</small>`;
      demandTh.title =
        "Фактический коэффициент спроса для SKU: адаптация базового кэффа под тренд продаж, остатки и всплески.";
    }

    const needTh = document.querySelector(
      '#loader-table thead th[data-field="need_raw"]'
    );
    if (needTh) {
      needTh.title =
        "Сколько единиц нужно довезти: цель спроса − остатки на складе − товары в пути (может быть 0).";
    }

    const supplyTh = document.querySelector(
      '#loader-table thead th[data-field="NeedGoods"]'
    );
    if (supplyTh) {
      supplyTh.title =
        "Фактическая рекомендация к поставке: расчёт, округлённый вверх до кратности упаковки.";
    }
  } catch (e) {
    console.error("Ошибка загрузки конфига:", e);
  }
}

function setInputValue(id, value) {
  const input = document.getElementById(id);
  if (input && value !== undefined) input.value = value;
}

function collectConfigFromInputs() {
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

// пороги статуса
const ADS_THRESH = {
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
};

// Минимальный порог “данных достаточно”
// Если у тебя уже определено на проекте — эта секция не мешает (можно удалить).
const ADS_MIN_DATA = window.ADS_MIN_DATA || {
  IMPRESSIONS: 800,
  CLICKS: 20,
  SPEND: 300,
};

function hasEnoughAdsData(row) {
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
        spend
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

  if (daysOfStock != null && daysOfStock <= ADS_THRESH.STOCK_BAD_DAYS) {
    return {
      level: "bad",
      label: "🟥 Закончится",
      title: `Дней запаса ≈ ${daysOfStock.toFixed(1)} (≤ ${
        ADS_THRESH.STOCK_BAD_DAYS
      })`,
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
        spend
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

  if (daysOfStock != null && daysOfStock <= ADS_THRESH.STOCK_WARN_DAYS) {
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
    if (daysOfStock == null || daysOfStock > ADS_THRESH.STOCK_WARN_DAYS) {
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
      (row) => evaluateAdsStatus(row).level === currentAdsStatus
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

function renderAdsTable(rows) {
  const tbody = document.querySelector("#ads-table tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.dataset.sku = row.sku;
    tr.dataset.offerId = row.offer_id || "";

    tr.addEventListener("click", (ev) => {
      ev.stopPropagation();
      showDetails(row);
    });

    const drrLevel = levelFromEmoji(row.drrColor);
    const status = evaluateAdsStatus(row);

    // ПОРЯДОК КОЛОНОК (как ты просил):
    // #, артикул, показы, заказы, продажи, расход, дрр, ctr, конверсия, остаток, статус.
    const cells = [
      index + 1, // 0
      row.offer_id || "-", // 1
      formatNumber(row.impressions || 0), // 2
      formatNumber(row.orders || 0), // 3
      formatNumber(row.revenue || 0), // 4
      formatNumber(row.ad_spend || 0), // 5
      formatPercent((row.drr || 0) * 100), // 6
      formatPercent((row.ctr || 0) * 100), // 7
      formatPercent((row.conv || 0) * 100), // 8
      formatNumber(row.ozon_stock || 0), // 9
      status.label, // 10
    ];

    cells.forEach((value, idx) => {
      if (idx === 1) {
        tr.appendChild(createOfferCellTD(row.offer_id || "-"));
        return;
      }

      const td = document.createElement("td");
      const span = document.createElement("span");
      span.textContent = value;

      // DRR цвет (idx 6)
      if (idx === 6) {
        if (drrLevel === "good") span.classList.add("level-good");
        else if (drrLevel === "warn") span.classList.add("level-warn");
        else span.classList.add("level-bad");
      }

      // Статус цвет (idx 10)
      if (idx === 10) {
        span.classList.remove(
          "level-good",
          "level-warn",
          "level-bad",
          "level-info"
        );

        if (status.level === "good") span.classList.add("level-good");
        else if (status.level === "warn") span.classList.add("level-warn");
        else if (status.level === "bad") span.classList.add("level-bad");
        else if (status.level === "immature") span.classList.add("level-info");

        if (status.title) span.title = status.title;
      }

      td.appendChild(span);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}
