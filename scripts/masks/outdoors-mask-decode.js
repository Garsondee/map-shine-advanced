/**
 * Shared indoor/outdoor classification from `_Outdoors` mask samples.
 * Keep JS (probes, diagnostics) and GLSL (CC, stack, debug overlay) in sync.
 *
 * @module masks/outdoors-mask-decode
 */

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number} 0 = indoor, 1 = outdoor
 */
export function decodeOutdoorClassFromRgb(r, g, b) {
  const outdoorRaw = Math.max(0, Math.min(1, Math.max(r, g, b)));
  if (outdoorRaw <= 0.1) return 0;
  if (outdoorRaw >= 0.9) return 1;
  const tMid = Math.max(0, Math.min(1, (outdoorRaw - 0.18) / (0.82 - 0.18)));
  const outdoorMid = tMid * tMid * (3 - 2 * tMid);
  return outdoorMid;
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} a
 * @returns {number} 0..1 indoor weight for Camera Grade ToD
 */
export function estimateIndoorWeightFromRgba(r, g, b, a) {
  const valid = a >= 0.5 ? 1 : 0;
  const outdoorClass = decodeOutdoorClassFromRgb(r, g, b);
  const indoorSignal = Math.max(0, Math.min(1, 1 - outdoorClass));
  const t = Math.max(0, Math.min(1, (indoorSignal - 0.2) / (0.75 - 0.2)));
  const indoorW = t * t * (3 - 2 * t);
  return indoorW * valid;
}

/** GLSL: outdoor class from mask RGB (no alpha). */
export const GLSL_DECODE_OUTDOOR_CLASS = /* glsl */`
float decodeOutdoorClass(vec3 rgb) {
  float outdoorRaw = clamp(max(rgb.r, max(rgb.g, rgb.b)), 0.0, 1.0);
  float outdoorMid = smoothstep(0.18, 0.82, outdoorRaw);
  return (outdoorRaw <= 0.10) ? 0.0 : ((outdoorRaw >= 0.90) ? 1.0 : outdoorMid);
}
`;

/** GLSL: indoor weight for ToD (RGB classify, alpha = validity). */
export const GLSL_DECODE_INDOOR_WEIGHT = /* glsl */`
float decodeIndoorWeightFromMask(vec4 od) {
  float valid = step(0.5, clamp(od.a, 0.0, 1.0));
  float outdoorClass = decodeOutdoorClass(od.rgb);
  float indoorSignal = clamp(1.0 - outdoorClass, 0.0, 1.0);
  return smoothstep(0.20, 0.75, indoorSignal) * valid;
}
`;

/** GLSL: legacy full sample decode (outdoor strength with validity gate). */
export const GLSL_DECODE_OUTDOORS_MASK_SAMPLE = /* glsl */`
float decodeOutdoorsMaskSample(vec4 od) {
  float outdoorClass = decodeOutdoorClass(od.rgb);
  float outdoorsAlphaValid = step(0.5, clamp(od.a, 0.0, 1.0));
  return mix(1.0, outdoorClass, outdoorsAlphaValid);
}
`;
