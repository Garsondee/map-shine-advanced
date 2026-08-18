/**
 * ui/rooms/studio/scene-department.js — "the authored resting look, and
 * everything the map ships with" (U1, docs/holy/UI-Testament.md §5.1, §9).
 * Ported layout from the mock's Scene department (`tools/ui-mock/index.html`
 * `.sysgrid`/`.syscard`).
 *
 * Only ONE card is real for U1: Masks aboard (real data — scene/mask-
 * catalog.js's suffix table + scene/mask-authority.js's found/missing
 * check, the same functions the EFFECTS cards' own mask-row already reads).
 * Baseline capture and Scene presets need the Fade Engine (U2, not built);
 * Levels-editing has no confirmed real hook this session traced; Motion
 * Tiles has no src/ runtime at all (V2-only) — all four ship as honest
 * `status:'planned'` cards rather than either hiding them or faking a
 * working button. See Petition P10.
 *
 * @module ui/rooms/studio/scene-department
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';

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

  grid.append(
    plannedCard(
      'play',
      'Motion tiles',
      'Motion Tiles has no src/ runtime yet (V2-only, legacy/scene/tile-motion-manager.js) — this card is chrome, not a working configurator.'
    )
  );

  container.innerHTML = '';
  container.append(grid);
  return 'the authored resting look, and everything the map ships with';
}
