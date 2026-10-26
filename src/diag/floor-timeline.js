/**
 * @fileoverview diag/floor-timeline.js — the ordered story of ONE level or scene change
 * (loading audit, Phase 0, 2026-10-25).
 *
 * ============================================================================
 * WHY A TIMELINE, WHEN THERE IS A FLIGHT RECORDER
 * ============================================================================
 * The flight recorder keeps every log line, so the facts are in there — interleaved with
 * several thousand others. The first question every floor-change complaint needs answered is
 * "where did the time go, and in what order": the gate preparing, Foundry's own tear-down,
 * Foundry's draw, MSA's re-sync, or the commit? It also answers the audit's open question —
 * was a long grey screen Foundry's snapshot, or a full viewer restart — by whether
 * `canvas-ready` was followed by `commit` or by `viewer-started`.
 *
 * So this keeps one small record per change: its events in order, each with its time since
 * the change began and since the previous event, plus a summary of the stretches people care
 * about. It is registered as a debug report, so it rides into the flight-recorder bundle with
 * no further wiring (the bundle runs every registered report).
 *
 * ============================================================================
 * WHAT COUNTS AS ONE CHANGE
 * ============================================================================
 * A change begins at `request` (the gate saw a `Scene#view`) — or, for a redraw nobody gated
 * (the gate is off, or the change came from somewhere the gate does not see), at the first
 * event that arrives with no change open. It ends at `first-frame` (the first frame drawn
 * after the commit or the cold start), at `cancelled` or `superseded`, or when the next change
 * begins; whatever ended it is its `outcome`. A second tear-down starts a new change, so an
 * old record can never absorb an unrelated redraw.
 *
 * Pure: the clock is injected. Node-tested.
 *
 * @module diag/floor-timeline
 */
import { perfNowMs } from '../core/frame-clock.js';

/** The events, in the order a gated level change produces them. Other names are accepted too. */
export const TIMELINE_EVENTS = Object.freeze({
  /** The gate saw a `Scene#view` that will redraw. */
  REQUEST: 'request',
  /** The gate began preparing in the background (the old view is still live). */
  PREPARE_START: 'prepare-start',
  /** Preparing finished (`detail.outcome` says how). */
  PREPARE_END: 'prepare-end',
  /** The gate handed over to Foundry's real `Scene#view`. */
  VIEW_CALLED: 'view-called',
  /** Foundry's `canvasTearDown`. */
  TEAR_DOWN: 'tear-down',
  /** Foundry's `canvasInit`. */
  CANVAS_INIT: 'canvas-init',
  /** Foundry's `canvasReady`. */
  CANVAS_READY: 'canvas-ready',
  /** A cold or scene change: the viewer was (re)started. */
  VIEWER_STARTED: 'viewer-started',
  /** The floor was committed (the viewer's floor index flipped). */
  COMMIT: 'commit',
  /** The first frame drawn after the commit (or after a cold start). Ends the change. */
  FIRST_FRAME: 'first-frame',
  /** The user cancelled. Ends the change. */
  CANCELLED: 'cancelled',
  /** A newer request replaced this one before it drew. Ends the change. */
  SUPERSEDED: 'superseded',
  /** The gate could not prepare and let Foundry draw anyway. */
  FAILED_OPEN: 'failed-open',
});

const E = TIMELINE_EVENTS;
const ENDING = new Set([E.FIRST_FRAME, E.CANCELLED, E.SUPERSEDED]);

/** How many finished changes the report keeps. */
export const MAX_CHANGES = 12;
/** A change that somehow never ends cannot grow without bound. */
export const MAX_EVENTS_PER_CHANGE = 80;

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * The stretches worth naming, from a change's events. A stretch is `null` when either end is
 * missing, never zero — "did not happen" and "took no time" are different statements.
 * @param {Array<{event: string, tMs: number}>} events
 */
export function summariseChange(events) {
  const at = (name) => events.find((e) => e.event === name)?.tMs ?? null;
  const span = (a, b) => (a === null || b === null ? null : round1(b - a));
  const first = events.length ? events[0].tMs : null;
  const last = events.length ? events[events.length - 1].tMs : null;
  const firstFrame = at(E.FIRST_FRAME);
  const started = at(E.VIEWER_STARTED);
  return {
    /** How long the OLD view stayed live while the gate prepared. */
    preparedMs: span(at(E.PREPARE_START), at(E.PREPARE_END)),
    /** Foundry's own tear-down → init gap (the stretch the old blank-canvas watchdog guessed about). */
    tearDownToInitMs: span(at(E.TEAR_DOWN), at(E.CANVAS_INIT)),
    /** Foundry's draw: canvasInit → canvasReady. */
    foundryDrawMs: span(at(E.CANVAS_INIT), at(E.CANVAS_READY)),
    /** canvasReady → the viewer's commit (a floor change). */
    readyToCommitMs: span(at(E.CANVAS_READY), at(E.COMMIT)),
    /** canvasReady → the viewer's restart (a scene change or cold load). */
    readyToViewerStartedMs: span(at(E.CANVAS_READY), started),
    /** Commit → the first frame that showed it. */
    commitToFirstFrameMs: span(at(E.COMMIT), firstFrame),
    /** The whole change, first event → the end. */
    totalMs: span(first, firstFrame ?? last),
    /** Did the viewer restart (the expensive path) instead of re-syncing the floor? */
    viewerRestarted: started !== null,
    gatePrepared: at(E.PREPARE_START) !== null,
    failedOpen: events.some((e) => e.event === E.FAILED_OPEN),
  };
}

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {{info?: Function}|null} [opts.log] gets one line per finished change
 * @returns {{
 *   mark: (event: string, detail?: object) => void,
 *   getReport: () => object,
 *   getLastChange: () => object|null,
 * }}
 */
export function createFloorTimeline({ now = perfNowMs, log = null } = {}) {
  /** @type {null|{n: number, startedAtMs: number, events: Array<{event: string, tMs: number, detail: object|null}>, dropped: number, implicit: boolean, kind: string|null, sceneId: string|null, levelId: string|null}} */
  let current = null;
  /** @type {Array<object>} */
  const finished = [];
  let counter = 0;
  let totalEvents = 0;

  function exportChange(c, outcome) {
    let prev = 0;
    return {
      n: c.n,
      kind: c.kind,
      sceneId: c.sceneId,
      levelId: c.levelId,
      implicit: c.implicit,
      outcome,
      eventsDropped: c.dropped,
      events: c.events.map((e) => {
        const row = { event: e.event, tMs: round1(e.tMs), sincePreviousMs: round1(e.tMs - prev), ...(e.detail ?? {}) };
        prev = e.tMs;
        return row;
      }),
      summary: summariseChange(c.events),
    };
  }

  function begin(implicit, detail) {
    counter++;
    current = {
      n: counter,
      startedAtMs: now(),
      events: [],
      dropped: 0,
      implicit,
      kind: detail?.kind ?? null,
      sceneId: detail?.sceneId ?? null,
      levelId: detail?.levelId ?? null,
    };
  }

  function close(outcome) {
    if (!current) return;
    const record = exportChange(current, outcome);
    finished.push(record);
    if (finished.length > MAX_CHANGES) finished.shift();
    const s = record.summary;
    log?.info?.(
      `level/scene change #${record.n} ${outcome}: ${s.totalMs ?? '?'} ms` +
        (s.preparedMs !== null ? ` (${s.preparedMs} ms prepared first)` : '') +
        (s.viewerRestarted ? ', viewer restarted' : '')
    );
    current = null;
  }

  return {
    mark(event, detail) {
      if (typeof event !== 'string' || !event) return;
      totalEvents++;
      if (event === E.REQUEST) {
        // A new request replaces whatever was open: that change never reached the screen.
        if (current) close('replaced');
        begin(false, detail);
      } else if (!current) {
        begin(true, detail);
      } else if (event === E.TEAR_DOWN && current.events.some((e) => e.event === E.TEAR_DOWN)) {
        // A second tear-down belongs to a different redraw, not to this change.
        close('abandoned');
        begin(true, detail);
      }
      const t = now() - current.startedAtMs;
      if (current.events.length >= MAX_EVENTS_PER_CHANGE) current.dropped++;
      else current.events.push({ event, tMs: t, detail: detail ?? null });
      if (ENDING.has(event)) close(event === E.FIRST_FRAME ? 'presented' : event);
    },

    getLastChange() {
      if (current) return exportChange(current, null);
      return finished.length ? finished[finished.length - 1] : null;
    },

    getReport() {
      return {
        changesSeen: counter,
        eventsSeen: totalEvents,
        open: current ? exportChange(current, null) : null,
        // Most recent first: the one you just did is the one you want.
        finished: [...finished].reverse(),
        note:
          'tMs is since the change began. preparedMs = how long the old view stayed live while the gate prepared; ' +
          'viewerRestarted:true on a LEVEL change means the expensive restart path ran instead of a floor re-sync ' +
          '(the long grey screen, audit P-02). A null stretch means one end of it never happened.',
      };
    },
  };
}
