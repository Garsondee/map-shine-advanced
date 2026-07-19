/**
 * Node verification for effects/lighting/environmental-light.js.
 *
 * Only the PURE ambient-ladder math is tested here — `mixRgb`,
 * `computeAmbientBackground`, `computeAmbientColors`.
 * `buildEnvironmentalLightMaterials` builds TSL and is browser-only (verified
 * live via the debug panel / an A/B screenshot vs Foundry, not a mocked THREE
 * — CONVENTIONS.md §4).
 *
 * The ladder is the parity checkpoint Light-Parity.md §5 names: it must equal
 * Foundry's own `background = mix(ambientDaylight, ambientDarkness, darknessLevel)`.
 */
import {
  mixRgb,
  computeAmbientBackground,
  computeAmbientColors,
  computeGlobalLightFloor,
  maxRgb,
  FOUNDRY_LIGHT_WEIGHTS,
} from '../environmental-light.js';

const near = (a, b) => Math.abs(a - b) < 1e-9;
const nearRgb = (a, b) => a.length === 3 && near(a[0], b[0]) && near(a[1], b[1]) && near(a[2], b[2]);

export function run(t) {
  const { ok } = t;

  // ---- mixRgb ------------------------------------------------------------
  {
    const a = [0.2, 0.4, 0.6];
    const b = [0.8, 0.6, 0.4];
    ok('t=0 returns a', nearRgb(mixRgb(a, b, 0), a));
    ok('t=1 returns b', nearRgb(mixRgb(a, b, 1), b));
    ok('t=0.5 is the midpoint', nearRgb(mixRgb(a, b, 0.5), [0.5, 0.5, 0.5]));
    ok('t below 0 clamps to a', nearRgb(mixRgb(a, b, -3), a));
    ok('t above 1 clamps to b', nearRgb(mixRgb(a, b, 5), b));
    ok('a non-finite t reads as 0 (a), never NaN', nearRgb(mixRgb(a, b, NaN), a));
  }

  // ---- computeAmbientBackground = Foundry's ladder -----------------------
  const daylight = [0.93, 0.93, 0.9];
  const darkness = [0.14, 0.14, 0.28];
  const env = (darkness01) => ({ ambient: { daylight, darkness }, darkness01 });
  {
    ok('darkness 0 => full daylight (bright day)', nearRgb(computeAmbientBackground(env(0)), daylight));
    ok("darkness 1 => Foundry's cool dark", nearRgb(computeAmbientBackground(env(1)), darkness));
    ok(
      'darkness 0.5 => exactly halfway (the mix formula, not a curve)',
      nearRgb(computeAmbientBackground(env(0.5)), mixRgb(daylight, darkness, 0.5))
    );
  }

  // ---- THE no-op-at-noon parity precondition -----------------------------
  // A white daylight at darkness 0 must yield a white background — that is what
  // makes the gamma-space composite EOTF(OETF(albedo)×1) the identity, i.e. a
  // fully-lit outdoor scene pixel-identical to the unlit map (and to Foundry).
  {
    const white = computeAmbientBackground({ ambient: { daylight: [1, 1, 1], darkness }, darkness01: 0 });
    ok('white daylight + darkness 0 => white background (the noon no-op)', nearRgb(white, [1, 1, 1]));
  }

  // ---- defaults: a snapshot without ambient still produces a sane colour --
  {
    ok('no ambient field => a finite triple, never a throw', Array.isArray(computeAmbientBackground({})) === true);
    ok(
      'missing darkness01 reads as 0 (daylight end)',
      nearRgb(computeAmbientBackground({ ambient: { daylight, darkness } }), daylight)
    );
  }

  // ---- THE darkness-realism lever (0 = Foundry parity, 1 = true dark) -----
  {
    // Default arg (omitted) MUST equal realism 0 — Foundry parity, so no
    // existing scene's look changes when the lever is untouched.
    ok(
      'omitted realism arg == realism 0 (Foundry parity, the default)',
      nearRgb(computeAmbientBackground(env(1)), computeAmbientBackground(env(1), 0))
    );
    ok(
      'realism 0 at darkness 1 => Foundry darkness colour (never black)',
      nearRgb(computeAmbientBackground(env(1), 0), darkness)
    );
    ok(
      'realism 1 at darkness 1 => TRUE BLACK (the realistic pitch-dark end)',
      nearRgb(computeAmbientBackground(env(1), 1), [0, 0, 0])
    );
    ok(
      'realism 0.5 at darkness 1 => darkness colour pulled halfway to black',
      nearRgb(computeAmbientBackground(env(1), 0.5), [darkness[0] / 2, darkness[1] / 2, darkness[2] / 2])
    );
    // THE key property: the lever only touches the DARKNESS end, so noon is
    // identical at every lever value (a realistic scene is unchanged in
    // daylight — it only bites as the scene darkens).
    ok(
      'realism has NO effect at darkness 0 (noon) — realism 0',
      nearRgb(computeAmbientBackground(env(0), 0), daylight)
    );
    ok(
      'realism has NO effect at darkness 0 (noon) — realism 1',
      nearRgb(computeAmbientBackground(env(0), 1), daylight)
    );
    // A non-finite lever value floors to 0 (Foundry parity), never NaN.
    ok(
      'a non-finite realism reads as 0 (Foundry parity), never NaN',
      nearRgb(computeAmbientBackground(env(1), NaN), darkness)
    );
  }

  // ---- the lever flows through computeAmbientColors: background+dim darken,
  // bright does NOT (light cores stay full-bright in realistic mode) --------
  {
    const brightest = [1, 1, 1];
    const e = { ambient: { daylight, darkness, brightest }, darkness01: 1 };
    const foundryMode = computeAmbientColors(e, 0);
    const realisticMode = computeAmbientColors(e, 1);
    ok('realistic background is black at darkness 1', nearRgb(realisticMode.background, [0, 0, 0]));
    ok(
      'realistic dim is DARKER than Foundry-mode dim (the unlit-ish ring darkens)',
      realisticMode.dim[0] < foundryMode.dim[0]
    );
    ok(
      'bright is IDENTICAL in both modes (weight 1 → ambientBrightest regardless of floor)',
      nearRgb(realisticMode.bright, foundryMode.bright)
    );
  }

  // ======================================================================
  // computeAmbientColors — the bright/dim rungs an illuminated LIGHT reads
  // ======================================================================
  {
    ok(
      'Foundry weights are the documented CONFIG.Canvas.lightLevels default',
      FOUNDRY_LIGHT_WEIGHTS.bright === 1 && FOUNDRY_LIGHT_WEIGHTS.dim === 0.25
    );

    const brightest = [1, 1, 1];
    const env = { ambient: { daylight, darkness, brightest }, darkness01: 0.5 };
    const colors = computeAmbientColors(env);
    const expectedBackground = mixRgb(daylight, darkness, 0.5);
    ok(
      'background matches computeAmbientBackground exactly (same derivation)',
      nearRgb(colors.background, expectedBackground)
    );
    ok('bright = mix(background, brightest, weightBright=1) = brightest exactly', nearRgb(colors.bright, brightest));
    ok(
      'dim = mix(background, bright, weightDim=0.25), NOT background and NOT bright',
      nearRgb(colors.dim, mixRgb(expectedBackground, brightest, 0.25))
    );
  }

  // ---- at darkness 1 with a non-white brightest, bright must still be
  // EXACTLY ambientBrightest (weightBright=1 collapses the mix fully) -------
  {
    const brightest = [0.9, 0.95, 1.0];
    const colors = computeAmbientColors({ ambient: { daylight, darkness, brightest }, darkness01: 1 });
    ok('bright collapses to ambientBrightest regardless of background', nearRgb(colors.bright, brightest));
  }

  // ---- missing brightest defaults to white, never a throw ----------------
  {
    const colors = computeAmbientColors({ ambient: { daylight, darkness }, darkness01: 0 });
    ok('no brightest field => defaults to white', nearRgb(colors.bright, [1, 1, 1]));
  }

  // ======================================================================
  // computeGlobalLightFloor — the global light's own ambient-floor raise
  // ======================================================================
  const ambientColors = { dim: [0.3, 0.3, 0.4], bright: [0.9, 0.9, 1.0] };
  {
    ok('null config => null (nothing to raise)', computeGlobalLightFloor(null, ambientColors) === null);
  }
  {
    // luminosity 0.5 => exposure = 0.5*2-1 = 0 => factor 1 => floor == base exactly.
    const floor = computeGlobalLightFloor({ luminosity01: 0.5, bright: true }, ambientColors);
    ok('luminosity 0.5 is the neutral exposure point (factor=1)', nearRgb(floor, ambientColors.bright));
  }
  {
    // luminosity 0 (GlobalLightData's own default) => exposure=-1 => factor=0 => floor is black,
    // i.e. MAX-blending it changes nothing — matches Foundry's own degenerate case.
    const floor = computeGlobalLightFloor({ luminosity01: 0, bright: true }, ambientColors);
    ok(
      'luminosity 0 => exposure -1 => the floor goes to exactly black (a true no-op under MAX)',
      nearRgb(floor, [0, 0, 0])
    );
  }
  {
    // luminosity 1 => exposure=1 (>0 branch) => factor = 1+1*0.5 = 1.5 => brighter than base.
    const floor = computeGlobalLightFloor({ luminosity01: 1, bright: false }, ambientColors);
    ok(
      'luminosity 1 takes the exposure>0 branch and brightens dim by 1.5x',
      nearRgb(floor, [ambientColors.dim[0] * 1.5, ambientColors.dim[1] * 1.5, ambientColors.dim[2] * 1.5])
    );
  }
  {
    const floorBright = computeGlobalLightFloor({ luminosity01: 0.5, bright: true }, ambientColors);
    const floorDim = computeGlobalLightFloor({ luminosity01: 0.5, bright: false }, ambientColors);
    ok('bright:true reads the bright colour, not dim', nearRgb(floorBright, ambientColors.bright));
    ok('bright:false reads the dim colour, not bright', nearRgb(floorDim, ambientColors.dim));
  }

  // ---- maxRgb --------------------------------------------------------------
  {
    ok('null floor => passthrough unchanged', nearRgb(maxRgb([0.2, 0.5, 0.1], null), [0.2, 0.5, 0.1]));
    ok('per-channel max, not a whole-triple pick', nearRgb(maxRgb([0.1, 0.9, 0.2], [0.5, 0.3, 0.6]), [0.5, 0.9, 0.6]));
    ok(
      'a floor entirely below the base changes nothing',
      nearRgb(maxRgb([0.8, 0.8, 0.8], [0.1, 0.1, 0.1]), [0.8, 0.8, 0.8])
    );
  }
}
