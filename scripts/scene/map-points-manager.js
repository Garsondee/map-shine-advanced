/**
 * @fileoverview Map Points Manager - Manages point groups for effects
 * Provides backwards compatibility with v1.x map-shine flag data
 * @module scene/map-points-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('MapPointsManager');

/** Module ID for flag access (current module) */
const MODULE_ID = 'map-shine-advanced';

/** Legacy module ID for v1.x backwards compatibility */
const LEGACY_MODULE_ID = 'map-shine';

/** Current data version for migration tracking */
const CURRENT_VERSION = 2;

/**
 * Effect target options - maps effect keys to display names
 * Must remain backwards compatible with v1.x
 */
export const EFFECT_SOURCE_OPTIONS = {
  '': 'None',
  sparks: 'Sparks',
  fire: 'Fire Particles',
  candleFlame: 'Candle Flame',
  dust: 'Dust Motes',
  smellyFlies: 'Smelly Flies',
  lightning: 'Lightning',
  cloudShadows: 'Cloud Shadows',
  canopy: 'Canopy Shadows',
  structuralShadows: 'Structural Shadows',
  water: 'Water Surface',
  pressurisedSteam: 'Pressurised Steam'
};

/**
 * @typedef {Object} MapPoint
 * @property {number} x - X coordinate in scene space
 * @property {number} y - Y coordinate in scene space
 */

/**
 * @typedef {Object} EmissionSettings
 * @property {number} intensity - Emission intensity (0-1)
 * @property {Object} falloff - Falloff settings
 * @property {boolean} falloff.enabled - Whether falloff is enabled
 * @property {number} falloff.strength - Falloff strength
 */

/**
 * @typedef {Object} MapPointGroup
 * @property {string} id - Unique identifier
 * @property {string} label - Display name
 * @property {'point'|'line'|'area'|'rope'} type - Group type
 * @property {MapPoint[]} points - Array of points
 * @property {boolean} isBroken - Validation state
 * @property {string} reason - Validation message
 * @property {boolean} isEffectSource - Whether this group drives an effect
 * @property {string} effectTarget - Effect key (e.g., 'lightning', 'candleFlame')
 * @property {EmissionSettings} emission - Emission settings
 * @property {number} [version] - Data version for migration
 * @property {Object} [metadata] - Additional metadata
 * @property {string} [ropeType] - Rope preset type (for rope groups)
 * @property {string} [texturePath] - Custom texture path (for rope groups)
 * @property {number} [segmentLength] - Rope segment length
 */

/**
 * MapPointsManager - Manages map point groups for the Three.js rendering system
 * Provides backwards compatibility with v1.x data stored in scene flags
 */
export class MapPointsManager {
  /**
   * @param {THREE.Scene} scene - Three.js scene to add visual elements to
   */
  constructor(scene) {
    /** @type {THREE.Scene} */
    this.scene = scene;
    
    /** @type {Map<string, MapPointGroup>} */
    this.groups = new Map();
    
    /** @type {Map<string, THREE.Object3D>} */
    this.visualObjects = new Map();
    
    /** @type {boolean} */
    this.initialized = false;
    
    /** @type {boolean} */
    this.showVisualHelpers = false;
    
    /** @type {Function[]} */
    this.changeListeners = [];
    
    log.debug('MapPointsManager created');
  }

  /**
   * Initialize the manager and load groups from scene flags
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      log.warn('MapPointsManager already initialized');
      return;
    }

    // Load groups from scene flags
    await this.loadFromScene();
    
    // Register Foundry hooks for updates
    this.setupHooks();
    
    this.initialized = true;
    log.info(`MapPointsManager initialized with ${this.groups.size} groups`);
  }

  /**
   * Load map point groups from the current scene's flags
   * Handles migration from v1.x format if needed
   * Checks both current and legacy module namespaces for backwards compatibility
   * @private
   */
  async loadFromScene() {
    const scene = canvas?.scene;
    if (!scene) {
      log.warn('No active scene, skipping map points load');
      return;
    }

    // Try to get groups from scene flags
    // First check current module namespace, then fall back to legacy v1.x namespace
    let groupsData = null;
    let fromLegacy = false;
    
    try {
      groupsData = scene.getFlag(MODULE_ID, 'mapPointGroups');
    } catch (e) {
      // Flag namespace not registered, this is fine
      log.debug('Current module flag namespace not available');
    }
    
    // If not found in current namespace, try legacy namespace
    if (!groupsData) {
      try {
        groupsData = scene.getFlag(LEGACY_MODULE_ID, 'mapPointGroups');
        if (groupsData) {
          fromLegacy = true;
          log.info('Found map point groups in legacy namespace, will migrate');
        }
      } catch (e) {
        // Legacy namespace not available either, this is fine
        log.debug('Legacy module flag namespace not available');
      }
    }
    
    if (!groupsData) {
      log.debug('No map point groups found in scene flags');
      return;
    }

    // Convert object to Map and migrate if needed
    let needsMigration = false;
    
    for (const [id, group] of Object.entries(groupsData)) {
      const migratedGroup = this.migrateGroup(group);
      if (migratedGroup.version !== group.version) {
        needsMigration = true;
      }
      this.groups.set(id, migratedGroup);
    }

    // Save migrated data to current namespace if migrating from legacy or version changed
    if (needsMigration || fromLegacy) {
      log.info(`Migrating map point groups to v2 format${fromLegacy ? ' (from legacy namespace)' : ''}`);
      await this.saveToScene();
    }

    log.info(`Loaded ${this.groups.size} map point groups from scene${fromLegacy ? ' (from legacy)' : ''}`);
  }

  /**
   * Migrate a group from v1.x format to v2 format
   * @param {Object} group - Group data (possibly v1.x format)
   * @returns {MapPointGroup} Migrated group
   * @private
   */
  migrateGroup(group) {
    // Already v2+
    if (group.version >= CURRENT_VERSION) {
      return group;
    }

    // v1.x -> v2 migration
    return {
      // Preserve all existing properties
      ...group,
      
      // Add version tracking
      version: CURRENT_VERSION,
      
      // Add metadata container for future use
      metadata: group.metadata || {},
      
      // Ensure emission settings exist with defaults
      emission: group.emission || {
        intensity: 1.0,
        falloff: { enabled: false, strength: 0.5 }
      },
      
      // Ensure validation state exists
      isBroken: group.isBroken ?? false,
      reason: group.reason || '',
      
      // Ensure effect source settings exist
      isEffectSource: group.isEffectSource ?? false,
      effectTarget: group.effectTarget || ''
    };
  }

  /**
   * Save current groups to scene flags
   * @private
   */
  async saveToScene() {
    const scene = canvas?.scene;
    if (!scene) {
      log.warn('No active scene, cannot save map points');
      return;
    }

    // Convert Map to plain object for storage
    const groupsData = {};
    for (const [id, group] of this.groups) {
      groupsData[id] = group;
    }

    await scene.setFlag(MODULE_ID, 'mapPointGroups', groupsData);
    log.debug('Map point groups saved to scene');
  }

  /**
   * Setup Foundry hooks for reactive updates
   * @private
   */
  setupHooks() {
    // Listen for scene flag updates
    Hooks.on('updateScene', (scene, changes, options, userId) => {
      // Only process if this is the current scene
      if (scene.id !== canvas?.scene?.id) return;
      
      // Check if mapPointGroups flag was updated (in either namespace)
      const currentUpdated = changes.flags?.[MODULE_ID]?.mapPointGroups !== undefined;
      const legacyUpdated = changes.flags?.[LEGACY_MODULE_ID]?.mapPointGroups !== undefined;
      
      if (currentUpdated || legacyUpdated) {
        log.debug('Map point groups updated via scene flag');
        this.loadFromScene();
        this.notifyListeners();
      }
    });

    // Listen for canvas ready to reload groups
    Hooks.on('canvasReady', () => {
      this.groups.clear();
      this.clearVisualObjects();
      this.loadFromScene();
    });
  }

  /**
   * Get all groups
   * @returns {Map<string, MapPointGroup>}
   */
  getGroups() {
    return this.groups;
  }

  /**
   * Get a specific group by ID
   * @param {string} id - Group ID
   * @returns {MapPointGroup|undefined}
   */
  getGroup(id) {
    return this.groups.get(id);
  }

  /**
   * Get all groups that target a specific effect
   * @param {string} effectTarget - Effect key (e.g., 'fire', 'lightning')
   * @returns {MapPointGroup[]}
   */
  getGroupsByEffect(effectTarget) {
    const result = [];
    for (const group of this.groups.values()) {
      if (group.isEffectSource && group.effectTarget === effectTarget) {
        result.push(group);
      }
    }
    return result;
  }

  /**
   * Get all points for a specific effect, flattened from all matching groups
   * @param {string} effectTarget - Effect key
   * @returns {MapPoint[]}
   */
  getPointsForEffect(effectTarget) {
    const groups = this.getGroupsByEffect(effectTarget);
    const points = [];
    
    for (const group of groups) {
      if (group.points && Array.isArray(group.points)) {
        points.push(...group.points);
      }
    }
    
    return points;
  }

  /**
   * Get line segments for a specific effect (for line-type groups)
   * @param {string} effectTarget - Effect key
   * @returns {Array<{start: MapPoint, end: MapPoint}>}
   */
  getLinesForEffect(effectTarget) {
    const groups = this.getGroupsByEffect(effectTarget);
    const lines = [];
    
    for (const group of groups) {
      if (group.type !== 'line' || !group.points || group.points.length < 2) {
        continue;
      }
      
      // Create line segments from consecutive points
      for (let i = 0; i < group.points.length - 1; i++) {
        lines.push({
          start: group.points[i],
          end: group.points[i + 1],
          groupId: group.id,
          emission: group.emission
        });
      }
    }
    
    return lines;
  }

  /**
   * Get rope configurations for physics rope effect
   * @returns {Array<{group: MapPointGroup, points: MapPoint[]}>}
   */
  getRopeConfigurations() {
    const ropes = [];
    
    for (const group of this.groups.values()) {
      if (group.type === 'rope' && group.points && group.points.length >= 2) {
        ropes.push({
          group,
          points: group.points,
          ropeType: group.ropeType || 'chain',
          texturePath: group.texturePath,
          segmentLength: group.segmentLength || 20
        });
      }
    }
    
    return ropes;
  }

  /**
   * Create a new group
   * @param {Partial<MapPointGroup>} groupData - Initial group data
   * @returns {Promise<MapPointGroup>}
   */
  async createGroup(groupData) {
    const id = groupData.id || foundry.utils.randomID();
    
    const group = this.migrateGroup({
      id,
      label: groupData.label || 'New Group',
      type: groupData.type || 'point',
      points: groupData.points || [],
      isBroken: false,
      reason: '',
      isEffectSource: groupData.isEffectSource ?? false,
      effectTarget: groupData.effectTarget || '',
      emission: groupData.emission || {
        intensity: 1.0,
        falloff: { enabled: false, strength: 0.5 }
      },
      ...groupData
    });

    this.groups.set(id, group);
    await this.saveToScene();
    this.notifyListeners();
    
    log.info(`Created map point group: ${id} (${group.label})`);
    return group;
  }

  /**
   * Update an existing group
   * @param {string} id - Group ID
   * @param {Partial<MapPointGroup>} updates - Properties to update
   * @returns {Promise<MapPointGroup|null>}
   */
  async updateGroup(id, updates) {
    const group = this.groups.get(id);
    if (!group) {
      log.warn(`Cannot update non-existent group: ${id}`);
      return null;
    }

    // Merge updates
    const updatedGroup = { ...group, ...updates };
    this.groups.set(id, updatedGroup);
    
    await this.saveToScene();
    this.notifyListeners();
    
    log.debug(`Updated map point group: ${id}`);
    return updatedGroup;
  }

  /**
   * Delete a group
   * @param {string} id - Group ID
   * @returns {Promise<boolean>}
   */
  async deleteGroup(id) {
    if (!this.groups.has(id)) {
      log.warn(`Cannot delete non-existent group: ${id}`);
      return false;
    }

    this.groups.delete(id);
    this.removeVisualObject(id);
    
    await this.saveToScene();
    this.notifyListeners();
    
    log.info(`Deleted map point group: ${id}`);
    return true;
  }

  /**
   * Add a point to a group
   * @param {string} groupId - Group ID
   * @param {MapPoint} point - Point to add
   * @returns {Promise<boolean>}
   */
  async addPoint(groupId, point) {
    const group = this.groups.get(groupId);
    if (!group) {
      log.warn(`Cannot add point to non-existent group: ${groupId}`);
      return false;
    }

    group.points = group.points || [];
    group.points.push(point);
    
    await this.saveToScene();
    this.notifyListeners();
    
    return true;
  }

  /**
   * Remove a point from a group
   * @param {string} groupId - Group ID
   * @param {number} pointIndex - Index of point to remove
   * @returns {Promise<boolean>}
   */
  async removePoint(groupId, pointIndex) {
    const group = this.groups.get(groupId);
    if (!group || !group.points || pointIndex >= group.points.length) {
      return false;
    }

    group.points.splice(pointIndex, 1);
    
    await this.saveToScene();
    this.notifyListeners();
    
    return true;
  }

  /**
   * Register a change listener
   * @param {Function} callback - Callback function
   */
  addChangeListener(callback) {
    this.changeListeners.push(callback);
  }

  /**
   * Remove a change listener
   * @param {Function} callback - Callback function
   */
  removeChangeListener(callback) {
    const index = this.changeListeners.indexOf(callback);
    if (index >= 0) {
      this.changeListeners.splice(index, 1);
    }
  }

  /**
   * Notify all change listeners
   * @private
   */
  notifyListeners() {
    for (const callback of this.changeListeners) {
      try {
        callback(this.groups);
      } catch (e) {
        log.error('Error in change listener:', e);
      }
    }
  }

  /**
   * Toggle visual helper display
   * @param {boolean} show - Whether to show helpers
   */
  setShowVisualHelpers(show) {
    this.showVisualHelpers = show;
    
    if (show) {
      this.createVisualHelpers();
    } else {
      this.clearVisualObjects();
    }
  }

  /**
   * Create visual helper objects for all groups
   * @private
   */
  createVisualHelpers() {
    const THREE = window.THREE;
    if (!THREE) return;

    for (const [id, group] of this.groups) {
      this.createVisualHelper(id, group);
    }
  }

  /**
   * Create a visual helper for a single group
   * @param {string} id - Group ID
   * @param {MapPointGroup} group - Group data
   * @private
   */
  createVisualHelper(id, group) {
    const THREE = window.THREE;
    if (!THREE || !group.points || group.points.length === 0) return;

    // Remove existing helper
    this.removeVisualObject(id);

    // Choose color based on effect target
    const color = this.getEffectColor(group.effectTarget);
    
    if (group.type === 'point') {
      // Create point markers
      const geometry = new THREE.BufferGeometry();
      const positions = [];
      
      for (const point of group.points) {
        positions.push(point.x, point.y, 50); // Z=50 to render above map
      }
      
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      
      const material = new THREE.PointsMaterial({
        color,
        size: 20,
        sizeAttenuation: false,
        depthTest: false
      });
      
      const points = new THREE.Points(geometry, material);
      points.name = `MapPointHelper_${id}`;
      points.renderOrder = 1000;
      
      this.scene.add(points);
      this.visualObjects.set(id, points);
      
    } else if (group.type === 'line' || group.type === 'rope') {
      // Create line visualization
      const geometry = new THREE.BufferGeometry();
      const positions = [];
      
      for (const point of group.points) {
        positions.push(point.x, point.y, 50);
      }
      
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      
      const material = new THREE.LineBasicMaterial({
        color,
        linewidth: 2,
        depthTest: false
      });
      
      const line = new THREE.Line(geometry, material);
      line.name = `MapPointHelper_${id}`;
      line.renderOrder = 1000;
      
      this.scene.add(line);
      this.visualObjects.set(id, line);
      
    } else if (group.type === 'area') {
      // Create area outline (closed loop)
      if (group.points.length >= 3) {
        const geometry = new THREE.BufferGeometry();
        const positions = [];
        
        for (const point of group.points) {
          positions.push(point.x, point.y, 50);
        }
        // Close the loop
        positions.push(group.points[0].x, group.points[0].y, 50);
        
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        
        const material = new THREE.LineBasicMaterial({
          color,
          linewidth: 2,
          depthTest: false
        });
        
        const line = new THREE.LineLoop(geometry, material);
        line.name = `MapPointHelper_${id}`;
        line.renderOrder = 1000;
        
        this.scene.add(line);
        this.visualObjects.set(id, line);
      }
    }
  }

  /**
   * Get color for an effect type
   * @param {string} effectTarget - Effect key
   * @returns {number} Hex color
   * @private
   */
  getEffectColor(effectTarget) {
    const colors = {
      fire: 0xff4400,
      candleFlame: 0xffaa00,
      sparks: 0xffff00,
      lightning: 0x00aaff,
      dust: 0xaaaaaa,
      smellyFlies: 0x00ff00,
      water: 0x0066ff,
      pressurisedSteam: 0xcccccc,
      cloudShadows: 0x666666,
      canopy: 0x228822,
      structuralShadows: 0x444444
    };
    
    return colors[effectTarget] || 0xffffff;
  }

  /**
   * Remove a visual object
   * @param {string} id - Group ID
   * @private
   */
  removeVisualObject(id) {
    const obj = this.visualObjects.get(id);
    if (obj) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
      this.scene.remove(obj);
      this.visualObjects.delete(id);
    }
  }

  /**
   * Clear all visual objects
   * @private
   */
  clearVisualObjects() {
    for (const id of this.visualObjects.keys()) {
      this.removeVisualObject(id);
    }
  }

  /**
   * Dispose of all resources
   */
  dispose() {
    this.clearVisualObjects();
    this.groups.clear();
    this.changeListeners = [];
    this.initialized = false;
    
    log.info('MapPointsManager disposed');
  }
}
