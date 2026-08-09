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
import { buildHeightGateNode } from './lighting/point-light-illumination.js';

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
 * Flame shape constants — the TOP-DOWN FOOTPRINT of a 3D teardrop (author model,
 * 2026-07-20): "the teardrop shape in 3D space where the bottom is anchored and
 * the top is evolved/animated by the shader to move around in the wind... looking
 * top down [it is] a rounded shape where the wick is and then a point which
 * wouldn't be visible at all when the wind isn't active".
 *
 * THE KEY INSIGHT: under the viewer's ORTHOGRAPHIC top-down camera there is no
 * perspective, so a real 3D teardrop mesh standing on the wick would render as
 * exactly its top-down FOOTPRINT and nothing more — a 3D mesh buys zero here and
 * costs more. So we draw the footprint directly: a "round cone" (a disc of
 * radius FLAME_BASE_RADIUS at the wick, tapering to FLAME_TIP_RADIUS at the tip)
 * whose TIP is steered by wind (`buildCandleFlameMaterial`'s `uLean`). At rest
 * the tip sits over the wick (a 3D flame pointing straight AT the camera → its
 * point foreshortens to nothing) so the footprint is just the round base; as the
 * tip leans, a teardrop tail sweeps out in the wind direction and the point
 * appears. The base end of the spine is ALWAYS the wick (the quad centre) — the
 * anchor is baked into the geometry, no uniform can move it. (A real 3D mesh
 * becomes worth building only if the camera ever tilts off straight-down —
 * recorded here, not built.)
 */
const FLAME_BASE_RADIUS = 0.23; // round base radius, as a fraction of the quad half-extent
/** Radius at the tip. ⚠️ Was 0.02 — a true needle point, which under the noise
 * displacement added 2026-08-06 frayed into thin spikes rather than the ROUNDED
 * lobes the reference art is built from. A blunter tip keeps the teardrop
 * silhouette while giving the lobe noise enough width to read as billowing. */
const FLAME_TIP_RADIUS = 0.05;
/** Silhouette softness, in quad fractions — so it SCALES with the flame.
 * ⚠️ Was 0.05, which at the shipped 24-30px flame is subtle but at any larger
 * candle is 15px of gaussian mush: the lab's first capture (2026-08-06) showed
 * every flame as a soft featureless blob with no readable edge at all. The
 * reference art the author supplied has painterly, DEFINED boundaries broken up
 * by speckle rather than blurred away, so the edge is now crisp and
 * `FLAME_GRAIN_*` below supplies the break-up instead. At the small end this is
 * ~1px of transition, which is the right amount of antialiasing and no more. */
const FLAME_EDGE_SOFT = 0.02;
/** A tiny sideways bias for the resting spine (fraction of the quad). The spine's
 * LENGTH is now life-driven (FLAME_REST_LEN_*), pointing "up" (−Y is up on screen,
 * the camera flips Y); this is only the small x-lean of an otherwise-vertical
 * resting wisp. Wind adds on top. */
const FLAME_REST_CURL_X = 0.0;

/**
 * ============================================================================
 * THE COLOUR RAMP — rebuilt 2026-08-06 against the author's own reference art
 * ============================================================================
 *
 * The author supplied a hand-painted fire/explosion sheet and asked for the
 * candle's colours to "conform as closely as possible" to it. That painting's
 * palette runs, from hottest to coolest:
 *
 *   pale cream-yellow  →  saturated golden  →  strong orange  →  deep orange-red
 *   (#FEE5A2-ish)         (#FCB63E-ish)        (#F8901C-ish)     (#B36814-ish)
 *
 * ⚠️ WHAT THE OLD MODEL GOT WRONG, AND WHY NOTHING CAUGHT IT. It was
 * `mix(FLAME_BASE_COLOR, flameColor, h)` — a pale cream body lerping to the
 * AUTHORED colour at the TIP — multiplied by a `heat` term that fades toward
 * that same tip, and then a 0.9-strength blow to pure WHITE at the core on top.
 * So the one saturated colour in the whole shader was painted exactly where the
 * brightness went to zero, and everything you could actually see was washed
 * cream. The first lab capture (`tools/shader-lab/candle-lab.js`, built the
 * same day for this) shows it plainly: sixteen pale beige blobs with no orange
 * anywhere. It had been that way since 2026-07-20 and read as "a bit pale"
 * rather than as a bug, because nothing ever rendered a flame bigger than 30px
 * where the gradient's direction was legible.
 *
 * The ramp is now derived FROM the per-candle authored colour rather than
 * lerping toward it, so it stays a real recolour knob (a blue candle ramps
 * blue) while the DEFAULT lands on the reference palette above. Hot things do
 * pale toward cream in reality, so the two hot stops mix toward cream/gold
 * rather than being fixed — that is what keeps a recoloured candle from simply
 * looking like flat tinted paper.
 */
const FLAME_PALE_GOLD = [1.0, 0.84, 0.35]; // what the INNER stop mixes toward
const FLAME_CREAM = [1.0, 0.95, 0.72]; // what the CORE stop mixes toward
const FLAME_RAMP_INNER_MIX = 0.45; // how far the inner stop travels to pale gold
const FLAME_RAMP_CORE_MIX = 0.86; // how far the core stop travels to cream
const FLAME_RIM_DARKEN = 0.78; // the deep orange-red rim = authored colour, deepened
/** Ramp stop positions along `heat` (0 = silhouette, 1 = hottest core).
 * Deliberately front-loaded: in the reference art the deep colour is a
 * comparatively THIN rim and the bright golds/creams own most of the mass, so
 * the ramp reaches its inner and core stops early rather than at the extremes.
 *
 * ⚠️ AND the saturated MID stop must own a wide plateau between them. A first
 * pass front-loaded ALL THREE (T2 opening at 0.28), which handed most of the
 * flame's area to the two stops that mix toward pale gold and cream — the
 * result read pastel and washed, the same failure the old model had, reached
 * from the opposite direction. The gap between T1's end and T2's start is where
 * the authored colour shows at full saturation, and it has to be real. */
const FLAME_RAMP_T1 = [0.02, 0.22]; // rim → mid
const FLAME_RAMP_T2 = [0.4, 0.72]; // mid → inner  (0.22..0.40 = pure authored colour)
const FLAME_RAMP_T3 = [0.66, 0.9]; // inner → core
/** `heat`'s own shaping. <1 WIDENS the hot interior (the reference's blobs are
 * mostly bright, with the deep colour confined to a rim), and the tip stays
 * only mildly cooler because the distance-field depth already cools it. */
const FLAME_HEAT_TIGHTNESS = 0.6;
const FLAME_TIP_COOL = 0.75;
/** Emission: a body floor + a heat-driven gain + a modest core kick. The core
 * kick is deliberately FAR smaller than the 1.7 it replaced — that number
 * existed to serve an "extremely bright core" ask by blowing the centre to
 * white, and the reference art has no blown-out white anywhere in it. Brightness
 * now comes from the pale cream ramp stop, not from clipping the channel. */
const FLAME_EMIT_BODY = 0.6;
const FLAME_EMIT_HEAT_GAIN = 1.0;
const FLAME_CORE_RADIUS = 0.12; // the core kick's radius (fraction of the quad)
const FLAME_CORE_BOOST = 0.5;

/**
 * ============================================================================
 * THE BILLOWY SILHOUETTE — lobes + grain (2026-08-06, same reference)
 * ============================================================================
 * The painting's masses are cauliflower-like: big rounded lobes with smaller
 * bumps riding on them, and a scatter of detached specks around the edge. A
 * clean round-cone SDF cannot produce any of that, so the distance field itself
 * is displaced by noise before it is thresholded — two octaves for the lobes
 * (tier ≥1), plus a much finer, lower-amplitude octave for the painterly
 * grain that breaks the silhouette into flecks (tier 2).
 *
 * Both are scaled by the flame's own base radius, NOT by the local `radiusAt`:
 * keyed to `radiusAt` the lobes would vanish exactly where the cone tapers, so
 * the tip — the most visually interesting part of a flame — would be the one
 * place that stayed a smooth machined curve.
 */
const FLAME_LOBE_FREQ = 4.0; // lower = BIGGER, rounder lobes (5.5 read as torn, not billowed)
const FLAME_LOBE_RATE = 0.9;
const FLAME_LOBE_AMP = 0.3;
const FLAME_LOBE_OCTAVE2 = 2.3; // second octave's frequency multiplier
const FLAME_LOBE_OCTAVE2_W = 0.25;
/** ⚠️ GRAIN IS HIGH-FREQUENCY AND LOW-AMPLITUDE, and the pairing is the whole
 * point. At freq 13 / amp 0.15 the displacement is large enough RELATIVE to its
 * own wavelength to move the silhouette itself, which shredded the outline into
 * jagged tears instead of dusting it with flecks. Fine and weak reads as
 * painterly grain; coarse and strong reads as damage. */
const FLAME_GRAIN_FREQ = 22.0;
const FLAME_GRAIN_RATE = 1.6;
const FLAME_GRAIN_AMP = 0.09;

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
const WIND_GUTTER_MAG_THRESHOLD = 1.3; // raw wind magnitude where a gust starts adding ITS OWN gutter pressure
const WIND_GUTTER_MAG_RANGE = 1.0; // span over which that pressure ramps to "as deep as a random gutter"
const WIND_SNUFF_MAG_LOW = 2.2; // below this, zero snuff pressure
const WIND_SNUFF_MAG_HIGH = 3.2; // at/above this, fully extinguished (until the gust passes)

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
const FLAME_REST_LEN_BASE = 0.08; // upward tail length when calm/guttered …
const FLAME_REST_LEN_LIFE = 0.24; // … plus this much when alive → elongates/shortens
const FLAME_SIZE_BASE = 0.62; // round-base WIDTH scale: shrinks in the cold …
const FLAME_SIZE_LIFE = 0.55; // … swells when alive
const FLAME_SIZE_BREATHE = 0.15;
const FLAME_BREATHE_RATE = 0.9;
const FLAME_TAIL_LIFE = 0.7; // the wind tail also elongates with life
const FLAME_CURL_RATE = 2.4; // per-candle bend that DESYNCS neighbours' tails
const FLAME_CURL_AMP = 0.7; // curl strength relative to the coherent gust
const FLAME_WARP_FREQ = 3.2; // tier-2 domain warp — the silhouette BOILS/CURLS
const FLAME_WARP_RATE = 1.4; // (less precise, more organic than a clean teardrop)
/** Reduced from 0.13 on 2026-08-06: `FLAME_LOBE_*` now does the heavy lifting
 * for silhouette irregularity, and stacking the full old warp on top of it
 * pushed the shape past "chaotic but reads as a flame" into shapeless. */
const FLAME_WARP_AMP = 0.06;

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
// light-source builder + clustering, and the flame vertex-array bake) moved
// to candle-flame-geometry.js on 2026-07-25 (size-ratchet god-object
// reversal) — none of it touches THREE/TSL, which is why it carries the
// runtime's entire Node test suite there now.
import { computeCandleFlameArrays } from './candle-flame-geometry.js';

/**
 * Build (or fill) a THREE.BufferGeometry for the flame billboards. Kept thin so
 * the geometry MATH stays in `computeCandleFlameArrays` (Node-tested) and only
 * the GPU-object glue is here.
 * @param {*} THREE @param {Array<{x:number,y:number}>} anchors @param {{sizePx:number}} opts
 * @returns {{geometry: *, quadCount: number}}
 */
export function buildCandleFlameGeometry(THREE, anchors, opts) {
  const { positions, uvs, centers, exposures, colors, intensities, elevationRanks, indices, quadCount } =
    computeCandleFlameArrays(anchors, opts);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('center', new THREE.BufferAttribute(centers, 2));
  geometry.setAttribute('windExposure', new THREE.BufferAttribute(exposures, 1));
  geometry.setAttribute('flameColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('flameIntensity', new THREE.BufferAttribute(intensities, 1));
  // THE HEIGHT GATE'S OWN INPUT — see computeCandleFlameArrays' own doc.
  geometry.setAttribute('elevationRank', new THREE.BufferAttribute(elevationRanks, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // Draw only the quads actually filled — matters only if the belt-and-braces
  // finite check dropped an anchor (the authority guarantees it never does), in
  // which case the buffers hold trailing zeros that would draw degenerate tris.
  geometry.setDrawRange(0, quadCount * 6);
  return { geometry, quadCount };
}

/**
 * Build the flame's TSL material — the TOP-DOWN FOOTPRINT of a bending 3D
 * teardrop (see the FLAME shape-constants header for the full model).
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
 * BRIGHT CORE + COLOUR GRADIENT (2026-07-20) — a white-hot centre near the wick
 * and a hot-yellow-base → warm-orange-tip gradient, the author's "extremely
 * bright core… slight gradient of colour."
 *
 * ============================================================================
 * THE SHAPE — a steerable "round cone", and the WIND SEAM (`uLean`)
 * ============================================================================
 *
 * The flame is the distance-field of a ROUND CONE: a disc of radius
 * FLAME_BASE_RADIUS at the wick (the quad centre) tapering to FLAME_TIP_RADIUS
 * at the TIP. The tip sits at `restCurl + uLean`, both fractions of the quad:
 *   - the wick end of the spine is the quad CENTRE, ALWAYS — the anchor is baked
 *     into the geometry, so no value of `uLean` can ever move the root off the
 *     candle (the author's hard requirement);
 *   - at rest (`uLean`=0) the tip sits at `restCurl` — a tiny offset that gives
 *     the resting flame a hint of teardrop form ("a little thickness"); its
 *     point is barely off-centre, reading as a rounded base with no obvious
 *     point, exactly the at-rest look asked for;
 *   - wind writes `uLean` (tip displacement, x/y in quad fractions) and a
 *     teardrop TAIL sweeps out in that direction — a plain per-frame uniform
 *     write, as cheap as `uColor`, NO geometry rebuild. `uLean` defaults to
 *     (0,0); no wind source exists yet — the seam is wired, at rest.
 *
 * The footprint is the standard round-cone SDF: project the fragment onto the
 * spine segment [wick→tip], clamp to the segment (spherical caps → the rounded
 * base + soft point), and compare its distance to the radius interpolated along
 * the spine. Brightness is hottest at the base (the fuel) fading to the tip,
 * with a white-hot core near the wick centre.
 *
 * Additive blending makes it GLOW over the lit scene regardless of scene
 * darkness — a flame emits light, it is not lit by it — and overlapping flames
 * add. `side: DoubleSide` sidesteps quad winding under the flipped camera.
 * Multi-arg TSL calls use the FUNCTION form (`smoothstep`/`clamp`/`mix`/`length`/
 * `dot`/`max`) — the `.mix()`-as-method trap (reference_tsl_method_chaining_trap)
 * applies to all of them.
 *
 * PER-CANDLE CHAOTIC LIFE (2026-07-20, tiered) — the flame no longer holds one
 * static shape. A per-candle seed (flameHash) phases a chaotic LIFE envelope
 * (with COLD gutter periods), which drives its EMISSION (flicker/gutter), its
 * TAIL length (elongate/shorten), and its WIDTH (swell/shrink); the wind bends
 * it, a per-candle curl desyncs neighbours, and tier 2 domain-warps the
 * silhouette so it boils and curls instead of holding a clean teardrop.
 *
 * TIERS (graph-build-time `quality`, from the candle effect's animationQuality
 * param — no-uniform-gates: a lower tier never builds the higher tier's nodes):
 *   0 "low"      — a calm flame: a gentle per-candle emission flicker + a small
 *                  length pulse. No wind, no gutter, no warp. Cheapest.
 *   1 "standard" — full LIFE: chaotic flicker with cold gutter periods, wind
 *                  tail (coherent gust + per-candle curl), width/length pulsing.
 *   2 "lavish"   — + a domain-warped silhouette (boiling, curling, imprecise).
 *
 * @param {{THREE: *, uGlobalTimeMs?: *, quality?: number, windHandle?: object, attrTexNode?: *}} args -
 *   `uGlobalTimeMs` is the shared clock (the viewer's one clock); when
 *   absent the flame rests. `quality` is the build-time tier (default 2).
 *   `windHandle` is `world/wind-access.js#createWindHandle`'s product — the
 *   ambient bias, Tier 1's baked openness, the wall-avoidance field and Tier
 *   2's transient all ride INSIDE it (Wind.md §5.1), replacing the four
 *   separate arguments this used to forward by hand into `sampleWind`. Omit it
 *   entirely for byte-identical Tier-0 behaviour (a flame that only knows the
 *   organic gust noise). `attrTexNode` — `buf:scene.attr`, UNSAMPLED — wires
 *   the SAME height/elevation gate a point light uses
 *   (`point-light-illumination.js#buildHeightGateNode`); omit it for a flame
 *   that ignores floor occlusion entirely (byte-identical pre-gate behaviour).
 * @returns {{material: *, uIntensity: *, uLean: *, uWindResponse: *}}
 */
export function buildCandleFlameMaterial({
  THREE,
  uGlobalTimeMs,
  quality = 2,
  windHandle = TIER0_WIND_HANDLE,
  attrTexNode,
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
    pow,
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
  const flameElevationRank = attribute('elevationRank', 'float');

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
      exposure: windExposure,
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

  // THE SPINE (wick → tip). An upward tail whose LENGTH pulses with life (the
  // flame elongating/shortening), plus — tier ≥1 — the wind bend + a per-candle
  // curl (so neighbours' tails point differently), the whole tail elongating
  // further with life. The wick end stays pinned at (0,0).
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

  // WIDTH — the round base swells when alive, shrinks in the cold (tier ≥1).
  const sizeScale =
    quality >= 1
      ? max(
          float(FLAME_SIZE_BASE)
            .add(life.mul(float(FLAME_SIZE_LIFE)))
            .add(nz(FLAME_BREATHE_RATE, float(61)).mul(float(FLAME_SIZE_BREATHE))),
          float(0.2)
        )
      : float(1);

  // Fragment position, DOMAIN-WARPED at tier 2 so the silhouette boils/curls
  // (less precise, more organic — the author's "less precise in shape").
  let p = uv().sub(vec2(0.5, 0.5));
  if (quality >= 2) {
    const warp = vec2(
      perlin(
        vec2(
          p.x.mul(float(FLAME_WARP_FREQ)).add(pt.mul(float(FLAME_WARP_RATE))),
          p.y.mul(float(FLAME_WARP_FREQ)).add(phase)
        )
      ),
      perlin(
        vec2(
          p.y.mul(float(FLAME_WARP_FREQ)).sub(pt.mul(float(FLAME_WARP_RATE))),
          p.x.mul(float(FLAME_WARP_FREQ)).add(phase)
        )
      )
    ).sub(float(0.5));
    p = p.add(warp.mul(float(FLAME_WARP_AMP)));
  }

  // Round-cone distance field. h = projection of p onto the spine, clamped to
  // [0,1] (0 = the wick/base, 1 = the tip); the clamp's caps round both ends.
  // Radius scaled by the live WIDTH.
  const h = clamp(dot(p, tip).div(max(dot(tip, tip), float(1e-6))), float(0), float(1));
  const closest = tip.mul(h);
  const distToSpine = length(p.sub(closest));
  const radiusAt = mix(float(FLAME_BASE_RADIUS), float(FLAME_TIP_RADIUS), h).mul(sizeScale);
  /** The flame's own scale reference for every noise displacement below — the
   * BASE radius, not the tapering local one (see the FLAME_LOBE_* header). */
  const radiusRef = max(float(FLAME_BASE_RADIUS).mul(sizeScale), float(1e-4));
  let signed = distToSpine.sub(radiusAt); // < 0 inside the teardrop

  // BILLOWY LOBES (tier ≥1) — two noise octaves displacing the distance field,
  // so the silhouette grows rounded cauliflower lobes with smaller bumps on
  // them instead of holding a machined cone. Phased by the per-candle seed
  // (`pt`/`phase`) like every other noise here, so neighbours never billow in
  // lockstep.
  if (quality >= 1) {
    const lobe1 = perlin(
      vec2(
        p.x.mul(float(FLAME_LOBE_FREQ)).add(pt.mul(float(FLAME_LOBE_RATE))),
        p.y.mul(float(FLAME_LOBE_FREQ)).add(phase)
      )
    );
    const lobe2 = perlin(
      vec2(
        p.y.mul(float(FLAME_LOBE_FREQ * FLAME_LOBE_OCTAVE2)).sub(pt.mul(float(FLAME_LOBE_RATE * 1.4))),
        p.x.mul(float(FLAME_LOBE_FREQ * FLAME_LOBE_OCTAVE2)).add(phase)
      )
    );
    const lobes = lobe1.mul(float(1 - FLAME_LOBE_OCTAVE2_W)).add(lobe2.mul(float(FLAME_LOBE_OCTAVE2_W)));
    signed = signed.add(lobes.mul(radiusRef).mul(float(FLAME_LOBE_AMP)));
  }

  // PAINTERLY GRAIN (tier 2) — a much finer, weaker octave. Too small to
  // change the read of the shape, big enough to fray the boundary into flecks
  // and specks, which is what stops a flat-shaded SDF from looking vector-cut.
  if (quality >= 2) {
    const grain = perlin(
      vec2(
        p.x.mul(float(FLAME_GRAIN_FREQ)).add(pt.mul(float(FLAME_GRAIN_RATE))),
        p.y.mul(float(FLAME_GRAIN_FREQ)).sub(phase)
      )
    );
    signed = signed.add(grain.mul(radiusRef).mul(float(FLAME_GRAIN_AMP)));
  }

  // Soft silhouette: 1 well inside, 0 outside (the well-defined smoothstep
  // direction, then inverted — never a reversed-edge smoothstep).
  const inside = float(1).sub(smoothstep(float(-FLAME_EDGE_SOFT), float(0), signed));

  // HEAT — how far INSIDE the (already noise-displaced) silhouette this
  // fragment sits, normalised by the flame's own radius, then cooled slightly
  // toward the tip. Derived from `signed` rather than from `h`/`distToSpine`
  // directly so the colour bands FOLLOW the lobes instead of cutting across
  // them — a lobe that bulges out carries its own rim of deep orange with it,
  // which is exactly what the reference art does.
  // ⚠️ NORMALISED BY THE *LOCAL* RADIUS, NOT THE BASE ONE. Dividing by
  // `radiusRef` (the first cut, 2026-08-06) looked right on paper and rendered
  // muddy brown: the cone TAPERS, so above the base the local radius is a small
  // fraction of the base radius, the deepest reachable depth was correspondingly
  // small, and `heat` could never climb past the rim stop — the entire upper
  // flame came out rim-coloured. Against the local radius the spine reads ~1 at
  // every height, so the flame is bright the whole way up with a deep rim
  // wrapped around it (which is what the reference actually shows), and the tip
  // cools through the explicit `FLAME_TIP_COOL` term instead of by accident.
  const heatDenom = max(radiusAt, radiusRef.mul(float(0.25)));
  const heat = clamp(
    pow(clamp(signed.negate().div(heatDenom), float(0), float(1)), float(FLAME_HEAT_TIGHTNESS)).mul(
      mix(float(1), float(FLAME_TIP_COOL), h)
    ),
    float(0),
    float(1)
  );

  // THE RAMP — four stops built FROM the authored per-candle colour (see the
  // FLAME_PALE_GOLD header for why it is derived rather than lerped toward).
  const rimCol = flameColor.mul(float(FLAME_RIM_DARKEN));
  const innerCol = mix(flameColor, vec3(...FLAME_PALE_GOLD), float(FLAME_RAMP_INNER_MIX));
  const coreCol = mix(flameColor, vec3(...FLAME_CREAM), float(FLAME_RAMP_CORE_MIX));
  let colorOut = mix(rimCol, flameColor, smoothstep(float(FLAME_RAMP_T1[0]), float(FLAME_RAMP_T1[1]), heat));
  colorOut = mix(colorOut, innerCol, smoothstep(float(FLAME_RAMP_T2[0]), float(FLAME_RAMP_T2[1]), heat));
  colorOut = mix(colorOut, coreCol, smoothstep(float(FLAME_RAMP_T3[0]), float(FLAME_RAMP_T3[1]), heat));

  // A small extra emission kick right at the wick — enough that the flame still
  // reads as a light SOURCE, not so much that the centre clips to white.
  const coreRadius = max(float(FLAME_CORE_RADIUS).mul(sizeScale), float(1e-4));
  const coreT = clamp(float(1).sub(distToSpine.div(coreRadius)), float(0), float(1)).mul(mix(float(1), float(0), h));

  // EMISSION — guttering: near-dark in a cold period, a flare when alive (tier
  // ≥1); a gentle flicker at tier 0. Plus the bright core kick.
  const emitLevel =
    quality >= 1 ? mix(float(FLAME_EMIT_FLOOR), float(FLAME_EMIT_CEIL), life) : mix(float(0.75), float(1.1), life);
  let emission = inside
    .mul(
      float(FLAME_EMIT_BODY)
        .add(heat.mul(float(FLAME_EMIT_HEAT_GAIN)))
        .add(coreT.mul(float(FLAME_CORE_BOOST)))
    )
    .mul(emitLevel)
    .mul(uIntensity)
    .mul(flameIntensity); // per-candle brightness (the anchor's own `intensity` param, finally read by the flame itself)
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
    emission = emission.mul(float(1).sub(snuff));
  }

  // ============================================================================
  // THE HEIGHT/ELEVATION GATE — the SAME node a point light's own materials
  // use (`point-light-illumination.js#buildHeightGateNode`), applied to the
  // flame SPRITE itself. A candle's cast LIGHT already flows through the
  // point-light pool; the flame you actually SEE is a separate batched mesh
  // and needed its own wiring — the author's own follow-up after the point-
  // light fix: "now do the candle flame and lightning shaders too."
  //
  // ⚠️ `screenUV`, never the bare node — `buf:scene.attr` is a SCREEN-space
  // buffer and this is a WORLD-space billboard batch; a bare `texture()` node
  // would default to this mesh's OWN `uv` (which DOES exist here, unlike a
  // light's fan — but it is the flame's LOCAL 0..1 quad coordinate, not a
  // screen coordinate, so it would sample the wrong thing just as surely as
  // no uv at all — `feedback_shared_texture_node_carries_the_wrong_uv`).
  //
  // `flameElevationRank` is baked PER-CANDLE at geometry build time
  // (`computeCandleFlameArrays`), not a uniform — this mesh batches every
  // visible candle into ONE draw call, and different candles can legitimately
  // sit on different floors (`scene/anchor-authority.js`'s `own-and-above`
  // visibility). A JS-time branch, not a uniform gate: with no `attrTexNode`
  // this material is byte-identical to before the gate existed.
  if (attrTexNode) {
    emission = emission.mul(
      buildHeightGateNode(THREE.TSL, {
        attrHere: attrTexNode.sample(screenUV),
        uLightElevationRank: flameElevationRank,
      })
    );
  }

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  // AdditiveBlending = SrcAlpha·rgb + dst → the contribution is colorOut ×
  // emission, added onto scene.lit — a glow that fades at the silhouette.
  material.fragmentNode = vec4(colorOut, emission);

  return { material, uIntensity, uLean, uWindResponse };
}
