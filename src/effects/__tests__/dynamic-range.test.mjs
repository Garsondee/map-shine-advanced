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
  drDisplayBrightness,
  adaptToward,
  srgbToLinear,
} from '../dynamic-range.js';

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
  t.ok('no lit cell = no answer', meterStats(new Float32Array(cells * 4), METER_W, METER_H) === null);

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
  t.ok('noon snow glows (reads past "Glow from")', drDisplayBrightness(lit(0.92, 1), sun, noon) > D.glowFrom);
  t.ok('a sunlit cobble does not glow', drDisplayBrightness(lit(0.55, 1), sun, noon) < D.glowFrom);
  const shade = drTransform(lit(0.55, 0.5), L(0.5), noon);
  const shadeFlat = drTransform(lit(0.55, 0.5), L(0.5), { ...noon, drama: 1 });
  t.ok('drama deepens a cobble in sun-shadow', lum(shade) < lum(shadeFlat));

  // ── night: lamp pools stay pools, flames punch ───────────────────────────
  const night = curveFor({ illumP50: 0.26 }, nightEv, D);
  const poolIllum = L(1);
  const pool = drTransform(lit(0.46, 1), poolIllum, night); // a grey floor in a full lamp pool
  t.ok(`a lamp pool on a grey floor never blows out (${lum(pool).toFixed(3)})`, lum(pool) < 0.85);
  t.ok('a lamp pool never glows', drDisplayBrightness(lit(0.46, 1), poolIllum, night) < D.glowFrom);
  t.ok(
    'the light-range cap really holds it back',
    lum(pool) < lum(drTransform(lit(0.46, 1), poolIllum, { ...night, lightRange: 8 }))
  );
  const flame = [1.6, 0.7, 0.18]; // emissive, under the light it casts
  const fOut = drTransform(flame, L(0.6), night);
  t.ok('a flame reads at the top of the range', Math.max(...fOut) > 0.95);
  t.ok('…and stays fire-coloured (red well over blue), not flat white', fOut[0] > fOut[2] * 1.5);
  t.ok('a flame glows', drDisplayBrightness(flame, L(0.6), night) > D.glowFrom);
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
    drDisplayBrightness(greenFloorLit, L(0.3), night, greenCol) <
      drDisplayBrightness(greenFloorLit, L(0.3), night) * 0.6
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
  t.ok('a stalled frame never jumps it', adaptToward(0, 1, 5, 1.5) < 0.2);

  // ── the declaration ──────────────────────────────────────────────────────
  t.ok('ships on (author, 2026-11-04)', DYNAMIC_RANGE.enabledFromProfile === 'low');
  t.ok(
    'every default is inside its range',
    Object.values(DYNAMIC_RANGE_PARAMS).every((d) => d.default >= d.min && d.default <= d.max)
  );
  t.ok('ships with drama and punch on', D.drama > 1 && D.punch > 1);
}
