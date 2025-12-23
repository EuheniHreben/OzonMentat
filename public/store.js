// store.js
// Единое хранилище данных по SKU на фронтенде

const Store = {
  // ===== multi-store context =====
  activeStoreId: "palantir-ru",

  setActiveStore(storeId) {
    const id = String(storeId || "").trim();
    if (!id) return;
    this.activeStoreId = id;
  },

  getActiveStore() {
    return this.activeStoreId;
  },

  // ключ — offer_id, значение — объект SKU
  skusByOffer: {},
  // дублируем индекс по sku (числовой id озона)
  skusBySku: {},

  // runtime-конфиги (загружаются с бэка)
  loaderConfig: null,
  funnelConfig: null,

  clear() {
    this.skusByOffer = {};
    this.skusBySku = {};
    this.loaderConfig = null;
    this.funnelConfig = null;
  },

  // Универсальный upsert с защитой от “старых” перезаписей
  _upsertRow(targetKey, row, ts, sectionName) {
    if (!row) return;
    const offerId = row.offer_id;
    if (!offerId) return;

    let skuEntry = this.skusByOffer[offerId];
    if (!skuEntry) skuEntry = { offer_id: offerId };

    if (row.sku != null) skuEntry.sku = row.sku;
    if (row.name != null) skuEntry.name = row.name;

    const prev = skuEntry[sectionName];
    const prevTs = prev?._updatedAt ?? 0;

    // если пришёл более старый апдейт — игнорим
    if (prevTs && ts < prevTs) return;

    skuEntry[sectionName] = {
      ...row,
      _updatedAt: ts,
      _storeId: this.activeStoreId,
    };

    this.skusByOffer[offerId] = skuEntry;

    if (row.sku != null) {
      this.skusBySku[String(row.sku)] = skuEntry;
    }
  },

  /**
   * Применяем данные воронки.
   * rows — то, что приходит с /api/funnel: [{ sku, offer_id, name, ... }]
   */
  applyFunnel(rows, options = {}) {
    const ts = options.timestamp ?? Date.now();
    if (!Array.isArray(rows)) return;

    rows.forEach((row) => this._upsertRow("offer_id", row, ts, "funnel"));
  },

  /**
   * Применяем данные прогрузчика.
   * rows — json.items из /api/loader/run: [{ sku, offer_id, disabled, included, ... }]
   */
  applyLoader(rows, options = {}) {
    const ts = options.timestamp ?? Date.now();
    if (!Array.isArray(rows)) return;

    rows.forEach((row) => this._upsertRow("offer_id", row, ts, "loader"));
  },

  // удобный батч-метод (если когда-нибудь вернёшь combined response)
  applyAll(payload, options = {}) {
    if (!payload) return;
    if (Array.isArray(payload.funnelRows))
      this.applyFunnel(payload.funnelRows, options);
    if (Array.isArray(payload.loaderRows))
      this.applyLoader(payload.loaderRows, options);
  },

  getByOfferId(offerId) {
    if (!offerId) return null;
    return this.skusByOffer[offerId] || null;
  },

  getBySku(sku) {
    if (sku == null) return null;
    return this.skusBySku[String(sku)] || null;
  },

  getAll() {
    return Object.values(this.skusByOffer);
  },

  getWithFunnel() {
    return this.getAll().filter((sku) => !!sku.funnel);
  },

  getWithLoader() {
    return this.getAll().filter((sku) => !!sku.loader);
  },

  // -------- runtime-конфиги --------

  setLoaderConfig(cfg) {
    this.loaderConfig = cfg ? { ...cfg } : null;
  },

  getLoaderConfig() {
    return this.loaderConfig;
  },

  setFunnelConfig(cfg) {
    this.funnelConfig = cfg ? { ...cfg } : null;
  },

  getFunnelConfig() {
    return this.funnelConfig;
  },
};

window.Store = Store;
