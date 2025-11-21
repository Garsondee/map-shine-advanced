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
      uParticleTexture: { value: texture }
    },
    vertexShader: `
      uniform float uTime;
      uniform sampler2D uEmitterTex;
      uniform vec2 uEmitterTexSize;
      uniform float uParticlesPerEmitter;
      uniform float uEmitterCount;

      attribute float index;

      varying vec4 vColor;
      varying float vAlpha;

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

        if (emType == 0.0) {
          // FIRE
          vec3 up = vec3(0.0, 0.0, 1.0) * (localTime * 3.0);
          vec3 jitter = vec3(spread, spreadY, 0.0) * 0.5;
          pos = vec3(emX, emY, emZ) + up + jitter;

          vec3 fireColor = mix(vec3(1.0, 0.8, 0.1), vec3(1.0, 0.1, 0.0), pow(lifeProgress, 0.5));
          color = vec4(fireColor, 1.0);
          size = 1.0 - lifeProgress;
        } else if (emType == 1.0) {
          // SMOKE
          vec3 up = vec3(0.0, 0.0, 1.0) * (localTime * 1.5);
          vec3 drift = vec3(spread, spreadY, 0.0) * localTime;
          pos = vec3(emX, emY, emZ) + up + drift;

          color = vec4(0.5, 0.5, 0.5, 0.8);
          size = 0.5 + lifeProgress;
        } else if (emType == 2.0) {
          // RAIN
          vec3 fall = vec3(0.0, 0.0, -1.0) * (localTime * 20.0);
          vec3 startHeight = vec3(0.0, 0.0, 4.0);
          vec3 area = vec3(spread * 50.0, spreadY * 50.0, 0.0);
          pos = vec3(emX, emY, emZ) + startHeight + area + fall;

          color = vec4(0.6, 0.7, 1.0, 0.6);
          size = 0.5;
        } else {
          // MAGIC / SPARKLES
          float radius = localTime * 5.0;
          float theta = spread * 3.14159265;
          float phi = spreadY * 3.14159265;
          vec3 dir = vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));

          pos = vec3(emX, emY, emZ) + dir * radius;
          color = vec4(0.8, 0.3, 1.0, 1.0);
          size = 1.0 - lifeProgress;
        }

        // Visibility / Opacity
        float isActive = step(0.0, emRate - 0.0001);
        float fadeIn = clamp(lifeProgress * 10.0, 0.0, 1.0);
        float fadeOut = clamp((1.0 - lifeProgress) * 5.0, 0.0, 1.0);
        float alpha = fadeIn * fadeOut * isActive;

        vColor = color;
        vAlpha = alpha;

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = size * 50.0;
      }
    `,
    fragmentShader: `
      uniform sampler2D uParticleTexture;

      varying vec4 vColor;
      varying float vAlpha;

      void main() {
        vec2 uv = gl_PointCoord;
        vec4 tex = texture2D(uParticleTexture, uv);
        vec4 col = tex * vColor;
        col.a *= vAlpha;
        if (col.a <= 0.001) discard;
        gl_FragColor = col;
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  // Wire uniforms into the provided container so ParticleSystem.update()
  // can continue to drive time-based animation.
  if (uniforms) {
    uniforms.time = material.uniforms.uTime;
    uniforms.deltaTime = material.uniforms.uDeltaTime;
  }

  return material;
}
