// dataService.js
// Тонкий слой общения с бекендом. Ничего не нормализует, просто возвращает JSON.

const DataService = {
  // Воронка
  async loadFunnel(days = 7) {
    const res = await fetch(`/api/funnel?days=${days}`);
    // сервер ВСЕГДА возвращает JSON вида { ok, rows, ... }
    return await res.json();
  },

  // Прогрузчик: запуск
  async runLoader() {
    const res = await fetch(`/api/loader/run`, {
      method: "POST",
    });
    return await res.json(); // { ok, items, updated, fileName, config }
  },

  // Конфиг прогрузчика (GET)
  async loadLoaderConfig() {
    const res = await fetch(`/api/loader/config`);
    return await res.json(); // { ok, config }
  },

  // Конфиг прогрузчика (POST)
  async saveLoaderConfig(cfg) {
    const res = await fetch(`/api/loader/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    return await res.json(); // { ok, config }
  },
};

window.DataService = DataService;
