/**
 * @fileoverview LightEnhancementStore
 * Stores MapShine enhancement data keyed by Foundry AmbientLight id.
 *
 * Enhancements are stored as scene flags so Foundry lights remain the
 * primary source of truth while MapShine adds optional features.
 */

const MODULE_ID = 'map-shine-advanced';
const FLAG_KEY = 'lightEnhancements';
const CURRENT_VERSION = 1;

const DEFAULT_COOKIE_TEXTURE = `modules/${MODULE_ID}/assets/kenney assets/light_01.png`;
const DEFAULT_COOKIE_STRENGTH = 1.0;
const DEFAULT_COOKIE_CONTRAST = 1.0;
const DEFAULT_COOKIE_GAMMA = 1.0;
const DEFAULT_COOKIE_TINT = '#ffffff';

const DEFAULT_OUTPUT_GAIN = 1.0;
const DEFAULT_OUTER_WEIGHT = 0.5;
const DEFAULT_INNER_WEIGHT = 0.5;

function _isObject(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function _normalizeContainer(raw) {
  if (Array.isArray(raw)) return { version: CURRENT_VERSION, lights: raw };
  if (_isObject(raw)) {
    const version = Number.isFinite(raw.version) ? raw.version : CURRENT_VERSION;
    const lights = Array.isArray(raw.lights)
      ? raw.lights
      : (Array.isArray(raw.items) ? raw.items : []);
    return { version, lights };
  }
  return { version: CURRENT_VERSION, lights: [] };
}

function _normalizeConfig(cfg) {
  if (!_isObject(cfg)) return {};

  const out = { ...cfg };

  // Cookie/gobo defaults.
  if (out.cookieEnabled === true && (!out.cookieTexture || typeof out.cookieTexture !== 'string')) {
    out.cookieTexture = DEFAULT_COOKIE_TEXTURE;
  }
  if (typeof out.cookieTexture === 'string' && !out.cookieTexture) {
    delete out.cookieTexture;
  }
  if (out.cookieStrength !== undefined && !Number.isFinite(out.cookieStrength)) {
    out.cookieStrength = DEFAULT_COOKIE_STRENGTH;
  }
  if (out.cookieContrast !== undefined && !Number.isFinite(out.cookieContrast)) {
    out.cookieContrast = DEFAULT_COOKIE_CONTRAST;
  }
  if (out.cookieGamma !== undefined && !Number.isFinite(out.cookieGamma)) {
    out.cookieGamma = DEFAULT_COOKIE_GAMMA;
  }
  if (out.cookieTint !== undefined && typeof out.cookieTint !== 'string') {
    out.cookieTint = DEFAULT_COOKIE_TINT;
  }

  // Output shaping defaults.
  if (out.outputGain !== undefined && !Number.isFinite(out.outputGain)) {
    out.outputGain = DEFAULT_OUTPUT_GAIN;
  }
  if (out.outerWeight !== undefined && !Number.isFinite(out.outerWeight)) {
    out.outerWeight = DEFAULT_OUTER_WEIGHT;
  }
  if (out.innerWeight !== undefined && !Number.isFinite(out.innerWeight)) {
    out.innerWeight = DEFAULT_INNER_WEIGHT;
  }

  return out;
}

export class LightEnhancementStore {
  constructor() {
    /** @type {Map<string, {id:string, config:Object}>} */
    this._cache = new Map();
    this._version = 0;
  }

  get flagKey() {
    return FLAG_KEY;
  }

  get version() {
    return this._version;
  }

  /**
   * Load enhancements from the scene and refresh the cache.
   * @param {Scene} [scene]
   */
  async load(scene = canvas?.scene) {
    if (!scene) return [];

    let raw;
    try {
      raw = scene.getFlag(MODULE_ID, FLAG_KEY);
    } catch (_) {
      raw = scene?.flags?.[MODULE_ID]?.[FLAG_KEY];
    }

    const container = _normalizeContainer(raw);
    const list = Array.isArray(container.lights) ? container.lights : [];
    this._cache.clear();

    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.id ?? '');
      if (!id) continue;

      const config = _normalizeConfig(entry.config ?? entry);
      this._cache.set(id, { id, config });
    }

    this._version++;
    return Array.from(this._cache.values());
  }

  /**
   * Get enhancement data from the in-memory cache.
   * @param {string} id
   */
  getCached(id) {
    if (!id) return null;
    return this._cache.get(String(id)) || null;
  }

  /**
   * @param {string} id
   */
  async get(id) {
    const cached = this.getCached(id);
    if (cached) return cached;

    await this.load();
    return this.getCached(id);
  }

  async list() {
    await this.load();
    return Array.from(this._cache.values());
  }

  /**
   * Upsert enhancement data for a Foundry light id.
   * @param {string} id
   * @param {Object} changes
   */
  async upsert(id, changes = {}) {
    if (!id) return null;
    const scene = canvas?.scene;
    if (!scene) return null;

    await this.load(scene);

    const key = String(id);
    const cur = this._cache.get(key) || { id: key, config: {} };
    const nextConfig = _normalizeConfig({ ...cur.config, ...(changes.config ?? changes) });
    const next = { id: key, config: nextConfig };

    const list = Array.from(this._cache.values()).filter((e) => e.id !== key);
    list.push(next);

    await scene.setFlag(MODULE_ID, FLAG_KEY, { version: CURRENT_VERSION, lights: list });
    this._cache.set(key, next);
    this._version++;
    return next;
  }

  /**
   * Remove enhancement data for a Foundry light id.
   * @param {string} id
   */
  async remove(id) {
    if (!id) return false;
    const scene = canvas?.scene;
    if (!scene) return false;

    await this.load(scene);

    const key = String(id);
    const list = Array.from(this._cache.values()).filter((e) => e.id !== key);
    await scene.setFlag(MODULE_ID, FLAG_KEY, { version: CURRENT_VERSION, lights: list });

    this._cache.delete(key);
    this._version++;
    return true;
  }
}
