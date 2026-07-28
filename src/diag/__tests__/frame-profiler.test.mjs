/**
 * Node tests for frame-profiler.js.
 *
 * Two of these are the whole point of the module and would be nearly impossible
 * to check in a browser:
 *
 *   1. DISARMED, IT READS THE CLOCK ZERO TIMES. The author's constraint was
 *      "minimal performance cost when not active". With ~50 zones bracketed in
 *      the render loop that is ~100 clock reads per frame if the guard is in the
 *      wrong place — and a guard in the wrong place is invisible in any live
 *      test, because everything still works, just slower. An injected counting
 *      clock makes it an assertion.
 *
 *   2. MISPAIRED BRACKETS ARE COUNTED, NEVER SWALLOWED. An unterminated zone
 *      does not crash; it quietly poisons that zone's number for the rest of the
 *      session. That is a wrong answer surviving a silent failure, which is the
 *      worst outcome an instrument can have (feedback_instruments_must_not_lie).
 */
import { ZONES } from '../perf-zones.js';
import { DEFAULT_SETTLE_FRAMES, createFrameProfiler, measureClockResolution } from '../frame-profiler.js';
import { buildZoneRows } from '../perf-report.js';

/** A clock that only moves when the test moves it, and counts every read. */
function fakeClock() {
  const state = { t: 0, reads: 0 };
  const now = () => {
    state.reads++;
    return state.t;
  };
  return { state, now };
}

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // 1. DISARMED COSTS ONE BOOLEAN READ — no clock, no accumulation
  // ======================================================================
  {
    const { state, now } = fakeClock();
    const p = createFrameProfiler({ now });
    const i = p.indexOf('light.drawPointLights');

    for (let f = 0; f < 100; f++) {
      p.beginFrame(0);
      p.begin(i);
      p.end(i);
      p.beginById('light.drawIllum');
      p.endById('light.drawIllum');
      p.passHooks.onPassBegin('light.accumulate');
      p.passHooks.onPassEnd('light.accumulate');
      p.noteGpuMs(i, 1.5);
      p.noteGpuMsForPass('light.accumulate', 2.5);
      p.endFrame(0);
    }

    ok('disarmed: the clock is never read, across 100 frames of full bracketing', state.reads === 0);
    ok('disarmed: isArmed() is false', p.isArmed() === false);
    ok('disarmed: nothing accumulates', p.snapshot().zoneStats.length === 0);
    ok('disarmed: no frames are counted', p.snapshot().frames === 0);
    ok('disarmed: no pass slots are consumed', p.capacity().passSlotsUsed === 0);
  }

  // ---- passHooks must be ONE stable object, not a per-frame allocation -----
  {
    const p = createFrameProfiler({ now: fakeClock().now });
    ok('passHooks is the same object every read', p.passHooks === p.passHooks);
    ok('passHooks is frozen so nobody swaps a hook mid-run', Object.isFrozen(p.passHooks));
    ok(
      'passHooks exposes exactly the runPassPlan contract',
      typeof p.passHooks.onPassBegin === 'function' && typeof p.passHooks.onPassEnd === 'function'
    );
  }

  // ======================================================================
  // 2. SETTLE FRAMES — discarded, and COUNTED
  // ======================================================================
  {
    const { state, now } = fakeClock();
    const p = createFrameProfiler({ now });
    const i = p.indexOf('light.drawIllum');
    p.arm({ settleFrames: 3, clockResolutionMs: 0.1 });

    ok('armed but settling: isArmed true, isMeasuring false', p.isArmed() && !p.isMeasuring());
    ok('settleRemaining reports the countdown', p.settleRemaining() === 3);

    state.reads = 0;
    for (let f = 0; f < 3; f++) {
      p.beginFrame(f);
      p.begin(i);
      state.t += 5;
      p.end(i);
      p.endFrame(f);
    }
    ok('during settle the clock is still not read', state.reads === 0);
    ok('during settle nothing accumulates', p.snapshot().zoneStats.length === 0);
    ok('settling completes after exactly settleFrames', p.isMeasuring() === true);

    // Now a real frame.
    p.beginFrame(10);
    p.begin(i);
    state.t += 2;
    p.end(i);
    p.endFrame(12);

    const snap = p.snapshot();
    ok('after settling, work accumulates', snap.zoneStats.length === 1);
    ok('the discarded frames are COUNTED, not just dropped', snap.settleFramesDiscarded === 3);
    ok('only post-settle frames count toward the window', snap.frames === 1);
    ok('the measured duration is real', snap.durationMs !== null);
    ok('the injected clock resolution is carried into the snapshot', snap.clockResolutionMs === 0.1);
  }

  // ======================================================================
  // 2b. OWNERSHIP — two consumers of one profiler is a REAL bug, not a theory
  // ======================================================================
  {
    // Live, 2026-07-27: a profile session timed out at "waited 30s for 30 frames
    // but only 4 were counted" on a viewer rendering happily at ~40fps. The live
    // HUD was on, re-arming the profiler four times a second for its rolling
    // window and resetting the very counter the session was waiting on. The
    // symptom accused the renderer; the cause was two instruments sharing one.
    const p = createFrameProfiler({ now: fakeClock().now });
    ok('an idle profiler has no owner', p.owner() === null);

    p.arm({ owner: 'hud', settleFrames: 0, clockResolutionMs: 0.1 });
    ok('arming records the owner', p.owner() === 'hud');

    // The HUD re-arming as itself is the normal, correct case.
    let sameOwnerThrew = null;
    try {
      p.arm({ owner: 'hud', settleFrames: 0, clockResolutionMs: 0.1 });
    } catch (e) {
      sameOwnerThrew = e;
    }
    ok('re-arming as the SAME owner is allowed — that is the rolling window', sameOwnerThrew === null);

    let otherOwnerThrew = null;
    try {
      p.arm({ owner: 'session', settleFrames: 0, clockResolutionMs: 0.1 });
    } catch (e) {
      otherOwnerThrew = e;
    }
    ok('arming over ANOTHER owner throws instead of silently resetting', otherOwnerThrew !== null);
    ok(
      '...naming both parties',
      otherOwnerThrew.message.includes('session') && otherOwnerThrew.message.includes('hud')
    );
    ok(
      '...and citing the live failure so nobody re-derives it',
      otherOwnerThrew.message.includes('only 4 frames counted')
    );
    ok('the original owner still owns the window', p.owner() === 'hud');

    p.disarm();
    ok('disarming releases ownership', p.owner() === null);
    let afterRelease = null;
    try {
      p.arm({ owner: 'session', settleFrames: 0, clockResolutionMs: 0.1 });
    } catch (e) {
      afterRelease = e;
    }
    ok('...so the next consumer can arm freely', afterRelease === null && p.owner() === 'session');
  }

  // ======================================================================
  // 3. ACCUMULATION — sums, counts, peaks; inclusive nesting
  // ======================================================================
  {
    const { state, now } = fakeClock();
    const p = createFrameProfiler({ now });
    const pass = 'light.accumulate';
    const child = p.indexOf('light.drawPointLights');
    p.arm({ settleFrames: 0, clockResolutionMs: 0.1 });

    // Two frames: the pass takes 10ms and 20ms, the child 4ms and 6ms inside it.
    for (const [passMs, childMs] of [
      [10, 4],
      [20, 6],
    ]) {
      p.beginFrame(state.t);
      p.passHooks.onPassBegin(pass);
      p.begin(child);
      state.t += childMs;
      p.end(child);
      state.t += passMs - childMs;
      p.passHooks.onPassEnd(pass);
      p.endFrame(state.t);
    }

    const snap = p.snapshot();
    const byId = Object.fromEntries(snap.zoneStats.map((z) => [z.id, z]));

    ok('a declared zone reports under its declared id', byId['light.drawPointLights'] !== undefined);
    ok('a pass zone is synthesised with the pass. prefix', byId['pass.light.accumulate'] !== undefined);
    ok('child sum is 4+6', byId['light.drawPointLights'].cpu.sumMs === 10);
    ok('child count is 2', byId['light.drawPointLights'].cpu.count === 2);
    ok('child peak is the worse of the two', byId['light.drawPointLights'].cpu.maxMs === 6);
    // INCLUSIVE: the pass total covers its child, deliberately — perf-report
    // needs both to compute the pass's own un-broken-down residual.
    ok('pass time INCLUDES the child (10+20, not 6+14)', byId['pass.light.accumulate'].cpu.sumMs === 30);
    ok('pass peak is 20', byId['pass.light.accumulate'].cpu.maxMs === 20);
    ok('two frames were counted', snap.frames === 2);
    ok('no anomalies on a clean run', snap.anomalies.unbalancedBrackets === 0);
    ok('a clean run has no anomaly note', snap.anomalies.note === null);

    // And the snapshot must feed the report brain unchanged.
    const rows = buildZoneRows({ zoneStats: snap.zoneStats, zones: ZONES, frames: snap.frames });
    ok('the snapshot feeds buildZoneRows directly', rows.length === 2);
    ok('the pass row is recognised as a pass', rows.find((r) => r.id === 'pass.light.accumulate').isPass === true);
    ok(
      'the child row is parented to the pass',
      rows.find((r) => r.id === 'light.drawPointLights').parent === 'pass.light.accumulate'
    );
  }

  // ======================================================================
  // 4. MISPAIRED BRACKETS — counted, never swallowed
  // ======================================================================
  {
    const { state, now } = fakeClock();
    const p = createFrameProfiler({ now });
    const i = p.indexOf('light.drawIllum');
    p.arm({ settleFrames: 0, clockResolutionMs: 0.1 });

    p.beginFrame(0);
    p.end(i); // end with no begin
    p.begin(i);
    p.begin(i); // re-entrant begin
    state.t += 5;
    p.end(i);
    p.endFrame(state.t);

    const snap = p.snapshot();
    const z = snap.zoneStats.find((x) => x.id === 'light.drawIllum');
    ok('an unpaired end is counted', z.unbalanced === 2);
    ok('the run still records the one valid bracket', z.cpu.count === 1);
    ok('the re-entrant begin keeps the OUTER extent (5ms, not 0)', z.cpu.sumMs === 5);
    ok('anomalies are totalled at the snapshot level', snap.anomalies.unbalancedBrackets === 2);
    ok('...with a note telling the reader the numbers are suspect', snap.anomalies.note.includes('suspect'));
  }

  // ---- disarm must close any zone left open --------------------------------
  {
    const { state, now } = fakeClock();
    const p = createFrameProfiler({ now });
    const i = p.indexOf('light.drawIllum');
    p.arm({ settleFrames: 0, clockResolutionMs: 0.1 });
    p.begin(i);
    state.t += 3;
    p.disarm(); // never ended

    ok('disarm counts the zone left open as an anomaly', p.snapshot().anomalies.unbalancedBrackets === 1);

    // And crucially the stale open timestamp must not survive into a new run.
    p.arm({ settleFrames: 0, clockResolutionMs: 0.1 });
    p.begin(i);
    state.t += 7;
    p.end(i);
    const snap = p.snapshot();
    ok('a re-arm clears the previous window entirely', snap.anomalies.unbalancedBrackets === 0);
    ok('...and the first sample of the new run is correct, not poisoned', snap.zoneStats[0].cpu.sumMs === 7);
  }

  // ======================================================================
  // 5. GPU folding — arrives late, out of band
  // ======================================================================
  {
    const p = createFrameProfiler({ now: fakeClock().now });
    const i = p.indexOf('light.drawPointLights');
    p.arm({ settleFrames: 0, clockResolutionMs: 0.1 });

    p.noteGpuMs(i, 1.4);
    p.noteGpuMs(i, 2.2);
    p.noteGpuMsForPass('post.bloom', 0.9);

    const snap = p.snapshot();
    const z = snap.zoneStats.find((x) => x.id === 'light.drawPointLights');
    ok('GPU durations accumulate independently of the CPU bracket', Math.abs(z.gpu.sumMs - 3.6) < 1e-9);
    ok('GPU count is tracked separately', z.gpu.count === 2);
    ok('GPU peak is tracked', z.gpu.maxMs === 2.2);
    ok('a zone with GPU but no CPU time reports cpu null, not 0', z.cpu === null);
    ok(
      'GPU time can be folded onto a pass zone',
      snap.zoneStats.some((x) => x.id === 'pass.post.bloom')
    );

    // Garbage in must not become a measurement.
    p.noteGpuMs(i, -5);
    p.noteGpuMs(i, NaN);
    p.noteGpuMs(i, Infinity);
    ok(
      'negative/NaN/Infinite GPU durations are rejected',
      p.snapshot().zoneStats.find((x) => x.id === 'light.drawPointLights').gpu.count === 2
    );

    // An out-of-range index must not corrupt a neighbouring slot — the whole
    // point of typed-array accumulators is that a stray write lands SOMEWHERE.
    const beforeIds = p
      .snapshot()
      .zoneStats.map((x) => x.id)
      .join(',');
    const beforeNeighbour = p.snapshot().zoneStats.find((x) => x.id === 'light.drawPointLights').gpu.sumMs;
    p.noteGpuMs(-1, 5);
    p.noteGpuMs(99999, 5);
    const after = p.snapshot();
    ok('an out-of-range index creates no zone', after.zoneStats.map((x) => x.id).join(',') === beforeIds);
    ok(
      '...and leaves its neighbours untouched',
      after.zoneStats.find((x) => x.id === 'light.drawPointLights').gpu.sumMs === beforeNeighbour
    );
  }

  // ======================================================================
  // 6. DRAW CALL DELTAS — sampled at the bracket, free-ish
  // ======================================================================
  {
    const { state, now } = fakeClock();
    let draws = 0;
    let tris = 0;
    const p = createFrameProfiler({ now });
    const i = p.indexOf('light.drawPointLights');
    p.arm({ settleFrames: 0, clockResolutionMs: 0.1, readDrawCalls: () => draws, readTriangles: () => tris });

    p.beginFrame(0);
    p.begin(i);
    draws += 3;
    tris += 96;
    state.t += 1;
    p.end(i);
    p.endFrame(state.t);

    const z = p.snapshot().zoneStats.find((x) => x.id === 'light.drawPointLights');
    ok('draw calls inside the bracket are captured as a delta', z.drawCalls.sum === 3);
    ok('triangles too', z.triangles.sum === 96);
    ok('the delta carries its own count for averaging', z.drawCalls.count === 1);

    // With no reader injected there must be no fabricated zero.
    const q = createFrameProfiler({ now });
    const j = q.indexOf('light.drawIllum');
    q.arm({ settleFrames: 0, clockResolutionMs: 0.1 });
    q.begin(j);
    q.end(j);
    ok('no draw-call reader gives null, not 0', q.snapshot().zoneStats[0].drawCalls === null);
  }

  // ======================================================================
  // 7. PASS SLOT EXHAUSTION — bounded, and it says so
  // ======================================================================
  {
    const p = createFrameProfiler({ now: fakeClock().now, maxPassZones: 2 });
    p.arm({ settleFrames: 0, clockResolutionMs: 0.1 });
    for (const id of ['a', 'b', 'c', 'd']) {
      p.passHooks.onPassBegin(id);
      p.passHooks.onPassEnd(id);
    }
    const snap = p.snapshot();
    ok('pass slots are bounded', p.capacity().passSlotsUsed === 2);
    ok('overflow is COUNTED rather than silently dropping zones', snap.anomalies.passSlotOverflow > 0);
    ok('...and surfaces in the anomaly note', snap.anomalies.note.includes('pass slots'));
  }

  // ======================================================================
  // 8. CLOCK RESOLUTION PROBE
  // ======================================================================
  {
    // A clock that advances by exactly 0.25 on every read: the probe should find
    // a step of 0.25, not 0 and not something smaller.
    let t = 0;
    const stepping = () => {
      t += 0.25;
      return t;
    };
    const res = measureClockResolution(stepping, 5);
    ok('the probe recovers the clock step', Math.abs(res - 0.25) < 1e-9);

    // A frozen clock must yield null, never a fabricated 0 resolution — a 0
    // would make every noise-floor comparison pass and silence the suppression.
    let frozenReads = 0;
    const frozen = () => {
      frozenReads++;
      return 7;
    };
    ok('a frozen clock yields null resolution, never 0', measureClockResolution(frozen, 2, 50) === null);

    // The probe must TERMINATE on a frozen clock rather than spinning forever,
    // and the spin limit is what guarantees it. Assert the bound is real by
    // counting reads: 3 trials x (1 initial + 1 first + <=10 spins) is well
    // under 40, whereas an unbounded loop would never return at all.
    frozenReads = 0;
    measureClockResolution(frozen, 3, 10);
    ok(`the probe is bounded by its spin limit (${frozenReads} reads)`, frozenReads > 0 && frozenReads <= 3 * 12);
  }

  // ======================================================================
  // 9. Defaults and detachment
  // ======================================================================
  {
    ok(`the default settle window is ${DEFAULT_SETTLE_FRAMES} frames`, DEFAULT_SETTLE_FRAMES === 30);

    // Every entry point must survive being destructured off the object — a
    // `this`-dependent method that silently no-ops when detached is exactly the
    // quiet failure mode this instrument cannot afford.
    const p = createFrameProfiler({ now: fakeClock().now });
    p.arm({ settleFrames: 0, clockResolutionMs: 0.1 });
    const { noteGpuMs, begin, end, noteGpuMsForPass } = p;
    const i = p.indexOf('light.drawIllum');
    begin(i);
    end(i);
    noteGpuMs(i, 1);
    noteGpuMsForPass('post.bloom', 1);
    const snap = p.snapshot();
    ok('destructured begin/end still records', snap.zoneStats.find((z) => z.id === 'light.drawIllum').cpu.count === 1);
    ok('destructured noteGpuMs still records', snap.zoneStats.find((z) => z.id === 'light.drawIllum').gpu.count === 1);
    ok(
      'destructured noteGpuMsForPass still records',
      snap.zoneStats.some((z) => z.id === 'pass.post.bloom')
    );

    ok('an unknown zone id resolves to -1 rather than throwing', p.indexOf('no.such.zone') === -1);

    // begin/end on -1 (the "unknown zone" sentinel) must be a genuine no-op,
    // not a write to slot 0. beginById with a typo'd id is the realistic way in.
    const idsBefore = p
      .snapshot()
      .zoneStats.map((z) => z.id)
      .join(',');
    p.begin(-1);
    p.end(-1);
    p.beginById('typo.zone.name');
    p.endById('typo.zone.name');
    ok(
      'an unknown zone records nothing at all',
      p
        .snapshot()
        .zoneStats.map((z) => z.id)
        .join(',') === idsBefore
    );
  }
}
