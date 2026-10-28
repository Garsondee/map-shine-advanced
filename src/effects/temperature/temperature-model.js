/**
 * TEMPERATURE EFFECTS' MATHS — the bands, the grade delta, the frost's growth
 * and the ripple, from the resolved card params (`temperature.js` declares
 * them; the split is the same one `window/window.js` + `window-grade.js` use,
 * and what lets `params/no-dead-controls` see every param has a reader).
 *
 * Pure. No THREE — Node-tested.
 *
 * @module effects/temperature/temperature-model
 */

import { TEMPERATURE_EFFECTS_PARAMS } from './temperature.js';

const DEF = Object.fromEntries(Object.entries(TEMPERATURE_EFFECTS_PARAMS).map(([k, d]) => [k, d.default]));

/** A resolved value, or the schema default when missing/malformed. */
function num(params, key) {
  const v = Number(params?.[key]);
  return Number.isFinite(v) ? v : DEF[key];
}

/** @param {number} x @returns {number} */
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * A smoothstepped ramp from `from` (0) to `to` (1), either direction — so a
 * cold ramp (from 0.25 down to 0) and a warm one (0.75 up to 1) share one
 * shape. A degenerate band is a hard step at `from`.
 * @param {number} x @param {number} from @param {number} to @returns {number}
 */
export function temperatureRamp(x, from, to) {
  if (Math.abs(to - from) < 1e-6) return (to < from ? x <= from : x >= from) ? 1 : 0;
  const t = clamp01((x - from) / (to - from));
  return t * t * (3 - 2 * t);
}

/**
 * Parse a colour param: '#rrggbb' (how the cascade stores a `color`) or an
 * already-split `[r, g, b]` 0..1 triple.
 * @param {*} v @param {number[]} fallback @returns {number[]}
 */
export function temperatureColor(v, fallback) {
  if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) return [v[0], v[1], v[2]];
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v ?? ''));
  if (!m) return [...fallback];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * How cold, warm, frosty and hot a temperature is, per the card's bands.
 * `cold01`/`warm01` include their strength (so up to 2); `frostTarget01` and
 * `heat01` are 0..1 and 0 when their layer is switched off.
 * @param {number} temperature01 @param {object} [params]
 * @returns {{cold01:number, warm01:number, frostTarget01:number, heat01:number}}
 */
export function temperatureBands(temperature01, params = {}) {
  const t = Number.isFinite(temperature01) ? clamp01(temperature01) : 0.55;
  return {
    cold01:
      temperatureRamp(t, num(params, 'coldBelow'), num(params, 'coldFullAt')) *
      Math.max(0, num(params, 'coldStrength')),
    warm01:
      temperatureRamp(t, num(params, 'warmAbove'), num(params, 'warmFullAt')) *
      Math.max(0, num(params, 'warmStrength')),
    frostTarget01:
      params?.frostEnabled === false ? 0 : temperatureRamp(t, num(params, 'frostBelow'), num(params, 'frostFullAt')),
    heat01: params?.heatEnabled === false ? 0 : temperatureRamp(t, num(params, 'heatAbove'), num(params, 'heatFullAt')),
  };
}

/** The identity delta — what a temperate scene (or a disabled effect) adds. */
export const IDENTITY_TEMPERATURE_GRADE = Object.freeze({
  exposure: 0,
  temperature: 0,
  saturationMul: 1,
  contrastMul: 1,
  lift: Object.freeze([0, 0, 0]),
  gainMul: Object.freeze([1, 1, 1]),
});

/**
 * The grade DELTA for a temperature — what to add to (or multiply into) the
 * Colour Grade's own values. The 0.15 lift and 0.3 gain scales are the same
 * the Colour Grade's split-tone uses (`vt-pan-viewer.js#pushGradeLook`), so an
 * "amount" of 1 here means what a picked tint means there.
 * @param {number} temperature01 @param {object} [params]
 * @returns {{exposure:number, temperature:number, saturationMul:number, contrastMul:number,
 *   lift:number[], gainMul:number[], cold01:number, warm01:number}}
 */
export function resolveTemperatureGrade(temperature01, params = {}) {
  const { cold01: c, warm01: w } = temperatureBands(temperature01, params);
  const cs = temperatureColor(params.coldShadowTint, temperatureColor(DEF.coldShadowTint, [0, 0, 0]));
  const ch = temperatureColor(params.coldHighlightTint, temperatureColor(DEF.coldHighlightTint, [1, 1, 1]));
  const ws = temperatureColor(params.warmShadowTint, temperatureColor(DEF.warmShadowTint, [0, 0, 0]));
  const wh = temperatureColor(params.warmHighlightTint, temperatureColor(DEF.warmHighlightTint, [1, 1, 1]));
  const csA = c * num(params, 'coldShadowAmount') * 0.15;
  const wsA = w * num(params, 'warmShadowAmount') * 0.15;
  const chA = c * num(params, 'coldHighlightAmount') * 0.3;
  const whA = w * num(params, 'warmHighlightAmount') * 0.3;
  const lift = [0, 1, 2].map((i) => cs[i] * csA + ws[i] * wsA);
  const gainMul = [0, 1, 2].map((i) => (1 + (ch[i] - 1) * chA) * (1 + (wh[i] - 1) * whA));
  return {
    exposure: c * num(params, 'coldExposure') + w * num(params, 'warmExposure'),
    temperature: -c * num(params, 'coldWhiteBalance') + w * num(params, 'warmWhiteBalance'),
    saturationMul:
      Math.max(0, 1 - c * num(params, 'coldDesaturate')) * Math.max(0, 1 + w * num(params, 'warmSaturation')),
    contrastMul:
      Math.max(0.1, 1 + c * num(params, 'coldContrast')) * Math.max(0.1, 1 + w * num(params, 'warmContrast')),
    lift,
    gainMul,
    cold01: c,
    warm01: w,
  };
}

/**
 * Fold a share of a temperature delta into a grade (`grade-ops.js` shape).
 * Missing grade fields read as the identity, so `{}` (a disabled Colour Grade)
 * becomes the temperature grade alone. `share` 0 returns the grade's values
 * unchanged; 1 applies the whole delta.
 * @param {object} grade @param {object} delta @param {number} share @returns {object}
 */
export function applyTemperatureGrade(grade = {}, delta = IDENTITY_TEMPERATURE_GRADE, share = 1) {
  const s = clamp01(Number.isFinite(share) ? share : 0);
  const g = grade || {};
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const lift = Array.isArray(g.lift) ? g.lift : [0, 0, 0];
  const gain = Array.isArray(g.gain) ? g.gain : [1, 1, 1];
  const d = delta || IDENTITY_TEMPERATURE_GRADE;
  return {
    ...g,
    exposure: n(g.exposure, 0) + d.exposure * s,
    temperature: n(g.temperature, 0) + d.temperature * s,
    saturation: n(g.saturation, 1) * (1 + (d.saturationMul - 1) * s),
    contrast: n(g.contrast, 1) * (1 + (d.contrastMul - 1) * s),
    vibrance: n(g.vibrance, 0),
    tint: n(g.tint, 0),
    lift: [0, 1, 2].map((i) => n(lift[i], 0) + d.lift[i] * s),
    gamma: Array.isArray(g.gamma) ? g.gamma : [1, 1, 1],
    gain: [0, 1, 2].map((i) => n(gain[i], 1) * (1 + (d.gainMul[i] - 1) * s)),
  };
}

/**
 * Advance the frost's coverage one frame: it creeps toward `target01` at
 * `1 / frostGrowSec` per second and clears at `1 / frostMeltSec`. A long hitch
 * (an alt-tab) counts as at most one second, so frost never leaps in at once.
 * @param {number} prev01 @param {number} dtSec @param {number} target01 @param {object} [params]
 * @returns {number}
 */
export function stepFrost(prev01, dtSec, target01, params = {}) {
  const prev = Number.isFinite(prev01) ? clamp01(prev01) : 0;
  const target = Number.isFinite(target01) ? clamp01(target01) : 0;
  const dt = Number.isFinite(dtSec) ? Math.min(1, Math.max(0, dtSec)) : 0;
  if (target > prev) return Math.min(target, prev + dt / Math.max(1, num(params, 'frostGrowSec')));
  return Math.max(target, prev - dt / Math.max(1, num(params, 'frostMeltSec')));
}

/**
 * How far the heat ripple moves the picture this frame, in screen pixels:
 * the band × strength, eased down toward `heatNightStrength` with darkness, and
 * faded out once a ripple cell is drawn smaller than ~60 px on screen (zoomed
 * far out a world-anchored ripple would turn to fizz).
 * @param {number} heat01 @param {object} [params]
 * @param {{darkness01?:number, worldPerScreenPx?:number}} [view]
 * @returns {number}
 */
export function heatRipplePx(heat01, params = {}, { darkness01 = 0, worldPerScreenPx = 1 } = {}) {
  const h = Number.isFinite(heat01) ? clamp01(heat01) : 0;
  if (h <= 0) return 0;
  const dark = Number.isFinite(darkness01) ? clamp01(darkness01) : 0;
  const night = 1 + (clamp01(num(params, 'heatNightStrength')) - 1) * dark;
  const cellPx = num(params, 'heatScale') / Math.max(1e-6, Number(worldPerScreenPx) || 1);
  const zoomFade = temperatureRamp(cellPx, 30, 90);
  return h * Math.max(0, num(params, 'heatStrengthPx')) * night * zoomFade;
}

/** Ripple tap frequencies along y (cells per `heatScale`) — the shader's two
 * taps are stretched vertically by these, so the CPU scroll must match them
 * for the shimmer to rise at `heatRiseSpeed`. */
export const HEAT_TAP_Y_FREQ = Object.freeze([2.2, 3.1]);

/**
 * Advance the ripple's rising scroll (texture-space, wrapped to [0,1) — the
 * texture repeats with period 1). CPU-integrated so changing the speed never
 * jumps the pattern.
 * @param {number[]} scroll - `[y0, y1]`, mutated and returned.
 * @param {number} dtSec @param {object} [params]
 * @returns {number[]}
 */
export function stepHeatScroll(scroll, dtSec, params = {}) {
  const dt = Number.isFinite(dtSec) ? Math.min(1, Math.max(0, dtSec)) : 0;
  const rate = num(params, 'heatRiseSpeed') / Math.max(1, num(params, 'heatScale'));
  for (let i = 0; i < 2; i++) {
    const next = (Number(scroll[i]) || 0) + rate * HEAT_TAP_Y_FREQ[i] * dt;
    scroll[i] = next - Math.floor(next);
  }
  return scroll;
}

/**
 * The per-frame stepper — everything the viewer does each frame except touch
 * the GPU, so the viewer and the shader lab run the same code. Holds the
 * frost's grown coverage and the ripple's scroll between frames.
 *
 * Frost grows on WALL time (a GM setting the mood with the game paused still
 * sees it creep in); the ripple rises on world time, so it holds still while
 * paused like the rest of the weather.
 *
 * The `warp.frost` / `warp.heatRipple` flags are the present's COMPILE flags:
 * they follow the temperature only — never zoom or darkness, which only scale
 * the amount — so panning or nightfall never rebuilds the present.
 *
 * @returns {{step: (frame: {enabled: boolean, params?: object, temperature01?: number,
 *   realDtSec?: number, worldDtSec?: number, darkness01?: number, screenW: number,
 *   screenH: number, worldPerScreenPx?: number}) => {grade: object, indoorShare: number,
 *   warp: object, info: object}}}
 */
export function createTemperatureFxStepper() {
  let frost01 = 0;
  const scroll = [0, 0];
  return {
    step({ enabled, params, temperature01, realDtSec, worldDtSec, darkness01, screenW, screenH, worldPerScreenPx }) {
      const p = params ?? {};
      const on = !!enabled;
      const dark = Number.isFinite(darkness01) ? clamp01(darkness01) : 0;
      const bands = on ? temperatureBands(temperature01, p) : { cold01: 0, warm01: 0, frostTarget01: 0, heat01: 0 };
      frost01 = stepFrost(frost01, realDtSec, bands.frostTarget01, p);
      const W = Math.max(1, Number(screenW) || 1);
      const H = Math.max(1, Number(screenH) || 1);
      const ripplePx = heatRipplePx(bands.heat01, p, { darkness01: dark, worldPerScreenPx });
      const frostShows = frost01 > 1e-3;
      const heatShows = bands.heat01 > 1e-3 && num(p, 'heatStrengthPx') > 0;
      if (heatShows) stepHeatScroll(scroll, worldDtSec, p);
      const refractPx = num(p, 'frostRefractPx');
      const frostLight = 1 - dark * (1 - clamp01(num(p, 'frostNightGlow')));
      return {
        grade: on ? resolveTemperatureGrade(temperature01, p) : IDENTITY_TEMPERATURE_GRADE,
        indoorShare: clamp01(num(p, 'indoorShare')),
        warp: {
          frost: frostShows,
          heatRipple: heatShows,
          frostCover: frost01 * frost01 * (3 - 2 * frost01),
          frostShape: [
            num(p, 'frostReach'),
            num(p, 'frostIrregularity'),
            num(p, 'frostCornerBias'),
            num(p, 'frostSoftness'),
          ],
          frostScale: num(p, 'frostCrystalScale'),
          frostRefractUv: [refractPx / W, refractPx / H],
          frostLook: [num(p, 'frostOpacity'), num(p, 'frostSparkle'), frostLight, 0],
          frostTint: temperatureColor(p.frostTint, temperatureColor(DEF.frostTint, [1, 1, 1])),
          heatAmpUv: [ripplePx / W, ripplePx / H],
          heatScroll: [scroll[0], scroll[1]],
          heatScale: num(p, 'heatScale'),
        },
        info: {
          enabled: on,
          temperature01,
          cold01: bands.cold01,
          warm01: bands.warm01,
          frost01,
          frostTarget01: bands.frostTarget01,
          heat01: bands.heat01,
          ripplePx,
        },
      };
    },
    /** Jump the frost's grown coverage (the lab's "skip the wait" button). */
    setFrost01(v) {
      frost01 = Number.isFinite(v) ? clamp01(v) : 0;
    },
  };
}
