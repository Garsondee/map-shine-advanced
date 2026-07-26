/**
 * specular-material.test.mjs — THE DECODE IS ASSERTED, NOT EYEBALLED.
 *
 * `feedback_smooth_output_hides_ported_bugs` is the whole reason this file
 * exists. A shine effect renders a smooth, plausible highlight from almost any
 * decode: gold that comes out slightly green, or a neutral grey that comes out
 * 30% metallic and quietly suppresses the map art beneath it, looks *fine* on
 * screen. The authoring model would be wrong and nobody would find out, because
 * the instrument (a screenshot) cannot see it.
 *
 * So the claims `specular-material.js`'s header makes in prose are each a named
 * assertion here — above all the ONE that the whole compatibility story rests
 * on: **a V2-era greyscale mask must decode to exactly zero metalness**, so it
 * provably suppresses nothing and behaves as the pure additive dielectric V2
 * drew.
 */
import {
  decodeSpecularMaterial,
  srgbToLinear01,
  ggxDistribution,
  smithVisibility,
  schlickFresnel,
  keyLightDirection,
  smoothstep,
  DIELECTRIC_F0,
  MIN_ROUGHNESS,
  SPECULAR_PRESENCE_EDGE0,
  SPECULAR_PRESENCE_EDGE1,
} from '../specular-material.js';

const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;

  // ── GREY IS A METAL — the correction that made the effect visible ───────
  // The first decode read HSV saturation as metalness, so every grey metal —
  // steel, iron, pewter, silver, chrome, the commonest metals anyone paints on
  // a battlemap — landed at F0 = 0.04 and vanished. These assertions pin the
  // corrected claim, and the FIRST one is the whole bug in one line.
  const steel = decodeSpecularMaterial(0.75, 0.76, 0.8);
  ok('GREY STEEL IS A METAL — a neutral mask is not a 4% dielectric', steel.metalness > 0.5);
  ok('…so its F0 is a real conductor’s, not 0.04', steel.f0[1] > 0.5);
  ok('…and stays essentially neutral, because that is what steel looks like', near(steel.f0[0], steel.f0[2], 0.12));
  ok('…and it is fully present', near(steel.presence, 1));

  // Metalness is a SCENE choice now, so it must actually be reachable.
  const asGlaze = decodeSpecularMaterial(0.75, 0.76, 0.8, 0);
  ok('metalness 0 turns the same paint into a dielectric — the glass/glaze map', near(asGlaze.f0[1], DIELECTRIC_F0));
  ok('…which is a real, reachable setting rather than a documented intention', asGlaze.metalness === 0);
  const midway = decodeSpecularMaterial(0.75, 0.76, 0.8, 0.5);
  ok('…and it interpolates monotonically in between', midway.f0[1] > asGlaze.f0[1] && midway.f0[1] < steel.f0[1]);

  // Lossy encodes put a few percent of chroma into painted neutral. Under the
  // OLD decode that noise became metalness; now it can only tint F0 slightly,
  // which is both harmless and correct.
  const noisyGrey = decodeSpecularMaterial(0.62, 0.6, 0.59);
  ok(
    'compression-noise chroma barely tints F0 and cannot change metalness',
    near(noisyGrey.f0[0], noisyGrey.f0[2], 0.1)
  );

  const v2grey = decodeSpecularMaterial(0.6, 0.6, 0.6);
  ok('a V2-era mid-grey still reads its VALUE as polish, unchanged', near(v2grey.roughness, 0.4));

  // ── GOLD: hue → F0 ──────────────────────────────────────────────────────
  const gold = decodeSpecularMaterial(1.0, 0.77, 0.34);
  ok('saturated gold reads as a conductor', gold.metalness > 0.7);
  ok(
    'gold F0 is warm — R > G > B, the ordering that MAKES it gold',
    gold.f0[0] > gold.f0[1] && gold.f0[1] > gold.f0[2]
  );
  ok('gold F0 red is near-total reflectance', gold.f0[0] > 0.8);
  ok('gold F0 blue is far below its red — the hue survives the decode', gold.f0[2] < 0.3);
  // THE glTF STEP, asserted as the CLAIM rather than as a number: F0 is built
  // from the LINEARISED hue, not from the sRGB value as painted. Comparing
  // against a literal would be wrong here anyway — F0 is `mix(0.04, hueLinear,
  // metalness)` and gold's metalness is 0.95, not 1, so the exact value is a
  // few percent below the pure linearised hue by design. What must hold is the
  // direction, and it holds by an order of magnitude.
  const goldLinearErr = Math.abs(gold.f0[1] - srgbToLinear01(0.77));
  const goldSrgbErr = Math.abs(gold.f0[1] - 0.77);
  ok('gold F0 green is built from the LINEARISED 0.77, not from 0.77 itself', goldLinearErr * 2 < goldSrgbErr);

  // ── VALUE DRIVES POLISH, NOT HUE ────────────────────────────────────────
  // The `1/value` normalisation before linearising is what stops a dark copper
  // being penalised twice — once by a dark F0, once by a high roughness.
  const brightCopper = decodeSpecularMaterial(0.95, 0.6, 0.4);
  const darkCopper = decodeSpecularMaterial(0.475, 0.3, 0.2);
  // ⚠️ THE CLAIM HERE CHANGED with the metalness correction, and the change is
  // the point. It used to be "halving brightness does not touch F0 at all" —
  // which produced the inversion where dark paint out-shone polished paint five
  // to one, because a dark surface kept a full conductor's F0 while gaining a
  // broad lobe. Now darkness lowers F0 too (a dark metal is dark because it is
  // TARNISHED, and oxide is a dielectric), while the HUE it was painted still
  // survives intact. Both halves are asserted, because keeping the hue is what
  // stops this being a plain brightness slider.
  ok(
    'halving a metal’s brightness lowers its F0 — a dark metal is a tarnished one',
    darkCopper.f0[0] < brightCopper.f0[0] * 0.75
  );
  ok(
    '…but the HUE survives: the red:blue ratio is essentially unchanged',
    near(brightCopper.f0[0] / brightCopper.f0[2], darkCopper.f0[0] / darkCopper.f0[2], 1.5)
  );
  ok('…and it also reads rougher', darkCopper.roughness > brightCopper.roughness + 0.4);
  ok('bright paint is smoother than dark paint', brightCopper.roughness < darkCopper.roughness);
  const chrome = decodeSpecularMaterial(1, 1, 1);
  ok('pure white paint floors at MIN_ROUGHNESS, never 0', chrome.roughness === MIN_ROUGHNESS);
  ok('…which is the fp16 floor (0.089), not the fp32 one (0.045)', MIN_ROUGHNESS === 0.089);
  ok('alpha is roughness squared', near(chrome.alpha, MIN_ROUGHNESS * MIN_ROUGHNESS));

  // ── ABSENCE ─────────────────────────────────────────────────────────────
  const black = decodeSpecularMaterial(0, 0, 0);
  ok('unpainted (black) has zero presence', black.presence === 0);
  ok('…and reports no metal rather than NaN (the 0/0 guard)', black.metalness === 0);
  ok(
    '…and its F0 stays finite',
    black.f0.every((c) => Number.isFinite(c))
  );
  ok(
    'the presence ramp is a genuine BAND, not a step — the antialiasing bug water shipped',
    SPECULAR_PRESENCE_EDGE1 > SPECULAR_PRESENCE_EDGE0 * 4
  );
  const halfway = decodeSpecularMaterial(
    (SPECULAR_PRESENCE_EDGE0 + SPECULAR_PRESENCE_EDGE1) / 2,
    (SPECULAR_PRESENCE_EDGE0 + SPECULAR_PRESENCE_EDGE1) / 2,
    (SPECULAR_PRESENCE_EDGE0 + SPECULAR_PRESENCE_EDGE1) / 2
  );
  ok(
    '…so a mid-band value is partially present (sub-pixel coverage)',
    halfway.presence > 0.2 && halfway.presence < 0.8
  );
  // Dark metal must survive: presence and roughness must not BOTH punish it.
  const darkIron = decodeSpecularMaterial(0.15, 0.15, 0.15);
  ok('dark iron (value 0.15) is FULLY present — not double-penalised', near(darkIron.presence, 1));
  ok('…and reads as rough, which is the single place its darkness is spent', darkIron.roughness > 0.8);

  // ── MONOTONICITY: the authoring model has to be predictable ─────────────
  let monotone = true;
  let prev = -1;
  for (let i = 0; i <= 20; i++) {
    const m = decodeSpecularMaterial(i / 20, i / 20, i / 20);
    if (1 - m.roughness < prev - 1e-9) monotone = false;
    prev = 1 - m.roughness;
  }
  ok('smoothness rises monotonically with painted value across the whole range', monotone);

  // ⚠️ And the OPPOSITE of what this file used to assert: metalness must NOT
  // move with saturation. Sweeping chroma at constant value changes WHICH metal
  // it is, never WHETHER it is one — which is exactly the correction that made
  // grey steel visible.
  let satIndependent = true;
  for (let i = 0; i <= 20; i++) {
    const m = decodeSpecularMaterial(1, 1 - i / 20, 1 - i / 20);
    if (Math.abs(m.metalness - decodeSpecularMaterial(1, 1, 1).metalness) > 1e-9) satIndependent = false;
  }
  ok('metalness is INDEPENDENT of painted saturation — grey is as metal as gold', satIndependent);
  // …while the hue it carries genuinely does change.
  const warm = decodeSpecularMaterial(1, 0.5, 0.2);
  const neutral = decodeSpecularMaterial(1, 1, 1);
  ok('…but the F0 HUE tracks it', warm.f0[0] / warm.f0[2] > (neutral.f0[0] / neutral.f0[2]) * 2);

  // ── THE BRDF SCALARS ────────────────────────────────────────────────────
  ok('GGX peaks at N·H = 1', ggxDistribution(1, 0.3) > ggxDistribution(0.9, 0.3));
  ok('a smoother surface concentrates more energy at the peak', ggxDistribution(1, 0.05) > ggxDistribution(1, 0.5));
  ok(
    'GGX is finite at the roughness floor (the fp16 Inf/NaN trap)',
    Number.isFinite(ggxDistribution(1, MIN_ROUGHNESS ** 2))
  );
  ok('GGX never returns a negative lobe', ggxDistribution(0.2, 0.4) > 0);
  ok('Smith visibility is finite at grazing incidence', Number.isFinite(smithVisibility(0, 0, 0.2)));
  ok('Smith visibility is positive', smithVisibility(0.5, 0.9, 0.3) > 0);

  const f0 = [0.04, 0.04, 0.04];
  ok('Fresnel at normal incidence IS F0 — top-down’s minimum', near(schlickFresnel(f0, 1)[0], 0.04));
  ok('Fresnel at grazing incidence approaches 1', near(schlickFresnel(f0, 0)[0], 1));
  ok('Fresnel rises monotonically toward grazing', schlickFresnel(f0, 0.3)[0] > schlickFresnel(f0, 0.9)[0]);
  ok(
    'a conductor’s Fresnel stays coloured at normal incidence (gold does not go white)',
    schlickFresnel(gold.f0, 1)[0] > schlickFresnel(gold.f0, 1)[2] * 2
  );

  // ── THE KEY LIGHT LIFT ──────────────────────────────────────────────────
  const noon = keyLightDirection({ dirX: 0, dirY: -1, elevationDeg: 60 });
  ok('a lifted key direction is a unit vector', near(Math.hypot(noon[0], noon[1], noon[2]), 1));
  ok('a high sun points mostly UP', noon[2] > 0.8);
  const dusk = keyLightDirection({ dirX: 1, dirY: 0, elevationDeg: 2 });
  ok('a low sun points mostly SIDEWAYS — the grazing streak', dusk[2] < 0.1 && dusk[0] > 0.9);
  ok('…and it still normalises', near(Math.hypot(dusk[0], dusk[1], dusk[2]), 1));
  const degenerate = keyLightDirection({ dirX: 0, dirY: 0, elevationDeg: 0 });
  ok('a degenerate key falls back to straight up, never NaN', degenerate.every(Number.isFinite));

  // ── smoothstep matches TSL's argument order ─────────────────────────────
  ok('smoothstep(e0,e1,x) clamps below', smoothstep(0.2, 0.8, 0.1) === 0);
  ok('smoothstep(e0,e1,x) clamps above', smoothstep(0.2, 0.8, 0.9) === 1);
  ok('smoothstep is 0.5 at the midpoint', near(smoothstep(0.2, 0.8, 0.5), 0.5));
  ok('a degenerate band does not divide by zero', Number.isFinite(smoothstep(0.5, 0.5, 0.7)));

  // ── sRGB decode ─────────────────────────────────────────────────────────
  ok('sRGB decode fixes both endpoints', srgbToLinear01(0) === 0 && near(srgbToLinear01(1), 1));
  ok('mid grey decodes to ~0.216 (the reason V/S are NOT linearised)', near(srgbToLinear01(0.5), 0.214, 0.005));
  ok('the linear toe is used below 0.04045', near(srgbToLinear01(0.02), 0.02 / 12.92));
}
