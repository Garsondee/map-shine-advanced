/**
 * How long {@link refreshMsaSameSceneRedrawPredict} stays armed after live weather drags / flag writes.
 * Must cover debounced snapshot save (~1s) + server RTT + delayed `canvas.draw` → `tearDown`.
 */
export const MSA_SAME_SCENE_REDRAW_PREDICT_MS = 8000;

/**
 * Arms {@link window.MapShine.__msaPredictSameSceneRedrawUntil} so `Canvas#tearDown` can skip the
 * "Switching scenes…" path while Foundry redraws after weather/control scene flags (echo shape varies).
 * Safe to call frequently (e.g. every live rain slider `input`).
 *
 * @param {number} [ms]
 */
export function refreshMsaSameSceneRedrawPredict(ms = MSA_SAME_SCENE_REDRAW_PREDICT_MS) {
  try {
    if (!window.MapShine) window.MapShine = {};
    const sid = typeof canvas !== 'undefined' && canvas?.scene?.id;
    if (sid == null) return;
    window.MapShine.__msaPredictSameSceneRedrawUntil = performance.now() + Math.max(500, ms);
    window.MapShine.__msaPredictSameSceneRedrawSceneId = String(sid);
  } catch (_) {}
}

/**
 * Short window after Map Shine writes scene flags from this client. Used so
 * `updateScene` can skip re-applying controlState / weather-snapshot when Foundry
 * omits userId on the hook or the echo would stack applyTimeOfDay / darkness updates.
 *
 * @param {number} [ms=2200]
 */
export function extendMsaLocalFlagWriteGuard(ms = 2200) {
  try {
    if (window.MapShine) {
      window.MapShine._msaLocalFlagWriteGuardUntil = performance.now() + Math.max(500, ms);
    }
  } catch (_) {
  }
  refreshMsaSameSceneRedrawPredict();
}
