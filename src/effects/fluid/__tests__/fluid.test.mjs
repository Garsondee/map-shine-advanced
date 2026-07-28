/**
 * Node verification for effects/fluid/fluid.js — the declaration.
 *
 * Mirrors water.test.mjs's job: prove the manifest and schema are well-formed
 * as DATA, months before a governor or a settings dialog exists to trip over
 * them. The interesting assertion is the EMPTY one — `FLUID_PARAMS` having no
 * keys is a deliberate state this phase must not drift out of by accident, so
 * it is asserted with its reason attached rather than left implicit.
 */
import { FLUID, FLUID_PARAMS } from '../fluid.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { validateParamsSchema } from '../../../core/params-schema.js';

export function run(t) {
  const { ok } = t;

  {
    const r = validateEffectManifest(FLUID);
    ok(`manifest validates (${r.errors.join('; ')})`, r.ok === true);
  }
  {
    const r = validateParamsSchema(FLUID_PARAMS);
    ok('params schema validates', r.ok === true);
  }

  // Every key must be consumed by fluid-render.js — `params/no-dead-controls`
  // enforces that across the tree; this pins the SHAPE so a key cannot be added
  // here without someone noticing it needs a consumer.
  ok('FLUID_PARAMS carries the Look + Motion + Detail knobs', Object.keys(FLUID_PARAMS).length === 6);
  ok(
    'every param declares a category so the ROH card can group it',
    Object.values(FLUID_PARAMS).every((p) => typeof p.category === 'string' && p.category.length > 0)
  );
  ok(
    'every param declares plain-language help (Effects-UI.md)',
    Object.values(FLUID_PARAMS).every((p) => typeof p.help === 'string' && p.help.length > 30)
  );
  ok('the manifest points at that same schema object', FLUID.params === FLUID_PARAMS);
  ok(
    'no rung is both a built tier and a deferred one',
    !FLUID.deferredRungs.some((r) => FLUID.tiers.some((t) => t.name === r.name))
  );

  ok('id is the stable camelCase registry key', FLUID.id === 'fluid');
  ok('a decoration is defended late under budget', FLUID.visualWeight <= 0.4);
  ok('on by default at every profile', FLUID.enabledFromProfile === 'low');
  ok('tier 0 is declared — a manifest without one is malformed', FLUID.tiers[0]?.n === 0);
  ok('tier 0 is the C4 admission price (the mask read)', FLUID.tiers[0]?.cost?.class === 'C4');
  ok('tiers 0-5 are real code now', FLUID.tiers.length === 6);
  ok(
    'the ladder is named in build order',
    FLUID.tiers.map((t) => t.name).join() === 'placement,tube,flow,film,fill,structure'
  );
  ok('no tier still claims to be unbuilt', !FLUID.tiers.some((t) => /NOT BUILT/.test(t.adds)));
  ok(
    // Mirrors `validateEffectManifest`'s own loop exactly (`effect-manifest.js`):
    // starts at tiers[2] vs tiers[1], never tiers[1] vs tiers[0] — tier 0 is
    // the admission price, explicitly EXEMPT from the monotonic chain (water's
    // own C4-then-C1 is why: cheaper-than-tier-0 at tier 1 is correct, not a
    // violation). This is `validateEffectManifest`'s job to enforce, already
    // exercised by "manifest validates" above; this test additionally PINS
    // rungs 1..N=5's SHAPE so a future edit that breaks the chain fails with
    // a message naming a real tier, not just a generic manifest error.
    'cost class is non-decreasing across rungs 1..N (Law 3 — tier 0 exempt, matching effect-manifest.js)',
    (() => {
      const order = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
      for (let i = 2; i < FLUID.tiers.length; i++) {
        if (order.indexOf(FLUID.tiers[i].cost.class) < order.indexOf(FLUID.tiers[i - 1].cost.class)) return false;
      }
      return true;
    })()
  );

  // The ladder is the design's deferred list, and it must stay ordered and
  // complete — a rung quietly dropped here is a feature quietly cancelled.
  const rungNames = FLUID.deferredRungs.map((r) => r.name);
  ok(
    'the four UNBUILT rungs are recorded, in ladder order — and the three now shipped as tiers are not',
    rungNames.join() === 'bubbles,optics,emission,spray'
  );
  ok(
    'every deferred rung carries a note explaining what it buys',
    FLUID.deferredRungs.every((r) => typeof r.note === 'string' && r.note.length > 40)
  );

  ok('the declaration is frozen', Object.isFrozen(FLUID) && Object.isFrozen(FLUID_PARAMS));
}
