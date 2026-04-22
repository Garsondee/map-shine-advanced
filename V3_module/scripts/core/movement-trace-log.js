/**
 * @fileoverview Unified movement/stair debug traces for Foundry console filtering.
 *
 * Filter the browser console with: MS-MOVE-TRACE
 *
 * @module core/movement-trace-log
 */

/** Console substring to filter all movement trace lines */
export const MOVEMENT_TRACE_FILTER = 'MS-MOVE-TRACE';

const DEFAULT_PHASE_ALLOWLIST = new Set([
  'executeDoorAware.start',
  'executeDoorAware.pathOk',
  'executeDoorAware.pathFailed',
  'executeDoorAware.crossFloor.try',
  'executeDoorAware.crossFloor.ok',
  'executeDoorAware.crossFloor.fail',
  'executeDoorAware.foundryCheckpoint.try',
  'executeDoorAware.foundryCheckpoint.ok',
  'executeDoorAware.foundryCheckpoint.fail',
  'executeDoorAware.finalStepRepair.start',
  'executeDoorAware.finalStepRepair.ok',
  'executeDoorAware.finalStepRepair.fail',
  'executeDoorAware.complete',
  'executeDoorAware.throw',
  'zoneStair.transition.start',
  'zoneStair.transition.done'
]);

/**
 * @param {string} phase - Short event id (e.g. executeDoorAware.start)
 * @param {Record<string, unknown>} [detail] - JSON-friendly fields only
 */
export function moveTrace(phase, detail = {}) {
  try {
    const cfg = globalThis?.window?.MapShine?.movementTrace || {};
    const enabled = cfg.enabled !== false;
    if (!enabled) return;
    const verbose = cfg.verbose === true;
    if (!verbose && !DEFAULT_PHASE_ALLOWLIST.has(String(phase || ''))) return;
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
