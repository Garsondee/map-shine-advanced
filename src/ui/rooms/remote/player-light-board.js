/**
 * ui/rooms/remote/player-light-board.js — THE PLAYER LIGHT BOARD
 * (mythica-machina-press#77, mythica-machina-press#577), GM-only: which of
 * the six carried light/vision modes are offered on THIS scene, whether
 * players can pick their own at all, and how hard night crushes toward true
 * black on a floor nothing is lighting.
 *
 * Mirrors `weather-board.js`'s own shape (a `renderX(container, ctx)`
 * export, the SAME `aria-pressed` pill-toggle idiom its mood/biome chips
 * already use) rather than inventing a second control language for this
 * board.
 *
 * ⚠️ ALL SIX MODES RENDER SOMETHING AS OF STAGE 2B (mythica-machina-
 * press#77, mythica-machina-press#580) — Torch/Flashlight as real MSA-
 * rendered LIGHTS everyone at the table sees (Stage 2a), the other four as
 * real MSA screen-space GRADES visible only to the wearer's own client
 * (`effects/vision/player-vision-grade-render.js`). Both kinds are real and
 * functional; the tooltip below says which is which so a GM isn't left
 * guessing why flipping on Night Vision changes nothing on the GM's OWN
 * screen (it isn't meant to — that mode is personal by design).
 *
 * @module ui/rooms/remote/player-light-board
 */

import { buildParamControl } from '../../widgets/param-control.js';

/** The six mode keys, in the order they should appear, and WHAT each one
 * renders — matches `foundry/player-light-permissions.js#
 * PLAYER_LIGHT_MODE_KEYS` exactly (a literal copy, not an import: this is a
 * UI-ordering/labelling concern, the persistence module's own list is a
 * validity concern — the two happen to need the same six strings today, not
 * a reason to couple the files). `kind` matches `ui/rooms/player-light-
 * picker.js`'s own identical field (see that file's own header for why it
 * isn't a shared import either). */
const MODE_ROWS = Object.freeze([
  { key: 'torch', label: 'Torch', kind: 'light' },
  { key: 'flashlight', label: 'Flashlight', kind: 'light' },
  { key: 'nightVision', label: 'Night Vision', kind: 'grade' },
  { key: 'lowLight', label: 'Low-light Vision', kind: 'grade' },
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
 * @param {{
 *   getPermissions: () => {modes: Record<string, boolean>, playersCanChooseMode: boolean, darknessRealism01: number},
 *   onModeToggle: (modeKey: string, allowed: boolean) => void,
 *   onPlayersCanChooseModeToggle: (allowed: boolean) => void,
 *   onDarknessRealismCommit: (v: number) => void,
 * }} ctx
 * @returns {{refresh: () => void}}
 */
export function renderPlayerLightBoard(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-wx-board';

  const title = document.createElement('span');
  title.textContent = 'Player Lights';
  const label = document.createElement('div');
  label.className = 'msa-wx-blocklabel';
  label.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'msa-wx-hint';
  hint.style.marginLeft = '0'; // .msa-wx-hint defaults to margin-left:auto (an inline trailing caption); here it's its own full-width line
  hint.textContent = 'Which carried light/vision modes players may pick on THIS scene.';

  const chipRow = document.createElement('div');
  chipRow.className = 'msa-wx-chips';

  const masterHost = document.createElement('div');
  const realismHost = document.createElement('div');

  wrap.append(label, hint, chipRow, masterHost, realismHost);
  container.appendChild(wrap);

  function renderChips() {
    chipRow.innerHTML = '';
    const permissions = ctx.getPermissions();
    for (const row of MODE_ROWS) {
      const allowed = permissions.modes?.[row.key] === true;
      const title =
        row.kind === 'light'
          ? `${row.label} — a real, MSA-rendered light everyone at the table sees. Click to ${allowed ? 'forbid' : 'allow'} it on this scene.`
          : `${row.label} — a real screen-space grade visible only to the wearer's own view, nobody else. Click to ${allowed ? 'forbid' : 'allow'} it on this scene.`;
      chipRow.appendChild(pill(row.label, title, allowed, () => ctx.onModeToggle(row.key, !allowed)));
    }
  }

  function renderMaster() {
    masterHost.innerHTML = '';
    const permissions = ctx.getPermissions();
    masterHost.appendChild(
      buildParamControl(
        'playersCanChooseMode',
        {
          type: 'bool',
          label: 'Players can choose their own mode',
          help: 'Off: players see a read-only "the GM has disabled this" message instead of the picker, regardless of which modes are allowed above.',
        },
        { value: permissions.playersCanChooseMode, onChange: (v) => ctx.onPlayersCanChooseModeToggle(v) }
      )
    );
  }

  function renderRealism() {
    realismHost.innerHTML = '';
    const permissions = ctx.getPermissions();
    realismHost.appendChild(
      buildParamControl(
        'darknessRealism01',
        {
          type: 'float',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0,
          label: 'Night darkness',
          help: 'How dark an UNLIT floor gets at full night — 0 keeps Foundry\'s own gentle grey floor, 1 crushes it toward true black so player lights genuinely matter. Distinct from the separate "Region Darkness Override" feature — this only affects how black darkness itself reads, not any region\'s own adjustment.',
        },
        { value: permissions.darknessRealism01, onChange: (v) => ctx.onDarknessRealismCommit(v) }
      )
    );
  }

  renderChips();
  renderMaster();
  renderRealism();

  return {
    refresh() {
      renderChips();
      renderMaster();
      renderRealism();
    },
  };
}
