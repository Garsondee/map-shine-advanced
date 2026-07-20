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
 * @typedef {object} EffectManifest
 * @property {string} id - camelCase identity; the stable key in the registry + settings.
 * @property {number} visualWeight - 0..1, what to defend first under budget (Effects.md §2).
 * @property {{photosensitive: boolean}} a11y - accessibility class flags; the cascade's hard override reads these.
 * @property {string} enabledFromProfile - the lowest {@link PERFORMANCE_PROFILES} it is on at by default.
 * @property {Record<string, object>} params - the params schema (core/params-schema.js).
 * @property {Array<{n: number, name?: string, cost?: object, adds: string}>} tiers - the ladder (Effects.md §2).
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
      }
    });
  }

  return { ok: errors.length === 0, errors };
}
