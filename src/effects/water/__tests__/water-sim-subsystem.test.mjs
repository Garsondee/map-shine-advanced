/**
 * water-sim-subsystem.test.mjs — THE ORCHESTRATION LOGIC ITSELF, WITH A FAKE
 * ALLOCATOR AND A FAKE RENDER PASS, NEVER TESTED UNTIL NOW. Same reasoning as
 * `water-flow-subsystem.test.mjs`'s own header: the thing worth pinning here
 * is control flow — which of the THREE different lifetimes (ping-pong
 * targets, step materials, the per-frame step itself, this module's own
 * header) fires on which trigger — not shader output, which needs a real GPU
 * and belongs to S5's own shader-lab bench task instead.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { createWaterSimSubsystem } from '../water-sim-subsystem.js';

function stubTexture(tag) {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  t.__tag = tag; // identity marker for the "did this get rebuilt against a NEW object" assertions
  return t;
}

/** A fake allocator that counts create/dispose calls and never touches a
 * real GPU — `.texture` is a plain marker object, never sampled. */
function fakeAllocator() {
  let created = 0;
  let disposed = 0;
  return {
    create(name) {
      created++;
      return { name, texture: { name }, dispose() {} };
    },
    dispose(rt) {
      if (rt) disposed++;
    },
    get created() {
      return created;
    },
    get disposed() {
      return disposed;
    },
  };
}

/** A fake `renderWaterPass` that counts calls and validates it was actually
 * handed a real target + quad. */
function fakeRenderPass() {
  let calls = 0;
  return {
    run(target, quad) {
      calls++;
      if (!target || !quad) throw new Error(`renderWaterPass call #${calls} got a missing target/quad`);
    },
    get calls() {
      return calls;
    },
  };
}

function buildHarness({ flowReady = true, bodyReady = true, flowW = 1024, flowH = 476 } = {}) {
  const allocator = fakeAllocator();
  const pass = fakeRenderPass();
  let flowTexture = flowReady ? stubTexture('flow-1') : null;
  const bodyTexture = bodyReady ? stubTexture('body-1') : null;
  const waterFlow = {
    get texture() {
      return flowTexture;
    },
    get width() {
      return flowReady ? flowW : null;
    },
    get height() {
      return flowReady ? flowH : null;
    },
  };
  const waterBody = {
    get texture() {
      return bodyTexture;
    },
    getRect: () => ({ minX: 0, minY: 0, maxX: 10240, maxY: 4760 }),
  };
  const params = { flowSpeedPx: 90, foam: 1 };
  const getWaterRenderState = () => ({ params });
  const subsystem = createWaterSimSubsystem({
    THREE,
    allocator,
    waterFlow,
    waterBody,
    renderWaterPass: (t, q) => pass.run(t, q),
    getWaterRenderState,
  });
  return {
    subsystem,
    allocator,
    pass,
    params,
    setFlowTexture: (t) => {
      flowTexture = t;
    },
  };
}

export function run(t) {
  const { ok } = t;

  // ══ NO INPUTS YET — reported honestly, never a crash, never a render ═══
  {
    const allocator = fakeAllocator();
    const pass = fakeRenderPass();
    const subsystem = createWaterSimSubsystem({
      THREE,
      allocator,
      waterFlow: { texture: null, width: null, height: null },
      waterBody: { texture: null, getRect: () => null },
      renderWaterPass: (tgt, q) => pass.run(tgt, q),
    });
    subsystem.tick(0.016);
    ok('no flow/body yet: no render passes run', pass.calls === 0);
    ok('no flow/body yet: texture reads null', subsystem.texture === null);
    ok('no flow/body yet: status names the reason', subsystem.getStatus().lastStatus.includes('waiting'));
  }

  // ══ FIRST TICK: allocate + clear both targets (2 passes) + one step (1
  // pass) = 3 total; both step materials get built (one rebuild) ═════════
  {
    const { subsystem, pass, allocator } = buildHarness();
    subsystem.tick(0.016);
    ok('first tick: exactly 3 render passes (clear ping + clear pong + one step)', pass.calls === 3);
    ok('first tick: allocates exactly 2 targets (ping + pong)', allocator.created === 2);
    ok('first tick: exactly one material rebuild', subsystem.getStatus().rebuilds === 1);
    ok('first tick: steps is 1', subsystem.getStatus().steps === 1);
    ok('first tick: the subsystem exposes a real texture afterward', !!subsystem.texture);
  }

  // ══ A SECOND TICK, NOTHING ELSE CHANGED: exactly one MORE pass (the
  // step), no reallocation, no rebuild ════════════════════════════════════
  {
    const { subsystem, pass, allocator } = buildHarness();
    subsystem.tick(0.016);
    const callsAfterFirst = pass.calls;
    const createdAfterFirst = allocator.created;
    subsystem.tick(0.016);
    ok('second tick: exactly one more render pass', pass.calls === callsAfterFirst + 1);
    ok('second tick: no new targets allocated', allocator.created === createdAfterFirst);
    ok('second tick: no additional rebuild', subsystem.getStatus().rebuilds === 1);
    ok('second tick: steps is now 2', subsystem.getStatus().steps === 2);
  }

  // ══ PING-PONG ALTERNATES — the texture identity returned differs between
  // consecutive ticks (it is genuinely a DIFFERENT target each time) ═════
  {
    const { subsystem } = buildHarness();
    subsystem.tick(0.016);
    const first = subsystem.texture;
    subsystem.tick(0.016);
    const second = subsystem.texture;
    subsystem.tick(0.016);
    const third = subsystem.texture;
    ok('ping-pong: consecutive ticks return different texture objects', first !== second);
    ok('ping-pong: the THIRD tick returns to the FIRST tick’s own target', first === third);
  }

  // ══ A FLOW REBAKE (new texture identity, SAME dimensions) triggers a
  // material rebuild but does NOT reallocate or re-clear the ping-pong
  // targets — this is the whole point of the three-lifetimes split ══════
  {
    const { subsystem, pass, allocator, setFlowTexture } = buildHarness();
    subsystem.tick(0.016);
    const createdAfterFirst = allocator.created;
    const callsAfterFirst = pass.calls;
    setFlowTexture(stubTexture('flow-2')); // author drags the flow-angle slider; water-flow-subsystem rebuilds wholesale
    subsystem.tick(0.016);
    ok('flow rebake: no new targets allocated (foam memory survives)', allocator.created === createdAfterFirst);
    ok('flow rebake: exactly one more render pass (the step only, no re-clear)', pass.calls === callsAfterFirst + 1);
    ok('flow rebake: a second material rebuild happened', subsystem.getStatus().rebuilds === 2);
  }

  // ══ dispose() TEARS DOWN EVERYTHING IT ALLOCATED ═══════════════════════
  {
    const { subsystem, allocator } = buildHarness();
    subsystem.tick(0.016);
    const createdCount = allocator.created;
    subsystem.dispose();
    ok('dispose() frees every target the subsystem allocated', allocator.disposed === createdCount);
    ok('texture reads null again after dispose', subsystem.texture === null);
  }

  // ══ setReachPx GUARDS AGAINST NON-FINITE/NEGATIVE INPUT — never lets a
  // bad external push corrupt the swash band into nonsense ═══════════════
  {
    const { subsystem } = buildHarness();
    // No assertion possible on the uniform's own value without a GPU read;
    // this only proves the guard does not throw on hostile input.
    let threw = false;
    try {
      subsystem.setReachPx(NaN);
      subsystem.setReachPx(-5);
      subsystem.setReachPx(0);
      subsystem.setReachPx(128);
    } catch (e) {
      threw = true;
    }
    ok('setReachPx never throws, even on NaN/negative/zero input', !threw);
  }
}
