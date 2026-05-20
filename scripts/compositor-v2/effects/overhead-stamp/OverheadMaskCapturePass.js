/**
 * @fileoverview Packed roof/rain mask capture targets and legacy channel sync.
 *
 * Screen packed RT (RGBA): R=visibility, G=block, B=restrictLight, A=rain visibility.
 * Guard packed RT (RGBA): R=roof caster, B=fluid (when enabled).
 */

import { ChannelExtractPass } from './ChannelExtractPass.js';
import { SceneCaptureScope } from './SceneCaptureScope.js';

export class OverheadMaskCapturePass {
  constructor() {
    this.roofPackedScreenTarget = null;
    this.roofPackedGuardTarget = null;
    this._channelExtract = new ChannelExtractPass();
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  ensureTargets(width, height) {
    const THREE = window.THREE;
    if (!THREE || !width || !height) return;
    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    for (const key of ['roofPackedScreenTarget', 'roofPackedGuardTarget']) {
      if (!this[key]) this[key] = new THREE.WebGLRenderTarget(width, height, opts);
      else this[key].setSize(width, height);
    }
  }

  /**
   * Copy legacy single-channel RTs into packed targets for consumers that sample packed data.
   * Legacy getters remain authoritative for LightingEffectV2 until fully migrated.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {object} legacy
   */
  syncPackedFromLegacy(renderer, legacy) {
    if (!renderer) return;
    const packed = this.roofPackedScreenTarget;
    if (!packed) return;
    const w = packed.width;
    const h = packed.height;
    this.ensureTargets(w, h);
    if (legacy.roofVisibilityTarget?.texture) {
      this._packChannel(renderer, legacy.roofVisibilityTarget.texture, packed, 0);
    }
    if (legacy.roofBlockTarget?.texture) {
      this._packChannel(renderer, legacy.roofBlockTarget.texture, packed, 1);
    }
    if (legacy.roofRestrictLightTarget?.texture) {
      this._packChannel(renderer, legacy.roofRestrictLightTarget.texture, packed, 2);
    }
    if (legacy.rainOcclusionVisibilityTarget?.texture) {
      this._packChannel(renderer, legacy.rainOcclusionVisibilityTarget.texture, packed, 3);
    }
    const guard = this.roofPackedGuardTarget;
    if (guard && legacy.roofTarget?.texture) {
      this._packChannel(renderer, legacy.roofTarget.texture, guard, 0);
    }
    if (guard && legacy.fluidRoofTarget?.texture) {
      this._packChannel(renderer, legacy.fluidRoofTarget.texture, guard, 2);
    }
  }

  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Texture} src
   * @param {import('three').WebGLRenderTarget} packed
   * @param {0|1|2|3} channel
   * @private
   */
  _packChannel(renderer, src, packed, channel) {
    const THREE = window.THREE;
    if (!THREE) return;
    if (!this._packMaterial) {
      this._packScene = new THREE.Scene();
      this._packCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this._packMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tSrc: { value: null },
          uChannel: { value: 0 },
        },
        vertexShader: /* glsl */`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */`
          uniform sampler2D tSrc;
          uniform float uChannel;
          varying vec2 vUv;
          void main() {
            float a = texture2D(tSrc, vUv).a;
            if (uChannel < 0.5) gl_FragColor = vec4(a, 0.0, 0.0, 1.0);
            else if (uChannel < 1.5) gl_FragColor = vec4(0.0, a, 0.0, 1.0);
            else if (uChannel < 2.5) gl_FragColor = vec4(0.0, 0.0, a, 1.0);
            else gl_FragColor = vec4(0.0, 0.0, 0.0, a);
          }
        `,
        depthWrite: false,
        depthTest: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.MaxEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
      });
      this._packMaterial.toneMapped = false;
      this._packQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._packMaterial);
      this._packQuad.frustumCulled = false;
      this._packScene.add(this._packQuad);
    }
    const prev = renderer.getRenderTarget();
    try {
      this._packMaterial.uniforms.tSrc.value = src;
      this._packMaterial.uniforms.uChannel.value = channel;
      renderer.setRenderTarget(packed);
      if (channel === 0) {
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      }
      renderer.render(this._packScene, this._packCamera);
    } finally {
      renderer.setRenderTarget(prev);
    }
  }

  /**
   * Refresh legacy RT textures from packed screen channels (for external getters).
   * @param {import('three').WebGLRenderer} renderer
   * @param {object} legacy
   */
  syncLegacyFromPacked(renderer, legacy) {
    if (!renderer || !this.roofPackedScreenTarget?.texture) return;
    const tex = this.roofPackedScreenTarget.texture;
    if (legacy.roofVisibilityTarget) {
      this._channelExtract.extract(renderer, tex, legacy.roofVisibilityTarget, 0);
    }
    if (legacy.roofBlockTarget) {
      this._channelExtract.extract(renderer, tex, legacy.roofBlockTarget, 1);
    }
    if (legacy.roofRestrictLightTarget) {
      this._channelExtract.extract(renderer, tex, legacy.roofRestrictLightTarget, 2);
    }
  }

  /** @returns {SceneCaptureScope} */
  createScope() {
    return new SceneCaptureScope();
  }

  dispose() {
    try { this.roofPackedScreenTarget?.dispose?.(); } catch (_) { /* dispose */ }
    try { this.roofPackedGuardTarget?.dispose?.(); } catch (_) { /* dispose */ }
    try { this._packMaterial?.dispose?.(); } catch (_) { /* dispose */ }
    try { this._packQuad?.geometry?.dispose?.(); } catch (_) { /* dispose */ }
    this.roofPackedScreenTarget = null;
    this.roofPackedGuardTarget = null;
    this._packMaterial = null;
    this._packQuad = null;
    this._packScene = null;
    this._packCamera = null;
    this._channelExtract.dispose();
  }
}
