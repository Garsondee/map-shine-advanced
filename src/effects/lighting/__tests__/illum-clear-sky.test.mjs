/**
 * Perf goal attempt 3 (2026-09-24): the illum fill's CLEAR-SKY TWIN.
 *
 * Measured on Church of the Light: the cloud ground-shadow term is ~95% of the
 * illum fill (3.3 ms → 0.17 ms compiled out), evaluated at every pixel even
 * under a cloudless sky. The viewer swaps in a cloud-free twin ONLY while the
 * cloud field is provably empty. These tests pin the two load-bearing facts:
 * the swap keys off the exact threshold value that makes the term ×1, and the
 * twin exists exactly when there is a cloud term to skip.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { buildEnvironmentalLightMaterials, pickIllumMaterial } from '../environmental-light.js';
import {
  CLOUD_THRESHOLD_OFF,
  coverThreshold,
  createCloudUniforms,
  pushCloudUniforms,
  cloudRecipeFor,
  buildCloudFieldNode,
  buildCloudGroundVisNode,
} from '../../../world/cloud-field.js';

function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export function run(t) {
  const { ok } = t;

  // ---- the threshold the swap keys off ---------------------------------------
  ok('coverThreshold(0) is the named OFF value', coverThreshold(0, { coverLut: [0.5] }) === CLOUD_THRESHOLD_OFF);
  ok('negative cover is also OFF', coverThreshold(-1, { coverLut: [0.5] }) === CLOUD_THRESHOLD_OFF);
  ok('OFF is unreachable by a base shape <= 1', CLOUD_THRESHOLD_OFF > 1);
  {
    const u = createCloudUniforms(THREE.TSL);
    ok('fresh cloud uniforms start OFF (nothing pushed yet = no cloud)', u.macroThreshold.value === CLOUD_THRESHOLD_OFF);
    let recipe = null;
    try {
      recipe = cloudRecipeFor(0.3);
    } catch {
      recipe = null;
    }
    ok('a real cloud recipe is available to push', !!recipe);
    if (recipe) {
      pushCloudUniforms(u, { recipe, cover01: 0, scalePx: 1000, drift: { x: 0, y: 0 }, boil: 0, windDir: { x: 1, y: 0 } });
      ok('pushing cover 0 sets macroThreshold OFF', u.macroThreshold.value === CLOUD_THRESHOLD_OFF);
      pushCloudUniforms(u, { recipe, cover01: 0.4, scalePx: 1000, drift: { x: 0, y: 0 }, boil: 0, windDir: { x: 1, y: 0 } });
      ok('pushing real cover moves macroThreshold below OFF', u.macroThreshold.value < CLOUD_THRESHOLD_OFF);
    }
  }

  // ---- the chooser ----------------------------------------------------------
  const cloudy = { id: 'cloudy' };
  const clear = { id: 'clear' };
  const pick = (macroThreshold, c = clear) =>
    pickIllumMaterial({ cloudy, clear: c, macroThreshold, offThreshold: CLOUD_THRESHOLD_OFF });
  ok('OFF threshold -> clear twin', pick(CLOUD_THRESHOLD_OFF) === clear);
  ok('any real threshold -> cloudy', pick(0.62) === cloudy);
  ok('just below OFF -> cloudy (only EXACTLY off may skip)', pick(CLOUD_THRESHOLD_OFF - 1e-6) === cloudy);
  ok('non-finite threshold -> cloudy (never skip on garbage)', pick(NaN) === cloudy && pick(undefined) === cloudy);
  ok('no twin -> always cloudy', pick(CLOUD_THRESHOLD_OFF, null) === cloudy);

  // ---- the twin exists exactly when a cloud term was compiled in ------------
  const base = () => ({
    THREE,
    albedoTexture: stubTexture(),
    illumTexture: stubTexture(),
    colorationTexture: stubTexture(),
    outdoorsTexture: stubTexture(),
  });
  {
    const built = buildEnvironmentalLightMaterials(base());
    ok('no cloud builders -> no cloud term compiled', built.cloudGateCompiled === false);
    ok('...and no clear-sky twin', built.illumMaterialClear === null);
  }
  {
    const { uniform, vec2, float } = THREE.TSL;
    let built = null;
    let err = null;
    try {
      built = buildEnvironmentalLightMaterials({
        ...base(),
        cloudUniforms: createCloudUniforms(THREE.TSL),
        buildCloudField: buildCloudFieldNode,
        buildCloudGroundVis: buildCloudGroundVisNode,
        cloudOffsetNode: uniform(vec2(0, 0)),
        cloudFillShareNode: uniform(float(0.4)),
      });
    } catch (e) {
      err = e;
    }
    ok(`builds with a cloud term (${err ? err.message : 'clean'})`, err === null && built?.cloudGateCompiled === true);
    ok('...and HAS a clear-sky twin', !!built?.illumMaterialClear);
    ok('...a distinct material with its own fragment graph', built?.illumMaterialClear !== built?.illumMaterial && !!built?.illumMaterialClear?.fragmentNode && built.illumMaterialClear.fragmentNode !== built.illumMaterial.fragmentNode);
    ok('...drawn like the original (no depth test/write)', built?.illumMaterialClear?.depthTest === false && built?.illumMaterialClear?.depthWrite === false);
  }
}
