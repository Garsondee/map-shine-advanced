/**
 * @fileoverview Map Shine Advanced - Foundry VTT Module Entrypoint
 * Handles Foundry VTT hooks and delegates initialization to core/bootstrap
 * @module module
 */

// Static import: keybindings MUST be registered synchronously during the init
// hook, before any await. Dynamic imports yield control back to Foundry, which
// then considers the init phase complete and rejects late registrations.
import { registerLevelNavigationKeybindings } from './foundry/level-navigation-keybindings.js';

function _suppressDiagConsoleLogs() {
  try {
    if (window.__msaDiagLogsSuppressed) return;

    window.__msaDiagLogsSuppressed = true;

    const shouldSuppress = (args) => {
      try {
        if (!Array.isArray(args)) return false;
        return args.some((arg) => (typeof arg === 'string') && arg.includes('Diag #'));
      } catch (_) {
        return false;
      }
    };

    const wrap = (fn) => {
      if (typeof fn !== 'function') return fn;
      return (...args) => {
        if (shouldSuppress(args)) return;
        return fn(...args);
      };
    };

    console.log = wrap(console.log.bind(console));
    console.warn = wrap(console.warn.bind(console));
    console.error = wrap(console.error.bind(console));
  } catch (_) {
  }
}

async function showExperimentalWarningDialog() {
  try {
    if (window.__msaExperimentalWarningShownThisSession) return;

    const dismissed = game?.settings?.get?.(MODULE_ID, 'dismissExperimentalWarning') === true;
    if (dismissed) return;

    window.__msaExperimentalWarningShownThisSession = true;

    const content = `
      <div>
        <p><strong>Map Shine Advanced is experimental.</strong></p>
        <p>
          Stability issues can still occur in complex scenes or unusual module combinations. Because
          Map Shine replaces Foundry's rendering pipeline, modules with heavy visual FX will not be
          compatible yet.
        </p>
        <p>
          If you encounter a rendering problem: save your world, refresh the browser, and gather
          console logs before reporting the issue.
        </p>
        <p>
          Contact / support:
          <a href="https://github.com/Garsondee/map-shine-advanced/issues" target="_blank" rel="noopener noreferrer">GitHub Issues Tracker</a>
          or
          <a href="https://www.patreon.com/c/MythicaMachina" target="_blank" rel="noopener noreferrer">Patreon</a>.
        </p>
      </div>
    `;

    const action = await new Promise((resolve) => {
      new Dialog({
        title: 'Map Shine Stability Warning',
        content,
        buttons: {
          continue: {
            icon: '<i class="fas fa-check"></i>',
            label: 'Continue',
            callback: () => resolve('continue')
          },
          dismiss: {
            icon: '<i class="fas fa-eye-slash"></i>',
            label: "Don't Show Again",
            callback: () => resolve('dismiss')
          }
        },
        default: 'continue',
        close: () => resolve('continue')
      }).render(true);
    });

    if (action === 'dismiss') {
      await game?.settings?.set?.(MODULE_ID, 'dismissExperimentalWarning', true);
    }
  } catch (_) {
  }
}

function _installGlobalPasswordManagerInsertGuard() {
  try {
    if (window.__msaGlobalPasswordManagerInsertGuardInstalled) return;
    window.__msaGlobalPasswordManagerInsertGuardInstalled = true;

    const wrapNodeInsertMethod = (name) => {
      try {
        const original = Node.prototype?.[name];
        if (typeof original !== 'function') return;

        Node.prototype[name] = function(...args) {
          const result = original.apply(this, args);
          try {
            const insertedNode = (name === 'replaceChild') ? args?.[0] : args?.[0];
            _applyPasswordManagerIgnores(insertedNode);
          } catch (_) {
          }
          return result;
        };
      } catch (_) {
      }
    };

    wrapNodeInsertMethod('appendChild');
    wrapNodeInsertMethod('insertBefore');
    wrapNodeInsertMethod('replaceChild');

    try {
      const originalInsertAdjacentHTML = Element.prototype?.insertAdjacentHTML;
      if (typeof originalInsertAdjacentHTML === 'function') {
        Element.prototype.insertAdjacentHTML = function(position, text) {
          const result = originalInsertAdjacentHTML.call(this, position, text);
          try {
            if (typeof text === 'string' && /<(input|textarea|select|form)\b/i.test(text)) {
              _applyPasswordManagerIgnores(this);
            }
          } catch (_) {
          }
          return result;
        };
      }
    } catch (_) {
    }

    try {
      const existingFields = document.querySelectorAll?.('input, textarea, select, form');
      if (existingFields && existingFields.length) {
        for (const field of existingFields) {
          _setPasswordManagerIgnoreAttributes(field);
        }
      }
    } catch (_) {
    }
  } catch (_) {
  }
}

function _setPasswordManagerIgnoreAttributes(el) {
  try {
    if (!(el instanceof Element)) return;
    if (!el.matches('input, textarea, select, form')) return;

    el.setAttribute('data-bwignore', 'true');
    el.setAttribute('data-1p-ignore', 'true');
    el.setAttribute('data-lpignore', 'true');
    el.setAttribute('autocomplete', 'off');
  } catch (_) {
  }
}

function _applyPasswordManagerIgnores(root) {
  try {
    if (!root) return;

    const rootNode = root?.jquery ? root[0] : root;
    if (!(rootNode instanceof Element || rootNode instanceof Document || rootNode instanceof DocumentFragment)) return;

    if (rootNode instanceof Element) {
      _setPasswordManagerIgnoreAttributes(rootNode);
    }

    const fields = rootNode.querySelectorAll?.('input, textarea, select, form');
    if (!fields || !fields.length) return;
    for (const field of fields) {
      _setPasswordManagerIgnoreAttributes(field);
    }
  } catch (_) {
  }
}

function _installTokenHudPasswordManagerGuard() {
  try {
    if (window.__msaTokenHudPasswordManagerGuardInstalled) return;
    window.__msaTokenHudPasswordManagerGuardInstalled = true;

    const observer = new MutationObserver((mutations) => {
      try {
        for (const mutation of mutations) {
          const added = mutation?.addedNodes;
          if (!added || !added.length) continue;

          for (const node of added) {
            if (!(node instanceof Element)) continue;

            const hudRoot =
              (node.id === 'token-hud' ? node : null)
              ?? node.closest?.('#token-hud')
              ?? node.querySelector?.('#token-hud')
              ?? null;

            if (hudRoot) {
              _applyPasswordManagerIgnores(hudRoot);
              continue;
            }

            if (node.matches?.('input, textarea, select, form')) {
              const isHudField = !!node.closest?.('#token-hud');
              if (isHudField) _setPasswordManagerIgnoreAttributes(node);
            }
          }
        }
      } catch (_) {
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    window.__msaTokenHudPasswordManagerObserver = observer;

    const existingHud = document.getElementById('token-hud');
    if (existingHud) {
      _applyPasswordManagerIgnores(existingHud);
    }
  } catch (_) {
  }
}


/**
 * Module-level cache of msa-data.json sidecars keyed by module ID.
 * Populated during the ready hook so it is available synchronously in preImportAdventure.
 * @type {Map<string, object>}
 */
const _msaSidecars = new Map();

/**
 * Module-scoped set tracking scene IDs that were successfully injected with MSA
 * flags during the preImportAdventure hook. The importAdventure post-hook reads
 * this to know which scenes to auto-enable, regardless of whether the flags
 * actually survived the Adventure round-trip on their own.
 * @type {Set<string>}
 */
const _injectedSceneIds = new Set();

/**
 * Auto-capture MSA scene/tile flags into the Adventure's top-level flags during
 * export. Adventure top-level flags are a standard DocumentFlagsField at the
 * document root — NOT wrapped inside EmbeddedDataField — so they survive the
 * compendium round-trip even when embedded scene flags are stripped.
 *
 * Called from preUpdateAdventure / preCreateAdventure hooks. Modifies the
 * `changes` object in-place so the captured config is persisted alongside the
 * Adventure document.
 *
 * @param {Adventure} adventure  The Adventure document being saved
 * @param {object} changes       The update/create payload (modified in-place)
 */
function _autoCaptureMSASceneFlags(adventure, changes) {
  try {
    const NS = 'map-shine-advanced';
    const scenes = changes.scenes;
    if (!Array.isArray(scenes) || scenes.length === 0) return;

    const sceneConfig = {};
    let capturedCount = 0;

    for (const sceneData of scenes) {
      const sceneId = sceneData._id ?? sceneData.id;
      if (!sceneId) continue;

      const msaFlags = sceneData.flags?.[NS];
      if (!msaFlags || typeof msaFlags !== 'object') continue;
      // Skip scenes that only have trivial/empty MSA flags.
      if (Object.keys(msaFlags).length === 0) continue;

      // Build config entry with scene name (for fallback matching) and flags.
      const entry = {
        name: sceneData.name ?? null,
        flags: { [NS]: { ...msaFlags } }
      };

      // Capture tile-level MSA flags.
      if (Array.isArray(sceneData.tiles)) {
        const tiles = {};
        for (const tile of sceneData.tiles) {
          const tileId = tile._id ?? tile.id;
          const tileMsaFlags = tile.flags?.[NS];
          if (tileId && tileMsaFlags && typeof tileMsaFlags === 'object' && Object.keys(tileMsaFlags).length > 0) {
            tiles[tileId] = { flags: { [NS]: { ...tileMsaFlags } } };
          }
        }
        if (Object.keys(tiles).length > 0) entry.tiles = tiles;
      }

      sceneConfig[sceneId] = entry;
      capturedCount++;
    }

    if (capturedCount === 0) return;

    // Merge into the Adventure's top-level flags in the update payload.
    changes.flags ??= {};
    changes.flags[NS] ??= {};
    changes.flags[NS].sceneConfig = sceneConfig;

    console.log(`Map Shine: auto-captured MSA config for ${capturedCount} scene(s) into Adventure top-level flags`);
  } catch (e) {
    console.warn('Map Shine: failed to auto-capture scene flags during Adventure export:', e);
  }
}


/**
 * Inject MSA scene/tile flags into Adventure import data.
 * Called synchronously from the preImportAdventure hook.
 *
 * Source code analysis indicates flags SHOULD survive the EmbeddedDataField
 * round-trip (DocumentFlagsField validates via regex, our ID passes). This
 * injection serves as a belt-and-suspenders fallback. Two sources are tried:
 *
 * 1. Adventure top-level flags (`adventure.flags['map-shine-advanced'].sceneConfig`):
 *    Written by the map author via a developer console snippet. Self-contained inside
 *    the Adventure pack — no extra files or HTTP requests required.
 *
 * 2. Sidecar JSON file (`modules/{id}/packs/msa-data.json`):
 *    A fallback for map authors who prefer a separate file over Adventure flag storage.
 *    Pre-fetched during the ready hook and cached in _msaSidecars.
 *
 * @param {Adventure} adventure   The Adventure document being imported
 * @param {object} toCreate       Map of documentName → array of create payloads
 * @param {object} toUpdate       Map of documentName → array of update payloads
 */
function _injectMSASidecarData(adventure, toCreate, toUpdate) {
  try {
    const NS = 'map-shine-advanced';

    // --- Source 1: Adventure's own top-level flags (preferred) ---
    // The Adventure document's flags are a top-level DocumentFlagsField and are NOT
    // wrapped inside EmbeddedDataField, so they survive the pack serialization cycle.
    // Map authors write to this via: adv.setFlag('map-shine-advanced', 'sceneConfig', {...})
    let sceneConfig = adventure.flags?.[NS]?.sceneConfig ?? null;
    let configSource = 'adventure-flags';

    // --- Source 2: Pre-fetched sidecar JSON file (fallback) ---
    if (!sceneConfig) {
      const pack = game.packs.get(adventure.pack);
      const moduleId = pack?.metadata?.packageName ?? null;
      if (moduleId && pack?.metadata?.packageType === 'module') {
        const sidecar = _msaSidecars.get(moduleId);
        if (sidecar?.scenes && typeof sidecar.scenes === 'object') {
          sceneConfig = sidecar.scenes;
          configSource = `sidecar(${moduleId})`;
        }
      }
    }

    if (!sceneConfig || typeof sceneConfig !== 'object') return;

    // Build a name→config lookup for fallback matching when scene IDs don't match
    // (IDs can change if the Adventure was re-created or the scene was duplicated).
    const configByName = new Map();
    for (const [id, cfg] of Object.entries(sceneConfig)) {
      const name = cfg?.name ?? cfg?.flags?.[NS]?.name;
      if (name) configByName.set(name.toLowerCase().trim(), cfg);
    }

    for (const collection of [toCreate, toUpdate]) {
      for (const sceneData of (collection?.Scene ?? [])) {
        const sceneId = sceneData._id ?? sceneData.id;
        let sidecarScene = sceneConfig[sceneId] ?? null;

        // Fallback: match by scene name if ID lookup missed.
        if (!sidecarScene && sceneData.name) {
          sidecarScene = configByName.get(sceneData.name.toLowerCase().trim()) ?? null;
          if (sidecarScene) {
            console.log(`Map Shine: ID lookup missed for scene "${sceneData.name}", matched by name instead`);
          }
        }
        if (!sidecarScene) continue;

        // Inject scene-level MSA flags, merging over any existing data.
        if (sidecarScene.flags?.[NS] && typeof sidecarScene.flags[NS] === 'object') {
          sceneData.flags ??= {};
          sceneData.flags[NS] = Object.assign({}, sceneData.flags[NS] ?? {}, sidecarScene.flags[NS]);
        }

        // Inject tile-level MSA flags.
        if (sidecarScene.tiles && typeof sidecarScene.tiles === 'object') {
          for (const tile of (sceneData.tiles ?? [])) {
            const tileId = tile._id ?? tile.id;
            const sidecarTile = sidecarScene.tiles[tileId];
            if (!sidecarTile?.flags?.[NS]) continue;
            tile.flags ??= {};
            tile.flags[NS] = Object.assign({}, tile.flags[NS] ?? {}, sidecarTile.flags[NS]);
          }
        }

        // Track this scene so the importAdventure post-hook can auto-enable it.
        _injectedSceneIds.add(sceneId);
        console.log(`Map Shine: injected MSA config [${configSource}] into scene "${sceneData.name ?? sceneId}"`);
      }
    }
  } catch (e) {
    console.warn('Map Shine: preImportAdventure injection failed:', e);
  }
}

function getPlayerLightEffectInstance() {
  try {
    return (
      window.MapShine?.playerLightEffectV2
      ?? window.MapShine?.floorCompositorV2?._playerLightEffect
      ?? window.MapShine?.playerLightEffect
      ?? null
    );
  } catch (_) {
    return null;
  }
}

_suppressDiagConsoleLogs();
_installGlobalPasswordManagerInsertGuard();

function _msaCrisisLog(id, message) {
  try {
    const n = String(id).padStart(3, '0');
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

    const allFlagsSize = _msaCrisisSafeJsonSize(flags);
    const msaFlagsSize = _msaCrisisSafeJsonSize(msaFlags);

    try {
      const perModule = [];
      for (const [modId, modFlags] of Object.entries(flags ?? {})) {
        const sz = _msaCrisisSafeJsonSize(modFlags);
        if (typeof sz === 'number') perModule.push({ modId, sz });
      }
      perModule.sort((a, b) => b.sz - a.sz);
      const top = perModule.slice(0, 12);
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
      } else {
      }
    } catch (_) {
    }

  } catch (e) {
  }
}

_msaCrisisLog(1, 'module.js: module evaluation started');

try {
} catch (_) {
}

// -- diagnostic kill-switch cleanup --
// These localStorage flags were temporary debugging measures during the
// 0%/98% load-stall investigation. They are now treated as deprecated and
// are forcibly cleared on startup so they cannot silently break rendering.
try {
  globalThis.localStorage?.removeItem?.('msa-disable-texture-loading');
} catch (_) {}
try {
  globalThis.localStorage?.removeItem?.('msa-disable-water-effect');
} catch (_) {}

// Some older builds (or other modules) may re-set these keys during early
// startup. Scrub them for a few seconds so the session is reliably unblocked.
try {
  if (!globalThis.__msaDeprecatedKillSwitchScrubInstalled) {
    globalThis.__msaDeprecatedKillSwitchScrubInstalled = true;
    let remaining = 10;
    const scrub = () => {
      try { globalThis.localStorage?.removeItem?.('msa-disable-texture-loading'); } catch (_) {}
      try { globalThis.localStorage?.removeItem?.('msa-disable-water-effect'); } catch (_) {}
      remaining--;
      if (remaining > 0) setTimeout(scrub, 500);
    };
    setTimeout(scrub, 0);
  }
} catch (_) {}

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
      } catch (_) {
      }
    });

    window.addEventListener('unhandledrejection', (ev) => {
      try {
        const reason = ev?.reason;
        const msg = (reason && typeof reason === 'object' && 'message' in reason) ? reason.message : String(reason);
        const stack = reason?.stack ?? null;
        _msaCrisisLog(6, `window.onunhandledrejection: ${msg}`);
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
// PIXI/Three diagnostics: replaced when suppression / compositor run (see canvas-replacement, FloorCompositor).
MapShine.__pixiVisibilityState = MapShine.__pixiVisibilityState ?? {
  note: 'Awaiting _enforceGameplayPixiSuppression (MSA scene + canvas ready).',
};
MapShine.__pixiWorldCompositeMapping = MapShine.__pixiWorldCompositeMapping ?? {
  active: false,
  note: 'Awaiting V2 FloorCompositor._compositePixiWorldOverlay (non-V2 builds never set this).',
};
MapShine.__pixiBridgeCompositeStatus = MapShine.__pixiBridgeCompositeStatus ?? {
  note: 'Last world-overlay composite attempt (updated every time compositor evaluates the pass).',
};
// Default runtime policy: keep Foundry native PIXI overlays on top and avoid
// extra PIXI extraction/compositing unless explicitly enabled for diagnostics.
MapShine.__usePixiContentLayerBridge = false;
MapShine.__useThreeTemplateOverlays = false;
MapShine.loadingScreenService = MapShine.loadingScreenService ?? null;
MapShine.debugLoadingProfiler = MapShine.debugLoadingProfiler ?? null;
MapShine.applyPasswordManagerIgnores = _applyPasswordManagerIgnores;
MapShine.installTokenHudPasswordManagerGuard = _installTokenHudPasswordManagerGuard;
MapShine.installGlobalPasswordManagerInsertGuard = _installGlobalPasswordManagerInsertGuard;

_msaCrisisLog(4, 'module.js: MapShine state exposed on window');

/**
 * Foundry VTT 'init' hook - Called when Foundry initializes
 * Used for early setup like settings registration
 */
Hooks.once('init', async function() {
  _msaCrisisLog(10, "Hooks.once('init'): handler entered");
  _installGlobalPasswordManagerInsertGuard();

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
          // Diagnostic logging removed intentionally.
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
          _msaCrisisInspectScene(game?.scenes?.active ?? canvas?.scene ?? null, 'ready');
        } catch (_) {}
      });

      _msaCrisisLog(358, 'init: corruption diagnostics hooks installed');
    }
  } catch (_) {
  }

  // Register keybindings SYNCHRONOUSLY before any await. Foundry's hook system
  // does not await async handlers -- after the first yield, Foundry considers the
  // init phase complete and rejects late keybinding registrations with:
  // "You cannot register a Keybinding after the init hook"
  try {
    registerLevelNavigationKeybindings(MODULE_ID);
    _msaCrisisLog(9, 'init: registerLevelNavigationKeybindings() completed (pre-await)');
  } catch (e) {
    console.warn('Map Shine: failed to register level navigation keybindings', e);
    _msaCrisisLog(9, 'init: registerLevelNavigationKeybindings() threw (pre-await)');
  }

  const [{ info }, sceneSettings, canvasReplacement, { registerUISettings }, loadingService, debugLoadingProfilerMod] = await Promise.all([
    import('./core/log.js'),
    import('./settings/scene-settings.js'),
    import('./foundry/canvas-replacement.js'),
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
    loadingOverlay.showBlack('Initializing...');
    _msaCrisisLog(19, 'init: loadingOverlay.showBlack() completed');
  } catch (e) {
    console.warn('Map Shine: failed to initialize loading overlay', e);
    _msaCrisisLog(20, 'init: loadingOverlay.showBlack() threw');
  }


  console.log("%c GNU Terry Pratchett %c \n\"A man is not dead while his name is still spoken.\"",
  "background: #313131ff; color: #FFD700; font-weight: bold; padding: 4px 8px; border-radius: 4px;",
  "color: #888; font-style: italic;"
);

  // Keybinding registration moved before the first await (see above).
  _msaCrisisLog(21, 'init: keybinding registration already done (pre-await)');
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

      // Keep Light layer Fog reset wired even when scene controls are rebuilt.
      // Foundry core behavior is canvas.fog.reset(); we also clear the V2 fog
      // accumulation buffer immediately for visual parity before socket roundtrip.
      //
      // IMPORTANT: Foundry already registers a native 'reset' tool in the lighting
      // controls. ensureTool() only adds if absent, so our callback would never
      // run. We must REPLACE the existing tool to intercept the button click.
      if (isGM) {
        const lightingControls = getControl('lighting');
        if (lightingControls?.tools) {
          const _resetTool = {
            name: 'reset',
            order: 4,
            title: 'CONTROLS.LightReset',
            icon: 'fa-solid fa-cloud',
            button: true,
            onChange: () => {
              const _runFogReset = async () => {
                // Immediately clear V2 fog accumulation buffers for visual
                // parity before the socket roundtrip completes. The socket
                // handler in FogOfWarEffectV2 also resets on the server
                // broadcast, so this is an optimistic pre-clear only.
                try {
                  const fogEffect = window.MapShine?.floorCompositorV2?._fogEffect ?? null;
                  if (fogEffect && typeof fogEffect.resetExploration === 'function') {
                    fogEffect.resetExploration();
                  }
                } catch (_) {
                  // Fall through to Foundry authoritative reset.
                }
                await canvas?.fog?.reset?.();
              };

              const _content = `<p>${game.i18n.localize('CONTROLS.FOWResetDesc')}</p>`;
              const _dialogV2Confirm = globalThis?.DialogV2?.confirm
                ?? globalThis?.foundry?.applications?.api?.DialogV2?.confirm;

              if (typeof _dialogV2Confirm === 'function') {
                _dialogV2Confirm({
                  window: { title: 'CONTROLS.FOWResetTitle', icon: 'fa-solid fa-cloud' },
                  content: _content,
                  yes: { callback: _runFogReset }
                });
                return;
              }

              Dialog.confirm({
                title: game.i18n.localize('CONTROLS.FOWResetTitle'),
                content: _content,
                yes: _runFogReset
              });
            }
          };
          // Replace any existing native 'reset' tool rather than only adding
          // when absent — Foundry's built-in reset tool already occupies this
          // slot and would otherwise shadow our V2-aware callback.
          if (Array.isArray(lightingControls.tools)) {
            const _idx = lightingControls.tools.findIndex((t) => t?.name === 'reset');
            if (_idx >= 0) lightingControls.tools[_idx] = _resetTool;
            else lightingControls.tools.push(_resetTool);
          } else if (typeof lightingControls.tools === 'object') {
            lightingControls.tools['reset'] = _resetTool;
          }
        }
      }

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
        name: 'map-shine-graphics-options',
        title: 'Map Shine Graphics Options',
        icon: 'fas fa-desktop',
        button: true,
        order: 103,
        visible: true,
        toolclip: {
          src: '',
          heading: 'MAPSHINE.ToolTitle',
          items: [{ paragraph: 'Open per-client graphics options' }]
        },
        onChange: () => {
          const graphicsSettings = window.MapShine?.graphicsSettings;
          if (!graphicsSettings || typeof graphicsSettings.toggle !== 'function') {
            ui.notifications?.warn?.('Map Shine Graphics Options are not available yet. The scene may still be initializing.');
            return;
          }
          graphicsSettings.toggle();
        }
      });

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

          const playerLightEffect = getPlayerLightEffectInstance();
          if (!playerLightEffect?.enabled) {
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

          const playerLightEffect = getPlayerLightEffectInstance();
          if (playerLightEffect && !playerLightEffect.enabled) {
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

  Hooks.on('renderTokenHUD', (app, html) => {
    _msaCrisisLog(38, 'init: renderTokenHUD hook fired');
    try {
      _installTokenHudPasswordManagerGuard();

      const root = html?.jquery ? html[0] : html;
      if (root) {
        _applyPasswordManagerIgnores(root);
        // Token HUD can add/update form controls asynchronously after initial render.
        setTimeout(() => _applyPasswordManagerIgnores(root), 0);
        setTimeout(() => _applyPasswordManagerIgnores(root), 50);
        setTimeout(() => _applyPasswordManagerIgnores(root), 200);
      }
    } catch (e) {
      console.error('Map Shine: failed to inject password manager bypass into TokenHUD', e);
      _msaCrisisLog(39, 'init: renderTokenHUD threw');
    }
  });

  // Adventure EXPORT hooks: auto-capture MSA scene/tile flags into the Adventure's
  // top-level flags whenever an Adventure is created or updated (e.g. via the
  // AdventureExporter). Top-level Adventure flags survive the compendium round-trip
  // even when embedded scene flags are stripped by EmbeddedDataField cleaning.
  // This makes the preImportAdventure injection automatic — no manual console
  // snippets or sidecar JSON files required.
  Hooks.on('preUpdateAdventure', (adventure, changes, options, userId) => {
    _autoCaptureMSASceneFlags(adventure, changes);
  });
  Hooks.on('preCreateAdventure', (document, data, options, userId) => {
    _autoCaptureMSASceneFlags(document, data);
  });

  // Adventure pre-import hook: diagnostic logging + safety-net injection.
  // Reads MSA config from Adventure top-level flags (auto-captured during export)
  // or sidecar JSON, and injects it into the scene payloads before creation.
  Hooks.on('preImportAdventure', (adventure, options, toCreate, toUpdate) => {
    try {
      // Layer 5: Diagnostic logging to verify whether flags survive Adventure export.
      const NS = 'map-shine-advanced';
      for (const sceneData of (toCreate?.Scene ?? [])) {
        const msaFlags = sceneData.flags?.[NS];
        const flagKeys = msaFlags ? Object.keys(msaFlags) : [];
        console.log(
          `Map Shine DIAG: preImport CREATE scene "${sceneData.name ?? '?'}" (${sceneData._id ?? '?'})`,
          'MSA flags present:', !!msaFlags,
          'keys:', flagKeys.length ? flagKeys.join(', ') : 'none'
        );
      }
      for (const sceneData of (toUpdate?.Scene ?? [])) {
        const msaFlags = sceneData.flags?.[NS];
        const flagKeys = msaFlags ? Object.keys(msaFlags) : [];
        console.log(
          `Map Shine DIAG: preImport UPDATE scene "${sceneData.name ?? '?'}" (${sceneData._id ?? '?'})`,
          'MSA flags present:', !!msaFlags,
          'keys:', flagKeys.length ? flagKeys.join(', ') : 'none'
        );
      }
    } catch (_) {}

    // Layer 4: Safety-net injection from Adventure flags or sidecar file.
    try {
      _injectMSASidecarData(adventure, toCreate, toUpdate);
    } catch (_) {}
  });

  // Layer 3: Post-import verification — auto-enable imported scenes that were
  // injected with MSA flags during preImportAdventure, or that carry surviving
  // MSA authoring data. Uses _injectedSceneIds (populated by _injectMSASidecarData)
  // as the primary detection mechanism, with hasImpliedMapShineConfig as fallback.
  Hooks.on('importAdventure', (adventure, formData, created, updated) => {
    try {
      const NS = 'map-shine-advanced';
      const scenes = [...(created?.Scene ?? []), ...(updated?.Scene ?? [])];
      for (const scene of scenes) {
        const sceneId = scene.id ?? scene._id;
        const wasInjected = _injectedSceneIds.has(sceneId);
        const hasImplied = sceneSettings.hasImpliedMapShineConfig(scene);

        if (!wasInjected && !hasImplied) continue;

        const enabled = scene.getFlag(NS, 'enabled');
        if (enabled !== true) {
          scene.setFlag(NS, 'enabled', true).catch(() => {});
          const reason = wasInjected ? 'injected during preImport' : 'has implied MSA config';
          console.log(`Map Shine: auto-enabled imported scene "${scene.name}" (${reason})`);
        } else {
          console.log(`Map Shine: imported scene "${scene.name}" already has enabled=true`);
        }
      }

      // Clear the tracking set after processing.
      _injectedSceneIds.clear();
    } catch (e) {
      console.warn('Map Shine: importAdventure post-hook failed:', e);
      _injectedSceneIds.clear();
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
        if (typeof showExperimentalWarningDialog === 'function') void showExperimentalWarningDialog();
      } catch (_) {
      }
    }, 250);
    _msaCrisisLog(43, 'ready: experimental warning timeout scheduled');
  } catch (_) {
    _msaCrisisLog(44, 'ready: failed to schedule experimental warning timeout');
  }

  try {
    _msaCrisisLog(45, 'ready: loadingOverlay.setMessage(Preparing renderer...) about to run');
    loadingOverlay.setMessage('Preparing renderer...');
    _msaCrisisLog(46, 'ready: loadingOverlay.setMessage completed');
  } catch (e) {
    console.warn('Map Shine: failed to update loading overlay', e);
    _msaCrisisLog(47, 'ready: loadingOverlay.setMessage threw');
  }
  // Run bootstrap sequence -- wrapped in try/catch so a failed import (e.g.
  // game-system.js 404) doesn't silently hang createThreeCanvas forever.
  _msaCrisisLog(48, 'ready: importing bootstrap + LoadingScreenManager');
  let bootstrap = null;
  let LoadingScreenManager = null;
  try {
    _msaCrisisLog(48.1, 'ready: importing bootstrap.js...');
    const bsMod = await import('./core/bootstrap.js');
    bootstrap = bsMod.bootstrap;
    _msaCrisisLog(48.2, 'ready: bootstrap.js imported, importing loading-screen-manager.js...');
    const lsmMod = await import('./ui/loading-screen/loading-screen-manager.js');
    LoadingScreenManager = lsmMod.LoadingScreenManager;
    _msaCrisisLog(49, 'ready: bootstrap + LoadingScreenManager imports resolved');
  } catch (importErr) {
    console.error('Map Shine: failed to import bootstrap or LoadingScreenManager', importErr);
    _msaCrisisLog(49, `ready: import FAILED (${importErr?.message ?? 'unknown'}) -- marking bootstrapComplete`);
    MapShine.bootstrapComplete = true;
    MapShine.bootstrapError = importErr?.message ?? 'import failed';
    return; // nothing more we can do without bootstrap
  }

  _msaCrisisLog(50, 'ready: calling bootstrap({verbose:false})');
  let state = null;
  try {
    state = await bootstrap({ verbose: false });
  } catch (bootstrapErr) {
    console.error('Map Shine: failed to run bootstrap', bootstrapErr);
    _msaCrisisLog(51, `ready: bootstrap FAILED (${bootstrapErr?.message ?? 'unknown'}) -- marking bootstrapComplete`);
    MapShine.bootstrapComplete = true;
    MapShine.bootstrapError = bootstrapErr?.message ?? 'bootstrap failed';
    return; // nothing more we can do without bootstrap
  }

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
      info('No active scene -- dismissing loading overlay');
      loadingOverlay.fadeIn(500).catch(() => {});
      _msaCrisisLog(58, 'ready: loadingOverlay.fadeIn(500) invoked for no-scene case');
    }
  } catch (e) {
    console.warn('Map Shine: failed to dismiss overlay for no-scene case', e);
    _msaCrisisLog(59, 'ready: no-scene overlay dismissal threw');
  }
});
