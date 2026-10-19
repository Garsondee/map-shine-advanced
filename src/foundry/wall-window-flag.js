/**
 * THE WALL "WINDOW" FLAG — the one switch that says "this wall is a window" for the Window light pattern.
 *
 * WHY A FLAG (2026-10-19, author): the pattern must appear only on walls the author MEANS as windows. Guessing
 * from Foundry's sense settings (light PROXIMITY, or light NONE with sight PROXIMITY) over-claimed some maps and
 * missed others, and "transparent" walls are also terrain edges, railings and fences. So the pattern now reads an
 * explicit checkbox that this module adds to the bottom of Foundry's own wall dialog; it lives on the wall as
 * `flags.map-shine-advanced.windowPattern`.
 *
 * The guess is not thrown away: `foundry/scene-walls.js#deriveWallLooksLikeWindow` still drives the window REACH
 * (how far candle and fire light travels once it has gone through a window), which must not depend on a
 * checkbox somebody forgot to tick. And {@link markWallWindows} ticks the box on every wall that looks like a
 * window, in one go, for maps authored before the flag existed.
 *
 * @module foundry/wall-window-flag
 */

import { createLogger } from '../core/log.js';
import { deriveWallLooksLikeWindow } from './scene-walls.js';

const log = createLogger('wall-window-flag');

const MODULE_ID = 'map-shine-advanced';
/** The flag key under `flags.map-shine-advanced`. */
export const WALL_WINDOW_FLAG = 'windowPattern';
const FORM_NAME = `flags.${MODULE_ID}.${WALL_WINDOW_FLAG}`;
const GROUP_CLASS = 'msa-wall-window';

/**
 * Add the checkbox to the bottom of Foundry's wall dialog (`WallConfig`, an ApplicationV2 form). The input is
 * named like a document field, so Foundry's own Save writes it onto the wall with everything else.
 * Safe to call once at start-up; a no-op outside Foundry.
 * @returns {{registered: boolean, reason: string|null}}
 */
export function installWallWindowConfig() {
  if (typeof Hooks === 'undefined') return { registered: false, reason: 'no Foundry Hooks global' };
  Hooks.on('renderWallConfig', (app, element) => {
    try {
      const root = element instanceof HTMLElement ? element : (element?.[0] ?? null);
      if (!root || root.querySelector(`.${GROUP_CLASS}`)) return;
      const host = root.querySelector('.standard-form.scrollable') ?? root.querySelector('form') ?? root;
      const checked = app?.document?.getFlag?.(MODULE_ID, WALL_WINDOW_FLAG) === true;
      const fieldset = document.createElement('fieldset');
      fieldset.className = GROUP_CLASS;
      fieldset.innerHTML =
        '<legend>Map Shine Advanced</legend>' +
        '<div class="form-group">' +
        '<label>Window (light pattern)</label>' +
        '<div class="form-fields">' +
        `<input type="checkbox" name="${FORM_NAME}"${checked ? ' checked' : ''}>` +
        '</div>' +
        '<p class="hint">Tick this for a pane of glass. Light that passes through it shows the window pattern ' +
        '(panes and frames) and stops a short way outside. Leave it off for terrain, railings and fences.</p>' +
        '</div>';
      host.appendChild(fieldset);
    } catch (err) {
      log.error('could not add the window checkbox to the wall dialog:', err);
    }
  });
  return { registered: true, reason: null };
}

/**
 * Tick (or clear) the window flag on many walls at once.
 *  - `mode: 'detected'` (default): every wall of the scene that LOOKS like a window (light PROXIMITY, or light NONE
 *    with sight PROXIMITY) gets the flag.
 *  - `mode: 'clear'`: removes the flag from every wall.
 * @param {object} [options]
 * @param {object} [options.scene] defaults to the viewed scene.
 * @param {'detected'|'clear'} [options.mode]
 * @param {boolean} [options.dryRun] count only, change nothing.
 * @returns {Promise<{changed: number, total: number, dryRun: boolean}>}
 */
export async function markWallWindows({ scene = null, mode = 'detected', dryRun = false } = {}) {
  const sc = scene ?? globalThis.canvas?.scene ?? null;
  if (!sc?.walls) return { changed: 0, total: 0, dryRun };
  const updates = [];
  for (const wall of sc.walls) {
    const has = wall.getFlag?.(MODULE_ID, WALL_WINDOW_FLAG) === true;
    if (mode === 'clear') {
      if (has) updates.push({ _id: wall.id, [`flags.${MODULE_ID}.${WALL_WINDOW_FLAG}`]: false });
    } else if (!has && deriveWallLooksLikeWindow({ move: wall.move, light: wall.light, sight: wall.sight })) {
      updates.push({ _id: wall.id, [`flags.${MODULE_ID}.${WALL_WINDOW_FLAG}`]: true });
    }
  }
  if (!dryRun && updates.length) await sc.updateEmbeddedDocuments('Wall', updates);
  return { changed: updates.length, total: sc.walls.size, dryRun };
}
