/**
 * ui/camera-path-dialog.js — the authoring+playback panel for the revived
 * camera-pass tool (author request, 2026-07-21: "the camera related tools
 * that allowed me to record complex camera motion passes... for PIXI mode
 * with the ability to hide the UI", needed to finish releasing maps).
 *
 * A plain floating DOM panel, matching diag/debug-panel.js's own established
 * style (vanilla `document.createElement`, one injected `<style>` tag) rather
 * than introducing Foundry's `ApplicationV2` as a second UI paradigm — no
 * existing `src/` code uses it yet, and this is not the session to start.
 *
 * Every actual Foundry touch (capture the live view, save/load the scene
 * flag, play/stop) goes through `../foundry/index.js` — the zone's one door
 * (`zones/one-door`) — this file never reaches into `foundry/camera-path*.js`
 * directly.
 *
 * @module ui/camera-path-dialog
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
} from '../foundry/index.js';

const STYLE_ID = 'msa-camera-path-dialog-style';
let panelEl = null;
/** In-memory authoring state — loaded fresh from the scene flag every time
 * the dialog opens (see openCameraPathDialog), so a stale in-memory copy
 * never shadows what another session/reload actually saved. */
let pathState = { keyframes: [], settings: { ...CAMERA_PATH_DEFAULT_SETTINGS } };

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
    #msa-camera-path-dialog {
      position: fixed; top: 80px; right: 20px; width: 340px; max-height: 80vh;
      overflow-y: auto; background: #1b1e24; color: #d8dee9; font: 12px/1.4 system-ui, sans-serif;
      border: 1px solid #3a3f4a; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      z-index: 99998; padding: 10px;
    }
    #msa-camera-path-dialog h3 { margin: 0 0 8px; font-size: 13px; color: #f0b45a; display: flex; justify-content: space-between; align-items: center; }
    #msa-camera-path-dialog .msa-cpd-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
    #msa-camera-path-dialog .msa-cpd-kf { border: 1px solid #2e333c; border-radius: 6px; padding: 6px; margin-bottom: 6px; background: #20242c; }
    #msa-camera-path-dialog input[type=number] { width: 64px; background: #12151a; color: #d8dee9; border: 1px solid #3a3f4a; border-radius: 4px; padding: 2px 4px; }
    #msa-camera-path-dialog select { background: #12151a; color: #d8dee9; border: 1px solid #3a3f4a; border-radius: 4px; padding: 2px 4px; }
    #msa-camera-path-dialog button { background: #2c313a; color: #d8dee9; border: 1px solid #3a3f4a; border-radius: 4px; padding: 3px 7px; cursor: pointer; font-size: 11px; }
    #msa-camera-path-dialog button:hover { background: #3a3f4a; }
    #msa-camera-path-dialog label { font-size: 11px; color: #9aa4b2; }
    #msa-camera-path-dialog .msa-cpd-footer { display: flex; gap: 6px; margin-top: 8px; border-top: 1px solid #2e333c; padding-top: 8px; }
  `;
  document.head.appendChild(el);
}

function fieldRow(labelText, inputEl) {
  const row = document.createElement('div');
  row.className = 'msa-cpd-row';
  const label = document.createElement('label');
  label.textContent = labelText;
  row.appendChild(label);
  row.appendChild(inputEl);
  return row;
}

function numberInput(value, step, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step ?? 1);
  input.value = String(value);
  input.addEventListener('change', () => onChange(Number(input.value)));
  return input;
}

function renderKeyframeRow(kf, index) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-cpd-kf';

  const head = document.createElement('div');
  head.className = 'msa-cpd-row';
  const title = document.createElement('strong');
  title.textContent = `#${index + 1}`;
  head.appendChild(title);

  const goToBtn = document.createElement('button');
  goToBtn.textContent = 'Preview';
  goToBtn.title = 'Snap the live view to this keyframe (no save)';
  goToBtn.addEventListener('click', () => previewCameraKeyframe({ x: kf.x, y: kf.y, scale: kf.scale }));
  head.appendChild(goToBtn);

  const recaptureBtn = document.createElement('button');
  recaptureBtn.textContent = 'Recapture';
  recaptureBtn.title = 'Overwrite this keyframe with the current live view';
  recaptureBtn.addEventListener('click', () => {
    const view = captureCurrentView();
    if (!view) return;
    Object.assign(kf, view);
    render();
  });
  head.appendChild(recaptureBtn);

  const upBtn = document.createElement('button');
  upBtn.textContent = '↑';
  upBtn.disabled = index === 0;
  upBtn.addEventListener('click', () => {
    const arr = pathState.keyframes;
    [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
    render();
  });
  head.appendChild(upBtn);

  const downBtn = document.createElement('button');
  downBtn.textContent = '↓';
  downBtn.disabled = index === pathState.keyframes.length - 1;
  downBtn.addEventListener('click', () => {
    const arr = pathState.keyframes;
    [arr[index], arr[index + 1]] = [arr[index + 1], arr[index]];
    render();
  });
  head.appendChild(downBtn);

  const removeBtn = document.createElement('button');
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove this keyframe';
  removeBtn.addEventListener('click', () => {
    pathState.keyframes.splice(index, 1);
    render();
  });
  head.appendChild(removeBtn);

  wrap.appendChild(head);
  wrap.appendChild(
    fieldRow(
      'hold (ms)',
      numberInput(kf.holdMs, 100, (v) => (kf.holdMs = Math.max(0, v)))
    )
  );

  const cutCheck = document.createElement('input');
  cutCheck.type = 'checkbox';
  cutCheck.checked = kf.cutBefore === true;
  cutCheck.title =
    "Start a NEW shot here: instant snap + a brief hold, instead of panning in from the previous keyframe (V2's own 4-shot cinematic behaviour)";
  cutCheck.addEventListener('change', () => (kf.cutBefore = cutCheck.checked));
  wrap.appendChild(fieldRow('hard cut in (new shot, no pan)', cutCheck));

  return wrap;
}

function renderSettings() {
  const wrap = document.createElement('div');
  const s = pathState.settings;

  wrap.appendChild(
    fieldRow(
      'sweep (ms)',
      numberInput(s.sweepMs, 100, (v) => (s.sweepMs = Math.max(100, v)))
    )
  );

  const easingSelect = document.createElement('select');
  for (const opt of ['cosine', 'linear', 'trapezoidal']) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (opt === s.easing) o.selected = true;
    easingSelect.appendChild(o);
  }
  easingSelect.addEventListener('change', () => (s.easing = easingSelect.value));
  wrap.appendChild(fieldRow('easing', easingSelect));

  const fadeInInput = numberInput(s.fadeInMs, 100, (v) => (s.fadeInMs = Math.max(0, v)));
  fadeInInput.title =
    'Also gates the intro: fade to black, snap to keyframe #1, a 1s pause, fade back up — THEN the path plays. ' +
    '0 = skip the theater, jump straight to keyframe #1 as a hard cut.';
  wrap.appendChild(fieldRow('fade in (ms)', fadeInInput));
  wrap.appendChild(
    fieldRow(
      'fade out (ms)',
      numberInput(s.fadeOutMs, 100, (v) => (s.fadeOutMs = Math.max(0, v)))
    )
  );

  const hideUiCheck = document.createElement('input');
  hideUiCheck.type = 'checkbox';
  hideUiCheck.checked = s.hideUi;
  hideUiCheck.addEventListener('change', () => (s.hideUi = hideUiCheck.checked));
  wrap.appendChild(fieldRow('hide Foundry UI while playing', hideUiCheck));

  const hideLayersCheck = document.createElement('input');
  hideLayersCheck.type = 'checkbox';
  hideLayersCheck.checked = s.hideLayers;
  hideLayersCheck.addEventListener('change', () => (s.hideLayers = hideLayersCheck.checked));
  wrap.appendChild(fieldRow('hide grid/drawings/notes/etc.', hideLayersCheck));

  const letterboxCheck = document.createElement('input');
  letterboxCheck.type = 'checkbox';
  letterboxCheck.checked = s.letterbox;
  letterboxCheck.addEventListener('change', () => (s.letterbox = letterboxCheck.checked));
  wrap.appendChild(fieldRow('letterbox bars (cinematic look)', letterboxCheck));

  const longJumpCheck = document.createElement('input');
  longJumpCheck.type = 'checkbox';
  longJumpCheck.checked = s.longJumpFadeCut;
  longJumpCheck.title =
    'A pan across more than a third of the map hard-cuts (fade to black, snap, fade up) instead of whip-panning';
  longJumpCheck.addEventListener('change', () => (s.longJumpFadeCut = longJumpCheck.checked));
  wrap.appendChild(fieldRow('long jumps → fade cut, not whip-pan', longJumpCheck));

  const rampEnabledCheck = document.createElement('input');
  rampEnabledCheck.type = 'checkbox';
  rampEnabledCheck.checked = s.darknessRamp.enabled;
  rampEnabledCheck.addEventListener('change', () => (s.darknessRamp.enabled = rampEnabledCheck.checked));
  wrap.appendChild(fieldRow('darkness ramp (mood shift while playing)', rampEnabledCheck));

  wrap.appendChild(
    fieldRow(
      'darkness ramp: start (0=day, 1=night)',
      numberInput(s.darknessRamp.start01, 0.05, (v) => (s.darknessRamp.start01 = Math.min(1, Math.max(0, v))))
    )
  );
  wrap.appendChild(
    fieldRow(
      'darkness ramp: end',
      numberInput(s.darknessRamp.end01, 0.05, (v) => (s.darknessRamp.end01 = Math.min(1, Math.max(0, v))))
    )
  );

  return wrap;
}

let statusEl = null;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function renderPresetRow() {
  const row = document.createElement('div');
  row.className = 'msa-cpd-row';

  const select = document.createElement('select');
  for (const preset of CAMERA_PATH_PRESETS) {
    const o = document.createElement('option');
    o.value = preset.id;
    o.textContent = preset.label;
    select.appendChild(o);
  }
  row.appendChild(select);

  const genBtn = document.createElement('button');
  genBtn.textContent = 'Generate';
  genBtn.title = "Auto-frame a starting sweep from this scene's own dimensions (V2's own preset math)";
  genBtn.addEventListener('click', () => {
    if (
      pathState.keyframes.length > 0 &&
      !window.confirm(`Replace the current ${pathState.keyframes.length} keyframe(s) with the generated preset?`)
    ) {
      return;
    }
    const result = generatePresetKeyframes(select.value, { letterboxEnabled: pathState.settings.letterbox });
    if (!result) return setStatus('No active scene to frame — open a scene first.');
    pathState.keyframes = result.keyframes;
    pathState.settings.sweepMs = result.suggestedSweepMs;
    // A generated preset's points are ALL deliberately far apart (that's the
    // whole shot) — the long-jump heuristic exists to catch an ACCIDENTAL
    // far-apart pair, so it must be off here or it silently swaps the
    // intended sweeps for instant fade-cuts (2026-07-21 live bug report).
    pathState.settings.longJumpFadeCut = result.suggestedLongJumpFadeCut;
    render();
    setStatus(
      `Generated "${select.value}" (${result.keyframes.length} keyframes, ${result.suggestedSweepMs}ms/sweep).`
    );
  });
  row.appendChild(genBtn);
  return row;
}

function render() {
  if (!panelEl) return;
  const body = panelEl.querySelector('.msa-cpd-body');
  body.innerHTML = '';

  body.appendChild(renderPresetRow());

  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add keyframe from current view';
  addBtn.addEventListener('click', () => {
    const view = captureCurrentView();
    if (!view) return setStatus('No active canvas — nothing to capture.');
    pathState.keyframes.push({ ...view, holdMs: 0 });
    render();
  });
  body.appendChild(addBtn);

  pathState.keyframes.forEach((kf, i) => body.appendChild(renderKeyframeRow(kf, i)));

  const sectionSettings = document.createElement('div');
  sectionSettings.style.marginTop = '8px';
  sectionSettings.style.borderTop = '1px solid #2e333c';
  sectionSettings.style.paddingTop = '8px';
  sectionSettings.appendChild(renderSettings());
  body.appendChild(sectionSettings);
}

function buildPanel() {
  injectStyle();
  const panel = document.createElement('div');
  panel.id = 'msa-camera-path-dialog';

  const header = document.createElement('h3');
  header.textContent = '🎥 Camera Path';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeCameraPathDialog);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'msa-cpd-body';
  panel.appendChild(body);

  statusEl = document.createElement('div');
  statusEl.style.marginTop = '6px';
  statusEl.style.color = '#9aa4b2';
  panel.appendChild(statusEl);

  const footer = document.createElement('div');
  footer.className = 'msa-cpd-footer';

  const playBtn = document.createElement('button');
  playBtn.textContent = '▶ Play';
  playBtn.addEventListener('click', async () => {
    if (pathState.keyframes.length < 2) return setStatus('Add at least 2 keyframes to play a path.');
    setStatus('Playing…');
    panel.style.display = 'none'; // get the dialog itself out of the shot
    await playCameraPath(normalizeCameraPath(pathState));
    panel.style.display = 'block';
    setStatus('Playback finished.');
  });
  footer.appendChild(playBtn);

  const stopBtn = document.createElement('button');
  stopBtn.textContent = '■ Stop';
  stopBtn.addEventListener('click', () => {
    stopCameraPath();
    panel.style.display = 'block';
    setStatus(isCameraPathPlaying() ? 'Stop failed?' : 'Stopped.');
  });
  footer.appendChild(stopBtn);

  const saveBtn = document.createElement('button');
  saveBtn.textContent = '💾 Save to scene';
  saveBtn.addEventListener('click', async () => {
    const result = await saveCameraPath(normalizeCameraPath(pathState));
    setStatus(result.ok ? 'Saved.' : `Save failed: ${result.reason}`);
  });
  footer.appendChild(saveBtn);

  panel.appendChild(footer);
  return panel;
}

/** Idempotent — opening twice just re-loads+shows the existing panel. */
export function openCameraPathDialog() {
  pathState = normalizeCameraPath(loadCameraPathRaw());
  if (!panelEl) {
    panelEl = buildPanel();
    document.body.appendChild(panelEl);
  }
  panelEl.style.display = 'block';
  render();
  setStatus(`Loaded ${pathState.keyframes.length} keyframe(s) from this scene.`);
}

export function closeCameraPathDialog() {
  if (panelEl) panelEl.style.display = 'none';
}
