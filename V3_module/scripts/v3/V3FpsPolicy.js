/**
 * @fileoverview V3 FPS policy — one place that decides the effective
 * frame-rate ceiling and applies it to **every** scheduler this module can
 * influence.
 *
 * ### Motivation
 * Foundry v14 (`foundryvttsourcecode_v14/resources/app/client/canvas/board.mjs`
 * `_configurePerformanceMode`) clamps the `core.maxFPS` setting to `0..60`,
 * and in **MAX** performance mode with a slider-equivalent of 60 it sets
 * `settings.fps = 0` (PIXI: **uncapped**). Three.js work that runs from the
 * PIXI `postrender` runner inherits that cadence; on a high-refresh display
 * this can exceed 120 Hz. The rAF fallback in `V3PixiThreeFrameBridge` is
 * likewise unbounded by default.
 *
 * ### Policy (single source of truth)
 * `effective = min(hardCeiling, foundryMax === 0 ? hardCeiling : foundryMax)`
 *   - `hardCeiling` defaults to `120` (configurable via module setting).
 *   - Foundry's `0` (uncapped) is treated as "cap at `hardCeiling`".
 *   - Finite Foundry caps pass through unchanged when ≤ `hardCeiling`.
 *
 * ### Application surface
 *   - `canvas.app.ticker.maxFPS`
 *   - `PIXI.Ticker.shared.maxFPS`
 *   - `PIXI.Ticker.system.maxFPS`
 *
 * The `V3PixiThreeFrameBridge` rAF fallback reads `getEffectiveFpsCap()` to
 * self-throttle — see `_attachRaf` in `V3PixiThreeFrameBridge.js`.
 *
 * ### Wrapping strategy
 * No hard dependency on `libWrapper`. We patch
 * `Canvas.prototype._configurePerformanceMode` in place; the original method
 * is stashed so `uninstall()` fully reverts the prototype. Only one install is
 * live per page load; re-install is a no-op.
 *
 * @see foundryvttsourcecode_v14/resources/app/client/canvas/board.mjs#_configurePerformanceMode
 */

/**
 * Hard absolute ceiling the module will never exceed, even if a user sets the
 * `v3MaxFpsCap` module setting higher. Matches the planning doc target.
 */
export const V3_FPS_POLICY_HARD_MAX = 120;

/** Settings fallback default used when the module setting is missing. */
export const V3_FPS_POLICY_DEFAULT_CAP = 120;

/**
 * Minimum acceptable cap — below this, interactivity suffers noticeably and
 * Pixi animation timing can go wrong.
 */
export const V3_FPS_POLICY_MIN_CAP = 30;

/**
 * Current runtime state for the policy. Single-module singleton: there is one
 * PIXI Application per Foundry client.
 * @typedef {object} V3FpsPolicyState
 * @property {boolean} installed - true after `installFpsPolicy` succeeded.
 * @property {number}  desiredCap - current user/module-configured cap (pre-ceiling).
 * @property {number}  hardCeiling - hard ceiling used by `computeEffectiveCap`.
 * @property {number|null} lastEffective - last value written to tickers.
 * @property {number|null} lastFoundryMax - last cap Foundry applied before we overrode.
 * @property {number} applyCount - number of times we re-applied after Foundry.
 * @property {Function|null} originalConfigurePerformanceMode - prototype stash.
 * @property {any|null} canvasCtor - the `Canvas` class we patched, for clean restore.
 */

/** @type {V3FpsPolicyState} */
const state = {
  installed: false,
  desiredCap: V3_FPS_POLICY_DEFAULT_CAP,
  hardCeiling: V3_FPS_POLICY_HARD_MAX,
  lastEffective: null,
  lastFoundryMax: null,
  applyCount: 0,
  originalConfigurePerformanceMode: null,
  canvasCtor: null,
};

/** @param {unknown} n */
function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Compute the effective cap from a raw Foundry ticker value, module-desired
 * cap, and the hard ceiling. Safe for any input (coerces invalid → ceiling).
 *
 * @param {number|null|undefined} foundryMax Value Foundry assigned to the ticker
 *   (post-`_configurePerformanceMode`). Pixi semantic: `0` means **uncapped**.
 * @param {number} desiredCap Module setting `v3MaxFpsCap`.
 * @param {number} [hardCeiling=V3_FPS_POLICY_HARD_MAX] Absolute upper bound.
 * @returns {number} A positive integer FPS cap (never `0`, never above `hardCeiling`).
 */
export function computeEffectiveFpsCap(foundryMax, desiredCap, hardCeiling = V3_FPS_POLICY_HARD_MAX) {
  const ceil = Math.max(1, Math.floor(isFiniteNumber(hardCeiling) ? hardCeiling : V3_FPS_POLICY_HARD_MAX));
  const wanted = Math.max(
    V3_FPS_POLICY_MIN_CAP,
    Math.min(ceil, Math.floor(isFiniteNumber(desiredCap) ? desiredCap : V3_FPS_POLICY_DEFAULT_CAP)),
  );
  if (!isFiniteNumber(foundryMax) || foundryMax <= 0) {
    // Foundry uncapped (MAX mode, 60→0). Treat as "cap to wanted".
    return wanted;
  }
  return Math.min(wanted, Math.floor(foundryMax));
}

/**
 * Read the currently active effective cap. If the policy is not installed,
 * falls back to the desired cap clipped to the ceiling.
 * @returns {number}
 */
export function getEffectiveFpsCap() {
  if (state.lastEffective != null) return state.lastEffective;
  return Math.min(state.hardCeiling, Math.max(V3_FPS_POLICY_MIN_CAP, state.desiredCap));
}

/**
 * Apply the effective cap to all three PIXI tickers at once.
 *
 * @param {object} [opts]
 * @param {any} [opts.canvas] Foundry canvas (defaults to `globalThis.canvas`).
 * @param {any} [opts.PIXI] PIXI namespace (defaults to `globalThis.PIXI`).
 * @param {boolean} [opts.fromWrapper=false] When true, logs the pre-override
 *   Foundry value for diagnostics.
 * @returns {number|null} Effective FPS applied, or `null` if application failed.
 */
export function applyFpsCapToPixi({ canvas, PIXI, fromWrapper = false } = {}) {
  const cv = canvas ?? globalThis.canvas;
  const pixi = PIXI ?? globalThis.PIXI;
  const appTicker = cv?.app?.ticker;
  if (!appTicker) return null;

  const foundryMax = isFiniteNumber(appTicker.maxFPS) ? appTicker.maxFPS : null;
  if (fromWrapper) state.lastFoundryMax = foundryMax;

  const effective = computeEffectiveFpsCap(foundryMax, state.desiredCap, state.hardCeiling);
  try {
    appTicker.maxFPS = effective;
    const shared = pixi?.Ticker?.shared;
    const system = pixi?.Ticker?.system;
    if (shared) shared.maxFPS = effective;
    if (system) system.maxFPS = effective;
    state.lastEffective = effective;
    state.applyCount += 1;
    return effective;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the `Canvas` class to patch. Prefer `canvas.constructor` (always
 * the runtime `Canvas`), then `foundry.canvas.Canvas`, then `CONFIG.Canvas`.
 * @returns {any|null}
 */
function resolveCanvasClass() {
  try {
    const fromInstance = globalThis.canvas?.constructor;
    if (typeof fromInstance === "function" && fromInstance.prototype?._configurePerformanceMode) {
      return fromInstance;
    }
  } catch (_) {}
  try {
    /** @type {any} */
    const f = globalThis.foundry;
    const cls = f?.canvas?.Canvas;
    if (typeof cls === "function" && cls.prototype?._configurePerformanceMode) return cls;
  } catch (_) {}
  try {
    const cls = globalThis.Canvas;
    if (typeof cls === "function" && cls.prototype?._configurePerformanceMode) return cls;
  } catch (_) {}
  return null;
}

/**
 * Install the prototype wrapper around `Canvas#_configurePerformanceMode` so
 * the module re-applies its cap **after** Foundry finishes assigning the
 * PIXI ticker fields. Idempotent.
 *
 * @param {object} [opts]
 * @param {number} [opts.desiredCap] Overrides the runtime desired cap.
 * @param {number} [opts.hardCeiling] Overrides the runtime hard ceiling.
 * @param {{log?: Function, warn?: Function}} [opts.logger]
 * @returns {boolean} true if installed (or already installed), false on failure.
 */
export function installFpsPolicy({ desiredCap, hardCeiling, logger } = {}) {
  const log = logger?.log ?? (() => {});
  const warn = logger?.warn ?? (() => {});
  if (isFiniteNumber(desiredCap)) state.desiredCap = desiredCap;
  if (isFiniteNumber(hardCeiling)) state.hardCeiling = hardCeiling;
  if (state.installed) {
    // Re-apply with potentially-new values.
    applyFpsCapToPixi({ fromWrapper: false });
    return true;
  }
  const CanvasCtor = resolveCanvasClass();
  if (!CanvasCtor) {
    warn("[V3FpsPolicy] could not resolve Canvas class — will retry on canvasReady");
    return false;
  }
  const orig = CanvasCtor.prototype._configurePerformanceMode;
  if (typeof orig !== "function") {
    warn("[V3FpsPolicy] Canvas.prototype._configurePerformanceMode missing");
    return false;
  }
  state.originalConfigurePerformanceMode = orig;
  state.canvasCtor = CanvasCtor;
  CanvasCtor.prototype._configurePerformanceMode = function v3WrappedConfigurePerformanceMode() {
    const result = orig.apply(this, arguments);
    try {
      applyFpsCapToPixi({ canvas: this, fromWrapper: true });
    } catch (err) {
      warn("[V3FpsPolicy] apply after _configurePerformanceMode failed", err);
    }
    return result;
  };
  state.installed = true;
  log(
    "[V3FpsPolicy] installed prototype wrapper on Canvas#_configurePerformanceMode",
    { desiredCap: state.desiredCap, hardCeiling: state.hardCeiling },
  );
  // Apply immediately against the current canvas so the first frame is capped.
  applyFpsCapToPixi({ fromWrapper: false });
  return true;
}

/**
 * Restore the original `Canvas#_configurePerformanceMode`. Safe to call even
 * when not installed.
 * @param {object} [opts]
 * @param {{log?: Function, warn?: Function}} [opts.logger]
 */
export function uninstallFpsPolicy({ logger } = {}) {
  const log = logger?.log ?? (() => {});
  if (!state.installed) return;
  try {
    if (state.canvasCtor && state.originalConfigurePerformanceMode) {
      state.canvasCtor.prototype._configurePerformanceMode = state.originalConfigurePerformanceMode;
    }
  } catch (_) {}
  state.installed = false;
  state.originalConfigurePerformanceMode = null;
  state.canvasCtor = null;
  log("[V3FpsPolicy] uninstalled prototype wrapper");
}

/**
 * Update the desired cap at runtime. Clamps to `[V3_FPS_POLICY_MIN_CAP,
 * state.hardCeiling]` and re-applies across tickers. Use this from the
 * `onChange` handler of the `v3MaxFpsCap` module setting.
 *
 * @param {number} nextCap
 */
export function setDesiredFpsCap(nextCap) {
  const clamped = Math.max(
    V3_FPS_POLICY_MIN_CAP,
    Math.min(state.hardCeiling, Math.floor(isFiniteNumber(nextCap) ? nextCap : V3_FPS_POLICY_DEFAULT_CAP)),
  );
  state.desiredCap = clamped;
  applyFpsCapToPixi({ fromWrapper: false });
}

/**
 * Snapshot for diagnostics.
 * @returns {{
 *   installed: boolean,
 *   desiredCap: number,
 *   hardCeiling: number,
 *   effectiveCap: number|null,
 *   lastFoundryMax: number|null,
 *   applyCount: number,
 *   currentPixiTickerMax: number|null,
 *   currentSharedTickerMax: number|null,
 *   currentSystemTickerMax: number|null,
 * }}
 */
export function snapshotFpsPolicy() {
  /** @type {any} */ const PIXI = globalThis.PIXI;
  const appTicker = globalThis.canvas?.app?.ticker;
  return {
    installed: state.installed,
    desiredCap: state.desiredCap,
    hardCeiling: state.hardCeiling,
    effectiveCap: state.lastEffective,
    lastFoundryMax: state.lastFoundryMax,
    applyCount: state.applyCount,
    currentPixiTickerMax: isFiniteNumber(appTicker?.maxFPS) ? appTicker.maxFPS : null,
    currentSharedTickerMax: isFiniteNumber(PIXI?.Ticker?.shared?.maxFPS)
      ? PIXI.Ticker.shared.maxFPS
      : null,
    currentSystemTickerMax: isFiniteNumber(PIXI?.Ticker?.system?.maxFPS)
      ? PIXI.Ticker.system.maxFPS
      : null,
  };
}
