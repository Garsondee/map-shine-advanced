/**
 * CRITTER SURFACE — the three things every critter material does the same way:
 * take the scene's own lighting, respect what is above it, and set up a draw that
 * neither writes nor tests depth.
 *
 * ============================================================================
 * LIT, OCCLUDED, AND NOT A SECOND LIGHTING MODEL
 * ============================================================================
 *
 * A critter draws into `scene.lit` AFTER lighting has been composed, so left alone it
 * would be full-bright in a pitch-dark cellar. The scene's own composite finishes a
 * pixel as `lit = EOTF(OETF(albedo) × illum + coloration)` (`environmental-light.js`);
 * a critter that wants to belong to the scene does exactly that with its own albedo
 * and the same two buffers — no second lighting model, no per-critter light loop.
 * `illum` is the multiplicative light level (ambient × sun × lights) and `coloration`
 * the additive tint (the coloured part of a torch). A fly in a torch pool is warm; a
 * fly in the dark is dark.
 *
 * The gate is the depth authority's rank test (the one fire and every other post-lit
 * draw uses): a critter over a room does not draw through the roof above it.
 *
 * @module effects/critters/critter-surface
 */
import { buildDepthHeightGateNode } from '../lighting/point-light-illumination.js';

/**
 * Light a straight-sRGB albedo with the scene's illumination, returning LINEAR colour
 * for the lit target.
 *
 * @param {*} TSL
 * @param {object} a
 * @param {*} a.rgb - vec3, straight sRGB albedo.
 * @param {boolean} a.lit - the tier flag; false (or no illumination) is unlit.
 * @param {*} [a.illumTexNode] @param {*} [a.colorationTexNode] - texture nodes sampled at the screen UV.
 * @param {*} [a.influence] - float node 0..1, the author's "lit by the scene": 1 is the scene's own
 *   light on the body, 0 is the unlit albedo at full brightness. It only has anything to blend at a rung
 *   that lights the body at all (`lit`); below that every body is unlit and there is nothing to dial.
 * @returns {*} vec3 linear.
 */
export function litLinear(TSL, { rgb, lit, illumTexNode = null, colorationTexNode = null, influence = null }) {
  const { vec3, screenUV, sRGBTransferEOTF, mix } = TSL;
  if (lit && illumTexNode) {
    const illum = illumTexNode.sample(screenUV).rgb;
    const coloration = colorationTexNode ? colorationTexNode.sample(screenUV).rgb : vec3(0, 0, 0);
    const lighted = rgb.mul(illum).add(coloration);
    return sRGBTransferEOTF(influence ? mix(rgb, lighted, influence) : lighted);
  }
  return sRGBTransferEOTF(rgb);
}

/**
 * 0 where something is drawn over this pixel, 1 where it is clear.
 *
 * @param {*} TSL
 * @param {object} a
 * @param {*} [a.depthTexNode] @param {*} [a.depthFlagsTexNode]
 * @param {*} a.expectedDepth - the uniform from `resolveExpectedDepth`.
 * @returns {*} float node.
 */
export function occlusionGate(TSL, { depthTexNode = null, depthFlagsTexNode = null, expectedDepth }) {
  const { float, screenUV } = TSL;
  if (!depthTexNode) return float(1);
  return buildDepthHeightGateNode(TSL, {
    depthHere: depthTexNode.sample(screenUV),
    flagsHere: depthFlagsTexNode ? depthFlagsTexNode.sample(screenUV) : null,
    uLightExpectedDepth: expectedDepth,
  });
}

/**
 * The draw state every critter material shares. `DoubleSide` because the viewer's flipped
 * camera mirrors the winding, and a single-sided batch is then culled to nothing without
 * a warning (fire's own note); no depth test or write because the order is `renderOrder`.
 *
 * @param {*} THREE @param {object} [o]
 * @param {*} [o.blending] - `THREE.AdditiveBlending` for a glow; default normal.
 * @returns {*} a NodeMaterial.
 */
export function createCritterMaterial(THREE, { blending = null } = {}) {
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.toneMapped = false;
  if (blending !== null) material.blending = blending;
  return material;
}
