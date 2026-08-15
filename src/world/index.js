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
} from './day-clock.js';
export { resolveSky, applySkyEdit, normalizeSky, DEFAULT_SKY } from './sky-settings.js';
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
