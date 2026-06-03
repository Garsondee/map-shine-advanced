/**
 * Shared GLSL for fullscreen passes that run after ColorCorrection on the merged composite.
 *
 * CC may output linear HDR when tone mapping is disabled (toneMapping = 0). Stylize
 * effects (sepia, halftone, invert, …) assume display-referred ~0–1 input; without
 * this soft shoulder they blow out once scene illumination rises.
 *
 * @module compositor-v2/msa-post-stylize-input.glsl
 */

export const MSA_POST_STYLIZE_INPUT_GLSL = /* glsl */`
  /** Soft compress for post-CC stylize passes (Reinhard-style shoulder above ~1.35). */
  vec3 msaPostStylizePrepareRgb(vec3 c) {
    c = max(c, vec3(0.0));
    float peak = max(max(c.r, c.g), c.b);
    if (peak <= 1.35) return c;
    return c / (vec3(1.0) + c * 0.32);
  }
`;
