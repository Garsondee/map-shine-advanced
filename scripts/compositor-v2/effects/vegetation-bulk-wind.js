/**
 * @fileoverview Vegetation wind: rigid bulk sway (vertex), fine flutter (fragment UV only).
 * Bulk motion moves overlay geometry; large mask UV offsets are avoided to prevent alpha-edge splitting.
 * @module compositor-v2/effects/vegetation-bulk-wind
 */

/** Hash + noise + bulk offset — inject into vertex and fragment shaders. */
export const VEGETATION_WIND_NOISE_GLSL = `
        float vegetationHash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        float vegetationNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(vegetationHash(i + vec2(0.0, 0.0)), vegetationHash(i + vec2(1.0, 0.0)), u.x),
            mix(vegetationHash(i + vec2(0.0, 1.0)), vegetationHash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }
`;

/** Overlay uniforms: wind anchor + tile size for vertex displacement. */
export const VEGETATION_WIND_OVERLAY_UNIFORM_GLSL = `
        uniform vec2  uWindAnchorWorld;
        uniform float uWindClumpSeed;
        uniform vec2  uTileWorldSize;
`;

/** Bulk sway amplitudes (vertex displacement). */
export const VEGETATION_WIND_LAYER_UNIFORM_GLSL = `
        uniform float uBulkSway;
        uniform float uBulkSwayScale;
        uniform float uBulkSwaySpeed;
        uniform float uBulkSwaySpread;
`;

/** Baked clump attributes → fragment varyings (avoids per-pixel clump texture lookup). */
export const VEGETATION_CLUMP_WIND_VARYING_GLSL = `
        attribute vec2 aClumpAnchor;
        attribute float aClumpId;

        varying vec2 vClumpAnchor;
        varying float vClumpId;
        varying vec2 vBulkWindUv;
`;

/**
 * Scene-border fade for wind distortion — use per-vertex rest world position, not clump anchor.
 * Expects uSceneMin, uSceneMax, uEdgeFadeStart, uEdgeFadeEnd in scope.
 */
export const VEGETATION_SCENE_EDGE_FADE_GLSL = `
        vec2 vegetationSceneUvFromWorld(vec2 worldPos) {
          vec2 sceneSpan = max(uSceneMax - uSceneMin, vec2(1e-3));
          return clamp((worldPos - uSceneMin) / sceneSpan, 0.0, 1.0);
        }

        float vegetationSceneEdgeFade(vec2 worldPos) {
          vec2 sceneUv = vegetationSceneUvFromWorld(worldPos);
          float edgeDist = min(min(sceneUv.x, 1.0 - sceneUv.x), min(sceneUv.y, 1.0 - sceneUv.y));
          return smoothstep(0.0, max(uEdgeFadeStart + 1e-4, uEdgeFadeEnd), edgeDist);
        }
`;

/**
 * Unified bulk sway — one direction + one oscillator per clump island (vertex displacement).
 * Expects wind + scene-wind uniforms in scope.
 */
export const VEGETATION_BULK_WIND_OFFSET_GLSL = `
        float vegetationBulkSwayRate(float swaySpeed) {
          float s = clamp(swaySpeed, 0.2, 3.0);
          return mix(0.45, 1.65, (s - 0.2) / 2.8);
        }

        float vegetationBulkOscillationRate(float elasticity) {
          float e = clamp(elasticity, 0.5, 5.0);
          return mix(0.35, 1.25, (e - 0.5) / 4.5);
        }

        vec2 computeVegetationBulkWindOffset(vec2 anchorWorld, float clumpSeed, vec2 windDirIn) {
          vec2 windDir = normalize(windDirIn);
          if (length(windDir) < 0.01) windDir = vec2(1.0, 0.0);

          float rawWind = clamp(uWindSpeed, 0.0, 1.0);
          float speed = max(0.0, rawWind * uWindSpeedGlobal);
          float rustleFloor = max(0.0, uMinRustleSpeed * max(0.0, uRustleFloorScale));
          float rustleSpeed = max(speed, rustleFloor);
          float bendLo = min(uBendWindStart, uBendWindFull - 0.001);
          float bendHi = max(bendLo + 1e-4, uBendWindFull);
          float bendDrive = smoothstep(bendLo, bendHi, rawWind);
          float effectiveSpeed = uAmbientMotion + rustleSpeed;

          float clumpId = fract(clumpSeed + 1e-4);
          float idMix = vegetationHash(vec2(
            clumpId * 19.73 + anchorWorld.x * 0.0019,
            clumpId * 7.41 + anchorWorld.y * 0.0023
          ));
          float spread = clamp(uBulkSwaySpread, 0.08, 0.75);
          vec2 bulkDir = clumpWindDir(windDir, clumpId + idMix * 0.31, spread);
          vec2 perpDir = vec2(-bulkDir.y, bulkDir.x);
          float anchorPhase = dot(anchorWorld, vec2(0.00107, 0.00131)) * 6.2831853;
          float phaseSeed = clumpId * 6.2831853 + anchorPhase + idMix * 5.4977871;
          float clumpAmp = 0.68 + 0.42 * vegetationHash(vec2(
            clumpId * 2.31 + anchorWorld.x * 0.00083,
            clumpId * 5.83 + anchorWorld.y * 0.00071
          )) + 0.14 * idMix;

          float bulkWaveSpatial = max(0.00003, uWaveSpatialFrequency * 0.11);
          float waveCoord = dot(anchorWorld, bulkDir);
          float slowWave = sin(waveCoord * bulkWaveSpatial - uWavePhase * 0.14 + phaseSeed);
          float slowWaveFront = pow(clamp(0.5 + 0.5 * slowWave, 0.0, 1.0), max(0.35, uWaveSharpness * 0.55));
          float legacyWaveMod = mix(1.0, slowWaveFront, clamp(uWaveInfluence, 0.0, 1.0) * 0.72);

          float bulkSceneAlong = dot(anchorWorld, bulkDir);
          float bulkSceneCarrier = 0.5 + 0.5 * sin(
            bulkSceneAlong * max(0.00004, uSceneWindSpatialFreq * 0.14) - uSceneWindWavePhase * 0.12
          );
          float bulkScenePeak = pow(clamp(bulkSceneCarrier, 0.0, 1.0), max(0.35, uSceneWindSharpness * 0.6));
          float bulkSceneGap = clamp(uSceneWindGapRatio, 0.0, 0.95);
          float bulkSceneThreshold = 1.0 - bulkSceneGap;
          float bulkSceneSoftness = max(0.001, uSceneWindGapSoftness) * (0.35 + 0.65 * bulkSceneGap);
          float bulkSceneStrength = mix(
            clamp(uSceneWindStrengthFloor, 0.0, 0.95),
            1.0,
            smoothstep(bulkSceneThreshold, bulkSceneThreshold + bulkSceneSoftness, bulkScenePeak)
          );
          float sceneStrength = uSceneWindEnabled > 0.5 ? bulkSceneStrength : 1.0;

          float spatialInfluence = clamp(uWaveInfluence, 0.0, 1.0);
          float spatialBlend = spatialInfluence * smoothstep(0.16, 0.68, rawWind);
          float bendSpatialMod = uSceneWindEnabled > 0.5
            ? mix(1.0, sceneStrength, spatialBlend)
            : legacyWaveMod;

          float bulkOscRate = mix(
            vegetationBulkSwayRate(uBulkSwaySpeed),
            vegetationBulkOscillationRate(uElasticity),
            0.32
          );
          float clumpTimeScale = 0.52 + 0.78 * fract(clumpId * 2.618 + idMix * 1.31);
          float orbitPhase = uTime * bulkOscRate * clumpTimeScale + phaseSeed;
          float orbitSway = sin(orbitPhase);
          float orbitSwayB = sin(orbitPhase * 1.618 + phaseSeed * 0.41);

          float along = dot(anchorWorld, bulkDir);
          float rollSpatial = max(0.000018, uWaveSpatialFrequency * 0.038);
          float roll = sin(along * rollSpatial - uWavePhase * 0.07 + phaseSeed);

          float bendStrength = (uBendMinStrength + (1.0 - uBendMinStrength) * rawWind)
                             * mix(0.58, 1.0, bendDrive);
          float bendWave = uSceneWindEnabled > 0.5
            ? smoothstep(0.0, max(0.05, uBendRiseSoftness), bendSpatialMod)
            : bendSpatialMod;
          float bendEffectiveSpeed = uSceneWindEnabled > 0.5 ? rustleSpeed * bendWave : effectiveSpeed;
          float swayCoupling = uSceneWindEnabled > 0.5
            ? mix(0.86, sceneStrength, spatialBlend * 0.42)
            : (0.65 + 0.35 * bendSpatialMod);

          float hurricaneBoost = mix(1.0, 1.35, smoothstep(0.72, 0.98, rawWind));
          float bulkScale = min(max(0.0, uBulkSwayScale), 2.5);
          float bulkAmp = min(max(0.0, uBulkSway), 0.14) * bulkScale * clumpAmp * hurricaneBoost;
          float windDrive = max(0.42, bendEffectiveSpeed) * bendStrength * swayCoupling;
          float windGate = mix(0.72, 1.0, bendDrive);

          float gustEnvelope = 0.78 + 0.22 * sin(uWavePhase * 0.38 + phaseSeed * 0.17);
          float primaryMotion = (orbitSway * 0.8 + orbitSwayB * 0.2) * bulkAmp * windDrive * windGate;
          float rollMotion = roll * bulkAmp * 0.18 * windDrive * windGate;

          return (bulkDir * (primaryMotion * gustEnvelope + rollMotion * 0.35))
               + (perpDir * (rollMotion * 0.12 * gustEnvelope));
        }
`;

/**
 * Canopy flutter + billboard ground shadow (expects safeAlpha + mask sampler in scope).
 * Shadow = blurred offset of the distorted canopy silhouette (bulk vertex + flutter UV).
 */
export const VEGETATION_BILLBOARD_SHADOW_GLSL = `
        vec2 vegetationCanopyFlutterUvOffset(
          vec2 restWorldPos,
          float restTexA,
          vec2 clumpAnchor,
          float clumpId,
          vec2 windDir,
          float edgeFade
        ) {
          vec2 flutterUv = computeVegetationFlutterUvOffset(
            restWorldPos, clumpAnchor, clumpId, windDir
          );
          float foliageFlutterWeight = smoothstep(0.02, 0.38, restTexA);
          return capVegetationFlutterUvOffset(flutterUv) * edgeFade * foliageFlutterWeight;
        }

        float vegetationBillboardShadowTap(
          sampler2D mask,
          vec2 shadowFragmentUv,
          vec2 tapOffset,
          vec2 shadowOffset,
          vec2 tileWorldSize,
          vec2 shadowFragmentWorld,
          vec2 clumpAnchor,
          float clumpId,
          vec2 windDir,
          float edgeFade
        ) {
          vec2 tapShadowUv = shadowFragmentUv + tapOffset;
          vec2 tapWorld = shadowFragmentWorld + vec2(
            tapOffset.x * tileWorldSize.x,
            tapOffset.y * tileWorldSize.y
          );
          vec2 castRestUv = tapShadowUv - shadowOffset;
          vec2 castWorld = tapWorld - vec2(
            shadowOffset.x * tileWorldSize.x,
            shadowOffset.y * tileWorldSize.y
          );
          float castRestA = safeAlpha(texture2D(mask, castRestUv));
          vec2 flutterUv = vegetationCanopyFlutterUvOffset(
            castWorld, castRestA, clumpAnchor, clumpId, windDir, edgeFade
          );
          return safeAlpha(texture2D(mask, castRestUv + flutterUv));
        }
`;

/**
 * Rigid vertex bulk apply — scene edge fade only (no foliage-cover gradient).
 * Expects vegetationSceneEdgeFade in scope.
 */
export const VEGETATION_BULK_VERTEX_APPLY_GLSL = `
        vec2 applyVegetationBulkWindVertexDisplacement(vec2 bulkUv, vec2 restWorldPos) {
          float bulkWeight = vegetationSceneEdgeFade(restWorldPos);
          vec2 scaled = bulkUv * bulkWeight;
          float mag = length(scaled);
          const float bulkCap = 0.13;
          if (mag > bulkCap) {
            scaled *= bulkCap / mag;
          }
          return scaled;
        }
`;

/** Edge fade + rigid bulk apply — correct GLSL definition order for vertex shaders. */
export const VEGETATION_BULK_VERTEX_DISPLACEMENT_GLSL =
  VEGETATION_SCENE_EDGE_FADE_GLSL + VEGETATION_BULK_VERTEX_APPLY_GLSL;

/** Fragment edge fade for flutter weighting. */
export const VEGETATION_FLUTTER_FRAGMENT_GLSL =
  VEGETATION_SCENE_EDGE_FADE_GLSL
  + `
        vec2 capVegetationFlutterUvOffset(vec2 flutterUv) {
          float mag = length(flutterUv);
          const float flutterCap = 0.006;
          if (mag > flutterCap) {
            return flutterUv * (flutterCap / mag);
          }
          return flutterUv;
        }
`;

/** Tree-only turbulence added to bulk offset. */
export const VEGETATION_BULK_WIND_TURBULENCE_GLSL = `
        vec2 computeVegetationBulkTurbulenceUvOffset(vec2 anchorWorld, float clumpSeed, vec2 windDirIn, vec2 bulkSoFar) {
          float rawWind = clamp(uWindSpeed, 0.0, 1.0);
          float speed = max(0.0, rawWind * uWindSpeedGlobal);
          float rustleFloor = max(0.0, uMinRustleSpeed * max(0.0, uRustleFloorScale));
          float rustleSpeed = max(speed, rustleFloor);
          float bendLo = min(uBendWindStart, uBendWindFull - 0.001);
          float bendHi = max(bendLo + 1e-4, uBendWindFull);
          float bendDrive = smoothstep(bendLo, bendHi, rawWind);
          float ambientMotion = uAmbientMotion;
          float effectiveSpeed = ambientMotion + rustleSpeed;

          vec2 windDir = normalize(windDirIn);
          if (length(windDir) < 0.01) windDir = vec2(1.0, 0.0);

          float windFieldFrequency = mix(0.0003, max(0.0003, uGustFrequency), rawWind);
          float windField = vegetationNoise(anchorWorld * windFieldFrequency - windDir * uWindFieldPhase);
          float windPulse = mix(0.65, 1.28, smoothstep(0.08, 0.92, windField));
          windPulse *= (0.35 + 0.65 * rawWind);

          float clumpId = fract(clumpSeed + 1e-4);
          float spread = clamp(uBulkSwaySpread, 0.08, 0.75);
          vec2 bendBaseDir = clumpWindDir(windDir, clumpId, spread);

          float waveCoord = dot(anchorWorld, bendBaseDir);
          float wavePhase = waveCoord * uWaveSpatialFrequency - uWavePhase;
          float waveCarrier = 0.5 + 0.5 * sin(wavePhase);
          float waveFront = pow(clamp(waveCarrier, 0.0, 1.0), max(0.1, uWaveSharpness));
          float legacyWaveMod = mix(1.0, waveFront, clamp(uWaveInfluence, 0.0, 1.0));
          float sceneStrength = sceneWindStrength(anchorWorld, bendBaseDir);
          float spatialInfluence = clamp(uWaveInfluence, 0.0, 1.0);
          float spatialBlend = spatialInfluence * smoothstep(0.16, 0.68, rawWind);
          float bendSpatialMod = uSceneWindEnabled > 0.5
            ? mix(1.0, sceneStrength, spatialBlend)
            : legacyWaveMod;
          float bendWave = uSceneWindEnabled > 0.5
            ? smoothstep(0.0, max(0.05, uBendRiseSoftness), bendSpatialMod)
            : bendSpatialMod;
          float bendEffectiveSpeed = uSceneWindEnabled > 0.5 ? rustleSpeed * bendWave : effectiveSpeed;
          float turbulenceStrength = max(0.0, uTurbulence);
          float turbulenceScale = max(0.00001, uTurbulenceScale);
          float swirlNoise = vegetationNoise(anchorWorld * (turbulenceScale * 0.4) - (bendBaseDir * uTime * 0.15));
          float angleSpread = (swirlNoise - 0.5) * 1.2 * turbulenceStrength;
          float cosS = cos(angleSpread);
          float sinS = sin(angleSpread);
          vec2 localWindDir = vec2(
            bendBaseDir.x * cosS - bendBaseDir.y * sinS,
            bendBaseDir.x * sinS + bendBaseDir.y * cosS
          );
          vec2 localPerpDir = vec2(-localWindDir.y, localWindDir.x);

          vec2 turbulencePos = anchorWorld * turbulenceScale;
          float turbulenceFieldA = vegetationNoise(turbulencePos + vec2(uTime * 0.27, -uTime * 0.19));
          float turbulenceFieldB = vegetationNoise((turbulencePos * 1.9) - vec2(uTime * 0.61, uTime * 0.47));
          float turbulenceSigned = ((turbulenceFieldA * 0.65 + turbulenceFieldB * 0.35) - 0.5) * 2.0;
          float turbulenceGustCoupling = 0.45 + 0.55 * windPulse;
          float turbWaveCoupling = uSceneWindEnabled > 0.5 ? bendSpatialMod : (0.55 + 0.45 * bendSpatialMod);
          float turbulenceHighWindDamp = mix(1.0, 0.48, smoothstep(0.7, 0.98, rawWind));
          float turbulenceMagnitude = turbulenceStrength * bendEffectiveSpeed * turbulenceGustCoupling
                                    * turbWaveCoupling * turbulenceHighWindDamp;
          return (localWindDir * (turbulenceSigned * uBulkSway * 0.85 * turbulenceMagnitude))
               + (localPerpDir * (((turbulenceFieldB - 0.5) * 2.0) * uBulkSway * 0.15 * turbulenceMagnitude));
        }
`;

/** Small per-pixel flutter — safe UV wobble only (bulk bend lives in vertex displacement). */
export const VEGETATION_FLUTTER_UV_GLSL = `
        vec2 computeVegetationFlutterUvOffset(vec2 worldPos, vec2 clumpAnchor, float clumpSeed, vec2 windDirIn) {
          if (uFlutterIntensity < 1e-6) return vec2(0.0);

          vec2 windDir = normalize(windDirIn);
          if (length(windDir) < 0.01) windDir = vec2(1.0, 0.0);

          float rawWind = clamp(uWindSpeed, 0.0, 1.0);
          float speed = max(0.0, rawWind * uWindSpeedGlobal);
          float rustleFloor = max(0.0, uMinRustleSpeed * max(0.0, uRustleFloorScale));
          float rustleSpeed = max(speed, rustleFloor);
          float flutterDrive = uFlutterBaseDrive + (1.0 - uFlutterBaseDrive)
                            * smoothstep(uFlutterWindStart, max(uFlutterWindStart + 1e-4, uFlutterWindFull), rawWind);
          float bendLo = min(uBendWindStart, uBendWindFull - 0.001);
          float bendHi = max(bendLo + 1e-4, uBendWindFull);
          float bendDrive = smoothstep(bendLo, bendHi, rawWind);

          float windFieldFrequency = mix(0.0003, max(0.0003, uGustFrequency), rawWind);
          float windField = vegetationNoise(worldPos * windFieldFrequency - windDir * uWindFieldPhase);
          float windPulse = mix(0.65, 1.28, smoothstep(0.08, 0.92, windField));
          windPulse *= (0.35 + 0.65 * rawWind);

          float clumpId = fract(clumpSeed + 1e-4);
          float spread = clamp(uBulkSwaySpread, 0.08, 0.75) * 0.35;
          vec2 bendWindDir = clumpWindDir(windDir, clumpId, spread);
          vec2 perpDir = vec2(-bendWindDir.y, bendWindDir.x);

          float flutterCoupling = uSceneWindEnabled > 0.5
            ? max(0.38, 0.42 + 0.58 * flutterDrive)
            : 0.75;

          float flutterScale = max(0.00001, uFlutterScale);
          vec2 leafPos = worldPos;
          float noiseA = vegetationNoise(leafPos * flutterScale);
          float noiseB = vegetationNoise(leafPos * flutterScale * 2.85 + vec2(clumpId * 5.17, clumpId * 11.3));
          float noiseC = vegetationNoise(leafPos * flutterScale * 6.4 + clumpAnchor * 0.0013);
          float phaseSeed = clumpId * 6.2831853 * 1.35;
          float flutterPhase = uFlutterPhase + noiseA * 6.2831853 + noiseB * 4.18879 + phaseSeed;
          float flutterFast = sin(flutterPhase * 1.93 + uTime * max(uFlutterSpeed, 0.08) * 1.15 + noiseC * 2.4);
          float flutterSlow = sin(flutterPhase * 0.71 + noiseB * 1.7);
          float flutter = flutterSlow * 0.58 + flutterFast * 0.42;

          float lowWindBoost = mix(uFlutterLowWindBoost, 1.0, smoothstep(0.04, max(0.041, uFlutterLowWindFadeEnd), rawWind));
          float legacyFlutterFloor = clamp(uFlutterGustFloor, 0.0, 1.0);
          float flutterWindPulse = mix(legacyFlutterFloor, 1.0, clamp(windPulse, 0.0, 1.0));
          float calmFlutterBoost = (1.0 + 1.15 * (1.0 - bendDrive))
                                   * mix(1.0, 0.52, smoothstep(0.45, 0.82, rawWind));
          float highWindFlutterDamp = mix(1.0, 0.44, smoothstep(0.55, 0.96, rawWind));
          float leafMod = 0.48 + 0.52 * vegetationNoise(leafPos * flutterScale * 4.6 + vec2(phaseSeed * 0.17));
          float flutterAmp = uFlutterIntensity * 12.0;
          float flutterMagnitude = flutter * flutterAmp * leafMod * flutterWindPulse * lowWindBoost
                                 * max(0.22, flutterDrive) * flutterCoupling * calmFlutterBoost
                                 * highWindFlutterDamp;
          return (bendWindDir * flutterMagnitude) + (perpDir * (flutterMagnitude * 0.14));
        }
`;

/** Keep UV distortion from crossing into a neighbor island (prevents edge shredding). */
export const VEGETATION_WIND_ISLAND_CLAMP_GLSL = `
        vec2 clampVegetationWindDistortionToIsland(vec2 restUv, vec2 worldPos, vec2 distortion) {
          if (length(distortion) < 1e-7) return distortion;
          vec3 restClump = sampleClumpField(restUv, worldPos);
          float restId = clumpId01(restClump.z);
          if (restId < 1e-4) return distortion;

          float t = 1.0;
          for (int i = 0; i < 5; i++) {
            vec3 probe = sampleClumpField(restUv - distortion * t, worldPos);
            if (abs(clumpId01(probe.z) - restId) < 0.02) break;
            t *= 0.62;
          }
          return distortion * t;
        }
`;

/**
 * @param {typeof import('three')} THREE
 * @param {number} tileW
 * @param {number} tileH
 * @param {number} centerX
 * @param {number} centerY
 * @returns {Record<string, { value: unknown }>}
 */
/** @param {number} ax @param {number} ay @param {number} [explicitSeed] */
export function vegetationOverlayWindSeed(ax, ay, explicitSeed = 0) {
  const base = Number(explicitSeed) || 0;
  if (base > 1e-6) return base;
  const h = Math.sin(ax * 12.9898 + ay * 78.233) * 43758.5453;
  return (h - Math.floor(h)) * 6.2831853;
}

export function createVegetationWindOverlayUniforms(THREE, tileW, tileH, centerX, centerY) {
  const seed = vegetationOverlayWindSeed(centerX, centerY);
  return {
    uWindAnchorWorld: { value: THREE ? new THREE.Vector2(centerX, centerY) : { x: centerX, y: centerY } },
    uWindClumpSeed: { value: seed },
    uTileWorldSize: { value: THREE ? new THREE.Vector2(tileW, tileH) : { x: tileW, y: tileH } },
  };
}

/**
 * @param {{ material?: object, shadowMaterial?: object }} entry
 * @param {{ wx: number, wy: number, seed: number }|null|undefined} anchor
 * @param {number} centerX
 * @param {number} centerY
 */
export function applyVegetationWindAnchorToOverlay(entry, anchor, centerX, centerY) {
  const ax = Number(anchor?.wx ?? centerX) || 0;
  const ay = Number(anchor?.wy ?? centerY) || 0;
  const seed = vegetationOverlayWindSeed(ax, ay, Number(anchor?.seed) || 0);
  for (const mat of [entry?.material, entry?.shadowMaterial]) {
    const u = mat?.uniforms;
    if (!u) continue;
    if (u.uWindAnchorWorld?.value) {
      if (typeof u.uWindAnchorWorld.value.set === 'function') {
        u.uWindAnchorWorld.value.set(ax, ay);
      } else {
        u.uWindAnchorWorld.value.x = ax;
        u.uWindAnchorWorld.value.y = ay;
      }
    }
    if (u.uWindClumpSeed) u.uWindClumpSeed.value = seed;
  }
}
