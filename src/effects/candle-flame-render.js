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
const FLAME_BASE_RADIUS = 0.22; // round base radius, as a fraction of the quad half-extent
const FLAME_TIP_RADIUS = 0.02; // radius at the tip → a point
const FLAME_EDGE_SOFT = 0.05; // silhouette antialiasing width
/** A tiny sideways bias for the resting spine (fraction of the quad). The spine's
 * LENGTH is now life-driven (FLAME_REST_LEN_*), pointing "up" (−Y is up on screen,
 * the camera flips Y); this is only the small x-lean of an otherwise-vertical
 * resting wisp. Wind adds on top. */
const FLAME_REST_CURL_X = 0.0;

/** Flame CORE + COLOUR GRADIENT (2026-07-20, author: "extremely bright core…
 * a slight gradient of colour to make it look more like a candle flame"). A
 * real candle flame is hottest (near-white/yellow) at the base by the wick and
 * cools (deeper orange) toward the tip. */
const FLAME_BASE_COLOR = [1.0, 0.9, 0.62]; // hot yellow-white body near the wick
const FLAME_CORE_WHITE = 0.9; // how far the very centre blows to pure white
const FLAME_CORE_RADIUS = 0.12; // the white-hot core radius (fraction of the quad)
const FLAME_CORE_BOOST = 1.7; // extra emission at the core (the "extremely bright" ask)

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
const FLAME_WARP_AMP = 0.13;

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
  const signed = distToSpine.sub(radiusAt); // < 0 inside the teardrop

  // Soft silhouette: 1 well inside, 0 outside (the well-defined smoothstep
  // direction, then inverted — never a reversed-edge smoothstep).
  const inside = float(1).sub(smoothstep(float(-FLAME_EDGE_SOFT), float(0), signed));
  // Hottest at the base (h=0, the fuel), fading toward the tip.
  const heat = mix(float(1), float(0.35), h);

  // COLOUR GRADIENT — a hot yellow-white body at the base cooling to the
  // authored warm orange at the tip (a real flame cools as it rises).
  const baseCol = vec3(FLAME_BASE_COLOR[0], FLAME_BASE_COLOR[1], FLAME_BASE_COLOR[2]);
  const gradient = mix(baseCol, flameColor, h);

  // WHITE-HOT CORE — a small, intense WHITE centre on the spine near the wick
  // (coreT is 1 at the very centre, 0 by the core radius or up toward the tip).
  const coreRadius = max(float(FLAME_CORE_RADIUS).mul(sizeScale), float(1e-4));
  const coreT = clamp(float(1).sub(distToSpine.div(coreRadius)), float(0), float(1)).mul(mix(float(1), float(0), h));
  const colorOut = mix(gradient, vec3(1, 1, 1), coreT.mul(float(FLAME_CORE_WHITE)));

  // EMISSION — guttering: near-dark in a cold period, a flare when alive (tier
  // ≥1); a gentle flicker at tier 0. Plus the bright core kick.
  const emitLevel =
    quality >= 1 ? mix(float(FLAME_EMIT_FLOOR), float(FLAME_EMIT_CEIL), life) : mix(float(0.75), float(1.1), life);
  let emission = inside
    .mul(heat.add(coreT.mul(float(FLAME_CORE_BOOST))))
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
