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
import { loadingOverlay } from './ui/loading-overlay.js';

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

  try {
    loadingOverlay.showBlack('Initializing…');
  } catch (e) {
    console.warn('Map Shine: failed to initialize loading overlay', e);
  }

  console.log("%c GNU Terry Pratchett %c \n“A man is not dead while his name is still spoken.”",
  "background: #313131ff; color: #FFD700; font-weight: bold; padding: 4px 8px; border-radius: 4px;",
  "color: #888; font-style: italic;"
);
  
  // Register settings
  sceneSettings.registerSettings();
  registerUISettings();
  
  // Register scene control button to toggle Map Shine UI
  // Foundry v13+ uses Record<string, SceneControl> with tools as Record<string, SceneControlTool>
  Hooks.on('getSceneControlButtons', (controls) => {
    try {
      // In Foundry v13+, controls is Record<string, SceneControl>
      // Access tokens control directly by key
      const tokenControls = controls?.tokens;
      if (!tokenControls?.tools) return;

      // Avoid duplicate tool registration
      if (tokenControls.tools['map-shine-ui']) return;

      // Add tool as a property on the tools object (not array push)
      // Include toolclip to prevent Foundry errors when hovering
      tokenControls.tools['map-shine-ui'] = {
        name: 'map-shine-ui',
        title: 'Map Shine UI',
        icon: 'fas fa-sun',
        button: true,
        order: 100, // Place at end of tools list
        visible: game.user?.isGM ?? false,
        toolclip: {
          src: '',
          heading: 'MAPSHINE.ToolTitle',
          items: [{ paragraph: 'MAPSHINE.ToolDescription' }]
        },
        onChange: () => {
          const uiManager = window.MapShine?.uiManager;
          if (!uiManager) {
            ui.notifications?.warn?.('Map Shine UI is not available yet. The scene may still be initializing.');
            return;
          }
          uiManager.toggle();
        }
      };
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
  try {
    loadingOverlay.setMessage('Preparing renderer…');
  } catch (e) {
    console.warn('Map Shine: failed to update loading overlay', e);
  }
  // Run bootstrap sequence
  const state = await bootstrap({ verbose: false });
  
  // Update global state
  Object.assign(MapShine, state);

  try {
    if (!state?.initialized) {
      loadingOverlay.setMessage('Renderer unavailable');
    }
  } catch (e) {
    console.warn('Map Shine: failed to update loading overlay', e);
  }
  
  info('Module ready');
});