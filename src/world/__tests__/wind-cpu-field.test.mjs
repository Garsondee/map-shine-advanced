/**
 * wind-cpu-field.test.mjs — the wind on the CPU (mmp-vm1.1.15): the read-back copy CPU-side effects sample.
 *
 * Pins the three things a CPU consumer (a fire's plume, water spray) relies on: the copy's grid lines up with the
 * wind grid (same origin, 4× cells, texel centres on block centres); a padded WebGPU read-back of half floats decodes
 * to the right values in the right cells; and sampling is the GPU's bilinear-between-centres, clamped at the edge.
 */
import {
  windCpuFieldGrid,
  decodeWindCpuField,
  sampleWindCpuField,
  WIND_CPU_FIELD_DOWNSAMPLE,
} from '../wind-cpu-field.js';
import { createWindHandle } from '../wind-access.js';

export function run(t) {
  const { ok } = t;

  // The grid.
  {
    const g = windCpuFieldGrid({ originX: 100, originY: 50, cellSize: 37.5, cols: 322, rows: 224 });
    ok('copy keeps the origin', g.originX === 100 && g.originY === 50);
    ok('copy cells are 4x the wind cells', g.cellSize === 37.5 * WIND_CPU_FIELD_DOWNSAMPLE);
    ok('copy rounds the counts up', g.cols === 81 && g.rows === 56);
  }

  // Decoding a padded half-float read-back: 3 x 2 texels, rows padded to 256 bytes (128 u16).
  {
    const cols = 3;
    const rows = 2;
    const stride = 128;
    const raw = new Uint16Array(stride * (rows - 1) + cols * 4);
    // encode "half" as the value × 100 so a fake decoder can read it back exactly
    const put = (c, r, x, y) => {
      raw[r * stride + c * 4] = x * 100;
      raw[r * stride + c * 4 + 1] = y * 100;
    };
    put(0, 0, 1, 2);
    put(2, 0, 3, 4);
    put(1, 1, 5, 6);
    const { fx, fy } = decodeWindCpuField(raw, { cols, rows }, (h) => h / 100);
    ok('decodes cell (0,0)', fx[0] === 1 && fy[0] === 2);
    ok('decodes cell (2,0)', fx[2] === 3 && fy[2] === 4);
    ok('decodes cell (1,1) past the row padding', fx[4] === 5 && fy[4] === 6);
    ok('untouched cells read 0', fx[1] === 0 && fy[3] === 0);
    let threw = false;
    try {
      decodeWindCpuField(raw, { cols, rows });
    } catch {
      threw = true;
    }
    ok('a half-float read-back without a decoder throws', threw);
  }

  // Sampling: bilinear between texel centres, clamped.
  {
    const f = {
      originX: 0,
      originY: 0,
      cellSize: 10,
      cols: 2,
      rows: 1,
      fx: new Float32Array([0, 1]),
      fy: new Float32Array([2, 2]),
    };
    const mid = sampleWindCpuField(f, 10, 5);
    ok(`halfway between centres is the mean (${mid.x})`, Math.abs(mid.x - 0.5) < 1e-9 && mid.y === 2);
    const atCentre = sampleWindCpuField(f, 5, 5);
    ok('a texel centre reads that texel', atCentre.x === 0);
    const far = sampleWindCpuField(f, 1000, -500);
    ok('outside the grid reads the nearest edge', far.x === 1 && far.y === 2);
    const out = { x: 9, y: 9 };
    ok('the out object is filled and returned', sampleWindCpuField(f, 15, 5, out) === out && out.x === 1);
    ok('no copy yet reads null', sampleWindCpuField(null, 0, 0) === null);
  }

  // The handle: cpuFieldAt forwards to the viewer's sampler, and reads null with none.
  {
    const bare = createWindHandle();
    ok('a bare handle has no air on the CPU', bare.cpuFieldAt(0, 0) === null);
    const h = createWindHandle({ cpuFieldAt: (x, y, out) => Object.assign(out ?? {}, { x: x * 2, y: y * 3 }) });
    const v = h.cpuFieldAt(1, 2);
    ok('a handle forwards cpuFieldAt', v.x === 2 && v.y === 6);
  }
}
