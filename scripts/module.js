/**
 * @fileoverview Map Shine Advanced - Foundry VTT Module Entrypoint
 * Handles Foundry VTT hooks and delegates initialization to core/bootstrap
 * @module module
 */

import { bootstrap, cleanup } from './core/bootstrap.js';
import { info } from './core/log.js';
import * as sceneSettings from './settings/scene-settings.js';
import * as canvasReplacement from './foundry/canvas-replacement.js';
import { registerLevelNavigationKeybindings } from './foundry/level-navigation-keybindings.js';
import { registerUISettings } from './ui/tweakpane-manager.js';
import { loadingScreenService as loadingOverlay } from './ui/loading-screen/loading-screen-service.js';
import { LoadingScreenManager } from './ui/loading-screen/loading-screen-manager.js';
import { debugLoadingProfiler } from './core/debug-loading-profiler.js';

const MODULE_ID = 'map-shine-advanced';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getMovementStyleEntries() {
  const manager = window.MapShine?.tokenMovementManager;
  if (manager?.styles instanceof Map && manager.styles.size > 0) {
    const entries = [];
    for (const [id, def] of manager.styles.entries()) {
      entries.push({ id, label: String(def?.label || id) });
    }
    if (entries.length > 0) return entries;
  }

  return [
    { id: 'walk', label: 'Walk - Steady March' },
    { id: 'walk-heavy-stomp', label: 'Walk - Heavy Stomp' },
    { id: 'walk-sneak-glide', label: 'Walk - Sneak Glide' },
    { id: 'walk-swagger-stride', label: 'Walk - Swagger Stride' },
    { id: 'walk-skitter-step', label: 'Walk - Skitter Step' },
    { id: 'walk-limping-advance', label: 'Walk - Limping Advance' },
    { id: 'walk-wobble-totter', label: 'Walk - Wobble Totter' },
    { id: 'walk-drunken-drift', label: 'Walk - Drunken Drift' },
    { id: 'walk-clockwork-tick', label: 'Walk - Clockwork Tick-Walk' },
    { id: 'walk-chaos-skip', label: 'Walk - Chaos Skip' },
    { id: 'pick-up-drop', label: 'Pick Up and Drop' },
    { id: 'flying-glide', label: 'Flying - Glide' },
    { id: 'flying-hover-bob', label: 'Flying - Hover Bob' },
    { id: 'flying-bank-swoop', label: 'Flying - Bank Swoop' },
    { id: 'flying-flutter-dart', label: 'Flying - Flutter Dart' },
    { id: 'flying-chaos-drift', label: 'Flying - Chaos Drift' }
  ];
}

function getActorSheetTokenDocuments(sheetApp) {
  const tokenMap = new Map();

  const primaryTokenDoc = sheetApp?.token?.document;
  if (primaryTokenDoc?.id) tokenMap.set(primaryTokenDoc.id, primaryTokenDoc);

  const actor = sheetApp?.actor;
  if (actor?.getActiveTokens) {
    const activeTokenDocs = actor.getActiveTokens(false, true) || [];
    for (const tokenDoc of activeTokenDocs) {
      if (tokenDoc?.id) tokenMap.set(tokenDoc.id, tokenDoc);
    }
  }

  return [...tokenMap.values()];
}

function openActorMovementStyleDialog(sheetApp) {
  const actor = sheetApp?.actor;
  if (!actor) return;

  const tokenDocs = getActorSheetTokenDocuments(sheetApp).filter((tokenDoc) => {
    if (!tokenDoc?.id) return false;
    return !!canvas?.scene?.tokens?.get(tokenDoc.id);
  });

  if (tokenDocs.length === 0) {
    ui.notifications?.warn?.('No active scene tokens found for this character.');
    return;
  }

  const controlledIds = new Set(
    (canvas?.tokens?.controlled || [])
      .map((token) => token?.document?.id)
      .filter(Boolean)
  );

  const initialToken = tokenDocs.find((tokenDoc) => controlledIds.has(tokenDoc.id)) || tokenDocs[0];
  const movementStyles = getMovementStyleEntries();
  const initialStyle = String(initialToken?.getFlag?.(MODULE_ID, 'movementStyle') || '__default__');

  const tokenOptionsHtml = tokenDocs
    .map((tokenDoc) => {
      const tokenName = tokenDoc?.name || actor.name || tokenDoc.id;
      const selected = tokenDoc.id === initialToken.id ? ' selected' : '';
      return `<option value="${escapeHtml(tokenDoc.id)}"${selected}>${escapeHtml(tokenName)}</option>`;
    })
    .join('');

  const styleOptionsHtml = [
    `<option value="__default__"${initialStyle === '__default__' ? ' selected' : ''}>Scene Default</option>`,
    ...movementStyles.map((style) => {
      const selected = style.id === initialStyle ? ' selected' : '';
      return `<option value="${escapeHtml(style.id)}"${selected}>${escapeHtml(style.label)}</option>`;
    })
  ].join('');

  const content = `
    <form class="map-shine-movement-style-form" style="display:flex; flex-direction:column; gap: 0.75rem;">
      <p style="margin:0; opacity:0.9;">Choose a movement style for a single token in this scene.</p>
      <div class="form-group">
        <label for="map-shine-token-id" style="display:block; font-weight:600; margin-bottom:0.25rem;">Token</label>
        <select id="map-shine-token-id" name="map-shine-token-id" style="width:100%;">${tokenOptionsHtml}</select>
      </div>
      <div class="form-group">
        <label for="map-shine-movement-style" style="display:block; font-weight:600; margin-bottom:0.25rem;">Movement Style</label>
        <select id="map-shine-movement-style" name="map-shine-movement-style" style="width:100%;">${styleOptionsHtml}</select>
      </div>
      <p class="notes" style="margin:0; opacity:0.75;">This updates the token flag <code>flags.${MODULE_ID}.movementStyle</code>.</p>
    </form>
  `;

  new Dialog(
    {
      title: `Movement Style - ${actor.name}`,
      content,
      buttons: {
        save: {
          icon: '<i class="fas fa-check"></i>',
          label: 'Apply',
          callback: (html) => {
            void (async () => {
              try {
                const tokenId = String(html?.find?.('select[name="map-shine-token-id"]')?.val?.() || '');
                const selectedStyle = String(html?.find?.('select[name="map-shine-movement-style"]')?.val?.() || '__default__');
                if (!tokenId) return;

                const tokenDoc = canvas?.scene?.tokens?.get?.(tokenId);
                if (!tokenDoc) {
                  ui.notifications?.warn?.('Token was not found in the current scene.');
                  return;
                }

                const manager = window.MapShine?.tokenMovementManager;
                if (selectedStyle === '__default__') {
                  await tokenDoc.unsetFlag(MODULE_ID, 'movementStyle');
                  manager?.setTokenStyleOverride?.(tokenId, null);
                  ui.notifications?.info?.(`Movement style reset to scene default for ${tokenDoc.name || 'token'}.`);
                  return;
                }

                await tokenDoc.setFlag(MODULE_ID, 'movementStyle', selectedStyle);
                manager?.setTokenStyleOverride?.(tokenId, selectedStyle);
                const selectedLabel = movementStyles.find((entry) => entry.id === selectedStyle)?.label || selectedStyle;
                ui.notifications?.info?.(`Movement style set to ${selectedLabel} for ${tokenDoc.name || 'token'}.`);
              } catch (e) {
                console.error('Map Shine: failed to apply token movement style from actor sheet', e);
                ui.notifications?.error?.('Failed to apply movement style.');
              }
            })();
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Cancel'
        }
      },
      render: (html) => {
        try {
          const tokenSelect = html?.find?.('select[name="map-shine-token-id"]');
          const styleSelect = html?.find?.('select[name="map-shine-movement-style"]');
          if (!tokenSelect?.length || !styleSelect?.length) return;

          const syncStyleToToken = () => {
            const selectedTokenId = String(tokenSelect.val?.() || '');
            const selectedToken = tokenDocs.find((tokenDoc) => tokenDoc?.id === selectedTokenId);
            const selectedTokenStyle = String(selectedToken?.getFlag?.(MODULE_ID, 'movementStyle') || '__default__');

            let hasStyleOption = false;
            styleSelect.find('option').each((_, option) => {
              if (String(option?.value || '') === selectedTokenStyle) hasStyleOption = true;
            });

            styleSelect.val(hasStyleOption ? selectedTokenStyle : '__default__');
          };

          tokenSelect.on('change', syncStyleToToken);
          syncStyleToToken();
        } catch (_) {
        }
      },
      default: 'save'
    },
    { width: 420 }
  ).render(true);
}

function showExperimentalWarningDialog() {
  try {
    const dismissed = game.settings?.get?.(MODULE_ID, 'dismissExperimentalWarning');
    if (dismissed) return;

    const issuesUrl = 'https://github.com/Garsondee/map-shine-advanced/issues';

    const content = `
      <div style="display:flex; flex-direction:column; gap: 0.75rem;">
        <p>
          <strong>Map Shine Advanced is experimental.</strong>
          It may be unreliable, incomplete, or change behavior between versions.
        </p>
        <p>
          <strong>Compatibility note:</strong>
          Levels compatibility is currently designed for <strong>import-only</strong> workflows.
          Running active Levels runtime wrappers alongside Map Shine gameplay mode can still conflict.
        </p>
        <p>
          If things aren’t working correctly mid-session, your best bet may be to <strong>disable Map Shine Advanced</strong>
          and continue with the session without it.
        </p>
        <p>
          Please report bugs and odd behavior so they can be fixed:
          <a href="${issuesUrl}" target="_blank" rel="noopener noreferrer">${issuesUrl}</a>
        </p>
        <label style="display:flex; align-items:center; gap: 0.5rem;">
          <input type="checkbox" name="msa-dismiss-experimental-warning" />
          <span>Don’t show this message again</span>
        </label>
      </div>
    `;

    const applyDismissal = (html) => {
      try {
        const checked = !!html?.find?.('input[name="msa-dismiss-experimental-warning"]')?.prop?.('checked');
        if (checked) {
          game.settings?.set?.(MODULE_ID, 'dismissExperimentalWarning', true);
        }
      } catch (_) {
      }
    };

    new Dialog(
      {
        title: 'Map Shine Advanced (Experimental)',
        content,
        buttons: {
          issues: {
            icon: '<i class="fas fa-bug"></i>',
            label: 'Report a Bug',
            callback: (html) => {
              applyDismissal(html);
              try { window.open(issuesUrl, '_blank', 'noopener'); } catch (_) {}
            }
          },
          ok: {
            icon: '<i class="fas fa-check"></i>',
            label: 'Continue',
            callback: (html) => applyDismissal(html)
          }
        },
        default: 'ok',
        close: (html) => applyDismissal(html)
      },
      { width: 520 }
    ).render(true);
  } catch (e) {
    console.warn('Map Shine: failed to show experimental warning dialog', e);
  }
}

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
MapShine.loadingScreenService = loadingOverlay;

// Expose debug loading profiler early (runtime state is synced from Foundry settings at init).
MapShine.debugLoadingProfiler = debugLoadingProfiler;

/**
 * Foundry VTT 'init' hook - Called when Foundry initializes
 * Used for early setup like settings registration
 */
Hooks.once('init', async function() {
  info('Initializing...');

  // Register settings first so loading-screen service can read world defaults.
  sceneSettings.registerSettings();

  try {
    await loadingOverlay.initialize();
  } catch (e) {
    console.warn('Map Shine: failed to initialize loading screen service', e);
  }

  try {
    loadingOverlay.showBlack('Initializing…');
  } catch (e) {
    console.warn('Map Shine: failed to initialize loading overlay', e);
  }

  console.log("%c GNU Terry Pratchett %c \n“A man is not dead while his name is still spoken.”",
  "background: #313131ff; color: #FFD700; font-weight: bold; padding: 4px 8px; border-radius: 4px;",
  "color: #888; font-style: italic;"
);
  
  registerLevelNavigationKeybindings(MODULE_ID);
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

      if (isGM) {
        ensureTool(tokenControls, {
          name: 'map-shine-loading-screens',
          title: 'Map Shine Loading Screens',
          icon: 'fas fa-images',
          button: true,
          order: 106,
          visible: true,
          toolclip: {
            src: '',
            heading: 'MAPSHINE.ToolTitle',
            items: [{ paragraph: 'Open Loading Screen Composer' }]
          },
          onChange: async () => {
            try {
              let manager = window.MapShine?.loadingScreenManager;
              if (!manager) {
                manager = new LoadingScreenManager();
                await manager.initialize();
                if (window.MapShine) window.MapShine.loadingScreenManager = manager;
              }
              await manager.toggle();
            } catch (e) {
              console.error('Map Shine: failed to open Loading Screen Composer', e);
              ui.notifications?.warn?.('Loading Screen Composer is not available yet.');
            }
          }
        });
      }

      ensureTool(tokenControls, {
        name: 'map-shine-player-torch',
        title: 'Player Light: Torch',
        icon: 'fas fa-fire',
        toggle: true,
        order: 103,
        visible: playerToolsVisible,
        active: false,
        onChange: async () => {
          if (!playerToolsVisible) {
            ui.notifications?.warn?.('Only the GM can change Player Light mode.');
            return;
          }

          if (!window.MapShine?.playerLightEffect?.enabled) {
            ui.notifications?.warn?.('Player Light is disabled for this map.');
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
        active: false,
        onChange: async () => {
          if (!playerToolsVisible) {
            ui.notifications?.warn?.('Only the GM can change Player Light mode.');
            return;
          }

          if (!window.MapShine?.playerLightEffect?.enabled) {
            ui.notifications?.warn?.('Player Light is disabled for this map.');
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

  Hooks.on('getActorSheetHeaderButtons', (app, buttons) => {
    try {
      const actor = app?.actor;
      if (!actor || !Array.isArray(buttons)) return;
      if (!game.user?.isGM && !actor.isOwner) return;

      const existing = buttons.some((btn) => btn?.class === 'map-shine-movement-style');
      if (existing) return;

      buttons.unshift({
        label: 'Movement Style',
        class: 'map-shine-movement-style',
        icon: 'fas fa-shoe-prints',
        onclick: () => openActorMovementStyleDialog(app)
      });
    } catch (e) {
      console.error('Map Shine: failed to add actor sheet movement style header button', e);
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
    // Defer slightly so the rest of Foundry UI finishes settling before we show a modal.
    setTimeout(() => showExperimentalWarningDialog(), 250);
  } catch (_) {
  }

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

  try {
    if (!MapShine.loadingScreenManager) {
      const manager = new LoadingScreenManager();
      await manager.initialize();
      MapShine.loadingScreenManager = manager;
    }
  } catch (e) {
    console.warn('Map Shine: failed to initialize Loading Screen Manager', e);
  }
});