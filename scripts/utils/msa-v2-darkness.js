/**
 * Map Shine + Compositor V2 — scene darkness policy (regression guard, 2026-03).
 *
 * **Grey canvas:** Repeated or stacked `canvas.scene.update({ environment.darknessLevel })`
 * (time slider, `updateScene` resync, weather snapshot) destabilized the V2 WebGL path.
 *
 * **Stale sky/fog:** `WeatherController` static fast-path skips `_updateEnvironmentOutputs()`
 * after `_staticSnapped`; any external change to `timeOfDay` must clear that flag (see `setTime`).
 *
 * **V14 getter trap (2026-05):** `canvas.environment.darknessLevel` is a *getter only* in
 * V14 (it was a setter pair in V11/V12). Direct assignment such as
 * `canvas.environment.darknessLevel = X` silently fails, so the cached value
 * that Foundry's lighting layer, `AmbientLight._initializeLightSource`,
 * `EffectsCanvasGroup.getDarknessLevel`, and darkness-gated vision modes
 * actually read NEVER updates during a Map Shine time transition. Symptom:
 * the entire scene snaps from night to day at the end of the transition once
 * some downstream path finally calls `initialize()`. The fix is to call
 * `canvas.environment.initialize({ environment: { darknessLevel: X } })` —
 * the canonical V14 local-only setter — every time we push a new value.
 *
 * **Darkness-gated lights / vision (2026-05):** Bypassing `scene.update` means
 * `Scene._onUpdate` never fires, so Foundry never receives the perception
 * `initializeLightSources` / `initializeVision` flags that re-evaluate each
 * `AmbientLight`'s `darkness.min`/`darkness.max` activation range against the
 * new scene darkness. The `initialize()` call above does most of the heavy
 * lifting, but we still raise the perception flags explicitly as belt-and-
 * suspenders so light activation toggles in lock-step with the ramp.
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
    // V14 canonical local-only darkness setter. This updates the internal
    // `_darknessLevel` cache backing the `darknessLevel` getter, recomputes
    // ambient colors / weights, fires `configureCanvasEnvironment`, and
    // schedules lighting / vision refresh. Without this, lights gated on
    // darkness ranges, ambient illumination, and vision-mode darkness gates
    // all hold their previous-frame state for the whole transition because
    // they read via `canvas.environment.darknessLevel` (getter → cache),
    // not from `canvas.scene.environment.darknessLevel` (document data).
    if (typeof canvas?.environment?.initialize === 'function') {
      canvas.environment.initialize({ environment: { darknessLevel: clamped } });
    } else if (canvas?.environment && typeof canvas.environment === 'object') {
      // Fallback for pre-V14 builds that exposed a real setter.
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
 * Last darkness level for which we asked Foundry to re-evaluate darkness-gated
 * light / vision activation. Used to avoid spamming `initializeLightSources`
 * (which iterates every `AmbientLight` / `VisionSource` on the canvas) when
 * darkness has not meaningfully moved.
 *
 * @type {number|null}
 */
let _lastPerceptionDarknessNotified = null;

/**
 * Minimum darkness delta (0..1) between perception re-initializations.
 *
 * Foundry's stock animator effectively re-initializes per animation step, but
 * we only need to cross light `darkness.min`/`darkness.max` thresholds in a
 * visually smooth way. Time-of-day transitions can run 1..60min so 0.002 keeps
 * activation toggling responsive (< ~3 minutes of in-game noon→midnight ramp)
 * without firing on every 100ms tick when nothing materially changed.
 *
 * @type {number}
 */
const PERCEPTION_DARKNESS_DELTA_THRESHOLD = 0.002;

/**
 * Notify Foundry's perception manager that scene darkness has changed so it
 * re-initializes darkness-gated `AmbientLight` and vision sources.
 *
 * Normally fired implicitly by `Scene._onUpdate({ environment.darknessLevel })`;
 * Map Shine writes darkness through `updateSource` (see grey-canvas note above),
 * so we re-issue the relevant flags ourselves. The PerceptionManager batches
 * flags until the next frame, so calling this every 100ms is cheap.
 *
 * @param {number} level 0..1 — the just-applied darkness level
 * @param {{ force?: boolean }} [opts]
 * @returns {boolean} true when a perception update was queued
 */
export function notifyPerceptionDarknessChange(level, opts = {}) {
  const v = Number(level);
  if (!Number.isFinite(v)) return false;

  const clamped = Math.max(0, Math.min(1, v));
  const force = opts?.force === true;

  if (!force && _lastPerceptionDarknessNotified !== null) {
    if (Math.abs(_lastPerceptionDarknessNotified - clamped) < PERCEPTION_DARKNESS_DELTA_THRESHOLD) {
      return false;
    }
  }

  try {
    if (canvas?.perception?.update) {
      canvas.perception.update({
        initializeLightSources: true,
        initializeVision: true,
        refreshLighting: true,
        refreshVision: true
      });
      _lastPerceptionDarknessNotified = clamped;
      return true;
    }
  } catch (_) {
    // Perception manager may briefly be unavailable mid-redraw; the next
    // darkness push will retry.
  }
  return false;
}

/**
 * Reset the darkness-change debounce. Call on canvas tearDown / redraw so the
 * first push after the canvas is re-ready always re-initializes sources.
 */
export function resetPerceptionDarknessNotifier() {
  _lastPerceptionDarknessNotified = null;
}

/**
 * Apply local runtime scene darkness for Map Shine time / snapshot restore.
 * Mutates `canvas.environment` / `canvas.scene.environment` only (no DB round-trip).
 *
 * @param {number} level 0..1
 * @returns {Promise<void>}
 */
export async function mapShinePushSceneDarknessLevel(level) {
  const v = Number(level);
  if (!Number.isFinite(v) || !canvas?.scene) return;
  const pending = Math.max(0, Math.min(1, v));
  // V14: scene.update({ environment.darknessLevel }) can trigger full same-scene
  // canvas redraws. For time-of-day driven darkness, we only need an immediate
  // local visual update; persistence already flows through Map Shine control flags.
  applySceneDarknessLocalOnly(pending);

  // Keep the Scene document instance locally aligned without forcing a network
  // document update / draw cycle.
  try {
    if (typeof canvas.scene.updateSource === 'function') {
      canvas.scene.updateSource({ environment: { darknessLevel: pending } });
    }
  } catch (_) {}

  // Re-evaluate darkness-gated `AmbientLight` / vision activation. Without
  // this, lights configured to activate within a darkness range only toggle
  // at the end of a time-of-day transition (when something else happens to
  // trigger `initializeLightSources` — e.g. the final `setFlag` echo).
  notifyPerceptionDarknessChange(pending);
}
