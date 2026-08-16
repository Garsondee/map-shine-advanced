/**
 * SCENE READINESS — "is everything actually on screen yet, and is it safe to
 * play?", answered with outstanding-work counters instead of a stopwatch.
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
 * THE RULE — four criteria, 2026-08-15 (was three)
 * ============================================================================
 * The scene is SETTLED when every counted piece of outstanding work reads zero
 * AND has read zero continuously for `quietMs` AND real frames have rendered
 * during that quiet window AND nothing during that window betrayed work the
 * counters cannot see. All four matter:
 *   - zero work, because a stopwatch cannot know what is still queued;
 *   - HELD for a period, because these counters dip through zero between
 *     stages (one item finishes decoding a beat before the next is requested,
 *     and a naive reader calls that "done" — the same premature-completion bug
 *     one level down);
 *   - frames advancing, because a paused/backgrounded renderer has zero work
 *     outstanding forever and is the opposite of settled (this project has
 *     already been bitten by a non-compositing window parking a load in the
 *     `firstFrame` phase — see the live-harness memory's trap 5);
 *   - **no late evidence**, because the two most expensive things left in a
 *     cold load are invisible to every counter: a GPU pipeline compiling on
 *     its first draw, and the frame-time hitch that compile causes.
 *
 * The author's requirement is not "the bytes arrived", it is *"FPS is safe for
 * playing"*. Zero outstanding work does not prove that and never did. The two
 * evidence criteria below are what close the gap.
 *
 * ============================================================================
 * WHY EVIDENCE RESTARTS THE CLOCK RATHER THAN FAILING SEPARATELY
 * ============================================================================
 * A pipeline compile or a 200 ms hitch is not a queue depth — there is nothing
 * to poll to zero, only a thing that just happened. So they are supplied as
 * *deltas since the previous sample* and they RESTART the quiet clock, exactly
 * as reappearing work does. That gives one uniform meaning to "quiet": nothing
 * outstanding and nothing surprising, held. A separate pass/fail flag would let
 * a scene report settled one sample after a 400 ms stall, which is precisely
 * the premature-completion shape this module exists to refuse.
 *
 * ============================================================================
 * NO FOURTH VOTE ON WHAT A HITCH IS
 * ============================================================================
 * `hitchMs` is an INPUT with no default. 50 ms is already declared three times
 * in this codebase (`vt-pan-viewer.js`, `diag/flight-recorder.js`,
 * `diag/frame-profiler.js`) and flight-recorder's own header already names that
 * as a `feedback_probed_constants_vs_derived` problem to be fixed at the
 * source, not papered over. Defaulting here would cast a fourth independent
 * vote for the same number. Instead the caller hands in the threshold it is
 * already using against the very gap array it is already keeping — the two that
 * must agree are then the same value, not two values that happen to match.
 *
 * Omitting it does not silently disable the check: the criterion reports
 * `unavailable`, which is a measurement, not a pass (`feedback_absent_zone_row_
 * is_a_measurement`).
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
 * Where a probe sits in the loading chain. Ordering is not cosmetic: the first
 * non-zero blocker is what a stuck load gets diagnosed by, so it must name the
 * EARLIEST stage still busy, not whichever subsystem happened to register first.
 *
 * A new effect picks a stage — a statement about what kind of work it is — and
 * never a magic number, so two subsystems added a year apart still sort into a
 * chain a human can read top to bottom.
 */
export const READINESS_STAGE = Object.freeze({
  /** Fetch / decode / compress — the front of the chain, and the slow part. */
  STREAM: 10,
  /** GPU upload, residency, mesh construction. */
  UPLOAD: 20,
  /** One-time per-effect bakes (masks, island packs, LUTs, wind fields). */
  BAKE: 30,
  /** Shader/pipeline compilation. */
  COMPILE: 40,
  /** Frame-time steadiness — the last thing to be true. */
  STEADY: 50,
});

/**
 * The built-in VT streaming work counters, in the order a reader most wants to
 * see them.
 *
 * These are no longer THE list — they are the seed set the registry installs
 * for the streaming core (see {@link createReadinessRegistry}). Everything else
 * registers itself next to its own code, because a central hand-kept list of
 * "things that count as work" is precisely the shape that has already lost six
 * effects from `EFFECT_REAPPLIERS` and one counter from this very array
 * (`maskPagesPending`, declared here for months while nothing supplied it).
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
 * reports `unavailable` separately for that; see {@link createReadinessRegistry}).
 *
 * @param {Record<string, number|boolean>} raw
 * @param {ReadonlyArray<{key:string,label:string}>} [keys] - the descriptors to
 *   read, in report order. Defaults to the built-in streaming set so every
 *   existing caller keeps working unchanged; the registry passes its own.
 * @returns {{blockers: Array<{key:string,label:string,count:number}>, totalOutstanding:number}}
 */
export function summarizeSettleWork(raw, keys = SETTLE_WORK_KEYS) {
  const blockers = [];
  let totalOutstanding = 0;
  for (const { key, label } of keys) {
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
 * A registry of readiness probes.
 *
 * A FACTORY, NOT A SINGLETON — the same call `src/effects/registry.js` makes
 * and for the same reason. A module-level registry would be a global in a file
 * whose entire discipline is "no globals, no clock", and it would make two
 * tests in one process share state. The composition root creates one and hands
 * it to the subsystems it builds.
 *
 * ## Polling, not tickets
 *
 * `read()` returns the CURRENT outstanding count. There is deliberately no
 * `beginWork()`/`endWork()` pair: a ticket that is never returned (an early
 * `return`, a thrown error, a cancelled floor switch) wedges the scene forever,
 * and that failure is silent until someone waits twenty minutes. A poll of
 * state that already exists cannot leak.
 *
 * ## A probe that throws is `unavailable`, not zero, and does not block
 *
 * Stated plainly because it is a real trade-off, not an oversight. Reading a
 * broken probe as zero would be the instrument lying (`feedback_instruments_
 * must_not_lie`). Reading it as a blocker would be fail-closed — correct in
 * principle, except that floor changes now hold the previous floor on screen
 * indefinitely rather than raising a curtain, so one permanently-throwing probe
 * would wedge a floor switch forever with no way out. So it is reported by name
 * in `unavailable[]` — which rides into the curtain's detail line and the perf
 * report — and readiness proceeds without it. The loud gate against a MISSING
 * probe is manifest validation plus its Node test, which fire in CI rather than
 * in a GM's session.
 *
 * @param {object} [opts]
 * @param {ReadonlyArray<{key:string,label:string}>} [opts.builtinKeys] - seed
 *   descriptors registered at STREAM/UPLOAD stage order, defaulting to the VT
 *   streaming set. Pass `[]` for a registry with nothing pre-installed.
 */
export function createReadinessRegistry({ builtinKeys = SETTLE_WORK_KEYS } = {}) {
  /** @type {Map<string, {id:string,label:string,stage:number,seq:number,read:Function|null}>} */
  const probes = new Map();
  let seq = 0;

  /**
   * Register a probe. Throws on a duplicate id or a malformed descriptor —
   * loudly, at the call site, during boot, rather than producing a registry
   * that quietly under-reports for the rest of the session.
   *
   * @param {object} p
   * @param {string} p.id - stable, unique. Appears in the perf report.
   * @param {string} p.label - the sentence a human reads when this is what the
   *   load is stuck on. Written for 3 a.m., not for a dashboard.
   * @param {() => number|boolean} p.read - current outstanding count.
   * @param {number} [p.stage] - see {@link READINESS_STAGE}.
   */
  function register({ id, label, read, stage = READINESS_STAGE.BAKE } = {}) {
    if (typeof id !== 'string' || !id) throw new Error('readiness probe needs a non-empty string id');
    if (typeof label !== 'string' || label.length < 6) {
      throw new Error(`readiness probe "${id}" needs a human label (a real sentence, not a key name)`);
    }
    if (typeof read !== 'function') throw new Error(`readiness probe "${id}" needs a read() function`);
    if (probes.has(id)) throw new Error(`readiness probe "${id}" is already registered`);
    probes.set(id, { id, label, stage: Number(stage) || 0, seq: seq++, read });
    return id;
  }

  /** Remove a probe — for a subsystem that genuinely goes away (teardown). */
  function unregister(id) {
    return probes.delete(id);
  }

  /** Descriptors in report order: chain stage first, registration order within a stage. */
  function list() {
    return [...probes.values()].sort((a, b) => a.stage - b.stage || a.seq - b.seq);
  }

  /**
   * Poll every probe.
   * @returns {{raw: Record<string, number>, keys: Array<{key:string,label:string}>,
   *            unavailable: Array<{id:string, error:string}>}}
   */
  function collect() {
    const raw = {};
    const keys = [];
    const unavailable = [];
    for (const p of list()) {
      keys.push({ key: p.id, label: p.label });
      try {
        const v = p.read();
        raw[p.id] = v === true ? 1 : v === false || v == null ? 0 : Number(v) || 0;
      } catch (err) {
        unavailable.push({ id: p.id, error: String(err?.message || err) });
      }
    }
    return { raw, keys, unavailable };
  }

  for (const { key, label } of builtinKeys) {
    register({ id: key, label, stage: READINESS_STAGE.STREAM, read: () => 0 });
  }

  /**
   * Re-point a built-in probe at its real source once the subsystem that owns
   * it exists. The seed probes above read zero so the registry is well-formed
   * from the first frame; this is how they stop being placeholders.
   */
  function bind(id, read) {
    const p = probes.get(id);
    if (!p) throw new Error(`cannot bind unknown readiness probe "${id}"`);
    if (typeof read !== 'function') throw new Error(`readiness probe "${id}" needs a read() function`);
    p.read = read;
    return id;
  }

  return {
    register,
    unregister,
    bind,
    list,
    collect,
    has: (id) => probes.has(id),
    get size() {
      return probes.size;
    },
  };
}

/**
 * A settle tracker. Feed it samples; ask it whether the scene has settled.
 *
 * @param {object} [opts]
 * @param {number} [opts.quietMs] - how long work must stay at zero.
 * @param {number} [opts.minFrames=2] - frames that must render during the
 *   quiet window before it counts (a still renderer is not a settled one).
 * @param {number|null} [opts.hitchMs=null] - what counts as a frame-time hitch.
 *   NO DEFAULT ON PURPOSE — see this module's header. Omitted means the
 *   steadiness criterion reports `unavailable` rather than silently passing.
 * @returns {{sample: Function, read: Function, reset: Function}}
 */
export function createSettleTracker({ quietMs = DEFAULT_SETTLE_QUIET_MS, minFrames = 2, hitchMs = null } = {}) {
  const hitchThresholdMs = Number.isFinite(hitchMs) && hitchMs > 0 ? hitchMs : null;
  let quietSinceMs = null;
  let framesAtQuietStart = 0;
  let lastPipelineCompiles = null;
  let last = null;

  /**
   * @param {Record<string, number|boolean>} raw - outstanding-work counts.
   * @param {number} nowMs
   * @param {number} [frameCount] - a monotonically increasing frame counter.
   * @param {object} [evidence] - things that HAPPENED rather than things queued.
   * @param {number|null} [evidence.maxFrameGapMs] - the worst frame gap seen
   *   SINCE THE PREVIOUS SAMPLE. Not an all-time worst: an all-time worst never
   *   decays, so one early hitch would make the scene permanently unsettleable.
   * @param {number|null} [evidence.pipelineCompileCount] - a CUMULATIVE count of
   *   GPU pipeline compiles. The tracker diffs it; the caller does not have to
   *   remember anything.
   * @param {ReadonlyArray<{key:string,label:string}>} [evidence.keys] - the
   *   descriptor list for `raw` (the registry's). Defaults to the built-ins.
   * @param {Array<{id:string,error:string}>} [evidence.unavailable] - probes
   *   that could not be read at all, carried through to the report.
   */
  function sample(raw, nowMs, frameCount = 0, evidence = {}) {
    const {
      maxFrameGapMs = null,
      pipelineCompileCount = null,
      keys = SETTLE_WORK_KEYS,
      unavailable = [],
    } = evidence ?? {};

    const { blockers, totalOutstanding } = summarizeSettleWork(raw, keys);

    // --- the two evidence criteria ------------------------------------------
    // Both are deltas over the interval that just elapsed, and both restart the
    // clock rather than merely failing, so "quiet" keeps one meaning.
    const steadinessAvailable = hitchThresholdMs !== null && Number.isFinite(maxFrameGapMs);
    const hitched = steadinessAvailable && maxFrameGapMs >= hitchThresholdMs;

    const pipelinesAvailable = Number.isFinite(pipelineCompileCount);
    // A first reading establishes the baseline and can never itself be a delta —
    // otherwise the very first sample of a session would count every pipeline
    // compiled during startup as "just happened" and refuse to settle.
    const compiledDelta =
      pipelinesAvailable && lastPipelineCompiles !== null
        ? Math.max(0, pipelineCompileCount - lastPipelineCompiles)
        : 0;
    if (pipelinesAvailable) lastPipelineCompiles = pipelineCompileCount;

    const evidenceBlockers = [];
    if (hitched) {
      evidenceBlockers.push({
        key: 'frameTimeSteadiness',
        label: 'frame time not steady yet',
        count: Math.round(maxFrameGapMs),
      });
    }
    if (compiledDelta > 0) {
      evidenceBlockers.push({
        key: 'pipelineCompiles',
        label: 'GPU shader pipelines still compiling',
        count: compiledDelta,
      });
    }

    const disturbed = totalOutstanding > 0 || evidenceBlockers.length > 0;
    if (disturbed) {
      // Anything outstanding OR anything surprising restarts the clock — never
      // "mostly quiet".
      quietSinceMs = null;
      framesAtQuietStart = frameCount;
    } else if (quietSinceMs === null) {
      quietSinceMs = nowMs;
      framesAtQuietStart = frameCount;
    }

    const quietForMs = quietSinceMs === null ? 0 : Math.max(0, nowMs - quietSinceMs);
    const framesSinceQuiet = Math.max(0, frameCount - framesAtQuietStart);
    const quietElapsed = quietSinceMs !== null && quietForMs >= quietMs;
    const framesAdvanced = framesSinceQuiet >= minFrames;
    const settled = quietElapsed && framesAdvanced;

    const allBlockers = [...blockers, ...evidenceBlockers];

    last = {
      settled,
      quietForMs,
      framesSinceQuiet,
      blockers: allBlockers,
      totalOutstanding,
      // Which criteria actually got evaluated, so a reader can tell "passed"
      // from "never measured" (`feedback_absent_zone_row_is_a_measurement`).
      // A missing hitch threshold or pipeline counter reads `unavailable`, never
      // a quiet pass.
      criteria: {
        work: totalOutstanding > 0 ? 'blocked' : 'pass',
        quiet: quietElapsed ? 'pass' : 'blocked',
        frames: framesAdvanced ? 'pass' : 'blocked',
        steadiness: !steadinessAvailable ? 'unavailable' : hitched ? 'blocked' : 'pass',
        pipelines: !pipelinesAvailable ? 'unavailable' : compiledDelta > 0 ? 'blocked' : 'pass',
      },
      // Probes that threw. Named, never counted — see createReadinessRegistry.
      unavailable,
      // Named so a caller that times out can say what it was waiting FOR,
      // rather than only how long it waited.
      // Order matters, and it is not cosmetic: during the ordinary quiet dwell
      // BOTH "time not yet elapsed" and "no frames since quiet began" are
      // momentarily true, and blaming the renderer there would send a reader
      // hunting a compositing bug that does not exist. The renderer is only
      // named once the time requirement is satisfied and frames STILL have not
      // arrived — which is the genuine "this window is not drawing" case.
      waitingFor: allBlockers.length
        ? allBlockers.map((b) => `${b.label} (${b.count})`)
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
      // The pipeline baseline is deliberately KEPT across a reset. It is a
      // property of the GPU device for the whole session, not of this settle
      // epoch — clearing it would make the first sample after every floor
      // switch re-establish a baseline and therefore be blind to a compile that
      // happened during exactly the window the switch cares about.
      last = null;
    },
  };
}
