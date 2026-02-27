/**
 * @fileoverview Bootstrap orchestrator for Map Shine Advanced
 * Coordinates module initialization in correct order
 * @module core/bootstrap
 */

import * as log from './log.js';
import * as capabilities from './capabilities.js';
import * as rendererStrategy from './renderer-strategy.js';
import * as errors from './errors.js';
import { installConsoleHelpers } from '../utils/console-helpers.js';
import { GameSystemManager } from './game-system.js';

const logger = log.createLogger('Bootstrap');

function _msaCrisisLog(id, message) {
  try {
    const n = String(id).padStart(3, '0');
    console.log(`Crisis #${n} - ${message}`);
  } catch (_) {
  }
}

/**
 * Bootstrap the Map Shine Advanced module
 * @param {BootstrapOptions} [options={}] - Bootstrap options
 * @returns {Promise<MapShineState>} Initialized module state
 * @public
 */
export async function bootstrap(options = {}) {
  _msaCrisisLog(60, 'bootstrap.js: bootstrap() entered');
  const { verbose = false, skipSceneInit = false } = options;

  _msaCrisisLog(61, `bootstrap: options parsed (verbose=${!!verbose}, skipSceneInit=${!!skipSceneInit})`);

  // Set log level based on options
  if (verbose) {
    log.setLogLevel(log.LogLevel.DEBUG);
  }

  _msaCrisisLog(62, 'bootstrap: log level configured');

  console.log('[MSA BOOT] bootstrap: start');
  logger.info('Starting bootstrap sequence...');

  /** @type {MapShineState} */
  const state = {
    renderer: null,
    rendererType: null,
    capabilities: null,
    initialized: false,
    error: null,
    scene: null,
    camera: null,
    gameSystem: null
  };

  _msaCrisisLog(63, 'bootstrap: initial state object created');

  try {
    // Step 1: Load three.js (bundled from node_modules via build script)
    _msaCrisisLog(64, 'bootstrap: importing three.custom.js');
    console.log('[MSA BOOT] bootstrap: loading three.js');
    logger.info('Loading three.js...');
    const THREE = await import('../vendor/three/three.custom.js');
    window.THREE = THREE; // Expose globally for debugging
    logger.info(`three.js r${THREE.REVISION} loaded`);
    console.log('[MSA BOOT] bootstrap: three.js loaded, revision', THREE.REVISION);

    _msaCrisisLog(65, `bootstrap: three.js imported (REVISION=${THREE?.REVISION ?? 'unknown'})`);

    // Step 2: Detect GPU capabilities
    _msaCrisisLog(66, 'bootstrap: capabilities.detect() about to run');
    console.log('[MSA BOOT] bootstrap: detecting GPU capabilities');
    logger.info('Detecting GPU capabilities...');
    state.capabilities = await capabilities.detect();
    console.log('[MSA BOOT] bootstrap: capabilities detected, tier=', state.capabilities.tier);

    _msaCrisisLog(67, `bootstrap: capabilities detected (tier=${state?.capabilities?.tier ?? 'unknown'})`);

    // Step 3: Check if any rendering tier is available
    if (state.capabilities.tier === 'none') {
      _msaCrisisLog(68, 'bootstrap: capabilities tier=none; showing compatibility error and aborting');
      state.error = 'No GPU acceleration available';
      logger.error('No compatible GPU rendering context found');
      errors.showCompatibilityError(state.capabilities);
      return state;
    }

    // Step 4: Initialize renderer with fallback strategy
    _msaCrisisLog(69, 'bootstrap: rendererStrategy.create() about to run');
    console.log('[MSA BOOT] bootstrap: creating renderer');
    logger.info('Initializing renderer...');
    const { renderer, rendererType } = await rendererStrategy.create(THREE, state.capabilities);
    console.log('[MSA BOOT] bootstrap: renderer created=', !!renderer, 'type=', rendererType);

    _msaCrisisLog(70, `bootstrap: rendererStrategy.create() returned (hasRenderer=${!!renderer}, type=${rendererType ?? 'unknown'})`);

    if (!renderer) {
      _msaCrisisLog(71, 'bootstrap: renderer was null; showing compatibility error and aborting');
      state.error = 'Renderer initialization failed';
      logger.error('Failed to initialize any renderer');
      errors.showCompatibilityError(state.capabilities);
      return state;
    }

    // Configure renderer
    _msaCrisisLog(72, 'bootstrap: rendererStrategy.configure() about to run');
    rendererStrategy.configure(renderer, {
      width: window.innerWidth,
      height: window.innerHeight
    });

    _msaCrisisLog(73, 'bootstrap: rendererStrategy.configure() completed');

    state.renderer = renderer;
    state.rendererType = rendererType;

    _msaCrisisLog(74, 'bootstrap: state.renderer + state.rendererType assigned');

    // Step 4.5: Initialize Game System Manager (non-fatal — rendering works without it)
    _msaCrisisLog(75, 'bootstrap: creating GameSystemManager');
    try {
      logger.info('Initializing game system manager...');
      state.gameSystem = new GameSystemManager();
      state.gameSystem.initialize();
      _msaCrisisLog(76, 'bootstrap: GameSystemManager initialized');
    } catch (gsErr) {
      logger.warn('GameSystemManager failed to initialize — game-system features disabled', gsErr);
      _msaCrisisLog(76, `bootstrap: GameSystemManager failed (${gsErr?.message ?? 'unknown'}) — continuing`);
    }

    // Step 5: Create minimal scene (if not skipped)
    if (!skipSceneInit) {
      _msaCrisisLog(77, 'bootstrap: creating initial THREE.Scene + OrthographicCamera');
      logger.info('Creating initial scene...');
      // TODO: This will be extracted to scene/ module in next milestone
      state.scene = new THREE.Scene();
      state.camera = new THREE.OrthographicCamera(
        window.innerWidth / -2,
        window.innerWidth / 2,
        window.innerHeight / 2,
        window.innerHeight / -2,
        0.1,
        1000
      );
      state.camera.position.z = 5;
      logger.debug('Initial scene and camera created');

      _msaCrisisLog(78, 'bootstrap: initial scene + camera created');
    }

    // Step 6: Install console helpers for debugging
    _msaCrisisLog(79, 'bootstrap: installConsoleHelpers() about to run');
    installConsoleHelpers();

    _msaCrisisLog(80, 'bootstrap: installConsoleHelpers() completed');
    
    // Step 7: Mark as initialized
    state.initialized = true;
    logger.info(`Bootstrap complete: ${rendererType} (Tier: ${state.capabilities.tier})`);

    _msaCrisisLog(81, `bootstrap: completed successfully (initialized=true, rendererType=${rendererType ?? 'unknown'})`);

    // Step 7: Show success notification
    _msaCrisisLog(82, 'bootstrap: errors.showSuccessNotification() about to run');
    errors.showSuccessNotification(state.capabilities.tier);

    _msaCrisisLog(83, 'bootstrap: errors.showSuccessNotification() completed');

    return state;

  } catch (e) {
    _msaCrisisLog(84, `bootstrap: caught error (${e?.message ?? 'unknown'})`);
    state.error = e.message;
    logger.error('Critical bootstrap error:', e);
    errors.showInitializationError(e.message, e);
    return state;
  }
}

/**
 * Cleanup module state and dispose resources
 * @param {MapShineState} state - Module state to cleanup
 * @public
 */
export function cleanup(state) {
  logger.info('Cleaning up module resources...');

  if (state.renderer) {
    state.renderer.dispose();
    logger.debug('Renderer disposed');
  }

  if (state.scene) {
    // Dispose scene resources
    state.scene.traverse((object) => {
      if (object.geometry) {
        object.geometry.dispose();
      }
      if (object.material) {
        if (Array.isArray(object.material)) {
          object.material.forEach(material => material.dispose());
        } else {
          object.material.dispose();
        }
      }
    });
    logger.debug('Scene resources disposed');
  }

  state.renderer = null;
  state.scene = null;
  state.camera = null;
  state.initialized = false;

  logger.info('Cleanup complete');
}
