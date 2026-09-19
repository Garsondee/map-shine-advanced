/**
 * PRISM MOTION — the pure math behind facet shading, the moving glint and
 * chromatic dispersion (mythica-machina-press#137).
 *
 * Every function here is a straight, verified transcription of V2's own real
 * arithmetic (`legacy/compositor-v2/effects/PrismEffectV2.js`, recovered from
 * git history at `c328c9bd~1`) — not a re-derivation, not a guess at what "a
 * crystal facet" should look like. `computeVoronoiFacet` in particular is a
 * line-for-line port of V2's own `voronoi()` cellular-noise function, the
 * heart of its facet pattern.
 *
 * No THREE, no `canvas`/`game` — plain numbers in, plain numbers out, so this
 * whole file is directly Node-testable (CONVENTIONS §4), the same split
 * `effects/lens-motion.js`'s own header describes: the MATHS lives here as
 * stateless functions; `prism-render.js` transcribes the IDENTICAL formulas
 * into TSL node-graph form for the GPU, and any per-frame STATE (a running
 * clock, a camera offset) stays with whichever caller owns it.
 *
 * @module effects/prism/prism-motion
 */

/** @param {number} v @returns {number} */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** @param {number} x @param {number} lo @param {number} hi @returns {number} `smoothstep(lo, hi, x)`, GLSL's own formula. */
function smoothstep(lo, hi, x) {
  if (hi <= lo) return x < lo ? 0 : 1;
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

/**
 * `fract(sin(x)*k)`-style 2D hash — V2's own `hash2()`
 * (`PrismEffectV2.js#hash2`), transcribed exactly: two independent dot
 * products through the same sine/scale trick every hash-based cellular noise
 * in this codebase uses (see `effects/lens-render.js#hash12`'s own sibling
 * for the identical family, one dimension over).
 *
 * @param {number} x @param {number} y
 * @returns {{x: number, y: number}} both components in [0, 1).
 */
export function hash2(x, y) {
  const dotA = x * 127.1 + y * 311.7;
  const dotB = x * 269.5 + y * 183.3;
  const sx = Math.sin(dotA) * 43758.5453;
  const sy = Math.sin(dotB) * 43758.5453;
  return { x: sx - Math.floor(sx), y: sy - Math.floor(sy) };
}

/**
 * ONE cell's own animated jitter offset — V2's own
 * `o = 0.5 + 0.5*sin(uTime*uFacetSpeed + 6.2831*o)` line from inside
 * `voronoi()`'s 3x3 loop, extracted so `computeVoronoiFacet` below can call it
 * once per neighbour without repeating the formula.
 *
 * @param {number} cellX @param {number} cellY - the neighbour cell's own
 *   integer grid coordinate (`n + g` in V2's own notation).
 * @param {number} timePhase - `elapsedSec * facetSpeed`, 0 when
 *   `facetAnimate` is off (a frozen pattern, not a paused clock — see
 *   `computeFacetTimePhase`).
 * @returns {{x: number, y: number}} the jittered offset, in [0, 1].
 */
export function cellJitter(cellX, cellY, timePhase) {
  const h = hash2(cellX, cellY);
  const TAU = Math.PI * 2;
  return {
    x: 0.5 + 0.5 * Math.sin(timePhase + TAU * h.x),
    y: 0.5 + 0.5 * Math.sin(timePhase + TAU * h.y),
  };
}

/**
 * THE FACET FIELD — a straight port of V2's own `voronoi(vec2 x)`
 * (`PrismEffectV2.js`): a 3x3 neighbourhood cellular search that returns the
 * squared distance to the nearest animated jitter point AND that point's own
 * offset vector, which V2 (and this port) reads as a fake per-facet surface
 * slope — cheaper than a real normal map, and the whole reason a Voronoi
 * field reads as "faceted" rather than "smoothly noisy": each cell's own
 * offset is locally constant, so neighbouring fragments inside one facet
 * share (almost) the same slope, and the slope jumps at the cell boundary —
 * exactly the discontinuity a cut gem's own facet edges have.
 *
 * @param {number} u @param {number} v - the facet-space coordinate,
 *   already scaled by `facetScale` (V2's own `noiseUv = (vUv + parallax) *
 *   uFacetScale`) — this function itself knows nothing about UV space or
 *   scale, only the coordinate it is handed.
 * @param {number} timePhase - see `cellJitter`'s own doc.
 * @returns {{distSq: number, slopeX: number, slopeY: number}} `distSq` is the
 *   squared distance to the nearest jittered point (V2's own `m.x`, unused by
 *   the shader itself but kept for parity/future glint-by-cell-size work);
 *   `slopeX`/`slopeY` are V2's own `center` — the offset FROM the fragment TO
 *   the nearest jittered point, read downstream as a fake surface slope.
 */
export function computeVoronoiFacet(u, v, timePhase) {
  const cellX = Math.floor(u);
  const cellY = Math.floor(v);
  const fracX = u - cellX;
  const fracY = v - cellY;

  let best = 8.0;
  let slopeX = 0;
  let slopeY = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const neighborX = cellX + i;
      const neighborY = cellY + j;
      const jitter = cellJitter(neighborX, neighborY, timePhase);
      const rx = i + jitter.x - fracX;
      const ry = j + jitter.y - fracY;
      const d = rx * rx + ry * ry;
      if (d < best) {
        best = d;
        slopeX = rx;
        slopeY = ry;
      }
    }
  }
  return { distSq: best, slopeX, slopeY };
}

/**
 * `facetAnimate` gates the CLOCK itself, not just the visible motion — a
 * frozen pattern (V2's own reading: an author who turns animation off wants
 * the SAME still shape every session, not a shape that happened to be
 * whatever the clock read the moment it was disabled).
 *
 * @param {number} elapsedSec - any non-negative running clock.
 * @param {number} facetSpeed
 * @param {boolean} facetAnimate
 * @returns {number} the phase to feed `computeVoronoiFacet`/`cellJitter`.
 */
export function computeFacetTimePhase(elapsedSec, facetSpeed, facetAnimate) {
  if (!facetAnimate) return 0;
  const t = Number.isFinite(elapsedSec) && elapsedSec > 0 ? elapsedSec : 0;
  const speed = Number.isFinite(facetSpeed) ? facetSpeed : 0;
  return t * speed;
}

/**
 * THE FACET UV — V2's own `noiseUv = (vUv + parallaxOffset) * uFacetScale`,
 * where `parallaxOffset = uCameraOffset * 0.0001 * uParallaxStrength`. Kept
 * as a named constant (`PRISM_PARALLAX_SCALE`) rather than an inline magic
 * number so a test can pin it against V2's own literal.
 * @type {number}
 */
export const PRISM_PARALLAX_SCALE = 0.0001;

/**
 * @param {object} args
 * @param {number} args.u @param {number} args.v - the surface's own UV, 0..1.
 * @param {number} args.facetScale
 * @param {number} args.cameraOffsetX @param {number} args.cameraOffsetY - a
 *   screen-space camera delta, px (0 with no live camera feed wired — see
 *   `prism-render.js`'s own header on what is and is not wired yet).
 * @param {number} args.parallaxStrength
 * @returns {{u: number, v: number}} facet-space coordinates, ready for
 *   `computeVoronoiFacet`.
 */
export function computeFacetUv({ u, v, facetScale, cameraOffsetX, cameraOffsetY, parallaxStrength }) {
  const scale = Number.isFinite(facetScale) && facetScale > 0 ? facetScale : 1;
  const strength = Number.isFinite(parallaxStrength) ? parallaxStrength : 0;
  const dx = (Number.isFinite(cameraOffsetX) ? cameraOffsetX : 0) * PRISM_PARALLAX_SCALE * strength;
  const dy = (Number.isFinite(cameraOffsetY) ? cameraOffsetY : 0) * PRISM_PARALLAX_SCALE * strength;
  return { u: (u + dx) * scale, v: (v + dy) * scale };
}

/**
 * THE FINAL SLOPE — V2's own `mix(facetSlope, glassSlope, facetSoftness)`:
 * blends the faceted Voronoi slope toward a smooth, low-frequency "glass"
 * fallback slope as `facetSoftness` rises, so an author can dial from a
 * sharply-cut gem (0) to featureless glass (1) with one knob.
 *
 * @param {{slopeX: number, slopeY: number}} facetSlope - `computeVoronoiFacet`'s own output.
 * @param {{slopeX: number, slopeY: number}} glassSlope - a smooth fallback (V2's own
 *   `normalize(vWorldUv*0.5 + 0.0001)` — computed by the caller, since it
 *   needs the surface's own world UV, not the facet-space one).
 * @param {number} facetSoftness - 0..1.
 * @returns {{slopeX: number, slopeY: number}}
 */
export function blendFacetSlope(facetSlope, glassSlope, facetSoftness) {
  const t = clamp01(facetSoftness);
  return {
    slopeX: facetSlope.slopeX + (glassSlope.slopeX - facetSlope.slopeX) * t,
    slopeY: facetSlope.slopeY + (glassSlope.slopeY - facetSlope.slopeY) * t,
  };
}

/**
 * THE MOVING GLINT — V2's own rotating fake light direction
 * (`vec2(sin(uTime*0.5), cos(uTime*0.3))`, two different frequencies so the
 * direction traces a slowly-precessing Lissajous path rather than a plain
 * circle) plus its own glint formula
 * (`smoothstep(uGlintThreshold, 1.0, dot(normalize(slope), normalize(lightDir)))`).
 * Kept as ONE function (rather than splitting "light direction" out) because
 * nothing else in this build consumes the direction alone — see this
 * module's own header on why a real light-direction upgrade (mirroring
 * `specular`/`window`'s own light-reactive surfaces) is a deliberately later
 * decision, not attempted here.
 *
 * @param {object} args
 * @param {number} args.slopeX @param {number} args.slopeY - the blended facet slope.
 * @param {number} args.elapsedSec
 * @param {number} args.glintThreshold
 * @returns {number} 0..1, the raw glint amount BEFORE `glintStrength` scales it.
 */
export function computeGlintAmount({ slopeX, slopeY, elapsedSec, glintThreshold }) {
  const t = Number.isFinite(elapsedSec) && elapsedSec > 0 ? elapsedSec : 0;
  const lightX = Math.sin(t * 0.5);
  const lightY = Math.cos(t * 0.3);
  const slopeLen = Math.hypot(slopeX, slopeY) || 1e-5;
  const lightLen = Math.hypot(lightX, lightY) || 1e-5;
  const dot = (slopeX / slopeLen) * (lightX / lightLen) + (slopeY / slopeLen) * (lightY / lightLen);
  return smoothstep(clamp01(glintThreshold), 1.0, dot);
}

/**
 * CHROMATIC DISPERSION OFFSETS — V2's own three-tap split
 * (`offsetR = slope*distAmt*(1+spread); offsetG = slope*distAmt;
 * offsetB = slope*distAmt*(1-spread)`, where `distAmt = intensity*0.01`):
 * red bends furthest, blue bends least, green sits at the un-split centre —
 * the same red-outward/blue-inward convention `lens-render.js#
 * sampleSceneWithCA` already uses for its own chromatic aberration, so a
 * Prism edge and a Lens-glass edge fringe the same direction.
 *
 * @param {object} args
 * @param {number} args.slopeX @param {number} args.slopeY - the blended facet slope.
 * @param {number} args.intensity
 * @param {number} args.spread
 * @returns {{r: {x:number,y:number}, g: {x:number,y:number}, b: {x:number,y:number}}}
 *   world/UV-space offsets — the caller's own `distAmt` units apply
 *   (`prism-render.js` scales these into world px before use).
 */
export function computeChromaticOffsets({ slopeX, slopeY, intensity, spread }) {
  const distAmt = (Number.isFinite(intensity) ? intensity : 0) * 0.01;
  const s = Number.isFinite(spread) ? spread : 0;
  return {
    r: { x: slopeX * distAmt * (1 + s), y: slopeY * distAmt * (1 + s) },
    g: { x: slopeX * distAmt, y: slopeY * distAmt },
    b: { x: slopeX * distAmt * (1 - s), y: slopeY * distAmt * (1 - s) },
  };
}

/** How many performance-cascade rungs this effect declares (0..3, `prism.js#PRISM.tiers`). */
export const PRISM_MAX_TIER = 3;

/**
 * `resolveEffectTier(PRISM, {profile: DEFAULT_PERFORMANCE_PROFILE})`'s own
 * fallback — unlike `lens`/`fluid`/`specular`, EVERY rung above tier 0 is
 * gated `'quality'` or higher (`prism.js#PRISM.tiers`), and the manifest
 * itself only turns on at `'extreme'` (`PRISM.enabledFromProfile`) — so the
 * one profile that can ever resolve this effect at all already affords every
 * rung. Defaulting an unspecified tier to the FULL ladder (rather than a
 * conservative tier 0/1, the other effects' own posture) is therefore the
 * historically accurate answer for THIS manifest, not a looser one.
 */
export const PRISM_DEFAULT_TIER = PRISM_MAX_TIER;

/**
 * The tier ladder, as a plan a builder can branch on — mirrors
 * `lensTierPlan`/`fluidTierPlan`/`specularTierPlan`'s own shape exactly.
 * @param {number} tier
 * @returns {{tier: number, facetsEnabled: boolean, glintEnabled: boolean, dispersionEnabled: boolean}}
 */
export function prismTierPlan(tier) {
  const t = Number.isFinite(tier) ? Math.max(0, Math.min(PRISM_MAX_TIER, Math.floor(tier))) : PRISM_DEFAULT_TIER;
  return {
    tier: t,
    facetsEnabled: t >= 1,
    glintEnabled: t >= 2,
    dispersionEnabled: t >= 3,
  };
}
