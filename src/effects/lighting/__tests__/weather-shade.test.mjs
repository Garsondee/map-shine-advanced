/**
 * WEATHER SHADE — `effects/lighting/weather-shade.js`: weather darkened by the
 * local illumination (building/cloud shadows, darkness regions) relative to the
 * scene's ambient level. The node is CONSTRUCTED against the real vendored
 * THREE, so a TSL typo fails here rather than on the author's live scene.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { weatherShade, buildWeatherShadeNode, WEATHER_SHADE_MIN } from '../weather-shade.js';

export function run(t) {
  t.ok('lit like the ambient => no shade', weatherShade(0.5, 0.5) === 1);
  t.ok('a torch pool brighter than ambient never brightens', weatherShade(3, 0.5) === 1);
  t.ok('half the ambient => half', Math.abs(weatherShade(0.25, 0.5) - 0.5) < 1e-9);
  t.ok('a full building shadow floors, never black', weatherShade(0, 1) === WEATHER_SHADE_MIN);
  t.ok('non-finite inputs fail to unshaded', weatherShade(NaN, 1) === 1 && weatherShade(0.5, undefined) === 1);
  t.ok('a zero scene light does not divide by zero', Number.isFinite(weatherShade(0.01, 0)));

  t.ok(
    'no illum texture => term compiles out (null)',
    buildWeatherShadeNode(THREE.TSL, { illumTexNode: null, uSceneLight: null }) === null
  );
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const node = buildWeatherShadeNode(THREE.TSL, {
    illumTexNode: THREE.TSL.texture(tex),
    uSceneLight: THREE.TSL.uniform(1),
  });
  t.ok('with an illum texture the node builds', node && typeof node.mul === 'function');
}
