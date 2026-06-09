/**
 * @fileoverview Resolve the subject token for per-client contextual probing.
 * @module core/context-grade/subject-token-resolver
 */

import { isGmLike } from '../gm-parity.js';
import Coordinates from '../../utils/coordinates.js';

/**
 * @typedef {Object} SubjectTokenResolverState
 * @property {string|null} [lastControlledTokenId]
 */

/**
 * @param {Token|object|null} token
 * @returns {boolean}
 */
export function canUserUseTokenForContext(token) {
  if (!token) return false;
  try {
    if (isGmLike()) return true;
    const doc = token.document ?? token;
    if (doc?.isOwner === true) return true;
    if (typeof token.isOwner === 'boolean' && token.isOwner) return true;
    const actor = doc?.actor ?? token.actor;
    if (actor?.isOwner === true) return true;
  } catch (_) {
  }
  return false;
}

/**
 * @param {Token|object|null} token
 * @returns {string|null}
 */
export function getTokenDocumentId(token) {
  if (!token) return null;
  try {
    return token.document?.id ?? token.id ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the token id used for contextual scene grade probing.
 *
 * - GM: prefers sticky last controlled token when still controlled, else controlled[0]
 * - Player: controlled[0] when the user owns that token
 *
 * @param {SubjectTokenResolverState} [state]
 * @returns {string|null}
 */
export function resolveSubjectTokenId(state = {}) {
  const isGM = !!isGmLike();

  try {
    const controlled = canvas?.tokens?.controlled;
    if (!Array.isArray(controlled) || controlled.length === 0) return null;

    if (isGM) {
      const last = state.lastControlledTokenId;
      if (last) {
        const t = canvas.tokens.get(last);
        if (t?.controlled && canUserUseTokenForContext(t)) return last;
      }
    }

    const t0 = controlled[0];
    if (!canUserUseTokenForContext(t0)) return null;
    return getTokenDocumentId(t0);
  } catch (_) {
  }

  return null;
}

/**
 * @param {string|null} tokenId
 * @returns {Token|null}
 */
export function getTokenPlaceableById(tokenId) {
  if (!tokenId) return null;
  try {
    return canvas?.tokens?.get?.(tokenId) ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Token center in Foundry scene coordinates (pixels).
 * Prefers the live Three.js sprite position so pathfinding movement is sampled
 * correctly (token document x/y may lag until each segment completes).
 *
 * @param {string|null} tokenId
 * @returns {{ x: number, y: number }|null}
 */
export function getSubjectTokenCenterFoundry(tokenId) {
  if (!tokenId) return null;

  try {
    const tm = window.MapShine?.tokenManager;
    const sprite = tm?.getTokenSprite?.(tokenId);
    if (sprite?.position) {
      const foundry = Coordinates.toFoundry(sprite.position.x, sprite.position.y);
      if (Number.isFinite(foundry.x) && Number.isFinite(foundry.y)) {
        return { x: foundry.x, y: foundry.y };
      }
    }
  } catch (_) {
  }

  const token = getTokenPlaceableById(tokenId);
  const doc = token?.document;
  if (!doc) return null;

  const x = Number(doc.x);
  const y = Number(doc.y);
  const w = Number(doc.width ?? doc.w ?? 1);
  const h = Number(doc.height ?? doc.h ?? 1);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return {
    x: x + (Number.isFinite(w) ? w * 0.5 : 0),
    y: y + (Number.isFinite(h) ? h * 0.5 : 0),
  };
}

/**
 * Remember the last controlled token for GM sticky selection.
 *
 * @param {SubjectTokenResolverState} state
 * @param {string|null} tokenId
 */
export function noteControlledTokenId(state, tokenId) {
  if (!state || !tokenId) return;
  state.lastControlledTokenId = tokenId;
}
