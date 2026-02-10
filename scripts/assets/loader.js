/**
 * @fileoverview Asset loader for suffix-based texture system
 * Loads base texture and effect masks with intelligent fallbacks
 * @module assets/loader
 */

import { createLogger } from '../core/log.js';
import { globalLoadingProfiler } from '../core/loading-profiler.js';

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
  iridescence: { suffix: '_Iridescence', required: false, description: 'Iridescence effect mask' },
  prism: { suffix: '_Prism', required: false, description: 'Prism/refraction mask' },
  windows: { suffix: '_Windows', required: false, description: 'Window lighting mask' },
  structural: { suffix: '_Structural', required: false, description: 'Structural (legacy window) mask' },
  bush: { suffix: '_Bush', required: false, description: 'Animated bush texture (RGBA with transparency)' },
  tree: { suffix: '_Tree', required: false, description: 'Animated tree texture (high canopy)' },
  water: { suffix: '_Water', required: false, description: 'Water depth mask (data)' },
  // emissive: { suffix: '_Emissive', required: false, description: 'Self-illumination mask' }
};

// These masks gate many systems (specular, roof/outdoor logic, water, particles).
// If a cached bundle is missing any of these, we should not trust the cache.
const CRITICAL_MASK_IDS = new Set(['specular', 'outdoors']);

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
    bypassCache = false
  } = options || {};
  log.info(`Loading asset bundle: ${basePath}${skipBaseTexture ? ' (masks only)' : ''}`);

  const lp = globalLoadingProfiler;
  const doLoadProfile = !!lp?.enabled;
  const spanToken = doLoadProfile ? (++_lpSeq) : 0;
  
  const warnings = [];
  
  try {
    // Check cache first
    const cacheKey = `${basePath}::${skipBaseTexture ? 'masks' : 'full'}`;
    if (!bypassCache && assetCache.has(cacheKey)) {
      const cached = assetCache.get(cacheKey);
      const cachedMaskCount = Array.isArray(cached?.masks) ? cached.masks.length : 0;
      // If the cached bundle has no masks, it may have been produced when
      // FilePicker browsing was unavailable (common on player clients). Bypass
      // cache so we can probe known suffix filenames directly.
      if (cachedMaskCount > 0) {
        // Only trust cache if it contains all critical masks.
        // If a critical mask was missing due to a transient FilePicker issue,
        // we must re-probe so the effect can become active.
        const cachedIds = new Set(
          cached.masks
            .map((m) => String(m?.id || m?.type || '').toLowerCase())
            .filter(Boolean)
        );

        const missingCritical = Array.from(CRITICAL_MASK_IDS).filter((id) => !cachedIds.has(id));
        if (missingCritical.length === 0) {
          _cacheHits++;
          log.info(`Asset bundle cache hit (${cachedMaskCount} masks): ${basePath}`);
          return {
            success: true,
            bundle: cached,
            warnings: [],
            error: null,
            cacheHit: true
          };
        }

        log.warn('Cached asset bundle missing critical masks; reloading', {
          basePath,
          missingCritical
        });
      }
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

    // Step 2: Discover available files in directory using FilePicker
    let availableFiles = [];
    if (doLoadProfile) {
      try {
        lp.begin(`assetLoader.discoverAvailableFiles:${spanToken}`, { basePath });
      } catch (e) {
      }
    }
    try {
      availableFiles = await discoverAvailableFiles(basePath);
    } finally {
      if (doLoadProfile) {
        try {
          lp.end(`assetLoader.discoverAvailableFiles:${spanToken}`, { files: availableFiles?.length ?? 0 });
        } catch (e) {
        }
      }
    }
    log.debug(`Discovered ${availableFiles.length} files in directory`);

    // Step 3: Load masks in parallel with concurrency limit
    const semaphore = new Semaphore(4);
    const maskEntries = Object.entries(EFFECT_MASKS);
    let loaded = skipBaseTexture ? 0 : 1;
    const totalMasks = maskEntries.length;

    // When FilePicker returned no files, fall back to direct URL probing.
    // This is common for player clients that lack FilePicker browse permissions.
    const useDirectProbe = availableFiles.length === 0;
    if (useDirectProbe) {
      log.info('FilePicker returned no files — falling back to direct URL probing');
    }

    const maskPromises = maskEntries.map(async ([maskId, maskDef]) => {
      await semaphore.acquire();
      try {
        // Resolve the mask file path: from FilePicker results or via direct URL probe
        let maskFile = null;
        if (useDirectProbe) {
          maskFile = await probeMaskUrl(basePath, maskDef.suffix);
        } else {
          maskFile = findMaskInFiles(availableFiles, basePath, maskDef.suffix);
        }

        // Fast-path: if an optional water mask is not present, skip the loading step entirely
        // so we don't stall on a map that doesn't use water at all.
        if (!maskFile && maskId === 'water' && !maskDef.required) {
          loaded++;
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
          resolvedMaskPath = maskFile;
          try {
            const spanId = doLoadProfile ? `assetLoader.maskTexture:${spanToken}:${maskId}` : null;
            if (doLoadProfile) {
              try {
                lp.begin(spanId, { maskId, path: maskFile, direct: true });
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
              maskTexture = await loadMaskTextureDirect(maskFile, { isColorTexture, maxSize: maskMaxSize });
            } finally {
              if (doLoadProfile) {
                try {
                  lp.end(spanId, { ok: !!maskTexture });
                } catch (e) {
                }
              }
            }
          } catch (e) {
            const msg = `Failed to load mask: ${maskId} (${maskDef.suffix}) from ${maskFile}`;
            if (maskDef.required) {
              throw new Error(msg);
            }
            warnings.push(msg);
            maskTexture = null;
          }
        }

        if (maskTexture) {
          // Texture settings (colorSpace, flipY, mipmaps, filters) are already
          // configured by loadMaskTextureDirect — no post-load overrides needed.
          const isColorTexture = ['bush', 'tree'].includes(maskId);
          log.debug(`Loaded effect mask: ${maskId} from ${resolvedMaskPath} (colorSpace: ${isColorTexture ? 'sRGB' : 'data'}, ${maskTexture.image?.width ?? '?'}×${maskTexture.image?.height ?? '?'})`);
          return {
            id: maskId,
            suffix: maskDef.suffix,
            type: maskId,
            path: resolvedMaskPath,
            texture: maskTexture,
            required: maskDef.required
          };
        } else if (maskDef.required) {
          warnings.push(`Required mask missing: ${maskId} (${maskDef.suffix})`);
        }
        return null;
      } finally {
        semaphore.release();
      }
    });

    // Wait for all masks to load and collect results in registry order
    const maskResults = await Promise.all(maskPromises);
    const masks = maskResults.filter(m => m !== null);

    // Step 4: Apply intelligent fallbacks
    applyIntelligentFallbacks(masks, warnings);

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
  // IMPORTANT: This must not generate network requests for missing files.
  // We only report a mask as present if FilePicker directory listing includes it.
  void options;
  try {
    const availableFiles = await discoverAvailableFiles(basePath);
    if (!Array.isArray(availableFiles) || availableFiles.length === 0) return null;
    const maskFile = findMaskInFiles(availableFiles, basePath, suffix);
    if (!maskFile) return null;
    return { path: maskFile };
  } catch (_) {
    return null;
  }
}

/**
 * Discover available files in the same directory as the base texture
 * Uses Foundry's FilePicker API to avoid 404 spam
 * @param {string} basePath - Base path without extension (e.g., 'modules/mymodule/assets/map')
 * @returns {Promise<string[]>} Array of available file paths
 * @private
 */
async function discoverAvailableFiles(basePath) {
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
    // Extract directory path from base path
    const lastSlash = basePath.lastIndexOf('/');
    const directory = lastSlash >= 0 ? basePath.substring(0, lastSlash + 1) : '';
    
    if (!directory) {
      log.warn('Could not determine directory from basePath:', basePath);
      return [];
    }

    // Use Foundry's FilePicker to browse the directory
    // This returns the actual files that exist
    const filePickerImpl = globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
    const filePicker = filePickerImpl ?? globalThis.FilePicker;
    if (!filePicker) {
      throw new Error('FilePicker is not available');
    }
    const tried = new Set();
    const dirsToTry = [];
    const pushDir = (d) => {
      if (typeof d !== 'string') return;
      const trimmed = d.trim();
      if (!trimmed) return;
      if (tried.has(trimmed)) return;
      tried.add(trimmed);
      dirsToTry.push(trimmed);
    };

    pushDir(directory);
    try {
      if (directory.includes('%')) pushDir(decodeURIComponent(directory));
    } catch (e) {
    }
    try {
      if (directory.includes(' ')) pushDir(encodeURI(directory));
    } catch (e) {
    }

    const allFiles = [];
    let browseIndex = 0;
    for (const dir of dirsToTry) {
      try {
        const spanId = doLoadProfile ? `assetLoader.filePicker.browse:${spanToken}:${browseIndex++}` : null;
        if (doLoadProfile) {
          try {
            lp.begin(spanId, { dir });
          } catch (e) {
          }
        }
        const result = await filePicker.browse('data', dir);
        if (doLoadProfile) {
          try {
            lp.end(spanId, { files: result?.files?.length ?? 0 });
          } catch (e) {
          }
        }
        if (!result || !result.files) {
          continue;
        }
        for (const f of result.files) {
          if (!allFiles.includes(f)) allFiles.push(f);
        }
      } catch (e) {
        // Try next directory variant
      }
    }

    if (!allFiles.length) {
      log.warn('FilePicker returned no files for directory:', directory);
      return [];
    }

    log.debug(`FilePicker found ${allFiles.length} files in ${directory}`);
    return allFiles;
    
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
const MASK_MAX_SIZE = 2048;

/** Max dimension for color textures (bush, tree) and visual-detail masks */
const VISUAL_MASK_MAX_SIZE = 4096;

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

  if (!_hasImageBitmap) {
    // Fallback: use the legacy PIXI-based loader
    return loadTextureAsync(absoluteUrl);
  }

  const response = await fetch(absoluteUrl);
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}): ${absoluteUrl}`);
  }

  const blob = await response.blob();

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
  let bitmap = await createImageBitmap(blob, bitmapOpts);

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

  // Create the THREE.Texture with final, correct settings — no double config.
  const texture = new THREE.Texture(bitmap);
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
 * Probe known suffix+format URLs directly when FilePicker browse returned no files.
 * This is common for player clients that lack FilePicker access.
 * Uses lightweight HEAD requests to avoid downloading full images just to check existence.
 * All formats are probed in parallel via Promise.any for minimal latency; the first
 * successful response wins (respecting SUPPORTED_FORMATS priority via a small delay trick).
 *
 * @param {string} basePath - Base path without extension (e.g., 'worlds/myworld/maps/BattleMap')
 * @param {string} suffix - Mask suffix (e.g., '_Specular')
 * @returns {Promise<string|null>} URL of the first format that exists, or null
 * @private
 */
async function probeMaskUrl(basePath, suffix) {
  // Build parallel probes — all formats fire simultaneously
  const probes = SUPPORTED_FORMATS.map(async (format) => {
    const url = normalizePath(`${basePath}${suffix}.${format}`);
    const resp = await fetch(url, { method: 'HEAD' });
    if (!resp.ok) throw new Error(`${resp.status}`);
    return url;
  });

  try {
    // Promise.any resolves with the first success
    const url = await Promise.any(probes);
    log.debug(`Direct probe hit: ${url}`);
    return url;
  } catch (_) {
    // All probes failed — mask doesn't exist in any format
    return null;
  }
}

/**
 * Find a mask file with the given suffix in the list of available files
 * @param {string[]} availableFiles - List of available file paths from FilePicker
 * @param {string} basePath - Base path without extension
 * @param {string} suffix - Effect mask suffix (e.g., '_Specular')
 * @returns {string|null} Full path to the mask file, or null if not found
 * @private
 */
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
