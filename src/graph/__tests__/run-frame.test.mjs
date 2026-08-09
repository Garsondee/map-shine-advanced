/**
 * Node verification for graph/run-frame.js — the pass RUNNER, proven both in
 * isolation (synthetic pass lists) and against the REAL graph/passes.js, so a
 * future pass added to the geometry..present range without a wired impl fails
 * here instead of silently going dark on screen.
 */
import { planFrame, runPassPlan } from '../run-frame.js';
import { PASSES, STAGES } from '../passes.js';

const FAKE_PASSES = [
  { id: 'a.one', stage: 'sims', status: 'seam' },
  { id: 'b.two', stage: 'geometry', status: 'live' },
  { id: 'c.three', stage: 'geometry', status: 'future' },
  { id: 'd.four', stage: 'lighting', status: 'live' },
  { id: 'e.five', stage: 'present', status: 'live' },
];

export function run(t) {
  const { ok, throws } = t;

  // ---- planFrame: filters to LIVE within the stage range, preserves order ---
  {
    const { ids, skipped } = planFrame(FAKE_PASSES, { fromStage: 'geometry', toStage: 'present' });
    ok('geometry..present plan includes both live passes in declared order', ids.join(',') === 'b.two,d.four,e.five');
    ok('sims-stage pass is excluded (out of range), not just skipped', !skipped.some((s) => s.id === 'a.one'));
    ok(
      'the future geometry-stage pass is recorded as skipped, not planned',
      skipped.some((s) => s.id === 'c.three' && s.status === 'future') && !ids.includes('c.three')
    );
  }

  {
    const { ids } = planFrame(FAKE_PASSES); // default range = whole STAGES span
    ok('no range = every live pass, whole session', ids.join(',') === 'b.two,d.four,e.five');
  }

  {
    const { ids } = planFrame(FAKE_PASSES, { fromStage: 'sims', toStage: 'sims' });
    ok('a range containing no live passes plans nothing (not an error)', ids.length === 0);
  }

  throws('unknown fromStage throws', () => planFrame(FAKE_PASSES, { fromStage: 'nope' }), 'unknown fromStage');
  throws('unknown toStage throws', () => planFrame(FAKE_PASSES, { toStage: 'nope' }), 'unknown toStage');
  throws(
    'toStage before fromStage throws (a reversed range is a caller bug, not silently empty)',
    () => planFrame(FAKE_PASSES, { fromStage: 'present', toStage: 'geometry' }),
    'precedes'
  );

  // ---- runPassPlan: calls in order, threads ctx, collects what ran ----------
  {
    const calls = [];
    const ctx = { frame: 42 };
    const impls = {
      'b.two': (c) => calls.push(['b.two', c]),
      'd.four': (c) => calls.push(['d.four', c]),
      'e.five': (c) => calls.push(['e.five', c]),
    };
    const ran = runPassPlan(['b.two', 'd.four', 'e.five'], impls, ctx);
    ok('runPassPlan calls every id in order', calls.map((c) => c[0]).join(',') === 'b.two,d.four,e.five');
    ok(
      'the SAME ctx object is threaded to every call, untouched',
      calls.every((c) => c[1] === ctx)
    );
    ok('runPassPlan returns the ids that ran, in run order', ran.join(',') === 'b.two,d.four,e.five');
  }

  {
    const calls = [];
    throws(
      "a planned id with no impl throws, naming the id — a live pass can't silently go dark",
      () => runPassPlan(['b.two', 'missing.pass'], { 'b.two': () => calls.push('b.two') }, {}),
      "'missing.pass'"
    );
    ok('the pass BEFORE the missing one still ran (fail loud, not fail first)', calls.length === 1);
  }

  ok('runPassPlan on an empty plan is a no-op, not an error', runPassPlan([], {}, {}).length === 0);

  // ---- against the REAL graph: today's actual masks..present shape ----------
  // This is the regression guard: if passes.js ever adds a new live pass in
  // [masks..present] without updating vt-pan-viewer's local impls map, THIS
  // assertion is what should change first — and reviewing that diff is exactly
  // the point (not a silent extra id nobody wired).
  {
    const { ids } = planFrame(PASSES, { fromStage: 'masks', toStage: 'present' });
    // `surface.response` joined 2026-07-26 (Specular.md tiers 0-2), between
    // light.accumulate and surface.particles — which is not a detail: it MUST
    // sit after the pass that writes buf:scene.illum, because reading the
    // illumination is the whole reason it is a pass rather than a drawable in
    // geometry.world the way water's surface is.
    // `post.dof` joined 2026-08-06 (Depth-of-Field.md), between post.bloom and
    // present.composite (post.grade is still a seam, so it never appears in a
    // LIVE plan) — it reads buf:scene.depth, which is unaffected by ordering
    // relative to bloom either way, but runs AFTER bloom so a bloomed bright
    // light seen through a lower-floor hole blurs along with everything else.
    const expected =
      'masks.occlusion,geometry.world,light.accumulate,surface.response,surface.particles,post.bloom,post.dof,present.composite';
    ok(`today's real masks..present plan is exactly [${expected}] (got: ${ids.join(',')})`, ids.join(',') === expected);
    ok(
      'surface.response is planned AFTER light.accumulate — it reads what that pass writes',
      ids.indexOf('surface.response') > ids.indexOf('light.accumulate')
    );
  }

  ok('STAGES is non-empty (sanity: run-frame.js depends on it)', STAGES.length > 0);

  // ---- TIMING HOOKS (docs/planning/Performance.md) --------------------------
  // The runner is the one place a per-pass timing wrap belongs, and this file
  // has said so since it was written. What is tested here is not that the hooks
  // fire — it is that they PAIR, under every exit path, because an unterminated
  // zone does not crash: it silently poisons that zone's number for the rest of
  // the session, which is a wrong answer surviving a visible failure.
  {
    const events = [];
    const impls = {
      'b.two': () => events.push('run:b.two'),
      'd.four': () => events.push('run:d.four'),
    };
    const ran = runPassPlan(
      ['b.two', 'd.four'],
      impls,
      {},
      {
        onPassBegin: (id) => events.push(`begin:${id}`),
        onPassEnd: (id) => events.push(`end:${id}`),
      }
    );
    ok(
      'hooks bracket each pass in begin/run/end order',
      events.join(',') === 'begin:b.two,run:b.two,end:b.two,begin:d.four,run:d.four,end:d.four'
    );
    ok('hooks do not change what runPassPlan returns', ran.join(',') === 'b.two,d.four');
  }

  {
    // A pass that throws must STILL close its zone.
    const events = [];
    const boom = new Error('pass exploded');
    let caught = null;
    try {
      runPassPlan(
        ['b.two'],
        {
          'b.two': () => {
            events.push('run');
            throw boom;
          },
        },
        {},
        { onPassBegin: (id) => events.push(`begin:${id}`), onPassEnd: (id) => events.push(`end:${id}`) }
      );
    } catch (e) {
      caught = e;
    }
    ok('a throwing pass still propagates its error', caught === boom);
    ok('...and its zone is still closed', events.join(',') === 'begin:b.two,run,end:b.two');
  }

  {
    // A missing impl must throw BEFORE opening a zone, so the failure can never
    // be read as "a pass that ran and cost nothing".
    const events = [];
    throws(
      'a missing impl throws before any zone is opened',
      () =>
        runPassPlan(
          ['missing.pass'],
          {},
          {},
          {
            onPassBegin: (id) => events.push(`begin:${id}`),
            onPassEnd: (id) => events.push(`end:${id}`),
          }
        ),
      "'missing.pass'"
    );
    ok('no zone was opened for the missing pass', events.length === 0);
  }

  {
    // Every hook shape must be optional and independently omittable — the
    // profiler is disarmed almost always, and the disarmed path must not need a
    // pair of no-op closures allocated per frame.
    ok('hooks may be omitted entirely', runPassPlan(['b.two'], { 'b.two': () => {} }, {}).length === 1);
    ok('hooks may be undefined', runPassPlan(['b.two'], { 'b.two': () => {} }, {}, undefined).length === 1);
    ok('an empty hooks object is fine', runPassPlan(['b.two'], { 'b.two': () => {} }, {}, {}).length === 1);
    const onlyBegin = [];
    runPassPlan(['b.two'], { 'b.two': () => {} }, {}, { onPassBegin: (id) => onlyBegin.push(id) });
    ok('onPassBegin alone works without onPassEnd', onlyBegin.join(',') === 'b.two');
    const onlyEnd = [];
    runPassPlan(['b.two'], { 'b.two': () => {} }, {}, { onPassEnd: (id) => onlyEnd.push(id) });
    ok('onPassEnd alone works without onPassBegin', onlyEnd.join(',') === 'b.two');
    ok(
      'a non-function hook is ignored rather than throwing mid-frame',
      runPassPlan(['b.two'], { 'b.two': () => {} }, {}, { onPassBegin: 'nope', onPassEnd: 42 }).length === 1
    );
  }
}
