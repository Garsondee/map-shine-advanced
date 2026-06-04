/**
 * @fileoverview Unified effect enablement resolver.
 *
 * Replaces the scattered `effect?.enabled && effect?.params?.enabled !== false`
 * pattern with a single deterministic function. Every render pass gate in
 * FloorCompositor and every continuous-render check must call this instead of
 * inlining its own variation.
 *
 * The resolver normalizes three sources of truth:
 *   1. `effect.enabled` — runtime instance flag (set by graphics settings toggle)
 *   2. `effect.params.enabled` — scene-flag-driven parameter
 *   3. Graphics settings client override (localStorage)
 *
 * Rule: an effect renders if and only if ALL enabled sources agree it should.
 * Disabled effects MUST NOT render, even if data/uniforms exist.
 *
 * @module effects/resolve-effect-enabled
 */

import * as sceneSettings from '../settings/scene-settings.js';

/** Stylistic fullscreen passes synced from scene flags (not repopulate snapshots). */
export const STYLISTIC_EFFECT_FC_KEYS = Object.freeze([
  ['ascii', '_asciiEffect'],
  ['dotScreen', '_dotScreenEffect'],
  ['halftone', '_halftoneEffect'],
  ['visionMode', '_visionModeEffect'],
  ['invert', '_invertEffect'],
  ['sepia', '_sepiaEffect'],
  // dazzleOverlay omitted — enabled at runtime by DynamicExposureManager after updatables.
]);

/** @type {Set<string>} */
const STYLISTIC_FC_KEY_SET = new Set(STYLISTIC_EFFECT_FC_KEYS.map(([, key]) => key));

/** @type {Set<string>} */
const STYLISTIC_EFFECT_ID_SET = new Set(STYLISTIC_EFFECT_FC_KEYS.map(([id]) => id));

/**
 * @param {string} fcKey
 * @returns {boolean}
 */
export function isStylisticEffectFcKey(fcKey) {
  return STYLISTIC_FC_KEY_SET.has(fcKey);
}

/**
 * @param {string} effectId
 * @returns {boolean}
 */
export function isStylisticEffectId(effectId) {
  return STYLISTIC_EFFECT_ID_SET.has(effectId);
}

/**
 * While the Tweakpane save queue is debounced (~1s), prefer the live UI toggle so
 * per-frame sync does not stomp a just-enabled stylistic pass before scene flags flush.
 *
 * @param {string} effectId
 * @param {object|null|undefined} [uiManager]
 * @returns {boolean|null} UI authoritative value, or null when scene flags should win.
 */
function resolveStylisticPendingUiEnabled(effectId, uiManager = null) {
  const ui = uiManager ?? window.MapShine?.uiManager ?? null;
  if (!ui) return null;

  const fd = ui.effectFolders?.[effectId];
  if (!fd?.params || typeof fd.params.enabled !== 'boolean') return null;

  const dirtyKey = `${effectId}.enabled`;
  const pending =
    (ui.saveQueue && typeof ui.saveQueue.has === 'function' && ui.saveQueue.has(effectId))
    || (ui.dirtyParams && typeof ui.dirtyParams.has === 'function' && ui.dirtyParams.has(dirtyKey));

  if (!pending) return null;
  return fd.params.enabled === true;
}

/**
 * Scene-flag enablement plus debounced UI toggle authority.
 *
 * @param {string} effectId
 * @param {object} [mapMakerEffects]
 * @param {object} [gmEffects]
 * @param {object|null|undefined} [uiManager]
 * @returns {boolean}
 */
export function resolveStylisticEnabledAuthoritative(
  effectId,
  mapMakerEffects = {},
  gmEffects = {},
  uiManager = null
) {
  const sceneOn = resolveStylisticEnabled(effectId, mapMakerEffects, gmEffects);
  const ui = uiManager ?? window.MapShine?.uiManager ?? null;
  const fd = ui?.effectFolders?.[effectId];
  if (fd?.params && typeof fd.params.enabled === 'boolean') {
    const uiOn = fd.params.enabled === true;
    // Checkbox is owned by Tweakpane; when it diverges from persisted scene flags
    // (debounced save, in-flight write), runtime must follow the live UI.
    if (uiOn !== sceneOn) return uiOn;
  }
  const pendingUi = resolveStylisticPendingUiEnabled(effectId, ui);
  if (pendingUi !== null) return pendingUi;
  return sceneOn;
}

/**
 * Resolve whether a stylistic effect should be enabled from scene flags.
 * Vision mode defaults on when both branches are unset.
 *
 * @param {string} effectId
 * @param {object} [mapMakerEffects]
 * @param {object} [gmEffects]
 * @returns {boolean}
 */
export function resolveStylisticEnabled(effectId, mapMakerEffects = {}, gmEffects = {}) {
  const mmEnabled = mapMakerEffects?.[effectId]?.enabled;
  const gmEnabled = gmEffects?.[effectId]?.enabled;
  if (mmEnabled === true || gmEnabled === true) return true;

  if (effectId === 'visionMode') {
    const hasExplicitBoolean =
      mmEnabled === true || mmEnabled === false || gmEnabled === true || gmEnabled === false;
    if (!hasExplicitBoolean) return true;
  }
  return false;
}

/**
 * Apply scene-flag authoritative enablement for stylistic fullscreen passes.
 * Uses FloorCompositor.applyParam so getter/setter effects stay in sync.
 *
 * @param {object|null|undefined} floorCompositor
 * @param {object|null|undefined} [scene]
 * @param {{ syncUi?: boolean }} [options] Legacy option; UI is never overwritten here.
 *   Tweakpane owns the Enabled checkbox; rewriting `params.enabled` + refresh() each
 *   frame prevented the toggle from staying checked.
 */
export function syncStylisticEffectGate(floorCompositor, scene = null, options = {}) {
  const fc = floorCompositor;
  if (!fc || typeof fc.applyParam !== 'function') return;

  let mm = {};
  let gm = {};
  try {
    const resolvedScene = scene ?? globalThis.canvas?.scene ?? null;
    if (resolvedScene) {
      const all = sceneSettings.getSceneSettings(resolvedScene);
      mm = all?.mapMaker?.effects || {};
      gm = all?.gm?.effects || {};
    }
  } catch (_) {}

  const ui = window.MapShine?.uiManager ?? null;

  for (const [effectId, fcKey] of STYLISTIC_EFFECT_FC_KEYS) {
    let enabled = resolveStylisticEnabledAuthoritative(effectId, mm, gm, ui);
    try {
      const gsm = window.MapShine?.graphicsSettingsManager;
      // Only honor explicit client disables — not stylistic default-off semantics from
      // getEffectiveEnabled(), which would force every opt-in pass off every frame.
      if (gsm?.isExplicitlyDisabledByClient?.(effectId)) {
        enabled = false;
      }
    } catch (_) {}

    try {
      fc.applyParam(fcKey, 'enabled', enabled);
    } catch (_) {}
  }
}

/**
 * Determine the effective enabled state for a compositor effect.
 *
 * @param {Object|null|undefined} effect - The effect instance to evaluate.
 * @returns {boolean} True if the effect should be active this frame.
 */
export function resolveEffectEnabled(effect) {
  if (!effect) return false;

  // Stylistic opt-in passes (sepia, invert, halftone, …): schema default is off.
  // Undefined enabled must not activate the pass — only explicit true does.
  if (effect?.constructor?.optInEnable === true) {
    // DazzleOverlay: runtime gate only (DynamicExposureManager sets enabled after updatables).
    if (effect?.constructor?.runtimeEnable === true) {
      return effect.enabled === true;
    }
    return effect.enabled === true && effect.params?.enabled === true;
  }

  // Gate 1: runtime instance flag
  if (effect.enabled === false) return false;

  // Gate 2: scene-flag-driven params (most effects store enable here)
  if (effect.params?.enabled === false) return false;

  return true;
}

/**
 * Determine if a mask-driven bus overlay effect is effectively enabled
 * AND has visible overlays worth rendering.
 *
 * @param {Object|null|undefined} effect
 * @returns {boolean}
 */
export function resolveOverlayEffectActive(effect) {
  if (!resolveEffectEnabled(effect)) return false;
  // Overlay effects expose _overlays (Map or Set) populated by FloorRenderBus
  const overlays = effect?._overlays;
  if (overlays && (typeof overlays.size === 'number') && overlays.size > 0) return true;
  return false;
}

/**
 * Determine if a particle/floor-based effect is effectively enabled
 * AND has active floors worth rendering.
 *
 * @param {Object|null|undefined} effect
 * @returns {boolean}
 */
export function resolveFloorEffectActive(effect) {
  if (!resolveEffectEnabled(effect)) return false;
  const floors = effect?._activeFloors;
  if (floors && (typeof floors.size === 'number') && floors.size > 0) return true;
  return false;
}
