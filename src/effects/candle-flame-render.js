/**
 * CANDLE FLAME — THE RUNTIME (what actually draws a flame + emits its light).
 *
 * ============================================================================
 * WHY THIS IS NOT A PARTICLE (the constraint, reconsidered — author, 2026-07-20)
 * ============================================================================
 *
 * The earlier plan filed the candle under `surface.particles` because V2 did.
 * That was wrong, and the author was right to push on it: a candle is ONE
 * persistent thing per anchor — a small flame that sits still and a light that
 * pools around it — NOT a fountain of thousands of ephemeral, simulated
 * particles. The particle engine (TSL compute / transform feedback / GPGPU
 * position buffers) exists for the latter; forcing a candle through it would be
 * machinery with nothing to simulate.
 *
 * So a candle is TWO first-class primitives the renderer already understands:
 *   1. an anchored BILLBOARD — the flame shape (this file's TSL material), drawn
 *      as ONE batched world-quad mesh (all candles in a single geometry, one
 *      draw call). That is exactly the "one draw call, not N" outcome the
 *      `particles/one-engine` wall exists to enforce — reached via geometry
 *      batching, not `InstancedMesh`/`Sprite` — so the wall never even fires.
 *   2. a POINT LIGHT — reusing the SAME machinery Foundry lights already run
 *      through (`effects/lighting/point-light-illumination.js`, the viewer's
 *      light-mesh pool): a candle light is just another light SOURCE, authored
 *      by us from the anchor + params ("a point light we control") instead of
 *      read from a Foundry document. It gets the region-aware ambient, the soft
 *      edge, the coloration and MAX-blending every other light gets, for free.
 *
 * This file is the RUNTIME's TSL/THREE half (the flame material + the geometry
 * wrapper); the pure math (colour parsing, override resolution, the light-
 * source builder, clustering, the vertex-array bake) lives in
 * `candle-flame-geometry.js` (split out 2026-07-25, the size-ratchet god-object
 * reversal — this file was 1,009 lines before it). `effects/candle-flame.js`
 * stays the DECLARATION (params + manifest). The viewer (`vt/vt-pan-viewer.js`)
 * owns the GPU lifecycle and calls these builders — the same split as
 * ui-window-shadow (declaration) / light-visibility (runtime), and the same
 * "effect exports pure TSL builders, the viewer drives them" pattern every
 * lighting effect already follows.
 *
 * COORDINATES: everything here is in RAW world space (Foundry canvas px, +Y
 * down). The viewer's camera owns the one Y-flip (vt-pan-viewer.js#updateCamera:
 * `top = minY`), so a flame quad built at a candle's world (x,y) needs zero
 * manual Y math — the exact discipline every other world mesh uses, and the
 * reason the recurring Y-flip bug (feedback_y_flip_recurring_risk) cannot bite
 * here: there is no hand-rolled world↔screen mapping to get wrong.
 *
 * @module effects/candle-flame-render
 */

import { createWindHandle } from '../world/index.js';
import { buildDepthHeightGateNode } from './lighting/point-light-illumination.js';
import { computeCandleFlameArrays, FLAME_SHAPE, FLAME_PROFILE_NORM, srgbHexToLinear } from './candle-flame-geometry.js';

/**
 * THE TIER-0 FALLBACK HANDLE — a bake-less handle, so a caller that supplies
 * none still gets the organic gust/flutter noise (byte-identical to the old
 * `sampleWind` call with every optional argument omitted) rather than a
 * wind-inert flame. Degrading to "no baked structure" is correct; degrading to
 * "no wind at all" would be a silent feature loss (`feedback_safety_slide_
 * outranks_doctrine` — fall back, never fall silent). Module-level and frozen:
 * one shared object, no per-material allocation.
 */
const TIER0_WIND_HANDLE = createWindHandle();

/**
 * ============================================================================
 * THE SHAPE — a smooth teardrop (rebuilt 2026-10-08 from the author's photos)
 * ============================================================================
 *
 * The flame is the TOP-DOWN FOOTPRINT of a 3D teardrop (author model,
 * 2026-07-20): rooted at the wick (the quad centre — the anchor is baked into
 * the geometry, so no uniform can move it), a rounded bulb at the base and a
 * tail that leans with the wind. Under the viewer's ORTHOGRAPHIC camera a real
 * 3D mesh would render as exactly this footprint, so it is drawn directly.
 *
 * ⚠️ WHAT THE PREVIOUS SHAPE GOT WRONG. It was a round-cone signed-distance
 * field with three layers of NOISE added to it — two octaves of "lobes", a fine
 * "grain" octave and a domain warp — all chosen to imitate a hand-painted
 * explosion sheet (cauliflower masses, detached specks). A candle is not that.
 * The author's own reference photos of real candles (2026-10-08) are all a
 * SMOOTH, convex teardrop: a round bulb, drawing in to one clean point, with a
 * lick of curvature and NOTHING at the edge that looks like fray. The noise read
 * as "rough and fuzzy" at every size, and no amount of retuning its amplitude
 * could fix that, because the roughness WAS the feature. It is gone; the
 * silhouette is an analytic curve. (Measured in the lab on identical frames: the
 * old edge deviated ~0.5 px RMS from a smooth line, the new one ~0.05 px — the
 * antialiasing floor.)
 *
 * THE PROFILE (the numbers live in `candle-flame-geometry.js#FLAME_SHAPE`, where
 * the Node tests pin its properties). Half-width along the flame, with `s`
 * running 0 (the lowest point of the bulb) to 1 (the tip):
 *
 *     w(s) = R · norm · s^0.5 · (1 − s)^0.9
 *
 * - `s^0.5` is a parabolic cap — round at the bottom, no corner anywhere.
 * - `(1 − s)^0.9` closes to a point with convex sides, as in the photographs
 *   (sampled: the half-width at 80% height is ~0.6 of the maximum, at 94% ~0.3;
 *   a concave-sided "flame icon" spike, exponent 1.15, was TRIED and reads as a
 *   thorn).
 * - the widest point lands at s ≈ 0.36, where the photos put it (0.37-0.46), and
 *   `norm` scales the maximum to exactly R.
 *
 * THE BEND. A wind-leaned flame is not a straight cone tilted off vertical —
 * it rises from the wick nearly upright and curls over (the sweeping lick in
 * the top-down photos). The chord runs wick → tip as before (so `uLean`, the
 * gust and the curl all keep steering the TIP exactly as they did); the
 * centre line is then bowed off that chord by a parabola that keeps the base
 * nearer vertical (`FLAME_ARC`), plus a per-candle sway and, at tier 2, a slow
 * travelling wave. All of it is a smooth offset in the across-the-flame
 * coordinate — no noise is ever added to the EDGE.
 *
 * THE EDGE. Two terms, never one: a pixel-width antialiasing band taken from
 * the screen-space derivative of the edge distance (so a 24px flame and a 300px
 * flame are both crisp, and the hair-thin tip fades instead of shimmering), and
 * a soft band proportional to the local half-width (`FLAME_EDGE_SOFT`) that
 * gives large flames the gentle falloff the photographs show.
 */
const {
  baseRadius: FLAME_BASE_RADIUS,
  bulbDrop: FLAME_BULB_DROP,
  profileBottom: FLAME_PROFILE_BOTTOM,
  profileTip: FLAME_PROFILE_TIP,
  lenMax: FLAME_LEN_MAX,
  lenOrder: FLAME_LEN_ORDER,
} = FLAME_SHAPE;
/** The resting spine's sideways bias (fraction of the quad). Zero: a calm flame
 * rises straight up; the wind, the curl and the sway lean it. */
const FLAME_REST_CURL_X = 0.0;
/** Edge softness: the soft falloff band's width as a fraction of the LOCAL
 * half-width. 0 = a knife edge; the photographs sit around 0.1-0.2. */
const FLAME_EDGE_SOFT = 0.11;
/** Antialiasing band, in screen pixels (of the edge's own derivative). */
const FLAME_AA_PX = 1.1;
/** The bend (see THE BEND). `ARC` = how far the base is pulled back toward
 * vertical on a leaned flame (0 = a straight tilted cone, 1 = base fully upright).
 * Sway and lick are tip offsets in quad fractions. */
const FLAME_ARC = 0.5;
const FLAME_SWAY_RATE = 0.8;
const FLAME_SWAY_AMP = 0.07;
const FLAME_LICK_AMP = 0.03; // tier 2: a slow S-wave that travels up the flame
const FLAME_LICK_WAVES = 1.1; // wavelengths along the flame's length
const FLAME_LICK_SPEED = 7.0; // rad/s

/**
 * ============================================================================
 * THE COLOUR — rebuilt 2026-10-08 against the author's reference photos
 * ============================================================================
 *
 * MEASURED, not guessed (pixel sampling across the photographed flames, edge to
 * axis). Every photo has the same anatomy, from the axis outward:
 *
 *   white-cream core → pale yellow → golden yellow → orange → a THIN deep
 *   red-brown rim, then a faint warm halo that dies away
 *
 * and the side-view photos add a blue-violet band hugging the very base, round
 * the dark wick. Two further facts the old ramp missed: the tip is yellow-orange
 * (cooler, thin), not white; and the base of the white region is ROUND — the
 * white-hot region is simply an INSET of the outline, wide where the flame is
 * wide and absent where it is thin.
 *
 * ⚠️ THE OLD RAMP NEVER REACHED ORANGE ON SCREEN, and nothing noticed. The
 * flame colour was fed to the shader as a raw hex byte-parse (`hexToRgb01` — the
 * right call for Foundry's gamma-space LIGHT shaders) but this material writes
 * LINEAR light into `scene.lit`, which is then sRGB-encoded for display. A
 * #f8901c fed in unconverted DISPLAYS as #fcc65d — a pale gold — and every
 * "deeper" stop derived from it stayed yellow: the shipped flames in the lab
 * show cream and gold and not one pixel of orange-red or blue. The authored
 * colour is now DECODED (sRGB → linear) before use, so the mid stop displays as
 * exactly the colour that was picked, and the fixed hot/cold stops below are
 * written as the sRGB colours they are meant to look like.
 *
 * COLOUR IS A FUNCTION OF THE INSET — `inset` ≈ 0 at the outline, ≈ 1 on the axis
 * of the widest part (see the shader for how it is measured). Read rim → core:
 * deep rim → the authored colour → gold → pale yellow → the white-hot core. The
 * hot/cold stops are MIXED with the authored colour (a little of it survives in
 * the white), so a recoloured candle recolours the whole ramp rather than being
 * flat tinted paper.
 */
const FLAME_CREAM = srgbHexToLinear('#fff7df'); // the white-hot core
const FLAME_PALE_YELLOW = srgbHexToLinear('#ffe98a'); // the first yellow past the core
const FLAME_GOLD = srgbHexToLinear('#fdc22a'); // the golden band
const FLAME_BLUE = srgbHexToLinear('#3558ff'); // the base of the flame, round the wick
const FLAME_CORE_TINT = 0.1; // how much of the authored colour survives in the white core
const FLAME_YELLOW_TINT = 0.25; // … in the pale-yellow band
const FLAME_GOLD_TINT = 0.45; // … in the golden band
/** The deep rim = the authored colour pulled toward red and darkened, per channel. */
const FLAME_RIM_MUL = [0.6, 0.3, 0.22];
/** Colour stops along the INSET, each a [from, to] smoothstep, read rim → core. */
const FLAME_STOP_MID = [0.02, 0.12];
const FLAME_STOP_GOLD = [0.12, 0.3];
const FLAME_STOP_YELLOW = [0.24, 0.44];
const FLAME_STOP_CORE = [0.38, 0.6];
/** The blue base: how far up the flame it reaches (fraction of the height), how
 * far in from the outline it goes at the very base, and how much of it shows. */
const FLAME_BLUE_REACH = 0.38;
const FLAME_BLUE_DEPTH = 0.32;
const FLAME_BLUE_STRENGTH = 0.85;
/** The tip runs a little dimmer than the body (photos: thin and yellow-orange). */
const FLAME_TIP_DIM = 0.12;
/** The base runs dimmer too — the dark zone round the wick. */
const FLAME_BASE_DIM = 0.55;

/**
 * ============================================================================
 * THE BRIGHTNESS PROFILE (HDR) + THE FALLOFF
 * ============================================================================
 *
 * Emission across the flame, in linear HDR units, as a function of the inset: a
 * white-hot core (`FLAME_E_CORE`) that falls to a ~1 shoulder (`FLAME_E_SHOULDER`)
 * and then a dim rim. The core is deliberately FAR above 1 — bloom thresholds
 * the scene's HDR luma (bloom.js, default 1.52), so a core that merely reaches
 * "white" sits on the edge of it and a flame mid-flicker never crosses, while
 * one at ~4-5 blooms easily (author, 2026-10-08: "bright enough that they
 * trigger bloom easily") — HDR emission, not a whiter colour. The shoulder is
 * ~1.3-1.8 on purpose: the colour stops only DISPLAY as themselves where the
 * emission is about that; much higher and the orange washes out to yellow-white,
 * much lower and it goes to brown (both seen in the lab).
 *
 * LIGHT PARITY, MEASURED: a flame that is prettier but DIMMER was not the brief
 * (author, 2026-10-08, one turn earlier: "very dim"). Time-averaged over 8 moments
 * x 10 candles at 24/30/40/56 px, the visible light this emits relative to the
 * shader it replaced was 0.88x at the first-cut bulb width and brightness; the
 * bulb radius (0.17 → 0.185) and shoulder (1.7 → 1.8) were retuned until it read
 * 0.97 / 0.99 / 1.00 / 1.01x. (The old flares were unrealistically huge blobs —
 * parity is on average, not frame for frame.)
 *
 * THE FALLOFF IS ONE CONTINUOUS CURVE ACROSS THE EDGE. Inside the silhouette
 * the brightness fades to `FLAME_HALO_LEVEL` of the rim's value (not to zero);
 * outside it decays from that same value exponentially. A body that fades to
 * zero at the edge with a halo that starts from non-zero outside it draws a
 * dark ring exactly on the outline — the photographs have the opposite: bright
 * body → dim red-brown edge → a glow that gently dies away.
 */
const FLAME_E_CORE = 6.0; // the white-hot HDR core (bloom)
const FLAME_E_SHOULDER = 1.8; // the body's brightness once past the core, at a mid-life emission level
const FLAME_E_CORE_POW = 1.4; // >1 keeps the core wide, drops it late and fast
const FLAME_E_CORE_FROM = 0.3; // inset where the HDR core starts to rise out of the shoulder …
const FLAME_E_CORE_TO = 1.0; // … and where it reaches its full value (the axis of the widest part)
const FLAME_E_RIM_WIDTH = 0.12; // inset over which the dim rim comes up to the shoulder
const FLAME_E_RIM_FRAC = 0.55; // … from this fraction of itself at the outline
const FLAME_HALO_LEVEL = 0.28;
const FLAME_HALO_WIDTH = 0.06; // e-folding distance, quad fractions (× the width scale)
/** THE OPAQUE MIDDLE (author, 2026-10-08: "opaque in the middle"). Where the
 * inset is inside this band the flame stops ADDING to the floor and REPLACES it,
 * so the body does not go see-through over a bright map. The rim stays additive. */
const FLAME_OPAQUE_INSET = [0.1, 0.35];

/** GPU WIND (2026-07-20, author: "candles in a drafty castle"). The flame tip's
 * MAX displacement from the wind field, in quad fractions — a hard gust leans
 * the flame most of the way to the quad edge. See `sampleWind` (world/wind-field.js). */
const FLAME_WIND_MAX = 0.34;

/**
 * WIND-DRIVEN GUTTER + SNUFF (2026-07-21, Wind.md §6: "strong enough local
 * wind → the flame gutters, or a real draft snuffs the candle" — this is
 * that bonus emergent beat, wired). Thresholds are set against the RAW
 * `sampleWind` magnitude (`length(gust)`, BEFORE `FLAME_WIND_MAX`'s own
 * "how far this moves visually" scale, but AFTER the effect's own
 * `windResponse` gain) — `effects/lighting/animations/candle-flicker.js`
 * mirrors these SAME constants against that SAME raw magnitude (both files
 * sample the identical shared field at the identical position), so a single
 * gust reliably gutters/snuffs the flame and the candle's own cast light
 * together, never one before the other.
 *
 * SNUFF IS DELIBERATELY STATELESS — a smooth dim toward zero WHILE the local
 * wind is that strong, recovering the instant it eases, never a persisted
 * "this candle is out until someone relights it" flag. A real relight state
 * machine (anchor-level persistence, a GM interaction to relight, surviving
 * a scene reload) is a materially bigger, separate feature — named here so
 * it reads as a deliberate scope line, not an oversight.
 *
 * Tuned by eye against the rough magnitude ranges `sampleWind`'s own terms
 * can reach (organic noise ~0..1.4 always present; +~1 from a dialled-in
 * gale; +~1.6 at a door-gust's peak — see world/wind-sim.js's own header for
 * the transient sim's magnitude story) — NOT live-verified (this session has
 * no Foundry access; see the keyhole-wind-tier2-transient-sim memory).
 */
/**
 * ⭐ RETUNED FROM REAL CANDLE PHYSICS (2026-09-04, mythica-machina-press#499's
 * consumer-retune pass), REPLACING 1.3 / 1.0 / 2.2 / 3.2.
 *
 * ⚠️ THE OLD NUMBERS WERE NOT MERELY MISTUNED, THEY HAD BEEN ORPHANED. They
 * were set against a field whose magnitude ran to ~3.4 at full wind, because
 * the old organic drift/gust/flutter layer contributed ~0..1.4 ON TOP of the
 * coherent term at ALL times. Stage 2 deleted that layer and replaced the
 * clamped turbulence with a real intensity (`σ = I·U`, I ≈ 0.16 in the open),
 * so an exposed point at FULL gale now peaks near 1.16. A gutter threshold of
 * 1.3 and a snuff span of 2.2-3.2 sit above anything the field can now
 * produce: left alone, a candle would never gutter or blow out again at any
 * setting — a silent feature loss, which is exactly what the retune step
 * exists to catch.
 *
 * DERIVED, NOT RE-EYEBALLED. Now that the dial has real units
 * (`world/wind-scale.js`), these come from what actually happens to a candle:
 * a flame starts to gutter in a 1.5 m/s draught, is guttering hard by 3 m/s,
 * begins to blow out around 4 m/s and is reliably out by 7 m/s. Converting
 * through Beaufort and scaling by the field's own composition at an exposed
 * point (coherent + ~16% turbulence ⇒ magnitude ≈ 1.16 × speed01):
 *
 * ```
 *   1.5 m/s → speed01 0.123 → magnitude 0.14   (dial 12)  gutter begins
 *   3   m/s → speed01 0.195 → magnitude 0.23   (dial 20)  guttering hard
 *   4   m/s → speed01 0.237 → magnitude 0.27   (dial 24)  starts to snuff
 *   7   m/s → speed01 0.344 → magnitude 0.40   (dial 34)  reliably out
 * ```
 *
 * A candle outdoors in a light breeze genuinely does gutter, so the new
 * numbers make candles MUCH more wind-sensitive in dial terms than the old
 * ones did — which is correct. An INDOOR candle is unaffected either way:
 * `openness` gates its coherent term toward zero, so its magnitude never
 * approaches these thresholds, and its atmospheric flicker comes from
 * `candleLife`'s own noise regardless.
 */
const WIND_GUTTER_MAG_THRESHOLD = 0.14;
const WIND_GUTTER_MAG_RANGE = 0.09;
const WIND_SNUFF_MAG_LOW = 0.27;
const WIND_SNUFF_MAG_HIGH = 0.4;

/** FLAME ANIMATION (2026-07-20, tiered — author: "more chaotic… bend, curl,
 * flicker, gutter, elongate/shorten, evolve; near candles must NOT react the
 * same way"). Every noise below is phased by a PER-CANDLE seed (flameHash of the
 * wick's world position), so even candles a pixel apart dance independently —
 * the fix for identical neighbours. Tier-gated (see buildCandleFlameMaterial). */
const FLAME_LIFE_SLOW = 0.5; // per-candle brightness/size/length envelope octaves
const FLAME_LIFE_MID = 2.1;
const FLAME_LIFE_FAST = 6.3;
const FLAME_LIFE_SLOW_W = 0.3;
const FLAME_LIFE_MID_W = 0.16;
const FLAME_LIFE_FAST_W = 0.09;
const FLAME_GUTTER_RATE = 0.6; // COLD PERIODS — a slow noise that occasionally
const FLAME_GUTTER_DEPTH = 0.88; // guts the flame nearly out, then it revives
const FLAME_EMIT_FLOOR = 0.12; // guttered (cold) emission level …
const FLAME_EMIT_CEIL = 1.4; // … up to a flare
const FLAME_REST_LEN_BASE = 0.34; // wick → tip length when calm/guttered …
const FLAME_REST_LEN_LIFE = 0.22; // … plus this much when alive → elongates/shortens
const FLAME_SIZE_BASE = 0.75; // base WIDTH scale: shrinks in the cold …
const FLAME_SIZE_LIFE = 0.4; // … swells when alive
const FLAME_SIZE_BREATHE = 0.08;
const FLAME_BREATHE_RATE = 0.9;
const FLAME_TAIL_LIFE = 0.7; // the wind tail also elongates with life
const FLAME_CURL_RATE = 2.4; // per-candle bend that DESYNCS neighbours' tails
const FLAME_CURL_AMP = 0.7; // curl strength relative to the coherent gust

/**
 * A per-candle pseudo-random in [0,1] from the wick's WORLD position — the
 * classic GLSL sin-hash. Well-separated even for candles a pixel apart (a 1px
 * move shifts the sin argument by ~13 radians), so it desyncs neighbouring
 * flames' flicker/size/gutter/curl phases — the fix for "all the candles near
 * each other react the exact same way." Not a quality PRNG, just a stable,
 * well-mixed phase offset (same role as deriveCandleSeed, but GPU-side).
 * @param {*} TSL @param {*} p - a vec2 node (the wick's world xy).
 * @returns {*} a float node in [0,1].
 */
function flameHash(TSL, p) {
  const { float, vec2, dot, sin, fract } = TSL;
  return fract(sin(dot(p, vec2(float(12.9898), float(78.233)))).mul(float(43758.5453)));
}

// The pure candle math (colour parsing, per-anchor override resolution, the
// light-source builder + clustering, the flame vertex-array bake, and — since
// 2026-10-08 — the flame's silhouette profile and length limit) lives in
// candle-flame-geometry.js (split out 2026-07-25, the size-ratchet god-object
// reversal) — none of it touches THREE/TSL, which is why it carries the
// runtime's entire Node test suite there. Imported at the top of this file.

/**
 * Build (or fill) a THREE.BufferGeometry for the flame billboards. Kept thin so
 * the geometry MATH stays in `computeCandleFlameArrays` (Node-tested) and only
 * the GPU-object glue is here.
 * @param {*} THREE @param {Array<{x:number,y:number}>} anchors @param {{sizePx:number}} opts
 * @returns {{geometry: *, quadCount: number}}
 */
export function buildCandleFlameGeometry(THREE, anchors, opts) {
  const { positions, uvs, centers, exposures, colors, intensities, expectedDepths, indices, quadCount } =
    computeCandleFlameArrays(anchors, opts);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('center', new THREE.BufferAttribute(centers, 2));
  geometry.setAttribute('windExposure', new THREE.BufferAttribute(exposures, 1));
  geometry.setAttribute('flameColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('flameIntensity', new THREE.BufferAttribute(intensities, 1));
  // THE DEPTH-AUTHORITY GATE'S OWN INPUT — see computeCandleFlameArrays' own doc.
  geometry.setAttribute('expectedDepth', new THREE.BufferAttribute(expectedDepths, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // Draw only the quads actually filled — matters only if the belt-and-braces
  // finite check dropped an anchor (the authority guarantees it never does), in
  // which case the buffers hold trailing zeros that would draw degenerate tris.
  geometry.setDrawRange(0, quadCount * 6);
  return { geometry, quadCount };
}

/**
 * Build the flame's TSL material — a smooth teardrop (see THE SHAPE above).
 * `uIntensity` (a master brightness multiplier) is created here and returned
 * for the viewer to drive from the resolved params (the same "uniforms out,
 * update .value per frame" contract point-light-illumination.js uses). Colour
 * and PER-CANDLE brightness are no longer a uniform — see the new
 * `flameColor`/`flameIntensity` per-vertex attributes below
 * (computeCandleFlameArrays' own header explains why: a single uColor uniform
 * could not express "this one candle is recoloured").
 *
 * GPU WIND (2026-07-20, moved to world/wind-field.js 2026-07-21 — Wind.md
 * Tier 0) — the flame tip is bent by the SHARED wind field (`sampleWind`),
 * read per-candle from the baked `center`/`windExposure` geometry attributes
 * + `uGlobalTimeMs`. The candle LIGHT (candle-flicker.js) samples the SAME
 * function at the SAME position now too — the two used to lean in different
 * winds; see world/wind-field.js's own header for that bug and the fix. No
 * per-flame CPU, no geometry rebuild per frame: the batched billboard leans
 * entirely on the GPU, each flame by its own world-position gust, indoor
 * candles shielded, outdoor candles swaying.
 *
 * ============================================================================
 * HOW A FRAGMENT IS SHADED
 * ============================================================================
 *
 * 1. THE FRAME. The tip vector (rest length from the life envelope + manual
 *    lean + wind lean + per-candle curl, then smoothly length-limited) defines
 *    a chord from the wick. `ax` is the distance along it, `lat` across it.
 * 2. THE BEND. The centre line is bowed off the chord (arc + sway + lick) —
 *    `lat` becomes the distance from that bowed line.
 * 3. THE PROFILE. `w(s)` (see THE SHAPE) gives the half-width at this height;
 *    `f = |lat| − w` is the (signed) distance to the outline, negative inside.
 * 4. COLOUR + BRIGHTNESS are functions of the INSET — how far inside the outline
 *    this fragment is, as a fraction of the base radius (see THE COLOUR): the
 *    white-hot core, the yellow → gold → orange → red-brown rim, the blue base.
 * 5. FALLOFF: one continuous curve across the edge (body → halo).
 * 6. OPACITY: the middle replaces what is under it; the rim adds to it.
 *
 * Additive blending makes the rim GLOW over the lit scene regardless of scene
 * darkness — a flame emits light, it is not lit by it — and overlapping flames
 * add. `side: DoubleSide` sidesteps quad winding under the flipped camera.
 * Multi-arg TSL calls use the FUNCTION form (`smoothstep`/`clamp`/`mix`/`length`/
 * `dot`/`max`) — the `.mix()`-as-method trap (reference_tsl_method_chaining_trap)
 * applies to all of them. `smoothstep` is NEVER given reversed edges (undefined
 * in WGSL) — a falling edge is `1 − smoothstep(lo, hi, x)`.
 *
 * PER-CANDLE CHAOTIC LIFE (2026-07-20, tiered) — the flame no longer holds one
 * static shape. A per-candle seed (flameHash) phases a chaotic LIFE envelope
 * (with COLD gutter periods), which drives its EMISSION (flicker/gutter), its
 * LENGTH (elongate/shorten), and its WIDTH (swell/shrink); the wind bends it
 * and a per-candle curl desyncs neighbours.
 *
 * TIERS (graph-build-time `quality`, from the candle effect's animationQuality
 * param — no-uniform-gates: a lower tier never builds the higher tier's nodes):
 *   0 "low"      — a calm flame: a gentle per-candle emission flicker + a small
 *                  length pulse. No wind, no gutter, no sway. Cheapest.
 *   1 "standard" — full LIFE: chaotic flicker with cold gutter periods, wind
 *                  lean (coherent gust + per-candle curl), arc + sway, width and
 *                  length pulsing.
 *   2 "lavish"   — + a slow S-wave travelling up the flame (smooth, never at the
 *                  edge) — the flame licks.
 *
 * @param {{THREE: *, uGlobalTimeMs?: *, quality?: number, windHandle?: object, depthTexNode?: *, depthFlagsTexNode?: *}} args -
 *   `uGlobalTimeMs` is the shared clock (the viewer's one clock); when
 *   absent the flame rests. `quality` is the build-time tier (default 2).
 *   `windHandle` is `world/wind-access.js#createWindHandle`'s product — the
 *   ambient bias, Tier 1's baked openness, the wall-avoidance field and Tier
 *   2's transient all ride INSIDE it (Wind.md §5.1), replacing the four
 *   separate arguments this used to forward by hand into `sampleWind`. Omit it
 *   entirely for byte-identical Tier-0 behaviour (a flame that only knows the
 *   organic gust noise). `depthTexNode` — `buf:scene.depth`, UNSAMPLED — wires
 *   the DEPTH-AUTHORITY gate lightning and the point-light pool already use
 *   (`point-light-illumination.js#buildDepthHeightGateNode`); `depthFlagsTexNode`
 *   is its optional flag payload (tile-restricts-light). Omit both for a flame
 *   that ignores floor occlusion entirely (byte-identical pre-gate behaviour).
 * @returns {{material: *, uIntensity: *, uLean: *, uWindResponse: *}}
 */
export function buildCandleFlameMaterial({
  THREE,
  uGlobalTimeMs,
  quality = 2,
  windHandle = TIER0_WIND_HANDLE,
  depthTexNode,
  depthFlagsTexNode = null,
}) {
  const {
    uv,
    uniform,
    attribute,
    vec2,
    vec3,
    vec4,
    float,
    length,
    dot,
    clamp,
    smoothstep,
    mix,
    max,
    min,
    pow,
    abs,
    sqrt,
    exp,
    sin,
    fwidth,
    step,
    screenUV,
    mx_noise_float: perlin,
  } = THREE.TSL;

  const uIntensity = uniform(float(1));
  // A MANUAL tip-displacement override (default 0), kept for compatibility and
  // any future authored wind; the live GPU wind below adds ON TOP of it.
  const uLean = uniform(vec2(0, 0));
  // WIND RESPONSE (effects/candle-flame.js's `windResponse` param, Wind.md
  // §8.1) — the ONE live-updatable gain over everything wind touches below:
  // lean/curl, gutter pressure, and snuff. Default 1 (the tuned reference);
  // 0 makes this candle wind-inert regardless of how hard it's blowing.
  const uWindResponse = uniform(float(1));

  // Baked per-vertex: the wick's world position + its sky exposure + its
  // resolved colour/brightness. computeCandleFlameArrays already decided
  // "does this candle override X" on the CPU when the geometry was built —
  // the shader just reads the result, never re-decides it.
  const centerXY = attribute('center', 'vec2');
  const windExposure = attribute('windExposure', 'float');
  const flameColor = attribute('flameColor', 'vec3');
  const flameIntensity = attribute('flameIntensity', 'float');
  const flameExpectedDepth = attribute('expectedDepth', 'float');

  // PER-CANDLE SEED + TIME PHASE — the desync fix (see flameHash). Every noise
  // reads `pt` (time offset by the candle's own seed), so neighbours differ.
  const seed = flameHash(THREE.TSL, centerXY);
  const seed2 = flameHash(THREE.TSL, centerXY.add(vec2(float(37.1), float(91.7))));
  const time = uGlobalTimeMs ? uGlobalTimeMs.mul(float(0.001)) : float(0); // ms → ~s
  const pt = time.add(seed.mul(float(1000)));
  const phase = seed2.mul(float(50));
  const nz = (rate, off) => perlin(vec2(pt.mul(float(rate)).add(off), phase));

  // THE SHARED FIELD, sampled ONCE (tier ≥1 only — tier 0 stays wind-inert by
  // design, "no wind, no gutter, no warp"), reused by BOTH the life/gutter
  // term below and the tip lean further down — was two separate concerns
  // reading two separate samples before wind-driven gutter existed; now one
  // sample feeds both, so they can never disagree about "how windy is it
  // right now" the way flame/light used to disagree before Wind.md Tier 0.
  let gust = null;
  let windMag = float(0);
  if (quality >= 1 && uGlobalTimeMs) {
    gust = windHandle.node(THREE.TSL, {
      centerXY,
      time: uGlobalTimeMs,
    });
    windMag = length(gust).mul(uWindResponse);
  }

  // LIFE — a per-candle [0,1] envelope. Tier ≥1: chaotic multi-octave with COLD
  // gutter periods (a slow noise that guts it nearly out, then it revives) —
  // NOW WITH A REAL WIND CONTRIBUTION on top of the atmospheric random one
  // (see WIND_GUTTER_MAG_* header): a strong local gust ADDS its own gutter
  // pressure (`max`, never subtracting — wind can only make a dip MORE
  // likely/deeper, never suppress the random ones a real candle also has).
  // Tier 0: a calm gentle flicker, no gutter mechanic at all.
  let life;
  if (quality >= 1) {
    const base = clamp(
      float(0.5)
        .add(nz(FLAME_LIFE_SLOW, float(0)).mul(float(FLAME_LIFE_SLOW_W)))
        .add(nz(FLAME_LIFE_MID, float(7)).mul(float(FLAME_LIFE_MID_W)))
        .add(nz(FLAME_LIFE_FAST, float(17)).mul(float(FLAME_LIFE_FAST_W))),
      float(0),
      float(1)
    );
    const noiseCold = smoothstep(float(0.5), float(0.88), nz(FLAME_GUTTER_RATE, float(31)));
    const windCold = clamp(
      windMag.sub(float(WIND_GUTTER_MAG_THRESHOLD)).div(float(WIND_GUTTER_MAG_RANGE)),
      float(0),
      float(1)
    );
    const cold = max(noiseCold, windCold);
    life = clamp(base.mul(float(1).sub(cold.mul(float(FLAME_GUTTER_DEPTH)))), float(0), float(1));
  } else {
    life = clamp(float(0.5).add(nz(FLAME_LIFE_MID, float(0)).mul(float(0.22))), float(0), float(1));
  }

  // THE TIP (wick → tip). A length that pulses with life (the flame elongating/
  // shortening), plus — tier ≥1 — the wind lean + a per-candle curl (so
  // neighbours' tips point differently), the whole thing elongating further
  // with life. The wick end stays pinned at (0,0).
  const restLen = float(FLAME_REST_LEN_BASE).add(life.mul(float(FLAME_REST_LEN_LIFE)));
  let tip = uLean.add(vec2(float(FLAME_REST_CURL_X), restLen.negate()));
  if (gust) {
    const curl = vec2(nz(FLAME_CURL_RATE, float(3)), nz(FLAME_CURL_RATE, float(29)))
      .mul(float(FLAME_CURL_AMP))
      .mul(clamp(windExposure, float(0.25), float(1)));
    const lean = gust
      .add(curl)
      .mul(float(FLAME_WIND_MAX))
      .mul(uWindResponse)
      .mul(float(1).add(life.mul(float(FLAME_TAIL_LIFE))));
    tip = tip.add(lean);
  }

  // The tip as a chord: its length SMOOTHLY limited (the same expression as
  // `limitFlameLength` in candle-flame-geometry.js, which the Node tests pin: it
  // can never leave the quad), its direction and across-the-flame normal. `tipLen`
  // replaces |tip| everywhere below; the direction is untouched, so the wind
  // still steers exactly as before.
  const tipLenRaw = max(length(tip), float(1e-4));
  const tipLen = tipLenRaw.div(
    pow(float(1).add(pow(tipLenRaw.div(float(FLAME_LEN_MAX)), float(FLAME_LEN_ORDER))), float(1 / FLAME_LEN_ORDER))
  );
  const dir = tip.div(tipLenRaw);
  const nrm = vec2(dir.y.negate(), dir.x);

  // WIDTH — the bulb swells when alive, shrinks in the cold (tier ≥1).
  const sizeScale =
    quality >= 1
      ? max(
          float(FLAME_SIZE_BASE)
            .add(life.mul(float(FLAME_SIZE_LIFE)))
            .add(nz(FLAME_BREATHE_RATE, float(61)).mul(float(FLAME_SIZE_BREATHE))),
          float(0.3)
        )
      : float(1);
  const baseR = float(FLAME_BASE_RADIUS).mul(sizeScale);

  // THE FRAME COORDINATES of this fragment: along the chord from the wick, and across it.
  const p = uv().sub(vec2(0.5, 0.5));
  const ax = dot(p, dir);
  const lat = dot(p, nrm);
  const tAlong = clamp(ax.div(tipLen), float(0), float(1)); // 0 at the wick, 1 at the tip

  // THE BEND — a smooth bowing of the centre line off the chord. See THE BEND.
  //  · ARC: pull the base back toward vertical on a leaned flame. `lean` is the
  //    chord's sideways-per-upward ratio; the parabola 4t(1−t) is zero at both
  //    ends, so the wick and the tip stay exactly where the chord puts them.
  //  · SWAY (tier ≥1): a slow per-candle S, a tip offset growing as t².
  //  · LICK (tier 2): a slow wave travelling up the flame, growing toward the tip.
  const leanRatio = clamp(dir.x.div(max(dir.y.negate(), float(0.3))), float(-1.5), float(1.5));
  let bend = leanRatio
    .mul(tipLen)
    .mul(float(-FLAME_ARC))
    .mul(tAlong.mul(float(1).sub(tAlong)));
  if (quality >= 1) {
    const swayAmp = float(FLAME_SWAY_AMP).mul(clamp(windExposure, float(0.25), float(1)));
    bend = bend.add(nz(FLAME_SWAY_RATE, float(43)).mul(swayAmp).mul(tAlong.mul(tAlong)));
  }
  if (quality >= 2) {
    const wave = sin(
      tAlong
        .mul(float(FLAME_LICK_WAVES * 2 * Math.PI))
        .sub(time.mul(float(FLAME_LICK_SPEED)))
        .add(seed.mul(float(2 * Math.PI)))
    );
    bend = bend.add(
      wave
        .mul(float(FLAME_LICK_AMP))
        .mul(tAlong)
        .mul(float(1).sub(tAlong.mul(float(0.4))))
    );
  }
  const latB = lat.sub(bend);

  // THE PROFILE — half-width at this height (see THE SHAPE). `s` runs from the
  // lowest point of the bulb (0) to the tip (1).
  const aBot = baseR.mul(float(-FLAME_BULB_DROP));
  const span = tipLen.sub(aBot);
  const sRaw = ax.sub(aBot).div(span);
  const sAlong = clamp(sRaw, float(0), float(1));
  // ⚠️ MASKED to the flame's own length. `sAlong` is clamped, so without the mask
  // the half-width at s = 0 (small but not zero — it is s^0.5) would be held
  // constant for every fragment BELOW the bulb and draw a hairline straight down
  // the quad. Zero outside [0, 1], and the floor on `pow`'s base is far below it.
  const inRange = step(float(0), sRaw).mul(step(sRaw, float(1)));
  const w = baseR
    .mul(float(FLAME_PROFILE_NORM))
    .mul(pow(max(sAlong, float(1e-9)), float(FLAME_PROFILE_BOTTOM)))
    .mul(pow(max(float(1).sub(sAlong), float(1e-9)), float(FLAME_PROFILE_TIP)))
    .mul(inRange);

  // THE EDGE. `f` < 0 inside the outline. `cov` is 0 at the outline and ramps to
  // 1 across a band that is the WIDER of a pixel-width AA band (from the
  // derivative of `f` itself, so it is right at every size and orientation, and
  // a hair-thin tip fades rather than shimmers) and a soft band proportional to
  // the local half-width.
  const f = abs(latB).sub(w);
  const soft = max(max(w.mul(float(FLAME_EDGE_SOFT)), fwidth(f).mul(float(FLAME_AA_PX))), float(1e-5));
  const cov = smoothstep(float(0), soft, f.negate());

  // HOW FAR INSIDE THE OUTLINE (the INSET) drives the colour and the brightness —
  // not the position across the LOCAL width. Measured against the photographs, the
  // white-hot region is simply an inset of the outline: wide where the flame is wide,
  // gone where it is thin. Normalising by the local width instead (the first cut) made
  // the white pinch to a needle point at the base and stay white all the way to the
  // tip, where the photos run yellow-orange and the base runs orange-then-blue.
  //   `f` is not a true distance (|∇f| = √(1 + w'²), steep along the outline's slanted
  // ends), so it is divided by that gradient to get one, then by the base radius so the
  // bands scale with the flame: inset ≈ 1 on the axis of the widest part, 0 at the edge.
  const sSafe = clamp(sAlong, float(0.02), float(0.98));
  const wPrime = w
    .mul(
      float(FLAME_PROFILE_BOTTOM)
        .div(sSafe)
        .sub(float(FLAME_PROFILE_TIP).div(float(1).sub(sSafe)))
    )
    .div(span);
  const depthSides = max(f.negate(), float(0)).div(sqrt(float(1).add(wPrime.mul(wPrime))));
  //   …which breaks down at the round bottom, where the true inset curve is a CIRCLE (the
  // first-order estimate pinches it to a V). Near the bottom, the exact distance to the
  // bulb's own circle (radius = the profile's curvature radius at its lowest point) takes
  // over, blended out by the time that circle has reached its widest.
  const rhoV = baseR
    .mul(float(FLAME_PROFILE_NORM))
    .mul(baseR.mul(float(FLAME_PROFILE_NORM)))
    .div(span.mul(float(2)));
  const yBulb = ax.sub(aBot);
  const depthCircle = max(rhoV.sub(length(vec2(latB, rhoV.sub(yBulb)))), float(0));
  const bottomness = float(1).sub(smoothstep(rhoV.mul(float(0.5)), rhoV, yBulb));
  const depth = mix(depthSides, min(depthSides, depthCircle), bottomness);
  const inset = depth.div(baseR);
  const tipness = smoothstep(float(0.35), float(1), sAlong);

  // BRIGHTNESS PROFILE (HDR): a white-hot core falling to a ~1 shoulder, then a dim rim —
  // dimmed toward the tip and toward the wick.
  const hdrCore = smoothstep(float(FLAME_E_CORE_FROM), float(FLAME_E_CORE_TO), inset);
  const shoulder = float(FLAME_E_SHOULDER).add(
    float(FLAME_E_CORE - FLAME_E_SHOULDER).mul(pow(hdrCore, float(FLAME_E_CORE_POW)))
  );
  const rimFade = mix(float(FLAME_E_RIM_FRAC), float(1), smoothstep(float(0), float(FLAME_E_RIM_WIDTH), inset));
  const baseDim = mix(float(FLAME_BASE_DIM), float(1), smoothstep(float(0), float(0.22), sAlong));
  const brightness = shoulder
    .mul(rimFade)
    .mul(float(1).sub(tipness.mul(float(FLAME_TIP_DIM))))
    .mul(baseDim);

  // COLOUR. The authored colour is an sRGB hex (see THE COLOUR) — decode it, so
  // the mid stop displays as exactly what was picked; the hot and cold stops are
  // derived from it, then the fixed blue of the base. Read from the rim inward:
  // deep rim → the authored colour → gold → pale yellow → the white-hot core.
  const midLin = pow(max(flameColor, vec3(float(0))), vec3(float(2.2)));
  const coreCol = mix(vec3(...FLAME_CREAM), midLin, float(FLAME_CORE_TINT));
  const yellowCol = mix(vec3(...FLAME_PALE_YELLOW), midLin, float(FLAME_YELLOW_TINT));
  const goldCol = mix(vec3(...FLAME_GOLD), midLin, float(FLAME_GOLD_TINT));
  const rimCol = midLin.mul(vec3(...FLAME_RIM_MUL));
  let colorOut = mix(rimCol, midLin, smoothstep(float(FLAME_STOP_MID[0]), float(FLAME_STOP_MID[1]), inset));
  colorOut = mix(colorOut, goldCol, smoothstep(float(FLAME_STOP_GOLD[0]), float(FLAME_STOP_GOLD[1]), inset));
  colorOut = mix(colorOut, yellowCol, smoothstep(float(FLAME_STOP_YELLOW[0]), float(FLAME_STOP_YELLOW[1]), inset));
  colorOut = mix(colorOut, coreCol, smoothstep(float(FLAME_STOP_CORE[0]), float(FLAME_STOP_CORE[1]), inset));
  // The blue base: strongest at the outline of the lowest part of the flame, fading
  // upward and inward — it hugs the lower outline, as in the photographs.
  const blueMask = float(1)
    .sub(smoothstep(float(0), float(FLAME_BLUE_REACH), sAlong))
    .mul(float(1).sub(smoothstep(float(0), float(FLAME_BLUE_DEPTH), inset)));
  colorOut = mix(colorOut, vec3(...FLAME_BLUE), blueMask.mul(float(FLAME_BLUE_STRENGTH)));

  // THE FALLOFF — one curve across the edge (see THE BRIGHTNESS PROFILE).
  // `dist` = distance outside the outline (0 inside), including the axial
  // overshoot past the tip / below the bulb; the window keeps the halo from ever
  // reaching the quad's own square border.
  const axialOver = max(max(aBot.sub(ax), float(0)), max(ax.sub(tipLen), float(0)));
  const dist = length(vec2(max(f, float(0)), axialOver));
  const haloFall = exp(dist.negate().div(float(FLAME_HALO_WIDTH).mul(sizeScale)));
  const window = float(1).sub(smoothstep(float(0.3), float(0.5), max(abs(p.x), abs(p.y))));
  const falloff = float(FLAME_HALO_LEVEL)
    .mul(haloFall)
    .mul(window)
    .add(float(1 - FLAME_HALO_LEVEL).mul(cov));

  // EMISSION LEVEL — guttering: near-dark in a cold period, a flare when alive
  // (tier ≥1); a gentle flicker at tier 0. Then the per-candle brightness, the
  // wind snuff and the depth gate, which dim the WHOLE flame (body, rim, halo).
  const emitLevel =
    quality >= 1 ? mix(float(FLAME_EMIT_FLOOR), float(FLAME_EMIT_CEIL), life) : mix(float(0.75), float(1.1), life);
  let vis = emitLevel.mul(uIntensity).mul(flameIntensity); // per-candle brightness (the anchor's own `intensity` param, finally read by the flame itself)
  // SNUFF — see WIND_SNUFF_MAG_* header: a genuinely extreme local gust
  // extinguishes the flame's visible emission, smoothly, STATELESS (recovers
  // the instant the gust passes — see that constant's own doc for why this
  // is deliberately not a persisted relight mechanic). Gated on `gust`
  // (quality ≥1 only, same as the lean above) — tier 0 stays truly wind-
  // inert, no extra always-zero node, matching its own "no wind, no gutter,
  // cheapest" promise (tsl/no-uniform-gates' own spirit: a tier that pays
  // for wind math it never uses is not actually cheaper).
  if (gust) {
    const snuff = smoothstep(float(WIND_SNUFF_MAG_LOW), float(WIND_SNUFF_MAG_HIGH), windMag);
    vis = vis.mul(float(1).sub(snuff));
  }

  // ============================================================================
  // THE DEPTH-AUTHORITY OCCLUSION GATE — the SAME node lightning and the
  // point-light pool already use (`point-light-illumination.js#
  // buildDepthHeightGateNode`), applied to the flame SPRITE itself. A
  // candle's cast LIGHT already flowed through the point-light pool; the
  // flame you actually SEE is a separate batched mesh that used to carry its
  // own OLDER gate — a lossy, per-floor-relative, quantized-to-16-levels
  // `buf:scene.attr` byte (`keyhole-depth-authority-sole-system-decision`) —
  // which is what produced candles that stayed dark/invisible on an upper
  // floor even with their light correctly showing. This is the same rebuild
  // lightning's own bolt already got: a bare ordinal compare against
  // `buf:scene.depth`, no smoothstep tolerance, no sentinel concept.
  //
  // ⚠️ `screenUV`, never the bare node — `buf:scene.depth` is a SCREEN-space
  // buffer and this is a WORLD-space billboard batch; a bare `texture()` node
  // would default to this mesh's OWN `uv` (which DOES exist here, unlike a
  // light's fan — but it is the flame's LOCAL 0..1 quad coordinate, not a
  // screen coordinate, so it would sample the wrong thing just as surely as
  // no uv at all — `feedback_shared_texture_node_carries_the_wrong_uv`).
  //
  // `flameExpectedDepth` is baked PER-CANDLE at geometry build time
  // (`computeCandleFlameArrays`), from the viewer's own candle-specific
  // `resolveExpectedDepth` closure — not a uniform, since this mesh batches
  // every visible candle into ONE draw call, and different candles can
  // legitimately sit on different floors (`scene/anchor-authority.js`'s
  // `own-and-above` visibility). A JS-time branch, not a uniform gate: with
  // no `depthTexNode` this material is byte-identical to before the gate
  // existed.
  if (depthTexNode) {
    const depthHere = depthTexNode.sample(screenUV);
    const flagsHere = depthFlagsTexNode ? depthFlagsTexNode.sample(screenUV) : null;
    vis = vis.mul(
      buildDepthHeightGateNode(THREE.TSL, {
        depthHere,
        flagsHere,
        uLightExpectedDepth: flameExpectedDepth,
      })
    );
  }

  // OPACITY of the flame's middle: where the inset is inside FLAME_OPAQUE_INSET the
  // flame REPLACES what is under it. Scaled by `vis`, so a guttered, snuffed or floor-
  // occluded flame fades its opaque body out with its light instead of leaving
  // a dark hole in the map.
  const opacity = cov
    .mul(smoothstep(float(FLAME_OPAQUE_INSET[0]), float(FLAME_OPAQUE_INSET[1]), inset))
    .mul(clamp(vis.mul(float(2)), float(0), float(1)));

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // PREMULTIPLIED OVER: out = rgb + dst·(1 − opacity). Where opacity is 0 (the
  // rim, the halo) that is exactly an additive glow (colour × emission added
  // onto scene.lit); where it is 1 (the middle) the flame replaces what is
  // under it.
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(colorOut.mul(brightness.mul(falloff).mul(vis)), opacity);

  return { material, uIntensity, uLean, uWindResponse };
}
