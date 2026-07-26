/**
 * FLUID's SURFACE — the TSL material. THREE is INJECTED, never imported.
 *
 * ============================================================================
 * THIS IS THE **ADD** HALF OF THE TWO-BLEND SPLIT, AND THAT IS DELIBERATE
 * ============================================================================
 * `Fluid.md` §5.6 (inherited from `keyhole-water-tsl-design` correction #5):
 * goo does two physically different things and one alpha cannot express both.
 * ABSORPTION tints the map art beneath it — a MULTIPLY, drawn UNDER the tile
 * albedo, preserving V2's authored "under the texture" look. EMISSION, sheen
 * and the iridescent film are an ADD, and an add belongs OVER the art, because
 * a highlight on glass is physically on top of it.
 *
 * The add half ships first because it is the half that CARRIES V2's shipped
 * look: read `Fluid.md` §3 — the author's own defaults had both colour pickers
 * on white, iridescence pinned at the top of its slider, and the HDR boost on.
 * All the colour came from an emissive rainbow. So this is not a placeholder
 * for the "real" pass; it is the pass that makes the effect look like itself.
 *
 * ⚠️ **When the multiply half lands, `feedback_blend_neutral_element_is_per_
 * blend` goes live.** Every transparent in this renderer writes `gAttr =
 * vec4(0)` to leave `buf:scene.attr` untouched — and that is the identity
 * element of NORMAL blending only. **The identity of a MULTIPLY blend is
 * WHITE.** A multiply pass emitting `vec4(0)` would silently zero the attribute
 * buffer under every tube. This add pass is safe (it is additive, whose
 * identity IS zero); the next one is not, by default.
 *
 * ============================================================================
 * WHAT IT DRAWS, AND WHERE EACH TERM COMES FROM
 * ============================================================================
 *   SILHOUETTE   the high-res mask file, thresholded — never the pack. The pack
 *                is a ~1,536-wide derived grid and `feedback_sdf_does_not_draw_
 *                the_edge` is unambiguous that a derived grid cannot supply an
 *                edge, however finely it is sampled.
 *   s, across    the pack (`fluid-pack.js`). Arc length along the tube and
 *                distance from its centreline, both baked once per mask change.
 *   CYLINDER     `√(1 − across²)` — the optical path length through a round
 *                tube seen from directly above. THE tier-1 cue: it is what
 *                stops a tube reading as a painted line, and it is pure ALU on
 *                a value the pack already carries.
 *   SLUGS        a scrolling window in `s`. This is the PRESCRIBE mode of
 *                `Fluid.md` §5.3 — the same shape V2 drew, but in a GEODESIC
 *                arc length rather than a hand-painted ramp, so the goo moves
 *                at a constant speed in WORLD px instead of at whatever speed
 *                the author's brush pressure implied.
 *   FILM         thin-film interference driven by the optical thickness, so the
 *                rainbow bands across the tube's cross-section and shifts at
 *                every slug front instead of being an unrelated fbm. V2 needed
 *                13 parameters for this; grounding it in a real thickness
 *                leaves three.
 *
 * @module effects/fluid/fluid-render
 */

/** Tier 0's tint — a cyan-green "alchemical" glow. Matches FLUID_PARAMS.tint. */
export const FLUID_TIER0_TINT = [0.15, 0.95, 0.7];

/** How hard the goo is pushed into HDR for `post.bloom` to find it. */
export const FLUID_TIER0_GLOW = 1.6;

/** Mask bytes below this are not tube; above the upper edge they fully are. The
 * narrow band between them is the antialiased edge of the AUTHORED file, which
 * is what makes the silhouette crisp at any zoom (the water shoreline's own
 * lesson, applied without re-deriving it). */
export const FLUID_PRESENCE_EDGE0 = 0.04;
export const FLUID_PRESENCE_EDGE1 = 0.18;

/** Slugs per unit arc length, i.e. how many blobs are in flight down one tube. */
export const FLUID_TIER2_SLUG_COUNT = 6;

/** Fraction of each slug period that is liquid rather than gap, 0..1. */
export const FLUID_TIER2_SLUG_WIDTH = 0.55;

/** World px per second the slugs travel. Constant in WORLD units — the whole
 * point of the geodesic arc length is that this means the same thing on a long
 * tube and a short one. */
export const FLUID_TIER2_SPEED_PX = 90;

/** Thin-film strength, 0 = flat tint. */
export const FLUID_TIER3_IRIDESCENCE = 0.8;

/**
 * Build fluid's additive surface material.
 *
 * @param {object} args
 * @param {*} args.THREE - injected.
 * @param {*} args.maskTexture - the high-res `_Fluid` file (RED, linear).
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} args.maskRect - the
 *   world rect the mask file covers.
 * @param {*} args.packTexture - `fluid-pack.js`'s RGBA pack.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} args.packRect
 * @param {*} args.timeMsNode - THE SHARED CLOCK (`core/frame-clock.js`). Never a
 *   private time node: `time/one-clock` exists because V2's water sampled eight
 *   independent ones.
 * @param {number[]} [args.tint] @param {number} [args.glow]
 * @param {number} [args.speedPx] @param {number} [args.slugCount]
 * @param {number} [args.slugWidth] @param {number} [args.iridescence]
 * @param {number} [args.opacity]
 * @returns {{material: *, uniforms: object, maskTexNode: *, packTexNode: *}}
 */
export function buildFluidSurfaceMaterial({
  THREE,
  maskTexture,
  maskRect,
  packTexture,
  packRect,
  timeMsNode,
  tint = FLUID_TIER0_TINT,
  glow = FLUID_TIER0_GLOW,
  speedPx = FLUID_TIER2_SPEED_PX,
  slugCount = FLUID_TIER2_SLUG_COUNT,
  slugWidth = FLUID_TIER2_SLUG_WIDTH,
  iridescence = FLUID_TIER3_IRIDESCENCE,
  opacity = 1,
}) {
  const {
    texture,
    vec2,
    vec3,
    vec4,
    float,
    uniform,
    positionWorld,
    smoothstep,
    clamp,
    max,
    sqrt,
    fract,
    sin,
    mix,
    mrt,
  } = THREE.TSL;

  const uMaskRect = uniform(vec4(maskRect.minX, maskRect.minY, maskRect.maxX, maskRect.maxY));
  const uPackRect = uniform(vec4(packRect.minX, packRect.minY, packRect.maxX, packRect.maxY));
  const uTint = uniform(vec3(tint[0], tint[1], tint[2]));
  const uGlow = uniform(float(glow));
  const uSpeedPx = uniform(float(speedPx));
  const uSlugCount = uniform(float(slugCount));
  const uSlugWidth = uniform(float(slugWidth));
  const uIridescence = uniform(float(iridescence));
  const uOpacity = uniform(float(opacity));

  // WORLD → UV for both textures, independently. `positionWorld`, not `uv()`:
  // the mesh is cropped to the tubes' AABB (Law 6 — cost scales with COVERED
  // pixels) while the mask and pack each cover their own rect, so quad UVs
  // would sample the wrong place the moment the crop changed.
  const maskU = positionWorld.x.sub(uMaskRect.x).div(uMaskRect.z.sub(uMaskRect.x));
  const maskV = positionWorld.y.sub(uMaskRect.y).div(uMaskRect.w.sub(uMaskRect.y));
  const maskTexNode = texture(maskTexture, vec2(clamp(maskU, 0, 1), clamp(maskV, 0, 1)));

  const packU = positionWorld.x.sub(uPackRect.x).div(uPackRect.z.sub(uPackRect.x));
  const packV = positionWorld.y.sub(uPackRect.y).div(uPackRect.w.sub(uPackRect.y));
  const packTexNode = texture(packTexture, vec2(clamp(packU, 0, 1), clamp(packV, 0, 1)));

  // THE SILHOUETTE — from the FILE, at its own resolution.
  const inside = smoothstep(float(FLUID_PRESENCE_EDGE0), float(FLUID_PRESENCE_EDGE1), maskTexNode.r).toVar();

  const s = packTexNode.r.toVar();
  const across = clamp(packTexNode.g, 0, 1).toVar();

  // ── TIER 1: THE CYLINDER ────────────────────────────────────────────────
  // Optical path length through a round tube from directly above. Maximum down
  // the centreline, zero at the glass — which is what a real capillary looks
  // like and what V2 had no way to express (everything it drew was a function
  // of arc length alone, so nothing varied ACROSS the tube).
  const thickness = sqrt(max(float(1).sub(across.mul(across)), float(0))).toVar();

  // The wall rim: a thin bright band where the glass catches light. One
  // smoothstep on a value already in a register.
  const rim = smoothstep(float(0.72), float(0.99), across).toVar();

  // ── TIER 2: SLUGS, in GEODESIC arc length ───────────────────────────────
  // `s` is metres-along-the-tube normalised to 0..1, so dividing the speed by
  // the tube's own length would be needed for true world-constant travel; the
  // pack does not carry length per texel, so this is per-tube-normalised for
  // now and named as such. Constant-in-world speed arrives with the sim, which
  // knows each tube's length (Fluid.md §5.3).
  const tSec = timeMsNode.mul(float(1 / 1000));
  const phase = fract(s.mul(uSlugCount).sub(tSec.mul(uSpeedPx).mul(float(0.01)))).toVar();
  // A soft window, not a hard edge: the leading meniscus of a slug is a curved
  // lens and reads brightest, the tail trails off.
  const head = smoothstep(float(0), float(0.12), phase);
  const tail = float(1).sub(smoothstep(uSlugWidth.sub(float(0.18)), uSlugWidth, phase));
  const slug = clamp(head.mul(tail), 0, 1).toVar();

  // The meniscus — bright right at the slug's leading face. On the RIGHT AXIS:
  // it lives where the fill CHANGES along the tube, not at the wall. V2's
  // `meniscusStrength` was a function of distance to the wall and defaulted to
  // 0 because it could never have looked right.
  const meniscus = smoothstep(float(0.1), float(0.0), phase).mul(slug).toVar();

  // ── TIER 3: THE FILM ────────────────────────────────────────────────────
  // Thin-film interference as a readout of REAL optical thickness, so the
  // rainbow bands across the cross-section and shifts at each slug front
  // instead of floating free. Three constants where V2 needed thirteen.
  const filmPhase = thickness
    .mul(float(9.0))
    .add(s.mul(float(2.0)))
    .add(tSec.mul(float(0.35)));
  const film = vec3(
    sin(filmPhase).mul(0.5).add(0.5),
    sin(filmPhase.add(float(2.1)))
      .mul(0.5)
      .add(0.5),
    sin(filmPhase.add(float(4.2)))
      .mul(0.5)
      .add(0.5)
  );
  const tinted = mix(uTint, film, uIridescence.mul(float(0.6))).toVar();

  // ── COMPOSITE ───────────────────────────────────────────────────────────
  // Body brightness: thick down the middle, plus the rim, plus the meniscus.
  // Everything is gated by `inside` (the file's silhouette) and by `slug` (is
  // there liquid here right now).
  const body = thickness
    .mul(slug)
    .mul(float(0.9))
    .add(meniscus.mul(float(0.8)))
    .add(rim.mul(slug).mul(float(0.35)));
  const radiance = tinted.mul(body).mul(uGlow).mul(inside).mul(uOpacity);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  // DoubleSide — `feedback_doubleside_invisible_to_status_reports`: a world quad
  // without it culls silently while every JS field reports healthy, and this
  // project has lost time to exactly that more than once.
  material.side = THREE.DoubleSide;
  // MRT: colour to scene.color, and vec4(0) to scene.attr. Zero IS the identity
  // element of ADDITIVE blending, so this leaves the attribute buffer untouched
  // — see the header for why the multiply half cannot copy this line.
  material.mrtNode = mrt({ output: vec4(radiance, float(1)), gAttr: vec4(0, 0, 0, 0) });

  return {
    material,
    maskTexNode,
    packTexNode,
    uniforms: {
      uMaskRect,
      uPackRect,
      uTint,
      uGlow,
      uSpeedPx,
      uSlugCount,
      uSlugWidth,
      uIridescence,
      uOpacity,
    },
  };
}
