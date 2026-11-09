/**
 * wind-flow.test.mjs — LIVING WIND's flow solver, the CPU reference (mmp-vm1.1).
 *
 * The claims these pin come from the MSA Lab's wind claims (tools/lab/claims/wind.md), where the analytic field
 * failed them: a wake is slow air that recovers downstream; a room open only to the lee stays still; a dead-end room
 * behind a windward door only breathes while a cross-ventilated one carries a draught; a sealed room is dead still;
 * a paused world holds its wind exactly; and a gust's energy fades over seconds instead of vanishing in a frame.
 * Numbers are fractions of the driver speed U, on small grids (one cell ≈ 0.4 m), measured after the flow settles.
 */
import {
  stepWindFlowReference,
  flowDivergence,
  planWindFlowSteps,
  escapeField,
  WIND_FLOW_DEFAULTS,
} from '../wind-flow.js';

const U = 10; // cells per second
const DT = 1 / 20;
const OPTS = { vorticity: 2, jacobiIterations: 20, verticalEscapeCells: 12, indoorEscapeCells: 24 };

function scene(cols, rows) {
  const n = cols * rows;
  const solid = new Uint8Array(n);
  const sky = new Float32Array(n).fill(1);
  const set = (a, c, r, v) => {
    if (c >= 0 && r >= 0 && c < cols && r < rows) a[r * cols + c] = v;
  };
  return {
    cols,
    rows,
    solid,
    sky,
    block(c0, r0, c1, r1) {
      for (let c = c0; c <= c1; c++)
        for (let r = r0; r <= r1; r++) {
          set(solid, c, r, 1);
          set(sky, c, r, 0);
        }
    },
    room(c0, r0, c1, r1, doors = []) {
      for (let c = c0; c <= c1; c++)
        for (let r = r0; r <= r1; r++) {
          if (c === c0 || c === c1 || r === r0 || r === r1) set(solid, c, r, 1);
          set(sky, c, r, 0);
        }
      for (const [c, r] of doors) set(solid, c, r, 0);
    },
  };
}

/** Run to a settled state, return time-averaged speed / U and x-velocity / U over the second half. */
function settle(sc, { seconds = 10, start = U, driver = () => U } = {}) {
  const { cols, rows } = sc;
  const n = cols * rows;
  let vx = new Float32Array(n);
  for (let i = 0; i < n; i++) vx[i] = sc.sky[i] > 0 ? start : 0;
  let vy = new Float32Array(n);
  let p = null;
  const tx = new Float32Array(n);
  const ty = new Float32Array(n);
  const steps = Math.round(seconds / DT);
  const sumS = new Float64Array(n);
  const sumX = new Float64Array(n);
  let kept = 0;
  for (let s = 0; s < steps; s++) {
    tx.fill(driver(s * DT));
    const o = stepWindFlowReference({
      vx,
      vy,
      tx,
      ty,
      sky: sc.sky,
      solid: sc.solid,
      cols,
      rows,
      dt: DT,
      relaxCells: 45,
      p0: p,
      opts: OPTS,
    });
    vx = o.vx;
    vy = o.vy;
    p = o.p;
    if (s >= steps / 2) {
      kept++;
      for (let i = 0; i < n; i++) {
        sumS[i] += Math.hypot(vx[i], vy[i]);
        sumX[i] += vx[i];
      }
    }
  }
  const at = (a, c, r) => a[r * cols + c] / kept / U;
  return { sp: (c, r) => at(sumS, c, r), ux: (c, r) => at(sumX, c, r), vx, vy };
}

export function run(t) {
  const { ok } = t;

  // A paused world (dt = 0) holds its wind exactly.
  {
    const sc = scene(20, 10);
    const n = 200;
    const vx = Float32Array.from({ length: n }, (_, i) => (i % 7) * 0.3);
    const vy = Float32Array.from({ length: n }, (_, i) => (i % 5) * -0.2);
    const o = stepWindFlowReference({
      vx,
      vy,
      tx: new Float32Array(n).fill(U),
      ty: new Float32Array(n),
      sky: sc.sky,
      solid: sc.solid,
      cols: 20,
      rows: 10,
      dt: 0,
      relaxCells: 45,
    });
    ok(
      'dt 0 leaves vx exactly',
      o.vx.every((v, i) => v === vx[i])
    );
    ok(
      'dt 0 leaves vy exactly',
      o.vy.every((v, i) => v === vy[i])
    );
  }

  // Open ground: a uniform wind stays uniform and divergence-free.
  {
    const sc = scene(60, 30);
    const r = settle(sc, { seconds: 4 });
    let maxDev = 0;
    for (let c = 2; c < 58; c++) for (let rr = 2; rr < 28; rr++) maxDev = Math.max(maxDev, Math.abs(r.sp(c, rr) - 1));
    ok(`open ground stays at the driver (max deviation ${maxDev.toFixed(4)})`, maxDev < 0.02);
    const div = flowDivergence({ vx: r.vx, vy: r.vy, cols: 60, rows: 30, solid: sc.solid });
    const maxDiv = Math.max(...Array.from(div).map(Math.abs));
    ok(`open ground is divergence-free (max |div| ${maxDiv.toFixed(5)} cells/s per cell)`, maxDiv < 0.05);
  }

  // A building in the wind: still air in the near lee, recovering downstream; slowed upwind; walls hold no air.
  {
    const sc = scene(200, 90);
    sc.block(50, 35, 74, 54); // 25 x 20 cells (~10 m x 8 m)
    const r = settle(sc, { seconds: 12 });
    const lee = r.sp(78, 45);
    const far = r.sp(160, 45);
    const up = r.sp(48, 45);
    const free = r.sp(10, 10);
    ok(`near lee is slow (${lee.toFixed(2)} U, claim 0.1-0.5)`, lee < 0.4);
    ok(`the wake recovers downstream (${far.toFixed(2)} U at ~34 m)`, far > 0.75);
    ok(
      `the wake recovers monotonically (${lee.toFixed(2)} < ${r.sp(100, 45).toFixed(2)} < ${far.toFixed(2)})`,
      lee < r.sp(100, 45) && r.sp(100, 45) < far
    );
    ok(`the upwind face is slowed (${up.toFixed(2)} U)`, up < 0.5);
    ok(`open ground away from it is near the driver (${free.toFixed(2)} U)`, free > 0.85);
    let wallMax = 0;
    for (let c = 50; c <= 74; c++)
      for (let rr = 35; rr <= 54; rr++) wallMax = Math.max(wallMax, Math.abs(r.vx[rr * 200 + c]));
    ok('no air inside a wall', wallMax === 0);
  }

  // Rooms under a roof: sealed is still; a lee-only door stays near still; a windward door breathes a short jet;
  // a cross-ventilated room carries a draught.
  {
    const room = (doors) => {
      const sc = scene(160, 70);
      sc.room(50, 20, 79, 49, doors);
      return settle(sc, { seconds: 10 });
    };
    const sealed = room([]);
    let sealedMax = 0;
    for (let c = 51; c < 79; c++) for (let rr = 21; rr < 49; rr++) sealedMax = Math.max(sealedMax, sealed.sp(c, rr));
    ok(`a sealed room is still (max ${sealedMax.toExponential(1)} U)`, sealedMax < 1e-3);
    const lee = room([
      [79, 34],
      [79, 35],
      [79, 36],
    ]);
    ok(`a room open only to the lee stays near still (mid ${lee.sp(65, 35).toFixed(3)} U)`, lee.sp(65, 35) < 0.1);
    const windward = room([
      [50, 34],
      [50, 35],
      [50, 36],
    ]);
    const atDoor = windward.sp(52, 35);
    const deep = windward.sp(70, 35);
    ok(
      `a windward door breathes a jet that fades (door ${atDoor.toFixed(2)} U, 7 m in ${deep.toFixed(2)} U)`,
      atDoor > 0.05 && deep < atDoor && deep < 0.15
    );
    const cross = room([
      [50, 34],
      [50, 35],
      [50, 36],
      [79, 34],
      [79, 35],
      [79, 36],
    ]);
    ok(
      `a cross-ventilated room carries a draught (mid ${cross.sp(65, 35).toFixed(2)} U > dead-end ${windward.sp(65, 35).toFixed(3)} U)`,
      cross.sp(65, 35) > windward.sp(65, 35) + 0.03
    );
  }

  // A gust's energy fades over seconds, not in a frame.
  {
    const sc = scene(60, 30);
    const r = settle(sc, { seconds: 6, driver: (s) => (s < 3 ? U : 0) });
    // the averaging window is the second half (3-6 s): a decaying flow averages well above zero but below U
    const mid = r.sp(30, 15);
    ok(
      `after the wind drops, the air keeps moving and slows (3-6 s mean ${mid.toFixed(2)} U)`,
      mid > 0.15 && mid < 0.9
    );
  }

  // The step planner and the screening.
  {
    const a = planWindFlowSteps(0);
    ok('no time, no steps', a.steps === 0);
    const b = planWindFlowSteps(1 / 60);
    ok('a 60 Hz frame is one step', b.steps === 1 && Math.abs(b.stepSec - 1 / 60) < 1e-9);
    const c = planWindFlowSteps(0.2);
    ok(
      `a slow frame is cut into steps no longer than ${WIND_FLOW_DEFAULTS.maxStepSec} s`,
      c.steps === 4 && c.stepSec <= WIND_FLOW_DEFAULTS.maxStepSec + 1e-9
    );
    const e = escapeField({ sky: new Float32Array([1, 0]), cols: 2, rows: 1, escapeCells: 10, indoorEscapeCells: 20 });
    ok('open sky escapes more than a roof', Math.abs(e[0] - 1 / 100) < 1e-7 && Math.abs(e[1] - 1 / 400) < 1e-7);
    ok('no escape lengths, no screening', escapeField({ cols: 1, rows: 1, escapeCells: 0 }) === null);
  }
}
