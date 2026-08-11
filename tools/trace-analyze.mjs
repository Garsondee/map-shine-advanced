/**
 * trace-analyze.mjs — read a raw Chrome DevTools performance trace and answer
 * the only questions that change what we do next: is the frame CPU- or
 * GPU-bound, what does a SLOW frame do that a fast one doesn't, and which of
 * our own modules is actually spending the time.
 *
 * Usage:
 *   node tools/trace-analyze.mjs <trace.json|trace.json.gz> [--json out.json] [--md out.md]
 *   node tools/trace-analyze.mjs <baseline> --compare <candidate>
 *
 * A big trace needs heap: `node --max-old-space-size=8192 tools/trace-analyze.mjs ...`
 * (158 MB / 645k events parses in ~1.2 s and fits comfortably; the tool refuses
 * loudly rather than dying half-way if the file is too large to read at all.)
 *
 * ============================================================================
 * WHAT THIS INSTRUMENT CANNOT SEE — READ THIS FIRST
 * ============================================================================
 *
 * A DevTools trace records Chrome's own instrumentation. Unless the capture was
 * taken with the Dawn/WebGPU trace categories enabled (`disabled-by-default-gpu.dawn`
 * and friends), it knows the GPU process was BUSY and never WHICH RENDER PASS
 * made it busy. There is no way to recover that after the fact — it was not
 * written down. So this tool will happily tell you "GPU submission thread 90%
 * busy" and it is structurally incapable of turning that into
 * `geometry.worldDraw` vs `pass.light.accumulate`. MSA's own timestamp-query
 * zone timer (`diag/perf-session.js`) remains the ONLY instrument that can.
 *
 * Every report prints a BLIND SPOTS section listing which categories were
 * absent, because a zero produced by a missing category and a zero produced by
 * genuinely-absent work are different facts and must never render identically
 * (memory: feedback_instruments_must_not_lie).
 *
 * ============================================================================
 * THREE MEASUREMENT BUGS THIS TOOL EXISTS TO MAKE UNREPEATABLE (2026-08-11)
 * ============================================================================
 *
 * All three were made by hand, in one session, reading the first trace — and all
 * three were caught only because a number came out physically impossible. They
 * are encoded as mechanisms here rather than left as advice:
 *
 * 1. SUMMING NESTED SPANS OVERCOUNTS. Adding up every `dur` on a thread counts a
 *    parent (`RunTask`) and everything inside it (`GPUTask`, `FunctionCall`, ...)
 *    as if they were disjoint. Live result: "CrGpuMain 174.6% busy" — impossible,
 *    therefore caught. `mergeIntervals` unions overlapping spans instead, and
 *    `assertUtilizationSane` throws if any derived utilization still exceeds 100%
 *    by more than float slop. A busy figure over 100% is a BUG IN THIS FILE, and
 *    it now fails loudly instead of shipping into a report.
 *
 * 2. `ts:0` METADATA POISONS A NAIVE MIN/MAX. Every Chrome trace carries `ph:'M'`
 *    metadata events (`process_name`, `thread_name`) timestamped 0. A naive
 *    min/max scan over all timestamps therefore reported an 11.3-SECOND trace as
 *    428,161,450 ms long. `traceWindow` prefers DevTools' own recorded breadcrumb
 *    window and cross-checks it against duration-bearing, non-metadata events.
 *
 * 3. THE PROFILER'S OWN ATTACH COST LOOKS EXACTLY LIKE THE WORST HITCH. Starting
 *    the JS sampling profiler deoptimizes already-JITed code so it can be
 *    reinstrumented; live, that was a single 1187.4 ms main-thread `RunTask`
 *    beginning 1.2 ms BEFORE the recording's own start marker, with
 *    `CpuProfiler::StartProfiling` (1155.5 ms) inside it and two
 *    `V8.DeoptimizeAllOptimizedCodeWithFunction` calls landing the instant it
 *    ended. Excluding it, that trace had ZERO >50 ms main-thread tasks for its
 *    remaining ~10 s. `detectProfilerArtifact` finds it by that signature and
 *    every hitch/frame statistic excludes it — while REPORTING that it did, so
 *    the exclusion is never silent.
 *
 * ============================================================================
 * WHAT A "FRAME" IS HERE, AND WHY IT IS NOT `FireAnimationFrame`
 * ============================================================================
 *
 * One `PageAnimator::serviceScriptedAnimations` span is one animation-frame
 * service — the unit that lines up 1:1 with presented frames (first trace: 305
 * services vs 306 `DrawFrame`s). `FireAnimationFrame` is ONE rAF CALLBACK, and
 * there are several registrants (Foundry's ticker, MSA's render loop, UI) — 1,530
 * of them against 306 presented frames in that same trace. Bucketing by
 * `FireAnimationFrame` would therefore report ~5x too many "frames" and quietly
 * divide every per-frame cost by the wrong denominator.
 *
 * @module tools/trace-analyze
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** A main-thread task at or over this is a hitch worth naming. */
export const HITCH_MS = 50;
/** Frames at or over this missed a 30fps deadline badly enough to feel. */
export const SLOW_FRAME_MS = 20;
/** `PageAnimator::serviceScriptedAnimations` — the one true frame unit. See header. */
export const FRAME_SPAN_NAME = 'PageAnimator::serviceScriptedAnimations';

/**
 * Origin buckets for a JS stack frame's URL. A CLOSED list with an explicit
 * `unknown` fallback — a category string invented at the call site is how a
 * typo becomes a silently-empty row (memory:
 * feedback_category_string_must_be_in_closed_list).
 */
export const ORIGINS = Object.freeze(['msa', 'three-vendor', 'foundry', 'extension', 'browser-internal', 'unknown']);

/**
 * Classify a stack frame's URL into one of ORIGINS.
 *
 * ⚠️ ORDER IS LOAD-BEARING AND TESTED. MSA's vendored three lives at
 * `.../map-shine-advanced/src/vendor/three/three.webgpu.js` — a URL containing
 * BOTH markers. Checking `map-shine-advanced` first would bill every millisecond
 * of three.js's renderer to MSA's own code and make our biggest cost centre
 * invisible by mislabelling it (memory: feedback_fallback_matcher_self_match).
 * The vendor test therefore runs FIRST, and `trace-analyze.test.mjs` pins it.
 *
 * @param {string} url
 * @returns {typeof ORIGINS[number]}
 */
export function classifyUrl(url) {
  if (!url) return 'browser-internal';
  if (url.startsWith('chrome-extension://')) return 'extension';
  if (/\/vendor\/three\//.test(url)) return 'three-vendor';
  if (/map-shine-advanced/.test(url)) return 'msa';
  if (/\/scripts\/foundry\.mjs|\/scripts\/[a-z-]+\.mjs/.test(url)) return 'foundry';
  if (/^(https?:)?\/\//.test(url)) return 'unknown';
  return 'unknown';
}

/**
 * Short, readable module label for a URL — the last path segment, so
 * `.../effects/lighting/point-light-pool.js` reads as `point-light-pool.js`.
 * @param {string} url
 * @returns {string}
 */
export function moduleLabel(url) {
  if (!url) return '(browser internal)';
  const noQuery = url.split('?')[0];
  const seg = noQuery.split('/').filter(Boolean).pop();
  return seg || url;
}

/**
 * Union of overlapping/nested `[start, end)` intervals, in input units.
 *
 * THE FIX FOR MEASUREMENT BUG 1 (see header). Summing durations double-counts
 * every nested span; this counts wall-clock occupancy exactly once.
 *
 * @param {Array<[number, number]>} intervals
 * @returns {number} merged occupancy
 */
export function mergeIntervals(intervals) {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  return total + (curEnd - curStart);
}

/**
 * A utilization figure over 100% means this file has a bug (bug 1 again), not
 * that a thread worked harder than time allows. Fail loudly.
 * @param {string} label @param {number} pct
 */
export function assertUtilizationSane(label, pct) {
  // 0.5% slop: spans can extend a hair past the breadcrumb window's end.
  if (pct > 100.5) {
    throw new Error(
      `trace-analyze: computed ${pct.toFixed(1)}% busy for '${label}', which is physically impossible. ` +
        'This means overlapping spans were summed instead of merged (see this file\'s "measurement bug 1"). ' +
        'Refusing to emit a report containing an impossible number.'
    );
  }
  return pct;
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted array.
 * @param {number[]} sortedAsc @param {number} p 0..1
 * @returns {number|null}
 */
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/**
 * The trace's real recording window.
 *
 * THE FIX FOR MEASUREMENT BUG 2 (see header). Prefers DevTools' own breadcrumb
 * (what the user actually recorded) and cross-checks it against duration-bearing
 * non-metadata events, reporting disagreement rather than silently picking one.
 *
 * @param {object[]} events @param {object|null} metadata
 */
export function traceWindow(events, metadata) {
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const e of events) {
    // ph:'M' excluded on purpose — metadata is timestamped 0 and would drag the
    // window back to the epoch. This is measurement bug 2, mechanised.
    if (e.ph === 'M' || typeof e.ts !== 'number') continue;
    if (e.ts < minTs) minTs = e.ts;
    const end = e.ts + (e.dur || 0);
    if (end > maxTs) maxTs = end;
  }
  const observed = Number.isFinite(minTs) ? { startUs: minTs, endUs: maxTs } : null;
  const bc = metadata?.modifications?.initialBreadcrumb?.window ?? null;
  const chosen = bc ? { startUs: bc.min, endUs: bc.max } : observed;
  if (!chosen) throw new Error('trace-analyze: no timestamped events — not a usable trace.');
  return {
    startUs: chosen.startUs,
    endUs: chosen.endUs,
    durationMs: (chosen.endUs - chosen.startUs) / 1000,
    source: bc ? 'devtools-breadcrumb' : 'observed-events',
    observedDurationMs: observed ? (observed.endUs - observed.startUs) / 1000 : null,
  };
}

/**
 * Find the JS-profiler attach artifact, if present.
 *
 * THE FIX FOR MEASUREMENT BUG 3 (see header). Signature, all three required so a
 * genuine early hitch is not silently discarded: a main-thread task at least
 * `HITCH_MS` long, starting within the first `graceMs` of the window, that
 * CONTAINS a `CpuProfiler::StartProfiling` span. The containment check is what
 * separates "the profiler attached" from "the app really did stall at startup" —
 * without it this would be a blunt "ignore the first second" rule, which would
 * hide real first-frame cost.
 *
 * @returns {{startUs:number, endUs:number, durMs:number, tsRelMs:number, profilerMs:number}|null}
 */
export function detectProfilerArtifact(events, win, mainThreadKeys, graceMs = 2000) {
  const starts = events.filter((e) => e.name === 'CpuProfiler::StartProfiling' && typeof e.dur === 'number');
  if (!starts.length) return null;
  const candidates = events.filter(
    (e) =>
      e.ph === 'X' &&
      e.name === 'RunTask' &&
      typeof e.dur === 'number' &&
      e.dur >= HITCH_MS * 1000 &&
      mainThreadKeys.has(`${e.pid}:${e.tid}`) &&
      e.ts <= win.startUs + graceMs * 1000
  );
  for (const task of candidates) {
    const taskEnd = task.ts + task.dur;
    const inside = starts.find((s) => s.ts >= task.ts && s.ts + s.dur <= taskEnd);
    if (inside) {
      return {
        startUs: task.ts,
        endUs: taskEnd,
        durMs: task.dur / 1000,
        tsRelMs: (task.ts - win.startUs) / 1000,
        profilerMs: inside.dur / 1000,
      };
    }
  }
  return null;
}

/**
 * Reassemble the V8 CPU sample profile scattered across `ProfileChunk` events.
 *
 * Returns a TIME-ORDERED sample timeline, which is what makes span attribution
 * possible: `samplesInRange` bisects it, so any trace span (a frame, a rAF
 * callback, a hitch) can be asked "what JS was on the stack during you?" That is
 * the whole reason this tool can name a source instead of only an aggregate
 * (memory: feedback_aggregate_cannot_name_the_source).
 *
 * `timeDeltas[i]` is the gap BEFORE sample i, cumulative from `startTime`.
 */
export function buildSampleTimeline(events) {
  const nodesById = new Map();
  const times = [];
  const nodeIds = [];
  let startTime = null;

  for (const e of events) {
    if (e.name === 'Profile' && e.args?.data?.startTime != null) {
      startTime = e.args.data.startTime;
    }
  }
  let cursor = startTime;
  for (const chunk of events) {
    if (chunk.name !== 'ProfileChunk') continue;
    const cp = chunk.args?.data?.cpuProfile;
    if (!cp) continue;
    if (cp.nodes) {
      for (const n of cp.nodes) {
        nodesById.set(n.id, { callFrame: n.callFrame ?? {}, parent: n.parent ?? null });
      }
    }
    const samples = cp.samples ?? [];
    const deltas = chunk.args.data.timeDeltas ?? [];
    if (cursor == null) cursor = chunk.ts;
    for (let i = 0; i < samples.length; i++) {
      cursor += deltas[i] ?? 0;
      times.push(cursor);
      nodeIds.push(samples[i]);
    }
  }
  return { times, nodeIds, nodesById, sampleCount: times.length };
}

/**
 * Indices of samples whose timestamp falls in `[startUs, endUs)`, via binary
 * search on the ascending `times` array.
 */
export function samplesInRange(timeline, startUs, endUs) {
  const { times } = timeline;
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < startUs) lo = mid + 1;
    else hi = mid;
  }
  const from = lo;
  hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < endUs) lo = mid + 1;
    else hi = mid;
  }
  return { from, to: lo, count: lo - from };
}

/**
 * Walk a node's ancestor chain to the root.
 * @returns {number[]} node ids, innermost first
 */
export function ancestorChain(nodesById, nodeId, maxDepth = 512) {
  const out = [];
  let cur = nodeId;
  let guard = 0;
  while (cur != null && guard++ < maxDepth) {
    out.push(cur);
    const n = nodesById.get(cur);
    if (!n) break;
    cur = n.parent;
  }
  return out;
}

/**
 * Attribute a set of samples by SELF time (the leaf frame) and by ORIGIN.
 *
 * Self time answers "where is the CPU actually executing"; the origin split
 * answers the question that decides whose problem it is — ours, three's,
 * Foundry's, or an extension that has no business being in the measurement.
 */
export function attributeSamples(timeline, from, to) {
  const { nodeIds, nodesById } = timeline;
  const selfByKey = new Map();
  const byOrigin = new Map();
  const byModule = new Map();
  let counted = 0;

  for (let i = from; i < to; i++) {
    const node = nodesById.get(nodeIds[i]);
    if (!node) continue;
    counted++;
    const cf = node.callFrame ?? {};
    const url = cf.url ?? '';
    const origin = classifyUrl(url);
    const fn = cf.functionName || '(anonymous)';
    const key = `${fn}|${url}|${cf.lineNumber ?? ''}`;

    byOrigin.set(origin, (byOrigin.get(origin) || 0) + 1);
    if (origin === 'msa' || origin === 'three-vendor' || origin === 'foundry' || origin === 'extension') {
      const label = moduleLabel(url);
      byModule.set(label, (byModule.get(label) || 0) + 1);
    }
    const rec = selfByKey.get(key) || { fn, url, line: cf.lineNumber ?? null, origin, hits: 0 };
    rec.hits++;
    selfByKey.set(key, rec);
  }
  return { counted, selfByKey, byOrigin, byModule };
}

/**
 * Total (inclusive) time per function: a function is charged for every sample
 * taken anywhere beneath it. Self time alone hides a cheap-looking function
 * whose CALLEES are the cost, which is precisely the shape of a render loop.
 */
export function attributeTotals(timeline, from, to) {
  const { nodeIds, nodesById } = timeline;
  const totalByKey = new Map();
  const seen = new Set();
  for (let i = from; i < to; i++) {
    const chain = ancestorChain(nodesById, nodeIds[i]);
    seen.clear();
    for (const id of chain) {
      const n = nodesById.get(id);
      if (!n) continue;
      const cf = n.callFrame ?? {};
      const key = `${cf.functionName || '(anonymous)'}|${cf.url ?? ''}|${cf.lineNumber ?? ''}`;
      // A recursive function must be charged ONCE per sample, not once per
      // stack level, or recursion alone would invent time that never elapsed.
      if (seen.has(key)) continue;
      seen.add(key);
      const rec = totalByKey.get(key) || {
        fn: cf.functionName || '(anonymous)',
        url: cf.url ?? '',
        line: cf.lineNumber ?? null,
        origin: classifyUrl(cf.url ?? ''),
        hits: 0,
      };
      rec.hits++;
      totalByKey.set(key, rec);
    }
  }
  return totalByKey;
}

/** Thread/process name maps from a trace's metadata events. */
export function readThreadNames(events) {
  const procNames = new Map();
  const threadNames = new Map();
  for (const e of events) {
    if (e.ph !== 'M') continue;
    if (e.name === 'process_name') procNames.set(e.pid, e.args?.name ?? '?');
    else if (e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args?.name ?? '?');
  }
  return { procNames, threadNames };
}

/**
 * Per-thread merged busy time and utilization, with the sanity assert applied.
 * `exclude` drops a span range (the profiler artifact) from the accounting.
 */
export function threadUtilization(events, win, threadNames, filter, exclude = null) {
  const byThread = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number' || e.dur < 0) continue;
    if (!filter(e)) continue;
    if (exclude && e.ts >= exclude.startUs && e.ts < exclude.endUs) continue;
    const k = `${e.pid}:${e.tid}`;
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k).push([e.ts, e.ts + e.dur]);
  }
  const windowMs = win.durationMs - (exclude ? exclude.durMs : 0);
  const out = [];
  for (const [k, intervals] of byThread) {
    const busyMs = mergeIntervals(intervals) / 1000;
    const pct = assertUtilizationSane(threadNames.get(k) ?? k, (busyMs / windowMs) * 100);
    const [pid, tid] = k.split(':').map(Number);
    out.push({ thread: threadNames.get(k) ?? '?', pid, tid, busyMs, utilizationPct: pct });
  }
  return out.sort((a, b) => b.busyMs - a.busyMs);
}

/**
 * Segment the trace into frames and attribute each one.
 * See the header for why the unit is `PageAnimator::serviceScriptedAnimations`.
 */
export function buildFrames(events, win, mainThreadKeys, timeline, exclude) {
  const frames = [];
  for (const e of events) {
    if (e.ph !== 'X' || e.name !== FRAME_SPAN_NAME || typeof e.dur !== 'number') continue;
    if (!mainThreadKeys.has(`${e.pid}:${e.tid}`)) continue;
    if (exclude && e.ts >= exclude.startUs && e.ts < exclude.endUs) continue;
    frames.push({
      startUs: e.ts,
      endUs: e.ts + e.dur,
      durMs: e.dur / 1000,
      tsRelMs: (e.ts - win.startUs) / 1000,
    });
  }
  frames.sort((a, b) => a.startUs - b.startUs);
  // Gap to the previous frame's START is the felt cadence — the same definition
  // MSA's own frame-profiler uses for its gap ring, so the two are comparable.
  for (let i = 1; i < frames.length; i++) {
    frames[i].gapMs = (frames[i].startUs - frames[i - 1].startUs) / 1000;
  }
  if (timeline) {
    for (const f of frames) {
      const { from, to } = samplesInRange(timeline, f.startUs, f.endUs);
      f.sampleFrom = from;
      f.sampleTo = to;
    }
  }
  return frames;
}

/**
 * THE HEADLINE ANALYSIS: what does a SLOW frame do that a fast one does not?
 *
 * Averages over a whole capture hide the answer — a 36 s pan contains 8 ms
 * frames and 100 ms frames, and only the difference between them is actionable.
 * Frames are split at a percentile, each bucket's JS is attributed, and the
 * result is ranked by the per-frame millisecond DELTA rather than by raw share,
 * because a function that costs the same in both buckets explains nothing about
 * why the slow ones are slow.
 */
export function diffSlowVsFast(frames, timeline, msPerSample, slowPct = 0.9) {
  const withSamples = frames.filter((f) => f.sampleTo > f.sampleFrom);
  if (withSamples.length < 10 || !timeline) return null;
  const sorted = [...withSamples].sort((a, b) => a.durMs - b.durMs);
  const cut = percentile(
    sorted.map((f) => f.durMs),
    slowPct
  );
  const slow = sorted.filter((f) => f.durMs >= cut);
  const fast = sorted.filter((f) => f.durMs < cut);
  if (!slow.length || !fast.length) return null;

  const bucketAttr = (bucket) => {
    const selfByKey = new Map();
    const byOrigin = new Map();
    let samples = 0;
    for (const f of bucket) {
      const a = attributeSamples(timeline, f.sampleFrom, f.sampleTo);
      samples += a.counted;
      for (const [k, v] of a.selfByKey) {
        const rec = selfByKey.get(k) || { ...v, hits: 0 };
        rec.hits += v.hits;
        selfByKey.set(k, rec);
      }
      for (const [o, n] of a.byOrigin) byOrigin.set(o, (byOrigin.get(o) || 0) + n);
    }
    return { selfByKey, byOrigin, samples, frames: bucket.length };
  };

  const slowAttr = bucketAttr(slow);
  const fastAttr = bucketAttr(fast);

  const keys = new Set([...slowAttr.selfByKey.keys(), ...fastAttr.selfByKey.keys()]);
  const deltas = [];
  for (const k of keys) {
    const s = slowAttr.selfByKey.get(k);
    const f = fastAttr.selfByKey.get(k);
    const meta = s ?? f;
    const slowMsPerFrame = ((s?.hits ?? 0) * msPerSample) / slowAttr.frames;
    const fastMsPerFrame = ((f?.hits ?? 0) * msPerSample) / fastAttr.frames;
    deltas.push({
      fn: meta.fn,
      url: meta.url,
      line: meta.line,
      origin: meta.origin,
      module: moduleLabel(meta.url),
      slowMsPerFrame,
      fastMsPerFrame,
      deltaMsPerFrame: slowMsPerFrame - fastMsPerFrame,
    });
  }
  deltas.sort((a, b) => b.deltaMsPerFrame - a.deltaMsPerFrame);

  const originDelta = [];
  for (const o of ORIGINS) {
    const s = ((slowAttr.byOrigin.get(o) ?? 0) * msPerSample) / slowAttr.frames;
    const f = ((fastAttr.byOrigin.get(o) ?? 0) * msPerSample) / fastAttr.frames;
    if (s || f) originDelta.push({ origin: o, slowMsPerFrame: s, fastMsPerFrame: f, deltaMsPerFrame: s - f });
  }
  originDelta.sort((a, b) => b.deltaMsPerFrame - a.deltaMsPerFrame);

  return {
    cutoffMs: cut,
    slow: { frames: slow.length, meanMs: mean(slow.map((f) => f.durMs)), samples: slowAttr.samples },
    fast: { frames: fast.length, meanMs: mean(fast.map((f) => f.durMs)), samples: fastAttr.samples },
    topDeltas: deltas.slice(0, 25),
    originDelta,
  };
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/** rAF callbacks grouped by which JS module dominates them — answers "how many real loops?" */
export function attributeRafCallbacks(events, win, mainThreadKeys, timeline, exclude) {
  const groups = new Map();
  let total = 0;
  for (const e of events) {
    if (e.ph !== 'X' || e.name !== 'FireAnimationFrame' || typeof e.dur !== 'number') continue;
    if (!mainThreadKeys.has(`${e.pid}:${e.tid}`)) continue;
    if (exclude && e.ts >= exclude.startUs && e.ts < exclude.endUs) continue;
    total++;
    let label = '(no samples)';
    if (timeline) {
      const { from, to } = samplesInRange(timeline, e.ts, e.ts + e.dur);
      const a = attributeSamples(timeline, from, to);
      let best = null;
      for (const [m, n] of a.byModule) if (!best || n > best[1]) best = [m, n];
      if (best) label = best[0];
    }
    const rec = groups.get(label) || { label, count: 0, sumMs: 0, maxMs: 0 };
    rec.count++;
    rec.sumMs += e.dur / 1000;
    if (e.dur / 1000 > rec.maxMs) rec.maxMs = e.dur / 1000;
    groups.set(label, rec);
  }
  return { total, groups: [...groups.values()].sort((a, b) => b.sumMs - a.sumMs) };
}

/** Long main-thread tasks, each with the JS that was actually on the stack. */
export function findHitches(events, win, mainThreadKeys, timeline, exclude, msPerSample) {
  const hitches = [];
  for (const e of events) {
    if (e.ph !== 'X' || e.name !== 'RunTask' || typeof e.dur !== 'number') continue;
    if (!mainThreadKeys.has(`${e.pid}:${e.tid}`)) continue;
    if (e.dur < HITCH_MS * 1000) continue;
    if (exclude && e.ts >= exclude.startUs && e.ts < exclude.endUs) continue;
    const rec = { tsRelMs: (e.ts - win.startUs) / 1000, durMs: e.dur / 1000, top: [] };
    if (timeline) {
      const { from, to } = samplesInRange(timeline, e.ts, e.ts + e.dur);
      const a = attributeSamples(timeline, from, to);
      rec.top = [...a.selfByKey.values()]
        .sort((x, y) => y.hits - x.hits)
        .slice(0, 5)
        .map((v) => ({ fn: v.fn, module: moduleLabel(v.url), origin: v.origin, ms: v.hits * msPerSample }));
    }
    hitches.push(rec);
  }
  return hitches.sort((a, b) => b.durMs - a.durMs);
}

/** Which trace categories are present — and which useful ones are NOT. */
export function categoryReport(events) {
  const cats = new Map();
  for (const e of events) {
    if (!e.cat) continue;
    for (const c of e.cat.split(',')) cats.set(c, (cats.get(c) || 0) + 1);
  }
  const present = [...cats.entries()].sort((a, b) => b[1] - a[1]);
  const wanted = [
    {
      pattern: /gpu\.dawn|disabled-by-default-gpu/,
      label: 'Dawn/WebGPU GPU-side passes',
      unlocks: 'per-RENDER-PASS GPU attribution',
    },
    {
      pattern: /disabled-by-default-v8\.cpu_profiler/,
      label: 'V8 CPU profiler (JS Profiling)',
      unlocks: 'JS function attribution',
    },
    {
      pattern: /disabled-by-default-devtools\.screenshot/,
      label: 'Screenshots',
      unlocks: 'visual correlation of hitches',
    },
  ];
  const blindSpots = wanted
    .filter((w) => !present.some(([c]) => w.pattern.test(c)))
    .map((w) => ({ label: w.label, unlocks: w.unlocks }));
  return { present, blindSpots };
}

/** Read a trace from `.json` or `.json.gz`. */
export function loadTrace(path) {
  const size = statSync(path).size;
  const buf = readFileSync(path);
  const json = path.endsWith('.gz') ? gunzipSync(buf) : buf;
  let data;
  try {
    data = JSON.parse(json.toString('utf8'));
  } catch (err) {
    throw new Error(
      `trace-analyze: could not parse ${path} (${(size / 1e6).toFixed(1)} MB). ` +
        `If this is a heap failure, re-run with: node --max-old-space-size=8192 tools/trace-analyze.mjs ...\n${err.message}`
    );
  }
  const events = Array.isArray(data) ? data : data.traceEvents;
  if (!Array.isArray(events))
    throw new Error(`trace-analyze: ${path} has no traceEvents array — not a DevTools trace.`);
  return { events, metadata: Array.isArray(data) ? null : data.metadata, fileSizeMb: size / 1e6 };
}

/** The whole analysis, as data. Rendering is separate so a test can assert on facts. */
export function analyzeTrace({ events, metadata, fileSizeMb }, label = 'trace') {
  const win = traceWindow(events, metadata);
  const { procNames, threadNames } = readThreadNames(events);
  const mainThreadKeys = new Set(
    [...threadNames.entries()].filter(([, n]) => /CrRendererMain/i.test(n)).map(([k]) => k)
  );
  const gpuPids = new Set([...procNames.entries()].filter(([, n]) => /gpu process/i.test(n)).map(([pid]) => pid));

  const artifact = detectProfilerArtifact(events, win, mainThreadKeys);
  const effectiveWindowMs = win.durationMs - (artifact ? artifact.durMs : 0);

  const timeline = buildSampleTimeline(events);
  const hasSamples = timeline.sampleCount > 0;
  // Sampling is periodic, so one sample represents (measured window / sample
  // count) of wall time. Derived from THIS trace rather than assuming Chrome's
  // nominal 1 ms — a busy main thread does not sample on a perfect cadence.
  const sampleSpanMs = hasSamples ? (timeline.times[timeline.times.length - 1] - timeline.times[0]) / 1000 : 0;
  const msPerSample = hasSamples && timeline.sampleCount > 1 ? sampleSpanMs / timeline.sampleCount : 0;

  const rendererUtil = threadUtilization(
    events,
    win,
    threadNames,
    (e) => mainThreadKeys.has(`${e.pid}:${e.tid}`),
    artifact
  );
  const gpuUtil = threadUtilization(events, win, threadNames, (e) => gpuPids.has(e.pid), artifact);

  const drawFrames = events.filter((e) => e.name === 'DrawFrame').length;
  const frames = buildFrames(events, win, mainThreadKeys, hasSamples ? timeline : null, artifact);
  const frameDurs = frames.map((f) => f.durMs).sort((a, b) => a - b);
  const gaps = frames
    .map((f) => f.gapMs)
    .filter((g) => typeof g === 'number' && g > 0)
    .sort((a, b) => a - b);

  const hitches = findHitches(events, win, mainThreadKeys, hasSamples ? timeline : null, artifact, msPerSample);
  const raf = attributeRafCallbacks(events, win, mainThreadKeys, hasSamples ? timeline : null, artifact);
  const slowFast = hasSamples ? diffSlowVsFast(frames, timeline, msPerSample) : null;

  // Whole-window self/total attribution, excluding the artifact's sample range.
  let wholeSelf = null;
  let wholeTotals = null;
  let originSplit = null;
  if (hasSamples) {
    const excl = artifact ? samplesInRange(timeline, artifact.startUs, artifact.endUs) : null;
    const from = excl ? excl.to : 0;
    const a = attributeSamples(timeline, from, timeline.sampleCount);
    wholeSelf = [...a.selfByKey.values()]
      .map((v) => ({ ...v, module: moduleLabel(v.url), ms: v.hits * msPerSample, pct: (v.hits / a.counted) * 100 }))
      .sort((x, y) => y.hits - x.hits);
    originSplit = [...a.byOrigin.entries()]
      .map(([origin, hits]) => ({ origin, hits, pct: (hits / a.counted) * 100, ms: hits * msPerSample }))
      .sort((x, y) => y.hits - x.hits);
    const totals = attributeTotals(timeline, from, timeline.sampleCount);
    wholeTotals = [...totals.values()]
      .map((v) => ({ ...v, module: moduleLabel(v.url), ms: v.hits * msPerSample, pct: (v.hits / a.counted) * 100 }))
      .sort((x, y) => y.hits - x.hits);
  }

  const cats = categoryReport(events);

  return {
    label,
    file: { sizeMb: fileSizeMb, events: events.length },
    window: { ...win, effectiveWindowMs },
    artifact,
    processes: [...procNames.entries()].map(([pid, name]) => ({ pid, name })),
    presented: {
      drawFrames,
      fps: drawFrames / (effectiveWindowMs / 1000),
    },
    frames: {
      count: frames.length,
      meanMs: mean(frameDurs),
      p50Ms: percentile(frameDurs, 0.5),
      p90Ms: percentile(frameDurs, 0.9),
      p99Ms: percentile(frameDurs, 0.99),
      maxMs: frameDurs.length ? frameDurs[frameDurs.length - 1] : null,
      slowFrames: frameDurs.filter((d) => d >= SLOW_FRAME_MS).length,
      gap: {
        p50Ms: percentile(gaps, 0.5),
        p90Ms: percentile(gaps, 0.9),
        p99Ms: percentile(gaps, 0.99),
        maxMs: gaps.length ? gaps[gaps.length - 1] : null,
        impliedP50Fps: percentile(gaps, 0.5) ? 1000 / percentile(gaps, 0.5) : null,
      },
    },
    cpu: { rendererUtil, gpuUtil },
    hitches: { count: hitches.length, top: hitches.slice(0, 20) },
    raf,
    slowFast,
    profile: {
      hasSamples,
      sampleCount: timeline.sampleCount,
      msPerSample,
      originSplit,
      topSelf: wholeSelf ? wholeSelf.slice(0, 30) : null,
      topTotal: wholeTotals ? wholeTotals.slice(0, 30) : null,
    },
    categories: cats,
  };
}

const f2 = (n) => (n == null ? 'n/a' : n.toFixed(2));
const f1 = (n) => (n == null ? 'n/a' : n.toFixed(1));

/** Render the analysis as Markdown. */
export function renderMarkdown(a) {
  const L = [];
  L.push(`# Chrome trace analysis — ${a.label}`);
  L.push('');
  L.push(
    `**${f1(a.window.durationMs)} ms window** · ${a.file.events.toLocaleString()} events · ${f1(a.file.sizeMb)} MB · ` +
      `window source: \`${a.window.source}\``
  );
  L.push('');

  if (a.artifact) {
    L.push(
      `> ⚠️ **Profiler-attach artifact excluded:** a ${f1(a.artifact.durMs)} ms main-thread task at ` +
        `t=${f1(a.artifact.tsRelMs)} ms contained \`CpuProfiler::StartProfiling\` (${f1(a.artifact.profilerMs)} ms). ` +
        `This is the JS profiler attaching, **not** engine jank. Every number below excludes it; ` +
        `effective window ${f1(a.window.effectiveWindowMs)} ms.`
    );
    L.push('');
  }

  L.push('## Verdict');
  L.push('');
  const mainT = a.cpu.rendererUtil[0];
  const gpuT = a.cpu.gpuUtil.find((t) => /CrGpuMain/i.test(t.thread)) ?? a.cpu.gpuUtil[0];
  L.push(`| Metric | Value |`);
  L.push(`|---|---|`);
  L.push(`| Presented frames | ${a.presented.drawFrames} → **${f1(a.presented.fps)} fps** |`);
  L.push(`| Main thread (\`CrRendererMain\`) busy | **${f1(mainT?.utilizationPct)}%** (${f1(mainT?.busyMs)} ms) |`);
  L.push(`| GPU submission (\`CrGpuMain\`) busy | **${f1(gpuT?.utilizationPct)}%** (${f1(gpuT?.busyMs)} ms) |`);
  L.push(
    `| Frame service p50 / p99 / max | ${f2(a.frames.p50Ms)} / ${f2(a.frames.p99Ms)} / ${f2(a.frames.maxMs)} ms |`
  );
  L.push(
    `| Felt cadence p50 / p99 / max | ${f2(a.frames.gap.p50Ms)} / ${f2(a.frames.gap.p99Ms)} / ${f2(a.frames.gap.maxMs)} ms |`
  );
  L.push(`| Hitches >${HITCH_MS}ms (excl. artifact) | ${a.hitches.count} |`);
  L.push('');
  if (mainT && gpuT) {
    const verdict =
      gpuT.utilizationPct > mainT.utilizationPct + 15
        ? `**GPU-submission-bound.** The GPU thread is ${f1(gpuT.utilizationPct - mainT.utilizationPct)} points busier than the main thread; CPU has real headroom.`
        : mainT.utilizationPct > gpuT.utilizationPct + 15
          ? `**CPU-bound.** The main thread is the busier of the two.`
          : `**Mixed / neither dominates.** Main ${f1(mainT.utilizationPct)}% vs GPU ${f1(gpuT.utilizationPct)}% — within 15 points.`;
    L.push(verdict);
    L.push('');
  }

  if (a.slowFast) {
    L.push('## What SLOW frames do that fast ones do not');
    L.push('');
    L.push(
      `Split at the ${f2(a.slowFast.cutoffMs)} ms frame: **${a.slowFast.slow.frames} slow** ` +
        `(mean ${f2(a.slowFast.slow.meanMs)} ms) vs **${a.slowFast.fast.frames} fast** (mean ${f2(a.slowFast.fast.meanMs)} ms). ` +
        `Ranked by extra ms PER FRAME — work that costs the same in both buckets explains nothing.`
    );
    L.push('');
    L.push('| Δ ms/frame | slow | fast | function | module | origin |');
    L.push('|---:|---:|---:|---|---|---|');
    for (const d of a.slowFast.topDeltas.slice(0, 15)) {
      if (d.deltaMsPerFrame <= 0.001) continue;
      L.push(
        `| **+${f2(d.deltaMsPerFrame)}** | ${f2(d.slowMsPerFrame)} | ${f2(d.fastMsPerFrame)} | \`${d.fn}\` | ${d.module}${d.line != null ? `:${d.line}` : ''} | ${d.origin} |`
      );
    }
    L.push('');
    L.push('By origin:');
    L.push('');
    L.push('| Δ ms/frame | slow | fast | origin |');
    L.push('|---:|---:|---:|---|');
    for (const o of a.slowFast.originDelta) {
      L.push(`| ${f2(o.deltaMsPerFrame)} | ${f2(o.slowMsPerFrame)} | ${f2(o.fastMsPerFrame)} | ${o.origin} |`);
    }
    L.push('');
  }

  if (a.profile.originSplit) {
    L.push('## Where main-thread JS time goes (whole window)');
    L.push('');
    L.push(`${a.profile.sampleCount.toLocaleString()} samples · ${f2(a.profile.msPerSample)} ms/sample.`);
    L.push('');
    L.push('| % | ms | origin |');
    L.push('|---:|---:|---|');
    for (const o of a.profile.originSplit) L.push(`| ${f1(o.pct)}% | ${f1(o.ms)} | ${o.origin} |`);
    L.push('');
    L.push('### Top self-time (leaf) — where the CPU is actually executing');
    L.push('');
    L.push('| % | ms | function | module | origin |');
    L.push('|---:|---:|---|---|---|');
    for (const s of a.profile.topSelf.slice(0, 20)) {
      L.push(
        `| ${f1(s.pct)}% | ${f1(s.ms)} | \`${s.fn}\` | ${s.module}${s.line != null ? `:${s.line}` : ''} | ${s.origin} |`
      );
    }
    L.push('');
    const ourTotals = a.profile.topTotal.filter((t) => t.origin === 'msa' || t.origin === 'three-vendor');
    if (ourTotals.length) {
      L.push('### Top TOTAL time in our own code (self + everything it calls)');
      L.push('');
      L.push('| % | ms | function | module | origin |');
      L.push('|---:|---:|---|---|---|');
      for (const s of ourTotals.slice(0, 20)) {
        L.push(
          `| ${f1(s.pct)}% | ${f1(s.ms)} | \`${s.fn}\` | ${s.module}${s.line != null ? `:${s.line}` : ''} | ${s.origin} |`
        );
      }
      L.push('');
    }
  }

  L.push('## rAF callbacks — how many real loops are running?');
  L.push('');
  L.push(
    `${a.raf.total.toLocaleString()} \`FireAnimationFrame\` callbacks against ${a.frames.count.toLocaleString()} frame services ` +
      `(${f2(a.raf.total / Math.max(1, a.frames.count))} callbacks per frame), grouped by dominant module:`
  );
  L.push('');
  L.push('| total ms | count | max ms | dominant module |');
  L.push('|---:|---:|---:|---|');
  for (const g of a.raf.groups.slice(0, 12)) {
    L.push(`| ${f1(g.sumMs)} | ${g.count} | ${f2(g.maxMs)} | ${g.label} |`);
  }
  L.push('');

  if (a.hitches.count) {
    L.push(`## Hitches >${HITCH_MS} ms (${a.hitches.count} total)`);
    L.push('');
    L.push('| at (ms) | dur (ms) | dominant JS |');
    L.push('|---:|---:|---|');
    for (const h of a.hitches.top.slice(0, 15)) {
      const top = h.top
        .slice(0, 3)
        .map((t) => `\`${t.fn}\` (${t.module}, ${f1(t.ms)}ms)`)
        .join(' · ');
      L.push(`| ${f1(h.tsRelMs)} | **${f1(h.durMs)}** | ${top || '_no samples_'} |`);
    }
    L.push('');
  }

  L.push('## Blind spots — what this capture CANNOT answer');
  L.push('');
  if (a.categories.blindSpots.length) {
    for (const b of a.categories.blindSpots) L.push(`- **${b.label}** not recorded → no ${b.unlocks}.`);
  } else {
    L.push('- All expected categories present.');
  }
  L.push(
    `- **No per-render-pass GPU attribution** is possible from any standard DevTools capture. GPU busy% above is real; ` +
      `mapping it to \`geometry.worldDraw\` / \`pass.light.accumulate\` requires MSA's own timestamp-query zone timer.`
  );
  L.push('- Sampling profiler: self-time under ~0.2% is at the noise floor and should not be acted on alone.');
  L.push('');
  return L.join('\n');
}

/** Compare two analyses on the metrics that decide "did it get better?". */
export function renderComparison(base, cand) {
  const L = [];
  L.push(`# Trace comparison — ${base.label} → ${cand.label}`);
  L.push('');
  const rows = [
    ['Presented fps', base.presented.fps, cand.presented.fps, 'higher'],
    ['Main thread busy %', base.cpu.rendererUtil[0]?.utilizationPct, cand.cpu.rendererUtil[0]?.utilizationPct, 'lower'],
    [
      'GPU submit busy %',
      base.cpu.gpuUtil.find((t) => /CrGpuMain/i.test(t.thread))?.utilizationPct,
      cand.cpu.gpuUtil.find((t) => /CrGpuMain/i.test(t.thread))?.utilizationPct,
      'lower',
    ],
    ['Frame p50 ms', base.frames.p50Ms, cand.frames.p50Ms, 'lower'],
    ['Frame p99 ms', base.frames.p99Ms, cand.frames.p99Ms, 'lower'],
    ['Hitches', base.hitches.count, cand.hitches.count, 'lower'],
  ];
  L.push('| Metric | baseline | candidate | change |');
  L.push('|---|---:|---:|---|');
  for (const [name, b, c, better] of rows) {
    if (b == null || c == null) {
      L.push(`| ${name} | n/a | n/a | — |`);
      continue;
    }
    const delta = c - b;
    const improved = better === 'higher' ? delta > 0 : delta < 0;
    const pct = b !== 0 ? (delta / b) * 100 : 0;
    L.push(
      `| ${name} | ${f2(b)} | ${f2(c)} | ${improved ? '✅' : '❌'} ${delta > 0 ? '+' : ''}${f2(delta)} (${f1(pct)}%) |`
    );
  }
  L.push('');
  L.push(
    '> ⚠️ Two captures are only comparable if the scene, floor, route and machine load matched. ' +
      'Harness/live numbers are DIRECTIONAL unless the machine was otherwise idle ' +
      "(the standing rule from the Testament's P-003 resolution)."
  );
  L.push('');
  return L.join('\n');
}

function parseArgs(argv) {
  const out = { positional: [], json: null, md: null, compare: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = argv[++i];
    else if (a === '--md') out.md = argv[++i];
    else if (a === '--compare') out.compare = argv[++i];
    else out.positional.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.positional.length) {
    console.error(
      'usage: node tools/trace-analyze.mjs <trace.json|.gz> [--compare other.json] [--json out] [--md out]'
    );
    process.exit(1);
  }
  const path = args.positional[0];
  const base = analyzeTrace(loadTrace(path), path.split(/[\\/]/).pop());
  let md;
  if (args.compare) {
    const cand = analyzeTrace(loadTrace(args.compare), args.compare.split(/[\\/]/).pop());
    md = renderComparison(base, cand) + '\n' + renderMarkdown(cand);
    if (args.json) writeFileSync(args.json, JSON.stringify({ base, cand }, null, 2));
  } else {
    md = renderMarkdown(base);
    if (args.json) writeFileSync(args.json, JSON.stringify(base, null, 2));
  }
  if (args.md) writeFileSync(args.md, md);
  console.log(md);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
