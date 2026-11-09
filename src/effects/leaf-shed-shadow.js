/**
 * LEAF SHED — THE CAST SHADOW'S LAW (mmp-y9q). Pure numbers, no TSL: the runtime's shader
 * (particles/leaf-shed-runtime.js) builds the same law from these constants, and the Node
 * tests check the law itself (effects/__tests__/leaf-shed.test.mjs).
 *
 * @module effects/leaf-shed-shadow
 */

/**
 * THE CAST SHADOW'S LAW (mmp-y9q, 2026-11-09). The author, 2026-11-07: leaf and twig shadows in high
 * wind were "rectangles with darker edges and brighter centres". Cause: a leaf's shadow softens with
 * its height (`soft`, leaf units), but its quad only reached 1.15 leaf units round the shadow, so any
 * leaf more than ~16 half-lengths up (1.6 m for a 20 px leaf) had its blur cut off by the quad's own
 * edges — and the blur also INFLATED the shadow: `shedCoverage`'s smoothstep keeps the core dark while
 * the fringe grows, so a high leaf painted 1 + s²/5 times the darkness of a landed one (measured by
 * integrating it over a disk), a big grey patch instead of a faint smudge.
 *
 * Physics: a blurred shadow spreads the SAME blocked light over a wider area, so it gets fainter as it
 * widens, and far enough up it is gone (the sun's 0.53° disc gives a 10 cm leaf no umbra above ~10 m;
 * MSA's softness is ~6x the sun's, an artistic choice kept here). So:
 *   gain = (1 / (1 + s²/5)) · (1 − smoothstep(FADE_FROM, FADE_TO, s))   — energy kept, then faded out;
 *   the quad reaches QUAD_PAD + s leaf units round the shadow, so the blur always fits inside it.
 * Above FADE_TO the shadow is not drawn at all (the author's own proposal in mmp-y9q: no shadow until
 * the leaf is close to the ground), which also keeps the quad small for high leaves.
 */
export const LEAF_SHADOW = Object.freeze({
  /** Leaf units of edge softness per (px of height ÷ px of half-length). */
  SOFT_PER_HEIGHT: 0.06,
  /** A landed leaf's edge softness, leaf units. */
  SOFT_BASE: 0.04,
  /** The shadow starts to fade out at this softness... */
  FADE_FROM: 1,
  /** ...and is gone here (≈ 41 half-lengths up: 4.1 m for a 20 px leaf, more for a twig). */
  FADE_TO: 2.5,
  /** Coverage of the silhouette reaches this far from its centre at softness 0, leaf units. */
  QUAD_PAD: 1.15,
  /** The darkness a blur adds, measured: area(s) / area(0) ≈ 1 + ENERGY_K s². */
  ENERGY_K: 0.2,
});

/**
 * The cast shadow of a leaf `heightPx` above the ground with half-length `halfPx` (CPU twin of the
 * runtime's shader, which uses the same constants).
 * @param {number} heightPx @param {number} halfPx
 * @returns {{soft: number, gain: number, padLeafUnits: number}} softness and quad pad in leaf units,
 *   gain 0..1 multiplies the shadow's opacity.
 */
export function leafShadowLaw(heightPx, halfPx) {
  const L = LEAF_SHADOW;
  const s = (Math.max(heightPx, 0) * L.SOFT_PER_HEIGHT) / Math.max(halfPx, 0.5) + L.SOFT_BASE;
  const soft = Math.min(s, L.FADE_TO);
  const t = Math.min(1, Math.max(0, (s - L.FADE_FROM) / (L.FADE_TO - L.FADE_FROM)));
  const fade = 1 - t * t * (3 - 2 * t);
  const gain = fade / (1 + L.ENERGY_K * soft * soft);
  return { soft, gain, padLeafUnits: L.QUAD_PAD + soft };
}
