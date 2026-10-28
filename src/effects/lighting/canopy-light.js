/**
 * CANOPY LIGHT — foliage lets some light through (2026-10-28).
 *
 * The author: *"Trees and bushes are meant to be slightly translucent but currently if a light is
 * below them they occlude 100% of the light. Could you make it so that bushes only occlude 50% and
 * trees occlude 75% … Ideally you would link the layer elevation to the distance that the light
 * would have to reach to create a gradient based on height too."*
 *
 * The point-light depth gate (`point-light-illumination.js#buildDepthHeightGateNode`) is a hard 0/1
 * rank test: anything drawn above the light blocks it. A canopy is drawn above the ground's lights,
 * so it read as solid as a roof. This term softens that for canopies only, and only for point
 * lights (illumination + coloration, single and batched): the depth pass tags each canopy's pixels
 * (`vt/scene-depth.js#computeVegetationDepthFlags`), and here a tagged pixel above the light gets
 *
 *   - a TRANSMISSION instead of 0 — `1 - block`, block being the Vegetation card's tree/bush dial;
 *   - a LIFTED distance — the light reaches a canopy `h` above the ground through
 *     `sqrt(d² + h²)`, not `d`, so the canopy's lit patch is smaller and dimmer than the ground's and
 *     a tall tree fades out sooner than a low bush. `h` is the kind's own height dial
 *     (`treeHeightFt`/`bushHeightFt`) × the scene's px per unit × the "light height falloff" dial.
 *
 * Fireflies, flames, particles and window light keep the hard gate: none of them reads these bits.
 *
 * The light's radius in px (to bring `h` into the light's own unit-radius space) comes from screen
 * derivatives — world px per screen px over local units per screen px — because a batched light
 * mesh has no per-light scale uniform to read. Both sides are linear across a light's triangles, so
 * the ratio is exactly the radius for an ordinary (uniformly scaled) light.
 *
 * @module effects/lighting/canopy-light
 */

/**
 * MIRRORS `vt/scene-depth.js#DEPTH_FLAG_IS_VEGETATION`/`DEPTH_FLAG_IS_TREE` — a duplicate rather
 * than an import for the same `vt/`→`effects/` layering reason as
 * `point-light-illumination.js#DEPTH_FLAG_RESTRICTS_LIGHT_MIRROR`. Pinned in the tests.
 */
export const CANOPY_FLAG_IS_VEGETATION_MIRROR = 128;
export const CANOPY_FLAG_IS_TREE_MIRROR = 32;

/** The values the shader reads, kept here so a material built before the first push starts right. */
const state = {
  treeTransmit: 0.25,
  bushTransmit: 0.5,
  treeLiftPx: 0,
  bushLiftPx: 0,
};

/** One uniform bundle per TSL instance (a test's TSL and the live one never share nodes). */
const bundles = new Map();

/**
 * The shared uniforms every point-light material reads. Created once per TSL; every light shares
 * them, so a dial change is four `.value` writes a frame, never a recompile.
 *
 * @param {*} TSL - THREE.TSL.
 * @returns {{uTreeTransmit: *, uBushTransmit: *, uTreeLiftPx: *, uBushLiftPx: *}}
 */
export function getCanopyLightUniforms(TSL) {
  let b = bundles.get(TSL);
  if (!b) {
    const { uniform, float } = TSL;
    b = {
      uTreeTransmit: uniform(float(state.treeTransmit)),
      uBushTransmit: uniform(float(state.bushTransmit)),
      uTreeLiftPx: uniform(float(state.treeLiftPx)),
      uBushLiftPx: uniform(float(state.bushLiftPx)),
    };
    bundles.set(TSL, b);
  }
  return b;
}

const clamp01 = (v, fallback) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const nonNeg = (v, fallback) => (Number.isFinite(v) ? Math.max(0, v) : fallback);

/**
 * Resolve the Vegetation card's dials into what the shader reads. Pure — the CPU half of
 * {@link pushCanopyLightUniforms}, tested on its own.
 *
 * @param {object} args
 * @param {number} [args.treeBlock=0.75] - share of a light a tree blocks (0..1).
 * @param {number} [args.bushBlock=0.5] - share of a light a bush blocks (0..1).
 * @param {number} [args.treeHeightFt=0] @param {number} [args.bushHeightFt=0] - the kinds' heights,
 *   in scene units.
 * @param {number} [args.heightReach=1] - multiplies both heights; 0 = no height falloff.
 * @param {number} [args.pxPerUnit=0] - world px per scene unit (grid size / grid distance).
 * @returns {{treeTransmit: number, bushTransmit: number, treeLiftPx: number, bushLiftPx: number}}
 */
export function resolveCanopyLight({
  treeBlock = 0.75,
  bushBlock = 0.5,
  treeHeightFt = 0,
  bushHeightFt = 0,
  heightReach = 1,
  pxPerUnit = 0,
} = {}) {
  const scale = nonNeg(heightReach, 1) * nonNeg(pxPerUnit, 0);
  return {
    treeTransmit: 1 - clamp01(treeBlock, 0.75),
    bushTransmit: 1 - clamp01(bushBlock, 0.5),
    treeLiftPx: nonNeg(treeHeightFt, 0) * scale,
    bushLiftPx: nonNeg(bushHeightFt, 0) * scale,
  };
}

/**
 * Push this frame's dials into every uniform bundle (and remember them for bundles not built yet).
 *
 * @param {Parameters<typeof resolveCanopyLight>[0]} args
 */
export function pushCanopyLightUniforms(args) {
  Object.assign(state, resolveCanopyLight(args));
  for (const b of bundles.values()) {
    b.uTreeTransmit.value = state.treeTransmit;
    b.uBushTransmit.value = state.bushTransmit;
    b.uTreeLiftPx.value = state.treeLiftPx;
    b.uBushLiftPx.value = state.bushLiftPx;
  }
}

/**
 * THE CPU TWIN of {@link buildCanopyLightTerm}.
 *
 * @param {object} args
 * @param {boolean} args.occluded - the depth gate's own verdict (the surface ranks above the light).
 * @param {number} args.flagsByte - the `buf:scene.depth` B byte, 0-255.
 * @param {number} args.dist - distance from the light in its own unit-radius space.
 * @param {number} args.radiusPx - the light's radius in world px.
 * @param {ReturnType<typeof resolveCanopyLight>} args.resolved
 * @returns {{under: boolean, transmit: number, liftedDist: number}} `transmit` is 0 when this is
 *   not a canopy above the light (the hard gate's answer then stands).
 */
export function computeCanopyLight({ occluded, flagsByte, dist, radiusPx, resolved }) {
  const isVeg = Math.floor(flagsByte / CANOPY_FLAG_IS_VEGETATION_MIRROR) % 2 === 1;
  const isTree = Math.floor(flagsByte / CANOPY_FLAG_IS_TREE_MIRROR) % 2 === 1;
  const under = isVeg && !!occluded;
  if (!under) return { under, transmit: 0, liftedDist: dist };
  const liftPx = isTree ? resolved.treeLiftPx : resolved.bushLiftPx;
  const lift = liftPx / Math.max(radiusPx, 1);
  return {
    under,
    transmit: isTree ? resolved.treeTransmit : resolved.bushTransmit,
    liftedDist: Math.hypot(dist, lift),
  };
}

/**
 * The canopy term as TSL. Feed `liftedDist` (or `localUnitXY × liftScale`, for the beam) to the
 * falloff in place of `dist`, and `max()` the depth gate with `transmit`.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {object} args
 * @param {*} args.depthHere - this fragment's `buf:scene.depth` depth sample.
 * @param {*} args.flagsHere - this fragment's `buf:scene.depth` colour sample (B = flags byte).
 * @param {*} args.expectedDepth - the light's `uLightExpectedDepth`.
 * @param {*} args.localUnitXY - the light-local unit-radius position.
 * @param {*} args.dist - `length(localUnitXY)`.
 * @returns {{under: *, transmit: *, liftedDist: *, liftScale: *}} `under` is 1 on a canopy pixel
 *   above the light, else 0; `transmit` is already multiplied by it.
 */
export function buildCanopyLightTerm(TSL, { depthHere, flagsHere, expectedDepth, localUnitXY, dist }) {
  const { float, floor, mod, select, mix, length, vec2, dFdx, dFdy, positionWorld, max } = TSL;
  const u = getCanopyLightUniforms(TSL);
  const flagsByte = floor(flagsHere.b.mul(float(255)).add(float(0.5)));
  const isVeg = mod(floor(flagsByte.div(float(CANOPY_FLAG_IS_VEGETATION_MIRROR))), float(2));
  const isTree = mod(floor(flagsByte.div(float(CANOPY_FLAG_IS_TREE_MIRROR))), float(2));
  const occluded = select(depthHere.lessThan(expectedDepth), float(1), float(0));
  const under = isVeg.mul(occluded);
  const transmit = mix(u.uBushTransmit, u.uTreeTransmit, isTree).mul(under);
  const liftPx = mix(u.uBushLiftPx, u.uTreeLiftPx, isTree);
  // World px per local unit = the light's radius in px (see this module's header).
  const worldStep = length(dFdx(positionWorld.xy)).add(length(dFdy(positionWorld.xy)));
  const localStep = length(dFdx(localUnitXY)).add(length(dFdy(localUnitXY)));
  const radiusPx = worldStep.div(max(localStep, float(1e-6)));
  const lift = liftPx.div(max(radiusPx, float(1))).mul(under);
  const liftedDist = length(vec2(dist, lift));
  const liftScale = liftedDist.div(max(dist, float(1e-4)));
  return { under, transmit, liftedDist, liftScale };
}
