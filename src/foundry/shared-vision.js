/**
 * SHARED PARTY VISION — every token a player owns keeps contributing vision,
 * whichever one is selected.
 *
 * ⚠️ WHY THIS EXISTS. Foundry's `Token#_isVisionSource` (v14 token.mjs:983)
 * makes a token a vision source only when it is CONTROLLED, or — for a non-GM —
 * when it is observable AND the user controls no other token with sight. So the
 * moment a player (or the GM, who sees what the selected token sees) selects
 * ONE of a player's five tokens, the other four stop being sources and their
 * own cells go black ("unexplored") — exactly the screenshot that prompted
 * this. Vision is meant to be shared across a player's tokens.
 *
 * THE RULE (additive — core's verdict is never overridden to `false`):
 *   - non-GM: any token the viewer OWNS, with sight, is a source.
 *   - GM: any token with sight that shares a (non-GM) owner with a token the GM
 *     has selected is a source. Selecting an NPC adds nothing — the GM is
 *     deliberately seeing through one creature's eyes.
 * The shared gates stay core's: token vision on, `hasSight`, the viewed level,
 * and hidden tokens only for the GM.
 *
 * The decision is pure (`sharesVisionWith`) so Node can prove it; the patch is
 * one guarded wrap of one method, and any throw falls back to core's answer.
 * Core re-runs `initializeVisionSource` on every placeable at every control and
 * release (`Token#_onControl`/`_onRelease`), so no extra refresh hook is needed.
 */

/**
 * Should a token that core did NOT make a vision source become one?
 *
 * @param {object} args
 * @param {boolean} args.isGM - the viewing client is a GM.
 * @param {boolean} args.ownedByViewer - the viewing user owns this token.
 * @param {Iterable<string>} args.tokenOwnerIds - non-GM users owning THIS token.
 * @param {Iterable<string>} args.controlledOwnerIds - non-GM users owning any
 *   token the viewer has selected (with sight).
 * @returns {boolean}
 */
export function sharesVisionWith({ isGM, ownedByViewer, tokenOwnerIds, controlledOwnerIds }) {
  if (!isGM) return ownedByViewer === true;
  const controlled = new Set(controlledOwnerIds ?? []);
  if (controlled.size === 0) return false;
  for (const id of tokenOwnerIds ?? []) if (controlled.has(id)) return true;
  return false;
}

/** Non-GM user ids that own this token (OWNER permission on its document). */
function nonGmOwnerIds(token) {
  const ids = [];
  for (const user of game.users ?? []) {
    if (user.isGM) continue;
    if (token.document?.testUserPermission?.(user, 'OWNER')) ids.push(user.id);
  }
  return ids;
}

const PATCH_FLAG = Symbol.for('map-shine-advanced.sharedVision');

/**
 * Wrap `Token#_isVisionSource` once. Idempotent; returns a status for the log.
 * @returns {{installed: boolean, reason: string}}
 */
export function installSharedVision() {
  try {
    const proto = CONFIG?.Token?.objectClass?.prototype;
    const core = proto?._isVisionSource;
    if (typeof core !== 'function') return { installed: false, reason: 'Token#_isVisionSource not found' };
    if (core[PATCH_FLAG]) return { installed: true, reason: 'already installed' };

    const wrapped = function _isVisionSourceShared() {
      const coreVerdict = core.call(this);
      if (coreVerdict) return true;
      try {
        // Core's own preconditions, restated — core returns false for them AND
        // for "not selected", and we may only override the latter.
        if (!canvas.visibility?.tokenVision || !this.hasSight) return false;
        if (this.document.level !== canvas.level?.id) return false;
        const isGM = game.user.isGM;
        if (this.document.hidden && !isGM) return false;

        let controlledOwnerIds = [];
        if (isGM) {
          const owners = new Set();
          for (const t of this.layer.controlled) {
            if (!t.hasSight || t.document.hidden) continue;
            for (const id of nonGmOwnerIds(t)) owners.add(id);
          }
          controlledOwnerIds = owners;
        }
        return sharesVisionWith({
          isGM,
          ownedByViewer: this.document.testUserPermission?.(game.user, 'OWNER') === true,
          tokenOwnerIds: isGM ? nonGmOwnerIds(this) : [],
          controlledOwnerIds,
        });
      } catch {
        return coreVerdict;
      }
    };
    wrapped[PATCH_FLAG] = true;
    proto._isVisionSource = wrapped;
    return { installed: true, reason: 'wrapped Token#_isVisionSource' };
  } catch (err) {
    return { installed: false, reason: `install threw: ${err?.message ?? err}` };
  }
}
