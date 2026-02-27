/**
 * @fileoverview Circuit breaker registry for disabling effects at runtime.
 *
 * Purpose: provide a single, centralized place to disable effects BEFORE they are
 * instantiated/initialized. This is intended as a crisis-debugging tool to
 * isolate scene-load freezes or GPU driver hangs.
 *
 * Persistence: client-local via localStorage.
 *
 * @module core/circuit-breaker
 */

import { createLogger } from './log.js';

const log = createLogger('CircuitBreaker');

const STORAGE_KEY = 'msa-circuit-breaker';

/**
 * @typedef {{
 *   version: number,
 *   disabled: Record<string, boolean>
 * }} CircuitBreakerState
 */

function _safeParse(jsonText) {
  try {
    if (!jsonText || typeof jsonText !== 'string') return null;
    return JSON.parse(jsonText);
  } catch (_) {
    return null;
  }
}

function _defaultState() {
  /** @type {CircuitBreakerState} */
  return {
    version: 1,
    disabled: {},
  };
}

function _readState() {
  try {
    const raw = globalThis.localStorage?.getItem?.(STORAGE_KEY) ?? null;
    const parsed = _safeParse(raw);
    if (!parsed || typeof parsed !== 'object') return _defaultState();
    const disabled = (parsed.disabled && typeof parsed.disabled === 'object') ? parsed.disabled : {};
    return {
      version: Number.isFinite(parsed.version) ? parsed.version : 1,
      disabled: { ...disabled },
    };
  } catch (_) {
    return _defaultState();
  }
}

function _writeState(state) {
  try {
    globalThis.localStorage?.setItem?.(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    log.warn('Failed to persist circuit breaker state:', e);
  }
}

export class CircuitBreaker {
  constructor() {
    /** @type {CircuitBreakerState} */
    this._state = _readState();
  }

  /**
   * @returns {CircuitBreakerState}
   */
  getState() {
    return {
      version: this._state.version,
      disabled: { ...this._state.disabled },
    };
  }

  /**
   * @param {string} effectId
   * @returns {boolean}
   */
  isDisabled(effectId) {
    try {
      const id = String(effectId || '').trim();
      if (!id) return false;
      return this._state.disabled[id] === true;
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {string} effectId
   * @param {boolean} disabled
   */
  setDisabled(effectId, disabled) {
    const id = String(effectId || '').trim();
    if (!id) return;
    if (disabled) this._state.disabled[id] = true;
    else delete this._state.disabled[id];
    _writeState(this._state);
  }

  /**
   * @param {string} effectId
   */
  clear(effectId) {
    this.setDisabled(effectId, false);
  }

  clearAll() {
    this._state = _defaultState();
    _writeState(this._state);
  }

  /**
   * @param {Array<{id:string,label:string,description?:string}>} defs
   */
  ensureKnown(defs) {
    try {
      for (const d of (defs || [])) {
        const id = String(d?.id || '').trim();
        if (!id) continue;
        // No-op: this exists so UI can call it and we can later migrate/version.
        // We intentionally do not auto-add keys, because absence => enabled.
      }
    } catch (_) {
    }
  }
}

/** @type {CircuitBreaker|null} */
let _singleton = null;

export function getCircuitBreaker() {
  if (!_singleton) _singleton = new CircuitBreaker();
  return _singleton;
}

export const CIRCUIT_BREAKER_EFFECTS = Object.freeze([
  { id: 'v2.specular', label: 'V2 Specular', description: 'Specular overlay shader + mask probing.' },
  { id: 'v2.fire', label: 'V2 Fire', description: 'Fire particle systems from _Fire masks.' },
  { id: 'v2.windows', label: 'V2 Windows', description: 'Window light overlays from _Windows masks.' },
  { id: 'v2.clouds', label: 'V2 Clouds', description: 'Cloud shadows and cloud tops.' },
  { id: 'v2.weatherParticles', label: 'V2 Weather Particles', description: 'Rain/snow/ash particles.' },
  { id: 'v2.water', label: 'V2 Water', description: 'Water post-processing (waves/specular/foam).' },
  { id: 'v2.waterSplashes', label: 'V2 Water Splashes', description: 'Water splashes + bubbles particle layers.' },
  { id: 'v2.outdoorsMask', label: 'V2 Outdoors Mask', description: 'Outdoors mask discovery/compositing provider.' },
  { id: 'v2.buildingShadows', label: 'V2 Building Shadows', description: 'Baked building shadow factor texture.' },
  { id: 'v2.lighting', label: 'V2 Lighting', description: 'Lighting post-process and light accumulation.' },
  { id: 'v2.skyColor', label: 'V2 Sky Color', description: 'Sky color grading pass.' },
  { id: 'v2.colorCorrection', label: 'V2 Color Correction', description: 'Global grade controls.' },
  { id: 'v2.filter', label: 'V2 Filter', description: 'Stylized filter pass.' },
  { id: 'v2.bloom', label: 'V2 Bloom', description: 'Bloom post effect.' },
  { id: 'v2.filmGrain', label: 'V2 Film Grain', description: 'Film grain overlay.' },
  { id: 'v2.sharpen', label: 'V2 Sharpen', description: 'Sharpen pass.' },
]);
