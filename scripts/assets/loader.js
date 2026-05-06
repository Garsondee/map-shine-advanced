/**
 * @fileoverview Asset loader for suffix-based texture system
 * Loads base texture and effect masks with intelligent fallbacks
 * @module assets/loader
 */

import { createLogger } from '../core/log.js';
import { globalLoadingProfiler } from '../core/loading-profiler.js';
import { debugLoadingProfiler } from '../core/debug-loading-profiler.js';

const log = createLogger('AssetLoader');

let _lpSeq = 0;

class Semaphore {
  constructor(max = 4) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }

  release() {
    this.current--;
    const resolve = this.queue.shift();
    if (resolve) resolve();
  }
}

/** Supported image formats in priority order */
const SUPPORTED_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];

/** Known effect mask suffixes - currently only PBR masks are implemented */
const EFFECT_MASKS = {
  specular: { suffix: '_Specular', required: false, description: 'Specular highlights mask' },
  roughness: { suffix: '_Roughness', required: false, description: 'Roughness/smoothness map' },
  normal: { suffix: '_Normal', required: false, description: 'Normal map for lighting detail' },
  fire: { suffix: '_Fire', required: false, description: 'Fire effect mask' },
  ash: { suffix: '_Ash', required: false, description: 'Ash disturbance mask' },
  dust: { suffix: '_Dust', required: false, description: 'Dust motes mask' },
  outdoors: { suffix: '_Outdoors', required: false, description: 'Indoor/outdoor area mask' },
  handPaintedShadow: { suffix: '_Shadow', required: false, description: 'Hand-painted outdoor shadow mask' },
  outdoors0: { suffix: '_Outdoors_0', required: false, description: 'Outdoors mask for level 0' },
  outdoors1: { suffix: '_Outdoors_1', required: false, description: 'Outdoors mask for level 1' },
  iridescence: { suffix: '_Iridescence', required: false, description: 'Iridescence effect mask' },
  fluid: { suffix: '_Fluid', required: false, description: 'Fluid flow mask (data)' },
  prism: { suffix: '_Prism', required: false, description: 'Prism/refraction mask' },
  windows: { suffix: '_Windows', required: false, description: 'Window lighting mask' },
  structural: { suffix: '_Structural', required: false, description: 'Structural (legacy window) mask' },
  bush: { suffix: '_Bush', required: false, description: 'Animated bush texture (RGBA with transparency)' },
  tree: { suffix: '_Tree', required: false, description: 'Animated tree texture (high canopy)' },
  water: { suffix: '_Water', required: false, description: 'Water depth mask (data)' },
  // emissive: { suffix: '_Emissive', required: false, description: 'Self-illumination mask' }
};

// These masks gate many systems (specular rendering).
// If a cached bundle is missing any of these, we should not trust the cache.
//
// NOTE: tree/bush/outdoors are NOT included here to avoid 404 spam on hosted
// servers where FilePicker browse fails. They are optional masks that should
// only be loaded when FilePicker can confirm they exist.
const CRITICAL_MASK_IDS = new Set(['specular']);

export function getEffectMaskRegistry() {
  return EFFECT_MASKS;
}

/** Asset cache to prevent redundant loads */
const assetCache = new Map();

/** Cache hit/miss counters for diagnostics */
let _cacheHits = 0;
let _cacheMisses = 0;

/** Generic texture cache for non-map assets (e.g. light cookies/gobos) */
const textureCache = new Map();

/** Negative result cache to prevent repeated 404 probing for masks that don't exist */
const _probeMaskNegativeCache = new Map();
const PROBE_NEGATIVE_CACHE_TTL_MS = 15000;
/** Structured missing-mask diagnostics cache by bundle key */
const _missingMaskDiagnostics = new Map();
/** Failed mask URL cache to suppress repeated 404 retries */
const _failedMaskUrlCache = new Set();

function _normalizeFileList(files) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(files) ? files : []) {
    if (typeof f !== 'string') continue;
    const s = f.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function _discoverFilesViaFilePicker(basePath) {
  // Extract directory path from base path
  const lastSlash = basePath.lastIndexOf('/');
  const directory = lastSlash >= 0 ? basePath.substring(0, lastSlash + 1) : '';
  if (!directory) return [];

  const filePickerImpl = globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
  const filePicker = filePickerImpl ?? globalThis.FilePicker;
  if (!filePicker) return [];

  const tried = new Set();
  const dirsToTry = [];
  const pushDir = (d) => {
    if (typeof d !== 'string') return;
    const trimmed = d.trim();
    if (!trimmed || tried.has(trimmed)) return;
    tried.add(trimmed);
    dirsToTry.push(trimmed);
  };

  pushDir(directory);
  try {
    if (directory.includes('%')) pushDir(decodeURIComponent(directory));
  } catch (_) {}
  try {
    if (directory.includes(' ')) pushDir(encodeURI(directory));
  } catch (_) {}

  const buildBrowseCandidates = (dir) => {
    const d = String(dir || '').trim().replace(/^\/+/, '');
    const lower = d.toLowerCase();
    if (lower.startsWith('modules/')) {
      const stripped = d.replace(/^modules\//i, '');
      return [['public', d], ['public', stripped], ['data', d]];
    }
    if (lower.startsWith('systems/')) {
      const stripped = d.replace(/^systems\//i, '');
      return [['public', d], ['public', stripped], ['data', d]];
    }
    if (lower.startsWith('worlds/')) {
      const stripped = d.replace(/^worlds\//i, '');
      return [['data', d], ['data', stripped], ['public', d]];
    }
    return [['public', d], ['data', d], ['public', d.replace(/^\/+/, '')]];
  };

  const allFiles = [];
  for (const dir of dirsToTry) {
    try {
      const candidates = buildBrowseCandidates(dir);
      for (const [source, targetDir] of candidates) {
        let result = null;
        try {
          result = await filePicker.browse(source, targetDir);
        } catch (_) {
          result = null;
        }
        if (!result || !Array.isArray(result.files) || result.files.length === 0) continue;
        for (const f of result.files) {
          if (!allFiles.includes(f)) allFiles.push(f);
        }
        // First successful source is authoritative for this dir.
        break;
      }
    } catch (_) {}
  }
  return _normalizeFileList(allFiles);
}

function _extractExtension(path) {
  const src = String(path || '');
  const noQuery = src.split('?')[0];
  const dot = noQuery.lastIndexOf('.');
  if (dot < 0) return '';
  return noQuery.slice(dot + 1).toLowerCase();
}

function _buildBasePathVariants(basePath) {
  const src = String(basePath || '').trim();
  if (!src) return [];
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  push(src);
  push(src.toLowerCase());
  const slash = src.lastIndexOf('/');
  if (slash >= 0) {
    const dir = src.slice(0, slash + 1);
    const name = src.slice(slash + 1);
    if (name) push(`${dir}${name.toLowerCase()}`);
  }
  return out;
}

function _buildSuffixVariants(suffix) {
  const src = String(suffix || '').trim();
  if (!src) return [];
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  push(src);
  push(src.toLowerCase());
  return out;
}

function _buildExtensionVariants(preferredExt) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v || '').toLowerCase().replace(/^\./, '');
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  push(preferredExt);
  push('webp');
  push('png');
  push('jpg');
  push('jpeg');
  return out;
}

/**
 * @param {'minimal'|'full'} [options.probeMode='minimal'] — minimal: basePath + canonical suffix +
 *   (source extension, then webp). full: legacy cartesian product of path/suffix/extension variants
 *   (very noisy on 404; diagnostics / explicit opt-in only).
 */
export function buildMaskManifest(basePath, options = {}) {
  const src = String(basePath || '').trim();
  if (!src) return {};
  const probeMode = options.probeMode === 'full' ? 'full' : 'minimal';
  const ext = String(options?.extension || _extractExtension(canvas?.scene?.background?.src) || 'webp')
    .toLowerCase()
    .replace(/^\./, '');
  const requestedMaskIds = (() => {
    if (!Array.isArray(options?.maskIds) || options.maskIds.length === 0) return null;
    return new Set(options.maskIds.map((v) => String(v || '').toLowerCase()).filter(Boolean));
  })();
  const manifest = {};
  for (const [maskId, def] of Object.entries(EFFECT_MASKS)) {
    if (!def?.suffix) continue;
    if (requestedMaskIds && !requestedMaskIds.has(String(maskId).toLowerCase())) continue;

    if (probeMode === 'full') {
      const baseVariants = _buildBasePathVariants(src);
      const extVariants = _buildExtensionVariants(ext);
      const suffixVariants = _buildSuffixVariants(def.suffix);
      const candidates = [];
      for (const b of baseVariants) {
        for (const s of suffixVariants) {
          for (const e of extVariants) {
            const c = normalizePath(`${b}${s}.${e}`);
            if (!candidates.includes(c)) candidates.push(c);
          }
        }
      }
      manifest[def.suffix] = candidates;
    } else {
      const candidates = [];
      const push = (rel) => {
        const c = normalizePath(rel);
        if (!candidates.includes(c)) candidates.push(c);
      };
      push(`${src}${def.suffix}.${ext}`);
      if (ext !== 'webp') push(`${src}${def.suffix}.webp`);
      manifest[def.suffix] = candidates;
    }
  }
  return manifest;
}

function _resolveMaskCandidates(maskManifest, maskSuffix) {
  if (!maskManifest || typeof maskManifest !== 'object') return null;
  const raw = maskManifest[maskSuffix];
  if (Array.isArray(raw)) {
    const out = raw
      .map((v) => (typeof v === 'string' ? normalizePath(v.trim()) : ''))
      .filter(Boolean);
    return out.length ? out : null;
  }
  if (typeof raw === 'string' && raw.trim()) return [normalizePath(raw.trim())];
  return null;
}

/**
 * Ensure a resolved mask URL matches the same map stem as `basePath` (filename without ext).
 * Prevents multi-map folders from binding e.g. `Tower_Bridge_Underground_Water` when the
 * active albedo is `Tower_Bridge_Middle`.
 * @param {string} resolvedPath
 * @param {string} basePath
 * @param {string} suffix e.g. `_Water`
 * @returns {boolean}
 */
function _maskResolvedStemMatchesBase(resolvedPath, basePath, suffix) {
  try {
    const lastSlash = basePath.lastIndexOf('/');
    const baseFilename = lastSlash >= 0 ? basePath.substring(lastSlash + 1) : basePath;
    const expected = `${baseFilename}${suffix}`.toLowerCase();
    const file = String(resolvedPath).substring(String(resolvedPath).lastIndexOf('/') + 1);
    const dot = file.lastIndexOf('.');
    const stem = (dot >= 0 ? file.substring(0, dot) : file).toLowerCase();
    return stem === expected;
  } catch (_) {
    return false;
  }
}

/**
 * Load a complete asset bundle for a scene
 * @param {string} basePath - Base path to scene image (without extension)
 * @param {AssetLoadProgressCallback} [onProgress] - Progress callback
 * @param {Object} [options] - Loading options
 * @param {boolean} [options.skipBaseTexture=false] - Skip loading base texture (if already loaded by Foundry)
 * @param {boolean} [options.suppressProbeErrors=false] - Suppress probe errors when called from UI
 * @param {boolean} [options.bypassCache=false] - Bypass the asset cache (forces a reload/probe)
 * @returns {Promise<AssetLoadResult>} Loaded asset bundle
 * @public
 */
export async function loadAssetBundle(basePath, onProgress = null, options = {}) {
  const {
    skipBaseTexture = false,
    suppressProbeErrors = false,
    bypassCache = false,
    skipMaskIds = null,
    maskManifest = null,
    maskExtension = null,
    maskIds = null,
    cacheKeySuffix = '',
    /**
     * off: only load masks listed in maskManifest (no URL guessing; for players without a scene flag).
     * minimal (default): at most two candidate URLs per mask (source ext + webp fallback).
     * full: legacy high-cardinality probing (diagnostics / explicit opt-in only).
     */
    maskConventionFallback = 'minimal'
  } = options || {};

  const allowConventionProbe = options?.allowConventionProbe === true;
  const convFallback = allowConventionProbe
    ? (maskConventionFallback === 'off' ? 'off' : maskConventionFallback === 'full' ? 'full' : 'minimal')
    : 'off';
  const probeMode = convFallback === 'full' ? 'full' : 'minimal';

  log.info(`Loading asset bundle: ${basePath}${skipBaseTexture ? ' (masks only)' : ''}`);

  const lp = globalLoadingProfiler;
  const doLoadProfile = !!lp?.enabled;
  const spanToken = doLoadProfile ? (++_lpSeq) : 0;
  
  const warnings = [];
  const _dlp = debugLoadingProfiler;
  const _isDbg = _dlp.debugMode;
  const _shortBase = basePath.split('/').pop() || basePath;
  const _skipMaskSet = (() => {
    try {
      if (!skipMaskIds) return null;
      if (skipMaskIds instanceof Set) return skipMaskIds;
      if (Array.isArray(skipMaskIds)) return new Set(skipMaskIds.map((v) => String(v).toLowerCase()));
      return new Set([String(skipMaskIds).toLowerCase()]);
    } catch (e) {
      return null;
    }
  })();
  
  try {
    // Check cache first
    const _skipKey = _skipMaskSet ? Array.from(_skipMaskSet).sort().join(',') : '';
    const ckSuffix = String(cacheKeySuffix || 'default');
    const cacheKey = `${basePath}::${skipBaseTexture ? 'masks' : 'full'}::skip=${_skipKey}::${ckSuffix}`;
    if (!bypassCache && assetCache.has(cacheKey)) {
      const cached = assetCache.get(cacheKey);
      const cachedMaskCount = Array.isArray(cached?.masks) ? cached.masks.length : 0;
      // If the cached bundle has no masks, it may have been produced when
      // FilePicker browsing was unavailable (common on player clients). Bypass
      // cache so we can probe known suffix filenames directly.
      if (cachedMaskCount > 0) {
        // Validate that cached textures still have valid image data.
        // After sceneComposer.dispose(), the GPU backing is removed but the JS
        // Texture object and its .image remain. We must verify .image is present
        // and has non-zero dimensions — otherwise the cache entry is truly stale.
        const staleTextures = cached.masks.filter(m => {
          const img = m?.texture?.image ?? m?.texture?.source?.data;
          if (!img) return true;
          const w = img.width ?? img.naturalWidth ?? 0;
          return w <= 0;
        });

        if (staleTextures.length > 0) {
          if (_isDbg) _dlp.addDiagnostic('Asset Cache', {
            [`cache.${_shortBase}`]: `MISS (${staleTextures.length} stale textures: ${staleTextures.map(m => m.id).join(', ')})`
          });
          log.warn('Cached textures have stale image data; reloading', { basePath, stale: staleTextures.map(m => m.id) });
          assetCache.delete(cacheKey);
        } else {
          // Do NOT invalidate just because a "critical" mask is absent.
          // Absent masks are often intentional on hosted scenes and forcing reloads
          // creates repeat probe/load loops and 404 spam.
          const cachedIds = new Set(
            cached.masks
              .map((m) => String(m?.id || m?.type || '').toLowerCase())
              .filter(Boolean)
          );
          const missingCritical = Array.from(CRITICAL_MASK_IDS).filter((id) => !cachedIds.has(id));
          if (missingCritical.length > 0) {
            log.debug('Cache hit with missing critical masks (trusted to avoid probe loops)', {
              basePath,
              missingCritical
            });
          }

          // Mark all cached textures for GPU re-upload (they were GPU-disposed
          // but still have valid JS image data).
          for (const m of cached.masks) {
            if (m?.texture) m.texture.needsUpdate = true;
          }
          _cacheHits++;
          if (_isDbg) _dlp.addDiagnostic('Asset Cache', { [`cache.${_shortBase}`]: `HIT (${cachedMaskCount} masks, re-upload)` });
          log.info(`Asset bundle cache hit (${cachedMaskCount} masks): ${basePath}`);
          return {
            success: true,
            bundle: cached,
            warnings: [],
            error: null,
            cacheHit: true
          };
        }
      } else {
        // Trust empty cached bundles too. Without this, player clients with
        // genuinely missing masks will re-attempt every initialize and spam 404s.
        _cacheHits++;
        if (_isDbg) _dlp.addDiagnostic('Asset Cache', { [`cache.${_shortBase}`]: 'HIT (0 masks cached)' });
        return {
          success: true,
          bundle: cached,
          warnings: [],
          error: null,
          cacheHit: true
        };
      }
    } else {
      if (_isDbg) _dlp.addDiagnostic('Asset Cache', { [`cache.${_shortBase}`]: bypassCache ? 'BYPASSED' : 'MISS (no entry)' });
    }

    _cacheMisses++;

    // Step 1: Load base texture (optional if Foundry already loaded it)
    let baseTexture = null;
    if (!skipBaseTexture) {
      baseTexture = await loadBaseTexture(basePath);
      if (!baseTexture) {
        return {
          success: false,
          bundle: null,
          warnings,
          error: new Error(`Base texture not found: ${basePath}`)
        };
      }
      // Notify progress
      if (onProgress) onProgress(1, Object.keys(EFFECT_MASKS).length + 1, 'Base texture');
    }

    // Step 2: Build a single authoritative exact-URL manifest.
    //
    // Safety policy (404 spam control):
    // - Prefer explicit scene manifest paths when available.
    // - Otherwise, prefer FilePicker directory listing (authoritative existing files).
    // - Only fall back to conventional URL guessing when neither is available.
    //
    // Optional masks are NOT convention-probed in the fallback path because that
    // creates large GET/HEAD 404 storms on hosted setups.
    const explicitManifest = (maskManifest && typeof maskManifest === 'object') ? maskManifest : null;
    const hasExplicitManifest = !!explicitManifest && Object.keys(explicitManifest).length > 0;
    let manifestAuthority = hasExplicitManifest ? 'explicit' : 'convention';
    let baseManifest = hasExplicitManifest ? explicitManifest : null;

    if (!baseManifest) {
      try {
        const listed = await discoverMaskDirectoryFiles(basePath);
        if (Array.isArray(listed) && listed.length > 0) {
          const requestedIds = Array.isArray(maskIds) && maskIds.length > 0
            ? maskIds.map((v) => String(v || '').toLowerCase()).filter(Boolean)
            : Object.keys(EFFECT_MASKS);
          const byId = resolveMaskPathsFromListing(listed, basePath, requestedIds);
          const bySuffix = {};
          for (const [maskId, path] of Object.entries(byId)) {
            const suffix = EFFECT_MASKS?.[maskId]?.suffix;
            if (!suffix || typeof path !== 'string' || !path.trim()) continue;
            bySuffix[suffix] = [normalizePath(path.trim())];
          }
          baseManifest = bySuffix;
          manifestAuthority = 'listing';
          log.debug(`Asset manifest authority: FilePicker listing (${Object.keys(bySuffix).length} masks)`);
        }
      } catch (_) {
      }
    }

    if (!baseManifest) {
      baseManifest = buildMaskManifest(basePath, { extension: maskExtension, maskIds, probeMode });
      manifestAuthority = 'convention';
      log.debug('Asset manifest authority: convention fallback');
    }
    const effectiveManifest = { ...(baseManifest || {}) };
    const baseManifestSuffixSet = new Set(Object.keys(baseManifest || {}));
    if (convFallback !== 'off') {
      try {
        const requestedMaskIds = Array.isArray(maskIds) && maskIds.length > 0
          ? maskIds.map((v) => String(v || '').toLowerCase()).filter(Boolean)
          : Object.keys(EFFECT_MASKS);
        const fallbackManifest = buildMaskManifest(basePath, {
          extension: maskExtension,
          maskIds: requestedMaskIds,
          probeMode,
        });
        for (const [maskId, def] of Object.entries(EFFECT_MASKS)) {
          const idLower = String(maskId || '').toLowerCase();
          if (!requestedMaskIds.includes(idLower)) continue;
          const suffix = def?.suffix;
          if (!suffix) continue;
          const hasExisting = Array.isArray(effectiveManifest[suffix])
            ? effectiveManifest[suffix].length > 0
            : (typeof effectiveManifest[suffix] === 'string' && !!effectiveManifest[suffix].trim());
          if (hasExisting) continue;
          const fallbackCandidates = fallbackManifest?.[suffix];
          // Optional masks should be quiet-by-default: if a suffix is missing from
          // the authoritative/base manifest, do not synthesize guessed URLs for
          // optional masks (that causes noisy 404 floods for absent files).
          //
          // Exception: critical masks can still be synthesized in convention mode.
          const critical = CRITICAL_MASK_IDS.has(String(maskId || '').toLowerCase());
          if (!def.required && !critical) continue;
          if (Array.isArray(fallbackCandidates) && fallbackCandidates.length > 0) {
            effectiveManifest[suffix] = fallbackCandidates;
          }
        }
      } catch (_) {}
    }

    // Step 3: Load masks in parallel with concurrency limit
    const semaphore = new Semaphore(4);
    const manifestSuffixSet = new Set(Object.keys(effectiveManifest || {}));
    const maskEntries = Object.entries(EFFECT_MASKS).filter(([, def]) => manifestSuffixSet.has(def?.suffix));
    let loaded = skipBaseTexture ? 0 : 1;
    const totalMasks = maskEntries.length;

    if (_isDbg) _dlp.begin(`al.loadMasks[${_shortBase}]`, 'texture', { totalMasks });
    const unresolvedRequired = [];
    const maskPromises = maskEntries.map(async ([maskId, maskDef]) => {
      await semaphore.acquire();
      const _maskDbgId = `al.mask.${maskId}[${_shortBase}]`;
      if (_isDbg) _dlp.begin(_maskDbgId, 'texture');
      try {
        // Optional: allow callers to skip specific mask types entirely.
        // This is used by Compositor V2 to avoid loading legacy bundle masks
        // (e.g. _Water) that the V2 pipeline doesn't consume.
        if (_skipMaskSet && _skipMaskSet.has(String(maskId).toLowerCase())) {
          loaded++;
          if (_isDbg) _dlp.end(_maskDbgId, { result: 'skipped (caller)' });
          return null;
        }

        // Single runtime path for all users: exact URL from manifest only.
        const maskCandidates = (_resolveMaskCandidates(effectiveManifest, maskDef.suffix) || []).filter((u) =>
          _maskResolvedStemMatchesBase(u, basePath, maskDef.suffix)
        );
        const fromBaseManifest = baseManifestSuffixSet.has(maskDef.suffix);
        const maskIdLower = String(maskId || '').toLowerCase();
        const criticalMask = CRITICAL_MASK_IDS.has(maskIdLower);

        // Hard anti-spam guard:
        // In convention fallback mode, skip optional non-critical masks entirely.
        // This prevents broad URL-guess probes from spamming 404s.
        if (manifestAuthority === 'convention' && !maskDef.required && !criticalMask) {
          loaded++;
          if (_isDbg) _dlp.end(_maskDbgId, { result: 'skipped (optional, convention fallback)' });
          return null;
        }

        if (!maskDef.required && !fromBaseManifest && !criticalMask) {
          // Optional + synthesized-only candidate list -> skip silently.
          loaded++;
          if (_isDbg) _dlp.end(_maskDbgId, { result: 'skipped (optional, no manifest entry)' });
          return null;
        }
        const candidateList = maskCandidates.filter((u) => !_failedMaskUrlCache.has(u));
        const maskFile = candidateList.length ? candidateList[0] : null;

        // Fast-path: if an optional water mask is not present, skip the loading step entirely
        // so we don't stall on a map that doesn't use water at all.
        if (!maskFile && maskId === 'water' && !maskDef.required) {
          loaded++;
          if (_isDbg) _dlp.end(_maskDbgId, { result: 'skipped (optional)' });
          return null;
        }

        // Report progress for masks we actually attempt to load (or required misses).
        if (onProgress && (maskFile || maskDef.required)) {
          const current = loaded;
          onProgress(current, totalMasks + 1, maskDef.description);
        }
        loaded++;

        let maskTexture = null;
        let resolvedMaskPath = null;
        if (maskFile) {
          for (const candidate of candidateList) {
            resolvedMaskPath = candidate;
            try {
              const spanId = doLoadProfile ? `assetLoader.maskTexture:${spanToken}:${maskId}` : null;
              if (doLoadProfile) {
                try {
                  lp.begin(spanId, { maskId, path: candidate, direct: true });
                } catch (e) {
                }
              }
              try {
                // Use direct loading (fetch + createImageBitmap) for off-thread decode.
                // Bypasses PIXI, eliminates canvas clone, downscales large masks, and
                // applies final texture settings (colorSpace, mipmaps, flipY) in one pass.
                const isColorTexture = ['bush', 'tree'].includes(maskId);
                const isVisualDetail = VISUAL_DETAIL_MASKS.has(maskId);
                // Visual-detail masks (specular, normal, etc.) need full resolution
                // to avoid visible quality loss on high-frequency patterns.
                const maskMaxSize = (isColorTexture || isVisualDetail) ? VISUAL_MASK_MAX_SIZE : undefined;
                maskTexture = await loadMaskTextureDirect(candidate, { isColorTexture, maxSize: maskMaxSize });
                break;
              } finally {
                if (doLoadProfile) {
                  try {
                    lp.end(spanId, { ok: !!maskTexture });
                  } catch (e) {
                  }
                }
              }
            } catch (e) {
              _failedMaskUrlCache.add(candidate);
              maskTexture = null;
            }
          }
          if (!maskTexture && maskDef.required) {
            throw new Error(`Failed to load required mask: ${maskId} (${maskDef.suffix})`);
          }
        }

        if (maskTexture) {
          // Texture settings (colorSpace, flipY, mipmaps, filters) are already
          // configured by loadMaskTextureDirect — no post-load overrides needed.
          const isColorTexture = ['bush', 'tree'].includes(maskId);
          const w = maskTexture.image?.width ?? '?';
          const h = maskTexture.image?.height ?? '?';
          log.debug(`Loaded effect mask: ${maskId} from ${resolvedMaskPath} (colorSpace: ${isColorTexture ? 'sRGB' : 'data'}, ${w}×${h})`);
          if (_isDbg) _dlp.end(_maskDbgId, { result: 'loaded', dims: `${w}x${h}` });
          return {
            id: maskId,
            suffix: maskDef.suffix,
            type: maskId,
            path: resolvedMaskPath,
            texture: maskTexture,
            required: maskDef.required
          };
        } else if (maskDef.required) {
          unresolvedRequired.push(maskId);
          warnings.push(`Required mask missing: ${maskId} (${maskDef.suffix})`);
        }
        if (_isDbg && !maskTexture) _dlp.end(_maskDbgId, { result: maskFile ? 'load failed' : 'not found' });
        return null;
      } finally {
        semaphore.release();
      }
    });

    // Wait for all masks to load and collect results in registry order
    const maskResults = await Promise.all(maskPromises);
    const masks = maskResults.filter(m => m !== null);
    if (_isDbg) {
      _dlp.end(`al.loadMasks[${_shortBase}]`, { loaded: masks.length, total: totalMasks });
      // Add mask summary to diagnostics
      const maskSummary = masks.map(m => {
        const t = m.texture;
        const dims = t?.image ? `${t.image.width}x${t.image.height}` : '?';
        return `${m.id}(${dims})`;
      }).join(', ');
      _dlp.addDiagnostic('Loaded Masks', { [`${_shortBase}`]: maskSummary || 'none' });
    }

    // Step 4: Apply intelligent fallbacks
    applyIntelligentFallbacks(masks, warnings);

    if (unresolvedRequired.length > 0) {
      _missingMaskDiagnostics.set(cacheKey, {
        basePath,
        unresolvedRequired,
        manifestKeys: Object.keys(effectiveManifest || {})
      });
      log.error('Required masks unresolved from manifest', { basePath, unresolvedRequired });
    } else {
      _missingMaskDiagnostics.delete(cacheKey);
    }

    // Step 5: Create bundle
    /** @type {MapAssetBundle} */
    const bundle = {
      basePath,
      baseTexture,
      masks,
      isMapShineCompatible: masks.length > 0
    };

    // Cache the bundle
    assetCache.set(cacheKey, bundle);

    log.info(`Asset bundle loaded: ${masks.length} masks found`);
    if (warnings.length > 0) {
      log.warn('Asset loading warnings:', warnings);
    }

    return {
      success: true,
      bundle,
      warnings,
      error: null
    };

  } catch (error) {
    log.error('Asset loading failed:', error);
    return {
      success: false,
      bundle: null,
      warnings,
      error
    };
  }
}

/**
 * Load base texture with format detection
 * @param {string} basePath - Base path without extension
 * @returns {Promise<THREE.Texture|null>} Loaded texture or null
 * @private
 */
async function loadBaseTexture(basePath) {
  const THREE = window.THREE;
  if (!THREE) {
    throw new Error('three.js not loaded');
  }

  // Try each supported format
  for (const format of SUPPORTED_FORMATS) {
    const path = `${basePath}.${format}`;
    
    try {
      const texture = await loadTextureAsync(path);
      if (texture) {
        log.debug(`Base texture loaded: ${path}`);
        return texture;
      }
    } catch (e) {
      // Try next format
      continue;
    }
  }

  return null;
}

async function probeMaskTexture(basePath, suffix, suppressProbeErrors = false) {
  // IMPORTANT: Do not issue any network probing requests (HEAD/GET) for optional
  // masks. Some hosting setups surface these as noisy "errors" in the browser.
  // Runtime mask loading should be driven by FilePicker discovery only.
  //
  // This helper is retained for backwards-compatibility but intentionally does
  // not attempt to load any asset.
  void basePath;
  void suffix;
  void suppressProbeErrors;
  return null;
}

/**
 * Probe for a mask file by attempting to load the expected suffix filename.
 * This is intended for diagnostics and edge-case recovery.
 *
 * @param {string} basePath
 * @param {string} suffix
 * @param {{suppressProbeErrors?: boolean}} [options]
 * @returns {Promise<{path: string} | null>}
 */
export async function probeMaskFile(basePath, suffix, options = {}) {
  const allowConventionProbe = options?.allowConventionProbe === true;

  const cacheKey = `${basePath}::${suffix}`;
  if (_probeMaskNegativeCache.has(cacheKey)) {
    const cached = _probeMaskNegativeCache.get(cacheKey);
    if (cached && typeof cached === 'object' && Object.prototype.hasOwnProperty.call(cached, 'value')) {
      if (cached.value) return cached.value;
      const age = performance.now() - Number(cached.atMs ?? 0);
      if (age >= 0 && age < PROBE_NEGATIVE_CACHE_TTL_MS) return null;
      // Expired negative entry: allow one retry.
      _probeMaskNegativeCache.delete(cacheKey);
    } else {
      // Backward compatibility for old cache value shape (result|null).
      return cached;
    }
  }

  try {
    const availableFiles = await discoverMaskDirectoryFiles(basePath);
    const hasListing = Array.isArray(availableFiles) && availableFiles.length > 0;

    let resolvedPath = null;
    if (hasListing) {
      resolvedPath = findMaskInFiles(availableFiles, basePath, suffix);
    }

    if (!resolvedPath) {
      const scene = typeof canvas !== 'undefined' ? canvas?.scene : null;
      resolvedPath = _pathFromSceneMaskTextureManifest(scene, basePath, suffix);
    }
    // Optional diagnostics-only fallback: exact-name HEAD probe by convention.
    // Runtime default is OFF to avoid 404 spam and request storms.
    if (!resolvedPath && allowConventionProbe) {
      resolvedPath = await _probeMaskPathByConvention(basePath, suffix);
    }

    if (resolvedPath && !_maskResolvedStemMatchesBase(resolvedPath, basePath, suffix)) {
      log.warn('probeMaskFile: stem mismatch — ignoring path', { basePath, suffix, resolvedPath });
      resolvedPath = null;
    }

    if (resolvedPath) {
      const result = { path: resolvedPath };
      _probeMaskNegativeCache.set(cacheKey, { value: result, atMs: performance.now() });
      return result;
    }

    // Negative-cache misses briefly to prevent hot-loop re-probing when effects
    // repeatedly ask for the same absent mask during load/render transitions.
    _probeMaskNegativeCache.set(cacheKey, { value: null, atMs: performance.now() });
    return null;
  } catch (_) {
    _probeMaskNegativeCache.set(cacheKey, { value: null, atMs: performance.now() });
    return null;
  }
}

/**
 * Discover available files in the same directory as the base texture
 * Uses Foundry's FilePicker API to avoid 404 spam
 * @param {string} basePath - Base path without extension (e.g., 'modules/mymodule/assets/map')
 * @returns {Promise<string[]>} Array of available file paths
 * @public
 */
export async function discoverMaskDirectoryFiles(basePath) {
  const lp = globalLoadingProfiler;
  const doLoadProfile = !!lp?.enabled;
  const spanToken = doLoadProfile ? (++_lpSeq) : 0;
  if (doLoadProfile) {
    try {
      lp.begin(`assetLoader.discoverAvailableFiles.inner:${spanToken}`, { basePath });
    } catch (e) {
    }
  }
  try {
    const normalized = await _discoverFilesViaFilePicker(basePath);
    if (normalized.length) {
      log.debug(`FilePicker found ${normalized.length} files for ${basePath}`);
      return normalized;
    }

    log.warn('FilePicker returned no files for basePath:', basePath);
    return [];

  } catch (error) {
    log.warn('Failed to discover files via FilePicker:', error.message);
    return [];
  } finally {
    if (doLoadProfile) {
      try {
        lp.end(`assetLoader.discoverAvailableFiles.inner:${spanToken}`);
      } catch (e) {
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Direct mask texture loading (bypasses PIXI for off-thread decode)
// ---------------------------------------------------------------------------

/** Feature-detect createImageBitmap support once */
const _hasImageBitmap = typeof createImageBitmap === 'function';

/** Max dimension for low-frequency data masks (fire spawn, outdoors, water depth, etc.) */
const MASK_MAX_SIZE = 4096;

/** Max dimension for color textures (bush, tree) and visual-detail masks */
const VISUAL_MASK_MAX_SIZE = 8192;

/**
 * Masks containing high-frequency visual detail that is directly visible on screen.
 * These need full resolution to avoid blurriness — downscaling a 4096 specular mask
 * to 2048 produces a noticeable "half-res" appearance on stripe/sparkle patterns.
 */
const VISUAL_DETAIL_MASKS = new Set(['specular', 'roughness', 'normal', 'iridescence', 'prism']);

/**
 * Load a mask texture directly via fetch + createImageBitmap → THREE.Texture.
 * This bypasses PIXI entirely:
 *   - Image decode happens off the main thread (createImageBitmap)
 *   - No PIXI texture management overhead
 *   - No canvas clone step needed (ImageBitmap is already detached)
 *   - Large masks are downscaled during decode (zero main-thread cost)
 *
 * Texture settings (flipY, mipmaps, colorSpace, filters) are applied
 * immediately so there is no need for post-load reconfiguration and
 * only a single `needsUpdate = true` cycle occurs.
 *
 * Falls back to the legacy PIXI path if createImageBitmap is unavailable.
 *
 * @param {string} url - URL to the mask image file
 * @param {object} [opts]
 * @param {boolean} [opts.isColorTexture=false] - True for bush/tree (sRGB + mipmaps)
 * @param {number}  [opts.maxSize] - Max dimension; larger images are downscaled during decode
 * @returns {Promise<THREE.Texture>} Loaded THREE.Texture
 * @private
 */
async function loadMaskTextureDirect(url, opts = {}) {
  const THREE = window.THREE;
  const absoluteUrl = normalizePath(url);
  const isColor = !!opts.isColorTexture;
  const maxSize = opts.maxSize ?? (isColor ? VISUAL_MASK_MAX_SIZE : MASK_MAX_SIZE);
  const _dlp = debugLoadingProfiler;
  const _isDbg = _dlp.debugMode;
  const _shortUrl = url.split('/').pop() || url;

  if (!_hasImageBitmap) {
    // Fallback: use the legacy PIXI-based loader
    return loadTextureAsync(absoluteUrl);
  }

  if (_isDbg) _dlp.begin(`al.fetch[${_shortUrl}]`, 'texture');
  const response = await fetch(absoluteUrl);
  if (!response.ok) {
    if (_isDbg) _dlp.end(`al.fetch[${_shortUrl}]`, { status: response.status });
    throw new Error(`Fetch failed (${response.status}): ${absoluteUrl}`);
  }
  const blob = await response.blob();
  if (_isDbg) _dlp.end(`al.fetch[${_shortUrl}]`, { bytes: blob.size });

  // Build createImageBitmap options — decode + optional downscale off-thread.
  // Color textures (bush/tree) use premultiplied alpha so that transparent pixels
  // become (0,0,0,0) instead of (1,1,1,0).  This eliminates white fringe from
  // bilinear filtering at content edges — the GPU interpolates premultiplied
  // values correctly.  The shader un-premultiplies after sampling.
  // Data masks keep straight alpha (premultiplyAlpha:'none') since they are
  // sampled as single-channel data, not blended as RGBA.
  const bitmapOpts = {
    premultiplyAlpha: isColor ? 'premultiply' : 'none',
    colorSpaceConversion: 'none'
  };

  // Decode off the main thread, then downscale if the image exceeds maxSize.
  // We resize the already-decoded ImageBitmap (not the blob) to avoid
  // decompressing the PNG/WebP/JPG data a second time.
  if (_isDbg) _dlp.begin(`al.decode[${_shortUrl}]`, 'texture');
  let bitmap = await createImageBitmap(blob, bitmapOpts);
  if (_isDbg) _dlp.end(`al.decode[${_shortUrl}]`, { w: bitmap.width, h: bitmap.height });

  if (maxSize > 0 && (bitmap.width > maxSize || bitmap.height > maxSize)) {
    const w = bitmap.width;
    const h = bitmap.height;
    const scale = maxSize / Math.max(w, h);
    const newW = Math.max(1, Math.round(w * scale));
    const newH = Math.max(1, Math.round(h * scale));

    try {
      // Resize the decoded bitmap (fast — no re-decompression)
      const resized = await createImageBitmap(bitmap, 0, 0, w, h, {
        resizeWidth: newW,
        resizeHeight: newH,
        resizeQuality: 'medium',
        // Preserve the premultiply mode from the original decode so the
        // resize averages pixels in the correct alpha space.
        premultiplyAlpha: isColor ? 'premultiply' : 'none'
      });
      bitmap.close(); // Release full-size memory
      bitmap = resized;
      log.debug(`Downscaled mask ${absoluteUrl}: ${w}×${h} → ${newW}×${newH}`);
    } catch (_) {
      // If resize options aren't supported, keep the full-size bitmap
      log.debug(`Resize not supported — keeping full-size mask ${w}×${h}`);
    }
  }

  // Stabilize ImageBitmap orientation by copying to a canvas element.
  // Some browsers/drivers have inconsistent ImageBitmap upload/orientation
  // behavior with WebGL UNPACK_FLIP_Y (see tile-manager.js commit 090907e).
  // Drawing through a canvas normalizes the pixel data so Three.js uploads
  // it consistently regardless of browser or GPU driver.
  let texSource = bitmap;
  try {
    const bw = Number(bitmap?.width ?? 0);
    const bh = Number(bitmap?.height ?? 0);
    if (bw > 0 && bh > 0) {
      const canvasEl = document.createElement('canvas');
      canvasEl.width = bw;
      canvasEl.height = bh;
      const ctx = canvasEl.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, bw, bh);
        texSource = canvasEl;
      }
    }
  } catch (_) {
  }
  try {
    if (texSource !== bitmap && bitmap && typeof bitmap.close === 'function') bitmap.close();
  } catch (_) {
  }

  // Create the THREE.Texture with final, correct settings — no double config.
  const texture = new THREE.Texture(texSource);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  if (isColor) {
    // Color textures (bush, tree) — sRGB, no mipmaps.
    // Mipmaps with straight-alpha textures cause "mipmap bleed": gl.generateMipmap()
    // averages transparent texels whose RGB is white with opaque content, creating
    // white halos at every mip level that no shader correction can undo.
    // flipY=false matches the base map and data masks (all share geometry with scale.y=-1).
    texture.colorSpace = THREE.SRGBColorSpace || '';
    texture.flipY = false;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
  } else {
    // Data masks — linear, no mipmaps, flipY=false (shader handles UV inversion)
    texture.colorSpace = THREE.NoColorSpace || '';
    texture.flipY = false;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
  }

  texture.needsUpdate = true;
  return texture;
}

/**
 * Find a mask file with the given suffix in the list of available files
 * @param {string[]} availableFiles - List of available file paths from FilePicker
 * @param {string} basePath - Base path without extension
 * @param {string} suffix - Effect mask suffix (e.g., '_Specular')
 * @returns {string|null} Full path to the mask file, or null if not found
 * @private
 */
/** Scene flag written by GM during mask discovery — same schema as mask-manifest-flags.js */
const MASK_TEX_MANIFEST_NS = 'map-shine-advanced';
const MASK_TEX_MANIFEST_KEY = 'maskTextureManifest';
const MASK_TEX_MANIFEST_VER = 1;

function _normMaskBasePath(p) {
  return String(p || '').trim().replace(/\\/g, '/');
}

function _maskIdForSuffix(suffix) {
  const s = String(suffix || '');
  for (const [id, def] of Object.entries(EFFECT_MASKS)) {
    if (def?.suffix === s) return id;
  }
  return null;
}

/**
 * When FilePicker returns no directory listing (common for players), use paths
 * the GM already persisted on the Scene so clients can load without browsing.
 * @param {Scene|null} scene
 * @param {string} basePath
 * @param {string} suffix
 * @returns {string|null}
 */
function _pathFromSceneMaskTextureManifest(scene, basePath, suffix) {
  try {
    const raw = scene?.getFlag?.(MASK_TEX_MANIFEST_NS, MASK_TEX_MANIFEST_KEY);
    if (!raw || typeof raw !== 'object') return null;
    if (Number(raw.version) !== MASK_TEX_MANIFEST_VER) return null;
    if (typeof raw.basePath !== 'string' || !raw.pathsByMaskId || typeof raw.pathsByMaskId !== 'object') {
      return null;
    }
    if (_normMaskBasePath(raw.basePath) !== _normMaskBasePath(basePath)) return null;
    const maskId = _maskIdForSuffix(suffix);
    if (!maskId) return null;
    const pb = raw.pathsByMaskId;
    const p = pb[maskId] || pb[String(maskId).toLowerCase()];
    if (typeof p === 'string' && p.trim()) {
      const trimmed = p.trim();
      if (_maskResolvedStemMatchesBase(trimmed, basePath, suffix)) return trimmed;
    }
  } catch (_) {}
  return null;
}

/**
 * Last resort when FilePicker returns **no** directory listing (typical player clients).
 * Not used when a listing exists — optional masks that are absent from the listing
 * must not trigger HEAD probes (404 noise for GMs).
 * @param {string} basePath
 * @param {string} suffix
 * @returns {Promise<string|null>}
 */
async function _probeMaskPathByConvention(basePath, suffix) {
  const preferred =
    _extractExtension(typeof canvas !== 'undefined' ? canvas?.scene?.background?.src : '') || 'webp';
  const formats = [];
  const pushFmt = (f) => {
    const s = String(f || '').toLowerCase().replace(/^\./, '');
    if (s && !formats.includes(s)) formats.push(s);
  };
  pushFmt(preferred);
  if (preferred !== 'webp') pushFmt('webp');
  for (const format of formats) {
    const candidate = `${basePath}${suffix}.${format}`;
    const u = normalizePath(candidate);
    try {
      const r = await fetch(u, { method: 'HEAD', cache: 'force-cache' });
      if (r.ok) return candidate;
    } catch (_) {}
  }
  return null;
}

function findMaskInFiles(availableFiles, basePath, suffix) {
  // Extract base filename (without directory)
  const lastSlash = basePath.lastIndexOf('/');
  const baseFilename = lastSlash >= 0 ? basePath.substring(lastSlash + 1) : basePath;

  const normalizeName = (name) => {
    if (typeof name !== 'string') return '';
    let out = name;
    try {
      out = decodeURIComponent(out);
    } catch (e) {
    }
    return out.toLowerCase();
  };
  const normalizedAvailable = new Map();
  for (const file of availableFiles) {
    const filename = String(file).substring(String(file).lastIndexOf('/') + 1);
    normalizedAvailable.set(normalizeName(filename), file);
  }
  
  // Try to find a file matching the suffix pattern
  for (const format of SUPPORTED_FORMATS) {
    const expectedFilename = `${baseFilename}${suffix}.${format}`;

    const matchingFile = normalizedAvailable.get(normalizeName(expectedFilename));
    if (matchingFile) {
      log.debug(`Found mask: ${matchingFile}`);
      return matchingFile;
    }
  }
  
  return null;
}

/**
 * Resolve mask paths from a GM FilePicker listing (authoritative filenames on disk).
 * @param {string[]} availableFiles
 * @param {string} basePath
 * @param {string[]|null} maskIds - EFFECT_MASKS keys; null means all keys
 * @returns {Record<string, string>} maskId → full Foundry path
 * @public
 */
export function resolveMaskPathsFromListing(availableFiles, basePath, maskIds) {
  const ids =
    maskIds == null
      ? Object.keys(EFFECT_MASKS)
      : Array.isArray(maskIds)
        ? maskIds
        : [];
  const out = {};
  for (const id of ids) {
    const def = EFFECT_MASKS[id];
    if (!def?.suffix) continue;
    const p = findMaskInFiles(availableFiles, basePath, def.suffix);
    if (p) out[id] = p;
  }
  return out;
}

/**
 * Normalize path for texture loading
 * @param {string} path - Relative or absolute path
 * @returns {string} Normalized path
 * @private
 */
function normalizePath(path) {
  // If already absolute (starts with http:// or https://), return as-is
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  
  // For all other paths (relative or root-relative), return as-is
  // The browser will resolve them correctly relative to the current page
  // This allows Foundry's routing system to handle modules/, worlds/, etc.
  // Encode spaces to avoid URL resolution failures for module asset paths.
  return path.includes(' ') ? path.replace(/ /g, '%20') : path;
}

 /**
  * Load a single texture with caching.
  * Intended for one-off textures which are not part of a scene's asset bundle
  * (e.g. light cookie/gobo textures).
  *
  * @param {string} path
  * @param {{suppressProbeErrors?: boolean, colorSpace?: any}} [options]
  * @returns {Promise<THREE.Texture>}
  */
 export async function loadTexture(path, options = {}) {
   const THREE = window.THREE;
   const suppressProbeErrors = options?.suppressProbeErrors === true;
   const key = normalizePath(String(path ?? ''));
   if (!key) throw new Error('loadTexture requires a non-empty path');

   const cached = textureCache.get(key);
   if (cached) return cached;

   const tex = await loadTextureAsync(key, suppressProbeErrors);
   try {
     if (options?.colorSpace !== undefined && tex) {
       tex.colorSpace = options.colorSpace;
     } else if (THREE?.NoColorSpace && tex) {
       // Most generic textures are treated as data unless otherwise specified.
       tex.colorSpace = THREE.NoColorSpace;
     }
   } catch (e) {
   }

   textureCache.set(key, tex);
   return tex;
 }

/**
 * Load a texture asynchronously using Foundry's texture loading system
 * Silently fails for 404s to allow format fallback without console spam
 * @param {string} path - Full path to texture (Foundry module path format)
 * @returns {Promise<THREE.Texture>} Loaded texture
 * @private
 */
async function loadTextureAsync(path, suppressProbeErrors = false) {
  const THREE = window.THREE;
  const lp = globalLoadingProfiler;
  const doLoadProfile = !!lp?.enabled;
  const spanToken = doLoadProfile ? (++_lpSeq) : 0;
  
  // Use Foundry's loadTexture which handles module paths correctly
  const absolutePath = normalizePath(path);
  
  try {
    if (doLoadProfile) {
      try {
        lp.begin(`assetLoader.loadTextureAsync:${spanToken}`, { path: absolutePath });
      } catch (e) {
      }
    }
    // Use Foundry's built-in texture loading (via PIXI)
    // Don't use fallback - let it throw on 404 so we can try next format
    const loadTextureFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
    if (!loadTextureFn) {
      throw new Error('loadTexture is not available');
    }
    const pixiTexture = await loadTextureFn(absolutePath);
    
    if (!pixiTexture || !pixiTexture.baseTexture) {
      throw new Error(`Failed to load texture: ${absolutePath}`);
    }
    
    // Convert PIXI texture to THREE.Texture
    const resource = pixiTexture.baseTexture.resource;
    if (!resource || !resource.source) {
      throw new Error(`Texture resource not accessible: ${absolutePath}`);
    }
    
    let texSource = resource.source;
    try {
      const cloneSpanId = doLoadProfile ? `assetLoader.cloneTexSource:${spanToken}` : null;
      if (doLoadProfile) {
        try {
          lp.begin(cloneSpanId, { path: absolutePath });
        } catch (e) {
        }
      }
      const shouldClone = Object.values(EFFECT_MASKS).some((m) => {
        const suffix = m?.suffix;
        return typeof suffix === 'string' && suffix.length > 0 && absolutePath.includes(`${suffix}.`);
      });

      if (
        shouldClone &&
        texSource &&
        (
          texSource instanceof HTMLImageElement ||
          texSource instanceof HTMLCanvasElement ||
          texSource instanceof OffscreenCanvas ||
          texSource instanceof ImageBitmap
        )
      ) {
        const w = Number(texSource?.naturalWidth ?? texSource?.videoWidth ?? texSource?.width ?? 0);
        const h = Number(texSource?.naturalHeight ?? texSource?.videoHeight ?? texSource?.height ?? 0);
        if (w > 0 && h > 0) {
          const canvasEl = document.createElement('canvas');
          canvasEl.width = w;
          canvasEl.height = h;
          const ctx = canvasEl.getContext('2d');
          if (ctx) {
            ctx.drawImage(texSource, 0, 0, w, h);
            texSource = canvasEl;
          }
        }
      }
      if (doLoadProfile) {
        try {
          lp.end(cloneSpanId, { cloned: texSource !== resource.source });
        } catch (e) {
        }
      }
    } catch (e) {
    }

    const threeTexture = new THREE.Texture(texSource);
    threeTexture.needsUpdate = true;
    
    // Configure texture settings
    threeTexture.wrapS = THREE.ClampToEdgeWrapping;
    threeTexture.wrapT = THREE.ClampToEdgeWrapping;
    threeTexture.minFilter = THREE.LinearMipmapLinearFilter;
    threeTexture.magFilter = THREE.LinearFilter;
    threeTexture.generateMipmaps = true;
    
    log.debug(`Successfully loaded: ${absolutePath}`);
    if (doLoadProfile) {
      try {
        lp.end(`assetLoader.loadTextureAsync:${spanToken}`, { ok: true });
      } catch (e) {
      }
    }
    return threeTexture;
    
  } catch (error) {
    // Silently fail - this is expected during format probing
    // Only log at debug level to avoid console spam
    if (!suppressProbeErrors) {
      log.debug(`Texture load failed (expected during probing): ${absolutePath}`, error);
    }
    if (doLoadProfile) {
      try {
        lp.end(`assetLoader.loadTextureAsync:${spanToken}`, { ok: false, message: String(error?.message ?? error) });
      } catch (e) {
      }
    }
    throw error;
  }
}

/**
 * Apply intelligent fallbacks for missing optional masks
 * @param {EffectMask[]} masks - Array of loaded masks
 * @param {string[]} warnings - Warning messages array
 * @private
 */
function applyIntelligentFallbacks(masks, warnings) {
  const THREE = window.THREE;
  
  // Find loaded masks by ID
  const maskMap = new Map();
  for (const mask of masks) {
    maskMap.set(mask.id, mask);
  }

  // Fallback 1: Derive roughness from specular if missing
  if (!maskMap.has('roughness') && maskMap.has('specular')) {
    log.info('Deriving roughness from specular map');
    
    const specularMask = maskMap.get('specular');
    const roughnessTexture = deriveRoughnessFromSpecular(specularMask.texture);
    
    if (roughnessTexture) {
      masks.push({
        id: 'roughness',
        suffix: '_Roughness',
        type: 'roughness',
        texture: roughnessTexture,
        required: false
      });
      warnings.push('Roughness map derived from specular (consider authoring dedicated roughness map for best results)');
    }
  }

  // Fallback 2: Create default white roughness if no PBR maps
  if (!maskMap.has('roughness') && !maskMap.has('specular')) {
    log.debug('Creating default roughness map (fully rough)');
    
    const defaultRoughness = createDefaultRoughnessTexture();
    masks.push({
      id: 'roughness',
      suffix: '_Roughness',
      type: 'roughness',
      texture: defaultRoughness,
      required: false
    });
  }
}

/**
 * Derive roughness texture from specular (inverse luminance)
 * @param {THREE.Texture} specularTexture - Source specular texture
 * @returns {THREE.Texture|null} Derived roughness texture
 * @private
 */
function deriveRoughnessFromSpecular(specularTexture) {
  const THREE = window.THREE;
  
  // TODO: Implement canvas-based image processing to invert luminance
  // For now, return null (will use default roughness)
  log.warn('Roughness derivation not yet implemented, using default');
  return null;
}

/**
 * Create default white roughness texture (fully rough surface)
 * @returns {THREE.Texture} Default roughness texture
 * @private
 */
function createDefaultRoughnessTexture() {
  const THREE = window.THREE;
  
  // Create 1x1 white texture
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1, 1);
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  
  return texture;
}

/**
 * Clear asset cache (useful for memory management)
 * @public
 */
export function clearCache() {
  // Dispose all cached textures
  for (const bundle of assetCache.values()) {
    try {
      if (bundle.baseTexture && typeof bundle.baseTexture.dispose === 'function') {
        bundle.baseTexture.dispose();
      }
    } catch (e) {
    }
    for (const mask of bundle.masks) {
      if (mask.texture) {
        mask.texture.dispose();
      }
    }
  }

  for (const tex of textureCache.values()) {
    try {
      tex?.dispose?.();
    } catch (e) {
    }
  }

  assetCache.clear();
  textureCache.clear();
  _probeMaskNegativeCache.clear();
  _failedMaskUrlCache.clear();
  _missingMaskDiagnostics.clear();
  log.info('Asset cache cleared');
}

/**
 * Eagerly upload all textures in a bundle to the GPU via renderer.initTexture().
 *
 * By default Three.js defers texture upload (gl.texImage2D) until the texture is
 * first used in a draw call. For a scene with 10-14 masks this causes a massive
 * first-frame stall. Calling this function during loading spreads that cost across
 * the loading phase where the user already expects to wait.
 *
 * @param {THREE.WebGLRenderer} renderer - The active renderer
 * @param {MapAssetBundle} bundle - The loaded asset bundle
 * @param {(uploaded: number, total: number) => void} [onProgress] - Optional progress callback
 * @returns {{uploaded: number, totalMs: number}} Upload stats
 * @public
 */
export function warmupBundleTextures(renderer, bundle, onProgress) {
  if (!renderer?.initTexture || !bundle) return { uploaded: 0, totalMs: 0 };

  const textures = [];
  if (bundle.baseTexture) textures.push(bundle.baseTexture);
  for (const mask of (bundle.masks || [])) {
    if (mask?.texture) textures.push(mask.texture);
  }

  if (textures.length === 0) return { uploaded: 0, totalMs: 0 };

  const t0 = performance.now();
  let uploaded = 0;

  for (const tex of textures) {
    try {
      renderer.initTexture(tex);
      uploaded++;
      if (onProgress) onProgress(uploaded, textures.length);
    } catch (e) {
      log.debug(`GPU warmup failed for texture:`, e);
    }
  }

  const totalMs = performance.now() - t0;
  log.info(`GPU texture warmup: ${uploaded}/${textures.length} textures uploaded in ${totalMs.toFixed(1)}ms`);
  return { uploaded, totalMs };
}

/**
 * Get cache statistics
 * @returns {{size: number, bundles: string[]}} Cache stats
 * @public
 */
export function getCacheStats() {
  return {
    size: assetCache.size,
    bundles: Array.from(assetCache.keys()),
    hits: _cacheHits,
    misses: _cacheMisses,
    hitRate: (_cacheHits + _cacheMisses) > 0
      ? (_cacheHits / (_cacheHits + _cacheMisses) * 100).toFixed(1) + '%'
      : 'N/A'
  };
}

/**
 * Force a full module reload by clearing all caches and reloading the page.
 * This is a nuclear option for debugging when code changes aren't taking effect.
 * @public
 */
export function forceModuleReload() {
  log.warn('Forcing full module reload - clearing all caches and reloading page');
  clearCache();
  // Clear browser cache for this module's scripts
  if (window.caches) {
    window.caches.keys().then(names => {
      names.forEach(name => {
        if (name.includes('map-shine')) {
          window.caches.delete(name);
        }
      });
    });
  }
  // Reload with cache bypass
  setTimeout(() => {
    window.location.reload(true);
  }, 100);
}
