/**
 * Node verification for foundry/wind-persistence.js — the scene-flag store
 * behind mythica-machina-press#541 (wind ambient not reaching other
 * connected clients). Neither sky-persistence.js nor fade-persistence.js
 * (the two modules this one mirrors) have their own dedicated suite here —
 * this is the first — so the mocking approach below follows the closest
 * available precedent instead: paint-adapter.test.mjs's `canvas`/scene
 * double (getFlag/setFlag over an in-memory store) for the read/write half,
 * and scene-walls.test.mjs's "Node genuinely has no `Hooks` global" guard-
 * clause proof for the watch half, extended with a small fake `Hooks.on`/
 * `.off` so the actual updateScene filtering logic — not just its absence —
 * gets exercised too.
 *
 * No live Foundry / two-client test is possible under Node; what this DOES
 * prove: a write-then-read round-trip, the "nothing stored yet" vs "stored
 * as a real zero" distinction (feedback_instruments_must_not_lie), GM-only
 * write failures reported rather than thrown, watchSceneWind's updateScene
 * filtering (active scene + this module's own `wind` flag key only), and
 * that a wind write never touches this same scene's own `sky` flag.
 */
import { readSceneWind, writeSceneWind, watchSceneWind } from '../wind-persistence.js';

/**
 * A tiny scene double: `getFlag`/`setFlag` over an in-memory store keyed
 * `${namespace}.${key}`, the same shape paint-adapter.test.mjs's own
 * `mkScene` uses to reproduce real Foundry semantics for the two calls this
 * module actually makes.
 */
function mkScene(initialFlags = {}, { failSetFlag = false, failGetFlag = false, id = 'scene-1' } = {}) {
  const store = { ...initialFlags };
  const calls = [];
  return {
    calls,
    store,
    scene: {
      id,
      getFlag: (namespace, key) => {
        if (failGetFlag) throw new Error('getFlag exploded (simulated)');
        return store[`${namespace}.${key}`];
      },
      setFlag: async (namespace, key, value) => {
        calls.push(['setFlag', namespace, key, value]);
        if (failSetFlag) throw new Error('setFlag rejected (simulated, GM only?)');
        store[`${namespace}.${key}`] = value;
      },
    },
  };
}

/**
 * A fake `Hooks` global — `on`/`off` only, all this module ever calls —
 * recording every registration so a test can fire one back synchronously
 * and prove the active-scene/own-flag-key filtering, not just Node's real
 * "no Hooks at all" absence (scene-walls.test.mjs's own guard-clause proof).
 */
function fakeHooks() {
  const handlers = new Map();
  let nextId = 1;
  return {
    handlers,
    on(event, fn) {
      const id = nextId++;
      handlers.set(id, { event, fn });
      return id;
    },
    off(_event, id) {
      handlers.delete(id);
    },
    /** Foundry calls an `updateScene` hook as (doc, change, options, userId). */
    fire(event, ...args) {
      for (const { event: e, fn } of handlers.values()) if (e === event) fn(...args);
    },
  };
}

/**
 * Installs `globalThis.canvas` (and, when given, `globalThis.Hooks`) for the
 * duration of `fn`, restoring whatever was there before — same shape as
 * paint-adapter.test.mjs's own `withCanvas`. `Hooks` is left UNTOUCHED when
 * `hooksStub` is omitted, so the "Node has no Hooks global at all" cases
 * exercise the real ambient absence rather than a stubbed one.
 */
async function withGlobals({ canvasStub, hooksStub } = {}, fn) {
  const priorCanvas = globalThis.canvas;
  const hadHooks = 'Hooks' in globalThis;
  const priorHooks = globalThis.Hooks;
  globalThis.canvas = canvasStub;
  if (hooksStub !== undefined) globalThis.Hooks = hooksStub;
  try {
    return await fn();
  } finally {
    globalThis.canvas = priorCanvas;
    if (hooksStub !== undefined) {
      if (hadHooks) globalThis.Hooks = priorHooks;
      else delete globalThis.Hooks;
    }
  }
}

export async function run(t) {
  const { ok } = t;

  // ---- no active scene: reports failure, never throws --------------------
  await withGlobals({ canvasStub: undefined }, async () => {
    const read = readSceneWind();
    ok('no canvas -> read wind:null, reason set', read.wind === null && read.reason === 'no active scene');
    const write = await writeSceneWind({ directionDeg: 90, speed01: 0.5 });
    ok('no canvas -> write ok:false, reason set', write.ok === false && write.reason === 'no active scene to write to');
  });
  await withGlobals({ canvasStub: { scene: null } }, async () => {
    const read = readSceneWind();
    ok('canvas.scene null -> read wind:null, reason set', read.wind === null && read.reason === 'no active scene');
  });

  // ---- nothing stored yet: null, distinguishable from a real stored zero -
  {
    const rig = mkScene({});
    await withGlobals({ canvasStub: { scene: rig.scene } }, async () => {
      const read = readSceneWind();
      ok('nothing stored yet -> wind:null (not a fabricated zero)', read.wind === null && read.reason === null);
    });
  }

  // ---- write-then-read round-trip -----------------------------------------
  {
    const rig = mkScene({});
    await withGlobals({ canvasStub: { scene: rig.scene } }, async () => {
      const write = await writeSceneWind({ directionDeg: 135, speed01: 0.6 });
      ok('write reports ok', write.ok === true && write.reason === null);
      const read = readSceneWind();
      ok(
        'read round-trips the exact written pair',
        read.wind && read.wind.directionDeg === 135 && read.wind.speed01 === 0.6
      );
    });
  }

  // ---- a second write fully REPLACES, never merges — matches
  // writeSceneSky/writeFadeState's own full-replace posture. The MERGE onto
  // current values (a speed-only commit must not blank out direction) is
  // MapShine.setWind's own job in boot.js, one layer up, the same split
  // editSky/writeSceneSky already have.
  {
    const rig = mkScene({});
    await withGlobals({ canvasStub: { scene: rig.scene } }, async () => {
      await writeSceneWind({ directionDeg: 10, speed01: 0.2 });
      await writeSceneWind({ directionDeg: 50, speed01: 0.9 });
      const read = readSceneWind();
      ok(
        'the second write is the whole story, not merged with the first',
        read.wind.directionDeg === 50 && read.wind.speed01 === 0.9
      );
    });
  }

  // ---- isolation: a wind write never touches this scene's own SKY flag
  // (mythica-machina-press#541's own "doesn't touch the sky object/schema
  // at all" requirement, proven against a real mock scene rather than just
  // implied by this file never importing sky-persistence.js) -------------
  {
    const rig = mkScene({ 'map-shine-advanced.sky': { mode: 'aesthetic', todHour: 12 } });
    await withGlobals({ canvasStub: { scene: rig.scene } }, async () => {
      await writeSceneWind({ directionDeg: 200, speed01: 0.3 });
      ok(
        "the scene's own sky flag is untouched by a wind write",
        JSON.stringify(rig.store['map-shine-advanced.sky']) === JSON.stringify({ mode: 'aesthetic', todHour: 12 })
      );
      ok(
        'the wind write used its OWN flag key, not the sky one',
        rig.calls.some((c) => c[0] === 'setFlag' && c[2] === 'wind')
      );
    });
  }

  // ---- write failure (GM-only rejection) is reported, never thrown -------
  {
    const rig = mkScene({}, { failSetFlag: true });
    await withGlobals({ canvasStub: { scene: rig.scene } }, async () => {
      const write = await writeSceneWind({ directionDeg: 1, speed01: 1 });
      ok('a failing setFlag is reported, never thrown', write.ok === false && typeof write.reason === 'string');
    });
  }

  // ---- read failure is reported, never thrown -----------------------------
  {
    const rig = mkScene({}, { failGetFlag: true });
    await withGlobals({ canvasStub: { scene: rig.scene } }, async () => {
      const read = readSceneWind();
      ok('a throwing getFlag is reported, never thrown', read.wind === null && typeof read.reason === 'string');
    });
  }

  // ==========================================================================
  // watchSceneWind
  // ==========================================================================

  // ---- no Hooks global (Node) -> a safe no-op, exercising the real guard
  // clause, same posture scene-walls.test.mjs documents for its own watchers
  {
    let threw = false;
    let unsub;
    try {
      unsub = watchSceneWind(() => {});
    } catch {
      threw = true;
    }
    ok(
      'no globalThis.Hooks -> watchSceneWind never throws, returns a callable unsubscribe',
      !threw && typeof unsub === 'function'
    );
    let unsubThrew = false;
    try {
      unsub?.();
    } catch {
      unsubThrew = true;
    }
    ok('...and calling that unsubscribe is itself safe', !unsubThrew);
  }
  {
    let threw = false;
    try {
      watchSceneWind()(); // no callback at all — the returned unsub must still be safe to call
    } catch {
      threw = true;
    }
    ok('a missing/undefined onChange callback is also safe (never throws)', !threw);
  }

  // ---- a real fake Hooks global: registration + filtering + unsubscribe --
  {
    const hooks = fakeHooks();
    const rig = mkScene({}, { id: 'active-scene' });
    let changeCount = 0;
    let unsub;
    await withGlobals({ canvasStub: { scene: rig.scene }, hooksStub: hooks }, async () => {
      unsub = watchSceneWind(() => {
        changeCount++;
      });
      ok('registers exactly one updateScene handler', hooks.handlers.size === 1);

      // A different scene updating must never fire.
      hooks.fire('updateScene', { id: 'other-scene' }, { flags: { 'map-shine-advanced': { wind: {} } } });
      ok('a different scene updating does not fire onChange', changeCount === 0);

      // The active scene changing an UNRELATED flag (sky, not wind) must never fire.
      hooks.fire('updateScene', { id: 'active-scene' }, { flags: { 'map-shine-advanced': { sky: {} } } });
      ok("the active scene's sky flag changing does not fire onChange", changeCount === 0);

      // An update with no flags at all must never fire.
      hooks.fire('updateScene', { id: 'active-scene' }, {});
      ok('an update with no flags does not fire onChange', changeCount === 0);

      // THE REAL CASE: the active scene's own wind flag changing fires.
      hooks.fire(
        'updateScene',
        { id: 'active-scene' },
        { flags: { 'map-shine-advanced': { wind: { directionDeg: 1, speed01: 1 } } } }
      );
      ok("the active scene's own wind flag changing fires onChange", changeCount === 1);

      // No active scene at fire time (e.g. mid-teardown) must never fire.
      await withGlobals({ canvasStub: { scene: null }, hooksStub: hooks }, async () => {
        hooks.fire('updateScene', { id: 'active-scene' }, { flags: { 'map-shine-advanced': { wind: {} } } });
      });
      ok('no active scene at fire time does not fire onChange', changeCount === 1);

      // Unsubscribe actually removes the Hooks registration — called INSIDE
      // this same withGlobals block, since the unsubscribe itself calls
      // `Hooks.off` and must see the same fake `Hooks` it registered against
      // (outside this block, globalThis.Hooks has already been restored).
      unsub();
      ok('unsubscribe removes the Hooks.on registration', hooks.handlers.size === 0);

      // Firing again after unsubscribe must never reach onChange.
      hooks.fire('updateScene', { id: 'active-scene' }, { flags: { 'map-shine-advanced': { wind: {} } } });
      ok('a fire after unsubscribe never reaches onChange', changeCount === 1);
    });
  }

  // ---- a throwing onChange inside the Hooks callback must never propagate
  // past Foundry's own dispatch (the same "mid-teardown update; nothing to
  // recover" swallow every sibling watcher uses) ---------------------------
  {
    const hooks = fakeHooks();
    const rig = mkScene({}, { id: 'active-scene' });
    await withGlobals({ canvasStub: { scene: rig.scene }, hooksStub: hooks }, async () => {
      watchSceneWind(() => {
        throw new Error('onChange exploded (simulated)');
      });
      let threw = false;
      try {
        hooks.fire('updateScene', { id: 'active-scene' }, { flags: { 'map-shine-advanced': { wind: {} } } });
      } catch {
        threw = true;
      }
      ok('a throwing onChange is swallowed, never reaches the dispatcher', !threw);
    });
  }
}
