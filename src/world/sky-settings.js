/**
 * SKY SETTINGS — where "what is the sky doing" is stored, and which store wins.
 *
 * ============================================================================
 * THE RULE (author-decided 2026-07-23)
 * ============================================================================
 *
 * *"Time of day and weather should be per world by default with an option to
 * make it per scene that you have to enable."*
 *
 * So: ONE world sky is the truth for the campaign, and a scene may OPT IN to
 * having its own. One toggle governs the whole override block — not a toggle
 * per value. That matters: a per-value opt-in ("this scene overrides the hour
 * but not the weather but yes the mode") is four booleans that can contradict
 * each other, and answering "why is this scene overcast" then means reading
 * four flags instead of one. One switch, one question: *does this scene have
 * its own sky?*
 *
 * ============================================================================
 * WHY A RESOLVE FUNCTION AND NOT A MERGE
 * ============================================================================
 *
 * `resolveSky` picks ONE source and returns it whole, tagged with where it came
 * from. It never merges fields across the two stores.
 *
 * That is deliberate and it is the anti-V2 shape. V2 had *"seven homes per
 * weather value"* (Environment.md §0.4) — the same number living in a scene
 * flag, a world setting, a params blackboard, a UI mirror and three caches,
 * with per-field precedence rules nobody could hold in their head. Field-level
 * merging is how you get there: every field acquires its own private history of
 * which store last won. A whole-block resolve has exactly two possible answers
 * and reports which one it gave.
 *
 * Pure — no Foundry, no storage. `foundry/sky-persistence.js` does the reading
 * and writing; this decides what the answer means.
 *
 * @module world/sky-settings
 */

import { normalizeHour } from './sun.js';
import { DAY_CLOCK_MODES, DEFAULT_TOD_HOUR, DEFAULT_RATE_HOURS_PER_MINUTE } from './day-clock.js';
import { DEFAULT_ARCHETYPE_ID, CUSTOM_PRESET, isApplicableArchetype } from './weather-data.js';
import { WEATHER_MODES, PRECIP_KINDS } from './weather.js';
import { isKnownBiome } from './weather-biomes.js';

/**
 * The scene's LOOK block — everything about time, weather and colour a scene can
 * own, in one object. Named `SKY` for history; it now also carries the colour
 * GRADE (docs/planning/Grade.md), because the grade is per-scene/per-world by
 * the exact same rule as the sky and sharing one block means one resolve, one
 * persist, one pump — not a second parallel settings system (the thing V2 grew
 * three of). Deliberately small: every field is another way two scenes can
 * silently disagree.
 */
export const DEFAULT_SKY = Object.freeze({
  /** 'aesthetic' | 'synced' — see world/day-clock.js. */
  mode: 'aesthetic',
  /** 0..24. Ignored in `synced` mode, where Foundry's world clock supplies it. */
  todHour: DEFAULT_TOD_HOUR,
  /** Game-hours per real minute. 0 = frozen (the default; see day-clock.js). */
  rateHoursPerMinute: DEFAULT_RATE_HOURS_PER_MINUTE,
  /** 0..1 overcast. Authoritative ONLY when `weatherArchetype` is `custom` —
   * see that field. */
  cloudCover01: 0,
  /**
   * THE NAMED SKY (docs/planning/Weather-Manager.md §3.2) — an archetype id, or
   * `custom` for a sky hand-tuned off every named row.
   *
   * ⚠️ THIS AND `cloudCover01` ARE NOT TWO COPIES OF ONE FACT, and the split is
   * deliberate: exactly one of them is authoritative at a time. A named
   * archetype carries ALL FOUR cloud axes, so storing its id restores the whole
   * sky — storing cover alongside it would be a second, lower-resolution
   * account of the same thing, free to disagree the moment a row's values are
   * tuned (`feedback_shared_field_two_meanings_two_registries`). `custom` is
   * the one state cover has to describe, because there is no row to name.
   *
   * The restore rule, in `boot.js#applyLookToEngines`: a real id applies the
   * ROW; `custom` applies the stored COVER. Never both.
   */
  weatherArchetype: DEFAULT_ARCHETYPE_ID,
  /**
   * 'director' | 'almanac' (Weather-Manager.md §5). Persisted like everything
   * else here: a GM who set a scene walking through `desert` should find it
   * still walking on reload, not silently reset to a held sky.
   */
  weatherMode: 'director',
  /**
   * The Almanac's climate, or `null` (no biome chosen — the walk stays idle
   * even in `almanac` mode, a legitimate state per `world/weather.js#setBiome`,
   * never a fake default climate).
   */
  weatherBiome: null,
  /** The Almanac's dwell-time multiplier, 0.25..4. Meaningless in `director`
   * mode; stored anyway so switching back to `almanac` remembers the pace. */
  weatherVolatility: 1,
  /**
   * ⭐ PRECIPITATION, PERSISTED (P1). Author: *"you should make it so that the
   * time of day and weather persist on a scene between foundry refreshes."*
   *
   * ⚠️ THESE THREE WERE THE GAP. `todHour`, the archetype, the mode and the
   * biome already rode the scene flag — but `precip01`/`temperature01` joined
   * `WEATHER_AXES` in P1 and nobody added them here, so weather only
   * HALF-persisted: a shelf click survived a refresh (because the archetype id
   * carries its own precip), while a hand-set shower or a cold map evaporated.
   * `feedback_hand_maintained_dispatch_list_forgets_new_effects` again, in a
   * third place — the axis table, the env snapshot and now the store each keep
   * their own list of what a weather is.
   *
   * ⚠️ `precip01` is authoritative ONLY when `weatherArchetype` is `custom`,
   * exactly like `cloudCover01` above and for the same reason: a named row
   * already carries its own precip, and storing both invites the two to
   * disagree about what the sky is doing.
   */
  precip01: 0,
  /** Cold → hot. NOT archetype-owned (a sky is not a climate), so this is the
   * ONLY thing that remembers a map is wintry — and it is what decides whether
   * `auto` precipitation falls as rain or snow. */
  temperature01: 0.55,
  /** `auto` | rain | snow | sleet | hail | ash | embers. Stored so a GM who
   * pinned "always snow" gets it back; `auto` hands control to temperature. */
  precipKindAuthored: 'auto',
  /** 0 = exact Foundry parity (the sky light is a no-op), 1 = full model.
   * See effects/sky-access.js for why the default cannot be anything else. */
  realism01: 0,
  /** THE ENVIRONMENTAL GRADE strength, 0..1 (the automatic ToD/weather look +
   * cloud desaturation). 0 = neutral. docs/planning/Grade.md.
   *
   * (The ARTISTIC grade is NOT stored here — it became a first-class effect
   * with its own settings cascade, `effects/grade/grade.js`, 2026-07-23. One
   * home, not two: the astrolabe Look dropdown + a `lookPreset` field here
   * would have been a second persistence home for the same value.) */
  gradeEnvStrength: 0,
});

/**
 * Coerce anything into a valid sky block. Every field falls back to its default
 * INDEPENDENTLY, so one corrupt value in a stored flag cannot discard the rest
 * of a scene's authored sky — a scene losing its 19:30 dusk because someone
 * hand-edited a cloud value into a string would be a real loss of work.
 *
 * @param {object} [raw]
 * @returns {Readonly<typeof DEFAULT_SKY>}
 */
export function normalizeSky(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return Object.freeze({
    mode: DAY_CLOCK_MODES.includes(r.mode) ? r.mode : DEFAULT_SKY.mode,
    todHour: Number.isFinite(Number(r.todHour)) ? normalizeHour(r.todHour) : DEFAULT_SKY.todHour,
    rateHoursPerMinute: clampRange(r.rateHoursPerMinute, -60, 60, DEFAULT_SKY.rateHoursPerMinute),
    cloudCover01: clampRange(r.cloudCover01, 0, 1, DEFAULT_SKY.cloudCover01),
    // A stored id from a future version (or a typo) falls back to `clear`
    // rather than being kept and failing later — the same fail-open posture
    // `resolveArchetype` takes, applied at the storage boundary so a bad value
    // never even reaches the manager.
    weatherArchetype:
      r.weatherArchetype === CUSTOM_PRESET || isApplicableArchetype(r.weatherArchetype)
        ? r.weatherArchetype
        : DEFAULT_SKY.weatherArchetype,
    weatherMode: WEATHER_MODES.includes(r.weatherMode) ? r.weatherMode : DEFAULT_SKY.weatherMode,
    // `null` is a real, legal value here (no biome chosen) — the same
    // fail-open posture `resolveBiome` takes, applied at the storage boundary.
    weatherBiome:
      r.weatherBiome === null || isKnownBiome(r.weatherBiome) ? (r.weatherBiome ?? null) : DEFAULT_SKY.weatherBiome,
    weatherVolatility: clampRange(r.weatherVolatility, 0.25, 4, DEFAULT_SKY.weatherVolatility),
    precip01: clampRange(r.precip01, 0, 1, DEFAULT_SKY.precip01),
    temperature01: clampRange(r.temperature01, 0, 1, DEFAULT_SKY.temperature01),
    // Fails open to `auto` on an unknown kind — the closed list lives in
    // `world/weather.js`, and a stored value from a future version must hand
    // control back to the derivation rather than storm-lock a species.
    precipKindAuthored: PRECIP_KINDS.includes(r.precipKindAuthored)
      ? r.precipKindAuthored
      : DEFAULT_SKY.precipKindAuthored,
    realism01: clampRange(r.realism01, 0, 1, DEFAULT_SKY.realism01),
    gradeEnvStrength: clampRange(r.gradeEnvStrength, 0, 1, DEFAULT_SKY.gradeEnvStrength),
  });
}

/**
 * Decide which sky is in force.
 *
 * @param {object} inputs
 * @param {object} [inputs.world] - the world-level sky block.
 * @param {object} [inputs.scene] - the scene's own block, if it has one.
 * @param {boolean} [inputs.sceneOverrides] - the scene's opt-in toggle.
 * @returns {Readonly<{sky: object, source: 'scene'|'world', sceneOverrides: boolean}>}
 *   `source` is not decoration — it is what the astrolabe shows so a GM can
 *   always tell whether they are editing this scene or the whole campaign. A
 *   control that silently edits a different scope than the user believes is the
 *   single most expensive kind of UI mistake available here.
 */
export function resolveSky({ world, scene, sceneOverrides } = {}) {
  const worldSky = normalizeSky(world);
  if (sceneOverrides !== true) {
    return Object.freeze({ sky: worldSky, source: 'world', sceneOverrides: false });
  }
  // An override that was enabled but never authored inherits the world's values
  // as its STARTING POINT — a scene flipping to "own sky" should look identical
  // until something is actually changed, not snap to a hardcoded noon.
  return Object.freeze({
    sky: normalizeSky({ ...worldSky, ...(scene && typeof scene === 'object' ? scene : {}) }),
    source: 'scene',
    sceneOverrides: true,
  });
}

/**
 * Apply one edit to whichever scope is in force, returning the FULL block to
 * write back plus which store to write it to.
 *
 * Exists so the astrolabe never has to know the precedence rules: it says "the
 * user moved the hour to 19.5" and this says "then write this whole block to
 * the scene". A UI that decided the target scope itself would be a second copy
 * of the rule above, free to disagree with it.
 *
 * @param {object} inputs - same shape as `resolveSky`'s.
 * @param {object} patch - the changed field(s).
 * @returns {Readonly<{target: 'scene'|'world', sky: object}>}
 */
export function applySkyEdit(inputs, patch) {
  const { sky, source } = resolveSky(inputs);
  return Object.freeze({ target: source, sky: normalizeSky({ ...sky, ...(patch ?? {}) }) });
}

/** @param {*} v @param {number} lo @param {number} hi @param {number} fallback @returns {number} */
function clampRange(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
