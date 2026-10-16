/**
 * ui/rooms/player-light-picker.js — THE PLAYER-SIDE MODE PICKER
 * (mythica-machina-press#77): pick which carried light/vision mode YOUR OWN
 * token uses, scoped to whatever the GM currently allows on this scene.
 *
 * Lives in `ui/rooms/`, a sibling of `player-shell.js`'s own generated
 * system-panel content — added as its OWN section
 * (`player-shell.js#installPlayer`'s `paint()`), never a replacement.
 *
 * ⚠️ A GM HAS NO PERSONAL CHARACTER, SO THE GM'S PICKER ACTS ON THE SELECTED
 * TOKEN (`resolveCarriedLightTarget`). It first shipped excluding GMs outright,
 * which left a GM with no way to give anything a light, aim it, or see a vision
 * mode. It is mounted in the Remote's Player Lights board for a GM and in the
 * Player room for everyone else; the GM sees all seven modes (marking any the
 * scene switches off), a player only the ones the GM allows.
 *
 * ⚠️ ALL SEVEN MODES ARE PICKABLE (when the scene allows them) AND ALL SEVEN NOW
 * RENDER SOMETHING (Stage 2b, mythica-machina-press#77/#580) — Torch/
 * Flashlight as real lights everyone sees, the other five as a real
 * screen-space grade visible only to this token's own viewer. The tooltip
 * below says which kind each chip is rather than lumping both under one
 * "rendered" label.
 *
 * @module ui/rooms/player-light-picker
 */

import {
  resolveCarriedLightTarget,
  isViewingUserGM,
  readTokenPlayerLightMode,
  writeTokenPlayerLightMode,
  readScenePlayerLightPermissions,
} from '../../foundry/index.js';

/** The seven modes, in display order, with WHAT each one actually renders —
 * a local, UI-owned copy (see `remote/player-light-board.js`'s own identical
 * `MODE_ROWS` for why this isn't a shared import: the two lists answer
 * different questions that happen to share seven strings today). All seven
 * render something as of Stage 2b (mythica-machina-press#77, #580):
 * `'light'` = a real MSA-rendered light everyone at the table sees
 * (Torch/Flashlight, Stage 2a); `'grade'` = a real MSA screen-space colour
 * grade visible ONLY to this token's own viewer (the other five,
 * `effects/vision/player-vision-grade-render.js`) — different enough in
 * kind to say so in the tooltip rather than lumping both under "rendered". */
const MODE_ROWS = Object.freeze([
  { key: 'torch', label: 'Torch', kind: 'light' },
  { key: 'flashlight', label: 'Flashlight', kind: 'light' },
  { key: 'nightVision', label: 'Night Vision', kind: 'grade' },
  { key: 'lowLight', label: 'Low-light Vision', kind: 'grade' },
  { key: 'activeLowLight', label: 'Low Light (Active)', kind: 'grade' },
  { key: 'infravision', label: 'Infravision', kind: 'grade' },
  { key: 'activeInfravision', label: 'Active Infravision', kind: 'grade' },
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

  function paintNote(text) {
    const note = document.createElement('div');
    note.className = 'msa-wx-hint';
    note.style.marginLeft = '0'; // a full-width line under the chips, not the inline trailing caption
    note.textContent = text;
    body.appendChild(note);
  }

  function paint() {
    // A GM's carried light belongs to the token they have SELECTED (a player's
    // to their own character) — `resolveCarriedLightTarget` is the one answer the
    // aim channel and the vision grade use too, so the three cannot disagree.
    const gm = isViewingUserGM();
    title.textContent = gm ? 'Carried Light (selected token)' : 'Carried Light';
    const { token, reason, blockedName } = resolveCarriedLightTarget();
    if (!token) {
      if (!gm) {
        paintMessage("You don't have a token on this scene yet — your carried light follows your character's token.");
      } else if (reason === 'player-active') {
        paintMessage(
          `${blockedName || 'That token'} is steered by its player right now. Select a token no active player owns to give it a light.`
        );
      } else {
        paintMessage('Select a token on the canvas to give it a Torch, Flashlight or vision mode.');
      }
      return;
    }
    const { permissions } = readScenePlayerLightPermissions();
    if (!gm && permissions.playersCanChooseMode !== true) {
      paintMessage('The GM has disabled player-chosen lights on this scene.');
      return;
    }
    const isAllowed = (key) => permissions.modes?.[key] === true;
    // A player is only offered what the GM allows. A GM sees all seven, with the
    // switched-off ones marked, so there is always something to try.
    const rows = gm ? MODE_ROWS : MODE_ROWS.filter((row) => isAllowed(row.key));
    if (rows.length === 0) {
      paintMessage('The GM has not allowed any carried light modes on this scene.');
      return;
    }
    const currentMode = readTokenPlayerLightMode(token.document);
    body.innerHTML = '';
    const chipRow = document.createElement('div');
    chipRow.className = 'msa-wx-chips';
    for (const row of rows) {
      const pressed = row.key === currentMode;
      const subject = gm ? 'this token' : 'your token';
      let chipTitle =
        row.kind === 'light'
          ? `${row.label} — a real light that follows ${subject}, visible to everyone at the table.`
          : gm
            ? `${row.label} — a real screen-space grade that tints YOUR view while this token is selected; nobody else sees it.`
            : `${row.label} — a real screen-space grade only YOUR view gets; nobody else at the table sees it.`;
      if (gm && !isAllowed(row.key)) chipTitle += ' (Switched off for this scene above, so it will not show.)';
      chipRow.appendChild(
        pill(row.label, chipTitle, pressed, () => void setMode(token.document, row.key, currentMode))
      );
    }
    body.appendChild(chipRow);
    if (gm)
      paintNote(`Token: ${token.name ?? token.document?.name ?? 'selected token'}. Your cursor steers its light.`);
    if (gm && token.document?.hidden === true) {
      paintNote('This token is hidden, so its light is not drawn until it is revealed.');
    }
    if (currentMode && !isAllowed(currentMode)) {
      // The GM revoked the mode this token was using mid-session — say so,
      // rather than silently showing no selection with no explanation.
      paintNote(
        gm
          ? 'This mode is switched off for the scene above, so it has stopped showing.'
          : 'Your previous choice is no longer allowed on this scene and has stopped showing.'
      );
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
