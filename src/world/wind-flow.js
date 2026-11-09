/**
 * world/wind-flow.js — LIVING WIND, the flow solver's CPU reference (mmp-vm1.1, 2026-11-09).
 *
 * ============================================================================
 * WHY A FLOW SOLVER
 * ============================================================================
 * The analytic field (`wind-field.js#sampleWind`) is a pure function of position and time: a mean wind, a
 * travelling gust envelope and a curl-noise turbulence stack, then GATED by geometry (openness, a 24-cell upwind
 * "shadow" march, a wall deflection). Measured on the MSA Lab (Lab · Wind, rig E) it cannot do what air does
 * around buildings, because nothing in it carries momentum or conserves mass:
 *   - the lee of a building is a rectangle cut out of the field (hard sides, no reversed flow, no eddies);
 *   - a room whose only door faces DOWNWIND fills with the full outdoor wind (0.71 U at 10.5 m/s, streaks to 2 U);
 *   - a dead-end room behind a windward door reads the whole outdoor wind 12 m deep (no outlet, yet a through-jet);
 *   - a gust that passes leaves nothing behind (no energy to dissipate).
 * Those are all MASS and MOMENTUM: air entering a room must leave it, a wake is air that lost its momentum to a
 * wall, a gust is momentum carried downwind. A small incompressible solver on the wind grid gives all of them at
 * once, for a few full-grid passes a frame.
 *
 * ============================================================================
 * THE MODEL (stable fluids on a collocated grid, Stam 1999; Harris, GPU Gems ch. 38; Crane et al., GPU Gems 3
 * ch. 30 for obstacles; Fedkiw et al. 2001 for vorticity confinement)
 * ============================================================================
 * Velocity lives at cell centres, in CELLS PER SECOND inside the solver (h = 1); the caller converts the field's
 * dial units (× 70 m/s × px/m ÷ cell px). Each step:
 *   1. ADVECT   u* = u(x − dt·u(x)), bilinear; solid cells read 0 (the air in a wall has no velocity).
 *   2. FORCE    open-sky air relaxes toward the DRIVER (the analytic free-stream wind: mean + gusts + turbulence,
 *               no geometry) at rate |driver| / L — a wake fills back in over L (~18 m), the measured 5-10 building
 *               heights of a real wake for a two-storey house; roofed air gets no driver and loses momentum at
 *               `indoorDampPerSec`; the outer ring of the grid IS the driver (inflow and outflow).
 *   3. SWIRL    vorticity confinement, ε·(N × ω): the eddies a coarse grid smooths away are given back, so wakes
 *               and doorways shed swirls instead of going laminar.
 *   4. PROJECT  ∇²p = ∇·u* by Jacobi (walls Neumann, grid edge p = 0), u = u* − ∇p: what flows into a room must
 *               flow out, so a dead-end room gets a weak exchange and a cross-ventilated one a draught.
 * Everything is linear in dt and a dt of 0 changes nothing, so a paused world holds its wind exactly.
 *
 * This file is the Node-tested reference; `world/wind-flow-gpu.js` is its TSL port, pass for pass.
 * PURE — no THREE, no Foundry, no TSL (CONVENTIONS §4).
 *
 * @module world/wind-flow
 */

/** Defaults, every one a look or cost knob with its reason. */
export const WIND_FLOW_DEFAULTS = Object.freeze({
  /** Metres over which open-sky air recovers the driver's velocity (a wake's length, a front's sharpness). */
  relaxLengthM: 18,
  /** A floor on the relax rate (1/s), so a light breeze's lee still refills in seconds, not minutes. */
  minRelaxPerSec: 0.25,
  /**
   * A KNOB FOR CLEAR AIR, set equal to the sheltered values (no effect) as measured and shipped. Shorter here would make
   * open ground follow the driver's gust fronts more closely (sharper, stronger gusts) while walls and their shadows
   * keep the solver's own wakes (`relaxLengthM`); the blend reads the baked shelter (wall proximity, upwind shadow).
   * Measured on Lab · Wind with 18 m everywhere: open-field σ/U 0.13-0.29, 3-s gust factor 1.25-1.5, σθ 5-9°.
   */
  clearRelaxLengthM: 18,
  minRelaxClearPerSec: 0.25,
  /** Momentum lost per second by ROOFED air (indoor friction: furniture, walls, no driver). */
  indoorDampPerSec: 1.2,
  /** Vorticity confinement strength (dimensionless, in cells). 0 = laminar. */
  vorticity: 0.6,
  /** Jacobi iterations per step (the projection's accuracy). */
  jacobiIterations: 20,
  /**
   * THE THIRD DIMENSION, in one number. A top-down solver has walls of infinite height, so a walled yard would be
   * a sealed box and no air would ever come down into a wake. Real air goes OVER walls too. Under open sky the
   * pressure equation is screened, `∇²p − p/Lv² = ∇·u`, so a convergence there can spill upward within ~Lv metres
   * instead of being pushed round the whole building; under a roof it cannot (Lv = ∞: what enters must leave by a
   * door). ~1-2 wall heights.
   */
  verticalEscapeM: 6,
  /**
   * The same for ROOFED air: buildings are not airtight (chimneys, gaps, the doors and shutters a map never draws),
   * so a windward door still breathes a jet into a room that has no other opening, fading over a few metres.
   * Larger than the outdoor value: a roof holds most of it in. Infinity = airtight.
   */
  indoorEscapeM: 9,
  /** The longest step one tick integrates; a slower frame takes several. */
  maxStepSec: 1 / 20,
});

const idx = (c, r, cols) => r * cols + c;

/** Bilinear sample of a cell-centred grid at fractional cell coords (centre of cell c at c), clamp to edge. */
export function sampleBilinear(a, cols, rows, x, y) {
  const cx = Math.min(cols - 1, Math.max(0, x));
  const cy = Math.min(rows - 1, Math.max(0, y));
  const c0 = Math.floor(cx);
  const r0 = Math.floor(cy);
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const fx = cx - c0;
  const fy = cy - r0;
  const top = a[idx(c0, r0, cols)] * (1 - fx) + a[idx(c1, r0, cols)] * fx;
  const bot = a[idx(c0, r1, cols)] * (1 - fx) + a[idx(c1, r1, cols)] * fx;
  return top * (1 - fy) + bot * fy;
}

/**
 * 1. ADVECT — semi-Lagrangian self-advection. Solid cells come out 0.
 * @param {{vx: Float32Array, vy: Float32Array, cols: number, rows: number, solid?: Uint8Array, dt: number}} a
 * @returns {{vx: Float32Array, vy: Float32Array}}
 */
export function flowAdvect({ vx, vy, cols, rows, solid = null, dt }) {
  const n = cols * rows;
  const ox = new Float32Array(n);
  const oy = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(c, r, cols);
      if (solid && solid[i]) continue;
      const x = c - dt * vx[i];
      const y = r - dt * vy[i];
      ox[i] = sampleBilinear(vx, cols, rows, x, y);
      oy[i] = sampleBilinear(vy, cols, rows, x, y);
    }
  }
  return { vx: ox, vy: oy };
}

/**
 * 2. FORCE — open-sky air relaxes toward the driver; roofed air is damped; the grid's outer ring is the driver.
 * Rates are exponential (`1 − e^(−k·dt)`), so the result does not depend on how a second is cut into steps.
 *
 * @param {object} a
 * @param {Float32Array} a.vx @param {Float32Array} a.vy - velocity, cells/s (written in place).
 * @param {Float32Array} a.tx @param {Float32Array} a.ty - the driver, cells/s.
 * @param {Float32Array} a.sky - 1 where the cell is under open sky (outdoors, a yard), 0 where roofed.
 * @param {Uint8Array} [a.solid]
 * @param {number} a.cols @param {number} a.rows @param {number} a.dt
 * @param {number} a.relaxCells - `relaxLengthM` in cells.
 * @param {number} [a.minRelaxPerSec] @param {number} [a.indoorDampPerSec]
 * @param {Float32Array} [a.shelter] - 0..1 per cell (1 = beside a wall or deep in its wind shadow). With it, clear air
 *   (shelter 0) relaxes over `clearRelaxCells` with floor `minRelaxClearPerSec`; sheltered air over `relaxCells`.
 * @param {number} [a.clearRelaxCells] @param {number} [a.minRelaxClearPerSec]
 */
export function flowForce({
  vx,
  vy,
  tx,
  ty,
  sky,
  solid = null,
  cols,
  rows,
  dt,
  relaxCells,
  minRelaxPerSec = WIND_FLOW_DEFAULTS.minRelaxPerSec,
  indoorDampPerSec = WIND_FLOW_DEFAULTS.indoorDampPerSec,
  shelter = null,
  clearRelaxCells = relaxCells,
  minRelaxClearPerSec = WIND_FLOW_DEFAULTS.minRelaxClearPerSec,
}) {
  const damp = 1 - Math.exp(-indoorDampPerSec * dt);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(c, r, cols);
      if (solid && solid[i]) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      if (c === 0 || r === 0 || c === cols - 1 || r === rows - 1) {
        vx[i] = tx[i];
        vy[i] = ty[i];
        continue;
      }
      const open = sky ? Math.min(1, Math.max(0, sky[i])) : 1;
      const sh = shelter ? Math.sqrt(Math.min(1, Math.max(0, shelter[i]))) : 1;
      const len = clearRelaxCells + (relaxCells - clearRelaxCells) * sh;
      const floor = minRelaxClearPerSec + (minRelaxPerSec - minRelaxClearPerSec) * sh;
      const k = Math.max(floor, Math.hypot(tx[i], ty[i]) / Math.max(len, 1e-6));
      const relax = (1 - Math.exp(-k * dt)) * open;
      const d = damp * (1 - open);
      vx[i] += (tx[i] - vx[i]) * relax - vx[i] * d;
      vy[i] += (ty[i] - vy[i]) * relax - vy[i] * d;
    }
  }
}

/** Curl ω = ∂v/∂x − ∂u/∂y (central differences; solid or off-grid neighbours read 0). */
export function flowCurl({ vx, vy, cols, rows, solid = null }) {
  const n = cols * rows;
  const w = new Float32Array(n);
  const at = (a, c, r) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return 0;
    const i = idx(c, r, cols);
    return solid && solid[i] ? 0 : a[i];
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      w[idx(c, r, cols)] = 0.5 * (at(vy, c + 1, r) - at(vy, c - 1, r) - (at(vx, c, r + 1) - at(vx, c, r - 1)));
    }
  }
  return w;
}

/**
 * 3. SWIRL — vorticity confinement: f = ε·(N × ω), N = ∇|ω| / |∇|ω||. In place.
 * @param {{vx: Float32Array, vy: Float32Array, cols: number, rows: number, solid?: Uint8Array, epsilon: number, dt: number}} a
 */
export function flowConfineVorticity({ vx, vy, cols, rows, solid = null, epsilon, dt }) {
  if (!(epsilon > 0) || !(dt > 0)) return;
  const w = flowCurl({ vx, vy, cols, rows, solid });
  const aw = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : Math.abs(w[idx(c, r, cols)]));
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = idx(c, r, cols);
      if (solid && solid[i]) continue;
      const gx = 0.5 * (aw(c + 1, r) - aw(c - 1, r));
      const gy = 0.5 * (aw(c, r + 1) - aw(c, r - 1));
      const len = Math.hypot(gx, gy) + 1e-5;
      const nx = gx / len;
      const ny = gy / len;
      vx[i] += epsilon * ny * w[i] * dt;
      vy[i] += -epsilon * nx * w[i] * dt;
    }
  }
}

/** Divergence ∇·u (central differences; solid neighbours read 0, off-grid neighbours read the cell itself). */
export function flowDivergence({ vx, vy, cols, rows, solid = null }) {
  const n = cols * rows;
  const d = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(c, r, cols);
      if (solid && solid[i]) continue;
      const u = (cc, rr, a) => {
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) return a[i];
        const j = idx(cc, rr, cols);
        return solid && solid[j] ? 0 : a[j];
      };
      d[i] = 0.5 * (u(c + 1, r, vx) - u(c - 1, r, vx) + u(c, r + 1, vy) - u(c, r - 1, vy));
    }
  }
  return d;
}

/**
 * 4a. Jacobi for the screened Poisson `∇²p − k·p = div`: p' = (pL + pR + pB + pT − div) / (4 + k); a solid
 * neighbour reads the cell's own p (no flow through walls), off-grid reads 0 (the open edge). `escape[i]` = k =
 * 1/Lv² in cells (open sky), 0 under a roof. Starts from `p0` (warm start) or zeros.
 */
export function flowJacobi({ div, cols, rows, solid = null, iterations, p0 = null, escape = null }) {
  const n = cols * rows;
  let p = p0 ? Float32Array.from(p0) : new Float32Array(n);
  let q = new Float32Array(n);
  for (let it = 0; it < iterations; it++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = idx(c, r, cols);
        if (solid && solid[i]) {
          q[i] = 0;
          continue;
        }
        const pc = p[i];
        const nb = (cc, rr) => {
          if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) return 0;
          const j = idx(cc, rr, cols);
          return solid && solid[j] ? pc : p[j];
        };
        const k = escape ? escape[i] : 0;
        q[i] = (nb(c - 1, r) + nb(c + 1, r) + nb(c, r - 1) + nb(c, r + 1) - div[i]) / (4 + k);
      }
    }
    [p, q] = [q, p];
  }
  return p;
}

/** 4b. u = u* − ∇p (central differences, the same neighbour rules as the Jacobi). In place; solid cells → 0. */
export function flowSubtractGradient({ vx, vy, p, cols, rows, solid = null }) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(c, r, cols);
      if (solid && solid[i]) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      const pc = p[i];
      const nb = (cc, rr) => {
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) return 0;
        const j = idx(cc, rr, cols);
        return solid && solid[j] ? pc : p[j];
      };
      vx[i] -= 0.5 * (nb(c + 1, r) - nb(c - 1, r));
      vy[i] -= 0.5 * (nb(c, r + 1) - nb(c, r - 1));
    }
  }
}

/**
 * One whole step (the order the GPU runs). `driver(i)` → [tx, ty] in cells/s at cell i. Returns the new
 * velocity and the pressure (to warm-start the next step).
 *
 * @param {object} a
 * @param {Float32Array} a.vx @param {Float32Array} a.vy
 * @param {Float32Array} a.tx @param {Float32Array} a.ty - the driver this step, cells/s.
 * @param {Float32Array} [a.sky] @param {Uint8Array} [a.solid]
 * @param {number} a.cols @param {number} a.rows @param {number} a.dt - seconds (0 = paused: unchanged).
 * @param {number} a.relaxCells
 * @param {Float32Array} [a.p0] - last step's pressure.
 * @param {object} [a.opts] - overrides of {@link WIND_FLOW_DEFAULTS}.
 */
export function stepWindFlowReference({
  vx,
  vy,
  tx,
  ty,
  sky = null,
  solid = null,
  cols,
  rows,
  dt,
  relaxCells,
  p0 = null,
  opts = {},
}) {
  const o = { ...WIND_FLOW_DEFAULTS, ...opts };
  if (!(dt > 0))
    return {
      vx: Float32Array.from(vx),
      vy: Float32Array.from(vy),
      p: p0 ? Float32Array.from(p0) : new Float32Array(cols * rows),
    };
  const adv = flowAdvect({ vx, vy, cols, rows, solid, dt });
  flowForce({
    vx: adv.vx,
    vy: adv.vy,
    tx,
    ty,
    sky,
    solid,
    cols,
    rows,
    dt,
    relaxCells,
    minRelaxPerSec: o.minRelaxPerSec,
    indoorDampPerSec: o.indoorDampPerSec,
  });
  flowConfineVorticity({ vx: adv.vx, vy: adv.vy, cols, rows, solid, epsilon: o.vorticity, dt });
  const div = flowDivergence({ vx: adv.vx, vy: adv.vy, cols, rows, solid });
  const escape = escapeField({
    sky,
    cols,
    rows,
    escapeCells: o.verticalEscapeCells ?? 0,
    indoorEscapeCells: o.indoorEscapeCells ?? 0,
  });
  const p = flowJacobi({ div, cols, rows, solid, iterations: o.jacobiIterations, p0, escape });
  flowSubtractGradient({ vx: adv.vx, vy: adv.vy, p, cols, rows, solid });
  return { vx: adv.vx, vy: adv.vy, p };
}

/**
 * The screening per cell: 1/Lv² (cells), mixing the open-sky and the roofed value by `sky`. A length of 0 (or
 * absent) means no escape there (strictly 2-D). Both 0 → null (no screening anywhere).
 * @param {{sky?: Float32Array|null, cols: number, rows: number, escapeCells: number, indoorEscapeCells?: number}} a
 * @returns {Float32Array|null}
 */
export function escapeField({ sky = null, cols, rows, escapeCells, indoorEscapeCells = 0 }) {
  const kOut = escapeCells > 0 ? 1 / (escapeCells * escapeCells) : 0;
  const kIn = indoorEscapeCells > 0 ? 1 / (indoorEscapeCells * indoorEscapeCells) : 0;
  if (kOut === 0 && kIn === 0) return null;
  const out = new Float32Array(cols * rows);
  for (let i = 0; i < out.length; i++) {
    const open = sky ? Math.min(1, Math.max(0, sky[i])) : 1;
    out[i] = open * kOut + (1 - open) * kIn;
  }
  return out;
}

/**
 * How many steps a tick of `dtSec` takes, and how long each is — never longer than `maxStepSec`, so a slow frame
 * stays stable and a fast one costs one step.
 * @param {number} dtSec @param {number} [maxStepSec]
 * @returns {{steps: number, stepSec: number}}
 */
export function planWindFlowSteps(dtSec, maxStepSec = WIND_FLOW_DEFAULTS.maxStepSec) {
  if (!(dtSec > 0)) return { steps: 0, stepSec: 0 };
  const steps = Math.min(4, Math.max(1, Math.ceil(dtSec / maxStepSec - 1e-9)));
  return { steps, stepSec: Math.min(dtSec, steps * maxStepSec) / steps };
}

/**
 * Field dial units → solver cells/s, and back: × 70 m/s × px/m ÷ cell px.
 * @param {number} pixelsPerMetre @param {number} cellSizePx @param {number} [mpsPerUnit=70]
 */
export function windFlowCellsPerSecPerUnit(pixelsPerMetre, cellSizePx, mpsPerUnit = 70) {
  return (mpsPerUnit * pixelsPerMetre) / Math.max(cellSizePx, 1e-6);
}
