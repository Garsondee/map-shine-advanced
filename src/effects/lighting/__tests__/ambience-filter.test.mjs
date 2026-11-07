/**
 * ambience-filter.test.mjs — Foundry's scene Environment (base/dark) filter on the art (2026-11-07, mmp-ynr.4).
 *
 * Pinned against numbers measured in real Foundry v14 on 'MSA Test - Light Matrix' (darkness 1, the v14 default
 * environment: dark.luminosity -0.25, everything else 0): a 50% grey floor under the darkness ambient #303030 read
 * 18.9 in Foundry; MSA, without the filter, read 24.9.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  ambienceParamsAt,
  applyAmbienceCpu,
  buildAmbienceNode,
  colorFromHsl,
  createAmbienceUniforms,
  deriveAmbienceUniforms,
  setAmbienceUniforms,
} from '../ambience-filter.js';

const V14_DEFAULT = {
  cycle: true,
  base: { hue: 0, intensity: 0, luminosity: 0, saturation: 0, shadows: 0 },
  dark: { hue: 0.7138888888888889, intensity: 0, luminosity: -0.25, saturation: 0, shadows: 0 },
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;

  // ---- uniforms from the scene ----
  {
    const u = deriveAmbienceUniforms(V14_DEFAULT);
    ok("v14's default environment is an active filter (dark luminosity -0.25, cycle on)", u.enabled === true);
    ok('...a scene with nothing set is not', deriveAmbienceUniforms({ cycle: true }).enabled === false);
    ok(
      '...nor is a dark-only setting with the day/night cycle off',
      deriveAmbienceUniforms({ ...V14_DEFAULT, cycle: false }).enabled === false
    );
    ok('a missing environment reads as off, not a throw', deriveAmbienceUniforms(undefined).enabled === false);
    const red = colorFromHsl([0, 1, 0.5]);
    ok('Color.fromHSL hue 0 is red', red[0] === 1 && red[1] === 0 && red[2] === 0);
    const hue = colorFromHsl([0.7138888888888889, 1, 0.5]);
    ok(
      '...and quantises to 8 bits like Color.fromRGB',
      hue.every((c) => near(c * 255, Math.round(c * 255)))
    );
  }

  // ---- computeAmbienceParameters ----
  {
    const u = deriveAmbienceUniforms(V14_DEFAULT);
    const day = ambienceParamsAt(u, 0);
    const night = ambienceParamsAt(u, 1);
    const dusk = ambienceParamsAt(u, 0.5);
    ok('at darkness 0 the default filter is identity', day.luminosity === 0 && day.saturation === 0);
    ok('at darkness 1 luminosity is -0.25 × 0.8 = -0.2', near(night.luminosity, -0.2));
    ok('...halfway it is -0.1 (mixed, then ×0.8)', near(dusk.luminosity, -0.1));
    ok(
      'a brightening luminosity is scaled ×1.2',
      near(ambienceParamsAt(deriveAmbienceUniforms({ base: { luminosity: 0.5 } }), 0).luminosity, 0.6)
    );
    const s = ambienceParamsAt(deriveAmbienceUniforms({ cycle: true, dark: { shadows: 1 } }), 1);
    ok('shadows are ×0.15', near(s.shadows, 0.15));
    const tinted = ambienceParamsAt(deriveAmbienceUniforms({ cycle: true, base: { hue: 0, intensity: 0.5 } }), 0);
    ok('intensity eases as x²', near(tinted.intensity, 0.25) && tinted.tint[0] === 1);
  }

  // ---- the filter, against Foundry's measured pixels ----
  {
    const night = ambienceParamsAt(deriveAmbienceUniforms(V14_DEFAULT), 1);
    const grey = 128 / 255;
    const out = applyAmbienceCpu([grey, grey, grey], night);
    const litFloor = out[0] * (48 / 255) * 255; // × the darkness ambient #303030, in sRGB as MSA's composite does
    ok(
      `a 50% grey floor at night: ${litFloor.toFixed(1)} (Foundry measured 18.9, MSA was 24.9)`,
      Math.abs(litFloor - 18.9) < 1
    );
    ok('luminosity alone is a plain ×0.8 in sRGB', near(out[0], grey * 0.8, 1e-4));
    ok(
      'identity parameters leave a colour unchanged',
      applyAmbienceCpu([0.3, 0.6, 0.9], ambienceParamsAt(deriveAmbienceUniforms({}), 1)).every((c, i) =>
        near(c, [0.3, 0.6, 0.9][i], 1e-6)
      )
    );
    const desat = applyAmbienceCpu([1, 0, 0], {
      tint: [1, 1, 1],
      intensity: 0,
      luminosity: 0,
      saturation: -1,
      shadows: 0,
    });
    ok('saturation -1 is grey (BT709 luminance)', near(desat[0], desat[1], 1e-6) && near(desat[1], desat[2], 1e-6));
  }

  // ---- the TSL node builds and is wired to its uniforms ----
  {
    const u = createAmbienceUniforms(THREE.TSL);
    const node = buildAmbienceNode(THREE.TSL, THREE.TSL.vec3(0.5, 0.5, 0.5), u);
    ok('buildAmbienceNode returns a node', !!node && typeof node === 'object');
    setAmbienceUniforms(u, deriveAmbienceUniforms(V14_DEFAULT), 1);
    ok('setAmbienceUniforms pushes darkness-1 values', u.enabled.value === 1 && near(u.luminosity.value, -0.2));
    setAmbienceUniforms(u, deriveAmbienceUniforms({}), 1);
    ok('...and turns the filter off for a scene with nothing set', u.enabled.value === 0);
  }
}
