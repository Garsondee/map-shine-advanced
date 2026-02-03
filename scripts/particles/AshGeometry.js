/**
 * @fileoverview Instanced geometry for ash precipitation particles.
 * Based on SnowGeometry.js but tuned for volcanic/fire ash:
 * - Slower, heavier fall than snow
 * - Grey/charcoal coloring
 * - Less flutter, more direct descent
 * - Respects roof masking (_Outdoors)
 * @module particles/AshGeometry
 */

import { weatherController } from '../core/WeatherController.js';

export class AshGeometry {
  constructor(capacity = 6000) {
    this.capacity = capacity;
    this.geometry = null;
    this.material = null;
    this.mesh = null;
    this._spawnDensity = 0;
  }

  /**
   * Initialize instanced ash particle geometry and material.
   * @param {typeof THREE} THREE
   */
  initialize(THREE) {
    const baseGeometry = new THREE.PlaneGeometry(1, 1);

    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = baseGeometry.index;
    this.geometry.attributes.position = baseGeometry.attributes.position;
    this.geometry.attributes.uv = baseGeometry.attributes.uv;

    const indices = new Float32Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) indices[i] = i;
    this.geometry.setAttribute('instanceIndex', new THREE.InstancedBufferAttribute(indices, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDeltaTime: { value: 0.016 },
        uWindVector: { value: new THREE.Vector3(0, 0, 0) },
        uWindInfluence: { value: 1.0 },
        // Ash appearance tuning
        uColorStart: { value: new THREE.Color(0.45, 0.42, 0.38) },
        uColorEnd: { value: new THREE.Color(0.35, 0.32, 0.28) },
        uOpacityStartMin: { value: 0.75 },
        uOpacityStartMax: { value: 0.5 },
        uOpacityEnd: { value: 0.0 },
        uBrightness: { value: 1.0 },
        // Ash size tuning (world units scaled in shader)
        uScaleMin: { value: 0.06 },
        uScaleMax: { value: 0.10 },
        // Life and fall speed tuning
        uLifeMin: { value: 6.0 },
        uLifeMax: { value: 11.0 },
        uFallSpeedMin: { value: 180.0 },
        uFallSpeedMax: { value: 280.0 },
        uSceneBounds: { value: new THREE.Vector4(0, 0, 10000, 10000) },
        uSceneDarkness: { value: 0.0 },
        uRoofMap: { value: null },
        uRoofMaskEnabled: { value: 0.0 },
        uSpawnDensity: { value: 0.0 }
      },
      vertexShader: `
        uniform float uTime;
        uniform vec3 uWindVector;
        uniform float uWindInfluence;
        uniform float uScaleMin;
        uniform float uScaleMax;
        uniform float uLifeMin;
        uniform float uLifeMax;
        uniform float uFallSpeedMin;
        uniform float uFallSpeedMax;
        uniform vec4 uSceneBounds;
        uniform float uSpawnDensity;
        uniform sampler2D uRoofMap;
        uniform float uRoofMaskEnabled;

        attribute float instanceIndex;

        varying float vAlpha;
        varying float vPhase;
        varying float vLife;
        varying vec2 vUv;

        float hash(float n) {
          return fract(sin(n) * 43758.5453123);
        }

        // Gentle drift field for ash - less energetic than snow
        vec2 getAshDrift(float t, float windStrength) {
          float amp = windStrength * 15.0;
          vec2 pos = vec2(0.0);
          // Very slow large drift
          pos.x += sin(t * 0.15) * 10.0;
          pos.y += cos(t * 0.12) * 10.0;
          // Subtle medium swirls
          pos.x += sin(t * 0.6) * 4.0;
          pos.y += cos(t * 0.5) * 4.0;
          return pos * amp;
        }

        void main() {
          float idx = instanceIndex;
          float rnd = hash(idx);

          // Ash falls slower than snow, longer life cycle
          float lifeMin = max(0.1, uLifeMin);
          float lifeMax = max(lifeMin, uLifeMax);
          float cycleDuration = mix(lifeMin, lifeMax, rnd);
          float timeOffset = rnd * 123.0;
          float localTime = mod(uTime + timeOffset, cycleDuration);
          float life = localTime / cycleDuration;

          // Per-instance enable based on spawn density
          float density = clamp(uSpawnDensity, 0.0, 1.0);
          float spawnMask = step(hash(idx + 17.0), density) * step(0.0001, density);

          float areaW = uSceneBounds.z;
          float areaH = uSceneBounds.w;
          float centerX = uSceneBounds.x + areaW * 0.5;
          float centerY = uSceneBounds.y + areaH * 0.5;

          float spreadX = (hash(idx + 1.0) - 0.5) * areaW;
          float spreadY = (hash(idx + 2.0) - 0.5) * areaH;

          // Ash spawns at similar heights to snow
          float spawnZ = 4000.0 + hash(idx + 5.0) * 3500.0;

          vec3 startPos = vec3(centerX + spreadX, centerY + spreadY, spawnZ);

          // Ash is heavier than snow - less wind response
          float rawWind = length(uWindVector.xy) / 1000.0;
          float windStrength = pow(clamp(rawWind * uWindInfluence, 0.0, 1.0), 3.0); // More resistance

          // Slower base fall speed than snow (ash is denser but still light)
          float fallMin = max(0.0, uFallSpeedMin);
          float fallMax = max(fallMin, uFallSpeedMax);
          float baseFall = mix(fallMin, fallMax, hash(idx + 3.0));
          baseFall *= mix(1.0, 1.3, windStrength); // Less wind acceleration
          float vz = -baseFall;
          float zOffset = vz * localTime;

          // Wind drift - ash is less responsive than snow
          vec2 baseWindDir = vec2(0.0);
          if (length(uWindVector.xy) > 0.001) {
            baseWindDir = normalize(uWindVector.xy);
          }
          
          float driftSpeed = mix(0.0, 600.0, windStrength); // Less drift than snow
          vec2 windXY = baseWindDir * driftSpeed;

          // Flutter - ash has minimal flutter, mostly direct descent
          float flutterFreq = 0.3 + hash(idx + 7.0) * 0.4;
          float flutterAmp = 15.0 + 15.0 * hash(idx + 11.0);
          flutterAmp *= mix(1.0, 0.5, windStrength);
          
          float flutterPhaseOffset = hash(idx + 19.0) * 6.2831853;
          float phase = uTime * flutterFreq + rnd * 6.2831853 + flutterPhaseOffset;
          vec2 flutter = vec2(cos(phase), sin(phase * 0.5)) * flutterAmp;

          // Drag response - ash has higher drag coefficient (settles faster)
          float dragCoeff = 3.0;
          float windResponse = localTime - (1.0 - exp(-dragCoeff * localTime)) / dragCoeff;

          // Gentle drift field
          float spawnTime = uTime - localTime;
          float driftPhase = hash(idx + 33.0) * 6.2831853;
          vec2 driftNow = getAshDrift(uTime + driftPhase, windStrength);
          vec2 driftSpawn = getAshDrift(spawnTime + driftPhase, windStrength);
          vec2 driftOffset = driftNow - driftSpawn;

          vec2 lateralOffset = windXY * windResponse + driftOffset + flutter;
          vec3 currentPos = startPos + vec3(lateralOffset, zOffset);

          // Clip below ground
          if (currentPos.z < 0.0) {
            currentPos.z = -10000.0;
          }

          // Bounds-based alpha
          float alpha = 1.0;
          if (currentPos.x < uSceneBounds.x || currentPos.x > uSceneBounds.x + uSceneBounds.z ||
              currentPos.y < uSceneBounds.y || currentPos.y > uSceneBounds.y + uSceneBounds.w) {
            alpha = 0.0;
          }

          // Roof mask: prevent ash indoors
          if (uRoofMaskEnabled > 0.5) {
            float u = (currentPos.x - uSceneBounds.x) / uSceneBounds.z;
            float v = (currentPos.y - uSceneBounds.y) / uSceneBounds.w;
            v = 1.0 - v;
            vec2 roofUv = clamp(vec2(u, v), 0.0, 1.0);
            float roofCover = texture2D(uRoofMap, roofUv).r;
            float isOutdoor = step(0.5, roofCover);
            alpha *= isOutdoor;
          }

          // Fade in/out over life
          alpha *= smoothstep(0.0, 0.1, life);
          alpha *= smoothstep(1.0, 0.85, life);
          alpha *= spawnMask;

          vAlpha = alpha;
          vPhase = rnd;
          vLife = life;
          vUv = uv;

          // Billboard with slow tumble
          vec3 worldPos = currentPos;
          vec3 camRight = vec3(1.0, 0.0, 0.0);
          vec3 camUp = vec3(0.0, 1.0, 0.0);

          vec3 localPos = position;

          // Ash tumbles slowly - less chaotic than snow
          float baseSpin = 0.8 + hash(idx + 41.0) * 1.2;
          float windSpinScale = mix(0.3, 2.0, windStrength);
          float tumbleAngle = (uTime + timeOffset) * baseSpin * windSpinScale;

          float s = sin(tumbleAngle);
          float c = cos(tumbleAngle);

          vec2 rotatedLocal;
          rotatedLocal.x = localPos.x * c - localPos.y * s;
          rotatedLocal.y = localPos.x * s + localPos.y * c;

          float scaleNow = mix(uScaleMin, uScaleMax, rnd);
          vec3 offset = camRight * (rotatedLocal.x * scaleNow * 45.0) +
                        camUp * (rotatedLocal.y * scaleNow * 45.0);

          worldPos += offset;

          vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColorStart;
        uniform vec3 uColorEnd;
        uniform float uOpacityStartMin;
        uniform float uOpacityStartMax;
        uniform float uOpacityEnd;
        uniform float uBrightness;
        uniform float uSceneDarkness;
        uniform float uTime;

        varying float vAlpha;
        varying float vPhase;
        varying float vLife;
        varying vec2 vUv;

        void main() {
          float opacityStart = mix(uOpacityStartMin, uOpacityStartMax, vPhase);
          float alpha = mix(opacityStart, uOpacityEnd, vLife) * vAlpha;
          if (alpha <= 0.01) discard;

          // Ash is darker in bright scenes, slightly lighter at night
          float darkness = clamp(uSceneDarkness, 0.0, 1.0);
          float baseBrightness = mix(0.8, 1.2, darkness) * uBrightness;

          // Procedural ash flake shape - irregular, slightly jagged
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);

          // Soft irregular disc
          float core = smoothstep(1.0, 0.3, r);

          // Edge region for noise
          float edge = smoothstep(0.2, 0.85, r);

          // Angular noise for irregular edges
          float angle = atan(p.y, p.x);
          float edgeNoise = 0.6 + 0.4 * sin(vPhase * 11.0 + angle * 5.0);

          float edgeJitter = mix(1.0, edgeNoise, edge);
          float flakeMask = core * edgeJitter;

          // Subtle shimmer (less than snow)
          float shimmer = 0.85 + 0.15 * sin(uTime * 0.8 + vPhase * 8.0);

          alpha *= flakeMask * shimmer;
          if (alpha <= 0.01) discard;

          vec3 baseColor = mix(uColorStart, uColorEnd, vLife) * baseBrightness;
          gl_FragColor = vec4(baseColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.position.z = 32.0;
  }

  /**
   * Update uniforms per frame
   * @param {Object} timeInfo
   * @param {Object} weatherState
   * @param {Object} bounds
   * @param {number} ashIntensity - 0..1 intensity for ash precipitation
   */
  update(timeInfo, weatherState, bounds, ashIntensity = 0) {
    if (!this.material) return;

    const u = this.material.uniforms;
    u.uTime.value = timeInfo.elapsed;
    u.uDeltaTime.value = timeInfo.delta;

    if (weatherState && weatherState.windDirection) {
      const windSpeed = weatherState.windSpeed || 0;
      // Ash responds less to wind than snow
      const speed = windSpeed * 800.0;
      u.uWindVector.value.set(
        weatherState.windDirection.x * speed,
        weatherState.windDirection.y * speed,
        0
      );
    }

    const ashTuning = weatherController?.ashTuning || {};

    // Use ashIntensity parameter directly (controlled by WeatherController)
    const intensityScale = ashTuning.intensityScale ?? 1.0;
    const clampedIntensity = Math.max(0, Math.min(1, ashIntensity * intensityScale));
    const targetDensity = Math.pow(clampedIntensity, 0.7);
    
    if (u.uSpawnDensity) {
      const delta = Math.max(0.0, Math.min(1.0, timeInfo.delta || 0));
      const k = 2.5; // Slightly slower transition than snow
      const lerp = 1.0 - Math.exp(-k * delta);
      this._spawnDensity += (targetDensity - this._spawnDensity) * lerp;
      if (targetDensity <= 0.0001) {
        this._spawnDensity = 0.0;
      }
      u.uSpawnDensity.value = this._spawnDensity;
    }

    // Apply artistic tuning for appearance and motion.
    if (u.uWindInfluence) u.uWindInfluence.value = ashTuning.windInfluence ?? 1.0;

    if (u.uLifeMin) u.uLifeMin.value = ashTuning.lifeMin ?? 6.0;
    if (u.uLifeMax) u.uLifeMax.value = ashTuning.lifeMax ?? 11.0;
    if (u.uFallSpeedMin) u.uFallSpeedMin.value = ashTuning.speedMin ?? 180.0;
    if (u.uFallSpeedMax) u.uFallSpeedMax.value = ashTuning.speedMax ?? 280.0;

    if (u.uScaleMin) u.uScaleMin.value = (ashTuning.sizeMin ?? 10) / 45.0;
    if (u.uScaleMax) u.uScaleMax.value = (ashTuning.sizeMax ?? 16) / 45.0;

    if (u.uOpacityStartMin) u.uOpacityStartMin.value = ashTuning.opacityStartMin ?? 0.75;
    if (u.uOpacityStartMax) u.uOpacityStartMax.value = ashTuning.opacityStartMax ?? 0.5;
    if (u.uOpacityEnd) u.uOpacityEnd.value = ashTuning.opacityEnd ?? 0.0;
    if (u.uBrightness) u.uBrightness.value = ashTuning.brightness ?? 1.0;

    if (u.uColorStart && ashTuning.colorStart) {
      u.uColorStart.value.set(ashTuning.colorStart.r, ashTuning.colorStart.g, ashTuning.colorStart.b);
    }
    if (u.uColorEnd && ashTuning.colorEnd) {
      u.uColorEnd.value.set(ashTuning.colorEnd.r, ashTuning.colorEnd.g, ashTuning.colorEnd.b);
    }

    // Scene darkness for color adjustment
    try {
      const le = window.MapShine?.lightingEffect;
      if (le && typeof le.getEffectiveDarkness === 'function') {
        u.uSceneDarkness.value = le.getEffectiveDarkness();
      } else if (typeof canvas !== 'undefined' && canvas?.scene?.environment?.darknessLevel !== undefined) {
        u.uSceneDarkness.value = canvas.scene.environment.darknessLevel;
      }
    } catch (e) {
      // Ignore errors
    }

    // Roof / outdoors mask: cull ash under covered/indoor regions
    if (weatherController && weatherController.roofMap) {
      u.uRoofMap.value = weatherController.roofMap;
      u.uRoofMaskEnabled.value = 1.0;
    } else {
      u.uRoofMaskEnabled.value = 0.0;
    }

    if (bounds) {
      u.uSceneBounds.value.copy(bounds);
    }
  }

  dispose() {
    if (this.geometry) this.geometry.dispose();
    if (this.material) this.material.dispose();
  }
}
