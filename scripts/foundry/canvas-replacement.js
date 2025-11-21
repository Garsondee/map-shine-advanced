/**
 * @fileoverview Canvas replacement hooks for Foundry VTT integration
 * Uses Libwrapper to intercept and replace Foundry's canvas rendering
 * @module foundry/canvas-replacement
 */

import { createLogger } from '../core/log.js';
import * as sceneSettings from '../settings/scene-settings.js';
import { SceneComposer } from '../scene/composer.js';
import { CameraController } from '../scene/camera-controller.js';
import { EffectComposer } from '../effects/EffectComposer.js';
import { SpecularEffect } from '../effects/SpecularEffect.js';
import { IridescenceEffect } from '../effects/IridescenceEffect.js';
import { ColorCorrectionEffect } from '../effects/ColorCorrectionEffect.js';
import { ParticleSystem } from '../particles/ParticleSystem.js';
import {
  CloudShadowsEffect,
  TimeOfDayEffect,
  WeatherEffect,
  HeatDistortionEffect,
  LightningEffect,
  AmbientEffect,
  CloudDepthEffect,
  WaterEffect,
  FoamEffect,
  GroundGlowEffect,
  BiofilmEffect,
  StructuralShadowsEffect,
  BuildingShadowsEffect,
  CanopyDistortionEffect,
  PhysicsRopeEffect,
  BushTreeEffect,
  OverheadEffect,
  DustEffect,
  FireSparksEffect,
  SteamEffect,
  MetallicGlintsEffect,
  SmellyFliesEffect,
  PostProcessingEffect,
  PrismEffect,
  SceneTransitionsEffect,
  PauseEffect,
  LoadingScreenEffect,
  MapPointsEffect
} from '../effects/stubs/StubEffects.js';
import { RenderLoop } from '../core/render-loop.js';
import { TweakpaneManager } from '../ui/tweakpane-manager.js';
import { TokenManager } from '../scene/token-manager.js';
import { TileManager } from '../scene/tile-manager.js';
import { WallManager } from '../scene/wall-manager.js';
import { InteractionManager } from '../scene/interaction-manager.js';
import { GridRenderer } from '../scene/grid-renderer.js';
import { DropHandler } from './drop-handler.js';
import { sceneDebug } from '../utils/scene-debug.js';

const log = createLogger('Canvas');

/** @type {HTMLCanvasElement|null} */
let threeCanvas = null;

/** @type {boolean} */
let isHooked = false;

/** @type {THREE.Renderer|null} */
let renderer = null;

/** @type {SceneComposer|null} */
let sceneComposer = null;

/** @type {EffectComposer|null} */
let effectComposer = null;

/** @type {RenderLoop|null} */
let renderLoop = null;

/** @type {CameraController|null} */
let cameraController = null;

/** @type {TweakpaneManager|null} */
let uiManager = null;

/** @type {TokenManager|null} */
let tokenManager = null;

/** @type {TileManager|null} */
let tileManager = null;

/** @type {WallManager|null} */
let wallManager = null;

/** @type {InteractionManager|null} */
let interactionManager = null;

/** @type {GridRenderer|null} */
let gridRenderer = null;

/** @type {DropHandler|null} */
let dropHandler = null;

/**
 * Initialize canvas replacement hooks
 * Uses Foundry's native hook system for v13 compatibility
 * @returns {boolean} Whether hooks were successfully registered
 * @public
 */
export function initialize() {
  if (isHooked) {
    log.warn('Canvas hooks already registered');
    return true;
  }

  try {
    // Hook into canvas ready event (when canvas is fully initialized)
    Hooks.on('canvasReady', onCanvasReady);
    
    // Hook into canvas teardown
    Hooks.on('canvasTearDown', onCanvasTearDown);

    isHooked = true;
    log.info('Canvas replacement hooks registered');
    return true;

  } catch (error) {
    log.error('Failed to register canvas hooks:', error);
    return false;
  }
}

/**
 * Hook handler for canvasReady event
 * Called when Foundry's canvas is fully initialized
 * @param {Canvas} canvas - Foundry canvas instance
 * @private
 */
async function onCanvasReady(canvas) {
  const scene = canvas.scene;

  // Check if Map Shine is enabled for this scene
  if (!scene || !sceneSettings.isEnabled(scene)) {
    log.debug(`Scene not enabled for Map Shine: ${scene?.name || 'undefined'}`);
    return;
  }

  // Wait for bootstrap to complete if it hasn't yet
  // This handles race condition where canvas loads before 'ready' hook
  if (!window.MapShine || !window.MapShine.initialized) {
    log.info('Waiting for bootstrap to complete...');
    
    // Wait up to 5 seconds for bootstrap
    const startTime = Date.now();
    while (!window.MapShine?.initialized && (Date.now() - startTime) < 5000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    if (!window.MapShine?.initialized) {
      log.error('Bootstrap timeout - module did not initialize in time');
      return;
    }
    
    log.info('Bootstrap complete, proceeding with canvas initialization');
  }

  log.info(`Initializing Map Shine canvas for scene: ${scene.name}`);

  // Create three.js canvas overlay
  await createThreeCanvas(scene);
}

/**
 * Hook handler for canvasTearDown event
 * Called when Foundry's canvas is being torn down
 * @param {Canvas} canvas - Foundry canvas instance
 * @private
 */
function onCanvasTearDown(canvas) {
  log.info('Tearing down Map Shine canvas');

  // Cleanup three.js canvas
  destroyThreeCanvas();
}

/**
 * Create three.js canvas and attach to Foundry's canvas container
 * @param {Scene} scene - Current Foundry scene
 * @returns {Promise<void>}
 * @private
 */
async function createThreeCanvas(scene) {
  // Cleanup existing canvas if present
  destroyThreeCanvas();

  const THREE = window.THREE;
  if (!THREE) {
    log.error('three.js not loaded');
    return;
  }

  // Get MapShine state from global (set by bootstrap)
  let mapShine = window.MapShine;
  if (!mapShine || !mapShine.renderer) {
    // Try a lazy bootstrap as a recovery path
    log.warn('MapShine renderer missing, attempting lazy bootstrap...');
    try {
      const mod = await import('../core/bootstrap.js');
      const state = await mod.bootstrap({ verbose: false, skipSceneInit: true });
      Object.assign(window.MapShine, state);
      mapShine = window.MapShine;
    } catch (e) {
      log.error('Lazy bootstrap failed:', e);
      return;
    }
    if (!mapShine.renderer) {
      log.error('Renderer still unavailable after lazy bootstrap. Aborting.');
      return;
    }
  }

  try {
    // CRITICAL: Configure Foundry PIXI Canvas for Hybrid Mode
    configureFoundryCanvas();

    // Create new canvas element
    threeCanvas = document.createElement('canvas');
    threeCanvas.id = 'map-shine-canvas';
    threeCanvas.style.position = 'absolute';
    threeCanvas.style.top = '0';
    threeCanvas.style.left = '0';
    threeCanvas.style.width = '100%';
    threeCanvas.style.height = '100%';
    threeCanvas.style.zIndex = '1'; // Very low - background layer only
    threeCanvas.style.pointerEvents = 'auto'; // Enable for camera controls (right-click, scroll)

    // Inject NEXT to Foundry's canvas (as sibling, not child)
    // #board is the PIXI canvas itself, not a container!
    const pixiCanvas = document.getElementById('board');
    if (!pixiCanvas) {
      log.error('Failed to find Foundry canvas (#board)');
      return;
    }
    // Insert our canvas as a sibling, right after the PIXI canvas
    pixiCanvas.parentElement.insertBefore(threeCanvas, pixiCanvas.nextSibling);
    log.debug('Three.js canvas created and attached as sibling to PIXI canvas');

    // Get renderer from global state and attach its canvas
    renderer = mapShine.renderer;
    const rendererCanvas = renderer.domElement;
    
    // Replace our placeholder with the renderer's actual canvas
    threeCanvas.replaceWith(rendererCanvas);
    rendererCanvas.id = 'map-shine-canvas';
    rendererCanvas.style.position = 'absolute';
    rendererCanvas.style.top = '0';
    rendererCanvas.style.left = '0';
    rendererCanvas.style.width = '100%';
    rendererCanvas.style.height = '100%';
    rendererCanvas.style.zIndex = '1'; // Below PIXI canvas (which is hidden and non-interactive)
    rendererCanvas.style.pointerEvents = 'auto'; // ENABLE pointer events for drop handling
    rendererCanvas.style.backgroundColor = '#000000'; // CRITICAL: Force black background via CSS
    
    threeCanvas = rendererCanvas; // Update reference
    const rect = threeCanvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height);
    
    // CRITICAL: Force renderer clear color to opaque black
    // This ensures that "void" areas are black, not white or transparent
    if (renderer.setClearColor) {
      renderer.setClearColor(0x000000, 1);
    }

    // Step 1: Initialize scene composer
    sceneComposer = new SceneComposer();
    const { scene: threeScene, camera, bundle } = await sceneComposer.initialize(
      scene,
      rect.width,
      rect.height
    );

    log.info(`Scene composer initialized with ${bundle.masks.length} effect masks`);

    // Step 2: Initialize effect composer
    effectComposer = new EffectComposer(renderer, threeScene, camera);
    effectComposer.initialize(mapShine.capabilities);

    // Step 3: Register specular effect
    const specularEffect = new SpecularEffect();
    effectComposer.registerEffect(specularEffect);

    // Step 3.1: Register iridescence effect
    const iridescenceEffect = new IridescenceEffect();
    effectComposer.registerEffect(iridescenceEffect);

    // Step 3.2: Register color correction effect (Post-Processing)
    const colorCorrectionEffect = new ColorCorrectionEffect();
    effectComposer.registerEffect(colorCorrectionEffect);
    
    // Step 3.3: Register Particle System (WebGPU/WebGL2)
    const particleSystem = new ParticleSystem();
    effectComposer.registerEffect(particleSystem);

    // Provide the base mesh and asset bundle to the effect
    const basePlane = sceneComposer.getBasePlane();
    specularEffect.setBaseMesh(basePlane, bundle);
    iridescenceEffect.setBaseMesh(basePlane, bundle);

    // Step 3b: Initialize grid renderer
    gridRenderer = new GridRenderer(threeScene);
    gridRenderer.initialize();
    gridRenderer.updateGrid();
    log.info('Grid renderer initialized');

    // Step 4: Initialize token manager
    tokenManager = new TokenManager(threeScene);
    tokenManager.setEffectComposer(effectComposer); // Connect to main loop
    tokenManager.initialize();
    
    // Sync existing tokens immediately (we're already in canvasReady, so the hook won't fire)
    tokenManager.syncAllTokens();
    log.info('Token manager initialized and synced');

    // Step 4b: Initialize tile manager
    tileManager = new TileManager(threeScene);
    tileManager.initialize();
    tileManager.syncAllTiles();
    log.info('Tile manager initialized and synced');

    // Step 4c: Initialize wall manager
    wallManager = new WallManager(threeScene);
    wallManager.initialize();
    // Sync happens in initialize
    log.info('Wall manager initialized');

    // Step 5: Initialize interaction manager (Selection, Drag/Drop)
    interactionManager = new InteractionManager(threeCanvas, sceneComposer, tokenManager, tileManager, wallManager);
    interactionManager.initialize();
    log.info('Interaction manager initialized');

    // Step 6: Initialize drop handler (for creating new items)
    dropHandler = new DropHandler(threeCanvas, sceneComposer);
    dropHandler.initialize();
    log.info('Drop handler initialized');

    // Step 6: Initialize camera controller
    cameraController = new CameraController(threeCanvas, sceneComposer);
    log.info('Camera controller initialized');

    // Step 7: Ensure Foundry UI layers are above our canvas
    ensureUILayering();

    // Step 8: Start render loop
    renderLoop = new RenderLoop(renderer, threeScene, camera, effectComposer);
    renderLoop.start();

    log.info('Render loop started');

    // Expose for diagnostics (after render loop is created)
    mapShine.sceneComposer = sceneComposer;
    mapShine.effectComposer = effectComposer;
    mapShine.specularEffect = specularEffect;
    mapShine.iridescenceEffect = iridescenceEffect;
    mapShine.colorCorrectionEffect = colorCorrectionEffect;
    mapShine.cameraController = cameraController;
    mapShine.tokenManager = tokenManager; // NEW: Expose token manager for diagnostics
    mapShine.tileManager = tileManager; // NEW: Expose tile manager for diagnostics
    mapShine.wallManager = wallManager; // NEW: Expose wall manager
    mapShine.interactionManager = interactionManager; // NEW: Expose interaction manager
    mapShine.gridRenderer = gridRenderer; // NEW: Expose grid renderer
    mapShine.renderLoop = renderLoop; // CRITICAL: Expose render loop for diagnostics
    mapShine.sceneDebug = sceneDebug; // NEW: Expose scene debug helpers
    // Attach to canvas as well for convenience (used by console snippets)
    try { canvas.mapShine = mapShine; } catch (_) {}

    log.info('Specular effect registered and initialized');

    // Log FPS periodically
    setInterval(() => {
      if (renderLoop && renderLoop.running()) {
        log.debug(`FPS: ${renderLoop.getFPS()}, Frames: ${renderLoop.getFrameCount()}`);
      }
    }, 5000);

    // Initialize Tweakpane UI
    try {
      await initializeUI(specularEffect, iridescenceEffect, colorCorrectionEffect);
    } catch (e) {
      log.error('Failed to initialize UI:', e);
    }

  } catch (error) {
    log.error('Failed to initialize three.js scene:', error);
    destroyThreeCanvas();
  }
}

/**
 * Initialize Tweakpane UI and register effects
 * @param {SpecularEffect} specularEffect - The specular effect instance
 * @param {IridescenceEffect} iridescenceEffect - The iridescence effect instance
 * @param {ColorCorrectionEffect} colorCorrectionEffect - The color correction effect instance
 * @private
 */
async function initializeUI(specularEffect, iridescenceEffect, colorCorrectionEffect) {
  // Expose TimeManager BEFORE creating UI so Global Controls can access it
  if (window.MapShine.effectComposer) {
    window.MapShine.timeManager = window.MapShine.effectComposer.getTimeManager();
    log.info('TimeManager exposed to UI');
  } else {
    log.warn('EffectComposer not available, TimeManager not exposed');
  }
  
  // Create UI manager if not already created
  if (!uiManager) {
    uiManager = new TweakpaneManager();
    await uiManager.initialize();
    log.info('UI Manager created');
  }

  // Get Specular effect schema from effect class (centralized definition)
  const specularSchema = SpecularEffect.getControlSchema();

  // Update callback for Specular effect
  const onSpecularUpdate = (effectId, paramId, value) => {
    if (paramId === 'enabled' || paramId === 'masterEnabled') {
      specularEffect.enabled = value;
      log.debug(`Specular effect ${value ? 'enabled' : 'disabled'}`);
    } else if (specularEffect.params[paramId] !== undefined) {
      specularEffect.params[paramId] = value;
      log.debug(`Specular.${paramId} = ${value}`);
    }
  };

  // Register effect with UI (Surface & Material category)
  uiManager.registerEffect(
    'specular',
    'Metallic / Specular',
    specularSchema,
    onSpecularUpdate,
    'surface'
  );

  // --- Iridescence Settings ---
  if (iridescenceEffect) {
    const iridescenceSchema = IridescenceEffect.getControlSchema();
    
    const onIridescenceUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        iridescenceEffect.enabled = value;
        log.debug(`Iridescence effect ${value ? 'enabled' : 'disabled'}`);
      } else if (iridescenceEffect.params[paramId] !== undefined) {
        iridescenceEffect.params[paramId] = value;
        log.debug(`Iridescence.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'iridescence',
      'Iridescence / Holographic',
      iridescenceSchema,
      onIridescenceUpdate,
      'surface'
    );

    // Sync status
    if (uiManager.effectFolders['iridescence']) {
      const folderData = uiManager.effectFolders['iridescence'];
      folderData.params.textureStatus = iridescenceEffect.params.textureStatus;
      
      if (folderData.bindings.textureStatus) {
        folderData.bindings.textureStatus.refresh();
      }
      uiManager.updateEffectiveState('iridescence');
    }
  }

  // Sync dynamic status from effect to UI immediately
  if (uiManager.effectFolders['specular']) {
    const folderData = uiManager.effectFolders['specular'];
    
    // Update internal params in UI manager
    folderData.params.textureStatus = specularEffect.params.textureStatus;
    folderData.params.hasSpecularMask = specularEffect.params.hasSpecularMask;
    
    // Refresh status display
    if (folderData.bindings.textureStatus) {
      folderData.bindings.textureStatus.refresh();
    }
    
    // Update status light
    uiManager.updateEffectiveState('specular');
  }

  // --- Grid Settings ---
  if (gridRenderer) {
    const gridSchema = GridRenderer.getControlSchema();
    
    const onGridUpdate = (effectId, paramId, value) => {
      gridRenderer.updateSetting(paramId, value);
      log.debug(`Grid.${paramId} = ${value}`);
    };

    uiManager.registerEffect(
      'grid',
      'Grid Settings',
      gridSchema,
      onGridUpdate,
      'global'
    );
    log.info('Grid settings wired to UI');
  }

  // --- Color Correction & Grading (Post-Processing) ---
  if (colorCorrectionEffect) {
    const ccSchema = ColorCorrectionEffect.getControlSchema();

    const onColorCorrectionUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        colorCorrectionEffect.enabled = value;
        log.debug(`ColorCorrection effect ${value ? 'enabled' : 'disabled'}`);
      } else if (colorCorrectionEffect.params && Object.prototype.hasOwnProperty.call(colorCorrectionEffect.params, paramId)) {
        colorCorrectionEffect.params[paramId] = value;
        log.debug(`ColorCorrection.${paramId} =`, value);
      }
    };

    uiManager.registerEffect(
      'colorCorrection',
      'Color Grading & VFX',
      ccSchema,
      onColorCorrectionUpdate,
      'global'
    );

    log.info('Color correction effect wired to UI');
  }

  // --- Stub Effects ---
  // UI-only placeholders for planned effects; these do not yet affect rendering
  const stubEffectDefs = [
    // Atmospheric & Environmental
    { id: 'cloud-shadows',      name: 'Cloud Shadows',        Class: CloudShadowsEffect,      categoryId: 'atmospheric' },
    { id: 'time-of-day',        name: 'Time of Day',          Class: TimeOfDayEffect,         categoryId: 'atmospheric' },
    { id: 'weather',            name: 'Weather System',       Class: WeatherEffect,           categoryId: 'atmospheric' },
    { id: 'heat-distortion',    name: 'Heat Distortion',      Class: HeatDistortionEffect,    categoryId: 'atmospheric' },
    { id: 'lightning',          name: 'Lightning',            Class: LightningEffect,         categoryId: 'atmospheric' },
    { id: 'ambient',            name: 'Ambient Lighting',     Class: AmbientEffect,           categoryId: 'atmospheric' },
    { id: 'cloud-depth',        name: 'Cloud Depth',          Class: CloudDepthEffect,        categoryId: 'atmospheric' },

    // Surface & Material
    { id: 'water',              name: 'Water',                Class: WaterEffect,             categoryId: 'water' },
    { id: 'foam',               name: 'Foam',                 Class: FoamEffect,              categoryId: 'water' },
    { id: 'ground-glow',        name: 'Ground Glow',          Class: GroundGlowEffect,        categoryId: 'surface' },
    { id: 'biofilm',            name: 'Water Splashes',       Class: BiofilmEffect,           categoryId: 'water' },

    // Object & Structure
    { id: 'structural-shadows', name: 'Structural Shadows',   Class: StructuralShadowsEffect, categoryId: 'structure' },
    { id: 'building-shadows',   name: 'Building Shadows',     Class: BuildingShadowsEffect,   categoryId: 'structure' },
    { id: 'canopy-distortion',  name: 'Canopy Distortion',    Class: CanopyDistortionEffect,  categoryId: 'structure' },
    { id: 'physics-rope',       name: 'Physics Rope',         Class: PhysicsRopeEffect,       categoryId: 'structure' },
    { id: 'bush-tree',          name: 'Bush & Tree',          Class: BushTreeEffect,          categoryId: 'structure' },
    { id: 'overhead',           name: 'Overhead Effect',      Class: OverheadEffect,          categoryId: 'structure' },

    // Particle Systems
    { id: 'dust',               name: 'Dust',                 Class: DustEffect,              categoryId: 'particle' },
    { id: 'fire-sparks',        name: 'Fire & Sparks',        Class: FireSparksEffect,        categoryId: 'particle' },
    { id: 'steam',              name: 'Steam',                Class: SteamEffect,             categoryId: 'particle' },
    { id: 'metallic-glints',    name: 'Metallic Glints',      Class: MetallicGlintsEffect,    categoryId: 'particle' },
    { id: 'smelly-flies',       name: 'Smelly Flies',         Class: SmellyFliesEffect,       categoryId: 'particle' },

    // Global & UI Effects
    // { id: 'post-processing',    name: 'Post-Processing',      Class: PostProcessingEffect,    categoryId: 'global' }, // Replaced by real ColorCorrectionEffect
    { id: 'prism',              name: 'Prism',                Class: PrismEffect,             categoryId: 'global' },
    { id: 'scene-transitions',  name: 'Scene Transitions',    Class: SceneTransitionsEffect,  categoryId: 'global' },
    { id: 'pause',              name: 'Pause Effect',         Class: PauseEffect,             categoryId: 'global' },
    { id: 'loading-screen',     name: 'Loading Screen',       Class: LoadingScreenEffect,     categoryId: 'global' },
    { id: 'map-points',         name: 'Map Points',           Class: MapPointsEffect,         categoryId: 'global' }
  ];

  // Simple storage for stub parameters (for future wiring to real effects)
  if (!window.MapShine.stubEffects) {
    window.MapShine.stubEffects = {};
  }

  for (const def of stubEffectDefs) {
    const { id, name, Class, categoryId } = def;

    // Avoid duplicate registration if initializeUI is called multiple times
    if (window.MapShine.stubEffects[id]?.registered) continue;

    const schema = Class.getControlSchema();

    // Local state container for this effect
    window.MapShine.stubEffects[id] = window.MapShine.stubEffects[id] || {
      params: {},
      enabled: false,
      registered: false
    };

    const onStubUpdate = (effectId, paramId, value) => {
      const entry = window.MapShine.stubEffects[effectId];
      if (!entry) return;

      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        entry.enabled = value;
      } else {
        entry.params[paramId] = value;
      }
    };

    uiManager.registerEffect(id, name, schema, onStubUpdate, categoryId);
    window.MapShine.stubEffects[id].registered = true;
  }

  // Expose UI manager globally for debugging
  window.MapShine.uiManager = uiManager;
  
  log.info('Specular effect wired to UI');
}

/**
 * Destroy three.js canvas and cleanup resources
 * @private
 */
function destroyThreeCanvas() {
  // Dispose UI manager
  if (uiManager) {
    uiManager.dispose();
    uiManager = null;
    log.debug('UI manager disposed');
  }

  // Dispose camera controller
  if (cameraController) {
    cameraController.dispose();
    cameraController = null;
    log.debug('Camera controller disposed');
  }

  // Stop render loop
  if (renderLoop) {
    renderLoop.stop();
    renderLoop = null;
    log.debug('Render loop stopped');
  }

  // Dispose drop handler
  if (dropHandler) {
    dropHandler.dispose();
    dropHandler = null;
    log.debug('Drop handler disposed');
  }

  // Dispose token manager
  if (tokenManager) {
    tokenManager.dispose();
    tokenManager = null;
    log.debug('Token manager disposed');
  }

  // Dispose tile manager
  if (tileManager) {
    tileManager.dispose();
    tileManager = null;
    log.debug('Tile manager disposed');
  }

  // Dispose wall manager
  if (wallManager) {
    wallManager.dispose();
    wallManager = null;
    log.debug('Wall manager disposed');
  }

  // Dispose interaction manager
  if (interactionManager) {
    interactionManager.dispose();
    interactionManager = null;
    log.debug('Interaction manager disposed');
  }

  // Dispose grid renderer
  if (gridRenderer) {
    gridRenderer.dispose();
    gridRenderer = null;
    log.debug('Grid renderer disposed');
  }

  // Dispose effect composer
  if (effectComposer) {
    effectComposer.dispose();
    effectComposer = null;
    log.debug('Effect composer disposed');
  }

  // Dispose scene composer
  if (sceneComposer) {
    sceneComposer.dispose();
    sceneComposer = null;
    log.debug('Scene composer disposed');
  }

  // Remove canvas element
  if (threeCanvas) {
    threeCanvas.remove();
    threeCanvas = null;
    log.debug('Three.js canvas removed');
  }

  // Restore Foundry's PIXI rendering
  restoreFoundryRendering();

  // Note: renderer is owned by MapShine global state, don't dispose here
  renderer = null;

  log.info('Three.js canvas destroyed');
}

/**
 * Configure Foundry's PIXI canvas for Hybrid Mode
 * Keeps canvas visible but hides specific layers we've replaced
 * Sets up input arbitration to pass clicks through to THREE.js when needed
 * @private
 */
function configureFoundryCanvas() {
  if (!canvas || !canvas.app) {
    log.warn('Cannot configure canvas - Foundry canvas not ready');
    return;
  }

  log.info('Configuring Foundry PIXI canvas for Hybrid Mode');

  const pixiCanvas = canvas.app.view;
  if (pixiCanvas) {
    // Hide visual output but keep interactive
    pixiCanvas.style.opacity = '0'; 
    // Enable interaction so Foundry tools (Walls, etc.) still receive events
    pixiCanvas.style.pointerEvents = 'auto';
    
    // Ensure it is on top so it catches the mouse events
    pixiCanvas.style.zIndex = '10'; 
  }

  // Hide the layers we have replaced
  manageFoundryLayers();

  // Setup Input Arbitration (Tool switching)
  // We still use this to optimize: if using Token tool, we might want THREE to handle input directly?
  // But if PIXI is opaque (alpha:false), we can't have THREE behind it if PIXI blocks events?
  // Wait, opacity:0 does NOT block events.
  // So if PIXI is zIndex 10, it catches ALL events.
  // We need to let events pass through to THREE if we are not using a Foundry tool.
  setupInputArbitration();

  log.info('PIXI canvas configured for Replacement Mode');
}

/**
 * Hide specific Foundry layers that we render in THREE.js
 * @private
 */
function manageFoundryLayers() {
  // List of layers to hide
  // We use the layer names as they appear in canvas.layers
  // or access them directly if possible
  
  // 1. Background Layer (canvas.background)
  if (canvas.background) {
    canvas.background.visible = false;
    log.debug('Hidden Foundry BackgroundLayer');
  }
  
  // 2. Grid Layer (canvas.grid)
  if (canvas.grid) {
    canvas.grid.visible = false;
    log.debug('Hidden Foundry GridLayer');
  }

  // 3. Token Layer (canvas.tokens)
  if (canvas.tokens) {
    canvas.tokens.visible = false;
    log.debug('Hidden Foundry TokenLayer');
  }
  
  // 4. Tiles Layer (canvas.tiles) - Foreground and Background
  // Note: Tiles are complicated in V12/13, they might be in Primary Canvas Group
  if (canvas.tiles) {
    canvas.tiles.visible = false;
    log.debug('Hidden Foundry TilesLayer');
  }

  // 5. Effects/Weather (canvas.weather or canvas.environment)
  if (canvas.weather) {
    canvas.weather.visible = false;
  }
}

/**
 * Setup Input Arbitration
 * Listens to tool changes to toggle PIXI canvas interactivity
 * @private
 */
function setupInputArbitration() {
  // Hook into tool changes
  Hooks.on('canvasInit', manageFoundryLayers); // Re-apply layer hiding on scene change
  
  // We check the active layer/tool to decide who gets input
  const updateInputMode = () => {
    const pixiCanvas = canvas.app?.view;
    if (!pixiCanvas) return;

    const activeLayer = canvas.activeLayer?.name;
    const tool = game.activeTool;
    
    // Tools that require PIXI interaction (Legacy fallback)
    // We are taking over Walls, so remove it from this list
    const pixiTools = [
      // 'walls', // We handle walls in THREE.js now
      'lighting',
      'sounds',
      'templates',
      'drawings',
      'notes'
    ];
    
    // Check if we are on a layer that needs PIXI
    // WallsLayer is now handled by THREE.js
    const needsPixi = pixiTools.some(t => activeLayer?.toLowerCase().includes(t));
    
    if (needsPixi) {
      pixiCanvas.style.pointerEvents = 'auto';
      log.debug(`Input Mode: PIXI (Layer: ${activeLayer})`);
    } else {
      pixiCanvas.style.pointerEvents = 'none';
      log.debug(`Input Mode: THREE.js (Layer: ${activeLayer})`);
    }
  };

  // Hook into layer changes
  Hooks.on('canvasReady', updateInputMode);
  Hooks.on('changeSidebarTab', updateInputMode); // When switching tools
  Hooks.on('renderSceneControls', updateInputMode); // When clicking tools
  
  // Initial check
  updateInputMode();
}

/**
 * Restore Foundry's PIXI rendering (for cleanup/disabling module)
 * @private
 */
function restoreFoundryRendering() {
  if (!canvas || !canvas.app) return;

  log.info('Restoring Foundry PIXI rendering');

  // Restore PIXI canvas to default state
  const pixiCanvas = canvas.app.view;
  if (pixiCanvas) {
    pixiCanvas.style.opacity = '1';
    pixiCanvas.style.pointerEvents = 'auto';
    pixiCanvas.style.zIndex = ''; // Reset to default
  }

  // Restore background layer visibility
  if (canvas.background) {
    canvas.background.visible = true;
    log.debug('PIXI background layer restored');
  }

  // Restore primary background alpha
  if (canvas.primary?.background) {
    canvas.primary.background.alpha = 1;
    log.debug('PIXI primary background restored');
  }

  log.info('PIXI rendering restored');
}

/**
 * Ensure Foundry UI layers have proper z-index to appear above Three.js canvas
 * @private
 */
function ensureUILayering() {
  log.info('Ensuring UI layering...');
  
  // Strategy: Set high z-index only on peripheral UI elements that don't cover the canvas
  // The main canvas area should remain free for Three.js interaction
  
  // Sidebar and other UI elements (right side - doesn't cover canvas)
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.style.zIndex = '100';
    log.debug('Sidebar z-index set to 100');
  }
  
  // Chat panel (positioned to side, doesn't cover main canvas)
  const chat = document.getElementById('chat');
  if (chat) {
    chat.style.zIndex = '100';
    log.debug('Chat z-index set to 100');
  }
  
  // Players list (top right corner)
  const players = document.getElementById('players');
  if (players) {
    players.style.zIndex = '100';
    log.debug('Players z-index set to 100');
  }
  
  // Hotbar (bottom of screen)
  const hotbar = document.getElementById('hotbar');
  if (hotbar) {
    hotbar.style.zIndex = '100';
    log.debug('Hotbar z-index set to 100');
  }
  
  // Scene controls (left toolbar)
  const controls = document.getElementById('controls');
  if (controls) {
    controls.style.zIndex = '100';
    log.debug('Controls z-index set to 100');
  }
  
  // Navigation bar (top of screen)
  const navigation = document.getElementById('navigation');
  if (navigation) {
    navigation.style.zIndex = '100';
    log.debug('Navigation z-index set to 100');
  }
  
  // Main UI container - make it transparent to pointer events over canvas area
  // This allows mouse events to pass through to the Three.js canvas
  const uiContainer = document.getElementById('ui');
  if (uiContainer) {
    uiContainer.style.zIndex = '100';
    uiContainer.style.pointerEvents = 'none'; // Make transparent to events
    log.debug('UI container set to pointer-events: none');
    
    // Re-enable pointer events on child elements that need interaction
    const uiChildren = uiContainer.querySelectorAll('#sidebar, #chat, #players, #hotbar, #controls, #navigation');
    uiChildren.forEach(child => {
      child.style.pointerEvents = 'auto';
    });
    log.debug('Re-enabled pointer events on interactive UI children');
  }
  
  log.info('UI layering ensured - peripheral UI at z-index 100, canvas area left interactive');
}

/**
 * Get the current three.js canvas element
 * @returns {HTMLCanvasElement|null}
 * @public
 */
export function getCanvas() {
  return threeCanvas;
}

/**
 * Handle canvas resize events
 * @param {number} width - New width
 * @param {number} height - New height
 * @public
 */
export function resize(width, height) {
  if (!threeCanvas) return;

  log.debug(`Canvas resized: ${width}x${height}`);

  // Update renderer size
  if (renderer) {
    renderer.setSize(width, height);
  }

  // Update scene composer camera
  if (sceneComposer) {
    sceneComposer.resize(width, height);
  }

  // Update effect composer render targets
  if (effectComposer) {
    effectComposer.resize(width, height);
  }
}
