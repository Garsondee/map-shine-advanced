/**
 * anchor-catalog.test.mjs — the anchor catalog is DATA with an executable
 * contract (the mask-catalog discipline): malformed declarations fail HERE, at
 * build time. Also pins the V2 effectTarget → kind mapping the importer relies
 * on.
 */
import {
  ANCHOR_KINDS,
  validateAnchorCatalog,
  anchorKindById,
  anchorKindsForEffect,
  anchorKindByV2EffectTarget,
} from '../anchor-catalog.js';

export function run(t) {
  // --- the shipped catalog is valid ---------------------------------------
  const real = validateAnchorCatalog();
  t.ok('shipped anchor catalog validates clean', real.ok && real.errors.length === 0);

  // --- the candle kind is pinned (Tier 0's whole point) -------------------
  const candle = anchorKindById('candleFlame');
  t.ok('candleFlame kind exists', !!candle);
  t.ok("candleFlame's effect id is candleFlame", candle?.effectId === 'candleFlame');
  t.ok('candleFlame declares an intensity param', 'intensity' in (candle?.params ?? {}));
  t.ok(
    'candleFlame declares the per-candle override pairs (colour/size/light-reach)',
    [
      'useCustomColor',
      'customColor',
      'useCustomSize',
      'customSizePx',
      'useCustomLightRadius',
      'customLightRadiusPx',
    ].every((k) => k in (candle?.params ?? {}))
  );
  t.ok(
    'candleFlame declares its own map icon (the click/drag handle)',
    typeof candle?.icon === 'string' && candle.icon.length > 0
  );

  // --- the V2 → kind mapping the importer uses ----------------------------
  t.ok(
    "V2 'candleFlame' maps to the candleFlame kind",
    anchorKindByV2EffectTarget('candleFlame')?.id === 'candleFlame'
  );
  t.ok(
    "V2 'fire' does NOT map to an anchor (it is a painted region, not an anchor)",
    anchorKindByV2EffectTarget('fire') === null
  );
  t.ok('unknown V2 target maps to null', anchorKindByV2EffectTarget('nonsense') === null);
  t.ok(
    'anchorKindsForEffect(candleFlame) includes the candle kind',
    anchorKindsForEffect('candleFlame').some((k) => k.id === 'candleFlame')
  );
  t.ok('anchorKindsForEffect of an unknown effect is empty', anchorKindsForEffect('ghost').length === 0);

  // --- validation actually bites ------------------------------------------
  const base = {
    id: 'alpha',
    effectId: 'alpha',
    label: 'Alpha',
    v2EffectTargets: ['alpha'],
    params: { p: { type: 'float', min: 0, max: 1, default: 0, label: 'P' } },
    meaning: 'x'.repeat(20),
  };

  t.ok('a clean synthetic kind validates', validateAnchorCatalog([base]).ok);

  const dupTarget = validateAnchorCatalog([base, { ...base, id: 'beta', effectId: 'beta', label: 'Beta' }]);
  t.ok(
    'a V2 effectTarget claimed by two kinds is rejected',
    !dupTarget.ok && dupTarget.errors.some((e) => e.includes("'alpha'"))
  );

  const badId = validateAnchorCatalog([{ ...base, id: 'Not-Camel' }]);
  t.ok('a non-camelCase id is rejected', !badId.ok);

  const badParams = validateAnchorCatalog([
    { ...base, params: { p: { type: 'float', min: 1, max: 0, default: 0, label: 'P' } } },
  ]);
  t.ok('an incoherent param schema is rejected (min above max)', !badParams.ok);

  const noTargets = validateAnchorCatalog([{ ...base, v2EffectTargets: [] }]);
  t.ok('a kind with no V2 targets is rejected', !noTargets.ok);

  t.ok('a kind with no icon at all still validates (icon is optional)', validateAnchorCatalog([base]).ok);
  const badIcon = validateAnchorCatalog([{ ...base, icon: '' }]);
  t.ok('a declared-but-empty icon is rejected', !badIcon.ok);

  t.ok('ANCHOR_KINDS is frozen (data, not mutable state)', Object.isFrozen(ANCHOR_KINDS));
}
