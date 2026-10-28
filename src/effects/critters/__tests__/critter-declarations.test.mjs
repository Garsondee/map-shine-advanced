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
import {
  SMELLY_FLIES,
  SMELLY_FLIES_PARAMS,
  SMELLY_FLIES_PRESETS,
  SMELLY_FLIES_FOH,
  smellyFliesPreset,
} from '../smelly-flies.js';
import { MAGGOTS, MAGGOTS_PARAMS, MAGGOTS_PRESETS, MAGGOTS_FOH, maggotsPreset } from '../maggots.js';
import { FIREFLIES, FIREFLIES_PARAMS, FIREFLIES_PRESETS, FIREFLIES_FOH, firefliesPreset } from '../fireflies.js';
import { DUST, DUST_PARAMS, DUST_PRESETS, DUST_FOH, dustPreset } from '../dust.js';
import { CATEGORY_ORDER, rohGroups, groupParamsByCategory } from '../../../ui/widgets/param-groups.js';
import { FIREFLY_SYNC } from '../firefly-brain.js';
import { MASK_GRID_MAX_DIM } from '../../../scene/mask-derive.js';
import { ZONE_GRID_SIDE_MAX } from '../critter-zone.js';
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

/** The four effects: their manifest, schema, presets, and the mask kind each one paints. */
export const CRITTER_EFFECTS = Object.freeze([
  {
    label: 'SMELLY_FLIES',
    manifest: SMELLY_FLIES,
    params: SMELLY_FLIES_PARAMS,
    presets: SMELLY_FLIES_PRESETS,
    preset: smellyFliesPreset,
    kind: 'flies',
    // The Studio card's curated strip (`boot.js#registerSimpleEffectCard` uses this very constant).
    foh: SMELLY_FLIES_FOH,
  },
  {
    label: 'MAGGOTS',
    manifest: MAGGOTS,
    params: MAGGOTS_PARAMS,
    presets: MAGGOTS_PRESETS,
    preset: maggotsPreset,
    kind: 'maggots',
    foh: MAGGOTS_FOH,
  },
  {
    label: 'FIREFLIES',
    manifest: FIREFLIES,
    params: FIREFLIES_PARAMS,
    presets: FIREFLIES_PRESETS,
    preset: firefliesPreset,
    kind: 'fireflies',
    foh: FIREFLIES_FOH,
  },
  {
    label: 'DUST',
    manifest: DUST,
    params: DUST_PARAMS,
    presets: DUST_PRESETS,
    preset: dustPreset,
    kind: 'dust',
    foh: DUST_FOH,
  },
]);

export function run(t) {
  for (const { label, manifest, params, kind } of CRITTER_EFFECTS) {
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

    // Categories give the generated Studio card its sections — and the vocabulary is CLOSED. A category that is
    // not in `CATEGORY_ORDER` is silently swept into "Technical", which is how these three cards once drew as one
    // undifferentiated pile: the declaration said 'Swarm', 'Flight', 'Glow'… and the panel said 'Technical'.
    t.ok(
      `${label}: every param's category is in the Studio's vocabulary (none is swept into Technical)`,
      Object.values(params).every((d) => CATEGORY_ORDER.includes(d.category) && d.category !== 'Technical')
    );
    t.ok(
      `${label}: every param has help text (it becomes the tooltip)`,
      Object.values(params).every((d) => typeof d.help === 'string' && d.help.length > 20)
    );
    t.ok(
      `${label}: every param has a label`,
      Object.values(params).every((d) => typeof d.label === 'string' && d.label.length > 2)
    );
    const groups = groupParamsByCategory(params);
    t.ok(
      `${label}: the Studio sections it gets are ${groups.map((g) => g.category).join(', ')}`,
      groups.length >= 5 &&
        groups.some((g) => g.category === 'Weather') &&
        groups.some((g) => g.category === 'Presence')
    );
    t.ok(
      `${label}: a decent amount of controls to tune it (${Object.keys(params).length})`,
      Object.keys(params).length >= 30
    );
  }

  // ---- THE STUDIO CARDS: FOH is a curated strip, ROH is everything else ---------------------------
  for (const { label, params, foh, presets, preset } of CRITTER_EFFECTS) {
    t.ok(
      `${label}: every FOH key is a real param`,
      foh.every((k) => Object.hasOwn(params, k))
    );
    t.ok(`${label}: the FOH strip is short enough to stay a strip (≤ 8)`, foh.length >= 4 && foh.length <= 8);
    const rohKeys = rohGroups(params, foh).flatMap((g) => g.keys);
    t.ok(
      `${label}: FOH and ROH partition the schema — nothing lost, nothing drawn twice`,
      rohKeys.length + foh.length === Object.keys(params).length && foh.every((k) => !rohKeys.includes(k))
    );
    t.ok(
      `${label}: the weather controls are in ROH (Advanced), together, under Weather`,
      rohGroups(params, foh).find((g) => g.category === 'Weather')?.keys.length >= 6
    );
    // presets: each a patch of real params with in-range, correctly typed values
    const names = Object.keys(presets);
    t.ok(`${label}: it ships built-in presets (${names.join(', ')})`, names.length >= 4);
    for (const name of names) {
      const patch = preset(name);
      const bad = Object.entries(patch).filter(([k, v]) => {
        const d = params[k];
        if (!d) return true;
        if (d.type === 'float' || d.type === 'int') return !(Number.isFinite(v) && v >= d.min && v <= d.max);
        if (d.type === 'enum') return !d.values.includes(v);
        if (d.type === 'color') return !/^#[0-9a-fA-F]{6}$/.test(v);
        if (d.type === 'bool') return typeof v !== 'boolean';
        return true;
      });
      t.ok(
        `${label}: preset '${name}' only sets real params, in range${bad.length ? ' — bad: ' + bad.map((b) => b[0]).join() : ''}`,
        bad.length === 0
      );
    }
    t.ok(`${label}: an unknown preset is an empty patch, never a throw`, Object.keys(preset('nonsense')).length === 0);
    t.ok(
      `${label}: a preset is a fresh copy (applying one cannot mutate the table)`,
      preset(names[0]) !== presets[names[0]]
    );
  }

  // ---- four effects, four separate masks ---------------------------------------------------------
  t.ok(
    'the four critter-engine effects paint four DIFFERENT masks',
    new Set(CRITTER_EFFECTS.map((e) => e.manifest.authoring.paint)).size === 4
  );
  t.ok(
    'the four effects have four different ids and titles',
    new Set(CRITTER_EFFECTS.map((e) => e.manifest.id)).size === 4 &&
      new Set(CRITTER_EFFECTS.map((e) => e.manifest.title)).size === 4
  );
  t.ok(
    'the flies carry no maggot controls any more (they are their own effect)',
    !Object.keys(SMELLY_FLIES_PARAMS).some((k) => /maggot/i.test(k))
  );
  t.ok(
    'every effect has the SAME weather vocabulary under the same ids — one meaning per control',
    CRITTER_EFFECTS.every((e) =>
      [
        'rainResponse',
        'snowResponse',
        'windThreshold',
        'windResponse',
        'coldBelow',
        'coldResponse',
        'weatherFloor',
        'fadeTime',
      ].every(
        (k) => e.params[k]?.type === 'float' && e.params[k].category === (k === 'fadeTime' ? 'Response' : 'Weather')
      )
    )
  );

  // ---- specific behaviours the defaults must honour ---------------------------------------------
  t.ok(
    'maggots, painted, show up by default (the paint IS the opt-in now): a non-zero head-count',
    MAGGOTS_PARAMS.countPerZone.default > 0
  );
  t.ok('maggot rests are ordered', MAGGOTS_PARAMS.pauseMin.default < MAGGOTS_PARAMS.pauseMax.default);
  t.ok(
    'the fly cap is V2’s Max Flies, widened',
    SMELLY_FLIES_PARAMS.fliesPerZone.min === 0 && SMELLY_FLIES_PARAMS.fliesPerZone.max >= 30
  );
  t.ok('default swarm of 5 (V2 had 10; tuned down 2026-10-18)', SMELLY_FLIES_PARAMS.fliesPerZone.default === 5);
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
    'twilight thresholds default in a sane order (appear > full > fade)',
    FIREFLIES_PARAMS.appearBelowDeg.default > FIREFLIES_PARAMS.fullBelowDeg.default &&
      FIREFLIES_PARAMS.fullBelowDeg.default > FIREFLIES_PARAMS.fadeByDeg.default
  );
  t.ok('fireflies default to the real sky, not "always on"', FIREFLIES_PARAMS.alwaysActive.default === false);
  t.ok('the glow is bright enough to bloom by default', FIREFLIES_PARAMS.intensity.default > 1);
  t.ok(
    'the flash period cannot be set below the kernel’s own floor (the photosensitivity promise has ONE number)',
    FIREFLIES_PARAMS.flashPeriod.min >= FIREFLY_SYNC.PERIOD_FLOOR &&
      FIREFLIES_PARAMS.flashPeriod.default >= FIREFLIES_PARAMS.flashPeriod.min
  );
  t.ok(
    'fireflies stay out of the photosensitive class — which is only honest while the floor holds',
    FIREFLIES.a11y.photosensitive === false
  );
  t.ok(
    'the zone field is sized from the mask authority’s own grid cap (the two constants cannot drift)',
    ZONE_GRID_SIDE_MAX === MASK_GRID_MAX_DIM
  );

  // ---- species tables ----------------------------------------------------------------------------
  t.ok('four kinds', CRITTER_KINDS.join() === 'fly,maggot,firefly,mote');
  t.ok(
    'every kind has a positive capacity',
    CRITTER_KINDS.every((k) => CRITTER_CAPACITY[k] > 0)
  );
  t.ok(
    'capacity covers the manifests’ own per-zone ceilings',
    CRITTER_CAPACITY.fly >= SMELLY_FLIES_PARAMS.fliesPerZone.max &&
      CRITTER_CAPACITY.maggot >= MAGGOTS_PARAMS.countPerZone.max &&
      CRITTER_CAPACITY.firefly >= FIREFLIES_PARAMS.countPerZone.max &&
      // the top rung deals half again as many
      CRITTER_CAPACITY.mote >= DUST_PARAMS.countPerZone.max * 1.5
  );
  t.ok('the zone buffer holds a full 512² derived grid plus its 2-cell border', ZONE_MAX_CELLS === 516 * 516);

  // tier plans: monotone — a feature bought at one rung is never taken away higher up
  for (const family of ['fly', 'firefly', 'mote']) {
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
