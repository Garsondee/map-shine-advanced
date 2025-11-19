/**
 * @fileoverview Map Shine Advanced - Foundry VTT Module Entrypoint
 * Handles Foundry VTT hooks and delegates initialization to core/bootstrap
 * @module module
 */

import { bootstrap, cleanup } from './core/bootstrap.js';
import { info } from './core/log.js';
import * as sceneSettings from './settings/scene-settings.js';
import * as canvasReplacement from './foundry/canvas-replacement.js';
import { registerUISettings } from './ui/tweakpane-manager.js';

/**
 * Module state exposed globally for debugging and inter-module communication
 * Reuse existing object if already defined to avoid losing state on re-execution
 * @type {MapShineState}
 */
const MapShine = window.MapShine ?? {
  renderer: null,
  rendererType: null,
  capabilities: null,
  initialized: false,
  error: null,
  scene: null,
  camera: null
};

// Expose module state globally (idempotent)
window.MapShine = MapShine;

/**
 * Foundry VTT 'init' hook - Called when Foundry initializes
 * Used for early setup like settings registration
 */
Hooks.once('init', async function() {
  info('Initializing...');
  
  // Register settings
  sceneSettings.registerSettings();
  registerUISettings();
  
  // Debounce Foundry UI configuration to avoid rapid reflows while dragging sliders (e.g. UI scale)
  if (typeof game !== 'undefined' && game && typeof game.configureUI === 'function' && globalThis.foundry?.utils?.debounce) {
    const originalConfigureUI = game.configureUI.bind(game);
    const debouncedConfigureUI = globalThis.foundry.utils.debounce(originalConfigureUI, 250, false);
    game.configureUI = function(config) {
      return debouncedConfigureUI(config);
    };
  }
  
  // Initialize canvas replacement hooks
  canvasReplacement.initialize();
});

/**
 * Foundry VTT 'ready' hook - Called when Foundry is fully loaded
 * Main bootstrap happens here
 */
Hooks.once('ready', async function() {
  // Run bootstrap sequence
  const state = await bootstrap({ verbose: false });
  
  // Update global state
  Object.assign(MapShine, state);
  
  info('Module ready');
});

/**
 * Foundry VTT cleanup hook (if module needs to cleanup on disable)
 */
if (typeof Hooks !== 'undefined') {
  Hooks.on('closeApplication', function() {
    if (MapShine.initialized) {
      cleanup(MapShine);
    }
  });
}