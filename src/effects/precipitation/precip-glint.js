/**
 * RAIN GLINT — the pure maths of "a rain streak catches a light" (mmp-row).
 *
 * ============================================================================
 * THE IDEA, IN ONE PARAGRAPH
 * ============================================================================
 * Specular lights metal with blobs. Rain is a thin glass filament, so it is lit
 * with a LINE instead: along the streak the glint is a bright core that tapers
 * to both ends, the core is pushed toward whichever end faces the light, the
 * light's own colour tints it, and each streak glints a little differently and
 * twinkles over time.
 *
 * ============================================================================
 * WHERE THE LIGHT COMES FROM — NO SECOND LIGHT SYSTEM
 * ============================================================================
 * `buf:scene.illum` is the engine's finished light accumulation (every Foundry
 * light, candle and fire, with colour, radius, falloff and wall clipping
 * already baked in). The rain's vertex stage already sampled it once per body
 * for the flat P7 pickup. The glint reads it at the streak's TWO ENDS: the
 * mean says how lit the streak is, and the head-minus-tail difference points
 * at the light (the gradient of a light pool always points at its centre).
 * That is the same "one illum sample replaces a per-light loop" trick
 * specular and iridescence use, so the cost per body is a constant two reads —
 * there is no per-light loop and nothing to cap by light count.
 *
 * ============================================================================
 * CPU TWIN
 * ============================================================================
 * `precip-runtime.js` evaluates these same formulas as TSL nodes (the vertex
 * stage computes the amount, tint and peak; the fragment stage the profile).
 * Every constant below is imported by that file, so the two cannot drift; the
 * Node tests pin the maths here.
 *
 * @module effects/precipitation/precip-glint
 */

/** sRGB-ish luminance weights, the same ones the P7 pickup uses. */
export const LUMA = Object.freeze({ r: 0.2126, g: 0.7152, b: 0.0722 });

/** Default of the "Rain light response" dial (1 = the designed strength). */
export const GLINT_DEFAULT_STRENGTH = 2;
/** Default of the "Rain glint" dial (how much streaks differ and twinkle). */
export const GLINT_DEFAULT_VARIATION = 1;

/** Light excess below this is noise in the illum buffer, not a light. */
export const LIT_FLOOR = 0.02;
/** Light excess at which a streak is fully lit. */
export const LIT_FULL = 0.55;
/** The range never drops below this, so a bright twilight ambient does not turn a sliver of excess into a full glint. */
export const LIT_RANGE_MIN = 0.4;

/** Day factor above which the glint has faded to nothing. */
export const DAY_FADE_END = 0.95;
/** Day factor below which the glint is at full strength. */
export const DAY_FADE_START = 0.55;

/** How strongly a normalised head-vs-tail difference moves the glint core. */
export const PEAK_GAIN = 8;
/** Farthest the core travels from the middle toward an end (0.4 => 0.1..0.9). */
export const PEAK_REACH = 0.4;
/** Half-width of the glint along the streak, in streak lengths. */
export const PROFILE_HALF_WIDTH = 0.62;
/** How much of the glint is added as light colour. */
export const GLINT_COLOUR_GAIN = 1.4;
/** How much of the glint is added as opacity (rain is thin; colour alone would not show). */
export const GLINT_ALPHA_GAIN = 0.85;
/** How far toward white the light's tint is eased (so a coloured light does not turn the glint murky). */
export const TINT_WHITE_MIX = 0.2;

/** Twinkle rate range, cycles per second. */
export const TWINKLE_HZ_MIN = 0.7;
export const TWINKLE_HZ_MAX = 2.6;
/** Per-streak spread of how strongly it glints (0 = all alike), at full "Rain glint". */
export const CHARACTER_SPREAD = 0.75;
/** Depth of the slow twinkle swell, at full "Rain glint". */
export const TWINKLE_SWELL = 0.45;
/** Height of the occasional narrow sparkle on top, at full "Rain glint". */
export const TWINKLE_SPARKLE = 0.5;

/** @param {number} v @returns {number} */
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** GLSL smoothstep. @param {number} a @param {number} b @param {number} x @returns {number} */
export function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** @param {number} r @param {number} g @param {number} b @returns {number} */
export function luma(r, g, b) {
  return r * LUMA.r + g * LUMA.g + b * LUMA.b;
}

/**
 * The light a point receives above the ambient, per channel (never negative).
 * @param {number[]} rgb - illum at the point.
 * @param {number[]} ambientRgb
 * @returns {[number, number, number]}
 */
export function channelExcess(rgb, ambientRgb) {
  return [0, 1, 2].map((k) => Math.max(0, (Number.isFinite(rgb[k]) ? rgb[k] : 0) - ambientRgb[k]));
}

/**
 * How much light a streak is in, given the light it receives ABOVE the
 * scene's ambient.
 *
 * The illum buffer never reaches 0 (Foundry floors the darkness), and by day it
 * is ~1 everywhere, so "lit" has to mean "brighter than the ambient", or rain
 * would glint on the whole map. At full daylight illum ~ ambient => 0.
 *
 * @param {number} excess - luminance of (illum - ambient), per-channel clamped at 0.
 * @param {number} ambientLum - luminance of the ambient background.
 * @returns {number} 0..1
 */
export function litAmount(excess, ambientLum) {
  const amb = clamp01(ambientLum);
  const range = Math.max(1 - amb, LIT_RANGE_MIN);
  return smoothstep(LIT_FLOOR, LIT_FULL, (Number.isFinite(excess) ? Math.max(0, excess) : 0) / range);
}

/**
 * 1 at night, 0 in full day: the explicit daylight fade, so day rain is
 * unchanged even if the ambient estimate is slightly off.
 * @param {number} dayFactor01 - 1 = full day.
 * @returns {number} 0..1
 */
export function nightFade(dayFactor01) {
  return 1 - smoothstep(DAY_FADE_START, DAY_FADE_END, dayFactor01);
}

/**
 * Where along the streak (0 = tail, 1 = head) the glint core sits: the end
 * that faces the light. Takes the light each end receives ABOVE AMBIENT (the
 * ambient floor would dilute the difference). Flat light => the middle.
 *
 * @param {number} excessHead @param {number} excessTail - luminance of each end's excess.
 * @returns {number} 0.1..0.9
 */
export function glintPeak(excessHead, excessTail) {
  const sum = Math.max(excessHead + excessTail, 1e-4);
  const g = Math.max(-1, Math.min(1, (PEAK_GAIN * (excessHead - excessTail)) / sum));
  return 0.5 + PEAK_REACH * g;
}

/**
 * The gradient along the streak: 1 at the core, tapering smoothly to 0 at
 * `PROFILE_HALF_WIDTH` away from it (squared, so the falloff has no corner).
 *
 * @param {number} t - 0 at the tail, 1 at the head (`uv().y`).
 * @param {number} peak - from {@link glintPeak}.
 * @returns {number} 0..1
 */
export function glintProfile(t, peak) {
  const d = Math.abs(t - peak) / PROFILE_HALF_WIDTH;
  const k = clamp01(1 - d);
  return k * k;
}

/**
 * The light's colour as a unit tint (brightest channel = 1), eased toward
 * white by `TINT_WHITE_MIX`. Input is the light above ambient, per channel.
 * No light => white.
 *
 * @param {number} r @param {number} g @param {number} b
 * @returns {[number, number, number]}
 */
export function glintTint(r, g, b) {
  const m = Math.max(r, g, b, 1e-4);
  const e = (v) => TINT_WHITE_MIX + (1 - TINT_WHITE_MIX) * (Math.max(0, v) / m);
  return [e(r), e(g), e(b)];
}

/**
 * A streak's own glint gain: a fixed per-streak character (some glint more
 * than others) times a slow twinkle. `variation` 0 => exactly 1 for every
 * streak at every moment (uniform glow).
 *
 * @param {number} bodyHash - per-body random in [0,1).
 * @param {number} phaseHash - second per-body random in [0,1).
 * @param {number} timeSec
 * @param {number} variation - the "Rain glint" dial, 0..1.
 * @returns {number} roughly 0.15..1.5
 */
export function glintGain(bodyHash, phaseHash, timeSec, variation) {
  const v = clamp01(variation);
  const character = 1 - v * CHARACTER_SPREAD * clamp01(bodyHash);
  const hz = TWINKLE_HZ_MIN + (TWINKLE_HZ_MAX - TWINKLE_HZ_MIN) * clamp01(phaseHash);
  const cycle = (timeSec * hz + phaseHash * 7.31) % 1;
  const wave = 0.5 + 0.5 * Math.cos(cycle * 2 * Math.PI); // 0..1
  // Mostly a gentle swell, with an occasional narrow sparkle on top.
  const twinkle = 1 - v * TWINKLE_SWELL * (1 - wave) + v * TWINKLE_SPARKLE * wave ** 8;
  return character * twinkle;
}

/**
 * The whole vertex-stage result for one streak: the CPU twin of the glint
 * varying in `precip-runtime.js`, i.e. what the fragment stage receives.
 *
 * @param {object} p
 * @param {number[]} p.headRgb @param {number[]} p.tailRgb - illum at each end.
 * @param {number[]} p.ambientRgb - the ambient background (sRGB, like illum).
 * @param {number} p.dayFactor01 - 1 = full day.
 * @param {number} p.bodyHash @param {number} p.phaseHash - per-streak randoms in [0,1).
 * @param {number} p.timeSec
 * @param {boolean} [p.enabled=true]
 * @param {number} [p.strength=GLINT_DEFAULT_STRENGTH] - "Rain light response"; 0 = off.
 * @param {number} [p.variation=GLINT_DEFAULT_VARIATION] - "Rain glint".
 * @returns {{rgb: [number,number,number], amount: number, peak: number}}
 *   `rgb` = tint x amount (exactly zeros when off / daylight / unlit).
 */
export function glintVarying(p) {
  const { enabled = true, strength = GLINT_DEFAULT_STRENGTH, variation = GLINT_DEFAULT_VARIATION } = p;
  const exH = channelExcess(p.headRgb, p.ambientRgb);
  const exT = channelExcess(p.tailRgb, p.ambientRgb);
  const lumH = luma(exH[0], exH[1], exH[2]);
  const lumT = luma(exT[0], exT[1], exT[2]);
  const peak = glintPeak(lumH, lumT);
  const ambientLum = luma(p.ambientRgb[0], p.ambientRgb[1], p.ambientRgb[2]);
  const lit = litAmount((lumH + lumT) * 0.5, ambientLum);
  const on = enabled && strength > 0;
  const amount = on
    ? lit * nightFade(p.dayFactor01) * strength * glintGain(p.bodyHash, p.phaseHash, p.timeSec, variation)
    : 0;
  const tint = glintTint((exH[0] + exT[0]) * 0.5, (exH[1] + exT[1]) * 0.5, (exH[2] + exT[2]) * 0.5);
  return { rgb: [tint[0] * amount, tint[1] * amount, tint[2] * amount], amount, peak };
}
