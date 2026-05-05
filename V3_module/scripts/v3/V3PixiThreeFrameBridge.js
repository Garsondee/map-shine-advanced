/**
 * @fileoverview Single place to decide **when Three runs relative to Foundry’s PIXI tick**.
 *
 * PixiJS ticker: **higher `priority` runs earlier** in a tick. Foundry’s
 * `Application` render is typically scheduled at `UPDATE_PRIORITY.LOW` (-25).
 *
 * **Default** scheduling uses priority **`LOW - 1`** (e.g. -26): Three runs in the
 * same tick **immediately after** the LOW band, so the underlay WebGL buffer is
 * fresh right after Foundry paints the transparent PIXI surface. Scheduling much
 * later at `UTILITY` (-50) left a wider window for other listeners / compositor
 * work and could produce visible flicker between the two canvases.
 *
 * Optional **UTILITY_LATE** keeps the older `-50` timing for debugging.
 *
 * `V3ThreeSceneHost` prefers **`renderer.runners.postrender`** (Pixi v8) so Three
 * runs in the same synchronous stack as the end of each PIXI `render()`; this
 * bridge is only used when that runner is missing.
 *
 * Anything that must happen **before** Foundry paints (e.g. hiding
 * `canvas.primary.sprite`) lives in `V3ThreeSceneHost` at
 * `v3PixiPrimarySuppressTickerPriority()` in `V3FoundryCanvasIntegration.js`.
 *
 * **LOW_SIBLING** registers at **LOW** (same band as the app render). Order among
 * same-priority listeners is **registration order**; treat as experimental.
 *
 * ### rAF fallback
 * When no PIXI ticker is available we fall back to `requestAnimationFrame`.
 * That path reads {@link getEffectiveFpsCap} from `V3FpsPolicy` and throttles
 * each tick so the fallback never exceeds the module-wide ceiling (hard max
 * {@link V3_FPS_POLICY_HARD_MAX} FPS). This prevents high-refresh displays
 * from running Three at 144/240 Hz when PIXI is not driving the composite.
 */

import { getEffectiveFpsCap, V3_FPS_POLICY_HARD_MAX } from "./V3FpsPolicy.js";

/** Stored in `game.settings`; keep values stable for saved worlds. */
export const V3_FRAME_BRIDGE_SETTING = Object.freeze({
  /** Priority `LOW - 1`: Three immediately after Foundry’s LOW render (default). */
  UTILITY_AFTER_LOW: "utility-after-low",
  /** Legacy: `UPDATE_PRIORITY.UTILITY` (-50) — much later in the tick. */
  UTILITY_LATE: "utility-late",
  LOW_SIBLING: "low-sibling",
});

/** @type {Readonly<Record<string, string>>} */
export const V3_FRAME_BRIDGE_SETTING_LABELS = Object.freeze({
  [V3_FRAME_BRIDGE_SETTING.UTILITY_AFTER_LOW]:
    "Right after Foundry LOW render (recommended; reduces two-canvas flicker)",
  [V3_FRAME_BRIDGE_SETTING.UTILITY_LATE]:
    "Late in tick (UTILITY -50) — legacy fallback",
  [V3_FRAME_BRIDGE_SETTING.LOW_SIBLING]:
    "Same band as app render (LOW) — experimental; can change feel",
});

/**
 * @param {string} settingValue one of `V3_FRAME_BRIDGE_SETTING`
 * @returns {number} PIXI `ticker.add(..., priority)` value
 */
export function pixiPriorityForFrameBridgeSetting(settingValue) {
  const P = globalThis.PIXI;
  const low = P?.UPDATE_PRIORITY?.LOW ?? -25;
  switch (settingValue) {
    case V3_FRAME_BRIDGE_SETTING.LOW_SIBLING:
      return low;
    case V3_FRAME_BRIDGE_SETTING.UTILITY_LATE:
      return P?.UPDATE_PRIORITY?.UTILITY ?? -50;
    case V3_FRAME_BRIDGE_SETTING.UTILITY_AFTER_LOW:
    default:
      return low - 1;
  }
}

/**
 * Owns PIXI ticker registration (or rAF fallback) for one repeating callback.
 */
export class V3PixiThreeFrameBridge {
  /**
   * @param {{
   *   frameBridgeSetting?: string,
   *   logger?: { log?: Function, warn?: Function },
   * }} [opts]
   */
  constructor({ frameBridgeSetting, logger } = {}) {
    this._setting =
      frameBridgeSetting === V3_FRAME_BRIDGE_SETTING.LOW_SIBLING
        ? V3_FRAME_BRIDGE_SETTING.LOW_SIBLING
        : frameBridgeSetting === V3_FRAME_BRIDGE_SETTING.UTILITY_LATE
          ? V3_FRAME_BRIDGE_SETTING.UTILITY_LATE
          : V3_FRAME_BRIDGE_SETTING.UTILITY_AFTER_LOW;
    this._log = logger?.log ?? (() => {});
    this._warn = logger?.warn ?? (() => {});

    /** @type {any} */ this._ticker = null;
    /** @type {Function|null} */ this._listener = null;
    /** @type {unknown} */ this._thisArg = null;
    /** @type {number|null} */ this._priorityUsed = null;
    /** @type {"pixi-ticker"|"raf-fallback"|"none"} */ this._drive = "none";
    /** @type {number} */ this._raf = 0;
    /** Last rAF-fallback composite time in `performance.now()` units. */
    /** @type {number} */ this._rafLastCompositeMs = 0;
    /** @type {number} rAF ticks fired by browser in fallback mode */
    this._rafTicks = 0;
    /** @type {number} rAF ticks that ran the listener (passed cap gate) */
    this._rafComposites = 0;
    /** @type {number} rAF ticks that were throttled (skipped the listener) */
    this._rafThrottledSkips = 0;
  }

  /**
   * @param {any} app PIXI Application (`canvas.app`)
   * @param {Function} listener
   * @param {unknown} [thisArg]
   * @returns {boolean} true if PIXI ticker hook succeeded
   */
  attach(app, listener, thisArg) {
    this.detach();
    this._listener = listener;
    this._thisArg = thisArg;

    const ticker = app?.ticker;
    const priority = pixiPriorityForFrameBridgeSetting(this._setting);
    if (ticker?.add) {
      try {
        ticker.add(listener, thisArg, priority);
        this._ticker = ticker;
        this._priorityUsed = priority;
        this._drive = "pixi-ticker";
        this._log(
          "[V3FrameBridge] PIXI ticker",
          this._setting,
          "priority",
          priority,
        );
        return true;
      } catch (err) {
        this._warn("[V3FrameBridge] ticker.add failed, using rAF", err);
      }
    } else {
      this._warn("[V3FrameBridge] no PIXI ticker; using rAF");
    }
    this._attachRaf(listener, thisArg);
    return false;
  }

  _attachRaf(listener, thisArg) {
    const now = () => {
      try { return globalThis.performance?.now?.() ?? Date.now(); }
      catch (_) { return Date.now(); }
    };
    this._rafLastCompositeMs = 0;
    this._rafTicks = 0;
    this._rafComposites = 0;
    this._rafThrottledSkips = 0;
    const loop = () => {
      this._raf = globalThis.requestAnimationFrame(loop);
      this._rafTicks += 1;
      // Policy: never exceed V3_FPS_POLICY_HARD_MAX (120) in the rAF fallback.
      // Use the active effective cap so manual overrides from V3FpsPolicy
      // (e.g. user lowered the cap) flow through here too.
      const cap = Math.max(1, Math.min(V3_FPS_POLICY_HARD_MAX, getEffectiveFpsCap() || V3_FPS_POLICY_HARD_MAX));
      // Subtract half a ms to avoid round-off drift against the browser's rAF
      // native cadence on 120Hz displays — otherwise an effective cap of 120
      // can miss every other frame to 60fps.
      const minIntervalMs = Math.max(0, (1000 / cap) - 0.5);
      const t = now();
      if ((t - this._rafLastCompositeMs) < minIntervalMs) {
        this._rafThrottledSkips += 1;
        return;
      }
      this._rafLastCompositeMs = t;
      this._rafComposites += 1;
      listener.call(thisArg);
    };
    this._raf = globalThis.requestAnimationFrame(loop);
    this._priorityUsed = null;
    this._drive = "raf-fallback";
    this._warn(
      "[V3FrameBridge] rAF fallback (throttled to V3FpsPolicy effective cap) — pan/zoom may desync vs PIXI",
    );
  }

  detach() {
    if (this._ticker && this._listener != null) {
      try {
        this._ticker.remove(this._listener, this._thisArg);
      } catch (_) {}
    }
    this._ticker = null;
    this._listener = null;
    this._thisArg = null;
    this._priorityUsed = null;

    if (this._raf) {
      try {
        globalThis.cancelAnimationFrame(this._raf);
      } catch (_) {}
    }
    this._raf = 0;
    this._drive = "none";
  }

  snapshot() {
    return {
      setting: this._setting,
      drive: this._drive,
      pixiPriority: this._priorityUsed,
      /** rAF fallback telemetry. Zero when `drive !== "raf-fallback"`. */
      rafFallback: {
        ticks: this._rafTicks,
        composites: this._rafComposites,
        throttledSkips: this._rafThrottledSkips,
        effectiveCap: this._drive === "raf-fallback" ? getEffectiveFpsCap() : null,
      },
    };
  }
}
