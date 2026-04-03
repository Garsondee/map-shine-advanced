/**
 * Scene-flag persisted mask texture paths (GM-discovered via FilePicker).
 * Syncs with the Scene document so players load the same URLs without browsing.
 * @module settings/mask-manifest-flags
 */
import { canPersistSceneDocument, isGmLike } from '../core/gm-parity.js';


import { createLogger } from '../core/log.js';
import * as sceneSettings from './scene-settings.js';
import {
  getEffectMaskRegistry,
  discoverMaskDirectoryFiles,
  resolveMaskPathsFromListing,
} from '../assets/loader.js';

const log = createLogger('MaskManifestFlags');

export const MASK_FLAG_NAMESPACE = 'map-shine-advanced';
export const MASK_TEXTURE_MANIFEST_KEY = 'maskTextureManifest';
export const MASK_MANIFEST_VERSION = 1;

/**
 * @param {string} src
 * @returns {string}
 */
export function normalizeMaskSourceKey(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  const noQuery = s.split('?')[0];
  return noQuery;
}

function _normBasePath(p) {
  return String(p || '').trim().replace(/\\/g, '/');
}

/** File extension from a texture URL (lowercase, no dot), or null */
export function extensionFromTextureSrc(src) {
  const s = String(src || '');
  const noQuery = s.split('?')[0];
  const dot = noQuery.lastIndexOf('.');
  return dot >= 0 ? noQuery.slice(dot + 1).toLowerCase() : null;
}

/**
 * @param {Scene|null} scene
 * @returns {{ version?: number, basePath?: string, maskSourceKey?: string, pathsByMaskId?: Record<string, string>, updatedAt?: number } | null}
 */
export function getMaskTextureManifest(scene) {
  try {
    const raw = scene?.getFlag?.(MASK_FLAG_NAMESPACE, MASK_TEXTURE_MANIFEST_KEY);
    if (!raw || typeof raw !== 'object') return null;
    if (Number(raw.version) !== MASK_MANIFEST_VERSION) return null;
    if (typeof raw.basePath !== 'string' || !raw.basePath.trim()) return null;
    if (!raw.pathsByMaskId || typeof raw.pathsByMaskId !== 'object') return null;
    return raw;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} flag
 * @param {string} basePath
 * @returns {boolean}
 */
export function maskTextureManifestMatchesBasePath(flag, basePath) {
  if (!flag) return false;
  return _normBasePath(flag.basePath) === _normBasePath(basePath);
}

/**
 * Build loader maskManifest (suffix -> single path string) from flag paths and enabled mask ids.
 * @param {Record<string, string>} pathsByMaskId
 * @param {string[]} enabledMaskIds
 * @returns {Record<string, string>}
 */
export function pathsByMaskIdToLoaderManifest(pathsByMaskId, enabledMaskIds) {
  const registry = getEffectMaskRegistry();
  const want = new Set((enabledMaskIds || []).map((v) => String(v || '').toLowerCase()));
  const manifest = {};
  for (const [maskId, def] of Object.entries(registry)) {
    if (!def?.suffix) continue;
    if (!want.has(String(maskId).toLowerCase())) continue;
    const p =
      pathsByMaskId[maskId] ||
      pathsByMaskId[String(maskId).toLowerCase()] ||
      pathsByMaskId[String(maskId)];
    if (typeof p === 'string' && p.trim()) {
      manifest[def.suffix] = p.trim();
    }
  }
  return manifest;
}

/**
 * Same mapping as SceneComposer._collectEnabledMaskIds — effect UI ids → mask registry ids.
 * @param {Scene} scene
 * @returns {string[]}
 */
export function collectEnabledMaskIds(scene) {
  const enabledEffects = sceneSettings.getEffectiveSettings(scene)?.effects || {};
  const isEnabled = (effectId) => !!enabledEffects?.[effectId]?.enabled;
  // Outdoors is required for BuildingShadows / specular / sky gating — not optional
  // like tree/bush; always allow manifest + bundle resolution alongside specular.
  const ids = new Set(['specular', 'outdoors']);

  if (isEnabled('specular')) {
    ids.add('normal');
    ids.add('roughness');
  }
  if (isEnabled('fire-sparks')) {
    ids.add('fire');
    ids.add('ash');
    ids.add('dust');
  }
  if (isEnabled('tree')) ids.add('tree');
  if (isEnabled('bush')) ids.add('bush');
  if (isEnabled('prism')) {
    ids.add('prism');
    ids.add('iridescence');
  }
  if (isEnabled('windowLight')) {
    ids.add('windows');
    ids.add('structural');
  }
  if (isEnabled('water-splashes') || isEnabled('underwater-bubbles') || isEnabled('water')) {
    ids.add('fluid');
    ids.add('water');
  }
  return Array.from(ids);
}

/**
 * @param {Scene} scene
 * @param {{ basePath: string, maskSourceKey: string, pathsByMaskId: Record<string, string> }} payload
 * @returns {Promise<boolean>} Whether a write occurred
 */
export async function persistMaskTextureManifest(scene, payload) {
  try {
    if (!scene || !canPersistSceneDocument()) return false;
    const next = {
      version: MASK_MANIFEST_VERSION,
      basePath: _normBasePath(payload.basePath),
      maskSourceKey: String(payload.maskSourceKey || ''),
      pathsByMaskId: { ...payload.pathsByMaskId },
      updatedAt: Date.now(),
    };
    const prev = getMaskTextureManifest(scene);
    const prevJson = prev ? JSON.stringify(prev) : '';
    const nextJson = JSON.stringify(next);
    if (prevJson === nextJson) return false;

    await scene.setFlag(MASK_FLAG_NAMESPACE, MASK_TEXTURE_MANIFEST_KEY, next);
    log.info('Persisted maskTextureManifest', { basePath: next.basePath, count: Object.keys(next.pathsByMaskId).length });
    return true;
  } catch (e) {
    log.warn('Failed to persist maskTextureManifest', e?.message ?? e);
    return false;
  }
}

/**
 * GM: discover directory + resolve paths for all registry mask ids, persist, return manifest for enabled ids only.
 * Non-GM: read flag only; if basePath matches, use flag paths; else empty manifest (no URL guessing).
 *
 * @param {Scene} scene
 * @param {{ basePath: string, maskSourceSrc: string, enabledMaskIds: string[] }} params
 * @returns {Promise<{ maskManifest: Record<string, string>, maskExtension: string|null, maskIds: string[], cacheKeySuffix: string, maskConventionFallback: 'off'|'minimal'|'full' }>}
 */
export async function prepareSceneMaskManifestForLoad(scene, { basePath, maskSourceSrc, enabledMaskIds }) {
  if (typeof sceneSettings.isEnabled === 'function' && !sceneSettings.isEnabled(scene)) {
    const ext = extensionFromTextureSrc(maskSourceSrc);
    return {
      maskManifest: {},
      maskExtension: ext,
      maskIds: enabledMaskIds,
      cacheKeySuffix: 'mf:disabled',
      maskConventionFallback: 'off',
    };
  }

  const maskSourceKey = normalizeMaskSourceKey(maskSourceSrc || '');
  const ext = extensionFromTextureSrc(maskSourceSrc);

  const flag = getMaskTextureManifest(scene);
  const flagMatches = maskTextureManifestMatchesBasePath(flag, basePath);

  if (flagMatches && flag.pathsByMaskId) {
    const manifest = pathsByMaskIdToLoaderManifest(flag.pathsByMaskId, enabledMaskIds);
    return {
      maskManifest: manifest,
      maskExtension: ext,
      maskIds: enabledMaskIds,
      cacheKeySuffix: `mf:${flag.updatedAt || 0}`,
      // Paths came from GM directory listing — do not convention-probe missing optional masks (404 spam).
      maskConventionFallback: 'off',
    };
  }

  if (!isGmLike()) {
    log.info('No matching maskTextureManifest for basePath; skipping local mask discovery', { basePath });
    return {
      maskManifest: {},
      maskExtension: ext,
      maskIds: enabledMaskIds,
      cacheKeySuffix: 'mf:none',
      maskConventionFallback: 'off',
    };
  }

  try {
    const available = await discoverMaskDirectoryFiles(basePath);
    const allIds = Object.keys(getEffectMaskRegistry());
    const pathsByMaskId = resolveMaskPathsFromListing(available, basePath, allIds);
    await persistMaskTextureManifest(scene, {
      basePath,
      maskSourceKey,
      pathsByMaskId,
    });
    const manifest = pathsByMaskIdToLoaderManifest(pathsByMaskId, enabledMaskIds);
    return {
      maskManifest: manifest,
      maskExtension: ext,
      maskIds: enabledMaskIds,
      cacheKeySuffix: `mf:${Date.now()}`,
      maskConventionFallback: available.length > 0 ? 'off' : 'minimal',
    };
  } catch (e) {
    log.warn('Mask directory discovery failed', e?.message ?? e);
  }

  return {
    maskManifest: {},
    maskExtension: ext,
    maskIds: enabledMaskIds,
    cacheKeySuffix: 'mf:none',
    maskConventionFallback: 'minimal',
  };
}

/**
 * Non-GM path for GpuSceneMaskCompositor: flag match only, no FilePicker.
 * @param {Scene} scene
 * @param {string} basePath
 * @param {string[]} enabledMaskIds
 * @returns {{ maskManifest: Record<string, string>, maskExtension: string|null, maskIds: string[], cacheKeySuffix: string, skipMaskIds?: string[], maskConventionFallback: 'off'|'minimal'|'full' }}
 */
export function getMaskBundleOptionsFromFlagOnly(scene, basePath, enabledMaskIds, { skipMaskIds = ['water'] } = {}) {
  const bgExt = extensionFromTextureSrc(scene?.background?.src);
  const flag = getMaskTextureManifest(scene);
  if (!maskTextureManifestMatchesBasePath(flag, basePath) || !flag.pathsByMaskId) {
    return {
      maskManifest: {},
      maskExtension: bgExt,
      maskIds: enabledMaskIds,
      cacheKeySuffix: 'mf:none',
      skipMaskIds,
      maskConventionFallback: 'off',
    };
  }
  const manifest = pathsByMaskIdToLoaderManifest(flag.pathsByMaskId, enabledMaskIds);
  return {
    maskManifest: manifest,
    maskExtension: bgExt,
    maskIds: enabledMaskIds,
    cacheKeySuffix: `mf:${flag.updatedAt || 0}`,
    skipMaskIds,
    maskConventionFallback: 'off',
  };
}
