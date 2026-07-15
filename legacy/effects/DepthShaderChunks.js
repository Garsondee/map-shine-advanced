/**
 * @fileoverview Shared GLSL helper chunks for depth pass sampling and decoding.
 *
 * Any effect that needs to read the module-wide depth texture should import
 * these chunks and splice them into its shader source.
 *
 * ## Quick Start — Fragment Shader
 *   ${DepthShaderChunks.uniforms}
 *   ${DepthShaderChunks.linearize}
 *
 *   void main() {
 *     float deviceZ = texture2D(uDepthTexture, vUv).r;
 *     float linDepth = msa_linearizeDepth(deviceZ);
 *     float normDepth = msa_normalizedLinearDepth(deviceZ);
 *     ...
 *   }
 *
 * ## Quick Start — JavaScript (in render() or update())
 *   import { DepthShaderChunks } from './DepthShaderChunks.js';
 *   DepthShaderChunks.bindDepthPass(material.uniforms);
 *
 * ## Tile Z Layout (layers 1.0 apart, sort 0.001/step)
 *   ground(0) → ground-indicators(0.5) → BG(1.0) → FG(2.0)
 *   → TOKEN(3.0) → OVERHEAD(4.0) → effects(5.0+)
 *
 * ## Coordinate Notes
 *  - Main camera: near=1, far=5000. Ground at Z=1000, camera at Z=2000.
 *  - Depth pass camera: tight bounds (groundDist±200) for ~40 ULPs/sort step.
 *  - Device depth is non-linear (perspective projection).
 *  - linearizeDepth returns eye-space distance in world units.
 *  - normalizedLinearDepth returns [0,1] (near→far).
 *
 * @module effects/DepthShaderChunks
 */

export const DepthShaderChunks = {

  /**
   * Uniform declarations required by the depth sampling helpers.
   * Add these inside the shader's global scope (before main).
   */
  uniforms: /* glsl */ `
uniform sampler2D uDepthTexture;
uniform float uDepthEnabled;
uniform float uDepthCameraNear;
uniform float uDepthCameraFar;
uniform float uGroundDistance;
`,

  /**
   * Core depth linearization functions.
   * Prefix `msa_` (Map Shine Advanced) to avoid collisions with
   * Three.js built-in packing helpers.
   */
  linearize: /* glsl */ `
// Convert perspective device depth [0,1] → linear eye-space depth
float msa_linearizeDepth(float deviceDepth) {
  float z_ndc = deviceDepth * 2.0 - 1.0;
  return (2.0 * uDepthCameraNear * uDepthCameraFar) /
         (uDepthCameraFar + uDepthCameraNear - z_ndc * (uDepthCameraFar - uDepthCameraNear));
}

// Normalized linear depth in [0,1] range (0 = near plane, 1 = far plane)
float msa_normalizedLinearDepth(float deviceDepth) {
  float lin = msa_linearizeDepth(deviceDepth);
  return clamp((lin - uDepthCameraNear) / (uDepthCameraFar - uDepthCameraNear), 0.0, 1.0);
}

// Sample depth texture at a screen UV and return device depth
float msa_sampleDeviceDepth(vec2 screenUv) {
  return texture2D(uDepthTexture, screenUv).r;
}

// Sample depth texture and return linearized depth in world units
float msa_sampleLinearDepth(vec2 screenUv) {
  return msa_linearizeDepth(texture2D(uDepthTexture, screenUv).r);
}

// Compare: is the given linear depth in front of (closer than) the stored depth?
// Returns true if fragment is in front, false if behind.
bool msa_isInFrontOf(float fragmentLinearDepth, vec2 screenUv) {
  float storedLinear = msa_sampleLinearDepth(screenUv);
  return fragmentLinearDepth < storedLinear;
}

// Tile overlay occlusion: discard fragment if a closer surface exists.
// Tolerance 0.0005 world units: passes same-tile (precision error ~0.00003),
// rejects adjacent sort keys (gap 0.001 > 0.0005).
// Usage: if (msa_isOccluded(vLinearDepth, screenUv)) discard;
bool msa_isOccluded(float fragmentLinearDepth, vec2 screenUv) {
  float storedLinear = msa_sampleLinearDepth(screenUv);
  return storedLinear < (fragmentLinearDepth - 0.0005);
}

// Depth-based fog modulation: returns 0..1 factor to multiply fog amount by.
// Ground (ratio~1.0) → 1.0 (full fog), roofs (ratio~0.996) → reduced fog.
// strength controls the blend from no modulation (0) to full modulation (1).
float msa_depthFogFactor(vec2 screenUv, float strength) {
  float deviceDepth = texture2D(uDepthTexture, screenUv).r;
  if (deviceDepth >= 0.9999) return 1.0; // background — full fog
  float linDepth = msa_linearizeDepth(deviceDepth);
  float depthRatio = linDepth / max(uGroundDistance, 1.0);
  return mix(1.0, smoothstep(0.990, 1.001, depthRatio), strength);
}
`,

  /**
   * Depth-based soft edge factor for effects that want gradual
   * falloff near depth boundaries (contact shadows, fog edges, etc.).
   */
  softEdge: /* glsl */ `
// Soft depth edge — returns 0 at the surface, ramping to 1 over 'thickness' world units
float msa_depthSoftEdge(float fragmentLinearDepth, vec2 screenUv, float thickness) {
  float storedLinear = msa_sampleLinearDepth(screenUv);
  float diff = storedLinear - fragmentLinearDepth;
  return clamp(diff / max(thickness, 0.001), 0.0, 1.0);
}
`,

  // ─── JavaScript helpers ──────────────────────────────────────────────────

  /**
   * Bind the depth pass texture and camera uniforms to a material's uniform set.
   * Call this in render() or update() for any effect that uses depth pass data.
   *
   * Expects the material to have these uniforms (created at material init time):
   *   uDepthTexture, uDepthEnabled, uDepthCameraNear, uDepthCameraFar
   * And optionally: uGroundDistance
   *
   * @param {Object} uniforms - The material's uniforms object
   * @param {Object} [options] - Optional overrides
   * @param {number} [options.groundDistance] - Override ground distance value
   * @returns {boolean} true if depth pass is available and bound
   */
  bindDepthPass(uniforms) {
    const dpm = window.MapShine?.depthPassManager;
    const depthTex = (dpm && dpm.isEnabled()) ? dpm.getDepthTexture() : null;
    const hasDepth = !!depthTex;

    if (uniforms.uDepthEnabled) uniforms.uDepthEnabled.value = hasDepth ? 1.0 : 0.0;
    if (uniforms.uDepthTexture) uniforms.uDepthTexture.value = depthTex;

    if (hasDepth && dpm) {
      if (uniforms.uDepthCameraNear) uniforms.uDepthCameraNear.value = dpm.getDepthNear();
      if (uniforms.uDepthCameraFar) uniforms.uDepthCameraFar.value = dpm.getDepthFar();
      if (uniforms.uGroundDistance) {
        uniforms.uGroundDistance.value = window.MapShine?.sceneComposer?.groundDistance ?? 1000.0;
      }
    }

    return hasDepth;
  },

  /**
   * Create the standard set of depth pass uniforms for a new ShaderMaterial.
   * Spread into your uniforms object at material creation time.
   *
   * @param {typeof THREE} THREE - Three.js namespace
   * @returns {Object} Uniform entries for uDepthTexture, uDepthEnabled, etc.
   */
  createUniforms() {
    return {
      uDepthTexture:   { value: null },
      uDepthEnabled:   { value: 0.0 },
      uDepthCameraNear: { value: 800.0 },
      uDepthCameraFar:  { value: 1200.0 },
      uGroundDistance:  { value: 1000.0 }
    };
  }
};
