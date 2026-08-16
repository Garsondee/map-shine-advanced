/**
 * EVERY SHIPPED EFFECT ANSWERS THE READINESS QUESTION — and the list of effects
 * checked here cannot quietly fall behind.
 *
 * `readiness` (effect-manifest.js) is what stops the loading curtain lifting
 * while an effect is still building itself. A validator nothing runs over the
 * real manifests would be decorative, so this suite does two separate jobs:
 *
 *   1. Run the shipped validator over every shipped manifest. Catches a
 *      malformed or missing declaration.
 *   2. **Prove the list in job 1 is complete**, derived from `perf-zones.js`
 *      rather than trusted. This is the half that matters: a hand-kept list of
 *      "effects to check" is the same shape as the hand-kept lists that have
 *      already lost six entries from `EFFECT_REAPPLIERS` and (twice) an entry
 *      from `EFFECT_ZONING`, whose own comments call the resulting silent
 *      default *"a live instance of feedback_instruments_must_not_lie, not a
 *      hypothetical"*. A new effect that owns zones but is not listed below
 *      fails HERE, rather than shipping with an unchecked manifest.
 *
 * The strongest check is the third one: an effect that owns a zone declared
 * `cadence: 'bake'` has, by the profiler's own declaration, one-time expensive
 * work — so `readiness.firstRunWork: false` is provably false for it. That is a
 * contradiction between two independent declarations, which is the only kind of
 * consistency a test can actually enforce.
 */
import { validateEffectManifest, validateReadiness } from '../effect-manifest.js';
import { ZONES } from '../../diag/perf-zones.js';

import { APERTURE_GOBO } from '../aperture-gobo.js';
import { BLOOM } from '../bloom.js';
import { CANDLE_FLAME } from '../candle-flame.js';
import { DEPTH_OF_FIELD } from '../depth-of-field.js';
import { DOOR_GRAPHICS } from '../door-graphics.js';
import { FIRE } from '../fire/fire.js';
import { FLUID } from '../fluid/fluid.js';
import { GRADE } from '../grade/grade.js';
import { LIGHTNING } from '../lightning.js';
import { SPECULAR } from '../specular/specular.js';
import { SUN_SHADOWS } from '../sun-shadows.js';
import { UI_WINDOW_SHADOW } from '../ui-window-shadow.js';
import { VEGETATION } from '../vegetation.js';
import { WATER } from '../water/water.js';
import { WINDOW } from '../window/window.js';

const MANIFESTS = [
  APERTURE_GOBO,
  BLOOM,
  CANDLE_FLAME,
  DEPTH_OF_FIELD,
  DOOR_GRAPHICS,
  FIRE,
  FLUID,
  GRADE,
  LIGHTNING,
  SPECULAR,
  SUN_SHADOWS,
  UI_WINDOW_SHADOW,
  VEGETATION,
  WATER,
  WINDOW,
];

export function run(t) {
  const { ok } = t;

  const byId = new Map(MANIFESTS.map((m) => [m?.id, m]));
  ok('every imported manifest has an id', byId.size === MANIFESTS.length && !byId.has(undefined));

  // --- 1. the shipped validator, over the shipped manifests ----------------
  for (const m of MANIFESTS) {
    const res = validateEffectManifest(m);
    ok(`${m.id}: manifest validates`, res.ok === true);
    if (!res.ok) console.error(`    ${m.id}:`, res.errors.join('\n    '));
  }

  // --- 2. the list above is complete, derived not trusted -------------------
  // Keyed on `ownerEffectId` — an effect that owns a profiler zone is an effect
  // with runtime cost, and therefore one whose readiness declaration has to be
  // checked.
  //
  // Deliberately NOT also keyed on `Object.keys(EFFECT_ZONING)`: `src/diag`
  // already asserts every EFFECT_ZONING key is a registered effect id, so
  // repeating it here would print two failures for one cause and send whoever
  // reads them looking for two bugs. One gate per fact.
  {
    const ownersWithZones = new Set(ZONES.map((z) => z.ownerEffectId).filter(Boolean));
    const missing = [...ownersWithZones].filter((id) => !byId.has(id));
    ok(
      `every effect that owns a profiler zone is checked here (missing: ${missing.join(', ') || 'none'})`,
      missing.length === 0
    );
  }

  // --- 3. THE CONTRADICTION CHECK -----------------------------------------
  // A zone declared `cadence:'bake'` IS a declaration, by the profiler, of
  // one-time expensive work. An effect owning one cannot also declare it has no
  // first-run work — that is two independent declarations disagreeing, which is
  // the only kind of inconsistency a test can actually catch.
  //
  // It checks `firstRunWork`, NOT `coverage`, and that distinction is the whole
  // reason the two fields exist: several of these effects correctly declare
  // `coverage: 'none'` because their bake is synchronous and better caught by
  // settle.js's global criteria than by a probe that would fail closed. Denying
  // the WORK is the error; declining to probe it is a judgement call the `why`
  // has to defend.
  {
    const bakeOwners = new Set(
      ZONES.filter((z) => z.cadence === 'bake' && z.ownerEffectId).map((z) => z.ownerEffectId)
    );
    ok('there are bake-cadence zones to check against (else this test proves nothing)', bakeOwners.size > 0);
    for (const id of bakeOwners) {
      const m = byId.get(id);
      if (!m) continue; // already reported by check 2
      ok(`${id}: owns a bake-cadence zone, so readiness.firstRunWork must be true`, m.readiness?.firstRunWork === true);
    }
  }

  // --- 4. probe ids are usable as registry keys ----------------------------
  {
    // Deliberately NOT "unique across manifests": vegetation names
    // `vegetationOverlaysLoading`, which is one of vt/settle.js's built-in
    // streaming counters, and two effects legitimately sharing one probe is a
    // fact about the system rather than a mistake. What must hold is that every
    // named probe is a plausible id — a typo'd one would register nothing and
    // the effect would be silently uncounted.
    for (const m of MANIFESTS) {
      for (const p of m.readiness?.probes ?? []) {
        ok(`${m.id}: probe '${p}' is a camelCase id`, /^[a-z][a-zA-Z0-9]*$/.test(p));
      }
    }
  }

  // --- 5. the validator itself --------------------------------------------
  {
    const why = 'x'.repeat(30);
    ok('a missing readiness block is an error', validateReadiness(undefined).length === 1);
    ok(
      'a missing firstRunWork is an error',
      validateReadiness({ coverage: 'none', why }).some((e) => /firstRunWork/.test(e))
    );
    ok(
      "coverage:'none' with probes is a contradiction, not a harmless extra",
      validateReadiness({ firstRunWork: true, coverage: 'none', why, probes: ['a'] }).some((e) => /probe/.test(e))
    );
    ok(
      "coverage:'full' with no probes is a claim with no receipt",
      validateReadiness({ firstRunWork: true, coverage: 'full', why, probes: [] }).some((e) => /at least one/.test(e))
    );
    ok(
      'no first-run work but non-none coverage is a contradiction',
      validateReadiness({ firstRunWork: false, coverage: 'full', why, probes: ['a'] }).some((e) =>
        /nothing to cover/.test(e)
      )
    );
    ok(
      'a one-word why is rejected — the field exists to be read at 3am',
      validateReadiness({ firstRunWork: false, coverage: 'none', why: 'none' }).some((e) => /why/.test(e))
    );
    ok(
      'an unknown coverage value is rejected',
      validateReadiness({ firstRunWork: true, coverage: 'mostly', why }).some((e) => /coverage/.test(e))
    );
    ok(
      'a well-formed "no work at all" block passes',
      validateReadiness({ firstRunWork: false, coverage: 'none', why }).length === 0
    );
    ok(
      'a well-formed "real work, covered globally" block passes',
      validateReadiness({ firstRunWork: true, coverage: 'none', why }).length === 0
    );
    ok(
      'a well-formed probed block passes',
      validateReadiness({ firstRunWork: true, coverage: 'full', why, probes: ['someBake'] }).length === 0
    );
    ok(
      'a duplicate probe id is rejected',
      validateReadiness({ firstRunWork: true, coverage: 'full', why, probes: ['a1', 'a1'] }).some((e) =>
        /twice/.test(e)
      )
    );
  }
}
