/**
 * THE DOOR to world/ — sun, environment, and (eventually) weather/wind owners.
 * One public API per zone (Skeleton.md §2.1, `zones/one-door`): if it is not
 * exported here, other zones cannot reach it — by build failure, not by ask.
 */
export { computeSun, normalizeHour, DEFAULT_SUN_CONFIG } from './sun.js';
export { buildEnvSnapshot, DEFAULT_WEATHER, DEFAULT_WIND } from './environment.js';
