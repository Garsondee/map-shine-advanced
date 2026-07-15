/**
 * Shared Three.js layer constants for renderer/compositor systems.
 *
 * Kept outside EffectComposer so scene managers and V2 pipeline code do not
 * need to import V1 orchestration modules just to access layer IDs.
 */

export const BLOOM_HOTSPOT_LAYER = 30;
export const OVERLAY_THREE_LAYER = 31;

/**
 * Bush/tree canopy overlays: excluded from the bus albedo draw (layers 0–19) and
 * composited after WaterEffectV2 so water tint/specular never paints over vegetation.
 */
export const VEGETATION_ABOVE_WATER_LAYER = 32;

/**
 * WaterSplashesEffectV2 batches: drawn after the water post pass, before vegetation.
 */
export const WATER_SPLASH_ABOVE_WATER_LAYER = 33;

/**
 * Layer for floor-agnostic world objects that should render once per frame
 * outside per-floor passes.
 */
export const GLOBAL_SCENE_LAYER = 29;

/** Rope meshes write to this layer when sampling rope masks. */
export const ROPE_MASK_LAYER = 25;

export const TILE_FEATURE_LAYERS = {
  CLOUD_SHADOW_BLOCKER: 23,
  CLOUD_TOP_BLOCKER: 24,
};
