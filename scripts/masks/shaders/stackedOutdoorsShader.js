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

import { GLSL_DEFRINGE_HELPERS } from './defringe-gLSL.js';



export { SKY_REACH_VERT as STACKED_OUTDOORS_VERT } from './skyReachShader.js';



/**

 * Combine one floor into the accumulated stack.

 *

 * Uniforms:

 *   tAccum      — previous stack (R=outdoorClass, A=validity)

 *   tFloorAlpha — this floor's tile coverage (scene-space, R)

 *   tOutdoors   — this floor's authored `_Outdoors` (scene-space, RGBA)

 *   uDefringe*  — from Tweakpane indoor/outdoor defringe strength

 */

export const STACKED_OUTDOORS_LAYER_FRAG = /* glsl */`

  precision highp float;



  uniform sampler2D tAccum;

  uniform sampler2D tFloorAlpha;

  uniform sampler2D tOutdoors;

  uniform float uUseOutdoorsAlphaCoverage;

  uniform float uHasRealFloorAlpha;

  uniform float uDefringeFootLo;

  uniform float uDefringeFootHi;

  uniform float uDefringeIndoorFootMin;

  uniform float uDefringeOdAlphaLo;

  uniform float uDefringeOdAlphaHi;

  uniform float uDefringeHardness;

  uniform float uDefringeEdgeOutdoorBias;



  varying vec2 vSceneUv;



  ${GLSL_DECODE_OUTDOOR_CLASS}

  ${GLSL_DEFRINGE_HELPERS}



  void main() {

    vec4 acc = texture2D(tAccum, vSceneUv);

    vec4 od = texture2D(tOutdoors, vSceneUv);

    float alpha = clamp(od.a, 0.0, 1.0);

    float fa = clamp(texture2D(tFloorAlpha, vSceneUv).r, 0.0, 1.0);

    float outdoorClass = acc.r;

    float w = 0.0;



    float footprint = defringeCoverage(fa, uDefringeFootLo, uDefringeFootHi, uDefringeHardness);

    if (uUseOutdoorsAlphaCoverage > 0.5) {

      outdoorClass = decodeOutdoorClass(od.rgb);

      float cov = defringeCoverage(alpha, uDefringeOdAlphaLo, uDefringeOdAlphaHi, uDefringeHardness);

      float valid = step(0.48, alpha);

      w = cov * valid;

      if (uHasRealFloorAlpha > 0.5) {

        w *= footprint;

        if (outdoorClass < 0.12 && footprint < uDefringeIndoorFootMin) {

          w = 0.0;

        }

      } else if (outdoorClass < 0.12 && alpha < uDefringeOdAlphaHi) {

        w = 0.0;

      }

      if (outdoorClass >= 0.85) {

        w = max(w, outdoorClass * step(0.85, outdoorClass));

      }

    } else if (footprint > 0.001) {

      outdoorClass = decodeOutdoorClass(od.rgb);

      w = footprint;

      if (outdoorClass >= 0.85) {

        w = max(w, outdoorClass);

      }

      if (outdoorClass < 0.12) {

        w *= smoothstep(uDefringeIndoorFootMin - 0.02, uDefringeIndoorFootMin, footprint);

        if (fa < uDefringeIndoorFootMin) {

          w = 0.0;

        }

      }

    }



    float mergeW = w;

    if (outdoorClass < 0.12) {

      mergeW = w * step(uDefringeIndoorFootMin, fa);

      float fringeZone = step(uDefringeFootLo, fa) * (1.0 - step(uDefringeIndoorFootMin, fa));

      if (fringeZone > 0.5) {

        float bleed = uDefringeEdgeOutdoorBias * (1.0 - smoothstep(uDefringeFootLo, uDefringeIndoorFootMin, fa));

        outdoorClass = max(outdoorClass, bleed);

        mergeW = max(mergeW, bleed);

      }

    }



    if (fa > uDefringeFootLo && outdoorClass < 0.12 && acc.r < 0.12 && mergeW < 0.55) {

      float punch = uDefringeEdgeOutdoorBias * step(uDefringeFootLo, fa);

      outdoorClass = max(outdoorClass, punch);

      mergeW = max(mergeW, punch * 0.95);

    }



    float outR = mix(acc.r, outdoorClass, mergeW);

    float outA = max(acc.a, mergeW);

    gl_FragColor = vec4(outR, outR, outR, outA);

  }

`;



/** Same stack logic as outdoors but reads derived per-floor `skyReach` masks. */

export const STACKED_SKY_REACH_LAYER_FRAG = /* glsl */`

  precision highp float;



  uniform sampler2D tAccum;

  uniform sampler2D tFloorAlpha;

  uniform sampler2D tSkyReach;

  uniform float uDefringeFootLo;

  uniform float uDefringeFootHi;

  uniform float uDefringeHardness;



  varying vec2 vSceneUv;



  ${GLSL_DEFRINGE_HELPERS}



  void main() {

    vec4 acc = texture2D(tAccum, vSceneUv);

    float fa = clamp(texture2D(tFloorAlpha, vSceneUv).r, 0.0, 1.0);

    float cov = defringeCoverage(fa, uDefringeFootLo, uDefringeFootHi, uDefringeHardness);

    vec4 sr = texture2D(tSkyReach, vSceneUv);

    float reach = mix(1.0, clamp(sr.r, 0.0, 1.0), clamp(sr.a, 0.0, 1.0));

    float w = cov;

    float outR = mix(acc.r, reach, w);

    float outA = max(acc.a, w);

    gl_FragColor = vec4(outR, outR, outR, outA);

  }

`;


