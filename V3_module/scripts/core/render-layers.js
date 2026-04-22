/**
 * Shared Three.js layer constants for renderer/compositor systems.
 *
 * Kept outside EffectComposer so scene managers and V2 pipeline code do not
 * need to import V1 orchestration modules just to access layer IDs.
 */

export const BLOOM_HOTSPOT_LAYER = 30;
export const OVERLAY_THREE_LAYER = 31;

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
