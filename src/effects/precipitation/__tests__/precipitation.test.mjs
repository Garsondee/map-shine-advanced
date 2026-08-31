/**
 * Node verification for effects/precipitation/precipitation.js — the
 * declaration. Mirrors fluid.test.mjs's own job: prove the manifest and
 * schema are well-formed as DATA. The interesting assertion is the EMPTY
 * one — `PRECIPITATION_PARAMS` having no keys is a deliberate state (this
 * file's own header has the full account: precipitation's "look" is
 * weather-manager state, not a per-scene author dial), asserted with its
 * reason attached rather than left implicit, the same posture fluid's own
 * manifest test took before that effect had any real params either.
 */
import { PRECIPITATION, PRECIPITATION_PARAMS } from '../precipitation.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { validateParamsSchema } from '../../../core/params-schema.js';
import { precipTierPlan } from '../precip-species.js';

export function run(t) {
  const { ok } = t;

  {
    const r = validateEffectManifest(PRECIPITATION);
    ok(`manifest validates (${r.errors.join('; ')})`, r.ok === true);
  }
  {
    const r = validateParamsSchema(PRECIPITATION_PARAMS);
    ok('params schema validates', r.ok === true);
  }
  ok(
    'PRECIPITATION_PARAMS is deliberately empty — precipitation`s look is weather-manager state, not an author dial',
    Object.keys(PRECIPITATION_PARAMS).length === 0
  );
  ok('the manifest points at that same schema object', PRECIPITATION.params === PRECIPITATION_PARAMS);

  ok('id is the stable camelCase registry key', PRECIPITATION.id === 'precipitation');
  ok(
    'on by default at every profile — formalises, does not change, today`s hardcoded enabled:true',
    PRECIPITATION.enabledFromProfile === 'low'
  );
  ok('tier 0 is declared — a manifest without one is malformed', PRECIPITATION.tiers[0]?.n === 0);
  ok('the ladder is exactly 3 rungs, matching PRECIP_TIER_SCALES', PRECIPITATION.tiers.length === 3);
  ok(
    'rungs are contiguous 0..2',
    PRECIPITATION.tiers.every((t, i) => t.n === i)
  );
  ok('tier 1 is bought at performance', PRECIPITATION.tiers[1]?.fromProfile === 'performance');
  ok('tier 2 is bought at standard — the DEFAULT profile', PRECIPITATION.tiers[2]?.fromProfile === 'standard');

  ok(
    'every deferred rung carries a note explaining what it buys',
    PRECIPITATION.deferredRungs.every((r) => typeof r.note === 'string' && r.note.length > 40)
  );

  ok('the declaration is frozen', Object.isFrozen(PRECIPITATION) && Object.isFrozen(PRECIPITATION_PARAMS));

  // ── THE LADDER AND THE MANIFEST NEVER DISAGREE ───────────────────────────
  // `precipTierPlan` and the manifest's own tier count are two independently
  // hand-typed things (3 tiers vs. a 3-element PRECIP_TIER_SCALES array) —
  // this is the cross-check that catches them drifting apart.
  ok(
    'precipTierPlan resolves exactly as many rungs as the manifest declares',
    precipTierPlan(PRECIPITATION.tiers.length).tier === PRECIPITATION.tiers.length - 1
  );
  ok('tier 0`s scale matches the manifest`s own "40%" claim', precipTierPlan(0).tierScale === 0.4);
  ok('tier 2 (standard, the ceiling) matches the manifest`s own "100%" claim', precipTierPlan(2).tierScale === 1.0);
}
