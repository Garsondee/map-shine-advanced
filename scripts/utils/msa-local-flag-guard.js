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
}
