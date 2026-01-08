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
  
  // Register scene control buttons for Map Shine panels
  // Foundry v13+ uses Record<string, SceneControl> with tools as Record<string, SceneControlTool>
  Hooks.on('getSceneControlButtons', (controls) => {
    try {
      if (!(game.user?.isGM ?? false)) return;

      // In Foundry v13+, controls is Record<string, SceneControl>
      // Access tokens control directly by key
      const tokenControls = controls?.tokens;
      if (!tokenControls?.tools) return;

      // Avoid duplicate tool registration
      if (tokenControls.tools['map-shine-config']) return;

      // Configuration Panel button (existing TweakpaneManager)
      tokenControls.tools['map-shine-config'] = {
        name: 'map-shine-config',
        title: 'Map Shine Config',
        icon: 'fas fa-cog',
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
            ui.notifications?.warn?.('Map Shine Configuration is not available yet. The scene may still be initializing.');
            return;
          }
          uiManager.toggle();
        }
      };

      // Control Panel button (new ControlPanelManager)
      tokenControls.tools['map-shine-control'] = {
        name: 'map-shine-control',
        title: 'Map Shine Control',
        icon: 'fas fa-sliders-h',
        button: true,
        order: 101, // After config button
        visible: game.user?.isGM ?? false,
        toolclip: {
          src: '',
          heading: 'MAPSHINE.ToolTitle',
          items: [{ paragraph: 'MAPSHINE.ToolDescription' }]
        },
        onChange: () => {
          const controlPanel = window.MapShine?.controlPanel;
          if (!controlPanel) {
            ui.notifications?.warn?.('Map Shine Control Panel is not available yet. The scene may still be initializing.');
            return;
          }
          controlPanel.toggle();
        }
      };
    } catch (e) {
      console.error('Map Shine: failed to register scene control buttons', e);
    }
  });

  Hooks.on('renderTileConfig', (app, html) => {
    try {
      const $ = globalThis.$;
      if (typeof $ !== 'function') return;

      const tileDoc = app?.document;
      if (!tileDoc) return;

      const moduleId = 'map-shine-advanced';
      const flagKey = 'overheadIsRoof';
      const bypassFlagKey = 'bypassEffects';
      const cloudShadowsFlagKey = 'cloudShadowsEnabled';
      const cloudTopsFlagKey = 'cloudTopsEnabled';

      const $html = html?.find ? html : $(html);
      const overheadTab = $html.find('.tab[data-tab="overhead"]');
      if (!overheadTab.length) return;

      const current = !!(tileDoc.getFlag?.(moduleId, flagKey) ?? tileDoc.flags?.[moduleId]?.[flagKey]);
      const bypassCurrent = !!(tileDoc.getFlag?.(moduleId, bypassFlagKey) ?? tileDoc.flags?.[moduleId]?.[bypassFlagKey]);
      const cloudShadowsEnabled = (tileDoc.getFlag?.(moduleId, cloudShadowsFlagKey) ?? tileDoc.flags?.[moduleId]?.[cloudShadowsFlagKey]);
      const cloudTopsEnabled = (tileDoc.getFlag?.(moduleId, cloudTopsFlagKey) ?? tileDoc.flags?.[moduleId]?.[cloudTopsFlagKey]);
      const cloudShadowsCurrent = (cloudShadowsEnabled === undefined) ? true : !!cloudShadowsEnabled;
      const cloudTopsCurrent = (cloudTopsEnabled === undefined) ? true : !!cloudTopsEnabled;

      const group = $(
        `<div class="form-group">
           <label>Overhead = Roof (Map Shine)</label>
           <div class="form-fields">
             <input type="checkbox" name="flags.${moduleId}.${flagKey}" ${current ? 'checked' : ''} />
           </div>
           <p class="notes">Treat this overhead tile as a roof for weather visibility.</p>
         </div>`
      );

      const bypassGroup = $(
        `<div class="form-group">
           <label>Bypass Map Shine Effects</label>
           <div class="form-fields">
             <input type="checkbox" name="flags.${moduleId}.${bypassFlagKey}" ${bypassCurrent ? 'checked' : ''} />
           </div>
           <p class="notes">Render this tile outside the Map Shine post-processing stack.</p>
         </div>`
      );

      const cloudShadowsGroup = $(
        `<div class="form-group">
           <label>Cloud Shadows (Map Shine)</label>
           <div class="form-fields">
             <input type="checkbox" name="flags.${moduleId}.${cloudShadowsFlagKey}" ${cloudShadowsCurrent ? 'checked' : ''} />
           </div>
           <p class="notes">Allow CloudEffect shadows to affect this tile.</p>
         </div>`
      );

      const cloudTopsGroup = $(
        `<div class="form-group">
           <label>Cloud Tops (Map Shine)</label>
           <div class="form-fields">
             <input type="checkbox" name="flags.${moduleId}.${cloudTopsFlagKey}" ${cloudTopsCurrent ? 'checked' : ''} />
           </div>
           <p class="notes">Allow CloudEffect cloud-top overlay to render over this tile.</p>
         </div>`
      );

      const anchor = overheadTab.find('input[name="overhead.restrictsWeather"]').closest('.form-group');
      if (anchor.length) {
        anchor.after(group);
        group.after(bypassGroup);
        bypassGroup.after(cloudShadowsGroup);
        cloudShadowsGroup.after(cloudTopsGroup);
      } else {
        overheadTab.append(group);
        overheadTab.append(bypassGroup);
        overheadTab.append(cloudShadowsGroup);
        overheadTab.append(cloudTopsGroup);
      }
    } catch (e) {
      console.error('Map Shine: failed to inject TileConfig overhead roof toggle', e);
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