/**
 * Shared roof/tree drip edge logic: 4-connected opaque components, exterior flood,
 * per-component angular ordering + striding (fair multi-blob coverage), and
 * farthest-point subsampling in UV space.
 *
 * @module particles/RoofDripEdgeSampling
 */

/**
 * When true, CPU union-find / silhouette sampling is skipped (almost no drip spawn from tile alpha).
 * Full sampling is very heavy on large textures and interacts badly with frequent pool refreshes.
 * Opt-in quality: set false after tuning `pointsRefreshSec` ≥ 1–2s.
 */
export const ROOF_DRIP_EDGE_SAMPLING_DISABLED = true;

/**
 * Label 4-connected opaque components. labels[i]=0 transparent; else canonical root index.
 * @param {number} alphaChan - 0 if alpha is in buf[i*4] (GPU readback), 3 for canvas RGBA.
 */
export function labelOpaqueComponents4(buf, W, H, alphaByte, alphaChan = 0) {
  if (ROOF_DRIP_EDGE_SAMPLING_DISABLED) return new Uint32Array(W * H);
  const n = W * H;
  const parent = new Int32Array(n);
  parent.fill(-1);
  const idx = (x, y) => y * W + x;
  const a = (i) => buf[i * 4 + alphaChan];
  const find = (i) => {
    if (parent[i] < 0) return -1;
    let p = i;
    while (parent[p] !== p) p = parent[p];
    let r = i;
    while (parent[r] !== p) {
      const nxt = parent[r];
      parent[r] = p;
      r = nxt;
    }
    return p;
  };
  const unionPixels = (i, j) => {
    const ra = find(i);
    const rb = find(j);
    if (ra < 0 || rb < 0 || ra === rb) return;
    parent[rb] = ra;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      if (a(i) < alphaByte) continue;
      parent[i] = i;
      if (x > 0 && a(idx(x - 1, y)) >= alphaByte) unionPixels(i, idx(x - 1, y));
      if (y > 0 && a(idx(x, y - 1)) >= alphaByte) unionPixels(i, idx(x, y - 1));
    }
  }
  const labels = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    if (parent[i] < 0) {
      labels[i] = 0;
      continue;
    }
    let r = i;
    while (parent[r] !== r) r = parent[r];
    // 0 = transparent; opaque roots use r+1 so pixel index 0 is not treated as empty (JS falsy bug).
    labels[i] = (r + 1) >>> 0;
  }
  return labels;
}

/**
 * Centroid (sum x, sum y, count) per component root for opaque pixels.
 */
export function componentOpaqueCentroids(labels, W, H) {
  if (ROOF_DRIP_EDGE_SAMPLING_DISABLED) return new Map();
  const map = new Map();
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const root = labels[row + x];
      if (root === 0) continue;
      let c = map.get(root);
      if (!c) {
        c = { sx: 0, sy: 0, n: 0 };
        map.set(root, c);
      }
      c.sx += x;
      c.sy += y;
      c.n++;
    }
  }
  return map;
}

/**
 * Collect exterior silhouette edge pixels (opaque with 4-neighbor exterior-transparent).
 * @param {number} alphaChan - 0 = GPU packed (alpha in R), 3 = standard RGBA imageData.
 */
export function collectSilhouetteEdgePixels(
  buf,
  W,
  H,
  alphaByte,
  reach,
  outPx,
  outPy,
  maxRaw,
  scanStride,
  alphaChan = 0
) {
  if (ROOF_DRIP_EDGE_SAMPLING_DISABLED) {
    outPx.length = 0;
    outPy.length = 0;
    return;
  }
  outPx.length = 0;
  outPy.length = 0;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];

  const alphaAt = (qx, qy) => {
    if (qx < 0 || qx >= W || qy < 0 || qy >= H) return 0;
    return buf[(qy * W + qx) * 4 + alphaChan];
  };

  for (let py = 0; py < H; py += scanStride) {
    for (let px = 0; px < W; px += scanStride) {
      const i = py * W + px;
      if (buf[i * 4 + alphaChan] < alphaByte) continue;

      let edge = false;
      for (let d = 0; d < dirs.length; d++) {
        const qx = px + dirs[d][0];
        const qy = py + dirs[d][1];
        let exterior = false;
        if (qx < 0 || qx >= W || qy < 0 || qy >= H) {
          exterior = true;
        } else if (alphaAt(qx, qy) < alphaByte) {
          if (!reach || reach[qy * W + qx]) exterior = true;
        }
        if (exterior) {
          edge = true;
          break;
        }
      }
      if (!edge) continue;

      outPx.push(px);
      outPy.push(py);
      if (outPx.length >= maxRaw) return;
    }
  }
}

/**
 * Per-component polar sort + proportional K; returns interleaved px,py (screen/tex space).
 */
export function pickEvenlyPerComponentEdges(px, py, n, labels, W, centroids, targetK) {
  if (ROOF_DRIP_EDGE_SAMPLING_DISABLED) return [];
  if (n < 1 || targetK < 1) return [];

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = labels[py[i] * W + px[i]];
    if (root === 0) continue;
    let g = groups.get(root);
    if (!g) {
      g = [];
      groups.set(root, g);
    }
    g.push(i);
  }

  let total = 0;
  for (const g of groups.values()) total += g.length;
  if (total < 1) return [];

  const out = [];
  const roots = [...groups.keys()].sort((a, b) => a - b);

  for (const root of roots) {
    const g = groups.get(root);
    const m = g.length;
    const kSub = Math.max(1, Math.min(m, Math.round((targetK * m) / total)));
    const cen = centroids.get(root);
    const cx = cen && cen.n ? cen.sx / cen.n : 0;
    const cy = cen && cen.n ? cen.sy / cen.n : 0;

    const ang = new Float64Array(m);
    const rad = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const ii = g[j];
      const dx = px[ii] - cx;
      const dy = py[ii] - cy;
      ang[j] = Math.atan2(dy, dx);
      rad[j] = dx * dx + dy * dy;
    }
    const order = new Array(m);
    for (let j = 0; j < m; j++) order[j] = j;
    order.sort((a, b) => ang[a] - ang[b] || rad[a] - rad[b]);

    const K = Math.min(kSub, m);
    if (K === 1) {
      const ii = g[order[0]];
      out.push(px[ii], py[ii]);
      continue;
    }
    for (let t = 0; t < K; t++) {
      const j = m === 1 ? 0 : Math.floor((t * (m - 1)) / (K - 1));
      const ii = g[order[j]];
      out.push(px[ii], py[ii]);
    }
  }

  const nPairs = out.length / 2;
  if (nPairs > targetK && nPairs > 1) {
    const trimmed = [];
    for (let t = 0; t < targetK; t++) {
      const j = Math.floor((t * (nPairs - 1)) / Math.max(1, targetK - 1)) * 2;
      trimmed.push(out[j], out[j + 1]);
    }
    return trimmed;
  }
  return out;
}

/**
 * Farthest-point sampling in UV (stride-5 flat: u,v,nx,ny,z). Keeps first random seed, adds K-1 points.
 */
export function farthestPointSampleStride5Uv(flat, targetK) {
  if (ROOF_DRIP_EDGE_SAMPLING_DISABLED) return null;
  const n = Math.floor(flat.length / 5);
  if (n < 2 || targetK < 2) return null;
  const MAX_N = 3200;
  if (n > MAX_N) {
    const stride = Math.ceil(n / MAX_N);
    const thin = [];
    for (let i = 0; i < n; i += stride) {
      const o = i * 5;
      for (let t = 0; t < 5; t++) thin.push(flat[o + t]);
    }
    const nThin = Math.floor(thin.length / 5);
    if (nThin < 2) return null;
    return farthestPointSampleStride5Uv(thin, Math.min(targetK, nThin));
  }
  const K = Math.min(targetK, n);
  const picked = new Int32Array(K);
  picked[0] = (Math.random() * n) | 0;
  const chosen = new Uint8Array(n);
  chosen[picked[0]] = 1;

  const dist2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const du = flat[i * 5] - flat[picked[0] * 5];
    const dv = flat[i * 5 + 1] - flat[picked[0] * 5 + 1];
    dist2[i] = du * du + dv * dv;
  }

  for (let k = 1; k < K; k++) {
    let best = -1;
    let bestD = -1;
    for (let i = 0; i < n; i++) {
      if (chosen[i]) continue;
      if (dist2[i] > bestD) {
        bestD = dist2[i];
        best = i;
      }
    }
    if (best < 0) break;
    chosen[best] = 1;
    picked[k] = best;
    for (let i = 0; i < n; i++) {
      if (chosen[i]) continue;
      const du = flat[i * 5] - flat[best * 5];
      const dv = flat[i * 5 + 1] - flat[best * 5 + 1];
      const d = du * du + dv * dv;
      if (d < dist2[i]) dist2[i] = d;
    }
  }

  const out = [];
  for (let k = 0; k < K; k++) {
    const o = picked[k] * 5;
    for (let t = 0; t < 5; t++) out.push(flat[o + t]);
  }
  return out.length >= 5 ? out : null;
}
