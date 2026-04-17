/**
 * @fileoverview Shaders used to derive the per-floor `skyReach` mask.
 *
 * `skyReach_N = outdoors_N ∧ ¬union(floorAlpha_k for k > N)`
 *
 * Composition runs in two fullscreen passes:
 *
 *   1. Overhead accumulator pass. Start with a black RT, then for every upper
 *      floor `k > N` render a fullscreen quad with {@link OVERHEAD_ACCUM_FRAG}
 *      under `MaxEquation` blending. Each draw samples that floor's
 *      `floorAlpha` texture in scene UV space and writes `max(prev, upperAlpha)`.
 *      The result is a greyscale union of all opaque coverage above floor N.
 *
 *   2. Sky-reach pass. Render a fullscreen quad with {@link SKY_REACH_FRAG}:
 *      `skyReach = outdoors * (1 - overheadAccum)`. The output RT is then
 *      cached on the floor bundle under the id `'skyReach'`.
 *
 * Both shaders assume a full-screen [-1,1] NDC quad and derive `vSceneUv` in
 * the vertex shader so we don't have to supply a dedicated mesh per floor.
 *
 * @module masks/shaders/skyReachShader
 */

/**
 * Minimal fullscreen vertex shader: forwards `position.xy` as NDC and emits
 * the scene UV for fragment sampling.
 */
export const SKY_REACH_VERT = /* glsl */`
  precision highp float;

  attribute vec3 position;
  varying vec2 vSceneUv;

  void main() {
    vSceneUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Overhead-accumulator fragment shader. Samples one upper-floor `floorAlpha`
 * texture and writes the sampled alpha into all channels. The caller is
 * expected to set `CustomBlending` with `MaxEquation` so successive draws
 * accumulate max(previous, sample).
 *
 * Uniforms:
 *   tUpperAlpha — a single upper floor's `floorAlpha` RT (scene-space, R channel).
 */
export const OVERHEAD_ACCUM_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tUpperAlpha;
  varying vec2 vSceneUv;

  void main() {
    float a = texture2D(tUpperAlpha, vSceneUv).r;
    gl_FragColor = vec4(a, a, a, a);
  }
`;

/**
 * Sky-reach fragment shader. Reads the floor's authored `outdoors` mask and
 * the previously accumulated `overheadAccum` texture, then outputs
 * `outdoors * (1 - overheadAccum)` as greyscale.
 *
 * If `uHasOverhead == 0.0` the output equals the outdoors mask verbatim — used
 * for the topmost floor or when no upper `floorAlpha` exists yet.
 *
 * Uniforms:
 *   tOutdoors      — authored per-floor `_Outdoors` RT (scene-space, R channel).
 *   tOverheadAccum — union of upper-floor `floorAlpha` RTs (scene-space, R).
 *   uHasOverhead   — 1.0 if tOverheadAccum is meaningful, 0.0 otherwise.
 */
export const SKY_REACH_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tOutdoors;
  uniform sampler2D tOverheadAccum;
  uniform float uHasOverhead;

  varying vec2 vSceneUv;

  void main() {
    float outdoors = texture2D(tOutdoors, vSceneUv).r;
    float overhead = (uHasOverhead > 0.5)
      ? clamp(texture2D(tOverheadAccum, vSceneUv).r, 0.0, 1.0)
      : 0.0;
    float reach = outdoors * (1.0 - overhead);
    gl_FragColor = vec4(reach, reach, reach, reach);
  }
`;
