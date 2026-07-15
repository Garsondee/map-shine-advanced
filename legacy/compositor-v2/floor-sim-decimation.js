/**
 * Helpers for post-level-change compositor hygiene (mask preload backoff).
 *
 * @module compositor-v2/floor-sim-decimation
 */

/**
 * @returns {boolean} True while floor-mask preload should stay idle after a level switch.
 */
export function isFloorPreloadSuppressedAfterLevelChange() {
  try {
    const until = Number(window.MapShine?.__msaSuppressFloorPreloadUntilMs) || 0;
    return until > 0 && performance.now() < until;
  } catch (_) {
    return false;
  }
}

/**
 * @param {number} [durationMs=10000]
 */
export function suppressFloorPreloadAfterLevelChange(durationMs = 10000) {
  try {
    const ms = window.MapShine ?? (window.MapShine = {});
    const dur = Number.isFinite(Number(durationMs)) && Number(durationMs) > 0
      ? Number(durationMs)
      : 10000;
    ms.__msaSuppressFloorPreloadUntilMs = performance.now() + dur;
  } catch (_) {}
}
