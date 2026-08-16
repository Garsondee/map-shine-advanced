/**
 * Node verification for vt/settle.js — the "is the scene actually finished
 * loading" detector.
 *
 * The properties pinned here are the ones whose failure modes are expensive and
 * SILENT: declaring settled while work is outstanding (a screenshot of a
 * half-drawn map, read as truth), declaring settled during the gap between two
 * stages (the premature-completion bug this module exists to end), and
 * declaring settled in a renderer that is not drawing at all.
 */
import {
  createSettleTracker,
  createReadinessRegistry,
  summarizeSettleWork,
  DEFAULT_SETTLE_QUIET_MS,
  READINESS_STAGE,
  SETTLE_WORK_KEYS,
} from '../settle.js';

export function run(t) {
  const { ok, throws } = t;

  // --- summarizeSettleWork -------------------------------------------------
  {
    const { blockers, totalOutstanding } = summarizeSettleWork({ itemsLoading: 3, residencyInFlight: true });
    ok(
      'counts a numeric counter',
      blockers.some((b) => b.key === 'itemsLoading' && b.count === 3)
    );
    ok(
      'treats a boolean flag as one unit of work',
      blockers.some((b) => b.key === 'residencyInFlight' && b.count === 1)
    );
    ok('totals across kinds', totalOutstanding === 4);
    ok(
      'every blocker carries a human label',
      blockers.every((b) => typeof b.label === 'string' && b.label.length > 5)
    );
  }
  {
    const { blockers, totalOutstanding } = summarizeSettleWork({});
    ok('an empty bag is zero work, never a fabricated blocker', blockers.length === 0 && totalOutstanding === 0);
    const missing = summarizeSettleWork(null);
    ok('a null bag does not throw', missing.totalOutstanding === 0);
    const unknown = summarizeSettleWork({ somethingElse: 99 });
    ok('an unknown key is ignored, never counted as work', unknown.totalOutstanding === 0);
  }
  {
    const keys = new Set(SETTLE_WORK_KEYS.map((k) => k.key));
    ok('the key list has no duplicates', keys.size === SETTLE_WORK_KEYS.length);
  }

  // --- the quiet period ----------------------------------------------------
  // THE CENTRAL CASE: counters dip through zero between stages. A reader that
  // calls the first zero "done" reproduces exactly the bug this module exists
  // to fix, so a single zero sample must NEVER settle.
  {
    const tr = createSettleTracker({ quietMs: 1000, minFrames: 2 });
    let s = tr.sample({ itemsLoading: 2 }, 0, 0);
    ok('work outstanding is not settled', s.settled === false && s.totalOutstanding === 2);
    s = tr.sample({}, 100, 10);
    ok('the FIRST zero sample is not settled (this is the between-stages dip)', s.settled === false);
    s = tr.sample({ bcCompressOutstanding: 1 }, 200, 20);
    ok('work reappearing restarts the clock', s.settled === false && s.quietForMs === 0);
    s = tr.sample({}, 300, 30);
    s = tr.sample({}, 1200, 40);
    ok('quiet must be measured from the RESTART, not the first ever zero', s.settled === false);
    s = tr.sample({}, 1301, 50);
    ok('settles once the full quiet period has elapsed with frames advancing', s.settled === true);
    ok('and reports nothing outstanding', s.blockers.length === 0 && s.waitingFor.length === 0);
  }

  // --- a still renderer is not a settled one -------------------------------
  {
    const tr = createSettleTracker({ quietMs: 100, minFrames: 2 });
    tr.sample({}, 0, 5);
    const s = tr.sample({}, 5000, 5); // ages of quiet, but the frame count never moved
    ok('zero work + zero frames is NOT settled', s.settled === false);
    ok(
      '...and it says so plainly',
      s.waitingFor.some((w) => /frames/i.test(w))
    );
    const s2 = tr.sample({}, 6000, 9);
    ok('once frames advance, it settles', s2.settled === true);
  }

  // --- what it was waiting for --------------------------------------------
  {
    const tr = createSettleTracker({ quietMs: 1000 });
    const s = tr.sample({ itemsLoading: 1, maskPagesPending: 7 }, 0, 0);
    ok(
      'waitingFor names each blocker with its count',
      s.waitingFor.length === 2 && /\(7\)/.test(s.waitingFor.join(' '))
    );
    ok('blockers are ordered by the loading chain, earliest first', s.blockers[0].key === 'itemsLoading');
    const quiet = tr.sample({}, 10, 5);
    ok('during the quiet dwell it says it is waiting on the period itself', /quiet period/.test(quiet.waitingFor[0]));
  }

  // --- frame-time steadiness ("FPS is safe for playing") -------------------
  // The author's requirement was never "the bytes arrived". Zero outstanding
  // work with a 200ms hitch inside the dwell is not a playable scene, and every
  // counter in this module is blind to that by construction.
  {
    const tr = createSettleTracker({ quietMs: 1000, minFrames: 2, hitchMs: 50 });
    let s = tr.sample({}, 0, 0, { maxFrameGapMs: 16 });
    ok('a healthy gap does not disturb the clock', s.criteria.steadiness === 'pass');
    s = tr.sample({}, 900, 20, { maxFrameGapMs: 16 });
    s = tr.sample({}, 1100, 30, { maxFrameGapMs: 240 });
    ok('a hitch inside the dwell blocks', s.settled === false && s.criteria.steadiness === 'blocked');
    ok('...and restarts the clock rather than merely failing', s.quietForMs === 0);
    ok(
      '...and names itself with the gap that caused it',
      s.waitingFor.some((w) => /frame time not steady/i.test(w) && /240/.test(w))
    );
    s = tr.sample({}, 1200, 40, { maxFrameGapMs: 16 });
    s = tr.sample({}, 2300, 50, { maxFrameGapMs: 16 });
    ok('a clean dwell after the hitch settles', s.settled === true);
  }
  {
    // A missing threshold must never read as a silent pass — an unmeasured
    // criterion is a measurement (`feedback_absent_zone_row_is_a_measurement`).
    const noThreshold = createSettleTracker({ quietMs: 10 });
    const a = noThreshold.sample({}, 0, 0, { maxFrameGapMs: 5000 });
    ok('no hitchMs supplied reports unavailable, not pass', a.criteria.steadiness === 'unavailable');
    ok('...and a 5s gap it was never told to judge does not block', a.blockers.length === 0);
    const noGap = createSettleTracker({ quietMs: 10, hitchMs: 50 });
    const b = noGap.sample({}, 0, 0);
    ok('a threshold with no gap reading is also unavailable', b.criteria.steadiness === 'unavailable');
  }

  // --- pipeline compilation (the invisible tail) ---------------------------
  // compileAsync(scene, camera) covers one of the viewer's eight scenes; every
  // post-pass, particle and overlay pipeline compiles lazily on first draw,
  // inside frames the user is already watching. Nothing counts that, so it is
  // fed in as a cumulative total and diffed here.
  {
    const tr = createSettleTracker({ quietMs: 1000, minFrames: 2 });
    let s = tr.sample({}, 0, 0, { pipelineCompileCount: 84 });
    ok('the FIRST reading is a baseline, never a delta', s.criteria.pipelines === 'pass' && s.blockers.length === 0);
    s = tr.sample({}, 500, 10, { pipelineCompileCount: 84 });
    ok('no new compiles keeps the clock running', s.quietForMs === 500);
    s = tr.sample({}, 900, 20, { pipelineCompileCount: 87 });
    ok('a new pipeline compile blocks', s.criteria.pipelines === 'blocked');
    ok('...and restarts the clock', s.quietForMs === 0);
    ok(
      '...and reports how many compiled, not that "something happened"',
      s.blockers.some((b) => b.key === 'pipelineCompiles' && b.count === 3)
    );
    s = tr.sample({}, 1000, 30, { pipelineCompileCount: 87 });
    s = tr.sample({}, 2100, 40, { pipelineCompileCount: 87 });
    ok('once compilation stops, it settles', s.settled === true);
  }
  {
    const tr = createSettleTracker({ quietMs: 10 });
    const none = tr.sample({}, 0, 0);
    ok('no pipeline counter supplied reports unavailable', none.criteria.pipelines === 'unavailable');
  }
  {
    // THE FLOOR-SWITCH CASE. reset() starts a new settle epoch, but the pipeline
    // total is a property of the DEVICE for the whole session. Re-baselining it
    // on reset would make the first sample after every floor switch blind to a
    // compile inside exactly the window that switch cares about.
    const tr = createSettleTracker({ quietMs: 1000, minFrames: 2 });
    tr.sample({}, 0, 0, { pipelineCompileCount: 84 });
    tr.reset();
    const s = tr.sample({}, 100, 10, { pipelineCompileCount: 90 });
    ok(
      'a compile that spans a reset is still seen (the baseline survives)',
      s.criteria.pipelines === 'blocked' && s.blockers.some((b) => b.count === 6)
    );
  }

  // --- the probe registry --------------------------------------------------
  {
    const reg = createReadinessRegistry({ builtinKeys: [] });
    ok('an empty registry starts empty', reg.size === 0 && reg.list().length === 0);

    reg.register({ id: 'lateBake', label: 'water SDF still baking', read: () => 2, stage: READINESS_STAGE.BAKE });
    reg.register({
      id: 'earlyStream',
      label: 'map layers still loading',
      read: () => 1,
      stage: READINESS_STAGE.STREAM,
    });
    ok('registration is reported by stage order, not insertion order', reg.list()[0].id === 'earlyStream');

    const { raw, keys, unavailable } = reg.collect();
    ok('collect reads every probe', raw.earlyStream === 1 && raw.lateBake === 2);
    ok('collect hands back descriptors in the same order', keys[0].key === 'earlyStream');
    ok('nothing threw, so nothing is unavailable', unavailable.length === 0);

    const { blockers, totalOutstanding } = summarizeSettleWork(raw, keys);
    ok('registry output feeds summarizeSettleWork unchanged', totalOutstanding === 3);
    ok('and keeps the chain order for diagnosis', blockers[0].key === 'earlyStream');
  }
  {
    const reg = createReadinessRegistry({ builtinKeys: [] });
    reg.register({ id: 'dup', label: 'a real sentence', read: () => 0 });
    throws(
      'a duplicate id throws at the call site',
      () => reg.register({ id: 'dup', label: 'another one', read: () => 0 }),
      'already registered'
    );
    throws('a missing id throws', () => reg.register({ label: 'a real sentence', read: () => 0 }), 'id');
    throws('a missing read() throws', () => reg.register({ id: 'x', label: 'a real sentence' }), 'read()');
    throws(
      'a key-name masquerading as a label throws',
      () => reg.register({ id: 'y', label: 'veg', read: () => 0 }),
      'label'
    );
    throws('binding an unknown probe throws', () => reg.bind('nope', () => 0), 'unknown');
  }
  {
    // A probe that throws must not be able to read as "no work" — that is the
    // instrument lying. It is named instead, and (documented trade-off) does
    // not block, because a floor switch now holds the old floor indefinitely
    // and one broken probe must not wedge it forever.
    const reg = createReadinessRegistry({ builtinKeys: [] });
    reg.register({
      id: 'broken',
      label: 'a subsystem that cannot answer',
      read: () => {
        throw new Error('worker died');
      },
    });
    reg.register({ id: 'fine', label: 'a subsystem that can answer', read: () => 0 });
    const { raw, unavailable } = reg.collect();
    ok('a throwing probe is absent from raw, never zero', !('broken' in raw));
    ok('...and is named with its error', unavailable.length === 1 && /worker died/.test(unavailable[0].error));
    ok('...and does not stop the others being read', raw.fine === 0);
  }
  {
    const reg = createReadinessRegistry();
    ok('the built-in streaming counters are seeded by default', reg.has('itemsLoading') && reg.has('maskPagesPending'));
    ok('...and read zero until something binds them', reg.collect().raw.itemsLoading === 0);
    reg.bind('itemsLoading', () => 4);
    ok('bind re-points a seeded probe at its real source', reg.collect().raw.itemsLoading === 4);
    ok('unregister removes a probe', reg.unregister('itemsLoading') === true && !reg.has('itemsLoading'));
  }
  {
    // The whole point of the registry: a probe registered next to its own code
    // reaches the settle verdict without anyone editing a central list.
    const reg = createReadinessRegistry({ builtinKeys: [] });
    reg.register({ id: 'newEffectBake', label: 'a brand new effect still baking', read: () => 1 });
    const tr = createSettleTracker({ quietMs: 10 });
    const { raw, keys } = reg.collect();
    const s = tr.sample(raw, 0, 0, { keys });
    ok(
      'an effect nobody added to SETTLE_WORK_KEYS still blocks readiness',
      s.settled === false && s.waitingFor.some((w) => /brand new effect/.test(w))
    );
  }

  // --- housekeeping --------------------------------------------------------
  {
    const tr = createSettleTracker();
    ok('read() before any sample is null, never a fake settled', tr.read() === null);
    tr.sample({}, 0, 0);
    ok('read() returns the last sample', tr.read() !== null);
    tr.reset();
    ok('reset clears it (a floor switch starts a NEW settle, not a continued one)', tr.read() === null);
    ok('the default quiet period is a real, positive number', DEFAULT_SETTLE_QUIET_MS > 0);
  }
}
