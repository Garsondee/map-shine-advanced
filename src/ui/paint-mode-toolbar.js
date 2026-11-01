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
import { kindFileSupport } from '../scene/index.js';
import { MASK_LIST_BOX } from './paint-mode-mask-list.js';

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
    activeKey,
    confirmModal,
    paintableKinds: PAINTABLE_KINDS,
    // MSA Ready (2026-11-01) — see paint-mode.js's header.
    startFromWalls,
    startAllOutdoors,
    setCleanViewOn,
    saveToMapFile,
    downloadFile,
    importFile,
    fileSupportFor,
    // The Masks panel (2026-11-01): the painter's one switch door, and the panel toggle.
    switchKind,
    toggleMaskList,
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

    // tool switcher — the brush, the vector tools, and (MSA Ready) the quick
    // shape tools for indoors/outdoors, all feeding the same masks
    const toolSeg = segmented(
      [
        ['🖌 Brush', 'brush'],
        ['• Point', 'point'],
        ['╱ Line', 'line'],
        ['⬠ Poly', 'polygon'],
        ['▭ Rect', 'rect'],
        ['▦ Cells', 'cells'],
        ['⌂ Room', 'room'],
      ],
      () => state.tool,
      (v) => setTool(v)
    );
    // Snap: Off / ¼ grid (the old sub-grid) / Grid (whole squares or hexes).
    const snapSeg = segmented(
      [
        ['Free', 'off'],
        ['¼ grid', 'quarter'],
        ['Grid', 'grid'],
      ],
      () => state.snapMode,
      (v) => (state.snapMode = v)
    );
    const snapWrap = document.createElement('div');
    Object.assign(snapWrap.style, { display: 'flex', alignItems: 'center', gap: '4px' });
    snapWrap.append(label('Snap'), snapSeg.el);
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
    // Foundry's own stylesheet gives every <select> `width: 100%`, which made
    // this one take a whole row of the toolbar to itself.
    Object.assign(kindSel.style, { width: 'auto', flex: '0 0 auto' });
    for (const k of PAINTABLE_KINDS) {
      const o = document.createElement('option');
      o.value = k.id;
      o.textContent = k.suffixes[0];
      kindSel.append(o);
    }
    kindSel.value = state.kind;
    // Guard unsaved work when swapping masks (author ask) — through the
    // painter's one switch door, which the Masks panel uses too.
    kindSel.addEventListener('change', async () => {
      await switchKind(kindSel.value);
      kindSel.value = state.kind; // a cancelled switch puts the dropdown back
    });
    // THE MASKS PANEL (2026-11-01) — every mask, whether it's working, one click to paint it.
    const masksBtn = button('☰ Masks', () => toggleMaskList(), '143,214,255');
    masksBtn.title = 'Show every mask Map Shine can use, which ones this floor has, and switch between them (M).';

    const modeSeg = segmented(
      [
        ['Spray', 'add'],
        ['Paint', 'paint'],
        ['Erase', 'erase'],
      ],
      () => state.brush.mode,
      (v) => (state.brush.mode = v)
    );
    // `_Outdoors` speaks in its own words (MSA Ready): you paint INDOORS (black)
    // or OUTDOORS (white), always at full strength — a half-indoors room is a bug.
    const sideSeg = segmented(
      [
        ['■ Indoors', 'in'],
        ['□ Outdoors', 'out'],
      ],
      () => (state.brush.mode === 'erase' ? 'in' : 'out'),
      (v) => {
        state.brush.mode = v === 'in' ? 'erase' : 'paint';
        state.brush.strength = 255;
        state.refreshToolbar?.();
      }
    );
    const startAllBtn = button('All outdoors', startAllOutdoors, '143,214,255');
    startAllBtn.title = 'Make this whole floor outdoors (white), then paint the buildings as indoors.';
    const startWallsBtn = button('Start from walls', startFromWalls, '167,255,196');
    startWallsBtn.title =
      "Every room Foundry's walls close off becomes indoors; everything else outdoors. A first guess — check it, then fix what's wrong.";
    const outdoorsWrap = document.createElement('div');
    Object.assign(outdoorsWrap.style, { display: 'flex', alignItems: 'center', gap: '6px' });
    outdoorsWrap.append(sideSeg.el, startAllBtn, startWallsBtn);

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

    /** This layer's name as the author sees it — the catalog's own suffix
     * (`_Fire`), never a raw kind id, and never a guess about which layer. */
    const activeSuffix = () => PAINTABLE_KINDS.find((k) => k.id === state.kind)?.suffixes[0] ?? state.kind;

    // CLEAR ASKS FIRST (2026-08-31). It wipes a whole painted layer on one
    // click — strictly more destructive than switching effects or closing the
    // painter, BOTH of which already confirm — and the undo that covers it
    // only lives until the painter closes. Names the exact kind AND floor,
    // because "Clear" alone never said WHICH of the per-kind, per-floor masks
    // was about to go.
    let clearing = false;
    async function confirmClear() {
      if (clearing) return;
      clearing = true;
      try {
        const choice = await confirmModal(
          'Clear this mask?',
          `Clear the painted ${activeSuffix()} mask on floor ${state.floor}? Undo can bring it back while the ` +
            "painter is open, but not after you close it — and it's gone from the scene as soon as you Save.",
          [
            { action: 'clear', label: 'Clear it', accent: '255,120,120' },
            { action: 'cancel', label: 'Keep it', accent: '143,214,255' },
          ]
        );
        if (choice === 'clear') clearActive();
      } finally {
        clearing = false;
      }
    }

    const top = row();
    top.append(label('Mask'), kindSel, masksBtn, modeSeg.el, outdoorsWrap);
    const mid = row();
    mid.append(sizeR.el, strengthR.el, hardR.el);

    // VIEW (MSA Ready) — Clean view: Foundry's plain map art, no lighting or
    // weather, under the overlay; and how strongly the overlay shows.
    const viewSeg = segmented(
      [
        ['Effects', 'fx'],
        ['Clean map', 'clean'],
      ],
      () => (state.cleanView ? 'clean' : 'fx'),
      (v) => setCleanViewOn(v === 'clean')
    );
    const opacityR = range(
      'Overlay',
      10,
      100,
      () => Math.round(state.overlayOpacity * 100),
      (v) => (state.overlayOpacity = v / 100)
    );
    const viewRow = row();
    viewRow.append(label('View'), viewSeg.el, opacityR.el);

    const saveBtn = button('💾 Save', save, '167,255,196');
    saveBtn.title = 'Keep your painting in the scene (a draft). Save next to map makes it a real mask file.';
    const bottom = row();
    bottom.append(
      button('↶ Undo', undo, '143,214,255'),
      button('Clear', confirmClear, '255,196,120'),
      saveBtn,
      button('Exit', requestExit, '143,214,255')
    );

    // FULL-SIZE FILES (MSA Ready) — the mask at the map art's own pixel size.
    const fileSaveBtn = button('⬆ Save next to map', () => saveToMapFile(), '167,255,196');
    fileSaveBtn.title = "Write this mask at the map's full size, beside the map art, named so Map Shine finds it.";
    const fileDownBtn = button('⬇ Download', () => downloadFile(), '143,214,255');
    fileDownBtn.title =
      'Save this mask at full size to your computer — to edit in GIMP, Krita or Photopea, or keep as a backup.';
    const fileImportBtn = button('⤒ Import', () => importFile(), '143,214,255');
    fileImportBtn.title =
      'Pick a mask picture from your computer. Map Shine checks it fits the map, renames it and puts it beside the map art.';
    const fileStatus = document.createElement('span');
    Object.assign(fileStatus.style, { opacity: '0.8', maxWidth: '360px' });
    const fileRow = row();
    fileRow.append(label('File'), fileSaveBtn, fileDownBtn, fileImportBtn, fileStatus);
    const setEnabled = (btn, on) => {
      btn.disabled = !on;
      btn.style.opacity = on ? '1' : '0.4';
      btn.style.cursor = on ? 'pointer' : 'default';
    };

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
      legendItem('S', 'snap'),
      legendItem('V', 'clean view'),
      legendItem('M', 'masks'),
      legendItem('Esc', 'cancel / exit')
    );

    bar.append(toolRow, top, mid, viewRow, bottom, fileRow, legendRow);
    state.refreshToolbar = () => {
      toolSeg.sync();
      sizeR.sync();
      strengthR.sync();
      hardR.sync();
      modeSeg.sync();
      snapSeg.sync();
      sideSeg.sync();
      viewSeg.sync();
      opacityR.sync();
      kindSel.value = state.kind;
      const isOutdoors = state.kind === 'outdoors';
      // 'inline-flex', not '': clearing the inline display dropped the segment
      // to `block` and stacked Spray/Paint/Erase vertically (found live, 2026-11-01).
      modeSeg.el.style.display = isOutdoors ? 'none' : 'inline-flex';
      outdoorsWrap.style.display = isOutdoors ? 'flex' : 'none';
      // The file row: what this layer can do, and why not when it can't.
      const { info, loading } = fileSupportFor();
      const support = kindFileSupport(state.kind, { fileExists: !!info?.existingUrl });
      const hasArt = !!info?.artUrl;
      const idle = !state.busy && !loading;
      setEnabled(fileSaveBtn, idle && hasArt && support.canWrite);
      setEnabled(fileDownBtn, idle && hasArt && support.canWrite);
      setEnabled(fileImportBtn, idle && hasArt && support.canImport);
      if (state.busy) fileStatus.textContent = state.busy;
      else if (loading) fileStatus.textContent = 'Opening the mask file…';
      else if (!info) fileStatus.textContent = 'Load a scene with map art to save files.';
      else if (!hasArt) fileStatus.textContent = 'This floor has no map art to put a mask beside.';
      else if (!support.canWrite) fileStatus.textContent = `Import only: ${support.why}.`;
      else if (state.fileBacked[activeKey()]) fileStatus.textContent = 'This is the mask file — no unsaved changes.';
      else if (info.existingUrl) fileStatus.textContent = 'Opened from its file; Save next to map replaces it.';
      else fileStatus.textContent = 'No file yet.';
      floorLabelEl.textContent = state.floorSwitching ? `Floor ${state.floor} ⏳` : `Floor ${state.floor}`;
      floorPrevBtn.disabled = state.floorSwitching;
      floorNextBtn.disabled = state.floorSwitching;
      floorPrevBtn.style.opacity = state.floorSwitching ? '0.4' : '1';
      floorNextBtn.style.opacity = state.floorSwitching ? '0.4' : '1';
      saveBtn.textContent = state.dirtySinceSave ? '💾 Save •' : '💾 Saved';
      saveBtn.style.opacity = state.dirtySinceSave ? '1' : '0.55';
      // DIMMED MEANT NOTHING (2026-08-31): the button LOOKED disabled when
      // there was nothing to save and still fired a real scene-flag write on
      // a stray click. The opacity is the appearance; this is the state.
      saveBtn.disabled = !state.dirtySinceSave;
      saveBtn.style.cursor = state.dirtySinceSave ? 'pointer' : 'default';
      masksBtn.style.background = `rgba(143,214,255,${state.maskListOpen ? 0.34 : 0.16})`;
      // Centred as always, unless the open Masks panel would sit under its left
      // edge — then just far enough right to clear it.
      const halfBar = Math.ceil((bar.offsetWidth || 0) / 2);
      bar.style.left = state.maskListOpen ? `max(50%, ${MASK_LIST_BOX.right + 12 + halfBar}px)` : '50%';
      state.refreshMaskList?.(); // the panel follows the layer, the floor and the save state
    };
    state.refreshToolbar();
    return bar;
  }

  return buildToolbar;
}
