/**
 * Node verification for effects/prism/prism.js — the declaration.
 *
 * Mirrors lens.test.mjs's/fluid.test.mjs's job: prove the manifest and
 * schema are well-formed as DATA, and pin the SHAPE so a key cannot be added
 * without someone noticing it needs a consumer (`params/no-dead-controls`).
 */
import { PRISM, PRISM_PARAMS, PRISM_PRESETS, prismPreset } from '../prism.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { validateParamsSchema } from '../../../core/params-schema.js';
import { resolveEffectEnabled } from '../../effect-cascade.js';
import { MASK_KINDS } from '../../../scene/mask-catalog.js';

export function run(t) {
  const { ok } = t;

  {
    const r = validateEffectManifest(PRISM);
    ok(`manifest validates (${r.errors.join('; ')})`, r.ok === true);
  }
  {
    const r = validateParamsSchema(PRISM_PARAMS);
    ok('params schema validates', r.ok === true);
  }

  ok(
    'every param declares a category so the ROH card can group it',
    Object.values(PRISM_PARAMS).every((p) => typeof p.category === 'string' && p.category.length > 0)
  );
  ok(
    'every param declares plain-language help (Effects-UI.md)',
    Object.values(PRISM_PARAMS).every((p) => typeof p.help === 'string' && p.help.length > 30)
  );
  ok('the manifest points at that same schema object', PRISM.params === PRISM_PARAMS);
  ok(
    'no rung is both a built tier and a deferred one',
    !PRISM.deferredRungs.some((r) => PRISM.tiers.some((t2) => t2.name === r.name))
  );

  ok('id is the stable camelCase registry key', PRISM.id === 'prism');
  ok(
    'a narrow, per-item surface finish is defended mid-weight, not first or last',
    PRISM.visualWeight > 0.15 && PRISM.visualWeight < 0.5
  );
  ok(
    'off by default at every profile short of extreme — a real live pass now exists, but nobody has watched it run yet',
    PRISM.enabledFromProfile === 'extreme'
  );
  ok('resolves OFF at standard, the default profile', resolveEffectEnabled(PRISM, { profile: 'standard' }) === false);
  ok(
    'resolves OFF at quality too — extreme is the floor',
    resolveEffectEnabled(PRISM, { profile: 'quality' }) === false
  );
  ok('resolves ON at extreme, the ceiling', resolveEffectEnabled(PRISM, { profile: 'extreme' }) === true);
  ok(
    'a GM can still opt a scene in at any profile (the Studio effect switch)',
    resolveEffectEnabled(PRISM, { profile: 'standard', gmEnable: 'on' }) === true
  );

  ok('tier 0 is declared — a manifest without one is malformed', PRISM.tiers[0]?.n === 0);
  ok('tiers 0-3 are real, Node-tested code', PRISM.tiers.length === 4);
  ok('the ladder is named in build order', PRISM.tiers.map((t2) => t2.name).join() === 'glass,facets,glint,dispersion');
  ok('no tier still claims to be unbuilt', !PRISM.tiers.some((t2) => /NOT BUILT/.test(t2.adds)));
  ok(
    'cost class is non-decreasing across rungs 1..N (Law 3 — tier 0 exempt)',
    (() => {
      const order = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
      for (let i = 2; i < PRISM.tiers.length; i++) {
        if (order.indexOf(PRISM.tiers[i].cost.class) < order.indexOf(PRISM.tiers[i - 1].cost.class)) return false;
      }
      return true;
    })()
  );
  ok(
    'the priciest rung (real scene-capture dispersion) is the first dependent read, C5 — matching water`s own tier 5',
    PRISM.tiers[3].cost.class === 'C5'
  );
  ok('nothing left deferred — every V2 rung is a real, built tier above', PRISM.deferredRungs.length === 0);

  // ── Authoring — the ＋ button (`effects/effect-manifest.js#validateAuthoring`) ──
  ok('authoring names the `prism` mask kind', PRISM.authoring?.paint === 'prism');
  ok(
    'the `prism` mask kind this manifest paints actually exists in the catalog',
    MASK_KINDS.some((k) => k.id === 'prism')
  );

  ok('the declaration is frozen', Object.isFrozen(PRISM) && Object.isFrozen(PRISM_PARAMS));

  // ── Presets ────────────────────────────────────────────────────────────
  ok('PRISM_PRESETS is a real (if currently empty-of-named-looks) table', typeof PRISM_PRESETS === 'object');
  ok(
    'prismPreset always returns a FULL params object, even for an unknown name',
    Object.keys(prismPreset('does-not-exist')).length === Object.keys(PRISM_PARAMS).length
  );
  ok(
    "prismPreset('none') is exactly the schema defaults",
    Object.entries(prismPreset('none')).every(([k, v]) => v === PRISM_PARAMS[k].default)
  );

  // ── The one genuinely NEW knob beyond V2's own params, called out honestly ──
  ok(
    'maskTintStrength defaults to 0 — an ordinary black-and-white mask tints nothing, matching V2 exactly',
    PRISM_PARAMS.maskTintStrength.default === 0
  );
}
