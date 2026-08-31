/**
 * tile-motion.test.mjs — the pure motion math (foundry/tile-motion.js).
 * No Foundry environment needed; every export here is a plain function.
 */
import {
  MOTION_TYPES,
  ROTATION_EASING_TYPES,
  normalizeTileMotionConfig,
  normalizeTransportState,
  computeElapsedSec,
  reanchorTransport,
  easeByName01,
  hash01,
  tileSeed,
  computeClockworkProgress01,
  computeRotationDeltaRad,
  isConfigEffectivelyAnimated,
  buildMotionGraph,
  combineRigidDeltas,
  applyRigidDelta,
  computeTileWorldTransforms,
} from '../tile-motion.js';

function cfg(overrides = {}) {
  return normalizeTileMotionConfig(
    {
      enabled: true,
      mode: 'transform',
      pivot: { x: 0, y: 0 },
      motion: { type: 'rotation', speed: 90, phase: 0 },
      ...overrides,
    },
    overrides.tileId ?? 'tileA'
  );
}

export function run(t) {
  const { ok } = t;
  const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

  // ── normalizeTileMotionConfig — never throws, clamps everything ──────────
  ok(
    'undefined config normalizes to a valid disabled default',
    normalizeTileMotionConfig(undefined, 'x').enabled === false
  );
  ok('null config does not throw', (() => normalizeTileMotionConfig(null, 'x'))() !== undefined);
  ok(
    'garbage motion.type falls back to rotation',
    normalizeTileMotionConfig({ motion: { type: 'nonsense' } }, 'x').motion.type === 'rotation'
  );
  ok(
    'garbage rotationEasing falls back to linear',
    normalizeTileMotionConfig({ motion: { rotationEasing: 'nonsense' } }, 'x').motion.rotationEasing === 'linear'
  );
  ok(
    'easeStrength clamps to [0,1]',
    normalizeTileMotionConfig({ motion: { easeStrength: 99 } }, 'x').motion.easeStrength === 1 &&
      normalizeTileMotionConfig({ motion: { easeStrength: -5 } }, 'x').motion.easeStrength === 0
  );
  ok(
    'clockworkSteps clamps to [1,48] and rounds',
    normalizeTileMotionConfig({ motion: { clockworkSteps: 200 } }, 'x').motion.clockworkSteps === 48 &&
      normalizeTileMotionConfig({ motion: { clockworkSteps: 0 } }, 'x').motion.clockworkSteps === 1
  );
  ok('a tile cannot be its own parent', normalizeTileMotionConfig({ parentId: 'self' }, 'self').parentId === null);
  ok('a genuine parentId survives', normalizeTileMotionConfig({ parentId: 'other' }, 'self').parentId === 'other');
  ok('MOTION_TYPES has exactly the 4 V2 types', MOTION_TYPES.length === 4);
  ok(
    'ROTATION_EASING_TYPES has exactly the 10 V2 curves incl. clockwork variants',
    ROTATION_EASING_TYPES.length === 10
  );

  // ── normalizeTransportState ───────────────────────────────────────────────
  ok('undefined transport normalizes to a valid stopped default', normalizeTransportState(undefined).playing === false);
  ok(
    'speedPercent/timeFactorPercent clamp to documented ranges',
    normalizeTransportState({ speedPercent: 999 }).speedPercent === 400 &&
      normalizeTransportState({ timeFactorPercent: 999 }).timeFactorPercent === 200
  );

  // ── transport clock — the anchor-based late-joiner fix ────────────────────
  {
    let transport = normalizeTransportState({ playing: true, anchorElapsedSec: 0, anchorAtMs: 0, speedPercent: 100 });
    ok(
      'stopped transport always reports 0 elapsed',
      computeElapsedSec(normalizeTransportState({ playing: false }), 99999) === 0
    );
    ok('elapsed advances 1:1 at 100% speed', near(computeElapsedSec(transport, 5000), 5));

    // Play 10s, then bump speed to 300% (reanchor).
    transport = reanchorTransport(
      { ...transport, anchorElapsedSec: computeElapsedSec(transport, 10000), anchorAtMs: 10000 },
      10000
    );
    const beforeChange = computeElapsedSec(transport, 10000);
    transport = normalizeTransportState({ ...reanchorTransport(transport, 10000), speedPercent: 300 });
    const rightAfterChange = computeElapsedSec(transport, 10000);
    ok('reanchoring at the same instant does not jump elapsed', near(beforeChange, rightAfterChange));
    ok(
      'a rate change applies going FORWARD, not retroactively',
      near(computeElapsedSec(transport, 12000), rightAfterChange + 6)
    );

    // Late joiner: reading the SAME persisted blob later must match exactly.
    ok(
      'a late joiner reading the same blob computes the identical elapsed a client present the whole time would',
      near(computeElapsedSec(transport, 12000), computeElapsedSec(transport, 12000))
    );

    // Pause freezes; resume continues from the frozen value.
    const paused = normalizeTransportState({ ...transport, paused: true, pausedAtMs: 12000 });
    ok(
      'paused elapsed is frozen at pausedAtMs regardless of how much later nowMs is',
      near(computeElapsedSec(paused, 999999), computeElapsedSec(paused, 12000))
    );
    const resumed = reanchorTransport(paused, 20000);
    ok(
      'resume is continuous at the pause/resume boundary',
      near(computeElapsedSec(resumed, 20000), computeElapsedSec(paused, 12000))
    );
  }

  // ── easing — boundary values ───────────────────────────────────────────────
  for (const name of [
    'easeInSine',
    'easeOutSine',
    'easeInOutSine',
    'easeInOutCubic',
    'easeInOutBack',
    'easeOutBounce',
    'easeInOutElastic',
  ]) {
    ok(`${name}(0) === 0`, near(easeByName01(name, 0), 0));
    ok(`${name}(1) === 1`, near(easeByName01(name, 1), 1));
  }
  ok('linear(u) === u', easeByName01('linear', 0.37) === 0.37);
  ok('hash01 is deterministic', hash01(42) === hash01(42));
  ok(
    'tileSeed is deterministic and stable per id',
    tileSeed('abc') === tileSeed('abc') && tileSeed('abc') !== tileSeed('xyz')
  );

  // ── clockwork — deterministic, no Math.random ─────────────────────────────
  {
    const motion = cfg().motion;
    const a = computeClockworkProgress01(0.5, motion, 'tileA', 0, 1);
    const b = computeClockworkProgress01(0.5, motion, 'tileA', 0, 1);
    ok('clockwork progress is deterministic for a fixed (tileId, cycleIndex, jank)', a === b);
    ok('clockwork progress stays within [0,1]', a >= 0 && a <= 1);
  }

  // ── rotation delta: fast path vs shaped path agree at the boundary ────────
  {
    const linearCfg = cfg({
      motion: { type: 'rotation', speed: 90, phase: 0, rotationEasing: 'linear', easeStrength: 1 },
    });
    ok(
      '1s at 90deg/s linear -> exactly 90deg in radians',
      near(computeRotationDeltaRad(linearCfg, 1, 'tileA'), 90 * (Math.PI / 180))
    );
  }

  // ── isConfigEffectivelyAnimated ────────────────────────────────────────────
  ok('disabled config is never animated', isConfigEffectivelyAnimated(cfg({ enabled: false })) === false);
  ok(
    'rotation with zero speed+phase is a no-op',
    isConfigEffectivelyAnimated(cfg({ motion: { type: 'rotation', speed: 0, phase: 0 } })) === false
  );
  ok(
    'rotation with nonzero speed is animated',
    isConfigEffectivelyAnimated(cfg({ motion: { type: 'rotation', speed: 5, phase: 0 } })) === true
  );

  // ── buildMotionGraph — topological order, cycles, missing parents ─────────
  {
    const configs = new Map([
      ['a', cfg({ tileId: 'a', motion: { type: 'rotation', speed: 10 } })],
      ['b', cfg({ tileId: 'b', parentId: 'a', motion: { type: 'rotation', speed: 0, phase: 0 } })], // passenger of a
      ['c', cfg({ tileId: 'c', parentId: 'b', motion: { type: 'rotation', speed: 5 } })],
    ]);
    const graph = buildMotionGraph(configs);
    ok('parent (a) is ordered before its child (c)', graph.order.indexOf('a') < graph.order.indexOf('c'));
    ok('b is included as a passenger even though it has no own motion', graph.order.includes('b'));
    ok(
      'no false-positive cycles/missing-parents on a clean chain',
      graph.invalidIds.size === 0 && graph.missingParentIds.size === 0
    );
  }
  {
    // A -> B -> A is a genuine cycle.
    const configs = new Map([
      ['a', cfg({ tileId: 'a', parentId: 'b', motion: { type: 'rotation', speed: 10 } })],
      ['b', cfg({ tileId: 'b', parentId: 'a', motion: { type: 'rotation', speed: 10 } })],
    ]);
    const graph = buildMotionGraph(configs);
    ok('a 2-cycle is fully captured in invalidIds', graph.invalidIds.has('a') && graph.invalidIds.has('b'));
  }
  {
    const configs = new Map([['a', cfg({ tileId: 'a', parentId: 'ghost', motion: { type: 'rotation', speed: 10 } })]]);
    const graph = buildMotionGraph(configs);
    ok('a parentId pointing nowhere lands in missingParentIds', graph.missingParentIds.has('a'));
  }

  // ── combineRigidDeltas — the hierarchy-composition invariant ──────────────
  {
    const outer = { deltaRotationRad: 0.7, pivotWorldX: 10, pivotWorldY: -3, translateWorldX: 2, translateWorldY: 5 };
    const identity = { deltaRotationRad: 0, pivotWorldX: 99, pivotWorldY: -42, translateWorldX: 0, translateWorldY: 0 };
    const combined = combineRigidDeltas(outer, identity);
    const points = [
      [0, 0],
      [5, 5],
      [-20, 13],
    ];
    let passengerOk = true;
    for (const [x, y] of points) {
      const a = applyRigidDelta(x, y, outer);
      const b = applyRigidDelta(x, y, combined);
      if (!near(a.x, b.x) || !near(a.y, b.y)) passengerOk = false;
    }
    ok(
      'a passenger (identity inner) inherits the outer delta verbatim, for ANY vertex not just the origin',
      passengerOk
    );

    const inner = { deltaRotationRad: -1.1, pivotWorldX: 4, pivotWorldY: 8, translateWorldX: -3, translateWorldY: 1 };
    const combinedReal = combineRigidDeltas(outer, inner);
    let sequentialOk = true;
    for (const [x, y] of [
      [0, 0],
      [7, -2],
      [-15, 30],
      [1000, -1000],
    ]) {
      const step1 = applyRigidDelta(x, y, outer);
      const step2 = applyRigidDelta(step1.x, step1.y, inner);
      const direct = applyRigidDelta(x, y, combinedReal);
      if (!near(step2.x, direct.x, 1e-6) || !near(step2.y, direct.y, 1e-6)) sequentialOk = false;
    }
    ok('combine(outer,inner) matches applying outer then inner in sequence, for arbitrary vertices', sequentialOk);
  }

  // ── computeQuadCorners rotation convention (the Y-flip gotcha) ────────────
  // scene-geometry.js#computeQuadCorners: x'=cos(a)*lx-sin(a)*ly, y'=sin(a)*lx+cos(a)*ly,
  // NO Y negation. A local point (1,0) rotated 90deg must land at (0,1).
  {
    const a = Math.PI / 2;
    const rx = Math.cos(a) * 1 - Math.sin(a) * 0;
    const ry = Math.sin(a) * 1 + Math.cos(a) * 0;
    ok('rotation convention matches computeQuadCorners exactly: (1,0) @ 90deg -> (0,1)', near(rx, 0) && near(ry, 1));
  }

  // ── full pipeline integration: rotating parent + bobbing child ────────────
  {
    const configs = new Map([
      [
        'parent',
        cfg({
          tileId: 'parent',
          motion: { type: 'rotation', speed: 90, phase: 0, rotationEasing: 'linear', easeStrength: 1 },
        }),
      ],
      [
        'child',
        cfg({
          tileId: 'child',
          parentId: 'parent',
          motion: { type: 'sine', speed: 0, phase: 0, amplitudeX: 0, amplitudeY: 0, amplitudeRot: 0 },
        }),
      ],
    ]);
    const rests = new Map([
      ['parent', { x: 0, y: 0, width: 100, height: 100, rotation: 0 }],
      ['child', { x: 50, y: 0, width: 20, height: 20, rotation: 0 }], // 50px east of parent's rest origin
    ]);
    const transport = normalizeTransportState({ playing: true, anchorElapsedSec: 0, anchorAtMs: 0, speedPercent: 100 });
    const { transforms, invalidIds, missingParentIds } = computeTileWorldTransforms(configs, rests, transport, 1000); // 1s elapsed -> parent spun 90deg

    ok('no invalid/missing-parent tiles in a clean 2-tile chain', invalidIds.size === 0 && missingParentIds.size === 0);
    ok('parent has a transform entry', transforms.has('parent'));
    ok('child has a transform entry (rides the parent even with no own translation)', transforms.has('child'));

    const childFinal = applyRigidDelta(50, 0, transforms.get('child'));
    ok(
      `child orbits with its spinning parent: rest (50,0) -> ~(0,50) after a 90deg parent spin, got (${childFinal.x.toFixed(3)},${childFinal.y.toFixed(3)})`,
      near(childFinal.x, 0, 1e-3) && near(childFinal.y, 50, 1e-3)
    );

    const parentFinal = applyRigidDelta(0, 0, transforms.get('parent'));
    ok(
      'a tile pivoting about its own rest origin does not translate its own origin',
      near(parentFinal.x, 0) && near(parentFinal.y, 0)
    );
  }

  // ── stopped playback / disabled tiles ──────────────────────────────────────
  {
    const configs = new Map([['a', cfg({ tileId: 'a' })]]);
    const rests = new Map([['a', { x: 0, y: 0, width: 10, height: 10, rotation: 0 }]]);
    const stopped = normalizeTransportState({ playing: false });
    const { transforms } = computeTileWorldTransforms(configs, rests, stopped, 1000);
    ok(
      'stopped transport yields an empty transform map (identity everywhere, no restore path needed)',
      transforms.size === 0
    );
  }
}
