/**
 * @fileoverview Texture role policies for standardized configuration
 * Ensures consistent mipmap, filtering, and color space settings across all texture types
 * @module assets/texture-policies
 */

import { createLogger } from '../core/log.js';

const log = createLogger('TexturePolicies');

const THREE = window.THREE;

/**
 * Texture role policies - standardized configuration by texture purpose
 * @type {Object<string, Object>}
 */
export const TEXTURE_POLICIES = {
  /**
   * Albedo/diffuse textures - visible color data
   * Should have full quality with mipmaps for smooth zoom
   */
  ALBEDO: {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: true,
    anisotropy: 16,
    flipY: false,
    description: 'Albedo/diffuse color texture'
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
  }
};

/**
 * Apply a texture policy to a THREE.Texture
 * @param {THREE.Texture} texture - Texture to configure
 * @param {string} role - Policy role (key from TEXTURE_POLICIES)
 * @returns {THREE.Texture} The configured texture
 */
export function applyTexturePolicy(texture, role) {
  if (!texture) {
    log.warn('applyTexturePolicy: texture is null/undefined');
    return texture;
  }

  const policy = TEXTURE_POLICIES[role];
  if (!policy) {
    log.warn(`applyTexturePolicy: unknown role "${role}"`);
    return texture;
  }

  try {
    texture.minFilter = policy.minFilter;
    texture.magFilter = policy.magFilter;
    texture.colorSpace = policy.colorSpace;
    texture.generateMipmaps = policy.generateMipmaps;
    texture.anisotropy = policy.anisotropy;
    texture.flipY = policy.flipY;
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
  const texture = new THREE.Texture(source);
  return applyTexturePolicy(texture, role);
}

/**
 * Validate that a texture has the expected policy applied
 * @param {THREE.Texture} texture - Texture to validate
 * @param {string} role - Expected policy role
 * @returns {boolean} Whether texture matches policy
 */
export function validateTexturePolicy(texture, role) {
  if (!texture) return false;

  const policy = TEXTURE_POLICIES[role];
  if (!policy) return false;

  return (
    texture.minFilter === policy.minFilter &&
    texture.magFilter === policy.magFilter &&
    texture.colorSpace === policy.colorSpace &&
    texture.generateMipmaps === policy.generateMipmaps &&
    texture.anisotropy === policy.anisotropy
  );
}

/**
 * Get policy info for debugging
 * @param {string} role - Policy role
 * @returns {Object} Policy configuration
 */
export function getPolicyInfo(role) {
  return TEXTURE_POLICIES[role] || null;
}

/**
 * List all available policies
 * @returns {string[]} Array of policy role names
 */
export function listPolicies() {
  return Object.keys(TEXTURE_POLICIES);
}
