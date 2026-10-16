/**
 * PLAYER TORCH FIRE — THE RENDER HALF. Two small additive materials, one for the flame
 * sprites and one for the sparks, built from the Fire effect's own sprite look
 * (`fire/fire-sprite.js`: the bird's-eye archetype shapes, the author's reference colour
 * ramp, the ember ramp, the life fade). See `player-torch-fire-geometry.js`'s header for
 * why a torch is not driven by the Fire effect's GPU particle engine and what these dumb
 * oversized quads do instead.
 *
 * ⚠️ UNVERIFIED LIVE. TSL/GPU code, so no Node test: it is checked in the shader lab
 * (`tools/shader-lab/player-light-lab.js`), which renders these exact builders on a real
 * WebGPU device. The pure half carries the Node tests.
 *
 * Both materials draw into `scene.lit`, after the composite, like the candle flames:
 * additive, no depth write, `toneMapped = false`. Their colour is HDR emission (it feeds
 * bloom), exactly the units the Fire effect's own sprites use.
 *
 * @module effects/player-torch-fire-render
 */

import {
  buildFlameShapeAlpha,
  buildFlameShading,
  buildLifeFade,
  piecewiseLinear,
  piecewiseLinearRgb,
  EMBER_COLOR_STOPS,
  EMBER_EMISSION_STOPS,
  EMBER_EMISSION,
  EMBER_PEAK_OPACITY,
  FIRE_HDR_LINEAR_GAIN,
} from './fire/fire-sprite.js';
import {
  TORCH_FIRE_FLAME_BOX_PX,
  TORCH_FIRE_SPARK_BOX_PX,
  TORCH_FIRE_FLAME_SPREAD_PX,
} from './player-torch-fire-geometry.js';

/**
 * THE LOOK — one place, named constants.
 *
 * Flame sprites restart every LIFE_MIN..LIFE_MAX seconds (Fire's flame lives 2.4-4.2 s; a
 * torch is a small, lively fire so it cycles about three times faster) at a fresh random spot
 * inside a `SPREAD` disc, so the fire boils in place rather than travelling.
 */
/** A flame sprite breathes between these multiples of its base size over its life. */
const FLAME_BREATH_MIN = 0.78;
const FLAME_BREATH_AMP = 0.32;
/** A torch with its burn at 0 is this fraction of full size (it is not drawn at all below the out-threshold). */
const FLAME_MIN_BURN_SIZE = 0.3;
/** Sparks: their sprite colour gain vs Fire's normal ember emission. */
const SPARK_EMISSION_SCALE = 0.1;

/** Stateless 0..1 hash of a float node (the classic sin-fract fold). */
function hash1(TSL, x) {
  const { fract, sin, float } = TSL;
  return fract(sin(x.mul(float(127.1))).mul(float(43758.5453)));
}

/**
 * The flame sprites' material. Per vertex it reads `fireSeed` (the sprite's phase) and
 * `fireLook` = (tint rgb, burn01); the quad is `TORCH_FIRE_FLAME_BOX_PX` square and the sprite
 * is drawn INSIDE it, moved and scaled in the fragment shader.
 *
 * @param {{THREE: *, uGlobalTimeMs?: *, archetype?: string, sizeScale?: number, gain?: number}} args
 *   `sizeScale` multiplies the sprite size, `gain` the emission (see `TORCH_FIRE_FLAME_VARIANTS`).
 * @returns {{material: *, uIntensity: *}}
 */
export function buildTorchFireFlameMaterial({
  THREE,
  uGlobalTimeMs,
  archetype = 'plasmaCore',
  sizeScale = 1,
  gain = 1,
}) {
  const TSL = THREE.TSL;
  const { uv, uniform, attribute, vec2, float, fract, sin, cos, sqrt, smoothstep } = TSL;

  const uIntensity = uniform(float(gain));
  const seed = attribute('fireSeed', 'float');
  const look = attribute('fireLook', 'vec4');
  const age01 = attribute('fireAge', 'float').clamp(0, 1);
  const spriteSize = attribute('fireSize', 'float');
  const burn = look.w;

  const timeS = uGlobalTimeMs ? uGlobalTimeMs.mul(float(0.001)) : float(0);
  const t01 = age01;

  // Each sprite is a world-space particle with its own spawn position and
  // lifetime. Only a tiny fixed scatter remains inside its own quad.
  const angle = hash1(TSL, seed.mul(float(5.71))).mul(float(6.2832));
  const radius = sqrt(hash1(TSL, seed.mul(float(9.13))))
    .mul(float(TORCH_FIRE_FLAME_SPREAD_PX))
    .mul(burn);
  const offset = vec2(cos(angle), sin(angle)).mul(radius);

  const breath = float(FLAME_BREATH_MIN).add(sin(t01.mul(float(3.14159))).mul(float(FLAME_BREATH_AMP)));
  const size = spriteSize
    .mul(float(sizeScale))
    .mul(breath)
    .mul(float(FLAME_MIN_BURN_SIZE).add(burn.mul(float(1 - FLAME_MIN_BURN_SIZE))));

  // The sprite's own 0..1 coordinates, as `buildFlameShapeAlpha` expects.
  const localPx = uv().sub(vec2(0.5, 0.5)).mul(float(TORCH_FIRE_FLAME_BOX_PX));
  const n = localPx.sub(offset).div(size).add(vec2(0.5, 0.5));
  const inside = smoothstep(float(0), float(0.03), n.x)
    .mul(smoothstep(float(0), float(0.03), float(1).sub(n.x)))
    .mul(smoothstep(float(0), float(0.03), n.y))
    .mul(smoothstep(float(0), float(0.03), float(1).sub(n.y)));

  const phase = t01
    .mul(float(6.2832))
    .add(seed)
    .add(timeS.mul(float(0.3)));
  const shape = buildFlameShapeAlpha(TSL, { nx: n.x, ny: n.y, phase, seed: fract(seed.mul(float(0.0731))), archetype });
  const shade = buildFlameShading(TSL, { t01, heat: float(1), brightness: float(1), linearRamp: true });
  const fade = buildLifeFade(TSL, t01, 0.14, 0.16);

  const material = new THREE.NodeMaterial();
  material.colorNode = shade.rgb.mul(look.xyz).mul(uIntensity);
  material.opacityNode = shape.mul(shade.alpha).mul(fade).mul(inside).mul(burn);
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  // DoubleSide or the batch is culled silently: the flipped camera inverts winding (see fire-particle-runtime.js).
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  return { material, uIntensity };
}

/**
 * The sparks' material: small, very bright additive dots that fly out in EVERY direction (a
 * fresh random bearing each flight, never a fixed "up"), slowing as they go, cooling along
 * Fire's ember colour ramp.
 *
 * @param {{THREE: *, uGlobalTimeMs?: *}} args
 * @returns {{material: *, uIntensity: *}}
 */
export function buildTorchFireSparkMaterial({ THREE, uGlobalTimeMs }) {
  const TSL = THREE.TSL;
  const { uv, uniform, attribute, vec2, float, sin, mix, length, clamp } = TSL;

  const uIntensity = uniform(float(1));
  const seed = attribute('fireSeed', 'float');
  const look = attribute('fireLook', 'vec4');
  const age01 = attribute('fireAge', 'float').clamp(0, 1);
  const particleSize = attribute('fireSize', 'float');
  const burn = look.w;

  const timeS = uGlobalTimeMs ? uGlobalTimeMs.mul(float(0.001)) : float(0);
  const t01 = age01;

  const localPx = uv().sub(vec2(0.5, 0.5)).mul(float(TORCH_FIRE_SPARK_BOX_PX));
  const dist = length(localPx);
  const dotRadius = particleSize.mul(mix(float(1), float(0.36), t01)).mul(float(0.3).add(burn.mul(float(0.7))));
  const soft = clamp(float(1).sub(dist.div(dotRadius)), float(0), float(1));
  const radial = soft.mul(soft);
  const fade = buildLifeFade(TSL, t01, 0.22, 0.4);
  const twinkle = float(0.75).add(sin(timeS.mul(float(23)).add(seed.mul(float(5)))).mul(float(0.25)));

  const rgb = piecewiseLinearRgb(TSL, t01, EMBER_COLOR_STOPS)
    .mul(piecewiseLinear(TSL, t01, EMBER_EMISSION_STOPS))
    .mul(float(EMBER_EMISSION * FIRE_HDR_LINEAR_GAIN * SPARK_EMISSION_SCALE))
    .mul(look.xyz)
    .mul(twinkle);

  const material = new THREE.NodeMaterial();
  material.colorNode = rgb.mul(uIntensity);
  material.opacityNode = radial.mul(float(EMBER_PEAK_OPACITY)).mul(fade).mul(burn);
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  return { material, uIntensity };
}

/**
 * A dynamic `THREE.BufferGeometry` for one particle batch. Capacity is allocated
 * ahead of the live population so ordinary particle updates rewrite GPU buffers
 * instead of churning/recreating geometries.
 * @param {*} THREE @param {object} batch @param {{capacityQuads?:number}} [opts]
 * @returns {*} the geometry, draw range already set.
 */
export function buildTorchFireBatchGeometry(THREE, batch, { capacityQuads = batch.quadCount } = {}) {
  const requested = Number(capacityQuads);
  const capacity = Math.max(1, batch.quadCount, Number.isFinite(requested) ? Math.floor(requested) : 0);
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 12);
  const uvs = new Float32Array(capacity * 8);
  const seeds = new Float32Array(capacity * 4);
  const looks = new Float32Array(capacity * 16);
  const ages = new Float32Array(capacity * 4);
  const sizes = new Float32Array(capacity * 4);
  const indices = new Uint32Array(capacity * 6);
  for (let quad = 0; quad < capacity; quad++) {
    const base = quad * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], quad * 6);
  }
  const write = (target, source) => target.set(source);
  write(positions, batch.positions);
  write(uvs, batch.uvs);
  write(seeds, batch.seeds);
  write(looks, batch.looks);
  write(ages, batch.ages);
  write(sizes, batch.sizes);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('fireSeed', new THREE.BufferAttribute(seeds, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('fireLook', new THREE.BufferAttribute(looks, 4).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('fireAge', new THREE.BufferAttribute(ages, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('fireSize', new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.userData.torchFireCapacity = capacity;
  geometry.setDrawRange(0, batch.quadCount * 6);
  return geometry;
}

/** Rewrite one existing batch's active prefix; return false only when it must grow. */
export function updateTorchFireBatchGeometry(geometry, batch) {
  const capacity = Number(geometry?.userData?.torchFireCapacity) || 0;
  if (batch.quadCount > capacity) return false;
  const copy = (name, data) => {
    const attribute = geometry.getAttribute(name);
    attribute.array.set(data, 0);
    attribute.needsUpdate = true;
  };
  copy('position', batch.positions);
  copy('uv', batch.uvs);
  copy('fireSeed', batch.seeds);
  copy('fireLook', batch.looks);
  copy('fireAge', batch.ages);
  copy('fireSize', batch.sizes);
  geometry.setDrawRange(0, batch.quadCount * 6);
  return true;
}
