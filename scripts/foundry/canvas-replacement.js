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
import { RenderLoop } from '../core/render-loop.js';
import { TweakpaneManager } from '../ui/tweakpane-manager.js';
import { TokenManager } from '../scene/token-manager.js';
import { DropHandler } from './drop-handler.js';

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
    // CRITICAL: Override Foundry's PIXI rendering
    overrideFoundryRendering();

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
    
    threeCanvas = rendererCanvas; // Update reference
    const rect = threeCanvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height);

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
    
    // Provide the base mesh and asset bundle to the effect
    const basePlane = sceneComposer.getBasePlane();
    specularEffect.setBaseMesh(basePlane, bundle);

    // Step 4: Initialize token manager
    tokenManager = new TokenManager(threeScene);
    tokenManager.initialize();
    log.info('Token manager initialized');

    // Step 5: Initialize drop handler (for token/tile creation)
    dropHandler = new DropHandler(threeCanvas);
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
    mapShine.cameraController = cameraController;
    mapShine.tokenManager = tokenManager; // NEW: Expose token manager for diagnostics
    mapShine.renderLoop = renderLoop; // CRITICAL: Expose render loop for diagnostics
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
      await initializeUI(specularEffect);
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
 * @private
 */
async function initializeUI(specularEffect) {
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

  // Register effect with UI
  uiManager.registerEffect(
    'specular',
    'Metallic / Specular',
    specularSchema,
    onSpecularUpdate
  );

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
 * Override Foundry's PIXI rendering system
 * Hides PIXI canvas completely - Foundry UI buttons are separate HTML elements
 * @private
 */
function overrideFoundryRendering() {
  if (!canvas || !canvas.app) {
    log.warn('Cannot override rendering - Foundry canvas not ready');
    return;
  }

  log.info('Overriding Foundry PIXI rendering system');

  // Hide PIXI canvas completely - we handle all interactions
  const pixiCanvas = canvas.app.view;
  if (pixiCanvas) {
    pixiCanvas.style.opacity = '0'; // Hide visually
    pixiCanvas.style.pointerEvents = 'none'; // Disable - we'll handle drops ourselves
    log.debug('PIXI canvas hidden and non-interactive');
  }

  log.info('PIXI canvas completely disabled');
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
