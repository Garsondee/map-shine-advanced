/**
 * @fileoverview Tile manager - syncs Foundry tiles to THREE.js sprites
 * Handles creation, updates, and deletion of tile sprites in the THREE.js scene
 * Support for Background, Foreground, and Overhead tile layers
 * @module scene/tile-manager
 */

import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';
import { OVERLAY_THREE_LAYER, TILE_FEATURE_LAYERS } from '../effects/EffectComposer.js';

const log = createLogger('TileManager');

// TEMPORARY KILL-SWITCH: Disable tile manager updates for perf testing.
// Set to true to skip all tile sync operations.
// Currently FALSE so tiles behave normally while we profile other systems.
const DISABLE_TILE_UPDATES = false;

// Z-layer offsets from groundZ (from Architecture)
// These are OFFSETS added to groundZ, not absolute values.
// Compressed so all tiles live in a very thin band above the ground plane.
// Background < Foreground < Overhead, but differences are tiny.
const Z_BACKGROUND_OFFSET = 0.01;
const Z_FOREGROUND_OFFSET = 0.02;
const Z_OVERHEAD_OFFSET = 0.03;

const ROOF_LAYER = 20;
const WEATHER_ROOF_LAYER = 21;
const WATER_OCCLUDER_LAYER = 22;

/**
 * TileManager - Synchronizes Foundry VTT tiles to THREE.js sprites
 * Handles layering (Background/Foreground/Overhead) and reactive updates
 */
export class TileManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene to add tile sprites to
   */
  constructor(scene) {
    this.scene = scene;
    
    /** @type {Map<string, {sprite: THREE.Sprite, tileDoc: TileDocument}>} */
    this.tileSprites = new Map();
    
    /** @type {THREE.TextureLoader} */
    this.textureLoader = new THREE.TextureLoader();
    
    /** @type {Map<string, THREE.Texture>} */
    this.textureCache = new Map();
    
    /** @type {Map<string, {width: number, height: number, data: Uint8ClampedArray}>} */
    this.alphaMaskCache = new Map();

    this._overheadTileIds = new Set();
    this._weatherRoofTileIds = new Set();
    
    this.initialized = false;
    this.hooksRegistered = false;
    
    // PERFORMANCE: Reusable color objects to avoid per-frame allocations
    this._globalTint = null;      // Lazy init when THREE is available
    this._tempDaylight = null;
    this._tempDarkness = null;
    this._tempAmbient = null;

    this._lastTintKey = null;
    this._tintDirty = true;
    
    // Window light effect reference for overhead tile lighting
    /** @type {WindowLightEffect|null} */
    this.windowLightEffect = null;
    
    log.debug('TileManager created');
  }

  /**
   * Set the WindowLightEffect reference for overhead tile lighting
   * @param {WindowLightEffect} effect
   */
  setWindowLightEffect(effect) {
    this.windowLightEffect = effect;
    // Clear cached mask data so it gets re-extracted
    this._windowMaskData = null;
    this._windowMaskExtractFailed = false;
    this._outdoorsMaskData = null;
    this._outdoorsMaskExtractFailed = false;
    log.debug('WindowLightEffect linked to TileManager');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) {
      log.warn('TileManager already initialized');
      return;
    }

    this.setupHooks();
    this.initialized = true;
    
    log.info('TileManager initialized');
  }

  /**
   * Set up Foundry VTT hooks for tile synchronization
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    // Initial load when canvas is ready
    Hooks.on('canvasReady', () => {
      log.debug('Canvas ready, syncing all tiles');
      this.syncAllTiles();
    });

    // Create new tile
    Hooks.on('createTile', (tileDoc, options, userId) => {
      log.debug(`Tile created: ${tileDoc.id}`);
      this.createTileSprite(tileDoc);
    });

    // Update existing tile
    Hooks.on('updateTile', (tileDoc, changes, options, userId) => {
      log.debug(`Tile updated: ${tileDoc.id}`, changes);
      this.updateTileSprite(tileDoc, changes);
    });

    // Delete tile
    Hooks.on('deleteTile', (tileDoc, options, userId) => {
      log.debug(`Tile deleted: ${tileDoc.id}`);
      this.removeTileSprite(tileDoc.id);
    });

    // Refresh tile (rendering changes)
    Hooks.on('refreshTile', (tile) => {
      log.debug(`Tile refreshed: ${tile.id}`);
      this.refreshTileSprite(tile.document);
    });

    // Scene updates (foregroundElevation changes)
    Hooks.on('updateScene', (scene, changes) => {
      if (scene.id !== canvas.scene?.id) return;
      
      if ('foregroundElevation' in changes) {
        log.info('Foreground elevation changed, refreshing all tile transforms');
        for (const { sprite, tileDoc } of this.tileSprites.values()) {
          this.updateSpriteTransform(sprite, tileDoc);
        }
      }
    });

    this.hooksRegistered = true;
    log.debug('Foundry hooks registered');
  }

  /**
   * Set global visibility of all 3D tiles
   * Used when switching between Gameplay Mode (Visible) and Map Maker Mode (Hidden)
   * @param {boolean} visible 
   * @public
   */
  setVisibility(visible) {
    for (const { sprite, tileDoc } of this.tileSprites.values()) {
      if (!sprite) continue;
      
      // If turning ON, respect the tile's document hidden state
      if (visible) {
        sprite.visible = !tileDoc.hidden;
      } else {
        // If turning OFF, always hide
        sprite.visible = false;
      }
    }
  }

  /**
   * Sync all existing tiles from Foundry to THREE.js
   * Called on canvasReady
   * @public
   */
  syncAllTiles() {
    if (DISABLE_TILE_UPDATES) {
      log.warn('TileManager disabled by DISABLE_TILE_UPDATES flag (perf testing).');
      return;
    }
    if (!canvas || !canvas.scene || !canvas.scene.tiles) {
      log.warn('Canvas or scene tiles not available');
      return;
    }

    const tiles = canvas.scene.tiles;
    log.info(`Syncing ${tiles.size} tiles`);

    // Clear existing if any (though usually empty on init)
    if (this.tileSprites.size > 0) {
      this.dispose(false); // false = don't clear cache
    }

    for (const tileDoc of tiles) {
      this.createTileSprite(tileDoc);
    }
  }

  /**
   * Get all overhead tile sprites (for interaction/hover)
   * @returns {THREE.Sprite[]}
   * @public
   */
  getOverheadTileSprites() {
    const sprites = [];
    for (const { sprite } of this.tileSprites.values()) {
      if (sprite.userData.isOverhead) sprites.push(sprite);
    }
    return sprites;
  }

  /**
   * Toggle hover-based hiding for a specific tile. When un-hiding, normal
   * visibility rules (GM hidden, alpha, etc.) are re-applied.
   * @param {string} tileId
   * @param {boolean} hidden
   * @public
   */
  setTileHoverHidden(tileId, hidden) {
    const data = this.tileSprites.get(tileId);
    if (!data) return;

    data.hoverHidden = !!hidden;
  }

  /**
   * Determine if a given world-space point hits an opaque pixel of a tile
   * sprite's texture (alpha > 0.5).
   * @param {{sprite: THREE.Sprite, tileDoc: TileDocument}} data
   * @param {number} worldX
   * @param {number} worldY
   * @returns {boolean}
   * @public
   */
  isWorldPointOpaque(data, worldX, worldY) {
    const { sprite, tileDoc } = data;
    const texture = sprite.material?.map;
    const image = texture?.image;
    if (!texture || !image) return false;

    // Map world coords back to Foundry top-left space
    const sceneHeight = canvas.dimensions?.height || 10000;
    const foundryY = sceneHeight - worldY;

    const u = (worldX - tileDoc.x) / tileDoc.width;
    const v = (foundryY - tileDoc.y) / tileDoc.height;

    if (u < 0 || u > 1 || v < 0 || v > 1) return false;

    const key = texture.uuid || image.src || texture.id || tileDoc.id;

    let mask = this.alphaMaskCache.get(key);
    if (!mask) {
      try {
        const canvasEl = document.createElement('canvas');
        canvasEl.width = image.width;
        canvasEl.height = image.height;
        const ctx = canvasEl.getContext('2d');
        if (!ctx) return true; // Fallback: treat as opaque
        ctx.drawImage(image, 0, 0);
        const imgData = ctx.getImageData(0, 0, image.width, image.height);
        mask = { width: image.width, height: image.height, data: imgData.data };
        this.alphaMaskCache.set(key, mask);
      } catch (e) {
        // If we fail to build a mask, default to opaque to avoid breaking UX
        return true;
      }
    }

    const ix = Math.floor(u * (mask.width - 1));
    const iy = Math.floor(v * (mask.height - 1));
    const index = (iy * mask.width + ix) * 4;
    const alpha = mask.data[index + 3] / 255;

    return alpha > 0.5;
  }

  /**
   * Update tile states (occlusion animation)
   * @param {Object} timeInfo - Time information
   * @public
   */
  update(timeInfo) {
    if (DISABLE_TILE_UPDATES) return;
    const dt = timeInfo.delta;
    const canvasTokens = canvas.tokens?.placeables || [];
    // We care about controlled tokens or the observed token
    const sources = canvas.tokens?.controlled.length > 0 
      ? canvas.tokens.controlled 
      : (canvas.tokens?.observed || []);

    // Calculate global tile tint based on darkness
    // This matches the logic in SpecularEffect to darken elements at night
    const THREE = window.THREE;
    
    // PERFORMANCE: Reuse color objects instead of allocating every frame
    if (!this._globalTint) {
      this._globalTint = new THREE.Color(1, 1, 1);
      this._tempDaylight = new THREE.Color();
      this._tempDarkness = new THREE.Color();
      this._tempAmbient = new THREE.Color();
    }
    const globalTint = this._globalTint.set(1, 1, 1);
    
    try {
      const scene = canvas?.scene;
      const env = canvas?.environment;
      
      if (scene?.environment?.darknessLevel !== undefined) {
        let darkness = scene.environment.darknessLevel;
        const le = window.MapShine?.lightingEffect;
        if (le && typeof le.getEffectiveDarkness === 'function') {
          darkness = le.getEffectiveDarkness();
        }
        
        // PERFORMANCE: Reuse color objects, mutate in place
        const setThreeColor = (target, src, def) => {
            try {
                if (!src) { target.set(def); return target; }
                if (src instanceof THREE.Color) { target.copy(src); return target; }
                if (src.rgb) { target.setRGB(src.rgb[0], src.rgb[1], src.rgb[2]); return target; }
                if (Array.isArray(src)) { target.setRGB(src[0], src[1], src[2]); return target; }
                target.set(src); return target;
            } catch (e) { target.set(def); return target; }
        };

        const daylight = setThreeColor(this._tempDaylight, env?.colors?.ambientDaylight, 0xffffff);
        const darknessColor = setThreeColor(this._tempDarkness, env?.colors?.ambientDarkness, 0x242448);
        
        // Calculate ambient tint (mix of day/night colors) - reuse _tempAmbient
        this._tempAmbient.copy(daylight).lerp(darknessColor, darkness);
        
        // Calculate light level (brightness falloff)
        // User Request: "I think at darkness 1 you need to darken the scene by something like 0.75"
        // So minBrightness should be around 0.25 (1.0 - 0.75)
        // We clamp to ensure it doesn't go pitch black.
        const lightLevel = Math.max(1.0 - darkness, 0.25);
        
        // Final tint = ambient color * brightness
        globalTint.copy(this._tempAmbient).multiplyScalar(lightLevel);
      }
    } catch(e) {
      // Fallback to white if environment lookup fails
    }

    const tr = Math.max(0, Math.min(255, (globalTint.r * 255 + 0.5) | 0));
    const tg = Math.max(0, Math.min(255, (globalTint.g * 255 + 0.5) | 0));
    const tb = Math.max(0, Math.min(255, (globalTint.b * 255 + 0.5) | 0));
    const tintKey = (tr << 16) | (tg << 8) | tb;

    if (this._tintDirty || tintKey !== this._lastTintKey) {
      this._lastTintKey = tintKey;
      this._tintDirty = false;

      for (const data of this.tileSprites.values()) {
        const { sprite } = data;
        if (!sprite.userData.isOverhead && sprite.material) {
          sprite.material.color.copy(globalTint);
        }
      }
    }

    let anyHoverHidden = false;

    // Store global tint for window light application (avoid per-tile cloning)
    this._frameGlobalTint = globalTint;

    for (const tileId of this._overheadTileIds) {
      const data = this.tileSprites.get(tileId);
      if (!data) continue;

      const { sprite, tileDoc, hoverHidden } = data;
      if (sprite.material) {
        // Overhead tiles should respect the same outdoors brightness/dim response
        // as the main LightingEffect composite (otherwise outdoor roofs stay too
        // bright as darkness increases).
        let overheadTint = globalTint;
        try {
          const le = window.MapShine?.lightingEffect;
          if (le && le.params && typeof le.params.outdoorBrightness === 'number' && weatherController && typeof weatherController.getRoofMaskIntensity === 'function') {
            const d = canvas.dimensions;
            const sceneX = d?.sceneRect?.x ?? d?.sceneX ?? 0;
            const sceneY = d?.sceneRect?.y ?? d?.sceneY ?? 0;
            const sceneW = d?.sceneRect?.width ?? d?.sceneWidth ?? d?.width ?? 10000;
            const sceneH = d?.sceneRect?.height ?? d?.sceneHeight ?? d?.height ?? 10000;

            // Tile docs are in Foundry top-left (Y-down) space.
            // The authored _Outdoors mask is also in sceneRect top-left UV space.
            const tileCenterX = tileDoc.x + tileDoc.width / 2;
            const tileCenterY = tileDoc.y + tileDoc.height / 2;
            const u = (tileCenterX - sceneX) / sceneW;
            const v = (tileCenterY - sceneY) / sceneH;

            const outdoorStrength = weatherController.getRoofMaskIntensity(u, v);
            if (outdoorStrength > 0.001) {
              let darkness = canvas?.scene?.environment?.darknessLevel ?? 0.0;
              if (typeof le.getEffectiveDarkness === 'function') {
                darkness = le.getEffectiveDarkness();
              }

              const dayBoost = le.params.outdoorBrightness;
              const nightDim = 2.0 - le.params.outdoorBrightness;
              const outdoorMultiplier = (1.0 - darkness) * dayBoost + darkness * nightDim;
              const finalMultiplier = (1.0 - outdoorStrength) * 1.0 + outdoorStrength * outdoorMultiplier;

              // PERFORMANCE: reuse cached THREE.Color (avoid per-tile allocations)
              if (!this._tempOverheadTint) {
                this._tempOverheadTint = new THREE.Color(1, 1, 1);
              }
              overheadTint = this._tempOverheadTint.copy(globalTint).multiplyScalar(finalMultiplier);
            }
          }
        } catch (_) {
        }

        sprite.material.color.copy(overheadTint);
      }

      // Handle Occlusion
      // Default: use configured alpha
      let targetAlpha = tileDoc.alpha ?? 1;
      
      const occlusion = tileDoc.occlusion || {};
      const mode = occlusion.mode || CONST.TILE_OCCLUSION_MODES.NONE;

      if (mode !== CONST.TILE_OCCLUSION_MODES.NONE) {
        let occluded = false;

        // Check if any relevant token is under this tile
        // Simple bounds check for now (Foundry uses more complex pixel-perfect alpha checks usually)
        // We'll use the tile's rectangle (ignoring rotation for simple check, or proper check if needed)
        
        // TODO: Improve this to use proper SAT or pixel check for rotated tiles
        // For now, simple bounding box of the sprite
        
        // Get tile bounds in world space
        const left = tileDoc.x;
        const right = tileDoc.x + tileDoc.width;
        const top = tileDoc.y;
        const bottom = tileDoc.y + tileDoc.height;

        for (const token of sources) {
          // Token center
          const tx = token.document.x + token.document.width / 2 * (canvas.dimensions.size || 100); // Wait, width/height are grid units?
          // token.document.width is in grid units. token.w is pixels.
          const txPx = token.x + token.w / 2;
          const tyPx = token.y + token.h / 2;

          if (txPx >= left && txPx <= right && tyPx >= top && tyPx <= bottom) {
             occluded = true;
             break;
          }
        }

        if (occluded) {
          targetAlpha = occlusion.alpha ?? 0;
        }
      }

      // Apply hover-hide (fade to zero alpha when hovered)
      if (hoverHidden) {
        targetAlpha = 0;
        anyHoverHidden = true;
      }
      
      // Smoothly interpolate alpha
      // Use a ~2 second time constant for hover/occlusion fades
      const currentAlpha = sprite.material.opacity;
      const diff = targetAlpha - currentAlpha;
      const absDiff = Math.abs(diff);

      if (absDiff > 0.0005) {
        // Move opacity toward target at a fixed rate of 0.5 per second,
        // so a full 0->1 transition takes about 2 seconds regardless of
        // frame rate.
        const maxStep = dt / 2; // 0.5 units per second
        const step = Math.sign(diff) * Math.min(absDiff, maxStep);
        sprite.material.opacity = currentAlpha + step;
      } else {
        // Close enough: snap to target to avoid tiny tails.
        sprite.material.opacity = targetAlpha;
      }
    }

    // Tell WeatherController whether any roof is currently being hover-hidden,
    // so that precipitation effects can decide when to apply the _Outdoors mask.
    if (weatherController && typeof weatherController.setRoofMaskActive === 'function') {
      weatherController.setRoofMaskActive(anyHoverHidden);
    }

    // Apply window light to overhead tiles if enabled
    this._applyWindowLightToOverheadTiles();
  }

  /**
   * Apply window light brightness to overhead tiles.
   * Samples the WindowLightEffect's light texture and adds brightness to tiles
   * that are positioned over lit window areas.
   * @private
   */
  _applyWindowLightToOverheadTiles() {
    const wle = this.windowLightEffect;
    if (!wle) {
      return;
    }
    if (!wle.params.lightOverheadTiles) {
      return;
    }
    // Allow the effect to work even without a window mask if intensity > 0.9 (debug mode)
    if (!wle.params.hasWindowMask && wle.params.overheadLightIntensity <= 0.9) {
      return;
    }
    if (!wle._enabled) return;

    const THREE = window.THREE;
    if (!THREE) return;

    // Get scene dimensions for UV calculation (sceneRect, not padded canvas)
    const d = canvas.dimensions;
    const sceneX = d?.sceneRect?.x ?? d?.sceneX ?? 0;
    const sceneY = d?.sceneRect?.y ?? d?.sceneY ?? 0;
    const sceneW = d?.sceneRect?.width ?? d?.sceneWidth ?? d?.width ?? 10000;
    const sceneH = d?.sceneRect?.height ?? d?.sceneHeight ?? d?.height ?? 10000;

    // Count overhead tiles for debugging
    let overheadCount = 0;
    let litCount = 0;

    // For each overhead tile, calculate the average window light in its area
    // and apply as an additive tint on top of the global darkness tint
    for (const tileId of this._overheadTileIds) {
      const data = this.tileSprites.get(tileId);
      if (!data) continue;

      const { sprite, tileDoc } = data;
      overheadCount++;

      // Use the tile's CURRENT color as base (it already includes global tint + outdoors/night dim).
      const baseColor = sprite?.material?.color;
      if (!baseColor) continue;

      // Calculate tile center UV in scene space
      const tileCenterX = tileDoc.x + tileDoc.width / 2;
      const tileCenterY = tileDoc.y + tileDoc.height / 2;
      const u = (tileCenterX - sceneX) / sceneW;
      const v = (tileCenterY - sceneY) / sceneH;

      // Sample the window light at the tile's position
      const lightSample = this._sampleWindowLight(null, u, v);

      if (lightSample && lightSample.brightness > 0.01) {
        litCount++;
        // Apply additive brightness to the tile on top of global tint
        const overheadIntensity = Math.max(0.0, Math.min(1.0, wle.params.overheadLightIntensity ?? 0.0));
        const intensity = lightSample.brightness * overheadIntensity;

        // Copy the base so we don't accumulate repeatedly across frames.
        if (!this._tempWindowOverheadBase) {
          this._tempWindowOverheadBase = new THREE.Color(1, 1, 1);
        }
        this._tempWindowOverheadBase.copy(baseColor);
        
        // Additive blend: globalTint + (lightColor * intensity)
        sprite.material.color.r = Math.min(1.5, this._tempWindowOverheadBase.r + lightSample.r * intensity);
        sprite.material.color.g = Math.min(1.5, this._tempWindowOverheadBase.g + lightSample.g * intensity);
        sprite.material.color.b = Math.min(1.5, this._tempWindowOverheadBase.b + lightSample.b * intensity);
      } else if (!wle.params.hasWindowMask && wle.params.overheadLightIntensity > 0.9) {
        // Debug mode: when intensity is maxed, tint all overhead tiles slightly to verify the system works
        sprite.material.color.r = Math.min(1.5, baseColor.r + 0.3);
        sprite.material.color.g = Math.min(1.5, baseColor.g + 0.1);
        sprite.material.color.b = Math.min(1.5, baseColor.b + 0.0);
      }
      // If no window light, the global tint is already applied - no action needed
    }

    // Debug log once every 5 seconds
    if (!this._lastWindowLightLog || Date.now() - this._lastWindowLightLog > 5000) {
      this._lastWindowLightLog = Date.now();
      const maskDataReady = !!this._windowMaskData;
      const extractFailed = !!this._windowMaskExtractFailed;
      log.debug(`Window light overhead: ${overheadCount} overhead tiles, ${litCount} lit, maskData=${maskDataReady}, extractFailed=${extractFailed}, intensity=${wle.params.overheadLightIntensity}`);
    }
  }

  /**
   * Extract mask pixel data from a THREE.Texture for CPU sampling.
   * @param {THREE.Texture} texture
   * @returns {{data: Uint8ClampedArray, width: number, height: number}|null}
   * @private
   */
  _extractMaskData(texture) {
    if (!texture) {
      log.debug('_extractMaskData: texture is null');
      return null;
    }
    if (!texture.image) {
      log.debug('_extractMaskData: texture.image is null');
      return null;
    }
    
    const image = texture.image;
    
    // Check if it's an HTMLImageElement or similar drawable
    // Also accept VideoFrame and OffscreenCanvas which are valid sources
    const isDrawable = (
      image instanceof HTMLImageElement || 
      image instanceof HTMLCanvasElement || 
      image instanceof ImageBitmap ||
      (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) ||
      (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame)
    );
    
    if (!isDrawable) {
      log.warn('Window mask image is not a drawable type:', typeof image, image?.constructor?.name);
      return null;
    }

    try {
      const canvas = document.createElement('canvas');
      const w = image.width || image.naturalWidth || 256;
      const h = image.height || image.naturalHeight || 256;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        log.warn('_extractMaskData: failed to get 2d context');
        return null;
      }
      
      ctx.drawImage(image, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      log.debug(`_extractMaskData: successfully extracted ${w}x${h} pixels`);
      return { data: imageData.data, width: w, height: h };
    } catch (e) {
      log.warn('Failed to extract mask data:', e.message);
      return null;
    }
  }

  /**
   * Sample the window light texture at a given UV coordinate.
   * Returns the light color and brightness at that point.
   * @param {THREE.Texture} texture - unused, kept for API compatibility
   * @param {number} u - U coordinate (0-1)
   * @param {number} v - V coordinate (0-1)
   * @returns {{r: number, g: number, b: number, brightness: number}|null}
   * @private
   */
  _sampleWindowLight(texture, u, v) {
    const wle = this.windowLightEffect;
    if (!wle || !wle.windowMask) {
      return null;
    }

    // Lazy-extract window mask data
    if (!this._windowMaskData && !this._windowMaskExtractFailed) {
      const extracted = this._extractMaskData(wle.windowMask);
      if (extracted) {
        this._windowMaskData = extracted.data;
        this._windowMaskWidth = extracted.width;
        this._windowMaskHeight = extracted.height;
        log.info(`Window mask data extracted: ${extracted.width}x${extracted.height}`);
      } else {
        this._windowMaskExtractFailed = true;
        log.warn('Failed to extract window mask data for overhead tile lighting');
      }
    }

    if (!this._windowMaskData) return null;

    // Sample the mask at the UV coordinate
    const ix = Math.floor(Math.max(0, Math.min(1, u)) * (this._windowMaskWidth - 1));
    const iy = Math.floor(Math.max(0, Math.min(1, v)) * (this._windowMaskHeight - 1));
    const index = (iy * this._windowMaskWidth + ix) * 4;

    const r = this._windowMaskData[index] / 255;
    const g = this._windowMaskData[index + 1] / 255;
    const b = this._windowMaskData[index + 2] / 255;
    const brightness = (r * 0.2126 + g * 0.7152 + b * 0.0722);

    // Apply the same mask shaping as the shader
    const threshold = wle.params.maskThreshold;
    const softness = wle.params.softness;
    const halfWidth = Math.max(softness, 0.001);
    const edgeLo = Math.max(0, threshold - halfWidth);
    const edgeHi = Math.min(1, threshold + halfWidth);
    
    // Smoothstep
    let shaped = 0;
    if (brightness <= edgeLo) {
      shaped = 0;
    } else if (brightness >= edgeHi) {
      shaped = 1;
    } else {
      const t = (brightness - edgeLo) / (edgeHi - edgeLo);
      shaped = t * t * (3 - 2 * t);
    }

    // Check outdoors mask if available (skip outdoor areas)
    let indoorFactor = 1.0;
    if (wle.outdoorsMask) {
      // Lazy-extract outdoors mask data
      if (!this._outdoorsMaskData && !this._outdoorsMaskExtractFailed) {
        const extracted = this._extractMaskData(wle.outdoorsMask);
        if (extracted) {
          this._outdoorsMaskData = extracted.data;
          this._outdoorsMaskWidth = extracted.width;
          this._outdoorsMaskHeight = extracted.height;
        } else {
          this._outdoorsMaskExtractFailed = true;
        }
      }
      
      if (this._outdoorsMaskData) {
        const oix = Math.floor(Math.max(0, Math.min(1, u)) * (this._outdoorsMaskWidth - 1));
        const oiy = Math.floor(Math.max(0, Math.min(1, v)) * (this._outdoorsMaskHeight - 1));
        const oIndex = (oiy * this._outdoorsMaskWidth + oix) * 4;
        const outdoorStrength = this._outdoorsMaskData[oIndex] / 255;
        indoorFactor = 1.0 - outdoorStrength;
      }
    }

    const finalBrightness = shaped * indoorFactor * wle.params.intensity;

    // Return the light color (from params) scaled by brightness
    const color = wle.params.color;
    return {
      r: color.r,
      g: color.g,
      b: color.b,
      brightness: Math.min(1, finalBrightness)
    };
  }

  /**
   * Create a THREE.js sprite for a Foundry tile
   * @param {TileDocument} tileDoc - Foundry tile document
   * @private
   */
  createTileSprite(tileDoc) {
    // Skip if already exists
    if (this.tileSprites.has(tileDoc.id)) {
      log.warn(`Tile sprite already exists: ${tileDoc.id}`);
      return;
    }

    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE.js not available');
      return;
    }

    // Load tile texture
    const texturePath = tileDoc.texture?.src;
    if (!texturePath) {
      log.warn(`Tile ${tileDoc.id} has no texture`);
      return;
    }

    // Create sprite with material
    const material = new THREE.SpriteMaterial({
      transparent: true,
      alphaTest: 0.1,
      depthTest: true,
      depthWrite: true,
      side: THREE.DoubleSide
    });

    const sprite = new THREE.Sprite(material);
    sprite.name = `Tile_${tileDoc.id}`;
    sprite.matrixAutoUpdate = false;
    
    // Store Foundry data
    sprite.userData.foundryTileId = tileDoc.id;
    sprite.userData.tileDoc = tileDoc;

    // Load texture
    this.loadTileTexture(texturePath).then(texture => {
      material.map = texture;
      material.needsUpdate = true;
    }).catch(error => {
      log.error(`Failed to load tile texture: ${texturePath}`, error);
    });

    // Set initial transform and visibility
    this.updateSpriteTransform(sprite, tileDoc);
    this.updateSpriteVisibility(sprite, tileDoc);
    
    this.scene.add(sprite);

    this.tileSprites.set(tileDoc.id, {
      sprite,
      tileDoc
    });

    if (sprite.userData.isOverhead) {
      this._overheadTileIds.add(tileDoc.id);
    } else {
      this._overheadTileIds.delete(tileDoc.id);
    }

    if (sprite.userData.isWeatherRoof) {
      this._weatherRoofTileIds.add(tileDoc.id);
    } else {
      this._weatherRoofTileIds.delete(tileDoc.id);
    }

    this._tintDirty = true;

    log.debug(`Created tile sprite: ${tileDoc.id}`);
  }

  /**
   * Update an existing tile sprite
   * @param {TileDocument} tileDoc - Updated tile document
   * @param {object} changes - Changed properties
   * @private
   */
  updateTileSprite(tileDoc, changes) {
    const spriteData = this.tileSprites.get(tileDoc.id);
    if (!spriteData) {
      // If not found, create it
      this.createTileSprite(tileDoc);
      return;
    }

    const { sprite } = spriteData;

    // Update transform if relevant properties changed
    if ('x' in changes || 'y' in changes || 'width' in changes ||
        'height' in changes || 'rotation' in changes ||
        'elevation' in changes || 'z' in changes ||
        'flags' in changes) {
      this.updateSpriteTransform(sprite, tileDoc);
    }

    // Update texture if changed
    if ('texture' in changes && changes.texture?.src) {
      this.loadTileTexture(changes.texture.src).then(texture => {
        sprite.material.map = texture;
        sprite.material.needsUpdate = true;
      }).catch(error => {
        log.error(`Failed to load updated tile texture`, error);
      });
    }

    // Update visibility
    if ('hidden' in changes || 'alpha' in changes) {
      this.updateSpriteVisibility(sprite, tileDoc);
    }

    // Update stored reference
    spriteData.tileDoc = tileDoc;
  }

  /**
   * Refresh tile sprite (visual state changed)
   * @param {TileDocument} tileDoc - Tile document
   * @private
   */
  refreshTileSprite(tileDoc) {
    const spriteData = this.tileSprites.get(tileDoc.id);
    if (!spriteData) return;
    
    this.updateSpriteVisibility(spriteData.sprite, tileDoc);
  }

  /**
   * Remove a tile sprite
   * @param {string} tileId - Tile document ID
   * @private
   */
  removeTileSprite(tileId) {
    const spriteData = this.tileSprites.get(tileId);
    if (!spriteData) return;

    const { sprite } = spriteData;

    this.scene.remove(sprite);
    
    if (sprite.material) {
      sprite.material.dispose();
    }
    
    this.tileSprites.delete(tileId);
    this._overheadTileIds.delete(tileId);
    this._weatherRoofTileIds.delete(tileId);
    this._tintDirty = true;
    log.debug(`Removed tile sprite: ${tileId}`);

    try {
      window.MapShine?.cloudEffect?.requestBlockerUpdate?.(2);
    } catch (_) {
    }
  }

  /**
   * Update sprite transform (position, scale, rotation, z-index)
   * @param {THREE.Sprite} sprite - THREE.js sprite
   * @param {TileDocument} tileDoc - Foundry tile document
   * @private
   */
  updateSpriteTransform(sprite, tileDoc) {
    const THREE = window.THREE;

    const bypassFlag = tileDoc?.getFlag?.('map-shine-advanced', 'bypassEffects')
      ?? tileDoc?.flags?.['map-shine-advanced']?.bypassEffects;
    const bypassEffects = !!bypassFlag;
    const wasBypass = !!sprite.userData.bypassEffects;
    sprite.userData.bypassEffects = bypassEffects;

    // If bypass is enabled, render ONLY on the overlay layer so the tile is excluded
    // from the main scene render (and therefore from post-processing).
    // Note: this also excludes the tile from roof/water layer passes.
    if (bypassEffects) {
      sprite.layers.set(OVERLAY_THREE_LAYER);
      sprite.renderOrder = 1000;
    } else if (wasBypass) {
      // Reset to default layer when leaving bypass mode.
      sprite.layers.set(0);
      sprite.renderOrder = 0;
    }

    const cloudShadowsFlag = tileDoc?.getFlag?.('map-shine-advanced', 'cloudShadowsEnabled')
      ?? tileDoc?.flags?.['map-shine-advanced']?.cloudShadowsEnabled;
    const cloudTopsFlag = tileDoc?.getFlag?.('map-shine-advanced', 'cloudTopsEnabled')
      ?? tileDoc?.flags?.['map-shine-advanced']?.cloudTopsEnabled;
    const cloudShadowsEnabled = (cloudShadowsFlag === undefined) ? true : !!cloudShadowsFlag;
    const cloudTopsEnabled = (cloudTopsFlag === undefined) ? true : !!cloudTopsFlag;

    // 1. Determine Z-Layer
    // Logic: 
    // - Overhead if elevation >= foregroundElevation
    // - Otherwise, check Sort (Z) index from Foundry
    //   - z < 0 ? Background
    //   - z >= 0 ? Foreground
    
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    let zBase = groundZ + Z_FOREGROUND_OFFSET;

    const foregroundElevation = canvas.scene.foregroundElevation || 0;
    const isOverhead = tileDoc.elevation >= foregroundElevation;
    const wasOverhead = !!sprite.userData.isOverhead;

    // Store overhead status for update loop
    sprite.userData.isOverhead = isOverhead;
    if (wasOverhead !== isOverhead) {
      this._tintDirty = true;
      const tileId = tileDoc?.id;
      if (tileId) {
        if (isOverhead) this._overheadTileIds.add(tileId);
        else this._overheadTileIds.delete(tileId);
      }
    }

    const flag = tileDoc?.getFlag?.('map-shine-advanced', 'overheadIsRoof') ?? tileDoc?.flags?.['map-shine-advanced']?.overheadIsRoof;
    const isWeatherRoof = isOverhead && !!flag;
    const wasWeatherRoof = !!sprite.userData.isWeatherRoof;
    sprite.userData.isWeatherRoof = isWeatherRoof;

    if (wasWeatherRoof !== isWeatherRoof) {
      const tileId = tileDoc?.id;
      if (tileId) {
        if (isWeatherRoof) this._weatherRoofTileIds.add(tileId);
        else this._weatherRoofTileIds.delete(tileId);
      }
    }

    if (!bypassEffects) {
      if (isOverhead) sprite.layers.enable(ROOF_LAYER);
      else sprite.layers.disable(ROOF_LAYER);
      if (isWeatherRoof) sprite.layers.enable(WEATHER_ROOF_LAYER);
      else sprite.layers.disable(WEATHER_ROOF_LAYER);

      if (!cloudShadowsEnabled) sprite.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      else sprite.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      if (!cloudTopsEnabled) sprite.layers.enable(TILE_FEATURE_LAYERS.CLOUD_TOP_BLOCKER);
      else sprite.layers.disable(TILE_FEATURE_LAYERS.CLOUD_TOP_BLOCKER);
    }

    const occludesWaterFlag = tileDoc?.getFlag?.('map-shine-advanced', 'occludesWater')
      ?? tileDoc?.flags?.['map-shine-advanced']?.occludesWater;
    // Water occlusion is opt-in. Defaulting this to true for ground tiles makes the
    // water occluder render target fully opaque (most base tiles are opaque), which
    // suppresses water everywhere.
    const occludesWater = (occludesWaterFlag === undefined) ? false : !!occludesWaterFlag;
    sprite.userData.occludesWater = occludesWater;
    if (!bypassEffects) {
      if (occludesWater) sprite.layers.enable(WATER_OCCLUDER_LAYER);
      else sprite.layers.disable(WATER_OCCLUDER_LAYER);
    }

    try {
      window.MapShine?.cloudEffect?.requestBlockerUpdate?.(2);
    } catch (_) {
    }

    if (isOverhead) {
      zBase = groundZ + Z_OVERHEAD_OFFSET;
      // Overhead tiles should not dominate the depth buffer so that
      // weather and other environmental effects can render visibly above
      // them. Keep depth testing so roofs still occlude underlying
      // geometry, but avoid writing new depth values and give them a
      // modest renderOrder below the particle systems.
      if (sprite.material) {
        sprite.material.depthWrite = false;
        sprite.material.needsUpdate = true;
      }
      sprite.renderOrder = 10;
    } else {
      // Foundry 'z' property (sort key) determines background/foreground for non-overhead tiles
      // Note: Foundry uses 'sort' or 'z' depending on version, tileDoc.z is common access
      const sortKey = tileDoc.sort ?? tileDoc.z ?? 0;
      if (sortKey < 0) {
        zBase = groundZ + Z_BACKGROUND_OFFSET;
      } else {
        zBase = groundZ + Z_FOREGROUND_OFFSET;
      }

      // If the sprite was previously overhead, restore depth writing.
      if (sprite.material && sprite.material.depthWrite === false) {
        sprite.material.depthWrite = true;
        sprite.material.needsUpdate = true;
      }
      sprite.renderOrder = 0;
    }
    
    // Add small offset based on sort key to prevent z-fighting within same layer
    // Normalize sort key to small range (e.g., 0.0001 steps)
    const sortOffset = (tileDoc.sort || 0) * 0.00001;
    const zPosition = zBase + sortOffset;

    // 2. Position & Scale (Foundry Top-Left -> THREE Center)
    
    // Token dimensions are straight forward, but Tiles can have scaleX/scaleY in texture
    // Foundry tile width/height are the "Display Dimensions"
    
    const width = tileDoc.width;
    const height = tileDoc.height;
    
    // Center of tile in Foundry coords
    const centerX = tileDoc.x + width / 2;
    const centerY = tileDoc.y + height / 2; // Foundry Y (0 at top)
    
    // Convert to THREE World Coords (Y inverted)
    const sceneHeight = canvas.dimensions?.height || 10000;
    const worldY = sceneHeight - centerY;
    
    sprite.position.set(centerX, worldY, zPosition);
    sprite.scale.set(width, height, 1);
    sprite.updateMatrix();
    
    // 3. Rotation
    if (tileDoc.rotation) {
      sprite.material.rotation = THREE.MathUtils.degToRad(tileDoc.rotation);
    }
  }

  /**
   * Update sprite visibility and opacity
   * @param {THREE.Sprite} sprite 
   * @param {TileDocument} tileDoc 
   */
  updateSpriteVisibility(sprite, tileDoc) {
    // Hidden check
    const isHidden = tileDoc.hidden;
    const isGM = game.user?.isGM;
    
    if (isHidden && !isGM) {
      sprite.visible = false;
    } else {
      sprite.visible = true;
    }

    // Opacity (Alpha)
    // If GM and tile is hidden, show at reduced opacity
    if (isHidden && isGM) {
      sprite.visible = true;
      sprite.material.opacity = 0.5;
    } else {
      sprite.visible = !isHidden;
      sprite.material.opacity = tileDoc.alpha ?? 1;
    }

    try {
      window.MapShine?.cloudEffect?.requestBlockerUpdate?.(2);
    } catch (_) {
    }
  }

  /**
   * Load texture with caching
   * @param {string} texturePath 
   * @returns {Promise<THREE.Texture>}
   */
  async loadTileTexture(texturePath) {
    if (this.textureCache.has(texturePath)) {
      return this.textureCache.get(texturePath);
    }

    return new Promise((resolve, reject) => {
      this.textureLoader.load(
        texturePath,
        (texture) => {
          const THREE = window.THREE;
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          this.textureCache.set(texturePath, texture);
          resolve(texture);
        },
        undefined,
        reject
      );
    });
  }

  /**
   * Dispose all resources
   * @param {boolean} [clearCache=true] - Whether to clear texture cache
   * @public
   */
  dispose(clearCache = true) {
    log.info(`Disposing TileManager with ${this.tileSprites.size} tiles`);

    for (const { sprite } of this.tileSprites.values()) {
      this.scene.remove(sprite);
      sprite.material?.dispose();
    }
    this.tileSprites.clear();
    this._overheadTileIds.clear();
    this._weatherRoofTileIds.clear();

    if (clearCache) {
      for (const texture of this.textureCache.values()) {
        texture.dispose();
      }
      this.textureCache.clear();
      this.initialized = false;
    }
  }
}
