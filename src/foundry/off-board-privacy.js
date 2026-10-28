/**
 * OFF THE BOARD — the Table's privacy rule for tokens on the velvet.
 *
 * The author, 2026-10-27, on the Table effect: *"GM and players could put things
 * on the green velvet to show it as being essentially on the table but off the
 * board … Players should never have vision of what a GM has placed in this area
 * but can see their own tokens if they have ownership."*
 *
 * "On the velvet" is the scene's padding: a token whose centre lies outside
 * `dimensions.sceneRect`. Foundry alone does not keep those private:
 *  - with token vision off, `Token#isVisible` shows every non-hidden token;
 *  - `CanvasVisibility#testVisibility` (foundry.mjs v14, ~178371) lets a vision
 *    source that is itself in the padding see other padding points — so a
 *    player's own token parked on the table would see the GM's there.
 *
 * Two doors close it, both keyed on the one rule below:
 *  1. MSA's own draw list (`collectTokens`'s `offBoard` option) never builds
 *     the art of a token this user may not see;
 *  2. Foundry's own token (border, nameplate, bars, effects, hover) is hidden in
 *     a `refreshToken` hook — the hook Foundry calls right after
 *     `_refreshVisibility` sets `token.visible = token.isVisible`
 *     (`PlaceableObject#applyRenderFlags`, foundry.mjs v14 ~54970).
 *
 * @module foundry/off-board-privacy
 */

import { tokenFootprint, GRID_TYPES } from './scene-geometry.js';

/**
 * Is a world point off the board (in the scene's padding)?
 * @param {number} x @param {number} y
 * @param {{x:number,y:number,width:number,height:number}} sceneRect
 */
export function isOffBoardPoint(x, y, sceneRect) {
  if (!sceneRect) return false;
  return x < sceneRect.x || y < sceneRect.y || x > sceneRect.x + sceneRect.width || y > sceneRect.y + sceneRect.height;
}

/**
 * THE RULE. The GM sees everything; a player sees a token on the table only if
 * they own it. On the board, or with a public table, it does nothing.
 * @param {{privateTable:boolean, offBoard:boolean, isGM:boolean, isOwner:boolean}} a
 * @returns {boolean} true when the token must be hidden from this user.
 */
export function hideOffBoardToken({ privateTable, offBoard, isGM, isOwner }) {
  if (!privateTable || !offBoard || isGM) return false;
  return !isOwner;
}

/**
 * Apply the rule to a TokenDocument (or its data).
 * @param {object} token - `x`/`y` (px, top-left), `width`/`height` (grid units), `isOwner`.
 * @param {object} opts
 * @param {{x:number,y:number,width:number,height:number}} opts.sceneRect
 * @param {number} opts.gridSize
 * @param {number} [opts.gridType]
 * @param {boolean} opts.privateTable
 * @param {boolean} opts.isGM
 */
export function isTokenHiddenOffBoard(
  token,
  { sceneRect, gridSize, gridType = GRID_TYPES.SQUARE, privateTable, isGM }
) {
  if (!privateTable || isGM || !token) return false;
  const f = tokenFootprint(token, gridSize, gridType);
  const cx = (token.x ?? 0) + f.width / 2;
  const cy = (token.y ?? 0) + f.height / 2;
  return hideOffBoardToken({
    privateTable,
    offBoard: isOffBoardPoint(cx, cy, sceneRect),
    isGM,
    isOwner: token.isOwner === true,
  });
}

let installed = false;
let readPrivate = () => false;

/**
 * Hide Foundry's own token objects that the rule hides. Idempotent: the
 * predicate is replaced, the hook is registered once.
 * @param {{isPrivateTable: () => boolean}} opts - read on every refresh, so a GM
 *   turning the Table on or off takes effect at the next refresh.
 */
export function installOffBoardPrivacy({ isPrivateTable }) {
  readPrivate = typeof isPrivateTable === 'function' ? isPrivateTable : () => false;
  if (installed || typeof Hooks === 'undefined') return;
  installed = true;
  Hooks.on('refreshToken', (tokenObj) => {
    const doc = tokenObj?.document;
    const dims = canvas?.dimensions;
    if (!doc || !dims || tokenObj.isPreview || !tokenObj.visible) return;
    const hidden = isTokenHiddenOffBoard(doc, {
      sceneRect: dims.sceneRect,
      gridSize: dims.size,
      gridType: canvas.grid?.type,
      privateTable: readPrivate() === true,
      isGM: game.user?.isGM === true,
    });
    if (!hidden) return;
    tokenObj.visible = false;
    if (tokenObj.mesh) tokenObj.mesh.visible = false;
  });
}

/** Ask every token to re-run its visibility (after the Table's privacy changes). */
export function refreshOffBoardPrivacy() {
  if (typeof canvas === 'undefined' || !canvas?.tokens?.placeables) return;
  for (const t of canvas.tokens.placeables) t.renderFlags?.set({ refreshVisibility: true });
}
