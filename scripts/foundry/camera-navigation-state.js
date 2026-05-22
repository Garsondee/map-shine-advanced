/**
 * Shared signal for "user is panning/zooming the scene camera".
 * Used to skip hover raycasts, decorative effect simulation, and DOM layout work.
 *
 * Camera Path playback must NOT register as navigation — the render loop uses
 * the cinematic presentation tier during paths, and FloorCompositor treats
 * navigation as a signal to zero delta and skip cloud/weather/shadow sim.
 *
 * @module foundry/camera-navigation-state
 */

/** @returns {boolean} True while Camera Path or an environment ramp owns the scene clock. */
function isCameraPathPlaybackSimActive() {
  try {
    if (window.MapShine?.environmentControlApi?.isExternallyDriven?.()) return true;
    const cps = window.MapShine?.cameraPathService;
    if (cps?.isPlaying === true) return true;
    if (cps?.animator?.isActive === true) return true;
  } catch (_) {}
  return false;
}

/**
 * @returns {boolean}
 */
export function isCameraNavigationActive() {
  try {
    if (isCameraPathPlaybackSimActive()) return false;

    if (window.MapShine?.pixiInputBridge?.isCameraPanActive?.()) return true;
    const tier = window.MapShine?.__presentationState?.tier;
    // 'cinematic' is render-loop pacing for camera paths — not user navigation.
    if (tier === 'active') return true;
  } catch (_) {}
  return false;
}
