// app.js

let allRows = [];
let filteredRows = [];
let currentSort = { field: null, dir: 1 };
let periodDays = 7;

// поиск + фильтр
let searchQuery = "";
let currentPriority = "all";

// конфиг с бэка (для дефолтной мин. партии)
let RuntimeConfig = null;

// маленький график
let skuChart = null;

// для прогрузчика
let loaderItems = [];
let loaderFiltered = [];
let loaderSort = { field: null, dir: 1 };

let disabledCollapsed = true;
let shipmentCollapsed = false;
let activeCollapsed = true;

// ключи для запоминания сортировки
const SORT_KEYS = {
  funnelField: "sort:funnel:field",
  funnelDir: "sort:funnel:dir",
  loaderField: "sort:loader:field",
  loaderDir: "sort:loader:dir",
};

// ------------------------------
// init
// ------------------------------
document.addEventListener("DOMContentLoaded", () => {
  // поднимаем сохранённую сортировку
  loadSortState();

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

  if (tabFunnel) {
    tabFunnel.addEventListener("click", () => showTab("funnel"));
  }
  if (tabLoader) {
    tabLoader.addEventListener("click", () => showTab("loader"));
  }

  document.querySelectorAll(".period-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document
        .querySelectorAll(".period-chip")
        .forEach((c) => c.classList.remove("period-active"));
      chip.classList.add("period-active");

      periodDays = Number(chip.dataset.days || 7);
      if (getActiveTab() === "funnel") {
        loadFunnel();
      }
    });
  });

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

  // сортировка воронки
  document.querySelectorAll("#funnel-table thead th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      sortBy(th.dataset.field);
    });
  });

  // сортировка прогрузчика
  document.querySelectorAll("#loader-table thead th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      sortLoaderBy(th.dataset.field);
    });
  });

  // запуск прогрузчика
  const loaderBtn = document.getElementById("loader-run");
  if (loaderBtn) {
    loaderBtn.addEventListener("click", () => {
      withFakeProgress(loaderBtn, () => runLoader());
    });
  }

  // закрытие боковой панели
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
    if (!panel.contains(e.target)) {
      hideDetails();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideDetails();
    }
  });

  // поиск
  const searchInput = document.getElementById("search-input");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value || "";
      applyFunnelFiltersAndRender();
      applyLoaderFiltersAndRender();
    });
  }

  initConfigModal();
  loadRuntimeConfig();
  initFunnelTooltips();
});

// ------------------------------
// Сохранение / загрузка сортировки
// ------------------------------
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

// ------------------------------
// Tabs
// ------------------------------
function getActiveTab() {
  const funnelTab = document.getElementById("tab-funnel");
  return funnelTab && funnelTab.classList.contains("tab-active")
    ? "funnel"
    : "loader";
}

function setPageTitle(tab) {
  const el = document.getElementById("page-title");
  if (!el) return;

  if (tab === "funnel") {
    el.textContent = "📊 Воронка по SKU (Lite)";
  } else {
    el.textContent = "📦 Прогрузчик поставок";
  }
}

function showTab(tab) {
  const vf = document.getElementById("view-funnel");
  const vl = document.getElementById("view-loader");

  document
    .querySelectorAll(".tab-chip")
    .forEach((t) => t.classList.remove("tab-active"));

  if (tab === "funnel") {
    if (vf) vf.classList.remove("hidden");
    if (vl) vl.classList.add("hidden");
    const tf = document.getElementById("tab-funnel");
    if (tf) tf.classList.add("tab-active");
  } else {
    if (vl) vl.classList.remove("hidden");
    if (vf) vf.classList.add("hidden");
    const tl = document.getElementById("tab-loader");
    if (tl) tl.classList.add("tab-active");
  }

  setPageTitle(tab);
  hideDetails();
}

// ------------------------------
// API / воронка
// ------------------------------
async function loadFunnel() {
  try {
    const json = await DataService.loadFunnel(periodDays);

    if (!json.ok) {
      console.error("API /api/funnel error:", json.error);

      if (json.rateLimit) {
        alert(
          "OZON вернул лимит запросов (429).\n" +
            "Дай API немного отдохнуть и попробуй ещё раз через 30–60 секунд."
        );
      }

      allRows = [];
      filteredRows = [];
      renderTable([]);
      hideDetails();
      return;
    }

    allRows = Array.isArray(json.rows) ? json.rows : [];

    if (window.Store && typeof Store.applyFunnel === "function") {
      Store.applyFunnel(allRows, { timestamp: Date.now() });
    }

    applyFunnelFiltersAndRender();
  } catch (err) {
    console.error("Ошибка загрузки:", err);
    allRows = [];
    filteredRows = [];
    renderTable([]);
    hideDetails();
  }
}

// ------------------------------
// фильтр + поиск (воронка)
// ------------------------------
function applyFunnelFiltersAndRender() {
  let rows = Array.isArray(allRows) ? allRows.slice() : [];

  // фильтр по приоритету
  if (currentPriority && currentPriority !== "all") {
    rows = rows.filter((r) => r.priority === currentPriority);
  }

  // поиск
  if (searchQuery && searchQuery.trim()) {
    rows = rows.filter((r) => matchesSearch(r, searchQuery));
  }

  filteredRows = rows;

  // если уже есть сохранённая сортировка — применяем
  if (currentSort.field) {
    sortFunnelRowsInPlace();
  }

  renderTable(filteredRows);
  updateSortIndicators();
  hideDetails();
}

// сортировка массива filteredRows по currentSort без смены направления
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

// ------------------------------
// сортировка (воронка)
// ------------------------------
function sortBy(field) {
  if (!field) return;

  if (currentSort.field === field) {
    currentSort.dir *= -1;
  } else {
    currentSort.field = field;
    currentSort.dir = 1;
  }

  sortFunnelRowsInPlace();
  saveFunnelSortState();

  renderTable(filteredRows);
  updateSortIndicators();
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
}

// ------------------------------
// сортировка (прогрузчик)
// ------------------------------
function sortLoaderBy(field) {
  if (!field) return;

  if (loaderSort.field === field) {
    loaderSort.dir *= -1;
  } else {
    loaderSort.field = field;
    loaderSort.dir = 1;
  }

  saveLoaderSortState();
  applyLoaderFiltersAndRender();
}

// ------------------------------
// форматирование
// ------------------------------
function extractValue(row, field) {
  const val = row[field];

  if (typeof val === "number") return val;
  if (typeof val === "string") return val.toLowerCase();
  return 0;
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

// ------------------------------
// Поиск: "200 3 20" / "3 20" и т.п.
// ------------------------------
function extractOfferNumbers(row) {
  const base = `${row.offer_id || ""} ${row.name || ""}`;
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

  const bigStr = `${row.offer_id || ""} ${row.sku || ""} ${
    row.name || ""
  }`.toLowerCase();

  const numericTokens = [];
  const textTokens = [];

  for (const t of tokens) {
    if (/\d/.test(t)) numericTokens.push(t);
    else textTokens.push(t);
  }

  // текстовые токены — обычное "contains" по строке
  for (const t of textTokens) {
    if (!bigStr.includes(t)) return false;
  }

  if (numericTokens.length === 0) {
    return true;
  }

  // числовые токены сравниваем с реальными числами в артикуле / названии
  const offerNums = extractOfferNumbers(row);

  for (const t of numericTokens) {
    const tNorm = t.replace(",", ".").toLowerCase();
    const found = offerNums.some((n) => n === tNorm);
    if (!found) return false;
  }

  return true;
}

// ------------------------------
// Хелпер для иконки копирования
// ------------------------------
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

// ------------------------------
// рендер воронки
// ------------------------------
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
        const tdOffer = createOfferCellTD(row.offer_id || "-");
        tr.appendChild(tdOffer);
        return;
      }

      const td = document.createElement("td");
      const span = document.createElement("span");
      span.textContent = value;

      // заказы: дельта
      if (idx === 5 && row.orders_prev !== undefined) {
        const ch = row.orders_change || 0;
        if (ch > 0.001) span.classList.add("metric-up");
        else if (ch < -0.001) span.classList.add("metric-down");
      }

      // выручка: дельта
      if (idx === 7 && row.revenue_prev !== undefined) {
        const ch = row.revenue_change || 0;
        if (ch > 0.001) span.classList.add("metric-up");
        else if (ch < -0.001) span.classList.add("metric-down");
      }

      // возвраты %: дельта
      if (idx === 13 && row.refund_prev !== undefined) {
        const ch = row.refund_change || 0;
        if (ch > 0.001) span.classList.add("metric-down");
        else if (ch < -0.001) span.classList.add("metric-up");
      }

      // DRR цвет
      if (idx === 9) {
        if (drrLevel === "good") span.classList.add("level-good");
        else if (drrLevel === "warn") span.classList.add("level-warn");
        else span.classList.add("level-bad");
      }

      // Возвраты % цвет
      if (idx === 13) {
        if (refundLevel === "good") span.classList.add("level-good");
        else if (refundLevel === "warn") span.classList.add("level-warn");
        else span.classList.add("level-bad");
      }

      td.appendChild(span);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

// ------------------------------
// маленький график по SKU — жизнь товара
// ------------------------------

function drawSkuChart(points) {
  const canvas = document.getElementById("sku-chart");
  if (!canvas || typeof Chart === "undefined") return;

  const ctx = canvas.getContext("2d");

  if (skuChart) {
    skuChart.destroy();
    skuChart = null;
  }

  const safePoints = Array.isArray(points) ? points : [];

  const labels = safePoints.map((p) => {
    // показываем только день и месяц: 12-03
    return (p.date || "").slice(5);
  });

  const data = safePoints.map((p) => Number(p.orders || 0));

  skuChart = new Chart(ctx, {
    type: "bar", // можно "line", если захочешь линию
    data: {
      labels,
      datasets: [
        {
          label: "Заказано, шт",
          data,
          borderWidth: 1,
        },
      ],
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
  const skuKey = row.sku || row.offer_id;
  if (!skuKey) {
    drawSkuChart([]);
    return;
  }

  // очищаем текущий график на время загрузки
  drawSkuChart([]);

  try {
    // возьмём, например, 14 дней истории
    const days = 14;
    const res = await fetch(
      `/api/funnel/daily-sales?sku=${encodeURIComponent(skuKey)}&days=${days}`
    );
    const json = await res.json();

    if (!json.ok || !Array.isArray(json.points)) {
      console.warn("daily-sales ответ без points", json);
      drawSkuChart([]);
      return;
    }

    drawSkuChart(json.points);
  } catch (e) {
    console.error("Ошибка загрузки дневного графика:", e);
    drawSkuChart([]);
  }
}

// ------------------------------
// дельты
// ------------------------------
function setDelta(id, change, inverse = false) {
  const el = document.getElementById(id);
  if (!el) return;

  const num = typeof change === "number" ? change : 0;
  if (!Number.isFinite(num) || num === 0) {
    el.textContent = " (0%)";
    el.classList.remove("metric-up", "metric-down");
    return;
  }

  const p = num * 100;
  const sign = p > 0 ? "+" : "";
  el.textContent = ` (${sign}${p.toFixed(1)}%)`;

  el.classList.remove("metric-up", "metric-down");
  const positiveIsGood = !inverse;

  if (p > 0) {
    el.classList.add(positiveIsGood ? "metric-up" : "metric-down");
  } else {
    el.classList.add(positiveIsGood ? "metric-down" : "metric-up");
  }
}

// ------------------------------
// статус по слоям воронки (для вертикальной схемы)
// ------------------------------
function setLayerStatus(layerKey, data) {
  const statusEl = document.getElementById(`d-layer-${layerKey}-status`);
  const layerEl = document.querySelector(
    `.funnel-layer[data-layer="${layerKey}"]`
  );

  if (!statusEl || !layerEl || !data) return;

  statusEl.textContent = data.text || "";

  statusEl.classList.remove("ok", "warn", "bad");
  layerEl.classList.remove("layer-ok", "layer-warn", "layer-bad");

  if (data.statusClass) {
    statusEl.classList.add(data.statusClass);

    if (data.statusClass === "ok") layerEl.classList.add("layer-ok");
    else if (data.statusClass === "warn") layerEl.classList.add("layer-warn");
    else if (data.statusClass === "bad") layerEl.classList.add("layer-bad");
  }
}

function evaluateFunnelLayers(row) {
  const impressions = row.impressions || 0;
  const clicks = row.clicks || 0;
  const orders = row.orders || 0;
  const revenue = row.revenue || 0;
  const ad_spend = row.ad_spend || 0;
  const refundRate = row.refund_rate || 0;
  const drr = row.drr || 0;
  const stock = row.ozon_stock || 0;

  const CTR_LOW = 0.03; // 3%
  const CONV_LOW = 0.05; // 5%
  const REFUND_WARN = 0.05; // 5%
  const REFUND_BAD = 0.1; // 10%
  const DRR_WARN = 0.3; // 30%
  const DRR_BAD = 0.5; // 50%
  const MIN_ORDERS_FOR_REFUND = 5;

  // ---------- Слой 1: Показы ----------
  let traffic = { statusClass: "ok", text: "ОК" };

  if (impressions === 0 && clicks === 0 && orders === 0 && revenue === 0) {
    traffic = {
      statusClass: "bad",
      text: "Нет трафика",
    };
  } else {
    const ctr = row.ctr || 0;
    if (ctr < CTR_LOW) {
      traffic = {
        statusClass: "warn",
        text: "Низкий CTR",
      };
    }
  }

  // ---------- Слой 2: Карточка ----------
  let card = { statusClass: "ok", text: "ОК" };

  if (clicks === 0) {
    card = {
      statusClass: "warn",
      text: "Нет данных по кликам",
    };
  } else if (clicks > 0 && orders === 0) {
    card = {
      statusClass: "bad",
      text: "Клики есть, заказов нет",
    };
  } else {
    const conv = row.conv || 0;
    if (conv < CONV_LOW) {
      card = {
        statusClass: "warn",
        text: "Низкая конверсия",
      };
    }
  }

  // ---------- Слой 3: Послепродажа ----------
  let post = { statusClass: "ok", text: "ОК" };

  if (orders < MIN_ORDERS_FOR_REFUND) {
    post = {
      statusClass: "warn",
      text: "Мало данных по возвратам",
    };
  } else if (refundRate >= REFUND_BAD) {
    post = {
      statusClass: "bad",
      text: "Критично много возвратов",
    };
  } else if (refundRate >= REFUND_WARN) {
    post = {
      statusClass: "warn",
      text: "Повышенные возвраты",
    };
  }

  // ---------- Слой 4: Реклама ----------
  let ads = { statusClass: "ok", text: "ОК" };

  if (!ad_spend || ad_spend === 0) {
    ads = {
      statusClass: "ok",
      text: "Реклама не активна",
    };
  } else if (drr >= DRR_BAD) {
    ads = {
      statusClass: "bad",
      text: "DRR слишком высокий",
    };
  } else if (drr >= DRR_WARN) {
    ads = {
      statusClass: "warn",
      text: "DRR повышенный",
    };
  }

  // ---------- Слой 5: Остатки / наличие ----------
  let stockLayer = { statusClass: "ok", text: "ОК", daysOfStock: null };

  if (!stock && !orders) {
    stockLayer = {
      statusClass: "warn",
      text: "Нет данных по запасам",
      daysOfStock: null,
    };
  } else if (!stock && orders > 0) {
    stockLayer = {
      statusClass: "bad",
      text: "Товар закончился",
      daysOfStock: 0,
    };
  } else if (stock > 0 && orders === 0) {
    // спроса нет, но запас есть — пока считаем нормой
    stockLayer = {
      statusClass: "ok",
      text: "Запас есть, мало данных по спросу",
      daysOfStock: null,
    };
  } else {
    const days = periodDays || 7;
    const dailyOrders = orders / days;
    if (dailyOrders <= 0) {
      stockLayer = {
        statusClass: "ok",
        text: "Запас есть, спрос нестабилен",
        daysOfStock: null,
      };
    } else {
      const daysOfStock = stock / dailyOrders;

      stockLayer.daysOfStock = daysOfStock;

      if (daysOfStock <= 3) {
        stockLayer.statusClass = "bad";
        stockLayer.text = "Закончится ≤ 3 дней";
      } else if (daysOfStock <= 7) {
        stockLayer.statusClass = "warn";
        stockLayer.text = "Мало запаса (≤ 7 дн.)";
      } else {
        stockLayer.statusClass = "ok";
        stockLayer.text = "Запас здоров";
      }
    }
  }

  return {
    traffic,
    card,
    post,
    ads,
    stock: stockLayer,
  };
}

// ------------------------------
// ключ для localStorage по мин. партии
// ------------------------------
function getMinBatchStorageKey(row) {
  const offer = row.offer_id || "";
  const sku = row.sku || "";
  return `minBatch:${offer || sku}`;
}

// ------------------------------
// боковая панель
// ------------------------------
function showDetails(row) {
  const panel = document.getElementById("details-panel");
  if (!panel) return;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  // Заголовок + период
  set("details-title", row.offer_id || "-");
  set("d-period", periodDays + " дней");

  // Базовые метрики (текущий период)
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

  // Диагностика + совет (из бэка)
  set("d-diagnosis", row.mainProblem || row.diagnosis || "-");
  set("d-rec", row.recommendation || "-");

  // Динамика vs предыдущий период
  setDelta("d-orders-delta", row.orders_change);
  setDelta("d-revenue-delta", row.revenue_change);
  setDelta("d-refund-delta", row.refund_change, true);

  // Динамика vs долгосрочного среднего
  if (row.conv_vs_avg_long !== undefined) {
    setDelta("d-conv-delta", row.conv_vs_avg_long);
  }
  if (row.drr_vs_avg_long !== undefined) {
    setDelta("d-drr-delta", row.drr_vs_avg_long, true);
  }

  // Мин. партия — берём из localStorage, иначе дефолт MIN_STOCK_DEFAULT
  const minInput = document.getElementById("d-min-batch");
  if (minInput) {
    const key = getMinBatchStorageKey(row);

    const baseDefault =
      RuntimeConfig && RuntimeConfig.MIN_STOCK_DEFAULT != null
        ? Number(RuntimeConfig.MIN_STOCK_DEFAULT)
        : 0;

    let saved = localStorage.getItem(key);
    let valNum = saved != null && saved !== "" ? Number(saved) : baseDefault;

    if (!Number.isFinite(valNum) || valNum < 0) {
      valNum = baseDefault;
    }

    minInput.value = valNum;

    minInput.onchange = () => {
      const v = Number(minInput.value);
      if (Number.isFinite(v) && v >= 0) {
        localStorage.setItem(key, String(v));
      } else {
        minInput.value = baseDefault;
      }
    };
  }

  // Логика по слоям воронки (включая новый слой stock)
  const layers = evaluateFunnelLayers(row);
  setLayerStatus("traffic", layers.traffic);
  setLayerStatus("card", layers.card);
  setLayerStatus("post", layers.post);
  setLayerStatus("ads", layers.ads);
  setLayerStatus("stock", layers.stock);

  // Заполнение "Дней запаса"
  if (layers.stock && typeof layers.stock.daysOfStock === "number") {
    set("d-stock-days", layers.stock.daysOfStock.toFixed(1) + " дн.");
  } else {
    set("d-stock-days", "—");
  }

  // График "жизнь SKU" — берём дневные продажи с бэка
  loadDailySalesChart(row);

  panel.classList.add("visible");
}

function hideDetails() {
  const panel = document.getElementById("details-panel");
  if (!panel) return;
  panel.classList.remove("visible");
}

// ------------------------------
// Универсальный "фейковый" прогресс по кнопке
// ------------------------------
function withFakeProgress(btn, asyncFn) {
  if (!btn) return asyncFn();

  let fill = btn.querySelector(".btn-progress-fill");
  if (!fill) {
    fill = document.createElement("div");
    fill.className = "btn-progress-fill";
    btn.prepend(fill);
  }

  if (btn.classList.contains("btn-loading")) {
    return;
  }

  btn.classList.add("btn-loading");
  btn.disabled = true;

  return Promise.resolve()
    .then(asyncFn)
    .catch((e) => {
      console.error("Ошибка при выполнении действия кнопки:", e);
    })
    .finally(() => {
      btn.classList.remove("btn-loading");
      btn.disabled = false;
    });
}

// ------------------------------
// Прогрузчик (frontend)
// ------------------------------
async function runLoader() {
  const status = document.getElementById("loader-status");

  if (status) {
    status.textContent = "Запрашиваю данные у ассистента...";
  }

  try {
    const json = await DataService.runLoader();

    if (!json.ok) {
      console.error("API /api/loader/run error:", json.error);
      if (status) {
        status.textContent =
          "Ошибка прогрузки: " + (json.error || "см. консоль");
      }
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
    if (status) {
      status.textContent = "Ошибка соединения с сервером";
    }
  }
}

// фильтр + поиск + подмешивание заказов/выручки из воронки + сортировка
function applyLoaderFiltersAndRender() {
  let rows = Array.isArray(loaderItems) ? loaderItems.slice() : [];

  // поиск
  if (searchQuery && searchQuery.trim()) {
    rows = rows.filter((r) => matchesSearch(r, searchQuery));
  }

  // 👉 подмешиваем заказы и выручку из воронки, если она загружена
  if (Array.isArray(allRows) && allRows.length) {
    rows = rows.map((row) => {
      const match = allRows.find(
        (r) =>
          (row.offer_id && r.offer_id === row.offer_id) ||
          (row.sku &&
            (String(r.sku) === String(row.sku) ||
              String(r.offer_id) === String(row.sku)))
      );

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

  // сортировка
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
    if (row.disabled) {
      disabled.push(row);
    } else if (row.included) {
      inShipment.push(row);
    } else {
      activeNoShipment.push(row);
    }
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

    if (row.disabled) {
      tr.classList.add("row-disabled");
    }

    const smoothText =
      (row.week_sales_effective || 0) + (row.spike ? " (!)" : "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !row.disabled;
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSkuDisabled(row.sku, checkbox.checked);
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
        const tdOffer = createOfferCellTD(row.offer_id || "-");
        tr.appendChild(tdOffer);
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
      onToggle: () => {
        shipmentCollapsed = !shipmentCollapsed;
      },
    });

    if (!shipmentCollapsed) {
      inShipment.forEach(addRow);
    }
  }

  if (activeNoShipment.length) {
    if (inShipment.length) addSpacer();

    addGroupHeader("Активные (без поставки)", {
      collapsible: true,
      collapsed: activeCollapsed,
      count: activeNoShipment.length,
      onToggle: () => {
        activeCollapsed = !activeCollapsed;
      },
    });

    if (!activeCollapsed) {
      activeNoShipment.forEach(addRow);
    }
  }

  if (disabled.length) {
    if (inShipment.length || activeNoShipment.length) addSpacer();

    addGroupHeader("Отключены", {
      collapsible: true,
      collapsed: disabledCollapsed,
      count: disabled.length,
      onToggle: () => {
        disabledCollapsed = !disabledCollapsed;
      },
    });

    if (!disabledCollapsed) {
      disabled.forEach(addRow);
    }
  }
}

async function toggleSkuDisabled(sku, included) {
  const skuKey = String(sku || "").trim();
  if (!skuKey) return;

  try {
    await fetch("/api/loader/disabled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: skuKey,
        disabled: !included,
      }),
    });

    if (Array.isArray(loaderItems)) {
      loaderItems = loaderItems.map((row) => {
        if (String(row.sku) === skuKey) {
          return { ...row, disabled: !included };
        }
        return row;
      });
      applyLoaderFiltersAndRender();
    }
  } catch (e) {
    console.error("Ошибка переключения disabled для SKU", skuKey, e);
    alert("Не удалось изменить статус SKU (см. консоль)");
  }
}

// ------------------------------
// Модалка конфига (фронт)
// ------------------------------
function initConfigModal() {
  const cfgBtn = document.getElementById("loader-settings");
  const modal = document.getElementById("config-modal");
  const backdrop = document.getElementById("config-backdrop");
  const closeBtn = document.getElementById("config-close");
  const saveBtn = document.getElementById("config-save");

  if (!cfgBtn || !modal || !backdrop || !saveBtn) {
    return;
  }

  const openModal = () => {
    modal.classList.remove("hidden");
    loadRuntimeConfig();
  };

  const closeModal = () => {
    modal.classList.add("hidden");
  };

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

// ------------------------------
// Подсказки для колонок воронки
// ------------------------------
function initFunnelTooltips() {
  const map = {
    impressions: "Сколько раз товар показали пользователям в выдаче/рекламе.",
    clicks: "Сколько раз пользователи открывали карточку товара из выдачи.",
    ctr: "Отношение кликов к показам: клики / показы, в процентах.",
    orders: "Сколько заказов было оформлено за выбранный период.",
    conv: "Конверсия: заказы / клики, в процентах.",
    revenue: "Суммарная выручка по заказам за период.",
    ad_spend:
      "Сколько рублей потрачено на рекламу (пока заглушка, позже подключим Performance API).",
    drr: "DRR = затраты на рекламу / выручку. Чем ниже, тем лучше.",
    avg_check: "Средний чек: выручка / число заказов.",
    ozon_stock: "Остатки на складах Ozon, доступные к продаже (без резервов).",
    returns:
      "Количество возвратов за период (если метрика доступна в аналитике).",
    refund_rate:
      "Доля возвратов от числа заказов: возвраты / заказы, в процентах.",
  };

  document.querySelectorAll("#funnel-table thead th.sortable").forEach((th) => {
    const field = th.dataset.field;
    if (field && map[field]) {
      th.title = map[field];
    }
  });
}
