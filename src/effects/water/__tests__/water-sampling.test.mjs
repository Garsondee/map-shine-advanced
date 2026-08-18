/**
 * water-sampling.test.mjs — THE SMOOTH RECONSTRUCTION KEEPS ITS TWO PROMISES.
 *
 * The remap in `water-sampling.js` is the cure for the author's reported
 * staircase edges, and it is the kind of fix that can silently do harm: it
 * changes where a coarse field is SAMPLED, and every distance-derived term in
 * water (the depth ramp, the wet band, the foam's shoaling gate, the flow
 * tangent) trusts that field to be metric. So the two properties that make it
 * safe are asserted rather than assumed:
 *
 *   1. **texel centres are fixed points** — the field's own measured values are
 *      untouched, so no distance this pack reports moves. Only the interpolation
 *      BETWEEN texels changes, which is the only place a crease can live.
 *   2. **the remap never leaves its own texel** — so it cannot reach past a
 *      neighbour and cannot widen the field's effective blur.
 *
 * Plus the one that is the whole point: the reconstruction's DERIVATIVE is
 * continuous across a texel boundary, where plain bilinear's is not. That is
 * measurable in Node with finite differences and is what a GPU screenshot could
 * only ever suggest.
 */
import { quintic, smoothTexelUv } from '../water-sampling.js';

export function run(t) {
  const { ok } = t;
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

  // ── THE EASING CURVE ───────────────────────────────────────────────────
  ok('quintic(0) is 0 and quintic(1) is 1 — the ends are fixed', quintic(0) === 0 && quintic(1) === 1);
  ok('quintic(0.5) is 0.5 — symmetric, so it biases nothing', near(quintic(0.5), 0.5));
  // The reason it is quintic and not the cubic smoothstep: the SECOND
  // derivative also vanishes at the ends. That is what makes the reconstruction
  // C2 across a texel boundary rather than merely C1, and a merely-C1 join
  // still shows under a lobe as sharp as tier 3's.
  const d2 = (f, x, h = 1e-4) => (f(x + h) - 2 * f(x) + f(x - h)) / (h * h);
  ok(
    "quintic's curvature vanishes at both ends — the C2 property",
    near(d2(quintic, 0), 0, 1e-3) && near(d2(quintic, 1), 0, 1e-3)
  );

  // ── PROMISE 1: TEXEL CENTRES ARE FIXED POINTS ──────────────────────────
  const W = 512;
  const H = 238;
  let centresFixed = true;
  for (let i = 0; i < W; i += 37) {
    const u = (i + 0.5) / W;
    const [u2] = smoothTexelUv(u, 0.5, W, H);
    if (!near(u2, u, 1e-12)) centresFixed = false;
  }
  ok('every texel CENTRE maps to itself — no sampled value of the field changes', centresFixed);

  // ── PROMISE 2: THE REMAP STAYS INSIDE ITS OWN TEXEL ─────────────────────
  let stayedHome = true;
  for (let i = 0; i < 2000; i++) {
    const u = i / 2000;
    const [u2] = smoothTexelUv(u, u, W, H);
    // Same texel index before and after, measured the way the hardware does
    // (centre-anchored). A remap that crossed a boundary would be reaching a
    // texel the plain filter never touches.
    if (Math.floor(u * W - 0.5) !== Math.floor(u2 * W - 0.5)) stayedHome = false;
  }
  ok('the remap never crosses into a neighbouring texel — it cannot widen the field', stayedHome);

  // ── THE POINT: A CONTINUOUS DERIVATIVE ACROSS A BOUNDARY ────────────────
  // A LINEAR-filtered field reads `lerp(a, b, frac)`, so its slope in u is
  // `(b − a) · W` inside one texel and `(c − b) · W` inside the next: a JUMP at
  // the boundary whenever the field is not locally straight. Model that with a
  // deliberately non-straight field and measure the slope either side.
  const field = (i) => [0, 0, 1, 3, 6][Math.max(0, Math.min(4, i))]; // curved on purpose
  const sampleLinear = (u, size) => {
    const p = u * size - 0.5;
    const i = Math.floor(p);
    const f = p - i;
    return field(i) * (1 - f) + field(i + 1) * f;
  };
  const sampleSmooth = (u, size) => {
    const [u2] = smoothTexelUv(u, 0.5, size, size);
    return sampleLinear(u2, size);
  };
  const SIZE = 5;
  const boundary = 2.5 / SIZE; // exactly a texel centre, where two linear segments meet
  const h = 1e-5;
  const slope = (f, x) => (f(x + h, SIZE) - f(x - h, SIZE)) / (2 * h);
  const linJump = Math.abs(
    (sampleLinear(boundary + h, SIZE) - sampleLinear(boundary, SIZE)) / h -
      (sampleLinear(boundary, SIZE) - sampleLinear(boundary - h, SIZE)) / h
  );
  ok('plain bilinear DOES crease at a texel boundary — the artefact is real, not imagined', linJump > 1);
  const smoothSlopeAt = Math.abs(slope(sampleSmooth, boundary));
  ok('the smooth reconstruction has ZERO slope exactly at the boundary — no crease to amplify', smoothSlopeAt < 1e-3);

  // Monotone data must stay monotone: an eased fraction that overshot would
  // manufacture a local maximum in a DISTANCE field, i.e. a phantom shoreline.
  const rising = (i) => Math.max(0, Math.min(4, i));
  const sampleRising = (u) => {
    const [u2] = smoothTexelUv(u, 0.5, SIZE, SIZE);
    const p = u2 * SIZE - 0.5;
    const i = Math.floor(p);
    const f = p - i;
    return rising(i) * (1 - f) + rising(i + 1) * f;
  };
  let monotone = true;
  let prev = -Infinity;
  for (let i = 0; i <= 1000; i++) {
    const v = sampleRising(i / 1000);
    if (v < prev - 1e-12) monotone = false;
    prev = v;
  }
  ok('a monotone field stays monotone — no overshoot, so no phantom shoreline', monotone);

  // ── THE GUARDS ─────────────────────────────────────────────────────────
  // An unallocated field reports 0×0. Dividing by it would poison every
  // downstream distance with Inf/NaN, which renders as a black quad rather than
  // as an error anyone can trace.
  ok('a 0-sized field returns the UV unchanged rather than NaN', smoothTexelUv(0.3, 0.7, 0, 0)[0] === 0.3);
  ok('a non-finite size does the same', smoothTexelUv(0.3, 0.7, NaN, 10)[1] === 0.7);
  const [su, sv] = smoothTexelUv(0.25, 0.75, W, H);
  ok(
    'u and v are eased INDEPENDENTLY — a separable filter needs a separable remap',
    Number.isFinite(su) && Number.isFinite(sv) && su !== sv
  );
}
