/**
 * foundry/camera-path-player.js — the LIVE half of the revived camera-pass
 * tool (see camera-path.js's header for the "why not a V2 port" reasoning).
 * Everything here touches `canvas`/`Hooks`/DOM, so it lives in `foundry/` —
 * the one zone (with `diag/`) the `foundry/adapter-only` wall allows to.
 *
 * PLAYBACK PRIMITIVE: sequences Foundry's OWN `canvas.animatePan()` calls
 * (one per sweep segment, awaited) with plain timed holds in between — it
 * never runs its own per-frame loop or writes `canvas.pan()` directly outside
 * of what `animatePan` already does internally. Cancelling mid-sweep is
 * `CanvasAnimation.terminateAnimation('canvas.animatePan')` — the exact name
 * `Canvas#animatePan` registers itself under (client/canvas/board.mjs),
 * verified against source rather than guessed.
 *
 * TEARDOWN SAFETY: V2's own service (legacy/foundry/camera-path-service.js,
 * per this session's own research) had a documented history of leaking its
 * hide-UI/letterbox/fade overlays across scene reloads — multiple DOM-purge
 * fixes layered on after the fact. Built correctly from the start here
 * instead: exactly ONE idempotent `restore()` closure, called from a `finally`
 * around playback AND from a `canvasTearDown` hook AND from `stopCameraPath`
 * — calling it twice is always safe (every step no-ops if already undone).
 *
 * @module foundry/camera-path-player
 */

import {
  buildCameraTimeline,
  totalTimelineDurationMs,
  resolveEasingFn,
  generateKeyframePreset,
  LETTERBOX_BAR_HEIGHT_PCT,
} from './camera-path.js';
import { createLogger } from '../core/log.js';

const log = createLogger('camera-path');

const FLAG_SCOPE = 'map-shine-advanced';
const FLAG_KEY = 'cameraPath';
const HIDE_UI_STYLE_ID = 'msa-camera-path-style';
const HIDE_UI_CLASS = 'msa-camera-path-hide-ui';
const LETTERBOX_CLASS = 'msa-camera-path-letterbox';
// Foundry's own chrome (client/applications/views/game.hbs): #interface holds
// scene-controls/players/navigation/hotbar/sidebar as ONE container; #hud is
// the token/tile HUD popup, a sibling of #interface, not inside it. `#msa-
// keyhole-boot` (2026-07-22 live report: the FPS/frame-gap HUD was still
// visible during playback) is boot.js's OWN corner overlay, not Foundry's —
// display:none on it is safe, the heartbeat canvas inside keeps rendering
// real frames regardless of CSS visibility (that's the whole point of it
// being a real canvas, per boot.js's own comment). Mirrors V2's own "hide
// grid/drawings/notes/sounds/templates/controls (+ door controls)" layer
// set — see camera-path.js's header for why the REST of the data model was
// redesigned but this proven, author-tuned list was not.
const HIDDEN_LAYER_KEYS = ['grid', 'drawings', 'notes', 'sounds', 'templates', 'controls'];

let styleInjected = false;
let hooksRegistered = false;
let playState = null; // {abort: AbortController, restore: () => void} while playing, else null

function injectHideUiStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.id = HIDE_UI_STYLE_ID;
  el.textContent = `
    body.${HIDE_UI_CLASS} #interface,
    body.${HIDE_UI_CLASS} #hud,
    body.${HIDE_UI_CLASS} #msa-debug-panel,
    body.${HIDE_UI_CLASS} #msa-camera-path-dialog,
    body.${HIDE_UI_CLASS} #msa-keyhole-boot {
      display: none !important;
    }
    .msa-camera-path-fade {
      position: fixed; inset: 0; background: #000; pointer-events: none;
      z-index: 100000; transition: opacity linear;
    }
    .${LETTERBOX_CLASS} {
      position: fixed; inset: 0; pointer-events: none; z-index: 99999;
    }
    .${LETTERBOX_CLASS}__bar {
      position: absolute; left: 0; right: 0; background: #000;
      height: ${LETTERBOX_BAR_HEIGHT_PCT * 100}%;
    }
    .${LETTERBOX_CLASS}__bar--top { top: 0; }
    .${LETTERBOX_CLASS}__bar--bottom { bottom: 0; }
  `;
  document.head.appendChild(el);
  styleInjected = true;
}

function buildLetterboxOverlay() {
  const root = document.createElement('div');
  root.className = LETTERBOX_CLASS;
  const top = document.createElement('div');
  top.className = `${LETTERBOX_CLASS}__bar ${LETTERBOX_CLASS}__bar--top`;
  const bottom = document.createElement('div');
  bottom.className = `${LETTERBOX_CLASS}__bar ${LETTERBOX_CLASS}__bar--bottom`;
  root.appendChild(top);
  root.appendChild(bottom);
  document.body.appendChild(root);
  return root;
}

/** @returns {{width:number,height:number}|null} the PADDED canvas dims (not
 *  the tight scene rect) — matches V2's own `resolveSceneMapDimensions`,
 *  used only for the long-jump-fade-cut ratio (a coarse "basically across
 *  the whole map" measure, not precise framing). */
function getPaddedCanvasDimensions() {
  const dims = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
  if (!dims?.width || !dims?.height) return null;
  return { width: dims.width, height: dims.height };
}

/** @returns {{sceneX:number,sceneY:number,sceneWidth:number,sceneHeight:number}|null}
 *  the TIGHT scene rect — what `generateKeyframePreset`'s zoom-to-fit math
 *  actually needs (matches V2's own `generateCameraPathPreset`'s read). */
function getSceneRectDimensions() {
  const dims = typeof canvas !== 'undefined' ? canvas?.scene?.dimensions : null;
  if (!dims?.sceneWidth || !dims?.sceneHeight) return null;
  return { sceneX: dims.sceneX, sceneY: dims.sceneY, sceneWidth: dims.sceneWidth, sceneHeight: dims.sceneHeight };
}

/**
 * Live wrapper around `generateKeyframePreset` — reads the scene's real
 * dimensions and the browser's real viewport so the author never has to.
 * @param {'full'|'s_to_n'|'n_to_s'|'w_to_e'|'e_to_w'} presetId
 * @param {{letterboxEnabled?: boolean}} [opts]
 * @returns {{keyframes: import('./camera-path.js').CameraKeyframe[], suggestedSweepMs: number,
 *   suggestedLongJumpFadeCut: boolean}|null}
 */
export function generatePresetKeyframes(presetId, opts = {}) {
  const dims = getSceneRectDimensions();
  if (!dims) return null;
  return generateKeyframePreset(presetId, {
    dims,
    screenW: window.innerWidth,
    screenH: window.innerHeight,
    letterboxEnabled: opts.letterboxEnabled === true,
  });
}

/** Idempotent — call from a keydown handler or a hook, never assumes it's the first call. */
function stopIfPlaying() {
  if (playState) stopCameraPath();
}

/** Registered once, lazily, on the first play — never at module load, so a
 * Node test importing this file never touches `Hooks`/`document`. */
function ensureSafetyHooksRegistered() {
  if (hooksRegistered || typeof Hooks === 'undefined') return;
  hooksRegistered = true;
  // A scene change mid-playback invalidates the whole timeline (new canvas,
  // new stage) regardless of whether it's a real scene or a blank teardown —
  // unlike canvas-lifecycle.js's watchdog, there is no "did a real draw
  // follow" question to ask here; ANY teardown while playing must stop.
  Hooks.on('canvasTearDown', stopIfPlaying);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') stopIfPlaying();
  });
}

/** @returns {{x:number,y:number,scale:number}|null} `null` outside a live canvas. */
export function captureCurrentView() {
  if (typeof canvas === 'undefined' || !canvas?.stage) return null;
  return { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
}

/** Snap the live view straight to a keyframe, no animation — the dialog's
 * own "Preview" button, so an author can check framing without touching
 * `canvas.pan` outside `foundry/` (adapter-only). */
export function previewCameraKeyframe({ x, y, scale }) {
  if (typeof canvas === 'undefined' || !canvas?.pan) return;
  canvas.pan({ x, y, scale });
}

/**
 * @param {import('./camera-path.js').CameraPath} pathData - already normalized.
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function saveCameraPath(pathData) {
  if (typeof canvas === 'undefined' || !canvas?.scene) {
    return { ok: false, reason: 'no active scene (canvas.scene is absent)' };
  }
  try {
    await canvas.scene.setFlag(FLAG_SCOPE, FLAG_KEY, pathData);
    return { ok: true, reason: null };
  } catch (err) {
    log.error('saveCameraPath failed', err);
    return { ok: false, reason: `setFlag threw: ${err?.message ?? err}` };
  }
}

/** @returns {*} the raw stored flag value, or `null` if absent/no scene — the
 *   CALLER runs it through `normalizeCameraPath` (this file never imports the
 *   pure module's normalizer just to immediately hand back its input). */
export function loadCameraPathRaw() {
  if (typeof canvas === 'undefined' || !canvas?.scene) return null;
  try {
    return canvas.scene.getFlag(FLAG_SCOPE, FLAG_KEY) ?? null;
  } catch (err) {
    log.error('loadCameraPathRaw failed', err);
    return null;
  }
}

export function isCameraPathPlaying() {
  return !!playState;
}

/** @returns {Map<string, boolean>} which layers were ACTUALLY hidden (i.e.
 *  were `renderable:true` beforehand) — V2's own `_hideMapLayers` care,
 *  ported: a layer a GM had already hidden for their own reason must come
 *  back hidden, not get force-enabled by this tool's own restore. */
function hideLayers() {
  const prior = new Map();
  if (typeof canvas === 'undefined') return prior;
  for (const key of HIDDEN_LAYER_KEYS) {
    const layer = canvas[key];
    if (layer?.renderable) {
      prior.set(key, true);
      layer.renderable = false;
    }
  }
  return prior;
}

/** @param {Map<string, boolean>} prior */
function restoreLayers(prior) {
  if (typeof canvas === 'undefined') return;
  for (const [key, state] of prior) {
    const layer = canvas[key];
    if (layer) layer.renderable = state;
  }
}

/** @returns {number|null} the scene's current `environment.darknessLevel`, or
 *  `null` if unreadable (no scene, or a malformed value — never guessed). */
function readDarkness01() {
  const v = typeof canvas !== 'undefined' ? canvas?.scene?.environment?.darknessLevel : undefined;
  return Number.isFinite(v) ? v : null;
}

/** @param {number} darkness01 @param {{animateMs?: number}} [opts] */
async function writeDarkness01(darkness01, opts = {}) {
  if (typeof canvas === 'undefined' || !canvas?.scene?.update) return;
  const updateOpts = opts.animateMs > 0 ? { animateDarkness: opts.animateMs } : {};
  try {
    await canvas.scene.update({ environment: { darknessLevel: darkness01 } }, updateOpts);
  } catch (err) {
    log.error('camera-path darkness ramp: scene.update failed', err);
  }
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function buildFadeOverlay() {
  const el = document.createElement('div');
  el.className = 'msa-camera-path-fade';
  el.style.opacity = '0';
  document.body.appendChild(el);
  return el;
}

/** @param {HTMLElement} el @param {number} toOpacity @param {number} ms @param {AbortSignal} signal */
function fadeTo(el, toOpacity, ms) {
  return new Promise((resolve) => {
    if (ms <= 0) {
      el.style.opacity = String(toOpacity);
      return resolve();
    }
    el.style.transitionDuration = `${ms}ms`;
    // Next frame, so the browser registers the starting opacity before the
    // transition target changes — otherwise it can jump instantly.
    requestAnimationFrame(() => {
      el.style.opacity = String(toOpacity);
      setTimeout(resolve, ms);
    });
  });
}

/**
 * Play a camera path start to finish. Resolves when playback completes OR is
 * stopped early (`stopCameraPath()` / Escape / a scene teardown) — it never
 * rejects for a user-initiated stop, only logs+resolves.
 * @param {import('./camera-path.js').CameraPath} pathData - already normalized.
 * @param {{onSegment?: (index: number, total: number) => void}} [opts]
 * @returns {Promise<void>}
 */
export async function playCameraPath(pathData, opts = {}) {
  if (typeof canvas === 'undefined' || !canvas?.stage) {
    log.warn('playCameraPath: no active canvas — nothing to play.');
    return;
  }
  if (playState) stopCameraPath(); // one playback at a time; a re-click restarts cleanly
  injectHideUiStyle();
  ensureSafetyHooksRegistered();

  const { settings } = pathData;
  const segments = buildCameraTimeline(pathData, getPaddedCanvasDimensions());
  const abort = new AbortController();
  let fadeEl = null;
  let uiHidden = false;
  let layerPriorStates = null; // Map|null
  let letterboxEl = null;
  let originalDarkness01 = null;

  const restore = () => {
    if (fadeEl) {
      fadeEl.remove();
      fadeEl = null;
    }
    if (letterboxEl) {
      letterboxEl.remove();
      letterboxEl = null;
    }
    if (uiHidden) {
      document.body.classList.remove(HIDE_UI_CLASS);
      uiHidden = false;
    }
    if (layerPriorStates) {
      restoreLayers(layerPriorStates);
      layerPriorStates = null;
    }
    if (originalDarkness01 !== null) {
      const restoreTo = originalDarkness01;
      originalDarkness01 = null;
      // Fire-and-forget, deliberately not awaited — restore() itself must
      // stay synchronous (it also runs from stopCameraPath's own sync path).
      writeDarkness01(restoreTo).catch(() => {});
    }
    playState = null;
  };
  playState = { abort, restore };

  try {
    if (settings.hideUi) {
      document.body.classList.add(HIDE_UI_CLASS);
      uiHidden = true;
    }
    if (settings.hideLayers) {
      layerPriorStates = hideLayers();
    }
    if (settings.letterbox) {
      letterboxEl = buildLetterboxOverlay();
    }
    if (settings.darknessRamp.enabled) {
      originalDarkness01 = readDarkness01();
      await writeDarkness01(settings.darknessRamp.start01);
    }
    if (settings.fadeInMs > 0) {
      fadeEl = buildFadeOverlay();
      fadeEl.style.opacity = '1';
      await fadeTo(fadeEl, 0, settings.fadeInMs);
    }

    if (settings.darknessRamp.enabled && !abort.signal.aborted) {
      // Fire-and-forget: Foundry's own `animateDarkness` ramp runs on its own
      // clock in parallel with the sweep below, exactly like a real dusk/dawn
      // reveal — nothing here needs to wait on it.
      writeDarkness01(settings.darknessRamp.end01, { animateMs: totalTimelineDurationMs(segments) }).catch(() => {});
    }

    for (let i = 0; i < segments.length; i++) {
      if (abort.signal.aborted) break;
      const seg = segments[i];
      opts.onSegment?.(i, segments.length);
      if (seg.type === 'hold') {
        await sleepAbortable(seg.durationMs, abort.signal);
      } else if (seg.type === 'fadecut') {
        if (!fadeEl) fadeEl = buildFadeOverlay();
        await fadeTo(fadeEl, 1, seg.holdMs);
        if (!abort.signal.aborted) previewCameraKeyframe(seg.to);
        if (!abort.signal.aborted) await fadeTo(fadeEl, 0, seg.holdMs);
      } else if (seg.type === 'cut') {
        // A new SHOT starting (`cutBefore`) — instant snap, no fade (unlike
        // `fadecut`, which is the automatic long-jump heuristic and DOES
        // fade), then a brief hold before the next sweep begins. Matches
        // V2's own `camera-animator.js#animateTimeline` behaviour exactly.
        previewCameraKeyframe(seg.to);
        await sleepAbortable(seg.holdMs, abort.signal);
      } else {
        await canvas.animatePan({
          x: seg.to.x,
          y: seg.to.y,
          scale: seg.to.scale,
          duration: seg.durationMs,
          easing: resolveEasingFn(seg.easing, seg.durationMs),
        });
      }
    }

    if (!abort.signal.aborted && settings.fadeOutMs > 0) {
      if (!fadeEl) fadeEl = buildFadeOverlay();
      await fadeTo(fadeEl, 1, settings.fadeOutMs);
    }
  } catch (err) {
    log.error('playCameraPath failed mid-playback', err);
  } finally {
    restore();
  }
}

/** Cancel an in-progress playback immediately (mid-sweep or mid-hold) and
 * restore UI/layers/fade. Safe to call when nothing is playing. */
export function stopCameraPath() {
  if (typeof CanvasAnimation !== 'undefined') {
    CanvasAnimation.terminateAnimation('canvas.animatePan');
  }
  if (!playState) return;
  playState.abort.abort();
  playState.restore(); // also called by playCameraPath's own `finally`; idempotent
}
