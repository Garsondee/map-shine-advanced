/**
 * @fileoverview Utility to convert Foundry/PIXI geometry to Three.js geometry
 * Handles coordinate system transformation (Top-Left to Center)
 * @module vision/GeometryConverter
 */

import { createLogger } from '../core/log.js';

const log = createLogger('GeometryConverter');

export class GeometryConverter {
  /**
   * @param {number} sceneWidth - Width of the scene in pixels
   * @param {number} sceneHeight - Height of the scene in pixels
   */
  constructor(sceneWidth, sceneHeight) {
    this.halfWidth = sceneWidth / 2;
    this.halfHeight = sceneHeight / 2;
    
    // Locate earcut
    this.earcut = PIXI.utils.earcut;
    if (!this.earcut) {
      log.warn('PIXI.utils.earcut not found, falling back to canvas.app.renderer.plugins.extract.earcut or global earcut');
      // Fallbacks if PIXI API changes
      this.earcut = window.earcut || (canvas?.app?.renderer?.plugins?.extract?.earcut);
    }
    
    if (!this.earcut) {
      log.error('Critical: earcut triangulation library not found!');
    }
  }

  /**
   * Update scene dimensions if they change
   * @param {number} width 
   * @param {number} height 
   */
  resize(width, height) {
    this.halfWidth = width / 2;
    this.halfHeight = height / 2;
  }

  /**
   * Converts a flat array of PIXI points [x0, y0, x1, y1...] to Three.js BufferGeometry
   * @param {number[]} points - Flat array of x,y coordinates from PIXI.Polygon
   * @returns {THREE.BufferGeometry} Triangulated geometry
   */
  toBufferGeometry(points) {
    if (!points || points.length < 6) { // Need at least 3 points (6 coords)
      return new window.THREE.BufferGeometry();
    }

    // 1. Triangulate using original 2D points (earcut works on 2D)
    // earcut(data, holeIndices, dim) -> returns array of indices
    let indices;
    try {
      indices = this.earcut(points);
    } catch (e) {
      log.error('Triangulation failed', e);
      return new window.THREE.BufferGeometry();
    }

    // 2. Transform Coordinates to Three.js World Space
    const vertices = new Float32Array((points.length / 2) * 3);
    
    for (let i = 0; i < points.length; i += 2) {
      // Foundry (0,0 is Top-Left) -> Three.js (0,0 is Center)
      const x = points[i] - this.halfWidth;
      const y = -(points[i+1] - this.halfHeight); // Invert Y
      
      const vertIndex = (i / 2) * 3;
      vertices[vertIndex] = x;
      vertices[vertIndex + 1] = y;
      vertices[vertIndex + 2] = 0; // Z is flat
    }

    // 3. Build Geometry
    const geometry = new window.THREE.BufferGeometry();
    geometry.setAttribute('position', new window.THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    
    return geometry;
  }
}
