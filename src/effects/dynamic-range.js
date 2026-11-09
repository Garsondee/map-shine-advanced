/**
 * DYNAMIC RANGE — an HDR camera for MSA (2026-11-04, round 2). Replaces "Auto Exposure" (1e3f4f1f),
 * a limiter that left every real scene alone.
 *
 * Ingram: "increase drama, make best use of colour/luminosity space, make fires and candle flames
 * punchy, make snow glaring in full noon unclouded sun. Basically a PBR like approach" — while still
 * "helping to avoid over tipping things".
 *
 * THIS FILE IS THE DECLARATION (params + manifest) AND THE PURE MATHS — no THREE. The TSL twin of
 * {@link drGain} / {@link drTransform} is dynamic-range-render.js#buildDynamicRangeGainNode, line for
 * line; the present pass and bloom's bright pass both run it.
 *
 * THE IDEA — MSA already knows LIGHT from MATERIAL. `scene.illum` is the light arriving at a pixel and
 * `scene.lit = EOTF(OETF(albedo) × illum)`, so `lit ÷ greyCard(illum)` is what the surface does with that
 * light: 1 for an 18% grey floor, ~5 for snow or white paper, far more for a flame (it emits more than
 * the light around it explains). A single brightness curve cannot tell a lamp pool (ordinary floor
 * under strong light) from a flame or sunlit snow — round 2's first cut punched both, and lamp pools
 * blew out to cream disks (Clockwork Dungeon, Wizards Lair, measured 2026-11-04). So the camera tones
 * the two separately:
 *
 *  1. EXPOSURE FROM INCIDENT LIGHT — a light meter, not a reflected one. The median of `scene.illum`
 *     converted to what an 18% grey card reads under it; the camera adapts `eyeAdapt` of the way from
 *     that light level to noon's. A snowfield is NOT pulled to grey (the classic auto-exposure failure)
 *     — noon stays at noon's exposure; only the LIGHT LEVEL is adapted to. The pivot `mid` is that
 *     grey card, exposed.
 *  2. THE LIGHT TERM (stops of light vs the scene's typical light): DRAMA steepens it within ±3 stops
 *     (lit areas lift, dark ones deepen — never more than `shadowDepth`), then LIGHT RANGE caps it
 *     softly: no pool of light may read more than `lightRange` stops over the scene's light, so a lamp
 *     pool on an ordinary floor never blows out.
 *  3. THE MATERIAL TERM (stops of surface/emission vs grey under its own light): half of DRAMA (so a
 *     lampless room still gains depth), then HIGHLIGHT PUNCH expands
 *     it above `punchFrom` (at most PUNCH_RANGE extra stops). Flames, candle cores, snow and white
 *     things in strong light, metal glints pull away; a grey floor in a lamp pool is never punched.
 *  4. COLOUR IN LIGHT — brighter light carries richer colour (the eye's Hunt effect).
 *  5. THE SHOULDER — grade-ops.js#highlightRolloff, hue-preserving, with a slow burn (DR_WHITEN): what is
 *     pushed past white eases toward it, a flame keeps an orange body round its hot core.
 *
 * ONE CAMERA (2026-11-08, mmp-ilo.1) — this card is the camera's EXPOSURE; the Bloom card is its GLARE.
 *  - THE METER is a centre-weighted, trimmed LOG-AVERAGE of the incident light ({@link meterStats} →
 *    `illumKey`), not a median: a median of a frame that is half lamp-lit interior, half sunlit street jumps
 *    between the two modes on a few pixels of pan (the author: "flickering of light levels when moving across
 *    the map"). A weighted log-average moves continuously as the view moves; the centre weight keeps the
 *    frame's edges (where new ground streams in during a pan) from steering it.
 *  - THE FLASH GATE ({@link gateReading}): a reading may only RAISE the metered light once it has held for
 *    FLASH_GATE_SEC. Lightning, a muzzle flash, a spell burst (0.2–0.5 s) never re-expose the camera; a
 *    darker reading lands at once. `holdSec` freezes the meter outright (MapShine.camera.holdExposure).
 *  - ADAPTATION in log-luminance ({@link adaptToward}), asymmetric like an eye: into BRIGHTER light it
 *    adapts in LIGHT_ADAPT_SHARE of the adapt time (light adaptation is fast — glare is uncomfortable), never faster
 *    than MAX_ADAPT_STOPS_PER_SEC (no lurch at the start of a big change); into
 *    DARKER light it takes the full adapt time (dark adaptation is slow). Before 2026-11-08 this was the
 *    wrong way round: a pan into a dark interior lifted the picture twice as fast as a pan out dimmed it,
 *    which read as pumping.
 *  - THE GLARE TIE-IN: bloom's bright pass reads the scene at THIS camera's exposure (the stops only — the
 *    per-pixel drama/punch curve is a tone decision, not more light), and its glow joins after the curve.
 *    What glows, and how much, is the Bloom card's (bloom.js: an energy fraction, not a halo per pixel).
 *    Before, the bright pass thresholded the PUNCHED brightness, so a metal glint punched +2.5 stops also
 *    glowed as if it were that bright (the author: "huge fat chunky bloom around metallics").
 *
 * @module effects/dynamic-range
 */

import { highlightRolloff } from './grade/grade-ops.js';

/** The meter grid (cells), 16:9. ~83 KB per readback. */
export const METER_W = 96;
export const METER_H = 54;
/** A cell this dark is the void (or the map padding the meter zeroes), not the scene. */
export const METER_VALID_MIN = 1e-5;

/** Incident light at full noon sun as `scene.illum` reads it — measured 0.93 median on Snowbound at a
 * cloudless noon (2026-11-04). The exposure is 0 stops here. */
export const NOON_ILLUM = 1;
/** The grey card: an 18% (linear) grey surface, sRGB-encoded as the composite multiplies it. */
export const GREY_CARD_SRGB = 0.4614;
/** Light below this many stops under the scene's typical light counts as "the floor": an unlit pixel's
 * own material ratio is then judged against it, so darkness is never read as a bright material. */
export const LIGHT_FLOOR_STOPS = 4;

/** Drama steepens the light term only this many stops either side of the scene's light. */
export const DRAMA_RANGE = 3;
/** Drama's share on the MATERIAL term (half): under even light (a lampless room, an overcast street) drama
 * still deepens dark wood and lifts pale stone, within ±MATERIAL_DRAMA_RANGE stops of grey. */
export const MATERIAL_DRAMA = 0.5;
export const MATERIAL_DRAMA_RANGE = 2;
/** Above the light range, light is compressed to this many stops out per stop in. */
export const LIGHT_RANGE_RATIO = 0.3;
/** Soft-knee half-width (stops) for the punch and the light range. */
export const KNEE_SOFT = 0.5;
/** The most extra stops the punch can add (approached softly) — a flame pulls away, it never blows out. */
export const PUNCH_RANGE = 2.5;
/** The shoulder's burn-to-white rate in this mode (grade-ops.js#HIGHLIGHT_WHITEN is 0.25): low, so a
 * punched flame keeps an orange body round its hot core instead of going flat white. */
export const DR_WHITEN = 0.08;

/** Into BRIGHTER light the camera adapts in this share of the adapt time (light adaptation is fast); into
 * darker light it takes the whole adapt time (dark adaptation is slow). */
export const LIGHT_ADAPT_SHARE = 1 / 2;
/** The fastest the metered light may move, in stops of light per second (≈ 0.6 stop/s of exposure at the default
 * Eye adaptation 0.4): an exponential alone starts a big change at its fastest, which on a pan from a dark hall into
 * a sunlit yard read as a lurch. Measured on the rig (2026-11-08): it caps the per-frame exposure step at ~0.01. */
export const MAX_ADAPT_STOPS_PER_SEC = 1.5;
/** The longest frame step the adaptation integrates. */
export const MAX_ADAPT_DT_SEC = 0.25;
/** A brighter meter reading must hold this long before the camera adapts to it: bright events shorter than
 * this (lightning 0.2–0.5 s, a muzzle flash) never re-expose the picture. Darker readings land at once. */
export const FLASH_GATE_SEC = 0.8;
/** The meter's centre weight: a Gaussian whose sigma is this share of the frame's half-diagonal. */
export const METER_SIGMA = 0.5;
/** The meter's trim: this share of the weight is dropped at EACH end of the light range (black voids under
 * the frame, the hot cores of lamp pools) before the log-average is taken. */
export const METER_TRIM = 0.1;

/** @type {Record<string, object>} */
export const DYNAMIC_RANGE_PARAMS = Object.freeze({
  // ── Look ────────────────────────────────────────────────────────────────
  drama: {
    type: 'float',
    min: 0.7,
    max: 1.8,
    step: 0.01,
    default: 1.3,
    category: 'Look',
    label: 'Drama',
    help: 'How strongly lit areas stand out from dark ones: shadows deepen, lit places lift. 1 leaves the lighting’s own contrast; 1.6 is bold; below 1 flattens.',
  },
  punch: {
    type: 'float',
    min: 1,
    max: 3,
    step: 0.01,
    default: 1.8,
    category: 'Look',
    label: 'Highlight punch',
    help: 'How hard the brightest THINGS pull away from the rest — fire, candle flames, snow and white cloth in sunlight, glinting metal. A plain floor under a lamp is never punched. 1 is off.',
  },
  colour: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1.2,
    category: 'Look',
    label: 'Colour in light',
    help: 'Richness of colour in the lit parts of the picture: firelight goes deeper orange, sunlit thatch more golden. Shadows are not touched. 1 leaves colour as it is.',
  },
  exposure: {
    type: 'float',
    min: -2,
    max: 2,
    step: 0.01,
    default: 0,
    category: 'Look',
    label: 'Exposure',
    help: 'Brighter (+) or darker (−) overall, in stops, on top of what the camera chose.',
  },
  // ── Response ────────────────────────────────────────────────────────────
  eyeAdapt: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.4,
    category: 'Response',
    label: 'Eye adaptation',
    help: 'How far the camera adapts to the light level. 0 keeps noon’s exposure everywhere (night as dark as the lighting makes it); 1 makes a night as bright as noon. The camera meters the LIGHT, not the surfaces, so snow stays white and coal stays black.',
  },
  lightRange: {
    type: 'float',
    min: 1,
    max: 8,
    step: 0.1,
    default: 3,
    category: 'Response',
    label: 'Light range',
    help: 'How many stops brighter than the scene’s typical light a pool of light may read (each stop doubles). Past it, a lamp pool is eased back so it never blows out to a flat disc. 8 is off.',
  },
  punchFrom: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1.25,
    category: 'Response',
    label: 'Punch starts at',
    help: 'How many stops brighter than a grey surface under the same light a thing must be before it is punched. Lower brings paler surfaces in.',
  },
  shadowDepth: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Response',
    label: 'Deepest shadow',
    help: 'The most Drama may darken any shadow, in stops — depth without crushing detail to black.',
  },
  adaptSeconds: {
    type: 'float',
    min: 0,
    max: 10,
    step: 0.1,
    default: 2.5,
    category: 'Response',
    label: 'Adapt time',
    help: 'How long the camera takes to settle when the light gets darker, in seconds, like eyes getting used to the dark. Into brighter light it settles twice as fast, and never lurches. Flashes shorter than a second (lightning) never change it. A floor change or scene load settles at once.',
  },
});

export const DYNAMIC_RANGE_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(DYNAMIC_RANGE_PARAMS).map(([k, d]) => [k, d.default]))
);

const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** The meter's centre weight for cell (i, j) of a w×h grid (dynamic-range.js#METER_SIGMA). */
export function meterWeight(i, j, w, h) {
  const dx = ((i + 0.5) / w - 0.5) * 2;
  const dy = ((j + 0.5) / h - 0.5) * 2;
  const r2 = (dx * dx + dy * dy) / 2; // 1 at the corners
  return Math.exp(-r2 / (2 * METER_SIGMA * METER_SIGMA));
}

/**
 * The value of rank `k` (0-based, ascending) in `arr`, by in-place quickselect (Hoare partition, middle pivot).
 * Reorders `arr`; the answer equals `arr.slice().sort()[k]`. @param {Float32Array} arr @param {number} k
 */
export function selectRank(arr, k) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const pivot = arr[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (arr[i] < pivot) i++;
      while (arr[j] > pivot) j--;
      if (i <= j) {
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return arr[k];
  }
  return arr[k];
}

const sortF32 = new Float32Array(1);
const sortU32 = new Uint32Array(sortF32.buffer);
/**
 * The indices of `vals[0..n)` in ascending value order, ties by index (perf sweep 2026-11-08). Each key packs the
 * value's float32 bits (flipped so unsigned order = numeric order) above its index, and a native BigUint64Array sort
 * replaces a comparator sort: ~5x faster on the meter's 5184 cells. Values closer than float32 resolution keep index
 * order, which moves the trimmed mean by under 1e-6 stop.
 * @param {ArrayLike<number>} vals @param {number} n @param {{keys: BigUint64Array}|null} [scratch]
 * @returns {Uint32Array|number[]} the order (length n)
 */
function sortedOrder(vals, n, scratch = null) {
  const keys = scratch?.keys && scratch.keys.length >= n ? scratch.keys.subarray(0, n) : new BigUint64Array(n);
  for (let k = 0; k < n; k++) {
    sortF32[0] = vals[k];
    const bits = sortU32[0];
    const ord = bits & 0x80000000 ? ~bits >>> 0 : (bits | 0x80000000) >>> 0;
    keys[k] = (BigInt(ord) << 32n) | BigInt(k);
  }
  keys.sort();
  const order = scratch?.order && scratch.order.length >= n ? scratch.order.subarray(0, n) : new Uint32Array(n);
  for (let k = 0; k < n; k++) order[k] = Number(keys[k] & 0xffffffffn);
  return order;
}

/**
 * The weighted, trimmed mean of `vals` (log2 light): drop `trim` of the total weight at each end (partial
 * weights at the cut, so the answer moves continuously as the weights do), average the rest.
 * @param {Float64Array|number[]} vals @param {Float64Array|number[]} wts @param {number} n @param {number} trim
 */
export function trimmedWeightedMean(vals, wts, n, trim = METER_TRIM, orderScratch = null) {
  const order = sortedOrder(vals, n, orderScratch);
  let total = 0;
  for (let k = 0; k < n; k++) total += wts[k];
  if (!(total > 0)) return null;
  const lo = total * trim;
  const hi = total * (1 - trim);
  let acc = 0;
  let sum = 0;
  let wsum = 0;
  for (const k of order) {
    const a = acc;
    const b = acc + wts[k];
    acc = b;
    const keep = Math.max(0, Math.min(b, hi) - Math.max(a, lo));
    if (keep > 0) {
      sum += vals[k] * keep;
      wsum += keep;
    }
  }
  return wsum > 0 ? sum / wsum : null;
}

/**
 * One readback → statistics. Per cell: R = mean scene.lit luminance, G = mean scene.illum luminance,
 * B = mean bright EXCESS at the camera's exposure (exposed luminance over the glare threshold — the energy
 * the glare spreads), A = share of the cell's taps over that threshold (dynamic-range-render.js meter).
 * `illumKey` (what the camera meters, 2026-11-08) = 2^(centre-weighted, trimmed mean of log2 illum).
 * `glowEnergy` / `glowCover` = the in-scene, unweighted means of B and A (the glare budget's inputs).
 * @param {ArrayLike<number>} px RGBA floats @param {number} w @param {number} h
 * @returns {{n:number, litP50:number, litP99:number, illumP50:number, illumKey:number, glowEnergy:number,
 *   glowCover:number}|null}
 */
/** Per-grid scratch for {@link meterStats}: the centre weights (a pure function of the cell) and reusable buffers,
 * so a reading allocates nothing and calls `Math.exp` once per cell per grid size, not per reading. */
let meterScratch = null;
function meterScratchFor(w, h) {
  if (meterScratch && meterScratch.w === w && meterScratch.h === h) return meterScratch;
  const cells = w * h;
  const weights = new Float64Array(cells);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) weights[j * w + i] = meterWeight(i, j, w, h);
  meterScratch = {
    w,
    h,
    weights,
    lit: new Float32Array(cells),
    ill: new Float32Array(cells),
    logs: new Float64Array(cells),
    wts: new Float64Array(cells),
    sort: { keys: new BigUint64Array(cells), order: new Uint32Array(cells) },
  };
  return meterScratch;
}

export function meterStats(px, w, h) {
  const cells = w * h;
  if (!px || px.length < cells * 4) return null;
  const S = meterScratchFor(w, h);
  const { lit, ill, logs, wts, weights } = S;
  let n = 0;
  let energy = 0;
  let cover = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const c = j * w + i;
      const l = Number(px[c * 4]);
      if (!(l > METER_VALID_MIN)) continue;
      lit[n] = l;
      const il = Math.max(0, Number(px[c * 4 + 1]) || 0);
      ill[n] = il;
      logs[n] = Math.log2(Math.max(1e-6, il));
      wts[n] = weights[c];
      energy += Math.max(0, Number(px[c * 4 + 2]) || 0);
      cover += Math.max(0, Number(px[c * 4 + 3]) || 0);
      n++;
    }
  }
  if (!n) return null;
  const key = trimmedWeightedMean(logs, wts, n, METER_TRIM, S.sort);
  // Order statistics by selection, not a full sort (perf sweep 2026-11-08): the same values, O(n).
  const a = lit.subarray(0, n);
  const b = ill.subarray(0, n);
  const rank = (q) => Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1) + 0.5)));
  const litP50 = selectRank(a, rank(0.5));
  const litP99 = selectRank(a, rank(0.99));
  const illumP50 = selectRank(b, rank(0.5));
  return {
    n,
    litP50,
    litP99,
    illumP50,
    illumKey: key === null ? illumP50 : 2 ** key,
    glowEnergy: energy / n,
    glowCover: cover / n,
  };
}

/** What an 18% grey card reads (linear) under incident light `illum` — the composite's own formula. */
export function greyCard(illum) {
  return srgbToLinear(clamp(GREY_CARD_SRGB * Math.max(0, num(illum, 0)), 0, 64));
}

/**
 * The exposure (stops) from the incident light: adapt `eyeAdapt` of the way from this light level to
 * noon's, plus the author's bias. 0 at noon.
 * @param {number} illumP50 @param {object} params
 */
export function exposureFromIncident(illumP50, params) {
  const p = params ?? {};
  const adapt = clamp(num(p.eyeAdapt, DYNAMIC_RANGE_DEFAULTS.eyeAdapt), 0, 1);
  const bias = clamp(num(p.exposure, 0), -4, 4);
  const card = Math.max(1e-6, greyCard(illumP50));
  return clamp(adapt * Math.log2(greyCard(NOON_ILLUM) / card) + bias, -4, 5);
}

/**
 * The curve the shader runs this frame (all live uniforms).
 * @param {{illumP50:number}} stats @param {number} ev @param {object} params
 */
export function curveFor(stats, ev, params) {
  const p = params ?? {};
  const D = DYNAMIC_RANGE_DEFAULTS;
  return {
    ev: num(ev, 0),
    mid: Math.max(1e-5, greyCard(num(stats?.illumP50, NOON_ILLUM)) * 2 ** num(ev, 0)),
    drama: clamp(num(p.drama, D.drama), 0.5, 3),
    punch: clamp(num(p.punch, D.punch), 1, 4),
    punchFrom: clamp(num(p.punchFrom, D.punchFrom), 0, 6),
    shadowDepth: clamp(num(p.shadowDepth, D.shadowDepth), 0, 6),
    colour: clamp(num(p.colour, D.colour), 0, 3),
    lightRange: clamp(num(p.lightRange, D.lightRange), 0.5, 12),
  };
}

/** The quadratic soft knee: 0 below −KNEE_SOFT, x above +KNEE_SOFT, smooth between. */
function softAbove(x) {
  const t = clamp(x + KNEE_SOFT, 0, 2 * KNEE_SOFT);
  return x > KNEE_SOFT ? x : (t * t) / (4 * KNEE_SOFT);
}

/** The light term, stops in → stops out (drama, then the soft light-range cap). */
export function lightStopsOut(l, curve) {
  let o = l + (curve.drama - 1) * clamp(l, -DRAMA_RANGE, DRAMA_RANGE);
  if (l < 0) o = Math.max(o, l - curve.shadowDepth);
  return o - softAbove(o - curve.lightRange) * (1 - LIGHT_RANGE_RATIO);
}

/** The material term, stops in → stops out (half of drama, then the punch). */
export function materialStopsOut(r, curve) {
  const contrast = (curve.drama - 1) * MATERIAL_DRAMA * clamp(r, -MATERIAL_DRAMA_RANGE, MATERIAL_DRAMA_RANGE);
  const s = softAbove(r - curve.punchFrom);
  return r + contrast + (curve.punch - 1) * (s / (1 + s / PUNCH_RANGE));
}

/**
 * The per-pixel gain (and the exposed luminance it applies to), from the pixel's lit and illum.
 * @param {readonly number[]} rgb scene.lit @param {readonly number[]} illumRgb scene.illum
 * @param {ReturnType<typeof curveFor>} curve @param {readonly number[]|null} [colorationRgb] scene.coloration
 * @returns {{g:number, k:number, L:number}} exposure gain, curve gain, exposed lit luminance
 */
export function drGain(rgb, illumRgb, curve, colorationRgb = null) {
  const g = 2 ** curve.ev;
  const L = Math.max(1e-6, lumOf(rgb.map((v) => Math.max(0, v))) * g);
  // A lamp's COLORATION (Foundry's coloured light, added into lit but absent from illum) is LIGHT too:
  // counted here, a green-lit floor is a lit floor, not a glowing material (it was punched past white
  // and burned to a flat yellow blob on Wizards Lair, 2026-11-04).
  const col = colorationRgb ? Math.max(0, lumOf(colorationRgb)) : 0;
  const card = Math.max((greyCard(lumOf(illumRgb)) + col) * g, curve.mid * 2 ** -LIGHT_FLOOR_STOPS);
  const lLight = Math.log2(card / curve.mid);
  const r = Math.log2(L / card);
  const k = 2 ** (lightStopsOut(lLight, curve) - lLight + materialStopsOut(r, curve) - r);
  return { g, k, L };
}

/**
 * The full per-pixel transform (CPU mirror of the shader): scene-referred linear RGB → display-ready
 * linear RGB (≤ ~1 after the shoulder).
 * GLARE (2026-11-07) — `glareRgb`, bloom's glow, joins AFTER the curve and goes through the shoulder with the
 * picture. Added into `rgb` instead (as it was), the curve read a halo as a bright material and punched it: a halo
 * lifting a dark floor 1.25 stops over its grey card took the punch's extra stops on top. Since 2026-11-08 the bloom
 * pyramid is built from the scene AT THIS EXPOSURE, so the glare arrives already exposed (no extra gain here).
 * @param {readonly number[]} rgb @param {readonly number[]} illumRgb @param {ReturnType<typeof curveFor>} curve
 * @param {readonly number[]|null} [colorationRgb] @param {readonly number[]|null} [glareRgb] bloom, already exposed
 * @returns {[number,number,number]}
 */
export function drTransform(rgb, illumRgb, curve, colorationRgb = null, glareRgb = null) {
  const { g, k, L } = drGain(rgb, illumRgb, curve, colorationRgb);
  const graded = rgb.map((v) => Math.max(0, v) * g * k);
  const L2 = L * k;
  // Colour in light: full above the pivot + 2 stops, none below a stop under it.
  const w = clamp((Math.log2(L2 / curve.mid) + 1) / 3, 0, 1);
  const sat = 1 + (curve.colour - 1) * w;
  const coloured = graded.map((v, i) => Math.max(0, L2 + (v - L2) * sat) + (glareRgb ? Math.max(0, glareRgb[i]) : 0));
  return highlightRolloff(coloured, undefined, DR_WHITEN);
}

/**
 * What bloom's bright pass thresholds while this camera is on: the pixel's brightest channel at the camera's
 * EXPOSURE (stops only). The drama/punch curve is deliberately left out — it decides how bright a thing LOOKS,
 * not how much light reaches the lens (a punched metal glint must not also glare like a light that bright).
 */
export function drExposedBrightness(rgb, curve) {
  return Math.max(0, ...rgb) * 2 ** num(curve?.ev, 0);
}

/**
 * One adaptation step of the metered light (log2) toward `target` on the real frame delta (exponential in
 * log-luminance). Into BRIGHTER light (target above current) it runs at LIGHT_ADAPT_SHARE of the adapt
 * time; into darker light at the full adapt time — an eye adapts to glare fast and to the dark slowly.
 */
export function adaptToward(current, target, dtSec, adaptSeconds) {
  const cur = num(current, 0);
  const tgt = num(target, 0);
  const tau = num(adaptSeconds, DYNAMIC_RANGE_DEFAULTS.adaptSeconds);
  if (!(tau > 0)) return tgt;
  const dt = clamp(num(dtSec, 0), 0, MAX_ADAPT_DT_SEC);
  const t = tgt > cur ? tau * LIGHT_ADAPT_SHARE : tau;
  const step = (tgt - cur) * (1 - Math.exp(-dt / t));
  const cap = MAX_ADAPT_STOPS_PER_SEC * dt;
  return cur + clamp(step, -cap, cap);
}

/** A fresh flash gate (see {@link gateReading}). */
export function createFlashGate() {
  return { t: 0, readings: [], holdUntil: 0, gated: null };
}

/**
 * THE FLASH GATE — feed it the frame's real delta and, when a new meter reading has landed, that reading
 * (log2 light; null = none this frame). Returns the light the camera should adapt toward: the LOWEST
 * reading of the last FLASH_GATE_SEC, so a brighter reading counts only once it has held that long, and a
 * darker one counts at once. While held (`hold(gate, sec)`), it returns its last answer unchanged.
 * Pure state in, number out: no clock is read (time is the summed deltas).
 * @param {ReturnType<typeof createFlashGate>} gate @param {number|null} reading @param {number} dtSec
 * @returns {number|null}
 */
export function gateReading(gate, reading, dtSec, windowSec = FLASH_GATE_SEC) {
  gate.t += clamp(num(dtSec, 0), 0, 1);
  if (Number.isFinite(reading)) gate.readings.push({ t: gate.t, v: reading });
  // keep the newest reading older than the window too: it is the light that held through the window's start
  while (gate.readings.length > 1 && gate.readings[1].t <= gate.t - windowSec) gate.readings.shift();
  if (gate.t < gate.holdUntil && gate.gated !== null) return gate.gated;
  if (!gate.readings.length) return gate.gated;
  let lo = Infinity;
  for (const r of gate.readings) lo = Math.min(lo, r.v);
  gate.gated = lo;
  return lo;
}

/** Freeze the gate's answer for `sec` seconds of frame time (e.g. through a lightning storm's strike train). */
export function holdGate(gate, sec) {
  const s = clamp(num(sec, 0), 0, 30);
  gate.holdUntil = Math.max(gate.holdUntil, gate.t + s);
  return gate.holdUntil - gate.t;
}

/** Forget every reading (a scene load or floor change: the old light says nothing about the new view). */
export function resetGate(gate) {
  gate.readings.length = 0;
  gate.gated = null;
  gate.holdUntil = 0;
}

/** @type {import('./effect-manifest.js').EffectManifest} */
export const DYNAMIC_RANGE = Object.freeze({
  id: 'dynamicRange',
  title: 'Dynamic Range',
  visualWeight: 0.8,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'A 96×54 meter draw over scene.lit + scene.illum and an asynchronous readback every few frames; the transform is live uniforms in the present shader and bloom’s bright pass. No assets, no bakes; the exposure snaps while the view settles.',
  }),
  params: DYNAMIC_RANGE_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'incident-meter-light-material-split',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.06 }),
      adds:
        'an incident-light meter (median scene.illum → grey-card exposure, partially adapted toward noon) and a per-pixel ' +
        'HDR transform before the Look grade that tones the LIGHT (drama, soft light-range cap) apart from the MATERIAL ' +
        '(highlight punch), colour in light and the hue-preserving shoulder; bloom glows from the same transform',
    }),
  ]),
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'local-adaptation',
      note: 'a per-region exposure (interiors vs exteriors) from the same meter split by the outdoors mask',
    }),
  ]),
});
