/**
 * @fileoverview Levels runtime compatibility/interop guards.
 *
 * Map Shine's gameplay renderer is the runtime authority for visibility, fog,
 * and render layering. This module centralizes:
 * - compatibility mode setting reads,
 * - detection of active Levels runtime takeover signals,
 * - authority enforcement in gameplay mode,
 * - warning message formatting.
 */

import { createLogger } from '../core/log.js';

const log = createLogger('LevelsCompatibility');

const MODULE_ID = 'map-shine-advanced';
const LEVELS_MODULE_ID = 'levels';

export const LEVELS_COMPATIBILITY_SETTING_KEY = 'levelsCompatibilityMode';

export const LEVELS_COMPATIBILITY_MODES = Object.freeze({
  OFF: 'off',
  IMPORT_ONLY: 'import-only',
  DIAGNOSTIC_INTEROP: 'diagnostic-interop',
});

function _normalizeMode(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === LEVELS_COMPATIBILITY_MODES.OFF) return LEVELS_COMPATIBILITY_MODES.OFF;
  if (v === LEVELS_COMPATIBILITY_MODES.DIAGNOSTIC_INTEROP) return LEVELS_COMPATIBILITY_MODES.DIAGNOSTIC_INTEROP;
  return LEVELS_COMPATIBILITY_MODES.IMPORT_ONLY;
}

function _getClassName(value) {
  if (!value) return null;
  if (typeof value === 'function' && value.name) return value.name;
  if (value?.constructor?.name) return value.constructor.name;
  return null;
}

function _getCoreFogManagerClass() {
  return globalThis.foundry?.canvas?.perception?.FogManager || null;
}

function _getConfiguredFogManagerClass() {
  return globalThis.CONFIG?.Canvas?.fogManager || null;
}

/**
 * Read the currently configured Levels compatibility mode.
 * @returns {'off'|'import-only'|'diagnostic-interop'}
 */
export function getLevelsCompatibilityMode() {
  try {
    const raw = game?.settings?.get?.(MODULE_ID, LEVELS_COMPATIBILITY_SETTING_KEY);
    return _normalizeMode(raw);
  } catch (_) {
    return LEVELS_COMPATIBILITY_MODES.IMPORT_ONLY;
  }
}

/**
 * Detect Levels runtime takeover indicators that conflict with gameplay ownership.
 * @param {{gameplayMode?: boolean}} [options]
 * @returns {object}
 */
export function detectLevelsRuntimeInteropState(options = {}) {
  const { gameplayMode = true } = options;

  const mode = getLevelsCompatibilityMode();
  const levelsModuleActive = game?.modules?.get?.(LEVELS_MODULE_ID)?.active === true;

  const configLevels = globalThis.CONFIG?.Levels || null;
  const configLevelsPresent = !!configLevels;
  const levelsHandlersPresent = !!configLevels?.handlers;
  const levelsApiPresent = !!configLevels?.API;

  const coreFogManagerClass = _getCoreFogManagerClass();
  const configuredFogManagerClass = _getConfiguredFogManagerClass();

  const fogManagerTakeover = Boolean(
    levelsModuleActive
    && coreFogManagerClass
    && configuredFogManagerClass
    && configuredFogManagerClass !== coreFogManagerClass
  );

  const canvasFogTakeover = Boolean(
    levelsModuleActive
    && coreFogManagerClass
    && canvas?.fog
    && !(canvas.fog instanceof coreFogManagerClass)
  );

  // If Levels is active and these structures are present, wrappers are very likely registered.
  const wrappersLikelyActive = Boolean(
    levelsModuleActive
    && (levelsHandlersPresent || levelsApiPresent || configLevelsPresent)
  );

  const hasRuntimeConflict = Boolean(
    levelsModuleActive && (wrappersLikelyActive || fogManagerTakeover || canvasFogTakeover)
  );

  return {
    mode,
    gameplayMode,
    levelsModuleActive,
    wrappersLikelyActive,
    hasRuntimeConflict,
    shouldWarnInGameplay: Boolean(gameplayMode && hasRuntimeConflict),
    configLevelsPresent,
    levelsHandlersPresent,
    levelsApiPresent,
    fogManagerTakeover,
    canvasFogTakeover,
    configuredFogManagerClassName: _getClassName(configuredFogManagerClass),
    coreFogManagerClassName: _getClassName(coreFogManagerClass),
    canvasFogClassName: _getClassName(canvas?.fog),
  };
}

/**
 * Enforce Map Shine runtime ownership requirements while in gameplay mode.
 *
 * Current enforcement scope:
 * - Restore CONFIG.Canvas.fogManager to Foundry core FogManager when Levels
 *   has replaced it, so runtime authority remains Map Shine + core contracts.
 *
 * @param {{gameplayMode?: boolean}} [options]
 * @returns {object}
 */
export function enforceMapShineRuntimeAuthority(options = {}) {
  const { gameplayMode = true } = options;
  const state = detectLevelsRuntimeInteropState({ gameplayMode });

  const enforcement = {
    attempted: Boolean(gameplayMode),
    fogManagerReset: false,
  };

  if (!gameplayMode) {
    return {
      ...state,
      enforcement,
      runtimeAuthority: null,
    };
  }

  const coreFogManagerClass = _getCoreFogManagerClass();
  const configuredFogManagerClass = _getConfiguredFogManagerClass();

  if (
    state.levelsModuleActive
    && coreFogManagerClass
    && configuredFogManagerClass
    && configuredFogManagerClass !== coreFogManagerClass
  ) {
    try {
      globalThis.CONFIG.Canvas.fogManager = coreFogManagerClass;
      enforcement.fogManagerReset = true;
      log.warn(
        `Gameplay authority: restored CONFIG.Canvas.fogManager to ${_getClassName(coreFogManagerClass) || 'FogManager'}`
      );
    } catch (e) {
      log.warn('Gameplay authority: failed to restore CONFIG.Canvas.fogManager', e);
    }
  }

  return {
    ...state,
    enforcement,
    runtimeAuthority: {
      visibility: 'map-shine',
      fog: 'map-shine',
      renderLayering: 'map-shine',
    },
  };
}

// ---------------------------------------------------------------------------
//  MS-LVL-114: Known module conflict detection
// ---------------------------------------------------------------------------

/**
 * Known modules whose features may overlap with Map Shine's Levels
 * compatibility surface. Each entry has an id, description, and severity.
 * @type {ReadonlyArray<{id: string, label: string, overlap: string, severity: 'warn'|'info'}>}
 */
const KNOWN_CONFLICT_MODULES = Object.freeze([
  {
    id: 'elevatedvision',
    label: 'Elevated Vision',
    overlap: 'Provides its own elevation-aware visibility and LOS. May conflict with Map Shine wall-height filtering and elevation-based token visibility.',
    severity: 'warn',
  },
  {
    id: 'wall-height',
    label: 'Wall Height',
    overlap: 'Map Shine reads wall-height flags natively. Having Wall Height active is safe for flag authoring but its runtime patches may double-filter walls in LOS computation.',
    severity: 'info',
  },
  {
    id: 'enhanced-terrain-layer',
    label: 'Enhanced Terrain Layer',
    overlap: 'May conflict with Map Shine movement collision and pathfinding elevation handling.',
    severity: 'info',
  },
  {
    id: 'levels-3d-preview',
    label: 'Levels 3D Preview',
    overlap: 'Template/measurement 3D payloads are guarded in Map Shine template defaults. Runtime 3D rendering is not expected to conflict.',
    severity: 'info',
  },
  {
    id: 'betterroofs',
    label: 'Better Roofs',
    overlap: 'Map Shine has its own overhead/roof tile layering system. Better Roofs may fight over tile visibility states.',
    severity: 'warn',
  },
]);

/**
 * Detect known module conflicts relevant to Levels compatibility.
 * Returns an array of conflict entries for any active modules that overlap
 * with Map Shine's elevation/visibility/collision features.
 *
 * @returns {Array<{id: string, label: string, overlap: string, severity: string, active: boolean}>}
 */
export function detectKnownModuleConflicts() {
  const results = [];
  for (const mod of KNOWN_CONFLICT_MODULES) {
    const isActive = game?.modules?.get?.(mod.id)?.active === true;
    if (isActive) {
      results.push({ ...mod, active: true });
    }
  }
  return results;
}

/**
 * Emit one-time console warnings for detected module conflicts.
 * Called during gameplay initialization so GMs see relevant warnings.
 */
let _conflictWarningsEmitted = false;

export function emitModuleConflictWarnings() {
  if (_conflictWarningsEmitted) return;
  _conflictWarningsEmitted = true;

  const mode = getLevelsCompatibilityMode();
  if (mode === LEVELS_COMPATIBILITY_MODES.OFF) return;

  const conflicts = detectKnownModuleConflicts();
  if (conflicts.length === 0) return;

  for (const conflict of conflicts) {
    const prefix = `[Map Shine Levels Compat] ${conflict.label} (${conflict.id}):`;
    if (conflict.severity === 'warn') {
      log.warn(`${prefix} ${conflict.overlap}`);
    } else {
      log.info(`${prefix} ${conflict.overlap}`);
    }
  }

  // Surface a single UI notification if any warn-level conflicts exist
  const warnConflicts = conflicts.filter((c) => c.severity === 'warn');
  if (warnConflicts.length > 0 && game?.user?.isGM) {
    const names = warnConflicts.map((c) => c.label).join(', ');
    ui?.notifications?.warn?.(
      `Map Shine: Potential compatibility overlap detected with ${names}. Check the Diagnostic Center for details.`,
      { permanent: false }
    );
  }
}

/**
 * Build a user-facing warning message when Levels runtime interop is detected.
 * @param {object} state
 * @returns {string}
 */
export function formatLevelsInteropWarning(state) {
  const mode = _normalizeMode(state?.mode);
  const modeLabel = mode === LEVELS_COMPATIBILITY_MODES.DIAGNOSTIC_INTEROP
    ? 'diagnostic-interop'
    : (mode === LEVELS_COMPATIBILITY_MODES.OFF ? 'off' : 'import-only');

  return [
    'Map Shine detected active Levels runtime wrappers in gameplay mode.',
    `Map Shine remains the runtime authority (mode: ${modeLabel}).`,
    'For best stability, use import-only workflows and avoid dual runtime control.',
  ].join(' ');
}
