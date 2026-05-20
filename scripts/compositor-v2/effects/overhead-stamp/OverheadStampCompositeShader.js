/**
 * @fileoverview World-pinned overhead stamp composite shader (pre-blurred masks).
 *
 * WebGL1 limit: max 16 texture units. This shader uses 12 sampler2D slots.
 * Blurred masks are bound on the CPU into tRoofStamp / tFluidRoof / tTileProjection.
 */

/** @returns {string} */
export function getOverheadStampCompositeVertexShader() {
  return `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
}

/** @returns {string} */
export function getOverheadStampCompositeFragmentShader() {
  return `
    uniform sampler2D tRoof;
    uniform sampler2D tRoofStamp;
    uniform sampler2D tRoofVisibility;
    uniform float uHasRoofVisibility;
    uniform float uOpacity;
    uniform float uLength;
    uniform vec2 uTexelSize;
    uniform float uRoofUvScale;
    uniform float uTileProjectionUvScale;
    uniform vec2 uSunDir;
    uniform float uSunDirLength;
    uniform float uShadowLengthScale;
    uniform vec2 uResolution;
    uniform float uZoom;
    uniform float uHoverRevealActive;
    uniform float uOutdoorShadowLengthScale;
    uniform float uIndoorReceiverShadowLengthScale;
    uniform sampler2D uOutdoorsMask;
    uniform float uHasOutdoorsMask;
    uniform float uOutdoorsMaskFlipY;
    uniform float uFluidColorEnabled;
    uniform float uFluidEffectTransparency;
    uniform float uFluidShadowIntensityBoost;
    uniform float uFluidColorBoost;
    uniform float uFluidColorSaturation;
    uniform float uIndoorFluidShadowIntensityBoost;
    uniform float uIndoorFluidColorSaturation;
    uniform sampler2D tFluidRoof;
    uniform float uHasFluidRoof;
    uniform sampler2D tTileProjection;
    uniform sampler2D tTileProjectionRaw;
    uniform float uHasTileProjectionRaw;
    uniform float uHasTileProjection;
    uniform sampler2D tTileProjectionSort;
    uniform float uHasTileProjectionSort;
    uniform sampler2D tTileReceiverAlpha;
    uniform sampler2D tTileReceiverSort;
    uniform float uHasTileReceiverSort;
    uniform float uTileProjectionEnabled;
    uniform float uTileProjectionOpacity;
    uniform float uTileProjectionLengthScale;
    uniform float uTileProjectionThreshold;
    uniform float uTileProjectionPower;
    uniform float uTileProjectionOutdoorOpacityScale;
    uniform float uTileProjectionIndoorOpacityScale;
    uniform float uTileProjectionSortBias;
    uniform vec2 uSceneDimensions;
    uniform vec2 uStampSceneOrigin;
    uniform vec2 uStampSceneSize;
    uniform vec2 uStampViewCorner00;
    uniform vec2 uStampViewCorner10;
    uniform vec2 uStampViewCorner01;
    uniform vec2 uStampViewCorner11;
    uniform float uHasStampViewMapping;
    uniform sampler2D uDepthTexture;
    uniform float uDepthEnabled;
    uniform float uDepthCameraNear;
    uniform float uDepthCameraFar;
    uniform float uGroundDistance;
    uniform float uDebugView;
    uniform sampler2D tDynamicLight;
    uniform sampler2D tWindowLight;
    uniform float uHasDynamicLight;
    uniform float uHasWindowLight;
    uniform float uDynamicLightShadowOverrideEnabled;
    uniform float uDynamicLightShadowOverrideStrength;
    varying vec2 vUv;

    float msa_linearizeDepth(float d) {
      float z_ndc = d * 2.0 - 1.0;
      return (2.0 * uDepthCameraNear * uDepthCameraFar) /
             (uDepthCameraFar + uDepthCameraNear - z_ndc * (uDepthCameraFar - uDepthCameraNear));
    }

    float uvInBounds(vec2 uv, vec2 texelSize) {
      vec2 safeMin = max(texelSize * 0.25, vec2(0.0));
      vec2 safeMax = min(vec2(1.0) - texelSize * 0.25, vec2(1.0));
      vec2 ge0 = step(safeMin, uv);
      vec2 le1 = step(uv, safeMax);
      return ge0.x * ge0.y * le1.x * le1.y;
    }

    float readOutdoorsMask(vec2 uv) {
      vec2 suv = clamp(uv, 0.0, 1.0);
      if (uOutdoorsMaskFlipY > 0.5) suv.y = 1.0 - suv.y;
      vec4 m = texture2D(uOutdoorsMask, suv);
      return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
    }

    vec2 stampWorldXYFromScreen(vec2 screenUv) {
      if (uHasStampViewMapping < 0.5) return screenUv;
      vec2 w0 = mix(uStampViewCorner00, uStampViewCorner10, screenUv.x);
      vec2 w1 = mix(uStampViewCorner01, uStampViewCorner11, screenUv.x);
      return mix(w0, w1, screenUv.y);
    }

    vec2 stampFoundryFromScreen(vec2 screenUv) {
      vec2 worldXY = stampWorldXYFromScreen(screenUv);
      return vec2(worldXY.x, uSceneDimensions.y - worldXY.y);
    }

    vec2 stampSceneUvFromFoundry(vec2 foundryPos) {
      return clamp(
        (foundryPos - uStampSceneOrigin) / max(uStampSceneSize, vec2(1e-5)),
        0.0,
        1.0
      );
    }

    vec2 stampSceneUvForMask(vec2 screenUv) {
      if (uHasStampViewMapping < 0.5) return screenUv;
      return stampSceneUvFromFoundry(stampFoundryFromScreen(screenUv));
    }

    float offsetScaleLimit(float origin, float delta) {
      if (delta > 0.0) return (1.0 - origin) / delta;
      if (delta < 0.0) return (0.0 - origin) / delta;
      return 1e6;
    }

    void main() {
      vec2 screenUv = gl_FragCoord.xy / uResolution;
      vec2 sceneUv = stampSceneUvForMask(screenUv);
      float roofUvScale = max(uRoofUvScale, 0.0001);
      vec2 roofUv = (screenUv - 0.5) * roofUvScale + 0.5;
      float tileProjectionUvScale = max(uTileProjectionUvScale, 0.0001);
      vec2 tileProjectionUv = (screenUv - 0.5) * tileProjectionUvScale + 0.5;

      float sunLen = max(uSunDirLength, 0.0) * max(uShadowLengthScale, 0.0);
      vec2 screenDir = sunLen > 1e-6 ? normalize(vec2(uSunDir.x, -uSunDir.y)) : vec2(0.0);

      bool hasOutdoorsMask = (uHasOutdoorsMask > 0.5);
      float receiverOutdoors = hasOutdoorsMask ? readOutdoorsMask(sceneUv) : 1.0;
      float receiverIndoor = 1.0 - receiverOutdoors;
      float receiverIsOutdoors = step(0.5, receiverOutdoors);

      float receiverLengthScale = mix(
        max(uOutdoorShadowLengthScale, 0.0),
        max(uIndoorReceiverShadowLengthScale, 0.0),
        receiverIndoor
      );
      float pixelLen = uLength * 1080.0 * max(uZoom, 0.0001) * receiverLengthScale * sunLen;

      vec2 baseOffsetDeltaUv = screenDir * pixelLen * uTexelSize * roofUvScale;
      float baseOffsetScaleX = clamp(offsetScaleLimit(roofUv.x, baseOffsetDeltaUv.x), 0.0, 1.0);
      float baseOffsetScaleY = clamp(offsetScaleLimit(roofUv.y, baseOffsetDeltaUv.y), 0.0, 1.0);
      float baseOffsetScaleAvg = 0.5 * (baseOffsetScaleX + baseOffsetScaleY);
      float baseEdgeFade = mix(0.65, 1.0, smoothstep(0.0, 1.0, baseOffsetScaleAvg));
      vec2 offsetUv = roofUv + vec2(
        baseOffsetDeltaUv.x * baseOffsetScaleX,
        baseOffsetDeltaUv.y * baseOffsetScaleY
      );

      float roofCoverageAlpha = clamp(texture2D(tRoof, clamp(roofUv, 0.0, 1.0)).a, 0.0, 1.0);
      float roofVisibilityAlpha = roofCoverageAlpha;
      if (uHasRoofVisibility > 0.5) {
        roofVisibilityAlpha = clamp(texture2D(tRoofVisibility, clamp(screenUv, 0.0, 1.0)).a, 0.0, 1.0);
      }
      float roofBaseAlpha = roofVisibilityAlpha * (1.0 - clamp(uHoverRevealActive, 0.0, 1.0));

      bool tileProjectionEnabled = (uTileProjectionEnabled > 0.5 && uHasTileProjection > 0.5);
      // Tile projection length is independent of outdoor/indoor receiver length scales
      // (those gate roof stamp distance; tile casters carry their own length scale).
      float projectedPixelLen = uLength * 1080.0 * max(uZoom, 0.0001) * sunLen * max(uTileProjectionLengthScale, 0.0);
      vec2 projectedOffsetDeltaUv = screenDir * projectedPixelLen * uTexelSize * tileProjectionUvScale;
      float projectedOffsetScaleX = clamp(offsetScaleLimit(tileProjectionUv.x, projectedOffsetDeltaUv.x), 0.0, 1.0);
      float projectedOffsetScaleY = clamp(offsetScaleLimit(tileProjectionUv.y, projectedOffsetDeltaUv.y), 0.0, 1.0);
      float projectedOffsetScaleAvg = 0.5 * (projectedOffsetScaleX + projectedOffsetScaleY);
      float projectedEdgeFade = mix(0.65, 1.0, smoothstep(0.0, 1.0, projectedOffsetScaleAvg));
      vec2 projectedOffsetUv = tileProjectionUv + vec2(
        projectedOffsetDeltaUv.x * projectedOffsetScaleX,
        projectedOffsetDeltaUv.y * projectedOffsetScaleY
      );
      float tileBaseAlpha = 0.0;
      if (uHasTileProjectionRaw > 0.5) {
        tileBaseAlpha = clamp(texture2D(tTileProjectionRaw, clamp(tileProjectionUv, 0.0, 1.0)).a, 0.0, 1.0);
      } else {
        tileBaseAlpha = clamp(texture2D(tTileProjection, clamp(tileProjectionUv, 0.0, 1.0)).a, 0.0, 1.0);
      }

      float depthTileProjectionMod = 1.0;
      if (uDepthEnabled > 0.5 && tileProjectionEnabled && sunLen > 1e-6) {
        float receiverDevice = texture2D(uDepthTexture, screenUv).r;
        if (receiverDevice < 0.9999) {
          float receiverLinear = msa_linearizeDepth(receiverDevice);
          float receiverHeight = uGroundDistance - receiverLinear;
          vec2 tileCasterUv = screenUv + screenDir * projectedPixelLen * uTexelSize * min(projectedOffsetScaleX, projectedOffsetScaleY);
          float tileCasterDevice = texture2D(uDepthTexture, tileCasterUv).r;
          if (tileCasterDevice < 0.9999) {
            float tileCasterLinear = msa_linearizeDepth(tileCasterDevice);
            float tileCasterHeight = uGroundDistance - tileCasterLinear;
            float tileHeightDiff = tileCasterHeight - receiverHeight;
            depthTileProjectionMod = smoothstep(-2.0, -0.1, tileHeightDiff);
          }
        }
      }

      vec2 maskTexelSize = vec2(1.0) / max(uStampSceneSize, vec2(1.0));
      float maskOffsetPx = uLength * 1080.0 * receiverLengthScale * sunLen;
      vec2 foundryReceiver = stampFoundryFromScreen(screenUv);
      vec2 foundryCaster = foundryReceiver + vec2(uSunDir.x, -uSunDir.y) * maskOffsetPx;
      vec2 maskOffsetUvBase = stampSceneUvFromFoundry(foundryCaster);

      float sUvValid = uvInBounds(offsetUv, uTexelSize * 0.05);
      float roofTap = clamp(texture2D(tRoofStamp, clamp(offsetUv, 0.0, 1.0)).a, 0.0, 1.0) * sUvValid;
      float roofProjectedOnlyTap = max(roofTap - roofBaseAlpha, 0.0);
      float roofStrengthTap = clamp(roofProjectedOnlyTap * uOpacity, 0.0, 1.0) * baseEdgeFade;

      if (hasOutdoorsMask) {
        float sameRegionTap = 0.0;
        if (uvInBounds(maskOffsetUvBase, maskTexelSize) > 0.5) {
          float casterOutdoorsBase = readOutdoorsMask(maskOffsetUvBase);
          float casterIsOutdoors = step(0.5, casterOutdoorsBase);
          sameRegionTap = receiverIsOutdoors * casterIsOutdoors + (1.0 - receiverIsOutdoors) * (1.0 - casterIsOutdoors);
        }
        float roofRegionTap = (receiverIsOutdoors > 0.5) ? 1.0 : sameRegionTap;
        roofStrengthTap *= roofRegionTap;
      }

      float combinedStrength = roofStrengthTap;

      float tileProjectedStrength = 0.0;
      if (tileProjectionEnabled && sunLen > 1e-6) {
        float pUvValid = uvInBounds(projectedOffsetUv, uTexelSize * 0.05);
        float tileAlphaTap = clamp(texture2D(tTileProjection, clamp(projectedOffsetUv, 0.0, 1.0)).a, 0.0, 1.0) * pUvValid;
        float tileProjectedOnlyTap = max(tileAlphaTap - tileBaseAlpha, 0.0);
        float thresholdDenom = max(1.0 - uTileProjectionThreshold, 0.0001);
        float tileMaskedTap = pow(
          clamp((tileProjectedOnlyTap - uTileProjectionThreshold) / thresholdDenom, 0.0, 1.0),
          max(uTileProjectionPower, 0.0001)
        );
        float sortGate = 1.0;
        bool hasTileSortOcclusion = (uHasTileProjectionSort > 0.5 && uHasTileReceiverSort > 0.5);
        if (hasTileSortOcclusion && tileAlphaTap > 0.0001) {
          float receiverTileSortNorm = clamp(texture2D(tTileReceiverSort, screenUv).r, 0.0, 1.0);
          float casterTileSortNorm = clamp(texture2D(tTileProjectionSort, clamp(projectedOffsetUv, 0.0, 1.0)).r, 0.0, 1.0);
          float requiredCasterSort = receiverTileSortNorm + max(uTileProjectionSortBias, 0.0);
          sortGate = step(requiredCasterSort, casterTileSortNorm);
        }
        float projectionReceiverScale = mix(
          max(uTileProjectionOutdoorOpacityScale, 0.0),
          max(uTileProjectionIndoorOpacityScale, 0.0),
          receiverIndoor
        );
        tileProjectedStrength = clamp(tileMaskedTap * uTileProjectionOpacity * projectionReceiverScale * sortGate, 0.0, 1.0);
        tileProjectedStrength *= projectedEdgeFade * depthTileProjectionMod;
      }

      float roofCombinedStrength = combinedStrength;
      float tileOnlyStrength = tileProjectedStrength;

      if ((uHasDynamicLight > 0.5 || uHasWindowLight > 0.5) && uDynamicLightShadowOverrideEnabled > 0.5) {
        vec2 clampedUv = clamp(screenUv, vec2(0.0), vec2(1.0));
        float dynI = 0.0;
        if (uHasDynamicLight > 0.5) {
          vec3 dyn = texture2D(tDynamicLight, clampedUv).rgb;
          dynI = max(dynI, clamp(max(dyn.r, max(dyn.g, dyn.b)), 0.0, 1.0));
        }
        if (uHasWindowLight > 0.5) {
          vec3 win = texture2D(tWindowLight, clampedUv).rgb;
          dynI = max(dynI, clamp(max(win.r, max(win.g, win.b)), 0.0, 1.0));
        }
        float dynLift = clamp(smoothstep(0.02, 0.30, dynI) * max(uDynamicLightShadowOverrideStrength, 0.0), 0.0, 1.0);
        roofCombinedStrength = mix(roofCombinedStrength, 0.0, dynLift);
        tileOnlyStrength = mix(tileOnlyStrength, 0.0, dynLift);
      }

      float fluidBlurAlpha = 0.0;
      vec3 fluidBlurColor = vec3(0.0);
      if (uFluidColorEnabled > 0.5 && uHasFluidRoof > 0.5) {
        vec4 fluidTap = texture2D(tFluidRoof, clamp(offsetUv, 0.0, 1.0));
        float sameRegionFluidTap = 1.0;
        if (hasOutdoorsMask && uvInBounds(maskOffsetUvBase, maskTexelSize) > 0.5) {
          float casterIsOutdoorsFluid = step(0.5, readOutdoorsMask(maskOffsetUvBase));
          sameRegionFluidTap = 1.0 - abs(casterIsOutdoorsFluid - receiverIsOutdoors);
          if (receiverIsOutdoors > 0.5) sameRegionFluidTap = 1.0;
        }
        fluidBlurAlpha = clamp(fluidTap.a, 0.0, 1.0) * sameRegionFluidTap * sUvValid * baseEdgeFade;
        fluidBlurColor = (fluidTap.a > 0.0001) ? clamp(fluidTap.rgb / fluidTap.a, 0.0, 1.0) : vec3(0.0);
      }

      float shadowFactor = 1.0 - roofCombinedStrength;
      float tileShadowFactor = 1.0 - tileOnlyStrength;
      vec3 shadowRgb = vec3(shadowFactor);

      if (uFluidColorEnabled > 0.5 && uHasFluidRoof > 0.5 && fluidBlurAlpha > 0.0001) {
        float fluidLuma = dot(fluidBlurColor, vec3(0.2126, 0.7152, 0.0722));
        float fluidSaturation = mix(max(uFluidColorSaturation, 0.0), max(uIndoorFluidColorSaturation, 0.0), receiverIndoor);
        fluidBlurColor = mix(vec3(fluidLuma), fluidBlurColor, fluidSaturation);
        fluidBlurColor = clamp(fluidBlurColor * max(uFluidColorBoost, 0.0), 0.0, 1.0);
        float fluidIntensityBoost = mix(max(uFluidShadowIntensityBoost, 0.0), max(uIndoorFluidShadowIntensityBoost, 0.0), receiverIndoor);
        float tintedStrength = clamp(combinedStrength * fluidIntensityBoost, 0.0, 1.0);
        float fluidTintMix = clamp(fluidBlurAlpha * uFluidEffectTransparency * fluidIntensityBoost, 0.0, 1.0);
        vec3 tintedShadow = 1.0 - tintedStrength * (1.0 - fluidBlurColor);
        shadowRgb = mix(shadowRgb, tintedShadow, fluidTintMix);
      }

      if (uDebugView > 0.5) {
        float d = 0.0;
        if (uDebugView < 1.5) d = receiverOutdoors;
        else if (uDebugView < 2.5) d = roofCoverageAlpha;
        else if (uDebugView < 3.5) d = roofVisibilityAlpha;
        else if (uDebugView < 4.5) d = roofBaseAlpha;
        else if (uDebugView < 5.5) d = roofCombinedStrength;
        else d = tileOnlyStrength;
        gl_FragColor = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0);
        return;
      }

      gl_FragColor = vec4(shadowRgb, tileShadowFactor);
    }
  `;
}

/**
 * @param {typeof import('three')} THREE
 * @param {object} params
 * @returns {import('three').ShaderMaterial}
 */
export function createOverheadStampCompositeMaterial(THREE, params) {
  return new THREE.ShaderMaterial({
    uniforms: {
      tRoof: { value: null },
      tRoofStamp: { value: null },
      tRoofVisibility: { value: null },
      uHasRoofVisibility: { value: 0.0 },
      uOpacity: { value: params.opacity },
      uLength: { value: params.length },
      uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
      uRoofUvScale: { value: 1.0 },
      uTileProjectionUvScale: { value: 1.0 },
      uSunDir: { value: new THREE.Vector2(0.0, 1.0) },
      uSunDirLength: { value: 1.0 },
      uShadowLengthScale: { value: 1.0 },
      uResolution: { value: new THREE.Vector2(1024, 1024) },
      uZoom: { value: 1.0 },
      uHoverRevealActive: { value: 0.0 },
      uOutdoorShadowLengthScale: { value: params.outdoorShadowLengthScale ?? 1.0 },
      uIndoorReceiverShadowLengthScale: { value: params.indoorReceiverShadowLengthScale ?? 1.0 },
      uOutdoorsMask: { value: null },
      uHasOutdoorsMask: { value: 0.0 },
      uOutdoorsMaskFlipY: { value: 0.0 },
      uFluidColorEnabled: { value: 0.0 },
      uFluidEffectTransparency: { value: 0.35 },
      uFluidShadowIntensityBoost: { value: 1.0 },
      uFluidColorBoost: { value: 1.5 },
      uFluidColorSaturation: { value: 1.2 },
      uIndoorFluidShadowIntensityBoost: { value: 1.0 },
      uIndoorFluidColorSaturation: { value: 1.2 },
      tFluidRoof: { value: null },
      uHasFluidRoof: { value: 0.0 },
      tTileProjection: { value: null },
      tTileProjectionRaw: { value: null },
      uHasTileProjectionRaw: { value: 0.0 },
      uHasTileProjection: { value: 0.0 },
      tTileProjectionSort: { value: null },
      uHasTileProjectionSort: { value: 0.0 },
      tTileReceiverAlpha: { value: null },
      tTileReceiverSort: { value: null },
      uHasTileReceiverSort: { value: 0.0 },
      uTileProjectionEnabled: { value: 0.0 },
      uTileProjectionOpacity: { value: 0.5 },
      uTileProjectionLengthScale: { value: 1.0 },
      uTileProjectionThreshold: { value: 0.05 },
      uTileProjectionPower: { value: 1.0 },
      uTileProjectionOutdoorOpacityScale: { value: 1.0 },
      uTileProjectionIndoorOpacityScale: { value: 1.0 },
      uTileProjectionSortBias: { value: 0.002 },
      uSceneDimensions: { value: new THREE.Vector2(1, 1) },
      uStampSceneOrigin: { value: new THREE.Vector2(0, 0) },
      uStampSceneSize: { value: new THREE.Vector2(1, 1) },
      uStampViewCorner00: { value: new THREE.Vector2(0, 0) },
      uStampViewCorner10: { value: new THREE.Vector2(1, 0) },
      uStampViewCorner01: { value: new THREE.Vector2(0, 1) },
      uStampViewCorner11: { value: new THREE.Vector2(1, 1) },
      uHasStampViewMapping: { value: 0.0 },
      uDepthTexture: { value: null },
      uDepthEnabled: { value: 0.0 },
      uDepthCameraNear: { value: 800.0 },
      uDepthCameraFar: { value: 1200.0 },
      uGroundDistance: { value: 1000.0 },
      uDebugView: { value: 0.0 },
      tDynamicLight: { value: null },
      tWindowLight: { value: null },
      uHasDynamicLight: { value: 0.0 },
      uHasWindowLight: { value: 0.0 },
      uDynamicLightShadowOverrideEnabled: { value: 1.0 },
      uDynamicLightShadowOverrideStrength: { value: params.dynamicLightShadowOverrideStrength ?? 0.7 },
    },
    vertexShader: getOverheadStampCompositeVertexShader(),
    fragmentShader: getOverheadStampCompositeFragmentShader(),
    transparent: false,
  });
}
