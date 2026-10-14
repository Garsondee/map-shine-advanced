/**
 * ui-shadow-scan.test.mjs — which windows the UI shadow counts, and the
 * post-frame scanner that keeps the layout read out of the render loop.
 *
 * The DOM is faked (a `querySelectorAll` over plain objects) and the scheduler
 * is driven by hand, so the two things worth proving are provable in Node:
 *
 *   1. THE RULE for what counts as a shadow-casting window — a title bar, not
 *      minimized, non-degenerate — matches what `updateUiShadowStamps` did
 *      inline before this was extracted.
 *   2. THE SCANNER NEVER READS UNTIL THE FRAME HAS ENDED. `request()` must
 *      only QUEUE; the read happens when the scheduler fires. That is the
 *      whole fix (see ui-shadow-scan.js's header): if `request()` read
 *      synchronously, the forced reflow would be back.
 */
import { readUiWindowRects, createPostFrameScanner } from '../ui-shadow-scan.js';

function fakeEl({ header = true, minimized = false, rect = { left: 10, top: 20, width: 300, height: 200 } } = {}) {
  return {
    querySelector: (sel) => (sel === ':scope > .window-header' && header ? {} : null),
    classList: { contains: (c) => c === 'minimized' && minimized },
    getBoundingClientRect: () => rect,
  };
}

function fakeDoc(els) {
  return { querySelectorAll: (sel) => (sel === '.application, .app.window-app' ? els : []) };
}

function fakeCanvas(rect = { left: 0, top: 0, width: 1920, height: 1080 }, isConnected = true) {
  return { isConnected, getBoundingClientRect: () => rect };
}

export function run(t) {
  const { ok } = t;

  // ── WHICH WINDOWS COUNT ─────────────────────────────────────────────────
  {
    const scan = readUiWindowRects(
      fakeDoc([
        fakeEl({ rect: { left: 5, top: 6, width: 100, height: 80 } }), // counts
        fakeEl({ header: false }), // docked UI (sidebar/hotbar) — no title bar
        fakeEl({ minimized: true }), // minimized
        fakeEl({ rect: { left: 0, top: 0, width: 0, height: 50 } }), // zero width
        fakeEl({ rect: { left: 0, top: 0, width: 50, height: 0.4 } }), // sub-pixel height
        fakeEl({ rect: { left: 40, top: 50, width: 640, height: 480 } }), // counts
      ]),
      fakeCanvas()
    );
    ok('only framed, un-minimized, non-degenerate windows are returned', scan.windows.length === 2);
    ok(
      'their rects are copied as plain {left, top, width, height} data',
      scan.windows[0].left === 5 &&
        scan.windows[0].top === 6 &&
        scan.windows[0].width === 100 &&
        scan.windows[0].height === 80 &&
        Object.keys(scan.windows[1]).sort().join() === 'height,left,top,width'
    );
    ok(
      'the canvas rect rides along, also as plain data',
      scan.canvasRect.width === 1920 && scan.canvasRect.height === 1080
    );
  }
  ok('no windows open is an empty list, not null', readUiWindowRects(fakeDoc([]), fakeCanvas()).windows.length === 0);
  ok(
    'a disconnected canvas (viewer stopped) reads as null',
    readUiWindowRects(fakeDoc([fakeEl()]), fakeCanvas(undefined, false)) === null
  );
  ok('a missing canvas reads as null', readUiWindowRects(fakeDoc([fakeEl()]), null) === null);

  // ── THE SCANNER QUEUES; IT NEVER READS INSIDE THE FRAME ─────────────────
  {
    let reads = 0;
    const queued = [];
    const scanner = createPostFrameScanner({
      read: () => ({ n: ++reads }),
      schedule: (fn) => queued.push(fn) && queued.length,
      cancel: () => {},
    });
    scanner.request();
    ok(
      'request() only queues — it performs NO read (this is the forced-reflow fix)',
      reads === 0 && queued.length === 1
    );
    ok('nothing is available to take before the scheduler fires', scanner.take() === null);
    scanner.request();
    scanner.request();
    ok('request() is idempotent while a read is queued (a slow task cannot stack reads)', queued.length === 1);
    queued.shift()();
    ok('the read happens when the scheduler fires, exactly once', reads === 1);
    const first = scanner.take();
    ok('take() returns the finished read', first && first.n === 1);
    ok('…and only once — a result is applied one time, not re-applied every frame', scanner.take() === null);
    scanner.request();
    ok('a fresh request can queue again after the previous one ran', queued.length === 1);
    queued.shift()();
    ok('the next read is a new one', scanner.take().n === 2);
  }

  // ── A NEWER RESULT SUPERSEDES AN UNCONSUMED ONE ─────────────────────────
  {
    let n = 0;
    const queued = [];
    const scanner = createPostFrameScanner({
      read: () => ({ n: ++n }),
      schedule: (fn) => queued.push(fn) && queued.length,
      cancel: () => {},
    });
    scanner.request();
    queued.shift()();
    scanner.request();
    queued.shift()();
    ok('with two finished reads unconsumed, take() returns the newest', scanner.take().n === 2);
  }

  // ── A NULL READ DOES NOT ERASE A WAITING RESULT ─────────────────────────
  {
    let step = 0;
    const queued = [];
    const scanner = createPostFrameScanner({
      read: () => (++step === 1 ? { ok: true } : null),
      schedule: (fn) => queued.push(fn) && queued.length,
      cancel: () => {},
    });
    scanner.request();
    queued.shift()();
    scanner.request();
    queued.shift()(); // the canvas went away: read() returned null
    ok('a null read (canvas gone) leaves the earlier result intact', scanner.take()?.ok === true);
  }

  // ── DISCARD CANCELS AND CLEARS ──────────────────────────────────────────
  {
    const cancelled = [];
    const queued = [];
    const scanner = createPostFrameScanner({
      read: () => ({ done: true }),
      schedule: (fn) => queued.push(fn) && queued.length,
      cancel: (h) => cancelled.push(h),
    });
    scanner.request();
    scanner.discard();
    ok('discard() cancels a queued read', cancelled.length === 1);
    scanner.request();
    ok('…and a new request can queue afterwards', queued.length === 2);
    queued.shift()(); // the cancelled callback firing anyway must not be fatal
    queued.shift()();
    scanner.discard();
    ok('discard() also drops an unconsumed result', scanner.take() === null);
  }
}
