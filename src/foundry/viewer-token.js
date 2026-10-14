/**
 * VIEWER TOKEN — "which placed Token is THIS client's own character," the one
 * resolver every per-viewer feature (the scene intro zoom, the player-carried
 * light picker) needs and must agree on. Extracted from `scene-intro-zoom.js`
 * (2026-09-20, mythica-machina-press#77) once a second real consumer showed
 * up — a single private copy was fine for one caller; two callers silently
 * drifting on "which token is mine" is exactly the kind of duplicate-source-
 * of-truth bug this codebase's `zones/one-door` discipline exists to avoid.
 *
 * Deliberately does NOT exclude a GM — "the token I, this client, control" is
 * a well-defined question for a GM too (a GM can own tokens), it is only
 * MEANINGLESS for some callers' own purpose (the intro zoom, "zoom my own
 * character in" — a GM has no single personal character). Callers that need
 * to exclude a GM check `game.user.isGM` themselves at their own call site
 * (see `scene-intro-zoom.js#runSceneIntroZoom` for the precedent) rather than
 * this resolver silently returning null for every GM regardless of what the
 * caller actually wanted.
 *
 * @module foundry/viewer-token
 */

/**
 * Find the token THIS client's viewing user should treat as "my own," or
 * `null`.
 *
 * Prefers `game.user.character` (the user's explicitly assigned Actor) — the
 * same "this IS my character" signal Foundry's own UI treats as authoritative
 * — and looks for ITS token on the current scene first, since a user can own
 * tokens (by permission) that are not "theirs" in this sense (an NPC a GM
 * granted them edit rights to, for instance). Falls back to "any token this
 * user owns" only if no assigned-character token is present, so a player
 * without a formal character assignment still gets resolved to whatever they
 * actually control.
 *
 * @returns {*|null} a placed Token, or null (nothing to resolve to).
 */
export function resolveViewerToken() {
  if (typeof canvas === 'undefined' || !canvas?.tokens?.placeables) return null;
  const placeables = canvas.tokens.placeables;
  const characterId = game?.user?.character?.id;
  if (characterId) {
    const own = placeables.find((t) => t.actor?.id === characterId && !t.document?.hidden);
    if (own) return own;
  }
  return placeables.find((t) => t.isOwner && !t.document?.hidden) ?? null;
}

/**
 * Does an ACTIVE (logged-in) non-GM user own this token? Such a token is steered
 * by its player's own client, so a GM must not also steer it.
 * @param {*} token - a placed Token.
 * @returns {boolean}
 */
function isOwnedByActivePlayer(token) {
  try {
    return (
      game.users?.some?.(
        (user) => user?.active && !user.isGM && token.document?.testUserPermission?.(user, 'OWNER')
      ) === true
    );
  } catch {
    return false;
  }
}

/**
 * THE TOKEN THIS CLIENT'S CARRIED LIGHT BELONGS TO — the one answer the picker,
 * the cursor-aim channel and the vision-mode grade all need to agree on.
 *
 * - A PLAYER: their own character's token ({@link resolveViewerToken}).
 * - A GM: the token they have SELECTED, so a GM can give an NPC a torch or a
 *   flashlight, steer it with their own cursor, and try the vision modes on it
 *   (the grade tints the GM's own view while that token is selected). A selected
 *   token an active player owns is skipped: that player's client steers it, and
 *   two cursors must not fight over one beam (this is also why a GM who selects
 *   a PC just to read its sheet cannot drag the player's flashlight around).
 *
 * `reason` says why there is no token: `'no-canvas'`, `'no-token'` (a player with
 * no token on this scene), `'none-selected'` (a GM with nothing selected), or
 * `'player-active'` (a GM whose selection is all player-steered; `blockedName`
 * names the first).
 *
 * @returns {{token: *|null, reason: string|null, blockedName?: string}}
 */
export function resolveCarriedLightTarget() {
  if (typeof canvas === 'undefined' || !canvas?.tokens) return { token: null, reason: 'no-canvas' };
  if (typeof game === 'undefined' || game?.user?.isGM !== true) {
    const token = resolveViewerToken();
    return token ? { token, reason: null } : { token: null, reason: 'no-token' };
  }
  const controlled = Array.isArray(canvas.tokens.controlled) ? canvas.tokens.controlled : [];
  let blocked = null;
  for (const token of controlled) {
    if (!token?.document) continue;
    if (isOwnedByActivePlayer(token)) {
      blocked ??= token;
      continue;
    }
    return { token, reason: null };
  }
  if (blocked)
    return { token: null, reason: 'player-active', blockedName: String(blocked.name ?? blocked.document?.name ?? '') };
  return { token: null, reason: 'none-selected' };
}

/**
 * @returns {*|null} {@link resolveCarriedLightTarget}'s token, or null.
 */
export function resolveCarriedLightToken() {
  return resolveCarriedLightTarget().token;
}

/**
 * Is the CURRENT client's user a GM? A one-line door onto `game.user.isGM`
 * for callers OUTSIDE `foundry/`/`diag/` (the `foundry/adapter-only` wall —
 * `tools/verify-structure.mjs` — forbids touching `game.user` directly from
 * anywhere else) that need the same GM-exclusion check
 * `scene-intro-zoom.js#runSceneIntroZoom` already makes inline (that
 * module lives IN `foundry/`, so it reads the global directly; a UI-zone
 * caller like `ui/rooms/player-light-picker.js` cannot, and shouldn't have
 * to re-derive this one-line fact its own way).
 * @returns {boolean}
 */
export function isViewingUserGM() {
  return typeof game !== 'undefined' && game?.user?.isGM === true;
}

/**
 * Call `onChange` whenever the answer to {@link resolveViewerToken} might
 * have changed: a token created or deleted, or one updated in a way that
 * matters to it (actor, hidden) or to its carried light (this module's own
 * flags) — e.g. the GM places a player's token while that player has the
 * Performance & Graphics room open, or changes their light from the GM's
 * seat. A plain move is ignored. Never throws; returns an unsubscribe.
 * @param {() => void} onChange
 * @returns {() => void}
 */
export function watchViewerToken(onChange) {
  if (typeof onChange !== 'function' || typeof Hooks === 'undefined') return () => {};
  const fire = () => {
    try {
      onChange();
    } catch (err) {
      void err;
    }
  };
  const onUpdate = (_doc, change) => {
    if (!change) return;
    if ('actorId' in change || 'hidden' in change || change.flags?.['map-shine-advanced']) fire();
  };
  const ids = [
    ['createToken', Hooks.on('createToken', fire)],
    ['deleteToken', Hooks.on('deleteToken', fire)],
    ['updateToken', Hooks.on('updateToken', onUpdate)],
    // A GM's carried-light token is whichever one they have selected.
    ['controlToken', Hooks.on('controlToken', fire)],
  ];
  return () => {
    for (const [hook, id] of ids) {
      try {
        Hooks.off(hook, id);
      } catch (err) {
        void err;
      }
    }
  };
}
