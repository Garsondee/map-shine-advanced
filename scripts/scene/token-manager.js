/**
 * @fileoverview Token manager - syncs Foundry tokens to THREE.js sprites
 * Handles creation, updates, and deletion of token sprites in the THREE.js scene
 * @module scene/token-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('TokenManager');

/**
 * Z-position base for tokens (from architecture)
 * Tokens render at this z-position + elevation
 */
const TOKEN_BASE_Z = 10.0;

/**
 * TokenManager - Synchronizes Foundry VTT tokens to THREE.js sprites
 * Uses Foundry hooks for reactive updates instead of polling
 */
export class TokenManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene to add token sprites to
   */
  constructor(scene) {
    this.scene = scene;
    
    /** @type {Map<string, TokenSpriteData>} */
    this.tokenSprites = new Map();
    
    /** @type {THREE.TextureLoader} */
    this.textureLoader = new THREE.TextureLoader();
    
    /** @type {Map<string, THREE.Texture>} */
    this.textureCache = new Map();
    
    this.initialized = false;
    this.hooksRegistered = false;
    
    log.debug('TokenManager created');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) {
      log.warn('TokenManager already initialized');
      return;
    }

    this.setupHooks();
    this.initialized = true;
    
    log.info('TokenManager initialized');
  }

  /**
   * Set up Foundry VTT hooks for token synchronization
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    // Initial load when canvas is ready
    Hooks.on('canvasReady', () => {
      log.debug('Canvas ready, syncing all tokens');
      this.syncAllTokens();
    });

    // Create new token
    Hooks.on('createToken', (tokenDoc, options, userId) => {
      log.debug(`Token created: ${tokenDoc.id}`);
      this.createTokenSprite(tokenDoc);
    });

    // Update existing token
    Hooks.on('updateToken', (tokenDoc, changes, options, userId) => {
      log.debug(`Token updated: ${tokenDoc.id}`, changes);
      this.updateTokenSprite(tokenDoc, changes);
    });

    // Delete token
    Hooks.on('deleteToken', (tokenDoc, options, userId) => {
      log.debug(`Token deleted: ${tokenDoc.id}`);
      this.removeTokenSprite(tokenDoc.id);
    });

    // Refresh token (rendering changes)
    Hooks.on('refreshToken', (token) => {
      log.debug(`Token refreshed: ${token.id}`);
      // Refresh typically means visual state changed (visibility, effects, etc.)
      this.refreshTokenSprite(token.document);
    });

    this.hooksRegistered = true;
    log.debug('Foundry hooks registered');
  }

  /**
   * Sync all existing tokens from Foundry to THREE.js
   * Called on canvasReady
   * @private
   */
  syncAllTokens() {
    if (!canvas || !canvas.tokens) {
      log.warn('Canvas or tokens layer not available');
      return;
    }

    const tokens = canvas.tokens.placeables || [];
    log.info(`Syncing ${tokens.length} tokens`);

    for (const token of tokens) {
      this.createTokenSprite(token.document);
    }
  }

  /**
   * Create a THREE.js sprite for a Foundry token
   * @param {TokenDocument} tokenDoc - Foundry token document
   * @private
   */
  createTokenSprite(tokenDoc) {
    // Skip if already exists
    if (this.tokenSprites.has(tokenDoc.id)) {
      log.warn(`Token sprite already exists: ${tokenDoc.id}`);
      return;
    }

    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE.js not available');
      return;
    }

    // Load token texture
    const texturePath = tokenDoc.texture?.src;
    if (!texturePath) {
      log.warn(`Token ${tokenDoc.id} has no texture`);
      return;
    }

    // Create sprite with material
    const material = new THREE.SpriteMaterial({
      transparent: true,
      alphaTest: 0.1, // Discard fully transparent pixels
      depthTest: true,
      depthWrite: true
    });

    const sprite = new THREE.Sprite(material);
    sprite.name = `Token_${tokenDoc.id}`;
    
    // Store Foundry data in userData
    sprite.userData.foundryTokenId = tokenDoc.id;
    sprite.userData.tokenDoc = tokenDoc;

    // Load texture (async, will update material when loaded)
    this.loadTokenTexture(texturePath).then(texture => {
      material.map = texture;
      material.needsUpdate = true;
    }).catch(error => {
      log.error(`Failed to load token texture: ${texturePath}`, error);
    });

    // Set initial position, scale, visibility
    this.updateSpriteTransform(sprite, tokenDoc);
    this.updateSpriteVisibility(sprite, tokenDoc);

    // Add to scene
    this.scene.add(sprite);

    // Store reference
    this.tokenSprites.set(tokenDoc.id, {
      sprite,
      tokenDoc,
      lastUpdate: Date.now()
    });

    log.debug(`Created token sprite: ${tokenDoc.id} at (${tokenDoc.x}, ${tokenDoc.y}, z=${sprite.position.z})`);
  }

  /**
   * Update an existing token sprite
   * @param {TokenDocument} tokenDoc - Updated token document
   * @param {object} changes - Changed properties
   * @private
   */
  updateTokenSprite(tokenDoc, changes) {
    const spriteData = this.tokenSprites.get(tokenDoc.id);
    if (!spriteData) {
      // Token doesn't exist yet, create it
      log.warn(`Token sprite not found for update: ${tokenDoc.id}, creating`);
      this.createTokenSprite(tokenDoc);
      return;
    }

    const { sprite } = spriteData;

    // Update transform if position/size/elevation changed
    if ('x' in changes || 'y' in changes || 'width' in changes || 
        'height' in changes || 'elevation' in changes || 'rotation' in changes) {
      this.updateSpriteTransform(sprite, tokenDoc);
    }

    // Update texture if changed
    if ('texture' in changes && changes.texture?.src) {
      this.loadTokenTexture(changes.texture.src).then(texture => {
        sprite.material.map = texture;
        sprite.material.needsUpdate = true;
      }).catch(error => {
        log.error(`Failed to load updated token texture`, error);
      });
    }

    // Update visibility if hidden state changed
    if ('hidden' in changes) {
      this.updateSpriteVisibility(sprite, tokenDoc);
    }

    // Update stored reference
    spriteData.tokenDoc = tokenDoc;
    spriteData.lastUpdate = Date.now();

    log.debug(`Updated token sprite: ${tokenDoc.id}`);
  }

  /**
   * Refresh token sprite (visual state changed)
   * @param {TokenDocument} tokenDoc - Token document
   * @private
   */
  refreshTokenSprite(tokenDoc) {
    const spriteData = this.tokenSprites.get(tokenDoc.id);
    if (!spriteData) return;

    const { sprite } = spriteData;
    
    // Update visibility based on current state
    this.updateSpriteVisibility(sprite, tokenDoc);
  }

  /**
   * Remove a token sprite
   * @param {string} tokenId - Token document ID
   * @private
   */
  removeTokenSprite(tokenId) {
    const spriteData = this.tokenSprites.get(tokenId);
    if (!spriteData) {
      log.warn(`Token sprite not found for removal: ${tokenId}`);
      return;
    }

    const { sprite } = spriteData;

    // Remove from scene
    this.scene.remove(sprite);

    // Dispose material and geometry
    if (sprite.material) {
      if (sprite.material.map) {
        // Don't dispose texture if it's cached for reuse
        // sprite.material.map.dispose();
      }
      sprite.material.dispose();
    }
    sprite.geometry?.dispose();

    // Remove from map
    this.tokenSprites.delete(tokenId);

    log.debug(`Removed token sprite: ${tokenId}`);
  }

  /**
   * Update sprite transform (position, scale, rotation)
   * @param {THREE.Sprite} sprite - THREE.js sprite
   * @param {TokenDocument} tokenDoc - Foundry token document
   * @private
   */
  updateSpriteTransform(sprite, tokenDoc) {
    // Convert Foundry position (top-left origin) to THREE.js (center origin)
    const centerX = tokenDoc.x + tokenDoc.width / 2;
    const centerY = tokenDoc.y + tokenDoc.height / 2;
    
    // Z-position = base + elevation
    // Elevation is in grid units, convert to reasonable z-offset
    const elevation = tokenDoc.elevation || 0;
    const zPosition = TOKEN_BASE_Z + elevation;

    sprite.position.set(centerX, centerY, zPosition);

    // Scale to match token size
    sprite.scale.set(tokenDoc.width, tokenDoc.height, 1);

    // Rotation (Foundry uses degrees, THREE.js uses radians)
    if (tokenDoc.rotation !== undefined) {
      sprite.material.rotation = THREE.MathUtils.degToRad(tokenDoc.rotation);
    }
  }

  /**
   * Update sprite visibility based on token state
   * @param {THREE.Sprite} sprite - THREE.js sprite
   * @param {TokenDocument} tokenDoc - Foundry token document
   * @private
   */
  updateSpriteVisibility(sprite, tokenDoc) {
    // Hidden tokens are only visible to GMs
    if (tokenDoc.hidden) {
      sprite.visible = game.user?.isGM || false;
    } else {
      sprite.visible = true;
    }

    // Could also handle disposition (friendly, neutral, hostile) colors here
    // Could handle effects (invisible, etc.) here
  }

  /**
   * Load texture with caching
   * @param {string} texturePath - Path to texture
   * @returns {Promise<THREE.Texture>}
   * @private
   */
  async loadTokenTexture(texturePath) {
    // Check cache first
    if (this.textureCache.has(texturePath)) {
      return this.textureCache.get(texturePath);
    }

    // Load new texture
    return new Promise((resolve, reject) => {
      this.textureLoader.load(
        texturePath,
        (texture) => {
          // Configure texture
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          
          // Cache for reuse
          this.textureCache.set(texturePath, texture);
          
          resolve(texture);
        },
        undefined, // onProgress
        (error) => {
          reject(error);
        }
      );
    });
  }

  /**
   * Get token sprite by Foundry token ID
   * @param {string} tokenId - Token document ID
   * @returns {THREE.Sprite|null}
   * @public
   */
  getTokenSprite(tokenId) {
    return this.tokenSprites.get(tokenId)?.sprite || null;
  }

  /**
   * Get all token sprites
   * @returns {THREE.Sprite[]}
   * @public
   */
  getAllTokenSprites() {
    return Array.from(this.tokenSprites.values()).map(data => data.sprite);
  }

  /**
   * Dispose all resources
   * @public
   */
  dispose() {
    log.info(`Disposing TokenManager with ${this.tokenSprites.size} tokens`);

    // Remove all token sprites
    for (const [tokenId, data] of this.tokenSprites.entries()) {
      this.scene.remove(data.sprite);
      data.sprite.material?.dispose();
      data.sprite.geometry?.dispose();
    }

    this.tokenSprites.clear();

    // Dispose cached textures
    for (const texture of this.textureCache.values()) {
      texture.dispose();
    }
    this.textureCache.clear();

    this.initialized = false;
    
    log.info('TokenManager disposed');
  }

  /**
   * Get statistics for debugging
   * @returns {object}
   * @public
   */
  getStats() {
    return {
      tokenCount: this.tokenSprites.size,
      cachedTextures: this.textureCache.size,
      initialized: this.initialized,
      hooksRegistered: this.hooksRegistered
    };
  }
}

/**
 * @typedef {object} TokenSpriteData
 * @property {THREE.Sprite} sprite - THREE.js sprite
 * @property {TokenDocument} tokenDoc - Foundry token document
 * @property {number} lastUpdate - Timestamp of last update
 */
