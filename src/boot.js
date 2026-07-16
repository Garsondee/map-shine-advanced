/**
 * Map Shine Advanced 0.6.0 — "Keyhole"
 * =====================================
 * src/boot.js — the ONE entry point of the V3 rebirth (docs/planning/Keyhole.md §3).
 *
 * `module.json`'s `esmodules` points at this file and NOTHING else. Everything the
 * module does in the new architecture is reached from here: init/ready hooks, the
 * virtual-texture core (src/vt/), the frame graph (src/graph/), the Foundry adapter
 * (src/foundry/), and the effects. None of it exists yet — this is Stage 0.
 *
 * THE DOCTRINE (Keyhole §0), enforced from the first line:
 *   1. One path per behavior. No fallback that routes through legacy code.
 *   2. `legacy/` is frozen and quarantined — src/ NEVER imports from legacy/.
 *   3. Nothing is ever allocated at world resolution (enforced later in the allocator).
 *   4. The hard case ships first (the torture scene is Stage 0's fixture).
 *
 * STAGE 0 (Keyhole §8) proved the new tree is wired and the new Three boots —
 * a colored triangle. STAGE 1 ("the law, running") is now underway: the
 * allocator's world-res law, the page-cache/table/residency core, and the
 * physical GPU atlas are built and Node/mock-verified (src/graph/, src/vt/) —
 * but nothing is wired into a real render pass yet, so the boot heartbeat
 * below is still the only thing on screen. Real map rendering returns once
 * Stage 1's geometry pass lands. That is the plan working, not breaking.
 *
 * This file also hosts the temporary Keyhole DEBUG PANEL (src/diag/debug-panel.js)
 * in the same corner box as the heartbeat — a growing set of one-click reports
 * for the author to copy/paste back during development. Every future stage can
 * register its own report via `MapShine.debug.registerReport(...)`.
 */

// THE NODE BUILD (docs/planning/Shaders.md). It does NOT export WebGLRenderer —
// which is why the TSL port was all-or-nothing: one import, and every renderer
// moves at once. WebGPURenderer picks WebGPU or WebGL2 itself.
import * as THREE from './vendor/three/three.webgpu.js';
import { installSoak } from './diag/soak.js';
import { installDebugPanel } from './diag/debug-panel.js';
import { runVtLiveDecodeTest } from './vt/vt-live-decode-report.js';
import {
  startVtPanViewer,
  stopVtPanViewer,
  getVtPanViewerDiagnostics,
  setVtPanViewerFloor,
  setVtPanViewerDisplayLayer,
  runZoomThrashTest,
  soakPanStep,
  soakSwitchFloorStep,
  refreshVtPanViewerItems,
  syncVtPanViewerCamera,
} from './vt/vt-pan-viewer.js';
import { getActiveSceneFloors, computeVisibleFloorIndices } from './foundry/active-scene-source.js';
import { collectSceneLayers } from './foundry/scene-layers.js';
import { collectTokens, diagnoseTokens } from './foundry/scene-tokens.js';
import { engageFoundryFallback } from './diag/render-fallback.js';
import {
  beginSceneLoad,
  beginSceneLoadPhase,
  reportSceneLoadProgress,
  endSceneLoad,
  getLoadingScreenState,
  resetLoadingSceneMemory,
} from './ui/loading-screen.js';
import { LOAD_PHASES } from './ui/load-progress.js';
import { computeSceneDimensions } from './foundry/scene-geometry.js';
import { SORT_LAYERS, makeLayerKey } from './scene/layer-order.js';
import { getSourceBitmap } from './vt/decode-pool.js';
import { registerPixiProxy, getPixiResidencyReport } from './foundry/pixi-proxy-textures.js';

const MODULE_ID = 'map-shine-advanced';

/** Boot-heartbeat panel size. Shrunk from 320x200 (author, 2026-07-16: the
 * spinning triangle is genuinely useful for spotting frame-rate trouble, but it
 * does not need to be that big) — the space it gives up now carries the live perf
 * readout, which is the thing you actually read once the triangle has told you
 * something is wrong. */
const HEARTBEAT_W = 210;
const HEARTBEAT_H = 90;
const VERSION = '0.6.0-dev.0';
const CODENAME = 'Keyhole';
const STAGE = 'Stage 1 · the law, running';

const TAG = `[MSA ${VERSION} ${CODENAME}]`;

// ---------------------------------------------------------------------------
// Namespace. Legacy is disconnected, so there is no live `window.MapShine` to
// collide with — but we still create-if-absent and stamp our own fields so the
// V3 tree owns this namespace cleanly.
// ---------------------------------------------------------------------------
const MapShine = (globalThis.MapShine = globalThis.MapShine || {});
MapShine.version = VERSION;
MapShine.codename = CODENAME;
MapShine.__stage = STAGE;
MapShine.THREE = THREE; // single Three instance for the whole V3 tree

/** Guard against double-boot (Foundry hot-reload, duplicate module load). */
if (MapShine.__keyholeBooted) {
  console.warn(`${TAG} already booted; skipping re-entry.`);
} else {
  MapShine.__keyholeBooted = true;
  install();
}

function install() {
  installSoak(MapShine); // exposes MapShine.soak(n) — the stage-gate soak harness
  installDebugPanel(MapShine); // starts console capture NOW, as early as possible
  MapShine.debug.registerReport('vt-live-decode', 'Live decode test', async () => ({
    report: 'vt-live-decode',
    generatedAt: new Date().toISOString(),
    ...(await runVtLiveDecodeTest(`modules/${MODULE_ID}/assets/torture/torture_floor0.png`)),
  }));
  const TORTURE_FLOOR_COUNT = 3;
  const tortureImageUrl = (floorIndex) => `modules/${MODULE_ID}/assets/torture/torture_floor${floorIndex}.png`;

  // MULTI-LAYER (Keyhole §4.1, the mask pile-up killer): the torture fixture
  // emits real mask PNGs on disk (tools/make-torture-world.mjs), so it's where
  // we PROVE the masks page through the same fixed cache as albedo — V2 died of
  // _Fire/_Outdoors/_Specular/_Tree/_Bush all held at world resolution at once,
  // and this streams every one through the keyhole instead. Only albedo
  // displays until a mask is selected (VT Layers: Cycle Displayed Layer).
  //
  // CHANNEL-PACKING (author-confirmed mask taxonomy, 2026-07-16): only the 3
  // SINGLE-CHANNEL masks (_Shadow black=dark/white=lit, _Outdoors white=out/
  // black=in, _Fire white=fire-spawn) pack — into R/G/B of one RGBA texture +
  // a shared structural-hole alpha (the hole is a FLOOR property, identical
  // across masks — author-confirmed, see tools/make-torture-world.mjs's
  // fillHoleAlpha). The COLOURED masks (_Specular metallic tint, _Window
  // light colour) and RGBA masks (_Tree/_Bush colour+coverage) each need a
  // full texture and stay unpacked. Real math: 7 masks → 4 packs (not the
  // plan's original optimistic 13→6) — directly answers the GPU page-cache
  // pressure every live castle-scenario report showed (thousands of
  // evictions/misses at 24 unpacked packs × 3 floors).
  const TORTURE_UNPACKED_MASK_NAMES = ['Specular', 'Window', 'Tree', 'Bush'];
  const tortureMaskUrl = (floorIndex, name) =>
    `modules/${MODULE_ID}/assets/torture/torture_floor${floorIndex}_${name}.png`;
  const tortureLayerUrls = (floorIndex) => [
    {
      name: 'ShadowOutdoorsFire', // the packed single-channel trio
      channelUrls: {
        r: tortureMaskUrl(floorIndex, 'Shadow'),
        g: tortureMaskUrl(floorIndex, 'Outdoors'),
        b: tortureMaskUrl(floorIndex, 'Fire'),
      },
    },
    ...TORTURE_UNPACKED_MASK_NAMES.map((name) => ({ name, url: tortureMaskUrl(floorIndex, name) })),
  ];

  // THE CASTLE-COURTYARD TEST (author, 2026-07-16: "on a castle on floor three
  // looking down into the courtyard... fires/trees/lighting on all three
  // floors, all mutually visible"). Until now this button's `visibleFloorIndices`
  // was left at startVtPanViewer's default `(i) => [i]` — SINGLE FLOOR ONLY —
  // because the torture fixture's scene macro has no real `visibility.levels`
  // data to drive `computeVisibleFloorIndices` (§6's known mismatch). That
  // default silently meant: no floor ever composited beneath another, so an
  // albedo hole showed the canvas's own black backdrop, not a lower floor —
  // and, more importantly, the multi-layer mask streaming this session built
  // was NEVER exercised for more than one floor's fine (view-tier) pages at
  // once, only its always-resident coarse pins. ALWAYS composite all 3 torture
  // floors — the worst case (every floor's every layer streaming fine detail
  // simultaneously) and the direct proof of the castle scenario, not an
  // approximation of it.
  const tortureVisibleFloorIndices = () => Array.from({ length: TORTURE_FLOOR_COUNT }, (_, i) => i);

  // The fixture's synthetic world. It has no Foundry Scene documents to read, so
  // it fabricates the same shapes `collectSceneLayers` produces for a real scene
  // — deliberately, so the fixture and real scenes drive ONE renderer down ONE
  // path rather than forking a second (doctrine #1). The fixture's art IS its
  // world: 12000² per floor, no padding, so sceneRect == the canvas rect.
  const TORTURE_WORLD_PX = 12000;
  const tortureDimensions = computeSceneDimensions({
    width: TORTURE_WORLD_PX,
    height: TORTURE_WORLD_PX,
    padding: 0,
    grid: { size: 100 },
  });

  /**
   * The fixture's draw list: one background item per floor, stacked in an
   * elevation band per floor (bottom = i*10) so the real sort law orders them
   * exactly as it orders a real scene's Levels. All 3 floors always composite —
   * the castle-courtyard worst case (every floor's every layer streaming fine
   * detail at once), which is the whole point of the fixture.
   */
  const buildTortureItems = () =>
    tortureVisibleFloorIndices().map((i) => ({
      id: `torture:floor${i}`,
      kind: 'levelBackground',
      key: makeLayerKey({ elevation: i * 10, sortLayer: SORT_LAYERS.SCENE, sort: i, zIndex: 0 }),
      src: tortureImageUrl(i),
      levelId: `torture${i}`,
      visibleOnLevelIds: [`torture${i}`],
      alpha: 1,
      tint: 0xffffff,
      alphaThreshold: 0.75,
      occlusion: { modes: 0, alpha: 0 },
      restrictsLight: true,
      restrictsWeather: true,
      isUpper: false,
      hidden: false,
      _placement: { kind: 'level', texturesConfig: {} },
      __floorIndex: i, // so extraLayersForItem can find this item's mask set
    }));

  const tortureExtraLayers = (item) => tortureLayerUrls(item.__floorIndex ?? 0);

  MapShine.debug.registerReport('vt-pan-viewer-start', 'Start: torture fixture', async () => ({
    report: 'vt-pan-viewer-start',
    generatedAt: new Date().toISOString(),
    ...(await startVtPanViewer({
      THREE,
      buildItems: buildTortureItems,
      dimensions: tortureDimensions,
      floorCount: TORTURE_FLOOR_COUNT,
      extraLayersForItem: tortureExtraLayers,
    })),
  }));
  MapShine.debug.registerReport('vt-pan-viewer-diagnostics', 'Diagnostics', () => ({
    report: 'vt-pan-viewer-diagnostics',
    generatedAt: new Date().toISOString(),
    ...getVtPanViewerDiagnostics(),
  }));
  // WHY IS MY TOKEN NOT THERE? Reads the live scene documents directly — it does
  // not ask the viewer, so it answers even when the viewer is not running and
  // stays trustworthy if collection itself is the thing that is wrong.
  MapShine.debug.registerReport('tokens', 'Tokens: why is mine not showing?', () => {
    const sceneDoc = typeof canvas !== 'undefined' ? (canvas.scene ?? null) : null;
    const floorsResult = getActiveSceneFloors(sceneDoc);
    if (!floorsResult.ok) return { report: 'tokens', ok: false, reason: floorsResult.reason };
    const floors = floorsResult.floors;
    const viewedFloorIndex = resolveFloorDescriptor(sceneDoc, floors);
    const visibleLevelIds = computeVisibleFloorIndices(floors, viewedFloorIndex)
      .map((i) => floors[i]?.id)
      .filter(Boolean);
    const opts = {
      visibleLevelIds,
      knownLevelIds: floors.map((f) => f.id).filter(Boolean),
      viewedLevelId: floors[viewedFloorIndex]?.id,
      isGM: !!game?.user?.isGM,
    };
    const { items, skipped } = collectTokens(sceneDoc, opts);
    return {
      report: 'tokens',
      generatedAt: new Date().toISOString(),
      sceneName: sceneDoc?.name,
      floors: floors.map((f) => ({ index: f.index, id: f.id, name: f.name, elevationBottom: f.elevationBottom })),
      collectedTokenIds: items.map((i) => i.id),
      // Every drop, with its reason. The absence of this is what let three tokens
      // vanish while the report claimed skippedItems: [].
      skipped,
      ...diagnoseTokens(sceneDoc, opts),
    };
  });

  MapShine.debug.registerReport('vt-pan-viewer-stop', 'Stop / clear', () => ({
    report: 'vt-pan-viewer-stop',
    generatedAt: new Date().toISOString(),
    ...stopVtPanViewer(),
  }));

  // THE MASK-PILE-UP PROOF (Keyhole §4.1). Lists every (floor × layer) pair —
  // albedo AND every mask — with its resident page counts, alongside the fixed
  // cache's own stats. The whole layer stack is resident, yet residentPages
  // stays a small fraction of capacityPages: V2's `O(world × floors × masks)`
  // world-resolution textures replaced by `O(screen)` pages.
  MapShine.debug.registerReport('vt-pan-viewer-layers', 'Layer residency', () => {
    const d = getVtPanViewerDiagnostics();
    return {
      report: 'vt-pan-viewer-layers',
      generatedAt: new Date().toISOString(),
      active: d.active,
      displayLayer: d.displayLayer,
      currentFloorLayers: d.currentFloorLayers,
      layerResidency: d.layerResidency,
      layerLoadErrors: d.layerLoadErrors,
      layerResidencyTotals: d.layerResidencyTotals,
      cacheStats: d.cacheStats,
      decodeStats: d.decodeStats,
      interpretation:
        'GPU side: every (floor × layer) pair appears in layerResidency, and residentPages/evictions/' +
        'misses show the bounded page cache degrading to blur (never crash) under pressure — the mask ' +
        'pile-up killed. layerResidencyTotals.coarsePinShortfall MUST BE 0 — anything else means a ' +
        'coarse pin (the "always something resident, worst case blur" guarantee) failed to land, which ' +
        'is what a magenta screen means (a page with no resident data at any mip). coarsePinnedPages is ' +
        'ground truth (actually resident); coarseIntendedPages is what was asked for — they should match. ' +
        'DECODE-MEMORY side (the Bush-failure fix): decodeStats.heldSources is the peak number of full ' +
        '576MB source bitmaps alive at once — it must stay small (≈ SLICE_MAX_CONCURRENT_SOURCES), NOT ' +
        'grow with layers×floors. idbHits vs idbSlices shows pages served from IndexedDB without re-' +
        'decoding a source. Empty layerLoadErrors = no decode-memory failures. OFF-MAIN-THREAD DECODE: ' +
        'decodeStats.workerStatus should read "active" (if "unavailable", workerUnavailableReason says ' +
        'why, and everything silently fell back to the main thread — slower under pressure but still ' +
        'correct). workerSourceDecodes vs mainThreadFallbackSourceDecodes is the permanent tripwire for ' +
        '"is a giant image still touching the render thread anywhere" — mainThreadFallbackSourceDecodes ' +
        'should stay at or near 0; if it climbs, rangedFetchMisses shows whether the asset server is ' +
        "honoring Range requests (a nonzero value there means every pack's dimension probe is paying " +
        'for a full download just to read a PNG header).',
    };
  });

  // Visual verification: cycle the DISPLAYED layer (albedo → each mask → back).
  // The masks stream regardless; this just binds one to the shader so its known
  // fixture pattern (e.g. _Outdoors' margin ring, _Fire's sparse points) can be
  // eyeballed for correctness. Real scenes have no masks, so this stays albedo.
  const TORTURE_DISPLAY_CYCLE = ['albedo', 'ShadowOutdoorsFire', ...TORTURE_UNPACKED_MASK_NAMES];
  let tortureDisplayLayerIndex = 0;
  MapShine.debug.registerReport('vt-pan-viewer-cycle-layer', 'Cycle displayed layer', async () => {
    tortureDisplayLayerIndex = (tortureDisplayLayerIndex + 1) % TORTURE_DISPLAY_CYCLE.length;
    const name = TORTURE_DISPLAY_CYCLE[tortureDisplayLayerIndex];
    return {
      report: 'vt-pan-viewer-cycle-layer',
      generatedAt: new Date().toISOString(),
      requestedLayer: name,
      ...(await setVtPanViewerDisplayLayer(name)),
    };
  });

  // VT ZOOM THRASH TEST (author-requested, 2026-07-16: "force the camera to
  // flush the caches, start with a blank slate, start zoomed out and thrash
  // it in and out whilst tracking things" — a deterministic, instrumented
  // reproduction of the reported "rapid full-range zoom can temporarily
  // stop" hitch). Restarts the torture-fixture viewer FRESH (its own
  // startupParams, captured on every start), thrashes the zoom target
  // between fully-in and fully-out every animation frame for ~4 seconds, and
  // reports frame-gap/hitch evidence — see runZoomThrashTest's own header
  // for the full mechanism. Takes a few seconds to run (click once, wait).
  // TWO thrash buttons, because they answer DIFFERENT questions (author request,
  // 2026-07-16) — and because the single button that existed was broken: it still
  // passed the pre-item-renderer startup shape (imageUrlForFloor/floorCount/
  // visibleFloorIndices, no `dimensions`), so it died on `dimensions.width` before
  // rendering a frame. It was missed when boot.js was rewired because it hands its
  // params to runZoomThrashTest rather than calling startVtPanViewer directly.
  //
  //   TORTURE  — a controlled blank slate: 3 floors x 5 packs of synthetic 12000²
  //              art, always the same, always a cold cache. The right tool for
  //              "is the ENGINE hitching", isolated from whatever scene is open.
  //   ACTIVE   — thrashes whatever is on screen right now, with its real art, real
  //              floor count, real tiles and a warm cache. The right tool for "is
  //              MY map hitching", and the only one that can verify a fix against
  //              the conditions that produced a real report.
  MapShine.debug.registerReport('vt-zoom-thrash-torture', 'Zoom thrash: torture fixture', async () => ({
    report: 'vt-zoom-thrash-torture',
    generatedAt: new Date().toISOString(),
    subject: 'torture fixture (synthetic 12000² x3 floors + masks)',
    // Explicit startupParams — self-contained, works even if nothing is
    // currently active (doesn't require pressing "Start" first).
    ...(await runZoomThrashTest({
      startupParams: {
        THREE,
        buildItems: buildTortureItems,
        dimensions: tortureDimensions,
        floorCount: TORTURE_FLOOR_COUNT,
        extraLayersForItem: tortureExtraLayers,
      },
    })),
  }));

  MapShine.debug.registerReport('vt-zoom-thrash-active', 'Zoom thrash: active scene', async () => ({
    report: 'vt-zoom-thrash-active',
    generatedAt: new Date().toISOString(),
    subject: typeof canvas !== 'undefined' ? (canvas.scene?.name ?? '(no active scene)') : '(no canvas)',
    // No startupParams — runZoomThrashTest reuses the LIVE viewer's own captured
    // params, so this restarts the scene you are actually looking at rather than
    // swapping it for the fixture.
    ...(await runZoomThrashTest({})),
  }));

  // ---------------------------------------------------------------------------
  // DEFAULT-ON REAL-SCENE RENDERING (author correction, 2026-07-15: "this V3
  // renderer is the main rendering system and this isn't an optional feature
  // we're adding... don't make me have to press buttons"). Both the visual
  // severance (VT viewer occluding PIXI) and the VRAM severance (PIXI proxy
  // textures) were built gated behind manual debug-panel toggles — matching
  // the pattern every OTHER new capability used this session, but WRONG for
  // these two specifically, which are the actual product, not diagnostics.
  // Corrected: both now activate automatically from Foundry's own canvas
  // lifecycle hooks, no click required. See [[feedback_default_on_new_features]]
  // in project memory — this is the established rule (ship default-on, toggle
  // only when explicitly requested), applied here after initially missing it.
  //
  // startRealSceneViewer() is the ONE function both the automatic hook and the
  // manual debug-panel button (kept as a manual retry/force-refresh, not the
  // primary activation path anymore) call — one path per behavior. Accepts
  // `initialFloorIndex` so a caller can open on whatever floor Foundry is
  // ALREADY viewing (see startVtPanViewer's own doc for why a hardcoded 0
  // here was a real live bug: it silently discarded Foundry-side floor
  // switches AND crashed after a few of them from repeated full GPU
  // reallocation — this function is now reserved for genuine (re)starts, a
  // same-scene floor sync uses the cheap `setVtPanViewerFloor` path instead,
  // see the canvasReady handler below).
  // ---------------------------------------------------------------------------
  function resolveFloorDescriptor(sceneDoc, floors) {
    // canvas.level is Foundry's own PUBLIC getter for "the currently
    // displayed Level document" (verified in source, client/canvas/board.mjs)
    // — matched against our floor list by Level document id. Falls back to
    // floor 0 if canvas.level isn't available yet or matches nothing (e.g.
    // the legacy single-floor fallback, whose synthetic id is 'legacy').
    const viewedLevelId = typeof canvas !== 'undefined' ? (canvas.level?.id ?? null) : null;
    const idx = viewedLevelId ? floors.findIndex((f) => f.id === viewedLevelId) : -1;
    return idx >= 0 ? idx : 0;
  }

  async function startRealSceneViewer(initialFloorIndex = 0) {
    const sceneDoc = typeof canvas !== 'undefined' ? (canvas.scene ?? null) : null;
    beginSceneLoadPhase(LOAD_PHASES.SCENE); // no-op unless a curtain is up
    const floorsResult = getActiveSceneFloors(sceneDoc);
    if (!floorsResult.ok) {
      // This path already lands on Foundry's own rendering by construction — it
      // returns BEFORE startVtPanViewer, so no canvas is ever created. That is
      // the CORRECT outcome (the player gets a working session); what was wrong
      // is that it was SILENT, i.e. indistinguishable from MSA working. No
      // canvas to tear down here, so this is purely the announcement.
      engageFoundryFallback({
        reason: `This scene has no art MSA can render (${floorsResult.error}).`,
      });
      // The curtain must never outlive the load it describes — least of all on a
      // path that has just handed rendering back to Foundry, where leaving it up
      // would hide the working session it just rescued.
      endSceneLoad({ error: floorsResult.error });
      return { ok: false, error: floorsResult.error };
    }
    const { floors, skipped } = floorsResult;
    const dimensions = computeSceneDimensions(sceneDoc);
    const isGM = typeof game !== 'undefined' ? !!game.user?.isGM : true;

    /**
     * The real draw list: every visible Level's background AND foreground (roof)
     * art, plus every tile on any visible floor — all keyed for the ONE sort law.
     *
     * `computeVisibleFloorIndices` replicates Foundry's REAL cross-floor
     * visibility rule (a floor's own `visibility.levels` set, NOT "always show
     * the floor below") — see active-scene-source.js's header. Those indices are
     * mapped back to Level ids because that is what the document-level rules
     * (`isVisible`, `includedInLevel`) actually key on.
     */
    // EVERY level id in the scene, visible or not — see the use in buildItems.
    const allLevelIds = floors.map((f) => f.id).filter(Boolean);

    const buildItems = (viewedFloorIndex) => {
      const visibleIndices = computeVisibleFloorIndices(floors, viewedFloorIndex);
      const visibleLevelIds = visibleIndices.map((i) => floors[i]?.id).filter(Boolean);
      const viewedLevelId = floors[viewedFloorIndex]?.id;
      // Tokens join the SAME flat list as level art and tiles, and are sorted by
      // the same law (scene/layer-order.js) — they are drawables with a different
      // sortLayer (TOKENS 700), not a separate pass. That is the whole point of the
      // law being one flat list: nothing downstream learns the word "token".
      return [
        ...collectSceneLayers(sceneDoc, { viewedLevelId, visibleLevelIds, isGM }).items,
        // knownLevelIds is EVERY floor, not the visible ones: it is what lets
        // collectTokens tell "unassigned" (defaultLevel0000 — what a freshly
        // dragged token carries) from "on a floor you cannot currently see". Pass
        // only the visible ids and an upstairs token gets dragged down here.
        ...collectTokens(sceneDoc, { visibleLevelIds, knownLevelIds: allLevelIds, viewedLevelId, isGM }).items,
      ];
    };

    const initialVisibleLevelIds = computeVisibleFloorIndices(floors, initialFloorIndex)
      .map((i) => floors[i]?.id)
      .filter(Boolean);
    const layers = collectSceneLayers(sceneDoc, {
      viewedLevelId: floors[initialFloorIndex]?.id,
      visibleLevelIds: initialVisibleLevelIds,
      isGM,
    });
    const tokens = collectTokens(sceneDoc, {
      visibleLevelIds: initialVisibleLevelIds,
      knownLevelIds: allLevelIds,
      viewedLevelId: floors[initialFloorIndex]?.id,
      isGM,
    });
    // The report must describe what will actually DRAW, tokens included — a report
    // that quietly omits a whole class of drawable is worse than none.
    const collected = {
      items: [...layers.items, ...tokens.items],
      skipped: [...(layers.skipped ?? []), ...tokens.skipped],
    };

    return {
      sceneName: sceneDoc?.name,
      floors: floors.map((f) => ({ index: f.index, name: f.name, elevationBottom: f.elevationBottom, url: f.url })),
      skippedLevels: skipped,
      // What the scene model actually found — the first thing to check if a tile
      // or a roof isn't showing up.
      sceneDimensions: {
        canvas: { width: dimensions.width, height: dimensions.height },
        sceneRect: dimensions.sceneRect,
      },
      collectedItems: collected.items.map((i) => ({ id: i.id, kind: i.kind, elevation: i.key.elevation })),
      skippedItems: collected.skipped,
      ...(await startVtPanViewer({
        THREE,
        buildItems,
        // FOUNDRY OWNS ALL INPUT on a real scene (keyhole-input-model-decision):
        // pointer-events:none, no MSA input handlers, and the view follows
        // canvas.stage instead of tracking its own camera. The torture fixture
        // keeps its own camera — it has no Foundry scene to follow.
        followFoundryCamera: true,
        dimensions,
        floorCount: floors.length,
        initialFloorIndex,
        // Feeds the curtain, when there is one. A floor switch never reaches this
        // function at all (see the canvasReady handler), and these calls no-op
        // when nothing is loading — so the reporting path needs no knowledge of
        // whether a curtain is up.
        onLoadProgress: ({ done, total, detail }) => reportSceneLoadProgress(LOAD_PHASES.ART, { done, total, detail }),
      })),
    };
  }

  MapShine.debug.registerReport('vt-pan-viewer-start-real-scene', 'Restart: active scene', async () => {
    const sceneDoc = typeof canvas !== 'undefined' ? (canvas.scene ?? null) : null;
    const floorsResult = getActiveSceneFloors(sceneDoc);
    const initialFloorIndex = floorsResult.ok ? resolveFloorDescriptor(sceneDoc, floorsResult.floors) : 0;
    return {
      report: 'vt-pan-viewer-start-real-scene',
      generatedAt: new Date().toISOString(),
      ...(await startRealSceneViewer(initialFloorIndex)),
    };
  });

  // VRAM severance (Keyhole.md §4.3's "single biggest instant win") — the PIXI
  // proxy registration itself. LIVE-CONFIRMED 2026-07-15 (author's residency
  // report: both floors of a real 12000x12000 scene resident at exactly
  // 1024x1024) — the one assumption pixi-proxy-textures.js's header flagged
  // as unverifiable from source alone (does PIXI.Assets.load() itself respect
  // a pre-seeded Assets.cache entry) is now confirmed true, not just reasoned.
  // registerFloorProxies() is called from canvasInit below (unconditional,
  // no toggle — see the default-on note above) and is idempotent per src
  // (registerPixiProxy itself no-ops if that src is already cached).
  async function registerFloorProxies(sceneDoc) {
    const floorsResult = getActiveSceneFloors(sceneDoc);
    if (!floorsResult.ok) return;
    for (const floor of floorsResult.floors) {
      const bitmap = await getSourceBitmap(floor.url);
      const result = await registerPixiProxy(floor.url, bitmap);
      console.log(`${TAG} VRAM severance — floor ${floor.index} (${floor.name}):`, result);
    }
  }

  // THE TSL SPIKE (docs/planning/Shaders.md §7.5). Loads the node build LAZILY —
  // a 2.8MB vendor bundle must not be on the boot path for a decision we have not
  // taken. Touches nothing that works; renders into its own offscreen canvas.
  MapShine.debug.registerReport('loading-screen-state', 'Loading screen state', () => ({
    report: 'loading-screen-state',
    generatedAt: new Date().toISOString(),
    ...getLoadingScreenState(),
    note:
      'lastLoad.worstStallMs is the headline: a load that completes but froze the main thread for seconds is a ' +
      "bug with a receipt, not a success. lastStartedSceneId is the floor-switch guard's memory — a floor switch " +
      'is suppressed precisely because it matches.',
  }));

  // The curtain correctly refuses to reappear for the same scene, which makes it
  // impossible to look at again without switching scenes back and forth. This
  // forgets that memory so the next redraw is treated as a cold load.
  MapShine.debug.registerReport(
    'loading-screen-arm',
    'Loading Screen: Arm for next redraw (then switch floor/scene)',
    () => ({
      report: 'loading-screen-arm',
      generatedAt: new Date().toISOString(),
      ...resetLoadingSceneMemory(),
      note: 'The next canvasInit will now be treated as a cold load and raise the curtain, even for the scene you are already on.',
    })
  );

  MapShine.debug.registerReport('pixi-residency-report', 'PIXI residency', () => {
    const sceneDoc = typeof canvas !== 'undefined' ? (canvas.scene ?? null) : null;
    const floorsResult = getActiveSceneFloors(sceneDoc);
    const srcs = floorsResult.ok ? floorsResult.floors.map((f) => f.url) : [];
    return {
      report: 'pixi-residency-report',
      generatedAt: new Date().toISOString(),
      sceneName: sceneDoc?.name ?? null,
      floorsChecked: srcs,
      ...getPixiResidencyReport(srcs),
      interpretation:
        'width/height at or near 1024 (or below) on a real Level background = the proxy took effect. ' +
        'The original real dimensions (e.g. 12000x12000) resident instead = something regressed — flag it.',
    };
  });

  if (typeof Hooks !== 'undefined') {
    // canvasInit fires strictly BEFORE Foundry loads scene textures (verified
    // in source, client/canvas/board.mjs) — must register proxies here, not
    // later, or Foundry's own load wins the race.
    // THE CURTAIN GOES UP HERE — at canvasInit, the earliest moment we know a
    // scene is being drawn, so there is no window where Foundry looks frozen with
    // nothing on screen explaining why.
    //
    // BUT canvasInit fires for a FLOOR SWITCH too: Scene#view (scene.mjs:280) calls
    // canvas.draw() on `sceneChanged || levelChanged`, and draw() fires canvasInit
    // (board.mjs:1119) and canvasReady (1192) either way. The hook cannot tell them
    // apart — only the scene id can, and it IS available here (board.mjs sets
    // this.#scene and logs its name immediately before firing canvasInit).
    // beginSceneLoad does that comparison and shows nothing on a floor switch,
    // which is §4.5's headline promise and §7's dead level-transition curtain.
    Hooks.on('canvasInit', (canvasRef) => {
      try {
        const sceneDoc = canvasRef?.scene ?? null;
        const verdict = beginSceneLoad({ sceneId: sceneDoc?.id ?? null, sceneName: sceneDoc?.name });
        if (!verdict.shown) console.log(`${TAG} loading screen suppressed — ${verdict.reason}`);
      } catch (err) {
        // A broken curtain must never block a scene load.
        console.error(`${TAG} loading screen failed to start:`, err);
      }
    });

    Hooks.on('canvasInit', async (canvasRef) => {
      try {
        await registerFloorProxies(canvasRef?.scene ?? null);
      } catch (err) {
        console.error(`${TAG} VRAM severance — canvasInit proxy registration failed:`, err);
      }
    });

    // canvasReady fires once the scene is actually drawn — verified in source
    // (client/documents/scene.mjs's Scene#view(): canvas.draw() runs on
    // EITHER a full scene change OR a floor/level switch within the same
    // scene, both of which reach canvasReady) — so this single hook keeps the
    // VT viewer synced to whatever Foundry itself currently considers the
    // viewed scene+floor, automatically, without a separate floor-switch path.
    //
    // TWO DIFFERENT COSTS for two different events, deliberately NOT the same
    // path (this is the fix for a real live bug, 2026-07-15 — see
    // startVtPanViewer's `initialFloorIndex` doc for the full symptom/root-
    // cause trace): a genuine SCENE change needs a full (re)start
    // (startRealSceneViewer — new atlas, new page cache, the works). A
    // same-scene FLOOR switch — which also reaches this handler, per the
    // source citation above — only needs `setVtPanViewerFloor`, the same cost
    // as a keyboard floor-switch keypress. Calling the expensive path for the
    // cheap event was the actual crash: repeated full 512MB-atlas
    // reallocation on ordinary floor toggles.
    let lastRealSceneId = null;
    // TOKEN CRUD -> redraw. The draw list is derived from live Foundry documents,
    // but nothing was watching them: updateResidency only re-asks buildItems when
    // the VIEW changes, so a token created while the camera sat still never
    // appeared (author-reported 2026-07-16). Foundry's own hook names are the
    // authority here — see common/documents/token.mjs's metadata.events.
    //
    // updateToken matters as much as createToken: moving a token between floors
    // changes token.level, which changes which floors draw it.
    // Foundry's camera is the ONE source of truth for the view. canvasPan fires on
    // every pan/zoom (board.mjs:1715), so MSA adopts it rather than tracking its
    // own — a second camera is a second source of truth.
    Hooks.on('canvasPan', () => {
      syncVtPanViewerCamera().catch((err) => console.error(`${TAG} camera sync failed:`, err));
    });

    for (const hook of ['createToken', 'updateToken', 'deleteToken']) {
      Hooks.on(hook, () => {
        // Fire-and-forget: a redraw must never make a document update await GPU
        // work, and a failed redraw must not break Foundry's own bookkeeping.
        refreshVtPanViewerItems().catch((err) => console.error(`${TAG} ${hook} redraw failed:`, err));
      });
    }

    Hooks.on('canvasReady', async (canvasRef) => {
      try {
        const sceneDoc = canvasRef?.scene ?? null;
        if (!sceneDoc) return;
        const floorsResult = getActiveSceneFloors(sceneDoc);
        if (!floorsResult.ok) {
          console.warn(`${TAG} real-scene VT viewer: ${floorsResult.error}`);
          return;
        }
        const targetFloorIndex = resolveFloorDescriptor(sceneDoc, floorsResult.floors);

        if (lastRealSceneId === sceneDoc.id && getVtPanViewerDiagnostics().active) {
          // A floor switch. No curtain was raised for it and none is lifted —
          // beginSceneLoad already declined, so there is nothing here to undo.
          // "Floor changes without loading screens" is this branch existing.
          const result = await setVtPanViewerFloor(targetFloorIndex);
          console.log(`${TAG} real-scene VT viewer synced to floor ${targetFloorIndex} (same scene).`, result);
          return;
        }

        lastRealSceneId = sceneDoc.id;
        const result = await startRealSceneViewer(targetFloorIndex);
        if (result.ok === false) {
          console.warn(`${TAG} real-scene VT viewer did not start:`, result.error);
          endSceneLoad({ error: result.error });
          return;
        }
        console.log(`${TAG} real-scene VT viewer active for "${result.sceneName}" at floor ${targetFloorIndex}.`);

        // LIFT ONLY WHEN THERE IS SOMETHING TO SEE. startVtPanViewer has resolved,
        // so every coarse pin is resident and the render loop is armed — but no
        // frame has PAINTED yet. Waiting one frame is the difference between
        // "Ready" being true and being the §7 "Ready!" lie under a new name.
        beginSceneLoadPhase(LOAD_PHASES.FIRST_FRAME);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const summary = endSceneLoad();
        if (summary) {
          // worstStallMs is surfaced, not swallowed: a load that completes but
          // froze the main thread for seconds is a bug with a receipt.
          console.log(
            `${TAG} scene load complete in ${summary.totalMs}ms` +
              (summary.worstStallMs > 0 ? ` (worst main-thread stall: ${summary.worstStallMs}ms)` : ''),
            summary
          );
        }
      } catch (err) {
        console.error(`${TAG} real-scene VT viewer auto-sync failed:`, err);
        endSceneLoad({ error: String(err?.message || err) });
      }
    });
  }

  // MapShine.soak(n) drives the TORTURE FIXTURE specifically (Keyhole's own
  // Stage-1-gate harness — a controlled, known-content soak, not whatever
  // scene happens to be open). NOTE: inside a real running Foundry world, the
  // canvasReady hook above will usually have already started the REAL-scene
  // viewer before soak(n) runs, so `load`'s own "only if not already active"
  // guard means soak(n) run live now typically exercises the SAME already-
  // running real-scene instance, not the synthetic fixture — a real, worth-
  // flagging change in what "MapShine.soak(n)" measures inside a live world.
  // The Stage-1-gate soak run was captured before this session's default-on
  // change (see keyhole-stage-status memory) and remains valid.
  MapShine.soakHooks.load = async () => {
    if (!getVtPanViewerDiagnostics().active) {
      await startVtPanViewer({
        THREE,
        buildItems: buildTortureItems, // soak the castle-courtyard worst case: all 3 floors composited
        dimensions: tortureDimensions,
        floorCount: TORTURE_FLOOR_COUNT,
        extraLayersForItem: tortureExtraLayers, // soak the FULL layer stack (albedo + masks), not albedo alone
      });
    }
  };
  MapShine.soakHooks.pan = (i) => soakPanStep(i);
  MapShine.soakHooks.switchFloor = (i) => soakSwitchFloorStep(i);

  console.log(
    `%c${TAG}%c ${STAGE} — new tree live, legacy quarantined. Three r${THREE.REVISION} / WebGL2.` +
      ` Soak harness ready: MapShine.soak(n).`,
    'color:#8fd6ff;font-weight:bold',
    'color:inherit'
  );

  // Foundry defines its globals before loading module esmodules, so `Hooks` is
  // available here. If we are somehow loaded outside Foundry, fall back to the
  // window load event so the boot proof still renders.
  if (typeof Hooks !== 'undefined') {
    Hooks.once('init', () => console.log(`${TAG} init — ${MODULE_ID}`));
    Hooks.once('ready', () => bootHeartbeat());
  } else {
    console.warn(`${TAG} no Foundry Hooks found; booting on window load.`);
    if (document.readyState === 'complete') bootHeartbeat();
    else window.addEventListener('load', () => bootHeartbeat(), { once: true });
  }
}

/**
 * Stage 0 proof-of-life: a dedicated MSA overlay canvas rendering a slowly
 * spinning, vertex-colored triangle through the new Three. It sits bottom-right,
 * click-through (`pointer-events:none`), so Foundry's UI stays fully usable while
 * the author imports the torture fixture and runs the soak harness.
 *
 * Deliberately its OWN canvas, not Foundry's — entangling with Foundry's canvas is
 * the adapter's job (src/foundry/), which lands in Stage 2+. Stage 0 only proves
 * the renderer boots.
 */
function bootHeartbeat() {
  if (MapShine.__heartbeat) return; // idempotent
  try {
    const host = document.createElement('div');
    host.id = 'msa-keyhole-boot';
    // Sits clear of Foundry's right-hand sidebar (author-reported overlap,
    // 2026-07-16 — the sidebar is ~300px and this used to land on top of the
    // scene directory). `right: 320px` parks it just left of the sidebar rather
    // than under it.
    Object.assign(host.style, {
      position: 'fixed',
      right: '320px',
      bottom: '12px',
      width: `${HEARTBEAT_W}px`,
      zIndex: '90', // above Foundry board, below its notifications
      pointerEvents: 'none',
      fontFamily: 'Signika, sans-serif',
      color: '#cfe8ff',
      textShadow: '0 1px 2px #000',
      userSelect: 'none',
    });

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      display: 'block',
      width: `${HEARTBEAT_W}px`,
      height: `${HEARTBEAT_H}px`,
      borderRadius: '8px',
      border: '1px solid rgba(143,214,255,0.35)',
      boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
      background: 'rgba(6,10,18,0.72)',
    });

    // THE PERF READOUT. The author's own observation (2026-07-16): the spinning
    // triangle is genuinely useful for spotting frame-rate trouble, because it is
    // an INDEPENDENT renderer — if it stutters, the main thread is blocked, and no
    // amount of internal instrumentation can hide that from your eyes. So it stays,
    // just smaller, and the space it frees carries the numbers that explain it.
    const perf = document.createElement('div');
    Object.assign(perf.style, {
      marginTop: '6px',
      fontSize: '11px',
      lineHeight: '1.4',
      fontFamily: 'ui-monospace, Consolas, monospace',
      letterSpacing: '0.02em',
    });

    const caption = document.createElement('div');
    Object.assign(caption.style, {
      marginTop: '4px',
      fontSize: '10px',
      lineHeight: '1.3',
      textAlign: 'center',
      opacity: '0.75',
      letterSpacing: '0.02em',
    });
    caption.innerHTML =
      `<strong>Map Shine Advanced ${VERSION}</strong> &middot; ${CODENAME}<br>` +
      `${STAGE} &mdash; Three r${THREE.REVISION} / WebGL2`;

    host.appendChild(canvas);
    host.appendChild(perf);
    host.appendChild(caption);
    document.body.appendChild(host);

    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.setSize(HEARTBEAT_W, HEARTBEAT_H, false);
    renderer.setClearColor(0x000000, 0); // transparent → CSS background shows
    // The node renderer must init() before it will draw. Fire-and-forget: the
    // heartbeat is a liveness indicator, and a heartbeat that blocks boot to
    // report that boot is alive would be a poor sort of heartbeat.
    renderer.init().catch((err) => console.error(`${TAG} heartbeat renderer init failed:`, err));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, HEARTBEAT_W / HEARTBEAT_H, 0.1, 100);
    camera.position.set(0, 0, 3.2);

    // A single triangle with red/green/blue vertex colors — the canonical
    // "hello, GPU" that exercises buffers, a shader, transforms and rasterization.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 1.1, 0, -1.05, -0.85, 0, 1.05, -0.85, 0], 3)
    );
    geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.25, 0.25, 0.25, 1, 0.4, 0.35, 0.55, 1], 3));
    // NodeMaterial: the node renderer's own material. MeshBasicMaterial still
    // exists but NodeMaterial is what this project speaks now.
    const material = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const triangle = new THREE.Mesh(geometry, material);
    scene.add(triangle);

    // Frame-gap sampling on the HEARTBEAT's own loop. Deliberately independent of
    // the VT viewer's instrumentation: this loop keeps running even when the VT is
    // stopped, has failed, or was never started, so it reports the health of the
    // MAIN THREAD rather than of any one subsystem. A stall here is a stall
    // everywhere, whoever caused it.
    const gaps = [];
    let lastT = null;
    let worstGapMs = 0;
    renderer.setAnimationLoop((t) => {
      triangle.rotation.y = t * 0.0009; // gentle spin — proves the loop is alive
      renderer.render(scene, camera);

      if (lastT !== null) {
        const gap = t - lastT;
        gaps.push(gap);
        if (gaps.length > 120) gaps.shift();
        if (gap > worstGapMs) worstGapMs = gap;
      }
      lastT = t;

      // Repaint the numbers ~4x/sec — often enough to read, rare enough that the
      // monitor never becomes the thing worth monitoring.
      if (gaps.length && Math.floor(t / 250) !== perf.__lastTick) {
        perf.__lastTick = Math.floor(t / 250);
        const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const fps = avg > 0 ? 1000 / avg : 0;
        const recentWorst = Math.max(...gaps);
        const vt = getVtPanViewerDiagnostics();
        const warn = recentWorst > 50 ? '#ffb4b4' : '#cfe8ff';
        const rows = [
          `<span style="color:${warn}">${fps.toFixed(0)} fps</span>  ·  gap ${avg.toFixed(1)}ms (worst ${recentWorst.toFixed(0)})`,
          `all-time worst gap: ${worstGapMs.toFixed(0)}ms`,
        ];
        if (vt?.active) {
          const c = vt.cacheStats;
          rows.push(
            `VT ${vt.renderMode} · ${vt.itemsLoaded} items · mip ${vt.mip?.requested ?? '?'}`,
            `pages ${c.residentPages}/${c.capacityPages} · miss ${c.misses} · evict ${c.evictions}`
          );
        } else {
          rows.push('VT: not running');
        }
        perf.innerHTML = rows.join('<br>');
      }
    });

    MapShine.__heartbeat = { host, renderer, scene, camera, triangle };
    MapShine.__soakWatch?.(canvas); // count any WebGL context loss on the boot canvas
    MapShine.debug?.attachPanel(host); // the debug panel lives in the same corner box
    console.log(`${TAG} boot heartbeat rendering. Gate "boot renders" ✔`);
  } catch (err) {
    // Doctrine #1: fail LOUD, never silently. No V2 fallback exists to hide behind.
    console.error(`${TAG} boot heartbeat FAILED — the new renderer did not come up:`, err);
    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      padding: '10px 14px',
      zIndex: '90',
      pointerEvents: 'none',
      background: 'rgba(60,0,0,0.85)',
      color: '#ffd9d9',
      font: '12px/1.4 Signika, sans-serif',
      borderRadius: '8px',
      border: '1px solid rgba(255,120,120,0.5)',
    });
    banner.textContent = `${TAG} renderer failed to boot — see console.`;
    document.body.appendChild(banner);
  }
}
