/**
 * water-flow-potential.js — THE WATER'S CURRENT, FROM WHAT THE MAP IS (2026-11-10, Lab · River).
 *
 * Ingram, 2026-11-10: "If a _Water mask is fully white and touches the edge of the scene we consider that the link to
 * a much larger area of water (a scene edge that is entirely water might be the ocean or a deep river ...) or the
 * place where water could flow into or out of a scene. If we have a pond cut off from that then we don't want that to
 * flow in the same way the river does." And: "flow around obstacles, river bending".
 *
 * THE OLD CURRENT (`water-flow-solve.js`): one compass bearing seeded everywhere, then a pressure projection that only
 * bends it right at obstacles. A river's east-west reaches still flowed south (into their own bank), the ox-bow and
 * the ponds flowed at the river's speed, and nothing knew a body from the sea.
 *
 * THE NEW ONE is potential flow, the physics of water that cannot be squeezed, and it needs only the mask:
 *   1. {@link analyseBodies} labels every connected body of water and finds its LINKS — runs of cells on the scene's
 *      edge at `WATER_LINK_LEVEL` (fully white) or brighter. A body with a link is OPEN (a river, the sea, a bay); a
 *      body without one is CLOSED (a pond, an ox-bow): its current is zero.
 *   2. An open body is solved for a potential φ with ∇·(h ∇φ) = 0 (h = depth, from the mask's brightness, so shallows
 *      carry less and push the flow into the deep channel; dry rocks carry none) and φ held at the far-field stream
 *      φ = u·x on its links: the compass bearing u is how the water crosses the scene as a whole, and the solution
 *      carries it through the bends of the actual channel. Velocity = ∇φ (normalised: 1 = the free stream).
 *   What falls out, with no further rules: flow runs ALONG a channel, round every bend; speeds up where it narrows
 *   and between rocks, slows in a wide pool, stagnates behind an obstacle and in a bay's dead end; a closed pond is
 *   still; the sea, open on its edges, flows at the free stream.
 *
 * SHALLOW FRICTION: a shallow reach flows slower than the deep core beside it (bank and bar), `shallowFriction`.
 *
 * Pure JS (Node-testable, `CONVENTIONS.md` §4). The solve is a multigrid-initialised conjugate gradient written as a
 * generator, so a scene load spreads it over frames; the result is published into the flow pack by
 * `water-flow-subsystem.js`.
 *
 * @module effects/water/water-flow-potential
 */

/** Depth (0..1 mask value) below which a cell is dry land. */
export const WATER_PRESENCE = 0.04;
/** An edge cell this bright (of 255) or brighter is a LINK: "fully white, touching the edge of the scene". */
export const WATER_LINK_LEVEL = 0.8;
/** A body needs this many link cells (on the potential grid) to count as open. */
export const WATER_LINK_MIN_CELLS = 3;
/** The potential grid's long side, cells. */
export const WATER_POTENTIAL_GRID_MAX_DIM = 512;
/** The pack stores speed as |v| / this (the old pack's headroom: a mid-stream rapid may run 2.5× the free stream). */
export const WATER_POTENTIAL_SPEED_HEADROOM = 2.5;
/** Depth (0..1) at and above which a reach flows at its full potential speed; shallower reaches slow by √(h/this). */
export const WATER_SHALLOW_REF = 0.35;
/** The slowest a wet cell goes, as a share of its potential speed (no cell is frozen by friction alone). */
export const WATER_SHALLOW_FLOOR = 0.15;
/** Lowest depth a wet cell conducts with (keeps the system solvable where the mask just touches presence). */
const H_MIN = 0.03;

/** Mask bytes (R, 0..255, w×h) → depth 0..1 on a gw×gh grid, by area averaging (≤ 6×6 taps a cell). Pure. */
export function downsampleDepth(data, w, h, gw, gh, stride = 1) {
  const out = new Float32Array(gw * gh);
  const sx = w / gw;
  const sy = h / gh;
  const nx = Math.max(1, Math.min(6, Math.floor(sx)));
  const ny = Math.max(1, Math.min(6, Math.floor(sy)));
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      let acc = 0;
      for (let b = 0; b < ny; b++) {
        const y = Math.min(h - 1, Math.floor(j * sy + ((b + 0.5) / ny) * sy));
        for (let a = 0; a < nx; a++) {
          const x = Math.min(w - 1, Math.floor(i * sx + ((a + 0.5) / nx) * sx));
          acc += data[(y * w + x) * stride];
        }
      }
      out[j * gw + i] = acc / (nx * ny * 255);
    }
  }
  return out;
}

/** The flow grid for a world rect: aspect-preserving, `WATER_POTENTIAL_GRID_MAX_DIM` on the long side. */
export function potentialGridDims(rectW, rectH, maxDim = WATER_POTENTIAL_GRID_MAX_DIM) {
  const s = maxDim / Math.max(1, rectW, rectH);
  return { gw: Math.max(8, Math.round(rectW * s)), gh: Math.max(8, Math.round(rectH * s)) };
}

/**
 * Label the connected bodies of water (4-neighbour) and find each one's links on the scene edge.
 * @param {Float32Array} depth - gw×gh, 0..1
 * @returns {{labels: Int32Array, bodies: Array<{id:number, cells:number, linkCells:number, open:boolean,
 *   links: Array<{edge:'N'|'S'|'W'|'E', cells:number, centre:number}>}>}} labels: 0 = land, else body id (1-based).
 */
export function analyseBodies(depth, gw, gh, { presence = WATER_PRESENCE, linkLevel = WATER_LINK_LEVEL, minLink = WATER_LINK_MIN_CELLS } = {}) {
  const labels = new Int32Array(gw * gh);
  const bodies = [];
  const queue = new Int32Array(gw * gh);
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] !== 0 || depth[start] <= presence) continue;
    const id = bodies.length + 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = id;
    let cells = 0;
    while (head < tail) {
      const p = queue[head++];
      cells++;
      const i = p % gw;
      const j = (p - i) / gw;
      if (i > 0 && !labels[p - 1] && depth[p - 1] > presence) (labels[p - 1] = id), (queue[tail++] = p - 1);
      if (i < gw - 1 && !labels[p + 1] && depth[p + 1] > presence) (labels[p + 1] = id), (queue[tail++] = p + 1);
      if (j > 0 && !labels[p - gw] && depth[p - gw] > presence) (labels[p - gw] = id), (queue[tail++] = p - gw);
      if (j < gh - 1 && !labels[p + gw] && depth[p + gw] > presence) (labels[p + gw] = id), (queue[tail++] = p + gw);
    }
    bodies.push({ id, cells, linkCells: 0, open: false, links: [] });
  }
  const addLink = (body, edge, run) => {
    if (run.n === 0) return;
    body.links.push({ edge, cells: run.n, centre: run.sum / run.n });
    body.linkCells += run.n;
  };
  const sweep = (edge, count, cellAt, posOf) => {
    let cur = null;
    let run = { n: 0, sum: 0 };
    for (let k = 0; k < count; k++) {
      const p = cellAt(k);
      const lab = labels[p];
      if (lab && depth[p] >= linkLevel) {
        if (cur !== lab) {
          if (cur) addLink(bodies[cur - 1], edge, run);
          cur = lab;
          run = { n: 0, sum: 0 };
        }
        run.n++;
        run.sum += posOf(k);
      } else {
        if (cur) addLink(bodies[cur - 1], edge, run);
        cur = null;
        run = { n: 0, sum: 0 };
      }
    }
    if (cur) addLink(bodies[cur - 1], edge, run);
  };
  sweep('N', gw, (k) => k, (k) => k / gw);
  sweep('S', gw, (k) => (gh - 1) * gw + k, (k) => k / gw);
  sweep('W', gh, (k) => k * gw, (k) => k / gh);
  sweep('E', gh, (k) => k * gw + gw - 1, (k) => k / gh);
  for (const b of bodies) b.open = b.linkCells >= minLink;
  return { labels, bodies };
}

/** One level of the potential problem: conductances, the unknowns and the held (link) cells. */
function buildProblem(depth, gw, gh, f, dir, opts) {
  const n = gw * gh;
  const { labels, bodies } = analyseBodies(depth, gw, gh, opts);
  const h = new Float32Array(n);
  for (let p = 0; p < n; p++) if (labels[p]) h[p] = Math.max(H_MIN, (depth[p] - WATER_PRESENCE) / (1 - WATER_PRESENCE));
  const open = new Uint8Array(bodies.length + 1);
  for (const b of bodies) open[b.id] = b.open ? 1 : 0;
  // kind: 0 = not solved (land, or a closed body), 1 = unknown, 2 = held at the far-field stream
  const kind = new Uint8Array(n);
  const held = new Float64Array(n);
  const bg = new Float64Array(n);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const p = j * gw + i;
      bg[p] = dir[0] * (i + 0.5) * f + dir[1] * (j + 0.5) * f;
      const lab = labels[p];
      if (!lab || !open[lab]) continue;
      const onEdge = i === 0 || j === 0 || i === gw - 1 || j === gh - 1;
      if (onEdge && depth[p] >= WATER_LINK_LEVEL) {
        kind[p] = 2;
        held[p] = bg[p];
      } else kind[p] = 1;
    }
  }
  // face conductances (harmonic mean of the two depths; 0 across land)
  const cE = new Float32Array(n);
  const cS = new Float32Array(n);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const p = j * gw + i;
      if (!kind[p]) continue;
      if (i < gw - 1 && kind[p + 1]) cE[p] = (2 * h[p] * h[p + 1]) / (h[p] + h[p + 1]);
      if (j < gh - 1 && kind[p + gw]) cS[p] = (2 * h[p] * h[p + gw]) / (h[p] + h[p + gw]);
    }
  }
  const diag = new Float64Array(n);
  const rhs = new Float64Array(n);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const p = j * gw + i;
      if (kind[p] !== 1) continue;
      const cw = i > 0 ? cE[p - 1] : 0;
      const ce = cE[p];
      const cn = j > 0 ? cS[p - gw] : 0;
      const cs = cS[p];
      diag[p] = cw + ce + cn + cs;
      if (kind[p - 1] === 2 && i > 0) rhs[p] += cw * held[p - 1];
      if (i < gw - 1 && kind[p + 1] === 2) rhs[p] += ce * held[p + 1];
      if (j > 0 && kind[p - gw] === 2) rhs[p] += cn * held[p - gw];
      if (j < gh - 1 && kind[p + gw] === 2) rhs[p] += cs * held[p + gw];
    }
  }
  return { gw, gh, n, f, h, kind, held, bg, cE, cS, diag, rhs, bodies, labels };
}

/** y = A x on the unknown cells (zero elsewhere). */
function applyA(P, x, y) {
  const { gw, gh, kind, cE, cS, diag } = P;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const p = j * gw + i;
      if (kind[p] !== 1) {
        y[p] = 0;
        continue;
      }
      let s = diag[p] * x[p];
      if (i > 0 && kind[p - 1] === 1) s -= cE[p - 1] * x[p - 1];
      if (i < gw - 1 && kind[p + 1] === 1) s -= cE[p] * x[p + 1];
      if (j > 0 && kind[p - gw] === 1) s -= cS[p - gw] * x[p - gw];
      if (j < gh - 1 && kind[p + gw] === 1) s -= cS[p] * x[p + gw];
      y[p] = s;
    }
  }
}

/** Preconditioned CG on one level, as a generator yielding cell-updates of work done. Returns {its, rel}. */
function* cgLevel(P, phi, { tol = 1e-4, maxIts = 400, chunk = 8 } = {}) {
  const { n, kind, diag, rhs } = P;
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const d = new Float64Array(n);
  const q = new Float64Array(n);
  applyA(P, phi, q);
  let bn = 0;
  let rz = 0;
  for (let p = 0; p < n; p++) {
    if (kind[p] !== 1) continue;
    r[p] = rhs[p] - q[p];
    bn += rhs[p] * rhs[p];
    z[p] = r[p] / diag[p];
    d[p] = z[p];
    rz += r[p] * z[p];
  }
  bn = Math.sqrt(bn) || 1;
  let rel = Math.sqrt(rz) / bn;
  let its = 0;
  const cells = P.gw * P.gh;
  while (its < maxIts) {
    applyA(P, d, q);
    let dq = 0;
    for (let p = 0; p < n; p++) if (kind[p] === 1) dq += d[p] * q[p];
    if (!(dq > 0)) break;
    const alpha = rz / dq;
    let rn = 0;
    let rzNew = 0;
    for (let p = 0; p < n; p++) {
      if (kind[p] !== 1) continue;
      phi[p] += alpha * d[p];
      r[p] -= alpha * q[p];
      z[p] = r[p] / diag[p];
      rn += r[p] * r[p];
      rzNew += r[p] * z[p];
    }
    its++;
    rel = Math.sqrt(rn) / bn;
    if (rel < tol) break;
    const beta = rzNew / rz;
    rz = rzNew;
    for (let p = 0; p < n; p++) if (kind[p] === 1) d[p] = z[p] + beta * d[p];
    if (its % chunk === 0) yield cells * chunk;
  }
  return { its, rel };
}

/** Bilinear upsample of a coarse φ (cell-centred, coarse grid cw×ch) onto the fine grid gw×gh. */
function upsample(coarse, cw, ch, gw, gh) {
  const out = new Float64Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    const fy = Math.min(ch - 1, Math.max(0, ((j + 0.5) * ch) / gh - 0.5));
    const j0 = Math.floor(fy);
    const j1 = Math.min(ch - 1, j0 + 1);
    const ty = fy - j0;
    for (let i = 0; i < gw; i++) {
      const fx = Math.min(cw - 1, Math.max(0, ((i + 0.5) * cw) / gw - 0.5));
      const i0 = Math.floor(fx);
      const i1 = Math.min(cw - 1, i0 + 1);
      const tx = fx - i0;
      out[j * gw + i] =
        (coarse[j0 * cw + i0] * (1 - tx) + coarse[j0 * cw + i1] * tx) * (1 - ty) +
        (coarse[j1 * cw + i0] * (1 - tx) + coarse[j1 * cw + i1] * tx) * ty;
    }
  }
  return out;
}

/** Area-average a depth field to half size (for the coarse levels of the cascade). */
function halve(depth, gw, gh) {
  const cw = Math.max(8, Math.ceil(gw / 2));
  const ch = Math.max(8, Math.ceil(gh / 2));
  const out = new Float32Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const i0 = Math.min(gw - 1, 2 * i);
      const i1 = Math.min(gw - 1, 2 * i + 1);
      const j0 = Math.min(gh - 1, 2 * j);
      const j1 = Math.min(gh - 1, 2 * j + 1);
      out[j * cw + i] = (depth[j0 * gw + i0] + depth[j0 * gw + i1] + depth[j1 * gw + i0] + depth[j1 * gw + i1]) / 4;
    }
  }
  return { depth: out, gw: cw, gh: ch };
}

/**
 * THE SOLVE, as a generator: yields cell-updates of work done so the caller can spread it over frames; returns
 * `{vx, vy, speed01, rgba, bodies, stats}` on the potential grid.
 *
 * @param {object} o
 * @param {Float32Array} o.depth - gw×gh depth, 0..1 (`downsampleDepth`)
 * @param {number} o.gw @param {number} o.gh
 * @param {number[]} o.dir - the bearing as a unit vector in world axes (y down), `waterFlowVector`
 * @param {number} [o.levels] - cascade levels (the coarsest is 1/2^(levels−1) of the finest)
 * @param {number} [o.shallowFriction] - 0..1, how much shallow reaches slow (1 = full)
 */
export function* solvePotentialFlowSteps({ depth, gw, gh, dir, levels = 3, shallowFriction = 1, tol = 1e-4, maxIts = 500 }) {
  // the cascade, finest first
  const pyramid = [{ depth, gw, gh, f: 1 }];
  for (let l = 1; l < levels; l++) {
    const prev = pyramid[l - 1];
    if (prev.gw <= 24 || prev.gh <= 24) break;
    const c = halve(prev.depth, prev.gw, prev.gh);
    pyramid.push({ ...c, f: prev.f * 2 });
  }
  let phi = null;
  let P = null;
  const stats = { levels: pyramid.length, its: [], rel: [] };
  for (let l = pyramid.length - 1; l >= 0; l--) {
    const lv = pyramid[l];
    P = buildProblem(lv.depth, lv.gw, lv.gh, lv.f, dir, {});
    yield lv.gw * lv.gh;
    const start = new Float64Array(P.n);
    if (phi) {
      const up = upsample(phi.arr, phi.gw, phi.gh, lv.gw, lv.gh);
      for (let p = 0; p < P.n; p++) start[p] = P.kind[p] === 1 ? up[p] : P.kind[p] === 2 ? P.held[p] : P.bg[p];
    } else {
      for (let p = 0; p < P.n; p++) start[p] = P.kind[p] === 2 ? P.held[p] : P.bg[p];
    }
    const res = yield* cgLevel(P, start, { tol, maxIts });
    stats.its.push(res.its);
    stats.rel.push(+res.rel.toExponential(2));
    phi = { arr: start, gw: lv.gw, gh: lv.gh };
  }
  // velocity at the finest level: the mean of the open faces' gradients (φ is in fine-cell units, so 1 = free stream)
  const { kind, cE, cS, h } = P;
  const vx = new Float32Array(P.n);
  const vy = new Float32Array(P.n);
  const sp = new Float32Array(P.n);
  const rgba = new Float32Array(P.n * 4);
  const f = phi.arr;
  const field = (p) => (kind[p] === 2 ? P.held[p] : f[p]);
  let maxSp = 0;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const p = j * gw + i;
      if (!kind[p]) continue;
      let sx = 0;
      let nx = 0;
      let sy = 0;
      let ny = 0;
      if (i > 0 && cE[p - 1] > 0) (sx += field(p) - field(p - 1)), nx++;
      if (i < gw - 1 && cE[p] > 0) (sx += field(p + 1) - field(p)), nx++;
      if (j > 0 && cS[p - gw] > 0) (sy += field(p) - field(p - gw)), ny++;
      if (j < gh - 1 && cS[p] > 0) (sy += field(p + gw) - field(p)), ny++;
      let ux = nx ? sx / nx : 0;
      let uy = ny ? sy / ny : 0;
      const fr = Math.max(WATER_SHALLOW_FLOOR, Math.sqrt(Math.min(1, h[p] / WATER_SHALLOW_REF)));
      const k = 1 - shallowFriction * (1 - fr);
      ux *= k;
      uy *= k;
      vx[p] = ux;
      vy[p] = uy;
      const s = Math.hypot(ux, uy);
      sp[p] = s;
      if (s > maxSp) maxSp = s;
    }
    if (j % 32 === 31) yield gw * 32;
  }
  for (let p = 0; p < P.n; p++) {
    rgba[p * 4] = vx[p];
    rgba[p * 4 + 1] = vy[p];
    rgba[p * 4 + 2] = Math.min(1, sp[p] / WATER_POTENTIAL_SPEED_HEADROOM);
    rgba[p * 4 + 3] = P.labels[p] ? 0 : 1;
  }
  stats.maxSpeed = +maxSp.toFixed(3);
  return { gw, gh, vx, vy, speed: sp, rgba, bodies: P.bodies, labels: P.labels, stats };
}

/** Run the whole solve now (tests, tools). */
export function solvePotentialFlow(o) {
  const g = solvePotentialFlowSteps(o);
  for (;;) {
    const s = g.next();
    if (s.done) return s.value;
  }
}
