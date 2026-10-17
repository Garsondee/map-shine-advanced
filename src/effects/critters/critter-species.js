/**
 * CRITTER SPECIES — the constants and ladders every critter module agrees on.
 *
 * A species is DATA. The engine (`effects/particles/critter-runtime.js`) is one
 * factory that is handed a `kind` at build time — the fire runtime's own shape
 * (`createFireParticleEngine({kind})`) — and everything that differs between a
 * fly, a maggot and a firefly lives in a table or a tier plan here, never in an
 * `if (kind === …)` scattered through the render path. Pure; no THREE.
 *
 * @module effects/critters/critter-species
 */
import { ZONE_FIELD_CELLS_MAX } from './critter-zone.js';

/** The three bodies the engine can build. */
export const CRITTER_KINDS = Object.freeze(['fly', 'maggot', 'firefly']);

/**
 * Slots reserved in the particle arena per kind, MAP-WIDE (one floor's worth —
 * the engine is re-fed whichever floor is viewed).
 *
 * Chosen against the manifests' own ceilings (200 per swarm, 300 maggots per
 * swarm) and what a screen can show: a thousand flies is already a plague, and a
 * kind that asked for more than its capacity is thinned proportionally by
 * `allocateZonePopulation`, never truncated mid-zone.
 */
export const CRITTER_CAPACITY = Object.freeze({ fly: 1024, maggot: 2048, firefly: 1536 });

/**
 * The most cells the shared zone buffer can hold. `MASK_GRID_MAX_DIM` is 512 and a derived grid is at
 * most 512 × 512, plus the unpainted border cells the field keeps beyond the grid so that paint running to
 * the edge of the map still has a rim (516 × 516 — `critter-zone.js#ZONE_FIELD_CELLS_MAX`). The buffer is
 * allocated once at this maximum because a storage buffer cannot be freed or resized (`particle-arena.js`).
 */
export const ZONE_MAX_CELLS = ZONE_FIELD_CELLS_MAX;

/** The default ladder rung — what the `standard` profile resolves to. Anti-drift tested. */
export const CRITTER_DEFAULT_TIER = 2;

/**
 * The zone area that earns exactly `perZone` agents. Authored sizes follow the
 * grid (a swarm over "a corpse" is a grid square or two), so the reference is a
 * multiple of the grid, not a fixed pixel count: on a 50 px grid and a 200 px
 * grid the same painted-in-squares blob should be the same-sized swarm.
 *
 * @param {number} gridPx - Foundry's `grid.size` (px per square).
 * @returns {number} world px².
 */
export function critterRefAreaPx2(gridPx) {
  const g = Number.isFinite(gridPx) && gridPx > 0 ? gridPx : 100;
  const side = g * 2.5;
  return side * side;
}

/**
 * How far beyond the painted edge a swarm or colony may roam, in px, which sets
 * the zone field's crop margin. Derived from the grid for the same reason as above.
 * @param {number} gridPx @param {number} [squares=3]
 * @returns {number}
 */
export function critterMarginPx(gridPx, squares = 3) {
  const g = Number.isFinite(gridPx) && gridPx > 0 ? gridPx : 100;
  return Math.max(128, g * squares);
}

/**
 * The fly kinds the `species` param can pick, in the order the shader indexes
 * them. `mixed` is a build-time choice to roll per individual from the seed.
 */
export const FLY_LOOKS = Object.freeze(['mixed', 'housefly', 'bluebottle', 'greenbottle', 'fleshfly']);

/** The firefly flash styles, in shader index order. */
export const FIREFLY_FLASH_STYLES = Object.freeze(['breathe', 'blink', 'double', 'steady']);

/**
 * What each rung of each effect's ladder BUYS, as flags a material builder reads
 * at graph-build time (`tsl/no-uniform-gates`: a tier is a JS `if` that decides
 * which nodes are CONSTRUCTED, never a uniform that leaves the code running).
 *
 * `countScale` multiplies the population, because the cheapest way to make a
 * swarm cost less is to have fewer flies; everything else is a feature that adds
 * fragment work.
 */
const FLY_TIER_PLANS = Object.freeze([
  Object.freeze({
    countScale: 0.5,
    legs: false,
    veins: false,
    lit: false,
    shadow: false,
    groom: false,
    bank: false,
    sheen: false,
  }),
  Object.freeze({
    countScale: 0.75,
    legs: true,
    veins: false,
    lit: false,
    shadow: false,
    groom: false,
    bank: false,
    sheen: false,
  }),
  Object.freeze({
    countScale: 1,
    legs: true,
    veins: true,
    lit: true,
    shadow: true,
    groom: false,
    bank: false,
    sheen: false,
  }),
  Object.freeze({
    countScale: 1,
    legs: true,
    veins: true,
    lit: true,
    shadow: true,
    groom: true,
    bank: true,
    sheen: true,
  }),
  Object.freeze({
    countScale: 1.25,
    legs: true,
    veins: true,
    lit: true,
    shadow: true,
    groom: true,
    bank: true,
    sheen: true,
  }),
]);

const FIREFLY_TIER_PLANS = Object.freeze([
  Object.freeze({ countScale: 0.5, body: false, lit: false, trail: false }),
  Object.freeze({ countScale: 0.75, body: true, lit: false, trail: false }),
  Object.freeze({ countScale: 1, body: true, lit: true, trail: false }),
  Object.freeze({ countScale: 1, body: true, lit: true, trail: true }),
  Object.freeze({ countScale: 1.25, body: true, lit: true, trail: true }),
]);

/**
 * The plan for a rung. Total: an out-of-range or non-finite tier clamps into the
 * ladder rather than throwing into a frame (`resolveEffectTier`'s own posture).
 *
 * @param {'fly'|'firefly'} family - maggots follow the fly ladder (same swarm, same cost class).
 * @param {number} tier
 * @returns {Readonly<object>}
 */
export function critterTierPlan(family, tier) {
  const plans = family === 'firefly' ? FIREFLY_TIER_PLANS : FLY_TIER_PLANS;
  const n = Number.isFinite(tier) ? Math.max(0, Math.min(plans.length - 1, Math.floor(tier))) : CRITTER_DEFAULT_TIER;
  return plans[n];
}

/** Rungs per ladder — both effects declare the same count (the manifests are checked against this). */
export const CRITTER_TIER_COUNT = FLY_TIER_PLANS.length;
