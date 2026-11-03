/**
 * vt/pipeline-governor.js — EVERY PIPELINE COMPILE, NAMED, TIMED, AND KEPT OFF THE GPU'S MAIN THREAD
 * WHEN IT IS BIG (2026-10-27, epic mmp-fpu).
 *
 * ============================================================================
 * WHAT IT DOES
 * ============================================================================
 * It wraps the ONE function through which three's WebGPU backend creates a render
 * pipeline (`backend.pipelineUtils.createRenderPipeline`) and does three things:
 *
 *   1. DECIDES, per pipeline, whether to create it asynchronously
 *      (`core/compile-policy.js`). An async pipeline compiles on a worker thread, so
 *      no single shader — however large it grows — can block the GPU process past
 *      its watchdog. three already skips drawing an object whose pipeline is not
 *      ready, so the cost is a few frames of that one object not being drawn.
 *   2. WRITES THE COMPILE TO THE CRASH BREADCRUMBS before it starts
 *      (`diag/crash-guard.js`). When the GPU process dies mid-compile it takes the
 *      evidence with it; this is how the next load can say "it died compiling
 *      THIS", with the shader's size, instead of a guess.
 *   3. COUNTS: how many pipelines, how big, how long, which were deferred — the
 *      report that was missing when every diagnosis of the crash was a theory.
 *
 * ## What it does NOT do
 *
 * It does not queue or reorder creation. The descriptor is built from the render
 * object's CURRENT state at the moment three asks, and a deferred creation that
 * waited in a queue would build it later from state that may have moved on —
 * leaving a cache entry that never becomes a pipeline. Asking Dawn for the async
 * pipeline immediately sidesteps that whole class: Dawn owns the worker pool.
 *
 * ## Blocking mode
 *
 * The floor-prepare warm-up is deliberately one synchronous block with no `await`
 * (`vt-pan-viewer.js`, "SAFE BECAUSE IT IS ONE SYNCHRONOUS BLOCK"). Inside
 * `governor.blocking(fn)` pipelines are created the old way, so that block's
 * guarantee — everything it drew is compiled when it returns — holds for every
 * ordinary pipeline. The exception is a HEAVY one (`HEAVY_PIPELINE_CHARS`): water
 * at its upper tiers is three pipelines of 130-160k characters that took 12-16 s
 * each to compile cold, so a floor that first introduces water would otherwise be
 * the same crash again, reached by a different door. That pipeline compiles on a
 * worker thread and the water appears when it is ready.
 *
 * ## The per-task budget
 *
 * A pipeline that is small enough to compile synchronously is still part of a
 * burst. The commands of one JS task reach the GPU process together and run as ONE
 * task there, so what the watchdog sees is the SUM of every synchronous compile in
 * the burst, not the largest. `SYNC_CHARS_PER_TASK` caps that sum: once a task has
 * spent it, every further pipeline in the same task is created asynchronously
 * instead (a one-shot `sync-only` pass is the one thing never converted, but it
 * counts). The cap is in characters because that is what is known before the
 * compile; on the dev machine 80,000 of them is about 3 s, which leaves a slower
 * GPU several times that before 15 s.
 *
 * The wrapper touches nothing of three's but that one function; if the renderer's
 * shape is not what this was written against, it installs nothing and says so.
 *
 * @module vt/pipeline-governor
 */

import { createLogger } from '../core/log.js';
import { perfNowMs } from '../core/frame-clock.js';
import { compilePolicyFor, HEAVY_PIPELINE_CHARS } from '../core/compile-policy.js';
import { layoutLeaks } from '../core/tsl-fn.js';

const log = createLogger('pipeline-governor');

/** A compile slower than this is worth a warning with its name on it. */
export const SLOW_COMPILE_MS = 2_500;
/**
 * The most generated shader a single JS task may compile SYNCHRONOUSLY. Measured: about 0.04 ms per character
 * for ordinary shaders on the dev machine, so this is about 3 s there. See the module header.
 */
export const SYNC_CHARS_PER_TASK = 80_000;
/** Records kept for the report (the biggest are what matters, the rest are noise). */
const MAX_RECORDS = 400;

/**
 * A short, stable fingerprint of a shader's text — enough to tell two materials with the same name apart
 * in a log, cheap enough to run on every creation (it samples).
 * @param {string} text @returns {string} 6 hex chars
 */
export function fingerprint(text) {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(text.length / 4096));
  for (let i = 0; i < text.length; i += step) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

/**
 * HOW MUCH OF A SHADER IS ITS OWN CODE AGAIN (2026-11-03, epic mmp-8gf.1). TSL pastes a helper's body at every
 * call and re-emits a conditional's operands in each branch (`core/tsl-fn.js`), so a shader can grow 2-5x with no
 * one writing more code: the fly kernel was 391k chars, 81% of its lines repeats. This is the share of the
 * shader's statements (variable numbers and literals blanked, so `nodeVar12 = a * 2.0` and `nodeVar98 = a * 3.0`
 * read alike) that are repeats of an earlier one. Calibrated on one Big Bank load (2026-11-03): healthy shaders
 * read 0.2-0.8 (blanking makes many taps alike); the three blow-ups read 0.89 (window rain, 169k), 0.97
 * (fireflies, 255k) and 0.98 (flies, 391k), and 0.47-0.80 once fixed. Warned at {@link REPEAT_SHARE_WARN} on a
 * heavy shader only. Measured at {@link REPEAT_SCAN_MIN_CHARS} or more (a text scan: ~1-2 ms per 100k chars).
 * @param {string} code @returns {number} 0..1
 */
export function repeatShare(code) {
  const seen = new Set();
  let total = 0;
  let repeats = 0;
  const start = code.search(/@(fragment|vertex|compute)/);
  for (const raw of code.slice(Math.max(0, start)).split('\n')) {
    const l = raw.trim();
    if (l.length < 12 || l.startsWith('var') || l.startsWith('}')) continue;
    const key = l
      .replace(/nodeVar\d+/g, 'v')
      .replace(/nodeUniform\d+/g, 'u')
      .replace(/\b\d+(\.\d+)?(e[-+]?\d+)?u?\b/g, '0');
    total++;
    if (seen.has(key)) repeats++;
    else seen.add(key);
  }
  return total ? repeats / total : 0;
}
export const REPEAT_SCAN_MIN_CHARS = 20_000;
export const REPEAT_SHARE_WARN = 0.85;

/** Frames that are never the answer to "who drew this": three itself, this file, the diag probes that wrap three. */
const SITE_SKIP = /three\.webgpu|pipeline-governor|pipeline-rebuild-probe|shader-rebuild-probe|run-frame\.js/;

/**
 * THE MSA FUNCTION THAT ASKED FOR A PIPELINE, from a stack (2026-11-02, the author: "improving our recording
 * of loading times and shader compilation"). Almost no material is named, so the census used to read
 * `NodeMaterial#ed0f64 290700ch` — a 13 s compile nobody could find. The first frame under `src/` that is not
 * three or a probe is the pass that drew it (`runLightAccumulatePass`, `bakeSunShadowField`, ...).
 * @param {string} stack - an `Error().stack`. @returns {string|null} `functionName` or `file:line`.
 */
export function callerSite(stack) {
  for (const raw of String(stack ?? '').split('\n')) {
    const line = raw.trim();
    if (!/\/src\//.test(line) || SITE_SKIP.test(line)) continue;
    const named = /^at (?:async )?(?:Object\.|Animation\.)?([\w$.]+?)(?: \[as [^\]]+\])? \(/.exec(line);
    if (named && named[1] !== 'Object' && named[1] !== 'new') return named[1];
    const file = /\/src\/([^?:)]+)(?:\?[^:)]*)?:(\d+)/.exec(line);
    if (file) return `${file[1].split('/').pop()}:${file[2]}`;
  }
  return null;
}

/** The one-line reason a material was given a compile policy (`markCompileDeferrable(m, 'candle flame')`). */
function policyName(material) {
  const ud = material?.userData;
  for (const k of ['msaDeferCompile', 'msaSyncCompile']) if (typeof ud?.[k] === 'string' && ud[k]) return ud[k];
  return null;
}

/**
 * What to call a pipeline in a log, and how big it is: the material's own name, else the name its compile
 * policy was given, else the MSA function that drew it (`site`, see {@link callerSite}), else its type.
 * @param {any} renderObject @param {string|null} [site] @returns {{label: string, chars: number}}
 */
export function describePipeline(renderObject, site = null) {
  const pipeline = renderObject?.pipeline;
  const vs = pipeline?.vertexProgram?.code;
  const fs = pipeline?.fragmentProgram?.code;
  const vertex = typeof vs === 'string' ? vs : '';
  const fragment = typeof fs === 'string' ? fs : '';
  const material = renderObject?.material;
  const name =
    material?.name || policyName(material) || site || renderObject?.object?.name || material?.type || 'pipeline';
  return { label: `${name}#${fingerprint(vertex + fragment)}`, chars: vertex.length + fragment.length };
}

/**
 * How long the GPU had at least one compile running, and how many ran at once at worst (2026-11-02). Per-pipeline
 * `ms` overlap one another — twenty pipelines that each "took 7 s" were one 7 s window — so neither their sum nor
 * their max is the cost of a load. The union of the intervals is.
 * @param {ReadonlyArray<{startMs: number, endMs: number}>} records
 * @returns {{busyMs: number, spanMs: number, peakConcurrent: number}}
 */
export function compileBusy(records) {
  const iv = (records ?? [])
    .filter((r) => Number.isFinite(r?.startMs) && Number.isFinite(r?.endMs) && r.endMs >= r.startMs)
    .map((r) => [r.startMs, r.endMs])
    .sort((a, b) => a[0] - b[0]);
  if (iv.length === 0) return { busyMs: 0, spanMs: 0, peakConcurrent: 0 };
  let busy = 0;
  let [s, e] = iv[0];
  for (const [a, b] of iv.slice(1)) {
    if (a > e) {
      busy += e - s;
      [s, e] = [a, b];
    } else if (b > e) e = b;
  }
  busy += e - s;
  const edges = iv.flatMap(([a, b]) => [
    [a, 1],
    [b, -1],
  ]);
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let live = 0;
  let peak = 0;
  for (const [, d] of edges) peak = Math.max(peak, (live += d));
  return {
    busyMs: Math.round(busy),
    spanMs: Math.round(Math.max(...iv.map((x) => x[1])) - iv[0][0]),
    peakConcurrent: peak,
  };
}

/**
 * Tracks what is in flight, and answers "is everything done?". Pure bookkeeping.
 * @param {{now?: () => number}} [deps]
 */
export function createInFlightTracker({ now = perfNowMs } = {}) {
  /** @type {Map<string, {label: string, chars: number, mode: string, reason: string, startedAt: number}>} */
  const live = new Map();
  /** @type {Array<() => void>} */
  let waiters = [];
  const records = [];
  let completed = 0;
  let failed = 0;

  function settleWaiters() {
    if (live.size > 0) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  }

  return {
    begin(id, info) {
      live.set(id, { ...info, startedAt: now() });
    },
    /** A compile that is already over (compute pipelines are created synchronously and not governed). */
    note(info, ms) {
      const t = now();
      completed++;
      records.push({ ...info, ms: Math.round(ms), failed: false, startMs: Math.round(t - ms), endMs: Math.round(t) });
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
    },
    /** @param {string} id @param {Error|null} [error] @returns {{ms: number}|null} */
    end(id, error = null) {
      const entry = live.get(id);
      if (!entry) return null;
      live.delete(id);
      const endedAt = now();
      const ms = Math.round(endedAt - entry.startedAt);
      if (error) failed++;
      else completed++;
      records.push({
        label: entry.label,
        chars: entry.chars,
        mode: entry.mode,
        reason: entry.reason,
        ms,
        failed: !!error,
        // WHEN, not just how long — `compileBusy` needs the intervals (2026-11-02).
        startMs: Math.round(entry.startedAt),
        endMs: Math.round(endedAt),
      });
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
      settleWaiters();
      return { ms };
    },
    inFlight: () => live.size,
    /** Resolves when nothing is compiling. Never rejects; resolves immediately when already idle. */
    idle: () => (live.size === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))),
    snapshot: () => [...live.values()].map((e) => ({ label: e.label, chars: e.chars, mode: e.mode })),
    records: () => records.slice(),
    counts: () => ({ completed, failed }),
  };
}

/**
 * @param {object} deps
 * @param {any} deps.renderer - a three WebGPURenderer, initialised.
 * @param {{noteCompileStart?: Function, noteCompileEnd?: Function}|null} [deps.guard] - the crash ladder's memory.
 * @param {() => number} [deps.now]
 * @returns the governor.
 */
export function createPipelineGovernor({ renderer, guard = null, now = perfNowMs }) {
  const tracker = createInFlightTracker({ now });
  const stats = {
    installed: false,
    reason: '',
    created: 0,
    sync: 0,
    async: 0,
    deferred: 0,
    compileAsync: 0,
    overBudget: 0,
    heavyInBlocking: 0,
    compute: 0,
    heavyUnflagged: [],
    repetitive: [],
    layoutLeaks: [],
  };
  const warnedHeavy = new Set();
  const warnedRepeat = new Set();
  const warnedLeak = new Set();
  let blockingDepth = 0;
  /** Characters of shader this JS task has already asked the GPU to compile synchronously. */
  let syncChars = 0;
  let syncChecked = false;
  let seq = 0;
  let original = null;
  /** The function as three defined it — what `uninstall` must put back (`original` is a bound copy). */
  let rawOriginal = null;
  /** three's `createComputePipeline`, wrapped only to be counted (see `install`). */
  let rawCompute = null;
  let utils = null;
  let syncBatch = null;
  const device = renderer?.backend?.device ?? null;

  function begin(info) {
    const id = `p${++seq}`;
    tracker.begin(id, info);
    try {
      guard?.noteCompileStart?.(id, info.label, info.chars);
    } catch (err) {
      log.warn('could not write a compile breadcrumb:', err);
    }
    return id;
  }

  function end(id, error = null) {
    const done = tracker.end(id, error);
    try {
      guard?.noteCompileEnd?.(id);
    } catch (err) {
      log.warn('could not clear a compile breadcrumb:', err);
    }
    if (done && done.ms >= SLOW_COMPILE_MS) {
      const rec = tracker.records().at(-1);
      log.warn(
        `slow shader compile: ${rec?.label} took ${done.ms} ms (${rec?.chars} chars, ${rec?.mode}${rec?.reason ? `/${rec.reason}` : ''})`
      );
    }
    if (error) log.error(`pipeline ${id} failed to compile:`, error);
  }

  /** One `onSubmittedWorkDone` for every synchronous creation of a task, not one each. */
  function settleSyncLater(id) {
    if (!device?.queue?.onSubmittedWorkDone) {
      end(id);
      return;
    }
    if (!syncBatch) {
      syncBatch = [];
      queueMicrotask(() => {
        const ids = syncBatch;
        syncBatch = null;
        device.queue.onSubmittedWorkDone().then(
          () => ids.forEach((i) => end(i)),
          // A lost device rejects this. Leave the ids IN FLIGHT: that list is the crash's evidence.
          () => {}
        );
      });
    }
    syncBatch.push(id);
  }

  /**
   * Count `chars` against this task's synchronous budget. The count starts over when the event loop next turns —
   * a macrotask, not a microtask: commands reach the GPU process when the TASK ends, so two runs separated only
   * by an `await` on a settled promise still arrive together.
   */
  function spendSync(chars) {
    if (!syncChecked) {
      syncChecked = true;
      setTimeout(() => {
        syncChars = 0;
        syncChecked = false;
      }, 0);
    }
    syncChars += chars;
  }

  /**
   * HOW to create this pipeline: the material's own policy, then the two limits that exist because of the burst
   * (see the module header) — a heavy pipeline is never created synchronously, even inside a blocking block, and
   * a task that has spent its synchronous budget creates the rest asynchronously.
   * @returns {{mode: 'async'|'sync', reason: string}}
   */
  function decide(renderObject, info) {
    const base = compilePolicyFor(renderObject?.material, info.chars);
    // A one-shot pass loses its result if it is skipped: it is created now, whatever it costs, and it counts.
    if (base.reason === 'sync-only') {
      spendSync(info.chars);
      return base;
    }
    let policy = base;
    if (blockingDepth > 0) {
      if (info.chars >= HEAVY_PIPELINE_CHARS) {
        stats.heavyInBlocking++;
        policy = { mode: 'async', reason: 'heavy-in-blocking' };
      } else {
        policy = { mode: 'sync', reason: 'blocking' };
      }
    }
    if (policy.mode === 'sync') {
      if (!syncChecked) spendSync(0); // arm the reset before reading the count
      if (syncChars + info.chars > SYNC_CHARS_PER_TASK) {
        stats.overBudget++;
        return { mode: 'async', reason: 'task-budget' };
      }
      spendSync(info.chars);
    }
    return policy;
  }

  /** {@link callerSite} of the current call; the stack limit is raised for this one read (three is ~10 frames deep). */
  function siteNow() {
    const limit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 48;
      return callerSite(new Error().stack);
    } catch {
      return null;
    } finally {
      Error.stackTraceLimit = limit;
    }
  }

  /** Name a heavy shader that is mostly its own code again, once per label ({@link repeatShare}). */
  function noteRepeats(label, chars, code) {
    if (chars < HEAVY_PIPELINE_CHARS || warnedRepeat.has(label)) return;
    const share = repeatShare(code);
    if (share < REPEAT_SHARE_WARN) return;
    warnedRepeat.add(label);
    stats.repetitive.push({ label, chars, share: Math.round(share * 100) / 100 });
    log.warn(
      `${label} is ${chars} chars of shader and ${Math.round(share * 100)}% of its statements repeat — a TSL helper ` +
        `pasted per call, or a select chain carried through a JS loop. See core/tsl-fn.js (layoutFn / .toVar()).`
    );
  }

  /** A layout function that reads a binding is a broken shader in waiting (`core/tsl-fn.js#layoutLeaks`). */
  function noteLeaks(label, code) {
    if (warnedLeak.has(label)) return;
    const leaks = layoutLeaks(code);
    if (!leaks.length) return;
    warnedLeak.add(label);
    stats.layoutLeaks.push({ label, leaks });
    log.error(
      `${label}: layout function(s) ${leaks.map((l) => `${l.name} reads ${l.token}`).join(', ')} — a layout body may read ` +
        `only its parameters; pass uniforms/textures in as arguments (core/tsl-fn.js).`
    );
  }

  function governed(renderObject, promises) {
    const info = describePipeline(renderObject, siteNow());
    try {
      const p = renderObject?.pipeline;
      const code = `${p?.vertexProgram?.code ?? ''}\n${p?.fragmentProgram?.code ?? ''}`;
      if (info.chars >= HEAVY_PIPELINE_CHARS) noteRepeats(info.label, info.chars, code);
      noteLeaks(info.label, code);
    } catch (err) {
      log.warn('repeat scan failed:', err);
    }

    // three's own compileAsync already asks for async creation; count it, change nothing.
    if (promises !== null && promises !== undefined) {
      stats.created++;
      stats.compileAsync++;
      const id = begin({ ...info, mode: 'compileAsync', reason: '' });
      const before = promises.length;
      let out;
      try {
        out = original(renderObject, promises);
      } catch (err) {
        end(id, err);
        throw err;
      }
      Promise.all(promises.slice(before)).then(
        () => end(id),
        (err) => end(id, err)
      );
      return out;
    }

    const policy = decide(renderObject, info);
    stats.created++;

    if (policy.mode === 'async') {
      stats.async++;
      stats.deferred++;
      if (policy.reason === 'heavy' && !warnedHeavy.has(info.label)) {
        warnedHeavy.add(info.label);
        stats.heavyUnflagged.push(info.label);
        log.warn(
          `${info.label} is ${info.chars} chars of shader and carries no compile policy — compiling it asynchronously. ` +
            `Mark its material with markCompileDeferrable (core/compile-policy.js), or markCompileSyncOnly if it does one-shot GPU work.`
        );
      }
      const id = begin({ ...info, mode: 'async', reason: policy.reason });
      const own = [];
      try {
        original(renderObject, own);
      } catch (err) {
        end(id, err);
        throw err;
      }
      Promise.all(own).then(
        () => end(id),
        (err) => end(id, err)
      );
      return undefined;
    }

    stats.sync++;
    const id = begin({ ...info, mode: 'sync', reason: policy.reason });
    try {
      original(renderObject, null);
    } catch (err) {
      end(id, err);
      throw err;
    }
    settleSyncLater(id);
    return undefined;
  }

  function install() {
    utils = renderer?.backend?.pipelineUtils ?? null;
    if (!utils || typeof utils.createRenderPipeline !== 'function' || !device) {
      stats.reason = 'the renderer has no pipelineUtils.createRenderPipeline / device — a different three build?';
      log.warn(`pipeline governor not installed: ${stats.reason}`);
      return false;
    }
    if (utils.__msaGoverned) {
      stats.reason = 'already installed';
      return true;
    }
    rawOriginal = utils.createRenderPipeline;
    original = rawOriginal.bind(utils);
    utils.createRenderPipeline = governed;
    utils.__msaGoverned = true;
    stats.installed = true;
    // COMPUTE PIPELINES ARE COUNTED, NOT GOVERNED (2026-11-02). three creates them synchronously and a skipped
    // dispatch would lose a simulation step, so nothing here changes how they are made — but a 253k-character
    // critter kernel was compiling on the GPU's main thread with no line in any report. Its WGSL is read off the
    // program the same way a render pipeline's is; `ms` is only the JS side of the call.
    if (typeof utils.createComputePipeline === 'function') {
      rawCompute = utils.createComputePipeline;
      utils.createComputePipeline = governedCompute;
    }
    return true;
  }

  function governedCompute(pipeline, bindings) {
    const code = pipeline?.computeProgram?.code;
    const chars = typeof code === 'string' ? code.length : 0;
    const label = `${siteNow() || pipeline?.computeProgram?.name || 'compute'}#${fingerprint(typeof code === 'string' ? code : '')}`;
    stats.compute++;
    if (typeof code === 'string') {
      noteRepeats(label, chars, code);
      noteLeaks(label, code);
    }
    const t0 = now();
    try {
      return rawCompute.call(utils, pipeline, bindings);
    } finally {
      tracker.note({ label, chars, mode: 'compute', reason: '' }, now() - t0);
    }
  }

  function uninstall() {
    if (utils && rawOriginal && utils.createRenderPipeline === governed) {
      utils.createRenderPipeline = rawOriginal;
      utils.__msaGoverned = false;
    }
    if (utils && rawCompute && utils.createComputePipeline === governedCompute)
      utils.createComputePipeline = rawCompute;
    stats.installed = false;
  }

  return {
    install,
    uninstall,
    /**
     * Run `fn` with every pipeline created the old, synchronous way — for a block whose correctness is
     * "everything I drew is compiled when I return". Re-entrant.
     * @template T @param {() => T} fn @returns {T}
     */
    blocking(fn) {
      blockingDepth++;
      try {
        return fn();
      } finally {
        blockingDepth--;
      }
    },
    /** Resolves when no pipeline is compiling (synchronous ones count until the GPU has finished them). */
    idle: () => tracker.idle(),
    inFlight: () => tracker.inFlight(),
    /** For the load report and the console: what was created, how big, how long. */
    report({ sinceMs = null } = {}) {
      // `sinceMs` narrows the records to one load (or one floor change) on the governor's own clock.
      const all = tracker.records();
      const records = Number.isFinite(sinceMs) ? all.filter((r) => r.startMs >= sinceMs) : all;
      const byCost = records.slice().sort((a, b) => b.ms - a.ms || b.chars - a.chars);
      const bySize = records.slice().sort((a, b) => b.chars - a.chars);
      return {
        /** The governor's clock now, so a caller can pass it back as `sinceMs` later. */
        nowMs: Math.round(now()),
        /** Characters of WGSL compiled, in all — the number that tracks both JS build time and GPU compile time. */
        chars: records.reduce((a, r) => a + (r.chars || 0), 0),
        /** The ACTIONABLE list: the biggest shaders, by name (see `callerSite`). */
        largest: bySize.slice(0, 10).map((r) => ({ label: r.label, chars: r.chars, ms: r.ms, mode: r.mode })),
        /** How long at least one compile was running (the union of the intervals), and the worst overlap. */
        ...compileBusy(records),
        compute: stats.compute,
        installed: stats.installed,
        reason: stats.reason || null,
        created: stats.created,
        sync: stats.sync,
        async: stats.async,
        compileAsync: stats.compileAsync,
        /** Pipelines made asynchronously only because their task had spent its synchronous budget. */
        overBudget: stats.overBudget,
        /** Heavy pipelines that a blocking block would have compiled synchronously. */
        heavyInBlocking: stats.heavyInBlocking,
        inFlight: tracker.inFlight(),
        ...tracker.counts(),
        slowest: byCost.slice(0, 8),
        heavyUnflagged: stats.heavyUnflagged.slice(),
        repetitive: stats.repetitive.slice(),
        layoutLeaks: stats.layoutLeaks.slice(),
        compiling: tracker.snapshot(),
      };
    },
  };
}
