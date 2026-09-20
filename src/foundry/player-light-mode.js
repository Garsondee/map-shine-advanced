/**
 * PLAYER-LIGHT MODE — one TOKEN's own live choice of carried light/vision
 * mode (mythica-machina-press#77). Deliberately separate from
 * `player-light-permissions.js`: that module is the GM's scene-wide
 * allowance list (GM-write-only, one flag on the Scene document); this one is
 * a single player's own pick for their own token (owner-write, one flag PER
 * Token document) — two different documents, two different writers, no
 * reason to force them through one module just because they're both "player
 * light" state.
 *
 * `writeTokenPlayerLightMode` relies on Foundry's OWN permission model for
 * "can this client write this token's flag" (a player normally has UPDATE
 * permission on a token they own — Foundry's default actor/token ownership
 * rule, not something this module re-implements) — same never-throw
 * `{ok, reason}` posture as every other write in `foundry/`, since a token a
 * player does NOT own will reject the `setFlag` call.
 *
 * @module foundry/player-light-mode
 */

export const PLAYER_LIGHT_MODE_NAMESPACE = 'map-shine-advanced';
export const PLAYER_LIGHT_MODE_FLAG = 'playerLightMode';

/** The six modes #77 defines — mirrors `player-light-permissions.js#PLAYER_LIGHT_MODE_KEYS`
 * (kept as a separate copy rather than a shared import: one is the GM's
 * allowance-map KEY SET, this is the valid VALUE set for one token's own
 * flag — they happen to be the same six strings today, but a future mode
 * that's selectable-but-never-independently-allowed, or vice versa, would
 * need them to diverge, and importing one from the other would wrongly imply
 * they must always agree). */
export const PLAYER_LIGHT_MODES = Object.freeze([
  'torch',
  'flashlight',
  'nightVision',
  'lowLight',
  'infravision',
  'activeInfravision',
]);

/**
 * Read one token document's own player-light mode flag.
 * @param {{getFlag?: (ns: string, key: string) => unknown}|null|undefined} tokenDocument
 * @returns {string|null} one of `PLAYER_LIGHT_MODES`, or `null` (no light carried).
 */
export function readTokenPlayerLightMode(tokenDocument) {
  try {
    const raw = tokenDocument?.getFlag?.(PLAYER_LIGHT_MODE_NAMESPACE, PLAYER_LIGHT_MODE_FLAG);
    return PLAYER_LIGHT_MODES.includes(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Write one token document's own player-light mode flag — the OWNER's write
 * (normally the player controlling that token; a GM owns everything too).
 * `null` clears it ("carrying no light").
 * @param {{setFlag?: (ns: string, key: string, value: unknown) => Promise<unknown>}|null|undefined} tokenDocument
 * @param {string|null} mode
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeTokenPlayerLightMode(tokenDocument, mode) {
  try {
    if (!tokenDocument || typeof tokenDocument.setFlag !== 'function') {
      return { ok: false, reason: 'no token document to write to' };
    }
    const value = PLAYER_LIGHT_MODES.includes(mode) ? mode : null;
    await tokenDocument.setFlag(PLAYER_LIGHT_MODE_NAMESPACE, PLAYER_LIGHT_MODE_FLAG, value);
    return { ok: true, reason: null };
  } catch (err) {
    return {
      ok: false,
      reason: `writing this token's player-light mode failed (do you own it?): ${err?.message ?? err}`,
    };
  }
}

/**
 * Live snapshot of every placed token on the CURRENT scene carrying a
 * player-light mode — the raw per-token facts (position, elevation, mode),
 * nothing resolved against scene permissions yet (that's
 * `effects/lighting/player-light-geometry.js#buildPlayerLightSources`'s own
 * job, kept pure and Node-testable rather than mixed in here).
 *
 * Reads `token.center`/`token.document.elevation` LIVE, every call — no
 * caching — since this is the per-frame seam `point-light-pool.js`'s own
 * `getPlayerCarriedLightSources` injection point reads (mirrors
 * `getFireLightSources`'s own "recomputed every frame" contract): a moving
 * token's carried torch must follow it in real time, on every connected
 * client, since every client independently renders from this SAME live
 * Foundry document state (the flag is a synced Token document flag, not a
 * client-local setting).
 *
 * @returns {Array<{tokenId: string, x: number, y: number, elevation: number, mode: string}>}
 */
export function readActivePlayerCarriedLightTokens() {
  if (typeof canvas === 'undefined' || !canvas?.tokens?.placeables) return [];
  const out = [];
  for (const token of canvas.tokens.placeables) {
    if (token?.document?.hidden) continue;
    const mode = readTokenPlayerLightMode(token.document);
    if (!mode) continue;
    const center = token.center ?? { x: token.document?.x ?? 0, y: token.document?.y ?? 0 };
    const elevation = Number(token.document?.elevation);
    out.push({
      tokenId: token.document?.id ?? token.id,
      x: center.x,
      y: center.y,
      elevation: Number.isFinite(elevation) ? elevation : 0,
      mode,
    });
  }
  return out;
}
