/**
 * WATER'S SURFACE — the TSL material tier 0 draws (`docs/planning/Water.md` §6).
 *
 * Tier 0 is `placement`: the water mask, tinted, in the right place on the
 * right floor. Not volume, not motion, not light — those are rungs 1, 2 and 3,
 * and each is a separate build. What lands here is deliberately the smallest
 * thing that is genuinely water-shaped and genuinely in the right place.
 *
 * ============================================================================
 * ⚠️ THE EDGE COMES FROM THE MASK, NOT THE SDF — CORRECTED 2026-07-26
 * ============================================================================
 * This file originally derived alpha from the body pack's signed distance
 * (`alpha = 1 − smoothstep(−soft, +soft, sdf)`), on the reasoning that an SDF
 * gives a soft edge of any width for free. That reasoning is sound and the
 * result was still wrong on screen, three fixes running, because it asks the
 * SDF for the one thing our SDF cannot supply.
 *
 * **An SDF renders crisply far below its source resolution only because it was
 * BUILT from a high-resolution source.** That is the entire Valve-SDF-text
 * result: a 64² field renders sharp glyphs at 500px because each texel stores
 * a continuous distance encoding where the edge sits BETWEEN texels. Our flood
 * is seeded from the mask authority's 512-long derivation grid — POINT-sampled,
 * so a texel is water or not with no coverage fraction — and seeds therefore
 * land on texel centres. There is no sub-texel information in the field to
 * render crisply from, and no downstream filtering, supersampling or blur can
 * invent it. Author, after the third attempt: *"extremely pixelated... the
 * shoreline looks like a square wave in places."* Correct diagnosis, wrong
 * layer, three times.
 *
 * So the two jobs are SPLIT, which is what should have happened from the start:
 *
 *   THE SILHOUETTE  → the mask file itself, at real resolution, linearly
 *                     filtered (`vt/mask-image.js`). Exactly as crisp as the
 *                     map art beside it, at any zoom, forever.
 *   DISTANCE EFFECTS → the SDF, unchanged. Depth ramp (tier 1), foam band
 *                     width and shoaling (tiers 2/4), flow tangent — all
 *                     inherently low-frequency, all genuinely fine at 512.
 *
 * The SDF was never the wrong tool; using it as the OUTLINE was. Tier 0 no
 * longer samples it at all — which is honest rather than wasteful: the body
 * pack still earns its place (it decides the cross-floor borrow, it measures
 * the water's own AABB for the Law 6 crop, and every rung from 1 up reads it),
 * it simply is not what draws the line between water and land.
 *
 * ============================================================================
 * ⚠️ THERE IS NO `buf:scene.attr` READ HERE, AND THAT IS A CORRECTION
 * ============================================================================
 * Water.md §6 and `graph/passes.js` both describe tier 0's occlusion — "the
 * punch" — as a `buf:scene.attr` read: sample the attribute buffer, kill water
 * under opaque upper geometry. Building it found that to be both unnecessary
 * and unsafe:
 *
 *   UNSAFE — water draws inside `runGeometryWorldPass`, which is the very pass
 *   that WRITES `buf:scene.attr` as MRT attachment 1 of `scene.color`. Sampling
 *   a target the same pass is writing is undefined behaviour on both backends.
 *
 *   UNNECESSARY — this renderer paints by `scene/layer-order.js`'s painter's
 *   algorithm (`depthTest: false`, `transparent: true`, ascending renderOrder).
 *   The water mesh sits just above the floor background and below everything
 *   else, so upper-floor art, bridge decks and roofs draw OVER it with their
 *   own alpha, and wherever that art is transparent — a hole, a gap between
 *   planks — the water shows through. **The draw order IS the punch**, exactly
 *   and for free, including the soft partial-alpha case §12 worried about.
 *
 * V2 needed an explicit occluder because it composited per-floor stacks and
 * had already lost the one flat sort order; MSA has that order (Foundry's own,
 * `reference_foundry_v14_layering_law`), so the mechanism dissolves rather than
 * being ported. The cross-floor BORROW still matters and still rides tier 0 —
 * it decides which floor's mask to bake, which is a different question.
 *
 * THREE is INJECTED, never imported (the bloom split's rule).
 *
 * @module effects/water/water-render
 */

/**
 * Tier 0's flat body colour. A muted blue-green with a deliberate green bias:
 * a pure blue reads as swimming-pool, and the whole point of tier 0 is that a
 * player looking at it says "water", not "a blue shape". Depth-dependent
 * absorption (deep reads deep, shallow reads sandy) is TIER 1's Beer–Lambert
 * rung and must not be faked here — a flat tint that is honestly flat is a
 * better rung 0 than a hand-tuned gradient the ladder would have to unpick.
 */
export const WATER_TIER0_TINT = Object.freeze([0.09, 0.24, 0.28]);

/** Tier 0's surface opacity. Below 1 so the riverbed art painted underneath
 * still reads through — the map's own bed is doing the work a volume rung will
 * later do properly. */
export const WATER_TIER0_OPACITY = 0.62;

/**
 * Where the mask's RED channel is thresholded into presence, and over how wide
 * a ramp — both in mask VALUE (0..1), not distance.
 *
 * ⚠️ **THE RAMP MUST BE WIDE ENOUGH TO ANTIALIAS. Narrowing it was a real bug
 * (2026-07-26).** The first version used `0 → 2/255`, reasoning that a
 * near-zero threshold preserves even the shallowest painted water. It does —
 * and it also makes the test a STEP FUNCTION: every interpolated value above
 * 2/255 reads fully opaque, so the LINEAR filter's whole contribution is
 * discarded and the edge lands hard on a texel boundary. That is jagged at any
 * resolution, which is why the shoreline still read as pixelated after the
 * mask went high-res — a second, independent cause with the same symptom.
 *
 * The mask carries DEPTH and PRESENCE in the same channel, so alpha cannot
 * simply BE the value (a shelf painted at 0.4 is fully-present water that
 * happens to be shallow, not 40%-opaque water). The ramp is the compromise:
 * anything at or above `EDGE1` is fully opaque, and the band below it is where
 * the file's own antialiased boundary gets turned into a smooth alpha
 * gradient. On a boundary ramping 0 → 0.5 across one texel, crossing this band
 * spends ~36% of that texel fading — real sub-pixel antialiasing at full
 * resolution.
 *
 * The band is in mask VALUE, not texels or world px, so it is invariant to
 * `MASK_IMAGE_SCALE`: changing the upload resolution sharpens the shoreline
 * without retuning anything here.
 *
 * Named consequence, and it is arguably correct rather than a limitation:
 * water painted shallower than `EDGE1` renders partly transparent. Very
 * shallow water genuinely IS more transparent, so tier 0 gets a free hint of
 * the Beer–Lambert behaviour tier 1 will do properly. Only a mask painted
 * almost black throughout would look wrong, and that is indistinguishable from
 * "no water painted" at 8-bit quantisation anyway.
 */
export const WATER_PRESENCE_EDGE0 = 2 / 255;
export const WATER_PRESENCE_EDGE1 = 48 / 255;

/**
 * The tier-0 surface material.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture - THE HIGH-RES MASK (`vt/mask-image.js`), R =
 *   depth-and-presence. This, not the SDF, is what draws the shoreline — see
 *   the header. A 1×1 all-zero placeholder is fine at construction: the caller
 *   keeps the mesh hidden until the real one arrives, so there is no shader
 *   gate and no fallback path.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} args.maskRect -
 *   the world rect `maskTexture` covers.
 * @param {readonly number[]} [args.tint]
 * @param {number} [args.opacity]
 * @returns {{material:*, maskTexNode:*, setMaskRect:(r:object)=>void,
 *   setTint:(rgb:readonly number[])=>void, setOpacity:(v:number)=>void}}
 */
export function buildWaterSurfaceMaterial({
  THREE,
  maskTexture,
  maskRect,
  tint = WATER_TIER0_TINT,
  opacity = WATER_TIER0_OPACITY,
}) {
  const { texture, vec2, vec3, vec4, float, uniform, positionWorld, smoothstep, clamp } = THREE.TSL;

  const uMaskRect = uniform(vec4(maskRect.minX, maskRect.minY, maskRect.maxX, maskRect.maxY));
  const uTint = uniform(vec3(tint[0], tint[1], tint[2]));
  const uOpacity = uniform(float(opacity));
  // The upper edge of the presence band is authorable (WATER_PARAMS
  // `shorelineDepth`); the lower edge is not — it is the "is anything painted
  // here at all" floor, and exposing a knob that can be raised above the upper
  // edge would let the author invert the ramp into a hard edge by accident.
  const uPresenceEdge1 = uniform(float(WATER_PRESENCE_EDGE1));

  // WORLD → mask UV. `positionWorld` (not `uv()`): the quad's own UVs would
  // only be right if the mesh exactly covered the mask rect, and it does not —
  // the mesh is cropped to the water's AABB (Law 6, bounded geometry) while the
  // mask always covers the whole level-background rect. Deriving from world
  // position makes the two independent, so the mesh can shrink to the water
  // without the sampling silently shifting.
  const spanX = uMaskRect.z.sub(uMaskRect.x);
  const spanY = uMaskRect.w.sub(uMaskRect.y);
  const maskU = positionWorld.x.sub(uMaskRect.x).div(spanX);
  const maskV = positionWorld.y.sub(uMaskRect.y).div(spanY);
  const maskTexNode = texture(maskTexture, vec2(clamp(maskU, 0, 1), clamp(maskV, 0, 1)));

  // THE SHORELINE. A narrow threshold on the LINEAR-filtered high-res mask, so
  // the crispness is the file's own and the ramp is whatever the author
  // painted — see WATER_PRESENCE_EDGE0/1 for why this is a threshold rather
  // than using the value directly.
  const inside = smoothstep(float(WATER_PRESENCE_EDGE0), uPresenceEdge1, maskTexNode.r);

  const material = new THREE.NodeMaterial();
  material.colorNode = vec4(uTint, inside.mul(uOpacity));
  material.transparent = true;
  // The painter's-algorithm contract every drawable in this renderer shares
  // (scene/layer-order.js): ascending renderOrder IS the layering, so depth
  // testing would only fight it. `depthWrite: false` for the same reason —
  // water must never occlude anything by depth, only by paint order.
  material.depthTest = false;
  material.depthWrite = false;
  // EVERY world-space quad in this renderer sets this (scene/world-quad.js's
  // own QUAD_INDICES doc): a negative scale (Foundry's horizontal-flip
  // convention) mirrors the mesh's corners and reverses the effective
  // winding, and FrontSide would cull the water quad as a backface — visible
  // in every JS-side status field (mesh.visible, the measured bounds) and
  // invisible on screen, because face culling is a GPU-side fact bookkeeping
  // cannot see. Water's own bounds come from `buildQuadPositions` the same
  // way every tile's do, so it inherits the identical risk.
  material.side = THREE.DoubleSide;

  return {
    material,
    maskTexNode,
    setMaskRect(r) {
      uMaskRect.value.set(r.minX, r.minY, r.maxX, r.maxY);
    },
    setTint(rgb) {
      uTint.value.set(rgb[0], rgb[1], rgb[2]);
    },
    setOpacity(v) {
      uOpacity.value = v;
    },
    /** WATER_PARAMS `shorelineDepth`. Clamped ABOVE the fixed lower edge: the
     * two define a band, and a band whose top sits at or below its bottom
     * turns `smoothstep` back into the step function that made the shoreline
     * jagged in the first place. The schema's own `min` already prevents this,
     * so the clamp is the belt to that braces — a live override layer or a
     * stale saved setting is not bound by the schema. */
    setShorelineDepth(v) {
      const safe = Number.isFinite(v) ? v : WATER_PRESENCE_EDGE1;
      uPresenceEdge1.value = Math.max(WATER_PRESENCE_EDGE0 * 2, safe);
    },
  };
}
