/**
 * air.test.mjs — the 3-D air (Lab · Air, 2026-11-09; claims tools/lab/claims/air.md).
 *
 * Pins what the lab measured: the open ground holds the dial and the log-law profile; a paused world holds its air;
 * a house sheds a reversed lee that heals downstream and makes the air climb its windward face; a sealed room is dead
 * still; a windward door makes a churning draft that dies toward the back; a cross-ventilated room carries a draught,
 * a lee-door room almost nothing; walls have height; draftiness lets a shut door leak (and a crack never blows a gale).
 * One scene, 1 cell per 5-ft square, wind toward +x at 10 m/s, settled for 25 s.
 */
import { buildAirGrid, AIR_GRID_DEFAULTS } from '../air-grid.js';
import { createAirState, stepAir, airAt, airMaxDivergence } from '../air-solver.js';
import { airProfile } from '../air-driver.js';
import { parseSceneAirFacts } from '../../foundry/scene-air.js';

const SQ = 150;
const PPM = 98.43;
const U = 10;
const WIND = { directionDeg: 90, speedMps: U, gustiness01: 0 };

const seg = (x1, y1, x2, y2, extra = {}) => ({
  x1: x1 * SQ,
  y1: y1 * SQ,
  x2: x2 * SQ,
  y2: y2 * SQ,
  solid: true,
  blocksExterior: true,
  ...extra,
});
const box = (x, y, w, h, gaps = []) => {
  // Four walls; `gaps` = [{side, from, to, kind}] cut into a side (kind 'open' | 'shut' | 'glass').
  const out = [];
  const sides = { n: [x, y, x + w, y], s: [x, y + h, x + w, y + h], w: [x, y, x, y + h], e: [x + w, y, x + w, y + h] };
  for (const [name, [a, b, c, d]] of Object.entries(sides)) {
    const cut = gaps.find((g) => g.side === name);
    if (!cut) {
      out.push(seg(a, b, c, d));
      continue;
    }
    const vert = a === c;
    const at = (t) => (vert ? [a, t] : [t, b]);
    out.push(seg(...at(vert ? b : a), ...at(cut.from)));
    const kind =
      cut.kind === 'open'
        ? { solid: false }
        : cut.kind === 'shut'
          ? { door: true }
          : cut.kind === 'glass'
            ? { window: true }
            : {};
    out.push(seg(...at(cut.from), ...at(cut.to), kind));
    out.push(seg(...at(cut.to), ...at(vert ? d : c)));
  }
  return out;
};

function buildScene(opts = {}) {
  // Rows (squares): house y 2-10; windward-door room y 14-20; sealed room y 24-30; cross room y 34-40; lee-door y 44-50.
  const roofs = [
    [12, 2, 8, 8],
    [12, 14, 6, 6],
    [12, 24, 6, 6],
    [12, 34, 6, 6],
    [12, 44, 6, 6],
  ];
  const walls = [
    ...box(12, 2, 8, 8),
    ...box(12, 14, 6, 6, [{ side: 'w', from: 16, to: 17, kind: 'open' }]),
    ...box(12, 24, 6, 6, [{ side: 'w', from: 26, to: 27, kind: 'shut' }]),
    ...box(12, 34, 6, 6, [{ side: 'w', from: 36, to: 37, kind: 'open' }]).concat(),
    ...box(12, 44, 6, 6, [{ side: 'e', from: 46, to: 47, kind: 'open' }]),
  ];
  // The cross room also gets an open lee door.
  const crossEast = walls.findIndex((w) => w.x1 === 18 * SQ && w.y1 === 34 * SQ && w.x2 === 18 * SQ);
  walls.splice(crossEast, 1, seg(18, 34, 18, 36), seg(18, 36, 18, 37, { solid: false }), seg(18, 37, 18, 40));
  const inRoof = (x, y) =>
    roofs.some(([a, b, w, h]) => x >= a * SQ && x < (a + w) * SQ && y >= b * SQ && y < (b + h) * SQ);
  return buildAirGrid({
    walls,
    rect: { x: 0, y: 0, w: 60 * SQ, h: 54 * SQ },
    cellPx: SQ,
    pxPerMetre: PPM,
    skyAt: (x, y) => (inRoof(x, y) ? 0 : 1),
    opts,
  });
}

function settle(grid, secs = 25) {
  const st = createAirState(grid);
  for (let s = 0; s < secs * 10; s++) stepAir(st, WIND, 0.1);
  return st;
}

const at = (st, xSq, ySq, z = 1.5) => airAt(st, xSq * SQ, ySq * SQ, z);
const speed = (a) => Math.hypot(a.vx, a.vy) / U;

export function run(t) {
  const { ok } = t;

  // The open ground holds the dial and the log-law profile (no buildings).
  {
    const grid = buildAirGrid({ walls: [], rect: { x: 0, y: 0, w: 30 * SQ, h: 20 * SQ }, cellPx: SQ, pxPerMetre: PPM });
    const st = settle(grid, 6);
    const a = at(st, 15, 10, 1.5);
    ok(`open ground at 1.5 m is the dial (${speed(a).toFixed(3)} U)`, Math.abs(speed(a) - 1) < 0.02);
    const hi = at(st, 15, 10, 10);
    const want = airProfile(10.25);
    ok(
      `10 m runs faster, by the log law (${speed(hi).toFixed(2)} U, want ${want.toFixed(2)})`,
      Math.abs(speed(hi) - want) < 0.03
    );
    ok('no vertical air over open ground', Math.abs(a.vz) < 0.01 * U);
  }

  // A paused world holds its air exactly.
  {
    const grid = buildAirGrid({
      walls: box(10, 5, 4, 4),
      rect: { x: 0, y: 0, w: 24 * SQ, h: 14 * SQ },
      cellPx: SQ,
      pxPerMetre: PPM,
    });
    const st = settle(grid, 3);
    const before = Float32Array.from(st.u);
    stepAir(st, { ...WIND, gustiness01: 1 }, 0);
    ok(
      'dt 0 changes nothing',
      before.every((v, i) => v === st.u[i])
    );
  }

  const grid = buildScene();
  const st = settle(grid);

  // The house: reversed lee, healing wake, air climbing the windward face, over the roof.
  {
    const lee = at(st, 21, 6);
    ok(`the near lee is reversed (along ${(lee.vx / U).toFixed(2)} U)`, lee.vx < -0.05 * U);
    const far = at(st, 44, 6);
    ok(`the wake heals downstream (${speed(far).toFixed(2)} U at 36 m)`, speed(far) > 0.75);
    let rise = 0;
    for (const z of [4, 5.5, 7]) rise = Math.max(rise, at(st, 11.5, 6, z).vz / U);
    ok(`air climbs the windward face (w up to ${rise.toFixed(2)} U)`, rise > 0.1);
    const over = at(st, 16, 6, 7.2);
    ok(`air goes over the roof (${speed(over).toFixed(2)} U at 7 m)`, speed(over) > 0.9);
    ok(`mass is conserved (max |div| ${airMaxDivergence(st).toExponential(1)} /s)`, airMaxDivergence(st) < 0.05);
  }

  // Rooms.
  {
    const door1 = at(st, 12.7, 16.5);
    const back = at(st, 17.5, 16.5);
    ok(`a windward door draws a draft 1 m in (${speed(door1).toFixed(2)} U)`, speed(door1) > 0.1);
    ok(`the back of that room is still (${speed(back).toFixed(2)} U)`, speed(back) < 0.12);
    ok(
      `the draft churns: turbulence by the door ${Math.sqrt(door1.k).toFixed(2)} vs back ${Math.sqrt(back.k).toFixed(2)} m/s`,
      Math.sqrt(door1.k) > 2 * Math.sqrt(back.k)
    );
    let sealedMax = 0;
    for (let x = 12.5; x < 18; x += 1)
      for (let y = 24.5; y < 30; y += 1) sealedMax = Math.max(sealedMax, speed(at(st, x, y)));
    ok(
      `a room with only a shut door is still at draftiness ${AIR_GRID_DEFAULTS.draftiness01} (max ${sealedMax.toFixed(3)} U)`,
      sealedMax < 0.05
    );
    const cross = at(st, 15, 36.5);
    ok(
      `a cross-ventilated room carries a draught (${speed(cross).toFixed(2)} U mid-room)`,
      speed(cross) > 0.2 && cross.vx > 0
    );
    const leeRoom = at(st, 15, 46.5);
    ok(`a lee-door room is nearly still (${speed(leeRoom).toFixed(2)} U)`, speed(leeRoom) < 0.15);
  }

  // Walls have height; doors are holes in the bottom 2 m; draftiness opens shut doors a crack, never walls.
  {
    const g0 = buildScene({ draftiness01: 0 });
    const g1 = buildScene({ draftiness01: 1 });
    const face = (g, iSq, jSq, k) => g.ax[(k * g.ny + (jSq + g.margin)) * (g.nx + 1) + (iSq + g.margin)];
    ok('an open door is open at the ground', face(g0, 12, 16, 0) === 1 && face(g0, 12, 16, 1) === 1);
    ok('wall above an open door', face(g0, 12, 16, 3) === 0);
    ok('above the roof the air is open', face(g0, 12, 16, 6) === 1);
    ok('a shut door is airtight at draftiness 0', face(g0, 12, 26, 0) === 0);
    ok(`a shut door leaks at draftiness 1 (${face(g1, 12, 26, 0).toFixed(2)})`, face(g1, 12, 26, 0) > 0.05);
    ok('a plain wall never leaks', face(g1, 12, 27, 0) === 0);
    const st1 = settle(g1, 15);
    let m = 0;
    for (let x = 12.5; x < 18; x += 1) for (let y = 24.5; y < 30; y += 1) m = Math.max(m, speed(at(st1, x, y)));
    ok(`a crack never blows a gale (shut-door room max ${m.toFixed(3)} U at draftiness 1)`, m < 0.2);
  }

  // The scene's air facts.
  {
    const f = parseSceneAirFacts(
      { air: false, airRoofs: [{ x: 0, y: 0, w: 10, h: 10, heightM: 12 }, { x: 1 }], airDraftiness: 2 },
      100,
      50
    );
    ok(
      'scene air facts parse',
      f.enabled === false && f.roofs.length === 1 && f.roofs[0].x === 100 && f.draftiness01 === 1
    );
    ok('no flags: no opinion', parseSceneAirFacts(undefined).enabled === null);
  }
}
