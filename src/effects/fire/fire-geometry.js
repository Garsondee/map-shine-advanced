/**
 * FIRE — THE PURE MATH. No THREE, no TSL, no DOM: every export here is a total
 * function over plain numbers, so the physics carries a real Node test suite
 * instead of a hope.
 *
 * ============================================================================
 * THE MODEL: A VERTICAL SLAB INTEGRAL, WHICH IS NOT A RAYMARCH
 * ============================================================================
 *
 * The viewer's camera is a never-moving `OrthographicCamera` looking exactly
 * down −Z (`vt-pan-viewer.js:6103`; position/lookAt/up/rotation are never
 * assigned anywhere in the repo). So EVERY view ray is parallel to world up,
 * and integrating a fire's volume is a 1-D column integral at a fixed (x,y)
 * with every fragment marching the SAME heights in lockstep. No ray setup, no
 * per-pixel ray direction, no empty-space skipping, no 3D texture, and — since
 * `mx_fractal_noise_float` is analytic — zero bytes of memory read.
 *
 * That is why this does not contradict the two rejections on the books:
 * `layer-smear.js:8` ("a COMPOSITING problem, not a ray-marching one … after
 * two marching models failed") and `Clouds.md` R4 ("paying 3D for a 2.5D
 * problem", whose stated objection is that 3D TEXTURE FETCHES cache poorly —
 * there are none here).
 *
 * It also does not contradict `candle-flame-render.js:71` ("a 3D mesh buys zero
 * here and costs more"). That claim is SCALE-DEPENDENT and correct for a
 * candle: 20 mm of flame whose plume shear is sub-pixel at any usable zoom. A
 * campfire is 1.5 m of flame under 5 m of plume, and three things a footprint
 * structurally cannot produce are the whole look — self-occlusion (the rust
 * seams between lobes), height-dependent downwind shear (why a top-down fire
 * reads as flame with smoke streaming off ONE side), and a soft edge whose
 * width comes from accumulated partial coverage rather than a fixed smoothstep.
 *
 * ============================================================================
 * SHEETS ARE NOT SLICES — the split that makes it affordable
 * ============================================================================
 *
 * A plume is not N independent noise fields; it is ONE field, advected. A
 * parcel at height h was lower and upwind a moment ago:
 *
 *     D(x, y, h) ≈ D₀(xy − shear(h), φ − h/riseSpeed)
 *
 * Stacking N DECORRELATED fields would read as boiling static — a look failure
 * before it is a cost one. But it also means the field varies SMOOTHLY in h, so
 * the number of NOISE evaluations (M sheets) can be far smaller than the number
 * of COMPOSITE steps (N slices). Each slice still gets its own scalar geometry
 * — its own shear, radius, softness, temperature, absorption — and scalars are
 * uniform-flow and effectively free.
 *
 * MEASURED 2026-08-08 (`tools/shader-lab/bench-fire.js`, run
 * `2026-08-08_10-48-17-002-fire-octave-cost-curve`, perfectly linear across
 * octaves 1..6 with a fixed cost of 0.0004 ms/Mpx ≈ zero):
 *
 *     one lattice hash        0.00549 ms/Mpx
 *     one 3D Perlin octave    0.0439  ms/Mpx
 *     a 3-octave 3D fBm       0.1323  ms/Mpx
 *
 * and, from `noise-fold-ab` in the same session, a LIVE third noise coordinate
 * costs 1.047× a constant one — i.e. free. (The compiler is not folding the
 * constant `0.0` that `NodeBuilder.format` silently pads a vec2 argument with,
 * so the ~40 existing `fbmFloat(vec2)` call sites in `src/` already pay all 8
 * lattice corners.) N is therefore bounded by look and by coverage, not by a
 * doubling penalty.
 *
 * @module effects/fire/fire-geometry
 */

/** Clamp, the one used everywhere below. */
function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ─────────────────────────────────────────────────────────────────────────────
// THE COLOUR SPEC — sampled from the author's reference image, 2026-08-08
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The flame ramp, indexed by temperature `t` ∈ [0,1], hottest first.
 *
 * ⚠️ POSTERIZE THE TEMPERATURE SCALAR, NEVER THE RGB. Quantizing `t` before the
 * ramp lookup produces clean isotherm BANDS — concentric contours of equal
 * temperature, which is what the reference image shows. Quantizing the RGB
 * afterwards produces posterized NOISE: the same palette scattered by whatever
 * the noise field happened to be doing, which is a completely different and
 * much worse picture. The two are one line apart in a shader and nothing about
 * the code says which you meant, so it is said here.
 *
 * Values are sRGB hex as sampled; `fireRampStops` returns them as linear-ish
 * 0..1 triples for the shader.
 */
export const FIRE_RAMP_WOOD = Object.freeze([
  Object.freeze({ t: 1.0, hex: '#FFE9A8', role: 'pale core' }),
  Object.freeze({ t: 0.84, hex: '#FFDF8C', role: 'hot yellow' }),
  Object.freeze({ t: 0.66, hex: '#FFCE55', role: 'yellow' }),
  Object.freeze({ t: 0.5, hex: '#FDBA35', role: 'golden' }),
  Object.freeze({ t: 0.34, hex: '#F79420', role: 'orange' }),
  Object.freeze({ t: 0.2, hex: '#EE7B10', role: 'deep orange' }),
  Object.freeze({ t: 0.1, hex: '#E06A08', role: 'rust rim' }),
]);

/**
 * Smoke greys — WARM, not neutral, and that is the finding rather than a taste
 * call. Young smoke immediately above a fire is lit from below by the fire
 * itself, so it carries the flame's own hue; the reference image's "white"
 * smoke samples as a warm beige. `smokeMix` lerps toward the flame colour by
 * proximity to the flame, and that single term is most of why the reference's
 * smoke sits on the orange with no visible seam between them.
 */
export const FIRE_SMOKE_RAMP = Object.freeze({
  highlight: '#F5F2EC',
  mid: '#CFC8BC',
  shadow: '#A9A198',
  sootLight: '#8A5A2E',
  sootDark: '#6E4520',
});

/**
 * Fuel presets. `wood` IS the reference image; the others expand the range
 * where the author's brief invited it ("feel free to expand the colour range
 * when dealing with other sorts of fire"). Each is a multiplier/offset set over
 * the wood ramp rather than a second hand-authored table, so a change to the
 * reference spec propagates to all four.
 */
export const FIRE_FUELS = Object.freeze({
  wood: Object.freeze({ tempGain: 1.0, sootGain: 1.0, smokeGain: 1.0, hueShift: 0.0, heightGain: 1.0 }),
  coal: Object.freeze({ tempGain: 0.88, sootGain: 1.35, smokeGain: 0.7, hueShift: -0.012, heightGain: 0.75 }),
  oil: Object.freeze({ tempGain: 1.05, sootGain: 2.4, smokeGain: 2.2, hueShift: -0.004, heightGain: 1.35 }),
  magical: Object.freeze({ tempGain: 1.15, sootGain: 0.25, smokeGain: 0.45, hueShift: 0.5, heightGain: 1.2 }),
});

/** `#rrggbb` → [r,g,b] in 0..1. Returns null on anything malformed. */
export function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The flame ramp as shader-ready `{t, rgb}` stops, hottest first. */
export function fireRampStops() {
  return FIRE_RAMP_WOOD.map((s) => ({ t: s.t, rgb: hexToRgb01(s.hex) }));
}

/**
 * The ramp's own t=0.5 "golden" stop (`#FDBA35`) — `color`'s neutral anchor.
 * ⚠️ NOT A COINCIDENCE: `FIRE_PARAMS.color`'s shipped default IS this exact
 * hex. `fireTintMul` divides the picked swatch by this reference, so at the
 * default swatch the multiplier is exactly [1,1,1] — a provable no-op against
 * the already-live-approved look — and only a genuine colour change produces
 * a non-identity multiplier.
 */
const FLAME_TINT_REFERENCE_RGB = hexToRgb01(FIRE_RAMP_WOOD[3].hex);

/**
 * `color`'s effect: a per-channel multiplier RELATIVE TO THE RAMP'S OWN
 * reference midpoint, not a raw multiply. A raw multiply by the default hex
 * (`#fdba35` ≈ 0.99/0.73/0.21) would crush blue in every channel the instant
 * this is wired live, visibly darkening the exact look already seen on Tower
 * Bridge. Dividing by that same reference makes the picked swatch scale the
 * ramp's OWN gradient/contrast shape instead of flattening it toward one flat
 * colour — "tint", not "replace".
 *
 * @param {string} hex @returns {[number,number,number]}
 */
export function fireTintMul(hex) {
  const picked = hexToRgb01(hex) ?? FLAME_TINT_REFERENCE_RGB;
  return [
    picked[0] / Math.max(1e-4, FLAME_TINT_REFERENCE_RGB[0]),
    picked[1] / Math.max(1e-4, FLAME_TINT_REFERENCE_RGB[1]),
    picked[2] / Math.max(1e-4, FLAME_TINT_REFERENCE_RGB[2]),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SCALE CHAIN — one authored knob, everything else derived
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vortex-shedding puff frequency, Cetegen & Ahmed's pool-fire correlation:
 * f ≈ 1.5 / √D with D in metres. Worth using instead of a tuned constant
 * precisely BECAUSE it cannot be tuned wrong — it lands on ~13.7 Hz for a
 * candle, ~1.7 Hz for a 0.8 m campfire and ~0.5 Hz for an 8 m inferno, all of
 * which are real measured numbers for real fires of those sizes.
 */
const PUFF_HZ_COEFF = 1.5;

/** Plume centreline rise speed, m/s ≈ 0.61·√(gD), written as 1.9·√D. */
const RISE_SPEED_COEFF = 1.9;

/**
 * Laminar → turbulent. Small diffusion flames are laminar: one smooth, steady
 * tongue. Large ones break into many independently-puffing lobes. That
 * transition is the single most convincing size cue there is, and it is real
 * physics rather than an art dial — which is why ONE smoothstep drives lobe
 * count, billow amplitude, octave count and flame-height ratio together.
 */
const TURB_D_LO = 0.05;
const TURB_D_HI = 0.7;

/** Flame height as a multiple of diameter: tall and thin when laminar, squat when turbulent. */
const HEIGHT_RATIO_LAMINAR = 4.0;
const HEIGHT_RATIO_TURB_DROP = 2.8;

/** Light radius as a multiple of fire diameter, and its clamps in world px. */
const LIGHT_RADIUS_PER_DIAMETER = 6;
const LIGHT_RADIUS_MIN_PX = 120;
const LIGHT_RADIUS_MAX_PX = 1400;

/**
 * How hard the shared wind field can push fire's cast light around — the
 * SAME 0..2 scale `effects/candle-flame.js`'s own "Wind response" param
 * defines (1 = candle's tuned baseline, 2 = "twice as dramatic"), just
 * fixed rather than author-exposed for fire today. Raised from `1` (candle
 * parity) 2026-09-03, author's own direction once the temperature ramp
 * landed and was graded a C: *"give it more of a candle like wind response
 * too... a lot more dramatic."* 1.6 sits well inside candle's own declared
 * "up to twice as dramatic" ceiling rather than inventing a new scale.
 * Read by `candleLife`'s wind-driven gutter/snuff terms
 * (`animations/candle-flicker.js`) via `buildFireLightSources`'s own
 * `windResponse` field below — the light's brightness-swing AMPLITUDE is
 * the separate `FIRE_FLICKER_SCALE` (candle-flicker.js).
 */
const FIRE_WIND_RESPONSE = 1.6;

/** Smoke production ramps in above a threshold size — a clean small flame barely smokes. */
const SMOKE_D_LO = 0.1;
const SMOKE_D_HI = 1.0;

function smoothstep01(edge0, edge1, x) {
  if (!(edge1 > edge0)) return x >= edge1 ? 1 : 0;
  const t = clampNum((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * THE ONE KNOB. Everything a fire does — how fast it puffs, how tall it stands,
 * how ragged its silhouette is, how much it smokes, how far it lights — derives
 * from its diameter, so nothing can disagree with anything else.
 *
 * `mPerPx` comes from the scene's own grid (`scene.grid.distance / grid.size`),
 * never a constant: a fire painted 500 px across is a bonfire on a 100 px/5 ft
 * map and a housefire on a 20 px/5 ft one, and the puff rate has to know.
 *
 * @param {number} diameterPx - the fire's width in world (Foundry canvas) px.
 * @param {number} mPerPx - world metres per canvas pixel.
 * @param {object} [opts]
 * @param {string} [opts.fuel='wood'] - a key of {@link FIRE_FUELS}.
 * @param {number} [opts.intensity=1] - authored 0..2 multiplier on temperature.
 * @returns {object} the derived quantities, all finite.
 */
export function fireScaleChain(diameterPx, mPerPx, { fuel = 'wood', intensity = 1 } = {}) {
  const dPx = Number.isFinite(diameterPx) && diameterPx > 0 ? diameterPx : 1;
  const mpp = Number.isFinite(mPerPx) && mPerPx > 0 ? mPerPx : 0.02;
  const f = FIRE_FUELS[fuel] ?? FIRE_FUELS.wood;
  const inten = clampNum(Number.isFinite(intensity) ? intensity : 1, 0, 2);

  const dM = dPx * mpp;
  const turb01 = smoothstep01(TURB_D_LO, TURB_D_HI, dM);
  const riseSpeedMs = RISE_SPEED_COEFF * Math.sqrt(dM);

  return {
    diameterPx: dPx,
    diameterM: dM,
    mPerPx: mpp,
    fuel: FIRE_FUELS[fuel] ? fuel : 'wood',

    /** Hz. The clock BOTH the flame shader and the cast light run on. */
    puffHz: PUFF_HZ_COEFF / Math.sqrt(Math.max(dM, 1e-4)),
    riseSpeedMs,
    /** px/s — what the shear term actually divides by. */
    riseSpeedPx: riseSpeedMs / mpp,

    turb01,
    /** More octaves once turbulent; a laminar flame has no fine structure to resolve. */
    octaves: 2 + Math.round(turb01 * 2),
    /** Billow amplitude: a clean tongue at 0.15, a full cauliflower at 0.70. */
    billowAmp: 0.15 + turb01 * 0.55,
    /** Lobe density in the noise field — a big fire has MORE lobes, not bigger ones. */
    lobeFreq: 0.5 + turb01 * 1.5,

    /** Total plume height in world px (flame + smoke column). */
    heightPx: dPx * (HEIGHT_RATIO_LAMINAR - HEIGHT_RATIO_TURB_DROP * turb01) * f.heightGain,
    /** Fraction of that height which is still incandescent flame. */
    flameFrac: clampNum(0.62 - 0.22 * turb01, 0.28, 0.8),

    /**
     * Base temperature 0..1 — how hot the core reads BEFORE fuel/intensity.
     *
     * ⚠️ MOSTLY SIZE-INDEPENDENT, DELIBERATELY. A match flame and a bonfire burn
     * at similar combustion temperatures — what actually changes with size is
     * TURBULENCE and STRUCTURE (`turb01`, already modelled), not peak heat. The
     * first version ran 0.6→0.95 across the smoothstep, which reads fine for a
     * bonfire but means every hearth-scale fire (0.3-1m — what's actually
     * painted on a real map) topped out around 0.6-0.7 and NEVER reached the
     * ramp's hot/pale-core stop. Author, live, 2026-08-08: "there is no hot
     * whiter center." A small, mostly-flat baseline fixes it for the sizes that
     * matter; the residual smoothstep is a small extra push for a genuine
     * inferno, not the thing carrying "is this hot at all."
     */
    baseTemp: clampNum((0.88 + 0.1 * smoothstep01(0.0, 2.0, dM)) * f.tempGain * inten, 0, 1),

    /**
     * ⚠️ TWO NUMBERS, BECAUSE THEY ANSWER TWO QUESTIONS
     * (`feedback_one_byte_two_quantities`). The first version multiplied the
     * fuel's `smokeGain` into a single 0..1 `smoke01` and clamped — which made
     * every fuel identical for any fire over ~1 m, because the smoothstep had
     * already saturated and the clamp ate the gain. Oil and wood smoked exactly
     * the same, and the test that caught it was checking the wrong field for
     * the right reason.
     *
     *   `smoke01`      — HOW MUCH OF THE PLUME is smoke rather than flame. A
     *                    SHAPE question, strictly 0..1, drives `smokeMix` and
     *                    the slice table's regime split.
     *   `smokeDensity` — HOW THICK that smoke is. An OPACITY question, allowed
     *                    past 1 (oil billows black), drives absorption/alpha.
     */
    smoke01: clampNum(smoothstep01(SMOKE_D_LO, SMOKE_D_HI, dM), 0, 1),
    smokeDensity: clampNum(smoothstep01(SMOKE_D_LO, SMOKE_D_HI, dM) * f.smokeGain, 0, 3),

    soot01: clampNum((0.15 + 0.5 * turb01) * f.sootGain, 0, 2),
    hueShift: f.hueShift,

    lightRadiusPx: clampNum(dPx * LIGHT_RADIUS_PER_DIAMETER, LIGHT_RADIUS_MIN_PX, LIGHT_RADIUS_MAX_PX),
    /**
     * Flicker amplitude FALLS with size, and that is physics rather than taste:
     * a big fire is many independent lobes whose brightnesses average out, so
     * its light breathes slowly and shallowly while a candle guts hard.
     */
    flickerAmp: clampNum(0.42 - 0.3 * turb01, 0.08, 0.45),
    /**
     * Wind speed at which this fire starts to blow out, scaled by size — a
     * candle gutters in a breeze, a bonfire does not. Consumed by both the
     * shader and the light so they snuff together.
     */
    snuffWind: 1.2 + 6.5 * Math.sqrt(dM),
  };
}

/**
 * ⚠️ ORPHANED, 2026-08-09 — KEPT FOR ITS OWN TESTED PHYSICS, NOT CALLED LIVE.
 * This pair was "the shared clock": called once per fire per frame on the CPU
 * to drive the cast light, and once per fragment on the GPU to drive the
 * flame's own puff, so the two flickered in lockstep. Both halves of that are
 * now gone. The GPU half died when the particle rebuild replaced the single
 * puffing volumetric material with independent per-particle sprites
 * (`fire-sprite.js` drives colour off per-particle age, never a shared phase);
 * the CPU half is removed by THIS commit, because reusing `candle-flicker.js`'s
 * wind-aware noise for the light (see `registry.js`'s `firePuff` entry) means
 * the light's moment-to-moment flicker is the GPU's job now, and baking a
 * second, unrelated pulse in here would double it. `fireScaleChain`'s
 * `puffHz`/`flickerAmp` fields are real V2-derived physics with their own
 * tests below and are left in place; these two functions are left in place
 * alongside them for the same reason, and are candidates for deletion
 * together with `fire-render.js` once that volumetric fossil is finally
 * removed (`the-fire-effect-was-nested-sketch.md`'s own deferred step).
 *
 * ⚠️ Lockstep, when this was live, came from calling one function, NOT from
 * sharing a GPU node. `candle-flicker.js` does the analogous thing against
 * `candle-flame-render.js`'s constants (still live there) — the light is a
 * separate mesh in a separate pool built from CPU-side descriptors, so there
 * is no node to share; two implementations of one formula would drift the
 * first time either was tuned.
 *
 * @param {number} tMs - `env.time.tMs`. NEVER `performance.now()` (time/one-clock).
 * @param {number} puffHz - from {@link fireScaleChain}.
 * @param {number} seed - a stable per-fire phase offset, so neighbours desync.
 * @returns {number} phase in turns; `sin(2π·phase)` is the puff.
 */
export function firePuffPhase(tMs, puffHz, seed) {
  const t = Number.isFinite(tMs) ? tMs / 1000 : 0;
  const hz = Number.isFinite(puffHz) && puffHz > 0 ? puffHz : 1;
  const s = Number.isFinite(seed) ? seed : 0;
  return t * hz + s;
}

/**
 * The 0..1 brightness envelope a fire's light rides, from the same phase the
 * flame uses. Three incommensurate harmonics so it never reads as a sine — the
 * same chaos-sum shape V2's glow flicker used, kept because it worked.
 *
 * @param {number} phase - from {@link firePuffPhase}.
 * @param {number} flickerAmp - from {@link fireScaleChain}.
 * @returns {number} a multiplier around 1, floored so a fire never goes black.
 */
export function firePuffEnvelope(phase, flickerAmp) {
  const p = Number.isFinite(phase) ? phase : 0;
  const amp = clampNum(Number.isFinite(flickerAmp) ? flickerAmp : 0.3, 0, 1);
  const TAU = Math.PI * 2;
  const chaos =
    0.55 * Math.sin(TAU * p) + 0.3 * Math.sin(TAU * (p * 1.73 + 0.37)) + 0.15 * Math.sin(TAU * (p * 2.91 + 0.11));
  return Math.max(0.12, 1 + amp * chaos);
}

// ─────────────────────────────────────────────────────────────────────────────
// TIERS AND COVERAGE — two independent axes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The rungs, as data, index === tier. `sheets` (M) is the expensive axis;
 * `maxSlices` (N) is capped again by coverage at runtime.
 *
 * ⚠️ `estMsPerMp` in the MANIFEST must stay consistent with `sheets` here:
 * measured cost is `M × 0.1323 + N × ~0.004` ms/Mpx.
 *
 * `spriteCountScale` ADDED 2026-08-30 (Effect-Tier-Gradient-Audit-2026-08-29.md
 * round 2's own "fire's 3rd unused lever" finding) — a THIRD real, live axis
 * alongside `clusterFactor`/the puff-clock's `animation.quality`. Multiplies
 * `fire-subsystem.js`'s own `activeCount` (the flame/ember/smoke particle
 * budget PER FIRE, `PER_FIRE`'s own values) — the sprite layer's dominant
 * per-frame cost, and until now the one thing about fire that never varied
 * by profile at all. 1.0 at `standard` and above, matching `PER_FIRE`
 * exactly — those three rungs are BYTE-IDENTICAL to before this lever
 * existed, the same "only low/performance move" discipline every other
 * effect's tier gradient in this audit follows (`clusterFactor`'s own ramp
 * predates this session and is a DIFFERENT case — already shipped, already
 * live at every rung, not something newly introduced here). Ramped rather
 * than binary below `standard`, mirroring `precipTierScaleForProfile`'s own
 * 3-step shape (`precip-species.js`) — sparser fire at `low`, not absent
 * fire.
 */
const FIRE_TIER_PLANS = Object.freeze([
  Object.freeze({
    sheets: 0,
    maxSlices: 1,
    octaveCap: 0,
    bands: 4,
    smoke: false,
    shear: false,
    clusterFactor: 2.0,
    spriteCountScale: 0.35,
  }),
  Object.freeze({
    sheets: 1,
    maxSlices: 3,
    octaveCap: 3,
    bands: 5,
    smoke: false,
    shear: false,
    clusterFactor: 1.5,
    spriteCountScale: 0.6,
  }),
  Object.freeze({
    sheets: 2,
    maxSlices: 6,
    octaveCap: 3,
    bands: 6,
    smoke: false,
    shear: true,
    clusterFactor: 1.0,
    spriteCountScale: 0.8,
  }),
  Object.freeze({
    sheets: 3,
    maxSlices: 10,
    octaveCap: 4,
    bands: 7,
    smoke: true,
    shear: true,
    clusterFactor: 0.6,
    spriteCountScale: 1.0,
  }),
  Object.freeze({
    sheets: 3,
    maxSlices: 10,
    octaveCap: 4,
    bands: 8,
    smoke: true,
    shear: true,
    clusterFactor: 0.5,
    spriteCountScale: 1.0,
  }),
  Object.freeze({
    sheets: 4,
    maxSlices: 14,
    octaveCap: 4,
    bands: 9,
    smoke: true,
    shear: true,
    clusterFactor: 0.35,
    spriteCountScale: 1.0,
  }),
]);

/**
 * The rung an ABSENT or malformed tier falls back to.
 *
 * ⚠️ NOT a hardcoded 3 — the test suite asserts this equals what the DEFAULT
 * performance profile resolves the real fire ladder to, so re-tuning a rung's
 * `fromProfile` cannot leave this constant behind pointing at a different look.
 * Same defence `CANDLE_DEFAULT_TIER` carries, and for the same reason
 * (`feedback_seam_default_hides_unwired`).
 */
export const FIRE_DEFAULT_TIER = 3;

/** @param {number} tier @returns {object} the plan for a rung that exists. */
export function fireTierPlan(tier) {
  const n = Number.isFinite(tier) ? clampNum(Math.floor(tier), 0, FIRE_TIER_PLANS.length - 1) : FIRE_DEFAULT_TIER;
  return FIRE_TIER_PLANS[n];
}

/** Slice counts per coverage rung — the second axis, independent of tier. */
const COVERAGE_SLICES = Object.freeze([1, 2, 6, 10]);
/** Screen-pixel coverage boundaries between those rungs. */
const COVERAGE_EDGES = Object.freeze([256, 16_000, 400_000]);
/** ±35% dead-band around every edge, because a rung change is a pipeline swap. */
const COVERAGE_HYSTERESIS = 0.35;
/** Minimum ms a rung must be held before another change is allowed. */
const COVERAGE_DWELL_MS = 500;

/**
 * Screen-pixel coverage of one fire, which is the input Law 7 has always
 * wanted and nothing has ever computed (`Effects.md` step 4, declared and
 * never built — this is its first consumer).
 *
 * @param {number} quadSizePx - the fire quad's world-space side length.
 * @param {number} worldPxPerScreenPx - camera frustum width ÷ viewport width.
 * @returns {number} approximate covered screen pixels.
 */
export function fireCoveragePx(quadSizePx, worldPxPerScreenPx) {
  const q = Number.isFinite(quadSizePx) && quadSizePx > 0 ? quadSizePx : 0;
  const s = Number.isFinite(worldPxPerScreenPx) && worldPxPerScreenPx > 0 ? worldPxPerScreenPx : 1;
  // The plume is round-ish inside its square quad, hence π/4.
  return (Math.PI / 4) * (q / s) ** 2;
}

/**
 * Resolve a coverage rung WITH HYSTERESIS AND DWELL.
 *
 * ⚠️ This is not polish. `N` is a build-time constant (`tsl/no-uniform-gates`,
 * and a uniform trip count would not remove the work anyway — Law 4), so every
 * rung change is a MATERIAL REBUILD. A fire sitting exactly on a boundary while
 * the GM nudges the zoom would recompile every frame. The dead band makes an
 * oscillation impossible and the dwell makes a fast zoom cost one rebuild
 * rather than four.
 *
 * @param {number} coveragePx @param {object} [prev] - `{rung, sinceMs}` from last frame.
 * @param {number} [nowMs] - `env.time.tMs`.
 * @returns {{rung: number, slices: number, changed: boolean, sinceMs: number}}
 */
export function resolveFireCoverageRung(coveragePx, prev = null, nowMs = 0) {
  const cov = Number.isFinite(coveragePx) && coveragePx > 0 ? coveragePx : 0;
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  const prevRung = Number.isFinite(prev?.rung) ? clampNum(Math.floor(prev.rung), 0, COVERAGE_SLICES.length - 1) : null;
  const prevSince = Number.isFinite(prev?.sinceMs) ? prev.sinceMs : now;

  // The rung coverage alone would pick, with no memory.
  let raw = 0;
  while (raw < COVERAGE_EDGES.length && cov >= COVERAGE_EDGES[raw]) raw++;

  if (prevRung === null) return { rung: raw, slices: COVERAGE_SLICES[raw], changed: true, sinceMs: now };
  if (raw === prevRung)
    return { rung: prevRung, slices: COVERAGE_SLICES[prevRung], changed: false, sinceMs: prevSince };

  // Moving UP needs coverage past edge×(1+h); moving DOWN needs it below
  // edge×(1−h). Between those, the previous rung stands.
  const edge = COVERAGE_EDGES[raw > prevRung ? prevRung : raw];
  const passed = raw > prevRung ? cov >= edge * (1 + COVERAGE_HYSTERESIS) : cov <= edge * (1 - COVERAGE_HYSTERESIS);
  if (!passed || now - prevSince < COVERAGE_DWELL_MS) {
    return { rung: prevRung, slices: COVERAGE_SLICES[prevRung], changed: false, sinceMs: prevSince };
  }
  // One rung at a time, so a hard zoom walks the ladder instead of jumping it.
  const next = clampNum(prevRung + Math.sign(raw - prevRung), 0, COVERAGE_SLICES.length - 1);
  return { rung: next, slices: COVERAGE_SLICES[next], changed: true, sinceMs: now };
}

/**
 * The compiled shape of one fire material: how many noise sheets, how many
 * composite slices, how many octaves, which terms exist at all.
 *
 * Every field is consumed by a JS-time `if` in `fire-render.js` — never a
 * uniform. Law 4: if turning a feature off does not shrink the compiled shader,
 * it is not off.
 *
 * @param {number} tier @param {number} coverageRung
 * @returns {{M:number,N:number,octaves:number,bands:number,hasSmoke:boolean,hasShear:boolean,key:string}}
 */
export function fireSlabPlan(tier, coverageRung) {
  const plan = fireTierPlan(tier);
  const rung = Number.isFinite(coverageRung) ? clampNum(Math.floor(coverageRung), 0, COVERAGE_SLICES.length - 1) : 3;
  const N = Math.min(plan.maxSlices, COVERAGE_SLICES[rung]);
  // Sheets can never exceed slices — a sheet no slice reads is pure waste.
  const M = Math.min(plan.sheets, N);
  const hasSmoke = plan.smoke && N >= 4;
  return {
    M,
    N,
    octaves: plan.octaveCap,
    bands: plan.bands,
    hasSmoke,
    hasShear: plan.shear && N >= 2,
    // The material-variant cache key. Anything that changes the GRAPH must
    // appear here or a stale pipeline gets reused for a different shape.
    key: `t${Math.min(tier ?? FIRE_DEFAULT_TIER, FIRE_TIER_PLANS.length - 1)}_r${rung}_M${M}_N${N}_o${plan.octaveCap}_b${plan.bands}_s${hasSmoke ? 1 : 0}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SLICE TABLE — per-slice scalars, all constant-folded into the shader
// ─────────────────────────────────────────────────────────────────────────────

/** How far the noise field decorrelates per unit of normalized height. */
const VERTICAL_DECORRELATION = 1.8;
/** Plume radius at the fuel bed / at the flame tip / at the top of the smoke, ×(D/2). */
const RADIUS_AT_BASE = 1.0;
const RADIUS_AT_TIP = 0.34;
/**
 * ⚠️ A real plume keeps entraining air and spreading indefinitely; the VISIBLE
 * smoke in the reference image does not, and 2.1 rendered a grey halo three
 * times the width of the fire that dominated every frame. What a viewer reads
 * as "the smoke off this fire" is the dense near-field, not the whole dispersing
 * column — the far field is thin enough to be invisible against a map. 1.35
 * keeps the crown proportionate to the flame, which is what the reference shows.
 */
const RADIUS_AT_SMOKE_TOP = 1.35;

/**
 * Build the per-slice scalar geometry, TOP SLICE FIRST.
 *
 * ⚠️ ORDER IS LOAD-BEARING AND IT IS TOP-DOWN. The camera is above the fire, so
 * front-to-back compositing means the HIGHEST slice is composited FIRST and
 * occludes everything below it. That is not an implementation detail — it is
 * the mechanism that makes cool smoke partially hide the hot core, which is the
 * reference image's entire structure. Emitting this table bottom-up would
 * produce a picture with the smoke BEHIND the flame and no amount of tuning
 * would recover it.
 *
 * @param {object} plan - from {@link fireSlabPlan}.
 * @param {object} chain - from {@link fireScaleChain}.
 * @returns {Array<object>} N entries, index 0 = highest.
 */
export function fireSliceTable(plan, chain) {
  const N = Math.max(1, Math.floor(plan?.N ?? 1));
  const M = Math.max(1, Math.floor(plan?.M ?? 1));
  const flameFrac = clampNum(chain?.flameFrac ?? 0.5, 0.05, 0.95);
  const billowAmp = chain?.billowAmp ?? 0.4;
  const baseTemp = chain?.baseTemp ?? 0.8;
  // Two questions, two numbers — see `fireScaleChain`'s own note. `smoke01`
  // decides WHERE the smoke regime starts; `smokeDensity` decides how hard it
  // occludes once it does.
  const smoke01 = plan?.hasSmoke ? (chain?.smoke01 ?? 0) : 0;
  const smokeDensity = plan?.hasSmoke ? (chain?.smokeDensity ?? 0) : 0;

  const out = [];
  for (let k = 0; k < N; k++) {
    // TOP FIRST: k=0 is the highest slice. See this function's header.
    //
    // ⚠️ THE BOTTOM SLICE SITS AT EXACTLY h = 0, and that is load-bearing.
    // The old spacing `1 − (k + 0.5)/N` put the lowest slice at h = 0.05, so it
    // carried 5% of the wind shear — and since the BRIGHT flame slices live in
    // the bottom third, the whole fire (root included) slid sideways with the
    // gust. Author, 2026-08-08, seeing it live: *"the entire effect is parented
    // to a single spot... fire shouldn't wobble sideways like this."* A fire's
    // base is welded to its fuel. Only what has left the fuel may lean.
    const h = N === 1 ? flameFrac * 0.5 : 1 - k / (N - 1);

    // Radius: the FLAME tapers to a tip, then the SMOKE column spreads as it
    // entrains air. Two regimes, and the kink between them at `flameFrac` is
    // what reads as a flame with a crown rather than a single cone.
    const inFlame = h <= flameFrac;
    const radius01 = inFlame
      ? RADIUS_AT_BASE + (RADIUS_AT_TIP - RADIUS_AT_BASE) * (h / flameFrac)
      : RADIUS_AT_TIP + (RADIUS_AT_SMOKE_TOP - RADIUS_AT_TIP) * ((h - flameFrac) / (1 - flameFrac));

    // Temperature: near-constant through the flame, falling off a cliff at the
    // tip, then cooling slowly through the smoke.
    const temp = inFlame
      ? baseTemp * (1 - 0.25 * (h / flameFrac) ** 2)
      : baseTemp * 0.55 * (1 - (h - flameFrac) / (1 - flameFrac)) ** 1.5;

    // Which of the M sheets this slice reads. Sheets sit at (m+0.5)/M.
    const sheetPos = clampNum(h * M - 0.5, 0, M - 1);
    const sheetLo = Math.floor(sheetPos);

    out.push({
      k,
      /** Normalized height 0..1 (0 = fuel bed, 1 = top of the plume). */
      hK: Number(h.toFixed(5)),
      /** Radius at this height, as a multiple of the fire's own half-width. */
      radiusK: Number(radius01.toFixed(5)),
      /**
       * Billow amplitude — bigger higher up, where the plume has entrained more
       * air, but CAPPED in the smoke regime. Unclamped it reached ~0.88 on the
       * top slices and the billow fold turned the plume edge into lace: dozens
       * of thin tendrils rather than the reference image's fat rounded lobes.
       * Displacement above roughly half the radius stops reading as a lobe.
       *
       * ⚠️ CAPS RAISED 0.30/0.24 → 0.62/0.48, 2026-08-09, REVERSING THE PREVIOUS
       * DAY'S CHANGE, WHICH WAS AN OVERCORRECTION IN THE WRONG VARIABLE. The
       * author reported a spiky silhouette; the response was to raise lobe
       * FREQUENCY and cut AMPLITUDE together. That is the recipe for a circle
       * with a fuzzy edge, and it is exactly what rendered: displacement capped
       * at 30% of the radius cannot make a non-circular shape no matter what
       * the noise does, so the fire read as *"a circle, why is it a circle?"*
       *
       * Spikiness is a FREQUENCY property (thin tendrils are high octaves on a
       * displacement term — that is what `BILLOW_DIMINISH` suppresses), not an
       * amplitude one. Big rounded cauliflower lobes need the opposite pairing:
       * LOW frequency, LARGE amplitude, low diminish. Amplitude alone can never
       * make an edge spiky; it only makes the existing lobe shapes bigger.
       */
      ampK: Number(Math.min(billowAmp * (0.45 + 0.55 * h), inFlame ? 0.62 : 0.48).toFixed(5)),
      /**
       * Edge softness AS A FRACTION OF THIS SLICE'S OWN RADIUS — smoke edges
       * are far softer than flame edges.
       *
       * ⚠️ Not a fraction of the quad. The first version's numbers were read as
       * quad fractions by the material, so the top smoke slice's softness
       * became 360 px of gradient on a 292 px blob: the entire volume was one
       * soft edge, nothing had a silhouette, and the posterized bands had
       * nothing to land on. Softness has to scale with the thing it softens.
       */
      softK: Number((0.06 + 0.1 * h + (inFlame ? 0 : 0.14)).toFixed(5)),
      /** Temperature feeding the posterized ramp. */
      tempK: Number(clampNum(temp, 0, 1).toFixed(5)),
      /** How much this slice occludes what is behind (below) it. Smoke occludes hard. */
      absorbK: Number(clampNum(inFlame ? 0.28 : 0.4 + 0.25 * smokeDensity, 0, 0.95).toFixed(5)),
      /** 0 = pure flame ramp, 1 = pure smoke ramp. */
      smokeMix: Number((inFlame ? 0 : smoke01 * smoothstep01(flameFrac, Math.min(flameFrac + 0.25, 1), h)).toFixed(5)),
      /**
       * Downwind offset multiplier — QUADRATIC in height, not linear.
       *
       * The naive reading of "shear = wind × time-of-flight" is linear in h,
       * and it is wrong near the fuel: a parcel leaving the bed is
       * momentum-dominated and moving almost straight up, so it has barely
       * begun to be pushed. It only acquires the wind's horizontal velocity as
       * it decelerates vertically. Squaring pins the base hard while leaving
       * the top's lean untouched, which is both closer to a real plume and the
       * fix for the whole-fire wobble the author caught live (see the `h`
       * calculation above).
       */
      shearK: Number((plan?.hasShear ? h * h : 0).toFixed(5)),
      sheetLo,
      sheetHi: Math.min(sheetLo + 1, M - 1),
      sheetBlend: Number((sheetPos - sheetLo).toFixed(5)),
      /** This slice's own noise z-offset, so the field is vertically coherent. */
      zOffset: Number((h * VERTICAL_DECORRELATION).toFixed(5)),
    });
  }
  return out;
}

/**
 * THE SHEAR, WHICH COSTS ZERO ART CONSTANTS.
 *
 * A parcel at normalized height h has been rising for `h·heightPx / riseSpeedPx`
 * seconds, and the wind has been pushing it sideways the whole time. So its
 * downwind offset is simply wind × time-of-flight — two quantities the scale
 * chain already produces, with nothing to tune between them. This is why a
 * top-down fire reads as flame with smoke streaming off one side, and why it
 * gets longer in a gale without anybody authoring that.
 *
 * @param {number} hK @param {number} heightPx @param {number} riseSpeedPx
 * @returns {number} multiply the wind vector (px/s) by this to get px of offset.
 */
export function fireShearSeconds(hK, heightPx, riseSpeedPx) {
  const h = clampNum(Number.isFinite(hK) ? hK : 0, 0, 1);
  const hp = Number.isFinite(heightPx) && heightPx > 0 ? heightPx : 0;
  const rs = Number.isFinite(riseSpeedPx) && riseSpeedPx > 0 ? riseSpeedPx : 1;
  return (h * hp) / rs;
}

// ─────────────────────────────────────────────────────────────────────────────
// WEATHER — per-fire scalars, never per-pixel and never per-particle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold weather and wind into the scale chain's own terms.
 *
 * ⚠️ ORPHANED FROM THE LIGHT, 2026-09-04 — KEPT FOR ITS OWN TESTED PHYSICS
 * (`tempScale`/`heightScale`/`smokeScale`/`whiteness` were never live-consumed
 * downstream of ANY caller to begin with — only the orphaned volumetric
 * `fire-render.js` reads them), NOT CALLED LIVE FOR `alive01` ANY MORE either.
 * `buildFireLightSources` used to read this function's `alive01` for the
 * cast light's own wind-dimming; that reached a hard 0 (fully blown out) via
 * a formula the live PARTICLE sprite count never agreed with, which is
 * exactly why an author watching both at once saw the light "far too
 * strong" relative to what the flame body itself was doing. It now reads
 * `fireWindMotion01`/`fireWindParticleResponse`'s `flameActiveCountMul`
 * instead — the SAME fraction that sizes the flame sprite population — so
 * the two can no longer disagree. This function's own bellows/snuff physics
 * are real V2-derived work with their own tests below and are left in place
 * for the same reason `firePuffPhase`/`firePuffEnvelope` are (this file's
 * own note on that pair, above).
 *
 * ⚠️ ONE SCALAR PER FIRE PER FRAME. V2 sampled weather PER PARTICLE at spawn
 * (`fire-behaviors.js#applyFireParticleWorldSpawn`) and paid for it with a
 * rotating 1-in-5 slice that traded correctness for frame time. There is
 * nothing here a fragment or a particle needs to re-derive.
 *
 * Rain makes a fire cooler, shorter and much whiter (steam is white smoke);
 * wind below the snuff threshold makes it HOTTER (bellows) and shorter; wind
 * above it puts the fire out.
 *
 * ⚠️ RAIN AND WIND ARE GATED BY DIFFERENT THINGS, DELIBERATELY. Rain is gated
 * by `outdoors01` (the `_Outdoors` mask — is there a roof over this fire).
 * Wind is gated by `windExposure` (the wind bake's own openness — can moving
 * air reach it). They are NOT the same question and collapsing them would lose
 * a feature the candle already ships: "candles in a drafty castle" (Wind.md §6)
 * is precisely a fire that is indoors, takes no rain, and still gutters in a
 * draft. A caller that wants a sealed room must pass BOTH as 0; passing
 * `outdoors01 = 0` alone describes a covered but open-sided space, which is a
 * real and different place.
 *
 * @param {object} chain - from {@link fireScaleChain}.
 * @param {object} env - `{weather:{precip01}, wind:{speed01}}`.
 * @param {number} outdoors01 - 1 under open sky, 0 under a roof. Gates RAIN only.
 * @param {number} [windExposure=1] - openness to moving air. Gates WIND only.
 * @returns {{tempScale:number, heightScale:number, smokeScale:number, whiteness:number, alive01:number}}
 */
export function fireWeatherResponse(chain, env, outdoors01, windExposure = 1) {
  const out = clampNum(Number.isFinite(outdoors01) ? outdoors01 : 1, 0, 1);
  const expo = clampNum(Number.isFinite(windExposure) ? windExposure : 1, 0, 1);
  const precip = clampNum(Number(env?.weather?.precip01) || 0, 0, 1) * out;
  const windRaw = (Number(env?.wind?.speed01) || 0) * 10 * expo;
  const snuff = chain?.snuffWind ?? 4;

  // Bellows below the threshold, blown out above it. `smoothstep` on both ends
  // so a gust ramps the fire up before it starts killing it.
  const bellows = smoothstep01(0, snuff * 0.6, windRaw);
  const alive01 = 1 - smoothstep01(snuff, snuff * 1.6, windRaw);

  return {
    tempScale: clampNum(1 + 0.22 * bellows - 0.45 * precip, 0.2, 1.4),
    heightScale: clampNum(1 - 0.3 * bellows - 0.35 * precip, 0.25, 1),
    smokeScale: clampNum(1 + 1.8 * precip, 1, 3),
    /** Steam is white — rain shifts the smoke ramp toward the highlight. */
    whiteness: clampNum(precip * 0.85, 0, 1),
    alive01: clampNum(alive01, 0, 1),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIGHTS — the thing that actually costs, so the thing tiered hardest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grid-bucket fire sources into clusters. Deterministic (same sources → same
 * clusters, stable order via a sorted-id key), O(N), so it is cheap per frame
 * and the resulting `sourceId`s are stable enough for the light pool to REUSE
 * meshes across frames instead of rebuilding them.
 *
 * ⚠️ THIS IS THE BUDGET LEVER, NOT THE SHADER. Measured on candles
 * (`Performance-Insights.md`): every flame billboard in a scene cost 0.022 ms
 * while the lights cost 13.1 ms of a 20.4 ms frame across 91 draw calls,
 * because a 24 px billboard covers ~576 px² against a 400 px-radius light's
 * ~785,000, drawn twice — roughly 1,363×. Fire's radii are LARGER. Cell area
 * goes as `clusterFactor²`, so tier 0's 2.0 merges 16× harder than tier 4's 0.5.
 *
 * @param {Array<object>} sources - `{id,x,y,diameterPx,intensity,elevation,windExposure}`.
 * @param {number} cellPx
 * @returns {Array<object>} cluster centroids.
 */
export function clusterFireSources(sources, cellPx) {
  const list = Array.isArray(sources) ? sources : [];
  const size = Number.isFinite(cellPx) && cellPx > 0 ? cellPx : 1;
  const cells = new Map();

  for (const s of list) {
    const x = Number(s?.x);
    const y = Number(s?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = Number.isFinite(s?.diameterPx) && s.diameterPx > 0 ? s.diameterPx : 1;
    const key = `${Math.floor(x / size)}:${Math.floor(y / size)}`;
    let c = cells.get(key);
    if (!c) {
      c = { xw: 0, yw: 0, w: 0, count: 0, ids: [], area: 0, intensity: 0, elevation: 0, exposure: 0 };
      cells.set(key, c);
    }
    // Weight the centroid by AREA, not by count: a bonfire beside three embers
    // should put the light on the bonfire.
    const w = d * d;
    c.xw += x * w;
    c.yw += y * w;
    c.w += w;
    c.area += w;
    c.count++;
    c.intensity += Number.isFinite(s?.intensity) ? s.intensity : 1;
    c.elevation += Number.isFinite(s?.elevation) ? s.elevation : 0;
    c.exposure += Number.isFinite(s?.windExposure) ? s.windExposure : 1;
    if (s?.id) c.ids.push(String(s.id));
  }

  const out = [];
  for (const c of cells.values()) {
    if (!(c.w > 0)) continue;
    const x = c.xw / c.w;
    const y = c.yw / c.w;
    out.push({
      x,
      y,
      count: c.count,
      // Stable across frames, and independent of iteration order.
      id: c.ids.length ? [...c.ids].sort().join('+') : `${Math.round(x)}_${Math.round(y)}`,
      // The cluster burns as one fire of the COMBINED area — √Σd² , not Σd.
      // Two 100 px fires read as one ~141 px fire, never a 200 px one.
      diameterPx: Math.sqrt(c.area),
      intensity: c.intensity / c.count,
      elevation: c.elevation / c.count,
      exposure: c.exposure / c.count,
    });
  }
  // Sorted so the descriptor list itself is deterministic frame to frame.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * A fire light's polygon, before the viewer's wall clipping trims it.
 *
 * ⚠️ FLAT `[x0, y0, x1, y1, …]`, NEVER `[{x, y}, …]`, AND THAT IS THE WHOLE
 * REASON FIRE CAST NO LIGHT FOR TWO DAYS. This is Foundry's own
 * `PointSourcePolygon#points` format, and every other producer in the codebase
 * emits it — `scene-lights.js`, `scene-wall-clip.js`, `candle-flame-geometry.js`
 * and `lightning-geometry.js` all write `pts[i*2] = x; pts[i*2+1] = y`. The
 * consumer, `point-light-illumination.js#normalizeLightPolygon`, does:
 *
 *     lx[i] = (shapePoints[i * 2] - originX) * inv;
 *
 * Hand it objects and that is `{x,y} - number` → **NaN**, stored without
 * complaint into a `Float64Array`, rasterized into triangles the GPU silently
 * discards. The mesh is created, reconciled, and marked visible every frame; it
 * simply draws nothing. No throw, no warning, and `getPointLightsInfo`'s own
 * `activeCount` still counts it as active — which is exactly why this survived
 * a field-by-field review of the descriptor.
 *
 * ⚠️ AND THE HEADER ABOVE `buildFireLightSources` SAID IT MATCHED THE CANDLE
 * "EXACTLY". It did — on all seventeen field NAMES. The type of the contents of
 * one of them was the entire bug (`feedback_read_the_producer_never_invent_its_
 * shape`: the shape of a value is not its key list).
 *
 * ⚠️ RETURNS NULL RATHER THAN A NaN POLYGON. Author-reported live, 2026-08-08:
 * a stream of `THREE.BufferGeometry.computeBoundingSphere(): Computed radius is
 * NaN` out of `runLightAccumulatePass`. ONE non-finite vertex poisons a whole
 * batched geometry — every healthy light in the same buffer stops drawing and
 * the console fills every frame. Refusing to build the polygon at all means the
 * caller drops that one light and everything else survives.
 *
 * @returns {number[]|null} flat pairs, length `segments * 2`.
 */
function fireCirclePolygon(cx, cy, radius, segments = 32) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius) || radius <= 0) return null;
  const pts = new Array(segments * 2);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts[i * 2] = cx + Math.cos(a) * radius;
    pts[i * 2 + 1] = cy + Math.sin(a) * radius;
  }
  return pts;
}

/** A stable [0,1000) pseudo-seed from a world position, so neighbours desync. */
export function deriveFireSeed(x, y) {
  const v = Math.sin(x * 0.0173 + y * 0.0237) * 43758.5453;
  return Math.floor((v - Math.floor(v)) * 1000);
}

/**
 * Build the light-source descriptors for a set of fires.
 *
 * The shape matches `candle-flame-geometry.js#buildOneLightSource` exactly, so
 * the viewer's existing pool needs no new branch — a fire light is just another
 * authored point light, and it inherits region-aware ambient, the soft edge,
 * coloration and MAX-blending for free.
 *
 * ⚠️ WALL CLIPPING WAS NOT ACTUALLY FREE — this header claimed it was for
 * some time, and it was wrong. `shapePoints` below (`fireCirclePolygon`) is a
 * bare, unclipped circle; unlike candle/lightning, nothing in `point-light-
 * pool.js` ever replaced it with a real wall-aware shape until 2026-08-15
 * (`fireWallClipCache`, mirroring the candle fix's own `computeCandleWall
 * ClippedShape` call) — every fire near or inside a building bled its light
 * straight through every surrounding wall, unconditionally, until that fix.
 * A light DOES now get wall-clipped, but it happens entirely on the point-
 * light-pool.js side, keyed on `sourceId`/`radius`/the receiving floor — this
 * builder still hands back a naive circle every frame, same as before; it is
 * simply no longer the shape that ends up on screen once a wall stands
 * between the fire and a receiver.
 *
 * ⚠️ THE BASELINE IS DELIBERATELY STABLE ACROSS FRAMES, MATCHING CANDLE'S OWN
 * SPLIT. `luminosity01`/`alpha01` used to bake a live per-frame pulse from
 * `firePuffPhase`/`firePuffEnvelope` (`fireCirclePolygon`'s neighbour above —
 * see its own note on why that pairing is now orphaned). Since fire's light now
 * animates through `candleFlicker`'s own wind-aware noise (`registry.js`'s
 * `firePuff` entry, 2026-08-09, author: *"adjust fire light to work more like
 * candle light"*), that GPU animation supplies 100% of the moment-to-moment
 * flicker — exactly how `candleClusterLightParams` computes candle's OWN
 * baseline once per cluster with no live phase in it at all. Baking a second,
 * independent pulse in here would double it: one rhythm from this function, an
 * unrelated one from the shader. `alive01` stays — a fire dimming or guttering
 * in a gale is a real state change, not decoration, and candle's own baseline
 * responds to its analogous input (`strength`) the same way. `alive01` itself
 * changed source 2026-09-04 — see this function's own body for why.
 *
 * ⚠️ `ownerEffectId` IS SET, unlike the candle's. `light.drawPointLights` and
 * `light.drawColoration` currently bill to NOBODY, which is precisely why
 * candles' 13.1 ms went unnoticed for as long as it did
 * (`Performance-Insights.md` §5B). Fire's radii are bigger; it does not get to
 * repeat that.
 *
 * @param {Array<object>} sources @param {object} opts
 * @param {number} [opts.radiusScale=1] - the "Light reach" param
 *   (`fireRuntimeFromParams().lightRadiusScale`'s already-clamped effect).
 *   ⚠️ MUST BE PASSED BY THE CALLER OR THE SLIDER IS INERT: `fireRuntimeFromParams`
 *   computed `lightRadiusPx` with this applied and nothing ever read it, while
 *   this builder used the raw chain value — so the control labelled "the single
 *   most expensive number in the effect" moved and changed nothing. It passed
 *   `params/no-dead-controls` the whole time, because that wall checks the param
 *   is READ somewhere, not that the value it produces is USED
 *   (`feedback_unconsumed_api_rots_silently`).
 * @param {number} [opts.windSpeed01=0] - `windHandle.ambient.speed01`'s
 *   current `.value` — see {@link fireWindMotion01}.
 * @param {number} [opts.windResponseGain=1] - `FIRE_PARAMS.windResponse`, 0..2.
 * @param {number} [opts.weatherResponse01=1] - `FIRE_PARAMS.weatherResponse`, 0..1.
 * @param {boolean} [opts.canBeSnuffed=true] - `FIRE_PARAMS.canBeSnuffed`.
 * @returns {Array<object>} light descriptors.
 */
export function buildFireLightSources(
  sources,
  {
    tier,
    mPerPx,
    colorHex = null,
    radiusScale = 1,
    windSpeed01 = 0,
    windResponseGain = 1,
    weatherResponse01 = 1,
    canBeSnuffed = true,
  } = {}
) {
  const plan = fireTierPlan(tier);
  const list = Array.isArray(sources) ? sources : [];
  if (list.length === 0) return [];

  // Cluster at a cell sized off the MEDIAN fire's own light radius, so one
  // enormous fire in a scene of small ones cannot drag every cell wide.
  const radii = list.map((s) => fireScaleChain(s?.diameterPx, mPerPx).lightRadiusPx).sort((a, b) => a - b);
  const medianRadius = radii[Math.floor(radii.length / 2)] ?? LIGHT_RADIUS_MIN_PX;
  const clusters = clusterFireSources(list, medianRadius * plan.clusterFactor);

  const out = [];
  for (const c of clusters) {
    const chain = fireScaleChain(c.diameterPx, mPerPx, { intensity: c.intensity });
    // ⚠️ `alive01` NOW COMES FROM THE SAME SIGNAL THAT SIZES THE FLAME SPRITE
    // POPULATION (2026-09-04) — NOT a second, independent wind-response curve.
    // Author, live: the light's own wind dimming was "far too strong" and
    // needed to track "the number of fire particles being created and how
    // many are alive in that area". The old `fireWeatherResponse(chain, env,
    // 1, c.exposure).alive01` was a HARD THRESHOLD (exactly 1 below the
    // fire's own `snuffWind`, then a steep drop to exactly 0) computed from a
    // totally separate formula than `fireRuntimeFromParams`' particle
    // `activeCount` — the two could (and did) disagree arbitrarily. Reusing
    // `fireWindParticleResponse`'s `flameActiveCountMul` — the SAME fraction
    // `fire-subsystem.js` multiplies into every flame engine's `activeCount`
    // — makes the light dim in lockstep with the sprite population instead: a
    // smooth ramp from the very start of the wind range (not a cliff late in
    // it) that floors at 15%/55% (never a hard blowout, matching the sprites
    // never fully vanishing either) rather than exactly 0. Computed PER
    // CLUSTER, using that cluster's own `chain.snuffWind` and `c.exposure` —
    // MORE precise than the particle engines get, which only have one
    // map-wide representative fire to work from.
    //
    // ⚠️ THIS ALSO FIXES A SECOND DEAD-CONTROL GAP: the old call never routed
    // through `applyWeatherResponseGain` (itself unreachable dead code — see
    // that function's own header), so the light's dimming ignored BOTH
    // `weatherResponse` ("at 0 it burns regardless") and `canBeSnuffed`
    // ("whether a strong enough wind can put this fire out") entirely, the
    // same gap `fireWindMotion01` already closed for the particles.
    const windMotion01 = fireWindMotion01({
      windSpeed01,
      windExposure01: c.exposure,
      windResponseGain,
      weatherResponse01,
      snuffWind: chain.snuffWind,
    });
    const alive01 = fireWindParticleResponse(windMotion01, canBeSnuffed).flameActiveCountMul;
    if (!(alive01 > 0.02)) continue;

    const seed = deriveFireSeed(c.x, c.y);

    // Clamped to the SAME 0.25..3 band `fireRuntimeFromParams` uses, so the
    // slider cannot reach past its own declared range by a different route.
    const radius = chain.lightRadiusPx * clampNum(Number.isFinite(radiusScale) ? radiusScale : 1, 0.25, 3);
    const rgb = hexToRgb01(colorHex) ?? hexToRgb01(FIRE_RAMP_WOOD[3].hex);
    const shapePoints = fireCirclePolygon(c.x, c.y, radius);

    // ⚠️ EVERY NUMBER THIS DESCRIPTOR CARRIES IS CHECKED BEFORE IT LEAVES.
    // The light pool builds a fan geometry from these and one NaN takes out the
    // whole batch (see `fireCirclePolygon`'s note). A dropped light is a missing
    // glow; a NaN light is a black screen and a console flood.
    // `alive01` — computed above, from the SAME signal the particle sprite
    // count uses, in place of the old live `envelope` (the pulse itself moved
    // to the GPU long before this — see this function's own header note).
    // ⚠️ BASELINE DROPPED 0.5 → 0.12, 2026-09-02 (mythica-machina-press#475).
    // THE REAL ROOT CAUSE, found only after two earlier (real, but
    // insufficient) fixes — a live side-by-side the author ran nailed it: a
    // plain Foundry light at luminosity≈0 threw an evenly warm glow with NO
    // white halo; the SAME light at Foundry's neutral default (luminosity
    // 0.5) read as flatly white with no visible tint anywhere.
    //
    // Illumination's own colour is Foundry-parity colour-agnostic ambient —
    // its "bright" tone IS the scene's literal `ambient.brightest`
    // (`environmental-light.js#computeAmbientColors`, `[1,1,1]` by default),
    // and `computeExposure`/`exposureFactor` (point-light-illumination.js)
    // PUSHES a fragment TOWARD that white whenever luminosity is ≥ 0.5
    // (`exposure ≥ 0`) — which, at Foundry's own neutral default 0.5, this
    // formula's old 0.5 BASE sat right on top of, before any modulation ever
    // moved it. A fragment already pushed to (or near) pure white [1,1,1] has
    // no headroom left: coloration's own additive orange on top of an
    // already-saturated white channel clips right back to white, REGARDLESS
    // of the coloration's own strength or falloff reach — which is exactly
    // why the two earlier fixes (widening `coreFade`, then the whole falloff
    // curve) moved the goalposts but never the actual symptom. Below 0.5
    // (exposure < 0) illumination instead pulls the SAME fragment DOWN
    // toward black, which is what opens the headroom the additive tint needs
    // to read as genuinely orange rather than an invisible top-up on white.
    //
    // This does not make fire dimmer in any way a player would notice: the
    // scene's actual brightening still comes overwhelmingly from the
    // ADDITIVE coloration below (`alpha01`), which never depended on
    // `luminosity01` at all — this only stops illumination's OWN, colour-
    // agnostic contribution from drowning it out.
    const luminosity01 = clampNum(0.12 + 0.42 * (alive01 - 1) + 0.25 * (chain.baseTemp - 0.6), 0.05, 0.4);
    const alpha01 = clampNum(0.55 * alive01 * chain.baseTemp, 0.05, 1);
    const elevation = Number.isFinite(c.elevation) ? c.elevation : 0;
    if (!shapePoints || ![radius, luminosity01, alpha01].every(Number.isFinite)) continue;

    out.push({
      sourceId: `fire:${c.id}`,
      ownerEffectId: 'fire',
      x: c.x,
      y: c.y,
      elevation,
      radius,
      windExposure: Number.isFinite(c.exposure) ? c.exposure : 1,
      windResponse: FIRE_WIND_RESPONSE,
      shapePoints,
      ratio: 0.35,
      attenuation01: 0.6,
      luminosity01,
      hasColor: true,
      alpha01,
      color: rgb,
      // ⚠️ `'inverseSquareWide'`, NOT candle/lightning's plain `'inverseSquare'`
      // (2026-09-02, mythica-machina-press#475 — "the light a fire throws is
      // white"). The two share the same windowed-inverse-square SHAPE, just
      // at a different steepness (`point-light-illumination.js`'s
      // `FIRE_INVERSE_SQUARE_STEEPNESS` vs `INVERSE_SQUARE_STEEPNESS`) — see
      // that constant's own header for why fire needed its own: the candle-
      // tuned K=8 curve is already down to a sliver of strength by ~50-70%
      // of a light's OWN radius, which reads fine on a candle's small radius
      // but left most of a fire's much bigger glow looking uncoloured.
      falloffModel: 'inverseSquareWide',
      animation: {
        type: 'firePuff',
        speedRaw: 5,
        intensityRaw: 5,
        reverse: false,
        seed,
        // `candleFlicker`'s own tier ladder (registry.js's `firePuff` entry) —
        // 0 plain, 1 chaotic guttering, 2 lean/oval/boiling edge.
        quality: clampNum(Math.floor(tier ?? FIRE_DEFAULT_TIER), 0, 2),
      },
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// WIND — how the PARTICLES answer the same dial the light already leans into
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calm-air lifespan boost / full-gale lifespan cut, flame only.
 *
 * ⚠️ AUTHOR'S OWN ENDPOINTS (2026-09-03): *"at very low wind values flames
 * have longer lifespans to make them feel lazy and slow"* / *"at wind 1...
 * flame particles should have smaller lifespans."* `FLAME_CALM_LIFE_MUL`
 * makes "no wind at all" its own distinct, unhurried character rather than
 * just "whatever `flameLifeScale` already says"; `FLAME_GUTTER_LIFE_MUL`
 * makes a full gale recycle particles fast — short, flickery puffs.
 */
const FLAME_CALM_LIFE_MUL = 1.4;
const FLAME_GUTTER_LIFE_MUL = 0.3;

/**
 * How far a guttering flame's population/brightness can be pushed down.
 *
 * ⚠️ RAISED 2026-09-04 (from 0.15/0.55) — author, live, TWICE: "the amount of
 * light suppression is far too strong" and then, after the light was linked
 * to this exact fraction, "still far too strong". The floor itself was only
 * half the story (see `EASE_POWER`/`SNUFF_FRAC_FLOOR` below for the other
 * half) but it was also genuinely too severe on its own — 0.15 is an 85%
 * cut, deep enough that both the flame sprites AND (once linked) the cast
 * light read as nearly extinguished at the top of the range rather than
 * "mostly suppressed", the phrase this was originally built to match.
 *
 * Two floors: a fire that CAN be blown out empties out harder (0.3) than one
 * the author has marked immune (`canBeSnuffed: false` — a magical brazier, a
 * plot beacon, 0.65) — but neither goes anywhere near as low as before.
 */
const FLAME_GUTTER_COUNT_FLOOR = 0.3;
const FLAME_GUTTER_COUNT_FLOOR_IMMUNE = 0.65;
/**
 * Opacity floors deliberately GENTLER than the count floors — fewer sprites
 * that are still clearly flame-coloured reads as "struggling"; fewer AND
 * faint at once reads as "already out", which is a stronger claim than
 * "mostly suppressed" asked for.
 */
const FLAME_GUTTER_OPACITY_FLOOR = 0.65;
const FLAME_GUTTER_OPACITY_FLOOR_IMMUNE = 0.85;

/**
 * ⚠️ ADDED 2026-09-04, THE OTHER HALF OF THE "TOO STRONG" FIX. Raising the
 * floors alone (above) does not slow how FAST a fire reaches them —
 * `smoothstep01` is already halfway to its floor by the midpoint of the
 * range (`smoothstep01(0,1,0.5) === 0.5`), so a fire at "half wind" read as
 * roughly half-suppressed, which is a steep ramp for something meant to bite
 * mainly near the top. Raising this SHAPE exponent keeps the same 0→1
 * endpoints (still fully calm at `windMotion01=0`, still fully floored at
 * `windMotion01=1`) while pushing the bulk of the transition later —
 * `smoothstep01(0,1,0.5) ** 2.2 ≈ 0.22`, not 0.5.
 */
const SUPPRESSION_EASE_POWER = 2.2;

/**
 * Smoke is the most fragile layer — real smoke shears apart in far less wind
 * than it takes to blow a flame out, which is why "producing zero smoke" is
 * the author's OWN stated wind-1 endpoint regardless of how suppressed the
 * flame itself is at the same moment. The exponent below is under 1 so the fade
 * starts EARLIER than flame's own suppression curve (a bowed ramp, not a
 * straight one) while still landing on an EXACT 0 at `windMotion01 = 1`.
 */
const SMOKE_WIND_FADE_EXPONENT = 0.65;

/**
 * The GM's wind dial, folded into ONE 0..1 "how hard is this fire being hit"
 * signal — every curve in {@link fireWindParticleResponse} and the live
 * particle kernel (`fire-particle-runtime.js`'s `uWindMotion01`) reads THIS,
 * not the raw scene wind speed, so a slider move tells one coherent story
 * instead of several terms disagreeing about how windy it is.
 *
 * ⚠️ `weatherResponse01` GENUINELY GATES THIS TO 0, not merely dampens it —
 * `FIRE_PARAMS.weatherResponse`'s own help text already promises "at 0 it
 * burns regardless"; before this function existed that was true for the
 * light's `alive01` gate and false for every particle, which still felt the
 * raw ambient wind unconditionally. This is that promise finally kept end to
 * end.
 *
 * ⚠️ `windResponseGain` reads `FIRE_PARAMS.windResponse` ("How far wind
 * leans the plume") — computed since the schema shipped and, until this
 * function, consumed by nothing (`fire-subsystem.js`'s `engine.setParams`
 * call never mentioned it): a dead control, the same shape this file's own
 * `lightRadiusScale`/`color`/`posterize` notes already record once each.
 *
 * ⚠️ SIZE-NORMALISED BY `snuffWind`, THE SAME SIGNAL THE LIGHT'S OWN
 * SUPPRESSION NOW READS TOO (`buildFireLightSources`, via
 * {@link fireWindParticleResponse}). Dividing by the fire's own
 * `snuffWind/10` fraction gives a candle-scale hearth a lower ceiling before
 * it saturates than a bonfire gets — "a candle gutters in a breeze, a
 * bonfire does not" (`fireScaleChain`'s own words). Division happens BEFORE
 * the final clamp so `windResponseGain` above 1 can still push a large
 * fire's normalised signal back up — the dial keeps its own declared meaning
 * regardless of size.
 *
 * ⚠️ THE DIVISOR'S OWN FLOOR WAS RAISED 0.05 → 0.4, 2026-09-04 (author, live,
 * TWICE: "the amount of light suppression is far too strong" / "still far
 * too strong"). At the old 0.05 floor, a small hearth's own `snuffFrac` could
 * sit near that floor too, meaning the raw scene wind speed got divided by
 * as little as 0.05 — up to a 20× amplification, so a small painted fire
 * reached FULL suppression at a small fraction of the GM's actual wind dial.
 * Raising the floor caps that amplification at 2.5×, so an ordinary hearth-
 * scale fire (the size this effect is mostly used at) now needs wind
 * genuinely close to its own dial maximum before saturating, not a fraction
 * of it — see `SUPPRESSION_EASE_POWER`, above, for the other half of this fix.
 *
 * @param {object} [args]
 * @param {number} [args.windSpeed01=0] - the scene's live ambient wind speed,
 *   0..1 (`windHandle.ambient.speed01`'s current `.value`).
 * @param {number} [args.windExposure01=1] - the representative fire's own
 *   `windExposure` (`fires[0].windExposure`) — sealed rooms read low,
 *   matching `buildFireLightSources`' identical `c.exposure` gate on the
 *   SAME fires.
 * @param {number} [args.windResponseGain=1] - `FIRE_PARAMS.windResponse`, 0..2.
 * @param {number} [args.weatherResponse01=1] - `FIRE_PARAMS.weatherResponse`, 0..1.
 * @param {number} [args.snuffWind] - `chain.snuffWind` ({@link fireScaleChain}).
 *   Falls back to `fireWeatherResponse`'s own `?? 4` default (a mid-size
 *   fire) so this stays callable without a full chain in isolation.
 * @returns {number} 0..1.
 */
export function fireWindMotion01({
  windSpeed01 = 0,
  windExposure01 = 1,
  windResponseGain = 1,
  weatherResponse01 = 1,
  snuffWind,
} = {}) {
  const speed = clampNum(Number.isFinite(windSpeed01) ? windSpeed01 : 0, 0, 1);
  const exposure = clampNum(Number.isFinite(windExposure01) ? windExposure01 : 1, 0, 1);
  const gain = clampNum(Number.isFinite(windResponseGain) ? windResponseGain : 1, 0, 2);
  const gate = clampNum(Number.isFinite(weatherResponse01) ? weatherResponse01 : 1, 0, 1);
  const snuffFrac = clampNum((Number.isFinite(snuffWind) ? snuffWind : 4) / 10, 0.4, 1);
  const sizeNormalised = clampNum((speed * exposure * gain) / snuffFrac, 0, 1);
  return sizeNormalised * gate;
}

/**
 * The particle-side wind story, entirely keyed off {@link fireWindMotion01}'s
 * one signal so "calm" and "guttering" read as ONE thing changing.
 *
 * ⚠️ EVERY MULTIPLIER HERE STACKS ONTO THE AUTHOR'S OWN DIAL, never replaces
 * it — the same "1.0 = exactly the reference" contract every existing
 * `perKind` multiplier already keeps (this file's own "THE AUTHOR'S DIALS"
 * header, `fire-particle-runtime.js`). At `windMotion01 = 0` count/opacity sit
 * at their neutral 1× (only the calm LIFE boost moves — lazy, not
 * suppressed) and smoke's multiplier is exactly 1 — a windless fire looks
 * exactly as it would with no wind system at all.
 *
 * @param {number} windMotion01 - from {@link fireWindMotion01}.
 * @param {boolean} [canBeSnuffed=true] - `FIRE_PARAMS.canBeSnuffed`; false
 *   raises every floor so wind can rough the fire up but never empty it out.
 * @returns {{flameLifeMul:number, flameActiveCountMul:number,
 *   flameOpacityMul:number, smokeActiveCountMul:number}}
 */
export function fireWindParticleResponse(windMotion01, canBeSnuffed = true) {
  const t = clampNum(Number.isFinite(windMotion01) ? windMotion01 : 0, 0, 1);
  // ⚠️ POWERED, NOT BARE smoothstep01 — see SUPPRESSION_EASE_POWER's own
  // header. Still 0 at t=0 and 1 at t=1 (a fraction in [0,1] raised to a
  // positive power stays in [0,1] with the same endpoints); only the MIDDLE
  // of the ramp moves.
  const eased = smoothstep01(0, 1, t) ** SUPPRESSION_EASE_POWER;
  const countFloor = canBeSnuffed ? FLAME_GUTTER_COUNT_FLOOR : FLAME_GUTTER_COUNT_FLOOR_IMMUNE;
  const opacityFloor = canBeSnuffed ? FLAME_GUTTER_OPACITY_FLOOR : FLAME_GUTTER_OPACITY_FLOOR_IMMUNE;
  return {
    flameLifeMul: FLAME_CALM_LIFE_MUL + (FLAME_GUTTER_LIFE_MUL - FLAME_CALM_LIFE_MUL) * eased,
    flameActiveCountMul: 1 - eased * (1 - countFloor),
    flameOpacityMul: 1 - eased * (1 - opacityFloor),
    // Bowed toward an earlier fade (see SMOKE_WIND_FADE_EXPONENT) and an
    // EXACT 0 at t=1 — "producing zero smoke" is literal, not asymptotic.
    smokeActiveCountMul: 1 - t ** SMOKE_WIND_FADE_EXPONENT,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PARAMS → RUNTIME — the one place a control becomes a number
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the effect's params into the exact values the material's uniforms and
 * the light builder take.
 *
 * ⚠️ THIS FUNCTION IS WHY THE PARAMS ARE NOT DEAD CONTROLS, and that is a wall
 * rather than a nicety. `tools/verify-structure.mjs`'s `params/no-dead-controls`
 * fails the build for any declared param with no consumer anywhere in `src/`,
 * and it exists because V2's water shipped 46 uniforms with a live UI slider and
 * ZERO consuming GLSL — including a fully-labelled "Bathymetry (Volumetric)"
 * folder with two colour pickers and a documented Beer-Lambert model, entirely
 * inert. A control an author can move that changes NOTHING is worse than no
 * control: it is a lie they tune against.
 *
 * Keeping the mapping HERE rather than inside the subsystem also means it is
 * pure, Node-testable, and cannot quietly disagree with itself between the
 * flame's uniforms and the light's descriptors — both read this one function.
 *
 * @param {object} params - a resolved param bag (`effect-cascade.js#resolveEffectParams`).
 * @param {object} chain - from {@link fireScaleChain}.
 * @param {object} [wind] - `{speed01, exposure01}`. Omitted (the default for
 *   every pre-existing call site and test) resolves `windMotion01` to exactly
 *   0 — byte-identical to before this parameter existed.
 * @returns {object} plain numbers, ready to assign to uniforms.
 */
export function fireRuntimeFromParams(params = {}, chain = {}, wind = {}) {
  const p = params ?? {};
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

  const weatherResponse = clampNum(num(p.weatherResponse, 1), 0, 1);
  const windResponseGain = clampNum(num(p.windResponse, 1), 0, 2);
  const canBeSnuffed = bool(p.canBeSnuffed, true);
  // THE ONE PARTICLE WIND SIGNAL — see fireWindMotion01's own header for why
  // weatherResponse GATES rather than dampens, and why windResponse is read
  // here at all (a dead control until this call site existed).
  const windMotion01 = fireWindMotion01({
    windSpeed01: wind?.speed01,
    windExposure01: wind?.exposure01,
    windResponseGain,
    weatherResponse01: weatherResponse,
    snuffWind: chain?.snuffWind,
  });
  const windFx = fireWindParticleResponse(windMotion01, canBeSnuffed);
  return {
    // Material uniforms.
    intensity: clampNum(num(p.brightness, 1), 0, 3),
    // 0, matching FIRE_PARAMS.posterize's own (fixed) default — see fire.js's
    // "Look" category header for why not the schema's old 0.85.
    posterize: clampNum(num(p.posterize, 0), 0, 1),
    bands: Math.round(clampNum(num(p.bandCount, 7), 3, 12)),
    smokeGain: clampNum(num(p.smokeAmount, 1) * 0.3, 0, 1),
    grainGain: clampNum(num(p.grain, 0.5), 0, 1),
    windResponse: windResponseGain,
    /**
     * Playback rate for the particle engines' own motion — the turbulence
     * field's churn and the flame archetype's silhouette boil. Shared by all
     * three kinds (`fire-subsystem.js` attaches it to every engine's
     * `setParams`, the same way it attaches `intensity`/`cameraHeight`).
     *
     * ⚠️ NOT `chain.puffHz`. An earlier version of this field multiplied
     * `chain.puffHz` (the Cetegen-Ahmed vortex-shedding rate) by this same
     * clamp and called the result `puffHz` — correct-looking, and dead: that
     * clock belonged to the volumetric material's per-fragment noise phase
     * (`fire-render.js`, orphaned since the particle rebuild), and nothing in
     * the live particle runtime (`fire-particle-runtime.js`) ever read a
     * `runtime.puffHz` field. `chain.puffHz` itself is untouched and still
     * feeds `fire-render.js`/`firePuffPhase` — see their own notes.
     */
    motionSpeed: clampNum(num(p.animationSpeed, 1), 0.1, 3),
    hueShift: chain.hueShift ?? 0,
    sootGain: clampNum(chain.soot01 ?? 0.4, 0, 2),

    // Light.
    lightEnabled: bool(p.lightEnabled, true),
    lightRadiusPx: (chain.lightRadiusPx ?? 0) * clampNum(num(p.lightRadiusScale, 1), 0.25, 3),
    /** The raw multiplier, for `buildFireLightSources` — which works from its
     * OWN per-cluster chain and so cannot use the pre-multiplied px value above
     * (a cluster's diameter is not any one fire's). */
    lightRadiusScale: clampNum(num(p.lightRadiusScale, 1), 0.25, 3),
    lightColor: typeof p.lightColor === 'string' ? p.lightColor : '#ff9a3c',
    flameColor: typeof p.color === 'string' ? p.color : FIRE_RAMP_WOOD[3].hex,
    /** `color`'s ready-to-multiply form — see `fireTintMul`'s own header. */
    flameColorTintMul: fireTintMul(typeof p.color === 'string' ? p.color : FIRE_RAMP_WOOD[3].hex),
    /**
     * ⚠️ TWO SOURCES, ONE UNIFORM. `chain.hueShift` is the FUEL's own built-in
     * shift (`FIRE_FUELS` — magical's 0.5 turns is what its own help text
     * already promises: "magical is hue-shifted for the unnatural stuff").
     * It was dead alongside `color`/`posterize` — this is also its fix, not a
     * new feature: any scene already using magical fuel will visibly change
     * (a full 180° flip) the moment this ships, in the direction its own
     * label always claimed. `p.colorHueShift` is the author's manual ROH
     * dial, in degrees because a GM thinks in degrees, not turns; converted
     * here so the shader only ever receives one combined radian value.
     */
    hueShiftRad: ((chain.hueShift ?? 0) + clampNum(num(p.colorHueShift, 0), -180, 180) / 360) * Math.PI * 2,

    // Weather. `weatherResponse` scales how far each response term travels from
    // its neutral value, so 0 is genuinely "ignores the weather" rather than
    // "gets a smaller amount of weather".
    weatherResponse,
    // ── THE AUTHOR'S TUNING SET ──
    // Passed straight through to the particle engines as multipliers over the
    // V2-derived constants. Clamped to each param's own declared range so a
    // stored value from an older schema cannot reach past what the slider says.
    perKind: {
      flame: {
        // ⚠️ WIND-MODULATED (2026-09-03) — see fireWindParticleResponse. Each
        // multiplier STACKS onto the author's own dial rather than replacing
        // it, and is ~1 at windMotion01=0 (activeCount/opacity) so a windless
        // fire is unaffected. `lifeScale` moves even at zero wind (the "calm
        // = lazy" boost) — that is the one asymmetry the author asked for.
        activeCount: Math.round(clampNum(num(p.flameCount, 12), 0, 200) * windFx.flameActiveCountMul),
        lifeScale: clampNum(num(p.flameLifeScale, 1), 0.05, 30) * windFx.flameLifeMul,
        sizeScale: clampNum(num(p.flameSizeScale, 1), 0.02, 20),
        opacityScale: clampNum(num(p.flameOpacity, 1), 0, 20) * windFx.flameOpacityMul,
        emissionScale: clampNum(num(p.flameEmission, 1), 0, 50),
        colorAge: clampNum(num(p.flameColorAge, 2.5), 0.1, 12),
        // Warps WHICH spawn point gets picked, not how it looks once picked —
        // see `spawnAt` in the particle runtime. 0 = uniform (the old default).
        spawnBias: clampNum(num(p.flameSpawnBias, 0), -20, 20),
        // A CPU-side pull toward the fire's own centre of mass, consumed by
        // `fire-subsystem.js` (never reaches a uniform) — see `applyCohesion`.
        // Default 0 (off) — known good idea, currently buggy in practice
        // (author verdict, 2026-08-13); see FIRE_PARAMS.flameCohesion's help.
        cohesion: clampNum(num(p.flameCohesion, 0), -2, 3),
      },
      ember: {
        activeCount: Math.round(clampNum(num(p.emberCount, 10), 0, 200)),
        lifeScale: clampNum(num(p.emberLifeScale, 1), 0.05, 30),
        sizeScale: clampNum(num(p.emberSizeScale, 1), 0.02, 20),
        opacityScale: clampNum(num(p.emberOpacity, 1), 0, 20),
        emissionScale: clampNum(num(p.emberEmission, 1), 0, 50),
        chaosScale: clampNum(num(p.emberChaos, 1), 0, 30),
        riseScale: clampNum(num(p.emberRise, 1), 0, 30),
      },
      smoke: {
        // ⚠️ WIND-MODULATED (2026-09-03) — fades to a literal ZERO active
        // count at windMotion01=1 ("producing zero smoke", the author's own
        // wind-1 endpoint), ahead of flame's own suppression curve — see
        // SMOKE_WIND_FADE_EXPONENT.
        activeCount: Math.round(clampNum(num(p.smokeCount, 24), 0, 400) * windFx.smokeActiveCountMul),
        lifeScale: clampNum(num(p.smokeLifeScale, 1), 0.05, 30),
        sizeScale: clampNum(num(p.smokeSizeScale, 1), 0.02, 20),
        opacityScale: clampNum(num(p.smokeOpacity, 1), 0, 20),
        growthScale: clampNum(num(p.smokeGrowth, 1), 0, 30),
        riseScale: clampNum(num(p.smokeRise, 1), 0, 30),
      },
    },
    /**
     * Perspective as a CAMERA HEIGHT, which is the form the shader wants.
     * The control is a strength (1 = V2's camera at 1000 units), and stronger
     * perspective means a CLOSER camera — hence the reciprocal. 0 maps to a
     * effectively-infinite height, i.e. perfectly flat.
     */
    cameraHeight: 1000 / Math.max(0.02, clampNum(num(p.perspective, 1), 0, 20)),
    canBeSnuffed,
    fuel: typeof p.fuel === 'string' ? p.fuel : 'wood',
    fireIntensity: clampNum(num(p.intensity, 1), 0, 2),
    // GLOBAL, like motionSpeed/hueShiftRad above — fire-subsystem.js attaches
    // this to every engine's setParams (flame/ember/smoke alike), which is
    // what lets ember and smoke inherit the same gust push flame gets, and
    // lets the particle kernel fade flame's own calm-air upward drift as
    // wind rises (see fire-particle-runtime.js's uWindMotion01).
    windMotion01,
  };
}

/**
 * Blend a weather response toward neutral by the effect's own
 * `weatherResponse` param — 0 leaves the fire burning exactly as it would in
 * still, dry air.
 *
 * @param {object} response - from {@link fireWeatherResponse}.
 * @param {number} weatherResponse01 @param {boolean} canBeSnuffed
 * @returns {object} the same shape, scaled.
 */
export function applyWeatherResponseGain(response, weatherResponse01, canBeSnuffed = true) {
  const g = clampNum(Number.isFinite(weatherResponse01) ? weatherResponse01 : 1, 0, 1);
  const lerp = (a, neutral) => neutral + (a - neutral) * g;
  return {
    tempScale: lerp(response?.tempScale ?? 1, 1),
    heightScale: lerp(response?.heightScale ?? 1, 1),
    smokeScale: lerp(response?.smokeScale ?? 1, 1),
    whiteness: lerp(response?.whiteness ?? 0, 0),
    // A fire that cannot be snuffed stays lit no matter the gale — an authored
    // override for a magical brazier or a plot-critical beacon.
    alive01: canBeSnuffed ? lerp(response?.alive01 ?? 1, 1) : 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GEOMETRY — one batched quad per fire, five attribute buffers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Worst-case downwind shear the quad must contain, as a fraction of plume
 * height. The quad is baked WIND-INDEPENDENT on purpose: wind changes every
 * frame and a wind-sized quad would rebake the whole geometry every frame. The
 * material's own soft edge handles anything that would exceed this.
 */
const QUAD_SHEAR_MARGIN = 0.9;
/** Extra room for billow lobes pushing past the nominal radius. */
const QUAD_BILLOW_MARGIN = 1.35;

/**
 * The world-space side length of one fire's quad.
 * @param {object} chain @returns {number} px
 */
export function fireQuadSizePx(chain) {
  const halfWidth = (chain.diameterPx / 2) * RADIUS_AT_SMOKE_TOP * QUAD_BILLOW_MARGIN;
  const shear = chain.heightPx * QUAD_SHEAR_MARGIN;
  return 2 * (halfWidth + shear);
}

/**
 * Bake the batched quad geometry for every visible fire.
 *
 * ⚠️ FIVE ATTRIBUTE BUFFERS, NOT EIGHT. WebGPU guarantees only 8 vertex buffers
 * per pipeline and this project has already taken a real compile failure at 12
 * ("Vertex buffer count (12) exceeds the maximum number of vertex buffers (8)",
 * caught in the Shader Lab while every Node test passed and nothing drew).
 * The natural attribute set here — position, uv, center, windExposure,
 * fireColor, fireIntensity, expectedDepth, diameterPx — is exactly 8, sitting
 * on the wall with no room for the next idea. Packing to 5 is not premature:
 * `lightning-render.js` had to widen an existing vec3 to vec4 rather than open
 * a 7th buffer for precisely this reason.
 *
 *   position(3) · uv(2) · center(2) · colorIntensity(4) · fireParams(4)
 *
 * `fireParams` = (diameterPx, windExposure, expectedDepth, maskClip).
 *
 * ⚠️ `expectedDepth` is PER-VERTEX, not a uniform: one draw call batches every
 * visible fire and different fires legitimately sit on different floors.
 *
 * ⚠️ `maskClip` IS PER-VERTEX FOR THE SAME REASON `expectedDepth` IS: one draw
 * call batches every fire in a size class, and a mask-derived fire and an
 * anchor-placed fire can legitimately sit in the SAME batch. Only a
 * mask-derived fire has a painted shape to conform to — an anchor is placed
 * precisely because the author wants fire somewhere with no `_Fire` paint at
 * all, and clipping it against whatever the mask happens to read at that
 * point would be `feedback_gate_polarity_must_fail_open`'s exact mistake in a
 * new outfit. 1 = mask-derived (clip to the paint), 0 = anchor (never clipped).
 *
 * @param {Array<object>} fires - `{x,y,diameterPx,intensity,expectedDepth,windExposure,color,maskClip}`.
 * @param {object} opts - `{mPerPx}`.
 * @returns {object} typed arrays + counts, ready for a BufferGeometry.
 */
export function computeFireQuadArrays(fires, { mPerPx = 0.02 } = {}) {
  // ⚠️ THE QUAD SIZE IS CHECKED, NOT JUST THE INPUTS. A finite diameter can
  // still produce a non-finite quad if any link in the scale chain degenerates,
  // and one NaN vertex takes out the entire batched draw — every other fire in
  // the same buffer stops rendering (author-reported live, 2026-08-08: a
  // per-frame flood of `computeBoundingSphere(): Computed radius is NaN`).
  const list = (Array.isArray(fires) ? fires : []).filter((f) => {
    if (!Number.isFinite(f?.x) || !Number.isFinite(f?.y) || !(Number(f?.diameterPx) > 0)) return false;
    const size = fireQuadSizePx(fireScaleChain(f.diameterPx, mPerPx, { fuel: f.fuel, intensity: f.intensity }));
    return Number.isFinite(size) && size > 0;
  });
  const quadCount = list.length;
  const position = new Float32Array(quadCount * 4 * 3);
  const uv = new Float32Array(quadCount * 4 * 2);
  const center = new Float32Array(quadCount * 4 * 2);
  const colorIntensity = new Float32Array(quadCount * 4 * 4);
  const fireParams = new Float32Array(quadCount * 4 * 4);
  const index = new Uint32Array(quadCount * 6);

  const quadSizes = [];
  for (let q = 0; q < quadCount; q++) {
    const f = list[q];
    const chain = fireScaleChain(f.diameterPx, mPerPx, { fuel: f.fuel, intensity: f.intensity });
    const size = fireQuadSizePx(chain);
    quadSizes.push(size);
    const half = size / 2;
    const rgb = hexToRgb01(f.color) ?? hexToRgb01(FIRE_RAMP_WOOD[3].hex);
    const inten = Number.isFinite(f.intensity) ? f.intensity : 1;
    const expo = Number.isFinite(f.windExposure) ? f.windExposure : 1;
    // Defaults to 0 ("below everything") ONLY if nothing resolved it; a caller
    // that has not wired the depth authority yet gets an ungated flame rather
    // than a silently invisible one (feedback_gate_polarity_must_fail_open).
    const depth = Number.isFinite(f.expectedDepth) ? f.expectedDepth : 0;
    // Defaults to 0 (never clipped) for the SAME reason: a caller that has not
    // labelled its fires yet gets an unclipped flame, not one invisibly
    // vanishing against an empty mask it was never told to ignore.
    const maskClip = f.maskClip ? 1 : 0;

    // ⚠️ CORNER ORDER IS (−,−) (+,−) (+,+) (−,+) with uv matching, and the quad
    // is CENTRED on the fire. World space here is raw Foundry canvas px with +Y
    // DOWN; the camera owns the one Y-flip (`computeCameraFrustum` sets
    // `top = minY`), so there is no manual Y math to get wrong here — the exact
    // discipline every other world mesh in this codebase uses.
    const corners = [
      [-half, -half, 0, 0],
      [half, -half, 1, 0],
      [half, half, 1, 1],
      [-half, half, 0, 1],
    ];
    for (let v = 0; v < 4; v++) {
      const [dx, dy, u, vv] = corners[v];
      const p3 = (q * 4 + v) * 3;
      const p2 = (q * 4 + v) * 2;
      const p4 = (q * 4 + v) * 4;
      position[p3] = f.x + dx;
      position[p3 + 1] = f.y + dy;
      position[p3 + 2] = 0;
      uv[p2] = u;
      uv[p2 + 1] = vv;
      center[p2] = f.x;
      center[p2 + 1] = f.y;
      colorIntensity[p4] = rgb[0];
      colorIntensity[p4 + 1] = rgb[1];
      colorIntensity[p4 + 2] = rgb[2];
      colorIntensity[p4 + 3] = inten;
      fireParams[p4] = chain.diameterPx;
      fireParams[p4 + 1] = expo;
      fireParams[p4 + 2] = depth;
      fireParams[p4 + 3] = maskClip;
    }
    const base = q * 4;
    const io = q * 6;
    index[io] = base;
    index[io + 1] = base + 1;
    index[io + 2] = base + 2;
    index[io + 3] = base;
    index[io + 4] = base + 2;
    index[io + 5] = base + 3;
  }

  return { position, uv, center, colorIntensity, fireParams, index, quadCount, quadSizes };
}

/**
 * A cheap integer checksum over everything the baked geometry depends on, so a
 * pan or a tick does not rebuild buffers that did not change. Deliberately does
 * NOT include wind or time — the quad is wind-independent by construction (see
 * {@link fireQuadSizePx}) and animation lives entirely in the material.
 *
 * @param {Array<object>} fires @returns {number}
 */
export function fireGeometrySignature(fires) {
  const list = Array.isArray(fires) ? fires : [];
  let h = 2166136261 >>> 0;
  const mix = (n) => {
    h ^= Math.round(Number.isFinite(n) ? n * 16 : 0) | 0;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(list.length);
  for (const f of list) {
    mix(f?.x);
    mix(f?.y);
    mix(f?.diameterPx);
    mix(f?.intensity);
    mix(f?.expectedDepth);
    mix(f?.windExposure);
    mix(f?.maskClip ? 1 : 0);
    // Colour and fuel change the bake, so they change the signature.
    for (const ch of String(f?.color ?? '')) mix(ch.codePointAt(0));
    for (const ch of String(f?.fuel ?? '')) mix(ch.codePointAt(0));
  }
  return h;
}
