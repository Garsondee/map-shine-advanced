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
    
    // Track active animations to allow cancellation
    this.activeAnimations = new Map(); // tokenId -> { cancel: () => void }
    
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
      this.updateTokenSprite(tokenDoc, changes, options);
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
      depthWrite: true,
      sizeAttenuation: true, // Enable perspective scaling - tokens should scale with the world
      side: THREE.DoubleSide // CRITICAL: Prevent culling when projection matrix is flipped
    });

    const sprite = new THREE.Sprite(material);
    sprite.name = `Token_${tokenDoc.id}`;
    
    // Store Foundry data in userData
    sprite.userData.foundryTokenId = tokenDoc.id;
    sprite.userData.tokenDoc = tokenDoc;

    // Load texture (async, will update material when loaded)
    this.loadTokenTexture(texturePath).then(texture => {
      material.map = texture;
      material.opacity = 1; // Restore opacity
      material.needsUpdate = true;
    }).catch(error => {
      log.error(`Failed to load token texture: ${texturePath}`, error);
    });

    // Set initial position, scale, visibility
    this.updateSpriteTransform(sprite, tokenDoc);
    this.updateSpriteVisibility(sprite, tokenDoc);
    
    // Start with 0 opacity to prevent white flash before texture loads
    sprite.material.opacity = 0;

    // Add to scene
    // DEBUG: TEMPORARILY DISABLED TOKEN RENDERING
    // log.warn(`DEBUG: Token rendering disabled for ${tokenDoc.id}`);
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
   * @param {object} [options={}] - Update options
   * @private
   */
  updateTokenSprite(tokenDoc, changes, options = {}) {
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
      log.debug(`Updating transform for ${tokenDoc.id}: x=${tokenDoc.x}, y=${tokenDoc.y}, z=${tokenDoc.elevation}`);
      
      // Check if we should animate (default true unless specified false)
      // Also, if only elevation/size changed, we might snap? Foundry animates size/elevation too usually.
      const animate = options.animate !== false;
      this.updateSpriteTransform(sprite, tokenDoc, animate);
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
    
    // CRITICAL: Update sprite userData so InteractionManager sees the new doc
    sprite.userData.tokenDoc = tokenDoc;

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
   * @param {boolean} [animate=false] - Whether to animate the transition
   * @private
   */
  updateSpriteTransform(sprite, tokenDoc, animate = false) {
    // Get grid size for proper scaling
    const gridSize = canvas.grid?.size || 100;
    
    // Get texture scale factors (default to 1)
    const scaleX = tokenDoc.texture?.scaleX ?? 1;
    const scaleY = tokenDoc.texture?.scaleY ?? 1;
    
    // Token width/height are in grid units, convert to pixels AND apply texture scale
    const widthPx = tokenDoc.width * gridSize * scaleX;
    const heightPx = tokenDoc.height * gridSize * scaleY;
    
    // Convert Foundry position (top-left origin) to THREE.js (center origin)
    const rectWidth = tokenDoc.width * gridSize;
    const rectHeight = tokenDoc.height * gridSize;
    const centerX = tokenDoc.x + rectWidth / 2;
    
    // Invert Y for Standard Coordinate System
    const sceneHeight = canvas.dimensions?.height || 10000;
    const centerY = sceneHeight - (tokenDoc.y + rectHeight / 2);
    
    // Z-position = base + elevation
    const elevation = tokenDoc.elevation || 0;
    const zPosition = TOKEN_BASE_Z + elevation;

    log.debug(`Calculated Sprite Pos: (${centerX}, ${centerY}, ${zPosition}) from Token (${tokenDoc.x}, ${tokenDoc.y})`);
    log.debug(`Current Sprite Pos: (${sprite.position.x}, ${sprite.position.y}, ${sprite.position.z})`);

    // Handle Scale (usually instant)
    sprite.scale.set(widthPx, heightPx, 1);

    // Target Rotation (radians)
    let targetRotation = 0;
    if (tokenDoc.rotation !== undefined) {
      targetRotation = THREE.MathUtils.degToRad(tokenDoc.rotation);
    }

    // Animation Logic
    if (animate && typeof CanvasAnimation !== 'undefined') {
      const attributes = [];
      
      // Position X
      if (Math.abs(sprite.position.x - centerX) > 0.1) {
        attributes.push({ parent: sprite.position, attribute: "x", to: centerX });
      }
      // Position Y
      if (Math.abs(sprite.position.y - centerY) > 0.1) {
        attributes.push({ parent: sprite.position, attribute: "y", to: centerY });
      }
      // Position Z (Elevation)
      if (Math.abs(sprite.position.z - zPosition) > 0.1) {
        attributes.push({ parent: sprite.position, attribute: "z", to: zPosition });
      }
      // Rotation
      if (sprite.material && Math.abs(sprite.material.rotation - targetRotation) > 0.01) {
        attributes.push({ parent: sprite.material, attribute: "rotation", to: targetRotation });
      }

      if (attributes.length > 0) {
        // Calculate duration based on distance
        const dist = Math.hypot(sprite.position.x - centerX, sprite.position.y - centerY);
        
        // If distance is negligible, snap instantly
        if (dist < 1) {
          log.debug(`Distance too small (${dist}), snapping`);
          sprite.position.set(centerX, centerY, zPosition);
          if (sprite.material) sprite.material.rotation = targetRotation;
          return;
        }

        const duration = Math.max(250, Math.min((dist / gridSize) * 250, 2000));
        
        log.debug(`Starting animation for ${tokenDoc.id}. Duration: ${duration}, Attrs: ${attributes.length}`);
        
        this.runAnimation(tokenDoc.id, attributes, duration);
        return;
      } else {
        log.debug(`No animation needed for ${tokenDoc.id} (already at target)`);
      }
    } else {
      log.debug(`Skipping animation for ${tokenDoc.id} (animate=${animate})`);
    }

    // Fallback: Instant Snap
    sprite.position.set(centerX, centerY, zPosition);
    if (sprite.material) {
      sprite.material.rotation = targetRotation;
    }
  }

  /**
   * Custom animation system
   * @param {string} tokenId 
   * @param {Array} attributes 
   * @param {number} duration 
   * @private
   */
  runAnimation(tokenId, attributes, duration) {
    // Cancel existing
    if (this.activeAnimations.has(tokenId)) {
      this.activeAnimations.get(tokenId).cancel();
      this.activeAnimations.delete(tokenId);
    }

    const startTime = performance.now();
    
    // Capture start values
    const animData = attributes.map(attr => ({
      parent: attr.parent,
      attribute: attr.attribute,
      start: attr.to,
      to: attr.parent[attr.attribute],
      diff: attr.parent[attr.attribute] - attr.to
    }));

    let animationFrameId;

    const tick = (currentTime) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // EaseInOutCosine: 0.5 - Math.cos(progress * Math.PI) / 2
      const ease = 0.5 - Math.cos(progress * Math.PI) / 2;

      for (const data of animData) {
        data.parent[data.attribute] = data.start + (data.diff * ease);
      }

      if (progress < 1) {
        animationFrameId = requestAnimationFrame(tick);
      } else {
        // Ensure final values are exact
        for (const data of animData) {
          data.parent[data.attribute] = data.to;
        }
        this.activeAnimations.delete(tokenId);
      }
    };

    animationFrameId = requestAnimationFrame(tick);

    this.activeAnimations.set(tokenId, {
      cancel: () => cancelAnimationFrame(animationFrameId)
    });
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
      sprite.material.opacity = 0.5;
    } else {
      sprite.visible = true;
      sprite.material.opacity = 1.0;
    }
  }

  /**
   * Set token selection state
   * @param {string} tokenId 
   * @param {boolean} selected 
   */
  setTokenSelection(tokenId, selected) {
    const spriteData = this.tokenSprites.get(tokenId);
    if (!spriteData) return;

    const { sprite, tokenDoc } = spriteData;
    
    // Use square border instead of tint
    if (selected) {
      if (!spriteData.selectionBorder) {
        this.createSelectionBorder(spriteData);
      }
      spriteData.selectionBorder.visible = true;
      
      // Also show name on selection? Usually yes.
      this.setHover(tokenId, true);
    } else {
      if (spriteData.selectionBorder) {
        spriteData.selectionBorder.visible = false;
      }
      // Hide name if not hovered (we'll need to track hover state separately, but for now assume deselect = hide)
      this.setHover(tokenId, false);
    }
    
    // Reset tint
    sprite.material.color.setHex(0xffffff);
  }

  /**
   * Set token hover state
   * @param {string} tokenId 
   * @param {boolean} hovered 
   */
  setHover(tokenId, hovered) {
    const spriteData = this.tokenSprites.get(tokenId);
    if (!spriteData) return;

    // Create name label if needed
    if (hovered && !spriteData.nameLabel) {
      this.createNameLabel(spriteData);
    }

    if (spriteData.nameLabel) {
      spriteData.nameLabel.visible = hovered;
    }
  }

  /**
   * Create selection border for a token
   * @param {object} spriteData 
   * @private
   */
  createSelectionBorder(spriteData) {
    const THREE = window.THREE;
    const { sprite, tokenDoc } = spriteData;
    
    // Create square geometry (1x1, centered)
    // Vertices: TopLeft, TopRight, BottomRight, BottomLeft
    const points = [];
    points.push(new THREE.Vector3(-0.5, 0.5, 0));
    points.push(new THREE.Vector3(0.5, 0.5, 0));
    points.push(new THREE.Vector3(0.5, -0.5, 0));
    points.push(new THREE.Vector3(-0.5, -0.5, 0));
    
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    
    // Orange/Yellow selection color: 0xFF9829 (Foundry-ish)
    const material = new THREE.LineBasicMaterial({ 
      color: 0xFF9829, 
      linewidth: 2, // Note: WebGL lineWidth often limited to 1
      depthTest: false, // Always show on top
      depthWrite: false
    });
    
    const border = new THREE.LineLoop(geometry, material);
    border.name = 'SelectionBorder';
    
    // Scale to match sprite (which matches token size)
    // Sprite has scale set to pixel width/height
    // But we are adding as child of sprite? 
    // If child of sprite, it inherits sprite scale.
    // Since sprite is 1x1 geometry scaled to WxH.
    // Our border is 1x1. So it matches perfectly.
    // BUT sprite might be scaled differently if texture is non-square?
    // TokenManager sets sprite scale to (widthPx, heightPx, 1).
    // So child at scale (1,1,1) will stretch to (widthPx, heightPx).
    // Correct.
    
    // Z-offset to prevent z-fighting with token? 
    // Token is at Z=10. Border at Z=0 relative to token.
    // We set depthTest: false so it draws on top.
    
    sprite.add(border);
    spriteData.selectionBorder = border;
  }

  /**
   * Create name label for a token
   * @param {object} spriteData 
   * @private
   */
  createNameLabel(spriteData) {
    const THREE = window.THREE;
    const { sprite, tokenDoc } = spriteData;
    
    // Create canvas for text
    // High resolution for crisp rendering
    const fontSize = 96; 
    const padding = 20;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const text = tokenDoc.name || "Unknown";
    const font = `bold ${fontSize}px Arial, sans-serif`;
    
    ctx.font = font;
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const canvasWidth = Math.ceil(textWidth + padding * 2);
    const canvasHeight = Math.ceil(fontSize * 1.4); // Room for descenders/outline
    
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    
    // Text Configuration
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Center position
    const cx = canvasWidth / 2;
    const cy = canvasHeight / 2;

    // Text Outline (Stroke) for readability without background
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 8; // Thick outline
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeText(text, cx, cy);
    
    // Text Fill
    ctx.fillStyle = 'white';
    ctx.fillText(text, cx, cy);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace; // Ensure correct colors
    
    const material = new THREE.SpriteMaterial({ 
      map: texture, 
      transparent: true,
      depthTest: false // Always on top
    });
    
    const label = new THREE.Sprite(material);
    label.name = 'NameLabel';
    
    // Scale calculation:
    // Maintain constant world height regardless of resolution
    const parentScaleX = sprite.scale.x || 100;
    const parentScaleY = sprite.scale.y || 100;
    
    // Target height in world units (approx 1/3 grid square)
    // Slightly adjusted for visual balance
    const targetHeight = 30; 
    const aspectRatio = canvasWidth / canvasHeight;
    const targetWidth = targetHeight * aspectRatio;
    
    // Apply relative scale to counteract parent scaling
    label.scale.set(
      targetWidth / parentScaleX,
      targetHeight / parentScaleY,
      1
    );
    
    // Position above token
    const relativeLabelHeight = targetHeight / parentScaleY;
    // 0.5 is top edge. Move up by half label height + margin.
    label.position.set(0, 0.5 + (relativeLabelHeight / 2) + 0.05, 0);
    
    sprite.add(label);
    spriteData.nameLabel = label;
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
