/**
 * THE CANDLE LIGHT'S VERTEX OUTPUTS (2026-11-11) — WebGPU allows 16 per pipeline. The candle illumination shader
 * (batched light + soft-wall-edge attributes + the candle's per-light values) reached 17: the pipeline failed
 * ("Vertex output variable ... location (16) is too large") and candle-animated lights drew nothing.
 *
 * This builds the candle's own graph for real (three's WGSL builder, no GPU) and counts the vertex outputs it adds.
 * The candle owns a fixed budget of them; the rest of the 16 belongs to the light batch and penumbra attributes
 * (`light-penumbra.js`, `point-light-batch-mesh.js`), so a new candle varying has to take one from somewhere else.
 */
import * as THREE from '../../../../vendor/three/three.webgpu.js';
import { materialWgsl } from '../../../../core/__tests__/wgsl-harness.mjs';
import { buildCandleFlickerIlluminationSeed } from '../candle-flicker.js';

/** Outputs this graph adds beyond the always-present position pair. */
export const CANDLE_VARYING_BUDGET = 4;

/** Vertex outputs of a material whose fragment is the candle's illumination at `quality`. */
function candleVertexOutputs(quality, withWind) {
  const { uniform, float, vec3, positionLocal, length } = THREE.TSL;
  const local = positionLocal.xy;
  const seed = buildCandleFlickerIlluminationSeed({
    THREE,
    uDimColor: uniform(new THREE.Color(0.2, 0.1, 0.05)),
    uRatio: uniform(0.5),
    uIntensityRaw: uniform(5),
    time: uniform(1.25),
    dist: length(local),
    localPosition: local,
    computeSwitchColorBand: (r) => vec3(r, r, r),
    quality,
    wind: withWind ? uniform(new THREE.Vector2(0.3, 0.1)) : undefined,
    windResponse: withWind ? uniform(1) : undefined,
  });
  const m = new THREE.NodeMaterial();
  m.fragmentNode = THREE.TSL.vec4(seed.finalColor, seed.presence01 ?? float(1));
  const { vertex } = materialWgsl(m);
  const struct = vertex.slice(vertex.indexOf('struct VaryingsStruct'));
  const body = struct.slice(0, struct.indexOf('}'));
  return [...body.matchAll(/@location\(\s*\d+\s*\)\s*(\w+)/g)]
    .map((x) => x[1])
    .filter((n) => !/^(v_positionWorld|position)$/.test(n));
}

export function run(t) {
  const { ok } = t;
  for (const quality of [0, 1, 2]) {
    for (const withWind of [false, true]) {
      const names = candleVertexOutputs(quality, withWind);
      ok(
        `candle light, quality ${quality}${withWind ? ' + wind' : ''}: ${names.length} vertex outputs (budget ${CANDLE_VARYING_BUDGET}: ${names.join(' ')})`,
        names.length <= CANDLE_VARYING_BUDGET
      );
    }
  }
  // The worst case must still carry the values the fragment reads (packed, not dropped).
  const worst = candleVertexOutputs(2, true);
  ok('the top rung packs life/pulse/warmth/presence into one varying', worst.includes('vCandleLifePack'));
  ok(
    'the top rung packs lean/axis and stretch/size',
    worst.includes('vCandleLeanAxis') && worst.includes('vCandleStretch')
  );
}
