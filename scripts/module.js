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

  console.log(
<<<<<<< HEAD
  "%c GNU Terry Pratchett %c \n \n“A man is not dead while his name is still spoken.”",
=======
  "%c GNU Terry Pratchett %c \n“A man is not dead while his name is still spoken.”",
>>>>>>> 17e6255a53e04b04350a85b5e962b7c3fb3b2c56
  "background: #4b0082; color: #FFD700; font-weight: bold; padding: 4px 8px; border-radius: 4px;",
  "color: #888; font-style: italic;"
);
  
  // Register settings
  sceneSettings.registerSettings();
  registerUISettings();
  
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