/**
 * @fileoverview ui/loading-screen.js — the curtain for cold loads and scene
 * changes. Never for floor changes.
 *
 * The thinking lives in `ui/load-progress.js` (pure, Node-tested); this file is
 * only the DOM and the frame loop. Browser-only, so it is verified live via the
 * debug panel rather than faked into a Node test.
 *
 * ## Three rules, each from a specific line of the plan
 *
 * **1. Never on a floor change.** Keyhole.md §4.5 promises *"floor changes without
 * loading screens"* and §7 puts the level-transition curtain on the kill list. This
 * is delivered by construction (coarse pins for every floor are always resident,
 * so the target floor renders instantly) — but Foundry hands us no way to tell the
 * two apart from hooks alone: `Scene#view` (scene.mjs:280) calls `canvas.draw()`
 * for `sceneChanged || levelChanged`, and `draw()` fires BOTH `canvasInit` and
 * `canvasReady` either way. `load-progress.js#shouldShowForScene` is the entire
 * defence, so it is a pure function with its own tests rather than an `if` buried
 * in a hook.
 *
 * **2. Honest progress.** §4.5 asks for *"**honest** progress (pages resident /
 * pages needed)"*; §7 kills *"the 0%/98% two-gate warmup and its 'Ready!' lie"*. No
 * fabricated percentages, no bar before anything is countable, and "Ready" only
 * when a frame has actually painted.
 *
 * **3. The liveness pulse is deliberately fragile.** The author's requirement is
 * that the user must not think Foundry has frozen. The obvious answer — a CSS
 * `@keyframes` spinner — is exactly wrong: CSS animations run on the COMPOSITOR
 * thread and keep spinning perfectly while the main thread is dead. That is the
 * worst available outcome, a confident animation asserting health precisely when
 * there is none, and it is how a hung tab convinces someone to sit and wait.
 *
 * So the pulse is driven from `requestAnimationFrame` and stops dead when the main
 * thread stops. Honest. The reassurance the author actually wants comes from the
 * signals a spinner cannot give: real counters advancing, elapsed time climbing,
 * and — once a stall ends — an explicit "that step took 2.3s". During a freeze the
 * browser cannot paint anything anyway; the only real choice is whether to have
 * lied about it beforehand.
 *
 * ## Not yet: customisation
 *
 * Authors enjoy customising loading screens (author, 2026-07-16) and legacy has a
 * whole `ui/loading-screen/` family for it (hints, animations, alignment, config).
 * Explicitly out of scope for now — this is the reliable, honest core it would
 * hang off. The structure anticipates it (one state object, one render function)
 * without building it.
 *
 * @module ui/loading-screen
 */

import {
  LOAD_PHASES,
  createLoadState,
  beginPhase,
  reportProgress,
  completeLoad,
  failLoad,
  recordTick,
  describeLoad,
  shouldShowForScene,
} from './load-progress.js';

const OVERLAY_ID = 'msa-loading-screen';

/** The scene whose load was last STARTED — the floor-switch guard's memory. */
let lastStartedSceneId = null;
/** @type {ReturnType<typeof createLoadState>|null} */
let state = null;
let els = null;
let rafHandle = null;
/** Kept after the load ends so a report can say what the last load actually cost. */
let lastSummary = null;

/**
 * Mount into the same host the renderer uses, so the curtain covers exactly the
 * scene area. Mirrors `vt-pan-viewer.js#resolveMountHost` rather than importing it
 * — `ui/` should not depend on `vt/` just to find a div.
 */
function resolveHost() {
  const board = typeof document !== 'undefined' ? document.getElementById('board') : null;
  return board?.parentElement ?? document.body;
}

function buildOverlay() {
  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  Object.assign(root.style, {
    position: 'absolute',
    inset: '0',
    // Above the VT canvas (5), below Foundry's UI (60) — the GM keeps their
    // sidebar and can still navigate away from a scene that is loading badly.
    zIndex: '6',
    background: 'linear-gradient(180deg, #070b12 0%, #0d1420 100%)',
    color: '#cfe8ff',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '14px',
    font: '13px/1.5 Signika, sans-serif',
    userSelect: 'none',
    pointerEvents: 'auto', // swallow clicks aimed at a scene that isn't there yet
  });

  const title = document.createElement('div');
  Object.assign(title.style, { fontSize: '18px', fontWeight: '700', letterSpacing: '0.02em' });

  const scene = document.createElement('div');
  Object.assign(scene.style, { fontSize: '12px', opacity: '0.7', marginTop: '-8px' });

  // THE LIVENESS PULSE — rAF-driven, never CSS. See this module's header: a CSS
  // animation would keep running through a main-thread freeze and lie about it.
  const pulse = document.createElement('canvas');
  pulse.width = 220;
  pulse.height = 4;
  Object.assign(pulse.style, {
    width: '220px',
    height: '4px',
    borderRadius: '2px',
    background: 'rgba(143,214,255,0.12)',
  });

  // The real progress bar. Hidden entirely when the total is unknown, rather than
  // shown at a fabricated zero (§7's "0%/98%" lie starts with exactly that bar).
  const barOuter = document.createElement('div');
  Object.assign(barOuter.style, {
    width: '220px',
    height: '6px',
    borderRadius: '3px',
    background: 'rgba(143,214,255,0.15)',
    overflow: 'hidden',
  });
  const barInner = document.createElement('div');
  Object.assign(barInner.style, {
    width: '0%',
    height: '100%',
    background: '#8fd6ff',
    transition: 'width 120ms linear',
  });
  barOuter.appendChild(barInner);

  const detail = document.createElement('div');
  Object.assign(detail.style, { fontSize: '12px', opacity: '0.85', minHeight: '18px', textAlign: 'center' });

  const note = document.createElement('div');
  Object.assign(note.style, { fontSize: '11px', color: '#ffd9a0', minHeight: '16px', textAlign: 'center' });

  const elapsed = document.createElement('div');
  Object.assign(elapsed.style, { fontSize: '11px', opacity: '0.5' });

  root.append(title, scene, pulse, barOuter, detail, note, elapsed);
  resolveHost().appendChild(root);
  return { root, title, scene, pulse, pulseCtx: pulse.getContext('2d'), barOuter, barInner, detail, note, elapsed };
}

/** Draw the liveness pulse. Called ONLY from rAF — its stopping is the signal. */
function drawPulse(ctx, tMs) {
  const w = 220;
  const h = 4;
  ctx.clearRect(0, 0, w, h);
  // A travelling dash. Its POSITION is a pure function of real elapsed time, so a
  // stalled main thread leaves it visibly parked rather than smoothly lying.
  const period = 1400;
  const p = (tMs % period) / period;
  const dashW = 60;
  const x = -dashW + p * (w + dashW * 2);
  const grad = ctx.createLinearGradient(x, 0, x + dashW, 0);
  grad.addColorStop(0, 'rgba(143,214,255,0)');
  grad.addColorStop(0.5, 'rgba(143,214,255,0.95)');
  grad.addColorStop(1, 'rgba(143,214,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x, 0, dashW, h);
}

function paint(nowMs) {
  if (!state || !els) return;
  const d = describeLoad(state, nowMs);
  els.title.textContent = d.title;
  els.scene.textContent = state.sceneName ?? '';
  els.detail.textContent = d.detail ?? '';
  els.note.textContent = d.stallNote ?? '';
  els.elapsed.textContent = `${(d.elapsedMs / 1000).toFixed(1)}s`;
  // Hidden, not zeroed, when there is nothing honest to show.
  if (d.fraction === null) {
    els.barOuter.style.visibility = 'hidden';
  } else {
    els.barOuter.style.visibility = 'visible';
    els.barInner.style.width = `${(d.fraction * 100).toFixed(1)}%`;
  }
}

function tick(tMs) {
  if (!state || !els) return;
  recordTick(state, tMs);
  drawPulse(els.pulseCtx, tMs);
  paint(tMs);
  rafHandle = requestAnimationFrame(tick);
}

/**
 * Begin a scene load, showing the curtain — UNLESS this is the same scene, in which
 * case it is a floor switch or a redraw and must show nothing (§4.5).
 *
 * Safe to call from `canvasInit` for every draw; the guard is the point.
 *
 * @param {{sceneId:string|null, sceneName?:string}} args
 * @returns {{shown:boolean, reason:string}}
 */
export function beginSceneLoad({ sceneId, sceneName }) {
  const verdict = shouldShowForScene(lastStartedSceneId, sceneId);
  if (!verdict.show) return { shown: false, reason: verdict.reason };

  // Recorded at BEGIN, not at completion, deliberately: a load that fails or is
  // interrupted must still suppress the curtain for later floor switches within
  // that same scene. Keying off completion would make a failed load flash a
  // curtain on every subsequent floor change.
  lastStartedSceneId = sceneId;

  endSceneLoad({ silent: true }); // never stack two curtains
  state = createLoadState({ sceneId, sceneName: sceneName ?? '', nowMs: performance.now() });
  beginPhase(state, LOAD_PHASES.SCENE);
  els = buildOverlay();
  paint(performance.now());
  rafHandle = requestAnimationFrame(tick);
  return { shown: true, reason: verdict.reason };
}

/**
 * Progress within the current load. No-op if no load is showing, so callers never
 * need to know whether the curtain is up (a floor switch reports nothing).
 * @param {string} phaseId @param {{done?:number, total?:number|null, detail?:string|null}} opts
 */
export function reportSceneLoadProgress(phaseId, opts) {
  if (!state) return;
  reportProgress(state, phaseId, opts);
}

/** @param {string} phaseId @param {{total?:number|null}} [opts] */
export function beginSceneLoadPhase(phaseId, opts) {
  if (!state) return;
  beginPhase(state, phaseId, opts);
}

/**
 * The load finished. Lifts the curtain and returns a summary worth keeping.
 *
 * `worstStallMs` is reported rather than swallowed: a load that completes but froze
 * the main thread for two seconds is a bug with a receipt, not a success — and it
 * is exactly the class of thing the whole Keyhole crash campaign was about.
 *
 * @param {{error?:string|null, silent?:boolean}} [args]
 * @returns {object|null} the summary, or null if nothing was loading.
 */
export function endSceneLoad({ error = null, silent = false } = {}) {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  let summary = null;
  if (state) {
    const now = performance.now();
    if (error) failLoad(state, error, now);
    else completeLoad(state, now);
    summary = {
      sceneId: state.sceneId,
      sceneName: state.sceneName,
      totalMs: Math.round((state.finishedAtMs ?? now) - state.startedAtMs),
      worstStallMs: Math.round(state.worstStallMs),
      error: state.error,
    };
    if (!silent) lastSummary = summary;
  }
  state = null;
  try {
    document.getElementById(OVERLAY_ID)?.remove();
  } catch (_) {
    // The curtain must never be what breaks a load.
  }
  els = null;
  return summary;
}

/** For diagnostics: what the last real load cost, and whether one is up now. */
export function getLoadingScreenState() {
  return {
    showing: !!state,
    lastStartedSceneId,
    current: state ? describeLoad(state, performance.now()) : null,
    lastLoad: lastSummary,
  };
}

/**
 * TEST SEAM: forget which scene was last loaded, so the next `beginSceneLoad` is
 * treated as a cold load. Exists for the debug panel's own "show me the curtain"
 * button — without it there is no way to see the loading screen again without
 * switching scenes back and forth, since the guard correctly suppresses it.
 */
export function resetLoadingSceneMemory() {
  lastStartedSceneId = null;
  return { reset: true };
}
