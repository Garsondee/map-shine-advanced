/**
 * gpu-zone-timer.js — REAL per-render-pass GPU time, via WebGPU timestamp
 * queries, attributed to the zone that was open when the pass ran.
 *
 * ============================================================================
 * THE FLAG NOBODY EVER PASSED
 * ============================================================================
 *
 * `diag/gpu-probe.js` recorded for a week that three's `trackTimestamp` GPU timer
 * "reported supported:false", and that claim steered every session away from the
 * best instrument available. It was a misdiagnosis. In the vendored three:
 *
 *   Backend constructor      : `this.trackTimestamp = parameters.trackTimestamp === true`
 *                              (three.webgpu.js:64637) — CONSTRUCTOR-ONLY, defaults false
 *   WebGPUBackend.init       : `trackTimestamp = trackTimestamp && hasFeature(TimestampQuery)`
 *                              (:75258) — a false flag stays false on capable hardware
 *   device creation          : requests EVERY feature the adapter reports (:75217-75228),
 *                              so `timestamp-query` is present wherever the adapter has it
 *
 * The viewer simply never passed the flag. So the fix is to construct the
 * renderer WITH `trackTimestamp: true`, capture the post-`init()` value as the
 * CAPABILITY, and park the flag at `false` until armed — at which point
 * `initTimestampQuery` returns on its first line (:76493) and the query pool is
 * never even allocated. That is what makes this free when off.
 *
 * ============================================================================
 * WHY THE INSPECTOR, AND NOT UID ARITHMETIC
 * ============================================================================
 *
 * `renderer.inspector` is a public setter (:61011) and `InspectorBase` is an
 * exported class (:79120), so we subclass it and inherit every hook we do not
 * implement as a no-op — no duck-typed method set to drift out of step with a
 * future three bump. The render path hands us the timestamp uid directly
 * (`inspector.beginRender(uid, ...)`, :61331), so nothing has to reconstruct
 * `r:<frameCalls>:<contextId>:f<frame>` from parts, and `contextId` is not
 * knowable from outside anyway.
 *
 * Installing an inspector does NOT change rendering. The only branch in three
 * that tests for a custom inspector is `InspectorNode.setup` (:36855), which
 * emits one warning for `.toInspector()` on WebGL — a TSL method this codebase
 * does not use.
 *
 * ============================================================================
 * THE THREE TRAPS, ALL LIVE
 * ============================================================================
 *
 * 1. THE POOL HOLDS 2048 QUERIES = 1024 PASSES (:76495). Past that
 *    `allocateQueriesForContext` returns null, RENDERING CONTINUES, and
 *    measurement silently stops. At ~25 render calls per frame that is ~40
 *    frames. `resolveQueriesAsync` resets `currentQueryIndex` to 0 (:74987), so
 *    resolving EVERY FRAME is not an optimisation — it is the thing that keeps
 *    the pool from filling. We resolve every frame and still count overflow.
 *
 * 2. `getTimestamp(uid)` WARNS AND RETURNS 0 for a uid it does not have
 *    (:67476-67482). A lying zero, plus console noise the flight recorder would
 *    faithfully capture. Every read here is gated on `hasTimestampQuery(uid)`.
 *
 * 3. `pool.timestamps` IS NEVER CLEARED (:75029). It grows for as long as the
 *    flag is on, which is survivable for a measurement window and a leak for a
 *    session. Disarm is guaranteed in the caller's `finally`, and we prune our
 *    own pending map as we fold.
 *
 * @module diag/gpu-zone-timer
 */
import { createLogger } from '../core/log.js';
import { percentileOf } from './gpu-probe.js';

const log = createLogger('gpu-zone-timer');

/** Beyond this many un-resolved uids we assume the pool overflowed. */
export const PENDING_UID_ALARM = 2000;

/**
 * Parse a three timestamp uid: `r:<frameCalls>:<contextId>:f<frameId>`.
 * Pure, so the format assumption is a Node test rather than a hope.
 * @returns {{type:'render'|'compute', call:number, context:number, frame:number}|null}
 */
export function parseTimestampUid(uid) {
  if (typeof uid !== 'string') return null;
  const m = /^([rc]):(\d+):(\d+):f(\d+)$/.exec(uid);
  if (!m) return null;
  return {
    type: m[1] === 'r' ? 'render' : 'compute',
    call: Number(m[2]),
    context: Number(m[3]),
    frame: Number(m[4]),
  };
}

/**
 * Can this renderer time individual passes?
 *
 * Reports the REASON as well as the answer, because "no" has three very
 * different causes and the report has to tell them apart: the flag was never
 * requested at construction, the adapter lacks the feature, or there is no
 * backend at all.
 */
export function probeTimestampSupport(renderer) {
  const backend = renderer?.backend ?? null;
  if (!backend) {
    return { method: 'none', capable: false, reason: 'no renderer backend — the renderer has not been init()ed' };
  }
  // Post-init this is `requestedFlag && hasFeature(TimestampQuery)`, so `true`
  // here proves BOTH halves. See this file's header.
  const capable = backend.trackTimestamp === true || backend.__msaTimestampCapable === true;
  if (!capable) {
    return {
      method: 'none',
      capable: false,
      reason:
        'trackTimestamp is false after init(). Either the renderer was constructed without ' +
        '`trackTimestamp: true` (it is a CONSTRUCTOR-ONLY flag, three.webgpu.js:64637) or this adapter ' +
        'genuinely lacks the timestamp-query feature. Those are different problems — check the renderer ' +
        'construction site first, because that was the actual cause last time.',
    };
  }
  return {
    method: 'timestamp-query',
    capable: true,
    backend: backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
    reason: null,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.renderer   a THREE Renderer (duck-typed here)
 * @param {Function} deps.InspectorBase  THREE.InspectorBase — injected, not imported
 * @param {object} deps.profiler   a frame-profiler instance
 */
export function createGpuZoneTimer({ renderer, InspectorBase, profiler }) {
  /** uid -> zone slot that was open when the pass began. */
  const pending = new Map();
  let armed = false;
  let installed = null;
  let previousInspector = null;
  let folded = 0;
  let missed = 0;
  let unattributed = 0;
  let overflowed = false;
  let resolveErrors = 0;
  // OVERFLOW DIAGNOSTICS (2026-08-09) — `overflowed` alone says a run crossed
  // the line; it says nothing about how CLOSE a non-overflowing run came, or
  // what the pool was doing in the frames leading up to a crossing. Two live
  // reports have shown `poolOverflowed: true` with no named cause anywhere in
  // this codebase — a leading hypothesis was `renderFrame`'s own GPU-probe
  // throttle blocking `collect()` for several consecutive ticks while a PRIOR
  // `resolveTimestampsAsync` is still stuck awaiting `resultBuffer.mapAsync`.
  //
  // ⚠️ REFUTED, 2026-08-26 (docs/planning perf-report round 2) — the first
  // live capture long enough to overflow (`maxPendingSize: 2017`, crossing
  // `PENDING_UID_ALARM`) showed `maxResolveSkipStreak: 3` — far too short a
  // streak to support "stuck for many consecutive ticks". The real mechanism,
  // confirmed against the vendored three.webgpu.js directly: this file only
  // ever called `resolveTimestampsAsync('render')` — never `'compute'` — so
  // every `c:`-prefixed uid from a TSL compute dispatch (this project runs
  // wind/fluid compute EVERY frame) landed in `pending` via `beginCompute`
  // and could NEVER resolve, accumulating one-or-more per frame for the whole
  // window until crossing the alarm. Not a stall; a steady, silent leak of an
  // entire query TYPE. Fixed below by resolving both types independently,
  // each with its OWN skip-streak tracking (`resolveState`) so a stuck
  // resolve on one type can never block the other from being attempted.
  let maxPendingSize = 0;
  /** Per-type resolve bookkeeping — `poolFor(type)` already indexes pools
   * this way; resolve scheduling now mirrors it. */
  const resolveState = {
    render: { inFlight: false, skipStreak: 0, maxSkipStreak: 0 },
    compute: { inFlight: false, skipStreak: 0, maxSkipStreak: 0 },
  };
  // The latest known COMPUTE-pass frame total, folded into the next RENDER-
  // driven frameGpuSamples push (see resolveType's own doc) rather than
  // requiring both types to report before any sample is pushed at all — a
  // build/session with no active compute work would otherwise starve
  // frameGpuMs entirely, which is worse than the render-only number this
  // file already produced before this fix. Frame-or-two-stale by nature,
  // same tolerance this file's own header already states for uid resolution.
  let lastComputeFrameTotal = 0;
  /**
   * Whole-frame GPU samples, free of charge. `Backend.resolveTimestampsAsync`
   * writes the frame's TOTAL pass duration into `renderer.info.render.timestamp`
   * (three.webgpu.js:65119). That is the denominator `attribution.coverage`
   * needs — and without it coverage could never be computed at all during a
   * profile, because the session deliberately refuses to run while the
   * whole-frame GPU probe (the other source of a frame total) is armed.
   *
   * ⚠️ It is the sum of TIMESTAMPED RENDER PASSES, not every joule the GPU spent
   * on the frame: mipmap generation, presentation and anything outside a render
   * pass are not in it. The report labels it accordingly rather than calling it
   * "the frame".
   */
  const frameGpuSamples = [];
  const MAX_FRAME_SAMPLES = 900;

  const support = probeTimestampSupport(renderer);

  // Subclassing the exported base means every hook we do not implement stays a
  // no-op that three already defines — nothing to keep in step by hand.
  class ZoneInspector extends InspectorBase {
    beginRender(uid) {
      if (!armed) return;
      // NEAREST GPU-CAPABLE ANCESTOR, not simply the innermost open zone
      // (2026-08-12). A `kind:'gpu'` bracket that opens a `kind:'cpu'` sub-zone
      // around its own renderer.render() call would otherwise hand that child
      // its entire GPU cost while reporting null for itself — see
      // frame-profiler.js#gpuTargetSlot for the full history and for why the
      // attributed TOTAL is unaffected by this. `currentSlot` is retained on the
      // profiler (it is the honest answer to a different question) but is no
      // longer what decides attribution.
      const slot = profiler.gpuTargetSlot ? profiler.gpuTargetSlot() : profiler.currentSlot();
      // A render with no zone open is real (something outside every bracket) and
      // is COUNTED rather than silently attributed to slot 0, which would quietly
      // inflate whichever zone happened to be first in the taxonomy.
      if (slot < 0) {
        unattributed++;
        return;
      }
      pending.set(uid, slot);
    }
    beginCompute(uid) {
      this.beginRender(uid);
    }
  }

  function poolFor(type) {
    return renderer?.backend?.timestampQueryPool?.[type] ?? null;
  }

  function foldResolved() {
    const backend = renderer?.backend;
    if (!backend || pending.size === 0) return;
    // Checked at ENTRY, before this pass's own folding can shrink `pending` —
    // the peak backlog a caller would see is "how many had piled up before we
    // got a chance to try resolving any of them", not "how many are left over
    // afterward".
    if (pending.size > maxPendingSize) maxPendingSize = pending.size;
    for (const [uid, slot] of pending) {
      let has = false;
      const parsed = parseTimestampUid(uid);
      const pool = poolFor(parsed?.type === 'compute' ? 'compute' : 'render');
      // Read the pool's own map rather than backend.getTimestamp(), which warns
      // and returns a lying 0 for anything it does not have (trap 2).
      if (pool && pool.timestamps instanceof Map) has = pool.timestamps.has(uid);
      if (!has) continue;
      const ms = pool.timestamps.get(uid);
      if (Number.isFinite(ms) && ms >= 0) {
        profiler.noteGpuMs(slot, ms);
        folded++;
      } else {
        missed++;
      }
      pending.delete(uid);
      pool.timestamps.delete(uid); // trap 3: the pool never prunes itself
    }
    if (pending.size > PENDING_UID_ALARM) {
      overflowed = true;
      pending.clear();
    }
  }

  /**
   * Resolve+fold ONE query type. Independent per-type in-flight/skip-streak
   * state (`resolveState[type]`) means a stuck resolve on `'render'` can
   * never block `'compute'` from being attempted next tick, and vice versa —
   * the actual guarantee the 2026-08-26 fix (see this file's own state-
   * declaration comment) exists to provide. Safe to call every tick for BOTH
   * types even when only one is doing real work:
   * `WebGPUTimestampQueryPool#resolveQueriesAsync` early-exits cheaply when
   * its own pool saw zero queries that round.
   * @param {'render'|'compute'} type
   */
  function resolveType(type) {
    const st = resolveState[type];
    if (st.inFlight) {
      // A run of these immediately BEFORE an overflow WOULD be the signature
      // of a stuck resolve — this file's own state-declaration comment
      // explains why the 2026-08-26 live data refuted that as the actual
      // cause of the overflow it was measured against, but the tracking
      // stays: it is real, useful evidence either way, for whichever type.
      st.skipStreak++;
      if (st.skipStreak > st.maxSkipStreak) st.maxSkipStreak = st.skipStreak;
      return;
    }
    st.skipStreak = 0;
    if (typeof renderer.resolveTimestampsAsync !== 'function') return;
    st.inFlight = true;
    Promise.resolve(renderer.resolveTimestampsAsync(type))
      .then(() => {
        foldResolved();
        const total = renderer.info?.[type]?.timestamp;
        const value = Number.isFinite(total) && total > 0 ? total : 0;
        if (type === 'compute') {
          // NOT pushed on its own — folded into the next RENDER-driven push
          // below, so a session with zero active compute work degrades
          // exactly to this file's original render-only behaviour, never to
          // "no sample at all" (see `lastComputeFrameTotal`'s own doc).
          lastComputeFrameTotal = value;
          return;
        }
        const combined = value + lastComputeFrameTotal;
        if (combined > 0) {
          frameGpuSamples.push(combined);
          if (frameGpuSamples.length > MAX_FRAME_SAMPLES) frameGpuSamples.shift();
        }
      })
      .catch((err) => {
        resolveErrors++;
        log.error(`resolveTimestampsAsync('${type}') rejected — GPU zone samples dropped for this frame:`, err);
      })
      .finally(() => {
        st.inFlight = false;
      });
  }

  return {
    support,

    /**
     * Flip the vendor-internal flag on and install the inspector.
     *
     * This is the ONE line in the repo that writes `backend.trackTimestamp`
     * (three.webgpu.js:64637 declares it constructor-only; :75258 ANDs it with
     * the feature check). Keeping it to one place is what stops the next three
     * vendor bump from silently disarming the profiler somewhere else.
     */
    arm() {
      if (!support.capable) return false;
      if (armed) return true;
      renderer.backend.trackTimestamp = true;
      previousInspector = renderer.inspector ?? null;
      installed = new ZoneInspector();
      renderer.inspector = installed;
      pending.clear();
      frameGpuSamples.length = 0;
      folded = 0;
      missed = 0;
      unattributed = 0;
      overflowed = false;
      resolveErrors = 0;
      maxPendingSize = 0;
      resolveState.render = { inFlight: false, skipStreak: 0, maxSkipStreak: 0 };
      resolveState.compute = { inFlight: false, skipStreak: 0, maxSkipStreak: 0 };
      lastComputeFrameTotal = 0;
      armed = true;
      return true;
    },

    disarm() {
      if (!armed) return;
      armed = false;
      try {
        renderer.backend.trackTimestamp = false;
        if (previousInspector) renderer.inspector = previousInspector;
      } catch (err) {
        log.error('failed to restore renderer timestamp state on disarm:', err);
      }
      // Drop our own pending map AND the pool's, which three never prunes.
      pending.clear();
      for (const type of ['render', 'compute']) {
        const pool = poolFor(type);
        if (pool?.timestamps instanceof Map) pool.timestamps.clear();
      }
      installed = null;
      previousInspector = null;
    },

    isArmed: () => armed,

    /**
     * Resolve this frame's queries and fold whatever is ready into the profiler.
     *
     * FIRE AND FORGET, single-in-flight — awaiting here would serialise CPU and
     * GPU and turn the measurement into the very thing `gpu-probe.js`'s header
     * warns about. Timestamps arrive a frame or two late; the uid->slot map is
     * what makes that harmless.
     *
     * MUST be called every frame while armed. `resolveQueriesAsync` is what
     * resets the query index, so skipping it fills the 1024-pass pool in ~40
     * frames and measurement stops without a word (trap 1).
     */
    collect() {
      if (!armed) return;
      // FOLD FIRST, ALWAYS. Folding just reads three's own uid->duration map, so
      // it is synchronous and cheap — and doing it unconditionally means a
      // timestamp that resolved during a previous frame lands immediately
      // instead of waiting behind whatever resolve is currently in flight. The
      // first version guarded the whole method on a single in-flight flag and
      // could therefore stall folding indefinitely on a slow readback, which
      // showed up as zones that simply never got a GPU number. Type-agnostic
      // already (poolFor(type) inside foldResolved dispatches per uid), so this
      // one call covers both of resolveType's independent resolve paths below.
      foldResolved();
      // BOTH TYPES, EVERY TICK (2026-08-26) — resolveType's own doc explains
      // why calling both unconditionally is safe and why this is the actual
      // fix for the pool-overflow class of bug this file used to only guess
      // at. Independent in-flight state per type, so neither call can starve
      // the other.
      resolveType('render');
      resolveType('compute');
    },

    /** Everything the report needs to say how much of the GPU story is real. */
    getStatus() {
      return {
        method: armed ? support.method : 'idle',
        capable: support.capable,
        reason: support.reason,
        backend: support.backend ?? null,
        foldedSamples: folded,
        pendingUids: pending.size,
        unattributedPasses: unattributed,
        malformedDurations: missed,
        resolveErrors,
        poolOverflowed: overflowed,
        // OVERFLOW DIAGNOSTICS — see this factory's own state-declaration
        // comment. `maxPendingSize` shows how close a run got even when it
        // never crossed PENDING_UID_ALARM. `maxResolveSkipStreak` (combined
        // across both types, for backward compatibility with existing
        // consumers that read it as a plain number — e.g. the
        // `timestamp-pool-overflow` finding) is the larger of the two types'
        // own streaks; `maxResolveSkipStreakByType`/`pendingUidsByType` give
        // the per-type split this bug class actually needs to diagnose — a
        // large RENDER streak points at a stuck GPU readback, a large or
        // ever-growing COMPUTE `pendingUids` with a near-zero skip streak
        // points at the 2026-08-26 leak class this file's own header
        // documents (a type simply never being resolved at all).
        maxPendingSize,
        maxResolveSkipStreak: Math.max(resolveState.render.maxSkipStreak, resolveState.compute.maxSkipStreak),
        maxResolveSkipStreakByType: {
          render: resolveState.render.maxSkipStreak,
          compute: resolveState.compute.maxSkipStreak,
        },
        pendingUidsByType: (() => {
          const byType = { render: 0, compute: 0 };
          for (const uid of pending.keys()) {
            byType[parseTimestampUid(uid)?.type === 'compute' ? 'compute' : 'render']++;
          }
          return byType;
        })(),
        // The denominator for attribution.coverage. Labelled, not called "the
        // frame". RENDER AND COMPUTE, summed (2026-08-26) — before this fix,
        // compute-pass GPU time was simply never resolved at all, so it never
        // reached `attributed` either; the two stayed accidentally consistent.
        // Once compute uids started folding, leaving this render-only would
        // have let `attribution.coverage` silently exceed 1.0 with no clamp
        // anywhere in computeAttribution — this is the other half of that fix,
        // not a separate concern.
        frameGpuMs: frameGpuSamples.length
          ? {
              p50: percentileOf(frameGpuSamples, 0.5),
              p95: percentileOf(frameGpuSamples, 0.95),
              max: Math.round(Math.max(...frameGpuSamples) * 100) / 100,
              sampleCount: frameGpuSamples.length,
              basis:
                'sum of timestamped render AND compute passes per frame (renderer.info.{render,compute}.timestamp)',
              caveat:
                'NOT the whole GPU frame: mipmap generation, presentation and any work outside a render/compute ' +
                'pass are not counted. Coverage against this measures "of the pass time we can see, how much did ' +
                'we attribute to a declared zone" — a real question, but a narrower one than "where did the frame go".',
            }
          : null,
        note: overflowed
          ? 'The timestamp query pool overflowed: three stops handing out queries past 1024 outstanding passes ' +
            'and rendering continues silently. Zone GPU numbers are MISSING for part of this window, not zero.'
          : unattributed > 0
            ? `${unattributed} render pass(es) ran with no profiler zone open. Their GPU time is real but ` +
              'unattributed — it shows up in the frame total and in attribution.residualGpuMs, never folded ' +
              'into an arbitrary zone.'
            : null,
      };
    },
  };
}
