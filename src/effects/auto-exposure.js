/**
 * AUTO EXPOSURE — "balanced light" (2026-11-04). A camera that keeps a scene readable without
 * flattening it, and a bloom that behaves like light through a lens.
 *
 * THIS FILE IS THE DECLARATION (params schema + manifest) AND THE PURE MATHS — no THREE. The meter
 * shader is `auto-exposure-render.js`; the viewer (vt/vt-pan-viewer.js#runPostBloomPass) renders the
 * meter, reads it back asynchronously, and drives the grade's exposure and the bloom from the
 * functions below. Node-tested in `__tests__/auto-exposure.test.mjs`.
 *
 * THE IDEA — a limiter at both ends, nothing in the middle (Ingram's brief: "avoid darkening to the
 * point of nothing being visible and especially avoid the scene being dominated by lighting which
 * looks unrealistically bright", without "robbing scenes of drama"):
 *  - The meter reads the scene's brightness SPREAD (median and 95th percentile of a 96×54 grid of
 *    cell means), not its average: one lamp cannot fool a median, and a few bright lamps never reach
 *    the 95th percentile — only light that covers a real share of the frame does.
 *  - Inside a comfortable band it does NOTHING: a moody night or a bright forge that already reads
 *    is left exactly as authored. Only a median below the floor (too dark to read) or a 95th
 *    percentile above the ceiling (the frame swamped by light) moves the exposure.
 *  - It only moves exposure, a uniform scale, so every ratio between light and shadow survives.
 *    `strength` closes only part of the gap and the lift/cut saturate softly at their caps, so a dark
 *    scene is still visibly darker than a bright one.
 *  - Light that reads far brighter than the middle of the picture (the 99th percentile more than
 *    `lightRange` stops above the median) is COMPRESSED above a knee two stops over the median —
 *    the audio compressor, in stops. Measured 2026-11-04 over eight maps: under 0.4% of any frame
 *    ever passes white, so "unrealistically bright" is a RANGE problem (lamp pools 3-4.5 stops over
 *    a dark room), which exposure alone cannot fix without darkening the room too.
 *  - It adapts over seconds (faster to brightness than to darkness, like an eye) and snaps while
 *    the view is settling (scene load, floor change), so a level switch never slides.
 *
 * THE BLOOM TIE-IN — bloom is light scattered inside the lens or the eye, so it should obey two
 * physical facts:
 *  1. It happens AFTER exposure. A threshold authored as "what glows on screen" must follow the
 *     exposure: when the camera opens up for a dark room, dimmer lamps glow; when it stops down for
 *     noon, only real highlights do. `bloomFollow` scales the bloom's scene-space threshold by
 *     2^-EV (1 = fully physical).
 *  2. A lens scatters a FRACTION of the light it receives; it cannot add more light than the scene
 *     holds. The meter measures the glow the bloom adds against the scene's own light, and
 *     `glowBudget` softly caps that share. Local glow around lamps is untouched; a haze that floods
 *     the whole frame is reined in.
 *
 * @module effects/auto-exposure
 */

/** The meter grid (cells). 96×54 keeps the screen's 16:9 shape; 5184 cells, ~83 KB per readback. */
export const METER_W = 96;
export const METER_H = 54;

/** A cell this dark is the void around the map, not the scene, and is left out of the statistics. */
export const METER_VALID_MIN = 1e-5;

/** The percentile that stands for "the highlights": a few lamps never reach it, a flood of light does. */
export const HIGHLIGHT_PERCENTILE = 0.95;

/**
 * Lift headroom: a lift may raise the highlight percentile up to this × the ceiling. Above 1 lets a
 * very dark scene with a few lit pools still lift a little (the pools roll toward the ceiling);
 * exactly the ceiling would freeze any scene whose lamps already touch it.
 */
export const LIFT_HEADROOM = 1.25;

/**
 * The range compressor's knee, in stops above the median: light up to 4× the middle tone is never
 * touched (the lit side of a face, a sunlit wall); only what is brighter than that is compressed.
 */
export const COMPRESS_KNEE_STOPS = 2;

/** The firmest compression it will ever apply (stops-out per stop-in above the knee). */
export const MIN_COMPRESS_RATIO = 0.35;

/** The compressor's soft-knee half-width (stops): it eases in over one stop centred on the knee. */
export const COMPRESS_SOFT_KNEE = 0.5;

/** Brightening adapts this much slower than darkening (an eye adapts to glare faster than to the dark). */
export const DARK_ADAPT_SLOWER = 2;

/** The longest frame step the adaptation will integrate; a stalled frame never jumps the exposure. */
export const MAX_ADAPT_DT_SEC = 0.25;

/**
 * The authorable knobs (validated by core/params-schema.js), grouped by the fixed ROH categories.
 * @type {Record<string, object>}
 */
export const AUTO_EXPOSURE_PARAMS = Object.freeze({
  // ── Look ────────────────────────────────────────────────────────────────
  strength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.6,
    category: 'Look',
    label: 'Strength',
    help: 'How far a scene that is too dark or too bright is moved back toward a readable brightness. 1 closes the whole gap (every scene ends up alike); lower keeps more of each scene’s own mood. Scenes that already read well are never touched.',
  },
  darkFloor: {
    type: 'float',
    min: 0,
    max: 0.6,
    step: 0.01,
    default: 0.2,
    category: 'Look',
    label: 'Darkest mid-tone',
    help: 'How dark the middle of the picture may get before the camera opens up, as a screen brightness (0 black, 1 white). Lower allows darker, moodier scenes.',
  },
  brightCeiling: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Look',
    label: 'Brightest highlights',
    help: 'How bright the brightest twentieth of the picture may get before the camera stops down (1 = screen white). A few lamps never trip it; light that floods the frame does. Raise it to allow glaring scenes.',
  },
  lightRange: {
    type: 'float',
    min: 2,
    max: 8,
    step: 0.1,
    default: 3.5,
    category: 'Look',
    label: 'Light range',
    help: 'How many stops brighter than the middle of the picture its brightest light may read (each stop doubles). Past this, light more than two stops above the middle is gently compressed — lamps stay the brightest thing, just not glaring. 8 never compresses.',
  },
  // ── Response ────────────────────────────────────────────────────────────
  maxLift: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Response',
    label: 'Most it may brighten',
    help: 'The furthest it will ever open up a dark scene, in stops (1 = twice as bright). Keeps night scenes dark, just not black.',
  },
  maxCut: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Response',
    label: 'Most it may darken',
    help: 'The furthest it will ever stop down a glaring scene, in stops (1 = half as bright).',
  },
  adaptSeconds: {
    type: 'float',
    min: 0,
    max: 10,
    step: 0.1,
    default: 2,
    category: 'Response',
    label: 'Adapt time',
    help: 'How long the camera takes to settle after the light changes, in seconds. Adjusting to glare takes half as long, like an eye. 0 is instant. A floor change or scene load always settles at once.',
  },
  // ── Light (the bloom tie-in) ─────────────────────────────────────────────
  bloomFollow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Light',
    label: 'Glow follows exposure',
    help: 'Bloom happens inside the lens, after exposure: when the camera opens up for a dark room, dimmer lamps start to glow; when it stops down for noon, only real highlights do. 1 is fully physical, 0 leaves the bloom threshold alone.',
  },
  glowBudget: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.15,
    category: 'Light',
    label: 'Glow budget',
    help: 'The most light the bloom may add to the whole picture, as a share of the scene’s own light (0.15 = about a seventh). Glow around lamps is untouched; a haze that floods the frame is reined in, as a real lens would. 0 turns the budget off.',
  },
});

/** sRGB transfer → linear, one channel. */
export const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The schema defaults as a flat object. */
export const AUTO_EXPOSURE_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(AUTO_EXPOSURE_PARAMS).map(([k, d]) => [k, d.default]))
);

/**
 * Reduce one meter readback to the numbers the controller needs.
 * Channel R = mean scene luminance of the cell (before bloom), G = mean luminance the bloom adds there.
 *
 * @param {ArrayLike<number>} px RGBA floats, `w*h*4`
 * @param {number} w @param {number} h
 * @returns {{n:number, p50:number, p95:number, sceneMean:number, bloomMean:number}|null} null when no cell is lit
 */
export function meterStats(px, w, h) {
  const cells = w * h;
  if (!px || px.length < cells * 4) return null;
  const lums = new Float32Array(cells);
  let n = 0;
  let sceneSum = 0;
  let bloomSum = 0;
  for (let i = 0; i < cells; i++) {
    const s = Number(px[i * 4]);
    if (!(s > METER_VALID_MIN)) continue;
    const b = Math.max(0, Number(px[i * 4 + 1]) || 0);
    lums[n++] = s;
    sceneSum += s;
    bloomSum += b;
  }
  if (!n) return null;
  const sorted = lums.subarray(0, n).sort();
  const at = (q) => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1) + 0.5)))];
  let over = 0;
  for (let i = n - 1; i >= 0 && sorted[i] > 1; i--) over++;
  return {
    n,
    p50: at(0.5),
    p95: at(HIGHLIGHT_PERCENTILE),
    p99: at(0.99),
    overWhite: over / n, // share of cells whose mean is past screen white (diagnostic)
    sceneMean: sceneSum / n,
    bloomMean: bloomSum / n,
  };
}

/** A soft cap: ~x for small x, approaching ±cap. */
function softCap(x, cap) {
  if (!(cap > 0)) return 0;
  return cap * Math.tanh(x / cap);
}

/**
 * The exposure (stops) the camera wants for these statistics. 0 inside the comfortable band.
 * @param {{p50:number, p95:number}|null} stats
 * @param {object} params resolved AUTO_EXPOSURE params
 * @returns {number}
 */
export function autoExposureTarget(stats, params) {
  if (!stats) return 0;
  const p = params ?? {};
  const strength = clamp(num(p.strength, AUTO_EXPOSURE_DEFAULTS.strength), 0, 1);
  if (!strength) return 0;
  const floorLin = srgbToLinear(clamp(num(p.darkFloor, AUTO_EXPOSURE_DEFAULTS.darkFloor), 0, 1));
  const ceiling = Math.max(1e-3, num(p.brightCeiling, AUTO_EXPOSURE_DEFAULTS.brightCeiling));
  const maxLift = Math.max(0, num(p.maxLift, AUTO_EXPOSURE_DEFAULTS.maxLift));
  const maxCut = Math.max(0, num(p.maxCut, AUTO_EXPOSURE_DEFAULTS.maxCut));
  const p50 = Math.max(METER_VALID_MIN, num(stats.p50, 0));
  const p95 = Math.max(p50, num(stats.p95, 0));

  const lift = floorLin > p50 ? Math.log2(floorLin / p50) : 0;
  const cut = p95 > ceiling ? Math.log2(p95 / ceiling) : 0;
  let ev = strength * (lift - cut);
  if (ev > 0) {
    ev = softCap(ev, maxLift);
    // Never lift the highlights far past the ceiling: a dark scene with lit pools lifts less.
    const headroom = Math.log2((ceiling * LIFT_HEADROOM) / p95);
    ev = Math.min(ev, Math.max(0, headroom));
  } else if (ev < 0) {
    ev = -softCap(-ev, maxCut);
  }
  return ev;
}

/**
 * THE RANGE COMPRESSOR — the audio compressor, in stops. When the picture's brightest light (99th
 * percentile) reads more than `lightRange` stops above its middle tone (median), everything brighter
 * than the knee (COMPRESS_KNEE_STOPS above the median) is compressed by `ratio` in log space, so the
 * range shrinks by `strength` of the excess. Order is kept (a brighter pixel stays brighter), the
 * middle and shadows are untouched, and inside the range it is exactly off (ratio 1).
 *
 * Both numbers are AFTER the exposure `ev` (the shader compresses the exposed image).
 * @param {{p50:number, p99:number}|null} stats
 * @param {number} ev the exposure that will be applied (stops)
 * @param {object} params resolved AUTO_EXPOSURE params (strength, lightRange)
 * @returns {{knee:number, ratio:number}} knee in exposed linear luminance; ratio 1 = off
 */
export function rangeCompression(stats, ev, params) {
  const off = { knee: 1, ratio: 1 };
  if (!stats) return off;
  const p = params ?? {};
  const strength = clamp(num(p.strength, AUTO_EXPOSURE_DEFAULTS.strength), 0, 1);
  const rangeMax = Math.max(COMPRESS_KNEE_STOPS + 0.5, num(p.lightRange, AUTO_EXPOSURE_DEFAULTS.lightRange));
  const gain = 2 ** num(ev, 0);
  const m = Math.max(METER_VALID_MIN, num(stats.p50, 0)) * gain;
  const h = Math.max(m, num(stats.p99, 0) * gain);
  const range = Math.log2(h / m);
  if (!strength || range <= rangeMax) return { knee: m * 2 ** COMPRESS_KNEE_STOPS, ratio: 1 };
  const wanted = range - strength * (range - rangeMax);
  const ratio = clamp((wanted - COMPRESS_KNEE_STOPS) / (range - COMPRESS_KNEE_STOPS), MIN_COMPRESS_RATIO, 1);
  return { knee: m * 2 ** COMPRESS_KNEE_STOPS, ratio };
}

/** The compressor's per-pixel gain for exposed luminance `L` (the shader mirrors this exactly). */
export function compressGain(L, knee, ratio) {
  if (!(ratio < 1) || !(L > 0) || !(knee > 0)) return 1;
  const over = Math.log2(L / knee);
  const w = COMPRESS_SOFT_KNEE;
  // Quadratic soft knee: exactly 0 below knee − w, exactly `over` above knee + w, smooth between.
  const t = clamp(over + w, 0, 2 * w);
  const soft = over > w ? over : (t * t) / (4 * w);
  return 2 ** (soft * (ratio - 1));
}

/**
 * One adaptation step toward `target` (both in stops), exponential, on the REAL frame delta.
 * @param {number} current @param {number} target @param {number} dtSec @param {number} adaptSeconds
 * @returns {number}
 */
export function adaptExposure(current, target, dtSec, adaptSeconds) {
  const cur = num(current, 0);
  const tgt = num(target, 0);
  const tau = num(adaptSeconds, AUTO_EXPOSURE_DEFAULTS.adaptSeconds);
  if (!(tau > 0)) return tgt;
  const dt = clamp(num(dtSec, 0), 0, MAX_ADAPT_DT_SEC);
  const t = tgt > cur ? tau : tau / DARK_ADAPT_SLOWER;
  return cur + (tgt - cur) * (1 - Math.exp(-dt / t));
}

/**
 * Bloom's scene-space threshold multiplier: the authored threshold means "on screen", after exposure.
 * @param {number} ev current exposure (stops) @param {number} follow 0..1
 * @returns {number}
 */
export function bloomThresholdScale(ev, follow) {
  return 2 ** (-num(ev, 0) * clamp(num(follow, 1), 0, 1));
}

/**
 * The bloom strength multiplier that keeps the glow inside its budget. The meter measured the glow
 * the bloom added at strength × `scaleUsed`, so the unscaled share is that over `scaleUsed`.
 * Soft: ~1 well under budget, ~budget/share well over it.
 *
 * @param {{sceneMean:number, bloomMean:number}|null} stats
 * @param {number} budget share of the scene's light (0 = off)
 * @param {number} scaleUsed the multiplier that was live when the meter rendered
 * @returns {number} 0..1
 */
export function glowBudgetScale(stats, budget, scaleUsed) {
  const b = num(budget, 0);
  if (!(b > 0) || !stats) return 1;
  const used = Math.max(1e-3, num(scaleUsed, 1));
  const share = Math.max(0, num(stats.bloomMean, 0)) / used / Math.max(METER_VALID_MIN, num(stats.sceneMean, 0));
  if (!(share > 0)) return 1;
  const r = share / b;
  return 1 / Math.sqrt(Math.sqrt(1 + r ** 4));
}

/**
 * The manifest — the effect as data (Effects.md §2 shape). Ships ON (Ingram, 2026-11-04: "Make it on by
 * default and I'll test it"); `strength` 0 or the card's switch turns it fully off (no meter pass).
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const AUTO_EXPOSURE = Object.freeze({
  id: 'autoExposure',
  title: 'Auto Exposure',
  visualWeight: 0.6,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'A 96×54 meter draw over scene.lit and an asynchronous readback every few frames: no assets, no bakes. Its exposure snaps while the view is settling, so the curtain never reveals a sliding exposure.',
  }),
  params: AUTO_EXPOSURE_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'spread-meter-limiter',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.02 }),
      adds:
        'a median/95th-percentile meter of scene.lit (96×54 cells, 16 taps each, read back asynchronously every 4th ' +
        'frame) driving a capped, slowly adapting exposure before the grade; bloom threshold follows the exposure and ' +
        'the glow is held to a share of the scene light',
    }),
  ]),
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'local-adaptation',
      note: 'a per-region (interiors vs exteriors) exposure from the same meter split by the outdoors mask, so a dark interior beside a sunlit street lifts on its own',
    }),
  ]),
});
