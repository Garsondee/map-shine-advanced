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
 * (tier 2, which ALSO carries tier 4's shoaling/caustics booleans — see that
 * function's own header for why both live inside tier 2's fetch rather than a
 * separate tier-4 block), `buildWaterSpecular` (tier 3), `buildWaterFilamentFoam`
 * (tier 4's one genuinely independent piece). Below a rung's threshold the term
 * it would have produced is a literal neutral default (`float(0)`, `float(1)`,
 * `vec3(0,0,0)`) wired in instead — never computed, never sampled, never bound
 * — so the compiled shader for a `low`-profile machine is genuinely smaller,
 * not merely quieter (§7's own test: compare tier 0 and tier N shader length).
 * A tier change therefore means a NEW node graph, which means new materials:
 * the caller (`water-surface-subsystem.js`) rebuilds and disposes on a
 * resolved-tier change, mirroring candle flame's own quality-tier material
 * rebuild (`vt-pan-viewer.js#candleFlameMat`).
 *
 * TIERS 5-8 (`Water.md` §6, `WATER.deferredRungs` in `water.js`) are NOT built
 * — see the scaffold comment beside `activeTier` below for where each one's
 * `if (activeTier >= N)` block lands the day its own code does. TIER 4
 * (`shore` — filament foam, wave shoaling, caustics) landed 2026-08-16.
 *
 * ============================================================================
 * ⚠️ CORRECTION, 2026-08-15 — PAINT ORDER ALONE WAS NEVER SUFFICIENT, AND THE
 * PARAGRAPHS BELOW ARE THE STALE REASONING THAT SHIPPED ANYWAY
 * ============================================================================
 * The "draw order IS the punch" argument two sections down is correct FOR A
 * SINGLE FLOOR IN ISOLATION and was written three days before the depth
 * authority (`keyhole-depth-authority-sole-system-decision`, LOCKED
 * 2026-08-04) existed to check it against. `water-surface-subsystem.js`'s own
 * header made the load-bearing assumption explicit: "index 0 of the sorted
 * list [is] always... the floor background" — true only when water's own
 * resolved floor happens to be the LOWEST floor in whatever multi-floor
 * composite the current frame actually draws. The moment a floor BELOW
 * water's own is also part of that composite (any multi-floor scene, viewed
 * from anywhere but the single lowest floor — which per
 * `keyhole-orthographic-hole-stack-model` is the ORDINARY case, not an edge
 * one), that lower floor's own real content sorts BETWEEN the true index-0
 * background and water's own fixed position, and paint order alone can no
 * longer promise the lower floor stays behind it. Reported live 2026-08-15:
 * "water renders above things that should be masking it," worse on upper
 * floors — exactly this shape, and exactly the same symptom specular and
 * window were each built to fix on this same system months earlier
 * ("previously they were failing to render correctly on the upper floor").
 *
 * THE FIX rides the now-LOCKED depth authority, the same one line every other
 * consumer already uses: `step(uExpectedDepth, depthHere)` against
 * `buf:scene.depth`, gating BOTH of tier 0's meshes toward each blend's own
 * neutral element (white for the multiply, zero for the add — see "WATER IS
 * TWO BLENDS" below) wherever something already ranks above water's own
 * floor's background at this pixel. Paint order still does the REST of the
 * job it always did — same-floor foam/wet-band layering, mesh-1-before-mesh-2
 * ordering — this only closes the CROSS-FLOOR gap paint order could never
 * promise on its own. See `water-surface-subsystem.js` and
 * `water-seams.js#getWaterBackgroundItemId` for the rest of the migration.
 *
 * ============================================================================
 * 2026-08-16 — THREE AUTHOR-REPORTED FIXES, ALL STRUCTURAL, ALL IN THIS FILE
 * ============================================================================
 * Recorded together because they arrived together and because each is a
 * different shape of the same underlying mistake: **a soft answer standing in
 * for a hard boundary.**
 *
 *   1. **WATER OUTSIDE THE MAP** — *"water can appear outside the bounds of the
 *      actual map"*. The mesh is padded 64 px past the measured water AABB, and
 *      the mask fetch CLAMPS its UV, which does not stop at the rect — it
 *      extrudes the edge row across everything beyond it. Fixed in two places
 *      that fail differently: `water-body-subsystem.js#clipRectToMask` keeps the
 *      GEOMETRY inside the authored rect, and `inRect` below makes any fragment
 *      that still lands outside contribute nothing to either mesh.
 *   2. **HARD EDGES IN THE WHITE THINGS** — *"unusual hard edges appearing that
 *      don't make sense"*, traced as a staircase through open water. Two causes,
 *      both amplifiers on the coarse body pack: the bank warp applied at full
 *      strength at the medial axis, where the shore tangent is meaningless
 *      (`water-field.js#WATER_BANK_REACH_PX`), and plain bilinear's C0 crease at
 *      every one of the pack's ~21-world-px texel boundaries, pushed through a
 *      wet-band smoothstep, a foam threshold and a GGX lobe
 *      (`water-sampling.js`). Neither is a resolution problem and neither is
 *      fixed by a finer field — that round trip was already made and recorded.
 *   3. **THE GLINT SHONE INSIDE BUILDINGS** — *"sun glint needs to be defeated
 *      by shadows"*. `Water.md` §7 has listed sun occlusion as one of water's
 *      seven handles since the design was written, and tier 3's own ladder row
 *      says "gated by `buf:scene.illum` and `buf:scene.vis`"; the gate simply
 *      never got built. It was not obviously missing because the glint DOES ride
 *      the ambient fill's own `sunVis` downstream — but a lobe that reaches ten
 *      times the buffer's white point is still blown out after a 0.3× ambient.
 *      See `water-light.js#WATER_TIER3_SHADOW_RESPONSE`.
 *
 * Also here: the flow direction became a COMPASS (`water-field.js#
 * waterFlowVector`), which meant confronting that the old heading ran clockwise
 * from +x on a Y-down screen while its help text claimed otherwise, AND that
 * the advection was added to the noise domain rather than subtracted, so every
 * river had been running backwards.
 *
 * SAME SESSION, ONE RUNG FURTHER: TIER 4 (`shore`) LANDED — `Water.md` §6's own
 * text for this rung ("no derivatives, no divergent-flow UB") was written down
 * before any of it existed, and building it turned that into three real
 * decisions rather than one: shoaling and caustics have to live inside tier 2's
 * OWN fetch (see `water-field.js`'s header — tier 3 has already consumed
 * `field.slope` by the time a separate `if (activeTier >= 4)` block would run),
 * caustics reads the field's Jacobian from two EXPLICIT world-space taps of the
 * already-safe warped domain rather than a screen-space derivative, and its
 * calibration constant (`WATER_CAUSTICS_K`) was swept against 65,536 real
 * samples of the actual GPU noise before shipping — the same measure-first
 * discipline tier 3's own invisible-ship cost this codebase once already.
 * ============================================================================
 * ⚠️ THERE IS NO `buf:scene.attr` READ HERE — STILL TRUE, DIFFERENT REASON
 * ============================================================================
 * Water.md §6 and `graph/passes.js` both describe tier 0's occlusion — "the
 * punch" — as a `buf:scene.attr` read: sample the attribute buffer, kill water
 * under opaque upper geometry. That specific mechanism remains both
 * unnecessary and unsafe:
 *
 *   UNSAFE — water draws inside `runGeometryWorldPass`, which is the very pass
 *   that WRITES `buf:scene.attr` as MRT attachment 1 of `scene.color`. Sampling
 *   a target the same pass is writing is undefined behaviour on both backends.
 *
 *   UNNECESSARY — `buf:scene.depth` is a SEPARATE attachment, written by
 *   `runSceneDepthPass` BEFORE the colour draw runs at all (the depth
 *   authority's own "SEVENTH CONSUMER" pass-order change, 2026-08-09), so
 *   reading it here has none of `buf:scene.attr`'s same-pass hazard — it is
 *   already fully written by the time water's fragment shader runs.
 *
 * Paint order still handles same-floor, non-occlusion layering for free (see
 * below); the depth-authority gate above is what makes cross-floor occlusion
 * actually correct rather than merely usually-correct.
 *
 * THREE is INJECTED, never imported (the bloom split's rule).
 *
 * @module effects/water/water-render
 */

import {
  buildWaterSurfaceField,
  waterFlowVector,
  WATER_TIER2_WAVE_SCALE_PX,
  WATER_TIER2_FLOW_SPEED_PX,
  WATER_TIER2_FLOW_ANGLE_DEG,
  WATER_TIER2_FOAM,
  WATER_TIER3_CHOP,
  WATER_BANK_INFLUENCE,
  WATER_FLOW_WARP_INFLUENCE,
  WATER_CAUSTICS_SHARPNESS,
  WATER_CAUSTICS_SCALE,
  WATER_CAUSTICS_NETTING,
} from './water-field.js';
import {
  buildWaterSpecular,
  WATER_TIER3_SUN_GLINT,
  WATER_TIER3_SKY_SHEEN,
  WATER_TIER3_GLOSSINESS,
  WATER_TIER3_VIEWER_HEIGHT,
  WATER_TIER3_SHADOW_RESPONSE,
} from './water-light.js';
import { buildSmoothTexelUv } from './water-sampling.js';
import {
  buildWaterShoreFoam,
  waterFoamReachPx,
  buildFoamCellularStructure,
  WATER_FOAM_FLOW_NUDGE,
  WATER_FOAM_EDGE_FAR,
  WATER_FOAM_EDGE_AA_PX,
  WATER_FOAM_BUBBLE_AMOUNT,
  WATER_FOAM_BUBBLE_OCTAVE,
  WATER_FOAM_BUBBLE_TIME_SCALE,
  WATER_FOAM_GRAIN_AMOUNT,
  WATER_FOAM_GRAIN_OCTAVE,
  WATER_FOAM_GRAIN_TIME_SCALE,
} from './water-shore.js';
import { WATER_SIM_CLUMP_LO, WATER_SIM_CLUMP_HI, WATER_SIM_CLUMP_AA_PX } from './water-sim.js';
import { buildDebugChannelColor } from '../debug-channel-select.js';
import { WATER_DEBUG_CHANNELS } from './water.js';
// Intra-zone: the ONE hex→byte decoder, already shared by the candle and by
// water's own registration (`water-registration.js`'s tint decode). A second
// copy is how two effects end up disagreeing about what a hex string means.
import { hexToRgb01 } from '../candle-flame-geometry.js';
import { hsb2rgb } from '../lighting/animations/tsl-noise-toolkit.js';

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
 * later do properly.
 *
 * ⚠️ LOWERED 1→0.15 (2026-08-23, author's own live judgment — "Water
 * opacity should be 0.15 ideally, that's more realistic too") — this
 * doc's own "below 1" claim was true in name only until now; the shipped
 * constant had stayed at the fully-opaque fallback since tier 0's own
 * first version. Matches `WATER_PARAMS.opacity`'s own identical default
 * change (`water.js`) — this is the same value, never a second one. */
export const WATER_TIER0_OPACITY = 0.15;

/**
 * THE DEPTH×POLLUTION COLOUR REFERENCE (2026-08-17, Water-Testament S1) — four
 * real colours, not an invented gradient. `depth` blends shallow→deep WITHIN
 * one pole; `pollution` blends between the two poles. Every water colour on
 * screen is a bilinear read of these four, before `tint`'s own minority trim.
 *
 * References, not vibes — the same discipline `Water-Testament.md` §2.2/§2.7
 * already cites (NOAA/USGS): CLEAR follows the round-trip-light explanation
 * for why shallow tropical water reads pale and warm while depth goes dark
 * blue as nothing returns; POLLUTED follows the silt/sediment account (brown-
 * grey, opaque, scatters) rather than a chemical-toxin green — the author's
 * own target is a medieval town river (mud, waste, algae), not a fantasy
 * poison pool.
 */
export const WATER_COLOR_CLEAR_SHALLOW_HEX = '#BEE8DC';
export const WATER_COLOR_CLEAR_DEEP_HEX = '#0C3947';
export const WATER_COLOR_POLLUTED_SHALLOW_HEX = '#736B45';
export const WATER_COLOR_POLLUTED_DEEP_HEX = '#191708';

/**
 * How much of `tint`'s OWN colour survives once `depth`/`pollution` derive
 * the base — a minority hand-tune, never the primary source again. See
 * `tint`'s own schema help (water.js) for the author-facing framing.
 */
export const WATER_TINT_TRIM_WEIGHT = 0.35;

/** How much `depth` (0..1) rescales the absorption coefficient — Water-
 * Testament §3.3's own named range. */
export const WATER_DEPTH_ABSORPTION_RANGE = Object.freeze([0.5, 2.6]);
/** How much `depth` (0..1) rescales the in-scatter strength — same source. */
export const WATER_DEPTH_INSCATTER_RANGE = Object.freeze([0.6, 1.8]);
/** How much EXTRA absorption `pollution` (0..1) adds on top of `depth`'s own
 * scale — sludge is murkier per world-px, independent of how deep the body
 * reads overall (a shallow polluted puddle can still hide its own bed). */
export const WATER_POLLUTION_ABSORPTION_RANGE = Object.freeze([1.0, 1.6]);

/** Tier 1's shipped defaults for the two new S1 params — Water-Testament
 * §3.3's own calibration target (`depth`) and the author's own "large
 * polluted medieval town river" lean (`pollution`). Matches `water.js`'s
 * schema defaults; a change lands in both places or in neither. */
export const WATER_TIER1_DEPTH = 0.45;
export const WATER_TIER1_POLLUTION = 0.6;

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
 *
 * ⚠️ **`EDGE1`'s own SCHEMA CEILING WAS TOO LOW FOR A WIDE, SOFTLY-PAINTED
 * BANK (2026-08-23) — live-reported: "water is extending OUTSIDE of the white
 * parts of the mask... only at soft transitions, not hard ones."** The math
 * explains it exactly: `smoothstep(EDGE0≈0, 0.5, x)` already puts a mask value
 * of 0.2 (a dark, mostly-black-looking grey) at ~34% opacity and 0.3 at ~65% —
 * clearly VISIBLE water at brightness levels a viewer calls "basically land".
 * That is invisible on a mask whose only soft region is ONE bilinear-filtered
 * texel at a hard-painted edge (too narrow spatially to ever look like a
 * problem) and glaring on a WIDE, deliberately soft brush stroke, which spends
 * a meaningful spatial distance sitting in that same 0.2–0.3 range. `EDGE1` is
 * exactly the control for this (`WATER_PARAMS.shorelineDepth`, "raise it if
 * your mask paints shallows you would rather not see") — but its schema `max`
 * was capped at 0.5, the SAME as the default, so an author hitting this
 * symptom had no room to raise it at all. Raised to 0.98 (never a literal 1,
 * matching `EDGE0`'s own non-zero floor, so the ramp cannot invert into a
 * step function at the extreme). Deliberately NOT touched: the DEFAULT stays
 * 0.5, so nothing changes for a map that never turns this dial — this is an
 * opt-in ceiling raise, not a recalibration of the shipped look.
 */
export const WATER_PRESENCE_EDGE0 = 2 / 255;
export const WATER_PRESENCE_EDGE1 = 0.5;

/**
 * The presence edge's own screen-space anti-aliasing width, in SCREEN
 * PIXELS — `water-shore.js#WATER_FOAM_EDGE_AA_PX`'s exact sibling and
 * technique. This edge has ALREADY been the site of two independent,
 * VALUE-space fixes for the identical "pixelated shoreline" symptom
 * (`WATER_PRESENCE_EDGE1`'s own doc, immediately above: the ramp width,
 * then the mask's own upload resolution) — both real, both insufficient on
 * their own, because neither addresses the actual variable: a FIXED
 * value-space ramp still compresses into fewer and fewer screen pixels as
 * either the camera moves or a fine authored detail in the mask itself
 * gets crossed, at any resolution. Same `fwidth()`-based floor as the foam
 * edges: never narrower than a few real screen pixels, whatever the
 * camera or the source art is doing.
 */
export const WATER_PRESENCE_EDGE_AA_PX = 1.5;

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
export const WATER_TIER1_ABSORPTION = 3.2;

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
export const WATER_TIER1_INSCATTER = 0.18;

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
export const WATER_TIER1_DEPTH_SCALE_PX = 312;

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
export const WATER_TIER1_WET_BAND_PX = 84;

/** TIER 1 — how dark the wet band goes at the waterline, 0..1. A NEUTRAL
 * multiply (`dst · (1 − wet)`), never a tint — see the header. Subtle on
 * purpose: damp sand is a shade darker, not a painted outline. */
export const WATER_TIER1_WET_STRENGTH = 0.38;

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

/** TIER 4 — the default SWASH strength: waves running up the beach and draining
 * back. An ADDITION to tier 2's own crest foam, never a replacement. */
export const WATER_TIER4_SWASH_FOAM = 1;

/** TIER 4 — the default BREAK-FOAM strength: the flow driven into a bank, on the
 * upstream face of every obstacle. Higher than the swash by default because it
 * is the one the author named directly (*"the shoreline and break near obstacles
 * foam"*) and because it is naturally one-sided, so it never covers as much of
 * the shore as the swash does. */
export const WATER_TIER4_BREAK_FOAM = 1;

/** TIER 4 — the default caustics strength, as a fraction of
 * `WATER_CAUSTICS_K`'s own calibrated value. 1.0 is the measured operating
 * point (`water-field.js#WATER_CAUSTICS_K`'s own doc has the sweep); this is a
 * MULTIPLIER an author can pull back for a stiller, less busy bed.
 *
 * ⚠️ RAISED 0.33→1 (2026-08-24, author's own live tuning pass) — back to the
 * measured operating point itself; the previous default was a deliberate
 * pull-back, not a calibration this value corrects. */
export const WATER_TIER4_CAUSTICS = 1;

/**
 * How strongly break foam STREAMS DOWNSTREAM from where it was made
 * (`water-shore.js#WATER_TAIL_TAPS`) — the stateless stand-in for the foam
 * MEMORY the Water Testament names as its single highest-value finding.
 * Matches `WATER_PARAMS.foamTrail`; a Node test pins the two equal.
 *
 * ⚠️ RAISED 0.8→0.85 (2026-08-23, author's own live tuning pass, alongside
 * `WATER_TIER3_CHOP`'s own identical-shape update) — matching the schema
 * default's own change, same value, never a second one.
 */
export const WATER_TIER4_FOAM_TRAIL = 0.85;

/**
 * ============================================================================
 * FOAM'S OWN EDGE-SHARPNESS GATE (2026-08-24)
 * ============================================================================
 * Live-reported, right after the soft-mask-bleed fix (`0b1ab2d`) landed:
 * *"Currently the foam that we've been working on appears on all shores, but
 * could we add a slider so that it only appears from sharp black/white
 * transitions and actually doesn't happen when there is a smoother edge?"*
 * A genuinely new capability, not a bug — every foam source this effect has
 * (`field.foam`'s shore-proximity crest, the sim-driven wake) fires near ANY
 * shore, with no notion of whether the author painted that shore hard or
 * soft.
 *
 * THE MEASUREMENT: how fast the RAW mask value changes per world px, sampled
 * as a central difference at a FIXED WORLD-SPACE offset
 * (`WATER_FOAM_EDGE_SHARPNESS_TAP_PX`) — deliberately NOT `fwidth()` (that is
 * a SCREEN-space derivative, confounded with camera zoom; this needs a
 * property of the AUTHORED ART, independent of how close the camera happens
 * to be).
 *
 * ⚠️ **A CENTRAL DIFFERENCE CANNOT DISTINGUISH TWO EDGES BOTH NARROWER THAN
 * ITS OWN SAMPLING SPAN — THE TAP DISTANCE IS THE WHOLE CALIBRATION, NOT A
 * DETAIL.** The full 0→1 rise happens SOMEWHERE inside a `2×TAP_PX`-wide
 * window either way, so a source-texel-hard edge and a moderately soft
 * (tens of world px) edge read IDENTICALLY once both are narrower than that
 * window. The first shipped version used a 16px tap (32px span) and shipped
 * exactly this failure: edges from ~1.5px through 20px are mathematically
 * indistinguishable at that span (verified by hand-deriving the formula's
 * own output, not just reasoning about it) — a real, deliberately-feathered
 * bank reads as "just as sharp as a pier" the whole time, so raising the
 * slider visibly does nothing. `WATER_FOAM_EDGE_SHARPNESS_TAP_PX` is now 4:
 * narrow enough that a 20-80px soft edge spends only a FRACTION of the
 * sampling span crossing the ramp, giving a genuinely smaller reading than
 * a true hard edge, which crosses its own much-narrower transition entirely
 * within the same span regardless.
 *
 * ⚠️ **THE THRESHOLD ITSELF STAYS A CONSTANT; THE AUTHOR-FACING SLIDER IS
 * `WATER_PARAMS.foamEdgeSharpness`, A BLEND, NOT A RECALIBRATION.** The
 * shader computes `gate = smoothstep(GRAD_LO, GRAD_HI, gradMag)` once, then
 * `sharpnessFactor = mix(1, gate, foamEdgeSharpness)` — at `foamEdgeSharpness
 * = 0` (the schema default) this is EXACTLY 1 everywhere, so a map that
 * never touches this new slider gets byte-identical foam to before this
 * fix, matching every other opt-in threshold change this session
 * (`shorelineDepth`'s own two rounds). Raising it interpolates toward the
 * full gate, so the author controls how STRICTLY this applies rather than
 * needing to guess a correct absolute gradient value themselves.
 */
export const WATER_FOAM_EDGE_SHARPNESS_TAP_PX = 4;
/** Below this measured gradient (mask value change per world px), an edge
 * reads as fully SOFT. At the 4px tap above, an 80px-wide ramp measures
 * ~0.0125 (comfortably below) and a 160px+ ramp measures well under that —
 * both fully suppressed once the slider is raised. */
export const WATER_FOAM_EDGE_SHARPNESS_GRAD_LO = 0.015;
/** At or above this measured gradient, an edge reads as fully SHARP. At the
 * 4px tap above, a true hard (source-texel-width, ~1-2px) edge measures
 * ~0.125 and a still-fairly-crisp 10px edge measures ~0.1 — both
 * comfortably above this ceiling. A 20px edge (~0.05) sits mid-band on
 * purpose: "moderately soft" should read as partially suppressed, not a
 * hard on/off flip. */
export const WATER_FOAM_EDGE_SHARPNESS_GRAD_HI = 0.08;

/**
 * `capturedRect`'s own default — a degenerate-but-safe 1×1 world rect at the
 * origin, used ONLY before `water-refraction-subsystem.js` has ever
 * completed a real capture (`setCapturedRect` re-points it the moment one
 * lands). Every UV built from it clamps to [0,1] regardless, so the worst
 * this default can do is sample one corner texel of the 1×1 placeholder
 * texture — never a NaN, never an out-of-range read.
 */
export const WATER_TIER5_PLACEHOLDER_RECT = Object.freeze({ minX: 0, minY: 0, maxX: 1, maxY: 1 });

/**
 * ⚠️ NO LONGER THE ONLY PLACE A SCALE ENTERS (2026-08-23) — this is now just
 * the DEFAULT for `WATER_PARAMS.refractStrengthPx` (water.js), a live,
 * wide-range author control (`buildWaterSurfaceMaterial`'s own
 * `refractStrengthPx` constructor param, `setRefractStrengthPx`). Kept as a
 * named export because a torture-fixture/unwired caller still needs SOME
 * default. See that param's own doc for the full story of why a fixed
 * constant here was the wrong shape once it became clear the visible
 * effect was crushed by TWO other factors (`field.slope`'s own measured,
 * always-small magnitude; `depth01`'s own measured low range) that this
 * constant alone could never account for.
 *
 * World-space UNITS (not texels — the offset is computed before the world→UV
 * remap) the refracted sample point shifts by, at `field.slope`'s own
 * BOUNDED unit-length direction (see `refractOffsetWorld`'s own comment at
 * the call site for why the raw vector is normalised first) and full depth.
 *
 * ⚠️ LOWERED 24→6, LIVE-REPORTED (2026-08-23): the author's own words,
 * "weird oil spill like patterns," at the schema DEFAULT chop (0.86) — the
 * original 24 was an unbounded guess, multiplying an UNCLAMPED `field.slope`
 * (this rung's own first bug: nothing capped its magnitude before using it
 * as a sample-position offset, unlike every other slope/deviation-driven
 * term in this effect — `WATER_FOAM_FLOW_NUDGE`'s own `deviationSafe`,
 * `water-field.js`'s own `flowDeviationSafe`, both normalise-then-scale for
 * exactly this reason). A steep or noisy per-pixel slope could push the
 * sample arbitrarily far from its true position, and a REFRACTED position
 * that jumps by more than a texel or two between neighbouring pixels reads
 * as decorrelated noise, not a bend — the shader-lab bench's own synthetic
 * fixture reproduced a milder version of this at the SAME chop, checkerboard
 * squares visibly displaced rather than shattered; the live map's own real
 * wave field apparently reaches this regime harder.
 *
 * ⚠️ THEN LIVE-REPORTED AGAIN, THE OPPOSITE PROBLEM (2026-08-23, same day):
 * "Nothing. No sign of distortion. Assume it's broken, not subtle." 6 was
 * chosen to be safely small against the (now-fixed) unbounded-slope bug,
 * but never re-measured against how small `field.slope` and `depth01`
 * actually run in practice — see `refractOffsetWorld`'s own call-site
 * comment for the measured numbers. This constant alone was never going to
 * be enough at ANY single fixed value; hence the live param.
 */
export const WATER_TIER5_REFRACT_PX = 6;

/**
 * The hard ceiling on tier 5's own alpha, strictly below 1.0. `attr`'s MRT
 * write during the refraction mesh's pass is the multiplicative identity
 * (`vec4(1,1,1,1)`), and a REPLACE-style alpha blend has no value that leaves
 * `buf:scene.attr` unchanged at alpha==1 (see `debugMaterial`'s own comment
 * on this exact constraint) — capping alpha below 1 guarantees some of
 * whatever `attr` already held always survives the lerp. Flagged as an
 * imperfect, pragmatic tradeoff pending a live look, not a solved problem.
 */
export const WATER_TIER5_MAX_ALPHA = 0.85;

/**
 * The chromatic fringe's own OFF/ON luminance band, measured on
 * `specular.reflection` (water-light.js) at THIS SAME fragment, THIS SAME
 * frame — not the captured (previous-frame) texture the fringe itself reads.
 *
 * ⚠️ LIVE-REPORTED (2026-08-23), two screenshots: a field of small rainbow
 * chevrons scattered across open water, author's own diagnosis verbatim —
 * "The specular is strongly getting folded into the refraction's chromatic
 * aberration which isn't actually physically sensible. The specular
 * highlight sits on the surface of the water, only air between it and the
 * camera. The bottom of the lake is where we want the chromatic aberration,
 * not the surface." Root cause: `capturedTexture` is last frame's FINISHED
 * `buf:scene.color` (`water-refraction-subsystem.js`'s own header — tiers
 * 0-4 draw inside the same pass that writes it), which already has
 * `specular.reflection` baked in additively (`inscatterMaterial`'s own
 * `reflection` term, below) — so the fringe's ±1-texel R/B split was
 * splitting the sun-glint sparkle itself into colour, not just the bed
 * colour it is meant to disperse. Correct fix architecturally is keeping
 * reflection out of what gets captured at all (its own pass, after the
 * capture) — a real frame-graph change, not attempted here; this is the
 * same-session, no-new-pass mitigation: gate the fringe OFF wherever THIS
 * fragment is currently a strong specular highlight, using the exact same
 * `specular.reflection` node tier 3+ already computes for THIS pixel this
 * frame (not a brightness guess against the stale capture).
 *
 * Thresholds are luminance multiples of the render's own white point, reused
 * from `water-light.js#sunSpec`'s own documented magnitude language ("a lobe
 * that reaches ten times the buffer's white point is still blown out after a
 * 0.3× ambient") — LO sits clearly above ordinary lit water (which reads
 * nowhere near white-point brightness) so the smoothstep starts inside the
 * glint's own spatial footprint, not just its single brightest texel; HI
 * sits well under the sun disc's ~10× extreme peak so genuinely broad,
 * moderate brightness (a sunlit shallow, sky sheen) is never mistaken for
 * the glint. Unmeasured against the real map — an honest first estimate in
 * the same spirit as `WATER_TIER5_REFRACT_PX`'s own, pending a live look.
 */
export const WATER_TIER5_FRINGE_SPECULAR_LO = 1.0;
export const WATER_TIER5_FRINGE_SPECULAR_HI = 3.0;

/**
 * ⚠️ THE SAFETY SLIDE THIS CONSTANT USED TO PULL (2026-08-23) — kept as
 * `false`, not deleted, because the STORY explains real, load-bearing
 * decisions elsewhere in this file and `water-surface-subsystem.js` that
 * would otherwise look unmotivated.
 *
 * Root cause, confirmed not guessed: `water-refraction-subsystem.js#tick()`
 * captures `buf:scene.color` AFTER `runGeometryWorldPass` finishes — and
 * tier 5's own mesh USED TO draw inside that very pass (renderOrder 0.52,
 * last of the three), so its own output was already baked into what got
 * captured for its OWN next read. Tier 5 was genuinely reading a buffer
 * containing its own past output, every frame, forever. Author, live,
 * after two narrower fixes (bounding the offset magnitude, f4bd218;
 * suppressing the chromatic fringe on specular, cfbdfa2) both failed to
 * resolve it: "It's like the water is sampling itself and then producing
 * visual feedback noise which is compounding." Correct, and a different,
 * more fundamental problem than either shipped fix targeted — the self-
 * reference itself, not any one term's magnitude.
 *
 * ⚠️ THE ACTUAL FIX (2026-08-23, same day, author: "Go ahead and build the
 * proper fix now") — tier 5's mesh now draws in `waterRefractScene`
 * (`vt-pan-viewer.js`), a SEPARATE scene `runGeometryWorldPass` never
 * touches, drawn explicitly by `runWaterRefractionCapturePass` itself —
 * AFTER that same pass's own per-floor capture loop, same frame, reading
 * what THAT capture just produced (ZERO-frame latency now, not one — a
 * strict improvement, not just a fix; see that pass's own updated header).
 * `notOccluded` — the SAME depth-authority value mesh 1/2 already trust —
 * now gates `refractAlpha` too, since the mesh lost the free painter's-
 * algorithm occlusion that came from sharing `scene`.
 *
 * Verified via a REAL shader-lab scenario, not reasoning alone:
 * `tier5-refraction-does-not-capture-itself` (bench-water.js) runs a genuine
 * multi-iteration capture-then-draw loop against a real WebGPU device and
 * demands the captured content be byte-identical every iteration over a
 * static fixture — `measured: 0` divergence, exactly, reproduced twice. The
 * three pre-existing water scenarios still pass unchanged after this one's
 * own scene-juggling cleanup.
 *
 * `water-surface-subsystem.js#sync()` reads this constant via
 * `resolveGatedWaterTier` — a production-wiring decision, never read inside
 * `buildWaterSurfaceMaterial` itself, so every tier-5 construction test in
 * this file's own "TIER 5" section stayed valid and testable throughout.
 *
 * If this ever needs to go back to `true` (a live regression this
 * architecture didn't anticipate), that is a real, worth-a-Petition
 * decision — not a quiet revert.
 */
export const WATER_TIER5_DISABLED_PENDING_SELF_CAPTURE_FIX = false;

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
 *   for tier 3's synthesised eye (`water-light.js`) AND, since 2026-08-15, for
 *   mapping `positionWorld` to the depth-authority gate's own screen UV — see
 *   `args.depthTexture`. Absent compiles BOTH to their safe defaults (tier 3's
 *   zero reflection; the occlusion gate open).
 * @param {*} [args.uOutdoorsRect] @param {*} [args.outdoorsTexNode] - envLight's
 *   outdoors rect/texture, shared the same way.
 * @param {Function} [args.buildOutdoorsGate] - injected world-space gate
 *   builder; absent compiles tier 3's reflection to a safe zero.
 * @param {*} [args.depthTexture] - `buf:scene.depth`'s DEPTH attachment
 *   (2026-08-15, the depth-authority migration — see the module header).
 *   Absent/null compiles the occlusion gate OUT entirely (a JS-time branch,
 *   Effects.md Law 4 — never a uniform multiplied by a permanent one), which
 *   is exactly today's pre-migration behaviour: paint order alone. Present,
 *   it gates BOTH meshes toward their own blend's neutral element wherever
 *   `buf:scene.depth` says something already ranks above THIS water's own
 *   floor at a pixel — see `args.uViewRect` for the screen-UV it is sampled at.
 * @param {number} [args.tier] - the resolved rung (effect-cascade.js#resolveEffectTier).
 *   JS-`if` gates rungs 1-3's node construction (Effects.md Law 4) — see the
 *   header's "TIER GATING" section. Absent/non-finite falls back to
 *   {@link WATER_DEFAULT_TIER}, today's shipped look, never tier 0.
 * @param {*} [args.flowPackTexture] - `res:waterFlow`'s own finished pack
 *   (`water-flow.js`, S2 solidity + S3 velocity/speed01 — RG velocity
 *   normalised to a free-stream speed of 1, B speed01, A solidity), for the
 *   `flowSolidity`/`flowVelocity` debug channels AND (S4) the shore-foam
 *   terms' own local direction/speed. Unlike `depthTexture`, absent/null
 *   does NOT compile the read out: the caller (`water-surface-subsystem.js`)
 *   always supplies a real (if 1×1 placeholder) texture object here, the
 *   same contract `maskTexture` itself already keeps, because this reads at
 *   EVERY tier and has no JS-time fact to gate on the way a tier number or
 *   an optional pass attachment does.
 * @param {*} [args.waterSimTexture] - `res:waterSim`'s own ping-ponged pack
 *   (`water-sim.js`+`water-sim-subsystem.js`, S5, 2026-08-18) — R is the RAW
 *   foam accumulator, NOT display-ready (see that module's own header on why
 *   the clump/break threshold is deliberately NOT baked into the stored
 *   state). This function applies `smoothstep(WATER_SIM_CLUMP_LO,
 *   WATER_SIM_CLUMP_HI, …)` itself, once, at read time — see `waterSimFoam`
 *   below. Same "always a real, if placeholder, texture" contract as
 *   `flowPackTexture` — never compiled out by tier.
 * @param {readonly [number, number]|null} [args.flowPackTexSize] - the flow
 *   pack's own finest-level texel dimensions, `[width, height]` — SAME
 *   reason `waterSimTexSize` immediately below exists. Live-reported
 *   2026-08-19, once `flowWarp`/the foam flow-nudge made this pack's own
 *   coarse grid load-bearing for the base surface (not just foam shape,
 *   which was a more forgiving consumer): "pixelated texels in the overall
 *   appearance." Same fix, same file, same author-reported shape as
 *   `waterSimTexSize`'s own scar one entry below — `buildSmoothTexelUv`
 *   needs the real texel pitch or it degrades to a no-op identity remap.
 * @param {readonly [number, number]|null} [args.waterSimTexSize] - the sim
 *   grid's own texel dimensions, `[width, height]` — SAME reason
 *   `bodyTexSize`/`uBodyTexSize` exists: the sim grid is coarse relative to
 *   the mask (matching the flow pack's own finest level, ~10 world-px/texel
 *   on a real map), and after the display-time clump threshold above, foam
 *   is a SHARP-edged field, not a smooth one — plain bilinear sampling of a
 *   coarse texture through a sharp threshold reads as visibly blocky when
 *   zoomed in (live-reported the same day: "when I zoom in you can see a
 *   pixelated look"). `buildSmoothTexelUv` (the SAME C2 reconstruction the
 *   body pack already uses, for the same reason) needs this to correct it.
 * @returns {{absorbMaterial:*, inscatterMaterial:*, debugMaterial:*, maskTexNode:*, maskTexNodes:Array<*>,
 *   bodyTexNode:*|null, flowPackTexNode:*, waterSimTexNode:*,
 *   setMaskRect:(r:object)=>void, setTint:(rgb:readonly number[])=>void,
 *   setOpacity:(v:number)=>void, setDepth:(v:number)=>void, setPollution:(v:number)=>void,
 *   setExpectedDepth:(v:number)=>void,
 *   setDebugChannel:(n:number)=>void, floorGateCompiled:boolean, tier:number}} TWO
 *   materials for the shipping draw, plus a THIRD (`debugMaterial`) no mesh shows
 *   until `setDebugChannel` picks a channel > 0 — see `water.js#WATER_DEBUG_CHANNELS`
 *   and the instrument's own comment above the `return` below. The caller draws
 *   `absorbMaterial` first, then `inscatterMaterial`. `bodyTexNode` is `null` below
 *   tier 1 (never sampled, so nothing to re-point on a bake regrid — callers must
 *   guard the same way `water-surface-subsystem.js#sync` does). `flowPackTexNode`
 *   and `waterSimTexNode` are NEVER null (unlike `bodyTexNode`) — see their own
 *   `args.flowPackTexture`/`args.waterSimTexture` doc.
 */
export function buildWaterSurfaceMaterial({
  THREE,
  maskTexture,
  maskRect,
  bodyTexture,
  bodyRect,
  bodyTexSize,
  tint = WATER_TIER0_TINT,
  opacity = WATER_TIER0_OPACITY,
  depth = WATER_TIER1_DEPTH,
  pollution = WATER_TIER1_POLLUTION,
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
  shadowResponse = WATER_TIER3_SHADOW_RESPONSE,
  chop = WATER_TIER3_CHOP,
  tier = WATER_DEFAULT_TIER,
  // ── THE DEPTH-AUTHORITY GATE (2026-08-15) ──────────────────────────────────
  depthTexture = null,
  // ── THE SUN-SHADOW GATE (2026-08-16) ───────────────────────────────────────
  sunShadowTexture = null,
  // ── THE FLOW PACK'S PREVIEW (2026-08-17, S2 solidity + S3 velocity) ────────
  flowPackTexture = null,
  flowPackTexSize = null,
  // ── THE SIM PACK — foam's own ping-ponged memory (2026-08-18, S5) ──────────
  waterSimTexture = null,
  waterSimTexSize = null,
  // ── TIER 4 (2026-08-16) ─────────────────────────────────────────────────
  swashFoam = WATER_TIER4_SWASH_FOAM,
  breakFoam = WATER_TIER4_BREAK_FOAM,
  caustics = WATER_TIER4_CAUSTICS,
  foamTrail = WATER_TIER4_FOAM_TRAIL,
  // ⚠️ LIVE PARAM (2026-08-24) — live-reported: foam appears on every shore
  // regardless of how the author painted the bank, and a softly-feathered
  // bank should read differently from a hard-edged one. See
  // `WATER_FOAM_EDGE_SHARPNESS_GRAD_LO/HI`'s own doc for the mechanism.
  // Default 0 — this multiplies a `mix(1, gate, this)` blend, so 0 is
  // BYTE-IDENTICAL to every previously-shipped map (the gate never engages
  // at all); only turning it up starts requiring a sharper local mask edge.
  foamEdgeSharpness = 0,
  // ── TIER 5 — REFRACTION (2026-08-23, Water-Testament.md §2.5) ───────────
  // `capturedTexture` follows the SAME "caller always supplies a real, if
  // 1×1 placeholder, texture object" contract `waterSimTexture` above already
  // documents — never null. `capturedRect`/`capturedTexSize` describe what
  // world rect that texture's own UV space maps across and its own texel
  // pitch, exactly the `bodyRect`/`bodyTexSize` shape one level up, because
  // it is the SAME kind of fact about a DIFFERENT texture.
  capturedTexture,
  capturedRect = WATER_TIER5_PLACEHOLDER_RECT,
  capturedTexSize = { width: 1, height: 1 },
  // ⚠️ LIVE PARAM (2026-08-23) — was the baked WATER_TIER5_REFRACT_PX
  // constant; see WATER_PARAMS.refractStrengthPx's own doc (water.js) for
  // why this needed to become author-tunable, not just a bigger guess.
  refractStrengthPx = WATER_TIER5_REFRACT_PX,
  // ── THE INSTRUMENT (2026-08-16, Water-Testament W0) ─────────────────────
  debugChannel = 0,
}) {
  // THE GATE. Clamped/coerced ONCE, here, so every `if (activeTier >= N)`
  // below reads a known-good integer regardless of what a caller passed —
  // Effects.md Law 4 is a JS `if` at graph-BUILD time, and a NaN or negative
  // tier reaching one would either throw mid-build or silently compile the
  // wrong rung. Nested ifs (not independent ones) below make the ladder's own
  // cumulative rule (Effects.md §2: a rung may not depend on one above it)
  // true BY CONSTRUCTION rather than by trusting the resolver's contract a
  // second time.
  const requestedTier = Number.isFinite(tier) ? Math.max(0, Math.floor(tier)) : WATER_DEFAULT_TIER;
  // ⚠️ ALSO CLAMPED TO 0 WHENEVER `bodyTexture` ISN'T READY YET (2026-08-18)
  // — live-reported the same day as the fix that caused it. Tier 1's own
  // block below calls `texture(bodyTexture, …)` unconditionally once
  // `activeTier >= 1`, and tier 4's `sampleBodyAt` closure does the same for
  // shore foam; `texture(null, …)` throws a construction-time NodeError that
  // does not just make ONE term degenerate — it fails the whole material's
  // build, and because a rebuild only fires on a TIER CHANGE
  // (`water-surface-subsystem.js`'s own `builtForTier` check), a material
  // built once against a still-loading body pack stays permanently broken
  // for the rest of the session even after the real bake lands, with no
  // further tier change ever occurring to trigger a rebuild. This became
  // reachable the same day `water-body-subsystem.js` started requiring the
  // surface's own full-resolution mask before its first bake — a genuinely
  // slower dependency than the coarse-grid copy it replaced, which widened
  // an already-existing but previously narrow race into one hit on every
  // frame. Clamping here (the ONE place every rung's own gate already reads)
  // is the same "fail toward tier 0, never toward a broken shader" contract
  // this function already promises for a non-finite tier, extended to a
  // second precondition tier 1+ genuinely needs. See
  // `feedback_check_console_before_theorizing` — the identical NodeError
  // shape, from a different missing texture, cost a long detour earlier
  // this same session.
  // ⚠️ TIER 5 GETS THE SAME TREATMENT, ONE RUNG NARROWER (2026-08-23) —
  // `capturedTexture` is genuinely `null` before `water-refraction-
  // subsystem.js` completes its first capture (that module's own JSDoc says
  // so: "the most recently captured colour, or null before the first
  // successful capture") — the exact same startup race `bodyTexture` just
  // got clamped against, one paragraph up, for the exact same reason:
  // tier 5's block below calls `texture(capturedTexture, …)` three times,
  // unconditionally, once `activeTier >= 5`, and `texture(null, …)` throws a
  // construction-time error that leaves the material permanently broken
  // until the next TIER CHANGE, not the next frame a real capture lands.
  // Falls back to 4, not 0: tiers 1-4 read nothing this subsystem provides,
  // so there is no reason to darken the whole surface while only the newest
  // rung waits on its own producer to warm up.
  //
  // ⚠️ Deliberately NOT where `WATER_TIER5_DISABLED_PENDING_SELF_CAPTURE_FIX`
  // is applied — that constant's own doc explains why: this function's job
  // is honestly constructing whatever tier it is ASKED for (every test in
  // this file's own "TIER 5" section depends on that staying true), and the
  // safety slide is a PRODUCTION WIRING decision, not a construction-time
  // one. `water-surface-subsystem.js#sync()` is where the real caller's
  // requested tier gets clamped before it ever reaches here.
  const activeTier = bodyTexture ? (requestedTier >= 5 && !capturedTexture ? 4 : requestedTier) : 0;
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
    exp,
    log,
    max,
    min,
    dot,
    mrt,
    step,
    mix,
    atan,
    pow,
    abs,
    length,
    fwidth,
    luminance,
  } = THREE.TSL;

  const uMaskRect = uniform(vec4(maskRect.minX, maskRect.minY, maskRect.maxX, maskRect.maxY));
  const uBodyRect = uniform(vec4(bodyRect.minX, bodyRect.minY, bodyRect.maxX, bodyRect.maxY));
  // TIER 5 — the world rect `capturedTexture`'s own UV space maps across
  // (`water-refraction-subsystem.js#capturedRect`, one frame stale by
  // design — see that module's header on why that needs no camera-delta
  // math), and its texel pitch, for the chromatic fringe's ±1-texel offset.
  const uCapturedRect = uniform(vec4(capturedRect.minX, capturedRect.minY, capturedRect.maxX, capturedRect.maxY));
  const uCapturedTexelUv = uniform(
    vec2(1 / Math.max(1, capturedTexSize.width), 1 / Math.max(1, capturedTexSize.height))
  );
  // ⚠️ LIVE (2026-08-23) — see `refractStrengthPx`'s own constructor-param
  // doc, a few lines up, and `WATER_PARAMS.refractStrengthPx` (water.js)
  // for why this stopped being the baked `WATER_TIER5_REFRACT_PX` constant.
  const uRefractStrengthPx = uniform(float(refractStrengthPx));
  const uTint = uniform(vec3(tint[0], tint[1], tint[2]));
  const uOpacity = uniform(float(opacity));
  const uDepth = uniform(float(depth));
  const uPollution = uniform(float(pollution));
  const uAbsorption = uniform(float(absorption));
  const uDepthScalePx = uniform(float(depthScalePx));
  const uInscatter = uniform(float(inscatterAmount));
  // THE FOUR REFERENCE COLOURS, decoded ONCE per material build via the ONE
  // shared hex decoder — never author-tunable, so plain node constants
  // (not uniforms): nothing ever pushes a new `.value` at them.
  const clearShallowRgb = hexToRgb01(WATER_COLOR_CLEAR_SHALLOW_HEX);
  const clearDeepRgb = hexToRgb01(WATER_COLOR_CLEAR_DEEP_HEX);
  const pollutedShallowRgb = hexToRgb01(WATER_COLOR_POLLUTED_SHALLOW_HEX);
  const pollutedDeepRgb = hexToRgb01(WATER_COLOR_POLLUTED_DEEP_HEX);
  const colorClearShallow = vec3(clearShallowRgb[0], clearShallowRgb[1], clearShallowRgb[2]);
  const colorClearDeep = vec3(clearDeepRgb[0], clearDeepRgb[1], clearDeepRgb[2]);
  const colorPollutedShallow = vec3(pollutedShallowRgb[0], pollutedShallowRgb[1], pollutedShallowRgb[2]);
  const colorPollutedDeep = vec3(pollutedDeepRgb[0], pollutedDeepRgb[1], pollutedDeepRgb[2]);
  // `depth` RESCALES how aggressively the ladder's own absorption/in-scatter
  // read (Water-Testament §3.3's named ranges) — it does not replace
  // `absorption`/`inscatter`, which stay real ROH trims on top.
  const depthAbsorptionScale = mix(
    float(WATER_DEPTH_ABSORPTION_RANGE[0]),
    float(WATER_DEPTH_ABSORPTION_RANGE[1]),
    uDepth
  );
  const depthInscatterScale = mix(float(WATER_DEPTH_INSCATTER_RANGE[0]), float(WATER_DEPTH_INSCATTER_RANGE[1]), uDepth);
  // `pollution` adds ITS OWN murk on top — sludge is harder to see through per
  // world-px independent of how deep the body reads overall.
  const pollutionAbsorptionScale = mix(
    float(WATER_POLLUTION_ABSORPTION_RANGE[0]),
    float(WATER_POLLUTION_ABSORPTION_RANGE[1]),
    uPollution
  );
  // The SINGLE representative colour absorption reads its hue from — a
  // material property of the water, not something that should vary shallow-
  // to-deep within one body. `tint` blends in as a genuine minority trim
  // (`WATER_TINT_TRIM_WEIGHT`), never the primary source again.
  const derivedDeepColor = mix(colorClearDeep, colorPollutedDeep, uPollution);
  const sigmaColorSource = mix(derivedDeepColor, uTint, float(WATER_TINT_TRIM_WEIGHT));
  const uWaveScalePx = uniform(float(waveScalePx));
  const uFlowSpeedPx = uniform(float(flowSpeedPx));
  // ROH TUNING (2026-08-19) — `bankWarp`/`flowWarp`'s own influence weights,
  // now author-adjustable rather than baked-in constants. See
  // `WATER_BANK_INFLUENCE`/`WATER_FLOW_WARP_INFLUENCE`'s own doc
  // (`water-field.js`) for the safety argument this does not change: both
  // stay a FIXED per-frame multiplier, never scaled by time, whatever value
  // the slider holds.
  const uBankInfluence = uniform(float(WATER_BANK_INFLUENCE));
  const uFlowWarpInfluence = uniform(float(WATER_FLOW_WARP_INFLUENCE));
  // THE FLOW, AS A VECTOR — converted from the author's compass bearing on the
  // CPU (`waterFlowVector`), never as `cos`/`sin` in the shader. That is where a
  // Y-flip hides, and this project has paid for one five times; a plain JS
  // function is something a Node test can pin against all eight cardinals.
  const flow0 = waterFlowVector(flowAngleDeg);
  const uFlowDir = uniform(vec2(flow0[0], flow0[1]));
  const uFoam = uniform(float(foam));
  // THE BODY PACK's OWN SIZE IN TEXELS — for the smooth (C2) reconstruction
  // that stops its ~21-world-px grid from creasing every steep read downstream
  // (`water-sampling.js`). Seeded at the real grid the caller has, and re-pushed
  // on every regrid; 1×1 is only ever the pre-first-bake placeholder, which is
  // never sampled because the mesh is hidden until a bake lands.
  const uBodyTexSize = uniform(vec2(bodyTexSize?.[0] ?? 1, bodyTexSize?.[1] ?? 1));
  // THE FLOW PACK's OWN SIZE IN TEXELS (2026-08-19) — same reasoning as
  // `uBodyTexSize`/`uWaterSimTexSize`, for the same C2 reconstruction —
  // `flowPackTexSize` param's own doc has the live-reported symptom.
  const uFlowPackTexSize = uniform(vec2(flowPackTexSize?.[0] ?? 1, flowPackTexSize?.[1] ?? 1));
  // THE SIM PACK's OWN SIZE IN TEXELS (S5, 2026-08-18) — same reasoning as
  // `uBodyTexSize` immediately above, for the same C2 reconstruction, now
  // that the pack it corrects is read post-threshold (see `waterSimTexSize`
  // param's own doc for why a coarse grid needed this only once foam became
  // sharp-edged rather than smooth).
  const uWaterSimTexSize = uniform(vec2(waterSimTexSize?.[0] ?? 1, waterSimTexSize?.[1] ?? 1));
  const uChop = uniform(float(chop));
  const uTurbidity = uniform(float(WATER_TIER2_TURBIDITY));
  // ── TIER 4 (2026-08-16) ─────────────────────────────────────────────────
  const uSwashFoam = uniform(float(swashFoam));
  const uBreakFoam = uniform(float(breakFoam));
  const uCaustics = uniform(float(caustics));
  // ROH TUNING (2026-08-27) — caustics' own look controls, live uniforms, no
  // rebake needed, same shape as `uBankInfluence`/`uFlowWarpInfluence` above.
  // See `water-field.js#WATER_CAUSTICS_SCALE`/`_SHARPNESS`/`_NETTING`'s own
  // docs for the mechanism each one drives.
  const uCausticSharpness = uniform(float(WATER_CAUSTICS_SHARPNESS));
  const uCausticScale = uniform(float(WATER_CAUSTICS_SCALE));
  const uCausticNetting = uniform(float(WATER_CAUSTICS_NETTING));
  const uFoamTrail = uniform(float(foamTrail));
  const uFoamEdgeSharpness = uniform(float(foamEdgeSharpness));
  // THE FOAM BAND's REACH, derived from the author's own `depthScalePx` on the
  // CPU — see `water-shore.js#WATER_FOAM_SHORE_FRACTION` for why a fraction of a
  // body-scale length rather than a bare pixel constant is the entire answer to
  // "ponds through ocean shorelines". Re-derived in `setDepthScalePx` so the two
  // can never disagree about the body's size.
  const uFoamReachPx = uniform(float(waterFoamReachPx(depthScalePx)));
  // ROH TUNING (2026-08-19) — `buildFoamCellularStructure`'s own knobs, one
  // shared set of uniforms feeding BOTH shore foam and sim-foam structure
  // (the same "one registry, not two independently-drifting copies" rule
  // `field.domainOffset` itself already follows).
  const uFoamFlowNudge = uniform(float(WATER_FOAM_FLOW_NUDGE));
  const uFoamEdgeFar = uniform(float(WATER_FOAM_EDGE_FAR));
  const uFoamEdgeAaPx = uniform(float(WATER_FOAM_EDGE_AA_PX));
  const uFoamBubbleAmount = uniform(float(WATER_FOAM_BUBBLE_AMOUNT));
  const uFoamBubbleOctave = uniform(float(WATER_FOAM_BUBBLE_OCTAVE));
  const uFoamBubbleTimeScale = uniform(float(WATER_FOAM_BUBBLE_TIME_SCALE));
  const uFoamGrainAmount = uniform(float(WATER_FOAM_GRAIN_AMOUNT));
  const uFoamGrainOctave = uniform(float(WATER_FOAM_GRAIN_OCTAVE));
  const uFoamGrainTimeScale = uniform(float(WATER_FOAM_GRAIN_TIME_SCALE));
  const foamStructureUniforms = {
    uFlowNudge: uFoamFlowNudge,
    uEdgeFar: uFoamEdgeFar,
    uEdgeAaPx: uFoamEdgeAaPx,
    uBubbleAmount: uFoamBubbleAmount,
    uBubbleOctave: uFoamBubbleOctave,
    uBubbleTimeScale: uFoamBubbleTimeScale,
    uGrainAmount: uFoamGrainAmount,
    uGrainOctave: uFoamGrainOctave,
    uGrainTimeScale: uFoamGrainTimeScale,
  };
  // ROH TUNING (2026-08-19) — the sim-foam clump/break threshold, display-
  // time only (`water-sim.js`'s own header on why these are never fed back
  // into the stored accumulator).
  const uSimClumpLo = uniform(float(WATER_SIM_CLUMP_LO));
  const uSimClumpHi = uniform(float(WATER_SIM_CLUMP_HI));
  const uSimClumpAaPx = uniform(float(WATER_SIM_CLUMP_AA_PX));
  const uWetBandPx = uniform(float(wetBandPx));
  const uWetStrength = uniform(float(wetStrength));
  // THE INSTRUMENT's OWN SELECTOR — never a param (see `water.js#
  // WATER_DEBUG_CHANNELS`'s header), pushed by the caller from render state
  // beside `enabled`. 0 means "the caller never re-points this", which is
  // exactly the `debugMaterial` OFF state — see `setDebugChannel`.
  const uDebugChannel = uniform(float(debugChannel));
  // The upper edge of the presence band is authorable (WATER_PARAMS
  // `shorelineDepth`); the lower edge is not — it is the "is anything painted
  // here at all" floor, and exposing a knob that can be raised above the upper
  // edge would let the author invert the ramp into a hard edge by accident.
  const uPresenceEdge1 = uniform(float(WATER_PRESENCE_EDGE1));
  // THE DEPTH-AUTHORITY GATE's OWN EXPECTED DEPTH (2026-08-15) —
  // `computeTieSafeExpectedDepth`'s result for THIS floor's own background
  // item's rank, pushed by `setExpectedDepth` every sync, the exact shape
  // `window-render.js`'s own `uExpectedDepth` uses. Defaults to 0: with the
  // depth texture cleared to the far plane (1) until the first real depth
  // pass runs, `depthHere(1) >= uExpectedDepth(0)` always holds, so an
  // unwired/not-yet-synced caller fails OPEN (water draws) — never a global
  // blackout from an upstream failure.
  const uExpectedDepth = uniform(float(0));

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
  // ⚠️ EVERY `texture(maskTexture, …)` NODE THIS FUNCTION BUILDS MUST LAND IN
  // THIS ARRAY (2026-08-17, `feedback_texture_nodes_must_be_repointed_
  // together`). The material is built against a 1×1 PLACEHOLDER
  // (`water-surface-subsystem.js`'s own `createMaskTexture` call) and the
  // real image re-points asynchronously — `water-body.js#prevTexNodes`
  // already names the rule ("EVERY node must be re-pointed together"); this
  // is the site that broke it. A node created and never pushed here samples
  // the placeholder FOREVER, silently, and reads as "confidently land" —
  // exactly the bug that turned the author's river solid white.
  const maskTexNodes = [maskTexNode];

  // ── WATER STOPS AT THE EDGE OF THE MAP (2026-08-16) ──────────────────────
  // Author, live, with an arrow drawn at a band of water sitting in the black
  // ABOVE the map art: *"I also noticed that water can appear outside the
  // bounds of the actual map."*
  //
  // ⚠️ **A UV CLAMP IS NOT A BOUNDARY — IT IS AN EXTRUSION.** The two lines
  // above clamp `maskU/maskV` into 0..1 so the fetch stays legal, and that is
  // all a clamp can do: outside the rect it keeps returning the EDGE row's
  // value. Where a river runs off the top of the map, the mask's top row reads
  // "water" all the way across, so the clamp smears that row upward across the
  // full width for as far as the mesh reaches — and the mesh reaches
  // `WATER_BOUNDS_PAD_PX` (64 px) past the measured water AABB, which at the
  // map's edge is 64 px past the map. Clamping the geometry (done, same day, in
  // `water-body-subsystem.js`) fixes the case that was reported; this fixes the
  // CLASS, because the mesh is only one of the ways a fragment can land outside
  // the authored rect — a mask rect narrower than the body rect would do it
  // too, and so would any future rung that widens the quad.
  //
  // MEMBERSHIP, NOT A THRESHOLD (`feedback_membership_beats_derived_threshold`):
  // "is this world point inside the authored rect" is a question the rect can
  // answer exactly, so it is asked directly rather than inferred from what the
  // clamped sample happened to return. `step` twice per axis, no branch, and
  // the boundary is the rect's own edge with no inset — the outermost texel is
  // real authored data, and CLAMP_TO_EDGE returns it faithfully; it is only
  // BEYOND the rect that the clamp starts inventing.
  const inRect = step(float(0), maskU)
    .mul(step(maskU, float(1)))
    .mul(step(float(0), maskV))
    .mul(step(maskV, float(1)));

  // ── FLOW PACK: `res:waterFlow` (2026-08-17, S2 solidity + S3 velocity) ──
  // The finished pack — RG velocity (normalised, free-stream speed = 1.0), B
  // speed01, A solidity — baked at the flow grid's own (coarser) resolution.
  // Sampled ONCE, HERE, moved up from beside the debug channels (2026-08-18,
  // S4) so S4's real consumers (swash/break/streak, tier 4 below) and the
  // flowSolidity/flowVelocity debug channels read the IDENTICAL fetch, never
  // two independently-drifting copies
  // (`feedback_shared_field_two_meanings_two_registries`).
  //
  // SAME world→UV formula as `maskU`/`maskV`: the flow grid covers the
  // IDENTICAL rect the mask image does (`water-flow-subsystem.js` bakes over
  // `waterBody.getRect()`, the exact rect `uMaskRect` already holds).
  //
  // ⚠️ `flowPackTexNode` MUST STAY A RAW `texture()` NODE, NEVER a derived
  // expression under this same name — LIVE REGRESSION, 2026-08-18: a
  // `.mul(inRect)` membership gate was once assigned back onto this exact
  // name and silently broke `water-surface-subsystem.js#setFlowPackTexture`'s
  // own re-point (`.mul()` returns a node with no real `.value` setter —
  // production sampled the placeholder forever, reading black; author: "The
  // flow pack velocity debug layer is black for me"). The membership gate
  // lives on the SEPARATE `flowPackGated` below instead — every consumer
  // that must respect "is this pixel actually inside the water body's own
  // rect" reads `flowPackGated`, never `flowPackTexNode` directly. (S4's own
  // terms below are already shore-gated by `insideWater`/`d01` independently
  // — reading the gated pack too is defensive belt-and-braces, not load-
  // bearing, since a shore-band pixel is inside this same rect by
  // construction.)
  // ⚠️ C2 SMOOTH-TEXEL RECONSTRUCTION (2026-08-19) — the SAME `buildSmoothTexelUv`
  // fix `waterSimTexNode` below already needed for the identical author-reported
  // symptom, applied here for the identical reason: plain bilinear was fine while
  // this pack only fed foam SHAPE (a forgiving consumer), but `flowWarp`/the foam
  // flow-nudge (`water-field.js`/`water-shore.js`, same day) now perturb the base
  // surface and foam sample POSITION directly from this coarse grid, which is
  // exactly what makes a coarse texture's own texel grid visible at zoom. Still a
  // raw `texture()` node — the UV argument is transformed, not the return value —
  // so `setFlowPackTexture`'s own re-point (this exact node's `.value` setter)
  // stays intact, the same non-negotiable property its own header above states.
  const flowPackTexNode = texture(
    flowPackTexture,
    buildSmoothTexelUv(THREE.TSL, {
      uvNode: vec2(clamp(maskU, 0, 1), clamp(maskV, 0, 1)),
      uTexSize: uFlowPackTexSize,
    })
  );
  const flowPackGated = flowPackTexNode.mul(inRect);

  // ── SIM PACK: `res:waterSim` (2026-08-18, S5) ───────────────────────────
  // Foam's own per-frame memory — R is the RAW accumulator this pass reads
  // and ping-pongs every frame (`water-sim.js`'s own header on why it is
  // stored unclamped, not display-ready). SAME world→UV formula as
  // `maskU`/`maskV`/`flowPackTexNode`: the sim grid matches the flow pack's
  // own finest level exactly (`water-sim-subsystem.js`'s own citation),
  // which covers the IDENTICAL rect the mask image does.
  //
  // ⚠️ SMOOTH (C2) RECONSTRUCTION, NOT PLAIN BILINEAR LIKE `flowPackTexNode`
  // — live-reported the same day: "when I zoom in you can see a pixelated
  // look". `flowPackTexNode` gets away with a bare bilinear sample because
  // velocity is a smooth field with no sharp edges away from a solid
  // boundary (`water-flow.js`'s own header); THIS pack, read post-threshold
  // (`waterSimFoam` below), is not — a `smoothstep` deliberately produces a
  // sharp-edged clumpy field, and sampling a coarse grid's sharp edges with
  // plain bilinear is exactly what reads as blocky when the camera is close.
  // `buildSmoothTexelUv` is the SAME C2 fix `bodyTexNode` already uses for
  // its own coarse grid, reused rather than re-derived.
  //
  // ⚠️ `waterSimTexNode` MUST STAY A RAW `texture()` NODE, NEVER a derived
  // expression under this same name — same rule, same live-regression scar,
  // as `flowPackTexNode` immediately above: `water-surface-subsystem.js
  // #setWaterSimTexture`'s own re-point needs a real `.value` setter, which
  // only a bare `texture()` node has. Every transform (the membership gate,
  // the display-time clump threshold) lives on `waterSimFoam` below instead
  // — the smooth reconstruction is safe to bake into the UV itself, same as
  // `bodyTexNode`'s own `bodyUv`, because it only reshapes WHERE inside the
  // texture is sampled, never wraps the sampled RESULT in a derived node.
  const waterSimTexNode = texture(
    waterSimTexture,
    buildSmoothTexelUv(THREE.TSL, {
      uvNode: vec2(clamp(maskU, 0, 1), clamp(maskV, 0, 1)),
      uTexSize: uWaterSimTexSize,
    })
  );
  // THE CLUMP/BREAK THRESHOLD, APPLIED HERE — this is the "whichever CONSUMER
  // reads this pack for display" `water-sim.js`'s own header names as the
  // threshold's rightful home, now that it exists. `smoothstep` turns the
  // raw, smoothly-accumulating memory into the clumpy, torn-apart look the
  // author asked for; `inRect` is the SAME membership gate `flowPackGated`
  // already applies, for the same reason (belt-and-braces against a stray
  // sample beyond the water body's own rect).
  // ⚠️ ANTI-ALIASED (2026-08-19) — `WATER_SIM_CLUMP_AA_PX`'s own doc, same
  // technique and reason as `water-shore.js#WATER_FOAM_EDGE_AA_PX`. The
  // band's own CENTRE never moves — only its half-width, floored by
  // `fwidth`, so the clump/break threshold's own calibrated MIDPOINT is
  // unchanged and only the transition's screen-space smoothness improves.
  const clumpCenter = uSimClumpLo.add(uSimClumpHi).mul(float(0.5));
  const clumpHalfWidth = max(
    uSimClumpHi.sub(uSimClumpLo).mul(float(0.5)),
    fwidth(waterSimTexNode.r).mul(uSimClumpAaPx.mul(float(0.5)))
  );
  const waterSimFoam = smoothstep(
    clumpCenter.sub(clumpHalfWidth),
    clumpCenter.add(clumpHalfWidth),
    waterSimTexNode.r
  ).mul(inRect);

  // The raw local direction plus a DIVIDE-BY-ZERO-GUARDED unit direction.
  const localVel = vec2(flowPackGated.r, flowPackGated.g);
  const localSpeed = length(localVel);
  const localDirSafe = localVel.div(max(localSpeed, float(1e-4)));
  // ⚠️ NO FALLBACK TO THE GLOBAL BULK DIRECTION (removed 2026-08-19, author's
  // explicit, repeated instruction: "get rid of the escape hatch... either
  // flow works or breaks, no fallbacks"). This USED TO `mix` back to
  // `uFlowDir` below a small dead-zone on normalised local speed — real
  // river speeds measured comfortably clear of it (0.8-0.98 on the bench's
  // own synthetic river, ~40-50x the old 0.02 threshold), so the fallback
  // was already a rare-case safety net, not the common path. Now every S4
  // consumer (shore foam, sim-foam structure, `flowWarp`) reads the SOLVE
  // directly, always. Honest cost, not hidden: at a texel where local
  // velocity is exactly/near zero — dead centre of a solid, or a texel the
  // bake has not reached yet — `localDirSafe` reads as a degenerate
  // near-zero vector rather than gracefully defaulting to the compass. In
  // practice this mostly lands on pixels already masked out elsewhere
  // (solid/obstacle texels do not render as open foam), but it is a real
  // behaviour change, on the record rather than papered over.
  const localFlowDirSafe = localDirSafe;

  // THE SHORELINE. A narrow threshold on the LINEAR-filtered high-res mask, so
  // the crispness is the file's own and the ramp is whatever the author
  // painted — see WATER_PRESENCE_EDGE0/1 for why this is a threshold rather
  // than using the value directly.
  //
  // ⚠️ SCREEN-SPACE AA FLOOR (2026-08-19) — `WATER_PRESENCE_EDGE_AA_PX`'s own
  // doc: the upper edge is never narrower than a few real screen pixels,
  // whichever is wider, the author's own calibrated ramp or what THIS frame's
  // zoom needs. Never narrower than `uPresenceEdge1` itself — only ever widens.
  const presenceEdge1AA = max(uPresenceEdge1, fwidth(maskTexNode.r).mul(float(WATER_PRESENCE_EDGE_AA_PX)));
  //
  // `inRect` multiplies in HERE, at the single definition of "is there water at
  // this pixel", rather than at the two composites — so every downstream term
  // (depth, foam, in-scatter, the reflection, and the wet band via `1 − inside`)
  // inherits the boundary from one place instead of four that could drift.
  const inside = smoothstep(float(WATER_PRESENCE_EDGE0), presenceEdge1AA, maskTexNode.r).mul(inRect);

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
    // ⚠️ SMOOTH (C2) RECONSTRUCTION, NOT PLAIN BILINEAR (2026-08-16) — see
    // `water-sampling.js` for the author-reported staircase edges this removes
    // and for why a finer field is the wrong fix. The remap passes exactly
    // through every texel centre, so no distance this pack reports changes; only
    // the CREASES between texels do, and it is those the steep reads below (a
    // 34 px wet band over ~1.6 texels, the foam crest, tier 3's GGX lobe) were
    // amplifying into visible edges. Costs no extra fetch.
    const bodyUv = buildSmoothTexelUv(THREE.TSL, {
      uvNode: vec2(clamp(bodyU, 0, 1), clamp(bodyV, 0, 1)),
      uTexSize: uBodyTexSize,
    });
    // The NODE is kept, not just its `.r` — the caller re-points `.value` when a
    // regrid recreates the target, and a swizzle cannot be re-pointed.
    bodyTexNode = texture(bodyTexture, bodyUv);
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
    //
    // ⚠️ `inRect` HAS TO BE APPLIED SEPARATELY HERE, and only here. Every other
    // term inherits the map boundary through `inside`; this one reads
    // `1 − inside`, which is 1 exactly where `inside` is 0 — so folding the
    // boundary into `inside` alone would have left the damp-ground band as the
    // ONE term still free to draw past the edge of the map, which is the same
    // bug wearing its own inverse (`feedback_gate_and_self_exclusion_answer_
    // different_questions`).
    wetBand = float(1)
      .sub(smoothstep(float(0), max(uWetBandPx, float(1)), sdf))
      .mul(float(1).sub(inside))
      .mul(inRect)
      .mul(uWetStrength);
  }

  // ── THE DEPTH×POLLUTION COLOUR RAMP (2026-08-17, Water-Testament S1) ─────
  // `structuralDepth01` is the mask's own painted brightness times the
  // GEOMETRIC shore taper (`depthRamp`, neutral 1 below tier 1) — the
  // author's literal instruction ("treat the brightness of the mask as the
  // depth") taken as far as it can honestly go before the ladder adds a real
  // taper on top. Deliberately WITHOUT `opacity`/`turbid` (unlike `depth01`
  // below): those answer "how much LAW effect", this answers "how deep does
  // this pixel structurally read" — a colour question, not an optics one.
  const structuralDepth01 = maskTexNode.r.mul(depthRamp).mul(inside);
  const waterColorRamp = mix(
    mix(colorClearShallow, colorClearDeep, structuralDepth01),
    mix(colorPollutedShallow, colorPollutedDeep, structuralDepth01),
    uPollution
  );
  // Same minority `tint` trim as the absorption colour, so a hand-tune nudges
  // the WHOLE look consistently rather than just the deep read.
  const inscatterColorSource = mix(waterColorRamp, uTint, float(WATER_TINT_TRIM_WEIGHT));

  // ── BEER–LAMBERT, PER CHANNEL — pure ALU on `sigmaColorSource`/`uAbsorption`
  // uniforms, never a texture read, so σ costs the same at every tier and
  // stays outside the gate above. What the gate controls is `depthRamp`,
  // which σ is about to be multiplied against via `depth01` below.
  //
  // σ_rgb = absorption · −log(colour) / mean(−log colour), i.e. THE COLOUR IS
  // READ AS A TRANSMITTANCE COLOUR. The first version used `1 − tint`, which
  // is the same idea and far too weak to see: on the default tint it spreads
  // the channels only ±14%, and `exp()` then flattens what little spread
  // there was, making the per-channel result numerically indistinguishable
  // from the scalar one it replaced. `−log` is the relationship Beer–Lambert
  // actually inverts and it nearly doubles the spread (red:blue 1.9× against
  // 1.27×), which is the difference between a hue shift you can see and one
  // only the maths knows about.
  //
  // ⚠️ 2026-08-17: THE FLAT `uTint` THAT USED TO FEED THIS IS WHY IN-SCATTER
  // (below) READ AS PAINT — see that term's own updated comment. σ itself
  // stays keyed to ONE representative colour on purpose (absorption is a
  // material property of the water, not something that should vary shallow-
  // to-deep within a single body) — `sigmaColorSource` is that colour, now
  // DERIVED from `pollution` (a material fact) plus a minority `tint` trim,
  // instead of `tint` alone.
  //
  // Normalising by the mean keeps "how deep it reads" and "what colour it is"
  // independent controls — see WATER_TIER1_ABSORPTION. Both floors are load
  // bearing: the inner one stops `log(0)` on a pure black colour, and the
  // outer one stops a 0/0 on a pure WHITE colour, which correctly yields
  // σ = 0 — colourless water that absorbs nothing and is simply invisible.
  const absorbHue = log(max(sigmaColorSource, vec3(2e-3, 2e-3, 2e-3))).negate();
  const absorbMean = max(dot(absorbHue, vec3(1 / 3, 1 / 3, 1 / 3)), float(1e-4));
  // `depth`/`pollution` RESCALE the magnitude (Water-Testament §3.3); `absorption`
  // stays a real ROH trim multiplying the same result, exactly as before.
  const sigma = absorbHue.div(absorbMean).mul(uAbsorption).mul(depthAbsorptionScale).mul(pollutionAbsorptionScale);
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
  let field = {
    foam: float(0),
    turbidity: float(0),
    slope: null,
    domainOffset: vec2(0, 0),
    flowWarp: vec2(0, 0),
    causticBrightness: float(0),
  };
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
      uFlowDir,
      uFoam,
      // TIER 3's WAVE NORMAL rides tier 2's fetch — see `water-light.js`'s
      // header for why its absence made rung 3 measure invisible. Passed here
      // rather than inside the tier-3 block below because the FETCH belongs to
      // tier 2; only its third reading is tier 3's.
      uChop,
      // THE REAL SOLVED LOCAL DIRECTION, already computed above (with the
      // dead-zone fallback baked in) for shore foam's own `localFlowDir` —
      // reused here rather than re-derived, same discipline as
      // `field.domainOffset` itself being reused by tier 4's filament foam.
      // This is what lets `buildWaterSurfaceField`'s new `flowWarp`
      // (`WATER_FLOW_WARP_INFLUENCE`'s own doc) bend the BASE surface near
      // an obstacle instead of only foam's shape/orientation.
      localFlowDir: localFlowDirSafe,
      uBankInfluence,
      uFlowWarpInfluence,
      uCausticSharpness,
      uCausticScale,
      uCausticNetting,
      // TIER 4's SHOALING AND CAUSTICS ALSO RIDE TIER 2's FETCH — see
      // `water-field.js`'s own header on why both must live inside this call
      // rather than in a separate `if (activeTier >= 4)` block: shoaling has to
      // amplify slope BEFORE tier 3 (built next) reads it, and caustics needs
      // the SAME warped domain plus two more taps of it. Plain JS booleans,
      // Effects.md Law 4 — below tier 4 neither branch is even entered.
      shoaling: activeTier >= 4,
      caustics: activeTier >= 4,
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
  // Three changes keep it honest AND keep it water:
  //   · `absorption` now defaults to a value that leaves the bed VISIBLE, which
  //     is what makes the multiply mean anything (see WATER_TIER1_ABSORPTION).
  //   · in-scatter is scaled by its own control, defaulting well below 1. Real
  //     shallow water returns very little light toward a viewer directly above
  //     it; a full-strength term is a deep-ocean look applied to a ford.
  //   · ⚠️ 2026-08-17 — THE REAL FIX. The two points above make the CONSTANT
  //     smaller; they cannot stop it being a constant, because it was reading
  //     one flat `uTint` regardless of position. Once `depth01` saturates
  //     (any confidently-painted open water, which is most of a real river's
  //     surface), `1 − mean(bedTransmit)` saturates to 1 too, and the WHOLE
  //     term collapses to `uTint × uInscatter` — a single colour painted over
  //     everything, independent of how deep THAT pixel actually reads. That is
  //     "opaque blue paint" by construction, and no amount of retuning
  //     `absorption`/`inscatter` can fix a term that no longer has position in
  //     it once saturated. The fix is not a smaller constant, it is not a
  //     constant: `inscatterColorSource` (`waterColorRamp` + the `tint` trim,
  //     above) varies with `structuralDepth01` AND `pollution` at every pixel,
  //     so even fully saturated in-scatter still reads shallow-pale near the
  //     bank and deep-dark mid-channel instead of one flat wash.
  //
  // Keyed off the transmittance BEFORE the wet band touches it, so damp ground
  // (which has no volume above it) can never in-scatter — the precise line
  // where the blue-margin bug lived.
  const inscatter = inscatterColorSource
    .mul(float(1).sub(dot(bedTransmit, vec3(1 / 3, 1 / 3, 1 / 3))))
    .mul(uInscatter)
    .mul(depthInscatterScale);

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
    setShadowResponse() {},
    setSunShadowRect() {},
    setSunShadowMix() {},
    outdoorsGateCompiled: false,
    normalCompiled: false,
    sunShadowCompiled: false,
    sunShadowTexNode: null,
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
      shadowResponse,
      // THE SUN-SHADOW GATE (2026-08-16). A JS-time branch, Law 4: with no
      // field texture the whole lookup is compiled OUT, and the rung renders
      // exactly as it did before shadows reached water. `Water.md` §7 has
      // listed "sun occlusion" as one of water's seven handles since the design
      // was written, and tier 3's own ladder row says "gated by
      // `buf:scene.illum` and `buf:scene.vis`" — this is the half of that row
      // that shipped missing.
      sunShadowTexture,
      // THE WAVE NORMAL. Non-null here by construction — rungs are cumulative,
      // so reaching tier 3 means tier 2 built the field above. Passing it is
      // what separates a visible rung from the flat 0.0084 wash this shipped
      // as; `water-light.js`'s header carries the measurement.
      slopeXY: field.slope,
    });
  }

  // ── TIER 4: SHORE — swash + break foam, on top of tier 2's own crest foam ─
  // Shoaling and caustics are ALREADY DONE (they rode tier 2's own fetch
  // above — see that call site's comment for why). Shoreline foam is the one
  // piece of tier 4 with no upstream dependency, so it is the one piece that
  // genuinely belongs in its own `if` block, the same shape tiers 1-3 use.
  //
  // ⚠️ NEUTRAL below tier 4: `float(0)`, so `totalFoam` below is byte-
  // identical to tier 2/3's own `field.foam` when this tier is not affordable
  // — Law 2's "adds, never substitutes" made checkable the same way tier 3's
  // stub object makes ITS absence checkable.
  // ⚠️ THE WHOLE OBJECT IS KEPT, not just `.foam` — `d01`/`lace`/`swashBand`/
  // `breakFacing` are dead weight to the shipping render but are exactly the
  // four taps `WATER_DEBUG_CHANNELS` needs to localise a dead term the way
  // this rung's own two 2026-08-16 bugs would have been caught in minutes
  // instead of a live report. The neutral defaults below (all `float(0)`,
  // i.e. "at the waterline / no structure / no wave / facing away") describe
  // the same "this term does not exist yet" state the debug channels' own
  // "reads" text promises below tier 4.
  let shore = {
    foam: float(0),
    breakOnly: float(0),
    tailOnly: float(0),
    d01: float(0),
    lace: float(0),
    swashBand: float(0),
    breakFacing: float(0),
  };
  if (activeTier >= 4) {
    shore = buildWaterShoreFoam({
      TSL: THREE.TSL,
      worldXY: vec2(positionWorld.x, positionWorld.y),
      timeMsNode: timeMsNode ?? float(0),
      // The SAME safe domain shift tier 2's own fetch used — see
      // `water-shore.js`'s header for why re-deriving this independently
      // (even correctly) would be a second copy of a thing this file has
      // already shipped two bugs in.
      domainOffset: field.domainOffset,
      // THE SHORE NORMAL's SOURCE — break foam rotates this tangent 90° to ask
      // "is the current heading into my nearest bank". Non-null here by
      // construction: rungs are cumulative, so reaching tier 4 means tier 1
      // built `bodyTexNode`.
      tangentXY: vec2(bodyTexNode.b, bodyTexNode.a),
      flowDir: uFlowDir,
      // S4 (2026-08-18) — the REAL solved local direction/speed, already
      // sampled once above (with the bank/solid fallback baked in) and
      // reused here rather than re-derived. See `water-shore.js`'s own S4
      // header block for exactly which three terms this reaches and why the
      // rest (the domain offset, the tail's march) deliberately stay global.
      localFlowDir: localFlowDirSafe,
      localSpeed01: flowPackGated.b,
      shoreDist,
      insideWater: inside,
      uReachPx: uFoamReachPx,
      uSwash: uSwashFoam,
      uBreak: uBreakFoam,
      uTrail: uFoamTrail,
      foamStructureUniforms,
      // THE TAIL'S BODY-PACK TAP. Built HERE because this is where the body
      // rect, the grid size and the smooth (C2) reconstruction all already
      // live — `water-shore.js` re-deriving any of that would be a second copy
      // of the mapping this file has already shipped bugs in. Takes a WORLD
      // offset so the caller never has to know the UV convention at all.
      sampleBodyAt: (offsetXY) => {
        const at = vec2(positionWorld.x.add(offsetXY.x), positionWorld.y.add(offsetXY.y));
        const u = at.x.sub(uBodyRect.x).div(uBodyRect.z.sub(uBodyRect.x));
        const v = at.y.sub(uBodyRect.y).div(uBodyRect.w.sub(uBodyRect.y));
        // ⚠️ CLAMPED, and here the clamp is CORRECT rather than an extrusion
        // (`feedback_uv_clamp_is_an_extrusion_not_a_boundary`): a tap that
        // marches off the body rect is asking about water outside the baked
        // field, and the edge texel's own "no shore near here" answer is the
        // honest one. Nothing downstream treats it as membership — `inside`,
        // at THIS pixel, is what gates the result.
        return texture(
          bodyTexture,
          buildSmoothTexelUv(THREE.TSL, {
            uvNode: vec2(clamp(u, 0, 1), clamp(v, 0, 1)),
            uTexSize: uBodyTexSize,
          })
        );
      },
    });
  }
  // ⚠️ BOTH 8-TAP OBSTACLE-RING SYSTEMS REMOVED 2026-08-18, author's explicit
  // repeated request ("get rid of the damn eight tap... I keep asking you to
  // get rid of it and you don't"). First round removed only `obstacleFoam`
  // (read `buf:scene.depth`, so it lit up around overhead tiles too) and kept
  // this one — `maskProximityFoam` — reasoning it couldn't react to tiles
  // since it read the water's own mask, not the depth buffer. That reasoning
  // was true but beside the point: the author reported "still the same 8 tap
  // white edges" AFTER that removal, with browser caching explicitly ruled
  // out on their end, and their own live session confirmed running at the
  // `extreme` profile — so tier 4 was active and this block had been
  // rendering, completely unchanged, through the whole first round. Same
  // visual signature (a ring around every obstacle painted into the water
  // mask, piers included), different data source, same "eight tap" the
  // author was naming. Gone now, along with `WATER_OBSTACLE_RING_TAPS`/
  // `WATER_OBSTACLE_REACH_PX`, which had no other consumer.
  //
  // The one thing this genuinely bought — catching a painted hole smaller
  // than the derivation grid's own resolution — has no replacement in place.
  // If a rock that thin needs to foam again, that is a new, deliberate ask,
  // not a silent gap: `shore.foam`'s SDF-based break/swash terms below still
  // answer "something solid is near here" for anything the derivation grid
  // actually resolved.

  // ── FLOW PACK — `flowPackTexNode`/`flowPackGated`/`localVel`/`localSpeed`/
  // `localDirSafe`/`localFlowDirSafe` MOVED EARLIER, 2026-08-18 (S4), to
  // right after `inRect` — see that block for the full history. S4's
  // swash/break/streak below need them BEFORE this point in the function;
  // the flowVelocity debug channel's own deviation math, right below, reads
  // the SAME fetch rather than a second independent one
  // (`feedback_shared_field_two_meanings_two_registries` is the bug class
  // that split exists to prevent).
  // ══════════════════════════════════════════════════════════════════════
  // DEVIATION-FROM-BULK-DIRECTION, not absolute direction — REDESIGNED
  // 2026-08-18 after the FIRST version (absolute direction → hue, speed →
  // value, both proven correct via `bench-water.js#real-underground-river-
  // flow` against the real Underground river) still read as a near-uniform
  // flat colour in the saved picture. The reason: a real river's bulk flow
  // is the SAME direction almost everywhere by construction — routing
  // around an obstacle is a SMALL local perturbation on top of that bulk
  // direction, so absolute-direction-as-hue spends the entire hue wheel on
  // a signal that barely moves. The fix is not a brighter version of the
  // same idea — it's a different question: not "which way is this pixel
  // flowing" but "how far does THIS pixel's flow differ from the RIVER'S
  // OWN bulk direction" — which is near-zero almost everywhere (correctly)
  // and spikes exactly where an obstacle is actually doing something.
  //
  // `uFlowDir` (built above, `waterFlowVector(flowAngleDeg)`) IS the bulk
  // direction — the IDENTICAL bearing→vector conversion
  // `water-flow-subsystem.js`'s own `uDir` seeds the solve from, off the
  // SAME `flowAngleDeg` render-state field (DIRECTION AUTHORITY doctrine:
  // one compass, never two independently-derived ones). `sinDev`/`cosDev`
  // are the sine/cosine of the SIGNED angle between local and bulk
  // direction (2-D cross/dot of two unit vectors — no trig function calls
  // needed for either), and `atan(sinDev, cosDev)` recovers that signed
  // angle directly, positive one way round, negative the other.
  //
  // Inside solid, velocity is forced to exactly (0,0) (B2's own
  // `×(1−solid)` mask) — `localSpeed` floors at the `max(.,1e-4)` guard
  // below, so direction is defined-but-arbitrary there, same as the
  // previous design's `atan(0,0)` case, and just as harmless: `value` below
  // is ALSO ~0 there, and HSV value 0 is black regardless of hue/saturation.
  // `localVel`/`localSpeed`/`localDirSafe` are computed EARLIER now (right
  // after `inRect`, S4) — reused here rather than re-derived, same reasoning
  // as the pointer comment above this block.
  const cosDev = dot(localDirSafe, uFlowDir);
  const sinDev = uFlowDir.x.mul(localDirSafe.y).sub(uFlowDir.y.mul(localDirSafe.x));
  const deviationRad = atan(sinDev, cosDev);
  // Fully saturated by a ~29° (0.5 rad) local bend — a genuine routing
  // event right beside an obstacle, not a threshold tuned to any specific
  // fixture's numbers. LINEAR in angle (not `1-cos`, which is quadratic and
  // therefore LEAST sensitive exactly at the small deviations this channel
  // most needs to reveal).
  const MAX_BEND_RAD = 0.5;
  const deviationMag01 = clamp(abs(deviationRad).div(float(MAX_BEND_RAD)), 0, 1);
  // A DIVERGING pair, not a hue sweep: cyan = bent one way, orange = bent
  // the other, chosen for contrast (never adjacent on the wheel) and
  // colour-blind legibility (never a red/green pair). `mix(...,
  // step(0,x))` is a HARD switch between exactly these two fixed hues, not
  // a blend THROUGH the wheel between them — the wheel-crawl is exactly
  // what made the previous design illegible, so this deliberately never
  // interpolates hue at all, only saturation.
  const HUE_BENT_NEGATIVE = 0.53; // cyan
  const HUE_BENT_POSITIVE = 0.08; // orange
  const flowVelocityHue = mix(float(HUE_BENT_NEGATIVE), float(HUE_BENT_POSITIVE), step(float(0), deviationRad));
  // Saturation carries the SIGNAL (how much this pixel deviates from the
  // river's own bulk direction) — zero deviation reads as GREY/WHITE
  // (hue irrelevant at s=0), so "nothing interesting is happening here" is
  // visually silent, and colour only appears where routing genuinely does
  // something. Value still carries speed (`pow(.,0.4)`, the 2026-08-18
  // legibility fix, kept — real speeds land at 10-30% of
  // `WATER_FLOW_SPEED01_HEADROOM`'s own generous headroom and read as
  // near-black without it), so a fast, undeviated stretch of open river
  // still reads as bright white rather than a flat mid-grey.
  const flowVelocityColor = hsb2rgb(THREE.TSL, flowVelocityHue, deviationMag01, pow(flowPackGated.b, float(0.4)));

  // THE ONE FOAM TOTAL every downstream term reads from here on — tier 2's
  // crest foam PLUS the SIM PACK's own shoreline/wake foam, clamped once.
  // Law 2: an ADD, never a substitution; `field.foam` itself is untouched,
  // so a caller that only wants tier 2's own number still has it.
  //
  // ⚠️ `waterSimFoam`, NOT `shore.foam` (2026-08-18, S5) — THE ACTUAL
  // COLLAPSE `docs/planning/Water-Simulation-Turn.md` §3/§6 describes. The
  // author's own complaint about the PREVIOUS source (`shore.foam`'s
  // swash/break/tail): *"the concentric circles radiating outwards are very
  // predictable and artificial... they aren't currently being changed by
  // the surface of the water."* That was a structural property of a pure
  // function of (position, clock) with zero memory between frames — no
  // amount of retuning could have fixed it, only a genuinely stateful
  // buffer could (`water-sim.js`'s own header). `shore` (below) is STILL
  // built, unchanged, for its own diagnostic channels
  // (`foamD01`/`worleyLace`/`swashBand`/`breakFacing`/`breakFoam`/
  // `foamTail`) — those keep answering "is this term individually
  // healthy", same as always — but `shore.foam` itself no longer reaches
  // the visible water.
  //
  // ⚠️ `max`, NOT `add` (2026-08-18, SAME DAY, live-reported) — author,
  // looking at the real map with channel 24 (`simFoamRaw`) selected:
  // *"The debug channel shows the correct wake structure but the actual
  // foam at the moment is happening in a roughly even area around the
  // whole circumference of the things that create wakes... If we can get
  // the foam to appear only in the sim pack foam whiter areas that would
  // be a good way to make it look better."* Root cause: `field.foam` (tier
  // 2's own crest foam, `water-field.js`) is gated by `shoreGate` — a HARD
  // "within `WATER_FOAM_SHORE_PX` of ANY shore or obstacle" cutoff with NO
  // directionality at all, by construction the "roughly even... whole
  // circumference" shape the author named exactly. `ADD`ing that to the
  // sim's own correctly wake-shaped signal does what this codebase already
  // learned once, for the OLD swash/break/tail terms, not to do: it drives
  // every overlap toward the clamp and ERASES the very structure the sim
  // buffer exists to provide (`water-shore.js#buildWaterShoreFoam`'s own
  // header: "they are three views of ONE substance... summing would erase
  // exactly the structure"). Same fix, same reasoning, new terms: `MAX`,
  // so the sim's own bright wake pixels stand at their OWN full value
  // rather than a diluted sum, and tier 2's own near-shore crest foam only
  // shows through where the sim genuinely has nothing to say (open water
  // far from any wake). `field.foam`'s own `shoreGate` is deliberately
  // NOT touched here — it is also what keeps `WATER_BANK_REACH_PX`'s own
  // domain-warp safety margin valid (that constant's own header: sized to
  // stay "a little past `WATER_FOAM_SHORE_PX`, so the warp is still fully
  // present everywhere foam CAN appear") — widening where tier-2 foam can
  // fire would need that margin re-examined too, a separate change from
  // fixing how two ALREADY-BOUNDED sources combine.
  //
  // ── SIM FOAM STRUCTURE (2026-08-19) — "real foam is complex stringy
  // mess, it's not a 'glow' effect" (author, live, once the calibration fix
  // above finally made the wake's SHAPE visible at all). `waterSimFoam` is
  // the sim buffer's own accumulator, correctly shaped and sized now, but
  // still a smoothly-diffused field — smoothness a display-time CLAMP
  // cannot fix, because the accumulator has no internal structure to clamp
  // into; a brighter smooth gradient is still a smooth gradient, which is
  // exactly what reads as a glow. `buildFoamCellularStructure` is the SAME
  // Worley "net with holes" texture shore foam already uses
  // (`water-shore.js`'s own header: real foam is cellular, not a gradient)
  // — reused rather than grown a second time
  // (`feedback_shared_field_two_meanings_two_registries`). `.structure`, NOT
  // `.lace`: the wake is meant to read as DISCRETE patches that can
  // genuinely vanish between clumps ("foam might break off and flow
  // downstream"), not a continuous sheet merely thinned in the middle —
  // `.lace`'s softening exists for shore foam's different, continuous-sheet
  // case. Reuses `localFlowDirSafe`/`field.domainOffset`/`uFoamReachPx` —
  // all already computed above, none sim-specific, so cells read at the
  // same size/orientation convention as shore foam's own.
  //
  // ⚠️ FIXED 2026-08-19 — this used to pass `localFlowDirSafe` (the REAL,
  // per-pixel-varying solved direction) as `flowDir`, which rotated the
  // Worley query by a spatially-varying angle and warped it into a literal
  // spiral near small obstacles (author, live, zoomed: "26 shows concentric
  // poles of almost magnetic like rings"). `WATER_FOAM_FLOW_NUDGE`'s own doc
  // (`water-shore.js`) has the full story: `flowDir` must be the GLOBAL
  // uniform (`buildFoamCellularStructure`'s own restored contract), and the
  // real per-pixel signal now reaches this the SAFE way, as `localFlowDir` —
  // a bounded additive nudge to the sample point, never a rotation. Shore
  // foam's already-shipped `worleyLace` shared this exact bug (confirmed
  // showing the identical artifact) and is fixed by the same change, in the
  // one shared function, not twice.
  const simFoamStructureBuild = buildFoamCellularStructure({
    TSL: THREE.TSL,
    worldXY: vec2(positionWorld.x, positionWorld.y),
    domainOffset: field.domainOffset,
    flowDir: uFlowDir,
    localFlowDir: localFlowDirSafe,
    uReachPx: uFoamReachPx,
    timeMsNode,
    ...foamStructureUniforms,
  });
  const simFoamStructure = simFoamStructureBuild.structure;
  const waterSimFoamStructured = waterSimFoam.mul(simFoamStructure);

  // ── FOAM EDGE-SHARPNESS GATE — see `WATER_FOAM_EDGE_SHARPNESS_TAP_PX`'s
  // own doc (above the constant, this file) for the full mechanism. Reads
  // the RAW mask (`maskTexture`, the same source `maskTexNode` above
  // samples), not the baked body pack — this is a property of the AUTHORED
  // ART, and the body pack's own SDF is already smoothed by the flood.
  //
  // ⚠️ EVERY ONE OF THESE FOUR TAPS PUSHED TO `maskTexNodes`
  // (`feedback_texture_nodes_must_be_repointed_together`, THIS SAME FILE's
  // own loud warning six lines above `maskTexNodes`' own declaration) — live-
  // reported, 2026-08-24, no wiring gap needed to notice it: "I see no
  // difference between the highest and lowest setting." Without this, all
  // four taps sample the 1×1 construction-time placeholder FOREVER — a 1×1
  // texture has no spatial variation, so the gradient below is identically
  // ZERO on every real map regardless of what is painted, and the gate never
  // reflects reality no matter where the slider sits.
  //
  // GATED TO TIER 4+ (unlike most of this file's other unconditional-below-
  // their-tier terms) — the request this answers is specifically about
  // `shore`'s own foam ("the foam we've been working on"), which does not
  // exist before tier 4 either. Keeping this out of tiers 0-3 also keeps
  // `maskTexNodes`' own count at exactly 1 below tier 4, the invariant
  // `water-render.test.mjs`'s own removal guard already pins (the OLD
  // 8-tap obstacle ring's ghost).
  let foamSharpnessGate = float(1);
  let foamSharpnessFactor = float(1);
  if (activeTier >= 4) {
    const tapWorld = float(WATER_FOAM_EDGE_SHARPNESS_TAP_PX);
    const sampleMaskAt = (worldOffsetX, worldOffsetY) => {
      const u = positionWorld.x.add(worldOffsetX).sub(uMaskRect.x).div(spanX);
      const v = positionWorld.y.add(worldOffsetY).sub(uMaskRect.y).div(spanY);
      const tapNode = texture(maskTexture, vec2(clamp(u, 0, 1), clamp(v, 0, 1)));
      maskTexNodes.push(tapNode);
      return tapNode.r;
    };
    const maskGradX = sampleMaskAt(tapWorld, float(0))
      .sub(sampleMaskAt(tapWorld.negate(), float(0)))
      .div(tapWorld.mul(float(2)));
    const maskGradY = sampleMaskAt(float(0), tapWorld)
      .sub(sampleMaskAt(float(0), tapWorld.negate()))
      .div(tapWorld.mul(float(2)));
    const maskGradMag = length(vec2(maskGradX, maskGradY));
    foamSharpnessGate = smoothstep(
      float(WATER_FOAM_EDGE_SHARPNESS_GRAD_LO),
      float(WATER_FOAM_EDGE_SHARPNESS_GRAD_HI),
      maskGradMag
    );
    // `foamEdgeSharpness = 0` (the schema default) makes this EXACTLY 1 —
    // see the constant block's own doc for why that is load-bearing, not
    // incidental: every map that has never touched this slider gets
    // byte-identical foam to before this fix.
    foamSharpnessFactor = mix(float(1), foamSharpnessGate, uFoamEdgeSharpness);
  }

  const totalFoam = min(max(field.foam, waterSimFoamStructured), float(1)).mul(foamSharpnessFactor);

  // ── TIER 4: CAUSTICS' OWN AUTHOR-FACING GAIN ─────────────────────────────
  // `field.causticBrightness` already carries the calibrated
  // `WATER_CAUSTICS_K` internally (see that constant's own doc for the real
  // GPU sweep it was tuned against) — this is a SEPARATE multiplier on top,
  // so an author can pull the whole effect back without retuning the physics
  // constant underneath it. `max(0, ...)`: a negative gain would flip
  // brightening into darkening and darkening into brightening, which is not
  // "less caustics", it is a different, wrong effect.
  const causticGain = max(uCaustics, float(0));
  const causticExcess = field.causticBrightness.mul(causticGain);

  // ============================================================================
  // TIER 5 — REFRACTION (C5, Water-Testament.md §2.5) — landed 2026-08-23
  // ============================================================================
  // The dependent read the whole pass-graph flip (graph/passes.js#surface.water)
  // exists for. `capturedTexture` is a PREVIOUS frame's own `buf:scene.color`,
  // bounded to water's own screen rect (`water-refraction-subsystem.js`) — a
  // drawable genuinely cannot read the buffer it is still helping to write, so
  // this samples what was there a frame ago instead, same price every
  // screen-space-reflection technique pays.
  //
  // WORLD-ANCHORED, NOT SCREEN-ANCHORED (no camera-delta math): `uCapturedRect`
  // is the world rect `capturedTexture`'s own UV space maps across, captured
  // AT THAT TIME. This frame's `positionWorld` maps through the SAME formula
  // regardless of how far the camera has panned since — a texel's world
  // position never moves, so there is nothing to reproject.
  // ── THE DEPTH-AUTHORITY GATE (2026-08-15) — see the module header ────────
  // A JS-time branch: with no depth texture OR no view rect, the whole lookup
  // is compiled OUT rather than multiplied by a one (Effects.md Law 4 /
  // `tsl/no-uniform-gates`), so an unwired caller (the torture fixture, a
  // material built before envLight's view rect exists) pays nothing extra and
  // renders exactly as it did before this migration — paint order alone.
  //
  // Screen UV comes from `positionWorld` mapped through the SAME `uViewRect`
  // the geometry pass wrote `buf:scene.depth` against — byte-for-byte
  // `window-render.js`'s own floor-gate mapping, so the two agree about where
  // a world point lands on screen without a second derivation. NOT `uv()` or
  // the built-in `screenUV()`: this quad is a world-space AABB crop, not a
  // fullscreen pass (`feedback_shared_texture_node_carries_the_wrong_uv`).
  //
  // ⚠️ MOVED HERE, ABOVE tier 5 (2026-08-23) — was declared just above "MESH
  // 1", too late for tier 5's own `refractAlpha` to read it. Tier 5's mesh
  // draws in ITS OWN separate pass now (`WATER_TIER5_DISABLED_PENDING_SELF_
  // CAPTURE_FIX`'s own doc has the full story of why), which means it no
  // longer gets occlusion for free from paint order the way mesh 1/2 still
  // do — this is the ONLY thing standing between it and drawing over content
  // that should hide it (a token, an upper floor), so it reads this SAME
  // depth-authority value mesh 1/2 already trust, not a separate check.
  let notOccluded = float(1);
  let floorGateCompiled = false;
  if (depthTexture && uViewRect) {
    const viewSpanX = max(uViewRect.z.sub(uViewRect.x), float(1));
    const viewSpanY = max(uViewRect.w.sub(uViewRect.y), float(1));
    const screenU = positionWorld.x.sub(uViewRect.x).div(viewSpanX);
    const screenV = positionWorld.y.sub(uViewRect.y).div(viewSpanY);
    const screenUv = vec2(clamp(screenU, 0, 1), clamp(screenV, 0, 1));
    const depthHere = texture(depthTexture, screenUv);
    // `step(edge,x) = x>=edge ? 1:0`, so this reads "is the stored depth at
    // this pixel AT OR ABOVE my own floor's rank" — 1 unless something ranked
    // strictly higher (a Tile, a roof, a floor above) is drawn over it. The
    // SAME single ordinal comparison every other depth-authority consumer
    // already uses; no tolerance/softness needed, a real rank is exact.
    notOccluded = step(uExpectedDepth, depthHere);
    floorGateCompiled = true;
  }

  let refractMaterial = null;
  /** Every `texture(capturedTexture, …)` node tier 5 builds — see the fringe
   * comment below for why re-pointing needs all three, always this array,
   * never empty-then-populated-elsewhere (a caller checking `.length` before
   * a rebuild would see a stale answer otherwise). */
  const capturedTexNodes = [];
  if (activeTier >= 5) {
    // ⚠️ BOUND THE SLOPE'S OWN MAGNITUDE BEFORE USING IT AS AN OFFSET — real
    // bug, live-reported as "oil spill" chaos (2026-08-23), fixed here.
    // `field.slope` is a rise/run gradient (unitless), and the FIRST version
    // of this rung multiplied it by a bare constant completely unclamped —
    // so a steep wave crest, or simply a per-pixel-noisy slope reading above
    // magnitude 1, pushed the SAMPLE POSITION arbitrarily far from its true
    // spot, and a per-pixel-varying offset with no ceiling is exactly what
    // turns a coherent bend into decorrelated noise between neighbouring
    // pixels — the same failure shape this effect has already scarred on
    // twice: a per-pixel spiral (`WATER_FOAM_FLOW_NUDGE`'s own doc comment)
    // and a runaway warp (`water-field.js#flowDeviationSafe`) — both of
    // which ALREADY normalise-then-scale for this exact reason, a
    // discipline this rung skipped the first time. `div(max(length, 1))`
    // leaves a GENTLE slope (magnitude ≤ 1) untouched and only clamps a
    // STEEP one down to unit length.
    //
    // ⚠️ WORTH KNOWING (2026-08-23, the invisible-refraction investigation)
    // — in practice this clamp almost NEVER engages. `field.slope`'s own
    // magnitude is a MEASURED physical quantity, not an arbitrary one — see
    // `water-field.js#WATER_TIER3_CHOP`'s own Cox-Munk citation: real RMS
    // slope runs ~0.055 (dead calm) to ~0.28 (a stiff breeze), nowhere near
    // the magnitude-1 ceiling this clamp guards against. Combined with
    // `depth01` (measured 0.10-0.17 across a real river in the shader-lab
    // bench), the ACTUAL offset this whole expression produces is a small
    // FRACTION of `refractStrengthPx`, not a value anywhere close to it —
    // which is why the old fixed constant (24, then 6) read as invisible on
    // a live map rather than merely subtle, and why this is a live,
    // wide-range param now (`WATER_PARAMS.refractStrengthPx`, water.js)
    // instead of a constant to keep re-guessing.
    const slopeMagnitude = length(field.slope);
    const slopeBounded = field.slope.div(max(slopeMagnitude, float(1)));
    const refractOffsetWorld = slopeBounded.mul(depth01).mul(uRefractStrengthPx);
    const refractedWorldXY = vec2(positionWorld.x, positionWorld.y).add(refractOffsetWorld);

    const capturedSpanX = max(uCapturedRect.z.sub(uCapturedRect.x), float(1));
    const capturedSpanY = max(uCapturedRect.w.sub(uCapturedRect.y), float(1));
    const centerUv = vec2(
      clamp(positionWorld.x.sub(uCapturedRect.x).div(capturedSpanX), 0, 1),
      clamp(positionWorld.y.sub(uCapturedRect.y).div(capturedSpanY), 0, 1)
    );
    const refractedUv = vec2(
      clamp(refractedWorldXY.x.sub(uCapturedRect.x).div(capturedSpanX), 0, 1),
      clamp(refractedWorldXY.y.sub(uCapturedRect.y).div(capturedSpanY), 0, 1)
    );

    // TAP VALIDATION — the SAME buf:scene.depth idiom the floor gate below
    // already uses (byte-for-byte the `uViewRect`-based explicit remap,
    // never the shared `screenUV()` builtin —
    // `feedback_shared_texture_node_carries_the_wrong_uv`), sampled at the
    // REFRACTED position instead of water's own: a tap landing on something
    // that ranks ABOVE water there (a token standing where the bend would
    // look) falls back to the CENTRE, unrefracted UV — V2's own checklist
    // named this exact artifact "tap validation".
    let tapUv = refractedUv;
    if (depthTexture && uViewRect) {
      const tapViewSpanX = max(uViewRect.z.sub(uViewRect.x), float(1));
      const tapViewSpanY = max(uViewRect.w.sub(uViewRect.y), float(1));
      const refractedScreenUv = vec2(
        clamp(refractedWorldXY.x.sub(uViewRect.x).div(tapViewSpanX), 0, 1),
        clamp(refractedWorldXY.y.sub(uViewRect.y).div(tapViewSpanY), 0, 1)
      );
      const depthAtRefraction = texture(depthTexture, refractedScreenUv);
      const tapValid = step(uExpectedDepth, depthAtRefraction);
      tapUv = mix(centerUv, refractedUv, tapValid);
    }

    // CHROMATIC FRINGE — ±1 texel R/B split, the top tier's own signature (no
    // dedicated author param yet: a fixed, small technique, not a tunable —
    // see WATER_TIER5_REFRACT_PX's own note on why the offset itself is a
    // constant for now too).
    //
    // ⚠️ THREE bare `texture()` nodes, not one re-derived expression — the
    // SAME trap `waterSimTexNode`'s own header names above: a texture node
    // re-pointed for the caller needs a real `.value` setter, which only a
    // bare node has, and R/G/B each need their OWN UV here, so one shared
    // node cannot serve all three. Tracked in `capturedTexNodes` (plural,
    // mirroring `maskTexNodes`) so the caller re-points every one of them
    // together the moment a real capture lands — re-pointing only the first
    // is exactly `feedback_texture_nodes_must_be_repointed_together`'s own
    // scar (a channel silently frozen on the 1×1 placeholder forever).
    //
    // ⚠️ SUPPRESSED WHERE THIS FRAGMENT IS CURRENTLY A SUN-GLINT SPARKLE —
    // see WATER_TIER5_FRINGE_SPECULAR_LO/HI's own doc for the live-reported
    // bug this closes ("rainbow chevrons" scattered across open water:
    // specular.reflection is baked into the buf:scene.color this fringe
    // reads, one frame stale, and was getting split into colour right along
    // with the bed). `specular.reflection` here is THIS fragment's own,
    // THIS-FRAME value (tier 3's own live node, not a read of the stale
    // capture) — a strong, cheap, physically-grounded proxy for "the
    // captured pixel here is dominated by a mirror reflection, not bed
    // colour", without a new pass or a new render target.
    const specularLuma = luminance(specular.reflection);
    const fringeSuppress = smoothstep(
      float(WATER_TIER5_FRINGE_SPECULAR_LO),
      float(WATER_TIER5_FRINGE_SPECULAR_HI),
      specularLuma
    );
    const fringeUv = vec2(uCapturedTexelUv.x, float(0)).mul(float(1).sub(fringeSuppress));
    const refractRNode = texture(capturedTexture, tapUv.add(fringeUv));
    const refractGNode = texture(capturedTexture, tapUv);
    const refractBNode = texture(capturedTexture, tapUv.sub(fringeUv));
    capturedTexNodes.push(refractRNode, refractGNode, refractBNode);
    const refractColor = vec3(refractRNode.r, refractGNode.g, refractBNode.b);

    // ⚠️ `.mul(notOccluded)` ADDED (2026-08-23) — this mesh now draws in its
    // own separate pass (see the self-capture fix's own account), so it no
    // longer gets occlusion for free from paint order the way mesh 1/2
    // still do inside `scene`. Without this, a token or upper-floor tile
    // that should hide the water beneath it would no longer hide THIS
    // mesh's own refracted overlay, regardless of what it does to mesh 1/2
    // — the exact "water renders above things that should mask it" shape
    // this file's own module header already names as a real, once-shipped
    // regression class.
    const refractAlpha = inside.mul(notOccluded).mul(float(WATER_TIER5_MAX_ALPHA));
    refractMaterial = new THREE.NodeMaterial();
    refractMaterial.colorNode = vec4(refractColor, refractAlpha);
    configureShared(refractMaterial);
    refractMaterial.blendSrc = THREE.SrcAlphaFactor;
    refractMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
    refractMaterial.blendSrcAlpha = THREE.OneFactor;
    refractMaterial.blendDstAlpha = THREE.ZeroFactor;
    // ⚠️ NO `mrtNode` HERE — REAL BUG, FOUND AND FIXED (2026-08-23, live-
    // reported: "Refraction strength at 600, full, no sign of any
    // refraction at all. It's. Broken."). Tier 5 used to share mesh 1/2's
    // OWN `attr`-writing `mrtNode` (an `mrt({attr:...})` struct, written
    // here at CONSTRUCTION time before this fix) because it used to draw
    // into `buf:scene.color` (`sceneColor`) alongside them — a genuine
    // multi-attachment target with a real `attr` channel. Once the self-
    // capture fix (same day, earlier) moved this mesh to draw in its OWN
    // pass, it targets `sceneLit` instead (`vt-pan-viewer.js#runWater
    // RefractionCapturePass` — see that pass's own comment for WHY:
    // `sceneColor` is a pre-lighting input `light.accumulate` consumes, not
    // the buffer that reaches the screen). `sceneLit` is deliberately
    // SINGLE-attachment (`describeSceneColor()`, not `describeSceneColorMrt()`
    // — vt-pan-viewer.js's own comment there already names the exact WGSL
    // failure this would hit: "structures must have at least one member").
    // The `mrtNode` this mesh used to carry pointed at an attachment name
    // that does not exist on its new target — a real, live-reported,
    // completely-invisible-regardless-of-any-uniform bug, not merely a
    // magnitude problem. Removed, not merely disabled: this mesh has no
    // `attr` to write any more, on ANY target it now draws to.
  }

  // ============================================================================
  // TIERS 6-8 — NOT YET BUILT. THIS IS WHERE THEY GO (Effects.md §0 / §2)
  // ============================================================================
  // Named, ordered and costed in `WATER.deferredRungs` (water.js) and
  // `docs/holy/Water-Testament.md` §3.6 (the newer, LOCKED ladder — NOT
  // `Water.md` §6, which still lists a now-deleted `reflection` rung between
  // these two; see that Testament section for why). Nothing below is code,
  // only the landing strip a real rung gets the day its own module lands.
  // Each becomes an `if (activeTier >= N) { ... }` block in this exact
  // position, CUMULATIVE with everything above it — tier 5 just established
  // the "a rung's own coordinate can come from another read" pattern.
  //
  //   tier 6  sim:memory       C7  foam advect/decay buffer + wetness
  //                                watermark + convergence scum
  //                                (coverage/zoom gated, Effects.md Law 7)
  //   tier 7  sim:interactive  C7  ripple integrator, wakes, rain rings —
  //                                ADDED into tier 2's field, never
  //                                substituted for it
  //   tier 8  spray            C8  splash/spray particles through the one
  //                                particle engine — geometry, the top of
  //                                the ladder
  //
  // None of the three has a `fromProfile` yet — real design decisions for
  // whoever builds them, not placeholders to guess at here. Tier 5
  // (`fromProfile: 'quality'`, water.js) is the first of tiers 5+ to declare
  // one; the first of THESE three to declare `'extreme'` on its own account
  // is what gives extreme a look past tier 5.
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
  // supposed to be covering. Reads `totalFoam` (tier 2 + tier 4's filaments),
  // never `field.foam` alone, past this point — see that variable's own
  // comment for why (Law 2: one foam total, or foam and its own occlusion
  // could disagree about how much of the bed is covered).
  // ── FOAM HAS A THICKNESS, AND IT HIDES LESS THAN IT GLOWS (2026-08-17) ───
  // Author: *"I can see it, but it's currently very primitive."* One cause was
  // that `totalFoam` drove BOTH how much bed the foam hides and how bright it
  // is, through the SAME linear factor — so every foam pixel was the same flat
  // white paint at a different alpha, and the only structure available was the
  // lace texture's own.
  //
  // Real foam does not work that way. A thin scatter of bubbles throws light
  // back very efficiently (bright) while hiding almost nothing behind it
  // (translucent); a thick raft is opaque. So the two curves separate, and the
  // separation IS the sense of thickness:
  //
  //   COVER = f²        rises SLOWLY  — thin foam is see-through
  //   GLOW  = f·(2 − f) rises QUICKLY — thin foam still catches the light
  //
  // At f = 0.3 that is 9% of the bed hidden against 51% brightness: a bright
  // veil you can see the water through, which is what the shallow edges of a
  // foam patch actually look like. Both reach exactly 1 at f = 1, so the
  // thickest foam is still fully opaque white and nothing overshoots. Two
  // multiplies, no transcendental, no new texture read.
  const foamCover = totalFoam.mul(totalFoam);
  const foamGlow = totalFoam.mul(float(2).sub(totalFoam));
  const foamHide = float(1).sub(foamCover);

  const absorbMaterial = new THREE.NodeMaterial();
  // CAUSTICS BRIGHTEN THE BED, MULTIPLICATIVELY — the correct mesh for them:
  // a caustic does not add new light to the scene, it REDISTRIBUTES the light
  // already reaching the bed, which is exactly what multiplying the bed's own
  // transmitted colour (rather than adding a separate glow) expresses. Placed
  // AFTER the wet band and foam hide, so caustics never brighten damp ground
  // (no volume above it to refract through) or the underside of foam (which
  // scatters, it does not focus).
  const absorbColor = bedTransmit.mul(float(1).sub(wetBand)).mul(foamHide).mul(float(1).add(causticExcess));
  // OCCLUDED → `vec3(1,1,1)`, the multiply's OWN neutral element (see the
  // header on why white, not black — [[feedback_blend_neutral_element_is_per_blend]]):
  // whatever already won this pixel passes through completely untouched,
  // never darkened by a water pass that should not be there at all.
  //
  // Named (not inlined) because debug channel 17 (`absorbFinal`) reads this
  // exact expression — see the instrument below.
  const absorbFinalColor = mix(vec3(1, 1, 1), absorbColor, notOccluded);
  absorbMaterial.colorNode = vec4(absorbFinalColor, 1);
  configureShared(absorbMaterial);
  absorbMaterial.blendSrc = THREE.ZeroFactor;
  absorbMaterial.blendDst = THREE.SrcColorFactor;
  // WHITE, not the global zero — the multiplicative identity. See the header:
  // `attr · 0` would erase the floor attributes under every water pixel, and
  // blend state is not per-attachment on WebGL2. Already occlusion-safe as-is
  // (white is neutral regardless of `notOccluded`), so it needs no gating.
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
  //
  // OCCLUDED → the WHOLE term scaled toward 0, the add's own neutral element —
  // an occluded water pixel must emit no light at all, not merely skip its
  // bed multiply.
  // Named (not inlined) because debug channel 18 (`inscatterFinal`) reads
  // this exact expression — see the instrument below.
  const inscatterFinalColor = inscatter
    .mul(foamHide)
    .add(foamGlow.mul(float(0.85)))
    .add(reflection)
    .mul(notOccluded);
  inscatterMaterial.colorNode = vec4(inscatterFinalColor, 1);
  configureShared(inscatterMaterial);
  inscatterMaterial.blendSrc = THREE.OneFactor;
  inscatterMaterial.blendDst = THREE.OneFactor;
  // Additive's identity IS the renderer-global default, so this changes
  // nothing — it is stated because the pass beside it is a counter-example to
  // "vec4(0) always means don't touch it", and the next reader needs to see
  // that this one was checked rather than left to luck.
  inscatterMaterial.mrtNode = mrt({ attr: vec4(0, 0, 0, 0) });

  // ── THE INSTRUMENT (2026-08-16, Water-Testament W0) — a third material no
  // mesh draws until asked ──────────────────────────────────────────────────
  // `water.js#WATER_DEBUG_CHANNELS` holds the why and the reading guide for
  // every channel below. Free when off: at channel 0 `water-surface-
  // subsystem.js#refreshVisibility` attaches this material to no mesh, so the
  // selector is not in a draw call at all — the same structural (not merely
  // promised) zero cost `specular-render.js#SPECULAR_DEBUG_CHANNELS` uses.
  //
  // Three channels are DISPLAY-REMAPPED so a value outside [0,1] reads as a
  // picture instead of clipping silently: `depth01` can exceed 1 once
  // turbidity brightens it, `turbidity` is SIGNED around a "no effect" zero,
  // and `causticExcess` (2026-08-27: always ≥0 since the Worley-net rebuild —
  // there is no "darkening" case any more) keeps the SAME 0.5-is-neutral
  // remap anyway, for one honest reason: a bare `clamp(causticExcess, 0, 1)`
  // would visually flatten every value past 1 (a common case — the net's own
  // ceiling is `WATER_CAUSTICS_MAX = 1.6`) to identical white, hiding exactly
  // the "is a bright line pegged at the ceiling or just bright" question a
  // debug channel exists to answer; the same half-scale remap answers it for
  // free without needing two different formulas for two display channels.
  // Every other channel below is its raw node, unclamped, on purpose: a value
  // legitimately outside [0,1] on one of THOSE is itself the finding.
  const depth01Display = clamp(depth01, float(0), float(1));
  const bedVisibility = dot(bedTransmit, vec3(1 / 3, 1 / 3, 1 / 3));
  const turbidityDisplay = clamp(field.turbidity.mul(float(0.5)).add(float(0.5)), float(0), float(1));
  const causticDisplay = clamp(causticExcess.mul(float(0.5)).add(float(0.5)), float(0), float(1));
  const debugNodes = {
    quad: vec3(1, 0, 1),
    mask: vec3(maskTexNode.r, maskTexNode.r, maskTexNode.r),
    inside: vec3(inside, inside, inside),
    shoreDist01: vec3(depthRamp, depthRamp, depthRamp),
    depth01: vec3(depth01Display, depth01Display, depth01Display),
    bedVisibility: vec3(bedVisibility, bedVisibility, bedVisibility),
    turbidity: vec3(turbidityDisplay, turbidityDisplay, turbidityDisplay),
    foamCrest: vec3(field.foam, field.foam, field.foam),
    foamD01: vec3(shore.d01, shore.d01, shore.d01),
    worleyLace: vec3(shore.lace, shore.lace, shore.lace),
    swashBand: vec3(shore.swashBand, shore.swashBand, shore.swashBand),
    breakFacing: vec3(shore.breakFacing, shore.breakFacing, shore.breakFacing),
    breakFoam: vec3(shore.breakOnly, shore.breakOnly, shore.breakOnly),
    foamTail: vec3(shore.tailOnly, shore.tailOnly, shore.tailOnly),
    totalFoam: vec3(totalFoam, totalFoam, totalFoam),
    causticExcess: vec3(causticDisplay, causticDisplay, causticDisplay),
    // RAW tier-3 output, ungated by `inside`/`foamHide` — isolating "does
    // tier 3 itself produce signal" from "does the water gate multiply it
    // correctly", the same split channels 8 and 12 already draw for foam.
    // Channel 18 (`inscatterFinal`) is the gated readback of this same term.
    reflection: specular.reflection,
    absorbFinal: absorbFinalColor,
    inscatterFinal: inscatterFinalColor,
    // `.a`, NOT `.r` — S3's pack moved solidity to the ALPHA channel to make
    // room for RG velocity + B speed01 (`buildWaterProjectPackMaterial`'s own
    // B4 doc); reading `.r` here now would show VELOCITY-X mislabelled as
    // solidity, exactly the kind of channel-layout drift this project's own
    // `feedback_shared_field_two_meanings_two_registries` bug class names.
    flowSolidity: vec3(flowPackGated.a, flowPackGated.a, flowPackGated.a),
    flowVelocity: flowVelocityColor,
    // RAW accumulator (no clump threshold) — deliberately the UNCLAMPED
    // value, same "isolate the source from its own gate" split channels 7
    // and 12 already draw: `simFoam` below shows what actually reaches the
    // water, this shows what the buffer itself actually contains.
    simFoamRaw: vec3(waterSimTexNode.r, waterSimTexNode.r, waterSimTexNode.r),
    simFoam: vec3(waterSimFoam, waterSimFoam, waterSimFoam),
    // The cellular "net with holes" mask ALONE (2026-08-19) — no accumulator
    // involved, so an author can judge the texture itself (cell size, streak
    // stretch, hole density) independent of where the sim buffer happens to
    // be bright this frame. `simFoamStructured` (below) is what actually
    // reaches the water: this × `simFoam` above.
    simFoamStructure: vec3(simFoamStructure, simFoamStructure, simFoamStructure),
    simFoamStructured: vec3(waterSimFoamStructured, waterSimFoamStructured, waterSimFoamStructured),
    // `flowWarp` ALONE (`field.flowWarp`, `water-field.js`) — NOT `domainOffset`,
    // which this channel could not use even if it wanted to: `drift` (unbounded,
    // growing with elapsed time) dwarfs `flowWarp` within seconds of scene load,
    // so anything summed with it reads as flat/saturated almost immediately.
    // Existence proof for the 2026-08-19 sign fix: R/G > 0.5 means the warp
    // points +X/+Y; divided by 10 (a display range picked to keep typical
    // measured magnitudes, a few world-px, comfortably inside [0,1] without
    // saturating) rather than the term's own (much larger) safety cap.
    flowWarp: vec3(
      clamp(field.flowWarp.x.div(float(10)).add(float(0.5)), float(0), float(1)),
      clamp(field.flowWarp.y.div(float(10)).add(float(0.5)), float(0), float(1)),
      float(0.5)
    ),
    // THE RAW GATE (2026-08-24), NOT `foamSharpnessFactor` — isolating "how
    // sharp does this pixel's local mask edge measure" from "is the slider
    // even turned on", the same split every OTHER gate in this list draws.
    // White = a sharp, hard-painted edge; black = a soft, gradual one;
    // mid-grey = ambiguous, between the two calibrated bounds. Flat white
    // (or flat black) everywhere on a mask with BOTH edge styles painted
    // means `WATER_FOAM_EDGE_SHARPNESS_TAP_PX`'s own calibration needs
    // revisiting for that map's own resolution, not that the mechanism is
    // broken.
    foamEdgeSharpness: vec3(foamSharpnessGate, foamSharpnessGate, foamSharpnessGate),
  };
  // ⚠️ ARITHMETIC, NOT `select()` — see `effects/debug-channel-select.js`'s
  // header for the twelve specular rounds this trap cost before anyone dumped
  // the real WGSL. Water shares `bodyTexNode`/`field`/`shore` across many of
  // the channels above; a `select()` fold would assign each shared `.toVar()`
  // in whichever branch the graph walk reached first and leave every other
  // channel reading it as an unassigned zero.
  const debugColor = buildDebugChannelColor(THREE.TSL, {
    channels: WATER_DEBUG_CHANNELS,
    nodes: debugNodes,
    uDebugChannel,
    label: 'water',
  });
  const debugMaterial = new THREE.NodeMaterial();
  debugMaterial.colorNode = vec4(debugColor, 1);
  configureShared(debugMaterial);
  // OPAQUE where the effect ADDS: a diagnostic whose "this is zero" answer
  // rendered as *nothing added* would reproduce the very ambiguity it exists
  // to remove.
  debugMaterial.blendSrc = THREE.OneFactor;
  debugMaterial.blendDst = THREE.ZeroFactor;
  // ⚠️ `attr` TOO — and unlike the two real meshes above, REPLACE (One/Zero)
  // has no value that means "leave the destination alone": `absorbMaterial`
  // could pick WHITE as multiply's neutral and `inscatterMaterial` could rely
  // on add's zero-is-neutral default, but a replace blend always overwrites
  // `attr` with whatever this material's own `attr` output is, full stop —
  // there is no "don't touch it" available on either backend (blend state is
  // not per-attachment on WebGL2, so `attr` cannot quietly keep a gentler
  // blend while `colorNode` replaces). Explicit zero, not an unexamined
  // renderer-global default, so a future reader sees this was CHECKED: while
  // any non-zero debug channel is on screen, `attr` reads zero under the
  // water AABB. Accepted rather than avoided — this material never ships in
  // the normal render path (Water-Testament W0), and nothing consumes `attr`
  // as part of reading the SAME diagnostic the picker is open for.
  debugMaterial.mrtNode = mrt({ attr: vec4(0, 0, 0, 0) });

  return {
    absorbMaterial,
    inscatterMaterial,
    debugMaterial,
    /** Tier 5's own third mesh — `null` below tier 5 (the same convention
     * `bodyTexNode` uses), a real `THREE.NodeMaterial` at tier >= 5. Callers
     * add/remove this from the draw list on a tier rebuild exactly like the
     * other two, never gated by a separate flag — the null check IS the
     * gate. */
    refractMaterial,
    maskTexNode,
    /** EVERY `texture(maskTexture, …)` node this material built, `maskTexNode`
     * included (always first) — the caller re-points ALL of them together
     * when the real image loads, never `maskTexNode` alone. See this array's
     * own declaration for why one node re-pointed and the rest forgotten is
     * exactly the bug that shipped. */
    maskTexNodes,
    /** EVERY `texture(capturedTexture, …)` node tier 5 built — always a real
     * (possibly empty, below tier 5) array, same reasoning as `maskTexNodes`:
     * the caller re-points all three chromatic-fringe taps together the
     * moment a real capture lands, never just the first. */
    capturedTexNodes,
    bodyTexNode,
    /** The `flowSolidity`/`flowVelocity` debug channels' shared single fetch
     * — NEVER `null` (contrast `bodyTexNode`), because `flowPackTexture` is
     * always a real (if placeholder) texture object; see that param's own
     * doc. The caller re-points this via `setFlowPackTexture`, on its own
     * cadence, independent of every `maskTexNodes` re-point. */
    flowPackTexNode,
    /** `res:waterSim`'s own raw-accumulator fetch — NEVER `null`, same reason
     * as `flowPackTexNode` (see `args.waterSimTexture`'s own doc). The
     * caller re-points this via `setWaterSimTexture`, on its own cadence
     * (per-frame, unlike the flow pack's own bake-on-change cadence). */
    waterSimTexNode,
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
    /** The body pack's size IN TEXELS — pushed on every regrid alongside
     * `setBodyRect`, because the smooth reconstruction in `water-sampling.js`
     * is phase-locked to the grid and a stale size would put its eased fraction
     * out of step with the hardware filter it exists to correct.
     * @param {number} w @param {number} h */
    setBodyTexSize(w, h) {
      uBodyTexSize.value.set(Number.isFinite(w) && w > 0 ? w : 1, Number.isFinite(h) && h > 0 ? h : 1);
    },
    /** Same contract as `setBodyTexSize` above, for the flow pack's own
     * smooth-texel reconstruction (2026-08-19).
     * @param {number} w @param {number} h */
    setFlowPackTexSize(w, h) {
      uFlowPackTexSize.value.set(Number.isFinite(w) && w > 0 ? w : 1, Number.isFinite(h) && h > 0 ? h : 1);
    },
    /** Same contract as `setBodyTexSize` above, for the sim pack's own
     * smooth-texel reconstruction (S5, 2026-08-18).
     * @param {number} w @param {number} h */
    setWaterSimTexSize(w, h) {
      uWaterSimTexSize.value.set(Number.isFinite(w) && w > 0 ? w : 1, Number.isFinite(h) && h > 0 ? h : 1);
    },
    setAbsorption(v) {
      uAbsorption.value = v;
    },
    /** WATER_PARAMS `depthScalePx`. ⚠️ ALSO re-derives tier 4's foam reach —
     * `water-shore.js#WATER_FOAM_SHORE_FRACTION` makes the shoreline foam band a
     * FRACTION of this length so a pond and an ocean shore both work from the
     * one knob an author already sets. Deriving it in the same setter is what
     * stops the two drifting into disagreeing about the body's size
     * (`feedback_shared_field_two_meanings_two_registries`). */
    setDepthScalePx(v) {
      uDepthScalePx.value = v;
      uFoamReachPx.value = waterFoamReachPx(v);
    },
    setInscatter(v) {
      uInscatter.value = v;
    },
    setWaveScalePx(v) {
      uWaveScalePx.value = v;
    },
    setBankInfluence(v) {
      uBankInfluence.value = v;
    },
    setFlowWarpInfluence(v) {
      uFlowWarpInfluence.value = v;
    },
    setFoamFlowNudge(v) {
      uFoamFlowNudge.value = v;
    },
    setFoamEdgeFar(v) {
      uFoamEdgeFar.value = v;
    },
    setFoamEdgeAaPx(v) {
      uFoamEdgeAaPx.value = v;
    },
    setFoamBubbleAmount(v) {
      uFoamBubbleAmount.value = v;
    },
    setFoamBubbleOctave(v) {
      uFoamBubbleOctave.value = v;
    },
    setFoamBubbleTimeScale(v) {
      uFoamBubbleTimeScale.value = v;
    },
    setFoamGrainAmount(v) {
      uFoamGrainAmount.value = v;
    },
    setFoamGrainOctave(v) {
      uFoamGrainOctave.value = v;
    },
    setFoamGrainTimeScale(v) {
      uFoamGrainTimeScale.value = v;
    },
    setSimClumpLo(v) {
      uSimClumpLo.value = v;
    },
    setSimClumpHi(v) {
      uSimClumpHi.value = v;
    },
    setSimClumpAaPx(v) {
      uSimClumpAaPx.value = v;
    },
    setFlowSpeedPx(v) {
      uFlowSpeedPx.value = v;
    },
    /** WATER_PARAMS `flowAngleDeg` — a COMPASS BEARING (0 = north/up the
     * screen, clockwise), naming the direction the water travels TOWARD. The
     * heading→vector conversion happens here, on the CPU, in `waterFlowVector`
     * — one tested implementation, never a second reading of the convention in
     * a shader. @param {number} v */
    setFlowAngleDeg(v) {
      const dir = waterFlowVector(v);
      uFlowDir.value.set(dir[0], dir[1]);
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
    // ── TIER 4 ────────────────────────────────────────────────────────────
    /** WATER_PARAMS `swashFoam` — waves running up the beach and draining back. */
    setSwashFoam(v) {
      uSwashFoam.value = v;
    },
    /** WATER_PARAMS `breakFoam` — the flow driven into a bank, on the upstream
     * face of every obstacle. The author's own *"break near obstacles"*. */
    setBreakFoam(v) {
      uBreakFoam.value = v;
    },
    /** WATER_PARAMS `foamTrail` — the stateless downstream-tail stand-in
     * (`WATER_TIER4_FOAM_TRAIL`, `water-shore.js#WATER_TAIL_TAPS`). Was wired
     * into `uFoamTrail`/`buildWaterShoreFoam`'s `uTrail` at construction but
     * never actually exposed here, so `water-surface-subsystem.js#sync`'s
     * `surface.setFoamTrail(...)` call threw on every frame — the slider
     * moved and was saved, and nothing downstream ever heard about it. */
    setFoamTrail(v) {
      uFoamTrail.value = v;
    },
    /** WATER_PARAMS `foamEdgeSharpness` — see `WATER_FOAM_EDGE_SHARPNESS_TAP_PX`'s
     * own doc for the full mechanism. 0 = every shore shows foam exactly as
     * before this control existed; 1 = only edges the mask itself paints
     * sharply. */
    setFoamEdgeSharpness(v) {
      uFoamEdgeSharpness.value = v;
    },
    /** WATER_PARAMS `caustics` — a gain on top of the calibrated
     * `WATER_CAUSTICS_K`, never the constant itself (see that constant's own
     * doc for why it is measured, not authored). */
    setCaustics(v) {
      uCaustics.value = v;
    },
    /** WATER_PARAMS `causticSharpness` — how WIDE the bright band around
     * each Worley cell edge reads (`water-field.js#WATER_CAUSTICS_EDGE_FAR_
     * MIN/MAX`'s own doc). 0 = a thick, lacy net, 1 = a hairline net. */
    setCausticSharpness(v) {
      uCausticSharpness.value = v;
    },
    /** WATER_PARAMS `causticScale` — the caustics Worley net's own cell
     * size, as a fraction of `waveScalePx`, independent of the visible
     * chop's own scale. See `water-field.js#WATER_CAUSTICS_SCALE`'s own doc
     * for why this is what actually makes "thin" achievable at all. */
    setCausticScale(v) {
      uCausticScale.value = v;
    },
    /** WATER_PARAMS `causticNetting` — blend weight for a second, finer
     * Worley layer (`WATER_CAUSTICS_NET_SCALE_RATIO`), so the net reads as
     * several overlapping cell sizes rather than one uniform mesh. 0 = the
     * single-layer net. */
    setCausticNetting(v) {
      uCausticNetting.value = v;
    },
    // ── TIER 5 ────────────────────────────────────────────────────────────
    /** THE CAPTURE'S OWN WORLD RECT (`water-refraction-subsystem.js`'s
     * `capturedRect`) — pushed every tick, since a capture can move
     * (rebucket, floor switch) on any frame the body/view intersection
     * changes. See this material's own tier-5 header for why remapping THIS
     * frame's `positionWorld` through LAST frame's rect is correct with no
     * camera-delta math at all. */
    setCapturedRect(r) {
      uCapturedRect.value.set(r.minX, r.minY, r.maxX, r.maxY);
    },
    /** The capture texture's size IN TEXELS — feeds the chromatic fringe's
     * ±1-texel R/B split (`uCapturedTexelUv`). Same guard convention as
     * `setBodyTexSize`: never zero, never non-finite.
     * @param {number} w @param {number} h */
    setCapturedTexSize(w, h) {
      uCapturedTexelUv.value.set(1 / (Number.isFinite(w) && w > 0 ? w : 1), 1 / (Number.isFinite(h) && h > 0 ? h : 1));
    },
    /** `WATER_PARAMS.refractStrengthPx` (water.js) — see that entry's own
     * doc for why this is a wide-range live param now, not the baked
     * `WATER_TIER5_REFRACT_PX` constant. @param {number} v */
    setRefractStrengthPx(v) {
      uRefractStrengthPx.value = v;
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
    /** WATER_PARAMS `shadowResponse` — how completely a cast shadow puts out
     * the sun glint. @param {number} v */
    setShadowResponse(v) {
      specular.setShadowResponse(v);
    },
    /** THE SUN-SHADOW FIELD's world rect, for the floor this water sits on.
     * Pushed by the subsystem whenever the slot it borrows moves. */
    setSunShadowRect(r) {
      specular.setSunShadowRect(r);
    },
    /** 1 when a real sun-shadow field is bound for THIS floor, 0 when none is
     * — see `water-light.js#setSunShadowMix` for why "no field" must read as
     * full sun rather than as full shadow. */
    setSunShadowMix(v) {
      specular.setSunShadowMix(v);
    },
    /** The tier-3 shadow field's own texture node, so the caller can re-point
     * `.value` at whichever per-floor slot currently matches. `null` below tier
     * 3 or when the gate compiled out — callers must guard, the same way they
     * already guard `bodyTexNode`. */
    sunShadowTexNode: specular.sunShadowTexNode ?? null,
    /** For the debug report — whether the outdoors branch is real on this
     * scene or compiled to the indoors constant. */
    outdoorsGateCompiled: specular.outdoorsGateCompiled,
    /** For the debug report — `false` means the sun glint is NOT defeated by
     * cast shadows on this scene (no field texture reached the build), which is
     * silent on screen: the water simply keeps glinting inside a building's
     * shadow, which is what the author reported. */
    sunShadowCompiled: specular.sunShadowCompiled ?? false,
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
    /** WATER_PARAMS `depth` — how deep the whole body reads (Water-Testament
     * §3.3). Rescales absorption/in-scatter magnitude; does not touch colour
     * selection directly (that is `structuralDepth01`, computed per-pixel). */
    setDepth(v) {
      uDepth.value = v;
    },
    /** WATER_PARAMS `pollution` — clear (0) to sludge (1). Blends the whole
     * colour ramp AND adds its own murk on top of `depth`'s absorption scale. */
    setPollution(v) {
      uPollution.value = v;
    },
    /** THE DEPTH-AUTHORITY GATE's own push — `computeTieSafeExpectedDepth(rank,
     * maxRank)` for THIS floor's own background item's rank, on the SAME
     * cadence `window-render.js#setExpectedDepth` uses (every sync, never
     * cached — a floor's own background item can change RANK whenever the
     * depth authority rebuilds, not just on a floor switch). @param {number} v */
    setExpectedDepth(v) {
      uExpectedDepth.value = Number.isFinite(v) ? v : 0;
    },
    /** For the debug report — whether the occlusion gate actually compiled
     * (both a depth texture AND a view rect were present at build time) or
     * fell back to unconditionally-open (paint order alone, pre-migration
     * behaviour). `false` here on a live multi-floor scene means the SAME
     * "renders above things that should mask it" bug this migration fixed. */
    floorGateCompiled,
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
    /** THE INSTRUMENT's OWN SELECTOR (Water-Testament W0) — which
     * `debugMaterial` channel shows. 0 = off, and the CALLER is what makes 0
     * free: it must DETACH the material rather than leave it attached showing
     * channel 0's own (undefined) picture — see `water-surface-subsystem.js#
     * refreshVisibility`. Never a param, never persisted; travels on render
     * state beside `enabled`. @param {number} n */
    setDebugChannel(n) {
      uDebugChannel.value = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    },
  };
}
