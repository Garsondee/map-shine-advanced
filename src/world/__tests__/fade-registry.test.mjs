/**
 * THE FADE REGISTRY — proving "automatically expands as we add more
 * effects" with a fake effect, not asserted by reading the design doc. If a
 * brand-new, made-up effect with a Studio-card-shaped {schema, getValue,
 * onChange} triple becomes fully fadeable with ZERO changes to this module
 * or fade-engine.js, the property is real.
 */
import { createFadeSourceRegistry, schemaFadeSource } from '../fade-registry.js';

/** A fake effect, exactly as `registerEffectCard`'s view-model factory would
 * shape one — never referenced by name anywhere in fade-registry.js itself. */
function fakeEffect(initial) {
  const state = { ...initial };
  const schema = {
    depth: { type: 'float', min: 0, max: 1, default: 0.5, label: 'Depth' },
    hue: { type: 'angle', default: 0, label: 'Hue' },
    tint: { type: 'color', space: 'srgb', default: '#000000', label: 'Tint' },
    enabled: { type: 'bool', default: true, label: 'Enabled' },
    // The two non-fadeable types a real schema might also carry — must be
    // excluded from `keys()`, never silently offered as fadeable.
    debugLabel: { type: 'text', default: '', label: 'Debug label' },
    fire: { type: 'action', label: 'Fire' },
  };
  return {
    schema,
    getValue: (id) => state[id],
    onChange: (id, value) => {
      state[id] = value;
    },
    _state: state, // test-only peek, not part of the real contract
  };
}

export function run(t) {
  // ---- schemaFadeSource — the whole auto-expansion mechanism -------------
  {
    const fx = fakeEffect({ depth: 0.5, hue: 90, tint: '#336699', enabled: true, debugLabel: 'x' });
    const source = schemaFadeSource(fx);

    t.ok(
      'keys() lists every fadeable field',
      new Set(source.keys()).size === 4 && source.keys().every((k) => ['depth', 'hue', 'tint', 'enabled'].includes(k))
    );
    t.ok('keys() excludes text (not fadeable)', !source.keys().includes('debugLabel'));
    t.ok('keys() excludes action (not fadeable)', !source.keys().includes('fire'));

    t.ok('typeOf reads the real declared type', source.typeOf('depth') === 'float');
    t.ok('typeOf on an unknown field is undefined, not a throw', source.typeOf('nope') === undefined);

    t.ok('readLive round-trips the real getValue', source.readLive('depth') === 0.5);

    source.write('depth', 0.9);
    t.ok('write round-trips through the real onChange', fx._state.depth === 0.9);
  }

  // ---- createFadeSourceRegistry — namespaced resolution -------------------
  {
    const registry = createFadeSourceRegistry();
    const water = fakeEffect({ depth: 0.3, hue: 200, tint: '#224466', enabled: true });
    const bloom = fakeEffect({ depth: 0.1, hue: 10, tint: '#ffcc00', enabled: false });

    registry.registerSource('water', schemaFadeSource(water));
    registry.registerSource('bloom', schemaFadeSource(bloom));

    t.ok('hasSource is true for a registered namespace', registry.hasSource('water'));
    t.ok('hasSource is false for an unregistered namespace', !registry.hasSource('fire'));

    t.ok('typeOf resolves through the correct namespace', registry.typeOf('water.depth') === 'float');
    t.ok(
      'typeOf resolves the SAME field name in a DIFFERENT namespace independently',
      registry.typeOf('bloom.depth') === 'float'
    );
    t.ok('typeOf on an unregistered namespace is undefined, not a throw', registry.typeOf('nope.depth') === undefined);
    t.ok('typeOf on a malformed key (no dot) is undefined, not a throw', registry.typeOf('nodothere') === undefined);

    t.ok(
      'readLive resolves the correct effect instance, not a shared one',
      registry.readLive('water.depth') === 0.3 && registry.readLive('bloom.depth') === 0.1
    );

    registry.write('water.tint', '#abcdef');
    t.ok(
      'write reaches the correct effect instance only',
      water._state.tint === '#abcdef' && bloom._state.tint === '#ffcc00'
    );

    t.throws(
      'write to an unregistered namespace throws (a fade must not silently vanish)',
      () => registry.write('fire.strength', 1),
      'unknown key'
    );

    t.throws(
      'registering the same namespace twice throws',
      () => registry.registerSource('water', schemaFadeSource(fakeEffect({}))),
      'already registered'
    );
    t.throws('a namespace containing a dot throws at registration, not at first resolve', () =>
      registry.registerSource('bad.name', schemaFadeSource(fakeEffect({})))
    );

    const keys = registry.allKeys();
    t.ok('allKeys is namespace-qualified', keys.includes('water.depth') && keys.includes('bloom.depth'));
    t.ok(
      'allKeys excludes non-fadeable fields from every source',
      !keys.some((k) => k.endsWith('.debugLabel') || k.endsWith('.fire'))
    );
    t.ok(
      'allKeys covers both registered sources (4 fadeable fields each)',
      keys.filter((k) => k.startsWith('water.')).length === 4 && keys.filter((k) => k.startsWith('bloom.')).length === 4
    );
  }

  // ---- the auto-expansion claim itself, made literal ----------------------
  {
    // A THIRD, entirely new "effect" — registered AFTER the registry already
    // exists, using nothing but the same generic wrapper. If this works with
    // no code above having been touched, "automatically expands" is real.
    const registry = createFadeSourceRegistry();
    const brandNewEffect = fakeEffect({ depth: 0.77, hue: 300, tint: '#112233', enabled: false });
    registry.registerSource('totallyNewEffectNobodyPlannedFor', schemaFadeSource(brandNewEffect));
    t.ok(
      'a never-before-seen effect is immediately, fully fadeable via the identical generic path',
      registry.typeOf('totallyNewEffectNobodyPlannedFor.hue') === 'angle' &&
        registry.readLive('totallyNewEffectNobodyPlannedFor.depth') === 0.77
    );
  }
}
