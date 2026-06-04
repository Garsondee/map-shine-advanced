/**
 * Final pass on the visible-floor stacked outdoors RT — erodes indoor halos at tile edges.
 *
 * @module masks/shaders/stackedOutdoorsPostShader
 */

import { GLSL_DEFRINGE_HELPERS } from './defringe-gLSL.js';

export { SKY_REACH_VERT as STACKED_OUTDOORS_POST_VERT } from './skyReachShader.js';

export const STACKED_OUTDOORS_POST_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tStack;
  uniform sampler2D tTopFloorAlpha;
  uniform float uHasTopFloorAlpha;
  uniform float uDefringeFootLo;
  uniform float uDefringeFootHi;
  uniform float uDefringeIndoorFootMin;
  uniform float uDefringeStackValidLo;
  uniform float uDefringeStackValidHi;
  uniform float uDefringeIndoorCovMin;
  uniform float uDefringeEdgeOutdoorBias;
  uniform float uDefringeHardness;

  varying vec2 vSceneUv;

  ${GLSL_DEFRINGE_HELPERS}

  void main() {
    vec4 st = texture2D(tStack, vSceneUv);
    float oc = clamp(st.r, 0.0, 1.0);
    float cov = clamp(st.a, 0.0, 1.0);

    float fa = 0.0;
    float footprint = 1.0;
    if (uHasTopFloorAlpha > 0.5) {
      fa = clamp(texture2D(tTopFloorAlpha, vSceneUv).r, 0.0, 1.0);
      footprint = defringeCoverage(fa, uDefringeFootLo, uDefringeFootHi, uDefringeHardness);
    }

    float validCov = defringeCoverage(cov, uDefringeStackValidLo, uDefringeStackValidHi, uDefringeHardness);

    // Tile-edge fringe: black RGB cutout / soft alpha is not solid indoor authorship.
    if (oc < 0.15) {
      if (uHasTopFloorAlpha > 0.5 && footprint < uDefringeIndoorFootMin) {
        float fringe = step(uDefringeFootLo, fa) * (1.0 - step(uDefringeIndoorFootMin, fa));
        float bleed = max(uDefringeEdgeOutdoorBias, fringe);
        oc = mix(oc, 1.0, bleed);
        cov = mix(cov, footprint, bleed * 0.85);
      } else if (validCov < uDefringeIndoorCovMin) {
        oc = 1.0;
        cov = 0.0;
      }
    }

    // Hard kill at max defringe: never leave indoor classification on partial footprint.
    if (uDefringeHardness > 0.92 && uHasTopFloorAlpha > 0.5 && oc < 0.12 && fa < uDefringeIndoorFootMin) {
      oc = 1.0;
      cov = min(cov, footprint);
    }

    gl_FragColor = vec4(oc, oc, oc, cov);
  }
`;
