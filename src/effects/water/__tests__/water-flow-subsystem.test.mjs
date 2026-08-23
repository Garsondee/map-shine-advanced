/**
 * water-flow-subsystem.test.mjs — THE ORCHESTRATION LOGIC ITSELF, WITH A
 * FAKE ALLOCATOR AND A FAKE RENDER PASS, NEVER TESTED UNTIL NOW.
 *
 * `water-body-subsystem.js` has no test file of its own — its own GPU-
 * orchestration glue is judged too coupled to real render targets to be
 * worth a fake-GPU harness, and it leans on live/bench verification instead
 * (`run-tests.mjs`'s own header names this precedent). This file departs
 * from that on purpose: the very ordering bug this suite pins
 * (`docs/planning/Water-Simulation-Turn.md` §3 B1, the 2026-08-18
 * solidity-cascade fix) was a REAL, live-reported defect in exactly this
 * kind of control-flow — which passes/materials run in which order, how
 * many times, seeded from what — and a fake allocator + a fake
 * `renderWaterPass` that just counts and validates its own arguments is
 * enough to pin that shape precisely, with no GPU required.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { createWaterFlowSubsystem } from '../water-flow-subsystem.js';
import { WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL } from '../water-flow-solve.js';

function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
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
 * handed a real target + quad — catches the class of bug where a level's
 * own material/target never got built or wired at all. */
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

function buildHarness({ bearingDeg = 180 } = {}) {
  const allocator = fakeAllocator();
  const pass = fakeRenderPass();
  const maskTexture = stubTexture();
  const waterSurface = { getFullResMaskTexture: () => maskTexture };
  const waterBody = { getRect: () => ({ minX: 0, minY: 0, maxX: 1024, maxY: 476 }) };
  const createFlowTexture = (data, w, hgt) => {
    const t = new THREE.DataTexture(data, w, hgt, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.needsUpdate = true;
    return t;
  };
  const params = { flowAngleDeg: bearingDeg };
  const getWaterRenderState = () => ({ params });
  const subsystem = createWaterFlowSubsystem({
    THREE,
    allocator,
    waterSurface,
    waterBody,
    renderWaterPass: (t, q) => pass.run(t, q),
    createFlowTexture,
    getWaterRenderState,
  });
  return { subsystem, allocator, pass, params };
}

export function run(t) {
  const { ok } = t;

  // ══ A FULL BAKE RUNS EXACTLY THE EXPECTED SHAPE ═══════════════════════
  // 5 levels × (1 solidity + 2 fixed passes [velocity seed, divergence] +
  // WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL SOR iterations, EACH ONE TWO
  // checkerboard-parity renders since 2026-08-19 (`buildWaterJacobiStepMaterial`'s
  // own doc — plain Jacobi replaced by red-black SOR) + 1 pack) — pinned by
  // NUMBER so a future "simplify the loop" change that silently drops a
  // level, a pass, or an SOR half-step fails loudly here instead of only
  // showing up as a live symptom.
  {
    const { subsystem, allocator, pass } = buildHarness();
    subsystem.maybeBake();
    const expectedPassesPerLevel = 1 + 2 + WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL * 2 + 1;
    const expectedTotalPasses = expectedPassesPerLevel * 5;
    ok(
      `one full bake runs exactly ${expectedTotalPasses} render passes (5 levels × [1 solidity + 2 + ${WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL}×2 SOR half-steps + 1 pack])`,
      pass.calls === expectedTotalPasses
    );
    ok('one full bake allocates exactly 30 targets (5 levels × 6 targets each)', allocator.created === 30);
    ok('the subsystem exposes a real texture after baking', !!subsystem.texture);
    const status = subsystem.getStatus();
    ok('getStatus reports bakes:1 after the first bake', status.bakes === 1);
    ok('getStatus reports 5 levels', status.levelCount === 5);
    ok(
      'getStatus reports the finest level at the requested grid (1536x714, 2026-08-19: matches the raised WATER_FLOW_GRID_MAX_DIM)',
      status.grid === '1536x714'
    );
  }

  // ══ maybeBake IS A NO-OP WHEN NOTHING CHANGED — bake count must not
  // track poll/frame count (the body pack's own §1 discipline, ported) ═══
  {
    const { subsystem, pass } = buildHarness();
    subsystem.maybeBake();
    const callsAfterFirst = pass.calls;
    subsystem.maybeBake();
    subsystem.maybeBake();
    subsystem.maybeBake();
    ok('three more maybeBake calls with nothing changed render nothing further', pass.calls === callsAfterFirst);
    ok(
      'bakes stays at 1 while polls keeps climbing',
      subsystem.getStatus().bakes === 1 && subsystem.getStatus().polls === 4
    );
  }

  // ══ A BEARING CHANGE TRIGGERS A FULL REBAKE — direction genuinely
  // changes the solve's own routing, unlike speed (this module's own
  // header explains why speed is deliberately NOT tracked) ═══════════════
  {
    const { subsystem, pass, params } = buildHarness({ bearingDeg: 180 });
    subsystem.maybeBake();
    const callsAfterFirst = pass.calls;
    params.flowAngleDeg = 90; // author drags the compass
    subsystem.maybeBake();
    ok('changing flowAngleDeg triggers a second full bake', pass.calls > callsAfterFirst);
    ok('bakes is now 2', subsystem.getStatus().bakes === 2);
  }

  // ══ AN OMEGA (SOR strength) CHANGE TRIGGERS A FULL REBAKE — the author's
  // own "changing a slider rebakes" requirement (2026-08-19), same gate
  // shape as flowAngleDeg above ═══════════════════════════════════════════
  {
    const { subsystem, pass, params } = buildHarness();
    params.flowSolveOmega = 1.7;
    subsystem.maybeBake();
    const callsAfterFirst = pass.calls;
    params.flowSolveOmega = 1.2; // author drags the SOR-strength slider
    subsystem.maybeBake();
    ok('changing flowSolveOmega triggers a second full bake', pass.calls > callsAfterFirst);
    ok('bakes is now 2', subsystem.getStatus().bakes === 2);
    ok('lastBake reports the new omega, not the default', subsystem.getStatus().lastBake.omega === 1.2);
  }

  // ══ AN ITERATIONS-PER-LEVEL CHANGE TRIGGERS A FULL REBAKE, AND ACTUALLY
  // CHANGES THE PASS COUNT — proves the new value reaches the SOR loop
  // bound, not just the rebake gate ═══════════════════════════════════════
  {
    const { subsystem, pass, params } = buildHarness();
    subsystem.maybeBake();
    const callsAfterFirst = pass.calls;
    params.flowSolveIterations = 10; // author drags the iterations slider way down
    subsystem.maybeBake();
    const callsAfterSecond = pass.calls;
    ok('changing flowSolveIterations triggers a second full bake', callsAfterSecond > callsAfterFirst);
    const expectedSecondBakePasses = (1 + 2 + 10 * 2 + 1) * 5;
    ok(
      `the second bake runs exactly ${expectedSecondBakePasses} passes (5 levels × [1 solidity + 2 + 10×2 SOR half-steps + 1 pack]) — the new iteration count reached the SOR loop, not just the gate`,
      callsAfterSecond - callsAfterFirst === expectedSecondBakePasses
    );
  }

  // ══ dispose() TEARS DOWN EVERYTHING IT ALLOCATED ═══════════════════════
  {
    const { subsystem, allocator } = buildHarness();
    subsystem.maybeBake();
    const createdCount = allocator.created;
    subsystem.dispose();
    ok('dispose() frees every target the bake allocated', allocator.disposed === createdCount);
    ok('texture reads null again after dispose (levels cleared)', subsystem.texture === null);
  }

  // ══ NO MASK YET — reported honestly, never silently stuck ═════════════
  {
    const allocator = fakeAllocator();
    const pass = fakeRenderPass();
    const subsystem = createWaterFlowSubsystem({
      THREE,
      allocator,
      waterSurface: { getFullResMaskTexture: () => null },
      waterBody: { getRect: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }) },
      renderWaterPass: (tex, q) => pass.run(tex, q),
      createFlowTexture: (data, w, hgt) => {
        const tx = new THREE.DataTexture(data, w, hgt, THREE.RGBAFormat, THREE.UnsignedByteType);
        tx.needsUpdate = true;
        return tx;
      },
    });
    subsystem.maybeBake();
    ok('no mask yet: no render passes run', pass.calls === 0);
    ok(
      'no mask yet: status names the reason',
      subsystem.getStatus().lastBake.reason?.includes('no full-resolution mask')
    );
  }
}
