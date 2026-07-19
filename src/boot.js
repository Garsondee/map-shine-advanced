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
import { installFlightRecorder } from './diag/flight-recorder.js';
import { createLogger } from './core/log.js';
import {
  runVtLiveDecodeTest,
  startVtPanViewer,
  stopVtPanViewer,
  getVtPanViewerDiagnostics,
  setVtPanViewerFloor,
  setVtPanViewerDisplayLayer,
  setVtPanViewerIsolateItem,
  getVtPanViewerDrawListIds,
  getVtPanViewerIsolateItemId,
  runZoomThrashTest,
  soakPanStep,
  soakSwitchFloorStep,
  soakZoomStep,
  refreshVtPanViewerItems,
  runOrientationSelfTest,
  getSourceBitmap,
  readPageBitmapPixels,
  resolveRendererRequiredLimits,
  setWholeImageMode,
  setDarknessRealism,
  getDarknessRealism,
  sampleVtPanViewerIllumPixel,
  probeVtPanViewerPixels,
  runInteractiveVtPanViewerPixelProbe,
} from './vt/index.js';
import { PASSES, validatePassGraph, PASS_SEAMS, PASS_IMPLS } from './graph/index.js';
import { NotBuiltError } from './core/not-built.js';
import {
  getActiveSceneFloors,
  computeVisibleFloorIndices,
  collectSceneLayers,
  collectTokens,
  diagnoseTokens,
  SCENE_LAYER_DOCUMENTS,
  TOKEN_DOCUMENTS,
  computeSceneDimensions,
  computeItemPlacement,
  floorCeilings,
  discoverAuthoredMasks,
  registerPixiProxy,
  getPixiResidencyReport,
  registerCanvasCompositing,
  applyArtSuppression,
  restoreFoundryArt,
  getCanvasCompositingReport,
  registerCanvasTearDownWatchdog,
} from './foundry/index.js';
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
import { installPainter } from './ui/index.js';
import {
  SORT_LAYERS,
  makeLayerKey,
  createMaskAuthority,
  maskKindById,
  assembleLayerDescriptors,
} from './scene/index.js';

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
// Escape hatch for the whole-image render path (2026-07-17): MapShine
// .setWholeImageMode(false) reverts to page-streaming live (takes effect on the
// next residency refresh — pan or switch floor). Streaming still device-loses on
// huge maps, so this is a debug lever, not a working fallback; the real
// reliability floor is the device-lost safety slide.
MapShine.setWholeImageMode = setWholeImageMode;
// THE DARKNESS-REALISM LEVER (2026-07-19, author-requested): MapShine
// .setDarknessRealism(v), v in [0,1]. 0 = Foundry parity (DEFAULT — the unlit
// floor at scene darkness 1 stays at Foundry's readable ~19% darkness colour,
// never pitch black); 1 = "realistic" (darkness 1 crushes the unlit map to
// true black). Takes effect on the next rendered frame (no reload). Also
// available as a dropdown in the debug panel ("Darkness at max"). See
// vt-pan-viewer.js#setDarknessRealism / environmental-light.js.
MapShine.setDarknessRealism = setDarknessRealism;
MapShine.getDarknessRealism = getDarknessRealism;
// THE PIXEL-READBACK DIAGNOSTIC (2026-07-19, the region-darkness rendering
// audit): `await MapShine.sampleIllumPixel(worldX, worldY)` reads the ACTUAL
// GPU-rendered value of buf:scene.illum at one world position — the ONLY
// instrument in this project that answers "did this actually reach the
// screen" rather than "what does the CPU say it should be" (getRegionDarknessInfo's
// own job). See vt-pan-viewer.js#sampleIllumPixel for the full reasoning.
MapShine.sampleIllumPixel = sampleVtPanViewerIllumPixel;
// THE PIXEL PROBE (2026-07-19, author-requested, buffed same day once the
// author flagged it as THE tool that cracked the region-darkness bug):
// `await MapShine.probePixels([{x,y}, {x,y}, {x,y}])` — up to 3 world
// positions, reading ALL FIVE screen-sized compositor buffers (illum/lit/
// albedo/coloration/occlusion, the last via a byte-not-half-float decode
// path — see diag/pixel-probe.js), PLUS a numbered on-screen marker (thin
// crosshair + thin circle + a chunkier badge) per point for 30s, so a
// screenshot taken right after the call lines up with the JSON report,
// point-for-point. Point 2+ also carries `deltaFromPrev` — an automatic
// diff against the previous point, biggest jump called out, the same
// by-hand "point A vs point B" comparison that found the region-darkness
// discard() bug and the region-aware-ambient seam, now computed for free.
// See vt-pan-viewer.js#probePixels / diag/pixel-probe.js.
MapShine.probePixels = probeVtPanViewerPixels;
// THE INTERACTIVE PIXEL PROBE (2026-07-19, author-requested: "I want to
// click on the screen and set the points"). MapShine.armPixelProbe() also
// exists for console use; the debug-panel "Pixel Probe" button (registered
// below, once MapShine.debug exists) is the primary way to reach it — click
// the button, then click up to 3 spots on the map. See vt-pan-viewer.js
// #armInteractivePixelProbe for the full "why this never steals a click
// from Foundry" reasoning.
MapShine.armPixelProbe = runInteractiveVtPanViewerPixelProbe;

/**
 * Boot's own logger. Everything this file says goes through `core/log.js`, which
 * forwards it to the flight recorder as STRUCTURE (level, subsystem, data) — not
 * as a console string a regex has to guess at later. `TAG` survives only where a
 * message is genuinely about the version/codename; the prefix itself is the
 * logger's job now.
 */
const log = createLogger('boot');

/** Guard against double-boot (Foundry hot-reload, duplicate module load). */
if (MapShine.__keyholeBooted) {
  log.warn(`already booted; skipping re-entry.`);
} else {
  MapShine.__keyholeBooted = true;
  install();
}

function install() {
  // THE BLACK BOX GOES FIRST — before the panel, before the soak, before the
  // pass-graph check below. Every line after this point is captured; anything
  // before it is gone forever, and the earliest failures are the ones nobody can
  // reproduce on request. (The panel used to open a warn/error-only buffer here;
  // the recorder supersedes it and catches every level from every source.)
  installFlightRecorder(MapShine);
  installSoak(MapShine); // exposes MapShine.soak(n) — the stage-gate soak harness
  installDebugPanel(MapShine);
  // The in-app painter (tier 0): registers its "🖌️ Paint _Fire" action on the
  // debug panel and returns a hydrate hook the canvasReady handler calls to pull
  // any saved paint for the newly-loaded scene (docs/planning/Authoring-and-Distribution.md).
  MapShine.__painter = installPainter(MapShine);

  // THE PASS GRAPH, VALIDATED AT BOOT (Keyhole §"THE FRAMEWORK" — 2026-07-17).
  // Node tests already prove PASSES validates (194+ assertions); this is the
  // SAME check running against the REAL declared graph every real session
  // boots with, not just at `npm test` time — the gap between "the committed
  // file validates" and "the graph a player's session actually runs under
  // validates" is exactly the kind of gap this project's whole second half has
  // been about closing. Loud, never fatal: a malformed pass DECLARATION is a
  // bookkeeping bug, not a reason to take live map rendering down for a table
  // mid-session (the same reasoning as diag/render-fallback.js's safety slide
  // — announce, never silently break, and never break MORE than the actual
  // problem warrants).
  const graphCheck = validatePassGraph(PASSES);
  if (!graphCheck.ok) {
    log.error(`PASS GRAPH INVALID — this is a real bug in graph/passes.js, not a render fault:`);
    for (const e of graphCheck.errors) log.error(`  - ${e}`);
  }

  // The same graph, seam-door, and live-impl checks Node already runs (194+
  // assertions across pass-declarations.test.mjs + pass-impls.test.mjs) —
  // exercised here against the REAL running session instead of the committed
  // file, one click, no console-log copy/paste (keyhole-debug-panel protocol).
  // `live` checks confirm each entry is a REAL function reference (never a
  // string path — see graph/pass-impls.js's header for why), and surface
  // `fusedWith` honestly: geometry.world/present.composite currently share ONE
  // real implementation, and this report says so rather than implying three
  // independent passes exist.
  MapShine.debug.registerReport('pass-graph-health', 'Pass graph health', () => {
    const graph = validatePassGraph(PASSES);
    const seamChecks = PASSES.filter((p) => p.status === 'seam').map((p) => {
      const door = PASS_SEAMS[p.id];
      if (typeof door !== 'function') return { id: p.id, status: 'MISSING DOOR' };
      try {
        door({});
        return { id: p.id, status: 'UNEXPECTED — door did NOT throw (secretly built? update its status)' };
      } catch (err) {
        return {
          id: p.id,
          status:
            err instanceof NotBuiltError ? 'correctly locked' : `UNEXPECTED ERROR TYPE: ${err?.constructor?.name}`,
        };
      }
    });
    const liveChecks = PASSES.filter((p) => p.status === 'live').map((p) => {
      const impl = PASS_IMPLS[p.id];
      if (!impl) return { id: p.id, status: 'MISSING — live pass has no PASS_IMPLS entry' };
      return {
        id: p.id,
        status: typeof impl.fn === 'function' ? 'real function confirmed' : 'BROKEN — fn is not a function',
        export: impl.export,
        fusedWith: impl.fusedWith ?? null,
      };
    });
    return {
      report: 'pass-graph-health',
      generatedAt: new Date().toISOString(),
      graphValid: graph.ok,
      graphErrors: graph.errors,
      passCounts: {
        total: PASSES.length,
        live: PASSES.filter((p) => p.status === 'live').length,
        seam: PASSES.filter((p) => p.status === 'seam').length,
        future: PASSES.filter((p) => p.status === 'future').length,
      },
      seamChecks,
      liveChecks,
    };
  });

  // ORIENTATION SELF-TEST — the standing answer to "how do we stop fighting
  // Y-flips?" (author, 2026-07-17, on an upside-down map). Renders an
  // asymmetric four-corner pattern through the REAL buf:scene.color and the
  // REAL present pass, reads the actual pixels back, and NAMES what it sees:
  // "Y-FLIPPED", "X-FLIPPED", "ROTATED 180°", or ok. One click, after any new
  // screen-space or world→texture mapping — instead of eyeballing content that
  // might be symmetric enough to hide the bug (which is how Y-flips survive).
  MapShine.debug.registerAction('orientation-self-test', 'Orientation self-test', async () => ({
    report: 'orientation-self-test',
    generatedAt: new Date().toISOString(),
    ...(await runOrientationSelfTest()),
  }));

  MapShine.debug.registerAction('vt-live-decode', 'Live decode test', async () => ({
    report: 'vt-live-decode',
    generatedAt: new Date().toISOString(),
    ...(await runVtLiveDecodeTest(`modules/${MODULE_ID}/assets/torture/torture_floor0.png`)),
  }));
  // ---------------------------------------------------------------------------
  // THE MASK AUTHORITY — the single source of truth for authored + derived
  // content masks (scene/mask-authority.js's header is the map; the
  // `masks/authority-only` tripwire is the wall). Boot is the composition
  // root: the authority never imports the renderer and the renderer never
  // imports the authority — they meet HERE, as two injected closures
  // (extraLayersForItem = what to stream, onPageDecoded = what streamed).
  // Deliberately NOT exposed on the MapShine namespace: consumers import
  // through scene/index.js, and the debug report below is the author's
  // window. A `MapShine.masks` would be V2's global bus growing back.
  // ---------------------------------------------------------------------------
  const maskAuthority = createMaskAuthority({
    // Bounded pixel access for ingest: ≤256² pages, a handful per pack, once
    // per scene load — never the render loop, never a giant source. The reader
    // itself lives in vt/decode-pool.js (per-page CPU extraction is decode
    // machinery; `no-gpu-readback` correctly refused to host it here).
    readPageImageData: readPageBitmapPixels,
    log: createLogger('masks'),
  });
  MapShine.debug.registerReport('mask-authority', 'Mask authority (authored + derived masks)', () => ({
    report: 'mask-authority',
    generatedAt: new Date().toISOString(),
    ...maskAuthority.getReport(),
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
  // SINGLE-CHANNEL masks pack — into R/G/B of one RGBA texture + a shared
  // structural-hole alpha (the hole is a FLOOR property, identical across
  // masks — author-confirmed, see tools/make-torture-world.mjs's
  // fillHoleAlpha). COLOURED and RGBA masks each need a full texture and stay
  // unpacked. Real math: 7 masks → 4 packs (not the plan's original
  // optimistic 13→6) — directly answers the GPU page-cache pressure every
  // live castle-scenario report showed. WHICH kinds exist, their suffixes and
  // the packing rule all live in scene/mask-catalog.js now — this file only
  // knows the fixture's URL pattern and which kinds the fixture generator
  // emits (everything but water). `assembleLayerDescriptors` is the SAME
  // assembly the real-scene discovery path goes through: one policy, two
  // data sources, per the mask authority's whole point.
  const FIXTURE_MASK_KIND_IDS = ['shadow', 'outdoors', 'fire', 'specular', 'window', 'tree', 'bush'];
  const tortureMaskUrlsByKind = (floorIndex) =>
    new Map(
      FIXTURE_MASK_KIND_IDS.map((id) => [
        id,
        `modules/${MODULE_ID}/assets/torture/torture_floor${floorIndex}${maskKindById(id).suffixes[0]}.png`,
      ])
    );
  const tortureLayerUrls = (floorIndex) => assembleLayerDescriptors(tortureMaskUrlsByKind(floorIndex));

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

  /**
   * Point the mask authority at the fixture (hard case first — doctrine #4):
   * fabricated floors with real elevation bands (bottom i*10, ceiling
   * (i+1)*10) and the same discovery shape a real scene produces, so
   * skyReach/coverAbove derive from the fixture's actual hole-alpha'd art +
   * authored _Outdoors trio. The soak/thrash restarts reuse the PURE
   * descriptor list above without re-pointing the authority — streaming stays
   * identical; ingest simply keeps feeding whatever scene the authority is on.
   */
  const pointMaskAuthorityAtFixture = () => {
    const fixtureFloors = tortureVisibleFloorIndices().map((i) => ({
      index: i,
      id: `torture${i}`,
      name: `Torture floor ${i}`,
      ceilingElevation: (i + 1) * 10,
    }));
    maskAuthority.reset({
      sceneKey: 'torture-fixture',
      dimensions: tortureDimensions,
      floors: fixtureFloors,
      items: buildTortureItems(),
      resolvePlacement: (item, size) => computeItemPlacement(item, size, tortureDimensions),
    });
    maskAuthority.setDiscovery({
      byLevelId: new Map(fixtureFloors.map((f) => [f.id, tortureMaskUrlsByKind(f.index)])),
      method: 'fixture',
      failures: [],
      probesAttempted: 0,
    });
  };

  MapShine.debug.registerAction('vt-pan-viewer-start', 'Start: torture fixture', async () => {
    pointMaskAuthorityAtFixture();
    return {
      report: 'vt-pan-viewer-start',
      generatedAt: new Date().toISOString(),
      ...(await startVtPanViewer({
        THREE,
        buildItems: buildTortureItems,
        dimensions: tortureDimensions,
        floorCount: TORTURE_FLOOR_COUNT,
        extraLayersForItem: tortureExtraLayers,
        onPageDecoded: (info) => maskAuthority.ingestDecodedPage(info),
      })),
    };
  });
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

  MapShine.debug.registerAction('vt-pan-viewer-stop', 'Stop / clear', () => ({
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
  // fixture pattern (the outdoors margin ring, fire's sparse points) can be
  // eyeballed for correctness. The cycle is DERIVED from the same catalog
  // assembly that names the packs — a hand-kept name list here is exactly the
  // drift the mask catalog exists to end. Real scenes with discovered masks
  // cycle their own pack names identically (pack names match descriptors).
  const TORTURE_DISPLAY_CYCLE = ['albedo', ...tortureLayerUrls(0).map((d) => d.name)];
  let tortureDisplayLayerIndex = 0;
  MapShine.debug.registerAction('vt-pan-viewer-cycle-layer', 'Cycle displayed layer', async () => {
    tortureDisplayLayerIndex = (tortureDisplayLayerIndex + 1) % TORTURE_DISPLAY_CYCLE.length;
    const name = TORTURE_DISPLAY_CYCLE[tortureDisplayLayerIndex];
    return {
      report: 'vt-pan-viewer-cycle-layer',
      generatedAt: new Date().toISOString(),
      requestedLayer: name,
      ...(await setVtPanViewerDisplayLayer(name)),
    };
  });

  // ISOLATE ONE DRAW ITEM — the ghost-hunting control (2026-07-17).
  //
  // The ghost ("tiles of textures at the wrong scale and in the wrong place")
  // has survived five diagnoses from me. Each one found a REAL bug and none of
  // them was the ghost, because I was reasoning about a VISUAL artefact from
  // aggregate counters — I can't see it, the author can. This inverts that:
  // pick items one at a time until the stripes appear, and the ghost's identity
  // stops being my theory and starts being a fact. Which item it is says a lot
  // on its own — a Tile means placement/packing, a Level means floor
  // compositing, a Token means the live-sync path.
  //
  // A dropdown, not a "next item" button: the choices are mutually exclusive
  // and the author should be able to jump straight back to a suspect
  // (feedback_debug_ui_one_action_one_control).
  MapShine.debug.registerSelect(
    'vt-isolate-item',
    'Isolate draw item',
    // A thunk: the draw list doesn't exist at install() and changes with every
    // scene, floor and token update. A snapshot here would be empty forever.
    () => [
      { value: '', label: 'All items (normal)' },
      ...getVtPanViewerDrawListIds().map(({ id, kind, renderOrder }) => ({
        value: id,
        label: `${renderOrder}. ${kind}: ${id}`,
      })),
    ],
    () => getVtPanViewerIsolateItemId(),
    async (id) => setVtPanViewerIsolateItem(id)
  );

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
  //
  // ADVERSARIAL MAX-STRESS, NOT A PLAY PROXY (relabeled 2026-07-17, live-
  // confirmed): a multi-round ghost-artefact hunt this session traced the
  // ghost to this test's OWN burst-rate zoom — several full-range sweeps in
  // ~8 seconds, zero settle between direction flips — and the author could
  // not reproduce it through 15-20s of deliberate, aggressive manual
  // scroll-zooming afterward. The RANGE this test reaches is real (same
  // clampHalfSpan() bounds a real scroll wheel); the RATE is not. Good for
  // finding races fast (it already has: the coarse-pin budget shortfall, the
  // freeze, the pin leak, a mip-blend mismatch — all real, all confirmed).
  // Bad for "would a GM ever see this" — that question is `MapShine.soak(n)`'s
  // job now, via its `zoom` driver (soakZoomStep: one bounded, eased step per
  // cycle, the same code path a real zoom key uses). See
  // runZoomThrashTest's own returned `interpretation` for the same caveat on
  // every run.
  MapShine.debug.registerAction('vt-zoom-thrash-torture', 'Zoom thrash (max-stress): torture fixture', async () => ({
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

  MapShine.debug.registerAction('vt-zoom-thrash-active', 'Zoom thrash (max-stress): active scene', async () => ({
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

    // MASK DISCOVERY + AUTHORITY RESET — before the viewer starts, so
    // `layersForItem` is a sync manifest lookup by the time packs build.
    // Discovery is one directory listing per unique art directory (bounded
    // probes only as the announced fallback — see foundry/mask-discovery.js);
    // a total failure serves absence defaults and says so, never blocks the
    // scene (the safety-slide stance: masks degrade, sessions don't).
    //
    // OWN LOADING-SCREEN PHASE (2026-07-17): this await used to sit silently
    // inside LOAD_PHASES.SCENE — invisible on the listing happy path, but the
    // probe fallback is a real bounded sequence of network round trips that
    // must never sit unlabeled behind an earlier phase's title (exactly the
    // "silent stall" shape Keyhole.md §7's kill list forbids). `total` is
    // `floors.length`, known here; `onProgress` advances it per floor.
    beginSceneLoadPhase(LOAD_PHASES.MASKS, { total: floors.length });
    let maskDiscovery = null;
    try {
      maskDiscovery = await discoverAuthoredMasks({
        floors,
        onProgress: ({ done, total, detail }) => reportSceneLoadProgress(LOAD_PHASES.MASKS, { done, total, detail }),
      });
    } catch (err) {
      log.error('mask discovery failed outright — this scene serves absence defaults:', err);
    }
    // The authority's item set is UNFILTERED (every level visible, GM view):
    // cover physics must not depend on what the current user happens to be
    // viewing. Hidden tiles are collected WITH their flag — the authority
    // excludes them from cover itself and reports them, which beats silently
    // never collecting them.
    maskAuthority.reset({
      sceneKey: String(sceneDoc?.id ?? sceneDoc?.name ?? 'unknown-scene'),
      dimensions,
      floors: (() => {
        const ceilings = floorCeilings(sceneDoc, floors);
        return floors.map((f) => ({
          index: f.index,
          id: f.id,
          name: f.name,
          ceilingElevation: ceilings.get(f.id) ?? Infinity,
        }));
      })(),
      items: collectSceneLayers(sceneDoc, {
        viewedLevelId: floors[initialFloorIndex]?.id,
        visibleLevelIds: allLevelIds,
        isGM: true,
      }).items,
      resolvePlacement: (item, size) => computeItemPlacement(item, size, dimensions),
    });
    if (maskDiscovery) maskAuthority.setDiscovery(maskDiscovery);

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
      // What discovery concluded, in the same report the author already reads
      // after a scene start — the full story lives in the mask-authority report.
      maskDiscovery: maskDiscovery
        ? {
            method: maskDiscovery.method,
            floorsWithMasks: maskDiscovery.byLevelId.size,
            probesAttempted: maskDiscovery.probesAttempted,
            failures: maskDiscovery.failures,
          }
        : 'FAILED — see log; absence defaults are being served',
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
        // THE MASK AUTHORITY'S two seams (see its header): what to stream per
        // item, and what streamed. Real scenes now pull mask layers from
        // discovery instead of streaming albedo alone.
        extraLayersForItem: (item) => maskAuthority.layersForItem(item),
        onPageDecoded: (info) => maskAuthority.ingestDecodedPage(info),
        // Feeds the curtain, when there is one. A floor switch never reaches this
        // function at all (see the canvasReady handler), and these calls no-op
        // when nothing is loading — so the reporting path needs no knowledge of
        // whether a curtain is up.
        onLoadProgress: ({ done, total, detail }) => reportSceneLoadProgress(LOAD_PHASES.ART, { done, total, detail }),
        // THE DEVICE-LOST SAFETY SLIDE'S seam half (see startVtPanViewer's
        // onDeviceLost handler): when the GPU device is lost, the viewer removes
        // its own dead canvas and announces — but only boot.js, the composition
        // root that suppressed Foundry's art, can un-suppress it. Restoring the
        // seam here is what turns "MSA's dead black canvas over hidden Foundry
        // art" back into "Foundry drawing the scene normally".
        onDeviceLost: () => {
          const seam = restoreFoundryArt();
          log.info(`device lost — restored Foundry's own art (seam un-suppressed: ${seam}).`);
        },
      })),
    };
  }

  MapShine.debug.registerAction('vt-pan-viewer-start-real-scene', 'Restart: active scene', async () => {
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
      log.info(`VRAM severance — floor ${floor.index} (${floor.name}):`, result);
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
  MapShine.debug.registerAction(
    'loading-screen-arm',
    'Loading Screen: Arm for next redraw (then switch floor/scene)',
    () => ({
      report: 'loading-screen-arm',
      generatedAt: new Date().toISOString(),
      ...resetLoadingSceneMemory(),
      note: 'The next canvasInit will now be treated as a cold load and raise the curtain, even for the scene you are already on.',
    })
  );

  MapShine.debug.registerReport('interface-seam', 'Interface seam (art vs chrome)', () => getCanvasCompositingReport());

  // RENDERER A/B TOGGLE (2026-07-18, author request: "a button that lets me
  // toggle back to the native PIXI render and back again to threejs, for
  // proper A/B visual testing of the lights").
  //
  // NOT a new mechanism — the interface seam already has a fully reversible
  // lever for exactly this (canvas-compositing.js): `canvas.environment
  // .renderable`. false = Foundry's own primary+effects art is suppressed and
  // MSA (stacked underneath, verified z-index 0 vs Foundry's own canvas —
  // vt-pan-viewer.js's stackUnderBoard) shows through. true = Foundry draws
  // its own art again, on top, occluding MSA. MSA's render loop keeps running
  // in EITHER mode (wasted GPU work while hidden, never a correctness issue —
  // pausing it is a possible follow-up, not needed for A/B comparison).
  //
  // A dropdown, not a plain button (feedback_debug_ui_one_action_one_control:
  // mutually-exclusive modes are a dropdown), reading its value from the SAME
  // live fact the interface-seam report already exposes — one source of
  // truth, not a second one invented for this control.
  //
  // Switching TO Foundry is unconditional (`restoreFoundryArt` — showing
  // Foundry's own art is never unsafe). Switching TO MSA reuses
  // `applyArtSuppression`'s existing safety check (decideArtSuppression) and
  // can REFUSE (e.g. the PIXI context is opaque) — a refusal is thrown, not
  // silently swallowed, so the status line reads "failed: <reason>" rather
  // than a false "✓" (feedback_instruments_must_not_lie).
  MapShine.debug.registerSelect(
    'render-compare',
    'Renderer',
    [
      { value: 'msa', label: 'MSA' },
      { value: 'foundry', label: 'Foundry' },
    ],
    () => (getCanvasCompositingReport().environmentRenderable ? 'foundry' : 'msa'),
    async (mode) => {
      if (mode === 'foundry') {
        if (!restoreFoundryArt())
          throw new Error("restoreFoundryArt() could not restore Foundry's own art — see console.");
        return;
      }
      const result = applyArtSuppression();
      if (!result.applied) throw new Error(`refused (${result.code}): ${result.reason}`);
    }
  );

  // THE DARKNESS-REALISM LEVER (2026-07-19, author-requested) — how dark the
  // UNLIT scene gets at maximum scene darkness. "Foundry" (default) floors at
  // Foundry's own readable darkness colour (~19%, never black — parity); the
  // "realistic" end drives that floor to true black. Presets rather than a
  // continuous slider because the debug panel's lever primitive is a select
  // (feedback_debug_ui_one_action_one_control) — three points span the range.
  MapShine.debug.registerSelect(
    'darkness-realism',
    'Darkness at max',
    [
      { value: '0', label: 'Foundry (readable)' },
      { value: '0.5', label: 'Halfway' },
      { value: '1', label: 'Realistic (black)' },
    ],
    () => {
      // Snap the live value to the nearest preset for display (the API accepts
      // any 0..1; the dropdown only offers these three).
      const v = getDarknessRealism();
      if (v <= 0.25) return '0';
      if (v >= 0.75) return '1';
      return '0.5';
    },
    (value) => {
      setDarknessRealism(Number(value));
    }
  );

  // THE INTERACTIVE PIXEL PROBE (2026-07-19, author-requested: "I need a
  // button to activate pixel probe and the ability to click on the screen
  // to set the three points"). An ACTION, not a report — it arms a click
  // listener and does not resolve until the author has clicked up to 3
  // points (or 90s elapse), so it must never be swept up by the flight
  // recorder's "run every report" export. Its return value (the same
  // 5-buffer readback + deltaFromPrev `MapShine.probePixels` gives) is
  // copied to the clipboard automatically by the SAME mechanism every other action
  // uses — click, then click up to 3 map points, then paste.
  MapShine.debug.registerAction('pixel-probe', 'Pixel Probe (click 3 pts)', async () => ({
    report: 'pixel-probe',
    generatedAt: new Date().toISOString(),
    points: await MapShine.armPixelProbe(3),
  }));

  // THE THIRD GROUP (2026-07-17, ghost-hunting round 3). Five theories dead by
  // direct evidence tonight, in order: environmentRenderable:false (not
  // Foundry's suppressed art), renderer.autoClear defaults true and nothing
  // overrides it — verified against three.webgpu.js — (not a stale
  // sceneColor buffer), totalStuckChildren:0 (not a stuck drag preview),
  // msaCanvasCount:1 (not an orphaned second viewer), and — provably, by
  // reading the code rather than guessing — NOT an MSA mesh at all: every
  // itemStates entry gets `.visible` set by exactly one of two gates on every
  // residency pass (vt-pan-viewer.js:1740 or :1833, the isolation-aware one),
  // with no third writer (`refreshItemPlacement`, called every frame by
  // `syncTokenPlacements`, touches only geometry — never `.visible`, read
  // directly). `scene.add()` is called in exactly one place in the whole
  // file. So whatever draws the ghost is not in this Three.js scene, period.
  //
  // `canvas.environment` and `canvas.interface` are two of THREE siblings
  // under `rendered` (config.mjs: primary/effects → environment; every
  // placeable layer → interface; `visibility` → the THIRD, Foundry's fog of
  // war). `applyArtSuppression` was only ever told about the first two.
  // `CanvasVisibility#visible` (visibility.mjs:499) is
  // `canvas.effects.visionSources.some(s => s.active) || !game.user.isGM` —
  // true the instant a vision source is active, which this session's own
  // early testing ("I tried making the scene dark and adding a light and the
  // token's vision was only present where the light was") means it plausibly
  // has been. Its `explored` container holds `canvas.fog.sprite`
  // (fog.mjs:118) — a real SpriteMesh with a real texture, drawn through
  // FOUNDRY'S OWN camera, which the thrash test never touches. A hypothesis,
  // not a diagnosis (feedback_plausible_diagnosis_rots) — this is the one
  // machine-checked fact that confirms or kills it.
  MapShine.debug.registerReport('fog-of-war-census', 'Fog of war (third PIXI group)', () => {
    const vis = typeof canvas !== 'undefined' ? (canvas?.visibility ?? null) : null;
    if (!vis) {
      return {
        report: 'fog-of-war-census',
        generatedAt: new Date().toISOString(),
        present: false,
        interpretation: 'canvas.visibility is not reachable — not running inside a loaded Foundry scene.',
      };
    }
    const sprite = canvas?.fog?.sprite ?? null;
    const spriteRect = sprite?.getBounds ? sprite.getBounds() : null;
    const visionSources = Array.from(canvas?.effects?.visionSources ?? []);
    return {
      report: 'fog-of-war-census',
      generatedAt: new Date().toISOString(),
      present: true,
      visibilityGroupVisible: vis.visible,
      visibilityGroupRenderable: vis.renderable,
      exploredContainerVisible: vis.explored?.visible ?? null,
      exploredContainerChildCount: vis.explored?.children?.length ?? null,
      isGM: typeof game !== 'undefined' ? (game?.user?.isGM ?? null) : null,
      activeVisionSourceCount: visionSources.filter((s) => s?.active).length,
      totalVisionSourceCount: visionSources.length,
      fogSprite: sprite
        ? {
            visible: sprite.visible,
            alpha: sprite.alpha,
            width: sprite.width,
            height: sprite.height,
            x: sprite.x,
            y: sprite.y,
            bounds: spriteRect
              ? {
                  x: Math.round(spriteRect.x),
                  y: Math.round(spriteRect.y),
                  w: Math.round(spriteRect.width),
                  h: Math.round(spriteRect.height),
                }
              : null,
          }
        : null,
      interpretation:
        'visibilityGroupVisible:false means fog is entirely off this frame — rule this theory out. ' +
        'visibilityGroupVisible:true means canvas.visibility (a SIBLING of the suppressed environment ' +
        'group, never touched by applyArtSuppression) is genuinely drawing, and fogSprite.bounds is a ' +
        "REAL rectangle in FOUNDRY's own screen space — compare it against where the ghost visually " +
        "sits. It is drawn through Foundry's own camera, which the VT thrash test never moves, so once " +
        "MSA's independently-thrashed camera diverges from Foundry's, this sprite would appear at the " +
        'wrong scale and place relative to MSA content, immune to MSA eviction, and outside every ' +
        'MSA draw item — matching everything reported so far.',
    };
  });

  // THE OTHER HALF OF THE SEAM (2026-07-17, ghost-hunting). applyArtSuppression
  // only ever touches `canvas.environment` (`primary` + `effects` per
  // MSA_OWNED_GROUPS) — verified against config.mjs, that is where `primary` and
  // `effects` both declare `parent: "environment"`. Every PLACEABLE layer
  // (tiles, tokens, walls, notes, templates, drawings, regions, sounds,
  // lighting) is declared `group: "interface"`, a SIBLING of `environment`
  // under `rendered` — `environmentRenderable:false` says nothing about it,
  // by design (keyhole-interface-seam: "PIXI keeps the CHROME").
  //
  // Each of those layers is a `PlaceablesLayer`, and EVERY `PlaceablesLayer`
  // owns a `.preview` PIXI.Container (placeables-layer.mjs:348) used to draw a
  // LIVE placeable — actual art, not a read-only overlay — during a drag or
  // creation gesture. It is supposed to empty via `clearPreviewContainer()` on
  // drop/cancel (placeables-layer.mjs:427/1185/1194) — but every one of those
  // call sites is reachable through Foundry's OWN pointer handling, which this
  // session's early bug reports ("it leaves a version of the tile behind")
  // describe going wrong under MSA. A stuck preview would be real PIXI content,
  // entirely outside `canvas.environment` AND outside every MSA draw item — so
  // it would render regardless of `environmentRenderable` and regardless of
  // the isolate-draw-item selection. That is a hypothesis, not a diagnosis
  // (feedback_plausible_diagnosis_rots) — this report is the one machine-
  // checked fact that confirms or kills it: a genuinely empty preview on every
  // layer means look elsewhere entirely.
  // CANVAS CENSUS (2026-07-17, ghost-hunting round 2). Three theories are now
  // DEAD by live evidence: Foundry's own art is off (environmentRenderable:
  // false), MSA's sceneColor target clears unconditionally every frame
  // (renderer.autoClear defaults true in three.webgpu.js and nothing in this
  // file touches it — verified against the vendored source, not assumed), and
  // every PlaceablesLayer.preview is empty (totalStuckChildren:0). Isolating
  // any single MSA draw item still shows the ghost.
  //
  // The remaining candidate: not WHAT draws, but HOW MANY THINGS draw.
  // `disposeActive()` (vt-pan-viewer.js:195) removes the old canvas via
  // `_active.canvas.remove()` wrapped in an empty `catch(_){}` — standard
  // practice everywhere else in that function for a teardown step that must
  // not crash the NEXT viewer's startup, but it means a removal that silently
  // failed would leave a canvas element attached forever, frozen at whatever
  // camera state it had the instant its `setAnimationLoop(null)` killed it:
  // static, wrong scale (a stale zoom), wrong place (a stale pan), and
  // genuinely un-evictable (its renderer is dead, not merely off-screen).
  // That matches everything reported so far. This is a hypothesis, not a
  // diagnosis (feedback_plausible_diagnosis_rots) — the census below is the
  // one machine-checked fact that confirms or kills it.
  MapShine.debug.registerReport('vt-canvas-census', 'VT canvas census (orphaned viewer?)', () => {
    const byId = document.querySelectorAll('#msa-vt-pan-viewer-canvas');
    const allCanvases = Array.from(document.querySelectorAll('canvas'));
    return {
      report: 'vt-canvas-census',
      generatedAt: new Date().toISOString(),
      msaCanvasCount: byId.length,
      totalCanvasCount: allCanvases.length,
      msaCanvases: Array.from(byId).map((c) => {
        const r = c.getBoundingClientRect();
        const cs = window.getComputedStyle(c);
        return {
          width: c.width,
          height: c.height,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          zIndex: cs.zIndex,
          display: cs.display,
          opacity: cs.opacity,
          isConnected: c.isConnected,
        };
      }),
      allCanvases: allCanvases.map((c) => ({
        id: c.id || '(no id)',
        width: c.width,
        height: c.height,
        parentId: c.parentElement?.id || '(no id)',
      })),
      interpretation:
        'msaCanvasCount SHOULD be exactly 1 while a viewer is running (0 if stopped). If it is 2+, ' +
        'disposeActive() failed to remove a previous canvas and an ORPHANED, FROZEN viewer instance ' +
        "is sitting in the DOM — that instance's last rendered frame IS the ghost: static, at whatever " +
        'zoom/pan it had when its render loop was killed, invisible to isolate-draw-item and immune to ' +
        'eviction because it belongs to a dead renderer, not the live one. Compare each msaCanvases ' +
        "entry's rect against where the ghost visually sits on screen.",
    };
  });

  MapShine.debug.registerReport('interface-preview-leak', 'Interface previews (stuck drag ghosts?)', () => {
    const PREVIEW_LAYER_NAMES = [
      'tiles',
      'tokens',
      'walls',
      'notes',
      'templates',
      'drawings',
      'regions',
      'sounds',
      'lighting',
    ];
    const layers = {};
    let totalStuckChildren = 0;
    for (const name of PREVIEW_LAYER_NAMES) {
      const layer = typeof canvas !== 'undefined' ? (canvas?.[name] ?? null) : null;
      const preview = layer?.preview ?? null;
      if (!preview) {
        layers[name] = { present: false };
        continue;
      }
      const children = Array.isArray(preview.children) ? preview.children : [];
      totalStuckChildren += children.length;
      layers[name] = {
        present: true,
        childCount: children.length,
        children: children.map((c) => ({
          constructorName: c?.constructor?.name ?? '(unknown)',
          documentId: c?.document?.id ?? null,
          x: c?.x ?? null,
          y: c?.y ?? null,
          width: c?.width ?? null,
          height: c?.height ?? null,
          visible: c?.visible ?? null,
          alpha: c?.alpha ?? null,
          destroyed: c?._destroyed ?? null,
        })),
      };
    }
    return {
      report: 'interface-preview-leak',
      generatedAt: new Date().toISOString(),
      totalStuckChildren,
      layers,
      interpretation:
        'totalStuckChildren:0 across every layer means every PlaceablesLayer.preview is genuinely ' +
        'empty — the ghost is NOT a stuck Foundry drag/creation preview, rule this theory out entirely. ' +
        "Any nonzero childCount is real PIXI content sitting in canvas.interface, drawn at FOUNDRY'S " +
        "own (un-thrashed) screen coordinates, untouched by MSA's cache, its residency, and its " +
        'isolate-draw-item control alike — because it is not an MSA mesh. x/y/width/height are in ' +
        "that layer's local space; compare against where the ghost visually sits on screen.",
    };
  });

  // Shared by pixi-residency-report and stage-gate-baseline below — both need
  // the active scene doc, and boot.js already has this exact `canvas.scene`
  // ternary repeated as ratcheted debt at several other call sites in this
  // file. Routing both through ONE helper, instead of each report inlining
  // its own copy, keeps `foundry/adapter-only`'s ratchet at its current bound
  // rather than growing it by one violation per new report that needs a scene.
  const getActiveSceneDoc = () => (typeof canvas !== 'undefined' ? (canvas.scene ?? null) : null);

  MapShine.debug.registerReport('pixi-residency-report', 'PIXI residency', () => {
    const sceneDoc = getActiveSceneDoc();
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

  // ---------------------------------------------------------------------------
  // THE STAGE-GATE BASELINE (2026-07-18) — Keyhole.md's infrastructure menu,
  // Track 2 item 5 ("the performance baseline + regression harness") + item 7
  // ("the multi-scene validation matrix"). ONE report serves both: run it once
  // per scene (the torture fixture, Church, Mansion, one non-square multi-floor
  // scene — Keyhole.md §8's own gate scenes) and each run is a row in the
  // matrix; run it on the SAME scene across sessions and it's the regression
  // diff. Nothing here was previously aggregated in one place — this is
  // read-only (calls existing reports/accessors, changes no render behavior),
  // built specifically so the very first session back at a browser can verify
  // everything built blind this session (the pass runner, frame.snapshot,
  // masks.occlusion) in one click instead of ad hoc clicking around.
  //
  // Every gate below is quoted from Keyhole.md §1/§8 directly rather than
  // reinvented — a threshold I misremembered would be worse than no threshold.
  // Anything NOT instrumented reports `available:false` with a reason, never a
  // guessed or zeroed number (doctrine #5, instruments must not lie) — this
  // project's own crash campaign was killed by exactly this kind of honesty.
  MapShine.debug.registerReport('stage-gate-baseline', 'Stage gate baseline (run once per scene)', () => {
    const sceneDoc = getActiveSceneDoc();
    const floorsResult = getActiveSceneFloors(sceneDoc);
    const srcs = floorsResult.ok ? floorsResult.floors.map((f) => f.url) : [];
    const pixi = getPixiResidencyReport(srcs);
    const pixiTotalMB = pixi.available
      ? Math.round((pixi.entries.reduce((sum, e) => sum + (e.approxBytes ?? 0), 0) / (1024 * 1024)) * 10) / 10
      : null;
    const vt = getVtPanViewerDiagnostics();
    const loading = getLoadingScreenState();
    const wholeImageErrors = (vt.wholeImage?.items ?? [])
      .filter((i) => i.error)
      .map((i) => ({ id: i.id, error: i.error }));

    return {
      report: 'stage-gate-baseline',
      generatedAt: new Date().toISOString(),
      sceneName: sceneDoc?.name ?? null,
      sceneId: sceneDoc?.id ?? null,
      floorCount: floorsResult.ok ? floorsResult.floors.length : null,
      viewerActive: vt.active,
      gates: {
        // Stage 2's gate (Keyhole.md §8): "PIXI ≤ 60 MB".
        pixiResidencyMB: { value: pixiTotalMB, gateMaxMB: 60, pass: pixiTotalMB === null ? null : pixiTotalMB <= 60 },
        // Stage 1's gate (Keyhole.md §8): "interactive ≤ 10 s" — reads the
        // last COMPLETED load's total, per load-progress.js's own receipt.
        // null = no load has completed yet this session (reload the scene
        // before running this report, not a bug).
        loadTimeMs: {
          value: loading.lastLoad?.totalMs ?? null,
          gateMaxMs: 10000,
          pass: loading.lastLoad?.totalMs == null ? null : loading.lastLoad.totalMs <= 10000,
          // A load that completes but froze the main thread for seconds is a
          // bug with a receipt, not a pass — check this even if totalMs is fine.
          worstStallMs: loading.lastLoad?.worstStallMs ?? null,
        },
        // Stage 1's gate (Keyhole.md §8): "torture scene pans at 60 fps
        // target / 30 floor". Reported as frame-GAP percentiles in ms
        // (what's actually tracked) rather than converted to fps, so the
        // raw measurement is never silently reinterpreted: 16.7ms ≈ 60fps,
        // 33.3ms ≈ the 30fps floor. Pan/zoom/floor-switch BEFORE running
        // this report — it reads a 300-frame rolling window, not a live sample.
        frameGapMs: vt.hitchStats ?? { available: false, reason: 'viewer not active' },
        // NOT INSTRUMENTED — the original Stage 2 gate ("zero texImage2D >
        // 32ms") was a WebGL-call-level metric from the V2 crash campaign
        // (Forward+.md §13's slowGlOps). V3's upload path is architecturally
        // different (page-atlas uploads via atlas.js, or whole-image via
        // renderer.initTexture — see Keyhole.md's compression section) and
        // has no equivalent per-call timer. Reported honestly absent rather
        // than mapped onto a metric that no longer means the same thing.
        texImage2DOver32ms: {
          available: false,
          reason: 'no V3 equivalent of this V2 WebGL-call-level metric exists yet',
        },
      },
      vramFacts: {
        estTextureVramMB: vt.wholeImage?.estTextureVramMB ?? null,
        packs: vt.layerResidencyTotals?.packs ?? null,
        // Both should read 0 — see their own field-level interpretation
        // text in the Diagnostics report if either is nonzero.
        coarsePinShortfall: vt.layerResidencyTotals?.coarsePinShortfall ?? null,
        coarseReserveMisses: vt.coarsePinBudget?.cacheReserveCheck?.coarseReserveMisses ?? null,
      },
      errors: {
        layerLoadErrors: vt.layerLoadErrors ?? [],
        wholeImageErrors,
      },
      interpretation:
        'Run once per scene (torture fixture, Church, Mansion, one non-square multi-floor scene), ' +
        'copy the JSON, paste it back — that becomes one row of the multi-scene validation matrix ' +
        '(Keyhole.md Track 2 item 7) or, run again later on the SAME scene, the regression diff ' +
        '(item 5). A `pass:null` means "not measured yet" (e.g. reload the scene so loadTimeMs has a ' +
        'completed load to read) — never read null as a failure. `frameGapMs` needs real pan/zoom/' +
        'floor-switch input before this report captures anything meaningful; a scene sitting idle ' +
        'will show a thin or empty sample.',
    };
  });

  // THE INTERFACE SEAM — MSA owns the ART, Foundry's PIXI keeps the CHROME.
  // Registered HERE, at module load, and that is not stylistic: `canvasConfig`
  // fires inside Canvas#initialize, which runs between the "setup" and "ready"
  // hooks (game.mjs:740/763/779), and it is the ONLY chance to make the PIXI
  // canvas transparent — PIXI derives the GL context's immutable `alpha`
  // attribute from backgroundAlpha at context-creation time. Miss it and the
  // canvas is opaque for the whole session. install() runs at esmodule load,
  // long before setup. Full reasoning in foundry/canvas-compositing.js.
  {
    const seam = registerCanvasCompositing();
    if (!seam.registered) log.warn(`interface seam not registered — ${seam.reason}`);
  }

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
    // THE BLANK-CANVAS GAP (audit, 2026-07-17): canvasInit/canvasReady are
    // BOTH skipped entirely when Foundry draws a BLANK canvas (`Scene
    // #unview()`, or the active scene being deleted) — see
    // foundry/canvas-lifecycle.js's header for the full mechanism and why a
    // plain canvasTearDown listener can't just dispose unconditionally
    // (it would defeat the cheap same-scene floor-switch path below). The
    // `Hooks.on` call itself lives in foundry/ (the wall's adapter-only
    // ratchet is already at its bound); `markCovered()` here is a plain
    // function call, not a new Foundry-global touch.
    const tearDownWatchdog = registerCanvasTearDownWatchdog({
      isViewerActive: () => getVtPanViewerDiagnostics().active,
      onOrphaned: () => {
        stopVtPanViewer();
        lastRealSceneId = null;
        endSceneLoad({ error: 'canvas is blank (scene unviewed or deleted)' });
      },
      logInfo: (msg) => log.info(msg),
    });
    if (!tearDownWatchdog.registered) log.warn(`blank-canvas watchdog not registered — ${tearDownWatchdog.reason}`);

    Hooks.on('canvasInit', (canvasRef) => {
      tearDownWatchdog.markCovered(); // this draw is real — see foundry/canvas-lifecycle.js
      try {
        const sceneDoc = canvasRef?.scene ?? null;
        const verdict = beginSceneLoad({ sceneId: sceneDoc?.id ?? null, sceneName: sceneDoc?.name });
        if (!verdict.shown) log.info(`loading screen suppressed — ${verdict.reason}`);
      } catch (err) {
        // A broken curtain must never block a scene load.
        log.error(`loading screen failed to start:`, err);
      }
    });

    Hooks.on('canvasInit', async (canvasRef) => {
      try {
        await registerFloorProxies(canvasRef?.scene ?? null);
      } catch (err) {
        log.error(`VRAM severance — canvasInit proxy registration failed:`, err);
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
    // DOCUMENT CRUD -> redraw. The draw list is derived from live Foundry
    // documents, but nothing was watching them: updateResidency only re-asks
    // buildItems when the VIEW changes, so a token created while the camera sat
    // still never appeared (author-reported 2026-07-16).
    //
    // THE LIST MUST MATCH buildItems, AND IT DID NOT (author-reported
    // 2026-07-17: "I can move a tile and it's clearly moving the document but
    // it's not currently updating the tile's position when I release it... it
    // only updates when I pan or zoom and it leaves a version of the tile
    // behind"). buildItems is `collectSceneLayers(...)` + `collectTokens(...)`,
    // i.e. Level art AND Tiles AND Tokens — but only Token was watched. So a
    // moved tile kept its MSA art at the old spot while Foundry's interface
    // chrome (its frame and handles, which PIXI still draws) sat at the new
    // one: the "version left behind" is our stale art beside Foundry's
    // correctly-moved selection frame. Nothing was wrong with the renderer; it
    // was simply never told.
    //
    // DERIVED FROM THE COLLECTORS' OWN DECLARATIONS, not a list remembered here
    // — `buildItems` is exactly `collectSceneLayers` + `collectTokens`, and each
    // declares the document types it reads right beside itself. A list kept in
    // boot.js is a list that drifts away from the thing it describes, which is
    // the whole mechanism of this bug (and the reason `tools/run-tests.mjs`
    // discovers suites off disk rather than reading a hand-kept array).
    //
    // Foundry's own hook names are the authority: `Hooks.callAll(`update${type}`)`
    // where type is the documentName — verified in the v14 source at
    // client/data/client-backend.mjs:159/327/451 (create/update/delete).
    const DRAW_LIST_DOCUMENTS = [...SCENE_LAYER_DOCUMENTS, ...TOKEN_DOCUMENTS];

    // THE MASK AUTHORITY'S item set follows the scene-layer half of the same
    // declared document list (tokens never participate in cover, and
    // re-collecting on every token move would be pure waste). It PIGGYBACKS on
    // redrawOn's existing hook registration rather than registering its own —
    // deliberately: a separate Hooks.on + a `canvas.scene` read here was two
    // new foundry/adapter-only violations, and the wall (correctly) refused
    // the ratchet. The hook handler already RECEIVES the changed document, and
    // an embedded document's `.parent` IS its Scene — no global needed.
    const MASK_AUTHORITY_HOOKS = new Set(
      SCENE_LAYER_DOCUMENTS.flatMap((doc) => ['create', 'update', 'delete'].map((verb) => `${verb}${doc}`))
    );
    const refreshMaskAuthorityItems = (hook, sceneDoc) => {
      try {
        if (!sceneDoc) return;
        const floorsResult = getActiveSceneFloors(sceneDoc);
        if (!floorsResult.ok) return;
        const levelIds = floorsResult.floors.map((f) => f.id).filter(Boolean);
        maskAuthority.setItems(
          collectSceneLayers(sceneDoc, {
            viewedLevelId: levelIds[0],
            visibleLevelIds: levelIds,
            isGM: true,
          }).items
        );
      } catch (err) {
        log.error(`mask-authority item refresh failed on ${hook}:`, err);
      }
    };

    const redrawOn = (hook) => {
      Hooks.on(hook, (doc) => {
        // Fire-and-forget: a redraw must never make a document update await GPU
        // work, and a failed redraw must not break Foundry's own bookkeeping.
        // The hook NAME is passed through: diagnostics' documentSync.byHook is
        // how "which hook actually fired" gets answered from a report.
        refreshVtPanViewerItems(hook).catch((err) => log.error(`${hook} redraw failed:`, err));
        if (MASK_AUTHORITY_HOOKS.has(hook)) refreshMaskAuthorityItems(hook, doc?.parent ?? null);
      });
    };
    for (const doc of DRAW_LIST_DOCUMENTS) {
      for (const verb of ['create', 'update', 'delete']) redrawOn(`${verb}${doc}`);
    }

    // MOVEMENT IS NOT AN ORDINARY UPDATE IN v14 — it has its own hook family,
    // and CRUD alone does not cover it (author-reported 2026-07-17: "when I move
    // a token it clearly moves in the document but it only updates... once I pan
    // the camera or zoom"). The instrument said a hook fired and the position
    // was unchanged, so the position lands somewhere other than where we looked.
    //
    // v14 fires these from `TokenDocument.#onUpdateOperationMovement`
    // (client/documents/token.mjs:2880/2883), reached via the static
    // `_onUpdateOperation` — which client-backend.mjs runs at line 339, AFTER
    // the per-document `updateToken` callbacks at line 333. So these fire
    // strictly LATER in the same operation, once the movement is applied and
    // frozen. That ordering is the whole reason they can catch what updateToken
    // apparently could not.
    //
    //   moveToken  - a movement with passed waypoints was applied
    //   stopToken  - movement was constrained/halted partway (final rest position)
    //   pauseToken - movement paused (token.mjs:868)
    //
    // A redundant refresh is FREE — refreshItemPlacement compares a placementKey
    // and returns false when nothing moved, so catching the same move twice
    // costs one string build and no GPU work. Cheap enough that covering the
    // whole family beats guessing which single one is authoritative.
    for (const hook of ['moveToken', 'stopToken', 'pauseToken']) redrawOn(hook);

    Hooks.on('canvasReady', async (canvasRef) => {
      try {
        const sceneDoc = canvasRef?.scene ?? null;
        if (!sceneDoc) return;
        MapShine.__painter?.hydrateFromScene(); // pull any painted masks saved on this scene
        const floorsResult = getActiveSceneFloors(sceneDoc);
        if (!floorsResult.ok) {
          log.warn(`real-scene VT viewer: ${floorsResult.error}`);
          // THE ZOMBIE-VIEWER GAP (audit, 2026-07-17): this branch used to just
          // warn and return, leaving whatever viewer was already running — built
          // for the PREVIOUS scene — rendering on, now slaved to THIS scene's
          // camera (followFoundryCamera reads canvas.stage every frame
          // regardless of which scene it was built for), with the loading
          // curtain (if beginSceneLoad's canvasInit handler raised one for this
          // draw) stuck up forever, since nothing here ever called
          // endSceneLoad(). "This scene has no art MSA can render" is ALWAYS a
          // genuine scene change — getActiveSceneFloors doesn't depend on the
          // viewed floor, so a same-scene floor switch can never land here —
          // which means stopping unconditionally is always correct and can
          // never defeat the cheap floor-switch path below.
          stopVtPanViewer();
          lastRealSceneId = null;
          endSceneLoad({ error: floorsResult.error });
          return;
        }
        const targetFloorIndex = resolveFloorDescriptor(sceneDoc, floorsResult.floors);

        if (lastRealSceneId === sceneDoc.id && getVtPanViewerDiagnostics().active) {
          // A floor switch. No curtain was raised for it and none is lifted —
          // beginSceneLoad already declined, so there is nothing here to undo.
          // "Floor changes without loading screens" is this branch existing.
          const result = await setVtPanViewerFloor(targetFloorIndex);
          log.info(`real-scene VT viewer synced to floor ${targetFloorIndex} (same scene).`, result);
          syncInterfaceSeam('floor switch');
          return;
        }

        lastRealSceneId = sceneDoc.id;
        const result = await startRealSceneViewer(targetFloorIndex);
        if (result.ok === false) {
          log.warn(`real-scene VT viewer did not start:`, result.error);
          endSceneLoad({ error: result.error });
          return;
        }
        log.info(`real-scene VT viewer active for "${result.sceneName}" at floor ${targetFloorIndex}.`);

        // LIFT ONLY WHEN THERE IS SOMETHING TO SEE. startVtPanViewer has resolved,
        // so every coarse pin is resident and the render loop is armed — but no
        // frame has PAINTED yet. Waiting one frame is the difference between
        // "Ready" being true and being the §7 "Ready!" lie under a new name.
        beginSceneLoadPhase(LOAD_PHASES.FIRST_FRAME);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        // ONLY NOW hand the art over. MSA has painted a real frame, so
        // suppressing Foundry's `primary`/`effects` swaps one picture for
        // another instead of leaving a hole. Suppressing earlier — or while the
        // PIXI canvas is still opaque — is the one state worse than doing
        // nothing at all: no art from EITHER renderer, with selection borders
        // floating over a void. applyArtSuppression refuses on its own if the
        // canvas is not verifiably transparent; this is just the right MOMENT.
        syncInterfaceSeam('scene load');

        const summary = endSceneLoad();
        if (summary) {
          // worstStallMs is surfaced, not swallowed: a load that completes but
          // froze the main thread for seconds is a bug with a receipt.
          log.info(
            `scene load complete in ${summary.totalMs}ms` +
              (summary.worstStallMs > 0 ? ` (worst main-thread stall: ${summary.worstStallMs}ms)` : ''),
            summary
          );
        }
      } catch (err) {
        log.error(`real-scene VT viewer auto-sync failed:`, err);
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
  MapShine.soakHooks.zoom = (i) => soakZoomStep(i);

  log.info(
    `%c${TAG}%c ${STAGE} — new tree live, legacy quarantined. Three r${THREE.REVISION} / WebGL2.` +
      ` Soak harness ready: MapShine.soak(n).`,
    'color:#8fd6ff;font-weight:bold',
    'color:inherit'
  );

  // Foundry defines its globals before loading module esmodules, so `Hooks` is
  // available here. If we are somehow loaded outside Foundry, fall back to the
  // window load event so the boot proof still renders.
  if (typeof Hooks !== 'undefined') {
    Hooks.once('init', () => log.info(`init — ${MODULE_ID}`));
    Hooks.once('ready', () => {
      bootHeartbeat().catch((err) => log.error('bootHeartbeat failed:', err));
    });
  } else {
    log.warn(`no Foundry Hooks found; booting on window load.`);
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
/**
 * Hand Foundry's art over to MSA, once MSA is confirmed to be painting.
 * Idempotent — `canvasReady` fires for both a scene change and a floor switch,
 * and Foundry's own group teardown/redraw could plausibly reset `renderable`,
 * so this re-asserts on every one rather than trusting a remembered state.
 *
 * Refusal is NOT failure: applyArtSuppression defaults to leaving Foundry
 * rendering whenever it cannot verify the PIXI canvas is transparent, and says
 * so loudly. That is the safety slide, and a table that can play beats a pretty
 * renderer that cannot.
 */
function syncInterfaceSeam(context) {
  const seam = applyArtSuppression();
  if (seam.applied) {
    log.info(
      `interface seam active (${context}) — MSA owns primary+effects (the art); ` +
        `Foundry's PIXI keeps interface (selection, grid, walls, controls) on top.`
    );
  }
  // Re-sync the "Renderer" dropdown (and any other control) against reality
  // NOW — this is the exact moment environmentRenderable can flip. Without
  // this the debug panel's FIRST paint (registered during boot, before any
  // scene has loaded) shows whatever was true at that early instant, and
  // nothing ever repaints it (see refreshControls' own doc). Called
  // unconditionally, not just on seam.applied — a REFUSED suppression is
  // also a real state change the dropdown must reflect (Foundry's art is
  // genuinely still showing then).
  MapShine.debug?.refreshControls?.();
  return seam;
}

async function bootHeartbeat() {
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

    // Same raised WebGPU texture cap as the VT viewer (vt/texture-limits.js) —
    // so this renderer's device, which the flight recorder reports, agrees with
    // the one that draws the map. Awaited before construction; the heartbeat is
    // fire-and-forget so the one adapter round-trip costs nothing that matters.
    const requiredLimits = await resolveRendererRequiredLimits();
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true, requiredLimits });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.setSize(HEARTBEAT_W, HEARTBEAT_H, false);
    renderer.setClearColor(0x000000, 0); // transparent → CSS background shows
    // The node renderer must init() before it will draw. Fire-and-forget: the
    // heartbeat is a liveness indicator, and a heartbeat that blocks boot to
    // report that boot is alive would be a poor sort of heartbeat.
    renderer.init().catch((err) => log.error(`heartbeat renderer init failed:`, err));

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

      // THE BLACK BOX'S FRAME FEED. Same loop, same `t`, for the same reason the
      // readout below uses it: this is the MAIN THREAD's cadence, and it keeps
      // reporting when the VT is stopped, failed, or never started. The recorder
      // keeps three views of it — a histogram over every frame, a 1-in-N
      // timeline, and every hitch — so the export can answer "what was the frame
      // rate like" without either storing 200k frames or sampling the hitches
      // away. The panel's live readout stays as it is: it answers "right now",
      // which is a different question from "what happened".
      MapShine.flight?.recordFrame(t);

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
    log.info(`boot heartbeat rendering. Gate "boot renders" ✔`);
  } catch (err) {
    // Doctrine #1: fail LOUD, never silently. No V2 fallback exists to hide behind.
    log.error(`boot heartbeat FAILED — the new renderer did not come up:`, err);
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
