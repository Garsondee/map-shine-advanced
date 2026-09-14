/**
 * Node verification for effects/lens.js — the declaration.
 *
 * Mirrors fluid.test.mjs/water.test.mjs's job: prove the manifest and schema
 * are well-formed as DATA, and pin the SHAPE so a key cannot be added without
 * someone noticing it needs a consumer (`params/no-dead-controls`).
 */
import { LENS, LENS_PARAMS, LENS_PRESETS, lensPreset } from '../lens.js';
import { validateEffectManifest } from '../effect-manifest.js';
import { validateParamsSchema } from '../../core/params-schema.js';

export function run(t) {
  const { ok } = t;

  {
    const r = validateEffectManifest(LENS);
    ok(`manifest validates (${r.errors.join('; ')})`, r.ok === true);
  }
  {
    const r = validateParamsSchema(LENS_PARAMS);
    ok('params schema validates', r.ok === true);
  }

  ok(
    'every param declares a category so the ROH card can group it',
    Object.values(LENS_PARAMS).every((p) => typeof p.category === 'string' && p.category.length > 0)
  );
  ok(
    'every param declares plain-language help (Effects-UI.md)',
    Object.values(LENS_PARAMS).every((p) => typeof p.help === 'string' && p.help.length > 30)
  );
  ok('the manifest points at that same schema object', LENS.params === LENS_PARAMS);
  ok(
    'no rung is both a built tier and a deferred one',
    !LENS.deferredRungs.some((r) => LENS.tiers.some((t2) => t2.name === r.name))
  );

  ok('id is the stable camelCase registry key', LENS.id === 'lens');
  ok('a mood tool is defended mid-weight, not first or last', LENS.visualWeight > 0.2 && LENS.visualWeight < 0.5);
  ok('on by default at every profile', LENS.enabledFromProfile === 'low');
  ok('tier 0 is declared — a manifest without one is malformed', LENS.tiers[0]?.n === 0);
  ok('tiers 0-2 are real code', LENS.tiers.length === 3);
  ok('the ladder is named in build order', LENS.tiers.map((t2) => t2.name).join() === 'optics,motion,light-burn');
  ok('no tier still claims to be unbuilt', !LENS.tiers.some((t2) => /NOT BUILT/.test(t2.adds)));
  ok(
    'cost class is non-decreasing across rungs 1..N (Law 3 — tier 0 exempt)',
    (() => {
      const order = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
      for (let i = 2; i < LENS.tiers.length; i++) {
        if (order.indexOf(LENS.tiers[i].cost.class) < order.indexOf(LENS.tiers[i - 1].cost.class)) return false;
      }
      return true;
    })()
  );

  // The overlay-catalog gap is recorded as ONE rung, not four — see
  // lens.js's own header for why the four V2 "channel" layers are a single
  // coherent content gap.
  const rungNames = LENS.deferredRungs.map((r) => r.name);
  ok('exactly one deferred rung — the overlay/grime asset library', rungNames.join() === 'overlay-catalog');
  ok(
    'every deferred rung carries a note explaining what it buys',
    LENS.deferredRungs.every((r) => typeof r.note === 'string' && r.note.length > 40)
  );

  ok('the declaration is frozen', Object.isFrozen(LENS) && Object.isFrozen(LENS_PARAMS));

  // ── Presets ────────────────────────────────────────────────────────────
  ok('LENS_PRESETS is a real (if currently empty-of-named-looks) table', typeof LENS_PRESETS === 'object');
  ok(
    'lensPreset always returns a FULL params object, even for an unknown name',
    Object.keys(lensPreset('does-not-exist')).length === Object.keys(LENS_PARAMS).length
  );
  ok(
    "lensPreset('none') is exactly the schema defaults",
    Object.entries(lensPreset('none')).every(([k, v]) => v === LENS_PARAMS[k].default)
  );
}
