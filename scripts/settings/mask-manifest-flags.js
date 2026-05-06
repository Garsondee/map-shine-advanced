/**
 * Scene-flag persisted mask texture paths (GM-discovered via FilePicker).
 * Syncs with the Scene document so players load the same URLs without browsing.
 * @module settings/mask-manifest-flags
 */
import { canPersistSceneDocument, isGmLike } from '../core/gm-parity.js';


import { createLogger } from '../core/log.js';
import * as sceneSettings from './scene-settings.js';
import { getViewedLevelBackgroundSrc } from '../foundry/levels-scene-flags.js';
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
 * The texture URL that suffix-mask discovery should track (may differ from
 * `scene.background.src` on Foundry v14 native Levels).
 * @param {Scene|null|undefined} scene
 * @returns {string|null}
 */
export function resolveSceneMaskSourceSrc(scene) {
  try {
    const override = scene?.getFlag?.(MASK_FLAG_NAMESPACE, 'maskSource');
    if (typeof override === 'string' && override.trim().length > 0) {
      return override.trim();
    }
  } catch (_) {}
  try {
    const viewed = getViewedLevelBackgroundSrc(scene);
    if (typeof viewed === 'string' && viewed.trim()) return viewed.trim();
  } catch (_) {}
  try {
    const bg = scene?.background?.src ?? scene?.img;
    if (typeof bg === 'string' && bg.trim()) return bg.trim();
  } catch (_) {}
  return null;
}

/**
 * Whether a persisted maskTextureManifest should be trusted for this load.
 * Rejects stale manifests where `maskSourceKey` no longer matches the image
 * that actually drives mask discovery (common after level/background edits).
 *
 * @param {object|null} flag
 * @param {string} basePath - normalized directory base for this load (no extension)
 * @param {string} maskSourceSrc - authoritative mask source texture URL for this load
 */
export function maskTextureManifestMatchesLoadContext(flag, basePath, maskSourceSrc) {
  if (!flag || !flag.pathsByMaskId) return false;
  const bp = _normBasePath(basePath);
  if (!bp) return false;

  const loadKey = normalizeMaskSourceKey(maskSourceSrc || '');
  const loadBaseFromSrc = loadKey ? _normBasePath(loadKey.replace(/\?.*$/, '').replace(/\.[^/.]+$/, '')) : '';

  const flagBase = _normBasePath(flag.basePath);
  const flagKeyRaw = typeof flag.maskSourceKey === 'string' ? flag.maskSourceKey.trim() : '';
  const flagKey = normalizeMaskSourceKey(flagKeyRaw);
  const flagBaseFromKey = flagKey ? _normBasePath(flagKey.replace(/\?.*$/, '').replace(/\.[^/.]+$/, '')) : '';

  if (flagBase && flagBase === bp) {
    if (flagKey && loadKey && flagKey !== loadKey) {
      return false;
    }
    return true;
  }

  if (loadBaseFromSrc && flagBaseFromKey && loadBaseFromSrc === flagBaseFromKey) {
    if (flagKey && loadKey && flagKey !== loadKey) {
      return false;
    }
    return true;
  }

  return false;
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
  const ids = new Set(['specular', 'outdoors', 'handPaintedShadow']);

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

function _hasAllEnabledMaskPaths(pathsByMaskId, enabledMaskIds) {
  const p = pathsByMaskId && typeof pathsByMaskId === 'object' ? pathsByMaskId : {};
  for (const id of Array.isArray(enabledMaskIds) ? enabledMaskIds : []) {
    const key = String(id || '').trim();
    if (!key) continue;
    const v = p[key] ?? p[key.toLowerCase()] ?? p[key.toUpperCase()];
    if (typeof v !== 'string' || !v.trim()) return false;
  }
  return true;
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
  const flagMatches = maskTextureManifestMatchesLoadContext(flag, basePath, maskSourceSrc);

  const flagHasAllEnabled = flagMatches && flag?.pathsByMaskId
    ? _hasAllEnabledMaskPaths(flag.pathsByMaskId, enabledMaskIds)
    : false;

  if (flagMatches && flag.pathsByMaskId && flagHasAllEnabled) {
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

  // Stale-manifest repair for GMs: if load context matches but enabled mask ids
  // have grown (e.g. new feature adds `_Shadow`), refresh from directory listing
  // instead of silently omitting the new masks forever.
  if (flagMatches && flag?.pathsByMaskId && !flagHasAllEnabled && isGmLike()) {
    log.info('Refreshing stale maskTextureManifest missing enabled mask ids', {
      basePath,
      enabledMaskIds,
      manifestIds: Object.keys(flag.pathsByMaskId || {}),
    });
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
  const maskSourceSrc = resolveSceneMaskSourceSrc(scene) || '';
  const ext = extensionFromTextureSrc(maskSourceSrc || scene?.background?.src);
  const flag = getMaskTextureManifest(scene);
  const flagMatches = maskTextureManifestMatchesLoadContext(flag, basePath, maskSourceSrc);
  const flagHasAllEnabled = flagMatches && flag?.pathsByMaskId
    ? _hasAllEnabledMaskPaths(flag.pathsByMaskId, enabledMaskIds)
    : false;
  if (!flagMatches || !flag.pathsByMaskId || !flagHasAllEnabled) {
    return {
      maskManifest: {},
      maskExtension: ext,
      maskIds: enabledMaskIds,
      cacheKeySuffix: 'mf:none',
      skipMaskIds,
      // If flag is stale/missing for a newly enabled mask id, allow minimal
      // convention fallback so optional masks like `_Shadow` can still resolve.
      maskConventionFallback: 'minimal',
    };
  }
  const manifest = pathsByMaskIdToLoaderManifest(flag.pathsByMaskId, enabledMaskIds);
  return {
    maskManifest: manifest,
    maskExtension: ext,
    maskIds: enabledMaskIds,
    cacheKeySuffix: `mf:${flag.updatedAt || 0}`,
    skipMaskIds,
    maskConventionFallback: 'off',
  };
}
