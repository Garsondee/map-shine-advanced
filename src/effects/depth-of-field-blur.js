/**
 * DEPTH OF FIELD — the floor-distance-to-blur maths, pure and Node-testable.
 * Plan of record: `docs/planning/Depth-of-Field.md`.
 *
 * Three small, total functions, mirroring the granularity
 * `effects/lighting/layer-smear.js` uses for its own throw/falloff maths:
 * each answers exactly one question, each is safe on degenerate input (a
 * missing/negative/NaN value clamps to something sane rather than
 * propagating into a shader uniform), and each has its own test.
 *
 * ⚠️ THIS IS THE REFERENCE FORMULA, NOT THE SHADER. `depth-of-field-
 * render.js`'s TSL `Fn()` body is a SEPARATE, manually-synced
 * reimplementation of the same arithmetic — Node cannot execute a TSL graph,
 * so there is no way to share the literal code, only the shape (the same
 * gap `layer-smear-render.js` has from `layer-smear.js`, named in that
 * file's own header). Keep the two in step by hand; the TSL side comments
 * which function here it mirrors.
 *
 * ⚠️ NOT JS-REACHABLE FROM `boot.js`, ON PURPOSE — recorded, not silent.
 * These three functions describe a per-PIXEL formula; nothing on the CPU
 * ever has a reason to call them at runtime (the GPU shader is the only real
 * consumer, and it cannot `import` this file). `graph/reachable-from-boot`'s
 * ratchet bound was deliberately moved 1→2 (`tools/structure-ratchets.json`)
 * to admit exactly this file, the same way `layer-smear.js` earns its OWN
 * reachability only through `layerSmearTierPlan` (a genuinely different,
 * CPU-side function) while its own per-sample maths (`layerThrowPx`,
 * `smearFalloff01`) share this file's same "referenced only by its shader
 * mirror and its test" shape. Node-tested (`__tests__/depth-of-field-
 * blur.test.mjs`) and cited by name in `depth-of-field-render.js`'s TSL
 * comments — used, just not imported.
 *
 * @module effects/depth-of-field-blur
 */

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);

/**
 * How many floors below the CURRENTLY VIEWED floor this pixel's own content
 * sits on. Zero at or above the viewed floor, and zero wherever
 * `buf:scene.depth`'s colour payload carries no real write at all (see the
 * `present` param) — an unrendered/void pixel must never read as "far
 * below", which is exactly the ambiguity `scene-attr.js` names for its own
 * sibling buffer (its clear value and a genuine "floor 0" write share R=0).
 *
 * `buf:scene.depth`'s R channel is written behind a hard alpha-test +
 * depth-test discard, never blended (`scene-depth.js#buildSceneDepthWriterMaterial`)
 * — every REAL write is exactly one floor's own index, so there is no
 * fractional/averaged value to guard against here, unlike `buf:scene.attr`'s
 * NormalBlending-written floor channel.
 *
 * @param {object} args
 * @param {number} args.floorIndexHere - 0-255, `buf:scene.depth`'s R channel
 *   already decoded from its 0..1 texture read (`round(sample.r * 255)`).
 * @param {number} args.viewedFloorIndex - `view.floorIndex`, the floor
 *   currently being viewed.
 * @param {boolean} [args.present=true] - `buf:scene.depth`'s A channel > 0.5.
 * @returns {number} an integer >= 0.
 */
export function computeDofFloorsBelow({ floorIndexHere, viewedFloorIndex, present = true }) {
  if (present === false) return 0;
  const here = Number.isFinite(floorIndexHere) ? Math.round(floorIndexHere) : 0;
  const viewed = Number.isFinite(viewedFloorIndex) ? Math.round(viewedFloorIndex) : 0;
  return Math.max(0, viewed - here);
}

/**
 * Map a floor distance into a fractional LOD across the blur mip chain, and
 * the two integer mip levels that fractional LOD sits between (for a
 * `mix(sampleMip(lod0), sampleMip(lod1), frac)` read).
 *
 * `strength` lives HERE, not in {@link computeDofAlpha} — it is a multiplier
 * on the blur RADIUS itself (how far the LOD ramp climbs), not on how much
 * the blurred result is cross-faded with the sharp source. That distinction
 * is why `strength=0.5` reads as "half as blurred," not as "a 50/50 ghost of
 * the sharp and blurred image" — the composite always fully replaces a
 * below-floor pixel (see `computeDofAlpha`); `strength` only decides how
 * blurry the thing that replaces it is.
 *
 * @param {object} args
 * @param {number} args.floorsBelow - {@link computeDofFloorsBelow}'s result.
 * @param {number} args.strength - 0..1, the `strength` param — scales the
 *   blur radius reached at a given distance. 0 = pixels below the viewed
 *   floor sample mip0 (the least-blurred level, effectively no extra blur);
 *   1 = the full ramp authored by `blurPerFloor`/`maxBlur`. Non-finite
 *   degrades to 1 (a broken param must read as "full effect," never a
 *   silent off).
 * @param {number} args.blurPerFloor - LOD added per floor of distance (the
 *   `blurPerFloor` param, `depth-of-field.js`).
 * @param {number} args.maxBlur - 0..1, caps the reachable LOD as a fraction
 *   of the mip range (the `maxBlur` param).
 * @param {number} args.mipCount - how many blurred mip levels exist (>= 1).
 * @returns {{lod: number, lod0: number, lod1: number, frac: number}}
 *   `lod0`/`lod1` are both valid mip indices (`0..mipCount-1`); `frac` is
 *   how far between them to mix, 0..1. A single-mip chain (`mipCount<=1`)
 *   is total and returns the one level with `frac=0`.
 */
export function computeDofMipSample({ floorsBelow, strength, blurPerFloor, maxBlur, mipCount }) {
  const count = Number.isFinite(mipCount) && mipCount >= 1 ? Math.floor(mipCount) : 1;
  const topLod = count - 1;
  if (topLod <= 0) return { lod: 0, lod0: 0, lod1: 0, frac: 0 };

  const below = Number.isFinite(floorsBelow) && floorsBelow > 0 ? floorsBelow : 0;
  const perFloor = Number.isFinite(blurPerFloor) && blurPerFloor > 0 ? blurPerFloor : 0;
  const s = clamp01(strength);
  const cap = clamp01(maxBlur);

  const lod = Math.max(0, Math.min(topLod * cap, below * perFloor * s));
  const lod0 = Math.floor(lod);
  const lod1 = Math.min(topLod, lod0 + 1);
  return { lod, lod0, lod1, frac: lod - lod0 };
}

/**
 * The composite's output alpha under `NormalBlending` — exactly 0 (leaving
 * the destination untouched by the blend equation, `dst·(1−0)+src·0=dst`) at
 * or above the viewed floor, exactly 1 (a full replace, never a cross-fade)
 * anywhere strictly below it.
 *
 * A HARD cut, not a distance-based ramp: the floor-index boundary is already
 * a real spatial edge (a wall, a railing, the rim of a hole), sampled at
 * NEAREST full-screen resolution, so there is no gradual spatial transition
 * to feather in the first place — see `docs/planning/Depth-of-Field.md` §3.
 * The blur RADIUS itself (via {@link computeDofMipSample}) is what grows
 * smoothly with distance; this only decides whether the blurred sample
 * applies at all.
 *
 * `strength` deliberately does NOT appear here as a blend factor. It used to
 * scale this alpha directly — which meant a below-floor pixel became a
 * linear cross-fade of the sharp source and the fully-blurred mip, i.e. a
 * visible double-image/ghosting artifact at any strength short of 1, not
 * "less blur." `strength` now scales the blur RADIUS instead
 * ({@link computeDofMipSample}), so a below-floor pixel is always fully
 * replaced by ONE coherent sample — just a less-blurred one at lower
 * strength.
 *
 * `lod` DOES gate this, though — not as a ramp, but as an all-or-nothing
 * check. `mipTexNodes[0]` (`lod===0`) is NOT a sharp source; it is already a
 * half-res, 13-tap-softened downsample (`depth-of-field-render.js`'s
 * pyramid), so replacing a pixel with it is never truly "no blur," only
 * "the least blur this pyramid can produce." Any one of `strength`,
 * `blurPerFloor`, or `maxBlur` sitting at exactly 0 drives `lod` to exactly
 * 0 ({@link computeDofMipSample}) — that must disable the replace entirely
 * (alpha 0, sharp source shows through untouched), or "all sliders at zero"
 * would still visibly blur. `lod>0` is still a hard boolean gate, not a
 * ramp — it never reintroduces the cross-fade `strength` used to cause.
 *
 * @param {object} args
 * @param {number} args.floorsBelow
 * @param {number} args.lod - {@link computeDofMipSample}'s `lod`, the same
 *   value driving which mip(s) get sampled.
 * @returns {number} 0 or 1.
 */
export function computeDofAlpha({ floorsBelow, lod }) {
  return floorsBelow > 0 && lod > 0 ? 1 : 0;
}
