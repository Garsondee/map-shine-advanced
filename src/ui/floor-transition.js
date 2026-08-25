/**
 * ui/floor-transition.js — the slim, non-blocking affordance for a floor
 * switch that is taking a moment.
 *
 * ============================================================================
 * WHY THIS IS NOT ui/loading-screen.js
 * ============================================================================
 * The author's own words set this design: *"Ideally we don't want a full
 * loading screen between floors... run a background worker with the job of
 * getting everything ready in the background and only starting a transition
 * once it's safe to actually swap floors. If we give the user a loading bar
 * to let them know that the floor change was started then users won't be
 * confused when floor changes aren't instant."*
 *
 * That is three requirements this file exists to satisfy, and none of them is
 * "block the view": (1) never a curtain, (2) the OLD floor stays fully
 * visible and interactive while the new one prepares, (3) a small, honest
 * signal that the request was received — not a promise of when it will finish,
 * because there is no deadline (`vt-pan-viewer.js#prepareFloor`'s own header:
 * a floor switch holds the old floor for as long as it genuinely takes; the
 * cold-load curtain's `HARD_REVEAL_MS` escape hatch does not apply here).
 *
 * Modelled on `ui/perf-progress-overlay.js` — same host, same `pointerEvents:
 * 'none'` on the container (a floor switch must never swallow a click meant
 * for the still-live old floor), same corner placement, same scale (a few
 * words, not a scene). The one deliberate escalation: a Cancel control, because
 * without a deadline this bar is the ONLY way out of a prepare that is
 * genuinely stuck (`feedback_safety_slide_outranks_doctrine` — a mechanism
 * with no escape hatch is a mechanism the author can get trapped inside).
 *
 * ============================================================================
 * WHY IT IS GATED ON ELAPSED TIME, NOT ON PROGRESS
 * ============================================================================
 * A warm switch (everything already resident from prewarm) resolves in one
 * synchronous pass with nothing to report — showing a bar for that case would
 * be UI noise on the common path, flickering on every ordinary floor tap. So
 * `beginFloorTransition` arms a plain timer for `SHOW_AFTER_MS` and only
 * builds the DOM if it fires; `endFloorTransition` (called unconditionally by
 * the caller once prepare resolves, however it resolves) clears the timer if
 * it hasn't fired yet. This is gated on TIME SINCE THE REQUEST STARTED, not on
 * "no progress yet" — a prepare that is genuinely making slow progress must
 * still surface the bar once it has run long enough to look like nothing is
 * happening, which is exactly the case a progress-based gate would miss.
 *
 * @module ui/floor-transition
 */

import { perfNowMs } from '../core/frame-clock.js';

const OVERLAY_ID = 'msa-floor-transition';

/** How long a prepare must run before the bar appears. Below this, a floor
 * switch reads as instant and any UI would be pure flicker — see this
 * module's header for why this gates on elapsed time, not on progress. */
export const SHOW_AFTER_MS = 250;

/** How many blockers to list before summarising the rest — same discipline
 * `ui/loading-screen.js#formatBlockerLines` uses, and for the same reason: a
 * capped list that SAYS it is capped beats one that silently truncates. */
const MAX_BLOCKERS_SHOWN = 3;

/**
 * The headline. Pure, so it is testable under plain Node without a DOM — same
 * split `perf-progress-overlay.js#formatPerfProgressText` uses.
 *
 * `fromFloorIndex`/`toFloorIndex` are plain numbers, not floor names: this
 * file has no access to a scene's authored floor labels (that lives in
 * boot.js, several layers up), and "Going up" / "Going down" already answers
 * the only question a GM actually has mid-switch — which way, and is it
 * working — without this module needing a new dependency just to look up a
 * name.
 *
 * @param {number|null} fromFloorIndex @param {number|null} toFloorIndex
 * @returns {string}
 */
export function formatFloorTransitionHeadline(fromFloorIndex, toFloorIndex) {
  if (!Number.isFinite(fromFloorIndex) || !Number.isFinite(toFloorIndex) || fromFloorIndex === toFloorIndex) {
    return 'Switching floors';
  }
  return toFloorIndex > fromFloorIndex ? 'Going up' : 'Going down';
}

/**
 * Cap and join the blocker list, same rule as the loading screen's own
 * formatter: `feedback_absent_zone_row_is_a_measurement`'s sibling for
 * DISPLAY — a truncated list must say so, never just stop.
 * @param {string[]} list @returns {string}
 */
export function formatFloorTransitionBlockers(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  if (list.length <= MAX_BLOCKERS_SHOWN) return list.join(' · ');
  const shown = list.slice(0, MAX_BLOCKERS_SHOWN);
  return `${shown.join(' · ')} · +${list.length - MAX_BLOCKERS_SHOWN} more`;
}

let el = null;
let showTimer = null;
let startedAtMs = null;
let onCancel = null;
let lastBlockersText = '';

/** Mount into the same host `ui/loading-screen.js`/`perf-progress-overlay.js`
 * both use — the scene area, not the whole page. Copied, not imported, for
 * the same reason those two give: `ui/` modules do not reach into each
 * other's internals just to find a div. */
function resolveHost() {
  const board = typeof document !== 'undefined' ? document.getElementById('board') : null;
  return board?.parentElement ?? document.body;
}

function buildOverlay(headline) {
  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  Object.assign(root.style, {
    position: 'absolute',
    right: '8px',
    bottom: '8px',
    // Same layer as perf-progress-overlay.js (7: above the VT canvas at 5,
    // below Foundry's own UI at 60) — this is informational chrome over a
    // scene that is otherwise fully live, never a barrier in front of it.
    zIndex: '7',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '4px',
    padding: '6px 10px',
    background: 'rgba(7, 11, 18, 0.72)',
    color: '#cfe8ff',
    font: '11px/1.4 Signika, sans-serif',
    borderRadius: '4px',
    // The CONTAINER never swallows a click meant for the still-live old
    // floor underneath it — only the Cancel button (below) opts back in.
    pointerEvents: 'none',
    userSelect: 'none',
    maxWidth: '280px',
  });

  const head = document.createElement('div');
  Object.assign(head.style, { fontWeight: '700', fontSize: '12px' });
  head.textContent = headline;

  const detail = document.createElement('div');
  Object.assign(detail.style, { opacity: '0.78', textAlign: 'right' });

  const bar = document.createElement('div');
  Object.assign(bar.style, {
    width: '160px',
    height: '3px',
    borderRadius: '2px',
    background: 'rgba(143,214,255,0.15)',
    overflow: 'hidden',
  });
  const pulse = document.createElement('div');
  // NO fabricated fraction — the same honesty rule ui/load-progress.js
  // enforces for the cold-load bar. Prepare's own item/compress counters are
  // real but not a meaningful single percentage (dimensions-fetch and
  // BC-compression are wildly different costs per item), so this is a
  // travelling indeterminate pulse, not a lying number.
  Object.assign(pulse.style, {
    width: '35%',
    height: '100%',
    background: '#8fd6ff',
    borderRadius: '2px',
    animation: 'msa-floor-transition-pulse 1.1s ease-in-out infinite',
  });
  bar.appendChild(pulse);

  if (!document.getElementById('msa-floor-transition-style')) {
    const style = document.createElement('style');
    style.id = 'msa-floor-transition-style';
    style.textContent =
      '@keyframes msa-floor-transition-pulse{0%{transform:translateX(-100%)}100%{transform:translateX(390%)}}';
    document.head.appendChild(style);
  }

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  Object.assign(cancel.style, {
    // Opts BACK IN to pointer events — this is the one control on the whole
    // overlay a click must reach. See this file's header on why a switch
    // with no deadline needs a real way out.
    pointerEvents: 'auto',
    marginTop: '2px',
    padding: '3px 10px',
    font: '11px/1.2 Signika, sans-serif',
    color: '#cfe8ff',
    background: 'rgba(143,214,255,0.10)',
    border: '1px solid rgba(143,214,255,0.35)',
    borderRadius: '3px',
    cursor: 'pointer',
  });
  cancel.addEventListener('click', () => {
    // Disabled, not removed — endFloorTransition() (called once the caller's
    // own cancellation actually lands) is what takes the overlay away. A
    // click that visibly did nothing reads as broken; one that visibly
    // disables itself reads as received.
    cancel.disabled = true;
    cancel.textContent = 'Cancelling…';
    cancel.style.cursor = 'default';
    onCancel?.();
  });

  root.append(head, detail, bar, cancel);
  resolveHost().appendChild(root);
  return { root, head, detail, cancel };
}

/**
 * Arm a floor-transition prepare. Shows NOTHING yet — see this module's
 * header for why the reveal is gated on elapsed time. Safe to call even if a
 * PREVIOUS transition's overlay is still up (a rapid second floor-switch
 * request): it is torn down first, so there is never more than one on screen.
 *
 * @param {{fromFloorIndex?:number|null, toFloorIndex?:number|null, onCancel?:Function}} args
 */
export function beginFloorTransition({ fromFloorIndex = null, toFloorIndex = null, onCancel: cancelFn } = {}) {
  endFloorTransition(); // never stack two overlays, same discipline loading-screen.js's beginSceneLoad uses
  startedAtMs = perfNowMs();
  onCancel = typeof cancelFn === 'function' ? cancelFn : null;
  lastBlockersText = '';
  const headline = formatFloorTransitionHeadline(fromFloorIndex, toFloorIndex);
  if (typeof document === 'undefined') return; // console-safe outside a browser, same posture as every ui/ module
  showTimer = setTimeout(() => {
    showTimer = null;
    el = buildOverlay(headline);
  }, SHOW_AFTER_MS);
}

/**
 * Report the current named blockers (`waitingFor`-shaped, straight from
 * `vt/settle.js` via whatever readiness read the caller is polling). A no-op
 * before `beginFloorTransition` or after the overlay has actually appeared is
 * fine either way — dirty-checked so a caller polling on an interval never
 * writes the DOM when nothing changed.
 * @param {string[]} blockers
 */
export function updateFloorTransitionProgress(blockers) {
  if (!el) return; // not shown yet (still within SHOW_AFTER_MS) or already ended
  const text = formatFloorTransitionBlockers(blockers);
  if (text === lastBlockersText) return;
  lastBlockersText = text;
  el.detail.textContent = text || 'preparing…';
}

/**
 * End the transition — success, failure, or cancellation all call this the
 * same way. Clears the not-yet-fired show timer (the common, fast-switch
 * case) and removes the DOM if it was built. Always safe to call, including
 * with nothing currently active.
 */
export function endFloorTransition() {
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (el?.root?.parentElement) el.root.parentElement.removeChild(el.root);
  el = null;
  startedAtMs = null;
  onCancel = null;
  lastBlockersText = '';
}

/** For diagnostics/tests: is the overlay actually mounted right now (i.e. has
 * SHOW_AFTER_MS already elapsed for the current transition)? */
export function isFloorTransitionVisible() {
  return el !== null;
}

/** For diagnostics: is a transition armed at all (shown or still within its
 * grace period)? */
export function isFloorTransitionActive() {
  return startedAtMs !== null;
}
