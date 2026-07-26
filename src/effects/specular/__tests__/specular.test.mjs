/**
 * specular.test.mjs — the specular declaration is a valid, registrable effect.
 *
 * Registration MACHINERY is proven in effect-registration.test.mjs; this pins
 * specular's own shape, that it flows through the one door, and the two claims
 * its header makes that are checkable as data: that the ladder is complete
 * (built + deferred = the whole design, nothing claimed twice, nothing dropped)
 * and that every rung named in `docs/planning/Specular.md` §6 is accounted for.
 */
import { validateParamsSchema } from '../../../core/params-schema.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { createEffectRegistry } from '../../registry.js';
import { resolveEffectEnabled } from '../../effect-cascade.js';
import { SPECULAR, SPECULAR_PARAMS } from '../specular.js';

export function run(t) {
  const { ok } = t;

  // --- the declaration validates ------------------------------------------
  ok('SPECULAR_PARAMS is a valid params schema', validateParamsSchema(SPECULAR_PARAMS).ok);
  ok('SPECULAR is a valid manifest', validateEffectManifest(SPECULAR).ok);
  ok("the effect's id is specular", SPECULAR.id === 'specular');
  ok(
    'tiers 0-2 do not flash (a11y photosensitive false) — the glint rung is 3',
    SPECULAR.a11y.photosensitive === false
  );

  // --- default ON: inert without a mask, so it cannot surprise a scene ----
  ok('gated to low → on even at Low', SPECULAR.enabledFromProfile === 'low');
  ok('resolves ON at Low by default', resolveEffectEnabled(SPECULAR, { profile: 'low' }) === true);
  ok('resolves ON at Standard by default', resolveEffectEnabled(SPECULAR, { profile: 'standard' }) === true);
  ok(
    'a player can still turn it OFF (final say)',
    resolveEffectEnabled(SPECULAR, { profile: 'low', playerEnable: 'off' }) === false
  );

  // --- the ladder: BUILT rungs in `tiers`, the rest honestly deferred -----
  // Asserted RELATIVE to each other rather than pinned to literals, so a rung
  // actually landing does not force an edit here — what must hold at EVERY
  // phase is that the two lists together describe one whole ladder.
  const built = SPECULAR.tiers.length;
  const deferred = SPECULAR.deferredRungs.length;
  ok('tier 0 exists — the coarse pin (Effects.md Law 1)', SPECULAR.tiers[0]?.n === 0);
  ok('tier 0 is named for what it does, not for a technique', SPECULAR.tiers[0]?.name === 'presence');
  ok('built + deferred describe the whole 9-rung ladder', built + deferred === 9);
  const allNames = [...SPECULAR.tiers.map((x) => x.name), ...SPECULAR.deferredRungs.map((x) => x.name)];
  ok('no rung is claimed twice', new Set(allNames).size === allNames.length);
  ok(
    'every deferred rung says what it will add',
    SPECULAR.deferredRungs.every((r) => typeof r.note === 'string')
  );

  // Effects.md Law 3, from tier 1 up — tier 0 is the admission price and is
  // exempt (see effect-manifest.js). The manifest validator proves this
  // generally; this pins the SHAPE the design argues for: the cheap rungs
  // cluster at the bottom and buy most of the look.
  ok('tier 1 is pure ALU (C1) — free detail on tier 0’s fetch', SPECULAR.tiers[1]?.cost.class === 'C1');
  ok('tier 2 is a graph read (C3) — no new bandwidth', SPECULAR.tiers[2]?.cost.class === 'C3');

  // --- every param is a MATERIAL or WORLD property, per the header --------
  // The V2 corpse this replaces had 30 shimmer sliders, each a property of a
  // noise generator. The count is the claim; assert it stays honest.
  const keys = Object.keys(SPECULAR_PARAMS);
  ok('the whole schema is well under V2’s 61 controls', keys.length <= 12);
  ok(
    'every param declares a help string an author can act on',
    keys.every((k) => (SPECULAR_PARAMS[k].help ?? '').length > 40)
  );
  ok(
    'every param declares a category, so the panel groups itself',
    keys.every((k) => typeof SPECULAR_PARAMS[k].category === 'string')
  );
  ok(
    'the indoor/outdoor split is visible in the SCHEMA, not just the shader',
    keys.some((k) => SPECULAR_PARAMS[k].category === 'Indoor') &&
      keys.some((k) => SPECULAR_PARAMS[k].category === 'Outdoor')
  );
  // The compatibility escape hatch is a real, reachable value, not prose.
  ok(
    'metalResponse can be taken to 0 — the documented "give me V2 back" setting',
    SPECULAR_PARAMS.metalResponse.min === 0
  );
  ok('…and defaults ABOVE 0, so the new behaviour is what ships', SPECULAR_PARAMS.metalResponse.default > 0);

  // --- it registers through the ONE door ----------------------------------
  const registry = createEffectRegistry();
  let applied = null;
  registry.register(SPECULAR, (resolved) => {
    applied = resolved;
  });
  registry.resolveAndApply('specular', { profile: 'standard', paramLayers: [{ strength: 0.5 }] });
  ok('registration + resolve reaches the apply callback', applied !== null);
  ok('…with the effect enabled', applied?.enabled === true);
  ok('…and the override layer winning over the default', applied?.params?.strength === 0.5);
  ok(
    '…while unset params fall back to their declared defaults',
    applied?.params?.lampHeight === SPECULAR_PARAMS.lampHeight.default
  );
}
