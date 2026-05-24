/**
 * @fileoverview Shared loader for sprite cloud PNG assets.
 * @module compositor-v2/effects/cloud-sprites/cloud-asset-loader
 */

import { createLogger } from '../../../core/log.js';
import { loadTexture } from '../../../assets/loader.js';
import { CLOUD_ASSET_BASE, FULL_CLOUD_FILES, SPARSE_CLOUD_FILES } from './CloudSprite.js';

const log = createLogger('CloudAssetLoader');

/**
 * Load sparse + full cloud sprite textures from assets/clouds/.
 * @returns {Promise<{ sparse: import('three').Texture[], full: import('three').Texture[] }>}
 */
export async function loadCloudSpriteTextures() {
  const THREE = window.THREE;
  if (!THREE) return { sparse: [], full: [] };

  const loadFolder = async (folder, files) => {
    const out = [];
    for (const file of files) {
      const url = `${CLOUD_ASSET_BASE}/${folder}/${file}`;
      try {
        const tex = await loadTexture(url, { role: 'MASK_COLOR', suppressProbeErrors: true });
        if (!tex) continue;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        out.push(tex);
      } catch (err) {
        log.warn(`loadCloudSpriteTextures: failed to load ${url}`, err);
      }
    }
    return out;
  };

  const [sparse, full] = await Promise.all([
    loadFolder('sparse', SPARSE_CLOUD_FILES),
    loadFolder('full', FULL_CLOUD_FILES),
  ]);
  return { sparse, full };
}
