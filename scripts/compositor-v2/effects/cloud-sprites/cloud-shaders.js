/**
 * @fileoverview Fullscreen shadow-mask + world-space blit shaders for sprite clouds.
 * @module compositor-v2/effects/cloud-sprites/cloud-shaders
 */

/** @param {typeof import('three')} THREE */
export function createShadowMaskMaterial(THREE) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tShadowRaw: { value: null },
      tFloorIdTex: { value: null },
      uHasFloorIdTex: { value: 0 },
      tOutdoorsMask: { value: null },
      tOutdoorsMask0: { value: null },
      tOutdoorsMask1: { value: null },
      tOutdoorsMask2: { value: null },
      tOutdoorsMask3: { value: null },
      uHasOutdoorsMask: { value: 0 },
      uOutdoorsMaskFlipY: { value: 0 },
      uShadowSoftness: { value: 0.9 },
      uTexelSize: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      uZoom: { value: 1 },
      uMinBrightness: { value: 0 },
      uSceneFadeSoftness: { value: 0.025 },
      uApplyOutdoorsMask: { value: 1.0 },
      uViewBoundsMin: { value: new THREE.Vector2(0, 0) },
      uViewBoundsMax: { value: new THREE.Vector2(4000, 3000) },
      uCaptureBoundsMin: { value: new THREE.Vector2(0, 0) },
      uCaptureBoundsMax: { value: new THREE.Vector2(4000, 3000) },
      uSceneOrigin: { value: new THREE.Vector2(0, 0) },
      uSceneSize: { value: new THREE.Vector2(4000, 3000) },
      uSceneDimensions: { value: new THREE.Vector2(4000, 3000) },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tShadowRaw;
      uniform sampler2D tFloorIdTex;
      uniform float uHasFloorIdTex;
      uniform sampler2D tOutdoorsMask;
      uniform sampler2D tOutdoorsMask0;
      uniform sampler2D tOutdoorsMask1;
      uniform sampler2D tOutdoorsMask2;
      uniform sampler2D tOutdoorsMask3;
      uniform float uHasOutdoorsMask;
      uniform float uOutdoorsMaskFlipY;
      uniform float uShadowSoftness;
      uniform vec2 uTexelSize;
      uniform float uZoom;
      uniform float uMinBrightness;
      uniform float uSceneFadeSoftness;
      uniform float uApplyOutdoorsMask;
      uniform vec2 uViewBoundsMin;
      uniform vec2 uViewBoundsMax;
      uniform vec2 uCaptureBoundsMin;
      uniform vec2 uCaptureBoundsMax;
      uniform vec2 uSceneOrigin;
      uniform vec2 uSceneSize;
      uniform vec2 uSceneDimensions;
      varying vec2 vUv;

      vec2 worldToSceneUv(vec2 worldPos) {
        float foundryX = worldPos.x;
        float foundryY = uSceneDimensions.y - worldPos.y;
        return (vec2(foundryX, foundryY) - uSceneOrigin) / max(uSceneSize, vec2(1e-5));
      }

      float readOutdoors(vec2 sceneUvFoundry) {
        if (uHasOutdoorsMask < 0.5) return 1.0;
        vec2 maskUv = vec2(sceneUvFoundry.x, (uOutdoorsMaskFlipY > 0.5) ? (1.0 - sceneUvFoundry.y) : sceneUvFoundry.y);
        if (uHasFloorIdTex > 0.5) {
          vec2 sceneUvThree = vec2(sceneUvFoundry.x, 1.0 - sceneUvFoundry.y);
          float fid = texture2D(tFloorIdTex, sceneUvThree).r;
          float idx = floor(fid * 255.0 + 0.5);
          if (idx < 0.5) return texture2D(tOutdoorsMask0, maskUv).r;
          if (idx < 1.5) return texture2D(tOutdoorsMask1, maskUv).r;
          if (idx < 2.5) return texture2D(tOutdoorsMask2, maskUv).r;
          return texture2D(tOutdoorsMask3, maskUv).r;
        }
        return texture2D(tOutdoorsMask, maskUv).r;
      }

      void main() {
        vec2 baseWorld = mix(uViewBoundsMin, uViewBoundsMax, vUv);
        vec2 sceneUvRaw = worldToSceneUv(baseWorld);
        float sf = max(uSceneFadeSoftness, 0.001);
        float sfX = smoothstep(-sf, 0.0, sceneUvRaw.x) * smoothstep(1.0 + sf, 1.0, sceneUvRaw.x);
        float sfY = smoothstep(-sf, 0.0, sceneUvRaw.y) * smoothstep(1.0 + sf, 1.0, sceneUvRaw.y);
        float sceneMask = sfX * sfY;

        vec2 captureSize = max(uCaptureBoundsMax - uCaptureBoundsMin, vec2(1e-5));
        vec2 baseCaptureUv = (baseWorld - uCaptureBoundsMin) / captureSize;
        float blurPx = uShadowSoftness * 20.0 * uZoom;
        vec2 stepCaptureUv = uTexelSize * blurPx;
        float accum = 0.0;
        float wsum = 0.0;
        for (int dy = -1; dy <= 1; dy++) {
          for (int dx = -1; dx <= 1; dx++) {
            float w = (dx == 0 && dy == 0) ? 2.0 : 1.0;
            vec2 captureUv = clamp(
              baseCaptureUv + vec2(float(dx), float(dy)) * stepCaptureUv,
              vec2(0.0),
              vec2(1.0)
            );
            accum += texture2D(tShadowRaw, captureUv).r * w;
            wsum += w;
          }
        }
        float factor = max(accum / max(wsum, 0.001), uMinBrightness);

        if (uApplyOutdoorsMask > 0.5 && uHasOutdoorsMask > 0.5) {
          float outdoorsInScene =
            step(0.0, sceneUvRaw.x) * step(sceneUvRaw.x, 1.0) *
            step(0.0, sceneUvRaw.y) * step(sceneUvRaw.y, 1.0);
          vec2 sceneUvFoundry = clamp(sceneUvRaw, vec2(0.0), vec2(1.0));
          float outdoors = readOutdoors(sceneUvFoundry);
          factor = mix(1.0, factor, mix(1.0, outdoors, outdoorsInScene));
        }

        factor = mix(1.0, factor, sceneMask);
        gl_FragColor = vec4(factor, factor, factor, 1.0);
      }
    `,
    depthWrite: false,
    depthTest: false,
  });
  mat.toneMapped = false;
  return mat;
}

/** @param {typeof import('three')} THREE */
export function createCloudLayerMaterialTemplate(THREE) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tCloudTop: { value: null },
      uViewBoundsMin: { value: new THREE.Vector2(0, 0) },
      uViewBoundsMax: { value: new THREE.Vector2(4000, 3000) },
      uCaptureBoundsMin: { value: new THREE.Vector2(0, 0) },
      uCaptureBoundsMax: { value: new THREE.Vector2(4000, 3000) },
      uUvOffset: { value: new THREE.Vector2(0, 0) },
      uOpacityMul: { value: 1 },
      uEdgeSoftness: { value: 0.12 },
      uAlphaStart: { value: 0.2 },
      uAlphaEnd: { value: 0.6 },
      uLayerReveal: { value: 0.9 },
      uNoiseSeed: { value: new THREE.Vector2(0, 0) },
      uNoiseScale: { value: 0.0002 },
      uNoiseSoftness: { value: 0.015 },
    },
    vertexShader: /* glsl */`
      varying vec2 vWorldXY;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldXY = worldPos.xy;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tCloudTop;
      uniform vec2 uViewBoundsMin;
      uniform vec2 uViewBoundsMax;
      uniform vec2 uCaptureBoundsMin;
      uniform vec2 uCaptureBoundsMax;
      uniform vec2 uUvOffset;
      uniform float uOpacityMul;
      uniform float uEdgeSoftness;
      uniform float uAlphaStart;
      uniform float uAlphaEnd;
      uniform float uLayerReveal;
      uniform vec2 uNoiseSeed;
      uniform float uNoiseScale;
      uniform float uNoiseSoftness;
      varying vec2 vWorldXY;

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash12(i);
        float b = hash12(i + vec2(1.0, 0.0));
        float c = hash12(i + vec2(0.0, 1.0));
        float d = hash12(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      void main() {
        vec2 captureSize = max(uCaptureBoundsMax - uCaptureBoundsMin, vec2(1e-3));
        vec2 uv = (vWorldXY - uCaptureBoundsMin) / captureSize + uUvOffset;

        vec2 meshSize = max(uViewBoundsMax - uViewBoundsMin, vec2(1e-3));
        vec2 edgeDist = min(vWorldXY - uViewBoundsMin, uViewBoundsMax - vWorldXY) / meshSize;
        float edgeFade = smoothstep(0.0, max(uEdgeSoftness, 0.001), min(edgeDist.x, edgeDist.y));

        vec4 sampleCol = texture2D(tCloudTop, clamp(uv, 0.0, 1.0));
        float alpha = sampleCol.a * uOpacityMul * edgeFade;
        float edgeSoft = smoothstep(uAlphaStart, uAlphaEnd, sampleCol.a);
        alpha *= edgeSoft;

        // Soft fade at capture atlas edges (replaces hard UV discard that clipped mid-scene).
        const float captureEdgeSoft = 0.04;
        float uvFade = smoothstep(0.0, captureEdgeSoft, uv.x)
          * smoothstep(1.0, 1.0 - captureEdgeSoft, uv.x)
          * smoothstep(0.0, captureEdgeSoft, uv.y)
          * smoothstep(1.0, 1.0 - captureEdgeSoft, uv.y);
        alpha *= uvFade;

        // Smooth value noise — no floor() cell grid (that caused sharp lines across the scene).
        float n = valueNoise(vWorldXY * max(uNoiseScale, 1e-6) + uNoiseSeed);
        float reveal = clamp(uLayerReveal, 0.001, 1.0);
        float soft = max(uNoiseSoftness, 0.02);
        alpha *= 1.0 - smoothstep(reveal - soft, reveal + soft, n);

        if (alpha < 0.001) discard;
        gl_FragColor = vec4(sampleCol.rgb * alpha, alpha);
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
  });
  mat.toneMapped = false;
  return mat;
}

/**
 * Multiplicative shadow sprite material — order-independent darkening on a white RT.
 * @param {typeof import('three')} THREE
 */
export function createCloudShadowSpriteMaterial(THREE) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      opacity: { value: 1.0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      uniform float opacity;
      varying vec2 vUv;
      void main() {
        float a = texture2D(map, vUv).a;
        if (a < 0.02) discard;
        float shade = 1.0 - a * clamp(opacity, 0.0, 1.0);
        gl_FragColor = vec4(shade, shade, shade, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    blendEquation: THREE.AddEquation,
  });
  return mat;
}
