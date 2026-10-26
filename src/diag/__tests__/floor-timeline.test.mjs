/**
 * Node verification for diag/floor-timeline.js — the ordered story of one level/scene change.
 * Defended: events land on the right change, stretches are measured between the right events,
 * "did not happen" is null (never 0), and old records cannot absorb an unrelated redraw.
 */
import { createFloorTimeline, summariseChange, TIMELINE_EVENTS as E, MAX_CHANGES } from '../floor-timeline.js';

function fakeClock() {
  let t = 1000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

export async function run(t) {
  const { ok } = t;

  // --- a gated level change, start to finish --------------------------------
  {
    const c = fakeClock();
    const lines = [];
    const tl = createFloorTimeline({ now: c.now, log: { info: (m) => lines.push(m) } });
    tl.mark(E.REQUEST, { kind: 'level', sceneId: 'S', levelId: 'L2' });
    tl.mark(E.PREPARE_START);
    c.advance(400);
    tl.mark(E.PREPARE_END, { outcome: 'ok' });
    tl.mark(E.VIEW_CALLED);
    c.advance(5);
    tl.mark(E.TEAR_DOWN);
    c.advance(30);
    tl.mark(E.CANVAS_INIT);
    c.advance(200);
    tl.mark(E.CANVAS_READY);
    c.advance(10);
    tl.mark(E.COMMIT);
    c.advance(16);
    tl.mark(E.FIRST_FRAME);

    const r = tl.getReport();
    const ch = r.finished[0];
    ok('a finished change is reported', r.finished.length === 1 && r.open === null);
    ok('it ended "presented" at the first frame', ch.outcome === 'presented');
    ok('it kept what the request said', ch.kind === 'level' && ch.levelId === 'L2' && ch.implicit === false);
    ok(
      'events are in order',
      ch.events.map((e) => e.event).join() ===
        'request,prepare-start,prepare-end,view-called,tear-down,canvas-init,canvas-ready,commit,first-frame'
    );
    ok(
      'each event has its time since the previous one',
      ch.events[2].sincePreviousMs === 400 && ch.events[5].sincePreviousMs === 30
    );
    ok('event detail rides along', ch.events[2].outcome === 'ok');
    const s = ch.summary;
    ok('preparedMs = prepare-start → prepare-end', s.preparedMs === 400);
    ok('tearDownToInitMs = tear-down → canvas-init', s.tearDownToInitMs === 30);
    ok('foundryDrawMs = canvas-init → canvas-ready', s.foundryDrawMs === 200);
    ok('readyToCommitMs = canvas-ready → commit', s.readyToCommitMs === 10);
    ok('commitToFirstFrameMs = commit → first frame', s.commitToFirstFrameMs === 16);
    ok('totalMs = whole change', s.totalMs === 661);
    ok('a floor re-sync is not a restart', s.viewerRestarted === false && s.gatePrepared === true);
    ok('one log line per finished change', lines.length === 1 && /#1 presented: 661 ms/.test(lines[0]));
  }

  // --- the restart signature, and "did not happen" is null --------------------
  {
    const c = fakeClock();
    const tl = createFloorTimeline({ now: c.now });
    tl.mark(E.TEAR_DOWN); // nobody gated this one
    c.advance(50);
    tl.mark(E.CANVAS_INIT);
    tl.mark(E.CANVAS_READY);
    c.advance(9000);
    tl.mark(E.VIEWER_STARTED);
    tl.mark(E.FIRST_FRAME);
    const ch = tl.getReport().finished[0];
    ok('an ungated redraw opens its own change', ch.implicit === true);
    ok(
      'a viewer restart is called out',
      ch.summary.viewerRestarted === true && ch.summary.readyToViewerStartedMs === 9000
    );
    ok(
      'a stretch whose end never happened is null, not 0',
      ch.summary.preparedMs === null && ch.summary.readyToCommitMs === null
    );
  }

  // --- cancelled / superseded / replaced -------------------------------------
  {
    const tl = createFloorTimeline({ now: fakeClock().now });
    tl.mark(E.REQUEST, { kind: 'level' });
    tl.mark(E.CANCELLED);
    ok('cancel ends the change "cancelled"', tl.getReport().finished[0].outcome === 'cancelled');
    tl.mark(E.REQUEST, { kind: 'level' });
    tl.mark(E.REQUEST, { kind: 'level', levelId: 'L3' });
    const r = tl.getReport();
    ok('a newer request closes the open one as "replaced"', r.finished[0].outcome === 'replaced');
    ok('…and the newer one is the open change', r.open?.levelId === 'L3');
  }

  // --- a second tear-down is a different redraw ------------------------------
  {
    const tl = createFloorTimeline({ now: fakeClock().now });
    tl.mark(E.TEAR_DOWN);
    tl.mark(E.CANVAS_INIT);
    tl.mark(E.TEAR_DOWN);
    const r = tl.getReport();
    ok('an unfinished redraw followed by another tear-down is "abandoned"', r.finished[0]?.outcome === 'abandoned');
    ok('…and the new tear-down starts its own change', r.open?.events.length === 1);
  }

  // --- bounded ---------------------------------------------------------------
  {
    const tl = createFloorTimeline({ now: fakeClock().now });
    for (let i = 0; i < MAX_CHANGES + 5; i++) {
      tl.mark(E.REQUEST);
      tl.mark(E.FIRST_FRAME);
    }
    ok('only the most recent changes are kept', tl.getReport().finished.length === MAX_CHANGES);
    ok('…most recent first', tl.getReport().finished[0].n === MAX_CHANGES + 5);
    ok('…but every change is counted', tl.getReport().changesSeen === MAX_CHANGES + 5);
  }

  // --- garbage ---------------------------------------------------------------
  {
    const tl = createFloorTimeline({ now: fakeClock().now });
    tl.mark('');
    tl.mark(null);
    ok('a nameless mark is ignored', tl.getReport().eventsSeen === 0 && tl.getLastChange() === null);
    ok('summarising nothing gives nulls', summariseChange([]).totalMs === null);
  }
}
