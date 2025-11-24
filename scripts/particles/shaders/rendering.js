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
      uFireMap: { value: null },
      uFireMaskEnabled: { value: 0.0 },
      uFireMaskThreshold: { value: 0.9 },
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
      uniform sampler2D uFireMap;
      uniform float uFireMaskEnabled;
      uniform float uFireMaskThreshold;
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
        
        // Fire Mask factor (applied later after computing world-space pos)
        float fireMaskFactor = 1.0;

        vec3 effectiveWind = uWindVector * outdoorFactor * uGlobalWindInfluence;

        if (emType == 0.0) {
          // FIRE (global mask-driven variant)
          // - Emitter is centered on the scene and param1/2 encode the scene size.
          // - We generate a uniform random XY jitter over the scene rectangle and
          //   then use a separate texture lookup (uFireMap) to decide which
          //   particles are actually visible based on the authored _Fire mask.
          //
          // This keeps the CPU emitter simple (just a big rectangle) and pushes
          // the spawn filtering entirely into the vertex shader.
          // Param1: Scene width for global emitter
          // Param2: Scene height for global emitter
          // Use half-extent so jitter covers exactly [sceneX, sceneX+sceneWidth] etc.
          float radiusX = (emParam1 > 0.0) ? emParam1 * 0.5 : 20.0;
          float radiusY = (emParam2 > 0.0) ? emParam2 * 0.5 : radiusX;

          // Zero-velocity: particles sit on the ground plane with simple XY jitter
          vec3 jitter = vec3(spread * radiusX, spreadY * radiusY, 0.0);
          pos = vec3(emX, emY, 0.0) + jitter;

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
        } else if (emType == 4.0) {
          // SPARKS
          // Ballistic motion: Up + Gravity
          
          float radius = (emParam1 > 0.0) ? emParam1 : 10.0;
          
          // Initial velocity (Random Up cone)
          vec3 v0 = vec3(spread * 20.0, spreadY * 20.0, 150.0 + randSeed * 100.0);
          vec3 gravity = vec3(0.0, 0.0, -80.0); // Drag/Gravity
          
          // Position = p0 + v0*t + 0.5*a*t^2
          vec3 ballistic = v0 * localTime + 0.5 * gravity * localTime * localTime;
          
          // Wind influence (sparks are light)
          vec3 windDrift = effectiveWind * localTime * 2.0;
          
          // Turbulent swirl
          float swirlFreq = 5.0;
          vec3 swirl = vec3(sin(localTime * swirlFreq + randSeed * 10.0), cos(localTime * swirlFreq), 0.0) * 10.0 * localTime;

          pos = vec3(emX, emY, emZ) + ballistic + windDrift + swirl;
          
          // Color: Bright Yellow/White -> Red -> Off
          vec3 cSpark = mix(vec3(1.0, 0.9, 0.5), vec3(1.0, 0.2, 0.0), lifeProgress);
          color = vec4(cSpark, 1.0);
          
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

        // Sample Fire Mask using particle world position (Fire only).
        //
        // World -> UV mapping:
        //   - uSceneBounds = vec4(sceneX, sceneY, sceneWidth, sceneHeight)
        //   - Particles live in the same world space as the base plane, so we
        //     remap pos.xy into [0,1] relative to the scene rect and flip V to
        //     match the texture orientation used by the ground plane.
        //
        // Important gotcha: many authoring tools export fully opaque alpha
        // (A=1) even for black pixels. If we used max(R,G,B,A) we would get
        // fireMaskFactor=1 everywhere. We therefore only look at RGB when
        // constructing fireMaskFactor.
        //
        // Debugging: uFireMaskThreshold<0 enables a special mode that colors
        // particles by (u,v,mask) so UV alignment and mask values can be
        // inspected directly in-scene.
        if (emType == 0.0) {
            float u = (pos.x - uSceneBounds.x) / uSceneBounds.z;
            float v = (pos.y - uSceneBounds.y) / uSceneBounds.w;
            v = 1.0 - v; // Flip V to match texture orientation (consistent with roof mask sampling)
            vec2 mapUV = clamp(vec2(u, v), 0.0, 1.0);

            // Fire mask: use RGB luminance only. Many authoring tools export
            // fully opaque alpha (1.0) even for black pixels, which would make
            // a max(R,G,B,A) test always return 1.0. By ignoring alpha here we
            // ensure that black areas (RGB≈0) correctly produce a 0.0 mask.
            vec4 maskSample = texture2D(uFireMap, mapUV);
            fireMaskFactor = max(max(maskSample.r, maskSample.g), maskSample.b);

            // Debug mode: when threshold is negative, visualize UVs instead of
            // normal fire color so we can inspect coordinate mapping.
            if (uFireMaskThreshold < 0.0) {
              color = vec4(mapUV.x, mapUV.y, fireMaskFactor, 1.0);
            }
        }

        // Visibility / Opacity
        float isActive = step(0.0, emRate - 0.0001);
        float fadeIn = clamp(lifeProgress * 10.0, 0.0, 1.0);
        // Note: Some types handle their own fadeOut (fire)
        float fadeOut = (emType == 0.0 || emType == 4.0) ? 1.0 : clamp((1.0 - lifeProgress) * 5.0, 0.0, 1.0);
        
        // Clipping: Check if inside scene bounds
        float inBoundsX = step(uSceneBounds.x, pos.x) * step(pos.x, uSceneBounds.x + uSceneBounds.z);
        float inBoundsY = step(uSceneBounds.y, pos.y) * step(pos.y, uSceneBounds.y + uSceneBounds.w);
        float inBounds = inBoundsX * inBoundsY;

        float alpha = fadeIn * fadeOut * isActive * inBounds;
        
        // DEBUG: Visualize fire mask as grayscale for Fire particles when
        // threshold is non-negative (normal masking mode). When threshold is
        // negative, UV debug coloring above takes precedence.
        if (emType == 0.0 && uFireMaskThreshold >= 0.0) {
          color = vec4(fireMaskFactor, fireMaskFactor, fireMaskFactor, 1.0);
        }

        // Apply Fire Mask cutoff to Fire (0) only when enabled and when
        // threshold is non-negative. Negative threshold is reserved for
        // debugging the UV/mask mapping so that authors can see the raw
        // fireMaskFactor without culling.
        if (uFireMaskEnabled > 0.5 && uFireMaskThreshold >= 0.0 && emType == 0.0) {
           float maskStep = step(uFireMaskThreshold, fireMaskFactor);
           alpha *= maskStep;
           if (maskStep < 0.5) {
             size = 0.0;
           }
        }

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
          // Other types (fire/smoke/magic): use texture as a soft alpha mask only.
          // This avoids inheriting any base texture tint (e.g. blue) and lets the
          // vertex shader fully control fire/smoke colors.
          vec4 tex = texture2D(uParticleTexture, uv);
          col = vec4(vColor.rgb, vColor.a * tex.a);
        }

        col.a *= vAlpha;
        if (col.a <= 0.001) discard;
        gl_FragColor = col;
      }
    `,
    transparent: true,
    depthWrite: false,
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
    uniforms.fireMap = material.uniforms.uFireMap;
    uniforms.fireMaskEnabled = material.uniforms.uFireMaskEnabled;
    uniforms.fireMaskThreshold = material.uniforms.uFireMaskThreshold;
    // Expose debug rain angle uniform for external control
    uniforms.rainAngle = material.uniforms.uRainAngle;
  }

  return material;
}
