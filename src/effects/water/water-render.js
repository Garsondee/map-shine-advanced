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
 * ⚠️ WATER IS TWO BLENDS, NOT ONE — CORRECTED 2026-07-26
 * ============================================================================
 * Tier 1 first shipped as ONE alpha-blended draw, on the reasoning (spelled out
 * at length under WATER_TIER1_ABSORPTION, and still true as far as it goes) that
 * `src·a + dst·(1−a)` IS Beer–Lambert when `a = 1 − exp(−σd)`. Author's verdict:
 * *"Water looks like paint or mist not water, blending mode makes it look like
 * colour added on top of the background."* Correct, and the maths says why.
 *
 * With a SCALAR alpha, `lerp(bed, tint, a)` moves every channel of the bed the
 * same fraction toward one flat colour. That is what a wash of paint does. Real
 * water does two physically DIFFERENT things at once:
 *
 *   ABSORPTION — the bed is seen THROUGH a coloured medium, so it is
 *                MULTIPLIED, per channel, by `exp(−σ_rgb·d)`. Multiplication
 *                darkens and re-hues while PRESERVING the bed's own contrast;
 *                that preserved detail is the entire visual difference between
 *                "riverbed under water" and "riverbed under a blue film".
 *                σ is per-channel because it must be: water absorbs red first,
 *                and that is *why* deep water goes blue-green rather than
 *                merely dark. A single alpha cannot express a per-channel
 *                destination attenuation — which is exactly the deferral this
 *                file recorded a rung ago, now cashed in as the actual cause.
 *   IN-SCATTER — light bounced back out of the volume before it ever reached
 *                the bed. This one genuinely IS added on top, and it is what
 *                makes deep water read as the author's colour rather than as
 *                black.
 *
 * So the surface draws TWICE, with the blend each term actually needs:
 *
 *   MESH 1  multiply   dst · exp(−σ_rgb·d)         CustomBlending Zero/SrcColor
 *   MESH 2  add        + tint · (1 − mean T)       CustomBlending One/One
 *
 * Two bounded draws over the water's AABB, no dependent read, no extra target.
 * The sum is the volume-rendering equation `bed·T + W·(1−T)`, which at `d → 0`
 * leaves the bed untouched and at `d → ∞` converges on the author's colour.
 *
 * ⚠️ **THE WET BAND BELONGS TO THE MULTIPLY, AND ONLY THE MULTIPLY.** It first
 * shipped as `uTint` at low alpha, on the theory that wet sand takes the colour
 * of what soaked it. Author: *"Wet margin isn't darker, it's blue so it looks
 * like paint."* Damp ground is not tinted, it is DARKER — a water film cuts
 * diffuse back-scatter, which is a neutral multiply, and the saturation that
 * comes with wetness falls out of that multiply on its own. It therefore rides
 * mesh 1 with no colour of its own and contributes NOTHING to mesh 2.
 *
 * ⚠️ **THE MULTIPLY PASS MUST OVERRIDE ITS `attr` MRT OUTPUT TO WHITE.**
 * `vt/scene-attr.js`'s renderer-global default writes `attr = vec4(0)`, which
 * is the do-not-touch value *for NormalBlending* — its own header derives it as
 * `dst·(1−0) + 0·0 = dst`. Blend state is not per-attachment on WebGL2, so the
 * multiply pass applies `dst · src` to attachment 1 as well, and `attr · 0`
 * would silently ZERO the floor attributes under every water pixel. The neutral
 * element of a blend is a property of the BLEND, not a constant: white for a
 * multiply, black for an add. Mesh 1 overrides to `vec4(1)`; mesh 2's add is
 * already neutral at the global default, and says so explicitly anyway.
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
 * TIER 1 — ABSORPTION. How fast light is lost with depth (Beer–Lambert's σ,
 * in units of "per unit of mask depth", since the mask's 0..1 R IS the depth
 * axis).
 *
 * This is the MEAN of a per-channel σ, not σ itself. The header explains why
 * the channels must differ; this constant sets how strong the absorption is
 * overall, and the tint sets how it is split between them:
 *
 *     σ_rgb = absorption · (1 − tint) / mean(1 − tint)
 *
 * Dividing by the mean is what keeps the two controls ORTHOGONAL, and that is
 * worth stating because the obvious formulation (`σ = absorption · (1 − tint)`)
 * is not: there, picking a darker water colour would silently also make the
 * water murkier, and the author would be fighting two effects with one slider.
 * Normalised, the tint decides only the HUE of the absorption and this decides
 * only its DEPTH, which is how the panel already describes them.
 *
 * The direction is the physical one and falls out for free: `1 − tint` means a
 * blue-green water colour absorbs RED hardest, so a sandy bed loses its warmth
 * first and shifts toward the water's own hue as it deepens. That hue shift is
 * the thing a scalar alpha could never produce, and it is most of what makes
 * the result read as depth rather than as coverage.
 *
 * 3.0 default: at the mask's full depth (1.0) mean transmittance is exp(−3)
 * ≈ 5%, so deep water is nearly opaque and dominated by in-scatter; at 0.2
 * depth it is ≈55%, so shallows still read as riverbed. Those numbers are
 * unchanged from the single-blend version on purpose — the rung's response
 * curve was never the problem, only how it was composited.
 */
export const WATER_TIER1_ABSORPTION = 3.0;

/**
 * TIER 1 — HOW FAR FROM THE BANK THE WATER REACHES FULL DEPTH, world px.
 *
 * ⚠️ **THIS IS THE CONTROL THAT MAKES WATER STOP LOOKING LIKE PAINT, AND ITS
 * ABSENCE — NOT THE BLEND — IS WHY IT DID (2026-07-26).**
 *
 * Tier 1 first derived depth from the mask's R channel alone, which is what
 * `water-body.js` still packs into the body pack's G. That is correct *if the
 * mask authors a depth gradient*. Real `_Water` masks are SILHOUETTES — you
 * paint where water is, not how deep it is — so R is ~1 across the entire
 * river, `exp(−σd)` is therefore a CONSTANT, and a constant absorption over a
 * constant depth is a flat wash of colour. That is paint, and no choice of
 * blend equation can rescue it: there is simply no variation in the input.
 * Author, twice, correctly: *"Water looks like paint."*
 *
 * `Water.md` §2a specified the answer from the start — "G — depth01. Authored
 * where painted (mask channel), **else derived from `|SDF|`**" — and only the
 * first half was ever built. This is the second half. Inside the water the body
 * pack's signed distance IS distance-from-the-bank, so depth ramps 0 at the
 * shoreline to 1 this far in, and the river gets the shape it always had:
 * clear sandy shallows at the edges, deep colour in the channel.
 *
 * The two sources MULTIPLY (`maskR · ramp`) rather than one winning, which
 * makes the degenerate cases fall out right with no mode flag: a flat white
 * silhouette yields the pure geometric ramp, a painted gradient modulates it
 * proportionally, and both agree on zero at the bank.
 *
 * This is exactly the work a coarse distance field is good at (low-frequency,
 * far below the mask's own resolution) and is the same division of labour
 * correction #1 established: SILHOUETTE from the mask file, DISTANCE from the
 * SDF. 256 px default suits a river a few hundred px wide; a wide lake wants
 * more, a stream less.
 */
export const WATER_TIER1_DEPTH_SCALE_PX = 256;

/**
 * TIER 1 — THE WET BAND, world px. How far past the shoreline the ground reads
 * as damp.
 *
 * **This is the first thing the body pack visibly does.** Every earlier use of
 * the SDF was either internal or (in tier 0's case) actively wrong. Here it is
 * exactly right: the field is SIGNED, so the ground OUTSIDE the water is just
 * the positive side of a value already fetched — a band of any width, for
 * free, with no second mask, no dilation pass, and no authoring. V2 had no wet
 * ground at all; `Water.md` §5.1 calls this out as one of the four systems the
 * one signed field replaces.
 *
 * Low-frequency by nature, which is precisely the work a coarse distance field
 * is good at — the same reasoning that says the SDF must NOT draw the edge
 * says it SHOULD draw this.
 */
export const WATER_TIER1_WET_BAND_PX = 34;

/** TIER 1 — how dark the wet band goes at the waterline, 0..1. A NEUTRAL
 * multiply (`dst · (1 − wet)`), never a tint — see the header. Subtle on
 * purpose: damp sand is a shade darker, not a painted outline. */
export const WATER_TIER1_WET_STRENGTH = 0.35;

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
 * @returns {{absorbMaterial:*, inscatterMaterial:*, maskTexNode:*, bodyTexNode:*,
 *   setMaskRect:(r:object)=>void, setTint:(rgb:readonly number[])=>void,
 *   setOpacity:(v:number)=>void}} TWO materials, for two meshes over the same
 *   geometry — see the header. The caller draws `absorbMaterial` first.
 */
export function buildWaterSurfaceMaterial({
  THREE,
  maskTexture,
  maskRect,
  bodyTexture,
  bodyRect,
  tint = WATER_TIER0_TINT,
  opacity = WATER_TIER0_OPACITY,
  absorption = WATER_TIER1_ABSORPTION,
  depthScalePx = WATER_TIER1_DEPTH_SCALE_PX,
  wetBandPx = WATER_TIER1_WET_BAND_PX,
  wetStrength = WATER_TIER1_WET_STRENGTH,
}) {
  const { texture, vec2, vec3, vec4, float, uniform, positionWorld, smoothstep, clamp, exp, log, max, dot, mrt } =
    THREE.TSL;

  const uMaskRect = uniform(vec4(maskRect.minX, maskRect.minY, maskRect.maxX, maskRect.maxY));
  const uBodyRect = uniform(vec4(bodyRect.minX, bodyRect.minY, bodyRect.maxX, bodyRect.maxY));
  const uTint = uniform(vec3(tint[0], tint[1], tint[2]));
  const uOpacity = uniform(float(opacity));
  const uAbsorption = uniform(float(absorption));
  const uDepthScalePx = uniform(float(depthScalePx));
  const uWetBandPx = uniform(float(wetBandPx));
  const uWetStrength = uniform(float(wetStrength));
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

  // WORLD → body-pack UV, and the ONE fetch of it. The body pack's R is the
  // SIGNED distance to shore in world px — negative INSIDE the water, positive
  // outside — and tier 1 reads both signs: the inside for the depth ramp (1a)
  // and the outside for the wet band (1b). Sampled once, above both, because
  // they are two readings of one value and a second fetch would be pure cost.
  const bodyU = positionWorld.x.sub(uBodyRect.x).div(uBodyRect.z.sub(uBodyRect.x));
  const bodyV = positionWorld.y.sub(uBodyRect.y).div(uBodyRect.w.sub(uBodyRect.y));
  // The NODE is kept, not just its `.r` — the caller re-points `.value` when a
  // regrid recreates the target, and a swizzle cannot be re-pointed.
  const bodyTexNode = texture(bodyTexture, vec2(clamp(bodyU, 0, 1), clamp(bodyV, 0, 1)));
  const sdf = bodyTexNode.r;

  // ── TIER 1a: BEER–LAMBERT, PER CHANNEL ───────────────────────────────────
  // σ_rgb = absorption · −log(tint) / mean(−log tint), i.e. THE TINT IS READ AS
  // A TRANSMITTANCE COLOUR. The first version used `1 − tint`, which is the
  // same idea and far too weak to see: on the default tint it spreads the
  // channels only ±14%, and `exp()` then flattens what little spread there was,
  // making the per-channel result numerically indistinguishable from the scalar
  // one it replaced. `−log` is the relationship Beer–Lambert actually inverts
  // and it nearly doubles the spread (red:blue 1.9× against 1.27×), which is
  // the difference between a hue shift you can see and one only the maths knows
  // about.
  //
  // Normalising by the mean keeps "how deep it reads" and "what colour it is"
  // independent controls — see WATER_TIER1_ABSORPTION. Both floors are load
  // bearing: the inner one stops `log(0)` on a pure black tint, and the outer
  // one stops a 0/0 on a pure WHITE tint, which correctly yields σ = 0 —
  // colourless water that absorbs nothing and is simply invisible.
  const absorbHue = log(max(uTint, vec3(2e-3, 2e-3, 2e-3))).negate();
  const absorbMean = max(dot(absorbHue, vec3(1 / 3, 1 / 3, 1 / 3)), float(1e-4));
  const sigma = absorbHue.div(absorbMean).mul(uAbsorption);

  // THE DEPTH AXIS — the mask's painted depth TIMES the geometric ramp away
  // from the bank. See WATER_TIER1_DEPTH_SCALE_PX: on a silhouette mask the
  // first factor is constant, and without the second the whole rung has no
  // variation to render and can only ever produce a flat wash.
  const shoreDist = max(sdf.negate(), float(0)); // sdf is negative INSIDE the water
  const depthRamp = smoothstep(float(0), max(uDepthScalePx, float(1)), shoreDist);
  // `opacity` scales the OPTICAL DEPTH, not the finished colour. That matters:
  // lerping the transmittance toward 1 (the first attempt) drags every channel
  // toward each other and destroys the hue separation the line above just
  // bought, so a half-opacity river went grey rather than pale-teal. Scaling
  // the exponent is what "less water" physically means and leaves the per-
  // channel RATIOS exactly intact at every setting.
  const depth01 = maskTexNode.r.mul(depthRamp).mul(inside).mul(uOpacity);
  // Outside the water `depth01` is 0, so this is exactly 1 — the identity of
  // the multiply blend. The pass provably cannot darken dry land.
  const bedTransmit = exp(sigma.negate().mul(depth01));
  // IN-SCATTER. Keyed off the transmittance BEFORE the wet band touches it, so
  // damp ground (which has no volume above it) can never in-scatter: that is
  // the precise line where the blue-margin bug lived.
  const inscatter = uTint.mul(float(1).sub(dot(bedTransmit, vec3(1 / 3, 1 / 3, 1 / 3))));

  // ── TIER 1b: THE WET BAND ────────────────────────────────────────────────
  // `1 − smoothstep(0, band, sdf)` on the POSITIVE (outside) side of the same
  // signed distance sampled above — a damp ground band of any width, from a
  // value already fetched, the dividend §5.1 promised for making the field
  // signed.
  //
  // Multiplied by `1 − inside` so it exists only OUTSIDE the water: without
  // that the band would also darken the first few px of water itself, which
  // reads as a dirty rim rather than a wet shore.
  const wetBand = float(1)
    .sub(smoothstep(float(0), max(uWetBandPx, float(1)), sdf))
    .mul(float(1).sub(inside))
    .mul(uWetStrength);

  // Shared by both meshes. Split out so the two materials cannot drift apart on
  // the settings that make them agree about WHERE they are, which is every
  // setting except the blend.
  function configureShared(material) {
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
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendEquationAlpha = THREE.AddEquation;
    // DESTINATION ALPHA IS LEFT ALONE BY BOTH PASSES. `buf:scene.color`'s alpha
    // is the level-composite coverage the floor stack is assembled with, and
    // neither "the bed is seen through water" nor "the water glows" is a
    // statement about coverage. `Zero·src + One·dst` is the identity on it.
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
  }

  // ── MESH 1: ABSORPTION ───────────────────────────────────────────────────
  // `dst · src` — the bed, multiplied per channel. The wet band rides here and
  // ONLY here, as a neutral darkening with no colour of its own.
  const absorbMaterial = new THREE.NodeMaterial();
  absorbMaterial.colorNode = vec4(bedTransmit.mul(float(1).sub(wetBand)), 1);
  configureShared(absorbMaterial);
  absorbMaterial.blendSrc = THREE.ZeroFactor;
  absorbMaterial.blendDst = THREE.SrcColorFactor;
  // WHITE, not the global zero — the multiplicative identity. See the header:
  // `attr · 0` would erase the floor attributes under every water pixel, and
  // blend state is not per-attachment on WebGL2.
  absorbMaterial.mrtNode = mrt({ attr: vec4(1, 1, 1, 1) });

  // ── MESH 2: IN-SCATTER ───────────────────────────────────────────────────
  // `src + dst`, premultiplied — the light the volume sends back. Zero outside
  // the water by construction (bedTransmit is 1 there), so it needs no gate.
  const inscatterMaterial = new THREE.NodeMaterial();
  inscatterMaterial.colorNode = vec4(inscatter, 1);
  configureShared(inscatterMaterial);
  inscatterMaterial.blendSrc = THREE.OneFactor;
  inscatterMaterial.blendDst = THREE.OneFactor;
  // Additive's identity IS the renderer-global default, so this changes
  // nothing — it is stated because the pass beside it is a counter-example to
  // "vec4(0) always means don't touch it", and the next reader needs to see
  // that this one was checked rather than left to luck.
  inscatterMaterial.mrtNode = mrt({ attr: vec4(0, 0, 0, 0) });

  return {
    absorbMaterial,
    inscatterMaterial,
    maskTexNode,
    bodyTexNode,
    setMaskRect(r) {
      uMaskRect.value.set(r.minX, r.minY, r.maxX, r.maxY);
    },
    setBodyRect(r) {
      uBodyRect.value.set(r.minX, r.minY, r.maxX, r.maxY);
    },
    setAbsorption(v) {
      uAbsorption.value = v;
    },
    setDepthScalePx(v) {
      uDepthScalePx.value = v;
    },
    setWetBandPx(v) {
      uWetBandPx.value = v;
    },
    setWetStrength(v) {
      uWetStrength.value = v;
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
