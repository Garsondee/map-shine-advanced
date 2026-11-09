/**
 * world/air-solver.js — THE AIR, STEPPED: a coarse 3-D incompressible flow with a turbulence-energy field
 * (2026-11-09, Lab · Air; claims `tools/lab/claims/air.md`, geometry `world/air-grid.js`, weather `world/air-driver.js`).
 *
 * ============================================================================
 * ONE STEP
 * ============================================================================
 *   1. ADVECT  momentum (u on x-faces, v on y-faces, w on z-faces) and turbulence energy k (cells), semi-Lagrangian.
 *              The back-trace MARCHES and stops at the first closed face it would cross, and the interpolation never
 *              blends two samples split by a wall or a roof (it keeps the one on the departure's side). That is what
 *              keeps outdoor wind from leaking through a wall into a room (her taste: nothing leaks through walls).
 *   2. FORCE   open-sky air relaxes toward the weather (the driver: dial × log-law profile × gust fronts) at rate
 *              |U| / L(z) — gently near the ground (a wake can live there), firmly aloft (the free stream); roofed air
 *              gets no weather and loses momentum to the room (furniture, walls).
 *   3. DOORS   a doorway's DRAFT. One opening cannot carry a net flow into a closed room (what enters must leave), and
 *              the eddies and gust buffeting that make the real draft are far smaller than a cell. So each open door
 *              gets the building-physics single-sided exchange (Warren & Parkins 1985; Larsen & Heiselberg 2008): a
 *              zero-net in/out flow, in through the top of the door and out along the floor, sized by the wind
 *              approaching the door and the outdoor turbulence. The solver carries it into the room as a loop.
 *   4. MIX     vertical turbulent mixing of the departure from the weather's shape (implicit, per column): the fast air
 *              above a wake is what refills it, so wakes heal from the top and a taller building's lasts longer.
 *   5. PROJECT ∇·(A∇φ) = ∇·(A u*) on the faces' open areas (red-black SOR, warm-started), u = u* − ∇φ: what enters a
 *              room must leave; air piled against a windward face climbs it and spills over the roof; a gap between
 *              two buildings speeds the air up; a dead-end room refuses a through-jet.
 *   6. TURBULENCE  k is made by the resolved shear beyond the open ground's own (doors, corners, roof edges, wakes),
 *              held at the open ground's level under open sky (the weather's gustiness), carried by the air, spread
 *              by turbulent diffusion through open faces only, and burned off at k^1.5 / l. Effects add swirl of size
 *              sqrt(2k/3): a door makes a turbulent draft, not a hose.
 * A dt of 0 changes nothing (a paused world holds its air exactly).
 *
 * Units: metres, seconds, m/s. Indices: cell (i,j,k) = (k·ny + j)·nx + i; u-face (i ∈ 0..nx, between cells i−1 and
 * i) = (k·ny + j)·(nx+1) + i; v-face (j ∈ 0..ny) = (k·(ny+1) + j)·nx + i; w-face (k ∈ 0..nz, below cell k)
 * = (k·ny + j)·nx + i. Inner loops are flat (no closures): this runs ~10 times a second in a worker.
 *
 * PURE — no THREE, no Foundry, no clock (the caller passes dt from the sim clock). Node-tested.
 *
 * @module world/air-solver
 */
import { airProfile, airGustColumns, stepAirDriver, AIR_DRIVER_DEFAULTS } from './air-driver.js';
import { windFlowVector } from './wind-bake.js';
import { airSealedCells } from './air-grid.js';

export const AIR_SOLVER_DEFAULTS = Object.freeze({
  /** Relax length near the ground and at the top of the box, m (geometric in between). */
  relaxGroundM: 45,
  relaxTopM: 5,
  /** A floor on the relax rate, 1/s, so a breath of wind still settles. */
  minRelaxPerSec: 0.03,
  /** Momentum lost per second by roofed air. */
  indoorDampPerSec: 0.5,
  /** Pressure solve (warm-started, so a few sweeps a step hold the field). */
  sorIterations: 12,
  sorOmega: 1.8,
  /** Turbulent viscosity ν = cNu · l · sqrt(k); mixing length l = clamp(κ z, lMin, lMax). */
  cNu: 0.55,
  kappa: 0.41,
  lMinM: 0.7,
  lMaxM: 3,
  /** Dissipation ε = cDiss · k^1.5 / l. */
  cDiss: 0.16,
  /** Turbulent diffusion of k is ν / sigmaK. */
  sigmaK: 1,
  /** Door exchange: q = doorApproach · (wind approaching the door) + doorTurbulence · σ outside. */
  doorApproach: 0.4,
  doorTurbulence: 0.45,
  /** How fast a doorway's exchange is driven toward q, 1/s. */
  doorRatePerSec: 10,
  /** Cells out from a door at which "the wind approaching it" is read. */
  doorApproachCells: 2,
  /** How many cells into the room the doorway's jet is pushed (fading). */
  doorJetCells: 3,
  /**
   * A step is split so the air travels at most this many cells per sub-step. The back-trace marches and stops at walls,
   * so long sub-steps stay wall-tight; too many sub-steps made a slow step slower (a spiral seen live, 2026-11-09).
   */
  maxCellsPerSubstep: 6,
  maxSubsteps: 2,
});

/**
 * Allocate the air's state for a grid (all still) and precompute the pressure coefficients, the interpolation links,
 * the faces' outdoor weights and the doorways. Rebuild on a geometry change (walls, doors, roofs).
 * @param {object} grid - `buildAirGrid`'s result.
 * @param {object} [opts] - overrides of {@link AIR_SOLVER_DEFAULTS} and {@link AIR_DRIVER_DEFAULTS}; `clock` (a
 *   function returning ms) makes {@link stepAir} time its phases into `stats.phaseMs` (benches only).
 */
export function createAirState(grid, opts = {}) {
  const o = { ...AIR_DRIVER_DEFAULTS, ...AIR_SOLVER_DEFAULTS, ...opts };
  const { nx, ny, nz, h, dz, zc, zb, ax, ay, az, indoor } = grid;
  const nC = nx * ny * nz;
  const nU = (nx + 1) * ny * nz;
  const nV = nx * (ny + 1) * nz;
  const nW = nx * ny * (nz + 1);
  const NXY = nx * ny;
  const NU = nx + 1;

  // Pressure coefficients A/d per cell face (0 for a closed face); a neighbour off the grid (sides, top) is φ = 0.
  const cW = new Float32Array(nC);
  const cE = new Float32Array(nC);
  const cS = new Float32Array(nC);
  const cN = new Float32Array(nC);
  const cD = new Float32Array(nC);
  const cU = new Float32Array(nC);
  const inv = new Float32Array(nC);
  const h2 = h * h;
  for (let k = 0; k < nz; k++) {
    const dUp = k < nz - 1 ? zc[k + 1] - zc[k] : zb[nz] - zc[k];
    const dDn = k > 0 ? zc[k] - zc[k - 1] : 1;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i;
        cW[c] = dz[k] * ax[(k * ny + j) * NU + i];
        cE[c] = dz[k] * ax[(k * ny + j) * NU + i + 1];
        cS[c] = dz[k] * ay[(k * (ny + 1) + j) * nx + i];
        cN[c] = dz[k] * ay[(k * (ny + 1) + j + 1) * nx + i];
        cD[c] = k > 0 ? (h2 * az[k * NXY + j * nx + i]) / dDn : 0;
        cU[c] = (h2 * az[(k + 1) * NXY + j * nx + i]) / dUp;
        const s = cW[c] + cE[c] + cS[c] + cN[c] + cD[c] + cU[c];
        inv[c] = s > 0 ? 1 / s : 0;
      }
    }
  }

  // Interpolation links: are two neighbouring samples on the same side of every wall and roof?
  const uLinkY = new Uint8Array(nU); // u(i,j,k) – u(i,j+1,k)
  const uLinkZ = new Uint8Array(nU); // u(i,j,k) – u(i,j,k+1)
  const vLinkX = new Uint8Array(nV); // v(i,j,k) – v(i+1,j,k)
  const vLinkZ = new Uint8Array(nV);
  const wLinkX = new Uint8Array(nW); // w(i,j,k) – w(i+1,j,k)
  const wLinkY = new Uint8Array(nW);
  const AY = (i, j, k) => (i < 0 || i >= nx ? -1 : ay[(k * (ny + 1) + j) * nx + i]);
  const AX = (i, j, k) => (j < 0 || j >= ny ? -1 : ax[(k * ny + j) * NU + i]);
  const AZ = (i, j, k) => (i < 0 || j < 0 || i >= nx || j >= ny ? -1 : az[k * NXY + j * nx + i]);
  const pair = (a, b) => (a < 0 ? b > 0.25 : b < 0 ? a > 0.25 : 0.5 * (a + b) > 0.25);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const f = (k * ny + j) * NU + i;
        if (j < ny - 1) uLinkY[f] = pair(AY(i - 1, j + 1, k), AY(i, j + 1, k)) ? 1 : 0;
        if (k < nz - 1) uLinkZ[f] = pair(AZ(i - 1, j, k + 1), AZ(i, j, k + 1)) ? 1 : 0;
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = (k * (ny + 1) + j) * nx + i;
        if (i < nx - 1) vLinkX[f] = pair(AX(i + 1, j - 1, k), AX(i + 1, j, k)) ? 1 : 0;
        if (k < nz - 1) vLinkZ[f] = pair(AZ(i, j - 1, k + 1), AZ(i, j, k + 1)) ? 1 : 0;
      }
    }
  }
  for (let k = 0; k <= nz; k++) {
    const kl = Math.max(0, k - 1);
    const kh = Math.min(nz - 1, k);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = k * NXY + j * nx + i;
        if (i < nx - 1) wLinkX[f] = pair(AX(i + 1, j, kl), AX(i + 1, j, kh)) ? 1 : 0;
        if (j < ny - 1) wLinkY[f] = pair(AY(i, j + 1, kl), AY(i, j + 1, kh)) ? 1 : 0;
      }
    }
  }

  // Outdoor weights: cells (1 under open sky), faces (mean of their two cells; off-grid counts as open sky).
  const sealed = airSealedCells(grid);
  grid.free = airFreeColumns(grid);
  const outC = new Float32Array(nC);
  for (let c = 0; c < nC; c++) outC[c] = indoor[c] ? 0 : 1;
  const outU = new Float32Array(nU);
  const outV = new Float32Array(nV);
  const outW = new Float32Array(nW);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const a = i > 0 ? outC[(k * ny + j) * nx + i - 1] : 1;
        const b = i < nx ? outC[(k * ny + j) * nx + i] : 1;
        outU[(k * ny + j) * NU + i] = 0.5 * (a + b);
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j > 0 ? outC[(k * ny + j - 1) * nx + i] : 1;
        const b = j < ny ? outC[(k * ny + j) * nx + i] : 1;
        outV[(k * (ny + 1) + j) * nx + i] = 0.5 * (a + b);
      }
    }
  }
  for (let k = 1; k < nz; k++) {
    for (let c = 0; c < NXY; c++) outW[k * NXY + c] = 0.5 * (outC[(k - 1) * NXY + c] + outC[k * NXY + c]);
  }
  for (let c = 0; c < NXY; c++) outW[nz * NXY + c] = outC[(nz - 1) * NXY + c];

  // Per-layer constants.
  const prof = new Float32Array(nz);
  const relaxL = new Float32Array(nz);
  const lmix = new Float32Array(nz);
  const s0 = new Float32Array(nz); // the open profile's own shear per unit U, 1/m
  for (let k = 0; k < nz; k++) {
    prof[k] = airProfile(zc[k], o);
    const t = k / Math.max(1, nz - 1);
    relaxL[k] = o.relaxGroundM * Math.pow(o.relaxTopM / o.relaxGroundM, t);
    lmix[k] = Math.min(o.lMaxM, Math.max(o.lMinM, o.kappa * zc[k]));
  }
  for (let k = 0; k < nz; k++) {
    const kd = Math.max(0, k - 1);
    const ku = Math.min(nz - 1, k + 1);
    s0[k] = ku > kd ? (prof[ku] - prof[kd]) / (zc[ku] - zc[kd]) : 0;
  }
  const mixUp = new Float64Array(nz);
  const mixDn = new Float64Array(nz);
  for (let k = 0; k < nz; k++) {
    mixUp[k] = k < nz - 1 ? 1 / (dz[k] * (zc[k + 1] - zc[k])) : 0;
    mixDn[k] = k > 0 ? 1 / (dz[k] * (zc[k] - zc[k - 1])) : 0;
  }

  return {
    grid,
    o,
    u: new Float32Array(nU),
    v: new Float32Array(nV),
    w: new Float32Array(nW),
    k: new Float32Array(nC),
    phi: new Float32Array(nC),
    u2: new Float32Array(nU),
    v2: new Float32Array(nV),
    w2: new Float32Array(nW),
    k2: new Float32Array(nC),
    uc: new Float32Array(nC),
    vc: new Float32Array(nC),
    wc: new Float32Array(nC),
    div: new Float32Array(nC),
    nu: new Float32Array(nC),
    gust: new Float32Array(NXY).fill(1),
    gU: new Float32Array((nx + 1) * ny).fill(1),
    gV: new Float32Array(nx * (ny + 1)).fill(1),
    coef: { cW, cE, cS, cN, cD, cU, inv },
    links: { uLinkY, uLinkZ, vLinkX, vLinkZ, wLinkX, wLinkY },
    sealed,
    outC,
    outU,
    outV,
    outW,
    doors: findDoorways(grid),
    prof,
    relaxL,
    lmix,
    s0,
    mixUp,
    mixDn,
    driver: { phase: 0, tSec: 0 },
    stats: { steps: 0, substeps: 0 },
    primed: false,
    mix: {
      a: new Float64Array(nz),
      b: new Float64Array(nz),
      x: new Float64Array(nz),
      base: new Float64Array(nz),
      nus: new Float64Array(nz),
      cp: new Float64Array(nz),
      dp: new Float64Array(nz),
    },
  };
}

/**
 * The doorways: horizontal faces open at the ground with a wall above them (a door in a wall), that join a roofed
 * (indoor) cell to an open-sky one or to another room. Each: the face, its axis, which side is indoors (+1: the higher
 * index, −1: the lower, 0: both), and the layers it is open in (bottom up).
 */
export function findDoorways(grid) {
  const { nx, ny, nz, ax, ay, indoor } = grid;
  const NU = nx + 1;
  const doors = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 1; i < nx; i++) {
      if (!(ax[j * NU + i] > 0.5)) continue;
      let wallAbove = false;
      for (let k = 1; k < nz; k++) if (ax[(k * ny + j) * NU + i] < 0.5) wallAbove = true;
      if (!wallAbove) continue;
      const inA = indoor[j * nx + i - 1] === 1;
      const inB = indoor[j * nx + i] === 1;
      if (!inA && !inB) continue;
      doors.push({ axis: 0, i, j, inSide: inA && !inB ? -1 : !inA && inB ? 1 : 0, layers: openLayers(grid, 0, i, j) });
    }
  }
  leaks(grid, 0, doors);
  for (let j = 1; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!(ay[j * nx + i] > 0.5)) continue;
      let wallAbove = false;
      for (let k = 1; k < nz; k++) if (ay[(k * (ny + 1) + j) * nx + i] < 0.5) wallAbove = true;
      if (!wallAbove) continue;
      const inA = indoor[(j - 1) * nx + i] === 1;
      const inB = indoor[j * nx + i] === 1;
      if (!inA && !inB) continue;
      doors.push({ axis: 1, i, j, inSide: inA && !inB ? -1 : !inA && inB ? 1 : 0, layers: openLayers(grid, 1, i, j) });
    }
  }
  leaks(grid, 1, doors);
  return doors;
}

/**
 * DRAFTS through shut doors and closed glass (draftiness): a face only a crack open near the ground, between a room
 * and outdoors (or another room), is a weak doorway — the same exchange, scaled by the draftiness, pushed in from the
 * first cell inside the room (the crack itself carries only its trickle).
 */
function leaks(grid, axis, out) {
  const { nx, ny, nz, ax, ay, indoor } = grid;
  const gain = Math.min(1, Math.max(0, grid.draftiness01 ?? 0)) * AIR_LEAK_DRAFT_GAIN;
  if (!(gain > 0)) return;
  const A = (k, i, j) => (axis === 0 ? ax[(k * ny + j) * (nx + 1) + i] : ay[(k * (ny + 1) + j) * nx + i]);
  for (let j = axis === 0 ? 0 : 1; j < ny; j++) {
    for (let i = axis === 0 ? 1 : 0; i < (axis === 0 ? nx : nx); i++) {
      const layers = [];
      for (let k = 0; k < Math.min(3, nz); k++) {
        const a = A(k, i, j);
        if (a > 0 && a <= 0.5) layers.push(k);
        else break;
      }
      if (layers.length < 2) continue;
      const ca = axis === 0 ? j * nx + i - 1 : (j - 1) * nx + i;
      const inA = indoor[ca] === 1;
      const inB = indoor[j * nx + i] === 1;
      if (!inA && !inB) continue;
      out.push({ axis, i, j, inSide: inA && !inB ? -1 : !inA && inB ? 1 : 0, layers, leak: true, gain });
    }
  }
}

/** How strong a crack's draft is at full draftiness, against an open door's. */
export const AIR_LEAK_DRAFT_GAIN = 0.4;
function openLayers(grid, axis, i, j) {
  const { nx, ny, nz, ax, ay } = grid;
  const out = [];
  for (let k = 0; k < nz; k++) {
    const a = axis === 0 ? ax[(k * ny + j) * (nx + 1) + i] : ay[(k * (ny + 1) + j) * nx + i];
    if (a > 0.5) out.push(k);
    else break;
  }
  return out;
}

/** Fractional index of z in a sorted array (clamped to its ends). */
function zIndex(z, arr, n) {
  if (z <= arr[0]) return 0;
  if (z >= arr[n - 1]) return n - 1;
  let k = 0;
  while (k < n - 2 && z >= arr[k + 1]) k++;
  return k + (z - arr[k]) / (arr[k + 1] - arr[k]);
}
/** The layer (cell) that height z (m) is in. */
function layerOf(z, zb, nz) {
  let k = 0;
  while (k < nz - 1 && z >= zb[k + 1]) k++;
  return k;
}

/**
 * Advance the air by dt seconds.
 * @param {object} st - {@link createAirState}.
 * @param {{directionDeg:number, speedMps:number, gustiness01?:number}} wind - the weather now.
 * @param {number} dtSec - sim seconds (0 = paused: nothing changes).
 */
export function stepAir(st, wind, dtSec) {
  if (!(dtSec > 0)) return st;
  const { grid, o } = st;
  if (!st.primed) primeAir(st, wind);
  // Sub-steps from the fastest air actually present (and the weather's, so a rising dial is caught at once).
  let vmax = Math.max(0, wind.speedMps || 0) * st.prof[grid.nz - 1] * 1.2;
  for (let f = 0; f < st.u.length; f++) vmax = Math.max(vmax, Math.abs(st.u[f]));
  for (let f = 0; f < st.v.length; f++) vmax = Math.max(vmax, Math.abs(st.v[f]));
  const n = Math.min(o.maxSubsteps, Math.max(1, Math.ceil((vmax * dtSec) / (o.maxCellsPerSubstep * grid.h))));
  const sub = dtSec / n;
  const clock = o.clock;
  for (let s = 0; s < n; s++) {
    stepAirDriver(st.driver, wind, sub);
    gustFaces(st, wind);
    const t0 = clock ? clock() : 0;
    advect(st, sub);
    const t1 = clock ? clock() : 0;
    force(st, wind, sub);
    doorways(st, sub);
    mixVertical(st, sub);
    const t2 = clock ? clock() : 0;
    project(st);
    const t3 = clock ? clock() : 0;
    turbulence(st, wind, sub);
    if (clock) {
      const t4 = clock();
      const ph = (st.stats.phaseMs ??= { advect: 0, force: 0, project: 0, turb: 0 });
      ph.advect += t1 - t0;
      ph.force += t2 - t1;
      ph.project += t3 - t2;
      ph.turb += t4 - t3;
    }
    st.stats.substeps++;
  }
  st.stats.steps++;
  return st;
}

function gustFaces(st, wind) {
  const { grid } = st;
  const { nx, ny } = grid;
  airGustColumns(grid, st.driver, wind, st.gust);
  const g = st.gust;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i <= nx; i++) {
      st.gU[j * (nx + 1) + i] = 0.5 * (g[j * nx + Math.max(0, i - 1)] + g[j * nx + Math.min(nx - 1, i)]);
    }
  }
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i < nx; i++)
      st.gV[j * nx + i] = 0.5 * (g[Math.max(0, j - 1) * nx + i] + g[Math.min(ny - 1, j) * nx + i]);
  }
}

/** Start from the weather: every open-sky face at its target, still air indoors, k at the open level. */
export function primeAir(st, wind) {
  const { grid } = st;
  const { nx, ny, nz, ax, ay } = grid;
  gustFaces(st, wind);
  const U = Math.max(0, wind.speedMps || 0);
  const dir = windFlowVector(wind.directionDeg);
  for (let k = 0; k < nz; k++) {
    const base = U * st.prof[k];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const f = (k * ny + j) * (nx + 1) + i;
        st.u[f] = ax[f] > 0 ? base * dir.x * st.gU[j * (nx + 1) + i] * st.outU[f] : 0;
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = (k * (ny + 1) + j) * nx + i;
        st.v[f] = ay[f] > 0 ? base * dir.y * st.gV[j * nx + i] * st.outV[f] : 0;
      }
    }
  }
  const k0 = openK(st, wind);
  for (let c = 0; c < st.k.length; c++) st.k[c] = st.sealed[c] ? 0 : st.outC[c] * k0;
  for (let it = 0; it < 8; it++) project(st);
  st.primed = true;
}

/** The open ground's turbulence energy at this wind (height-independent in the surface layer: σu ≈ 2.5 u*). */
function openK(st, wind) {
  const s = st.o.openTurbulence * Math.max(0, wind.speedMps || 0);
  return 0.9 * s * s;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. ADVECT (momentum and k, from the same old velocities)
// ---------------------------------------------------------------------------------------------------------------
/** Scratch for the back-trace (no allocation per sample). */
const TR = { x: 0, y: 0, z: 0 };
/** Cells round a column that must be free of closed faces for the straight back-trace. */
const FREE_REACH = 6;

/** Per column: 1 when no closed face (wall, roof, floor) lies within FREE_REACH cells. Built once per grid. */
export function airFreeColumns(grid) {
  const { nx, ny, nz, ax, ay, az } = grid;
  const NXY = nx * ny;
  const blocked = new Uint8Array(NXY);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) if (ax[(k * ny + j) * (nx + 1) + i] < 1) blocked[j * nx + Math.min(nx - 1, i)] = 1;
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) if (ay[(k * (ny + 1) + j) * nx + i] < 1) blocked[Math.min(ny - 1, j) * nx + i] = 1;
    }
  }
  for (let k = 1; k <= nz; k++) for (let c = 0; c < NXY; c++) if (az[k * NXY + c] < 1) blocked[c] = 1;
  // Dilate by FREE_REACH + 1 (a separable max filter).
  const R = FREE_REACH + 1;
  const tmp = new Uint8Array(NXY);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let b = 0;
      for (let d = -R; d <= R && !b; d++) {
        const ii = i + d;
        if (ii >= 0 && ii < nx && blocked[j * nx + ii]) b = 1;
      }
      tmp[j * nx + i] = b;
    }
  }
  const free = new Uint8Array(NXY);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let b = 0;
      for (let d = -R; d <= R && !b; d++) {
        const jj = j + d;
        if (jj >= 0 && jj < ny && tmp[jj * nx + i]) b = 1;
      }
      free[j * nx + i] = b ? 0 : 1;
    }
  }
  return free;
}

/** March from (x, y in cell units; z in m) by (dx, dy, dz), stopping before the first closed face crossed. → TR. */
function trace(grid, x, y, z, dx, dy, dzm) {
  const { nx, ny, nz, zb, ax, ay, az } = grid;
  const NU = nx + 1;
  const NXY = nx * ny;
  const adx = dx < 0 ? -dx : dx;
  const ady = dy < 0 ? -dy : dy;
  const adz = (dzm < 0 ? -dzm : dzm) / 0.6;
  // FAST PATH: no closed face within reach of this column — the straight back-trace cannot cross a wall or a roof.
  const ci0 = x | 0;
  const cj0 = y | 0;
  if (adx < FREE_REACH && ady < FREE_REACH && grid.free && grid.free[cj0 * nx + ci0]) {
    TR.x = Math.min(nx - 1e-4, Math.max(1e-4, x + dx));
    TR.y = Math.min(ny - 1e-4, Math.max(1e-4, y + dy));
    TR.z = Math.min(zb[nz] - 1e-4, Math.max(1e-4, z + dzm));
    return;
  }
  // Otherwise march a cell at a time (at most one face crossed per axis per move).
  const steps = Math.max(1, Math.ceil(Math.max(adx, ady, adz)));
  const sx = dx / steps;
  const sy = dy / steps;
  const sz = dzm / steps;
  const zTop = zb[nz] - 1e-4;
  let ck = layerOf(z, zb, nz);
  for (let s = 0; s < steps; s++) {
    let x2 = x + sx;
    let y2 = y + sy;
    let z2 = z + sz;
    if (x2 < 1e-4) x2 = 1e-4;
    else if (x2 > nx - 1e-4) x2 = nx - 1e-4;
    if (y2 < 1e-4) y2 = 1e-4;
    else if (y2 > ny - 1e-4) y2 = ny - 1e-4;
    if (z2 < 1e-4) z2 = 1e-4;
    else if (z2 > zTop) z2 = zTop;
    const ci = x | 0;
    const cj = y | 0;
    const ci2 = x2 | 0;
    const cj2 = y2 | 0;
    if (ci2 !== ci && ax[(ck * ny + cj) * NU + (ci > ci2 ? ci : ci2)] < 0.5) x2 = x;
    if (cj2 !== cj && ay[(ck * (ny + 1) + (cj > cj2 ? cj : cj2)) * nx + (x2 | 0)] < 0.5) y2 = y;
    const ck2 = layerOf(z2, zb, nz);
    if (ck2 !== ck && az[(ck > ck2 ? ck : ck2) * NXY + (y2 | 0) * nx + (x2 | 0)] < 0.5) z2 = z;
    else ck = ck2;
    x = x2;
    y = y2;
    z = z2;
  }
  TR.x = x;
  TR.y = y;
  TR.z = z;
}

function advect(st, dt) {
  const { grid, links, sealed } = st;
  const { nx, ny, nz, h, zc, zb, ax, ay, az } = grid;
  const { u2, v2, w2, k2, uc, vc, wc } = st;
  // What a face carries into its neighbours is its FLOW per full face (aperture × speed): air squeezing fast through a
  // crack (a leaky door, draftiness) brings in a trickle, not a gale. Fully open faces are unchanged.
  const u = (st.ue ??= new Float32Array(st.u.length));
  const v = (st.ve ??= new Float32Array(st.v.length));
  const w = (st.we ??= new Float32Array(st.w.length));
  for (let f = 0; f < u.length; f++) u[f] = st.u[f] * ax[f];
  for (let f = 0; f < v.length; f++) v[f] = st.v[f] * ay[f];
  for (let f = 0; f < w.length; f++) w[f] = st.w[f] * az[f];
  const K = st.k;
  const NXY = nx * ny;
  const NU = nx + 1;
  const NV = (ny + 1) * nx;
  const ix = dt / h;
  const { uLinkY, uLinkZ, vLinkX, vLinkZ, wLinkX, wLinkY } = links;

  cellVelocities(st);

  // ---- u-faces: sample (i, j + ½, zc[k])
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const f = (k * ny + j) * NU + i;
        if (ax[f] <= 0) {
          u2[f] = 0;
          continue;
        }
        const il = i > 0 ? i - 1 : 0;
        const ir = i < nx ? i : nx - 1;
        const fvA = k * NV + j * nx;
        const vv = 0.25 * (v[fvA + il] + v[fvA + ir] + v[fvA + nx + il] + v[fvA + nx + ir]);
        const fwA = j * nx;
        const ww =
          0.25 *
          (w[k * NXY + fwA + il] + w[k * NXY + fwA + ir] + w[(k + 1) * NXY + fwA + il] + w[(k + 1) * NXY + fwA + ir]);
        trace(grid, i < 1e-4 ? 1e-4 : i > nx - 1e-4 ? nx - 1e-4 : i, j + 0.5, zc[k], -u[f] * ix, -vv * ix, -ww * dt);
        const fi = TR.x;
        const fj = TR.y - 0.5 < 0 ? 0 : TR.y - 0.5 > ny - 1 ? ny - 1 : TR.y - 0.5;
        const fk = zIndex(TR.z, zc, nz);
        const i0 = fi >= nx ? nx - 1 : fi | 0;
        const j0 = Math.min(ny > 1 ? ny - 2 : 0, fj | 0);
        const k0 = Math.min(nz > 1 ? nz - 2 : 0, fk | 0);
        const tx = fi - i0;
        const ty = Math.min(1, fj - j0);
        const tz = Math.min(1, fk - k0);
        const j1 = ny > 1 ? j0 + 1 : j0;
        const k1 = nz > 1 ? k0 + 1 : k0;
        const inear = tx < 0.5 ? i0 : i0 + 1;
        const b00 = (k0 * ny + j0) * NU;
        const b10 = (k0 * ny + j1) * NU;
        const b01 = (k1 * ny + j0) * NU;
        const b11 = (k1 * ny + j1) * NU;
        const r00 = u[b00 + i0] + (u[b00 + i0 + 1] - u[b00 + i0]) * tx;
        const r10 = u[b10 + i0] + (u[b10 + i0 + 1] - u[b10 + i0]) * tx;
        const r01 = u[b01 + i0] + (u[b01 + i0 + 1] - u[b01 + i0]) * tx;
        const r11 = u[b11 + i0] + (u[b11 + i0 + 1] - u[b11 + i0]) * tx;
        const y0 = uLinkY[b00 + inear] ? r00 + (r10 - r00) * ty : ty < 0.5 ? r00 : r10;
        const y1 = uLinkY[b01 + inear] ? r01 + (r11 - r01) * ty : ty < 0.5 ? r01 : r11;
        const jn = ty < 0.5 ? j0 : j1;
        u2[f] = uLinkZ[(k0 * ny + jn) * NU + inear] ? y0 + (y1 - y0) * tz : tz < 0.5 ? y0 : y1;
      }
    }
  }
  // ---- v-faces: sample (i + ½, j, zc[k])
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = k * NV + j * nx + i;
        if (ay[f] <= 0) {
          v2[f] = 0;
          continue;
        }
        const jl = j > 0 ? j - 1 : 0;
        const jr = j < ny ? j : ny - 1;
        const ul = (k * ny + jl) * NU + i;
        const ur = (k * ny + jr) * NU + i;
        const uu = 0.25 * (u[ul] + u[ul + 1] + u[ur] + u[ur + 1]);
        const ww =
          0.25 *
          (w[k * NXY + jl * nx + i] +
            w[k * NXY + jr * nx + i] +
            w[(k + 1) * NXY + jl * nx + i] +
            w[(k + 1) * NXY + jr * nx + i]);
        trace(grid, i + 0.5, j < 1e-4 ? 1e-4 : j > ny - 1e-4 ? ny - 1e-4 : j, zc[k], -uu * ix, -v[f] * ix, -ww * dt);
        const fi = TR.x - 0.5 < 0 ? 0 : TR.x - 0.5 > nx - 1 ? nx - 1 : TR.x - 0.5;
        const fj = TR.y;
        const fk = zIndex(TR.z, zc, nz);
        const i0 = Math.min(nx > 1 ? nx - 2 : 0, fi | 0);
        const j0 = fj >= ny ? ny - 1 : fj | 0;
        const k0 = Math.min(nz > 1 ? nz - 2 : 0, fk | 0);
        const tx = Math.min(1, fi - i0);
        const ty = fj - j0;
        const tz = Math.min(1, fk - k0);
        const i1 = nx > 1 ? i0 + 1 : i0;
        const k1 = nz > 1 ? k0 + 1 : k0;
        const jnear = ty < 0.5 ? j0 : j0 + 1;
        const a0 = k0 * NV + j0 * nx;
        const a1 = k1 * NV + j0 * nx;
        const c00 = v[a0 + i0] + (v[a0 + nx + i0] - v[a0 + i0]) * ty;
        const c10 = v[a0 + i1] + (v[a0 + nx + i1] - v[a0 + i1]) * ty;
        const c01 = v[a1 + i0] + (v[a1 + nx + i0] - v[a1 + i0]) * ty;
        const c11 = v[a1 + i1] + (v[a1 + nx + i1] - v[a1 + i1]) * ty;
        const x0 = vLinkX[k0 * NV + jnear * nx + i0] ? c00 + (c10 - c00) * tx : tx < 0.5 ? c00 : c10;
        const x1 = vLinkX[k1 * NV + jnear * nx + i0] ? c01 + (c11 - c01) * tx : tx < 0.5 ? c01 : c11;
        const inr = tx < 0.5 ? i0 : i1;
        v2[f] = vLinkZ[k0 * NV + jnear * nx + inr] ? x0 + (x1 - x0) * tz : tz < 0.5 ? x0 : x1;
      }
    }
  }
  // ---- w-faces (interior + top): sample (i + ½, j + ½, zb[k])
  w2.fill(0);
  for (let k = 1; k <= nz; k++) {
    const kl = k - 1;
    const kh = k < nz ? k : nz - 1;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = k * NXY + j * nx + i;
        if (az[f] <= 0) continue;
        const a = (kl * ny + j) * NU + i;
        const b = (kh * ny + j) * NU + i;
        const uu = 0.25 * (u[a] + u[a + 1] + u[b] + u[b + 1]);
        const vv =
          0.25 *
          (v[kl * NV + j * nx + i] +
            v[kl * NV + (j + 1) * nx + i] +
            v[kh * NV + j * nx + i] +
            v[kh * NV + (j + 1) * nx + i]);
        trace(grid, i + 0.5, j + 0.5, k < nz ? zb[k] : zb[nz] - 1e-3, -uu * ix, -vv * ix, -w[f] * dt);
        const fi = TR.x - 0.5 < 0 ? 0 : TR.x - 0.5 > nx - 1 ? nx - 1 : TR.x - 0.5;
        const fj = TR.y - 0.5 < 0 ? 0 : TR.y - 0.5 > ny - 1 ? ny - 1 : TR.y - 0.5;
        const fk = zIndex(TR.z, zb, nz + 1);
        const i0 = Math.min(nx > 1 ? nx - 2 : 0, fi | 0);
        const j0 = Math.min(ny > 1 ? ny - 2 : 0, fj | 0);
        const k0 = fk >= nz ? nz - 1 : fk | 0;
        const tx = Math.min(1, fi - i0);
        const ty = Math.min(1, fj - j0);
        const tz = fk - k0;
        const i1 = nx > 1 ? i0 + 1 : i0;
        const j1 = ny > 1 ? j0 + 1 : j0;
        const knear = tz < 0.5 ? k0 : k0 + 1;
        const lo = k0 * NXY;
        const hi = (k0 + 1) * NXY;
        const v00 = w[lo + j0 * nx + i0] + (w[hi + j0 * nx + i0] - w[lo + j0 * nx + i0]) * tz;
        const v10 = w[lo + j0 * nx + i1] + (w[hi + j0 * nx + i1] - w[lo + j0 * nx + i1]) * tz;
        const v01 = w[lo + j1 * nx + i0] + (w[hi + j1 * nx + i0] - w[lo + j1 * nx + i0]) * tz;
        const v11 = w[lo + j1 * nx + i1] + (w[hi + j1 * nx + i1] - w[lo + j1 * nx + i1]) * tz;
        const y0 = wLinkX[knear * NXY + j0 * nx + i0] ? v00 + (v10 - v00) * tx : tx < 0.5 ? v00 : v10;
        const y1 = wLinkX[knear * NXY + j1 * nx + i0] ? v01 + (v11 - v01) * tx : tx < 0.5 ? v01 : v11;
        const inr = tx < 0.5 ? i0 : i1;
        w2[f] = wLinkY[knear * NXY + j0 * nx + inr] ? y0 + (y1 - y0) * ty : ty < 0.5 ? y0 : y1;
      }
    }
  }
  // ---- k at cells: sample (i + ½, j + ½, zc[k]); links are the faces between cells.
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i;
        if (sealed[c]) {
          k2[c] = 0;
          continue;
        }
        trace(grid, i + 0.5, j + 0.5, zc[k], -uc[c] * ix, -vc[c] * ix, -wc[c] * dt);
        const fi = TR.x - 0.5 < 0 ? 0 : TR.x - 0.5 > nx - 1 ? nx - 1 : TR.x - 0.5;
        const fj = TR.y - 0.5 < 0 ? 0 : TR.y - 0.5 > ny - 1 ? ny - 1 : TR.y - 0.5;
        const fk = zIndex(TR.z, zc, nz);
        const i0 = Math.min(nx > 1 ? nx - 2 : 0, fi | 0);
        const j0 = Math.min(ny > 1 ? ny - 2 : 0, fj | 0);
        const k0 = Math.min(nz > 1 ? nz - 2 : 0, fk | 0);
        const tx = Math.min(1, fi - i0);
        const ty = Math.min(1, fj - j0);
        const tz = Math.min(1, fk - k0);
        const i1 = nx > 1 ? i0 + 1 : i0;
        const j1 = ny > 1 ? j0 + 1 : j0;
        const k1 = nz > 1 ? k0 + 1 : k0;
        const inr = tx < 0.5 ? i0 : i1;
        const jn = ty < 0.5 ? j0 : j1;
        const r00 = (k0 * ny + j0) * nx;
        const r10 = (k0 * ny + j1) * nx;
        const r01 = (k1 * ny + j0) * nx;
        const r11 = (k1 * ny + j1) * nx;
        const a00 = K[r00 + i0];
        const a10 = K[r10 + i0];
        const a01 = K[r01 + i0];
        const a11 = K[r11 + i0];
        const x00 = ax[(k0 * ny + j0) * NU + i1] > 0 ? a00 + (K[r00 + i1] - a00) * tx : tx < 0.5 ? a00 : K[r00 + i1];
        const x10 = ax[(k0 * ny + j1) * NU + i1] > 0 ? a10 + (K[r10 + i1] - a10) * tx : tx < 0.5 ? a10 : K[r10 + i1];
        const x01 = ax[(k1 * ny + j0) * NU + i1] > 0 ? a01 + (K[r01 + i1] - a01) * tx : tx < 0.5 ? a01 : K[r01 + i1];
        const x11 = ax[(k1 * ny + j1) * NU + i1] > 0 ? a11 + (K[r11 + i1] - a11) * tx : tx < 0.5 ? a11 : K[r11 + i1];
        const y0 = ay[k0 * NV + j1 * nx + inr] > 0 ? x00 + (x10 - x00) * ty : ty < 0.5 ? x00 : x10;
        const y1 = ay[k1 * NV + j1 * nx + inr] > 0 ? x01 + (x11 - x01) * ty : ty < 0.5 ? x01 : x11;
        k2[c] = az[k1 * NXY + jn * nx + inr] > 0 ? y0 + (y1 - y0) * tz : tz < 0.5 ? y0 : y1;
      }
    }
  }
  // Sealed rooms hold still air.
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i;
        if (!sealed[c]) continue;
        u2[(k * ny + j) * NU + i] = 0;
        u2[(k * ny + j) * NU + i + 1] = 0;
        v2[k * NV + j * nx + i] = 0;
        v2[k * NV + (j + 1) * nx + i] = 0;
        w2[k * NXY + j * nx + i] = 0;
        w2[(k + 1) * NXY + j * nx + i] = 0;
      }
    }
  }
  st.u.set(u2);
  st.v.set(v2);
  st.w.set(w2);
  K.set(k2);
}

/** Cell-centred velocities from the faces (for k's trace and the turbulence pass). */
function cellVelocities(st) {
  const { nx, ny, nz, ax, ay, az } = st.grid;
  const { u, v, w, uc, vc, wc } = st;
  const NU = nx + 1;
  const NV = (ny + 1) * nx;
  const NXY = nx * ny;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i;
        const fu = (k * ny + j) * NU + i;
        const fv = k * NV + j * nx + i;
        const fw = k * NXY + j * nx + i;
        uc[c] = 0.5 * (u[fu] * ax[fu] + u[fu + 1] * ax[fu + 1]);
        vc[c] = 0.5 * (v[fv] * ay[fv] + v[fv + nx] * ay[fv + nx]);
        wc[c] = 0.5 * (w[fw] * az[fw] + w[fw + NXY] * az[fw + NXY]);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 2. FORCE
// ---------------------------------------------------------------------------------------------------------------
function force(st, wind, dt) {
  const { grid, o, outU, outV, outW, gU, gV } = st;
  const { nx, ny, nz, ax, ay, az } = grid;
  const NU = nx + 1;
  const NV = (ny + 1) * nx;
  const NXY = nx * ny;
  const U = Math.max(0, wind.speedMps || 0);
  const dir = windFlowVector(wind.directionDeg);
  const dampIn = 1 - Math.exp(-o.indoorDampPerSec * dt);
  const { u, v, w } = st;
  for (let k = 0; k < nz; k++) {
    const rate = Math.max(o.minRelaxPerSec, (U * st.prof[k]) / st.relaxL[k]);
    const relax = 1 - Math.exp(-rate * dt);
    const tu = U * dir.x * st.prof[k];
    const tv = U * dir.y * st.prof[k];
    for (let j = 0; j < ny; j++) {
      const edgeJ = j === 0 || j === ny - 1;
      for (let i = 0; i <= nx; i++) {
        const f = (k * ny + j) * NU + i;
        if (ax[f] <= 0) continue;
        const t = tu * gU[j * NU + i];
        if (i === 0 || i === nx || edgeJ) {
          u[f] = t;
          continue;
        }
        const out = outU[f];
        const x = u[f] + (t - u[f]) * relax * out;
        u[f] = x - x * dampIn * (1 - out);
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = k * NV + j * nx + i;
        if (ay[f] <= 0) continue;
        const t = tv * gV[j * nx + i];
        if (j === 0 || j === ny || i === 0 || i === nx - 1) {
          v[f] = t;
          continue;
        }
        const out = outV[f];
        const x = v[f] + (t - v[f]) * relax * out;
        v[f] = x - x * dampIn * (1 - out);
      }
    }
    if (k > 0) {
      for (let c = 0; c < NXY; c++) {
        const f = k * NXY + c;
        if (az[f] <= 0) continue;
        const out = outW[f];
        w[f] -= w[f] * (dampIn * (1 - out) + relax * out * 0.5);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 3. DOORWAYS — the single-sided exchange through an open door.
// ---------------------------------------------------------------------------------------------------------------
function doorways(st, dt) {
  const { grid, o, doors } = st;
  if (!doors.length) return;
  const { nx, ny } = grid;
  const NU = nx + 1;
  const NV = (ny + 1) * nx;
  const NXY = nx * ny;
  const rate = 1 - Math.exp(-o.doorRatePerSec * dt);
  const n = o.doorApproachCells;
  for (const d of doors) {
    const L = d.layers;
    if (L.length < 2) continue;
    const kTop = d.leak ? Math.min(1, L[L.length - 1]) : L[L.length - 1];
    const kLow = L[0];
    // Which side is the room (s = +1: the higher index)? Between two rooms, the calmer side is "inside".
    let s = d.inSide;
    const cA = d.axis === 0 ? d.j * nx + d.i - 1 : (d.j - 1) * nx + d.i;
    const cB = d.j * nx + d.i;
    if (s === 0) s = st.k[kTop * NXY + cA] >= st.k[kTop * NXY + cB] ? 1 : -1;
    // The wind approaching the door from outside, n cells out (toward the room = +): the strongest of the door's top
    // layer and the one above it — along the floor the base vortex of a windward wall runs the other way, and an
    // average over the door's height would cancel the push the doorway really feels.
    let approach = 0;
    let kOut = 0;
    for (let k = kTop; k <= Math.min(grid.nz - 1, kTop + 1); k++) {
      const a =
        d.axis === 0
          ? s * st.u[(k * ny + d.j) * NU + (s > 0 ? Math.max(0, d.i - n) : Math.min(nx, d.i + n))]
          : s * st.v[k * NV + (s > 0 ? Math.max(0, d.j - n) : Math.min(ny, d.j + n)) * nx + d.i];
      if (a > approach) approach = a;
    }
    for (const k of L) {
      kOut +=
        d.axis === 0
          ? st.k[k * NXY + d.j * nx + Math.min(nx - 1, Math.max(0, s > 0 ? d.i - n : d.i + n - 1))]
          : st.k[k * NXY + Math.min(ny - 1, Math.max(0, s > 0 ? d.j - n : d.j + n - 1)) * nx + d.i];
    }
    kOut /= L.length;
    // A door that is already the outlet of a through-draught carries its own flow: no exchange push against it.
    let net = 0;
    for (const k of L) net += s * (d.axis === 0 ? st.u[(k * ny + d.j) * NU + d.i] : st.v[k * NV + d.j * nx + d.i]);
    net /= L.length;
    const q = (o.doorApproach * Math.max(0, approach) + o.doorTurbulence * Math.sqrt((2 * kOut) / 3)) * (d.gain ?? 1);
    if (net < -0.5 * q) continue;
    // In through the top of the door: a short jet force along the room's first few metres (fading inward), so the
    // pressure solve must send the return flow back across the room and out along the floor — a loop, not a stub.
    const arr = d.axis === 0 ? st.u : st.v;
    const apr = d.axis === 0 ? grid.ax : grid.ay;
    const M = o.doorJetCells;
    for (let m = d.leak ? 1 : 0; m < M; m++) {
      const at = (d.axis === 0 ? d.i : d.j) + s * m;
      if (at <= 0 || at >= (d.axis === 0 ? nx : ny)) break;
      const f = d.axis === 0 ? (kTop * ny + d.j) * NU + at : kTop * NV + at * nx + d.i;
      if (!(apr[f] > 0.5)) break;
      const target = s * q * (1 - m / M);
      if (s * arr[f] < s * target) arr[f] += (target - arr[f]) * rate;
    }
    void kLow;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 4. MIX — implicit vertical diffusion of the departure from the weather's shape, per face column.
// ---------------------------------------------------------------------------------------------------------------
function mixVertical(st, dt) {
  const { grid, o, outU, outV, mixUp, mixDn } = st;
  const { nx, ny, nz, ax, ay } = grid;
  const NU = nx + 1;
  const NV = (ny + 1) * nx;
  const NXY = nx * ny;
  const nu = st.nu;
  const { uLinkZ, vLinkZ } = st.links;
  for (let k = 0; k < nz; k++) {
    const l = o.cNu * st.lmix[k];
    for (let c = 0; c < NXY; c++) {
      const q = k * NXY + c;
      const kk = st.k[q];
      nu[q] = l * Math.sqrt(kk > 0 ? kk : 0);
    }
  }
  const { a, b, x, base, nus, cp, dp } = st.mix;
  const prof = st.prof;
  const ptop = Math.max(1e-6, prof[nz - 1]);
  const UF = ny * NU;
  // The departure is taken from the weather's SHAPE scaled to this column's own top (outdoor faces only; roofed air
  // mixes plainly). Open ground is exactly that shape, so mixing leaves it alone; a wake's deficit is shared with the
  // fast air above it, which the relax then tops up.
  for (let j = 0; j < ny; j++) {
    for (let i = 1; i < nx; i++) {
      const f0 = j * NU + i;
      const ref = st.u[(nz - 1) * UF + f0] / ptop;
      for (let k = 0; k < nz; k++) {
        const f = k * UF + f0;
        nus[k] = 0.5 * (nu[k * NXY + j * nx + i - 1] + nu[k * NXY + j * nx + i]);
        base[k] = ref * prof[k] * outU[f];
        x[k] = st.u[f] - base[k];
      }
      for (let k = 0; k < nz; k++) {
        const f = k * UF + f0;
        b[k] = k < nz - 1 && uLinkZ[f] ? 0.5 * (nus[k] + nus[k + 1]) * mixUp[k] * dt : 0;
        a[k] = k > 0 && uLinkZ[f - UF] ? 0.5 * (nus[k] + nus[k - 1]) * mixDn[k] * dt : 0;
      }
      thomas(a, b, x, cp, dp, nz);
      for (let k = 0; k < nz; k++) {
        const f = k * UF + f0;
        if (ax[f] > 0) st.u[f] = x[k] + base[k];
      }
    }
  }
  for (let j = 1; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const f0 = j * nx + i;
      const ref = st.v[(nz - 1) * NV + f0] / ptop;
      for (let k = 0; k < nz; k++) {
        const f = k * NV + f0;
        nus[k] = 0.5 * (nu[k * NXY + (j - 1) * nx + i] + nu[k * NXY + j * nx + i]);
        base[k] = ref * prof[k] * outV[f];
        x[k] = st.v[f] - base[k];
      }
      for (let k = 0; k < nz; k++) {
        const f = k * NV + f0;
        b[k] = k < nz - 1 && vLinkZ[f] ? 0.5 * (nus[k] + nus[k + 1]) * mixUp[k] * dt : 0;
        a[k] = k > 0 && vLinkZ[f - NV] ? 0.5 * (nus[k] + nus[k - 1]) * mixDn[k] * dt : 0;
      }
      thomas(a, b, x, cp, dp, nz);
      for (let k = 0; k < nz; k++) {
        const f = k * NV + f0;
        if (ay[f] > 0) st.v[f] = x[k] + base[k];
      }
    }
  }
}
/** (1 + a_k + b_k) x_k − a_k x_{k−1} − b_k x_{k+1} = rhs_k, in place on x (Thomas algorithm). */
function thomas(a, b, x, cp, dp, n) {
  for (let k = 0; k < n; k++) {
    const diag = 1 + a[k] + b[k];
    if (k === 0) {
      cp[0] = -b[0] / diag;
      dp[0] = x[0] / diag;
    } else {
      const m = diag + a[k] * cp[k - 1];
      cp[k] = -b[k] / m;
      dp[k] = (x[k] + a[k] * dp[k - 1]) / m;
    }
  }
  x[n - 1] = dp[n - 1];
  for (let k = n - 2; k >= 0; k--) x[k] = dp[k] - cp[k] * x[k + 1];
}

// ---------------------------------------------------------------------------------------------------------------
// 5. PROJECT
// ---------------------------------------------------------------------------------------------------------------
/** Make the flow divergence-free on the open faces (red-black SOR, warm-started from the last step's φ). */
export function project(st, iterations = st.o.sorIterations) {
  const { grid, o, coef } = st;
  const { nx, ny, nz, h, dz, zc, zb, ax, ay, az } = grid;
  const { u, v, w, phi, div } = st;
  const NU = nx + 1;
  const NV = (ny + 1) * nx;
  const NXY = nx * ny;
  const h2 = h * h;
  for (let k = 0; k < nz; k++) {
    const hd = h * dz[k];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i;
        const fu = (k * ny + j) * NU + i;
        const fv = k * NV + j * nx + i;
        const fw = k * NXY + j * nx + i;
        div[c] =
          hd * (ax[fu + 1] * u[fu + 1] - ax[fu] * u[fu]) +
          hd * (ay[fv + nx] * v[fv + nx] - ay[fv] * v[fv]) +
          h2 * (az[fw + NXY] * w[fw + NXY] - az[fw] * w[fw]);
      }
    }
  }
  const { cW, cE, cS, cN, cD, cU, inv } = coef;
  const om = o.sorOmega;
  for (let it = 0; it < iterations; it++) {
    for (let color = 0; color < 2; color++) {
      for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
          const row = (k * ny + j) * nx;
          for (let i = (color + j + k) & 1; i < nx; i += 2) {
            const c = row + i;
            const iv = inv[c];
            if (iv === 0) continue;
            let s = -div[c];
            if (i > 0) s += cW[c] * phi[c - 1];
            if (i < nx - 1) s += cE[c] * phi[c + 1];
            if (j > 0) s += cS[c] * phi[c - nx];
            if (j < ny - 1) s += cN[c] * phi[c + nx];
            if (k > 0) s += cD[c] * phi[c - NXY];
            if (k < nz - 1) s += cU[c] * phi[c + NXY];
            phi[c] += om * (s * iv - phi[c]);
          }
        }
      }
    }
  }
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = (k * ny + j) * nx;
      const fb = (k * ny + j) * NU;
      for (let i = 0; i <= nx; i++) {
        const f = fb + i;
        if (ax[f] <= 0) continue;
        u[f] -= ((i < nx ? phi[row + i] : 0) - (i > 0 ? phi[row + i - 1] : 0)) / h;
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = k * NV + j * nx + i;
        if (ay[f] <= 0) continue;
        const pb = j > 0 ? phi[(k * ny + j - 1) * nx + i] : 0;
        const pt = j < ny ? phi[(k * ny + j) * nx + i] : 0;
        v[f] -= (pt - pb) / h;
      }
    }
  }
  for (let k = 1; k <= nz; k++) {
    const d = k < nz ? zc[k] - zc[k - 1] : zb[nz] - zc[nz - 1];
    for (let c = 0; c < NXY; c++) {
      const f = k * NXY + c;
      if (az[f] <= 0) continue;
      w[f] -= ((k < nz ? phi[k * NXY + c] : 0) - phi[(k - 1) * NXY + c]) / d;
    }
  }
}

/** The largest |∇·u| per unit volume (1/s) over the open (not sealed) cells — a test's measure of mass conservation. */
export function airMaxDivergence(st) {
  const { grid } = st;
  const { nx, ny, nz, h, dz, ax, ay, az } = grid;
  const { u, v, w } = st;
  const NU = nx + 1;
  const NXY = nx * ny;
  let m = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i;
        if (st.sealed[c]) continue;
        const fu = (k * ny + j) * NU + i;
        const fv = (k * (ny + 1) + j) * nx + i;
        const fw = k * NXY + j * nx + i;
        const d =
          (ax[fu + 1] * u[fu + 1] - ax[fu] * u[fu]) / h +
          (ay[fv + nx] * v[fv + nx] - ay[fv] * v[fv]) / h +
          (az[fw + NXY] * w[fw + NXY] - az[fw] * w[fw]) / dz[k];
        m = Math.max(m, Math.abs(d));
      }
    }
  }
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// 6. TURBULENCE ENERGY (k was advected with the momentum)
// ---------------------------------------------------------------------------------------------------------------
function turbulence(st, wind, dt) {
  const { grid, o, sealed, outC } = st;
  const { nx, ny, nz, h, dz, zc, ax, ay, az } = grid;
  const NU = nx + 1;
  const NV = (ny + 1) * nx;
  const NXY = nx * ny;
  const { u, v, w, k2, uc, vc, wc } = st;
  const K = st.k;
  const U = Math.max(0, wind.speedMps || 0);
  const k0 = openK(st, wind);
  cellVelocities(st);
  k2.set(K);
  const inv2h = 1 / (2 * h);
  for (let k = 0; k < nz; k++) {
    const l = st.lmix[k];
    const zU = k < nz - 1 ? zc[k + 1] : zc[k];
    const zD = k > 0 ? zc[k - 1] : zc[k];
    const izz = zU > zD ? 1 / (zU - zD) : 0;
    const dzu = k < nz - 1 ? zc[k + 1] - zc[k] : dz[k];
    const dzd = k > 0 ? zc[k] - zc[k - 1] : dz[k];
    const dzMin = dzu < dzd ? dzu : dzd;
    const s0 = st.s0[k] * U;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i;
        if (sealed[c]) {
          K[c] = 0;
          continue;
        }
        const fu = (k * ny + j) * NU + i;
        const fv = k * NV + j * nx + i;
        const fw = k * NXY + j * nx + i;
        const oW = i > 0 && ax[fu] > 0;
        const oE = i < nx - 1 && ax[fu + 1] > 0;
        const oS = j > 0 && ay[fv] > 0;
        const oN = j < ny - 1 && ay[fv + nx] > 0;
        const oD = k > 0 && az[fw] > 0;
        const oU = k < nz - 1 && az[fw + NXY] > 0;
        // A neighbour behind a closed face is a wall (still air); off the grid it copies this cell.
        const uN = oN ? uc[c + nx] : j === ny - 1 ? uc[c] : 0;
        const uS = oS ? uc[c - nx] : j === 0 ? uc[c] : 0;
        const vE = oE ? vc[c + 1] : i === nx - 1 ? vc[c] : 0;
        const vW = oW ? vc[c - 1] : i === 0 ? vc[c] : 0;
        const wE = oE ? wc[c + 1] : i === nx - 1 ? wc[c] : 0;
        const wW = oW ? wc[c - 1] : i === 0 ? wc[c] : 0;
        const wN = oN ? wc[c + nx] : j === ny - 1 ? wc[c] : 0;
        const wS = oS ? wc[c - nx] : j === 0 ? wc[c] : 0;
        // Vertical: the ground is not counted (the open profile's own shear is the weather's); a roof is a wall.
        const uUp = k < nz - 1 ? (oU ? uc[c + NXY] : 0) : uc[c];
        const uDn = k > 0 ? (oD ? uc[c - NXY] : 0) : uc[c];
        const vUp = k < nz - 1 ? (oU ? vc[c + NXY] : 0) : vc[c];
        const vDn = k > 0 ? (oD ? vc[c - NXY] : 0) : vc[c];
        const dudx = (u[fu + 1] - u[fu]) / h;
        const dvdy = (v[fv + nx] - v[fv]) / h;
        const dwdz = (w[fw + NXY] - w[fw]) / dz[k];
        const dudy = (uN - uS) * inv2h;
        const dvdx = (vE - vW) * inv2h;
        const dwdx = (wE - wW) * inv2h;
        const dwdy = (wN - wS) * inv2h;
        const dudz = (uUp - uDn) * izz;
        const dvdz = (vUp - vDn) * izz;
        const S2 =
          2 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz) +
          (dudy + dvdx) * (dudy + dvdx) +
          (dudz + dwdx) * (dudz + dwdx) +
          (dvdz + dwdy) * (dvdz + dwdy);
        const gC = st.gust[j * nx + i];
        const out = outC[c];
        const sh = s0 * gC;
        const S2x = S2 - out * sh * sh > 0 ? S2 - out * sh * sh : 0;
        const kc = k2[c];
        const nuT = o.cNu * l * Math.sqrt(kc > 0 ? kc : 0);
        // Diffusion through open faces only (explicit, capped for stability).
        const dk = nuT / o.sigmaK;
        let cx = (dk * dt) / (h * h);
        let cz = (dk * dt) / (dz[k] * dzMin);
        const tot = 4 * cx + 2 * cz;
        if (tot > 0.8) {
          cx *= 0.8 / tot;
          cz *= 0.8 / tot;
        }
        let lap = 0;
        if (oW) lap += cx * ax[fu] * (k2[c - 1] - kc);
        if (oE) lap += cx * ax[fu + 1] * (k2[c + 1] - kc);
        if (oS) lap += cx * ay[fv] * (k2[c - nx] - kc);
        if (oN) lap += cx * ay[fv + nx] * (k2[c + nx] - kc);
        if (oD) lap += cz * az[fw] * (k2[c - NXY] - kc);
        if (oU) lap += cz * az[fw + NXY] * (k2[c + NXY] - kc);
        const kOpen = k0 * gC * gC;
        const floorSrc = (out * o.cDiss * kOpen * Math.sqrt(kOpen)) / l;
        let kn = kc + lap + dt * (nuT * S2x + floorSrc);
        kn = kn / (1 + (dt * o.cDiss * Math.sqrt(kn > 0 ? kn : 0)) / l);
        K[c] = kn > 0 && kn < 1e6 ? kn : 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// READ-OUT
// ---------------------------------------------------------------------------------------------------------------
/**
 * One layer of the air as cell-centred arrays (m/s, m²/s²): what effects and the wind view read.
 * @param {object} st @param {number} kLayer
 * @param {{vx?:Float32Array, vy?:Float32Array, vz?:Float32Array, tke?:Float32Array}} [out]
 */
export function airLayer(st, kLayer, out = {}) {
  const { nx, ny, nz } = st.grid;
  const k = Math.min(nz - 1, Math.max(0, kLayer | 0));
  const NU = nx + 1;
  const NXY = nx * ny;
  const vx = out.vx ?? new Float32Array(NXY);
  const vy = out.vy ?? new Float32Array(NXY);
  const vz = out.vz ?? new Float32Array(NXY);
  const tke = out.tke ?? new Float32Array(NXY);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const fu = (k * ny + j) * NU + i;
      const fv = (k * (ny + 1) + j) * nx + i;
      const g = st.grid;
      vx[c] = 0.5 * (st.u[fu] * g.ax[fu] + st.u[fu + 1] * g.ax[fu + 1]);
      vy[c] = 0.5 * (st.v[fv] * g.ay[fv] + st.v[fv + nx] * g.ay[fv + nx]);
      vz[c] = 0.5 * (st.w[k * NXY + c] * g.az[k * NXY + c] + st.w[(k + 1) * NXY + c] * g.az[(k + 1) * NXY + c]);
      tke[c] = st.k[k * NXY + c];
    }
  }
  return { vx, vy, vz, tke, nx, ny, layer: k };
}

/** The air at a world point (px) and height (m), cell-centred, nearest layer. */
export function airAt(st, xPx, yPx, zM = 1.5) {
  const g = st.grid;
  const i = Math.floor((xPx - g.originX) / g.cellPx);
  const j = Math.floor((yPx - g.originY) / g.cellPx);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return null;
  const k = layerOf(zM, g.zb, g.nz);
  const NXY = g.nx * g.ny;
  const c = j * g.nx + i;
  const fu = (k * g.ny + j) * (g.nx + 1) + i;
  const fv = (k * (g.ny + 1) + j) * g.nx + i;
  return {
    vx: 0.5 * (st.u[fu] * g.ax[fu] + st.u[fu + 1] * g.ax[fu + 1]),
    vy: 0.5 * (st.v[fv] * g.ay[fv] + st.v[fv + g.nx] * g.ay[fv + g.nx]),
    vz: 0.5 * (st.w[k * NXY + c] * g.az[k * NXY + c] + st.w[(k + 1) * NXY + c] * g.az[(k + 1) * NXY + c]),
    k: st.k[k * NXY + c],
    layer: k,
    indoor: g.indoor[k * NXY + c] === 1,
  };
}
