/**
 * FOG OF WAR LOOK — the Fog of War card's values (`fog-of-war.js`) turned into what the fog shaders take
 * (`vision-mask-render.js#createFogLookUniforms`). Pure; the viewer calls it once a frame.
 *
 * @module effects/vision/fog-of-war-look
 */

import { FOG_OF_WAR_PARAMS } from './fog-of-war.js';

/** What the card OFF draws: the same field, with every flourish at rest. */
const PLAIN = Object.freeze({
  edgeSoftness: 0,
  ink: 0,
  motion: 0,
  revealSec: 0,
  memoryColour: 1,
  mist: 0,
  gridOverMemory: 0.3,
});

const num = (v, fallback, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/**
 * The card's values → what the fog shaders take. World sizes come out in world px for `gridPx`.
 * Never throws; anything missing or broken is its shipped default.
 * @param {{enabled?: boolean, params?: Record<string, unknown>|null}|null} state
 * @param {number} gridPx - the scene's grid size in world px.
 */
export function resolveFogOfWarLook(state, gridPx) {
  const on = state?.enabled !== false;
  const p = { ...(state?.params ?? {}), ...(on ? {} : PLAIN) };
  const S = FOG_OF_WAR_PARAMS;
  const clampTo = (raw, s) => num(raw, s.default, s.min, s.max);
  const grid = Number.isFinite(gridPx) && gridPx > 0 ? gridPx : 100;
  return {
    featherGrid: clampTo(p.edgeSoftness, S.edgeSoftness),
    ink: clampTo(p.ink, S.ink),
    inkCellPx: clampTo(p.inkSize, S.inkSize) * grid,
    motion: clampTo(p.motion, S.motion),
    revealTauSec: clampTo(p.revealSec, S.revealSec),
    memoryDim: clampTo(p.memoryBrightness, S.memoryBrightness),
    memorySaturation: clampTo(p.memoryColour, S.memoryColour),
    mist: clampTo(p.mist, S.mist),
    mistCellPx: clampTo(p.mistSize, S.mistSize) * grid,
    memoryGrid: clampTo(p.gridOverMemory, S.gridOverMemory),
  };
}
