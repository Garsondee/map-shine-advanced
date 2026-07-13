/**
 * @fileoverview V3PostBridge — runs V2's post-merge colour grade on the V3 lit
 * buffer, so the module's signature time-of-day / indoor-outdoor look is available
 * for judging how well V3's lighting fundamentals actually work.
 *
 * V3 skips `FloorCompositor.render()`, so the post-merge grade never ran under V3
 * (the scene rendered "physically lit but ungraded"). This bridge reaches the live
 * `_colorCorrectionEffect` + `_contextualSceneGradeManager` instances — the same
 * way {@link V3EffectsBridge} reaches candle/vegetation — ticks them, and calls
 * `ColorCorrectionEffectV2.render(renderer, litRT, gradedRT)`: the exact clean
 * (inputRT → outputRT) entry point FloorCompositor uses at its post-merge CC site
 * ([FloorCompositor.js:9756]). ColorCorrection also hosts the Contextual Scene
 * Grade (indoor/outdoor packs + ToD timeline), so ticking it restores both.
 *
 * **Colour space.** CC consumes linear HDR and writes linear (it applies its own
 * ACES when its `toneMapping` param is on, but no sRGB OETF). V3's present pass
 * does the linear→sRGB encode. When CC tone-mapped, present skips the highlight
 * rolloff (CC owns tone-mapping — a second pass would double-compress); otherwise
 * present keeps the rolloff. See {@link ccToneMappingActive}.
 *
 * **MVP scope.** ColorCorrection (+ its contextual grade) only. Bloom, atmospheric
 * fog, and the stylizer chain are follow-ups on the same (in,out) render contract.
 * Per-floor shadow / local-light bindings V2 feeds CC do not exist under V3 yet
 * and are passed null (CC treats them as neutral).
 *
 * @module compositor-v3/V3PostBridge
 */

import { createLogger } from '../core/log.js';
import { resolveViewedBandOutdoorsMask } from '../masks/indoor-outdoor-mask-api.js';

const log = createLogger('V3PostBridge');

export class V3PostBridge {
  /** @param {object} [options] @param {any} [options.THREE] */
  constructor(options = {}) {
    this._THREE = options.THREE ?? (typeof window !== 'undefined' ? window.THREE : null);
    this._copyScene = null;
    this._copyCamera = null;
    this._copyMat = null;
    this._warnedUnavailable = false;
  }

  /** @returns {any|null} the V2 FloorCompositor (holds the grade instances). @private */
  _compositor() {
    return window.MapShine?.floorCompositorV2
      ?? window.MapShine?.effectComposer?._floorCompositorV2
      ?? null;
  }

  /** @returns {boolean} whether the colour-correction grade can run this frame. */
  isColorCorrectionAvailable() {
    const cc = this._compositor()?._colorCorrectionEffect ?? null;
    return !!(cc && cc._initialized);
  }

  /**
   * @returns {boolean} whether CC will tone-map (its toneMapping param > 0). When
   * true, the present pass must NOT also apply the highlight rolloff.
   */
  ccToneMappingActive() {
    try {
      const cc = this._compositor()?._colorCorrectionEffect ?? null;
      return Number(cc?.params?.toneMapping) > 0;
    } catch (_) { return false; }
  }

  /**
   * Resolve the `_Outdoors` mask for CC's indoor/outdoor grade the way V2's
   * post-merge CC does: the **effective stack** across visible floors (V2 feeds
   * CC `stackedOutdoorsForPostMerge`, not the single viewed band). On multi-floor
   * scenes the single-band resolve returns the wrong/no mask, which is why the
   * Camera Grade read as not-indoor/outdoor-aware under V3. Needs the renderer to
   * build the stack. Null when unavailable → CC grades everything outdoor (neutral).
   * @param {THREE.WebGLRenderer} renderer
   * @returns {{outdoors: any|null}}
   * @private
   */
  _resolveOutdoors(renderer) {
    try {
      const comp = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
      if (!comp) return { outdoors: null };
      const ctx = window.MapShine?.activeLevelContext ?? null;
      const res = resolveViewedBandOutdoorsMask(comp, ctx, { preferEffectiveStack: true, renderer });
      return { outdoors: res?.texture ?? null };
    } catch (_) {
      return { outdoors: null };
    }
  }

  /**
   * Tick the grade (ToD timeline + contextual grade) and run it lit→graded.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {THREE.WebGLRenderTarget} litRT - V3 scene.lit (linear HDR input)
   * @param {THREE.WebGLRenderTarget} gradedRT - output
   * @param {object|null} timeInfo
   * @returns {boolean} true iff CC wrote gradedRT (else caller must passthrough).
   */
  renderColorGrade(renderer, camera, litRT, gradedRT, timeInfo) {
    const fc = this._compositor();
    const cc = fc?._colorCorrectionEffect ?? null;
    if (!renderer || !litRT || !gradedRT || !cc || !cc._initialized) {
      if (!this._warnedUnavailable) { log.debug('CC unavailable; grade skipped'); this._warnedUnavailable = true; }
      return false;
    }

    // V2.render (which normally ticks these) is skipped under V3 — tick here so
    // the ToD timeline and contextual indoor/outdoor grade advance.
    try { fc._contextualSceneGradeManager?.update?.(timeInfo); } catch (err) { log.debug('ctx grade update failed', err); }
    try { cc.update?.(timeInfo); } catch (err) { log.debug('cc update failed', err); }

    const { outdoors } = this._resolveOutdoors(renderer);
    try {
      cc.setOutdoorsMask?.(outdoors ?? null);
      cc.setSkyReachMask?.(null);
      cc.setSkyOcclusionTexture?.(null);
      // V3 has no per-floor shadow / local-light producers yet → neutral (null).
      cc.setCombinedShadowTexture?.(null);
      cc.setLocalLightTexture?.(null, 0.0);
      cc.setSceneLightTexture?.(null);
    } catch (_) {}

    let wrote = false;
    try {
      wrote = cc.render(renderer, litRT, gradedRT) === true;
    } catch (err) {
      log.warn('color-correction render failed; passing lit through', err);
      wrote = false;
    } finally {
      try { cc.setOutdoorsMask?.(null); cc.setLocalLightTexture?.(null, 0.0); cc.setSceneLightTexture?.(null); } catch (_) {}
    }
    return wrote;
  }

  /**
   * Raw passthrough copy `srcTex → dstRT` (no tone map, no encode) used when the
   * grade is disabled / unavailable / errored, so scene.graded is always valid.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture} srcTex
   * @param {THREE.WebGLRenderTarget} dstRT
   * @returns {boolean}
   */
  copy(renderer, srcTex, dstRT) {
    const THREE = this._THREE ?? (typeof window !== 'undefined' ? window.THREE : null);
    if (!renderer || !srcTex || !dstRT || !THREE) return false;
    if (!this._copyMat) {
      this._copyScene = new THREE.Scene();
      this._copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this._copyMat = new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'precision highp float; uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }',
        depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending,
      });
      this._copyMat.toneMapped = false;
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._copyMat);
      quad.frustumCulled = false;
      this._copyScene.add(quad);
    }
    const prev = renderer.getRenderTarget?.();
    const prevAC = renderer.autoClear;
    try {
      this._copyMat.uniforms.tDiffuse.value = srcTex;
      renderer.setRenderTarget(dstRT);
      renderer.autoClear = false;
      if (typeof renderer.clear === 'function') renderer.clear(true, true, true);
      renderer.render(this._copyScene, this._copyCamera);
    } catch (err) {
      log.debug('passthrough copy failed', err);
      return false;
    } finally {
      renderer.autoClear = prevAC;
      try { renderer.setRenderTarget(prev ?? null); } catch (_) {}
    }
    return true;
  }

  dispose() {
    try { this._copyMat?.dispose?.(); } catch (_) {}
    try { this._copyScene = null; this._copyCamera = null; this._copyMat = null; } catch (_) {}
  }
}
