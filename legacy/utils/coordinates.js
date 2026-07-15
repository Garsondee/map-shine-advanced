/**
 * @fileoverview Centralized coordinate transformation utility
 * Unifies mapping between Foundry VTT (2D, Top-Left Origin, Y-Down) 
 * and THREE.js (3D, Y-Up, but mapped to match)
 * @module utils/coordinates
 */

const Coordinates = {
  /**
   * Convert Foundry coordinates to THREE.js World coordinates
   * Foundry: (0,0) at Top-Left, +Y Down
   * THREE: (0,0) at Bottom-Left of the bounds (assuming we map 0->H), +Y Up
   * 
   * @param {number} x - Foundry X
   * @param {number} y - Foundry Y
   * @returns {THREE.Vector3} THREE.js Vector3 (z=0)
   */
  toWorld(x, y) {
    if (!canvas || !canvas.dimensions) return new THREE.Vector3(x, y, 0);
    const h = canvas.dimensions.height;
    // DEBUG: Log conversion
    // console.log(`toWorld: (${x}, ${y}) -> (${x}, ${h - y}, 0) [h=${h}]`);
    return new THREE.Vector3(x, h - y, 0);
  },

  /**
   * Convert THREE.js World coordinates to Foundry coordinates
   * @param {number} x - World X
   * @param {number} y - World Y
   * @returns {{x: number, y: number}} Foundry Point
   */
  toFoundry(x, y) {
    if (!canvas || !canvas.dimensions) return { x, y };
    const h = canvas.dimensions.height;
    const fx = x;
    const fy = h - y;
    // DEBUG: Log conversion
    // console.log(`toFoundry: (${x}, ${y}) -> (${fx}, ${fy}) [h=${h}]`);
    return { x: fx, y: fy };
  },

  /**
   * Transform a length/size (Y axis only)
   * Since Y is inverted, delta Y is inverted.
   * But size is absolute.
   * If we move +10 in Foundry Y, we move -10 in World Y.
   */
  transformY(y) {
    return -y;
  }
};

// Expose globally for debugging
window.MapShine = window.MapShine || {};
window.MapShine.Coordinates = Coordinates;

export default Coordinates;
