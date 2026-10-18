/**
 * ui/rooms/remote/camera-path-popover.js — the Remote's 🎥 header micro-
 * button (Testament §9 UM.2: "header micro-buttons (Director, camera path,
 * health)"), U2.
 *
 * EVERY LINE OF STATE AND EVERY HANDLER HERE IS A FAITHFUL PORT of
 * `ui/camera-path-dialog.js` — the already-live, already-correct dialog the
 * old debug panel opens today (`boot.js`'s own `openCameraPathDialog()` call,
 * completely untouched by this file). This is not a replacement for that
 * dialog; it is a second, independent door onto the exact same real
 * functions (`foundry/index.js`'s camera-path exports), the identical
 * side-by-side pattern U1 already proved for water's Studio card sitting
 * next to its old panel twin. What changes here is ONLY presentation: LANTERN
 * tokens instead of hardcoded hex, and the floating-window shell already
 * proven live by `ui/rooms/studio/effects-department.js#popOutCard`.
 *
 * Per Petition P7 (docs/holy/UI-Testament.md): the mock's own camera-path
 * popover was already rebuilt once against this real source after an earlier
 * draft invented a library of named paths that don't exist — keyframes
 * (`x,y,scale,holdMs,cutBefore`), not waypoints; one path per SCENE.
 *
 * ⚠️ PRESENTATION IS CLASSES, NOT INLINE STYLES (2026-10-18). It used to be
 * `style.cssText` strings on bare `<button>`/`<input>`/`<select>` elements, which
 * can answer no hover, press or focus — and under Foundry's real stylesheet left
 * every checkbox as its orange pair-of-boxes glyph, every select stretched to the
 * window's width and every button on a 0.5s transition with a stuck focus glow. The
 * classes (`msa-btn`, `msa-input`, `msa-select`, `msa-switch-input`, `msa-pop-*`)
 * are styled in `remote-style.js`, from the same kit every room uses.
 *
 * ⚠️ REPLACING KEYFRAMES ASKS INLINE, NOT WITH `window.confirm` (2026-10-18). A
 * native confirm blocks the whole tab — the live WebGPU map with it — behind a grey
 * OS box that ignores the theme. "Generate" arms on the first click ("Replace 3
 * keyframe(s)?") and fires on the second, exactly like every other destructive
 * button; with no keyframes to lose it just generates.
 *
 * @module ui/rooms/remote/camera-path-popover
 */

import {
  captureCurrentView,
  previewCameraKeyframe,
  saveCameraPath,
  loadCameraPathRaw,
  playCameraPath,
  stopCameraPath,
  isCameraPathPlaying,
  normalizeCameraPath,
  generatePresetKeyframes,
  CAMERA_PATH_PRESETS,
  CAMERA_PATH_DEFAULT_SETTINGS,
} from '../../../foundry/index.js';
import { iconMarkup } from '../../widgets/icon-sprite.js';
import { buildArmButton } from '../../widgets/inline-actions.js';
import { replayClass } from '../room-style.js';
import { CAMERA_PATH_PANEL_ID } from './remote-style.js';

const PANEL_ID = CAMERA_PATH_PANEL_ID;

function row(...children) {
  const el = document.createElement('div');
  el.className = 'msa-pop-row';
  el.append(...children);
  return el;
}

function label(text) {
  const el = document.createElement('label');
  el.className = 'msa-pop-label';
  el.textContent = text;
  return el;
}

function fieldRow(labelText, inputEl) {
  return row(label(labelText), inputEl);
}

function numberInput(value, step, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'msa-input msa-input--num';
  input.step = String(step ?? 1);
  input.value = String(value);
  input.addEventListener('change', () => onChange(Number(input.value)));
  return input;
}

function checkboxInput(checked, title, onChange) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  // The kit's real switch (a native checkbox underneath, so keyboard / label-click /
  // form semantics stay the browser's) — Foundry draws a bare checkbox as a glyph.
  input.className = 'msa-switch-input';
  input.checked = checked;
  if (title) input.title = title;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function selectInput(options, current, onChange) {
  const select = document.createElement('select');
  select.className = 'msa-select';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value ?? opt;
    o.textContent = opt.label ?? opt;
    if ((opt.value ?? opt) === current) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function ghostButton(text, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msa-btn msa-btn--sm';
  btn.textContent = text;
  if (title) btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * @param {{onStatus: (text: string) => void}} deps
 * @returns {{root: HTMLElement, render: () => void}}
 */
function buildBody(pathState, rerender, onStatus) {
  const body = document.createElement('div');

  // ---- presets ---------------------------------------------------------
  const presetSelect = selectInput(
    CAMERA_PATH_PRESETS.map((p) => ({ value: p.id, label: p.label })),
    CAMERA_PATH_PRESETS[0]?.id,
    () => {}
  );
  const generate = () => {
    const result = generatePresetKeyframes(presetSelect.value, { letterboxEnabled: pathState.settings.letterbox });
    if (!result) return onStatus('No active scene to frame — open a scene first.');
    pathState.keyframes = result.keyframes;
    pathState.settings.sweepMs = result.suggestedSweepMs;
    pathState.settings.longJumpFadeCut = result.suggestedLongJumpFadeCut;
    rerender();
    onStatus(
      `Generated "${presetSelect.value}" (${result.keyframes.length} keyframes, ${result.suggestedSweepMs}ms/sweep).`
    );
  };
  const genBtn = buildArmButton({
    label: 'Generate',
    title: "Auto-frame a starting sweep from this scene's own dimensions",
    // Only asks when there is something to lose — and says how much.
    needsConfirm: () => pathState.keyframes.length > 0,
    armedLabel: () => `Replace ${pathState.keyframes.length} keyframe(s)?`,
    armedTitle:
      'This replaces the keyframes below with the generated preset. Click again within a few seconds to confirm.',
    onConfirm: generate,
  });
  body.append(row(presetSelect, genBtn));

  // ---- add + keyframe list ----------------------------------------------
  body.append(
    row(
      ghostButton('+ Add keyframe from current view', null, () => {
        const view = captureCurrentView();
        if (!view) return onStatus('No active canvas — nothing to capture.');
        pathState.keyframes.push({ ...view, holdMs: 0 });
        rerender();
      })
    )
  );

  pathState.keyframes.forEach((kf, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'msa-pop-kf';
    const title = document.createElement('strong');
    title.className = 'msa-pop-kf-title';
    title.textContent = `#${index + 1}`;
    const upBtn = ghostButton('↑', 'Move this keyframe earlier', () => {
      const arr = pathState.keyframes;
      [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
      rerender();
    });
    upBtn.disabled = index === 0;
    const downBtn = ghostButton('↓', 'Move this keyframe later', () => {
      const arr = pathState.keyframes;
      [arr[index], arr[index + 1]] = [arr[index + 1], arr[index]];
      rerender();
    });
    downBtn.disabled = index === pathState.keyframes.length - 1;
    wrap.append(
      row(
        title,
        ghostButton('Preview', 'Snap the live view to this keyframe (no save)', () =>
          previewCameraKeyframe({ x: kf.x, y: kf.y, scale: kf.scale })
        ),
        ghostButton('Recapture', 'Overwrite this keyframe with the current live view', () => {
          const view = captureCurrentView();
          if (!view) return;
          Object.assign(kf, view);
          rerender();
        }),
        upBtn,
        downBtn,
        ghostButton('✕', 'Remove this keyframe', () => {
          pathState.keyframes.splice(index, 1);
          rerender();
        })
      ),
      fieldRow(
        'hold (ms)',
        numberInput(kf.holdMs, 100, (v) => (kf.holdMs = Math.max(0, v)))
      ),
      fieldRow(
        'hard cut in (new shot, no pan)',
        checkboxInput(
          kf.cutBefore === true,
          'Start a NEW shot here: instant snap + a brief hold, instead of panning in from the previous keyframe',
          (v) => (kf.cutBefore = v)
        )
      )
    );
    body.appendChild(wrap);
  });

  // ---- path settings ------------------------------------------------------
  const s = pathState.settings;
  const settingsWrap = document.createElement('div');
  settingsWrap.className = 'msa-pop-settings';
  settingsWrap.append(
    fieldRow(
      'sweep (ms)',
      numberInput(s.sweepMs, 100, (v) => (s.sweepMs = Math.max(100, v)))
    ),
    fieldRow(
      'easing',
      selectInput(['cosine', 'linear', 'trapezoidal'], s.easing, (v) => (s.easing = v))
    ),
    fieldRow(
      'fade in (ms)',
      numberInput(s.fadeInMs, 100, (v) => (s.fadeInMs = Math.max(0, v)))
    ),
    fieldRow(
      'fade out (ms)',
      numberInput(s.fadeOutMs, 100, (v) => (s.fadeOutMs = Math.max(0, v)))
    ),
    fieldRow(
      'hide Foundry UI while playing',
      checkboxInput(s.hideUi, null, (v) => (s.hideUi = v))
    ),
    fieldRow(
      'hide grid/drawings/notes/etc.',
      checkboxInput(s.hideLayers, null, (v) => (s.hideLayers = v))
    ),
    fieldRow(
      'letterbox bars (cinematic look)',
      checkboxInput(s.letterbox, null, (v) => (s.letterbox = v))
    ),
    fieldRow(
      'long jumps → fade cut, not whip-pan',
      checkboxInput(
        s.longJumpFadeCut,
        'A pan across more than a third of the map hard-cuts instead of whip-panning',
        (v) => (s.longJumpFadeCut = v)
      )
    ),
    fieldRow(
      'darkness ramp (mood shift while playing)',
      checkboxInput(s.darknessRamp.enabled, null, (v) => (s.darknessRamp.enabled = v))
    ),
    fieldRow(
      'ramp start (0=day, 1=night)',
      numberInput(s.darknessRamp.start01, 0.05, (v) => (s.darknessRamp.start01 = Math.min(1, Math.max(0, v))))
    ),
    fieldRow(
      'ramp end',
      numberInput(s.darknessRamp.end01, 0.05, (v) => (s.darknessRamp.end01 = Math.min(1, Math.max(0, v))))
    )
  );
  body.appendChild(settingsWrap);

  return body;
}

/**
 * Install the Remote's camera-path popover, once.
 * @returns {{open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean}}
 */
export function installCameraPathPopover() {
  if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID)._msaController;

  let pathState = { keyframes: [], settings: { ...CAMERA_PATH_DEFAULT_SETTINGS } };
  let open = false;

  const win = document.createElement('div');
  win.id = PANEL_ID;
  win.hidden = true;

  const head = document.createElement('div');
  head.className = 'msa-pop-head';
  const title = document.createElement('span');
  title.className = 'msa-pop-title';
  title.innerHTML = `${iconMarkup('camera')}Camera Path`;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'hbtn';
  closeBtn.title = 'Close';
  closeBtn.innerHTML = iconMarkup('x');
  closeBtn.addEventListener('click', () => controller.close());
  head.append(title, closeBtn);

  const bodyHost = document.createElement('div');
  const statusEl = document.createElement('div');
  statusEl.className = 'msa-pop-status';
  const setStatus = (text) => (statusEl.textContent = text ?? '');

  const footer = document.createElement('div');
  footer.className = 'msa-pop-foot';

  function render() {
    bodyHost.innerHTML = '';
    bodyHost.appendChild(buildBody(pathState, render, setStatus));
  }

  const playBtn = ghostButton('▶ Play', null, async () => {
    if (pathState.keyframes.length < 2) return setStatus('Add at least 2 keyframes to play a path.');
    setStatus('Playing…');
    win.style.display = 'none'; // get the popover itself out of the shot
    await playCameraPath(normalizeCameraPath(pathState));
    win.style.display = 'block';
    setStatus('Playback finished.');
  });
  const stopBtn = ghostButton('■ Stop', null, () => {
    stopCameraPath();
    win.style.display = 'block';
    setStatus(isCameraPathPlaying() ? 'Stop failed?' : 'Stopped.');
  });
  const saveBtn = ghostButton('💾 Save to scene', null, async () => {
    const result = await saveCameraPath(normalizeCameraPath(pathState));
    setStatus(result.ok ? 'Saved.' : `Save failed: ${result.reason}`);
  });
  footer.append(playBtn, stopBtn, saveBtn);

  win.append(head, bodyHost, statusEl, footer);
  document.body.appendChild(win);

  const controller = {
    open() {
      pathState = normalizeCameraPath(loadCameraPathRaw());
      open = true;
      win.hidden = false;
      win.style.display = 'block';
      replayClass(win, 'msa-pop-enter');
      render();
      setStatus(`Loaded ${pathState.keyframes.length} keyframe(s) from this scene.`);
    },
    close() {
      open = false;
      win.hidden = true;
    },
    toggle() {
      if (open) controller.close();
      else controller.open();
    },
    isOpen: () => open,
  };
  win._msaController = controller;
  return controller;
}
