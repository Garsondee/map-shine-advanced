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
