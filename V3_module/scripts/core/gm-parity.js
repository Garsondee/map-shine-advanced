/**
 * GM parity switch for debugging (e.g. player vs GM loading differences).
 *
 * When `MAPSHINE_DEBUG_GM_PARITY` is true, {@link isGmLike} is always true, so
 * mask discovery, scene flags, UI gates, fog/path helpers, and other former
 * `game.user.isGM` checks behave like the GM client.
 *
 * Set to `false` for production, then restore normal behavior. Re-tighten UI
 * by guarding scene control buttons with real `game.user.isGM` where desired.
 *
 * @module core/gm-parity
 */

export const MAPSHINE_DEBUG_GM_PARITY = true;

/**
 * @returns {boolean}
 */
export function isGmLike() {
  return MAPSHINE_DEBUG_GM_PARITY ? true : !!globalThis.game?.user?.isGM;
}

/**
 * Use before Scene#setFlag / scene.update. Foundry's server rejects Scene updates
 * from non-GMs; {@link isGmLike} must not be used for persistence (debug parity).
 * @returns {boolean}
 */
export function canPersistSceneDocument() {
  return !!globalThis.game?.user?.isGM;
}
