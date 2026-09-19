/**
 * Node verification for effects/iridescence/iridescence.js — the declaration.
 *
 * Mirrors prism.test.mjs's job: prove the manifest and schema are well-formed
 * as DATA, and pin the SHAPE so a key cannot be added without someone
 * noticing it needs a consumer (`params/no-dead-controls`).
 */
import { IRIDESCENCE, IRIDESCENCE_PARAMS, IRIDESCENCE_PRESETS, iridescencePreset } from '../iridescence.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { validateParamsSchema } from '../../../core/params-schema.js';
import { resolveEffectEnabled } from '../../effect-cascade.js';
import { MASK_KINDS } from '../../../scene/mask-catalog.js';

export function run(t) {
  const { ok } = t;

  {
    const r = validateEffectManifest(IRIDESCENCE);
    ok(`manifest validates (${r.errors.join('; ')})`, r.ok === true);
  }
  {
    const r = validateParamsSchema(IRIDESCENCE_PARAMS);
    ok('params schema validates', r.ok === true);
  }

  ok(
    'every param declares a category so the ROH card can group it',
    Object.values(IRIDESCENCE_PARAMS).every((p) => typeof p.category === 'string' && p.category.length > 0)
  );
  ok(
    'every param declares plain-language help (Effects-UI.md)',
    Object.values(IRIDESCENCE_PARAMS).every((p) => typeof p.help === 'string' && p.help.length > 30)
  );
  ok('the manifest points at that same schema object', IRIDESCENCE.params === IRIDESCENCE_PARAMS);
  ok(
    'no rung is both a built tier and a deferred one',
    !IRIDESCENCE.deferredRungs.some((r) => IRIDESCENCE.tiers.some((t2) => t2.name === r.name))
  );

  ok('id is the stable camelCase registry key', IRIDESCENCE.id === 'iridescence');
  ok(
    'a narrow, per-item surface finish is defended mid-weight, not first or last',
    IRIDESCENCE.visualWeight > 0.15 && IRIDESCENCE.visualWeight < 0.5
  );
  ok(
    'off by default at every profile short of extreme — a real live pass now exists, but nobody has watched it run yet',
    IRIDESCENCE.enabledFromProfile === 'extreme'
  );
  ok(
    'resolves OFF at standard, the default profile',
    resolveEffectEnabled(IRIDESCENCE, { profile: 'standard' }) === false
  );
  ok(
    'resolves OFF at quality too — extreme is the floor',
    resolveEffectEnabled(IRIDESCENCE, { profile: 'quality' }) === false
  );
  ok('resolves ON at extreme, the ceiling', resolveEffectEnabled(IRIDESCENCE, { profile: 'extreme' }) === true);
  ok(
    'a GM can still opt a scene in at any profile (the Studio effect switch)',
    resolveEffectEnabled(IRIDESCENCE, { profile: 'standard', gmEnable: 'on' }) === true
  );

  ok('tier 0 is declared — a manifest without one is malformed', IRIDESCENCE.tiers[0]?.n === 0);
  ok('tiers 0-2 are real, Node-tested code', IRIDESCENCE.tiers.length === 3);
  ok('the ladder is named in build order', IRIDESCENCE.tiers.map((t2) => t2.name).join() === 'sheen,flow,spectral');
  ok('no tier still claims to be unbuilt', !IRIDESCENCE.tiers.some((t2) => /NOT BUILT/.test(t2.adds)));
  ok(
    'cost class is non-decreasing across rungs 1..N (Law 3 — tier 0 exempt)',
    (() => {
      const order = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
      for (let i = 2; i < IRIDESCENCE.tiers.length; i++) {
        if (order.indexOf(IRIDESCENCE.tiers[i].cost.class) < order.indexOf(IRIDESCENCE.tiers[i - 1].cost.class)) {
          return false;
        }
      }
      return true;
    })()
  );
  ok(
    'the priciest rung (real light reactivity off buf:scene.illum) is one extra texture read, C3 — matching specular`s own islands/sunAndSky rungs',
    IRIDESCENCE.tiers[2].cost.class === 'C3'
  );
  ok('nothing left deferred — every V2 rung is a real, built tier above', IRIDESCENCE.deferredRungs.length === 0);

  // ── Authoring — the ＋ button (`effects/effect-manifest.js#validateAuthoring`) ──
  ok('authoring names the `iridescence` mask kind', IRIDESCENCE.authoring?.paint === 'iridescence');
  ok(
    'the `iridescence` mask kind this manifest paints actually exists in the catalog',
    MASK_KINDS.some((k) => k.id === 'iridescence')
  );

  ok('the declaration is frozen', Object.isFrozen(IRIDESCENCE) && Object.isFrozen(IRIDESCENCE_PARAMS));

  // ── Presets ────────────────────────────────────────────────────────────
  ok(
    'IRIDESCENCE_PRESETS is a real (if currently empty-of-named-looks) table',
    typeof IRIDESCENCE_PRESETS === 'object'
  );
  ok(
    'iridescencePreset always returns a FULL params object, even for an unknown name',
    Object.keys(iridescencePreset('does-not-exist')).length === Object.keys(IRIDESCENCE_PARAMS).length
  );
  ok(
    "iridescencePreset('none') is exactly the schema defaults",
    Object.entries(iridescencePreset('none')).every(([k, v]) => v === IRIDESCENCE_PARAMS[k].default)
  );

  // ── V2's own shipped defaults, not its drifted schema defaults ──────────
  ok(
    'distortionStrength matches V2`s own constructor default (0.13)',
    IRIDESCENCE_PARAMS.distortionStrength.default === 0.13
  );
  ok('maskThreshold matches V2`s own constructor default (0.4)', IRIDESCENCE_PARAMS.maskThreshold.default === 0.4);
  ok(
    'colorCycleSpeed matches V2`s own constructor default (0.25)',
    IRIDESCENCE_PARAMS.colorCycleSpeed.default === 0.25
  );
}
