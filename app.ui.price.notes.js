// public/app.ui.js
// =====================================================
// Init glue extracted from app.js (keeps legacy behavior)
// =====================================================

document.addEventListener("DOMContentLoaded", () => {
  loadSortState();
  initStoreSwitcher();

  restoreRefreshUi();
  startRefreshUiTicker();
  renderRefreshButtons();

  // ✅ FIX: если вдруг скрипты подключились не в том порядке
  if (!window.DataService) {
    console.error("DataService не найден. Проверь подключение /dataService.js");
  }

  hydrateFunnelFromCache();
  loadFunnel({ background: true }); // обновим в фоне
  scheduleNextAutoRefresh("init");
  setPageTitle(getActiveTab());

  const reloadBtn = document.getElementById("reload-btn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", () => {
      loadFunnel({ force: true });
    });
  }

  const reloadBtnAds = document.getElementById("reload-btn-ads");
  if (reloadBtnAds) {
    reloadBtnAds.addEventListener("click", () => {
      withFakeProgress(reloadBtnAds, () => loadFunnel({ force: true }));
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
  // подтянуть конфиги модулей на старте, чтобы статусы считались по актуальным порогам
  loadModuleConfig("loader");
  loadModuleConfig("funnel");
  loadModuleConfig("ads");
  initFunnelTooltips();
});

// =====================================================
// UI functions moved from app.core.js
// (DOM rendering, panels, progress, charts)
// =====================================================

function setActiveRow({ tableId, offerId }) {
  if (!tableId) return;

  // снять старую подсветку
  document
    .querySelectorAll(`#${tableId} tbody tr.row-active`)
    .forEach((tr) => tr.classList.remove("row-active"));

  if (!offerId) return;

  const selector = `#${tableId} tbody tr[data-offer-id="${CSS.escape(
    String(offerId),
  )}"]`;
  const tr = document.querySelector(selector);
  if (tr) tr.classList.add("row-active");
}
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
          }, 1000);
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
function renderTable(rows) {
  const tbody = document.querySelector("#funnel-table tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.dataset.sku = row.sku;
    tr.dataset.offerId = row.offer_id || "";

    // подсветка активной строки (если боковая панель открыта)
    if (activeFunnelOfferId && (row.offer_id || "") === activeFunnelOfferId) {
      tr.classList.add("row-active");
    }

    tr.addEventListener("click", (ev) => {
      ev.stopPropagation();

      // сделать активной строкой воронки
      activeFunnelOfferId = row.offer_id || "";
      setActiveRow({ tableId: "funnel-table", offerId: activeFunnelOfferId });

      // на всякий случай сбросить подсветку рекламы
      if (activeAdsOfferId) {
        activeAdsOfferId = null;
        setActiveRow({ tableId: "ads-table", offerId: null });
      }

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
          classifyDeltaClass(row.orders_change, { inverse: false }),
        );
      }

      if (idx === 7 && row.revenue_prev !== undefined) {
        span.classList.add(
          classifyDeltaClass(row.revenue_change, { inverse: false }),
        );
      }

      if (idx === 13 && row.refund_prev !== undefined) {
        span.classList.add(
          classifyDeltaClass(row.refund_change, { inverse: true }),
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
              1,
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

// cache last drawn sku chart so we can redraw it after notes changes
let __lastSkuChart = { row: null, points: [] };
// cache for derived price chart (revenue/orders)
let __lastSkuPriceChart = { row: null, points: [] };
let __lastSkuStockChart = { row: null, points: [] };

function redrawSkuChartIfNeeded(row) {
  if (!GRAPH_ENABLED) return;
  if (!skuChart) return;
  if (!__lastSkuChart.row) return;

  // перерисовываем только если это тот же offer_id
  if (String(__lastSkuChart.row.offer_id || "") !== String(row.offer_id || ""))
    return;

  drawSkuChart(__lastSkuChart.points || [], __lastSkuChart.row);
}

function redrawSkuPriceChartIfNeeded(row) {
  if (!GRAPH_ENABLED) return;
  if (!skuPriceChart) return;
  if (!__lastSkuPriceChart.row) return;

  if (
    String(__lastSkuPriceChart.row.offer_id || "") !== String(row.offer_id || "")
  )
    return;

  drawSkuPriceChart(__lastSkuPriceChart.points || [], __lastSkuPriceChart.row);
}

function redrawSkuStockChartIfNeeded(row) {
  if (!GRAPH_ENABLED) return;
  if (!skuStockChart) return;
  if (!__lastSkuStockChart.row) return;

  if (
    String(__lastSkuStockChart.row.offer_id || "") !==
    String(row.offer_id || "")
  )
    return;

  drawSkuStockChart(__lastSkuStockChart.points || [], __lastSkuStockChart.row);
}

function drawSkuChart(points, row) {
  if (!GRAPH_ENABLED) return;

  const canvas =
    document.getElementById("sku-orders-chart") ||
    document.getElementById("sku-orders-chart-canvas");

  if (!canvas || typeof Chart === "undefined") return;

  const ctx = canvas.getContext("2d");

  if (skuChart) {
    skuChart.destroy();
    skuChart = null;
  }

  if (skuPriceChart) {
    skuPriceChart.destroy();
    skuPriceChart = null;
  }

  const safePoints = Array.isArray(points) ? points : [];

  // ---------- NOTES MAP: YYYY-MM-DD -> [noteText,...] ----------
  const storeId = Store.getActiveStore();
  const offerId = row?.offer_id;

  const notes = offerId ? loadNotes(storeId, offerId) : [];

  const pad2 = (n) => String(n).padStart(2, "0");
  const localDateKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };

  const notesByDate = {};
  notes.forEach((n) => {
    const k = localDateKey(n.ts);
    if (!notesByDate[k]) notesByDate[k] = [];
    const t = String(n.text || "").trim();
    if (t) notesByDate[k].push(t);
  });

  // ---------- CHART DATA ----------
  const labels = safePoints.map((p) => (p.date || "").slice(5)); // MM-DD
  const data = safePoints.map((p) => Number(p.orders || 0));

  // есть ли заметка на эту дату
  const hasNoteArr = safePoints.map((p) => !!notesByDate[p.date]);

  // визуальный маркер: толще обводка у баров с заметкой
  const borderWidthArr = hasNoteArr.map((has) => (has ? 3 : 1));
  const borderColorArr = hasNoteArr.map((has) =>
    has ? "rgba(74, 222, 128, 0.85)" : "rgba(255,255,255,0.25)",
  );

  skuChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Заказано, шт",
          data,

          // ✅ ВОЗВРАЩАЕМ ЦВЕТ БАРОВ
          backgroundColor: "rgba(74, 222, 128, 0.35)",

          // маркеры заметок
          borderWidth: borderWidthArr,
          borderColor: borderColorArr,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            // добавим к тултипу заметки
            afterBody: (items) => {
              if (!items || !items.length) return;

              const i = items[0].dataIndex;
              const point = safePoints[i];
              const dateKey = point?.date;
              const texts = dateKey ? notesByDate[dateKey] : null;

              if (!texts || !texts.length) return;

              // показываем до 3 заметок, остальное "и ещё N"
              const max = 3;
              const shown = texts.slice(0, max).map((t) => {
                const oneLine = t.replace(/\s+/g, " ").trim();
                const cut =
                  oneLine.length > 70 ? oneLine.slice(0, 70) + "…" : oneLine;
                return `📝 ${cut}`;
              });

              if (texts.length > max)
                shown.push(`…и ещё ${texts.length - max}`);

              return shown;
            },
          },
        },
      },
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

function drawSkuPriceChart(points, row) {
  if (!GRAPH_ENABLED) return;

  const canvas = document.getElementById("sku-price-chart");
  if (!canvas || typeof Chart === "undefined") return;
  const ctx = canvas.getContext("2d");

  if (skuPriceChart) {
    skuPriceChart.destroy();
    skuPriceChart = null;
  }

  const safePoints = Array.isArray(points) ? points : [];

  // ---------- NOTES MAP: YYYY-MM-DD -> [noteText,...] ----------
  const storeId = Store.getActiveStore();
  const offerId = row?.offer_id;

  const notes = offerId ? loadNotes(storeId, offerId) : [];

  const pad2 = (n) => String(n).padStart(2, "0");
  const localDateKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };

  const notesByDate = {};
  notes.forEach((n) => {
    const k = localDateKey(n.ts);
    if (!notesByDate[k]) notesByDate[k] = [];
    const t = String(n.text || "").trim();
    if (t) notesByDate[k].push(t);
  });

  const labels = safePoints.map((p) => (p.date || "").slice(5)); // MM-DD
  const data = safePoints.map((p) => {
    const orders = Number(p.orders || 0);
    const revenue = Number(p.revenue || 0);
    if (!Number.isFinite(orders) || orders <= 0) return null; // gap
    if (!Number.isFinite(revenue) || revenue < 0) return null;
    return revenue / orders;
  });

  // есть ли заметка на эту дату
  const hasNoteArr = safePoints.map((p) => !!notesByDate[p.date]);

  // маркеры заметок на точках (крупнее + зелёная обводка)
  const pointRadiusArr = hasNoteArr.map((has) => (has ? 5 : 3));
  const pointBorderWidthArr = hasNoteArr.map((has) => (has ? 2 : 0));
  const pointBorderColorArr = hasNoteArr.map((has) =>
    has ? "rgba(74, 222, 128, 0.95)" : "rgba(255,255,255,0.0)",
  );

  skuPriceChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Фактическая цена (выручка/заказы)",
          data,
          spanGaps: true,
          pointRadius: pointRadiusArr,
          pointBorderWidth: pointBorderWidthArr,
          pointBorderColor: pointBorderColorArr,
          tension: 0.25,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const v = item.raw;
              if (v == null) return "Нет заказов";
              // округляем до 1 знака, но без навязывания валюты
              return `Факт. цена: ${Number(v).toFixed(1)}`;
            },
            afterBody: (items) => {
              if (!items || !items.length) return;

              const i = items[0].dataIndex;
              const point = safePoints[i];
              const dateKey = point?.date;
              const texts = dateKey ? notesByDate[dateKey] : null;

              if (!texts || !texts.length) return;

              const max = 3;
              const shown = texts.slice(0, max).map((t) => {
                const oneLine = t.replace(/\s+/g, " ").trim();
                const cut =
                  oneLine.length > 70 ? oneLine.slice(0, 70) + "…" : oneLine;
                return `📝 ${cut}`;
              });

              if (texts.length > max) shown.push(`…и ещё ${texts.length - max}`);

              return shown;
            },
          },
        },
      },
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

function drawSkuStockChart(points, row) {
  if (!GRAPH_ENABLED) return;
  const canvas = document.getElementById("sku-stock-chart");
  if (!canvas || typeof Chart === "undefined") return;

  const ctx = canvas.getContext("2d");

  if (skuStockChart) {
    skuStockChart.destroy();
    skuStockChart = null;
  }

  const safePoints = Array.isArray(points) ? points : [];
  const labels = safePoints.map((p) => (p.date || "").slice(5)); // MM-DD

  const est = safePoints.map((p) =>
    p.source === "estimated" ? Number(p.ozon_stock || 0) : null,
  );
  const fact = safePoints.map((p) =>
    p.source === "snapshot" ? Number(p.ozon_stock || 0) : null,
  );

  skuStockChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data: fact,
          pointRadius: 3,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false, },
        tooltip: {
          callbacks: {
            label: (item) => {
              const i = item.dataIndex;
              const p = safePoints[i];
              if (!p) return "";
              return `Остаток: ${Number(p.ozon_stock || 0)}`;
            },
          },
        },
      },
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
  // ✅ берем ТОЛЬКО sku (а не offer_id/название)
  const skuKey =
    typeof getSkuKey === "function"
      ? getSkuKey(row)
      : String(row?.sku || "").trim();

  // ✅ запомним, какой row сейчас в панели (даже если данных нет)
  if (typeof __lastSkuChart === "object" && __lastSkuChart) {
    __lastSkuChart.row = row;
  }

  if (!skuKey) {
    console.warn("Нет sku у строки — график не строим:", row);
    if (typeof __lastSkuChart === "object" && __lastSkuChart) {
      __lastSkuChart.points = [];
    }
    drawSkuPriceChart([], row);
    return drawSkuChart([], row);
  }

  const reqId = ++skuChartReqId;

  // ✅ очистка графика
  drawSkuChart([], row);
  drawSkuPriceChart([], row);

  try {
    // const days = Number(periodDays || 7);
    const days = Number(periodDays || 14) * 3;

    const res = await fetch(
      `/api/funnel/daily-sales?sku=${encodeURIComponent(skuKey)}&days=${days}`,
    );
    const json = await res.json();

    if (reqId !== skuChartReqId) return;

    if (!json.ok || !Array.isArray(json.points)) {
      if (typeof __lastSkuChart === "object" && __lastSkuChart) {
        __lastSkuChart.points = [];
      }
      drawSkuPriceChart([], row);
      return drawSkuChart([], row);
    }

    // ✅ кэшируем точки, чтобы можно было redraw после заметок без запроса
    if (typeof __lastSkuChart === "object" && __lastSkuChart) {
      __lastSkuChart = { row, points: json.points };
    }

    if (typeof __lastSkuPriceChart === "object" && __lastSkuPriceChart) {
      __lastSkuPriceChart = { row, points: json.points };
    }

    drawSkuChart(json.points, row);
    drawSkuPriceChart(json.points, row);
  } catch (e) {
    if (reqId !== skuChartReqId) return;
    console.error("Ошибка загрузки дневного графика:", e);

    if (typeof __lastSkuChart === "object" && __lastSkuChart) {
      __lastSkuChart.points = [];
    }

    drawSkuChart([], row);
    drawSkuPriceChart([], row);
  }
}

async function loadSkuStockChart(row) {
  const skuKey =
    typeof getSkuKey === "function"
      ? getSkuKey(row)
      : String(row?.sku || "").trim();

  if (typeof __lastSkuStockChart === "object" && __lastSkuStockChart) {
    __lastSkuStockChart.row = row;
  }

  if (!skuKey) {
    if (typeof __lastSkuStockChart === "object" && __lastSkuStockChart) {
      __lastSkuStockChart.points = [];
    }
    return drawSkuStockChart([], row);
  }

  const reqId = ++skuStockChartReqId;
  drawSkuStockChart([], row);

  try {
    const days = Number(periodDays || 14) * 3;
    const json = window.DataService
      ? await DataService.loadStockHistory(skuKey, days, false)
      : await (async () => {
          const r = await fetch(
            `/api/stock-history?sku=${encodeURIComponent(skuKey)}&days=${days}`,
          );
          return await r.json();
        })();

    if (reqId !== skuStockChartReqId) return;

    if (!json || !json.ok || !Array.isArray(json.points)) {
      if (typeof __lastSkuStockChart === "object" && __lastSkuStockChart) {
        __lastSkuStockChart.points = [];
      }
      return drawSkuStockChart([], row);
    }

    if (typeof __lastSkuStockChart === "object" && __lastSkuStockChart) {
      __lastSkuStockChart = { row, points: json.points };
    }

    return drawSkuStockChart(json.points, row);
  } catch (e) {
    if (reqId !== skuStockChartReqId) return;
    console.error("Ошибка загрузки графика остатков:", e);
    if (typeof __lastSkuStockChart === "object" && __lastSkuStockChart) {
      __lastSkuStockChart.points = [];
    }
    return drawSkuStockChart([], row);
  }
}

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
function setLayerStatus(layerKey, data) {
  const statusEl = document.getElementById(`d-layer-${layerKey}-status`);
  const layerEl = document.querySelector(
    `.funnel-layer[data-layer="${layerKey}"]`,
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

function showDetails(row) {
  const panel = document.getElementById("details-panel");
  if (!panel) return;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  const titleEl = document.getElementById("details-title");
  if (titleEl) {
    titleEl.innerHTML = ""; // очищаем при переключении SKU

    const textSpan = document.createElement("span");
    textSpan.textContent = row.offer_id || "-";

    titleEl.appendChild(textSpan);

    if (row.offer_id) {
      const copyIcon = makeCopyIcon(row.offer_id);
      titleEl.appendChild(copyIcon);
    }
  }

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
  // ✅ Участвует в прогрузке — синхронизировано с модулем прогрузчика
  bindParticipateToggle(row);

  const layers = evaluateFunnelLayers(row);
  setLayerStatus("traffic", layers.traffic);
  setLayerStatus("interest", layers.interest);
  setLayerStatus("intent", layers.intent);
  setLayerStatus("post", layers.post);
  setLayerStatus("ads", layers.ads);
  setLayerStatus("stock", layers.stock);

  if (layers.stock && typeof layers.stock.daysOfStock === "number")
    set("d-stock-days", layers.stock.daysOfStock.toFixed(1) + " дн.");
  else set("d-stock-days", "—");

  if (GRAPH_ENABLED) {
    loadDailySalesChart(row);
    loadSkuStockChart(row);
  }

  // ✅ ЗАМЕТКИ: важно обновлять "текущий row" и отрисовать список
  setCurrentNotesRow(row);
  renderNotes(row);

  panel.classList.add("visible");
}

function hideDetails() {
  const panel = document.getElementById("details-panel");
  if (panel) panel.classList.remove("visible");

  // отменяем любые «висящие» ответы по графику
  skuChartReqId++;
  skuStockChartReqId++;

  // очищаем график, чтобы при следующем SKU не мигал старый
  if (skuChart) {
    skuChart.destroy();
    skuChart = null;
  }

  if (skuStockChart) {
    skuStockChart.destroy();
    skuStockChart = null;
  }

  // снять подсветку активных строк
  activeFunnelOfferId = null;
  activeAdsOfferId = null;
  setActiveRow({ tableId: "funnel-table", offerId: null });
  setActiveRow({ tableId: "ads-table", offerId: null });
}

// ================================
// NOTES LOGIC (side panel notes)
// ================================

const NOTES_VERSION = "v1";

function deleteNote(storeId, offerId, noteId) {
  const notes = loadNotes(storeId, offerId);
  const next = notes.filter((n) => n.id !== noteId);
  saveNotes(storeId, offerId, next);
}

/**
 * Получаем ключ localStorage
 */
function getNotesStorageKey(storeId, offerId) {
  return `notes:${NOTES_VERSION}:${storeId}:offer:${offerId}`;
}

/**
 * Загрузка заметок
 */
function loadNotes(storeId, offerId) {
  try {
    const raw = localStorage.getItem(getNotesStorageKey(storeId, offerId));
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn("Failed to load notes", e);
    return [];
  }
}

/**
 * Сохранение заметок
 */
function saveNotes(storeId, offerId, notes) {
  localStorage.setItem(
    getNotesStorageKey(storeId, offerId),
    JSON.stringify(notes),
  );
}

/**
 * Формат даты
 */
function formatDate(ts) {
  const d = new Date(ts);
  return (
    d.toLocaleDateString("ru-RU") +
    " " +
    d.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    })
  );
}

/**
 * Сколько дней прошло
 */
function daysAgo(ts) {
  const now = new Date();
  const d = new Date(ts);

  const pad2 = (n) => String(n).padStart(2, "0");
  const key = (x) =>
    `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;

  const nowKey = key(now);
  const dKey = key(d);

  if (dKey === nowKey) return "сегодня";

  // “вчера” по календарю
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (dKey === key(y)) return "вчера";

  // иначе — количество календарных дней
  const startOfNow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfD = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
  ).getTime();
  const days = Math.round((startOfNow - startOfD) / (1000 * 60 * 60 * 24));

  if (days === 1) return "1 день назад";
  return `${days} дней назад`;
}

/**
 * Создаём слепок метрик из текущего row
 */
function makeSnapshot(row) {
  return {
    impressions: row.impressions,
    clicks: row.clicks,
    ctr: row.ctr,
    orders: row.orders,
    conv: row.conv,
    revenue: row.revenue,
    ad_spend: row.ad_spend,
    drr: row.drr,
    stock: row.ozon_stock,
    returns: row.returns,
    refund_rate: row.refund_rate,
  };
}

/**
 * Рендер заметок
 */
function renderNotes(row) {
  const storeId = Store.getActiveStore();
  const offerId = row.offer_id;
  const list = document.getElementById("notes-list");
  if (!list) return;

  const notes = loadNotes(storeId, offerId);
  list.innerHTML = "";

  if (!notes.length) {
    list.innerHTML = `<div class="muted">Заметок пока нет</div>`;
    return;
  }

  notes
    .slice()
    .reverse()
    .forEach((note) => {
      const card = document.createElement("div");
      card.className = "note-card";

      // ---- META (date + daysAgo + delete) ----
      const meta = document.createElement("div");
      meta.className = "note-meta";

      const left = document.createElement("span");
      left.textContent = formatDate(note.ts);

      const right = document.createElement("span");
      right.textContent = daysAgo(note.ts);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "note-del";
      delBtn.textContent = "✕";
      delBtn.title = "Удалить заметку";

      delBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // чтобы не сработало закрытие панели по клику вне
        deleteNote(storeId, offerId, note.id);
        renderNotes(row);
        redrawSkuChartIfNeeded(row);
        redrawSkuStockChartIfNeeded(row);
        redrawSkuPriceChartIfNeeded(row);
      });

      const rightBox = document.createElement("span");
      rightBox.style.display = "inline-flex";
      rightBox.style.alignItems = "center";
      rightBox.style.gap = "8px";
      rightBox.appendChild(right);
      rightBox.appendChild(delBtn);

      meta.appendChild(left);
      meta.appendChild(rightBox);

      const text = document.createElement("div");
      text.className = "note-text";
      text.textContent = note.text;

      card.appendChild(meta);
      card.appendChild(text);

      // ---- METRICS COMPARISON ----
      if (note.snapshot) {
        const metrics = document.createElement("div");
        metrics.className = "note-metrics";

        const fields = [
          ["orders", "Заказы"],
          ["revenue", "Выручка"],
          ["ctr", "CTR"],
          ["conv", "Конверсия"],
          ["drr", "DRR"],
          ["ad_spend", "Расход"],
          ["stock", "Остаток"],
        ];

        fields.forEach(([key, label]) => {
          const oldVal = note.snapshot[key];
          const curVal = key === "stock" ? row.ozon_stock : row[key];

          if (oldVal == null || curVal == null) return;

          // delta в % (для отображения)
          let deltaPct = null;
          if (oldVal !== 0) {
            deltaPct = ((curVal - oldVal) / oldVal) * 100;
          }

          // class нужен в "долях" (как в setDelta), поэтому делим на 100
          const cls =
            deltaPct == null
              ? "metric-mid"
              : classifyDeltaClass(deltaPct / 100, { inverse: key === "drr" });

          const fmt = (k, v) => {
            if (k === "ctr" || k === "conv" || k === "drr") {
              return `${(Number(v) * 100).toFixed(2)}%`;
            }
            return typeof formatNumber === "function"
              ? formatNumber(v || 0)
              : String(v);
          };

          const rowEl = document.createElement("div");
          rowEl.className = "note-row";
          rowEl.innerHTML = `
            <span class="label">${label}</span>
            <span class="vals ${cls}">
              ${fmt(key, oldVal)} → ${fmt(key, curVal)}
              ${
                deltaPct != null
                  ? ` (${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`
                  : ""
              }
            </span>
          `;
          metrics.appendChild(rowEl);
        });

        card.appendChild(metrics);
      }

      list.appendChild(card);
    });
}

/**
 * Инициализация UI заметок (вызывать из showDetails)
 */

// текущий row, для которого открыта панель
let __notesCurrentRow = null;

function setCurrentNotesRow(row) {
  __notesCurrentRow = row;
  initNotesUi(); // гарантируем, что кнопка привязана
}

function initNotesUi() {
  const textarea = document.getElementById("note-text");
  const saveBtn = document.getElementById("note-save");
  if (!textarea || !saveBtn) return;

  // биндим кнопку только один раз
  if (saveBtn.dataset.bound === "1") return;
  saveBtn.dataset.bound = "1";

  saveBtn.addEventListener("click", () => {
    const row = __notesCurrentRow;
    if (!row) return;

    const text = textarea.value.trim();
    if (!text) return;

    const storeId = Store.getActiveStore();
    const offerId = row.offer_id;

    const notes = loadNotes(storeId, offerId);

    notes.push({
      id:
        window.crypto && crypto.randomUUID
          ? crypto.randomUUID()
          : String(Date.now()),
      ts: Date.now(),
      text,
      snapshot: makeSnapshot(row),
    });

    saveNotes(storeId, offerId, notes);

    textarea.value = "";

    // обновляем список заметок
    renderNotes(row);

    // ✅ сразу обновляем график, чтобы тултип увидел новую заметку
    redrawSkuChartIfNeeded(row);
    redrawSkuStockChartIfNeeded(row);
        redrawSkuPriceChartIfNeeded(row);
  });
}

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
function renderAdsTable(rows) {
  const tbody = document.querySelector("#ads-table tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.dataset.sku = row.sku;
    tr.dataset.offerId = row.offer_id || "";

    // подсветка активной строки (если боковая панель открыта)
    if (activeAdsOfferId && (row.offer_id || "") === activeAdsOfferId) {
      tr.classList.add("row-active");
    }

    tr.addEventListener("click", (ev) => {
      ev.stopPropagation();

      // сделать активной строкой рекламы
      activeAdsOfferId = row.offer_id || "";
      setActiveRow({ tableId: "ads-table", offerId: activeAdsOfferId });

      // на всякий случай сбросить подсветку воронки
      if (activeFunnelOfferId) {
        activeFunnelOfferId = null;
        setActiveRow({ tableId: "funnel-table", offerId: null });
      }

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
          "level-info",
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

// ================================
// HOTKEYS: ArrowUp / ArrowDown
// ================================

document.addEventListener("keydown", (e) => {
  // не мешаем вводу текста
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  // панель должна быть открыта
  const panel = document.getElementById("details-panel");
  if (!panel || !panel.classList.contains("visible")) return;

  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;

  e.preventDefault();

  const table = document.getElementById("funnel-table");
  if (!table) return;

  const rows = Array.from(table.querySelectorAll("tbody tr"));
  if (!rows.length) return;

  let idx = rows.findIndex((tr) => tr.classList.contains("row-active"));

  // если вдруг нет активной строки — берём первую
  if (idx === -1) idx = 0;

  if (e.key === "ArrowUp") idx = Math.max(0, idx - 1);
  if (e.key === "ArrowDown") idx = Math.min(rows.length - 1, idx + 1);

  const nextRowEl = rows[idx];
  if (!nextRowEl) return;

  const offerId = nextRowEl.dataset.offerId;
  if (!offerId) return;

  // ищем данные строки по offer_id
  const rowData =
    (window.currentFunnelRows || []).find(
      (r) => String(r.offer_id) === String(offerId),
    ) || null;

  if (!rowData) return;

  // подсветка + открытие
  activeFunnelOfferId = offerId;
  setActiveRow({ tableId: "funnel-table", offerId });
  showDetails(rowData);

  // аккуратно скроллим таблицу
  nextRowEl.scrollIntoView({
    block: "nearest",
    behavior: "smooth",
  });
});
