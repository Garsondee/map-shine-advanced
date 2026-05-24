/**
 * @fileoverview Ash ground cloud billboard shader — dark grey, outdoors-gated, organic reveal.
 * @module compositor-v2/effects/ash-cloud-sprites/ash-cloud-shaders
 */

const OUTDOORS_READ_GLSL = /* glsl */`
  uniform sampler2D tOutdoorsMask;
  uniform sampler2D tOutdoorsMask0;
  uniform sampler2D tOutdoorsMask1;
  uniform sampler2D tOutdoorsMask2;
  uniform sampler2D tOutdoorsMask3;
  uniform sampler2D tFloorIdTex;
  uniform float uHasOutdoorsMask;
  uniform float uHasFloorIdTex;
  uniform float uOutdoorsMaskFlipY;
  uniform vec2 uSceneOrigin;
  uniform vec2 uSceneSize;
  uniform vec2 uSceneDimensions;

  vec2 ashWorldToSceneUv(vec2 worldPos) {
    float foundryX = worldPos.x;
    float foundryY = uSceneDimensions.y - worldPos.y;
    return (vec2(foundryX, foundryY) - uSceneOrigin) / max(uSceneSize, vec2(1e-5));
  }

  float readAshOutdoors(vec2 worldPos) {
    if (uHasOutdoorsMask < 0.5) return 1.0;
    vec2 sceneUvFoundry = ashWorldToSceneUv(worldPos);
    vec2 sceneUvFoundryClamped = clamp(sceneUvFoundry, vec2(0.0), vec2(1.0));
    vec2 maskUv = vec2(
      sceneUvFoundryClamped.x,
      (uOutdoorsMaskFlipY > 0.5) ? (1.0 - sceneUvFoundryClamped.y) : sceneUvFoundryClamped.y
    );
    if (uHasFloorIdTex > 0.5) {
      vec2 sceneUvThree = vec2(sceneUvFoundryClamped.x, 1.0 - sceneUvFoundryClamped.y);
      float fid = texture2D(tFloorIdTex, sceneUvThree).r;
      float idx = floor(fid * 255.0 + 0.5);
      if (idx < 0.5) return texture2D(tOutdoorsMask0, maskUv).r;
      if (idx < 1.5) return texture2D(tOutdoorsMask1, maskUv).r;
      if (idx < 2.5) return texture2D(tOutdoorsMask2, maskUv).r;
      return texture2D(tOutdoorsMask3, maskUv).r;
    }
    return texture2D(tOutdoorsMask, maskUv).r;
  }
`;

const NOISE_GLSL = /* glsl */`
  float ashHash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float ashValueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = ashHash12(i);
    float b = ashHash12(i + vec2(1.0, 0.0));
    float c = ashHash12(i + vec2(0.0, 1.0));
    float d = ashHash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  vec2 ashBoilUv(vec2 uv, vec2 seed, float t, float strength) {
    if (strength <= 0.0005) return uv;
    vec2 w = vec2(
      sin(uv.y * 8.0 + t * 0.45 + seed.x * 6.283),
      cos(uv.x * 7.0 + t * 0.38 + seed.y * 6.283)
    );
    vec2 w2 = vec2(
      sin(uv.x * 11.0 - t * 0.29 + seed.y * 4.71),
      cos(uv.y * 9.5 + t * 0.33 + seed.x * 3.14)
    );
    return uv + (w + w2 * 0.45) * strength * 0.018;
  }
`;

/**
 * @param {typeof import('three')} THREE
 */
export function createAshCloudSpriteMaterial(THREE) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      opacity: { value: 1.0 },
      uAshColor: { value: new THREE.Vector3(0.082, 0.078, 0.072) },
      uOpacityCap: { value: 0.68 },
      uWarpSeed: { value: new THREE.Vector2(0, 0) },
      uWarpStrength: { value: 0.03 },
      uTime: { value: 0 },
      uRevealNoiseScale: { value: 0.00012 },
      uRevealThreshold: { value: 0.55 },
      uRevealSoftness: { value: 0.18 },
      uRevealSeed: { value: new THREE.Vector2(0, 0) },
      tOutdoorsMask: { value: null },
      tOutdoorsMask0: { value: null },
      tOutdoorsMask1: { value: null },
      tOutdoorsMask2: { value: null },
      tOutdoorsMask3: { value: null },
      tFloorIdTex: { value: null },
      uHasOutdoorsMask: { value: 0 },
      uHasFloorIdTex: { value: 0 },
      uOutdoorsMaskFlipY: { value: 0 },
      uSceneOrigin: { value: new THREE.Vector2(0, 0) },
      uSceneSize: { value: new THREE.Vector2(4000, 3000) },
      uSceneDimensions: { value: new THREE.Vector2(4000, 3000) },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      varying vec2 vWorldXY;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldXY = worldPos.xy;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      uniform float opacity;
      uniform vec3 uAshColor;
      uniform float uOpacityCap;
      uniform vec2 uWarpSeed;
      uniform float uWarpStrength;
      uniform float uTime;
      uniform float uRevealNoiseScale;
      uniform float uRevealThreshold;
      uniform float uRevealSoftness;
      uniform vec2 uRevealSeed;

      varying vec2 vUv;
      varying vec2 vWorldXY;

      ${OUTDOORS_READ_GLSL}
      ${NOISE_GLSL}

      void main() {
        vec2 sampleUv = ashBoilUv(vUv, uWarpSeed, uTime, uWarpStrength);
        vec4 tex = texture2D(map, clamp(sampleUv, 0.0, 1.0));
        if (tex.a < 0.02) discard;

        float outdoors = readAshOutdoors(vWorldXY);
        if (outdoors < 0.02) discard;

        float n = ashValueNoise(vWorldXY * max(uRevealNoiseScale, 1e-8) + uRevealSeed);
        float soft = max(uRevealSoftness, 0.02);
        float reveal = 1.0 - smoothstep(
          uRevealThreshold - soft,
          uRevealThreshold + soft,
          n
        );

        float alpha = tex.a * clamp(opacity, 0.0, 1.0) * clamp(uOpacityCap, 0.0, 1.0);
        alpha *= reveal * outdoors;

        if (alpha < 0.001) discard;

        vec3 rgb = uAshColor * alpha;
        gl_FragColor = vec4(rgb, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    premultipliedAlpha: true,
    toneMapped: false,
  });
  return mat;
}

/**
 * @param {import('three').ShaderMaterial} material
 * @param {object} masks
 */
export function applyAshCloudMaskUniforms(material, masks) {
  const u = material?.uniforms;
  if (!u) return;

  u.tFloorIdTex.value = masks.floorIdTex ?? null;
  u.uHasFloorIdTex.value = masks.floorIdTex ? 1 : 0;

  const fw = masks.fallbackWhite ?? null;
  u.tOutdoorsMask0.value = masks.outdoorsMasks?.[0] ?? fw ?? null;
  u.tOutdoorsMask1.value = masks.outdoorsMasks?.[1] ?? fw ?? null;
  u.tOutdoorsMask2.value = masks.outdoorsMasks?.[2] ?? fw ?? null;
  u.tOutdoorsMask3.value = masks.outdoorsMasks?.[3] ?? fw ?? null;
  const anyPerFloor = !!(masks.outdoorsMasks?.[0] || masks.outdoorsMasks?.[1]
    || masks.outdoorsMasks?.[2] || masks.outdoorsMasks?.[3]);
  u.uHasOutdoorsMask.value = (anyPerFloor || masks.outdoorsMask) ? 1 : 0;
  u.tOutdoorsMask.value = masks.outdoorsMask ?? fw ?? null;

  const anyTex = masks.outdoorsMasks?.find((t) => !!t) ?? masks.outdoorsMask ?? null;
  u.uOutdoorsMaskFlipY.value = anyTex?.flipY ? 1.0 : 0.0;

  if (u.uSceneOrigin?.value?.set) {
    u.uSceneOrigin.value.set(masks.sceneOriginX ?? 0, masks.sceneOriginY ?? 0);
  }
  if (u.uSceneSize?.value?.set) {
    u.uSceneSize.value.set(masks.sceneW ?? 4000, masks.sceneH ?? 3000);
  }
  if (u.uSceneDimensions?.value?.set) {
    u.uSceneDimensions.value.set(masks.sceneDimW ?? 4000, masks.sceneDimH ?? 3000);
  }
}
