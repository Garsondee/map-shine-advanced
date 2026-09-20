/**
 * ui/rooms/player-light-picker.js — THE PLAYER-SIDE MODE PICKER
 * (mythica-machina-press#77): pick which carried light/vision mode YOUR OWN
 * token uses, scoped to whatever the GM currently allows on this scene.
 *
 * Lives in `ui/rooms/`, a sibling of `player-shell.js`'s own generated
 * system-panel content — added as its OWN section
 * (`player-shell.js#installPlayer`'s `paint()`), never a replacement.
 *
 * ⚠️ GM EXCLUSION HAPPENS HERE, NOT IN `resolveViewerToken()`. That resolver
 * (foundry/viewer-token.js) deliberately answers "which token is this
 * client's own" for ANY client, GM included (a GM can legitimately own
 * tokens) — see its own header. A GM has no single personal character this
 * picker makes sense for, so THIS module checks `game.user.isGM` itself
 * before rendering anything, the same call-site posture
 * `scene-intro-zoom.js#runSceneIntroZoom` already established for its own,
 * identical reason.
 *
 * ⚠️ ALL SIX MODES ARE PICKABLE (when the scene allows them), EVEN THOUGH
 * ONLY TORCH/FLASHLIGHT RENDER ANYTHING YET. Picking a vision mode still
 * writes the token's own flag (so Stage 2's real render has something to key
 * off later) — this module labels the other four honestly rather than
 * hiding them or silently pretending they work.
 *
 * @module ui/rooms/player-light-picker
 */

import {
  resolveViewerToken,
  isViewingUserGM,
  readTokenPlayerLightMode,
  writeTokenPlayerLightMode,
  readScenePlayerLightPermissions,
} from '../../foundry/index.js';

/** The six modes, in display order, with which ones Stage 1 actually
 * renders — a local, UI-owned copy (see `remote/player-light-board.js`'s
 * own identical `MODE_ROWS` for why this isn't a shared import: the two
 * lists answer different questions that happen to share six strings today). */
const MODE_ROWS = Object.freeze([
  { key: 'torch', label: 'Torch', rendered: true },
  { key: 'flashlight', label: 'Flashlight', rendered: true },
  { key: 'nightVision', label: 'Night Vision', rendered: false },
  { key: 'lowLight', label: 'Low-light Vision', rendered: false },
  { key: 'infravision', label: 'Infravision', rendered: false },
  { key: 'activeInfravision', label: 'Active Infravision', rendered: false },
]);

function pill(text, title, pressed, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msa-wx-chip';
  btn.textContent = text;
  if (title) btn.title = title;
  btn.setAttribute('aria-pressed', String(pressed));
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * @param {HTMLElement} container
 * @returns {{refresh: () => void}}
 */
export function renderPlayerLightPicker(container) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-wx-board msa-player-light-picker';

  const title = document.createElement('div');
  title.className = 'msa-wx-blocklabel';
  title.textContent = 'Carried Light';

  const body = document.createElement('div');

  wrap.append(title, body);
  container.appendChild(wrap);

  function paintMessage(text) {
    body.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'msa-wx-hint';
    msg.textContent = text;
    body.appendChild(msg);
  }

  async function setMode(tokenDocument, mode, currentMode) {
    const next = mode === currentMode ? null : mode; // clicking the active mode again clears it
    const result = await writeTokenPlayerLightMode(tokenDocument, next);
    if (!result.ok) {
      paintMessage(`Couldn't change your light — ${result.reason}`);
      return;
    }
    paint();
  }

  function paint() {
    // GM EXCLUSION — see this module's own header for why this check lives
    // here rather than inside resolveViewerToken() itself.
    if (isViewingUserGM()) {
      paintMessage('GMs have no personal carried light — set player allowances from the Remote instead.');
      return;
    }
    const token = resolveViewerToken();
    if (!token) {
      paintMessage('No controlled token found on this scene.');
      return;
    }
    const { permissions } = readScenePlayerLightPermissions();
    if (permissions.playersCanChooseMode !== true) {
      paintMessage('The GM has disabled player-chosen lights on this scene.');
      return;
    }
    const allowedRows = MODE_ROWS.filter((row) => permissions.modes?.[row.key] === true);
    if (allowedRows.length === 0) {
      paintMessage('The GM has not allowed any carried light modes on this scene.');
      return;
    }
    const currentMode = readTokenPlayerLightMode(token.document);
    body.innerHTML = '';
    const chipRow = document.createElement('div');
    chipRow.className = 'msa-wx-chips';
    for (const row of allowedRows) {
      const pressed = row.key === currentMode;
      const text = row.rendered ? row.label : `${row.label} (visual coming soon)`;
      const chipTitle = row.rendered
        ? `${row.label} — a real light that follows your token.`
        : `${row.label} — selectable now, but nothing renders for it yet; the visual treatment is a later build.`;
      chipRow.appendChild(pill(text, chipTitle, pressed, () => void setMode(token.document, row.key, currentMode)));
    }
    body.appendChild(chipRow);
    if (currentMode && !allowedRows.some((r) => r.key === currentMode)) {
      // The GM revoked the mode this token was using mid-session — say so,
      // rather than silently showing no selection with no explanation.
      const note = document.createElement('div');
      note.className = 'msa-wx-hint';
      note.textContent = 'Your previous choice is no longer allowed on this scene and has stopped showing.';
      body.appendChild(note);
    }
  }

  paint();

  return {
    /** Re-paint — boot.js's own `resolveAndApplyPlayerLightPermissions`
     * calls this (via `MapShine.__player.refreshPlayerLightPicker()`)
     * whenever the scene's permissions change, matching every other board's
     * "never polls, it's told" shape. */
    refresh() {
      paint();
    },
  };
}
