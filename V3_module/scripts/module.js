/**
 * @fileoverview Map Shine Advanced - V3 Minimal Floor Sandwich entry point.
 *
 * Sole purpose: composite `lowerFloor -> proceduralChecker -> upperFloor`
 * with the upper floor's alpha driving occlusion/reveal. Uses Foundry V14
 * native level background URLs for data only; **map sandwich is Three.js**
 * (WebGLRenderer). The native PIXI view stays visible **above** Three for grid
 * and interface layers while `canvas.primary.sprite` is suppressed. **Native
 * `CanvasVisibility` / fog are turned off during V3** (their fullscreen pass is
 * opaque over a second WebGL canvas). At module load we hook `canvasConfig` to set
 * `transparent` and `backgroundAlpha: 0` (v13 parity). Do not assign a plain object to
 * `config.context` — Pixi v8 treats that as an adopted WebGL context. A full reload may be
 * needed if the board was created before those options applied (`diag().pixiContextAlpha`).
 * The PIXI ticker stays on unless you opt in via module settings to stop it (breaks pan/zoom).
 *
 * Runtime surface (debug only, via window.V3Shine):
 *   - enable()      : force-mount the layer on the active canvas
 *   - disable()     : force-unmount the layer
 *   - rebuild()     : force a re-resolve + reload of textures
 *   - setUniforms() : tweak debug uniforms (checker size / opacity / colors / premultiplied)
 *   - textureInventory() / showLevelTextureDebug() / hideLevelTextureDebug()
 *                     : suffixed level textures (e.g. _Outdoors) over the sandwich
 *   - openMaskDebugPane() / toggleMaskDebugPane() — Tweakpane: masks + illumination + runtime PIXI vs Three map toggle
 *   - getRuntimeThreeOverlayWanted() / setRuntimeThreeOverlayWanted(bool) — mount/unmount Three without changing the V3 setting
 *   - setFoundryPixiViewHiddenForDiagnostic(bool) — hide Foundry’s PIXI `app.view` (flicker A/B); restore with false
 *   - Token controls: **mask** button toggles the mask inspector; **gear** (GM) opens the stub V3 config pane
 *   - diag()        : snapshot of current state (srcs, uniforms, mounted)
 */

import { V3ThreeSceneHost } from "./v3/V3ThreeSceneHost.js";
import {
  V3_FRAME_BRIDGE_SETTING,
} from "./v3/V3PixiThreeFrameBridge.js";
import { V3MaskDebugPane } from "./v3/V3MaskDebugPane.js";
import { V3ModuleConfigPane } from "./v3/V3ModuleConfigPane.js";
import {
  installFpsPolicy,
  uninstallFpsPolicy,
  setDesiredFpsCap,
  applyFpsCapToPixi,
  V3_FPS_POLICY_HARD_MAX,
  V3_FPS_POLICY_DEFAULT_CAP,
  V3_FPS_POLICY_MIN_CAP,
} from "./v3/V3FpsPolicy.js";
import { installV3DebugApi } from "./v3/V3DebugApi.js";
import { registerV3ModuleSettings } from "./v3/V3ModuleSettings.js";
import { registerV3LifecycleHooks } from "./v3/V3LifecycleHooks.js";
import { V3LoadingStatusOverlay } from "./v3/V3LoadingStatusOverlay.js";

const MODULE_ID = "map-shine-advanced";
const SETTING_ENABLED = "v3SandwichEnabled";
const SETTING_SUPPRESS_PIXI = "v3SuppressFoundryPixi";
const SETTING_FRAME_BRIDGE = "v3FrameBridgeMode";
const SETTING_MASK_DEBUG_PANE = "v3MaskDebugPane";
const SETTING_ENFORCE_FPS_CAP = "v3EnforceFpsCap";
const SETTING_MAX_FPS_CAP = "v3MaxFpsCap";
const SETTING_V3_FLICKER_DIAG = "v3FlickerDiagnostics";
/** Setting key for the shader warmup UX mode (see V3ShaderWarmupCoordinator). */
const SETTING_SHADER_WARMUP_MODE = "v3ShaderWarmupMode";

/** @type {V3ThreeSceneHost|null} */
let layer = null;

/**
 * When false, the Three.js sandwich is not mounted even if “V3 Sandwich Enabled”
 * is on — native PIXI map/lighting shows for A/B checks. Ephemeral (not a
 * game.settings key); Tweakpane “Render comparison” and `V3Shine` helpers keep
 * it in sync with mount/unmount.
 */
let runtimeThreeOverlayWanted = true;

/** @type {V3MaskDebugPane|null} */
let maskDebugPane = null;

/** @type {V3ModuleConfigPane|null} */
let v3ModuleConfigPane = null;

/** @type {V3LoadingStatusOverlay|null} */
let shaderWarmupOverlay = null;

/** @type {ReturnType<typeof setTimeout>|null} */
let _maskComposeAfterSceneUpdateTimer = null;

/**
 * Inline styles saved while {@link setFoundryPixiViewHiddenForDiagnostic} hides
 * Foundry’s PIXI view (flicker isolation).
 * @type {{ opacity: string, visibility: string, pointerEvents: string }|null}
 */
let _foundryPixiViewDiagnosticStyle = null;

function _getFoundryPixiViewEl() {
  const v = globalThis.canvas?.app?.view;
  if (!v || typeof HTMLElement === "undefined") return null;
  return v instanceof HTMLElement ? v : null;
}

function restoreFoundryPixiViewDiagnosticIfNeeded() {
  const view = _getFoundryPixiViewEl();
  if (!_foundryPixiViewDiagnosticStyle) return;
  if (!view) {
    _foundryPixiViewDiagnosticStyle = null;
    return;
  }
  try {
    view.style.opacity = _foundryPixiViewDiagnosticStyle.opacity;
    view.style.visibility = _foundryPixiViewDiagnosticStyle.visibility;
    view.style.pointerEvents = _foundryPixiViewDiagnosticStyle.pointerEvents;
  } catch (_) {}
  _foundryPixiViewDiagnosticStyle = null;
}

/**
 * Temporarily hide Foundry’s PIXI output (`canvas.app.view`) so only the
 * Three underlay is visible — isolates dual-canvas / PIXI-layer flicker.
 * PIXI still runs; this is CSS-only. Restored on `unmount()` or `false`.
 *
 * @param {boolean} hidden
 * @returns {{ ok: boolean, reason?: string }}
 */
function setFoundryPixiViewHiddenForDiagnostic(hidden) {
  const view = _getFoundryPixiViewEl();
  if (!view) {
    warn("setFoundryPixiViewHiddenForDiagnostic: no canvas.app.view (open a scene?)");
    return { ok: false, reason: "no-view" };
  }
  if (hidden) {
    if (_foundryPixiViewDiagnosticStyle) {
      warn(
        "PIXI view already hidden for diagnostic — call setFoundryPixiViewHiddenForDiagnostic(false) first",
      );
      return { ok: false, reason: "already-hidden" };
    }
    _foundryPixiViewDiagnosticStyle = {
      opacity: view.style.opacity,
      visibility: view.style.visibility,
      pointerEvents: view.style.pointerEvents,
    };
    view.style.opacity = "0";
    view.style.visibility = "hidden";
    view.style.pointerEvents = "none";
    log(
      "Foundry PIXI canvas (app.view) hidden — only the Three layer should be visible. " +
        "V3Shine.setFoundryPixiViewHiddenForDiagnostic(false) to restore.",
    );
    return { ok: true };
  }
  restoreFoundryPixiViewDiagnosticIfNeeded();
  log("Foundry PIXI canvas (app.view) restored");
  return { ok: true };
}

function log(...args) {
  try { console.log("[V3Shine]", ...args); } catch (_) {}
}

function warn(...args) {
  try { console.warn("[V3Shine]", ...args); } catch (_) {}
}

function isEnabled() {
  try {
    return game?.settings?.get?.(MODULE_ID, SETTING_ENABLED) !== false;
  } catch (_) {
    return true;
  }
}

/**
 * PIXI must be created with a transparent color buffer (`backgroundAlpha` / WebGL
 * `alpha: true`) or cleared pixels never composite over a second WebGL canvas
 * under `#board`. v13 used `config.backgroundAlpha = 0` and avoided relying on
 * legacy `transparent` alone for PIXI v8+ (`canvas-replacement.js`). Never assign
 * a stub to `config.context` — Pixi treats it as an adopted GL context.
 *
 * Registered at **module load** (not inside `init`) so the hook exists before
 * `Hooks.callAll("canvasConfig")` on the first `PIXI.Application` build.
 *
 * @param {any} config Foundry → PIXI.Application options
 */
function applyV3PixiCanvasConfig(config) {
  if (!config || typeof config !== "object") return;
  if (!isEnabled()) return;
  try {
    config.transparent = true;
    config.backgroundAlpha = 0;
  } catch (_) {}
}

try {
  Hooks.on("canvasConfig", (config) => {
    try {
      applyV3PixiCanvasConfig(config);
    } catch (_) {}
  });
} catch (err) {
  warn("Hooks.on(canvasConfig) at module load failed", err);
}

function readSuppressFoundryPixi() {
  try {
    return game?.settings?.get?.(MODULE_ID, SETTING_SUPPRESS_PIXI) === true;
  } catch (_) {
    return false;
  }
}

function readFrameBridgeSetting() {
  try {
    const v = game?.settings?.get?.(MODULE_ID, SETTING_FRAME_BRIDGE);
    if (v === V3_FRAME_BRIDGE_SETTING.LOW_SIBLING) return v;
    if (v === V3_FRAME_BRIDGE_SETTING.UTILITY_LATE) return v;
  } catch (_) {}
  return V3_FRAME_BRIDGE_SETTING.UTILITY_AFTER_LOW;
}

function readMaskDebugPaneSetting() {
  try {
    return game?.settings?.get?.(MODULE_ID, SETTING_MASK_DEBUG_PANE) === true;
  } catch (_) {
    return false;
  }
}

function readEnforceFpsCapSetting() {
  try {
    return game?.settings?.get?.(MODULE_ID, SETTING_ENFORCE_FPS_CAP) !== false;
  } catch (_) {
    return true;
  }
}

function readMaxFpsCapSetting() {
  try {
    const v = Number(game?.settings?.get?.(MODULE_ID, SETTING_MAX_FPS_CAP));
    if (Number.isFinite(v) && v >= V3_FPS_POLICY_MIN_CAP) {
      return Math.min(V3_FPS_POLICY_HARD_MAX, Math.floor(v));
    }
  } catch (_) {}
  return V3_FPS_POLICY_DEFAULT_CAP;
}

/**
 * Decide to install/uninstall the FPS policy wrapper and apply the configured
 * cap to the currently-live tickers. Called on init, on canvasReady, and
 * whenever the `v3EnforceFpsCap` / `v3MaxFpsCap` settings change.
 */
function syncFpsPolicyFromSettings() {
  if (!readEnforceFpsCapSetting()) {
    uninstallFpsPolicy({ logger: { log, warn } });
    return;
  }
  const desiredCap = readMaxFpsCapSetting();
  const installed = installFpsPolicy({
    desiredCap,
    hardCeiling: V3_FPS_POLICY_HARD_MAX,
    logger: { log, warn },
  });
  if (!installed) {
    // Even if the wrapper could not install (canvas not ready yet), apply now
    // so the next _configurePerformanceMode run does not leave an uncapped value.
    setDesiredFpsCap(desiredCap);
    applyFpsCapToPixi();
    return;
  }
  setDesiredFpsCap(desiredCap);
}

function syncMaskDebugPaneFromSettings() {
  if (readMaskDebugPaneSetting()) {
    openMaskDebugPane();
  } else {
    closeMaskDebugPane();
  }
}

/**
 * Whether a Foundry `updateScene` diff should refresh the V3 mask manifest /
 * per-floor table (inventory pane + hub records).
 *
 * @param {unknown} changes
 */
function sceneUpdateAffectsMaskAssets(changes) {
  if (changes === undefined || changes === null) return true;
  if (typeof changes !== "object" || Array.isArray(changes)) return true;
  if ("levels" in changes || "background" in changes || "img" in changes || "foreground" in changes) {
    return true;
  }
  try {
    const f = changes.flags;
    if (f && typeof f === "object" && Object.prototype.hasOwnProperty.call(f, MODULE_ID)) {
      return true;
    }
  } catch (_) {}
  return false;
}

function activeCanvasSceneMatches(scene) {
  try {
    const active = globalThis.canvas?.scene;
    return !!(active && scene && active.id === scene.id);
  } catch (_) {
    return false;
  }
}

/**
 * Invalidate cached manifest for this scene and rebuild the hub (debounced).
 * Needed when `canvasReady` ran before levels/backgrounds were populated, or
 * when the GM updates the persisted asset manifest / level stack.
 *
 * @param {object|null|undefined} scene
 */
function scheduleMaskHubComposeFromSceneUpdate(scene) {
  if (!layer?.maskHub || !layer?.assetInventory) return;
  if (!activeCanvasSceneMatches(scene)) return;
  try {
    layer.assetInventory.invalidateScene(scene);
  } catch (_) {}
  if (_maskComposeAfterSceneUpdateTimer) {
    try { clearTimeout(_maskComposeAfterSceneUpdateTimer); } catch (_) {}
  }
  _maskComposeAfterSceneUpdateTimer = setTimeout(() => {
    _maskComposeAfterSceneUpdateTimer = null;
    void layer?.maskHub?.compose?.()?.catch?.((e) => warn("mask compose after updateScene", e));
  }, 50);
}

function clearMaskComposeAfterSceneUpdateTimer() {
  if (!_maskComposeAfterSceneUpdateTimer) return;
  try { clearTimeout(_maskComposeAfterSceneUpdateTimer); } catch (_) {}
  _maskComposeAfterSceneUpdateTimer = null;
}

function openMaskDebugPane() {
  if (!maskDebugPane) {
    maskDebugPane = new V3MaskDebugPane({
      getHost: () => layer,
      getRuntimeThreeOverlayWanted: () => runtimeThreeOverlayWanted,
      setRuntimeThreeOverlayWanted: (v) => setRuntimeThreeOverlayWanted(v),
    });
  }
  try {
    maskDebugPane.mount();
  } catch (err) {
    warn("mask debug pane mount failed", err);
  }
}

function closeMaskDebugPane() {
  try {
    maskDebugPane?.unmount();
  } catch (err) {
    warn("mask debug pane unmount failed", err);
  } finally {
    maskDebugPane = null;
  }
}

async function toggleMaskDebugPane() {
  if (maskDebugPane?.pane) {
    closeMaskDebugPane();
    return;
  }
  if (!isEnabled()) {
    try {
      globalThis.ui?.notifications?.warn(
        "Enable “V3 Sandwich Enabled” in module settings first.",
      );
    } catch (_) {}
    return;
  }
  const cv = globalThis.canvas;
  if (!cv?.ready) {
    try {
      globalThis.ui?.notifications?.warn("Open a scene canvas first.");
    } catch (_) {}
    return;
  }
  if (runtimeThreeOverlayWanted && isEnabled() && !layer) {
    await mount();
  }
  openMaskDebugPane();
}

function openV3ModuleConfigPane() {
  if (!globalThis.game?.user?.isGM) {
    try {
      globalThis.ui?.notifications?.warn("Only the GM can open Map Shine V3 configuration.");
    } catch (_) {}
    return;
  }
  if (!v3ModuleConfigPane) {
    v3ModuleConfigPane = new V3ModuleConfigPane({
      onRequestClose: () => {
        closeV3ModuleConfigPane();
      },
      getHost: () => layer,
    });
  }
  try {
    v3ModuleConfigPane.mount();
  } catch (err) {
    warn("V3 module config pane mount failed", err);
  }
}

function closeV3ModuleConfigPane() {
  try {
    v3ModuleConfigPane?.unmount();
  } catch (err) {
    warn("V3 module config pane unmount failed", err);
  } finally {
    v3ModuleConfigPane = null;
  }
}

function toggleV3ModuleConfigPane() {
  if (!globalThis.game?.user?.isGM) {
    try {
      globalThis.ui?.notifications?.warn("Only the GM can open Map Shine V3 configuration.");
    } catch (_) {}
    return;
  }
  if (v3ModuleConfigPane?.pane) {
    closeV3ModuleConfigPane();
    return;
  }
  openV3ModuleConfigPane();
}

/**
 * Register token-toolbar button: V3 mask debug (toggle).
 */
function installV3SceneControls() {
  Hooks.on("getSceneControlButtons", (controls) => {
    try {
      const getControl = (name) => {
        if (!controls) return null;
        if (Array.isArray(controls)) {
          return controls.find((c) => c && c.name === name) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(controls, name)) {
          return controls[name];
        }
        return null;
      };
      const ensureTool = (control, tool) => {
        if (!control?.tools || !tool?.name) return;
        const tools = control.tools;
        if (Array.isArray(tools)) {
          if (!tools.some((t) => t && t.name === tool.name)) tools.push(tool);
          return;
        }
        if (typeof tools === "object") {
          if (!Object.prototype.hasOwnProperty.call(tools, tool.name)) {
            tools[tool.name] = tool;
          }
        }
      };
      const tokenControls = getControl("tokens");
      if (!tokenControls?.tools) return;
      if (globalThis.game?.user?.isGM) {
        ensureTool(tokenControls, {
          name: "map-shine-v3-config",
          title: "Map Shine V3 Config",
          icon: "fas fa-cog",
          order: 100,
          button: true,
          onChange: () => {
            toggleV3ModuleConfigPane();
          },
        });
      }
      ensureTool(tokenControls, {
        name: "v3MaskDebug",
        title: "V3 mask debug",
        icon: "fa-solid fa-mask",
        order: 96,
        button: true,
        onChange: () => {
          void toggleMaskDebugPane();
        },
      });
    } catch (err) {
      warn("getSceneControlButtons (V3 token tools) failed", err);
    }
  });
}

function readFlickerDiagnosticsEnabled() {
  try {
    return game?.settings?.get?.(MODULE_ID, SETTING_V3_FLICKER_DIAG) === true;
  } catch (_) {
    return false;
  }
}

/**
 * Read the shader warmup UX mode setting. Valid values mirror
 * {@link V3ShaderWarmupCoordinator#setMode}:
 *   - `"auto"`   — resolve via persisted adaptive metrics (default).
 *   - `"fast"`   — fast-first-pixel toast.
 *   - `"gated"`  — centered overlay while core compiles.
 *   - `"off"`    — do not show any overlay.
 *
 * @returns {"auto" | "fast" | "gated" | "off"}
 */
function readShaderWarmupModeSetting() {
  try {
    const v = game?.settings?.get?.(MODULE_ID, SETTING_SHADER_WARMUP_MODE);
    if (v === "fast" || v === "gated" || v === "auto" || v === "off") return v;
  } catch (_) {}
  return "auto";
}

/**
 * Mount the shader warmup overlay against the active V3 layer. Idempotent —
 * calling while the overlay is already mounted is a no-op.
 */
function mountShaderWarmupOverlay() {
  const mode = readShaderWarmupModeSetting();
  if (mode === "off") return;
  if (!layer?.shaderWarmup) return;
  try {
    layer.shaderWarmup.setMode(mode === "off" ? "auto" : mode);
  } catch (err) {
    warn("shaderWarmup.setMode failed", err);
  }
  if (!shaderWarmupOverlay) {
    shaderWarmupOverlay = new V3LoadingStatusOverlay({
      getCoordinator: () => layer?.shaderWarmup ?? null,
      getMode: () => {
        const m = readShaderWarmupModeSetting();
        return m === "off" ? "auto" : m;
      },
      warn,
    });
  }
  try {
    shaderWarmupOverlay.mount();
  } catch (err) {
    warn("shader warmup overlay mount failed", err);
  }
}

function unmountShaderWarmupOverlay() {
  if (!shaderWarmupOverlay) return;
  try {
    shaderWarmupOverlay.unmount();
  } catch (err) {
    warn("shader warmup overlay unmount failed", err);
  } finally {
    shaderWarmupOverlay = null;
  }
}

function ensureLayer() {
  if (!layer) {
    layer = new V3ThreeSceneHost({
      logger: { log, warn },
      stopFoundryTicker: readSuppressFoundryPixi(),
      frameBridgeSetting: readFrameBridgeSetting(),
      flickerDiagnosticsEnabled: readFlickerDiagnosticsEnabled,
    });
  }
  return layer;
}

async function mount() {
  if (!isEnabled()) {
    log("mount skipped: disabled in settings");
    return;
  }
  if (!runtimeThreeOverlayWanted) {
    log("mount skipped: Three overlay off (runtime toggle)");
    return;
  }
  const cv = globalThis.canvas;
  if (!cv?.stage || !cv?.ready) {
    warn("mount skipped: canvas not ready");
    return;
  }
  try {
    const host = ensureLayer();
    // Mount the loading overlay BEFORE awaiting host.mount(): the host's
    // texture + mask load happens inside mount(), and the coordinator's
    // `loading-resources` state is set at the very top of mount() so the
    // overlay already has something meaningful to display while those
    // awaits run. Mount-before-await is also what lets the "gated" mode
    // actually gate visually during the slow path.
    mountShaderWarmupOverlay();
    await host.mount(cv);
    log("mounted");
  } catch (err) {
    warn("mount failed", err);
  }
}

/**
 * @param {boolean} want
 */
async function setRuntimeThreeOverlayWanted(want) {
  if (!want) {
    runtimeThreeOverlayWanted = false;
    unmount();
    try {
      maskDebugPane?.syncRuntimeThreeOverlayBinding?.();
    } catch (_) {}
    try {
      maskDebugPane?.notifyHostAvailabilityChanged?.();
    } catch (_) {}
    return;
  }
  if (!isEnabled()) {
    try {
      globalThis.ui?.notifications?.warn(
        "Enable “V3 Sandwich Enabled” in module settings first.",
      );
    } catch (_) {}
    try {
      maskDebugPane?.syncRuntimeThreeOverlayBinding?.();
    } catch (_) {}
    return;
  }
  runtimeThreeOverlayWanted = true;
  await mount();
  if (!layer) {
    runtimeThreeOverlayWanted = false;
    try {
      globalThis.ui?.notifications?.warn(
        "Three overlay did not mount (is the canvas ready?).",
      );
    } catch (_) {}
  }
  try {
    maskDebugPane?.syncRuntimeThreeOverlayBinding?.();
  } catch (_) {}
  try {
    maskDebugPane?.notifyHostAvailabilityChanged?.();
  } catch (_) {}
}

function unmount() {
  restoreFoundryPixiViewDiagnosticIfNeeded();
  // Tear the overlay down first: once the host unmounts, the coordinator is
  // cleared and its snapshot goes to `idle`, which the overlay would then
  // interpret as "warmup finished" and schedule a fade-out. Killing the
  // overlay before that avoids the brief "finished" flash on teardown.
  unmountShaderWarmupOverlay();
  if (!layer) return;
  try {
    layer.unmount();
    log("unmounted");
  } catch (err) {
    warn("unmount failed", err);
  } finally {
    layer = null;
  }
}

function exposeDebugApi() {
  installV3DebugApi({
    moduleId: MODULE_ID,
    settingEnabled: SETTING_ENABLED,
    getLayer: () => layer,
    setRuntimeThreeOverlayWanted: (v) => setRuntimeThreeOverlayWanted(!!v),
    getRuntimeThreeOverlayWanted: () => runtimeThreeOverlayWanted,
    getFoundryPixiViewHiddenForDiagnostic: () => !!_foundryPixiViewDiagnosticStyle,
    setFoundryPixiViewHiddenForDiagnostic: (hidden) => setFoundryPixiViewHiddenForDiagnostic(!!hidden),
    openMaskDebugPane: () => openMaskDebugPane(),
    closeMaskDebugPane: () => closeMaskDebugPane(),
    toggleMaskDebugPane: () => toggleMaskDebugPane(),
    isMaskDebugPaneOpen: () => !!maskDebugPane?.pane,
    openV3ModuleConfigPane: () => openV3ModuleConfigPane(),
    closeV3ModuleConfigPane: () => closeV3ModuleConfigPane(),
    toggleV3ModuleConfigPane: () => toggleV3ModuleConfigPane(),
    isV3ModuleConfigPaneOpen: () => !!v3ModuleConfigPane?.pane,
    getMaskDebugLastProbe: () => maskDebugPane?.lastProbe ?? null,
    mount,
    unmount,
    isEnabled,
    warn,
  });
}

Hooks.once("init", () => {
  try {
    registerV3ModuleSettings({
      moduleId: MODULE_ID,
      settingEnabled: SETTING_ENABLED,
      settingSuppressPixi: SETTING_SUPPRESS_PIXI,
      settingFrameBridge: SETTING_FRAME_BRIDGE,
      settingMaskDebugPane: SETTING_MASK_DEBUG_PANE,
      settingEnforceFpsCap: SETTING_ENFORCE_FPS_CAP,
      settingMaxFpsCap: SETTING_MAX_FPS_CAP,
      settingV3FlickerDiag: SETTING_V3_FLICKER_DIAG,
      settingShaderWarmupMode: SETTING_SHADER_WARMUP_MODE,
      syncFpsPolicyFromSettings,
      warn,
    });
  } catch (err) {
    warn("settings.register failed", err);
  }
  exposeDebugApi();
  // Install the FPS policy as early as possible so the very first
  // `_configurePerformanceMode` call (during Canvas#initialize) is wrapped.
  try {
    syncFpsPolicyFromSettings();
  } catch (err) {
    warn("initial syncFpsPolicyFromSettings failed", err);
  }
  registerV3LifecycleHooks({
    isEnabled,
    getLayer: () => layer,
    warn,
    log,
    syncFpsPolicyFromSettings,
    syncMaskDebugPaneFromSettings,
    scheduleMaskHubComposeFromSceneUpdate,
    sceneUpdateAffectsMaskAssets,
    installV3SceneControls,
    closeMaskDebugPane,
    closeV3ModuleConfigPane,
    unmount,
    getMaskComposeAfterSceneUpdateTimer: () => _maskComposeAfterSceneUpdateTimer,
    clearMaskComposeAfterSceneUpdateTimer,
    mount,
  });
});
