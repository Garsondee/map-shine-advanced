/**
 * Foundry `updateWall` hook payloads may nest deltas under `diff`.
 * @param {object|null|undefined} changes
 * @returns {Record<string, unknown>}
 */
export function flattenWallUpdateChanges(changes) {
  if (!changes || typeof changes !== 'object') return {};
  const { diff, ...rest } = changes;
  const d = diff && typeof diff === 'object' ? diff : null;
  return d ? { ...d, ...rest } : { ...rest };
}

const WALL_GEOM_KEYS = ['c', 'door', 'move', 'sight', 'light', 'sound'];

/**
 * Door open/close/lock: `ds` changes without wall segment geometry or channel flags.
 * Used to skip expensive PIXI bridge/template invalidation and Three wall rebuilds.
 *
 * @param {object|null|undefined} changes
 * @returns {boolean}
 */
export function isWallDoorStateOnlyUpdate(changes) {
  const f = flattenWallUpdateChanges(changes);
  if (!Object.prototype.hasOwnProperty.call(f, 'ds')) return false;
  return !WALL_GEOM_KEYS.some((k) => Object.prototype.hasOwnProperty.call(f, k));
}
