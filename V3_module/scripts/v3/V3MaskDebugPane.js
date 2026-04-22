/**
 * @fileoverview **Mask inspector** — a Tweakpane UI over {@link V3MaskHub}.
 *
 * The pane no longer probes or loads masks itself: it subscribes to the hub,
 * reads per-floor records (authored + derived), and drives the debug overlay
 * by passing hub-owned textures straight into the host.
 *
 * Responsibilities:
 *   - list every mask in the catalog for the active (viewed) floor
 *   - show status (ready / missing / loading) + URL / derived tag
 *   - preview any ready mask on click (hub fetches/derives the texture)
 *   - persist UI state (pinned mask id, checker params, overlay α)
 *   - keep outdoors 'surface' vs 'sky' both available as separate buttons
 *
 * With “Match viewed floor” on and the scene viewed from an upper level,
 * **authored** mask previews use the hub’s **stack matte** (lower + upper
 * disk masks matted by upper albedo α) when either floor supplies that mask —
 * so e.g. `_Water` on the ground floor is still previewable from floor1.
 * With manual floor selection, previews stay **per-floor disk** only.
 *
 * @module v3/V3MaskDebugPane
 */

import { Pane } from "../vendor/tweakpane.js";
import {
  V3_MASK_CATALOG,
  listAuthoredMaskIds,
  listDerivedMaskIds,
  getMaskEntry,
} from "./V3MaskCatalog.js";
import { V3_DEFAULTS } from "./V3ThreeSandwichCompositor.js";
import {
  loadMaskDebugState,
  saveMaskDebugState,
  saveSkyLightingDebugState,
  saveLightAppearanceDebugState,
  saveSceneColorGradeDebugState,
  saveTokenColorGradeDebugState,
} from "./V3MaskDebugStorage.js";
import { getViewedLevelIndex } from "./V3ViewedLevel.js";
import { countStackedBackgroundLevels } from "./V3MaskProbe.js";

/**
 * @param {import('./V3MaskCatalog.js').MaskCatalogEntry|null} entry
 * @returns {'rgba'|'r'|'a'}
 */
function channelForEntry(entry) {
  const c = entry?.debugChannel;
  if (c === "rgba" || c === "r" || c === "a") return c;
  return "r";
}

/**
 * Encodes which mask/purpose a button represents. `surface` and `sky` view
 * of outdoors get separate rows so the user can inspect the authored mask
 * independently from the hub-derived skyReach composite.
 *
 * @typedef {{
 *   id: string,            // hub id ('outdoors', 'skyReach', 'specular', ...)
 *   label: string,         // display label for button + persistence key
 *   catalogId: string,     // always points at V3_MASK_CATALOG entry
 *   purpose?: 'surface'|'sky',
 * }} InspectorRow
 */

/**
 * @returns {InspectorRow[]} Stable per-pane button list.
 */
function buildInspectorRows() {
  const rows = [];
  for (const id of listAuthoredMaskIds()) {
    if (id === "outdoors") {
      rows.push({
        id: "outdoors",
        catalogId: "outdoors",
        purpose: "surface",
        label: "outdoors (surface)",
      });
    } else {
      rows.push({ id, catalogId: id, label: id });
    }
  }
  for (const id of listDerivedMaskIds()) {
    const entry = V3_MASK_CATALOG[id];
    if (entry?.internal) continue;
    rows.push({
      id,
      catalogId: id,
      label: id === "skyReach" ? "skyReach (sky)" : `${id} (derived)`,
      ...(id === "skyReach" ? { purpose: "sky" } : {}),
    });
  }
  return rows;
}

export class V3MaskDebugPane {
  /**
   * @param {{
   *   getHost: () => (import('./V3ThreeSceneHost.js').V3ThreeSceneHost|null),
   *   getRuntimeThreeOverlayWanted?: () => boolean,
   *   setRuntimeThreeOverlayWanted?: (want: boolean) => void | Promise<void>,
   * }} opts
   */
  constructor(opts) {
    this.getHost = typeof opts.getHost === "function" ? opts.getHost : () => null;
    this.getRuntimeThreeOverlayWanted =
      typeof opts.getRuntimeThreeOverlayWanted === "function"
        ? opts.getRuntimeThreeOverlayWanted
        : () => true;
    this.setRuntimeThreeOverlayWanted =
      typeof opts.setRuntimeThreeOverlayWanted === "function"
        ? opts.setRuntimeThreeOverlayWanted
        : () => {};

    /** @type {{ threeJsMap: boolean }|null} */ this._renderPath = null;

    /** @type {Pane|null} */ this.pane = null;
    /** @type {import('../vendor/tweakpane.js').FolderApi|null} */ this._maskFolder = null;
    /** @type {import('../vendor/tweakpane.js').FolderApi|null} */ this._inventoryFolder = null;
    /** @type {number} */ this._lastInventoryCacheVersion = -1;

    const _stored = loadMaskDebugState({
      followViewedFloor: true,
      manualFloor: 0,
      overlayOpacity: 0.45,
      checkerOpacity: V3_DEFAULTS.checkerOpacity,
      checkerSizePx: V3_DEFAULTS.checkerSizePx,
    });
    this.params = _stored.params;
    /** @type {string|null} */ this._pinnedPreviewId = _stored.pinnedPreviewMaskId;

    /** @type {() => void | null} */ this._unsubscribeHub = null;
    /** @type {ReturnType<typeof setInterval>|null} */ this._pollTimer = null;
    /** @type {string|null} */ this._lastActiveFloorKey = null;
    /** @type {number} */ this._lastCacheVersion = -1;

    /** @type {InspectorRow[]} */ this._rows = buildInspectorRows();
    /** @type {Map<string, import('../vendor/tweakpane.js').ButtonApi>} */
    this._buttonsById = new Map();

    /**
     * Last-successfully-previewed row, for overlayOpacity live-updates.
     * @type {InspectorRow|null}
     */
    this._lastPreviewRow = null;
  }

  /** Called from `module.js` after mount/unmount so the checkbox matches the module flag. */
  syncRuntimeThreeOverlayBinding() {
    this._syncRenderPathBinding();
  }

  /** Re-subscribe to the mask hub and rebuild lists when the Three host appears/disappears. */
  notifyHostAvailabilityChanged() {
    try {
      this._unsubscribeHub?.();
    } catch (_) {}
    this._unsubscribeHub = null;
    const hub = this.getHost()?.maskHub ?? null;
    if (hub) {
      try {
        this._unsubscribeHub = hub.subscribe(() => this._rebuildFolder());
      } catch (_) {}
    }
    this._rebuildFolder();
    this._applyCheckerUniforms();
  }

  _syncRenderPathBinding() {
    if (!this._renderPath || !this.pane) return;
    this._renderPath.threeJsMap = this.getRuntimeThreeOverlayWanted() !== false;
    try {
      this.pane.refresh();
    } catch (_) {}
  }

  _persistSettings() {
    try {
      saveMaskDebugState(this.params, this._pinnedPreviewId);
    } catch (_) {}
  }

  _applyCheckerUniforms() {
    const host = this.getHost();
    if (!host?.setUniforms) return;
    try {
      host.setUniforms({
        checkerOpacity: this.params.checkerOpacity,
        checkerSizePx: this.params.checkerSizePx,
      });
    } catch (_) {}
  }

  _getScene() {
    const host = this.getHost();
    return host?.canvas?.scene ?? globalThis.canvas?.scene ?? null;
  }

  _effectiveFloorKey() {
    const host = this.getHost();
    if (!host?.maskHub) return "floor0";
    if (this.params.followViewedFloor) return host.maskHub.getActiveFloorKey();
    return host.maskHub.floorKeyForIndex(Math.max(0, Math.round(this.params.manualFloor)));
  }

  mount() {
    if (this.pane) return;

    const wrap = document.createElement("div");
    wrap.id = "v3-mask-debug-pane-host";
    wrap.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:10000;max-height:90vh;overflow:auto;pointer-events:auto;";
    document.body.appendChild(wrap);

    this.pane = new Pane({
      container: wrap,
      title: "V3 mask inspector",
      expanded: true,
    });

    this._renderPath = {
      threeJsMap: this.getRuntimeThreeOverlayWanted() !== false,
    };
    const renderFolder = this.pane.addFolder({
      title: "Render comparison",
      expanded: true,
    });
    renderFolder
      .addBinding(this._renderPath, "threeJsMap", {
        label: "Three.js map",
      })
      .on("change", (ev) => {
        void this.setRuntimeThreeOverlayWanted(!!ev.value);
      });

    this.pane.addBinding(this.params, "followViewedFloor", {
      label: "Match viewed floor",
    });

    const host = this.getHost();
    const floorCount = Math.max(
      1,
      host?.maskHub?.listFloorKeys().length ?? Math.max(1, countStackedBackgroundLevels(this._getScene())),
    );
    this.params.manualFloor = Math.min(
      Math.max(0, Math.round(this.params.manualFloor)),
      floorCount - 1,
    );
    this.pane.addBinding(this.params, "manualFloor", {
      label: "Floor (if manual)",
      min: 0,
      max: Math.max(0, floorCount - 1),
      step: 1,
    });

    const sandwichFolder = this.pane.addFolder({
      title: "Sandwich checker (underlay)",
      expanded: true,
    });
    sandwichFolder.addBinding(this.params, "checkerOpacity", {
      label: "Checker opacity",
      min: 0,
      max: 1,
      step: 0.02,
    });
    sandwichFolder.addBinding(this.params, "checkerSizePx", {
      label: "Cell size (px)",
      min: 4,
      max: 128,
      step: 1,
    });

    const illumHost = this.getHost();
    if (illumHost?.skyLighting) {
      const sky = illumHost.skyLighting;
      const illumFolder = this.pane.addFolder({
        title: "Illumination (policy v1)",
        expanded: true,
      });

      // Occlusion: sky-reach scene darkness (first built-in shadow term).
      const skyFolder = illumFolder.addFolder({
        title: "Occlusion: sky-reach darkness",
        expanded: true,
      });
      const persistSky = () => {
        try { saveSkyLightingDebugState(sky); } catch (_) {}
      };
      skyFolder.addBinding(sky, "enabled", { label: "Enable term" }).on("change", persistSky);
      skyFolder.addBinding(sky, "useSceneDarkness", { label: "Use scene darkness" }).on("change", persistSky);
      skyFolder.addBinding(sky, "manualDarkness01", {
        label: "Manual darkness",
        min: 0,
        max: 1,
        step: 0.02,
      }).on("change", persistSky);
      skyFolder.addBinding(sky, "strength", {
        label: "Strength",
        min: 0,
        max: 3,
        step: 0.05,
      }).on("change", persistSky);
      skyFolder
        .addButton({ title: "Refresh hub (rebuild skyReach)" })
        .on("click", () => {
          const h = this.getHost()?.maskHub;
          h?.compose().catch((e) => console.warn("[V3MaskDebug] sky compose", e));
        });

      // Building-shadows controls live in the main V3 config pane
      // ("Map Shine Advanced — V3"), not here — keeping this debug pane focused
      // on per-mask inspection + core illumination-term knobs.

      const lightAppearance = illumHost.lightAppearance;
      if (lightAppearance) {
        const lightDefaults = {
          addScale: 0.5,
          dimRadiusStrength: 0.7,
          brightRadiusStrength: 4.0,
          illuminationStrength: 0.25,
          colorationStrength: 1.0,
          colorationReflectivity: 1.0,
          colorationSaturation: 1.0,
          groundSaturation: 0.0,
          groundContrast: -0.2,
        };
        // Migrate stale persisted debug state so new bindings always exist.
        for (const [k, v] of Object.entries(lightDefaults)) {
          const n = Number(lightAppearance[k]);
          if (!Number.isFinite(n)) lightAppearance[k] = v;
        }
        const lightFolder = illumFolder.addFolder({
          title: "Foundry radial light appearance",
          expanded: true,
        });
        const persistAppearance = () => {
          try { saveLightAppearanceDebugState(lightAppearance); } catch (_) {}
        };
        lightFolder.addBinding(lightAppearance, "addScale", {
          label: "Light buffer",
          min: 0,
          max: 2,
          step: 0.01,
        }).on("change", persistAppearance);
        lightFolder.addBinding(lightAppearance, "dimRadiusStrength", {
          label: "Dim radius brightness",
          min: 0,
          max: 8,
          step: 0.01,
        }).on("change", persistAppearance);
        lightFolder.addBinding(lightAppearance, "brightRadiusStrength", {
          label: "Bright radius brightness",
          min: 0,
          max: 8,
          step: 0.01,
        }).on("change", persistAppearance);
        lightFolder.addBinding(lightAppearance, "illuminationStrength", {
          label: "Illumination",
          min: 0,
          max: 4,
          step: 0.01,
        }).on("change", persistAppearance);
        lightFolder.addBinding(lightAppearance, "colorationStrength", {
          label: "Color amount",
          min: 0,
          max: 4,
          step: 0.01,
        }).on("change", persistAppearance);
        lightFolder.addBinding(lightAppearance, "colorationReflectivity", {
          label: "Color vs surface",
          min: 0,
          max: 1,
          step: 0.01,
        }).on("change", persistAppearance);
        lightFolder.addBinding(lightAppearance, "colorationSaturation", {
          label: "Light saturation",
          min: -1,
          max: 4,
          step: 0.01,
        }).on("change", persistAppearance);
        lightFolder.addBinding(lightAppearance, "groundSaturation", {
          label: "Ground saturation",
          min: -1,
          max: 4,
          step: 0.01,
        }).on("change", persistAppearance);
        lightFolder.addBinding(lightAppearance, "groundContrast", {
          label: "Ground contrast",
          min: -1,
          max: 2,
          step: 0.01,
        }).on("change", persistAppearance);
        lightFolder.addButton({ title: "Reset light appearance defaults" }).on("click", () => {
          Object.assign(lightAppearance, lightDefaults);
          persistAppearance();
          this._rebuildFolder();
        });
      }

      const sceneGrade = illumHost.sceneColorGrade;
      if (sceneGrade) {
        const gradeDefaults = {
          enabled: true,
          exposure: 1.0,
          temperature: 0.0,
          tint: 0.0,
          brightness: 0.0,
          contrast: 0.995,
          saturation: 1.4,
          vibrance: 0.0,
          liftColor: [0, 0, 0],
          gammaColor: [1, 1, 1],
          gainColor: [1, 1, 1],
          masterGamma: 1.05,
          toneMapping: 0,
        };
        const gradeFolder = illumFolder.addFolder({
          title: "Scene color grading",
          expanded: false,
        });
        const persistGrade = () => {
          try { saveSceneColorGradeDebugState(sceneGrade); } catch (_) {}
        };
        gradeFolder.addBinding(sceneGrade, "enabled", { label: "Enable grade" }).on("change", persistGrade);
        gradeFolder.addBinding(sceneGrade, "exposure", {
          label: "Exposure",
          min: 0,
          max: 5,
          step: 0.01,
        }).on("change", persistGrade);
        gradeFolder.addBinding(sceneGrade, "temperature", {
          label: "Temperature",
          min: -1,
          max: 1,
          step: 0.01,
        }).on("change", persistGrade);
        gradeFolder.addBinding(sceneGrade, "tint", {
          label: "Tint",
          min: -1,
          max: 1,
          step: 0.01,
        }).on("change", persistGrade);
        gradeFolder.addBinding(sceneGrade, "brightness", {
          label: "Brightness",
          min: -0.1,
          max: 0.1,
          step: 0.002,
        }).on("change", persistGrade);
        gradeFolder.addBinding(sceneGrade, "contrast", {
          label: "Contrast",
          min: 0.5,
          max: 1.5,
          step: 0.005,
        }).on("change", persistGrade);
        gradeFolder.addBinding(sceneGrade, "saturation", {
          label: "Saturation",
          min: 0,
          max: 2.5,
          step: 0.01,
        }).on("change", persistGrade);
        gradeFolder.addBinding(sceneGrade, "vibrance", {
          label: "Vibrance",
          min: -1,
          max: 1,
          step: 0.01,
        }).on("change", persistGrade);
        const gradeProxy = {
          liftColor: {
            r: sceneGrade.liftColor[0],
            g: sceneGrade.liftColor[1],
            b: sceneGrade.liftColor[2],
          },
          gammaColor: {
            r: sceneGrade.gammaColor[0],
            g: sceneGrade.gammaColor[1],
            b: sceneGrade.gammaColor[2],
          },
          gainColor: {
            r: sceneGrade.gainColor[0],
            g: sceneGrade.gainColor[1],
            b: sceneGrade.gainColor[2],
          },
        };
        gradeFolder.addBinding(gradeProxy, "liftColor", {
          label: "Lift",
          color: { type: "float" },
        }).on("change", (e) => {
          sceneGrade.liftColor = [Number(e.value.r) || 0, Number(e.value.g) || 0, Number(e.value.b) || 0];
          persistGrade();
        });
        gradeFolder.addBinding(gradeProxy, "gammaColor", {
          label: "Gamma",
          color: { type: "float" },
        }).on("change", (e) => {
          sceneGrade.gammaColor = [Number(e.value.r) || 1, Number(e.value.g) || 1, Number(e.value.b) || 1];
          persistGrade();
        });
        gradeFolder.addBinding(gradeProxy, "gainColor", {
          label: "Gain",
          color: { type: "float" },
        }).on("change", (e) => {
          sceneGrade.gainColor = [Number(e.value.r) || 1, Number(e.value.g) || 1, Number(e.value.b) || 1];
          persistGrade();
        });
        gradeFolder.addBinding(sceneGrade, "masterGamma", {
          label: "Master gamma",
          min: 0.1,
          max: 3,
          step: 0.01,
        }).on("change", persistGrade);
        gradeFolder.addBinding(sceneGrade, "toneMapping", {
          label: "Tone mapping",
          options: { None: 0, ACES: 1, Reinhard: 2 },
        }).on("change", persistGrade);
        gradeFolder.addButton({ title: "Reset scene grade defaults" }).on("click", () => {
          Object.assign(sceneGrade, {
            ...gradeDefaults,
            liftColor: [...gradeDefaults.liftColor],
            gammaColor: [...gradeDefaults.gammaColor],
            gainColor: [...gradeDefaults.gainColor],
          });
          persistGrade();
          this._rebuildFolder();
        });
      }

      const tokenGrade = illumHost.tokenColorGrade;
      if (tokenGrade) {
        const tokenDefaults = {
          enabled: true,
          exposure: 0.9,
          temperature: 0.0,
          tint: 0.0,
          brightness: 0.0,
          contrast: 1.0,
          saturation: 1.25,
          vibrance: 0.0,
          amount: 1.0,
        };
        const tokenFolder = illumFolder.addFolder({
          title: "Token color grading",
          expanded: false,
        });
        const persistTokenGrade = () => {
          try { saveTokenColorGradeDebugState(tokenGrade); } catch (_) {}
        };
        tokenFolder.addBinding(tokenGrade, "enabled", { label: "Enable token grade" }).on("change", persistTokenGrade);
        tokenFolder.addBinding(tokenGrade, "amount", {
          label: "Amount",
          min: 0,
          max: 1,
          step: 0.01,
        }).on("change", persistTokenGrade);
        tokenFolder.addBinding(tokenGrade, "exposure", {
          label: "Exposure",
          min: 0,
          max: 5,
          step: 0.01,
        }).on("change", persistTokenGrade);
        tokenFolder.addBinding(tokenGrade, "temperature", {
          label: "Temperature",
          min: -1,
          max: 1,
          step: 0.01,
        }).on("change", persistTokenGrade);
        tokenFolder.addBinding(tokenGrade, "tint", {
          label: "Tint",
          min: -1,
          max: 1,
          step: 0.01,
        }).on("change", persistTokenGrade);
        tokenFolder.addBinding(tokenGrade, "brightness", {
          label: "Brightness",
          min: -0.1,
          max: 0.1,
          step: 0.002,
        }).on("change", persistTokenGrade);
        tokenFolder.addBinding(tokenGrade, "contrast", {
          label: "Contrast",
          min: 0.5,
          max: 1.5,
          step: 0.005,
        }).on("change", persistTokenGrade);
        tokenFolder.addBinding(tokenGrade, "saturation", {
          label: "Saturation",
          min: 0,
          max: 2.5,
          step: 0.01,
        }).on("change", persistTokenGrade);
        tokenFolder.addBinding(tokenGrade, "vibrance", {
          label: "Vibrance",
          min: -1,
          max: 1,
          step: 0.01,
        }).on("change", persistTokenGrade);
        tokenFolder.addButton({ title: "Reset token grade defaults" }).on("click", () => {
          Object.assign(tokenGrade, tokenDefaults);
          persistTokenGrade();
          this._rebuildFolder();
        });
      }

      illumFolder.addButton({ title: "Export tweak values" }).on("click", () => {
        const hostNow = this.getHost();
        if (!hostNow) return;
        const payload = {
          skyLighting: hostNow.skyLighting ? { ...hostNow.skyLighting } : null,
          lightAppearance: hostNow.lightAppearance ? { ...hostNow.lightAppearance } : null,
          sceneColorGrade: hostNow.sceneColorGrade
            ? {
              ...hostNow.sceneColorGrade,
              liftColor: Array.isArray(hostNow.sceneColorGrade.liftColor)
                ? [...hostNow.sceneColorGrade.liftColor]
                : [0, 0, 0],
              gammaColor: Array.isArray(hostNow.sceneColorGrade.gammaColor)
                ? [...hostNow.sceneColorGrade.gammaColor]
                : [1, 1, 1],
              gainColor: Array.isArray(hostNow.sceneColorGrade.gainColor)
                ? [...hostNow.sceneColorGrade.gainColor]
                : [1, 1, 1],
            }
            : null,
          tokenColorGrade: hostNow.tokenColorGrade ? { ...hostNow.tokenColorGrade } : null,
        };
        const text = JSON.stringify(payload, null, 2);
        try {
          console.log("[V3MaskDebug] tweak export", payload);
        } catch (_) {}
        const done = (ok) => {
          try {
            const n = globalThis.ui?.notifications;
            if (ok) n?.info?.("V3 tweak values exported (copied to clipboard + console).");
            else n?.warn?.("V3 tweak values exported to console (clipboard unavailable).");
          } catch (_) {}
        };
        try {
          const clip = globalThis.navigator?.clipboard;
          if (clip && typeof clip.writeText === "function") {
            void clip.writeText(text).then(() => done(true)).catch(() => done(false));
            return;
          }
        } catch (_) {}
        done(false);
      });
    }

    this.pane.addBinding(this.params, "overlayOpacity", {
      label: "Mask overlay α",
      min: 0,
      max: 1,
      step: 0.05,
    });

    this.pane.addButton({ title: "Refresh (no scan)" }).on("click", () => {
      const h = this.getHost()?.maskHub;
      h?.compose().catch((e) => console.warn("[V3MaskDebug]", e));
    });

    this.pane.addButton({ title: "Rescan assets (GM → persists)" }).on("click", () => {
      const h = this.getHost()?.maskHub;
      if (!h) return;
      h.compose({ rescan: true })
        .then(() => {
          this._rebuildInventoryFolder();
          this._rebuildFolder();
        })
        .catch((e) => console.warn("[V3MaskDebug] rescan", e));
    });

    this.pane.addButton({ title: "Hide mask overlay" }).on("click", () => {
      this._lastPreviewRow = null;
      this._pinnedPreviewId = null;
      try { this.getHost()?.clearLevelTextureDebug(); } catch (_) {}
      this._persistSettings();
    });

    this.pane.addBlade({ view: "separator" });

    this._maskFolder = this.pane.addFolder({
      title: "Masks (hub)",
      expanded: true,
    });

    this._inventoryFolder = this.pane.addFolder({
      title: "Level asset inventory",
      expanded: false,
    });

    this.pane.on("change", (ev) => {
      const key = ev?.target?.key;
      if (key === "followViewedFloor") {
        if (!this.params.followViewedFloor) {
          this.params.manualFloor = getViewedLevelIndex(this._getScene());
          try { this.pane.refresh(); } catch (_) {}
        }
        this._persistSettings();
        this._rebuildFolder();
        return;
      }
      if (key === "manualFloor" && !this.params.followViewedFloor) {
        this._persistSettings();
        this._rebuildFolder();
        return;
      }
      if (key === "overlayOpacity" && this._lastPreviewRow) {
        this._previewRow(this._lastPreviewRow).catch(() => {});
        this._persistSettings();
        return;
      }
      if (key === "checkerOpacity" || key === "checkerSizePx") {
        this._applyCheckerUniforms();
      }
      this._persistSettings();
    });

    // Subscribe to the hub so this pane re-renders automatically (no hub until Three mounts).
    const hub = this.getHost()?.maskHub ?? null;
    if (hub) {
      this._unsubscribeHub = hub.subscribe(() => this._rebuildFolder());
    }

    this._pollTimer = setInterval(() => this._pollActiveFloor(), 200);

    this._rebuildFolder();
    this._applyCheckerUniforms();
  }

  _pollActiveFloor() {
    if (!this.pane) return;
    const host = this.getHost();
    const hub = host?.maskHub;
    if (!hub) return;
    if (!this.params.followViewedFloor) return;
    const key = hub.getActiveFloorKey();
    if (this._lastActiveFloorKey !== key) {
      this._rebuildFolder();
    }
  }

  /** Rebuild the mask list against the current floor + hub snapshot. */
  _rebuildFolder() {
    if (!this.pane || !this._maskFolder) return;
    const host = this.getHost();
    const hub = host?.maskHub;
    if (!hub) {
      try {
        this._maskFolder.dispose();
      } catch (_) {}
      this._maskFolder = this.pane.addFolder({
        title: "Masks (hub) — Three overlay off",
        expanded: true,
      });
      this._maskFolder.addButton({
        title: "Turn on “Three.js map” in Render comparison above.",
      });
      this._buttonsById.clear();
      this._rebuildInventoryFolder();
      try {
        this.pane.refresh();
      } catch (_) {}
      return;
    }

    const floorKey = this._effectiveFloorKey();
    const records = new Map(
      hub.listFloorMaskRecords(floorKey).map((r) => [r.maskId, r]),
    );
    this._lastActiveFloorKey = floorKey;
    this._lastCacheVersion = hub.getCacheVersion();

    try { this._maskFolder.dispose(); } catch (_) {}
    this._maskFolder = this.pane.addFolder({
      title: `${floorKey} · cacheV=${hub.getCacheVersion()}`,
      expanded: true,
    });

    this._buttonsById.clear();
    for (const row of this._rows) {
      const rec = records.get(row.id);
      const entry = getMaskEntry(row.catalogId);
      const canStack =
        this.params.followViewedFloor &&
        !!entry?.suffix &&
        !entry?.derived &&
        typeof hub.canBuildStackMatte === "function" &&
        hub.canBuildStackMatte(row.id);

      let statusIcon = rec?.status === "ready"
        ? "✓"
        : rec?.status === "missing"
        ? "✗"
        : rec?.status === "loading" || rec?.status === "probing"
        ? "…"
        : rec?.status === "error"
        ? "!"
        : "·";
      if (rec?.status === "missing" && canStack) {
        statusIcon = "~";
      }
      const pinMark = this._pinnedPreviewId === row.id ? "●" : " ";
      const derivedTag = entry?.derived ? " (derived)" : "";
      const title = `${pinMark}${statusIcon} ${row.label}${derivedTag}`;
      const btn = this._maskFolder.addButton({ title });
      try {
        const tip = entry?.description ?? "";
        const url = rec?.url ?? "";
        const stackHint =
          rec?.status === "missing" && canStack
            ? "Upper-view stack matte: preview can use another floor’s file where this floor has none (empty stand-in on the missing side)."
            : "";
        btn.element?.setAttribute?.(
          "title",
          [tip, url ? `url: ${url}` : "", stackHint, `status: ${rec?.status ?? "idle"}`].filter(Boolean).join("\n"),
        );
      } catch (_) {}
      btn.on("click", () => {
        this._previewRow(row).catch((e) => console.warn("[V3MaskDebug] preview", e));
      });
      this._buttonsById.set(row.id, btn);
    }

    // Attempt to restore pinned preview after rebuild.
    if (this._pinnedPreviewId) {
      const row = this._rows.find((r) => r.id === this._pinnedPreviewId);
      if (row) this._previewRow(row, { silent: true }).catch(() => {});
    }

    this._rebuildInventoryFolder();

    try { this.pane.refresh(); } catch (_) {}
  }

  /**
   * Render the per-level texture/mask inventory view. Reads the hub’s
   * current manifest + floor records so both configured and scanned sources
   * are visible, along with any files discovered in the background folder
   * that don't match a catalog mask suffix.
   */
  _rebuildInventoryFolder() {
    if (!this.pane || !this._inventoryFolder) return;
    const host = this.getHost();
    const hub = host?.maskHub;
    if (!hub) {
      const parent = this._inventoryFolder;
      const wasExpanded = parent.expanded;
      try {
        parent.dispose();
      } catch (_) {}
      this._inventoryFolder = this.pane.addFolder({
        title: "Level asset inventory — Three overlay off",
        expanded: wasExpanded,
      });
      this._inventoryFolder.addButton({
        title: "Mount the Three.js map to load the mask manifest here.",
      });
      try {
        this.pane.refresh();
      } catch (_) {}
      return;
    }

    const manifest = typeof hub.getManifest === "function" ? hub.getManifest() : null;
    const parent = this._inventoryFolder;
    const wasExpanded = parent.expanded;

    try { parent.dispose(); } catch (_) {}
    const scanState = manifest?.scan?.state ?? "none";
    const scanAt = manifest?.scan?.lastScannedAt
      ? new Date(manifest.scan.lastScannedAt).toLocaleTimeString()
      : "never";
    const title = `Level asset inventory · ${scanState} · scanned ${scanAt}`;
    this._inventoryFolder = this.pane.addFolder({
      title,
      expanded: wasExpanded,
    });

    const inv = host?.assetInventory;
    const invDiag = inv?.diagnostics?.().counters ?? null;
    const hubDiag = typeof hub.getDiagnostics === "function" ? hub.getDiagnostics() : null;
    if (invDiag || hubDiag) {
      const diagBtn = this._inventoryFolder.addButton({
        title:
          `inv: build ${invDiag?.manifestBuilds ?? 0}, scans ${invDiag?.scanAttempts ?? 0}/${invDiag?.scanSuccess ?? 0}, ` +
          `browse ${invDiag?.browseCalls ?? 0} (fail ${invDiag?.browseFailures ?? 0}) ` +
          `| hub: miss ${hubDiag?.missingKnown ?? 0}, load ${hubDiag?.loadsAttempted ?? 0}, skip ${hubDiag?.loadsSkipped ?? 0}`,
      });
      try {
        diagBtn.element?.setAttribute?.(
          "title",
          JSON.stringify({ inventory: invDiag, hub: hubDiag }, null, 2),
        );
      } catch (_) {}
    }

    if (!manifest || !manifest.levels || !Object.keys(manifest.levels).length) {
      this._inventoryFolder.addButton({
        title: "no manifest yet — run Rescan",
      });
      return;
    }

    const isGM = !!globalThis.game?.user?.isGM;
    this._inventoryFolder
      .addButton({ title: isGM ? "Rescan & persist" : "Rescan (in-memory only)" })
      .on("click", () => {
        hub.compose({ rescan: true })
          .then(() => {
            this._rebuildInventoryFolder();
            this._rebuildFolder();
          })
          .catch((e) => console.warn("[V3MaskDebug] rescan", e));
      });

    const indices = Object.keys(manifest.levels)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    for (const idx of indices) {
      const level = manifest.levels[idx];
      if (!level) continue;
      const floorKey = hub.floorKeyForIndex(idx);
      const records = new Map(
        hub.listFloorMaskRecords(floorKey).map((r) => [r.maskId, r]),
      );

      const suffixBits = [];
      if (level.baseName) suffixBits.push(level.baseName);
      if (level.listOk) suffixBits.push("listed");
      else if (level.listAttempted) suffixBits.push("no-listing");
      const subtitle = `floor ${idx} · ${floorKey}${suffixBits.length ? ` · ${suffixBits.join(" · ")}` : ""}`;
      const lvlFolder = this._inventoryFolder.addFolder({
        title: subtitle,
        expanded: idx === 0,
      });

      const metaBlade = (label, value) => {
        const btn = lvlFolder.addButton({ title: `${label}: ${value ?? "—"}` });
        try {
          btn.element?.setAttribute?.("title", String(value ?? ""));
        } catch (_) {}
        return btn;
      };

      metaBlade("background", level.backgroundUrl ?? "(none)");
      metaBlade("basePath", level.basePath ?? "(none)");
      if (level.listedFrom) metaBlade("browsed", level.listedFrom);

      const configured = Array.isArray(level.configuredTextures)
        ? level.configuredTextures
        : [];
      if (configured.length) {
        const cfgFolder = lvlFolder.addFolder({
          title: `Scene-configured textures (${configured.length})`,
          expanded: false,
        });
        for (const row of configured) {
          const label = row.name
            ? `${row.name}${row.suffix ? ` · _${row.suffix}` : ""}`
            : (row.suffix ? `_${row.suffix}` : "(texture)");
          const btn = cfgFolder.addButton({ title: label });
          try {
            btn.element?.setAttribute?.("title", row.src ?? "");
          } catch (_) {}
        }
      }

      const maskEntries = Object.values(level.masks ?? {});
      if (maskEntries.length) {
        const mkFolder = lvlFolder.addFolder({
          title: `Masks (${maskEntries.length})`,
          expanded: true,
        });
        maskEntries.sort((a, b) => a.maskId.localeCompare(b.maskId));
        for (const entry of maskEntries) {
          const rec = records.get(entry.maskId);
          const status = rec?.status ?? "idle";
          const statusIcon = status === "ready"
            ? "✓"
            : status === "missing"
            ? "✗"
            : status === "loading" || status === "probing"
            ? "…"
            : status === "error"
            ? "!"
            : "·";
          const title = `${statusIcon} ${entry.maskId} · ${entry.source}`;
          const btn = mkFolder.addButton({ title });
          try {
            btn.element?.setAttribute?.(
              "title",
              [
                `status: ${status}`,
                `source: ${entry.source}`,
                entry.suffix ? `suffix: ${entry.suffix}` : "",
                entry.url ? `url: ${entry.url}` : "",
              ].filter(Boolean).join("\n"),
            );
          } catch (_) {}
          btn.on("click", () => {
            const row = this._rows.find((r) => r.id === entry.maskId);
            if (row) {
              this._previewRow(row).catch((e) =>
                console.warn("[V3MaskDebug] inventory preview", e),
              );
            }
          });
        }
      }

      if (Array.isArray(level.otherFiles) && level.otherFiles.length) {
        const otherFolder = lvlFolder.addFolder({
          title: `Other files in folder (${level.otherFiles.length})`,
          expanded: false,
        });
        for (const path of level.otherFiles) {
          const name = String(path).split("/").pop() || path;
          const btn = otherFolder.addButton({ title: name });
          try { btn.element?.setAttribute?.("title", String(path)); } catch (_) {}
        }
      }
    }

    this._lastInventoryCacheVersion = hub.getCacheVersion();
  }

  /**
   * @param {InspectorRow} row
   * @param {{ silent?: boolean }} [opts]
   */
  async _previewRow(row, opts = {}) {
    const host = this.getHost();
    const hub = host?.maskHub;
    if (!host || !hub) return;

    const floorKey = this._effectiveFloorKey();
    const entry = getMaskEntry(row.catalogId);
    const channelView = channelForEntry(entry);
    const isMask = channelView !== "rgba";

    const scene = this._getScene();
    const upperStackPreview =
      this.params.followViewedFloor &&
      !!entry?.suffix &&
      !entry?.derived &&
      countStackedBackgroundLevels(scene) >= 2 &&
      getViewedLevelIndex(scene) > 0;

    const maskOpts = {
      purpose: row.purpose,
      // Upper-view + match viewed: show the same stack matte as runtime when
      // any floor has this mask (e.g. water only on floor0). Manual floor: disk only.
      authoredOnly: !upperStackPreview,
      allowSpeculativeDiskUrl: false,
    };
    const { texture, meta } = await hub.getFloorMask(floorKey, row.id, maskOpts);

    if (!texture) {
      if (!opts.silent) {
        try {
          globalThis.ui?.notifications?.warn(
            `No mask for ${row.label} on ${floorKey} (status: ${meta?.status ?? "unknown"}).`,
          );
        } catch (_) {}
      }
      // Keep pin but clear overlay so the stale texture doesn't linger.
      try { host.clearLevelTextureDebug(); } catch (_) {}
      return;
    }

    host.setLevelTextureDebugFromHubTexture(texture, {
      opacity: this.params.overlayOpacity,
      channelView,
      isMask,
      label: meta?.viewComposite ? `${row.label} · composite` : `${floorKey}/${row.id}`,
      owned: false,
    });

    this._lastPreviewRow = row;
    this._pinnedPreviewId = row.id;
    this._persistSettings();
  }

  /** @returns {object|null} Mirror for `V3Shine.getMaskDebugLastProbe()`. */
  get lastProbe() {
    const host = this.getHost();
    const hub = host?.maskHub;
    if (!hub) return null;
    const floorKey = this._effectiveFloorKey();
    return {
      floorKey,
      cacheVersion: hub.getCacheVersion(),
      rows: hub.listFloorMaskRecords(floorKey),
    };
  }

  unmount() {
    this._persistSettings();
    if (this._pollTimer) {
      try { clearInterval(this._pollTimer); } catch (_) {}
      this._pollTimer = null;
    }
    try { this._unsubscribeHub?.(); } catch (_) {}
    this._unsubscribeHub = null;

    try { this._maskFolder?.dispose(); } catch (_) {}
    this._maskFolder = null;

    try { this._inventoryFolder?.dispose(); } catch (_) {}
    this._inventoryFolder = null;

    try { this.pane?.dispose(); } catch (_) {}
    this.pane = null;

    try {
      const el = document.getElementById("v3-mask-debug-pane-host");
      el?.parentElement?.removeChild(el);
    } catch (_) {}
  }
}
