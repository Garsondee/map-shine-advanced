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

  console.log("%c GNU Terry Pratchett %c \n“A man is not dead while his name is still spoken.”",
  "background: #313131ff; color: #FFD700; font-weight: bold; padding: 4px 8px; border-radius: 4px;",
  "color: #888; font-style: italic;"
);
  
  // Register settings
  sceneSettings.registerSettings();
  registerUISettings();
  
  // Register scene control button to toggle Map Shine UI
  Hooks.on('getSceneControlButtons', (controls) => {
    try {
      let tokenControls = null;

      // Foundry versions differ: controls may be an Array or a Record<string, SceneControl>
      if (Array.isArray(controls)) {
        tokenControls = controls.find(c => c.name === 'token' || c.name === 'tokens') || null;
      } else if (controls && typeof controls === 'object') {
        // Prefer explicit keys if present
        tokenControls = controls.token || controls.tokens || null;
        if (!tokenControls) {
          // Fallback: search values by name property
          const values = Object.values(controls);
          tokenControls = values.find(c => c && (c.name === 'token' || c.name === 'tokens')) || null;
        }
      }

      if (!tokenControls) return;

      let tools = tokenControls.tools;
      if (!Array.isArray(tools)) {
        // Foundry may store tools as an object map in some versions; normalize to array
        tools = Array.isArray(tools) ? tools : (tools ? Object.values(tools) : []);
        tokenControls.tools = tools;
      }

      // Avoid duplicate tool registration
      if (tools.some(t => t.name === 'map-shine-ui')) return;

      tools.push({
        name: 'map-shine-ui',
        title: 'Map Shine UI',
        icon: 'fas fa-sun',
        button: true,
        // During development, expose the UI toggle on all scenes but only to GMs
        visible: () => game.user?.isGM ?? false,

        onClick: () => {
          const uiManager = window.MapShine?.uiManager;
          if (!uiManager) {
            ui.notifications?.warn?.('Map Shine UI is not available yet. The scene may still be initializing.');
            return;
          }
          uiManager.toggle();
        }
      });
    } catch (e) {
      console.error('Map Shine: failed to register scene control button', e);
    }
  });

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