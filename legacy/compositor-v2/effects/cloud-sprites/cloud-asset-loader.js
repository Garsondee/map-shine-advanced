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

/**
 * Load cloud sprite textures **lazily and one at a time**, with a deliberate gap
 * between each, delivering each texture as it arrives. This keeps the heavy 2048²
 * cloud uploads off the load path and out of any single burst — the eager
 * {@link loadCloudSpriteTextures} path put ~16 × 16 MB uploads into the scene-load
 * storm, a confirmed driver-watchdog (TDR) contributor on 8 GB GPUs.
 *
 * Sparse/full files are interleaved so both kinds become usable early. The caller
 * decides when to start (after the scene settles) and supplies `shouldContinue`
 * so the loop stops promptly on dispose / scene change.
 *
 * @param {object} options
 * @param {(kind: 'sparse'|'full', tex: import('three').Texture) => void} options.onTexture
 *   Called for each loaded, configured texture, in load order.
 * @param {number} [options.staggerMs=4000] Delay between consecutive loads.
 * @param {() => boolean} [options.shouldContinue] Return false to stop early.
 * @param {() => Promise<boolean|void>} [options.awaitClearance] Awaited before each
 *   upload; the caller blocks here while a large GPU allocation is unsafe (VRAM near
 *   the ceiling, a floor-switch mask rebuild in flight). Keeps 33 MP cloud atlases
 *   from uploading into a danger window. Return value matters: explicit `false`
 *   means clearance was never granted (gave up after a bound) — that ONE candidate
 *   is skipped (clouds are decorative, an acceptable degrade) rather than forced
 *   through, which would defeat the gate on a scene whose pressure never clears.
 *   `true` or `undefined` (the default no-op) proceeds normally. Defaults to a no-op.
 * @returns {Promise<void>}
 */
export async function loadCloudSpriteTexturesPaced({
  onTexture,
  staggerMs = 4000,
  shouldContinue = () => true,
  awaitClearance = () => Promise.resolve(),
} = {}) {
  const THREE = window.THREE;
  if (!THREE || typeof onTexture !== 'function') return;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  const configure = (tex) => {
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  };

  // Interleave sparse/full so both kinds are available after the first couple loads.
  /** @type {Array<['sparse'|'full', string]>} */
  const queue = [];
  const maxLen = Math.max(SPARSE_CLOUD_FILES.length, FULL_CLOUD_FILES.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < SPARSE_CLOUD_FILES.length) queue.push(['sparse', SPARSE_CLOUD_FILES[i]]);
    if (i < FULL_CLOUD_FILES.length) queue.push(['full', FULL_CLOUD_FILES[i]]);
  }

  for (let idx = 0; idx < queue.length; idx++) {
    if (!shouldContinue()) return;
    // Pause here while a large GPU upload is unsafe (VRAM near the ceiling or a
    // floor switch in flight) — this is exactly the window a cloud-atlas upload
    // tipped the card in the field.
    let cleared = true;
    try { cleared = await awaitClearance(); } catch (_) { cleared = true; }
    if (!shouldContinue()) return;
    if (cleared === false) {
      // Clearance never granted for this candidate (chronic pressure, not a
      // transient window) — skip it rather than forcing the upload through, which
      // would silently defeat the whole point of the gate. The next candidate gets
      // its own fresh clearance check after the stagger delay.
      if (idx < queue.length - 1) await sleep(staggerMs);
      continue;
    }
    const [kind, file] = queue[idx];
    const url = `${CLOUD_ASSET_BASE}/${kind}/${file}`;
    try {
      const tex = await loadTexture(url, { role: 'MASK_COLOR', suppressProbeErrors: true });
      if (tex && shouldContinue()) {
        configure(tex);
        onTexture(kind, tex);
      } else if (tex) {
        try { tex.dispose?.(); } catch (_) {}
      }
    } catch (err) {
      log.warn(`loadCloudSpriteTexturesPaced: failed to load ${url}`, err);
    }
    if (idx < queue.length - 1) await sleep(staggerMs);
  }
}
