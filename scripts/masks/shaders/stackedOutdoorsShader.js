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

import {
  GLSL_DECODE_OUTDOOR_CLASS,
} from '../outdoors-mask-decode.js';

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
  uniform float uUseOutdoorsAlphaCoverage;

  varying vec2 vSceneUv;

  ${GLSL_DECODE_OUTDOOR_CLASS}

  void main() {
    vec4 acc = texture2D(tAccum, vSceneUv);
    vec4 od = texture2D(tOutdoors, vSceneUv);
    float outdoorClass = decodeOutdoorClass(od.rgb);
    float cov = (uUseOutdoorsAlphaCoverage > 0.5)
      ? clamp(od.a, 0.0, 1.0)
      : clamp(texture2D(tFloorAlpha, vSceneUv).r, 0.0, 1.0);
    float covFromRgb = smoothstep(0.12, 0.88, outdoorClass);
    cov = max(cov, covFromRgb);
    float valid = max(step(0.5, clamp(od.a, 0.0, 1.0)), step(0.02, cov));
    float w = cov * valid;
    // Background-only upper bands often lack floorAlpha and use outdoors.a for
    // coverage. Deliberate alpha holes must not suppress a strong outdoor RGB
    // deck (white _Outdoors), or lower-floor indoor ToD bleeds through the stack.
    if (uUseOutdoorsAlphaCoverage > 0.5 && outdoorClass >= 0.85) {
      w = max(w, outdoorClass);
    } else if (outdoorClass >= 0.85) {
      w = max(w, covFromRgb);
    }
    float outR = mix(acc.r, outdoorClass, w);
    float outA = max(acc.a, w);
    gl_FragColor = vec4(outR, outR, outR, outA);
  }
`;

/** Same stack logic as outdoors but reads derived per-floor `skyReach` masks. */
export const STACKED_SKY_REACH_LAYER_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tAccum;
  uniform sampler2D tFloorAlpha;
  uniform sampler2D tSkyReach;

  varying vec2 vSceneUv;

  void main() {
    vec4 acc = texture2D(tAccum, vSceneUv);
    float cov = clamp(texture2D(tFloorAlpha, vSceneUv).r, 0.0, 1.0);
    vec4 sr = texture2D(tSkyReach, vSceneUv);
    float reach = mix(1.0, clamp(sr.r, 0.0, 1.0), clamp(sr.a, 0.0, 1.0));
    float w = cov;
    float outR = mix(acc.r, reach, w);
    float outA = max(acc.a, w);
    gl_FragColor = vec4(outR, outR, outR, outA);
  }
`;
