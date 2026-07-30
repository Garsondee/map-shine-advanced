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
 * subsystem must exist BEFORE `envLight` does. But `bakeCasterTexture` (below)
 * needs to call `envLight.setSunShadowRect(...)` on every rebake. A plain
 * `envLight` parameter captured at construction would be `undefined` (or throw
 * a TDZ ReferenceError for a `const` not yet initialized — the EXACT crash
 * class this project hit live on 2026-07-24 with `SUN_SHADOW_FIELD_DIM`).
 *
 * The fix: `getEnvLight: () => envLight`, a closure written in the CALLER's
 * own scope where `envLight` is a `const` declared moments later. It is only
 * ever INVOKED from inside `bakeCasterTexture`, which only ever runs via
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

import { buildSunShadowBakeMaterial } from './sun-occlusion-render.js';
import {
  resolveSunMarch,
  sunNeedsRebake,
  sunShadowTierPlan,
  sunShadowBakeSamples,
  SUN_SHADOW_DEFAULT_TIER,
  SUN_SHADOW_MAX_TIER,
} from './sun-occlusion.js';
import { buildSunShadowDebugMaterial, sunShadowDebugPaints } from './sun-shadow-debug.js';
import { sampleMaskGridWorld } from '../../scene/mask-derive.js';

/**
 * ============================================================================
 * §4 — THE PERFORMANCE LADDER, AND WHAT MOVES WHEN THE PROFILE DOES
 * ============================================================================
 *
 * Added 2026-07-29. Three of this subsystem's four cost numbers used to be
 * module constants — the field's resolution, the march's step count and the
 * cone's tap count — which meant a `low` machine and an `extreme` one marched
 * the identical 1024²×24×3 field. They now come from the resolved performance
 * rung (`sun-occlusion.js#sunShadowTierPlan`, fed by `resolveEffectTier`
 * through `getSunShadowRenderState().perfTier`), and this module is where a
 * change to that rung actually costs or saves anything:
 *
 *   fieldDim    → `allocator.resize(sunShadowRt, …)`. ⚠️ `setSize` KEEPS THE
 *                 SAME `.texture` OBJECT, which is the only reason resizing is
 *                 safe at all: `envLight`, every point-light material and the
 *                 debug view each captured `sunShadows.texture` at THEIR own
 *                 construction (Extraction plan trap #2 — shared nodes stay
 *                 shared). Re-ALLOCATING would hand all three a disposed
 *                 texture and blank the map.
 *   marchSteps  → a new bake material. Both loops are unrolled at TSL build
 *   lateralTaps   time, so these cannot be uniforms; the material is rebuilt,
 *                 which is a shader compile, which is why it only ever happens
 *                 on a profile change and never per frame.
 *   quantizeDeg → passed straight to `sunNeedsRebake`, so it takes effect on
 *                 the very next frame with nothing to rebuild.
 *
 * AND WHAT "OFF" NOW COSTS. It used to cost a FULL-RESOLUTION march that wrote
 * white — the pass could not simply be skipped, because the ambient fill always
 * samples this texture, so "no shadow" has to be a written value rather than an
 * unwritten one. That is still true, but a 1×1 white texel satisfies it exactly
 * as well as a 1024² one: a disabled effect now drops its caster field,
 * collapses the target to 1×1 and marches a single pixel, once. The residual
 * per-frame cost is the consumers' own texture fetch, which is a 1×1 sample and
 * not zero — stated rather than rounded down (feedback_instruments_must_not_lie).
 */

/** How far the sun must move before the field is re-marched, at the DEFAULT
 * rung. Without this a running day clock re-bakes every frame — exactly the cost
 * model this design exists to avoid; half a degree is invisible and turns sixty
 * bakes a second into a few a minute. The LIVE value is the resolved rung's
 * (`sunShadowTierPlan(...).quantizeDeg`); this is what `standard` buys, exported
 * so a test can pin the two together. */
export const SUN_SHADOW_QUANTIZE_DEG = sunShadowTierPlan(SUN_SHADOW_DEFAULT_TIER).quantizeDeg;

/** The minimum feather at the contact point, px — no shadow is a perfect
 * cutout, not even where it meets the wall casting it. Not tiered: it is a
 * LOOK constant, and softening a shadow's contact point on a slow machine
 * would be a different picture, not a cheaper one. */
export const SUN_SHADOW_BASE_PENUMBRA_PX = 3;

/** Default width of the map-edge ramp (the author's own suggested cure for the
 * shadow gap at the scene boundary — see `buildSunShadowBakeMaterial`). */
export const SUN_SHADOW_EDGE_BAND_PX = 384;

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
  // A 1×1 EMPTY caster height field — no casters, and (critically) a receiver
  // gate of ZERO, so the march is a provable no-op before any real field is
  // baked. Deliberately NOT white (which would read as "a 2048px building on
  // every texel" — the whole map in shadow from frame one, the exact black-
  // screen-by-construction class `keyhole-grade-engine-built` already named
  // once for the LUT tail). A placeholder whose failure mode is invisible
  // beats one whose failure mode is a black screen.
  let casterTexture = createCasterTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  let casterRect = { ...dimensions.sceneRect };
  /** The tallest caster in the current field, px — sizes the march's reach. */
  let casterMaxHeightPx = 0;
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
  let activeTier = SUN_SHADOW_DEFAULT_TIER;
  let activePlan = sunShadowTierPlan(activeTier);
  /** The live field resolution — `activePlan.fieldDim` normally, 1 while the
   * effect is off. A separate variable rather than a derived one BECAUSE they
   * genuinely differ: the rung stays whatever the profile bought while the
   * effect is switched off, so turning it back on restores that rung rather
   * than the cheapest one. */
  let activeFieldDim = activePlan.fieldDim;
  /** What the LIVE bake material was actually built with, so `applyMarchQuality`
   * can tell a real change from a re-resolve of the same rung. Declared HERE,
   * above every function that reads them, rather than beside the function that
   * writes them: Extraction plan trap #4 is a temporal-dead-zone crash this very
   * file already caused once. */
  let builtMarchSteps = activePlan.marchSteps;
  let builtLateralTaps = activePlan.lateralTaps;
  /** The height scale the live caster field was uploaded with. Re-pushed into a
   * rebuilt material, since only `bakeCasterTexture` ever sets it and that runs
   * on mask changes, not on profile changes. */
  let casterHeightScalePx = 0;
  /** The scene-wide building height (world px) the live caster field was baked
   * with — ROUND SEVEN's COLUMN test reads this as a uniform, not a per-texel
   * channel, so it needs the same re-push-on-rebuild treatment as
   * `casterHeightScalePx` just above, for the identical reason. */
  let casterBuildingHeightPx = 0;
  /** ⚠️ THE CASTER TEXTURE'S OWN RESOLUTION (texels a side), set ONLY from the
   * texture `bakeCasterTexture` actually just uploaded (`spec.w`) — NEVER from
   * `activeFieldDim`/`plan.fieldDim`, which is a DIFFERENT number (the OUTPUT
   * bake target's own resolution). Conflating the two fed §4's mip-LOD math
   * the wrong texel size the moment `casterGridDim` stopped moving in lockstep
   * with `fieldDim` (2026-07-30, live: Quality-tier banding, Extreme-tier a
   * visibly mispositioned shadow — sun-occlusion-render.js's `uCasterGridDim`
   * has the full post-mortem). Re-pushed on a material rebuild for the same
   * reason `casterHeightScalePx` is: only a real bake changes it. */
  let casterGridDimPx = 0;

  // TWO textures, both SCENE-SPACE (world-aligned, camera-independent):
  //   `casterTexture` — the height field, uploaded from the mask authority's
  //                     derived channels (R coverAbove, G overhead, B
  //                     sky-reach, A the `_Outdoors` receiver).
  //   `sunShadowRt`   — the marched result, sampled once per frame by the
  //                     ambient fill AND per-fragment by every point light.
  // Neither is re-made per frame. The march runs only when the QUANTISED sun
  // moves, the masks change, or the floor changes — panning and zooming are
  // free, which is why a 24-step march is affordable here and never was in V2
  // (which re-marched a view-aligned target every frame).
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
    // (512 → 1280) stays under the 2048 world-res cap, so no `allowWorldScale`
    // exception is claimed at any rung.
    screenSized: false,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    filter: 'linear',
    depth: false,
  };
  const sunShadowRt = allocator.create('scene.sunShadow', sunShadowRtDesc);

  let sunShadowBake = buildSunShadowBakeMaterial({
    THREE,
    casterTexture,
    steps: activePlan.marchSteps,
    lateralTaps: activePlan.lateralTaps,
  });
  let sunShadowQuad = new THREE.QuadMesh(sunShadowBake.material);

  /** The world rect the live caster field covers, as the (minX,minY,maxX,maxY)
   * shape both the bake material and `envLight` want. ONE derivation, three
   * readers (`bakeCasterTexture`, `applyMarchQuality`, the public `getRect`) —
   * a second copy of this arithmetic is how the shadow field and the gate that
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
    // Pushed HERE too, not left to `applyMarchQuality`/`bakeCasterTexture`
    // alone: a resize never actually changes the CASTER texture's own
    // resolution (`casterGridDimPx` — this call re-pushes the cached value,
    // it does not derive a new one from `next`, which is the OUTPUT bake
    // target's dimension and a genuinely different number — see
    // `casterGridDimPx`'s own header for the live bug conflating the two
    // caused). Harmless when a rebake follows immediately (it always does,
    // here); the defensive value is covering the case a future caller calls
    // this in isolation.
    sunShadowBake.setField({
      heightScalePx: casterHeightScalePx,
      casterGridDimPx,
      buildingHeightPx: casterBuildingHeightPx,
    });
    return true;
  }

  /**
   * Rebuild the march for a new step/tap count, if it changed. Both are unrolled
   * loops in the TSL graph (§4), so this is a shader compile — rare by design,
   * and every uniform the old material carried has to be pushed into the new one
   * before the next bake reads it. `bakeSunShadowField` re-pushes sun/look/edge
   * on every run; the two that are NOT re-pushed per bake — the caster texture
   * and the field rect/scale, both owned by `bakeCasterTexture` — are restored
   * here, or the first bake after a profile change would march a default 1×1
   * caster over a unit rect and write a blank field.
   *
   * @param {{marchSteps: number, lateralTaps: number}} plan
   * @returns {boolean} whether the material was replaced.
   */
  function applyMarchQuality(plan) {
    if (plan.marchSteps === builtMarchSteps && plan.lateralTaps === builtLateralTaps) return false;
    const previous = sunShadowBake;
    sunShadowBake = buildSunShadowBakeMaterial({
      THREE,
      casterTexture,
      steps: plan.marchSteps,
      lateralTaps: plan.lateralTaps,
    });
    sunShadowQuad = new THREE.QuadMesh(sunShadowBake.material);
    builtMarchSteps = plan.marchSteps;
    builtLateralTaps = plan.lateralTaps;
    // Restore the two pieces of state the new material was born without.
    // ⚠️ `casterGridDimPx`, NEVER `activeFieldDim` — the fresh material's
    // `uCasterGridDim` uniform otherwise starts at its own hardcoded default
    // (512) rather than the LIVE caster texture's actual resolution, silently
    // mis-sizing every mip request until the next real bake happens to fire.
    sunShadowBake.setRect(currentRect());
    sunShadowBake.setField({
      heightScalePx: casterHeightScalePx,
      casterGridDimPx,
      buildingHeightPx: casterBuildingHeightPx,
    });
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
   * Upload a floor's occluder height field as one RGBA texture.
   *
   * THE PACKING (ROUND SEVEN, 2026-07-30 — sun-occlusion.js's own header has
   * the physics): R = sky-reach coverage ALONE, G = FLOATING height
   * (overhead ∪ sky-reach — buildings EXCLUDED, see below), B = FLOATING
   * coverage (overhead ∪ sky-reach), A = the floor's raw `_Outdoors` (the
   * receiver gate, so that test costs no second fetch).
   *
   * Building height is NOT a channel — a building is a COLUMN with ONE
   * scene-wide height, so per-texel storage would be pure redundancy (every
   * covered texel would carry the identical byte). The march reads
   * `buildingHeightPx` as a uniform (`setField`, below) and derives per-texel
   * building COVERAGE from A: `(255 − outdoors) / 255`, the same "indoors-ness"
   * `mask-derive.js#coverBuilding` already computes.
   *
   * ⚠️ WHY G/B DROP BUILDING (this is the actual Round Seven repack, not just
   * a rename). Before this round, G was `max(building, overhead, skyReach)`
   * height and B was `max(building, overhead)` coverage — so wherever a
   * texel was BOTH indoors (tall building) and also had a same-floor overhead
   * item or an upper floor above it, the building's own (usually taller)
   * height WON the max and hid the floating height that was also genuinely
   * there. The COLUMN and BAND tests need to run on independent inputs — a
   * receiver standing under a mezzanine inside a tall building needs its
   * `floatingHeightPx` read, not the building's own height masquerading as it.
   * `channels.overhead`/`channels.skyReach` already exist as UNMERGED
   * per-producer grids (kept "for the isolation toggles and the pixel probe" —
   * mask-derive.js's own `casterChannels` doc), so this is a repack, not a
   * new derivation.
   *
   * @param {number} floorIndex
   * @returns {object} the outcome, verbatim, for the status report.
   */
  function bakeCasterTexture(floorIndex) {
    let field = null;
    try {
      field = getCasterHeightField(floorIndex);
    } catch (err) {
      return { ok: false, floorIndex, reason: String(err?.message ?? err) };
    }
    const channels = field?.channels;
    const gateGrid = field?.outdoors;
    if (!channels?.height?.spec || !gateGrid?.data) {
      return { ok: false, floorIndex, reason: 'no caster height field for this floor' };
    }
    const spec = channels.height.spec;
    const { w, h } = spec;
    if (!(w > 0 && h > 0)) return { ok: false, floorIndex, reason: `degenerate grid ${w}x${h}` };

    const data = new Uint8Array(w * h * 4);
    let coveredTexels = 0;
    // ⚠️ THE GATE GRID (`outdoors`) LIVES AT A DIFFERENT, PERMANENTLY-512
    // RESOLUTION (2026-07-30 — the casterGridDim/Quality-Extreme corruption
    // bug). `outdoors` comes from `maskAuthority.getDerived('outdoors', ...)`,
    // the SHARED grid every effect reads (water/specular/coarse-alpha too),
    // sized by `MASK_GRID_MAX_DIM` — it never followed `casterGridDim` when
    // that axis was split off from the old shared 512 cap. Reading it with
    // THIS loop's flat index `i` silently REINTERPRETS a 512-row-stride
    // buffer as if it had `w`'s row stride, which only happens to be correct
    // when `w === 512` — the shipped resolution before this session. At any
    // other `w` (Quality 768, Extreme 1024) every row shears against the
    // wrong offset, producing exactly the reported "banding"/"squashed ghost
    // copies", because 1024 = 512×2 doubles every real row into a repeat and
    // 768 = 512×1.5 shears diagonally. World-SAMPLING it (mask-derive.js's own
    // fix for the identical class of problem, `sampleMaskGridWorld`) reads the
    // correct texel regardless of either grid's own resolution.
    for (let gy = 0; gy < h; gy++) {
      const wy = spec.y + (gy + 0.5) * spec.texelH;
      for (let gx = 0; gx < w; gx++) {
        const wx = spec.x + (gx + 0.5) * spec.texelW;
        const i = gy * w + gx;
        const overheadHeight = channels.overhead?.data[i] ?? 0;
        const skyReachHeight = channels.skyReach?.data[i] ?? 0;
        const overheadCoverage = channels.coverOverhead?.data[i] ?? 0;
        const skyReachCoverage = channels.coverSkyReach?.data[i] ?? 0;
        // ⚠️ R IS SKY-REACH ONLY (2026-07-26) — NOT the floating merge just
        // below. `d = 0` reads R raw, with no march, as "something solid
        // stands directly over THIS PIXEL" — genuinely true for an upper
        // FLOOR's structure (that art is not drawn at this pixel; the ground
        // beneath it stays visible and honestly darkened). For an overhead
        // item on the SAME floor, this pixel's only visible content IS the
        // item's own opaque art — there is no separate, visible "ground
        // beneath" to darken, so a same-floor item shading itself was pure
        // self-shadowing (docs/planning/Sun-Shadows-Rethink.md §4b).
        // Overhead's own coverage/height still march-cast normally via G/B
        // below — only the zero-distance self-check excludes it.
        data[i * 4 + 0] = skyReachCoverage;
        data[i * 4 + 1] = overheadHeight > skyReachHeight ? overheadHeight : skyReachHeight;
        data[i * 4 + 2] = overheadCoverage > skyReachCoverage ? overheadCoverage : skyReachCoverage;
        data[i * 4 + 3] = sampleMaskGridWorld(gateGrid, wx, wy) ?? 255;
        if (data[i * 4 + 0] > 0 || data[i * 4 + 2] > 0) coveredTexels++;
      }
    }

    // `createCasterTexture` is the caller's callback (see §3) — LINEAR
    // filtering so a silhouette edge is a ramp rather than a staircase of
    // mask texels, which the march's contact-hardening depends on.
    const tex = createCasterTexture(data, w, h);

    casterTexture?.dispose();
    casterTexture = tex;
    sunShadowBake.casterTexNode.value = tex;
    debug?.setCasterTexture(tex);
    casterRect = { x: spec.x, y: spec.y, width: spec.width, height: spec.height };
    // `field.completeness.maxCasterHeightPx` is mask-derive.js's OWN max,
    // computed across ALL three producers INCLUDING building — the single
    // source of truth for "how far must the march reach", now that building
    // height no longer shows up in any packed byte this function could
    // re-derive a max from itself (Round Seven).
    casterMaxHeightPx = field.completeness?.maxCasterHeightPx ?? 0;
    casterHeightScalePx = field.scalePx ?? 0;
    casterBuildingHeightPx = field.buildingHeightPx ?? 0;
    // ⚠️ `spec.w` — the texture JUST uploaded, in texels — NEVER `activeFieldDim`
    // (a different number: the OUTPUT bake target's own resolution). See
    // `casterGridDimPx`'s own header for the live bug this is the fix for.
    casterGridDimPx = spec.w;
    const rect = currentRect();
    sunShadowBake.setRect(rect);
    sunShadowBake.setField({
      heightScalePx: casterHeightScalePx,
      casterGridDimPx,
      buildingHeightPx: casterBuildingHeightPx,
    });
    getEnvLight().setSunShadowRect(rect);
    // A new field invalidates whatever was marched from the old one.
    bakedSun = null;
    return {
      ok: true,
      floorIndex,
      cols: w,
      rows: h,
      maxCasterHeightPx: Math.round(casterMaxHeightPx),
      buildingHeightPx: Math.round(casterBuildingHeightPx),
      // ⚠️ READ THESE TWO TOGETHER. Casters present with a max height of ZERO is
      // the silent failure that hid sky-reach: a floor with no declared
      // `bottomElevation` gives every caster height 0, and every count stays
      // healthy while the field casts nothing. `caster-coverage` vs
      // `caster-height` in the debug dropdown is the same test, by eye.
      coveredTexels,
      coveredPct: +((coveredTexels / (w * h)) * 100).toFixed(1),
      completeness: field.completeness ?? null,
      rect,
    };
  }

  /**
   * Give back the uploaded caster field — the memory half of "off costs
   * nothing" (§4). The full-resolution RGBA upload is one `w × h × 4` byte
   * texture per floor (512² ⇒ 1 MB), and holding it while the effect is
   * switched off is holding it for nobody.
   *
   * ⚠️ `casterMaxHeightPx = 0` IS THE LOAD-BEARING LINE, not the dispose.
   * `bakeSunShadowField`'s `active` test is `enabled && casterMaxHeightPx > 0`,
   * and the 1×1 placeholder this restores has a receiver gate of ZERO — so
   * even if something re-baked the field while off, the march is a provable
   * no-op rather than a full-strength shadow over a stale height map.
   */
  function dropCasterField() {
    const placeholder = createCasterTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    casterTexture?.dispose?.();
    casterTexture = placeholder;
    sunShadowBake.casterTexNode.value = placeholder;
    debug?.setCasterTexture(placeholder);
    casterMaxHeightPx = 0;
    casterHeightScalePx = 0;
    casterBuildingHeightPx = 0;
    casterGridDimPx = 0;
    casterFieldLoaded = false;
    lastCasterBakeResult = { ok: false, reason: 'effect off — caster field released' };
    bakedSun = null;
  }

  /**
   * Run the march into `scene.sunShadow`. Cheap to CALL and expensive to RUN,
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
    const active = state.enabled && casterMaxHeightPx > 0;
    const resolved = resolveSunMarch({
      azimuthDeg: atmosphere.azimuthDeg,
      elevationDeg: atmosphere.elevationDeg,
      maxCasterHeightPx: active ? casterMaxHeightPx : 0,
      // ⚠️ THE MATERIAL'S OWN STEP COUNT, not the rung's. The CPU's step LENGTH
      // (`resolved.stepPx`) and the shader's unrolled loop must agree exactly or
      // the march walks the wrong span — so this reads what the live material
      // was BUILT with, which is the rung's value everywhere except the one
      // frame a profile change is being applied.
      steps: builtMarchSteps,
      // THE LENGTH CONTROLS — global scale + dawn/dusk cap, both folded into
      // the ONE effective tangent resolveSunMarch computes, so the shorter
      // span also means smaller steps (finer, and cheaper).
      lengthScale: params.lengthScale ?? 1,
      maxLengthMul: params.dawnDuskLength ?? 0,
    });
    sunShadowBake.setSun(atmosphere.azimuthDeg, atmosphere.elevationDeg, resolved);
    sunShadowBake.setLook({
      strength01: active ? Math.max(0, Math.min(1, params.strength01 ?? 1)) * atmosphere.strengthMul : 0,
      softnessMul: atmosphere.softnessMul * Math.max(0.05, params.softnessBias ?? 1),
      basePx: SUN_SHADOW_BASE_PENUMBRA_PX,
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
      maxCasterHeightPx: Math.round(casterMaxHeightPx),
      // WHAT THIS BAKE ACTUALLY COST, not what the ladder says it should have.
      // The rung is reported separately in `getStatus`; these are the numbers
      // the draw above was made of, so a report can never claim a resolution
      // the field is not at (feedback_instruments_must_not_lie).
      tier: activeTier,
      steps: builtMarchSteps,
      lateralTaps: builtLateralTaps,
      fieldDim: activeFieldDim,
      bakeSamples: activeFieldDim * activeFieldDim * builtMarchSteps * builtLateralTaps,
      marchSpanPx: Math.round(resolved.spanPx),
      softnessMul: +(atmosphere.softnessMul * Math.max(0.05, params.softnessBias ?? 1)).toFixed(3),
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

    // ── ON: the resolved rung decides how much field there is to march ────
    // Read every frame and compared, never assumed: the performance profile is
    // a LIVE client setting with no reload behind it, so a player who drops
    // from Extreme to Standard mid-session must see the cheaper field on the
    // next bake, not on the next scene load.
    offFieldWritten = false;
    const tier = Number.isFinite(state.perfTier) ? state.perfTier : SUN_SHADOW_DEFAULT_TIER;
    const plan = sunShadowTierPlan(tier);
    activeTier = tier;
    activePlan = plan;
    // Both of these return "did anything move", and both invalidate the live
    // field when they do — a resized target's contents are undefined, and a
    // rebuilt material has never drawn anything at all.
    //
    // ⚠️ BOTH ARE CALLED UNCONDITIONALLY — NOT `a() || b()`. A rung change can
    // move `fieldDim` and `marchSteps`/`lateralTaps` at once (e.g. `performance`
    // → `standard`), and `||` short-circuits the second call the moment the
    // first returns `true`, silently stranding the OLD march quality forever —
    // `fieldDim` never needs to change again once it matches, so the skipped
    // rebuild would never get a second chance.
    const dimChanged = applyFieldDim(plan.fieldDim);
    const qualityChanged = applyMarchQuality(plan);
    const geometryChanged = dimChanged || qualityChanged;

    const version = getMaskAuthorityVersion ? getMaskAuthorityVersion() : casterFieldVersion;
    if (!casterFieldLoaded || version !== casterFieldVersion || floorIndex !== casterFieldFloor) {
      casterFieldVersion = version;
      casterFieldFloor = floorIndex;
      lastCasterBakeResult = bakeCasterTexture(floorIndex);
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
    /** The marched field's texture — shared by the ambient fill (via
     * `envLight`, which took this at ITS OWN construction) and every point
     * light's per-fragment sample (`point-light-illumination.js`). */
    texture: sunShadowRt.texture,
    /** The world rect `texture` currently covers. The caller pushes this into
     * `envLight.setSunShadowRect` ONCE, right after building envLight (see
     * this module's own header) — subsequent pushes happen internally, from
     * `bakeCasterTexture`, on every real rebake. */
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
     * `sunShadowBakeSamples`'s doc has the argument. */
    getStatus() {
      return {
        caster: lastCasterBakeResult ?? 'never baked',
        lastBake: lastSunShadowBake ?? 'never marched',
        profile: {
          tier: activeTier,
          maxTier: SUN_SHADOW_MAX_TIER,
          // The LIVE numbers, not the plan's: while the effect is off these
          // genuinely differ (the field collapses to 1×1 and the material is
          // left alone), and a status that printed the plan there would be
          // reporting a field that is not allocated.
          fieldDim: activeFieldDim,
          // ⚠️ A DIFFERENT NUMBER FROM `fieldDim`, DELIBERATELY REPORTED
          // ALONGSIDE IT — conflating the two (feeding the LOD math one when
          // it meant the other) is exactly the live bug this field's own
          // presence here is meant to make auditable at a glance from now on.
          casterGridDimPx,
          steps: builtMarchSteps,
          lateralTaps: builtLateralTaps,
          quantizeDeg: activePlan.quantizeDeg,
          bakeSamples: activeFieldDim * activeFieldDim * builtMarchSteps * builtLateralTaps,
          defaultTierSamples: sunShadowBakeSamples(sunShadowTierPlan(SUN_SHADOW_DEFAULT_TIER)),
          // ROUND SEVEN: reported alongside the rest of the LIVE field state —
          // the one number the COLUMN test uses that no packed byte carries.
          buildingHeightPx: Math.round(casterBuildingHeightPx),
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
