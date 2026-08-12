/**
 * frame-profiler.js — the zone timer. Owns the clock; knows nothing about
 * THREE, the DOM, or what a "pass" means beyond a string.
 *
 * ============================================================================
 * DISARMED, THIS COSTS ONE BOOLEAN READ
 * ============================================================================
 *
 * The author's constraint was "minimal performance cost when not active", and
 * that is a design property here, not an aspiration:
 *
 *   - every entry point returns on `if (!armed)` BEFORE reading the clock,
 *     touching an array, or allocating anything;
 *   - `passHooks` is ONE object built once at construction, so the render loop
 *     hands the same reference to `runPassPlan` every frame instead of
 *     allocating a closure pair 60 times a second;
 *   - armed, every accumulator is a preallocated typed array. Nothing allocates
 *     inside a frame. An instrument that triggers GC is measuring itself.
 *
 * `snapshot()` allocates freely — it runs once, after the window closes.
 *
 * ============================================================================
 * INCLUSIVE, NOT EXCLUSIVE
 * ============================================================================
 *
 * A zone's time INCLUDES its children. `pass.light.accumulate` covers the
 * sub-zones inside it, deliberately: the report needs both the pass total and
 * the children to compute the pass's own un-broken-down residual. That is also
 * why no stack is needed — each zone keeps its own open timestamp and they nest
 * without interacting. `perf-report.js` owns the un-double-counting.
 *
 * ============================================================================
 * WHY diag/
 * ============================================================================
 *
 * `time/one-clock` (tools/verify-structure.mjs, ratcheted at 35) allows
 * `performance.now()` in `diag/` and `core/frame-clock.js` and nowhere else. So
 * the viewer calls `profiler.begin(i)` and the clock is read HERE. `now` is
 * injected, which is also what makes every assertion below testable with a
 * deterministic fake clock and no browser.
 *
 * @module diag/frame-profiler
 */
import { PASS_ZONE_PREFIX, ZONES, zoneIndexOf } from './perf-zones.js';

/** Extra accumulator slots for the pass-level zones synthesised at runtime. */
export const MAX_PASS_ZONES = 32;
/** Frames discarded after arming: shader compile, first residency pass, first bake. */
export const DEFAULT_SETTLE_FRAMES = 30;

/**
 * Frame-gap ring capacity. 4,096 samples is ~68s at 60fps / ~100s at 40fps, so a
 * 60-second benchmark route fits whole — which matters, because the whole point
 * of that route is min/max/average over the ENTIRE sweep rather than a window
 * that happens to end wherever the buffer ran out. 16KB, allocated once.
 */
export const GAP_CAPACITY = 4096;
/**
 * A frame slower than this counts as a hitch for the in-flight-zone correlation.
 * Matches `vt-pan-viewer.js`'s own HITCH_THRESHOLD_MS deliberately: two
 * instruments disagreeing about what counts as a hitch, in the same report, is
 * the kind of quiet contradiction this file exists to avoid.
 */
export const DEFAULT_HITCH_THRESHOLD_MS = 50;
/** Trials used to measure the clock's real step. */
export const CLOCK_PROBE_TRIALS = 25;
/**
 * A CPU sample whose bracket OPENED within this many ms of the real window's
 * start counts as "early" for the front-loaded-burst-vs-steady-tax split. Ten
 * seconds is long enough to catch a settling burst (new residency items, a
 * cache warming) without swallowing the whole window on a short capture.
 */
export const DEFAULT_EARLY_WINDOW_MS = 10000;

/**
 * Measure the clock's actual resolution by spinning until the value changes.
 *
 * Foundry sets no COOP/COEP, so the page is not cross-origin-isolated and every
 * major browser clamps `performance.now()` — Firefox to ~1ms by default. A
 * profiler that assumed sub-microsecond resolution would report quantisation
 * noise as measurement. We measure the floor instead of assuming one.
 *
 * @returns {number|null} null when the clock never advanced (a frozen fake
 *   clock in a test, or a pathological environment) — never a fabricated 0.
 */
export function measureClockResolution(now, trials = CLOCK_PROBE_TRIALS, spinLimit = 1e6) {
  let min = Infinity;
  for (let i = 0; i < trials; i++) {
    const t0 = now();
    let t1 = now();
    let guard = 0;
    while (t1 === t0 && guard < spinLimit) {
      t1 = now();
      guard++;
    }
    const d = t1 - t0;
    if (d > 0 && d < min) min = d;
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now] injected clock
 * @param {ReadonlyArray<object>} [opts.zones] the declared taxonomy
 * @param {number} [opts.maxPassZones]
 */
export function createFrameProfiler({ now = defaultNow, zones = ZONES, maxPassZones = MAX_PASS_ZONES } = {}) {
  const declaredCount = zones.length;
  const slots = declaredCount + maxPassZones;

  // Preallocated. Nothing below allocates inside a frame.
  const cpuSum = new Float64Array(slots);
  const cpuMax = new Float64Array(slots);
  const cpuCount = new Int32Array(slots);
  const gpuSum = new Float64Array(slots);
  const gpuMax = new Float64Array(slots);
  const gpuCount = new Int32Array(slots);
  const drawSum = new Float64Array(slots);
  const drawCount = new Int32Array(slots);
  const triSum = new Float64Array(slots);
  const openAt = new Float64Array(slots);
  const openDraws = new Float64Array(slots);
  const openTris = new Float64Array(slots);
  const unbalanced = new Int32Array(slots);

  // THE OPEN STACK. Accumulation does not need it (each zone keeps its own open
  // timestamp and they nest without interacting), but GPU attribution does: when
  // three tells the inspector "a render pass just began", the only way to know
  // WHICH zone owns it is to ask which bracket is currently innermost.
  // Preallocated; nesting here is ~3 deep (pass > sub-zone).
  const openStack = new Int32Array(64);
  let stackDepth = 0;

  // WHICH SLOTS MAY LEGALLY RECEIVE A GPU TIMESTAMP (2026-08-12). Precomputed
  // once so the attribution walk below stays a typed-array read per level and
  // never touches the ZONES array (or allocates) inside a frame.
  //
  // Declared slots: 1 for kind 'gpu'/'both', 0 for 'cpu'. Pass slots (>=
  // declaredCount) are synthesized, carry no declaration, and genuinely DO own
  // GPU work — a pass row's own gpuMs is exactly the draws inside it that no
  // sub-zone bracketed. They are valid targets.
  const slotTakesGpu = new Uint8Array(slots);
  for (let i = 0; i < slots; i++) {
    slotTakesGpu[i] = i >= declaredCount || zones[i]?.kind !== 'cpu' ? 1 : 0;
  }

  // HITCH ↔ IN-FLIGHT ZONE CORRELATION. Preallocated like everything else here:
  // one Int32Array and two counters, incremented only on frames that already
  // exceeded the threshold, so the common path pays a single comparison. See
  // beginFrame for what this can and cannot observe.
  const hitchOpenZone = new Int32Array(slots);
  let hitchFrames = 0;
  let hitchThresholdMs = DEFAULT_HITCH_THRESHOLD_MS;

  // FRONT-LOADED BURST vs STEADY TAX (2026-08-12) — the residency audit's own
  // stated open question, generalised past residency to every zone: "is the
  // mean a steady cost across all occurrences, or a few expensive early ones
  // dragging the average up?" Cannot be answered from `cpuSum`/`cpuCount`
  // alone — a mean is the SAME NUMBER either way, by construction.
  //
  // ⚠️ CPU ONLY, DELIBERATELY. A CPU bracket's OPEN timestamp is right here,
  // for free, at `openSlot` — classifying it early/late costs one comparison
  // at `closeSlot`. A GPU sample has no equivalent: `recordGpuMs` fires
  // asynchronously, a frame or more after the pass was actually issued, with
  // no "when did this originate" signal available without plumbing a second
  // timestamp through `gpu-zone-timer.js`'s own pending-uid bookkeeping — a
  // real, separate change this pass does not take on. The motivating question
  // (`residency.itemLoad`) is CPU-only anyway; scope matches the ask.
  //
  // Three PARALLEL arrays, not a doubled set — `cpuSum`/`cpuCount`/`cpuMax`
  // stay exactly as they are (every existing consumer is unaffected), and
  // "late" is `total − early`, derived at report time rather than stored, so
  // this adds one comparison and three writes to the hot path, not six.
  const cpuSumEarly = new Float64Array(slots);
  const cpuMaxEarly = new Float64Array(slots);
  const cpuCountEarly = new Int32Array(slots);
  let earlyWindowMs = DEFAULT_EARLY_WINDOW_MS;

  /** passId -> slot, allocated on first sight then reused. */
  const passSlots = new Map();
  let nextPassSlot = declaredCount;
  let passSlotOverflow = 0;

  let armed = false;
  // WHO owns the current window. Two consumers arming one profiler is not a
  // hypothetical: the live HUD re-arms every 250ms to get its rolling window,
  // which resets the frame counters a profile session is simultaneously waiting
  // on. First live run, 2026-07-27: "waited 30s for 30 frames but only 4 were
  // counted", on a viewer that was rendering perfectly well at ~40fps. Guarding
  // it here rather than at one call site is what makes the collision impossible
  // rather than merely reported.
  let owner = null;
  let frames = 0;
  let settleRemaining = 0;
  let settleDiscarded = 0;
  let windowStartMs = null;
  let windowEndMs = null;
  let clockResolutionMs = null;

  // ===========================================================================
  // FRAME GAPS, OWNED HERE — because the viewer's ring is too short to profile
  // ===========================================================================
  //
  // `vt-pan-viewer.js` keeps its own `frameGapTimes` capped at 300 samples. That
  // is right for a live diagnostic and useless for a 60-second benchmark route,
  // which runs ~2,400 frames: reading it would silently describe only the last
  // 12% of the run while the report claimed the whole window. The author's ask
  // is explicitly for "the lowest, the highest and the averages rather than any
  // one moment", which is a statement about the WHOLE route.
  //
  // A preallocated Float32Array of 4,096 covers ~68s at 60fps or ~100s at 40fps
  // in one contiguous buffer — 16KB, allocated once at construction, never while
  // armed. Past that it wraps and reports `dropped`, like every other ring here.
  const gapMs = new Float32Array(GAP_CAPACITY);
  let gapCount = 0;
  let gapDropped = 0;
  let lastFrameStartMs = null;
  let readDrawCalls = null;
  let readTriangles = null;

  function reset() {
    cpuSum.fill(0);
    cpuMax.fill(0);
    cpuCount.fill(0);
    gpuSum.fill(0);
    gpuMax.fill(0);
    gpuCount.fill(0);
    drawSum.fill(0);
    drawCount.fill(0);
    triSum.fill(0);
    openAt.fill(-1);
    openDraws.fill(0);
    openTris.fill(0);
    unbalanced.fill(0);
    hitchOpenZone.fill(0);
    hitchFrames = 0;
    cpuSumEarly.fill(0);
    cpuMaxEarly.fill(0);
    cpuCountEarly.fill(0);
    stackDepth = 0;
    passSlots.clear();
    nextPassSlot = declaredCount;
    passSlotOverflow = 0;
    frames = 0;
    settleDiscarded = 0;
    windowStartMs = null;
    windowEndMs = null;
    gapCount = 0;
    gapDropped = 0;
    lastFrameStartMs = null;
  }
  reset();

  /** Slot for a pass id, allocating one on first sight. -1 once full. */
  function slotForPass(passId) {
    const existing = passSlots.get(passId);
    if (existing !== undefined) return existing;
    if (nextPassSlot >= slots) {
      passSlotOverflow++;
      return -1;
    }
    const slot = nextPassSlot++;
    passSlots.set(passId, slot);
    return slot;
  }

  // Sentinel for openAt[i]: "a begin() landed while settling". Distinct from
  // -1 (closed) and from every real timestamp (now() is never negative). See
  // openSlot/closeSlot's own comments for why this exists.
  const SETTLING = -2;

  function openSlot(i) {
    if (i < 0 || i >= slots) return;
    // Already open: a re-entrant begin (or one still pending from the settle
    // window below). Keep the FIRST open (real timestamp or SETTLING — either
    // way it is the true extent) and count the anomaly rather than silently
    // overwriting, which would under-report the zone forever after.
    if (openAt[i] !== -1) {
      unbalanced[i]++;
      return;
    }
    // NO CLOCK READ WHILE SETTLING (BUG FOUND LIVE, 2026-08-11 — a live
    // perf-run-full report showed `residency.pass`/`residency.itemLoad` each
    // unbalanced by exactly 1, on a run whose try/finally around both was
    // already correct). `perf-run-full` starts the camera path — which fires
    // real residency passes — BEFORE/WHILE the profiler is still settling
    // (runProfileSession arms with settleFrames well after playCameraPath is
    // already moving). A pass whose begin() lands during that settle window
    // used to be silently gated off entirely (this function returned without
    // touching openAt), while its own `finally { profiler.end(...) }` has no
    // way to know that — it fires whenever the pass's real async work
    // finishes, often AFTER settling completes, and found nothing open: a
    // spurious "end with no begin". The bracket was never mispaired; the
    // WINDOW moved out from under it. Recording SETTLING here (no now() call
    // — settling must stay exactly as free as disarmed) lets closeSlot
    // recognise that same story on the other end and discard silently instead
    // of flagging an anomaly that was never a renderer bug.
    if (settleRemaining > 0) {
      openAt[i] = SETTLING;
      return;
    }
    openAt[i] = now();
    if (stackDepth < openStack.length) openStack[stackDepth++] = i;
    if (readDrawCalls !== null) openDraws[i] = readDrawCalls();
    if (readTriangles !== null) openTris[i] = readTriangles();
  }

  /**
   * Remove a slot from the open stack. Normally it is the top; a zone closed
   * out of order is searched for and spliced rather than corrupting the stack,
   * because a mis-nested bracket must degrade the ATTRIBUTION of one zone, not
   * every zone after it.
   */
  function popStack(i) {
    if (stackDepth > 0 && openStack[stackDepth - 1] === i) {
      stackDepth--;
      return;
    }
    for (let k = stackDepth - 1; k >= 0; k--) {
      if (openStack[k] === i) {
        for (let j = k; j < stackDepth - 1; j++) openStack[j] = openStack[j + 1];
        stackDepth--;
        return;
      }
    }
  }

  function closeSlot(i) {
    if (i < 0 || i >= slots) return;
    const start = openAt[i];
    // An end with no begin. Counted, never silently dropped: it means a bracket
    // is mispaired somewhere, and every number for this zone is suspect.
    if (start === -1) {
      unbalanced[i]++;
      return;
    }
    openAt[i] = -1;
    // The matching begin() landed during settling and was recorded as SETTLING,
    // not a timestamp (see openSlot). This end() — whether it also happens
    // during settling or, as in the live bug, well after — closes the SAME
    // bracket the caller opened; discard it exactly like any other settle-
    // window sample, silently, with no clock read and no anomaly.
    if (start === SETTLING) return;
    const elapsed = now() - start;
    popStack(i);
    if (elapsed >= 0) {
      cpuSum[i] += elapsed;
      cpuCount[i]++;
      if (elapsed > cpuMax[i]) cpuMax[i] = elapsed;
      // Classified by when the bracket OPENED, not by when it closed — a
      // sample never gets split across both buckets. `windowStartMs` is
      // guaranteed non-null here: `start` is only a real timestamp (not the
      // SETTLING sentinel, already handled above) once settling has already
      // ended, and settling ending is exactly what sets `windowStartMs`.
      if (start < windowStartMs + earlyWindowMs) {
        cpuSumEarly[i] += elapsed;
        cpuCountEarly[i]++;
        if (elapsed > cpuMaxEarly[i]) cpuMaxEarly[i] = elapsed;
      }
    }
    if (readDrawCalls !== null) {
      const d = readDrawCalls() - openDraws[i];
      if (d >= 0) {
        drawSum[i] += d;
        drawCount[i]++;
      }
    }
    if (readTriangles !== null) {
      const tri = readTriangles() - openTris[i];
      if (tri >= 0) triSum[i] += tri;
    }
  }

  function recordGpuMs(index, ms) {
    if (!armed || index < 0 || index >= slots) return;
    if (!Number.isFinite(ms) || ms < 0) return;
    gpuSum[index] += ms;
    gpuCount[index]++;
    if (ms > gpuMax[index]) gpuMax[index] = ms;
  }

  // Built ONCE. The render loop passes this same object to runPassPlan every
  // frame; building it inline there would allocate two closures per frame.
  const passHooks = Object.freeze({
    // settleRemaining is no longer checked here — openSlot/closeSlot already
    // gate on it themselves (the SETTLING sentinel), and checking it twice
    // would re-introduce the exact boundary-straddle bug their own comments
    // describe, just for pass zones instead of declared ones.
    onPassBegin(passId) {
      if (!armed) return;
      openSlot(slotForPass(passId));
    },
    onPassEnd(passId) {
      if (!armed) return;
      closeSlot(slotForPass(passId));
    },
  });

  return {
    /**
     * @param {object} [opts]
     * @param {number} [opts.settleFrames] frames discarded before measuring
     * @param {number} [opts.clockResolutionMs] skip the probe and use this
     * @param {() => number} [opts.readDrawCalls] e.g. () => renderer.info.render.drawCalls
     * @param {() => number} [opts.readTriangles]
     */
    arm({
      settleFrames = DEFAULT_SETTLE_FRAMES,
      clockResolutionMs: injectedResolution = null,
      readDrawCalls: rdc = null,
      readTriangles: rt = null,
      owner: nextOwner = 'anonymous',
      hitchThresholdMs: hitchMs = DEFAULT_HITCH_THRESHOLD_MS,
      earlyWindowMs: earlyMs = DEFAULT_EARLY_WINDOW_MS,
    } = {}) {
      // Re-arming as the SAME owner is normal — that is how the HUD gets a
      // rolling window. Arming over somebody else's live window is the bug.
      if (armed && owner !== null && owner !== nextOwner) {
        throw new Error(
          `frame-profiler: '${nextOwner}' tried to arm while '${owner}' already owns the window. Arming resets ` +
            `every counter, so the two would silently corrupt each other's numbers — which is exactly what ` +
            `happened live on 2026-07-27 (a profile session timed out at "only 4 frames counted" because the ` +
            `live HUD was resetting the counter four times a second). Stop '${owner}' first.`
        );
      }
      owner = nextOwner;
      reset();
      readDrawCalls = typeof rdc === 'function' ? rdc : null;
      readTriangles = typeof rt === 'function' ? rt : null;
      settleRemaining = Math.max(0, settleFrames | 0);
      hitchThresholdMs = Number.isFinite(hitchMs) && hitchMs > 0 ? hitchMs : DEFAULT_HITCH_THRESHOLD_MS;
      earlyWindowMs = Number.isFinite(earlyMs) && earlyMs > 0 ? earlyMs : DEFAULT_EARLY_WINDOW_MS;
      // Measured at arm time, not assumed, and not re-measured per run — the
      // clamp is a property of the page, not of the window being measured. An
      // injected value skips the probe entirely (tests with a frozen fake clock,
      // and any caller that has already paid for the measurement).
      if (Number.isFinite(injectedResolution)) clockResolutionMs = injectedResolution;
      else if (clockResolutionMs === null) clockResolutionMs = measureClockResolution(now);
      armed = true;
    },

    disarm() {
      armed = false;
      owner = null;
      readDrawCalls = null;
      readTriangles = null;
      // Any zone still open at disarm was never closed — including one still
      // holding SETTLING (openSlot's sentinel for "begin landed during
      // settling"): closeSlot forgives THAT sentinel when a real end()
      // eventually finds it, but nothing ever came here to claim it, which is
      // a genuine mispaired bracket (a throw during settling, same as any
      // other), not the boundary artifact the sentinel exists to silence.
      // Close the books on it as an anomaly so a truncated window cannot leave
      // a stale open timestamp that poisons the NEXT run's first sample.
      for (let i = 0; i < slots; i++) {
        if (openAt[i] !== -1) {
          unbalanced[i]++;
          openAt[i] = -1;
        }
      }
      stackDepth = 0;
    },

    /**
     * The innermost currently-open zone slot, or -1. This is how GPU work gets
     * attributed: three's inspector reports "a render pass began" with no idea
     * what it is FOR, and the answer is whichever bracket is open around it.
     */
    currentSlot: () => (stackDepth > 0 ? openStack[stackDepth - 1] : -1),
    openDepth: () => stackDepth,

    /**
     * THE SLOT A GPU TIMESTAMP BELONGS TO — the innermost open zone that is
     * allowed to own GPU work, which is NOT always the innermost open zone.
     *
     * ⚠️ WHY THIS IS NOT JUST `currentSlot()` (fixed 2026-08-12, after the same
     * bug was rediscovered in three separate investigations).
     *
     * `runSceneDepthPass` opens `geometry.depthDraw` (kind 'gpu') and then, one
     * level in, `geometry.depthRenderCall` (kind 'cpu') around the actual
     * `renderer.render()` call — three CPU sub-zones added in 2026-08 to chase a
     * CPU mystery in that pass. Attribution by innermost-open therefore handed
     * the depth pass's ENTIRE GPU cost (~18ms/frame, the second largest number
     * in the whole table) to a zone declared to contain no draw calls at all,
     * while `geometry.depthDraw` — the zone that exists precisely to hold it —
     * reported `gpuMs: null` in every report ever produced. The report renders
     * that null as "measurement failed", which is the exact opposite of what
     * happened, and each investigation had to re-derive the truth from the
     * bracket nesting before it could read its own numbers.
     *
     * ⚠️ THE ATTRIBUTED TOTAL IS UNCHANGED BY THIS. Every sample still lands in
     * exactly one slot, and `computeAttribution` sums every row — so coverage,
     * the residual, and the frame total are all bit-identical to before. Only
     * the LABEL moves, from a zone that disclaims GPU work to its nearest
     * ancestor that claims it.
     *
     * FALLBACK, deliberate: if no GPU-capable ancestor is open at all, this
     * returns the innermost slot exactly as before rather than -1. Dropping the
     * sample would silently shrink coverage — losing real measured GPU time to
     * make a label tidy — which is the trade this file never makes. The
     * mislabelled row is then caught loudly at the report layer
     * (`zone-kind-contradiction`), which names the zone instead of leaving a
     * bare counter.
     */
    gpuTargetSlot: () => {
      for (let d = stackDepth - 1; d >= 0; d--) {
        const slot = openStack[d];
        if (slotTakesGpu[slot]) return slot;
      }
      return stackDepth > 0 ? openStack[stackDepth - 1] : -1;
    },

    isArmed: () => armed,
    /** Who owns the live window, or null. Callers guard on this BEFORE arming. */
    owner: () => owner,
    /** True only once settling is done — the caller may want to show progress. */
    isMeasuring: () => armed && settleRemaining === 0,
    settleRemaining: () => settleRemaining,

    /** Zone index for a declared id, or -1. Resolve ONCE, outside the loop. */
    indexOf: (id) => zoneIndexOf(id),

    // settleRemaining is checked INSIDE openSlot/closeSlot, not here — see
    // their own comments (frame-profiler's SETTLING sentinel). Gating it here
    // too would independently re-decide "are we settling?" at begin time vs
    // end time, which is exactly what let a pass that starts mid-settle and
    // finishes after report a false unbalanced bracket.
    begin(index) {
      if (!armed) return;
      openSlot(index);
    },
    end(index) {
      if (!armed) return;
      closeSlot(index);
    },
    /** Convenience for cold call sites; prefer the integer form in the loop. */
    beginById(id) {
      if (!armed) return;
      openSlot(zoneIndexOf(id));
    },
    endById(id) {
      if (!armed) return;
      closeSlot(zoneIndexOf(id));
    },

    passHooks,

    /**
     * Fold in a GPU duration measured elsewhere (timestamp queries resolve a
     * frame or more late, so they cannot be recorded inside the bracket).
     */
    // Plain functions, not methods calling `this` — every one of these is
    // destructured at a call site somewhere, and a `this`-dependent method that
    // silently no-ops when detached is exactly the kind of quiet failure an
    // instrument must not have.
    noteGpuMs: recordGpuMs,
    noteGpuMsForPass(passId, ms) {
      if (!armed) return;
      recordGpuMs(slotForPass(passId), ms);
    },

    beginFrame(nowMs) {
      if (!armed) return;
      const t = nowMs ?? now();
      if (windowStartMs === null && settleRemaining === 0) windowStartMs = t;
      // The gap since the PREVIOUS frame actually started — the felt cadence,
      // which is what a person perceives as the frame rate. Recorded before any
      // work this frame, and only once settling is done.
      if (settleRemaining === 0 && lastFrameStartMs !== null) {
        const gap = t - lastFrameStartMs;
        if (gap > 0 && Number.isFinite(gap)) {
          if (gapCount < GAP_CAPACITY) gapMs[gapCount++] = gap;
          else gapDropped++;
          // WHAT WAS STILL RUNNING WHEN THE FRAME HUNG? (2026-08-12)
          //
          // This is the ONLY point in the codebase where the frame gap and the
          // open-zone stack are both in scope, which is why the correlation
          // lives here rather than beside the viewer's own hitch log.
          //
          // ⚠️ READ WHAT THIS CAN AND CANNOT SEE. By the time frame N's gap is
          // known — at the START of frame N+1 — every render-loop zone from
          // frame N has already closed. So `stackDepth` here is normally 0, and
          // the only zones this can ever catch open are the ones that genuinely
          // SPAN frames: the `cadence:'event'` residency brackets, which suspend
          // across real `await`s while the render loop keeps ticking
          // independently (scheduleResidencyUpdate is fire-and-forget).
          //
          // That narrowness is the entire point. The 2026-08-11 residency audit
          // closed with a named, unresolved mystery: 20 hitches of 250-667ms
          // whose decode/cache stats showed ZERO I/O activity, with no mechanism
          // found and the honest note that resolving it "needs a live Chrome
          // trace correlated against hitchLog timestamps and residency in-flight
          // windows". This is that correlation, computed in-process, for free,
          // on every run — no trace, no manual timestamp alignment.
          //
          // A high count here says the freezes land while residency is
          // mid-flight (not proof of cause, but the first real evidence either
          // way). A count of zero rules that out and sends the next
          // investigation somewhere else — which is worth just as much and is
          // what the audit could not establish at all.
          if (gap > hitchThresholdMs) {
            hitchFrames++;
            for (let d = 0; d < stackDepth; d++) hitchOpenZone[openStack[d]]++;
          }
        }
      }
      lastFrameStartMs = t;
    },
    endFrame(nowMs) {
      if (!armed) return;
      if (settleRemaining > 0) {
        settleRemaining--;
        settleDiscarded++;
        // The window starts the moment settling ends, not when arm() was called.
        if (settleRemaining === 0) windowStartMs = nowMs ?? now();
        return;
      }
      frames++;
      windowEndMs = nowMs ?? now();
    },

    /** Allocates — called once, after the window closes. */
    snapshot() {
      const zoneStats = [];
      for (let i = 0; i < slots; i++) {
        if (cpuCount[i] === 0 && gpuCount[i] === 0 && unbalanced[i] === 0) continue;
        zoneStats.push({
          id: i < declaredCount ? zones[i].id : `${PASS_ZONE_PREFIX}${passIdForSlot(i)}`,
          cpu: cpuCount[i] > 0 ? { sumMs: cpuSum[i], count: cpuCount[i], maxMs: cpuMax[i] } : null,
          // The EARLY-only slice of the same CPU cost, for the front-loaded-
          // burst-vs-steady-tax split (perf-report.js#classifyTemporalShape).
          // `null`, never a zero block, when nothing in this zone opened during
          // the early window — that is a real "none of it was early" result,
          // not an absence, and `statFrom` already knows the difference.
          cpuEarly:
            cpuCountEarly[i] > 0 ? { sumMs: cpuSumEarly[i], count: cpuCountEarly[i], maxMs: cpuMaxEarly[i] } : null,
          gpu: gpuCount[i] > 0 ? { sumMs: gpuSum[i], count: gpuCount[i], maxMs: gpuMax[i] } : null,
          drawCalls: drawCount[i] > 0 ? { sum: drawSum[i], count: drawCount[i] } : null,
          triangles: drawCount[i] > 0 ? { sum: triSum[i], count: drawCount[i] } : null,
          unbalanced: unbalanced[i],
        });
      }
      const totalUnbalanced = zoneStats.reduce((a, z) => a + z.unbalanced, 0);
      return {
        // A plain copy, so the caller can sort/percentile it without touching
        // the live buffer. Only allocates at SNAPSHOT time, never while armed.
        gapSamples: Array.prototype.slice.call(gapMs.subarray(0, gapCount)),
        gapDropped,
        gapCapacity: GAP_CAPACITY,
        frames,
        durationMs: windowStartMs === null || windowEndMs === null ? null : windowEndMs - windowStartMs,
        settleFramesDiscarded: settleDiscarded,
        clockResolutionMs,
        // What "early" meant for THIS window — echoed, not assumed, so the
        // report layer never has to guess what threshold produced its numbers.
        earlyWindowMs,
        zoneStats,
        // WHICH ZONES WERE MID-FLIGHT WHEN A FRAME HUNG (2026-08-12). See
        // beginFrame for what this can and cannot observe — in short, only zones
        // that genuinely span frames (the async residency brackets) can ever
        // appear here, which is exactly the question the 2026-08-11 audit closed
        // unable to answer.
        //
        // `zones` is emitted only for slots with a nonzero count, so an empty
        // object beside a nonzero `frames` is a REAL result — "no zone was open
        // during any hitch" — not a gap. That is why `frames` ships alongside
        // it: without the denominator, empty would be ambiguous.
        hitchZones: (() => {
          const z = {};
          for (let i = 0; i < slots; i++) {
            if (hitchOpenZone[i] > 0) {
              z[i < declaredCount ? zones[i].id : `${PASS_ZONE_PREFIX}${passIdForSlot(i)}`] = hitchOpenZone[i];
            }
          }
          return { thresholdMs: hitchThresholdMs, frames: hitchFrames, zones: z };
        })(),
        anomalies: {
          unbalancedBrackets: totalUnbalanced,
          passSlotOverflow,
          note:
            totalUnbalanced > 0 || passSlotOverflow > 0
              ? 'Mispaired begin/end brackets or exhausted pass slots were detected. The affected zones are counted, ' +
                'not silently dropped — treat their numbers as suspect and fix the bracket before trusting them.'
              : null,
        },
      };
    },

    /** For tests and the HUD: raw slot capacity, so overflow is inspectable. */
    capacity: () => ({ slots, declaredCount, passSlotsUsed: passSlots.size }),
  };

  function passIdForSlot(slot) {
    for (const [id, s] of passSlots) if (s === slot) return id;
    return `unknown-slot-${slot}`;
  }
}

function defaultNow() {
  return performance.now();
}
