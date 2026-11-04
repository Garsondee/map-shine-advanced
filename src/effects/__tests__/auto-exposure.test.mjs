/**
 * auto-exposure.test.mjs — the balanced-light camera (2026-11-04). The promises it makes to the author:
 * leave a readable scene alone, lift only a too-dark middle, cut only a frame flooded with light, never
 * flatten (capped, partial), adapt smoothly, and keep the bloom physical (threshold after exposure,
 * glow a share of the scene light).
 */
import {
  AUTO_EXPOSURE,
  AUTO_EXPOSURE_PARAMS,
  AUTO_EXPOSURE_DEFAULTS,
  METER_W,
  METER_H,
  meterStats,
  autoExposureTarget,
  adaptExposure,
  bloomThresholdScale,
  glowBudgetScale,
  srgbToLinear,
} from '../auto-exposure.js';

/** A meter readback where every cell has scene luminance `f(i)` and glow `g(i)`. */
function grid(f, g = () => 0) {
  const px = new Float32Array(METER_W * METER_H * 4);
  for (let i = 0; i < METER_W * METER_H; i++) {
    px[i * 4] = f(i);
    px[i * 4 + 1] = g(i);
    px[i * 4 + 3] = 1;
  }
  return px;
}
const N = METER_W * METER_H;
const stats = (f, g) => meterStats(grid(f, g), METER_W, METER_H);
const D = AUTO_EXPOSURE_DEFAULTS;
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

export function run(t) {
  // ── the meter ────────────────────────────────────────────────────────────
  const flat = stats(() => 0.1);
  t.ok('flat frame: median = p95 = the value', near(flat.p50, 0.1) && near(flat.p95, 0.1));
  const lamps = stats((i) => (i < N * 0.03 ? 3 : 0.1));
  t.ok('3% of the frame at lamp brightness does not reach the 95th percentile', near(lamps.p95, 0.1));
  const flood = stats((i) => (i < N * 0.2 ? 3 : 0.1));
  t.ok('20% of the frame flooded does', near(flood.p95, 3));
  const voidy = stats((i) => (i < N / 2 ? 0 : 0.2));
  t.ok('the black void around the map is left out', near(voidy.p50, 0.2) && voidy.n === N / 2);
  t.ok(
    'an all-black frame gives no answer',
    meterStats(
      grid(() => 0),
      METER_W,
      METER_H
    ) === null
  );
  t.ok('a short buffer gives no answer', meterStats(new Float32Array(8), METER_W, METER_H) === null);
  const nan = stats(
    () => 0.1,
    () => Number.NaN
  );
  t.ok('NaN glow (stale mips under a zero switch) reads as no glow', nan.bloomMean === 0);

  // ── the comfortable band ─────────────────────────────────────────────────
  const floorLin = srgbToLinear(D.darkFloor);
  t.ok(
    'a readable scene is left exactly alone',
    autoExposureTarget(
      stats(() => floorLin * 2),
      D
    ) === 0
  );
  t.ok('lamps that do not flood the frame never darken it', autoExposureTarget(lamps, { ...D, darkFloor: 0 }) === 0);

  // ── too dark ─────────────────────────────────────────────────────────────
  const dark = stats(() => floorLin / 8); // 3 stops under the floor
  const lift = autoExposureTarget(dark, D);
  t.ok('a too-dark scene is lifted', lift > 0);
  t.ok('…but only part of the way (drama kept): under strength × gap', lift < D.strength * 3 + 1e-9);
  t.ok('…and never past the lift cap', lift <= D.maxLift + 1e-9);
  const darker = autoExposureTarget(
    stats(() => floorLin / 64),
    D
  );
  t.ok(
    'a darker scene still ends up darker than a less dark one',
    Math.log2(floorLin / 64) + darker < Math.log2(floorLin / 8) + lift
  );
  t.ok('maxLift 0 = never brightens', autoExposureTarget(dark, { ...D, maxLift: 0 }) === 0);
  const darkWithPools = stats((i) => (i < N * 0.1 ? D.brightCeiling : floorLin / 8));
  t.ok('lit pools at the ceiling hold a dark scene back (no blown lamps)', autoExposureTarget(darkWithPools, D) < lift);

  // ── too bright ───────────────────────────────────────────────────────────
  const cut = autoExposureTarget(flood, D);
  t.ok('a frame flooded with light is stopped down', cut < 0);
  t.ok('…never past the cut cap', cut >= -D.maxCut - 1e-9);
  t.ok('maxCut 0 = never darkens', autoExposureTarget(flood, { ...D, maxCut: 0 }) === 0);
  t.ok('a higher ceiling allows the glare', autoExposureTarget(flood, { ...D, brightCeiling: 3 }) === 0);
  t.ok(
    'strength 0 = off',
    autoExposureTarget(flood, { ...D, strength: 0 }) === 0 && autoExposureTarget(dark, { ...D, strength: 0 }) === 0
  );
  t.ok('no meter answer yet = no change', autoExposureTarget(null, D) === 0);

  // ── adaptation ───────────────────────────────────────────────────────────
  let ev = 0;
  for (let i = 0; i < 60; i++) ev = adaptExposure(ev, 1, 1 / 60, 2);
  t.ok('brightening over 1 s with a 2 s adapt time is part-way (~39%)', ev > 0.3 && ev < 0.45);
  let ev2 = 0;
  for (let i = 0; i < 60; i++) ev2 = adaptExposure(ev2, -1, 1 / 60, 2);
  t.ok('adjusting to glare is faster than to the dark', -ev2 > ev);
  t.ok('adapt time 0 = instant', adaptExposure(0, 1.3, 0.016, 0) === 1.3);
  t.ok('a stalled 5 s frame does not jump the exposure', adaptExposure(0, 1, 5, 2) < 0.15);
  t.ok(
    'a negative or junk delta does not move it',
    adaptExposure(0.5, 1, -1, 2) === 0.5 && adaptExposure(0.5, 1, Number.NaN, 2) === 0.5
  );

  // ── the bloom tie-in ─────────────────────────────────────────────────────
  t.ok('glow follows exposure: +1 stop halves the scene-space threshold', near(bloomThresholdScale(1, 1), 0.5));
  t.ok('…and −1 stop doubles it', near(bloomThresholdScale(-1, 1), 2));
  t.ok('follow 0 leaves the threshold alone', bloomThresholdScale(1.5, 0) === 1);
  t.ok('no exposure = no change', bloomThresholdScale(0, 1) === 1);
  const quiet = stats(
    () => 0.2,
    () => 0.2 * 0.02
  );
  t.ok('a glow of 2% of the scene light is left alone (budget 25%)', glowBudgetScale(quiet, 0.25, 1) > 0.999);
  const haze = stats(
    () => 0.2,
    () => 0.2 * 1.0
  );
  const s = glowBudgetScale(haze, 0.25, 1);
  t.ok('a glow equal to the whole scene light is reined in toward the budget', s < 0.27 && s > 0.2);
  t.ok(
    'the budget reads the UNSCALED glow (the meter saw it at the scale then live)',
    near(
      glowBudgetScale(
        stats(
          () => 0.2,
          () => 0.2 * 0.25
        ),
        0.25,
        0.25
      ),
      s,
      1e-4
    )
  );
  t.ok('budget 0 = off', glowBudgetScale(haze, 0, 1) === 1);
  t.ok('no meter answer = no change', glowBudgetScale(null, 0.25, 1) === 1);

  // ── the declaration ──────────────────────────────────────────────────────
  t.ok('ships on (author, 2026-11-04)', AUTO_EXPOSURE.enabledFromProfile === 'low' && D.strength > 0);
  t.ok('ships with the glow budget and the follow on', D.glowBudget > 0 && D.bloomFollow === 1);
  t.ok(
    'every default is inside its range',
    Object.values(AUTO_EXPOSURE_PARAMS).every((d) => d.default >= d.min && d.default <= d.max)
  );
  t.ok('the manifest carries the params', AUTO_EXPOSURE.params === AUTO_EXPOSURE_PARAMS);
}
