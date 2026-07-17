/**
 * THE FLIGHT RECORDER'S OWN VERIFICATION.
 *
 * The recorder is a diagnostic, and this project has an expensive history with
 * diagnostics that lie (memory: `feedback_instruments_must_not_lie` — five
 * self-deceiving instruments in one session). So the assertions below lean hard
 * on the ways THIS instrument could quietly deceive:
 *
 *  - a ring that drops entries and reports a tidy number as if it were complete
 *  - a frame histogram that silently mis-buckets, making a bad session look fine
 *  - sampling that eats the hitches — the one thing being hunted
 *  - a bundle that runs a side-effecting "report" and restarts the author's scene
 *  - a `JSON.stringify` that throws on one circular report and takes the whole
 *    export down with it
 *
 * Every timing behaviour is provable here because the clock is injected — no
 * waiting, no flakes, no `setTimeout` in a test.
 *
 * @module diag/__tests__/flight-recorder.test
 */

import { createFlightRecorder, toJsonSafe, runAllReports, bundleFilename } from '../flight-recorder.js';
import { setLogSink, setLogLevel, createLogger, LogLevel } from '../../core/log.js';

/** A controllable clock. @returns {{now: () => number, advance: (ms:number) => void}} */
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** @param {object} [opts] */
function makeRecorder(opts = {}) {
  const clock = fakeClock();
  const recorder = createFlightRecorder({
    now: clock.now,
    wallClock: () => new Date('2026-07-17T12:00:00.000Z'),
    ...opts,
  });
  return { recorder, clock };
}

export async function run(t) {
  // ---- the log ring ------------------------------------------------------
  {
    const { recorder } = makeRecorder({ limits: { logEntries: 3 } });
    for (let i = 0; i < 5; i++) recorder.log({ level: 'info', message: `line ${i}` });
    const snap = recorder.snapshot();

    t.ok('ring keeps only its capacity', snap.log.kept === 3);
    t.ok('ring keeps the MOST RECENT entries', snap.log.items.at(-1).message === 'line 4');
    // The headline: a truncated log must never present itself as complete.
    t.ok('ring REPORTS what it dropped', snap.log.dropped === 2);
    t.ok('ring says so in prose too', /2 older entries were dropped/.test(snap.log.note));
  }
  {
    const { recorder } = makeRecorder({ limits: { logEntries: 10 } });
    recorder.log({ level: 'info', message: 'only one' });
    const snap = recorder.snapshot();
    t.ok('an undropped ring says it is COMPLETE', /complete log/.test(snap.log.note));
    t.ok('...and never claims a drop it did not have', snap.log.dropped === 0);
  }
  {
    const { recorder } = makeRecorder();
    recorder.log({ level: 'warn', message: 'a', source: 'foreign' });
    recorder.log({ level: 'error', message: 'b', source: 'foreign' });
    recorder.log({ level: 'info', message: 'c' });
    const snap = recorder.snapshot();
    t.ok('counts by level', snap.log.counts.warn === 1 && snap.log.counts.error === 1 && snap.log.counts.info === 1);
    // The author chose "everything, tagged by source" — the tag has to be real.
    t.ok('counts by SOURCE (msa vs foreign)', snap.log.bySource.foreign === 2 && snap.log.bySource.msa === 1);
    t.ok('defaults source to msa', snap.log.items.at(-1).source === 'msa');
  }
  {
    // A recorder that can break the thing it records is worse than no recorder.
    const { recorder } = makeRecorder();
    const hostile = {
      get boom() {
        throw new Error('hostile getter');
      },
    };
    let threw = false;
    try {
      recorder.log({ level: 'info', message: 'x', data: hostile });
    } catch (e) {
      threw = true;
    }
    t.ok('log() never throws into its caller', !threw);
    // ...but it must not swallow silently either.
    const snap = recorder.snapshot();
    const survived = snap.log.items.at(-1)?.message === 'x';
    t.ok(
      'a hostile getter is either recorded safely or COUNTED as a failure',
      survived || snap.log.recorderFailures === 1
    );
  }

  // ---- load spans --------------------------------------------------------
  {
    const { recorder, clock } = makeRecorder();
    recorder.beginSpan('scene');
    clock.advance(12);
    const dur = recorder.endSpan('scene');
    t.ok('endSpan returns the measured duration', dur === 12);
    const snap = recorder.snapshot();
    t.ok('the span is recorded with its duration', snap.load.items[0].durMs === 12);
    t.ok('the span is named', snap.load.items[0].name === 'scene');
  }
  {
    const { recorder, clock } = makeRecorder();
    recorder.beginSpan('art', { items: 7 });
    clock.advance(2400);
    recorder.endSpan('art', { done: 7 });
    const span = recorder.snapshot().load.items[0];
    t.ok('a long span measures correctly', span.durMs === 2400);
    t.ok('span meta merges begin + end', span.meta.items === 7 && span.meta.done === 7);
  }
  {
    // An abandoned span is EVIDENCE (something restarted mid-load), not litter.
    const { recorder, clock } = makeRecorder();
    recorder.beginSpan('art');
    clock.advance(5);
    recorder.beginSpan('art'); // re-opened without closing
    const snap = recorder.snapshot();
    t.ok('re-opening a span closes the old one rather than dropping it', snap.load.items.length === 1);
    t.ok('...and marks it superseded', snap.load.items[0].meta?.superseded === true);
  }
  {
    // `skipped: []` must mean "nothing was skipped", never "I did not look".
    const { recorder } = makeRecorder();
    const dur = recorder.endSpan('never-opened');
    t.ok('closing an unopened span returns null', dur === null);
    const snap = recorder.snapshot();
    t.ok('...and is RECORDED as unmatched, not ignored', snap.load.items[0].unmatched === true);
  }
  {
    // Exporting mid-load is exactly when someone reaches for the button.
    const { recorder, clock } = makeRecorder();
    recorder.beginSpan('art');
    clock.advance(9000);
    const snap = recorder.snapshot();
    t.ok('a still-open span is surfaced at export', snap.load.openAtExport.length === 1);
    t.ok('...with how long it has been hanging', snap.load.openAtExport[0].openForMs === 9000);
    t.ok('...and named', snap.load.openAtExport[0].name === 'art');
  }

  // ---- frames: histogram over EVERY frame ---------------------------------
  {
    const { recorder } = makeRecorder({ frameSampleEvery: 10 });
    // 100 frames at a steady 16ms (a 60fps session).
    let t0 = 0;
    for (let i = 0; i < 100; i++) {
      t0 += 16;
      recorder.recordFrame(t0);
    }
    const f = recorder.snapshot().frames;
    t.ok('every frame is counted', f.total === 100);
    const bucket60 = f.histogram.find((b) => b.label === '60-120fps');
    // 99 gaps from 100 frames — the first frame has no predecessor.
    t.ok('the histogram buckets a 16ms frame as 60-120fps', bucket60.frames === 99);
    t.ok('the histogram is a PERCENTAGE of counted frames', bucket60.percent === 100);
    t.ok('avg gap is exact', f.avgGapMs === 16);
    t.ok('avg fps is derived from the real average', f.avgFps === 62.5);
  }
  {
    const { recorder } = makeRecorder();
    let t0 = 0;
    for (const gap of [8, 20, 40, 60, 120, 300, 1200]) {
      t0 += gap;
      recorder.recordFrame(t0);
    }
    const h = Object.fromEntries(recorder.snapshot().frames.histogram.map((b) => [b.label, b.frames]));
    // The first recordFrame establishes the baseline; 6 gaps are measured.
    t.ok('20ms → 30-60fps', h['30-60fps'] === 1);
    t.ok('40ms → 20-30fps', h['20-30fps'] === 1);
    t.ok('60ms → 10-20fps', h['10-20fps'] === 1);
    t.ok('120ms → 4-10fps', h['4-10fps'] === 1);
    t.ok('300ms → 1-4fps', h['1-4fps'] === 1);
    t.ok('1200ms → <1fps', h['<1fps'] === 1);
  }

  // ---- frames: sampling must never eat the hitches ------------------------
  {
    const { recorder } = makeRecorder({ frameSampleEvery: 10 });
    // 9 fast frames then ONE 500ms stall — the stall lands on frame 10... no:
    // deliberately place it on frame 3, which the 1-in-10 sampler would MISS.
    let t0 = 0;
    for (let i = 1; i <= 9; i++) {
      t0 += i === 3 ? 500 : 16;
      recorder.recordFrame(t0);
    }
    const f = recorder.snapshot().frames;
    t.ok('the hitch is recorded even though the sampler skipped that frame', f.hitches.kept === 1);
    t.ok('the hitch keeps its real gap', f.hitches.items[0].gapMs === 500);
    t.ok('the hitch names its frame number', f.hitches.items[0].frame === 3);
    t.ok('the timeline sampled nothing yet (fewer than 10 frames)', f.samples.kept === 0);
    // The whole point: the outlier survives a sampler that never saw it.
    t.ok('worst gap is the hitch, not a sampled frame', f.worstGapMs === 500);
    t.ok('hitch count is over ALL frames', f.hitchCount === 1);
  }
  {
    const { recorder } = makeRecorder({ frameSampleEvery: 5 });
    let t0 = 0;
    for (let i = 0; i < 20; i++) {
      t0 += 16;
      recorder.recordFrame(t0);
    }
    const f = recorder.snapshot().frames;
    t.ok('the timeline samples 1-in-N', f.samples.kept === 4);
    t.ok('samples are on the Nth frames', f.samples.items.map((s) => s.frame).join() === '5,10,15,20');
    t.ok('a healthy session logs no hitches', f.hitches.kept === 0);
  }
  {
    const { recorder } = makeRecorder({ hitchThresholdMs: 50 });
    let t0 = 0;
    recorder.recordFrame((t0 += 16));
    recorder.recordFrame((t0 += 49)); // just under
    recorder.recordFrame((t0 += 50)); // exactly at the threshold
    const f = recorder.snapshot().frames;
    t.ok('49ms is not a hitch, 50ms is (threshold is inclusive)', f.hitches.kept === 1);
    t.ok('the threshold is reported, so a reader can check it', f.hitchThresholdMs === 50);
  }
  {
    const { recorder } = makeRecorder();
    recorder.recordFrame(100);
    const f = recorder.snapshot().frames;
    // A first frame with a giant delta is a lurch bug in disguise — the same
    // reasoning core/frame-clock.js applies to dtSec on its first tick.
    t.ok('the first frame has no gap (never "time since page load")', f.avgGapMs === null);
    t.ok('...and logs no hitch', f.hitches.kept === 0);
  }
  {
    const { recorder } = makeRecorder({ limits: { hitches: 2 } });
    let t0 = 0;
    for (let i = 0; i < 4; i++) recorder.recordFrame((t0 += 200));
    const f = recorder.snapshot().frames;
    t.ok('the hitch ring is bounded', f.hitches.kept === 2);
    t.ok('...and admits what it dropped', f.hitches.dropped === 1);
    t.ok('hitchCount still counts ALL of them, ring or no ring', f.hitchCount === 3);
  }
  {
    // A measurement window must be cleanable without destroying the context
    // that explains it.
    const { recorder } = makeRecorder();
    recorder.log({ level: 'info', message: 'context' });
    recorder.recordFrame(0);
    recorder.recordFrame(500);
    recorder.resetFrameStats();
    const snap = recorder.snapshot();
    t.ok('resetFrameStats clears frames', snap.frames.total === 0 && snap.frames.hitches.kept === 0);
    t.ok(
      'resetFrameStats clears the histogram',
      snap.frames.histogram.every((b) => b.frames === 0)
    );
    t.ok('resetFrameStats KEEPS the log', snap.log.kept === 1);
  }

  // ---- toJsonSafe: one bad report must not sink the bundle ----------------
  {
    const a = { name: 'a' };
    a.self = a;
    const safe = toJsonSafe(a);
    t.ok('a cycle becomes a marker, not a throw', safe.self === '[Circular]');
    let threw = false;
    try {
      JSON.stringify(safe);
    } catch (e) {
      threw = true;
    }
    t.ok('the result actually survives JSON.stringify', !threw);
  }
  {
    // Siblings sharing a reference are NOT a cycle. Getting this wrong would
    // silently blank half of every real report (draw items share placements).
    const shared = { v: 1 };
    const safe = toJsonSafe({ x: shared, y: shared });
    t.ok('a shared sibling reference is not mistaken for a cycle', safe.y.v === 1);
  }
  {
    const err = new Error('boom');
    const safe = toJsonSafe({ err });
    t.ok('an Error keeps its message (not the famously useless {})', safe.err.message === 'boom');
    t.ok('an Error keeps its stack', typeof safe.err.stack === 'string');
  }
  {
    t.ok('NaN is stringified (JSON cannot hold it)', toJsonSafe({ n: NaN }).n === 'NaN');
    t.ok('Infinity is stringified', toJsonSafe({ n: Infinity }).n === 'Infinity');
    t.ok('a Map is serialised, not silently emptied', toJsonSafe(new Map([['k', 1]])).__map.k === 1);
    t.ok('a Set is serialised', toJsonSafe(new Set([1, 2])).__set.length === 2);
    t.ok('a function is named, not dropped', toJsonSafe({ f: function foo() {} }).f === '[Function foo]');
  }
  {
    const deep = { a: { b: { c: { d: { e: 'too far' } } } } };
    t.ok('depth is capped rather than recursing forever', toJsonSafe(deep, 3).a.b.c === '[MaxDepth]');
  }

  // ---- console capture: the drain, and the double-record trap -------------
  //
  // This is the fiddliest part of the design and the easiest to get silently
  // wrong. `core/log.js` records to the sink AND prints to the console; the
  // recorder patches the console to catch FOREIGN traffic. Without the
  // re-entrancy guard those two overlap and every MSA line lands twice — once
  // structured, once as a flattened string — which would make the export's own
  // counts lie about how much was said and by whom.
  {
    const { recorder } = makeRecorder();
    const fake = { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const restore = recorder.captureConsole(fake);

    fake.log('a foreign line');
    fake.warn('a foreign warning');

    const snap = recorder.snapshot();
    t.ok('foreign console.log is captured', snap.log.items[0].message === 'a foreign line');
    t.ok('...tagged as foreign, not as ours', snap.log.items[0].source === 'foreign');
    t.ok('console.log is recorded at info level', snap.log.items[0].level === 'info');
    t.ok('console.warn keeps its level', snap.log.items[1].level === 'warn');
    // Stack capture is paid for only where it earns its keep (warn/error).
    t.ok('a foreign WARNING carries an origin', 'origin' in snap.log.items[1]);
    t.ok('a foreign LOG does not pay for a stack', !('origin' in snap.log.items[0]));

    restore();
    fake.log('after restore');
    t.ok('uninstall really restores the console', recorder.snapshot().log.kept === 2);
  }
  {
    // THE DOUBLE-RECORD TRAP — and a note on why this test patches the REAL
    // `console` rather than a convenient fake.
    //
    // The first draft of this block passed a stub object to captureConsole().
    // It went green instantly and proved NOTHING: `core/log.js` closes over the
    // real global `console`, so the stub was never on the path the logger takes,
    // and "recorded exactly once" was true only because the patch never ran at
    // all. A test that cannot fail is not evidence — it is decoration that reads
    // like evidence, which is worse (memory: `feedback_instruments_must_not_lie`).
    //
    // So: patch the real console, prove the patch is LIVE on it (the foreign
    // line below), and only then trust "exactly once" to mean the guard works.
    const { recorder } = makeRecorder();
    const restore = recorder.captureConsole(console);
    try {
      // Guard-the-guard: if this line is not captured, the patch is not on the
      // object the logger uses, and every assertion after it is meaningless.
      console.log('[flight-recorder test] a genuinely foreign line');
      t.ok('the patch is LIVE on the real console (guard-the-guard)', recorder.snapshot().log.kept === 1);
      t.ok('...and that line is tagged foreign', recorder.snapshot().log.items[0].source === 'foreign');

      setLogSink((entry) => recorder.log({ ...entry, source: 'msa' }));
      const log = createLogger('test-subsystem');
      log.info('[flight-recorder test] one message');

      const snap = recorder.snapshot();
      // 2, not 3: the foreign line above + this one. A third would mean the
      // logger's own print was also swept up by the patch.
      t.ok('a logger call is recorded EXACTLY once, not twice', snap.log.kept === 2);
      t.ok('...as ours, not as foreign', snap.log.items[1].source === 'msa');
      t.ok('...carrying the subsystem as STRUCTURE', snap.log.items[1].subsystem === 'test-subsystem');
      t.ok('...at the right level', snap.log.items[1].level === 'info');

      // THE HEADLINE OF THE WHOLE DESIGN: the console print threshold does NOT
      // gate the recorder. You cannot ask someone to reproduce a bug with
      // verbose logging on after the bug has already happened.
      setLogLevel(LogLevel.ERROR); // console goes quiet…
      log.debug('a debug line nobody will ever see in the console');
      const after = recorder.snapshot();
      t.ok('DEBUG is recorded even with the console set to ERROR only', after.log.kept === 3);
      t.ok('...at debug level', after.log.items[2].level === 'debug');
      t.ok('...and it really did stay out of the console', after.log.bySource.foreign === 1);
    } finally {
      // finally: a thrown assertion must not leave the real console patched for
      // every suite that runs after this one.
      setLogLevel(LogLevel.INFO);
      setLogSink(null);
      restore();
    }
  }

  // ---- runAllReports: the export must be survivable -----------------------
  {
    const reports = new Map([
      ['good', { label: 'Good', fn: () => ({ ok: true }) }],
      [
        'thrower',
        {
          label: 'Thrower',
          fn: () => {
            throw new Error('report is broken');
          },
        },
      ],
      ['asyncGood', { label: 'Async', fn: async () => ({ n: 42 }) }],
    ]);
    const clock = fakeClock();
    const { results, failures, timings } = await runAllReports(reports, { now: clock.now });
    t.ok('a working report lands in results', results.good.ok === true);
    t.ok('an async report is awaited', results.asyncGood.n === 42);
    // A report that throws is itself a finding — captured, never swallowed.
    t.ok('a throwing report does NOT take the bundle down', Object.keys(results).length === 2);
    t.ok('...and its failure is CAPTURED', /report is broken/.test(failures.thrower));
    t.ok('every report is timed', typeof timings.good === 'number');
  }
  {
    const circular = { name: 'c' };
    circular.me = circular;
    const reports = new Map([['circular', { label: 'C', fn: () => circular }]]);
    const { results, failures } = await runAllReports(reports);
    t.ok('a report returning a cycle is still exported', results.circular.me === '[Circular]');
    t.ok('...and is not counted as a failure', Object.keys(failures).length === 0);
  }
  {
    // A hung report must not hang the export forever.
    const reports = new Map([['hung', { label: 'Hung', fn: () => new Promise(() => {}) }]]);
    const { results, failures } = await runAllReports(reports, { timeoutMs: 20 });
    t.ok('a hung report times out', Object.keys(results).length === 0);
    t.ok('...and says so, because "it is hung" IS the finding', /did not finish within 20ms/.test(failures.hung));
  }

  // ---- the filename ------------------------------------------------------
  {
    const name = bundleFilename({}, () => new Date('2026-07-17T12:34:56.789Z'));
    t.ok('filename is slugged and stamped', name === 'msa-flight-no-scene-2026-07-17_12-34-56.json');
    t.ok('filename has no characters a filesystem will argue about', !/[:.]/.test(name.replace(/\.json$/, '')));
  }
}
