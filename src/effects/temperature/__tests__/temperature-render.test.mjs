/**
 * temperature-render.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN NODE
 * (`keyhole-tsl-constructs-in-node`), through the real present material it is
 * folded into, with each layer on, both on, and back off.
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { buildGradePresentMaterial } from '../../grade/grade-present.js';
import { createTemperatureUniforms, buildFrostNodes, buildHeatRippleOffset } from '../temperature-render.js';
import { HEAT_TAP_Y_FREQ } from '../temperature-model.js';
import {
  sampleExploredNode,
  buildVisionExploredDimMaterial,
  buildVisionSnapshotPublishMaterial,
} from '../../vision/vision-mask-render.js';

function stubTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 128, 128, 128]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

export function run(t) {
  const { ok } = t;
  const TSL = THREE.TSL;
  const { uniform, vec4, texture } = TSL;

  const u = createTemperatureUniforms(TSL);
  ok('uniforms are created', !!u.frostCover && !!u.heatAmpUv && !!u.frostTint);
  const noise = texture(stubTexture());
  const frost = buildFrostNodes(TSL, { uvNode: TSL.uv(), aspectNode: TSL.float(16 / 9), noiseTexNode: noise, u });
  ok('frost nodes build', !!frost.cover && !!frost.crystal && !!frost.offsetUv);
  const ripple = buildHeatRippleOffset(TSL, {
    worldXY: TSL.vec2(0, 0),
    noiseTexNode: noise,
    gate: null,
    u,
    yFreq: HEAT_TAP_Y_FREQ,
  });
  ok('ripple builds with no gate', !!ripple);

  const outdoorsTexNode = texture(stubTexture());
  const build = (withNoise) =>
    buildGradePresentMaterial({
      THREE,
      litTexture: stubTexture(),
      outdoorsTexNode,
      uViewRect: uniform(vec4(0, 0, 1920, 1080)),
      uOutdoorsRect: uniform(vec4(0, 0, 1920, 1080)),
      temperatureNoiseTexture: withNoise ? stubTexture() : undefined,
    });
  const gp = build(true);
  const base = gp.material.fragmentNode;
  ok(
    'starts with neither layer compiled',
    gp.temperatureCompiled().frost === false && gp.temperatureCompiled().heatRipple === false
  );
  gp.setTemperatureEffects({ frost: false, heatRipple: false, frostCover: 0.5 });
  ok('⭐ no change of layers ⇒ no rebuild', gp.material.fragmentNode === base);
  gp.setTemperatureEffects({
    frost: true,
    frostCover: 0.4,
    frostShape: [0.3, 0.5, 0.6, 0.4],
    frostTint: [0.9, 0.95, 1],
  });
  ok('frost on ⇒ rebuilt with frost', gp.temperatureCompiled().frost === true && gp.material.fragmentNode !== base);
  gp.setTemperatureEffects({ frost: true, heatRipple: true, heatAmpUv: [0.001, 0.001], heatScroll: [0.2, 0.4] });
  ok('both layers together build', gp.temperatureCompiled().heatRipple === true);
  gp.setTemperatureEffects({ frost: false, heatRipple: false });
  ok(
    'both off ⇒ back to no layers',
    gp.temperatureCompiled().frost === false && gp.temperatureCompiled().heatRipple === false
  );
  gp.setTemperatureNoise(stubTexture());
  ok('the real tile swaps in without throwing', true);
  const bare = build(false);
  bare.setTemperatureEffects({ frost: true, heatRipple: true });
  ok('built without a noise texture ⇒ the layers never compile in', bare.temperatureCompiled().frost === false);

  // THE FOG HOLD (2026-10-27) — the grade (Temperature's included) kept out of
  // the fog. Built with the gate's own inputs, with every warp layer on too.
  const held = buildGradePresentMaterial({
    THREE,
    litTexture: stubTexture(),
    outdoorsTexNode,
    uViewRect: uniform(vec4(0, 0, 1920, 1080)),
    uOutdoorsRect: uniform(vec4(0, 0, 1920, 1080)),
    temperatureNoiseTexture: stubTexture(),
    fogHold: {
      maskTexture: stubTexture(),
      illumTexture: stubTexture(),
      exploredTexture: stubTexture(),
      uExploredRect: uniform(vec4(0, 0, 1920, 1080)),
      threshold: 0.1,
    },
  });
  const heldBase = held.material.fragmentNode;
  ok('fog hold starts off', held.fogHoldCompiled() === false);
  held.setFogHoldActive(true);
  ok('⭐ fog hold on ⇒ rebuilt with it', held.fogHoldCompiled() === true && held.material.fragmentNode !== heldBase);
  const heldOn = held.material.fragmentNode;
  held.setFogHoldActive(true);
  ok('fog hold on again ⇒ no rebuild', held.material.fragmentNode === heldOn);
  held.setTemperatureEffects({ frost: true, heatRipple: true });
  held.setPlayerVisionMode('nightVision', 0, 1, { x: 10, y: 10 });
  ok('fog hold builds beside frost, ripple and a vision mode', held.fogHoldCompiled() === true);
  held.setFogHoldActive(false);
  ok('fog hold off ⇒ gone', held.fogHoldCompiled() === false);
  bare.setFogHoldActive(true);
  ok('built without fogHold inputs ⇒ the hold never compiles in', bare.fogHoldCompiled() === false);

  // SEEN BY DAYLIGHT (2026-10-27) — "explored" also reads the snapshot's alpha,
  // so ground revealed by light perception (not the sight shape) is remembered.
  const exploredArgs = {
    THREE,
    exploredTexture: stubTexture(),
    uViewRect: uniform(vec4(0, 0, 1920, 1080)),
    uExploredRect: uniform(vec4(0, 0, 1920, 1080)),
    screenUV: TSL.uv(),
  };
  const sightOnly = sampleExploredNode(exploredArgs);
  const withSeen = sampleExploredNode({ ...exploredArgs, exploredSnapshotTexture: stubTexture() });
  ok('explored builds from the sight shape alone', !!sightOnly.isExplored && !!sightOnly.bufferUv);
  ok(
    '⭐ explored builds with the daylight-seen memory unioned in',
    !!withSeen.isExplored && withSeen.isExplored !== sightOnly.isExplored
  );
  const dim = buildVisionExploredDimMaterial({
    THREE,
    maskTexture: stubTexture(),
    illumTexture: stubTexture(),
    threshold: 0.08,
    exploredTexture: stubTexture(),
    exploredSnapshotTexture: stubTexture(),
    uViewRect: exploredArgs.uViewRect,
    uExploredRect: exploredArgs.uExploredRect,
    dimFactor: 0.35,
  });
  ok('the explored-dim quad builds with the memory', !!dim.fragmentNode);
  const relit = buildVisionExploredDimMaterial({
    THREE,
    maskTexture: stubTexture(),
    illumTexture: stubTexture(),
    threshold: 0.08,
    exploredTexture: stubTexture(),
    exploredSnapshotTexture: stubTexture(),
    uViewRect: exploredArgs.uViewRect,
    uExploredRect: exploredArgs.uExploredRect,
    dimFactor: 0.35,
    memoryLight: uniform(TSL.vec3(0.2, 0.2, 0.3)),
  });
  ok(
    '⭐ the explored-dim quad relights memory by the current ambient',
    !!relit.fragmentNode && relit.fragmentNode !== dim.fragmentNode
  );
  const unlitPublish = buildVisionSnapshotPublishMaterial({
    THREE,
    mapOnlyTexture: stubTexture(),
    maskTexture: stubTexture(),
    illumTexture: stubTexture(),
    threshold: 0.08,
    uViewRect: exploredArgs.uViewRect,
    uExploredRect: exploredArgs.uExploredRect,
    storeUnlit: true,
  });
  ok('the snapshot publish quad builds storing unlit colour', !!unlitPublish.fragmentNode);
  const heldSeen = buildGradePresentMaterial({
    THREE,
    litTexture: stubTexture(),
    outdoorsTexNode,
    uViewRect: uniform(vec4(0, 0, 1920, 1080)),
    uOutdoorsRect: uniform(vec4(0, 0, 1920, 1080)),
    fogHold: {
      maskTexture: stubTexture(),
      illumTexture: stubTexture(),
      exploredTexture: stubTexture(),
      exploredSnapshotTexture: stubTexture(),
      uExploredRect: uniform(vec4(0, 0, 1920, 1080)),
      threshold: 0.08,
    },
  });
  heldSeen.setFogHoldActive(true);
  ok('the fog hold builds with the memory', heldSeen.fogHoldCompiled() === true);
}
