/**
 * @fileoverview Shared GLSL helpers for "is this fragment inside the
 * scene rect?" early-outs. Use as a fallback for passes that cannot be
 * scissored at the JS level (e.g. when SceneRectScissor is disabled,
 * when a pass is opted-out of the wrapper, or when an effect needs a
 * different "outside" behavior than the cleared black surrounding the
 * scissored region).
 *
 * Primary mechanism is hardware scissor — see
 * {@link module:compositor-v2/SceneRectScissor}. This module exists
 * only as a backup path. Most effects do NOT need to import it.
 *
 * Two coord-frame helpers are exposed because effects historically use
 * two different conventions in this codebase:
 *
 *   - **Foundry-world**: a `vec4 uSceneBounds = (sceneX, sceneY, sceneW, sceneH)`
 *     in Foundry coords (top-left origin). Fragments compute their
 *     world position via `uViewBounds` + `uSceneDimensions`. Used by
 *     {@link AtmosphericFogEffectV2}, {@link MaskDebugOverlayPass},
 *     {@link FilterEffectV2}, {@link DistortionManager}, etc.
 *
 *   - **Plane-UV**: a `vec4 uSceneUVRect = (uMin, vMin, uW, vH)` that
 *     maps the full-canvas plane's UV [0,1] to the scene rect's UV
 *     sub-region. Used by {@link FogOfWarEffectV2} (plane spans the
 *     full Foundry canvas including padding).
 *
 * Usage:
 *
 *   import { SCENE_RECT_GUARD_GLSL_FOUNDRY, SCENE_RECT_GUARD_GLSL_UV }
 *     from '../scene-rect-guard.glsl.js';
 *
 *   const fragmentShader = `
 *     ${SCENE_RECT_GUARD_GLSL_FOUNDRY}
 *     // ...
 *     void main() {
 *       vec2 foundryPos = ...;
 *       if (msaSceneRectGuardFoundry(foundryPos, uSceneBounds)) {
 *         gl_FragColor = passthroughColor;
 *         return;
 *       }
 *       // ...
 *     }
 *   `;
 *
 * @module compositor-v2/scene-rect-guard.glsl
 */

/**
 * GLSL helper for Foundry-world coords.
 * Returns `true` when `(foundryX, foundryY)` is OUTSIDE the rect.
 *
 *   uSceneBounds = vec4(sceneX, sceneY, sceneW, sceneH)
 */
export const SCENE_RECT_GUARD_GLSL_FOUNDRY = /* glsl */ `
  bool msaSceneRectGuardFoundry(vec2 foundryPos, vec4 sceneBounds) {
    float minX = sceneBounds.x;
    float minY = sceneBounds.y;
    float maxX = sceneBounds.x + sceneBounds.z;
    float maxY = sceneBounds.y + sceneBounds.w;
    return (foundryPos.x < minX) || (foundryPos.x > maxX)
        || (foundryPos.y < minY) || (foundryPos.y > maxY);
  }
`;

/**
 * GLSL helper for plane-UV coords (full-canvas plane → scene-rect UV).
 * Returns `true` when `vUv` is OUTSIDE the scene rect's UV sub-region.
 *
 *   uSceneUVRect = vec4(uMin, vMin, uW, vH)
 *
 * Also usable on a sceneUv computed from `vUv`:
 *   `vec2 sceneUv = (vUv - uSceneUVRect.xy) / uSceneUVRect.zw;`
 *   `msaSceneRectGuardSceneUv(sceneUv)` returns true when sceneUv is outside [0,1].
 */
export const SCENE_RECT_GUARD_GLSL_UV = /* glsl */ `
  bool msaSceneRectGuardUv(vec2 vUv, vec4 sceneUVRect) {
    vec2 sceneUv = (vUv - sceneUVRect.xy) / max(sceneUVRect.zw, vec2(1e-5));
    return sceneUv.x < 0.0 || sceneUv.x > 1.0
        || sceneUv.y < 0.0 || sceneUv.y > 1.0;
  }

  bool msaSceneRectGuardSceneUv(vec2 sceneUv) {
    return sceneUv.x < 0.0 || sceneUv.x > 1.0
        || sceneUv.y < 0.0 || sceneUv.y > 1.0;
  }
`;

/**
 * Convenience: both helpers as a single string for shaders that may
 * call either form.
 */
export const SCENE_RECT_GUARD_GLSL_ALL =
  SCENE_RECT_GUARD_GLSL_FOUNDRY + '\n' + SCENE_RECT_GUARD_GLSL_UV;
