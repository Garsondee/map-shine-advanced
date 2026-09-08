/**
 * Node verification for foundry/region-darkness-override.js. Only the pure
 * rule (`isDarkeningRegionBehavior`) and the settings round-trip (against a
 * fake `game` global, same double `settings-adapter.test.mjs` uses) are
 * testable here — `applyRegionDarknessOverride`'s live `canvas.scene.regions`
 * read/write is browser-only, same split as every other live reader in this
 * zone (see `scene-regions.test.mjs`'s own header).
 */
import {
  isDarkeningRegionBehavior,
  registerRegionDarknessOverrideSettings,
  readRegionDarknessOverrideSettings,
  writeRegionDarknessOverrideSettings,
  DEFAULT_REGION_DARKNESS_OVERRIDE_VALUE,
} from '../region-darkness-override.js';

function fakeGame() {
  const registered = [];
  const store = {};
  return {
    registered,
    store,
    settings: {
      register(namespace, key, data) {
        registered.push({ namespace, key, data });
        store[`${namespace}.${key}`] = data.default;
      },
      get(namespace, key) {
        const k = `${namespace}.${key}`;
        if (!(k in store)) throw new Error(`setting "${k}" was never registered`);
        return store[k];
      },
      set(namespace, key, value) {
        store[`${namespace}.${key}`] = value;
        return Promise.resolve(value);
      },
    },
  };
}

export async function run(t) {
  const { ok } = t;

  // ---- isDarkeningRegionBehavior — the pure "which regions count" rule ----
  ok('OVERRIDE with a positive modifier is darkening', isDarkeningRegionBehavior(0, 0.75) === true);
  ok(
    'OVERRIDE with modifier 0 is NOT darkening (deliberately "always fully lit")',
    isDarkeningRegionBehavior(0, 0) === false
  );
  ok('BRIGHTEN is never darkening, regardless of modifier', isDarkeningRegionBehavior(1, 0.9) === false);
  ok('BRIGHTEN at modifier 0 is still never darkening', isDarkeningRegionBehavior(1, 0) === false);
  ok('DARKEN is always darkening, even at a small modifier', isDarkeningRegionBehavior(2, 0.01) === true);
  ok(
    'DARKEN at modifier 0 is still counted as darkening (mode alone decides)',
    isDarkeningRegionBehavior(2, 0) === true
  );
  ok('an unrecognized mode is never guessed into "darkening"', isDarkeningRegionBehavior(99, 0.9) === false);

  // ---- settings round-trip, against a fake `game` global -------------------
  const realGame = globalThis.game;
  try {
    globalThis.game = fakeGame();
    registerRegionDarknessOverrideSettings();
    const [enabledCall, valueCall] = globalThis.game.registered;
    ok('both settings register at world scope', enabledCall.data.scope === 'world' && valueCall.data.scope === 'world');
    ok(
      "both settings are config:false — edited from the Studio card, not Foundry's settings sheet",
      enabledCall.data.config === false && valueCall.data.config === false
    );
    ok('the toggle defaults to off', enabledCall.data.default === false);
    ok(
      'the value defaults to 0.75, stored as a string (the settings adapter has no numeric kind)',
      valueCall.data.default === String(DEFAULT_REGION_DARKNESS_OVERRIDE_VALUE)
    );

    const initial = readRegionDarknessOverrideSettings();
    ok('read reflects the registered defaults', initial.enabled === false && initial.value === 0.75);

    await writeRegionDarknessOverrideSettings({ enabled: true, value: 0.4 });
    const afterWrite = readRegionDarknessOverrideSettings();
    ok('write-then-read round-trips both fields', afterWrite.enabled === true && afterWrite.value === 0.4);

    await writeRegionDarknessOverrideSettings({ value: 5 });
    ok('an out-of-range value is clamped to 1 on write', readRegionDarknessOverrideSettings().value === 1);

    await writeRegionDarknessOverrideSettings({ value: -2 });
    ok('a negative value is clamped to 0 on write', readRegionDarknessOverrideSettings().value === 0);

    const beforeNoopWrite = readRegionDarknessOverrideSettings();
    await writeRegionDarknessOverrideSettings({});
    ok(
      'a patch touching neither field leaves both settings unchanged',
      readRegionDarknessOverrideSettings().enabled === beforeNoopWrite.enabled &&
        readRegionDarknessOverrideSettings().value === beforeNoopWrite.value
    );

    // Foundry calls the registered onChange itself, after a value commits —
    // simulated the same way settings-adapter.test.mjs does for the adapter.
    globalThis.game = fakeGame();
    let calls = 0;
    registerRegionDarknessOverrideSettings({ onChange: () => calls++ });
    globalThis.game.registered[0].data.onChange();
    ok('registering wires an onChange that fires on commit', calls === 1);
  } finally {
    globalThis.game = realGame;
  }
}
