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
 * THE BLOOM TIE-IN: bloom's bright pass runs the SAME per-pixel gain and glows from what reads past
 * `glowFrom` on screen. Punchy flames and noon snow glare through the lens; lamp pools and ordinary
 * surfaces never glow.
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

/** Brightening adapts this much slower than darkening (an eye adapts to glare faster). */
export const DARK_ADAPT_SLOWER = 2;
/** The longest frame step the adaptation integrates. */
export const MAX_ADAPT_DT_SEC = 0.25;

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
    default: 1.5,
    category: 'Response',
    label: 'Adapt time',
    help: 'How long the camera takes to settle after the light changes, in seconds (glare takes half as long). A floor change or scene load settles at once.',
  },
  // ── Light (the bloom tie-in) ────────────────────────────────────────────
  glowFrom: {
    type: 'float',
    min: 0.5,
    max: 3,
    step: 0.01,
    default: 1.15,
    category: 'Light',
    label: 'Glow from',
    help: 'Bloom starts where this camera makes the picture read this bright (1 = white), so only light too bright for the picture glows — flames, glints, noon snow — never a lamp pool. Lower lets more glow. Replaces the Bloom card’s thresholds while this card is on.',
  },
});

export const DYNAMIC_RANGE_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(DYNAMIC_RANGE_PARAMS).map(([k, d]) => [k, d.default]))
);

const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * One readback → statistics. R = mean scene.lit luminance of the cell, G = mean scene.illum luminance.
 * @param {ArrayLike<number>} px RGBA floats @param {number} w @param {number} h
 * @returns {{n:number, litP50:number, litP99:number, illumP50:number}|null}
 */
export function meterStats(px, w, h) {
  const cells = w * h;
  if (!px || px.length < cells * 4) return null;
  const lit = new Float32Array(cells);
  const ill = new Float32Array(cells);
  let n = 0;
  for (let i = 0; i < cells; i++) {
    const l = Number(px[i * 4]);
    if (!(l > METER_VALID_MIN)) continue;
    lit[n] = l;
    ill[n] = Math.max(0, Number(px[i * 4 + 1]) || 0);
    n++;
  }
  if (!n) return null;
  const a = lit.subarray(0, n).sort();
  const b = ill.subarray(0, n).sort();
  const at = (s, q) => s[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1) + 0.5)))];
  return { n, litP50: at(a, 0.5), litP99: at(a, 0.99), illumP50: at(b, 0.5) };
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
 * @param {readonly number[]} rgb @param {readonly number[]} illumRgb @param {ReturnType<typeof curveFor>} curve
 * @returns {[number,number,number]}
 */
export function drTransform(rgb, illumRgb, curve, colorationRgb = null) {
  const { g, k, L } = drGain(rgb, illumRgb, curve, colorationRgb);
  const graded = rgb.map((v) => Math.max(0, v) * g * k);
  const L2 = L * k;
  // Colour in light: full above the pivot + 2 stops, none below a stop under it.
  const w = clamp((Math.log2(L2 / curve.mid) + 1) / 3, 0, 1);
  const sat = 1 + (curve.colour - 1) * w;
  const coloured = graded.map((v) => Math.max(0, L2 + (v - L2) * sat));
  return highlightRolloff(coloured, undefined, DR_WHITEN);
}

/** What bloom's bright pass compares with `glowFrom`: the pixel's brightest channel as this camera shows it (pre-shoulder). */
export function drDisplayBrightness(rgb, illumRgb, curve, colorationRgb = null) {
  const { g, k } = drGain(rgb, illumRgb, curve, colorationRgb);
  return Math.max(0, ...rgb) * g * k;
}

/** One adaptation step toward `target` on the real frame delta (exponential). */
export function adaptToward(current, target, dtSec, adaptSeconds) {
  const cur = num(current, 0);
  const tgt = num(target, 0);
  const tau = num(adaptSeconds, DYNAMIC_RANGE_DEFAULTS.adaptSeconds);
  if (!(tau > 0)) return tgt;
  const dt = clamp(num(dtSec, 0), 0, MAX_ADAPT_DT_SEC);
  const t = tgt > cur ? tau : tau / DARK_ADAPT_SLOWER;
  return cur + (tgt - cur) * (1 - Math.exp(-dt / t));
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
