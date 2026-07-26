/**
 * water.test.mjs — the water declaration is a valid, registrable effect.
 * Registration MACHINERY is proven in effect-registration.test.mjs; this
 * pins water's own shape and that it flows through the one door.
 *
 * WATER_PARAMS is deliberately empty right now — see water.js's own header
 * for why (declaration first, implementation second, taken literally: tier
 * 0's actual params arrive in phase 3, alongside the render code that reads
 * them, never ahead of it).
 */
import { validateParamsSchema } from '../../../core/params-schema.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { createEffectRegistry } from '../../registry.js';
import { resolveEffectEnabled } from '../../effect-cascade.js';
import { WATER, WATER_PARAMS } from '../water.js';

export function run(t) {
  const { ok, throws } = t;

  // --- the declaration validates ------------------------------------------
  ok('WATER_PARAMS is a valid params schema (even though empty)', validateParamsSchema(WATER_PARAMS).ok);
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

  // --- the ladder: only tier 0 is real, 1-8 are honestly deferred ---------
  ok('tiers has exactly one rung (tier 0) — nothing claimed that is not built', WATER.tiers.length === 1);
  ok('tier 0 is n=0', WATER.tiers[0].n === 0);
  ok('tier 0 has a cost class', WATER.tiers[0].cost.class === 'C4');
  ok('tier 0 has a one-line adds', typeof WATER.tiers[0].adds === 'string' && WATER.tiers[0].adds.length > 0);
  ok('deferredRungs records the full remaining ladder (tiers 1-8)', WATER.deferredRungs.length === 8);
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
