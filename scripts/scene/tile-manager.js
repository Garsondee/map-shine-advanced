/**
 * @fileoverview Tile manager - syncs Foundry tiles to THREE.js sprites
 * Handles creation, updates, and deletion of tile sprites in the THREE.js scene
 * Support for Background, Foreground, and Overhead tile layers
 * @module scene/tile-manager
 */

import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';
import { OVERLAY_THREE_LAYER, TILE_FEATURE_LAYERS } from '../effects/EffectComposer.js';

const log = createLogger('TileManager');

// TEMPORARY KILL-SWITCH: Disable tile manager updates for perf testing.
// Set to true to skip all tile sync operations.
// Currently FALSE so tiles behave normally while we profile other systems.
const DISABLE_TILE_UPDATES = false;

// Z-layer offsets from groundZ (from Architecture)
// These are OFFSETS added to groundZ, not absolute values.
// Compressed so all tiles live in a very thin band above the ground plane.
// Background < Foreground < Overhead, but differences are tiny.
const Z_BACKGROUND_OFFSET = 0.01;
const Z_FOREGROUND_OFFSET = 0.02;
// IMPORTANT: Overhead tiles must sit above tokens in Z so depth testing can
// reliably keep roofs visible even when renderer object sorting is disabled.
// Tokens use TOKEN_BASE_Z=0.06 (see TokenManager). Keep this slightly above.
const Z_OVERHEAD_OFFSET = 0.08;

const ROOF_LAYER = 20;
const WEATHER_ROOF_LAYER = 21;
const WATER_OCCLUDER_LAYER = 22;

/**
 * TileManager - Synchronizes Foundry VTT tiles to THREE.js sprites
 * Handles layering (Background/Foreground/Overhead) and reactive updates
 */
export class TileManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene to add tile sprites to
   */
  constructor(scene) {
    this.scene = scene;

    /** @type {THREE.Scene|null} */
    this.waterOccluderScene = null;
    
    /** @type {Map<string, {sprite: THREE.Sprite, tileDoc: TileDocument}>} */
    this.tileSprites = new Map();
    
    /** @type {THREE.TextureLoader} */
    this.textureLoader = new THREE.TextureLoader();
    
    /** @type {Map<string, THREE.Texture>} */
    this.textureCache = new Map();

    this._texturePromises = new Map();

    this._tileWaterMaskCache = new Map();
    this._tileWaterMaskPromises = new Map();

    // Resolved mask URL per tile base path (ignores query string so cache-busters don't break lookups)
    // Key: tileBaseNoExt (no query, no extension), Value: resolved mask URL string OR null
    this._tileWaterMaskResolvedUrl = new Map();
    this._tileWaterMaskResolvePromises = new Map();

    this._tileSpecularMaskCache = new Map();
    this._tileSpecularMaskPromises = new Map();
    this._tileSpecularMaskResolvedUrl = new Map();
    this._tileSpecularMaskResolvePromises = new Map();

    // Cache directory listings so we can avoid 404 spam when probing optional mask files.
    // Key: directory path (with trailing slash), Value: string[] of file paths
    this._dirFileListCache = new Map();
    this._dirFileListPromises = new Map();
    
    /** @type {Map<string, {width: number, height: number, data: Uint8ClampedArray}>} */
    this.alphaMaskCache = new Map();

    this._overheadTileIds = new Set();
    this._weatherRoofTileIds = new Set();

    this._initialLoad = {
      active: false,
      pendingAll: 0,
      pendingOverhead: 0,
      trackedIds: new Set(),
      waiters: []
    };
    
    this.initialized = false;
    this.hooksRegistered = false;

    // Global visibility gate used by canvas-replacement when switching tools/modes.
    // When false, tile sprites must remain hidden even if Foundry emits refresh/update
    // hooks (e.g. while editing tiles in PIXI).
    this._globalVisible = true;
    
    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];
    
    // PERFORMANCE: Reusable color objects to avoid per-frame allocations
    this._globalTint = null;      // Lazy init when THREE is available
    this._tempDaylight = null;
    this._tempDarkness = null;
    this._tempAmbient = null;

    this._lastTintKey = null;
    this._tintDirty = true;

    this._overheadCCDirty = true;
    this.overheadColorCorrection = {
      enabled: true,
      exposure: 1.0,
      temperature: 0.0,
      tint: 0.0,
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
      gamma: 1.0
    };

    // Cache for expensive per-mask image analysis used by water occluder heuristics.
    // Keyed by resolved mask URL.
    this._waterMaskCoverageCache = new Map();

    this._waterCacheInvalidation = {
      pending: false,
      timer: null,
      lastTileId: null
    };
    
    // Window light effect reference for overhead tile lighting
    /** @type {WindowLightEffect|null} */
    this.windowLightEffect = null;

    /** @type {SpecularEffect|null} */
    this.specularEffect = null;

    // Cache renderer-derived values for texture filtering.
    this._maxAnisotropy = null;
    
    log.debug('TileManager created');
  }

  setOverheadColorCorrectionParams(params) {
    if (!params || typeof params !== 'object') return;
    Object.assign(this.overheadColorCorrection, params);
    this._overheadCCDirty = true;
    this.applyColorCorrectionToAllOverheadTiles();
  }

  applyColorCorrectionToAllOverheadTiles() {
    for (const data of this.tileSprites.values()) {
      const sprite = data?.sprite;
      const mat = sprite?.material;
      if (!mat) continue;
      this._ensureOverheadColorCorrection(mat);
      this._applyOverheadColorCorrectionUniforms(sprite, mat);
    }
    this._overheadCCDirty = false;
  }

  _applyOverheadColorCorrectionUniforms(sprite, material) {
    const shader = material?.userData?._msOverheadCCShader;
    if (!shader?.uniforms) return;

    const p = this.overheadColorCorrection;
    const isOverhead = !!sprite?.userData?.isOverhead;

    shader.uniforms.uOverheadCCEnabled.value = (p.enabled && isOverhead) ? 1.0 : 0.0;
    shader.uniforms.uOverheadExposure.value = p.exposure ?? 1.0;
    shader.uniforms.uOverheadTemperature.value = p.temperature ?? 0.0;
    shader.uniforms.uOverheadTint.value = p.tint ?? 0.0;
    shader.uniforms.uOverheadBrightness.value = p.brightness ?? 0.0;
    shader.uniforms.uOverheadContrast.value = p.contrast ?? 1.0;
    shader.uniforms.uOverheadSaturation.value = p.saturation ?? 1.0;
    shader.uniforms.uOverheadGamma.value = p.gamma ?? 1.0;
  }

  _ensureOverheadColorCorrection(material) {
    if (!material || material.userData?._msOverheadCCInstalled) return;

    material.userData._msOverheadCCInstalled = true;
    material.onBeforeCompile = (shader) => {
      material.userData._msOverheadCCShader = shader;

      shader.uniforms.uOverheadCCEnabled = { value: 1.0 };
      shader.uniforms.uOverheadExposure = { value: 1.0 };
      shader.uniforms.uOverheadTemperature = { value: 0.0 };
      shader.uniforms.uOverheadTint = { value: 0.0 };
      shader.uniforms.uOverheadBrightness = { value: 0.0 };
      shader.uniforms.uOverheadContrast = { value: 1.0 };
      shader.uniforms.uOverheadSaturation = { value: 1.0 };
      shader.uniforms.uOverheadGamma = { value: 1.0 };

      const uniformBlock = `
uniform float uOverheadCCEnabled;
uniform float uOverheadExposure;
uniform float uOverheadTemperature;
uniform float uOverheadTint;
uniform float uOverheadBrightness;
uniform float uOverheadContrast;
uniform float uOverheadSaturation;
uniform float uOverheadGamma;

vec3 ms_applyOverheadWhiteBalance(vec3 color, float temp, float tint) {
  vec3 tempShift = vec3(1.0 + temp, 1.0, 1.0 - temp);
  if (temp < 0.0) tempShift = vec3(1.0, 1.0, 1.0 - temp * 0.5);
  else tempShift = vec3(1.0 + temp * 0.5, 1.0, 1.0);

  vec3 tintShift = vec3(1.0, 1.0 + tint, 1.0);
  return color * tempShift * tintShift;
}

vec3 ms_applyOverheadColorCorrection(vec3 color) {
  if (uOverheadCCEnabled < 0.5) return color;

  color *= uOverheadExposure;
  color = ms_applyOverheadWhiteBalance(color, uOverheadTemperature, uOverheadTint);
  color += uOverheadBrightness;
  color = (color - 0.5) * uOverheadContrast + 0.5;

  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, uOverheadSaturation);

  color = max(color, vec3(0.0));
  color = pow(color, vec3(1.0 / max(uOverheadGamma, 0.0001)));
  return color;
}
`;

      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        `${uniformBlock}\nvoid main() {`
      );

      let patched = false;

      if (shader.fragmentShader.includes('#include <output_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <output_fragment>',
          `#include <output_fragment>\n  gl_FragColor.rgb = ms_applyOverheadColorCorrection(gl_FragColor.rgb);`
        );
        patched = true;
      }

      if (!patched && shader.fragmentShader.includes('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
          `vec3 ccLight = ms_applyOverheadColorCorrection(outgoingLight);\n  gl_FragColor = vec4( ccLight, diffuseColor.a );`
        );
        patched = true;
      }

      if (!patched) {
        shader.fragmentShader = shader.fragmentShader.replace(
          /}\s*$/,
          `  gl_FragColor.rgb = ms_applyOverheadColorCorrection(gl_FragColor.rgb);\n}`
        );
      }

      try {
        const tileId = material?.userData?._msTileId;
        const sprite = tileId ? this.tileSprites.get(tileId)?.sprite : null;
        if (sprite) this._applyOverheadColorCorrectionUniforms(sprite, material);
      } catch (_) {
      }
    };

    material.needsUpdate = true;
  }

  _getRenderer() {
    return window.MapShine?.renderer || null;
  }

  _getMaxAnisotropy() {
    if (typeof this._maxAnisotropy === 'number') return this._maxAnisotropy;
    const renderer = this._getRenderer();
    const max = renderer?.capabilities?.getMaxAnisotropy?.();
    this._maxAnisotropy = (typeof max === 'number' && max > 0) ? max : 1;
    return this._maxAnisotropy;
  }

  _isPowerOfTwo(value) {
    const v = value | 0;
    return v > 0 && (v & (v - 1)) === 0;
  }

  _getTextureDimensions(texture) {
    const img = texture?.image;
    if (!img) return { w: 0, h: 0 };
    const w = Number(img?.naturalWidth ?? img?.videoWidth ?? img?.width ?? 0);
    const h = Number(img?.naturalHeight ?? img?.videoHeight ?? img?.height ?? 0);
    return { w, h };
  }

  _configureTileTextureFiltering(texture, role = 'ALBEDO') {
    const THREE = window.THREE;
    if (!THREE || !texture) return;

    // ALBEDO textures need mipmaps for stable minification when zoomed out.
    // DATA_MASK textures should remain linear/no-mipmap to preserve data semantics.
    if (role === 'DATA_MASK') {
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 1;
      texture.needsUpdate = true;
      return;
    }

    const renderer = this._getRenderer();
    const isWebGL2 = !!renderer?.capabilities?.isWebGL2;
    const { w, h } = this._getTextureDimensions(texture);
    const isPot = this._isPowerOfTwo(w) && this._isPowerOfTwo(h);
    const canMipmap = isWebGL2 || isPot;

    texture.generateMipmaps = canMipmap;
    texture.minFilter = canMipmap ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = canMipmap ? Math.min(16, this._getMaxAnisotropy()) : 1;
    texture.needsUpdate = true;
  }

  _normalizeTileTextureSource(texture, role = 'ALBEDO') {
    if (!texture || role === 'DATA_MASK') return texture;

    const img = texture.image;
    if (!img) return texture;

    const ImageBitmapCtor = globalThis.ImageBitmap;
    const isBitmap = ImageBitmapCtor && img instanceof ImageBitmapCtor;
    if (!isBitmap) return texture;

    const w = Number(img?.width ?? 0);
    const h = Number(img?.height ?? 0);
    if (!(w > 0 && h > 0)) return texture;

    try {
      const canvasEl = document.createElement('canvas');
      canvasEl.width = w;
      canvasEl.height = h;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) return texture;
      ctx.drawImage(img, 0, 0, w, h);
      texture.image = canvasEl;
      texture.needsUpdate = true;
      try {
        if (typeof img.close === 'function') img.close();
      } catch (_) {
      }
    } catch (_) {
      return texture;
    }

    return texture;
  }

  /**
   * Provide a dedicated scene for water occluder meshes.
   * Rendering occluders from a separate scene avoids traversing the entire
   * world scene during the occluder pass.
   * @param {THREE.Scene|null} scene
   */
  setWaterOccluderScene(scene) {
    const next = scene || null;
    if (this.waterOccluderScene === next) return;

    const prev = this.waterOccluderScene;
    this.waterOccluderScene = next;

    // Migrate any existing occluder meshes between scenes.
    try {
      if (!prev && !next) return;
      for (const { sprite } of this.tileSprites.values()) {
        const occ = sprite?.userData?.waterOccluderMesh;
        if (!occ) continue;
        try {
          if (prev) prev.remove(occ);
        } catch (_) {
        }
        try {
          if (next) next.add(occ);
          else this.scene.add(occ);
        } catch (_) {
        }
      }
    } catch (_) {
    }
  }

  isWorldPointInTileBounds(data, worldX, worldY) {
    const { tileDoc } = data;
    if (!tileDoc) return false;

    const width = tileDoc.width;
    const height = tileDoc.height;

    const scaleX = tileDoc.texture?.scaleX ?? 1;
    const scaleY = tileDoc.texture?.scaleY ?? 1;

    // Foundry tile docs store the base dimensions, with texture.scaleX/scaleY applied
    // around the tile center. Our hover/bounds math must use the displayed size.
    const dispW = width * Math.abs(scaleX || 1);
    const dispH = height * Math.abs(scaleY || 1);

    if (!Number.isFinite(dispW) || !Number.isFinite(dispH) || dispW <= 0 || dispH <= 0) return false;

    // Map world coords back to Foundry top-left space
    const sceneHeight = canvas.dimensions?.height || 10000;
    const foundryX = worldX;
    const foundryY = sceneHeight - worldY;

    // Convert to tile local space (account for rotation around center)
    const centerX = tileDoc.x + width / 2;
    const centerY = tileDoc.y + height / 2;
    const dx = foundryX - centerX;
    const dy = foundryY - centerY;

    const rotDeg = tileDoc.rotation || 0;
    const r = (-rotDeg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;

    // Convert to displayed local space (scaled around center).
    const localX = lx + dispW / 2;
    const localY = ly + dispH / 2;

    let u = localX / dispW;
    let v = localY / dispH;

    if (scaleX < 0) u = 1 - u;
    if (scaleY < 0) v = 1 - v;

    return !(u < 0 || u > 1 || v < 0 || v > 1);
  }

  _getWaterOccluderScene() {
    return this.waterOccluderScene || this.scene;
  }

  _scheduleWaterCacheInvalidation(tileId = null) {
    // Debounce to avoid spamming rebuilds when a user drags/resizes tiles.
    this._waterCacheInvalidation.lastTileId = tileId;
    if (this._waterCacheInvalidation.pending) return;
    this._waterCacheInvalidation.pending = true;

    try {
      if (this._waterCacheInvalidation.timer) {
        clearTimeout(this._waterCacheInvalidation.timer);
        this._waterCacheInvalidation.timer = null;
      }
    } catch (_) {
    }

    this._waterCacheInvalidation.timer = setTimeout(() => {
      this._waterCacheInvalidation.pending = false;
      this._waterCacheInvalidation.timer = null;

      // WaterEffectV2 cache
      try {
        const waterEffect = window.MapShine?.waterEffect;
        if (waterEffect && typeof waterEffect.clearCaches === 'function') {
          waterEffect.clearCaches();
        }
      } catch (_) {
      }

      // WeatherParticles tile foam cache
      try {
        const particleSystem = window.MapShineParticles;
        const wp = particleSystem?.weatherParticles;
        if (wp && typeof wp.clearWaterCaches === 'function') {
          wp.clearWaterCaches();
        }
      } catch (_) {
      }
    }, 150);
  }

  _invalidateTileWaterMaskCachesForTile(tileDoc, changes = null) {
    // Ensure we don't keep using stale per-tile _Water mask textures when a tile changes.
    try {
      const src = (changes?.texture?.src !== undefined) ? changes.texture.src : tileDoc?.texture?.src;
      const parts = this._splitUrl(src);
      if (parts?.pathNoExt) this._tileWaterMaskResolvedUrl.delete(parts.pathNoExt);
    } catch (_) {
    }

    // If we have a resolved URL cached for this tile base, drop the texture cache entry too.
    // (Resolved URL cache stores url-by-base; if cleared above, we can't reliably look it up.)
    try {
      // Conservative approach: clear all per-tile water mask caches. This path is not hot.
      this._tileWaterMaskCache?.clear?.();
      this._tileWaterMaskPromises?.clear?.();
      this._tileWaterMaskResolvePromises?.clear?.();
    } catch (_) {
    }
  }

  setSpecularEffect(specularEffect) {
    this.specularEffect = specularEffect || null;
  }

  _getTileSpecularMode(tileDoc) {
    // Tri-state:
    // - true  => force enable and attempt to bind
    // - false => force disable and never bind
    // - unset => auto-detect by probing for a matching _Specular file
    try {
      const f = tileDoc?.flags?.['map-shine-advanced'];
      if (f?.enableSpecular === true) return 'enabled';
      if (f?.enableSpecular === false) return 'disabled';
      return 'auto';
    } catch (_) {
      return 'auto';
    }
  }

  _tileAllowsSpecular(tileDoc) {
    return this._getTileSpecularMode(tileDoc) !== 'disabled';
  }

  _deriveMaskPath(src, suffix) {
    const s = String(src || '');
    if (!s) return null;
    const q = s.indexOf('?');
    const base = q >= 0 ? s.slice(0, q) : s;
    const query = q >= 0 ? s.slice(q) : '';

    const dot = base.lastIndexOf('.');
    if (dot < 0) return null;
    const path = base.slice(0, dot);
    const ext = base.slice(dot);
    return `${path}${suffix}${ext}${query}`;
  }

  _splitUrl(src) {
    const s = String(src || '');
    if (!s) return null;
    const q = s.indexOf('?');
    const base = q >= 0 ? s.slice(0, q) : s;
    const query = q >= 0 ? s.slice(q) : '';
    const dot = base.lastIndexOf('.');
    if (dot < 0) return null;
    return {
      base,
      query,
      pathNoExt: base.slice(0, dot),
      ext: base.slice(dot)
    };
  }

  _getDirectoryFromPath(path) {
    try {
      const s = String(path || '');
      const i = s.lastIndexOf('/');
      if (i < 0) return '';
      return s.slice(0, i + 1);
    } catch (_) {
      return '';
    }
  }

  async _listDirectoryFiles(directory) {
    const dir = String(directory || '').trim();
    if (!dir) return [];

    if (this._dirFileListCache.has(dir)) {
      return this._dirFileListCache.get(dir) || [];
    }

    if (this._dirFileListPromises.has(dir)) {
      return this._dirFileListPromises.get(dir);
    }

    const p = (async () => {
      try {
        const filePickerImpl = globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
        const filePicker = filePickerImpl ?? globalThis.FilePicker;
        if (!filePicker) throw new Error('FilePicker is not available');
        const result = await filePicker.browse('data', dir);
        const files = Array.isArray(result?.files) ? result.files : [];
        this._dirFileListCache.set(dir, files);
        return files;
      } catch (_) {
        // If FilePicker fails (permissions, non-data source, etc.) fall back to fetch probing.
        this._dirFileListCache.set(dir, []);
        return [];
      } finally {
        this._dirFileListPromises.delete(dir);
      }
    })();

    this._dirFileListPromises.set(dir, p);
    return p;
  }

  async _fileExistsViaFilePicker(pathNoQuery) {
    const p = String(pathNoQuery || '');
    if (!p) return false;
    const dir = this._getDirectoryFromPath(p);
    if (!dir) return false;
    const files = await this._listDirectoryFiles(dir);
    if (!files || !files.length) return false;
    return files.includes(p);
  }

  async _resolveTileWaterMaskUrl(tileDoc) {
    const src = tileDoc?.texture?.src;
    const parts = this._splitUrl(src);
    if (!parts) return null;

    const key = parts.pathNoExt;
    if (this._tileWaterMaskResolvedUrl.has(key)) {
      return this._tileWaterMaskResolvedUrl.get(key);
    }

    if (this._tileWaterMaskResolvePromises.has(key)) {
      return this._tileWaterMaskResolvePromises.get(key);
    }

    const p = (async () => {
      const exts = [parts.ext, '.webp', '.png', '.jpg', '.jpeg'];
      const uniqueExts = [];
      for (const e of exts) {
        const ee = String(e || '').toLowerCase();
        if (!ee) continue;
        if (!uniqueExts.includes(ee)) uniqueExts.push(ee);
      }

      // Try without query first (most authored masks won't carry cache-buster query strings).
      // Then try with query as a fallback.
      const candidates = [];
      for (const ext of uniqueExts) {
        const baseNoQuery = `${parts.pathNoExt}_Water${ext}`;
        candidates.push(baseNoQuery);
        if (parts.query) candidates.push(`${baseNoQuery}${parts.query}`);
      }

      // Strict no-probing policy: do not make any network requests for optional
      // masks unless we can confirm the file exists via FilePicker directory listing.
      let hasFilePickerListing = false;
      try {
        const dir = this._getDirectoryFromPath(parts.base);
        const files = await this._listDirectoryFiles(dir);
        hasFilePickerListing = Array.isArray(files) && files.length > 0;
      } catch (_) {
        hasFilePickerListing = false;
      }

      if (!hasFilePickerListing) {
        // Cannot confirm existence without probing; do nothing.
        this._tileWaterMaskResolvedUrl.set(key, null);
        return null;
      }

      for (let i = 0; i < candidates.length; i++) {
        const url = candidates[i];
        try {
          if (hasFilePickerListing) {
            // Only probe the no-query form against the directory listing.
            const noQuery = url.split('?')[0];
            const exists = await this._fileExistsViaFilePicker(noQuery);
            if (!exists) continue;
          }
          const tex = await this.loadTileTexture(url, { role: 'DATA_MASK' });
          if (tex) {
            this._tileWaterMaskCache.set(url, tex);
            this._tileWaterMaskResolvedUrl.set(key, url);
            return url;
          }
        } catch (_) {
        }
      }

      this._tileWaterMaskResolvedUrl.set(key, null);
      return null;
    })();

    this._tileWaterMaskResolvePromises.set(key, p);
    try {
      return await p;
    } finally {
      this._tileWaterMaskResolvePromises.delete(key);
    }
  }

  async loadTileWaterMaskTexture(tileDoc) {
    const resolvedUrl = await this._resolveTileWaterMaskUrl(tileDoc);
    if (!resolvedUrl) return null;

    const cached = this._tileWaterMaskCache.get(resolvedUrl);
    if (cached) {
      // Ensure correct color space even for cached textures
      const THREE = window.THREE;
      if (THREE && cached.colorSpace !== THREE.NoColorSpace) {
        cached.colorSpace = THREE.NoColorSpace;
        cached.needsUpdate = true;
      }
      return cached;
    }

    const pending = this._tileWaterMaskPromises.get(resolvedUrl);
    if (pending) return pending;

    const p = this.loadTileTexture(resolvedUrl, { role: 'DATA_MASK' }).then((tex) => {
      if (!tex) return null;

      // _Water is a data mask, not color. Ensure we don't apply sRGB decoding.
      const THREE = window.THREE;
      if (THREE) {
        tex.colorSpace = THREE.NoColorSpace;
        tex.needsUpdate = true;
      }

      this._tileWaterMaskCache.set(resolvedUrl, tex);
      return tex;
    }).catch(() => null).finally(() => {
      this._tileWaterMaskPromises.delete(resolvedUrl);
    });

    this._tileWaterMaskPromises.set(resolvedUrl, p);
    return p;
  }

  async _resolveTileSpecularMaskUrl(tileDoc) {
    if (!this._tileAllowsSpecular(tileDoc)) return null;
    const src = tileDoc?.texture?.src;
    const parts = this._splitUrl(src);
    if (!parts) return null;

    const key = parts.pathNoExt;
    if (this._tileSpecularMaskResolvedUrl.has(key)) {
      return this._tileSpecularMaskResolvedUrl.get(key);
    }

    if (this._tileSpecularMaskResolvePromises.has(key)) {
      return this._tileSpecularMaskResolvePromises.get(key);
    }

    const p = (async () => {
      // Specular masks are optional per tile (opt-in via enableSpecular), but when
      // enabled we should tolerate the mask being authored in a different file
      // format than the tile texture (png vs jpg/webp, etc.).
      const exts = [
        String(parts.ext || '').toLowerCase(),
        '.webp',
        '.png',
        '.jpg',
        '.jpeg'
      ];
      const uniqueExts = [];
      for (const e of exts) {
        const ee = String(e || '').toLowerCase();
        if (!ee) continue;
        if (!uniqueExts.includes(ee)) uniqueExts.push(ee);
      }

      // Try without query first (most authored masks won't carry cache-buster query strings).
      // Then try with query as a fallback.
      const candidates = [];
      for (const ext of uniqueExts) {
        const baseNoQuery = `${parts.pathNoExt}_Specular${ext}`;
        candidates.push(baseNoQuery);
        if (parts.query) candidates.push(`${baseNoQuery}${parts.query}`);
      }

      // Strict no-probing policy: do not make any network requests for optional
      // masks unless we can confirm the file exists via FilePicker directory listing.
      let hasFilePickerListing = false;
      try {
        const dir = this._getDirectoryFromPath(parts.base);
        const files = await this._listDirectoryFiles(dir);
        hasFilePickerListing = Array.isArray(files) && files.length > 0;
      } catch (_) {
        hasFilePickerListing = false;
      }

      if (!hasFilePickerListing) {
        // Cannot confirm existence without probing; do nothing.
        this._tileSpecularMaskResolvedUrl.set(key, null);
        return null;
      }

      for (let i = 0; i < candidates.length; i++) {
        const url = candidates[i];
        try {
          if (hasFilePickerListing) {
            // Only probe the no-query form against the directory listing.
            const noQuery = url.split('?')[0];
            const exists = await this._fileExistsViaFilePicker(noQuery);
            if (!exists) continue;
          }
          const tex = await this.loadTileTexture(url, { role: 'DATA_MASK' });
          if (tex) {
            this._tileSpecularMaskCache.set(url, tex);
            this._tileSpecularMaskResolvedUrl.set(key, url);
            return url;
          }
        } catch (_) {
        }
      }

      this._tileSpecularMaskResolvedUrl.set(key, null);

      try {
        log.debug(`No _Specular mask found for enabled tile ${tileDoc?.id || '(unknown)'}: ${candidates.join(', ')}`);
      } catch (_) {
      }

      return null;
    })();

    this._tileSpecularMaskResolvePromises.set(key, p);
    try {
      return await p;
    } finally {
      this._tileSpecularMaskResolvePromises.delete(key);
    }
  }

  async loadTileSpecularMaskTexture(tileDoc) {
    const resolvedUrl = await this._resolveTileSpecularMaskUrl(tileDoc);
    if (!resolvedUrl) return null;

    const cached = this._tileSpecularMaskCache.get(resolvedUrl);
    if (cached) {
      const THREE = window.THREE;
      if (THREE && cached.colorSpace !== THREE.NoColorSpace) {
        cached.colorSpace = THREE.NoColorSpace;
        cached.needsUpdate = true;
      }
      return cached;
    }

    const pending = this._tileSpecularMaskPromises.get(resolvedUrl);
    if (pending) return pending;

    const p = this.loadTileTexture(resolvedUrl, { role: 'DATA_MASK' }).then((tex) => {
      if (!tex) return null;
      const THREE = window.THREE;
      if (THREE) {
        tex.colorSpace = THREE.NoColorSpace;
        tex.needsUpdate = true;
      }
      this._tileSpecularMaskCache.set(resolvedUrl, tex);
      return tex;
    }).catch(() => null).finally(() => {
      this._tileSpecularMaskPromises.delete(resolvedUrl);
    });

    this._tileSpecularMaskPromises.set(resolvedUrl, p);
    return p;
  }

  _autoDetectWaterOccludersForAllTiles() {
    // Retry auto-detection scene-wide (useful after initial tile load settles).
    // This ensures every tile has a chance to resolve its own _Water mask.
    for (const { sprite, tileDoc } of this.tileSprites.values()) {
      if (!sprite || !tileDoc) continue;

      // Respect explicit overrides.
      const state = sprite.userData?._autoOccludesWaterState;
      if (state === 'overridden' || state === 'enabled' || state === 'pending') continue;

      // Trigger detection by clearing state and re-running transform.
      sprite.userData._autoOccludesWaterState = null;
      try {
        this.updateSpriteTransform(sprite, tileDoc);
      } catch (_) {
      }
    }
  }

  _createWaterOccluderMaterial(tileTexture, waterMaskTexture) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        tTile: { value: tileTexture || null },
        uHasTile: { value: tileTexture ? 1.0 : 0.0 },
        tWaterMask: { value: waterMaskTexture || null },
        uHasWaterMask: { value: waterMaskTexture ? 1.0 : 0.0 },
        uOpacity: { value: 1.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tTile;
        uniform float uHasTile;
        uniform sampler2D tWaterMask;
        uniform float uHasWaterMask;
        uniform float uOpacity;
        varying vec2 vUv;

        float msLuminance(vec3 c) {
          return dot(c, vec3(0.299, 0.587, 0.114));
        }

        void main() {
          float aTile = 1.0;
          if (uHasTile > 0.5) {
            aTile = texture2D(tTile, vUv).a;
          }

          float w = 0.0;
          if (uHasWaterMask > 0.5) {
            // Tile _Water masks are luminance masks (in RGB) and may also have alpha.
            // Use luminance as the primary mask and multiply by alpha to respect any
            // authored transparency in the mask.
            vec4 m = texture2D(tWaterMask, vUv);
            w = msLuminance(m.rgb) * m.a;
          }

          float a = clamp(aTile * uOpacity, 0.0, 1.0);
          a *= (1.0 - clamp(w, 0.0, 1.0));
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      toneMapped: false
    });

    return material;
  }

  _estimateWaterMaskCoverage01(maskTex, cacheKey = null) {
    // Returns average mask coverage in [0..1], where 1 means "water everywhere".
    // Uses a downsampled CPU readback to avoid heavy per-pixel work.
    try {
      if (cacheKey && this._waterMaskCoverageCache.has(cacheKey)) {
        return this._waterMaskCoverageCache.get(cacheKey);
      }
    } catch (_) {
    }

    let coverage = null;
    try {
      const image = maskTex?.image;
      const w = image?.width ?? 0;
      const h = image?.height ?? 0;
      if (!image || w <= 0 || h <= 0) return null;

      const canvasEl = document.createElement('canvas');
      // Keep this small; we only need an average.
      const outW = Math.min(64, w);
      const outH = Math.min(64, h);
      canvasEl.width = outW;
      canvasEl.height = outH;
      const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;

      ctx.clearRect(0, 0, outW, outH);
      ctx.drawImage(image, 0, 0, outW, outH);
      const img = ctx.getImageData(0, 0, outW, outH);
      const data = img?.data;
      if (!data) return null;

      let sum = 0;
      const n = outW * outH;
      for (let i = 0; i < data.length; i += 4) {
        // Luminance * alpha
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const a = data[i + 3] / 255;
        const lum = (0.299 * r + 0.587 * g + 0.114 * b);
        sum += lum * a;
      }
      coverage = n > 0 ? (sum / n) : null;
    } catch (_) {
      coverage = null;
    }

    try {
      if (cacheKey && coverage !== null && Number.isFinite(coverage)) {
        this._waterMaskCoverageCache.set(cacheKey, coverage);
      }
    } catch (_) {
    }
    return coverage;
  }

  _ensureWaterOccluderMesh(spriteData, tileDoc) {
    const THREE = window.THREE;
    if (!THREE) return;

    const sprite = spriteData?.sprite;
    if (!sprite) return;

    const occludesWater = !!sprite.userData?.occludesWater;
    const existing = sprite.userData.waterOccluderMesh;

    if (!occludesWater) {
      if (existing) {
        try {
          this._getWaterOccluderScene().remove(existing);
          existing.geometry?.dispose?.();
          existing.material?.dispose?.();
        } catch (_) {
        }
        sprite.userData.waterOccluderMesh = null;
      }
      return;
    }

    if (existing) {
      // Keep uniforms in sync in case the mesh was created before the tile
      // texture finished loading.
      const tex = sprite.material?.map ?? null;
      if (existing.material?.uniforms?.tTile) {
        existing.material.uniforms.tTile.value = tex;
        if (existing.material.uniforms.uHasTile) {
          existing.material.uniforms.uHasTile.value = tex ? 1.0 : 0.0;
        }
      }
      existing.visible = !!sprite.visible;
      return;
    }

    const geom = new THREE.PlaneGeometry(1, 1);
    const mat = this._createWaterOccluderMaterial(sprite.material?.map ?? null, null);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.matrixAutoUpdate = false;
    mesh.layers.set(WATER_OCCLUDER_LAYER);
    mesh.visible = !!sprite.visible;
    mesh.renderOrder = 999;
    this._getWaterOccluderScene().add(mesh);
    sprite.userData.waterOccluderMesh = mesh;

    this.loadTileWaterMaskTexture(tileDoc).then((maskTex) => {
      const m = sprite.userData?.waterOccluderMesh;
      if (!m || !m.material?.uniforms) return;

      // Defensive heuristic:
      // If the tile's _Water mask is effectively "all water" (nearly white everywhere),
      // then using it for occlusion would produce near-zero occluder alpha and cause
      // WaterEffect tint/distortion to apply across the whole tile. That makes props
      // (boats) look like they're not receiving the same grading as the scene.
      //
      // In that degenerate case, ignore the mask and fall back to tile alpha occlusion.
      let effectiveMask = maskTex;
      try {
        const resolvedUrl = spriteData?.resolvedWaterMaskUrl ?? null;
        const coverage = (maskTex && maskTex.image) ? this._estimateWaterMaskCoverage01(maskTex, resolvedUrl || null) : null;
        if (coverage !== null && Number.isFinite(coverage) && coverage > 0.98) {
          effectiveMask = null;
        }
      } catch (_) {
        effectiveMask = maskTex;
      }

      m.material.uniforms.tWaterMask.value = effectiveMask;
      m.material.uniforms.uHasWaterMask.value = effectiveMask ? 1.0 : 0.0;
    }).catch(() => {
    });
  }

  _updateWaterOccluderMeshTransform(sprite, tileDoc) {
    const THREE = window.THREE;
    if (!THREE) return;

    const mesh = sprite?.userData?.waterOccluderMesh;
    if (!mesh) return;

    mesh.position.copy(sprite.position);
    mesh.scale.set(tileDoc.width, tileDoc.height, 1);
    mesh.rotation.set(0, 0, 0);
    if (tileDoc.rotation) {
      mesh.rotation.z = THREE.MathUtils.degToRad(tileDoc.rotation);
    }
    mesh.updateMatrix();

    if (mesh.material?.uniforms?.uOpacity) {
      const a = ('alpha' in tileDoc) ? tileDoc.alpha : 1.0;
      mesh.material.uniforms.uOpacity.value = Number.isFinite(a) ? a : 1.0;
    }
  }

  /**
   * Set the WindowLightEffect reference for overhead tile lighting
   * @param {WindowLightEffect} effect
   */
  setWindowLightEffect(effect) {
    this.windowLightEffect = effect;
    // Clear cached mask data so it gets re-extracted
    this._windowMaskData = null;
    this._windowMaskExtractFailed = false;
    this._outdoorsMaskData = null;
    this._outdoorsMaskExtractFailed = false;
    log.debug('WindowLightEffect linked to TileManager');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) {
      log.warn('TileManager already initialized');
      return;
    }

    this.setupHooks();
    this.initialized = true;
    
    log.info('TileManager initialized');
  }

  /**
   * Set up Foundry VTT hooks for tile synchronization
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    // NOTE: We intentionally do NOT register a canvasReady hook here.
    // canvas-replacement.js explicitly calls syncAllTiles() after initialize(),
    // so a canvasReady hook would cause double-creation of tile sprites,
    // leaving orphan sprites in the scene that don't respond to updates.

    // Create new tile
    this._hookIds.push(['createTile', Hooks.on('createTile', (tileDoc, options, userId) => {
      log.debug(`Tile created: ${tileDoc.id}`);
      this.createTileSprite(tileDoc);

      this._invalidateTileWaterMaskCachesForTile(tileDoc);
      this._scheduleWaterCacheInvalidation(tileDoc?.id);
    })]);

    // Update existing tile
    this._hookIds.push(['updateTile', Hooks.on('updateTile', (tileDoc, changes, options, userId) => {
      log.debug(`Tile updated: ${tileDoc.id}`, changes);
      this.updateTileSprite(tileDoc, changes);

      // Only invalidate if the update could affect tile water contributions.
      const keys = changes && typeof changes === 'object' ? Object.keys(changes) : null;
      const relevant = !keys || keys.some((k) => (
        k === 'x' || k === 'y' || k === 'width' || k === 'height' || k === 'rotation' || k === 'texture' || k === 'flags'
      ));
      if (relevant) {
        this._invalidateTileWaterMaskCachesForTile(tileDoc, changes);
        this._scheduleWaterCacheInvalidation(tileDoc?.id);
      }
    })]);

    // Delete tile
    this._hookIds.push(['deleteTile', Hooks.on('deleteTile', (tileDoc, options, userId) => {
      log.debug(`Tile deleted: ${tileDoc.id}`);
      this.removeTileSprite(tileDoc.id);

      this._invalidateTileWaterMaskCachesForTile(tileDoc);
      this._scheduleWaterCacheInvalidation(tileDoc?.id);
    })]);

    // Refresh tile (rendering changes)
    this._hookIds.push(['refreshTile', Hooks.on('refreshTile', (tile) => {
      log.debug(`Tile refreshed: ${tile.id}`);
      this.refreshTileSprite(tile.document);
    })]);

    // Scene updates (foregroundElevation changes)
    this._hookIds.push(['updateScene', Hooks.on('updateScene', (scene, changes) => {
      if (scene.id !== canvas.scene?.id) return;
      
      if ('foregroundElevation' in changes) {
        log.info('Foreground elevation changed, refreshing all tile transforms');
        for (const { sprite, tileDoc } of this.tileSprites.values()) {
          this.updateSpriteTransform(sprite, tileDoc);
        }
      }
    })]);

    this.hooksRegistered = true;
    log.debug('Foundry hooks registered');
  }

  /**
   * Set global visibility of all 3D tiles
   * Used when switching between Gameplay Mode (Visible) and Map Maker Mode (Hidden)
   * @param {boolean} visible 
   * @public
   */
  setVisibility(visible) {
    this._globalVisible = !!visible;
    for (const { sprite, tileDoc } of this.tileSprites.values()) {
      if (!sprite) continue;
      
      // If turning ON, respect the tile's document hidden state
      if (this._globalVisible) {
        sprite.visible = !tileDoc.hidden;
      } else {
        // If turning OFF, always hide
        sprite.visible = false;
      }
    }
  }

  /**
   * Sync all existing tiles from Foundry to THREE.js.
   * Called explicitly by canvas-replacement.js after initialize().
   * @public
   */
  syncAllTiles() {
    if (DISABLE_TILE_UPDATES) {
      log.warn('TileManager disabled by DISABLE_TILE_UPDATES flag (perf testing).');
      return;
    }
    if (!canvas || !canvas.scene || !canvas.scene.tiles) {
      log.warn('Canvas or scene tiles not available');
      return;
    }

    const tiles = canvas.scene.tiles;
    log.info(`Syncing ${tiles.size} tiles`);

    // Clear existing if any (though usually empty on init)
    if (this.tileSprites.size > 0) {
      this.dispose(false); // false = don't clear cache
    }

    this._initialLoad.active = true;
    this._initialLoad.pendingAll = 0;
    this._initialLoad.pendingOverhead = 0;
    this._initialLoad.trackedIds = new Set();

    const foregroundElevation = Number.isFinite(canvas.scene.foregroundElevation)
      ? canvas.scene.foregroundElevation
      : 0;
    for (const tileDoc of tiles) {
      const tileId = tileDoc?.id;
      if (tileId) {
        this._initialLoad.trackedIds.add(tileId);
        this._initialLoad.pendingAll++;
        // Overhead detection:
        // - Preferred (v12+): elevation > foregroundElevation
        // - Back-compat: tileDoc.overhead (some worlds/systems still set this)
        const elev = Number.isFinite(tileDoc.elevation) ? tileDoc.elevation : 0;
        const isOverhead = (elev > foregroundElevation) || (tileDoc.overhead === true);
        if (isOverhead) this._initialLoad.pendingOverhead++;
      }
      this.createTileSprite(tileDoc);
    }

    this._notifyInitialLoadWaiters();
  }

  _notifyInitialLoadWaiters() {
    if (!this._initialLoad?.waiters?.length) return;

    const doneAll = (this._initialLoad.pendingAll <= 0);
    const doneOverhead = (this._initialLoad.pendingOverhead <= 0);

    if (doneAll) {
      this._initialLoad.active = false;
    }

    const remaining = [];
    for (const w of this._initialLoad.waiters) {
      if (!w) continue;
      const ok = w.overheadOnly ? doneOverhead : doneAll;
      if (ok) {
        try { w.resolve(); } catch (_) {}
      } else {
        remaining.push(w);
      }
    }
    this._initialLoad.waiters = remaining;
  }

  _markInitialTileLoaded(tileId, wasOverhead) {
    if (!this._initialLoad.active) return;
    if (!tileId) return;
    if (!this._initialLoad.trackedIds?.has(tileId)) return;

    this._initialLoad.trackedIds.delete(tileId);
    this._initialLoad.pendingAll = Math.max(0, this._initialLoad.pendingAll - 1);
    if (wasOverhead) {
      this._initialLoad.pendingOverhead = Math.max(0, this._initialLoad.pendingOverhead - 1);
    }

    this._notifyInitialLoadWaiters();
  }

  waitForInitialTiles(opts = undefined) {
    const overheadOnly = !!opts?.overheadOnly;
    const timeoutMs = Number.isFinite(opts?.timeoutMs) ? Math.max(0, opts.timeoutMs) : 0;

    const doneAll = (this._initialLoad.pendingAll <= 0);
    const doneOverhead = (this._initialLoad.pendingOverhead <= 0);

    if (overheadOnly ? doneOverhead : doneAll) {
      return Promise.resolve();
    }

    let timeoutId = null;
    return new Promise((resolve) => {
      this._initialLoad.waiters.push({ resolve, overheadOnly });
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          try { resolve(); } catch (_) {}
        }, timeoutMs);
      }
    }).finally(() => {
      if (timeoutId) {
        try { clearTimeout(timeoutId); } catch (_) {}
      }
    });
  }

  /**
   * Get all overhead tile sprites (for interaction/hover)
   * @returns {THREE.Sprite[]}
   * @public
   */
  getOverheadTileSprites() {
    const sprites = [];
    for (const { sprite } of this.tileSprites.values()) {
      if (sprite.userData.isOverhead) sprites.push(sprite);
    }
    return sprites;
  }

  /**
   * Toggle hover-based hiding for a specific tile. When un-hiding, normal
   * visibility rules (GM hidden, alpha, etc.) are re-applied.
   * @param {string} tileId
   * @param {boolean} hidden
   * @public
   */
  setTileHoverHidden(tileId, hidden) {
    const data = this.tileSprites.get(tileId);
    if (!data) return;

    // Hover-hide is an overhead-only UX feature.
    // If a tile is not overhead, ensure it cannot be left permanently hidden
    // due to a stale hoverHidden flag from a previous overhead classification.
    try {
      const isOverhead = !!data?.sprite?.userData?.isOverhead;
      if (!isOverhead) {
        data.hoverHidden = false;
        // Re-apply normal visibility immediately in case the tile was stuck at opacity 0.
        try {
          if (data.sprite && data.tileDoc) this.updateSpriteVisibility(data.sprite, data.tileDoc);
        } catch (_) {
        }
        return;
      }
    } catch (_) {
    }

    data.hoverHidden = !!hidden;

    // Hover-hide uses a smooth alpha animation in update(). If RenderLoop is
    // currently idle-throttled, the fade can appear to "start" and then stall
    // visually. Request a short continuous-render window so the fade completes.
    try {
      const rl = window.MapShine?.renderLoop;
      // Fade speed in update() is 0.5 alpha/sec, so a full 0->1 takes ~2000ms.
      // Add margin for throttling jitter.
      rl?.requestContinuousRender?.(2500);
    } catch (_) {
    }
  }

  /**
   * Determine if a given world-space point hits an opaque pixel of a tile
   * sprite's texture (alpha > 0.5).
   * @param {{sprite: THREE.Sprite, tileDoc: TileDocument}} data
   * @param {number} worldX
   * @param {number} worldY
   * @returns {boolean}
   * @public
   */
  isWorldPointOpaque(data, worldX, worldY) {
    const { sprite, tileDoc } = data;
    const texture = sprite.material?.map;
    const image = texture?.image;
    if (!texture || !image) return false;

    const width = tileDoc.width;
    const height = tileDoc.height;
    const scaleX = tileDoc.texture?.scaleX ?? 1;
    const scaleY = tileDoc.texture?.scaleY ?? 1;

    // Use displayed size for UV mapping.
    const dispW = width * Math.abs(scaleX || 1);
    const dispH = height * Math.abs(scaleY || 1);

    // Map world coords back to Foundry top-left space
    const sceneHeight = canvas.dimensions?.height || 10000;
    const foundryX = worldX;
    const foundryY = sceneHeight - worldY;

    // Convert to tile local space (account for rotation around center)
    const centerX = tileDoc.x + width / 2;
    const centerY = tileDoc.y + height / 2;
    const dx = foundryX - centerX;
    const dy = foundryY - centerY;

    const rotDeg = tileDoc.rotation || 0;
    const r = (-rotDeg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;

    // Convert into displayed local space (scaled around center).
    const localX = lx + dispW / 2;
    const localY = ly + dispH / 2;

    let u = localX / dispW;
    let v = localY / dispH;

    if (scaleX < 0) u = 1 - u;
    if (scaleY < 0) v = 1 - v;

    if (u < 0 || u > 1 || v < 0 || v > 1) return false;

    const key = (() => {
      try {
        const src = String(image?.src || '');
        if (src) {
          const q = src.indexOf('?');
          return q >= 0 ? src.slice(0, q) : src;
        }
      } catch (_) {
      }
      return tileDoc.id;
    })();

    let mask = this.alphaMaskCache.get(key);
    if (!mask) {
      try {
        const canvasEl = document.createElement('canvas');
        canvasEl.width = image.width;
        canvasEl.height = image.height;
        const ctx = canvasEl.getContext('2d');
        if (!ctx) return true; // Fallback: treat as opaque
        ctx.drawImage(image, 0, 0);
        const imgData = ctx.getImageData(0, 0, image.width, image.height);
        mask = { width: image.width, height: image.height, data: imgData.data };
        this.alphaMaskCache.set(key, mask);
      } catch (e) {
        // If we fail to build a mask, default to opaque to avoid breaking UX
        return true;
      }
    }

    const ix = Math.floor(u * (mask.width - 1));
    const iy = Math.floor(v * (mask.height - 1));
    const index = (iy * mask.width + ix) * 4;
    const alpha = mask.data[index + 3] / 255;

    return alpha > 0.5;
  }

  isUvOpaque(data, uv) {
    const { sprite, tileDoc } = data;
    const texture = sprite.material?.map;
    const image = texture?.image;
    if (!texture || !image || !uv) return false;

    const u = uv.x;
    const v = 1 - uv.y;

    if (u < 0 || u > 1 || v < 0 || v > 1) return false;

    const key = (() => {
      try {
        const src = String(image?.src || '');
        if (src) {
          const q = src.indexOf('?');
          return q >= 0 ? src.slice(0, q) : src;
        }
      } catch (_) {
      }
      return tileDoc.id;
    })();

    let mask = this.alphaMaskCache.get(key);
    if (!mask) {
      try {
        const canvasEl = document.createElement('canvas');
        canvasEl.width = image.width;
        canvasEl.height = image.height;
        const ctx = canvasEl.getContext('2d');
        if (!ctx) return true;
        ctx.drawImage(image, 0, 0);
        const imgData = ctx.getImageData(0, 0, image.width, image.height);
        mask = { width: image.width, height: image.height, data: imgData.data };
        this.alphaMaskCache.set(key, mask);
      } catch (e) {
        return true;
      }
    }

    const ix = Math.floor(u * (mask.width - 1));
    const iy = Math.floor(v * (mask.height - 1));
    const index = (iy * mask.width + ix) * 4;
    const alpha = mask.data[index + 3] / 255;

    return alpha > 0.5;
  }

  /**
   * Update tile states (occlusion animation)
   * @param {Object} timeInfo - Time information
   * @public
   */
  update(timeInfo) {
    if (DISABLE_TILE_UPDATES) return;

    // If tiles are globally hidden (e.g. TilesLayer active in PIXI), do not run
    // occlusion/hover fade updates. This prevents hidden tiles from being
    // re-shown by later updateSpriteVisibility calls.
    if (!this._globalVisible) return;

    const dt = timeInfo.delta;
    const canvasTokens = canvas.tokens?.placeables || [];
    // We care about controlled tokens or the observed token
    const sources = canvas.tokens?.controlled.length > 0 
      ? canvas.tokens.controlled 
      : (canvas.tokens?.observed || []);

    // Calculate global tile tint based on darkness
    // This matches the logic in SpecularEffect to darken elements at night
    const THREE = window.THREE;
    
    // PERFORMANCE: Reuse color objects instead of allocating every frame
    if (!this._globalTint) {
      this._globalTint = new THREE.Color(1, 1, 1);
      this._tempDaylight = new THREE.Color();
      this._tempDarkness = new THREE.Color();
      this._tempAmbient = new THREE.Color();
    }
    const globalTint = this._globalTint.set(1, 1, 1);

    let skipDarknessTint = false;

    // If LightingEffect is active, tile lighting is handled by the lighting composite.
    // Keep tile base colors neutral so lights can punch through the global darkness.
    try {
      const le = window.MapShine?.lightingEffect;
      if (le && le.enabled) {
        globalTint.set(1, 1, 1);
        skipDarknessTint = true;

        const tintKey = 0xffffff;
        if (this._tintDirty || tintKey !== this._lastTintKey) {
          this._lastTintKey = tintKey;
          this._tintDirty = false;

          for (const data of this.tileSprites.values()) {
            const { sprite } = data;
            if (sprite && sprite.material) {
              sprite.material.color.copy(globalTint);
            }
          }
        }

        // Store global tint for window light application (avoid per-tile cloning)
        this._frameGlobalTint = globalTint;
        // Continue with occlusion updates below; tinting is handled.
      }
    } catch (_) {
    }
    
    if (!skipDarknessTint) try {
      const scene = canvas?.scene;
      const env = canvas?.environment;
      
      if (scene?.environment?.darknessLevel !== undefined) {
        let darkness = scene.environment.darknessLevel;
        const le = window.MapShine?.lightingEffect;
        if (le && typeof le.getEffectiveDarkness === 'function') {
          darkness = le.getEffectiveDarkness();
        }
        
        // PERFORMANCE: Reuse color objects, mutate in place
        const setThreeColor = (target, src, def) => {
            try {
                if (!src) { target.set(def); return target; }
                if (src instanceof THREE.Color) { target.copy(src); return target; }
                if (src.rgb) { target.setRGB(src.rgb[0], src.rgb[1], src.rgb[2]); return target; }
                if (Array.isArray(src)) { target.setRGB(src[0], src[1], src[2]); return target; }
                target.set(src); return target;
            } catch (e) { target.set(def); return target; }
        };

        const daylight = setThreeColor(this._tempDaylight, env?.colors?.ambientDaylight, 0xffffff);
        const darknessColor = setThreeColor(this._tempDarkness, env?.colors?.ambientDarkness, 0x242448);
        
        // Calculate ambient tint (mix of day/night colors) - reuse _tempAmbient
        this._tempAmbient.copy(daylight).lerp(darknessColor, darkness);
        
        // Calculate light level (brightness falloff)
        // User Request: "I think at darkness 1 you need to darken the scene by something like 0.75"
        // So minBrightness should be around 0.25 (1.0 - 0.75)
        // We clamp to ensure it doesn't go pitch black.
        const lightLevel = Math.max(1.0 - darkness, 0.25);
        
        // Final tint = ambient color * brightness
        globalTint.copy(this._tempAmbient).multiplyScalar(lightLevel);
      }
    } catch(e) {
      // Fallback to white if environment lookup fails
    }

    if (!skipDarknessTint) {
      const tr = Math.max(0, Math.min(255, (globalTint.r * 255 + 0.5) | 0));
      const tg = Math.max(0, Math.min(255, (globalTint.g * 255 + 0.5) | 0));
      const tb = Math.max(0, Math.min(255, (globalTint.b * 255 + 0.5) | 0));
      const tintKey = (tr << 16) | (tg << 8) | tb;

      if (this._tintDirty || tintKey !== this._lastTintKey) {
        this._lastTintKey = tintKey;
        this._tintDirty = false;

        for (const data of this.tileSprites.values()) {
          const { sprite } = data;
          if (!sprite.userData.isOverhead && sprite.material) {
            sprite.material.color.copy(globalTint);
          }
        }
      }
    }

    let anyHoverHidden = false;

    // Store global tint for window light application (avoid per-tile cloning)
    this._frameGlobalTint = globalTint;

    let anyOverheadFadeInProgress = false;

    for (const tileId of this._overheadTileIds) {
      const data = this.tileSprites.get(tileId);
      if (!data) continue;

      const { sprite, tileDoc, hoverHidden } = data;
      if (sprite.material) {
        // Overhead tiles should respect the same outdoors brightness/dim response
        // as the main LightingEffect composite (otherwise outdoor roofs stay too
        // bright as darkness increases).
        let overheadTint = globalTint;
        if (!skipDarknessTint) try {
          const le = window.MapShine?.lightingEffect;
          if (le && le.params && typeof le.params.outdoorBrightness === 'number' && weatherController && typeof weatherController.getRoofMaskIntensity === 'function') {
            const d = canvas.dimensions;
            const sceneX = d?.sceneRect?.x ?? d?.sceneX ?? 0;
            const sceneY = d?.sceneRect?.y ?? d?.sceneY ?? 0;
            const sceneW = d?.sceneRect?.width ?? d?.sceneWidth ?? d?.width ?? 10000;
            const sceneH = d?.sceneRect?.height ?? d?.sceneHeight ?? d?.height ?? 10000;

            // Tile docs are in Foundry top-left (Y-down) space.
            // The authored _Outdoors mask is also in sceneRect top-left UV space.
            const tileCenterX = tileDoc.x + tileDoc.width / 2;
            const tileCenterY = tileDoc.y + tileDoc.height / 2;
            const u = (tileCenterX - sceneX) / sceneW;
            const v = (tileCenterY - sceneY) / sceneH;

            const outdoorStrength = weatherController.getRoofMaskIntensity(u, v);
            if (outdoorStrength > 0.001) {
              let darkness = canvas?.scene?.environment?.darknessLevel ?? 0.0;
              if (typeof le.getEffectiveDarkness === 'function') {
                darkness = le.getEffectiveDarkness();
              }

              const dayBoost = le.params.outdoorBrightness;
              const nightDim = 2.0 - le.params.outdoorBrightness;
              const outdoorMultiplier = (1.0 - darkness) * dayBoost + darkness * nightDim;
              const finalMultiplier = (1.0 - outdoorStrength) * 1.0 + outdoorStrength * outdoorMultiplier;

              // PERFORMANCE: reuse cached THREE.Color (avoid per-tile allocations)
              if (!this._tempOverheadTint) {
                this._tempOverheadTint = new THREE.Color(1, 1, 1);
              }
              overheadTint = this._tempOverheadTint.copy(globalTint).multiplyScalar(finalMultiplier);
            }
          }
        } catch (_) {
        }

        sprite.material.color.copy(overheadTint);
      }

      // Handle Occlusion
      // Default: use configured alpha
      let targetAlpha = tileDoc.alpha ?? 1;
      
      const occlusion = tileDoc.occlusion || {};
      const mode = occlusion.mode || CONST.TILE_OCCLUSION_MODES.NONE;

      if (mode !== CONST.TILE_OCCLUSION_MODES.NONE) {
        let occluded = false;

        // Check if any relevant token is under this tile
        // Simple bounds check for now (Foundry uses more complex pixel-perfect alpha checks usually)
        // We'll use the tile's rectangle (ignoring rotation for simple check, or proper check if needed)
        
        // TODO: Improve this to use proper SAT or pixel check for rotated tiles
        // For now, simple bounding box of the sprite
        
        // Get tile bounds in world space
        const left = tileDoc.x;
        const right = tileDoc.x + tileDoc.width;
        const top = tileDoc.y;
        const bottom = tileDoc.y + tileDoc.height;

        for (const token of sources) {
          // Token center
          const txPx = token.x + token.w / 2;
          const tyPx = token.y + token.h / 2;

          if (txPx >= left && txPx <= right && tyPx >= top && tyPx <= bottom) {
             occluded = true;
             break;
          }
        }

        if (occluded) {
          targetAlpha = occlusion.alpha ?? 0;
        }
      }

      // Apply hover-hide (fade to zero alpha when hovered)
      if (hoverHidden) {
        targetAlpha = 0;
        anyHoverHidden = true;
      }
      
      // Smoothly interpolate alpha
      // Use a ~2 second time constant for hover/occlusion fades
      const currentAlphaRaw = sprite.material.opacity;
      const currentAlpha = Number.isFinite(currentAlphaRaw) ? currentAlphaRaw : targetAlpha;
      const diff = targetAlpha - currentAlpha;
      const absDiff = Math.abs(diff);

      if (absDiff > 0.0005) {
        anyOverheadFadeInProgress = true;
        // Ensure the fade keeps rendering smoothly even if the scene is otherwise idle.
        // (This is intentionally inside the per-tile loop so any new targetAlpha change
        // immediately extends the continuous-render window.)
        try {
          const rl = window.MapShine?.renderLoop;
          rl?.requestContinuousRender?.(2500);
        } catch (_) {
        }
        // Move opacity toward target at a fixed rate of 0.5 per second,
        // so a full 0->1 transition takes about 2 seconds regardless of
        // frame rate.
        const maxStep = dt / 2; // 0.5 units per second
        const step = Math.sign(diff) * Math.min(absDiff, maxStep);
        sprite.material.opacity = currentAlpha + step;
      } else {
        // Close enough: snap to target to avoid tiny tails.
        sprite.material.opacity = targetAlpha;
      }

      // Keep depth behavior consistent with fade-hidden roofs.
      // When opacity is near-zero, disable depthWrite so invisible roofs don't occlude tokens.
      // When visible, re-enable depthWrite so roofs can reliably appear above tokens.
      sprite.material.depthTest = true;
      sprite.material.depthWrite = (sprite.material.opacity ?? 1.0) > 0.01;
    }

    // If any overhead tile is mid-fade, ensure we keep rendering at full rate
    // long enough for the animation to settle.
    if (anyOverheadFadeInProgress) {
      try {
        const rl = window.MapShine?.renderLoop;
        rl?.requestContinuousRender?.(250);
      } catch (_) {
      }
    }

    // Tell WeatherController whether any roof is currently being hover-hidden,
    // so that precipitation effects can decide when to apply the _Outdoors mask.
    if (weatherController && typeof weatherController.setRoofMaskActive === 'function') {
      weatherController.setRoofMaskActive(anyHoverHidden);
    }

    // Apply window light to overhead tiles if enabled
    this._applyWindowLightToOverheadTiles();
  }

  /**
   * Apply window light brightness to overhead tiles.
   * Samples the WindowLightEffect's light texture and adds brightness to tiles
   * that are positioned over lit window areas.
   * @private
   */
  _applyWindowLightToOverheadTiles() {
    const wle = this.windowLightEffect;
    if (!wle) {
      return;
    }
    if (!wle.params.lightOverheadTiles) {
      return;
    }
    if (!wle.params.hasWindowMask) {
      return;
    }
    if (!wle._enabled) return;

    const THREE = window.THREE;
    if (!THREE) return;

    // Get scene dimensions for UV calculation (sceneRect, not padded canvas)
    const d = canvas.dimensions;
    const sceneX = d?.sceneRect?.x ?? d?.sceneX ?? 0;
    const sceneY = d?.sceneRect?.y ?? d?.sceneY ?? 0;
    const sceneW = d?.sceneRect?.width ?? d?.sceneWidth ?? d?.width ?? 10000;
    const sceneH = d?.sceneRect?.height ?? d?.sceneHeight ?? d?.height ?? 10000;

    // Count overhead tiles for debugging
    let overheadCount = 0;
    let litCount = 0;

    // For each overhead tile, calculate the average window light in its area
    // and apply as an additive tint on top of the global darkness tint
    for (const tileId of this._overheadTileIds) {
      const data = this.tileSprites.get(tileId);
      if (!data) continue;

      const { sprite, tileDoc } = data;
      overheadCount++;

      // Use the tile's CURRENT color as base (it already includes global tint + outdoors/night dim).
      const baseColor = sprite?.material?.color;
      if (!baseColor) continue;

      // Calculate tile center UV in scene space
      const tileCenterX = tileDoc.x + tileDoc.width / 2;
      const tileCenterY = tileDoc.y + tileDoc.height / 2;
      const u = (tileCenterX - sceneX) / sceneW;
      const v = (tileCenterY - sceneY) / sceneH;

      // Sample the window light at the tile's position
      const lightSample = this._sampleWindowLight(null, u, v);

      if (lightSample && lightSample.brightness > 0.01) {
        litCount++;
        // Apply additive brightness to the tile on top of global tint
        const overheadIntensity = Math.max(0.0, Math.min(1.0, wle.params.overheadLightIntensity ?? 0.0));
        const intensity = lightSample.brightness * overheadIntensity;

        // Copy the base so we don't accumulate repeatedly across frames.
        if (!this._tempWindowOverheadBase) {
          this._tempWindowOverheadBase = new THREE.Color(1, 1, 1);
        }
        this._tempWindowOverheadBase.copy(baseColor);
        
        // Additive blend: globalTint + (lightColor * intensity)
        sprite.material.color.r = Math.min(1.5, this._tempWindowOverheadBase.r + lightSample.r * intensity);
        sprite.material.color.g = Math.min(1.5, this._tempWindowOverheadBase.g + lightSample.g * intensity);
        sprite.material.color.b = Math.min(1.5, this._tempWindowOverheadBase.b + lightSample.b * intensity);
      }
      // If no window light, the global tint is already applied - no action needed
    }

    // Debug log once every 5 seconds
    if (!this._lastWindowLightLog || Date.now() - this._lastWindowLightLog > 5000) {
      this._lastWindowLightLog = Date.now();
      const maskDataReady = !!this._windowMaskData;
      const extractFailed = !!this._windowMaskExtractFailed;
      log.debug(`Window light overhead: ${overheadCount} overhead tiles, ${litCount} lit, maskData=${maskDataReady}, extractFailed=${extractFailed}, intensity=${wle.params.overheadLightIntensity}`);
    }
  }

  /**
   * Extract mask pixel data from a THREE.Texture for CPU sampling.
   * @param {THREE.Texture} texture
   * @returns {{data: Uint8ClampedArray, width: number, height: number}|null}
   * @private
   */
  _extractMaskData(texture) {
    if (!texture) {
      log.debug('_extractMaskData: texture is null');
      return null;
    }
    if (!texture.image) {
      log.debug('_extractMaskData: texture.image is null');
      return null;
    }
    
    const image = texture.image;
    
    // Check if it's an HTMLImageElement or similar drawable
    // Also accept VideoFrame and OffscreenCanvas which are valid sources
    const isDrawable = (
      image instanceof HTMLImageElement || 
      image instanceof HTMLCanvasElement || 
      image instanceof ImageBitmap ||
      (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) ||
      (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame)
    );
    
    if (!isDrawable) {
      log.warn('Window mask image is not a drawable type:', typeof image, image?.constructor?.name);
      return null;
    }

    try {
      const canvas = document.createElement('canvas');
      const w = image.width || image.naturalWidth || 256;
      const h = image.height || image.naturalHeight || 256;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        log.warn('_extractMaskData: failed to get 2d context');
        return null;
      }
      
      ctx.drawImage(image, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      log.debug(`_extractMaskData: successfully extracted ${w}x${h} pixels`);
      return { data: imageData.data, width: w, height: h };
    } catch (e) {
      log.warn('Failed to extract mask data:', e.message);
      return null;
    }
  }

  /**
   * Sample the window light texture at a given UV coordinate.
   * Returns the light color and brightness at that point.
   * @param {THREE.Texture} texture - unused, kept for API compatibility
   * @param {number} u - U coordinate (0-1)
   * @param {number} v - V coordinate (0-1)
   * @returns {{r: number, g: number, b: number, brightness: number}|null}
   * @private
   */
  _sampleWindowLight(texture, u, v) {
    const wle = this.windowLightEffect;
    if (!wle || !wle.windowMask) {
      return null;
    }

    // Lazy-extract window mask data
    if (!this._windowMaskData && !this._windowMaskExtractFailed) {
      const extracted = this._extractMaskData(wle.windowMask);
      if (extracted) {
        this._windowMaskData = extracted.data;
        this._windowMaskWidth = extracted.width;
        this._windowMaskHeight = extracted.height;
        log.info(`Window mask data extracted: ${extracted.width}x${extracted.height}`);
      } else {
        this._windowMaskExtractFailed = true;
        log.warn('Failed to extract window mask data for overhead tile lighting');
      }
    }

    if (!this._windowMaskData) return null;

    // Sample the mask at the UV coordinate
    const ix = Math.floor(Math.max(0, Math.min(1, u)) * (this._windowMaskWidth - 1));
    const iy = Math.floor(Math.max(0, Math.min(1, v)) * (this._windowMaskHeight - 1));
    const index = (iy * this._windowMaskWidth + ix) * 4;

    const r = this._windowMaskData[index] / 255;
    const g = this._windowMaskData[index + 1] / 255;
    const b = this._windowMaskData[index + 2] / 255;
    const brightness = (r * 0.2126 + g * 0.7152 + b * 0.0722);

    // Apply the same mask shaping as the shader
    const threshold = wle.params.maskThreshold;
    const softness = wle.params.softness;
    const halfWidth = Math.max(softness, 0.001);
    const edgeLo = Math.max(0, threshold - halfWidth);
    const edgeHi = Math.min(1, threshold + halfWidth);
    
    // Smoothstep
    let shaped = 0;
    if (brightness <= edgeLo) {
      shaped = 0;
    } else if (brightness >= edgeHi) {
      shaped = 1;
    } else {
      const t = (brightness - edgeLo) / (edgeHi - edgeLo);
      shaped = t * t * (3 - 2 * t);
    }

    // Check outdoors mask if available (skip outdoor areas)
    let indoorFactor = 1.0;
    if (wle.outdoorsMask) {
      // Lazy-extract outdoors mask data
      if (!this._outdoorsMaskData && !this._outdoorsMaskExtractFailed) {
        const extracted = this._extractMaskData(wle.outdoorsMask);
        if (extracted) {
          this._outdoorsMaskData = extracted.data;
          this._outdoorsMaskWidth = extracted.width;
          this._outdoorsMaskHeight = extracted.height;
        } else {
          this._outdoorsMaskExtractFailed = true;
        }
      }
      
      if (this._outdoorsMaskData) {
        const oix = Math.floor(Math.max(0, Math.min(1, u)) * (this._outdoorsMaskWidth - 1));
        const oiy = Math.floor(Math.max(0, Math.min(1, v)) * (this._outdoorsMaskHeight - 1));
        const oIndex = (oiy * this._outdoorsMaskWidth + oix) * 4;
        const outdoorStrength = this._outdoorsMaskData[oIndex] / 255;
        indoorFactor = 1.0 - outdoorStrength;
      }
    }

    let darkness = 0.0;
    try {
      const le = window.MapShine?.lightingEffect;
      if (le && typeof le.getEffectiveDarkness === 'function') {
        darkness = le.getEffectiveDarkness();
      } else if (typeof canvas?.environment?.darknessLevel === 'number') {
        darkness = canvas.environment.darknessLevel;
      } else if (typeof canvas?.scene?.environment?.darknessLevel === 'number') {
        darkness = canvas.scene.environment.darknessLevel;
      }
    } catch (_) {
    }

    darkness = (typeof darkness === 'number' && Number.isFinite(darkness))
      ? Math.max(0.0, Math.min(1.0, darkness))
      : 0.0;

    const nightDimming = (typeof wle.params?.nightDimming === 'number' && Number.isFinite(wle.params.nightDimming))
      ? Math.max(0.0, Math.min(1.0, wle.params.nightDimming))
      : 1.0;

    const envFactor = 1.0 - Math.max(0.0, Math.min(1.0, darkness * nightDimming));

    const finalBrightness = shaped * indoorFactor * wle.params.intensity * envFactor;

    // Return the light color (from params) scaled by brightness
    const color = wle.params.color;
    return {
      r: color.r,
      g: color.g,
      b: color.b,
      brightness: Math.min(1, finalBrightness)
    };
  }

  /**
   * Create a THREE.js sprite for a Foundry tile
   * @param {TileDocument} tileDoc - Foundry tile document
   * @private
   */
  createTileSprite(tileDoc) {
    // Skip if already exists
    if (this.tileSprites.has(tileDoc.id)) {
      log.warn(`Tile sprite already exists: ${tileDoc.id}`);
      return;
    }

    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE.js not available');
      return;
    }

    // Load tile texture
    const texturePath = tileDoc.texture?.src;
    if (!texturePath) {
      log.warn(`Tile ${tileDoc.id} has no texture`);
      return;
    }

    // Create sprite with material
    const material = new THREE.SpriteMaterial({
      transparent: true,
      alphaTest: 0.1,
      depthTest: true,
      depthWrite: true,
      side: THREE.DoubleSide
    });

    // Used by the overhead color correction shader patch to look up the owning sprite.
    // This avoids storing a direct sprite reference on the material (which can be disposed).
    material.userData._msTileId = tileDoc.id;

    const sprite = new THREE.Sprite(material);
    sprite.name = `Tile_${tileDoc.id}`;
    sprite.matrixAutoUpdate = false;

    // Defensive: tiles should participate in the main scene render (post-processed).
    // Only tiles with bypassEffects enabled are moved to the overlay layer.
    try {
      sprite.layers.disable(OVERLAY_THREE_LAYER);
    } catch (_) {
    }
    
    // Store Foundry data
    sprite.userData.foundryTileId = tileDoc.id;
    sprite.userData.tileDoc = tileDoc;

    sprite.userData.textureReady = false;
    sprite.visible = false;

    // Install overhead CC shader patch early so it compiles with the material.
    // Uniform values will be populated once overhead classification is known.
    try {
      this._ensureOverheadColorCorrection(material);
    } catch (_) {
    }

    const foregroundElevation = Number.isFinite(canvas.scene.foregroundElevation)
      ? canvas.scene.foregroundElevation
      : 0;
    // Overhead detection:
    // - Preferred (v12+): elevation > foregroundElevation
    // - Back-compat: tileDoc.overhead
    const elevForLoad = Number.isFinite(tileDoc.elevation) ? tileDoc.elevation : 0;
    const isOverheadForLoad = (elevForLoad > foregroundElevation) || (tileDoc.overhead === true);

    // Load texture
    this.loadTileTexture(texturePath).then(texture => {
      material.map = texture;
      material.needsUpdate = true;

      sprite.userData.textureReady = true;

      // Canvas dimensions / sceneRect can still settle during initial scene load.
      // Recompute transform at the moment the tile becomes visible to avoid
      // late Y-mirroring / misalignment vs scene-space masks.
      this.updateSpriteTransform(sprite, tileDoc);
      this.updateSpriteVisibility(sprite, tileDoc);

      // Bind per-tile specular overlay if a matching _Specular mask exists and enabled.
      try {
        if (this.specularEffect && this._tileAllowsSpecular(tileDoc)) {
          this.loadTileSpecularMaskTexture(tileDoc).then((specTex) => {
            if (!specTex) {
              this.specularEffect.unbindTileSprite(tileDoc.id);
              return;
            }
            this.specularEffect.bindTileSprite(tileDoc, sprite, specTex);
          }).catch(() => {
          });
        }
      } catch (_) {
      }

      const spriteData = this.tileSprites.get(tileDoc.id);
      if (spriteData) {
        this._ensureWaterOccluderMesh(spriteData, tileDoc);
        this._updateWaterOccluderMeshTransform(sprite, tileDoc);

        // If the occluder mesh already exists (it may have been created while
        // the tile texture was still loading), update its tile texture uniforms
        // and visibility now that the sprite is ready.
        const occ = sprite.userData?.waterOccluderMesh;
        if (occ?.material?.uniforms?.tTile) {
          occ.material.uniforms.tTile.value = texture;
          if (occ.material.uniforms.uHasTile) {
            occ.material.uniforms.uHasTile.value = texture ? 1.0 : 0.0;
          }
        }
        if (occ) {
          occ.visible = !!sprite.visible;
        }
      }

      try {
        window.MapShine?.cloudEffect?.requestBlockerUpdate?.(2);
      } catch (_) {
      }

      this._markInitialTileLoaded(tileDoc?.id, isOverheadForLoad);
    }).catch(error => {
      log.error(`Failed to load tile texture: ${texturePath}`, error);

      this._markInitialTileLoaded(tileDoc?.id, isOverheadForLoad);
    });

    // Set initial transform and visibility
    this.updateSpriteTransform(sprite, tileDoc);
    
    this.scene.add(sprite);

    this.tileSprites.set(tileDoc.id, {
      sprite,
      tileDoc
    });

    // Kick specular resolve early (texture load is async, but we can probe now).
    try {
      if (this.specularEffect && this._tileAllowsSpecular(tileDoc)) {
        this.loadTileSpecularMaskTexture(tileDoc).then((specTex) => {
          if (!specTex) return;
          this.specularEffect.bindTileSprite(tileDoc, sprite, specTex);
        }).catch(() => {
        });
      }
    } catch (_) {
    }

    this._ensureWaterOccluderMesh(this.tileSprites.get(tileDoc.id), tileDoc);

    if (sprite.userData.isOverhead) {
      this._overheadTileIds.add(tileDoc.id);
    } else {
      this._overheadTileIds.delete(tileDoc.id);
    }

    // Keep overhead CC uniforms in sync with overhead status.
    try {
      if (sprite.material) this._applyOverheadColorCorrectionUniforms(sprite, sprite.material);
    } catch (_) {
    }

    if (sprite.userData.isWeatherRoof) {
      this._weatherRoofTileIds.add(tileDoc.id);
    } else {
      this._weatherRoofTileIds.delete(tileDoc.id);
    }

    this._tintDirty = true;

    try {
      window.MapShine?.cloudEffect?.requestBlockerUpdate?.(2);
    } catch (_) {
    }

    log.debug(`Created tile sprite: ${tileDoc.id}`);
  }

  /**
   * Update an existing tile sprite
   * @param {TileDocument} tileDoc - Updated tile document
   * @param {object} changes - Changed properties
   * @private
   */
  updateTileSprite(tileDoc, changes) {
    const spriteData = this.tileSprites.get(tileDoc.id);
    if (!spriteData) {
      // If not found, create it
      this.createTileSprite(tileDoc);
      return;
    }

    const { sprite } = spriteData;

    const mergedFlags = (() => {
      const base = (tileDoc && tileDoc.flags) ? tileDoc.flags : {};
      const delta = (changes && changes.flags) ? changes.flags : null;
      if (!delta) return base;

      const out = { ...base, ...delta };
      const moduleId = 'map-shine-advanced';
      if (base?.[moduleId] || delta?.[moduleId]) {
        out[moduleId] = { ...(base?.[moduleId] || {}), ...(delta?.[moduleId] || {}) };
      }
      return out;
    })();

    const targetDoc = {
      id: tileDoc.id,
      x: ('x' in changes) ? changes.x : tileDoc.x,
      y: ('y' in changes) ? changes.y : tileDoc.y,
      width: ('width' in changes) ? changes.width : tileDoc.width,
      height: ('height' in changes) ? changes.height : tileDoc.height,
      rotation: ('rotation' in changes) ? changes.rotation : tileDoc.rotation,
      elevation: ('elevation' in changes) ? changes.elevation : tileDoc.elevation,
      sort: ('sort' in changes) ? changes.sort : (tileDoc.sort ?? tileDoc.z),
      z: ('z' in changes) ? changes.z : tileDoc.z,
      hidden: ('hidden' in changes) ? changes.hidden : tileDoc.hidden,
      alpha: ('alpha' in changes) ? changes.alpha : tileDoc.alpha,
      flags: mergedFlags
    };

    // Specular masks can be forced on/off, or auto-detected when unset.
    const allowsSpecular = this._tileAllowsSpecular(targetDoc);

    // Update transform if relevant properties changed
    if ('x' in changes || 'y' in changes || 'width' in changes ||
        'height' in changes || 'rotation' in changes ||
        'elevation' in changes || 'z' in changes ||
        'flags' in changes) {
      this.updateSpriteTransform(sprite, targetDoc);
      this._ensureWaterOccluderMesh(spriteData, targetDoc);
      this._updateWaterOccluderMeshTransform(sprite, targetDoc);

      try {
        this.specularEffect?.syncTileSpriteTransform?.(tileDoc.id, sprite);
      } catch (_) {
      }

      // If specular was toggled off via flags, remove any existing overlay.
      // If toggled on, we'll bind below (and/or on the next texture load).
      if ('flags' in changes) {
        try {
          if (!allowsSpecular) {
            this.specularEffect?.unbindTileSprite?.(tileDoc.id);
          } else if (this.specularEffect) {
            // Specular was enabled (or remains enabled) but may not be bound yet.
            // Bind immediately without requiring a texture change.
            try {
              const prevSrc = spriteData?.tileDoc?.texture?.src;
              const prevParts = this._splitUrl(prevSrc);
              if (prevParts?.pathNoExt) this._tileSpecularMaskResolvedUrl.delete(prevParts.pathNoExt);
            } catch (_) {
            }

            const docForMask = {
              id: tileDoc.id,
              texture: { src: spriteData?.tileDoc?.texture?.src || tileDoc?.texture?.src },
              flags: targetDoc.flags
            };
            this.loadTileSpecularMaskTexture(docForMask).then((specTex) => {
              if (!specTex) {
                this.specularEffect?.unbindTileSprite?.(tileDoc.id);
                return;
              }
              this.specularEffect.bindTileSprite({ id: tileDoc.id }, sprite, specTex);
            }).catch(() => {
            });
          }
        } catch (_) {
        }
      }
    }

    // Update texture if changed
    if ('texture' in changes && changes.texture?.src) {
      // If the tile texture changes, its associated _Water mask may also change.
      // Clear any cached resolution for this tile base path so we re-scan properly.
      try {
        const prevSrc = spriteData?.tileDoc?.texture?.src;
        const nextSrc = changes.texture.src;
        const prevParts = this._splitUrl(prevSrc);
        const nextParts = this._splitUrl(nextSrc);
        if (prevParts?.pathNoExt) this._tileWaterMaskResolvedUrl.delete(prevParts.pathNoExt);
        if (nextParts?.pathNoExt) this._tileWaterMaskResolvedUrl.delete(nextParts.pathNoExt);
      } catch (_) {
      }

      // Reset auto-detection state unless user explicitly overrode occlusion.
      try {
        if (sprite.userData?._autoOccludesWaterState !== 'overridden') {
          sprite.userData._autoOccludesWaterState = null;
          sprite.userData._autoOccludesWaterRequestKey = null;
        }
      } catch (_) {
      }

      this.loadTileTexture(changes.texture.src).then(texture => {
        sprite.material.map = texture;
        sprite.material.needsUpdate = true;

        // If the tile texture changes, its associated _Specular mask may also change.
        try {
          const prevSrc = spriteData?.tileDoc?.texture?.src;
          const nextSrc = changes.texture.src;
          const prevParts = this._splitUrl(prevSrc);
          const nextParts = this._splitUrl(nextSrc);
          if (prevParts?.pathNoExt) this._tileSpecularMaskResolvedUrl.delete(prevParts.pathNoExt);
          if (nextParts?.pathNoExt) this._tileSpecularMaskResolvedUrl.delete(nextParts.pathNoExt);
        } catch (_) {
        }

        try {
          if (this.specularEffect) {
            if (!allowsSpecular) {
              this.specularEffect.unbindTileSprite(tileDoc.id);
            } else {
              const nextDoc = { texture: { src: changes.texture.src }, flags: targetDoc.flags };
              this.loadTileSpecularMaskTexture(nextDoc).then((specTex) => {
                if (!specTex) {
                  this.specularEffect.unbindTileSprite(tileDoc.id);
                  return;
                }
                this.specularEffect.bindTileSprite({ id: tileDoc.id }, sprite, specTex);
              }).catch(() => {
              });
            }
          }
        } catch (_) {
        }

        const occ = sprite.userData?.waterOccluderMesh;
        if (occ?.material?.uniforms?.tTile) {
          occ.material.uniforms.tTile.value = texture;
          if (occ.material.uniforms.uHasTile) {
            occ.material.uniforms.uHasTile.value = texture ? 1.0 : 0.0;
          }
        }

        // Kick auto-detection again for the new tile texture. This will:
        // - enable water occlusion if a matching _Water mask exists
        // - update the water occluder mesh's mask uniforms
        // - safely no-op (with cached null) if no mask exists
        try {
          this.updateSpriteTransform(sprite, targetDoc);
        } catch (_) {
        }

        try {
          window.MapShine?.cloudEffect?.requestBlockerUpdate?.(2);
        } catch (_) {
        }
      }).catch(error => {
        log.error(`Failed to load updated tile texture`, error);
      });
    }

    // Update visibility
    if ('hidden' in changes || 'alpha' in changes) {
      this.updateSpriteVisibility(sprite, targetDoc);
      const occ = sprite.userData?.waterOccluderMesh;
      if (occ) {
        occ.visible = !!sprite.visible;
      }
      if (occ?.material?.uniforms?.uOpacity) {
        const a = ('alpha' in targetDoc) ? targetDoc.alpha : 1.0;
        occ.material.uniforms.uOpacity.value = Number.isFinite(a) ? a : 1.0;
      }
    }

    // Update stored reference
    spriteData.tileDoc = tileDoc;
  }

  /**
   * Refresh tile sprite (visual state changed)
   * @param {TileDocument} tileDoc - Tile document
   * @private
   */
  refreshTileSprite(tileDoc) {
    const spriteData = this.tileSprites.get(tileDoc.id);
    if (!spriteData) return;

    // refreshTile fires frequently during interactive transforms (drag/resize/rotate).
    // Keep our THREE sprite transform in sync even if the updateTile hook hasn't
    // been committed yet.
    try {
      this.updateSpriteTransform(spriteData.sprite, tileDoc);
    } catch (_) {
    }

    try {
      this.specularEffect?.syncTileSpriteTransform?.(tileDoc.id, spriteData.sprite);
    } catch (_) {
    }

    // Visibility/opacity can also change during refresh.
    this.updateSpriteVisibility(spriteData.sprite, tileDoc);
  }

  /**
   * Remove a tile sprite
   * @param {string} tileId - Tile document ID
   * @private
   */
  removeTileSprite(tileId) {
    const spriteData = this.tileSprites.get(tileId);
    if (!spriteData) return;

    const { sprite } = spriteData;

    try {
      this.specularEffect?.unbindTileSprite?.(tileId);
    } catch (_) {
    }

    const occ = sprite?.userData?.waterOccluderMesh;
    if (occ) {
      try {
        this._getWaterOccluderScene().remove(occ);
        occ.geometry?.dispose?.();
        occ.material?.dispose?.();
      } catch (_) {
      }
      sprite.userData.waterOccluderMesh = null;
    }

    this.scene.remove(sprite);
    
    if (sprite.material) {
      sprite.material.dispose();
    }
    
    this.tileSprites.delete(tileId);
    this._overheadTileIds.delete(tileId);
    this._weatherRoofTileIds.delete(tileId);

    if (this._initialLoad.active && this._initialLoad.trackedIds?.has(tileId)) {
      const wasOverhead = !!sprite?.userData?.isOverhead;
      this._markInitialTileLoaded(tileId, wasOverhead);
    }
    this._tintDirty = true;
    log.debug(`Removed tile sprite: ${tileId}`);

    try {
      window.MapShine?.cloudEffect?.requestBlockerUpdate?.(2);
    } catch (_) {
    }
  }

  /**
   * Update sprite transform (position, scale, rotation, z-index)
   * @param {THREE.Sprite} sprite - THREE.js sprite
   * @param {TileDocument} tileDoc - Foundry tile document
   * @private
   */
  updateSpriteTransform(sprite, tileDoc) {
    const THREE = window.THREE;

    const moduleId = 'map-shine-advanced';
    const getFlag = (doc, key) => {
      try {
        const v = doc?.getFlag?.(moduleId, key);
        if (v !== undefined) return v;
      } catch (_) {
      }
      try {
        const v = doc?.flags?.[moduleId]?.[key];
        if (v !== undefined) return v;
      } catch (_) {
      }
      try {
        const v = doc?._source?.flags?.[moduleId]?.[key];
        if (v !== undefined) return v;
      } catch (_) {
      }
      return undefined;
    };

    const bypassFlag = getFlag(tileDoc, 'bypassEffects');
    const bypassEffects = !!bypassFlag;
    const wasBypass = !!sprite.userData.bypassEffects;
    sprite.userData.bypassEffects = bypassEffects;

    if (bypassEffects) {
      try {
        if (!this._warnedBypassTiles) this._warnedBypassTiles = new Set();
        const id = tileDoc?.id;
        if (id && !this._warnedBypassTiles.has(id)) {
          this._warnedBypassTiles.add(id);
          log.warn(`Tile has bypassEffects enabled (will ignore post-processing): ${id}`);
        }
      } catch (_) {
      }
    }

    // If bypass is enabled, render ONLY on the overlay layer so the tile is excluded
    // from the main scene render (and therefore from post-processing).
    // Note: this also excludes the tile from roof/water layer passes.
    if (bypassEffects) {
      sprite.layers.set(OVERLAY_THREE_LAYER);
      sprite.renderOrder = 1000;
    } else if (wasBypass) {
      // Reset to default layer when leaving bypass mode.
      sprite.layers.set(0);
      sprite.renderOrder = 0;
    } else {
      // Defensive: ensure tiles never render in the overlay pass unless explicitly bypassing effects.
      // If a tile is accidentally left with OVERLAY_THREE_LAYER enabled, it can be drawn twice:
      // once post-processed (main scene) and again unprocessed (overlay), making it appear like
      // color correction is "not working" for that tile.
      try {
        sprite.layers.disable(OVERLAY_THREE_LAYER);
      } catch (_) {
      }
    }

    const cloudShadowsFlag = getFlag(tileDoc, 'cloudShadowsEnabled');
    const cloudTopsFlag = getFlag(tileDoc, 'cloudTopsEnabled');
    const cloudShadowsEnabled = (cloudShadowsFlag === undefined) ? true : !!cloudShadowsFlag;
    const cloudTopsEnabled = (cloudTopsFlag === undefined) ? true : !!cloudTopsFlag;

    // 1. Determine Z-Layer
    // Logic: 
    // - Overhead if elevation >= foregroundElevation
    // - Otherwise, check Sort (Z) index from Foundry
    //   - z < 0 ? Background
    //   - z >= 0 ? Foreground
    
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    let zBase = groundZ + Z_FOREGROUND_OFFSET;

    const foregroundElevation = Number.isFinite(canvas.scene.foregroundElevation)
      ? canvas.scene.foregroundElevation
      : 0;
    // Overhead detection:
    // - Preferred (v12+): elevation > foregroundElevation
    // - Back-compat: tileDoc.overhead
    const elev = Number.isFinite(tileDoc.elevation) ? tileDoc.elevation : 0;
    const isOverhead = (elev > foregroundElevation) || (tileDoc.overhead === true);
    const wasOverhead = !!sprite.userData.isOverhead;

    // Store overhead status for update loop
    sprite.userData.isOverhead = isOverhead;

    try {
      if (sprite.material) {
        this._ensureOverheadColorCorrection(sprite.material);
        this._applyOverheadColorCorrectionUniforms(sprite, sprite.material);
      }
    } catch (_) {
    }
    if (wasOverhead !== isOverhead) {
      this._tintDirty = true;
      const tileId = tileDoc?.id;
      if (tileId) {
        if (isOverhead) this._overheadTileIds.add(tileId);
        else this._overheadTileIds.delete(tileId);
      }

      // If a tile stops being overhead, clear any hover-hidden state so it
      // doesn't remain invisible as a ground tile.
      if (wasOverhead && !isOverhead) {
        try {
          const data = tileId ? this.tileSprites.get(tileId) : null;
          if (data?.hoverHidden) {
            data.hoverHidden = false;
            // Restore normal visibility immediately.
            this.updateSpriteVisibility(sprite, tileDoc);
          }
        } catch (_) {
        }
      }
    }

    const flag = getFlag(tileDoc, 'overheadIsRoof');
    const isWeatherRoof = isOverhead && !!flag;
    const wasWeatherRoof = !!sprite.userData.isWeatherRoof;
    sprite.userData.isWeatherRoof = isWeatherRoof;

    if (wasWeatherRoof !== isWeatherRoof) {
      const tileId = tileDoc?.id;
      if (tileId) {
        if (isWeatherRoof) this._weatherRoofTileIds.add(tileId);
        else this._weatherRoofTileIds.delete(tileId);
      }
    }

    if (!bypassEffects) {
      if (isOverhead) sprite.layers.enable(ROOF_LAYER);
      else sprite.layers.disable(ROOF_LAYER);
      if (isWeatherRoof) sprite.layers.enable(WEATHER_ROOF_LAYER);
      else sprite.layers.disable(WEATHER_ROOF_LAYER);

      if (!cloudShadowsEnabled) sprite.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      else sprite.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      if (!cloudTopsEnabled) sprite.layers.enable(TILE_FEATURE_LAYERS.CLOUD_TOP_BLOCKER);
      else sprite.layers.disable(TILE_FEATURE_LAYERS.CLOUD_TOP_BLOCKER);
    }

    const occludesWaterFlag = getFlag(tileDoc, 'occludesWater');

    // Water occlusion behavior:
    // - If the flag is explicitly set, it is authoritative.
    // - If the flag is unset, attempt to auto-detect a matching _Water mask.
    //   This is cached per tile base path so scenes with many tiles won't spam requests.
    let occludesWater = false;
    if (occludesWaterFlag !== undefined) {
      occludesWater = !!occludesWaterFlag;
      sprite.userData._autoOccludesWaterState = 'overridden';
      sprite.userData._autoOccludesWaterRequestKey = null;
    } else {
      const state = sprite.userData?._autoOccludesWaterState;
      if (state === 'enabled') {
        occludesWater = true;
      } else if (state === 'disabled') {
        occludesWater = false;
      } else {
        // Unknown state (or pending). Default to disabled until the async probe resolves.
        occludesWater = false;

        // Only kick a new probe if we're not already waiting.
        if (state !== 'pending') {
          sprite.userData._autoOccludesWaterState = 'pending';
          const tileId = tileDoc?.id ?? '';
          const src = tileDoc?.texture?.src ?? '';
          const requestKey = `${tileId}|${src}`;
          sprite.userData._autoOccludesWaterRequestKey = requestKey;

          this.loadTileWaterMaskTexture(tileDoc).then((maskTex) => {
            // Tile could have been removed or changed while awaiting.
            const current = this.tileSprites.get(tileId);
            const s = current?.sprite;
            if (!s || s !== sprite) return;

            if (s.userData?._autoOccludesWaterState === 'overridden') return;
            if (s.userData?._autoOccludesWaterRequestKey !== requestKey) return;

            if (maskTex) {
              s.userData._autoOccludesWaterState = 'enabled';
              s.userData.occludesWater = true;

              // Ensure occluder mesh exists and update its uniforms immediately.
              try {
                this._ensureWaterOccluderMesh(current, tileDoc);
                this._updateWaterOccluderMeshTransform(s, tileDoc);
                const occ = s.userData?.waterOccluderMesh;
                if (occ?.material?.uniforms?.tWaterMask) {
                  occ.material.uniforms.tWaterMask.value = maskTex;
                  if (occ.material.uniforms.uHasWaterMask) {
                    occ.material.uniforms.uHasWaterMask.value = 1.0;
                  }
                }
              } catch (_) {
              }
            } else {
              s.userData._autoOccludesWaterState = 'disabled';
              s.userData.occludesWater = false;
              try {
                this._ensureWaterOccluderMesh(current, tileDoc);
              } catch (_) {
              }
            }
          }).catch(() => {
            const current = this.tileSprites.get(tileDoc?.id);
            const s = current?.sprite;
            if (!s || s !== sprite) return;
            if (s.userData?._autoOccludesWaterState === 'overridden') return;
            s.userData._autoOccludesWaterState = 'disabled';
            s.userData.occludesWater = false;
            try {
              this._ensureWaterOccluderMesh(current, tileDoc);
            } catch (_) {
            }
          });
        }
      }
    }

    sprite.userData.occludesWater = occludesWater;
    if (!bypassEffects) {
      sprite.layers.disable(WATER_OCCLUDER_LAYER);
    }

    try {
      window.MapShine?.cloudEffect?.requestBlockerUpdate?.(2);
    } catch (_) {
    }

    if (isOverhead) {
      zBase = groundZ + Z_OVERHEAD_OFFSET;
      // Overhead tiles should not dominate the depth buffer so that
      // weather and other environmental effects can render visibly above
      // them. Keep depth testing so roofs still occlude underlying
      // geometry, but avoid writing new depth values and give them a
      // modest renderOrder below the particle systems.
      if (sprite.material) {
        // IMPORTANT:
        // - depthTest must remain ON so roofs respect world depth.
        // - depthWrite must be ON while the roof is visible so tokens can't
        //   overdrawing it (especially if renderer sorting is disabled).
        // - while a roof is fade-hidden (opacity ~0), depthWrite must be OFF
        //   or it will continue occluding tokens even though it is invisible.
        sprite.material.depthTest = true;
        const initialAlpha = (tileDoc && typeof tileDoc.alpha === 'number') ? tileDoc.alpha : 1.0;
        sprite.material.depthWrite = initialAlpha > 0.01;
        sprite.material.needsUpdate = true;
      }
      sprite.renderOrder = 10;
    } else {
      // Foundry 'z' property (sort key) determines background/foreground for non-overhead tiles
      // Note: Foundry uses 'sort' or 'z' depending on version, tileDoc.z is common access
      const sortKey = tileDoc.sort ?? tileDoc.z ?? 0;
      if (sortKey < 0) {
        zBase = groundZ + Z_BACKGROUND_OFFSET;
      } else {
        zBase = groundZ + Z_FOREGROUND_OFFSET;
      }

      // If the sprite was previously overhead, restore depth writing.
      if (sprite.material && (sprite.material.depthWrite === false || sprite.material.depthTest === false)) {
        sprite.material.depthWrite = true;
        sprite.material.depthTest = true;
        sprite.material.needsUpdate = true;
      }
      sprite.renderOrder = 0;
    }
    
    // Add small offset based on sort key to prevent z-fighting within same layer
    // Normalize sort key to small range (e.g., 0.0001 steps)
    const sortOffset = (tileDoc.sort || 0) * 0.00001;
    const zPosition = zBase + sortOffset;

    // 2. Position & Scale (Foundry Top-Left -> THREE Center)
    
    // Token dimensions are straight forward, but Tiles can have scaleX/scaleY in texture
    // Foundry tile width/height are the "Display Dimensions"
    
    const width = tileDoc.width;
    const height = tileDoc.height;

    const scaleX = tileDoc.texture?.scaleX ?? 1;
    const scaleY = tileDoc.texture?.scaleY ?? 1;
    const signX = (scaleX < 0) ? -1 : 1;
    const signY = (scaleY < 0) ? -1 : 1;
    const dispW = width * Math.abs(scaleX || 1);
    const dispH = height * Math.abs(scaleY || 1);
    
    // Center of tile in Foundry coords
    const centerX = tileDoc.x + width / 2;
    const centerY = tileDoc.y + height / 2; // Foundry Y (0 at top)
    
    // Convert to THREE World Coords (Y inverted)
    const sceneHeight = canvas.dimensions?.height || 10000;
    const worldY = sceneHeight - centerY;
    
    sprite.position.set(centerX, worldY, zPosition);
    // Preserve Foundry's negative scaleX/scaleY semantics (flip) by applying
    // the sign to the THREE.Sprite scale.
    sprite.scale.set(dispW * signX, dispH * signY, 1);
    sprite.updateMatrix();
    
    // 3. Rotation
    if (tileDoc.rotation) {
      sprite.material.rotation = THREE.MathUtils.degToRad(tileDoc.rotation);
    }

    const data = this.tileSprites.get(tileDoc.id);
    if (data) {
      this._ensureWaterOccluderMesh(data, tileDoc);
      this._updateWaterOccluderMeshTransform(sprite, tileDoc);
    }
  }

  /**
   * Update sprite visibility and opacity
   * @param {THREE.Sprite} sprite 
   * @param {TileDocument} tileDoc 
   */
  updateSpriteVisibility(sprite, tileDoc) {
    // Global visibility override: if the TileManager is globally hidden,
    // do not allow per-tile visibility to re-enable the sprite.
    if (!this._globalVisible) {
      try { sprite.visible = false; } catch (_) {}
      return;
    }

    if (sprite?.userData?.textureReady === false) {
      sprite.visible = false;
      return;
    }

    // Hidden check
    const isHidden = tileDoc.hidden;
    const isGM = game.user?.isGM;
    
    if (isHidden && !isGM) {
      sprite.visible = false;
    } else {
      sprite.visible = true;
    }

    // Opacity (Alpha)
    // If GM and tile is hidden, show at reduced opacity
    if (isHidden && isGM) {
      sprite.visible = true;
      sprite.material.opacity = 0.5;
    } else {
      sprite.visible = !isHidden;
      sprite.material.opacity = tileDoc.alpha ?? 1;
    }

    // If this tile is currently hover-hidden, force opacity to zero so that
    // refreshTile/update hooks don't fight the hover fade in update().
    try {
      const data = this.tileSprites.get(tileDoc?.id);
      // Hover-hide is overhead-only; never force-hide ground tiles.
      if (data?.hoverHidden && sprite?.userData?.isOverhead) {
        sprite.material.opacity = 0;
      }
    } catch (_) {
    }

    // Keep water occluder mesh visibility/opacity synced. The occluder can be
    // created before the sprite becomes visible (async texture load), so without
    // this it may remain permanently invisible.
    // IMPORTANT: Also respect hover-hidden state so the occluder doesn't linger
    // when the tile sprite fades out during hover-hide.
    const occ = sprite?.userData?.waterOccluderMesh;
    if (occ) {
      occ.visible = !!sprite.visible;
      if (occ.material?.uniforms?.uOpacity) {
        // Use sprite's material opacity (which includes hover-hidden fades)
        // rather than just tileDoc.alpha
        const spriteOpacity = sprite?.material?.opacity ?? 1.0;
        occ.material.uniforms.uOpacity.value = Number.isFinite(spriteOpacity) ? spriteOpacity : 1.0;
      }
    }

    try {
      window.MapShine?.cloudEffect?.requestBlockerUpdate?.(2);
    } catch (_) {
    }
  }

  /**
   * Load texture with caching
   * @param {string} texturePath 
   * @param {{role?: 'ALBEDO'|'DATA_MASK'}} [options]
   * @returns {Promise<THREE.Texture>}
   */
  async loadTileTexture(texturePath, options = {}) {
    if (this.textureCache.has(texturePath)) {
      const cached = this.textureCache.get(texturePath);
      this._normalizeTileTextureSource(cached, options?.role || 'ALBEDO');
      return cached;
    }

    if (this._texturePromises.has(texturePath)) {
      return this._texturePromises.get(texturePath);
    }

    const promise = (async () => {
      const THREE = window.THREE;
      if (!THREE) throw new Error('THREE.js not available');

      const role = options?.role || 'ALBEDO';

      // Prefer createImageBitmap for faster/off-thread decoding where supported.
      // Fallback to THREE.TextureLoader when unavailable.
      // Debug flag: window.MapShine.disableImageBitmapTiles = true to bypass
      // ImageBitmap decode (helps diagnose Y-flip or upload path issues).
      try {
        const disableImageBitmapTiles = window.MapShine?.disableImageBitmapTiles === true;
        if (!disableImageBitmapTiles && typeof fetch === 'function' && typeof createImageBitmap === 'function') {
          const res = await fetch(texturePath);
          if (!res.ok) throw new Error(`Failed to fetch texture (${res.status})`);
          const blob = await res.blob();
          // Keep tile textures in the same orientation as THREE.TextureLoader
          // so sprite UVs remain consistent across browsers.
          // NOTE: Some browsers/drivers have inconsistent ImageBitmap upload/orientation
          // behavior with WebGL UNPACK_FLIP_Y, so we copy to a canvas to stabilize.
          let bitmap = null;
          try {
            bitmap = await createImageBitmap(blob, { imageOrientation: 'none' });
          } catch (_) {
            bitmap = await createImageBitmap(blob);
          }

          let texSource = bitmap;
          try {
            const w = Number(bitmap?.width ?? 0);
            const h = Number(bitmap?.height ?? 0);
            if (w > 0 && h > 0) {
              const canvasEl = document.createElement('canvas');
              canvasEl.width = w;
              canvasEl.height = h;
              const ctx = canvasEl.getContext('2d');
              if (ctx) {
                ctx.drawImage(bitmap, 0, 0, w, h);
                texSource = canvasEl;
              }
            }
          } catch (_) {
          }
          try {
            if (texSource !== bitmap && bitmap && typeof bitmap.close === 'function') bitmap.close();
          } catch (_) {
          }

          const texture = new THREE.Texture(texSource);
          // three.js default UV convention expects textures to be flipped vertically
          // (flipY=true) for typical 2D images. We only disable flipY for data masks
          // where we control sampling explicitly.
          texture.flipY = (role === 'DATA_MASK') ? false : true;
          texture.colorSpace = (role === 'DATA_MASK') ? THREE.NoColorSpace : THREE.SRGBColorSpace;
          this._configureTileTextureFiltering(texture, role);
          this._normalizeTileTextureSource(texture, role);
          texture.needsUpdate = true;
          this.textureCache.set(texturePath, texture);
          return texture;
        }
      } catch (_) {
      }

      return await new Promise((resolve, reject) => {
        this.textureLoader.load(
          texturePath,
          (texture) => {
            texture.colorSpace = (role === 'DATA_MASK') ? THREE.NoColorSpace : THREE.SRGBColorSpace;
            texture.flipY = (role === 'DATA_MASK') ? false : true;
            this._configureTileTextureFiltering(texture, role);
            this._normalizeTileTextureSource(texture, role);
            texture.needsUpdate = true;
            this.textureCache.set(texturePath, texture);
            resolve(texture);
          },
          undefined,
          reject
        );
      });
    })();

    this._texturePromises.set(texturePath, promise);
    try {
      return await promise;
    } finally {
      this._texturePromises.delete(texturePath);
    }
  }

  /**
   * Dispose all resources
   * @param {boolean} [clearCache=true] - Whether to clear texture cache
   * @public
   */
  dispose(clearCache = true) {
    log.info(`Disposing TileManager with ${this.tileSprites.size} tiles`);

    // Only unregister Foundry hooks on full dispose (clearCache=true).
    // When called with clearCache=false (e.g., from syncAllTiles to clear
    // existing sprites before re-syncing), we want to keep hooks active.
    if (clearCache) {
      try {
        if (this._hookIds && this._hookIds.length) {
          for (const [hookName, hookId] of this._hookIds) {
            try {
              Hooks.off(hookName, hookId);
            } catch (e) {
            }
          }
        }
      } catch (e) {
      }
      this._hookIds = [];
      this.hooksRegistered = false;
    }

    for (const { sprite } of this.tileSprites.values()) {
      this.scene.remove(sprite);
      sprite.material?.dispose();
    }
    this.tileSprites.clear();
    this._overheadTileIds.clear();
    this._weatherRoofTileIds.clear();

    if (clearCache) {
      for (const texture of this.textureCache.values()) {
        try {
          if (texture?.image && typeof texture.image.close === 'function') {
            texture.image.close();
          }
        } catch (_) {
        }
        texture.dispose();
      }
      this.textureCache.clear();
      
      // Clear alpha mask cache (large Uint8ClampedArray buffers)
      this.alphaMaskCache.clear();
      
      // Clear water mask caches
      for (const tex of this._tileWaterMaskCache.values()) {
        try { tex?.dispose?.(); } catch (_) {}
      }
      this._tileWaterMaskCache.clear();
      this._tileWaterMaskPromises.clear();
      this._tileWaterMaskResolvedUrl.clear();
      this._tileWaterMaskResolvePromises.clear();
      
      // Clear specular mask caches
      for (const tex of this._tileSpecularMaskCache.values()) {
        try { tex?.dispose?.(); } catch (_) {}
      }
      this._tileSpecularMaskCache.clear();
      this._tileSpecularMaskPromises.clear();
      this._tileSpecularMaskResolvedUrl.clear();
      this._tileSpecularMaskResolvePromises.clear();
      
      this.initialized = false;
    }
  }
}
