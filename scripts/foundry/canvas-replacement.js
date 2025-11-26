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
import { AsciiEffect } from '../effects/AsciiEffect.js';
import { BloomEffect } from '../effects/BloomEffect.js';
import { LightingEffect } from '../effects/LightingEffect.js';
import { LensflareEffect } from '../effects/LensflareEffect.js';
import { PrismEffect } from '../effects/PrismEffect.js';
import { ParticleSystem } from '../particles/ParticleSystem.js';
import { FireSparksEffect } from '../particles/FireSparksEffect.js';
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
  SteamEffect,
  MetallicGlintsEffect,
  SmellyFliesEffect,
  PostProcessingEffect,
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
import { weatherController } from '../core/WeatherController.js';

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

/** @type {LightingEffect|null} */
let lightingEffect = null;

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

    // Resolve background colour from Foundry scene (fallback to Foundry default #999999)
    // scene.backgroundColor is a hex string like "#999999" in modern Foundry versions
    const sceneBgColorStr = (scene && typeof scene.backgroundColor === 'string' && scene.backgroundColor.trim().length > 0)
      ? scene.backgroundColor
      : '#999999';

    // Parse hex string to numeric RGB for three.js clear colour
    let sceneBgColorInt = 0x999999;
    try {
      const hex = sceneBgColorStr.replace('#', '');
      const parsed = parseInt(hex, 16);
      if (!Number.isNaN(parsed)) sceneBgColorInt = parsed;
    } catch (e) {
      // Fallback already set to 0x999999
    }

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
      rect.height
    );

    log.info(`Scene composer initialized with ${bundle.masks.length} effect masks`);

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

    // Ensure WeatherController is initialized and driven by the centralized TimeManager.
    // This allows precipitation, wind, etc. to update every frame and drive GPU effects
    // like the particle-based weather system without requiring manual console snippets.
    weatherController.initialize();
    effectComposer.addUpdatable(weatherController);

    // Step 3: Register specular effect
    const specularEffect = new SpecularEffect();
    effectComposer.registerEffect(specularEffect);

    // Step 3.1: Register iridescence effect
    const iridescenceEffect = new IridescenceEffect();
    effectComposer.registerEffect(iridescenceEffect);

    // Step 3.2: Register color correction effect (Post-Processing)
    const colorCorrectionEffect = new ColorCorrectionEffect();
    effectComposer.registerEffect(colorCorrectionEffect);
    
    // Step 3.3: Register ASCII Effect (Post-Processing)
    const asciiEffect = new AsciiEffect();
    effectComposer.registerEffect(asciiEffect);
    
    // Step 3.4: Register Particle System (WebGPU/WebGL2)
    const particleSystem = new ParticleSystem();
    effectComposer.registerEffect(particleSystem);

    // Step 3.4: Register Fire Sparks Effect and wire it to the ParticleSystem
    const fireSparksEffect = new FireSparksEffect();
    // Provide the particle backend so FireSparksEffect can create emitters and bind uniforms
    fireSparksEffect.setParticleSystem(particleSystem);
    effectComposer.registerEffect(fireSparksEffect);
    // Pass asset bundle to check for _Fire mask (after particle system is wired)
    if (bundle) {
      fireSparksEffect.setAssetBundle(bundle);
    }

    // Step 3.5: Register Prism Effect
    const prismEffect = new PrismEffect();
    effectComposer.registerEffect(prismEffect);

    // Step 3.6: Register Lighting Effect
    lightingEffect = new LightingEffect();
    effectComposer.registerEffect(lightingEffect);

    // Step 3.7: Register Bloom Effect
    const bloomEffect = new BloomEffect();
    effectComposer.registerEffect(bloomEffect);

    // Step 3.8: Register Lensflare Effect
    const lensflareEffect = new LensflareEffect();
    effectComposer.registerEffect(lensflareEffect);

    // Provide the base mesh and asset bundle to the effect
    const basePlane = sceneComposer.getBasePlane();

    specularEffect.setBaseMesh(basePlane, bundle);
    iridescenceEffect.setBaseMesh(basePlane, bundle);
    prismEffect.setBaseMesh(basePlane, bundle);
    lightingEffect.setBaseMesh(basePlane);

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
    effectComposer.addUpdatable(tileManager); // Register for occlusion updates
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
    mapShine.prismEffect = prismEffect;
    mapShine.lightingEffect = lightingEffect;
    mapShine.bloomEffect = bloomEffect;
    mapShine.lensflareEffect = lensflareEffect;
    mapShine.colorCorrectionEffect = colorCorrectionEffect;
    mapShine.asciiEffect = asciiEffect;
    mapShine.fireSparksEffect = fireSparksEffect;
    mapShine.cameraController = cameraController;
    mapShine.tokenManager = tokenManager; // NEW: Expose token manager for diagnostics
    mapShine.tileManager = tileManager; // NEW: Expose tile manager for diagnostics
    mapShine.wallManager = wallManager; // NEW: Expose wall manager
    mapShine.interactionManager = interactionManager; // NEW: Expose interaction manager
    mapShine.gridRenderer = gridRenderer; // NEW: Expose grid renderer
    mapShine.weatherController = weatherController; // NEW: Expose weather controller
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
      await initializeUI(specularEffect, iridescenceEffect, colorCorrectionEffect, asciiEffect, prismEffect, lightingEffect, bloomEffect, lensflareEffect, fireSparksEffect);
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
 * @param {AsciiEffect} asciiEffect - The ASCII effect instance
 * @param {PrismEffect} prismEffect - The prism effect instance
 * @param {LightingEffect} lightingEffect - The dynamic lighting effect instance
 * @param {BloomEffect} bloomEffect - The bloom effect instance
 * @param {LensflareEffect} lensflareEffect - The lensflare effect instance
 * @private
 */
async function initializeUI(specularEffect, iridescenceEffect, colorCorrectionEffect, asciiEffect, prismEffect, lightingEffect, bloomEffect, lensflareEffect, fireSparksEffect) {
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

  // --- Lighting Settings ---
  if (lightingEffect) {
    const lightingSchema = LightingEffect.getControlSchema();
    
    const onLightingUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        lightingEffect.enabled = value;
        log.debug(`Lighting effect ${value ? 'enabled' : 'disabled'}`);
      } else if (lightingEffect.params[paramId] !== undefined) {
        lightingEffect.params[paramId] = value;
        log.debug(`Lighting.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'lighting',
      'Dynamic Lighting',
      lightingSchema,
      onLightingUpdate,
      'global'
    );
  }

  // --- Bloom Settings ---
  if (bloomEffect) {
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
       // Weather system is always running technically, but we could toggle visibility of effects
       // For now, just log
       log.debug(`Weather system ${value ? 'enabled' : 'disabled'}`);
    } else if (paramId === 'roofMaskForceEnabled') {
      // Manual override for indoor masking independent of roof hover state
      weatherController.roofMaskForceEnabled = !!value;
    } else if (paramId === 'transitionDuration') {
      weatherController.transitionDuration = value;
    } else if (paramId === 'variability') {
      weatherController.setVariability(value);
    } else if (paramId === 'timeOfDay') {
      weatherController.setTime(value);
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
        else if (paramId === 'rainBrightness') rt.brightness = value;
        else if (paramId === 'rainGravityScale') rt.gravityScale = value;
        else if (paramId === 'rainWindInfluence') rt.windInfluence = value;
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
        else if (paramId === 'snowFallSpeed') st.fallSpeed = value;
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
    enabled: true,
    transitionDuration: weatherController.transitionDuration,
    variability: weatherController.variability,
    timeOfDay: weatherController.timeOfDay,
    roofMaskForceEnabled: weatherController.roofMaskForceEnabled,
    
    // Manual params
    precipitation: weatherController.targetState.precipitation,
    cloudCover: weatherController.targetState.cloudCover,
    windSpeed: weatherController.targetState.windSpeed,
    windDirection: Math.atan2(weatherController.targetState.windDirection.y, weatherController.targetState.windDirection.x) * (180 / Math.PI),
    fogDensity: weatherController.targetState.fogDensity,
    wetness: weatherController.currentState.wetness, // Read-only derived
    freezeLevel: weatherController.targetState.freezeLevel
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

  // --- Fire Debug Settings ---
  if (fireSparksEffect) {
    const fireSchema = FireSparksEffect.getControlSchema();

    const onFireUpdate = (effectId, paramId, value) => {
      const ps = fireSparksEffect.particleSystem;
      const em = ps?.emitterManager;

      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        fireSparksEffect.settings.enabled = value;
        fireSparksEffect.params.enabled = value;

        // When disabling, force global emitters off; when enabling, restore from params
        if (em) {
          if (fireSparksEffect.globalFireEmitterId) {
            const e = em.emitters.find(x => x.id === fireSparksEffect.globalFireEmitterId);
            if (e) e.rate = value ? fireSparksEffect.params.globalFireRate : 0.0;
          }
        }
        return;
      }

      // Persist param value
      if (fireSparksEffect.params && Object.prototype.hasOwnProperty.call(fireSparksEffect.params, paramId)) {
        fireSparksEffect.params[paramId] = value;
      }

      if (!ps || !em) return;

      // Update global emitter rates if we have handles
      if (paramId === 'globalFireRate' && fireSparksEffect.globalFireEmitterId) {
        const e = em.emitters.find(x => x.id === fireSparksEffect.globalFireEmitterId);
        if (e) e.rate = value;
      }

      // Drive fire tuning uniforms when available
      const u = ps.uniforms;
      if (u) {
        if (paramId === 'fireAlpha' && u.fireAlpha) {
          u.fireAlpha.value = value;
        } else if (paramId === 'fireCoreBoost' && u.fireCoreBoost) {
          u.fireCoreBoost.value = value;
        } else if (paramId === 'fireHeight' && u.fireHeight) {
          u.fireHeight.value = value;
        } else if (paramId === 'fireSize' && u.fireSize) {
          u.fireSize.value = value;
        }
      }
    };

    uiManager.registerEffect(
      'fire-sparks',
      'Fire (Debug)',
      fireSchema,
      onFireUpdate,
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
      setInterval(updateWindVane, 200);
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

  // --- Stub Effects ---
  // UI-only placeholders for planned effects; these do not yet affect rendering
  const stubEffectDefs = [
    // Atmospheric & Environmental
    { id: 'cloud-shadows',      name: 'Cloud Shadows',        Class: CloudShadowsEffect,      categoryId: 'atmospheric' },
    { id: 'time-of-day',        name: 'Time of Day',          Class: TimeOfDayEffect,         categoryId: 'atmospheric' },
    // Weather System replaced by active controller
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
    { id: 'steam',              name: 'Steam',                Class: SteamEffect,             categoryId: 'particle' },
    { id: 'metallic-glints',    name: 'Metallic Glints',      Class: MetallicGlintsEffect,    categoryId: 'particle' },
    { id: 'smelly-flies',       name: 'Smelly Flies',         Class: SmellyFliesEffect,       categoryId: 'particle' },

    // Global & UI Effects
    // { id: 'post-processing',    name: 'Post-Processing',      Class: PostProcessingEffect,    categoryId: 'global' }, // Replaced by real ColorCorrectionEffect
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
