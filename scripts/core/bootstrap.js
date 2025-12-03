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

const logger = log.createLogger('Bootstrap');

/**
 * Bootstrap the Map Shine Advanced module
 * @param {BootstrapOptions} [options={}] - Bootstrap options
 * @returns {Promise<MapShineState>} Initialized module state
 * @public
 */
export async function bootstrap(options = {}) {
  const { verbose = false, skipSceneInit = false } = options;

  // Set log level based on options
  if (verbose) {
    log.setLogLevel(log.LogLevel.DEBUG);
  }

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

  try {
    // Step 1: Load three.js (bundled from node_modules via build script)
    logger.info('Loading three.js...');
    const THREE = await import('../vendor/three/three.custom.js');
    window.THREE = THREE; // Expose globally for debugging
    logger.info(`three.js r${THREE.REVISION} loaded`);

    // Step 2: Detect GPU capabilities
    logger.info('Detecting GPU capabilities...');
    state.capabilities = await capabilities.detect();

    // Step 3: Check if any rendering tier is available
    if (state.capabilities.tier === 'none') {
      state.error = 'No GPU acceleration available';
      logger.error('No compatible GPU rendering context found');
      errors.showCompatibilityError(state.capabilities);
      return state;
    }

    // Step 4: Initialize renderer with fallback strategy
    logger.info('Initializing renderer...');
    const { renderer, rendererType } = await rendererStrategy.create(THREE, state.capabilities);

    if (!renderer) {
      state.error = 'Renderer initialization failed';
      logger.error('Failed to initialize any renderer');
      errors.showCompatibilityError(state.capabilities);
      return state;
    }

    // Configure renderer
    rendererStrategy.configure(renderer, {
      width: window.innerWidth,
      height: window.innerHeight
    });

    state.renderer = renderer;
    state.rendererType = rendererType;

    // Step 4.5: Initialize Game System Manager
    logger.info('Initializing game system manager...');
    const { GameSystemManager } = await import('./game-system.js');
    state.gameSystem = new GameSystemManager();
    state.gameSystem.initialize();

    // Step 5: Create minimal scene (if not skipped)
    if (!skipSceneInit) {
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
    }

    // Step 6: Install console helpers for debugging
    installConsoleHelpers();
    
    // Step 7: Mark as initialized
    state.initialized = true;
    logger.info(`Bootstrap complete: ${rendererType} (Tier: ${state.capabilities.tier})`);

    // Step 7: Show success notification
    errors.showSuccessNotification(state.capabilities.tier);

    return state;

  } catch (e) {
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
