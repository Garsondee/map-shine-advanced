/**
 * @fileoverview PAINT MODE — the floating toolbar. Builds the whole control
 * bar (tool switcher, snap, floor stepper, mask picker, brush mode/size/
 * strength/hardness, undo/clear/save/exit, the shortcut legend) and owns
 * `state.refreshToolbar`, the one function that re-syncs every control to the
 * painter's live state.
 *
 * Split out of paint-mode.js on 2026-07-25 (the size-ratchet god-object
 * reversal): at 182 lines this was the single biggest block inside the
 * 867-line `installPainter` closure. The body moved VERBATIM; `createToolbar`
 * is a factory that destructures the painter's own callbacks out of `deps` so
 * every name the body already used still resolves identically.
 *
 * @module ui/paint-mode-toolbar
 */

import { styleControl, label, legendItem, button, range, segmented } from './paint-mode-widgets.js';

/**
 * Bind the toolbar builder to the painter's live `state` + its actions.
 * @param {object} state - the painter state.
 * @param {object} deps - the painter's own callbacks, unchanged in name so the
 *   moved body resolves them exactly as it did inside the closure.
 * @returns {() => HTMLElement} `buildToolbar()`.
 */
export function createToolbar(state, deps) {
  const {
    setTool,
    changeFloor,
    save,
    undo,
    clearActive,
    requestExit,
    layerFor,
    markFull,
    activeKey,
    confirmModal,
    paintableKinds: PAINTABLE_KINDS,
  } = deps;

  function buildToolbar() {
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '101',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '9px 13px',
      background: 'rgba(12,16,26,0.95)',
      border: '1px solid rgba(143,214,255,0.28)',
      borderRadius: '11px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      font: '11px/1.3 Signika, sans-serif',
      color: '#dcecff',
      pointerEvents: 'auto',
    });
    const row = () => {
      const r = document.createElement('div');
      Object.assign(r.style, { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });
      return r;
    };

    // tool switcher — the brush and the vector tools, all feeding the same masks
    const toolSeg = segmented(
      [
        ['🖌 Brush', 'brush'],
        ['• Point', 'point'],
        ['╱ Line', 'line'],
        ['⬠ Poly', 'polygon'],
      ],
      () => state.tool,
      (v) => setTool(v)
    );
    const snapWrap = document.createElement('label');
    Object.assign(snapWrap.style, { display: 'flex', alignItems: 'center', gap: '4px', pointerEvents: 'auto' });
    const snapCb = document.createElement('input');
    snapCb.type = 'checkbox';
    snapCb.checked = state.snap;
    snapCb.addEventListener('change', () => (state.snap = snapCb.checked));
    snapWrap.append(snapCb, document.createTextNode('Snap ¼-grid'));
    // floor stepper — masks are per-floor AND this drives the live 3D view to
    // match (changeFloor), so the label doubles as a busy indicator while that
    // switch is in flight and the buttons disable to block rapid re-clicks.
    const floorLabelEl = document.createElement('span');
    Object.assign(floorLabelEl.style, { minWidth: '60px', textAlign: 'center', opacity: '0.9' });
    floorLabelEl.textContent = `Floor ${state.floor}`;
    const floorPrevBtn = button('◀', () => changeFloor(-1), '143,214,255');
    const floorNextBtn = button('▶', () => changeFloor(1), '143,214,255');
    const floorWrap = document.createElement('div');
    Object.assign(floorWrap.style, { display: 'flex', alignItems: 'center', gap: '3px' });
    floorWrap.append(floorPrevBtn, floorLabelEl, floorNextBtn);

    const toolRow = row();
    toolRow.append(label('Tool'), toolSeg.el, snapWrap, label('Floor'), floorWrap);

    // kind picker — labelled by the catalog's own suffix, never a literal
    const kindSel = document.createElement('select');
    styleControl(kindSel);
    for (const k of PAINTABLE_KINDS) {
      const o = document.createElement('option');
      o.value = k.id;
      o.textContent = k.suffixes[0];
      kindSel.append(o);
    }
    kindSel.value = state.kind;
    let revertingKind = false;
    kindSel.addEventListener('change', async () => {
      if (revertingKind) return;
      const target = kindSel.value;
      // Guard unsaved work when swapping effects (author ask): the mask you were
      // on stays in memory either way, but remind so it isn't forgotten.
      if (state.dirtySinceSave) {
        const suffix = PAINTABLE_KINDS.find((k) => k.id === target)?.suffixes[0] ?? target;
        const choice = await confirmModal(
          'Unsaved painting',
          `Save your changes before switching to ${suffix}? Your masks stay in memory either way — Save writes them all to the scene at once.`,
          [
            { action: 'save', label: '💾 Save & switch', accent: '167,255,196' },
            { action: 'switch', label: 'Switch without saving', accent: '143,214,255' },
            { action: 'cancel', label: 'Cancel', accent: '255,196,120' },
          ]
        );
        if (choice === 'cancel') {
          revertingKind = true;
          kindSel.value = state.kind; // put the dropdown back
          revertingKind = false;
          return;
        }
        if (choice === 'save') await save();
      }
      state.kind = target;
      layerFor(state.kind);
      markFull(activeKey());
      state.refreshToolbar?.();
    });

    const modeSeg = segmented(
      [
        ['Spray', 'add'],
        ['Paint', 'paint'],
        ['Erase', 'erase'],
      ],
      () => state.brush.mode,
      (v) => (state.brush.mode = v)
    );

    const sizeR = range(
      'Size',
      5,
      400,
      () => state.brush.radius,
      (v) => (state.brush.radius = v)
    );
    const strengthR = range(
      'Strength',
      5,
      255,
      () => state.brush.strength,
      (v) => (state.brush.strength = v)
    );
    const hardR = range(
      'Hardness',
      0,
      100,
      () => Math.round(state.brush.hardness * 100),
      (v) => (state.brush.hardness = v / 100)
    );

    const top = row();
    top.append(label('Mask'), kindSel, modeSeg.el);
    const mid = row();
    mid.append(sizeR.el, strengthR.el, hardR.el);
    const saveBtn = button('💾 Save', save, '167,255,196');
    const bottom = row();
    bottom.append(
      button('↶ Undo', undo, '143,214,255'),
      button('Clear', clearActive, '255,196,120'),
      saveBtn,
      button('Exit', requestExit, '143,214,255')
    );

    const legendRow = row();
    Object.assign(legendRow.style, {
      gap: '6px',
      paddingTop: '5px',
      marginTop: '2px',
      borderTop: '1px solid rgba(143,214,255,0.14)',
    });
    legendRow.append(
      legendItem('LMB', 'paint / add point'),
      legendItem('RMB', 'pan'),
      legendItem('Wheel', 'zoom'),
      legendItem('Enter', 'finish'),
      legendItem('Bksp', 'undo point'),
      legendItem('Ctrl+Z', 'undo'),
      legendItem('Esc', 'cancel / exit')
    );

    bar.append(toolRow, top, mid, bottom, legendRow);
    state.refreshToolbar = () => {
      toolSeg.sync();
      sizeR.sync();
      strengthR.sync();
      hardR.sync();
      modeSeg.sync();
      snapCb.checked = state.snap;
      kindSel.value = state.kind;
      floorLabelEl.textContent = state.floorSwitching ? `Floor ${state.floor} ⏳` : `Floor ${state.floor}`;
      floorPrevBtn.disabled = state.floorSwitching;
      floorNextBtn.disabled = state.floorSwitching;
      floorPrevBtn.style.opacity = state.floorSwitching ? '0.4' : '1';
      floorNextBtn.style.opacity = state.floorSwitching ? '0.4' : '1';
      saveBtn.textContent = state.dirtySinceSave ? '💾 Save •' : '💾 Saved';
      saveBtn.style.opacity = state.dirtySinceSave ? '1' : '0.55';
    };
    state.refreshToolbar();
    return bar;
  }

  return buildToolbar;
}
