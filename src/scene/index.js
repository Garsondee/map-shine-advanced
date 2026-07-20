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
export { SORT_LAYERS, makeLayerKey, compareLayerKeys, sortByLayer, isInForeground } from './layer-order.js';
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
export { createMaskAuthority } from './mask-authority.js';
export { MASK_GRID_MAX_DIM, computeMaskGridSpec, sampleMaskGridWorld, maskGridMean } from './mask-derive.js';
export {
  createPaintLayer,
  stampBrushWorld,
  isPaintLayerEmpty,
  encodePaintLayer,
  decodePaintLayer,
  encodedByteEstimate,
  serializePaintedMasks,
  hydratePaintedMasks,
  PAINT_EMBED_BYTE_BUDGET,
  PAINT_GRID_MAX_DIM,
} from './paint-mask.js';
