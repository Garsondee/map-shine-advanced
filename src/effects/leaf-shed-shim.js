/**
 * LEAF SHED — A SCALAR STAND-IN FOR TSL, so the Studio can draw each leaf design with the VERY SAME
 * builders the shader uses (`leaf-shed-shape.js`), on the CPU, one pixel at a time.
 *
 * WHY (the author, 2026-10-31): she wanted "visual buttons to show each leaf design … placed alongside the
 * controls which change their visuals, because then as you change the sliders we can update the leaf shapes
 * in the previews". A hand-written canvas copy of the shapes would drift from the shader the first time
 * either changed. Instead the shape module is written against a small math surface (`float`, `vec2`,
 * `select`, `.add()`, `.mul()` …) and this file implements that surface on plain numbers: evaluating a
 * builder with `SHIM` instead of `THREE.TSL` gives the number the GPU would compute at that pixel.
 *
 * Only what the shape module uses is implemented. `select` is eager (both branches are already built), the
 * same as the shader; the shape module's `constValue` fast path lets it skip whole branches when the kind
 * or form is a known constant, which only this shim can answer.
 *
 * Pure: no DOM, no THREE — it runs in a worker (`leaf-shed-preview.worker.js`) and in Node tests.
 *
 * @module effects/leaf-shed-shim
 */

const ADD = (a, b) => a + b;
const SUB = (a, b) => a - b;
const MUL = (a, b) => a * b;
const DIV = (a, b) => a / b;

/** A value: 1–4 components. Every op broadcasts a 1-component value against a wider one. */
class V {
  constructor(c) {
    this.c = c;
  }
  get x() {
    return new V([this.c[0]]);
  }
  get y() {
    return new V([this.c[1] ?? this.c[0]]);
  }
  get z() {
    return new V([this.c[2] ?? this.c[0]]);
  }
  get w() {
    return new V([this.c[3] ?? this.c[0]]);
  }
  get xy() {
    return new V([this.c[0], this.c[1] ?? this.c[0]]);
  }
  get xyz() {
    return new V([this.c[0], this.c[1] ?? this.c[0], this.c[2] ?? this.c[0]]);
  }
  add(o) {
    return zip(this, o, ADD);
  }
  sub(o) {
    return zip(this, o, SUB);
  }
  mul(o) {
    return zip(this, o, MUL);
  }
  div(o) {
    return zip(this, o, DIV);
  }
  negate() {
    return map(this, (a) => -a);
  }
  lessThan(o) {
    return zip(this, o, (a, b) => (a < b ? 1 : 0));
  }
  lessThanEqual(o) {
    return zip(this, o, (a, b) => (a <= b ? 1 : 0));
  }
  greaterThan(o) {
    return zip(this, o, (a, b) => (a > b ? 1 : 0));
  }
  greaterThanEqual(o) {
    return zip(this, o, (a, b) => (a >= b ? 1 : 0));
  }
  and(o) {
    return zip(this, o, (a, b) => (a && b ? 1 : 0));
  }
  or(o) {
    return zip(this, o, (a, b) => (a || b ? 1 : 0));
  }
  min(o) {
    return zip(this, o, Math.min);
  }
  max(o) {
    return zip(this, o, Math.max);
  }
  clamp(lo, hi) {
    return clampV(this, lo, hi);
  }
}

const v = (x) => (x instanceof V ? x : new V([x]));
function zip(a, b, f) {
  // The hot path: two scalars (nearly every op in a leaf's distance) — no arrays walked, no broadcasting.
  const A = a instanceof V ? a.c : [a];
  const B = b instanceof V ? b.c : [b];
  if (A.length === 1 && B.length === 1) return new V([f(A[0], B[0])]);
  const n = Math.max(A.length, B.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = f(A.length === 1 ? A[0] : A[i], B.length === 1 ? B[0] : B[i]);
  return new V(out);
}
function map(a, f) {
  return new V(v(a).c.map(f));
}
function clampV(x, lo, hi) {
  return zip(zip(x, lo, Math.max), hi, Math.min);
}
const fract = (a) => a - Math.floor(a);

/** The surface `leaf-shed-shape.js` builds with, on numbers. */
export const SHIM = Object.freeze({
  /** Marks this as the scalar evaluator (the shape module's constant fast paths read it). */
  isScalarShim: true,
  /** A known constant's number, or undefined (TSL always answers undefined). */
  constValue: (x) => (x instanceof V ? x.c[0] : typeof x === 'number' ? x : undefined),
  float: (x) => v(x),
  int: (x) => v(x),
  vec2: (a, b) => (b === undefined ? new V([v(a).c[0], v(a).c[1] ?? v(a).c[0]]) : new V([v(a).c[0], v(b).c[0]])),
  vec3: (a, b, c) =>
    b === undefined ? new V([0, 1, 2].map((i) => v(a).c[i] ?? v(a).c[0])) : new V([v(a).c[0], v(b).c[0], v(c).c[0]]),
  vec4: (a, b, c, d) => new V([v(a).c[0], v(b).c[0], v(c).c[0], v(d).c[0]]),
  clamp: (x, lo, hi) => clampV(x, lo, hi),
  min: (a, b) => zip(a, b, Math.min),
  max: (a, b) => zip(a, b, Math.max),
  abs: (a) => map(a, Math.abs),
  sin: (a) => map(a, Math.sin),
  cos: (a) => map(a, Math.cos),
  exp: (a) => map(a, Math.exp),
  sqrt: (a) => map(a, (x) => Math.sqrt(Math.max(0, x))),
  floor: (a) => map(a, Math.floor),
  fract: (a) => map(a, fract),
  pow: (a, b) => zip(a, b, (x, y) => Math.pow(x, y)),
  atan: (y, x) => zip(y, x, Math.atan2),
  length: (a) => new V([Math.hypot(...v(a).c)]),
  dot: (a, b) => {
    const A = v(a).c;
    const B = v(b).c;
    let s = 0;
    for (let i = 0; i < A.length; i++) s += A[i] * (B.length === 1 ? B[0] : B[i]);
    return new V([s]);
  },
  mix: (a, b, t) => zip(zip(a, b, (x, y) => [x, y]), t, ([x, y], k) => x + (y - x) * k),
  smoothstep: (e0, e1, x) =>
    zip(zip(e0, e1, (a, b) => [a, b]), x, ([a, b], t) => {
      const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
      return k * k * (3 - 2 * k);
    }),
  select: (cond, a, b) => {
    const C = v(cond).c;
    return C[0] ? v(a) : v(b);
  },
});

/** The numbers out of a value (for the preview's pixel loop). */
export function shimNumbers(x) {
  return v(x).c;
}
