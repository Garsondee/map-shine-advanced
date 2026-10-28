/**
 * WINDOW COLOUR — the "CC" section at the end of the Window card (author,
 * 2026-10-27: *"give me a new CC section at the end which is designed to let me
 * fine tune the visual appearance of the whole window effect"*).
 *
 * ⚠️ NOT A SECOND GRADE ENGINE. This project has exactly one grade primitive —
 * `effects/grade/grade-ops.js#buildGradeNode` (`grade/one-stack`, Grade.md) —
 * and every "CC" is that function fed different data. This file only adapts the
 * Window card's seven dials onto it (the colour filter is the grade's `gain`,
 * gamma its per-channel `gamma`, lift is pinned at 0) and owns the uniforms the
 * window material feeds it.
 *
 * It grades the FINISHED window light — after the glass, the shoulder, the
 * daylight tint and the weather — so it is the last word on how the effect
 * looks. Because window light ADDS onto the scene's illumination, lift stays at
 * 0 (a lift on additive light paints a wash over the whole quad) and the result
 * is clamped at 0 and faded in by the light's own presence (contrast about the
 * pivot must never subtract light, nor lift an unlit fragment into a glow).
 *
 * @module effects/window/window-grade
 */

import { buildGradeNode } from '../grade/grade-ops.js';

/** The CC dials' identity values (mirrored by `window.js#WINDOW_PARAMS.cc*`). */
export const WINDOW_COLOR_DEFAULTS = Object.freeze({
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  filter: Object.freeze([1, 1, 1]),
  gamma: 1,
});

const num = (v, d, lo = -Infinity) => (Number.isFinite(v) ? Math.max(lo, v) : d);

/**
 * The card's dials as the grade primitive's params. Pure; anything malformed
 * falls back to the identity.
 * @param {{exposure?:number, contrast?:number, saturation?:number, temperature?:number,
 *   tint?:number, filter?:number[], gamma?:number}} d
 */
export function windowColorParams(d = {}) {
  const D = WINDOW_COLOR_DEFAULTS;
  const filter =
    Array.isArray(d.filter) && d.filter.length === 3 && d.filter.every(Number.isFinite) ? d.filter : D.filter;
  const gamma = num(d.gamma, D.gamma, 0.05);
  return {
    exposure: num(d.exposure, D.exposure),
    contrast: num(d.contrast, D.contrast, 0),
    saturation: num(d.saturation, D.saturation, 0),
    temperature: num(d.temperature, D.temperature),
    tint: num(d.tint, D.tint),
    gain: filter.map((c) => Math.max(0, c)),
    gamma: [gamma, gamma, gamma],
  };
}

/**
 * The uniform set `buildGradeNode` reads, at identity.
 * @param {*} TSL
 */
export function createWindowColorUniforms(TSL) {
  const { uniform, float, vec3 } = TSL;
  return {
    exposure: uniform(float(0)),
    contrast: uniform(float(1)),
    saturation: uniform(float(1)),
    vibrance: uniform(float(0)),
    temperature: uniform(float(0)),
    tint: uniform(float(0)),
    lift: uniform(vec3(0, 0, 0)),
    gamma: uniform(vec3(1, 1, 1)),
    gain: uniform(vec3(1, 1, 1)),
  };
}

/** Push dials into the uniforms. @param {object} u @param {object} d */
export function pushWindowColor(u, d) {
  const p = windowColorParams(d);
  u.exposure.value = p.exposure;
  u.contrast.value = p.contrast;
  u.saturation.value = p.saturation;
  u.temperature.value = p.temperature;
  u.tint.value = p.tint;
  u.gain.value.set(...p.gain);
  u.gamma.value.set(...p.gamma);
}

/**
 * The window light through the one grade primitive, clamped non-negative.
 * @param {*} TSL @param {*} light - vec3 node. @param {object} u - {@link createWindowColorUniforms}.
 */
export function applyWindowColor(TSL, light, u) {
  const { max, min, vec3, float, dot } = TSL;
  const graded = max(buildGradeNode(TSL, light, u), vec3(0, 0, 0));
  // ⚠️ The primitive's contrast pivots on 0.18, so contrast < 1 would RAISE a
  // zero (unlit) fragment toward the pivot — a glow over the whole unpainted
  // quad. Additive light must stay exactly 0 where there is none, so the grade
  // is faded in by the light's own presence (full above a dim 0.01).
  const presence = min(dot(light, vec3(0.2126, 0.7152, 0.0722)).div(float(0.01)), float(1));
  return graded.mul(max(presence, float(0)));
}
