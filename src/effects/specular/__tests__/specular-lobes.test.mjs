/**
 * specular-lobes.test.mjs — HOW BRIGHT IS IT, IN SCENE UNITS?
 *
 * The author's first live report on tiers 0-2 was *"nothing is very visible
 * about it right now."* The decode had 73 assertions behind it and was fine;
 * what nothing measured was the COMPOSITION — what those numbers actually add
 * to a pixel. So the one question that mattered was the one question the suite
 * could not answer.
 *
 * These assertions are that answer, and they are deliberately phrased as
 * BRIGHTNESS BANDS rather than as "does it run". `buf:scene.color` holds the lit
 * map at roughly 0..1, so an additive term of 0.008 is invisible, 0.05 is a
 * sheen, 0.3 is unmistakable metal and 3.0 is a blown highlight that will feed
 * bloom. A physically-correct BRDF that lands in the first band is not a working
 * effect, and only a number says which band it is in.
 */
import { decodeSpecularMaterial } from '../specular-material.js';
import {
  composeSpecular,
  synthesizedViewDir,
  envBrdfApprox,
  sunLobe,
  SUN_IRRADIANCE_RATIO,
} from '../specular-lobes.js';

/** What "visible" means here, once, so every assertion below reads against the
 * same yardstick rather than against a hand-picked epsilon. */
const INVISIBLE_BELOW = 0.02;
const CLEARLY_VISIBLE = 0.08;

const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

/** A clear noon sky, as `effects/sky-access.js` reports it. */
const NOON = {
  keyColor: [1, 0.97, 0.94],
  keyStrength: 1,
  fillColor: [0.46, 0.63, 1],
  fillStrength: 0.42,
};

/** The default synthesised eye, mid-screen and near the edge. */
const EYE_CENTRE = synthesizedViewDir({ offsetX: 0, offsetY: 0, viewWidth: 4000, heightRatio: 1.5 });
const EYE_EDGE = synthesizedViewDir({ offsetX: 2000, offsetY: 0, viewWidth: 4000, heightRatio: 1.5 });

/** The sun at its default 60° peak elevation, due south. */
const SUN_NOON = [0, -0.5, Math.sin((60 * Math.PI) / 180)];
const FLAT_N = [0, 0, 1];

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

export function run(t) {
  const { ok } = t;

  // ── THE DIAGNOSIS, PINNED AS AN ASSERTION ───────────────────────────────
  // Not a regression guard — a RECORD. These two facts are why the shipped
  // pass was invisible, and if a future change makes either false, the reason
  // this effect is shaped the way it is has changed too.
  {
    const polished = decodeSpecularMaterial(0.9, 0.9, 0.9);
    const peak = sunLobe({
      normal: norm([0, -0.5, Math.sin((60 * Math.PI) / 180)]), // N AT the mirror angle
      viewDir: norm([0, -0.5, Math.sin((60 * Math.PI) / 180)]),
      lightDir: SUN_NOON,
      f0: polished.f0,
      alpha: polished.alpha,
      radiance: [1, 1, 1],
    });
    const flat = sunLobe({
      normal: FLAT_N,
      viewDir: EYE_CENTRE,
      lightDir: SUN_NOON,
      f0: polished.f0,
      alpha: polished.alpha,
      radiance: [1, 1, 1],
    });
    ok(
      'THE CORE PROBLEM: a flat normal puts the sun lobe orders of magnitude below its own peak',
      flat[0] * 50 < peak[0]
    );
    ok('…and the peak itself is genuinely bright, so the lobe is not the problem — the NORMAL is', peak[0] > 1);
  }

  // ── THE SPLIT-SUM FIT: a useful NEGATIVE result ─────────────────────────
  // The first hypothesis for the invisible pass was "the dome integral is
  // wrong — a rough surface should gather grazing microfacets and be
  // brighter". Measured, it is slightly DIMMER, which rules that out and
  // leaves the flat normal with nowhere to hide.
  {
    const { scale, bias } = envBrdfApprox(0.4, 0.99);
    const splitSum = 0.04 * scale + bias;
    ok('split-sum on a rough dielectric is DIMMER than bare Schlick, not brighter', splitSum < 0.04);
    ok('…but still positive — it is an energy correction, not a switch', splitSum > 0.02);
    const metalDome = envBrdfApprox(0.25, 0.99);
    ok('a conductor keeps most of its reflectance through the same fit', 0.9 * metalDome.scale + metalDome.bias > 0.7);
  }

  // ── THE AUTHORING CASES, MEASURED ───────────────────────────────────────
  // Each is a real thing an author paints, evaluated end to end.
  //
  // `illum`/`lampGate`/`lampDir` are THREE independent knobs, deliberately —
  // conflating "is the room lit" with "is there a nearby point light" is
  // exactly the bug this file's INDOOR block exists to catch (see
  // `specular-render.js`'s `ambientSpec` header for the account). `illum`
  // drives BOTH the ambient dome and the directional lobe (one buffer sampled
  // once, same as the real shader); `lampGate` is the SEPARATE question of
  // whether a local gradient exists to point that lobe with. A non-zero
  // `illum` with `lampGate: 0` is a real, common case: a lit room with
  // nothing placed close enough to the metal to catch a sharp highlight FROM.
  const measure = (
    rgb,
    {
      outdoors = 1,
      normal = FLAT_N,
      viewDir = EYE_CENTRE,
      illum = [0.5, 0.48, 0.42],
      lampGate = 0,
      lampDir = null,
    } = {}
  ) =>
    composeSpecular({
      material: decodeSpecularMaterial(rgb[0], rgb[1], rgb[2]),
      normal,
      viewDir,
      keyDir: SUN_NOON,
      ...NOON,
      outdoors,
      lampDir: lampDir ?? [0, 0, 1],
      lampRadiance: illum,
      lampGate,
    });

  {
    // STEEL. The commonest metal on any battlemap, and it is GREY — which is
    // exactly why metalness cannot be read off the mask's saturation.
    const steel = measure([0.75, 0.76, 0.8]);
    ok('grey steel outdoors at noon is CLEARLY VISIBLE', steel.luma > CLEARLY_VISIBLE);
    ok('…and is not blown out', steel.luma < 3);
    // Neither term may be negligible: the dome is what makes metal read as metal
    // in flat light, the sun is the only thing that can move. A build where
    // either has collapsed is a build that looks wrong in one specific way.
    ok(
      '…and BOTH terms contribute — neither has collapsed',
      steel.sun[1] > steel.dome[1] * 0.3 && steel.dome[1] > steel.sun[1] * 0.3
    );

    // GOLD. The hue must survive all the way to the pixel.
    const gold = measure([1, 0.77, 0.34]);
    ok('gold outdoors is clearly visible', gold.luma > CLEARLY_VISIBLE);
    ok('…and reads WARM at the pixel, not just in the decode', gold.rgb[0] > gold.rgb[2] * 1.5);
    ok('…and is brighter than steel, as a higher-F0 metal should be', gold.rgb[0] > steel.rgb[0]);

    // A DIELECTRIC the author explicitly asked for: polished stone / glaze.
    // Dim from directly above is CORRECT physics (a 4% reflector showing you
    // the zenith sky), and the assertion records that we accept it.
    const glaze = measure([0.06, 0.06, 0.06]);
    ok('near-black paint stays an order of magnitude below real metal', glaze.luma < steel.luma * 0.1);
    ok('…which is what keeps the mask meaning something', glaze.luma < CLEARLY_VISIBLE);
  }

  {
    // INDOORS. No sky at all; the room's own light is the entire environment.
    //
    // ⚠️ THE FIX, MEASURED: a room lit ONLY by ambient/global fill — no torch
    // placed close enough to the metal to create a local illum gradient —
    // used to compose to EXACTLY 0 here, regardless of the mask, the
    // material, or how bright the room actually was. That was the live bug
    // (the author's screenshot: a hall full of gold/brass metal, nothing
    // shining). `ambientSpec` in `specular-render.js` is the fix; this is
    // the measurement that proves it, and it must never regress to 0 again.
    const roomLight = [0.55, 0.5, 0.42]; // a plainly, ordinarily lit interior
    const ambientOnly = measure([0.75, 0.76, 0.8], { outdoors: 0, illum: roomLight, lampGate: 0 });
    ok('a LIT room with NO nearby lamp still shows a real ambient sheen', ambientOnly.luma > CLEARLY_VISIBLE);
    ok(
      '…using the room`s own colour, since ambient light is all there is to reflect',
      near(ambientOnly.rgb[0] / ambientOnly.rgb[2], roomLight[0] / roomLight[2], 0.3)
    );

    // A nearby lamp ADDS a sharp directional highlight ON TOP of that floor —
    // it was never meant to be the ONLY source of indoor shine, only of the
    // sharp highlight.
    const lampDir = norm([0.6, 0, 0.8]);
    const withLamp = measure([0.75, 0.76, 0.8], { outdoors: 0, illum: [1, 0.85, 0.6], lampGate: 1, lampDir });
    ok('a nearby lamp makes indoor metal BRIGHTER than the ambient floor alone', withLamp.luma > ambientOnly.luma);

    // A GENUINELY dark room — zero illum, not merely zero gradient — still
    // shows nothing, which is the one case that SHOULD stay black: there is
    // no light present of any kind for the metal to reflect.
    const darkRoom = measure([0.75, 0.76, 0.8], { outdoors: 0, illum: [0, 0, 0], lampGate: 0 });
    ok(
      'a room with genuinely ZERO light still shows nothing — there is nothing to reflect',
      darkRoom.luma < INVISIBLE_BELOW
    );
    ok('…which is different from "no lamp" — the earlier, wrong conflation', ambientOnly.luma > darkRoom.luma * 100);
    ok('…which is the whole indoor/outdoor distinction, at the pixel', measure([0.75, 0.76, 0.8]).luma > 0.05);
  }

  {
    // THE SWEEP. With a FLAT normal the eye position barely changes anything —
    // this is the measurement that proves the `relief` rung is required rather
    // than merely nice, and it is asserted in the direction of the PROBLEM.
    const steelCentre = measure([0.75, 0.76, 0.8], { viewDir: EYE_CENTRE });
    const steelEdge = measure([0.75, 0.76, 0.8], { viewDir: EYE_EDGE });
    const flatSwing = Math.abs(steelEdge.luma - steelCentre.luma) / Math.max(steelCentre.luma, 1e-6);
    ok('with a FLAT normal the view position moves the result only slightly', flatSwing < 0.6);

    // Perturb the normal the way the albedo-gradient rung will, and the SAME
    // pixel swings enormously — some orientations catch the lobe, others do
    // not. That difference IS a highlight.
    const tilted = norm([0.22, -0.3, 1]);
    const tiltedHit = measure([0.9, 0.9, 0.9], { normal: tilted, viewDir: EYE_CENTRE });
    const flatSame = measure([0.9, 0.9, 0.9], { normal: FLAT_N, viewDir: EYE_CENTRE });
    ok(
      'THE FIX, MEASURED: tilting the normal toward the mirror angle multiplies the response',
      tiltedHit.sun[1] > flatSame.sun[1] * 2
    );
    // And at the actual mirror angle it is a blaze, which is what feeds bloom.
    const mirror = norm([0, -0.27, 1]);
    ok(
      '…and at the mirror angle itself it blows out, which IS a sun glint',
      measure([0.75, 0.76, 0.8], { normal: mirror }).luma > measure([0.75, 0.76, 0.8]).luma * 8
    );
  }

  {
    // The unit conversion, asserted as a relationship rather than a literal.
    ok('the sun is driven as an IRRADIANCE ratio over the dome, not as a unit light', SUN_IRRADIANCE_RATIO > 1);
    const withRatio = measure([0.75, 0.76, 0.8]);
    ok('…and every term stays finite through the composition', withRatio.rgb.every(Number.isFinite));
    ok(
      '…including at zero strength',
      measure([0, 0, 0]).rgb.every((c) => c === 0)
    );
  }
}
