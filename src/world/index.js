/**
 * THE DOOR to world/ — sun, environment, and (eventually) weather/wind owners.
 * One public API per zone (Skeleton.md §2.1, `zones/one-door`): if it is not
 * exported here, other zones cannot reach it — by build failure, not by ask.
 */
export {
  computeSun,
  normalizeHour,
  phaseAtElevation,
  phaseBoundaryHours,
  DEFAULT_SUN_CONFIG,
  SKY_PHASES,
} from './sun.js';
export { buildEnvSnapshot, DEFAULT_WEATHER, DEFAULT_WIND, DEFAULT_AMBIENT } from './environment.js';
export {
  createDayClock,
  shortestHourDelta,
  DAY_CLOCK_MODES,
  DEFAULT_TOD_HOUR,
  DEFAULT_RATE_HOURS_PER_MINUTE,
  ALMANAC_POSTURES,
  postureToDayClockMode,
} from './day-clock.js';
export { resolveSky, applySkyEdit, normalizeSky, DEFAULT_SKY } from './sky-settings.js';
// THE WEATHER MANAGER (docs/planning/Weather-Manager.md) — the env snapshot's
// weather owner, which this door has said "eventually" about since it was
// written. Slice 1: the cloud axes + the ease engine + director mode.
export {
  createWeatherManager,
  easeToward,
  tauForDuration,
  clampAxis,
  WEATHER_MODES,
  WEATHER_AXES,
  WEATHER_AXIS_NAMES,
  TRANSITION_SPEEDS,
  TRANSITION_SPEED_NAMES,
  DEFAULT_PRESET,
  // ⭐ THE PRECIPITATION AXES (P1) and the sleet BAND — the band crosses the
  // zone because `effects/precipitation/mantle-model.js` must decide "is it
  // cold enough for this to LIE" using the SAME edges the manager uses to
  // decide "is it cold enough for this to FALL". Two copies of that number is
  // how a map ends up snowing onto ground that instantly melts it
  // (`feedback_shared_field_two_meanings_two_registries`), so it rides the door
  // rather than being restated.
  PRECIP_KINDS,
  PRECIP_SLEET_BAND,
  derivePrecipKind,
} from './weather.js';
// THE ARCHETYPE TABLE (slice 2) — the astrolabe's shelf renders straight from
// this, so the row order, icons and blurbs are one edit here rather than two.
export {
  WEATHER_ARCHETYPES,
  WEATHER_ARCHETYPE_IDS,
  DEFAULT_ARCHETYPE_ID,
  CUSTOM_PRESET,
  resolveArchetype,
  isApplicableArchetype,
  matchArchetype,
} from './weather-data.js';
// THE BIOME TABLE (slice 3) — the astrolabe's biome picker renders straight
// from this, same reasoning as the archetype table just above.
export { WEATHER_BIOMES, WEATHER_BIOME_IDS, resolveBiome, isKnownBiome } from './weather-biomes.js';
// THE EVENTS TABLE (slice 4) — the closed list + defaults a future events UI
// (or a GM macro / front script) renders/validates against, same reasoning
// as the archetype and biome tables above.
export {
  EVENT_KINDS,
  EVENT_KIND_DEFAULTS,
  OVERRIDE_OPS,
  OP_NEUTRAL,
  resolveEventKind,
  envelopePhase,
  composeOverride,
  applyEventOverrides,
} from './weather-events.js';
// THE WIND HANDLE (Wind.md §5.1) — the ONE door to the field for everything
// outside world/. `sampleWind` itself is deliberately NOT re-exported here any
// more: it needs five hand-assembled inputs, and hand-assembling them is the
// bug class `wind/handle-only` (tools/verify-structure.mjs) now fails the build
// over. Consumers take a handle; only world/ builds one.
export { createWindHandle, packWindCells, WIND_CELL_VEC4_STRIDE } from './wind-access.js';
export {
  validateWindContributor,
  deflectAroundWalls,
  computeWindTurbulence,
  // The shared curl-noise octave (divergence-free ⇒ area-preserving). Wind
  // turbulence's own octaves AND vegetation's mass-preserving leaf flutter both
  // read this ONE implementation at their own scales — see its header.
  curlNoise2D,
  WALL_MOMENTUM_GUARD_LOW,
  WALL_MOMENTUM_GUARD_HIGH,
  WALL_IMPACT_CHAOS_GAIN,
  // Exported so the wind PROBE applies the identical shelter strength the
  // renderer does — an instrument holding its own copy of this number is how it
  // starts reporting a wind the scene isn't actually showing.
  WIND_SHADOW_DEPTH,
  // The discrete travelling gust envelope (2026-08-15) and its shipped
  // default. The default is exported for the SAME reason WIND_SHADOW_DEPTH is:
  // the uniform's initial value and the debug control's own default must be
  // one number, not two copies that can drift.
  computeGustEnvelope,
  WIND_DEFAULT_GUSTINESS01,
} from './wind-field.js';
export { ambientVectorFromWind, computeWindBakeGridSpec, rasterizeWallsToGrid } from './wind-bake.js';
export {
  floodFillOpenFromBoundary,
  summarizeEnclosure,
  downsampleMax,
  cropGridMargin,
  distanceFromDoorThreshold,
  opennessFalloffFromDistance,
  downsampleDistanceMin,
  DOOR_FALLOFF_REACH_CELLS,
  // How far the wind pushes IN scales with how hard it blows (2026-08-15).
  doorReachScaleForWindSpeed,
  DOOR_REACH_SCALE_CALM,
  DOOR_REACH_SCALE_GALE,
  distanceFromNearestSolid,
  wallAvoidanceDirectionFromDistance,
  wallProximityFromDistance,
  WALL_DEFLECT_REACH_CELLS,
  upwindShelter,
  WIND_SHADOW_REACH_CELLS,
} from './wind-enclosure.js';
export {
  computeOneShotGain01,
  computeDecayTailTicks,
  computeThawWindowMs,
  doorwayImpulseFromWallSegment,
  gatherActiveImpulseSlots,
  advectWindField,
  splatWindField,
  relaxWindField,
  dissipateWindField,
  stepWindSimReference,
  WIND_SIM_DEFAULT_DECAY_PER_SECOND,
  WIND_SIM_DEFAULT_RELAX_ITERATIONS,
  WIND_SIM_RELAX_BLEND,
  WIND_SIM_ENERGY_FLOOR_FRACTION,
  WIND_SIM_MAX_ACTIVE_IMPULSES,
  WIND_SIM_SPLAT_FOLLOW_RATE_PER_SECOND,
  DOOR_IMPULSE_GAIN,
  DOOR_IMPULSE_LIFETIME_MS,
  DOOR_IMPULSE_MIN_RADIUS_PX,
} from './wind-sim.js';
export { buildWindSimMaterials } from './wind-sim-gpu.js';

// THE ALMANAC (docs/holy/Almanac-Testament.md) — worldTime <-> calendar
// components, themed date formatting, moon phase. Pure; the CalendarData
// subclass that actually INSTALLS the true-gregorian calendars into Foundry
// lives in foundry/calendar-install.js (foundry/ cannot import world/, so it
// calls core/gregorian-math.js directly — this door only carries the
// Almanac's own public surface to the REST of src/, e.g. the eventual Face).
export {
  projectWorldTime,
  composeWorldTime,
  validateCalendarConfig,
  CALENDAR_ENGINES,
  moonPhaseAt,
  PHASE_NAMES,
  formatThemedDate,
  formatThemedTime,
  ordinalString,
  CALENDARS,
  CALENDAR_IDS,
  getCalendar,
  GOLARION_PARITY_CALENDAR,
  EARTH_CALENDAR,
  GOLARION_LORE_STRICT_CALENDAR,
} from './almanac.js';

// THE FADE ENGINE (docs/holy/UI-Testament.md §4.2, U2) — pure curve/merge/
// resume/expiry math over a flat Record<key, FadeEntry>. Zero knowledge of
// effects or Foundry; fade-registry.js is the door that makes an arbitrary
// effect's schema fadeable without this file (or that one) learning its name.
export {
  FADEABLE_TYPES,
  CURVES,
  isFadeableType,
  shapeProgress,
  rawProgress,
  progressOf,
  isEntryExpired,
  computeEasedValue,
  mergeFadeState,
  pruneExpired,
  cancelEntry,
  snapEntry,
  deriveAllValues,
} from './fade-engine.js';
export { schemaFadeSource, createFadeSourceRegistry } from './fade-registry.js';
