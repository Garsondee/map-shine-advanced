/**
 * @fileoverview Centralized resource registry for GPU resources
 * Tracks and manages disposal of render targets, textures, and materials
 * Prevents leaks during scene transitions and module reloads
 * @module core/resource-registry
 */

import { createLogger } from './log.js';

const log = createLogger('ResourceRegistry');

/**
 * Resource types for tracking and categorization
 */
export const RESOURCE_TYPES = {
  RENDER_TARGET: 'renderTarget',
  TEXTURE: 'texture',
  MATERIAL: 'material',
  GEOMETRY: 'geometry',
  PROGRAM: 'program',
  OTHER: 'other'
};

/**
 * Centralized registry for GPU resources
 * Enables coordinated disposal and leak prevention
 */
export class ResourceRegistry {
  constructor() {
    /** @type {Map<string, Object>} - Registry of resources by ID */
    this.resources = new Map();

    /** @type {Map<string, Set<string>>} - Resources grouped by owner/effect */
    this.ownerMap = new Map();

    /** @type {number} - Counter for auto-generated IDs */
    this._idCounter = 0;

    log.info('ResourceRegistry created');
  }

  /**
   * Register a GPU resource
   * @param {Object} resource - Resource to register (THREE.RenderTarget, THREE.Texture, etc.)
   * @param {string} type - Resource type (from RESOURCE_TYPES)
   * @param {string} [owner] - Owner identifier (effect ID, manager name, etc.)
   * @param {string} [name] - Human-readable name for debugging
   * @returns {string} Unique resource ID
   */
  register(resource, type, owner = null, name = null) {
    if (!resource) {
      log.warn('register: resource is null/undefined');
      return null;
    }

    const id = `res_${++this._idCounter}`;
    const entry = {
      id,
      resource,
      type,
      owner,
      name: name || `${type}_${id}`,
      registeredAt: Date.now(),
      disposed: false
    };

    this.resources.set(id, entry);

    // Track by owner for bulk disposal
    if (owner) {
      if (!this.ownerMap.has(owner)) {
        this.ownerMap.set(owner, new Set());
      }
      this.ownerMap.get(owner).add(id);
    }

    log.debug(`Registered ${type}: ${entry.name} (owner: ${owner || 'none'})`);
    return id;
  }

  /**
   * Unregister and dispose a single resource
   * @param {string} resourceId - Resource ID to dispose
   * @returns {boolean} Whether disposal succeeded
   */
  dispose(resourceId) {
    const entry = this.resources.get(resourceId);
    if (!entry) {
      log.warn(`dispose: resource not found: ${resourceId}`);
      return false;
    }

    if (entry.disposed) {
      log.debug(`dispose: resource already disposed: ${resourceId}`);
      return true;
    }

    try {
      const { resource, type, name } = entry;

      // Call appropriate disposal method based on type
      if (typeof resource.dispose === 'function') {
        resource.dispose();
      }

      entry.disposed = true;
      log.debug(`Disposed ${type}: ${name}`);
      return true;
    } catch (e) {
      log.error(`Error disposing resource ${resourceId}:`, e);
      entry.disposed = true;
      return false;
    }
  }

  /**
   * Dispose all resources owned by a specific owner
   * @param {string} owner - Owner identifier
   * @returns {number} Number of resources disposed
   */
  disposeByOwner(owner) {
    const resourceIds = this.ownerMap.get(owner);
    if (!resourceIds) {
      log.debug(`disposeByOwner: no resources for owner: ${owner}`);
      return 0;
    }

    let count = 0;
    for (const id of resourceIds) {
      if (this.dispose(id)) {
        count++;
      }
    }

    this.ownerMap.delete(owner);
    log.info(`Disposed ${count} resources for owner: ${owner}`);
    return count;
  }

  /**
   * Dispose all resources of a specific type
   * @param {string} type - Resource type (from RESOURCE_TYPES)
   * @returns {number} Number of resources disposed
   */
  disposeByType(type) {
    let count = 0;
    for (const [id, entry] of this.resources.entries()) {
      if (entry.type === type && !entry.disposed) {
        if (this.dispose(id)) {
          count++;
        }
      }
    }

    log.info(`Disposed ${count} resources of type: ${type}`);
    return count;
  }

  /**
   * Dispose all registered resources
   * @returns {number} Total number of resources disposed
   */
  disposeAll() {
    let count = 0;
    for (const id of this.resources.keys()) {
      if (this.dispose(id)) {
        count++;
      }
    }

    this.ownerMap.clear();
    log.info(`Disposed all ${count} registered resources`);
    return count;
  }

  /**
   * Get resource entry by ID
   * @param {string} resourceId - Resource ID
   * @returns {Object|null} Resource entry or null
   */
  get(resourceId) {
    return this.resources.get(resourceId) || null;
  }

  /**
   * Get all resources owned by a specific owner
   * @param {string} owner - Owner identifier
   * @returns {Object[]} Array of resource entries
   */
  getByOwner(owner) {
    const resourceIds = this.ownerMap.get(owner);
    if (!resourceIds) return [];

    return Array.from(resourceIds)
      .map(id => this.resources.get(id))
      .filter(entry => entry && !entry.disposed);
  }

  /**
   * Get all resources of a specific type
   * @param {string} type - Resource type
   * @returns {Object[]} Array of resource entries
   */
  getByType(type) {
    const result = [];
    for (const entry of this.resources.values()) {
      if (entry.type === type && !entry.disposed) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * Get registry statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    const stats = {
      totalRegistered: this.resources.size,
      disposed: 0,
      active: 0,
      byType: {},
      byOwner: {}
    };

    for (const entry of this.resources.values()) {
      if (entry.disposed) {
        stats.disposed++;
      } else {
        stats.active++;
        stats.byType[entry.type] = (stats.byType[entry.type] || 0) + 1;
        if (entry.owner) {
          stats.byOwner[entry.owner] = (stats.byOwner[entry.owner] || 0) + 1;
        }
      }
    }

    return stats;
  }

  /**
   * Log registry statistics for debugging
   */
  logStats() {
    const stats = this.getStats();
    log.info('ResourceRegistry stats:', stats);
  }

  /**
   * Clear registry (for testing or hard reset)
   * WARNING: Does NOT dispose resources, only clears tracking
   */
  clear() {
    this.resources.clear();
    this.ownerMap.clear();
    log.warn('ResourceRegistry cleared (resources NOT disposed)');
  }
}

/**
 * Global singleton instance
 * @type {ResourceRegistry|null}
 */
let globalRegistry = null;

/**
 * Get or create the global resource registry
 * @returns {ResourceRegistry} Global registry instance
 */
export function getGlobalResourceRegistry() {
  if (!globalRegistry) {
    globalRegistry = new ResourceRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global registry (for testing)
 */
export function resetGlobalResourceRegistry() {
  if (globalRegistry) {
    globalRegistry.disposeAll();
  }
  globalRegistry = null;
}
