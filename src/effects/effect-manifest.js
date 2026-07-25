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
      }
    });

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
