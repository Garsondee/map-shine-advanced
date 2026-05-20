/**
 * @fileoverview Holds GPU copies of lightning-direction shadows for one strike.
 *
 * Fade uses ShadowManager texture blend (fixed lightning map + live sun map),
 * not live sun-angle interpolation (which rotates shadow silhouettes).
 */

import {
  allocLitFactorTarget,
  copyTextureToTarget,
  createShadowTextureBlitContext,
} from './shadow-texture-copy.js';

/**
 * @param {THREE.WebGLRenderTarget|null} rt
 */
function disposeRt(rt) {
  try { rt?.dispose?.(); } catch (_) {}
}

export class LightningStrikeShadowSnapshot {
  constructor() {
    /** @type {ReturnType<typeof createShadowTextureBlitContext>|null} */
    this._blit = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._building = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._skyReach = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._painted = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._vegetation = null;
    this._azimuthDeg = null;
  }

  clear() {
    disposeRt(this._building);
    disposeRt(this._skyReach);
    disposeRt(this._painted);
    disposeRt(this._vegetation);
    this._building = null;
    this._skyReach = null;
    this._painted = null;
    this._vegetation = null;
    this._azimuthDeg = null;
  }

  hasCapture() {
    return !!(this._building || this._skyReach || this._painted || this._vegetation);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture|null} src
   * @param {THREE.WebGLRenderTarget|null} prev
   * @param {string} name
   * @returns {THREE.WebGLRenderTarget|null}
   */
  _copyInto(renderer, src, prev, name) {
    if (!renderer || !src) return prev;
    const w = Math.max(2, src.image?.width ?? src.source?.data?.width ?? 2);
    const h = Math.max(2, src.image?.height ?? src.source?.data?.height ?? 2);
    let rt = prev;
    if (!rt || rt.width !== w || rt.height !== h) {
      disposeRt(rt);
      rt = allocLitFactorTarget(w, h, name);
    }
    if (rt) copyTextureToTarget(renderer, src, rt, this._blit);
    return rt;
  }

  /**
   * Copy current lightning-direction shadow RTs from the compositor (call after
   * structural + vegetation passes rendered with live sun override).
   *
   * @param {import('../FloorCompositor.js').FloorCompositor} fc
   * @param {number} azimuthDeg
   */
  captureFromCompositor(fc, azimuthDeg) {
    const renderer = fc?.renderer;
    if (!renderer) return;
    if (!this._blit) this._blit = createShadowTextureBlitContext();
    if (!this._blit) return;

    const building = fc._buildingShadowEffect?.shadowFactorTexture ?? null;
    const skyReach = fc._skyReachShadowEffect?.shadowFactorTexture ?? null;
    const painted = fc._paintedShadowEffect?.shadowFactorTexture ?? null;
    const vegetation = fc._vegetationBillboardShadowTexture ?? null;

    this._building = this._copyInto(renderer, building, this._building, 'LandscapeLightningStrikeBuilding');
    this._skyReach = this._copyInto(renderer, skyReach, this._skyReach, 'LandscapeLightningStrikeSkyReach');
    this._painted = this._copyInto(renderer, painted, this._painted, 'LandscapeLightningStrikePainted');
    this._vegetation = this._copyInto(renderer, vegetation, this._vegetation, 'LandscapeLightningStrikeVeg');
    this._azimuthDeg = Number.isFinite(Number(azimuthDeg)) ? Number(azimuthDeg) : null;
  }

  /**
   * @returns {{ building: THREE.Texture|null, skyReach: THREE.Texture|null, painted: THREE.Texture|null, vegetation: THREE.Texture|null }|null}
   */
  getTextures() {
    if (!this.hasCapture()) return null;
    return {
      building: this._building?.texture ?? null,
      skyReach: this._skyReach?.texture ?? null,
      painted: this._painted?.texture ?? null,
      vegetation: this._vegetation?.texture ?? null,
    };
  }

  dispose() {
    this.clear();
    this._blit = null;
  }
}
