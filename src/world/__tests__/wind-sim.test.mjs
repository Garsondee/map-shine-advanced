/**
 * wind-sim.test.mjs — Wind.md Tier 2's transient sim, 100% pure. Assertions
 * below are written against REAL printed numbers from a throwaway probe
 * script (run once, deleted — see wind-sim.js's own header for why that
 * matters here specifically: the GPU port cannot be print-debugged at all
 * without a live Foundry session, so this reference is the only thing in
 * this session that was actually exercised with real numbers).
 */
import {
  advectWindField,
  relaxWindField,
  splatWindField,
  dissipateWindField,
  stepWindSimReference,
  computeOneShotGain01,
  computeDecayTailTicks,
  computeThawWindowMs,
  doorwayImpulseFromWallSegment,
  gatherActiveImpulseSlots,
  WIND_SIM_MAX_ACTIVE_IMPULSES,
} from '../wind-sim.js';
import { validateWindContributor } from '../wind-field.js';

function approx(a, b, eps = 1e-3) {
  return Math.abs(a - b) <= eps;
}

export function run(t) {
  const { ok } = t;

  // --- advectWindField -------------------------------------------------------
  {
    // dt=0 is an exact no-op (backtrace lands exactly on the sampled cell).
    const vx = new Float32Array([0, 1, 2, 3, 4]);
    const vy = new Float32Array([0, 5, 4, 3, 2]);
    const out = advectWindField({ vx, vy, cols: 5, rows: 1, ambientX: 5, ambientY: 3, dt: 0, cellSize: 1 });
    ok(
      'dt=0 leaves vx byte-identical',
      Array.from(out.vx).every((v, i) => v === vx[i])
    );
    ok(
      'dt=0 leaves vy byte-identical',
      Array.from(out.vy).every((v, i) => v === vy[i])
    );

    // A small spike under a steady +X ambient drifts DOWNSTREAM (rightward)
    // over many ticks — the observed centroid: col 6.04 @ 10 ticks -> 11.10 @
    // 60 ticks (probe output), a real ~5 cell rightward drift over 1 second
    // under a 6 cell/s ambient. Repeated bilinear resampling is expected to
    // lose some peak/sum via numerical smoothing (a known semi-Lagrangian
    // property, not a bug) — assert DIRECTION and rough MAGNITUDE, not exact
    // conservation.
    const cols = 20;
    const rows = 1;
    let sx = new Float32Array(cols);
    let sy = new Float32Array(cols);
    sx[5] = 1;
    const dt = 1 / 60;
    let centroidAt10 = null;
    for (let tick = 0; tick < 60; tick++) {
      const stepped = advectWindField({ vx: sx, vy: sy, cols, rows, ambientX: 6, ambientY: 0, dt, cellSize: 1 });
      sx = stepped.vx;
      sy = stepped.vy;
      if (tick === 9) {
        let sum = 0;
        let wsum = 0;
        for (let col = 0; col < cols; col++) {
          sum += Math.abs(sx[col]) * col;
          wsum += Math.abs(sx[col]);
        }
        centroidAt10 = wsum > 0 ? sum / wsum : NaN;
      }
    }
    let sum = 0;
    let wsum = 0;
    for (let col = 0; col < cols; col++) {
      sum += Math.abs(sx[col]) * col;
      wsum += Math.abs(sx[col]);
    }
    const centroidAt60 = wsum > 0 ? sum / wsum : NaN;
    ok('a spike drifts rightward under +X ambient (centroid @10 ticks > start col 5)', centroidAt10 > 5.5);
    ok('the drift continues over more ticks (centroid @60 > centroid @10)', centroidAt60 > centroidAt10 + 3);

    // Defensive solid-zeroing: a solid cell reads exactly (0,0) out of
    // advect ALONE, even when its neighbours carry real velocity that would
    // otherwise backtrace-sample into it (see this fn's own header — the gap
    // this closes: relaxWindField only zeroes solid cells when iterations>0).
    const acols = 3;
    const arows = 1;
    const avx = new Float32Array([5, 0, 5]); // solid cell (index 1) starts at 0, neighbours are fast
    const avy = new Float32Array(3);
    const asolid = new Uint8Array([0, 1, 0]);
    const aout = advectWindField({
      vx: avx,
      vy: avy,
      cols: acols,
      rows: arows,
      solid: asolid,
      ambientX: 5,
      ambientY: 0,
      dt: 1,
      cellSize: 1,
    });
    ok('advectWindField zeroes a solid cell on its own, independent of relax', aout.vx[1] === 0 && aout.vy[1] === 0);
  }

  // --- relaxWindField ----------------------------------------------------------
  {
    // A cell with ONE solid neighbour to its +X: the into-wall X component is
    // fully cancelled after just 1 iteration (probe: 1 -> 0 exactly); the
    // tangential Y component survives the cancellation itself but the SAME
    // pass's blend-toward-neighbour-average still nudges it (probe: 0.5 ->
    // 0.40625 after 1 iter, since 3 of this tiny grid's 4 neighbour slots are
    // off-grid and read as a fixed 0).
    const cols = 3;
    const rows = 1;
    const vx = new Float32Array([1, 0, 0]);
    const vy = new Float32Array([0.5, 0, 0]);
    const solid = new Uint8Array([0, 1, 0]);
    const out1 = relaxWindField({ vx, vy, cols, rows, solid, iterations: 1, blend: 0.25 });
    ok('the into-wall X component is fully cancelled after 1 iteration', out1.vx[0] === 0);
    ok('the tangential Y component survives, reduced only by the neighbour blend', approx(out1.vy[0], 0.40625));
    const out4 = relaxWindField({ vx, vy, cols, rows, solid, iterations: 4, blend: 0.25 });
    ok('X stays cancelled across more iterations', out4.vx[0] === 0);
    ok('further iterations keep damping the tangential component toward 0', out4.vy[0] < out1.vy[0]);

    // A solid cell itself ALWAYS reads (0,0), regardless of its neighbours.
    const solidSelf = new Uint8Array([0, 1, 0]);
    const vxs = new Float32Array([1, 7, 1]);
    const vys = new Float32Array([1, -7, 1]);
    const outSolid = relaxWindField({ vx: vxs, vy: vys, cols, rows, solid: solidSelf, iterations: 3 });
    ok('a solid cell reads exactly (0,0) after relax', outSolid.vx[1] === 0 && outSolid.vy[1] === 0);

    // The SAME claim at iterations:0 (WIND_PARAMS' own documented
    // "reflect-only... off" rung) — the iteration loop never runs, so this
    // exercises the defensive post-loop zero pass specifically.
    const outSolidZeroIters = relaxWindField({ vx: vxs, vy: vys, cols, rows, solid: solidSelf, iterations: 0 });
    ok(
      'a solid cell reads exactly (0,0) even at iterations:0',
      outSolidZeroIters.vx[1] === 0 && outSolidZeroIters.vy[1] === 0
    );
    ok(
      'iterations:0 leaves OPEN cells completely untouched (a true pass-through)',
      outSolidZeroIters.vx[0] === 1 && outSolidZeroIters.vy[0] === 1
    );

    // A corner (solid to +X AND +Y): both raw components are driven near
    // zero (probe: (1,1) -> (0, 0.0625) after 1 iteration — NOT exactly
    // (0,0), because the blend step's neighbour average has one small
    // nonzero contributor left; the residual points along the OPEN
    // direction, not into either wall, so "small" is the right bar, not
    // "exactly zero").
    const cols2 = 2;
    const rows2 = 2;
    const cvx = new Float32Array([1, 0, 0, 0]);
    const cvy = new Float32Array([1, 0, 0, 0]);
    const csolid = new Uint8Array([0, 1, 1, 0]);
    const cornerOut = relaxWindField({ vx: cvx, vy: cvy, cols: cols2, rows: rows2, solid: csolid, iterations: 1 });
    ok(
      'a corner cancels both components to near-zero, not left at their original (1,1)',
      Math.hypot(cornerOut.vx[0], cornerOut.vy[0]) < 0.15
    );

    // A full wall with a far cell: near-wall damps hard, far-from-wall is
    // barely touched at the shipped default iteration count (probe @
    // iterations=4: nearWall 1.0 -> 0.0647, farFromWall 1.0 -> 0.9785).
    const wcols = 10;
    const wrows = 5;
    const wn = wcols * wrows;
    const wvx = new Float32Array(wn).fill(1);
    const wvy = new Float32Array(wn);
    const wsolid = new Uint8Array(wn);
    for (let row = 0; row < wrows; row++) wsolid[row * wcols + 6] = 1;
    const widx = (c, r) => r * wcols + c;
    const wout = relaxWindField({ vx: wvx, vy: wvy, cols: wcols, rows: wrows, solid: wsolid, iterations: 4 });
    ok('a cell against a wall is damped well below its ambient value', wout.vx[widx(5, 2)] < 0.15);
    ok('a cell far from any wall is barely touched at the default iteration count', wout.vx[widx(1, 2)] > 0.95);
  }

  // --- splatWindField ----------------------------------------------------------
  {
    const cols = 10;
    const rows = 10;
    let vx = new Float32Array(cols * rows);
    let vy = new Float32Array(cols * rows);
    const solid = new Uint8Array(cols * rows);
    const slots = [{ x: 5, y: 5, vx: 100, vy: 0, radius: 3, gain: 1 }];
    const dt = 1 / 60;
    const idx = (c, r) => r * cols + c;
    for (let tick = 0; tick < 30; tick++) {
      const out = splatWindField({ vx, vy, cols, rows, solid, slots, dt, originX: 0, originY: 0, cellSize: 1 });
      vx = out.vx;
      vy = out.vy;
    }
    // Probe: 100.000 at tick 30 (0.5s) — a bounded exponential follow, not an
    // unbounded accumulator (see this fn's own header for why that matters).
    ok('the centre cell converges to (bounded, not overshoots) the slot target', approx(vx[idx(5, 5)], 100, 0.5));
    ok('a cell outside every slot radius is left EXACTLY untouched', vx[idx(9, 9)] === 0 && vy[idx(9, 9)] === 0);

    // Convergence is genuinely bounded, never exceeds the target even after
    // many more ticks (no overshoot/ringing).
    for (let tick = 0; tick < 60; tick++) {
      const out = splatWindField({ vx, vy, cols, rows, solid, slots, dt, originX: 0, originY: 0, cellSize: 1 });
      vx = out.vx;
      vy = out.vy;
    }
    ok('extended ticking never overshoots the target', vx[idx(5, 5)] <= 100 + 1e-6);
  }

  // --- dissipateWindField ------------------------------------------------------
  {
    const out1s = dissipateWindField({
      vx: new Float32Array([1]),
      vy: new Float32Array([0]),
      dt: 1,
      decayPerSecond: 0.35,
    });
    ok('a 1-second tick applies decayPerSecond exactly', approx(out1s.vx[0], 0.35, 1e-6));

    // Frame-rate independence, proven, not asserted on faith: compounding 60
    // small dt=1/60 steps must reconstruct the SAME result as one dt=1 step
    // (probe: both landed at 0.350000).
    let v = 1;
    for (let i = 0; i < 60; i++) {
      v = dissipateWindField({ vx: new Float32Array([v]), vy: new Float32Array([0]), dt: 1 / 60, decayPerSecond: 0.35 })
        .vx[0];
    }
    ok('60 ticks at dt=1/60 compounds to the same result as one dt=1 tick', approx(v, 0.35, 1e-4));
  }

  // --- computeOneShotGain01 -----------------------------------------------------
  {
    const startMs = 1000;
    const lifetimeMs = 900;
    ok('gain is exactly 0 before start', computeOneShotGain01({ startMs, lifetimeMs, nowMs: startMs - 1 }) === 0);
    ok(
      'gain is exactly 0 at the very start (t=0)',
      computeOneShotGain01({ startMs, lifetimeMs, nowMs: startMs }) === 0
    );
    // Probe: attack peaks (gain=1.0000) at t=108ms == lifetimeMs * DOOR_IMPULSE_ATTACK_FRACTION (0.12).
    ok(
      'gain reaches its peak at the attack fraction of lifetime',
      approx(computeOneShotGain01({ startMs, lifetimeMs, nowMs: startMs + 108 }), 1, 0.01)
    );
    ok(
      'gain decays through the back half (0.6s: 0.32, per probe)',
      approx(computeOneShotGain01({ startMs, lifetimeMs, nowMs: startMs + 600 }), 0.32, 0.02)
    );
    ok(
      'gain is exactly 0 at exactly start+lifetime',
      computeOneShotGain01({ startMs, lifetimeMs, nowMs: startMs + 900 }) === 0
    );
    ok(
      'gain is exactly 0 after start+lifetime',
      computeOneShotGain01({ startMs, lifetimeMs, nowMs: startMs + 901 }) === 0
    );
    ok(
      'a non-finite input never throws, returns 0',
      computeOneShotGain01({ startMs: NaN, lifetimeMs, nowMs: 0 }) === 0
    );
  }

  // --- computeDecayTailTicks / computeThawWindowMs -------------------------------
  {
    ok(
      'a known decay/floor pair matches the closed-form log solve',
      computeDecayTailTicks({ decayPerStep: 0.9, energyFloorFraction: 0.01 }) ===
        Math.ceil(Math.log(0.01) / Math.log(0.9))
    );
    ok(
      'degenerate decayPerStep (>=1) never throws, returns 0',
      computeDecayTailTicks({ decayPerStep: 1, energyFloorFraction: 0.01 }) === 0
    );
    ok(
      'degenerate floor (<=0) never throws, returns 0',
      computeDecayTailTicks({ decayPerStep: 0.9, energyFloorFraction: 0 }) === 0
    );

    const windowMs = computeThawWindowMs({ lifetimeMs: 900, decayPerSecond: 0.35, tickHz: 60 });
    ok('the thaw window is at least the injection lifetime', windowMs >= 900);
    ok(
      'the thaw window adds a real, bounded decay tail (not thousands of ms)',
      windowMs > 900 && windowMs < 900 + 5000
    );
  }

  // --- doorwayImpulseFromWallSegment -----------------------------------------
  {
    // A vertical (N-S) wall with an ambient blowing due "+X": probe measured
    // impulse (4.8, ~0) — i.e. the impulse ends up pointing the SAME way the
    // ambient blows, self-corrected with no side/inside knowledge (see this
    // fn's own header for the derivation).
    const vertical = doorwayImpulseFromWallSegment(
      { x1: 10, y1: 0, x2: 10, y2: 20 },
      { ambientX: 3, ambientY: 0, nowMs: 0 }
    );
    ok(
      'a doorway through a wall the wind blows square into gets a real impulse',
      Math.hypot(vertical.impulse.x, vertical.impulse.y) > 3
    );
    ok('the impulse points the SAME way as the ambient (positive X)', vertical.impulse.x > 0);
    ok('the impulse is a valid WindContributor', validateWindContributor(vertical).ok);

    // A horizontal (E-W) wall — parallel to the same ambient — gets ~0.
    const horizontal = doorwayImpulseFromWallSegment(
      { x1: 0, y1: 10, x2: 20, y2: 10 },
      { ambientX: 3, ambientY: 0, nowMs: 0 }
    );
    ok(
      'a doorway in a wall parallel to the wind gets a near-zero impulse',
      Math.hypot(horizontal.impulse.x, horizontal.impulse.y) < 1e-6
    );

    // A windless scene gets exactly zero impulse (emergent, not special-cased).
    const windless = doorwayImpulseFromWallSegment(
      { x1: 10, y1: 0, x2: 10, y2: 20 },
      { ambientX: 0, ambientY: 0, nowMs: 0 }
    );
    ok('a windless scene produces exactly zero impulse', windless.impulse.x === 0 && windless.impulse.y === 0);

    // Degenerate (zero-length) wall never throws, returns null.
    ok(
      'a zero-length wall segment returns null, never throws or NaNs',
      doorwayImpulseFromWallSegment({ x1: 5, y1: 5, x2: 5, y2: 5 }, { ambientX: 3, ambientY: 0, nowMs: 0 }) === null
    );

    // The contributor carries a real startMs/lifetimeMs (oneShot, per the
    // shape validateWindContributor requires).
    ok(
      'the contributor is mode:oneShot with a finite startMs/lifetimeMs',
      vertical.mode === 'oneShot' && Number.isFinite(vertical.startMs) && vertical.lifetimeMs > 0
    );
  }

  // --- gatherActiveImpulseSlots -------------------------------------------------
  {
    const contributors = [];
    for (let i = 0; i < 6; i++) {
      contributors.push({
        id: `d${i}`,
        kind: 'impulse',
        mode: 'oneShot',
        at: { x: i, y: 0 },
        impulse: { x: 10 + i, y: 0 },
        strength: 1,
        radius: 50,
        startMs: 0,
        lifetimeMs: 900,
      });
    }
    const { slots: allExpired, droppedCount: dExpired } = gatherActiveImpulseSlots(contributors, 5000, 4);
    ok(
      'every contributor past its lifetime is excluded, not counted as a capacity drop',
      allExpired.length === 0 && dExpired === 0
    );

    const { slots: capped, droppedCount } = gatherActiveImpulseSlots(contributors, 100, 4);
    ok('the slot list never exceeds the configured cap', capped.length <= WIND_SIM_MAX_ACTIVE_IMPULSES);
    ok(
      'over-capacity is reported, never silently dropped without a count',
      droppedCount === contributors.length - capped.length
    );
    ok(
      'the STRONGEST contributors win when over capacity (6 entries vx 10..15, cap 4 -> keep the top four, 12..15)',
      capped.every((s) => s.vx >= 12)
    );

    // A steady-mode contributor is ignored entirely (only oneShots register).
    const steady = gatherActiveImpulseSlots(
      [
        {
          id: 's',
          kind: 'thermal',
          mode: 'steady',
          at: { x: 0, y: 0 },
          impulse: { x: 5, y: 0 },
          strength: 1,
          radius: 10,
        },
      ],
      0,
      4
    );
    ok('a steady-mode contributor never becomes a slot', steady.slots.length === 0);

    // A not-yet-started contributor (nowMs before startMs) is excluded.
    const notYet = gatherActiveImpulseSlots(
      [
        {
          id: 'x',
          kind: 'impulse',
          mode: 'oneShot',
          at: { x: 0, y: 0 },
          impulse: { x: 5, y: 0 },
          strength: 1,
          radius: 10,
          startMs: 1000,
          lifetimeMs: 900,
        },
      ],
      500,
      4
    );
    ok('a not-yet-started contributor is excluded', notYet.slots.length === 0);

    // Malformed entries never throw.
    ok(
      'a malformed contributor list never throws',
      (() => {
        try {
          gatherActiveImpulseSlots([null, {}, 'nope', { mode: 'oneShot' }], 0, 4);
          return true;
        } catch {
          return false;
        }
      })()
    );
  }

  // --- stepWindSimReference — the full composed pipeline -----------------------
  {
    const cols = 10;
    const rows = 5;
    let vx = new Float32Array(cols * rows);
    let vy = new Float32Array(cols * rows);
    const solid = new Uint8Array(cols * rows);
    for (let row = 0; row < rows; row++) solid[row * cols + 6] = 1; // a full vertical wall at col 6
    const idx = (c, r) => r * cols + c;
    const dt = 1 / 60;
    for (let tick = 0; tick < 90; tick++) {
      const slots = tick < 30 ? [{ x: 5, y: 2, vx: 40, vy: 0, radius: 2, gain: 1 }] : [];
      const out = stepWindSimReference({
        vx,
        vy,
        cols,
        rows,
        solid,
        restVx: null,
        restVy: null,
        ambientX: 0,
        ambientY: 0,
        dt,
        cellSize: 1,
        originX: 0,
        originY: 0,
        slots,
        iterations: 4,
        decayPerSecond: 0.35,
      });
      vx = out.vx;
      vy = out.vy;
      // A solid cell reads exactly (0,0) at EVERY tick, not just eventually.
      if (vx[idx(6, 2)] !== 0 || vy[idx(6, 2)] !== 0) {
        ok(`solid cell stays exactly zero at tick ${tick}`, false);
      }
    }
    ok('a solid cell never carries nonzero D_live across the whole run', vx[idx(6, 2)] === 0 && vy[idx(6, 2)] === 0);
    // Probe: the far side of the wall (col7) stayed at EXACTLY 0.000 for the
    // entire run — the wall genuinely blocks D_live from crossing.
    ok('a splat pushed against a wall never crosses to the far side', vx[idx(7, 2)] === 0);
    // After splatting stops (tick>=30) and ~1s more elapses, total energy has
    // collapsed toward zero (probe: 103.8 @ tick30 -> 0.005 @ tick60 -> 0.000 @ tick75+).
    let energy = 0;
    for (let i = 0; i < vx.length; i++) energy += vx[i] * vx[i] + vy[i] * vy[i];
    ok('total energy has decayed to a negligible fraction after the impulse ends', energy < 0.01);
  }
}
