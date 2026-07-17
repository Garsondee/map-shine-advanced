/**
 * THE FLIGHT RECORDER — the black box. One button, the whole story.
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHY IT IS A DRAIN RATHER THAN A SUBSYSTEM
 * ============================================================================
 *
 * The author's ask (2026-07-17): *"being able to simply press a single button to
 * export all MSA logs and all supporting information... it needs to be plugged
 * into everything and tell the full complete story of how the scene loads."*
 *
 * The temptation is to build a new logging subsystem. That would be exhibit #9
 * in the museum (memory: `v2-postmortem-the-failure-modes`), because the module
 * ALREADY HAD a logger — `core/log.js`, a clean scoped-logger API — and at the
 * time this file was written it had **3 importers against 61 direct `console.*`
 * calls**. That is `EffectComposer.js`'s 5-vs-92 forming again, at a different
 * layer, for the third documented time. A second logger next to the losing one
 * does not make the story complete; it makes two incomplete stories.
 *
 * So this module is a **drain**, not a subsystem:
 *
 *   1. Everything already flows through `core/log.js` → it forwards here.
 *   2. Everything that DOESN'T (Foundry core, other modules, and our own
 *      not-yet-migrated call sites) is caught by patching `console` itself.
 *   3. The `log/one-door` tripwire in `tools/verify-structure.mjs` makes (2)
 *      shrink-only, so the bypass count can never grow again. A comment cannot
 *      fail a build; that rule can.
 *
 * ## The bundle auto-discovers, because a hand-kept list is how this rots
 *
 * `buildFlightBundle` does not enumerate what to include. It runs **every report
 * registered with the debug panel** (`MapShine.debug.reports`). Every future
 * subsystem that registers a report is in the export from that moment on,
 * forever, with nobody editing this file. That is deliberate: this repo has
 * already been bitten three times by hand-kept lists (`Keyhole.md`'s own tally
 * missed 21 params; boot's hook list missed Tile CRUD; the test runner's suite
 * list missed 911 assertions). Discovery, never a list.
 *
 * **The contract that makes that safe:** a *report* is a PURE READOUT. An
 * *action* (`registerAction`) is the thing with side effects. When this split
 * was introduced, **10 of the 20 registered "reports" had side effects** — the
 * soak ran 3 cycles, `vt-pan-viewer-start` launched the torture fixture,
 * `vt-pan-viewer-stop` tore down the live viewer. An exporter that naively ran
 * "every report" would have detonated all ten on one click. The split is not
 * tidiness; it is what makes auto-discovery survivable.
 *
 * ## Three views of frame time, because one view lies
 *
 * The author asked for *"a scattering of fps and individual frame rendering
 * information, not every frame but a good enough sample"*. Sampling alone would
 * answer the question dishonestly, so this keeps three complementary views:
 *
 *   - **The histogram counts EVERY frame** (8 counters, ~free). No sampling bias,
 *     so "what does this session actually feel like" has an unbiased answer.
 *   - **The timeline samples every Nth frame.** Shape over time — is it degrading?
 *   - **The hitch log keeps EVERY hitch, unsampled.** The outliers ARE the bug.
 *     Uniform sampling would statistically miss the exact frames being hunted,
 *     which is the failure mode of every "sample the frame time" instrument.
 *
 * ## Ring buffers report their own drops
 *
 * Every ring here counts what it evicted and says so in the snapshot
 * (`dropped`). A truncated log that presents itself as complete is precisely the
 * bug class in memory `feedback_instruments_must_not_lie`: *"Could not measure"
 * must never look like "is broken"* — and "2,000 entries" must never look like
 * "that was all of them".
 *
 * ## Why it lives in `diag/`
 *
 * The `time/one-clock` tripwire allows `performance.now()`/`Date.now()` in
 * exactly two places: `core/frame-clock.js` and `diag/`. A black box without
 * timestamps is a filing cabinet, so `diag/` is the only legal home. `diag/` is
 * likewise the one zone besides `foundry/` allowed to read Foundry globals
 * (`foundry/adapter-only`), which is what lets `captureEnvironment` name the
 * Foundry version and active scene without reaching around the adapter.
 *
 * @module diag/flight-recorder
 */

import { setLogSink, isLoggerPrinting } from '../core/log.js';

/**
 * Ring capacities. Sized against what a real load actually produces (a cold
 * 3-floor torture load emits a few hundred log lines and runs ~10k frames in a
 * long session) and against what a person can be asked to upload — the whole
 * bundle wants to stay in the low hundreds of KB, not tens of MB.
 */
export const RECORDER_LIMITS = Object.freeze({
  logEntries: 3000,
  frameSamples: 900,
  hitches: 150,
  spans: 400,
});

/**
 * A frame gap at or above this is a hitch — a real, user-perceptible stall
 * rather than ordinary jitter.
 *
 * **This number is 50 because `vt-pan-viewer.js:1159` independently chose 50**
 * ("~3 frames' worth at 60fps"), and two instruments that disagree about what
 * "a stall" means produce two reports that cannot be read side by side.
 *
 * It deliberately does NOT match `ui/load-progress.js`'s `STALL_THRESHOLD_MS`
 * (250), which measures a different thing: a freeze long enough that a person
 * thinks the app is dead. Both numbers are real; neither substitutes for the
 * other. (That file's comment used to claim it shared "the same threshold the
 * renderer's own hitch log uses" — it never did, 250 ≠ 50; the claim is
 * corrected there rather than papered over here. See memory
 * `feedback_probed_constants_vs_derived`.)
 */
export const HITCH_THRESHOLD_MS = 50;

/** Sample one frame in N for the timeline. Every frame still feeds the
 * histogram, and every hitch is kept regardless — see this file's header. */
export const FRAME_SAMPLE_EVERY = 10;

/**
 * Frame-time histogram buckets, in ms, as [upperBoundExclusive, label]. The
 * boundaries are the ones a person actually reasons in (fps bands), not even
 * powers of two — a report is read by a human before it is read by anything else.
 */
const HISTOGRAM_BUCKETS = Object.freeze([
  [8.34, '>120fps'],
  [16.7, '60-120fps'],
  [33.4, '30-60fps'],
  [50, '20-30fps'],
  [100, '10-20fps'],
  [250, '4-10fps'],
  [1000, '1-4fps'],
  [Infinity, '<1fps'],
]);

/**
 * A fixed-capacity ring that KNOWS WHAT IT LOST. `dropped` is the whole point:
 * see this file's header on instruments that must not lie.
 */
class Ring {
  /** @param {number} capacity */
  constructor(capacity) {
    this._capacity = capacity;
    /** @type {any[]} */
    this._items = [];
    this._dropped = 0;
  }

  /** @param {any} item */
  push(item) {
    this._items.push(item);
    if (this._items.length > this._capacity) {
      this._items.shift();
      this._dropped += 1;
    }
  }

  /** @returns {{items: any[], dropped: number, capacity: number, kept: number}} */
  snapshot() {
    return {
      kept: this._items.length,
      dropped: this._dropped,
      capacity: this._capacity,
      items: this._items.slice(),
    };
  }

  clear() {
    this._items.length = 0;
    this._dropped = 0;
  }
}

/**
 * JSON-safe stringification of arbitrary values.
 *
 * Not defensive decoration: reports return live objects, and a single circular
 * reference (a THREE object, a Foundry document, a DOM node) would make
 * `JSON.stringify` throw and take the ENTIRE export down — one bad report
 * costing every other report in the bundle. Cycles become `'[Circular]'`,
 * over-deep branches become `'[MaxDepth]'`, and Errors keep their stack instead
 * of serialising to the famously useless `{}`.
 *
 * @param {any} value
 * @param {number} [maxDepth=8]
 * @returns {any} a structure `JSON.stringify` cannot choke on.
 */
export function toJsonSafe(value, maxDepth = 8) {
  const seen = new WeakSet();

  const walk = (v, depth) => {
    if (v === null || typeof v === 'undefined') return v ?? null;
    const t = typeof v;
    if (t === 'number') return Number.isFinite(v) ? v : String(v); // NaN/Infinity are not JSON
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'bigint') return String(v);
    if (t === 'function') return `[Function ${v.name || 'anonymous'}]`;
    if (t === 'symbol') return String(v);
    if (v instanceof Error) {
      return { __error: v.name, message: v.message, stack: v.stack ?? null };
    }
    if (v instanceof Date) return v.toISOString();
    if (depth >= maxDepth) return '[MaxDepth]';
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      if (v instanceof Map) {
        return { __map: Object.fromEntries(Array.from(v, ([k, val]) => [String(k), walk(val, depth + 1)])) };
      }
      if (v instanceof Set) return { __set: Array.from(v, (x) => walk(x, depth + 1)) };
      // A DOM node or a THREE object would serialise into pages of noise; name it instead.
      if (typeof Node !== 'undefined' && v instanceof Node) return `[DOM ${v.nodeName}]`;
      if (v.isObject3D || v.isTexture || v.isMaterial) return `[THREE ${v.type ?? 'object'}]`;
      const out = {};
      for (const k of Object.keys(v)) {
        out[k] = walk(v[k], depth + 1);
      }
      return out;
    } finally {
      seen.delete(v); // siblings sharing a reference are NOT cycles; only ancestors are
    }
  };

  return walk(value, 0);
}

/**
 * Collapse console arguments into one readable line. Errors keep their stack —
 * the single most useful thing in any bug report, and the thing a naive
 * `String(err)` throws away.
 * @param {any[]} args
 * @returns {string}
 */
function formatArgs(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
      try {
        return JSON.stringify(toJsonSafe(a, 4));
      } catch (e) {
        return `[unserialisable: ${e?.message ?? e}]`;
      }
    })
    .join(' ');
}

/**
 * Best-effort "who logged this" for foreign console traffic.
 *
 * Only called for warn/error (rare), never for log/info — constructing an Error
 * per `console.log` would make the recorder the most expensive thing in a hot
 * loop, which is a monitor becoming the thing worth monitoring.
 *
 * @returns {string|null} the first stack frame outside this file, or null.
 */
function captureOrigin() {
  const stack = new Error().stack;
  if (!stack) return null;
  const lines = stack.split('\n').slice(1);
  for (const line of lines) {
    if (line.includes('flight-recorder.js')) continue;
    const m = line.match(/\(?((?:https?|file):\/\/[^\s)]+)\)?/);
    if (m) return m[1].replace(/^.*\/modules\//, 'modules/');
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 160);
  }
  return null;
}

/**
 * The recorder core. Pure by injection — `now`/`wallClock` are arguments, so
 * every behaviour below runs under Node with a fake clock: no waiting, no
 * flakes, and the timing logic is provable rather than eyeballed.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - monotonic ms. `diag/` is a sanctioned
 *   home for `performance.now()` (`time/one-clock`).
 * @param {() => Date} [options.wallClock] - for human-readable ISO stamps.
 * @param {Partial<typeof RECORDER_LIMITS>} [options.limits]
 * @param {number} [options.hitchThresholdMs]
 * @param {number} [options.frameSampleEvery]
 */
export function createFlightRecorder({
  now = () => performance.now(),
  wallClock = () => new Date(),
  limits = {},
  hitchThresholdMs = HITCH_THRESHOLD_MS,
  frameSampleEvery = FRAME_SAMPLE_EVERY,
} = {}) {
  const caps = { ...RECORDER_LIMITS, ...limits };

  const logs = new Ring(caps.logEntries);
  const frames = new Ring(caps.frameSamples);
  const hitches = new Ring(caps.hitches);
  const spans = new Ring(caps.spans);

  const startedAtMs = now();
  const startedAtIso = wallClock().toISOString();

  /** @type {Map<string, {name: string, startMs: number, meta: any}>} */
  const openSpans = new Map();

  const counts = { debug: 0, info: 0, warn: 0, error: 0 };
  const bySource = Object.create(null);
  /** Times the recorder failed to record. Surfaced in `snapshot()` — an
   * instrument that quietly loses entries is the exact failure this project
   * hunts (memory: `feedback_instruments_must_not_lie`). */
  let recorderFailures = 0;
  /** @type {string|null} */
  let firstRecorderFailure = null;

  const histogram = HISTOGRAM_BUCKETS.map(([, label]) => ({ label, frames: 0 }));
  const frameStats = {
    total: 0,
    lastMs: null,
    worstGapMs: 0,
    worstGapAtMs: null,
    sumDtMs: 0,
    hitchCount: 0,
  };

  /**
   * Record one log entry. Never throws — a recorder that can break the thing it
   * is recording is worse than no recorder.
   * @param {{level?: string, source?: string, subsystem?: string|null, message: string, data?: any, origin?: string|null}} entry
   */
  function log(entry) {
    try {
      const level = entry.level ?? 'info';
      const source = entry.source ?? 'msa';
      if (level in counts) counts[level] += 1;
      bySource[source] = (bySource[source] ?? 0) + 1;
      logs.push({
        tMs: round2(now() - startedAtMs),
        iso: wallClock().toISOString(),
        level,
        source,
        subsystem: entry.subsystem ?? null,
        message: entry.message,
        ...(entry.data === undefined ? {} : { data: toJsonSafe(entry.data, 5) }),
        ...(entry.origin ? { origin: entry.origin } : {}),
      });
    } catch (e) {
      // NOT swallowed — counted, and surfaced in `snapshot().log.recorderFailures`.
      // A recorder that throws into its caller can break the very code it exists
      // to observe (a `data` object with a hostile getter is enough). So it
      // absorbs the failure and REPORTS that it did, which is the honest version
      // of "keep going".
      recorderFailures += 1;
      if (firstRecorderFailure === null) firstRecorderFailure = String(e?.message ?? e);
    }
  }

  /**
   * Open a named span. Re-opening a name closes the previous one as `superseded`
   * rather than silently dropping it — an abandoned span is evidence (something
   * restarted mid-load), and evidence is never thrown away here.
   * @param {string} name
   * @param {any} [meta]
   */
  function beginSpan(name, meta = null) {
    if (openSpans.has(name)) endSpan(name, { superseded: true });
    openSpans.set(name, { name, startMs: now(), meta });
  }

  /**
   * Close a named span. Closing an unopened span is itself recorded (as
   * `unmatched`) instead of ignored — see `no-silent-catch`: every skip states
   * WHY and WHICH.
   * @param {string} name
   * @param {any} [meta]
   * @returns {number|null} the span's duration in ms, or null if unmatched.
   */
  function endSpan(name, meta = null) {
    const open = openSpans.get(name);
    const t = now();
    if (!open) {
      spans.push({
        name,
        startMs: null,
        endMs: round2(t - startedAtMs),
        durMs: null,
        unmatched: true,
        note: 'endSpan called with no matching beginSpan — recorded rather than dropped',
        meta: meta === null ? null : toJsonSafe(meta, 4),
      });
      return null;
    }
    openSpans.delete(name);
    const durMs = round2(t - open.startMs);
    spans.push({
      name,
      startMs: round2(open.startMs - startedAtMs),
      endMs: round2(t - startedAtMs),
      durMs,
      meta: mergeMeta(open.meta, meta),
    });
    return durMs;
  }

  /**
   * Fold one frame in. Call once per rendered frame from the render loop.
   *
   * @param {number} [tMs] - the loop's own timestamp if it has one (RAF/
   *   setAnimationLoop already receive one; taking theirs keeps this instrument
   *   measuring the loop rather than measuring itself).
   * @returns {{gapMs: number|null, hitch: boolean, sampled: boolean}}
   */
  function recordFrame(tMs = now()) {
    frameStats.total += 1;
    const prev = frameStats.lastMs;
    frameStats.lastMs = tMs;
    if (prev === null) return { gapMs: null, hitch: false, sampled: false };

    const gapMs = tMs - prev;
    frameStats.sumDtMs += gapMs;

    // EVERY frame counts here — the histogram is the unbiased view.
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
      if (gapMs < HISTOGRAM_BUCKETS[i][0]) {
        histogram[i].frames += 1;
        break;
      }
    }

    if (gapMs > frameStats.worstGapMs) {
      frameStats.worstGapMs = gapMs;
      frameStats.worstGapAtMs = round2(tMs - startedAtMs);
    }

    // EVERY hitch is kept, unsampled — the outliers are the bug.
    const hitch = gapMs >= hitchThresholdMs;
    if (hitch) {
      frameStats.hitchCount += 1;
      hitches.push({ frame: frameStats.total, atMs: round2(tMs - startedAtMs), gapMs: round2(gapMs) });
    }

    const sampled = frameStats.total % frameSampleEvery === 0;
    if (sampled) {
      frames.push({ frame: frameStats.total, atMs: round2(tMs - startedAtMs), gapMs: round2(gapMs) });
    }

    return { gapMs, hitch, sampled };
  }

  /**
   * Patch `console` so foreign traffic (Foundry core, other modules, and our own
   * not-yet-migrated call sites) lands in the box too — the author chose
   * "everything, tagged by source" precisely because a Foundry error is often the
   * cause of an MSA symptom, and a report that omits it tells the story with the
   * villain edited out.
   *
   * Logger-originated output is skipped here: `core/log.js` already recorded it
   * with structure (subsystem, level, data), and recording it again from the
   * flattened console string would double every MSA line.
   *
   * @param {Console} [target=console]
   * @returns {() => void} an uninstall function (used by tests, and by anything
   *   that needs the real console back).
   */
  function captureConsole(target = console) {
    /** @type {Array<() => void>} */
    const restores = [];
    const levels = /** @type {const} */ (['log', 'info', 'warn', 'error', 'debug']);
    for (const method of levels) {
      const orig = target[method]?.bind(target);
      if (!orig) continue;
      restores.push(() => {
        target[method] = orig;
      });
      target[method] = (...args) => {
        if (!isLoggerPrinting()) {
          const level = method === 'log' ? 'info' : method;
          const isProblem = method === 'warn' || method === 'error';
          log({
            level,
            source: 'foreign',
            message: formatArgs(args),
            // Stack capture only where it pays for itself — see captureOrigin.
            origin: isProblem ? captureOrigin() : null,
          });
        }
        orig(...args);
      };
    }
    return () => {
      for (const r of restores) r();
    };
  }

  /** @returns {object} everything the recorder holds, as plain JSON-safe data. */
  function snapshot() {
    const elapsedMs = round2(now() - startedAtMs);
    const counted = histogram.reduce((a, b) => a + b.frames, 0);
    const logSnap = logs.snapshot(); // once: each call copies the whole ring
    return {
      startedAt: startedAtIso,
      elapsedMs,
      log: {
        ...logSnap,
        counts: { ...counts },
        bySource: { ...bySource },
        recorderFailures,
        firstRecorderFailure,
        note: logSnap.dropped
          ? `${logSnap.dropped} older entries were dropped — the ring holds the most recent ${caps.logEntries}.`
          : 'no entries dropped — this is the complete log for this session.',
      },
      load: {
        ...spans.snapshot(),
        openAtExport: Array.from(openSpans.values(), (s) => ({
          name: s.name,
          startMs: round2(s.startMs - startedAtMs),
          openForMs: round2(now() - s.startMs),
          note: 'STILL OPEN when the bundle was taken — it never finished, or the export happened mid-load.',
        })),
      },
      frames: {
        total: frameStats.total,
        // A histogram over EVERY frame; the samples below are a timeline, not a
        // population. Reading fps off the samples would be a sampling bias.
        histogram: histogram.map((b) => ({
          ...b,
          percent: counted ? round2((b.frames / counted) * 100) : 0,
        })),
        avgGapMs: frameStats.total > 1 ? round2(frameStats.sumDtMs / (frameStats.total - 1)) : null,
        avgFps: frameStats.sumDtMs > 0 ? round2(1000 / (frameStats.sumDtMs / (frameStats.total - 1))) : null,
        worstGapMs: round2(frameStats.worstGapMs),
        worstGapAtMs: frameStats.worstGapAtMs,
        hitchThresholdMs: hitchThresholdMs,
        hitchCount: frameStats.hitchCount,
        sampleEvery: frameSampleEvery,
        samples: frames.snapshot(),
        hitches: {
          ...hitches.snapshot(),
          note: 'EVERY hitch is recorded, never sampled — the outliers are the bug being hunted.',
        },
      },
    };
  }

  /** Wipe frame/hitch history for a clean measurement window. Logs and spans are
   * kept: a measurement window is about frames, and discarding the log would
   * throw away the context that explains the frames. */
  function resetFrameStats() {
    frames.clear();
    hitches.clear();
    frameStats.total = 0;
    frameStats.lastMs = null;
    frameStats.worstGapMs = 0;
    frameStats.worstGapAtMs = null;
    frameStats.sumDtMs = 0;
    frameStats.hitchCount = 0;
    for (const b of histogram) b.frames = 0;
  }

  return {
    log,
    beginSpan,
    endSpan,
    recordFrame,
    captureConsole,
    snapshot,
    resetFrameStats,
    get startedAtMs() {
      return startedAtMs;
    },
  };
}

/** @param {any} a @param {any} b @returns {any} */
function mergeMeta(a, b) {
  if (a == null && b == null) return null;
  if (a == null) return toJsonSafe(b, 4);
  if (b == null) return toJsonSafe(a, 4);
  return toJsonSafe({ ...a, ...b }, 4);
}

/** @param {number} v @returns {number} */
function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Everything about the machine this ran on. `diag/` is allowed to read Foundry
 * globals directly (`foundry/adapter-only`'s allow-list) — that exemption exists
 * for exactly this: naming the environment without routing a diagnostic through
 * the adapter.
 *
 * Every field is individually guarded, because this runs when things are already
 * broken. A bundle that throws while describing a half-dead session is a black
 * box that only works when the plane lands safely.
 *
 * @param {object} MapShine
 * @returns {object}
 */
export function captureEnvironment(MapShine) {
  /** @type {Record<string, any>} */
  const env = {};

  const tryField = (name, fn) => {
    try {
      env[name] = fn();
    } catch (e) {
      env[name] = `[unavailable: ${e?.message ?? e}]`;
    }
  };

  tryField('msa', () => ({
    version: MapShine?.version ?? null,
    codename: MapShine?.codename ?? null,
    stage: MapShine?.__stage ?? null,
    booted: !!MapShine?.__keyholeBooted,
    threeRevision: MapShine?.THREE?.REVISION ?? null,
  }));

  tryField('foundry', () => {
    if (typeof game === 'undefined') return { present: false, note: 'no `game` global — not running inside Foundry.' };
    return {
      present: true,
      version: game.version ?? null,
      system: game.system ? { id: game.system.id, version: game.system.version } : null,
      userIsGM: game.user?.isGM ?? null,
      activeModules:
        game.modules && typeof game.modules.entries === 'function'
          ? Array.from(game.modules.entries())
              .filter(([, m]) => m?.active)
              .map(([id, m]) => `${id}@${m?.version ?? '?'}`)
          : null,
    };
  });

  tryField('scene', () => {
    if (typeof canvas === 'undefined' || !canvas?.scene) return null;
    const s = canvas.scene;
    return {
      id: s.id ?? null,
      name: s.name ?? null,
      width: s.width ?? null,
      height: s.height ?? null,
      padding: s.padding ?? null,
      gridSize: s.grid?.size ?? null,
      background: s.background?.src ?? null,
      tokenCount: s.tokens?.size ?? null,
      tileCount: s.tiles?.size ?? null,
      levelCount: Array.isArray(s.levels) ? s.levels.length : (s.levels?.size ?? null),
    };
  });

  tryField('renderer', () => {
    const r = MapShine?.__heartbeat?.renderer;
    if (!r) return { note: 'no heartbeat renderer — boot may have failed before it was constructed.' };
    const backend = r.backend?.isWebGPUBackend ? 'webgpu' : r.backend ? 'webgl2' : 'unknown';
    const out = { backend, webgpuAvailable: typeof navigator !== 'undefined' && !!navigator.gpu };
    const info = r.backend?.adapter?.info;
    if (info) {
      out.adapter = {
        vendor: info.vendor ?? null,
        architecture: info.architecture ?? null,
        device: info.device ?? null,
        description: info.description ?? null,
      };
    }
    const limits = r.backend?.device?.limits;
    if (limits) {
      out.limits = {
        maxTextureDimension2D: limits.maxTextureDimension2D,
        maxTextureArrayLayers: limits.maxTextureArrayLayers,
        maxBufferSize: limits.maxBufferSize,
      };
    }
    return out;
  });

  tryField('browser', () => ({
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    language: typeof navigator !== 'undefined' ? navigator.language : null,
    hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null,
    // Chrome-only, and the single most useful number when the symptom is "it got
    // slow after ten minutes". Absent elsewhere — reported as absent, not faked.
    deviceMemoryGb: typeof navigator !== 'undefined' ? (navigator.deviceMemory ?? null) : null,
    jsHeap:
      typeof performance !== 'undefined' && performance.memory
        ? {
            usedMb: Math.round(performance.memory.usedJSHeapSize / 1048576),
            limitMb: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
          }
        : null,
    screen:
      typeof window !== 'undefined'
        ? {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
          }
        : null,
    url: typeof location !== 'undefined' ? location.href : null,
  }));

  return env;
}

/**
 * Run every registered report and fold the results in.
 *
 * Auto-discovered, never listed — see this file's header. Two guarantees make
 * that safe to do on one click:
 *
 *  - **Only reports run.** Actions (`registerAction`) are excluded by
 *    construction: they are a different map. Half the registry had side effects
 *    when this was written.
 *  - **A bad report cannot take the bundle down.** Each is timed out and each
 *    failure is CAPTURED AS A FINDING, not swallowed — a report that throws is
 *    itself a bug worth exporting, and `skipped: []` must always mean "nothing
 *    was skipped", never "I did not look" (memory:
 *    `feedback_instruments_must_not_lie`).
 *
 * @param {Map<string, {label: string, fn: Function}>} reports
 * @param {{timeoutMs?: number, now?: () => number}} [options]
 * @returns {Promise<{results: object, failures: object, timings: object}>}
 */
export async function runAllReports(reports, { timeoutMs = 5000, now = () => performance.now() } = {}) {
  /** @type {Record<string, any>} */
  const results = {};
  /** @type {Record<string, string>} */
  const failures = {};
  /** @type {Record<string, number>} */
  const timings = {};

  for (const [id, entry] of reports) {
    const t0 = now();
    try {
      const value = await withTimeout(Promise.resolve(entry.fn()), timeoutMs, id);
      results[id] = toJsonSafe(value, 10);
    } catch (e) {
      // Reported, never swallowed: a report that throws IS a finding.
      failures[id] = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    }
    timings[id] = round2(now() - t0);
  }

  return { results, failures, timings };
}

/**
 * @param {Promise<any>} promise @param {number} ms @param {string} id
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`report "${id}" did not finish within ${ms}ms — it is hung, and that is the finding`)),
      ms
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Assemble the whole bundle: environment + the recorder's own history + every
 * registered report.
 *
 * @param {object} args
 * @param {ReturnType<typeof createFlightRecorder>} args.recorder
 * @param {object} args.MapShine
 * @param {Map<string, {label: string, fn: Function}>} [args.reports]
 * @param {string[]} [args.actionIds] - names of the registered ACTIONS, listed so
 *   the bundle states plainly what it did not run and why.
 * @param {number} [args.reportTimeoutMs]
 * @returns {Promise<object>}
 */
export async function buildFlightBundle({ recorder, MapShine, reports = new Map(), actionIds = [], reportTimeoutMs }) {
  const { results, failures, timings } = await runAllReports(reports, { timeoutMs: reportTimeoutMs });

  return {
    bundle: 'msa-flight-recorder',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    readMe:
      'Map Shine Advanced flight recorder. `recorder.log` is the session log (MSA + Foundry + other ' +
      'modules, tagged by `source`). `recorder.load` is the scene-load timeline as spans. ' +
      '`recorder.frames` holds three views of frame time: a histogram over EVERY frame (unbiased), a ' +
      'timeline sampling 1-in-N (shape over time), and EVERY hitch (unsampled — the outliers are the ' +
      'bug). `reports` is every read-only debug-panel report, auto-discovered. `reportFailures` is not ' +
      'noise: a report that threw is itself a finding. Anything dropped says so — no ring here ' +
      'silently truncates.',
    environment: captureEnvironment(MapShine),
    recorder: recorder.snapshot(),
    reports: results,
    reportFailures: failures,
    reportTimingsMs: timings,
    reportsSkipped: {
      actions: actionIds,
      why:
        'These are ACTIONS, not readouts — they change state (start/stop the viewer, run a soak, thrash ' +
        'the zoom). The exporter never runs them: one click must not restart your scene. Run them by ' +
        'hand from the debug panel when you want them.',
    },
  };
}

/**
 * Trigger a browser download of `text`.
 *
 * The author chose file-only delivery: a full bundle runs to hundreds of KB and
 * is well past what anyone can paste into a chat window.
 *
 * @param {string} text @param {string} filename
 * @returns {{ok: boolean, bytes: number, filename: string, error?: string}}
 */
export function downloadText(text, filename) {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a timer, not immediately: revoking synchronously after click()
    // cancels the download in Firefox before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { ok: true, bytes: blob.size, filename };
  } catch (e) {
    return { ok: false, bytes: 0, filename, error: String(e?.message ?? e) };
  }
}

/**
 * Build the bundle's filename. Scene name is included because the first question
 * asked of any report is "which map?", and a filename that answers it saves a
 * round trip.
 * @param {object} MapShine
 * @param {() => Date} [wallClock]
 * @returns {string}
 */
export function bundleFilename(MapShine, wallClock = () => new Date()) {
  let scene = 'no-scene';
  try {
    if (typeof canvas !== 'undefined' && canvas?.scene?.name) scene = canvas.scene.name;
  } catch (e) {
    scene = 'scene-unreadable';
  }
  const slug = String(scene)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const stamp = wallClock().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `msa-flight-${slug || 'scene'}-${stamp}.json`;
}

/**
 * Install the recorder onto the MapShine namespace and start capturing.
 *
 * **Call this FIRST in boot** — before anything else runs, because a black box
 * that starts late has a hole exactly where the earliest (and most interesting)
 * failures live. The old `debug-panel.js` console capture had this same warning
 * and the same limitation; the difference is this one also catches `info`/
 * `debug`, which is where the load story is actually told. The panel used to
 * keep `warn`/`error` only — it recorded the complaints and threw away the plot.
 *
 * @param {object} MapShine
 * @returns {object} the recorder API, also exposed at `MapShine.flight`.
 */
export function installFlightRecorder(MapShine) {
  if (MapShine.flight) return MapShine.flight; // idempotent (hot-reload, double-boot)

  const recorder = createFlightRecorder();
  const uninstallConsole = recorder.captureConsole();

  // core/log.js forwards EVERY call here regardless of console verbosity — the
  // print level and the record level are different dials. Console stays quiet at
  // INFO; the box swallows DEBUG too. That decoupling is the entire point of a
  // flight recorder: you cannot ask a user to reproduce a bug with verbose
  // logging on when the bug already happened.
  setLogSink((entry) => recorder.log({ ...entry, source: 'msa' }));

  MapShine.flight = {
    ...recorder,
    uninstallConsole,
    /** @param {object} [opts] */
    async bundle(opts = {}) {
      return buildFlightBundle({
        recorder,
        MapShine,
        reports: MapShine.debug?.reports ?? new Map(),
        actionIds: Array.from(MapShine.debug?.actions?.keys?.() ?? []),
        ...opts,
      });
    },
    /**
     * The one button. Builds the bundle and downloads it.
     * @returns {Promise<{ok: boolean, bytes: number, filename: string, reports: number, failures: number, error?: string}>}
     */
    async export() {
      const bundle = await MapShine.flight.bundle();
      const text = JSON.stringify(bundle, null, 2);
      const result = downloadText(text, bundleFilename(MapShine));
      return {
        ...result,
        reports: Object.keys(bundle.reports).length,
        failures: Object.keys(bundle.reportFailures).length,
      };
    },
  };

  return MapShine.flight;
}
