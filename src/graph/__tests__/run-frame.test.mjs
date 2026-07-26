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
    const expected =
      'masks.occlusion,geometry.world,light.accumulate,surface.response,surface.particles,post.bloom,present.composite';
    ok(`today's real masks..present plan is exactly [${expected}] (got: ${ids.join(',')})`, ids.join(',') === expected);
    ok(
      'surface.response is planned AFTER light.accumulate — it reads what that pass writes',
      ids.indexOf('surface.response') > ids.indexOf('light.accumulate')
    );
  }

  ok('STAGES is non-empty (sanity: run-frame.js depends on it)', STAGES.length > 0);
}
