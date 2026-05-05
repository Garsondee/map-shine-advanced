/**
 * @fileoverview Resolve whether players may use each Player Light mode from token palette tools.
 * Combines per-scene controlState.playerLightAllowance with world global defaults.
 * @module core/player-light-allowance
 */

import { isGmLike } from './gm-parity.js';

export const MODULE_ID = 'map-shine-advanced';

/** @typedef {'torch'|'flashlight'|'nightVision'} PlayerLightMode */

const VALID_MODES = new Set(['torch', 'flashlight', 'nightVision']);
const VALID_OVERRIDE = new Set(['global', 'allowed', 'disallowed']);

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
 * @returns {{ torch: string, flashlight: string, nightVision: string }}
 */
export function getPlayerLightAllowanceFromControlState(controlState) {
  const defaults = { torch: 'global', flashlight: 'global', nightVision: 'global' };
  const pa = controlState?.playerLightAllowance;
  if (!pa || typeof pa !== 'object') return { ...defaults };
  return {
    torch: normalizePlayerLightOverride(pa.torch),
    flashlight: normalizePlayerLightOverride(pa.flashlight),
    nightVision: normalizePlayerLightOverride(pa.nightVision)
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
 * GM may always toggle; players follow resolvePlayerLightModeAllowance.
 * @param {PlayerLightMode} mode
 * @param {{ scene?: Scene|null, controlState?: object|null, tokenDoc?: TokenDocument|null }} [options]
 * @returns {boolean}
 */
export function isPlayerLightModeAllowedForUser(mode, options = {}) {
  if (isGmLike()) return true;
  return resolvePlayerLightModeAllowance(mode, options);
}
