/**
 * A NUMERIC TSL STUB — enough of THREE.TSL to actually EVALUATE the wind
 * field's node graphs in Node, with real numbers coming out the other end.
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHAT IT IS HONESTLY NOT
 * ============================================================================
 *
 * Until this file, `world/__tests__/wind-field.test.mjs` said outright: "`sampleWind`
 * is TSL (no fake-node harness exists in this codebase for it) — browser-verified
 * live, not unit-tested here." That was accurate and it was a real gap: the
 * whole claim that `world/wind-access.js`'s two GPU shapes (`node`, the texture
 * path, and `kernel`, the storage-buffer path) compute the SAME field rested on
 * a source comment promising the kernels "replicate sampleWind's own ambient-bias
 * formula byte-for-byte". A comment is not a test, and this project has a
 * standing rule about instruments that cannot actually measure the thing they
 * claim to (`feedback_instruments_must_not_lie`).
 *
 * WHAT THIS DOES PROVE: that the two access paths, given the same position, the
 * same clock, the same grid data and the same noise, agree. That is precisely
 * the drift this harness is aimed at — two hand-maintained copies of one
 * formula silently diverging.
 *
 * WHAT THIS DOES **NOT** PROVE, stated plainly so nobody later mistakes a green
 * test for a guarantee it never made:
 *   - It is NOT the real MaterialX noise. `mx_noise_float` here is a smooth
 *     deterministic value noise with roughly the right range and character.
 *     Absolute output values from this stub mean nothing about what a GPU
 *     produces; only AGREEMENT BETWEEN TWO PATHS through it is meaningful.
 *   - It is NOT a shader compiler. Anything that only breaks at graph-build or
 *     WGSL-generation time (a type mismatch TSL would catch, a swizzle that
 *     doesn't exist) can pass here and still fail on the GPU.
 *   - Float precision is JS doubles, not GPU 32/16-bit. Exact-equality
 *     assertions across the two paths are therefore MEANINGFUL here and would
 *     not be on hardware — which is fine, because the thing being asserted is
 *     that the two paths run the same arithmetic, not that the GPU rounds it a
 *     particular way.
 *
 * ⚠ `.mix()` AS A METHOD IS DELIBERATELY NOT IMPLEMENTED. TSL's method form
 * silently uses the RECEIVER as the interpolant, not the first argument — this
 * project's own named trap (`reference_tsl_method_chaining_trap`). A stub that
 * implemented it would let a caller write the buggy form and see it "work"
 * here, which is worse than not supporting it at all. Function form only.
 *
 * @module world/__tests__/tsl-numeric-stub
 */

/** A numeric node: 1, 2 or 4 components, with the TSL method surface the wind code uses. */
class N {
  /** @param {number[]} c */
  constructor(c) {
    this.c = c;
  }
  get x() {
    return new N([this.c[0]]);
  }
  get y() {
    return new N([this.c[1]]);
  }
  get z() {
    return new N([this.c[2]]);
  }
  get w() {
    return new N([this.c[3]]);
  }
  /** The single number, for a 1-component node. */
  get v() {
    return this.c[0];
  }
  add(o) {
    return zip(this, o, (a, b) => a + b);
  }
  sub(o) {
    return zip(this, o, (a, b) => a - b);
  }
  mul(o) {
    return zip(this, o, (a, b) => a * b);
  }
  div(o) {
    return zip(this, o, (a, b) => a / b);
  }
  negate() {
    return new N(this.c.map((a) => -a));
  }
  floor() {
    return new N(this.c.map(Math.floor));
  }
  clamp(lo, hi) {
    return clamp(this, lo, hi);
  }
  length() {
    return new N([Math.hypot(...this.c)]);
  }
}

/** Coerce a raw number / N into an N. */
function n(v) {
  return v instanceof N ? v : new N([Number(v)]);
}

/** Component-wise op with scalar broadcasting, exactly as TSL does it. */
function zip(a, b, f) {
  const A = n(a).c;
  const B = n(b).c;
  const len = Math.max(A.length, B.length);
  const out = [];
  for (let i = 0; i < len; i++) out.push(f(A.length === 1 ? A[0] : A[i], B.length === 1 ? B[0] : B[i]));
  return new N(out);
}

const float = (v) => n(v);
const int = (v) => n(v);
const vec2 = (a, b) => new N([n(a).c[0], n(b === undefined ? a : b).c[0]]);
const vec4 = (a, b, c, d) => new N([n(a).v, n(b).v, n(c).v, n(d).v]);

const dot = (a, b) => new N([n(a).c.reduce((s, v, i) => s + v * n(b).c[i], 0)]);
const length = (a) => n(a).length();
const max = (a, b) => zip(a, b, Math.max);
const min = (a, b) => zip(a, b, Math.min);
const clamp = (v, lo, hi) => zip(zip(v, lo, Math.max), hi, Math.min);
const mix = (a, b, t) =>
  zip(
    a,
    zip(
      zip(b, a, (q, p) => q - p),
      t,
      (d, s) => d * s
    ),
    (p, d) => p + d
  );
const cos = (a) => new N(n(a).c.map(Math.cos));
const sin = (a) => new N(n(a).c.map(Math.sin));

/**
 * A smooth, deterministic stand-in for MaterialX's gradient noise: bilinear-
 * interpolated hashed lattice values with a smoothstep fade, output roughly in
 * [-1, 1]. NOT the real noise (see this file's own header) — its only required
 * property is that the same input always gives the same output, so two code
 * paths sampling "the same noise" can be compared.
 */
function mx_noise_float(p) {
  const [x, y] = n(p).c;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const fade = (t) => t * t * (3 - 2 * t);
  const h = (a, b) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = fade(xf);
  const vv = fade(yf);
  const top = h(xi, yi) * (1 - u) + h(xi + 1, yi) * u;
  const bot = h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u;
  return new N([top * (1 - vv) + bot * vv]);
}

/**
 * A stub texture sample. A "texture" here is `{ sample(u, v) -> [r,g,b,a] }`,
 * so a test can hand-author the exact field it wants to assert against.
 */
function texture(tex, uv) {
  const [u, v] = n(uv).c;
  const rgba = tex.sample(u, v);
  return new N([rgba[0], rgba[1], rgba[2], rgba[3]]);
}

/** The stub TSL namespace — pass this where the real code expects `THREE.TSL`. */
export const TSL_STUB = Object.freeze({
  float,
  int,
  vec2,
  vec4,
  dot,
  length,
  max,
  min,
  clamp,
  mix,
  cos,
  sin,
  mx_noise_float,
  texture,
});

/** Unwrap an evaluated node into plain numbers. */
export function values(node) {
  return n(node).c.slice();
}

/**
 * A stub storage buffer: `.element(i)` returns the i-th vec4, matching the
 * packing both particle kernels use (x=openness, y/z=wall-away dir, w=wall
 * proximity).
 * @param {number[][]} cellsVec4
 */
export function storageBuffer(cellsVec4) {
  return {
    element(idx) {
      const i = Math.max(0, Math.min(cellsVec4.length - 1, Math.round(n(idx).v)));
      const c = cellsVec4[i] ?? [1, 0, 0, 0];
      return new N([c[0], c[1], c[2], c[3]]);
    },
  };
}

/**
 * Build a stub texture over a cell grid, sampled the way `sampleWind` does it:
 * a 0..1 UV over the whole mapped area, NEAREST (not bilinear — a test wants to
 * assert against one known cell's value, not a blend of four).
 * @param {{cols: number, rows: number}} grid
 * @param {(i: number) => number[]} rgbaAt
 */
export function gridTexture(grid, rgbaAt) {
  return {
    sample(u, v) {
      const cx = Math.min(grid.cols - 1, Math.max(0, Math.floor(u * grid.cols)));
      const cy = Math.min(grid.rows - 1, Math.max(0, Math.floor(v * grid.rows)));
      return rgbaAt(cy * grid.cols + cx);
    },
  };
}
