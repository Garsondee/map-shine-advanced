/**
 * force-defaults-registry.test.mjs — `createEffectRegistry({forceDefaults})`: while forcing, EVERY effect
 * resolves from its manifest defaults alone; the stored layers are ignored, not consumed, so switching it
 * off brings them straight back. The check is asked at each resolve (no restart, no cache).
 */
import { createEffectRegistry } from '../registry.js';
import { BLOOM } from '../bloom.js';

export function run(t) {
  const { ok } = t;
  const key = Object.keys(BLOOM.params)[0];
  const def = BLOOM.params[key].default;
  const tuned = typeof def === 'number' ? def + 0.123 : def;
  const layers = { profile: 'extreme', paramLayers: [{ [key]: tuned }] };

  let forcing = false;
  const reg = createEffectRegistry({ forceDefaults: () => forcing });
  let applied = null;
  reg.register(BLOOM, (r) => {
    applied = r;
  });

  if (typeof def !== 'number') {
    ok('the first bloom param is numeric (test premise)', false);
    return;
  }

  const normal = reg.resolveAndApply('bloom', layers);
  ok('not forcing: the stored layer wins', normal.params[key] === tuned || Math.abs(normal.params[key] - tuned) < 1e-9);

  forcing = true;
  const forced = reg.resolveAndApply('bloom', layers);
  ok('forcing: the shipped default comes back', forced.params[key] === def);
  ok('forcing: apply() received the defaults too (that is what draws)', applied.params[key] === def);
  ok('forcing: nothing is reported rejected', forced.rejected.length === 0);

  forcing = false;
  ok(
    'switching it off again restores the stored look (nothing was deleted)',
    Math.abs(reg.resolveAndApply('bloom', layers).params[key] - tuned) < 1e-9
  );

  const plain = createEffectRegistry();
  plain.register(BLOOM, () => {});
  ok(
    'a registry made without the option never forces',
    Math.abs(plain.resolveAndApply('bloom', layers).params[key] - tuned) < 1e-9
  );
}
