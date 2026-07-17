/**
 * THE DOOR to scene/ — the scene model's public surface: the sort law, the
 * occlusion model + its (unbuilt) producer door, world-quad geometry, and the
 * mask authority (the single source of truth for authored + derived content
 * masks). Internals (the renderer's plumbing) stay unimportable from other zones.
 */
export { SORT_LAYERS, makeLayerKey, compareLayerKeys, sortByLayer, isInForeground } from './layer-order.js';
export { OCCLUSION_MODES, packOcclusionModes, computeOcclusionState, mapElevation } from './occlusion.js';
export { buildOcclusionMaskPass } from './occlusion-mask.js';
export { computeCameraFrustum, worldToNdc, computeItemViewportPx } from './world-quad.js';

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
