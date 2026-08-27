/**
 * WATER TIER 0's SURFACE — the mesh, its material, and the high-resolution
 * mask that actually draws its shoreline (`docs/planning/Water.md` §6).
 *
 * `water-render.js` builds the material; this owns the mesh's lifetime, crops
 * it to the water's AABB, and loads the mask image. Extracted from
 * `vt-pan-viewer.js` 2026-07-26 the moment it crossed that file's frozen
 * budget — the standing directive is to split as prep, never to loosen the cap
 * (`feedback_ratchet_proactive_not_reactive`). It follows the door-graphics
 * subsystem's shape exactly, which is not a coincidence: a door and a water
 * surface are the same KIND of thing, an opaque-ish lit map element drawn into
 * `buf:scene.color` before lighting.
 *
 * ============================================================================
 * THE MESH GOES INTO THE MAIN `scene`, AND THAT BUYS THREE THINGS
 * ============================================================================
 *  1. OCCLUSION FOR FREE. This renderer paints by `scene/layer-order.js`'s
 *     painter's algorithm, so upper-floor art, decks and roofs draw OVER water
 *     with their own alpha and their holes let it through. That IS "the punch"
 *     — see `water-render.js` for why the planned `buf:scene.attr` read is both
 *     unnecessary and unsafe.
 *  2. THE `gAttr = vec4(0)` CONTRACT FOR FREE. `runGeometryWorldPass` renders
 *     `scene` under the renderer-global zero-attr MRT, which is exactly what
 *     B0-3 requires of a transparent: water READS attributes, never writes them.
 *  3. No extra render call, no extra target, no extra pass wiring.
 *
 * RENDER ORDER 0.5 puts it immediately above the floor background (always index
 * 0 of the sorted list — the bottom of the elevation/sortLayer sort) and below
 * every token, tile and roof, which are 1..N-1. Fractional on purpose:
 * `sortByLayer` owns the integers, so water claims no index and cannot collide
 * with one. A real LayerKey for water is the honest fix and is a deferred rung,
 * the same caveat the door leaves carry.
 *
 * ============================================================================
 * ⚠️ CONSTRUCT THIS AFTER `scene` EXISTS — TRAP #4
 * ============================================================================
 * The caller must build this where `scene` is already initialized. A first
 * draft built the mesh beside water's OTHER wiring ~3,400 lines earlier in
 * `startVtPanViewer()` and threw `Cannot access 'scene' before initialization`
 * on every load — `scene` is a `const` in its temporal dead zone until its own
 * line runs. That is trap #4 of `VT-Pan-Viewer-Extraction.md`, hit three times
 * now by the same instinct ("put the code next to its siblings"). Taking
 * `scene` as an explicit argument is what makes the ordering a caller-visible
 * requirement instead of an invisible one.
 *
 * @module effects/water/water-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import {
  buildWaterSurfaceMaterial,
  WATER_DEFAULT_TIER,
  WATER_TIER5_DISABLED_PENDING_SELF_CAPTURE_FIX,
} from './water-render.js';
import { waterKeyLightDirection } from './water-light.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('WaterSurface');

/**
 * The safety-slide tier gate, pulled out as a pure function so it is
 * directly testable — `water-surface-subsystem.js` otherwise has NO
 * dedicated test file at all (a real, pre-existing coverage gap this
 * doesn't attempt to close wholesale), and this is genuinely safety-
 * critical: `sync()`'s own tier resolution below depends on it clamping
 * correctly every time, not just when eyeballed once. See
 * `WATER_TIER5_DISABLED_PENDING_SELF_CAPTURE_FIX`'s own doc (water-
 * render.js) for WHY tier 5 is clamped; this is only the WHERE/HOW.
 * @param {number} rawTier @returns {number}
 */
export function resolveGatedWaterTier(rawTier) {
  return rawTier >= 5 && WATER_TIER5_DISABLED_PENDING_SELF_CAPTURE_FIX ? 4 : rawTier;
}

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {*} args.scene - the MAIN scene. Must already exist (see header).
 * @param {object} args.waterBody - `createWaterBodySubsystem()`'s handle.
 * @param {(floorIndex: number) => string|null} args.getWaterMaskUrl - boot's
 *   seam onto the RESOLVED floor's `_Water` file. Null = no hi-res mask, which
 *   keeps the surface hidden rather than falling back to a blocky SDF edge.
 * @param {(data: Uint8Array, w: number, h: number, filter: string) => *} args.createMaskTexture -
 *   the literal `new THREE.DataTexture(...)`, defined in `vt/` (trap #5).
 * @param {(url: string) => Promise<object|null>} args.loadMaskImage -
 *   `vt/mask-image.js`'s loader, injected for the same directory-wall reason.
 * @param {*} [args.uViewRect] - envLight's shared view-rect uniform, for tier
 *   3's synthesised eye — the identical object `specular-surface-subsystem.js`
 *   receives, so the two never disagree about where a world point lands.
 * @param {*} [args.uOutdoorsRect] @param {*} [args.outdoorsTexNode] - envLight's
 *   outdoors rect/texture, shared the same way.
 * @param {Function} [args.buildOutdoorsGate] - the world-space gate builder
 *   (`buildWorldSpaceOutdoorsGate`), injected so this module never re-writes
 *   "world XY → mask UV → sample".
 * @param {() => object|null} [args.getSkyHandle] - `effects/sky-access.js`'s
 *   handle for THIS frame. The ONE description of the outdoor light; this
 *   module never touches the hour (`env/one-sun`).
 * @param {*} [args.depthTexture] - `buf:scene.depth`'s DEPTH attachment
 *   (2026-08-15, the depth-authority migration). `null` compiles the
 *   occlusion gate out entirely — see `water-render.js`'s own header.
 * @param {(floorIndex: number) => number|null} [args.resolveExpectedDepth] -
 *   given the floor THIS instance represents, `computeTieSafeExpectedDepth`
 *   for its own background item's rank. Composed in `vt-pan-viewer.js` from
 *   `depthAuthority.rankOf` + `getWaterBackgroundItemId`, the SAME shape
 *   `specular-surface-subsystem.js`/`window-surface-subsystem.js` already
 *   proved. Called every frame from `sync`, never cached — a floor's own
 *   background item can change RANK whenever the depth authority rebuilds.
 *
 *   ⚠️ RETURNS `null` FOR "UNRESOLVED", NOT `0` — a DELIBERATE DIVERGENCE from
 *   specular/window's own `rank === null ? 0 : ...` composition. Those two
 *   own an explicit per-floor render CALL their own frame loop can simply
 *   skip when a floor's rank is unresolved (window-render.js's own "SKIP A
 *   FLOOR THAT ISN'T CURRENTLY COMPOSITED AT ALL" fix). Water has no such
 *   call to skip — every instance's meshes live in the ONE shared main
 *   `scene` and draw unconditionally whenever `mesh.visible` is true, every
 *   frame, with no per-floor early-out available downstream. Failing open to
 *   0 here would reproduce window's OWN third live bug verbatim (an
 *   unresolved floor's content broadcasting across the entire screen,
 *   `step(0, depthHere)` being true everywhere) — so `null` instead feeds
 *   `refreshVisibility` below, which hides the WHOLE mesh rather than letting
 *   the shader gate fail open pixel-by-pixel.
 * @param {*} [args.sunShadowTexture] - ANY sun-shadow slot's texture, purely so
 *   the gate can be compiled into the material at build time (Law 4's JS-time
 *   branch). Never the field this floor actually reads — see
 *   `args.getSunShadowSlot` for that, and `buildSurfaceForTier` for why
 *   building against "my own floor's slot" would be the worse bug.
 * @param {*} [args.waterRefraction] - THIS FLOOR's own
 *   `water-refraction-subsystem.js` handle (2026-08-23, tier 5) — a stable
 *   per-floor object, injected exactly like `waterBody`, never an accessor
 *   function: unlike the sun-shadow slots (a SHARED array reassigned across
 *   floors at runtime), each floor owns one refraction subsystem for its own
 *   lifetime. `.texture`/`.capturedRect`/`.width`/`.height` are read LIVE,
 *   both at build time (`buildSurfaceForTier`) and every frame
 *   (`syncCapturedRefraction`) — never snapshotted — because all four are
 *   `null` until the subsystem's first successful capture and can change
 *   IDENTITY later too (a zoom/pan crossing a bucket boundary reallocates the
 *   capture target, same race class `setFlowPackTexture`'s own doc names).
 *   Absent = today's pre-tier-5 behaviour: `water-render.js`'s own build-time
 *   clamp (`capturedTexture` missing) holds the compiled tier at 4 forever,
 *   the same "torture fixture" posture every other optional seam here takes.
 * @param {*} [args.refractScene] - tier 5's OWN scene (2026-08-23, the self-
 *   capture fix) — `meshes[2]` goes here, never into `args.scene`, so it can
 *   never be baked into what `water-refraction-subsystem.js` captures FROM.
 *   Absent falls back to `args.scene` itself (pre-fix behaviour) — see the
 *   mesh-creation code's own comment for why that's safe for an unwired
 *   caller.
 * @param {(floorIndex: number) => {texture: *, rect: object}|null} [args.getSunShadowSlot] -
 *   THE CAST-SHADOW SEAM (2026-08-16). Given the floor this instance draws on,
 *   the sun-shadow field currently baked FOR that floor, or `null` when no slot
 *   holds it. Composed in `vt-pan-viewer.js` from `sunShadows.fields` — an
 *   array of per-floor slots whose floor attribution a residency pass can
 *   REASSIGN at runtime, which is why this is a per-frame question and not a
 *   construction argument.
 *
 *   ⚠️ ABSENT = TODAY'S BEHAVIOUR, WHICH IS A GLINT THAT SHINES INSIDE
 *   BUILDINGS. The material compiles the gate out entirely when no field
 *   reaches it (Law 4), so an unwired caller is not merely ungated, it is
 *   byte-identical to before this existed. `getStatus().sunShadow` is what
 *   makes that state visible rather than silent.
 * @returns {{sync: (floorIndex: number, viewRect?: object|null) => void,
 *   getStatus: () => object, dispose: () => void}}
 */
export function createWaterSurfaceSubsystem({
  THREE,
  scene,
  waterBody,
  getWaterMaskUrl,
  createMaskTexture,
  loadMaskImage,
  getWaterRenderState,
  timeMsNode,
  uViewRect,
  uOutdoorsRect,
  outdoorsTexNode,
  buildOutdoorsGate,
  getSkyHandle,
  depthTexture = null,
  resolveExpectedDepth,
  sunShadowTexture = null,
  getSunShadowSlot,
  waterRefraction = null,
  // ⚠️ TIER 5's OWN SCENE (2026-08-23, the self-capture fix) — see
  // `water-render.js#WATER_TIER5_DISABLED_PENDING_SELF_CAPTURE_FIX`'s own
  // doc. `meshes[2]` (refraction) is added to THIS scene, never `scene`,
  // so `runGeometryWorldPass`'s own draw of `scene` (the thing
  // `water-refraction-subsystem.js` captures FROM) can never include it.
  // Optional, defaulting to `scene` itself — an unwired caller (the torture
  // fixture, any test that doesn't care about this distinction) renders
  // exactly as it did before this fix existed, same convention every other
  // optional dependency here follows.
  refractScene = null,
}) {
  // Default-off shape matching every other effect seam: an un-wired caller
  // (the torture fixture) renders exactly as it did before water existed.
  getWaterRenderState ??= () => ({ enabled: true, params: {} });
  getSkyHandle ??= () => null;
  // Fails OPEN — matches `buildWaterSurfaceMaterial`'s own `uExpectedDepth`
  // default (0) for an unwired caller: with no resolver at all (the torture
  // fixture, a caller predating this migration), water renders exactly as it
  // did before, gated by paint order alone.
  resolveExpectedDepth ??= () => 0;
  getSunShadowSlot ??= () => null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geometry.setIndex(Array.from(QUAD_INDICES));

  /** A 1×1 all-zero (no water) placeholder until the real mask decodes. The
   * mesh stays hidden until then, so this is never actually sampled — which is
   * why the shader needs no "do I have a mask yet" uniform gate
   * (`tsl/no-uniform-gates`): `mesh.visible` is the gate, JS-side. */
  let maskTexture = createMaskTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, 'linear');
  let maskInfo = null;
  let loadedUrl = null;
  let loading = false;
  /** A 1×1 "fully open, no flow" (RGBA all zero) placeholder for the
   * `flowSolidity`/`flowVelocity` debug channels — see
   * `buildWaterSurfaceMaterial`'s own `flowPackTexture` doc for why this
   * parameter, unlike `maskTexture`, must NEVER be JS `null`.
   *
   * ⚠️ ALL-ZERO BYTES, NOT `[0,0,0,255]` LIKE `maskTexture`'s OWN
   * PLACEHOLDER — S3 moved solidity to the ALPHA channel
   * (`buildWaterProjectPackMaterial`'s own B4 doc), and a byte alpha of 255
   * normalises to solidity=1 (FULLY SOLID), the opposite of "quiet, invisible
   * failure" this placeholder exists to be. `[0,0,0,0]` reads as open water,
   * zero velocity, zero speed — the one byte pattern that is simultaneously
   * the correct silent default for all four channels at once.
   *
   * Unlike `maskTexture` this is a PERMANENT fallback, not a one-shot
   * placeholder: a floor with no water never gets a real flow bake either,
   * so `setFlowPackTexture` can legitimately keep falling back to this for
   * the subsystem's whole lifetime — never disposed until `dispose()`. */
  const flowPackPlaceholder = createMaskTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, 'linear');
  /** The texture object currently bound, by IDENTITY — see
   * `setFlowPackTexture`'s own doc. Starts equal to the placeholder so the
   * FIRST real bake is correctly seen as a change. */
  let boundFlowPackTexture = flowPackPlaceholder;
  /** A 1×1 "no foam" placeholder for `res:waterSim` (S5, 2026-08-18) — same
   * contract as `flowPackPlaceholder` immediately above: `waterSimTexture`
   * must NEVER be JS `null` (`buildWaterSurfaceMaterial`'s own doc). R=0
   * reads as "no foam" after the display-time `smoothstep(WATER_SIM_CLUMP_LO,
   * …)` transform that function applies, for any non-negative `CLUMP_LO` —
   * the same "one byte pattern, correct silent default" property
   * `flowPackPlaceholder`'s own comment names. GBA are unused by this pack
   * today (reserved for S7/S8) so their bytes do not matter; zero for the
   * same "quiet, invisible failure" reasoning throughout this file. */
  const waterSimPlaceholder = createMaskTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, 'linear');
  /** Same bind-by-identity discipline as `boundFlowPackTexture` — see
   * `setWaterSimTexture`'s own doc. */
  let boundWaterSimTexture = waterSimPlaceholder;
  /** The bake generation the geometry was cropped for (-1 = never). */
  let builtForBake = -1;
  /** The resolved-params signature last pushed, so a quiet frame is one string
   * compare rather than three uniform writes. */
  let lastParamsKey = '';
  /** The sky signature last pushed — mirrors `specular-surface-subsystem.js`'s
   * own `lastSkyKey`, and for the same reason: the sky only changes when the
   * clock or the weather does, unlike the eye, which moves every pan. */
  let lastSkyKey = '';
  let enabled = true;
  /** Which debug intermediate is on screen (`water.js#WATER_DEBUG_CHANNELS`,
   * Water-Testament W0) — 0 = the effect as it ships. Mirrors `specular-
   * surface-subsystem.js`'s own copy. */
  let debugChannel = 0;
  /** THE PERFORMANCE TIER THE CURRENT MATERIALS WERE BUILT AT (Effects.md Law
   * 4 — a tier is a JS `if` at graph-BUILD time, so a tier CHANGE means a new
   * node graph, which means new materials, never a live uniform toggle on the
   * existing ones). Mirrors candle flame's own `candleFlameQuality` +
   * rebuild-on-change pattern (`vt-pan-viewer.js`). Seeded at the default so
   * the FIRST build (below, before any `sync()` has resolved a real tier)
   * shows today's shipped look, same reasoning as `WATER_DEFAULT_TIER` itself. */
  let builtForTier = WATER_DEFAULT_TIER;
  /** The last value `resolveExpectedDepth` actually returned (raw, BEFORE
   * `setExpectedDepth`'s own null→0 coercion) — see `refreshVisibility`'s own
   * use of it, and `resolveExpectedDepth`'s doc above for why `null` must hide
   * the mesh rather than fail open. */
  let lastExpectedDepth = 0;

  /** The ONE place visibility is decided, so the conditions can never drift
   * apart across the call sites that each learn about one of them — and,
   * since tier 1, so the two meshes can never drift apart either. Half a
   * water surface (absorption with no in-scatter, or the reverse) is a far
   * worse failure than none, and it would look like a shader bug.
   *
   * `lastExpectedDepth !== null` (2026-08-15) — see `resolveExpectedDepth`'s
   * own doc for why an unresolved floor hides the WHOLE mesh here rather than
   * letting the shader-side gate fail open pixel-by-pixel.
   *
   * ⚠️ THE DEBUG SWAP (2026-08-16, Water-Testament W0) also lives here now —
   * mirrors `specular-surface-subsystem.js`'s own single-mesh swap
   * (`mesh.material = debugChannel > 0 ? surface.debugMaterial : ...`),
   * generalised to water's PAIR: the ABSORB mesh simply hides at a non-zero
   * channel (a multiply pass has nothing to contribute to a diagnostic
   * reading, which is already opaque), and the IN-SCATTER mesh's own
   * `.material` is repointed at `surface.debugMaterial` rather than a THIRD
   * mesh being added — one less geometry slot to keep in step with every
   * bake regrid, and `debugMaterial` carries its own OPAQUE blend state
   * (`water-render.js`), so the swap needs nothing beyond the assignment
   * itself. At channel 0 `surface.debugMaterial` is attached to no mesh,
   * which is what makes the instrument genuinely free rather than merely
   * cheap.
   *
   * `meshes[2]` (tier 5+ refraction, 2026-08-23) hides during a debug channel
   * too, same reasoning as `meshes[0]`: the instrument reads one isolated
   * quantity cleanly, and an alpha-blended sample on top would muddy it. It
   * ALSO hides whenever `surface.refractMaterial` is null (below tier 5, or a
   * tier 5 build that clamped down for want of a captured texture yet) —
   * `!!surface.refractMaterial` is the SAME structural (not uniform) gate
   * `bodyTexNode !== null` already is for tier 1, so a mesh with nothing real
   * to draw is never merely dim, it is absent. */
  function refreshVisibility() {
    const bakedReady = enabled && !!waterBody.getWaterBounds() && !!loadedUrl && lastExpectedDepth !== null;
    const showDebug = bakedReady && debugChannel > 0;
    meshes[0].visible = bakedReady && !showDebug;
    meshes[1].material = showDebug ? surface.debugMaterial : surface.inscatterMaterial;
    meshes[1].visible = bakedReady;
    meshes[2].visible = bakedReady && !showDebug && !!surface.refractMaterial;
  }

  /** Build (or, called again from `sync`, REBUILD) the two tier-gated
   * materials. Reads `waterBody`/`maskTexture` live at call time rather than
   * closing over a snapshot, so a rebuild triggered by a tier change always
   * reflects the CURRENT bake and mask, not whatever was current when the
   * subsystem was constructed. */
  function buildSurfaceForTier(tier) {
    return buildWaterSurfaceMaterial({
      THREE,
      maskTexture,
      maskRect: waterBody.getRect(),
      // The body pack's grid, for the smooth (C2) reconstruction that stops its
      // ~21-world-px texels creasing every steep read on top of it
      // (`water-sampling.js`). Re-pushed on every bake below, since a regrid
      // moves the texel centres this is phase-locked to.
      bodyTexSize: waterBody.getGridSize?.() ?? [1, 1],
      // TIER 1's wet band reads the SDF. The body texture is null until the
      // first bake allocates the targets, and the material only samples it
      // (from tier 1 up) once the mesh is visible — which requires a
      // completed bake — so a null here is never sampled. `sync` re-points it
      // every bake regardless.
      bodyTexture: waterBody.texture,
      bodyRect: waterBody.getRect(),
      // TIER 2's field travels with THE SHARED CLOCK, handed down rather than
      // sampled — `time/one-clock` names water as the effect that broke this in
      // V2 by reading `performance.now()` in eight independent places. A null
      // here (the torture fixture) yields a still surface, never a private clock.
      timeMsNode,
      // TIER 3 — see `water-light.js`. All four are envLight's own shared state,
      // the identical objects `specular-surface-subsystem.js` receives.
      uViewRect,
      uOutdoorsRect,
      outdoorsTexNode,
      buildOutdoorsGate,
      tier,
      // THE DEPTH-AUTHORITY GATE (2026-08-15) — floor-INDEPENDENT (the SAME
      // `buf:scene.depth` attachment every instance reads), so it rebuilds
      // fine on a tier change like everything else here; only `uExpectedDepth`
      // (pushed per-frame in `sync`, below) actually varies per floor.
      depthTexture,
      // THE FLOW PACK'S PREVIEW (2026-08-17, S2 solidity + S3 velocity) —
      // ALWAYS a real texture (never null), starting at
      // `flowPackPlaceholder` and re-pointed by `setFlowPackTexture` on its
      // own cadence, entirely independent of this rebuild. See
      // `buildWaterSurfaceMaterial`'s own `flowPackTexture` doc for why this
      // one does NOT follow `bodyTexture`'s "null compiles it out" shape.
      flowPackTexture: boundFlowPackTexture,
      // `res:waterSim` (S5, 2026-08-18) — same shape as `flowPackTexture`
      // immediately above: ALWAYS a real texture, starting at
      // `waterSimPlaceholder` and re-pointed by `setWaterSimTexture` on its
      // own (per-frame) cadence, independent of this rebuild.
      waterSimTexture: boundWaterSimTexture,
      // THE CAST-SHADOW GATE (2026-08-16). ⚠️ THIS DECIDES ONLY WHETHER THE
      // LOOKUP EXISTS IN THE COMPILED SHADER — it is NOT the field this floor
      // reads. That is a per-frame push (`syncSunShadow` below), because which
      // floor a slot holds is a residency-pass decision that changes at
      // runtime. Building against `getSunShadowSlot(floorIndex)` instead would
      // be the subtler and worse bug: a floor with no slot AT CONSTRUCTION
      // TIME would compile the gate out permanently and then never obey a
      // shadow again, however many slots it was later given. Any slot's texture
      // is a correct thing to build against — they are a fixed-length array
      // allocated once, all the same format and size, so re-pointing between
      // them is a bind-group update and never a pipeline rebuild.
      sunShadowTexture,
      // TIER 5 — REFRACTION (2026-08-23). `waterRefraction` is `null` for an
      // unwired caller (the torture fixture) and its own three fields are
      // `null` until its FIRST successful capture even when wired — see
      // `args.waterRefraction`'s own doc above for why this rebuild-time read
      // is deliberately live, never cached. `capturedRect`/`capturedTexSize`
      // fall through to `undefined` (never a bare `null`) so `water-render.js`'s
      // own default-parameter placeholders apply — that file's two uniforms
      // built from them are UNCONDITIONAL (every tier, not just tier 5), and a
      // literal `null` there would throw at construction, not merely at tier 5.
      capturedTexture: waterRefraction?.texture ?? null,
      capturedRect: waterRefraction?.capturedRect ?? undefined,
      capturedTexSize:
        Number.isFinite(waterRefraction?.width) && Number.isFinite(waterRefraction?.height)
          ? { width: waterRefraction.width, height: waterRefraction.height }
          : undefined,
    });
  }

  /** THE FIELD currently bound, by OBJECT IDENTITY, and the rect pushed with
   * it. Two values rather than one string, deliberately: **every slot covers
   * the SAME caster rect**, so a rect-only key would compare equal across a
   * floor→slot reassignment and silently leave this floor's water reading
   * another floor's shadows (`feedback_one_input_two_extractions_two_
   * thresholds`, and the reason it is worth naming is that the wrong version
   * of this looks completely reasonable). `null`/`''` = nothing pushed yet,
   * which must always push. */
  let boundShadowTexture = null;
  let boundShadowRectKey = '';

  /**
   * Point this floor's material at the sun-shadow field baked for THIS floor.
   *
   * ⚠️ WHY THIS IS PER-FRAME AND NOT PER-BUILD. `sunShadows.fields` is a
   * fixed-length array of SLOTS, and which floor each slot holds is decided by
   * a residency pass on its own cadence — a floor switch, a scene change, a
   * pan. Caching this on the params key or the bake generation would be the
   * exact `feedback_residency_sync_vs_render_loop` shape water has already been
   * bitten by twice (the sliders that did nothing until the camera moved; the
   * visibility that went stale on a rank flip): three inputs on three cadences,
   * gated on one of them.
   * @param {number} floorIndex
   */
  function syncSunShadow(floorIndex) {
    const slot = getSunShadowSlot(floorIndex);
    const texture = slot?.texture ?? null;
    const rectKey = slot?.rect ? `${slot.rect.minX},${slot.rect.minY},${slot.rect.maxX},${slot.rect.maxY}` : 'none';
    if (texture === boundShadowTexture && rectKey === boundShadowRectKey) return;
    boundShadowTexture = texture;
    boundShadowRectKey = rectKey;
    if (!texture) {
      // NO FIELD FOR THIS FLOOR → FULL SUN, never full shadow. See
      // `water-light.js#setSunShadowMix`: this floor may simply have no baked
      // slot right now, and a river that went black on a residency reshuffle is
      // a far worse failure than a glint that outstays its shadow.
      surface.setSunShadowMix(0);
      return;
    }
    // The node is null below tier 3 / when the gate compiled out — guarded the
    // same way `bodyTexNode` is, never assumed.
    if (surface.sunShadowTexNode) surface.sunShadowTexNode.value = texture;
    surface.setSunShadowRect(slot.rect);
    surface.setSunShadowMix(surface.sunShadowTexNode ? 1 : 0);
  }

  /**
   * Point the `flowSolidity`/`flowVelocity` debug channels at THIS floor's
   * own flow pack texture — called from the frame loop right after
   * `waterFlow.maybeBake()`, every frame, unconditionally; the identity
   * check below makes a quiet frame one `===` compare.
   *
   * ⚠️ WHY THIS IS SEPARATE FROM EVERY OTHER RE-POINT IN THIS FILE. The mask
   * (`maskTexNodes`) and the body pack (`bodyTexNode`) each change on THEIR
   * OWN bake, and this is a THIRD, independent cadence (the flow pack's own
   * bake) — folding it into either existing check would make a quiet flow
   * frame silently skip a real mask/body change, or the reverse.
   *
   * `texture ?? flowPackPlaceholder`, never a bare `null` re-point: this
   * parameter's whole contract (`buildWaterSurfaceMaterial`'s own doc) is
   * that it is NEVER JS `null`, because — unlike `bodyTexNode` — nothing here
   * keeps the debug channel's mesh-visibility gated on a completed flow bake,
   * so a null-valued texture node could actually be sampled on the GPU the
   * instant an author picks this channel before the first bake lands.
   * @param {*|null|undefined} texture
   */
  function setFlowPackTexture(texture) {
    const t = texture ?? flowPackPlaceholder;
    if (t === boundFlowPackTexture) return;
    boundFlowPackTexture = t;
    if (surface.flowPackTexNode) surface.flowPackTexNode.value = t;
  }

  /**
   * Point the `simFoamRaw`/`simFoam` debug channels — AND, since S5, the
   * ACTUAL VISIBLE WATER — at THIS floor's own sim pack texture. Called from
   * the frame loop right after `waterSim.tick(dtSec)`, every frame,
   * unconditionally — same shape as `setFlowPackTexture` immediately above,
   * a THIRD independent re-point cadence (the sim pack ticks every frame,
   * not on a bake) alongside the mask's, the body pack's, and the flow
   * pack's own.
   *
   * `texture ?? waterSimPlaceholder`, never a bare `null` re-point — same
   * reasoning as `setFlowPackTexture`'s own doc: `waterSimTexture` is never
   * JS `null` by contract, because nothing gates this material's own
   * visibility on a completed sim tick the way `bodyTexNode` is gated on a
   * completed body bake.
   * @param {*|null|undefined} texture
   */
  function setWaterSimTexture(texture) {
    const t = texture ?? waterSimPlaceholder;
    if (t === boundWaterSimTexture) return;
    boundWaterSimTexture = t;
    if (surface.waterSimTexNode) surface.waterSimTexNode.value = t;
  }

  /**
   * Push THIS floor's sim grid dimensions to the material's smooth-texel
   * reconstruction (`water-render.js#setWaterSimTexSize`) — the C2-eased UV
   * remap (`buildSmoothTexelUv`) needs the real texel pitch of whatever
   * `sim.texture` currently is, or it degrades to a no-op identity remap and
   * the sim foam reads blocky at zoom. Same per-frame cadence as
   * `setWaterSimTexture` immediately above — called right alongside it in
   * `vt-pan-viewer.js` — and just as cheap: a uniform `.set()`, not a shader
   * rebuild.
   * @param {number} w
   * @param {number} h
   */
  function setWaterSimTexSize(w, h) {
    surface.setWaterSimTexSize?.(w, h);
  }

  /**
   * Same contract as `setWaterSimTexSize` immediately above, for the flow
   * pack's own smooth-texel reconstruction (2026-08-19) —
   * `water-render.js#setFlowPackTexSize`'s own doc has the live-reported
   * "pixelated texels" symptom this corrects. Called alongside
   * `setFlowPackTexture` in `vt-pan-viewer.js`, same cadence (the flow
   * pack's own bake, not every frame — its grid never changes between
   * bakes, so pushing it more often would be pure cost for no benefit).
   * @param {number} w
   * @param {number} h
   */
  function setFlowPackTexSize(w, h) {
    surface.setFlowPackTexSize?.(w, h);
  }

  /** The captured-refraction texture currently bound, by IDENTITY — same
   * discipline as `boundFlowPackTexture`/`boundWaterSimTexture` above.
   * Starts `null` (unlike those two) because, unlike their placeholders,
   * `waterRefraction.texture` is genuinely absent — not merely a stand-in —
   * until the subsystem's first successful capture; see `args.waterRefraction`'s
   * own doc for why. */
  let boundCapturedTexture = null;

  /**
   * Point tier 5's three chromatic-fringe taps (`capturedTexNodes`) and its
   * world-rect/texel-size uniforms at THIS floor's own refraction capture —
   * called from the frame loop every frame, unconditionally, same shape as
   * `setFlowPackTexture`/`setWaterSimTexture` above: a FOURTH independent
   * re-point cadence (the capture's own tick, gated on the body/view
   * intersection and any zoom-driven reallocation — neither of which is a
   * water-surface bake or a tier change).
   *
   * ⚠️ WHY THE TEXTURE RE-POINT CANNOT WAIT FOR A TIER-MISMATCH REBUILD.
   * `water-render.js`'s own build-time clamp (`activeTier >= 5 && !capturedTexture
   * ? 4 : requestedTier`) self-corrects the COLD-START race (captured texture
   * was null, is now real) because the mismatch between `resolvedTier` and
   * `builtForTier` keeps retrying every sync() until it converges. But once
   * converged, `resolvedTier === builtForTier` and NO further rebuild fires —
   * so a WARM-path identity change (the SAME tier, a DIFFERENT texture object,
   * e.g. a zoom crossing a bucket boundary reallocates `waterRefraction`'s own
   * capture target) would leave `capturedTexNodes` sampling a stale, possibly
   * already-disposed texture forever without this explicit re-point, exactly
   * `feedback_texture_nodes_must_be_repointed_together`'s own scar one level up.
   *
   * `capturedRect` is pushed unconditionally, never gated on identity — same
   * reasoning as `setViewCentre` above: the world rect a capture covers shifts
   * on ordinary panning even without a reallocation.
   */
  function syncCapturedRefraction() {
    if (!waterRefraction) return;
    const t = waterRefraction.texture;
    if (t && t !== boundCapturedTexture) {
      boundCapturedTexture = t;
      for (const node of surface.capturedTexNodes) node.value = t;
      if (Number.isFinite(waterRefraction.width) && Number.isFinite(waterRefraction.height)) {
        surface.setCapturedTexSize?.(waterRefraction.width, waterRefraction.height);
      }
    }
    if (waterRefraction.capturedRect) surface.setCapturedRect?.(waterRefraction.capturedRect);
  }

  let surface = buildSurfaceForTier(builtForTier);
  /** A cheap, permanently-inert stand-in for `meshes[2].material` whenever
   * `surface.refractMaterial` is `null` (below tier 5) — `THREE.Mesh` always
   * wants a real material object, and this is the SAME "always a real
   * object, gated by JS visibility, never a conditionally-absent slot"
   * discipline `flowPackPlaceholder`/`waterSimPlaceholder` already use for
   * their own textures. Never drawn: `refreshVisibility` hides `meshes[2]`
   * whenever `refractMaterial` is null, so this empty `colorNode`-less
   * material is never actually sampled by the GPU. Created once, disposed
   * once, in `dispose()` below — never per tier-rebuild. */
  const refractPlaceholderMaterial = new THREE.NodeMaterial();
  // THREE meshes over ONE geometry — water is a multiply, THEN an add, THEN
  // (tier 5+) an alpha-blended refraction sample, and blend state is per-
  // material (see `water-render.js`'s header for why one alpha blend cannot
  // be all three). They share the geometry object, so the AABB crop below
  // still writes exactly one position buffer.
  //
  // 0.5 / 0.51 / 0.52 — fractional on purpose, since `sortByLayer` owns the
  // integers: all three sit above the floor background (0) and below every
  // token and roof (1..N-1). Absorption strictly precedes in-scatter (the
  // order matters less than it looks — multiply and add commute over a bed —
  // but it is the physical order and it costs nothing to be right); refraction
  // draws LAST because Effects.md Law 2 makes it an ADDITION on top of the
  // already-shipped tinted-bed look, never a replacement for it.
  // ⚠️ `meshes[2]` goes into `refractMeshScene`, NOT `scene` — see
  // `refractScene`'s own doc above (the constructor param). Falls back to
  // `scene` when unwired, so an un-migrated caller sees the OLD behaviour
  // (all three meshes, one scene) rather than a silently-never-drawn mesh.
  const refractMeshScene = refractScene ?? scene;
  const meshes = [
    Object.assign(new THREE.Mesh(geometry, surface.absorbMaterial), { renderOrder: 0.5 }),
    Object.assign(new THREE.Mesh(geometry, surface.inscatterMaterial), { renderOrder: 0.51 }),
    Object.assign(new THREE.Mesh(geometry, surface.refractMaterial ?? refractPlaceholderMaterial), {
      renderOrder: 0.52,
    }),
  ];
  for (const [i, m] of meshes.entries()) {
    m.frustumCulled = false; // world-space; the camera rect moves every frame
    m.visible = false; // until BOTH a bake and the hi-res mask land
    (i === 2 ? refractMeshScene : scene).add(m);
  }

  /**
   * THE SHORELINE'S ACTUAL SOURCE. Loads the resolved floor's `_Water` file at
   * `MASK_IMAGE_SCALE` and hands it to the material.
   *
   * This replaced thresholding the SDF — see `water-render.js`'s header for why
   * three earlier fixes at the SDF layer could not work. Async and idempotent:
   * the mesh stays hidden until the texture lands, a fraction of a second after
   * the bake, which needs no shader-side fallback path.
   */
  function ensureMaskImage(floorIndex) {
    const url = getWaterMaskUrl(floorIndex);
    if (!url || url === loadedUrl || loading) return;
    loading = true;
    loadMaskImage(url)
      .then((loaded) => {
        loading = false;
        if (!loaded) return; // already logged loudly by the loader
        maskTexture?.dispose?.();
        maskTexture = loaded.texture;
        maskInfo = {
          url,
          uploaded: `${loaded.width}x${loaded.height}`,
          native: `${loaded.nativeWidth}x${loaded.nativeHeight}`,
          mb: +(loaded.bytes / (1024 * 1024)).toFixed(1),
        };
        loadedUrl = url;
        // ⚠️ EVERY node in `maskTexNodes`, not `maskTexNode` alone
        // (`feedback_texture_nodes_must_be_repointed_together`) — the
        // material is built against a 1×1 placeholder and ANY
        // `texture(maskTexture, …)` node this material owns keeps sampling
        // it forever unless re-pointed here. `maskTexNode` is the first
        // entry of this same array (`water-render.js`'s own guarantee), so
        // this one loop is a strict superset of the old single assignment,
        // never a behaviour change for anything that already worked.
        for (const node of surface.maskTexNodes) node.value = loaded.texture;
        // The mask file is placed exactly like the level background it rides
        // with, which is the same rect the derivation grid covers — verified
        // live (both read 2700,1350→13350,6300 on the author's scene).
        surface.setMaskRect(waterBody.getRect());
        refreshVisibility();
      })
      .catch((err) => {
        loading = false;
        log.error('water mask image load rejected —', err);
      });
  }

  /**
   * Per-frame, called right after `waterBody.maybeBake`. Gated on the SAME bake
   * generation, so a quiet frame is one integer compare and the geometry is
   * re-cropped only when the flood actually produced something new.
   * @param {number} floorIndex - the VIEWED floor; the body pack resolves the
   *   borrow itself, and `getWaterMaskUrl` is asked for the RESOLVED one.
   * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} [viewRect] -
   *   the camera's world rect, for tier 3's synthesised eye position. Optional:
   *   a caller that never passes it just never moves the eye, which is a
   *   correct (if static) tier-3 render rather than a crash.
   */
  function sync(floorIndex, viewRect) {
    ensureMaskImage(floorIndex);

    // THE LOOK/TIER STATE — fetched ONCE, at the top, because the tier-rebuild
    // check right below must run BEFORE anything calls a setter on `surface`:
    // a rebuilt surface is a brand-new object, and every setter further down
    // (setViewCentre, setSky, the param pushes) must land on IT, not on the
    // one that is about to be disposed.
    const state = getWaterRenderState();

    // THE TIER GATE (Effects.md Law 4). A resolved tier different from what
    // the CURRENT materials were built at means a DIFFERENT node graph —
    // fewer (or more) texture fetches, a smaller (or larger) compiled shader.
    // Rebuilding is the only way to actually change the compiled shader; a
    // uniform cannot (Law 4's own test — water-render.js's header). Mirrors
    // candle flame's material rebuild on a quality-tier change.
    // ⚠️ SAFETY SLIDE (2026-08-23) — `resolveGatedWaterTier`'s own doc,
    // above, and `WATER_TIER5_DISABLED_PENDING_SELF_CAPTURE_FIX`'s (water-
    // render.js) explain why: tier 5 reads a buffer that already contains
    // its own previous frame's output, live-reported as compounding visual
    // noise, not yet architecturally fixed.
    const rawResolvedTier = Number.isFinite(state.perfTier) ? state.perfTier : WATER_DEFAULT_TIER;
    const resolvedTier = resolveGatedWaterTier(rawResolvedTier);
    if (resolvedTier !== builtForTier) {
      const prev = surface;
      surface = buildSurfaceForTier(resolvedTier);
      meshes[0].material = surface.absorbMaterial;
      meshes[1].material = surface.inscatterMaterial;
      meshes[2].material = surface.refractMaterial ?? refractPlaceholderMaterial;
      prev.absorbMaterial?.dispose?.(); // free the superseded materials on a tier change
      prev.inscatterMaterial?.dispose?.();
      prev.debugMaterial?.dispose?.(); // the THIRD material built every rebuild, same as the other two
      prev.refractMaterial?.dispose?.(); // the FOURTH — null below tier 5, so guarded like the others aren't
      // ⚠️ `surface.tier`, NOT `resolvedTier` (2026-08-18) — a real, previously
      // dormant bug this line's own neighbour (the `getStatus()` comment on
      // `perfTier`/`builtForTier`, below) already documents the CONTRACT for:
      // "they can disagree for at most one sync() between a resolve and its
      // rebuild." That contract is only true if `builtForTier` records what
      // the build ACTUALLY produced. `water-render.js`'s own gate clamps its
      // internal `activeTier` below `tier` whenever `bodyTexture` is not yet
      // ready (its own header explains why) — on any sync() where THIS
      // rebuild races ahead of the body pack's first completed bake,
      // `resolvedTier` and the material's real, compiled tier already
      // disagree at the moment of the build itself, and recording the
      // REQUESTED value here would make that disagreement permanent: no
      // later sync() would ever see `resolvedTier !== builtForTier` again,
      // so the degraded build would never be retried even once bodyTexture
      // becomes available. Recording the ACTUAL tier instead means a raced
      // first build keeps being seen as a mismatch on every subsequent
      // sync() until a real rebuild at the real tier finally succeeds —
      // self-correcting regardless of how the two subsystems happen to race,
      // rather than depending on winning that race.
      builtForTier = surface.tier;
      // Force every cached value below to re-push onto the FRESH material — it
      // starts back at its constructor defaults, and the key-based caches
      // below exist to skip REDUNDANT writes, not the first write to a new
      // object.
      lastParamsKey = '';
      lastSkyKey = '';
      // ⚠️ THE SHADOW SLOT IS ONE OF THEM, and forgetting it here would be
      // silent: a tier change would leave the new material's shadow mix at its
      // constructor 0 (full sun) for as long as the slot happened not to move,
      // i.e. the glint would quietly stop obeying shadows after any profile
      // change (`feedback_new_effect_forgotten`'s shape, one object over).
      boundShadowTexture = null;
      boundShadowRectKey = '';
      // ⚠️ SAME REASONING, ONE RUNG UP (2026-08-23) — a fresh `surface` means
      // fresh (placeholder-valued) `capturedTexNodes`, so the identity check
      // in `syncCapturedRefraction` must be forced to re-push onto THEM, not
      // trust that the OLD surface's nodes already match `waterRefraction`'s
      // current texture (they never do — they're different node objects).
      boundCapturedTexture = null;
    }

    // THE DEPTH-AUTHORITY GATE's OWN EXPECTED DEPTH (2026-08-15). Pushed
    // every frame and NEVER gated on a cached key, unlike the tier/params
    // below — mirrors `window-surface-subsystem.js`'s identical reasoning:
    // this floor's own background item can change RANK whenever the depth
    // authority rebuilds (a residency pass, a pan, any item added or
    // removed), not just on a floor switch. `lastExpectedDepth` keeps the
    // RAW (possibly-null) result for `refreshVisibility` above; the surface
    // setter itself still coerces null→0 as its own shader-side safety net.
    //
    // ⚠️ `refreshVisibility()` HERE TOO, UNCONDITIONALLY — this is the ONE
    // input to visibility that changes on ITS OWN cadence, independent of the
    // params-key and bake-generation gates below. Skipping it on a frame
    // neither of those gates caught would leave `mesh.visible` a frame stale
    // exactly when a residency pass flips this floor's rank from resolved to
    // unresolved (or back) with no param or bake change alongside it.
    lastExpectedDepth = resolveExpectedDepth(floorIndex);
    surface.setExpectedDepth(lastExpectedDepth ?? 0);
    refreshVisibility();

    // THE CAST-SHADOW SLOT — same cadence and the same reasoning as the line
    // above: an input that changes on the depth authority's/residency pass's
    // own clock, never on water's.
    syncSunShadow(floorIndex);

    // TIER 5's OWN CAPTURE — same cadence again: `water-refraction-
    // subsystem.js` ticks on the frame loop's own clock (and can reallocate
    // on a zoom/pan independent of any water-surface bake or tier change), so
    // this reads it fresh every sync() too, never gated on the bake or params
    // keys below.
    syncCapturedRefraction();

    // THE EYE. Pushed every frame and NEVER gated on anything — mirrors
    // `specular-surface-subsystem.js`'s identical reasoning: this is the whole
    // reason the sun-glint moves when the author pans, so a cached-key skip
    // here would silently make it static
    // (`feedback_residency_sync_vs_render_loop`, the same class).
    if (viewRect) {
      surface.setViewCentre((viewRect.minX + viewRect.maxX) / 2, (viewRect.minY + viewRect.maxY) / 2);
    }

    // THE SKY, as ONE description of ONE afternoon. Cached on a key because it
    // only changes when the clock or the weather does, unlike the eye.
    const sky = getSkyHandle();
    if (sky?.key) {
      const skyKey = `${sky.version}|${sky.key.azimuthDeg}|${sky.key.elevationDeg}|${sky.key.strength}|${sky.fill?.strength}`;
      if (skyKey !== lastSkyKey) {
        lastSkyKey = skyKey;
        surface.setSky({
          keyDir: waterKeyLightDirection(sky.key),
          keyColor: sky.key.colorRgb ?? [1, 1, 1],
          keyStrength: sky.key.strength ?? 0,
          fillColor: sky.fill?.colorRgb ?? [1, 1, 1],
          fillStrength: sky.fill?.strength ?? 0,
        });
      }
    }

    // THE LOOK PARAMS, pushed every frame. Cheap (three uniform writes against
    // a cached key) and it must NOT ride the bake gate below: a slider drag
    // changes no geometry and produces no new bake, so gating these on the
    // bake generation would make every control in the panel do nothing until
    // the mask happened to change — which is exactly the residency-sync bug
    // class this codebase has already paid for once
    // (`feedback_residency_sync_vs_render_loop`). `state` was already fetched
    // at the top of this function, ahead of the tier gate.
    const p = state.params ?? {};
    const key = [
      state.enabled ? 1 : 0,
      state.debugChannel ?? 0,
      p.tint,
      p.opacity,
      p.depth,
      p.pollution,
      p.shorelineDepth,
      p.absorption,
      p.depthScalePx,
      p.inscatter,
      p.foam,
      p.flowSpeedPx,
      p.flowAngleDeg,
      p.waveScalePx,
      p.chop,
      p.wetBandPx,
      p.wetStrength,
      p.sunGlint,
      p.skySheen,
      p.glossiness,
      p.viewerHeight,
      p.shadowResponse,
      p.swashFoam,
      p.breakFoam,
      p.foamTrail,
      p.caustics,
      p.causticSharpness,
      p.causticScale,
      p.causticNetting,
      p.causticWaveWarp,
      p.causticWaveWarpCap,
      p.causticGrowth,
      p.causticGrowthCap,
      p.causticGrowthScale,
      p.causticGrowthSpeed,
      p.causticEvolveSpeed,
      p.causticJunctionWidth,
      p.causticLineFloor,
      p.causticSpecularInfluence,
      p.refractStrengthPx,
      p.foamEdgeSharpness,
      // ROH TUNING (2026-08-19) — bankWarp/flowWarp + buildFoamCellularStructure's own knobs.
      p.bankInfluence,
      p.flowWarpInfluence,
      p.foamFlowNudge,
      p.foamEdgeFar,
      p.foamEdgeAaPx,
      p.foamBubbleAmount,
      p.foamBubbleOctave,
      p.foamBubbleTimeScale,
      p.foamGrainAmount,
      p.foamGrainOctave,
      p.foamGrainTimeScale,
      p.simClumpLo,
      p.simClumpHi,
      p.simClumpAaPx,
    ].join('|');
    if (key !== lastParamsKey) {
      lastParamsKey = key;
      if (Array.isArray(p.tint)) surface.setTint(p.tint);
      if (Number.isFinite(p.opacity)) surface.setOpacity(p.opacity);
      if (Number.isFinite(p.depth)) surface.setDepth(p.depth);
      if (Number.isFinite(p.pollution)) surface.setPollution(p.pollution);
      if (Number.isFinite(p.shorelineDepth)) surface.setShorelineDepth(p.shorelineDepth);
      if (Number.isFinite(p.absorption)) surface.setAbsorption(p.absorption);
      if (Number.isFinite(p.depthScalePx)) surface.setDepthScalePx(p.depthScalePx);
      if (Number.isFinite(p.inscatter)) surface.setInscatter(p.inscatter);
      if (Number.isFinite(p.foam)) surface.setFoam(p.foam);
      if (Number.isFinite(p.flowSpeedPx)) surface.setFlowSpeedPx(p.flowSpeedPx);
      if (Number.isFinite(p.flowAngleDeg)) surface.setFlowAngleDeg(p.flowAngleDeg);
      if (Number.isFinite(p.waveScalePx)) surface.setWaveScalePx(p.waveScalePx);
      if (Number.isFinite(p.chop)) surface.setChop(p.chop);
      if (Number.isFinite(p.wetBandPx)) surface.setWetBandPx(p.wetBandPx);
      if (Number.isFinite(p.wetStrength)) surface.setWetStrength(p.wetStrength);
      if (Number.isFinite(p.sunGlint)) surface.setSunGlint(p.sunGlint);
      if (Number.isFinite(p.skySheen)) surface.setSkySheen(p.skySheen);
      if (Number.isFinite(p.glossiness)) surface.setGlossiness(p.glossiness);
      if (Number.isFinite(p.viewerHeight)) surface.setViewerHeight(p.viewerHeight);
      if (Number.isFinite(p.shadowResponse)) surface.setShadowResponse(p.shadowResponse);
      if (Number.isFinite(p.swashFoam)) surface.setSwashFoam(p.swashFoam);
      if (Number.isFinite(p.breakFoam)) surface.setBreakFoam(p.breakFoam);
      if (Number.isFinite(p.foamTrail)) surface.setFoamTrail(p.foamTrail);
      if (Number.isFinite(p.caustics)) surface.setCaustics(p.caustics);
      if (Number.isFinite(p.causticSharpness)) surface.setCausticSharpness(p.causticSharpness);
      if (Number.isFinite(p.causticScale)) surface.setCausticScale(p.causticScale);
      if (Number.isFinite(p.causticNetting)) surface.setCausticNetting(p.causticNetting);
      if (Number.isFinite(p.causticWaveWarp)) surface.setCausticWaveWarp(p.causticWaveWarp);
      if (Number.isFinite(p.causticWaveWarpCap)) surface.setCausticWaveWarpCap(p.causticWaveWarpCap);
      if (Number.isFinite(p.causticGrowth)) surface.setCausticGrowth(p.causticGrowth);
      if (Number.isFinite(p.causticGrowthCap)) surface.setCausticGrowthCap(p.causticGrowthCap);
      if (Number.isFinite(p.causticGrowthScale)) surface.setCausticGrowthScale(p.causticGrowthScale);
      if (Number.isFinite(p.causticGrowthSpeed)) surface.setCausticGrowthSpeed(p.causticGrowthSpeed);
      if (Number.isFinite(p.causticEvolveSpeed)) surface.setCausticEvolveSpeed(p.causticEvolveSpeed);
      if (Number.isFinite(p.causticJunctionWidth)) surface.setCausticJunctionWidth(p.causticJunctionWidth);
      if (Number.isFinite(p.causticLineFloor)) surface.setCausticLineFloor(p.causticLineFloor);
      if (Number.isFinite(p.causticSpecularInfluence)) surface.setCausticSpecularInfluence(p.causticSpecularInfluence);
      if (Number.isFinite(p.refractStrengthPx)) surface.setRefractStrengthPx(p.refractStrengthPx);
      if (Number.isFinite(p.foamEdgeSharpness)) surface.setFoamEdgeSharpness(p.foamEdgeSharpness);
      if (Number.isFinite(p.bankInfluence)) surface.setBankInfluence(p.bankInfluence);
      if (Number.isFinite(p.flowWarpInfluence)) surface.setFlowWarpInfluence(p.flowWarpInfluence);
      if (Number.isFinite(p.foamFlowNudge)) surface.setFoamFlowNudge(p.foamFlowNudge);
      if (Number.isFinite(p.foamEdgeFar)) surface.setFoamEdgeFar(p.foamEdgeFar);
      if (Number.isFinite(p.foamEdgeAaPx)) surface.setFoamEdgeAaPx(p.foamEdgeAaPx);
      if (Number.isFinite(p.foamBubbleAmount)) surface.setFoamBubbleAmount(p.foamBubbleAmount);
      if (Number.isFinite(p.foamBubbleOctave)) surface.setFoamBubbleOctave(p.foamBubbleOctave);
      if (Number.isFinite(p.foamBubbleTimeScale)) surface.setFoamBubbleTimeScale(p.foamBubbleTimeScale);
      if (Number.isFinite(p.foamGrainAmount)) surface.setFoamGrainAmount(p.foamGrainAmount);
      if (Number.isFinite(p.foamGrainOctave)) surface.setFoamGrainOctave(p.foamGrainOctave);
      if (Number.isFinite(p.foamGrainTimeScale)) surface.setFoamGrainTimeScale(p.foamGrainTimeScale);
      if (Number.isFinite(p.simClumpLo)) surface.setSimClumpLo(p.simClumpLo);
      if (Number.isFinite(p.simClumpHi)) surface.setSimClumpHi(p.simClumpHi);
      if (Number.isFinite(p.simClumpAaPx)) surface.setSimClumpAaPx(p.simClumpAaPx);
      debugChannel = Number.isFinite(state.debugChannel) ? Math.max(0, Math.round(state.debugChannel)) : 0;
      surface.setDebugChannel(debugChannel);
      enabled = state.enabled !== false;
      refreshVisibility();
    }

    if (builtForBake === waterBody.bakeGeneration) return;
    builtForBake = waterBody.bakeGeneration;
    const bounds = waterBody.getWaterBounds();
    refreshVisibility();
    if (!bounds) return;
    surface.setMaskRect(waterBody.getRect());
    // TIER 1's wet band samples the SDF — re-point it every bake, since a
    // regrid recreates the target and the old texture would go stale.
    // `bodyTexNode` is `null` below tier 1 (never sampled there — see
    // water-render.js's header), so this is guarded rather than assumed.
    if (waterBody.texture && surface.bodyTexNode) surface.bodyTexNode.value = waterBody.texture;
    surface.setBodyRect(waterBody.getRect());
    // ⚠️ THE GRID SIZE RIDES THE SAME BAKE GATE AS THE RECT, and must: the
    // smooth reconstruction (`water-sampling.js`) is phase-locked to the texel
    // centres, so a regrid that moved the rect but left the size stale would
    // put the eased fraction out of step with the hardware filter it exists to
    // correct — which reads as the creases coming back, not as an error.
    {
      const [gw, gh] = waterBody.getGridSize?.() ?? [1, 1];
      surface.setBodyTexSize(gw, gh);
    }
    const positions = buildQuadPositions([
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
      { x: bounds.minX, y: bounds.maxY },
    ]);
    const posAttr = geometry.getAttribute('position');
    if (posAttr && posAttr.array.length === positions.length) {
      posAttr.array.set(positions);
      posAttr.needsUpdate = true; // same buffer, new contents (BufferAttribute has no dispose)
    } else {
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }
  }

  return {
    sync,
    /** Re-push `capturedTexNodes`/`capturedRect`/`capturedTexSize` from THIS
     * floor's `waterRefraction` handle — the SAME function `sync()` already
     * calls, exposed separately (2026-08-23, the self-capture fix) so
     * `runWaterRefractionCapturePass` can call it a SECOND time, right after
     * this floor's own `tick()`, immediately before drawing `refractScene`.
     * `sync()`'s own call (from the frame loop's earlier 'light.accumulate'
     * stage, BEFORE this frame's capture has even run) is otherwise pushing
     * LAST frame's `capturedRect`/texture identity — harmless in the common
     * case (both are usually unchanged frame to frame) but a real, if rare,
     * source of a one-frame rect/content mismatch during a reallocation or a
     * fast camera pan. Idempotent and cheap either way — see the function's
     * own doc for why calling it twice a frame costs nothing extra. */
    syncCapturedRefraction,
    /**
     * FLOOR-PREPARE HOOK (2026-08-16, live author report on window light's
     * OWN copy of this fix — same effect shape, same gap here). Starts the
     * SAME mask fetch `sync()` would, deliberately WITHOUT the rest of
     * `sync()`'s per-frame work: the tier gate (which can REBUILD `surface`'s
     * materials, disposing the current ones) and the depth-authority expected-
     * depth push (`resolveExpectedDepth`, which reads `depthAuthority.rankOf`
     * for whichever floor is passed).
     *
     * `vt-pan-viewer.js#prepareFloor` calls this for the TARGET floor while
     * `view.floorIndex` still points at the floor genuinely on screen — depth
     * authority has not been rebuilt for the target floor yet (that happens at
     * COMMIT, inside the residency pass `prepareFloor` deliberately does not
     * run early). Calling the FULL `sync()` here would be worse than window's
     * own version of this problem: it could REBUILD this floor's water
     * materials against a tier resolved for... whichever floor's settings
     * happen to be current, disposing/recreating GPU objects for a mesh that
     * is not even drawn yet. `ensureMaskImage` has no such dependency — it
     * only reads `getWaterMaskUrl(floorIndex)`, a scene-wide catalog lookup —
     * so calling it alone is the narrowest fix that actually closes the gap.
     *
     * Safe to call before this floor's own subsystem instance would otherwise
     * exist: water is per-floor by construction (`waterSurfacesByFloor`, a
     * separate Map entry per floor), unlike specular's single shared
     * instance — which is why THIS effect gets this hook and specular does
     * not (see specular's own `readiness.why` in `effects/specular/
     * specular.js` for that distinction stated the other way round).
     */
    prefetchMask: ensureMaskImage,
    /**
     * SCENE READINESS (vt/settle.js probe `waterSurfaceMask`) — is a mask image
     * fetch in flight right now?
     *
     * A separate one-line accessor rather than a field on `getStatus()` because
     * readiness polls this several times a second and `getStatus()` builds a
     * whole diagnostic object including `waterBody.getWaterBounds()`.
     *
     * Safe to gate a load on, in the way a "has it baked yet?" flag would NOT
     * be: `loading` is set false in BOTH the `.then` and the `.catch` above, so
     * a failed mask can never leave readiness waiting forever — and it reads
     * false before the first request too, so an effect that is switched off (and
     * therefore never asks for a mask) is not mistaken for one that is still
     * loading. Both halves matter now that a floor change holds the previous
     * floor on screen instead of raising a curtain.
     */
    isLoadingMask: () => loading,
    /**
     * THE FULL-RESOLUTION mask texture itself (2026-08-17, water-flow's own
     * seam) — `null` until a REAL image has loaded (`loadedUrl` unset), never
     * the 1×1 placeholder every OTHER consumer of `maskTexture` builds
     * against. Exists so `water-flow-subsystem.js`'s solidity bake can REBUILD
     * against the real texture directly rather than re-pointing a node built
     * before it existed — the same "rebuild, don't repoint" discipline
     * `feedback_texture_nodes_must_be_repointed_together` names as the safer
     * of the two lawful options, applied here from the start instead of
     * learned the expensive way a second time.
     */
    getFullResMaskTexture: () => (loadedUrl ? maskTexture : null),
    setFlowPackTexture,
    setFlowPackTexSize,
    setWaterSimTexture,
    setWaterSimTexSize,
    /** For the `water-body` report — merged into the body pack's own status. */
    getStatus() {
      return {
        // ⚠️ `meshes[1].visible`, NOT `meshes[0]` — since the debug swap
        // (2026-08-16) the ABSORB mesh (`meshes[0]`) is DELIBERATELY hidden
        // whenever a debug channel is showing (see `refreshVisibility`), so
        // it alone would report `false` — "nothing is drawing" — while the
        // instrument's own picture is genuinely on screen. `meshes[1]` stays
        // the visible carrier in both states, real or diagnostic; read
        // alongside `debugChannel` below to know WHICH.
        visible: meshes[1].visible,
        // Both, listed: tier 1 made water two draws, and "the multiply is
        // showing but the add is not" is a state the old single number could
        // not have reported. At a non-zero `debugChannel` the multiply's own
        // renderOrder is still listed even though that mesh is hidden — this
        // is the mesh PAIR's own layering contract, not a live picture of
        // what is currently visible (see `visible` above for that).
        renderOrder: meshes.map((m) => m.renderOrder).join(' + '),
        // Non-zero means the author is looking at a DIAGNOSTIC, not at the
        // effect — reported so a channel can never be silently left on and
        // then mistaken for a rendering bug (mirrors `specular-surface-
        // subsystem.js`'s own field).
        debugChannel,
        builtForBake,
        // THE TIER GATE'S OWN HONESTY CHECK (`feedback_instruments_must_not_
        // lie`) — `perfTier` is what the cascade RESOLVED; `builtForTier` is
        // what the live materials actually compiled with `if (activeTier >=
        // N)` (water-render.js). They can disagree for at most one `sync()`
        // between a resolve and its rebuild; agreeing every other frame is
        // the proof the rebuild-on-change wiring is actually running.
        perfTier: builtForTier,
        // ⚠️ WHAT THE TIER COSTS THE AUTHOR, IN THEIR OWN VOCABULARY (2026-08-17).
        // `perfTier: 3` is a true statement that answered nobody's question: the
        // author had five live sliders doing nothing and no way to connect that
        // to a number. Tier 4 needs the `quality` profile, so on a default
        // `standard` install every shore-foam term is compiled out while its
        // controls stay draggable — reported as *"Foam is set to full and I
        // can't see any"*. A report that states the gate but not its
        // CONSEQUENCE is the passive half of `feedback_instruments_must_not_lie`.
        inertControls:
          builtForTier >= 4
            ? 'none — every shipped water control is live at this rung'
            : 'swashFoam, breakFoam, foamTrail, caustics (+ wave shoaling) are ALL compiled out: ' +
              'they are rung 4, which needs the quality profile. Their sliders still move and are still ' +
              'saved; nothing reads them until the profile is raised.',
        bounds: waterBody.getWaterBounds(),
        // `null` means the hi-res mask has not loaded, and the surface is
        // therefore hidden BY DESIGN — the SDF is not asked to draw the edge
        // any more, so there is nothing to fall back to. `uploaded` vs
        // `native` shows MASK_IMAGE_SCALE actually applied; if `uploaded` ever
        // reads about the same as the derivation grid (~512), the hi-res path
        // is not running and the old blocky look is back.
        maskImage: maskInfo ?? 'not loaded',
        // `false` means every pixel takes tier 3's indoors path (zero sun/sky
        // reflection) regardless of what the map looks like — silent on
        // screen, never guessed at.
        outdoorsGate: surface.outdoorsGateCompiled,
        // `false` means tier 3 compiled its FLAT-normal fallback, which
        // measured as an invisible 0.0084 wash for three days without anything
        // reporting it (`water-light.js`'s header). Reported now precisely
        // because that state looks healthy from every other field here.
        waveNormal: surface.normalCompiled,
        // THE DEPTH-AUTHORITY GATE (2026-08-15) — `false` on a live multi-floor
        // scene means water is back to paint-order-only occlusion, the exact
        // "renders above things that should mask it" bug this migration fixed.
        floorGateCompiled: surface.floorGateCompiled,
        // THE CAST-SHADOW GATE (2026-08-16). Two independent things can go
        // wrong and they look identical on screen (a glint that ignores a
        // building), so both are reported: `compiled` false means no field
        // texture ever reached the material — the gate is not in the shader at
        // all — while `slot` reading 'none' means the gate IS compiled but this
        // floor has no baked field right now, so it is deliberately passing
        // full sun. `feedback_identical_symptom_two_gates_needs_a_discriminator`.
        sunShadow: { compiled: surface.sunShadowCompiled, slot: boundShadowRectKey || 'not synced' },
        // TIER 5 — REFRACTION (2026-08-23). `compiled` false means either the
        // tier is below 5, or it clamped back down to 4 at build time for
        // want of a captured texture yet (`water-render.js`'s own clamp) —
        // either way there is nothing to draw and `meshes[2]` stays hidden.
        // `capture` is the subsystem's OWN status report, unwrapped one level
        // so a live scene shows WHY there is nothing yet ('no water body rect
        // for this floor', 'water fully off-screen this frame', etc.) rather
        // than a bare boolean that cannot distinguish "never wired" from
        // "wired but waiting its first frame".
        refraction: { compiled: !!surface.refractMaterial, capture: waterRefraction?.getStatus?.() ?? 'not wired' },
        // The raw (possibly-null) resolve — `null` means this floor's own
        // background item has no rank right now (not currently composited, or
        // a transient residency-pass race), and IS why `visible` reads false
        // even with a healthy bake and a loaded mask; see `resolveExpectedDepth`'s
        // own doc for why this hides the mesh rather than failing the shader open.
        expectedDepth: lastExpectedDepth,
      };
    },
    dispose() {
      // ⚠️ `meshes[2]` lives in `refractMeshScene`, not `scene` — removing it
      // from the wrong scene is a silent no-op (`Object3D.remove()` checks
      // membership first), which would leak it in `refractMeshScene` forever
      // rather than throw. See the mesh-creation loop's own comment above.
      for (const [i, m] of meshes.entries()) (i === 2 ? refractMeshScene : scene).remove(m);
      geometry.dispose(); // shared by both meshes — disposed once, not per mesh
      surface.absorbMaterial?.dispose?.();
      surface.inscatterMaterial?.dispose?.();
      surface.debugMaterial?.dispose?.();
      surface.refractMaterial?.dispose?.();
      refractPlaceholderMaterial.dispose(); // the ONE object never touched by a tier rebuild — freed here instead
      maskTexture?.dispose?.();
      flowPackPlaceholder?.dispose?.();
      waterSimPlaceholder?.dispose?.();
    },
  };
}
