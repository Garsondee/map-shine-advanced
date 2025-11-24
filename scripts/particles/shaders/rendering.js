/**
 * @fileoverview TSL Render Material for Particles
 * Defines the visual appearance of particles using data from Storage Buffers.
 * @module particles/shaders/rendering
 */

/**
 * Creates the particle render material for Points
 * Plain WebGL2 ShaderMaterial (no TSL / NodeMaterial).
 * @param {typeof THREE} THREE - Three.js library
 * @param {Object} buffers - ParticleBuffers instance containing storage buffers
 * @param {THREE.Texture} texture - Base particle texture
 * @param {Object} uniforms - Uniforms object (time, deltaTime) to be wired
 * @returns {THREE.ShaderMaterial} Material for rendering particles
 */
export function createParticleMaterial(THREE, buffers, texture, uniforms) {
  const particlesPerEmitter = Math.max(1, Math.floor(buffers.capacity / buffers.emitterCount));
  const emitterTexWidth = buffers.emitterCount * 8;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0.0 },
      uDeltaTime: { value: 0.016 },
      uEmitterTex: { value: buffers.emitterTexture },
      uEmitterTexSize: { value: new THREE.Vector2(emitterTexWidth, 1) },
      uParticlesPerEmitter: { value: particlesPerEmitter },
      uEmitterCount: { value: buffers.emitterCount },
      uParticleTexture: { value: texture },
      uSceneBounds: { value: new THREE.Vector4(0, 0, 10000, 10000) }, // x, y, w, h
      uWindVector: { value: new THREE.Vector3(0, 0, 0) },
      uRoofMap: { value: null },
      uRoofMaskEnabled: { value: 0.0 },
      uFirePositionMap: { value: null },
      uGlobalWindInfluence: { value: 1.0 },
      // Debug: global rain streak orientation in degrees (screen-space)
      uRainAngle: { value: 270.0 }
    },
    vertexShader: `
      uniform float uTime;
      uniform sampler2D uEmitterTex;
      uniform vec2 uEmitterTexSize;
      uniform float uParticlesPerEmitter;
      uniform float uEmitterCount;
      uniform vec4 uSceneBounds;
      uniform vec3 uWindVector;
      uniform sampler2D uRoofMap;
      uniform float uRoofMaskEnabled;
      uniform sampler2D uFirePositionMap;
      uniform float uGlobalWindInfluence;
      uniform float uRainAngle;

      attribute float index;

      varying vec4 vColor;
      varying float vAlpha;
      varying float vType;
      // Screen-space motion direction (for oriented streaks)
      varying vec2 vMotionDir;

      // Read a single float from the 1D emitter texture
      float readEmitterFloat(int offset) {
        float x = (float(offset) + 0.5) / uEmitterTexSize.x;
        return texture2D(uEmitterTex, vec2(x, 0.5)).r;
      }

      float hash(float n) {
        return fract(sin(n) * 43758.5453123);
      }

      void main() {
        float idx = index;
        float emitterIdxF = floor(idx / uParticlesPerEmitter);
        emitterIdxF = clamp(emitterIdxF, 0.0, uEmitterCount - 1.0);
        int emitterIdx = int(emitterIdxF);

        int baseOffset = emitterIdx * 8;
        float emX = readEmitterFloat(baseOffset + 0);
        float emY = readEmitterFloat(baseOffset + 1);
        float emZ = readEmitterFloat(baseOffset + 2);
        float emType = readEmitterFloat(baseOffset + 3);
        float emRate = readEmitterFloat(baseOffset + 4);
        float emParam1 = readEmitterFloat(baseOffset + 5);
        float emParam2 = readEmitterFloat(baseOffset + 6);

        // Local life cycle
        float randSeed = hash(idx);
        float cycleDuration = 2.0 + randSeed; // 2.0 - 3.0s
        float timeOffset = randSeed * 100.0;
        float localTime = mod(uTime + timeOffset, cycleDuration);
        float lifeProgress = localTime / cycleDuration; // 0.0 -> 1.0

        // Default random spread
        float spread = (hash(idx + 1.0) - 0.5) * 2.0;
        float spreadY = (hash(idx + 2.0) - 0.5) * 2.0;

        vec3 pos = vec3(0.0);
        vec4 color = vec4(1.0);
        float size = 1.0;

        // World-space motion direction for this particle type (approximate)
        vec3 motionDir = vec3(0.0);

        // --- Wind & Shelter Calculation ---
        // Calculate shelter factor based on _Outdoors mask
        // Default to full exposure (1.0) if mask not enabled
        float outdoorFactor = 1.0;
        
        if (uRoofMaskEnabled > 0.5) {
             // Check current particle "base" position against shelter map
             // We use the emitter position for stability, or projected pos?
             // Using emitter position is safer for fire base logic.
             float u = (emX - uSceneBounds.x) / uSceneBounds.z;
             float v = (emY - uSceneBounds.y) / uSceneBounds.w;
             v = 1.0 - v; // Flip Y
             vec2 mapUV = clamp(vec2(u, v), 0.0, 1.0);
             
             // Sample texture (white = outdoors/exposed, black = indoor/sheltered)
             outdoorFactor = texture2D(uRoofMap, mapUV).r;
        }
        
        vec3 effectiveWind = uWindVector * outdoorFactor * uGlobalWindInfluence;

        if (emType == 0.0) {
          // FIRE (Lookup Map Technique)
          // ---------------------------------------------
          // uFirePositionMap is a packed list of VALID spawn locations built
          // on the CPU from the _Fire luminance mask at load time.
          //
          // Instead of throwing particles into a large rectangle and then
          // rejecting the ones that land on dark pixels, we:
          //   1. Scan the mask once on the CPU and record every bright pixel.
          //   2. Store those (u,v,brightness) triples into a float texture.
          //   3. Here in the shader, pick a random texel from that list.
          //
          // Result: 100% of live particles are guaranteed to spawn ON the
          // painted fire mask, no wasted work, and the visual density directly
          // reflects the original luminance.

          // 1. Generate a random ID for looking up a position
          // We use the particle index and time to pick a spot in our
          // Coordinate Texture (position map).
          vec2 lookupUV = vec2(hash(idx + 10.0 + uTime * 0.1), hash(idx + 20.0 + uTime * 0.1));
          
          // 2. Read the coordinate from our DataTexture
          vec4 spawnData = texture2D(uFirePositionMap, lookupUV);
          
          // spawnData.x = World X (Normalized 0-1)
          // spawnData.y = World Y (Normalized 0-1)
          // spawnData.z = Intensity
          
          if (spawnData.z <= 0.001) {
              // Hit an empty spot? Kill particle
              size = 0.0;
              pos = vec3(0.0, 0.0, -9999.0);
          } else {
              // 3. Map Normalized Coord back to World Space
              // Use uSceneBounds directly as the reference frame for the mask
              float worldX = uSceneBounds.x + (spawnData.x * uSceneBounds.z);
              float worldY = uSceneBounds.y + (spawnData.y * uSceneBounds.w); // y is already flipped in generator
              
              // Apply some jitter so they don't look like a grid
              float jitterX = (hash(idx) - 0.5) * 10.0; 
              float jitterY = (hash(idx + 1.0) - 0.5) * 10.0;
              
              pos = vec3(worldX + jitterX, worldY + jitterY, 0.0);
          }

          // Fire Styling: life-based color gradient and size pulse.
          // Color over life:
          //   0.0 -> 0.3 : White/Yellow base
          //   0.3 -> 0.8 : Orange body
          //   0.8 -> 1.0 : Dark red tip
          vec3 cBase = vec3(1.0, 0.95, 0.7);
          vec3 cBody = vec3(1.0, 0.45, 0.0);
          vec3 cTip  = vec3(0.7, 0.15, 0.0);

          vec3 cFire = mix(cBase, cBody, smoothstep(0.0, 0.3, lifeProgress));
          cFire = mix(cFire, cTip, smoothstep(0.3, 0.8, lifeProgress));

          color = vec4(cFire, 1.0);

          // Size over life: quick grow, then gradual shrink
          // 0.0 -> 0.2 : grow from small to full
          // 0.2 -> 1.0 : shrink back down
          float grow = smoothstep(0.0, 0.2, lifeProgress);
          float shrink = 1.0 - smoothstep(0.2, 1.0, lifeProgress);
          float baseSize = 0.6 + 0.4 * grow;   // 0.6 -> 1.0
          float fadeSize = 0.3 + 0.7 * shrink; // 1.0 -> 0.3
          size = baseSize * fadeSize;

          motionDir = vec3(0.0, 0.0, 1.0);
        } else if (emType == 1.0) {
          // SMOKE ONLY (Smoldering)
          vec3 up = vec3(0.0, 0.0, 1.0) * (localTime * 50.0);
          vec3 drift = vec3(spread, spreadY, 0.0) * 10.0 + effectiveWind * localTime;
          pos = vec3(emX, emY, emZ) + up + drift;

          color = vec4(0.3, 0.3, 0.3, 0.5);
          size = 0.5 + lifeProgress;
          color.a *= (1.0 - lifeProgress);
          
          motionDir = normalize(vec3(0.0, 0.0, 1.0));
          
        } else if (emType == 2.0) {
          // RAIN
          vec3 fall = vec3(0.0, 0.0, -1.0) * (localTime * 1500.0);
          
          float width = (emParam1 > 0.0) ? emParam1 : 500.0;
          float height = (emParam2 > 0.0) ? emParam2 : 500.0;
          
          vec3 area = vec3(spread * width * 0.5, spreadY * height * 0.5, 0.0);
          pos = vec3(emX, emY, emZ) + area + fall;

          // Softer, dimmer blue so it reads as rain instead of blown-out white
          color = vec4(0.35, 0.55, 0.95, 0.45);
          // Slightly smaller base size to avoid blobby appearance
          size = 0.3;

          // Approximate world-space motion for rain: fast downward fall plus lateral wind drift.
          // We don't have per-particle velocity in this stateless shader, so we reuse the
          // analytic fall direction and add projected wind.
          motionDir = normalize(vec3(uWindVector.xy * 0.001, -1.0));
        } else {
          // MAGIC / SPARKLES (Default fallback)
          float radius = localTime * 5.0;
          float theta = spread * 3.14159265;
          float phi = spreadY * 3.14159265;
          vec3 dir = vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));

          pos = vec3(emX, emY, emZ) + dir * radius;
          color = vec4(0.8, 0.3, 1.0, 1.0);
          size = 1.0 - lifeProgress;
          motionDir = normalize(dir);
        }

        // Visibility / Opacity
        float isActive = step(0.0, emRate - 0.0001);
        float fadeIn = clamp(lifeProgress * 10.0, 0.0, 1.0);
        // Note: Some types handle their own fadeOut (fire)
        float fadeOut = (emType == 0.0) ? 1.0 : clamp((1.0 - lifeProgress) * 5.0, 0.0, 1.0);
        
        // Clipping: Check if inside scene bounds
        float inBoundsX = step(uSceneBounds.x, pos.x) * step(pos.x, uSceneBounds.x + uSceneBounds.z);
        float inBoundsY = step(uSceneBounds.y, pos.y) * step(pos.y, uSceneBounds.y + uSceneBounds.w);
        float inBounds = inBoundsX * inBoundsY;

        float alpha = fadeIn * fadeOut * isActive * inBounds;

        vColor = color;
        vAlpha = alpha;
        vType = emType;

        // For now, use a fixed screen-space downward direction for streaks.
        vMotionDir = vec2(0.0, -1.0);

        // Standard model-view-projection transform
        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        // Depth-aware point sizing so particles scale with zoom like world objects.
        // Reference depth matches the default camera distance in SceneComposer (10000).
        float depth = -mvPosition.z;
        float referenceDepth = 10000.0;
        float depthScale = referenceDepth / max(depth, 1.0);

        // Slightly smaller point size so particles read as embers rather than blobs.
        gl_PointSize = size * 30.0 * depthScale;
      }
    `,
    fragmentShader: `
      uniform sampler2D uParticleTexture;
      uniform float uRainAngle;

      varying vec4 vColor;
      varying float vAlpha;
      varying float vType;
      varying vec2 vMotionDir;

      void main() {
        vec2 uv = gl_PointCoord;

        vec4 col;

        if (vType == 2.0) {
          // RAIN: render as a streak aligned with the projected motion direction.
          // We build a thin, soft-edged line mask in the point sprite quad using
          // vMotionDir (in screen space) as the "along" axis.

          // Centered quad coordinates in [-0.5, 0.5]
          vec2 p = uv - vec2(0.5);

          // Orthonormal basis from a debug-controlled angle (degrees)
          float angle = radians(uRainAngle);
          vec2 dir = vec2(cos(angle), sin(angle));
          vec2 ortho = vec2(-dir.y, dir.x);

          float along  = dot(p, dir);   // along motion
          float across = dot(p, ortho); // perpendicular to motion

          float halfWidth = 0.08;  // streak thickness
          float halfHeight = 0.5;  // streak length
          float edgeSoftness = 0.03;

          float maskAcross = smoothstep(halfWidth + edgeSoftness, halfWidth, abs(across));
          float maskAlong  = smoothstep(halfHeight + edgeSoftness, halfHeight, abs(along));
          float lineMask = maskAcross * maskAlong;

          col = vec4(vColor.rgb, vColor.a * lineMask);
        } else {
          // Other types (fire/smoke/magic): render as soft round sprites using
          // a procedural radial alpha falloff so they appear as glowing discs
          // instead of hard-edged squares.
          vec2 p = uv - vec2(0.5);
          float r = length(p);
          float edge = 0.5;
          float inner = 0.25;
          float radialMask = 1.0 - smoothstep(inner, edge, r);

          col = vec4(vColor.rgb, vColor.a * radialMask);
        }

        col.a *= vAlpha;
        if (col.a <= 0.001) discard;
        gl_FragColor = col;
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    // Use normal alpha blending so rain appears as blue droplets over the map
    // instead of overly bright additive blobs.
    blending: THREE.NormalBlending
  });

  // Wire uniforms into the provided container so ParticleSystem.update()
  // can continue to drive time-based animation.
  if (uniforms) {
    uniforms.time = material.uniforms.uTime;
    uniforms.deltaTime = material.uniforms.uDeltaTime;
    uniforms.sceneBounds = material.uniforms.uSceneBounds;
    // Fire mask plumbing
    uniforms.firePositionMap = material.uniforms.uFirePositionMap;
    // Expose debug rain angle uniform for external control
    uniforms.rainAngle = material.uniforms.uRainAngle;
  }

  return material;
}
