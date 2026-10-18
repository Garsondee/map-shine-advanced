/**
 * THE EXACT EUCLIDEAN DISTANCE TRANSFORM, ON A BYTE GRID — one implementation.
 *
 * Pure math over typed arrays; no THREE, no GPU, Node-tested. It lived inside
 * `effects/critters/critter-zone.js` until a second consumer (the rain-on-glass
 * flow field, `effects/window/window-rain-flow.js`) needed the same transform:
 * two private copies of a 60-line algorithm is how a sign error ends up in one
 * of them, so it moved here verbatim and both import it.
 *
 * @module scene/grid-edt
 */

/**
 * A stand-in for "no source" in the distance transform. Finite on purpose: with
 * Infinity the parabola intersection `(f[q]+q²) − (f[p]+p²)` becomes ∞−∞ = NaN.
 * 1e12 is large against any grid (a 512-cell side squares to 2.6e5) yet small
 * enough that float64 still resolves the q² terms exactly.
 */
export const EDT_INF = 1e12;

/**
 * One 1D pass of the exact squared-distance transform (Felzenszwalb &
 * Huttenlocher 2012, "Distance Transforms of Sampled Functions", fig. 1).
 * `f` holds 0 at sources and EDT_INF elsewhere (later passes feed it partial
 * results); `out` receives the squared distance to the nearest source along the
 * line. `v`/`z` are caller-owned scratch so the 2D driver allocates once.
 *
 * @param {Float64Array} f @param {number} n @param {Float64Array} out
 * @param {Int32Array} v @param {Float64Array} z
 */
function distance1d(f, n, out, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -EDT_INF;
  z[1] = EDT_INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = EDT_INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    out[q] = d * d + f[v[k]];
  }
}

/**
 * Squared Euclidean distance (in CELLS) from every cell to the nearest cell whose
 * `isSource` flag is 1. Two separable passes, O(cells).
 *
 * @param {Uint8Array} isSource - cols*rows, 1 = distance 0.
 * @param {number} cols @param {number} rows
 * @returns {Float64Array} cols*rows squared distances (≥ EDT_INF/2 means "no source anywhere").
 */
export function squaredDistanceField(isSource, cols, rows) {
  const out = new Float64Array(cols * rows);
  const maxSide = Math.max(cols, rows);
  const f = new Float64Array(maxSide);
  const d = new Float64Array(maxSide);
  const v = new Int32Array(maxSide);
  const z = new Float64Array(maxSide + 1);
  // Columns first: vertical distance to the nearest source in the same column.
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) f[y] = isSource[y * cols + x] ? 0 : EDT_INF;
    distance1d(f, rows, d, v, z);
    for (let y = 0; y < rows; y++) out[y * cols + x] = d[y];
  }
  // Then rows, feeding the vertical result in as the sampled function.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) f[x] = out[y * cols + x];
    distance1d(f, cols, d, v, z);
    for (let x = 0; x < cols; x++) out[y * cols + x] = d[x];
  }
  return out;
}
