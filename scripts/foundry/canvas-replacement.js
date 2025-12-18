/**
 * @fileoverview Canvas replacement hooks for Foundry VTT integration
 * Uses Libwrapper to intercept and replace Foundry's canvas rendering
 * @module foundry/canvas-replacement
 */

import { createLogger } from '../core/log.js';
import * as sceneSettings from '../settings/scene-settings.js';
import { SceneComposer } from '../scene/composer.js';
import { CameraFollower } from './camera-follower.js';
import { PixiInputBridge } from './pixi-input-bridge.js';
import { EffectComposer } from '../effects/EffectComposer.js';
import { SpecularEffect } from '../effects/SpecularEffect.js';
import { IridescenceEffect } from '../effects/IridescenceEffect.js';
import { WindowLightEffect } from '../effects/WindowLightEffect.js';
import { BushEffect } from '../effects/BushEffect.js';
import { TreeEffect } from '../effects/TreeEffect.js';
import { ColorCorrectionEffect } from '../effects/ColorCorrectionEffect.js';
import { SkyColorEffect } from '../effects/SkyColorEffect.js';
import { AsciiEffect } from '../effects/AsciiEffect.js';
import { BloomEffect } from '../effects/BloomEffect.js';
import { LightingEffect } from '../effects/LightingEffect.js';
import { LightningEffect } from '../effects/LightningEffect.js';
import { LensflareEffect } from '../effects/LensflareEffect.js';
import { PrismEffect } from '../effects/PrismEffect.js';
import { OverheadShadowsEffect } from '../effects/OverheadShadowsEffect.js';
import { BuildingShadowsEffect } from '../effects/BuildingShadowsEffect.js';
import { CloudEffect } from '../effects/CloudEffect.js';
import { DistortionManager } from '../effects/DistortionManager.js';
import { WaterEffect } from '../effects/WaterEffect.js';
import { MaskDebugEffect } from '../effects/MaskDebugEffect.js';
import { MaskManager } from '../masks/MaskManager.js';
import { ParticleSystem } from '../particles/ParticleSystem.js';
import { FireSparksEffect } from '../particles/FireSparksEffect.js';
import { SmellyFliesEffect } from '../particles/SmellyFliesEffect.js';
import { DustMotesEffect } from '../particles/DustMotesEffect.js';
import { WorldSpaceFogEffect } from '../effects/WorldSpaceFogEffect.js';
import { RenderLoop } from '../core/render-loop.js';
import { TweakpaneManager } from '../ui/tweakpane-manager.js';
import { TokenManager } from '../scene/token-manager.js';
import { TileManager } from '../scene/tile-manager.js';
import { WallManager } from '../scene/wall-manager.js';
import { DoorMeshManager } from '../scene/DoorMeshManager.js';
import { DrawingManager } from '../scene/drawing-manager.js';
import { NoteManager } from '../scene/note-manager.js';
import { TemplateManager } from '../scene/template-manager.js';
import { LightIconManager } from '../scene/light-icon-manager.js';
import { InteractionManager } from '../scene/interaction-manager.js';
import { GridRenderer } from '../scene/grid-renderer.js';
import { MapPointsManager } from '../scene/map-points-manager.js';
import { DropHandler } from './drop-handler.js';
import { sceneDebug } from '../utils/scene-debug.js';
import { weatherController } from '../core/WeatherController.js';
import { ControlsIntegration } from './controls-integration.js';
import { frameCoordinator } from '../core/frame-coordinator.js';
import { loadingOverlay } from '../ui/loading-overlay.js';

const log = createLogger('Canvas');

/** @type {ControlsIntegration|null} */
let controlsIntegration = null;

/** @type {HTMLCanvasElement|null} */
let threeCanvas = null;

/** @type {boolean} */
let isMapMakerMode = false;

/**
 * Track Foundry's native fog/visibility state so we can temporarily bypass it
 * in Map Maker mode (GM convenience) without permanently mutating the scene.
 * @type {{ fogVisible: boolean|null, visibilityVisible: boolean|null, visibilityFilterEnabled: boolean|null }|null}
 */
let mapMakerFogState = null;

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

/** @type {CameraFollower|null} */
let cameraFollower = null;

/** @type {PixiInputBridge|null} */
let pixiInputBridge = null;

/** @type {TweakpaneManager|null} */
let uiManager = null;

/** @type {TokenManager|null} */
let tokenManager = null;

/** @type {TileManager|null} */
let tileManager = null;

/** @type {WallManager|null} */
let wallManager = null;

/** @type {DoorMeshManager|null} */
let doorMeshManager = null;

/** @type {DrawingManager|null} */
let drawingManager = null;

/** @type {NoteManager|null} */
let noteManager = null;

/** @type {TemplateManager|null} */
let templateManager = null;

/** @type {LightIconManager|null} */
let lightIconManager = null;

/** @type {InteractionManager|null} */
let interactionManager = null;

/** @type {GridRenderer|null} */
let gridRenderer = null;

/** @type {MapPointsManager|null} */
let mapPointsManager = null;

/** @type {DropHandler|null} */
let dropHandler = null;

/** @type {LightingEffect|null} */
let lightingEffect = null;

/** @type {LightningEffect|null} */
let lightningEffect = null;

/** @type {WorldSpaceFogEffect|null} */
let fogEffect = null;

// NOTE: visionManager and fogManager are no longer used.
// WorldSpaceFogEffect renders fog as a world-space plane mesh in the Three.js scene.

/** @type {SkyColorEffect|null} */
let skyColorEffect = null;

/** @type {boolean} - Whether frame coordinator is initialized */
let frameCoordinatorInitialized = false;

/** @type {ResizeObserver|null} - Observer for canvas container resize */
let resizeObserver = null;

/** @type {Function|null} - Bound window resize handler for cleanup */
let windowResizeHandler = null;

/** @type {number} - Debounce timer for resize events */
let resizeDebounceTimer = null;

/** @type {number|null} - Hook ID for collapseSidebar listener */
let collapseSidebarHookId = null;

 /** @type {number|null} - Interval ID for periodic FPS logging */
 let fpsLogIntervalId = null;

 /** @type {number|null} - Interval ID for weather windvane UI sync */
 let windVaneIntervalId = null;

 /** @type {boolean} */
 let transitionsInstalled = false;

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
    // CRITICAL: Hook into canvasConfig to make PIXI canvas transparent
    // This hook is called BEFORE the PIXI.Application is created, allowing us
    // to set transparent: true so the PIXI canvas can show Three.js underneath
    Hooks.on('canvasConfig', (config) => {
      log.info('Configuring PIXI canvas for transparency');
      config.transparent = true;
      // Also set backgroundAlpha to 0 for good measure
      config.backgroundAlpha = 0;
    });
    
    // Hook into canvas ready event (when canvas is fully initialized)
    Hooks.on('canvasReady', onCanvasReady);
    
    // Hook into canvas teardown
    Hooks.on('canvasTearDown', onCanvasTearDown);
    
    // Hook into scene configuration changes (grid, padding, background, etc.)
    Hooks.on('updateScene', onUpdateScene);

     // Install transition wrapper so we can fade-to-black BEFORE Foundry tears down the old scene.
     // This must wrap an awaited method (Canvas.tearDown) to actually block the teardown.
     installCanvasTransitionWrapper();

    isHooked = true;
    log.info('Canvas replacement hooks registered');
    return true;

  } catch (error) {
    log.error('Failed to register canvas hooks:', error);
    return false;
  }
}

function installCanvasTransitionWrapper() {
  if (transitionsInstalled) return;
  transitionsInstalled = true;

  try {
    const CanvasCls = globalThis.foundry?.canvas?.Canvas;
    const proto = CanvasCls?.prototype;
    if (!proto?.tearDown) {
      log.warn('Canvas class not available; scene transition wrapper not installed');
      return;
    }

    if (proto.tearDown.__mapShineWrapped) return;

    const original = proto.tearDown;
    const wrapped = async function(...args) {
      try {
        const scene = this.scene;
        if (scene && sceneSettings.isEnabled(scene)) {
          loadingOverlay.showLoading('Switching scenes…');
          await loadingOverlay.fadeToBlack(5000);
          loadingOverlay.setMessage('Loading…');
          loadingOverlay.setProgress(0);
        }
      } catch (e) {
        log.warn('Scene transition fade failed:', e);
      }
      return original.apply(this, args);
    };

    wrapped.__mapShineWrapped = true;
    proto.tearDown = wrapped;
    log.info('Installed Canvas.tearDown transition wrapper');
  } catch (e) {
    log.warn('Failed to install scene transition wrapper:', e);
  }
}

async function waitForThreeFrames(
  renderer,
  renderLoop,
  minFrames = 2,
  timeoutMs = 5000,
  {
    minCalls = 1,
    minDelayMs = 0,
    stableCallsFrames = 2
  } = {}
) {
  const startTime = performance.now();

  const startThreeFrame = renderer?.info?.render?.frame;
  const startLoopFrame = typeof renderLoop?.getFrameCount === 'function' ? renderLoop.getFrameCount() : 0;

  let callsStable = 0;

  while (performance.now() - startTime < timeoutMs) {
    const now = performance.now();
    const currentThreeFrame = renderer?.info?.render?.frame;
    const currentLoopFrame = typeof renderLoop?.getFrameCount === 'function' ? renderLoop.getFrameCount() : 0;

    const hasThreeCounter = Number.isFinite(startThreeFrame) && Number.isFinite(currentThreeFrame);
    const framesAdvanced = hasThreeCounter
      ? (currentThreeFrame - startThreeFrame)
      : (currentLoopFrame - startLoopFrame);

    const calls = renderer?.info?.render?.calls;
    if (Number.isFinite(calls) && calls >= minCalls) callsStable++;
    else callsStable = 0;

    const meetsDelay = (now - startTime) >= minDelayMs;
    const meetsFrames = framesAdvanced >= minFrames;
    const meetsCalls = !Number.isFinite(calls) ? true : (callsStable >= stableCallsFrames);

    if (meetsDelay && meetsFrames && meetsCalls) return true;

    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  return false;
}

/**
 * Hook handler for updateScene event
 * Called when scene configuration changes mid-session
 * @param {Scene} scene - The updated scene
 * @param {object} changes - Changed properties
 * @param {object} options - Update options
 * @param {string} userId - User who made the change
 * @private
 */
function onUpdateScene(scene, changes, options, userId) {
  // Only process if this is the current scene and Map Shine is enabled
  if (!canvas?.scene || scene.id !== canvas.scene.id) return;
  if (!sceneSettings.isEnabled(scene)) return;
  
  // Check for changes that require full reinitialization
  const requiresReinit = [
    'grid',           // Grid size, type, style changes
    'padding',        // Scene padding changes
    'background',     // Background image changes
    'width',          // Scene dimension changes
    'height',
    'backgroundColor' // Background color changes
  ].some(key => key in changes);
  
  if (requiresReinit) {
    log.info('Scene configuration changed, reinitializing Map Shine canvas');
    
    // Defer to next frame to ensure Foundry has finished updating
    setTimeout(async () => {
      destroyThreeCanvas();
      await createThreeCanvas(scene);
    }, 0);
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

  if (!scene) {
    log.debug('onCanvasReady called with no active scene');
    return;
  }

  // Wait for bootstrap to complete if it hasn't yet
  // This handles race condition where canvas loads before 'ready' hook
  if (!window.MapShine || !window.MapShine.initialized) {
    log.info('Waiting for bootstrap to complete...');
    
    // Wait up to 15 seconds for bootstrap (increased for slow systems)
    const MAX_WAIT_MS = 15000;
    const POLL_INTERVAL_MS = 100;
    const startTime = Date.now();
    let lastLogTime = startTime;
    
    while (!window.MapShine?.initialized && (Date.now() - startTime) < MAX_WAIT_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      
      // Log progress every 2 seconds to show we're still waiting
      if (Date.now() - lastLogTime > 2000) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log.debug(`Still waiting for bootstrap... (${elapsed}s elapsed)`);
        lastLogTime = Date.now();
      }
    }

    if (!window.MapShine?.initialized) {
      log.error('Bootstrap timeout - module did not initialize in time');
      ui.notifications.error('Map Shine: Initialization timeout. Try refreshing the page.');
      return;
    }
    
    log.info('Bootstrap complete, proceeding with canvas initialization');
  }

  // If scene is not enabled for Map Shine, run UI-only mode so GMs can
  // configure and enable Map Shine without replacing the Foundry canvas.
  if (!sceneSettings.isEnabled(scene)) {
    log.debug(`Scene not enabled for Map Shine, initializing UI-only mode: ${scene.name}`);

    if (!uiManager) {
      try {
        uiManager = new TweakpaneManager();
        await uiManager.initialize();
        window.MapShine.uiManager = uiManager;
        log.info('Map Shine UI initialized in UI-only mode');
      } catch (e) {
        log.error('Failed to initialize Map Shine UI in UI-only mode:', e);
      }
    }

     // Scene not replaced by Three.js - dismiss the overlay so the user can interact with Foundry normally.
     try {
       loadingOverlay.fadeIn(500).catch(() => {});
     } catch (e) {
       log.debug('Loading overlay not available:', e);
     }

    return;
  }

  log.info(`Initializing Map Shine canvas for scene: ${scene.name}`);

  try {
    loadingOverlay.showBlack(`Loading ${scene?.name || 'scene'}…`);
    loadingOverlay.setProgress(0.05);
  } catch (e) {
    log.debug('Loading overlay not available:', e);
  }

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

  // CRITICAL: Pause time manager immediately to stop all animations
  if (effectComposer?.timeManager) {
    try {
      effectComposer.timeManager.pause();
    } catch (e) {
      log.warn('Failed to pause time manager:', e);
    }
  }

  // Dispose frame coordinator (removes PIXI ticker hook)
  if (frameCoordinatorInitialized) {
    try {
      frameCoordinator.dispose();
      frameCoordinatorInitialized = false;
    } catch (e) {
      log.warn('Failed to dispose frame coordinator:', e);
    }
  }

  if (window.MapShine?.maskManager && typeof window.MapShine.maskManager.dispose === 'function') {
    try {
      window.MapShine.maskManager.dispose();
    } catch (e) {
      log.warn('Failed to dispose MaskManager:', e);
    }
  }

  // Cleanup three.js canvas
  destroyThreeCanvas();
  
  // Clear global references to prevent stale state
  if (window.MapShine) {
    window.MapShine.sceneComposer = null;
    window.MapShine.effectComposer = null;
    window.MapShine.maskManager = null;
    window.MapShine.tokenManager = null;
    window.MapShine.tileManager = null;
    window.MapShine.wallManager = null;
    window.MapShine.doorMeshManager = null;
    window.MapShine.fogEffect = null;
    window.MapShine.lightingEffect = null;
    window.MapShine.renderLoop = null;
    window.MapShine.cameraFollower = null;
    window.MapShine.pixiInputBridge = null;
    window.MapShine.interactionManager = null;
    window.MapShine.gridRenderer = null;
    window.MapShine.mapPointsManager = null;
    window.MapShine.frameCoordinator = null;
    window.MapShine.waterEffect = null;
    window.MapShine.distortionManager = null;
    window.MapShine.cloudEffect = null;
    // Keep renderer and capabilities - they're reusable
  }
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
    try {
      loadingOverlay.showBlack(`Loading ${scene?.name || 'scene'}…`);
      loadingOverlay.setProgress(0.05);
    } catch (e) {
      log.debug('Loading overlay not available:', e);
    }

    // Set default mode - actual canvas configuration happens after ControlsIntegration init
    isMapMakerMode = false; // Default to Gameplay Mode

    // Create new canvas element
    threeCanvas = document.createElement('canvas');
    threeCanvas.id = 'map-shine-canvas';
    threeCanvas.style.position = 'absolute';
    threeCanvas.style.top = '0';
    threeCanvas.style.left = '0';
    threeCanvas.style.width = '100%';
    threeCanvas.style.height = '100%';
    threeCanvas.style.zIndex = '1'; // Below PIXI (but PIXI is transparent, so Three.js shows through)
    threeCanvas.style.pointerEvents = 'auto'; // Three.js handles interaction in gameplay mode

    // Inject NEXT to Foundry's canvas (as sibling, not child)
    // #board is the PIXI canvas itself, not a container!
    const pixiCanvas = document.getElementById('board');
    if (!pixiCanvas) {
      log.error('Failed to find Foundry canvas (#board)');
      return;
    }
    
    // Configure PIXI canvas for hybrid mode immediately
    // ControlsIntegration will take over later, but we need this now to prevent black screen
    // Strategy: Three.js handles interaction in gameplay by default; PIXI starts as a
    // transparent overlay (no pointer events) and InputRouter/ControlsIntegration
    // enable PIXI input when edit tools are active.
    pixiCanvas.style.opacity = '1'; // Keep visible for overlay layers (drawings, templates, notes)
    pixiCanvas.style.zIndex = '10'; // On top
    pixiCanvas.style.pointerEvents = 'none'; // Pass pointer events to Three.js by default
    
    // CRITICAL: Set PIXI renderer background to transparent
    // Without this, the PIXI background color renders over Three.js content
    if (canvas.app?.renderer?.background) {
      canvas.app.renderer.background.alpha = 0;
      log.debug('PIXI renderer background alpha set to 0');
    }
    
    // Hide replaced PIXI layers immediately (background, grid, etc.)
    // These are rendered by Three.js, so they must be hidden
    if (canvas.background) canvas.background.visible = false;
    if (canvas.grid) canvas.grid.visible = false;
    if (canvas.primary) canvas.primary.visible = false;
    if (canvas.weather) canvas.weather.visible = false;
    if (canvas.environment) canvas.environment.visible = false;
    
    // CRITICAL: Tokens layer needs special handling
    // - Visual rendering is done by Three.js (TokenManager)
    // - But PIXI tokens must remain INTERACTIVE for clicks, HUD, selection, cursor
    // - We make token meshes TRANSPARENT (alpha=0) instead of invisible
    // - This keeps hit detection working while Three.js renders the visuals
    if (canvas.tokens) {
      canvas.tokens.visible = true; // Layer stays visible for interaction
      canvas.tokens.interactiveChildren = true;
      // Make tokens transparent - ControlsIntegration.hideReplacedLayers() handles this
      // more thoroughly after tokens are synced
      for (const token of canvas.tokens.placeables) {
        if (token.mesh) token.mesh.alpha = 0;
        if (token.icon) token.icon.alpha = 0;
        if (token.border) token.border.alpha = 0;
        token.visible = true;
        token.interactive = true;
      }
    }
    log.debug('Replaced PIXI layers hidden, tokens layer transparent but interactive');
    
    // Insert our canvas as a sibling, right after the PIXI canvas
    pixiCanvas.parentElement.insertBefore(threeCanvas, pixiCanvas.nextSibling);
    log.debug('Three.js canvas created and attached as sibling to PIXI canvas');

    // Get renderer from global state and attach its canvas
    renderer = mapShine.renderer;
    const rendererCanvas = renderer.domElement;

    // Resolve background colour from Foundry scene (fallback to Foundry default #999999)
    // scene.backgroundColor is a hex string like "#999999" in modern Foundry versions
    const sceneBgColorStr = (scene && typeof scene.backgroundColor === 'string' && scene.backgroundColor.trim().length > 0)
      ? scene.backgroundColor
      : '#999999';

    // Replace our placeholder with the renderer's actual canvas
    threeCanvas.replaceWith(rendererCanvas);
    rendererCanvas.id = 'map-shine-canvas';
    rendererCanvas.style.position = 'absolute';
    rendererCanvas.style.top = '0';
    rendererCanvas.style.left = '0';
    rendererCanvas.style.width = '100%';
    rendererCanvas.style.height = '100%';
    rendererCanvas.style.zIndex = '1'; // Below PIXI (but PIXI is transparent, so Three.js shows through)
    rendererCanvas.style.pointerEvents = 'auto'; // Three.js handles interaction in gameplay mode
    // Use Foundry's scene background colour so padded region matches core Foundry
    rendererCanvas.style.backgroundColor = sceneBgColorStr;

    threeCanvas = rendererCanvas; // Update reference
    const rect = threeCanvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height);

    // Ensure regions outside the Foundry world bounds remain black; padded region is covered by a background plane
    if (renderer.setClearColor) {
      renderer.setClearColor(0x000000, 1);
    }

    // Step 1: Initialize scene composer
    sceneComposer = new SceneComposer();
    const { scene: threeScene, camera, bundle } = await sceneComposer.initialize(
      scene,
      rect.width,
      rect.height,
      {
        onProgress: (loaded, total, asset) => {
          try {
            const denom = total > 0 ? total : 1;
            const v = Math.max(0, Math.min(1, loaded / denom));
            loadingOverlay.setMessage(`Loading ${asset}…`);
            // Reserve first 40% of the bar for asset/mask loading.
            loadingOverlay.setProgress(0.05 + v * 0.35);
          } catch (e) {
            // Ignore overlay errors
          }
        }
      }
    );

    log.info(`Scene composer initialized with ${bundle.masks.length} effect masks`);

    // CRITICAL: Expose sceneComposer early so effects can access groundZ during initialization
    mapShine.sceneComposer = sceneComposer;

    mapShine.maskManager = new MaskManager();
    mapShine.maskManager.setRenderer(renderer);
    try {
      const mm = mapShine.maskManager;
      if (mm && bundle?.masks && Array.isArray(bundle.masks)) {
        for (const m of bundle.masks) {
          if (!m || !m.id || !m.texture) continue;
          mm.setTexture(`${m.id}.scene`, m.texture, {
            space: 'sceneUv',
            source: 'assetMask',
            colorSpace: m.texture.colorSpace ?? null,
            uvFlipY: m.texture.flipY ?? null,
            lifecycle: 'staticPerScene'
          });
        }
      }

      if (mm && typeof mm.defineDerivedMask === 'function') {
        mm.defineDerivedMask('indoor.scene', { op: 'invert', input: 'outdoors.scene' });
        mm.defineDerivedMask('roofVisible.screen', { op: 'threshold', input: 'roofAlpha.screen', lo: 0.05, hi: 0.15 });
        mm.defineDerivedMask('roofClear.screen', { op: 'invert', input: 'roofVisible.screen' });
        mm.defineDerivedMask('precipVisibility.screen', { op: 'max', a: 'outdoors.screen', b: 'roofClear.screen' });
      }
    } catch (e) {
      log.warn('Failed to initialize MaskManager registry for bundle masks:', e);
    }

    // Wire the _Outdoors (roof/indoor) mask into the WeatherController so
    // precipitation effects (rain, snow, puddles) can respect covered areas.
    try {
      if (bundle?.masks?.length) {
        const outdoorsMask = bundle.masks.find(m => m.id === 'outdoors' || m.type === 'outdoors');
        if (outdoorsMask?.texture && weatherController?.setRoofMap) {
          weatherController.setRoofMap(outdoorsMask.texture);
          log.info('WeatherController roof map set from _Outdoors mask texture');
        } else {
          log.debug('No _Outdoors mask texture found for this scene');
        }
      }
    } catch (e) {
      log.warn('Failed to apply _Outdoors roof mask to WeatherController:', e);
    }

    // Step 2: Initialize effect composer
    effectComposer = new EffectComposer(renderer, threeScene, camera);
    effectComposer.initialize(mapShine.capabilities);

    try {
      loadingOverlay.setMessage('Initializing effects…');
      loadingOverlay.setProgress(0.45);
    } catch (e) {
      // Ignore overlay errors
    }

    // Ensure WeatherController is initialized and driven by the centralized TimeManager.
    // This allows precipitation, wind, etc. to update every frame and drive GPU effects
    // like the particle-based weather system without requiring manual console snippets.
    weatherController.initialize();
    effectComposer.addUpdatable(weatherController);

    // Step 3: Register specular effect
    const specularEffect = new SpecularEffect();
    await effectComposer.registerEffect(specularEffect);

    // Step 3.1: Register iridescence effect
    const iridescenceEffect = new IridescenceEffect();
    await effectComposer.registerEffect(iridescenceEffect);

    // Step 3.1.5: Register window lighting effect
    const windowLightEffect = new WindowLightEffect();
    await effectComposer.registerEffect(windowLightEffect);

    // Step 3.2: Register color correction effect (Post-Processing)
    const colorCorrectionEffect = new ColorCorrectionEffect();
    await effectComposer.registerEffect(colorCorrectionEffect);
    
    // Step 3.3: Register ASCII Effect (Post-Processing)
    const asciiEffect = new AsciiEffect();
    await effectComposer.registerEffect(asciiEffect);
    
    // Step 3.4: Register Particle System (WebGPU/WebGL2)
    // CRITICAL: Must await to ensure batchRenderer is initialized before FireSparksEffect uses it
    const particleSystem = new ParticleSystem();
    await effectComposer.registerEffect(particleSystem);

    // Step 3.4: Register Fire Sparks Effect and wire it to the ParticleSystem
    const fireSparksEffect = new FireSparksEffect();
    // Provide the particle backend so FireSparksEffect can create emitters and bind uniforms
    fireSparksEffect.setParticleSystem(particleSystem);
    await effectComposer.registerEffect(fireSparksEffect);
    // Pass asset bundle to check for _Fire mask (after particle system is wired)
    if (bundle) {
      fireSparksEffect.setAssetBundle(bundle);
    }

    // Step 3.4b: Register Smelly Flies Effect (smart particles with AI behavior)
    const smellyFliesEffect = new SmellyFliesEffect();
    await effectComposer.registerEffect(smellyFliesEffect);

    const dustMotesEffect = new DustMotesEffect();
    await effectComposer.registerEffect(dustMotesEffect);

    if (bundle) {
      dustMotesEffect.setAssetBundle(bundle);
    }

    lightningEffect = new LightningEffect();
    await effectComposer.registerEffect(lightningEffect);

    // Step 3.5: Register Prism Effect
    const prismEffect = new PrismEffect();
    await effectComposer.registerEffect(prismEffect);

    // Step 3.5.05: Register Water Effect (MVP: drives DistortionManager using _Water)
    const waterEffect = new WaterEffect();
    await effectComposer.registerEffect(waterEffect);

    // Step 3.5.1: Register World-Space Fog Effect (Fog of War)
    // WorldSpaceFogEffect renders fog as a plane mesh in the Three.js scene.
    // This eliminates coordinate conversion issues between screen-space and world-space.
    // Vision is rendered to a world-space render target, exploration uses Foundry's texture.
    fogEffect = new WorldSpaceFogEffect();
    await effectComposer.registerEffect(fogEffect);
    log.info('WorldSpaceFogEffect registered');

    // Step 3.6: Register Lighting Effect
    lightingEffect = new LightingEffect();
    await effectComposer.registerEffect(lightingEffect);

    if (window.MapShine) window.MapShine.lightingEffect = lightingEffect;

    // Step 3.6.25: Register Animated Bushes (surface overlay, before shadows)
    const bushEffect = new BushEffect();
    await effectComposer.registerEffect(bushEffect);

    // Step 3.6.26: Register Animated Trees (High Canopy, above overhead)
    const treeEffect = new TreeEffect();
    await effectComposer.registerEffect(treeEffect);

    // Step 3.6.5: Register Overhead Shadows (post-lighting)
    const overheadShadowsEffect = new OverheadShadowsEffect();
    await effectComposer.registerEffect(overheadShadowsEffect);

    // Step 3.6.6: Register Building Shadows (post-lighting, environmental)
    const buildingShadowsEffect = new BuildingShadowsEffect();
    await effectComposer.registerEffect(buildingShadowsEffect);

    // Step 3.6.7: Register Cloud Effect (procedural cloud shadows)
    const cloudEffect = new CloudEffect();
    await effectComposer.registerEffect(cloudEffect);

    if (window.MapShine) window.MapShine.cloudEffect = cloudEffect;

    // Step 3.6.8: Register Distortion Manager (centralized screen-space distortions)
    const distortionManager = new DistortionManager();
    await effectComposer.registerEffect(distortionManager);

    // Step 3.7: Register Bloom Effect
    const bloomEffect = new BloomEffect();
    await effectComposer.registerEffect(bloomEffect);

    // Step 3.8: Register Lensflare Effect
    const lensflareEffect = new LensflareEffect();
    await effectComposer.registerEffect(lensflareEffect);

    const maskDebugEffect = new MaskDebugEffect();
    await effectComposer.registerEffect(maskDebugEffect);

    // Step 7: Create Sky Color Effect (post-lighting color grading for sky/outdoors)
    skyColorEffect = new SkyColorEffect();
    await effectComposer.registerEffect(skyColorEffect);

    // Provide the base mesh and asset bundle to the effect
    const basePlane = sceneComposer.getBasePlane();

    specularEffect.setBaseMesh(basePlane, bundle);
    iridescenceEffect.setBaseMesh(basePlane, bundle);
    prismEffect.setBaseMesh(basePlane, bundle);
    waterEffect.setBaseMesh(basePlane, bundle);
    windowLightEffect.setBaseMesh(basePlane, bundle);
    windowLightEffect.createLightTarget();
    bushEffect.setBaseMesh(basePlane, bundle);
    treeEffect.setBaseMesh(basePlane, bundle);
    lightingEffect.setBaseMesh(basePlane, bundle);
    overheadShadowsEffect.setBaseMesh(basePlane, bundle);
    buildingShadowsEffect.setBaseMesh(basePlane, bundle);
    cloudEffect.setBaseMesh(basePlane, bundle);

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
    tileManager.setWindowLightEffect(windowLightEffect); // Link for overhead tile lighting
    effectComposer.addUpdatable(tileManager); // Register for occlusion updates
    log.info('Tile manager initialized and synced');

    // Step 4c: Initialize wall manager
    wallManager = new WallManager(threeScene);
    wallManager.initialize();
    // Sync happens in initialize
    log.info('Wall manager initialized');

    // Step 4c.1: Initialize door mesh manager (animated door graphics)
    doorMeshManager = new DoorMeshManager(threeScene, sceneComposer.camera);
    doorMeshManager.initialize();
    effectComposer.addUpdatable(doorMeshManager); // Register for animation updates
    log.info('Door mesh manager initialized');

    // Step 4d: Initialize drawing manager (Three.js drawings)
    drawingManager = new DrawingManager(threeScene);
    drawingManager.initialize();
    log.info('Drawing manager initialized');

    // Step 4e: Initialize note manager
    noteManager = new NoteManager(threeScene);
    noteManager.initialize();
    log.info('Note manager initialized');

    // Step 4f: Initialize template manager
    templateManager = new TemplateManager(threeScene);
    templateManager.initialize();
    log.info('Template manager initialized');

    // Step 4g: Initialize light icon manager
    lightIconManager = new LightIconManager(threeScene);
    lightIconManager.initialize();
    log.info('Light icon manager initialized');

    // Step 4h: Initialize map points manager (v1.x backwards compatibility)
    mapPointsManager = new MapPointsManager(threeScene);
    await mapPointsManager.initialize();
    log.info('Map points manager initialized');

    // Wire map points to particle effects (fire, candle flame, smelly flies, etc.)
    if (fireSparksEffect && mapPointsManager.groups.size > 0) {
      fireSparksEffect.setMapPointsSources(mapPointsManager);
      log.info('Map points wired to fire effect');
    }
    
    // Wire smelly flies to map points (always wire, even if no groups yet - it listens for changes)
    if (smellyFliesEffect) {
      smellyFliesEffect.setMapPointsSources(mapPointsManager);
      log.info('Map points wired to smelly flies effect');
    }

    if (lightningEffect) {
      lightningEffect.setMapPointsSources(mapPointsManager);
      log.info('Map points wired to lightning effect');
    }

    // Step 5: Initialize interaction manager (Selection, Drag/Drop)
    interactionManager = new InteractionManager(threeCanvas, sceneComposer, tokenManager, tileManager, wallManager, lightIconManager);
    interactionManager.initialize();
    effectComposer.addUpdatable(interactionManager); // Register for updates (HUD positioning)
    log.info('Interaction manager initialized');

    // Step 6: Initialize drop handler (for creating new items)
    dropHandler = new DropHandler(threeCanvas, sceneComposer);
    dropHandler.initialize();
    log.info('Drop handler initialized');

    // Step 6: Initialize Camera Follower
    // Simple one-way sync: Three.js camera follows PIXI camera each frame.
    // PIXI/Foundry handles all pan/zoom input - we just read and match.
    // This eliminates bidirectional sync issues and race conditions.
    cameraFollower = new CameraFollower({ sceneComposer });
    cameraFollower.initialize();
    effectComposer.addUpdatable(cameraFollower); // Per-frame sync
    log.info('Camera follower initialized - Three.js follows PIXI');

    // Step 6a: Initialize PIXI Input Bridge
    // Handles pan/zoom input on Three canvas and applies to PIXI stage.
    // CameraFollower then reads PIXI state and updates Three camera.
    pixiInputBridge = new PixiInputBridge(threeCanvas);
    pixiInputBridge.initialize();
    log.info('PIXI input bridge initialized - pan/zoom updates PIXI stage');

    // Step 6b: Initialize controls integration (PIXI overlay system)
    controlsIntegration = new ControlsIntegration({ 
      sceneComposer,
      effectComposer
    });
    await controlsIntegration.initialize();
    
    log.info('Controls integration initialized');

    // Step 7: Ensure Foundry UI layers are above our canvas
    ensureUILayering();

    // Step 8: Start render loop
    renderLoop = new RenderLoop(renderer, threeScene, camera, effectComposer);
    renderLoop.start();

    log.info('Render loop started');

    // Step 8.5: Set up resize handling
    setupResizeHandling();

    // Step 9: Initialize Frame Coordinator for PIXI/Three.js synchronization
    // This hooks into Foundry's ticker to ensure we render after PIXI updates complete
    if (!frameCoordinatorInitialized) {
      frameCoordinatorInitialized = frameCoordinator.initialize();
      if (frameCoordinatorInitialized) {
        // Register fog effect for synchronized texture extraction
        frameCoordinator.onPostPixi((frameState) => {
          // fogEffect may be null during teardown or if initialization failed;
          // in that case, just skip fog work for this frame.
          const fog = fogEffect;
          if (!fog) return;

          // Force vision update when needed so fog textures are current
          // before Three.js renders.
          if (fog._needsVisionUpdate) {
            fog._renderVisionMask();
          }
        });
        
        log.info('Frame coordinator initialized - PIXI/Three.js sync enabled');
      } else {
        log.warn('Frame coordinator failed to initialize - fog may lag during rapid camera movement');
      }
    }
    mapShine.frameCoordinator = frameCoordinator;

    // Expose for diagnostics (after render loop is created)
    mapShine.sceneComposer = sceneComposer;
    mapShine.effectComposer = effectComposer;
    mapShine.specularEffect = specularEffect;
    mapShine.iridescenceEffect = iridescenceEffect;
    mapShine.windowLightEffect = windowLightEffect;
    mapShine.bushEffect = bushEffect;
    mapShine.treeEffect = treeEffect;
    mapShine.smellyFliesEffect = smellyFliesEffect; // Smart particle swarms
    mapShine.dustMotesEffect = dustMotesEffect;
    mapShine.lightningEffect = lightningEffect;
    mapShine.waterEffect = waterEffect;
    mapShine.fogEffect = fogEffect; // Fog of War (world-space plane mesh)
    mapShine.skyColorEffect = skyColorEffect; // NEW: Expose SkyColorEffect
    mapShine.distortionManager = distortionManager;
    mapShine.cameraFollower = cameraFollower; // Three.js camera follows PIXI
    mapShine.pixiInputBridge = pixiInputBridge; // Pan/zoom input bridge
    mapShine.tokenManager = tokenManager; // NEW: Expose token manager for diagnostics
    mapShine.tileManager = tileManager; // NEW: Expose tile manager for diagnostics
    mapShine.wallManager = wallManager; // NEW: Expose wall manager
    mapShine.doorMeshManager = doorMeshManager; // Animated door graphics
    mapShine.drawingManager = drawingManager; // NEW: Expose drawing manager
    mapShine.noteManager = noteManager;
    mapShine.templateManager = templateManager;
    mapShine.lightIconManager = lightIconManager;
    mapShine.interactionManager = interactionManager; // NEW: Expose interaction manager
    mapShine.gridRenderer = gridRenderer; // NEW: Expose grid renderer
    mapShine.mapPointsManager = mapPointsManager; // NEW: Expose map points manager
    mapShine.weatherController = weatherController; // NEW: Expose weather controller
    mapShine.renderLoop = renderLoop; // CRITICAL: Expose render loop for diagnostics
    mapShine.sceneDebug = sceneDebug; // NEW: Expose scene debug helpers
    mapShine.setMapMakerMode = setMapMakerMode; // NEW: Expose mode toggle for UI
    mapShine.controlsIntegration = controlsIntegration; // NEW: Expose controls integration
    // Expose sub-systems for debugging
    if (controlsIntegration) {
      mapShine.cameraSync = controlsIntegration.cameraSync; // May be null now
      mapShine.inputRouter = controlsIntegration.inputRouter;
      mapShine.layerVisibility = controlsIntegration.layerVisibility;
    }
    // Attach to canvas as well for convenience (used by console snippets)
    try { canvas.mapShine = mapShine; } catch (_) {}

    log.info('Specular effect registered and initialized');

    // Log FPS periodically
    if (fpsLogIntervalId !== null) {
      clearInterval(fpsLogIntervalId);
      fpsLogIntervalId = null;
    }
    fpsLogIntervalId = setInterval(() => {
      if (renderLoop && renderLoop.running()) {
        log.debug(`FPS: ${renderLoop.getFPS()}, Frames: ${renderLoop.getFrameCount()}`);
      }
    }, 5000);

    // Initialize Tweakpane UI
    try {
      await initializeUI(
        specularEffect,
        iridescenceEffect,
        colorCorrectionEffect,
        asciiEffect,
        prismEffect,
        lightingEffect,
        skyColorEffect,
        bloomEffect,
        lensflareEffect,
        fireSparksEffect,
        smellyFliesEffect,
        dustMotesEffect,
        lightningEffect,
        windowLightEffect,
        overheadShadowsEffect,
        buildingShadowsEffect,
        cloudEffect,
        bushEffect,
        treeEffect,
        waterEffect,
        fogEffect,
        distortionManager,
        maskDebugEffect
      );
    } catch (e) {
      log.error('Failed to initialize UI:', e);
    }

    // Only begin fading-in once we have proof that Three has actually rendered.
    // This prevents the overlay from fading out during shader compilation / first-frame stutter.
    try {
      loadingOverlay.setMessage('Finalizing…');
    } catch (e) {
      // Ignore overlay errors
    }

    try {
      await waitForThreeFrames(renderer, renderLoop, 6, 12000, {
        minCalls: 1,
        stableCallsFrames: 3,
        minDelayMs: 350
      });
    } catch (e) {
      // Ignore wait errors
    }

    try {
      loadingOverlay.setMessage('Finished');
      loadingOverlay.setProgress(1);
      await loadingOverlay.fadeIn(5000);
    } catch (e) {
      // Ignore overlay errors
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
 * @param {AsciiEffect} asciiEffect - The ASCII effect instance
 * @param {PrismEffect} prismEffect - The prism effect instance
 * @param {LightingEffect} lightingEffect - The dynamic lighting effect instance
 * @param {SkyColorEffect} skyColorEffect - The sky color grading effect instance
 * @param {BloomEffect} bloomEffect - The bloom effect instance
 * @param {LensflareEffect} lensflareEffect - The lensflare effect instance
 * @param {WindowLightEffect} windowLightEffect - The window lighting effect instance
 * @param {OverheadShadowsEffect} overheadShadowsEffect - The overhead shadows effect instance
 * @param {BuildingShadowsEffect} buildingShadowsEffect - The building shadows effect instance
 * @param {CloudEffect} cloudEffect - The procedural cloud shadows effect instance
 * @param {BushEffect} bushEffect - The animated bushes surface effect instance
 * @param {TreeEffect} treeEffect - The animated trees surface effect instance
 * @param {WaterEffect} waterEffect - The water effect instance
 * @param {FogEffect} fogEffect - The fog of war effect instance
 * @param {DistortionManager} distortionManager - The centralized distortion manager
 * @private
 */
async function initializeUI(specularEffect, iridescenceEffect, colorCorrectionEffect, asciiEffect, prismEffect, lightingEffect, skyColorEffect, bloomEffect, lensflareEffect, fireSparksEffect, smellyFliesEffect, dustMotesEffect, lightningEffect, windowLightEffect, overheadShadowsEffect, buildingShadowsEffect, cloudEffect, bushEffect, treeEffect, waterEffect, fogEffect, distortionManager, maskDebugEffect) {
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

  // --- Fog Settings ---
  if (fogEffect) {
    const fogSchema = WorldSpaceFogEffect.getControlSchema();
    
    const onFogUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        fogEffect.enabled = value;
        log.debug(`Fog effect ${value ? 'enabled' : 'disabled'}`);
      } else if (fogEffect.params[paramId] !== undefined) {
        fogEffect.params[paramId] = value;
        log.debug(`Fog.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'fog',
      'Fog of War',
      fogSchema,
      onFogUpdate,
      'global'
    );
  }

  // --- Animated Bushes Settings ---
  if (bushEffect) {
    const bushSchema = BushEffect.getControlSchema();

    const onBushUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        bushEffect.enabled = value;
        log.debug(`Bush effect ${value ? 'enabled' : 'disabled'}`);
      } else if (bushEffect.params && Object.prototype.hasOwnProperty.call(bushEffect.params, paramId)) {
        bushEffect.params[paramId] = value;
        log.debug(`Bush.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'bush',
      'Animated Bushes',
      bushSchema,
      onBushUpdate,
      'surface'
    );
  }

  // --- Animated Trees Settings ---
  if (treeEffect) {
    const treeSchema = TreeEffect.getControlSchema();

    const onTreeUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        treeEffect.enabled = value;
        log.debug(`Tree effect ${value ? 'enabled' : 'disabled'}`);
      } else if (treeEffect.params && Object.prototype.hasOwnProperty.call(treeEffect.params, paramId)) {
        treeEffect.params[paramId] = value;
        log.debug(`Tree.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'tree',
      'Animated Trees (Canopy)',
      treeSchema,
      onTreeUpdate,
      'surface'
    );
  }

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

  // --- Prism Settings ---
  if (prismEffect) {
    const prismSchema = PrismEffect.getControlSchema();
    
    const onPrismUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        prismEffect.enabled = value;
        log.debug(`Prism effect ${value ? 'enabled' : 'disabled'}`);
      } else if (prismEffect.params[paramId] !== undefined) {
        prismEffect.params[paramId] = value;
        log.debug(`Prism.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'prism',
      'Prism / Refraction',
      prismSchema,
      onPrismUpdate,
      'surface'
    );

    // Sync status
    if (uiManager.effectFolders['prism']) {
      const folderData = uiManager.effectFolders['prism'];
      folderData.params.textureStatus = prismEffect.params.textureStatus;
      
      if (folderData.bindings.textureStatus) {
        folderData.bindings.textureStatus.refresh();
      }
      uiManager.updateEffectiveState('prism');
    }
  }

  // --- Lighting / Tone Mapping Settings (Global & Post) ---
  if (lightingEffect) {
    const lightingSchema = LightingEffect.getControlSchema();

    const onLightingUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        lightingEffect.enabled = value;
        log.debug(`Lighting effect ${value ? 'enabled' : 'disabled'}`);
      } else if (lightingEffect.params && Object.prototype.hasOwnProperty.call(lightingEffect.params, paramId)) {
        lightingEffect.params[paramId] = value;
        log.debug(`Lighting.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'lighting',
      'Lighting & Tone Mapping',
      lightingSchema,
      onLightingUpdate,
      'global'
    );
  }

  // --- Sky Color Settings (Global & Post) ---
  if (skyColorEffect) {
    const skySchema = SkyColorEffect.getControlSchema();

    const onSkyUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        skyColorEffect.enabled = value;
        log.debug(`SkyColor effect ${value ? 'enabled' : 'disabled'}`);
      } else if (skyColorEffect.params && Object.prototype.hasOwnProperty.call(skyColorEffect.params, paramId)) {
        skyColorEffect.params[paramId] = value;
        log.debug(`SkyColor.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'sky-color',
      'Sky Color',
      skySchema,
      onSkyUpdate,
      'global'
    );
  }

  // --- Bloom Settings ---
  if (bloomEffect) {
    // ... (rest of the code remains the same)
    const bloomSchema = BloomEffect.getControlSchema();
    
    const onBloomUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        bloomEffect.enabled = value;
        log.debug(`Bloom effect ${value ? 'enabled' : 'disabled'}`);
      } else if (bloomEffect.params[paramId] !== undefined) {
        bloomEffect.params[paramId] = value;
        log.debug(`Bloom.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'bloom',
      'Bloom (Glow)',
      bloomSchema,
      onBloomUpdate,
      'global'
    );
  }

  // --- Lensflare Settings ---
  if (lensflareEffect) {
    const lensflareSchema = LensflareEffect.getControlSchema();
    
    const onLensflareUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        // Drive the internal params.enabled flag for this effect; the
        // EffectComposer keeps the effect registered so update() can
        // hide/show flares without being removed from the pipeline.
        if (lensflareEffect.params && Object.prototype.hasOwnProperty.call(lensflareEffect.params, 'enabled')) {
          lensflareEffect.params.enabled = value;
        }
        log.debug(`Lensflare effect ${value ? 'enabled' : 'disabled'}`);
      } else if (lensflareEffect.params[paramId] !== undefined) {
        lensflareEffect.params[paramId] = value;
        log.debug(`Lensflare.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'lensflare',
      'Lensflare',
      lensflareSchema,
      onLensflareUpdate,
      'global'
    );
  }

  // --- Weather System Settings ---
  const weatherSchema = weatherController.constructor.getControlSchema();

  const onWeatherUpdate = (effectId, paramId, value) => {
    // Handle different parameter groups
    if (paramId === 'enabled') {
       // Runtime kill-switch for weather simulation & particles.
       // When disabled, ParticleSystem.update() checks this flag and skips
       // all WeatherController + WeatherParticles work so we can profile
       // map performance without any precipitation overhead.
       weatherController.enabled = !!value;
       log.debug(`Weather system ${value ? 'enabled' : 'disabled'}`);
    } else if (paramId === 'roofMaskForceEnabled') {
      // Manual override for indoor masking independent of roof hover state
      weatherController.roofMaskForceEnabled = !!value;
    } else if (paramId === 'transitionDuration') {
      weatherController.transitionDuration = value;
    } else if (paramId === 'variability') {
      weatherController.setVariability(value);
    } else if (paramId === 'simulationSpeed') {
      weatherController.simulationSpeed = value;
    } else if (paramId === 'timeOfDay') {
      weatherController.setTime(value);
    } else if (paramId === 'gustWaitMin') {
      weatherController.gustWaitMin = value;
    } else if (paramId === 'gustWaitMax') {
      weatherController.gustWaitMax = value;
    } else if (paramId === 'gustDuration') {
      weatherController.gustDuration = value;
    } else if (paramId === 'gustStrength') {
      weatherController.gustStrength = value;
    } else if (paramId === 'rainCurlStrength') {
      weatherController.rainTuning.curlStrength = value;
    } else {
      // Manual Overrides (update target state directly)
      const target = weatherController.targetState;
      
      if (paramId === 'windDirection') {
        // UI gives degrees (0-360), convert to vector
        const rad = (value * Math.PI) / 180;

        // Ensure windDirection is a THREE.Vector2 before using .set()
        const THREE = window.THREE;
        if (!THREE) {
          // If THREE is not available for some reason, bail out safely
          log.warn('THREE not available while updating windDirection');
          return;
        }

        if (!(target.windDirection instanceof THREE.Vector2)) {
          const existing = target.windDirection || { x: 1, y: 0 };
          target.windDirection = new THREE.Vector2(existing.x ?? 1, existing.y ?? 0);
        }

        target.windDirection.set(Math.cos(rad), Math.sin(rad));
      } else if (paramId.startsWith('rain')) {
        const rt = weatherController.rainTuning;
        if (!rt) return;
        if (paramId === 'rainIntensityScale') rt.intensityScale = value;
        else if (paramId === 'rainStreakLength') rt.streakLength = value;
        else if (paramId === 'rainDropSize') rt.dropSize = value;
        else if (paramId === 'rainDropSizeMin') rt.dropSizeMin = value;
        else if (paramId === 'rainDropSizeMax') rt.dropSizeMax = value;
        else if (paramId === 'rainBrightness') rt.brightness = value;
        else if (paramId === 'rainGravityScale') rt.gravityScale = value;
        else if (paramId === 'rainWindInfluence') rt.windInfluence = value;
        else if (paramId === 'rainCurlStrength') rt.curlStrength = value;
        // Splash-specific controls
        else if (paramId === 'rainSplashIntensityScale') rt.splashIntensityScale = value;
        else if (paramId === 'rainSplashLifeMin') rt.splashLifeMin = value;
        else if (paramId === 'rainSplashLifeMax') rt.splashLifeMax = value;
        else if (paramId === 'rainSplashSizeMin') rt.splashSizeMin = value;
        else if (paramId === 'rainSplashSizeMax') rt.splashSizeMax = value;
        else if (paramId === 'rainSplashOpacityPeak') rt.splashOpacityPeak = value;
        // Per-splash (per atlas tile) controls
        else if (paramId === 'rainSplash1IntensityScale') rt.splash1IntensityScale = value;
        else if (paramId === 'rainSplash1LifeMin') rt.splash1LifeMin = value;
        else if (paramId === 'rainSplash1LifeMax') rt.splash1LifeMax = value;
        else if (paramId === 'rainSplash1SizeMin') rt.splash1SizeMin = value;
        else if (paramId === 'rainSplash1SizeMax') rt.splash1SizeMax = value;
        else if (paramId === 'rainSplash1OpacityPeak') rt.splash1OpacityPeak = value;
        else if (paramId === 'rainSplash2IntensityScale') rt.splash2IntensityScale = value;
        else if (paramId === 'rainSplash2LifeMin') rt.splash2LifeMin = value;
        else if (paramId === 'rainSplash2LifeMax') rt.splash2LifeMax = value;
        else if (paramId === 'rainSplash2SizeMin') rt.splash2SizeMin = value;
        else if (paramId === 'rainSplash2SizeMax') rt.splash2SizeMax = value;
        else if (paramId === 'rainSplash2OpacityPeak') rt.splash2OpacityPeak = value;
        else if (paramId === 'rainSplash3IntensityScale') rt.splash3IntensityScale = value;
        else if (paramId === 'rainSplash3LifeMin') rt.splash3LifeMin = value;
        else if (paramId === 'rainSplash3LifeMax') rt.splash3LifeMax = value;
        else if (paramId === 'rainSplash3SizeMin') rt.splash3SizeMin = value;
        else if (paramId === 'rainSplash3SizeMax') rt.splash3SizeMax = value;
        else if (paramId === 'rainSplash3OpacityPeak') rt.splash3OpacityPeak = value;
        else if (paramId === 'rainSplash4IntensityScale') rt.splash4IntensityScale = value;
        else if (paramId === 'rainSplash4LifeMin') rt.splash4LifeMin = value;
        else if (paramId === 'rainSplash4LifeMax') rt.splash4LifeMax = value;
        else if (paramId === 'rainSplash4SizeMin') rt.splash4SizeMin = value;
        else if (paramId === 'rainSplash4SizeMax') rt.splash4SizeMax = value;
        else if (paramId === 'rainSplash4OpacityPeak') rt.splash4OpacityPeak = value;
      } else if (paramId.startsWith('snow')) {
        const st = weatherController.snowTuning;
        if (!st) return;
        if (paramId === 'snowIntensityScale') st.intensityScale = value;
        else if (paramId === 'snowFlakeSize') st.flakeSize = value;
        else if (paramId === 'snowBrightness') st.brightness = value;
        else if (paramId === 'snowGravityScale') st.gravityScale = value;
        else if (paramId === 'snowWindInfluence') st.windInfluence = value;
        else if (paramId === 'snowCurlStrength') st.curlStrength = value;
        else if (paramId === 'snowFlutterStrength') st.flutterStrength = value;
      } else if (target[paramId] !== undefined) {
        target[paramId] = value;
      }
      
      // If we are NOT transitioning, we might want to snap startState too
      // so next transition starts from here? 
      // Actually, if we change targetState while not transitioning, 
      // the update loop will snap currentState to targetState immediately.
      // So we get instant feedback.
    }
  };

  // Initialize params object from current controller state for the UI
  // We want the UI to reflect the Target State (what the user set), not the wandering Current State
  const weatherParams = {
    enabled: weatherController.enabled ?? true,
    transitionDuration: weatherController.transitionDuration,
    variability: weatherController.variability,
    simulationSpeed: weatherController.simulationSpeed,
    timeOfDay: weatherController.timeOfDay,
    roofMaskForceEnabled: weatherController.roofMaskForceEnabled,
    
    // Manual params
    precipitation: weatherController.targetState.precipitation,
    cloudCover: weatherController.targetState.cloudCover,
    windSpeed: weatherController.targetState.windSpeed,
    windDirection: Math.atan2(weatherController.targetState.windDirection.y, weatherController.targetState.windDirection.x) * (180 / Math.PI),
    fogDensity: weatherController.targetState.fogDensity,
    wetness: weatherController.currentState.wetness, // Read-only derived
    freezeLevel: weatherController.targetState.freezeLevel,

    // Wind / Gust tuning
    gustWaitMin: weatherController.gustWaitMin,
    gustWaitMax: weatherController.gustWaitMax,
    gustDuration: weatherController.gustDuration,
    gustStrength: weatherController.gustStrength
  };

  // Fix negative angles
  if (weatherParams.windDirection < 0) weatherParams.windDirection += 360;

  // Override the schema defaults with current values to ensure sync
  // (This is a bit of a hack to pre-populate the UI)
  // uiManager.registerEffect will merge these with loaded settings
  
  // We pass a custom 'updateCallback' that intercepts the preset logic in TweakpaneManager if needed,
  // or we just rely on the standard callback.
  // The TweakpaneManager handles presets by iterating properties and calling this callback.
  // So if a preset sets 'precipitation' to 0.8, it calls onWeatherUpdate('weather', 'precipitation', 0.8).
  // This works perfect.

  uiManager.registerEffect(
    'weather',
    'Weather System',
    weatherSchema,
    onWeatherUpdate,
    'atmospheric'
  );

  // --- Cloud & Cloud Shadow Appearance (Weather Subcategory) ---
  if (cloudEffect) {
    const cloudSchema = CloudEffect.getControlSchema();

    const onCloudUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        cloudEffect.enabled = !!value;
        log.debug(`Cloud effect ${value ? 'enabled' : 'disabled'}`);
      } else if (cloudEffect.params && Object.prototype.hasOwnProperty.call(cloudEffect.params, paramId)) {
        cloudEffect.params[paramId] = value;
        log.debug(`Cloud.${paramId} =`, value);
      }
    };

    uiManager.registerEffectUnderEffect(
      'weather',
      'cloud',
      'Cloud and Cloud Shadow Appearance',
      cloudSchema,
      onCloudUpdate
    );
  }

  // --- Window Light Settings ---
  if (windowLightEffect) {
    const windowSchema = WindowLightEffect.getControlSchema();

    const onWindowUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        windowLightEffect.enabled = value;
        log.debug(`WindowLight effect ${value ? 'enabled' : 'disabled'}`);
      } else if (windowLightEffect.params && Object.prototype.hasOwnProperty.call(windowLightEffect.params, paramId)) {
        windowLightEffect.params[paramId] = value;
      }
    };

    uiManager.registerEffect(
      'windowLight',
      'Window Light',
      windowSchema,
      onWindowUpdate,
      'atmospheric'
    );

    if (uiManager.effectFolders['windowLight']) {
      const folderData = uiManager.effectFolders['windowLight'];
      folderData.params.textureStatus = windowLightEffect.params.textureStatus;

      if (folderData.bindings.textureStatus) {
        folderData.bindings.textureStatus.refresh();
      }
      uiManager.updateEffectiveState('windowLight');
    }
  }

  // --- Overhead Shadows Settings ---
  if (overheadShadowsEffect) {
    const overheadSchema = OverheadShadowsEffect.getControlSchema();

    const onOverheadUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        overheadShadowsEffect.enabled = !!value;
        log.debug(`OverheadShadows effect ${value ? 'enabled' : 'disabled'}`);
      } else if (overheadShadowsEffect.params && Object.prototype.hasOwnProperty.call(overheadShadowsEffect.params, paramId)) {
        overheadShadowsEffect.params[paramId] = value;
        log.debug(`OverheadShadows.${paramId} =`, value);

        // Keep BuildingShadowsEffect's sunLatitude in sync so both
        // shadow casters share the same north/south eccentricity.
        if (paramId === 'sunLatitude' && buildingShadowsEffect && buildingShadowsEffect.params) {
          buildingShadowsEffect.params.sunLatitude = value;
          log.debug('BuildingShadows.sunLatitude synced from OverheadShadows:', value);
        }
      }
    };

    uiManager.registerEffect(
      'overhead-shadows',
      'Overhead Shadows',
      overheadSchema,
      onOverheadUpdate,
      'atmospheric'
    );
  }

  // --- Building Shadows Settings ---
  if (buildingShadowsEffect) {
    const buildingSchema = BuildingShadowsEffect.getControlSchema();

    const onBuildingUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        buildingShadowsEffect.enabled = !!value;
        log.debug(`BuildingShadows effect ${value ? 'enabled' : 'disabled'}`);
      } else if (buildingShadowsEffect.params && Object.prototype.hasOwnProperty.call(buildingShadowsEffect.params, paramId)) {
        buildingShadowsEffect.params[paramId] = value;
        log.debug(`BuildingShadows.${paramId} =`, value);

        // Keep OverheadShadowsEffect's sunLatitude in sync so both
        // shadow casters share the same north/south eccentricity.
        if (paramId === 'sunLatitude' && overheadShadowsEffect && overheadShadowsEffect.params) {
          overheadShadowsEffect.params.sunLatitude = value;
          log.debug('OverheadShadows.sunLatitude synced from BuildingShadows:', value);
        }
      }
    };

    uiManager.registerEffect(
      'building-shadows',
      'Building Shadows',
      buildingSchema,
      onBuildingUpdate,
      'atmospheric'
    );
  }

  // --- Fire Debug Settings ---
  if (fireSparksEffect) {
    const fireSchema = FireSparksEffect.getControlSchema();
    
    const onFireUpdate = (effectId, paramId, value) => {
      fireSparksEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'fire-sparks',
      'Fire',
      fireSchema,
      onFireUpdate,
      'particle'
    );
  }

  if (lightningEffect) {
    const lightningSchema = LightningEffect.getControlSchema();

    const onLightningUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        lightningEffect.enabled = !!value;
        log.debug(`Lightning effect ${value ? 'enabled' : 'disabled'}`);
      } else {
        lightningEffect.applyParamChange(paramId, value);
      }
    };

    uiManager.registerEffect(
      'lightning',
      'Lightning (Map Points)',
      lightningSchema,
      onLightningUpdate,
      'particle'
    );
  }

  // --- Distortion Manager Settings ---
  if (distortionManager) {
    const distortionSchema = DistortionManager.getControlSchema();
    
    const onDistortionUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        distortionManager.enabled = value;
        log.debug(`DistortionManager ${value ? 'enabled' : 'disabled'}`);
      } else if (distortionManager.params && Object.prototype.hasOwnProperty.call(distortionManager.params, paramId)) {
        distortionManager.params[paramId] = value;
        log.debug(`Distortion.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'distortion',
      'Screen Distortion',
      distortionSchema,
      onDistortionUpdate,
      'global'
    );
  }

  // --- Water Settings ---
  if (waterEffect) {
    const waterSchema = WaterEffect.getControlSchema();

    const onWaterUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        waterEffect.enabled = !!value;
        log.debug(`Water effect ${value ? 'enabled' : 'disabled'}`);
      } else if (waterEffect.params && Object.prototype.hasOwnProperty.call(waterEffect.params, paramId)) {
        waterEffect.params[paramId] = value;
      }
    };

    uiManager.registerEffect(
      'water',
      'Water',
      waterSchema,
      onWaterUpdate,
      'water'
    );
  }

  // --- Smelly Flies Settings ---
  if (smellyFliesEffect) {
    const fliesSchema = SmellyFliesEffect.getControlSchema();
    
    const onFliesUpdate = (effectId, paramId, value) => {
      smellyFliesEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'smelly-flies',
      'Smelly Flies',
      fliesSchema,
      onFliesUpdate,
      'particle'
    );

    // Add "Draw Spawn Area" button to Smelly Flies folder
    const fliesFolderData = uiManager.effectFolders?.['smelly-flies'];
    if (fliesFolderData?.folder) {
      fliesFolderData.folder.addButton({
        title: '🎯 Draw Spawn Area'
      }).on('click', () => {
        const interactionManager = window.MapShine?.interactionManager;
        if (interactionManager) {
          interactionManager.startMapPointDrawing('smellyFlies', 'area');
        } else {
          ui.notifications.warn('Interaction manager not available');
        }
      });
    }
  }

  if (dustMotesEffect) {
    const dustSchema = DustMotesEffect.getControlSchema();

    const onDustUpdate = (effectId, paramId, value) => {
      dustMotesEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'dust',
      'Dust',
      dustSchema,
      onDustUpdate,
      'particle'
    );
  }

  // Add a simple windvane indicator inside the Weather UI folder that reflects
  // the live scene wind direction from WeatherController.currentState.
  try {
    const weatherFolderData = uiManager.effectFolders?.weather;
    const folderElement = weatherFolderData?.folder?.element;
    if (folderElement) {
      const content = folderElement.querySelector('.tp-fldv_c') || folderElement;

      const vaneWrapper = document.createElement('div');
      vaneWrapper.style.display = 'flex';
      vaneWrapper.style.alignItems = 'center';
      vaneWrapper.style.justifyContent = 'space-between';
      vaneWrapper.style.marginTop = '4px';

      const label = document.createElement('div');
      label.textContent = 'Wind Direction';
      label.style.fontSize = '11px';

      const vane = document.createElement('div');
      vane.style.width = '24px';
      vane.style.height = '24px';
      vane.style.position = 'relative';

      const arrow = document.createElement('div');
      arrow.style.position = 'absolute';
      arrow.style.left = '50%';
      arrow.style.top = '50%';
      arrow.style.width = '2px';
      arrow.style.height = '10px';
      arrow.style.background = 'currentColor';
      arrow.style.transformOrigin = '50% 100%';

      const arrowHead = document.createElement('div');
      arrowHead.style.position = 'absolute';
      arrowHead.style.left = '50%';
      arrowHead.style.top = '0';
      arrowHead.style.transform = 'translate(-50%, -50%)';
      arrowHead.style.width = '0';
      arrowHead.style.height = '0';
      arrowHead.style.borderLeft = '4px solid transparent';
      arrowHead.style.borderRight = '4px solid transparent';
      arrowHead.style.borderBottom = '6px solid currentColor';

      arrow.appendChild(arrowHead);
      vane.appendChild(arrow);

      vaneWrapper.appendChild(label);
      vaneWrapper.appendChild(vane);
      content.appendChild(vaneWrapper);

      // Periodically sync arrow rotation with the live wind direction.
      const updateWindVane = () => {
        const state = weatherController.getCurrentState();
        if (!state || !state.windDirection) return;
        const angleRad = Math.atan2(state.windDirection.y, state.windDirection.x);
        const angleDeg = (angleRad * 180) / Math.PI;
        // Map world wind vector angle to UI rotation so that:
        // 0° (east), 90° (north), 180° (west), 270° (south) all align visually
        // with the direction the wind is pushing.
        // This mapping preserves correctness at 0° and 180° while fixing 90°/270°.
        arrow.style.transform = `translate(-50%, -50%) rotate(${90 - angleDeg}deg)`;
      };

      updateWindVane();
      if (windVaneIntervalId !== null) {
        clearInterval(windVaneIntervalId);
        windVaneIntervalId = null;
      }
      windVaneIntervalId = setInterval(updateWindVane, 200);
    }
  } catch (e) {
    log.warn('Failed to add windvane UI indicator:', e);
  }

  // Manually sync the initial values into the UI manager's storage for this effect
  // because registerEffect loads from scene settings or defaults, but we want to sync 
  // with the controller's in-memory state if it was initialized differently.
  // Actually, registerEffect handles loading. We should let it load, then sync controller TO settings?
  // Or settings TO controller?
  // Let's assume Scene Settings are authoritative.
  // The updateCallback is called during initialization for loaded params.
  // So weatherController will be updated to match Scene Settings. Perfect.

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

  // --- ASCII Effect ---
  if (asciiEffect) {
    const asciiSchema = AsciiEffect.getControlSchema();
    
    const onAsciiUpdate = (effectId, paramId, value) => {
       if (paramId === 'enabled' || paramId === 'masterEnabled') {
         asciiEffect.enabled = value;
         log.debug(`Ascii effect ${value ? 'enabled' : 'disabled'}`);
       } else {
         asciiEffect.params[paramId] = value;
         // Params are read in update() loop
       }
    };
    
    uiManager.registerEffect(
      'ascii',
      'ASCII Art',
      asciiSchema,
      onAsciiUpdate,
      'global'
    );
    log.info('ASCII effect wired to UI');
  }

  if (maskDebugEffect) {
    const ids = (() => {
      try {
        const mm = window.MapShine?.maskManager;
        const list = mm ? mm.listIds() : [];
        const o = {};
        for (const id of list) {
          o[id] = id;
        }
        return o;
      } catch (e) {
        return null;
      }
    })();

    const schema = MaskDebugEffect.getControlSchema(ids);
    const onUpdate = (effectId, paramId, value) => {
      maskDebugEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'mask-debug',
      'Mask Debug',
      schema,
      onUpdate,
      'debug'
    );
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
  // Clean up resize handling first
  cleanupResizeHandling();

  // Clear any timers created by this module
  if (fpsLogIntervalId !== null) {
    clearInterval(fpsLogIntervalId);
    fpsLogIntervalId = null;
  }
  if (windVaneIntervalId !== null) {
    clearInterval(windVaneIntervalId);
    windVaneIntervalId = null;
  }

  // Dispose UI manager
  if (uiManager) {
    uiManager.dispose();
    uiManager = null;
    log.debug('UI manager disposed');
  }

  // Dispose camera follower
  if (cameraFollower) {
    cameraFollower.dispose();
    cameraFollower = null;
    log.debug('Camera follower disposed');
  }

  // Dispose PIXI input bridge
  if (pixiInputBridge) {
    pixiInputBridge.dispose();
    pixiInputBridge = null;
    log.debug('PIXI input bridge disposed');
  }

  // Dispose controls integration
  if (controlsIntegration) {
    controlsIntegration.destroy();
    controlsIntegration = null;
    log.debug('Controls integration disposed');
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

  // Dispose door mesh manager
  if (doorMeshManager) {
    doorMeshManager.dispose();
    doorMeshManager = null;
    log.debug('Door mesh manager disposed');
  }

  // Dispose drawing manager
  if (drawingManager) {
    drawingManager.dispose();
    drawingManager = null;
    log.debug('Drawing manager disposed');
  }

  // Dispose note manager
  if (noteManager) {
    noteManager.dispose();
    noteManager = null;
    log.debug('Note manager disposed');
  }

  // Dispose template manager
  if (templateManager) {
    templateManager.dispose();
    templateManager = null;
    log.debug('Template manager disposed');
  }

  // Dispose light icon manager
  if (lightIconManager) {
    lightIconManager.dispose();
    lightIconManager = null;
    log.debug('Light icon manager disposed');
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

  // Dispose map points manager
  if (mapPointsManager) {
    mapPointsManager.dispose();
    mapPointsManager = null;
    log.debug('Map points manager disposed');
  }

  // Dispose effect composer
  if (effectComposer) {
    effectComposer.dispose();
    effectComposer = null;
    log.debug('Effect composer disposed');
  }

  // Dispose Fog of War (FogEffect is disposed as part of effectComposer)
  fogEffect = null;

  lightningEffect = null;

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
 * Set Map Maker Mode (Master Toggle)
 * @param {boolean} enabled - True for Map Maker (PIXI), False for Gameplay (Three.js)
 * @public
 */
export function setMapMakerMode(enabled) {
  if (isMapMakerMode === enabled) return;
  
  isMapMakerMode = enabled;
  log.info(`Switching to ${enabled ? 'Map Maker' : 'Gameplay'} Mode`);
  
  if (enabled) {
    disableSystem(); // Hide Three.js, Show PIXI
  } else {
    enableSystem(); // Show Three.js, Hide PIXI layers
  }
}

function applyMapMakerFogOverride() {
  if (!game?.user?.isGM) return;
  if (!canvas?.ready) return;

  // Capture prior state once per Map Maker entry.
  if (!mapMakerFogState) {
    mapMakerFogState = {
      fogVisible: canvas.fog?.visible ?? null,
      visibilityVisible: canvas.visibility?.visible ?? null,
      visibilityFilterEnabled: canvas.visibility?.filter?.enabled ?? null
    };
  }

  // In Map Maker mode, fog/visibility can black out the entire map for GMs
  // when no token vision source is active. Hide them to keep the map editable.
  try {
    if (canvas.fog) canvas.fog.visible = false;
    if (canvas.visibility) canvas.visibility.visible = false;
    if (canvas.visibility?.filter) canvas.visibility.filter.enabled = false;
  } catch (_) {
    // Ignore - structure may vary by Foundry version
  }
}

function restoreMapMakerFogOverride() {
  if (!mapMakerFogState) return;

  try {
    if (canvas?.fog && mapMakerFogState.fogVisible !== null) {
      canvas.fog.visible = mapMakerFogState.fogVisible;
    }
    if (canvas?.visibility && mapMakerFogState.visibilityVisible !== null) {
      canvas.visibility.visible = mapMakerFogState.visibilityVisible;
    }
    if (canvas?.visibility?.filter && mapMakerFogState.visibilityFilterEnabled !== null) {
      canvas.visibility.filter.enabled = mapMakerFogState.visibilityFilterEnabled;
    }
  } catch (_) {
    // Ignore
  } finally {
    mapMakerFogState = null;
  }
}

/**
 * Enable the Three.js System (Gameplay Mode)
 * @private
 */
function enableSystem() {
  if (!threeCanvas) return;

  // Leaving Map Maker mode - restore any temporary fog/visibility overrides.
  restoreMapMakerFogOverride();
  
  // Resume Render Loop
  if (renderLoop && !renderLoop.running()) {
    renderLoop.start();
  }
  
  // Three.js Canvas: visible but render-only (no interaction)
  threeCanvas.style.opacity = '1';
  threeCanvas.style.zIndex = '1'; // Below PIXI
  threeCanvas.style.pointerEvents = 'none'; // Three.js is render-only
  
  // PIXI Canvas: on top, handles ALL interaction
  const pixiCanvas = canvas.app?.view;
  if (pixiCanvas) {
    pixiCanvas.style.opacity = '1'; // Visible for overlay layers
    pixiCanvas.style.zIndex = '10'; // On top
    pixiCanvas.style.pointerEvents = 'auto'; // PIXI handles ALL interaction
  }
  
  // CRITICAL: Set PIXI renderer background to transparent
  // This allows Three.js content to show through
  if (canvas.app?.renderer?.background) {
    canvas.app.renderer.background.alpha = 0;
  }
  
  // Re-enable ControlsIntegration if it was disabled (e.g., returning from Map Maker mode)
  if (controlsIntegration) {
    const state = controlsIntegration.getState();
    if (state === 'disabled') {
      // Re-initialize to restore hooks and layer management
      controlsIntegration.initialize().then(() => {
        log.info('ControlsIntegration re-enabled after Map Maker mode');
      }).catch(err => {
        log.warn('Failed to re-enable ControlsIntegration:', err);
        configureFoundryCanvas();
      });
    } else if (state === 'active') {
      controlsIntegration.layerVisibility?.update();
      controlsIntegration.inputRouter?.autoUpdate();
    } else {
      // Fallback to legacy configuration
      configureFoundryCanvas();
    }
  } else {
    // Fallback to legacy configuration
    configureFoundryCanvas();
  }
}

/**
 * Disable the Three.js System (Map Maker Mode)
 * @private
 */
function disableSystem() {
  // Pause Render Loop to save resources
  if (renderLoop && renderLoop.running()) {
    renderLoop.stop();
  }
  
  // Hide Three.js Canvas
  if (threeCanvas) {
    threeCanvas.style.opacity = '0';
    threeCanvas.style.pointerEvents = 'none';
  }
  
  // CRITICAL: Disable ControlsIntegration BEFORE restoring PIXI.
  // This prevents its hooks from re-hiding layers after we restore them.
  // The disable() method calls restoreAllLayers() internally.
  if (controlsIntegration && controlsIntegration.getState() === 'active') {
    controlsIntegration.disable();
    log.info('ControlsIntegration disabled for Map Maker mode');
  } else {
    // Fallback if ControlsIntegration isn't active
    restoreFoundryRendering();
  }

  // GM convenience: prevent Foundry fog/visibility from blacking out the map
  // while editing in Map Maker mode.
  applyMapMakerFogOverride();
}

/**
 * Configure Foundry's PIXI canvas for Hybrid Mode
 * Keeps canvas visible but hides specific layers we've replaced
 * Sets up input arbitration to pass clicks through to THREE.js when needed
 * 
 * NOTE: This function is now largely superseded by ControlsIntegration.
 * It remains for backward compatibility and fallback scenarios.
 * @private
 */
function configureFoundryCanvas() {
  if (!canvas || !canvas.app) {
    log.warn('Cannot configure canvas - Foundry canvas not ready');
    return;
  }

  // If controls integration is active, let it handle configuration
  if (controlsIntegration && controlsIntegration.getState() === 'active') {
    log.debug('Controls integration active, skipping legacy configureFoundryCanvas');
    return;
  }

  log.info('Configuring Foundry PIXI canvas for Hybrid Mode (legacy)');

  const pixiCanvas = canvas.app.view;
  if (pixiCanvas) {
    // PIXI-first strategy: PIXI handles ALL interaction, Three.js is render-only
    // PIXI stays on top with opacity 1 so overlay layers (drawings, templates, notes) show.
    // Three.js is below but visible through PIXI's transparent background.
    pixiCanvas.style.opacity = '1'; // Keep visible for overlay layers
    pixiCanvas.style.pointerEvents = 'auto'; // PIXI handles ALL interaction
    pixiCanvas.style.zIndex = '10'; // On top
  }
  
  // CRITICAL: Set PIXI renderer background to transparent
  if (canvas.app?.renderer?.background) {
    canvas.app.renderer.background.alpha = 0;
  }

  // Update layer visibility based on current tool
  updateLayerVisibility();

  // Setup Input Arbitration (Tool switching)
  setupInputArbitration();

  log.info('PIXI canvas configured for Replacement Mode (legacy)');
}

/**
 * Update visibility of Foundry layers based on active tool and mode
 * @private
 */
function updateLayerVisibility() {
  if (!canvas.ready) return;
  
  // 1. Always Hide "Replaced" Layers in Gameplay/Hybrid Mode
  // These are rendered by Three.js
  if (canvas.background) canvas.background.visible = false;
  if (canvas.grid) canvas.grid.visible = false;
  if (canvas.weather) canvas.weather.visible = false;
  if (canvas.environment) canvas.environment.visible = false; // V12+

  // CRITICAL: Tokens layer needs special handling
  // - Visual rendering is done by Three.js (TokenManager)
  // - But PIXI tokens must remain INTERACTIVE for clicks, HUD, selection, cursor
  // - We make token meshes TRANSPARENT (alpha=0) instead of invisible
  // - This keeps hit detection working while Three.js renders the visuals
  if (canvas.tokens) {
    canvas.tokens.visible = true; // Layer stays visible for interaction
    canvas.tokens.interactiveChildren = true;
    // Make individual token visuals transparent but keep them interactive
    for (const token of canvas.tokens.placeables) {
      if (token.mesh) token.mesh.alpha = 0;
      if (token.icon) token.icon.alpha = 0;
      if (token.border) token.border.alpha = 0;
      token.visible = true;
      token.interactive = true;
    }
  }

  // Drawings are NOT replaced; they should render via PIXI as an overlay.
  if (canvas.drawings) canvas.drawings.visible = true;

  // 2. Dynamic Layers - Show only if using the corresponding tool
  const activeLayer = canvas.activeLayer?.name;
  
  // Helper to toggle PIXI layer vs Three.js Manager
  const toggleLayer = (pixiLayerName, manager, forceHideThree = false) => {
    const isActive = activeLayer === pixiLayerName;
    const layer = canvas.layers.find(l => l.name === pixiLayerName); // V12 safer access?
    
    // Show PIXI layer if active
    if (layer) layer.visible = isActive;
    
    // Hide Three.js counterpart if active (to avoid double rendering during edit)
    // OR if we are in Map Maker Mode (where Three.js is hidden anyway)
    if (manager && manager.setVisibility) {
        // In Gameplay Mode: Show manager unless we are explicitly editing this layer
        // In Map Maker Mode: Manager is hidden via canvas opacity, but we can also logically hide it
        const showThree = !isActive && !isMapMakerMode;
        manager.setVisibility(showThree);
    }
  };

  // Walls
  // If Walls Layer is active, show PIXI walls, hide Three.js wall edit lines.
  // If not active, hide PIXI walls, show Three.js wall edit lines.
  if (canvas.walls) {
      const isWallsActive = activeLayer === 'WallsLayer';
      canvas.walls.visible = isWallsActive;
  }

  // Tiles
  if (canvas.tiles) {
      const isTilesActive = activeLayer === 'TilesLayer';
      canvas.tiles.visible = isTilesActive;
      if (tileManager) {
          tileManager.setVisibility(!isTilesActive && !isMapMakerMode);
      }
  }

  // Other Tools (Lighting, Sounds, etc.) - Just show/hide PIXI layer
  // For Lighting, we also drive the Three.js light icon manager visibility so that
  // light icons only show when the Lighting tool is active.
  const simpleLayers = [
      'LightingLayer', 'SoundsLayer', 'TemplateLayer', 'NotesLayer', 'RegionLayer'
  ];
  
  simpleLayers.forEach(name => {
      const layer = canvas[name === 'RegionLayer' ? 'regions' : name.replace('Layer', '').toLowerCase()];
      // Note: canvas.lighting, canvas.sounds, etc.
      // V12 Regions is canvas.regions
      if (layer) {
          layer.visible = (activeLayer === name);
      }
  });
  
  // Regions Layer (V12 specific check)
  if (canvas.regions) {
      canvas.regions.visible = (activeLayer === 'RegionLayer');
  }
}

/**
 * Setup Input Arbitration
 * Listens to tool changes to toggle PIXI canvas interactivity
 * @private
 */
function setupInputArbitration() {
  // Hook into tool changes
  // We use 'canvasInit' to re-apply settings if scene changes, 
  // but 'createThreeCanvas' handles the main init.
  
  // Remove existing listeners to avoid duplicates if re-initialized
  Hooks.off('changeSidebarTab', updateInputMode);
  Hooks.off('renderSceneControls', updateInputMode);
  
  Hooks.on('changeSidebarTab', updateInputMode);
  Hooks.on('renderSceneControls', updateInputMode);
  
  // Initial check
  updateInputMode();
}

/**
 * Update Input Mode based on active tool
 * @private
 */
function updateInputMode() {
    if (!canvas.ready) return;
    
    // If ControlsIntegration is active, it handles input routing via InputRouter
    // Skip this legacy function to avoid conflicts
    if (controlsIntegration && controlsIntegration.getState() === 'active') {
        return;
    }
    
    const pixiCanvas = canvas.app?.view;
    if (!pixiCanvas) return;

    // If Map Maker Mode is ON, we keep PIXI fully in control. Visibility for
    // native layers is managed exclusively by restoreFoundryRendering(). We
    // must NOT call updateLayerVisibility here, or the scene will vanish when
    // switching tools (Lights, Walls, etc.).
    if (isMapMakerMode) {
        pixiCanvas.style.pointerEvents = 'auto';
        return;
    }

    // In Gameplay Mode (Hybrid), we actively manage PIXI layer visibility to
    // avoid double-rendering. Do this *before* deciding who gets input.
    updateLayerVisibility();

    const activeLayer = canvas.activeLayer?.name;
    
    // Tools that require PIXI interaction
    // Basically any layer that isn't TokenLayer (assuming we handle Tokens in 3D eventually? 
    // For now, we hide TokenLayer, so we might need PIXI input if we want to select tokens?
    // Wait, TokenManager syncs tokens. If we hide TokenLayer, we can't select tokens via PIXI.
    // InteractionManager handles 3D selection.
    
    // So we ONLY need PIXI input if we are on an "Edit" layer that still
    // relies on Foundry's native PIXI interaction (sounds, templates, etc.).
    // Wall editing is handled entirely in Three.js, so WallsLayer is
    // intentionally *excluded* here. That way, while in wall placement mode
    // the Three.js canvas continues to receive input and camera panning
    // remains available.
    const editLayers = [
      // NOTE: LightingLayer is intentionally *not* included here. In Gameplay
      // Mode we handle light placement directly in the Three.js interaction
      // system, so PIXI should not reclaim pointerEvents when the Lighting
      // controls are active.
      'SoundsLayer',
      'TemplateLayer',
      'DrawingsLayer',
      'NotesLayer',
      'RegionLayer',
      'TilesLayer'
    ];
    
    // Drive Three.js wall line visibility and PIXI input routing based on the
    // *final* active layer after Foundry has finished switching tools.
    // We defer to the next tick to avoid reading a stale activeLayer during
    // control changes.
    setTimeout(() => {
      if (!canvas?.ready || isMapMakerMode) return;

      const finalLayer = canvas.activeLayer?.name;
      const isEditMode = editLayers.some(l => finalLayer === l);

      // Drive Three.js light icon visibility from a single source of truth.
      // In Gameplay mode (Three.js active), show light icons only when the
      // Lighting layer is the *final* active layer so they behave like
      // Foundry's native handles. In Map Maker mode, the entire Three.js
      // canvas is hidden, so we also hide the icons here for logical
      // consistency.
      if (lightIconManager && lightIconManager.setVisibility) {
        const showIcons = (finalLayer === 'LightingLayer') && !isMapMakerMode;
        lightIconManager.setVisibility(showIcons);
      }

      if (wallManager && wallManager.setVisibility) {
        const showThreeWalls = finalLayer === 'WallsLayer' && !isMapMakerMode;
        wallManager.setVisibility(showThreeWalls);
      }

      if (isEditMode) {
        pixiCanvas.style.pointerEvents = 'auto';
        log.debug(`Input Mode: PIXI (Edit: ${finalLayer})`);
      } else {
        pixiCanvas.style.pointerEvents = 'none'; // Pass through to Three.js
        log.debug(`Input Mode: THREE.js (Gameplay: ${finalLayer})`);
      }
    }, 0);
}

/**
 * Restore Foundry's native PIXI rendering state
 * @private
 */
function restoreFoundryRendering() {
  if (!canvas || !canvas.app) return;

  log.info('Restoring Foundry PIXI rendering');

  // Restore PIXI renderer background to opaque.
  // In Gameplay mode we set it transparent so Three.js can show through.
  // When Three.js is hidden (Map Maker mode), leaving PIXI transparent
  // results in a black screen.
  if (canvas.app?.renderer?.background) {
    canvas.app.renderer.background.alpha = 1;
  }

  // Restore PIXI canvas to default state
  const pixiCanvas = canvas.app.view;
  if (pixiCanvas) {
    pixiCanvas.style.opacity = '1';
    pixiCanvas.style.pointerEvents = 'auto';
    pixiCanvas.style.zIndex = ''; // Reset to default
  }

  // Restore ALL layers (including 'primary' which is critical for V12+)
  if (canvas.background) canvas.background.visible = true;
  if (canvas.grid) canvas.grid.visible = true;
  if (canvas.primary) canvas.primary.visible = true;
  if (canvas.tokens) canvas.tokens.visible = true;
  if (canvas.tiles) canvas.tiles.visible = true;
  if (canvas.lighting) canvas.lighting.visible = true;
  if (canvas.sounds) canvas.sounds.visible = true;
  if (canvas.templates) canvas.templates.visible = true;
  if (canvas.drawings) canvas.drawings.visible = true;
  if (canvas.notes) canvas.notes.visible = true;
  if (canvas.walls) canvas.walls.visible = true;
  if (canvas.weather) canvas.weather.visible = true;
  if (canvas.environment) canvas.environment.visible = true;
  if (canvas.regions) canvas.regions.visible = true;
  if (canvas.fog) canvas.fog.visible = true;
  if (canvas.visibility) canvas.visibility.visible = true;
  
  // Restore visibility filter if it was disabled
  if (canvas.visibility?.filter) {
    canvas.visibility.filter.enabled = true;
  }
  
  // Restore token alphas (they were set to ~0 for Three.js rendering)
  if (canvas.tokens?.placeables) {
    for (const token of canvas.tokens.placeables) {
      if (token.mesh) token.mesh.alpha = 1;
      if (token.icon) token.icon.alpha = 1;
      if (token.border) token.border.alpha = 1;
    }
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
  
  // HUD Layer (Token HUD, Tile HUD, etc.)
  const hudLayer = document.getElementById('hud');
  if (hudLayer) {
    hudLayer.style.zIndex = '100';
    hudLayer.style.pointerEvents = 'none'; // Container is transparent
    log.debug('HUD layer z-index set to 100');
    
    // Enable pointer events for direct children (the actual HUDs)
    // We can't select them all easily as they are dynamic, but we can set a rule
    // or observer? Or just rely on the HUDs having pointer-events: auto in CSS?
    // Usually Foundry CSS handles this, but if we override the container...
    // Let's force it on children if possible, or assume Foundry CSS is sufficient once container allows it.
    // Actually, setting container to 'none' propagates unless children override it.
    // Foundry's #hud usually has pointer-events: none by default? 
    // Let's just trust standard CSS for children, but ensure container is above canvas.
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
 * Set up resize handling for the Three.js canvas
 * Uses ResizeObserver for container changes and window resize as fallback
 * @private
 */
function setupResizeHandling() {
  // Clean up any existing handlers first
  cleanupResizeHandling();

  if (!threeCanvas) {
    log.warn('Cannot set up resize handling - no canvas');
    return;
  }

  const container = threeCanvas.parentElement;
  if (!container) {
    log.warn('Cannot set up resize handling - no container');
    return;
  }

  /**
   * Debounced resize handler to avoid excessive updates
   * @param {number} width 
   * @param {number} height 
   */
  const handleResize = (width, height) => {
    // Clear any pending debounce
    if (resizeDebounceTimer) {
      clearTimeout(resizeDebounceTimer);
    }

    // Debounce resize events (16ms = ~60fps, prevents excessive updates during drag)
    resizeDebounceTimer = setTimeout(() => {
      // Validate dimensions
      if (width <= 0 || height <= 0) {
        log.debug(`Ignoring invalid resize dimensions: ${width}x${height}`);
        return;
      }

      // Check if size actually changed
      const currentWidth = renderer?.domElement?.width || 0;
      const currentHeight = renderer?.domElement?.height || 0;
      
      // Account for device pixel ratio
      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.floor(width * dpr);
      const targetHeight = Math.floor(height * dpr);

      if (targetWidth === currentWidth && targetHeight === currentHeight) {
        log.debug('Resize skipped - dimensions unchanged');
        return;
      }

      log.info(`Handling resize: ${width}x${height} (DPR: ${dpr})`);
      resize(width, height);
    }, 16);
  };

  // Method 1: ResizeObserver (preferred - handles sidebar, popouts, etc.)
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Use contentRect for accurate dimensions (excludes padding/border)
        const { width, height } = entry.contentRect;
        handleResize(width, height);
      }
    });

    resizeObserver.observe(container);
    log.debug('ResizeObserver attached to canvas container');
  } else {
    log.warn('ResizeObserver not available - falling back to window resize only');
  }

  // Method 2: Window resize event (fallback and additional coverage)
  windowResizeHandler = () => {
    if (!threeCanvas) return;
    const rect = threeCanvas.getBoundingClientRect();
    handleResize(rect.width, rect.height);
  };

  window.addEventListener('resize', windowResizeHandler);
  log.debug('Window resize listener attached');

  // Method 3: Listen for Foundry sidebar collapse/expand which changes canvas area
  // The 'collapseSidebar' hook fires when sidebar is toggled
  collapseSidebarHookId = Hooks.on('collapseSidebar', () => {
    // Delay slightly to let DOM update
    setTimeout(() => {
      if (threeCanvas) {
        const rect = threeCanvas.getBoundingClientRect();
        handleResize(rect.width, rect.height);
      }
    }, 50);
  });

  log.info('Resize handling initialized');
}

/**
 * Clean up resize handling resources
 * @private
 */
function cleanupResizeHandling() {
  // Clear debounce timer
  if (resizeDebounceTimer) {
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = null;
  }

  // Disconnect ResizeObserver
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
    log.debug('ResizeObserver disconnected');
  }

  // Remove window resize listener
  if (windowResizeHandler) {
    window.removeEventListener('resize', windowResizeHandler);
    windowResizeHandler = null;
    log.debug('Window resize listener removed');
  }

  // Remove collapseSidebar hook
  if (collapseSidebarHookId !== null) {
    Hooks.off('collapseSidebar', collapseSidebarHookId);
    collapseSidebarHookId = null;
    log.debug('collapseSidebar hook removed');
  }
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
