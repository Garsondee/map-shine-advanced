/**
 * THE DOOR to scene/ — the scene model's public surface: the sort law, the
 * occlusion model, world-quad geometry, and the mask authority (the single
 * source of truth for authored + derived content masks). Internals (the
 * renderer's plumbing) stay unimportable from other zones.
 *
 * `occlusion-mask.js`'s throwing seam door is GONE (2026-07-18): a real
 * (RADIAL-only) producer lives in vt-pan-viewer.js now — see
 * graph/passes.js's masks.occlusion note for the honest scope.
 */
export {
  SORT_LAYERS,
  makeLayerKey,
  compareLayerKeys,
  sortByLayer,
  isInForeground,
  resolveElevationFloorIndex,
} from './layer-order.js';
export {
  OCCLUSION_MODES,
  packOcclusionModes,
  computeOcclusionState,
  mapElevation,
  buildElevationTable,
} from './occlusion.js';
export {
  computeCameraFrustum,
  worldToNdc,
  ndcToWorld,
  clientToNdc,
  ndcToPixel,
  computeItemViewportPx,
} from './world-quad.js';

// THE MASK AUTHORITY (scene/mask-authority.js's header is the map). The
// catalog is the ONLY legal home of mask suffix knowledge — the
// `masks/authority-only` tripwire enforces that; consumers import it from here.
export {
  MASK_KINDS,
  DERIVED_KINDS,
  PACKED_TRIO_LAYER_NAME,
  validateMaskCatalog,
  maskKindById,
  derivedKindById,
  assembleLayerDescriptors,
  extractionPlanForLayer,
} from './mask-catalog.js';
export { createMaskAuthority, RequiredMaskMissingError } from './mask-authority.js';
// THE SKY-REACH SERVICE (scene/sky-reach-access.js's header is the map) — the
// ONE door for "what is between this point and the open sky?", shared by cast
// shadows now and rain when it lands. Author's own instruction, 2026-07-24:
// sky-reach has to be an API, not a grid five consumers each sample differently.
export { createSkyReachAccess, COVERED_THRESHOLD } from './sky-reach-access.js';

// THE ANCHOR CATALOG + AUTHORITY (scene/anchor-catalog.js's header is the map):
// the "place" sibling of the mask authority's "paint" — discrete point effects
// (a candle flame) as the successor to V2's Map Points. The catalog is the ONLY
// home of the V2 effectTarget → anchor kind mapping the importer relies on.
export {
  ANCHOR_KINDS,
  validateAnchorCatalog,
  anchorKindById,
  anchorKindsForEffect,
  anchorKindByV2EffectTarget,
} from './anchor-catalog.js';
export { createAnchorAuthority, mergeAnchorSources, nearestAnchor } from './anchor-authority.js';
export { MASK_GRID_MAX_DIM, computeMaskGridSpec, sampleMaskGridWorld, maskGridMean } from './mask-derive.js';
export {
  createPaintLayer,
  stampBrushWorld,
  rasterizePolygon,
  rasterizeStrokedLine,
  isPaintLayerEmpty,
  encodePaintLayer,
  decodePaintLayer,
  encodedByteEstimate,
  serializePaintedMasks,
  hydratePaintedMasks,
  PAINT_EMBED_BYTE_BUDGET,
  PAINT_GRID_MAX_DIM,
} from './paint-mask.js';
