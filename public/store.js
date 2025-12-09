// store.js
// Единое хранилище данных по SKU на фронтенде

const Store = {
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

  /**
   * Применяем данные воронки.
   * rows — то, что приходит с /api/funnel: [{ sku, offer_id, name, ... }]
   */
  applyFunnel(rows, options = {}) {
    const ts = options.timestamp ?? Date.now();
    if (!Array.isArray(rows)) return;

    rows.forEach((row) => {
      if (!row) return;
      const offerId = row.offer_id;
      if (!offerId) return;

      let skuEntry = this.skusByOffer[offerId];
      if (!skuEntry) {
        skuEntry = { offer_id: offerId };
      }

      if (row.sku != null) skuEntry.sku = row.sku;
      if (row.name != null) skuEntry.name = row.name;

      skuEntry.funnel = {
        ...row,
        _updatedAt: ts,
      };

      this.skusByOffer[offerId] = skuEntry;

      if (row.sku != null) {
        this.skusBySku[String(row.sku)] = skuEntry;
      }
    });
  },

  /**
   * Применяем данные прогрузчика.
   * rows — json.items из /api/loader/run: [{ sku, offer_id, disabled, included, ... }]
   */
  applyLoader(rows, options = {}) {
    const ts = options.timestamp ?? Date.now();
    if (!Array.isArray(rows)) return;

    rows.forEach((row) => {
      if (!row) return;
      const offerId = row.offer_id;
      if (!offerId) return;

      let skuEntry = this.skusByOffer[offerId];
      if (!skuEntry) {
        skuEntry = { offer_id: offerId };
      }

      if (row.sku != null) skuEntry.sku = row.sku;
      if (row.name != null) skuEntry.name = row.name;

      skuEntry.loader = {
        ...row,
        _updatedAt: ts,
      };

      this.skusByOffer[offerId] = skuEntry;

      if (row.sku != null) {
        this.skusBySku[String(row.sku)] = skuEntry;
      }
    });
  },

  getByOfferId(offerId) {
    if (!offerId) return null;
    return this.skusByOffer[offerId] || null;
  },

  getBySku(sku) {
    if (sku == null) return null;
    const key = String(sku);
    return this.skusBySku[key] || null;
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
