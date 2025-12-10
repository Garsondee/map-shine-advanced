/**
 * @fileoverview World-Space Fog of War Effect
 * 
 * Renders fog of war as a world-space plane mesh instead of a screen-space
 * post-processing effect. This eliminates coordinate system conversion issues
 * and ensures the fog is always correctly pinned to the map.
 * 
 * Architecture:
 * - Creates a plane mesh covering the scene rect
 * - Renders vision polygons to a world-space render target
 * - Uses Foundry's exploration texture directly (it's already world-space)
 * - Composites vision + exploration in the fog plane's shader
 * 
 * @module effects/WorldSpaceFogEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('WorldSpaceFogEffect');

/**
 * Z-height for the fog overlay plane
 * Must be above ALL other scene content including particles, effects, etc.
 * Post-processing effects happen after scene render, so this just needs to be
 * above all meshes in the scene.
 */
const FOG_PLANE_Z = 1000;

export class WorldSpaceFogEffect extends EffectBase {
  constructor() {
    super('fog', RenderLayers.ENVIRONMENTAL, 'low');
    
    this.priority = 10;
    
    this.params = {
      enabled: true,
      unexploredColor: '#000000',
      exploredColor: '#000000',
      exploredOpacity: 0.5
    };

    // Scene reference
    this.mainScene = null;
    
    // The fog overlay plane mesh
    this.fogPlane = null;
    this.fogMaterial = null;
    
    // World-space vision render target
    this.visionRenderTarget = null;
    this.visionScene = null;
    this.visionCamera = null;
    this.visionMaterial = null;
    
    // Self-maintained exploration render target
    // We accumulate vision into this each frame: explored = max(explored, vision)
    // This gives us proper "explored but not visible" without relying on Foundry's
    // pre-populated exploration texture which marks outdoors as explored by default.
    this.explorationRenderTarget = null;
    this.explorationScene = null;
    this.explorationCamera = null;
    this.explorationMaterial = null;
    
    // Ping-pong targets for accumulation
    this._explorationTargetA = null;
    this._explorationTargetB = null;
    this._currentExplorationTarget = 'A';
    
    // Scene dimensions
    this.sceneRect = { x: 0, y: 0, width: 1, height: 1 };
    this.sceneDimensions = { width: 1, height: 1 };
    
    // Fallback textures
    this._fallbackWhite = null;
    this._fallbackBlack = null;
    
    this._initialized = false;

    // Track MapShine selection changes to know when to recompute vision
    this._lastSelectionVersion = '';
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'fog',
          label: 'Fog of War',
          type: 'inline',
          parameters: ['unexploredColor', 'exploredColor', 'exploredOpacity']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        unexploredColor: { type: 'color', default: '#000000', label: 'Unexplored' },
        exploredColor: { type: 'color', default: '#000000', label: 'Explored Tint' },
        exploredOpacity: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5, label: 'Explored Opacity' }
      }
    };
  }

  initialize(renderer, scene, camera) {
    if (this._initialized) return;
    
    this.renderer = renderer;
    this.mainScene = scene;
    const THREE = window.THREE;

    // Get scene dimensions from Foundry
    this._updateSceneDimensions();
    
    // Create fallback textures
    const whiteData = new Uint8Array([255, 255, 255, 255]);
    this._fallbackWhite = new THREE.DataTexture(whiteData, 1, 1, THREE.RGBAFormat);
    this._fallbackWhite.needsUpdate = true;
    
    const blackData = new Uint8Array([0, 0, 0, 255]);
    this._fallbackBlack = new THREE.DataTexture(blackData, 1, 1, THREE.RGBAFormat);
    this._fallbackBlack.needsUpdate = true;

    // Create world-space vision render target
    this._createVisionRenderTarget();
    
    // Create self-maintained exploration render target
    this._createExplorationRenderTarget();
    
    // Create the fog overlay plane
    this._createFogPlane();
    
    // Register Foundry hooks for vision updates
    this._registerHooks();
    
    this._initialized = true;
    log.info('WorldSpaceFogEffect initialized');
  }

  /**
   * Update scene dimensions from Foundry
   * @private
   */
  _updateSceneDimensions() {
    if (canvas?.dimensions) {
      this.sceneDimensions = {
        width: canvas.dimensions.width || 1,
        height: canvas.dimensions.height || 1
      };
      
      const rect = canvas.dimensions.sceneRect;
      if (rect) {
        this.sceneRect = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      } else {
        this.sceneRect = {
          x: 0,
          y: 0,
          width: this.sceneDimensions.width,
          height: this.sceneDimensions.height
        };
      }
    }
  }

  /**
   * Create the world-space vision render target
   * @private
   */
  _createVisionRenderTarget() {
    const THREE = window.THREE;
    const { width, height } = this.sceneRect;
    
    // Use a reasonable resolution (can be lower than scene for performance)
    const maxSize = 2048;
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const rtWidth = Math.ceil(width * scale);
    const rtHeight = Math.ceil(height * scale);
    
    this.visionRenderTarget = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {
      format: THREE.RGBAFormat,  // Use RGBA for proper sampling
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
    });
    
    // Create a scene for rendering vision polygons
    this.visionScene = new THREE.Scene();
    
    // Orthographic camera covering the scene rect in Foundry coordinates
    // Foundry: origin top-left, Y-down, but the polygon point data we get from
    // PointVisionSource is in the same pixel space as canvas (0..width, 0..height).
    // Use a standard orthographic frustum that spans this box so our shapes are
    // fully inside the render volume.
    this.visionCamera = new THREE.OrthographicCamera(
      0, width,    // left, right
      height, 0,   // top, bottom
      0, 100
    );
    this.visionCamera.position.set(0, 0, 10);
    
    // Material for drawing vision polygons (white = visible)
    this.visionMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide
    });
    
    log.debug(`Vision render target created: ${rtWidth}x${rtHeight}`);
  }

  /**
   * Create the self-maintained exploration render target
   * We use ping-pong rendering to accumulate: explored = max(explored, vision)
   * @private
   */
  _createExplorationRenderTarget() {
    const THREE = window.THREE;
    const { width, height } = this.sceneRect;
    
    // Use same resolution as vision target
    const maxSize = 2048;
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const rtWidth = Math.ceil(width * scale);
    const rtHeight = Math.ceil(height * scale);
    
    const rtOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
    };
    
    // Create two targets for ping-pong rendering
    this._explorationTargetA = new THREE.WebGLRenderTarget(rtWidth, rtHeight, rtOptions);
    this._explorationTargetB = new THREE.WebGLRenderTarget(rtWidth, rtHeight, rtOptions);
    this._currentExplorationTarget = 'A';
    
    // Scene and camera for accumulation pass
    this.explorationScene = new THREE.Scene();
    this.explorationCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // Material that does: output = max(previousExplored, currentVision)
    this.explorationMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tPreviousExplored: { value: null },
        tCurrentVision: { value: null }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tPreviousExplored;
        uniform sampler2D tCurrentVision;
        varying vec2 vUv;
        
        void main() {
          float prev = texture2D(tPreviousExplored, vUv).r;
          float curr = texture2D(tCurrentVision, vUv).r;
          float explored = max(prev, curr);
          gl_FragColor = vec4(explored, explored, explored, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false
    });
    
    // Full-screen quad for accumulation
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.explorationMaterial);
    this.explorationScene.add(quad);
    
    // Clear both targets to black initially
    const currentTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._explorationTargetA);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.setRenderTarget(this._explorationTargetB);
    this.renderer.clear();
    this.renderer.setRenderTarget(currentTarget);
    
    log.debug(`Exploration render targets created: ${rtWidth}x${rtHeight}`);
  }

  /**
   * Get the current exploration texture (the one we read from)
   * @private
   */
  _getExplorationReadTarget() {
    return this._currentExplorationTarget === 'A' 
      ? this._explorationTargetA 
      : this._explorationTargetB;
  }

  /**
   * Get the exploration texture to write to (the other one)
   * @private
   */
  _getExplorationWriteTarget() {
    return this._currentExplorationTarget === 'A' 
      ? this._explorationTargetB 
      : this._explorationTargetA;
  }

  /**
   * Swap exploration targets after accumulation
   * @private
   */
  _swapExplorationTargets() {
    this._currentExplorationTarget = this._currentExplorationTarget === 'A' ? 'B' : 'A';
  }

  /**
   * Accumulate current vision into exploration texture
   * explored = max(explored, vision)
   * @private
   */
  _accumulateExploration() {
    if (!this.explorationMaterial || !this._explorationTargetA) return;
    
    const readTarget = this._getExplorationReadTarget();
    const writeTarget = this._getExplorationWriteTarget();
    
    // Set up uniforms
    this.explorationMaterial.uniforms.tPreviousExplored.value = readTarget.texture;
    this.explorationMaterial.uniforms.tCurrentVision.value = this.visionRenderTarget.texture;
    
    // Render accumulation pass
    const currentTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(writeTarget);
    this.renderer.render(this.explorationScene, this.explorationCamera);
    this.renderer.setRenderTarget(currentTarget);
    
    // Swap targets so next frame reads from the one we just wrote
    this._swapExplorationTargets();
  }

  /**
   * Create the fog overlay plane mesh
   * @private
   */
  _createFogPlane() {
    const THREE = window.THREE;
    const { x, y, width, height } = this.sceneRect;
    
    // Create shader material for fog compositing
    this.fogMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tVision: { value: this.visionRenderTarget.texture },
        tExplored: { value: this._fallbackBlack },
        uUnexploredColor: { value: new THREE.Color(0x000000) },
        uExploredColor: { value: new THREE.Color(0x000000) },
        uExploredOpacity: { value: 0.5 },
        uBypassFog: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tVision;
        uniform sampler2D tExplored;
        uniform vec3 uUnexploredColor;
        uniform vec3 uExploredColor;
        uniform float uExploredOpacity;
        uniform float uBypassFog;
        
        // Scene rect in Foundry coords (x, y, width, height)
        // We will inject this via defines/uniform replacement from JS if needed.
        // For now, assume the fog plane covers exactly the sceneRect, so vUv maps
        // linearly across it and we can reconstruct Foundry world coordinates.
        varying vec2 vUv;
        
        void main() {
          if (uBypassFog > 0.5) {
            discard;
          }
          
          // Sample vision (current LOS) - white = visible
          // Vision texture uses RGBA format, sample any channel (they're all the same)
          // UV needs Y-flip because Three.js plane UVs are bottom-left origin
          // but our vision camera renders with top-left origin (Foundry coords)
          vec2 visionUv = vec2(vUv.x, 1.0 - vUv.y);
          float vision = texture2D(tVision, visionUv).r;
          
          // Exploration texture is in Foundry world space over the sceneRect.
          // The fog plane's geometry is also aligned to sceneRect, so we can
          // use vUv directly as local coordinates. However, the underlying
          // PIXI texture is vertically inverted relative to our plane, so we
          // flip Y once when sampling.
          vec2 exploredUv = vec2(vUv.x, 1.0 - vUv.y);
          float explored = texture2D(tExplored, exploredUv).r;
          
          // Fog of War logic:
          // 1. Currently visible -> fully transparent (discard)
          // 2. Previously explored but not visible -> dim overlay
          // 3. Never explored -> full darkness
          if (vision > 0.1) {
            discard;
          } else if (explored > 0.1 && uExploredOpacity > 0.0) {
            gl_FragColor = vec4(uExploredColor, uExploredOpacity);
          } else {
            gl_FragColor = vec4(uUnexploredColor, 1.0);
          }
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    
    // Create plane geometry covering the scene rect
    const geometry = new THREE.PlaneGeometry(width, height);
    
    this.fogPlane = new THREE.Mesh(geometry, this.fogMaterial);
    this.fogPlane.name = 'FogOverlayPlane';
    
    // Ensure fog renders on top of everything in the scene
    this.fogPlane.renderOrder = 9999;
    
    // Position the plane in Three.js world space
    // Three.js: origin bottom-left, Y-up
    // Scene rect center in Three.js coords:
    const centerX = x + width / 2;
    const centerY = this.sceneDimensions.height - (y + height / 2);
    
    this.fogPlane.position.set(centerX, centerY, FOG_PLANE_Z);
    
    // Frustum culling off - always render
    this.fogPlane.frustumCulled = false;
    
    // Add to main scene
    this.mainScene.add(this.fogPlane);
    
    log.debug(`Fog plane created at (${centerX}, ${centerY}, ${FOG_PLANE_Z}), size ${width}x${height}`);
  }

  /**
   * Register Foundry hooks for vision updates
   * @private
   */
  _registerHooks() {
    // Vision needs to be re-rendered when:
    // - Token moves
    // - Token is controlled/released
    // - Lighting changes
    // - Walls change
    
    // We'll trigger updates on these hooks
    Hooks.on('controlToken', () => { this._needsVisionUpdate = true; });
    Hooks.on('updateToken', () => { this._needsVisionUpdate = true; });
    Hooks.on('sightRefresh', () => { this._needsVisionUpdate = true; });
    Hooks.on('lightingRefresh', () => { this._needsVisionUpdate = true; });
    
    this._needsVisionUpdate = true; // Initial render
  }

  /**
   * Render vision polygons to the world-space render target
   * @private
   */
  _renderVisionMask() {
    if (!this.visionRenderTarget || !this.visionScene || !this.visionCamera) return;
    
    const THREE = window.THREE;
    
    // Clear the vision scene
    while (this.visionScene.children.length > 0) {
      const child = this.visionScene.children[0];
      this.visionScene.remove(child);
      if (child.geometry) child.geometry.dispose();
    }
    
    // Resolve controlled tokens:
    // 1) Prefer MapShine's interactionManager selection (Three.js-driven UI)
    // 2) Fallback to Foundry's canvas.tokens.controlled
    let controlledTokens = [];
    const ms = window.MapShine;
    const interactionManager = ms?.interactionManager;
    const tokenManager = ms?.tokenManager;
    const selection = interactionManager?.selection;

    if (selection && tokenManager?.tokenSprites) {
      // Map selected IDs to Foundry Token placeables
      const placeables = canvas?.tokens?.placeables || [];
      const selectedIds = Array.from(selection);
      for (const id of selectedIds) {
        if (!tokenManager.tokenSprites.has(id)) continue; // skip non-token selections
        const token = placeables.find(t => t.document?.id === id);
        if (token) controlledTokens.push(token);
      }
    }

    // Fallback: use Foundry's native controlled tokens if MapShine selection is empty
    if (!controlledTokens.length) {
      controlledTokens = canvas?.tokens?.controlled || [];
    }

    // Debug: Log what we're working with
    if (Math.random() < 0.02) {
      const visionSources = canvas?.effects?.visionSources;
      log.debug(`Vision sources: ${visionSources?.size || 0}, controlled tokens: ${controlledTokens.length}`);
      if (visionSources) {
        for (const vs of visionSources) {
          log.debug(`  VisionSource: active=${vs.active}, shape=${vs.shape?.points?.length || 0} points`);
        }
      }
    }
    
    // Try to get vision from controlled tokens' vision sources
    let polygonsRendered = 0;
    
    for (const token of controlledTokens) {
      // Each token has a vision source in canvas.effects.visionSources
      // The key is typically the token's sourceId
      const visionSource = token.vision;
      
      if (!visionSource) {
        if (Math.random() < 0.02) {
          log.debug(`Token ${token.name} has no vision source`);
        }
        continue;
      }
      
      // Get the LOS (line of sight) shape - this is the actual visibility polygon
      // Try different properties that Foundry might use
      let shape = visionSource.los || visionSource.shape || visionSource.fov;
      
      if (!shape || !shape.points || shape.points.length < 6) {
        if (Math.random() < 0.02) {
          log.debug(`Token ${token.name} vision source has no valid shape (los=${!!visionSource.los}, shape=${!!visionSource.shape}, fov=${!!visionSource.fov})`);
        }
        continue;
      }
      
      // Convert PIXI polygon points to Three.js shape
      const points = shape.points;
      const threeShape = new THREE.Shape();
      
      // Points are in Foundry world coords (relative to scene origin)
      // Offset by sceneRect to get local coords for our render target
      const offsetX = this.sceneRect.x;
      const offsetY = this.sceneRect.y;
      
      threeShape.moveTo(points[0] - offsetX, points[1] - offsetY);
      for (let i = 2; i < points.length; i += 2) {
        threeShape.lineTo(points[i] - offsetX, points[i + 1] - offsetY);
      }
      threeShape.closePath();
      
      const geometry = new THREE.ShapeGeometry(threeShape);
      const mesh = new THREE.Mesh(geometry, this.visionMaterial);
      this.visionScene.add(mesh);
      polygonsRendered++;
      
      if (Math.random() < 0.02) {
        log.debug(`Rendered vision for ${token.name}: ${points.length / 2} vertices`);
      }
    }
    
    // Render to the vision target
    const currentTarget = this.renderer.getRenderTarget();
    const currentClearColor = this.renderer.getClearColor(new THREE.Color());
    const currentClearAlpha = this.renderer.getClearAlpha();
    
    this.renderer.setRenderTarget(this.visionRenderTarget);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(this.visionScene, this.visionCamera);
    
    // Restore previous state
    this.renderer.setRenderTarget(currentTarget);
    this.renderer.setClearColor(currentClearColor, currentClearAlpha);
    
    this._needsVisionUpdate = false;
    
    // Debug logging
    if (Math.random() < 0.01) {
      log.debug(`Vision mask rendered: ${this.visionScene.children.length} polygons`);
    }
  }

  /**
   * Check if fog should be bypassed (GM with no tokens selected)
   * @private
   */
  _shouldBypassFog() {
    const isGM = game?.user?.isGM;
    const fogEnabled = canvas?.scene?.tokenVision ?? false;
    
    if (!fogEnabled) return true;
    
    if (isGM) {
      // First, trust Foundry's native controlled tokens
      const foundryControlled = canvas?.tokens?.controlled || [];
      let hasControlledTokens = foundryControlled.length > 0;

      // Also consider MapShine's Three.js selection as a fallback/extension.
      // This ensures that as soon as a token is selected in our custom UI,
      // the GM no longer bypasses fog, even if Foundry hasn't fully synced yet.
      if (!hasControlledTokens) {
        try {
          const ms = window.MapShine;
          const interactionManager = ms?.interactionManager;
          const tokenManager = ms?.tokenManager;
          const selection = interactionManager?.selection;

          if (interactionManager && tokenManager && selection && selection.size > 0) {
            for (const id of selection) {
              if (tokenManager.tokenSprites && tokenManager.tokenSprites.has(id)) {
                hasControlledTokens = true;
                break;
              }
            }
          }
        } catch (_) {
          // Ignore MapShine check errors
        }
      }

      return !hasControlledTokens;
    }
    
    return false;
  }

  update(timeInfo) {
    if (!this._initialized || !this.fogPlane) return;
    
    // Check if fog should be bypassed
    const bypassFog = this._shouldBypassFog();
    this.fogMaterial.uniforms.uBypassFog.value = bypassFog ? 1.0 : 0.0;
    this.fogPlane.visible = this.params.enabled && !bypassFog;
    
    if (!this.params.enabled || bypassFog) return;
    
    // Detect MapShine selection changes (Three.js-driven UI) and trigger
    // a vision recompute when the set of selected token IDs changes.
    try {
      const ms = window.MapShine;
      const interactionManager = ms?.interactionManager;
      const selection = interactionManager?.selection;
      let selectionVersion = '';
      if (selection && selection.size > 0) {
        // Stable ordering by sorting IDs so that order changes don't
        // cause unnecessary recomputes.
        const ids = Array.from(selection);
        ids.sort();
        selectionVersion = ids.join('|');
      }
      if (selectionVersion !== this._lastSelectionVersion) {
        this._lastSelectionVersion = selectionVersion;
        this._needsVisionUpdate = true;
      }
    } catch (_) {
      // Ignore MapShine selection errors
    }

    // Update vision mask if needed
    if (this._needsVisionUpdate) {
      this._renderVisionMask();
    }
    
    // Accumulate current vision into our self-maintained exploration texture
    // This runs every frame so that as the token moves, the explored area grows
    // explored = max(explored, vision)
    this._accumulateExploration();
    
    // Use our self-maintained exploration texture (NOT Foundry's pre-populated one)
    // This ensures only areas we've actually seen with our token are marked explored
    const exploredTex = this._getExplorationReadTarget()?.texture || this._fallbackBlack;
    this.fogMaterial.uniforms.tExplored.value = exploredTex;
    
    // Update color uniforms
    this.fogMaterial.uniforms.uUnexploredColor.value.set(this.params.unexploredColor);
    this.fogMaterial.uniforms.uExploredColor.value.set(this.params.exploredColor);
    
    // If exploration is disabled, force explored opacity to 0 so only
    // current vision reveals the map. Otherwise respect the configured
    // exploredOpacity parameter.
    const explorationEnabled = canvas?.scene?.fog?.exploration ?? false;
    this.fogMaterial.uniforms.uExploredOpacity.value = explorationEnabled
      ? this.params.exploredOpacity
      : 0.0;
  }

  /**
   * Render is handled by the main scene render (fog plane is in the scene)
   */
  render(renderer, scene, camera) {
    // No-op - the fog plane is rendered as part of the main scene
  }

  /**
   * Handle scene resize
   */
  resize(width, height) {
    if (!this._initialized) return;
    
    // Update dimensions
    this._updateSceneDimensions();
    
    // Recreate vision render target at new size
    if (this.visionRenderTarget) {
      this.visionRenderTarget.dispose();
    }
    this._createVisionRenderTarget();
    
    // Recreate exploration render targets at new size
    if (this._explorationTargetA) {
      this._explorationTargetA.dispose();
    }
    if (this._explorationTargetB) {
      this._explorationTargetB.dispose();
    }
    this._createExplorationRenderTarget();
    
    // Update fog plane geometry and position
    if (this.fogPlane) {
      this.mainScene.remove(this.fogPlane);
      this.fogPlane.geometry.dispose();
    }
    this._createFogPlane();
    
    this._needsVisionUpdate = true;
  }

  dispose() {
    if (this.fogPlane && this.mainScene) {
      this.mainScene.remove(this.fogPlane);
      this.fogPlane.geometry.dispose();
      this.fogMaterial.dispose();
    }
    
    if (this.visionRenderTarget) {
      this.visionRenderTarget.dispose();
    }
    
    // Dispose exploration render targets
    if (this._explorationTargetA) {
      this._explorationTargetA.dispose();
    }
    if (this._explorationTargetB) {
      this._explorationTargetB.dispose();
    }
    if (this.explorationMaterial) {
      this.explorationMaterial.dispose();
    }
    
    if (this._fallbackWhite) this._fallbackWhite.dispose();
    if (this._fallbackBlack) this._fallbackBlack.dispose();
    
    this._initialized = false;
    log.info('WorldSpaceFogEffect disposed');
  }
}
