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
  startAutoRefresh();
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
    String(offerId)
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

  if (GRAPH_ENABLED) loadDailySalesChart(row);

  panel.classList.add("visible");
}
function hideDetails() {
  const panel = document.getElementById("details-panel");
  if (panel) panel.classList.remove("visible");

  // снять подсветку активных строк
  activeFunnelOfferId = null;
  activeAdsOfferId = null;
  setActiveRow({ tableId: "funnel-table", offerId: null });
  setActiveRow({ tableId: "ads-table", offerId: null });
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
