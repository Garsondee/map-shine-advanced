/**
 * Shared GLSL for fullscreen passes that run after ColorCorrection on the merged composite.
 *
 * CC may output linear HDR when tone mapping is disabled (toneMapping = 0). Stylize
 * effects (sepia, halftone, invert, …) assume display-referred ~0–1 input; without
 * compressing highs they wash out once scene illumination rises.
 *
 * IMPORTANT: use a smooth shoulder only — a hard peak threshold creates a visible dark
 * ring at bloom / candle / window halos (neighbors cross the knee at different peaks).
 *
 * @module compositor-v2/msa-post-stylize-input.glsl
 */

export const MSA_POST_STYLIZE_INPUT_GLSL = /* glsl */`
  /** Soft compress for post-CC stylize passes; continuous across all peaks. */
  vec3 msaPostStylizePrepareRgb(vec3 c) {
    c = max(c, vec3(0.0));
    float peak = max(max(c.r, c.g), c.b);
    vec3 compressed = c / (vec3(1.0) + c * 0.28);
    float blend = smoothstep(0.55, 1.75, peak);
    return mix(c, compressed, blend);
  }
`;
