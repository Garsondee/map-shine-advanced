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

/** PixiInputBridge is exposed as `cameraController` during scene init; prefer either alias. */
function getPixiInputBridge() {
  try {
    const ms = window.MapShine;
    return ms?.pixiInputBridge ?? ms?.cameraController ?? null;
  } catch (_) {}
  return null;
}

/**
 * @returns {boolean}
 */
export function isCameraNavigationActive() {
  try {
    if (isCameraPathPlaybackSimActive()) return false;

    const bridge = getPixiInputBridge();
    // Pan/zoom gesture only — do not key off presentation tier ('active' is high-FPS present mode, not pan).
    if (bridge?.isCameraPanActive?.()) return true;
    if (bridge?.isUserActivelyPanning?.()) return true;
  } catch (_) {}
  return false;
}
