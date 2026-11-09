#!/usr/bin/env node
/**
 * tools/lab/air-bench.mjs — the 3-D air on Lab · Air, OFFLINE (Node): no rig, no GPU. Builds the lab's air grid from
 * `air-spec.mjs`, runs `world/air-solver.js` for a while at a dial, times the steps, and writes pictures (plan views at
 * any height, side slices along the wind, turbulence) plus a probe table against `claims/air.md`.
 *
 *   node tools/lab/air-bench.mjs [--mps 10.5] [--secs 60] [--avg 30] [--gust 1] [--out tools/lab/out/air] [--cells 1]
 *        [--set key=value,...]   (solver/grid option overrides, e.g. relaxGroundM=60,sorIterations=40)
 *
 * Pictures (PNG): plan-z<layer>.png (speed colour, arrows), tke-z1.png, slice-<name>.png (x–z sections).
 *
 * @module tools/lab/air-bench
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { buildAirGrid } from '../../src/world/air-grid.js';
import { createAirState, stepAir, airLayer, airMaxDivergence } from '../../src/world/air-solver.js';
import { AIR_SIZE, AIR_PX_PER_METRE, airWallSegments, airRoofs, airProbes, airPlots } from './air-spec.mjs';
import { GRID } from './lab-spec.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const MPS = Number(opt('mps', 10.5));
const SECS = Number(opt('secs', 60));
const AVG = Number(opt('avg', 30));
const GUST = Number(opt('gust', 0));
const CELLS = Number(opt('cells', 1));
const DT = Number(opt('dt', 0.1));
const OUT = path.resolve(opt('out', 'tools/lab/out/air'));
const SET = Object.fromEntries(
  (opt('set', '') || '')
    .split(',')
    .filter(Boolean)
    .map((kv) => {
      const [k, v] = kv.split('=');
      return [k, Number(v)];
    })
);
fs.mkdirSync(OUT, { recursive: true });

// ---- geometry -------------------------------------------------------------------------------------------------
export function labAirGrid(cellsPerSquare = 1, opts = {}) {
  const roofs = airRoofs();
  const inRoof = (x, y) => roofs.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  return buildAirGrid({
    walls: airWallSegments(),
    rect: { x: 0, y: 0, w: AIR_SIZE.w, h: AIR_SIZE.h },
    cellPx: GRID / cellsPerSquare,
    pxPerMetre: AIR_PX_PER_METRE,
    skyAt: (x, y) => (inRoof(x, y) ? 0 : 1),
    roofHeightAt: (x, y) => inRoof(x, y)?.heightM ?? null,
    opts,
  });
}

// ---- run ------------------------------------------------------------------------------------------------------
const grid = labAirGrid(CELLS, SET);
const st = createAirState(grid, { ...SET, clock: () => Number(process.hrtime.bigint()) / 1e6 });
const wind = { directionDeg: 90, speedMps: MPS, gustiness01: GUST };
const NXY = grid.nx * grid.ny;
const sum = { vx: [], vy: [], vz: [], k: [] };
for (let k = 0; k < grid.nz; k++) {
  sum.vx.push(new Float64Array(NXY));
  sum.vy.push(new Float64Array(NXY));
  sum.vz.push(new Float64Array(NXY));
  sum.k.push(new Float64Array(NXY));
}
let nAvg = 0;
const steps = Math.round(SECS / DT);
const avgFrom = Math.round((SECS - AVG) / DT);
const times = [];
for (let s = 0; s < steps; s++) {
  const t0 = process.hrtime.bigint();
  stepAir(st, wind, DT);
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  if (s >= avgFrom) {
    for (let k = 0; k < grid.nz; k++) {
      const L = airLayer(st, k);
      for (let c = 0; c < NXY; c++) {
        sum.vx[k][c] += L.vx[c];
        sum.vy[k][c] += L.vy[c];
        sum.vz[k][c] += L.vz[c];
        sum.k[k][c] += L.tke[c];
      }
    }
    nAvg++;
  }
}
const mean = (arr, k, c) => arr[k][c] / Math.max(1, nAvg);
times.sort((a, b) => a - b);
const med = times[Math.floor(times.length / 2)];
const p95 = times[Math.floor(times.length * 0.95)];
console.log(
  `grid ${grid.nx}x${grid.ny}x${grid.nz} = ${grid.nx * grid.ny * grid.nz} cells (h ${grid.h.toFixed(2)} m), ${steps} steps of ${DT}s at ${MPS} m/s gust ${GUST}`
);
const ph = st.stats.phaseMs ?? {};
console.log(
  'phase ms per step:',
  Object.fromEntries(Object.entries(ph).map(([k, v]) => [k, +(v / st.stats.steps).toFixed(1)]))
);
console.log(
  `step ms: median ${med.toFixed(1)}, p95 ${p95.toFixed(1)}, substeps/step ${(st.stats.substeps / st.stats.steps).toFixed(2)}, max div ${airMaxDivergence(st).toExponential(2)} 1/s`
);

// ---- probes ---------------------------------------------------------------------------------------------------
const cellOf = (xPx, yPx) => {
  const i = Math.floor((xPx - grid.originX) / grid.cellPx);
  const j = Math.floor((yPx - grid.originY) / grid.cellPx);
  return j * grid.nx + i;
};
const layerOfZ = (z) => {
  let k = 0;
  while (k < grid.nz - 1 && z >= grid.zb[k + 1]) k++;
  return k;
};
const rows = [];
const ground = 1; // the 1-2 m layer
for (const p of airProbes()) {
  const c = cellOf(p.x, p.y);
  const k = p.z != null ? layerOfZ(p.z) : ground;
  const vx = mean(sum.vx, k, c);
  const vy = mean(sum.vy, k, c);
  const vz = mean(sum.vz, k, c);
  const tk = mean(sum.k, k, c);
  const roofK = layerOfZ(7);
  rows.push({
    plot: p.plot,
    probe: p.name,
    speed: Math.hypot(vx, vy) / MPS,
    along: vx / MPS,
    across: vy / MPS,
    w: vz / MPS,
    turb: Math.sqrt((2 * tk) / 3) / MPS,
    aloft: Math.hypot(mean(sum.vx, roofK, c), mean(sum.vy, roofK, c)) / MPS,
    wAloft: mean(sum.vz, layerOfZ(4), c) / MPS,
    indoor: grid.indoor[k * NXY + c] === 1,
  });
}
const f2 = (x) => (x >= 0 ? ' ' : '') + x.toFixed(2);
console.log('\nplot  probe          speed/U along/U  w/U   turb/U  7m/U  w4m/U  in');
for (const r of rows) {
  console.log(
    `${r.plot.padEnd(5)} ${r.probe.padEnd(14)} ${f2(r.speed)}  ${f2(r.along)}  ${f2(r.w)}  ${f2(r.turb)}  ${f2(r.aloft)}  ${f2(r.wAloft)}  ${r.indoor ? 'in' : ''}`
  );
}
// Vertical profile in the open.
const openC = cellOf(6 * GRID, 6 * GRID);
console.log(
  '\nopen-field profile (z m: speed/U):',
  [...grid.zc]
    .map((z, k) => `${z.toFixed(1)}: ${(Math.hypot(mean(sum.vx, k, openC), mean(sum.vy, k, openC)) / MPS).toFixed(2)}`)
    .join('  ')
);
fs.writeFileSync(
  path.join(OUT, `probes-${MPS}mps-g${GUST}.json`),
  JSON.stringify({ mps: MPS, gust: GUST, secs: SECS, avg: AVG, med, p95, rows }, null, 1)
);

// ---- pictures -------------------------------------------------------------------------------------------------
function canvas(w, h) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(255);
  const set = (x, y, r, g, b, a = 255) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    const t = a / 255;
    png.data[o] = png.data[o] * (1 - t) + r * t;
    png.data[o + 1] = png.data[o + 1] * (1 - t) + g * t;
    png.data[o + 2] = png.data[o + 2] * (1 - t) + b * t;
    png.data[o + 3] = 255;
  };
  const fill = (x0, y0, x1, y1, col) => {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) set(x, y, ...col);
  };
  const line = (x0, y0, x1, y1, col) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= n; s++) set(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n, ...col);
  };
  const arrow = (x, y, dx, dy, col) => {
    line(x, y, x + dx, y + dy, col);
    const L = Math.hypot(dx, dy);
    if (L < 2) return;
    const ux = dx / L;
    const uy = dy / L;
    const hx = x + dx;
    const hy = y + dy;
    const a = Math.min(4, L * 0.4);
    line(hx, hy, hx - a * (ux + uy * 0.6), hy - a * (uy - ux * 0.6), col);
    line(hx, hy, hx - a * (ux - uy * 0.6), hy - a * (uy + ux * 0.6), col);
  };
  const save = (file) => fs.writeFileSync(file, PNG.sync.write(png));
  return { set, fill, line, arrow, save, w, h };
}
/** Speed ratio → colour: still = deep blue, the open wind = pale, faster = orange → red. */
function ramp(r) {
  const stops = [
    [0, [20, 30, 90]],
    [0.25, [40, 90, 170]],
    [0.6, [110, 180, 210]],
    [1.0, [235, 235, 225]],
    [1.3, [250, 180, 80]],
    [1.7, [220, 60, 40]],
    [2.2, [120, 0, 40]],
  ];
  r = Math.max(0, Math.min(2.2, r));
  for (let s = 1; s < stops.length; s++) {
    if (r <= stops[s][0]) {
      const [a, ca] = stops[s - 1];
      const [b, cb] = stops[s];
      const t = (r - a) / (b - a);
      return ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
    }
  }
  return stops[stops.length - 1][1];
}
function drawWallsPlan(cv, S) {
  // Faces closed at this layer: dark lines.
}
function plan(k, file, mode = 'speed') {
  const S = 9;
  const cv = canvas(grid.nx * S, grid.ny * S);
  const ref = MPS * (mode === 'speed' ? st.prof[k] : 1);
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const c = j * grid.nx + i;
      const vx = mean(sum.vx, k, c);
      const vy = mean(sum.vy, k, c);
      let col;
      if (mode === 'speed') col = ramp(Math.hypot(vx, vy) / ref);
      else if (mode === 'tke') col = ramp((Math.sqrt((2 * mean(sum.k, k, c)) / 3) / MPS) * 4);
      else {
        const wz = mean(sum.vz, k, c) / MPS;
        const t = Math.max(-1, Math.min(1, wz * 3));
        col = t >= 0 ? [235 - 20 * t, 235 - 150 * t, 225 - 190 * t] : [235 + 0 * t, 235 + 120 * t, 225 + 10 * t];
      }
      if (grid.indoor[k * NXY + c]) col = col.map((v) => Math.round(v * 0.82));
      cv.fill(i * S, j * S, (i + 1) * S, (j + 1) * S, col);
    }
  }
  // Walls at this layer.
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i <= grid.nx; i++) {
      const a = grid.ax[(k * grid.ny + j) * (grid.nx + 1) + i];
      if (a < 1) cv.fill(i * S - 1, j * S, i * S + 1, (j + 1) * S, [0, 0, 0, Math.round(255 * (1 - a))]);
    }
  }
  for (let j = 0; j <= grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const a = grid.ay[(k * (grid.ny + 1) + j) * grid.nx + i];
      if (a < 1) cv.fill(i * S, j * S - 1, (i + 1) * S, j * S + 1, [0, 0, 0, Math.round(255 * (1 - a))]);
    }
  }
  // Arrows every cell, length ∝ speed.
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const c = j * grid.nx + i;
      const vx = mean(sum.vx, k, c) / ref;
      const vy = mean(sum.vy, k, c) / ref;
      const L = Math.hypot(vx, vy);
      if (L < 0.02) continue;
      const s = (Math.min(L, 2) / L) * S * 0.55;
      cv.arrow(i * S + S / 2 - (vx * s) / 2, j * S + S / 2 - (vy * s) / 2, vx * s, vy * s, [20, 20, 20]);
    }
  }
  cv.save(path.join(OUT, file));
}
/** x–z section along grid row j (world square row), heights to scale. */
function slice(rowSq, file, x0Sq = 0, x1Sq = 100) {
  const j = Math.floor((rowSq * GRID + GRID / 2 - grid.originY) / grid.cellPx);
  const i0 = Math.max(0, Math.floor((x0Sq * GRID - grid.originX) / grid.cellPx));
  const i1 = Math.min(grid.nx, Math.ceil((x1Sq * GRID - grid.originX) / grid.cellPx));
  const SX = 10; // px per cell horizontally
  const PM = SX / grid.h; // px per metre (to scale)
  const H = Math.ceil(grid.zb[grid.nz] * PM);
  const cv = canvas((i1 - i0) * SX, H);
  for (let i = i0; i < i1; i++) {
    const c = j * grid.nx + i;
    for (let k = 0; k < grid.nz; k++) {
      const vx = mean(sum.vx, k, c);
      const sp = Math.hypot(vx, mean(sum.vz, k, c)) / (MPS * st.prof[k]);
      let col = ramp(sp);
      if (grid.indoor[k * NXY + c]) col = col.map((v) => Math.round(v * 0.82));
      cv.fill((i - i0) * SX, H - grid.zb[k + 1] * PM, (i - i0 + 1) * SX, H - grid.zb[k] * PM, col);
    }
    // Lid.
    if (grid.lid[c] > 0)
      cv.fill(
        (i - i0) * SX,
        H - grid.zb[grid.lid[c]] * PM - 1,
        (i - i0 + 1) * SX,
        H - grid.zb[grid.lid[c]] * PM + 2,
        [0, 0, 0]
      );
  }
  // Walls (x-faces at this row), to their height.
  for (let i = i0; i <= i1; i++) {
    for (let k = 0; k < grid.nz; k++) {
      const a = grid.ax[(k * grid.ny + j) * (grid.nx + 1) + i];
      if (a < 1)
        cv.fill((i - i0) * SX - 1, H - grid.zb[k + 1] * PM, (i - i0) * SX + 2, H - grid.zb[k] * PM, [
          0,
          0,
          0,
          Math.round(255 * (1 - a)),
        ]);
    }
  }
  for (let i = i0; i < i1; i++) {
    const c = j * grid.nx + i;
    for (let k = 0; k < grid.nz; k++) {
      const u = mean(sum.vx, k, c) / MPS;
      const w = mean(sum.vz, k, c) / MPS;
      const L = Math.hypot(u, w);
      if (L < 0.02) continue;
      const s = (Math.min(L, 2) / L) * SX * 0.6;
      cv.arrow((i - i0) * SX + SX / 2 - (u * s) / 2, H - grid.zc[k] * PM + (w * s) / 2, u * s, -w * s, [20, 20, 20]);
    }
  }
  cv.save(path.join(OUT, file));
}

plan(1, 'plan-z1.png');
plan(4, 'plan-z4.png');
plan(5, 'plan-z5.png');
plan(1, 'tke-z1.png', 'tke');
plan(3, 'w-z3.png', 'w');
slice(6, 'slice-house.png', 4, 70);
slice(18, 'slice-tower.png', 4, 90);
slice(30, 'slice-shed-wall.png', 4, 96);
slice(43, 'slice-funnel.png', 14, 70);
slice(54, 'slice-rooms.png', 4, 80);
slice(66, 'slice-tunnel.png', 4, 80);
slice(80, 'slice-tworoom-street.png', 4, 76);
slice(99, 'slice-manor-corridor.png', 4, 70);
console.log(`\npictures in ${OUT}`);
void airPlots;
void drawWallsPlan;
