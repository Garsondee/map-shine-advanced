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
 * TIER 3 — SUN + SKY SPECULAR STAYS IN THIS PASS, AND THAT IS A DECISION
 * ============================================================================
 * The obvious move once a rung needs real lighting is to follow shine's own
 * precedent exactly: a second scene, drawn after `light.accumulate`, reading
 * `buf:scene.illum` for indoor lamp glints and `buf:scene.attr` for explicit
 * occlusion. Tier 3's own ladder text says otherwise — "No new bandwidth" —
 * and building it found that to be the right call, not a shortcut: everything
 * it needs (the sky handle's plain values, and the world-space `_Outdoors`
 * mask, a static authored texture with no pass-ordering constraint) is already
 * available at THIS pass's time. Moving out would trade water's existing free
 * occlusion (paint order — the same "the draw order IS the punch" reasoning
 * tier 0 already established) for the explicit `buf:scene.attr` gate shine
 * needs precisely because it gave that up. See `water-light.js`'s own header
 * for the physics and for why it is a separate transcription of shine's proven
 * GGX/Fresnel shape rather than an import of it.
 *
 * ============================================================================
 * ⚠️ TIER GATING IS A JS `if`, NOT A UNIFORM (Effects.md Law 4, added 2026-07-29)
 * ============================================================================
 * Every rung from 1 up used to build unconditionally — every machine, at every
 * performance profile, paid for the SDF fetch, the wet band, the surface field
 * and the full GGX/Fresnel specular lobe, regardless of what the resolved tier
 * (`effect-cascade.js#resolveEffectTier`) said it could afford. That is exactly
 * the shape Law 4 names and rejects: a feature that is "off" only in the sense
 * that its output happens not to matter still executes, still binds its
 * textures, and still shrinks nothing.
 *
 * `buildWaterSurfaceMaterial` now takes `tier` and gates each rung's EXPENSIVE
 * read with a plain JS `if` around its node construction — the body-pack
 * texture fetch (tier 1's depth ramp + wet band), `buildWaterSurfaceField`
 * (tier 2), `buildWaterSpecular` (tier 3). Below a rung's threshold the term it
 * would have produced is a literal neutral default (`float(0)`, `float(1)`,
 * `vec3(0,0,0)`) wired in instead — never computed, never sampled, never bound
 * — so the compiled shader for a `low`-profile machine is genuinely smaller,
 * not merely quieter (§7's own test: compare tier 0 and tier N shader length).
 * A tier change therefore means a NEW node graph, which means new materials:
 * the caller (`water-surface-subsystem.js`) rebuilds and disposes on a
 * resolved-tier change, mirroring candle flame's own quality-tier material
 * rebuild (`vt-pan-viewer.js#candleFlameMat`).
 *
 * TIERS 4-8 (`Water.md` §6, `WATER.deferredRungs` in `water.js`) are NOT built
 * — see the scaffold comment beside `activeTier` below for where each one's
 * `if (activeTier >= N)` block lands the day its own code does.
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

import {
  buildWaterSurfaceField,
  WATER_TIER2_WAVE_SCALE_PX,
  WATER_TIER2_FLOW_SPEED_PX,
  WATER_TIER2_FLOW_ANGLE_DEG,
  WATER_TIER2_FOAM,
  WATER_TIER3_CHOP,
} from './water-field.js';
import {
  buildWaterSpecular,
  WATER_TIER3_SUN_GLINT,
  WATER_TIER3_SKY_SHEEN,
  WATER_TIER3_GLOSSINESS,
  WATER_TIER3_VIEWER_HEIGHT,
} from './water-light.js';

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
 * ⚠️ **1.4, DOWN FROM 3.0 — AND THE OLD DEFAULT IS MOST OF WHY WATER LOOKED
 * LIKE PAINT.** At 3.0 the mean transmittance at full depth is exp(−3) ≈ 5%:
 * the riverbed is 95% GONE, so the multiply has nothing left to tint and the
 * picture is whatever in-scatter adds — a flat colour over everything. The
 * equation was right and the parameter put it in the regime where the equation
 * says "you cannot see the bottom". At 1.4 full depth transmits ≈25% and the
 * shallows 60–80%, so the bed survives everywhere and the water reads as
 * something the ground is visible THROUGH. That is the entire ask.
 *
 * Deep, opaque water is still one slider away for authors who want a lightless
 * tarn — it is just no longer the default for a shallow ford.
 */
export const WATER_TIER1_ABSORPTION = 1.4;

/**
 * TIER 1 — how much light the water sends back toward the viewer, 0..1, on top
 * of what it lets through. This is the ADDITIVE half of the composite, and the
 * one that reads as "paint" when it dominates.
 *
 * 0.3 default. Water directly below a viewer returns very little — most of what
 * you see looking straight down into a shallow river is the bed, filtered. A
 * full-strength term is a deep-ocean look applied to a ford, which is exactly
 * what shipped at 1.0 and exactly what the author kept rejecting. Raise it for
 * turbid, silty, or deliberately stylised water; drop it to 0 for water that is
 * purely a coloured filter over whatever is underneath.
 */
export const WATER_TIER1_INSCATTER = 0.3;

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
 * TIER 2 — how strongly the surface field varies optical depth, as a fraction.
 * Not a param: it is the rung's own internal strength, and the author already
 * has three controls over how the water reads at depth (`tint`, `opacity`,
 * `absorption`). 0.45 is enough to break the sheet-of-glass look without
 * reading as blotches.
 */
export const WATER_TIER2_TURBIDITY = 0.45;

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
 * THE RUNG AN UNWIRED OR ABSENT `tier` FALLS BACK TO — today's shipped look
 * (every built rung active), never the cheapest one. Matches
 * `candle-flame-geometry.js#CANDLE_DEFAULT_TIER`'s identical reasoning: a
 * caller that has not been updated to pass the resolved tier must see the
 * scene exactly as it always has, not a silent downgrade to tier 0.
 *
 * ⚠️ NOT a hardcoded imagined value — `effect-tier.test.mjs` asserts this
 * equals what `resolveEffectTier(WATER, {profile: DEFAULT_PERFORMANCE_PROFILE})`
 * actually resolves to, so retuning a rung's `fromProfile` in `water.js`
 * cannot leave this constant silently pointing at a different look
 * (`feedback_shared_field_two_meanings_two_registries`).
 */
export const WATER_DEFAULT_TIER = 3;

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
 * @param {*} [args.uViewRect] - envLight's shared view-rect uniform. Required
 *   for tier 3's synthesised eye — see `water-light.js`.
 * @param {*} [args.uOutdoorsRect] @param {*} [args.outdoorsTexNode] - envLight's
 *   outdoors rect/texture, shared the same way.
 * @param {Function} [args.buildOutdoorsGate] - injected world-space gate
 *   builder; absent compiles tier 3's reflection to a safe zero.
 * @param {number} [args.tier] - the resolved rung (effect-cascade.js#resolveEffectTier).
 *   JS-`if` gates rungs 1-3's node construction (Effects.md Law 4) — see the
 *   header's "TIER GATING" section. Absent/non-finite falls back to
 *   {@link WATER_DEFAULT_TIER}, today's shipped look, never tier 0.
 * @returns {{absorbMaterial:*, inscatterMaterial:*, maskTexNode:*, bodyTexNode:*|null,
 *   setMaskRect:(r:object)=>void, setTint:(rgb:readonly number[])=>void,
 *   setOpacity:(v:number)=>void, tier:number}} TWO materials, for two meshes over the
 *   same geometry — see the header. The caller draws `absorbMaterial` first.
 *   `bodyTexNode` is `null` below tier 1 (never sampled, so nothing to re-point
 *   on a bake regrid — callers must guard the same way `water-surface-
 *   subsystem.js#sync` does).
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
  inscatterAmount = WATER_TIER1_INSCATTER,
  waveScalePx = WATER_TIER2_WAVE_SCALE_PX,
  flowSpeedPx = WATER_TIER2_FLOW_SPEED_PX,
  flowAngleDeg = WATER_TIER2_FLOW_ANGLE_DEG,
  foam = WATER_TIER2_FOAM,
  timeMsNode = null,
  wetBandPx = WATER_TIER1_WET_BAND_PX,
  wetStrength = WATER_TIER1_WET_STRENGTH,
  // ── TIER 3 ────────────────────────────────────────────────────────────────
  uViewRect,
  uOutdoorsRect,
  outdoorsTexNode,
  buildOutdoorsGate,
  sunGlint = WATER_TIER3_SUN_GLINT,
  skySheen = WATER_TIER3_SKY_SHEEN,
  glossiness = WATER_TIER3_GLOSSINESS,
  viewerHeight = WATER_TIER3_VIEWER_HEIGHT,
  chop = WATER_TIER3_CHOP,
  tier = WATER_DEFAULT_TIER,
}) {
  // THE GATE. Clamped/coerced ONCE, here, so every `if (activeTier >= N)`
  // below reads a known-good integer regardless of what a caller passed —
  // Effects.md Law 4 is a JS `if` at graph-BUILD time, and a NaN or negative
  // tier reaching one would either throw mid-build or silently compile the
  // wrong rung. Nested ifs (not independent ones) below make the ladder's own
  // cumulative rule (Effects.md §2: a rung may not depend on one above it)
  // true BY CONSTRUCTION rather than by trusting the resolver's contract a
  // second time.
  const activeTier = Number.isFinite(tier) ? Math.max(0, Math.floor(tier)) : WATER_DEFAULT_TIER;
  const { texture, vec2, vec3, vec4, float, uniform, positionWorld, smoothstep, clamp, exp, log, max, dot, mrt } =
    THREE.TSL;

  const uMaskRect = uniform(vec4(maskRect.minX, maskRect.minY, maskRect.maxX, maskRect.maxY));
  const uBodyRect = uniform(vec4(bodyRect.minX, bodyRect.minY, bodyRect.maxX, bodyRect.maxY));
  const uTint = uniform(vec3(tint[0], tint[1], tint[2]));
  const uOpacity = uniform(float(opacity));
  const uAbsorption = uniform(float(absorption));
  const uDepthScalePx = uniform(float(depthScalePx));
  const uInscatter = uniform(float(inscatterAmount));
  const uWaveScalePx = uniform(float(waveScalePx));
  const uFlowSpeedPx = uniform(float(flowSpeedPx));
  const uFlowAngleRad = uniform(float((flowAngleDeg * Math.PI) / 180));
  const uFoam = uniform(float(foam));
  const uChop = uniform(float(chop));
  const uTurbidity = uniform(float(WATER_TIER2_TURBIDITY));
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

  // WORLD → body-pack UV, and AT MOST one fetch of it (tier 1+ only, see
  // below). The body pack's R is the SIGNED distance to shore in world px —
  // negative INSIDE the water, positive outside — and tiers 1a/1b read both
  // signs: the inside for the depth ramp (1a) and the outside for the wet band
  // (1b). Sampled once, shared by both, because they are two readings of one
  // value and a second fetch would be pure cost.
  //
  // ⚠️ BELOW TIER 1 THIS FETCH NEVER HAPPENS AT ALL (Effects.md Law 4, added
  // 2026-07-29) — `bodyTexNode` stays `null` and `depthRamp`/`wetBand` stay at
  // their NEUTRAL literals below. `depthRamp = 1` means `depth01` (below) rides
  // the mask's own authored R with no geometric shoreline taper — still a
  // genuine, correctly-placed tint, just without the extra texture read tier
  // 1's depth ramp needs. `wetBand = 0` means no damp-ground band, which is
  // honestly tier 1's own feature (water.js: "the wet-ground band OUTSIDE the
  // shoreline" is listed under tier 1's `adds`, not tier 0's).
  let bodyTexNode = null;
  let shoreDist = float(0);
  let depthRamp = float(1);
  let wetBand = float(0);

  if (activeTier >= 1) {
    const bodyU = positionWorld.x.sub(uBodyRect.x).div(uBodyRect.z.sub(uBodyRect.x));
    const bodyV = positionWorld.y.sub(uBodyRect.y).div(uBodyRect.w.sub(uBodyRect.y));
    // The NODE is kept, not just its `.r` — the caller re-points `.value` when a
    // regrid recreates the target, and a swizzle cannot be re-pointed.
    bodyTexNode = texture(bodyTexture, vec2(clamp(bodyU, 0, 1), clamp(bodyV, 0, 1)));
    // `sdf` is purely internal to this block: 1a/1b are its only two readers,
    // and both live here.
    const sdf = bodyTexNode.r;

    // ── TIER 1a: THE DEPTH AXIS — the mask's painted depth TIMES the
    // geometric ramp away from the bank. See WATER_TIER1_DEPTH_SCALE_PX: on a
    // silhouette mask the first factor is constant, and without the second
    // the whole rung has no variation to render and can only ever produce a
    // flat wash.
    shoreDist = max(sdf.negate(), float(0)); // sdf is negative INSIDE the water
    depthRamp = smoothstep(float(0), max(uDepthScalePx, float(1)), shoreDist);

    // ── TIER 1b: THE WET BAND ────────────────────────────────────────────
    // `1 − smoothstep(0, band, sdf)` on the POSITIVE (outside) side of the
    // same signed distance sampled above — a damp ground band of any width,
    // from a value already fetched, the dividend §5.1 promised for making
    // the field signed.
    //
    // Multiplied by `1 − inside` so it exists only OUTSIDE the water: without
    // that the band would also darken the first few px of water itself,
    // which reads as a dirty rim rather than a wet shore.
    wetBand = float(1)
      .sub(smoothstep(float(0), max(uWetBandPx, float(1)), sdf))
      .mul(float(1).sub(inside))
      .mul(uWetStrength);
  }

  // ── BEER–LAMBERT, PER CHANNEL — pure ALU on `uTint`/`uAbsorption` uniforms,
  // never a texture read, so σ costs the same at every tier and stays outside
  // the gate above. What the gate controls is `depthRamp`, which σ is about to
  // be multiplied against via `depth01` below.
  //
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
  // `opacity` scales the OPTICAL DEPTH, not the finished colour. That matters:
  // lerping the transmittance toward 1 (the first attempt) drags every channel
  // toward each other and destroys the hue separation the line above just
  // bought, so a half-opacity river went grey rather than pale-teal. Scaling
  // the exponent is what "less water" physically means and leaves the per-
  // channel RATIOS exactly intact at every setting.

  // ── TIER 2: THE SURFACE FIELD ────────────────────────────────────────────
  // See `water-field.js` for why this rung is foam + turbidity and NOT
  // slope-shading: from directly above a slope is invisible without refraction
  // (rung 5) or specular (rung 3), and faking a light here would fight the real
  // one later. `timeMsNode` is the viewer's shared clock, handed in.
  //
  // ⚠️ NEUTRAL below tier 2, and the fractal-noise fetch ITSELF never runs
  // below it, not just its result: zero turbidity leaves the optical depth
  // exactly what tier 1 computed, zero foam hides nothing and adds nothing,
  // and a zero slope leaves tier 3 (if it somehow ran) on the flat normal.
  // `tangentXY` reads `bodyTexNode`, which is only non-null once
  // `activeTier >= 2` (rungs are cumulative — tier 2 can never be reached
  // without tier 1 already being affordable, effect-cascade.js#resolveEffectTier).
  let field = { foam: float(0), turbidity: float(0), slope: null };
  if (activeTier >= 2) {
    field = buildWaterSurfaceField({
      TSL: THREE.TSL,
      worldXY: vec2(positionWorld.x, positionWorld.y),
      timeMsNode: timeMsNode ?? float(0),
      tangentXY: vec2(bodyTexNode.b, bodyTexNode.a),
      shoreDist,
      insideWater: inside,
      uWaveScalePx,
      uFlowSpeedPx,
      uFlowAngleRad,
      uFoam,
      // TIER 3's WAVE NORMAL rides tier 2's fetch — see `water-light.js`'s
      // header for why its absence made rung 3 measure invisible. Passed here
      // rather than inside the tier-3 block below because the FETCH belongs to
      // tier 2; only its third reading is tier 3's.
      uChop,
    });
  }

  // Turbidity rides the OPTICAL DEPTH, which is what makes it visible with no
  // lighting at all: it varies a quantity the absorption already renders,
  // rather than adding one that needs a light to be seen. Clamped positive so
  // a trough can thin the water but never invert it into a brightener.
  const turbid = max(float(1).add(field.turbidity.mul(uTurbidity)), float(0));
  const depth01 = maskTexNode.r.mul(depthRamp).mul(inside).mul(uOpacity).mul(turbid);
  // Outside the water `depth01` is 0, so this is exactly 1 — the identity of
  // the multiply blend. The pass provably cannot darken dry land.
  const bedTransmit = exp(sigma.negate().mul(depth01));
  // IN-SCATTER — and ⚠️ **THIS TERM, NOT THE BLEND, IS WHAT MADE WATER LOOK
  // LIKE PAINT** (author, three times; finally diagnosed 2026-07-26).
  //
  // The multiply pass was correct and working the whole time. The problem is
  // what it left behind. At the shipped defaults (absorption 3, opacity 0.62)
  // the bed came through the multiply at `(0.032, 0.084, 0.087)` — 99% ABSORBED
  // — and then this term added a flat `(0.074, 0.198, 0.230)` on top. So the
  // final picture was almost entirely a CONSTANT COLOUR added over everything,
  // with no bed left in it. That is paint, by any definition, and it is what
  // you get from a physically-honest volume model driven past the point where
  // the volume is opaque. Being right about the equation does not help if the
  // parameters put you in the regime where the equation says "you cannot see
  // the bottom".
  //
  // Two changes keep it honest AND keep it water:
  //   · `absorption` now defaults to a value that leaves the bed VISIBLE, which
  //     is what makes the multiply mean anything (see WATER_TIER1_ABSORPTION).
  //   · in-scatter is scaled by its own control, defaulting well below 1. Real
  //     shallow water returns very little light toward a viewer directly above
  //     it; a full-strength term is a deep-ocean look applied to a ford.
  //
  // Keyed off the transmittance BEFORE the wet band touches it, so damp ground
  // (which has no volume above it) can never in-scatter — the precise line
  // where the blue-margin bug lived.
  const inscatter = uTint.mul(float(1).sub(dot(bedTransmit, vec3(1 / 3, 1 / 3, 1 / 3)))).mul(uInscatter);

  // ── TIER 3: SUN + SKY SPECULAR ───────────────────────────────────────────
  // See `water-light.js` for the physics and the header above for why this
  // stays in THIS pass rather than following shine's own post-lighting scene.
  // Never tinted by `uTint` — see that module's header on why a dielectric's
  // mirror reflection takes its colour from the SKY, not the medium beneath.
  //
  // ⚠️ NEUTRAL below tier 3: a stub carrying the SAME method surface as the
  // real handle (`setSky`, `setSunGlint`, ...) so every setter this function
  // returns stays a plain, always-valid function — a caller never needs an
  // "is tier 3 live" branch just to push a slider value (mirrors how a
  // disabled `params/no-dead-controls` consumer still exists, just does
  // nothing). `reflection` is a literal zero vec3: the GGX/Smith/Schlick lobe
  // — two dot products, a sqrt, a division — never runs below this tier.
  let specular = {
    reflection: vec3(0, 0, 0),
    setViewCentre() {},
    setSky() {},
    setSunGlint() {},
    setSkySheen() {},
    setGlossiness() {},
    setViewerHeight() {},
    outdoorsGateCompiled: false,
    normalCompiled: false,
  };
  if (activeTier >= 3) {
    specular = buildWaterSpecular({
      TSL: THREE.TSL,
      positionWorld,
      uViewRect,
      uOutdoorsRect,
      outdoorsTexNode,
      buildOutdoorsGate,
      sunGlint,
      skySheen,
      glossiness,
      viewerHeight,
      // THE WAVE NORMAL. Non-null here by construction — rungs are cumulative,
      // so reaching tier 3 means tier 2 built the field above. Passing it is
      // what separates a visible rung from the flat 0.0084 wash this shipped
      // as; `water-light.js`'s header carries the measurement.
      slopeXY: field.slope,
    });
  }

  // ============================================================================
  // TIERS 4-8 — NOT YET BUILT. THIS IS WHERE THEY GO (Effects.md §0 / §2)
  // ============================================================================
  // Named, ordered and costed in `WATER.deferredRungs` (water.js) and
  // `Water.md` §6; nothing below is code, only the landing strip a real rung
  // gets the day its own module lands. Each becomes an
  // `if (activeTier >= N) { ... }` block in this exact position, CUMULATIVE
  // with everything above it — tiers 1-3 just established the pattern.
  //
  //   tier 4  shore       C4  SDF shoreline foam filaments + wave shoaling +
  //                           caustics from the surface field's Jacobian
  //   tier 5  refraction  C5  DEPENDENT read of buf:scene.color, offset by
  //                           slope × thickness — the first rung whose
  //                           coordinate comes from another read
  //   tier 6  reflection  C6  short screen-space march along the wave normal
  //                           for shoreline objects and tokens — the first
  //                           rung with its own VRAM cost (Effects.md §4.6)
  //   tier 7  sim         C7  spectral cascade + interactive ripple integrator,
  //                           ADDED into tier 2's field, never substituted for
  //                           it — ticks whether seen or not, so it needs a
  //                           coverage/zoom gate too (Effects.md Law 7), tier
  //                           alone is not enough
  //   tier 8  spray       C8  splash/spray particles through the one particle
  //                           engine — geometry, the top of the ladder
  //
  // None of the five has a `fromProfile` yet — that is a real design decision
  // for whoever builds it, not a placeholder to guess at here. What IS already
  // true: `quality` and `extreme` (effect-cascade.js#PERFORMANCE_PROFILES) buy
  // NOTHING beyond tier 3 today (WATER.tiers tops out at `standard`), so the
  // first of these five rungs to declare `fromProfile: 'quality'` or
  // `'extreme'` is what finally gives those two profiles a water of their own
  // — the same way candle flame's tier 4 (`perCandle`, `fromProfile: 'extreme'`)
  // does for candles.
  // ============================================================================

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
  // FOAM OCCLUDES, so it appears in BOTH passes and as the complement in each:
  // it hides the bed (a further multiply by `1 − foam`) and it emits white
  // (an add). Splitting it any other way would let foam brighten the bed it is
  // supposed to be covering.
  const foamHide = float(1).sub(field.foam);

  const absorbMaterial = new THREE.NodeMaterial();
  absorbMaterial.colorNode = vec4(bedTransmit.mul(float(1).sub(wetBand)).mul(foamHide), 1);
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
  // The reflection is gated by `inside` (no glint on dry land — the same
  // antialiased shoreline every other term already uses) and by `foamHide`
  // (broken, foamy water scatters light, it does not mirror it — reusing the
  // exact factor that already suppresses the bed and the in-scatter, rather
  // than adding a second foam interaction to reason about).
  const reflection = specular.reflection.mul(inside).mul(foamHide);

  // The water's own returned light, itself occluded by foam, PLUS the foam,
  // PLUS the sun/sky reflection. 0.85 rather than pure white on the foam term:
  // blown-out foam reads as a UI overlay, and the grade stack downstream has
  // its own opinion about highlights.
  inscatterMaterial.colorNode = vec4(
    inscatter
      .mul(foamHide)
      .add(field.foam.mul(float(0.85)))
      .add(reflection),
    1
  );
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
    /** The rung this material graph was actually BUILT at (Effects.md Law 4) —
     * for the debug report and for the caller's own rebuild-on-change check
     * (`water-surface-subsystem.js`). */
    tier: activeTier,
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
    setInscatter(v) {
      uInscatter.value = v;
    },
    setWaveScalePx(v) {
      uWaveScalePx.value = v;
    },
    setFlowSpeedPx(v) {
      uFlowSpeedPx.value = v;
    },
    setFlowAngleDeg(v) {
      uFlowAngleRad.value = (v * Math.PI) / 180;
    },
    setFoam(v) {
      uFoam.value = v;
    },
    /** WATER_PARAMS `chop` — tier 3's wave steepness. Floored at 0 (a mirror
     * pond) rather than allowed negative: a negative slope scale would flip
     * every wave normal's lean without changing its magnitude, which is not a
     * calmer surface, just a differently-wrong one. */
    setChop(v) {
      uChop.value = Math.max(0, v);
    },
    setWetBandPx(v) {
      uWetBandPx.value = v;
    },
    setWetStrength(v) {
      uWetStrength.value = v;
    },
    // ── TIER 3 ────────────────────────────────────────────────────────────
    /** The camera's world rect centre — pushed per frame, never gated. */
    setViewCentre(cx, cy) {
      specular.setViewCentre(cx, cy);
    },
    /** The whole sky, in one call — see `water-light.js#setSky`. */
    setSky(sky) {
      specular.setSky(sky);
    },
    setSunGlint(v) {
      specular.setSunGlint(v);
    },
    setSkySheen(v) {
      specular.setSkySheen(v);
    },
    setGlossiness(v) {
      specular.setGlossiness(v);
    },
    setViewerHeight(v) {
      specular.setViewerHeight(v);
    },
    /** For the debug report — whether the outdoors branch is real on this
     * scene or compiled to the indoors constant. */
    outdoorsGateCompiled: specular.outdoorsGateCompiled,
    /** For the debug report — whether tier 3 got a real wave normal. See
     * `water-light.js#normalCompiled`: `false` is the measured-invisible
     * configuration, and it fails silently. */
    normalCompiled: specular.normalCompiled ?? false,
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
