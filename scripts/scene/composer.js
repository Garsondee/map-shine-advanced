/**
 * @fileoverview Scene composer - creates 2.5D scene from battlemap assets
 * Handles scene setup, camera positioning, and grid alignment
 * @module scene/composer
 */

import { createLogger } from '../core/log.js';
import * as assetLoader from '../assets/loader.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('SceneComposer');

// Perspective strength multiplier for the camera.
// 1.0  = mathematically exact 1:1 ground-plane mapping (stronger perspective)
// <1.0 = flatter perspective (more orthographic-feeling)
// >1.0 = more exaggerated perspective
// NOTE: Values very far from 1.0 can introduce slight desync vs PIXI; small tweaks
// like 0.9–0.95 are usually safe. Adjust to taste.
const PERSPECTIVE_STRENGTH = 1.0;

/**
 * Scene composer class - manages three.js scene setup for battlemaps
 */
export class SceneComposer {
  constructor() {
    /** @type {THREE.Scene|null} */
    this.scene = null;
    
    /** @type {THREE.PerspectiveCamera|null} */
    this.camera = null;
    
    /** @type {MapAssetBundle|null} */
    this.currentBundle = null;
    
    /** @type {THREE.Mesh|null} */
    this.basePlaneMesh = null;
    
    /** @type {Object} */
    this.foundrySceneData = null;

    /** @type {number|undefined} Canonical ground plane Z (set in setupCamera) */
    this.groundZ = undefined;

    /** @type {number|undefined} Top of the logical world volume (for weather, fog, etc.) */
    this.worldTopZ = undefined;

    /** @type {number|undefined} Preferred emitter Z for world-space weather volumes */
    this.weatherEmitterZ = undefined;
  }

  async _loadMasksOnlyForBasePath(basePath, options = {}) {
    try {
      const res = await assetLoader.loadAssetBundle(basePath, null, { skipBaseTexture: true, ...options });
      if (res?.success && res?.bundle?.masks && Array.isArray(res.bundle.masks)) {
        return res.bundle.masks;
      }
    } catch (e) {
    }
    return [];
  }

  _getLargeSceneMaskTiles() {
    try {
      const tiles = canvas?.scene?.tiles;
      const d = canvas?.dimensions;
      const sr = d?.sceneRect;
      if (!tiles || !sr) return [];

      const sceneX = sr.x ?? 0;
      const sceneY = sr.y ?? 0;
      const sceneW = sr.width ?? 0;
      const sceneH = sr.height ?? 0;
      if (!sceneW || !sceneH) return [];

      const foregroundElevation = canvas?.scene?.foregroundElevation ?? Number.POSITIVE_INFINITY;

      const tol = 1;
      const minArea = sceneW * sceneH * 0.2;
      const out = [];

      for (const tileDoc of tiles) {
        const src = tileDoc?.texture?.src;
        if (typeof src !== 'string' || src.trim().length === 0) continue;

        const elev = Number.isFinite(tileDoc?.elevation) ? tileDoc.elevation : 0;
        if (Number.isFinite(foregroundElevation) && elev >= foregroundElevation) continue;

        const x = Number.isFinite(tileDoc?.x) ? tileDoc.x : 0;
        const y = Number.isFinite(tileDoc?.y) ? tileDoc.y : 0;
        const w = Number.isFinite(tileDoc?.width) ? tileDoc.width : 0;
        const h = Number.isFinite(tileDoc?.height) ? tileDoc.height : 0;
        if (!w || !h) continue;

        const area = w * h;
        if (area < minArea) continue;

        const yAligned = Math.abs(y - sceneY) <= tol && Math.abs(h - sceneH) <= tol;
        if (!yAligned) continue;

        out.push({
          tileDoc,
          src: src.trim(),
          basePath: this.extractBasePath(src.trim()),
          rect: { x, y, w, h }
        });
      }

      out.sort((a, b) => (a.rect.x - b.rect.x));
      return out;
    } catch (e) {
      return [];
    }
  }

  _computeSceneMaskCompositeLayout(tiles) {
    try {
      const d = canvas?.dimensions;
      const sr = d?.sceneRect;
      if (!sr) return null;

      const sceneX = sr.x ?? 0;
      const sceneY = sr.y ?? 0;
      const sceneW = sr.width ?? 0;
      const sceneH = sr.height ?? 0;
      if (!sceneW || !sceneH) return null;

      if (!Array.isArray(tiles) || tiles.length < 2) return null;

      const tol = 1;
      const segments = [];
      for (const t of tiles) {
        const r = t?.rect;
        if (!r) continue;
        const coversY = Math.abs(r.y - sceneY) <= tol && Math.abs(r.h - sceneH) <= tol;
        if (!coversY) continue;
        const x0 = r.x;
        const x1 = r.x + r.w;
        const sx0 = Math.max(sceneX, Math.min(sceneX + sceneW, x0));
        const sx1 = Math.max(sceneX, Math.min(sceneX + sceneW, x1));
        if (sx1 - sx0 <= tol) continue;

        segments.push({
          basePath: t.basePath,
          src: t.src,
          tileDoc: t.tileDoc,
          sceneX,
          sceneY,
          sceneW,
          sceneH,
          segX0: sx0,
          segX1: sx1
        });
      }

      if (segments.length < 2) return null;

      segments.sort((a, b) => a.segX0 - b.segX0);
      let covered = 0;
      let cursor = sceneX;
      for (const s of segments) {
        if (s.segX1 <= cursor + tol) continue;
        if (s.segX0 > cursor + tol) {
          cursor = s.segX0;
        }
        const add = Math.max(0, s.segX1 - cursor);
        covered += add;
        cursor = Math.max(cursor, s.segX1);
      }

      const coverFrac = covered / sceneW;
      if (coverFrac < 0.95) return null;

      return { sceneX, sceneY, sceneW, sceneH, segments };
    } catch (e) {
      return null;
    }
  }

  async _buildCompositeSceneMasks(layout, perBaseMasks) {
    const THREE = window.THREE;
    if (!THREE || !layout) return null;

    const renderer = window.MapShine?.renderer;
    const maxTex = renderer?.capabilities?.maxTextureSize;
    const cap = Number.isFinite(maxTex) ? Math.max(256, Math.floor(maxTex)) : 4096;
    const hardCap = Math.min(cap, 8192);

    const sceneW = layout.sceneW;
    const sceneH = layout.sceneH;
    const scale = Math.min(1.0, hardCap / Math.max(1, sceneW), hardCap / Math.max(1, sceneH));

    const outW = Math.max(1, Math.round(sceneW * scale));
    const outH = Math.max(1, Math.round(sceneH * scale));

    const registry = assetLoader.getEffectMaskRegistry?.() || {};
    const compositeMasks = [];

    for (const [maskId, def] of Object.entries(registry)) {
      const suffix = def?.suffix;
      if (typeof suffix !== 'string' || !suffix) continue;

      const canvasEl = document.createElement('canvas');
      canvasEl.width = outW;
      canvasEl.height = outH;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) continue;

      ctx.clearRect(0, 0, outW, outH);

      let any = false;
      let desiredFlipY = null;

      for (const seg of layout.segments) {
        const masks = perBaseMasks.get(seg.basePath) || [];
        const m = masks.find((x) => x?.id === maskId || x?.type === maskId);
        const tex = m?.texture;
        if (desiredFlipY === null && tex && typeof tex.flipY === 'boolean') {
          desiredFlipY = tex.flipY;
        }
        const img = tex?.image;
        if (!img) continue;

        const segU0 = (seg.segX0 - layout.sceneX) / layout.sceneW;
        const segU1 = (seg.segX1 - layout.sceneX) / layout.sceneW;
        const dx = Math.round(segU0 * outW);
        const dw = Math.max(1, Math.round((segU1 - segU0) * outW));

        try {
          ctx.drawImage(img, 0, 0, img.width, img.height, dx, 0, dw, outH);
          any = true;
        } catch (e) {
        }
      }

      if (!any) continue;

      const outTex = new THREE.Texture(canvasEl);
      outTex.needsUpdate = true;

      const isDataTexture = ['normal', 'roughness', 'water'].includes(maskId);
      if (THREE.SRGBColorSpace && !isDataTexture) {
        outTex.colorSpace = THREE.SRGBColorSpace;
      }

      outTex.minFilter = THREE.LinearFilter;
      outTex.magFilter = THREE.LinearFilter;
      outTex.generateMipmaps = false;

      // Preserve the original mask texture's flipY convention so the composite
      // behaves identically to the single-image (scene background) case.
      outTex.flipY = desiredFlipY === null ? outTex.flipY : desiredFlipY;

      compositeMasks.push({
        id: maskId,
        suffix,
        type: maskId,
        texture: outTex,
        required: !!def?.required
      });
    }

    return { masks: compositeMasks, width: outW, height: outH };
  }

  async _buildCompositeSceneAlbedo(layout) {
    const THREE = window.THREE;
    if (!THREE || !layout) return null;

    const renderer = window.MapShine?.renderer;
    const maxTex = renderer?.capabilities?.maxTextureSize;
    const cap = Number.isFinite(maxTex) ? Math.max(256, Math.floor(maxTex)) : 4096;
    const hardCap = Math.min(cap, 8192);

    const sceneW = layout.sceneW;
    const sceneH = layout.sceneH;
    const scale = Math.min(1.0, hardCap / Math.max(1, sceneW), hardCap / Math.max(1, sceneH));

    const outW = Math.max(1, Math.round(sceneW * scale));
    const outH = Math.max(1, Math.round(sceneH * scale));

    const canvasEl = document.createElement('canvas');
    canvasEl.width = outW;
    canvasEl.height = outH;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, outW, outH);

    const loadTextureFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
    if (!loadTextureFn) return null;

    let any = false;

    for (const seg of layout.segments) {
      const src = seg?.src;
      if (typeof src !== 'string' || !src.trim()) continue;

      let img = null;
      try {
        const pixiTexture = await loadTextureFn(src.trim());
        const resource = pixiTexture?.baseTexture?.resource;
        img = resource?.source || null;
      } catch (e) {
        img = null;
      }

      if (!img) continue;

      const segU0 = (seg.segX0 - layout.sceneX) / layout.sceneW;
      const segU1 = (seg.segX1 - layout.sceneX) / layout.sceneW;
      const dx = Math.round(segU0 * outW);
      const dw = Math.max(1, Math.round((segU1 - segU0) * outW));

      try {
        ctx.drawImage(img, 0, 0, img.width, img.height, dx, 0, dw, outH);
        any = true;
      } catch (e) {
      }
    }

    if (!any) return null;

    const outTex = new THREE.Texture(canvasEl);
    outTex.needsUpdate = true;
    if (THREE.SRGBColorSpace) {
      outTex.colorSpace = THREE.SRGBColorSpace;
    }
    outTex.minFilter = THREE.LinearFilter;
    outTex.magFilter = THREE.LinearFilter;
    outTex.generateMipmaps = false;
    outTex.flipY = false;

    return { texture: outTex, width: outW, height: outH };
  }

  _resolveMaskSourceSrc(foundryScene) {
    try {
      const override = foundryScene?.getFlag?.('map-shine-advanced', 'maskSource');
      if (typeof override === 'string' && override.trim().length > 0) {
        return override.trim();
      }
    } catch (e) {
    }

    // Auto-detect: choose a likely full-scene "base" tile (common for multi-layer maps)
    try {
      const tiles = canvas?.scene?.tiles;
      const d = canvas?.dimensions;
      const sr = d?.sceneRect;
      if (!tiles || !sr) return null;

      const sceneX = sr.x ?? 0;
      const sceneY = sr.y ?? 0;
      const sceneW = sr.width ?? (d?.sceneWidth ?? d?.width ?? 0);
      const sceneH = sr.height ?? (d?.sceneHeight ?? d?.height ?? 0);
      if (!sceneW || !sceneH) return null;

      const foregroundElevation = canvas?.scene?.foregroundElevation ?? Number.POSITIVE_INFINITY;

      let bestSrc = null;
      let bestScore = -Infinity;

      for (const tileDoc of tiles) {
        const src = tileDoc?.texture?.src;
        if (typeof src !== 'string' || src.trim().length === 0) continue;

        let score = 0;

        // Prefer non-overhead tiles
        const elev = Number.isFinite(tileDoc?.elevation) ? tileDoc.elevation : 0;
        if (Number.isFinite(foregroundElevation) && elev >= foregroundElevation) score -= 1000;

        // Prefer tiles that cover the full sceneRect
        const tol = 1;
        const coversScene = (
          Math.abs((tileDoc?.x ?? 0) - sceneX) <= tol &&
          Math.abs((tileDoc?.y ?? 0) - sceneY) <= tol &&
          Math.abs((tileDoc?.width ?? 0) - sceneW) <= tol &&
          Math.abs((tileDoc?.height ?? 0) - sceneH) <= tol
        );
        if (coversScene) score += 50;

        // Prefer common naming conventions
        try {
          const filename = src.substring(src.lastIndexOf('/') + 1).toLowerCase();
          if (filename.includes('ground')) score += 15;
          if (filename.includes('base')) score += 5;
          if (filename.includes('albedo')) score += 2;
        } catch (e) {
        }

        // Prefer larger tiles in general
        const area = Math.max(0, (tileDoc?.width ?? 0) * (tileDoc?.height ?? 0));
        score += Math.min(10, Math.log2(area + 1));

        // Prefer lower elevations
        score -= elev * 0.01;

        if (score > bestScore) {
          bestScore = score;
          bestSrc = src.trim();
        }
      }

      return bestSrc;
    } catch (e) {
    }

    try {
      const fallbackBg = foundryScene?.background?.src;
      if (typeof fallbackBg === 'string' && fallbackBg.trim().length > 0) {
        return fallbackBg.trim();
      }
    } catch (e) {
    }

    return null;
  }

  /**
   * Initialize a new scene from Foundry scene data
   * @param {Scene} foundryScene - Foundry VTT scene object
   * @param {number} viewportWidth - Viewport width in pixels
   * @param {number} viewportHeight - Viewport height in pixels
   * @param {{onProgress?: (loaded:number, total:number, asset:string)=>void}} [options]
   * @returns {Promise<{scene: THREE.Scene, camera: THREE.Camera, bundle: MapAssetBundle}>}
   */
  async initialize(foundryScene, viewportWidth, viewportHeight, options = {}) {
    log.info(`Initializing scene: ${foundryScene?.name || 'unnamed'}`);

    const THREE = window.THREE;
    if (!THREE) {
      throw new Error('three.js not loaded');
    }

    // Validate foundryScene exists
    if (!foundryScene) {
      throw new Error('No Foundry scene provided');
    }

    // Validate dimensions exist (required for camera/plane setup)
    if (!foundryScene.dimensions) {
      throw new Error('Scene has no dimensions data');
    }

    // Store Foundry scene data with safe defaults
    this.foundrySceneData = {
      width: foundryScene.dimensions.width || 1000,
      height: foundryScene.dimensions.height || 1000,
      sceneWidth: foundryScene.dimensions.sceneWidth || foundryScene.dimensions.width || 1000,
      sceneHeight: foundryScene.dimensions.sceneHeight || foundryScene.dimensions.height || 1000,
      gridSize: foundryScene.grid?.size || 100,
      gridType: foundryScene.grid?.type || 1,
      padding: foundryScene.padding || 0,
      backgroundColor: foundryScene.backgroundColor || '#999999'
    };

    // Create three.js scene
    this.scene = new THREE.Scene();
    // Remove explicit scene background to rely on renderer clear color (which is forced to black)
    // this.scene.background = new THREE.Color(0x000000); 
    
    // Check if scene has a background image
    const hasBackgroundImage = foundryScene.background?.src && 
                               typeof foundryScene.background.src === 'string' && 
                               foundryScene.background.src.trim().length > 0;
    
    let baseTexture = null;
    let bgPath = null;

    // Determine which source image drives suffix-mask discovery.
    // This may be the scene background or a full-scene tile (common for layered maps).
    const maskSourceSrc = this._resolveMaskSourceSrc(foundryScene);
    if (maskSourceSrc) {
      bgPath = this.extractBasePath(maskSourceSrc);
      log.info(`Mask source: ${maskSourceSrc}`);
      log.info(`Loading effect masks for: ${bgPath}`);
    }

    if (hasBackgroundImage) {
      // Use Foundry's already-loaded background texture instead of reloading
      // Foundry's canvas.primary.background.texture is already loaded and accessible
      baseTexture = await this.getFoundryBackgroundTexture(foundryScene);
      if (!baseTexture) {
        log.warn('Could not access Foundry background texture, using fallback');
      }
    } else {
      log.info('Scene has no background image, using solid color fallback');
    }
    
    // Load effect masks if we have a background path
    let result = { success: false, bundle: { masks: [] }, warnings: [] };
    if (bgPath) {
      result = await assetLoader.loadAssetBundle(
        bgPath,
        (loaded, total, asset) => {
          log.debug(`Asset loading: ${loaded}/${total} - ${asset}`);
          try {
            if (typeof options?.onProgress === 'function') {
              options.onProgress(loaded, total, asset);
            }
          } catch (e) {
            log.warn('Asset progress callback failed:', e);
          }
        },
        { skipBaseTexture: true } // Skip base texture since we got it from Foundry
      );
    }

    this._maskCompositeInfo = null;
    this._albedoCompositeInfo = null;
    let compositeLayout = null;
    try {
      const tileCandidates = this._getLargeSceneMaskTiles();
      const layout = this._computeSceneMaskCompositeLayout(tileCandidates);
      compositeLayout = layout;
      if (layout) {
        const perBaseMasks = new Map();
        for (const seg of layout.segments) {
          if (!seg?.basePath || perBaseMasks.has(seg.basePath)) continue;
          const masks = await this._loadMasksOnlyForBasePath(seg.basePath);
          perBaseMasks.set(seg.basePath, masks);
        }

        const composite = await this._buildCompositeSceneMasks(layout, perBaseMasks);
        if (composite?.masks?.length) {
          result = {
            success: true,
            bundle: {
              masks: composite.masks,
              isMapShineCompatible: true
            },
            warnings: result?.warnings || [],
            error: null
          };

          this._maskCompositeInfo = {
            enabled: true,
            sceneRect: { x: layout.sceneX, y: layout.sceneY, w: layout.sceneW, h: layout.sceneH },
            outputSize: { w: composite.width, h: composite.height },
            segments: layout.segments.map((s) => ({
              basePath: s.basePath,
              src: s.src,
              segX0: s.segX0,
              segX1: s.segX1
            }))
          };
        }
      }
    } catch (e) {
    }

    if (!hasBackgroundImage && !baseTexture && compositeLayout) {
      try {
        const compositeAlbedo = await this._buildCompositeSceneAlbedo(compositeLayout);
        if (compositeAlbedo?.texture) {
          baseTexture = compositeAlbedo.texture;
          this._albedoCompositeInfo = {
            enabled: true,
            outputSize: { w: compositeAlbedo.width, h: compositeAlbedo.height },
            segments: compositeLayout.segments.map((s) => ({
              basePath: s.basePath,
              src: s.src,
              segX0: s.segX0,
              segX1: s.segX1
            }))
          };
        }
      } catch (e) {
      }
    }

    // Create bundle with Foundry's texture + any masks that loaded successfully
    this.currentBundle = {
      basePath: bgPath || '',
      baseTexture: baseTexture,
      masks: result.success ? result.bundle.masks : [],
      isMapShineCompatible: result.success ? result.bundle.isMapShineCompatible : false
    };

    // Normalize mask textures to the same UV convention as the base plane.
    // The base plane uses flipY=false and a geometry Y-inversion (scale.y=-1)
    // to align Foundry's top-left origin. Masks must follow the same.
    try {
      if (this.currentBundle?.masks && Array.isArray(this.currentBundle.masks)) {
        for (const m of this.currentBundle.masks) {
          const tex = m?.texture;
          if (!tex || typeof tex.flipY !== 'boolean') continue;
          if (tex.flipY !== false) {
            tex.flipY = false;
            tex.needsUpdate = true;
          }
        }
      }
    } catch (e) {
    }

    // Create base plane mesh (with texture or fallback color)
    this.createBasePlane(baseTexture);

    // Setup perspective camera with FOV-based zoom
    this.setupCamera(viewportWidth, viewportHeight);

    log.info(`Scene initialized: ${this.currentBundle.masks.length} effect masks available`);
    if (result.warnings && result.warnings.length > 0) {
      log.warn('Asset warnings:', result.warnings);
    }

    return {
      scene: this.scene,
      camera: this.camera,
      bundle: this.currentBundle
    };
  }

  /**
   * Extract base path from Foundry image URL
   * @param {string} src - Foundry image source path
   * @returns {string} Base path without extension
   * @private
   */
  extractBasePath(src) {
    // Remove extension
    const lastDot = src.lastIndexOf('.');
    if (lastDot > 0) {
      return src.substring(0, lastDot);
    }
    return src;
  }

  /**
   * Get Foundry's already-loaded background texture as a THREE.Texture
   * @param {Scene} foundryScene - Foundry VTT scene object
   * @returns {Promise<THREE.Texture|null>} THREE.js texture or null if not found
   * @private
   */
  async getFoundryBackgroundTexture(foundryScene) {
    const THREE = window.THREE;
    
    // Wait for Foundry's canvas to be ready
    if (!canvas || !canvas.primary) {
      log.warn('Foundry canvas not ready');
      return null;
    }

    // Access Foundry's PIXI texture for the scene background
    const pixiTexture = canvas.primary.background?.texture;
    if (!pixiTexture || !pixiTexture.baseTexture) {
      log.warn('Foundry background texture not found');
      return null;
    }

    // Get the HTMLImageElement or HTMLCanvasElement from PIXI
    const baseTexture = pixiTexture.baseTexture;
    const resource = baseTexture.resource;
    
    if (!resource || !resource.source) {
      log.warn('Foundry texture resource not accessible');
      return null;
    }

    // Create THREE.Texture from the same image source
    const threeTexture = new THREE.Texture(resource.source);
    threeTexture.needsUpdate = true;
    // Use sRGB for correct color in lighting calculations
    if (THREE.SRGBColorSpace) {
      threeTexture.colorSpace = THREE.SRGBColorSpace;
    }
    // Flip Y: PIXI textures are top-left origin, three.js UVs are bottom-left origin
    threeTexture.flipY = false;
    
    // Match PIXI's texture settings
    threeTexture.wrapS = THREE.ClampToEdgeWrapping;
    threeTexture.wrapT = THREE.ClampToEdgeWrapping;
    threeTexture.minFilter = THREE.LinearFilter;
    threeTexture.magFilter = THREE.LinearFilter;

    log.debug('Converted Foundry texture to THREE.Texture');
    return threeTexture;
  }

  /**
   * Create the base plane mesh with battlemap texture
   * @param {THREE.Texture|null} texture - Base battlemap texture (null for blank maps)
   * @private
   */
  createBasePlane(texture) {
    const THREE = window.THREE;

    // Get texture dimensions (or use scene dimensions for blank maps)
    const imgWidth = texture?.image?.width || this.foundrySceneData.sceneWidth;
    const imgHeight = texture?.image?.height || this.foundrySceneData.sceneHeight;

    log.debug(`Creating base plane: ${imgWidth}x${imgHeight}px${texture ? '' : ' (no texture)'}`);

    // Create plane geometry matching texture aspect ratio
    // Use Foundry scene dimensions for world space size
    const worldWidth = this.foundrySceneData.width;
    const worldHeight = this.foundrySceneData.height;
    const sceneWidth = this.foundrySceneData.sceneWidth;
    const sceneHeight = this.foundrySceneData.sceneHeight;

    // Solid background plane covering the entire world (including padding)
    const bgColorStr = this.foundrySceneData.backgroundColor || '#999999';
    let bgColorInt = 0x999999;
    try {
      const hex = bgColorStr.replace('#', '');
      const parsed = parseInt(hex, 16);
      if (!Number.isNaN(parsed)) bgColorInt = parsed;
    } catch (e) {
      // Fallback already set
    }
    const bgGeometry = new THREE.PlaneGeometry(worldWidth, worldHeight);
    const bgMaterial = new THREE.MeshBasicMaterial({ color: bgColorInt });
    const bgMesh = new THREE.Mesh(bgGeometry, bgMaterial);
    // Position background slightly behind the base plane
    // groundZ is set when basePlaneMesh is created (1000 by default)
    // For perfect PIXI alignment with camera at Z=2000, ground should be at Z=1000
    // This gives distanceToGround = 1000, matching the base FOV calculation
    const GROUND_Z = 1000; // Canonical ground plane Z position
    bgMesh.position.set(worldWidth / 2, worldHeight / 2, GROUND_Z - 0.1);
    this.scene.add(bgMesh);

    // Use SCENE dimensions for geometry to prevent stretching texture across padding
    const geometry = new THREE.PlaneGeometry(sceneWidth, sceneHeight);
    
    // Basic material for now (will be replaced with PBR material in effect system)
    // If no texture, use scene background color
    let material;
    if (texture) {
      material = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.FrontSide, // Only render texture on front
        transparent: false
      });
      // Flip Y to correct UV orientation mismatch between PIXI and three.js
      if (material.map) { 
        material.map.flipY = false; 
        material.map.needsUpdate = true; 
      }
    } else {
      // Fallback: solid color plane for blank maps
      material = new THREE.MeshBasicMaterial({
        color: bgColorInt,
        side: THREE.FrontSide,
        transparent: false
      });
      log.info('Using solid color material for blank map');
    }

    this.basePlaneMesh = new THREE.Mesh(geometry, material);
    this.basePlaneMesh.name = 'BasePlane';
    
    // Create red back-face for orientation debugging
    const backMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      side: THREE.BackSide
    });
    const backMesh = new THREE.Mesh(geometry, backMaterial);
    backMesh.name = 'BasePlane_Back';
    this.basePlaneMesh.add(backMesh);
    
    // Position at world center at the canonical ground Z
    // This value (1000) is the canonical groundZ that all other layers reference
    // With camera at Z=2000, this gives distanceToGround=1000 for clean 1:1 pixel mapping
    this.basePlaneMesh.position.set(worldWidth / 2, worldHeight / 2, GROUND_Z);
    
    // CRITICAL: Foundry uses Y-down coordinates (0 at top, H at bottom). 
    // Three.js uses Y-up (0 at bottom, H at top).
    // Strategy: Map Foundry 0 -> World H (Top) and Foundry H -> World 0 (Bottom).
    // Plane Geometry is created at center (W/2, H/2).
    // Top-Left Vertex is at (0, H). Bottom-Right is at (W, 0).
    // Texture (FlipY=false) maps Image Top-Left to Vertex Bottom-Left? No.
    // With scale.y = -1, we invert the geometry.
    
    this.basePlaneMesh.scale.y = -1; 
    
    this.scene.add(this.basePlaneMesh);
    log.info(`Base plane added: size ${worldWidth}x${worldHeight}, pos (${worldWidth/2}, ${worldHeight/2}, 0)`);
  }

  /**
   * Setup perspective camera with FOV-based zoom for 2.5D top-down view
   * 
   * This approach keeps the camera at a FIXED Z position and zooms by
   * adjusting the FOV. This gives us:
   * - Perspective depth for particles (rain/snow look 3D)
   * - Fixed near/far planes (no depth precision issues)
   * - Ground plane always at same depth in frustum (no disappearing)
   * - Parallax effects during pan
   * 
   * The key insight: ground plane disappearing was caused by camera Z
   * moving, which changed the ground's position in the depth buffer.
   * With FOV zoom, ground stays at constant depth.
   * 
   * @param {number} viewportWidth - Viewport width in CSS pixels
   * @param {number} viewportHeight - Viewport height in CSS pixels
   * @private
   */
  setupCamera(viewportWidth, viewportHeight) {
    const THREE = window.THREE;

    const worldWidth = this.foundrySceneData.width;
    const worldHeight = this.foundrySceneData.height;

    // Center of the world (where camera looks)
    const centerX = worldWidth / 2;
    const centerY = worldHeight / 2;

    // FIXED CAMERA HEIGHT - never changes during zoom
    // This is the key to stability: ground plane is always at a predictable
    // depth relative to camera, so no near/far plane issues.
    const CAMERA_HEIGHT = 2000;
    
    // The ground plane may be offset in Z (e.g. 0, 900, etc.). Use the
    // ACTUAL distance between camera and ground for FOV math so that
    // moving the plane in Z does not break alignment with PIXI.
    const groundZ = this.basePlaneMesh?.position?.z ?? 0;
    const distanceToGround = Math.max(1, CAMERA_HEIGHT - groundZ);

    // Calculate base FOV to achieve 1:1 pixel mapping at zoom=1.
    // At zoom=1, we want to see exactly viewportHeight world units vertically
    // at the ground plane depth.
    // FOV = 2 * atan((viewportHeight/2) / distanceToGround)
    const baseFovRadiansRaw = 2 * Math.atan(viewportHeight / (2 * distanceToGround));

    // Apply perspective strength tweak: 1.0 = raw math, <1.0 = flatter.
    const baseFovRadians = baseFovRadiansRaw * PERSPECTIVE_STRENGTH;
    const baseFovDegrees = baseFovRadians * (180 / Math.PI);
    
    const aspect = viewportWidth / viewportHeight;

    this.camera = new THREE.PerspectiveCamera(
      baseFovDegrees,
      aspect,
      1,            // near - fixed, close enough for all content
      5000          // far - fixed, far enough for all content
    );

    // Position camera at fixed height above world center, looking down -Z
    this.camera.position.set(centerX, centerY, CAMERA_HEIGHT);
    
    // Standard Orientation (Look down -Z, Up is +Y)
    this.camera.rotation.set(0, 0, 0);
    
    this.camera.updateMatrix();
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();
    
    // Store camera constants for zoom calculations
    this.cameraHeight = CAMERA_HEIGHT;
    this.groundZ = groundZ;
    this.groundDistance = distanceToGround;
    // Define canonical vertical bounds for the world volume so that
    // all effects (weather, fog, etc.) can place content relative to
    // the ground plane without duplicating constants.
    this.worldTopZ = groundZ + 7500;
    this.weatherEmitterZ = groundZ + 6500;
    this.baseFov = baseFovDegrees;
    this.baseFovRadians = baseFovRadians;
    this.baseFovTanHalf = Math.tan(baseFovRadians / 2);
    this.currentZoom = 1.0;
    
    // Store base viewport dimensions for resize calculations
    this.baseViewportWidth = viewportWidth;
    this.baseViewportHeight = viewportHeight;
    
    // Legacy compatibility - some code checks these
    this.cameraDistance = CAMERA_HEIGHT;
    this.baseDistance = CAMERA_HEIGHT;

    log.info(`Perspective camera setup (FOV zoom): height=${CAMERA_HEIGHT}, groundZ=${groundZ}, distance=${distanceToGround}, baseFOV=${baseFovDegrees.toFixed(2)}°, center (${centerX}, ${centerY}), viewport ${viewportWidth}x${viewportHeight}`);
  }

  /**
   * Update camera on viewport resize
   * @param {number} viewportWidth - New viewport width
   * @param {number} viewportHeight - New viewport height
   */
  resize(viewportWidth, viewportHeight) {
    if (!this.camera) return;

    // Update aspect ratio
    this.camera.aspect = viewportWidth / viewportHeight;
    
    // Recalculate base FOV for new viewport height using the actual
    // camera-to-ground distance. This keeps zoom + parallax consistent
    // even if the base plane Z has been tweaked.
    const groundZ = this.basePlaneMesh?.position?.z ?? (this.groundZ ?? 0);
    const distanceToGround = Math.max(1, this.cameraHeight - groundZ);
    this.groundZ = groundZ;
    this.groundDistance = distanceToGround;
    // Keep vertical bounds in sync if the base plane Z changes (e.g. via
    // future editing tools or scene configuration).
    this.worldTopZ = groundZ + 7500;
    this.weatherEmitterZ = groundZ + 6500;

    const baseFovRadiansRaw = 2 * Math.atan(viewportHeight / (2 * distanceToGround));
    const baseFovRadians = baseFovRadiansRaw * PERSPECTIVE_STRENGTH;
    this.baseFov = baseFovRadians * (180 / Math.PI);
    this.baseFovRadians = baseFovRadians;
    this.baseFovTanHalf = Math.tan(baseFovRadians / 2);

    // Apply current zoom to new base FOV
    if (this.camera.isPerspectiveCamera) {
      const baseTan = this.baseFovTanHalf;
      const zoom = this.currentZoom || 1;
      const fovRad = 2 * Math.atan(baseTan / zoom);
      this.camera.fov = fovRad * (180 / Math.PI);
    }
    
    this.camera.updateProjectionMatrix();
    
    // Update stored dimensions
    this.baseViewportWidth = viewportWidth;
    this.baseViewportHeight = viewportHeight;

    log.debug(`Camera resized: ${viewportWidth}x${viewportHeight}, FOV=${this.camera.fov.toFixed(2)}°`);
  }

  /**
   * Pan camera by offset
   * @param {number} deltaX - X offset in world units
   * @param {number} deltaY - Y offset in world units
   */
  pan(deltaX, deltaY) {
    if (!this.camera) return;

    // Translate camera in XY (Z stays fixed)
    let newX = this.camera.position.x + deltaX;
    let newY = this.camera.position.y + deltaY;
    
    // Clamp camera to scene bounds + margin
    const width = this.foundrySceneData.width;
    const height = this.foundrySceneData.height;
    const marginX = Math.max(2000, width * 0.5);
    const marginY = Math.max(2000, height * 0.5);
    
    newX = Math.max(-marginX, Math.min(newX, width + marginX));
    newY = Math.max(-marginY, Math.min(newY, height + marginY));
    
    this.camera.position.x = newX;
    this.camera.position.y = newY;
    // Z stays at cameraHeight - never changes
    
    log.debug(`Camera pan to (${this.camera.position.x.toFixed(1)}, ${this.camera.position.y.toFixed(1)})`);
  }

  /**
   * Get Foundry-compatible zoom scale limits
   * Mirrors Foundry VTT's Canvas#getDimensions zoom calculation
   * @returns {{min: number, max: number}} Scale limits (1.0 = base zoom)
   * @private
   */
  getZoomLimits() {
    const { innerWidth, innerHeight } = window;
    const width = this.foundrySceneData.width;
    const height = this.foundrySceneData.height;
    const gridSize = this.foundrySceneData.gridSize;
    const padding = gridSize; // Use grid size as padding like Foundry
    
    // Min scale: fit entire padded scene in viewport
    // Matches Foundry: Math.min(innerWidth / paddedWidth, innerHeight / paddedHeight, 1)
    const paddedWidth = width + (2 * padding);
    const paddedHeight = height + (2 * padding);
    let minScale = CONFIG?.Canvas?.minZoom;
    if (minScale === undefined) {
      minScale = Math.min(innerWidth / paddedWidth, innerHeight / paddedHeight, 1);
    }
    
    // Max scale: zoom in to see ~3 grid cells
    // Matches Foundry: factor = 3 * (sourceGridSize / gridSize)
    // maxScale = Math.max(Math.min(innerWidth / gridSizeX, innerHeight / gridSizeY) / factor, minScale)
    let maxScale = CONFIG?.Canvas?.maxZoom;
    if (maxScale === undefined) {
      const factor = 3; // 3 grid cells visible at max zoom
      maxScale = Math.max(Math.min(innerWidth / gridSize, innerHeight / gridSize) / factor, minScale);
    }
    
    return { min: minScale, max: maxScale };
  }

  /**
   * Zoom camera by factor using FOV adjustment
   * 
   * FOV zoom: narrower FOV = magnified view (zoom in)
   *           wider FOV = wider view (zoom out)
   * 
   * Formula: currentFOV = baseFOV / zoomLevel
   * 
   * @param {number} zoomFactor - Zoom multiplier (>1 = zoom in, <1 = zoom out)
   * @param {number} centerX - Zoom center X in viewport space (0-1, default 0.5) - UNUSED for now
   * @param {number} centerY - Zoom center Y in viewport space (0-1, default 0.5) - UNUSED for now
   */
  zoom(zoomFactor, centerX = 0.5, centerY = 0.5) {
    if (!this.camera) return;

    let newZoom = this.currentZoom * zoomFactor;
    
    // Get Foundry-compatible zoom limits
    const limits = this.getZoomLimits();
    
    // Clamp zoom to limits
    newZoom = Math.max(limits.min, Math.min(newZoom, limits.max));
    
    // Store zoom level
    this.currentZoom = newZoom;
    
    // Apply FOV zoom: higher zoom = narrower FOV
    // Clamp FOV to reasonable range (1° to 170°)
    const newFov = Math.max(1, Math.min(170, this.baseFov / newZoom));
    this.camera.fov = newFov;
    this.camera.updateProjectionMatrix();

    log.debug(`Camera zoom: ${newZoom.toFixed(3)} (FOV=${newFov.toFixed(2)}°, limits: ${limits.min.toFixed(3)}-${limits.max.toFixed(3)})`);
  }

  /**
   * Get current zoom scale
   * @returns {number} Current zoom scale (1.0 = default)
   */
  getZoomScale() {
    if (!this.camera) return 1.0;
    // FOV-based zoom: return stored zoom level
    return this.currentZoom;
  }

  /**
   * Get the current asset bundle
   * @returns {MapAssetBundle|null}
   */
  getAssetBundle() {
    return this.currentBundle;
  }

  /**
   * Get the base plane mesh
   * @returns {THREE.Mesh|null}
   */
  getBasePlane() {
    return this.basePlaneMesh;
  }

  /**
   * Dispose scene resources
   */
  dispose() {
    if (this.basePlaneMesh) {
      this.basePlaneMesh.geometry.dispose();
      this.basePlaneMesh.material.dispose();
      this.basePlaneMesh = null;
    }

    if (this.scene) {
      this.scene.clear();
      this.scene = null;
    }

    this.camera = null;
    this.currentBundle = null;

    log.info('Scene composer disposed');
  }
}
