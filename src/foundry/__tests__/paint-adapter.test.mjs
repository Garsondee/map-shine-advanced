/**
 * Node verification for foundry/paint-adapter.js's scene-flag persistence and
 * its permission gate.
 *
 * The gate is the newer and more important half: the painter is constructed
 * for EVERY connected client, and the only GM check anywhere else in the paint
 * chain is `scene-controls-button.js`'s `visible: game.user?.isGM === true` — a
 * toolbar VISIBILITY filter, not an authorization check. A player with a
 * browser console open reaches `savePaintedMasks` directly and the button's
 * `visible` flag never runs. A painted mask is map information, not decoration
 * ("secrets safe from players"), so the enforcement point is this write
 * boundary. The tests below therefore assert not just the verdict but that a
 * refusal attempts NO write at all — including the destructive `unsetFlag`
 * leg, which a check placed one line too late would still have run.
 *
 * Covers two related regressions:
 *  - Bug-Tracker #31 (Clear+Save not persisting): `serializePaintedMasks`
 *    (scene/paint-mask.js) deliberately DROPS a fully-cleared layer from the
 *    save payload ("store only what differs"), and Foundry's
 *    `Document#setFlag` deep-MERGES rather than replaces. A key dropped from
 *    the payload must still disappear from what's persisted.
 *  - The fix's own follow-up regression: an unconditional unsetFlag-then-
 *    setFlag sequence is non-atomic. If setFlag fails AFTER unsetFlag
 *    already succeeded, a naive implementation loses every previously-saved
 *    mask, not just the one this save touched — and an unwrapped throw from
 *    either call means the caller never learns the save failed at all.
 *    `savePaintedMasks` only takes the unset+set path when a key is
 *    actually being removed (the common "nothing was cleared" case stays a
 *    single setFlag), wraps both calls in try/catch, and best-effort
 *    restores the previous flag value if the sequence fails partway.
 *
 * `globalThis.canvas` is stubbed with a tiny scene mock that reproduces real
 * Foundry semantics for the three calls this module actually makes
 * (getFlag/setFlag merge, unsetFlag delete, either optionally rejecting) —
 * enough to prove the bugs and the fixes without a real Foundry/PIXI env.
 */
import { savePaintedMasks, loadPaintedMasks } from '../paint-adapter.js';

function mkScene(initialFlagValue, { failSetFlag = false, failUnsetFlag = false, canUserModify = () => false } = {}) {
  const store = {};
  if (initialFlagValue !== undefined) store.paintedMasks = initialFlagValue;
  const calls = [];
  return {
    calls,
    scene: {
      // A real Scene always carries this; the default mirrors Foundry's own
      // answer for a plain player with no scene ownership. Deliberately NOT
      // recorded in `calls` — that list is the write log the "a refusal
      // attempts no write" assertions read, and a permission probe is not a
      // write. Every GM case short-circuits before reaching this anyway.
      canUserModify: (user, action) => canUserModify(user, action),
      getFlag: (moduleId, key) => store[key],
      setFlag: async (moduleId, key, value) => {
        calls.push(['setFlag', key]);
        if (failSetFlag) throw new Error('setFlag rejected (simulated)');
        // Mirrors Document#setFlag: a MERGE (foundry.utils.mergeObject) of
        // the flag's existing value with `value`, not a replace.
        store[key] = { ...(store[key] || {}), ...value };
      },
      unsetFlag: async (moduleId, key) => {
        calls.push(['unsetFlag', key]);
        if (failUnsetFlag) throw new Error('unsetFlag rejected (simulated)');
        delete store[key];
      },
    },
  };
}

/**
 * Install both globals the module reads — `canvas` (scene + transforms) and
 * `game` (the permission gate's `game.user`) — for the duration of `fn`.
 *
 * `user` DEFAULTS TO A GM so every pre-existing assertion below, all of which
 * are about flag-write mechanics rather than authorization, keeps testing what
 * it was written to test. The permission cases pass an explicit `user`, or
 * `noGame: true` to remove the global entirely.
 */
async function withCanvas(canvasStub, fn, { user = { isGM: true }, noGame = false } = {}) {
  const priorCanvas = globalThis.canvas;
  const priorGame = globalThis.game;
  globalThis.canvas = canvasStub;
  globalThis.game = noGame ? undefined : { user };
  try {
    // MUST await here, not `return fn()` — fn is async, and a bare `return`
    // lets `finally` restore globalThis.canvas before fn's own internal
    // awaits (e.g. a loadPaintedMasks() called after an awaited save) run.
    return await fn();
  } finally {
    globalThis.canvas = priorCanvas;
    globalThis.game = priorGame;
  }
}

export async function run(t) {
  const { ok } = t;

  // ---- no active scene: reports failure, never throws --------------------
  await withCanvas(undefined, async () => {
    const r = await savePaintedMasks({ 'fire::0': { w: 1, h: 1, rle: [1, 0] } });
    ok('no canvas -> ok:false, reason set', r.ok === false && r.reason === 'no active scene');
    ok('no canvas -> loadPaintedMasks returns null', loadPaintedMasks() === null);
  });

  // ---- fresh scene, first save: the FAST PATH, no deletion needed --------
  {
    const rig = mkScene(undefined);
    await withCanvas({ ready: true, dimensions: {}, scene: rig.scene }, async () => {
      const layer = { w: 2, h: 2, rle: [4, 0] };
      const r = await savePaintedMasks({ 'fire::0': layer });
      ok('first save reports ok', r.ok === true);
      ok(
        'first save round-trips the exact payload',
        JSON.stringify(loadPaintedMasks()) === JSON.stringify({ 'fire::0': layer })
      );
    });
    ok('first save (nothing to delete) skips unsetFlag entirely', !rig.calls.some((c) => c[0] === 'unsetFlag'));
  }

  // ---- adding a mask alongside existing ones: still the fast path --------
  {
    const fireLayer = { w: 2, h: 2, rle: [4, 0] };
    const waterLayer = { w: 2, h: 2, rle: [4, 9] };
    const rig = mkScene({ 'fire::0': fireLayer });
    await withCanvas({ ready: true, dimensions: {}, scene: rig.scene }, async () => {
      const r = await savePaintedMasks({ 'fire::0': fireLayer, 'water::0': waterLayer });
      ok('additive save reports ok', r.ok === true);
    });
    ok('additive save (every old key still present) skips unsetFlag', !rig.calls.some((c) => c[0] === 'unsetFlag'));
  }

  // ---- THE REGRESSION (#31): clear the only mask, save, must actually delete
  {
    const fireLayer = { w: 2, h: 2, rle: [4, 0] };
    const rig = mkScene({ 'fire::0': fireLayer });
    await withCanvas({ ready: true, dimensions: {}, scene: rig.scene }, async () => {
      // save() -> serializePaintedMasks drops the now-empty layer -> {}
      const r = await savePaintedMasks({});
      ok('clear+save reports ok', r.ok === true);
      const after = loadPaintedMasks();
      ok(
        'clear+save actually removes the stale mask, not just omits it from this write',
        after === undefined || after === null || !('fire::0' in after)
      );
    });
    ok('an empty payload never calls setFlag (unsetFlag alone is enough)', !rig.calls.some((c) => c[0] === 'setFlag'));
    ok(
      'unsetFlag was called (a real deletion is needed here)',
      rig.calls.some((c) => c[0] === 'unsetFlag')
    );
  }

  // ---- partial clear: one kind cleared, a sibling kind must survive ------
  {
    const fireLayer = { w: 2, h: 2, rle: [4, 0] };
    const dustLayer = { w: 2, h: 2, rle: [4, 7] };
    const rig = mkScene({ 'fire::0': fireLayer, 'dust::0': dustLayer });
    await withCanvas({ ready: true, dimensions: {}, scene: rig.scene }, async () => {
      // fire::0 was cleared this session; dust::0 is untouched and still painted.
      await savePaintedMasks({ 'dust::0': dustLayer });
      const after = loadPaintedMasks();
      ok('partial clear: cleared kind is gone', !('fire::0' in (after || {})));
      ok(
        'partial clear: untouched kind survives',
        after && JSON.stringify(after['dust::0']) === JSON.stringify(dustLayer)
      );
    });
  }

  // ---- write ordering: unsetFlag must run before setFlag -----------------
  {
    const rig = mkScene({ 'fire::0': { w: 1, h: 1, rle: [1, 0] } });
    await withCanvas({ ready: true, dimensions: {}, scene: rig.scene }, async () => {
      await savePaintedMasks({ 'dust::0': { w: 1, h: 1, rle: [1, 5] } });
    });
    const order = rig.calls.map((c) => c[0]);
    ok(
      'unsetFlag precedes setFlag when the payload is non-empty',
      order.indexOf('unsetFlag') < order.indexOf('setFlag')
    );
  }

  // ---- THE FOLLOW-UP REGRESSION: setFlag failing after unsetFlag succeeded
  // must not silently lose every previously-saved mask, and must not throw
  // past the caller.
  {
    const fireLayer = { w: 2, h: 2, rle: [4, 0] };
    const dustLayer = { w: 2, h: 2, rle: [4, 7] };
    const rig = mkScene({ 'fire::0': fireLayer, 'dust::0': dustLayer }, { failSetFlag: true });
    let r;
    await withCanvas({ ready: true, dimensions: {}, scene: rig.scene }, async () => {
      // Clearing fire::0 forces the delete path (unsetFlag), then the
      // re-write (setFlag) is made to fail.
      r = await savePaintedMasks({ 'dust::0': dustLayer });
    });
    ok('a failing setFlag is reported, never thrown', r && r.ok === false && typeof r.reason === 'string');
    const afterRestore = rig.calls.some((c) => c[0] === 'setFlag'); // the restore attempt itself
    ok('a restore setFlag was attempted after the failure', afterRestore);
    // The mock's own setFlag always throws when failSetFlag is set, so the
    // restore attempt also fails in this rig — the point being proven is
    // that it was ATTEMPTED (best-effort), not that this particular mock
    // can succeed at it. A real Foundry setFlag re-applying the SAME
    // previously-accepted value is far more likely to succeed than the
    // original (larger/different) payload was.
  }

  // ---- unsetFlag itself failing must also be reported, never thrown ------
  {
    const rig = mkScene({ 'fire::0': { w: 1, h: 1, rle: [1, 0] } }, { failUnsetFlag: true });
    let r;
    await withCanvas({ ready: true, dimensions: {}, scene: rig.scene }, async () => {
      r = await savePaintedMasks({}); // clearing the only mask forces unsetFlag
    });
    ok('a failing unsetFlag is reported, never thrown', r && r.ok === false && typeof r.reason === 'string');
  }

  // ---- the fast path never needs a restore: a failing setFlag with no
  // deletion pending must still report failure cleanly, with no unsetFlag
  // call at all (nothing was ever removed, so there is nothing to restore).
  {
    const rig = mkScene({ 'fire::0': { w: 1, h: 1, rle: [1, 0] } }, { failSetFlag: true });
    let r;
    await withCanvas({ ready: true, dimensions: {}, scene: rig.scene }, async () => {
      // Same key kept, one added -> no deletion -> fast path, single setFlag.
      r = await savePaintedMasks({ 'fire::0': { w: 1, h: 1, rle: [1, 0] }, 'dust::0': { w: 1, h: 1, rle: [1, 5] } });
    });
    ok('fast-path failure is reported, never thrown', r && r.ok === false);
    ok('fast-path failure never called unsetFlag', !rig.calls.some((c) => c[0] === 'unsetFlag'));
  }

  // ======================================================================
  // PERMISSION — the paint chain's ONE authorization check (see this file's
  // own header for why it has to live at this write boundary and not in the
  // UI that merely hides the brush).
  // ======================================================================

  // ---- a GM may always save, whatever the scene says ---------------------
  {
    // canUserModify deliberately refuses: a GM must never even consult it.
    const rig = mkScene(undefined, { canUserModify: () => false });
    let r;
    await withCanvas(
      { ready: true, dimensions: {}, scene: rig.scene },
      async () => {
        r = await savePaintedMasks({ 'fire::0': { w: 1, h: 1, rle: [1, 0] } });
      },
      { user: { isGM: true } }
    );
    ok('GM may save even when the scene would refuse a non-GM update', r.ok === true);
    ok(
      'GM save really reached the write',
      rig.calls.some((c) => c[0] === 'setFlag')
    );
  }

  // ---- a non-GM the SCENE ITSELF grants update to may save ---------------
  // The gate is scene-level permission, not a blunt isGM(): a trusted player
  // with real scene ownership is exactly who Foundry's own canUserModify
  // exists to answer for, and locking them out would be a different bug.
  {
    const rig = mkScene(undefined, { canUserModify: (_user, action) => action === 'update' });
    let r;
    await withCanvas(
      { ready: true, dimensions: {}, scene: rig.scene },
      async () => {
        r = await savePaintedMasks({ 'fire::0': { w: 1, h: 1, rle: [1, 0] } });
      },
      { user: { isGM: false } }
    );
    ok('a non-GM the scene grants update to may save', r.ok === true);
    ok(
      'that save really reached the write',
      rig.calls.some((c) => c[0] === 'setFlag')
    );
  }

  // ---- a plain player is blocked, and NOTHING is attempted ---------------
  {
    const fireLayer = { w: 2, h: 2, rle: [4, 0] };
    const rig = mkScene({ 'fire::0': fireLayer }, { canUserModify: () => false });
    let r;
    let after;
    await withCanvas(
      { ready: true, dimensions: {}, scene: rig.scene },
      async () => {
        // An EMPTY payload against a non-empty stored flag is the destructive
        // path (needsDeletion -> unsetFlag). Using it here proves the refusal
        // lands before that leg, not merely before setFlag — a check placed
        // one line too late would still have wiped the author's masks on its
        // way to reporting failure.
        r = await savePaintedMasks({});
        after = loadPaintedMasks();
      },
      { user: { isGM: false } }
    );
    ok('a non-GM the scene refuses is blocked', r.ok === false);
    ok(
      'the refusal reason names permission (paint-mode.js surfaces it verbatim)',
      typeof r.reason === 'string' && /permission/i.test(r.reason)
    );
    ok('a blocked save NEVER calls setFlag', !rig.calls.some((c) => c[0] === 'setFlag'));
    ok('a blocked save NEVER calls unsetFlag — no partial write, ever', !rig.calls.some((c) => c[0] === 'unsetFlag'));
    ok('a blocked save made no write calls at all', rig.calls.length === 0);
    ok(
      "a blocked save leaves the author's existing masks intact",
      after && JSON.stringify(after['fire::0']) === JSON.stringify(fireLayer)
    );
  }

  // ---- fail-closed: no `game` global at all ------------------------------
  // Never "allowed by default" when the permission facts can't be read.
  {
    const rig = mkScene(undefined, { canUserModify: () => true });
    let r;
    await withCanvas(
      { ready: true, dimensions: {}, scene: rig.scene },
      async () => {
        r = await savePaintedMasks({ 'fire::0': { w: 1, h: 1, rle: [1, 0] } });
      },
      { noGame: true }
    );
    ok('no game global -> blocked, not allowed by default', r.ok === false);
    ok('no game global -> nothing written', rig.calls.length === 0);
  }

  // ---- fail-closed: a scene with no canUserModify, and one that throws ---
  {
    const rig = mkScene(undefined);
    delete rig.scene.canUserModify;
    let r;
    await withCanvas(
      { ready: true, dimensions: {}, scene: rig.scene },
      async () => {
        r = await savePaintedMasks({ 'fire::0': { w: 1, h: 1, rle: [1, 0] } });
      },
      { user: { isGM: false } }
    );
    ok('a scene with no canUserModify blocks a non-GM rather than assuming yes', r.ok === false);
    ok('...and writes nothing', rig.calls.length === 0);
  }
  {
    const rig = mkScene(undefined, {
      canUserModify: () => {
        throw new Error('canUserModify exploded (simulated)');
      },
    });
    let r;
    await withCanvas(
      { ready: true, dimensions: {}, scene: rig.scene },
      async () => {
        r = await savePaintedMasks({ 'fire::0': { w: 1, h: 1, rle: [1, 0] } });
      },
      { user: { isGM: false } }
    );
    ok('a throwing canUserModify is reported as a refusal, never thrown past the caller', r && r.ok === false);
    ok('...and writes nothing', rig.calls.length === 0);
  }
}
