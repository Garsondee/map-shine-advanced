/**
 * @fileoverview Grid renderer - renders the battlemap grid
 * Uses off-screen canvas to generate grid texture for performance
 * Supports Square and Hex grids based on Foundry settings
 * @module scene/grid-renderer
 */

import { createLogger } from '../core/log.js';

const log = createLogger('GridRenderer');

// Z-position for grid (just above ground, below tiles)
const GRID_Z = 2.0;

/**
 * GridRenderer - Renders the scene grid
 */
export class GridRenderer {
  /**
   * @param {THREE.Scene} scene - THREE.js scene
   */
  constructor(scene) {
    this.scene = scene;
    
    /** @type {THREE.Mesh|null} */
    this.gridMesh = null;
    
    /** @type {THREE.Texture|null} */
    this.gridTexture = null;
    
    // Grid settings
    this.settings = {
      style: 'solid', // solid, dashed, dotted
      thickness: 3.0,
      colorOverride: null, // Use null to use Foundry color
      alphaOverride: 0.1, // Use null to use Foundry alpha
      dashArray: []
    };

    this.initialized = false;
    this.hooksRegistered = false;
    
    log.debug('GridRenderer created');
  }

  /**
   * Get control schema for UI
   * @returns {Object} Tweakpane schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      parameters: {
        style: {
          label: 'Style',
          options: {
            'Solid': 'solid',
            'Dashed': 'dashed',
            'Dotted': 'dotted'
          },
          default: 'solid'
        },
        thickness: {
          label: 'Thickness',
          min: 0.5,
          max: 5.0,
          step: 0.5,
          default: 3.0
        },
        colorOverride: {
          label: 'Color (Override)',
          default: '#000000',
          optional: true // Logic to handle null/undefined if UI supports it, else we assume hex
        },
        useColorOverride: {
          label: 'Override Color',
          default: false
        },
        alphaOverride: {
          label: 'Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.05,
          default: 0.1
        }
      }
    };
  }

  /**
   * Update settings from UI
   * @param {string} param - Parameter name
   * @param {any} value - New value
   */
  updateSetting(param, value) {
    if (param in this.settings) {
      this.settings[param] = value;
      this.updateGrid();
    } else if (param === 'useColorOverride') {
      // Special handling if needed, or just store it
      this.settings.useColorOverride = value;
      this.updateGrid();
    }
  }

  /**
   * Initialize and setup hooks
   * @public
   */
  initialize() {
    if (this.initialized) return;
    
    this.setupHooks();
    this.initialized = true;
    
    log.info('GridRenderer initialized');
  }

  /**
   * Setup Foundry hooks for grid updates
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    // Initial draw
    Hooks.on('canvasReady', () => {
      this.updateGrid();
    });

    // Update on grid settings change
    Hooks.on('updateScene', (scene, changes) => {
      if (scene.id !== canvas.scene?.id) return;
      
      // Check for grid-related changes
      if ('grid' in changes || 'shiftX' in changes || 'shiftY' in changes) {
        log.info('Grid settings changed, updating grid');
        this.updateGrid();
      }
    });
    
    this.hooksRegistered = true;
  }

  /**
   * Update grid based on current scene settings
   * @public
   */
  updateGrid() {
    if (!canvas || !canvas.grid || !canvas.dimensions) {
      log.warn('Canvas grid data not available');
      return;
    }

    // Remove existing grid
    if (this.gridMesh) {
      this.scene.remove(this.gridMesh);
      this.gridMesh.geometry.dispose();
      this.gridMesh.material.dispose();
      this.gridMesh = null;
    }
    
    if (this.gridTexture) {
      this.gridTexture.dispose();
      this.gridTexture = null;
    }

    // Don't render if gridless or invisible
    if (canvas.grid.type === CONST.GRID_TYPES.GRIDLESS || canvas.grid.alpha === 0) {
      log.debug('Grid is gridless or invisible, skipping render');
      return;
    }

    // Create grid texture via off-screen canvas
    this.gridTexture = this.createGridTexture();
    
    if (!this.gridTexture) {
      log.error('Failed to create grid texture');
      return;
    }

    const THREE = window.THREE;
    const width = canvas.dimensions.width;
    const height = canvas.dimensions.height;
    
    // Create plane mesh
    const geometry = new THREE.PlaneGeometry(width, height);
    
    // Determine opacity
    const baseOpacity = this.settings.alphaOverride !== null ? this.settings.alphaOverride : canvas.grid.alpha;
    const opacity = Math.pow(Math.max(0, Math.min(1, baseOpacity)), 2.2);
    
    const material = new THREE.MeshBasicMaterial({
      map: this.gridTexture,
      transparent: true,
      opacity: opacity,
      depthWrite: false, // Don't write depth, so it acts as overlay
      depthTest: true
    });

    this.gridMesh = new THREE.Mesh(geometry, material);
    this.gridMesh.name = 'GridOverlay';
    
    // Position center (Foundry coordinates are Top-Left)
    // Convert to World Coordinates
    const sceneWidth = canvas.dimensions.width;
    const sceneHeight = canvas.dimensions.height;
    
    this.gridMesh.position.set(sceneWidth / 2, sceneHeight / 2, GRID_Z);
    
    // Flip Y to match texture
    this.gridMesh.scale.y = -1; 
    
    this.scene.add(this.gridMesh);
    log.info(`Grid rendered: ${canvas.grid.type} size ${canvas.grid.size} style ${this.settings.style}`);
  }

  /**
   * Create a texture containing the grid pattern
   * @returns {THREE.Texture}
   * @private
   */
  createGridTexture() {
    const THREE = window.THREE;
    const grid = canvas.grid;
    const dim = canvas.dimensions;
    
    // Create a canvas large enough to hold the grid
    // WARNING: Creating a massive canvas for the whole map is bad for memory
    // Optimization: Create a repeatable texture? 
    // Hex grids are seamless but complex. Square grids are easy.
    // Foundry draws the grid on a PIXI Graphics object.
    // Maybe we can extract that?
    
    // Strategy: Draw the grid on an off-screen canvas
    const canvasEl = document.createElement('canvas');
    canvasEl.width = dim.width;
    canvasEl.height = dim.height;
    const ctx = canvasEl.getContext('2d');
    
    if (!ctx) return null;

    // Configure Style
    const color = (this.settings.useColorOverride && this.settings.colorOverride) 
      ? this.settings.colorOverride 
      : grid.color;
      
    ctx.strokeStyle = new THREE.Color(color).getStyle();
    ctx.lineWidth = this.settings.thickness || 1;
    ctx.globalAlpha = 1.0; // We handle alpha in the material

    // Configure Dash Array
    if (this.settings.style === 'dashed') {
      const dash = Math.max(4, grid.size / 8);
      ctx.setLineDash([dash, dash]);
    } else if (this.settings.style === 'dotted') {
      const dot = Math.max(1, this.settings.thickness);
      // Calculate gap so that (dot + gap) divides grid.size evenly
      // Target ~8 dots per cell
      const divisions = 8;
      const patternLength = grid.size / divisions;
      const gap = Math.max(1, patternLength - dot);
      
      ctx.setLineDash([dot, gap]);
      ctx.lineCap = 'round';
    } else {
      ctx.setLineDash([]); // Solid
    }

    if (grid.isHexagonal) {
      this.drawHexGrid(ctx, grid, dim);
    } else {
      this.drawSquareGrid(ctx, grid, dim);
    }
    
    const texture = new THREE.CanvasTexture(canvasEl);
    texture.minFilter = THREE.LinearFilter; // Or NearestFilter for crisp lines
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 16; // Better looking at angles (though we are top-down)
    
    return texture;
  }

  /**
   * Draw square grid
   * @param {CanvasRenderingContext2D} ctx 
   * @param {BaseGrid} grid 
   * @param {CanvasDimensions} dim 
   * @private
   */
  drawSquareGrid(ctx, grid, dim) {
    const w = dim.width;
    const h = dim.height;
    const s = grid.size;
    
    ctx.beginPath();
    
    // Verticals
    for (let x = 0; x <= w; x += s) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    
    // Horizontals
    for (let y = 0; y <= h; y += s) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    
    ctx.stroke();
  }

  /**
   * Draw hex grid
   * @param {CanvasRenderingContext2D} ctx 
   * @param {BaseGrid} grid 
   * @param {CanvasDimensions} dim 
   * @private
   */
  drawHexGrid(ctx, grid, dim) {
    // Access the grid's polygon points or calculation logic
    // Foundry's HexagonalGrid is complex.
    // Let's use grid.getPolygon(row, col) if available, or iterate rows/cols
    
    // This can be expensive for large maps.
    // Optimization: Draw *one* hex pattern tile and repeat it?
    // Hex grids tile but not simply as a square texture.
    
    // For now, draw naive implementation (draw all polygons)
    // This is a one-time cost at scene load.
    
    // This requires knowing rows/cols
    // canvas.grid.grid gives us the implementation
    
    const implementation = canvas.grid.grid;
    if (!implementation) return;

    // Iterate approximate bounds
    // We can loop through rows and columns based on dimensions
    
    // Let's try to be smart: use Foundry's getGridPositionFromPixels
    // Iterate through all cells...
    
    // Simplified: Iterate pixels? No.
    // Iterate grid coordinates.
    
    // How many rows/cols?
    // height / (size * ?) 
    // width / (size * ?)
    
    // Let's assume a safe upper bound and iterate
    const cols = Math.ceil(dim.width / grid.size) * 2; // *2 for safety with hex offset
    const rows = Math.ceil(dim.height / grid.size) * 2;
    
    ctx.beginPath();
    
    for (let r = -1; r <= rows; r++) {
      for (let c = -1; c <= cols; c++) {
        const poly = implementation.getPolygon(r, c);
        if (poly) {
          // poly is array of points [x,y, x,y, ...]
          const points = poly.points;
          if (points && points.length >= 2) {
            ctx.moveTo(points[0], points[1]);
            for (let i = 2; i < points.length; i += 2) {
              ctx.lineTo(points[i], points[i+1]);
            }
            ctx.lineTo(points[0], points[1]); // Close loop
          }
        }
      }
    }
    
    ctx.stroke();
  }

  /**
   * Dispose
   * @public
   */
  dispose() {
    if (this.gridMesh) {
      this.scene.remove(this.gridMesh);
      this.gridMesh.geometry.dispose();
      this.gridMesh.material.dispose();
    }
    
    if (this.gridTexture) {
      this.gridTexture.dispose();
    }
    
    this.gridMesh = null;
    this.gridTexture = null;
    this.initialized = false;
    
    log.info('GridRenderer disposed');
  }
}
