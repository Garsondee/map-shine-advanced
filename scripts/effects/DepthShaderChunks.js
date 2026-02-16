/**
 * @fileoverview Shared GLSL helper chunks for depth pass sampling and decoding.
 *
 * Any effect that needs to read the module-wide depth texture should import
 * these chunks and splice them into its shader source.
 *
 * Usage in a fragment shader:
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
 * Coordinate notes:
 *  - Camera near=1, far=5000.  Ground at Z=1000, camera at Z=2000.
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
uniform float uDepthCameraNear;
uniform float uDepthCameraFar;
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
// Returns 1.0 if fragment is in front, 0.0 if behind.
bool msa_isInFrontOf(float fragmentLinearDepth, vec2 screenUv) {
  float storedLinear = msa_sampleLinearDepth(screenUv);
  return fragmentLinearDepth < storedLinear;
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
};
