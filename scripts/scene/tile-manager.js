/**
 * @fileoverview Tile manager - syncs Foundry tiles to THREE.js sprites
 * Handles creation, updates, and deletion of tile sprites in the THREE.js scene
 * Support for Background, Foreground, and Overhead tile layers
 * @module scene/tile-manager
 */

import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('TileManager');

// Z-layer constants from Architecture
const Z_BACKGROUND = 1.0;
const Z_FOREGROUND = 5.0;
const Z_OVERHEAD = 20.0;

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
    
    this.initialized = false;
    this.hooksRegistered = false;
    
    log.debug('TileManager created');
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
   * Sync all existing tiles from Foundry to THREE.js
   * Called on canvasReady
   * @public
   */
  syncAllTiles() {
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
    const dt = timeInfo.delta;
    const canvasTokens = canvas.tokens?.placeables || [];
    // We care about controlled tokens or the observed token
    const sources = canvas.tokens?.controlled.length > 0 
      ? canvas.tokens.controlled 
      : (canvas.tokens?.observed || []);

    let anyHoverHidden = false;

    for (const data of this.tileSprites.values()) {
      const { sprite, tileDoc, hoverHidden } = data;
      // Only process overhead tiles for occlusion
      if (!sprite.userData.isOverhead) continue;

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
        'elevation' in changes || 'z' in changes) {
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
    log.debug(`Removed tile sprite: ${tileId}`);
  }

  /**
   * Update sprite transform (position, scale, rotation, z-index)
   * @param {THREE.Sprite} sprite - THREE.js sprite
   * @param {TileDocument} tileDoc - Foundry tile document
   * @private
   */
  updateSpriteTransform(sprite, tileDoc) {
    const THREE = window.THREE;

    // 1. Determine Z-Layer
    // Logic: 
    // - Overhead if elevation >= foregroundElevation
    // - Otherwise, check Sort (Z) index from Foundry
    //   - z < 0 ? Background
    //   - z >= 0 ? Foreground
    
    const foregroundElevation = canvas.scene.foregroundElevation || 0;
    const isOverhead = tileDoc.elevation >= foregroundElevation;
    
    // Store overhead status for update loop
    sprite.userData.isOverhead = isOverhead;
    
    let zBase = Z_FOREGROUND;
    
    if (isOverhead) {
      zBase = Z_OVERHEAD;
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
        zBase = Z_BACKGROUND;
      } else {
        zBase = Z_FOREGROUND;
      }
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
    // Hidden tiles are semi-transparent for GM
    if (isHidden && isGM) {
      sprite.material.opacity = 0.5;
    } else {
      sprite.material.opacity = tileDoc.alpha ?? 1;
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

    if (clearCache) {
      for (const texture of this.textureCache.values()) {
        texture.dispose();
      }
      this.textureCache.clear();
      this.initialized = false;
    }
  }
}
