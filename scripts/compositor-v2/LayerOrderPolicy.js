/**
 * @fileoverview Centralized floor-aware render-order policy for the V2 compositor.
 *
 * Every bus-scene mesh and effect overlay should obtain its renderOrder from
 * this module instead of computing ad-hoc values. Pick helpers by intent:
 *
 * - **tileStackedOverlayOrder** — Per-tile overlays that must paint **in stack order**
 *   with scene/tile albedo (specular, bush, prism, iridescence). Higher-sorted tiles
 *   occlude overlays from layers beneath.
 * - **tileRelativeEffectOrder** — Places overlays in **FLOOR_EFFECTS** while preserving
 *   sort — rarely needed; most per-tile FX should use tileStackedOverlayOrder instead.
 * - **effectUnderOverheadOrder** / **effectAboveOverheadOrder** — Floor-wide batches
 *   (particles, splashes, trees) that are not tied to a single tile’s sort slot.
 *
 * The policy divides each floor into fixed role bands so that the visual stack is
 * deterministic regardless of which floor the viewer is on:
 *
 *   per floor (ascending):
 *     FLOOR_ALBEDO        0 –  2399   regular (non-overhead) tiles
 *     FLOOR_EFFECTS       2400 – 4799  effects that sit above albedo, below overhead
 *     FLOOR_OVERHEAD      4800 – 7199  overhead / roof tiles
 *     FLOOR_OVERHEAD_FX   7200 – 9599  effects above overhead (tree canopies, etc.)
 *     FLOOR_MOTION_TOP    9600 – 9999  motion-forced above-tokens, reserved slots
 *
 * Cross-floor ordering:  floor N's band starts at N * RENDER_ORDER_PER_FLOOR.
 *
 * @module compositor-v2/LayerOrderPolicy
 */

import { createLogger } from '../core/log.js';

const log = createLogger('LayerOrderPolicy');

// ── Band geometry ────────────────────────────────────────────────────────────

export const RENDER_ORDER_PER_FLOOR = 10000;

/** Number of slots available within each role band for intra-role sorting. */
const BAND_SIZE = 2400;

/** Role band offsets (start of each band within a single floor). */
export const ROLE_OFFSETS = Object.freeze({
  FLOOR_ALBEDO:      0,
  FLOOR_EFFECTS:     BAND_SIZE,          // 2400
  FLOOR_OVERHEAD:    BAND_SIZE * 2,      // 4800
  FLOOR_OVERHEAD_FX: BAND_SIZE * 3,      // 7200
  FLOOR_MOTION_TOP:  9600,
});

/** Maximum intra-role offset callers may use before bleeding into the next band. */
export const MAX_INTRA_ROLE_OFFSET = BAND_SIZE - 1; // 2399

/**
 * Fractional renderOrder stride for overlays that interleave immediately after
 * their source tile. Three.js accepts non-integer renderOrder values; using the
 * fractional space avoids colliding with the next tile's integer sort slot.
 */
const STACKED_OVERLAY_FRACTIONAL_STEP = 0.01;

// ── Convenience aliases that effects / bus code can import directly ──────────

export const FLOOR_ALBEDO_OFFSET      = ROLE_OFFSETS.FLOOR_ALBEDO;
export const FLOOR_EFFECTS_OFFSET     = ROLE_OFFSETS.FLOOR_EFFECTS;
export const FLOOR_OVERHEAD_OFFSET    = ROLE_OFFSETS.FLOOR_OVERHEAD;
export const FLOOR_OVERHEAD_FX_OFFSET = ROLE_OFFSETS.FLOOR_OVERHEAD_FX;
export const FLOOR_MOTION_TOP_OFFSET  = ROLE_OFFSETS.FLOOR_MOTION_TOP;

// ── Z constants (unchanged from FloorRenderBus, re-exported for convenience) ─

export const GROUND_Z = 1000;
export const Z_PER_FLOOR = 1;

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * Compute the canonical renderOrder for a mesh given its floor and role.
 *
 * @param {number} floorIndex       - 0-based floor index
 * @param {'FLOOR_ALBEDO'|'FLOOR_EFFECTS'|'FLOOR_OVERHEAD'|'FLOOR_OVERHEAD_FX'|'FLOOR_MOTION_TOP'} role
 * @param {number} [intraOffset=0]  - offset within the role band (0 – MAX_INTRA_ROLE_OFFSET)
 * @returns {number} renderOrder value
 */
export function computeRenderOrder(floorIndex, role, intraOffset = 0) {
  const fi = Number.isFinite(Number(floorIndex)) ? Math.max(0, Number(floorIndex)) : 0;
  const base = ROLE_OFFSETS[role];
  if (base === undefined) {
    log.warn(`computeRenderOrder: unknown role "${role}", falling back to FLOOR_EFFECTS`);
    return fi * RENDER_ORDER_PER_FLOOR + ROLE_OFFSETS.FLOOR_EFFECTS + _clampIntra(intraOffset);
  }
  return fi * RENDER_ORDER_PER_FLOOR + base + _clampIntra(intraOffset);
}

/**
 * Compute renderOrder for a regular (non-overhead) albedo tile.
 *
 * @param {number} floorIndex
 * @param {number} sortWithinFloor - Foundry-derived sort mapped into 0 – MAX_INTRA_ROLE_OFFSET
 * @returns {number}
 */
export function tileAlbedoOrder(floorIndex, sortWithinFloor) {
  return computeRenderOrder(floorIndex, 'FLOOR_ALBEDO', sortWithinFloor);
}

/**
 * Compute renderOrder for an overhead / roof tile.
 *
 * @param {number} floorIndex
 * @param {number} sortWithinFloor
 * @returns {number}
 */
export function tileOverheadOrder(floorIndex, sortWithinFloor) {
  return computeRenderOrder(floorIndex, 'FLOOR_OVERHEAD', sortWithinFloor);
}

/**
 * Compute renderOrder for an effect that sits between albedo and overhead
 * (the default position for most effects).
 *
 * @param {number} floorIndex
 * @param {number} [intraOffset=0]
 * @returns {number}
 */
export function effectUnderOverheadOrder(floorIndex, intraOffset = 0) {
  return computeRenderOrder(floorIndex, 'FLOOR_EFFECTS', intraOffset);
}

/**
 * Compute renderOrder for an effect that sits above overhead tiles
 * (tree canopy, above-roof effects).
 *
 * @param {number} floorIndex
 * @param {number} [intraOffset=0]
 * @returns {number}
 */
export function effectAboveOverheadOrder(floorIndex, intraOffset = 0) {
  return computeRenderOrder(floorIndex, 'FLOOR_OVERHEAD_FX', intraOffset);
}

/**
 * Compute renderOrder for motion-forced "above tokens" tiles.
 *
 * @param {number} floorIndex
 * @param {number} [intraOffset=0]
 * @returns {number}
 */
export function motionAboveTokensOrder(floorIndex, intraOffset = 0) {
  return computeRenderOrder(floorIndex, 'FLOOR_MOTION_TOP', intraOffset);
}

// ── Tile-relative effect order (for per-tile additive overlays) ──────────────

/**
 * Render order for overlays that must **interleave** with tile albedo (e.g. additive
 * specular): drawn immediately **after** the base mesh in the **same** role band
 * (FLOOR_ALBEDO, FLOOR_OVERHEAD, or FLOOR_MOTION_TOP). This lets higher-sorted tiles
 * occlude shine from layers beneath without a depth prepass.
 *
 * Band is inferred from `tileRenderOrder` so motion-above-tokens tiles are handled
 * correctly (their base order is not FLOOR_ALBEDO).
 *
 * @param {number} tileRenderOrder - the base tile or background plane `renderOrder`
 * @param {number} floorIndex
 * @param {number} [delta=1] - fractional slots after the base mesh (multiple overlays on one tile)
 * @returns {number}
 */
export function tileStackedOverlayOrder(tileRenderOrder, floorIndex, delta = 1) {
  const fi = Number.isFinite(Number(floorIndex)) ? Math.max(0, Number(floorIndex)) : 0;
  const floorBase = fi * RENDER_ORDER_PER_FLOOR;
  const localOrder = tileRenderOrder - floorBase;
  const d = Math.max(1, Math.round(Number(delta) || 1));
  const overlayOffset = Math.min(0.99, d * STACKED_OVERLAY_FRACTIONAL_STEP);

  // Motion-above-tokens (foreground / above-token tiles)
  if (localOrder >= ROLE_OFFSETS.FLOOR_MOTION_TOP) {
    const intra = localOrder - ROLE_OFFSETS.FLOOR_MOTION_TOP;
    const maxMotionLocal = RENDER_ORDER_PER_FLOOR - ROLE_OFFSETS.FLOOR_MOTION_TOP - overlayOffset;
    const next = Math.max(0, Math.min(maxMotionLocal, intra + overlayOffset));
    return floorBase + ROLE_OFFSETS.FLOOR_MOTION_TOP + next;
  }

  // Overhead / roof / foreground layer (above ground albedo, below overhead-FX slot reserved for FX)
  if (localOrder >= ROLE_OFFSETS.FLOOR_OVERHEAD) {
    const intra = localOrder - ROLE_OFFSETS.FLOOR_OVERHEAD;
    const next = Math.max(0, Math.min(MAX_INTRA_ROLE_OFFSET + overlayOffset, intra + overlayOffset));
    return floorBase + ROLE_OFFSETS.FLOOR_OVERHEAD + next;
  }

  // Ground albedo band — includes `__bg_image__` at intra 0 and regular tiles.
  const intra = Math.max(0, localOrder - ROLE_OFFSETS.FLOOR_ALBEDO);
  const next = Math.max(0, Math.min(MAX_INTRA_ROLE_OFFSET + overlayOffset, intra + overlayOffset));
  return floorBase + ROLE_OFFSETS.FLOOR_ALBEDO + next;
}

/**
 * Map a tile-relative overlay into **FLOOR_EFFECTS** (or overhead-FX for overhead
 * tiles), preserving intra-floor sort. **Avoid for surface overlays** that must
 * interleave with albedo — use {@link tileStackedOverlayOrder} so upper tiles can
 * occlude (otherwise every overlay draws after all ground albedo in that floor).
 *
 * @param {number} tileRenderOrder  - the base tile's renderOrder
 * @param {number} floorIndex       - tile's floor
 * @param {boolean} isOverhead      - whether the tile is overhead
 * @param {number} [delta=1]        - intra-band offset for stacking multiple overlays per tile
 * @returns {number}
 */
export function tileRelativeEffectOrder(tileRenderOrder, floorIndex, isOverhead, delta = 1) {
  const fi = Number.isFinite(Number(floorIndex)) ? Math.max(0, Number(floorIndex)) : 0;
  const floorBase = fi * RENDER_ORDER_PER_FLOOR;
  const localOrder = tileRenderOrder - floorBase;

  if (isOverhead) {
    const overheadLocal = localOrder - ROLE_OFFSETS.FLOOR_OVERHEAD;
    const clamped = Math.max(0, Math.min(MAX_INTRA_ROLE_OFFSET, overheadLocal + delta));
    return floorBase + ROLE_OFFSETS.FLOOR_OVERHEAD_FX + clamped;
  }
  const albedoLocal = localOrder - ROLE_OFFSETS.FLOOR_ALBEDO;
  const clamped = Math.max(0, Math.min(MAX_INTRA_ROLE_OFFSET, albedoLocal + delta));
  return floorBase + ROLE_OFFSETS.FLOOR_EFFECTS + clamped;
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

/**
 * Decode a renderOrder value into its floor, role, and intra-role offset.
 * Useful for debug logging and health diagnostics.
 *
 * @param {number} renderOrder
 * @returns {{ floor: number, role: string, intraOffset: number }}
 */
export function decodeRenderOrder(renderOrder) {
  const ro = Number(renderOrder) || 0;
  const floor = Math.floor(ro / RENDER_ORDER_PER_FLOOR);
  const local = ro - floor * RENDER_ORDER_PER_FLOOR;

  const roleNames = Object.keys(ROLE_OFFSETS);
  let bestRole = roleNames[0];
  let bestOffset = ROLE_OFFSETS[roleNames[0]];
  for (const name of roleNames) {
    if (ROLE_OFFSETS[name] <= local && ROLE_OFFSETS[name] >= bestOffset) {
      bestRole = name;
      bestOffset = ROLE_OFFSETS[name];
    }
  }
  return {
    floor,
    role: bestRole,
    intraOffset: local - bestOffset,
  };
}

/**
 * Format a renderOrder as a human-readable diagnostic string.
 * @param {number} renderOrder
 * @returns {string}
 */
export function formatRenderOrder(renderOrder) {
  const { floor, role, intraOffset } = decodeRenderOrder(renderOrder);
  return `floor=${floor} role=${role} intra=${intraOffset} (raw=${renderOrder})`;
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _clampIntra(offset) {
  const n = Number(offset) || 0;
  return Math.max(0, Math.min(MAX_INTRA_ROLE_OFFSET, Math.round(n)));
}
