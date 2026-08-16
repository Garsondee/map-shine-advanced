/**
 * Node verification for ui/load-progress.js.
 *
 * Two blocks carry real weight here:
 *
 * - **THE FLOOR-SWITCH GUARANTEE** (`shouldShowForScene`). Keyhole.md §4.5's
 *   headline promise is "floor changes without loading screens", and Foundry gives
 *   us nothing to lean on: `Scene#view` calls `canvas.draw()` for BOTH a scene
 *   change and a level change, and `draw()` fires the same hooks either way. This
 *   comparison is the ONLY thing preventing a curtain on every floor switch, so it
 *   is tested like the load-bearing thing it is.
 * - **THE HONESTY RULES.** §7 kills "the 0%/98% two-gate warmup and its 'Ready!'
 *   lie" by name. Every test below that asserts `fraction === null` or "complete is
 *   not inferred" is there to stop that lie growing back.
 */
import {
  STALL_THRESHOLD_MS,
  STALL_NOTE_VISIBLE_MS,
  LOAD_PHASES,
  createLoadState,
  beginPhase,
  reportProgress,
  completeLoad,
  failLoad,
  recordTick,
  describeLoad,
  hardRevealDue,
  shouldShowForScene,
} from '../load-progress.js';
// The ONE pure function in the browser-only overlay — the blocker list's cap.
// Imported here rather than given its own suite because it is one formatter and
// a second file would be a second thing for `run-tests.mjs`'s dispatch list to
// forget ([[feedback_test_dispatch_list_forgets_new_files]]).
import { formatBlockerLines } from '../loading-screen.js';

export function run(t) {
  const { ok } = t;
  const mk = (nowMs = 1000) => createLoadState({ sceneId: 'sceneA', sceneName: 'Test Scene', nowMs });

  // --- THE FLOOR-SWITCH GUARANTEE -----------------------------------------
  {
    // Cold load: nothing loaded before.
    ok('cold load shows the curtain', shouldShowForScene(null, 'sceneA').show === true);
    ok('cold load says why', shouldShowForScene(null, 'sceneA').reason === 'cold load');

    // THE ONE THAT MATTERS. Foundry fires canvasInit + canvasReady on a floor
    // switch exactly as it does on a scene change (Scene#view, scene.mjs:280 →
    // canvas.draw() on `sceneChanged || levelChanged`). Only the id tells them apart.
    const floorSwitch = shouldShowForScene('sceneA', 'sceneA');
    ok('FLOOR SWITCH shows NO curtain (§4.5 headline promise)', floorSwitch.show === false);
    ok('floor switch explains itself', floorSwitch.reason.includes('floor switch'));

    // A real scene change must still show one.
    ok('scene change shows the curtain', shouldShowForScene('sceneA', 'sceneB').show === true);
    // ...and going back to a previously-seen scene is still a scene change.
    ok('returning to an earlier scene shows the curtain', shouldShowForScene('sceneB', 'sceneA').show === true);

    // Defensive: no scene at all.
    ok('no scene → no curtain', shouldShowForScene('sceneA', null).show === false);
    ok('no scene → no curtain (undefined)', shouldShowForScene(null, undefined).show === false);
  }

  // --- HONESTY: an unknown total must NOT produce a number ------------------
  {
    const s = mk();
    beginPhase(s, LOAD_PHASES.SCENE);
    const d = describeLoad(s, 1000);
    // The 0%/98% lie starts exactly here — with a bar drawn before anyone knows
    // how much work there is.
    ok('unknown total → fraction is null, NOT 0', d.fraction === null);
    ok('unknown total → still names the phase', d.title === 'Reading the scene');
    ok('unknown total → no fabricated "x of y" detail', d.detail === null);
  }

  // --- HONESTY: fraction is real, clamped, and phase-local -----------------
  {
    const s = mk();
    beginPhase(s, LOAD_PHASES.ART, { total: 7 });
    ok('known total, nothing done → fraction 0 (a real 0, not a guess)', describeLoad(s, 1000).fraction === 0);

    reportProgress(s, LOAD_PHASES.ART, { done: 3, detail: 'Ground Floor' });
    const mid = describeLoad(s, 1000);
    ok('fraction reflects real counters', Math.abs(mid.fraction - 3 / 7) < 1e-9);
    ok('detail carries both the count and the note', mid.detail === '3 of 7 · Ground Floor');
    ok('title names the phase', mid.title === 'Streaming map art');

    // Overshoot must never escape the bar (a >100% bar reads as a bug, and is one).
    reportProgress(s, LOAD_PHASES.ART, { done: 99 });
    ok('fraction is clamped to 1', describeLoad(s, 1000).fraction === 1);
    // ...but reaching the total is NOT completion. See the next block.
    ok('done === total does NOT imply complete', describeLoad(s, 1000).complete === false);
  }

  // --- HONESTY: "complete" cannot be inferred, only declared ---------------
  {
    const s = mk(1000);
    beginPhase(s, LOAD_PHASES.ART, { total: 4 });
    reportProgress(s, LOAD_PHASES.ART, { done: 4 });
    // Every counter is maxed. The old "Ready!" lie is precisely this moment.
    ok('all counters maxed → still not complete', describeLoad(s, 2000).complete === false);
    ok(
      'all counters maxed → title is still the phase, not "Ready"',
      describeLoad(s, 2000).title === 'Streaming map art'
    );

    // Only the explicit call flips it — the first frame having painted is a fact
    // no counter knows.
    completeLoad(s, 2500);
    const d = describeLoad(s, 9999);
    ok('completeLoad() is the only thing that completes a load', d.complete === true && d.title === 'Ready');
    ok('completed load reports fraction 1', d.fraction === 1);
    ok('elapsed freezes at completion, not at read time', d.elapsedMs === 1500);
  }

  // --- failure is distinct from completion ---------------------------------
  {
    const s = mk(1000);
    beginPhase(s, LOAD_PHASES.ART, { total: 4 });
    failLoad(s, 'the art 404ed', 1800);
    const d = describeLoad(s, 5000);
    ok('failed load is NOT complete', d.complete === false);
    ok('failed load surfaces the error', d.error === 'the art 404ed' && d.detail === 'the art 404ed');
    ok('failed load reports no fraction', d.fraction === null);
    ok('failed load freezes elapsed too', d.elapsedMs === 800);
  }

  // --- elapsed -------------------------------------------------------------
  {
    const s = mk(1000);
    ok('elapsed counts from the start', describeLoad(s, 3500).elapsedMs === 2500);
    ok('elapsed is never negative even if the clock misbehaves', describeLoad(s, 0).elapsedMs === 0);
  }

  // --- LIVENESS / STALLS ---------------------------------------------------
  {
    const s = mk(0);
    ok('first tick reports no gap', recordTick(s, 16) === 0);
    ok('a normal frame gap is measured', recordTick(s, 32) === 16);
    ok('a normal gap is not a stall', s.worstStallMs === 0);
    ok('a normal gap produces no note', describeLoad(s, 32).stallNote === null);

    // A real freeze: the tick simply doesn't happen for a while. That gap IS the
    // only observable — nothing runs during the stall to report it live.
    const gap = recordTick(s, 32 + 800);
    ok('a long gap is reported', gap === 800);
    ok('a long gap is recorded as the worst stall', s.worstStallMs === 800);
    ok(
      'the note only appears AFTER the stall ends — the only time it can',
      describeLoad(s, 900).stallNote === 'still working — the last step took 0.8s'
    );

    // A worse stall raises the watermark; a milder one does not lower it.
    // Tick times are absolute, so each gap is stated rather than inferred:
    // last tick was at 832; ticking at 2832 is a 2000ms gap.
    recordTick(s, 2832);
    ok('worst stall is a high-water mark (2000)', s.worstStallMs === 2000);
    recordTick(s, 3132); // a 300ms gap — a stall, but a milder one
    ok('a milder later stall does not lower the watermark', s.worstStallMs === 2000);
    ok(
      'but the NOTE reflects the most recent stall, not the worst',
      describeLoad(s, 3200).stallNote === 'still working — the last step took 0.3s'
    );

    // Bug (2026-08-08, author report): the note used to be gated purely on
    // "was there ever a stall", so it froze on screen for the rest of the load
    // even long after the main thread recovered. It must EXPIRE.
    ok(
      'the note is still visible just inside the decay window',
      describeLoad(s, 3132 + STALL_NOTE_VISIBLE_MS).stallNote === 'still working — the last step took 0.3s'
    );
    ok(
      'the note is GONE once the decay window has fully elapsed, even though a stall did happen',
      describeLoad(s, 3132 + STALL_NOTE_VISIBLE_MS + 1).stallNote === null
    );
    ok(
      'long after a stall, an otherwise-normal load reports no note at all',
      describeLoad(s, 3132 + STALL_NOTE_VISIBLE_MS * 10).stallNote === null
    );

    ok('the threshold matches the renderer hitch log (250ms)', STALL_THRESHOLD_MS === 250);
    const s2 = mk(0);
    recordTick(s2, 0);
    recordTick(s2, STALL_THRESHOLD_MS - 1);
    ok('a gap just under the threshold is not a stall', s2.worstStallMs === 0);
    recordTick(s2, STALL_THRESHOLD_MS - 1 + STALL_THRESHOLD_MS);
    ok('a gap exactly at the threshold IS a stall', s2.worstStallMs === STALL_THRESHOLD_MS);
  }

  // --- reportProgress on a phase that was never begun ----------------------
  {
    // Robustness: a caller reporting into a phase it never opened must not
    // silently write counters onto the WRONG phase's label.
    const s = mk();
    beginPhase(s, LOAD_PHASES.SCENE);
    reportProgress(s, LOAD_PHASES.ART, { done: 1, total: 3 });
    ok('reporting into a new phase switches to it', s.phase === LOAD_PHASES.ART);
    ok('...and does not inherit the old phase counters', s.done === 1 && s.total === 3);
    ok('...and relabels', describeLoad(s, 1000).title === 'Streaming map art');
  }

  // --- a full, realistic load ----------------------------------------------
  {
    const s = createLoadState({ sceneId: 'sceneA', sceneName: 'Town River Bridge', nowMs: 0 });
    beginPhase(s, LOAD_PHASES.SCENE);
    ok('1. reading: no bar, because nothing is countable yet', describeLoad(s, 10).fraction === null);

    beginPhase(s, LOAD_PHASES.ART, { total: 7 });
    for (let i = 1; i <= 7; i++) reportProgress(s, LOAD_PHASES.ART, { done: i, detail: `item ${i}` });
    ok('2. streaming: a real bar over real items', describeLoad(s, 500).fraction === 1);
    ok('2. streaming: STILL not complete despite a full bar', describeLoad(s, 500).complete === false);

    beginPhase(s, LOAD_PHASES.FIRST_FRAME);
    const ff = describeLoad(s, 600);
    ok('3. first frame: bar drops back to unknown rather than faking a hold at 100%', ff.fraction === null);
    ok('3. first frame: names what it is waiting for', ff.title === 'Drawing the first frame');

    completeLoad(s, 700);
    ok('4. complete, and only now', describeLoad(s, 800).complete === true);
    ok('4. total elapsed is real', describeLoad(s, 800).elapsedMs === 700);
  }

  // --- PHASE TIMINGS: "how long did each part of loading take?" -------------
  //
  // The author's ask (2026-07-17). The load model already knew the phase
  // transitions and already received the clock, so the stopwatch lives here
  // rather than in the flight recorder — a recorder timing this from boot.js's
  // three call sites would be a hand-kept list, and a fourth phase added later
  // would go silently unmeasured while the export still looked complete.
  {
    const s = mk(0);
    beginPhase(s, LOAD_PHASES.SCENE, { nowMs: 0 });
    beginPhase(s, LOAD_PHASES.ART, { nowMs: 12 });
    beginPhase(s, LOAD_PHASES.FIRST_FRAME, { nowMs: 2412 });
    completeLoad(s, 2592);

    ok('every phase entered is recorded', s.phases.length === 3);
    ok('phase 1 (reading the scene) is timed', s.phases[0].phase === LOAD_PHASES.SCENE && s.phases[0].durMs === 12);
    ok('phase 2 (streaming art — THE load) is timed', s.phases[1].durMs === 2400);
    ok('phase 3 (first frame) is timed', s.phases[2].durMs === 180);
    ok('entering a phase closes the previous one', s.phases[0].endMs === 12);
    ok('completeLoad closes the last phase', s.phases[2].endMs === 2592);
    ok('phase durations sum to the total', s.phases.reduce((a, p) => a + p.durMs, 0) === 2592);
    ok('spans are relative to the load start, not the epoch', s.phases[0].startMs === 0);
  }
  {
    // The phase that was running when it broke is the most interesting span in
    // the whole load. A dangling span would lose "it died 8s into streaming art".
    const s = mk(0);
    beginPhase(s, LOAD_PHASES.SCENE, { nowMs: 0 });
    beginPhase(s, LOAD_PHASES.ART, { nowMs: 10 });
    failLoad(s, 'decode failed', 8010);
    ok('failLoad closes the phase that was running', s.phases[1].endMs === 8010);
    ok('...with its real duration', s.phases[1].durMs === 8000);
    ok('...and the failure is still a failure, not a completion', s.error === 'decode failed' && s.complete === false);
  }
  {
    // A progress report for a phase we are not in IS a transition — and must be
    // timed like one, or the phase entered only this way is the one phase with
    // no duration.
    const s = mk(0);
    beginPhase(s, LOAD_PHASES.SCENE, { nowMs: 0 });
    reportProgress(s, LOAD_PHASES.ART, { done: 1, total: 7, nowMs: 40 });
    ok('an implicit transition via reportProgress opens a span', s.phases.length === 2);
    ok('...and closes the previous one at the right time', s.phases[0].durMs === 40);
    ok('...and the new span starts when it started', s.phases[1].startMs === 40);
    reportProgress(s, LOAD_PHASES.ART, { done: 2, nowMs: 60 });
    ok('progress WITHIN a phase does not open a second span', s.phases.length === 2);
  }
  {
    // An unmeasured duration must read as unmeasured, never as a confident NaN.
    // (`feedback_instruments_must_not_lie`: "could not measure" must never look
    // like a real number.)
    const s = mk(0);
    beginPhase(s, LOAD_PHASES.SCENE);
    ok('a phase entered with no clock still transitions', s.phase === LOAD_PHASES.SCENE);
    ok('...but reports its start as unknown, not NaN', s.phases[0].startMs === null);
    ok('...and says WHY in the span itself', /no clock was supplied/.test(s.phases[0].note));
    completeLoad(s, 100);
    ok('...and its duration stays null rather than becoming a fiction', s.phases[0].durMs === null);
  }
  {
    const s = mk(0);
    ok('a load with no phases has an empty list, not a fabricated one', s.phases.length === 0);
  }

  // --- LOAD_PHASES.MASKS (2026-07-17, the mask-discovery loading-screen seam) —
  // the machinery above is fully generic (already proven against 3 phases), so
  // this only needs to confirm the 4th phase is real vocabulary: it labels
  // itself, reports honest per-floor progress, and slots into the pipeline
  // between SCENE and ART without requiring any change to beginPhase/reportProgress.
  {
    const s = mk();
    beginPhase(s, LOAD_PHASES.MASKS);
    ok('MASKS names itself, not a generic fallback', describeLoad(s, 1000).title === 'Finding masks');

    reportProgress(s, LOAD_PHASES.MASKS, { done: 0, total: 3, detail: 'Ground Floor' });
    ok('MASKS starts at a real 0, not null, once the floor count is known', describeLoad(s, 1000).fraction === 0);

    reportProgress(s, LOAD_PHASES.MASKS, { done: 2, detail: 'Roof' });
    const mid = describeLoad(s, 1000);
    ok('MASKS progress is honest per-floor counting', Math.abs(mid.fraction - 2 / 3) < 1e-9);
    ok('MASKS detail matches the ART phase convention ("N of M · name")', mid.detail === '2 of 3 · Roof');
  }
  {
    // The realistic pipeline: SCENE (unknown total) → MASKS (per-floor) → ART
    // (per-item) → FIRST_FRAME (unknown again). Each transition closes the
    // previous span — no special-casing needed for the new phase.
    const s = createLoadState({ sceneId: 'sceneA', sceneName: 'Town River Bridge', nowMs: 0 });
    beginPhase(s, LOAD_PHASES.SCENE, { nowMs: 0 });
    beginPhase(s, LOAD_PHASES.MASKS, { total: 3, nowMs: 5 });
    for (let i = 1; i <= 3; i++) reportProgress(s, LOAD_PHASES.MASKS, { done: i, nowMs: 5 + i });
    beginPhase(s, LOAD_PHASES.ART, { total: 7, nowMs: 20 });
    ok('MASKS sits between SCENE and ART, each with its own closed span', s.phases.length === 3);
    ok('MASKS phase is timed like any other', s.phases[1].phase === LOAD_PHASES.MASKS && s.phases[1].durMs === 15);
    ok('MASKS closed exactly when ART opened', s.phases[1].endMs === 20);
    ok('the active phase is now ART, reporting ITS own title', describeLoad(s, 20).title === 'Streaming map art');
  }

  // --- THE WARM-UP HOLD ----------------------------------------------------
  // The gap this whole change exists to close: author, 2026-08-15 — "the
  // loading screen goes away and then it's a good long time, 10 to 20 seconds,
  // before the scene has settled and FPS is safe for playing."
  {
    const s = mk(0);
    beginPhase(s, LOAD_PHASES.WARMING, { nowMs: 0 });
    ok('WARMING has a human title', describeLoad(s, 0).title === 'Warming up');
    ok('DEVICE has one too', describeLoad(beginPhase(mk(0), LOAD_PHASES.DEVICE, { nowMs: 0 }), 0).title !== undefined);

    reportProgress(s, LOAD_PHASES.WARMING, {
      blockers: ['textures still being GPU-compressed (3)', 'GPU shader pipelines still compiling (2)'],
      nowMs: 10,
    });
    const d = describeLoad(s, 10);
    ok('blockers reach the description', d.blockers.length === 2);
    ok('...naming the stage, not just a count', /GPU-compressed/.test(d.blockers[0]));
    // Mutating the state must not rewrite a description someone already holds.
    s.blockers.push('a third thing');
    ok('describeLoad hands out a COPY of the blockers', d.blockers.length === 2);
  }

  // --- THE DEADLINE, AND WHY IT IS NOT A LIE -------------------------------
  {
    const s = mk(0);
    ok('a fresh load is not due for a forced reveal', hardRevealDue(s, 100, 1000) === false);
    ok('one that has run past the deadline is', hardRevealDue(s, 1000, 1000) === true);

    const done = mk(0);
    completeLoad(done, 50);
    ok(
      'a load that already finished is never "due" (it would fake a forced reveal)',
      hardRevealDue(done, 9999, 1000) === false
    );
    const failed = mk(0);
    failLoad(failed, 'boom', 50);
    ok('nor is one that failed', hardRevealDue(failed, 9999, 1000) === false);
    ok('a missing state does not throw', hardRevealDue(null, 1, 1) === false);
  }
  {
    // A FORCED REVEAL IS NOT A FINISHED LOAD. This is the §7 "Ready!" lie's
    // last hiding place: lift the curtain on a timer and call it success.
    const s = mk(0);
    reportProgress(s, LOAD_PHASES.WARMING, { blockers: ['map layers still loading (2)'], nowMs: 10 });
    completeLoad(s, 30000, { forced: true });
    const d = describeLoad(s, 30000);
    ok('a forced reveal does not say "Ready"', d.title !== 'Ready');
    ok('...and says what it is still doing', /still working/i.test(d.title));
    ok('...and does not claim 100%', d.fraction === null);
    ok('...and keeps naming what was unfinished', d.blockers.length === 1);
    ok('...and is flagged for the summary', d.forcedReveal === true && s.forcedReveal === true);

    const clean = mk(0);
    reportProgress(clean, LOAD_PHASES.WARMING, { blockers: ['something'], nowMs: 10 });
    completeLoad(clean, 500);
    const cd = describeLoad(clean, 500);
    ok('a genuine completion still says Ready', cd.title === 'Ready' && cd.fraction === 1);
    ok('...and carries no leftover blockers', cd.blockers.length === 0 && cd.forcedReveal === false);
  }

  // --- the blocker list is capped, and SAYS it is --------------------------
  {
    ok('an empty list renders as nothing', formatBlockerLines([]) === '');
    ok('a null list does not throw', formatBlockerLines(null) === '');
    const four = ['a', 'b', 'c', 'd'];
    ok('a list at the cap is shown whole', formatBlockerLines(four) === 'a\nb\nc\nd');
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    ok('an over-cap list never silently truncates', /…and 3 more/.test(formatBlockerLines(seven)));
  }
}
