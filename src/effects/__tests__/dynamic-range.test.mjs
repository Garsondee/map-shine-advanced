/**
 * dynamic-range.test.mjs — the HDR camera (2026-11-04, round 2). Ingram's brief, as numbers: "make fires
 * and candle flames punchy, make snow glaring in full noon unclouded sun", "increase drama", "best use of
 * colour/luminosity space", "avoid over tipping". Plus the two live failures this round already met:
 * round 1's inert dials, and lamp pools blown to cream disks when one curve punched everything bright.
 */
import {
  DYNAMIC_RANGE,
  DYNAMIC_RANGE_PARAMS,
  DYNAMIC_RANGE_DEFAULTS as D,
  METER_W,
  METER_H,
  NOON_ILLUM,
  GREY_CARD_SRGB,
  meterStats,
  greyCard,
  exposureFromIncident,
  curveFor,
  lightStopsOut,
  materialStopsOut,
  drTransform,
  drExposedBrightness,
  adaptToward,
  srgbToLinear,
  LIGHT_ADAPT_SHARE,
  MAX_ADAPT_STOPS_PER_SEC,
  FLASH_GATE_SEC,
  createFlashGate,
  gateReading,
  holdGate,
  resetGate,
  trimmedWeightedMean,
} from '../dynamic-range.js';
import { GLARE_ENERGY, glareBudgetGain, BLOOM_PARAMS } from '../bloom.js';

const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** The composite's own formula: lit = EOTF(OETF(albedo) × illum). */
const lit = (albedoSrgb, illum) => {
  const v = srgbToLinear(Math.min(1, albedoSrgb * illum));
  return [v, v, v];
};
const L = (v) => [v, v, v];
/** Screen value (sRGB-encoded) of a linear luminance — "visibly" is judged on screen, not in linear light. */
const screen = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function run(t) {
  // ── the meter ────────────────────────────────────────────────────────────
  const cells = METER_W * METER_H;
  const px = new Float32Array(cells * 4);
  for (let i = cells / 2; i < cells; i++) {
    px[i * 4] = 0.1;
    px[i * 4 + 1] = 0.7;
  }
  const st = meterStats(px, METER_W, METER_H);
  t.ok('padding cells (lit 0) are left out of the meter', st.n === cells / 2 && near(st.illumP50, 0.7, 1e-6));
  t.ok('a uniform light meters as itself (the log-average of one value)', near(st.illumKey, 0.7, 1e-6));
  t.ok('no lit cell = no answer', meterStats(new Float32Array(cells * 4), METER_W, METER_H) === null);

  // ── the meter does not flicker on a pan (mmp-ilo.1) ──────────────────────
  // A frame half lamp-lit interior (illum 0.1), half sunlit street (1.0), the boundary sliding one cell per pan step.
  // The old median jumped between the two modes as the boundary crossed the middle: the author's "flickering of
  // light levels when moving across the map". The weighted log-average must move by small, even steps.
  const panFrame = (edge) => {
    const f = new Float32Array(cells * 4);
    for (let j = 0; j < METER_H; j++) {
      for (let i = 0; i < METER_W; i++) {
        const c = j * METER_W + i;
        f[c * 4] = 0.2;
        f[c * 4 + 1] = i < edge ? 0.1 : 1;
      }
    }
    return f;
  };
  let worstKeyStep = 0;
  let worstMedianStep = 0;
  let prev = null;
  for (let edge = 20; edge <= 76; edge++) {
    const s = meterStats(panFrame(edge), METER_W, METER_H);
    if (prev) {
      worstKeyStep = Math.max(worstKeyStep, Math.abs(Math.log2(s.illumKey) - Math.log2(prev.illumKey)));
      worstMedianStep = Math.max(worstMedianStep, Math.abs(Math.log2(s.illumP50) - Math.log2(prev.illumP50)));
    }
    prev = s;
  }
  t.ok(
    `a one-cell pan moves the metered light by < 0.12 stop (worst ${worstKeyStep.toFixed(3)}; the median jumped ${worstMedianStep.toFixed(2)})`,
    worstKeyStep < 0.12 && worstMedianStep > 3
  );
  t.ok(
    'the trimmed mean ignores a few hot cells',
    near(trimmedWeightedMean([0, 0, 0, 0, 0, 0, 0, 0, 0, 10], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 10, 0.1), 0, 1e-9)
  );
  const hot = new Float32Array(cells * 4);
  for (let c = 0; c < cells; c++) {
    hot[c * 4] = 0.3;
    hot[c * 4 + 1] = 0.5;
    hot[c * 4 + 2] = c % 10 === 0 ? 2 : 0;
    hot[c * 4 + 3] = c % 10 === 0 ? 1 : 0;
  }
  const hs = meterStats(hot, METER_W, METER_H);
  t.ok('the glare channels average over the scene', near(hs.glowEnergy, 0.2, 1e-3) && near(hs.glowCover, 0.1, 1e-3));

  // ── exposure from the incident light ─────────────────────────────────────
  t.ok(
    'the grey card is 18% under full light',
    near(greyCard(1), srgbToLinear(GREY_CARD_SRGB), 1e-9) && near(greyCard(1), 0.18, 0.002)
  );
  t.ok('noon light = noon exposure (0 stops)', near(exposureFromIncident(NOON_ILLUM, D), 0));
  const nightEv = exposureFromIncident(0.26, D);
  t.ok(`a night lifts, part of the way (${nightEv.toFixed(2)} stops)`, nightEv > 0.8 && nightEv < 2.5);
  t.ok('eye adaptation 0 = noon exposure everywhere', exposureFromIncident(0.26, { ...D, eyeAdapt: 0 }) === 0);
  t.ok('the exposure dial adds stops', near(exposureFromIncident(1, { ...D, exposure: 1 }), 1));

  // ── noon: snow glares, cobbles stay cobbles ──────────────────────────────
  const noon = curveFor({ illumP50: 1 }, 0, D);
  const sun = L(1);
  const snow = drTransform(lit(0.92, 1), sun, noon);
  const cobble = drTransform(lit(0.55, 1), sun, noon);
  t.ok(`noon snow reads near white (${lum(snow).toFixed(3)})`, lum(snow) > 0.88);
  t.ok(`a sunlit cobble stays a mid-tone (${lum(cobble).toFixed(3)})`, lum(cobble) < 0.4);
  const glowFrom = BLOOM_PARAMS.threshold.default;
  t.ok('a sunlit cobble at noon reads under white at the exposure', drExposedBrightness(lit(0.55, 1), noon) < 1);
  const shade = drTransform(lit(0.55, 0.5), L(0.5), noon);
  const shadeFlat = drTransform(lit(0.55, 0.5), L(0.5), { ...noon, drama: 1 });
  t.ok('drama deepens a cobble in sun-shadow', lum(shade) < lum(shadeFlat));

  // ── night: lamp pools stay pools, flames punch ───────────────────────────
  const night = curveFor({ illumP50: 0.26 }, nightEv, D);
  const poolIllum = L(1);
  const pool = drTransform(lit(0.46, 1), poolIllum, night); // a grey floor in a full lamp pool
  t.ok(`a lamp pool on a grey floor never blows out (${lum(pool).toFixed(3)})`, lum(pool) < 0.85);
  t.ok(
    'the glare reads exposure only: a punched material does not glare more than its light',
    near(drExposedBrightness([0.5, 0.4, 0.3], night), 0.5 * 2 ** night.ev, 1e-9) &&
      near(drExposedBrightness([0.5, 0.4, 0.3], { ...night, punch: 3 }), 0.5 * 2 ** night.ev, 1e-9)
  );
  t.ok(
    'the light-range cap really holds it back',
    lum(pool) < lum(drTransform(lit(0.46, 1), poolIllum, { ...night, lightRange: 8 }))
  );
  const flame = [1.6, 0.7, 0.18]; // emissive, under the light it casts
  const fOut = drTransform(flame, L(0.6), night);
  t.ok('a flame reads at the top of the range', Math.max(...fOut) > 0.95);
  t.ok('…and stays fire-coloured (red well over blue), not flat white', fOut[0] > fOut[2] * 1.5);
  t.ok('a flame glows', drExposedBrightness(flame, night) > glowFrom);
  const candle = [0.12, 0.07, 0.02]; // a candle-lit brass pot: bright, not yet at the shoulder
  const room = lit(0.46, 0.26);
  const ratio = (curve) => lum(drTransform(candle, L(0.3), curve)) / lum(drTransform(room, L(0.26), curve));
  t.ok('punch pulls a candle away from the room', ratio(night) > ratio({ ...night, punch: 1 }) * 1.2);
  t.ok(
    'a white cloth in the lamp pool is punched; the grey floor beside it is not',
    materialStopsOut(2.3, night) > 2.3 + 0.3 && materialStopsOut(0, night) === 0
  );
  t.ok(
    'under even light, drama still separates dark wood from pale stone',
    materialStopsOut(1.5, { ...night, punch: 1 }) - materialStopsOut(-1.5, { ...night, punch: 1 }) > 3.3 &&
      materialStopsOut(1.5, { ...night, punch: 1, drama: 1 }) -
        materialStopsOut(-1.5, { ...night, punch: 1, drama: 1 }) ===
        3
  );

  // Coloured lamp light (Foundry coloration: in lit, not in illum) is light, not a glowing material.
  const greenFloorLit = [0.06, 0.32, 0.05]; // a grey floor washed by a green magic light
  const greenCol = [0.02, 0.25, 0.02];
  t.ok(
    'a green-lit floor is not punched when its coloration is known (no flat yellow blob)',
    lum(drTransform(greenFloorLit, L(0.3), night, greenCol)) < lum(drTransform(greenFloorLit, L(0.3), night)) * 0.8
  );
  const gOut = drTransform(greenFloorLit, L(0.3), night, greenCol);
  t.ok('…and stays green (green well over red)', gOut[1] > gOut[0] * 2);

  // ── no over-tipping ──────────────────────────────────────────────────────
  t.ok(
    'nothing leaves the display range (the shoulder holds)',
    Math.max(...drTransform([40, 30, 20], L(1), night)) <= 1.0001
  );
  const order = [0.01, 0.05, 0.2, 0.5, 1, 2, 4].map((v) => lum(drTransform(L(v), L(0.5), night)));
  t.ok(
    'brightness order is kept under one light',
    order.every((v, i) => i === 0 || v >= order[i - 1])
  );
  const lightOrder = [-6, -3, -1, 0, 1, 2, 3, 5, 8].map((l) => lightStopsOut(l, night));
  t.ok(
    'the light term is monotone (brighter light always reads brighter)',
    lightOrder.every((v, i) => i === 0 || v > lightOrder[i - 1])
  );
  t.ok(
    'drama never darkens light past "Deepest shadow"',
    lightStopsOut(-2.5, { ...night, drama: 1.8 }) >= -2.5 - D.shadowDepth - 1e-9
  );

  // ── every dial moves a real scene (round 1's failure) ────────────────────
  const scene = [
    [lit(0.46, 0.05), L(0.05)],
    [lit(0.46, 0.26), L(0.26)],
    [lit(0.46, 1), L(1)],
    [lit(0.72, 0.26), L(0.26)], // pale plaster at night: ~1 stop over grey
    [lit(0.92, 1), L(1)],
    [[0.5, 0.3, 0.1], L(0.6)],
    [flame, L(0.6)],
  ];
  const base = scene.map(([c, i]) => drTransform(c, i, night));
  // "Visibly" = at least 3/255 on screen somewhere in the scene.
  const moved = (curve) =>
    scene.some(([c, i], j) => Math.abs(screen(lum(drTransform(c, i, curve))) - screen(lum(base[j]))) > 3 / 255);
  for (const [k, v] of [
    ['drama', 1.7],
    ['punch', 2.6],
    ['punchFrom', 0.3],
    ['colour', 1.9],
    ['lightRange', 1.5],
    ['shadowDepth', 0.2],
  ]) {
    t.ok(`dial "${k}" visibly changes a night scene`, moved({ ...night, [k]: v }));
  }
  t.ok(
    'dial "eyeAdapt" visibly changes a night scene',
    Math.abs(exposureFromIncident(0.26, { ...D, eyeAdapt: 0.8 }) - nightEv) > 0.5
  );

  // ── adaptation ───────────────────────────────────────────────────────────
  t.ok('adapt time 0 = instant', adaptToward(0, 2, 0.016, 0) === 2);
  t.ok('a stalled frame never jumps it', adaptToward(0, 1, 5, 1.5) < 0.5);
  // Asymmetric like an eye: into brighter light fast (light adaptation), into the dark slowly (dark adaptation).
  const up = adaptToward(0, 1, 0.1, 2.5);
  const down = adaptToward(0, -1, 0.1, 2.5);
  t.ok(
    `brighter light is adapted to ${(up / -down).toFixed(1)}x faster than darker (share ${LIGHT_ADAPT_SHARE.toFixed(2)})`,
    up > -down * 1.8
  );
  // ...and never lurches: a 4-stop jump moves at most MAX_ADAPT_STOPS_PER_SEC per second.
  let lurch = 0;
  let prevL = 0;
  let lv = 0;
  for (let k = 0; k < 120; k++) {
    lv = adaptToward(lv, 4, 1 / 60, D.adaptSeconds);
    lurch = Math.max(lurch, lv - prevL);
    prevL = lv;
  }
  t.ok(
    `a big change never lurches (largest frame step ${lurch.toFixed(4)} stop of light)`,
    lurch <= MAX_ADAPT_STOPS_PER_SEC / 60 + 1e-9
  );
  // Settling in log space: one second of 60 fps frames into the dark moves less than half way.
  let lg = 0;
  for (let k = 0; k < 60; k++) lg = adaptToward(lg, -2, 1 / 60, D.adaptSeconds);
  t.ok(`one second into the dark adapts < half way (${(lg / -2).toFixed(2)})`, lg / -2 < 0.5 && lg / -2 > 0.2);

  // ── the flash gate (lightning never re-exposes the camera) ───────────────
  const runGate = (pattern, dt = 1 / 60) => {
    const g = createFlashGate();
    const out = [];
    for (const v of pattern) out.push(gateReading(g, v, dt));
    return out;
  };
  const frames = (sec) => Math.round(sec * 60);
  const flash = (sec) => [...Array(frames(1)).fill(-2), ...Array(frames(sec)).fill(1), ...Array(frames(2)).fill(-2)];
  for (const sec of [0.2, 0.5]) {
    const o = runGate(flash(sec));
    t.ok(`a ${sec} s flash never reaches the camera (max gated ${Math.max(...o)})`, Math.max(...o) === -2);
  }
  const step = runGate([...Array(frames(1)).fill(-2), ...Array(frames(3)).fill(1)]);
  t.ok(
    `a lasting change does land, after the gate (${FLASH_GATE_SEC} s)`,
    step.at(-1) === 1 && step[frames(1) + frames(FLASH_GATE_SEC) - 5] === -2
  );
  const dark = runGate([...Array(frames(1)).fill(1), ...Array(frames(0.1)).fill(-2)]);
  t.ok('a darker reading lands at once', dark.at(-1) === -2);
  const hg = createFlashGate();
  gateReading(hg, -2, 1 / 60);
  holdGate(hg, 2);
  let held = -2;
  for (let k = 0; k < frames(1.5); k++) held = gateReading(hg, 3, 1 / 60);
  t.ok('a hold freezes the metered light', held === -2);
  for (let k = 0; k < frames(2); k++) held = gateReading(hg, 3, 1 / 60);
  t.ok('…and lets go after it', held === 3);
  resetGate(hg);
  t.ok('a reset forgets the readings', gateReading(hg, null, 1 / 60) === null);

  // ── the glare (bloom.js): energy, not a halo per pixel (mmp-ilo.1/.2) ────
  const bp = Object.fromEntries(Object.entries(BLOOM_PARAMS).map(([k, d]) => [k, d.default]));
  const fraction = GLARE_ENERGY * bp.strength * (bp.coreStrength + bp.atmoStrength);
  t.ok(
    `the default glare spreads ${(100 * fraction).toFixed(0)}% of the over-white light (a lens, not ~400%)`,
    fraction > 0.08 && fraction < 0.3
  );
  t.ok('a quiet frame keeps its glare', glareBudgetGain(0.02, fraction) > 0.97);
  const crowded = 0.6; // a 40-torch hall: on average 0.6 of exposed white over the threshold
  t.ok(
    `a crowded frame is eased toward the budget (gain ${glareBudgetGain(crowded, fraction).toFixed(2)})`,
    glareBudgetGain(crowded, fraction) < 0.4 && crowded * fraction * glareBudgetGain(crowded, fraction) < 0.025
  );

  // ── the declaration ──────────────────────────────────────────────────────
  t.ok('ships on (author, 2026-11-04)', DYNAMIC_RANGE.enabledFromProfile === 'low');
  t.ok(
    'every default is inside its range',
    Object.values(DYNAMIC_RANGE_PARAMS).every((d) => d.default >= d.min && d.default <= d.max)
  );
  t.ok('ships with drama and punch on', D.drama > 1 && D.punch > 1);
}
