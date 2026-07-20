/**
 * Node verification for effects/lighting/animations/registry.js — the
 * lookup contract and the deferred-animations documentation map. Individual
 * animations' TSL builders are verified as each one lands (their own
 * `*.test.mjs`, where they have pure logic to test) and live, via the debug
 * panel, for the actual shader output.
 */
import { LIGHT_ANIMATIONS, KNOWN_DEFERRED_ANIMATIONS, resolveLightAnimation } from '../registry.js';

export function run(t) {
  const { ok } = t;

  // ---- resolveLightAnimation — the safety-slide contract -------------------
  ok('null type resolves to null (no animation)', resolveLightAnimation(null) === null);
  ok('undefined type resolves to null', resolveLightAnimation(undefined) === null);
  ok('empty-string type resolves to null', resolveLightAnimation('') === null);
  ok(
    'an unrecognized/not-yet-built type resolves to null, never throws',
    resolveLightAnimation('some-type-that-does-not-exist') === null
  );
  ok(
    'a KNOWN-deferred type (e.g. reactivepulse) ALSO resolves to null — the safety-slide is unconditional',
    resolveLightAnimation('reactivepulse') === null
  );

  // ---- once an animation is registered, resolveLightAnimation finds it -----
  {
    const fakeBuilder = () => null;
    LIGHT_ANIMATIONS.__test_only__ = {
      label: 'Test Only',
      cpuDriver: 'time',
      forceDefaultColor: false,
      buildIlluminationSeed: fakeBuilder,
      buildColorationSeed: null,
    };
    const resolved = resolveLightAnimation('__test_only__');
    ok('a registered entry resolves to itself, not a copy', resolved === LIGHT_ANIMATIONS.__test_only__);
    ok('buildIlluminationSeed passes through', resolved.buildIlluminationSeed === fakeBuilder);
    ok('a channel with no seed builder is a real null, not absent/undefined', resolved.buildColorationSeed === null);
    delete LIGHT_ANIMATIONS.__test_only__;
  }

  // ---- KNOWN_DEFERRED_ANIMATIONS — documentation map, not a technical gate -
  ok(
    'KNOWN_DEFERRED_ANIMATIONS lists reactivepulse with a reason',
    typeof KNOWN_DEFERRED_ANIMATIONS.reactivepulse === 'string' && KNOWN_DEFERRED_ANIMATIONS.reactivepulse.length > 0
  );
  for (const key of ['magicalGloom', 'roiling', 'hole', 'denseSmoke']) {
    ok(
      `KNOWN_DEFERRED_ANIMATIONS lists the darkness animation "${key}" with a reason`,
      typeof KNOWN_DEFERRED_ANIMATIONS[key] === 'string' && KNOWN_DEFERRED_ANIMATIONS[key].length > 0
    );
  }
  ok(
    'KNOWN_DEFERRED_ANIMATIONS is frozen (a documentation constant, never mutated at runtime)',
    Object.isFrozen(KNOWN_DEFERRED_ANIMATIONS)
  );
}
