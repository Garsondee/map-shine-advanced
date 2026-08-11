/**
 * ui/perf-progress-overlay.js — a small, non-blocking on-screen readout for a
 * running performance session (Testament Stage 4 follow-up, 2026-08-11: "even
 * without a UI it would be nice to have text on screen").
 *
 * `perf-session.js`'s `hideLiveUi()` takes the whole debug panel away for the
 * length of a measurement window ("hide itself and cost nothing during
 * tests") — which then leaves NOTHING on screen for a run that can last
 * several minutes, with no way to tell 5 seconds in from 45. This is
 * deliberately NOT `ui/loading-screen.js`: that is a full opaque curtain
 * meant to BLOCK the view of a scene that is not ready yet, `pointerEvents:
 * 'auto'` on purpose so it can swallow clicks. A perf run needs the OPPOSITE
 * — the benchmark camera path has to stay visible, that IS the workload being
 * measured — so this is just a few words in a corner, `pointerEvents:'none'`,
 * that never competes with the thing being measured or blocks a click.
 *
 * @module ui/perf-progress-overlay
 */

const OVERLAY_ID = 'msa-perf-progress-overlay';

/** Friendly labels for perf-session.js's own phase names. An unrecognised
 * phase (future-proofing, not just today's list) falls back to itself. */
const PHASE_LABELS = Object.freeze({
  settling: 'Profiling: settling',
  arming: 'Profiling: arming',
  measuring: 'Profiling: measuring',
  'measuring-tick': 'Profiling: measuring',
  sweeping: 'Profiling: sweeping',
  building: 'Profiling: building report',
  warning: 'Profiling: warning',
});

/**
 * Pure text formatting, split out from the DOM so it is testable under plain
 * Node — same split `astrolabe.js` uses for its own dial maths.
 * @param {string} phase
 * @param {string|null} [detail]
 * @returns {string}
 */
export function formatPerfProgressText(phase, detail) {
  const label = PHASE_LABELS[phase] ?? phase;
  return detail ? `${label} — ${detail}` : label;
}

let el = null;
let lastText = null;

/**
 * Mount into the same host `ui/loading-screen.js` uses, so this sits over
 * exactly the scene area rather than the whole page. Copied rather than
 * imported: `ui/` modules deliberately do not reach into each other's
 * internals just to find a div (loading-screen.js's own `resolveHost` makes
 * the same call against `vt/`).
 */
function resolveHost() {
  const board = typeof document !== 'undefined' ? document.getElementById('board') : null;
  return board?.parentElement ?? document.body;
}

/**
 * Create (if needed) and show the overlay with the given text. Safe to call
 * repeatedly — it lazily creates once, then delegates to the same
 * dirty-checked update every other call. A no-op outside a browser (no
 * `document`), matching every other `diag`/`ui` module's console-safety
 * posture rather than throwing on import in a Node test.
 * @param {string} text
 */
export function showPerfProgress(text) {
  if (typeof document === 'undefined') return;
  if (!el) {
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    Object.assign(el.style, {
      position: 'absolute',
      left: '8px',
      bottom: '8px',
      // Above the VT canvas (5, see loading-screen.js), below Foundry's own
      // UI (60) — same reasoning as the curtain, minus the click-swallowing.
      zIndex: '7',
      padding: '4px 8px',
      background: 'rgba(7, 11, 18, 0.72)',
      color: '#cfe8ff',
      font: '11px/1.4 monospace',
      borderRadius: '3px',
      pointerEvents: 'none',
      userSelect: 'none',
      whiteSpace: 'pre',
    });
    resolveHost().appendChild(el);
    lastText = null;
  }
  updatePerfProgress(text);
}

/**
 * Update the overlay's text. A no-op before `showPerfProgress()` or after
 * `hidePerfProgress()`. Dirty-checked — same discipline as the astrolabe's
 * own sync guard — so a caller ticking once a second never writes the DOM
 * when the text hasn't actually changed.
 * @param {string} text
 */
export function updatePerfProgress(text) {
  if (!el || text === lastText) return;
  lastText = text;
  el.textContent = text;
}

/** Remove the overlay entirely. Safe to call even if it was never shown. */
export function hidePerfProgress() {
  if (el?.parentElement) el.parentElement.removeChild(el);
  el = null;
  lastText = null;
}

/** For tests: is the overlay currently mounted? */
export function isPerfProgressVisible() {
  return el !== null;
}
