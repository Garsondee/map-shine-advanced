/**
 * POINT-LIGHT ILLUMINATION — increment 2a of Type-A parity (docs/planning/
 * Light-Parity.md §5): per-light MAX-blended contribution into the SAME
 * `buf:scene.illum` environmental-light.js fills with the ambient floor.
 *
 * Reproduces Foundry's default-technique illumination channel exactly
 * (docs/reference/foundry-v14-lighting-audit.md §5c, §7):
 *
 *   dist       = distance from the light's own origin, normalized to its
 *                radius (0 at center, 1 at the polygon boundary)
 *   ratio      = bright/radius (already computed live by Foundry, read
 *                straight off the source — foundry/scene-lights.js)
 *   switchColor: cross-fades bright→dim across a band centered on `ratio`,
 *                widened by (eased) attenuation
 *   falloff    : an outer radial fade toward the shape's edge, driven by
 *                the attenuation SLIDER (Foundry's own parameter, a real
 *                authored choice — a wide, deliberate corona, not an
 *                antialiasing detail)
 *   output     : mix(ambientBackground, switchColor-result, falloff)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SOFT-EDGE MARGIN (2026-07-19) — an analytic SDF, not Foundry's mesh-
 * inflate trick, chosen after live research (author: "if we can use WebGPU
 * and threejs to get a better light than Foundry we should... reliable,
 * reasonable, good performance with hundreds of lights"):
 *
 * Foundry ALWAYS softens the true polygon boundary by a small, ~constant-
 * pixel margin (`RenderedEffectSource.EDGE_OFFSET = -8`, scaled by
 * `canvas.grid.size/100`), INDEPENDENT of the attenuation slider — achieved
 * by literally inflating the mesh (`PolygonMesher`'s ClipperLib polygon-
 * offset, several inset rings, a per-vertex depth 0→1 ramp). That geometric
 * machinery is real engineering (a 2D polygon-offset implementation +
 * multi-ring triangulation) for a purely cosmetic ~8px margin.
 *
 * This reproduces the SAME margin, analytically, with NO extra geometry, NO
 * extra render target, and NO per-frame CPU work beyond what the light
 * already does: `sdPolygonEdgeDistance` (below) computes the exact signed
 * distance from a fragment to the polygon's NEAREST edge — negative inside,
 * positive outside — via the well-established point-in-polygon-plus-min-
 * segment-distance shader technique (the same family as Inigo Quilez's
 * widely-used `sdPolygon`; see also Godot 4's own SDF-based 2D lighting,
 * which the author's own research reviewed, chosen BECAUSE a distance-based
 * technique's cost scales with light count, not with per-light geometry
 * complexity — https://godotshaders.com/shader/dynamic-2d-lights-and-soft-shadows/).
 * `edgeSoftFactor = smoothstep(0, marginNormalized, -signedDist)` then
 * MULTIPLIES into the existing attenuation-based `falloff` — the two are
 * DIFFERENT terms answering different questions (a fixed antialiasing
 * margin vs. the authored attenuation corona), exactly as they are in
 * Foundry (vDepth blur is unconditional; attenuation fade is the slider).
 *
 * Cost, by design: a BOUNDED loop (MAX_LIGHT_EDGES, matching the same cap
 * `triangulateLightFan`'s geometry uses) over the light's OWN edges — a
 * simple open-room torch (few edges) costs almost nothing; only genuinely
 * wall-dense spots pay more. No new render target, no cache to invalidate,
 * no cross-wall bleed (unlike a screen-space blur, this is a pure function
 * of the ACTUAL polygon, never neighbouring pixels).
 *
 * NOT YET BUILT, this rung: real soft-SHADOW penumbra (raymarching this same
 * distance data toward the light, à la Godot/RTSDF) — something Foundry's
 * binary wall-visibility model cannot do at all. A compelling next tier,
 * deliberately out of scope here (this rung matches Foundry's INTENT for
 * silhouette softness, not a physically-lit-penumbra system).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SUN-SHADOW ATTENUATION (2026-07-24) — the background floor is sampled
 * PER-PIXEL from the sun-shadow field, never once per light
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A light's output is `mix(background, litColour, falloff)`. `background` is
 * what it fades BACK TO at its own rim — and it must be the SAME ambient the
 * rest of the scene has at that pixel, which (since cast shadows landed) means
 * the SHADOWED ambient. Otherwise the light's mesh writes an un-shadowed floor
 * across its whole footprint, the illum pass's `MaxEquation` blend picks that
 * over the correctly-darker shadowed ambient EVERYWHERE inside the mesh, and
 * the shadow is erased across the entire radius with a hard cut at the mesh
 * boundary.
 *
 * ⚠️ TWO FAILED ATTEMPTS FIRST, BOTH FOR THE SAME REASON — worth recording,
 * because both looked correct in isolation and the second actively made things
 * worse in a way that took a screenshot to see:
 *
 *   1. Scale `uBackgroundColor` on the CPU by the sun-visibility AT THE
 *      LIGHT'S ORIGIN. Fixed the rim, but a light's origin is ONE POINT: it is
 *      either in shadow or not, so the entire light's appearance flipped as the
 *      shadow edge swept across that single point. A few degrees of sun
 *      rotation → the whole light snapped between "soft and attenuated" and
 *      "hard-edged, shadow fully erased." Reported live as exactly that.
 *   2. Blend toward a WIDER falloff curve proportionally to how deep in shadow
 *      the light's origin sits. This inherited the same point-sample flip AND
 *      additionally coupled the light's own CORONA SHAPE to the time of day —
 *      a light visibly changing softness as the sun moved, which is not a thing
 *      any light should do.
 *
 * THE LESSON: a per-light scalar cannot describe a quantity that varies ACROSS
 * the light. The shadow does; so the sample must be per-fragment.
 *
 * WHAT IT DOES NOW: the light's material samples the baked sun-shadow field at
 * `positionWorld.xy` (the real fragment world position — the same node and the
 * same world-rect mapping `region-darkness.js` and `environmental-light.js`
 * already use) and multiplies `uBackgroundColor` by it per-pixel. So the floor
 * is correctly shadowed exactly where the shadow is, un-shadowed where it
 * isn't, with a smooth gradient wherever `falloff < 1` — and the light's own
 * corona shape is completely untouched by the sun. No popping, because nothing
 * is decided per-light any more.
 *
 * Still, in every sense the doctrine cares about, `max(ambient×sunVis, light)`:
 * `finalColorExposed` — the torch's OWN colour, everything `combinedFalloff`
 * blends TOWARD — is never scaled by shadow. Only the ambient floor it fades
 * back to is, which is just that floor agreeing with the rest of the scene.
 * The torch was still never darkened. This is a LIGHT reading the sun's own
 * visibility field (the same one the ambient fill reads), never a shadow
 * reading a light buffer.
 *
 * TIER-0 SCOPE, documented rather than silently absent:
 *   - HEIGHT/ELEVATION OCCLUSION OF LIGHT LANDED 2026-08-03 — see this file's
 *     own "HEIGHT/ELEVATION GATE" section, further down. A light whose OWN
 *     elevation is explicitly authored (Foundry's per-light `elevation`
 *     field) no longer brightens a receiver placed meaningfully ABOVE it —
 *     an untouched light (elevation 0, the schema default) reaches
 *     everything, unchanged from before. Still open: Regions' own SURFACE
 *     occlusion (masks.occlusion's roof/overhead-mask half) — a DIFFERENT
 *     mechanism (an authored mask polygon, not a numeric height comparison),
 *     not built anywhere in this project yet.
 *   - no coloration channel, no non-default coloration techniques, no
 *     animations, no darkness/negative sources, no global light — each its
 *     own later rung (Light-Parity.md §5).
 *
 * SHAPE: the light's mesh is a FAN triangulation of Foundry's own wall-
 * clipped `source.shape.points`, valid because a ClockwiseSweepPolygon is
 * "star-shaped" from the light's own origin BY CONSTRUCTION (it IS a radial
 * sweep from that point) — so walls are already "free" here: no separate
 * light.visibility work is needed for point-light occlusion specifically,
 * only for the SUN's shadow producers (Light-and-Shadow.md's actual scope).
 *
 * @module effects/lighting/point-light-illumination
 */

import { buildAnimationTimeNode } from './animations/light-animation-clock.js';
import { createWindHandle } from '../../world/index.js';
import { buildApertureGoboTerm } from './aperture-gobo-render.js';

/** A bake-less handle so an un-wired caller still gets Tier-0 organic wind
 * rather than a wind-inert light — see candle-flame-render.js's own identical
 * constant for the full reasoning. */
const TIER0_WIND_HANDLE = createWindHandle();

/**
 * Starting/default capacity, in POLYGON EDGES, for a light's soft-edge SDF
 * uniform array — see buildPointLightIlluminationMaterial's own header for
 * why this is a FIXED cap (never grown) rather than the geometry buffer's
 * grow-on-demand scheme: a `uniformArray`'s size is fixed forever at shader-
 * setup time (verified against the vendored three.webgpu.js source), so
 * growing it would mean a full material/shader rebuild — meaningfully more
 * expensive than the geometry buffer's own occasional grow. A light whose
 * polygon exceeds this cap gracefully TRUNCATES (writeLightEdgePoints' own
 * contract) rather than rebuilding — a slightly-approximate soft edge on a
 * pathologically complex shape, never a crash or a stall. Matches
 * triangulateLightFan's own generous sizing (INITIAL_LIGHT_FAN_VERTICES in
 * vt-pan-viewer.js is 3x this, i.e. the same edge-count assumption).
 */
export const MAX_LIGHT_EDGES = 64;

/**
 * MIRRORS `vt/scene-attr.js#RECEIVER_ELEVATION_LEVELS`/`RANGE_UNITS` EXACTLY
 * — see this module's own "HEIGHT/ELEVATION GATE" section for why these are
 * a deliberate duplicate (avoiding a `vt/`<->`effects/` import cycle) rather
 * than a shared import, and `point-light-illumination.test.mjs` for the
 * cross-file pin that keeps the two from silently drifting apart.
 *
 * ⚠️ RANGE CUT 100→15 (2026-08-03) — see `vt/scene-attr.js`'s own copy of
 * this constant for the live-report evidence (a real 4-5 unit gap leaked
 * ~26% of a light through under the old, 10×-too-coarse range). MUST be
 * changed in lockstep with that file's own value — that is the whole reason
 * the cross-file pin test exists.
 */
export const RECEIVER_ELEVATION_LEVELS_MIRROR = 16;
export const RECEIVER_ELEVATION_RANGE_UNITS_MIRROR = 15;

/**
 * Pushed as `uLightElevationRank` for a light whose RAW Foundry
 * elevation reads as the schema default (0 — `AmbientLightDocument.
 * elevation`'s own `initial`), i.e. "the author never touched this field".
 * Far enough beyond `RECEIVER_ELEVATION_RANGE_UNITS_MIRROR` (15) that the
 * height gate's own smoothstep saturates to 1 (full reach) with no special
 * case needed — see this module's "HEIGHT/ELEVATION GATE" section for why
 * that is a real correctness requirement (0 must stay available as a
 * genuine "at my own floor's ground" height), not just tidiness.
 */
export const LIGHT_ELEVATION_UNCONFIGURED_SENTINEL = 1e6;

/**
 * What one floor's worth of within-floor height divides down to in rank space
 * (see `elevationRank`). **`RANGE_UNITS / DIVISOR` plus the gate's whole
 * tolerance+softness band must stay strictly below 1.0**, or a light sitting
 * near the top of its own floor's band could reach across into the floor
 * above — precisely the cross-floor bleed this gate exists to stop.
 *
 * That is not hypothetical: it was caught by this module's own "no height
 * within a lower floor can reach ANY height on a higher floor" test, which
 * FAILED at the first-draft divisor of `LEVELS` (16). There a full-height
 * receiver reached 15/16 = 0.9375 and the tolerance band pushed it over 1.0
 * exactly. Doubling the divisor halves the fraction's span (max 15/32 ≈
 * 0.47) and leaves the band (4/32 = 0.125) a wide, provable margin — total
 * worst case ≈ 0.59, comfortably under a whole floor. Doubling BOTH the
 * fraction and the band together means within-floor behaviour is completely
 * unchanged; only the cross-floor headroom grows.
 */
export const ELEVATION_RANK_FRACTION_DIVISOR = RECEIVER_ELEVATION_LEVELS_MIRROR * 2;

/**
 * How far ABOVE a light a receiver may still sit and stay FULLY lit, in
 * world-elevation units within one floor. Small on purpose: the whole point
 * of the gate is that a lantern's own cover (4-5 units over its flame) goes
 * dark, so anything approaching that gap defeats it.
 *
 * A first live-tunable guess, like every constant in this file's history —
 * `feedback_margin_sized_to_gap_is_self_defeating` is the lesson that set it
 * this low, and the author's own 4-5 unit lantern gap is the number it was
 * checked against.
 */
export const HEIGHT_GATE_TOLERANCE_UNITS = 1;

/**
 * The width of the fade band above `HEIGHT_GATE_TOLERANCE_UNITS` — a receiver
 * `tolerance + softness` units above the light is fully dark. A soft band, not
 * a razor edge, so quantization noise (±0.5 unit) softens a transition rather
 * than flickering a light on/off across a texel boundary.
 */
export const HEIGHT_GATE_SOFTNESS_UNITS = 3;

/**
 * ============================================================================
 * ⚠️ THE COMPARISON IS ABSOLUTE (FLOOR-INDEX-DOMINANT), NEVER FLOOR-RELATIVE
 * ============================================================================
 * **This is the 2026-08-03 ROUND-3 fix, and it replaces the model the first
 * two rounds were built on. Read this before touching the gate again.**
 *
 * The first design expressed BOTH sides of the height comparison as "units
 * above MY OWN floor's `elevationBottom`", reasoning (in `vt/scene-attr.js`'s
 * own constant doc) that a basement at -40 and a tower floor at +400 "must
 * quantize on the same scale". That reasoning is correct for the question
 * a canopy's own real height (`vegetation-render.js#vegetationHeightFt`,
 * `bottom + heightFt`) answers — *how far above my own floor's ground do I
 * stand* — and catastrophically wrong for the question THIS gate
 * asks, which is inherently cross-floor: *is this light underneath the
 * surface I am looking at*. Normalizing both sides to their own floor's
 * ground ERASES the floor identity that is the entire signal.
 *
 * The author's live report is the proof, and the arithmetic is exact. A light
 * at elevation -20 sitting on a basement floor spanning [-20, 0) resolves to
 * `elevationAboveFloor = 0`. The floorboards of an upper floor spanning
 * [5, 15) at elevation 5 ALSO resolve to `0`. The old gate then computed
 * `smoothstep(0-1, 0+1, 0) = 0.5` — half of a deliberately blown-out light,
 * which is still blown out — and painted an entire upper storey white through
 * two floors of solid geometry. Every light in the scene read as though it
 * stood on the ground of whatever floor the receiver happened to be on.
 *
 * The fix is a RANK that keeps the floor identity: `floorIndex + heightWithin
 * Floor/LEVELS`. The fractional part is strictly < 1 by construction (a level
 * maxes at `LEVELS-1`, divided by `LEVELS`), so **the floor index always
 * dominates**: every floor-N surface outranks every floor-(N-1) surface no
 * matter how the heights inside those bands compare. Both facts are ALREADY
 * in `buf:scene.attr` and already trustworthy — R is the floor index (the
 * same channel the LIVE multi-floor sun-shadow cascade gates on) and B bits
 * 2-5 are the height. No new bits, no new buffer, no new derivation.
 *
 * What it buys, in the author's own three cases:
 *   - lantern cover (tile 4-5 units over its flame, same floor) → the
 *     fractional parts differ by ~0.25 rank, past tolerance+softness → DARK.
 *   - basement light under an upper storey → ranks differ by ≥ 1 whole floor,
 *     far past the fade band → DARK, regardless of the two heights.
 *   - light streaming OUT of a ground-floor window, seen from above → outside
 *     the building there is no upper floor, so `buf:scene.attr` records the
 *     GROUND's own low rank at those pixels and the light passes → LIT. The
 *     hole-stack model falls out for free; it was never special-cased.
 *
 * @param {number} floorIndex - `buf:scene.attr`.R, the receiver's/light's own
 *   resolved floor index.
 * @param {number} unitsAboveFloorBottom - world-elevation units above THAT
 *   floor's own `elevationBottom` (clamped into the quantizer's range, so a
 *   receiver far above its band saturates at "high within my floor" instead
 *   of wrapping into the floor above's rank).
 * @returns {number} the comparable rank.
 */
export function elevationRank(floorIndex, unitsAboveFloorBottom) {
  const fi = Number.isFinite(floorIndex) ? Math.max(0, floorIndex) : 0;
  const raw = Number.isFinite(unitsAboveFloorBottom) ? unitsAboveFloorBottom : 0;
  const clamped = Math.max(0, Math.min(RECEIVER_ELEVATION_RANGE_UNITS_MIRROR, raw));
  return fi + clamped / ELEVATION_RANK_FRACTION_DIVISOR;
}

/**
 * Steepness `K` of the windowed inverse-square falloff (see
 * `inverseSquareFalloff`) — bigger = a tighter bright centre and a faster
 * drop-off. Tuned for candles (the only current `falloffModel: 'inverseSquare'`
 * caller): "right next to the candle is bright but the light quickly drops
 * off" (the author's own ask). A module constant, not a uniform — the whole
 * falloff-model choice is a graph-build-time JS branch (`no-uniform-gates`).
 */
export const INVERSE_SQUARE_STEEPNESS = 8;

/**
 * A physically-flavoured inverse-square falloff over the NORMALIZED radial
 * distance `dist` (0 at the light's own centre, 1 at its edge). Foundry's
 * default corona is a plain `smoothstep` — fine for a torch, but wrong for a
 * candle, whose light should be bright right at the flame and fall off fast
 * (the author's ask). This is the standard Karis/UE4 "windowed inverse
 * square": a real `1/(1+K·d²)` core, multiplied by a `(1-d⁴)²` window that
 * drives it cleanly to exactly 0 at the light's edge (a raw inverse square
 * never reaches 0, which would leave a hard clip at the mesh boundary). At
 * `dist=0` it is 1; the window and the reciprocal both only reduce it from
 * there. `K` is `INVERSE_SQUARE_STEEPNESS`.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {*} dist - a float TSL node, the normalized radial distance.
 * @returns {*} a float TSL node in [0,1].
 */
export function inverseSquareFalloff(TSL, dist) {
  const { float, clamp } = TSL;
  const d2 = dist.mul(dist);
  const windowTerm = clamp(float(1).sub(d2.mul(d2)), float(0), float(1)); // 1 - dist⁴, → 0 at the edge
  return windowTerm.mul(windowTerm).div(d2.mul(float(INVERSE_SQUARE_STEEPNESS)).add(float(1)));
}

/**
 * Ease Foundry's raw [0,1] attenuation slider into the value its shaders
 * actually use, replicated verbatim from `base-light-source.mjs`
 * (`_updateCommonUniforms`, cached as `computedAttenuation`):
 *
 *   (cos(PI * attenuation^1.5) - 1) / -2
 *
 * Foundry's own graph: https://www.desmos.com/calculator/e7z0i7hrck
 *
 * @param {number} attenuation01 - raw, 0..1 (already clamped by
 *   foundry/scene-lights.js#deriveLightSnapshot, clamped again here so this
 *   function is safe to call standalone).
 * @returns {number} the eased value the falloff/switchColor bands actually use.
 */
export function easeAttenuation(attenuation01) {
  const a = Math.min(1, Math.max(0, Number.isFinite(attenuation01) ? attenuation01 : 0));
  return (Math.cos(Math.PI * Math.pow(a, 1.5)) - 1) / -2;
}

/**
 * Foundry's own luminosity → exposure remap, verbatim (`base-light-source.mjs`,
 * `_updateIlluminationUniforms`: `u.exposure = this.data.luminosity * 2.0 - 1.0`).
 * At the LightData default (`luminosity01=0.5`) this is exactly 0 — a genuine
 * no-op multiplier (see `buildPointLightIlluminationMaterial`'s EXPOSURE term)
 * — which is WHY omitting this term never visibly affected an ordinary light
 * left at its default; a GM-tuned luminosity, or the Global Illumination
 * config (whose OWN default is 0, not 0.5 — `deriveGlobalLightConfig`), needs
 * it to render correctly.
 *
 * @param {number} luminosity01 - raw, 0..1.
 * @returns {number} exposure, -1..1.
 */
export function computeExposure(luminosity01) {
  const l = Math.min(1, Math.max(0, Number.isFinite(luminosity01) ? luminosity01 : 0.5));
  return l * 2 - 1;
}

/**
 * Normalize a closed WORLD-space polygon to LOCAL (light-relative,
 * unit-radius) space — the shared first step of `triangulateLightFan` (mesh
 * geometry) and `writeLightEdgePoints` (the soft-edge SDF data), factored out
 * so the same coordinate math is never duplicated between them.
 *
 * @param {number[]} shapePoints - flat [x0,y0,x1,y1,...] world-space polygon.
 * @param {number} originX @param {number} originY @param {number} radius
 * @returns {{lx: Float64Array, ly: Float64Array, n: number}}
 */
function normalizeLightPolygon(shapePoints, originX, originY, radius) {
  const n = Math.floor(shapePoints.length / 2);
  const inv = radius !== 0 ? 1 / radius : 0;
  const lx = new Float64Array(n);
  const ly = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lx[i] = (shapePoints[i * 2] - originX) * inv;
    ly[i] = (shapePoints[i * 2 + 1] - originY) * inv;
  }
  return { lx, ly, n };
}

/**
 * Fan-triangulate a closed WORLD-space polygon around the light's own
 * origin into LOCAL unit-radius space — see this module's header for why a
 * simple fan (not a general polygon triangulator) is exact here.
 *
 * @param {number[]} shapePoints - flat [x0,y0,x1,y1,...] world-space polygon
 *   (Foundry's `source.shape.points`); already validated (>=3 vertices, even
 *   length, all finite) by `foundry/scene-lights.js#deriveLightSnapshot`.
 * @param {number} originX @param {number} originY @param {number} radius
 * @param {Float32Array} [outArray] - a REUSABLE destination buffer (see the
 *   caller, vt-pan-viewer.js's light-mesh pool, for why this parameter
 *   exists — it is the fix for a real GPU-buffer leak, not an optimisation).
 *   Reused (written into, returned as-is) when it already has room for this
 *   frame's vertex count; a fresh, bigger array is allocated and returned
 *   ONLY when it doesn't (absent, or too small) — an occasional event when a
 *   light's polygon complexity grows, never a per-frame one.
 * @returns {{array: Float32Array, vertexCount: number}} `array` holds
 *   interleaved [x,y,z, ...] local-space vertices (3 per triangle, one
 *   triangle per polygon edge — origin + edge; z always 0), valid for its
 *   first `vertexCount` vertices (`3 * vertexCount` floats) — the rest, if
 *   `array` is larger than needed this frame, is STALE data from a previous,
 *   larger frame and must be ignored (the caller does this via
 *   `BufferGeometry#setDrawRange`, never by trusting `array.length`).
 */
export function triangulateLightFan(shapePoints, originX, originY, radius, outArray) {
  const { lx, ly, n } = normalizeLightPolygon(shapePoints, originX, originY, radius);
  const neededFloats = n * 3 * 3;
  const out = outArray && outArray.length >= neededFloats ? outArray : new Float32Array(neededFloats);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n; // wraps the last edge back to vertex 0 — the polygon is implicitly closed
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = lx[i];
    out[o++] = ly[i];
    out[o++] = 0;
    out[o++] = lx[j];
    out[o++] = ly[j];
    out[o++] = 0;
  }
  return { array: out, vertexCount: n * 3 };
}

/**
 * Write this light's LOCAL-space polygon vertices into a caller-owned,
 * FIXED-CAPACITY array of mutable `{x, y}` points (real `THREE.Vector2`
 * instances in production; plain `{x,y}` objects are sufficient for Node
 * tests) — the data source for the analytic soft-edge SDF's `uniformArray`.
 *
 * REUSE CONTRACT, matching `triangulateLightFan`'s own discipline but via
 * TRUNCATION rather than growth (see `MAX_LIGHT_EDGES`'s own doc for why): if
 * this light's polygon has MORE vertices than `outPoints.length`, only the
 * first `outPoints.length` are written and the count is capped — never
 * throws, never grows the array. Slots at or beyond the returned count are
 * NOT touched (may hold stale data from a previous, larger frame) — the
 * caller's shader loop bounds itself by the returned count (its own
 * `uEdgeCount` uniform), exactly like `triangulateLightFan`'s `vertexCount`/
 * `setDrawRange` contract.
 *
 * @param {number[]} shapePoints - flat [x0,y0,x1,y1,...] world-space polygon.
 * @param {number} originX @param {number} originY @param {number} radius
 * @param {Array<{x: number, y: number}>} outPoints - fixed-length, reused every frame.
 * @returns {number} how many of `outPoints` were written this frame (<= outPoints.length).
 */
export function writeLightEdgePoints(shapePoints, originX, originY, radius, outPoints) {
  const { lx, ly, n } = normalizeLightPolygon(shapePoints, originX, originY, radius);
  const count = Math.min(n, outPoints.length);
  for (let i = 0; i < count; i++) {
    outPoints[i].x = lx[i];
    outPoints[i].y = ly[i];
  }
  return count;
}

/**
 * The soft-edge antialiasing margin, in LOCAL unit-radius space (matching
 * `dist`'s own normalization) — Foundry's own reference figure
 * (`RenderedEffectSource.EDGE_OFFSET = -8`, `client/canvas/sources/rendered-
 * effect-source.mjs`), scaled by the grid's own size relative to Foundry's
 * 100px reference square (`EDGE_OFFSET * (canvas.grid.size / 100)`), then
 * converted from world px to a fraction of THIS light's own radius (the
 * space `sdPolygonEdgeDistance` operates in).
 *
 * @param {number} gridSizePixels - canvas.grid.size (px per grid square).
 * @param {number} radius - the light's own pixel radius. 0 reads as no margin
 *   (a degenerate light that should never reach the shader anyway —
 *   `foundry/scene-lights.js#deriveLightSnapshot` rejects radius<=0 first).
 * @param {number} [edgeOffsetPx=8] - Foundry's own reference margin width.
 * @returns {number} the margin, as a fraction of the light's radius (>= 0).
 */
export function computeEdgeSoftMarginNormalized(gridSizePixels, radius, edgeOffsetPx = 8) {
  if (!(radius > 0)) return 0;
  const grid = Number.isFinite(gridSizePixels) && gridSizePixels > 0 ? gridSizePixels : 100;
  const marginPx = edgeOffsetPx * (grid / 100);
  return marginPx / radius;
}

/**
 * THE HEIGHT GATE AS A TSL NODE — the ONE implementation, shared by every
 * material that draws a light.
 *
 * ⚠️ **SHARED ON PURPOSE, AND THE REASON IS A LIVE BUG (2026-08-03, round 5).**
 * This started life inline inside `buildPointLightIlluminationMaterial`, and
 * the consequence was immediate: a point light is drawn by TWO meshes sharing
 * ONE geometry — the illumination mesh and `point-light-coloration.js`'s
 * coloration mesh (the visible coloured/ANIMATED glow: torch, pulse, chroma,
 * every entry in the animations registry). Fixing the gate in one of them left
 * the other drawing straight through solid floors, which is exactly what the
 * author saw and reported: *"You are now correctly occluding the light
 * polygon. But you aren't correctly occluding the animated light source."*
 * A gate that lives inside one of two twin materials is a gate half the light
 * ignores. Extracted here so there is one place it can be wrong.
 *
 * ⚠️ TAKES `attrHere` — AN ALREADY-SAMPLED VALUE, NEVER THE RAW TEXTURE NODE.
 * That signature is deliberate and load-bearing. Passing the bare
 * `attrTexNode` is what caused rounds 1-3 to fail: its default uv is `uv()`,
 * the MESH's coordinate, and a light's fan geometry has no `uv` attribute at
 * all, so every fragment read one constant texel. Demanding a sampled vec4
 * forces each caller to state where "here" is — and on a world-space light
 * mesh the only correct answer is `attrTexNode.sample(screenUV)`, because
 * `buf:scene.attr` is a screen-space buffer. See
 * [[feedback_shared_texture_node_carries_the_wrong_uv]].
 *
 * ============================================================================
 * ⚠️ ROUND 8 — WHY AN UNCONFIGURED LIGHT IS NOT ACTUALLY UNGATEABLE
 * ============================================================================
 * `LIGHT_ELEVATION_UNCONFIGURED_SENTINEL` pushes `lo`/`hi` to ~1e6, so the
 * FINE, tolerance-based comparison below provably never fires for a light
 * whose elevation was never touched — by design, so a scene that predates
 * this feature never regresses. Three earlier rounds fixed real bugs in HOW
 * that comparison samples/shares its inputs, but every one of them still
 * required BOTH the light's AND the receiver's elevation to be explicitly,
 * numerically authored before anything happened — which is precisely the
 * authoring burden the fine comparison exists to spare an unconfigured scene
 * from, and precisely why a lantern housing tile that had never had its own
 * elevation touched either stayed invisible to the gate no matter how
 * obviously, visually "on top of" the light it was drawn.
 *
 * The fix is NOT another elevation constant. It is a SECOND, INDEPENDENT
 * signal that needs no per-pair numeric authoring at all:
 * `PRESENCE_BIT_OVERHEAD` (`vt/scene-attr.js`, bit 0) — "is this pixel's
 * content a Level's own FOREGROUND layer, or a Tile explicitly raised into
 * foreground territory". Level foreground art gets this AUTOMATICALLY, with
 * ZERO extra authoring: `foundry/scene-layers.js`'s own level-item builder
 * sets a foreground item's `key.elevation` to `elevation.top` VERBATIM — the
 * Level's own, already-mandatory elevation band, not something this feature
 * asks an author to add. A roof/ceiling painted as a Level's foreground layer
 * (the common case for "this room has a roof") therefore ALREADY reads as
 * overhead today, for every scene, whether or not any light nearby has ever
 * had its own elevation touched.
 *
 * `PRESENCE_BIT_OCCLUDES_BACKGROUND` (bit 7) was considered and REJECTED for
 * this same role: it is set by ANY Tile or Level foreground, including
 * ordinary ground-level furniture and vegetation's own Case-1 host tile —
 * gating on it would have made a torch mounted on a table, or a bush grown on
 * a decorative tile, permanently unlit. `PRESENCE_BIT_OVERHEAD` is narrower
 * and correct: it is true only when something's OWN elevation genuinely
 * crosses into foreground/roof territory, which ordinary same-floor content
 * does not do by accident.
 *
 * Combined with a straight AND (multiply): the fine comparison still gates a
 * CONFIGURED light with the graduated tolerance vegetation needs (a canopy
 * near the top of its floor vs. one halfway up); the overhead bit ADDITIONALLY
 * hard-blocks ANY light — configured or not — under genuine roof/foreground
 * content, with no numeric authoring required on either side.
 *
 * ============================================================================
 * ⚠️ ROUND 9 (2026-08-04) — THE OVERHEAD BIT ALSO CARRIES A TILE'S OWN
 * "RESTRICT LIGHTING" FLAG NOW, AND THIS FUNCTION DID NOT CHANGE AT ALL
 * ============================================================================
 * Live report: a lantern's cover Tile, "Restrict Lighting" ticked in Foundry,
 * elevation meaningfully above its own light — still glowed straight through.
 * Round 8's own numeric arithmetic was already provably correct for that
 * exact pair (pinned as `point-light-illumination.test.mjs`'s own "LIVE CASE
 * 1"); the bug was that `PRESENCE_BIT_OVERHEAD` only ever fired for content
 * crossing a FLOOR's declared ceiling, never for the author's own explicit,
 * per-Tile flag — Foundry's `tile.restrictions.light`
 * (`common/documents/tile.mjs` in the vendored v14 source), which
 * `foundry/scene-layers.js#collectTiles` already reads into
 * `item.restrictsLight` and which sat completely unconsumed until now (see
 * [[feedback_unconsumed_api_rots_silently]]).
 *
 * The fix lives entirely in `vt/scene-attr.js#computeFloorAttrValues` — the
 * SAME bit, written one OR wider (`isInForeground(...) || (kind==='tile' &&
 * restrictsLight)`), scoped to Tiles only so a Level's own background (which
 * gets `restrictsLight: true` UNCONDITIONALLY, mirroring real Foundry) can
 * never set the overhead bit on itself and black out every light on its own
 * floor. This function and `computeHeightGate` below are UNCHANGED — they
 * already treated the overhead bit as a hard, unconditional block; they had
 * no way to know WHY it was set, and still don't need to.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {object} args
 * @param {*} args.attrHere - the fragment's OWN `buf:scene.attr` texel, already
 *   sampled (`attrTexNode.sample(screenUV)`).
 * @param {*} args.uLightElevationRank - this light's `elevationRank` uniform,
 *   or `LIGHT_ELEVATION_UNCONFIGURED_SENTINEL`, which saturates the FINE
 *   comparison to 1 with no branch (the overhead bit still applies).
 * @returns {*} a float node in [0,1] to multiply into a falloff.
 */
export function buildHeightGateNode(TSL, { attrHere, uLightElevationRank }) {
  const { float, floor, mod, smoothstep } = TSL;
  // ⚠️ THE FLOOR INDEX (R) IS HALF THE COMPARISON — see `elevationRank`'s own
  // doc for the live proof of what happens without it (a -20ft basement light
  // and a +5ft upper storey both normalized to "0 above my own floor", and the
  // gate passed 50% of a blown-out light through two solid floors). R is
  // written by every real attr writer and is the SAME channel the live
  // multi-floor sun-shadow cascade already gates on, so it is trustworthy.
  // `+0.5` then `floor` is a round, not a truncate: an RGBA8 texel stores
  // `index/255` exactly, but the float the sampler returns is not guaranteed
  // to land exactly on it.
  const receiverFloorIndex = floor(attrHere.r.mul(float(255)).add(float(0.5)));
  const rawByte = attrHere.b.mul(float(255));
  // Mirrors vt/scene-attr.js#decodeReceiverElevationLevel exactly:
  // floor(mod(byte, 64) / 4) — strips bit 7 (occludes-background) via the mod,
  // then bits 0-1 (overhead/reserved) via the integer divide, regardless of
  // whether either is set.
  const level = floor(mod(rawByte, float(64)).div(float(4)));
  // The fraction must stay strictly below 1 (with the gate's whole band on top
  // of it) so a floor's own top surface can never outrank the floor above it —
  // see `ELEVATION_RANK_FRACTION_DIVISOR`. Mirrors `elevationRank`'s CPU twin.
  const receiverRank = receiverFloorIndex.add(level.div(float(ELEVATION_RANK_FRACTION_DIVISOR)));
  // An UNWRITTEN texel clears to (0,0,0,0) → rank 0 → below every real light →
  // fully lit. Fail-open by construction, the required polarity here
  // (`feedback_gate_polarity_must_fail_open`).
  const lo = uLightElevationRank.add(float(HEIGHT_GATE_TOLERANCE_UNITS / ELEVATION_RANK_FRACTION_DIVISOR));
  const hi = lo.add(float(HEIGHT_GATE_SOFTNESS_UNITS / ELEVATION_RANK_FRACTION_DIVISOR));
  const fineGate = float(1).sub(smoothstep(lo, hi, receiverRank));
  // PRESENCE_BIT_OVERHEAD — bit 0, the LOW bit, no shift needed beyond mod 2.
  // A straight AND with the fine gate: genuine foreground/roof content blocks
  // ANY light, configured or not (see this function's own header).
  const overheadBit = mod(rawByte, float(2));
  const overheadGate = float(1).sub(overheadBit);
  return fineGate.mul(overheadGate);
}

/**
 * MIRRORS `vt/scene-depth.js#DEPTH_FLAG_RESTRICTS_LIGHT`/`DEPTH_FLAG_IS_TILE`
 * EXACTLY — same reason `RECEIVER_ELEVATION_LEVELS_MIRROR` is a duplicate
 * rather than an import (this module's own header, just above
 * `buildHeightGateNode`): `vt/scene-depth.js` cannot be imported from
 * `effects/`, the same one-way layering `vt/scene-attr.js` already
 * establishes by importing FROM `effects/`. Pinned against the real values in
 * `point-light-illumination.test.mjs`.
 */
export const DEPTH_FLAG_RESTRICTS_LIGHT_MIRROR = 1;
export const DEPTH_FLAG_IS_TILE_MIRROR = 16;

/**
 * ============================================================================
 * STAGE 2 (2026-08-04) — THE DEPTH-AUTHORITY HEIGHT GATE
 * ============================================================================
 * {@link buildHeightGateNode}'s replacement for an ORDINARY Foundry point
 * light (illumination + coloration only — candle-flame-render.js and
 * lightning-render.js still call the OLD gate above, a deliberately scoped,
 * named deferral: those two bake their anchor's elevationRank per-VERTEX into
 * a batched mesh, a materially different data path this pass did not touch).
 *
 * `docs/planning/Light-Elevation-Occlusion-Failure.md`'s whole investigation
 * was chasing bugs in a system built on `buf:scene.attr` — a lossy,
 * per-floor-relative, quantized-to-16-levels byte that a live pixel-probe
 * (2026-08-04) caught reading alpha=0 at a pixel with real, visible,
 * `meshVisible:true` floor art directly underneath. `buf:scene.depth`
 * (`vt/scene-depth.js`) replaces the entire quantity this gate compares: no
 * floor index, no within-floor height bucket, no tolerance band, no softness
 * band, no unconfigured sentinel — just RANK, a real per-item ordinal
 * (`scene/depth-authority.js`), compared directly. `uLightExpectedDepth` is
 * already the CPU-resolved comparable value
 * (`vt/scene-depth.js#computeTieSafeExpectedDepth`, which ALSO bakes in the
 * fail-open tie buffer — see that function's own doc for why a bare
 * `computeExpectedStoredDepth` would risk a light occluding its own floor's
 * ground on ordinary float noise); this function has no projection math left
 * to do, unlike `buildHeightGateNode`'s own floor-index-plus-fraction
 * reconstruction.
 *
 * The one piece of the OLD gate this does NOT drop: `PRESENCE_BIT_OVERHEAD`'s
 * own "ROUND 9" fix (a Tile's explicit Foundry "Restrict Lighting" flag,
 * elevation-BLIND by Foundry's own design — see `buildHeightGateNode`'s ROUND
 * 9 header). Rank alone alone does not subsume it: a Tile ticked "Restrict
 * Lighting" sitting at the SAME rank neighbourhood as the light (no elevation
 * difference to rank-order it above) would otherwise read as unblocked.
 * `vt/scene-depth.js#computeSceneDepthFlags` writes this SAME Foundry flag,
 * UNSCOPED, into the depth pass's own colour payload (B channel) — scoped
 * here to `IS_TILE` only, mirroring `scene-attr.js`'s own guard, because a
 * Level's own background gets `restrictsLight:true` UNCONDITIONALLY and an
 * unscoped check would black out every light on its own floor.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {object} args
 * @param {*} args.depthHere - this fragment's own `buf:scene.depth` DEPTH
 *   sample (`depthTexNode.sample(screenUV)`), a plain float.
 * @param {*} [args.flagsHere] - this fragment's own `buf:scene.depth` COLOUR
 *   sample (`depthFlagsTexNode.sample(screenUV)`), a vec4 (B = flags byte).
 *   Omitted → the tile-restrict hard block compiles out; the rank gate alone
 *   still applies.
 * @param {*} args.uLightExpectedDepth - this light's
 *   `computeTieSafeExpectedDepth` result, pushed as a uniform every frame
 *   (`point-light-pool.js`'s own refresh loop).
 * @returns {*} a float node in [0,1] to multiply into a falloff.
 */
export function buildDepthHeightGateNode(TSL, { depthHere, flagsHere, uLightExpectedDepth }) {
  const { float, floor, mod, select } = TSL;
  // RANK — a bare ordinal comparison, no smoothstep: "above" is a fact about
  // draw order, not a fuzzy quantity that needs a fade band. The fail-open
  // buffer already lives inside `uLightExpectedDepth` itself (computed on the
  // CPU), so this stays the same one-line shape `querySceneDepth` proved.
  const rankGate = select(depthHere.lessThan(uLightExpectedDepth), float(0), float(1));
  if (!flagsHere) return rankGate;
  // See this function's own header for why this bit needs its own check
  // alongside rank, and why it is scoped to IS_TILE.
  const flagsByte = floor(flagsHere.b.mul(float(255)).add(float(0.5)));
  const restrictsLightBit = mod(floor(flagsByte.div(float(DEPTH_FLAG_RESTRICTS_LIGHT_MIRROR))), float(2));
  const isTileBit = mod(floor(flagsByte.div(float(DEPTH_FLAG_IS_TILE_MIRROR))), float(2));
  const tileRestrictsLight = restrictsLightBit.mul(isTileBit);
  const flagsGate = float(1).sub(tileRestrictsLight);
  return rankGate.mul(flagsGate);
}

/**
 * THE CPU TWIN of {@link buildDepthHeightGateNode} — Node-testable so the bit
 * arithmetic (a genuinely easy place to get a shift/mask subtly wrong; this
 * exact function's own first draft did, `mod(byte, RESTRICTS_LIGHT*2)`
 * instead of `mod(floor(byte/RESTRICTS_LIGHT), 2)` — numerically identical
 * ONLY because `RESTRICTS_LIGHT` happens to be bit 0, caught before it ever
 * reached a test) is verified before a live scene ever runs it
 * (`feedback_smooth_output_hides_ported_bugs`).
 *
 * @param {object} args
 * @param {number} args.storedDepth - a `buf:scene.depth` DEPTH sample.
 * @param {number} args.expectedDepth - `computeTieSafeExpectedDepth`'s result.
 * @param {number} [args.flagsByte=0] - a raw 0-255 `buf:scene.depth` COLOUR
 *   sample's B channel. Omitted → the tile-restrict block never fires.
 * @returns {number} 0 or 1.
 */
export function computeDepthHeightGate({ storedDepth, expectedDepth, flagsByte = 0 }) {
  const rankGate = storedDepth < expectedDepth ? 0 : 1;
  const restrictsLightBit = Math.floor(flagsByte / DEPTH_FLAG_RESTRICTS_LIGHT_MIRROR) % 2;
  const isTileBit = Math.floor(flagsByte / DEPTH_FLAG_IS_TILE_MIRROR) % 2;
  const flagsGate = restrictsLightBit && isTileBit ? 0 : 1;
  return rankGate * flagsGate;
}

/**
 * THE CPU TWIN of the height/elevation gate (see `buildPointLightIllumination
 * Material`'s own "HEIGHT/ELEVATION GATE" section) — Node-testable so the
 * ARITHMETIC is verified before a live scene ever runs it
 * (`feedback_smooth_output_hides_ported_bugs`: a smooth gate looks like
 * something is happening even when the formula is subtly wrong). A plain
 * smoothstep, no special case: the CALLER encodes "this light was never
 * configured" by passing `LIGHT_ELEVATION_UNCONFIGURED_SENTINEL` rather than
 * this function branching on it — see that constant's own doc for why a
 * branch here would have conflated two different zeros.
 *
 * ⚠️ BOTH ARGUMENTS ARE **RANKS** (`elevationRank`), not raw heights — see
 * that function's own doc for why a raw floor-relative height provably could
 * not answer this question. The polarity also INVERTED with that change: this
 * is now `1 - smoothstep(...)` over the RECEIVER, because the thing being
 * asked is "how far above the light has this surface climbed", and the
 * fail-open direction has to stay "a receiver at or below the light is fully
 * lit" (`feedback_gate_polarity_must_fail_open` — an unwritten `buf:scene
 * .attr` texel decodes to rank 0, the lowest possible, and must read as
 * PROCEED).
 *
 * @param {number} receiverRank - the RECEIVER's `elevationRank`, decoded from
 *   `buf:scene.attr` (R = floor index, B bits 2-5 = height within it).
 * @param {number} lightRank - the LIGHT's own `elevationRank`, or
 *   `LIGHT_ELEVATION_UNCONFIGURED_SENTINEL` (which pushes the whole fade band
 *   far above any real receiver, saturating this half to 1 with no branch —
 *   `receiverOverhead` below still applies regardless).
 * @param {number} [toleranceUnits=HEIGHT_GATE_TOLERANCE_UNITS] - how far above
 *   the light a receiver stays fully lit, in world units within a floor.
 * @param {number} [softnessUnits=HEIGHT_GATE_SOFTNESS_UNITS] - the fade width.
 * @param {number} [receiverOverhead=0] - truthy/1 when the receiver's own
 *   `PRESENCE_BIT_OVERHEAD` is set (genuine Level foreground/roof content, a
 *   Tile explicitly raised into foreground territory, or a Tile with
 *   Foundry's own "Restrict Lighting" ticked — see this function's sibling
 *   `buildHeightGateNode`'s own "ROUND 8"/"ROUND 9" headers for the full
 *   reasoning). A straight AND with the fine comparison: hard-blocks ANY
 *   light, configured or not, needing NO numeric elevation authored on
 *   either side — the gap that left an unconfigured light immune to every
 *   cover drawn over it, however obviously, visually "on top" in the art.
 * @returns {number} 0..1, the fraction of this light's own falloff that
 *   survives the height gate.
 */
export function computeHeightGate(
  receiverRank,
  lightRank,
  toleranceUnits = HEIGHT_GATE_TOLERANCE_UNITS,
  softnessUnits = HEIGHT_GATE_SOFTNESS_UNITS,
  receiverOverhead = 0
) {
  const light = Number.isFinite(lightRank) ? lightRank : 0;
  const receiver = Number.isFinite(receiverRank) ? receiverRank : 0;
  // Tolerance/softness are authored in world units for readability; the
  // comparison happens in rank space, where one floor is 1.0 and one
  // quantization level (1 world unit at RANGE=15) is 1/LEVELS.
  const tolerance = (Number.isFinite(toleranceUnits) ? toleranceUnits : 0) / ELEVATION_RANK_FRACTION_DIVISOR;
  const softness = (Number.isFinite(softnessUnits) ? softnessUnits : 0) / ELEVATION_RANK_FRACTION_DIVISOR;
  const lo = light + tolerance;
  const hi = lo + softness;
  let fine;
  if (Math.abs(hi - lo) < 1e-9) {
    fine = receiver > lo ? 0 : 1; // degenerate (zero) softness — a razor edge, not undefined
  } else {
    const t = Math.min(1, Math.max(0, (receiver - lo) / (hi - lo)));
    fine = 1 - t * t * (3 - 2 * t); // 1 - smoothstep
  }
  const overheadGate = receiverOverhead ? 0 : 1;
  return fine * overheadGate;
}

/**
 * The analytic soft-edge SDF — exact signed distance from a LOCAL-space
 * point to the light's own polygon boundary (negative = inside, positive =
 * outside), via the standard point-in-polygon-ray-cast + min-distance-to-
 * segment shader technique (this module's header explains why, and cites
 * precedent). Wrapped in its own `Fn` — verified against the vendored
 * three.webgpu.js that `Loop`/`.toVar()`/`.assign()` (loop-carried mutable
 * state) are meant to run inside a shader-function-building context (the
 * SAME pattern the vendor's own `ggxConvolution`/`importanceSampleGGX_VNDF`
 * use), not procedurally alongside plain node construction.
 *
 * @param {*} TSL - THREE.TSL, passed in rather than closed over so this
 *   function has no hidden dependency on `buildPointLightIlluminationMaterial`'s
 *   own destructure.
 * @returns {*} a `Fn(([p, poly, edgeCount]) => signedDistance)` node function.
 */
function makeSdPolygonEdgeDistance(TSL) {
  const { Fn, Loop, select, bool, int, float, min, max, dot, sqrt } = TSL;
  return Fn(([p, poly, edgeCount]) => {
    const minDistSq = float(1e12).toVar();
    const inside = bool(false).toVar();

    Loop(edgeCount, ({ i }) => {
      // j = the PREVIOUS vertex (wraps 0 -> edgeCount-1) — the polygon is
      // implicitly closed, same convention as triangulateLightFan's fan.
      const j = select(i.equal(int(0)), edgeCount.sub(int(1)), i.sub(int(1)));
      const pi = poly.element(i);
      const pj = poly.element(j);

      // Min distance from p to the segment (pi, pj).
      const e = pj.sub(pi);
      const w = p.sub(pi);
      // Guard a zero-length edge (degenerate/duplicate vertex): 0/0 is NaN,
      // which IEEE-754 min() handles inconsistently — floor the denominator
      // instead of trusting a shader backend's NaN-propagation-through-min.
      const eDotE = max(dot(e, e), float(1e-12));
      const tClamped = min(float(1), max(float(0), dot(w, e).div(eDotE)));
      const closest = w.sub(e.mul(tClamped));
      minDistSq.assign(min(minDistSq, dot(closest, closest)));

      // Standard ray-casting point-in-polygon crossing test: toggle `inside`
      // each time the horizontal ray from p crosses edge (pi,pj). Safe
      // against the yi==yj division (would need crossesY true, which
      // REQUIRES yi!=yj) by construction, same as every shipped
      // implementation of this decades-old algorithm.
      const crossesY = pi.y.greaterThan(p.y).notEqual(pj.y.greaterThan(p.y));
      const xIntersect = pj.x.sub(pi.x).mul(p.y.sub(pi.y)).div(pj.y.sub(pi.y)).add(pi.x);
      const crosses = crossesY.and(p.x.lessThan(xIntersect));
      inside.assign(select(crosses, inside.not(), inside));
    });

    const dist = sqrt(minDistSq);
    return select(inside, dist.negate(), dist);
  });
}

/**
 * Build ONE point light's illumination material — fresh `uRatio`/
 * `uAttenuationEased`/soft-edge uniforms per light (mirrors vt-pan-viewer.js's
 * `buildOcclusionDisc`'s per-instance `uElevation`), referencing THREE
 * SHARED ambient-colour uniforms every light reads (updated once per frame
 * from `computeAmbientColors` — the caller's job, not this module's).
 *
 * SOFT EDGE (see this module's header): `edgePoints` is a FIXED-CAPACITY
 * (`MAX_LIGHT_EDGES`) array of real `THREE.Vector2` instances backing a
 * `uniformArray` — created ONCE here, returned for the caller to mutate
 * in place every frame via `writeLightEdgePoints` (never replaced — a
 * `uniformArray`'s size is fixed forever at shader-setup time, verified
 * against the vendored source; replacing it would mean a shader rebuild,
 * not the cheap per-frame update this is designed for).
 *
 * MAX BLENDING (`THREE.CustomBlending` + `MaxEquation` + `OneFactor`/
 * `OneFactor`, both RGB and alpha) — Foundry's own `MAX_COLOR`: overlapping
 * lights take the BRIGHTER value, never sum (audit §3, §18.2). Mirrors this
 * project's own `MinEquation` occlusion-disc precedent (vt-pan-viewer.js),
 * sign flipped.
 *
 * `side: THREE.DoubleSide` — the mesh is a hand-built fan from Foundry's own
 * (clockwise, canvas-space) polygon data, not a THREE-authored primitive
 * like `CircleGeometry`; rather than derive its winding under this project's
 * flipped camera (`feedback_y_flip_recurring_risk` — a repeat offender), a
 * flat 2D light shape has no meaningful "back face" to cull, so winding is
 * made irrelevant instead of solved.
 *
 * `mix`/`clamp`/`smoothstep`/`length` are called as FUNCTIONS, never
 * methods — the codebase's own documented trap (`reference_tsl_method_
 * chaining_trap`): `.mix()` as a method takes the RECEIVER as the
 * interpolant (third argument), not the first, and silently compiles to the
 * wrong blend. Simple binary arithmetic (`.mul`/`.add`/`.sub`/`.max`) is used
 * as methods, matching this file's own already-proven-safe `.max()` usage
 * elsewhere in vt-pan-viewer.js.
 *
 * ANIMATION SEED INJECTION (2026-07-20, docs/planning/Light-Parity.md §5's
 * last item) — the optional `args.animation` param is the ONLY seam an
 * animated light uses. Verified against Foundry source (docs/reference/
 * foundry-v14-light-animations-audit.md): every animation shader is the
 * SAME scaffold (FRAGMENT_BEGIN → …→ FALLOFF → FRAGMENT_END) with exactly
 * one line swapped — the seed `finalColor` expression, normally
 * `switchColor(bright,dim,dist)` (the `t`/`mix(uBrightColor,uDimColor,t)`
 * below). Everything downstream — EXPOSURE, FALLOFF, the soft-edge SDF, the
 * background mix, the MAX-blend material setup — is genuinely identical for
 * every animation and for no animation at all, so it stays exactly ONE
 * implementation, reused, never duplicated per-animation. When
 * `args.animation` is absent this function's output is BYTE-IDENTICAL to
 * before this param existed (regression safety net for every light that
 * isn't animated, i.e. most lights).
 *
 * GPU-ONLY ANIMATION (2026-07-20 rewrite, the author's own WebGPU-
 * performance direction: "let's not leave any CPU stuff in if we can avoid
 * it"). `time`/flicker-noise/pulse-wave used to be computed on the CPU
 * every frame per light and written into per-animation uniforms; now the
 * SCAFFOLD owns four small per-light "raw" uniforms
 * (`uSpeedRaw`/`uReverseSign`/`uSeed`/`uIntensityRaw`, Foundry's own
 * animation config, essentially static — CPU only writes them when they
 * actually change) plus ONE SHARED `uGlobalTimeMs` (the caller's job,
 * written ONCE per frame, not per light), and computes `time` in-shader via
 * `light-animation-clock.js#buildAnimationTimeNode`. `computeSwitchColorBand`
 * is exposed so a flicker/pulse-driven animation can rebuild the bright/dim
 * band with a GPU-JITTERED ratio instead of the base one — this replaces
 * the old trick where Torch's illumination needed "no shader code" because
 * the CPU pre-wrote a jittered `uRatio`; now the ratio jitter itself is a
 * GPU computation, so animations that need it call `computeSwitchColorBand`
 * themselves with their own ratio node.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uBackgroundColor - shared vec3 uniform (sRGB), env's `background`.
 * @param {*} args.uDimColor - shared vec3 uniform (sRGB), env's `dim`.
 * @param {*} args.uBrightColor - shared vec3 uniform (sRGB), env's `bright`.
 * @param {{buildIlluminationSeed: (function(object): {finalColor: *, skipExposure: (boolean|undefined)})}} [args.animation] -
 *   from effects/lighting/animations/registry.js's matched entry. When its
 *   `buildIlluminationSeed` is present it's called with `{THREE,
 *   uBrightColor, uDimColor, uRatio, uAttenuationEased, dist, defaultSeed,
 *   time, uIntensityRaw, computeSwitchColorBand}` and must return
 *   `{finalColor, skipExposure}` — `finalColor` replaces the seed;
 *   `skipExposure` (rare — currently only Pulse) omits the EXPOSURE stage
 *   entirely when true.
 * @param {*} [args.uGlobalTimeMs] - the ONE shared time uniform (see this
 *   function's own header) — REQUIRED when `animation` is present, unused
 *   otherwise.
 * @param {number} [args.animationQuality=0] - a graph-BUILD-time quality tier
 *   forwarded to the seed builder as `quality`. A JS-time integer (never a
 *   uniform), so a richer tier's extra nodes are only CONSTRUCTED at that
 *   tier — the `tsl/no-uniform-gates` wall's own rule. Only MSA-native
 *   animations that declare tiers (currently `candleFlicker`) read it;
 *   every other seed builder ignores the extra arg harmlessly.
 * @param {'foundry'|'inverseSquare'} [args.falloffModel='foundry'] - the radial
 *   falloff curve, a graph-build-time choice (never a uniform). `foundry` =
 *   the attenuation-slider corona (every real Foundry light); `inverseSquare`
 *   = a physical bright-centre/fast-drop curve (candles). See
 *   `inverseSquareFalloff`.
 * @param {{x:number,y:number}} [args.windCenter] - this light's WORLD
 *   position, for sampling the shared wind field (world/wind-field.js's
 *   `sampleWind` — Wind.md Tier 0). OPT-IN: paired with `windExposure`, both
 *   must be provided for the wind machinery to build at all — an ordinary
 *   Foundry light (no wind semantics) supplies neither and pays nothing extra.
 * @param {number} [args.windExposure] - 0..1 sky exposure at `windCenter`
 *   (scene/mask-catalog.js's `outdoors` — NOT `skyReach`, a DIFFERENT, rain-
 *   occlusion-specific product; see boot.js#getCandleRenderState's own note
 *   for why — matching the candle FLAME's own `windExposure` geometry
 *   attribute) — 1 = open to the wind, 0 = sheltered. Absent/non-finite =
 *   wind sampling is skipped entirely for this light.
 * @param {object} [args.windHandle] - the wind handle (`world/wind-access.js`,
 *   Wind.md §5.1): the live ambient bias, Tier 1's baked openness, the
 *   wall-avoidance deflection field and Tier 2's transient D_live, as ONE
 *   object, read under the same `windExposure`-presence gate. Replaces the
 *   four separate arguments this used to forward by hand — a block that was
 *   copy-pasted verbatim across four call sites and, at one of them, silently
 *   went stale for a whole session. Omit → Tier-0 organic wind only.
 * @param {number} [args.windResponse] - Wind.md §8.1's per-effect gain (e.g.
 *   `effects/candle-flame.js`'s `windResponse` param) — built into a THIRD
 *   wind uniform under the SAME `windExposure`-presence gate, forwarded to
 *   the animation seed builder as `windResponse` for it to scale lean/
 *   gutter/snuff with (candle-flicker.js is the one consumer today). Absent
 *   or non-finite → the seed builder's own default (1) applies.
 * @param {Array<{texNode:*, uRect:*, uFloorIndex01:*}>} [args.sunShadowSlotNodes] -
 *   `environmental-light.js`'s own `sunShadowSlotNodes` — the SAME per-slot
 *   nodes the ambient fill reads, SHARED (not rebuilt here) so the light and
 *   the ambient fill can never disagree about where a floor's field is or
 *   what it currently contains. When supplied, this light's background floor
 *   is sampled from EVERY resident slot PER-FRAGMENT and blended by floor
 *   attribution (see this module's "SUN-SHADOW ATTENUATION" header for the
 *   two per-light attempts this replaced, and for why per-fragment, not
 *   per-light, was always the right unit). Omitted/empty → the lookup is
 *   compiled out entirely and the material is unchanged.
 * @param {*} [args.attrTexNode] - `environmental-light.js`'s own `attrTexNode`
 *   (`buf:scene.attr`, R = this fragment's floor index / 255), SHARED for the
 *   same reason `sunShadowSlotNodes` is. Omitted with multiple slots present
 *   → falls back to slot 0 alone (no floor gating), the pre-multi-floor
 *   behaviour, rather than guessing which slot is "this light's own floor".
 *   No longer feeds the height/elevation gate — see `depthTexNode` below
 *   (STAGE 2, 2026-08-04).
 * @param {*} [args.depthTexNode] - `environmental-light.js`'s own
 *   `depthTexNode` (`buf:scene.depth`'s DEPTH attachment) — THE height/
 *   elevation gate's primary input now (see this module's own "STAGE 2"
 *   section, just above `buildDepthHeightGateNode`). Omitted → that gate
 *   compiles out entirely, same posture the old `attrTexNode`-gated version had.
 * @param {*} [args.depthFlagsTexNode] - `environmental-light.js`'s own
 *   `depthFlagsTexNode` (`buf:scene.depth`'s COLOUR attachment, B = flags
 *   byte) — the gate's secondary input, the Tile-"Restrict Lighting" hard
 *   block. Omitted → that ONE block compiles out; the rank comparison alone
 *   still applies.
 * @param {(TSL: *, args: object) => *} [args.blendSunVisibilityAcrossFloors] -
 *   injected from `environmental-light.js` (same DI convention specular/water
 *   already use for `buildOutdoorsGate`) — the ARITHMETIC per-slot blend; see
 *   its own header for why this must never be a `select()`/branch fold
 *   (`feedback_tsl_select_chain_strands_vars`).
 * @param {number} [args.apertureCount=0] - APERTURE GOBO (round 10,
 *   2026-08-04, `docs/planning/Aperture-Gobo.md` — a real Foundry wall's
 *   own `light:PROXIMITY` aperture casting a mullioned-window pattern).
 *   Graph-BUILD-TIME, like `falloffModel` — 0 compiles the whole gobo term
 *   out entirely, byte-identical to before this param existed. See "THE
 *   GOBO IS PART OF THIS LIGHT'S OWN FALLOFF" below for why this moved
 *   in here instead of staying a separate post-process pass.
 * @param {number} [args.apGoboCols] @param {number} [args.apGoboRows] -
 *   `aperture-gobo-render.js#buildApertureGoboTerm`'s own unroll counts,
 *   forwarded verbatim.
 * @param {object} [args.apertureGoboShared] - `aperture-gobo-render.js#
 *   createApertureGoboSharedUniforms`'s own return, ONE instance for the
 *   whole pool, forwarded verbatim.
 * @returns {{material: *, uRatio: *, uAttenuationEased: *, uExposure: *,
 *   uEdgeCount: *, uEdgeSoftMargin: *, edgePoints: object[],
 *   uSpeedRaw: (*|null), uReverseSign: (*|null), uSeed: (*|null),
 *   uIntensityRaw: (*|null), uWindCenter: (*|null), uWindExposure: (*|null),
 *   uWindResponse: (*|null), uLightExpectedDepth: *, backgroundFloor: *,
 *   combinedFalloff: *, finalColorExposed: *,
 *   uApLampHeight: (*|null), apApertures: (Array|null)}}
 *   the four `u*` animation-config uniforms (and the three wind uniforms)
 *   are `null` when `animation` (or `windCenter`/`windExposure`) is absent —
 *   nothing for the caller to write. `backgroundFloor`, `combinedFalloff` and
 *   `finalColorExposed` are always real nodes (never null) — see this
 *   function's own return statement. `uApLampHeight`/`apApertures` are
 *   `null` when `apertureCount` is 0.
 */
export function buildPointLightIlluminationMaterial({
  THREE,
  uBackgroundColor,
  uDimColor,
  uBrightColor,
  animation,
  uGlobalTimeMs,
  animationQuality = 0,
  falloffModel = 'foundry',
  windCenter,
  windExposure,
  windResponse,
  windHandle = TIER0_WIND_HANDLE,
  sunShadowSlotNodes,
  attrTexNode,
  depthTexNode,
  depthFlagsTexNode,
  blendSunVisibilityAcrossFloors,
  apertureCount = 0,
  apGoboCols,
  apGoboRows,
  apertureGoboShared,
}) {
  const {
    uniform,
    uniformArray,
    float,
    int,
    vec2,
    vec4,
    mix,
    clamp,
    smoothstep,
    length,
    positionLocal,
    positionWorld,
    screenUV,
    select,
  } = THREE.TSL;

  /**
   * ============================================================================
   * ⚠️ `buf:scene.attr` MUST BE SAMPLED WITH `screenUV` HERE. NEVER BARE.
   * ============================================================================
   * **This is the 2026-08-03 ROUND-4 fix, and it is the reason rounds 1-3 all
   * failed on a real scene while every arithmetic trace looked perfect.**
   *
   * `attrTexNode` arrives from `environmental-light.js` as a plain
   * `texture(attrTexture)` — a node with NO uv of its own, so it defaults to
   * `uv()`, the MESH's own texture coordinate. That is correct for the
   * environmental pass, which is a FULLSCREEN QUAD where `uv()` spans the
   * screen. It is meaningless here: a point light draws a WORLD-SPACE fan
   * whose geometry (`point-light-pool.js#createLightEntry`) sets exactly ONE
   * attribute, `position` — **there is no `uv` attribute on a light mesh at
   * all.** Every `attrTexNode.r`/`.b` read in this material was therefore
   * sampling a constant, identical for every fragment of every light.
   *
   * Measured, not reasoned: the `floor-lighting` bench renders this exact
   * material over a real three-floor building and varies ONLY the attr
   * buffer. Before this fix its `the-frame-changes-at-all-between-floors`
   * check reported **0.00% of pixels differ** — a byte-identical frame whether
   * the fragment sat under a solid slab or under open sky. A gate cannot be
   * "tuned" out of reading the wrong texel, which is why three rounds of
   * margin/range/rank corrections downstream all changed nothing visible.
   *
   * `buf:scene.attr` is a SCREEN-space buffer (an MRT attachment on
   * `scene.color`, sized in device px — `vt/scene-attr.js#describeSceneAttrMrt`),
   * so the fragment's own texel is at `screenUV`. This is the identical
   * technique the sibling COLORATION material — which shares this very
   * geometry object — already uses and documents as "this project's own
   * already-proven technique" (`point-light-coloration.js`, `texture(albedo
   * Texture, screenUV)`), and which `light-visibility.js` states outright:
   * *"`screenUV` is target/viewport-relative (not mesh-UV-relative)"*.
   *
   * Sampled ONCE and shared by both consumers below (the height gate and the
   * per-floor sun-shadow blend) rather than sampled twice — one texel fetch,
   * and no chance of the two disagreeing about where "here" is.
   */
  const attrHere = attrTexNode ? attrTexNode.sample(screenUV) : null;
  // Same `screenUV`-not-bare rule as `attrHere` just above (this material's
  // mesh carries no `uv` attribute) — see this file's own "STAGE 2" section
  // for why these two feed the height/elevation gate now instead of `attrHere`.
  const depthHere = depthTexNode ? depthTexNode.sample(screenUV) : null;
  const depthFlagsHere = depthFlagsTexNode ? depthFlagsTexNode.sample(screenUV) : null;

  const uRatio = uniform(float(0.5));
  const uAttenuationEased = uniform(float(0.5));
  const uExposure = uniform(float(0));
  const uEdgeCount = uniform(int(0));
  const uEdgeSoftMargin = uniform(float(0));

  // Fixed-capacity, allocated ONCE — see this function's own header. Real
  // THREE.Vector2 instances (UniformArrayNode's own update() reads
  // vector.x/vector.y off each element — verified against the vendored
  // source), initialized to the origin (harmless: unused slots past
  // uEdgeCount are never read by the shader's Loop).
  const edgePoints = Array.from({ length: MAX_LIGHT_EDGES }, () => new THREE.Vector2(0, 0));
  const edgePointsUniform = uniformArray(edgePoints, 'vec2');

  // dist: Foundry's own vUvs/dist derivation collapses, in this project's
  // local-unit-radius space, to exactly this — see this module's header.
  const localXY = positionLocal.xy;
  const dist = length(localXY);

  // switchColor(bright, dim, dist) — TRANSITION, audit §5c. Exposed as a
  // reusable function of `ratio` (not just the default `uRatio`) so a
  // flicker/pulse-driven animation can rebuild this SAME band with its own
  // GPU-jittered ratio — see this function's own header.
  const computeSwitchColorBand = (ratio) => {
    const attenuationStrength = uAttenuationEased.mul(float(0.7));
    const lowerEdge = ratio.mul(float(0.99).sub(attenuationStrength));
    const upperEdge = clamp(ratio.mul(float(1.01).add(attenuationStrength)), float(0.0001), float(1.0));
    const t = smoothstep(lowerEdge, upperEdge, dist);
    return mix(uBrightColor, uDimColor, t);
  };
  const defaultSeed = computeSwitchColorBand(uRatio);

  // ANIMATION SEED INJECTION — see this function's own header. Absent
  // `animation`/`buildIlluminationSeed` (the overwhelming common case, and
  // every call site before this param existed): finalColor === defaultSeed,
  // output is unchanged. `skipExposure` is a second, rarer escape hatch:
  // docs/reference/foundry-v14-light-animations-audit.md's own §4 `pulse`
  // entry is the ONE Foundry animation (of 27) whose illumination channel
  // skips `${ADJUSTMENTS}` (== EXPOSURE here) entirely, verified against
  // source — a JS-time decision (which nodes get BUILT), not a runtime one,
  // per the `tsl/no-uniform-gates` wall ("tier selection is a JS `if` at
  // graph-build time — the nodes are never constructed"; a runtime toggle
  // would still pay for the compiled branch).
  let finalColor = defaultSeed;
  let skipExposure = false;
  let uSpeedRaw = null;
  let uReverseSign = null;
  let uSeed = null;
  let uIntensityRaw = null;
  let uWindCenter = null;
  let uWindExposure = null;
  let uWindResponse = null;
  if (animation?.buildIlluminationSeed) {
    uSpeedRaw = uniform(float(5));
    uReverseSign = uniform(float(1));
    uSeed = uniform(float(0));
    uIntensityRaw = uniform(float(5));
    const time = buildAnimationTimeNode(THREE.TSL, { uSpeedRaw, uReverseSign, uSeed, uGlobalTimeMs });
    // SHARED WIND (Wind.md Tier 0) — OPT-IN: built only when the caller
    // supplies BOTH a world position and a finite exposure (an ordinary,
    // non-wind-aware Foundry light supplies neither, so it builds nothing
    // extra and pays nothing extra). `wind` is a vec2 node, sampled ONCE
    // here — a seed builder wanting it reads `args.wind` directly rather
    // than calling `sampleWind` itself, so there is exactly one call site
    // per light, never a per-animation re-derivation of the same field.
    let wind;
    if (Number.isFinite(windExposure)) {
      uWindCenter = uniform(vec2(windCenter?.x ?? 0, windCenter?.y ?? 0));
      uWindExposure = uniform(float(windExposure));
      // A THIRD wind uniform, same opt-in gate — see this function's own
      // `windResponse` param doc. Defaults to 1 (the tuned reference) so a
      // caller carrying wind machinery but not yet passing windResponse
      // still gets today's look, never a silently wind-deaf light.
      uWindResponse = uniform(float(Number.isFinite(windResponse) ? windResponse : 1));
      wind = windHandle.node(THREE.TSL, {
        centerXY: uWindCenter,
        time: uGlobalTimeMs,
        exposure: uWindExposure,
      });
    }
    const seeded = animation.buildIlluminationSeed({
      THREE,
      uBrightColor,
      uDimColor,
      uRatio,
      uAttenuationEased,
      dist,
      defaultSeed,
      time,
      uIntensityRaw,
      computeSwitchColorBand,
      quality: animationQuality,
      wind,
      windResponse: uWindResponse,
    });
    finalColor = seeded.finalColor;
    skipExposure = seeded.skipExposure === true;
  }

  // EXPOSURE, audit §8/§18 (`AdaptiveIlluminationShader.EXPOSURE`) — a
  // luminosity-driven multiplier on the switchColor result, BEFORE falloff.
  // `uExposure = luminosity*2-1` (computeExposure, computed on the CPU side
  // per light per frame — the SAME "ease once outside the shader" pattern as
  // uAttenuationEased). At the default luminosity (0.5) this is exactly 0, a
  // true no-op — which is why every point light rendered correctly before
  // this term existed; it only bites when a light's luminosity is tuned away
  // from default (e.g. the global-illumination floor's OWN default is 0, not
  // 0.5 — effects/lighting/environmental-light.js#computeGlobalLightFloor
  // handles that case separately since it isn't a mesh). `select` reproduces
  // Foundry's `if (exposure>0) {...} else if (exposure!=0) {...}` — the
  // "else" (exposure exactly 0) branch is folded into the same `<=0` arm
  // below since `1+exposure` at exposure=0 is already the identity.
  let finalColorExposed;
  if (skipExposure) {
    finalColorExposed = finalColor;
  } else {
    const attenuationStrengthExp = uAttenuationEased.mul(float(0.25));
    const lowerEdgeExp = uRatio.mul(float(0.98).sub(attenuationStrengthExp));
    const upperEdgeExp = clamp(uRatio.mul(float(1.02).add(attenuationStrengthExp)), float(0.0001), float(1.0));
    const quartExposure = uExposure.mul(float(0.25));
    const finalExposurePositive = quartExposure
      .mul(float(1).sub(smoothstep(lowerEdgeExp, upperEdgeExp, dist)))
      .add(quartExposure);
    const exposureFactor = select(
      uExposure.greaterThan(float(0)),
      float(1).add(finalExposurePositive),
      float(1).add(uExposure)
    );
    finalColorExposed = finalColor.mul(exposureFactor);
  }

  // FALLOFF, audit §7 — the AUTHORED attenuation slider's own radial corona,
  // epsilon-guarded: Foundry branches `if (attenuation != 0.0)` to skip a
  // degenerate smoothstep(1,1,dist) when attenuation is authored as exactly
  // 0 (a reachable state — LightData's AlphaField allows it). A branch-free
  // equivalent: floor attenuation at a tiny epsilon, so the edge case
  // becomes a razor-thin (not degenerate/undefined) transition instead —
  // numerically harmless, avoids relying on a shader backend's edge0==edge1
  // smoothstep behaviour being well-defined.
  // FALLOFF MODEL (2026-07-20) — a graph-BUILD-time JS branch (never a
  // uniform, per no-uniform-gates): `foundry` is the default attenuation-
  // slider corona above; `inverseSquare` is a physical bright-centre/fast-
  // drop-off curve (candles — see inverseSquareFalloff's own header). The
  // attenuation slider does not apply to the inverse-square model (its
  // steepness is INVERSE_SQUARE_STEEPNESS, not the slider).
  let falloff;
  if (falloffModel === 'inverseSquare') {
    falloff = inverseSquareFalloff(THREE.TSL, dist);
  } else {
    const attenForFalloff = uAttenuationEased.max(float(0.0001));
    falloff = smoothstep(float(1), float(1).sub(attenForFalloff), dist);
  }

  // THE SOFT-EDGE MARGIN — a SEPARATE, constant-width antialiasing term
  // (see this module's header): signedDist < 0 means inside the true
  // boundary; -signedDist grows the further inside a fragment sits.
  // smoothstep(0, margin, -signedDist) is 0 right at/outside the boundary,
  // 1 once safely past the margin — multiplied into `falloff`, NOT
  // replacing it, since the two answer different questions.
  const sdPolygonEdgeDistance = makeSdPolygonEdgeDistance(THREE.TSL);
  const signedDist = sdPolygonEdgeDistance(vec2(localXY.x, localXY.y), edgePointsUniform, uEdgeCount);
  const edgeSoftFactor = smoothstep(float(0), uEdgeSoftMargin, signedDist.negate());
  // STILL DISABLED (2026-07-19) — the "lights read monochrome" report is
  // CONFIRMED NOT this term (root cause found + fixed elsewhere: point-
  // light-coloration.js's mesh was drawing for colourless lights, where real
  // Foundry's `isRequired` gate skips it entirely — see vt-pan-viewer.js's
  // `colorationMesh.visible = light.hasColor` and foundry/scene-lights.js's
  // `hasColor` field). BUT wiring `edgeSoftFactor` into `combinedFalloff`
  // was tried live once (same day) and produced a DIFFERENT, WORSE symptom
  // — the whole scene went solid black, all 79 active lights included, not
  // just colourless ones — so something in this Loop/uniformArray/Fn SDF
  // path is genuinely broken in the browser, not merely dead-code-eliminated
  // as the earlier bisection worried. Reading the vendored THREE source
  // (UniformArrayNode#update, updateType RENDER) did not turn up the cause —
  // it copies array[i].x/.y into its buffer every render call, which looks
  // correct. Needs a live A/B (screenshot with/without this line) to find
  // the real defect before it's safe to re-enable. Do NOT flip this back to
  // `falloff.mul(edgeSoftFactor)` without that live verification first.
  let combinedFalloff = falloff;
  void edgeSoftFactor;

  // ── HEIGHT/ELEVATION GATE (2026-08-03) ───────────────────────────────────
  // Author: "tiles for the covers of lanterns... should be dark because they
  // are above the light sources that make them" — and the same question
  // asked of vegetation (`vt-pan-viewer.js`'s tree/bush overlay, whose own
  // canopy height rides the SAME channel via its live `treeHeightFt`/
  // `bushHeightFt` — `vegetation-render.js#vegetationHeightFt` — not its
  // host tile's elevation).
  //
  // SAME SHAPE AS `falloff`/`edgeSoftFactor`, NOT aperture-gobo's deleted
  // first design (see this file's own note just above for why that one was
  // removed): this multiplies INTO `combinedFalloff`, so gating it to 0 only
  // ever fades THIS light's own contribution back to `backgroundFloor` — the
  // ambient floor MAX-blending already agrees on. It can never darken a
  // fragment BELOW that floor, which is exactly what a light being too low
  // to reach a receiver means (no contribution from THIS source, not
  // "actively dark").
  //
  // STAGE 2 (2026-08-04) — RANK, not a floor-relative byte. See this file's
  // own "STAGE 2 — THE DEPTH-AUTHORITY HEIGHT GATE" section (just above
  // `buildDepthHeightGateNode`) for the full reasoning and the live pixel-
  // probe evidence that retired `buf:scene.attr` for this consumer.
  // `uLightExpectedDepth` has no "unconfigured" sentinel to default to —
  // `scene/depth-authority.js#rankOfElevation`'s own point is that elevation
  // 0 (untouched) is already an ordinary, real, comparable rank, so this
  // starts at 0 (harmless: `point-light-pool.js`'s per-frame refresh
  // overwrites it before this material ever draws a real frame) rather than
  // inheriting the old sentinel's meaning.
  const uLightExpectedDepth = uniform(float(0));
  if (depthHere) {
    combinedFalloff = combinedFalloff.mul(
      buildDepthHeightGateNode(THREE.TSL, { depthHere, flagsHere: depthFlagsHere, uLightExpectedDepth })
    );
  }

  // APERTURE GOBO (docs/planning/Aperture-Gobo.md) used to multiply into
  // THIS falloff, same family as `edgeSoftFactor` above — REMOVED 2026-08-03,
  // the same day it shipped, after the first live scene showed why that home
  // was structurally wrong: this material MAX-blends into `buf:scene.illum`,
  // and a MAX blend can only ever brighten a fragment above whatever is
  // already there — a term living INSIDE one light's own falloff can never
  // darken a spot BELOW ambient, no matter how it's tuned, which is exactly
  // why the pattern was invisible in daylight and barely visible even at
  // night. A window's mullion pattern needs to behave like a genuine SHADOW
  // — darkening the SHARED illumination directly, the same way the sun-
  // shadow field already does — so it now lives in its own dedicated
  // MULTIPLY-blended pass (`aperture-gobo-render.js#buildApertureShadowMaterial`,
  // `point-light-pool.js`'s own `apertureShadowScene`), drawn AFTER point
  // lights accumulate, not folded into any one light's own material. This
  // file is deliberately apertures-UNAWARE again.

  // SUN-SHADOW ATTENUATION — see this module's own header for the two failed
  // per-light attempts and why this has to be per-FRAGMENT. `positionWorld.xy`
  // is the real fragment world position (the exact node + world-rect mapping
  // `region-darkness.js` and `environmental-light.js#buildOutdoorsGate`
  // already use), so the floor is shadowed precisely where the shadow is.
  //
  // ⚠️ PER-FLOOR, NOT JUST PER-FRAGMENT (2026-08-02) — a light's own footprint
  // can straddle a floor gap exactly the same way any other content can (a
  // torch near a stairwell, or one floor below a hole in the floor above), so
  // "which slot's field applies" is ALSO a per-fragment question, answered by
  // the SAME arithmetic blend `environmental-light.js`'s own ambient fill
  // uses — never a `select()`/branch fold (`feedback_tsl_select_chain_strands_vars`).
  // Before this a light had NO floor gate at all (unlike the ambient fill,
  // which has had one since 2026-07-28): every light sampled whichever ONE
  // field happened to be resident, on every floor, all the time.
  //
  // A JS-time branch, not a uniform gate (`tsl/no-uniform-gates`): with no
  // slots supplied the lookup is absent from the compiled shader entirely and
  // this material is byte-identical to what it was before cast shadows existed.
  let backgroundFloor = uBackgroundColor;
  if (sunShadowSlotNodes && sunShadowSlotNodes.length > 0) {
    // Clamped, never wrapped — a light overhanging a field's edge reads the
    // nearest edge value rather than a caster from the far side of the map.
    const sampleSlot = (slot) => {
      const u = positionWorld.x.sub(slot.uRect.x).div(slot.uRect.z.sub(slot.uRect.x));
      const v = positionWorld.y.sub(slot.uRect.y).div(slot.uRect.w.sub(slot.uRect.y));
      return slot.texNode.sample(vec2(u.clamp(0, 1), v.clamp(0, 1))).r;
    };
    // ⚠️ THE FLOOR SOURCE IS `buf:scene.depth`, NOT `buf:scene.attr` (2026-08-05
    // — the shadow cascade's receiver half). `blendSunVisibilityAcrossFloors`'s
    // own `attrFloorIndex01` doc has the argument. `depthFlagsHere` is the SAME
    // `screenUV` sample the depth HEIGHT gate above already takes (STAGE 2,
    // 2026-08-04) — reused, never re-sampled (memory:
    // feedback_composite_only_terms_miss_shared_buffers).
    const shadowFloorHere = depthFlagsHere ?? attrHere;
    const sunVis =
      shadowFloorHere && blendSunVisibilityAcrossFloors
        ? blendSunVisibilityAcrossFloors(THREE.TSL, {
            attrFloorIndex01: shadowFloorHere.r,
            presence: depthFlagsHere ? depthFlagsHere.a : null,
            slots: sunShadowSlotNodes.map((slot) => ({ sunVis: sampleSlot(slot), floorIndex01: slot.uFloorIndex01 })),
          })
        : // No floor buffer (or no injected blend fn) to gate by — fall back to
          // slot 0 alone, the pre-multi-floor behaviour.
          sampleSlot(sunShadowSlotNodes[0]);
    backgroundFloor = uBackgroundColor.mul(sunVis);
  }

  // THE GOBO IS PART OF THIS LIGHT'S OWN FALLOFF (round 10, 2026-08-04) —
  // NOT a separate pass drawn after this material MAX-blends. Three earlier
  // rounds this SAME session tried a separate pass (`aperture-gobo-
  // render.js#buildApertureShadowMaterial`, blend-toward-`backgroundFloor`
  // on the ALREADY-composited buffer, then a second MULTIPLY pass for
  // coloration) and both shared the identical, live-confirmed flaw: a live
  // screenshot with the effect toggled off showed a light's own wedge
  // crossing a building's own cast shadow with NO extra darkening —
  // ordinary MAX behaviour. With the separate pass on, the SAME wedge grew
  // a visibly darker rim, because `mix(backgroundFloor, dst, strengthed)`
  // at a blocked fragment collapses to EXACTLY `backgroundFloor`, no matter
  // how `dst` (the ALREADY-fully-composited scene) got to be bright — it
  // could have been daylight, or a completely unrelated second light, and
  // this light's own shadow would drag it down regardless. Author, in
  // response: "parts of the effect which darken should never be able to
  // survive a direct illumination from any other source. The sun would
  // remove it and point lights would also remove it... treat the effect as
  // a type of illumination but carefully mix it into the existing
  // illumination."
  //
  // The fix is exactly that: multiply the gobo term into THIS light's own
  // `combinedFalloff` BEFORE the mix below, so the material's SINGLE
  // MAX-blend draw already reflects the pattern — no separate pass, nothing
  // to drag the shared buffer down after the fact. At a blocked fragment
  // (goboTerm=0): `mix(backgroundFloor, finalColorExposed, 0) =
  // backgroundFloor` exactly — THIS light's own "as if I weren't here"
  // colour — which then MAX-blends against whatever the sun/other lights
  // already drew. If they were already brighter, MAX keeps THEM, unchanged
  // — the shadow is invisible there, correctly, with no extra logic. If
  // nothing else reaches that fragment (a dark room, an alley's own
  // shadow), `backgroundFloor` becomes the visible result — a real,
  // correctly-bounded shadow. This is the SAME property the
  // visibility-gate machinery (rounds 1/2/3/5/6/7/8, `aperture-gobo.js#
  // computeApertureShadowVisibility`) spent seven rounds trying to
  // approximate from OUTSIDE the MAX-blend hierarchy — MAX-blending
  // correctly gives it for free, which is why that machinery is retired
  // alongside this change (see aperture-gobo.js's own header).
  //
  // Graph-BUILD-TIME gate (`apertureCount` is a JS integer, part of the
  // material rebuild key, never a uniform — `tsl/no-uniform-gates`): a
  // light with no apertures compiles NONE of this, byte-identical to
  // before `apertureCount` existed as a param.
  let combinedFalloffGoboed = combinedFalloff;
  let uApLampHeight = null;
  let apApertures = null;
  if (apertureCount > 0) {
    const goboResult = buildApertureGoboTerm({
      THREE,
      positionWorldXY: positionWorld.xy,
      dist,
      apertureCount,
      cols: apGoboCols,
      rows: apGoboRows,
      shared: apertureGoboShared,
    });
    if (goboResult) {
      // `uStrength` — a REAL bug, found live (2026-08-04): this mix was
      // documented (`aperture-gobo-render.js#createApertureGoboSharedUniforms`'s
      // own header, "applied by the CALLER... mixes the combined node
      // toward 1 by 1-uStrength") but never actually WRITTEN — the uniform
      // was created and updated every frame by `point-light-pool.js`, and
      // simply never multiplied into anything, so "Pattern strength" did
      // nothing regardless of its own value. `mix(1, node, uStrength)`:
      // at uStrength=1 (default), `goboResult.node` passes through
      // unchanged (byte-identical to before this fix); at 0, the gobo term
      // is fully neutral (this light renders exactly as if it had no
      // aperture at all), matching the schema's own documented meaning.
      const strengthedGobo = mix(float(1), goboResult.node, apertureGoboShared.uStrength);
      combinedFalloffGoboed = combinedFalloff.mul(strengthedGobo);
      uApLampHeight = goboResult.uLampHeight;
      apApertures = goboResult.apertures;
    }
  }

  // FRAGMENT_END (illumination), audit §5c: mix(background, finalColor, depth).
  const outputColor = mix(backgroundFloor, finalColorExposed, combinedFalloffGoboed);

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(outputColor, float(1));

  return {
    material,
    uRatio,
    uAttenuationEased,
    uExposure,
    uEdgeCount,
    uEdgeSoftMargin,
    edgePoints,
    // The height gate's ONE per-light input — see this module's own "STAGE 2
    // — THE DEPTH-AUTHORITY HEIGHT GATE" section. Always present (unlike the
    // animation/wind uniforms); `point-light-pool.js`'s per-frame refresh
    // overwrites it for every light, touched or not — there is no
    // "unconfigured" case left to special-case (`scene/depth-authority.js#
    // rankOfElevation`'s own point).
    uLightExpectedDepth,
    uSpeedRaw,
    uReverseSign,
    uSeed,
    uIntensityRaw,
    uWindCenter,
    uWindExposure,
    uWindResponse,
    // This light's OWN "no contribution here" colour — `uBackgroundColor`,
    // already attenuated by per-fragment sun-shadow visibility when slots are
    // supplied (see "SUN-SHADOW ATTENUATION" above). Also `point-light-
    // coloration.js`'s own gobo term's blend target — see that module's
    // header for why coloration needs this same node, not just illum.
    backgroundFloor,
    // This light's own radial reach (0 at the dim edge, 1 at full strength),
    // UNMODULATED by the gobo pattern (that multiply happens locally, just
    // above, into `combinedFalloffGoboed` — never mutating the value
    // returned here), and its true unshadowed colour.
    combinedFalloff,
    finalColorExposed,
    // APERTURE GOBO (round 10) — `null` when this light has no apertures.
    // `point-light-pool.js` writes the real per-aperture geometry into
    // `apApertures`' own uniforms every frame, the same way it always wrote
    // `aperture-gobo-render.js#buildApertureShadowMaterial`'s return before
    // that function stopped owning the main material.
    uApLampHeight,
    apApertures,
  };
}
