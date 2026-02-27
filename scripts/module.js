/**
 * @fileoverview Map Shine Advanced - Foundry VTT Module Entrypoint
 * Handles Foundry VTT hooks and delegates initialization to core/bootstrap
 * @module module
 */

function _msaCrisisLog(id, message) {
  try {
    const n = String(id).padStart(3, '0');
    console.log(`Crisis #${n} - ${message}`);
  } catch (_) {
  }
}

function _msaCrisisSafeJsonSize(value) {
  try {
    return JSON.stringify(value)?.length ?? null;
  } catch (_) {
    return null;
  }
}

function _msaCrisisInspectScene(scene, label) {
  try {
    if (!scene) {
      _msaCrisisLog(360, `${label}: scene=null`);
      return;
    }

    const id = scene.id ?? scene._id ?? 'unknown';
    const name = scene.name ?? 'unnamed';
    const flags = scene.flags ?? {};
    const msaFlags = flags?.['map-shine-advanced'] ?? {};

    const dim = scene.dimensions ?? null;
    const bg = scene.background?.src ?? scene.img ?? null;

    console.log(`Crisis #361 - ${label}: scene id=${id}, name=${name}`);
    console.log(`Crisis #362 - ${label}: dims=${dim ? JSON.stringify({w: dim.width, h: dim.height, sceneX: dim.sceneX, sceneY: dim.sceneY, sceneW: dim.sceneWidth, sceneH: dim.sceneHeight, pad: dim.padding, grid: dim.size}) : 'null'}`);
    console.log(`Crisis #363 - ${label}: bg=${bg ? String(bg).slice(0, 240) : 'null'}`);

    const counts = {
      tokens: scene.tokens?.size ?? scene.tokens?.length ?? null,
      tiles: scene.tiles?.size ?? scene.tiles?.length ?? null,
      walls: scene.walls?.size ?? scene.walls?.length ?? null,
      lights: scene.lights?.size ?? scene.lights?.length ?? null,
      sounds: scene.sounds?.size ?? scene.sounds?.length ?? null,
      drawings: scene.drawings?.size ?? scene.drawings?.length ?? null,
      notes: scene.notes?.size ?? scene.notes?.length ?? null,
      regions: scene.regions?.size ?? scene.regions?.length ?? null,
    };
    console.log(`Crisis #364 - ${label}: counts=${JSON.stringify(counts)}`);

    const allFlagsSize = _msaCrisisSafeJsonSize(flags);
    const msaFlagsSize = _msaCrisisSafeJsonSize(msaFlags);
    console.log(`Crisis #365 - ${label}: flags sizes: all=${allFlagsSize ?? '??'} bytes, msa=${msaFlagsSize ?? '??'} bytes`);

    try {
      const perModule = [];
      for (const [modId, modFlags] of Object.entries(flags ?? {})) {
        const sz = _msaCrisisSafeJsonSize(modFlags);
        if (typeof sz === 'number') perModule.push({ modId, sz });
      }
      perModule.sort((a, b) => b.sz - a.sz);
      const top = perModule.slice(0, 12);
      console.log(`Crisis #366 - ${label}: largest flag namespaces:`, top);
    } catch (_) {
    }

    try {
      const suspicious = [];
      const MAX_ABS = 10_000_000;
      const checkDoc = (kind, doc) => {
        try {
          const d = doc?.document ?? doc;
          if (!d) return;
          const docId = d.id ?? d._id ?? 'unknown';
          const pushIfBad = (field, v) => {
            if (v === null || v === undefined) return;
            if (typeof v !== 'number') return;
            if (!Number.isFinite(v) || Math.abs(v) > MAX_ABS) {
              suspicious.push({ kind, id: docId, field, value: v });
            }
          };

          pushIfBad('x', d.x);
          pushIfBad('y', d.y);
          pushIfBad('width', d.width);
          pushIfBad('height', d.height);
          pushIfBad('rotation', d.rotation);
          pushIfBad('elevation', d.elevation);

          // Common texture fields
          const src = d.texture?.src ?? d.img ?? null;
          if (src != null && typeof src !== 'string') {
            suspicious.push({ kind, id: docId, field: 'texture.src', value: `non-string (${typeof src})` });
          }
        } catch (_) {
        }
      };

      const each = (collection, kind) => {
        try {
          if (!collection) return;
          if (typeof collection.values === 'function') {
            for (const doc of collection.values()) checkDoc(kind, doc);
          } else if (Array.isArray(collection)) {
            for (const doc of collection) checkDoc(kind, doc);
          }
        } catch (_) {
        }
      };

      each(scene.tiles, 'Tile');
      each(scene.tokens, 'Token');
      each(scene.walls, 'Wall');
      each(scene.lights, 'AmbientLight');
      each(scene.sounds, 'AmbientSound');
      each(scene.drawings, 'Drawing');
      each(scene.notes, 'Note');
      each(scene.regions, 'Region');

      if (suspicious.length) {
        console.warn(`Crisis #367 - ${label}: suspicious numeric/field values detected (${suspicious.length})`);
        console.log('Crisis #367 - details:', suspicious.slice(0, 80));
        if (suspicious.length > 80) console.warn(`Crisis #367 - details truncated (showing 80/${suspicious.length})`);
      } else {
        console.log(`Crisis #368 - ${label}: no suspicious numeric values detected`);
      }
    } catch (_) {
    }

  } catch (e) {
    try { console.warn(`Crisis #369 - ${label}: inspector failed: ${e?.message ?? e}`); } catch (_) {}
  }
}

_msaCrisisLog(1, 'module.js: module evaluation started');

try {
  console.warn('MapShine DIAG loaded module.js from:', import.meta?.url ?? '(no import.meta.url)');
} catch (_) {
}

try {
  if (!window.__msaCrisisGlobalHandlersInstalled) {
    window.__msaCrisisGlobalHandlersInstalled = true;

    window.addEventListener('error', (ev) => {
      try {
        const msg = ev?.message ?? 'unknown error';
        const file = ev?.filename ?? '';
        const line = (typeof ev?.lineno === 'number') ? ev.lineno : '';
        const col = (typeof ev?.colno === 'number') ? ev.colno : '';
        const err = ev?.error;
        const stack = err?.stack ?? null;
        _msaCrisisLog(5, `window.onerror: ${msg} @ ${file}:${line}:${col}`);
        if (stack) console.log(`Crisis #005 - window.onerror stack:\n${stack}`);
      } catch (_) {
      }
    });

    window.addEventListener('unhandledrejection', (ev) => {
      try {
        const reason = ev?.reason;
        const msg = (reason && typeof reason === 'object' && 'message' in reason) ? reason.message : String(reason);
        const stack = reason?.stack ?? null;
        _msaCrisisLog(6, `window.onunhandledrejection: ${msg}`);
        if (stack) console.log(`Crisis #006 - window.onunhandledrejection stack:\n${stack}`);
      } catch (_) {
      }
    });

    _msaCrisisLog(7, 'module.js: installed global error handlers');
  }
} catch (_) {
}

const MODULE_ID = 'map-shine-advanced';

_msaCrisisLog(2, `module.js: MODULE_ID set (${MODULE_ID})`);

function rerenderControls() {
  try {
    ui?.controls?.render?.(true);
  } catch (_) {
  }
}

function getPlayerLightState() {
  try {
    const tokenDoc = canvas?.tokens?.controlled?.[0]?.document ?? null;
    if (!tokenDoc) return { tokenDoc: null, enabled: false, mode: null };

    const enabled = !!tokenDoc.getFlag?.(MODULE_ID, 'playerLightEnabled');
    const modeRaw = tokenDoc.getFlag?.(MODULE_ID, 'playerLightMode');
    const mode = (modeRaw === 'torch' || modeRaw === 'flashlight') ? modeRaw : null;
    return { tokenDoc, enabled, mode };
  } catch (_) {
    return { tokenDoc: null, enabled: false, mode: null };
  }
}

function openActorMovementStyleDialog() {
  try {
    const dlg = window.MapShine?.uiManager?.tokenMovementDialog;
    if (dlg && typeof dlg.toggle === 'function') {
      dlg.toggle();
      return;
    }

    ui.notifications?.warn?.('Movement Style dialog is not available yet. The scene may still be initializing.');
  } catch (_) {
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

_msaCrisisLog(3, 'module.js: MapShine global state object prepared');

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
MapShine.loadingScreenService = MapShine.loadingScreenService ?? null;
MapShine.debugLoadingProfiler = MapShine.debugLoadingProfiler ?? null;

_msaCrisisLog(4, 'module.js: MapShine state exposed on window');

/**
 * Foundry VTT 'init' hook - Called when Foundry initializes
 * Used for early setup like settings registration
 */
Hooks.once('init', async function() {
  _msaCrisisLog(10, "Hooks.once('init'): handler entered");

  // Diagnostic: watch for any changes to the MSA enabled flag or namespace.
  // This will show whether something is overwriting or deleting flags after you enable.
  try {
    if (!window.__msaEnabledFlagWatchInstalled) {
      window.__msaEnabledFlagWatchInstalled = true;
      Hooks.on('updateScene', (sceneDoc, changes) => {
        try {
          const ns = changes?.flags?.['map-shine-advanced'];
          const touched = (ns !== undefined) || (changes?.flags?.['-=map-shine-advanced'] !== undefined);
          if (!touched) return;
          const currentEnabled = (() => {
            try { return sceneDoc?.getFlag?.('map-shine-advanced', 'enabled'); } catch (_) { return null; }
          })();
          console.warn('MapShine DIAG updateScene flags changed:', {
            sceneId: sceneDoc?.id ?? null,
            sceneName: sceneDoc?.name ?? null,
            changesFlags: changes?.flags ?? null,
            currentEnabled,
          });
        } catch (_) {}
      });
    }
  } catch (_) {}

  try {
    // Scene/world corruption diagnostics: install very early so we still get logs
    // even if scene loading later hard-stalls.
    if (!window.__msaCrisisCorruptionDiagInstalled) {
      window.__msaCrisisCorruptionDiagInstalled = true;

      Hooks.on('canvasConfig', () => {
        try { _msaCrisisInspectScene(game?.scenes?.active ?? canvas?.scene ?? null, 'canvasConfig'); } catch (_) {}
      });

      Hooks.on('canvasInit', () => {
        try { _msaCrisisInspectScene(game?.scenes?.active ?? canvas?.scene ?? null, 'canvasInit'); } catch (_) {}
      });

      Hooks.on('drawCanvas', () => {
        try { _msaCrisisInspectScene(game?.scenes?.active ?? canvas?.scene ?? null, 'drawCanvas'); } catch (_) {}
      });

      Hooks.on('preUpdateScene', (scene) => {
        try { _msaCrisisInspectScene(scene, 'preUpdateScene'); } catch (_) {}
      });

      Hooks.once('ready', () => {
        try {
          const worldId = game?.world?.id ?? 'unknown';
          const worldTitle = game?.world?.title ?? 'unknown';
          console.log(`Crisis #359 - ready: world id=${worldId}, title=${worldTitle}`);
          _msaCrisisInspectScene(game?.scenes?.active ?? canvas?.scene ?? null, 'ready');
        } catch (_) {}
      });

      _msaCrisisLog(358, 'init: corruption diagnostics hooks installed');
    }
  } catch (_) {
  }

  const [{ info }, sceneSettings, canvasReplacement, { registerLevelNavigationKeybindings }, { registerUISettings }, loadingService, debugLoadingProfilerMod] = await Promise.all([
    import('./core/log.js'),
    import('./settings/scene-settings.js'),
    import('./foundry/canvas-replacement.js'),
    import('./foundry/level-navigation-keybindings.js'),
    import('./ui/tweakpane-manager.js'),
    import('./ui/loading-screen/loading-screen-service.js'),
    import('./core/debug-loading-profiler.js')
  ]);

  _msaCrisisLog(11, 'init: dynamic imports resolved');

  const loadingOverlay = loadingService.loadingScreenService;
  const debugLoadingProfiler = debugLoadingProfilerMod.debugLoadingProfiler;
  MapShine.loadingScreenService = loadingOverlay;
  MapShine.debugLoadingProfiler = debugLoadingProfiler;

  _msaCrisisLog(12, 'init: loading overlay + debug loading profiler assigned');

  info('Initializing...');

  _msaCrisisLog(13, 'init: scene settings registerSettings() about to run');

  // Register settings first so loading-screen service can read world defaults.
  sceneSettings.registerSettings();

  _msaCrisisLog(14, 'init: scene settings registered');

  try {
    _msaCrisisLog(15, 'init: loadingOverlay.initialize() about to run');
    await loadingOverlay.initialize();
    _msaCrisisLog(16, 'init: loadingOverlay.initialize() completed');
  } catch (e) {
    console.warn('Map Shine: failed to initialize loading screen service', e);
    _msaCrisisLog(17, 'init: loadingOverlay.initialize() threw');
  }

  try {
    _msaCrisisLog(18, 'init: loadingOverlay.showBlack() about to run');
    loadingOverlay.showBlack('Initializing…');
    _msaCrisisLog(19, 'init: loadingOverlay.showBlack() completed');
  } catch (e) {
    console.warn('Map Shine: failed to initialize loading overlay', e);
    _msaCrisisLog(20, 'init: loadingOverlay.showBlack() threw');
  }

  console.log("%c GNU Terry Pratchett %c \n“A man is not dead while his name is still spoken.”",
  "background: #313131ff; color: #FFD700; font-weight: bold; padding: 4px 8px; border-radius: 4px;",
  "color: #888; font-style: italic;"
);

  registerLevelNavigationKeybindings(MODULE_ID);
  _msaCrisisLog(21, 'init: registerLevelNavigationKeybindings() completed');
  // Sync Debug Loading Mode from Foundry settings on startup.
  debugLoadingProfiler.debugMode = sceneSettings.getDebugLoadingModeEnabled();
  _msaCrisisLog(22, 'init: debugLoadingProfiler.debugMode synced');
  registerUISettings();
  _msaCrisisLog(23, 'init: registerUISettings() completed');

  // Register scene control buttons for Map Shine panels
  // Foundry v13+ uses Record<string, SceneControl> with tools as Record<string, SceneControlTool>
  Hooks.on('getSceneControlButtons', (controls) => {
    _msaCrisisLog(24, 'init: getSceneControlButtons hook fired');
    try {
      const isGM = game.user?.isGM ?? false;
      const allowPlayers = game.settings?.get?.('map-shine-advanced', 'allowPlayersToTogglePlayerLightMode') ?? true;
      const playerToolsVisible = !!(isGM || allowPlayers);

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

        ensureTool(tokenControls, {
          name: 'map-shine-circuit-breaker',
          title: 'Map Shine Circuit Breaker',
          icon: 'fas fa-bolt',
          button: true,
          order: 107,
          visible: true,
          toolclip: {
            src: '',
            heading: 'MAPSHINE.ToolTitle',
            items: [{ paragraph: 'Disable effects before they load (debugging).' }]
          },
          onChange: async () => {
            try {
              const mod = await import('./ui/circuit-breaker-panel.js');
              await mod.openCircuitBreakerPanel();
            } catch (e) {
              console.error('Map Shine: failed to open Circuit Breaker Panel', e);
              ui.notifications?.warn?.('Circuit Breaker Panel is not available yet.');
            }
          }
        });

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
                const mod = await import('./ui/loading-screen/loading-screen-manager.js');
                const LoadingScreenManager = mod.LoadingScreenManager;
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
      _msaCrisisLog(25, 'init: getSceneControlButtons threw');
    }
  });

  Hooks.on('getActorSheetHeaderButtons', (app, buttons) => {
    _msaCrisisLog(26, 'init: getActorSheetHeaderButtons hook fired');
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
      _msaCrisisLog(27, 'init: getActorSheetHeaderButtons threw');
    }
  });

  Hooks.on('renderTileConfig', (app, html) => {
    _msaCrisisLog(28, 'init: renderTileConfig hook fired');
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
      _msaCrisisLog(29, 'init: renderTileConfig threw');
    }
  });

  // Initialize canvas replacement hooks
  try {
    _msaCrisisLog(30, 'init: calling canvasReplacement.initialize()');
  } catch (_) {
  }
  _msaCrisisLog(31, 'init: canvasReplacement.initialize() about to run');
  canvasReplacement.initialize();
  try {
    _msaCrisisLog(32, 'init: canvasReplacement.initialize() returned');
  } catch (_) {
  }
});

/**
 * Foundry VTT 'ready' hook - Called when Foundry is fully loaded
 * Main bootstrap happens here
 */
Hooks.once('ready', async function() {
  _msaCrisisLog(40, "Hooks.once('ready'): handler entered");
  const [{ info }, loadingService] = await Promise.all([
    import('./core/log.js'),
    import('./ui/loading-screen/loading-screen-service.js')
  ]);

  _msaCrisisLog(41, 'ready: dynamic imports resolved');

  const loadingOverlay = loadingService.loadingScreenService;
  MapShine.loadingScreenService = loadingOverlay;
  console.log('[MSA BOOT] ready hook: fired');

  _msaCrisisLog(42, 'ready: loading overlay assigned');

  try {
    // Defer slightly so the rest of Foundry UI finishes settling before we show a modal.
    setTimeout(() => {
      try {
        if (typeof showExperimentalWarningDialog === 'function') showExperimentalWarningDialog();
      } catch (_) {
      }
    }, 250);
    _msaCrisisLog(43, 'ready: experimental warning timeout scheduled');
  } catch (_) {
    _msaCrisisLog(44, 'ready: failed to schedule experimental warning timeout');
  }

  try {
    _msaCrisisLog(45, 'ready: loadingOverlay.setMessage(Preparing renderer…) about to run');
    loadingOverlay.setMessage('Preparing renderer…');
    _msaCrisisLog(46, 'ready: loadingOverlay.setMessage completed');
  } catch (e) {
    console.warn('Map Shine: failed to update loading overlay', e);
    _msaCrisisLog(47, 'ready: loadingOverlay.setMessage threw');
  }
  // Run bootstrap sequence
  _msaCrisisLog(48, 'ready: importing bootstrap + LoadingScreenManager');
  const [{ bootstrap }, { LoadingScreenManager }] = await Promise.all([
    import('./core/bootstrap.js'),
    import('./ui/loading-screen/loading-screen-manager.js')
  ]);

  _msaCrisisLog(49, 'ready: bootstrap + LoadingScreenManager imports resolved');

  _msaCrisisLog(50, 'ready: calling bootstrap({verbose:false})');
  const state = await bootstrap({ verbose: false });

  _msaCrisisLog(51, `ready: bootstrap returned (initialized=${state?.initialized})`);

  console.log('[MSA BOOT] ready hook: bootstrap complete, initialized=', state?.initialized);

  // Update global state
  Object.assign(MapShine, state);
  // Record bootstrap completion even if initialization failed.
  MapShine.bootstrapComplete = true;
  MapShine.bootstrapError = state?.error ?? null;

  _msaCrisisLog(52, 'ready: MapShine global state updated from bootstrap');

  info('Module ready');

  _msaCrisisLog(53, 'ready: info(Module ready) logged');

  try {
    if (!MapShine.loadingScreenManager) {
      _msaCrisisLog(54, 'ready: creating LoadingScreenManager');
      const manager = new LoadingScreenManager();
      await manager.initialize();
      MapShine.loadingScreenManager = manager;
      _msaCrisisLog(55, 'ready: LoadingScreenManager.initialize() completed');
    }
  } catch (e) {
    console.warn('Map Shine: failed to initialize Loading Screen Manager', e);
    _msaCrisisLog(56, 'ready: LoadingScreenManager initialize threw');
  }

  // Safety net: when Foundry has no active scene, it calls #drawBlank() which
  // does NOT fire the canvasReady hook. Without this check the loading overlay
  // shown during `init` is never dismissed and the module appears frozen at 0%.
  // canvasReady will fire normally when the user later navigates to a scene.
  try {
    if (!canvas?.scene) {
      _msaCrisisLog(57, 'ready: no active canvas.scene; dismissing loading overlay');
      info('No active scene — dismissing loading overlay');
      loadingOverlay.fadeIn(500).catch(() => {});
      _msaCrisisLog(58, 'ready: loadingOverlay.fadeIn(500) invoked for no-scene case');
    }
  } catch (e) {
    console.warn('Map Shine: failed to dismiss overlay for no-scene case', e);
    _msaCrisisLog(59, 'ready: no-scene overlay dismissal threw');
  }
});