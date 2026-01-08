/**
 * @fileoverview DoorMeshManager - Renders animated door graphics in THREE.js
 * 
 * Replicates Foundry VTT's DoorMesh system for backwards compatibility with
 * existing scene configurations. Reads from wall.document.animation to get:
 * - texture: Path to door texture image
 * - type: Animation type (swing, slide, ascend, descend, swivel)
 * - double: Whether it's a double door
 * - direction: Direction of swing/slide (-1 or 1)
 * - duration: Animation duration in ms
 * - strength: Animation strength multiplier
 * - flip: Whether to flip the texture vertically
 * 
 * @module scene/DoorMeshManager
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('DoorMeshManager');

/**
 * Animation easing function (ease-in-out cosine, matching Foundry)
 * @param {number} t - Progress 0-1
 * @returns {number} Eased value 0-1
 */
function easeInOutCosine(t) {
  return (1 - Math.cos(t * Math.PI)) / 2;
}

/**
 * Door style constants
 */
const DOOR_STYLES = Object.freeze({
  SINGLE: 'single',
  DOUBLE_LEFT: 'doubleL',
  DOUBLE_RIGHT: 'doubleR'
});

/**
 * Represents a single animated door mesh in THREE.js
 */
class DoorMesh {
  /**
   * @param {Object} options
   * @param {WallDocument} options.wallDoc - The Foundry wall document
   * @param {THREE.Texture} options.texture - The door texture
   * @param {string} options.style - Door style (single, doubleL, doubleR)
   * @param {Object} options.animation - Animation configuration
   * @param {THREE.Scene} options.scene - The THREE.js scene
   * @param {THREE.Camera} options.camera - The camera for billboarding (if needed)
   */
  constructor({ wallDoc, texture, style, animation, scene, camera }) {
    this.wallDoc = wallDoc;
    this.texture = texture;
    this.style = style;
    this.scene = scene;
    this.camera = camera;

    const THREE = window.THREE;
    this._globalTint = THREE ? new THREE.Color(0xffffff) : null;
    
    // Animation config with defaults
    this.animation = {
      type: animation?.type || 'swing',
      direction: animation?.direction ?? 1,
      double: animation?.double ?? false,
      duration: animation?.duration ?? 500,
      flip: animation?.flip ?? false,
      strength: animation?.strength ?? 1.0
    };
    
    // Flip direction for right side of double doors
    if (style === DOOR_STYLES.DOUBLE_RIGHT) {
      this.animation.direction *= -1;
    }
    
    // Current state
    this._isOpen = this._checkIsOpen();
    this._animationProgress = this._isOpen ? 1.0 : 0.0;
    this._animating = false;
    this._animationStartTime = 0;
    this._animationStartProgress = 0;
    this._animationTargetProgress = 0;
    
    // Mesh
    this.mesh = null;
    
    // Closed position state
    this._closedPosition = this._computeClosedPosition();
    
    this._createMesh();
    this._applyAnimationState(this._animationProgress);
  }
  
  /**
   * Check if the door is currently open
   * @returns {boolean}
   */
  _checkIsOpen() {
    return this.wallDoc.ds === CONST.WALL_DOOR_STATES.OPEN;
  }
  
  /**
   * Get wall endpoints as world coordinates
   * @returns {{a: {x: number, y: number}, b: {x: number, y: number}}}
   */
  _getWallEndpoints() {
    const c = this.wallDoc.c;
    const a = Coordinates.toWorld(c[0], c[1]);
    const b = Coordinates.toWorld(c[2], c[3]);
    return { a, b };
  }
  
  /**
   * Compute the closed position data for the door
   * @returns {Object}
   */
  _computeClosedPosition() {
    const { a, b } = this._getWallEndpoints();
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    
    // Determine pivot point based on style and animation type
    const isMidpoint = this._isMidpointAnimation();
    let pivot;
    
    if (this.style === DOOR_STYLES.DOUBLE_RIGHT) {
      pivot = isMidpoint ? { x: a.x + dx * 0.75, y: a.y + dy * 0.75 } : { x: b.x, y: b.y };
    } else if (this.style === DOOR_STYLES.DOUBLE_LEFT) {
      pivot = isMidpoint ? { x: a.x + dx * 0.25, y: a.y + dy * 0.25 } : { x: a.x, y: a.y };
    } else {
      // Single door
      pivot = isMidpoint ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: a.x, y: a.y };
    }
    
    // Width depends on single vs double
    const width = (this.style === DOOR_STYLES.SINGLE) ? distance : (distance / 2);
    
    // Scale factors
    const textureWidth = this.texture.image?.width || 100;
    const texturePadding = 0;
    const scaleX = width / (textureWidth - 2 * texturePadding);
    
    // Vertical scale based on grid size
    const gridSize = canvas.dimensions?.size || 100;
    const textureGridSize = this.wallDoc.flags?.core?.textureGridSize || CONFIG.Wall?.textureGridSize || 100;
    let scaleY = gridSize / textureGridSize;
    if (this.animation.flip) scaleY *= -1;
    if (this.style === DOOR_STYLES.DOUBLE_RIGHT) scaleY *= -1;
    
    // Rotation
    const rotation = (this.style === DOOR_STYLES.DOUBLE_RIGHT) ? (angle - Math.PI) : angle;
    
    return {
      x: pivot.x,
      y: pivot.y,
      rotation,
      scaleX,
      scaleY,
      alpha: 1.0,
      tint: 0xFFFFFF
    };
  }
  
  /**
   * Check if this animation type uses midpoint anchoring
   * @returns {boolean}
   */
  _isMidpointAnimation() {
    const type = this.animation.type;
    return type === 'ascend' || type === 'descend' || type === 'swivel';
  }
  
  /**
   * Create the THREE.js mesh for this door
   */
  _createMesh() {
    const THREE = window.THREE;
    if (!THREE) return;
    
    // Get texture dimensions
    const texWidth = this.texture.image?.width || 100;
    const texHeight = this.texture.image?.height || 100;
    
    // Create geometry - use a plane that we'll transform
    const geometry = new THREE.PlaneGeometry(texWidth, texHeight);
    
    // Adjust anchor point based on animation type
    if (this._isMidpointAnimation()) {
      // Midpoint anchor - geometry centered
      geometry.translate(0, 0, 0);
    } else {
      // Edge anchor - shift geometry so left edge is at origin
      geometry.translate(texWidth / 2, 0, 0);
    }
    
    // Create material
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true
    });
    
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.userData = {
      type: 'doorMesh',
      wallId: this.wallDoc.id,
      style: this.style
    };
    
    // Set render order to be above the base map but below UI
    this.mesh.renderOrder = 50;
    
    // Add to scene
    this.scene.add(this.mesh);
    
    log.debug(`Created door mesh for wall ${this.wallDoc.id} (${this.style})`);
  }
  
  /**
   * Apply the current animation state to the mesh
   * @param {number} progress - Animation progress 0 (closed) to 1 (open)
   */
  _applyAnimationState(progress) {
    if (!this.mesh) return;
    
    const closed = this._closedPosition;
    const type = this.animation.type;
    const strength = this.animation.strength;
    const direction = this.animation.direction;
    
    // Start from closed position
    let x = closed.x;
    let y = closed.y;
    let rotation = closed.rotation;
    let scaleX = closed.scaleX;
    let scaleY = closed.scaleY;
    let alpha = closed.alpha;
    let tintR = 1, tintG = 1, tintB = 1;
    
    // Apply animation based on type
    switch (type) {
      case 'swing':
      case 'swivel': {
        // Rotate around pivot
        const delta = (Math.PI / 2) * direction * strength * progress;
        rotation = closed.rotation + delta;
        break;
      }
      
      case 'slide': {
        // Slide along the wall direction
        const { a, b } = this._getWallEndpoints();
        const m = (this.style === DOOR_STYLES.SINGLE) ? strength : (strength * 0.5);
        const dx = (a.x - b.x) * direction * m * progress;
        const dy = (a.y - b.y) * direction * m * progress;
        x = closed.x + dx;
        y = closed.y + dy;
        break;
      }
      
      case 'ascend': {
        // Scale up and fade slightly
        const alphaReduction = 0.25 * strength * progress;
        const scaleIncrease = 0.1 * strength * progress;
        alpha = 1.0 - alphaReduction;
        scaleX = (Math.abs(closed.scaleX) + scaleIncrease) * Math.sign(closed.scaleX);
        scaleY = (Math.abs(closed.scaleY) + scaleIncrease) * Math.sign(closed.scaleY);
        // Tint darker when open
        const tintVal = progress > 0 ? 0.133 : 1.0; // 0x222222 / 0xFF = 0.133
        tintR = tintG = tintB = 1.0 - (1.0 - tintVal) * progress;
        break;
      }
      
      case 'descend': {
        // Scale down slightly and tint
        const scaleDecrease = 0.05 * strength * progress;
        scaleX = (Math.abs(closed.scaleX) - scaleDecrease) * Math.sign(closed.scaleX);
        scaleY = (Math.abs(closed.scaleY) - scaleDecrease) * Math.sign(closed.scaleY);
        // Tint darker when open
        const tintVal = progress > 0 ? 0.4 : 1.0; // 0x666666 / 0xFF = 0.4
        tintR = tintG = tintB = 1.0 - (1.0 - tintVal) * progress;
        break;
      }
    }
    
    // Apply to mesh
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.mesh.position.set(x, y, groundZ + 1.0); // Slightly above ground
    this.mesh.rotation.z = rotation;
    this.mesh.scale.set(scaleX, scaleY, 1);
    this.mesh.material.opacity = alpha;

    // Respect scene darkness: multiply door animation tint by the global tint.
    this.mesh.material.color.setRGB(tintR, tintG, tintB);
    if (this._globalTint) {
      this.mesh.material.color.multiply(this._globalTint);
    }
  }

  /**
   * Update the global tint (scene darkness) applied to this door.
   * @param {any} tint
   */
  setGlobalTint(tint) {
    if (!this._globalTint || !tint) return;
    this._globalTint.copy(tint);
  }
  
  /**
   * Start animating to a new state
   * @param {boolean} open - Target state
   */
  animate(open) {
    if (open === this._isOpen && !this._animating) return;
    
    this._isOpen = open;
    this._animating = true;
    this._animationStartTime = performance.now();
    this._animationStartProgress = this._animationProgress;
    this._animationTargetProgress = open ? 1.0 : 0.0;
    
    log.debug(`Door ${this.wallDoc.id} (${this.style}) animating to ${open ? 'OPEN' : 'CLOSED'}`);
  }
  
  /**
   * Update animation state (called each frame)
   * @param {number} elapsed - Elapsed time in seconds (unused, we use performance.now)
   */
  update(elapsed) {
    if (!this._animating) return;
    
    const now = performance.now();
    const duration = this.animation.duration;
    const rawProgress = (now - this._animationStartTime) / duration;
    
    if (rawProgress >= 1.0) {
      // Animation complete
      this._animationProgress = this._animationTargetProgress;
      this._animating = false;
    } else {
      // Interpolate with easing
      const eased = easeInOutCosine(rawProgress);
      const start = this._animationStartProgress;
      const end = this._animationTargetProgress;
      this._animationProgress = start + (end - start) * eased;
    }
    
    this._applyAnimationState(this._animationProgress);
  }
  
  /**
   * Immediately set to a state without animation
   * @param {boolean} open
   */
  setImmediate(open) {
    this._isOpen = open;
    this._animating = false;
    this._animationProgress = open ? 1.0 : 0.0;
    this._applyAnimationState(this._animationProgress);
  }
  
  /**
   * Refresh the door position (e.g., after wall coordinates change)
   */
  refresh() {
    this._closedPosition = this._computeClosedPosition();
    this._applyAnimationState(this._animationProgress);
  }
  
  /**
   * Dispose of this door mesh
   */
  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry?.dispose();
      this.mesh.material?.dispose();
      this.mesh = null;
    }
  }
}

/**
 * DoorMeshManager - Manages all animated door meshes in the scene
 */
export class DoorMeshManager {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    
    /** @type {Map<string, Set<DoorMesh>>} wallId -> Set of DoorMesh instances */
    this.doorMeshes = new Map();
    
    /** @type {Map<string, THREE.Texture>} texturePath -> loaded texture */
    this.textureCache = new Map();

    const THREE = window.THREE;
    this._globalTint = THREE ? new THREE.Color(0xffffff) : null;
    this._daylightTint = THREE ? new THREE.Color(0xffffff) : null;
    this._darknessTint = THREE ? new THREE.Color(0x242448) : null;
    this._ambientTint = THREE ? new THREE.Color(0xffffff) : null;
    this._skyTint = THREE ? new THREE.Color(0xffffff) : null;
    this._lastTintKey = 0xffffff;

    this.initialized = false;
    
    log.debug('DoorMeshManager created');
  }
  
  /**
   * Initialize the manager and set up hooks
   */
  initialize() {
    if (this.initialized) return;
    
    this._setupHooks();
    this._syncAllDoors();
    
    this.initialized = true;
    log.info('DoorMeshManager initialized');
  }
  
  /**
   * Set up Foundry hooks for door updates
   */
  _setupHooks() {
    // Wall created - check if it has a door mesh
    Hooks.on('createWall', (doc) => {
      this._createDoorMeshes(doc);
    });
    
    // Wall updated - handle door state changes and animation config changes
    Hooks.on('updateWall', (doc, changes) => {
      this._handleWallUpdate(doc, changes);
    });
    
    // Wall deleted - remove door meshes
    Hooks.on('deleteWall', (doc) => {
      this._destroyDoorMeshes(doc.id);
    });
  }
  
  /**
   * Sync all existing doors from the scene
   */
  _syncAllDoors() {
    if (!canvas.walls) return;
    
    log.info(`Syncing door meshes for ${canvas.walls.placeables.length} walls...`);
    
    let doorCount = 0;
    for (const wall of canvas.walls.placeables) {
      if (this._hasDoorMesh(wall.document)) {
        this._createDoorMeshes(wall.document);
        doorCount++;
      }
    }
    
    log.info(`Created door meshes for ${doorCount} doors`);
  }
  
  /**
   * Check if a wall document should have a door mesh
   * @param {WallDocument} doc
   * @returns {boolean}
   */
  _hasDoorMesh(doc) {
    if (doc.door === CONST.WALL_DOOR_TYPES.NONE) return false;
    const animation = doc.animation;
    if (!animation) return false;
    return !!(animation.type && animation.texture);
  }
  
  /**
   * Create door meshes for a wall
   * @param {WallDocument} doc
   */
  async _createDoorMeshes(doc) {
    // First destroy any existing meshes for this wall
    this._destroyDoorMeshes(doc.id);
    
    if (!this._hasDoorMesh(doc)) return;
    
    const animation = doc.animation;
    const textureSrc = animation.texture;
    
    try {
      // Load texture (with caching)
      let texture = this.textureCache.get(textureSrc);
      if (!texture) {
        texture = await this._loadTexture(textureSrc);
        if (texture) {
          this.textureCache.set(textureSrc, texture);
        }
      }
      
      if (!texture) {
        log.warn(`Failed to load door texture: ${textureSrc}`);
        return;
      }
      
      // Determine styles to create
      const styles = animation.double 
        ? [DOOR_STYLES.DOUBLE_LEFT, DOOR_STYLES.DOUBLE_RIGHT]
        : [DOOR_STYLES.SINGLE];
      
      const meshSet = new Set();
      
      for (const style of styles) {
        const doorMesh = new DoorMesh({
          wallDoc: doc,
          texture,
          style,
          animation,
          scene: this.scene,
          camera: this.camera
        });

        if (this._globalTint) {
          doorMesh.setGlobalTint(this._globalTint);
        }
        meshSet.add(doorMesh);
      }
      
      this.doorMeshes.set(doc.id, meshSet);
      log.debug(`Created ${styles.length} door mesh(es) for wall ${doc.id}`);
      
    } catch (err) {
      log.error(`Error creating door meshes for wall ${doc.id}:`, err);
    }
  }
  
  /**
   * Load a texture from a path
   * @param {string} src
   * @returns {Promise<THREE.Texture|null>}
   */
  async _loadTexture(src) {
    const THREE = window.THREE;
    if (!THREE) return null;
    
    return new Promise((resolve) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        src,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          resolve(texture);
        },
        undefined,
        (err) => {
          log.error(`Failed to load texture ${src}:`, err);
          resolve(null);
        }
      );
    });
  }
  
  /**
   * Handle wall update
   * @param {WallDocument} doc
   * @param {Object} changes
   */
  _handleWallUpdate(doc, changes) {
    const meshSet = this.doorMeshes.get(doc.id);
    
    // Check if we need to recreate meshes (animation config changed)
    const needsRecreate = 
      ('animation' in changes && (
        changes.animation?.texture !== undefined ||
        changes.animation?.double !== undefined ||
        changes.animation?.type !== undefined
      )) ||
      ('door' in changes);
    
    if (needsRecreate) {
      // Recreate meshes
      this._createDoorMeshes(doc);
      return;
    }
    
    // Check if door state changed
    if ('ds' in changes && meshSet) {
      const isOpen = doc.ds === CONST.WALL_DOOR_STATES.OPEN;
      for (const doorMesh of meshSet) {
        doorMesh.animate(isOpen);
      }
    }
    
    // Check if wall coordinates changed
    if ('c' in changes && meshSet) {
      for (const doorMesh of meshSet) {
        doorMesh.wallDoc = doc; // Update reference
        doorMesh.refresh();
      }
    }
    
    // Check if animation parameters changed (but not texture/type/double)
    if ('animation' in changes && meshSet) {
      const anim = changes.animation;
      if (anim.direction !== undefined || anim.duration !== undefined || 
          anim.strength !== undefined || anim.flip !== undefined) {
        // Update animation config and refresh
        for (const doorMesh of meshSet) {
          if (anim.direction !== undefined) doorMesh.animation.direction = anim.direction;
          if (anim.duration !== undefined) doorMesh.animation.duration = anim.duration;
          if (anim.strength !== undefined) doorMesh.animation.strength = anim.strength;
          if (anim.flip !== undefined) doorMesh.animation.flip = anim.flip;
          doorMesh.refresh();
        }
      }
    }
  }
  
  /**
   * Destroy door meshes for a wall
   * @param {string} wallId
   */
  _destroyDoorMeshes(wallId) {
    const meshSet = this.doorMeshes.get(wallId);
    if (!meshSet) return;
    
    for (const doorMesh of meshSet) {
      doorMesh.dispose();
    }
    
    this.doorMeshes.delete(wallId);
    log.debug(`Destroyed door meshes for wall ${wallId}`);
  }
  
  /**
   * Update all door animations (called each frame)
   * @param {Object} timeInfo - Time info from TimeManager
   */
  update(timeInfo) {
    this._updateGlobalTint();
    for (const meshSet of this.doorMeshes.values()) {
      for (const doorMesh of meshSet) {
        doorMesh.update(timeInfo.elapsed);
      }
    }
  }

  _updateGlobalTint() {
    if (!this._globalTint || !this._daylightTint || !this._darknessTint || !this._ambientTint || !this._skyTint) return;

    const THREE = window.THREE;
    if (!THREE) return;

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

        const setThreeColor = (target, src, def) => {
          try {
            if (!src) { target.set(def); return target; }
            if (src instanceof THREE.Color) { target.copy(src); return target; }
            if (src.rgb) { target.setRGB(src.rgb[0], src.rgb[1], src.rgb[2]); return target; }
            if (Array.isArray(src)) { target.setRGB(src[0], src[1], src[2]); return target; }
            target.set(src); return target;
          } catch (e) { target.set(def); return target; }
        };

        const daylight = setThreeColor(this._daylightTint, env?.colors?.ambientDaylight, 0xffffff);
        const darknessColor = setThreeColor(this._darknessTint, env?.colors?.ambientDarkness, 0x242448);

        this._ambientTint.copy(daylight).lerp(darknessColor, darkness);

        const lightLevel = Math.max(1.0 - darkness, 0.25);
        globalTint.copy(this._ambientTint).multiplyScalar(lightLevel);

        // Apply time-of-day / sky color cast.
        // WeatherController is the single source of truth for these environmental outputs.
        // We blend (not multiply) to avoid crushing brightness.
        try {
          const envState = weatherController?.getEnvironment?.();
          const skyColor = envState?.skyColor;
          const skyIntensity = Number.isFinite(envState?.skyIntensity) ? envState.skyIntensity : 1.0;
          if (skyColor && typeof skyColor.copy === 'function') {
            // Keep the influence subtle: maximum 35% blend, scaled by skyIntensity.
            const skyBlend = Math.max(0.0, Math.min(0.35, 0.35 * skyIntensity));
            this._skyTint.copy(skyColor);
            globalTint.lerp(this._skyTint, skyBlend);
          }
        } catch (_) {
        }
      }
    } catch (_) {
    }

    const tr = Math.max(0, Math.min(255, (globalTint.r * 255 + 0.5) | 0));
    const tg = Math.max(0, Math.min(255, (globalTint.g * 255 + 0.5) | 0));
    const tb = Math.max(0, Math.min(255, (globalTint.b * 255 + 0.5) | 0));
    const tintKey = (tr << 16) | (tg << 8) | tb;

    if (tintKey === this._lastTintKey) return;
    this._lastTintKey = tintKey;

    for (const meshSet of this.doorMeshes.values()) {
      for (const doorMesh of meshSet) {
        doorMesh.setGlobalTint(globalTint);
      }
    }
  }
  
  /**
   * Dispose of all resources
   */
  dispose() {
    // Dispose all door meshes
    for (const [wallId, meshSet] of this.doorMeshes) {
      for (const doorMesh of meshSet) {
        doorMesh.dispose();
      }
    }
    this.doorMeshes.clear();
    
    // Dispose cached textures
    for (const texture of this.textureCache.values()) {
      texture.dispose();
    }
    this.textureCache.clear();
    
    log.info('DoorMeshManager disposed');
  }
}
