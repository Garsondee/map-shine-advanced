/**
 * THE SUN-SHADOW SUBSYSTEM — building + overhead + sky-reach + sky-occlusion,
 * as one owned unit. Extraction step 1 of `docs/planning/VT-Pan-Viewer-
 * Extraction.md` (2026-07-25): the first subsystem pulled out of
 * `vt-pan-viewer.js`'s 10,484-line `startVtPanViewer()`, chosen because it is
 * newest, best-understood, and already had a pure core (`sun-occlusion.js`) +
 * a render module (`sun-occlusion-render.js`) + its own status report — the
 * fewest closure dependencies of anything in that file.
 *
 * ============================================================================
 * THE RULE THIS FOLLOWS (Extraction plan §1)
 * ============================================================================
 *
 * "A subsystem is not extracted while it still reads closure state. No
 * explicit parameter list = it did not happen." Every input this module needs
 * is named below — nothing is reached for from an enclosing scope, because
 * there is no enclosing scope; this is its own module.
 *
 * ⚠️ TWO INPUTS ARE REASSIGNED ELSEWHERE and are taken as GETTERS, not values
 * (Extraction plan trap #1 — the exact class of bug `wind-access.js` and
 * `feedback_residency_sync_vs_render_loop` both name): `shadowHandle` is
 * rebuilt whenever the sky changes; `envLight` does not exist yet at the
 * moment this subsystem is constructed (see §2 below). A getter captured now
 * and called only later, once the real value is guaranteed to exist, is safe;
 * capturing the value itself would freeze it at construction time.
 *
 * ============================================================================
 * §2 — WHY `envLight` IS A GETTER, NOT A CONSTRUCTOR VALUE
 * ============================================================================
 *
 * `buildEnvironmentalLightMaterials` (environmental-light.js) needs THIS
 * subsystem's `fields` as one of ITS OWN construction params — so this
 * subsystem must exist BEFORE `envLight` does. But `bakeLayerTexture` (below)
 * needs to call `envLight.setSunShadowRect(...)` on every rebake. A plain
 * `envLight` parameter captured at construction would be `undefined` (or throw
 * a TDZ ReferenceError for a `const` not yet initialized — the EXACT crash
 * class this project hit live on 2026-07-24 with `SUN_SHADOW_FIELD_DIM`).
 *
 * The fix: `getEnvLight: () => envLight`, a closure written in the CALLER's
 * own scope where `envLight` is a `const` declared moments later. It is only
 * ever INVOKED from inside `bakeLayerTexture`, which only ever runs via
 * `maybeBake()`, which only ever runs from the frame loop — by which time the
 * caller's synchronous setup (including the `const envLight = ...` line) has
 * long finished.
 *
 * ============================================================================
 * §3 — WHY THE ACTUAL GPU CALLS ARE INJECTED, NOT MADE HERE
 * ============================================================================
 *
 * The first draft of this module called `renderer.setRenderTarget(...)` and
 * `new THREE.DataTexture(...)` directly — and `verify-structure.mjs` correctly
 * rejected both: `renderer-state/graph-only` allows `.setRenderTarget(` only
 * inside `vt/`, `graph/`, `diag/`; `gpu/textures-in-vt-only` allows
 * `new ...Texture(` only inside `vt/`. Both walls exist for the exact reason
 * this extraction is happening — V2 scattered these calls across dozens of
 * files and nobody could reason about ownership. Moving this code to
 * `effects/lighting/` does not get a pass just because it USED to live inside
 * `vt/vt-pan-viewer.js`.
 *
 * The fix is the same shape as `getCasterHeightField`/`getSunShadowRenderState`
 * below: the two literal GPU-touching operations are CALLBACKS the caller
 * defines (so the literal `.setRenderTarget(`/`new ...Texture(` text stays
 * inside `vt-pan-viewer.js`, the one place in the codebase both walls already
 * sanction), and this module only decides WHEN to invoke them and WITH WHAT
 * DATA — `renderSunShadowPass(target, quad)` and `createCasterTexture(data, w,
 * h)`. This is the frame-graph pattern the walls themselves prescribe ("A pass
 * declares reads/writes and is HANDED a target") applied a step early, before
 * an actual frame graph exists. Calling each callback once PER SLOT (below) is
 * still exactly this pattern — the callbacks are plain functions, not
 * singletons.
 *
 * ============================================================================
 * §5 — MULTI-FLOOR (2026-08-02) — the gap `Sun-Shadows-Rethink.md` §5 named
 * and left explicitly unfixed, now closed
 * ============================================================================
 *
 * Author, live, on the real Town River Bridge map, after the alpha-slot fix
 * landed: *"when I'm on the middle floor and I'm looking down through a gap in
 * the map I can't see the shadow of the ground floor... when I go up to [the
 * roof] floor I can see shadows which should only be visible on the ground
 * floor. Occlusion of floors below isn't working correctly."* Both symptoms
 * are the SAME cause, from opposite sides: this subsystem baked exactly ONE
 * floor's shadow field at a time (`maybeBake(floorIndex)`, called once per
 * frame with `view.floorIndex` — the UI's "current floor", not "every floor
 * on screen"), and `environmental-light.js`'s per-fragment floor gate
 * (2026-07-28) reads `mix(1, sunVis, floorMatch)` — off the one baked floor,
 * `floorMatch` is 0 and the field is correctly IGNORED... which means a pixel
 * belonging to any OTHER floor gets NO shadow at all, ever, regardless of
 * whether that floor has its own real shadow data. Foundry natively composites
 * several floors in ONE frame (v14 `scene.levels`, gaps and all — this is not
 * an edge case on a multi-storey map), so "one floor's field, gated off
 * everywhere else" was always going to show exactly this: shadow-less floors
 * seen through gaps, and (when the CURRENT floor's own gate momentarily still
 * matches a floor it no longer belongs to, immediately after a floor switch)
 * a stale floor's shadow bleeding onto the wrong content.
 *
 * THE FIX: this subsystem now holds up to `SUN_SHADOW_MAX_FLOORS` independent
 * baked fields ("slots"), one per distinct `floorIndex` the caller has ever
 * asked `maybeBake` for — the caller (`vt-pan-viewer.js`) now asks for EVERY
 * floor in the scene, every frame, not just the active one (§5's own
 * `maybeBake` doc has the cost argument: each slot's rebake is independently
 * cached exactly like the old singular field was, so baking N floors costs
 * baking 1 floor N times only on the (rare) frame something that affects ALL
 * of them — the sun's own position — actually moves). `fields` (returned
 * below) is a FIXED-LENGTH array, built ONCE at construction — every slot's
 * render target exists from the start (so `environmental-light.js` and
 * `point-light-illumination.js`, which each capture `fields[i].texture` at
 * THEIR OWN construction, per the "resize never reallocate" rule below, always
 * have something real to bind) — but a slot's CONTENT stays whatever the
 * "off" placeholder is until some real `floorIndex` actually claims it.
 * `getFloorIndex()` is `-1` for an unclaimed slot, which — by the exact same
 * arithmetic-floor-match formula every consumer already used for the single-
 * field case — provably never matches any real fragment (see
 * `environmental-light.js#blendSunVisibilityAcrossFloors`'s own header for why
 * this must be ARITHMETIC, never a `select()`/branch fold:
 * `feedback_tsl_select_chain_strands_vars`).
 *
 * `SUN_SHADOW_MAX_FLOORS = 6`: comfortably above any scene this project has
 * shadowed live (Town River Bridge has 3), comfortably below the "8" class of
 * hard GPU-stage limit this codebase has hit twice before (storage buffers,
 * vertex buffers — see `keyhole-storage-buffer-limit-fix`/`keyhole-vertex-
 * buffer-limit-fix`). A scene with more floors than that degrades by simply
 * not shadowing the overflow floors (logged once, never silently) rather than
 * risking either limit.
 *
 * ============================================================================
 * §6 — THE SHADOW CASCADE (2026-08-05) — real heights, two bands, and where
 * the blockage went
 * ============================================================================
 *
 * Author: *"use the depth buffer + shadows + sun angle to allow shadows to
 * semi-realistically cascade downwards, getting softer and more diffuse as they
 * do so… buildings which are several stories tall might cast their building,
 * sky reach and overhead shadows and have a much longer larger shadow produced
 * as a result of having access to the information for all floors."*
 *
 * Three things changed here, and each has its own full write-up elsewhere:
 *
 *   1. **The band heights are DERIVED.** `shadow-bands.js#resolveShadowBandPlan`
 *      turns the scene's own Foundry Level elevations plus
 *      `canvas.dimensions.distancePixels` into per-band world-px heights, so a
 *      five-storey stack throws a five-storey shadow. `aboveHeightPx` survives
 *      only as the fallback, and the status report says which was used.
 *   2. **There are TWO bands, not one merged "above".** Band 1 is the floor
 *      ABOVE's own `coverAbove` — a grid `deriveFloorProducts` has always
 *      produced, one floor index away, which is why this cost no new mask
 *      derivation and no second texture (`packLayerTexelData`'s own header).
 *   3. **The cascade's blend factor moved OUT of the layer texture** (freeing
 *      the channel band 1 now uses) and into each slot's own BAKED FIELD's
 *      alpha, published by `setCascade` and read by the slot above from
 *      `lowerFieldTexNode.sample(uv()).a`. Same grid, same value, published by
 *      the slot that already owns it instead of copied into every floor above.
 *
 * ⚠️ THE BAKE ORDER CONTRACT IS UNCHANGED AND STILL LOAD-BEARING. Slots bake
 * bottom-up and slot N reads slot N-1's target, so `assignFloorSlotIndex`'s
 * "slot index IS floor index" identity and the `bakeSerial`/`lastSeenLowerSerial`
 * staleness link both still hold exactly as §5 describes — the cascade now
 * carries one more channel through the same wire, not a new dependency.
 *
 * ============================================================================
 * USAGE (the shape the caller's own two-phase construction takes)
 * ============================================================================
 *
 *   function renderSunShadowPass(target, quad) {
 *     const prev = renderer.getRenderTarget();
 *     renderer.setRenderTarget(target);   // NOT `.target` — see §3 and the
 *     quad.render(renderer);              // module's own bakeSunShadowField.
 *     renderer.setRenderTarget(prev);
 *   }
 *   function createSunShadowCasterTexture(data, w, h) {
 *     const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
 *     tex.minFilter = tex.magFilter = THREE.LinearFilter;
 *     tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
 *     tex.needsUpdate = true;
 *     return tex;
 *   }
 *   const sunShadows = createSunShadowSubsystem({
 *     THREE, allocator, dimensions,
 *     getCasterHeightField, getSunShadowRenderState, getMaskAuthorityVersion,
 *     getShadowHandle: () => shadowHandle,
 *     getEnvLight: () => envLight,
 *     renderSunShadowPass,
 *     createCasterTexture: createSunShadowCasterTexture,
 *   });
 *   const envLight = buildEnvironmentalLightMaterials({
 *     ..., sunShadowFields: sunShadows.fields,
 *   });
 *
 *   // Per frame (light.accumulate, exactly where the inline call used to be):
 *   // `nowMs` — `env.time?.realMs ?? 0` — throttles the actual bake only
 *   // (see `SUN_SHADOW_BAKE_THROTTLE_MS`'s own doc); omit it and every call
 *   // behaves exactly as it did before the throttle existed.
 *   for (const floor of everyFloorInTheScene) sunShadows.maybeBake(floor.index, nowMs);
 *   // Every frame, unconditionally — a slot's REBAKE is rare, but its floor
 *   // attribution must stay correct even on a frame that skipped one:
 *   for (let i = 0; i < sunShadows.fields.length; i++) {
 *     envLight.setSunShadowFloorIndex(i, sunShadows.fields[i].getFloorIndex());
 *   }
 *
 *   // Per-light material build (point-light-illumination.js):
 *   sunShadowFields: sunShadows.fields, attrTexture: sceneColor.textures?.[1] ?? null,
 *
 *   // Diagnostics:
 *   sunShadows: { compiled: envLight.sunShadowCompiled, ...sunShadows.getStatus() },
 *
 *   // Teardown (its own entry in disposeActive's list — see Extraction plan trap #3):
 *   sunShadows.dispose();
 *
 * @module effects/lighting/sun-shadow-subsystem
 */

import { buildLayerSmearBakeMaterial } from './layer-smear-render.js';
import { sunNeedsRebake } from './sun-occlusion.js';
import {
  resolveLayerSmear,
  layerSmearTierPlan,
  layerSmearBakeSamples,
  layerDiffusionBlurPx,
  LAYER_SMEAR_DEFAULT_TIER,
  LAYER_SMEAR_MAX_TIER,
  DEPTH_SCALES,
} from './layer-smear.js';
import { resolveShadowBandPlan, SHADOW_BAND_LAYER_INDICES } from './shadow-bands.js';
import { buildSunShadowDebugMaterial, sunShadowDebugPaints, sunShadowDebugLayers } from './sun-shadow-debug.js';
import { sampleMaskGridWorld } from '../../scene/index.js';
import { createLogger } from '../../core/log.js';

const log = createLogger('SunShadowSubsystem');

/**
 * ============================================================================
 * §4 — THE PERFORMANCE LADDER, AND WHAT MOVES WHEN THE PROFILE DOES
 * ============================================================================
 *
 * Added 2026-07-29 (and re-based 2026-08-02 onto the layer-smear model's own
 * ladder — the SHAPE of this section is unchanged, only which numbers move).
 * Every one of this subsystem's cost numbers comes from the resolved
 * performance rung (`layer-smear.js#layerSmearTierPlan`, fed by
 * `resolveEffectTier` through `getSunShadowRenderState().perfTier`), and this
 * module is where a change to that rung actually costs or saves anything —
 * PER SLOT, since §5 above made a slot the unit of "one floor's field":
 *
 *   fieldDim → `allocator.resize(sunShadowRt, …)`. ⚠️ `setSize` KEEPS THE SAME
 *              `.texture` OBJECT, which is the only reason resizing is safe at
 *              all: `envLight`, every point-light material and the debug view
 *              each captured a SLOT's `.texture` at THEIR own construction
 *              (Extraction plan trap #2 — shared nodes stay shared).
 *              Re-ALLOCATING would hand all three a disposed texture and
 *              blank the map.
 *   steps    → a new bake material, for THAT slot only. The station loop is
 *              unrolled at TSL build time, so it cannot be a uniform; the
 *              material is rebuilt, which is a shader compile, which is why it
 *              only ever happens on a profile change and never per frame.
 *   quantizeDeg → passed straight to `sunNeedsRebake`, so it takes effect on
 *                 the very next frame with nothing to rebuild.
 *
 * AND WHAT "OFF" NOW COSTS. It used to cost a FULL-RESOLUTION bake that wrote
 * white — the pass could not simply be skipped, because the ambient fill always
 * samples this texture, so "no shadow" has to be a written value rather than an
 * unwritten one. That is still true, but a 1×1 white texel satisfies it exactly
 * as well as a 2048² one: a disabled effect now drops its layer field,
 * collapses the target to 1×1 and bakes a single pixel, once, PER SLOT. The
 * residual per-frame cost is the consumers' own texture fetch — now up to
 * `SUN_SHADOW_MAX_FLOORS` 1×1 samples instead of one, stated rather than
 * rounded down (feedback_instruments_must_not_lie).
 */

/** How far the sun must move before a slot is re-baked, at the DEFAULT
 * rung. Without this a running day clock re-bakes every frame — exactly the cost
 * model this design exists to avoid; half a degree is invisible and turns sixty
 * bakes a second into a few a minute. The LIVE value is the resolved rung's
 * (`layerSmearTierPlan(...).quantizeDeg`); this is what `standard` buys, exported
 * so a test can pin the two together. */
export const SUN_SHADOW_QUANTIZE_DEG = layerSmearTierPlan(LAYER_SMEAR_DEFAULT_TIER).quantizeDeg;

/** The minimum feather at the contact point, px — no shadow is a perfect
 * cutout, not even where it meets the wall casting it. Not tiered: it is a
 * LOOK constant, and softening a shadow's contact point on a slow machine
 * would be a different picture, not a cheaper one. Tightened 3→1 2026-08-02
 * (author, live in Shader Lab — the tuned "preferred default" pass). */
export const SUN_SHADOW_BASE_PENUMBRA_PX = 1;

/** Default width of the map-edge ramp (the author's own suggested cure for the
 * shadow gap at the scene boundary — see `buildLayerSmearBakeMaterial`). */
export const SUN_SHADOW_EDGE_BAND_PX = 384;

/**
 * ============================================================================
 * LOOK CONSTANTS, NOT PARAMS — the same doctrine `sun-shadows.js`'s own header
 * states for length/smear/softness, applied to what the layer-smear model adds.
 * ============================================================================
 *
 * A layer's STRENGTH relative to the others, and the shape of its falloff
 * curve, are properties of what "a shadow" IS in this model, not settings a
 * per-scene author should need to balance — the same reasoning that kept this
 * effect at nine-ish params instead of V2's thirty. Tuned once, in Shader Lab,
 * against real geometry (`docs/planning/Sun-Shadows-Layer-Smear.md`); not
 * exposed, so a future look pass changes one number here rather than asking
 * every existing scene's author to re-discover it.
 *
 * `skyReachDepthPx` stays a REAL param (`SUN_SHADOW_PARAMS`) despite this
 * doctrine — it is not "how a shadow looks", it is "how wide is the thing
 * above you", which genuinely varies per map the way `wallHeightPx` already
 * does, and the author asked for it by name.
 */
/** Wall, overhead, floor-above, (unused) — relative to the master
 * `strength01` slider. All three sit just BELOW 1 (not exactly 1) so "a
 * little bit of light should leak through" even at full depth (author,
 * 2026-08-02) without needing a fourth slider to say so. Re-tuned from
 * [1, 0.85, 0.88] to a uniform 0.95 the same day — the author's own
 * "preferred default" pass in Shader Lab, live against real Tower Bridge
 * data, superseding the earlier per-layer split. */
// ⚠️ EXPORTED SO SHADER LAB CAN RENDER THE SAME PICTURE (2026-08-02). These
// three were module-private, so `bench-sun-shadow.js` had its OWN hardcoded
// copies — and they drifted, which is one reason the lab's render stopped
// resembling the author's real scene. Exporting them makes the bench read the
// producer instead of restating it (memory:
// feedback_bench_must_build_inputs_like_production). They remain LOOK
// CONSTANTS, not params: nothing outside this module may WRITE them.
// ⚠️ INDEX 3 WAS EXACTLY 0 UNTIL 2026-08-05, AND THAT ZERO WAS LOAD-BEARING.
// While the A channel carried THE CASCADE's blend factor rather than a
// silhouette, a non-zero strength here would have marched a blockage grid as
// if it were an occluder — so the zero was pinned by a test, not merely
// chosen. The shadow cascade gave A a real second BAND silhouette
// (`packLayerTexelData`'s own header) and moved blockage into the baked
// field's alpha, so index 3 is now an ordinary band and carries the same 0.95
// its sibling does. The pin moved with the reason: `sun-shadow-multi-floor.
// test.mjs` now asserts the two BANDS match each other instead.
export const SUN_SHADOW_LAYER_STRENGTH = Object.freeze([0.95, 0.95, 0.95, 0.95]);
/** Shape of the distance falloff — higher hugs the caster more tightly.
 * 1.6→1 2026-08-02 (author, live — the tuned "preferred default" pass). */
export const SUN_SHADOW_FALLOFF_EXP = 1;
/** How fast the penumbra widens with distance from its caster. */
export const SUN_SHADOW_TIP_BLUR_MUL = 3;

/**
 * How many independent floor slots this subsystem carries (§5). NOT exported:
 * a consumer never needs the cap itself, only `fields.length` (the array it is
 * handed IS the cap, already applied) — see `environmental-light.js`'s own
 * "no `select()`, and no magic number either" reasoning for why the consumer
 * side is written to whatever length it is GIVEN rather than a second copy of
 * this constant.
 */
const SUN_SHADOW_MAX_FLOORS = 6;

/**
 * §5.8 of the 2026-08 perf audit MECHANICALLY CONFIRMED this subsystem reads
 * mask-authority's ONE scene-wide `productsVersion` counter — the SAME
 * counter water and the wind-rebake poll read. Dragging a slider with
 * nothing to do with sun-shadows (wall height, a Tile field, a water mask
 * brushstroke — `touch()` has six call sites, none scoped to "does this
 * affect sun-shadow's own inputs") still bumps it, so `versionChanged` below
 * reads "changed" on every one of those edits too, not just a real caster
 * change. That check is correct and stays O(1) — the thing that is NOT safe
 * to pay for on every one of those bumps is `bakeLayerTexture` (a repack +
 * a 4 MB synchronous DataTexture upload) and the GPU march it forces right
 * behind it (`bakeLayerTexture` nulls `bakedSun`, and `sunNeedsRebake(null,
 * ...)` always answers "yes" — see that function's own `if (!last) return
 * true` — so a version bump chains straight into a full re-march, ~262 M
 * fetches at the default rung per §6.5). Worse than water's own version of
 * this problem: it pays this chained cost **per resident floor slot**, since
 * each slot polls the identical counter independently — up to
 * `SUN_SHADOW_MAX_FLOORS` full chains for one unrelated edit.
 *
 * Mirrors `water-body-subsystem.js#BAKE_THROTTLE_MS`'s own mechanism exactly
 * — read that constant's doc for the full "why a throttle, why it gates the
 * BAKE and not the cheap checks" reasoning, which applies here unchanged.
 * Same 150ms: no live measurement exists yet to justify a different number
 * for this subsystem specifically — a tuning starting point, not a measured
 * optimum, exactly as water's own comment states of itself.
 */
const SUN_SHADOW_BAKE_THROTTLE_MS = 150;

/**
 * PACK THE LAYER TEXTURE'S BYTES — the RGBA layout `buildLayerSmearBakeMaterial`
 * reads, as ONE pure function over already-derived grids.
 *
 * Same extraction discipline as this function's predecessor
 * (`packCasterTexelData`, retired 2026-08-02 with the model it packed for): a
 * standalone pure function so a Node test can pack real grids without standing
 * up the whole subsystem, and Shader Lab reads THIS same function rather than
 * transcribing the rule (`tools/shader-lab/bench-sun-shadow.js`'s own
 * `buildLayerField` is exactly that transcription, TODO'd to call this once
 * this lands — see that function's own header).
 *
 * The channel meanings — `layer-smear-render.js`'s own module header is the one
 * true source, verify against IT if the two ever disagree:
 *
 *   R = walls    (`1 − outdoors` — the `_Outdoors` dark)
 *   G = overhead (this floor's own overhead tiles' coverage)
 *   B = BAND 0 — `coverAbove(F)`,   every floor above this one
 *   A = BAND 1 — `coverAbove(F+1)`, every floor above THAT
 *
 * ⚠️ THE SECOND BAND NEEDED NO NEW DERIVATION (2026-08-05). `packLayerTexelData`'s
 * own previous header called splitting "the floor directly above" from
 * "everything higher" blocked on "a per-floor cover grid `deriveFloorProducts`
 * does not expose yet" — which was wrong, and the reason it was wrong is worth
 * keeping: `coverAbove` is derived PER FLOOR and is CUMULATIVE, so read at the
 * floor ABOVE the receiver it already IS "everything two or more storeys up".
 * The grid was there the whole time, one floor index away
 * ([[feedback_negative_grep_became_architecture]]'s smaller cousin — "the
 * producer does not expose this" was a claim about a call I had not made).
 *
 * @param {object} args
 * @param {object} args.channels - `mask-derive.js`'s `casterChannels` (only
 *   `coverOverhead` is read).
 * @param {object} args.outdoorsGrid - the `outdoors` MaskGrid (its own,
 *   SHARED resolution — see the world-sampling note below).
 * @param {object|null} args.coverAboveGrid - THIS floor's `coverAbove` MaskGrid,
 *   same shared resolution as `outdoors`. `null` reads as "nothing above" rather
 *   than throwing — a floor genuinely can have nothing above it (the roof).
 * @param {object|null} args.bandAboveGrid - the floor ABOVE's `coverAbove`
 *   MaskGrid — band 1. `null` (no such floor, or its products are not derived)
 *   reads as "nothing there".
 * @param {object} args.spec - the OUTPUT grid's `MaskGridSpec` (today,
 *   `channels.coverOverhead`'s own — see `bakeLayerTexture`'s call site for
 *   why that one).
 * @returns {{data: Uint8Array, coveredTexels: number}}
 */
/** The LOD ceiling the report clamps to — must match `layer-smear-render.js`'s
 * own `MAX_LOD`, or the ledger would print a level the shader never requests.
 * Pinned against it by `sun-shadow-blur.test.mjs`. */
const MAX_REPORTED_LOD = 12;

/** A byte at or below this reads as "not covered"; at or above `SOLID_BYTE`,
 * "fully covered". Anything between is a SOFT EDGE texel — the quantity that
 * distinguishes a crisp silhouette from a blurred one. 8/247 is ~3%, wide
 * enough to ignore encoder noise and narrow enough that a genuine
 * anti-aliased edge still counts. */
const EMPTY_BYTE = 8;
const SOLID_BYTE = 247;

/**
 * WHAT THE LAYER TEXTURE ACTUALLY CONTAINS, per channel — the instrument for
 * "why does the live scene not look like Shader Lab".
 *
 * Added 2026-08-02. By this point the SHADER, the model maths, the packing and
 * every look parameter were provably identical between the bench and the game
 * (all four imported from the same modules, defaults read from the same
 * schema) — and the pictures still disagreed. That leaves exactly one
 * suspect: the TEXTURE the two feed that shared shader. Nothing measured it,
 * so the comparison stayed a matter of opinion about two screenshots.
 *
 * @param {Uint8Array|Uint8ClampedArray} data - the packed RGBA layer texture.
 * @param {number} w @param {number} h
 * @returns {{walls:object, overhead:object, floorAbove:object, higher:object, thresholds:object}}
 */
export function describeLayerChannels(data, w, h) {
  const n = w * h;
  const channel = (offset) => {
    let covered = 0;
    let soft = 0;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const v = data[i * 4 + offset];
      sum += v;
      if (v > max) max = v;
      if (v > EMPTY_BYTE) covered++;
      if (v > EMPTY_BYTE && v < SOLID_BYTE) soft++;
    }
    return {
      coveredPct: n > 0 ? +((covered / n) * 100).toFixed(1) : 0,
      softEdgePct: n > 0 ? +((soft / n) * 100).toFixed(1) : 0,
      meanByte: n > 0 ? +(sum / n).toFixed(1) : 0,
      maxByte: max,
    };
  };
  return {
    walls: channel(0),
    overhead: channel(1),
    // Named for what the channels actually hold since 2026-08-05 — two
    // cumulative bands, not "the floor above" and an empty slot. A report that
    // still said `floorAbove`/`higher` would be describing the packing this
    // one replaced (`feedback_instruments_must_not_lie`).
    band0: channel(2),
    band1: channel(3),
    thresholds: {
      emptyAtOrBelow: EMPTY_BYTE,
      solidAtOrAbove: SOLID_BYTE,
      note: 'coveredPct here counts bytes > 8, unlike casterField.coveredPct which counts > 0',
    },
  };
}

/**
 * THE BLUR LEDGER — every mip level a bake's OWN reads will actually ask the
 * sampler for, computed from the same formulas the shader uses, with no GPU
 * readback. See `sun-shadow-blur.test.mjs`'s own header for the two real bugs
 * this made obvious the moment it existed.
 *
 * @param {object} args
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} args.rect
 * @param {number} args.layerGridDimPx
 * @param {number} args.maxThrowPx
 * @param {number} args.steps
 * @param {number} args.softnessMul
 * @param {number} args.depthRadiusPx
 * @returns {object}
 */
export function describeBakeBlur({ rect, layerGridDimPx, maxThrowPx, steps, softnessMul, depthRadiusPx }) {
  if (!(layerGridDimPx > 0)) return { unmeasurable: 'no layer texture uploaded yet' };
  const spanWorldPx = Math.max(rect.maxX - rect.minX, rect.maxY - rect.minY);
  const texelWorldPx = spanWorldPx / layerGridDimPx;
  const lodOf = (worldPx) => Math.min(MAX_REPORTED_LOD, Math.max(0, Math.log2(Math.max(1, worldPx / texelWorldPx))));
  const tipBlurPx = Math.max(1, (maxThrowPx / Math.max(1, steps)) * softnessMul * SUN_SHADOW_TIP_BLUR_MUL);
  const tipLod = lodOf(tipBlurPx);
  const directional = {
    tipBlurPx: +tipBlurPx.toFixed(1),
    tipLod: +tipLod.toFixed(2),
    limitedBy: tipLod >= MAX_REPORTED_LOD ? 'lodCeiling' : tipBlurPx <= texelWorldPx ? 'texelFloor' : 'blur',
  };
  const depthGradient =
    depthRadiusPx > 0
      ? Array.from({ length: DEPTH_SCALES }, (_, i) => {
          const scale = (i + 1) / DEPTH_SCALES;
          const radiusPx = depthRadiusPx * scale;
          const lod = Math.min(MAX_REPORTED_LOD, lodOf(radiusPx));
          return {
            radiusPx: Math.round(radiusPx),
            lod: +lod.toFixed(2),
            mapSpanTexels: +(layerGridDimPx / Math.pow(2, lod)).toFixed(1),
            worldPxPerTexel: +(texelWorldPx * Math.pow(2, lod)).toFixed(0),
          };
        })
      : 'off (depthRadiusPx is 0)';
  return {
    texelWorldPx: +texelWorldPx.toFixed(2),
    directional,
    depthGradient,
    coarsestReadCoversWorldPx: Array.isArray(depthGradient)
      ? depthGradient[depthGradient.length - 1].worldPxPerTexel
      : Math.round(texelWorldPx * Math.pow(2, tipLod)),
  };
}

/**
 * THE SOURCE GRID, BEFORE PACKING — `channelStats.walls` is DERIVED
 * (`255 - outdoors`), so a surprise there could come either from the grid or
 * from the packing arithmetic that packs it. This separates them without a
 * second decode.
 *
 * @param {{spec:{w:number,h:number}, data:Uint8Array}|null} grid
 */
export function describeSourceGrid(grid) {
  if (!grid?.data?.length) return null;
  const d = grid.data;
  let sum = 0;
  let dark = 0;
  for (let i = 0; i < d.length; i++) {
    sum += d[i];
    if (d[i] <= EMPTY_BYTE) dark++;
  }
  return {
    w: grid.spec?.w ?? 0,
    h: grid.spec?.h ?? 0,
    meanByte: +(sum / d.length).toFixed(1),
    nearBlackPct: +((dark / d.length) * 100).toFixed(1),
  };
}

export function packLayerTexelData({ channels, outdoorsGrid, coverAboveGrid, bandAboveGrid = null, spec }) {
  const { w, h } = spec;
  const data = new Uint8Array(w * h * 4);
  let coveredTexels = 0;
  // ⚠️⚠️ A IS THE SECOND BAND NOW (2026-08-05, the shadow cascade) — the floor
  // ABOVE's own `coverAbove`, i.e. the union of every floor two or more storeys
  // up. `shadow-bands.js`'s header has the decomposition and why the bands are
  // cumulative (and therefore NESTED) rather than one grid per floor.
  //
  // ⚠️ IT USED TO CARRY THE CASCADE'S BLEND FACTOR, and that is now published
  // by the lower SLOT itself, in its own baked field's alpha
  // (`layer-smear-render.js#uCascade`) — the same grid, from the slot that
  // already owns it, rather than a second copy packed into every floor above.
  // That is what freed this channel, at zero extra memory: the alternative was
  // a whole second `w × h × 4` DataTexture per floor slot, which at the Extreme
  // rung is 16 MB × 6 floors ([[keyhole-device-loss-large-map]] is why that is
  // stated in MB rather than waved through).
  //
  // ⚠️ LAYER 3 NOW CASTS FOR REAL. `SUN_SHADOW_LAYER_STRENGTH[3]` was pinned at
  // exactly 0 for as long as this channel held blockage, precisely so a
  // non-silhouette could not be marched as one. That pin is GONE with the
  // reason for it — see that constant's own note.
  //
  // ⚠️ `outdoors`, `coverAbove` AND `bandAbove` MUST BE WORLD-SAMPLED, NEVER
  // FLAT-INDEXED BY `i` (2026-07-30 — the casterGridDim/Quality-Extreme
  // corruption bug, `packCasterTexelData`'s own header has the full
  // post-mortem). All three live at the SHARED grid resolution (every effect's
  // shared budget — water/wind/specular too), independent of whatever
  // resolution THIS output `spec` asks for; indexing them with this loop's flat
  // `i` silently reinterprets one row stride as another the moment the two
  // resolutions diverge. `channels.coverOverhead` is natively at `spec`'s own
  // resolution (it is WHERE `spec` came from), so it alone is safe to
  // flat-index.
  for (let gy = 0; gy < h; gy++) {
    const wy = spec.y + (gy + 0.5) * spec.texelH;
    for (let gx = 0; gx < w; gx++) {
      const wx = spec.x + (gx + 0.5) * spec.texelW;
      const i = gy * w + gx;
      const outdoorsByte = sampleMaskGridWorld(outdoorsGrid, wx, wy) ?? 255;
      const overheadCoverage = channels.coverOverhead?.data[i] ?? 0;
      const aboveByte = coverAboveGrid ? (sampleMaskGridWorld(coverAboveGrid, wx, wy) ?? 0) : 0;
      // Absent (no floor two storeys up, or its products are not derived yet)
      // = 0, i.e. NOTHING THERE — the opposite polarity from the blockage this
      // channel used to carry, and deliberately so: an absent SILHOUETTE must
      // cast nothing, where an absent BLOCKAGE had to read fully-blocking. Same
      // channel, opposite safe default, because they are opposite questions
      // (`feedback_gate_polarity_must_fail_open`).
      const bandAboveByte = bandAboveGrid ? (sampleMaskGridWorld(bandAboveGrid, wx, wy) ?? 0) : 0;
      const wallByte = 255 - outdoorsByte;
      data[i * 4 + 0] = wallByte;
      data[i * 4 + 1] = overheadCoverage;
      data[i * 4 + 2] = aboveByte;
      data[i * 4 + 3] = bandAboveByte;
      if (wallByte > 0 || overheadCoverage > 0 || aboveByte > 0 || bandAboveByte > 0) coveredTexels++;
    }
  }
  return { data, coveredTexels, channelStats: describeLayerChannels(data, w, h) };
}

/**
 * ONE FLOOR'S BAKED FIELD — everything the old singular subsystem held at
 * module scope, mechanically re-scoped into an instantiable slot (§5). The
 * BAKE LOGIC ITSELF IS UNCHANGED from before the multi-floor rewrite; only the
 * storage moved from "one copy, module-level" to "N copies, one per slot".
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.allocator
 * @param {{sceneRect: object}} args.dimensions
 * @param {(floorIndex: number) => object|null} args.getCasterHeightField
 * @param {(() => {floors: object[], pxPerElevationUnit: number})|null} args.getShadowFloorPlan -
 *   THE SHADOW CASCADE's own seam (2026-08-05): the scene's real floor
 *   elevations plus Foundry's own px-per-distance-unit, so `shadow-bands.js`
 *   can turn "three storeys up" into world pixels. A LIVE getter for the same
 *   reason `getShadowHandle` is one — a floor's elevation can change under a
 *   GM's hands mid-session, and a value captured at construction would pin
 *   every shadow in the scene to whatever the levels looked like at boot.
 *   Absent/null falls back to `SUN_SHADOW_PARAMS.aboveHeightPx`, the authored
 *   slider this derivation replaces, and SAYS SO in the status report.
 * @param {() => {enabled: boolean, params: object}} args.getSunShadowRenderState
 * @param {(() => number)|null} args.getMaskAuthorityVersion
 * @param {() => {atmosphere: object}} args.getShadowHandle
 * @param {() => object} args.getEnvLight - LIVE getter; used ONLY for the
 *   debug view's borrowed `uViewRect` (the camera rect really is global — one
 *   camera, not one per floor). The rect PUSH goes through `pushRect` instead
 *   (below), because that IS per-slot.
 * @param {(target: *, quad: *) => void} args.renderSunShadowPass
 * @param {(data: Uint8Array, w: number, h: number) => *} args.createCasterTexture
 * @param {(rect: {minX:number,minY:number,maxX:number,maxY:number}) => void} args.pushRect -
 *   bound by the caller to `envLight.setSunShadowRect(thisSlotIndex, rect)` —
 *   see this module's own §5 for why a slot pushes to ITS OWN uniform set
 *   rather than a single shared one.
 * @param {string} args.rtName - this slot's own `allocator.create` name
 *   (`scene.sunShadow.slot0`, `.slot1`, ...) — distinct names so the allocator
 *   (and any GPU debugger reading resource labels) can tell the six apart.
 * @returns {object} the slot's own API — texture/getRect/getFloorIndex/
 *   maybeBake/getDebugQuad/getStatus/dispose, one instance per slot.
 */
/**
 * PURE slot-assignment bookkeeping (§5) — first-come, permanent, capped. No
 * THREE, no GPU state; kept separate from `createFloorSlot`'s GPU-heavy body
 * specifically so THIS part (an off-by-one, a floor stealing another's slot,
 * a cap that doesn't actually cap — ordinary JS mistakes, not GPU ones) is
 * directly testable in Node, the same "CPU twin, proven independently of the
 * GPU side" discipline `layer-smear.js` already uses for the bake maths
 * (`feedback_smooth_output_hides_ported_bugs`) — `sun-shadow-subsystem.test.mjs`
 * exercises this function directly, never a mocked THREE.
 *
 * @param {Map<number, number>} slotIndexByFloor - MUTATED in place:
 *   floorIndex -> slot index. Pass the SAME map back on every call for one
 *   subsystem instance — a fresh map every call would never remember an
 *   earlier claim and every floor would fight over slot 0.
 * @param {number} floorIndex
 * @param {number} maxSlots
 * @returns {number} the assigned (or previously-assigned) slot index, or -1
 *   if `floorIndex` is new AND every slot already belongs to a DIFFERENT
 *   floor — the caller decides how to log that once.
 */
export function assignFloorSlotIndex(slotIndexByFloor, floorIndex, maxSlots) {
  // ⚠️ SLOT INDEX *IS* FLOOR INDEX (2026-08-02, rewritten from a first-come
  // allocator). THE CASCADE made the old scheme unsafe: slot N's bake material
  // is wired at CONSTRUCTION time to read slot N-1's render target, so "the
  // slot below me holds the floor below me" has to be structurally true, not a
  // consequence of the caller happening to ask for floors in ascending order.
  // First-come allocation made that an unenforced invariant one reordered loop
  // away from silently cascading the wrong floor's shadow — and a wrong
  // cascade looks like a plausible shadow, not like a crash.
  //
  // Foundry's own floor indices are contiguous 0..N-1 (`getActiveSceneFloors`
  // enumerates and numbers them itself), so identity costs nothing and deletes
  // a whole class of question. The map is kept purely so `slotsUsed` and the
  // overflow warning can still report which floors were actually asked for.
  if (!Number.isInteger(floorIndex) || floorIndex < 0 || floorIndex >= maxSlots) return -1;
  slotIndexByFloor.set(floorIndex, floorIndex);
  return floorIndex;
}

function createFloorSlot({
  THREE,
  allocator,
  dimensions,
  getCasterHeightField,
  getShadowFloorPlan,
  getSunShadowRenderState,
  getMaskAuthorityVersion,
  getShadowHandle,
  getEnvLight,
  renderSunShadowPass,
  createCasterTexture,
  pushRect,
  rtName,
  lowerField = null,
}) {
  // ── STATE (was 11 viewer-closure locals; now one slot's own) ────────────
  //
  // A 1×1 EMPTY layer field — no casters, and (critically) a receiver gate of
  // ZERO, so the bake is a provable no-op before any real field exists.
  // Deliberately NOT white (which would read as "a 2048px building on every
  // texel" — the whole map in shadow from frame one, the exact black-screen-
  // by-construction class `keyhole-grade-engine-built` already named once for
  // the LUT tail). A placeholder whose failure mode is invisible beats one
  // whose failure mode is a black screen.
  let casterTexture = createCasterTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  let casterRect = { ...dimensions.sceneRect };
  /** Whether the live layer field has ANY coverage at all — the layer-smear
   * model's replacement for the old `casterMaxHeightPx > 0` enable-check.
   * `casterMaxHeightPx` sized the OLD model's march reach from the field's
   * OWN tallest caster; this model's reach comes from AUTHORED heights
   * (`SUN_SHADOW_PARAMS`), never measured from the field, so "how tall is the
   * tallest thing" stopped being a question this subsystem needs answered —
   * only "is there anything here at all" still is. */
  let casterHasCoverage = false;
  /** The last bake's inputs + outcome, verbatim, for the status report. */
  let lastSunShadowBake = null;
  /** The sun the live field was baked for (null = never baked). */
  let bakedSun = null;
  /** The version of the caster field the live texture was built from. */
  let casterFieldVersion = -1;
  /** The floor the live caster field belongs to. -1 = this slot has never
   * been claimed by a real floor — see this module's own §5 for why -1 must
   * provably never match any real fragment's floor index. */
  let casterFieldFloor = -1;
  let lastCasterBakeResult = null;
  let lastSunShadowParamsKey = '';
  /** False while `casterTexture` is still the 1×1 placeholder (never uploaded,
   * or dropped because the effect went off). A plain "has the mask version
   * moved" test cannot answer this — the version is identical on the frame the
   * effect is switched back on — so re-enabling would otherwise show no shadow
   * until something else happened to dirty a mask. */
  let casterFieldLoaded = false;
  // BAKE-GATE HEALTH (cache-completeness pass, 2026-08-12) — TWO separate
  // gates in this one slot, tracked separately because they can diverge (the
  // caster field can go stale without the sun/params/cascade gate tripping,
  // and vice versa): casterField* covers the `version !== casterFieldVersion`
  // check just below (the chamfer/coverage bake over the caster height
  // field); sunShadow* covers the multi-condition OR further down
  // (params/geometry/cascade/sun-angle — the actual shadow-field bake). Same
  // bakeRuns/bakeSkips doctrine as mask-authority.js's own recomputeIfDirty.
  let casterFieldBakeRuns = 0;
  let casterFieldBakeSkips = 0;
  let sunShadowBakeRuns = 0;
  let sunShadowBakeSkips = 0;
  /** True once the collapsed 1×1 white field has been written for the current
   * "off" spell, so being off costs one 1×1 draw in total rather than one per
   * frame. Cleared the moment the effect is enabled again. */
  let offFieldWritten = false;
  /** ⚠️ THE CASCADE'S STALENESS LINK. Bumped on every real bake of THIS slot,
   * and compared by the slot ABOVE — because this slot's content is an INPUT
   * to that one now. Without it, a frame where floor 0 rebakes (the sun moved,
   * a mask changed) but floor 1's own inputs did not would leave floor 1
   * showing floor 0's PREVIOUS shadow through every hole: correct-looking,
   * quietly one bake behind, and drifting further every time the two diverge.
   * A counter rather than a dirty flag so a slot that skipped several of the
   * floor below's bakes still detects it with one integer compare. */
  let bakeSerial = 0;
  let lastSeenLowerSerial = -1;
  /** Wall-clock ms of the last COMPLETED bake (either half of the pair —
   * see `SUN_SHADOW_BAKE_THROTTLE_MS`'s own doc), `-Infinity` so the very
   * first real bake of a session is never throttled. Compared only against a
   * caller-supplied `nowMs` — this module samples no clock of its own,
   * exactly as `water-body-subsystem.js#lastBakeWallClockMs` documents in
   * full. */
  let lastBakeWallClockMs = -Infinity;

  // ── THE RESOLVED RUNG (§4) ───────────────────────────────────────────────
  // Constructed at the DEFAULT rung, not at the live one: `getSunShadowRenderState()`
  // is boot's readout, which has not been through its first cascade resolve at
  // the moment this factory runs. The first `maybeBake` sets the real rung —
  // one resize and at most one material rebuild, at startup, on the frame the
  // profile is first known. That is strictly better than reading a value that
  // is not there yet and calling it the profile's answer.
  let activeTier = LAYER_SMEAR_DEFAULT_TIER;
  let activePlan = layerSmearTierPlan(activeTier);
  /** The live field resolution — `activePlan.fieldDim` normally, 1 while the
   * effect is off. A separate variable rather than a derived one BECAUSE they
   * genuinely differ: the rung stays whatever the profile bought while the
   * effect is switched off, so turning it back on restores that rung rather
   * than the cheapest one. */
  let activeFieldDim = activePlan.fieldDim;
  /** What the LIVE bake material was actually built with, so `applyQuality`
   * can tell a real change from a re-resolve of the same rung. Declared HERE,
   * above every function that reads them, rather than beside the function that
   * writes them: Extraction plan trap #4 is a temporal-dead-zone crash this very
   * file already caused once. */
  let builtSteps = activePlan.steps;
  /** ⚠️ THE LAYER TEXTURE'S OWN RESOLUTION (texels a side), set ONLY from the
   * texture `bakeLayerTexture` actually just uploaded (`spec.w`) — NEVER from
   * `activeFieldDim`/`plan.fieldDim`, which is a DIFFERENT number (the OUTPUT
   * bake target's own resolution). Conflating the two fed §4's mip-LOD math
   * the wrong texel size in the previous model (Quality-tier banding,
   * Extreme-tier a visibly mispositioned shadow — `layer-smear-render.js`'s
   * `setField`/its own header has the contract this repeats). Re-pushed on a
   * material rebuild since only a real bake changes it. */
  let layerGridDimPx = 0;

  const sunShadowRtDesc = {
    resolvedW: activeFieldDim,
    resolvedH: activeFieldDim,
    // NOT screenSized: a fixed square in WORLD space, O(1) in map size — a
    // 12000px map and a 2000px map both get exactly this. The whole ladder
    // (512 → 2048) stays at or under the 2048 world-res cap, so no
    // `allowWorldScale` exception is claimed at any rung.
    screenSized: false,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    filter: 'linear',
    depth: false,
  };
  const sunShadowRt = allocator.create(rtName, sunShadowRtDesc);
  /** THIS SLOT'S OWN rect uniform, for the debug view ONLY — see this
   * function's own `getEnvLight` doc for why the CONSUMER push goes through
   * `pushRect` instead. Owning a local copy means debug never has to reach
   * into `envLight`'s per-slot array to find "the entry that's mine". */
  const uDebugShadowRect = THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 1, 1));

  let sunShadowBake = buildLayerSmearBakeMaterial({
    THREE,
    layerTexture: casterTexture,
    // THE CASCADE's second input — the floor below's own render target, whose
    // `.texture` identity is stable for this subsystem's whole life (slots
    // RESIZE, never reallocate), so binding it once here is safe forever.
    lowerFieldTexture: lowerField?.texture ?? null,
    steps: activePlan.steps,
  });
  let sunShadowQuad = new THREE.QuadMesh(sunShadowBake.material);

  /** The world rect the live layer field covers, as the (minX,minY,maxX,maxY)
   * shape both the bake material and `envLight` want. ONE derivation, three
   * readers (`bakeLayerTexture`, `applyQuality`, the public `getRect`) — a
   * second copy of this arithmetic is how the shadow field and the gate that
   * reads it end up covering different halves of the map. */
  function currentRect() {
    return {
      minX: casterRect.x,
      minY: casterRect.y,
      maxX: casterRect.x + casterRect.width,
      maxY: casterRect.y + casterRect.height,
    };
  }

  /**
   * Point the field's resolution at `dim`, if it is not there already.
   *
   * ⚠️ RESIZE, NEVER RE-ALLOCATE — see §4. `WebGLRenderTarget.setSize` mutates
   * the existing target and keeps `.texture` as the SAME JS object, so every
   * consumer that captured THIS SLOT's texture at their own construction keeps
   * reading the thing that is actually being written. Allocating a replacement
   * would leave all of them pointing at a disposed texture — a blank map, from
   * a "tidier" line of code.
   *
   * @param {number} dim
   * @returns {boolean} whether anything moved (the caller must re-bake if so —
   *   a resized target's contents are undefined).
   */
  function applyFieldDim(dim) {
    const next = Math.max(1, Math.floor(dim));
    if (next === activeFieldDim) return false;
    activeFieldDim = next;
    sunShadowRtDesc.resolvedW = next;
    sunShadowRtDesc.resolvedH = next;
    allocator.resize(sunShadowRt, next, next, sunShadowRtDesc);
    // Pushed HERE too, not left to `applyQuality`/`bakeLayerTexture` alone: a
    // resize never actually changes the LAYER texture's own resolution
    // (`layerGridDimPx` — this call re-pushes the cached value, it does not
    // derive a new one from `next`, which is the OUTPUT bake target's
    // dimension and a genuinely different number — see `layerGridDimPx`'s own
    // header for the live bug conflating the two caused, in the previous
    // model). Harmless when a rebake follows immediately (it always does,
    // here); the defensive value is covering the case a future caller calls
    // this in isolation.
    sunShadowBake.setField({ layerGridDimPx });
    return true;
  }

  /**
   * Rebuild the bake material if the step count changed. An unrolled-loop TSL
   * graph, so a step change is a shader compile — rare by design — and every
   * uniform the old material carried has to be pushed into the new one before
   * the next bake reads it. `bakeSunShadowField` re-pushes sun/layers/depth/
   * look/edge on every run; the two that are NOT re-pushed per bake — the
   * layer texture and the field rect/resolution, both owned by
   * `bakeLayerTexture` — are restored here, or the first bake after a profile
   * change would draw a default 1×1 layer field over a unit rect and write a
   * blank shadow.
   *
   * @param {{steps: number}} plan
   * @returns {boolean} whether the material was replaced.
   */
  function applyQuality(plan) {
    if (plan.steps === builtSteps) return false;
    const previous = sunShadowBake;
    sunShadowBake = buildLayerSmearBakeMaterial({
      THREE,
      layerTexture: casterTexture,
      // Re-bound on a rebuild, or a profile change would silently drop the
      // cascade for every floor above the ground one.
      lowerFieldTexture: lowerField?.texture ?? null,
      steps: plan.steps,
    });
    sunShadowQuad = new THREE.QuadMesh(sunShadowBake.material);
    builtSteps = plan.steps;
    // Restore the two pieces of state the new material was born without.
    // ⚠️ `layerGridDimPx`, NEVER `activeFieldDim` — the fresh material's
    // `uLayerGridDim` uniform otherwise starts at its own hardcoded default
    // rather than the LIVE layer texture's actual resolution, silently
    // mis-sizing every mip request until the next real bake happens to fire.
    sunShadowBake.setRect(currentRect());
    sunShadowBake.setField({ layerGridDimPx });
    // NOT `sunShadowQuad.geometry` — `QuadMesh` shares ONE module-level
    // `QuadGeometry` process-wide (see `dispose` below for the same trap).
    previous.material?.dispose?.();
    return true;
  }

  // THE DEBUG VIEW, built LAZILY on first use (sun-shadow-debug.js). Two
  // reasons, both load-bearing: it needs `envLight`'s `uViewRect`, which does
  // not exist while this factory runs (see the module header's §2), and a
  // player who never opens the dropdown should never compile a second
  // fullscreen material for it.
  /** @type {{material: *, setView: Function, setCasterTexture: Function}|null} */
  let debug = null;
  let debugQuad = null;
  let debugViewId = 'off';
  function ensureDebug() {
    if (debug) return debug;
    const env = getEnvLight();
    debug = buildSunShadowDebugMaterial({
      THREE,
      shadowTexture: sunShadowRt.texture,
      casterTexture,
      // `uViewRect` is SHARED, never copied — the debug view must frame the
      // picture exactly as the render it is diagnosing does, or it is
      // diagnosing something else (Extraction plan trap #2). `uShadowRect` is
      // THIS SLOT's own local uniform (`uDebugShadowRect` above), not
      // borrowed — a slot's rect is a per-slot fact now, and reaching into
      // envLight's per-slot array to find "the one that's mine" would be a
      // second, potentially-disagreeing copy of exactly the mapping
      // `pushRect` already exists to keep singular.
      uViewRect: env.uViewRect,
      uShadowRect: uDebugShadowRect,
    });
    debugQuad = new THREE.QuadMesh(debug.material);
    debug.setView(debugViewId);
    return debug;
  }

  /**
   * Upload this floor's occluder layer field as one RGBA texture.
   *
   * THE PACKING — `packLayerTexelData`'s own header is the one true source,
   * verify against IT if this comment ever drifts: R = walls (`1 − outdoors`),
   * G = this floor's own overhead coverage, B = the floor above and everything
   * higher (merged), A = unused (see that function's own note on why a 4th
   * silhouette source is not split out yet).
   *
   * @param {number} floorIndex
   * @returns {object} the outcome, verbatim, for the status report.
   */
  function bakeLayerTexture(floorIndex) {
    let field = null;
    try {
      field = getCasterHeightField(floorIndex);
    } catch (err) {
      return { ok: false, floorIndex, reason: String(err?.message ?? err) };
    }
    const channels = field?.channels;
    const outdoorsGrid = field?.outdoors;
    // `channels.coverOverhead` — NOT `channels.height` (the previous model's
    // own output spec source, a channel this packing no longer reads at
    // all) — is where THIS model's output resolution comes from, since it is
    // the one caster-resolution channel `packLayerTexelData` actually indexes.
    const spec = channels?.coverOverhead?.spec;
    if (!spec || !outdoorsGrid?.data) {
      return { ok: false, floorIndex, reason: 'no layer field for this floor' };
    }
    const { w, h } = spec;
    if (!(w > 0 && h > 0)) return { ok: false, floorIndex, reason: `degenerate grid ${w}x${h}` };

    // BAND 1 — the floor ABOVE's own `coverAbove`, i.e. everything two or more
    // storeys up (`shadow-bands.js`'s header has the decomposition). Fetched
    // through the SAME seam as this floor's own field so a degraded upper floor
    // degrades identically; a throw or a missing floor yields null, which packs
    // as "nothing there" and simply leaves the second band empty.
    //
    // ⚠️ ALWAYS `floorIndex + 1`, NEVER a plan-chosen source index. The BAND
    // PLAN decides HEIGHTS; the SILHOUETTE for band k is `coverAbove(F+k)` by
    // construction, and letting two places choose the source floor is how the
    // grid and the height it is smeared at would end up describing different
    // storeys.
    let bandAboveGrid = null;
    try {
      bandAboveGrid = getCasterHeightField(floorIndex + 1)?.coverAbove ?? null;
    } catch {
      bandAboveGrid = null;
    }
    const { data, coveredTexels, channelStats } = packLayerTexelData({
      channels,
      outdoorsGrid,
      coverAboveGrid: field?.coverAbove ?? null,
      bandAboveGrid,
      spec,
    });

    // `createCasterTexture` is the caller's callback (see §3) — LINEAR
    // filtering so a silhouette edge is a ramp rather than a staircase of
    // mask texels, which the model's contact-hardening depends on.
    const tex = createCasterTexture(data, w, h);

    casterTexture?.dispose();
    casterTexture = tex;
    sunShadowBake.layerTexNode.value = tex;
    debug?.setCasterTexture(tex);
    casterRect = { x: spec.x, y: spec.y, width: spec.width, height: spec.height };
    casterHasCoverage = coveredTexels > 0;
    // ⚠️ `spec.w` — the texture JUST uploaded, in texels — NEVER `activeFieldDim`
    // (a different number: the OUTPUT bake target's own resolution). See
    // `layerGridDimPx`'s own header for the live bug this is the fix for
    // (found in the previous model; the same trap applies here unchanged).
    layerGridDimPx = spec.w;
    const rect = currentRect();
    sunShadowBake.setRect(rect);
    sunShadowBake.setField({ layerGridDimPx });
    uDebugShadowRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
    pushRect(rect);
    // A new field invalidates whatever was baked from the old one.
    bakedSun = null;
    return {
      ok: true,
      floorIndex,
      cols: w,
      rows: h,
      // ⚠️ ZERO WITH A NON-EMPTY ITEM LIST would be the silent failure that hid
      // sky-reach for months under the old model (a floor with no declared
      // `bottomElevation` gave every caster height 0 while counts stayed
      // healthy) — this model has no per-texel height byte to fall silent the
      // same way, but `coveredTexels` is still the one number that tells the
      // same class of lie apart from a genuinely empty floor.
      coveredTexels,
      coveredPct: +((coveredTexels / (w * h)) * 100).toFixed(1),
      // ⚠️ THE SOURCE GRID, BEFORE PACKING. `channelStats.walls` is derived
      // (`255 - outdoors`), so a surprise there could come either from the
      // GRID or from the packing arithmetic. Reporting the grid's own mean
      // splits those in one number: production's walls read 5x the bench's on
      // the same map, and this says whether `outdoors` itself arrived that
      // dark or the packing made it so.
      outdoorsGrid: describeSourceGrid(outdoorsGrid),
      // ⚠️ AND WHICH SOURCES BUILT IT. The grid mean above says a floor is dark;
      // it cannot say WHY, and three plausible theories died on that distinction
      // (2026-08-02). Every `_Outdoors` source feeding this floor, in draw
      // order, with its own content/alpha means — so "the mask is wrong" becomes
      // "THIS source is wrong". `contentMeanByte ≈ 0` beside a healthy
      // `alphaMeanByte` means the composite collapsed to `255 × (1 − alpha)`,
      // i.e. a source that paints nothing is deciding the whole floor.
      outdoorsSources: field?.outdoorsLedger ?? null,
      coverAboveGrid: describeSourceGrid(field?.coverAbove ?? null),
      // ⚠️ PER-CHANNEL, AND `softEdgePct` IS THE ONE THAT MATTERS. See
      // `describeLayerChannels`: with the shader, the model, the packing and
      // every look param now provably shared with Shader Lab, the layer
      // TEXTURE is the only remaining place the two can differ — and this
      // says, in numbers, whether this floor's silhouettes arrived crisp or
      // already blurred. Compare it directly against the bench's own figure
      // for the same floor.
      channelStats,
      completeness: field.completeness ?? null,
      rect,
    };
  }

  /**
   * Give back the uploaded layer field — the memory half of "off costs
   * nothing" (§4). The full-resolution RGBA upload is one `w × h × 4` byte
   * texture per floor, and holding it while the effect is switched off is
   * holding it for nobody.
   *
   * ⚠️ `casterHasCoverage = false` IS THE LOAD-BEARING LINE, not the dispose.
   * `bakeSunShadowField`'s `active` test is `enabled && casterHasCoverage`,
   * and the 1×1 placeholder this restores has a receiver gate of ZERO — so
   * even if something re-baked the field while off, the bake is a provable
   * no-op rather than a full-strength shadow over a stale layer map.
   */
  function dropCasterField() {
    const placeholder = createCasterTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    casterTexture?.dispose?.();
    casterTexture = placeholder;
    sunShadowBake.layerTexNode.value = placeholder;
    debug?.setCasterTexture(placeholder);
    casterHasCoverage = false;
    layerGridDimPx = 0;
    casterFieldLoaded = false;
    lastCasterBakeResult = { ok: false, reason: 'effect off — layer field released' };
    bakedSun = null;
  }

  /**
   * Run the bake into this slot's own render target. Cheap to CALL and
   * expensive to RUN, which is why every caller goes through `maybeBake`
   * instead.
   * @param {string} reason - what triggered this, verbatim, for the report.
   */
  function bakeSunShadowField(reason) {
    const state = getSunShadowRenderState();
    const atmosphere = getShadowHandle().atmosphere;
    const params = state.params ?? {};
    // A DISABLED effect, or a field with nothing in it, bakes WHITE — an
    // explicit, provable "no shadow anywhere" rather than a stale field left
    // multiplying the ambient forever. (The pass cannot simply be skipped:
    // the ambient fill always samples this texture now, so "off" has to be a
    // written value, not an unwritten one — the same correctness gotcha the
    // UI-shadow hit when it stopped having a draw to skip.)
    const active = state.enabled && casterHasCoverage;
    // ⚠️⚠️ THE BAND HEIGHTS ARE DERIVED FROM THE SCENE, NOT AUTHORED (2026-08-05,
    // the shadow cascade — `shadow-bands.js` is the derivation and its header is
    // the argument). `aboveHeightPx` survives ONLY as the fallback for a scene
    // that cannot answer the elevation question, which is why it is still read
    // here rather than deleted: a legacy single-background scene with a raised
    // tile over it has no Level elevations at all, and the slider is the honest
    // answer there. `bandPlan.source` says which happened, in the status report,
    // every bake — a derivation that silently falls back to a slider is
    // indistinguishable from one that never ran (`feedback_seam_default_hides_
    // unwired`).
    const floorPlan = getShadowFloorPlan?.() ?? null;
    const bandPlan = resolveShadowBandPlan({
      floors: floorPlan?.floors ?? null,
      receiverFloorIndex: casterFieldFloor,
      pxPerElevationUnit: floorPlan?.pxPerElevationUnit ?? 0,
      wallHeightPx: params.wallHeightPx ?? 0,
      fallbackAboveHeightPx: params.aboveHeightPx ?? 0,
    });
    // ⚠️ ZEROED WHEN INACTIVE, not read raw — mirrors the previous model's own
    // `active ? casterMaxHeightPx : 0`. Every height at 0 makes
    // `resolveLayerSmear` return `maxThrowPx = 0`, which `layerSmearVisibility`
    // already treats as a provable no-op (its own "no layer reaches anywhere"
    // early return) — the same "off costs nothing, and cannot half-apply"
    // guarantee, reached the model's own way rather than a caller-side branch.
    const heightsPx = active
      ? [params.wallHeightPx ?? 0, params.overheadHeightPx ?? 0, bandPlan.heightsPx[0] ?? 0, bandPlan.heightsPx[1] ?? 0]
      : [0, 0, 0, 0];
    const resolved = resolveLayerSmear({
      azimuthDeg: atmosphere.azimuthDeg,
      elevationDeg: atmosphere.elevationDeg,
      heightsPx,
      // THE LENGTH CONTROLS — global scale + dawn/dusk cap, both folded into
      // the ONE effective tangent `resolveLayerSmear` computes per layer, so
      // the shorter span also means smaller steps (finer, and cheaper). Same
      // contract the previous model's `resolveSunMarch` used.
      lengthScale: params.lengthScale ?? 1,
      maxLengthMul: params.dawnDuskLength ?? 0,
    });
    sunShadowBake.setSun(resolved);
    // THE DEBUG ISOLATION, applied here rather than in the derivation
    // (`sun-shadow-debug.js#sunShadowDebugLayers` has the post-mortem on why
    // the old `include`-based isolation silently stopped isolating). Zeroing a
    // layer's STRENGTH is exactly what Shader Lab's `layerIsolate` does, so
    // "sky-reach only" means the identical thing in both tools.
    const isolate = sunShadowDebugLayers(params.debugView ?? 'off');
    sunShadowBake.setLayers({ strengths: SUN_SHADOW_LAYER_STRENGTH.map((s, i) => s * (isolate[i] ?? 1)) });
    // THE SKY-REACH GRADIENT — the BAND layers only. Walls and overhead are
    // thin casters with no meaningful interior for a receiver to stand deep
    // inside (`layer-smear.js#isotropicDepthTerm`'s own header), so they have
    // never had a radius; both bands do, because "how deep under cover am I"
    // is the same question whichever storey the cover is on. Unlike the
    // strengths/falloff above, this ONE stays a real param — see this file's
    // own "LOOK CONSTANTS, NOT PARAMS" header for why it is the exception.
    //
    // ⚠️ THE INDICES COME FROM THE PACKING, not from two hand-typed zeroes and
    // two hand-typed radii. `layer-smear-render.js` compiles the gradient's
    // reads in for exactly `SHADOW_BAND_LAYER_INDICES` — a radius pushed to any
    // OTHER layer would be silently ignored, which is precisely the class of
    // "an instrument answering a different question than its label" this
    // effect's own debug views were already caught doing once.
    const skyReachPx = active ? (params.skyReachDepthPx ?? 0) : 0;
    const depthRadii = [0, 0, 0, 0];
    for (const i of SHADOW_BAND_LAYER_INDICES) depthRadii[i] = skyReachPx;
    sunShadowBake.setDepth({ radiiPx: depthRadii });
    // THE CASCADE's publication — this slot tells the slot ABOVE how much of
    // the view down it blocks (`layer-smear-render.js#uCascade`). Pushed on
    // every bake, including the "off" ones, because an inactive slot must
    // publish "fully blocked" rather than leaving a stale "wide open".
    sunShadowBake.setCascade({ active });
    sunShadowBake.setLook({
      strength01: active ? Math.max(0, Math.min(1, params.strength01 ?? 1)) * atmosphere.strengthMul : 0,
      softnessMul: atmosphere.softnessMul * Math.max(0.05, params.softnessBias ?? 1),
      basePx: SUN_SHADOW_BASE_PENUMBRA_PX,
      falloffExp: SUN_SHADOW_FALLOFF_EXP,
      tipBlurMul: SUN_SHADOW_TIP_BLUR_MUL,
    });
    sunShadowBake.setEdgeBandPx(params.edgeBandPx ?? SUN_SHADOW_EDGE_BAND_PX);

    // The literal save/bind/render/restore triplet lives in `vt/` (§3) — this
    // module only decides WHEN it needs to run.
    renderSunShadowPass(sunShadowRt, sunShadowQuad);

    bakedSun = { azimuthDeg: atmosphere.azimuthDeg, elevationDeg: atmosphere.elevationDeg };
    // THE CASCADE'S STALENESS LINK — see `bakeSerial`'s own declaration.
    bakeSerial++;
    lastSunShadowBake = {
      reason,
      enabled: !!state.enabled,
      active,
      sun: { ...bakedSun },
      // ⚠️ ALL FOUR, NOT THE FIRST THREE. This used to slice(0,3) because layer
      // 3 was structurally empty; band 1 is a real caster now, and a report
      // that stops one short of the tallest shadow in the scene is exactly the
      // instrument that cannot explain the picture it is describing.
      heightsPx: heightsPx.map((v) => Math.round(v)),
      // ⚠️ WHERE THOSE HEIGHTS CAME FROM — the whole point of the shadow
      // cascade is that the band heights are DERIVED, and a derivation that
      // quietly fell back to the old slider looks identical in every other
      // number here. `source: 'fallback'` with a `reason` is the difference
      // between "this scene has no multi-storey shadows" and "this scene's
      // elevations never reached the bake".
      bands: {
        source: bandPlan.source,
        reason: bandPlan.reason,
        heightsPx: bandPlan.heightsPx.map((v) => Math.round(v)),
        topOfStackPx: Math.round(bandPlan.topOfStackPx),
        topOfStackSource: bandPlan.topOfStackSource,
        // How many floors the LAST band had to swallow beyond its own lowest
        // member. Non-zero means real storeys are being smeared at a height
        // that is not their own — a stated cap, never a silent one
        // (`feedback_silent_cap_corrupts_hard_boundary`).
        mergedFloorsAbove: bandPlan.mergedFloorsAbove,
        pxPerElevationUnit: floorPlan?.pxPerElevationUnit ?? null,
        floorCount: floorPlan?.floors?.length ?? 0,
        // THE "SOFTER AS IT FALLS" TERM, in the same units the blur ledger
        // below reports — so "why is the top band so blurry" is answerable
        // from the report rather than from reading the shader.
        diffusionPx: heightsPx.map((h) =>
          Math.round(layerDiffusionBlurPx(h, atmosphere.softnessMul * Math.max(0.05, params.softnessBias ?? 1)))
        ),
      },
      // WHAT THIS BAKE ACTUALLY COST, not what the ladder says it should have.
      // The rung is reported separately in `getStatus`; these are the numbers
      // the draw above was made of, so a report can never claim a resolution
      // the field is not at (feedback_instruments_must_not_lie).
      tier: activeTier,
      steps: builtSteps,
      fieldDim: activeFieldDim,
      bakeSamples: layerSmearBakeSamples({ fieldDim: activeFieldDim, steps: builtSteps }),
      maxThrowPx: Math.round(resolved.maxThrowPx),
      softnessMul: +(atmosphere.softnessMul * Math.max(0.05, params.softnessBias ?? 1)).toFixed(3),
      // ⚠️ THE BLUR LEDGER — every mip level this bake actually asks the
      // sampler for, computed from the SAME formulas the shader uses (see
      // `describeBakeBlur`). Added 2026-08-02 because "the shadow looks too
      // blurry" was, for a whole session, un-diagnosable from a report that
      // printed resolutions and sample counts but never once said HOW COARSE
      // a read the shader was making. It answers that in numbers, with no GPU
      // readback, and it is directly comparable against Shader Lab's own
      // render of the same scene (`feedback_instruments_must_not_lie` —
      // report the quantity that actually explains the picture).
      blur: describeBakeBlur({
        rect: currentRect(),
        layerGridDimPx,
        maxThrowPx: resolved.maxThrowPx,
        steps: builtSteps,
        softnessMul: atmosphere.softnessMul * Math.max(0.05, params.softnessBias ?? 1),
        depthRadiusPx: active ? (params.skyReachDepthPx ?? 0) : 0,
      }),
    };
    return lastSunShadowBake;
  }

  /**
   * The per-frame question, kept as cheap as it sounds: has anything that
   * ACTUALLY changes THIS floor's shadow changed?
   *
   * ⚠️ Must be called from the FRAME LOOP, never from a residency-triggered
   * function. A uniform sync placed inside a residency pass only updates on
   * pan/zoom — the exact bug that made vegetation's own sliders do nothing
   * until the camera moved (`feedback_residency_sync_vs_render_loop`). The sun
   * moving is not a camera event, so a camera-gated rebake would be silently
   * frozen at dawn.
   *
   * @param {number} floorIndex
   * @param {number} [nowMs] - wall-clock ms (`env.time.realMs`, never a fresh
   *   `performance.now()` — see `lastBakeWallClockMs`'s own doc), used only to
   *   throttle the actual bake work. Optional and defaults to "never
   *   throttle" — the same "predates this dependency, still builds" shape
   *   `water-body-subsystem.js#maybeBake`'s own `nowMs` already uses, so
   *   every caller that predates this parameter (every test in this file
   *   included) keeps its exact old behaviour with no change required.
   */
  function maybeBake(floorIndex, nowMs) {
    casterFieldFloor = floorIndex;
    const state = getSunShadowRenderState();
    const enabled = state.enabled !== false;

    // ── OFF: COLLAPSE, DO NOT MARCH (§4) ──────────────────────────────────
    // Never throttled — already the cheap path (one 1×1 draw per "off" spell,
    // guarded by `offFieldWritten`), not the expensive one the throttle below
    // exists to protect.
    if (!enabled) {
      if (casterFieldLoaded) dropCasterField();
      const collapsed = applyFieldDim(1);
      if (collapsed || !offFieldWritten) {
        bakeSunShadowField('off');
        offFieldWritten = true;
        lastSunShadowParamsKey = '';
      }
      return;
    }

    // ── ON: the resolved rung decides how much field there is to bake ────
    // Read every frame and compared, never assumed: the performance profile is
    // a LIVE client setting with no reload behind it, so a player who drops
    // from Extreme to Standard mid-session must see the cheaper field on the
    // next bake, not on the next scene load.
    //
    // NOT throttled: this reacts to `state.perfTier`, a rare, user-driven
    // setting change — a different input entirely from the mask-authority
    // storm `SUN_SHADOW_BAKE_THROTTLE_MS` defends against — and
    // `applyFieldDim` is a `setSize` (§4: "KEEPS THE SAME `.texture` OBJECT"),
    // never a reallocate, so resizing on a throttled frame is safe; only the
    // bake that fills the (possibly resized) target with real content is what
    // the throttle below may defer, exactly as it would for any other pending
    // change.
    offFieldWritten = false;
    const tier = Number.isFinite(state.perfTier) ? state.perfTier : LAYER_SMEAR_DEFAULT_TIER;
    const plan = layerSmearTierPlan(tier);
    activeTier = tier;
    activePlan = plan;
    // Both of these return "did anything move", and both invalidate the live
    // field when they do — a resized target's contents are undefined, and a
    // rebuilt material has never drawn anything at all.
    //
    // ⚠️ BOTH ARE CALLED UNCONDITIONALLY — NOT `a() || b()`. A rung change can
    // move `fieldDim` and `steps` at once (e.g. `performance` → `standard`),
    // and `||` short-circuits the second call the moment the first returns
    // `true`, silently stranding the OLD quality forever — `fieldDim` never
    // needs to change again once it matches, so the skipped rebuild would
    // never get a second chance.
    const dimChanged = applyFieldDim(plan.fieldDim);
    const qualityChanged = applyQuality(plan);
    const geometryChanged = dimChanged || qualityChanged;

    // ── THE GATES, CHECKED BUT NOT YET ACTED ON — cheap, unthrottled, exactly
    // like water's own `unchanged` comparison. `versionChanged` reads
    // mask-authority's shared counter (`SUN_SHADOW_BAKE_THROTTLE_MS`'s own doc
    // has the full mechanism) — reading `true` does not by itself mean THIS
    // floor's own caster inputs changed, only that they might have.
    // `sunChanged` is read against the CURRENT `bakedSun` purely to decide
    // whether the throttle gate below applies; if `versionChanged` is also
    // true and a real bake runs past the throttle, `bakeLayerTexture` nulls
    // `bakedSun`, and the OR-condition further down re-reads it fresh — see
    // that condition's own comment for why reusing this snapshot there would
    // be wrong.
    const version = getMaskAuthorityVersion ? getMaskAuthorityVersion() : casterFieldVersion;
    const versionChanged = !casterFieldLoaded || version !== casterFieldVersion;
    const paramsKey = JSON.stringify(state.params ?? {}) + `|on|t${activeTier}`;
    const paramsChanged = paramsKey !== lastSunShadowParamsKey;
    // ⚠️ THE FLOOR BELOW IS AN INPUT NOW. Its field is sampled by this slot's
    // own bake, so its rebake dirties this one exactly like a param change
    // would. The caller iterates floors ASCENDING, so by the time this runs
    // the floor below has already rebaked this frame and its serial is final —
    // one frame of lag is impossible rather than merely unlikely.
    const lowerSerial = lowerField ? lowerField.getBakeSerial() : -1;
    const lowerChanged = lowerSerial !== lastSeenLowerSerial;
    const sunChanged = sunNeedsRebake(bakedSun, getShadowHandle().atmosphere, plan.quantizeDeg);

    // ⚠️ THE THROTTLE — see `SUN_SHADOW_BAKE_THROTTLE_MS`'s own doc for the
    // full "shared version counter" mechanism this defends against, and
    // `water-body-subsystem.js#lastBakeWallClockMs` for why this gates the
    // BAKE and not the cheap checks just above. `Number.isFinite` guards a
    // caller that never passes `nowMs` (this function's own JSDoc):
    // `undefined - anything` is `NaN`, and `NaN < SUN_SHADOW_BAKE_THROTTLE_MS`
    // is `false`, so an omitted `nowMs` already never throttles — the explicit
    // check just says so, rather than relying on that fallthrough's own
    // silent behaviour to carry the intent.
    //
    // Gated on `needsBake`, and checked BEFORE any of `casterFieldVersion`/
    // `lastSunShadowParamsKey`/`lastSeenLowerSerial`/`bakedSun` are stamped —
    // the same "safe to retry indefinitely" discipline water's own throttle
    // uses: a quiet poll (nothing changed) still falls through to the
    // ordinary skip counters below, unthrottled and unaffected; a declined
    // REAL change touches no state at all, so the very next poll past the
    // window re-detects the identical pending change and bakes it for real,
    // never silently dropping it.
    const needsBake = versionChanged || paramsChanged || geometryChanged || lowerChanged || sunChanged;
    if (needsBake && Number.isFinite(nowMs) && nowMs - lastBakeWallClockMs < SUN_SHADOW_BAKE_THROTTLE_MS) {
      lastSunShadowBake = {
        reason: 'a real change is pending, throttled to protect this frame — retries next poll',
        floorIndex,
        skipped: true,
      };
      return;
    }

    if (versionChanged) {
      casterFieldBakeRuns += 1;
      casterFieldVersion = version;
      lastCasterBakeResult = bakeLayerTexture(floorIndex);
      casterFieldLoaded = true;
    } else {
      casterFieldBakeSkips += 1;
    }
    if (paramsChanged) lastSunShadowParamsKey = paramsKey;
    lastSeenLowerSerial = lowerSerial;
    // Re-read, NOT the `sunChanged` snapshot above: `bakeLayerTexture` (just
    // above, when `versionChanged`) nulls `bakedSun` on success, which this
    // must see fresh — reusing the stale snapshot here would let a
    // version-only change repack the layer texture and then leave the GPU
    // march stale against it.
    if (
      paramsChanged ||
      geometryChanged ||
      lowerChanged ||
      sunNeedsRebake(bakedSun, getShadowHandle().atmosphere, plan.quantizeDeg)
    ) {
      sunShadowBakeRuns += 1;
      lastBakeWallClockMs = nowMs;
      bakeSunShadowField(
        geometryChanged ? 'profile' : paramsChanged ? 'param' : lowerChanged ? 'cascade' : bakedSun ? 'sun' : 'first'
      );
    } else {
      sunShadowBakeSkips += 1;
    }
  }

  return {
    texture: sunShadowRt.texture,
    getRect: currentRect,
    getFloorIndex() {
      return casterFieldFloor;
    },
    /** THE CASCADE's staleness link, read by the slot ABOVE this one. */
    getBakeSerial() {
      return bakeSerial;
    },
    maybeBake,
    getDebugQuad(viewId) {
      if (!sunShadowDebugPaints(viewId)) return null;
      ensureDebug();
      if (viewId !== debugViewId) {
        debugViewId = viewId;
        debug.setView(viewId);
      }
      return debugQuad;
    },
    getStatus() {
      return {
        floorIndex: casterFieldFloor,
        caster: lastCasterBakeResult ?? 'never baked',
        lastBake: lastSunShadowBake ?? 'never baked',
        // BAKE-GATE HEALTH — see casterFieldBakeRuns' own declaration above
        // for why these are two separate pairs. Lifetime counters for this
        // slot; a caller wanting one window's rate samples before/after,
        // same convention as depth-proxy-material-pool.js.
        bakeGate: {
          casterFieldBakeRuns,
          casterFieldBakeSkips,
          sunShadowBakeRuns,
          sunShadowBakeSkips,
        },
        profile: {
          tier: activeTier,
          maxTier: LAYER_SMEAR_MAX_TIER,
          fieldDim: activeFieldDim,
          layerGridDimPx,
          steps: builtSteps,
          quantizeDeg: activePlan.quantizeDeg,
          bakeSamples: layerSmearBakeSamples({ fieldDim: activeFieldDim, steps: builtSteps }),
          defaultTierSamples: layerSmearBakeSamples(layerSmearTierPlan(LAYER_SMEAR_DEFAULT_TIER)),
        },
      };
    },
    dispose() {
      allocator.dispose(sunShadowRt);
      sunShadowBake.material?.dispose?.();
      debug?.material?.dispose?.();
      casterTexture?.dispose?.();
    },
  };
}

/**
 * Build the subsystem. See this module's own header for the two-phase
 * construction `getEnvLight` requires, §3 for why the two GPU-touching
 * operations are callbacks rather than direct calls, and §5 for the
 * multi-floor slot pool this factory now allocates.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.allocator - `graph/three-allocator.js`'s instance.
 * @param {{sceneRect: object}} args.dimensions
 * @param {(floorIndex: number) => object|null} args.getCasterHeightField -
 *   boot's seam (`scene/sky-reach-access.js` behind it).
 * @param {(() => {floors: object[], pxPerElevationUnit: number})|null} [args.getShadowFloorPlan] -
 *   THE SHADOW CASCADE's own seam — see `createFloorSlot`'s own doc for the
 *   full contract and what its absence falls back to.
 * @param {() => {enabled: boolean, params: object}} args.getSunShadowRenderState
 * @param {(() => number)|null} [args.getMaskAuthorityVersion]
 * @param {() => {atmosphere: object}} args.getShadowHandle - LIVE getter; see header.
 * @param {() => {setSunShadowRect: Function, setSunShadowFloorIndex: Function, uViewRect: *}} args.getEnvLight - LIVE getter; see header.
 * @param {(target: *, quad: *) => void} args.renderSunShadowPass - the literal
 *   save/bind/render/restore triplet, defined in `vt/` (see §3).
 * @param {(data: Uint8Array, w: number, h: number) => *} args.createCasterTexture -
 *   the literal `new THREE.DataTexture(...)` + filter setup, defined in `vt/`.
 * @returns {{
 *   fields: Array<{texture: *, getRect: Function, getFloorIndex: Function}>,
 *   maybeBake: (floorIndex: number, nowMs?: number) => void,
 *   getDebugQuad: (viewId: string, floorIndex: number) => *,
 *   getStatus: () => object,
 *   dispose: () => void,
 * }}
 */
export function createSunShadowSubsystem({
  THREE,
  allocator,
  dimensions,
  getCasterHeightField,
  getShadowFloorPlan,
  getSunShadowRenderState,
  getMaskAuthorityVersion,
  getShadowHandle,
  getEnvLight,
  renderSunShadowPass,
  createCasterTexture,
}) {
  // ── THE SLOT POOL (§5) — built ONCE, eagerly, all SUN_SHADOW_MAX_FLOORS of
  // them, so every consumer that binds `fields[i].texture` at ITS OWN
  // construction (environmental-light.js, point-light-illumination.js) always
  // has something real to bind — an unclaimed slot just stays the tiny "off"
  // placeholder until a real floor claims it (`slotFor`, below). ──────────
  // ⚠️ BUILT SEQUENTIALLY, NOT WITH `Array.from`'s callback ALONE — slot i's
  // bake material is wired at CONSTRUCTION time to read slot i-1's render
  // target (THE CASCADE), so slot i-1 must already exist when slot i is built.
  // Slot index IS floor index (`assignFloorSlotIndex`), so "the slot below me"
  // and "the floor below me" are the same thing by construction.
  const slots = [];
  for (let i = 0; i < SUN_SHADOW_MAX_FLOORS; i++) {
    slots.push(
      createFloorSlot({
        THREE,
        allocator,
        dimensions,
        getCasterHeightField,
        getShadowFloorPlan,
        getSunShadowRenderState,
        getMaskAuthorityVersion,
        getShadowHandle,
        getEnvLight,
        renderSunShadowPass,
        createCasterTexture,
        // Floor 0 has nothing below it — null compiles the cascade out entirely
        // and its shader stays byte-identical to the pre-cascade one.
        lowerField: i === 0 ? null : slots[i - 1],
        // Bound ONCE per slot: this is the ENTIRE multi-floor consumer contract
        // — a slot pushes its own rect to its own uniform set, by INDEX, never
        // by floor identity. Only on a REAL rebake (this fires from inside
        // `bakeLayerTexture`, not every frame) — mirrors the pre-multi-floor
        // split exactly: `setSunShadowRect` on rebake, `setSunShadowFloorIndex`
        // every frame regardless (the caller's own per-frame loop, since a
        // slot's FLOOR ATTRIBUTION must stay correct even on a frame that
        // skipped a rebake — see `maybeBake`'s own doc).
        pushRect: (rect) => getEnvLight().setSunShadowRect(i, rect),
        rtName: `scene.sunShadow.slot${i}`,
      })
    );
  }

  /** floorIndex -> slot INDEX. IDENTITY since 2026-08-02 (see
   * `assignFloorSlotIndex` for why THE CASCADE required that); kept as a map
   * purely so `slotsUsed` and the overflow warning can report which floors
   * were actually asked for. Indices, not slot objects
   * — see `assignFloorSlotIndex`'s own header for why the bookkeeping is kept
   * separate from the THREE-dependent slot objects themselves. */
  const slotIndexByFloor = new Map();
  let warnedOverflow = false;

  /** @param {number} floorIndex @returns {object|null} the slot, or null if
   * every slot is claimed by a DIFFERENT floor already (logged once, never
   * silently — see this module's own §5 for the cap's reasoning). */
  function slotFor(floorIndex) {
    const index = assignFloorSlotIndex(slotIndexByFloor, floorIndex, slots.length);
    if (index === -1) {
      if (!warnedOverflow) {
        warnedOverflow = true;
        log.warn(
          `floor ${floorIndex} has no free slot (cap is ${slots.length}, already claimed by ` +
            `${[...slotIndexByFloor.keys()].join(', ')}) — this floor will not cast or receive sun shadows.`
        );
      }
      return null;
    }
    return slots[index];
  }

  return {
    /** Fixed-length array, built ONCE — stable identity for the life of the
     * subsystem. See this module's own §5 for the full contract. */
    fields: slots.map((s) => ({ texture: s.texture, getRect: s.getRect, getFloorIndex: s.getFloorIndex })),
    /** Bake (or skip re-baking, if nothing that matters moved) the slot this
     * `floorIndex` owns — claiming a fresh slot for it on first call. A
     * `floorIndex` beyond the cap is a silent no-op past the one logged
     * warning: that floor simply never gets a slot, exactly as if it were
     * never asked for.
     * @param {number} floorIndex
     * @param {number} [nowMs] - forwarded verbatim to the slot's own
     *   `maybeBake` — see that function's own doc for the bake throttle this
     *   drives. */
    maybeBake(floorIndex, nowMs) {
      slotFor(floorIndex)?.maybeBake(floorIndex, nowMs);
    },
    /**
     * The fullscreen debug quad to draw INSTEAD of the present pass, or null
     * when the view is `off` or `floorIndex` has no resident slot yet. The
     * viewer draws it — this module never touches the renderer (§3).
     * @param {string} viewId - the `debugView` param's current value.
     * @param {number} floorIndex - which floor's OWN field to inspect —
     *   debug view stays single-floor by design (§5 only multiplied the
     *   CONSUMER path; a diagnostic tool showing one floor at a time is still
     *   the right amount of tool for the job it does).
     */
    getDebugQuad(viewId, floorIndex) {
      // A LOOKUP, never `slotFor` — this must not be the thing that CLAIMS a
      // slot. By the time this runs the frame's own bake loop has already
      // asked for every scene floor (see `vt-pan-viewer.js`'s call site), so
      // an unclaimed floor here means it genuinely was never baked this
      // session, not that this is racing ahead of the bake.
      const index = slotIndexByFloor.get(floorIndex);
      return index === undefined ? null : (slots[index]?.getDebugQuad(viewId) ?? null);
    },
    /** For `boot.js`'s "Sun shadows" report — one entry per CLAIMED slot
     * (never the full SUN_SHADOW_MAX_FLOORS; an unclaimed slot has nothing to
     * say and printing it would just be padding). `compiled` is NOT included —
     * it is a property of `envLight`'s own shader graph, not this subsystem;
     * the caller merges it in (see this module's own USAGE example). */
    getStatus() {
      return {
        floors: slots.filter((s) => s.getFloorIndex() !== -1).map((s) => s.getStatus()),
        slotsUsed: slotIndexByFloor.size,
        slotsTotal: slots.length,
      };
    },
    /** Tear down every slot's OWN GPU state (§5 — dispose is now a fan-out,
     * not a single call; see each slot's own `dispose` for what leaked before
     * this subsystem existed at all). The CALLER must still wire this into the
     * existing teardown registration (`disposeActive`'s list) — this module
     * cannot reach it. */
    dispose() {
      for (const slot of slots) slot.dispose();
    },
  };
}
