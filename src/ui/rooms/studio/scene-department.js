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
 * Looks come from the shared `.msa-panel`/`.msa-btn`/`.msa-input` classes in
 * `studio-style.js` (2026-10-18) — this file used to inline a copy of the same
 * button style three times, none of which could hover, press or show focus.
 *
 * @module ui/rooms/studio/scene-department
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';
import { buildParamControl } from '../../widgets/param-control.js';
import { buildArmButton } from '../../widgets/inline-actions.js';

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

/** Tiny element factory. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A small `.msa-btn`. */
function smallBtn(label, title) {
  const b = el('button', 'msa-btn msa-btn--sm', label);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

/** A status line (`role="status"`, so a screen reader hears the result). */
function statusLine(text = '') {
  const p = el('p', 'msa-status', text);
  p.setAttribute('role', 'status');
  return p;
}

function setTone(node, text, ok) {
  node.textContent = text;
  node.dataset.tone = ok === true ? 'ok' : ok === false ? 'fail' : '';
}

/**
 * One panel: icon + uppercase title, then whatever the caller appends.
 * @param {string} icon @param {string} title
 * @param {{planned?: boolean, reason?: string}} [opts]
 */
function panel(icon, title, { planned = false, reason } = {}) {
  const root = el('div', `msa-panel${planned ? ' msa-panel--planned' : ''}`);
  if (reason) root.title = reason;
  const h = el('h3', 'msa-panel-title');
  h.innerHTML = iconMarkup(icon);
  h.append(document.createTextNode(title));
  if (planned) h.append(el('span', 'msa-panel-tag', '◇ planned'));
  root.append(h);
  return root;
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
 * @param {() => {presets: Array<{name: string, capturedAt: string|null, effectCount: number}>}} [ctx.listScenePresets] -
 *   MapShine.listScenePresets (mythica-machina-press#177); omitted (with saveScenePreset) hides the card.
 * @param {(name: string) => Promise<{ok: boolean, reason?: string}>} [ctx.saveScenePreset]
 * @param {(name: string) => Promise<{ok: boolean, reason?: string}>} [ctx.applyScenePreset]
 * @param {(name: string) => Promise<{ok: boolean, reason?: string}>} [ctx.deleteScenePreset]
 * @returns {string} department subtitle.
 */
export function renderSceneDepartment(container, ctx) {
  const grid = el('div');
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '10px',
  });

  // "Baseline" and "Scene presets" used to be planned cards here, both
  // saying they waited on the Fade Engine — which shipped: the Remote's own
  // ⟲ Baseline fades back to the authored look, and the scene-preset library
  // (mythica-machina-press#177) is real. Presets get a real card below;
  // Baseline needs none (it IS "the look this department authors").
  const levels = panel('layers', 'Levels', {
    planned: true,
    reason: 'Floor-band authoring — no confirmed src/ hook traced yet for editing scene.levels bands from this panel.',
  });
  levels.append(
    el(
      'p',
      'msa-note',
      'Floor-band authoring — no confirmed src/ hook traced yet for editing scene.levels bands from this panel.'
    )
  );
  grid.append(levels);

  let maskBoard = [];
  try {
    maskBoard = ctx.getMaskBoard?.() ?? [];
  } catch (_) {
    maskBoard = [];
  }
  const masks = panel('gem', 'Masks aboard');
  if (maskBoard.length > 0) {
    const list = el('div', 'msa-masklist');
    for (const m of maskBoard) {
      const item = el('span');
      item.style.color = m.found ? 'var(--ok)' : 'var(--ink2)';
      item.insertAdjacentHTML('beforeend', `<code>${m.suffix}</code> ${m.found ? iconMarkup('check') : '—'}`);
      list.append(item);
    }
    masks.append(list);
  } else {
    masks.append(el('p', 'msa-note', 'Mask board data not available.'));
  }
  grid.append(masks);

  // COPY/PASTE SCENE SETTINGS (mythica-machina-press#12) — the backend
  // (MapShine.copySceneEffectSettings/pasteSceneEffectSettings,
  // foundry/effect-param-persistence.js) has existed since that issue's own
  // commit; this card is the one piece that was still missing — a Studio
  // button, rather than requiring the console. An in-memory clipboard, not a
  // saved/named library (that's #102's separate, per-EFFECT preset system,
  // on each effect's own card) — "copy this scene, go paste it on that one"
  // in the same session, nothing persisted between reloads.
  if (typeof ctx.copySceneEffectSettings === 'function' && typeof ctx.pasteSceneEffectSettings === 'function') {
    const copyPasteCard = panel('map', 'Copy/paste scene settings');
    copyPasteCard.append(
      el(
        'p',
        'msa-note',
        "Copy every effect's authored look from this scene, then switch scenes and paste — an in-memory clipboard for this session only."
      )
    );
    const status = statusLine('Nothing copied yet.');
    const btnRow = el('div', 'msa-row-flex');
    const copyBtn = smallBtn('Copy from this scene');
    copyBtn.addEventListener('click', () => {
      const res = ctx.copySceneEffectSettings();
      if (res.ok) setTone(status, `Copied ${res.effectIds.length} effect(s) — switch scenes, then Paste.`, true);
      else setTone(status, `Nothing to copy: ${res.reason}`, null);
    });
    const pasteBtn = smallBtn('Paste into this scene');
    pasteBtn.addEventListener('click', () => {
      Promise.resolve(ctx.pasteSceneEffectSettings()).then((res) => {
        if (res.ok) setTone(status, `Pasted ${res.effectIds.length} effect(s) onto this scene.`, true);
        else setTone(status, `Paste failed: ${res.reason}`, false);
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
    const darknessCard = panel('moon', 'Darkness at max');
    darknessCard.append(
      el(
        'p',
        'msa-note',
        'How dark an unlit scene gets at full night. Same setting as the Remote’s Night darkness slider — saved on this scene, so every player sees it.'
      )
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

  // SCENE PRESETS (UI test pass, 2026-09-26) — the Studio face for the
  // MapShine.save/apply/list/deleteScenePreset library, which until now was
  // console-only. Same semantics as the API: effect params only, instant
  // apply, a world-scoped library the whole table shares.
  if (typeof ctx.listScenePresets === 'function' && typeof ctx.saveScenePreset === 'function') {
    const presetCard = panel('map', 'Scene presets');
    presetCard.append(
      el(
        'p',
        'msa-note',
        'Save this scene’s whole effect look under a name, then apply it here or on any other scene. Applying replaces every effect setting on this scene at once.'
      )
    );
    const status = statusLine();
    const list = el('div');
    Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '4px' });
    const setStatus = (text, ok) => setTone(status, text, ok);
    const renderList = () => {
      list.innerHTML = '';
      let presets = [];
      try {
        presets = ctx.listScenePresets()?.presets ?? [];
      } catch (_) {
        presets = [];
      }
      if (presets.length === 0) {
        list.appendChild(el('span', 'msa-note', 'No scene presets saved yet.'));
        return;
      }
      for (const p of presets) {
        const row = el('div', 'msa-row-flex');
        row.style.fontSize = '.72rem';
        const name = el('span', '', p.name);
        Object.assign(name.style, {
          flex: '1',
          minWidth: '0',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        });
        name.dataset.tip = `${p.name} — ${p.effectCount} effect(s)${p.capturedAt ? ` · saved ${new Date(p.capturedAt).toLocaleString()}` : ''}`;
        const applyBtn = smallBtn('Apply', `Replace this scene's effect settings with '${p.name}'`);
        applyBtn.addEventListener('click', () => {
          Promise.resolve(ctx.applyScenePreset(p.name)).then((res) =>
            res?.ok
              ? setStatus(`Applied '${p.name}' to this scene.`, true)
              : setStatus(`Apply failed: ${res?.reason}`, false)
          );
        });
        // Two-click confirm in place (it used to be a blocking native
        // confirm()): the preset is shared with the whole table, so the armed
        // label says so.
        const delBtn = buildArmButton({
          icon: 'trash',
          armedLabel: 'Delete?',
          title: `Delete '${p.name}' from the shared library`,
          armedTitle: `Click again to delete '${p.name}' — it is shared with the whole table`,
          className: 'hbtn',
          onConfirm: () => {
            Promise.resolve(ctx.deleteScenePreset(p.name)).then((res) => {
              if (res?.ok) setStatus(`Deleted '${p.name}'.`, null);
              else setStatus(`Delete failed: ${res?.reason}`, false);
              renderList();
            });
          },
        });
        row.append(name, applyBtn, delBtn);
        list.appendChild(row);
      }
    };
    const saveRow = el('div', 'msa-row-flex');
    const nameInput = el('input', 'msa-input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Preset name';
    nameInput.setAttribute('aria-label', 'Scene preset name');
    nameInput.addEventListener('input', () => nameInput.removeAttribute('aria-invalid'));
    const saveBtn = smallBtn('Save', 'Save this scene’s current effect look under this name');
    saveBtn.classList.add('msa-btn--gold');
    const doSave = () => {
      const presetName = nameInput.value.trim();
      if (!presetName) {
        nameInput.setAttribute('aria-invalid', 'true');
        setStatus('Type a name first.', false);
        nameInput.focus();
        return;
      }
      Promise.resolve(ctx.saveScenePreset(presetName)).then((res) => {
        if (res?.ok) {
          setStatus(`Saved '${presetName}'.`, true);
          nameInput.value = '';
        } else setStatus(`Save failed: ${res?.reason}`, false);
        renderList();
      });
    };
    saveBtn.addEventListener('click', doSave);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSave();
    });
    saveRow.append(nameInput, saveBtn);
    renderList();
    presetCard.append(list, status, saveRow);
    grid.append(presetCard);
  }

  let tileMotionSummary = null;
  try {
    tileMotionSummary = ctx.getTileMotionSummary?.() ?? null;
  } catch (_) {
    tileMotionSummary = null;
  }
  const tileMotionCard = panel('play', 'Motion tiles');
  tileMotionCard.append(
    el(
      'p',
      'msa-note',
      tileMotionSummary
        ? `${tileMotionSummary.enabledCount} of ${tileMotionSummary.totalTileCount} tile(s) animated · ${tileMotionSummary.playing ? 'Playing' : 'Stopped'}`
        : 'Tile motion data not available.'
    )
  );
  const openBtn = smallBtn('Open');
  openBtn.style.alignSelf = 'flex-start';
  openBtn.addEventListener('click', () => ctx.openTileMotionDialog?.());
  tileMotionCard.appendChild(openBtn);
  grid.append(tileMotionCard);

  container.innerHTML = '';
  container.append(grid);
  return 'the authored resting look, and everything the map ships with';
}
