/**
 * SCENE SETTLE — "is everything actually on screen yet?", answered with
 * outstanding-work counters instead of a stopwatch.
 *
 * ============================================================================
 * THE PROBLEM THIS EXISTS TO END (author, 2026-08-11)
 * ============================================================================
 * *"the 12k x 12k mansion map's upper floor takes an extremely long time to
 * appear which causes confusion for you and me. It's fine once it's been
 * cached, but the first cold load always takes a very long time to load levels
 * and we currently don't correctly track when the system is actually finished
 * loading, so the loading screen goes away too quickly."*
 *
 * Both halves of that are the same defect. The load is declared complete when
 * the things the loading screen KNOWS about have finished — but a 12,000²
 * floor's real arrival is a longer chain than that: fetch → decode → BC
 * compress (~52 s cold, per layer) → upload → residency pass → mesh build →
 * first frame that actually draws it. Anything watching only the front of that
 * chain announces "ready" while art is still materialising, and then everyone
 * downstream — a human waiting to look, a capture script about to screenshot,
 * an assistant about to believe a measurement — is working from a picture that
 * is still filling in. Every fixed `waitForTimeout(45000)` in this repo's
 * harness scripts is a guess standing in for this module.
 *
 * ============================================================================
 * THE RULE
 * ============================================================================
 * The scene is SETTLED when every counted piece of outstanding work reads zero
 * AND has read zero continuously for `quietMs` AND real frames have rendered
 * during that quiet window. All three matter:
 *   - zero work, because a stopwatch cannot know what is still queued;
 *   - HELD for a period, because these counters dip through zero between
 *     stages (one item finishes decoding a beat before the next is requested,
 *     and a naive reader calls that "done" — the same premature-completion bug
 *     one level down);
 *   - frames advancing, because a paused/backgrounded renderer has zero work
 *     outstanding forever and is the opposite of settled (this project has
 *     already been bitten by a non-compositing window parking a load in the
 *     `firstFrame` phase — see the live-harness memory's trap 5).
 *
 * ============================================================================
 * WHY BLOCKERS ARE NAMED, NOT COUNTED
 * ============================================================================
 * "Still loading" is what we have today and it is useless at 3 a.m. on a cold
 * cache. Every non-zero counter is reported as a named blocker with its count,
 * so a wait that never finishes says *which* stage is stuck — a BC worker that
 * died, an item wedged in `loading`, a residency pass that never lands. That
 * turns an unexplained 20-minute hang into a one-line diagnosis, which is the
 * entire point (`feedback_instruments_must_not_lie`: an instrument that cannot
 * say WHY is a stopwatch with extra steps).
 *
 * Pure and Node-tested: no THREE, no globals, no clock of its own — time is an
 * input (`nowMs`), the same discipline every other timed thing here follows.
 *
 * @module vt/settle
 */

/** Quiet period, in ms, before zero outstanding work counts as settled. */
export const DEFAULT_SETTLE_QUIET_MS = 1500;

/**
 * The work counters, in the order a reader most wants to see them — roughly
 * the order the loading chain runs, so the first non-zero blocker names the
 * earliest stage still busy.
 *
 * `label` is written for a human staring at a stuck load, not for a dashboard.
 * @type {ReadonlyArray<{key: string, label: string}>}
 */
export const SETTLE_WORK_KEYS = Object.freeze([
  { key: 'itemsLoading', label: 'map layers still loading (fetch/decode/compress)' },
  { key: 'bcCompressOutstanding', label: 'textures still being GPU-compressed' },
  { key: 'decodesInFlight', label: 'image decodes in flight' },
  { key: 'decodeQueueDepth', label: 'image decodes queued' },
  { key: 'vegetationOverlaysLoading', label: 'vegetation overlays still loading' },
  { key: 'maskPagesPending', label: 'mask pages still streaming' },
  { key: 'residencyInFlight', label: 'residency pass running' },
  { key: 'residencyDirty', label: 'residency pass queued' },
]);

/**
 * Turn a raw counter bag into named blockers. Unknown keys are ignored and
 * missing ones read as zero — a collector that cannot see a subsystem must
 * not be able to fabricate a blocker, nor to hide one by omission (the caller
 * reports `unavailable` separately for that; see {@link createSettleTracker}).
 *
 * @param {Record<string, number|boolean>} raw
 * @returns {{blockers: Array<{key:string,label:string,count:number}>, totalOutstanding:number}}
 */
export function summarizeSettleWork(raw) {
  const blockers = [];
  let totalOutstanding = 0;
  for (const { key, label } of SETTLE_WORK_KEYS) {
    const v = raw?.[key];
    const count = v === true ? 1 : v === false || v == null ? 0 : Number(v) || 0;
    if (count > 0) {
      blockers.push({ key, label, count });
      totalOutstanding += count;
    }
  }
  return { blockers, totalOutstanding };
}

/**
 * A settle tracker. Feed it samples; ask it whether the scene has settled.
 *
 * @param {object} [opts]
 * @param {number} [opts.quietMs] - how long work must stay at zero.
 * @param {number} [opts.minFrames=2] - frames that must render during the
 *   quiet window before it counts (a still renderer is not a settled one).
 * @returns {{sample: Function, read: Function, reset: Function}}
 */
export function createSettleTracker({ quietMs = DEFAULT_SETTLE_QUIET_MS, minFrames = 2 } = {}) {
  let quietSinceMs = null;
  let framesAtQuietStart = 0;
  let last = null;

  function sample(raw, nowMs, frameCount = 0) {
    const { blockers, totalOutstanding } = summarizeSettleWork(raw);
    if (totalOutstanding > 0) {
      // Any outstanding work restarts the clock — never "mostly quiet".
      quietSinceMs = null;
      framesAtQuietStart = frameCount;
    } else if (quietSinceMs === null) {
      quietSinceMs = nowMs;
      framesAtQuietStart = frameCount;
    }
    const quietForMs = quietSinceMs === null ? 0 : Math.max(0, nowMs - quietSinceMs);
    const framesSinceQuiet = Math.max(0, frameCount - framesAtQuietStart);
    const settled = quietSinceMs !== null && quietForMs >= quietMs && framesSinceQuiet >= minFrames;
    last = {
      settled,
      quietForMs,
      framesSinceQuiet,
      blockers,
      totalOutstanding,
      // Named so a caller that times out can say what it was waiting FOR,
      // rather than only how long it waited.
      // Order matters, and it is not cosmetic: during the ordinary quiet dwell
      // BOTH "time not yet elapsed" and "no frames since quiet began" are
      // momentarily true, and blaming the renderer there would send a reader
      // hunting a compositing bug that does not exist. The renderer is only
      // named once the time requirement is satisfied and frames STILL have not
      // arrived — which is the genuine "this window is not drawing" case.
      waitingFor: blockers.length
        ? blockers.map((b) => `${b.label} (${b.count})`)
        : settled
          ? []
          : quietForMs < quietMs
            ? [`the ${quietMs}ms quiet period to elapse`]
            : ['frames to render (the renderer may not be compositing)'],
      sampledAtMs: nowMs,
    };
    return last;
  }

  return {
    sample,
    read: () => last,
    reset: () => {
      quietSinceMs = null;
      framesAtQuietStart = 0;
      last = null;
    },
  };
}
