/**
 * @fileoverview Token manager - syncs Foundry tokens to THREE.js sprites
 * Handles creation, updates, and deletion of token sprites in the THREE.js scene
 * @module scene/token-manager
 */

import { createLogger } from '../core/log.js';
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';

const log = createLogger('TokenManager');

/**
 * Z-position base for tokens (from architecture)
 * Tokens render at this z-position + elevation above the scene groundZ.
 * Kept in a thin band above tiles to minimize depth range.
 */
const TOKEN_BASE_Z = 0.06;

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
    
    /** @type {EffectComposer|null} */
    this.effectComposer = null;

    // Track active animations
    // Map<tokenId, { 
    //   attributes: Array<{parent, attribute, start, to, diff}>, 
    //   duration: number, 
    //   elapsed: number, 
    //   easing: string 
    // }>
    this.activeAnimations = new Map();

    this._globalTint = null;
    this._daylightTint = null;
    this._darknessTint = null;
    this._ambientTint = null;
    this._lastTintKey = null;
    this._tintDirty = true;

    /** @type {((tokenId: string) => void)|null} */
    this._onTokenMovementStart = null;

    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];
    
    log.debug('TokenManager created');
  }

  /**
   * Register a callback invoked when a token begins moving (authoritative update).
   * @param {(tokenId: string) => void} callback
   */
  setOnTokenMovementStart(callback) {
    this._onTokenMovementStart = typeof callback === 'function' ? callback : null;
  }

  /**
   * Set the EffectComposer instance
   * @param {EffectComposer} composer 
   */
  setEffectComposer(composer) {
    this.effectComposer = composer;
    // Auto-register if already initialized
    if (this.initialized && this.effectComposer) {
      this.effectComposer.addUpdatable(this);
    }
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
    
    if (this.effectComposer) {
      this.effectComposer.addUpdatable(this);
    }
    
    log.info('TokenManager initialized');
  }

  /**
   * Update tokens (called every frame by EffectComposer)
   * @param {TimeInfo} timeInfo 
   */
  update(timeInfo) {
    // Process active animations
    for (const [tokenId, anim] of this.activeAnimations.entries()) {
      // Update elapsed time
      anim.elapsed += timeInfo.delta * 1000; // Convert seconds to ms for duration compatibility
      
      const progress = Math.min(anim.elapsed / anim.duration, 1);
      
      // EaseInOutCosine: 0.5 - Math.cos(progress * Math.PI) / 2
      const ease = 0.5 - Math.cos(progress * Math.PI) / 2;

      for (const data of anim.attributes) {
        data.parent[data.attribute] = data.start + (data.diff * ease);
      }

      if (progress >= 1) {
        // Ensure final values are exact
        for (const data of anim.attributes) {
          data.parent[data.attribute] = data.to;
        }
        this.activeAnimations.delete(tokenId);
      }

      const spriteData = this.tokenSprites.get(tokenId);
      const sprite = spriteData?.sprite;
      if (sprite && sprite.matrixAutoUpdate === false) {
        sprite.updateMatrix();
      }
    }

    // Apply global lighting tint to tokens based on scene darkness
    const THREE = window.THREE;
    if (THREE) {
      if (!this._globalTint) this._globalTint = new THREE.Color(1, 1, 1);
      if (!this._daylightTint) this._daylightTint = new THREE.Color(1, 1, 1);
      if (!this._darknessTint) this._darknessTint = new THREE.Color(1, 1, 1);
      if (!this._ambientTint) this._ambientTint = new THREE.Color(1, 1, 1);

      // If LightingEffect is active, token lighting is handled by the lighting composite.
      // Keep token base colors neutral so lights can punch through the global darkness.
      try {
        const le = window.MapShine?.lightingEffect;
        if (le && le.enabled) {
          const globalTint = this._globalTint;
          globalTint.setRGB(1, 1, 1);

          const tintKey = 0xffffff;
          if (!this._tintDirty && tintKey === this._lastTintKey) {
            return;
          }

          this._lastTintKey = tintKey;
          this._tintDirty = false;

          for (const data of this.tokenSprites.values()) {
            const { sprite } = data;
            if (sprite && sprite.material) {
              sprite.material.color.copy(globalTint);
            }
          }
          return;
        }
      } catch (_) {
      }

      const globalTint = this._globalTint;
      globalTint.setRGB(1, 1, 1);

      try {
        const scene = canvas?.scene;
        const env = canvas?.environment;

        if (scene?.environment?.darknessLevel !== undefined) {
          let darkness = scene.environment.darknessLevel;
          const le = window.MapShine?.lightingEffect;
          if (le && typeof le.getEffectiveDarkness === 'function') {
            darkness = le.getEffectiveDarkness();
          }

          const getThreeColor = (src, def, out) => {
            try {
              if (!out) out = new THREE.Color(def);
              if (!src) {
                out.set(def);
                return out;
              }
              if (src instanceof THREE.Color) {
                out.copy(src);
                return out;
              }
              if (src.rgb) {
                out.setRGB(src.rgb[0], src.rgb[1], src.rgb[2]);
                return out;
              }
              if (Array.isArray(src)) {
                out.setRGB(src[0], src[1], src[2]);
                return out;
              }
              out.set(src);
              return out;
            } catch (e) {
              out.set(def);
              return out;
            }
          };

          const daylight = getThreeColor(env?.colors?.ambientDaylight, 0xffffff, this._daylightTint);
          const darknessColor = getThreeColor(env?.colors?.ambientDarkness, 0x242448, this._darknessTint);

          const ambientTint = this._ambientTint.copy(daylight).lerp(darknessColor, darkness);

          const lightLevel = Math.max(1.0 - darkness, 0.25);

          globalTint.copy(ambientTint).multiplyScalar(lightLevel);
        }
      } catch (e) {
      }

      const tr = Math.max(0, Math.min(255, (globalTint.r * 255 + 0.5) | 0));
      const tg = Math.max(0, Math.min(255, (globalTint.g * 255 + 0.5) | 0));
      const tb = Math.max(0, Math.min(255, (globalTint.b * 255 + 0.5) | 0));
      const tintKey = (tr << 16) | (tg << 8) | tb;

      if (!this._tintDirty && tintKey === this._lastTintKey) {
        return;
      }

      this._lastTintKey = tintKey;
      this._tintDirty = false;

      for (const data of this.tokenSprites.values()) {
        const { sprite } = data;
        if (sprite && sprite.material) {
          sprite.material.color.copy(globalTint);
        }
      }
    }
  }

  /**
   * Set up Foundry VTT hooks for token synchronization
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    // Initial load when canvas is ready
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
      log.debug('Canvas ready, syncing all tokens');
      this.syncAllTokens();
    })]);

    // Create new token
    this._hookIds.push(['createToken', Hooks.on('createToken', (tokenDoc, options, userId) => {
      log.debug(`Token created: ${tokenDoc.id}`);
      this.createTokenSprite(tokenDoc);
    })]);

    // Update existing token
    this._hookIds.push(['updateToken', Hooks.on('updateToken', (tokenDoc, changes, options, userId) => {
      log.debug(`Token updated: ${tokenDoc.id}`, changes);
      this.updateTokenSprite(tokenDoc, changes, options);
    })]);

    // Delete token
    this._hookIds.push(['deleteToken', Hooks.on('deleteToken', (tokenDoc, options, userId) => {
      log.debug(`Token deleted: ${tokenDoc.id}`);
      this.removeTokenSprite(tokenDoc.id);
    })]);

    // Refresh token (rendering changes)
    this._hookIds.push(['refreshToken', Hooks.on('refreshToken', (token) => {
      log.debug(`Token refreshed: ${token.id}`);
      // Refresh typically means visual state changed (visibility, effects, etc.)
      this.refreshTokenSprite(token.document);
    })]);

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
    sprite.matrixAutoUpdate = false;
    
    // Store Foundry data in userData
    sprite.userData.foundryTokenId = tokenDoc.id;
    sprite.userData.tokenDoc = tokenDoc;
    sprite.userData._removed = false;

    // Load texture (async, will update material when loaded)
    // IMPORTANT: Token can be deleted before the texture resolves; guard against writing
    // into a disposed material/sprite.
    this.loadTokenTexture(texturePath).then(texture => {
      const currentData = this.tokenSprites.get(tokenDoc.id);
      const currentSprite = currentData?.sprite;
      if (!currentSprite || currentSprite.userData?._removed) return;
      if (!currentSprite.material || currentSprite.material.disposed) return;

      currentSprite.material.map = texture;
      currentSprite.material.opacity = 1; // Restore opacity
      currentSprite.material.needsUpdate = true;
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
      lastUpdate: Date.now(),
      isSelected: false,
      isHovered: false
    });

    this._tintDirty = true;

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
    
    log.debug(`updateTokenSprite: ${tokenDoc.id} | changes:`, changes);

    // Update transform if position/size/elevation changed
    if ('x' in changes || 'y' in changes || 'width' in changes || 
        'height' in changes || 'elevation' in changes || 'rotation' in changes) {
      
      // Create a proxy/merged object for target state
      // We prefer 'changes' values as they are authoritative for the new state
      // This fixes the "lagging behind" issue where tokenDoc might be stale in the hook
      const targetDoc = {
        x: 'x' in changes ? changes.x : tokenDoc.x,
        y: 'y' in changes ? changes.y : tokenDoc.y,
        width: 'width' in changes ? changes.width : tokenDoc.width,
        height: 'height' in changes ? changes.height : tokenDoc.height,
        elevation: 'elevation' in changes ? changes.elevation : tokenDoc.elevation,
        rotation: 'rotation' in changes ? changes.rotation : tokenDoc.rotation,
        // For complex objects like texture, fall back to tokenDoc for now unless critical
        texture: tokenDoc.texture,
        id: tokenDoc.id
      };

      log.debug(`Updating transform for ${tokenDoc.id}: x=${targetDoc.x}, y=${targetDoc.y}, z=${targetDoc.elevation}`);
      
      // Check if we should animate (default true unless specified false)
      // Also, if only elevation/size changed, we might snap? Foundry animates size/elevation too usually.
      const animate = options.animate !== false;
      this.updateSpriteTransform(sprite, targetDoc, animate);
    }

    // Update texture if changed
    if ('texture' in changes && changes.texture?.src) {
      const src = changes.texture.src;
      this.loadTokenTexture(src).then(texture => {
        const currentData = this.tokenSprites.get(tokenDoc.id);
        const currentSprite = currentData?.sprite;
        if (!currentSprite || currentSprite.userData?._removed) return;
        if (!currentSprite.material || currentSprite.material.disposed) return;

        currentSprite.material.map = texture;
        currentSprite.material.needsUpdate = true;
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

    if ('name' in changes) {
      this._refreshNameLabel(spriteData);
    }

    if ('name' in changes || 'displayName' in changes || 'disposition' in changes) {
      this._updateNameLabelVisibility(spriteData);
    }

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

    // If Foundry's Token HUD is currently bound to this token, close it.
    // Otherwise InteractionManager may attempt to reposition HUD for a token whose
    // Three sprite has been removed.
    try {
      const hud = canvas.tokens?.hud;
      const hudTokenId = hud?.object?.id;
      if (hud?.rendered && hudTokenId === tokenId) {
        hud.close();
      }
    } catch (_) {
    }

    // Mark removed early so any in-flight async callbacks can bail.
    try {
      sprite.userData._removed = true;
    } catch (_) {
    }

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

    this._tintDirty = true;

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
    
    // Z-position = groundZ + base + elevation
    const elevation = tokenDoc.elevation || 0;
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    const zPosition = groundZ + TOKEN_BASE_Z + elevation;

    log.debug(`Calculated Sprite Pos: (${centerX}, ${centerY}, ${zPosition}) from Token (${tokenDoc.x}, ${tokenDoc.y})`);
    log.debug(`Current Sprite Pos: (${sprite.position.x}, ${sprite.position.y}, ${sprite.position.z})`);

    // Handle Scale (usually instant)
    sprite.scale.set(widthPx, heightPx, 1);
    if (sprite.matrixAutoUpdate === false) {
      sprite.updateMatrix();
    }

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
        try {
          if (this._onTokenMovementStart) this._onTokenMovementStart(tokenDoc.id);
        } catch (_) {
        }
        // Calculate duration based on distance
        const dist = Math.hypot(sprite.position.x - centerX, sprite.position.y - centerY);
        
        // If distance is negligible, snap instantly
        if (dist < 1) {
          log.debug(`Distance too small (${dist}), snapping`);
          sprite.position.set(centerX, centerY, zPosition);
          if (sprite.material) sprite.material.rotation = targetRotation;
          if (sprite.matrixAutoUpdate === false) {
            sprite.updateMatrix();
          }
          return;
        }

        const duration = Math.max(250, Math.min((dist / gridSize) * 250, 2000));
        
        log.debug(`Starting animation for ${tokenDoc.id}. Duration: ${duration}, Attrs: ${attributes.length}`);
        
        this.startAnimation(tokenDoc.id, attributes, duration);
        return;
      } else {
        log.debug(`No animation needed for ${tokenDoc.id} (already at target)`);
      }
    } else {
      log.debug(`Skipping animation for ${tokenDoc.id} (animate=${animate})`);
    }

    // Fallback: Instant Snap
    if (
      Math.abs(sprite.position.x - centerX) > 0.1 ||
      Math.abs(sprite.position.y - centerY) > 0.1 ||
      Math.abs(sprite.position.z - zPosition) > 0.1
    ) {
      try {
        if (this._onTokenMovementStart) this._onTokenMovementStart(tokenDoc.id);
      } catch (_) {
      }
    }
    sprite.position.set(centerX, centerY, zPosition);
    if (sprite.material) {
      sprite.material.rotation = targetRotation;
    }
    if (sprite.matrixAutoUpdate === false) {
      sprite.updateMatrix();
    }
  }

  /**
   * Start a token animation (managed by main loop)
   * @param {string} tokenId 
   * @param {Array} attributes 
   * @param {number} duration 
   * @private
   */
  startAnimation(tokenId, attributes, duration) {
    // Cancel existing (overwrite)
    this.activeAnimations.delete(tokenId);

    // Capture start values and calculate diffs
    const animAttributes = attributes.map(attr => ({
      parent: attr.parent,
      attribute: attr.attribute,
      start: attr.parent[attr.attribute], // Current value is start
      to: attr.to,
      diff: attr.to - attr.parent[attr.attribute]
    }));

    log.debug(`startAnimation: ${tokenId}, duration=${duration}, diffs=${animAttributes.map(a => a.diff).join(',')}`);

    this.activeAnimations.set(tokenId, {
      attributes: animAttributes,
      duration: duration,
      elapsed: 0
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

    spriteData.isSelected = !!selected;
    
    // Use square border instead of tint
    if (selected) {
      if (!spriteData.selectionBorder) {
        this.createSelectionBorder(spriteData);
      }
      spriteData.selectionBorder.visible = true;
    } else {
      if (spriteData.selectionBorder) {
        spriteData.selectionBorder.visible = false;
      }
    }

    this._updateNameLabelVisibility(spriteData);
    
    // Reset tint
    sprite.material.color.setHex(0xffffff);
    this._tintDirty = true;
  }

  /**
   * Set token hover state
   * @param {string} tokenId 
   * @param {boolean} hovered 
   */
  setHover(tokenId, hovered) {
    const spriteData = this.tokenSprites.get(tokenId);
    if (!spriteData) return;

    spriteData.isHovered = !!hovered;

    this._updateNameLabelVisibility(spriteData);
  }

  _refreshNameLabel(spriteData) {
    const label = spriteData?.nameLabel;
    const sprite = spriteData?.sprite;
    if (!label || !sprite) return;

    try {
      sprite.remove(label);
    } catch (_) {
    }

    try {
      const map = label.material?.map;
      if (map) map.dispose();
      label.material?.dispose?.();
    } catch (_) {
    }

    spriteData.nameLabel = null;
  }

  _canViewMode(mode, spriteData) {
    try {
      const m = mode ?? CONST?.TOKEN_DISPLAY_MODES?.NONE;
      if (m === CONST.TOKEN_DISPLAY_MODES.NONE) return false;
      if (m === CONST.TOKEN_DISPLAY_MODES.ALWAYS) return true;
      if (m === CONST.TOKEN_DISPLAY_MODES.CONTROL) return !!spriteData?.isSelected;

      const hover = !!spriteData?.isHovered || !!canvas?.tokens?.layer?.highlightObjects;
      if (m === CONST.TOKEN_DISPLAY_MODES.HOVER) return hover;

      const isOwner = !!spriteData?.tokenDoc?.isOwner
        || !!spriteData?.tokenDoc?.actor?.testUserPermission?.(game.user, 'OWNER')
        || !!game?.user?.isGM;

      if (m === CONST.TOKEN_DISPLAY_MODES.OWNER_HOVER) return isOwner && hover;
      if (m === CONST.TOKEN_DISPLAY_MODES.OWNER) return isOwner;
      return false;
    } catch (_) {
      return false;
    }
  }

  _updateNameLabelVisibility(spriteData) {
    const tokenDoc = spriteData?.tokenDoc;
    if (!tokenDoc) return;

    let isOwner = false;
    try {
      isOwner = !!tokenDoc.isOwner || !!tokenDoc.actor?.testUserPermission?.(game.user, 'OWNER') || !!game?.user?.isGM;
    } catch (_) {
      isOwner = !!game?.user?.isGM;
    }

    let isSecret = false;
    try {
      isSecret = tokenDoc.disposition === CONST.TOKEN_DISPOSITIONS.SECRET && !isOwner;
    } catch (_) {
      isSecret = false;
    }

    const visible = !isSecret && this._canViewMode(tokenDoc.displayName, spriteData);

    if (visible && !spriteData.nameLabel) {
      this.createNameLabel(spriteData);
    }

    if (spriteData.nameLabel) {
      spriteData.nameLabel.visible = visible;
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
    border.matrixAutoUpdate = false;
    // Render selection border in overlay pass so it's not affected by bloom
    border.layers.set(OVERLAY_THREE_LAYER);
    
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
    border.updateMatrix();
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
    label.matrixAutoUpdate = false;
    // Render label in overlay pass so it's not affected by bloom
    label.layers.set(OVERLAY_THREE_LAYER);
    
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
    label.updateMatrix();
    
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

    // Unregister Foundry hooks using correct two-argument signature
    try {
      if (this._hookIds && this._hookIds.length) {
        for (const [hookName, hookId] of this._hookIds) {
          try {
            Hooks.off(hookName, hookId);
          } catch (e) {
          }
        }
      }
    } catch (e) {
    }
    this._hookIds = [];
    this.hooksRegistered = false;

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
