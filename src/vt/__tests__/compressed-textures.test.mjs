/**
 * Node verification for vt/compressed-textures.js — the BC worker client's
 * PRIORITY QUEUE.
 *
 * THE BUG THIS PINS (author, live on the real mansion, 2026-08-11): after a
 * cache wipe, switching to the upper floor left its background and foreground
 * invisible for MINUTES while everything else drew. One worker, strict FIFO,
 * and `primeCoverAlphaGrids` had already flooded it with a coarse-alpha job for
 * every item on every floor — so the texture the player was actually staring at
 * queued behind dozens of full 12000² decodes that nothing on screen wanted.
 *
 * The property that matters is therefore not "the queue works" but specifically
 * **a later interactive request overtakes earlier background ones**, and it is
 * asserted on real dispatch order (what actually reached the worker), never on
 * an internal field that could agree with a broken dispatcher.
 *
 * The worker is stubbed: `ensureWorker` reads the `Worker` global lazily, on the
 * first request, so installing a fake before any request is enough — no bundler
 * seam, no real thread, and the module under test is entirely unmodified.
 */
import {
  requestCompressedTexture,
  requestCoarseAlphaGrid,
  getCompressedTextureStats,
  disposeCompressedTextureWorker,
} from '../compressed-textures.js';

/** Records what was posted and lets the test answer one job at a time. */
class FakeWorker {
  constructor() {
    FakeWorker.latest = this;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(msg) {
    this.posted.push(msg);
  }
  terminate() {}
  /** The most recently dispatched job (the one the worker is "running"). */
  get current() {
    return this.posted[this.posted.length - 1];
  }
  replyBc(id) {
    this.onmessage?.({
      data: {
        id,
        ok: true,
        format: 'bc1',
        width: 8,
        height: 8,
        levels: [{ width: 8, height: 8, blocks: new Uint8Array(8) }],
      },
    });
  }
  replyAlpha(id) {
    this.onmessage?.({
      data: { id, ok: true, mode: 'alphaGrid', width: 8, height: 8, gridW: 2, gridH: 2, grid: new Uint8Array(4) },
    });
  }
  replyFailed(id) {
    this.onmessage?.({ data: { id, ok: false } });
  }
}

export async function run(t) {
  const { ok } = t;
  const priorWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;

  try {
    // --- THE CENTRAL CASE: interactive overtakes already-queued background ---
    const bgA = requestCoarseAlphaGrid('bg-a');
    const bgB = requestCoarseAlphaGrid('bg-b');
    const bgC = requestCoarseAlphaGrid('bg-c');
    const w = FakeWorker.latest;

    ok('only ONE job is posted at a time (the rest stay re-orderable here)', w.posted.length === 1);
    ok('the first arrival is the one in flight', w.posted[0].src === 'bg-a');

    // The floor switch: the texture the player is now waiting on, requested
    // LAST, behind three background jobs.
    const hot = requestCompressedTexture('upper-floor-background');
    ok('a later interactive request does not barge into the worker mid-job', w.posted.length === 1);

    const stats = getCompressedTextureStats();
    ok('pending counts queued work, not just the in-flight job', stats.pending === 4);
    ok(
      '...split by lane, so a report can name what is waiting',
      stats.queuedInteractive === 1 && stats.queuedBackground === 2
    );
    ok('inFlight is reported honestly', stats.inFlight === 1);
    ok('maxQueueDepth records the backlog actually seen', stats.maxQueueDepth >= 3);

    // Finish the in-flight background job — the next dispatch is the choice
    // this whole module exists to get right.
    w.replyAlpha(w.posted[0].id);
    ok(
      'THE FIX: the interactive job is served next, ahead of two OLDER background ones',
      w.posted.length === 2 && w.posted[1].src === 'upper-floor-background'
    );

    w.replyBc(w.posted[1].id);
    ok('background work resumes after it', w.posted.length === 3 && w.posted[2].src === 'bg-b');
    w.replyAlpha(w.posted[2].id);
    ok(
      '...in its own arrival order (FIFO within a lane is preserved)',
      w.posted.length === 4 && w.posted[3].src === 'bg-c'
    );
    w.replyAlpha(w.posted[3].id);

    ok('every job drained', getCompressedTextureStats().pending === 0);

    const [rA, , , rHot] = await Promise.all([bgA, bgB, bgC, hot]);
    ok('the interactive one resolved to real compressed blocks', rHot?.format === 'bc1');
    ok('a background one resolved to a real grid', rA?.grid instanceof Uint8Array);

    // --- a failed job must still advance the queue --------------------------
    const failing = requestCompressedTexture('fails');
    const following = requestCompressedTexture('follows');
    const failedId = w.current.id;
    w.replyFailed(failedId);
    ok('a failed reply still pumps the next job (a stall here strands the whole queue)', w.current.src === 'follows');
    w.replyBc(w.current.id);
    ok('a failed job resolves null, per the "null ⇒ use raw" contract', (await failing) === null);
    ok('and the one behind it still succeeds', (await following)?.format === 'bc1');

    // --- dispose must not strand awaiting callers ---------------------------
    const queued = [requestCoarseAlphaGrid('d-1'), requestCoarseAlphaGrid('d-2'), requestCoarseAlphaGrid('d-3')];
    ok('jobs are waiting before dispose', getCompressedTextureStats().pending === 3);
    disposeCompressedTextureWorker();
    ok('dispose clears the queue', getCompressedTextureStats().pending === 0);
    const disposed = await Promise.all(queued);
    ok(
      'every queued caller was RESOLVED by dispose, never left hanging',
      disposed.every((x) => x === null)
    );
  } finally {
    globalThis.Worker = priorWorker;
  }
}
