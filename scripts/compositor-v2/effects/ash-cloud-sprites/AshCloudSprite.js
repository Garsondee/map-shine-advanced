/**
 * @fileoverview Single ground-level ash cloud billboard sprite.
 * @module compositor-v2/effects/ash-cloud-sprites/AshCloudSprite
 */

import { createAshCloudSpriteMaterial } from './ash-cloud-shaders.js';

/** Default fast fade-in for ash puffs (seconds). */
export const ASH_FADE_IN_SEC = 2.0;
/** Default slow fade-out for ash puffs (seconds). */
export const ASH_FADE_OUT_SEC = 18.0;

/** Billboard ash cloud plane in world XY. */
export class AshCloudSprite {
  /**
   * @param {typeof import('three')} THREE
   * @param {object} params
   */
  constructor(THREE, params) {
    this._params = params;
    this.baseOpacity = 1;
    /** 0..1 lifecycle multiplier applied on top of baseOpacity. */
    this.fadeMul = 1;
    this._fadePhase = 'steady';
    this._fadeElapsed = 0;
    this._fadeDuration = ASH_FADE_IN_SEC;
    this._fadeStartMul = 1;
    /** When true, mesh hides after fade-out completes (pool deactivation). */
    this._pendingDeactivate = false;
    /** Set when a downwind exit fade-out finishes and the sprite should respawn upwind. */
    this._awaitingRecycle = false;
    this.windSpeedMult = 1;
    this.windAngleRad = 0;
    this.warpSeedX = 0;
    this.warpSeedY = 0;
    this.revealSeedX = 0;
    this.revealSeedY = 0;
    this.orbitPhase = 0;
    this.orbitRadius = 0.0015;
    this.orbitSpeed = 0.7;
    this.spawnRotationRad = 0;
    /** Scene-normalized spawn coords (0..1 across map width/height). */
    this.normU = 0.5;
    this.normV = 0.5;

    this.material = createAshCloudSpriteMaterial(THREE);
    const geo = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.root = this.mesh;
  }

  /**
   * @param {import('three').Texture|null} texture
   */
  assignTexture(texture) {
    if (this.material.uniforms?.map) {
      this.material.uniforms.map.value = texture;
    } else {
      this.material.map = texture;
    }
    this.material.needsUpdate = true;
  }

  /** @param {number} opacity */
  setDisplayOpacity(opacity) {
    const v = Math.max(0, Math.min(1, Number(opacity) || 0));
    if (this.material.uniforms?.opacity) {
      this.material.uniforms.opacity.value = v;
    } else {
      this.material.opacity = v;
    }
  }

  /** @param {number} [duration=ASH_FADE_IN_SEC] */
  beginFadeIn(duration = ASH_FADE_IN_SEC) {
    this._pendingDeactivate = false;
    this._awaitingRecycle = false;
    this._fadePhase = 'in';
    this._fadeElapsed = 0;
    this._fadeDuration = Math.max(0.001, Number(duration) || ASH_FADE_IN_SEC);
    this._fadeStartMul = 0;
    this.fadeMul = 0;
    this.syncDisplayOpacity();
  }

  /** @param {number} [duration=ASH_FADE_OUT_SEC] */
  beginFadeOut(duration = ASH_FADE_OUT_SEC) {
    if (this._fadePhase === 'out') return;
    this._fadePhase = 'out';
    this._fadeElapsed = 0;
    this._fadeDuration = Math.max(0.001, Number(duration) || ASH_FADE_OUT_SEC);
    this._fadeStartMul = Math.max(0, Math.min(1, this.fadeMul));
    this.syncDisplayOpacity();
  }

  markPendingDeactivate() {
    this._pendingDeactivate = true;
    const fadeOut = Number(this._params?.fadeOutDuration) || ASH_FADE_OUT_SEC;
    this.beginFadeOut(fadeOut);
  }

  clearPendingDeactivate() {
    this._pendingDeactivate = false;
  }

  /**
   * Advance fade ramp; returns `'complete'` when the current in/out ramp finishes.
   * @param {number} delta
   * @returns {'running'|'complete'}
   */
  updateFade(delta) {
    if (this._fadePhase === 'steady') return 'running';

    this._fadeElapsed += Math.max(0, Number(delta) || 0);
    const t = Math.min(1, this._fadeElapsed / this._fadeDuration);

    if (this._fadePhase === 'in') {
      this.fadeMul = this._fadeStartMul + (1 - this._fadeStartMul) * t;
    } else {
      this.fadeMul = this._fadeStartMul * (1 - t);
    }
    this.syncDisplayOpacity();

    if (t >= 1) {
      const finishedPhase = this._fadePhase;
      this._fadePhase = 'steady';
      this.fadeMul = finishedPhase === 'in' ? 1 : 0;
      this.syncDisplayOpacity();
      return 'complete';
    }
    return 'running';
  }

  syncDisplayOpacity() {
    this.setDisplayOpacity(this.baseOpacity * this.fadeMul);
  }

  /** @returns {import('three').Texture|null} */
  getTexture() {
    return this.material.uniforms?.map?.value ?? this.material?.map ?? null;
  }

  /**
   * Randomize scale, opacity, wind variance, and optionally texture.
   * @param {number} strength - ash strength 0..1 used for sparse/full bias
   * @param {import('../cloud-sprites/CloudSprite.js').CloudTexturePicker|null} picker
   * @param {Set<import('three').Texture>} usedTextures
   * @param {{ pickTexture?: boolean, spawnRotationRad?: number }} [options]
   */
  randomizeAppearance(strength, picker, usedTextures, options = {}) {
    const pickTexture = options.pickTexture !== false;
    if (pickTexture && picker) {
      const tex = picker.pick(strength, 0, usedTextures);
      if (tex) {
        this.assignTexture(tex);
        usedTextures.add(tex);
      }
    }

    const p = this._params;
    const scaleMin = Number(p.spriteScaleMin) || 400;
    const scaleMax = Number(p.spriteScaleMax) || 1400;
    const scale = scaleMin + Math.random() * (scaleMax - scaleMin);
    this.root.scale.set(scale, scale, 1);

    const opMin = Number(p.spriteOpacityMin) || 0.35;
    const opMax = Number(p.spriteOpacityMax) || 0.85;
    this.baseOpacity = opMin + Math.random() * (opMax - opMin);
    this.syncDisplayOpacity();

    this.windSpeedMult = 0.88 + Math.random() * 0.24;
    this.windAngleRad = (Math.random() * 2 - 1) * (5 * Math.PI / 180);
    this.warpSeedX = Math.random() * 100;
    this.warpSeedY = Math.random() * 100;
    this.revealSeedX = Math.random() * 500;
    this.revealSeedY = Math.random() * 500;
    this.orbitPhase = Math.random() * Math.PI * 2;
    this.orbitRadius = 0.0008 + Math.random() * 0.0028;
    this.orbitSpeed = 0.35 + Math.random() * 1.15;

    if (Number.isFinite(options.spawnRotationRad)) {
      this.setSpawnRotation(options.spawnRotationRad);
    }
  }

  /** @param {number} rad */
  setSpawnRotation(rad) {
    this.spawnRotationRad = rad;
    this.root.rotation.z = rad;
  }

  dispose() {
    try { this.mesh.geometry?.dispose?.(); } catch (_) {}
    try { this.material?.dispose?.(); } catch (_) {}
  }
}
