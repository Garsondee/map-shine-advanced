/**
 * @fileoverview Shared environment override field definitions for Map Shine Control
 * and Camera Path environment ramps.
 *
 * @module ui/environment-override-specs
 */

/** @typedef {'weather'|'fog'|'lightning'|'time'} EnvironmentFieldBackend */

/**
 * @typedef {Object} EnvironmentOverrideSpec
 * @property {string} id
 * @property {string} label
 * @property {number} min
 * @property {number} max
 * @property {number} step
 * @property {EnvironmentFieldBackend} backend
 * @property {boolean} [angular] Shortest-arc interpolation (time, wind direction)
 */

/** @type {ReadonlyArray<EnvironmentOverrideSpec>} */
export const ENVIRONMENT_OVERRIDE_SPECS = Object.freeze([
  { id: 'timeOfDay', label: 'Time', min: 0, max: 24, step: 0.05, backend: 'time', angular: true },
  { id: 'manualFogDensity', label: 'Fog', min: 0, max: 1, step: 0.01, backend: 'fog' },
  { id: 'precipitation', label: 'Rain', min: 0, max: 1, step: 0.01, backend: 'weather' },
  { id: 'cloudCover', label: 'Clouds', min: 0, max: 1, step: 0.01, backend: 'weather' },
  { id: 'freezeLevel', label: 'Temp (Freeze)', min: 0, max: 1, step: 0.01, backend: 'weather' },
  { id: 'lightning', label: 'Lightning', min: 0, max: 1, step: 0.01, backend: 'lightning' },
  { id: 'windSpeed', label: 'Wind', min: 0, max: 1, step: 0.01, backend: 'weather' },
  { id: 'windDirection', label: 'Wind Dir', min: 0, max: 359, step: 1, backend: 'weather', angular: true },
]);

/** Live weather panel subset (excludes time — owned by Time Director). */
export const LIVE_WEATHER_PANEL_SPECS = ENVIRONMENT_OVERRIDE_SPECS.filter((s) => s.backend !== 'time');

/** @type {ReadonlySet<string>} */
export const WEATHER_SNAPSHOT_FIELD_IDS = new Set(
  ENVIRONMENT_OVERRIDE_SPECS.filter((s) => s.backend === 'weather').map((s) => s.id),
);

/**
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * @param {string} id
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function clampEnvironmentValue(id, value, fallback = 0) {
  const spec = ENVIRONMENT_OVERRIDE_SPECS.find((s) => s.id === id);
  if (!spec) return fallback;

  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;

  if (id === 'windDirection') {
    return ((n % 360) + 360) % 360;
  }
  if (id === 'timeOfDay') {
    return ((n % 24) + 24) % 24;
  }
  if (spec.max <= 1 && spec.min >= 0) {
    return clamp01(n, fallback);
  }
  return Math.max(spec.min, Math.min(spec.max, n));
}

/**
 * Shortest-arc interpolation on a circular range.
 *
 * @param {number} start
 * @param {number} end
 * @param {number} period
 * @param {number} t
 * @returns {number}
 */
export function lerpCircular(start, end, period, t) {
  const a = Number(start);
  const b = Number(end);
  const p = Math.max(1e-6, Number(period) || 24);
  const tt = Math.max(0, Math.min(1, Number(t) || 0));

  let delta = b - a;
  if (delta > p / 2) delta -= p;
  if (delta < -p / 2) delta += p;

  return ((a + delta * tt) % p + p) % p;
}

/**
 * @param {string} id
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerpEnvironmentField(id, a, b, t) {
  const spec = ENVIRONMENT_OVERRIDE_SPECS.find((s) => s.id === id);
  if (!spec) return a;

  if (spec.angular) {
    const period = id === 'windDirection' ? 360 : 24;
    return lerpCircular(a, b, period, t);
  }

  const start = clampEnvironmentValue(id, a, spec.min);
  const end = clampEnvironmentValue(id, b, spec.min);
  const tt = Math.max(0, Math.min(1, Number(t) || 0));
  return start + (end - start) * tt;
}

/**
 * @returns {import('./environment-control-api.js').EnvironmentSnapshot}
 */
export function createDefaultEnvironmentSnapshot() {
  return {
    timeOfDay: 12,
    manualFogDensity: 0,
    lightning: 0,
    weather: {
      precipitation: 0,
      cloudCover: 0,
      freezeLevel: 0,
      windSpeed: 0,
      windDirection: 0,
    },
  };
}

/**
 * @param {unknown} raw
 * @returns {import('./environment-control-api.js').EnvironmentSnapshot}
 */
export function normalizeEnvironmentSnapshot(raw) {
  const base = createDefaultEnvironmentSnapshot();
  if (!raw || typeof raw !== 'object') return base;

  const src = /** @type {Record<string, unknown>} */ (raw);
  const weatherSrc = src.weather && typeof src.weather === 'object'
    ? /** @type {Record<string, unknown>} */ (src.weather)
    : src;

  return {
    timeOfDay: clampEnvironmentValue('timeOfDay', src.timeOfDay, base.timeOfDay),
    manualFogDensity: clampEnvironmentValue('manualFogDensity', src.manualFogDensity, 0),
    lightning: clampEnvironmentValue('lightning', src.lightning, 0),
    weather: {
      precipitation: clampEnvironmentValue('precipitation', weatherSrc.precipitation, 0),
      cloudCover: clampEnvironmentValue('cloudCover', weatherSrc.cloudCover, 0),
      freezeLevel: clampEnvironmentValue('freezeLevel', weatherSrc.freezeLevel, 0),
      windSpeed: clampEnvironmentValue('windSpeed', weatherSrc.windSpeed, 0),
      windDirection: clampEnvironmentValue('windDirection', weatherSrc.windDirection, 0),
    },
  };
}

/**
 * @param {number} [value=1]
 * @returns {number}
 */
export function clampEnvironmentTimeScale(value = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.1, Math.min(3, n));
}

/**
 * @param {import('./environment-control-api.js').EnvironmentSnapshot} start
 * @param {import('./environment-control-api.js').EnvironmentSnapshot} end
 * @param {number} t
 * @returns {import('./environment-control-api.js').EnvironmentSnapshot}
 */
export function lerpEnvironmentSnapshots(start, end, t) {
  const a = normalizeEnvironmentSnapshot(start);
  const b = normalizeEnvironmentSnapshot(end);
  const tt = Math.max(0, Math.min(1, Number(t) || 0));

  return {
    timeOfDay: lerpEnvironmentField('timeOfDay', a.timeOfDay, b.timeOfDay, tt),
    manualFogDensity: lerpEnvironmentField('manualFogDensity', a.manualFogDensity, b.manualFogDensity, tt),
    lightning: lerpEnvironmentField('lightning', a.lightning, b.lightning, tt),
    weather: {
      precipitation: lerpEnvironmentField('precipitation', a.weather.precipitation, b.weather.precipitation, tt),
      cloudCover: lerpEnvironmentField('cloudCover', a.weather.cloudCover, b.weather.cloudCover, tt),
      freezeLevel: lerpEnvironmentField('freezeLevel', a.weather.freezeLevel, b.weather.freezeLevel, tt),
      windSpeed: lerpEnvironmentField('windSpeed', a.weather.windSpeed, b.weather.windSpeed, tt),
      windDirection: lerpEnvironmentField('windDirection', a.weather.windDirection, b.weather.windDirection, tt),
    },
  };
}
