/**
 * @fileoverview Levels Perspective Bridge (MS-LVL-100).
 *
 * Provides bidirectional synchronization between MapShine's active level
 * context and the Levels module's runtime perspective state, so that
 * movement collision, vision, door interaction, wall visibility, and
 * sound audibility all evaluate the same floor at the same time.
 *
 * ## Problem
 * MapShine uses `getPerspectiveElevation()` (from elevation-context.js) as
 * its canonical floor resolver, while the Levels module uses
 * `WallHeight.currentTokenElevation` and `CONFIG.Levels.currentToken`.
 * Without explicit synchronization these can diverge, causing walls on
 * one floor to block movement/vision evaluated from a different floor.
 *
 * ## Solution
 * This bridge listens to change events from both sides and keeps both
 * representations in sync:
 *
 * - **MapShine → Levels**: on `mapShineLevelContextChanged`, push the
 *   active floor elevation into `WallHeight.currentTokenElevation` and
 *   trigger a Foundry perception refresh so Levels-owned sight/sound
 *   handlers re-evaluate.
 *
 * - **Levels → MapShine**: on `levelsUiChangeLevel`, read the new
 *   `CONFIG.Levels.UI.range` and, if the CameraFollower has matching
 *   level data, switch MapShine's active level to match.
 *
 * The bridge is intentionally lightweight and stateless — it reads live
 * state on each event and never caches elevation values.
 *
 * @module foundry/levels-perspective-bridge
 */

import { createLogger } from '../core/log.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from './levels-compatibility.js';

const log = createLogger('LevelsPerspectiveBridge');

// ---------------------------------------------------------------------------
//  Safe accessors for external globals
// ---------------------------------------------------------------------------

/**
 * Safely read or write `WallHeight.currentTokenElevation`.
 * The wall-height module exposes this as a global class.
 * @returns {typeof WallHeight|null}
 */
function _getWallHeight() {
  try {
    return globalThis.WallHeight ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Read the current Levels UI range as {bottom, top} or null.
 * @returns {{bottom: number, top: number}|null}
 */
function _getLevelsUiRange() {
  try {
    const ui = globalThis.CONFIG?.Levels?.UI;
    if (!ui || ui.rangeEnabled !== true) return null;
    const range = ui.range;
    if (!Array.isArray(range) || range.length < 2) return null;
    const bottom = parseFloat(range[0]);
    const top = parseFloat(range[1]);
    if (!Number.isFinite(bottom) || !Number.isFinite(top)) return null;
    return { bottom, top };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Bridge class
// ---------------------------------------------------------------------------

export class LevelsPerspectiveBridge {
  constructor() {
    /** @type {Array<[string, number]>} */
    this._hookIds = [];

    /** @type {boolean} */
    this._initialized = false;

    // Guard against re-entrant sync loops (MapShine→Levels→MapShine…)
    this._syncing = false;
  }

  // -------------------------------------------------------------------------
  //  Lifecycle
  // -------------------------------------------------------------------------

  initialize() {
    if (this._initialized) return;

    this._registerHooks();
    this._initialized = true;

    log.info('LevelsPerspectiveBridge initialized');
  }

  dispose() {
    for (const [hookName, hookId] of this._hookIds) {
      try { Hooks.off(hookName, hookId); } catch (_) {}
    }
    this._hookIds = [];
    this._initialized = false;

    log.info('LevelsPerspectiveBridge disposed');
  }

  // -------------------------------------------------------------------------
  //  Hook registration
  // -------------------------------------------------------------------------

  /** @private */
  _registerHooks() {
    // MapShine → Levels: when Map Shine changes floor, push to Levels runtime
    this._hookIds.push(['mapShineLevelContextChanged', Hooks.on('mapShineLevelContextChanged', (payload) => {
      if (this._syncing) return;
      this._syncing = true;
      try {
        this._onMapShineLevelChanged(payload);
      } finally {
        this._syncing = false;
      }
    })]);

    // Levels → MapShine: when Levels UI changes floor, pull into MapShine
    this._hookIds.push(['levelsUiChangeLevel', Hooks.on('levelsUiChangeLevel', () => {
      if (this._syncing) return;
      this._syncing = true;
      try {
        this._onLevelsUiChanged();
      } finally {
        this._syncing = false;
      }
    })]);

    // Levels perspective change (CONFIG.Levels.currentToken setter fires this)
    this._hookIds.push(['levelsPerspectiveChanged', Hooks.on('levelsPerspectiveChanged', (token) => {
      if (this._syncing) return;
      this._syncing = true;
      try {
        this._onLevelsPerspectiveChanged(token);
      } finally {
        this._syncing = false;
      }
    })]);
  }

  // -------------------------------------------------------------------------
  //  MapShine → Levels sync
  // -------------------------------------------------------------------------

  /**
   * Push MapShine's active floor elevation into Levels' runtime state.
   * @param {object} payload - The mapShineLevelContextChanged payload
   * @private
   */
  _onMapShineLevelChanged(payload) {
    const ctx = payload?.context;
    if (!ctx) return;

    const elevation = Number(ctx.center ?? ctx.bottom);
    if (!Number.isFinite(elevation)) return;

    const WH = _getWallHeight();
    if (!WH) return;

    // Only sync if the values actually differ to avoid unnecessary perception updates
    const current = WH.currentTokenElevation;
    if (current === elevation) return;

    try {
      WH.currentTokenElevation = elevation;
      log.debug(`MapShine→Levels: pushed elevation ${elevation} (was ${current})`);
    } catch (e) {
      log.warn('Failed to set WallHeight.currentTokenElevation:', e);
      return;
    }

    // Also update the Levels UI range display if the Levels UI is active,
    // so the UI reflects the MapShine-driven floor switch.
    try {
      const levelsUi = globalThis.CONFIG?.Levels?.UI;
      if (levelsUi && levelsUi.rangeEnabled && typeof levelsUi.setRange === 'function') {
        const bottom = Number(ctx.bottom);
        const top = Number(ctx.top);
        if (Number.isFinite(bottom) && Number.isFinite(top)) {
          levelsUi.setRange([bottom, top]);
        }
      }
    } catch (_) {
      // Levels UI may not support setRange — that's fine
    }

    // Schedule a Foundry perception update so Levels' sight/sound/light
    // handlers re-evaluate with the new elevation.
    this._schedulePerceptionRefresh();
  }

  // -------------------------------------------------------------------------
  //  Levels → MapShine sync
  // -------------------------------------------------------------------------

  /**
   * Pull the Levels UI floor selection into MapShine's camera follower.
   * @private
   */
  _onLevelsUiChanged() {
    const range = _getLevelsUiRange();
    if (!range) return;

    const cameraFollower = window.MapShine?.cameraFollower;
    if (!cameraFollower) return;

    const levels = cameraFollower.getAvailableLevels?.() ?? [];
    if (levels.length === 0) return;

    // Find the MapShine level whose band best matches the Levels UI range
    const targetCenter = (range.bottom + range.top) * 0.5;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < levels.length; i++) {
      const lvl = levels[i];
      const dist = Math.abs(lvl.center - targetCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) return;

    const currentCtx = cameraFollower.getActiveLevelContext?.();
    if (currentCtx && currentCtx.index === bestIdx) return;

    try {
      cameraFollower.setActiveLevel?.(bestIdx, { reason: 'levels-ui-sync' });
      log.debug(`Levels→MapShine: synced to level index ${bestIdx} (center ${levels[bestIdx]?.center})`);
    } catch (e) {
      log.warn('Failed to sync Levels UI change to MapShine:', e);
    }
  }

  /**
   * Handle the `levelsPerspectiveChanged` hook (fired when CONFIG.Levels.currentToken changes).
   * If a token is controlled and its elevation differs from MapShine's active level,
   * we let the camera follower's "follow-controlled-token" mode handle the switch
   * naturally — no forced override needed.
   * @param {Token|null} token
   * @private
   */
  _onLevelsPerspectiveChanged(token) {
    // This is primarily informational. The camera follower's own controlToken
    // handling and follow mode will typically keep things in sync.
    // We just make sure the WallHeight elevation matches what MapShine expects
    // when in manual lock mode.
    const cameraFollower = window.MapShine?.cameraFollower;
    if (!cameraFollower) return;

    const ctx = cameraFollower.getActiveLevelContext?.();
    if (!ctx || ctx.lockMode !== 'manual') return;

    // In manual mode, MapShine's chosen floor takes precedence over
    // whatever token Levels just focused on. Re-assert our elevation.
    const WH = _getWallHeight();
    if (!WH) return;

    const elevation = Number(ctx.center ?? ctx.bottom);
    if (!Number.isFinite(elevation)) return;
    if (WH.currentTokenElevation === elevation) return;

    try {
      WH.currentTokenElevation = elevation;
      log.debug(`Re-asserted manual level elevation ${elevation} after levelsPerspectiveChanged`);
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  //  Helpers
  // -------------------------------------------------------------------------

  /**
   * Schedule a Foundry perception update so Levels-owned handlers re-evaluate.
   * Uses WallHeight.schedulePerceptionUpdate if available, falls back to
   * canvas.perception.update.
   * @private
   */
  _schedulePerceptionRefresh() {
    try {
      const WH = _getWallHeight();
      if (WH && typeof WH.schedulePerceptionUpdate === 'function') {
        WH.schedulePerceptionUpdate();
        return;
      }
    } catch (_) {}

    try {
      if (canvas?.perception?.update) {
        canvas.perception.update({ refreshVision: true, refreshLighting: true, refreshSounds: true });
      }
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  //  Diagnostics
  // -------------------------------------------------------------------------

  getDiagnostics() {
    const WH = _getWallHeight();
    const levelsRange = _getLevelsUiRange();
    const ctx = window.MapShine?.activeLevelContext;

    return {
      initialized: this._initialized,
      wallHeightAvailable: !!WH,
      wallHeightElevation: WH?.currentTokenElevation ?? null,
      levelsUiRange: levelsRange,
      mapShineContext: ctx ? { center: ctx.center, bottom: ctx.bottom, top: ctx.top, lockMode: ctx.lockMode } : null,
      configLevelsCurrentToken: globalThis.CONFIG?.Levels?.currentToken?.name ?? null,
    };
  }
}
