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

import { EffectBase, RenderLayers, OVERLAY_THREE_LAYER } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { frameCoordinator } from '../core/frame-coordinator.js';
import { VisionSDF } from '../vision/VisionSDF.js';
import { debugLoadingProfiler } from '../core/debug-loading-profiler.js';

const log = createLogger('WorldSpaceFogEffect');

/**
 * Z offset for the fog plane above groundZ.
 *
 * We want the fog plane to sit just above all world content that can be
 * occluded by fog (ground, tiles, tokens, environmental meshes) while
 * remaining as close as possible to the canonical ground plane to avoid
 * any unintended parallax or depth-related artifacts.
 *
 * NOTE:
 * - depthTest: false  → fog does not participate in depth testing
 * - renderOrder: 9999 → fog renders after everything else regardless of Z
 *
 * The small offset here is only to keep the plane numerically above other
 * meshes that may also sit near groundZ; visually, ordering is controlled
 * by renderOrder + disabled depth test.
 */
const FOG_PLANE_Z_OFFSET = 0.05; // Nearly coplanar with the ground plane to avoid parallax/perspective peeking

export class WorldSpaceFogEffect extends EffectBase {
  constructor() {
    super('fog', RenderLayers.ENVIRONMENTAL, 'low');
    
    this.priority = 10;
    
    this.params = {
      enabled: true,
      unexploredColor: '#000000',
      exploredColor: '#000000',
      exploredOpacity: 0.5,
      softness: 6.0,
      noiseStrength: 6.0,
      noiseSpeed: 0.2
    };

    // Scene reference
    this.mainScene = null;
    
    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];
    
    // The fog overlay plane mesh
    this.fogPlane = null;
    this.fogMaterial = null;
    
    // World-space vision render target
    this.visionRenderTarget = null;
    this.visionScene = null;
    this.visionCamera = null;
    this.visionMaterial = null;

    this._visionRTWidth = 1;
    this._visionRTHeight = 1;
    
    // Self-maintained exploration render target
    // We accumulate vision into this each frame: explored = max(explored, vision)
    // This gives us proper "explored but not visible" without relying on Foundry's
    // pre-populated exploration texture which marks outdoors as explored by default.
    this.explorationRenderTarget = null;
    this.explorationScene = null;
    this.explorationCamera = null;
    this.explorationMaterial = null;

    this._explorationRTWidth = 1;
    this._explorationRTHeight = 1;
    
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
    
    // Track whether we have valid vision data (LOS polygons computed)
    // Used to hide fog plane until Foundry's async perception update completes
    this._hasValidVision = false;

    // Safety: count consecutive frames where we're stuck waiting for vision.
    // After a threshold we fall back to showing fog with whatever data we have
    // (prevents the fog plane being permanently hidden).
    this._visionRetryFrames = 0;
    this._maxVisionRetryFrames = 30; // ~0.5s at 60fps
    // True when the vision mask contains a full-scene white rect (global
    // illumination fallback) instead of a real LOS polygon. When set,
    // exploration accumulation is skipped to avoid polluting it past walls.
    this._visionIsFullSceneFallback = false;
    
    this._explorationLoadedFromFoundry = false;
    this._explorationLoadAttempts = 0;
    this._explorationDirty = false;
    // Generation counter: incremented on every reset/re-init to detect stale
    // async TextureLoader callbacks that should no longer overwrite exploration.
    this._explorationLoadGeneration = 0;
    // Tracks when vision was rendered but exploration wasn't ready to accumulate.
    // When exploration finishes loading, we do one catch-up accumulation.
    this._pendingAccumulation = false;
    this._explorationCommitCount = 0;
    this._saveExplorationDebounced = null;
    this._isSavingExploration = false;
    this._isLoadingExploration = false;

    // PERF: Saving fog exploration requires a GPU->CPU readback + image encode.
    // On large scenes, this can stall the renderer for ~1s. Rate-limit saves so
    // they cannot happen repeatedly and create periodic hitching.
    this._lastExplorationSaveMs = 0;
    this._minExplorationSaveIntervalMs = 30000;

    // PERF: Reuse buffers for fog exploration saves to reduce GC pressure.
    // Note: this does NOT eliminate the GPU->CPU stall from readRenderTargetPixels,
    // but it does avoid repeated large allocations.
    this._explorationSaveBuffer = null; // Uint8Array
    this._explorationReadbackTileBuffer = null; // Uint8Array
    this._explorationReadbackTileSize = 256;
    this._explorationEncodeCanvas = null; // OffscreenCanvas | HTMLCanvasElement
    this._explorationEncodeCtx = null; // OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
    this._explorationEncodeImageData = null; // ImageData

    this._fullResTargetsReady = false;
    this._fullResTargetsQueued = false;
    this._loggedExplorationState = false;

    // SDF generator for smooth fog edges (eliminates polygon scalloping)
    /** @type {VisionSDF|null} */
    this._visionSDF = null;
    this._loggedSDFState = false;
    this._sdfUpdateFailed = false;
  }

  resetExploration() {
    if (!this._initialized) return;
    if (!this.renderer) return;
    if (!this._explorationTargetA || !this._explorationTargetB) return;

    const THREE = window.THREE;

    const currentTarget = this.renderer.getRenderTarget();
    const currentClearColor = this.renderer.getClearColor(new THREE.Color());
    const currentClearAlpha = this.renderer.getClearAlpha();

    this.renderer.setClearColor(0x000000, 1);

    this.renderer.setRenderTarget(this._explorationTargetA);
    this.renderer.clear();

    this.renderer.setRenderTarget(this._explorationTargetB);
    this.renderer.clear();

    this.renderer.setRenderTarget(currentTarget);
    this.renderer.setClearColor(currentClearColor, currentClearAlpha);

    this._currentExplorationTarget = 'A';
    this._needsVisionUpdate = true;
    this._hasValidVision = false;

    this._explorationDirty = false;
    this._explorationCommitCount = 0;

    // If Foundry resets fog exploration, the authoritative state is now "blank".
    // Mark exploration as loaded so we don't stall accumulation while repeatedly
    // trying to load a now-deleted FogExploration document.
    this._explorationLoadedFromFoundry = true;
    // Bump generation so any in-flight async TextureLoader callbacks from a
    // prior _ensureExplorationLoadedFromFoundry() call are silently ignored.
    this._explorationLoadGeneration++;
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
          parameters: ['unexploredColor', 'exploredColor', 'exploredOpacity', 'softness', 'noiseStrength', 'noiseSpeed']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        unexploredColor: { type: 'color', default: '#000000', label: 'Unexplored' },
        exploredColor: { type: 'color', default: '#000000', label: 'Explored Tint' },
        exploredOpacity: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5, label: 'Explored Opacity' },
        softness: { type: 'slider', min: 0, max: 12, step: 0.5, default: 3.0, label: 'Edge Softness' },
        noiseStrength: { type: 'slider', min: 0, max: 12, step: 0.5, default: 2.0, label: 'Edge Distortion (px)' },
        noiseSpeed: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.2, label: 'Distortion Speed' }
      }
    };
  }

  initialize(renderer, scene, camera) {
    if (this._initialized) return;
    
    const _dlp = debugLoadingProfiler;
    const _isDbg = _dlp.debugMode;

    this.renderer = renderer;
    this.mainScene = scene;
    const THREE = window.THREE;

    // Get scene dimensions from Foundry
    if (_isDbg) _dlp.begin('fog.sceneDimensions', 'effect');
    this._updateSceneDimensions();
    if (_isDbg) _dlp.end('fog.sceneDimensions');

    // Respect Foundry scene fog colors if provided
    try {
      const colors = canvas?.scene?.fog?.colors;
      if (colors?.unexplored) this.params.unexploredColor = colors.unexplored;
      if (colors?.explored) this.params.exploredColor = colors.explored;
    } catch (_) {
      // Ignore
    }
    
    // Create fallback textures
    if (_isDbg) _dlp.begin('fog.createTargets', 'effect');
    const whiteData = new Uint8Array([255, 255, 255, 255]);
    this._fallbackWhite = new THREE.DataTexture(whiteData, 1, 1, THREE.RGBAFormat);
    this._fallbackWhite.needsUpdate = true;
    
    const blackData = new Uint8Array([0, 0, 0, 255]);
    this._fallbackBlack = new THREE.DataTexture(blackData, 1, 1, THREE.RGBAFormat);
    this._fallbackBlack.needsUpdate = true;

    this._createMinimalTargets();

    try {
      const maxAniso = this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 0;
      if (maxAniso > 0) {
        if (this.visionRenderTarget?.texture) this.visionRenderTarget.texture.anisotropy = maxAniso;
        if (this._explorationTargetA?.texture) this._explorationTargetA.texture.anisotropy = maxAniso;
        if (this._explorationTargetB?.texture) this._explorationTargetB.texture.anisotropy = maxAniso;
      }
    } catch (_) {
    }
    if (_isDbg) _dlp.end('fog.createTargets');

    this._saveExplorationDebounced = foundry.utils.debounce(
      this._saveExplorationToFoundry.bind(this),
      2000
    );
    
    // Create the fog overlay plane
    if (_isDbg) _dlp.begin('fog.createPlane', 'effect');
    this._createFogPlane();
    if (_isDbg) _dlp.end('fog.createPlane');
    
    // Register Foundry hooks for vision updates
    if (_isDbg) _dlp.begin('fog.registerHooks', 'effect');
    this._registerHooks();
    if (_isDbg) _dlp.end('fog.registerHooks');
    
    this._initialized = true;

    // One-shot diagnostic: confirm fog plane setup
    const fp = this.fogPlane;
    log.info(`WorldSpaceFogEffect initialized — fogPlane: ${!!fp}, layer: ${fp?.layers?.mask}, renderOrder: ${fp?.renderOrder}, visible: ${fp?.visible}, pos: (${fp?.position?.x?.toFixed(0)}, ${fp?.position?.y?.toFixed(0)}, ${fp?.position?.z?.toFixed(2)}), sceneRect: (${this.sceneRect.x}, ${this.sceneRect.y}, ${this.sceneRect.width}x${this.sceneRect.height}), tokenVision: ${canvas?.scene?.tokenVision}, globalIllum: ${this._isGlobalIlluminationActive()}`);

    this._queueUpgradeTargets();
  }

  /**
   * Console-callable diagnostic — run `MapShine.fogEffect.diagnose()` in the
   * browser console to get a snapshot of all relevant fog state.
   */
  diagnose() {
    const fp = this.fogPlane;
    const isGM = game?.user?.isGM ?? false;
    const controlled = canvas?.tokens?.controlled || [];
    const msSelection = window.MapShine?.interactionManager?.selection;
    const info = {
      initialized: this._initialized,
      enabled: this.enabled,
      paramsEnabled: this.params.enabled,
      fogPlaneExists: !!fp,
      fogPlaneVisible: fp?.visible,
      fogPlaneLayer: fp?.layers?.mask,
      fogPlaneRenderOrder: fp?.renderOrder,
      fogPlanePosition: fp ? `(${fp.position.x.toFixed(0)}, ${fp.position.y.toFixed(0)}, ${fp.position.z.toFixed(2)})` : 'N/A',
      fogPlaneInScene: fp ? this.mainScene?.children?.includes(fp) : false,
      fullResTargetsReady: this._fullResTargetsReady,
      visionRTSize: `${this._visionRTWidth}x${this._visionRTHeight}`,
      explorationRTSize: `${this._explorationRTWidth}x${this._explorationRTHeight}`,
      needsVisionUpdate: this._needsVisionUpdate,
      hasValidVision: this._hasValidVision,
      visionRetryFrames: this._visionRetryFrames,
      bypassFog: this._shouldBypassFog(),
      tokenVision: canvas?.scene?.tokenVision ?? 'undefined',
      globalIllumination: this._isGlobalIlluminationActive(),
      isGM,
      foundryControlled: controlled.map(t => t.name),
      mapShineSelection: msSelection ? Array.from(msSelection) : [],
      explorationEnabled: canvas?.scene?.fog?.exploration ?? false,
      explorationLoaded: this._explorationLoadedFromFoundry,
      explorationLoadGeneration: this._explorationLoadGeneration,
      visionIsFullSceneFallback: this._visionIsFullSceneFallback,
      pendingAccumulation: this._pendingAccumulation,
      explorationDirty: this._explorationDirty,
    };

    // Also check token vision data
    const allTokens = [...controlled];
    if (msSelection && window.MapShine?.tokenManager?.tokenSprites) {
      const placeables = canvas?.tokens?.placeables || [];
      for (const id of msSelection) {
        if (!window.MapShine.tokenManager.tokenSprites.has(id)) continue;
        const t = placeables.find(p => p.document?.id === id);
        if (t && !allTokens.includes(t)) allTokens.push(t);
      }
    }
    info.tokenDiag = allTokens.map(t => {
      const vs = t.vision;
      const shape = vs?.los || vs?.shape || vs?.fov;
      return {
        name: t.name,
        sightEnabled: t.document?.sight?.enabled ?? false,
        hasVision: !!vs,
        visionActive: vs?.active ?? 'N/A',
        hasLos: !!vs?.los,
        losPoints: vs?.los?.points?.length || 0,
        hasShape: !!vs?.shape,
        shapePoints: vs?.shape?.points?.length || 0,
        hasFov: !!vs?.fov,
        fovPoints: vs?.fov?.points?.length || 0,
      };
    });

    console.table(info);
    console.log('[FOG DIAGNOSE] Full state:', info);
    if (info.tokenDiag.length > 0) {
      console.table(info.tokenDiag);
    }
    return info;
  }

  _createMinimalTargets() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._visionRTWidth = 1;
    this._visionRTHeight = 1;
    this._explorationRTWidth = 1;
    this._explorationRTHeight = 1;

    try {
      if (this.visionRenderTarget) {
        this.visionRenderTarget.dispose();
        this.visionRenderTarget = null;
      }
    } catch (_) {
    }

    try {
      if (this._explorationTargetA) {
        this._explorationTargetA.dispose();
        this._explorationTargetA = null;
      }
      if (this._explorationTargetB) {
        this._explorationTargetB.dispose();
        this._explorationTargetB = null;
      }
    } catch (_) {
    }

    this.visionRenderTarget = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
    });

    this.visionScene = new THREE.Scene();

    const w = Math.max(1, this.sceneRect?.width ?? 1);
    const h = Math.max(1, this.sceneRect?.height ?? 1);
    this.visionCamera = new THREE.OrthographicCamera(
      0, w,
      h, 0,
      0, 100
    );
    this.visionCamera.position.set(0, 0, 10);

    this.visionMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide
    });

    const rtOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
    };

    this._explorationTargetA = new THREE.WebGLRenderTarget(1, 1, rtOptions);
    this._explorationTargetB = new THREE.WebGLRenderTarget(1, 1, rtOptions);
    this._currentExplorationTarget = 'A';

    this.explorationScene = new THREE.Scene();
    this.explorationCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
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

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.explorationMaterial);
    this.explorationScene.add(quad);

    this._fullResTargetsReady = false;
  }

  _queueUpgradeTargets() {
    if (this._fullResTargetsQueued) return;
    this._fullResTargetsQueued = true;

    setTimeout(() => {
      this._fullResTargetsQueued = false;
      this._upgradeTargetsToFullRes();
    }, 0);
  }

  _upgradeTargetsToFullRes() {
    if (!this._initialized) return;
    if (!this.renderer) return;
    const THREE = window.THREE;
    if (!THREE) return;

    try {
      if (this.visionRenderTarget) {
        this.visionRenderTarget.dispose();
        this.visionRenderTarget = null;
      }
      if (this._explorationTargetA) {
        this._explorationTargetA.dispose();
        this._explorationTargetA = null;
      }
      if (this._explorationTargetB) {
        this._explorationTargetB.dispose();
        this._explorationTargetB = null;
      }
    } catch (_) {
    }

    this._createVisionRenderTarget();
    this._createExplorationRenderTarget();

    // Create or resize the SDF generator to match the vision RT resolution
    if (this._visionSDF) {
      this._visionSDF.resize(this._visionRTWidth, this._visionRTHeight);
    } else {
      this._visionSDF = new VisionSDF(this.renderer, this._visionRTWidth, this._visionRTHeight);
      this._visionSDF.initialize();
    }

    try {
      if (this.fogMaterial?.uniforms?.tVision && this.visionRenderTarget?.texture) {
        this.fogMaterial.uniforms.tVision.value = this.visionRenderTarget.texture;
      }
    } catch (_) {
    }

    this._fullResTargetsReady = true;
    this._explorationLoadedFromFoundry = false;
    this._explorationLoadAttempts = 0;
    this._needsVisionUpdate = true;
    this._hasValidVision = false;

    log.info(`Full-res render targets ready — vision: ${this._visionRTWidth}x${this._visionRTHeight}, exploration: ${this._explorationRTWidth}x${this._explorationRTHeight}, SDF: ${!!this._visionSDF}`);
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
    const maxTexSize = this.renderer?.capabilities?.maxTextureSize ?? 2048;
    // PERF: Keep fog RT size modest. 4096^2 readbacks (exploration persistence)
    // can be extremely expensive and cause long-task hitches.
    const maxSize = Math.min(2048, maxTexSize);
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const rtWidth = Math.ceil(width * scale);
    const rtHeight = Math.ceil(height * scale);

    this._visionRTWidth = rtWidth;
    this._visionRTHeight = rtHeight;
    
    this.visionRenderTarget = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
      // No MSAA — unnecessary for a binary white/black vision mask.
      // LinearFilter already smooths edges. MSAA would add 4x fragment
      // cost and can cause texture-resolve issues when this RT is sampled
      // in the exploration accumulation shader on some drivers.
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

    // Material for drawing darkness source shapes (black = not visible).
    // Rendered AFTER vision/light shapes to subtract darkness areas.
    this.darknessMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
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
    const maxTexSize = this.renderer?.capabilities?.maxTextureSize ?? 2048;
    // PERF: Match vision target cap. This directly impacts the cost of
    // readRenderTargetPixels when persisting exploration.
    const maxSize = Math.min(2048, maxTexSize);
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const rtWidth = Math.ceil(width * scale);
    const rtHeight = Math.ceil(height * scale);

    this._explorationRTWidth = rtWidth;
    this._explorationRTHeight = rtHeight;
    
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
    
    // Create shader material for fog compositing.
    // Vision edges use a Signed Distance Field (SDF) generated by VisionSDF
    // via Jump Flood Algorithm, producing perfectly smooth edges regardless
    // of the input polygon's vertex density. Falls back to the legacy
    // sampleSoft() multi-tap blur when the SDF is unavailable.
    this.fogMaterial = new THREE.ShaderMaterial({
      extensions: {
        derivatives: true
      },
      uniforms: {
        tVision: { value: this.visionRenderTarget.texture },
        tVisionSDF: { value: this._fallbackBlack },
        tExplored: { value: this._fallbackBlack },
        uUnexploredColor: { value: new THREE.Color(0x000000) },
        uExploredColor: { value: new THREE.Color(0x000000) },
        uExploredOpacity: { value: 0.5 },
        uBypassFog: { value: 0.0 },
        uSoftnessPx: { value: 2.0 },
        uTime: { value: 0.0 },
        uNoiseStrengthPx: { value: 0.0 },
        uNoiseSpeed: { value: 0.0 },
        uNoiseScale: { value: 3.0 },
        uVisionTexelSize: { value: new THREE.Vector2(1, 1) },
        uExploredTexelSize: { value: new THREE.Vector2(1, 1) },
        uUseSDF: { value: 0.0 },
        uSDFMaxDistance: { value: 32.0 }
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
        uniform sampler2D tVisionSDF;
        uniform sampler2D tExplored;
        uniform vec3 uUnexploredColor;
        uniform vec3 uExploredColor;
        uniform float uExploredOpacity;
        uniform float uBypassFog;
        uniform float uSoftnessPx;
        uniform float uTime;
        uniform float uNoiseStrengthPx;
        uniform float uNoiseSpeed;
        uniform float uNoiseScale;
        uniform vec2 uVisionTexelSize;
        uniform vec2 uExploredTexelSize;
        uniform float uUseSDF;
        uniform float uSDFMaxDistance;

        varying vec2 vUv;

        // --- Noise for edge distortion ---
        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 345.45));
          p += dot(p, p + 34.345);
          return fract(p.x * p.y);
        }

        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        // --- Legacy multi-tap blur for exploration edges (and SDF fallback) ---
        float sampleSoft(sampler2D tex, vec2 uv, vec2 texel, float radiusPx) {
          float r = clamp(radiusPx, 0.0, 32.0);
          if (r <= 0.01) return texture2D(tex, uv).r;

          vec2 d1 = texel * max(1.0, r * 0.5);
          vec2 d2 = texel * max(1.0, r);

          float c = texture2D(tex, uv).r * 0.25;

          float cross = 0.0;
          cross += texture2D(tex, uv + vec2(d1.x, 0.0)).r;
          cross += texture2D(tex, uv + vec2(-d1.x, 0.0)).r;
          cross += texture2D(tex, uv + vec2(0.0, d1.y)).r;
          cross += texture2D(tex, uv + vec2(0.0, -d1.y)).r;

          float diag = 0.0;
          diag += texture2D(tex, uv + vec2(d2.x, d2.y)).r;
          diag += texture2D(tex, uv + vec2(-d2.x, d2.y)).r;
          diag += texture2D(tex, uv + vec2(d2.x, -d2.y)).r;
          diag += texture2D(tex, uv + vec2(-d2.x, -d2.y)).r;

          return c + cross * 0.125 + diag * 0.0625;
        }

        // --- SDF-based vision sampling ---
        // The SDF texture stores normalized signed distance:
        //   0.5 = on edge, >0.5 = inside (visible), <0.5 = outside (fog)
        // We convert back to pixel distance and apply a smooth edge.
        //
        // Key insight: fwidth(signedDist) tells us how many SDF pixels
        // correspond to one screen pixel. Using this as the minimum edge
        // width ensures the anti-aliased transition is always ~1 screen
        // pixel wide — producing clean sharp lines at any zoom level,
        // without the staircase pattern from low-res texture sampling.
        float sampleVisionSDF(vec2 uv, float softnessPx) {
          float sdfVal = texture2D(tVisionSDF, uv).r;

          // Convert from normalized [0,1] back to signed pixel distance
          // (positive = inside visible area, negative = outside)
          float signedDist = (sdfVal - 0.5) * 2.0 * uSDFMaxDistance;

          // Screen-adaptive anti-aliasing: fwidth gives the rate of change
          // of signedDist per screen pixel. For a smooth SDF this is ~1.0
          // at edges. Using it as minimum edge width ensures a 1-screen-pixel
          // anti-aliased transition regardless of zoom level.
          float screenAA = fwidth(signedDist) * 0.75;
          float edgeWidth = max(softnessPx, max(screenAA, 0.5));
          return smoothstep(-edgeWidth, edgeWidth, signedDist);
        }
        
        void main() {
          if (uBypassFog > 0.5) {
            discard;
          }
          
          // --- Noise-based UV warp for organic edge distortion ---
          float t = uTime * uNoiseSpeed;
          vec2 nUv = vUv * uNoiseScale + vec2(t * 0.11, t * 0.07);
          float n0 = noise2(nUv);
          float n1 = noise2(nUv + 17.31);
          vec2 n = vec2(n0, n1) - 0.5;
          float noiseUvScale = max(max(uVisionTexelSize.x, uVisionTexelSize.y), max(uExploredTexelSize.x, uExploredTexelSize.y));
          vec2 uvWarp = n * (uNoiseStrengthPx * noiseUvScale);

          // UV needs Y-flip because Three.js plane UVs are bottom-left origin
          // but our vision camera renders with top-left origin (Foundry coords)
          vec2 visionUv = vec2(vUv.x, 1.0 - vUv.y) + uvWarp;

          // --- Sample vision: SDF path (smooth) or legacy path (multi-tap blur) ---
          float visible;
          if (uUseSDF > 0.5) {
            // SDF path: perfectly smooth edges from the JFA distance field
            visible = sampleVisionSDF(visionUv, uSoftnessPx);
          } else {
            // Legacy fallback: multi-tap blur + fwidth threshold
            float vision = sampleSoft(tVision, visionUv, uVisionTexelSize, uSoftnessPx);
            float softnessPx = max(uSoftnessPx, 0.0);
            float dv = max(fwidth(vision), 1e-4);
            float dVisPx = (vision - 0.5) / dv;
            visible = (softnessPx <= 0.01)
              ? step(0.5, vision)
              : smoothstep(-softnessPx, softnessPx, dVisPx);
          }
          
          // --- Exploration: always uses sampleSoft (no SDF for exploration yet) ---
          vec2 exploredUv = vec2(vUv.x, 1.0 - vUv.y) + uvWarp;
          float explored = sampleSoft(tExplored, exploredUv, uExploredTexelSize, uSoftnessPx);
          float softnessPxE = max(uSoftnessPx, 0.0);
          float de = max(fwidth(explored), 1e-4);
          float dExpPx = (explored - 0.5) / de;
          float exploredMask = (softnessPxE <= 0.01)
            ? step(0.5, explored)
            : smoothstep(-softnessPxE, softnessPxE, dExpPx);

          // --- Compose fog ---
          float fogAlpha = 1.0 - visible;
          float exploredAlpha = mix(1.0, uExploredOpacity, exploredMask);
          vec3 fogColor = mix(uUnexploredColor, uExploredColor, exploredMask);
          float outAlpha = fogAlpha * exploredAlpha;

          if (outAlpha <= 0.001) {
            discard;
          }

          gl_FragColor = vec4(fogColor, outAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,  // Disable depth test - fog always renders on top via renderOrder
      side: THREE.DoubleSide
    });
    
    // Create plane geometry covering the scene rect
    const geometry = new THREE.PlaneGeometry(width, height);
    
    this.fogPlane = new THREE.Mesh(geometry, this.fogMaterial);
    this.fogPlane.name = 'FogOverlayPlane';
    
    // Ensure fog renders on top of everything in the scene
    this.fogPlane.renderOrder = 9999;
    this.fogPlane.layers.set(OVERLAY_THREE_LAYER);
    
    // Position the plane in Three.js world space
    // Three.js: origin bottom-left, Y-up
    // Scene rect center in Three.js coords:
    const centerX = x + width / 2;
    const centerY = this.sceneDimensions.height - (y + height / 2);
    
    // Position fog plane relative to groundZ
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.fogPlane.position.set(centerX, centerY, groundZ + FOG_PLANE_Z_OFFSET);
    
    // Frustum culling off - always render
    this.fogPlane.frustumCulled = false;
    
    // Add to main scene
    this.mainScene.add(this.fogPlane);
    
    log.debug(`Fog plane created at (${centerX}, ${centerY}, ${groundZ + FOG_PLANE_Z_OFFSET}), size ${width}x${height}`);
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
    this._hookIds.push(['controlToken', Hooks.on('controlToken', (token, controlled) => {
      // When token control changes, ensure Foundry recomputes
      // perception so that vision polygons exist before we
      // render the vision mask for the newly controlled token.
      log.debug(`controlToken hook: ${token?.name} controlled=${controlled}, forcing perception update`);
      frameCoordinator.forcePerceptionUpdate();
      this._needsVisionUpdate = true;
      this._hasValidVision = false; // Reset until we get valid LOS polygons
    })]);
    this._hookIds.push(['updateToken', Hooks.on('updateToken', () => { this._needsVisionUpdate = true; })]);
    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => { this._needsVisionUpdate = true; })]);
    this._hookIds.push(['lightingRefresh', Hooks.on('lightingRefresh', () => { this._needsVisionUpdate = true; })]);
    
    // Initial render: force perception so that any starting
    // controlled token (or vision source) has a valid LOS
    // polygon before the first fog mask is drawn.
    frameCoordinator.forcePerceptionUpdate();
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
    
    // Resolve vision tokens:
    // 1) Prefer MapShine's interactionManager selection (Three.js-driven UI)
    // 2) Fallback to Foundry's canvas.tokens.controlled
    // 3) For non-GM users only: if nothing is selected/controlled, use all owned tokens
    let controlledTokens = [];
    const ms = window.MapShine;
    const interactionManager = ms?.interactionManager;
    const tokenManager = ms?.tokenManager;
    const selection = interactionManager?.selection;
    const isGM = game?.user?.isGM ?? false;

    if (selection && tokenManager?.tokenSprites) {
      const placeables = canvas?.tokens?.placeables || [];
      const selectedIds = Array.from(selection);
      for (const id of selectedIds) {
        if (!tokenManager.tokenSprites.has(id)) continue;
        const token = placeables.find(t => t.document?.id === id);
        if (token) controlledTokens.push(token);
      }
    }

    // Fallback: use Foundry's native controlled tokens if MapShine selection is empty
    if (!controlledTokens.length) {
      controlledTokens = canvas?.tokens?.controlled || [];
    }

    // Player default: when nothing is selected/controlled, show combined vision of owned tokens.
    if (!isGM && !controlledTokens.length) {
      try {
        const user = game?.user;
        const placeables = canvas?.tokens?.placeables || [];
        if (user && placeables.length) {
          controlledTokens = placeables.filter(t => {
            const doc = t?.document;
            if (!doc) return false;
            if (t?.isOwner === true) return true;
            if (doc?.isOwner === true) return true;
            if (typeof doc?.testUserPermission === 'function') {
              try {
                return doc.testUserPermission(user, 'OWNER');
              } catch (_) {
                return false;
              }
            }
            return false;
          });
        }
      } catch (_) {
        // Ignore ownership resolution errors
      }
    }

    // Always log when we have controlled tokens but no vision yet (state transition diagnostic)
    if (controlledTokens.length > 0 && !this._hasValidVision) {
      const visionSources = canvas?.effects?.visionSources;
      log.debug(`[FOG DIAG] Vision sources: ${visionSources?.size || 0}, controlled: ${controlledTokens.length}, retryFrame: ${this._visionRetryFrames}`);
      for (const token of controlledTokens) {
        const vs = token.vision;
        const hasSight = token.document?.sight?.enabled ?? false;
        const shape = vs?.los || vs?.shape || vs?.fov;
        log.debug(`  [FOG DIAG] Token "${token.name}": sight.enabled=${hasSight}, vision=${!!vs}, active=${vs?.active ?? 'N/A'}, los=${!!vs?.los}, shape=${!!vs?.shape}, fov=${!!vs?.fov}, points=${shape?.points?.length || 0}`);
      }
    }
    
    // Global illumination means the token can see in the dark — but it does
    // NOT bypass walls or sight range. Foundry's LOS polygon already accounts
    // for global illumination when computing visibility. We should always use
    // the token's actual LOS polygon when it exists.
    //
    // For tokens whose LOS is degenerate (e.g. sight.range=0), global
    // illumination uses a full-scene rect so they aren't blind. However,
    // the _visionIsFullSceneFallback flag prevents this from being
    // accumulated into exploration (which would permanently mark areas
    // behind walls as explored via the max() accumulator).
    const globalIllumActive = this._isGlobalIlluminationActive();
    this._visionIsFullSceneFallback = false;

    // Categorize tokens into three groups:
    // - tokensWithValidLOS: have a vision source with a valid polygon
    // - tokensWaitingForLOS: have sight enabled and a vision source, but LOS hasn't computed yet
    // - tokensWithoutSight: don't have sight enabled or have no vision source at all
    // Only tokensWaitingForLOS should trigger retries. tokensWithoutSight are simply skipped.
    let polygonsRendered = 0;
    let tokensWaitingForLOS = 0;
    let tokensWithoutSight = 0;

    for (const token of controlledTokens) {
      const visionSource = token.vision;
      const hasSight = token.document?.sight?.enabled ?? false;

      // Token has no vision source at all. If sight isn't enabled on the
      // token, this is expected — skip it without triggering retries.
      if (!visionSource) {
        if (!hasSight) {
          tokensWithoutSight++;
        } else if (globalIllumActive) {
          // Sight enabled, no vision source yet, but global illumination is
          // active — render full-scene rect so the token isn't blind.
          // Flag prevents this from polluting exploration.
          this._addFullSceneRect(THREE);
          this._visionIsFullSceneFallback = true;
          polygonsRendered++;
        } else {
          // Sight is enabled but vision source hasn't been created yet — wait.
          tokensWaitingForLOS++;
          log.debug(`[FOG DIAG] Token "${token.name}" has sight enabled but no vision source yet — waiting`);
        }
        continue;
      }

      // Vision source exists — check if the LOS polygon has been computed.
      let shape = visionSource.los || visionSource.shape || visionSource.fov;

      if (!shape || !shape.points || shape.points.length < 6) {
        if (!hasSight) {
          // Sight disabled — token has a default/inactive vision source.
          tokensWithoutSight++;
        } else if (globalIllumActive) {
          // Sight enabled, LOS is tiny/missing (e.g. sight.range=0), but
          // global illumination is active. Use full-scene rect so the
          // token can see. Flag prevents exploration pollution.
          this._addFullSceneRect(THREE);
          this._visionIsFullSceneFallback = true;
          polygonsRendered++;
        } else {
          // Sight enabled but polygon not ready yet.
          tokensWaitingForLOS++;
          log.debug(`[FOG DIAG] Token "${token.name}" sight enabled, LOS not ready (points=${shape?.points?.length || 0})`);
        }
        continue;
      }

      // Valid LOS polygon — always use it, regardless of global illumination.
      // Global illumination affects lighting, not wall occlusion.
      const points = shape.points;
      const threeShape = new THREE.Shape();
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
    }

    // Phase 2: Light-Grants-Vision
    // Light sources with data.vision === true grant visibility within their area.
    // Draw their shapes into the vision mask alongside token LOS polygons.
    try {
      const lightSources = canvas?.effects?.lightSources;
      if (lightSources) {
        for (const lightSource of lightSources) {
          if (!lightSource.active || !lightSource.data?.vision) continue;
          // Skip GlobalLightSource — handled separately via _isGlobalIlluminationActive
          if (lightSource.constructor?.name === 'GlobalLightSource') continue;

          const shape = lightSource.shape;
          if (!shape?.points || shape.points.length < 6) continue;

          const pts = shape.points;
          const lightShape = new THREE.Shape();
          const offsetX = this.sceneRect.x;
          const offsetY = this.sceneRect.y;

          lightShape.moveTo(pts[0] - offsetX, pts[1] - offsetY);
          for (let i = 2; i < pts.length; i += 2) {
            lightShape.lineTo(pts[i] - offsetX, pts[i + 1] - offsetY);
          }
          lightShape.closePath();

          const geo = new THREE.ShapeGeometry(lightShape);
          const lightMesh = new THREE.Mesh(geo, this.visionMaterial);
          this.visionScene.add(lightMesh);
          polygonsRendered++;
        }
      }
    } catch (e) {
      log.warn('Failed to render light-grants-vision shapes:', e);
    }

    // Phase 5: Darkness Source Integration
    // Darkness-emitting lights (PointDarknessSource) suppress vision within their area.
    // Draw their shapes in black AFTER vision/light shapes to subtract those zones.
    // Foundry stores these in canvas.effects.darknessSources (v12+).
    try {
      const darknessSources = canvas?.effects?.darknessSources;
      if (darknessSources) {
        for (const darknessSource of darknessSources) {
          if (!darknessSource.active) continue;

          const shape = darknessSource.shape;
          if (!shape?.points || shape.points.length < 6) continue;

          const pts = shape.points;
          const darkShape = new THREE.Shape();
          const offsetX = this.sceneRect.x;
          const offsetY = this.sceneRect.y;

          darkShape.moveTo(pts[0] - offsetX, pts[1] - offsetY);
          for (let i = 2; i < pts.length; i += 2) {
            darkShape.lineTo(pts[i] - offsetX, pts[i + 1] - offsetY);
          }
          darkShape.closePath();

          const geo = new THREE.ShapeGeometry(darkShape);
          const darkMesh = new THREE.Mesh(geo, this.darknessMaterial);
          // Render darkness shapes slightly in front of vision shapes so they
          // overwrite (subtract) the white areas in the same render pass.
          darkMesh.renderOrder = 1;
          this.visionScene.add(darkMesh);
        }
      }
    } catch (e) {
      log.warn('Failed to render darkness source shapes:', e);
    }
    
    // Render to the vision target (always render, even if no polygons —
    // that gives us a black texture = "nothing visible" = full fog)
    const currentTarget = this.renderer.getRenderTarget();
    const currentClearColor = this.renderer.getClearColor(new THREE.Color());
    const currentClearAlpha = this.renderer.getClearAlpha();
    
    this.renderer.setRenderTarget(this.visionRenderTarget);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(this.visionScene, this.visionCamera);
    
    this.renderer.setRenderTarget(currentTarget);
    this.renderer.setClearColor(currentClearColor, currentClearAlpha);
    
    // Determine result state.
    //
    // Key distinction: tokens without sight are NOT "invalid" — they simply
    // don't contribute vision. Only tokens that SHOULD have LOS (sight enabled)
    // but DON'T yet should trigger retries.
    //
    // tokensWithSightRequirement = total tokens that should have LOS
    const tokensWithSightRequirement = controlledTokens.length - tokensWithoutSight;

    if (controlledTokens.length === 0) {
      // No controlled tokens at all — mark complete, bypass handles visibility
      this._needsVisionUpdate = false;
      this._hasValidVision = true;
    } else if (tokensWithSightRequirement === 0) {
      // All controlled tokens lack sight — vision RT is intentionally black
      // (full fog). This is valid; don't retry.
      this._needsVisionUpdate = false;
      this._hasValidVision = true;
      log.debug(`[FOG DIAG] All ${controlledTokens.length} controlled tokens lack sight → full fog`);
    } else if (tokensWaitingForLOS > 0 && polygonsRendered === 0) {
      // Some tokens should have LOS but none are ready yet — keep retrying
      frameCoordinator.forcePerceptionUpdate();
      this._hasValidVision = false;
      log.debug(`[FOG DIAG] Waiting for LOS: ${tokensWaitingForLOS} tokens pending, ${polygonsRendered} rendered`);
    } else {
      // We rendered at least some polygons, or all sight-enabled tokens were
      // handled. Mark as valid — partial vision is better than no fog at all.
      this._needsVisionUpdate = false;
      this._hasValidVision = true;
      if (tokensWaitingForLOS > 0) {
        // Some tokens still waiting but we have at least partial vision.
        // Trigger another perception update but don't block fog display.
        frameCoordinator.forcePerceptionUpdate();
        this._needsVisionUpdate = true;
        log.debug(`[FOG DIAG] Partial vision: ${polygonsRendered} rendered, ${tokensWaitingForLOS} still waiting`);
      }
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

  /**
   * Add a full-scene white rectangle to the vision scene.
   * Used as a fallback when global illumination is active and a token's
   * LOS polygon is unavailable or too small (e.g. sight.range = 0).
   * IMPORTANT: callers must set _visionIsFullSceneFallback = true so that
   * exploration accumulation is skipped — otherwise the full-scene white
   * would be max()'d into the exploration texture permanently, marking
   * areas behind walls as explored.
   * @param {object} THREE - Three.js namespace
   * @private
   */
  _addFullSceneRect(THREE) {
    const w = Math.max(1, this.sceneRect.width);
    const h = Math.max(1, this.sceneRect.height);
    const fullShape = new THREE.Shape();
    fullShape.moveTo(0, 0);
    fullShape.lineTo(w, 0);
    fullShape.lineTo(w, h);
    fullShape.lineTo(0, h);
    fullShape.closePath();
    const geometry = new THREE.ShapeGeometry(fullShape);
    const mesh = new THREE.Mesh(geometry, this.visionMaterial);
    this.visionScene.add(mesh);
  }

  /**
   * Check if Foundry's global illumination is active. Used to decide whether
   * tokens with degenerate LOS polygons (sight.range=0) should get a
   * full-scene vision rect. Exploration accumulation is guarded separately
   * by _visionIsFullSceneFallback.
   * @returns {boolean}
   * @private
   */
  _isGlobalIlluminationActive() {
    try {
      const gls = canvas?.environment?.globalLightSource;
      if (gls?.active) {
        const darknessLevel = canvas.environment.darknessLevel ?? 0;
        const { min = 0, max = 1 } = gls.data?.darkness ?? {};
        if (darknessLevel >= min && darknessLevel <= max) return true;
      }
    } catch (_) {}
    try {
      const globalLight = canvas?.scene?.environment?.globalLight?.enabled
                       ?? canvas?.scene?.globalLight ?? false;
      if (globalLight) {
        const darkness = canvas?.scene?.environment?.darknessLevel
                      ?? canvas?.scene?.darkness ?? 0;
        if (darkness < 0.5) return true;
      }
    } catch (_) {}
    return false;
  }

  update(timeInfo) {
    if (!this._initialized || !this.fogPlane) return;
    
    // Check if fog should be bypassed
    const bypassFog = this._shouldBypassFog();
    this.fogMaterial.uniforms.uBypassFog.value = bypassFog ? 1.0 : 0.0;

    // Prewarm exploration loading even while fog is bypassed so the first
    // token selection doesn't stall.
    const explorationEnabled = canvas?.scene?.fog?.exploration ?? false;
    if (this.params.enabled && explorationEnabled) {
      this._ensureExplorationLoadedFromFoundry();
    }
    
    if (!this.params.enabled || bypassFog) {
      this.fogPlane.visible = false;
      this._visionRetryFrames = 0;
      return;
    }

    // Don't attempt vision rendering until full-res render targets are ready.
    // The 1x1 minimal targets created during init produce garbage results.
    if (!this._fullResTargetsReady) {
      this.fogPlane.visible = false;
      return;
    }
    
    // Detect MapShine selection changes (Three.js-driven UI) and trigger
    // a vision recompute when the set of selected token IDs changes.
    // IMPORTANT: This must run BEFORE _renderVisionMask() so we don't
    // render once, then immediately reset _hasValidVision and render again.
    try {
      const ms = window.MapShine;
      const interactionManager = ms?.interactionManager;
      const selection = interactionManager?.selection;
      let selectionVersion = '';
      if (selection && selection.size > 0) {
        const ids = Array.from(selection);
        ids.sort();
        selectionVersion = ids.join('|');
      }
      if (selectionVersion !== this._lastSelectionVersion) {
        this._lastSelectionVersion = selectionVersion;
        log.debug(`Selection changed → forcing perception update and vision recompute`);
        frameCoordinator.forcePerceptionUpdate();
        this._needsVisionUpdate = true;
        this._hasValidVision = false;
        this._visionRetryFrames = 0;
      }
    } catch (_) {
      // Ignore MapShine selection errors
    }

    // Render vision mask if needed (single call per frame, after all
    // invalidation checks above have had a chance to set _needsVisionUpdate).
    let visionRenderedThisFrame = false;
    if (this._needsVisionUpdate) {
      this._renderVisionMask();
      visionRenderedThisFrame = true;

      // Recompute the SDF from the freshly rendered vision mask.
      // This converts the hard-edged polygon raster into a smooth distance
      // field, eliminating scallop artifacts from low-density circle arcs.
      if (this._visionSDF && this.visionRenderTarget?.texture) {
        try {
          this._visionSDF.update(this.visionRenderTarget.texture);
          this._sdfUpdateFailed = false;
          if (!this._loggedSDFState) {
            this._loggedSDFState = true;
            log.info(`[SDF] Vision SDF active: size=${this._visionSDF.width}x${this._visionSDF.height}, maxDist=${this._visionSDF.maxDistance}, outputType=HalfFloat`);
          }
        } catch (e) {
          // If SDF fails (e.g. shader compile error), fall back to legacy path
          if (!this._sdfUpdateFailed) {
            log.warn('[SDF] Vision SDF update failed — falling back to legacy softening', e);
            this._sdfUpdateFailed = true;
          }
        }
      }
    }
    
    // Determine if we're stuck waiting for valid vision data.
    // After _maxVisionRetryFrames, give up and show fog anyway - this
    // prevents the fog plane from being permanently hidden when tokens
    // lack sight or Foundry's perception never provides valid LOS.
    const waitingForVision = this._needsVisionUpdate && !this._hasValidVision;
    if (waitingForVision) {
      this._visionRetryFrames++;
      if (this._visionRetryFrames >= this._maxVisionRetryFrames) {
        log.warn(`Vision retry limit reached (${this._maxVisionRetryFrames} frames). Forcing fog visible with current data.`);
        this._needsVisionUpdate = false;
        this._hasValidVision = true;
        this._visionRetryFrames = 0;
      } else {
        // Still waiting — hide fog plane and skip the rest of the update
        this.fogPlane.visible = false;
        return;
      }
    } else {
      this._visionRetryFrames = 0;
    }

    // Fog plane is visible
    this.fogPlane.visible = true;
    
    // Accumulate exploration if enabled and prior state has been loaded.
    // Don't accumulate before loading — otherwise we'd start from black,
    // mark dirty, and overwrite the existing FogExploration document.
    // PERF: Only accumulate when vision was actually re-rendered this frame,
    // OR when we have a pending catch-up accumulation from a frame where
    // vision rendered but exploration wasn't loaded yet.
    this._ensureExplorationLoadedFromFoundry();
    const canAccumulate = explorationEnabled && this._explorationLoadedFromFoundry;

    if (visionRenderedThisFrame && !canAccumulate) {
      // Vision rendered but exploration not ready — remember to catch up later
      this._pendingAccumulation = true;
    }

    // CRITICAL: Never accumulate when the vision mask is a full-scene fallback
    // (from global illumination + degenerate LOS). The full-scene white rect
    // covers areas behind walls, and max() accumulation would permanently
    // mark them as explored. Only accumulate from real LOS polygons.
    const shouldAccumulate = canAccumulate
      && (visionRenderedThisFrame || this._pendingAccumulation)
      && !this._visionIsFullSceneFallback;
    if (shouldAccumulate) {
      this._accumulateExploration();
      this._markExplorationDirty();
      this._pendingAccumulation = false;
    }

    // One-shot diagnostic: log exploration accumulation state on first opportunity
    if (!this._loggedExplorationState) {
      this._loggedExplorationState = true;
      log.info(`[FOG DIAG] Exploration state: enabled=${explorationEnabled}, loaded=${this._explorationLoadedFromFoundry}, canAccumulate=${canAccumulate}, shouldAccumulate=${shouldAccumulate}, explorationRTSize=${this._explorationRTWidth}x${this._explorationRTHeight}`);
    }
    
    // Use our self-maintained exploration texture (NOT Foundry's pre-populated one)
    const exploredTex = explorationEnabled
      ? (this._getExplorationReadTarget()?.texture || this._fallbackBlack)
      : this._fallbackBlack;

    // --- Always update all uniforms when the fog plane is visible ---
    this.fogMaterial.uniforms.tExplored.value = exploredTex;

    // Bind the SDF texture for smooth vision edges (falls back to raw vision mask).
    // If the SDF update failed (shader compile error, GPU issue), force legacy path.
    const sdfTex = this._sdfUpdateFailed ? null : this._visionSDF?.getTexture();
    if (sdfTex) {
      this.fogMaterial.uniforms.tVisionSDF.value = sdfTex;
      this.fogMaterial.uniforms.uUseSDF.value = 1.0;
      this.fogMaterial.uniforms.uSDFMaxDistance.value = this._visionSDF.maxDistance;
    } else {
      this.fogMaterial.uniforms.uUseSDF.value = 0.0;
    }

    const vtW = Math.max(1, this._visionRTWidth);
    const vtH = Math.max(1, this._visionRTHeight);
    const etW = Math.max(1, this._explorationRTWidth);
    const etH = Math.max(1, this._explorationRTHeight);
    this.fogMaterial.uniforms.uVisionTexelSize.value.set(1.0 / vtW, 1.0 / vtH);
    this.fogMaterial.uniforms.uExploredTexelSize.value.set(1.0 / etW, 1.0 / etH);
    this.fogMaterial.uniforms.uSoftnessPx.value = this.params.softness;
    this.fogMaterial.uniforms.uTime.value = timeInfo?.elapsed ?? 0.0;
    this.fogMaterial.uniforms.uNoiseStrengthPx.value = this.params.noiseStrength ?? 0.0;
    this.fogMaterial.uniforms.uNoiseSpeed.value = this.params.noiseSpeed ?? 0.0;
    
    this.fogMaterial.uniforms.uUnexploredColor.value.set(this.params.unexploredColor);
    this.fogMaterial.uniforms.uExploredColor.value.set(this.params.exploredColor);
    
    // If exploration is disabled, force explored opacity to 0 so only
    // current vision reveals the map.
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
    
    // Resize the SDF generator to match new vision RT dimensions
    if (this._visionSDF) {
      this._visionSDF.resize(this._visionRTWidth, this._visionRTHeight);
    }

    // Recreate exploration render targets at new size
    if (this._explorationTargetA) {
      this._explorationTargetA.dispose();
    }
    if (this._explorationTargetB) {
      this._explorationTargetB.dispose();
    }
    this._createExplorationRenderTarget();

    try {
      const maxAniso = this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 0;
      if (maxAniso > 0) {
        if (this.visionRenderTarget?.texture) this.visionRenderTarget.texture.anisotropy = maxAniso;
        if (this._explorationTargetA?.texture) this._explorationTargetA.texture.anisotropy = maxAniso;
        if (this._explorationTargetB?.texture) this._explorationTargetB.texture.anisotropy = maxAniso;
      }
    } catch (_) {
    }
    
    // Update fog plane geometry and position
    if (this.fogPlane) {
      this.mainScene.remove(this.fogPlane);
      this.fogPlane.geometry.dispose();
    }
    this._createFogPlane();
    
    this._needsVisionUpdate = true;
    this._explorationLoadedFromFoundry = false;
    this._explorationLoadAttempts = 0;
  }

  _markExplorationDirty() {
    this._explorationDirty = true;
    this._explorationCommitCount++;

    const threshold = canvas?.fog?.constructor?.COMMIT_THRESHOLD ?? 70;
    if (this._explorationCommitCount >= threshold) {
      this._explorationCommitCount = 0;
      if (this._saveExplorationDebounced) this._saveExplorationDebounced();
    }
  }

  _ensureExplorationLoadedFromFoundry() {
    if (this._explorationLoadedFromFoundry) return;
    if (this._isLoadingExploration) return;

    const tokenVisionEnabled = canvas?.scene?.tokenVision ?? false;
    const explorationEnabled = canvas?.scene?.fog?.exploration ?? false;

    if (!tokenVisionEnabled) {
      this._explorationLoadedFromFoundry = true;
      return;
    }
    if (!explorationEnabled) {
      this._explorationLoadedFromFoundry = true;
      return;
    }

    if (this._explorationLoadAttempts > 600) {
      this._explorationLoadedFromFoundry = true;
      return;
    }

    this._isLoadingExploration = true;

    const FogExplorationCls = CONFIG?.FogExploration?.documentClass;
    if (!FogExplorationCls || typeof FogExplorationCls.load !== 'function') {
      this._explorationLoadedFromFoundry = true;
      this._isLoadingExploration = false;
      return;
    }

    // Capture generation before async work so we can detect stale callbacks
    // (e.g. resetExploration() called while the load is in flight).
    const loadGeneration = this._explorationLoadGeneration;

    FogExplorationCls.load().then((doc) => {
      try {
        // Stale? A reset happened while we were loading — discard.
        if (loadGeneration !== this._explorationLoadGeneration) {
          log.debug('[FOG DIAG] Discarding stale FogExploration load (generation mismatch)');
          return;
        }

        const base64 = doc?.explored;
        if (!doc || !base64) {
          // No persisted fog exists yet for this user+scene (or it was reset).
          // Treat this as a successful "load" of a blank state.
          this._explorationLoadedFromFoundry = true;
          return;
        }

        // Expose it for consistency with Foundry's own fog manager state.
        try {
          if (canvas?.fog && !canvas.fog.exploration) canvas.fog.exploration = doc;
        } catch (_) {
          // Ignore
        }

        this._explorationLoadedFromFoundry = true;

        const THREE = window.THREE;
        const loader = new THREE.TextureLoader();
        loader.load(
          base64,
          (texture) => {
            try {
              // Second stale check: the image decode is also async and a reset
              // could have happened between the document load and texture decode.
              if (loadGeneration !== this._explorationLoadGeneration) {
                log.debug('[FOG DIAG] Discarding stale exploration texture (generation mismatch)');
                return;
              }
              // Avoid double Y-flips: our fog shader already flips explored sampling.
              texture.flipY = false;
              texture.needsUpdate = true;
              this._renderLoadedExplorationTexture(texture);
            } catch (e) {
              log.warn('Failed to apply saved fog exploration texture', e);
            } finally {
              try { texture.dispose?.(); } catch (_) {}
            }
          },
          undefined,
          (err) => {
            log.warn('Failed to load saved fog exploration texture', err);
          }
        );
      } finally {
        this._isLoadingExploration = false;
      }
    }).catch((e) => {
      this._isLoadingExploration = false;
      this._explorationLoadAttempts++;
      if (Math.random() < 0.1) log.warn('FogExploration.load() failed', e);
    });
  }

  _renderLoadedExplorationTexture(texture) {
    if (!this.renderer) return;
    if (!this._explorationTargetA || !this._explorationTargetB) return;

    const THREE = window.THREE;

    const copyMat = new THREE.MeshBasicMaterial({
      map: texture,
      blending: THREE.NoBlending,
      depthWrite: false,
      depthTest: false,
      transparent: false
    });
    const copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copyMat);
    const copyScene = new THREE.Scene();
    copyScene.add(copyQuad);

    const currentTarget = this.renderer.getRenderTarget();
    const currentClearColor = this.renderer.getClearColor(new THREE.Color());
    const currentClearAlpha = this.renderer.getClearAlpha();

    this.renderer.setClearColor(0x000000, 1);

    this.renderer.setRenderTarget(this._explorationTargetA);
    this.renderer.clear();
    this.renderer.render(copyScene, this.explorationCamera);

    this.renderer.setRenderTarget(this._explorationTargetB);
    this.renderer.clear();
    this.renderer.render(copyScene, this.explorationCamera);

    this.renderer.setRenderTarget(currentTarget);
    this.renderer.setClearColor(currentClearColor, currentClearAlpha);

    copyQuad.geometry.dispose();
    copyMat.dispose();

    this._currentExplorationTarget = 'A';
  }

  async _saveExplorationToFoundry() {
    const tokenVisionEnabled = canvas?.scene?.tokenVision ?? false;
    const explorationEnabled = canvas?.scene?.fog?.exploration ?? false;
    if (!tokenVisionEnabled || !explorationEnabled) return;
    if (!this._explorationDirty) return;
    if (this._isSavingExploration) return;
    if (!this.renderer) return;

    // PERF: Rate-limit saves to avoid regular long-task stalls.
    // Keep exploration dirty so it will eventually persist.
    const nowMs = Date.now();
    const minInterval = Number(this._minExplorationSaveIntervalMs) || 0;
    if (minInterval > 0 && (nowMs - (Number(this._lastExplorationSaveMs) || 0)) < minInterval) {
      return;
    }

    const explorationTarget = this._getExplorationReadTarget();
    if (!explorationTarget) return;

    this._isSavingExploration = true;

    // Mark save attempt time up-front so back-to-back triggers don't queue
    // multiple expensive readbacks.
    this._lastExplorationSaveMs = nowMs;

    try {
      const width = this._explorationRTWidth;
      const height = this._explorationRTHeight;
      const required = Math.max(0, Math.floor(width * height * 4));
      if (!this._explorationSaveBuffer || this._explorationSaveBuffer.length !== required) {
        this._explorationSaveBuffer = new Uint8Array(required);
      }
      const buffer = this._explorationSaveBuffer;

      // PERF: Large single-call readbacks can cause long stalls.
      // Read the render target in smaller tiles and yield between batches.
      await this._readRenderTargetPixelsTiled(explorationTarget, width, height, buffer);

      const base64 = await this._encodeExplorationBase64(buffer, width, height);
      if (!base64) return;

      const fogMgr = canvas?.fog;
      if (!fogMgr) return;

      let doc = fogMgr.exploration;
      const FogExplorationCls = CONFIG?.FogExploration?.documentClass;
      if (!FogExplorationCls) return;

      const updateData = {
        scene: canvas?.scene?.id,
        user: game?.user?.id,
        explored: base64,
        timestamp: Date.now()
      };

      if (!doc) {
        // Match Foundry: create a new document and persist it
        const tmp = new FogExplorationCls();
        tmp.updateSource(updateData);
        doc = await FogExplorationCls.create(tmp.toJSON(), { loadFog: false });
        try { fogMgr.exploration = doc; } catch (_) {}
      } else if (!doc.id) {
        doc.updateSource(updateData);
        doc = await doc.constructor.create(doc.toJSON(), { loadFog: false });
        try { fogMgr.exploration = doc; } catch (_) {}
      } else {
        await doc.update(updateData, { loadFog: false });
      }

      this._explorationDirty = false;
    } catch (e) {
      log.warn('Failed to save fog exploration', e);
    } finally {
      this._isSavingExploration = false;
    }
  }

  async _readRenderTargetPixelsTiled(renderTarget, width, height, outBuffer) {
    if (!this.renderer) return;
    if (!renderTarget) return;
    if (!outBuffer) return;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

    const tileSize = Math.max(32, Math.min(1024, Math.floor(this._explorationReadbackTileSize || 256)));
    const maxBytes = tileSize * tileSize * 4;
    if (!this._explorationReadbackTileBuffer || this._explorationReadbackTileBuffer.byteLength !== maxBytes) {
      this._explorationReadbackTileBuffer = new Uint8Array(maxBytes);
    }
    const tileBuf = this._explorationReadbackTileBuffer;

    let tilesSinceYield = 0;
    const yieldEvery = 8;

    for (let y0 = 0; y0 < height; y0 += tileSize) {
      const th = Math.min(tileSize, height - y0);
      for (let x0 = 0; x0 < width; x0 += tileSize) {
        const tw = Math.min(tileSize, width - x0);
        const needed = tw * th * 4;
        const view = tileBuf.subarray(0, needed);

        // This call is synchronous; keeping tw/th small reduces worst-case stall.
        this.renderer.readRenderTargetPixels(renderTarget, x0, y0, tw, th, view);

        // Copy into the final packed buffer.
        // Render target data is bottom-left origin in WebGL space; the encoding path
        // already expects the raw buffer in the same orientation as readRenderTargetPixels.
        for (let row = 0; row < th; row++) {
          const srcOff = row * tw * 4;
          const dstOff = ((y0 + row) * width + x0) * 4;
          outBuffer.set(view.subarray(srcOff, srcOff + tw * 4), dstOff);
        }

        tilesSinceYield++;
        if (tilesSinceYield >= yieldEvery) {
          tilesSinceYield = 0;
          await new Promise(resolve => setTimeout(resolve, 0));
          if (!this.renderer) return;
        }
      }
    }
  }

  async _encodeExplorationBase64(buffer, width, height) {
    try {
      const useOffscreen = (typeof OffscreenCanvas !== 'undefined');

      if (!this._explorationEncodeCanvas || !this._explorationEncodeCtx) {
        if (useOffscreen) {
          this._explorationEncodeCanvas = new OffscreenCanvas(width, height);
          this._explorationEncodeCtx = this._explorationEncodeCanvas.getContext('2d');
        } else {
          const canvasEl = document.createElement('canvas');
          canvasEl.width = width;
          canvasEl.height = height;
          this._explorationEncodeCanvas = canvasEl;
          this._explorationEncodeCtx = canvasEl.getContext('2d');
        }
      }

      const canvasEl = this._explorationEncodeCanvas;
      const ctx = this._explorationEncodeCtx;
      if (!canvasEl || !ctx) return null;

      // Ensure correct canvas size.
      if (canvasEl.width !== width) canvasEl.width = width;
      if (canvasEl.height !== height) canvasEl.height = height;

      // Ensure ImageData is correct size.
      if (!this._explorationEncodeImageData || this._explorationEncodeImageData.width !== width || this._explorationEncodeImageData.height !== height) {
        this._explorationEncodeImageData = ctx.createImageData(width, height);
      }

      const imgData = this._explorationEncodeImageData;
      const pixels = imgData.data;

      const CHUNK_SIZE = 262144;
      let yieldCounter = 0;
      for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
        const end = Math.min(i + CHUNK_SIZE, buffer.length);
        for (let j = i; j < end; j += 4) {
          const val = buffer[j];
          pixels[j] = val;
          pixels[j + 1] = val;
          pixels[j + 2] = val;
          pixels[j + 3] = 255;
        }
        // Yield occasionally to keep UI responsive, but avoid allocating a Promise for every chunk.
        if (end < buffer.length) {
          yieldCounter++;
          if ((yieldCounter % 8) === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);

      if (useOffscreen && typeof canvasEl.convertToBlob === 'function') {
        const blob = await canvasEl.convertToBlob({ type: 'image/webp', quality: 0.8 });
        return await this._blobToDataURL(blob);
      }

      return await new Promise((resolve) => {
        canvasEl.toBlob((blob) => {
          if (blob) {
            this._blobToDataURL(blob).then(resolve).catch(() => resolve(null));
          } else {
            try {
              resolve(canvasEl.toDataURL('image/webp', 0.8));
            } catch (_) {
              resolve(null);
            }
          }
        }, 'image/webp', 0.8);
      });
    } catch (_) {
      return null;
    }
  }

  _blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

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
    
    if (this.fogPlane && this.mainScene) {
      this.mainScene.remove(this.fogPlane);
      this.fogPlane.geometry.dispose();
      this.fogMaterial.dispose();
    }

    if (this.visionMaterial) this.visionMaterial.dispose();
    if (this.darknessMaterial) this.darknessMaterial.dispose();

    // Dispose the SDF generator and its GPU resources
    if (this._visionSDF) {
      this._visionSDF.dispose();
      this._visionSDF = null;
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

    // Release reusable save buffers
    this._explorationSaveBuffer = null;
    this._explorationReadbackTileBuffer = null;
    this._explorationEncodeCanvas = null;
    this._explorationEncodeCtx = null;
    this._explorationEncodeImageData = null;
    
    this._initialized = false;
    log.info('WorldSpaceFogEffect disposed');
  }
}
