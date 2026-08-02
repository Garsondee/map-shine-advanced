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
 * subsystem's `texture` as one of ITS OWN construction params — so this
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
 * long finished. The one-time INITIAL push of the placeholder rect (what the
 * original inline code did synchronously, right after building envLight) stays
 * the CALLER's own explicit responsibility — see this module's own usage
 * example below — because doing it from inside this factory would require
 * calling `getEnvLight()` before `envLight` exists, which is exactly the crash
 * this design avoids.
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
 * an actual frame graph exists.
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
 *     ..., sunShadowTexture: sunShadows.texture,
 *   });
 *   envLight.setOutdoorsRect(outdoorsRect);
 *   envLight.setSunShadowRect(sunShadows.getRect());   // the one-time initial push
 *
 *   // Per frame (light.accumulate, exactly where the inline call used to be):
 *   sunShadows.maybeBake(view?.floorIndex ?? 0);
 *
 *   // Per-light material build (point-light-illumination.js):
 *   sunShadowTexture: sunShadows.texture, uSunShadowRect: envLight.uSunShadowRect,
 *
 *   // Diagnostics:
 *   sunShadows: { compiled: envLight.sunShadowCompiled, ...sunShadows.getStatus() },
 *
 *   // Teardown (its own entry in disposeActive's list — see Extraction plan trap #3):
 *   sunShadows.dispose();
 *
 * ============================================================================
 * A LEAK THIS EXTRACTION FIXES, FOUND WHILE MOVING THE CODE
 * ============================================================================
 *
 * Neither `sunShadowRt` nor `sunShadowBake.material` had ANY registered
 * dispose call anywhere in `vt-pan-viewer.js` — every Stop/Restart cycle
 * leaked one 1024² RGBA8 render target and one NodeMaterial. Not found by
 * looking for it; found because giving the subsystem an honest `dispose()`
 * made the absence visible. `dispose()` below is the fix; the CALLER must
 * still wire it into the existing teardown (this module cannot reach into
 * `disposeActive`'s registration list itself — see the Extraction plan's own
 * "not a rewrite" rule: wiring the call is a one-line follow-up, not bundled
 * silently into this move).
 *
 * @module effects/lighting/sun-shadow-subsystem
 */

import { buildLayerSmearBakeMaterial } from './layer-smear-render.js';
import { sunNeedsRebake } from './sun-occlusion.js';
import {
  resolveLayerSmear,
  layerSmearTierPlan,
  layerSmearBakeSamples,
  LAYER_SMEAR_DEFAULT_TIER,
  LAYER_SMEAR_MAX_TIER,
  DEPTH_SCALES,
} from './layer-smear.js';
import { buildSunShadowDebugMaterial, sunShadowDebugPaints, sunShadowDebugLayers } from './sun-shadow-debug.js';
import { sampleMaskGridWorld } from '../../scene/index.js';

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
 * module is where a change to that rung actually costs or saves anything:
 *
 *   fieldDim → `allocator.resize(sunShadowRt, …)`. ⚠️ `setSize` KEEPS THE SAME
 *              `.texture` OBJECT, which is the only reason resizing is safe at
 *              all: `envLight`, every point-light material and the debug view
 *              each captured `sunShadows.texture` at THEIR own construction
 *              (Extraction plan trap #2 — shared nodes stay shared).
 *              Re-ALLOCATING would hand all three a disposed texture and
 *              blank the map.
 *   steps    → a new bake material. The station loop is unrolled at TSL build
 *              time, so it cannot be a uniform; the material is rebuilt, which
 *              is a shader compile, which is why it only ever happens on a
 *              profile change and never per frame.
 *   quantizeDeg → passed straight to `sunNeedsRebake`, so it takes effect on
 *                 the very next frame with nothing to rebuild.
 *
 * AND WHAT "OFF" NOW COSTS. It used to cost a FULL-RESOLUTION bake that wrote
 * white — the pass could not simply be skipped, because the ambient fill always
 * samples this texture, so "no shadow" has to be a written value rather than an
 * unwritten one. That is still true, but a 1×1 white texel satisfies it exactly
 * as well as a 2048² one: a disabled effect now drops its layer field,
 * collapses the target to 1×1 and bakes a single pixel, once. The residual
 * per-frame cost is the consumers' own texture fetch, which is a 1×1 sample and
 * not zero — stated rather than rounded down (feedback_instruments_must_not_lie).
 */

/** How far the sun must move before the field is re-baked, at the DEFAULT
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
export const SUN_SHADOW_LAYER_STRENGTH = Object.freeze([0.95, 0.95, 0.95, 0]);
/** Shape of the distance falloff — higher hugs the caster more tightly.
 * 1.6→1 2026-08-02 (author, live — the tuned "preferred default" pass). */
export const SUN_SHADOW_FALLOFF_EXP = 1;
/** How fast the penumbra widens with distance from its caster. */
export const SUN_SHADOW_TIP_BLUR_MUL = 3;

/**
 * Build the subsystem. See this module's own header for the two-phase
 * construction `getEnvLight` requires and §3 for why the two GPU-touching
 * operations are callbacks rather than direct calls.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.allocator - `graph/three-allocator.js`'s instance.
 * @param {{sceneRect: object}} args.dimensions
 * @param {(floorIndex: number) => object|null} args.getCasterHeightField -
 *   boot's seam (`scene/sky-reach-access.js` behind it).
 * @param {() => {enabled: boolean, params: object}} args.getSunShadowRenderState
 * @param {(() => number)|null} [args.getMaskAuthorityVersion]
 * @param {() => {atmosphere: object}} args.getShadowHandle - LIVE getter; see header.
 * @param {() => {setSunShadowRect: Function}} args.getEnvLight - LIVE getter; see header.
 * @param {(target: *, quad: *) => void} args.renderSunShadowPass - the literal
 *   save/bind/render/restore triplet, defined in `vt/` (see §3).
 * @param {(data: Uint8Array, w: number, h: number) => *} args.createCasterTexture -
 *   the literal `new THREE.DataTexture(...)` + filter setup, defined in `vt/`.
 * @returns {{
 *   texture: *,
 *   getRect: () => {minX:number,minY:number,maxX:number,maxY:number},
 *   maybeBake: (floorIndex: number) => void,
 *   getStatus: () => object,
 *   dispose: () => void,
 * }}
 */
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
 *   R = walls            (`1 − outdoors` — the `_Outdoors` dark)
 *   G = overhead          (this floor's own overhead tiles' coverage)
 *   B = the floor above, and everything higher, merged (`coverAbove`)
 *   A = unused — `SHADOW_LAYER_COUNT` is 4 but this bake only has 3 REAL
 *       silhouette sources today (walls, overhead, "above ∪ higher" already
 *       merged by `coverAbove` itself); splitting "the floor directly above"
 *       from "everything higher" into two channels needs a per-floor cover
 *       grid `deriveFloorProducts` does not expose yet. Left EMPTY and said
 *       out loud rather than quietly duplicated into B, so the gap stays
 *       visible instead of looking finished (`layer-smear-render.js`'s own
 *       header documents the same gap for Shader Lab's synthetic packing).
 *
 * @param {object} args
 * @param {object} args.channels - `mask-derive.js`'s `casterChannels` (only
 *   `coverOverhead` is read).
 * @param {object} args.outdoorsGrid - the `outdoors` MaskGrid (its own,
 *   SHARED resolution — see the world-sampling note below).
 * @param {object|null} args.coverAboveGrid - the `coverAbove` MaskGrid, same
 *   shared resolution as `outdoors`. `null` reads as "nothing above" rather
 *   than throwing — a floor genuinely can have nothing above it (the roof).
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
 * `softEdgePct` is the load-bearing number. A silhouette rasterised at its
 * native resolution is nearly binary — a few percent of texels sit between
 * empty and solid, only along real edges. A silhouette UPSAMPLED from a
 * coarser source (a mask ingested at a low mip, then resampled into a finer
 * grid) is soft everywhere, and its `softEdgePct` climbs accordingly. That
 * single figure separates "the shader blurred it" from "the input arrived
 * blurred", which is the fork this whole investigation is stuck on.
 *
 * Cheap: one pass over bytes already in hand, no GPU readback, no second
 * decode. Runs on every bake, which is rare by design.
 *
 * @param {Uint8Array} data - the packed RGBA layer texture.
 * @param {number} w @param {number} h
 * @returns {object} per-channel stats, keyed by the channel's MEANING.
 */
export function describeLayerChannels(data, w, h) {
  const n = w * h;
  const names = ['walls', 'overhead', 'floorAbove', 'higher'];
  // ⚠️ SELF-DESCRIBING ON PURPOSE. `casterField.coveredPct` (one level up)
  // counts any byte `> 0`, while these count `> EMPTY_BYTE`. Two numbers
  // called "covered", measured differently, sitting in the same report is
  // precisely how a reader draws a confident wrong conclusion — so the
  // thresholds travel WITH the figures rather than living only in a comment
  // nobody reads at 2am (`feedback_instruments_must_not_lie`). A byte of 1–8
  // is a resampling artefact, not coverage: it casts essentially nothing, but
  // it does inflate a `> 0` count toward 100% on any real map.
  const out = {
    thresholds: {
      emptyAtOrBelow: EMPTY_BYTE,
      solidAtOrAbove: SOLID_BYTE,
      note: 'coveredPct here counts bytes > 8, unlike casterField.coveredPct which counts > 0',
    },
  };
  for (let c = 0; c < 4; c++) {
    let sum = 0;
    let covered = 0;
    let soft = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const v = data[i * 4 + c];
      sum += v;
      if (v > EMPTY_BYTE) covered++;
      if (v > EMPTY_BYTE && v < SOLID_BYTE) soft++;
      if (v > max) max = v;
    }
    out[names[c]] = {
      coveredPct: +((covered / n) * 100).toFixed(1),
      // Of the texels that ARE covered, how many are partial? This is the
      // sharpness figure — compare it against Shader Lab's own for the same
      // floor. A big gap means the two are being fed different data, not
      // rendering it differently.
      softEdgePct: covered > 0 ? +((soft / covered) * 100).toFixed(1) : 0,
      meanByte: +(sum / n).toFixed(1),
      maxByte: max,
    };
  }
  return out;
}

/**
 * THE BLUR LEDGER — every mip level this bake will ask the sampler for, in
 * numbers, without a GPU readback.
 *
 * Added 2026-08-02 after a full session of *"the shadow looks blurry"* that
 * could not be diagnosed from the report, because the report described
 * RESOLUTIONS (`fieldDim`, `layerGridDimPx`) and COST (`bakeSamples`) but
 * never the one quantity that decides how soft the picture is: how coarse a
 * mip each sample reads. The measurement that finally cracked it — that
 * `skyReachDepthPx = 1300` asks for mip 8 of a 2048-wide texture, which is
 * EIGHT BY FOUR texels for the whole map — was arithmetic anyone could have
 * done from day one, and nothing printed it.
 *
 * ⚠️ MIRRORS `layer-smear-render.js`'s OWN formulas, and is only honest while
 * it does. Both sides derive `texelWorldPx` the same way (`max(rectW, rectH) /
 * layerGridDim`), floor the directional blur at `max(stationSpacing,
 * texelWorldPx)`, and take `log2(blurPx / texelWorldPx)`. Kept as a pure
 * exported function so a Node test can pin it against those constants rather
 * than trusting this comment.
 *
 * @param {object} args
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} args.rect
 * @param {number} args.layerGridDimPx - the layer texture's own width.
 * @param {number} args.maxThrowPx @param {number} args.steps
 * @param {number} args.softnessMul @param {number} args.depthRadiusPx
 * @returns {object} the ledger, all values rounded for a readable report.
 */
export function describeBakeBlur({ rect, layerGridDimPx, maxThrowPx, steps, softnessMul, depthRadiusPx }) {
  const rectW = (rect?.maxX ?? 0) - (rect?.minX ?? 0);
  const rectH = (rect?.maxY ?? 0) - (rect?.minY ?? 0);
  const dim = layerGridDimPx > 0 ? layerGridDimPx : 0;
  if (!(dim > 0) || !(Math.max(rectW, rectH) > 0)) {
    return { unmeasurable: 'no layer texture uploaded yet' };
  }
  const texelWorldPx = Math.max(rectW, rectH) / dim;
  const n = Math.max(1, Math.floor(steps));
  const lodOf = (px) => Math.max(0, Math.min(MAX_REPORTED_LOD, Math.log2(Math.max(px / texelWorldPx, 1))));
  /** Texels across the WHOLE map at a given LOD — the number that makes a
   * coarse read obviously absurd instead of merely large. */
  const spanAt = (lod) => Math.max(1, Math.round(dim / 2 ** lod));

  // The DIRECTIONAL read, at the shadow's own tip (u = 1), which is the
  // blurriest station the walk ever reaches.
  const tipSpacing = (maxThrowPx * 2) / n;
  const tipPenumbra = (SUN_SHADOW_BASE_PENUMBRA_PX + maxThrowPx * 0.035 * SUN_SHADOW_TIP_BLUR_MUL) * softnessMul;
  const tipBlurPx = Math.max(tipPenumbra, Math.max(tipSpacing, texelWorldPx));
  const tipLod = lodOf(tipBlurPx);

  // The DEPTH gradient's nested reads — the ones that were producing a wash.
  const depth = [];
  if (depthRadiusPx > 0) {
    for (let s = 1; s <= DEPTH_SCALES; s++) {
      const rs = (depthRadiusPx * s) / DEPTH_SCALES;
      const lod = lodOf(rs);
      depth.push({
        radiusPx: Math.round(rs),
        lod: +lod.toFixed(2),
        mapSpanTexels: spanAt(lod),
        worldPxPerTexel: Math.round(Math.max(rectW, rectH) / spanAt(lod)),
      });
    }
  }

  return {
    texelWorldPx: +texelWorldPx.toFixed(2),
    directional: {
      tipBlurPx: +tipBlurPx.toFixed(1),
      tipLod: +tipLod.toFixed(2),
      // Which of the three terms actually won at the tip — naming the binding
      // constraint is the difference between "it is blurry" and "the station
      // spacing is what is blurring it".
      limitedBy:
        tipPenumbra >= Math.max(tipSpacing, texelWorldPx)
          ? 'penumbra'
          : tipSpacing >= texelWorldPx
            ? 'stationSpacing'
            : 'texelFloor',
    },
    depthGradient: depth.length ? depth : 'off (skyReachDepthPx = 0)',
    // The single most damning number when it is wrong: how much of the map one
    // texel of the COARSEST read covers.
    coarsestReadCoversWorldPx: depth.length ? depth[depth.length - 1].worldPxPerTexel : Math.round(tipBlurPx),
  };
}

/**
 * One authored/derived grid's own statistics, BEFORE any packing touches it.
 *
 * Exists because `channelStats.walls` is a DERIVED figure (`255 - outdoors`),
 * so an unexpected value there has two possible homes: the grid itself, or the
 * arithmetic that packs it. This separates them without a second decode.
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

export function packLayerTexelData({ channels, outdoorsGrid, coverAboveGrid, spec }) {
  const { w, h } = spec;
  const data = new Uint8Array(w * h * 4);
  let coveredTexels = 0;
  // ⚠️ `outdoors` AND `coverAbove` MUST BE WORLD-SAMPLED, NEVER FLAT-INDEXED
  // BY `i` (2026-07-30 — the casterGridDim/Quality-Extreme corruption bug,
  // `packCasterTexelData`'s own header has the full post-mortem). Both live at
  // the SHARED grid resolution (every effect's shared budget — water/wind/
  // specular too), independent of whatever resolution THIS output `spec`
  // asks for; indexing them with this loop's flat `i` silently reinterprets
  // one row stride as another the moment the two resolutions diverge.
  // `channels.coverOverhead` is natively at `spec`'s own resolution (it is
  // WHERE `spec` came from), so it alone is safe to flat-index.
  for (let gy = 0; gy < h; gy++) {
    const wy = spec.y + (gy + 0.5) * spec.texelH;
    for (let gx = 0; gx < w; gx++) {
      const wx = spec.x + (gx + 0.5) * spec.texelW;
      const i = gy * w + gx;
      const outdoorsByte = sampleMaskGridWorld(outdoorsGrid, wx, wy) ?? 255;
      const overheadCoverage = channels.coverOverhead?.data[i] ?? 0;
      const aboveByte = coverAboveGrid ? (sampleMaskGridWorld(coverAboveGrid, wx, wy) ?? 0) : 0;
      const wallByte = 255 - outdoorsByte;
      data[i * 4 + 0] = wallByte;
      data[i * 4 + 1] = overheadCoverage;
      data[i * 4 + 2] = aboveByte;
      data[i * 4 + 3] = 0;
      if (wallByte > 0 || overheadCoverage > 0 || aboveByte > 0) coveredTexels++;
    }
  }
  return { data, coveredTexels, channelStats: describeLayerChannels(data, w, h) };
}

export function createSunShadowSubsystem({
  THREE,
  allocator,
  dimensions,
  getCasterHeightField,
  getSunShadowRenderState,
  getMaskAuthorityVersion,
  getShadowHandle,
  getEnvLight,
  renderSunShadowPass,
  createCasterTexture,
}) {
  // ── STATE (was 11 viewer-closure locals; now this module's own) ─────────
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
  /** The floor the live caster field belongs to. */
  let casterFieldFloor = -1;
  let lastCasterBakeResult = null;
  let lastSunShadowParamsKey = '';
  /** False while `casterTexture` is still the 1×1 placeholder (never uploaded,
   * or dropped because the effect went off). A plain "has the mask version
   * moved" test cannot answer this — the version is identical on the frame the
   * effect is switched back on — so re-enabling would otherwise show no shadow
   * until something else happened to dirty a mask. */
  let casterFieldLoaded = false;
  /** True once the collapsed 1×1 white field has been written for the current
   * "off" spell, so being off costs one 1×1 draw in total rather than one per
   * frame. Cleared the moment the effect is enabled again. */
  let offFieldWritten = false;

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

  // TWO textures, both SCENE-SPACE (world-aligned, camera-independent):
  //   `casterTexture` — the layer field, uploaded from the mask authority's
  //                     derived channels: R walls, G overhead, B the floor
  //                     above (and everything higher, merged).
  //   `sunShadowRt`   — the baked result, sampled once per frame by the
  //                     ambient fill AND per-fragment by every point light.
  // Neither is re-made per frame. The bake runs only when the QUANTISED sun
  // moves, the masks change, or the floor changes — panning and zooming are
  // free.
  /** The descriptor, kept rather than inlined: `allocator.resize` takes it too,
   * so the Keyhole law re-runs on every resize with the SAME flags `create`
   * was judged under — "a resize storm can't smuggle a world-res target past
   * the law that create() already enforced" (three-allocator.js). One object,
   * two call sites, no chance of them disagreeing. */
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
  const sunShadowRt = allocator.create('scene.sunShadow', sunShadowRtDesc);

  let sunShadowBake = buildLayerSmearBakeMaterial({
    THREE,
    layerTexture: casterTexture,
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
   * the existing target and keeps `.texture` as the SAME JS object, so the three
   * consumers that captured it at their own construction (the ambient fill,
   * every point light, the debug view) keep reading the thing that is actually
   * being written. Allocating a replacement would leave all three pointing at a
   * disposed texture — a blank map, from a "tidier" line of code.
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
   * ⚠️ ONE MODEL NOW, NOT A DISPATCH (2026-08-02 — the march/old-smear A/B
   * switch this function once shared with `applyMarchQuality` is retired; see
   * `docs/planning/Sun-Shadows-Layer-Smear.md` §8). This function used to pick
   * between two builders and had to guard against a tier change and a model
   * change landing in the same frame with the wrong one winning. One builder
   * cannot disagree with itself, so that guard is gone with it.
   *
   * @param {{steps: number}} plan
   * @returns {boolean} whether the material was replaced.
   */
  function applyQuality(plan) {
    if (plan.steps === builtSteps) return false;
    const previous = sunShadowBake;
    sunShadowBake = buildLayerSmearBakeMaterial({ THREE, layerTexture: casterTexture, steps: plan.steps });
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
  // reasons, both load-bearing: it needs `envLight`'s uniforms, which do not
  // exist while this factory runs (see §2), and a player who never opens the
  // dropdown should never compile a second fullscreen material for it.
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
      // SHARED uniforms, never copies — the debug view must frame the picture
      // exactly as the render it is diagnosing does, or it is diagnosing
      // something else (Extraction plan trap #2).
      uViewRect: env.uViewRect,
      uShadowRect: env.uSunShadowRect,
    });
    debugQuad = new THREE.QuadMesh(debug.material);
    debug.setView(debugViewId);
    return debug;
  }

  /**
   * Upload a floor's occluder layer field as one RGBA texture.
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

    const { data, coveredTexels, channelStats } = packLayerTexelData({
      channels,
      outdoorsGrid,
      coverAboveGrid: field?.coverAbove ?? null,
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
    getEnvLight().setSunShadowRect(rect);
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
   * Run the bake into `scene.sunShadow`. Cheap to CALL and expensive to RUN,
   * which is why every caller goes through `maybeBake` instead.
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
    // ⚠️ ZEROED WHEN INACTIVE, not read raw — mirrors the previous model's own
    // `active ? casterMaxHeightPx : 0`. Every height at 0 makes
    // `resolveLayerSmear` return `maxThrowPx = 0`, which `layerSmearVisibility`
    // already treats as a provable no-op (its own "no layer reaches anywhere"
    // early return) — the same "off costs nothing, and cannot half-apply"
    // guarantee, reached the model's own way rather than a caller-side branch.
    const heightsPx = active
      ? [params.wallHeightPx ?? 0, params.overheadHeightPx ?? 0, params.aboveHeightPx ?? 0, 0]
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
    // THE SKY-REACH GRADIENT — only the "above" layer (index 2) carries real
    // data today (see `packLayerTexelData`'s own note on why index 3 is
    // empty), so only it gets a real radius. Unlike the strengths/falloff
    // above, this ONE stays a real param — see this file's own "LOOK
    // CONSTANTS, NOT PARAMS" header for why it is the exception.
    sunShadowBake.setDepth({ radiiPx: [0, 0, active ? (params.skyReachDepthPx ?? 0) : 0, 0] });
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
    lastSunShadowBake = {
      reason,
      enabled: !!state.enabled,
      active,
      sun: { ...bakedSun },
      heightsPx: heightsPx.slice(0, 3).map((v) => Math.round(v)),
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
   * ACTUALLY changes the shadows changed?
   *
   * ⚠️ Must be called from the FRAME LOOP, never from a residency-triggered
   * function. A uniform sync placed inside a residency pass only updates on
   * pan/zoom — the exact bug that made vegetation's own sliders do nothing
   * until the camera moved (`feedback_residency_sync_vs_render_loop`). The sun
   * moving is not a camera event, so a camera-gated rebake would be silently
   * frozen at dawn.
   *
   * @param {number} floorIndex
   */
  function maybeBake(floorIndex) {
    const state = getSunShadowRenderState();
    const enabled = state.enabled !== false;

    // ── OFF: COLLAPSE, DO NOT MARCH (§4) ──────────────────────────────────
    // The `low` profile lands here every frame (SUN_SHADOWS.enabledFromProfile
    // is `performance`), as does any GM/player who switched the effect off. A
    // 1×1 white field says "full sun everywhere" to the ambient fill and to
    // every point light exactly as convincingly as a 1024² one, so the whole
    // cost of being off is one 1×1 draw when the state changes, plus the
    // consumers' own (now trivially cached) fetch.
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

    const version = getMaskAuthorityVersion ? getMaskAuthorityVersion() : casterFieldVersion;
    if (!casterFieldLoaded || version !== casterFieldVersion || floorIndex !== casterFieldFloor) {
      casterFieldVersion = version;
      casterFieldFloor = floorIndex;
      lastCasterBakeResult = bakeLayerTexture(floorIndex);
      casterFieldLoaded = true;
    }
    const paramsKey = JSON.stringify(state.params ?? {}) + `|on|t${activeTier}`;
    const paramsChanged = paramsKey !== lastSunShadowParamsKey;
    if (paramsChanged) lastSunShadowParamsKey = paramsKey;
    if (paramsChanged || geometryChanged || sunNeedsRebake(bakedSun, getShadowHandle().atmosphere, plan.quantizeDeg)) {
      bakeSunShadowField(geometryChanged ? 'profile' : paramsChanged ? 'param' : bakedSun ? 'sun' : 'first');
    }
  }

  return {
    /** The baked field's texture — shared by the ambient fill (via
     * `envLight`, which took this at ITS OWN construction) and every point
     * light's per-fragment sample (`point-light-illumination.js`). */
    texture: sunShadowRt.texture,
    /** The world rect `texture` currently covers. The caller pushes this into
     * `envLight.setSunShadowRect` ONCE, right after building envLight (see
     * this module's own header) — subsequent pushes happen internally, from
     * `bakeLayerTexture`, on every real rebake. */
    getRect: currentRect,
    /** Which floor `texture`'s field currently holds DATA for — set by the
     * most recent `maybeBake`, even on a call that skipped an actual rebake
     * (the field's existing content is still correctly attributed to this
     * floor in that case). The caller pushes this into
     * `envLight.setSunShadowFloorIndex` every frame, right after `maybeBake`,
     * so the ambient fill can refuse to apply this field to a DIFFERENT
     * floor's own content drawn in the same multi-floor frame (KNOWN-REMAINING
     * gap in `Sun-Shadows-Rethink.md` §5 — this is that fix's data source). -1
     * before the first bake ever runs, which correctly matches no real floor.
     */
    getBakedFloorIndex() {
      return casterFieldFloor;
    },
    maybeBake,
    /**
     * The fullscreen debug quad to draw INSTEAD of the present pass, or null
     * when the view is `off` (the normal case, and the only cost is this
     * comparison). The viewer draws it — this module never touches the
     * renderer (§3).
     * @param {string} viewId - the `debugView` param's current value.
     */
    getDebugQuad(viewId) {
      if (!sunShadowDebugPaints(viewId)) return null;
      ensureDebug();
      if (viewId !== debugViewId) {
        debugViewId = viewId;
        debug.setView(viewId);
      }
      return debugQuad;
    },
    /** For `boot.js`'s "Sun shadows" report. `compiled` is NOT included — it
     * is a property of `envLight`'s own shader graph, not this subsystem; the
     * caller merges it in (see this module's own USAGE example).
     *
     * `profile` is the whole point of the 2026-07-29 ladder being visible: it
     * reports the rung the field is ACTUALLY built at, alongside the rung the
     * ladder tops out at and what one bake costs in texture samples. Without it
     * "the profile changed" and "the field changed" are indistinguishable from
     * outside, which is how a ladder nobody reads rots (resolveEffectTier's own
     * header). Samples rather than milliseconds, deliberately —
     * `layerSmearBakeSamples`'s doc has the argument. */
    getStatus() {
      return {
        caster: lastCasterBakeResult ?? 'never baked',
        lastBake: lastSunShadowBake ?? 'never baked',
        profile: {
          tier: activeTier,
          maxTier: LAYER_SMEAR_MAX_TIER,
          // The LIVE numbers, not the plan's: while the effect is off these
          // genuinely differ (the field collapses to 1×1 and the material is
          // left alone), and a status that printed the plan there would be
          // reporting a field that is not allocated.
          fieldDim: activeFieldDim,
          // ⚠️ A DIFFERENT NUMBER FROM `fieldDim`, DELIBERATELY REPORTED
          // ALONGSIDE IT — conflating the two (feeding the LOD math one when
          // it meant the other) is exactly the live bug this field's own
          // presence here is meant to make auditable at a glance from now on.
          layerGridDimPx,
          // ⚠️ THE LIVE MATERIAL'S OWN CHOICE, NEVER THE PARAM — the param can
          // change mid-frame before the next `maybeBake` catches up; this is
          // what `applyQuality` actually built, the same discipline `fieldDim`
          // above already follows for the identical reason.
          steps: builtSteps,
          quantizeDeg: activePlan.quantizeDeg,
          bakeSamples: layerSmearBakeSamples({ fieldDim: activeFieldDim, steps: builtSteps }),
          defaultTierSamples: layerSmearBakeSamples(layerSmearTierPlan(LAYER_SMEAR_DEFAULT_TIER)),
        },
      };
    },
    /** Tear down this subsystem's OWN GPU state. Found while extracting this
     * module: neither `sunShadowRt` nor `sunShadowBake.material` had ANY
     * registered dispose call before this — a real leak, on every
     * Stop/Restart cycle. NOT `sunShadowQuad.geometry` — `QuadMesh` shares
     * ONE module-level `QuadGeometry` across every `QuadMesh` in the process
     * (three.webgpu.js), so disposing it would break every other fullscreen
     * pass. The CALLER must still wire this into the existing teardown
     * registration (`disposeActive`'s list) — this module cannot reach it.
     */
    dispose() {
      allocator.dispose(sunShadowRt);
      sunShadowBake.material?.dispose?.();
      debug?.material?.dispose?.();
      casterTexture?.dispose?.();
    },
  };
}
