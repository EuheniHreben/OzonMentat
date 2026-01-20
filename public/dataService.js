// dataService.js
// Тонкий слой общения с бекендом.
// Возвращает JSON-ответ сервера, но аккуратно обрабатывает ошибки/429/202.

async function requestJson(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    return { ok: false, networkError: true, error: e?.message || String(e) };
  }

  let data = null;

  // сервер обычно возвращает JSON, но на всякий случай страхуемся
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      data = await res.json();
    } catch (e) {
      data = { ok: false, error: "Не удалось распарсить JSON ответа сервера" };
    }
  } else {
    // если вдруг пришёл текст/HTML
    try {
      const text = await res.text();
      data = {
        ok: false,
        error: `Сервер вернул не-JSON (${res.status})`,
        raw: text?.slice?.(0, 4000) || "",
      };
    } catch (e) {
      data = { ok: false, error: `Сервер вернул не-JSON (${res.status})` };
    }
  }

  // Если HTTP статус не OK, но сервер всё равно отдал полезный JSON — возвращаем его
  if (!res.ok) {
    return {
      ok: false,
      httpStatus: res.status,
      ...data,
    };
  }

  return data;
}

const DataService = {
  // Воронка
  async loadFunnel(days = 7) {
    return await requestJson(`/api/funnel?days=${encodeURIComponent(days)}`);
    // возможные поля:
    // ok, rows, cached, stale, warning, pending, adsEnabled...
  },

  // ✅ График: дневные продажи SKU
  async loadDailySales(sku, days = 14) {
    const qs = new URLSearchParams({
      sku: String(sku || "").trim(),
      days: String(days),
    });
    return await requestJson(`/api/funnel/daily-sales?${qs.toString()}`);
    // { ok, points: [{date, orders, returns?}, ...] }
  },

  // ✅ График: остатки по дням (fact snapshots + estimated backfill)
  async loadStockHistory(sku, days = 30, estimate = true) {
    const qs = new URLSearchParams({
      sku: String(sku || "").trim(),
      days: String(days),
      estimate: estimate ? "1" : "0",
    });
    return await requestJson(`/api/stock-history?${qs.toString()}`);
    // { ok, points: [{date, ozon_stock, source}, ...] }
  },

  // Прогрузчик: запуск
  async runLoader() {
    return await requestJson(`/api/loader/run`, {
      method: "POST",
    });
    // { ok, items, updated, fileName, fileUrl, config, ... }
  },

  // Конфиг прогрузчика (GET)
  async loadLoaderConfig() {
    return await requestJson(`/api/loader/config`);
    // { ok, config }
  },

  // Конфиг прогрузчика (POST)
  async saveLoaderConfig(cfg) {
    return await requestJson(`/api/loader/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg || {}),
    });
    // { ok, config }
  },

  // Статус папки cut (для кнопки "Открыть папку...")
  async loadCutStatus() {
    return await requestJson(`/api/loader/cut-status`);
    // { ok, hasFile, files }
  },

  // Открыть папку cut
  async openCutFolder() {
    return await requestJson(`/api/loader/open-cut-folder`, {
      method: "POST",
    });
    // { ok }
  },

  // Disabled SKU map (GET)
  async loadDisabledSkus() {
    return await requestJson(`/api/loader/disabled`);
    // { ok, disabled: { [sku]: true } }
  },

  // Disabled SKU map (POST)
  async setSkuDisabled(sku, disabled) {
    return await requestJson(`/api/loader/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku, disabled: !!disabled }),
    });
    // { ok, disabled }
  },
};

window.DataService = DataService;
