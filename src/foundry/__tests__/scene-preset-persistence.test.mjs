/**
 * Node verification for foundry/scene-preset-persistence.js (mythica-machina-
 * press#177). Neither `effect-preset-persistence.js` (this module's own
 * shape template) nor any other `registerSettings`-based world-JSON module
 * has a dedicated suite here except `region-darkness-override.test.mjs` —
 * this file follows THAT one's `fakeGame()` double (register/get/set over an
 * in-memory store, the same shape `settings-adapter.test.mjs` uses for the
 * adapter itself), extended with `wind-persistence.test.mjs`'s scoped
 * `withGlobals`-style installer (here: `withGame`) so each scenario below
 * gets a fresh, isolated `game` double rather than sharing mutable state.
 *
 * Section 1 tests the real exports directly: `registerScenePresetSettings`/
 * `readScenePresets`/`writeScenePresets` — register shape, the read/write
 * round trip, malformed-storage recovery, and GM-only failures reported
 * rather than thrown.
 *
 * Section 2 covers the save/apply/list/delete CONTRACT — presetName
 * validation, the "nothing captured yet" guard, not-found reporting, and
 * that apply hands `writeSceneAllEffectParams` EXACTLY the captured effects
 * blob. That behavior actually lives in `boot.js`'s `MapShine.
 * saveScenePreset`/`applyScenePreset`/`listScenePresets`/`deleteScenePreset`
 * (mirroring where #102's own `MapShine.saveEffectPreset` etc. live) — a
 * single ~15k-line `install()` closure with no test import anywhere in this
 * codebase (no `MapShine.*` function is unit-tested directly today; #102's
 * own equivalents have the identical gap). Section 2 is therefore a
 * REFERENCE MIRROR of that boot.js logic, not the literal source — it calls
 * the REAL `readScenePresets`/`writeScenePresets` from this module (so the
 * storage half is genuinely exercised end to end) and fakes only the OTHER
 * two collaborators boot.js's versions call (`writeSceneAllEffectParams`,
 * `reapplyAll` — the first is `effect-param-persistence.js`'s own job to
 * prove, the second is boot.js's own reapply cascade). Keep this mirror in
 * sync if boot.js's real versions ever change shape.
 */
import { registerScenePresetSettings, readScenePresets, writeScenePresets } from '../scene-preset-persistence.js';

function fakeGame({ failGet = false, failSet = false } = {}) {
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
        if (failGet) throw new Error('game.settings.get exploded (simulated)');
        const k = `${namespace}.${key}`;
        if (!(k in store)) throw new Error(`setting "${k}" was never registered`);
        return store[k];
      },
      set(namespace, key, value) {
        if (failSet) return Promise.reject(new Error('game.settings.set rejected (simulated, GM only?)'));
        store[`${namespace}.${key}`] = value;
        return Promise.resolve(value);
      },
    },
  };
}

/** Installs `globalThis.game` for the duration of `fn`, restoring it after — same shape wind-persistence.test.mjs's `withGlobals` uses for `canvas`/`Hooks`. */
async function withGame(gameStub, fn) {
  const prior = globalThis.game;
  globalThis.game = gameStub;
  try {
    return await fn();
  } finally {
    globalThis.game = prior;
  }
}

/**
 * A reference mirror of boot.js's `MapShine.save/apply/list/
 * deleteScenePreset` (see this file's own header for why it is a mirror,
 * not an import). `readScenePresets`/`writeScenePresets` are the REAL
 * module exports; `allEffectParams`/`failWriteAll` stand in for
 * `readSceneAllEffectParams`/`writeSceneAllEffectParams`
 * (effect-param-persistence.js) exactly as boot.js's own version would call
 * them, and `reapplyCalls`/`writeAllCalls` record what boot.js's own
 * `reapplyAll`/`writeSceneAllEffectParams` would have been invoked with.
 */
function makeSceneMirror({ allEffectParams = null, allEffectParamsReason = null, failWriteAll = false } = {}) {
  const writeAllCalls = [];
  const reapplyCalls = [];

  const writeSceneAllEffectParams = async (all) => {
    writeAllCalls.push(all);
    if (failWriteAll) {
      return { ok: false, reason: "writing this scene's effect params failed (GM only?): simulated" };
    }
    return { ok: true, reason: null };
  };
  const reapplyAll = (when) => reapplyCalls.push(when);

  const saveScenePreset = async (presetName) => {
    if (typeof presetName !== 'string' || !presetName) {
      return { ok: false, reason: 'presetName is required' };
    }
    if (!allEffectParams) {
      return {
        ok: false,
        reason: allEffectParamsReason ?? 'this scene has no authored effect settings to capture yet',
      };
    }
    const { presets } = readScenePresets();
    const next = {
      ...presets,
      [presetName]: { capturedAt: new Date().toISOString(), effects: allEffectParams },
    };
    return writeScenePresets(next);
  };

  const applyScenePreset = async (presetName) => {
    const { presets } = readScenePresets();
    const preset = presets?.[presetName];
    if (!preset) return { ok: false, reason: `no scene preset named '${presetName}'` };
    const result = await writeSceneAllEffectParams(preset.effects);
    if (result.ok) reapplyAll(`apply scene preset (${presetName})`);
    return result;
  };

  const listScenePresets = () => {
    const { presets } = readScenePresets();
    return {
      presets: Object.entries(presets).map(([name, preset]) => ({
        name,
        capturedAt: preset?.capturedAt ?? null,
        effectCount: preset?.effects && typeof preset.effects === 'object' ? Object.keys(preset.effects).length : 0,
      })),
    };
  };

  const deleteScenePreset = async (presetName) => {
    const { presets } = readScenePresets();
    if (!(presetName in presets)) return { ok: false, reason: `no scene preset named '${presetName}'` };
    const next = { ...presets };
    delete next[presetName];
    return writeScenePresets(next);
  };

  return { saveScenePreset, applyScenePreset, listScenePresets, deleteScenePreset, writeAllCalls, reapplyCalls };
}

export async function run(t) {
  const { ok } = t;

  // ==========================================================================
  // SECTION 1 — registerScenePresetSettings / readScenePresets / writeScenePresets
  // ==========================================================================

  // ---- register shape -------------------------------------------------------
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const call = globalThis.game.registered[0];
    ok('registers under the map-shine-advanced namespace', call.namespace === 'map-shine-advanced');
    ok('registers the scenePresets key', call.key === 'scenePresets');
    ok('world scope, like the effect-preset library it mirrors', call.data.scope === 'world');
    ok("config:false — not Foundry's own settings sheet", call.data.config === false);
    ok('defaults to an empty string (an empty library, JSON-serialized)', call.data.default === '');
    ok('types as String (the "enum" kind, no choices — a free-form JSON blob)', call.data.type === String);
  });

  // ---- nothing stored yet: an empty library, never confused with a failure -
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const read = readScenePresets();
    ok(
      'nothing stored yet -> presets:{} with reason:null (not a fabricated failure)',
      Object.keys(read.presets).length === 0 && read.reason === null
    );
  });

  // ---- write-then-read round trip, full nested shape ------------------------
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const payload = {
      'Cozy Tavern': {
        capturedAt: '2026-09-20T00:00:00.000Z',
        effects: { bloom: { intensity: 0.4 }, water: { flowSpeed: 1.2 } },
      },
    };
    const write = await writeScenePresets(payload);
    ok('write reports ok', write.ok === true && write.reason === null);
    const read = readScenePresets();
    ok(
      'read round-trips the exact written library, deep and all',
      JSON.stringify(read.presets) === JSON.stringify(payload)
    );
  });

  // ---- multiple presets coexist; a write REPLACES the whole library, like
  // writeEffectPresets/writeSceneAllEffectParams's own full-replace posture —
  // the caller (boot.js's save/delete) is responsible for spreading the prior
  // library into the next write, this layer does not merge on its behalf ----
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    await writeScenePresets({ A: { capturedAt: 't1', effects: {} }, B: { capturedAt: 't2', effects: {} } });
    await writeScenePresets({ A: { capturedAt: 't1', effects: {} } }); // B dropped deliberately
    const read = readScenePresets();
    ok(
      'the second write is the whole story — a name left out of it is gone, not preserved',
      Object.keys(read.presets).length === 1 && 'A' in read.presets && !('B' in read.presets)
    );
  });

  // ---- malformed stored JSON recovers to an empty library, never throws ----
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    globalThis.game.store['map-shine-advanced.scenePresets'] = '"just a string, not an object"';
    const read = readScenePresets();
    ok(
      'a parsed-but-non-object value falls back to {}',
      Object.keys(read.presets).length === 0 && read.reason === null
    );
  });

  // ---- read failure is reported, never thrown --------------------------------
  await withGame(fakeGame({ failGet: true }), async () => {
    registerScenePresetSettings();
    const read = readScenePresets();
    ok(
      'a throwing game.settings.get is reported, never thrown',
      Object.keys(read.presets).length === 0 && typeof read.reason === 'string'
    );
  });

  // ---- write failure (GM-only rejection) is reported, never thrown ----------
  await withGame(fakeGame({ failSet: true }), async () => {
    registerScenePresetSettings();
    const write = await writeScenePresets({ A: { capturedAt: 't1', effects: {} } });
    ok(
      'a rejecting game.settings.set is reported, never thrown',
      write.ok === false && typeof write.reason === 'string'
    );
  });

  // ---- onChange wiring: fires after commit, same posture settings-adapter/
  // region-darkness-override prove for their own registrations --------------
  await withGame(fakeGame(), async () => {
    let calls = 0;
    registerScenePresetSettings({ onChange: () => calls++ });
    globalThis.game.registered[0].data.onChange();
    ok('registering wires an onChange that fires on commit', calls === 1);
  });
  await withGame(fakeGame(), async () => {
    let threw = false;
    try {
      registerScenePresetSettings(); // no options at all — boot.js's own call site
    } catch {
      threw = true;
    }
    ok('an omitted options argument is safe (boot.js calls it with none)', !threw);
  });

  // ==========================================================================
  // SECTION 2 — save/apply/list/delete CONTRACT (reference mirror — see header)
  // ==========================================================================

  // ---- saving with an empty/missing name is rejected -------------------------
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const mirror = makeSceneMirror({ allEffectParams: { bloom: { intensity: 0.5 } } });
    const noArg = await mirror.saveScenePreset(undefined);
    const empty = await mirror.saveScenePreset('');
    ok(
      'a missing presetName is rejected, not silently saved under a blank key',
      noArg.ok === false && /presetName/.test(noArg.reason)
    );
    ok('an empty-string presetName is rejected the same way', empty.ok === false && /presetName/.test(empty.reason));
    ok('nothing was ever persisted by either rejected call', Object.keys(readScenePresets().presets).length === 0);
  });

  // ---- saving with nothing captured yet is rejected with a clear reason -----
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const mirror = makeSceneMirror({ allEffectParams: null, allEffectParamsReason: 'no active scene' });
    const result = await mirror.saveScenePreset('Cozy Tavern');
    ok('a scene with nothing authored yet is rejected, not saved as an empty preset', result.ok === false);
    ok(
      'the underlying reason (e.g. "no active scene") is surfaced, not swallowed',
      result.reason === 'no active scene'
    );
  });

  // ---- save-then-list round trip ---------------------------------------------
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const mirror = makeSceneMirror({ allEffectParams: { bloom: { intensity: 0.5 }, water: { flowSpeed: 1 } } });
    const save = await mirror.saveScenePreset('Cozy Tavern');
    ok('save reports ok', save.ok === true);
    const { presets } = mirror.listScenePresets();
    ok('the saved preset appears in the list exactly once', presets.length === 1 && presets[0].name === 'Cozy Tavern');
    ok(
      'list reports a capturedAt timestamp, not the full param blob',
      typeof presets[0].capturedAt === 'string' && presets[0].capturedAt.length > 0
    );
    ok(
      'list reports effectCount (2 here), not the effects object itself',
      presets[0].effectCount === 2 && presets[0].effects === undefined
    );
  });

  // ---- save-then-apply round trip: apply hands writeSceneAllEffectParams
  // EXACTLY what was captured, then triggers a reapply --------------------
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const capturedEffects = { bloom: { intensity: 0.5, threshold: 0.2 }, water: { flowSpeed: 1.2 } };
    const mirror = makeSceneMirror({ allEffectParams: capturedEffects });
    await mirror.saveScenePreset('Cozy Tavern');
    const applied = await mirror.applyScenePreset('Cozy Tavern');
    ok('apply reports ok', applied.ok === true);
    ok(
      'writeSceneAllEffectParams was called exactly once, with EXACTLY the captured effects blob',
      mirror.writeAllCalls.length === 1 && JSON.stringify(mirror.writeAllCalls[0]) === JSON.stringify(capturedEffects)
    );
    ok('a successful apply triggers exactly one reapply pass', mirror.reapplyCalls.length === 1);
  });

  // ---- applying a name that doesn't exist reports a clear error, and
  // touches neither writeSceneAllEffectParams nor reapplyAll ----------------
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const mirror = makeSceneMirror({ allEffectParams: { bloom: {} } });
    await mirror.saveScenePreset('Cozy Tavern');
    const applied = await mirror.applyScenePreset('Nonexistent');
    ok('applying an unknown name is rejected, not a silent no-op', applied.ok === false);
    ok("the reason names the preset that wasn't found", applied.reason.includes('Nonexistent'));
    ok('an unknown apply never reaches writeSceneAllEffectParams', mirror.writeAllCalls.length === 0);
    ok('an unknown apply never triggers a reapply pass', mirror.reapplyCalls.length === 0);
  });

  // ---- delete removes the right entry, leaves the rest untouched ------------
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const mirror = makeSceneMirror({ allEffectParams: { bloom: {} } });
    await mirror.saveScenePreset('Cozy Tavern');
    await mirror.saveScenePreset('Stormy Docks');
    const del = await mirror.deleteScenePreset('Cozy Tavern');
    ok('delete reports ok', del.ok === true);
    const { presets } = mirror.listScenePresets();
    ok('exactly the deleted preset is gone', presets.length === 1 && presets[0].name === 'Stormy Docks');
  });

  // ---- delete reports not-found for a missing name, rather than a silent
  // no-op that still reports ok:true --------------------------------------
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const mirror = makeSceneMirror({ allEffectParams: { bloom: {} } });
    await mirror.saveScenePreset('Cozy Tavern');
    const del = await mirror.deleteScenePreset('Nonexistent');
    ok('deleting an unknown name is reported as not-found, not ok:true', del.ok === false);
    ok("the reason names the preset that wasn't found", del.reason.includes('Nonexistent'));
    ok('the real preset is still there, untouched', Object.keys(readScenePresets().presets).length === 1);
  });

  // ---- GM-only write failure at the APPLY layer is reported, never thrown,
  // and never fires a reapply on top of a failed write ----------------------
  await withGame(fakeGame(), async () => {
    registerScenePresetSettings();
    const mirror = makeSceneMirror({ allEffectParams: { bloom: {} }, failWriteAll: true });
    await mirror.saveScenePreset('Cozy Tavern');
    const applied = await mirror.applyScenePreset('Cozy Tavern');
    ok(
      'a failing writeSceneAllEffectParams is reported, never thrown',
      applied.ok === false && typeof applied.reason === 'string'
    );
    ok(
      'reapplyAll never fires on top of a failed write (would show a change that was not persisted)',
      mirror.reapplyCalls.length === 0
    );
  });

  // ---- GM-only write failure at the SAVE layer (real writeScenePresets,
  // real game.settings.set rejecting) is reported, never thrown -------------
  await withGame(fakeGame({ failSet: true }), async () => {
    registerScenePresetSettings();
    const mirror = makeSceneMirror({ allEffectParams: { bloom: {} } });
    const save = await mirror.saveScenePreset('Cozy Tavern');
    ok(
      'a rejecting game.settings.set surfaces through save as ok:false, never thrown',
      save.ok === false && typeof save.reason === 'string'
    );
  });
}
