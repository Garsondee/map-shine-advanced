/**
 * Map Shine + Compositor V2 — scene darkness policy (regression guard, 2026-03).
 *
 * **Grey canvas:** Repeated or stacked `canvas.scene.update({ environment.darknessLevel })`
 * (time slider, `updateScene` resync, weather snapshot) destabilized the V2 WebGL path.
 *
 * **Stale sky/fog:** `WeatherController` static fast-path skips `_updateEnvironmentOutputs()`
 * after `_staticSnapped`; any external change to `timeOfDay` must clear that flag (see `setTime`).
 *
 * **Rule:** All Map Shine–driven darkness writes from simulated time MUST go through
 * `mapShinePushSceneDarknessLevel()`. Do not add new `scene.update({ environment })` calls
 * for clock/darkness sync without updating this module.
 *
 * @param {number} level 0..1
 * @returns {boolean} true if local fields were written
 */
export function applySceneDarknessLocalOnly(level) {
  const v = Number(level);
  if (!Number.isFinite(v)) return false;
  const clamped = Math.max(0, Math.min(1, v));
  try {
    if (canvas?.environment && typeof canvas.environment === 'object') {
      canvas.environment.darknessLevel = clamped;
    }
    const se = canvas?.scene?.environment;
    if (se && typeof se === 'object') {
      se.darknessLevel = clamped;
    }
    return true;
  } catch (_) {
    return false;
  }
}

/** @returns {boolean} */
export function isMapShineV2CanvasActive() {
  try {
    return window.MapShine?.__v2Active === true;
  } catch (_) {
    return false;
  }
}

/**
 * Apply scene darkness for Map Shine time / snapshot restore (GM session state).
 * V2: mutates `canvas.environment` / `canvas.scene.environment` only (no DB round-trip).
 * Non-V2: persists via Foundry `scene.update`.
 *
 * @param {number} level 0..1
 * @returns {Promise<void>}
 */
export async function mapShinePushSceneDarknessLevel(level) {
  const v = Number(level);
  if (!Number.isFinite(v) || !canvas?.scene) return;
  const pending = Math.max(0, Math.min(1, v));
  if (isMapShineV2CanvasActive()) {
    applySceneDarknessLocalOnly(pending);
    return;
  }
  await canvas.scene.update({ 'environment.darknessLevel': pending });
}
