/**
 * WINDOW SNOW — a flurry outside, played through window light.
 *
 * The author, 2026-11-03: *"have a think about how to change the _Windows effect when the precipitation is snow
 * instead, something that feels like there is a flurry of snow outside again working from very small values all the
 * way up to the highest values as a ramp of intensity."* Plan accepted as drafted (all four defaults).
 *
 * Rain lands ON the glass and bends the light. Snow mostly falls PAST it, so what the floor shows is the flakes'
 * SHADOWS. Five stages, each adding to the last, so nothing switches on with a jump:
 *
 *   FALLING   (from 0.01) flakes falling past outside: two depth layers in each facet's rigid frame (the same
 *             facets as the rain's running drops, `window-rain-field.js`), a near one of big faint discs and a
 *             far one of small sharp specks. They fall "down the pane" (toward the wall: a flake that drops
 *             lower outside throws its shadow nearer the window), flutter sideways and ride the wind. A few
 *             catch the light and GLINT. The number of flakes is LINEAR in the snow (`resolveSnowFrame`), the
 *             lesson of the rain's splash count (af837f1d).
 *   STUCK     (grows with the snow) flakes that land and stay: soft white blotches on the glass that glow a
 *             little, take the colour out and scatter the light, then melt.
 *   DRIFT     the "snow on the pane" (`stepSnowPack`) builds while it snows and melts slowly after: an uneven
 *             band along the sill edge of the light patch (pane height `h`, 0 at the wall), dim and cool inside
 *             with a glowing top edge where the snow is thin.
 *   FLURRY    (from 0.5) gusts of denser flakes: bands that sweep across the room with the wind and fill flake
 *             cells the steady fall leaves empty.
 *   WHITEOUT  (from 0.75) the light goes diffuse, cool and softly bright: a slow boiling warp blurs its edges,
 *             colour drains toward a cool white, the level lifts a little. Dramatic, never dull.
 *
 * Same contracts as the rain (`window-rain.js`): the integer hash (bit-exact GPU vs twin), clocks integrated on the
 * CPU (a speed change never teleports a flake), weather never rebuilds a material (`uPresence` runtime branch; the
 * handle exists or not, JS-time), every repeated helper a layout function fed its uniforms as arguments.
 *
 * @module effects/window/window-snow
 */

import { sharedFn } from '../../core/tsl-fn.js';
import { hash2, vnoise, rainHashNodes, aliveShare } from './window-rain.js';

/** Every tuned constant, shared by the JS twin and the shader. */
export const SNOW_TUNE = Object.freeze({
  // falling flakes: cell = flakeSizePx x mul; radius in cells; shadow darkness; speed share (near shadows move faster)
  farCellMul: 7,
  farRadius: 0.12,
  farDark: 0.32,
  farSoft: 0.45,
  farSpeed: 0.75,
  nearCellMul: 22,
  nearRadius: 0.17,
  // a near flake sways half as far (in cells): radius x 1.2 + jitter/2 + sway must stay under half a cell, or the
  // cell edge clips it (a hard step in the picture)
  nearFlutter: 0.5,
  nearDark: 0.11,
  nearSoft: 0.9,
  nearSpeed: 1.35,
  farSeed: 211,
  nearSeed: 307,
  aliveSoft: 0.06,
  // at full snow 60% of the cells hold a flake; the flurry bands fill the rest
  baseCover: 0.8,
  // a flake's centre wanders this share of a cell; its flutter at full dial (cells, peak) and rate (Hz)
  // wide jitter + small flakes in big cells: no visible lattice (radius x 1.2 + jitter/2 + sway < 0.5)
  jitter: 0.46,
  flutterCells: 0.12,
  flutterHzLo: 0.3,
  flutterHzSpan: 0.9,
  // fall speed of the shadows (px/s at the dial's 1), and how much the wind hurries them
  fallPx: 55,
  fallWindGain: 0.8,
  // the wind carries the whole fall sideways: px/s at full wind
  windDriftPx: 180,
  // glints: share of flakes that catch the light at the dial's 1, and how bright
  glintShare: 0.12,
  glintGain: 0.9,
  // stuck flakes on the glass
  stickCellMul: 7,
  stickRadius: 0.3,
  stickCover: 0.55,
  stickPeriodMin: 12,
  stickPeriodSpan: 28,
  // a stuck flake blocks part of the light (a soft dim blotch on the floor) with a faint glow round its rim
  stickDim: 0.3,
  stickGlow: 0.12,
  stickDesat: 0.6,
  stickScatterPx: 2.5,
  stickSeed: 401,
  // the sill drift: its tallest band in pane-height units (1 = 320 px), the edge's noise scale (px) and look
  driftMaxH: 0.26,
  driftNoisePx: 46,
  driftEdge: 0.05,
  driftDim: 0.5,
  driftRim: 0.3,
  driftDesat: 0.5,
  // the pack: seconds of full snow to fill it, and how high a given snowfall lets it climb
  packRiseSec: 240,
  packCapGain: 1.6,
  // flurry bands: their spacing (px), sweep speed (px/s at full wind, plus a floor) and boost
  flurryBandPx: 360,
  flurrySweepPx: 120,
  flurryBoost: 1.6,
  // whiteout: warp (px), its noise scale (px) and churn (1/s), the level lift, desaturation
  whiteWarpPx: 4,
  whiteNoisePx: 9,
  whiteChurn: 0.35,
  whiteLift: 0.14,
  // colour: how cool snow light leans at full (r, g, b multipliers) and how much drains toward grey
  cool: [0.94, 0.98, 1.05],
  desatSnow: 0.15,
  desatWhite: 0.45,
  // limits
  maxOffsetPx: 16,
  maxGain: 2,
});

/** Look defaults, mirrored by `WINDOW_PARAMS.snow*` (window.js quotes these). */
export const WINDOW_SNOW_DEFAULTS = Object.freeze({
  /** precipitation x this = the snow at the glass. 1: the ramp spans the whole precipitation range (author's ask). */
  response: 1,
  /** How many flakes fall past, relative (1 = 60% of cells at full snow). */
  flakeCount: 1,
  /** Size of a far flake's cell, px (a far flake is ~1/3 of it across, a near one ~1.4x the far cell). */
  flakeSizePx: 3.5,
  fallSpeed: 1,
  flutter: 1,
  glint: 1,
  stick: 1,
  sillDrift: 1,
  /** How long the sill drift takes to melt after the snow stops (an e-fold time, s). */
  meltSec: 300,
  flurry: 1,
  whiteout: 1,
});

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const TAU = Math.PI * 2;

/**
 * What falling water counts as snow at the window. `precipMixWeight` is the COLD share (1 = all snow), so sleet is
 * part snow (its warm share is the rain's, `rainKindWeight`).
 * @param {string} kind @param {number} mixWeight @returns {number} 0..1
 */
export function snowKindWeight(kind, mixWeight) {
  if (kind === 'snow') return 1;
  if (kind === 'sleet') return clamp01(Number.isFinite(mixWeight) ? mixWeight : 0);
  return 0;
}

/**
 * The snow lying on the pane (the sill drift), 0..1. It climbs at `snow01 / packRiseSec` per second toward a cap
 * the snowfall sets (light snow never builds a big drift), and melts with an e-fold of `meltSec` once it is above
 * what the current snow holds.
 * @param {number} pack01 @param {number} snow01 @param {number} dtSec @param {number} meltSec @returns {number}
 */
export function stepSnowPack(pack01, snow01, dtSec, meltSec) {
  const dt = clamp(Number.isFinite(dtSec) ? dtSec : 0, 0, 5);
  const pack = clamp01(Number.isFinite(pack01) ? pack01 : 0);
  const snow = clamp01(Number.isFinite(snow01) ? snow01 : 0);
  const cap = clamp01(snow * SNOW_TUNE.packCapGain);
  if (pack < cap) return Math.min(cap, pack + (dt * snow) / SNOW_TUNE.packRiseSec);
  const melt = Math.max(1, Number.isFinite(meltSec) ? meltSec : WINDOW_SNOW_DEFAULTS.meltSec);
  return Math.max(cap, pack * Math.exp(-dt / melt));
}

/**
 * Weather and the author's dials, resolved to what the shader reads. Pure, once per frame.
 * @param {object} a
 * @param {number} a.snow01 - snow of the right kind, already x response.
 * @param {number} a.pack01 - `stepSnowPack`.
 * @param {typeof WINDOW_SNOW_DEFAULTS} a.look
 * @param {number} [a.windSpeed01] - Beaufort strength 0..1.
 * @param {number} [a.gust01]
 */
export function resolveSnowFrame({ snow01, pack01, look, windSpeed01 = 0, gust01 = 0 }) {
  const T = SNOW_TUNE;
  const snow = clamp01(Number.isFinite(snow01) ? snow01 : 0);
  const pack = clamp01(Number.isFinite(pack01) ? pack01 : 0);
  const wind = clamp01(windSpeed01);
  const num = (v, d) => (Number.isFinite(v) ? Math.max(0, v) : d);
  const D = WINDOW_SNOW_DEFAULTS;
  // LINEAR in the snow: snow 0.5 is half the flakes of snow 1 (the rain's splash lesson, af837f1d)
  const fall = clamp01(snow * T.baseCover * num(look.flakeCount, D.flakeCount));
  const stick = clamp01(snow * T.stickCover * num(look.stick, D.stick));
  const drift = clamp01(pack * num(look.sillDrift, D.sillDrift));
  const flurry = smoothstep(0.5, 0.9, snow) * (0.45 + 0.55 * clamp01(gust01)) * num(look.flurry, D.flurry);
  const whiteout = smoothstep(0.75, 1, snow) * num(look.whiteout, D.whiteout);
  const c = clamp01(0.3 * snow + 0.7 * whiteout);
  return {
    // snowing at all (the colour lean shows) or snow still on the sill
    presence: snow > 0.002 || fall > 0.002 || stick > 0.002 || drift > 0.002 ? 1 : 0,
    fall,
    stick,
    drift,
    flurry,
    whiteout,
    // speeds the subsystem integrates (never multiplied by time in the shader)
    fallSpeedPx: T.fallPx * num(look.fallSpeed, D.fallSpeed) * (1 + T.fallWindGain * wind),
    windDriftPx: T.windDriftPx * wind,
    // the storm steadies the flutter, like the snow species' own `respondStorm`
    flutter: T.flutterCells * num(look.flutter, D.flutter) * (1 - 0.6 * wind),
    glint: clamp01(T.glintShare * num(look.glint, D.glint)),
    warpPx: T.whiteWarpPx * whiteout,
    lift: 1 + T.whiteLift * whiteout,
    desat: clamp01(T.desatSnow * snow + T.desatWhite * whiteout),
    tint: [lerp(1, T.cool[0], c), lerp(1, T.cool[1], c), lerp(1, T.cool[2], c)],
  };
}

/**
 * One layer of falling flakes in a rigid frame (d = "down the pane", unit). Returns the gain it multiplies in.
 * @returns {number}
 */
export function evalFlakeLayer({
  x,
  y,
  dx,
  dy,
  cellPx,
  seed,
  radius,
  dark,
  soft,
  speed,
  fallShift,
  cover,
  flutter,
  glint,
  clock,
}) {
  const T = SNOW_TUNE;
  const u = (x * -dy + y * dx) / cellPx;
  const v = (x * dx + y * dy - fallShift * speed) / cellPx;
  const cu = Math.floor(u);
  const cv = Math.floor(v);
  const fu = u - cu;
  const fv = v - cv;
  const h1 = hash2(cu, cv, 0, seed);
  const h2 = hash2(cu, cv, 1, seed);
  const alive = aliveShare(cover, h1[0], T.aliveSoft);
  if (!(alive > 0.001)) return 1;
  const hz = T.flutterHzLo + T.flutterHzSpan * h1[1];
  const sway = flutter * Math.sin(TAU * hz * clock + TAU * h2[1]);
  const ox = fu - (0.5 + (h2[0] - 0.5) * T.jitter + sway);
  const oy = fv - (0.5 + (h1[1] - 0.5) * T.jitter);
  const r = radius * (0.8 + 0.4 * h2[0]);
  const dn = Math.hypot(ox, oy) / r;
  const blob = 1 - smoothstep(1 - soft, 1, dn);
  if (!(blob > 0)) return 1;
  const h3 = hash2(cu, cv, 2, seed);
  const isGlint = h3[0] < glint ? 1 : 0;
  const core = blob * blob * blob * blob;
  return 1 + alive * (isGlint * T.glintGain * core - (1 - isGlint) * dark * blob);
}

/**
 * The flurry band at a world point: 0..1, bands across the wind sweeping downwind.
 */
export function flurryBand(x, y, windFlowX, windFlowY, flurryClock) {
  const T = SNOW_TUNE;
  const s = (x * windFlowX + y * windFlowY - flurryClock) / T.flurryBandPx;
  const w = 0.5 + 0.5 * Math.sin(TAU * s + 1.7 * Math.sin(TAU * 0.37 * s));
  return smoothstep(0.55, 0.95, w);
}

/**
 * Stuck flakes on the glass: world-aligned (the glass does not move), one per cell per melt cycle.
 * @returns {{gain:number, desat:number, ox:number, oy:number}}
 */
export function evalStuckLayer({ x, y, cellPx, stick, clock }) {
  const T = SNOW_TUNE;
  const qx = x / cellPx;
  const qy = y / cellPx;
  const cx = Math.floor(qx);
  const cy = Math.floor(qy);
  const fx = qx - cx;
  const fy = qy - cy;
  const h1 = hash2(cx, cy, 0, T.stickSeed);
  const period = T.stickPeriodMin + T.stickPeriodSpan * h1[0];
  const age01 = (clock + h1[1] * period) / period;
  const k = Math.floor(age01);
  const a = age01 - k;
  const kw = (k - 61 * Math.floor(k / 61)) | 0;
  const h2 = hash2(cx, cy, kw, T.stickSeed + 1);
  const alive = aliveShare(stick, h2[0], T.aliveSoft);
  const vis = alive * smoothstep(0, 0.02, a) * (1 - smoothstep(0.45, 1, a));
  if (!(vis > 0.001)) return { gain: 1, desat: 0, ox: 0, oy: 0 };
  const h3 = hash2(cx, cy, kw, T.stickSeed + 2);
  const ox = fx - (0.5 + (h3[0] - 0.5) * 0.4);
  const oy = fy - (0.5 + (h3[1] - 0.5) * 0.4);
  const r = T.stickRadius * (0.7 + 0.6 * h2[1]) * (1 - 0.55 * a);
  const dn = Math.hypot(ox, oy) / r;
  const blob = (1 - smoothstep(0.35, 1, dn)) * vis;
  // the scatter: a fine noise pushes each sample about inside the flake, so the light comes through blurred
  const n1 = vnoise(x * 0.45, y * 0.45, T.stickSeed) - 0.5;
  const n2 = vnoise(x * 0.45 + 17, y * 0.45 + 9, T.stickSeed) - 0.5;
  const rim = blob * (1 - blob) * 4;
  return {
    gain: 1 - T.stickDim * blob * blob + T.stickGlow * rim,
    desat: T.stickDesat * blob,
    ox: n1 * 2 * T.stickScatterPx * blob,
    oy: n2 * 2 * T.stickScatterPx * blob,
  };
}

/** The sill drift at a world point. `h` is the pane height (0 at the wall), `kappa` the wall-ness. */
export function evalDrift({ x, y, h, kappa, drift }) {
  const T = SNOW_TUNE;
  if (!(drift > 0.001) || !(kappa > 0.01)) return { gain: 1, desat: 0 };
  const n = vnoise(x / T.driftNoisePx, y / T.driftNoisePx, T.stickSeed + 5);
  const n2 = vnoise(x / (T.driftNoisePx * 0.31), y / (T.driftNoisePx * 0.31), T.stickSeed + 6);
  const edge = drift * T.driftMaxH * (0.62 + 0.55 * n + 0.18 * n2);
  const inside = (1 - smoothstep(edge - T.driftEdge, edge, h)) * kappa;
  if (!(inside > 0.001)) return { gain: 1, desat: 0 };
  // deeper in the drift (nearer the wall) the snow is thicker
  const depth = clamp01((edge - h) / Math.max(edge, 1e-4));
  const rim = inside * (1 - smoothstep(0, 0.3, depth));
  return {
    gain: 1 - inside * T.driftDim * (0.45 + 0.55 * depth) + T.driftRim * rim,
    desat: inside * T.driftDesat,
  };
}

/** No flow knowledge (`window-rain.js#NO_FLOW` shape). */
const NO_FLOW = Object.freeze({ px: 0, py: 0, qx: 0, qy: 0, mix: 0, kappa: 0, h: 0.5, gate: 1 });
const unitOrDown = (vx, vy) => {
  const l = Math.hypot(vx, vy);
  return l > 1e-4 ? [vx / l, vy / l] : [0, 1];
};

/**
 * The whole snow at one world pixel: what the shader returns, in plain JS.
 * @param {object} a
 * @param {number} a.x @param {number} a.y
 * @param {ReturnType<typeof resolveSnowFrame>} a.frame
 * @param {typeof WINDOW_SNOW_DEFAULTS} a.look
 * @param {number} a.clock - sim seconds.
 * @param {number} a.fallShift - px the fall has travelled (CPU-integrated).
 * @param {number} [a.flurryClock] - px the flurry bands have swept (CPU-integrated).
 * @param {number} [a.windShiftX] @param {number} [a.windShiftY] - px the wind has carried the fall.
 * @param {number} [a.windFlowX] @param {number} [a.windFlowY]
 * @param {object|null} [a.flow]
 * @returns {{offsetX:number, offsetY:number, gain:number, tint:number[], desat:number}}
 */
export function evalWindowSnowPixel({
  x,
  y,
  frame,
  look,
  clock,
  fallShift,
  flurryClock = 0,
  windShiftX = 0,
  windShiftY = 0,
  windFlowX = 0,
  windFlowY = 1,
  flow = null,
}) {
  const none = { offsetX: 0, offsetY: 0, gain: 1, tint: [1, 1, 1], desat: 0 };
  if (!(frame.presence > 0.5)) return none;
  const T = SNOW_TUNE;
  const f = flow ?? NO_FLOW;
  if (!((f.gate ?? 1) > 0.01)) return none;
  const kappa = f.kappa > 0.01 ? f.kappa : 0;
  const size = Math.max(0.5, Number.isFinite(look.flakeSizePx) ? look.flakeSizePx : WINDOW_SNOW_DEFAULTS.flakeSizePx);
  const [adx, ady] = kappa > 0 ? unitOrDown(f.px, f.py) : [0, 1];
  const [bdx, bdy] = kappa > 0 ? unitOrDown(f.qx, f.qy) : [0, 1];
  const band = frame.flurry > 0.001 ? flurryBand(x, y, windFlowX, windFlowY, flurryClock) : 0;
  const cover = clamp01(frame.fall * (1 + T.flurryBoost * frame.flurry * band));
  const px = x - windShiftX;
  const py = y - windShiftY;
  const layers = (dx, dy) => {
    const common = { x: px, y: py, dx, dy, fallShift, cover, flutter: frame.flutter, glint: frame.glint, clock };
    return (
      evalFlakeLayer({
        ...common,
        cellPx: size * T.farCellMul,
        seed: T.farSeed,
        radius: T.farRadius,
        dark: T.farDark,
        soft: T.farSoft,
        speed: T.farSpeed,
      }) *
      evalFlakeLayer({
        ...common,
        cellPx: size * T.nearCellMul,
        seed: T.nearSeed,
        radius: T.nearRadius,
        dark: T.nearDark,
        soft: T.nearSoft,
        speed: T.nearSpeed,
        flutter: frame.flutter * T.nearFlutter,
        // a near flake's shadow is too soft to glint
        glint: 0,
      })
    );
  };
  let gain = 1;
  if (frame.fall > 0.001) {
    const mixS = f.mix;
    if (mixS < 0.999) gain *= 1 + (layers(adx, ady) - 1) * (1 - mixS);
    if (mixS > 0.001) gain *= 1 + (layers(bdx, bdy) - 1) * mixS;
  }
  let ox = 0;
  let oy = 0;
  let desat = frame.desat;
  if (frame.stick > 0.001) {
    const s = evalStuckLayer({ x, y, cellPx: size * T.stickCellMul, stick: frame.stick, clock });
    gain *= s.gain;
    desat += s.desat;
    ox += s.ox;
    oy += s.oy;
  }
  const d = evalDrift({ x, y, h: kappa > 0 ? f.h : 0.5, kappa, drift: frame.drift });
  gain *= d.gain;
  desat += d.desat;
  if (frame.warpPx > 0.001) {
    const wx = (x - windShiftX * 0.5) / T.whiteNoisePx;
    const wy = (y - windShiftY * 0.5) / T.whiteNoisePx;
    const ch = clock * T.whiteChurn;
    ox += (vnoise(wx + ch, wy, T.stickSeed + 7) - 0.5) * 2 * frame.warpPx;
    oy += (vnoise(wx, wy - ch, T.stickSeed + 8) - 0.5) * 2 * frame.warpPx;
  }
  const len = Math.hypot(ox, oy);
  const scale = len > T.maxOffsetPx ? T.maxOffsetPx / len : 1;
  return {
    offsetX: ox * scale,
    offsetY: oy * scale,
    gain: clamp(gain * frame.lift, 0, T.maxGain),
    tint: frame.tint.slice(),
    desat: clamp01(desat),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE TSL TRANSCRIPTION — line for line the twin above.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The snow handle: uniforms, setters, and `buildInto`, which the rain's `build` calls inside its own `Fn` with the
 * flow it already fetched. The uniforms live here (this file's own uniform budget), never in window-rain.js.
 * @param {{THREE:*}} args
 */
export function createWindowSnow({ THREE }) {
  const TSL = THREE.TSL;
  const { float, int, uint, vec2, vec3, vec4, uniform, If, select, clamp, smoothstep, floor, sin, length, max, min } =
    TSL;
  const T = SNOW_TUNE;
  const D = WINDOW_SNOW_DEFAULTS;
  const F = (x) => float(x);
  const U = (n) => uint(n);
  const sat = (x) => clamp(x, 0, 1);
  const { hash2T, vnoiseT } = rainHashNodes(TSL);

  const uPresence = uniform(float(0));
  const uSize = uniform(float(D.flakeSizePx));
  /** (fall, stick, drift, flurry) */
  const uAmounts = uniform(vec4(0, 0, 0, 0));
  /** (flutter, glint, warpPx, lift) */
  const uLook = uniform(vec4(0, 0, 0, 1));
  /** (clock, fallShift, flurryClock, desat) */
  const uClocks = uniform(vec4(0, 0, 0, 0));
  const uTint = uniform(vec3(1, 1, 1));
  const uWindShift = uniform(vec2(0, 0));
  const uWindFlow = uniform(vec2(0, 1));

  // `evalFlakeLayer`. Packed: K1 = (cellPx, seed-as-float unused, radius, dark), K2 = (soft, speed, cover, flutter),
  // K3 = (glint, clock, fallShift, 0).
  const flakeFn = sharedFn(
    TSL,
    'msaSnowFlakeLayer',
    { P: 'vec2', d: 'vec2', seed: 'uint', K1: 'vec4', K2: 'vec4', K3: 'vec4' },
    'float',
    ({ P, d, seed, K1, K2, K3 }) => {
      const cellPx = K1.x;
      const radius = K1.z;
      const dark = K1.w;
      const soft = K2.x;
      const speed = K2.y;
      const cover = K2.z;
      const flutter = K2.w;
      const glint = K3.x;
      const clock = K3.y;
      const fallShift = K3.z;
      const u = P.y.mul(d.x).sub(P.x.mul(d.y)).div(cellPx);
      const v = P.x.mul(d.x).add(P.y.mul(d.y)).sub(fallShift.mul(speed)).div(cellPx);
      const cu = floor(u);
      const cv = floor(v);
      const fu = u.sub(cu);
      const fv = v.sub(cv);
      const iu = int(cu);
      const iv = int(cv);
      const h1 = hash2T(iu, iv, int(0), seed).toVar();
      const h2 = hash2T(iu, iv, int(1), seed).toVar();
      const aSoft = max(min(F(T.aliveSoft), cover), F(1e-5)).mul(0.5);
      const alive = F(1).sub(smoothstep(cover.sub(aSoft), cover.add(aSoft), h1.x));
      const hz = F(T.flutterHzLo).add(h1.y.mul(T.flutterHzSpan));
      const sway = flutter.mul(sin(hz.mul(clock).add(h2.y).mul(TAU)));
      const ox = fu.sub(F(0.5).add(h2.x.sub(0.5).mul(T.jitter)).add(sway));
      const oy = fv.sub(F(0.5).add(h1.y.sub(0.5).mul(T.jitter)));
      const r = radius.mul(F(0.8).add(h2.x.mul(0.4)));
      const dn = length(vec2(ox, oy)).div(r);
      const blob = F(1).sub(smoothstep(F(1).sub(soft), F(1), dn));
      const h3 = hash2T(iu, iv, int(2), seed);
      const isGlint = select(h3.x.lessThan(glint), F(1), F(0));
      const core = blob.mul(blob).mul(blob).mul(blob);
      return F(1).add(alive.mul(isGlint.mul(T.glintGain).mul(core).sub(F(1).sub(isGlint).mul(dark).mul(blob))));
    }
  );
  const flakeLayers = (P, d, size, cover, flutter, glint, clock, fallShift) => {
    const far = flakeFn(
      P,
      d,
      U(T.farSeed),
      vec4(size.mul(T.farCellMul), 0, T.farRadius, T.farDark),
      vec4(T.farSoft, T.farSpeed, cover, flutter),
      vec4(glint, clock, fallShift, 0)
    );
    const near = flakeFn(
      P,
      d,
      U(T.nearSeed),
      vec4(size.mul(T.nearCellMul), 0, T.nearRadius, T.nearDark),
      vec4(T.nearSoft, T.nearSpeed, cover, flutter.mul(T.nearFlutter)),
      vec4(0, clock, fallShift, 0)
    );
    return far.mul(near);
  };

  // `evalStuckLayer`, packed as (gain, desat, ox, oy).
  const stuckFn = sharedFn(
    TSL,
    'msaSnowStuckLayer',
    { P: 'vec2', cellPx: 'float', stick: 'float', clock: 'float' },
    'vec4',
    ({ P, cellPx, stick, clock }) => {
      const q = P.div(cellPx);
      const cell = floor(q);
      const fr = q.sub(cell);
      const cx = int(cell.x);
      const cy = int(cell.y);
      const h1 = hash2T(cx, cy, int(0), U(T.stickSeed)).toVar();
      const period = F(T.stickPeriodMin).add(h1.x.mul(T.stickPeriodSpan));
      const age01 = clock.add(h1.y.mul(period)).div(period);
      const k = floor(age01);
      const a = age01.sub(k);
      const kw = int(k.sub(floor(k.div(61)).mul(61)));
      const h2 = hash2T(cx, cy, kw, U(T.stickSeed + 1)).toVar();
      const aSoft = max(min(F(T.aliveSoft), stick), F(1e-5)).mul(0.5);
      const alive = F(1).sub(smoothstep(stick.sub(aSoft), stick.add(aSoft), h2.x));
      const vis = alive.mul(smoothstep(F(0), F(0.02), a)).mul(F(1).sub(smoothstep(F(0.45), F(1), a)));
      const h3 = hash2T(cx, cy, kw, U(T.stickSeed + 2));
      const ox = fr.x.sub(F(0.5).add(h3.x.sub(0.5).mul(0.4)));
      const oy = fr.y.sub(F(0.5).add(h3.y.sub(0.5).mul(0.4)));
      const r = F(T.stickRadius)
        .mul(F(0.7).add(h2.y.mul(0.6)))
        .mul(F(1).sub(a.mul(0.55)));
      const dn = length(vec2(ox, oy)).div(r);
      const blob = F(1)
        .sub(smoothstep(F(0.35), F(1), dn))
        .mul(vis)
        .toVar();
      const n1 = vnoiseT(P.x.mul(0.45), P.y.mul(0.45), U(T.stickSeed)).sub(0.5);
      const n2 = vnoiseT(P.x.mul(0.45).add(17), P.y.mul(0.45).add(9), U(T.stickSeed)).sub(0.5);
      const rim = blob.mul(F(1).sub(blob)).mul(4);
      return vec4(
        F(1).sub(blob.mul(blob).mul(T.stickDim)).add(rim.mul(T.stickGlow)),
        blob.mul(T.stickDesat),
        n1.mul(2 * T.stickScatterPx).mul(blob),
        n2.mul(2 * T.stickScatterPx).mul(blob)
      );
    }
  );

  /**
   * Build the snow's nodes INSIDE the caller's `Fn` (the rain's `build`), adding into its accumulators.
   * @param {{P:*, fl:{P:*,S:*,mix:*,kappa:*,h:*,gate:*}, off:*, gain:*, desat:*, unitOrDownT:Function}} a
   */
  function buildInto({ P, fl, off, gain, desat, unitOrDownT }) {
    If(uPresence.greaterThan(0.5).and(fl.gate.greaterThan(0.01)), () => {
      const fall = uAmounts.x;
      const stick = uAmounts.y;
      const drift = uAmounts.z;
      const flurry = uAmounts.w;
      const clock = uClocks.x;
      const fallShift = uClocks.y;
      const size = max(uSize, F(0.5));
      const kappa = select(fl.kappa.greaterThan(0.01), fl.kappa, F(0)).toVar();
      const dirA = select(kappa.greaterThan(0), unitOrDownT(fl.P), vec2(0, 1)).toVar();
      const dirB = select(kappa.greaterThan(0), unitOrDownT(fl.S), vec2(0, 1)).toVar();
      const sOff = vec2(0, 0).toVar();
      const sGain = F(1).toVar();
      const sDesat = uClocks.w.toVar();

      If(fall.greaterThan(0.001), () => {
        const band = F(0).toVar();
        If(flurry.greaterThan(0.001), () => {
          const s = P.x.mul(uWindFlow.x).add(P.y.mul(uWindFlow.y)).sub(uClocks.z).div(T.flurryBandPx);
          const w = F(0.5).add(sin(s.mul(TAU).add(sin(s.mul(TAU * 0.37)).mul(1.7))).mul(0.5));
          band.assign(smoothstep(F(0.55), F(0.95), w));
        });
        const cover = sat(fall.mul(F(1).add(flurry.mul(band).mul(T.flurryBoost))));
        const Pw = P.sub(uWindShift);
        If(fl.mix.lessThan(0.999), () => {
          const g = flakeLayers(Pw, dirA, size, cover, uLook.x, uLook.y, clock, fallShift);
          sGain.mulAssign(F(1).add(g.sub(1).mul(F(1).sub(fl.mix))));
        });
        If(fl.mix.greaterThan(0.001), () => {
          const g = flakeLayers(Pw, dirB, size, cover, uLook.x, uLook.y, clock, fallShift);
          sGain.mulAssign(F(1).add(g.sub(1).mul(fl.mix)));
        });
      });

      If(stick.greaterThan(0.001), () => {
        const s = stuckFn(P, size.mul(T.stickCellMul), stick, clock);
        sGain.mulAssign(s.x);
        sDesat.addAssign(s.y);
        sOff.addAssign(s.zw);
      });

      If(drift.greaterThan(0.001).and(kappa.greaterThan(0.01)), () => {
        const h = fl.h;
        const n = vnoiseT(P.x.div(T.driftNoisePx), P.y.div(T.driftNoisePx), U(T.stickSeed + 5));
        const n2 = vnoiseT(P.x.div(T.driftNoisePx * 0.31), P.y.div(T.driftNoisePx * 0.31), U(T.stickSeed + 6));
        const edge = drift
          .mul(T.driftMaxH)
          .mul(F(0.62).add(n.mul(0.55)).add(n2.mul(0.18)))
          .toVar();
        const inside = F(1)
          .sub(smoothstep(edge.sub(T.driftEdge), edge, h))
          .mul(kappa)
          .toVar();
        const depth = sat(edge.sub(h).div(max(edge, F(1e-4))));
        const rim = inside.mul(F(1).sub(smoothstep(F(0), F(0.3), depth)));
        sGain.mulAssign(
          F(1)
            .sub(inside.mul(T.driftDim).mul(F(0.45).add(depth.mul(0.55))))
            .add(rim.mul(T.driftRim))
        );
        sDesat.addAssign(inside.mul(T.driftDesat));
      });

      If(uLook.z.greaterThan(0.001), () => {
        const wx = P.x.sub(uWindShift.x.mul(0.5)).div(T.whiteNoisePx);
        const wy = P.y.sub(uWindShift.y.mul(0.5)).div(T.whiteNoisePx);
        const ch = clock.mul(T.whiteChurn);
        sOff.addAssign(
          vec2(
            vnoiseT(wx.add(ch), wy, U(T.stickSeed + 7)).sub(0.5),
            vnoiseT(wx, wy.sub(ch), U(T.stickSeed + 8)).sub(0.5)
          ).mul(uLook.z.mul(2))
        );
      });

      const len = length(sOff);
      const scale = min(F(1), F(T.maxOffsetPx).div(max(len, F(1e-4))));
      off.addAssign(sOff.mul(scale));
      gain.mulAssign(clamp(sGain.mul(uLook.w), 0, T.maxGain));
      desat.assign(sat(sDesat));
    });
  }

  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    buildInto,
    /** The tint the light takes on (a uniform: the cool lean is the same everywhere). */
    tintNode: uTint,
    /** @param {Partial<typeof WINDOW_SNOW_DEFAULTS>} look */
    setLook(look = {}) {
      uSize.value = Math.max(0.5, num(look.flakeSizePx, D.flakeSizePx));
    },
    /**
     * @param {ReturnType<typeof resolveSnowFrame>} frame
     * @param {{clock:number, fallShift:number, flurryClock?:number, windShift?:number[], windFlow?:number[]}} clocks
     */
    setFrame(frame, clocks) {
      const on = frame.presence ? 1 : 0;
      uPresence.value = on;
      uAmounts.value.set(num(frame.fall, 0), num(frame.stick, 0), num(frame.drift, 0), num(frame.flurry, 0));
      uLook.value.set(num(frame.flutter, 0), num(frame.glint, 0), num(frame.warpPx, 0), num(frame.lift, 1));
      uClocks.value.set(
        num(clocks.clock, 0),
        num(clocks.fallShift, 0),
        num(clocks.flurryClock, 0),
        num(frame.desat, 0)
      );
      // dry glass: the tint is exactly white, so the light's colour is untouched
      const t = on && Array.isArray(frame.tint) ? frame.tint : [1, 1, 1];
      uTint.value.set(num(t[0], 1), num(t[1], 1), num(t[2], 1));
      const ws = Array.isArray(clocks.windShift) ? clocks.windShift : [0, 0];
      uWindShift.value.set(num(ws[0], 0), num(ws[1], 0));
      const wf = Array.isArray(clocks.windFlow) ? clocks.windFlow : [0, 1];
      uWindFlow.value.set(num(wf[0], 0), num(wf[1], 1));
    },
    /** TEST/DIAGNOSTIC: every uniform as plain numbers. */
    snapshot: () => ({
      presence: uPresence.value,
      size: uSize.value,
      amounts: [uAmounts.value.x, uAmounts.value.y, uAmounts.value.z, uAmounts.value.w],
      look: [uLook.value.x, uLook.value.y, uLook.value.z, uLook.value.w],
      clocks: [uClocks.value.x, uClocks.value.y, uClocks.value.z, uClocks.value.w],
      tint: [uTint.value.x, uTint.value.y, uTint.value.z],
      windShift: [uWindShift.value.x, uWindShift.value.y],
      windFlow: [uWindFlow.value.x, uWindFlow.value.y],
    }),
  };
}
