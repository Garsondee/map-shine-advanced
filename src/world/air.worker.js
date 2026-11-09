/**
 * world/air.worker.js — THE AIR, OFF THE MAIN THREAD (2026-11-09). Hosts `world/air-solver.js` on its own core so
 * the 3-D air costs the frame nothing; `vt/air-runtime.js` drives it.
 *
 * Messages in:
 *   {type:'init', id, geometry}  — build the grid (`buildAirGrid` inputs, with the sky as a sampled grid and the
 *                                  authored roofs as rects) and a still state.
 *   {type:'step', id, wind, dtSec, simTimeSec, layers} — advance by the SIM clock's dt (0 = paused: nothing moves),
 *                                  then post the ground layer (and every layer when `layers`).
 * Messages out:
 *   {type:'ready', id, grid}     — the grid's shape (nx, ny, nz, origin, cell, layer bounds), its lids and walls for
 *                                  the wind view.
 *   {type:'field', id, simTimeSec, ground, all?, stepMs, substeps} — Float32Arrays, transferred:
 *                                  ground = nx·ny × 4 (vx, vy, vz m/s, k m²/s²) at the 1-2 m layer;
 *                                  all = nx·ny·nz × 4, layer-major (only when asked: the wind view).
 *
 * No clock of its own: dt always comes from the caller's sim clock. `stepMs` is measured with the worker's own
 * `performance` purely as a cost readout.
 *
 * @module world/air.worker
 */
import { buildAirGrid } from './air-grid.js';
import { createAirState, stepAir, primeAir } from './air-solver.js';

/** The layer every effect reads: 1-2 m, where the dial means what it says. */
export const AIR_GROUND_LAYER = 1;

let state = null;
let gridId = null;

function skySampler(sky) {
  if (!sky || !sky.data) return null;
  const { x, y, width, height, w, h, data } = sky;
  return (px, py) => {
    const tx = Math.floor(((px - x) / width) * w);
    const ty = Math.floor(((py - y) / height) * h);
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return 1;
    return data[ty * w + tx] / 255;
  };
}

function roofSampler(roofs) {
  if (!Array.isArray(roofs) || roofs.length === 0) return null;
  return (px, py) => {
    for (const r of roofs) if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return r.heightM;
    return null;
  };
}

function pack(st, k) {
  const { nx, ny, ax, ay, az } = st.grid;
  const NU = nx + 1;
  const NXY = nx * ny;
  const out = new Float32Array(NXY * 4);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const fu = (k * ny + j) * NU + i;
      const fv = (k * (ny + 1) + j) * nx + i;
      // Flux-equivalent (aperture × speed): what the room's air does, not the speed in a crack.
      out[c * 4] = 0.5 * (st.u[fu] * ax[fu] + st.u[fu + 1] * ax[fu + 1]);
      out[c * 4 + 1] = 0.5 * (st.v[fv] * ay[fv] + st.v[fv + nx] * ay[fv + nx]);
      out[c * 4 + 2] = 0.5 * (st.w[k * NXY + c] * az[k * NXY + c] + st.w[(k + 1) * NXY + c] * az[(k + 1) * NXY + c]);
      out[c * 4 + 3] = st.k[k * NXY + c];
    }
  }
  return out;
}

function packAll(st) {
  const { nx, ny, nz } = st.grid;
  const NXY = nx * ny;
  const out = new Float32Array(NXY * nz * 4);
  for (let k = 0; k < nz; k++) out.set(pack(st, k), k * NXY * 4);
  return out;
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const g = m.geometry;
      const grid = buildAirGrid({
        walls: g.walls,
        rect: g.rect,
        cellPx: g.cellPx,
        pxPerMetre: g.pxPerMetre,
        skyAt: skySampler(g.sky),
        roofHeightAt: roofSampler(g.roofs),
        opts: g.gridOpts ?? {},
      });
      state = createAirState(grid, g.solverOpts ?? {});
      gridId = m.id;
      self.postMessage({
        type: 'ready',
        id: m.id,
        grid: {
          nx: grid.nx,
          ny: grid.ny,
          nz: grid.nz,
          cellPx: grid.cellPx,
          originX: grid.originX,
          originY: grid.originY,
          h: grid.h,
          zb: Array.from(grid.zb),
          lid: grid.lid,
          ax: grid.ax,
          ay: grid.ay,
          doors: state.doors.length,
        },
      });
      return;
    }
    if (m.type === 'step') {
      if (!state || m.id !== gridId) return;
      const t0 = self.performance?.now?.() ?? 0;
      const before = state.stats.substeps;
      // A paused world (dt 0) still needs a first field: start from the weather, then hold it.
      if (!state.primed) primeAir(state, m.wind);
      stepAir(state, m.wind, m.dtSec);
      const stepMs = (self.performance?.now?.() ?? 0) - t0;
      const ground = pack(state, AIR_GROUND_LAYER);
      const all = m.layers ? packAll(state) : null;
      const transfer = all ? [ground.buffer, all.buffer] : [ground.buffer];
      self.postMessage(
        {
          type: 'field',
          id: m.id,
          simTimeSec: m.simTimeSec,
          ground,
          all,
          stepMs,
          substeps: state.stats.substeps - before,
        },
        transfer
      );
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m?.id, message: String(err?.message ?? err) });
  }
};
