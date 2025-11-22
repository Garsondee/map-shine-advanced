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
        uRoofMaskEnabled: { value: 0.0 }
      },
      vertexShader: `
        uniform float uTime;
        uniform vec3 uWindVector;
        uniform vec2 uScale;
        uniform vec4 uSceneBounds;
        uniform sampler2D uRoofMap;
        uniform float uRoofMaskEnabled;

        attribute float instanceIndex;

        varying float vAlpha;
        // Per-streak phase used for shimmer in fragment shader
        varying float vPhase;

        // Pseudo-random helper
        float hash(float n) {
          return fract(sin(n) * 43758.5453123);
        }

        void main() {
          // --- 1. Stateless Position Logic (same as current system) ---
          float idx = instanceIndex;
          float randSeed = hash(idx);
          
          // Life cycle
          float cycleDuration = 1.5 + randSeed; // Short life for rain
          float timeOffset = randSeed * 100.0;
          float localTime = mod(uTime + timeOffset, cycleDuration);
          float lifeProgress = localTime / cycleDuration;

          // Random spread over scene
          // We'll use the scene bounds to define the spawn area
          float spreadX = (hash(idx + 1.0) - 0.5);
          float spreadY = (hash(idx + 2.0) - 0.5);
          
          float areaW = uSceneBounds.z;
          float areaH = uSceneBounds.w;
          float centerX = uSceneBounds.x + areaW * 0.5;
          float centerY = uSceneBounds.y + areaH * 0.5;

          // Jitter the spawn height so drops originate from a tall column above
          // the scene, making the camera feel embedded in the rain volume.
          float spawnZ = 3500.0 + hash(idx + 5.0) * 2500.0; // ~3500-6000

          vec3 startPos = vec3(
            centerX + spreadX * areaW,
            centerY + spreadY * areaH,
            spawnZ
          );

          // Motion: Fall + Wind
          // We keep a coherent overall wind direction but only add modest
          // noise so that even at windSpeed=1.0 the motion still feels like
          // a driven sheet of rain, not fully chaotic.

          // 0..1 measure of lateral wind intensity (matches CPU mapping of 1.0 -> 1000 units/sec)
          // TODO: Revisit this turbulence model once a full 2D wind field and
          // lighting-aware rain interaction are available; current noise is a
          // tuned approximation for cinematic behaviour.
          float windStrength = clamp(length(uWindVector.xy) / 800.0, 0.0, 1.0);

          // Base horizontal wind vector
          vec2 baseWind = uWindVector.xy;

          // Time-varying noise direction per streak (slow to medium speed), with
          // a per-streak frequency so they don't all orbit in sync.
          float freq = 0.3 + windStrength * 1.2 + hash(idx + 6.0) * 0.8;
          float noisePhase = uTime * freq + randSeed * 6.2831853;
          vec2 noiseDir = vec2(cos(noisePhase), sin(noisePhase));

          // Per-streak jitter radius so not all streaks share the same offset
          // distance from the wind axis.
          float jitterRadius = (10.0 + 60.0 * hash(idx + 7.0)) * windStrength;
          vec2 jitter = noiseDir * jitterRadius;

          // Combine large-scale wind with local turbulence.
          vec2 combinedWind = baseWind + jitter;

          // If there is essentially no base wind, keep drizzle mostly vertical,
          // only adding a modest, less-patterned lateral component.
          vec2 finalWindXY = (length(baseWind) > 10.0)
            ? combinedWind
            : jitter * 0.5;

          // Vertical motion with simple acceleration: v = v0 + a*t, z = z0 + v0*t + 0.5*a*t^2
          // Each streak gets a slightly different initial fall speed so they
          // cross the scene and hit the ground at different times.
          float baseFallSpeed = 900.0 + 600.0 * hash(idx + 3.0); // ~900-1500
          float gravity = -1800.0; // pulls them down faster over time

          float t = localTime;
          float vz0 = -baseFallSpeed;
          float vz = vz0 + gravity * t;
          float zOffset = vz0 * t + 0.5 * gravity * t * t;

          vec2 lateralOffset = finalWindXY * t;
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
          // A simple approach: The strip connects P and P - (velocity * dt).
          // Or P and P + (dir * length).
          
          float streakLength = uScale.y * 50.0; // Base length multiplier
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

          vAlpha = alpha;
          // Cache a per-streak phase for shimmer; use a distinct hash so
          // neighbouring streaks don't sync.
          vPhase = hash(idx + 9.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uSceneDarkness;
        uniform float uTime;
        varying float vAlpha;
        varying float vPhase;

        void main() {
          float alpha = uOpacity * vAlpha;
          if (alpha <= 0.01) discard;

          // Global brightness from scene darkness: at darkness=0 rain is at
          // full base brightness; at darkness=1 it is significantly dimmed.
          float darkness = clamp(uSceneDarkness, 0.0, 1.0);
          float baseBrightness = mix(1.0, 0.2, darkness); // 1.0 -> 0.2

          // Darkness-aware shimmer: in bright scenes we allow a subtle
          // specular-like twinkle along the streaks; in darkness we
          // suppress it so rain doesn't glow in the dark.
          float lightFactor = 1.0 - 0.7 * darkness; // 1.0 -> 0.3

          // Time-varying sparkle per streak; vPhase ensures neighbours
          // don't sync perfectly.
          float sparkle = 0.5 + 0.5 * sin(uTime * 12.0 + vPhase * 6.2831853);

          // Final specular boost, kept gentle so it reads as a wet sheen
          // rather than glitter.
          float specIntensity = 0.3; // overall strength cap
          float spec = specIntensity * sparkle * lightFactor;

          vec3 baseColor = uColor * baseBrightness;
          vec3 finalColor = baseColor * (1.0 + spec);
          gl_FragColor = vec4(finalColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    // 4. Mesh
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // Prevent culling since instances move outside bounding sphere of base geo
    this.mesh.frustumCulled = false; 
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

      const precip = weatherState.precipitation || 0;

      // Base length factor ~1.0. Increases with precipitation and wind so that
      // heavier, windier storms produce longer, sharper streaks, while drizzle
      // stays shorter.
      const baseLen = 1.0;
      const lengthFactor = 0.6 + precip * 1.4 + windSpeed * 0.8; // ~0.6 - 2.8
      u.uScale.value.y = baseLen * lengthFactor;

      // Slightly thicken streaks under strong wind so sheets of rain read a
      // bit more solid in storms.
      const baseThickness = 0.05;
      const thicknessFactor = 0.9 + windSpeed * 0.6; // ~0.9 - 1.5
      u.uScale.value.x = baseThickness * thicknessFactor;
    }

    // Scene darkness: drive from Foundry scene environment if available so
    // shimmer fades appropriately in dark scenes.
    try {
      if (typeof canvas !== 'undefined' && canvas?.scene?.environment?.darknessLevel !== undefined) {
        u.uSceneDarkness.value = canvas.scene.environment.darknessLevel;
      }
    } catch (e) {
      // If canvas is not ready or throws, keep previous value.
    }

    // Roof / outdoors mask: cull rain under covered/indoor regions when the
    // WeatherController has a roofMap (the _Outdoors texture) available.
    if (weatherController && weatherController.roofMap) {
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
