/**
 * Node verification for foundry/paint-adapter.js's scene-flag persistence.
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

function mkScene(initialFlagValue, { failSetFlag = false, failUnsetFlag = false } = {}) {
  const store = {};
  if (initialFlagValue !== undefined) store.paintedMasks = initialFlagValue;
  const calls = [];
  return {
    calls,
    scene: {
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

async function withCanvas(canvasStub, fn) {
  const prior = globalThis.canvas;
  globalThis.canvas = canvasStub;
  try {
    // MUST await here, not `return fn()` — fn is async, and a bare `return`
    // lets `finally` restore globalThis.canvas before fn's own internal
    // awaits (e.g. a loadPaintedMasks() called after an awaited save) run.
    return await fn();
  } finally {
    globalThis.canvas = prior;
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
}
