/**
 * Shared signal for "user is panning/zooming the scene camera".
 * Used to skip hover raycasts, decorative effect simulation, and DOM layout work.
 *
 * @module foundry/camera-navigation-state
 */

/**
 * @returns {boolean}
 */
export function isCameraNavigationActive() {
  try {
    if (window.MapShine?.pixiInputBridge?.isCameraPanActive?.()) return true;
    const tier = window.MapShine?.__presentationState?.tier;
    if (tier === 'active' || tier === 'cinematic') return true;
  } catch (_) {
  }
  return false;
}
