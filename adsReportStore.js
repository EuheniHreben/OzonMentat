// adsReportStore.js
// Хранилище UUID отчётов Performance API

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "adsReportsQueue.json");
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 часов

function loadStore() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveStore(store) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2), "utf8");
  } catch {}
}

function addReport(uuid, meta = {}) {
  if (!uuid) return;
  const store = loadStore();
  store[uuid] = {
    createdAt: Date.now(),
    ...meta,
  };
  saveStore(store);
}

function removeReport(uuid) {
  const store = loadStore();
  delete store[uuid];
  saveStore(store);
}

function getPendingReports() {
  const store = loadStore();
  const now = Date.now();

  return Object.entries(store)
    .filter(([, v]) => now - v.createdAt < MAX_AGE_MS)
    .map(([uuid, meta]) => ({ uuid, meta }));
}

module.exports = {
  addReport,
  removeReport,
  getPendingReports,
};
