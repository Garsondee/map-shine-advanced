/**
 * PLAYER TORCH ANCHORS — THE PURE HALF (mythica-machina-press#77/#578). Turns a live
 * per-token snapshot (`foundry/player-light-mode.js#readActivePlayerCarriedLightTokens`'s
 * own shape) plus the scene's resolved GM allowance
 * (`foundry/player-light-permissions.js#resolvePlayerLightPermissions`'s own shape) into
 * one `{x, y, id, burn01?}` anchor per active, allowed torch: where its fire burns this
 * frame and how well. No THREE, no Foundry, re-derived fresh every call, matching
 * `player-light-geometry.js`'s own "PURE HALF" discipline.
 *
 * The fire itself (flame sprites and sparks) is `player-torch-fire-geometry.js` /
 * `player-torch-fire-render.js`. This file used to feed a 26 px candle flame and five
 * embers that rose toward screen-north; both are gone (see the fire module's header).
 *
 * @module effects/player-torch-flame-geometry
 */

import {
  resolveLightPosition,
  resolveTorchBurn01,
  hasCarriedLightAim,
  PLAYER_TORCH_OUT_BELOW_BURN01,
} from './lighting/player-light-geometry.js';

/**
 * Every currently-active, currently-allowed, currently-STEERED torch (not
 * flashlight, not a vision-mode pick) as a fire anchor. Mirrors
 * `player-light-geometry.js#buildPlayerLightSources`'s own filter shape (mode +
 * scene permission + a live aim — a torch nobody is holding out has no fire, see
 * `hasCarriedLightAim`) but produces only what the fire needs.
 *
 * @param {Array<{tokenId: string, x: number, y: number, mode: string}>} tokenSnapshots -
 *   `foundry/player-light-mode.js#readActivePlayerCarriedLightTokens`'s own shape.
 * @param {{modes: Record<string, boolean>}} permissions - `resolvePlayerLightPermissions`'s own shape.
 * @returns {Array<{x: number, y: number, id: string, burn01?: number}>}
 */
export function buildPlayerTorchFlameAnchors(tokenSnapshots, permissions) {
  const list = Array.isArray(tokenSnapshots) ? tokenSnapshots : [];
  const out = [];
  for (const snap of list) {
    if (snap?.mode !== 'torch') continue; // a flashlight or a vision-mode pick: no fire
    if (permissions?.modes?.torch !== true) continue; // the GM has not (or no longer) allowed torch on this scene
    // NO AIM IS NO FIRE (2026-10-15) — the very same gate the light itself uses
    // (`player-light-geometry.js#hasCarriedLightAim`): a torch nobody is steering
    // is a torch nobody is holding out, and neither it nor the light that goes
    // with it is built at all.
    if (!hasCarriedLightAim(snap)) continue;
    // The fire rides the light: wherever the bearer holds the torch out to
    // (`resolveLightPosition`), not the token's centre.
    const { x, y } = resolveLightPosition(snap);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // A torch that has gone out has no fire; one that is guttering has a smaller, redder one.
    const burn01 = resolveTorchBurn01(snap);
    if (burn01 < PLAYER_TORCH_OUT_BELOW_BURN01) continue;
    const anchor = { x, y, id: String(snap?.tokenId ?? '') };
    // Carried only when it matters, so the viewer's anchor signature (which hashes it)
    // redraws a fire that only changed size or colour.
    if (burn01 < 1) anchor.burn01 = burn01;
    out.push(anchor);
  }
  return out;
}
