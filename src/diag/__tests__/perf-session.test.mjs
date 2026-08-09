/**
 * Node tests for perf-session.js — the one-button orchestration.
 *
 * The two that matter most are about REFUSING and about CLEANING UP:
 *
 *   - Refusing to profile while the whole-frame GPU probe is armed. That probe
 *     throttles the render loop, so frames get skipped without opening a zone
 *     and every occurrence rate comes out wrong by an unknowable factor. A
 *     report that is quietly wrong is worse than no report.
 *   - Disarming on EVERY path. The GPU timer holds a vendor-internal flag on and
 *     a query pool three never prunes; an error that left it armed would leak
 *     for the rest of the session.
 */
import { BLOOM, SPECULAR } from '../../effects/index.js';
import { DEFAULT_MEASURE_FRAMES, createProfiledFrameWaiter, runProfileSession } from '../perf-session.js';

/** Let queued promise callbacks run. */
const flushTicks = () => new Promise((r) => setTimeout(r, 0));

function fakeHarness(over = {}) {
  const calls = [];
  const h = {
    _calls: calls,
    isGpuProbeArmed: () => false,
    armProfiler(o) {
      calls.push(['armProfiler', o.settleFrames]);
    },
    disarmProfiler() {
      calls.push(['disarmProfiler']);
    },
    readProfile: () => ({
      frames: 600,
      durationMs: 5000,
      settleFramesDiscarded: 30,
      clockResolutionMs: 0.1,
      zoneStats: [
        { id: 'pass.light.accumulate', cpu: null, gpu: { sumMs: 1200, count: 600, maxMs: 4 } },
        { id: 'light.drawPointLights', cpu: null, gpu: { sumMs: 600, count: 600, maxMs: 2 } },
      ],
      anomalies: { unbalancedBrackets: 0, passSlotOverflow: 0, note: null },
    }),
    setGpuZoneTimer(on) {
      calls.push(['setGpuZoneTimer', on]);
      return { armed: on };
    },
    getGpuZoneStatus: () => ({ capable: true, reason: null, poolOverflowed: false, unattributedPasses: 0 }),
    resetFrameStats() {
      calls.push(['resetFrameStats']);
    },
    readFrameStats: () => ({
      gapSamples: Array.from({ length: 600 }, () => 8.4),
      gpuMs: { p50: 3, p95: 4, sampleCount: 500 },
      hitches: [],
      hitchThresholdMs: 50,
    }),
    getContext: () => ({
      resolution: { w: 2560, h: 1392 },
      sceneName: 'Church',
      floorIndex: 0,
      enabledEffects: ['bloom'],
      msaVersion: '0.6.0',
    }),
    async waitFrames(n) {
      calls.push(['waitFrames', n]);
    },
    getManifests: () => [BLOOM, SPECULAR],
    readVram: () => null,
    ...over,
  };
  return h;
}

export async function run(t) {
  const { ok } = t;

  // ---- the happy path, in order -------------------------------------------
  {
    const h = fakeHarness();
    const phases = [];
    const report = await runProfileSession(h, {
      settleFrames: 30,
      measureFrames: 120,
      generatedAt: '2026-07-27T00:00:00.000Z',
      onProgress: (p) => phases.push(p),
    });

    const seq = h._calls.map((c) => c[0]).join(',');
    ok(
      'the sequence is arm-timer, reset, arm-profiler, wait, wait, disarm, disarm-timer',
      seq === 'setGpuZoneTimer,resetFrameStats,armProfiler,waitFrames,waitFrames,disarmProfiler,setGpuZoneTimer'
    );
    ok('the GPU timer is armed before the profiler', h._calls[0][1] === true);
    ok('the GPU timer is disarmed at the end', h._calls[h._calls.length - 1][1] === false);
    ok('the settle window is passed to the profiler', h._calls[2][1] === 30);
    ok('settle and measure are waited separately', h._calls[3][1] === 30 && h._calls[4][1] === 120);
    ok('progress is reported through the phases', phases.includes('settling') && phases.includes('measuring'));

    ok('a finished report comes back', report.report === 'perf-profile');
    ok('the window carries the real frame count', report.window.frames === 600);
    ok('the discarded settle frames are reported', report.window.settleFramesDiscarded === 30);
    ok('the method reflects a capable device', report.method.gpu === 'timestamp-query');
    ok('the measured clock resolution is carried through', report.method.cpuClockResolutionMs === 0.1);
    ok('zones came through', report.zones.length === 2);
    ok('instrument health is reported separately from the measurements', report.instrument !== undefined);
    ok('...and says so in as many words', report.instrument.note.includes('not the renderer'));
    ok(
      'a harness with no readPipelineStats produces no pipelineStats block (absence, not a fabricated zero)',
      report.instrument.pipelineStats === null
    );
  }

  // ---- PIPELINE HEALTH: sampled once after settling, once at the end --------
  {
    let calls = 0;
    const readings = [{ programs: 12 }, { programs: 19 }];
    const h = fakeHarness({
      readPipelineStats: () => readings[Math.min(calls++, readings.length - 1)],
    });
    const report = await runProfileSession(h, { settleFrames: 30, measureFrames: 120 });
    ok('readPipelineStats was called exactly twice — start and end, never per-frame', calls === 2);
    ok(
      'the report carries both readings, in order',
      report.instrument.pipelineStats.start.programs === 12 && report.instrument.pipelineStats.end.programs === 19
    );
    ok(
      'growth between them surfaces as a finding',
      report.findings.some((f) => f.id === 'pipeline-programs-grew')
    );
  }

  // ---- REFUSAL: never profile while the throttling probe is armed -----------
  {
    const h = fakeHarness({ isGpuProbeArmed: () => true });
    let threw = null;
    try {
      await runProfileSession(h, { settleFrames: 1, measureFrames: 1 });
    } catch (e) {
      threw = e;
    }
    ok('it refuses to run while the GPU probe is armed', threw !== null);
    ok('...and explains that frames would be skipped', threw.message.includes('skipped'));
    ok('...and that occurrence rates would be wrong', threw.message.includes('occurrence rate'));
    ok('...and it touched nothing before refusing', h._calls.length === 0);
  }

  // ---- REFUSAL 2: the live HUD owns the profiler while it is visible --------
  {
    const h = fakeHarness({ profilerOwner: () => 'hud' });
    let threw = null;
    try {
      await runProfileSession(h, { settleFrames: 1, measureFrames: 1 });
    } catch (e) {
      threw = e;
    }
    ok('it refuses while the HUD owns the profiler', threw !== null);
    ok('...naming the HUD rather than blaming the renderer', threw.message.includes('live zone HUD'));
    ok('...explaining that its resets would corrupt the window', threw.message.includes('reset'));
    ok('...and telling the user exactly what to do', threw.message.includes('Toggle the HUD off'));
    ok('...and it touched nothing before refusing', h._calls.length === 0);

    // A harness with no owner concept at all must still work.
    const plain = fakeHarness();
    delete plain.profilerOwner;
    const report = await runProfileSession(plain, { settleFrames: 1, measureFrames: 1 });
    ok('a harness without profilerOwner still runs', report.report === 'perf-profile');
  }

  // ---- CLEANUP: disarm on the throwing path too -----------------------------
  {
    const boom = new Error('the render loop died mid-window');
    const h = fakeHarness({
      async waitFrames(n) {
        this._calls.push(['waitFrames', n]);
        throw boom;
      },
    });
    let threw = null;
    try {
      await runProfileSession(h, { settleFrames: 1, measureFrames: 1 });
    } catch (e) {
      threw = e;
    }
    ok('the original error propagates', threw === boom);
    const seq = h._calls.map((c) => c[0]);
    ok('the profiler is still disarmed', seq.includes('disarmProfiler'));
    ok(
      'the GPU timer is still disarmed',
      h._calls.filter((c) => c[0] === 'setGpuZoneTimer' && c[1] === false).length === 1
    );
  }

  // ---- a disarm that itself fails must not mask the original error ---------
  {
    const boom = new Error('primary failure');
    const h = fakeHarness({
      async waitFrames() {
        throw boom;
      },
      setGpuZoneTimer(on) {
        this._calls.push(['setGpuZoneTimer', on]);
        if (on === false) throw new Error('disarm exploded');
        return { armed: on };
      },
    });
    let threw = null;
    try {
      await runProfileSession(h, { settleFrames: 1, measureFrames: 1 });
    } catch (e) {
      threw = e;
    }
    ok('a failing disarm does not mask the original error', threw === boom);
  }

  // ---- an incapable device degrades honestly, it does not fail -------------
  {
    const h = fakeHarness({
      getGpuZoneStatus: () => ({
        capable: false,
        reason: 'trackTimestamp is false after init()',
        poolOverflowed: false,
        unattributedPasses: 0,
      }),
    });
    const report = await runProfileSession(h, { settleFrames: 1, measureFrames: 1 });
    ok("an incapable device degrades to 'frame-only'", report.method.gpu === 'frame-only');
    ok('...carrying the reason', report.method.gpuReason.includes('trackTimestamp'));
    ok(
      '...and the report says loudly that GPU attribution is unavailable',
      report.findings.some((f) => f.id === 'gpu-attribution-unavailable')
    );
  }

  // ---- instrument faults are surfaced ABOVE the measurements ---------------
  {
    const h = fakeHarness({
      readProfile: () => ({
        frames: 100,
        durationMs: 1000,
        settleFramesDiscarded: 0,
        clockResolutionMs: 0.1,
        zoneStats: [{ id: 'light.drawIllum', cpu: null, gpu: { sumMs: 100, count: 100, maxMs: 2 }, unbalanced: 4 }],
        anomalies: { unbalancedBrackets: 4, passSlotOverflow: 2, note: 'suspect' },
      }),
    });
    const report = await runProfileSession(h, { settleFrames: 1, measureFrames: 1 });
    ok(
      'an unbalanced bracket is a finding',
      report.findings.some((f) => f.id === 'profiler-unbalanced-brackets')
    );
    ok('...at high severity, above any measurement', report.findings[0].severity === 'high');
    ok('...and names it a fault in the instrument', report.findings[0].text.includes('not in the renderer'));
    ok(
      'pass slot overflow is a finding too',
      report.findings.some((f) => f.id === 'profiler-pass-slot-overflow')
    );
    ok('the raw anomalies are carried for inspection', report.instrument.profilerAnomalies.unbalancedBrackets === 4);
  }

  // ---- unattributed GPU passes are named, never silently absorbed ----------
  {
    const h = fakeHarness({
      getGpuZoneStatus: () => ({ capable: true, reason: null, poolOverflowed: false, unattributedPasses: 7 }),
    });
    const report = await runProfileSession(h, { settleFrames: 1, measureFrames: 1 });
    const f = report.findings.find((x) => x.id === 'gpu-passes-unattributed');
    ok('unattributed passes become a finding', f !== undefined);
    ok('...and it says where that time DID go', f.text.includes('residualGpuMs'));
    ok('...and that nothing was folded in to tidy the sums', f.text.includes('tidier'));
  }

  // ---- the sweep is optional, and consumed rather than absorbed ------------
  {
    const h = fakeHarness({
      runSweep: async () => ({ effects: [{ id: 'bloom' }], summary: { perEffect: [{ id: 'bloom', costMs: 1.2 }] } }),
    });
    const without = await runProfileSession(h, { settleFrames: 1, measureFrames: 1 });
    ok('no sweep by default', without.method.sweepIncluded === false);

    const h2 = fakeHarness({
      runSweep: async () => ({ effects: [{ id: 'bloom' }], summary: { perEffect: [{ id: 'bloom', costMs: 1.2 }] } }),
    });
    const withSweep = await runProfileSession(h2, { settleFrames: 1, measureFrames: 1, includeSweep: true });
    ok('the sweep is included when asked', withSweep.method.sweepIncluded === true);
    ok(
      'and its marginal cost lands beside the zone cost',
      withSweep.effects.find((e) => e.id === 'bloom').sweepMarginalGpuMs === 1.2
    );
  }

  // ---- the frame waiter counts PROFILED frames, not clock ticks ------------
  {
    // The distinction matters: a tick-counting wait would return happily while
    // the viewer was stopped, and the report would then claim a 600-frame window
    // it never had.
    let profiled = { frames: 0, settleFramesDiscarded: 0 };
    const pending = [];
    const waitFrames = createProfiledFrameWaiter({
      readProfile: () => profiled,
      raf: (cb) => pending.push(cb),
      now: () => 0,
    });

    let resolved = false;
    waitFrames(3).then(() => {
      resolved = true;
    });

    pending.shift()?.(); // tick 1 — nothing counted yet
    await flushTicks();
    ok('the waiter does not resolve before frames are counted', resolved === false);

    profiled = { frames: 2, settleFramesDiscarded: 0 };
    pending.shift()?.();
    await flushTicks();
    ok('...still not, at 2 of 3', resolved === false);

    profiled = { frames: 3, settleFramesDiscarded: 0 };
    pending.shift()?.();
    await flushTicks();
    ok('resolves once the profiler has counted enough frames', resolved === true);
  }

  {
    // Settle frames count toward progress too — otherwise the settle wait would
    // never finish, because settling frames are deliberately NOT counted as
    // measured frames.
    let profiled = { frames: 0, settleFramesDiscarded: 0 };
    const pending = [];
    const waitFrames = createProfiledFrameWaiter({
      readProfile: () => profiled,
      raf: (cb) => pending.push(cb),
      now: () => 0,
    });
    let resolved = false;
    waitFrames(2).then(() => {
      resolved = true;
    });
    profiled = { frames: 0, settleFramesDiscarded: 2 };
    pending.shift()?.();
    await flushTicks();
    ok('discarded settle frames count as progress', resolved === true);
  }

  {
    // A stopped viewer must fail LOUDLY rather than hang the button forever.
    let clock = 0;
    const pending = [];
    const waitFrames = createProfiledFrameWaiter({
      readProfile: () => ({ frames: 0, settleFramesDiscarded: 0 }),
      raf: (cb) => pending.push(cb),
      now: () => clock,
      timeoutMs: 1000,
    });
    let err = null;
    waitFrames(10).catch((e) => {
      err = e;
    });
    clock = 2000; // past the timeout
    pending.shift()?.();
    await flushTicks();
    ok('a stalled viewer rejects rather than hanging', err !== null);
    ok('...naming how many frames it actually saw', err.message.includes('only 0'));
    ok('...and telling the user what to do', err.message.includes('load a scene'));
  }

  // ---- defaults ------------------------------------------------------------
  {
    ok(`the default window is ${DEFAULT_MEASURE_FRAMES} frames (~10s at 60fps)`, DEFAULT_MEASURE_FRAMES === 600);
    const h = fakeHarness();
    await runProfileSession(h);
    const waits = h._calls.filter((c) => c[0] === 'waitFrames').map((c) => c[1]);
    ok('the default settle window is used when unspecified', waits[0] === 30);
    ok('the default measure window is used when unspecified', waits[1] === DEFAULT_MEASURE_FRAMES);
  }
}
