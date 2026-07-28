/**
 * Node tests for perf-zones.js — the zone taxonomy.
 *
 * The point of these is not that the data parses. It is that the taxonomy is
 * checked against the LIVE pass graph and the LIVE effect manifests, so a zone
 * naming a pass that was renamed, or an effect that was deleted, fails the build
 * instead of quietly producing a report row nobody can act on.
 *
 * `PASS_BUDGETS_MS`'s keys get the same treatment specifically because the
 * deleted `graph/v3-perf.js` shipped a budget table keyed to stage names that
 * matched nothing — every lookup fell through to a default and the budget was
 * decorative for its whole life. That is the bug this suite exists to prevent
 * recurring.
 */
import { PASSES, STAGES } from '../../graph/index.js';
import {
  BLOOM,
  CANDLE_FLAME,
  DOOR_GRAPHICS,
  FLUID,
  GRADE,
  SPECULAR,
  SUN_SHADOWS,
  UI_WINDOW_SHADOW,
  VEGETATION,
  WATER,
  WINDOW,
} from '../../effects/index.js';
import {
  DEFAULT_PASS_BUDGET_MS,
  EFFECT_ZONING,
  FRAME_BUDGET_MS,
  PASS_BUDGETS_MS,
  PASS_ZONE_PREFIX,
  SPARSE_CADENCES,
  ZONE_CADENCES,
  ZONE_KINDS,
  ZONES,
  isSparseCadence,
  validateEffectZoning,
  validateZoneTaxonomy,
  zoneById,
  zoneIndexOf,
  zonesForPass,
} from '../perf-zones.js';

const MANIFESTS = [
  BLOOM,
  GRADE,
  WATER,
  SPECULAR,
  WINDOW,
  FLUID,
  SUN_SHADOWS,
  CANDLE_FLAME,
  DOOR_GRAPHICS,
  VEGETATION,
  UI_WINDOW_SHADOW,
];

export function run(t) {
  const { ok } = t;

  const livePassIds = PASSES.filter((p) => p.status === 'live').map((p) => p.id);
  const effectIds = MANIFESTS.map((m) => m.id);
  const live = { passIds: livePassIds, stages: [...STAGES], effectIds };

  // ---- 1. The real taxonomy validates against the real graph ----------------
  {
    const res = validateZoneTaxonomy(ZONES, live);
    ok(`ZONES validates against live PASSES/STAGES/effects (${res.errors.join(' | ')})`, res.ok);
    ok('ZONES is non-empty', ZONES.length > 0);
    ok('ZONES is frozen', Object.isFrozen(ZONES));
    ok(
      'every ZoneDecl is frozen',
      ZONES.every((z) => Object.isFrozen(z))
    );
  }

  // ---- 2. Ids are unique and never squat the derived pass namespace ---------
  {
    const ids = ZONES.map((z) => z.id);
    ok('no duplicate zone ids', new Set(ids).size === ids.length);
    ok(
      `no declared id starts with '${PASS_ZONE_PREFIX}'`,
      ids.every((id) => !id.startsWith(PASS_ZONE_PREFIX))
    );
  }

  // ---- 3. `site` names a function, never a line number ----------------------
  // Line numbers rot: a nine-line comment edit in vt-pan-viewer.js during this
  // module's own authoring shifted every citation below it by nine.
  {
    ok(
      'no site field contains a :line suffix',
      ZONES.every((z) => !/:\d+/.test(z.site))
    );
    ok(
      'every site is a non-empty string',
      ZONES.every((z) => typeof z.site === 'string' && z.site.length > 0)
    );
  }

  // ---- 4. Budgets are keyed to REAL live pass ids (the v3-perf lesson) ------
  {
    const budgetKeys = Object.keys(PASS_BUDGETS_MS);
    const unknown = budgetKeys.filter((k) => !livePassIds.includes(k));
    ok(`every PASS_BUDGETS_MS key is a live pass id (stray: ${unknown.join(', ') || 'none'})`, unknown.length === 0);
    ok('PASS_BUDGETS_MS is non-empty', budgetKeys.length > 0);
    ok(
      'every budget is a positive finite number',
      budgetKeys.every((k) => Number.isFinite(PASS_BUDGETS_MS[k]) && PASS_BUDGETS_MS[k] > 0)
    );
    ok('DEFAULT_PASS_BUDGET_MS is positive', DEFAULT_PASS_BUDGET_MS > 0);
    ok('FRAME_BUDGET_MS matches the 120Hz target perf-lab already judges against', FRAME_BUDGET_MS === 8.33);
    // The budgets should not silently exceed the frame budget in aggregate —
    // a "budget" whose sum is unachievable is decoration, not a target.
    const sum = budgetKeys.reduce((a, k) => a + PASS_BUDGETS_MS[k], 0);
    ok(`pass budgets sum (${sum.toFixed(2)}ms) <= FRAME_BUDGET_MS`, sum <= FRAME_BUDGET_MS + 1e-9);
  }

  // ---- 5. Lookups ----------------------------------------------------------
  {
    const first = ZONES[0];
    ok('zoneById finds a real zone', zoneById(first.id) === first);
    ok('zoneById returns null for an unknown id, never undefined', zoneById('nope.nope') === null);
    ok('zoneIndexOf is dense from 0', zoneIndexOf(first.id) === 0);
    ok('zoneIndexOf returns -1 for an unknown id', zoneIndexOf('nope.nope') === -1);
    ok(
      'zoneIndexOf agrees with array position for every zone',
      ZONES.every((z, i) => zoneIndexOf(z.id) === i)
    );
    const lightZones = zonesForPass('light.accumulate');
    ok('zonesForPass finds the light.accumulate sub-zones', lightZones.length > 10);
    ok(
      'zonesForPass returns only zones of that pass',
      lightZones.every((z) => z.pass === 'light.accumulate')
    );
    ok('zonesForPass on an unknown pass returns empty', zonesForPass('no.such.pass').length === 0);
  }

  // ---- 6. Cadence semantics ------------------------------------------------
  {
    ok('bake is sparse', isSparseCadence('bake'));
    ok('event is sparse', isSparseCadence('event'));
    ok('steady is NOT sparse', !isSparseCadence('steady'));
    ok('conditional is NOT sparse', !isSparseCadence('conditional'));
    ok(
      'every SPARSE_CADENCES entry is a valid cadence',
      SPARSE_CADENCES.every((c) => ZONE_CADENCES.includes(c))
    );
    // The two bakes are the reason the cadence field exists at all.
    ok('sun shadow bake is declared as a bake', zoneById('light.sunShadowBake').cadence === 'bake');
    ok('water body bake is declared as a bake', zoneById('light.waterBodyBake').cadence === 'bake');
    ok('residency is declared as an event', zoneById('residency.pass').cadence === 'event');
  }

  // ---- 7. The validator actually rejects each error class ------------------
  // A validator nobody has watched fail is an untested validator.
  {
    const good = ZONES[0];
    const bad = (over) => validateZoneTaxonomy([{ ...good, ...over }], live);

    ok('rejects a duplicate id', !validateZoneTaxonomy([good, good], live).ok);
    ok('rejects an empty id', !bad({ id: '' }).ok);
    ok('rejects a pass.-prefixed id', !bad({ id: 'pass.light.accumulate' }).ok);
    ok('rejects a missing label', !bad({ label: '' }).ok);
    ok('rejects a site that looks like a line number', !bad({ site: 'vt-pan-viewer.js:7063' }).ok);
    ok('rejects an unknown kind', !bad({ kind: 'gpu-ish' }).ok);
    ok('rejects an unknown cadence', !bad({ cadence: 'sometimes' }).ok);
    ok('rejects a non-boolean detail', !bad({ detail: 'yes' }).ok);
    ok('rejects an unknown stage', !bad({ stage: 'nonsense' }).ok);
    ok('rejects an unknown pass id', !bad({ pass: 'no.such.pass' }).ok);
    ok('rejects an unknown ownerEffectId', !bad({ ownerEffectId: 'sparkles' }).ok);
    ok('accepts ownerEffectId null', bad({ ownerEffectId: null }).ok);
    ok('accepts pass null (pre-plan / off-loop zones)', bad({ pass: null, stage: 'frame' }).ok);

    // Empty `live` sets must SKIP those checks rather than reject everything —
    // otherwise the validator is unusable anywhere the graph is not to hand.
    ok('empty live sets skip cross-checks rather than failing', validateZoneTaxonomy([good], {}).ok);

    const err = bad({ pass: 'no.such.pass' });
    ok(
      'errors name the offending zone id',
      err.errors.some((e) => e.includes(good.id))
    );
    ok(
      'errors are strings',
      err.errors.every((e) => typeof e === 'string')
    );
  }

  // ---- 8. EFFECT_ZONING stays in step with the zones -----------------------
  {
    const res = validateEffectZoning(EFFECT_ZONING, ZONES);
    ok(`EFFECT_ZONING validates against ZONES (${res.errors.join(' | ')})`, res.ok);

    ok('grade is declared unzonable', EFFECT_ZONING.grade.coverage === 'none');
    ok('vegetation is declared partial', EFFECT_ZONING.vegetation.coverage === 'partial');
    ok('water is declared partial', EFFECT_ZONING.water.coverage === 'partial');

    // Every id in EFFECT_ZONING must be a real effect.
    ok(
      'every EFFECT_ZONING key is a registered effect id',
      Object.keys(EFFECT_ZONING).every((id) => effectIds.includes(id))
    );
    // Every reason must actually read as a reason — this string is what a user
    // gets INSTEAD of a number, so a placeholder is worse than nothing.
    ok(
      'every EFFECT_ZONING reason is a real explanation',
      Object.values(EFFECT_ZONING).every((d) => d.why.length >= 40)
    );

    // And the validator itself must reject drift in both directions.
    const zonedEffect = ZONES.find((z) => z.ownerEffectId)?.ownerEffectId;
    ok(
      "rejects coverage:'none' for an effect that owns a zone",
      !validateEffectZoning({ [zonedEffect]: { coverage: 'none', why: 'x'.repeat(50) } }, ZONES).ok
    );
    ok(
      "rejects coverage:'full' for an effect that owns no zone",
      !validateEffectZoning({ grade: { coverage: 'full', why: 'x'.repeat(50) } }, ZONES).ok
    );
    ok(
      'rejects a placeholder reason',
      !validateEffectZoning({ grade: { coverage: 'none', why: 'because' } }, ZONES).ok
    );
  }

  // ---- 9. Coverage: the effects we claim to zone really are zoned ----------
  {
    const owned = new Set(ZONES.map((z) => z.ownerEffectId).filter(Boolean));
    // Every effect is either owned by >=1 zone or explained in EFFECT_ZONING.
    // This is the check that stops an effect from silently reporting nothing.
    const unexplained = effectIds.filter((id) => !owned.has(id) && !EFFECT_ZONING[id]);
    ok(
      `every effect is zoned or explained (unexplained: ${unexplained.join(', ') || 'none'})`,
      unexplained.length === 0
    );

    ok('bloom owns its whole mip chain', ZONES.filter((z) => z.ownerEffectId === 'bloom').length >= 5);
    ok(
      'specular is zoned',
      ZONES.some((z) => z.ownerEffectId === 'specular')
    );
    ok(
      'window light is zoned',
      ZONES.some((z) => z.ownerEffectId === 'window')
    );
  }

  // ---- 10. Kind/stage sanity ----------------------------------------------
  {
    ok(
      'every kind is valid',
      ZONES.every((z) => ZONE_KINDS.includes(z.kind))
    );
    ok(
      'every zone with an enclosing pass names a live pass',
      ZONES.every((z) => z.pass === null || livePassIds.includes(z.pass))
    );
    ok(
      'every stage is a real STAGES entry',
      ZONES.every((z) => STAGES.includes(z.stage))
    );
    // A gpu zone with no enclosing pass would be GPU work outside the plan —
    // real (the sims stage), so this asserts the ones we know about, not a ban.
    const gpuOutsidePlan = ZONES.filter((z) => z.pass === null && z.kind !== 'cpu');
    ok(
      'GPU work outside the pass plan is only the sims stage',
      gpuOutsidePlan.every((z) => z.stage === 'sims')
    );
  }
}
