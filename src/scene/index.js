/**
 * THE DOOR to scene/ — the scene model's public surface: the sort law, the
 * occlusion model + its (unbuilt) producer door, world-quad geometry.
 * Internals (the renderer's plumbing) stay unimportable from other zones.
 */
export { SORT_LAYERS, makeLayerKey, compareLayerKeys, sortByLayer, isInForeground } from './layer-order.js';
export { OCCLUSION_MODES, packOcclusionModes, computeOcclusionState, mapElevation } from './occlusion.js';
export { buildOcclusionMaskPass } from './occlusion-mask.js';
export { computeCameraFrustum, worldToNdc, computeItemViewportPx } from './world-quad.js';
