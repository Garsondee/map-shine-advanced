/**
 * @fileoverview Abstraction layer for Game System specific logic
 * Centralizes all system-specific checks (PF2e, DnD5e, etc.)
 * @module core/game-system
 */

import { createLogger } from './log.js';

const log = createLogger('GameSystem');

/**
 * Manager for handling system-specific quirks and data paths
 */
export class GameSystemManager {
  constructor() {
    this.systemId = game?.system?.id || 'unknown';
    this.isInitialized = false;
    
    log.info(`Initialized for system: ${this.systemId}`);
  }

  /**
   * Initialize system-specific hooks or data
   */
  initialize() {
    this.isInitialized = true;
  }

  /**
   * Check if current system is Pathfinder 2e
   * @returns {boolean}
   */
  isPF2e() {
    return this.systemId === 'pf2e';
  }

  /**
   * Check if current system is DnD 5e
   * @returns {boolean}
   */
  isDnD5e() {
    return this.systemId === 'dnd5e';
  }

  /**
   * Determine if a token has vision enabled
   * @param {Token|TokenDocument} object - The token or its document
   * @returns {boolean}
   */
  hasTokenVision(object) {
    if (!object) return false;

    // Handle Token vs TokenDocument
    const doc = object.document || object;
    
    // 1. Standard Foundry Check
    if (doc.sight?.enabled || doc.sight?.range > 0) return true;

    // 2. PF2e Specifics
    if (this.isPF2e()) {
      const actor = object.actor;
      if (actor) {
        // PF2e actors often store vision flags in system data
        // If 'vision' is explicitly true in perception, they have sight
        if (actor.system?.perception?.vision === true) return true;
        
        // Check for senses (Darkvision, Low-light vision) which might imply sight
        const senses = actor.system?.traits?.senses;
        if (Array.isArray(senses) && senses.length > 0) return true;
      }
    }

    // 3. Fallback to basic 'hasSight' property if available
    if (object.hasSight) return true;

    return false;
  }

  /**
   * Get the effective vision radius for a token in scene units (not pixels yet)
   * @param {Token} token - The token instance
   * @returns {number} Radius in distance units (e.g. feet/meters), 0 if no vision
   */
  getTokenVisionRadius(token) {
    if (!token) return 0;
    
    const doc = token.document;
    
    // 1. Prefer explicit Foundry sight range if set and > 0
    // This covers cases where a user manually overrides vision on a token
    const docRange = doc.sight?.range;
    if (typeof docRange === 'number' && docRange > 0) {
      return docRange;
    }

    // 2. PF2e Specific Logic
    if (this.isPF2e()) {
      // In PF2e, "normal vision" means you can see in bright light with no range limit.
      // The vision is only limited by walls and the scene boundaries.
      // We use a large radius that will effectively cover any battlemap.
      // 
      // Special senses like Darkvision 60ft would have explicit ranges, but
      // normal vision in bright areas is unlimited.
      
      const actor = token.actor;
      if (actor) {
        if (actor.system?.perception?.vision === true) {
          // Normal vision = effectively unlimited in bright light
          // 10000 units covers even the largest battlemaps (50000+ ft at 5ft/unit)
          return 10000;
        }
        
        // Check for specific senses with ranges (darkvision, etc.)
        const senses = actor.system?.perception?.senses;
        if (Array.isArray(senses) && senses.length > 0) {
          // Find the maximum range from all senses
          let maxRange = 0;
          for (const sense of senses) {
            // PF2e senses can have a 'range' property
            if (sense.range && sense.range > maxRange) {
              maxRange = sense.range;
            }
          }
          // If we found specific ranges, use the max; otherwise default to unlimited
          return maxRange > 0 ? maxRange : 10000;
        }
      }
    }

    // 3. Dnd5e Specific Logic
    if (this.isDnD5e()) {
       const actor = token.actor;
       if (actor?.system?.attributes?.senses) {
          const senses = actor.system.attributes.senses;
          // return max of darkvision, blindsight, etc.
          return Math.max(senses.darkvision || 0, senses.blindsight || 0, senses.tremorsense || 0, senses.truesight || 0);
       }
    }

    // 4. Fallback
    // If we still have 0, check if 'hasSight' is true. 
    // If Foundry says hasSight=true but range=0, it effectively means "Universal Light" rules often apply,
    // or it's an "unlimited" vision token.
    if (token.hasSight) {
        return 1000; // Default "Infinite"
    }

    return 0;
  }

  /**
   * Convert distance units to pixels for the current scene
   * @param {number} distance 
   * @returns {number} pixels
   */
  distanceToPixels(distance) {
    if (!canvas || !canvas.dimensions) return 0;
    return (distance / canvas.dimensions.distance) * canvas.dimensions.size;
  }
}
