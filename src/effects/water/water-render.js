/**
 * WATER'S SURFACE — the TSL material tier 0 draws (`docs/planning/Water.md` §6).
 *
 * Tier 0 is `placement`: the water mask, tinted, in the right place on the
 * right floor. Not volume, not motion, not light — those are rungs 1, 2 and 3,
 * and each is a separate build. What lands here is deliberately the smallest
 * thing that is genuinely water-shaped and genuinely in the right place.
 *
 * ============================================================================
 * THE SHORELINE IS THE ONE PLACE TIER 0 SPENDS ANYTHING
 * ============================================================================
 * A hard `depth > 0` test would give a stair-stepped edge at the mask's own
 * texel resolution (~23 world px on a 12K map) — the thing that reads as
 * "programmer water" before any other quality is even in play. The body pack
 * stores a signed DISTANCE, so a soft edge of any width is one `smoothstep`
 * over a value that is already there:
 *
 *   alpha = 1 − smoothstep(−soft, +soft, sdf)
 *
 * Zero extra fetches, zero extra state, and the softness is in WORLD px so it
 * is stable under zoom. This is the first dividend of §5.1's "store distance,
 * not a blurred gradient" — V2's bake-time `shoreWidthPx` could not do it at
 * all.
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
 * Shoreline softness, WORLD px. ~1/4 of a default 100px grid square: wide
 * enough to kill the mask's texel staircase, narrow enough that the shore
 * still reads as an edge rather than a fade. World px (not texels, not
 * screen px) so it is invariant under zoom AND under a change of mask
 * resolution — the two things that would otherwise silently retune it.
 */
export const WATER_TIER0_SHORE_SOFTNESS_PX = 26;

/**
 * The tier-0 surface material.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.bodyTexture - `res:waterBody` (R signed distance world px,
 *   negative inside; G depth01; BA shore tangent).
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} args.bodyRect -
 *   the world rect `bodyTexture` covers.
 * @param {readonly number[]} [args.tint]
 * @param {number} [args.opacity]
 * @param {number} [args.shoreSoftnessPx]
 * @returns {{material:*, bodyTexNode:*, setBodyRect:(r:object)=>void,
 *   setTint:(rgb:readonly number[])=>void, setOpacity:(v:number)=>void,
 *   setShoreSoftnessPx:(v:number)=>void}}
 */
export function buildWaterSurfaceMaterial({
  THREE,
  bodyTexture,
  bodyRect,
  tint = WATER_TIER0_TINT,
  opacity = WATER_TIER0_OPACITY,
  shoreSoftnessPx = WATER_TIER0_SHORE_SOFTNESS_PX,
}) {
  const { texture, vec2, vec3, vec4, float, uniform, positionWorld, smoothstep, clamp } = THREE.TSL;

  const uBodyRect = uniform(vec4(bodyRect.minX, bodyRect.minY, bodyRect.maxX, bodyRect.maxY));
  const uTint = uniform(vec3(tint[0], tint[1], tint[2]));
  const uOpacity = uniform(float(opacity));
  const uShoreSoftnessPx = uniform(float(shoreSoftnessPx));

  // WORLD → body UV. `positionWorld` (not `uv()`): the quad's own UVs would
  // only be right if the mesh exactly covered the body rect, and it does not —
  // the mesh is cropped to the water's AABB (Law 6, bounded geometry) while the
  // body pack always covers the whole mask rect. Deriving from world position
  // makes the two independent, so the mesh can shrink to the water without the
  // sampling silently shifting.
  const rectMinX = uBodyRect.x;
  const rectMinY = uBodyRect.y;
  const spanX = uBodyRect.z.sub(uBodyRect.x);
  const spanY = uBodyRect.w.sub(uBodyRect.y);
  const bodyU = positionWorld.x.sub(rectMinX).div(spanX);
  const bodyV = positionWorld.y.sub(rectMinY).div(spanY);
  const bodyTexNode = texture(bodyTexture, vec2(clamp(bodyU, 0, 1), clamp(bodyV, 0, 1)));

  // R is the signed distance to shore in world px, negative INSIDE the water.
  // One smoothstep turns it into a soft, zoom-stable shoreline (see header).
  const sdf = bodyTexNode.r;
  const soft = uShoreSoftnessPx;
  const inside = float(1).sub(smoothstep(soft.negate(), soft, sdf));

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
    bodyTexNode,
    setBodyRect(r) {
      uBodyRect.value.set(r.minX, r.minY, r.maxX, r.maxY);
    },
    setTint(rgb) {
      uTint.value.set(rgb[0], rgb[1], rgb[2]);
    },
    setOpacity(v) {
      uOpacity.value = v;
    },
    setShoreSoftnessPx(v) {
      uShoreSoftnessPx.value = v;
    },
  };
}
