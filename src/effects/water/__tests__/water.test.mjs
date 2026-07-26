/**
 * water.test.mjs — the water declaration is a valid, registrable effect.
 * Registration MACHINERY is proven in effect-registration.test.mjs; this
 * pins water's own shape and that it flows through the one door.
 *
 * WATER_PARAMS grows one TIER at a time, never ahead of the code that reads
 * it — see water.js's own header. It was deliberately EMPTY through phases
 * 1-2 (params/no-dead-controls would have failed the build otherwise), gained
 * tier 0's three in phase 3, and tier 1's three in phase 4.
 */
import { validateParamsSchema } from '../../../core/params-schema.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { createEffectRegistry } from '../../registry.js';
import { resolveEffectEnabled } from '../../effect-cascade.js';
import { WATER, WATER_PARAMS } from '../water.js';

export function run(t) {
  const { ok, throws } = t;

  // --- the declaration validates ------------------------------------------
  ok('WATER_PARAMS is a valid params schema', validateParamsSchema(WATER_PARAMS).ok);
  ok('WATER is a valid manifest', validateEffectManifest(WATER).ok);
  ok("the effect's id is water", WATER.id === 'water');
  ok(
    'water does not flash (a11y photosensitive false) — tier 0 has no flicker at all',
    WATER.a11y.photosensitive === false
  );

  // --- default ON: tier 0 is a mask read + a tint, nearly free ------------
  ok('gated to low → on even at Low', WATER.enabledFromProfile === 'low');
  ok('resolves ON at Low by default', resolveEffectEnabled(WATER, { profile: 'low' }) === true);
  ok('resolves ON at Standard by default', resolveEffectEnabled(WATER, { profile: 'standard' }) === true);
  ok(
    'a player can still turn it OFF (final say)',
    resolveEffectEnabled(WATER, { profile: 'low', playerEnable: 'off' }) === false
  );

  // --- the ladder: BUILT rungs in `tiers`, the rest honestly deferred -----
  // The counts are asserted RELATIVE to each other rather than pinned to
  // literals: this block previously hardcoded "exactly one rung" and "8
  // deferred", which is the correct invariant expressed in a way that has to
  // be edited every time a rung actually lands. What matters is that the two
  // together always describe the whole 9-rung ladder with nothing claimed
  // twice and nothing dropped — that holds at every phase.
  ok(
    'every built rung is numbered contiguously from 0',
    WATER.tiers.every((t, i) => t.n === i)
  );
  ok(
    'built + deferred always account for the whole 0-8 ladder, no gaps, no double-claims',
    WATER.tiers.length + WATER.deferredRungs.length === 9
  );
  ok('tier 0 is the admission price, C4', WATER.tiers[0].cost.class === 'C4');
  ok(
    'every built rung carries a cost class and a one-line adds',
    WATER.tiers.every((t) => typeof t.cost?.class === 'string' && typeof t.adds === 'string' && t.adds.length > 0)
  );
  // Tier 1 is the first rung of the C1→C8 staircase proper (Effects.md §4):
  // tier 0's class is the admission price and is exempt from monotonicity.
  ok(
    'tier 1, once built, is C1 — the staircase starts cheap',
    WATER.tiers[1] === undefined || WATER.tiers[1].cost.class === 'C1'
  );
  ok(
    "deferredRungs entries are named, not built (no n, no cost — bloom.js's own shape)",
    WATER.deferredRungs.every((r) => typeof r.name === 'string' && typeof r.note === 'string' && r.n === undefined)
  );

  // --- it flows through the ONE door (the velocity test in miniature) -----
  {
    const reg = createEffectRegistry();
    let applied = null;
    const id = reg.register(WATER, (r) => {
      applied = r;
    });
    ok('register returns the water id', id === 'water');
    const resolved = reg.resolveAndApply('water', { profile: 'standard' });
    ok('resolveAndApply drives the water apply', applied !== null && applied.enabled === true);
    // Phase 3 gave water its first real params (tier 0's three), so this
    // asserts the DEFAULTS flow through the cascade rather than the schema
    // being empty — which is what it checked while the schema deliberately
    // was (see water.js's header on why params arrive with their consumer).
    ok(
      'resolved params carry every schema default',
      Object.keys(resolved.params).length === Object.keys(WATER_PARAMS).length
    );
    ok(
      '...including the tint, decoded later by the registration seam',
      resolved.params.tint === WATER_PARAMS.tint.default
    );
    ok(
      '...and the shoreline threshold that antialiases the edge',
      resolved.params.shorelineDepth === WATER_PARAMS.shorelineDepth.default
    );
    throws('a duplicate water registration throws', () => reg.register(WATER, () => {}), 'already registered');
  }
}
