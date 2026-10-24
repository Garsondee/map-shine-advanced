/**
 * TOKEN ACTIVITY — every placed token's LIVE position, as plain data.
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHY IT IS NOT `scene-tokens.js#collectTokens`
 * ============================================================================
 *
 * `collectTokens` answers "what does the renderer draw" from the SCENE
 * DOCUMENT: level-filtered, drag-preview-aware, alpha-faded — the shape a
 * drawable needs. Nothing here wants any of that. This answers a narrower,
 * more frequent question — "where are the tokens, right now" — for
 * consumers that react to position rather than paint it: the mantle's
 * trample stamp queue (`effects/precipitation/precip-subsystem.js`) and
 * critter proximity (`effects/critters/critter-subsystem.js`) today; per the
 * goal this is meant to outlive both (`docs/planning/Precipitation.md` §5.2
 * already named the gap this closes: *"small CPU-side stamp queue flushed at
 * mantle cadence, positions from the token layer MSA already reads"*).
 *
 * So this reads `canvas.tokens.placeables` LIVE, every call, the same
 * pattern `player-light-mode.js#readActivePlayerCarriedLightTokens` already
 * uses for the identical reason: a PlaceableObject's `.center`/`.w`/`.h`
 * track Foundry's own mid-move animation, where the TokenDocument's `.x`/`.y`
 * only update once a move is COMMITTED. A consumer that wants to react
 * smoothly as a token walks — not only after Foundry finishes the step —
 * needs the live object, not the document.
 *
 * ⚠️ NO HOOK, DELIBERATELY. V2's `AshDisturbanceEffectV2` drove its burst
 * from a single `Hooks.on('updateToken', ...)` — a discrete "a move just
 * landed" event with no velocity, no proximity, nothing continuous
 * (confirmed by reading its final code). A hook-driven design also means
 * resubscribing on every floor/scene change and a lifecycle to get wrong.
 * This module instead hands back a plain snapshot on demand; a caller that
 * wants motion compares two snapshots itself (`world/token-activity.js#
 * deriveTokenMotion`) — polling a cheap, pure read is simpler than owning a
 * hook's lifecycle, and it is continuous for free.
 *
 * @module foundry/token-activity
 */
import { resolveTokenLevel } from './scene-tokens.js';

/**
 * @typedef {object} TokenPoint
 * @property {string} id
 * @property {number} x - world px, the token's footprint CENTRE (unlike
 *   `scene-tokens.js`'s `footprint`, which is top-left — centre is what
 *   "where is this token standing" means for every consumer here).
 * @property {number} y
 * @property {number} elevation
 * @property {number} disposition - `CONST.TOKEN_DISPOSITIONS` raw value.
 * @property {boolean} hidden
 * @property {number} radiusPx - half the token's smaller on-screen side; 0
 *   if indeterminate. The disturbance footprint a body this size should
 *   leave, same quantity `player-light-mode.js` uses for its light's rim.
 */

/**
 * Every live token on the canvas, optionally narrowed to one level.
 *
 * @param {object} [options]
 * @param {string} [options.levelId] - keep only tokens resolving to this
 *   level (`resolveTokenLevel`'s fallback target too, so an unassigned token
 *   — the common case on a single-level scene — matches it). Omit to return
 *   every token regardless of level.
 * @param {Array<string>|Set<string>} [options.knownLevelIds] - the scene's
 *   real level ids; required for `levelId` to resolve an unassigned token
 *   correctly rather than only matching an exact raw `token.level`.
 * @param {boolean} [options.includeHidden=false] - a hidden token's position
 *   is a GM secret; a disturbance trail revealing it is a real gameplay
 *   leak, not a rendering nicety, so the default keeps it out. A caller that
 *   wants a hidden creature to disturb the ground anyway (an author's
 *   choice, not an accident) can opt in.
 * @returns {TokenPoint[]}
 */
export function collectActiveTokenPoints({ levelId, knownLevelIds, includeHidden = false } = {}) {
  if (typeof canvas === 'undefined' || !canvas?.tokens?.placeables) return [];
  const known = knownLevelIds instanceof Set ? knownLevelIds : knownLevelIds ? new Set(knownLevelIds) : null;

  const out = [];
  for (const token of canvas.tokens.placeables) {
    const doc = token?.document;
    if (!doc) continue;
    if (doc.hidden && !includeHidden) continue;

    if (levelId) {
      const resolved = known ? resolveTokenLevel(doc, known, levelId) : doc.level || levelId;
      if (resolved !== levelId) continue;
    }

    const center = token.center ?? { x: doc.x ?? 0, y: doc.y ?? 0 };
    const bodyPx = Math.min(Number(token.w) || 0, Number(token.h) || 0);
    const elevation = Number(doc.elevation);
    const disposition = Number(doc.disposition);

    out.push({
      id: doc.id ?? token.id,
      x: center.x,
      y: center.y,
      elevation: Number.isFinite(elevation) ? elevation : 0,
      disposition: Number.isFinite(disposition) ? disposition : 0,
      hidden: !!doc.hidden,
      radiusPx: bodyPx > 0 ? bodyPx / 2 : 0,
    });
  }
  return out;
}
