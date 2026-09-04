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
  MAX_CONSECUTIVE_WORKER_FAILURES,
  WORKER_RECONSTRUCT_COOLDOWN_MS,
} from '../compressed-textures.js';

/** Records what was posted and lets the test answer one job at a time. */
class FakeWorker {
  constructor() {
    FakeWorker.latest = this;
    FakeWorker.instanceCount = (FakeWorker.instanceCount || 0) + 1;
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

    // --- a worker error no longer permanently condemns every OTHER asset ----
    // (mythica-machina-press#483: one bad asset used to latch `_unavailable`
    // forever; now it's a bounded cooldown-and-reconstruct.)
    // The cooldown timer reads perfNowMs() (core/frame-clock.js), which is a
    // thin wrapper over performance.now() — stub that, not Date.now(). Node's
    // `performance.now` lives on the prototype and is read-only there, so a
    // plain assignment throws; shadow it with an own property instead, and
    // `delete` that shadow afterwards to let the prototype's real one show
    // back through.
    let fakeNow = 1_000_000;
    Object.defineProperty(performance, 'now', { value: () => fakeNow, configurable: true });
    try {
      const baseInstances = FakeWorker.instanceCount; // whatever prior scenarios already built

      const errA = requestCompressedTexture('err-a');
      ok('the job that triggers this section built its own worker', FakeWorker.instanceCount === baseInstances + 1);
      FakeWorker.latest.onerror();
      ok('a single worker error resolves the in-flight job null (raw fallback)', (await errA) === null);
      ok('...but does NOT permanently disable the worker', getCompressedTextureStats().unavailable === false);
      ok('...it reports a cooldown instead', getCompressedTextureStats().cooldownActive === true);

      const duringCooldown = await requestCompressedTexture('during-cooldown');
      ok('a request mid-cooldown also falls back to raw, without reconstructing', duringCooldown === null);
      ok('no second worker was built yet', FakeWorker.instanceCount === baseInstances + 1);

      fakeNow += WORKER_RECONSTRUCT_COOLDOWN_MS + 1;
      const afterCooldown = requestCompressedTexture('after-cooldown');
      ok('past the cooldown, a fresh Worker is built', FakeWorker.instanceCount === baseInstances + 2);
      FakeWorker.latest.replyBc(FakeWorker.latest.current.id);
      ok('...and it actually serves the job', (await afterCooldown)?.format === 'bc1');
      ok(
        'a successful reply on the new worker resets the failure count',
        getCompressedTextureStats().consecutiveWorkerFailures === 0
      );
      ok('...and counts as a recorded reconstruction', getCompressedTextureStats().workerReconstructions === 1);

      // --- repeated errors with no success in between DO still give up -------
      // The first failure below reuses the still-healthy worker from
      // `afterCooldown` (no reconstruction needed to fail it); every failure
      // after that needs its own cooldown to elapse before `ensureWorker`
      // will even attempt the next Worker. So MAX_CONSECUTIVE_WORKER_FAILURES
      // errors cost MAX_CONSECUTIVE_WORKER_FAILURES - 1 new constructions.
      for (let i = 0; i < MAX_CONSECUTIVE_WORKER_FAILURES; i++) {
        // Cooldown must elapse BEFORE the request, or ensureWorker refuses to
        // reconstruct and the request resolves null without ever reaching a
        // (stale) worker to error on.
        if (i > 0) fakeNow += WORKER_RECONSTRUCT_COOLDOWN_MS + 1;
        const failing = requestCompressedTexture(`fatal-${i}`);
        FakeWorker.latest.onerror();
        await failing; // each error must land before the next request is made
      }
      ok(
        `after ${MAX_CONSECUTIVE_WORKER_FAILURES} straight failures, the worker gives up for good`,
        getCompressedTextureStats().unavailable === true
      );
      ok(
        'exactly MAX-1 reconstructions happened along the way',
        FakeWorker.instanceCount === baseInstances + 2 + (MAX_CONSECUTIVE_WORKER_FAILURES - 1)
      );

      fakeNow += WORKER_RECONSTRUCT_COOLDOWN_MS * 10;
      const afterGivingUp = await requestCompressedTexture('after-giving-up');
      ok('...and stays unavailable even long past any cooldown', afterGivingUp === null);
      ok(
        '...without building yet another Worker',
        FakeWorker.instanceCount === baseInstances + 2 + (MAX_CONSECUTIVE_WORKER_FAILURES - 1)
      );
    } finally {
      delete performance.now;
    }
  } finally {
    globalThis.Worker = priorWorker;
  }
}
