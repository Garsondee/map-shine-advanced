/**
 * world/air-driver.js — THE WEATHER THAT PUSHES THE AIR (2026-11-09, Lab · Air).
 *
 * The 3-D air (`world/air-solver.js`) is pushed by the weather above and around the map: the dial's wind, FASTER WITH
 * HEIGHT by the log law over open ground (normalised so the 1-2 m layer over open ground IS the dial: the dial keeps
 * its meaning, "what a person, a fire, a bush feels in the open"), modulated by GUST FRONTS that ride downwind at the
 * mean speed. Same gust recipe as the analytic field (`wind-field.js#createGustEnvelopeSampler`: two noise octaves
 * sliding along the wind, a threshold that falls with speed so a breeze has rare gusts and a gale is mostly gust,
 * lull 0.7, crest 1.75, ±0.18 ripple, bounded 0.4-2.2), on the CPU, on the air's own columns.
 *
 * The gust pattern's position is INTEGRATED (`phase += rate × dt`), so a wind fade changes the fronts' pace and never
 * teleports them, and a dt of 0 (a paused world) holds them exactly.
 *
 * PURE — no THREE, no Foundry. Node-tested.
 *
 * @module world/air-driver
 */
import { windFlowVector } from './wind-bake.js';
import {
  WIND_GUST_PERIOD_S,
  WIND_GUST_LENGTH_MIN_M,
  WIND_GUST_LENGTH_MAX_M,
  WIND_GUST_CROSS_FREQ_RATIO,
  WIND_GUST_EVOLVE_PER_PERIOD,
  WIND_GUST_NOISE_SPREAD,
  WIND_GUST_THRESHOLD_CALM,
  WIND_GUST_THRESHOLD_GALE,
  WIND_GUST_SHARPNESS,
  WIND_GUST_LULL,
  WIND_GUST_PEAK,
  WIND_GUST_RIPPLE,
  WIND_GALE_CHARACTER_MPS,
} from './wind-field.js';

export const AIR_DRIVER_DEFAULTS = Object.freeze({
  /** Roughness length of open ground, m (short grass 0.03, rough grass/scattered bushes 0.1). */
  z0M: 0.05,
  /** The height the dial means, m. */
  refHeightM: 1.5,
  /** σu / U at the reference height over open ground (EN 1991-1-4 at 2 m over grass: 0.24). */
  openTurbulence: 0.22,
});

/** The log-law speed ratio u(z) / u(ref). */
export function airProfile(zM, { z0M = AIR_DRIVER_DEFAULTS.z0M, refHeightM = AIR_DRIVER_DEFAULTS.refHeightM } = {}) {
  return Math.log((Math.max(0, zM) + z0M) / z0M) / Math.log((refHeightM + z0M) / z0M);
}

// ---- 2-D gradient noise (Perlin), deterministic, range about [-1, 1] -----------------------------------------------
const PERM = (() => {
  const p = new Uint8Array(512);
  let s = 0x9e3779b9 | 0;
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {
    s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) | 0;
    s = Math.imul(s ^ (s >>> 12), 0x297a2d39) | 0;
    const r = ((s ^ (s >>> 15)) >>> 0) % (i + 1);
    const t = base[i];
    base[i] = base[r];
    base[r] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
})();
const GX = [1, -1, 1, -1, 1, -1, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 1, -1];
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
/** Perlin noise at (x, y). */
export function perlin2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const X = xi & 255;
  const Y = yi & 255;
  const g = (h, dx, dy) => GX[h & 7] * dx + GY[h & 7] * dy;
  const aa = PERM[PERM[X] + Y];
  const ab = PERM[PERM[X] + Y + 1];
  const ba = PERM[PERM[X + 1] + Y];
  const bb = PERM[PERM[X + 1] + Y + 1];
  const u = fade(xf);
  const v = fade(yf);
  const x1 = g(aa, xf, yf) + (g(ba, xf - 1, yf) - g(aa, xf, yf)) * u;
  const x2 = g(ab, xf, yf - 1) + (g(bb, xf - 1, yf - 1) - g(ab, xf, yf - 1)) * u;
  return (x1 + (x2 - x1) * v) * 0.7071;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The driver's state: the integrated gust phase and the clock, so the fronts never jump.
 * @returns {{phase: number, tSec: number}}
 */
export function createAirDriverState() {
  return { phase: 0, tSec: 0 };
}

/**
 * Advance the driver by dt (a dt of 0 changes nothing).
 * @param {{phase:number, tSec:number}} state
 * @param {{speedMps:number}} wind @param {number} dtSec
 */
export function stepAirDriver(state, { speedMps }, dtSec) {
  if (!(dtSec > 0)) return state;
  const lengthM = gustLengthM(speedMps);
  state.phase += (Math.max(0, speedMps) / lengthM) * dtSec;
  state.tSec += dtSec;
  return state;
}

/** A gust's along-wind length, m: the distance the air covers in a gust's life, bounded to stay a map feature. */
export function gustLengthM(speedMps) {
  return Math.min(WIND_GUST_LENGTH_MAX_M, Math.max(WIND_GUST_LENGTH_MIN_M, Math.max(0, speedMps) * WIND_GUST_PERIOD_S));
}

/**
 * The gust multiplier at world point (xM, yM), metres, for this driver state.
 * @param {{phase:number, tSec:number}} state
 * @param {{directionDeg:number, speedMps:number, gustiness01?:number}} wind
 */
export function airGustAt(state, wind, xM, yM) {
  const g01 = Math.min(1, Math.max(0, wind.gustiness01 ?? 1));
  if (g01 === 0) return 1;
  const flow = windFlowVector(wind.directionDeg);
  const along = xM * flow.x + yM * flow.y;
  const across = -xM * flow.y + yM * flow.x;
  const freq = 1 / gustLengthM(wind.speedMps);
  const fine = freq * 2.3;
  const evolve = state.tSec * (WIND_GUST_EVOLVE_PER_PERIOD / WIND_GUST_PERIOD_S);
  const coarse = perlin2(along * freq - state.phase, across * freq * WIND_GUST_CROSS_FREQ_RATIO + evolve);
  const fn = perlin2(along * fine + 41.7 - state.phase * 1.18 * 2.3, across * fine * 0.6 + 19.3 - evolve * 1.7);
  const s = Math.min(1, Math.max(0, wind.speedMps / WIND_GALE_CHARACTER_MPS));
  const threshold = WIND_GUST_THRESHOLD_CALM + (WIND_GUST_THRESHOLD_GALE - WIND_GUST_THRESHOLD_CALM) * s;
  const z = (coarse + fn * 0.45) / WIND_GUST_NOISE_SPREAD;
  const shape = smoothstep(threshold, threshold + WIND_GUST_SHARPNESS, z);
  const ripple = 1 + Math.min(1, Math.max(-1, fn / WIND_GUST_NOISE_SPREAD)) * WIND_GUST_RIPPLE;
  const shaped = (WIND_GUST_LULL + (WIND_GUST_PEAK - WIND_GUST_LULL) * shape) * ripple;
  const bounded = Math.min(2.2, Math.max(0.4, shaped));
  return 1 + (bounded - 1) * g01;
}

/**
 * The gust multiplier for every column of an air grid (cell centres), written into `out`.
 * @param {object} grid - `buildAirGrid`'s result. @param {object} state @param {object} wind
 * @param {Float32Array} out - nx·ny.
 */
export function airGustColumns(grid, state, wind, out) {
  const { nx, ny, cellPx, pxPerMetre, originX, originY } = grid;
  for (let j = 0; j < ny; j++) {
    const yM = (originY + (j + 0.5) * cellPx) / pxPerMetre;
    for (let i = 0; i < nx; i++) {
      const xM = (originX + (i + 0.5) * cellPx) / pxPerMetre;
      out[j * nx + i] = airGustAt(state, wind, xM, yM);
    }
  }
  return out;
}
