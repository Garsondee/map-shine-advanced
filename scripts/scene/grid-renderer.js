/**
 * @fileoverview Grid renderer - renders the battlemap grid
 * Uses shader-based grid plane for performance and flexibility
 * Supports Square and Hex grids based on Foundry settings
 * @module scene/grid-renderer
 */

import { createLogger } from '../core/log.js';
import { getGlobalFrameState } from '../core/frame-state.js';
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';

const log = createLogger('GridRenderer');

// Z-position offset for grid.
// Note: The grid is rendered as an overlay (no depth test) so this value is mostly
// informational; we keep it slightly above groundZ to avoid any edge-case coplanar issues.
const GRID_Z_OFFSET = 0.01;

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

    /** @type {THREE.ShaderMaterial|null} */
    this.gridMaterial = null;

    /** @type {boolean} */
    this._isUpdatableRegistered = false;

    /** @type {number} */
    this._lastResolution = -1;
    
    // Grid settings
    // Parity-first: default behavior uses Foundry's scene grid settings.
    // Overrides are optional and disabled by default.
    this.settings = {
      style: null,
      useStyleOverride: true,

      thickness: 2,
      useThicknessOverride: true,

      colorOverride: '#000000',
      useColorOverride: true,

      alphaOverride: 0.05,
      useAlphaOverride: true
    };

    this.initialized = false;
    this.hooksRegistered = false;

    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];
    
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
          label: 'Style (Override)',
          options: {
            'Solid Lines': 'solidLines',
            'Dashed Lines': 'dashedLines',
            'Dotted Lines': 'dottedLines',
            'Square Points': 'squarePoints',
            'Diamond Points': 'diamondPoints',
            'Round Points': 'roundPoints'
          },
          default: 'solidLines'
        },
        useStyleOverride: {
          label: 'Override Style',
          default: true
        },
        thickness: {
          label: 'Thickness (Override)',
          min: 1,
          max: 10,
          step: 1,
          default: 2
        },
        useThicknessOverride: {
          label: 'Override Thickness',
          default: true
        },
        colorOverride: {
          label: 'Color (Override)',
          default: '#000000',
          optional: true
        },
        useColorOverride: {
          label: 'Override Color',
          default: true
        },
        alphaOverride: {
          label: 'Opacity (Override)',
          min: 0.0,
          max: 1.0,
          step: 0.05,
          default: 0.05
        },
        useAlphaOverride: {
          label: 'Override Opacity',
          default: true
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
    }
  }

  /**
   * Optional integration point so the renderer can be updated every frame.
   * EffectComposer will call update(timeInfo).
   * @param {TimeInfo} _timeInfo
   */
  update(_timeInfo) {
    // Keep the AA resolution uniform in sync with camera zoom.
    // This is required for parity with Foundry, where grid thickness is stable across zoom.
    try {
      if (!this.gridMaterial) return;
      if (!this.gridMaterial.uniforms) return;

      const frameState = getGlobalFrameState();
      const viewH = (frameState.viewMaxY - frameState.viewMinY) || 0;
      if (!(viewH > 0)) return;

      // Our world units are pixels (at zoom=1), so pixels-per-world-unit is screenHeight / viewHeight.
      const pixelsPerWorldUnit = frameState.screenHeight / viewH;
      const gridSize = this.gridMaterial.uniforms.uGridSize?.value || (canvas?.grid?.size || 1);
      const resolution = pixelsPerWorldUnit * gridSize;

      if (!Number.isFinite(resolution)) return;
      if (Math.abs(resolution - this._lastResolution) < 1e-4) return;

      this._lastResolution = resolution;
      this.gridMaterial.uniforms.uResolution.value = resolution;
    } catch (e) {
      // Non-critical; avoid cascading failures.
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
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
      this.updateGrid();
    })]);

    // Update on grid settings change
    this._hookIds.push(['updateScene', Hooks.on('updateScene', (scene, changes) => {
      if (scene.id !== canvas.scene?.id) return;
      
      // Check for grid-related changes
      // Foundry v13 uses background.offsetX/offsetY (not shiftX/shiftY) to align map art to the grid.
      // These changes can affect perceived alignment and should trigger a refresh.
      if ('grid' in changes || 'background' in changes || 'width' in changes || 'height' in changes || 'padding' in changes) {
        log.info('Grid settings changed, updating grid');
        this.updateGrid();
      }
    })]);
    
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

    this.gridMaterial = null;
    this._lastResolution = -1;

    // Don't render if gridless or invisible
    if (canvas.grid.type === CONST.GRID_TYPES.GRIDLESS || canvas.grid.alpha === 0) {
      log.debug('Grid is gridless or invisible, skipping render');
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    // Match SceneComposer positioning: draw the grid only over the scene rectangle.
    // This prevents the grid from rendering in the padded canvas area and ensures
    // it overlays the base map plane exactly.
    const dims = canvas.dimensions;
    const worldHeight = Number(dims.height || 1);
    const sceneX = Number.isFinite(dims.sceneX) ? dims.sceneX : 0;
    const sceneY = Number.isFinite(dims.sceneY) ? dims.sceneY : 0;
    const sceneW = Number(dims.sceneWidth || dims.width || 1);
    const sceneH = Number(dims.sceneHeight || dims.height || 1);

    // Create plane mesh over the sceneRect (actual map bounds)
    const geometry = new THREE.PlaneGeometry(sceneW, sceneH);

    // Determine effective settings (parity-first)
    const grid = canvas.grid;

    const styleKey = this.settings.useStyleOverride
      ? (this.settings.style || grid.style)
      : grid.style;

    const thicknessPx = this.settings.useThicknessOverride
      ? (Number(this.settings.thickness) || grid.thickness || 1)
      : (grid.thickness || 1);

    const colorStr = (this.settings.useColorOverride && this.settings.colorOverride)
      ? this.settings.colorOverride
      : grid.color;

    const alpha = this.settings.useAlphaOverride
      ? (Number(this.settings.alphaOverride) || 0)
      : (grid.alpha || 0);

    // Foundry's grid shader uses numeric style codes 0..5
    const styleCode = this._getFoundryStyleCode(styleKey);

    // Use normalized thickness (grid-space units)
    const gridSize = Number(grid.size || 1);
    const thickness = thicknessPx / Math.max(1, gridSize);

    const color = new THREE.Color(colorStr || '#000000');

    // ShaderMaterial to mirror Foundry's GridShader logic.
    // We compute in Foundry pixel space (Y-down) by converting from our world-space (Y-up).
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // The grid should always be visible above tiles/tokens/etc.
      // We render it in the overlay pass and disable depth testing so it cannot be occluded.
      depthTest: false,
      uniforms: {
        uCanvasHeight: { value: Number(canvas.dimensions.height || 1) },
        uGridSize: { value: gridSize },
        uType: { value: Number(grid.type || 0) },
        uStyle: { value: styleCode },
        uThickness: { value: thickness },
        uResolution: { value: 1.0 },
        uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
        uAlpha: { value: Math.max(0, Math.min(1, Number(alpha))) }
      },
      vertexShader: this._getVertexShaderSource(),
      fragmentShader: this._getFragmentShaderSource()
    });

    this.gridMaterial = material;

    this.gridMesh = new THREE.Mesh(geometry, material);
    this.gridMesh.name = 'GridOverlay';
    // Ensure the grid is rendered after all post-processing as a true overlay.
    // (EffectComposer renders OVERLAY_THREE_LAYER separately directly to screen.)
    this.gridMesh.layers.set(OVERLAY_THREE_LAYER);
    this.gridMesh.renderOrder = 2000;
    
    // Position grid relative to groundZ
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    const centerX = sceneX + (sceneW / 2);
    const centerYFoundry = sceneY + (sceneH / 2);
    const centerYWorld = worldHeight - centerYFoundry;
    this.gridMesh.position.set(centerX, centerYWorld, groundZ + GRID_Z_OFFSET);

    this.scene.add(this.gridMesh);
    log.info(`Grid rendered (shader): type ${grid.type}, size ${grid.size}, style ${styleKey}`);

    // Force initial resolution update (if FrameState is available)
    try {
      this.update();
    } catch (_) {
    }
  }

  _getFoundryStyleCode(styleKey) {
    // Back-compat for older saved values
    if (styleKey === 'solid') styleKey = 'solidLines';
    if (styleKey === 'dashed') styleKey = 'dashedLines';
    if (styleKey === 'dotted') styleKey = 'dottedLines';

    switch (styleKey) {
      case 'solidLines':
        return 0;
      case 'dashedLines':
        return 1;
      case 'dottedLines':
        return 2;
      case 'squarePoints':
        return 3;
      case 'diamondPoints':
        return 4;
      case 'roundPoints':
        return 5;
      default:
        return 0;
    }
  }

  _getVertexShaderSource() {
    return `
      varying vec3 vWorldPos;

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `;
  }

  _getFragmentShaderSource() {
    // Port of Foundry's GridShader core logic (simplified for Three.js).
    // Computes grid coverage in grid-space units and anti-aliases using a resolution uniform.
    return `
      precision highp float;

      varying vec3 vWorldPos;

      uniform float uCanvasHeight;
      uniform float uGridSize;
      uniform int uType;
      uniform int uStyle;
      uniform float uThickness;
      uniform float uResolution;
      uniform vec3 uColor;
      uniform float uAlpha;

      const float PI = 3.141592653589793;
      const float SQRT3 = 1.7320508075688772;
      const float SQRT1_2 = 0.7071067811865476;
      const float SQRT1_3 = 0.5773502691896257;

      // Grid type constants (must match CONST.GRID_TYPES)
      const int TYPE_SQUARE = 1;
      const int TYPE_HEXODDR = 2;
      const int TYPE_HEXEVENR = 3;
      const int TYPE_HEXODDQ = 4;
      const int TYPE_HEXEVENQ = 5;

      bool TYPE_IS_SQUARE_FN() { return uType == TYPE_SQUARE; }
      bool TYPE_IS_HEXAGONAL_FN() { return (TYPE_HEXODDR <= uType) && (uType <= TYPE_HEXEVENQ); }
      bool TYPE_IS_HEXAGONAL_COLUMNS_FN() { return (uType == TYPE_HEXODDQ) || (uType == TYPE_HEXEVENQ); }
      bool TYPE_IS_HEXAGONAL_EVEN_FN() { return (uType == TYPE_HEXEVENR) || (uType == TYPE_HEXEVENQ); }

      float antialiasedStep(float edge, float x) {
        return clamp(((x - edge) * uResolution) + 0.5, 0.0, 1.0);
      }

      float lineCoverage(float distance, float thickness, float alignment) {
        float alpha0 = antialiasedStep((0.0 - alignment) * thickness, distance);
        float alpha1 = antialiasedStep((1.0 - alignment) * thickness, distance);
        return alpha0 - alpha1;
      }

      float lineCoverage(float distance, float thickness) {
        return lineCoverage(distance, thickness, 0.5);
      }

      vec2 pointToCube(vec2 p) {
        float x = p.x;
        float y = p.y;
        float q;
        float r;
        float e = TYPE_IS_HEXAGONAL_EVEN_FN() ? 1.0 : 0.0;
        if ( TYPE_IS_HEXAGONAL_COLUMNS_FN() ) {
          q = ((2.0 * SQRT1_3) * x) - (2.0 / 3.0);
          r = (-0.5 * (q + e)) + y;
        } else {
          r = ((2.0 * SQRT1_3) * y) - (2.0 / 3.0);
          q = (-0.5 * (r + e)) + x;
        }
        return vec2(q, r);
      }

      vec2 cubeToPoint(vec2 a) {
        float q = a[0];
        float r = a[1];
        float x;
        float y;
        float e = TYPE_IS_HEXAGONAL_EVEN_FN() ? 1.0 : 0.0;
        if ( TYPE_IS_HEXAGONAL_COLUMNS_FN() ) {
          x = (SQRT3 / 2.0) * (q + (2.0 / 3.0));
          y = (0.5 * (q + e)) + r;
        } else {
          y = (SQRT3 / 2.0) * (r + (2.0 / 3.0));
          x = (0.5 * (r + e)) + q;
        }
        return vec2(x, y);
      }

      vec2 cubeRound(vec2 a) {
        float q = a[0];
        float r = a[1];
        float s = -q - r;
        float iq = floor(q + 0.5);
        float ir = floor(r + 0.5);
        float is = floor(s + 0.5);
        float dq = abs(iq - q);
        float dr = abs(ir - r);
        float ds = abs(is - s);
        if ( (dq > dr) && (dq > ds) ) {
          iq = -ir - is;
        } else if ( dr > ds ) {
          ir = -iq - is;
        } else {
          is = -iq - ir;
        }
        return vec2(iq, ir);
      }

      vec2 nearestVertex(vec2 p) {
        if ( TYPE_IS_SQUARE_FN() ) {
          return floor(p + 0.5);
        }

        if ( TYPE_IS_HEXAGONAL_FN() ) {
          vec2 c = cubeToPoint(cubeRound(pointToCube(p)));
          vec2 d = p - c;
          float a = atan(d.y, d.x);
          if ( TYPE_IS_HEXAGONAL_COLUMNS_FN() ) {
            a = floor((a / (PI / 3.0)) + 0.5) * (PI / 3.0);
          } else {
            a = (floor(a / (PI / 3.0)) + 0.5) * (PI / 3.0);
          }
          return c + (vec2(cos(a), sin(a)) * SQRT1_3);
        }

        return floor(p + 0.5);
      }

      float edgeDistance(vec2 p) {
        if ( TYPE_IS_SQUARE_FN() ) {
          vec2 d = abs(p - floor(p + 0.5));
          return min(d.x, d.y);
        }

        if ( TYPE_IS_HEXAGONAL_FN() ) {
          vec2 a = pointToCube(p);
          vec2 b = cubeRound(a);
          vec2 c = b - a;
          float q = c[0];
          float r = c[1];
          float s = -q - r;
          return (2.0 - (abs(q - r) + abs(r - s) + abs(s - q))) * 0.25;
        }

        return 0.0;
      }

      vec3 edgeOffset(vec2 p) {
        if ( TYPE_IS_SQUARE_FN() ) {
          vec2 d = abs(p - floor(p + 0.5));
          return vec3(max(d.x, d.y), min(d.x, d.y), 1.0);
        }

        if ( TYPE_IS_HEXAGONAL_FN() ) {
          vec2 c = cubeToPoint(cubeRound(pointToCube(p)));
          vec2 d = p - c;
          float a = atan(d.y, d.x);
          if ( TYPE_IS_HEXAGONAL_COLUMNS_FN() ) {
            a = (floor(a / (PI / 3.0)) + 0.5) * (PI / 3.0);
          } else {
            a = floor((a / (PI / 3.0)) + 0.5) * (PI / 3.0);
          }
          vec2 n = vec2(cos(a), sin(a));
          return vec3((0.5 * SQRT1_3) + dot(d, vec2(-n.y, n.x)), 0.5 - dot(d, n), SQRT1_3);
        }

        return vec3(0.0);
      }

      float drawGrid(vec2 point, int style, float thickness) {
        float alpha;

        // Points
        if ( style == 3 ) {
          vec2 offset = abs(nearestVertex(point) - point);
          float distance = max(offset.x, offset.y);
          alpha = lineCoverage(distance, thickness);
        }
        else if ( style == 4 ) {
          vec2 offset = abs(nearestVertex(point) - point);
          float distance = (offset.x + offset.y) * SQRT1_2;
          alpha = lineCoverage(distance, thickness);
        }
        else if ( style == 5 ) {
          float distance = distance(point, nearestVertex(point));
          alpha = lineCoverage(distance, thickness);
        }

        // Solid lines
        else if ( style == 0 ) {
          float distance = edgeDistance(point);
          alpha = lineCoverage(distance, thickness);
        }

        // Dashed / Dotted
        else {
          vec3 o = edgeOffset(point);
          if ( (style == 1) && TYPE_IS_HEXAGONAL_FN() ) {
            float padding = thickness * ((1.0 - SQRT1_3) * 0.5);
            o.x += padding;
            o.z += (padding * 2.0);
          }

          float intervals = o.z * 0.5 / thickness;
          if ( intervals < 0.5 ) {
            alpha = lineCoverage(o.y, thickness);
          } else {
            float interval = thickness * (2.0 * (intervals / floor(intervals + 0.5)));
            float dx = o.x - (floor((o.x / interval) + 0.5) * interval);
            float dy = o.y;

            if ( style == 2 ) {
              alpha = lineCoverage(length(vec2(dx, dy)), thickness);
            } else {
              alpha = min(lineCoverage(dx, thickness), lineCoverage(dy, thickness));
            }
          }
        }

        return alpha;
      }

      void main() {
        if (uAlpha <= 0.0) discard;
        if (uGridSize <= 0.0) discard;

        // Convert our world-space (Y-up) to Foundry pixel space (Y-down)
        vec2 pixelCoord = vec2(vWorldPos.x, uCanvasHeight - vWorldPos.y);
        vec2 gridCoord = pixelCoord / uGridSize;

        float a = drawGrid(gridCoord, uStyle, uThickness);
        if (a <= 0.0) discard;

        gl_FragColor = vec4(uColor, uAlpha * a);
      }
    `;
  }

  /**
   * Dispose
   * @public
   */
  dispose() {
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

    if (this.gridMesh) {
      this.scene.remove(this.gridMesh);
      this.gridMesh.geometry.dispose();
      this.gridMesh.material.dispose();
    }

    this.gridMesh = null;
    this.gridMaterial = null;
    this.initialized = false;
    
    log.info('GridRenderer disposed');
  }
}
