/**
 * @fileoverview Texture role policies for standardized configuration
 * Ensures consistent mipmap, filtering, and color space settings across all texture types
 * @module assets/texture-policies
 */

import { createLogger } from '../core/log.js';

const log = createLogger('TexturePolicies');

/** @returns {typeof import('three')|null} */
function _getTHREE() {
  return window.THREE ?? null;
}

/** @type {number|null} */
let _cachedMaxAnisotropy = null;

/** @type {Object<string, Object>|null} */
let _texturePolicies = null;

/**
 * Resolve the GPU's maximum supported anisotropic filtering level.
 * @param {THREE.WebGLRenderer|null} [renderer]
 * @returns {number}
 */
export function getMaxTextureAnisotropy(renderer = null) {
  if (typeof _cachedMaxAnisotropy === 'number') return _cachedMaxAnisotropy;

  const r = renderer
    ?? window.MapShine?.renderer
    ?? window.MapShine?.sceneComposer?.renderer
    ?? window.MapShine?.effectComposer?.renderer
    ?? null;
  const max = r?.capabilities?.getMaxAnisotropy?.();
  _cachedMaxAnisotropy = (typeof max === 'number' && max > 0) ? max : 1;
  return _cachedMaxAnisotropy;
}

/**
 * Clear cached anisotropy (e.g. after renderer recreation).
 */
export function resetMaxTextureAnisotropyCache() {
  _cachedMaxAnisotropy = null;
}

/**
 * Set Three.js default anisotropy for all newly created textures.
 * Call once after the WebGL renderer is initialized.
 * @param {THREE.WebGLRenderer} renderer
 * @returns {number} Applied anisotropy level
 */
export function applyGlobalTextureAnisotropy(renderer) {
  const THREE = _getTHREE();
  const max = getMaxTextureAnisotropy(renderer);
  if (THREE?.Texture) {
    THREE.Texture.DEFAULT_ANISOTROPY = max;
  }
  _installTextureLoaderAnisotropyHook(renderer);
  log.info(`Anisotropic filtering enabled at maximum quality (${max}x)`);
  return max;
}

/**
 * Ensure TextureLoader callbacks always receive max-quality anisotropy.
 * @param {THREE.WebGLRenderer} renderer
 * @private
 */
function _installTextureLoaderAnisotropyHook(renderer) {
  const THREE = _getTHREE();
  if (!THREE?.TextureLoader || THREE.TextureLoader.__mapShineAnisotropyPatched) return;

  const origLoad = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function patchedLoad(url, onLoad, onProgress, onError) {
    return origLoad.call(this, url, (texture) => {
      const w = Number(texture?.image?.width ?? texture?.image?.naturalWidth ?? 0);
      const h = Number(texture?.image?.height ?? texture?.image?.naturalHeight ?? 0);
      if (w <= 1 && h <= 1) {
        applyTexturePolicy(texture, 'FALLBACK_1X1');
      } else {
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        applyVisibleTextureAnisotropy(texture, renderer);
      }
      onLoad?.(texture);
    }, onProgress, onError);
  };
  THREE.TextureLoader.__mapShineAnisotropyPatched = true;
}

/**
 * Apply maximum anisotropic filtering to a visible/color texture.
 * @param {THREE.Texture|null|undefined} texture
 * @param {THREE.WebGLRenderer|null} [renderer]
 * @returns {THREE.Texture|null|undefined}
 */
export function applyVisibleTextureAnisotropy(texture, renderer = null) {
  if (!texture) return texture;
  texture.anisotropy = getMaxTextureAnisotropy(renderer);
  return texture;
}

/**
 * Texture role policies - standardized configuration by texture purpose.
 * Lazily built after THREE is available.
 * @returns {Object<string, Object>}
 */
export function getTexturePolicies() {
  if (_texturePolicies) return _texturePolicies;

  const THREE = _getTHREE();
  if (!THREE) {
    throw new Error('texture-policies: THREE is not available yet');
  }

  _texturePolicies = {
    /**
     * Albedo/diffuse textures - visible color data
     * Should have full quality with mipmaps for smooth zoom
     */
    ALBEDO: {
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: true,
      anisotropy: 'max',
      flipY: false,
      description: 'Albedo/diffuse color texture'
    },

    /**
     * Color effect masks with transparency (bush, tree) — sRGB, no mipmaps (alpha bleed).
     */
    MASK_COLOR: {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: false,
      anisotropy: 'max',
      flipY: false,
      premultiplyAlpha: true,
      description: 'Color mask with alpha (bush/tree)'
    },

    /**
     * Data masks - grayscale/channel data (not color)
     * Should NOT have color space conversion; use linear sampling
     */
    DATA_MASK: {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace,
      generateMipmaps: false,
      anisotropy: 1,
      flipY: false,
      description: 'Data mask (grayscale/channel information)'
    },

    /**
     * Lookup maps / DataTextures - precise pixel values
     * Should use nearest neighbor to avoid interpolation
     */
    LOOKUP_MAP: {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.NoColorSpace,
      generateMipmaps: false,
      anisotropy: 1,
      flipY: false,
      description: 'Lookup/data texture (nearest neighbor)'
    },

    /**
     * Normal maps - directional data
     * Should NOT have color space conversion; use linear sampling
     */
    NORMAL_MAP: {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace,
      generateMipmaps: false,
      anisotropy: 1,
      flipY: false,
      description: 'Normal map (directional data)'
    },

    /**
     * Render targets - intermediate buffers
     * Typically linear, no mipmaps needed
     */
    RENDER_TARGET: {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace,
      generateMipmaps: false,
      anisotropy: 1,
      flipY: false,
      description: 'Render target buffer'
    },

    /**
     * Floor-bus / placed-tile albedo — sRGB, no mipmaps (avoids alpha halo bleed).
     */
    TILE_ALBEDO: {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: false,
      anisotropy: 'max',
      flipY: true,
      premultiplyAlpha: true,
      description: 'Tile albedo on FloorRenderBus (straight-alpha upload, premultiplied sampling)'
    },

    /**
     * Per-tile data masks that share UVs with bus albedo (e.g. SpecularEffectV2 overlays).
     */
    OVERLAY_DATA_MASK: {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace,
      generateMipmaps: false,
      anisotropy: 1,
      flipY: true,
      description: 'Data mask sampled on tile-aligned overlay geometry'
    },

    /**
     * 1×1 shader placeholders — never generate mipmaps.
     */
    FALLBACK_1X1: {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.NoColorSpace,
      generateMipmaps: false,
      anisotropy: 1,
      flipY: false,
      description: '1×1 uniform fallback texture'
    }
  };

  return _texturePolicies;
}

/**
 * Apply a texture policy to a THREE.Texture
 * @param {THREE.Texture} texture - Texture to configure
 * @param {string} role - Policy role (key from getTexturePolicies())
 * @returns {THREE.Texture} The configured texture
 */
export function applyTexturePolicy(texture, role) {
  if (!texture) {
    log.warn('applyTexturePolicy: texture is null/undefined');
    return texture;
  }

  const policy = getTexturePolicies()[role];
  if (!policy) {
    log.warn(`applyTexturePolicy: unknown role "${role}"`);
    return texture;
  }

  try {
    texture.minFilter = policy.minFilter;
    texture.magFilter = policy.magFilter;
    texture.colorSpace = policy.colorSpace;
    texture.generateMipmaps = policy.generateMipmaps;
    texture.anisotropy = policy.anisotropy === 'max'
      ? getMaxTextureAnisotropy()
      : policy.anisotropy;
    texture.flipY = policy.flipY;
    if (policy.premultiplyAlpha === true) {
      texture.premultiplyAlpha = true;
    } else if (policy.premultiplyAlpha === false) {
      texture.premultiplyAlpha = false;
    }
    texture.needsUpdate = true;

    log.debug(`Applied texture policy "${role}" (${policy.description})`);
  } catch (e) {
    log.error(`Failed to apply texture policy "${role}":`, e);
  }

  return texture;
}

/**
 * Create a texture with a specific policy already applied
 * @param {HTMLImageElement|Canvas|CanvasImageSource} source - Texture source
 * @param {string} role - Policy role
 * @returns {THREE.Texture} Configured texture
 */
export function createTextureWithPolicy(source, role) {
  const THREE = _getTHREE();
  const texture = new THREE.Texture(source);
  return applyTexturePolicy(texture, role);
}

/**
 * Create a 1×1 DataTexture with FALLBACK_1X1 sampling policy.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} a
 * @param {{srgb?: boolean}} [options]
 * @returns {THREE.DataTexture}
 */
export function createFallback1x1Texture(r, g, b, a, options = {}) {
  const THREE = _getTHREE();
  if (!THREE) throw new Error('texture-policies: THREE is not available');

  const data = new Uint8Array([r, g, b, a]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  applyTexturePolicy(tex, 'FALLBACK_1X1');
  if (options.srgb) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.needsUpdate = true;
  return tex;
}

/**
 * Validate that a texture has the expected policy applied
 * @param {THREE.Texture} texture - Texture to validate
 * @param {string} role - Expected policy role
 * @returns {boolean} Whether texture matches policy
 */
export function validateTexturePolicy(texture, role) {
  if (!texture) return false;

  const policy = getTexturePolicies()[role];
  if (!policy) return false;

  return (
    texture.minFilter === policy.minFilter &&
    texture.magFilter === policy.magFilter &&
    texture.colorSpace === policy.colorSpace &&
    texture.generateMipmaps === policy.generateMipmaps &&
    texture.anisotropy === (policy.anisotropy === 'max' ? getMaxTextureAnisotropy() : policy.anisotropy)
  );
}

/**
 * Get policy info for debugging
 * @param {string} role - Policy role
 * @returns {Object|null} Policy configuration
 */
export function getPolicyInfo(role) {
  try {
    return getTexturePolicies()[role] || null;
  } catch (_) {
    return null;
  }
}

/**
 * List all available policies
 * @returns {string[]} Array of policy role names
 */
export function listPolicies() {
  try {
    return Object.keys(getTexturePolicies());
  } catch (_) {
    return [];
  }
}
