import { weatherController } from '../core/WeatherController.js';

export class SnowGeometry {
  constructor(capacity = 8000) {
    this.capacity = capacity;
    this.geometry = null;
    this.material = null;
    this.mesh = null;
  }

  /**
   * Initialize instanced snowflake geometry and material.
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
        uColor: { value: new THREE.Color(0.9, 0.95, 1.0) },
        uOpacity: { value: 0.9 },
        uScale: { value: new THREE.Vector2(0.05, 0.05) }, // flake width/height
        uSceneBounds: { value: new THREE.Vector4(0, 0, 10000, 10000) },
        uSceneDarkness: { value: 0.0 },
        uRoofMap: { value: null },
        uRoofMaskEnabled: { value: 0.0 },
        uSpawnDensity: { value: 0.0 }
      },
      vertexShader: `
        uniform float uTime;
        uniform vec3 uWindVector;
        uniform vec2 uScale;
        uniform vec4 uSceneBounds;
        uniform float uSpawnDensity;
        uniform sampler2D uRoofMap;
        uniform float uRoofMaskEnabled;

        attribute float instanceIndex;

        varying float vAlpha;
        varying float vPhase;
        varying vec2 vUv;

        float hash(float n) {
          return fract(sin(n) * 43758.5453123);
        }

        // Wander Gust Field (Snow Tuned)
        // Returns 2D offset. Uses low frequencies to create broad, slow swirls.
        vec2 getGustField(float t, float windStrength) {
            float amp = windStrength * 25.0; 
            
            vec2 pos = vec2(0.0);
            // Very slow large drift (10s+ period)
            pos.x += sin(t * 0.3) * 15.0;
            pos.y += cos(t * 0.2) * 15.0;
            
            // Medium swirls
            pos.x += sin(t * 1.1) * 8.0;
            pos.y += cos(t * 0.9) * 8.0;
            
            return pos * amp;
        }

        void main() {
          float idx = instanceIndex;
          float rnd = hash(idx);

          float cycleDuration = 4.0 + rnd * 4.0; // slower life than rain
          float timeOffset = rnd * 123.0;
          float localTime = mod(uTime + timeOffset, cycleDuration);
          float life = localTime / cycleDuration;

          // Per-instance enable based on spawn density (snow intensity)
          float spawnMask = step(hash(idx + 17.0), clamp(uSpawnDensity, 0.0, 1.0));

          float areaW = uSceneBounds.z;
          float areaH = uSceneBounds.w;
          float centerX = uSceneBounds.x + areaW * 0.5;
          float centerY = uSceneBounds.y + areaH * 0.5;

          float spreadX = (hash(idx + 1.0) - 0.5) * areaW;
          float spreadY = (hash(idx + 2.0) - 0.5) * areaH;

          float spawnZ = 4500.0 + hash(idx + 5.0) * 3000.0; // ~4500-7500

          vec3 startPos = vec3(centerX + spreadX, centerY + spreadY, spawnZ);

          // Snow falls slowly with gentle flutter. Use wind as a bias plus
          // per-flake sinusoidal motion. We treat the magnitude of uWindVector
          // similarly to rain (1.0 windSpeed -> ~1000 units/sec), but apply a
          // drag-like response so flakes never fully match streak speed at
          // low winds, while still being driven hard in storms.

          // Normalized measure of wind intensity 0..1
          float rawWind = length(uWindVector.xy) / 1000.0;
          float windStrength = pow(clamp(rawWind, 0.0, 1.0), 2.5);

          // Base fall speed, accelerated modestly under strong wind so
          // blizzards feel more forceful than calm snowfall.
          float baseFall = 250.0 + 150.0 * hash(idx + 3.0);
          baseFall *= mix(1.0, 1.6, windStrength);
          float vz = -baseFall;
          float zOffset = vz * localTime;

          // Wind drift: scale with windStrength but keep some drag so snow
          // is always somewhat slower than the full wind vector.
          // Use safe division for direction
          vec2 baseWindDir = vec2(0.0);
          if (length(uWindVector.xy) > 0.001) {
             baseWindDir = normalize(uWindVector.xy);
          }
          
          float driftSpeed = mix(0.0, 950.0, windStrength); 
          vec2 windXY = baseWindDir * driftSpeed;

          // Flutter: figure-eight in the lateral plane per flake
          float flutterFreq = 0.6 + hash(idx + 7.0) * 0.8;
          float flutterAmp = 40.0 + 40.0 * hash(idx + 11.0);
          // Scale flutter down slightly at very high wind so it looks more driven
          flutterAmp *= mix(1.0, 0.3, windStrength); 
          
          // Extra per-flake phase offset so neighbouring flakes don't share
          // identical flutter cycles.
          float flutterPhaseOffset = hash(idx + 19.0) * 6.2831853;
          float phase = uTime * flutterFreq + rnd * 6.2831853 + flutterPhaseOffset;
          vec2 flutter = vec2(cos(phase), sin(phase * 0.7)) * flutterAmp;

          // At low wind, flutter dominates; at high wind it is partially
          // overwhelmed by strong directional drift.
          
          // Apply Drag/Inertia to Base Wind:
          // Snowflakes accelerate to wind speed faster than rain (high drag/mass ratio).
          // x(t) = v_term * (t - (1-exp(-k*t))/k)
          float dragCoeff = 5.0; 
          float windResponse = localTime - (1.0 - exp(-dragCoeff * localTime)) / dragCoeff;

          // Gust Displacement Field (Wandering 2D, Additive)
          // We use the 2D field to allow swirls/eddies, but the low frequency
          // ensures we don't see "ping-pong" vibration.
          float spawnTime = uTime - localTime;
          // Per-flake phase into gust field to decorrelate trajectories and
          // avoid obvious twin flakes.
          float gustPhase = hash(idx + 33.0) * 6.2831853;
          vec2 gustNow = getGustField(uTime + gustPhase, windStrength);
          vec2 gustSpawn = getGustField(spawnTime + gustPhase, windStrength);
          vec2 gustOffset = gustNow - gustSpawn;

          // Combine:
          // 1. Base Drift (with inertial drag)
          // 2. Gust Drift (complex wandering)
          // 3. Flutter (local aerodynamic noise)
          
          vec2 lateralOffset = windXY * windResponse + gustOffset + flutter;
          vec3 currentPos = startPos + vec3(lateralOffset, zOffset);

          // Clip if below ground (simple z check)
          if (currentPos.z < 0.0) {
            currentPos.z = -10000.0; // push behind camera and fade out
          }

          // Bounds-based alpha
          float alpha = 1.0;
          if (currentPos.x < uSceneBounds.x || currentPos.x > uSceneBounds.x + uSceneBounds.z ||
              currentPos.y < uSceneBounds.y || currentPos.y > uSceneBounds.y + uSceneBounds.w) {
            alpha = 0.0;
          }

          // Roof mask: prevent flakes indoors (same logic as rain)
          if (uRoofMaskEnabled > 0.5) {
            float u = (currentPos.x - uSceneBounds.x) / uSceneBounds.z;
            float v = (currentPos.y - uSceneBounds.y) / uSceneBounds.w;
            v = 1.0 - v;
            vec2 roofUv = clamp(vec2(u, v), 0.0, 1.0);
            float roofCover = texture2D(uRoofMap, roofUv).r;
            float isOutdoor = step(0.5, roofCover);
            alpha *= isOutdoor;
          }

          alpha *= smoothstep(0.0, 0.15, life);
          alpha *= smoothstep(1.0, 0.8, life);
          alpha *= spawnMask;

          vAlpha = alpha;
          vPhase = rnd;

          // Pass through mesh UVs for procedural flake shaping in fragment
          vUv = uv;

          // Camera-facing billboard quad
          vec3 worldPos = currentPos;
          vec3 camRight = vec3(1.0, 0.0, 0.0);
          vec3 camUp = vec3(0.0, 1.0, 0.0);

          vec3 localPos = position; // -0.5..0.5
          vec3 offset = camRight * (localPos.x * uScale.x * 40.0) +
                        camUp * (localPos.y * uScale.y * 40.0);

          worldPos += offset;

          vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uSceneDarkness;
        uniform float uTime;

        varying float vAlpha;
        varying float vPhase;
        varying vec2 vUv;

        void main() {
          float alpha = uOpacity * vAlpha;
          if (alpha <= 0.01) discard;

          float darkness = clamp(uSceneDarkness, 0.0, 1.0);
          float baseBrightness = mix(1.0, 0.4, darkness);

          // --- Procedural flake shape ---
          // Small soft disc with slightly noisy edges (no bullseye rings).
          vec2 p = vUv * 2.0 - 1.0;       // -1..1
          float r = length(p);

          // Base disc: bright core that falls off toward the edge.
          float core = smoothstep(1.0, 0.2, r);

          // Edge region mask: 0 in center, 1 near rim.
          float edge = smoothstep(0.1, 0.9, r);

          // Angular noise for a jagged outline; depends mostly on angle so
          // we don't generate concentric bands.
          float angle = atan(p.y, p.x);
          float edgeNoise = 0.5 + 0.5 * sin(uTime * 0.8 + vPhase * 9.0 + angle * 7.0);

          // Mix noise only into the outer edge so the center stays smooth.
          float edgeJitter = mix(1.0, edgeNoise, edge);
          float flakeMask = core * edgeJitter;

          // Twinkle modulation retained but applied on top of flake shape.
          float twinkle = 0.5 + 0.5 * sin(uTime * 1.5 + vPhase * 10.0);
          float twinkleMask = mix(0.8, 1.15, twinkle);

          alpha *= flakeMask * twinkleMask;
          if (alpha <= 0.01) discard;

          vec3 baseColor = uColor * baseBrightness;
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
   */
  update(timeInfo, weatherState, bounds) {
    if (!this.material) return;

    const u = this.material.uniforms;
    u.uTime.value = timeInfo.elapsed;
    u.uDeltaTime.value = timeInfo.delta;

    if (weatherState && weatherState.windDirection) {
      const windSpeed = weatherState.windSpeed || 0;
      // Match the rain mapping (1.0 -> ~1000 units/sec) so wind magnitude
      // is comparable, but the vertex shader applies drag for snow.
      const speed = windSpeed * 1000.0;
      u.uWindVector.value.set(
        weatherState.windDirection.x * speed,
        weatherState.windDirection.y * speed,
        0
      );
    }

    const precip = (weatherState && typeof weatherState.precipitation === 'number')
      ? weatherState.precipitation
      : 0;

    const clampedPrecip = Math.max(0, Math.min(1, precip));
    const density = Math.pow(clampedPrecip, 0.9);
    if (u.uSpawnDensity) {
      u.uSpawnDensity.value = density;
    }

    try {
      if (typeof canvas !== 'undefined' && canvas?.scene?.environment?.darknessLevel !== undefined) {
        u.uSceneDarkness.value = canvas.scene.environment.darknessLevel;
      }
    } catch (e) {
      // ignore
    }

    if (weatherController && weatherController.roofMap && weatherController.roofMaskActive) {
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
