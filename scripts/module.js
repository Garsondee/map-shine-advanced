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
import { debugLoadingProfiler } from './core/debug-loading-profiler.js';

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

// Wall-clock load timer (starts at module evaluation time).
// This measures the full time from module load to "Finished" in createThreeCanvas.
try {
  if (typeof MapShine._loadTimerStartMs !== 'number') {
    MapShine._loadTimerStartMs = performance.now();
  }
} catch (_) {
  // Ignore
}

// Expose module state globally (idempotent)
window.MapShine = MapShine;

// Expose debug loading profiler early (runtime state is synced from Foundry settings at init).
MapShine.debugLoadingProfiler = debugLoadingProfiler;

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
  // Sync Debug Loading Mode from Foundry settings on startup.
  debugLoadingProfiler.debugMode = sceneSettings.getDebugLoadingModeEnabled();
  registerUISettings();
  
  // Register scene control buttons for Map Shine panels
  // Foundry v13+ uses Record<string, SceneControl> with tools as Record<string, SceneControlTool>
  Hooks.on('getSceneControlButtons', (controls) => {
    try {
      const isGM = game.user?.isGM ?? false;
      const allowPlayers = game.settings?.get?.('map-shine-advanced', 'allowPlayersToTogglePlayerLightMode') ?? true;

      // NOTE: In Foundry v13, accessing ui.controls.tool (and in some builds, game.activeTool)
      // can throw during early UI init because the SceneControls instance is not fully
      // constructed yet. This hook may run before ui.controls is ready.
      // Do not read active tool state here.

      const getControl = (name) => {
        try {
          if (!controls) return null;

          // Foundry versions differ:
          // - Some pass an array of SceneControl definitions
          // - Some pass a record keyed by layer name
          if (Array.isArray(controls)) {
            return controls.find((c) => c && (c.name === name)) ?? null;
          }

          if (Object.prototype.hasOwnProperty.call(controls, name)) {
            return controls[name];
          }
        } catch (_) {
        }
        return null;
      };

      const ensureTool = (control, tool) => {
        if (!control || !tool || !tool.name) return;

        const tools = control.tools;
        if (!tools) return;

        // Foundry versions differ: tools can be an array or an object map.
        if (Array.isArray(tools)) {
          const exists = tools.some((t) => t && (t.name === tool.name));
          if (!exists) tools.push(tool);
          return;
        }

        if (typeof tools === 'object') {
          if (!Object.prototype.hasOwnProperty.call(tools, tool.name)) {
            tools[tool.name] = tool;
          }
        }
      };

      const tokenControls = getControl('tokens');
      if (!tokenControls || !tokenControls.tools) return;

      if (isGM) {
        ensureTool(tokenControls, {
          name: 'map-shine-config',
          title: 'Map Shine Config',
          icon: 'fas fa-cog',
          button: true,
          order: 100,
          visible: true,
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
        });

        ensureTool(tokenControls, {
          name: 'map-shine-control',
          title: 'Map Shine Control',
          icon: 'fas fa-sliders-h',
          button: true,
          order: 101,
          visible: true,
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
        });

        ensureTool(tokenControls, {
          name: 'map-shine-camera',
          title: 'Map Shine Advanced Camera',
          icon: 'fas fa-video',
          button: true,
          order: 102,
          visible: true,
          toolclip: {
            src: '',
            heading: 'MAPSHINE.ToolTitle',
            items: [{ paragraph: 'MAPSHINE.ToolDescription' }]
          },
          onChange: () => {
            const cameraPanel = window.MapShine?.cameraPanel;
            if (!cameraPanel) {
              ui.notifications?.warn?.('Map Shine Camera Panel is not available yet. The scene may still be initializing.');
              return;
            }
            cameraPanel.toggle();
          }
        });
      }

      const playerToolsVisible = isGM || allowPlayers;

      ensureTool(tokenControls, {
        name: 'map-shine-graphics-settings',
        title: 'Map Shine Graphics Settings',
        icon: 'fas fa-desktop',
        button: true,
        order: 105,
        visible: playerToolsVisible,
        toolclip: {
          src: '',
          heading: 'MAPSHINE.ToolTitle',
          items: [{ paragraph: 'MAPSHINE.ToolDescription' }]
        },
        onChange: () => {
          const graphicsSettings = window.MapShine?.graphicsSettings;
          if (!graphicsSettings) {
            ui.notifications?.warn?.('Map Shine Graphics Settings is not available yet. The scene may still be initializing.');
            return;
          }
          graphicsSettings.toggle();
        }
      });

      const getControlledTokenDoc = () => {
        try {
          const controlled = canvas?.tokens?.controlled;
          const token = (Array.isArray(controlled) && controlled.length > 0) ? controlled[0] : null;
          return token?.document ?? null;
        } catch (_) {
          return null;
        }
      };

      const getPlayerLightState = () => {
        const tokenDoc = getControlledTokenDoc();
        if (!tokenDoc) return { tokenDoc: null, enabled: false, mode: 'flashlight' };

        const enabled = tokenDoc.getFlag?.('map-shine-advanced', 'playerLightEnabled');
        const mode = tokenDoc.getFlag?.('map-shine-advanced', 'playerLightMode');

        return {
          tokenDoc,
          enabled: (enabled === undefined || enabled === null) ? false : !!enabled,
          mode: (mode === 'torch' || mode === 'flashlight') ? mode : 'flashlight'
        };
      };

      const rerenderControls = () => {
        try { ui?.controls?.render?.(true); } catch (_) {}
        try {
          ui?.controls?.render?.(true);
        } catch (_) {
        }
      };

      const stNow = getPlayerLightState();
      const globalPlayerLightEnabled = !!(window.MapShine?.playerLightEffect?.enabled);
      const torchActive = globalPlayerLightEnabled && !!stNow.tokenDoc && stNow.enabled && stNow.mode === 'torch';
      const flashlightActive = globalPlayerLightEnabled && !!stNow.tokenDoc && stNow.enabled && stNow.mode === 'flashlight';

      ensureTool(tokenControls, {
        name: 'map-shine-player-torch',
        title: 'Player Light: Torch',
        icon: 'fas fa-fire',
        toggle: true,
        order: 103,
        visible: playerToolsVisible,
        active: torchActive,
        onChange: async () => {
          if (!playerToolsVisible) {
            ui.notifications?.warn?.('Only the GM can change Player Light mode.');
            return;
          }

          if (!window.MapShine?.playerLightEffect?.enabled) {
            ui.notifications?.warn?.('Player Light is disabled for this map.');
            rerenderControls();
            return;
          }

          const { tokenDoc, enabled, mode } = getPlayerLightState();
          if (!tokenDoc) {
            ui.notifications?.warn?.('Select a token first.');
            return;
          }

          try {
            if (enabled && mode === 'torch') {
              await tokenDoc.setFlag('map-shine-advanced', 'playerLightEnabled', false);
            } else {
              await tokenDoc.setFlag('map-shine-advanced', 'playerLightEnabled', true);
              await tokenDoc.setFlag('map-shine-advanced', 'playerLightMode', 'torch');
            }
            rerenderControls();
          } catch (e) {
            console.error('Map Shine: failed to set player light mode', e);
            ui.notifications?.warn?.('Failed to set Player Light mode.');
          }
        }
      });

      ensureTool(tokenControls, {
        name: 'map-shine-player-flashlight',
        title: 'Player Light: Flashlight',
        icon: 'fas fa-lightbulb',
        toggle: true,
        order: 104,
        visible: playerToolsVisible,
        active: flashlightActive,
        onChange: async () => {
          if (!playerToolsVisible) {
            ui.notifications?.warn?.('Only the GM can change Player Light mode.');
            return;
          }

          if (!window.MapShine?.playerLightEffect?.enabled) {
            ui.notifications?.warn?.('Player Light is disabled for this map.');
            rerenderControls();
            return;
          }

          const { tokenDoc, enabled, mode } = getPlayerLightState();
          if (!tokenDoc) {
            ui.notifications?.warn?.('Select a token first.');
            return;
          }

          try {
            if (enabled && mode === 'flashlight') {
              await tokenDoc.setFlag('map-shine-advanced', 'playerLightEnabled', false);
            } else {
              await tokenDoc.setFlag('map-shine-advanced', 'playerLightEnabled', true);
              await tokenDoc.setFlag('map-shine-advanced', 'playerLightMode', 'flashlight');
            }
            rerenderControls();
          } catch (e) {
            console.error('Map Shine: failed to set player light mode', e);
            ui.notifications?.warn?.('Failed to set Player Light mode.');
          }
        }
      });

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
  // Record bootstrap completion even if initialization failed.
  MapShine.bootstrapComplete = true;
  MapShine.bootstrapError = state?.error ?? null;

  try {
    if (!state?.initialized) {
      loadingOverlay.setMessage('Renderer unavailable');
    }
  } catch (e) {
    console.warn('Map Shine: failed to update loading overlay', e);
  }
  
  info('Module ready');
});