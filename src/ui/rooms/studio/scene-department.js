/**
 * ui/rooms/studio/scene-department.js — "the authored resting look, and
 * everything the map ships with" (U1, docs/holy/UI-Testament.md §5.1, §9).
 * Ported layout from the mock's Scene department (`tools/ui-mock/index.html`
 * `.sysgrid`/`.syscard`).
 *
 * Two cards are real: Masks aboard (real data — scene/mask-catalog.js's
 * suffix table + scene/mask-authority.js's found/missing check, the same
 * functions the EFFECTS cards' own mask-row already reads) and, since
 * 2026-08-27, Motion tiles (a summary readout + an "Open" button onto the
 * full `ui/tile-motion-dialog.js` authoring panel — the card itself is a
 * glance, not a second copy of that dialog's ~20 fields). Baseline capture
 * and Scene presets still need the Fade Engine (U2, not built); Levels-
 * editing has no confirmed real hook this session traced — those two ship
 * as honest `status:'planned'` cards rather than either hiding them or
 * faking a working button. See Petition P10.
 *
 * @module ui/rooms/studio/scene-department
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';
import { buildParamControl } from '../../widgets/param-control.js';

/** Same 3 presets, same snap-to-nearest read, same help text as the old
 * panel's own `darkness-realism` select (boot.js) — ported verbatim (UI
 * parity plan, phase 4a), not reinterpreted. Presets rather than a
 * continuous slider for the same reason the old select was one:
 * feedback_debug_ui_one_action_one_control. */
const DARKNESS_REALISM_DECL = Object.freeze({
  type: 'enum',
  values: ['0', '0.5', '1'],
  valueLabels: { 0: 'Foundry (readable)', 0.5: 'Halfway', 1: 'Realistic (black)' },
  label: 'Darkness at max',
  help:
    "How dark an unlit scene gets at maximum scene darkness. 'Foundry' floors at Foundry's own " +
    "readable darkness colour (~19%, never black — parity with vanilla Foundry); 'Realistic' " +
    'drives that floor to true black.',
});

function plannedCard(icon, title, reason) {
  const card = document.createElement('div');
  Object.assign(card.style, {
    background: 'var(--bg1)',
    border: '1px dashed var(--fail)',
    borderRadius: 'var(--r-card, 10px)',
    padding: '10px 12px',
  });
  card.title = reason;
  card.innerHTML = `<h3 style="font-size:.74rem; letter-spacing:.1em; text-transform:uppercase; color:var(--ink2); display:flex; gap:7px; align-items:center; margin:0 0 6px">${iconMarkup(icon)}${title} <span style="margin-left:auto; color:var(--fail); font-size:.68rem; font-weight:400; letter-spacing:0; text-transform:none">◇ planned</span></h3><p style="margin:0; font-size:.72rem; color:var(--ink2)">${reason}</p>`;
  return card;
}

function realCard(icon, title, bodyHtml) {
  const card = document.createElement('div');
  Object.assign(card.style, {
    background: 'var(--bg1)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--r-card, 10px)',
    padding: '10px 12px',
  });
  card.innerHTML = `<h3 style="font-size:.74rem; letter-spacing:.1em; text-transform:uppercase; color:var(--ink2); display:flex; gap:7px; align-items:center; margin:0 0 6px">${iconMarkup(icon)}${title}</h3>${bodyHtml}`;
  return card;
}

/**
 * @param {HTMLElement} container
 * @param {object} ctx
 * @param {() => Array<{suffix: string, found: boolean}>} [ctx.getMaskBoard] -
 *   supplied by boot.js; omitted (or throwing) falls back to an honest
 *   "not available" line rather than a blank card.
 * @param {() => {totalTileCount:number, enabledCount:number, playing:boolean}} [ctx.getTileMotionSummary] -
 *   supplied by boot.js (foundry/index.js#getTileMotionSummary); same
 *   omitted-or-throwing fallback posture as `getMaskBoard`.
 * @param {() => void} [ctx.openTileMotionDialog] - opens the full authoring panel.
 * @param {() => number} [ctx.getDarknessRealism] - 0..1, the real value MapShine.getDarknessRealism()
 *   reads; omitted hides the card (UI parity plan, phase 4a).
 * @param {(v: number) => void} [ctx.setDarknessRealism]
 * @param {() => {ok: boolean, reason?: string, effectIds?: string[]}} [ctx.copySceneEffectSettings] -
 *   MapShine.copySceneEffectSettings (mythica-machina-press#12); omitted hides the card.
 * @param {() => Promise<{ok: boolean, reason?: string, effectIds?: string[]}>} [ctx.pasteSceneEffectSettings]
 * @returns {string} department subtitle.
 */
export function renderSceneDepartment(container, ctx) {
  const grid = document.createElement('div');
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '10px',
  });

  grid.append(
    plannedCard(
      'home',
      'Baseline',
      'What "Baseline" on the Remote fades back to — needs the Fade Engine (U2), not built yet.'
    ),
    plannedCard(
      'map',
      'Scene presets',
      'A validated snapshot of the whole authored look — also waits on the Fade Engine (U2).'
    ),
    plannedCard(
      'layers',
      'Levels',
      'Floor-band authoring — no confirmed src/ hook traced yet for editing scene.levels bands from this panel.'
    )
  );

  let maskBoard = [];
  try {
    maskBoard = ctx.getMaskBoard?.() ?? [];
  } catch (_) {
    maskBoard = [];
  }
  const maskBody =
    maskBoard.length > 0
      ? `<div style="display:flex; flex-wrap:wrap; gap:6px; font-size:.7rem">${maskBoard
          .map(
            (m) =>
              `<span style="color:${m.found ? 'var(--ok)' : 'var(--ink2)'}"><code>${m.suffix}</code> ${m.found ? iconMarkup('check') : '—'}</span>`
          )
          .join('')}</div>`
      : `<p style="margin:0; font-size:.72rem; color:var(--ink2)">Mask board data not available.</p>`;
  grid.append(realCard('gem', 'Masks aboard', maskBody));

  // COPY/PASTE SCENE SETTINGS (mythica-machina-press#12) — the backend
  // (MapShine.copySceneEffectSettings/pasteSceneEffectSettings,
  // foundry/effect-param-persistence.js) has existed since that issue's own
  // commit; this card is the one piece that was still missing — a Studio
  // button, rather than requiring the console. An in-memory clipboard, not a
  // saved/named library (that's #102's separate, per-EFFECT preset system,
  // on each effect's own card) — "copy this scene, go paste it on that one"
  // in the same session, nothing persisted between reloads.
  if (typeof ctx.copySceneEffectSettings === 'function' && typeof ctx.pasteSceneEffectSettings === 'function') {
    const copyPasteCard = realCard(
      'map',
      'Copy/paste scene settings',
      '<p style="margin:0 0 8px; font-size:.72rem; color:var(--ink2)">Copy every effect\'s authored look from this scene, then switch scenes and paste — an in-memory clipboard for this session only.</p>'
    );
    const status = document.createElement('p');
    Object.assign(status.style, { margin: '0 0 8px', fontSize: '.7rem', color: 'var(--ink2)' });
    status.textContent = 'Nothing copied yet.';
    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '6px' });
    const mkBtn = (label) => {
      const b = document.createElement('button');
      b.textContent = label;
      Object.assign(b.style, {
        background: 'var(--bg2, #23262d)',
        color: 'var(--ink0)',
        border: '1px solid var(--line)',
        borderRadius: '6px',
        padding: '3px 10px',
        cursor: 'pointer',
        fontSize: '.72rem',
      });
      return b;
    };
    const copyBtn = mkBtn('Copy from this scene');
    copyBtn.addEventListener('click', () => {
      const res = ctx.copySceneEffectSettings();
      status.textContent = res.ok
        ? `Copied ${res.effectIds.length} effect(s) — switch scenes, then Paste.`
        : `Nothing to copy: ${res.reason}`;
      status.style.color = res.ok ? 'var(--ok, #6c6)' : 'var(--ink2)';
    });
    const pasteBtn = mkBtn('Paste into this scene');
    pasteBtn.addEventListener('click', () => {
      Promise.resolve(ctx.pasteSceneEffectSettings()).then((res) => {
        status.textContent = res.ok
          ? `Pasted ${res.effectIds.length} effect(s) onto this scene.`
          : `Paste failed: ${res.reason}`;
        status.style.color = res.ok ? 'var(--ok, #6c6)' : 'var(--fail)';
      });
    });
    btnRow.append(copyBtn, pasteBtn);
    copyPasteCard.append(status, btnRow);
    grid.append(copyPasteCard);
  }

  // DARKNESS AT MAX (UI parity plan, phase 4a) — the old panel's own
  // Bridge-zone 'darkness-realism' select, real port: same real backend
  // (getDarknessRealism/setDarknessRealism), same widget canon every other
  // enum in this codebase already renders through.
  if (typeof ctx.getDarknessRealism === 'function' && typeof ctx.setDarknessRealism === 'function') {
    const darknessCard = realCard(
      'moon',
      'Darkness at max',
      '<p style="margin:0 0 8px; font-size:.72rem; color:var(--ink2)">How dark an unlit scene gets.</p>'
    );
    const snapToPreset = (v) => (v <= 0.25 ? '0' : v >= 0.75 ? '1' : '0.5');
    darknessCard.appendChild(
      buildParamControl('darknessRealism', DARKNESS_REALISM_DECL, {
        value: snapToPreset(ctx.getDarknessRealism()),
        onChange: (v) => ctx.setDarknessRealism(Number(v)),
      })
    );
    grid.append(darknessCard);
  }

  let tileMotionSummary = null;
  try {
    tileMotionSummary = ctx.getTileMotionSummary?.() ?? null;
  } catch (_) {
    tileMotionSummary = null;
  }
  const tileMotionBody = tileMotionSummary
    ? `<p style="margin:0 0 8px; font-size:.72rem; color:var(--ink2)">${tileMotionSummary.enabledCount} of ${tileMotionSummary.totalTileCount} tile(s) animated · ${tileMotionSummary.playing ? 'Playing' : 'Stopped'}</p>`
    : `<p style="margin:0 0 8px; font-size:.72rem; color:var(--ink2)">Tile motion data not available.</p>`;
  const tileMotionCard = realCard('play', 'Motion tiles', tileMotionBody);
  const openBtn = document.createElement('button');
  openBtn.textContent = 'Open';
  Object.assign(openBtn.style, {
    background: 'var(--bg2, #23262d)',
    color: 'var(--ink0)',
    border: '1px solid var(--line)',
    borderRadius: '6px',
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: '.72rem',
  });
  openBtn.addEventListener('click', () => ctx.openTileMotionDialog?.());
  tileMotionCard.appendChild(openBtn);
  grid.append(tileMotionCard);

  container.innerHTML = '';
  container.append(grid);
  return 'the authored resting look, and everything the map ships with';
}
