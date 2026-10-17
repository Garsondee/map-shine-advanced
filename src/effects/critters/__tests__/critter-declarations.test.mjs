/**
 * The critter effects are DECLARATIONS first (docs: "declaration first,
 * implementation second"), so a malformed manifest, a ladder that disagrees with
 * its plan table, or a paint kind that does not exist is a red test months before
 * a GPU is involved — not a card that silently does nothing.
 */
import { validateEffectManifest } from '../../effect-manifest.js';
import { resolveEffectTier, PERFORMANCE_PROFILES } from '../../effect-cascade.js';
import { validateParamsSchema } from '../../../core/params-schema.js';
import { MASK_KINDS } from '../../../scene/mask-catalog.js';
import { SMELLY_FLIES, SMELLY_FLIES_PARAMS } from '../smelly-flies.js';
import { FIREFLIES, FIREFLIES_PARAMS } from '../fireflies.js';
import {
  CRITTER_KINDS,
  CRITTER_CAPACITY,
  CRITTER_DEFAULT_TIER,
  CRITTER_TIER_COUNT,
  ZONE_MAX_CELLS,
  FLY_LOOKS,
  FIREFLY_FLASH_STYLES,
  critterTierPlan,
  critterRefAreaPx2,
  critterMarginPx,
} from '../critter-species.js';

export function run(t) {
  for (const [label, manifest, params, kind] of [
    ['SMELLY_FLIES', SMELLY_FLIES, SMELLY_FLIES_PARAMS, 'flies'],
    ['FIREFLIES', FIREFLIES, FIREFLIES_PARAMS, 'fireflies'],
  ]) {
    const v = validateEffectManifest(manifest);
    t.ok(`${label} manifest validates${v.ok ? '' : ' — ' + v.errors.join('; ')}`, v.ok);
    const p = validateParamsSchema(params);
    t.ok(`${label} params schema validates${p.ok ? '' : ' — ' + p.errors.join('; ')}`, p.ok);
    t.ok(`${label} id is camelCase`, /^[a-z][a-zA-Z0-9]*$/.test(manifest.id));

    // The ＋ button's mask kind must EXIST, be paintable and be rasterized, or the
    // card offers a brush that paints into nothing.
    const mk = MASK_KINDS.find((k) => k.id === manifest.authoring?.paint);
    t.ok(`${label} authoring.paint names a real mask kind (${kind})`, !!mk && manifest.authoring.paint === kind);
    t.ok(`${label}'s mask kind is rasterized (the authority composites painted sources)`, mk?.rasterize === true);
    t.ok(`${label}'s mask kind is a plain gray, unpacked mask`, mk?.channels === 'gray' && mk?.packChannel === null);
    t.ok(`${label}'s mask kind has an absent default of "nothing"`, mk?.absentValue === 0);

    // The ladder and the plan table are two statements of one fact.
    t.ok(
      `${label} declares exactly ${CRITTER_TIER_COUNT} rungs (the plan table's count)`,
      manifest.tiers.length === CRITTER_TIER_COUNT
    );
    // Anti-drift: the default install (the `standard` profile) must land on the rung the fallback names.
    const std = resolveEffectTier(manifest, { profile: 'standard' });
    t.ok(
      `${label}: the standard profile resolves to CRITTER_DEFAULT_TIER (${std.tier} vs ${CRITTER_DEFAULT_TIER})`,
      std.tier === CRITTER_DEFAULT_TIER
    );
    t.ok(`${label}: the lowest profile still gets rung 0`, resolveEffectTier(manifest, { profile: 'low' }).tier === 0);
    t.ok(
      `${label}: the highest profile reaches the top rung`,
      resolveEffectTier(manifest, { profile: 'extreme' }).tier === CRITTER_TIER_COUNT - 1
    );
    t.ok(
      `${label}: every profile maps to a defined rung`,
      PERFORMANCE_PROFILES.every((pr) => resolveEffectTier(manifest, { profile: pr }).tier <= CRITTER_TIER_COUNT - 1)
    );

    // Categories give the generated card its sections.
    t.ok(
      `${label}: every param belongs to a category`,
      Object.values(params).every((d) => typeof d.category === 'string' && d.category.length > 0)
    );
    t.ok(
      `${label}: every param has help text (it becomes the tooltip)`,
      Object.values(params).every((d) => typeof d.help === 'string' && d.help.length > 20)
    );
  }

  // ---- specific behaviours the defaults must honour ---------------------------------------------
  t.ok('maggots default to OFF (opt-in grossness)', SMELLY_FLIES_PARAMS.maggotsPerZone.default === 0);
  t.ok(
    'the fly cap is V2’s Max Flies, widened',
    SMELLY_FLIES_PARAMS.fliesPerZone.min === 0 && SMELLY_FLIES_PARAMS.fliesPerZone.max >= 30
  );
  t.ok('V2 default swarm of 10 survives', SMELLY_FLIES_PARAMS.fliesPerZone.default === 10);
  t.ok('pause range is ordered', SMELLY_FLIES_PARAMS.pauseMin.default < SMELLY_FLIES_PARAMS.pauseMax.default);
  t.ok('flies sleep mostly at night by default', SMELLY_FLIES_PARAMS.nightActivity.default < 0.5);
  t.ok(
    'the species enum is exactly the shader’s table',
    SMELLY_FLIES_PARAMS.species.values.join() === FLY_LOOKS.join()
  );
  t.ok(
    'the flash-style enum is exactly the shader’s table',
    FIREFLIES_PARAMS.flashStyle.values.join() === FIREFLY_FLASH_STYLES.join()
  );
  t.ok(
    'fireflies never flash faster than two a second (the accessibility argument in the header)',
    FIREFLIES_PARAMS.flashPeriod.min >= 0.5
  );
  t.ok(
    'twilight thresholds default in a sane order (appear > full > fade)',
    FIREFLIES_PARAMS.appearBelowDeg.default > FIREFLIES_PARAMS.fullBelowDeg.default &&
      FIREFLIES_PARAMS.fullBelowDeg.default > FIREFLIES_PARAMS.fadeByDeg.default
  );
  t.ok('fireflies default to the real sky, not "always on"', FIREFLIES_PARAMS.alwaysActive.default === false);
  t.ok('the glow is bright enough to bloom by default', FIREFLIES_PARAMS.intensity.default > 1);

  // ---- species tables ----------------------------------------------------------------------------
  t.ok('three kinds', CRITTER_KINDS.join() === 'fly,maggot,firefly');
  t.ok(
    'every kind has a positive capacity',
    CRITTER_KINDS.every((k) => CRITTER_CAPACITY[k] > 0)
  );
  t.ok(
    'capacity covers the manifests’ own per-zone ceilings',
    CRITTER_CAPACITY.fly >= SMELLY_FLIES_PARAMS.fliesPerZone.max &&
      CRITTER_CAPACITY.maggot >= SMELLY_FLIES_PARAMS.maggotsPerZone.max &&
      CRITTER_CAPACITY.firefly >= FIREFLIES_PARAMS.countPerZone.max
  );
  t.ok('the zone buffer holds a full 512² derived grid', ZONE_MAX_CELLS === 512 * 512);

  // tier plans: monotone — a feature bought at one rung is never taken away higher up
  for (const family of ['fly', 'firefly']) {
    const plans = Array.from({ length: CRITTER_TIER_COUNT }, (_, n) => critterTierPlan(family, n));
    const flags = Object.keys(plans[0]).filter((k) => typeof plans[0][k] === 'boolean');
    t.ok(
      `${family} tier plans only ever ADD features going up`,
      flags.every((f) => plans.every((p, i) => i === 0 || !plans[i - 1][f] || p[f]))
    );
    t.ok(
      `${family} tier plans never reduce the population going up`,
      plans.every((p, i) => i === 0 || p.countScale >= plans[i - 1].countScale)
    );
    t.ok(`${family} rung 0 is the cheapest`, plans[0].countScale < plans[CRITTER_TIER_COUNT - 1].countScale);
  }
  t.ok('an out-of-range tier clamps', critterTierPlan('fly', 99) === critterTierPlan('fly', CRITTER_TIER_COUNT - 1));
  t.ok('a negative tier clamps', critterTierPlan('fly', -3) === critterTierPlan('fly', 0));
  t.ok(
    'a non-finite tier falls back to the default rung',
    critterTierPlan('fly', NaN) === critterTierPlan('fly', CRITTER_DEFAULT_TIER)
  );
  t.ok(
    'the fly ladder buys legs before it buys lighting',
    !critterTierPlan('fly', 0).legs &&
      critterTierPlan('fly', 1).legs &&
      !critterTierPlan('fly', 1).lit &&
      critterTierPlan('fly', 2).lit
  );

  // grid-relative sizes
  t.ok('reference area follows the grid', critterRefAreaPx2(200) === 4 * critterRefAreaPx2(100));
  t.ok('a bad grid falls back to 100 px', critterRefAreaPx2(NaN) === critterRefAreaPx2(100));
  t.ok(
    'the wander margin follows the grid and has a floor',
    critterMarginPx(10) === 128 && critterMarginPx(200) === 600
  );
}
