/**
 * auto-exposure-compress.test.mjs — the range compressor (2026-11-04). Measured over eight maps:
 * almost nothing ever passes white, so "unrealistically bright" is a RANGE problem (lamp pools
 * 3-4.5 stops over a dark room). The compressor's promises: off inside the range, never touch the
 * middle and shadows, keep brightness order, shrink only `strength` of the excess, and never crush.
 */
import {
  AUTO_EXPOSURE_DEFAULTS as D,
  COMPRESS_KNEE_STOPS,
  MIN_COMPRESS_RATIO,
  rangeCompression,
  compressGain,
} from '../auto-exposure.js';

const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

export function run(t) {
  const m = 0.03;
  const st = (rangeStops) => ({ p50: m, p99: m * 2 ** rangeStops });

  t.ok('inside the light range it is exactly off', rangeCompression(st(3), 0, D).ratio === 1);
  t.ok('no meter answer = off', rangeCompression(null, 0, D).ratio === 1);
  t.ok('strength 0 = off', rangeCompression(st(6), 0, { ...D, strength: 0 }).ratio === 1);
  t.ok('lightRange 8 never compresses a 6-stop scene', rangeCompression(st(6), 0, { ...D, lightRange: 8 }).ratio === 1);

  const c = rangeCompression(st(5), 0, D);
  t.ok('a 5-stop scene (lamps over a dark room) is compressed', c.ratio < 1);
  t.ok('the knee sits two stops over the median', near(c.knee, m * 2 ** COMPRESS_KNEE_STOPS));
  // What the brightest light reads after compression, in stops over the median.
  const hOut = Math.log2((m * 32 * compressGain(m * 32, c.knee, c.ratio)) / m);
  const want = 5 - D.strength * (5 - D.lightRange);
  t.ok('the range shrinks by strength × the excess (5 → 5 − 0.6 × 1.5)', near(hOut, want, 0.02));
  t.ok('…so the lamps are still well above the room (drama kept)', hOut > D.lightRange);

  t.ok('the middle tone is untouched', compressGain(m, c.knee, c.ratio) === 1);
  t.ok('shadows are untouched', compressGain(m / 8, c.knee, c.ratio) === 1);
  t.ok('a stop over the middle is untouched', compressGain(m * 2, c.knee, c.ratio) === 1);
  const order = [3, 3.5, 4, 5, 6, 8].map((s) => m * 2 ** s * compressGain(m * 2 ** s, c.knee, c.ratio));
  t.ok(
    'brightness order is kept',
    order.every((v, i) => i === 0 || v > order[i - 1])
  );
  const g = (s) => compressGain(m * 2 ** s, c.knee, c.ratio);
  // Continuous: across 0.02 stops the gain moves by about its slope (~0.003), not by a step.
  t.ok('the knee eases in smoothly (no step at the knee)', Math.abs(g(2.01) - g(1.99)) < 0.005);
  t.ok('…and at its edges too', Math.abs(g(2.51) - g(2.49)) < 0.01 && g(1.49) === 1);

  const wild = rangeCompression(st(12), 0, { ...D, strength: 1, lightRange: 2.5 });
  t.ok('it never crushes harder than the floor ratio', wild.ratio >= MIN_COMPRESS_RATIO - 1e-9);
  const lifted = rangeCompression(st(5), 1, D);
  t.ok('it works on the EXPOSED image (knee moves with exposure)', near(lifted.knee, c.knee * 2));
  t.ok('ratio 1 = gain exactly 1 everywhere', compressGain(5, 0.1, 1) === 1);
}
