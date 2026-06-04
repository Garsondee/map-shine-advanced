/**
 * Shared GLSL helpers for indoor/outdoor defringing (tile footprint gate).
 * @module masks/shaders/defringe-glsl
 */

export const GLSL_DEFRINGE_HELPERS = /* glsl */`
float defringeCoverage(float raw, float lo, float hi, float hardness) {
  float soft = smoothstep(lo, hi, clamp(raw, 0.0, 1.0));
  float mid = mix(lo, hi, 0.5);
  float hard = step(mid, raw);
  return mix(soft, hard, clamp(hardness, 0.0, 1.0));
}
`;
