/**
 * THE DOOR to foundry/ — the ONE Foundry adapter. One public API per zone
 * (Skeleton.md §2.1, `zones/one-door`): if it is not exported here, other zones
 * cannot reach it.
 *
 * This door matters more than the others, and V2 is the reason. `legacy/foundry/`
 * was designated the adapter exactly as Keyhole §9.1 designates this one — and
 * **107 of 128 files that touch Foundry globals reached around it (16% coverage)**,
 * plus 98 unguarded `.prototype.x =` monkey-patches against 2 libWrapper
 * registrations. The adapter existed and LOST. That is the second of the three
 * independent proofs that optional structure always loses
 * (v2-postmortem-the-failure-modes; Engine-Postmortem.md §2).
 *
 * Two walls make this one non-optional, and they work as a pair:
 *   - `foundry/adapter-only` — the Foundry globals (`canvas.*`, `game.*`,
 *     `Hooks.*`) are unwritable outside `src/foundry/` (and `diag/`).
 *   - `zones/one-door` — and this file is the only way in from outside.
 * Together: you cannot touch Foundry from elsewhere, and you cannot reach past
 * this door to the files that can.
 *
 * `foundry/` IS A LEAF. It imports nothing above itself — V2 inverted exactly
 * this (`canvas-replacement.js`, the lowest-level integration file, imported
 * concrete effect classes like `SpecularEffectV2` BY NAME: 12,573 lines with
 * arrows pointing every direction and no "down"). If something in here ever
 * needs to import an effect, a pass, or the renderer, that is the inversion
 * re-forming — stop and invert the dependency instead.
 */

// Scene source + floors — reads Foundry's native v14 `scene.levels`.
export {
  getActiveSceneBackground,
  getActiveSceneFloors,
  computeVisibleFloorIndices,
  resolveAssetUrl,
  isImageUrl,
  // VIDEO TILES (mythica-machina-press#430) — the sibling extension check
  // that lets a caller route a video source to its own construction path
  // instead of lumping it in with "not a still image, skip it". See
  // active-scene-source.js's own isVideoUrl doc for why this is a genuine
  // sibling rather than a boolean flag on isImageUrl.
  isVideoUrl,
} from './active-scene-source.js';

// VIDEO TILE PLAYBACK (mythica-machina-press#430) — hands an MSA-owned
// <video> element to the REAL game.video singleton so it plays under
// Foundry's own first-gesture gate, at the Tile's own configured
// loop/autoplay/volume. See tile-video.js's own header for the full
// mechanism + Foundry-source citations.
export { playTileVideo } from './tile-video.js';

// The coordinate model — Foundry canvas space, placements, quads.
export {
  computeSceneDimensions,
  computeQuadCorners,
  computeQuadBounds,
  computeLevelTexturePlacement,
  computeTilePlacement,
  computeTokenPlacement,
  TEXTURE_FIT_MODES,
} from './scene-geometry.js';

// Scene documents -> keyed draw items (the layering law's input).
//
// SCENE_LAYER_DOCUMENTS / TOKEN_DOCUMENTS declare which Foundry document types
// each collector READS, so the renderer can watch exactly those and no others.
// They are exported because boot.js derives its CRUD-hook list from them rather
// than remembering one — a document type read but not watched renders once and
// then ignores every later change (2026-07-17: that was Tile).
export {
  collectSceneLayers,
  computeItemPlacement,
  SCENE_LAYER_DOCUMENTS,
  floorCeilings,
  floorElevationBands,
} from './scene-layers.js';

// Authored-mask file discovery (listing-first, probe fallback) — feeds the
// mask authority (scene/mask-authority.js#setDiscovery); nothing else reads it.
export { discoverAuthoredMasks } from './mask-discovery.js';

// Token documents -> drawables.
export { collectTokens, diagnoseTokens, TOKEN_DOCUMENTS, tokenFootprint } from './scene-tokens.js';

// Tile document access for the editing-cadence perf stress test ONLY — see
// scene-tiles.js's own header. Nothing here draws anything.
export { pickStressTestTile, pingStressTestTile, unpingStressTestTile } from './scene-tiles.js';

// VRAM severance — feed PIXI <=1024px proxies so Foundry never decodes the real file.
export {
  registerPixiProxy,
  getPixiResidencyReport,
  getPixiProxyStats,
  urlsToEvictOnSceneChange,
} from './pixi-proxy-textures.js';

// THE INTERFACE SEAM — MSA owns the art, PIXI keeps the interactive chrome.
export {
  registerCanvasCompositing,
  applyArtSuppression,
  restoreFoundryArt,
  getCanvasCompositingReport,
  // ⚖️ RECKONING (TEMPORARY): how much Foundry's OWN renderer is still doing —
  // the one large GPU consumer MSA's per-pass timestamps cannot see.
  getFoundryRendererCensus,
  // THE THIRD LEVER (Bug #21): MSA owns the explored-fog wash, so Foundry never
  // re-renders the map. On by default; these are the LOOK knob, not an on/off.
  setExploredFogBase,
  getExploredFogBase,
  applyExploredFogBase,
  resolveExploredFogBase,
  DEFAULT_EXPLORED_FOG_BASE,
  // PILLAR 11 — hand canvas.visibility to MSA. Default OFF; see its own header.
  setVisibilitySuppression,
  decideArtSuppression,
  MSA_OWNED_GROUPS,
} from './canvas-compositing.js';

// THE BLANK-CANVAS WATCHDOG — detects a canvasTearDown that nothing follows
// (Scene#unview(), the active scene being deleted), which canvasInit/
// canvasReady alone can never see.
export { registerCanvasTearDownWatchdog, isOrphanedTeardown } from './canvas-lifecycle.js';

// THE SCENE-ENVIRONMENT READER — feeds world/environment.js#buildEnvSnapshot's
// `ambientInput`, and reads `canvas.scene.environment.darknessLevel` for
// DIAGNOSTIC comparison only (MSA owns darkness outright — see
// `publishSceneDarkness`'s own header; `darknessLevel` is no longer a live
// INPUT to anything MSA computes).
export {
  readSceneDarkness,
  // THE ONE WRITE in the environment adapter (2026-08-15) — client-local,
  // never a document update. `shouldPublishDarkness` is exported alongside it
  // because the write is only safe throttled — `publishSceneDarkness` itself
  // ends in Foundry's own `refreshLighting + refreshVision`, which must not
  // fire every frame. See `publishSceneDarkness`'s own header.
  publishSceneDarkness,
  shouldPublishDarkness,
  DARKNESS_PUBLISH_STEP,
  DARKNESS_PUBLISH_MIN_INTERVAL_MS,
  deriveDarkness,
  readSceneAmbient,
  deriveAmbient,
  FOUNDRY_FALLBACK_AMBIENT,
  // THE GLOBAL ILLUMINATION WRITE-BACK (2026-08-15) — closes the SECOND,
  // independent gate `publishSceneDarkness` above cannot close alone:
  // Foundry's own `environment.globalLight.enabled` toggle, schema-default
  // false on every scene. Published IN `publishSceneDarkness`'s own call
  // (see its header) — a separate `publishGlobalLightWindow` existed briefly
  // and was removed the same day after a live probe caught it stomping the
  // darkness publish's own call, and vice versa.
  deriveGlobalLightWindow,
  shouldPublishGlobalLightWindow,
  readSceneGlobalLightRaw,
  GLOBAL_LIGHT_DAYLIGHT_MAX,
} from './scene-environment.js';

// THE GAME-TIME READER — feeds world/day-clock.js (the world clock, in `synced`
// mode) and core/frame-clock.js's pause ramp. READ-ONLY BY DESIGN: it exposes no
// way to write `game.time`, because V2's write-back-plus-listen pair was a
// feedback loop held together by a guard flag. See that module's own header.
export {
  readWorldTimeOfDay,
  readGamePaused,
  watchGamePaused,
  watchWorldTimeOfDay,
  deriveHourFromComponents,
  DEFAULT_CALENDAR_UNITS,
  RECONCILE_INTERVAL_MS,
} from './game-time.js';

// SKY PERSISTENCE — where the world sky and a scene's own sky are STORED.
// Per-world by default; a scene opts in to its own. `world/sky-settings.js`
// decides which one wins (purely, Node-tested); this only reads and writes.
export {
  registerSkySettings,
  readWorldSky,
  writeWorldSky,
  readSceneSky,
  writeSceneSky,
  setSceneSkyOverride,
  watchSceneSky,
  SKY_NAMESPACE,
} from './sky-persistence.js';

// FADE PERSISTENCE (docs/holy/UI-Testament.md §4.2, U2) — the one scene flag
// a fade's live state lives under. Decides nothing about curves or easing —
// world/fade-engine.js owns that, purely and Node-tested; this only reads
// and writes, mirroring sky-persistence.js's own shape.
export { readFadeState, writeFadeState, watchFadeState } from './fade-persistence.js';

// CUE PERSISTENCE (U3, docs/holy/UI-Testament.md §4.3) — one scene flag,
// the authored cue stack. core/cues-schema.js validates; this only reads
// and writes, mirroring fade-persistence.js's own shape.
export { readCueStack, writeCueStack, watchCueStack } from './cues-persistence.js';

// THE LIGHT-SOURCE READER — feeds light.accumulate's point-light illumination
// rung; the one place canvas.effects.lightSources is read. Also the scene's
// own Global Illumination config (canvas.scene.environment.globalLight) —
// verified against source to need separate handling from a point light (no
// wall-clipped circular geometry), so it raises the ambient FLOOR instead of
// joining the mesh pool — see scene-lights.js's own header.
export {
  readActiveLightSources,
  deriveLightSnapshot,
  readGlobalLightConfig,
  deriveGlobalLightConfig,
} from './scene-lights.js';

// THE INVERSE OF THE READER ABOVE — mirrors MSA's OWN candle/fire light
// descriptors INTO canvas.effects.lightSources (client-local, never a
// document write), so Foundry's native door-icon reveal / light-perception
// detection actually sees a candle-lit room as lit. See scene-synthetic-
// lights.js's own header for the full mechanism and why this is safe.
export {
  buildVisionLightData,
  diffVisionLightState,
  createSceneSyntheticLights,
  DETECTION_RADIUS_MULTIPLIER,
} from './scene-synthetic-lights.js';

// WALL-CLIPPED POLYGON FOR NON-DOCUMENT POINTS — the one place
// `CONFIG.Canvas.polygonBackends`/`canvas.scene.levels` are read to compute
// a wall-aware shape for a point that isn't a real Foundry document (candle
// lights, effects/candle-flame-render.js). Reuses Foundry's own
// ClockwiseSweepPolygon rather than a second hand-rolled wall-clipping
// algorithm — see scene-wall-clip.js's own header for the `level`
// requirement (a real Level document, never `canvas.level`).
export { buildCandleWallClipConfig, computeCandleWallClippedShape } from './scene-wall-clip.js';

// WALL SEGMENTS — the one place `canvas.scene.walls` is read as flat
// segments (as opposed to scene-wall-clip.js's per-point visibility sweep).
// Feeds Wind.md Tier 1's structure bake (world/wind-bake.js): a wall or a
// closed door blocks the wind field, an open door doesn't. `watchSceneWallStructure`
// is the matching write-side signal — the one place Wall CRUD hooks are
// subscribed, so a door toggling open/closed can trigger a rebake.
export {
  readSceneWallSegments,
  deriveWallSolid,
  deriveWallAperture,
  watchSceneWallStructure,
  watchDoorOpenings,
} from './scene-walls.js';

// THE DOOR READER — the one place a wall's DOOR GRAPHIC fields (texture,
// animation type/double/direction/strength/flip, open state) are read, for the
// door-graphics effect (effects/door-graphics.js). Distinct from the wind
// segment read above: that throws the texture/animation away, this keeps
// exactly it. `watchDoorGraphics` is the door-specific CRUD signal the runtime
// animates from.
export { readSceneDoors, deriveDoorSnapshot, normalizeDoorAnimationType, watchDoorGraphics } from './scene-doors.js';

// THE REGION READER — feeds effects/lighting/region-darkness.js's per-point
// darkness adjustment; the one place canvas.scene.regions (+ each region's
// own "Adjust Darkness Level" behavior) is read. `readSuppressWeatherStub` is
// a deliberate, documented no-op — see scene-regions.js's own header.
export { readActiveDarknessRegions, deriveRegionDarknessAdjuster, readSuppressWeatherStub } from './scene-regions.js';
export { readPaintContext, savePaintedMasks, loadPaintedMasks } from './paint-adapter.js';

// GRID-GEOMETRY READERS — feeds the masks.occlusion producer's RADIAL channel
// (distancePixels) and the point-light soft-edge margin (gridSizePixels); the
// one place canvas.dimensions.distancePixels / canvas.grid.size are read.
export {
  readGridDistancePixels,
  deriveDistancePixels,
  readGridSizePixels,
  deriveGridSizePixels,
  computeTokenOcclusionRadiusPx,
} from './scene-occlusion-sources.js';

// THE SETTINGS ADAPTER — the one place game.settings is touched (foundry/
// adapter-only). Registers/reads/writes the descriptors effects/effect-
// settings.js derives; knows nothing about effects itself.
export { registerSettings, readSetting, writeSetting } from './settings-adapter.js';

// THE TOKEN-VISION DIAGNOSTIC — answers "why can this token only see a point
// light?" by naming WHICH gate is failing (empty light mask vs inactive
// global illumination), because on screen those two are pixel-identical.
// Pure read; see the module header for the full mechanism.
export { readTokenVisionDiagnostic, REPORT_BUILD_TAG } from './vision-diagnostics.js';

// THE VISION-SOURCE READER — slice 1 of "MSA owns vision/fog" (Testament
// Pillar 11, docs/planning/Vision-Fog-Ownership.md). CONSUMES Foundry's own
// wall-sweep polygons; never reproduces the vision ruleset, which is what
// keeps this compatible with any game system. Nothing renders from it yet.
export {
  readActiveVisionSources,
  deriveVisionSource,
  isUsablePolygon,
  shouldGateVision,
  readIsGM,
  MIN_POLYGON_FLOATS,
} from './scene-vision.js';

// V2 → V3 ANCHOR IMPORT — reads a scene's legacy `mapPointGroups` flags and
// produces V3 anchor candidates (the Map Points successor). Boot hands them to
// scene/anchor-authority.js. A leaf: it knows no anchor kinds — boot injects the
// V2 effectTarget → kind mapping (dependency inversion, like the mask authority).
export { importV2Anchors, detectV2MapPoints, V2_IMPORT_SENTINEL } from './v2-anchor-import.js';

// AUTHORED ANCHORS — the write side of the same story: added/edited/removed
// anchors (candles today), persisted as a small diff on the scene, the same
// embed-in-flag pattern paint-adapter.js uses for masks. Boot merges this with
// a fresh V2 import every scene load (scene/anchor-authority.js#mergeAnchorSources).
export { saveAuthoredAnchors, loadAuthoredAnchors } from './anchor-adapter.js';

// THE CAMERA-PATH TOOL (2026-07-21, author request) — the revived V2
// camera-pass recorder, rebuilt to sequence Foundry's OWN `canvas.animatePan`
// rather than reimplementing an interpolator. `camera-path.js` is the pure
// timeline/easing half (Node-tested); these are the live glue.
export {
  captureCurrentView,
  previewCameraKeyframe,
  saveCameraPath,
  loadCameraPathRaw,
  playCameraPath,
  stopCameraPath,
  isCameraPathPlaying,
  isCameraPathPlayingCapped,
  generatePresetKeyframes,
} from './camera-path-player.js';
export {
  normalizeCameraPath,
  normalizeKeyframe,
  buildCameraTimeline,
  totalTimelineDurationMs,
  CAMERA_PATH_PRESETS,
  DEFAULT_SETTINGS as CAMERA_PATH_DEFAULT_SETTINGS,
} from './camera-path.js';

// TILE MOTION (2026-08-27, V2 port + replan) — GM-authored rotate/orbit/
// pingPong/sine/texture-scroll motion for tiles. `tile-motion.js` is the pure
// rigid-transform math (Node-tested); `tile-motion-runtime.js` is the live
// glue (per-tile + scene flags, hooks, the one per-frame resolve the render
// side calls). Every mutation below is the extension seam for a future
// non-GM trigger source (see tile-motion-runtime.js's own header) — nothing
// else has private access these don't.
export {
  MOTION_TYPES as TILE_MOTION_TYPES,
  ROTATION_EASING_TYPES as TILE_MOTION_ROTATION_EASING_TYPES,
  normalizeTileMotionConfig,
  normalizeTransportState as normalizeTileMotionTransport,
  worldPointToLocalPivot as tileMotionWorldPointToLocalPivot,
} from './tile-motion.js';
export {
  initializeTileMotionRuntime,
  disposeTileMotionRuntime,
  resolveTileMotionFrame,
  setTileEditSuppressed as setTileMotionEditSuppressed,
  getTileMotionTileList,
  getTileMotionConfig,
  getTileMotionTransportState,
  getTileMotionRestPose,
  getTileMotionRuntimeStatus,
  getTileMotionSummary,
  setTileMotionConfig,
  startTileMotion,
  stopTileMotion,
  pauseTileMotion,
  resumeTileMotion,
  resetTileMotionPhase,
  setTileMotionSpeedPercent,
  setTileMotionTimeFactorPercent,
  setTileMotionAutoPlayEnabled,
  activateTileMotionNativeTool,
  watchTileMotionSelection,
} from './tile-motion-runtime.js';

// THE SCENE-CONTROLS (left palette) TOGGLES — one per room. The old panel's
// own `map-shine-advanced` toggle (registerControlPanelButton/
// syncControlPanelButtonState) was deleted in the UI parity plan's phase 7b,
// alongside the panel itself.
// THE ANCHOR VIEW TOGGLE — a GM-only tool that opens ui/anchor-view-mode.js
// (see scene-controls-button.js's own doc).
export { registerAnchorViewModeButton, syncAnchorViewModeButtonState } from './scene-controls-button.js';
// THE STUDIO TOGGLE (U1) — a GM-only tool that opens the new LANTERN Studio
// (see scene-controls-button.js's own doc for why this is the same proven
// mechanism as Anchor View above).
export { registerStudioButton, syncStudioButtonState } from './scene-controls-button.js';
// THE REMOTE TOGGLE (U2) — a fourth, GM-only tool that opens the new
// LANTERN Remote side-by-side with the panel/Studio (see scene-controls-
// button.js's own doc for why this is the same proven mechanism, a fourth time).
export { registerRemoteButton, syncRemoteButtonState } from './scene-controls-button.js';
// THE PLAYER TOGGLE (U5) — a fifth tool, visible:true like the ORIGINAL
// panel button (never GM-only — see scene-controls-button.js's own doc for
// why this one differs from Anchor View/Studio/Remote's own gating).
export { registerPlayerButton, syncPlayerButtonState } from './scene-controls-button.js';

// THE SCENE EXPORTER (2026-08-10, author directive) — the one human-operated
// bridge to an assistant working on a SEPARATE, disposable bench world: the
// active scene's Levels/Tiles/Walls/AmbientLights/Regions plus MSA's own
// scene-flag payloads, as one portable file. Never touches a second world
// itself — it only ever reads the author's own active scene. See
// scene-export.js's own header for the full reasoning.
export {
  buildLiveSceneExport,
  buildSceneExportPayload,
  collectExportTexturePaths,
  sceneExportFilename,
} from './scene-export.js';

// THE CALENDAR INSTALLER (docs/holy/Almanac-Testament.md, stage A1) — builds
// and installs the active CalendarData into CONFIG.time. Takes the calendar
// DATA REGISTRY as an argument (world/index.js's own door) rather than
// importing world/ itself — see calendar-install.js's own header for why.
export { registerCalendarSetting, installActiveCalendar } from './calendar-install.js';

// THE COMBAT-STATE READER (Almanac Testament, stage A2) — the Pen's
// "combat holds the pen" gate.
export { readCombatActive } from './combat-state.js';

// THE PF2E DARKNESS STAND-DOWN (Almanac Testament §6.4, stage A2) — detects
// PF2E's own darkness-sync on the active scene and, GM-gated, retires it so
// MSA's own darkness publish (scene-environment.js, already LIVE) is the
// one writer.
export {
  readPf2eDarknessSyncStatus,
  standDownPf2eDarknessSync,
  isPf2eDarknessSyncActive,
} from './pf2e-darkness-standdown.js';

// THE PEN (Almanac Testament §6, stage A2) — the only place
// `game.time.advance()` is called. `advance` takes the resolved Almanac
// posture as an argument (boot.js's own `skyScope`) rather than resolving it
// itself — `foundry/` cannot import `world/sky-settings.js#resolveSky`, the
// same leaf-boundary reason `calendar-install.js` already documents.
export { advance, isPenArmed, getAdvanceAuditLog, jumpToHour, advanceDays, advanceWeeks } from './time-authority.js';

// THE ALMANAC DIAGNOSTIC REPORT (stage A2, the author's own ask 2026-08-17)
// — one object covering every open exit-gate question this Testament stage
// can be asked live. See almanac-diagnostics.js's own header for why it
// takes so much as arguments.
export { buildAlmanacDiagnosticsReport } from './almanac-diagnostics.js';
