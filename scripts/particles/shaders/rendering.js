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
      // Fire tuning
      uFireAlpha: { value: 0.4 },
      uFireCoreBoost: { value: 1.0 },
      uFireHeight: { value: 110.0 },
      uFireSize: { value: 18.0 },
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
      uniform float uFireAlpha;
      uniform float uFireCoreBoost;
      uniform float uFireHeight;
      uniform float uFireSize;
      uniform float uRainAngle;

      attribute float index;

      varying vec4 vColor;
      varying float vAlpha;
      varying float vType;
      // Screen-space motion direction (for oriented streaks)
      varying vec2 vMotionDir;
      // Per-particle life and seed for flame shaping in fragment shader
      varying float vLife;
      varying float vSeed;

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
        // Fire should feel like a lingering column rather than one-frame pops.
        // Use a longer base period so particles live ~4-8 seconds.
        float cycleDuration = 4.0 + randSeed * 4.0; // 4.0 - 8.0s
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
          
          // Treat emitter rate (0..1) as a spawn probability so the UI slider
          // directly controls how many particles are active for this emitter.
          float spawnChance = clamp(emRate, 0.0, 1.0);
          float spawnMask = step(hash(idx + emitterIdxF * 37.0), spawnChance);

          if (spawnData.z <= 0.001 || spawnMask < 0.5) {
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

              // Vertical rise over life. Height is artist-tunable via uFireHeight.
              float height = uFireHeight;
              float rise = lifeProgress * height;

              // 2D turbulent drift: as particles rise they curl and wobble.
              float swayPhase = (lifeProgress * 15.0) + (randSeed * 50.0) + (uTime * 2.0);
              float swayX = sin(swayPhase) * (8.0 * lifeProgress);
              float swayY = cos(swayPhase * 0.8) * (6.0 * lifeProgress);

              pos.z += rise;
              pos.x += swayX;
              pos.y += swayY;
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

          // Emitter rate controls how MANY particles are active (isActive),
          // not how bright an individual flame sprite is.
          color = vec4(cFire, 1.0);

          // Size over life: quick grow, then gradual shrink
          // 0.0 -> 0.2 : grow from small to full
          // 0.2 -> 1.0 : shrink back down
          float grow = smoothstep(0.0, 0.2, lifeProgress);
          float shrink = 1.0 - smoothstep(0.2, 1.0, lifeProgress);
          float baseSize = 0.4 + 0.3 * grow;   // 0.4 -> 0.7
          float fadeSize = 0.2 + 0.6 * shrink; // 0.8 -> 0.2
          // Slightly smaller overall so overlapping tongues build the volume
          // instead of each sprite trying to fill the whole fireball.
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
        // For fire, we already applied a probabilistic spawnMask above; here we
        // just gate on emRate > 0 so rate=0 reliably kills all particles.
        float isActive = step(0.0, emRate - 0.0001);
        float fadeIn = clamp(lifeProgress * 4.0, 0.0, 1.0);
        // Note: Some types handle their own fadeOut (fire)
        float fadeOut = (emType == 0.0)
          ? (1.0 - smoothstep(0.8, 1.0, lifeProgress)) // fade out only near very end
          : clamp((1.0 - lifeProgress) * 5.0, 0.0, 1.0);
        
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

        // Expose life and seed to fragment shader for procedural flame shaping
        vLife = lifeProgress;
        vSeed = randSeed;

        // Standard model-view-projection transform
        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        // Depth-aware point sizing so particles scale with zoom like world objects.
        // Reference depth matches the default camera distance in SceneComposer (10000).
        float depth = -mvPosition.z;
        float referenceDepth = 10000.0;
        float depthScale = referenceDepth / max(depth, 1.0);

        // Smaller point size so individual particles remain visible and don't
        // merge into an overbright blob under additive blending. uFireSize lets
        // artists tune overall fire sprite size from the UI.
        float sizeScale = (vType == 0.0) ? uFireSize : 18.0;
        gl_PointSize = size * sizeScale * depthScale;
      }
    `,
    fragmentShader: `
      uniform sampler2D uParticleTexture;
      uniform float uRainAngle;
      uniform float uTime;
      uniform float uFireAlpha;
      uniform float uFireCoreBoost;

      varying vec4 vColor;
      varying float vAlpha;
      varying float vType;
      varying vec2 vMotionDir;
      varying float vLife;
      varying float vSeed;

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
        } else if (vType == 0.0) {
          // FIRE: tapered, ragged, lower-opacity tongues with fuzzy edges.
          vec2 p = uv - vec2(0.5); // -0.5..0.5

          // For top-down fire, treat the sprite as a radial blob whose center
          // is the hottest region. Use radius for the main falloff and noise
          // to rag the edge so it looks wispy instead of perfectly round.
          float x = p.x * 2.0;
          float y = p.y * 2.0;
          float r = length(vec2(x, y));

          // Base radial shape: strong core that falls off toward the edge.
          float baseShape = 1.0 - smoothstep(0.0, 1.0, r);

          // Animated pseudo-noise using layered sines; modulated by life so
          // young particles flicker more than dying embers.
          float t = uTime * 5.0 + vSeed * 10.0;
          float n = sin((x + t) * 7.0) * 0.18 + sin((y + t * 1.3) * 11.0) * 0.10;
          n *= (0.5 + 0.5 * (1.0 - vLife));

          // Ragged, fuzzy mask. Keep the center solid, feather the outer edge.
          float flameShape = baseShape + n;

          // HARD REQUIREMENT: prevent any contribution near the sprite border so
          // we never see the square point sprite. p is in [-0.5, 0.5], so the
          // inscribed circle has radius 0.5. We force alpha to 0 as we approach
          // that boundary.
          float dist = length(p);
          float safeEdge = 1.0 - smoothstep(0.38, 0.5, dist);

          float edgeSoft = 0.4;
          float flameMask = smoothstep(0.0, edgeSoft, flameShape) * safeEdge;

          // Temperature/colour ramp: white-hot core -> yellow -> orange.
          float coreFactor = 1.0 - smoothstep(0.0, 0.4, r);
          float midFactor  = smoothstep(0.1, 0.7, r);

          vec3 whiteHot = vec3(1.0, 0.98, 0.9);   // slightly toned down to avoid blowout
          vec3 yellow   = vec3(1.0, 0.85, 0.35);
          vec3 orange   = vec3(1.0, 0.45, 0.05);

          vec3 hotCore  = mix(whiteHot, yellow, midFactor);
          vec3 outer    = orange;
          vec3 fireCol  = mix(outer, hotCore, coreFactor) * uFireCoreBoost;

          // Slight life-based dimming near the end so late particles read as
          // cooler embers.
          float lifeFade = 1.0 - smoothstep(0.7, 1.0, vLife);
          fireCol *= lifeFade * 0.8; // base dim; uFireCoreBoost scales over this

          // Lower per-sprite opacity so overlapping additive sprites build
          // brightness instead of forming a flat opaque blob. uFireAlpha lets
          // artists control overall fire opacity.
          float localAlpha = vAlpha * flameMask * uFireAlpha;

          col = vec4(fireCol, localAlpha);
        } else {
          // Other types (smoke/magic): soft round sprites using a radial alpha
          // falloff so they appear as glowing discs instead of hard-edged
          // squares.
          vec2 p = uv - vec2(0.5);
          float r = length(p);
          float edge = 0.5;
          float inner = 0.25;
          float radialMask = 1.0 - smoothstep(inner, edge, r);

          col = vec4(vColor.rgb, vColor.a * radialMask);
        }

        // Global alpha scale (scene bounds, enable flags, life cycle).
        if (vType != 0.0) {
          col.a *= vAlpha;
        }

        if (col.a <= 0.001) discard;
        gl_FragColor = col;
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    // Use additive blending so overlapping fire particles build intensity and
    // look like glowing embers; rain and smoke remain relatively low-alpha so
    // they don't blow out the scene.
    blending: THREE.AdditiveBlending
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
    // Fire tuning uniforms for UI control
    uniforms.fireAlpha = material.uniforms.uFireAlpha;
    uniforms.fireCoreBoost = material.uniforms.uFireCoreBoost;
    uniforms.fireHeight = material.uniforms.uFireHeight;
    uniforms.fireSize = material.uniforms.uFireSize;
    uniforms.globalWindInfluence = material.uniforms.uGlobalWindInfluence;
  }

  return material;
}
