/**
 * Node verification for foundry/paint-adapter.js's scene-flag persistence —
 * specifically the Clear+Save regression: `serializePaintedMasks` (scene/
 * paint-mask.js) deliberately DROPS a fully-cleared layer from the save
 * payload ("store only what differs"), and Foundry's `Document#setFlag`
 * deep-MERGES rather than replaces. A key dropped from the payload must
 * still disappear from what's persisted — that's the whole point of the
 * unsetFlag-then-setFlag sequence this pins.
 *
 * `globalThis.canvas` is stubbed with a tiny scene mock that reproduces real
 * Foundry semantics for the three calls this module actually makes
 * (getFlag/setFlag merge, unsetFlag delete) — enough to prove the bug and
 * the fix without needing a real Foundry/PIXI environment.
 */
import { savePaintedMasks, loadPaintedMasks } from '../paint-adapter.js';

function mkScene(initialFlagValue) {
  const store = {};
  if (initialFlagValue !== undefined) store.paintedMasks = initialFlagValue;
  const calls = [];
  return {
    calls,
    scene: {
      getFlag: (moduleId, key) => store[key],
      setFlag: async (moduleId, key, value) => {
        calls.push(['setFlag', key]);
        // Mirrors Document#setFlag: a MERGE (foundry.utils.mergeObject) of
        // the flag's existing value with `value`, not a replace.
        store[key] = { ...(store[key] || {}), ...value };
      },
      unsetFlag: async (moduleId, key) => {
        calls.push(['unsetFlag', key]);
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

  // ---- fresh scene, first save --------------------------------------------
  await withCanvas({ ready: true, dimensions: {}, scene: mkScene(undefined).scene }, async () => {
    const layer = { w: 2, h: 2, rle: [4, 0] };
    const r = await savePaintedMasks({ 'fire::0': layer });
    ok('first save reports ok', r.ok === true);
    ok(
      'first save round-trips the exact payload',
      JSON.stringify(loadPaintedMasks()) === JSON.stringify({ 'fire::0': layer })
    );
  });

  // ---- THE REGRESSION: clear the only mask, save, must actually delete ---
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
      'unsetFlag was called',
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
}
