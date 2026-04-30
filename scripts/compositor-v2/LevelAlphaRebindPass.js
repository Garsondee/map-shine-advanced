/**
 * @fileoverview LevelAlphaRebindPass — clamps a per-level post-chain RT's
 * alpha channel to the authored solidity alpha of the source floor.
 *
 * Architectural rationale:
 *
 *   The per-level pipeline draws a floor's content into a sceneRT via
 *   `FloorRenderBus.renderFloorRangeTo(...)` with `clearAlpha: 0`. The
 *   sceneRT's alpha channel therefore encodes the floor's AUTHORED
 *   solidity — opaque wherever tiles/bg paint with alpha, transparent
 *   elsewhere. Downstream post-passes (lighting, sky, CC, filter, water,
 *   fog, bloom, sharpen, artistic effects) are each written to preserve
 *   input alpha, but in practice an effect can still widen alpha (e.g.
 *   water's `waterOutA = max(base.a, inside)`) or a shader may have a
 *   subtle bug that flattens transparent holes to opaque. Any single
 *   failure cascades into the LevelCompositePass and hides lower floors
 *   under what should be a hole.
 *
 *   This pass runs at the very end of each per-level pipeline and normally
 *   clamps output alpha toward `min(postChain.a, authored.a)` so pixels the
 *   author marked transparent stay transparent for upper-floor holes.
 *
 *   Exception: when the post chain **raises** alpha above authored (e.g.
 *   WaterEffectV2 uses `max(base.a, inside)` over river tiles that are
 *   alpha-0 holes), blindly taking `min` would force alpha back to 0.
 *   LevelCompositePass then computes straight-alpha source-over as
 *   `base.rgb * base.a` wherever the upper slice is transparent, which
 *   **zeros water RGB** when looking through a bridge — water appears only on
 *   single-floor views. If post alpha clearly exceeds authored, keep the
 *   post alpha so widened coverage survives compositing.
 *
 *   This gives LevelCompositePass an authoritative "this is where the
 *   floor is solid" signal that mirrors the user's authored content and
 *   any derived suffix masks (`_Outdoors_N`, `_Water_N`, ...), so holes
 *   in upper-floor art reliably reveal lower-floor content beneath.
 *
 * @module compositor-v2/LevelAlphaRebindPass
 */

import { createLogger } from '../core/log.js';

const log = createLogger('LevelAlphaRebindPass');

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * tDiffuse — post-chain RT (RGB + widened alpha).
 * tAuthoredAlpha — authoritative solidity: the floor's sceneRT right
 *   after `renderFloorRangeTo`, whose alpha channel carries the
 *   authored content alpha. RGB is ignored.
 *
 * Output alpha is usually min(diffuse.a, authored.a). When diffuse.a is
 * meaningfully above authored (water and similar passes widening coverage),
 * keep diffuse.a so lower-floor water stays visible through upper holes.
 */
const REBIND_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tAuthoredAlpha;
  uniform float uAllowAlphaWiden;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tDiffuse, vUv);
    float authored = texture2D(tAuthoredAlpha, vUv).a;
    float outA = min(c.a, authored);
    // Epsilon: ignore tiny filtering deltas; water widen is much larger.
    // Restrict widened-alpha preservation to known passes (water), otherwise
    // VFX alpha (e.g. fire) can flatten holes and hide lower floors.
    if (uAllowAlphaWiden > 0.5 && c.a > authored + 0.02) {
      outA = c.a;
    }
    gl_FragColor = vec4(c.rgb, clamp(outA, 0.0, 1.0));
  }
`;

export class LevelAlphaRebindPass {
  constructor() {
    /** @type {THREE.Scene|null} */ this._scene = null;
    /** @type {THREE.OrthographicCamera|null} */ this._camera = null;
    /** @type {THREE.ShaderMaterial|null} */ this._material = null;
    /** @type {THREE.Mesh|null} */ this._quad = null;
    this._initialized = false;
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tAuthoredAlpha: { value: null },
        uAllowAlphaWiden: { value: 0.0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: REBIND_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._material.toneMapped = false;

    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);

    this._initialized = true;
    log.debug('LevelAlphaRebindPass initialized');
  }

  /**
   * Render `inputRT` into `outputRT` with alpha clamped to
   * `authoredAlphaRT.alpha`.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputRT - post-chain output
   * @param {THREE.WebGLRenderTarget} authoredAlphaRT - raw sceneRT for this level
   * @param {THREE.WebGLRenderTarget} outputRT - destination
   * @param {{allowAlphaWiden?: boolean}} [options]
   * @returns {boolean} true on success
   */
  render(renderer, inputRT, authoredAlphaRT, outputRT, options = {}) {
    if (!this._initialized || !renderer || !inputRT || !authoredAlphaRT || !outputRT) return false;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    this._material.uniforms.tDiffuse.value = inputRT.texture;
    this._material.uniforms.tAuthoredAlpha.value = authoredAlphaRT.texture;
    this._material.uniforms.uAllowAlphaWiden.value = options?.allowAlphaWiden === true ? 1.0 : 0.0;

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.render(this._scene, this._camera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    return true;
  }

  dispose() {
    try { this._material?.dispose(); } catch (_) {}
    try { this._quad?.geometry?.dispose(); } catch (_) {}
    this._scene = null;
    this._camera = null;
    this._material = null;
    this._quad = null;
    this._initialized = false;
    log.debug('LevelAlphaRebindPass disposed');
  }
}
