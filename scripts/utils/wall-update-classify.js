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

/**
 * Wall door mesh animation duration (ms). Foundry often omits `animation.duration`;
 * `0` / NaN must not be used or the door snaps in ~1ms and fog LOS sync has no
 * in-between frames.
 *
 * @param {object|null|undefined} wallDoc
 * @param {number} [fallbackMs=500]
 * @returns {number}
 */
export function resolveWallDoorAnimationDurationMs(wallDoc, fallbackMs = 500) {
  const raw = Number(wallDoc?.animation?.duration);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const rawSrc = Number(wallDoc?._source?.animation?.duration);
  if (Number.isFinite(rawSrc) && rawSrc > 0) return rawSrc;
  const fb = Number(fallbackMs);
  return Number.isFinite(fb) && fb > 0 ? fb : 500;
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
