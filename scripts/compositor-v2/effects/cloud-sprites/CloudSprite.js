/**
 * @fileoverview Single billboard cloud sprite + asset manifest constants.
 * @module compositor-v2/effects/cloud-sprites/CloudSprite
 */

import { createCloudShadowSpriteMaterial } from './cloud-shaders.js';

export const CLOUD_ASSET_BASE = 'modules/map-shine-advanced/assets/clouds';
export const LAYER_COUNT = 3;
export const LAYER_PARALLAX = [1.0, 0.64, 0.28];
export const LAYER_POOL_COUNTS = [14, 14, 12];
export const MIN_ACTIVE_SPRITES = 10;
export const MAX_ACTIVE_SPRITES = 40;
export const COVER_FOR_MIN = 0.2;
export const COVER_FOR_MAX = 0.8;

export const FULL_CLOUD_FILES = [
  'cloud_transparent_007.png', 'cloud_transparent_008.png', 'cloud_transparent_026.png',
  'cloud_transparent_036.png', 'cloud_transparent_038.png', 'cloud_transparent_048.png',
  'cloud_transparent_049.png', 'cloud_transparent_050.png', 'cloud_transparent_051.png',
  'cloud_transparent_074.png', 'cloud_transparent_080.png', 'cloud_transparent_088.png',
  'cloud_transparent_097.png', 'cloud_transparent_098.png', 'cloud_transparent_103.png',
];

export const SPARSE_CLOUD_FILES = [
  'cloud_transparent_001.png', 'cloud_transparent_002.png', 'cloud_transparent_003.png',
  'cloud_transparent_004.png', 'cloud_transparent_005.png', 'cloud_transparent_006.png',
  'cloud_transparent_017.png', 'cloud_transparent_018.png', 'cloud_transparent_019.png',
  'cloud_transparent_020.png', 'cloud_transparent_027.png', 'cloud_transparent_029.png',
  'cloud_transparent_040.png', 'cloud_transparent_073.png', 'cloud_transparent_092.png',
  'cloud_transparent_106.png',
];

/** @param {import('three').Texture[]} arr */
function shuffleTextures(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Picks cloud PNGs without repeating until the pool is exhausted.
 */
export class CloudTexturePicker {
  /**
   * @param {import('three').Texture[]} sparseTextures
   * @param {import('three').Texture[]} fullTextures
   * @param {object} params
   */
  constructor(sparseTextures, fullTextures, params) {
    this._sparse = sparseTextures ?? [];
    this._full = fullTextures ?? [];
    this._params = params;
  }

  /** @private */
  _poolForCover(cover, layerIndex) {
    const sparseWeightParam = Number(this._params?.sparseWeight);
    const sparseBias = Number.isFinite(sparseWeightParam) && sparseWeightParam >= 0
      ? Math.max(0, Math.min(1, sparseWeightParam))
      : Math.max(0, Math.min(1, 1 - cover));
    const layerFullBias = Math.max(0, (2 - layerIndex) * 0.08);
    const pickSparse = Math.random() < Math.max(0, Math.min(1, sparseBias - layerFullBias));
    const primary = pickSparse ? this._sparse : this._full;
    const secondary = pickSparse ? this._full : this._sparse;
    const out = [];
    if (primary.length > 0) out.push(...primary);
    if (secondary.length > 0) out.push(...secondary);
    return out.length > 0 ? out : (this._sparse.length > 0 ? this._sparse : this._full);
  }

  /**
   * @param {number} cover
   * @param {number} layerIndex
   * @param {Set<import('three').Texture>} avoid
   * @returns {import('three').Texture|null}
   */
  pick(cover, layerIndex, avoid = new Set()) {
    const pool = this._poolForCover(cover, layerIndex);
    if (pool.length === 0) return null;
    const unused = pool.filter((t) => !avoid.has(t));
    const pickFrom = unused.length > 0 ? unused : pool;
    return pickFrom[Math.floor(Math.random() * pickFrom.length)] ?? null;
  }

  /**
   * Assign unique textures to an array of sprites (no repeats until pools merge).
   * @param {CloudSprite[]} sprites
   * @param {number} cover
   */
  assignUnique(sprites, cover) {
    const used = new Set();
    const sparseDeck = shuffleTextures(this._sparse);
    const fullDeck = shuffleTextures(this._full);
    let si = 0;
    let fi = 0;

    for (const sprite of sprites) {
      const layer = sprite.layerIndex ?? 0;
      const sparseWeightParam = Number(this._params?.sparseWeight);
      const sparseBias = Number.isFinite(sparseWeightParam) && sparseWeightParam >= 0
        ? Math.max(0, Math.min(1, sparseWeightParam))
        : Math.max(0, Math.min(1, 1 - cover));
      const layerFullBias = Math.max(0, (2 - layer) * 0.08);
      const preferSparse = Math.max(0, sparseBias - layerFullBias) >= 0.5
        || (this._sparse.length > 0 && this._full.length === 0);
      let tex = null;

      if (preferSparse) {
        while (si < sparseDeck.length && used.has(sparseDeck[si])) si++;
        if (si < sparseDeck.length) tex = sparseDeck[si++];
      }
      if (!tex) {
        while (fi < fullDeck.length && used.has(fullDeck[fi])) fi++;
        if (fi < fullDeck.length) tex = fullDeck[fi++];
      }
      if (!tex) {
        while (si < sparseDeck.length && used.has(sparseDeck[si])) si++;
        if (si < sparseDeck.length) tex = sparseDeck[si++];
      }
      if (!tex) tex = this.pick(cover, layer, used);

      if (tex) {
        used.add(tex);
        sprite.assignTexture(tex);
      }
    }
  }
}

/** Billboard cloud plane (XY, spawn-locked rotation on Z). */
export class CloudSprite {
  constructor(THREE, sparseTextures, fullTextures, params) {
    this._params = params;
    this.layerIndex = 0;
    this.baseOpacity = 1;
    this.windSpeedMult = 1;
    this.windAngleRad = 0;
    /** Locked at spawn; does not track sun/time-of-day. */
    this.spawnRotationRad = 0;
    /** Scene-normalized spawn coords (0..1 across map width/height). */
    this.normU = 0.5;
    this.normV = 0.5;

    this.displayMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      alphaTest: 0.02,
    });
    this.shadowMaterial = createCloudShadowSpriteMaterial(THREE);

    const geo = new THREE.PlaneGeometry(1, 1);
    this.displayMesh = new THREE.Mesh(geo, this.displayMaterial);
    this.shadowMesh = new THREE.Mesh(geo, this.shadowMaterial);
    this.displayMesh.frustumCulled = false;
    this.shadowMesh.frustumCulled = false;
    this.displayMesh.layers.set(0);
    this.shadowMesh.layers.set(1);

    this.root = new THREE.Group();
    this.root.frustumCulled = false;
    this.root.add(this.displayMesh);
    this.root.add(this.shadowMesh);
    /** Scene-graph node added to layer groups. */
    this.mesh = this.root;

    void sparseTextures;
    void fullTextures;
  }

  /**
   * @param {import('three').Texture|null} texture
   */
  assignTexture(texture) {
    this.displayMaterial.map = texture;
    if (this.shadowMaterial.uniforms?.map) {
      this.shadowMaterial.uniforms.map.value = texture;
    }
    this.displayMaterial.needsUpdate = true;
    this.shadowMaterial.needsUpdate = true;
  }

  /** @param {number} opacity */
  setShadowOpacity(opacity) {
    if (this.shadowMaterial.uniforms?.opacity) {
      this.shadowMaterial.uniforms.opacity.value = opacity;
    }
  }

  /** @returns {import('three').Texture|null} */
  getTexture() {
    return this.displayMaterial?.map ?? null;
  }

  /**
   * Randomize scale, opacity, wind variance, and optionally texture.
   * Does not change normU/normV — call _applySpriteLocalPosition separately.
   * @param {number} cover
   * @param {number} layerIndex
   * @param {CloudTexturePicker|null} picker
   * @param {Set<import('three').Texture>} usedTextures
   * @param {{ pickTexture?: boolean, spawnRotationRad?: number }} [options]
   */
  randomizeAppearance(cover, layerIndex, picker, usedTextures, options = {}) {
    const pickTexture = options.pickTexture !== false;
    this.layerIndex = layerIndex;

    if (pickTexture && picker) {
      const tex = picker.pick(cover, layerIndex, usedTextures);
      if (tex) {
        this.assignTexture(tex);
        usedTextures.add(tex);
      }
    }

    const p = this._params;
    const scaleMin = Number(p.spriteScaleMin) || 1000;
    const scaleMax = Number(p.spriteScaleMax) || 3000;
    const layerScale = 1 + layerIndex * 0.12;
    const scale = (scaleMin + Math.random() * (scaleMax - scaleMin)) * layerScale;
    this.root.scale.set(scale, scale, 1);

    const opMin = Number(p.spriteOpacityMin) || 0.6;
    const opMax = Number(p.spriteOpacityMax) || 1.0;
    this.baseOpacity = opMin + Math.random() * (opMax - opMin);
    this.displayMaterial.opacity = this.baseOpacity;

    this.windSpeedMult = 0.88 + Math.random() * 0.24;
    this.windAngleRad = (Math.random() * 2 - 1) * (5 * Math.PI / 180);

    if (Number.isFinite(options.spawnRotationRad)) {
      this.setSpawnRotation(options.spawnRotationRad);
    }
  }

  /** @param {number} rad */
  setSpawnRotation(rad) {
    this.spawnRotationRad = rad;
    this.root.rotation.z = rad;
  }

  /**
   * @param {number} cover
   * @param {number} layerIndex
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null} bounds
   * @param {CloudTexturePicker|null} picker
   * @param {Set<import('three').Texture>} usedTextures
   */
  reset(cover, layerIndex, bounds, picker, usedTextures, options = {}) {
    this.randomizeAppearance(cover, layerIndex, picker, usedTextures, options);
    if (bounds) {
      this.placeAt(
        bounds.minX + Math.random() * (bounds.maxX - bounds.minX),
        bounds.minY + Math.random() * (bounds.maxY - bounds.minY),
      );
    }
  }

  /** @param {number} x @param {number} y @param {number} [z] */
  placeAt(x, y, z) {
    const layerZ = Number.isFinite(z)
      ? z
      : -(this.layerIndex ?? 0) * 0.01;
    this.root.position.set(x, y, layerZ);
  }

  dispose() {
    try { this.displayMesh.geometry?.dispose?.(); } catch (_) {}
    try { this.displayMaterial?.dispose?.(); } catch (_) {}
    try { this.shadowMaterial?.dispose?.(); } catch (_) {}
  }
}
