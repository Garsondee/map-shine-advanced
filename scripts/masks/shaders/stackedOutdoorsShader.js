/**
 * @fileoverview Shaders to build a scene-space stacked `_Outdoors` mask for multi-floor CC.
 *
 * For each scene UV, the topmost floor with `floorAlpha` coverage wins. Layers are
 * composited bottom→top so upper-floor tiles replace lower-floor classification.
 *
 * Output RT: RGB = outdoor class (0 indoor … 1 outdoor), A = authored validity.
 *
 * @module masks/shaders/stackedOutdoorsShader
 */

export { SKY_REACH_VERT as STACKED_OUTDOORS_VERT } from './skyReachShader.js';

/**
 * Combine one floor into the accumulated stack.
 *
 * Uniforms:
 *   tAccum      — previous stack (R=outdoorClass, A=validity)
 *   tFloorAlpha — this floor's tile coverage (scene-space, R)
 *   tOutdoors   — this floor's authored `_Outdoors` (scene-space, RGBA)
 */
export const STACKED_OUTDOORS_LAYER_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tAccum;
  uniform sampler2D tFloorAlpha;
  uniform sampler2D tOutdoors;

  varying vec2 vSceneUv;

  float decodeOutdoorClass(vec4 od) {
    float outdoorRaw = clamp(max(od.r, max(od.g, od.b)), 0.0, 1.0);
    float outdoorMid = smoothstep(0.18, 0.82, outdoorRaw);
    return (outdoorRaw <= 0.10) ? 0.0 : ((outdoorRaw >= 0.90) ? 1.0 : outdoorMid);
  }

  void main() {
    vec4 acc = texture2D(tAccum, vSceneUv);
    float cov = clamp(texture2D(tFloorAlpha, vSceneUv).r, 0.0, 1.0);
    vec4 od = texture2D(tOutdoors, vSceneUv);
    float valid = step(0.5, clamp(od.a, 0.0, 1.0));
    float outdoorClass = decodeOutdoorClass(od);
    float w = cov * valid;
    float outR = mix(acc.r, outdoorClass, w);
    float outA = max(acc.a, w);
    gl_FragColor = vec4(outR, outR, outR, outA);
  }
`;
