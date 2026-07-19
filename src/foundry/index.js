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
} from './active-scene-source.js';

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
export { collectSceneLayers, computeItemPlacement, SCENE_LAYER_DOCUMENTS, floorCeilings } from './scene-layers.js';

// Authored-mask file discovery (listing-first, probe fallback) — feeds the
// mask authority (scene/mask-authority.js#setDiscovery); nothing else reads it.
export { discoverAuthoredMasks } from './mask-discovery.js';

// Token documents -> drawables.
export { collectTokens, diagnoseTokens, TOKEN_DOCUMENTS, tokenFootprint } from './scene-tokens.js';

// VRAM severance — feed PIXI <=1024px proxies so Foundry never decodes the real file.
export { registerPixiProxy, getPixiResidencyReport } from './pixi-proxy-textures.js';

// THE INTERFACE SEAM — MSA owns the art, PIXI keeps the interactive chrome.
export {
  registerCanvasCompositing,
  applyArtSuppression,
  restoreFoundryArt,
  getCanvasCompositingReport,
  decideArtSuppression,
  MSA_OWNED_GROUPS,
} from './canvas-compositing.js';

// THE BLANK-CANVAS WATCHDOG — detects a canvasTearDown that nothing follows
// (Scene#unview(), the active scene being deleted), which canvasInit/
// canvasReady alone can never see.
export { registerCanvasTearDownWatchdog, isOrphanedTeardown } from './canvas-lifecycle.js';

// THE SCENE-ENVIRONMENT READER — feeds world/environment.js#buildEnvSnapshot's
// `darknessInput` + `ambientInput`; the one place canvas.scene.environment
// .darknessLevel and the canvas.colors ambient palette are read.
export {
  readSceneDarkness,
  deriveDarkness,
  readSceneAmbient,
  deriveAmbient,
  FOUNDRY_FALLBACK_AMBIENT,
} from './scene-environment.js';

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
