/**
 * @fileoverview Instanced geometry for 3D rain streaks
 * Uses THREE.InstancedBufferGeometry to render actual 3D strips aligned with motion.
 * @module particles/RainStreakGeometry
 */

import { weatherController } from '../core/WeatherController.js';

export class RainStreakGeometry {
  constructor(capacity = 10000) {
    this.capacity = capacity;
    this.geometry = null;
    this.material = null;
    this.mesh = null;
    this._spawnDensity = 0;
  }

  /**
   * Initialize geometry and material
   * @param {typeof THREE} THREE
   */
  initialize(THREE) {
    // 1. Base Geometry: A thin vertical quad (billboarded or fixed, we'll orient it in shader)
    // Defined in range -0.5 to 0.5
    const baseGeometry = new THREE.PlaneGeometry(1, 1);
    
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = baseGeometry.index;
    this.geometry.attributes.position = baseGeometry.attributes.position;
    this.geometry.attributes.uv = baseGeometry.attributes.uv;

    // 2. Instance Attributes
    // We'll use a procedural approach similar to the current stateless shader
    // so we just need an index/seed per instance to generate positions.
    const indices = new Float32Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      indices[i] = i;
    }
    this.geometry.setAttribute('instanceIndex', new THREE.InstancedBufferAttribute(indices, 1));

    // 3. Material
    // Custom shader to position and orient each instance
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDeltaTime: { value: 0.016 },
        uWindVector: { value: new THREE.Vector3(0, 0, 0) },
        uColor: { value: new THREE.Color(0.6, 0.7, 1.0) },
        uOpacity: { value: 0.6 },
        uScale: { value: new THREE.Vector2(0.05, 1.0) }, // Thickness, Length scale
        uSceneBounds: { value: new THREE.Vector4(0, 0, 10000, 10000) },
        // Foundry scene darkness (0 = fully lit, 1 = max darkness)
        uSceneDarkness: { value: 0.0 },
        // Roof / outdoors mask (_Outdoors texture) for indoor/outdoor culling
        uRoofMap: { value: null },
        uRoofMaskEnabled: { value: 0.0 },
        // Spawn density 0..1 controls how many streak instances are active
        uSpawnDensity: { value: 0.0 },
        // Normalized wind speed 0..1 used to modulate droplet breakup in the
        // fragment shader (high wind => smoother, less segmented streaks).
        uWindSpeed: { value: 0.0 }
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
        // Per-streak phase used for shimmer in fragment shader
        varying float vPhase;
        // Along-streak coordinate in [0,1] for tip shaping
        varying float vAlong;
        // Across-streak coordinate in [0,1] for jagged silhouette
        varying float vWidthCoord;

        // Pseudo-random helper
        float hash(float n) {
          return fract(sin(n) * 43758.5453123);
        }

        void main() {
          // --- 1. Stateless Position Logic ---
          float idx = instanceIndex;
          float randSeed = hash(idx);
          
          // Life cycle
          float cycleDuration = 1.5 + randSeed; // Short life for rain
          float timeOffset = randSeed * 100.0;
          float localTime = mod(uTime + timeOffset, cycleDuration);
          float lifeProgress = localTime / cycleDuration;

          // Per-instance spawn gating driven by precipitation slider.
          // Use an explicit epsilon guard so that when density is effectively
          // zero, NO streaks render (even if hash() returns 0.0 for some ids).
          float density = clamp(uSpawnDensity, 0.0, 1.0);
          float spawnMask = step(hash(idx + 13.0), density) * step(0.0001, density);

          // Random spread over scene
          float spreadX = (hash(idx + 1.0) - 0.5);
          float spreadY = (hash(idx + 2.0) - 0.5);
          
          float areaW = uSceneBounds.z;
          float areaH = uSceneBounds.w;
          float centerX = uSceneBounds.x + areaW * 0.5;
          float centerY = uSceneBounds.y + areaH * 0.5;

          // Jitter the spawn height so drops originate from a taller column above the scene.
          float spawnZ = 5000.0 + hash(idx + 5.0) * 4000.0; // ~5000-9000

          vec3 startPos = vec3(
            centerX + spreadX * areaW,
            centerY + spreadY * areaH,
            spawnZ
          );

          // --- 2. Wind + Chaos ---

          // Normalized lateral wind intensity 0..1
          float rawWind = length(uWindVector.xy) / 800.0;
          float windStrength = pow(clamp(rawWind, 0.0, 1.0), 2.5);

          // 1) Per-particle speed variation: 0.5x .. 1.5x
          float speedVar = 0.5 + hash(idx + 31.0);

          // 2) Per-particle direction jitter: rotate wind by +/- ~15 degrees
          float dirNoise = (hash(idx + 45.0) - 0.5) * 0.5 * windStrength;
          float c = cos(dirNoise);
          float s = sin(dirNoise);
          vec2 uniqueWind = vec2(
            uWindVector.x * c - uWindVector.y * s,
            uWindVector.x * s + uWindVector.y * c
          );

          // 3) ID-based turbulence: independent meander per instance.
          // At low wind we allow some wobble; at high wind we damp it so
          // directional flow dominates and we don't get sideways thrashing.
          float turbFreq = 2.0;
          float uniquePhase = hash(idx + 99.0) * 100.0;
          float turbAmp = windStrength * 50.0 * (1.0 - 0.5 * windStrength);
          turbAmp = max(turbAmp, 0.0);
          vec2 turbulence = vec2(
            sin(uTime * turbFreq + uniquePhase),
            cos(uTime * turbFreq * 0.8 + uniquePhase)
          ) * turbAmp;

          // Base wind terminal velocity for this streak
          vec2 vTerm = uniqueWind * (windStrength / (rawWind + 0.001)) * speedVar;

          // Drag / inertia response: streaks accelerate sideways into the wind
          // x(t) = vTerm * (t - (1-exp(-k*t))/k)
          float dragCoeff = 3.0;
          float windResponse = localTime - (1.0 - exp(-dragCoeff * localTime)) / dragCoeff;
          vec2 windDisplacement = vTerm * windResponse;

          // Total lateral offset: mostly wind-driven, with small uncorrelated turbulence
          vec2 lateralOffset = windDisplacement + turbulence;

          // Approximate instantaneous lateral velocity for orientation
          // dv/dt for the drag curve tends to vTerm as t grows; we approximate
          // using vTerm plus a small turbulence contribution.
          vec2 finalWindXY = vTerm + turbulence * 0.2; 

          // Vertical motion with simple acceleration.
          // At higher wind, slightly increase fall speed and gravity so the
          // streaks still read as falling rain rather than sliding sideways.
          float baseFallSpeed = (900.0 + 600.0 * hash(idx + 3.0)) * (1.0 + 0.5 * windStrength);
          float gravity = -1800.0 * (1.0 + windStrength);

          float t = localTime;
          float vz0 = -baseFallSpeed;
          float vz = vz0 + gravity * t;
          float zOffset = vz0 * t + 0.5 * gravity * t * t;

          vec3 currentPos = startPos + vec3(lateralOffset, zOffset);

          // Wrap/Clip logic could go here, but simple modulus works for continuous rain

          // --- 2. Orientation Logic ---
          // We want to align the strip with the motion vector, which we
          // approximate using the current lateral wind plus vertical velocity.
          
          // We need a "right" vector to define the strip width.
          // Since we are viewing from top-down (mostly), we want the strip to face the camera
          // or just be flat against the view plane?
          // Actually, for 3D streaks, we usually want them to face the camera around the axis of travel.
          
          // View-aligned billboard technique:
          // 1. Get view direction (camera position - instance position)
          // 2. Cross view dir with velocity to get "right" vector
          
          // Simplified for orthographic/top-down: 
          // Camera is roughly +Z, but we are in 3D.
          // Let's assume standard billboard behavior constrained to an axis.
          
          // But wait, we want "true 3D". 
          // A simple approach: The strip connects P and P - (velocity * dt),
          // so slower drops appear shorter and faster drops appear longer.

          // Use current velocity magnitude to modulate streak length per instance.
          float speed = length(vec3(finalWindXY, vz));
          // Reference speed chosen around typical storm terminal speed so
          // drizzle is visibly shorter while heavy, fast rain is longer.
          float refSpeed = 1800.0;
          float speedNorm = clamp(speed / refSpeed, 0.3, 1.5);
          float streakLength = uScale.y * 25.0 * speedNorm;
          float thickness = uScale.x * 10.0;

          // Basis vectors
          vec3 axisY = normalize(vec3(finalWindXY, vz)); // Length axis
          // Arbitrary up to find Right, then correct
          vec3 up = vec3(0.0, 0.0, 1.0);
          if (abs(dot(axisY, up)) > 0.99) up = vec3(0.0, 1.0, 0.0);
          vec3 axisX = normalize(cross(axisY, up)); // Width axis
          
          // Ideally, axisX should be perpendicular to View Direction so it faces camera.
          // In Vertex Shader, 'cameraPosition' is available.
          vec3 viewDir = normalize(cameraPosition - currentPos);
          axisX = normalize(cross(axisY, viewDir));

          // Vertex offset from base geometry (which is 1x1 centered at 0)
          vec3 localPos = position; // -0.5 to 0.5
          
          // Scale
          // x moves along axisX (width)
          // y moves along axisY (length)
          vec3 offset = axisX * (localPos.x * thickness) + axisY * (localPos.y * streakLength);
          
          vec3 worldPos = currentPos + offset;

          // --- 3. Rendering ---
          vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
          gl_Position = projectionMatrix * mvPosition;

          // Fade in/out
          float alpha = 1.0;
          // Simple fade at ends of life
          alpha *= smoothstep(0.0, 0.1, lifeProgress);
          alpha *= smoothstep(1.0, 0.9, lifeProgress);
          
          // Clip bounds
          if (currentPos.x < uSceneBounds.x || currentPos.x > uSceneBounds.x + uSceneBounds.z ||
              currentPos.y < uSceneBounds.y || currentPos.y > uSceneBounds.y + uSceneBounds.w) {
             alpha = 0.0;
          }

          // Optional roof/outdoors mask culling: use the _Outdoors texture to
          // prevent rain from rendering under covered/indoor regions. For this
          // pass, we treat dark (low) values as "covered" so that rain only
          // appears over the bright portions of the mask.
          if (uRoofMaskEnabled > 0.5) {
            float u = (currentPos.x - uSceneBounds.x) / uSceneBounds.z;
            float v = (currentPos.y - uSceneBounds.y) / uSceneBounds.w;
            // Roof mask is authored in top-down Foundry space (Y-down), while
            // our world coordinates here are Y-up. Flip V so the mask is not
            // vertically inverted relative to the scene.
            v = 1.0 - v;
            vec2 roofUv = clamp(vec2(u, v), 0.0, 1.0);

            float roofCover = texture2D(uRoofMap, roofUv).r;
            // 1.0 where mask is bright (outdoors), 0.0 where mask is dark (covered).
            float isOutdoor = step(0.5, roofCover);
            alpha *= isOutdoor;
          }

          // Apply spawn density mask last so that precipitation directly
          // controls the fraction of active streaks.
          alpha *= spawnMask;

          vAlpha = alpha;
          // Cache a per-streak phase for shimmer; use a distinct hash so
          // neighbouring streaks don't sync.
          vPhase = hash(idx + 9.0);

          // Normalized along-streak coordinate (0 = one end, 1 = the other).
          // Map localPos.y = -0.5 (tail) .. +0.5 (tip) directly into 0..1.
          vAlong = localPos.y + 0.5;
          // Normalized across-streak coordinate; map localPos.x = -0.5..0.5 to 0..1.
          vWidthCoord = localPos.x + 0.5;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uSceneDarkness;
        uniform float uTime;
        uniform float uWindSpeed;
        varying float vAlpha;
        varying float vPhase;
        varying float vAlong;
        varying float vWidthCoord;

        void main() {
          float alpha = uOpacity * vAlpha;
          if (alpha <= 0.01) discard;

          // Global brightness from scene darkness.
          float darkness = clamp(uSceneDarkness, 0.0, 1.0);
          float baseBrightness = mix(1.0, 0.25, darkness);

          // Geometric shaping: tip-bright streak with sharp front fade and
          // longer, softer fade toward the back (tail).
          float along = clamp(vAlong, 0.0, 1.0);             // 0 = tail, 1 = tip
          float width = clamp(vWidthCoord, 0.0, 1.0);        // 0..1 across

          // Long, soft tail: fade in gradually over ~40% of the length.
          float tailMask = smoothstep(0.0, 0.40, along);
          // Sharp front (tip): fade out quickly in the last ~10%.
          float tipMask  = 1.0 - smoothstep(0.90, 1.0, along);
          float alongMask = tailMask * tipMask;

          // Across-streak coordinate in -1..1.
          float x = width * 2.0 - 1.0;

          // Inner bright core: thin, high-opacity band on the center line.
          float coreWidth = 1.0 - smoothstep(0.05, 0.18, abs(x));
          float coreMask = pow(coreWidth, 2.5);

          // Outer halo: wider, low-opacity shoulder so it doesn't look like a
          // single pixel wire.
          float haloWidth = 1.0 - smoothstep(0.25, 0.50, abs(x));
          float haloMask = pow(haloWidth, 1.5);

          float widthMask = max(coreMask, 0.35 * haloMask);

          // Base raindrop silhouette.
          float shape = alongMask * widthMask;

          // Breakup noise: punch small holes along the streak so it feels
          // more like motion-blurred droplets than a solid bar. Use a less
          // obviously periodic combination of along, vPhase, and time.
          float breakupPhase = along * 83.17 + vPhase * 127.31 + uTime * 5.0;
          float breakupBase = sin(breakupPhase) * 0.7 + cos(breakupPhase * 1.731) * 0.3;
          float breakup = 0.6 + 0.4 * fract(breakupBase * 43758.5453123);

          alpha *= shape * breakup;
          if (alpha <= 0.001) discard;

          // Subtle internal highlight along the center, biased toward the tip.
          float highlightCore = smoothstep(0.4, 0.0, abs(x));
          float tipBoost = smoothstep(0.3, 1.0, along);
          float centerHighlight = highlightCore * tipBoost;

          float shimmer = 0.08 * sin(uTime * 18.0 + vPhase * 6.2831853);
          float highlight = 0.20 * centerHighlight + shimmer * centerHighlight;

          // Tip-weighted brightness: bias overall brightness so the leading
          // edge reads clearly brighter than the trailing tail.
          float tipBrightness = mix(0.7, 1.5, along);

          vec3 baseColor = uColor * baseBrightness;
          vec3 finalColor = baseColor * tipBrightness * (1.0 + highlight);

          gl_FragColor = vec4(finalColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide
    });

    // 4. Mesh
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // Prevent culling since instances move outside bounding sphere of base geo
    this.mesh.frustumCulled = false; 
    // Place in the overhead particles band (above overhead tiles at z≈20)
    this.mesh.position.z = 30.0;
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

    // Wind and length/thickness responsiveness
    // Weather controller gives windSpeed (0-1) and windDirection (vec2).
    // We map 1.0 speed to ~1000 units/sec lateral force and also use
    // precipitation + wind to drive streak length.
    if (weatherState && weatherState.windDirection) {
      const windSpeed = weatherState.windSpeed || 0;
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

    // Base length factor ~1.0. Now depends only on wind so precipitation
    // controls density (spawn) but not individual streak length.
    const windSpeed = (weatherState && typeof weatherState.windSpeed === 'number')
      ? weatherState.windSpeed
      : 0;
    // Also expose normalized wind speed directly to the fragment shader so
    // droplet breakup/segmentation can soften as wind increases.
    if (u.uWindSpeed) {
      u.uWindSpeed.value = windSpeed;
    }
    const baseLen = 1.0;
    const lengthFactor = 0.7 + windSpeed * 1.3; // ~0.7 - 2.0
    u.uScale.value.y = baseLen * lengthFactor;

    // Map precipitation 0..1 -> active streak fraction 0..1.
    // Use a slightly aggressive curve so density ramps up quickly.
    const clampedPrecip = Math.max(0, Math.min(1, precip));
    const targetDensity = Math.pow(clampedPrecip, 0.8);
    if (u.uSpawnDensity) {
      const delta = Math.max(0.0, Math.min(1.0, timeInfo.delta || 0));
      const k = 3.0;
      const lerp = 1.0 - Math.exp(-k * delta);
      this._spawnDensity += (targetDensity - this._spawnDensity) * lerp;
      // Hard cutoff: if density is effectively zero, force exact 0 so
      // the shader never spawns stray streaks from numerical edge cases.
      if (targetDensity <= 0.0001) {
        this._spawnDensity = 0.0;
      }
      u.uSpawnDensity.value = this._spawnDensity;
    }

    // Scene darkness: drive from Foundry scene environment if available.
    try {
      if (typeof canvas !== 'undefined' && canvas?.scene?.environment?.darknessLevel !== undefined) {
        u.uSceneDarkness.value = canvas.scene.environment.darknessLevel;
      }
    } catch (e) {
      // If canvas is not ready or throws, keep previous value.
    }

    // Roof / outdoors mask: cull rain under covered/indoor regions when the
    // WeatherController has a roofMap (the _Outdoors texture) available AND
    // the roofMaskActive flag is true (e.g. while roofs are hover-hidden).
    if (weatherController && weatherController.roofMap && weatherController.roofMaskActive) {
      u.uRoofMap.value = weatherController.roofMap;
      u.uRoofMaskEnabled.value = 1.0;
    } else {
      u.uRoofMaskEnabled.value = 0.0;
    }

    // Bounds
    if (bounds) {
      u.uSceneBounds.value.copy(bounds);
    }
  }

  dispose() {
    if (this.geometry) this.geometry.dispose();
    if (this.material) this.material.dispose();
  }
}
