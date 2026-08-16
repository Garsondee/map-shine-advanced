/**
 * THE EFFECT MANIFEST CONTRACT — an effect declared as DATA, validated in Node.
 *
 * An effect is a declaration, not an object that gets wired up (Effects-API.md
 * §5). This validator is the checkable half: a malformed manifest is a RED
 * TEST, months before a governor or a settings dialog exists to trip over it —
 * exactly as `validatePassGraph`/`validateMaskCatalog`/`validateParamsSchema`
 * already do for their own declarations. Pure; no THREE, no Foundry.
 *
 * The manifest carries only what the registry, the settings cascade and the
 * (future) governor need, and NOTHING an effect could special-case itself with:
 * there is no `apply`, no field name, no `if (id === …)` hook — per-effect
 * behaviour is these DATA fields (`enabledFromProfile`, `a11y`, `tiers`) and the
 * params schema, never code (docs/planning/Effect-Registration.md §6, the
 * `resolve-effect-enabled` corpse).
 *
 * @module effects/effect-manifest
 */

import { validateParamsSchema } from '../core/params-schema.js';
import { PERFORMANCE_PROFILES } from './effect-cascade.js';

/**
 * Cost-class order, cheapest to most expensive (`Effects.md` Law 3, §1 table):
 * C0 constant · C1 ALU · C2 resident read · C3 graph read · C4 VT read ·
 * C5 dependent read · C6 extra RT · C7 per-frame sim · C8 geometry.
 */
const COST_CLASS_ORDER = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];

/**
 * @typedef {object} EffectManifest
 * @property {string} id - camelCase identity; the stable key in the registry + settings.
 * @property {number} visualWeight - 0..1, what to defend first under budget (Effects.md §2).
 * @property {{photosensitive: boolean}} a11y - accessibility class flags; the cascade's hard override reads these.
 * @property {string} enabledFromProfile - the lowest {@link PERFORMANCE_PROFILES} it is on at by default.
 * @property {Record<string, object>} params - the params schema (core/params-schema.js).
 * @property {Array<{n: number, name?: string, cost: {class: string, estMsPerMp?: number}, adds: string}>} tiers - the ladder (Effects.md §2). `cost.class` is required and, for rungs 1..N, must be non-decreasing (Law 3) — tier 0 is exempt (the admission price, not a ladder step).
 * @property {Array<{name: string, note?: string}>} [deferredRungs] - recorded future rungs, not built (Effects.md §0).
 */

/**
 * HOW YOU PUT THIS EFFECT ON THE MAP — the declaration behind the ＋ button in
 * every effect card's header (2026-07-27, author: "there should be a prominent ＋
 * button… the idea being that we make it easy to see how you might add each
 * effect and give it a prominent and reliable place").
 *
 * `{ paint }` is one `scene/mask-catalog.js` kind id, or an array of them for an
 * effect painted through more than one mask (vegetation's tree/bush pair). Absent
 * means the effect has no ＋ at all, which is the RIGHT answer for a whole-image
 * post effect — there is nowhere on the map to put bloom. Sun shadows has none
 * either: it derives its casters from walls and buildings, and the `shadow` mask
 * belongs to the lighting pass, not to it.
 *
 * ⚠️ PLACEMENT IS NOT DECLARED HERE, DELIBERATELY. `scene/anchor-catalog.js`'s
 * `ANCHOR_KINDS` already carry `effectId` and already have an `anchorsForEffect`
 * lookup — a second declaration saying the same thing is a second thing to drift.
 * Painting needs one because masks are SHARED (the `window` mask feeds both window
 * light and structural shadows), so "which mask does this effect's ＋ paint" is a
 * fact about the effect, not about the mask.
 *
 * Shape only — that `paint` names a mask kind which actually EXISTS and is
 * actually paintable is checked by a Node test against MASK_KINDS, not here:
 * importing the mask catalog from `effects/` would add an import edge for one
 * lookup. A ghost reference fails the build either way.
 *
 * @param {{paint?: string|string[]}} [a]
 * @returns {string[]} problems, empty when fine (an absent block is fine).
 */
export function validateAuthoring(a) {
  if (a === undefined || a === null) return [];
  const errors = [];
  if (typeof a !== 'object' || Array.isArray(a)) return ['authoring must be an object when present'];
  if ('paint' in a) {
    const list = Array.isArray(a.paint) ? a.paint : [a.paint];
    if (list.length === 0) errors.push('authoring.paint must name at least one mask kind when present');
    for (const k of list) {
      if (typeof k !== 'string' || k.length === 0) {
        errors.push(`authoring.paint entry ${JSON.stringify(k)} must be a non-empty mask-kind id`);
      }
    }
  }
  return errors;
}

/** The three honest answers to "does this effect have first-run work?". */
const READINESS_COVERAGE = ['full', 'partial', 'none'];

/**
 * DOES THIS EFFECT HAVE WORK THE LOADING SCREEN MUST WAIT FOR — required, 2026-08-15.
 *
 * ## Why this is REQUIRED and lives here, rather than being an optional side table
 *
 * `EFFECT_ZONING` (diag/perf-zones.js) already tried the optional-side-table
 * shape for the neighbouring question ("is this effect's cost instrumented?"),
 * and its own comments record the result twice over: `window` and `fire` owned
 * real zones with no entry at all and *"silently defaulted to
 * zoneCoverage:'full'"* — its comment calls that *"a live instance of
 * feedback_instruments_must_not_lie, not a hypothetical"* — and `specular` had
 * gone the same way months earlier. A check that only fires when someone
 * remembers to add a row cannot catch the person who forgot the row.
 *
 * So this is a required field on the manifest, validated by the same call that
 * already refuses a manifest with no `a11y` flag. A new effect cannot be
 * declared without answering the question, and answering it wrong is a red test
 * rather than a scene that reports "Ready" while the effect is still baking.
 *
 * ## Two questions, deliberately not one field
 *
 * `firstRunWork` — does this effect do ANY lazy one-time work at all?
 * `coverage` — how much of that work a named PROBE counts.
 *
 * The first draft collapsed these into one field and it was wrong within the
 * hour. Several effects (fire's particle engines, lightning's material, the
 * sun-shadow smear, fluid's tube net) do real, expensive first-run work that is
 * nonetheless a bad fit for a probe: it runs SYNCHRONOUSLY inside a frame, so
 * there is no in-flight window to observe, and the flag that would express it
 * — "has it built yet?" — is a gate that fails CLOSED on a scene which simply
 * contains no fire, holding readiness open forever
 * ([[feedback_gate_polarity_must_fail_open]]). Those are covered instead by
 * settle.js's global criteria, which catch exactly the two things a
 * synchronous bake produces: a bigger pipeline set and one long frame.
 *
 * With one field, saying that honestly required writing `coverage: 'none'`,
 * which read as "this effect has no first-run work" — a denial of the very
 * thing the note went on to describe. Two fields let both answers be true.
 *
 * - `firstRunWork: false` — genuinely nothing lazy: no target, no bake, no
 *   asset, no material built on first draw. `why` has to make that case,
 *   because it is the answer that costs nothing to write and is wrong most of
 *   the time. Forces `coverage: 'none'`.
 * - `coverage: 'full'` — every piece of first-run work is counted by the named
 *   probes; the curtain will wait for all of it.
 * - `coverage: 'partial'` — some is; `why` must say what is not, and why not.
 * - `coverage: 'none'` with `firstRunWork: true` — the work is real and is
 *   covered globally rather than per-effect. `why` must say which global
 *   criterion catches it.
 *
 * `probes` are `vt/settle.js` probe ids — the same strings the subsystem passes
 * to `registerReadinessProbe`. Shape only is checked here: that a named probe is
 * actually registered at runtime is a different kind of claim, checked by the
 * live registry (which throws on a duplicate) and reported as a declared-but-
 * never-registered probe in the perf report rather than being asserted in Node
 * against a registry that does not exist yet.
 *
 * @param {{coverage?: string, why?: string, probes?: string[]}} [r]
 * @returns {string[]} problems, empty when fine.
 */
export function validateReadiness(r) {
  if (r === undefined || r === null) {
    return [
      'readiness is required — declare { firstRunWork, coverage, why, probes } saying whether this effect has ' +
        'first-run work (a lazy render target, a bake, a mask load, a material built on first draw) and how much ' +
        'of it is counted. An effect with uncounted first-run work is the scene reporting "Ready" while it is ' +
        'still building itself (vt/settle.js).',
    ];
  }
  const errors = [];
  if (typeof r !== 'object' || Array.isArray(r)) return ['readiness must be an object'];

  if (typeof r.firstRunWork !== 'boolean') {
    errors.push(
      'readiness.firstRunWork must be a boolean: does this effect do ANY lazy one-time work (target, bake, ' +
        'asset load, material built on first draw)? It is deliberately separate from `coverage`, which says how ' +
        'much of that work a PROBE counts — plenty of real first-run work is genuinely better covered by ' +
        "settle.js's global pipeline-growth and frame-steadiness criteria than by a per-effect probe, and " +
        'collapsing the two questions into one field made an honest answer to the second look like a denial ' +
        'of the first.'
    );
  }
  if (!READINESS_COVERAGE.includes(r.coverage)) {
    errors.push(`readiness.coverage ${JSON.stringify(r.coverage)} must be one of: ${READINESS_COVERAGE.join(', ')}`);
  }
  if (typeof r.why !== 'string' || r.why.length < 20) {
    errors.push(
      'readiness.why must be a real sentence saying what first-run work this effect does (or making the case ' +
        'that it does none) — the field exists to be read by whoever is staring at a load that will not finish.'
    );
  }

  const probes = r.probes;
  if (r.firstRunWork === false && r.coverage !== 'none') {
    errors.push(
      `readiness declares no first-run work but coverage ${JSON.stringify(r.coverage)} — there is nothing to ` +
        'cover. Fix whichever half is wrong.'
    );
  }
  if (r.coverage === 'none') {
    // A probe list under `coverage:'none'` is a contradiction, not a harmless
    // extra: one of the two is wrong and there is no way to tell which.
    if (Array.isArray(probes) && probes.length > 0) {
      errors.push(
        `readiness.coverage is 'none' but ${probes.length} probe(s) are named — coverage 'none' means no probe ` +
          'counts this effect. Fix whichever half is wrong.'
      );
    }
  } else if (!Array.isArray(probes) || probes.length === 0) {
    errors.push(
      `readiness.coverage is ${JSON.stringify(r.coverage)}, so readiness.probes must name at least one ` +
        'vt/settle.js probe id. Coverage that names nothing is a claim with no receipt.'
    );
  } else {
    const seen = new Set();
    for (const p of probes) {
      if (typeof p !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(p)) {
        errors.push(`readiness.probes entry ${JSON.stringify(p)} must be a camelCase probe id`);
      } else if (seen.has(p)) {
        errors.push(`readiness.probes names '${p}' twice`);
      } else {
        seen.add(p);
      }
    }
  }
  return errors;
}

/**
 * Validate an effect manifest as data. Returns every problem at once (like the
 * sibling validators) so a bad declaration is fixed in one pass, not N.
 *
 * @param {EffectManifest} m
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateEffectManifest(m) {
  const errors = [];
  const fail = (s) => errors.push(s);

  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, errors: ['manifest must be an object'] };
  }

  if (!/^[a-z][a-zA-Z0-9]*$/.test(m.id ?? '')) {
    fail(`id '${m.id}' must be camelCase (it is the stable key in the registry + settings)`);
  }

  if (!m.a11y || typeof m.a11y !== 'object' || typeof m.a11y.photosensitive !== 'boolean') {
    fail(
      'a11y must declare { photosensitive: boolean } — the accessibility gate (effect-cascade.js) reads it to ' +
        'force-disable flashing effects for a player who asked, and a missing flag would silently opt an effect ' +
        'out of that protection (Effect-Registration.md §2).'
    );
  }

  if (!PERFORMANCE_PROFILES.includes(m.enabledFromProfile)) {
    fail(`enabledFromProfile '${m.enabledFromProfile}' must be one of: ${PERFORMANCE_PROFILES.join(', ')}`);
  }

  if (!(Number.isFinite(m.visualWeight) && m.visualWeight >= 0 && m.visualWeight <= 1)) {
    fail(`visualWeight must be a number in [0,1] (got ${JSON.stringify(m.visualWeight)})`);
  }

  const ps = validateParamsSchema(m.params);
  if (!ps.ok) for (const e of ps.errors) fail(`params.${e}`);

  for (const e of validateAuthoring(m.authoring)) fail(e);

  for (const e of validateReadiness(m.readiness)) fail(e);

  if (!Array.isArray(m.tiers) || m.tiers.length === 0) {
    fail('tiers must be a non-empty array (tier 0 is the coarse pin — Effects.md §1)');
  } else {
    m.tiers.forEach((t, i) => {
      if (!t || typeof t !== 'object') fail(`tiers[${i}] must be an object`);
      else {
        if (t.n !== i) fail(`tiers[${i}].n is ${JSON.stringify(t.n)} — must equal ${i} (contiguous from 0)`);
        if (typeof t.adds !== 'string' || t.adds.length === 0) {
          fail(`tiers[${i}] needs a one-line 'adds' (what this rung buys — Effects.md §2)`);
        }
        if (!COST_CLASS_ORDER.includes(t.cost?.class)) {
          fail(
            `tiers[${i}].cost.class is ${JSON.stringify(t.cost?.class)} — must be one of: ` +
              `${COST_CLASS_ORDER.join(', ')} (Effects.md §1's cost-class table, §2: required per rung)`
          );
        }
        // WHEN DOES THIS RUNG GET BOUGHT — required on rungs 1..N, and the
        // reason it is required rather than defaulted is that a ladder nothing
        // reads is exactly how these ladders rotted in the first place
        // (effect-cascade.js#resolveEffectTier's header). Rung 0 is the
        // admission price and is bought unconditionally, so declaring a profile
        // on it would be a promise the resolver deliberately ignores.
        if (i === 0) {
          if ('fromProfile' in t) {
            fail(
              `tiers[0].fromProfile is declared, but tier 0 is UNCONDITIONAL (Effects.md §6 step 2 / Law 1) — ` +
                'the resolver ignores it, so declaring one is a promise that will not be kept. Remove it.'
            );
          }
        } else if (!PERFORMANCE_PROFILES.includes(t.fromProfile)) {
          fail(
            `tiers[${i}].fromProfile is ${JSON.stringify(t.fromProfile)} — must be one of: ` +
              `${PERFORMANCE_PROFILES.join(', ')}. Every rung above 0 must say the lowest performance ` +
              'profile that buys it, or the profile selector cannot reach it (effect-cascade.js#resolveEffectTier).'
          );
        }
      }
    });

    // PROFILE MONOTONICITY — a rung may not be bought at a LOWER profile than
    // the rung beneath it. Rungs are cumulative (a rung may not depend on one
    // above it, Effects.md §2), so the resolver takes the highest CONTIGUOUS
    // affordable rung; a ladder that dips would leave a rung permanently
    // unreachable — declared, paid for in code, and never once selected. That is
    // the silent-rot failure this whole check exists to make loud.
    for (let i = 2; i < m.tiers.length; i++) {
      const prev = m.tiers[i - 1]?.fromProfile;
      const cur = m.tiers[i]?.fromProfile;
      const prevRank = PERFORMANCE_PROFILES.indexOf(prev);
      const curRank = PERFORMANCE_PROFILES.indexOf(cur);
      if (prevRank === -1 || curRank === -1) continue; // already reported above
      if (curRank < prevRank) {
        fail(
          `tiers[${i}].fromProfile '${cur}' is a LOWER profile than tiers[${i - 1}]'s '${prev}' — rungs are ` +
            'cumulative, so the resolver stops at the first unaffordable rung and this one could never be ' +
            'reached. Raise it to at least the rung below.'
        );
      }
    }

    // COST-CLASS MONOTONICITY (Effects.md Law 3: "a tier may only introduce a
    // cost class >= the tiers below it") — governs rungs 1..N ONLY. Tier 0 is
    // EXEMPT: it is the effect's admission price (placing the effect
    // correctly), not a step in the monotonic ladder, so the chain starts
    // being checked at the tier-1-to-tier-2 transition, never tier-0-to-
    // tier-1. Water's own ladder is why this exemption exists as data, not
    // just prose: tier 0 is C4 (a VT read, to place the mask) and tier 1 is
    // C1 (pure ALU) — cheaper than tier 0, and correctly so, since tier 1 is
    // the first REAL rung of the ladder, tier 0 is off to the side.
    for (let i = 2; i < m.tiers.length; i++) {
      const prevClass = m.tiers[i - 1]?.cost?.class;
      const curClass = m.tiers[i]?.cost?.class;
      const prevRank = COST_CLASS_ORDER.indexOf(prevClass);
      const curRank = COST_CLASS_ORDER.indexOf(curClass);
      // Already reported by the per-tier check above — do not double-report
      // an unparseable class as ALSO a monotonicity violation.
      if (prevRank === -1 || curRank === -1) continue;
      if (curRank < prevRank) {
        fail(
          `tiers[${i}].cost.class '${curClass}' is CHEAPER than tiers[${i - 1}]'s '${prevClass}' — ` +
            'Effects.md Law 3: a rung may only introduce a cost class >= the rung below it. Tier 0 is ' +
            'exempt from this chain (it is the admission price, not part of the ladder) — this check ' +
            'governs rungs 1..N.'
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
