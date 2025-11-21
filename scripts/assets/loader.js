/**
 * @fileoverview Asset loader for suffix-based texture system
 * Loads base texture and effect masks with intelligent fallbacks
 * @module assets/loader
 */

import { createLogger } from '../core/log.js';

const log = createLogger('AssetLoader');

/** Supported image formats in priority order */
const SUPPORTED_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];

/** Known effect mask suffixes - currently only PBR masks are implemented */
const EFFECT_MASKS = {
  specular: { suffix: '_Specular', required: false, description: 'Specular highlights mask' },
  roughness: { suffix: '_Roughness', required: false, description: 'Roughness/smoothness map' },
  normal: { suffix: '_Normal', required: false, description: 'Normal map for lighting detail' },
  // TODO: Uncomment as effects are implemented to avoid console spam
  // fire: { suffix: '_Fire', required: false, description: 'Fire effect mask' },
  // outdoors: { suffix: '_Outdoors', required: false, description: 'Indoor/outdoor area mask' },
  iridescence: { suffix: '_Iridescence', required: false, description: 'Iridescence effect mask' },
  prism: { suffix: '_Prism', required: false, description: 'Prism/refraction mask' },
  // water: { suffix: '_Water', required: false, description: 'Water surface mask' },
  // emissive: { suffix: '_Emissive', required: false, description: 'Self-illumination mask' }
};

/** Asset cache to prevent redundant loads */
const assetCache = new Map();

/**
 * Load a complete asset bundle for a scene
 * @param {string} basePath - Base path to scene image (without extension)
 * @param {AssetLoadProgressCallback} [onProgress] - Progress callback
 * @param {Object} [options] - Loading options
 * @param {boolean} [options.skipBaseTexture=false] - Skip loading base texture (if already loaded by Foundry)
 * @returns {Promise<AssetLoadResult>} Loaded asset bundle
 * @public
 */
export async function loadAssetBundle(basePath, onProgress = null, options = {}) {
  const { skipBaseTexture = false } = options;
  log.info(`Loading asset bundle: ${basePath}${skipBaseTexture ? ' (masks only)' : ''}`);
  
  const warnings = [];
  
  try {
    // Check cache first
    const cacheKey = basePath;
    if (assetCache.has(cacheKey)) {
      log.debug('Using cached asset bundle');
      return {
        success: true,
        bundle: assetCache.get(cacheKey),
        warnings: [],
        error: null
      };
    }

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
    const availableFiles = await discoverAvailableFiles(basePath);
    log.debug(`Discovered ${availableFiles.length} files in directory`);

    // Step 3: Load only masks that actually exist
    const masks = [];
    let loaded = skipBaseTexture ? 0 : 1;

    for (const [maskId, maskDef] of Object.entries(EFFECT_MASKS)) {
      if (onProgress) onProgress(loaded, Object.keys(EFFECT_MASKS).length + 1, maskDef.description);

      // Check if this mask exists in discovered files
      const maskFile = findMaskInFiles(availableFiles, basePath, maskDef.suffix);
      
      if (maskFile) {
        const maskTexture = await loadTextureAsync(maskFile);
        if (maskTexture) {
          masks.push({
            id: maskId,
            suffix: maskDef.suffix,
            type: maskId,
            texture: maskTexture,
            required: maskDef.required
          });
          log.debug(`Loaded effect mask: ${maskId} from ${maskFile}`);
        }
      } else if (maskDef.required) {
        warnings.push(`Required mask missing: ${maskId} (${maskDef.suffix})`);
      }

      loaded++;
    }

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

/**
 * Discover available files in the same directory as the base texture
 * Uses Foundry's FilePicker API to avoid 404 spam
 * @param {string} basePath - Base path without extension (e.g., 'modules/mymodule/assets/map')
 * @returns {Promise<string[]>} Array of available file paths
 * @private
 */
async function discoverAvailableFiles(basePath) {
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
    const result = await FilePicker.browse('data', directory);
    
    if (!result || !result.files) {
      log.warn('FilePicker returned no files for directory:', directory);
      return [];
    }

    log.debug(`FilePicker found ${result.files.length} files in ${directory}`);
    return result.files;
    
  } catch (error) {
    log.warn('Failed to discover files via FilePicker:', error.message);
    return [];
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
  
  // Try to find a file matching the suffix pattern
  for (const format of SUPPORTED_FORMATS) {
    const expectedFilename = `${baseFilename}${suffix}.${format}`;
    
    // Check if any available file matches this pattern
    const matchingFile = availableFiles.find(file => {
      const filename = file.substring(file.lastIndexOf('/') + 1);
      return filename === expectedFilename;
    });
    
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
  return path;
}

/**
 * Load a texture asynchronously using Foundry's texture loading system
 * Silently fails for 404s to allow format fallback without console spam
 * @param {string} path - Full path to texture (Foundry module path format)
 * @returns {Promise<THREE.Texture>} Loaded texture
 * @private
 */
async function loadTextureAsync(path) {
  const THREE = window.THREE;
  
  // Use Foundry's loadTexture which handles module paths correctly
  const absolutePath = normalizePath(path);
  
  try {
    // Use Foundry's built-in texture loading (via PIXI)
    // Don't use fallback - let it throw on 404 so we can try next format
    const pixiTexture = await loadTexture(absolutePath);
    
    if (!pixiTexture || !pixiTexture.baseTexture) {
      throw new Error(`Failed to load texture: ${absolutePath}`);
    }
    
    // Convert PIXI texture to THREE.Texture
    const resource = pixiTexture.baseTexture.resource;
    if (!resource || !resource.source) {
      throw new Error(`Texture resource not accessible: ${absolutePath}`);
    }
    
    // Create THREE.Texture from PIXI's loaded image
    const threeTexture = new THREE.Texture(resource.source);
    threeTexture.needsUpdate = true;
    
    // Configure texture settings
    threeTexture.wrapS = THREE.ClampToEdgeWrapping;
    threeTexture.wrapT = THREE.ClampToEdgeWrapping;
    threeTexture.minFilter = THREE.LinearMipmapLinearFilter;
    threeTexture.magFilter = THREE.LinearFilter;
    threeTexture.generateMipmaps = true;
    
    log.debug(`Successfully loaded: ${absolutePath}`);
    return threeTexture;
    
  } catch (error) {
    // Silently fail - this is expected during format probing
    // Only log at debug level to avoid console spam
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
    bundle.baseTexture.dispose();
    for (const mask of bundle.masks) {
      if (mask.texture) {
        mask.texture.dispose();
      }
    }
  }
  
  assetCache.clear();
  log.info('Asset cache cleared');
}

/**
 * Get cache statistics
 * @returns {{size: number, bundles: string[]}} Cache stats
 * @public
 */
export function getCacheStats() {
  return {
    size: assetCache.size,
    bundles: Array.from(assetCache.keys())
  };
}
