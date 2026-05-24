/**
 * @fileoverview LightingDirector — single source of truth for scene darkness,
 * time of day, sun direction, and ambient endpoints.
 *
 * Before this module, `LightingEffectV2` and `SkyColorEffectV2` each independently
 * merged Foundry's `canvas.scene.environment.darknessLevel`, Map Shine's calendar
 * darkness curve (`computeTimeOfDayDarkness01`), and the {@link WeatherController}
 * `effectiveDarkness` via private `Math.max(...)` chains. The result was that
 * shaders could disagree about how dark the scene is, and dragging the Foundry
 * scene darkness slider sometimes had no visible effect because a higher calendar
 * value clobbered it.
 *
 * `LightingDirector` evaluates all of those sources **once per frame** in CPU
 * code and exposes a frozen output object that every lighting/sky/water consumer
 * can read. The module setting `darknessPriority` controls how the sources are
 * combined.
 *
 * Outputs are intentionally narrow:
 *   - `masterDarkness`: 0..1, the single canonical darkness value
 *   - `calendarDayWeight`: 0..1, daylight gating from `getFoundrySunlightFactor`
 *   - `hour`: 0..24, Map Shine time of day (or Foundry phase when linked)
 *   - `sunAzDeg` / `sunElDeg`: solar angles for shadow / specular consumers
 *
 * @module core/LightingDirector
 */

import { createLogger } from './log.js';
import {
  computeTimeOfDayDarkness01,
  getFoundryTimePhaseHours,
  getFoundrySunlightFactor,
} from './foundry-time-phases.js';
import { computeSunAnglesFromHour } from '../compositor-v2/shadow-system/SunDirection.js';

const log = createLogger('LightingDirector');

const MODULE_ID = 'map-shine-advanced';
const SETTING_DARKNESS_PRIORITY = 'lightingDarknessPriority';
const SETTING_FADE_CHUNK_LEG_SECONDS = 'environmentFadeChunkLegSeconds';
const SETTING_FADE_CHUNK_SETTLE_MS = 'environmentFadeChunkSettleMs';
const SETTING_FADE_CHUNK_MIN_HOUR_DELTA = 'environmentFadeChunkMinHourDelta';

/**
 * How to merge the three darkness inputs (Foundry slider, calendar, weather).
 *
 * - `max` (default, legacy behaviour): `Math.max(foundry, calendar, weather)`
 * - `foundrySlider`: only `canvas.scene.environment.darknessLevel`
 * - `calendar`: only `computeTimeOfDayDarkness01(hour)`
 * - `weather`: only `weatherController.getEnvironment().effectiveDarkness`
 *
 * @type {Readonly<Record<string, string>>}
 */
export const DARKNESS_PRIORITY = Object.freeze({
  MAX: 'max',
  FOUNDRY: 'foundrySlider',
  CALENDAR: 'calendar',
  WEATHER: 'weather',
});

const DARKNESS_PRIORITY_CHOICES = Object.freeze({
  [DARKNESS_PRIORITY.MAX]: 'Max of all sources (legacy)',
  [DARKNESS_PRIORITY.FOUNDRY]: 'Foundry scene slider only',
  [DARKNESS_PRIORITY.CALENDAR]: 'Calendar / time-of-day only',
  [DARKNESS_PRIORITY.WEATHER]: 'Weather controller only',
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * @typedef {object} LightingDirectorState
 * @property {number} masterDarkness Canonical 0..1 scene darkness for the frame.
 * @property {number} calendarDayWeight Daylight gate from sunlight factor (0..1).
 * @property {number} hour Resolved time of day in 0..24 hours, or NaN.
 * @property {number} sunAzDeg Sun azimuth in degrees.
 * @property {number} sunElDeg Sun elevation in degrees.
 * @property {number} foundryDarkness Raw Foundry input (for diagnostics).
 * @property {number} calendarDarkness Raw calendar input (for diagnostics).
 * @property {number} weatherDarkness Raw weather input (for diagnostics).
 * @property {string} priority Active merge mode (one of {@link DARKNESS_PRIORITY}).
 * @property {number} frameId Monotonic counter, increments on every `update()`.
 */

/**
 * Empty/neutral state used before the first `update()` call.
 * @type {LightingDirectorState}
 */
const NEUTRAL_STATE = Object.freeze({
  masterDarkness: 0,
  calendarDayWeight: 1,
  hour: 12,
  sunAzDeg: 180,
  sunElDeg: 60,
  foundryDarkness: 0,
  calendarDarkness: 0,
  weatherDarkness: 0,
  priority: DARKNESS_PRIORITY.MAX,
  frameId: 0,
});

class LightingDirectorImpl {
  constructor() {
    /** @type {LightingDirectorState} */
    this._state = NEUTRAL_STATE;
    this._frameId = 0;
    /**
     * Setting cache so we don't hit `game.settings.get` every frame. Refreshed
     * lazily and on `Hooks.callAll('clientSettingChanged', ...)` if available.
     * @private
     */
    this._priorityCache = null;
  }

  /**
   * Register the module setting that selects how darkness sources are merged.
   * Safe to call multiple times; the registration is idempotent.
   */
  registerSettings() {
    try {
      if (!globalThis.game?.settings?.register) return;
      globalThis.game.settings.register(MODULE_ID, SETTING_DARKNESS_PRIORITY, {
        name: 'Lighting darkness priority',
        hint: 'Which source defines scene darkness. "Max" keeps the legacy behaviour where Foundry slider, calendar, and weather are combined via Math.max. Choose a single source to make that input authoritative (e.g. so dragging the Foundry slider always wins).',
        scope: 'world',
        config: true,
        type: String,
        choices: { ...DARKNESS_PRIORITY_CHOICES },
        default: DARKNESS_PRIORITY.MAX,
        onChange: () => { this._priorityCache = null; },
      });
      globalThis.game.settings.register(MODULE_ID, SETTING_FADE_CHUNK_LEG_SECONDS, {
        name: 'Environment fade chunk leg (seconds)',
        hint: 'Wall-clock duration of each mini-fade leg when a long time-of-day transition is split into chunks. Darkness and Foundry light activation refresh at the end of each leg.',
        scope: 'world',
        config: true,
        type: Number,
        range: { min: 5, max: 60, step: 1 },
        default: 10,
      });
      globalThis.game.settings.register(MODULE_ID, SETTING_FADE_CHUNK_SETTLE_MS, {
        name: 'Environment fade chunk settle (ms)',
        hint: 'Pause between chunked fade legs so Foundry perception/lighting can catch up before the next leg begins.',
        scope: 'world',
        config: true,
        type: Number,
        range: { min: 0, max: 2000, step: 50 },
        default: 300,
      });
      globalThis.game.settings.register(MODULE_ID, SETTING_FADE_CHUNK_MIN_HOUR_DELTA, {
        name: 'Environment fade chunk min hour delta',
        hint: 'Minimum in-game hour span (shortest arc) before chunked fades activate. Chunking also requires the fade duration to exceed the leg length.',
        scope: 'world',
        config: true,
        type: Number,
        range: { min: 0.1, max: 12, step: 0.1 },
        default: 0.5,
      });
    } catch (e) {
      log.warn('Failed to register darknessPriority setting:', e);
    }
  }

  /** @private */
  _readPriority() {
    if (this._priorityCache) return this._priorityCache;
    let val = DARKNESS_PRIORITY.MAX;
    try {
      const raw = globalThis.game?.settings?.get?.(MODULE_ID, SETTING_DARKNESS_PRIORITY);
      if (typeof raw === 'string' && Object.values(DARKNESS_PRIORITY).includes(raw)) {
        val = raw;
      }
    } catch (_) {}
    this._priorityCache = val;
    return val;
  }

  /** @private */
  _readFoundryDarkness() {
    try {
      const sceneLevel = globalThis.canvas?.scene?.environment?.darknessLevel;
      if (Number.isFinite(sceneLevel)) return clamp01(sceneLevel);
    } catch (_) {}
    try {
      const envLevel = globalThis.canvas?.environment?.darknessLevel;
      if (Number.isFinite(envLevel)) return clamp01(envLevel);
    } catch (_) {}
    return 0;
  }

  /** @private */
  _readWeatherDarkness() {
    try {
      const wc = globalThis.window?.MapShine?.weatherController;
      const env = wc?.getEnvironment?.();
      const v = Number(env?.effectiveDarkness);
      if (Number.isFinite(v)) return clamp01(v);
    } catch (_) {}
    return 0;
  }

  /** @private */
  _resolveHour() {
    try {
      const wc = globalThis.window?.MapShine?.weatherController;
      const fromWc = Number(wc?.timeOfDay);
      if (Number.isFinite(fromWc)) return ((fromWc % 24) + 24) % 24;
    } catch (_) {}
    try {
      const fromPanel = Number(globalThis.window?.MapShine?.controlPanel?.controlState?.timeOfDay);
      if (Number.isFinite(fromPanel)) return ((fromPanel % 24) + 24) % 24;
    } catch (_) {}
    return Number.NaN;
  }

  /**
   * Recompute `masterDarkness`, `calendarDayWeight`, `hour`, and sun angles
   * from the current Foundry / Map Shine / weather state.
   *
   * Idempotent and cheap; safe to call once per render frame. Subsequent
   * calls within the same frame just recompute identically — there is no
   * throttling because consumers may run at different frequencies.
   *
   * @returns {LightingDirectorState} the newly-frozen state.
   */
  update() {
    const foundryDarkness = this._readFoundryDarkness();
    const hour = this._resolveHour();
    const calendarDarknessRaw = Number.isFinite(hour)
      ? computeTimeOfDayDarkness01(hour)
      : null;
    const calendarDarkness = Number.isFinite(calendarDarknessRaw)
      ? clamp01(calendarDarknessRaw)
      : 0;
    const weatherDarkness = this._readWeatherDarkness();

    const priority = this._readPriority();
    let masterDarkness = 0;
    switch (priority) {
      case DARKNESS_PRIORITY.FOUNDRY:
        masterDarkness = foundryDarkness;
        break;
      case DARKNESS_PRIORITY.CALENDAR:
        masterDarkness = calendarDarkness;
        break;
      case DARKNESS_PRIORITY.WEATHER:
        masterDarkness = weatherDarkness;
        break;
      case DARKNESS_PRIORITY.MAX:
      default:
        masterDarkness = Math.max(foundryDarkness, calendarDarkness, weatherDarkness);
        break;
    }
    masterDarkness = clamp01(masterDarkness);

    const calendarDayWeight = Number.isFinite(hour)
      ? clamp01(getFoundrySunlightFactor(hour))
      : 0;

    let sunAzDeg = NEUTRAL_STATE.sunAzDeg;
    let sunElDeg = NEUTRAL_STATE.sunElDeg;
    try {
      if (Number.isFinite(hour) && typeof computeSunAnglesFromHour === 'function') {
        const phases = getFoundryTimePhaseHours?.() ?? null;
        const sunriseHour = Number.isFinite(Number(phases?.sunrise))
          ? Number(phases.sunrise)
          : 6;
        const angles = computeSunAnglesFromHour(hour, sunriseHour);
        if (angles && Number.isFinite(angles.azimuthDeg)) sunAzDeg = angles.azimuthDeg;
        if (angles && Number.isFinite(angles.elevationDeg)) sunElDeg = angles.elevationDeg;
      }
    } catch (_) {}

    this._frameId += 1;
    this._state = Object.freeze({
      masterDarkness,
      calendarDayWeight,
      hour,
      sunAzDeg,
      sunElDeg,
      foundryDarkness,
      calendarDarkness,
      weatherDarkness,
      priority,
      frameId: this._frameId,
    });

    // Mirror the canonical darkness back to Foundry so vision and other Foundry
    // systems stay in sync. Only write when we actually own the value (i.e. the
    // user did not pick the Foundry slider as the sole source — in that case the
    // slider already equals masterDarkness).
    if (priority !== DARKNESS_PRIORITY.FOUNDRY) {
      try {
        const env = globalThis.canvas?.environment;
        if (env && Number.isFinite(env.darknessLevel) && env.darknessLevel !== masterDarkness) {
          // Direct assignment is safe for the live mirror (canvas.environment);
          // we deliberately do NOT touch `canvas.scene.environment.darknessLevel`
          // which would persist to the database.
          env.darknessLevel = masterDarkness;
        }
      } catch (_) {}
    }

    return this._state;
  }

  /**
   * Current frame's frozen lighting state. Cheap to call; returns the most
   * recent {@link update} output, or a neutral default before the first call.
   * @returns {LightingDirectorState}
   */
  get() {
    return this._state;
  }
}

/** Module-scope singleton — there is only ever one director per page. */
const _singleton = new LightingDirectorImpl();

/**
 * The {@link LightingDirector} singleton. Call {@link LightingDirectorImpl.registerSettings}
 * during module init and {@link LightingDirectorImpl.update} once per render frame.
 */
export const LightingDirector = _singleton;

export default LightingDirector;
