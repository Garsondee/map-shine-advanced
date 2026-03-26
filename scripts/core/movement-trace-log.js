/**
 * @fileoverview Unified movement/stair debug traces for Foundry console filtering.
 *
 * Filter the browser console with: MS-MOVE-TRACE
 *
 * @module core/movement-trace-log
 */

/** Console substring to filter all movement trace lines */
export const MOVEMENT_TRACE_FILTER = 'MS-MOVE-TRACE';

/**
 * @param {string} phase - Short event id (e.g. executeDoorAware.start)
 * @param {Record<string, unknown>} [detail] - JSON-friendly fields only
 */
export function moveTrace(phase, detail = {}) {
  try {
    const line = {
      t: Date.now(),
      phase,
      ...detail
    };
    console.info(`[${MOVEMENT_TRACE_FILTER}]`, phase, line);
  } catch (_) {
  }
}

/**
 * @param {object|null|undefined} co
 * @returns {Record<string, unknown>|null}
 */
export function moveTraceConstrainSnapshot(co) {
  if (!co || typeof co !== 'object') return null;
  return {
    ignoreWalls: co.ignoreWalls === true,
    ignoreCost: co.ignoreCost === true,
    destinationFloorBottom: co.destinationFloorBottom,
    destinationFloorTop: co.destinationFloorTop
  };
}
