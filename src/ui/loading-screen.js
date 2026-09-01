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
  hardRevealDue,
  shouldShowForScene,
} from './load-progress.js';
import { perfNowMs } from '../core/frame-clock.js';

const OVERLAY_ID = 'msa-loading-screen';

/**
 * How long a load must have been running before the "Show me anyway" button
 * appears.
 *
 * Not zero, because a button that flashes for 200ms on a warm load is noise
 * that trains people to ignore it. Not the hard deadline either, because by
 * then the curtain lifts on its own and the button would have nothing left to
 * offer. Five seconds is roughly "this is taking longer than usual" — the point
 * at which offering an escape is a kindness rather than a distraction.
 */
export const SHOW_SKIP_AFTER_MS = 5000;

/** How many blockers to list before summarising the rest. A wall of text is as
 * unreadable as "still loading"; the first few name the stage, which is the job. */
const MAX_BLOCKERS_SHOWN = 4;

/**
 * THIS FILE'S ONE CLOCK READ.
 *
 * `time/one-clock` fired here when phase timings were added (2026-07-17), and
 * the honest answer was not to bump the ratchet. This module is the BOUNDARY
 * between the browser (which has a clock) and `load-progress.js` (which is pure
 * by law and must be HANDED the time), so it genuinely needs wall-clock access —
 * but it was sampling it from six separate places, which is the file-scale
 * version of the exact thing the rule exists to stop.
 *
 * Six sample sites became one. That is not full compliance and this comment will
 * not pretend it is: a private clock is still a private clock, and the real fix
 * is for a load to be timed by the frame snapshot once one exists to hand out.
 * What it does buy is that every timestamp in a load now comes from one line, so
 * no two readings here can disagree about when "now" is.
 *
 * @returns {number}
 */
const now = perfNowMs;

/** The scene whose load was last STARTED — the floor-switch guard's memory. */
let lastStartedSceneId = null;
/** Set by the "Show me anyway" button. Cleared when a new load begins. */
let forcedRevealRequested = false;
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
    // Above the VT canvas (5) AND above every one of MSA's own floating
    // rooms (2026-08-27 fix, author: "this UI should appear below the
    // loading screen... currently... this appears above it"). Those rooms
    // (Remote/Studio/Player, z-index 100; their own popovers, 400) did not
    // exist when this was set to 6 — nothing here was ever weighed against
    // them, and z-index 100 simply outranks 6. This still sits below
    // Foundry's OWN UI (60)... except it no longer can, now that it must
    // also clear 400: raised to 500, comfortably past MSA's own chrome.
    // Foundry's sidebar is unaffected regardless of this number — it lives
    // outside this overlay's own host (resolveHost(), above) entirely, so a
    // higher z-index here changes stacking order only against things that
    // occupy the SAME screen region (the scene area), never Foundry's own
    // UI docked elsewhere on screen.
    //
    // 2026-08-31 fix, author: "the paused UI layer appears above the
    // loading screen, move the loading screen up so nothing can go in
    // front of it." Foundry's own `#pause` banner (game-pause.mjs, id:
    // "pause", frame:false/positioned:false so it never gets bumped by
    // ApplicationV2's z-index-on-focus logic) is declared at
    // `calc(var(--z-index-canvas) + 1)` = 1 in Foundry v14's own
    // interface.less, and — like `#board` — sits at the SAME body-level
    // DOM depth as this overlay's host, so 500 already outranks it on
    // paper. The author saw it win anyway, which means something about the
    // live stacking (a theme override, a game-system stylesheet, a
    // difference from the vendored source this was checked against) traps
    // it differently than this analysis predicts. Rather than keep
    // reasoning about a stacking context this codebase cannot fully see,
    // this jumps past Foundry's own highest reserved level —
    // `--z-index-notification: 99999`, the ceiling of Foundry's ENTIRE
    // z-index scale (tooltips, windows, the pause banner, everything) —
    // so the curtain wins regardless of which of those explanations is
    // right.
    zIndex: '100000',
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

  // WHAT IT IS ACTUALLY WAITING FOR — `vt/settle.js`'s named blockers, one per
  // line. This is the difference between a load that hangs for twenty minutes
  // being a mystery and being a one-line diagnosis ("textures still being
  // GPU-compressed (3)"), which is the entire reason settle.js names its
  // blockers instead of counting them.
  const blockers = document.createElement('div');
  Object.assign(blockers.style, {
    fontSize: '11px',
    opacity: '0.62',
    textAlign: 'center',
    lineHeight: '1.6',
    maxWidth: '380px',
    minHeight: '16px',
  });

  const elapsed = document.createElement('div');
  Object.assign(elapsed.style, { fontSize: '11px', opacity: '0.5' });

  // THE ESCAPE HATCH. A curtain gated on real readiness can be held up by a
  // dead worker or a 404'd mask, and the person behind it has no map, no way to
  // change scene and no recourse. `HARD_REVEAL_MS` lifts it eventually; this is
  // for the case where "eventually" is already too long. Pressing it does not
  // claim the load finished — the summary records a forced reveal and the
  // blockers keep naming themselves afterwards.
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.textContent = 'Show me anyway';
  Object.assign(skip.style, {
    display: 'none',
    marginTop: '2px',
    padding: '5px 12px',
    font: '12px/1.2 Signika, sans-serif',
    color: '#cfe8ff',
    background: 'rgba(143,214,255,0.10)',
    border: '1px solid rgba(143,214,255,0.35)',
    borderRadius: '4px',
    cursor: 'pointer',
  });
  skip.addEventListener('click', () => {
    forcedRevealRequested = true;
    // Disabled, not hidden: a button that vanishes on click leaves the user
    // unsure whether it registered, and the reveal itself is not instant — the
    // wait loop notices on its next poll.
    skip.disabled = true;
    skip.textContent = 'Showing…';
    skip.style.cursor = 'default';
  });

  root.append(title, scene, pulse, barOuter, detail, note, blockers, elapsed, skip);
  resolveHost().appendChild(root);
  return {
    root,
    title,
    scene,
    pulse,
    pulseCtx: pulse.getContext('2d'),
    barOuter,
    barInner,
    detail,
    note,
    blockers,
    elapsed,
    skip,
  };
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

/**
 * Render the blocker list. Capped, and the cap SAYS so rather than silently
 * truncating — the same rule every ring in `diag/` follows, and for the same
 * reason: a list that quietly drops entries reads as a complete list.
 * @param {string[]} list @returns {string}
 */
export function formatBlockerLines(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  if (list.length <= MAX_BLOCKERS_SHOWN) return list.join('\n');
  const shown = list.slice(0, MAX_BLOCKERS_SHOWN);
  const rest = list.length - MAX_BLOCKERS_SHOWN;
  return `${shown.join('\n')}\n…and ${rest} more`;
}

function paint(nowMs) {
  if (!state || !els) return;
  const d = describeLoad(state, nowMs);
  els.title.textContent = d.title;
  els.scene.textContent = state.sceneName ?? '';
  els.detail.textContent = d.detail ?? '';
  els.note.textContent = d.stallNote ?? '';
  els.blockers.style.whiteSpace = 'pre-line';
  els.blockers.textContent = formatBlockerLines(d.blockers);
  els.elapsed.textContent = `${(d.elapsedMs / 1000).toFixed(1)}s`;
  // Appears only once the load is genuinely slow — see SHOW_SKIP_AFTER_MS.
  if (!d.complete && !d.error && d.elapsedMs >= SHOW_SKIP_AFTER_MS) els.skip.style.display = 'block';
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
  forcedRevealRequested = false; // a new load gets a new decision

  endSceneLoad({ silent: true }); // never stack two curtains
  // ONE clock reading for the load's start AND its first phase: sampling twice
  // would make the SCENE phase appear to start a fraction of a millisecond after
  // the load it opens, which is a small lie but a lie with a receipt in the export.
  const startNow = now();
  state = createLoadState({ sceneId, sceneName: sceneName ?? '', nowMs: startNow });
  beginPhase(state, LOAD_PHASES.SCENE, { nowMs: startNow });
  els = buildOverlay();
  paint(now());
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
  // The clock is supplied HERE rather than by callers: this is the boundary
  // between the browser (which has a clock) and the pure model (which is
  // forbidden one). A caller that had to remember `nowMs` would eventually
  // forget, and the phase it forgot would be the one with no duration.
  reportProgress(state, phaseId, { ...opts, nowMs: now() });
}

/** @param {string} phaseId @param {{total?:number|null}} [opts] */
export function beginSceneLoadPhase(phaseId, opts) {
  if (!state) return;
  beginPhase(state, phaseId, { ...opts, nowMs: now() });
}

/**
 * MAY THE CALLER STOP WAITING FOR READINESS?
 *
 * The curtain owns this decision rather than the boot sequence, because the
 * curtain owns the two things it depends on: the load's own clock (for the
 * deadline) and the "Show me anyway" button. Boot polls this; it does not need
 * to know that either exists.
 *
 * Returns true when there is NO curtain at all — a floor switch or a redraw,
 * where `beginSceneLoad` declined. That is deliberate and load-bearing: a
 * caller with no curtain up must never be made to block on readiness by this
 * function, because there would be nothing on screen explaining the wait and no
 * button to escape it. Floor changes get their own hold, with their own UI and
 * their own cancel ([[ui/floor-transition]]).
 *
 * @returns {{stop: boolean, reason: string}}
 */
export function shouldStopWaitingForReady() {
  if (!state) return { stop: true, reason: 'no curtain is up — nothing is being hidden by waiting' };
  if (forcedRevealRequested) return { stop: true, reason: 'the author asked to see it anyway' };
  if (hardRevealDue(state, now())) return { stop: true, reason: 'the reveal deadline elapsed' };
  return { stop: false, reason: 'still waiting for the scene to be ready' };
}

/**
 * Publish what readiness is currently waiting for, so the curtain can name it.
 * A no-op with no curtain up, like every other reporter here.
 * @param {string[]} blockers @param {string|null} [detail]
 * @param {ReadonlyArray<{key:string,label:string,count:number}>|null} [structuredBlockers] -
 *   the SAME blockers as `vt/settle.js`'s own stable-keyed shape, so
 *   `load-progress.js` can bill outstanding time per named cause instead of
 *   per formatted (and count-fluctuating) string. Optional so a caller that
 *   only has the display strings still works.
 */
export function reportSceneLoadBlockers(blockers, detail = null, structuredBlockers = null) {
  if (!state) return;
  reportProgress(state, LOAD_PHASES.WARMING, { blockers, detail, structuredBlockers, nowMs: now() });
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
export function endSceneLoad({ error = null, silent = false, forced = false } = {}) {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  let summary = null;
  if (state) {
    // `endedAt`, not `now` — a local named `now` would shadow this module's one
    // clock helper, and the next person to add a timestamp in here would get a
    // number frozen at whenever the load ended without anything saying so.
    const endedAt = now();
    if (error) failLoad(state, error, endedAt);
    else completeLoad(state, endedAt, { forced });
    summary = {
      sceneId: state.sceneId,
      sceneName: state.sceneName,
      totalMs: Math.round((state.finishedAtMs ?? endedAt) - state.startedAtMs),
      worstStallMs: Math.round(state.worstStallMs),
      // A FORCED REVEAL IS NOT A FINISHED LOAD, and the summary is the thing
      // that ends up in the flight recorder and the perf report — so it says so,
      // and it keeps the list of what was still running. Reading `totalMs`
      // without this would give a load that "took 30.0s" when what actually
      // happened is that we stopped waiting at 30s.
      forcedReveal: !!state.forcedReveal,
      unfinished: state.forcedReveal ? [...state.blockers] : [],
      // THE LOAD STORY, per phase — "reading the scene took 12ms, streaming art
      // took 2.4s, the first frame took 180ms" instead of one undifferentiated
      // total. Rides into the flight recorder's export for free: this summary is
      // already returned by getLoadingScreenState(), which is already a
      // registered read-only report.
      phases: state.phases.map((p) => ({ ...p })),
      // WARMING'S OWN BREAKDOWN (mythica-machina-press#400) — which named cause
      // (streaming, GPU compression, shader/pipeline compile, ...) ate how much
      // of the warm-up hold, straight off `load-progress.js`'s accumulator.
      // Cloned for the same reason `phases` is: nothing downstream should be
      // able to mutate the summary after the fact.
      blockerDurationsMs: cloneBlockerDurations(state.blockerDurationsMs),
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

/**
 * Defensive clone of the blocker-time accumulator — two levels of plain
 * objects, so a shallow spread per level is enough; no need for a generic deep
 * clone over a shape this small and fixed.
 * @param {Record<string, Record<string, {label:string, ms:number}>>} src
 */
function cloneBlockerDurations(src) {
  const out = {};
  for (const phaseId of Object.keys(src || {})) {
    out[phaseId] = {};
    for (const key of Object.keys(src[phaseId])) out[phaseId][key] = { ...src[phaseId][key] };
  }
  return out;
}

/** For diagnostics: what the last real load cost, and whether one is up now. */
export function getLoadingScreenState() {
  return {
    showing: !!state,
    lastStartedSceneId,
    current: state ? describeLoad(state, now()) : null,
    // Phases of the IN-FLIGHT load, if any. Without this, exporting while a load
    // is stuck — which is exactly when someone reaches for the export button —
    // would show the previous load's timings and nothing about the one that is
    // actually hanging. The still-open phase names itself by `endMs: null`.
    currentPhases: state ? state.phases.map((p) => ({ ...p })) : null,
    // LIVE blocker-time accumulation (mythica-machina-press#400), for the exact
    // moment someone reaches for this mid-freeze — same reasoning as
    // `currentPhases`: the WARMING breakdown is most useful WHILE stuck, not
    // only after the fact.
    currentBlockerDurationsMs: state ? cloneBlockerDurations(state.blockerDurationsMs) : null,
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
