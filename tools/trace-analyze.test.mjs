/**
 * Tests for tools/trace-analyze.mjs.
 *
 * The three measurement bugs in that file's header were all made BY HAND while
 * reading a real trace, and all three produced a plausible-looking report. Each
 * one gets a test that would fail if the mechanism preventing it were removed —
 * these are regression pins on the INSTRUMENT, which this project has been
 * burned by before (memory: feedback_instruments_must_not_lie).
 *
 * @module tools/trace-analyze.test
 */

import {
  classifyUrl,
  moduleLabel,
  mergeIntervals,
  assertUtilizationSane,
  percentile,
  traceWindow,
  detectProfilerArtifact,
  buildSampleTimeline,
  samplesInRange,
  ancestorChain,
  attributeTotals,
  attributeSamples,
  buildFrames,
  categoryReport,
  ORIGINS,
  FRAME_SPAN_NAME,
} from './trace-analyze.mjs';

const MSA = 'https://mythicamachina.com/modules/map-shine-advanced/src/effects/lighting/point-light-pool.js';
const VENDORED_THREE = 'https://mythicamachina.com/modules/map-shine-advanced/src/vendor/three/three.webgpu.js';
const FOUNDRY = 'https://mythicamachina.com/scripts/foundry.mjs';
const EXT = 'chrome-extension://hdokiejnpimakedhajhdlcegeplioahd/web-client-content-script.js';

export function run(t) {
  // ── classifyUrl: the ordering trap ────────────────────────────────────────
  t.ok('classifyUrl: MSA source is msa', classifyUrl(MSA) === 'msa');
  t.ok('classifyUrl: extension is extension', classifyUrl(EXT) === 'extension');
  t.ok('classifyUrl: foundry is foundry', classifyUrl(FOUNDRY) === 'foundry');
  t.ok('classifyUrl: empty url is browser-internal', classifyUrl('') === 'browser-internal');
  // THE LOAD-BEARING ONE. The vendored three URL contains BOTH 'map-shine-advanced'
  // and '/vendor/three/'. If the msa test ran first, every millisecond of
  // three.js's renderer would be billed to our own code — the single most
  // misleading thing this tool could do, since three IS the biggest cost centre.
  t.ok('classifyUrl: vendored three is NOT billed to msa', classifyUrl(VENDORED_THREE) === 'three-vendor');
  t.ok(
    'classifyUrl: every result is in the closed ORIGINS list',
    [MSA, VENDORED_THREE, FOUNDRY, EXT, '', 'weird'].every((u) => ORIGINS.includes(classifyUrl(u)))
  );

  t.ok('moduleLabel: last segment', moduleLabel(MSA) === 'point-light-pool.js');
  t.ok('moduleLabel: strips query', moduleLabel(`${MSA}?v=2`) === 'point-light-pool.js');
  t.ok('moduleLabel: empty is browser internal', moduleLabel('') === '(browser internal)');

  // ── mergeIntervals: measurement bug 1 ─────────────────────────────────────
  t.ok('mergeIntervals: empty is 0', mergeIntervals([]) === 0);
  t.ok('mergeIntervals: single', mergeIntervals([[0, 10]]) === 10);
  t.ok(
    'mergeIntervals: disjoint sums',
    mergeIntervals([
      [0, 10],
      [20, 30],
    ]) === 20
  );
  // A parent RunTask [0,100) containing GPUTask [10,50) and [60,90): summing
  // durations gives 100+40+30 = 170 (the 174.6% bug). Merging gives 100.
  t.ok(
    'mergeIntervals: NESTED children do not double-count',
    mergeIntervals([
      [0, 100],
      [10, 50],
      [60, 90],
    ]) === 100
  );
  t.ok(
    'mergeIntervals: partial overlap merges',
    mergeIntervals([
      [0, 10],
      [5, 20],
    ]) === 20
  );
  t.ok(
    'mergeIntervals: unsorted input',
    mergeIntervals([
      [20, 30],
      [0, 10],
    ]) === 20
  );
  t.ok(
    'mergeIntervals: touching intervals merge',
    mergeIntervals([
      [0, 10],
      [10, 20],
    ]) === 20
  );

  t.ok('assertUtilizationSane: passes 99%', assertUtilizationSane('x', 99) === 99);
  t.ok('assertUtilizationSane: tolerates float slop at 100.2', assertUtilizationSane('x', 100.2) === 100.2);
  let threw = false;
  try {
    assertUtilizationSane('CrGpuMain', 174.6);
  } catch {
    threw = true;
  }
  t.ok('assertUtilizationSane: THROWS on the impossible 174.6% figure', threw);

  // ── percentile ────────────────────────────────────────────────────────────
  t.ok('percentile: empty is null', percentile([], 0.5) === null);
  t.ok('percentile: p50 of 1..10', percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5) === 5);
  t.ok('percentile: p100 is max', percentile([1, 2, 3], 1) === 3);
  t.ok('percentile: p0 is min', percentile([1, 2, 3], 0) === 1);

  // ── traceWindow: measurement bug 2 ────────────────────────────────────────
  // A ts:0 metadata event alongside real events at ts=1000..2000.
  const withMeta = [
    { ph: 'M', name: 'process_name', ts: 0, pid: 1, args: { name: 'Renderer' } },
    { ph: 'X', name: 'RunTask', ts: 1000, dur: 500, pid: 1, tid: 2 },
    { ph: 'X', name: 'RunTask', ts: 1800, dur: 200, pid: 1, tid: 2 },
  ];
  const wNoBreadcrumb = traceWindow(withMeta, null);
  t.ok(
    'traceWindow: ts:0 metadata does NOT drag the window to the epoch',
    wNoBreadcrumb.startUs === 1000 && wNoBreadcrumb.durationMs === 1
  );
  const wBreadcrumb = traceWindow(withMeta, {
    modifications: { initialBreadcrumb: { window: { min: 900, max: 2100 } } },
  });
  t.ok(
    'traceWindow: prefers the DevTools breadcrumb',
    wBreadcrumb.source === 'devtools-breadcrumb' && wBreadcrumb.durationMs === 1.2
  );
  t.ok('traceWindow: still reports observed span for cross-check', Math.abs(wBreadcrumb.observedDurationMs - 1) < 1e-9);

  // ── detectProfilerArtifact: measurement bug 3 ─────────────────────────────
  const mainKeys = new Set(['1:2']);
  const win = { startUs: 0, durationMs: 10000 };
  const artifactEvents = [
    { ph: 'X', name: 'RunTask', ts: 0, dur: 1_187_425, pid: 1, tid: 2 },
    { ph: 'X', name: 'CpuProfiler::StartProfiling', ts: 66, dur: 1_155_527, pid: 1, tid: 2 },
  ];
  const found = detectProfilerArtifact(artifactEvents, win, mainKeys);
  t.ok('detectProfilerArtifact: finds the attach task', found !== null && Math.abs(found.durMs - 1187.425) < 1e-6);
  t.ok(
    'detectProfilerArtifact: reports the profiler cost inside it',
    found && Math.abs(found.profilerMs - 1155.527) < 1e-6
  );

  // SABOTAGE: a genuine long task early in the trace, with NO profiler span
  // inside it, must NOT be discarded — otherwise this becomes a blunt "ignore
  // the first second" rule that hides real first-frame cost.
  const genuineHitch = [{ ph: 'X', name: 'RunTask', ts: 0, dur: 900_000, pid: 1, tid: 2 }];
  t.ok(
    'detectProfilerArtifact: a real early hitch with no profiler inside is NOT discarded',
    detectProfilerArtifact(genuineHitch, win, mainKeys) === null
  );
  // A profiler span that starts AFTER the task ends is not contained by it.
  const notContained = [
    { ph: 'X', name: 'RunTask', ts: 0, dur: 100_000, pid: 1, tid: 2 },
    { ph: 'X', name: 'CpuProfiler::StartProfiling', ts: 500_000, dur: 1000, pid: 1, tid: 2 },
  ];
  t.ok(
    'detectProfilerArtifact: requires real containment',
    detectProfilerArtifact(notContained, win, mainKeys) === null
  );
  // A long task on a NON-main thread is not the main-thread artifact.
  t.ok(
    'detectProfilerArtifact: ignores other threads',
    detectProfilerArtifact(artifactEvents, win, new Set(['9:9'])) === null
  );

  // ── sample timeline + range queries ───────────────────────────────────────
  const profileEvents = [
    { name: 'Profile', args: { data: { startTime: 1000 } } },
    {
      name: 'ProfileChunk',
      ts: 1000,
      args: {
        data: {
          cpuProfile: {
            nodes: [
              { id: 1, callFrame: { functionName: 'root', url: '' } },
              { id: 2, parent: 1, callFrame: { functionName: 'renderFrame', url: MSA, lineNumber: 10 } },
              { id: 3, parent: 2, callFrame: { functionName: 'drawLights', url: MSA, lineNumber: 20 } },
              { id: 4, parent: 2, callFrame: { functionName: 'threeRender', url: VENDORED_THREE, lineNumber: 5 } },
            ],
            samples: [3, 3, 4, 4],
          },
          timeDeltas: [100, 100, 100, 100],
        },
      },
    },
  ];
  const tl = buildSampleTimeline(profileEvents);
  t.ok('buildSampleTimeline: counts samples', tl.sampleCount === 4);
  t.ok('buildSampleTimeline: cumulative timestamps from startTime', tl.times[0] === 1100 && tl.times[3] === 1400);
  t.ok('samplesInRange: full range', samplesInRange(tl, 0, 99999).count === 4);
  t.ok('samplesInRange: partial range', samplesInRange(tl, 1100, 1300).count === 2);
  t.ok('samplesInRange: empty range', samplesInRange(tl, 5000, 6000).count === 0);

  t.ok('ancestorChain: walks to root', ancestorChain(tl.nodesById, 3).join(',') === '3,2,1');

  const attr = attributeSamples(tl, 0, 4);
  t.ok('attributeSamples: counts all', attr.counted === 4);
  t.ok(
    'attributeSamples: splits msa vs three-vendor',
    attr.byOrigin.get('msa') === 2 && attr.byOrigin.get('three-vendor') === 2
  );

  // Total time: renderFrame is a LEAF in zero samples but an ancestor of all 4,
  // so its inclusive time is 4 — the whole point of measuring totals, since a
  // render loop's own self-time is always near zero.
  const totals = attributeTotals(tl, 0, 4);
  const renderFrameTotal = [...totals.values()].find((v) => v.fn === 'renderFrame');
  t.ok('attributeTotals: an ancestor gets full inclusive credit', renderFrameTotal?.hits === 4);
  const drawLightsTotal = [...totals.values()].find((v) => v.fn === 'drawLights');
  t.ok('attributeTotals: a leaf gets only its own samples', drawLightsTotal?.hits === 2);

  // Recursion must be charged once per sample, not once per stack level.
  const recursive = [
    { name: 'Profile', args: { data: { startTime: 0 } } },
    {
      name: 'ProfileChunk',
      ts: 0,
      args: {
        data: {
          cpuProfile: {
            nodes: [
              { id: 1, callFrame: { functionName: 'walk', url: MSA, lineNumber: 1 } },
              { id: 2, parent: 1, callFrame: { functionName: 'walk', url: MSA, lineNumber: 1 } },
              { id: 3, parent: 2, callFrame: { functionName: 'walk', url: MSA, lineNumber: 1 } },
            ],
            samples: [3],
          },
          timeDeltas: [10],
        },
      },
    },
  ];
  const recTl = buildSampleTimeline(recursive);
  const recTotals = attributeTotals(recTl, 0, 1);
  const walk = [...recTotals.values()].find((v) => v.fn === 'walk');
  t.ok('attributeTotals: recursion charged ONCE per sample, not per level', walk?.hits === 1);

  // ── frame segmentation ────────────────────────────────────────────────────
  const frameEvents = [
    { ph: 'X', name: FRAME_SPAN_NAME, ts: 1000, dur: 8000, pid: 1, tid: 2 },
    { ph: 'X', name: FRAME_SPAN_NAME, ts: 17000, dur: 30000, pid: 1, tid: 2 },
    { ph: 'X', name: 'FireAnimationFrame', ts: 1100, dur: 500, pid: 1, tid: 2 },
    { ph: 'X', name: FRAME_SPAN_NAME, ts: 60000, dur: 5000, pid: 9, tid: 9 },
  ];
  const built = buildFrames(frameEvents, { startUs: 0 }, mainKeys, null, null);
  t.ok('buildFrames: only frame spans, only main thread', built.length === 2);
  t.ok('buildFrames: durations in ms', built[0].durMs === 8 && built[1].durMs === 30);
  t.ok('buildFrames: gap measured start-to-start', built[1].gapMs === 16);
  const excluded = buildFrames(frameEvents, { startUs: 0 }, mainKeys, null, { startUs: 0, endUs: 2000, durMs: 2 });
  t.ok('buildFrames: honours the artifact exclusion', excluded.length === 1 && excluded[0].durMs === 30);

  // ── blind spots ───────────────────────────────────────────────────────────
  const cats = categoryReport([
    { cat: 'devtools.timeline', name: 'a' },
    { cat: 'disabled-by-default-v8.cpu_profiler', name: 'b' },
  ]);
  t.ok('categoryReport: counts present categories', cats.present.length === 2);
  t.ok(
    'categoryReport: names the MISSING Dawn category as a blind spot',
    cats.blindSpots.some((b) => /Dawn/i.test(b.label))
  );
  t.ok(
    'categoryReport: does not flag a category that IS present',
    !cats.blindSpots.some((b) => /CPU profiler/i.test(b.label))
  );
}
