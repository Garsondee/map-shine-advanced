import { V3_RENDER_CONVENTIONS } from "./V3RenderConventions.js";
import { buildLevelTextureInventory } from "./V3LevelTextureCatalog.js";
import { probeAllMasksForLevel } from "./V3MaskProbe.js";
import { listMaskIds } from "./V3EffectMaskRegistry.js";
import { getViewedLevelIndex } from "./V3ViewedLevel.js";
import {
  V3_MASK_CATALOG,
  V3_CONSUMER_CATALOG,
  listAllMaskIds,
  listAuthoredMaskIds,
  listDerivedMaskIds,
} from "./V3MaskCatalog.js";
import { runMaskDiagnostics } from "./V3MaskDiagnostics.js";
import { snapshotFpsPolicy } from "./V3FpsPolicy.js";

/**
 * Install `window.V3Shine` debug helpers.
 *
 * @param {{
 *   moduleId: string,
 *   settingEnabled: string,
 *   getLayer: () => any,
 *   setRuntimeThreeOverlayWanted: (v: boolean) => Promise<void>|void,
 *   getRuntimeThreeOverlayWanted: () => boolean,
 *   getFoundryPixiViewHiddenForDiagnostic: () => boolean,
 *   setFoundryPixiViewHiddenForDiagnostic: (hidden: boolean) => { ok: boolean, reason?: string },
 *   openMaskDebugPane: () => void,
 *   closeMaskDebugPane: () => void,
 *   toggleMaskDebugPane: () => Promise<void>,
 *   isMaskDebugPaneOpen: () => boolean,
 *   openV3ModuleConfigPane: () => void,
 *   closeV3ModuleConfigPane: () => void,
 *   toggleV3ModuleConfigPane: () => void,
 *   isV3ModuleConfigPaneOpen: () => boolean,
 *   getMaskDebugLastProbe: () => any,
 *   mount: () => Promise<void>,
 *   unmount: () => void,
 *   isEnabled: () => boolean,
 *   warn: (...args: any[]) => void,
 * }} deps
 */
export function installV3DebugApi(deps) {
  if (typeof window === "undefined") return;
  const {
    moduleId,
    settingEnabled,
    getLayer,
    setRuntimeThreeOverlayWanted,
    getRuntimeThreeOverlayWanted,
    getFoundryPixiViewHiddenForDiagnostic,
    setFoundryPixiViewHiddenForDiagnostic,
    openMaskDebugPane,
    closeMaskDebugPane,
    toggleMaskDebugPane,
    isMaskDebugPaneOpen,
    openV3ModuleConfigPane,
    closeV3ModuleConfigPane,
    toggleV3ModuleConfigPane,
    isV3ModuleConfigPaneOpen,
    getMaskDebugLastProbe,
    mount,
    unmount,
    isEnabled,
    warn,
  } = deps;
  window.V3Shine = {
    enable: async () => {
      try { await game?.settings?.set?.(moduleId, settingEnabled, true); } catch (_) {}
      await setRuntimeThreeOverlayWanted(true);
    },
    disable: async () => {
      try { await game?.settings?.set?.(moduleId, settingEnabled, false); } catch (_) {}
      await setRuntimeThreeOverlayWanted(false);
    },
    rebuild: async () => {
      unmount();
      await mount();
    },
    setUniforms: (partial) => {
      try { getLayer()?.setUniforms(partial); } catch (err) { warn("setUniforms failed", err); }
    },
    renderConventions: () => ({ ...V3_RENDER_CONVENTIONS }),
    diag: () => {
      try {
        const base = getLayer()?.diag() ?? { mounted: false, reason: "no layer" };
        /** @type {any} */ const augmented = base && typeof base === "object" ? base : { raw: base };
        try { augmented.fpsPolicy = snapshotFpsPolicy(); } catch (_) {}
        return augmented;
      }
      catch (err) { return { error: String(err) }; }
    },
    fpsPolicy: () => {
      try { return snapshotFpsPolicy(); }
      catch (err) { return { error: String(err) }; }
    },
    validateSync: async ({ durationMs = 4000, sampleCount = 8 } = {}) => {
      const host = getLayer();
      if (!host) return { ok: false, reason: "no-layer" };
      const policy0 = snapshotFpsPolicy();
      const d0 = host.diag?.();
      const cap = policy0.effectiveCap ?? policy0.desiredCap ?? null;
      const t0 = (performance?.now?.() ?? Date.now());
      const startFrames = d0?.frameCount ?? 0;
      const startMain = d0?.postrenderProfile?.mainScreenComposites ?? 0;
      const startDrive = d0?.threeCompositeDrive ?? "none";
      /** @type {Array<{tMs:number, frames:number, fpsSince:number, drive:string}>} */
      const samples = [];
      const interval = Math.max(50, Math.floor(durationMs / Math.max(1, sampleCount)));
      await new Promise((resolve) => {
        let lastT = t0;
        let lastFrames = startFrames;
        const tick = () => {
          const now = performance?.now?.() ?? Date.now();
          const d = host.diag?.();
          const f = d?.frameCount ?? lastFrames;
          const dt = Math.max(1, now - lastT);
          const fpsSince = ((f - lastFrames) * 1000) / dt;
          samples.push({
            tMs: now - t0,
            frames: f,
            fpsSince,
            drive: d?.threeCompositeDrive ?? "none",
          });
          lastT = now;
          lastFrames = f;
          if ((now - t0) >= durationMs) return resolve(null);
          setTimeout(tick, interval);
        };
        setTimeout(tick, interval);
      });
      const d1 = host.diag?.();
      const tN = (performance?.now?.() ?? Date.now());
      const elapsedSec = (tN - t0) / 1000;
      const totalFrames = Math.max(0, (d1?.frameCount ?? startFrames) - startFrames);
      const meanFps = elapsedSec > 0 ? totalFrames / elapsedSec : 0;
      const maxSampleFps = samples.reduce(
        (m, s) => (Number.isFinite(s.fpsSince) && s.fpsSince > m ? s.fpsSince : m),
        0,
      );
      const driveChanges = samples.filter(
        (s, i, a) => i > 0 && s.drive !== a[i - 1].drive,
      ).length;
      const policy1 = snapshotFpsPolicy();
      const compositesInWindow = Math.max(
        0,
        (d1?.postrenderProfile?.mainScreenComposites ?? startMain) - startMain,
      );
      const capExceeded = Number.isFinite(cap) && cap != null
        ? maxSampleFps > cap + 3
        : false;
      return {
        ok: !capExceeded && driveChanges === 0,
        cap,
        meanFps,
        maxSampleFps,
        totalFrames,
        compositesInWindow,
        elapsedSec,
        startDrive,
        endDrive: d1?.threeCompositeDrive ?? "none",
        driverTransitions: driveChanges,
        coalesceMode: d1?.postrenderProfile?.coalesceMode ?? null,
        rafFallback: d1?.frameBridge?.rafFallback ?? null,
        fpsPolicyBefore: policy0,
        fpsPolicyAfter: policy1,
        samples,
        issues: [
          capExceeded ? `maxSampleFps ${maxSampleFps.toFixed(1)} > cap ${cap}` : null,
          driveChanges > 0 ? `driver transitioned ${driveChanges} time(s)` : null,
        ].filter(Boolean),
      };
    },
    probePixel: (x, y) => {
      try { return getLayer()?.probePixel(x, y) ?? null; }
      catch (err) { return { error: String(err) }; }
    },
    textureInventory: () => {
      try {
        return buildLevelTextureInventory(globalThis.canvas?.scene ?? null);
      } catch (err) {
        return { error: String(err) };
      }
    },
    showLevelTextureDebug: async (opts) => {
      const host = getLayer();
      if (!host) {
        warn("showLevelTextureDebug: V3 layer not mounted (enable V3 + canvas ready)");
        return { ok: false, reason: "no-layer" };
      }
      try {
        return await host.setLevelTextureDebug(opts ?? {});
      } catch (err) {
        warn("showLevelTextureDebug failed", err);
        return { ok: false, reason: String(err) };
      }
    },
    hideLevelTextureDebug: () => {
      try {
        getLayer()?.clearLevelTextureDebug();
      } catch (err) {
        warn("hideLevelTextureDebug failed", err);
      }
    },
    showLevelTextureDebugFromUrl: async (url, opts) => {
      const host = getLayer();
      if (!host) return { ok: false, reason: "no-layer" };
      try {
        return await host.setLevelTextureDebugFromUrl(url, opts ?? {});
      } catch (err) {
        return { ok: false, reason: String(err) };
      }
    },
    maskRegistryIds: () => listMaskIds(),
    probeMasksForFloor: async (levelIndex) => {
      try {
        return await probeAllMasksForLevel(globalThis.canvas?.scene ?? null, levelIndex, {
          concurrency: 6,
        });
      } catch (err) {
        return { error: String(err) };
      }
    },
    getRuntimeThreeOverlayWanted: () => getRuntimeThreeOverlayWanted(),
    setRuntimeThreeOverlayWanted: (v) => setRuntimeThreeOverlayWanted(!!v),
    setFoundryPixiViewHiddenForDiagnostic: (hidden) => setFoundryPixiViewHiddenForDiagnostic(!!hidden),
    getFoundryPixiViewHiddenForDiagnostic: () => getFoundryPixiViewHiddenForDiagnostic(),
    openMaskDebugPane: () => openMaskDebugPane(),
    closeMaskDebugPane: () => closeMaskDebugPane(),
    toggleMaskDebugPane: () => toggleMaskDebugPane(),
    isMaskDebugPaneOpen: () => isMaskDebugPaneOpen(),
    openV3ModuleConfigPane: () => openV3ModuleConfigPane(),
    closeV3ModuleConfigPane: () => closeV3ModuleConfigPane(),
    toggleV3ModuleConfigPane: () => toggleV3ModuleConfigPane(),
    isV3ModuleConfigPaneOpen: () => isV3ModuleConfigPaneOpen(),
    getViewedLevelIndex: () => {
      try {
        return getViewedLevelIndex(globalThis.canvas?.scene ?? null);
      } catch (err) {
        return { error: String(err) };
      }
    },
    getMaskDebugLastProbe: () => getMaskDebugLastProbe(),
    masks: {
      catalog: () => ({
        masks: V3_MASK_CATALOG,
        consumers: V3_CONSUMER_CATALOG,
      }),
      listIds: () => listAllMaskIds(),
      listAuthoredIds: () => listAuthoredMaskIds(),
      listDerivedIds: () => listDerivedMaskIds(),
      snapshot: () => getLayer()?.maskHub?.snapshot?.() ?? null,
      cacheVersion: () => getLayer()?.maskHub?.getCacheVersion?.() ?? null,
      activeFloorKey: () => getLayer()?.maskHub?.getActiveFloorKey?.() ?? null,
      floor: (floorKey) => getLayer()?.maskHub?.listFloorMaskRecords?.(String(floorKey)) ?? [],
      refresh: () => getLayer()?.maskHub?.compose?.() ?? Promise.resolve(),
      rescan: (opts) => getLayer()?.maskHub?.compose?.({ rescan: true, persist: opts?.persist }) ?? Promise.resolve(),
      manifest: () => getLayer()?.maskHub?.getManifest?.() ?? null,
      inventoryDiagnostics: () => getLayer()?.assetInventory?.diagnostics?.() ?? null,
      canStackMatte: (maskId) => getLayer()?.maskHub?.canBuildStackMatte?.(String(maskId)) ?? false,
      get: async (floorKey, maskId, opts) => {
        const hub = getLayer()?.maskHub;
        if (!hub) return { ok: false, reason: "no-hub" };
        const { texture, meta } = await hub.getFloorMask(floorKey, maskId, opts ?? {});
        return { ok: !!texture, meta, hasTexture: !!texture };
      },
      preview: async (maskId, opts = {}) => {
        const host = getLayer();
        if (!host?.maskHub) return { ok: false, reason: "no-hub" };
        const floorKey = opts.floorKey ?? host.maskHub.getActiveFloorKey();
        const { texture, meta } = await host.maskHub.getFloorMask(floorKey, maskId, {
          purpose: opts.purpose,
          authoredOnly: opts.authoredOnly,
          allowSpeculativeDiskUrl: opts.allowSpeculativeDiskUrl === true,
        });
        if (!texture) return { ok: false, reason: "no-texture", meta };
        return host.setLevelTextureDebugFromHubTexture(texture, {
          opacity: opts.opacity ?? 0.75,
          channelView: opts.channelView,
          label: `${floorKey}/${maskId}`,
          owned: false,
        });
      },
      bindings: () => getLayer()?.maskBindings?.snapshot?.() ?? null,
      registerConsumer: (reg) => getLayer()?.maskBindings?.register?.(reg) ?? (() => {}),
      validate: () => getLayer()?.maskHub?.validate?.() ?? { ok: false, issues: ["no-hub"] },
      diagnose: () => runMaskDiagnostics({ host: getLayer() }),
    },
    effects: {
      snapshot: () => getLayer()?.effectChain?.snapshot?.() ?? null,
      hasActive: () => getLayer()?.effectChain?.hasAnyActiveEffects?.() ?? false,
      register: (effect) => getLayer()?.effectChain?.register?.(effect) ?? (() => {}),
      unregister: (id) => getLayer()?.effectChain?.unregister?.(id) ?? false,
      get: (id) => getLayer()?.effectChain?.getEffect?.(String(id)) ?? null,
      toggleDotScreen: (on) => {
        const eff = getLayer()?.dotScreenEffect;
        if (!eff) return { ok: false, reason: "no-effect" };
        eff.enabled = !!on;
        return { ok: true, enabled: !!eff.enabled };
      },
      dotScreenParams: () => getLayer()?.dotScreenEffect?.params ?? null,
      toggleBloom: (on) => {
        const eff = getLayer()?.bloomEffect;
        if (!eff) return { ok: false, reason: "no-effect" };
        eff.enabled = !!on;
        return { ok: true, enabled: !!eff.enabled };
      },
      bloomParams: () => getLayer()?.bloomEffect?.params ?? null,
      toggleHalftone: (on) => {
        const eff = getLayer()?.halftoneEffect;
        if (!eff) return { ok: false, reason: "no-effect" };
        eff.enabled = !!on;
        return { ok: true, enabled: !!eff.enabled };
      },
      halftoneParams: () => getLayer()?.halftoneEffect?.params ?? null,
      toggleInvert: (on) => {
        const eff = getLayer()?.invertEffect;
        if (!eff) return { ok: false, reason: "no-effect" };
        eff.enabled = !!on;
        return { ok: true, enabled: !!eff.enabled };
      },
      invertParams: () => getLayer()?.invertEffect?.params ?? null,
      toggleBuildingShadows: (on) => {
        const bs = getLayer()?.buildingShadows;
        if (!bs) return { ok: false, reason: "no-effect" };
        bs.enabled = !!on;
        return { ok: true, enabled: !!bs.enabled };
      },
      buildingShadowsParams: () => getLayer()?.buildingShadows ?? null,
      buildingShadowsDiag: () => getLayer()?.buildingShadowsPass?.getDiagnostics?.() ?? null,
    },
    shaderWarmup: {
      /**
       * Full snapshot of the coordinator. Shape documented on
       * {@link V3ShaderWarmupCoordinator#snapshot}.
       */
      snapshot: () => getLayer()?.shaderWarmup?.snapshot?.() ?? null,
      /**
       * Flat stage list with timing/status. Useful for answering "which
       * stage took the longest?" from the console.
       */
      stages: () => {
        const snap = getLayer()?.shaderWarmup?.snapshot?.();
        if (!snap) return null;
        return [...(snap.tiers?.core ?? []), ...(snap.tiers?.optional ?? [])];
      },
      /**
       * Sum of real compile time per tier. Excludes event-loop yield time,
       * so these are "on-CPU GL compile" numbers rather than wall clock.
       */
      totals: () => {
        const snap = getLayer()?.shaderWarmup?.snapshot?.();
        if (!snap) return null;
        const sum = (arr) => arr.reduce((acc, s) => acc + (Number(s.durationMs) || 0), 0);
        return {
          core: Math.round(sum(snap.tiers?.core ?? [])),
          optional: Math.round(sum(snap.tiers?.optional ?? [])),
          coreWallMs: snap.coreDurationMs != null ? Math.round(snap.coreDurationMs) : null,
          fullyWarmWallMs: snap.fullyWarmDurationMs != null
            ? Math.round(snap.fullyWarmDurationMs)
            : null,
          state: snap.state,
          resolvedMode: snap.resolvedMode,
        };
      },
      /**
       * @param {"fast" | "gated" | "auto" | "off"} mode
       * Updates both the persisted setting and the live coordinator. `"off"`
       * persists as `"off"` (the overlay suppresses itself) but the live
       * coordinator falls back to `"auto"` because its runtime only accepts
       * fast/gated/auto.
       */
      setMode: async (mode) => {
        const normalized = (mode === "fast" || mode === "gated" || mode === "auto" || mode === "off")
          ? mode
          : "auto";
        try {
          await game?.settings?.set?.(moduleId, "v3ShaderWarmupMode", normalized);
        } catch (err) {
          warn("setMode settings.set failed", err);
        }
        const coord = getLayer()?.shaderWarmup;
        if (coord?.setMode) {
          try { coord.setMode(normalized === "off" ? "auto" : normalized); }
          catch (err) { warn("setMode coord failed", err); }
        }
        return { ok: true, mode: normalized };
      },
      getMode: () => getLayer()?.shaderWarmup?.getMode?.() ?? null,
      /**
       * @returns {"fast" | "gated" | null}
       */
      resolvedMode: () => getLayer()?.shaderWarmup?.resolvedMode?.() ?? null,
      /**
       * Full adaptive decision incl. rationale, statistic, threshold, and
       * hardware snapshot. Lets users understand why Auto landed on fast
       * vs gated without squinting at the code.
       */
      policy: () => getLayer()?.shaderWarmup?.adaptiveDecision?.() ?? null,
      /**
       * Last hardware fingerprint probed at mount time (GPU strings,
       * cpu cores, device memory, tier).
       */
      hardware: () => getLayer()?.shaderWarmup?.snapshot?.()?.hardware ?? null,
      /** Adaptive metrics persisted in `localStorage`. */
      persistedMetrics: () => getLayer()?.shaderWarmup?.readPersistedMetrics?.() ?? null,
      /**
       * Clear persisted adaptive metrics so the next mount resolves
       * `"auto"` as `"fast"` until a fresh core sample is recorded.
       */
      clearPersistedMetrics: () => {
        try {
          globalThis.localStorage?.removeItem?.("mapShineV3.warmup.metrics.v1");
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: String(err) };
        }
      },
    },
    checklist: () => console.log(
      "V3Shine verification:\n" +
      "  V3Shine.diag()                    - inspect srcs, textures, rect, uniforms\n" +
      "  V3Shine.probePixel(sceneX,sceneY) - RGBA readback at a scene point\n" +
      "  V3Shine.setUniforms({checkerOpacity:1})         - crank visibility\n" +
      "  V3Shine.setUniforms({inputsPremultiplied:true}) - premultiplied source art\n" +
      "  V3Shine.setUniforms({flipBackgroundTextureY:false}) - runtime V flip (default from V3RenderConventions.js)\n" +
      "  V3Shine.renderConventions()           - see frozen defaults\n" +
      "  V3Shine.diag().frameBridge            - PIXI↔Three drive + priority\n" +
      "  V3Shine.diag().postrenderProfile      - coalesce mode, burst max/mean, latency\n" +
      "  V3Shine.diag().flickerDiagnostics     - composites/animation frame + GL context loss counts (enable setting below)\n" +
      "  V3Shine.fpsPolicy()                   - installed wrapper + desired/effective cap + ticker reads\n" +
      "  V3Shine.validateSync({durationMs:4000}) - sample-and-report stress validation (pan/zoom while it runs)\n" +
      "  V3Shine.textureInventory()          - suffixed / per-level texture URLs\n" +
      "  V3Shine.openMaskDebugPane() / closeMaskDebugPane() — Tweakpane: masks + Illumination (policy v1)\n" +
      "  V3Shine.getRuntimeThreeOverlayWanted() / setRuntimeThreeOverlayWanted(bool) — PIXI vs Three map (runtime)\n" +
      "  V3Shine.setFoundryPixiViewHiddenForDiagnostic(true|false) — hide Foundry PIXI view (CSS) for flicker A/B; auto-restored on unmount\n" +
      "\n" +
      "Mask hub (V3 single source of truth):\n" +
      "  V3Shine.masks.snapshot()                         - full per-floor table\n" +
      "  V3Shine.masks.cacheVersion()                     - monotonic change counter\n" +
      "  V3Shine.masks.activeFloorKey()                   - viewed floor (floor0, floor1...)\n" +
      "  V3Shine.masks.floor('floor1')                    - records for one floor\n" +
      "  V3Shine.masks.preview('outdoors',{purpose:'sky'})- preview via hub (derives skyReach)\n" +
      "  V3Shine.masks.refresh()                          - rebuild floor table from current manifest (no network)\n" +
      "  V3Shine.masks.rescan()                           - GM-only: FilePicker.browse scan + persist\n" +
      "  V3Shine.masks.manifest()                         - current inventory manifest snapshot\n" +
      "  V3Shine.masks.inventoryDiagnostics()             - discovery counters and cached scene ids\n" +
      "  V3Shine.masks.bindings()                         - consumer rebind state\n" +
      "  V3Shine.masks.validate()                         - orientation/status sanity check\n" +
      "\n" +
      "Screen-space effect chain:\n" +
      "  V3Shine.effects.snapshot()                       - chain state + per-phase effect list\n" +
      "  V3Shine.effects.hasActive()                      - any enabled effect?\n" +
      "  V3Shine.effects.toggleDotScreen(true)            - enable the built-in halftone\n" +
      "  V3Shine.effects.dotScreenParams()                - mutate live (strength/scale/angle/center)\n" +
      "  V3Shine.effects.toggleBloom(true)                - enable Unreal-style bloom\n" +
      "  V3Shine.effects.bloomParams()                    - strength / radius / threshold / tint / …\n" +
      "  V3Shine.effects.toggleBuildingShadows(true)      - enable V3 sun-cast building shadows (alpha-hole cascade)\n" +
      "  V3Shine.effects.buildingShadowsParams()          - opacity / length / sun / alphaHoleLo|Hi / …\n" +
      "  V3Shine.effects.buildingShadowsDiag()            - last run frame/ms, RT size, cascaded floor count\n" +
      "  V3Shine.effects.register({...}) / .unregister(id)- add / remove custom effects\n" +
      "\n" +
      "Shader warmup (staged compile UX):\n" +
      "  V3Shine.shaderWarmup.snapshot()                  - state, progress, stage list\n" +
      "  V3Shine.shaderWarmup.stages()                    - flat stage list with durationMs / status\n" +
      "  V3Shine.shaderWarmup.totals()                    - core/optional compile totals + wall time\n" +
      "  V3Shine.shaderWarmup.setMode('auto'|'fast'|'gated'|'off') - overlay UX mode (persists setting)\n" +
      "  V3Shine.shaderWarmup.resolvedMode()              - adaptive resolution of 'auto'\n" +
      "  V3Shine.shaderWarmup.policy()                    - adaptive decision + rationale (samples, tier, threshold)\n" +
      "  V3Shine.shaderWarmup.hardware()                  - probed GPU vendor/renderer + classification tier\n" +
      "  V3Shine.shaderWarmup.persistedMetrics()          - last core/fully-warm duration snapshot\n" +
      "  V3Shine.shaderWarmup.clearPersistedMetrics()     - forget adaptive history (reverts to fast)\n" +
      "\n" +
      "  V3Shine.rebuild()                 - full remount (needed after frame-order setting change)"
    ),
  };
}
