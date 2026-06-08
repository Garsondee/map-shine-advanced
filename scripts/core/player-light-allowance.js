/**
 * @fileoverview Resolve whether players may use each Player Light mode from token palette tools.
 * Combines per-scene controlState.playerLightAllowance with world global defaults.
 * @module core/player-light-allowance
 */

import { isGmLike } from './gm-parity.js';

export const MODULE_ID = 'map-shine-advanced';

/** @typedef {'torch'|'flashlight'|'nightVision'|'lowLightVision'|'infravision'|'activeIR'} PlayerLightMode */

export const PLAYER_LIGHT_MODES = Object.freeze([
  'torch',
  'flashlight',
  'nightVision',
  'lowLightVision',
  'infravision',
  'activeIR'
]);

const VALID_MODES = new Set(PLAYER_LIGHT_MODES);
const VALID_OVERRIDE = new Set(['global', 'allowed', 'disallowed']);

/** Modes that use the night-vision post-pass without a visible flashlight cone. */
export const NV_ONLY_PLAYER_LIGHT_MODES = Object.freeze([
  'nightVision',
  'lowLightVision',
  'infravision'
]);

/** Modes that run the night-vision post-pass (includes Active-IR hybrid). */
export const NV_POST_PLAYER_LIGHT_MODES = Object.freeze([
  'nightVision',
  'lowLightVision',
  'infravision',
  'activeIR'
]);

/** Modes that drive flashlight beam/cookie/light-source logic. */
export const FLASHLIGHT_PLAYER_LIGHT_MODES = Object.freeze([
  'flashlight',
  'activeIR'
]);

/**
 * @returns {{ torch: string, flashlight: string, nightVision: string, lowLightVision: string, infravision: string, activeIR: string }}
 */
export function createDefaultPlayerLightAllowance() {
  return {
    torch: 'global',
    flashlight: 'global',
    nightVision: 'global',
    lowLightVision: 'global',
    infravision: 'global',
    activeIR: 'global'
  };
}

/**
 * @param {*} mode
 * @returns {mode is PlayerLightMode}
 */
export function isValidPlayerLightMode(mode) {
  return VALID_MODES.has(mode);
}

/**
 * Human-readable label for notifications.
 * @param {PlayerLightMode} mode
 * @returns {string}
 */
export function getPlayerLightAllowanceLabel(mode) {
  switch (mode) {
    case 'torch':
      return 'Torch';
    case 'flashlight':
      return 'Flashlight';
    case 'nightVision':
      return 'Night Vision';
    case 'lowLightVision':
      return 'Low-light Vision';
    case 'infravision':
      return 'Infravision';
    case 'activeIR':
      return 'Active Infravision';
    default:
      return 'Player Light';
  }
}

/**
 * Global default for a mode (world settings). Night Vision treats legacy `nightVisionAllowPlayers` as OR with the new key.
 * @param {PlayerLightMode} mode
 * @returns {boolean}
 */
export function getGlobalPlayerLightModeAllowed(mode) {
  try {
    if (mode === 'torch') {
      return !!game.settings.get(MODULE_ID, 'playerLightTorchAllowedDefault');
    }
    if (mode === 'flashlight') {
      return !!game.settings.get(MODULE_ID, 'playerLightFlashlightAllowedDefault');
    }
    if (mode === 'nightVision') {
      const modern = !!game.settings.get(MODULE_ID, 'playerLightNightVisionAllowedDefault');
      let legacy = false;
      try {
        legacy = !!game.settings.get(MODULE_ID, 'nightVisionAllowPlayers');
      } catch (_) {
        legacy = false;
      }
      return modern || legacy;
    }
    if (mode === 'lowLightVision') {
      return !!game.settings.get(MODULE_ID, 'playerLightLowLightVisionAllowedDefault');
    }
    if (mode === 'infravision') {
      return !!game.settings.get(MODULE_ID, 'playerLightInfravisionAllowedDefault');
    }
    if (mode === 'activeIR') {
      return !!game.settings.get(MODULE_ID, 'playerLightActiveIRAllowedDefault');
    }
  } catch (_) {
  }
  return false;
}

/**
 * Normalize scene override string for one mode.
 * @param {*} raw
 * @returns {'global'|'allowed'|'disallowed'}
 */
export function normalizePlayerLightOverride(raw) {
  return VALID_OVERRIDE.has(raw) ? raw : 'global';
}

/**
 * Read playerLightAllowance from control state object safely.
 * @param {*} controlState
 * @returns {ReturnType<typeof createDefaultPlayerLightAllowance>}
 */
export function getPlayerLightAllowanceFromControlState(controlState) {
  const defaults = createDefaultPlayerLightAllowance();
  const pa = controlState?.playerLightAllowance;
  if (!pa || typeof pa !== 'object') return { ...defaults };
  return {
    torch: normalizePlayerLightOverride(pa.torch),
    flashlight: normalizePlayerLightOverride(pa.flashlight),
    nightVision: normalizePlayerLightOverride(pa.nightVision),
    lowLightVision: normalizePlayerLightOverride(pa.lowLightVision),
    infravision: normalizePlayerLightOverride(pa.infravision),
    activeIR: normalizePlayerLightOverride(pa.activeIR)
  };
}

/**
 * Resolve whether a mode is allowed on the scene for players (before GM bypass).
 * @param {PlayerLightMode} mode
 * @param {{ scene?: Scene|null, controlState?: object|null }} [options]
 * @returns {boolean}
 */
export function resolvePlayerLightModeAllowance(mode, options = {}) {
  if (!isValidPlayerLightMode(mode)) return false;

  let controlState = options.controlState;
  const scene = options.scene ?? (typeof canvas !== 'undefined' ? canvas?.scene : null);

  if ((!controlState || typeof controlState !== 'object') && scene?.getFlag) {
    try {
      controlState = scene.getFlag(MODULE_ID, 'controlState');
    } catch (_) {
      controlState = null;
    }
  }

  const allowance = getPlayerLightAllowanceFromControlState(controlState);
  const override = normalizePlayerLightOverride(allowance[mode]);

  if (override === 'allowed') return true;
  if (override === 'disallowed') return false;
  return getGlobalPlayerLightModeAllowed(mode);
}

/**
 * Whether non-GMs may use player light tools at all (world master toggle).
 * @returns {boolean}
 */
export function canPlayersTogglePlayerLightMode() {
  try {
    return game.settings.get(MODULE_ID, 'allowPlayersToTogglePlayerLightMode') !== false;
  } catch (_) {
    return true;
  }
}

/**
 * Whether the Player Light palette tool should appear for the current user.
 * @returns {boolean}
 */
export function canUserAccessPlayerLightTools() {
  if (isGmLike()) return true;
  if (!canPlayersTogglePlayerLightMode()) return false;
  return PLAYER_LIGHT_MODES.some((mode) => resolvePlayerLightModeAllowance(mode));
}

/**
 * Apply player light mode to a token document.
 * @param {TokenDocument} tokenDoc
 * @param {PlayerLightMode|null} mode null = off
 * @returns {Promise<void>}
 */
export async function applyPlayerLightModeToToken(tokenDoc, mode) {
  if (!tokenDoc?.setFlag) return;
  if (!mode) {
    await tokenDoc.setFlag(MODULE_ID, 'playerLightEnabled', false);
    return;
  }
  if (!isValidPlayerLightMode(mode)) return;
  await tokenDoc.setFlag(MODULE_ID, 'playerLightEnabled', true);
  await tokenDoc.setFlag(MODULE_ID, 'playerLightMode', mode);
}

/**
 * GM may always toggle; players follow master toggle + resolvePlayerLightModeAllowance.
 * @param {PlayerLightMode} mode
 * @param {{ scene?: Scene|null, controlState?: object|null, tokenDoc?: TokenDocument|null }} [options]
 * @returns {boolean}
 */
export function isPlayerLightModeAllowedForUser(mode, options = {}) {
  if (isGmLike()) return true;
  if (!canPlayersTogglePlayerLightMode()) return false;
  return resolvePlayerLightModeAllowance(mode, options);
}
