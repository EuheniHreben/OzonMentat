// src/server/services/adsReportStore.js
// Хранилище UUID отчётов Performance API

const fs = require("fs");
const path = require("path");

// ✅ FIX: файл хранилища рядом с модулем, а не “где запустили node”
const FILE = path.join(__dirname, "adsReportsQueue.json");

// 6 часов
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function loadStore() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store) {
  try {
    // ✅ гарантируем директорию
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store || {}, null, 2), "utf8");
  } catch {}
}

function addReport(uuid, meta = {}) {
  const id = String(uuid || "").trim();
  if (!id) return;

  const store = loadStore();
  store[id] = {
    createdAt: Date.now(),
    ...meta,
  };
  saveStore(store);
}

function removeReport(uuid) {
  const id = String(uuid || "").trim();
  if (!id) return;

  const store = loadStore();
  if (store && Object.prototype.hasOwnProperty.call(store, id)) {
    delete store[id];
    saveStore(store);
  }
}

// ✅ автоматически “подметаем” протухшие записи
function purgeExpired(store) {
  const now = Date.now();
  let changed = false;

  for (const [uuid, meta] of Object.entries(store || {})) {
    const createdAt = Number(meta?.createdAt || 0);
    if (!createdAt || now - createdAt >= MAX_AGE_MS) {
      delete store[uuid];
      changed = true;
    }
  }

  if (changed) saveStore(store);
  return store;
}

function getPendingReports() {
  const store = purgeExpired(loadStore());
  return Object.entries(store).map(([uuid, meta]) => ({ uuid, meta }));
}

// иногда отчёт может зависнуть; это “жёсткая метла”
function clearAll() {
  saveStore({});
}

module.exports = {
  addReport,
  removeReport,
  getPendingReports,
  clearAll,
};
