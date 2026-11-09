/**
 * perf-sweep-2026-11-08.test.mjs — the perf sweep's cheaper paths give the SAME answers as the paths they replaced:
 * the exposure meter (selection + cached weights vs full sorts), the quiet storm (idle frame without the schedule
 * walk), and the lens's low rung (fewer CA and starburst taps, top rungs unchanged).
 */
import { meterStats, meterWeight, trimmedWeightedMean, selectRank, METER_TRIM } from '../dynamic-range.js';
import { createStormLightning, STORM_IDLE } from '../lightning-storm.js';
import { lensTierPlan, LENS_MAX_TIER } from '../lens-render.js';

/** The meter as it was before the sweep (sorts, fresh arrays, weights per reading). */
function meterStatsReference(px, w, h) {
  const cells = w * h;
  const lit = [];
  const ill = [];
  const logs = [];
  const wts = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const c = j * w + i;
      const l = Number(px[c * 4]);
      if (!(l > 1e-6)) continue;
      lit.push(Math.fround(l));
      const il = Math.max(0, Number(px[c * 4 + 1]) || 0);
      ill.push(Math.fround(il));
      logs.push(Math.log2(Math.max(1e-6, il)));
      wts.push(meterWeight(i, j, w, h));
    }
  }
  const n = lit.length;
  if (!n || cells === 0) return null;
  const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => logs[a] - logs[b] || a - b);
  let total = 0;
  for (const x of wts) total += x;
  const lo = total * METER_TRIM;
  const hi = total * (1 - METER_TRIM);
  let acc = 0;
  let sum = 0;
  let wsum = 0;
  for (const k of order) {
    const a = acc;
    const b = acc + wts[k];
    acc = b;
    const keep = Math.max(0, Math.min(b, hi) - Math.max(a, lo));
    if (keep > 0) {
      sum += logs[k] * keep;
      wsum += keep;
    }
  }
  const sa = [...lit].sort((x, y) => x - y);
  const sb = [...ill].sort((x, y) => x - y);
  const at = (s, q) => s[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1) + 0.5)))];
  return { litP50: at(sa, 0.5), litP99: at(sa, 0.99), illumP50: at(sb, 0.5), illumKey: 2 ** (sum / wsum) };
}

export function run(t) {
  const { ok } = t;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // ── selectRank === sort()[k] ──
  let selOk = true;
  for (let trial = 0; trial < 60 && selOk; trial++) {
    const n = 1 + Math.floor(rnd() * 300);
    const a = new Float32Array(n);
    // ties on purpose: a coarse grid of values
    for (let i = 0; i < n; i++) a[i] = Math.floor(rnd() * 20) / 4;
    const sorted = Array.from(a).sort((x, y) => x - y);
    const k = Math.floor(rnd() * n);
    if (selectRank(a.slice(), k) !== sorted[k]) selOk = false;
  }
  ok('selectRank equals a full sort at every rank (60 random arrays with ties)', selOk);

  // ── meterStats === the pre-sweep meter ──
  const cases = [
    [96, 54, 0],
    [96, 54, 0.3],
    [12, 7, 0.5],
    [1, 1, 0],
  ];
  let meterOk = true;
  for (const [w, h, holes] of cases) {
    for (let rep = 0; rep < 3; rep++) {
      const px = new Float32Array(w * h * 4);
      for (let c = 0; c < w * h; c++) {
        px[c * 4] = rnd() < holes ? 0 : rnd() * 2;
        px[c * 4 + 1] = Math.floor(rnd() ** 3 * 64) / 16; // ties
        px[c * 4 + 2] = rnd() * 0.1;
        px[c * 4 + 3] = rnd() * 0.2;
      }
      const got = meterStats(px, w, h);
      const ref = meterStatsReference(px, w, h);
      if (!ref) {
        if (got !== null) meterOk = false;
        continue;
      }
      for (const k of ['litP50', 'litP99', 'illumP50']) if (got[k] !== ref[k]) meterOk = false;
      // the packed sort orders by float32: the key may move by float rounding, never visibly (< 1e-6 stop)
      if (Math.abs(Math.log2(got.illumKey) - Math.log2(ref.illumKey)) > 1e-6) meterOk = false;
    }
  }
  ok('meterStats matches the pre-sweep sorting meter (percentiles exact, key within 1e-6 stop)', meterOk);
  ok(
    'trimmedWeightedMean still takes plain arrays (no scratch)',
    Math.abs(trimmedWeightedMean([3, 1, 2], [1, 1, 1], 3, 0) - 2) < 1e-12
  );

  // ── the quiet storm ──
  const storm = createStormLightning({ seed: 9 });
  const base = { enabled: true, sceneRect: { x: 0, y: 0, width: 1000, height: 1000 }, gridPx: 100 };
  ok('a new storm is quiet', storm.quiet === true);
  ok('lightning 0 → the idle frame', storm.step({ ...base, nowMs: 5000, lightning01: 0 }) === STORM_IDLE);
  storm.force({ x: 10, y: 10 });
  ok('a forced strike is not quiet', storm.quiet === false);
  storm.step({ ...base, nowMs: 6000, lightning01: 0 });
  const f = storm.step({ ...base, nowMs: 6050, lightning01: 0 });
  ok('a forced strike still lands with the slider at 0', f.active === true);

  // ── the lens's low rung ──
  ok(
    'lens rung 0: 3-tap chromatic aberration, 6-tap starburst',
    !lensTierPlan(0).spectralChromatic && lensTierPlan(0).starTaps === 6
  );
  let topSame = true;
  for (let r = 1; r <= LENS_MAX_TIER; r++)
    if (!lensTierPlan(r).spectralChromatic || lensTierPlan(r).starTaps !== 12) topSame = false;
  ok('lens rungs 1+ keep the spectral fringe and the 12-tap starburst (the shipped look)', topSame);
}
