/**
 * THE ONE SUN — sun position/character derived from time-of-day, in one place.
 *
 * V2 computed sun-from-time in AT LEAST EIGHT places (the shadow system's own
 * `SunDirection.js`, `time.js`, `ThreeLightSource`, inline effect math…), and
 * fifteen files held sun state — so shadows could point one way while specular
 * glints answered to a different sky, BY CONSTRUCTION (docs/planning/Environment.md
 * §0.2). Worse, the roof-drip system never derived its screen→world mapping at
 * all and VOTED between four candidates at runtime — the feature that "never
 * reliably worked" (memory: feedback_probed_constants_vs_derived).
 *
 * The rule this module embodies: **a constant is DERIVED once and asserted in a
 * Node test — never probed, never re-derived per consumer.** The `env/one-sun`
 * tripwire fails the build if sun terms appear anywhere else.
 *
 * THE MODEL — cinematic plausibility over physical simulation (V2's own
 * WeatherController doctrine line, kept on purpose). This is stage lighting for
 * a top-down map, not an ephemeris:
 *
 *   elevation(h) = maxElevation · cos(2π · (h − 12) / 24)
 *     → noon: max. midnight: −max. 06:00 and 18:00: exactly 0 (the horizon).
 *   azimuth(h) = noonAzimuth + (h − 12) · 15°/hour
 *     → the real Earth rate; 06:00 = east (90°), noon = south (180°), 18:00 = west (270°).
 *
 * Continuous everywhere (no branch at sunrise to pop a shadow direction), and
 * lining up with the ToD anchor hours (0/6/12/18) the author already tunes by.
 *
 * @module world/sun
 */

/** @typedef {{maxElevationDeg?: number, noonAzimuthDeg?: number}} SunConfig */

export const DEFAULT_SUN_CONFIG = Object.freeze({
  /** Peak elevation at noon. 60° reads as "high sun" without top-down shadows vanishing. */
  maxElevationDeg: 60,
  /** Noon azimuth. 180° = south — northern-hemisphere stage convention. */
  noonAzimuthDeg: 180,
});

/**
 * Where and what the sun is at `todHour`. Pure; returns a frozen value.
 *
 * @param {number} todHour - 0..24 (any finite number is normalised into range).
 * @param {SunConfig} [config]
 * @returns {Readonly<{
 *   todHour: number,
 *   elevationDeg: number,
 *   azimuthDeg: number,
 *   aboveHorizon: boolean,
 *   dayFactor01: number,
 *   twilight01: number,
 * }>}
 */
export function computeSun(todHour, config = DEFAULT_SUN_CONFIG) {
  const cfg = { ...DEFAULT_SUN_CONFIG, ...config };
  const h = normalizeHour(todHour);

  const elevationDeg = cfg.maxElevationDeg * Math.cos((2 * Math.PI * (h - 12)) / 24);
  const azimuthDeg = wrapDeg(cfg.noonAzimuthDeg + (h - 12) * 15);

  // How "day" it is, 0..1 — eased across civil twilight (−6°) to clear sun
  // (+10°), so lighting fades in rather than snapping at the horizon. This is
  // the value the grade stack and sky ambient key from.
  const dayFactor01 = smoothstep01((elevationDeg + 6) / 16);

  // How "golden hour" it is, 0..1 — peaks when the sun sits ON the horizon and
  // fades within ±12°. Warmth/long-shadow looks key from this, day or dusk.
  const twilight01 = clamp01(1 - Math.abs(elevationDeg) / 12);

  return Object.freeze({
    todHour: h,
    elevationDeg,
    azimuthDeg,
    aboveHorizon: elevationDeg > 0,
    dayFactor01,
    twilight01,
  });
}

/** @param {number} hour @returns {number} 0..24, tolerant of any finite input */
export function normalizeHour(hour) {
  const n = Number(hour);
  if (!Number.isFinite(n)) return 12; // a broken input reads as noon, LOUDLY neutral — never NaN downstream
  return ((n % 24) + 24) % 24;
}

/** @param {number} deg @returns {number} 0..360 */
function wrapDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** @param {number} x @returns {number} */
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

/** Hermite smoothstep on a pre-scaled 0..1 input. */
function smoothstep01(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
