/**
 * Register V3 lifecycle hooks that are wired from the module entrypoint.
 *
 * @param {{
 *   isEnabled: () => boolean,
 *   getLayer: () => any,
 *   warn: (...args: any[]) => void,
 *   log: (...args: any[]) => void,
 *   syncFpsPolicyFromSettings: () => void,
 *   syncMaskDebugPaneFromSettings: () => void,
 *   scheduleMaskHubComposeFromSceneUpdate: (scene: any) => void,
 *   sceneUpdateAffectsMaskAssets: (changes: unknown) => boolean,
 *   installV3SceneControls: () => void,
 *   closeMaskDebugPane: () => void,
 *   closeV3ModuleConfigPane: () => void,
 *   unmount: () => void,
 *   getMaskComposeAfterSceneUpdateTimer: () => ReturnType<typeof setTimeout>|null,
 *   clearMaskComposeAfterSceneUpdateTimer: () => void,
 *   mount: () => Promise<void>,
 * }} deps
 */
export function registerV3LifecycleHooks(deps) {
  const {
    isEnabled,
    getLayer,
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
    getMaskComposeAfterSceneUpdateTimer,
    clearMaskComposeAfterSceneUpdateTimer,
    mount,
  } = deps;

  try {
    Hooks.on("updateScene", (scene, changes) => {
      try {
        if (!isEnabled() || !getLayer()) return;
        if (!sceneUpdateAffectsMaskAssets(changes)) return;
        scheduleMaskHubComposeFromSceneUpdate(scene);
      } catch (e) {
        warn("updateScene (V3 mask recompose) failed", e);
      }
    });
  } catch (err) {
    warn("Hooks.on(updateScene) registration failed", err);
  }

  try {
    Hooks.on("closeSettingsConfig", () => {
      try {
        if (globalThis.canvas?.ready) syncMaskDebugPaneFromSettings();
      } catch (_) {}
    });
  } catch (_) {}

  installV3SceneControls();
  log("init complete");

  Hooks.once("ready", () => {
    log("ready");
  });

  Hooks.on("canvasReady", async () => {
    // Canvas.prototype is now guaranteed resolvable — re-run so the wrapper is
    // installed if `init` ran too early, and re-apply the cap to current tickers.
    try {
      syncFpsPolicyFromSettings();
    } catch (err) {
      warn("canvasReady syncFpsPolicyFromSettings failed", err);
    }
    await mount();
    if (isEnabled()) syncMaskDebugPaneFromSettings();
  });

  Hooks.on("canvasTearDown", () => {
    if (getMaskComposeAfterSceneUpdateTimer()) {
      clearMaskComposeAfterSceneUpdateTimer();
    }
    closeMaskDebugPane();
    closeV3ModuleConfigPane();
    unmount();
  });
}
