/**
 * @fileoverview Wall manager - syncs Foundry walls to THREE.js
 * Handles creation, updates, and deletion of wall objects for lighting/collision
 * @module scene/wall-manager
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('WallManager');

// Foundry Wall Colors (Approximated)
const WALL_COLORS = {
  NORMAL: 0xf5f5dc, // Cream
  TERRAIN: 0x88ff88, // Light Green
  INVISIBLE: 0x88ccff, // Light Blue/Cyan
  ETHEREAL: 0xaa88ff, // Light Purple
  DOOR: 0x5555ff, // Blue
  SECRET: 0xaa00aa, // Dark Purple
  LOCKED: 0xff4444 // Red
};

/**
 * WallManager - Synchronizes Foundry VTT walls to THREE.js
 * Renders walls as 3D lines and endpoints
 */
export class WallManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene
   */
  constructor(scene) {
    this.scene = scene;
    
    /** @type {Map<string, THREE.Object3D>} */
    this.walls = new Map();
    
    this.initialized = false;
    
    // Group for all wall objects
    this.wallGroup = new THREE.Group();
    this.wallGroup.name = 'Walls';
    
    // Z-index for walls (raised to avoid z-fighting with ground/grid)
    this.wallGroup.position.z = 3.0; 
    
    this.scene.add(this.wallGroup);
    
    // Reusable geometry for endpoints
    this.endpointGeometry = new THREE.CircleGeometry(4, 8); // Radius 4px
    
    log.debug('WallManager created');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) return;

    this.setupHooks();
    this.syncAllWalls();
    
    this.initialized = true;
    log.info('WallManager initialized');
  }

  /**
   * Setup Foundry hooks for wall updates
   * @private
   */
  setupHooks() {
    Hooks.on('createWall', (doc) => this.create(doc));
    Hooks.on('updateWall', (doc, changes) => this.update(doc, changes));
    Hooks.on('deleteWall', (doc) => this.remove(doc.id));
    Hooks.on('renderSceneControls', () => this.updateVisibility());
  }

  /**
   * Update visibility of wall lines based on active layer
   * Door handles remain visible
   */
  updateVisibility() {
    const showLines = canvas.walls?.active ?? false;
    
    this.walls.forEach(group => {
      group.children.forEach(child => {
        // Skip door controls (they stay visible)
        if (child.userData.type === 'doorControl') return;
        
        // Toggle lines and endpoints
        child.visible = showLines;
      });
    });
  }

  /**
   * Sync all existing walls from the scene
   * @public
   */
  syncAllWalls() {
    if (!canvas.walls) return;
    
    log.info(`Syncing ${canvas.walls.placeables.length} walls...`);
    
    // Clear existing
    this.walls.forEach(wall => {
      this.wallGroup.remove(wall);
    });
    this.walls.clear();
    
    // Add current
    canvas.walls.placeables.forEach(wall => {
      this.create(wall.document);
    });
  }

  /**
   * Create a wall in the THREE.js scene
   * @param {WallDocument} doc - Foundry wall document
   * @param {Object} [dataOverride={}] - Optional data to override document properties (e.g. pending changes)
   */
  create(doc, dataOverride = {}) {
    if (this.walls.has(doc.id)) return;

    const group = new THREE.Group();
    group.userData = { wallId: doc.id };

    // Check if lines should be visible (active layer)
    const showLines = canvas.walls?.active ?? false;

    // Get Coordinates
    const c = dataOverride.c || doc.c;
    const [x0, y0, x1, y1] = c;
    
    const start = Coordinates.toWorld(x0, y0);
    const end = Coordinates.toWorld(x1, y1);

    // Determine Color based on properties
    const color = this.getWallColor(doc, dataOverride);
    
    // Create Line
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
        start,
        end
    ]);

    const material = new THREE.LineBasicMaterial({ 
        color: color,
        linewidth: 2
    });
    
    const line = new THREE.Line(lineGeometry, material);
    line.visible = showLines;
    group.add(line);

    // Create Endpoints (Circles)
    const dotMat = new THREE.MeshBasicMaterial({ color: color });
    
    const p0 = new THREE.Mesh(this.endpointGeometry, dotMat);
    p0.position.copy(start);
    p0.userData = { type: 'wallEndpoint', wallId: doc.id, index: 0 };
    p0.visible = showLines;
    group.add(p0);
    
    const p1 = new THREE.Mesh(this.endpointGeometry, dotMat);
    p1.position.copy(end);
    p1.userData = { type: 'wallEndpoint', wallId: doc.id, index: 1 };
    p1.visible = showLines;
    group.add(p1);
    
    // Door Icon
    const doorType = dataOverride.door !== undefined ? dataOverride.door : doc.door;
    if (doorType > 0) {
        this.createDoorControl(group, doc, start, end, dataOverride);
    }

    this.wallGroup.add(group);
    this.walls.set(doc.id, group);
    
    log.debug(`Rendered wall ${doc.id}`);
  }

  /**
   * Create Door Control Icon
   * @param {THREE.Group} group 
   * @param {WallDocument} doc 
   * @param {THREE.Vector3} start 
   * @param {THREE.Vector3} end 
   * @param {Object} [dataOverride={}]
   */
  createDoorControl(group, doc, start, end, dataOverride = {}) {
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      
      // Door Group
      const doorGroup = new THREE.Group();
      doorGroup.position.set(midX, midY, 0.1); // Slightly above wall line
      doorGroup.userData = { type: 'doorControl', wallId: doc.id };
      
      // Background (Rounded Rect approx)
      // 40x40 canvas units -> converted to world units?
      // Canvas grid size is usually 100px. Icons are fixed size.
      // Foundry uses 40px * uiScale.
      // In THREE, we are in world pixels (usually).
      const size = 40 * (canvas.dimensions.uiScale || 1);
      
      const bgGeo = new THREE.PlaneGeometry(size + 4, size + 4);
      const bgMat = new THREE.MeshBasicMaterial({ 
          color: 0x000000,
          transparent: true,
          opacity: 0.0, // Only visible on hover? Foundry says alpha=0 usually, 0.25 on hover.
          side: THREE.DoubleSide
      });
      const bg = new THREE.Mesh(bgGeo, bgMat);
      doorGroup.add(bg);
      
      // Icon Sprite
      const iconPath = this.getDoorIconPath(doc, dataOverride);
      // Debug state
      const ds = dataOverride.ds !== undefined ? dataOverride.ds : doc.ds;
      log.debug(`Wall ${doc.id} Door State: ${ds} (${typeof ds}), Icon: ${iconPath}`);

      const loader = new THREE.TextureLoader();
      
      // Use a Sprite for the icon so it always faces camera (if we were 3D) 
      // but in 2.5D top-down, a Plane is fine too. Sprite is easier for icons.
      // Actually, sprites always face camera. Planes align with ground.
      // If we want it "flat on the map" (like Foundry), use Plane.
      // Foundry's icons are mostly flat.
      const iconGeo = new THREE.PlaneGeometry(size, size);
      const iconMat = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0.8,
          color: 0xffffff
      });
      
      // Add timestamp to bypass cache if state stuck? 
      // Or maybe texture is fine but material isn't updating?
      // Let's try simple load.
      loader.load(iconPath, (tex) => {
          iconMat.map = tex;
          iconMat.needsUpdate = true;
      });
      
      const icon = new THREE.Mesh(iconGeo, iconMat);
      // icon.position.z = 0.1;
      doorGroup.add(icon);

      // Store references for updates
      doorGroup.userData.bg = bg;
      doorGroup.userData.icon = icon;
      
      group.add(doorGroup);
  }

  /**
   * Get the correct icon path for the door state
   * @param {WallDocument} doc 
   * @param {Object} [dataOverride={}]
   * @returns {string}
   */
  getDoorIconPath(doc, dataOverride = {}) {
      const ds = dataOverride.ds !== undefined ? dataOverride.ds : doc.ds; // 0=CLOSED, 1=OPEN, 2=LOCKED
      const type = dataOverride.door !== undefined ? dataOverride.door : doc.door; // 1=DOOR, 2=SECRET
      
      // Config defaults
      const icons = CONFIG.controlIcons;
      
      if (type === 2 && ds === 0) { // Secret & Closed
          return icons.doorSecret;
      }
      
      if (ds === 2) return icons.doorLocked;
      if (ds === 1) return icons.doorOpen;
      return icons.doorClosed;
  }

  /**
   * Determine wall color based on type
   * @param {WallDocument} doc 
   * @param {Object} [dataOverride={}]
   * @returns {number} Hex color
   */
  getWallColor(doc, dataOverride = {}) {
      // Logic based on Foundry's Wall class
      const door = dataOverride.door !== undefined ? dataOverride.door : doc.door;
      const move = dataOverride.move !== undefined ? dataOverride.move : doc.move;
      const sight = dataOverride.sight !== undefined ? dataOverride.sight : doc.sight;

      if (door === 1) return WALL_COLORS.DOOR;
      if (door === 2) return WALL_COLORS.SECRET;
      
      // Sense types: 0=NONE, 10=LIMITED, 20=NORMAL (approx consts)
      
      if (move === 0) return WALL_COLORS.ETHEREAL; // Passable
      if (sight === 0) return WALL_COLORS.INVISIBLE; // See-through
      if (sight === 10 || move === 10) return WALL_COLORS.TERRAIN; // Terrain
      
      return WALL_COLORS.NORMAL;
  }

  /**
   * Update an existing wall
   * @param {WallDocument} doc - Foundry wall document
   * @param {Object} changes - Changed data
   */
  update(doc, changes) {
    log.debug(`WallManager.update called for ${doc.id}`, changes);
    
    // Rebuild geometry if coordinates, type, or state changed
    // Check for undefined because 0 is a valid value for ds, move, sight
    const shouldUpdate = 
      changes.c || 
      changes.door !== undefined || 
      changes.ds !== undefined || 
      changes.move !== undefined || 
      changes.sight !== undefined || 
      changes.light !== undefined || 
      changes.sound !== undefined;

    if (shouldUpdate) {
      log.debug(`WallManager.update: Recreating wall ${doc.id}`);
      this.remove(doc.id);
      this.create(doc, changes);
    } else {
      log.debug(`WallManager.update: Update skipped for ${doc.id} (no relevant changes)`);
    }
  }

  /**
   * Highlight a wall
   * @param {string} id 
   * @param {boolean} active 
   */
  setHighlight(id, active) {
      const group = this.walls.get(id);
      if (!group) return;
      
      const line = group.children.find(c => c.type === 'Line');
      if (line) {
          if (active) {
             line.material.color.setHex(0xff9829); // Orange highlight
             line.material.linewidth = 4;
             // Note: linewidth only works in WebGL1 usually, usually need separate thick line mesh for WebGL2
             // For now, let's assume color change is enough feedback
          } else {
             const doc = canvas.walls.get(id)?.document;
             if (doc) {
                 line.material.color.setHex(this.getWallColor(doc));
                 line.material.linewidth = 2;
             }
          }
          line.material.needsUpdate = true;
      }
      
      // Highlight endpoints too?
      group.children.forEach(c => {
          if (c.userData.type === 'wallEndpoint') {
              c.material.color.setHex(active ? 0xff9829 : this.getWallColor(canvas.walls.get(id).document));
          }
      });
  }

  /**
   * Remove a wall
   * @param {string} id - Wall ID
   */
  remove(id) {
    const group = this.walls.get(id);
    if (group) {
      this.wallGroup.remove(group);
      
      // Cleanup geometry/material to prevent leaks
      group.traverse(obj => {
          if (obj.geometry && obj.geometry !== this.endpointGeometry) obj.geometry.dispose();
          if (obj.material) obj.material.dispose();
      });
      
      this.walls.delete(id);
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.walls.forEach((group, id) => this.remove(id));
    this.walls.clear();
    this.scene.remove(this.wallGroup);
    if (this.endpointGeometry) this.endpointGeometry.dispose();
    log.debug('WallManager disposed');
  }
}
