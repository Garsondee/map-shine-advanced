import {
  V3_FRAME_BRIDGE_SETTING,
  V3_FRAME_BRIDGE_SETTING_LABELS,
} from "./V3PixiThreeFrameBridge.js";
import {
  V3_FPS_POLICY_HARD_MAX,
  V3_FPS_POLICY_DEFAULT_CAP,
  V3_FPS_POLICY_MIN_CAP,
} from "./V3FpsPolicy.js";

/**
 * Register all module settings used by the V3 runtime.
 *
 * @param {{
 *   moduleId: string,
 *   settingEnabled: string,
 *   settingSuppressPixi: string,
 *   settingFrameBridge: string,
 *   settingMaskDebugPane: string,
 *   settingEnforceFpsCap: string,
 *   settingMaxFpsCap: string,
 *   settingV3FlickerDiag: string,
 *   settingShaderWarmupMode?: string,
 *   syncFpsPolicyFromSettings: () => void,
 *   warn: (...args: any[]) => void,
 * }} deps
 */
export function registerV3ModuleSettings(deps) {
  const {
    moduleId,
    settingEnabled,
    settingSuppressPixi,
    settingFrameBridge,
    settingMaskDebugPane,
    settingEnforceFpsCap,
    settingMaxFpsCap,
    settingV3FlickerDiag,
    settingShaderWarmupMode,
    syncFpsPolicyFromSettings,
    warn,
  } = deps;

  game.settings.register(moduleId, settingEnabled, {
    name: "V3 Sandwich Enabled",
    hint:
      "Render the experimental V3 floor sandwich (lower -> procedural -> upper) in Three.js, " +
      "with Foundry PIXI on top for grid and UI. Native Foundry fog/visibility is disabled while V3 is mounted " +
      "(that draw is opaque over a second WebGL canvas). The module sets canvasConfig " +
      "`backgroundAlpha: 0` at PIXI.Application creation (see v13 canvas-replacement). " +
      "If `V3Shine.diag().pixiContextAlpha` is still false, do a full reload (F5) so the board is rebuilt with that config.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(moduleId, settingSuppressPixi, {
    name: "V3: Stop Foundry PIXI ticker",
    hint: "When enabled, stops the PIXI ticker (pan/zoom and most canvas updates freeze). Leave disabled for normal navigation while Three draws on top.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
  game.settings.register(moduleId, settingFrameBridge, {
    name: "V3: PIXI ↔ Three frame order",
    hint:
      "Which PIXI ticker priority runs the Three.js pass relative to Foundry’s canvas render. " +
      "Default runs Three immediately after Foundry’s LOW render to reduce two-canvas flicker; " +
      "“Late (UTILITY)” is the older timing if you need to compare. " +
      "After changing, run V3Shine.rebuild() or reload the page so the mounted host picks it up.",
    scope: "client",
    config: true,
    type: String,
    choices: V3_FRAME_BRIDGE_SETTING_LABELS,
    default: V3_FRAME_BRIDGE_SETTING.UTILITY_AFTER_LOW,
  });
  game.settings.register(moduleId, settingMaskDebugPane, {
    name: "V3: Tweakpane — suffixed mask viewer",
    hint:
      "Floating panel: inspect the hub’s per-floor mask table (from the scene-configured + scanned manifest) " +
      "and click any entry to overlay it. The pane no longer HEAD-probes — use its “Rescan assets” button " +
      "(GM: persists to the scene flag; non-GM: in-memory only). " +
      "Console: V3Shine.openMaskDebugPane() / closeMaskDebugPane(). After toggling here, close this window or reload.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(moduleId, settingEnforceFpsCap, {
    name: "V3: Enforce FPS ceiling (PIXI + Three)",
    hint:
      "Apply a hard upper bound to every PIXI ticker (`app`, `Ticker.shared`, `Ticker.system`) " +
      "after Foundry's own `_configurePerformanceMode` runs, so Foundry's MAX-mode uncap (core.maxFPS=0) " +
      "cannot produce more than the limit below. The Three.js composite runs from PIXI `postrender` so it " +
      "inherits the same cap; the rAF fallback in V3PixiThreeFrameBridge self-throttles to the same value.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      try { syncFpsPolicyFromSettings(); } catch (err) { warn("syncFpsPolicyFromSettings failed", err); }
    },
  });
  game.settings.register(moduleId, settingMaxFpsCap, {
    name: "V3: Maximum FPS (hard ceiling)",
    hint:
      `Never exceed this frame rate in either PIXI or Three.js. Valid range ${V3_FPS_POLICY_MIN_CAP}-${V3_FPS_POLICY_HARD_MAX}. ` +
      "Applied after Foundry's performance mode; values above the hard ceiling are clamped.",
    scope: "client",
    config: true,
    type: Number,
    range: { min: V3_FPS_POLICY_MIN_CAP, max: V3_FPS_POLICY_HARD_MAX, step: 10 },
    default: V3_FPS_POLICY_DEFAULT_CAP,
    onChange: () => {
      try { syncFpsPolicyFromSettings(); } catch (err) { warn("syncFpsPolicyFromSettings failed", err); }
    },
  });
  game.settings.register(moduleId, settingV3FlickerDiag, {
    name: "V3: Flicker diagnostics (console)",
    hint:
      "Logs to the browser console when more than one Three.js composite runs in a single animation frame " +
      "(can cause visible two-canvas flicker) or when the Three or PIXI WebGL context is lost/restored. " +
      "Leave off normally; use while reproducing flicker, then check `V3Shine.diag().flickerDiagnostics`.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
  if (settingShaderWarmupMode) {
    game.settings.register(moduleId, settingShaderWarmupMode, {
      name: "V3: Shader warmup UX",
      hint:
        "How the V3 shader warmup is surfaced on scene load. " +
        "“Auto” uses an adaptive overlay based on the previous session’s core compile time " +
        "(fast toast when compile was quick, centered gated overlay when it was long). " +
        "“Fast” always shows the non-blocking toast, “Gated” always shows the centered overlay, " +
        "“Off” suppresses the overlay entirely (compile still runs in staged yields; see " +
        "V3Shine.diag().shaderWarmup).",
      scope: "client",
      config: true,
      type: String,
      choices: {
        auto: "Auto (adaptive)",
        fast: "Fast toast",
        gated: "Gated overlay",
        off: "Off",
      },
      default: "auto",
    });
  }
}
