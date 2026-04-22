/**
 * @fileoverview Tweakpane surface for V3 module settings.
 *
 * Starts minimal and grows as V2 controls are ported; currently houses:
 *   - Support & Links (branding)
 *   - Screen Effects (V3 effect chain — bloom + dot-screen)
 *
 * Effect controls bind live-mutable `params` on the registered effect objects
 * (see `V3EffectChain` / `V3DotScreenEffect`). Uniforms pick up the new
 * values on the very next frame — no re-registration required.
 *
 * @module v3/V3ModuleConfigPane
 */

import { Pane } from "../vendor/tweakpane.js";
import { V3_BUILDING_SHADOWS_DEFAULTS } from "./V3BuildingShadowsPass.js";
import { saveBuildingShadowsDebugState } from "./V3MaskDebugStorage.js";

const HOST_ID = "v3-module-config-pane-host";
const STYLE_ID = "v3-module-config-pane-styles";

/**
 * Port of v13 `TweakpaneManager.buildBrandingSection` (Support & Links),
 * appended into the folder body so it folds with Tweakpane.
 *
 * @param {import('../vendor/tweakpane.js').FolderApi} folder
 */
function appendSupportAndLinksIntoFolder(folder) {
  const linkContainer = document.createElement("div");
  linkContainer.style.padding = "8px";
  linkContainer.style.fontSize = "12px";
  linkContainer.innerHTML = `
      <div style="margin-bottom: 10px;">
        <a href="https://github.com/Garsondee/map-shine-advanced/issues" target="_blank" rel="noopener noreferrer" style="color: #66aaff;">
          🐞 Report a Bug
        </a>
      </div>
      <div style="margin-bottom: 8px;">
        <strong>Support Development:</strong>
      </div>
      <div style="margin-bottom: 4px;">
        <a href="https://www.patreon.com/c/MythicaMachina" target="_blank" rel="noopener noreferrer" style="color: #ff424d;">
          ❤️ Patreon
        </a>
      </div>
      <div>
        <a href="https://www.foundryvtt.store/creators/mythica-machina" target="_blank" rel="noopener noreferrer" style="color: #ff6400;">
          🛒 Foundry Store
        </a>
      </div>
    `;

  const folderEl = folder.element;
  const contentElement =
    (folderEl && folderEl.querySelector(".tp-fldv_c")) || folderEl;
  if (contentElement) contentElement.appendChild(linkContainer);
}

export class V3ModuleConfigPane {
  /**
   * @param {{
   *   onRequestClose?: () => void,
   *   getHost?: () => (null | {
   *     effectChain?: any,
   *     bloomEffect?: any,
   *     dotScreenEffect?: any,
   *     halftoneEffect?: any,
   *     invertEffect?: any,
   *   }),
   * }} [options]
   */
  constructor(options = {}) {
    this._onRequestClose =
      typeof options.onRequestClose === "function" ? options.onRequestClose : () => {};
    /** @type {() => any} */
    this._getHost =
      typeof options.getHost === "function" ? options.getHost : () => null;

    /** @type {import('../vendor/tweakpane.js').Pane|null} */
    this.pane = null;
    /** @type {HTMLDivElement|null} */
    this._host = null;
    /** @type {HTMLButtonElement|null} */
    this._closeBtn = null;
    /** @type {HTMLDivElement|null} */
    this._dragStrip = null;
    /** @type {HTMLStyleElement|null} */
    this._styleEl = null;
    /** @type {(() => void)|null} */
    this._resizeHandler = null;

    /** @type {boolean} */
    this._dragging = false;
    /** @type {number} */
    this._dragStartClientX = 0;
    /** @type {number} */
    this._dragStartClientY = 0;
    /** @type {number} */
    this._dragStartLeft = 0;
    /** @type {number} */
    this._dragStartTop = 0;
    /** @type {((e: MouseEvent) => void)|null} */
    this._onDragMove = null;
    /** @type {((e: MouseEvent) => void)|null} */
    this._onDragUp = null;
  }

  /**
   * Keep the host inside the viewport (same idea as v13 `_ensurePaneSafePosition`).
   * @returns {void}
   */
  _ensureHostInViewport() {
    const host = this._host;
    if (!host || !host.isConnected) return;

    const rect = host.getBoundingClientRect();
    if (
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return;
    }

    const viewportWidth = Math.max(
      window.innerWidth || 0,
      document.documentElement?.clientWidth || 0,
    );
    const viewportHeight = Math.max(
      window.innerHeight || 0,
      document.documentElement?.clientHeight || 0,
    );
    if (viewportWidth <= 0 || viewportHeight <= 0) return;

    const safeMargin = 12;
    const minVisible = 48;

    host.style.right = "auto";
    host.style.bottom = "auto";

    let left = rect.left;
    let top = rect.top;

    const fullyOff =
      rect.right < minVisible ||
      rect.bottom < minVisible ||
      rect.left > viewportWidth - minVisible ||
      rect.top > viewportHeight - minVisible;

    if (fullyOff) {
      left = safeMargin;
      top = safeMargin;
    }

    if (rect.width > viewportWidth - safeMargin * 2) {
      left = safeMargin;
    } else {
      left = Math.max(
        safeMargin,
        Math.min(left, viewportWidth - safeMargin - rect.width),
      );
    }

    if (rect.height > viewportHeight - safeMargin * 2) {
      top = safeMargin;
    } else {
      top = Math.max(
        safeMargin,
        Math.min(top, viewportHeight - safeMargin - rect.height),
      );
    }

    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  _injectTitleChromeStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
#${HOST_ID} .tp-rotv_m { display: none !important; }
#${HOST_ID} .tp-rotv_b {
  padding-right: 40px;
  box-sizing: border-box;
}
`;
      document.head.appendChild(style);
    }
    this._styleEl = style;
  }

  _removeTitleChromeStyles() {
    try {
      this._styleEl?.parentElement?.removeChild(this._styleEl);
    } catch (_) {}
    this._styleEl = null;
  }

  _addCloseButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Close";
    btn.setAttribute("aria-label", "Close Map Shine V3 configuration");
    btn.innerHTML = '<i class="fas fa-times"></i>';
    btn.style.cssText =
      "position:absolute;top:4px;right:6px;z-index:4;width:28px;height:24px;" +
      "padding:0;margin:0;border:none;border-radius:4px;cursor:pointer;" +
      "background:rgba(0,0,0,0.2);color:inherit;font-size:12px;" +
      "display:flex;align-items:center;justify-content:center;";
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(255,255,255,0.12)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "rgba(0,0,0,0.2)";
    });
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        this._onRequestClose();
      } catch (_) {}
    });
    this._host?.appendChild(btn);
    this._closeBtn = btn;
  }

  _addDragStrip() {
    const strip = document.createElement("div");
    strip.className = "v3-module-config-drag-strip";
    strip.title = "Drag to move";
    strip.style.cssText =
      "position:absolute;left:0;top:0;right:36px;height:28px;cursor:move;z-index:3;";
    this._host?.appendChild(strip);
    this._dragStrip = strip;
  }

  _installDragHandlers() {
    const strip = this._dragStrip;
    const host = this._host;
    if (!strip || !host) return;

    this._onDragMove = (e) => {
      if (!this._dragging || !host) return;
      const dx = e.clientX - this._dragStartClientX;
      const dy = e.clientY - this._dragStartClientY;
      host.style.left = `${Math.round(this._dragStartLeft + dx)}px`;
      host.style.top = `${Math.round(this._dragStartTop + dy)}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    };

    this._onDragUp = (e) => {
      if (!this._dragging) return;
      this._dragging = false;
      document.removeEventListener("mousemove", this._onDragMove, true);
      document.removeEventListener("mouseup", this._onDragUp, true);
      this._ensureHostInViewport();
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    strip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const rect = host.getBoundingClientRect();
      this._dragging = true;
      this._dragStartClientX = e.clientX;
      this._dragStartClientY = e.clientY;
      this._dragStartLeft = rect.left;
      this._dragStartTop = rect.top;
      host.style.right = "auto";
      host.style.bottom = "auto";
      host.style.left = `${Math.round(rect.left)}px`;
      host.style.top = `${Math.round(rect.top)}px`;
      document.addEventListener("mousemove", this._onDragMove, true);
      document.addEventListener("mouseup", this._onDragUp, true);
      e.preventDefault();
      e.stopPropagation();
    });

    strip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  _installResizeClamp() {
    this._resizeHandler = () => {
      requestAnimationFrame(() => this._ensureHostInViewport());
    };
    window.addEventListener("resize", this._resizeHandler);
  }

  /**
   * Build the `Screen Effects` folder on {@link #pane}, wiring each known
   * effect's live `params` / `enabled` to Tweakpane bindings. Missing hosts
   * (e.g. pane opened before the Three scene mounted) are tolerated — the
   * folder still appears with a helpful placeholder.
   *
   * @private
   */
  _buildScreenEffectsFolder() {
    if (!this.pane) return;

    const folder = this.pane.addFolder({
      title: "Screen Effects",
      expanded: false,
    });

    const host = this._getHost?.() ?? null;
    const chain = host?.effectChain ?? null;

    if (!chain) {
      const help = document.createElement("div");
      help.style.padding = "8px";
      help.style.fontSize = "12px";
      help.style.opacity = "0.8";
      help.textContent =
        "Screen effects become available once the V3 Three scene is mounted " +
        "(canvas ready). Close and reopen this pane after the scene loads.";
      const body =
        (folder.element && folder.element.querySelector(".tp-fldv_c")) ||
        folder.element;
      if (body) body.appendChild(help);
      return;
    }

    this._buildBloomControls(folder, host);
    this._buildDotScreenControls(folder, host);
    this._buildHalftoneControls(folder, host);
    this._buildInvertControls(folder, host);
  }

  /**
   * Build the `Building Shadows` top-level folder. Mutates the live
   * `host.buildingShadows` params object (same reference held by
   * {@link createBuildingShadowsOcclusionTerm} and
   * {@link V3BuildingShadowsPass}) so sliders take effect on the next frame
   * without any re-registration. Values are persisted to `localStorage` via
   * {@link saveBuildingShadowsDebugState} on every change.
   *
   * Missing host (pane opened before the Three scene mounted) is tolerated:
   * the folder shows a short help message so the user knows to reopen after
   * `canvasReady`.
   *
   * @private
   */
  _buildBuildingShadowsFolder() {
    if (!this.pane) return;

    const folder = this.pane.addFolder({
      title: "Building Shadows",
      expanded: false,
    });

    const host = this._getHost?.() ?? null;
    const params = host?.buildingShadows ?? null;

    if (!params) {
      const help = document.createElement("div");
      help.style.padding = "8px";
      help.style.fontSize = "12px";
      help.style.opacity = "0.8";
      help.textContent =
        "Building shadows become available once the V3 Three scene is mounted " +
        "(canvas ready). Close and reopen this pane after the scene loads.";
      const body =
        (folder.element && folder.element.querySelector(".tp-fldv_c")) ||
        folder.element;
      if (body) body.appendChild(help);
      return;
    }

    const defaults = { ...V3_BUILDING_SHADOWS_DEFAULTS };
    for (const [k, v] of Object.entries(defaults)) {
      if (k === "enabled") {
        if (typeof params[k] !== "boolean") params[k] = v;
      } else {
        const n = Number(params[k]);
        if (!Number.isFinite(n)) params[k] = v;
      }
    }

    const persist = () => {
      try { saveBuildingShadowsDebugState(params); } catch (_) {}
    };

    folder
      .addBinding(params, "enabled", { label: "Enabled" })
      .on("change", persist);
    folder
      .addBinding(params, "opacity", { label: "Opacity", min: 0, max: 1, step: 0.01 })
      .on("change", persist);
    folder
      .addBinding(params, "length", { label: "Shadow length", min: 0, max: 1.5, step: 0.01 })
      .on("change", persist);
    folder
      .addBinding(params, "softness", { label: "Softness", min: 0.1, max: 8, step: 0.05 })
      .on("change", persist);
    folder
      .addBinding(params, "smear", { label: "Smear", min: 0, max: 1, step: 0.01 })
      .on("change", persist);
    folder
      .addBinding(params, "penumbra", { label: "Penumbra", min: 0, max: 1, step: 0.01 })
      .on("change", persist);
    folder
      .addBinding(params, "shadowCurve", { label: "Shadow curve", min: 0.1, max: 3, step: 0.01 })
      .on("change", persist);
    folder
      .addBinding(params, "resolutionScale", { label: "Resolution scale", min: 0.25, max: 2, step: 0.05 })
      .on("change", persist);

    const sunFolder = folder.addFolder({ title: "Sun direction", expanded: false });
    sunFolder
      .addBinding(params, "sunAzimuthDeg", { label: "Azimuth (deg)", min: 0, max: 360, step: 1 })
      .on("change", persist);
    sunFolder
      .addBinding(params, "sunLatitude", {
        label: "Latitude (0=horizon, 1=overhead)",
        min: 0,
        max: 1,
        step: 0.01,
      })
      .on("change", persist);

    // `alphaHoleLo` / `alphaHoleHi` feed a `smoothstep` in the cascade shader —
    // if hi drops below lo the smoothstep inverts and shadows vanish, so we
    // self-correct here on every mutation.
    const cascadeFolder = folder.addFolder({ title: "Alpha-hole cascade", expanded: false });
    const fixHoleOrder = () => {
      if (params.alphaHoleHi <= params.alphaHoleLo) {
        params.alphaHoleHi = Math.min(1, params.alphaHoleLo + 0.01);
        try { this.pane?.refresh(); } catch (_) {}
      }
    };
    cascadeFolder
      .addBinding(params, "alphaHoleLo", { label: "Alpha hole low", min: 0, max: 1, step: 0.01 })
      .on("change", () => { fixHoleOrder(); persist(); });
    cascadeFolder
      .addBinding(params, "alphaHoleHi", { label: "Alpha hole high", min: 0, max: 1, step: 0.01 })
      .on("change", () => { fixHoleOrder(); persist(); });

    folder
      .addButton({ title: "Reset building shadows defaults" })
      .on("click", () => {
        Object.assign(params, defaults);
        persist();
        try { this.pane?.refresh(); } catch (_) {}
      });

    const diagFolder = folder.addFolder({ title: "Diagnostics", expanded: false });
    const diagState = {
      lastRunFrame: -1,
      lastSkipReason: "",
      cascadedFloors: 0,
      rtSize: "",
      lastRunMs: 0,
    };
    diagFolder.addBinding(diagState, "lastRunFrame", { label: "Last run frame", readonly: true });
    diagFolder.addBinding(diagState, "lastSkipReason", { label: "Last skip reason", readonly: true });
    diagFolder.addBinding(diagState, "cascadedFloors", { label: "Cascaded floors", readonly: true });
    diagFolder.addBinding(diagState, "rtSize", { label: "RT size", readonly: true });
    diagFolder.addBinding(diagState, "lastRunMs", {
      label: "Last run (ms)",
      readonly: true,
      format: (v) => (typeof v === "number" ? v.toFixed(2) : String(v ?? "")),
    });
    diagFolder.addButton({ title: "Refresh diagnostics" }).on("click", () => {
      const h = this._getHost?.();
      const d = h?.buildingShadowsPass?.getDiagnostics?.() ?? null;
      if (d) {
        diagState.lastRunFrame = d.lastRunFrame ?? -1;
        diagState.lastSkipReason = d.lastSkipReason ?? "";
        diagState.cascadedFloors = d.lastCascadedFloors ?? 0;
        diagState.rtSize = Array.isArray(d.lastRtSize) ? `${d.lastRtSize[0]} x ${d.lastRtSize[1]}` : "";
        diagState.lastRunMs = Number(d.lastRunMs) || 0;
      }
      try { this.pane?.refresh(); } catch (_) {}
    });
  }

  /**
   * Bloom (Unreal-style glow) — strength / radius / threshold / tint / blend and
   * optional water-specular injection (stub until water emits a mask).
   *
   * @param {import('../vendor/tweakpane.js').FolderApi} parentFolder
   * @param {{ bloomEffect?: any }} host
   * @private
   */
  _buildBloomControls(parentFolder, host) {
    const effect = host?.bloomEffect ?? null;
    if (!effect) return;

    const folder = parentFolder.addFolder({
      title: "Bloom (glow)",
      expanded: false,
    });

    folder.addBinding(effect, "enabled", { label: "Enabled" });
    folder.addBinding(effect.params, "strength", {
      label: "Strength",
      min: 0,
      max: 3,
      step: 0.01,
    });
    folder.addBinding(effect.params, "radius", {
      label: "Radius",
      min: 0,
      max: 1,
      step: 0.01,
    });
    folder.addBinding(effect.params, "threshold", {
      label: "Threshold",
      min: 0,
      max: 1,
      step: 0.01,
    });
    folder.addBinding(effect.params, "blendOpacity", {
      label: "Blend opacity",
      min: 0,
      max: 1,
      step: 0.01,
    });

    const tint = folder.addFolder({ title: "Glow tint (RGB)", expanded: false });
    tint.addBinding(effect.params.tintColor, "r", { label: "R", min: 0, max: 1, step: 0.01 });
    tint.addBinding(effect.params.tintColor, "g", { label: "G", min: 0, max: 1, step: 0.01 });
    tint.addBinding(effect.params.tintColor, "b", { label: "B", min: 0, max: 1, step: 0.01 });

    const water = folder.addFolder({
      title: "Water specular (bloom link)",
      expanded: false,
    });
    water.addBinding(effect.params, "waterSpecularBloomEnabled", {
      label: "Link when mask exists",
    });
    water.addBinding(effect.params, "waterSpecularBloomStrength", {
      label: "Mask strength",
      min: 0,
      max: 8,
      step: 0.01,
    });
    water.addBinding(effect.params, "waterSpecularBloomGamma", {
      label: "Gamma",
      min: 0.35,
      max: 3,
      step: 0.01,
    });

    folder.addButton({ title: "Preset: Subtle" }).on("click", () => {
      effect.params.strength = 0.8;
      effect.params.radius = 0.2;
      effect.params.threshold = 0.9;
      effect.params.blendOpacity = 1.0;
      effect.params.tintColor.r = 1;
      effect.params.tintColor.g = 1;
      effect.params.tintColor.b = 1;
      try { this.pane?.refresh(); } catch (_) {}
    });
    folder.addButton({ title: "Preset: Strong" }).on("click", () => {
      effect.params.strength = 2.0;
      effect.params.radius = 0.8;
      effect.params.threshold = 0.7;
      effect.params.blendOpacity = 1.0;
      effect.params.tintColor.r = 1;
      effect.params.tintColor.g = 1;
      effect.params.tintColor.b = 1;
      try { this.pane?.refresh(); } catch (_) {}
    });
  }

  /**
   * DotScreen (halftone) controls. First migrated V3 effect.
   *
   * @param {import('../vendor/tweakpane.js').FolderApi} parentFolder
   * @param {{ dotScreenEffect?: any }} host
   * @private
   */
  _buildDotScreenControls(parentFolder, host) {
    const effect = host?.dotScreenEffect ?? null;
    if (!effect) return;

    const folder = parentFolder.addFolder({
      title: "Dot Screen (halftone)",
      expanded: false,
    });

    folder.addBinding(effect, "enabled", { label: "Enabled" });
    folder.addBinding(effect.params, "strength", {
      label: "Strength",
      min: 0.0,
      max: 1.0,
      step: 0.01,
    });
    folder.addBinding(effect.params, "scale", {
      label: "Scale",
      min: 0.1,
      max: 10.0,
      step: 0.05,
    });
    folder.addBinding(effect.params, "angle", {
      label: "Angle (rad)",
      min: 0.0,
      max: 6.283185307179586,
      step: 0.01,
    });
    folder.addBinding(effect.params, "centerX", {
      label: "Center X",
      min: 0.0,
      max: 1.0,
      step: 0.001,
    });
    folder.addBinding(effect.params, "centerY", {
      label: "Center Y",
      min: 0.0,
      max: 1.0,
      step: 0.001,
    });

    folder
      .addButton({ title: "Reset to Classic preset" })
      .on("click", () => {
        effect.params.strength = 0.85;
        effect.params.scale = 1.6;
        effect.params.angle = 1.57;
        effect.params.centerX = 0.5;
        effect.params.centerY = 0.5;
        try { this.pane?.refresh(); } catch (_) {}
      });
  }

  /**
   * CMYK-style halftone controls (V2 parity).
   *
   * @param {import('../vendor/tweakpane.js').FolderApi} parentFolder
   * @param {{ halftoneEffect?: any }} host
   * @private
   */
  _buildHalftoneControls(parentFolder, host) {
    const effect = host?.halftoneEffect ?? null;
    if (!effect) return;

    const folder = parentFolder.addFolder({
      title: "Halftone (print)",
      expanded: false,
    });

    folder.addBinding(effect, "enabled", { label: "Enabled" });
    folder.addBinding(effect.params, "strength", {
      label: "Strength",
      min: 0.0,
      max: 1.0,
      step: 0.01,
    });
    folder.addBinding(effect.params, "radius", {
      label: "Radius",
      min: 1.0,
      max: 16.0,
      step: 0.25,
    });
    folder.addBinding(effect.params, "shape", {
      label: "Shape",
      options: {
        Dot: 1,
        Ellipse: 2,
        Line: 3,
        Square: 4,
      },
    });
    folder.addBinding(effect.params, "blendingMode", {
      label: "Blend mode",
      options: {
        Linear: 1,
        Multiply: 2,
        Add: 3,
        Lighter: 4,
        Darker: 5,
      },
    });
    folder.addBinding(effect.params, "scatter", {
      label: "Scatter",
      min: 0.0,
      max: 2.0,
      step: 0.01,
    });
    folder.addBinding(effect.params, "greyscale", {
      label: "Greyscale",
    });

    folder.addButton({ title: "Preset: Subtle" }).on("click", () => {
      effect.params.strength = 0.25;
      effect.params.radius = 6.0;
      effect.params.shape = 1;
      effect.params.blendingMode = 1;
      effect.params.scatter = 0.0;
      effect.params.greyscale = false;
      try { this.pane?.refresh(); } catch (_) {}
    });
    folder.addButton({ title: "Preset: Comic" }).on("click", () => {
      effect.params.strength = 0.85;
      effect.params.radius = 4.0;
      effect.params.shape = 1;
      effect.params.blendingMode = 1;
      effect.params.scatter = 0.0;
      effect.params.greyscale = false;
      try { this.pane?.refresh(); } catch (_) {}
    });
    folder.addButton({ title: "Preset: Print" }).on("click", () => {
      effect.params.strength = 1.0;
      effect.params.radius = 3.0;
      effect.params.shape = 2;
      effect.params.blendingMode = 2;
      effect.params.scatter = 0.15;
      effect.params.greyscale = false;
      try { this.pane?.refresh(); } catch (_) {}
    });
    folder.addButton({ title: "Preset: Noir" }).on("click", () => {
      effect.params.strength = 1.0;
      effect.params.radius = 4.0;
      effect.params.shape = 3;
      effect.params.blendingMode = 1;
      effect.params.scatter = 0.0;
      effect.params.greyscale = true;
      try { this.pane?.refresh(); } catch (_) {}
    });
  }

  /**
   * Color inversion controls.
   *
   * @param {import('../vendor/tweakpane.js').FolderApi} parentFolder
   * @param {{ invertEffect?: any }} host
   * @private
   */
  _buildInvertControls(parentFolder, host) {
    const effect = host?.invertEffect ?? null;
    if (!effect) return;

    const folder = parentFolder.addFolder({
      title: "Color Invert",
      expanded: false,
    });

    folder.addBinding(effect, "enabled", { label: "Enabled" });
    folder.addBinding(effect.params, "strength", {
      label: "Strength",
      min: 0.0,
      max: 1.0,
      step: 0.01,
    });

    folder.addButton({ title: "Preset: Partial" }).on("click", () => {
      effect.params.strength = 0.35;
      try { this.pane?.refresh(); } catch (_) {}
    });
    folder.addButton({ title: "Preset: Half" }).on("click", () => {
      effect.params.strength = 0.5;
      try { this.pane?.refresh(); } catch (_) {}
    });
    folder.addButton({ title: "Preset: Full" }).on("click", () => {
      effect.params.strength = 1.0;
      try { this.pane?.refresh(); } catch (_) {}
    });
  }

  mount() {
    if (this.pane) return;

    this._host = document.createElement("div");
    this._host.id = HOST_ID;
    this._host.style.cssText =
      "position:fixed;left:8px;top:48px;z-index:10000;max-height:85vh;overflow:auto;pointer-events:auto;";
    document.body.appendChild(this._host);

    this.pane = new Pane({
      container: this._host,
      title: "Map Shine Advanced — V3",
      expanded: true,
    });

    this.pane.addFolder({
      title: "General",
      expanded: false,
    });

    this._buildScreenEffectsFolder();
    this._buildBuildingShadowsFolder();

    const brandingFolder = this.pane.addFolder({
      title: "Support & Links",
      expanded: true,
    });
    appendSupportAndLinksIntoFolder(brandingFolder);

    this._injectTitleChromeStyles();
    this._addCloseButton();
    this._addDragStrip();
    this._installDragHandlers();
    this._installResizeClamp();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => this._ensureHostInViewport());
    });
  }

  unmount() {
    if (this._dragging && this._onDragUp) {
      try {
        this._onDragUp();
      } catch (_) {}
    }
    if (this._resizeHandler) {
      try {
        window.removeEventListener("resize", this._resizeHandler);
      } catch (_) {}
      this._resizeHandler = null;
    }
    if (this._onDragMove) {
      try {
        document.removeEventListener("mousemove", this._onDragMove, true);
      } catch (_) {}
      this._onDragMove = null;
    }
    if (this._onDragUp) {
      try {
        document.removeEventListener("mouseup", this._onDragUp, true);
      } catch (_) {}
      this._onDragUp = null;
    }

    this._dragging = false;
    this._closeBtn = null;
    this._dragStrip = null;

    try {
      this.pane?.dispose();
    } catch (_) {}
    this.pane = null;

    try {
      this._host?.parentElement?.removeChild(this._host);
    } catch (_) {}
    this._host = null;

    this._removeTitleChromeStyles();
  }
}
