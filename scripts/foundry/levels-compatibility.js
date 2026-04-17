/**
 * @fileoverview Levels compatibility — V14-only stub.
 *
 * V14-native levels are the sole authority. The legacy Levels module compatibility
 * layer (import-only, diagnostic-interop modes) has been removed. This file
 * retains the exported API surface so existing consumers don't break, but all
 * functions return V14-native-only answers.
 */
import { isGmLike } from '../core/gm-parity.js';
import { createLogger } from '../core/log.js';

const log = createLogger('LevelsCompatibility');

export const LEVELS_COMPATIBILITY_SETTING_KEY = 'levelsCompatibilityMode';

export const LEVELS_COMPATIBILITY_MODES = Object.freeze({
  OFF: 'off',
  IMPORT_ONLY: 'import-only',
  DIAGNOSTIC_INTEROP: 'diagnostic-interop',
});

/**
 * V14-only: always returns 'off'. Legacy compat modes removed.
 * @returns {'off'}
 */
export function getLevelsCompatibilityMode() {
  return LEVELS_COMPATIBILITY_MODES.OFF;
}

/**
 * V14-only: legacy Levels module interop detection.
 * Returns a minimal state object with all conflict flags false.
 * @param {{gameplayMode?: boolean}} [options]
 * @returns {object}
 */
export function detectLevelsRuntimeInteropState(options = {}) {
  const { gameplayMode = true } = options;
  return {
    mode: LEVELS_COMPATIBILITY_MODES.OFF,
    gameplayMode,
    levelsModuleActive: false,
    wrappersLikelyActive: false,
    hasRuntimeConflict: false,
    shouldWarnInGameplay: false,
    configLevelsPresent: false,
    levelsHandlersPresent: false,
    levelsApiPresent: false,
    fogManagerTakeover: false,
    canvasFogTakeover: false,
    configuredFogManagerClassName: null,
    coreFogManagerClassName: null,
    canvasFogClassName: null,
  };
}

/**
 * V14-only: no-op. Map Shine is always the runtime authority.
 * @param {{gameplayMode?: boolean}} [options]
 * @returns {object}
 */
export function enforceMapShineRuntimeAuthority(options = {}) {
  const { gameplayMode = true } = options;
  return {
    ...detectLevelsRuntimeInteropState({ gameplayMode }),
    enforcement: { attempted: Boolean(gameplayMode), fogManagerReset: false },
    runtimeAuthority: gameplayMode ? {
      visibility: 'map-shine',
      fog: 'map-shine',
      renderLayering: 'map-shine',
    } : null,
  };
}

/**
 * Known modules that may overlap with Map Shine features.
 * Retained for diagnostic center display.
 */
const KNOWN_CONFLICT_MODULES = Object.freeze([
  { id: 'elevatedvision', label: 'Elevated Vision', overlap: 'Provides its own elevation-aware visibility and LOS.', severity: 'warn' },
  { id: 'wall-height', label: 'Wall Height', overlap: 'Map Shine reads wall-height flags natively.', severity: 'info' },
  { id: 'betterroofs', label: 'Better Roofs', overlap: 'Map Shine has its own overhead/roof tile layering system.', severity: 'warn' },
]);

export function detectKnownModuleConflicts() {
  const results = [];
  for (const mod of KNOWN_CONFLICT_MODULES) {
    if (game?.modules?.get?.(mod.id)?.active === true) {
      results.push({ ...mod, active: true });
    }
  }
  return results;
}

let _conflictWarningsEmitted = false;

export function emitModuleConflictWarnings() {
  if (_conflictWarningsEmitted) return;
  _conflictWarningsEmitted = true;
  const conflicts = detectKnownModuleConflicts();
  if (!conflicts.length) return;
  const warns = conflicts.filter((c) => c.severity === 'warn');
  if (warns.length > 0 && isGmLike()) {
    const names = warns.map((c) => c.label).join(', ');
    ui?.notifications?.warn?.(`Map Shine: Potential overlap detected with ${names}.`, { permanent: false });
  }
}

/**
 * @deprecated V14-only: legacy interop warning formatter. Returns empty string.
 */
export function formatLevelsInteropWarning(_state) {
  return '';
}
