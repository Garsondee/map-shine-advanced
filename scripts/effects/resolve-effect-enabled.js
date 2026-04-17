/**
 * @fileoverview Unified effect enablement resolver.
 *
 * Replaces the scattered `effect?.enabled && effect?.params?.enabled !== false`
 * pattern with a single deterministic function. Every render pass gate in
 * FloorCompositor and every continuous-render check must call this instead of
 * inlining its own variation.
 *
 * The resolver normalizes three sources of truth:
 *   1. `effect.enabled` — runtime instance flag (set by graphics settings toggle)
 *   2. `effect.params.enabled` — scene-flag-driven parameter
 *   3. Graphics settings client override (localStorage)
 *
 * Rule: an effect renders if and only if ALL enabled sources agree it should.
 * Disabled effects MUST NOT render, even if data/uniforms exist.
 *
 * @module effects/resolve-effect-enabled
 */

/**
 * Determine the effective enabled state for a compositor effect.
 *
 * @param {Object|null|undefined} effect - The effect instance to evaluate.
 * @returns {boolean} True if the effect should be active this frame.
 */
export function resolveEffectEnabled(effect) {
  if (!effect) return false;

  // Gate 1: runtime instance flag
  if (effect.enabled === false) return false;

  // Gate 2: scene-flag-driven params (most effects store enable here)
  if (effect.params?.enabled === false) return false;

  return true;
}

/**
 * Determine if a mask-driven bus overlay effect is effectively enabled
 * AND has visible overlays worth rendering.
 *
 * @param {Object|null|undefined} effect
 * @returns {boolean}
 */
export function resolveOverlayEffectActive(effect) {
  if (!resolveEffectEnabled(effect)) return false;
  // Overlay effects expose _overlays (Map or Set) populated by FloorRenderBus
  const overlays = effect?._overlays;
  if (overlays && (typeof overlays.size === 'number') && overlays.size > 0) return true;
  return false;
}

/**
 * Determine if a particle/floor-based effect is effectively enabled
 * AND has active floors worth rendering.
 *
 * @param {Object|null|undefined} effect
 * @returns {boolean}
 */
export function resolveFloorEffectActive(effect) {
  if (!resolveEffectEnabled(effect)) return false;
  const floors = effect?._activeFloors;
  if (floors && (typeof floors.size === 'number') && floors.size > 0) return true;
  return false;
}
