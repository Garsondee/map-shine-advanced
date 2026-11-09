/**
 * world/wind-cpu-field.js — THE WIND ON THE CPU (mmp-vm1.1.15, 2026-11-09).
 *
 * Effects that decide on the CPU (the fire's smoke and flame plan, water spray's push, the flies' drive, window rain's
 * per-window gust) could only read the GM's dial: one direction and one speed for the whole map, no shelter, no gusts.
 * The wind itself lives on the GPU (the baked field, or Living Wind's solver), so the viewer copies it back a few
 * times a second, 4× smaller, without ever waiting for it (one asynchronous read-back in flight at a time), and this
 * module turns the copy into numbers and answers "what is the air doing at (x, y)" with the same bilinear filter the
 * GPU readers use. The copy is at most a few frames old, which is far below anything a CPU consumer eases over.
 *
 * Units are the field's own (dial units: × 70 = m/s), exactly what `windHandle.node()` returns on the GPU.
 *
 * PURE — the THREE pieces (the downsample material) take THREE injected; the read-back itself lives in vt/
 * (`readRenderTargetPixelsAsync` is walled there).
 *
 * @module world/wind-cpu-field
 */

/** The copy is this many times smaller than the wind grid on each axis (a 4×4 box per texel). */
export const WIND_CPU_FIELD_DOWNSAMPLE = 4;
/** A new copy is started every this many frames (one in flight at a time) — about 10 per second at 60 fps. */
export const WIND_CPU_FIELD_EVERY_FRAMES = 6;

/**
 * The copy's grid for a wind grid: same origin, `down`× the cell size, the cell counts rounded up.
 * @param {{originX:number, originY:number, cellSize:number, cols:number, rows:number}} g
 * @param {number} [down]
 */
export function windCpuFieldGrid(g, down = WIND_CPU_FIELD_DOWNSAMPLE) {
  const d = Math.max(1, Math.floor(down));
  return {
    originX: g.originX,
    originY: g.originY,
    cellSize: g.cellSize * d,
    cols: Math.max(1, Math.ceil(g.cols / d)),
    rows: Math.max(1, Math.ceil(g.rows / d)),
    down: d,
  };
}

/**
 * Decode a read-back of an RGBA (half-)float target into two Float32Arrays. WebGPU pads each copied row to 256 bytes,
 * so the row stride is derived from what came back.
 * @param {Uint16Array|Float32Array} raw
 * @param {{cols:number, rows:number}} size
 * @param {(h:number) => number} [fromHalf] - half-float decoder (THREE.DataUtils.fromHalfFloat) for a Uint16Array.
 * @returns {{fx: Float32Array, fy: Float32Array}}
 */
export function decodeWindCpuField(raw, { cols, rows }, fromHalf = null) {
  const n = cols * rows;
  const fx = new Float32Array(n);
  const fy = new Float32Array(n);
  const half = raw instanceof Uint16Array;
  if (half && typeof fromHalf !== 'function') throw new TypeError('decodeWindCpuField: a Uint16Array needs fromHalf');
  const stride = rows > 1 ? (raw.length - cols * 4) / (rows - 1) : cols * 4;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const o = r * stride + c * 4;
      const x = half ? fromHalf(raw[o]) : raw[o];
      const y = half ? fromHalf(raw[o + 1]) : raw[o + 1];
      fx[r * cols + c] = Number.isFinite(x) ? x : 0;
      fy[r * cols + c] = Number.isFinite(y) ? y : 0;
    }
  }
  return { fx, fy };
}

/**
 * The field at a world point: bilinear between texel centres (`origin + (c + ½)·cellSize`), clamped to the edge —
 * the same filter `sampleBakedWindField` uses on the GPU. `out` is reused when given (no allocation per call).
 * @param {{originX:number, originY:number, cellSize:number, cols:number, rows:number, fx: Float32Array, fy: Float32Array}|null} f
 * @param {number} x @param {number} y
 * @param {{x:number, y:number}} [out]
 * @returns {{x:number, y:number}|null} dial units; null when there is no copy yet.
 */
export function sampleWindCpuField(f, x, y, out = { x: 0, y: 0 }) {
  if (!f || !f.fx || !f.fy || !(f.cols > 0) || !(f.rows > 0)) return null;
  const u = (x - f.originX) / f.cellSize - 0.5;
  const v = (y - f.originY) / f.cellSize - 0.5;
  const cu = Math.min(f.cols - 1, Math.max(0, u));
  const cv = Math.min(f.rows - 1, Math.max(0, v));
  const c0 = Math.floor(cu);
  const r0 = Math.floor(cv);
  const c1 = Math.min(f.cols - 1, c0 + 1);
  const r1 = Math.min(f.rows - 1, r0 + 1);
  const tx = cu - c0;
  const ty = cv - r0;
  const i00 = r0 * f.cols + c0;
  const i10 = r0 * f.cols + c1;
  const i01 = r1 * f.cols + c0;
  const i11 = r1 * f.cols + c1;
  const lerp = (a, b, t) => a + (b - a) * t;
  out.x = lerp(lerp(f.fx[i00], f.fx[i10], tx), lerp(f.fx[i01], f.fx[i11], tx), ty);
  out.y = lerp(lerp(f.fy[i00], f.fy[i10], tx), lerp(f.fy[i01], f.fy[i11], tx), ty);
  return out;
}

/**
 * The downsample pass: each texel of the small target averages the 4×4 block of the wind grid under it with four
 * bilinear taps (each tap lands on a texel corner and averages 2×2). THREE injected.
 * @param {*} THREE
 * @param {{fieldTexture:*, cols:number, rows:number}} a - the full-size field and ITS cell counts.
 * @returns {{material:*, quad:*, sourceNodes: Array<*>}}
 */
export function buildWindCpuFieldDownsample(THREE, { fieldTexture, cols, rows }) {
  const TSL = THREE.TSL;
  const { texture, uv, vec2, vec4, float, clamp } = TSL;
  const uv0 = uv();
  const tx = 1 / Math.max(1, cols);
  const ty = 1 / Math.max(1, rows);
  const nodes = [];
  let sum = null;
  for (const [dx, dy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const n = texture(fieldTexture, clamp(uv0.add(vec2(dx * tx, dy * ty)), vec2(0, 0), vec2(1, 1)));
    nodes.push(n);
    sum = sum === null ? n.xy : sum.add(n.xy);
  }
  const material = new THREE.NodeMaterial();
  material.name = 'wind.cpu.downsample';
  material.fragmentNode = vec4(sum.mul(float(0.25)), 0, 1);
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  return { material, quad: new THREE.QuadMesh(material), sourceNodes: nodes };
}
