/**
 * vegetation.test.mjs — the declaration is a valid, registrable effect, and
 * VEGETATION_KINDS is internally consistent (mirrors candle-flame.test.mjs's
 * own shape).
 */
import { validateParamsSchema } from '../../core/params-schema.js';
import { validateEffectManifest } from '../effect-manifest.js';
import { createEffectRegistry } from '../registry.js';
import { resolveEffectEnabled } from '../effect-cascade.js';
import { VEGETATION, VEGETATION_PARAMS, VEGETATION_KINDS } from '../vegetation.js';
import { validateVegetationKinds } from '../vegetation-render.js';

export function run(t) {
  const { ok, throws } = t;

  // --- the declaration validates ------------------------------------------
  ok('VEGETATION_PARAMS is a valid params schema', validateParamsSchema(VEGETATION_PARAMS).ok);
  ok('VEGETATION is a valid manifest', validateEffectManifest(VEGETATION).ok);
  ok('the effect id is vegetation', VEGETATION.id === 'vegetation');
  ok('vegetation does not flash (a11y photosensitive false)', VEGETATION.a11y.photosensitive === false);

  // --- default ON, same posture as the candle ------------------------------
  ok('gated to low → on even at Low', VEGETATION.enabledFromProfile === 'low');
  ok('resolves ON at Low by default', resolveEffectEnabled(VEGETATION, { profile: 'low' }) === true);
  ok(
    'a player can still turn it OFF (final say)',
    resolveEffectEnabled(VEGETATION, { profile: 'low', playerEnable: 'off' }) === false
  );

  // --- THE TIER LADDER (2026-07-29) — one rung per performance profile ----
  // The resolver/plan arithmetic itself is exercised in effect-tier.test.mjs's
  // own anti-drift block; pinned here is just the manifest's own SHAPE, the
  // same way this file already pins "exactly two kinds" below.
  ok(
    'the ladder has exactly 6 rungs — the floor plus one per PERFORMANCE_PROFILES entry',
    VEGETATION.tiers.length === 6
  );
  ok('rung 0 is the unconditional floor (no fromProfile declared)', !('fromProfile' in VEGETATION.tiers[0]));
  ok(
    'every rung 1..5 names the performance profile that buys it, in ascending order',
    VEGETATION.tiers
      .slice(1)
      .map((t) => t.fromProfile)
      .join(',') === 'low,performance,standard,quality,extreme'
  );

  // --- ONE shared param set, TWO kinds — the whole design's central claim -
  ok('exactly two kinds declared (tree, bush)', VEGETATION_KINDS.length === 2);
  // The load-bearing claim is NOT a fixed param count (that legitimately grows
  // as rungs land) — it is that BOTH KINDS SHARE ONE PARAM SET, with every
  // per-kind difference living in the kinds table as data. That is what V2
  // failed: two near-identical 2,400-line files, ~50 sliders EACH.
  //
  // ⚠️ NAMED, DOCUMENTED EXCEPTION (2026-08-06): `treeHeightFt`/`bushHeightFt`
  // are genuinely independent per-kind LIVE params, not code-level constants
  // — the author wants to dial tree and bush height separately (a 25ft tree
  // beside a 2ft bush), which a single shared dial structurally cannot
  // express. This mirrors the render-order exception `vegetation.js`'s own
  // "HOW A KIND SORTS" section already documents (author, 2026-08-01:
  // "vegetation is a good exception so let's make an exception for it") —
  // vegetation earns a SECOND, narrowly-scoped exception here for the same
  // underlying reason: a canopy's real-world properties (sort height,
  // physical height) are NOT V2-style decorative tuning, they are honest
  // per-kind physical facts. The broader rule still holds for everything
  // else — this assertion now checks "every OTHER param", not "every param".
  const KNOWN_PER_KIND_PARAMS = new Set(['treeHeightFt', 'bushHeightFt']);
  ok(
    'both kinds share ONE param set, except the two NAMED per-kind height params',
    Object.keys(VEGETATION_PARAMS).every(
      (k) => KNOWN_PER_KIND_PARAMS.has(k) || (!k.startsWith('tree') && !k.startsWith('bush'))
    )
  );
  ok(
    'the per-kind exception is EXACTLY these two keys, never silently grown',
    Object.keys(VEGETATION_PARAMS).filter((k) => k.startsWith('tree') || k.startsWith('bush')).length ===
      KNOWN_PER_KIND_PARAMS.size
  );
  ok(
    "tree/bush height default to the author's own worked example — tall enough to clear a single story, " +
      'short enough to stay under a two-story building; a bush low enough only a genuinely low light reaches it',
    VEGETATION_PARAMS.treeHeightFt.default === 25 &&
      VEGETATION_PARAMS.bushHeightFt.default === 2 &&
      VEGETATION_PARAMS.treeHeightFt.category === 'Extent' &&
      VEGETATION_PARAMS.bushHeightFt.category === 'Extent'
  );
  ok(
    // Raised 2026-07-23 (same day) after the author's own follow-up asked for
    // the opposite: "I need controls over frequency, evolution rate,
    // amplitude and things like that, the more controls the better." The
    // ceiling still exists — it guards against genuine V2-style bloat (~50
    // sliders PER KIND, two near-identical files) — but the load-bearing
    // claim was never a specific count; it is the structural assertion just
    // above (ONE shared set, zero per-kind params).
    "the param set stays well short of V2's scale (it had ~50 PER KIND, in TWO files)",
    Object.keys(VEGETATION_PARAMS).length <= 24
  );
  // SHADOW: exactly ONE knob, per the author's explicit brief. Offset,
  // softness, direction, elongation, cloud and night are all DERIVED
  // (effects/shadow-access.js) — a second shadow slider here would be the
  // regression this asserts against.
  ok(
    'shadow exposes exactly ONE param (strength) — offset/softness are derived, never sliders',
    Object.keys(VEGETATION_PARAMS).filter((k) => k.toLowerCase().includes('shadow')).length === 1 &&
      'shadowStrength' in VEGETATION_PARAMS
  );
  ok(
    "a tree sways further than a bush at the same wind strength (V2's own default relationship)",
    VEGETATION_KINDS.find((k) => k.id === 'tree').swayMultiplier >
      VEGETATION_KINDS.find((k) => k.id === 'bush').swayMultiplier
  );
  // The shadow brief's own core claim, as data: ONE physical height per kind,
  // from which both throw and softness derive.
  {
    const tree = VEGETATION_KINDS.find((k) => k.id === 'tree');
    const bush = VEGETATION_KINDS.find((k) => k.id === 'bush');
    ok(
      'a tree is declared TALLER than a bush (drives both its longer AND softer shadow)',
      tree.shadowHeightPx > bush.shadowHeightPx
    );
    ok(
      'every kind declares a positive height and a flutter scale',
      VEGETATION_KINDS.every((k) => k.shadowHeightPx > 0 && k.flutterSpaceFreq > 0)
    );
    ok(
      "a bush's leaves flutter at a FINER scale than a tree canopy's masses",
      bush.flutterSpaceFreq > tree.flutterSpaceFreq
    );
    // A leftover from the old clamped-fraction sort model (superseded
    // 2026-08-06 by the real, unbounded treeHeightFt/bushHeightFt params
    // above) would be a silent regression back to a floor-relative fraction
    // — this is a RED TEST if that field is ever reintroduced by accident.
    ok(
      'no kind carries the old passiveElevationFraction field',
      VEGETATION_KINDS.every((k) => !('passiveElevationFraction' in k))
    );
  }

  // --- the kinds table resolves against the REAL catalog -------------------
  {
    const v = validateVegetationKinds();
    ok(`VEGETATION_KINDS validates against scene/mask-catalog.js (${v.errors.join('; ')})`, v.ok);
  }
  {
    // A THIRD kind whose maskKindId doesn't exist — the exact mistake
    // validateVegetationKinds exists to catch before it becomes a silent
    // "this kind never detects anything" bug in play.
    const broken = [...VEGETATION_KINDS, { id: 'vine', maskKindId: 'vine', swayMultiplier: 1, renderOrderNudge: 0 }];
    const v = validateVegetationKinds(broken);
    ok('an undeclared maskKindId fails validation', !v.ok && v.errors.some((e) => e.includes('vine')));
  }
  {
    // Two kinds racing for the same suffix — detectSelfVegetationKind could
    // only ever return one of them, so this must be caught as a real error,
    // not silently resolved by table order.
    const clashing = [
      { id: 'tree', maskKindId: 'tree', swayMultiplier: 1, renderOrderNudge: 0 },
      { id: 'tree2', maskKindId: 'tree', swayMultiplier: 1, renderOrderNudge: 0 },
    ];
    const v = validateVegetationKinds(clashing);
    ok('two kinds sharing a suffix fails validation (detection would be ambiguous)', !v.ok);
  }

  // --- it flows through the ONE door (the velocity test in miniature) -----
  {
    const reg = createEffectRegistry();
    let applied = null;
    const id = reg.register(VEGETATION, (r) => {
      applied = r;
    });
    ok('register returns the vegetation id', id === 'vegetation');
    const resolved = reg.resolveAndApply('vegetation', { profile: 'standard' });
    ok('resolveAndApply drives vegetation apply', applied !== null && applied.enabled === true);
    ok(
      'the resolved params carry the look defaults',
      // swayAmount 14 → 34 (2026-08-01): the motion budget was rebalanced out
      // of the per-pixel flutter warp (which was folding the art) and into bulk
      // sway, on the author's own "a lot more sway" instruction.
      resolved.params.windResponse === 1 && resolved.params.swayAmount === 34 && resolved.params.intensity === 1.0
    );
    throws(
      'a duplicate vegetation registration throws',
      () => reg.register(VEGETATION, () => {}),
      'already registered'
    );
  }
}
