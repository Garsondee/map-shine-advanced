/**
 * @fileoverview V3 Three.js scene host — **all visible scene rendering here**;
 * Foundry supplies documents and canvas layout only.
 *
 * - Owns WebGLRenderer; frame cadence comes from `V3PixiThreeFrameBridge` (PIXI ticker or rAF fallback).
 * - Inserts renderer canvas under the Foundry PIXI view (pointer-events: none).
 *   Native tools (lights, ruler, …) rely on `syncV3FoundryGameplayPixiSuppression`
 *   `syncV3FoundryGameplayPixiSuppression` (keeps `canvas.effects` off; forces
 *   `canvas.lighting` when editing lights; may re-show `canvas.background` for other tools).
 * - Each frame syncs map UVs from `canvas.stage` pivot/scale + `sceneRect`
 *   so pan/zoom matches Foundry while Three draws pixels.
 * - **When** Three runs vs PIXI: prefer `renderer.runners.postrender` (Pixi v8).
 *   `postrender` fires after **every** `render()` (screen + RTT). Foundry can call
 *   `render()` more than once per vsync; we enforce **≥ ~0.88× framePeriod** ms
 *   between composites (from {@link getEffectiveFpsCap}, floor at 6.5 ms) plus
 *   same-`ticker.lastTime` and a **re-entrancy** guard so postrender + ticker cannot
 *   nest two GPU passes in one stack. When `renderingToScreen` exists, we skip RTT passes directly.
 * - **Transparent clear:** `renderer.runners.prerender` (or `renderer.on("prerender")`)
 *   forces `renderer.background.alpha = 0` at the **start** of each PIXI `render()`
 *   so Foundry cannot briefly clear opaque black over the Three canvas.
 *   If postrender is missing, fall back to `V3PixiThreeFrameBridge` ticker.
 *   `canvas.primary.sprite` is hidden on a **separate** ticker callback at
 *   `UPDATE_PRIORITY.NORMAL` so suppression runs **before** Foundry’s `LOW` render
 *   (see `v3PixiPrimarySuppressTickerPriority` in `V3FoundryCanvasIntegration.js`).
 * - The native PIXI view stays **visible** and stacked **above** the Three canvas
 *   (DOM order + z-index). Foundry’s `primary.sprite` output is suppressed so
 *   backgrounds / level art / PIXI token meshes are not shown, while interface
 *   (incl. grid) still renders. **Native `CanvasVisibility` / fog are disabled**
 *   during coexistence — their fullscreen pass is opaque over a second WebGL
 *   canvas (`V3FoundryCanvasIntegration.js`).
 * - Optional: stop the PIXI ticker (module setting) — disables pan/zoom; default off.
 * - Loads level background URLs into THREE.Texture and drives the sandwich.
 * - Token portraits (`V3TokenOverlay`) render into a premultiplied layer RT, then the
 *   sandwich shader composites them **between** lower and upper maps so upper-level
 *   geometry occludes tokens; drawings switch between deck/post-water compositing:
 *   below upper art when viewing an upper floor, above water when viewing ground.
 *   Water stays in `_overlayScene` after lighting.
 *   picks up Foundry scene darkness from the same frame context as illumination.
 * - Optional suffixed-level texture debug overlay (`setLevelTextureDebug`) shares
 *   the same map UV / pan-zoom path; see `V3LevelTextureCatalog.js`.
 *
 * Foundry DOM / view integration lives in `V3FoundryCanvasIntegration.js`.
 * Level texture debug orchestration lives in `V3HostLevelTextureDebugController.js`.
 *
 * **Flicker diagnostics** (file-local `const`s near the class, not runtime APIs):
 * - `V3_DEBUG_SKIP_ILLUMINATION_PASS` — skip `illumination.render`, blit albedo only.
 * - `V3_DEBUG_SKIP_OVERLAY_PASS` — skip water + token overlay pass.
 * While either is `true`, composite **dedupe throttling is disabled** so Three
 * keeps pace with every PIXI `postrender` (otherwise skipped frames + stale
 * underlay can look like violent flicker). Flip flags to `false` and
 * `V3Shine.rebuild()` to restore normal behaviour.
 */

import * as THREE from "../vendor/three.module.js";
import {
  resolveTwoFloorBackgrounds,
  resolveTwoFloorForegrounds,
} from "./V3FloorSourceResolver.js";
import { V3ThreeSandwichCompositor } from "./V3ThreeSandwichCompositor.js";
import { V3PixiThreeFrameBridge } from "./V3PixiThreeFrameBridge.js";
import { getViewedLevelIndex } from "./V3ViewedLevel.js";
import { readSceneBackgroundRgb01 } from "./V3SceneClip.js";
import { V3_LEVEL_TEXTURE_FLIP_Y } from "./V3RenderConventions.js";
import { V3MaskHub } from "./V3MaskHub.js";
import { V3MaskBindingController } from "./V3MaskBindingController.js";
import { floorKeyForIndex } from "./V3MaskHub.js";
import { V3WaterOverlay } from "./V3WaterOverlay.js";
import { V3AssetInventoryService } from "./V3AssetInventoryService.js";
import {
  resolveV3BoardMountParent,
  getV3BoardPixelSize,
  buildV3ViewUniformPayloadInto,
  beginV3FoundryCoexistence,
  restoreV3FoundryCoexistence,
  insertV3WebglCanvasUnderPixiView,
  syncV3FoundryGameplayPixiSuppression,
  syncV3FoundryGameplayPixiSuppressionLight,
  v3PixiPrimarySuppressTickerPriority,
  readV3PixiContextHasAlpha,
  syncV3WebglDomElementToPixiView,
  syncV3RendererPixelRatioToPixi,
} from "./V3FoundryCanvasIntegration.js";
import { V3HostLevelTextureDebugController } from "./V3HostLevelTextureDebugController.js";
import {
  V3TokenOverlay,
  V3_TOKEN_LAYER_BELOW_DECK,
  V3_TOKEN_LAYER_ON_DECK,
} from "./V3TokenOverlay.js";
import { V3DrawingOverlay } from "./V3DrawingOverlay.js";
import {
  loadSkyLightingDebugState,
  loadLightAppearanceDebugState,
  loadSceneColorGradeDebugState,
  loadTokenColorGradeDebugState,
  loadBuildingShadowsDebugState,
} from "./V3MaskDebugStorage.js";
import {
  V3BuildingShadowsPass,
  V3_BUILDING_SHADOWS_DEFAULTS,
} from "./V3BuildingShadowsPass.js";
import { getEffectiveFpsCap } from "./V3FpsPolicy.js";
import { V3IlluminationPipeline } from "./V3IlluminationPipeline.js";
import { V3FloorLightBufferPass } from "./V3FloorLightBufferPass.js";
import {
  createSkyReachOcclusionTerm,
  createBuildingShadowsOcclusionTerm,
} from "./V3IlluminationTerms.js";
import { V3EffectChain, V3_EFFECT_PHASES } from "./V3EffectChain.js";
import {
  createFullscreenQuad,
  createOpaqueBlitMaterial,
} from "./V3FullscreenPass.js";
import { V3DotScreenEffect } from "./effects/V3DotScreenEffect.js";
import { V3BloomEffect } from "./effects/V3BloomEffect.js";
import { V3HalftoneEffect } from "./effects/V3HalftoneEffect.js";
import { V3InvertEffect } from "./effects/V3InvertEffect.js";
import {
  V3ShaderWarmupCoordinator,
  V3_WARMUP_STATE,
  V3_WARMUP_TIER,
} from "./V3ShaderWarmupCoordinator.js";
import { probeWarmupHardware } from "./V3WarmupPolicy.js";

/** @param {number} n */
function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/**
 * Foundry scene darkness 0..1 (V12 `scene.darkness` / V13+ `environment.darknessLevel`).
 * @param {any} canvas
 * @returns {number}
 */
function readFoundrySceneDarkness01(canvas) {
  if (!canvas) return 0;
  try {
    const scene = canvas.scene;
    const env = scene?.environment;
    if (Number.isFinite(env?.darknessLevel)) return clamp01(Number(env.darknessLevel));
    if (Number.isFinite(scene?.darkness)) return clamp01(Number(scene.darkness));
    const cenv = canvas.environment;
    if (Number.isFinite(cenv?.darknessLevel)) return clamp01(Number(cenv.darknessLevel));
  } catch (_) {}
  return 0;
}

/** Separate scratches so darkness + per-light tint never stomp each other. */
const _tmpDarknessTintColor = new THREE.Color();
const _tmpLightTintColor = new THREE.Color();

/**
 * Foundry {@link canvas.environment.colors.ambientDarkness} as linear RGB factors.
 * Writes into `out` (length ≥ 3) to avoid per-frame `THREE.Color` / array alloc.
 * @param {any} canvas
 * @param {number[]} out
 */
function readFoundryDarknessTintLinearRgbInto(canvas, out) {
  try {
    const c = canvas?.environment?.colors?.ambientDarkness;
    if (c) {
      const sr = Number(c.r);
      const sg = Number(c.g);
      const sb = Number(c.b);
      if ([sr, sg, sb].every((n) => Number.isFinite(n))) {
        _tmpDarknessTintColor.setRGB(sr, sg, sb, THREE.SRGBColorSpace);
        out[0] = _tmpDarknessTintColor.r;
        out[1] = _tmpDarknessTintColor.g;
        out[2] = _tmpDarknessTintColor.b;
        return;
      }
    }
  } catch (_) {}
  _tmpDarknessTintColor.setHex(0x303030 >>> 0, THREE.SRGBColorSpace);
  out[0] = _tmpDarknessTintColor.r;
  out[1] = _tmpDarknessTintColor.g;
  out[2] = _tmpDarknessTintColor.b;
}

/**
 * @param {unknown} tint
 * @param {number[]} out length ≥ 3
 * @returns {boolean} true when the light has an actual chromatic tint
 */
function v3FoundryLightTintToLinearRgbInto(tint, out) {
  try {
    if (typeof tint === "number" && tint >= 0) {
      _tmpLightTintColor.setHex(tint >>> 0, THREE.SRGBColorSpace);
      out[0] = _tmpLightTintColor.r;
      out[1] = _tmpLightTintColor.g;
      out[2] = _tmpLightTintColor.b;
      return (out[0] + out[1] + out[2]) > 1e-4;
    }
    if (typeof tint === "string" && tint.length) {
      _tmpLightTintColor.set(tint);
      out[0] = _tmpLightTintColor.r;
      out[1] = _tmpLightTintColor.g;
      out[2] = _tmpLightTintColor.b;
      return (out[0] + out[1] + out[2]) > 1e-4;
    }
    if (tint && typeof tint === "object") {
      const r = Number(tint.r);
      const g = Number(tint.g);
      const b = Number(tint.b);
      if ([r, g, b].every((n) => Number.isFinite(n))) {
        _tmpLightTintColor.setRGB(r, g, b, THREE.SRGBColorSpace);
        out[0] = _tmpLightTintColor.r;
        out[1] = _tmpLightTintColor.g;
        out[2] = _tmpLightTintColor.b;
        return (out[0] + out[1] + out[2]) > 1e-4;
      }
    }
  } catch (_) {}
  out[0] = 1;
  out[1] = 1;
  out[2] = 1;
  return false;
}

/**
 * Same remapping as Foundry `BaseLightSource._updateCommonUniforms` for
 * `uniform attenuation` (graph referenced in source: desmos e7z0i7hrck).
 * @param {number} dataAttenuation 0..1 from AmbientLight config
 */
function v3FoundryShaderAttenuationFromData(dataAttenuation) {
  const a = Math.max(0, Math.min(1, Number(dataAttenuation) || 0.5));
  return (Math.cos(Math.PI * a ** 1.5) - 1) / -2;
}

/**
 * Mirrors `BaseLightSource._updateColorationUniforms` colorationAlpha rules.
 * @param {number} coloration technique id
 * @param {number} alpha document alpha 0..1
 */
function v3FoundryColorationAlphaForTechnique(coloration, alpha) {
  const c = Math.max(0, Math.min(9, Math.round(Number(coloration)) || 1));
  const al = Math.max(0, Math.min(1, Number(alpha) || 0.5));
  if (c === 0) return al ** 2;
  if (c === 4 || c === 5 || c === 6 || c === 9) return al;
  return al * 2;
}

/**
 * V14 AmbientLight `levels` SetField: only contribute on the floor(s) listed.
 * Empty / missing levels → treat as unscoped (include on every floor index).
 *
 * @param {any} doc AmbientLight document
 * @param {any} scene Foundry scene
 * @param {number} levelIndex index into scene.levels.sorted
 * @returns {boolean}
 */
function v3AmbientLightAffectsLevel(doc, scene, levelIndex) {
  const sorted = scene?.levels?.sorted;
  if (!Array.isArray(sorted) || sorted.length <= 1) return true;

  const Lv = sorted[levelIndex];
  const levelIdsTarget = new Set(
    [
      Lv?.id,
      Lv?._id,
      Lv?.uuid,
      Lv?.document?.id,
      Lv?.document?._id,
      Lv?.document?.uuid,
      // Some integrations persist level references by sorted index.
      levelIndex,
    ]
      .map((v) => (v == null ? "" : String(v).trim()))
      .filter(Boolean),
  );
  const readFinite = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const readBandBottom = (level) =>
    readFinite(
      level?.elevation
      ?? level?.rangeBottom
      ?? level?.document?.elevation
      ?? level?.document?.rangeBottom
      ?? level?.document?.flags?.levels?.rangeBottom,
    );
  const readBandTop = (level, nextLevel) =>
    readFinite(
      level?.rangeTop
      ?? level?.top
      ?? level?.document?.rangeTop
      ?? level?.document?.top
      ?? level?.document?.flags?.levels?.rangeTop
      ?? readBandBottom(nextLevel),
    );
  const levelBottom = readBandBottom(Lv);
  const levelTop = readBandTop(Lv, sorted[levelIndex + 1]);

  const cfg = doc?.config && typeof doc.config === "object" ? doc.config : {};
  // V14 stores the Levels id set on `doc.levels`; some Levels-compat paths mirror the
  // set onto `doc.flags.levels.levels`. Read both so ids authored via either surface route.
  const levelsSources = [
    doc.levels,
    doc?.light?.levels,
    doc?.document?.light?.levels,
    cfg.levels,
    cfg?.light?.levels,
    doc?.flags?.levels?.levels,
    doc?.flags?.levels?.inclusive,
  ];
  /** @type {string[]} */
  const arr = [];
  const pushId = (/** @type {any} */ raw) => {
    if (raw == null) return;
    if (typeof raw === "string" || typeof raw === "number") {
      const s = String(raw).trim();
      if (s) arr.push(s);
      return;
    }
    if (typeof raw === "object") {
      const id =
        raw?.id
        ?? raw?._id
        ?? raw?.document?.id
        ?? raw?.document?._id
        ?? null;
      if (id != null) {
        const s = String(id).trim();
        if (s) arr.push(s);
      }
    }
  };
  const pushFromShape = (/** @type {any} */ src) => {
    if (!src) return;
    if (Array.isArray(src)) {
      for (const v of src) pushFromShape(v);
      return;
    }
    if (typeof src === "string" || typeof src === "number") {
      pushId(src);
      return;
    }
    if (src instanceof Set) {
      for (const v of src.values()) pushFromShape(v);
      return;
    }
    if (src instanceof Map) {
      for (const [k, v] of src.entries()) {
        pushFromShape(k);
        if (v === true || v === 1 || v === "1") pushFromShape(k);
        else pushFromShape(v);
      }
      return;
    }
    if (typeof src.forEach === "function") {
      src.forEach((/** @type {any} */ v) => pushFromShape(v));
      return;
    }
    if (typeof src === "object") {
      // Some serializers store a map-like object: { "<levelId>": true }.
      for (const [k, v] of Object.entries(src)) {
        if (v === true || v === 1 || v === "1") pushId(k);
      }
      pushId(src);
    }
  };
  try {
    for (const src of levelsSources) {
      if (!src) continue;
      pushFromShape(src);
    }
  } catch (_) {}

  if (arr.length > 0 && levelIdsTarget.size > 0) {
    for (const id of arr) {
      if (levelIdsTarget.has(String(id))) return true;
    }
    return false;
  }

  const lightBottom = readFinite(doc?.elevation ?? doc?.flags?.levels?.rangeBottom);
  const lightTop = readFinite(doc?.flags?.levels?.rangeTop);
  if (lightBottom == null && lightTop == null) return true;

  const targetBottom = levelBottom ?? -Infinity;
  const targetTop = levelTop ?? Infinity;
  const sourceBottom = lightBottom ?? -Infinity;
  const sourceTop = lightTop ?? Infinity;
  return sourceBottom < targetTop && sourceTop >= targetBottom;
}

/**
 * Token lights follow the token's assigned level (matching {@link V3TokenOverlay}).
 * Tokens without an explicit level are treated as ground-floor / unscoped.
 *
 * @param {any} tokenDoc Token document
 * @param {any} scene Foundry scene
 * @param {number} levelIndex index into scene.levels.sorted
 * @returns {boolean}
 */
function v3TokenLightAffectsLevel(tokenDoc, scene, levelIndex) {
  const sorted = scene?.levels?.sorted;
  if (!Array.isArray(sorted) || sorted.length <= 1) return true;

  const targetLevel = sorted[levelIndex];
  const targetId = targetLevel?.id ?? targetLevel?.document?.id ?? null;
  if (!targetId) return true;

  const tokenLevel = tokenDoc?.level;
  if (typeof tokenLevel === "string" && tokenLevel && tokenLevel !== targetId) {
    if (typeof tokenDoc.includedInLevel === "function") {
      try { return !!tokenDoc.includedInLevel(targetId); } catch (_) {}
    }
    return false;
  }
  return true;
}

/**
 * Best-effort token light predicate for scene documents that may not expose the
 * live placeable `emitsLight` getter.
 *
 * @param {any} tokenLike Token placeable or document
 * @returns {boolean}
 */
function v3TokenLikeEmitsLight(tokenLike) {
  try {
    if (typeof tokenLike?.emitsLight === "boolean") return tokenLike.emitsLight;
    const doc = tokenLike?.document ?? tokenLike;
    const cfg =
      doc?.light && typeof doc.light === "object"
        ? doc.light
        : doc?.config && typeof doc.config === "object"
          ? doc.config
          : {};
    const dim = Number(cfg.dim ?? doc?.dimLight ?? 0);
    const bright = Number(cfg.bright ?? doc?.brightLight ?? 0);
    return dim > 0 || bright > 0;
  } catch (_) {}
  return false;
}

/**
 * Approximate token light center from document geometry when no live placeable
 * exists for the token on the active canvas layer.
 *
 * @param {any} canvas
 * @param {any} tokenDoc
 * @returns {[number, number]}
 */
function v3TokenDocCenterWorld(canvas, tokenDoc) {
  const grid = canvas?.grid;
  const gridSizeX =
    grid && typeof grid.sizeX === "number" && grid.sizeX > 0
      ? grid.sizeX
      : grid && typeof grid.size === "number" && grid.size > 0
        ? grid.size
        : 100;
  const gridSizeY =
    grid && typeof grid.sizeY === "number" && grid.sizeY > 0
      ? grid.sizeY
      : grid && typeof grid.size === "number" && grid.size > 0
        ? grid.size
        : 100;
  const w = Math.max(0, Number(tokenDoc?.width) || 1) * gridSizeX;
  const h = Math.max(0, Number(tokenDoc?.height) || 1) * gridSizeY;
  return [
    (Number(tokenDoc?.x) || 0) + w * 0.5,
    (Number(tokenDoc?.y) || 0) + h * 0.5,
  ];
}

/**
 * Best-effort read of token light authoring fields across Foundry generations.
 *
 * @param {any} tokenDoc
 * @returns {{
 *   dim: number,
 *   bright: number,
 *   color: any,
 *   alpha: number,
 *   angle: number,
 *   attenuation: number,
 *   luminosity: number,
 *   coloration: number,
 *   contrast: number,
 *   saturation: number,
 *   shadows: number
 * }}
 */
function v3ReadTokenLightFields(tokenDoc) {
  const light = tokenDoc?.light && typeof tokenDoc.light === "object" ? tokenDoc.light : {};
  return {
    dim: Number(light.dim ?? tokenDoc?.dimLight ?? 0),
    bright: Number(light.bright ?? tokenDoc?.brightLight ?? 0),
    color: light.color ?? tokenDoc?.lightColor ?? tokenDoc?.tint ?? tokenDoc?.color ?? null,
    alpha: Number(light.alpha ?? tokenDoc?.lightAlpha ?? tokenDoc?.alpha ?? 0.5),
    angle: Number(light.angle ?? tokenDoc?.lightAngle ?? 360),
    attenuation: Number(light.attenuation ?? tokenDoc?.attenuation ?? 0.5),
    luminosity: Number(light.luminosity ?? tokenDoc?.luminosity ?? 0.5),
    coloration: Number(light.coloration ?? tokenDoc?.coloration ?? 1),
    contrast: Number(light.contrast ?? tokenDoc?.contrast ?? 0),
    saturation: Number(light.saturation ?? tokenDoc?.saturation ?? 0),
    shadows: Number(light.shadows ?? tokenDoc?.shadows ?? 0),
  };
}

/**
 * Flicker diagnostic: when `true`, skip {@link V3IlluminationPipeline#render} and
 * blit `_albedoRT.texture` fullscreen (unlit albedo). Set to `false` for normal lighting.
 */
const V3_DEBUG_SKIP_ILLUMINATION_PASS = false;

/** When `true`, skip post-light overlays (`_overlayScene` water). */
const V3_DEBUG_SKIP_OVERLAY_PASS = false;
/** Must match `MAX_FL_POLY` in `V3FloorLightBufferPass.js`. */
const V3_LIGHT_POLY_VERTEX_CAP = 16;

/** While any flicker-debug skip is on, do not throttle composites (spacing + same-ticker-LT). */
function v3DebugFlickerCompositeUnthrottled() {
  return V3_DEBUG_SKIP_ILLUMINATION_PASS || V3_DEBUG_SKIP_OVERLAY_PASS;
}

/**
 * @param {{
 *   logger?: {log: Function, warn: Function},
 *   stopFoundryTicker?: boolean,
 *   frameBridgeSetting?: string,
 *   flickerDiagnosticsEnabled?: () => boolean,
 * }} [opts]
 */
export class V3ThreeSceneHost {
  constructor({
    logger,
    stopFoundryTicker = false,
    frameBridgeSetting,
    flickerDiagnosticsEnabled,
  } = {}) {
    this.log = logger?.log ?? (() => {});
    this.warn = logger?.warn ?? (() => {});
    this.stopFoundryTicker = !!stopFoundryTicker;
    this._frameBridge = new V3PixiThreeFrameBridge({
      frameBridgeSetting,
      logger: { log: this.log, warn: this.warn },
    });

    /** @type {any|null} */ this.canvas = null;
    /** @type {THREE.WebGLRenderer|null} */ this.renderer = null;
    /** @type {V3ThreeSandwichCompositor|null} */ this.compositor = null;
    /** @type {THREE.TextureLoader|null} */ this.loader = null;

    /** @type {{lowerSrc:string|null, upperSrc:string|null, totalCount:number, source:string}|null} */
    this.srcs = null;
    /** @type {{lowerSrc:string|null, upperSrc:string|null, totalCount:number, source:string}|null} */
    this.fgSrcs = null;

    this._mountToken = 0;
    this._onResize = null;
    /** @type {number} */ this._frameCount = 0;

    /** FNV-1a hash of last floor-light pass inputs — when unchanged, skip GPU rebuild. */
    /** @type {number|null} */ this._floorLightPassSig = null;
    /** @type {any|null} last `floorLightBufferPass.run` result for reuse */
    this._floorLightPassCache = null;

    /** @type {import("./V3FoundryCanvasIntegration.js").V3FoundryCoexistenceRestore|null} */
    this._foundryRestore = null;

    this._onPixiTickRender = this._onPixiTickRender.bind(this);
    this._onPixiPrerenderBound = this._onPixiRendererPrerender.bind(this);
    /** @type {(() => void)|null} */
    this._pixiPrePrimarySuppressTick = null;
    /** @type {any|null} */ this._pixiPreSuppressTickerApp = null;
    /** @type {HTMLElement|null} */ this._mountParent = null;

    /** @type {ResizeObserver|null} */
    this._boardResizeObserver = null;
    /** @type {number|null} rAF handle coalescing ResizeObserver → one setSize per frame */
    this._boardResizeRaf = null;

    /** @type {V3WaterOverlay|null} */
    this._waterOverlay = null;
    /** @type {(() => void)|null} */
    this._unregisterWaterLower = null;
    /** @type {(() => void)|null} */
    this._unregisterWaterUpper = null;

    /** @type {number|null} */ this._lastViewedLevelIndex = null;

    /** @type {V3AssetInventoryService} */
    this.assetInventory = new V3AssetInventoryService({
      logger: { log: this.log, warn: this.warn },
    });
    /** @type {V3MaskHub} */
    this.maskHub = new V3MaskHub({ logger: { log: this.log, warn: this.warn } });
    /** @type {V3MaskBindingController} */
    this.maskBindings = new V3MaskBindingController({
      hub: this.maskHub,
      logger: { log: this.log, warn: this.warn },
    });

    /**
     * Tweakpane-bound params for the built-in sky-reach occlusion term (see
     * `V3IlluminationPipeline` + `createSkyReachOcclusionTerm`). Kept on the
     * host so the pane can rebind after remount without re-registering the
     * pipeline term.
     * @type {{ enabled: boolean, useSceneDarkness: boolean, manualDarkness01: number, strength: number }}
     */
    this.skyLighting = loadSkyLightingDebugState({
      enabled: true,
      useSceneDarkness: true,
      manualDarkness01: 1.0,
      strength: 0.9,
    });

    /**
     * Tweakpane-bound params for the current radial light appearance model. These
     * let us match native Foundry by eye without recompiling shader constants.
     * @type {{ addScale: number, dimRadiusStrength: number, brightRadiusStrength: number, illuminationStrength: number, colorationStrength: number, colorationReflectivity: number, colorationSaturation: number, groundSaturation: number, groundContrast: number }}
     */
    this.lightAppearance = loadLightAppearanceDebugState({
      addScale: 0.5,
      dimRadiusStrength: 0.7,
      brightRadiusStrength: 4.0,
      illuminationStrength: 0.25,
      colorationStrength: 1.0,
      colorationReflectivity: 1.0,
      colorationSaturation: 1.0,
      groundSaturation: 0.0,
      groundContrast: -0.2,
    });
    // Defensive migration for older persisted debug objects.
    {
      const la = this.lightAppearance;
      if (la && typeof la === "object") {
        if (!Number.isFinite(Number(la.dimRadiusStrength))) la.dimRadiusStrength = 1.55;
        if (!Number.isFinite(Number(la.brightRadiusStrength))) la.brightRadiusStrength = 4.6;
      }
    }

    /**
     * Tweakpane-bound final scene color grading after illumination, used to tune
     * the overall V3 render toward native Foundry appearance.
     * @type {{ enabled: boolean, exposure: number, temperature: number, tint: number, brightness: number, contrast: number, saturation: number, vibrance: number, liftColor: [number, number, number], gammaColor: [number, number, number], gainColor: [number, number, number], masterGamma: number, toneMapping: number }}
     */
    this.sceneColorGrade = loadSceneColorGradeDebugState({
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
    });

    /**
     * Token-only grading masked by token deck alpha in illumination resolve.
     * @type {{ enabled: boolean, exposure: number, temperature: number, tint: number, brightness: number, contrast: number, saturation: number, vibrance: number, amount: number }}
     */
    this.tokenColorGrade = loadTokenColorGradeDebugState({
      enabled: true,
      exposure: 0.9,
      temperature: 0.0,
      tint: 0.0,
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.25,
      vibrance: 0.0,
      amount: 1.0,
    });

    /**
     * Tweakpane-bound params for the {@link V3BuildingShadowsPass} occlusion
     * term. Persisted via {@link loadBuildingShadowsDebugState}. Owned by the
     * host so `V3Shine.effects.buildingShadowsParams()` and the V3 config pane
     * can mutate a single live reference.
     * @type {import("./V3BuildingShadowsPass.js").BuildingShadowsParams}
     */
    this.buildingShadows = loadBuildingShadowsDebugState({
      ...V3_BUILDING_SHADOWS_DEFAULTS,
    });

    /**
     * Per-frame shadow generator. Creates a scene-UV occlusion texture that
     * the illumination pipeline consumes via
     * {@link createBuildingShadowsOcclusionTerm}. Initialized here so the
     * term registration below can lock onto a stable instance; attached to
     * the renderer during {@link mount}.
     * @type {V3BuildingShadowsPass}
     */
    this.buildingShadowsPass = new V3BuildingShadowsPass({
      logger: { log: this.log, warn: this.warn },
    });

    /**
     * Per-frame texture-driven Foundry radial light accumulator + multi-floor
     * downward cascade. Replaces the legacy `uFl*` / `uTfFl*` uniform-array
     * path inside {@link V3IlluminationPipeline}: each floor's lights are
     * additively rendered into RGBA8 scene-UV buffers (batched 16 lights at
     * a time) and upper floors are then cascaded downward through the
     * combined occluder alpha (albedo + foreground + tiles) with
     * `chain_next = chain_prev * transmit(occluder_U)`. The four output
     * textures are bound to the illumination shader via
     * {@link V3IlluminationPipeline#setLightBufferTextures} each frame.
     *
     * @type {V3FloorLightBufferPass}
     */
    this.floorLightBufferPass = new V3FloorLightBufferPass({
      logger: { log: this.log, warn: this.warn },
      // Moderate defaults: quality scales with scene size under a VRAM budget;
      // static lights skip re-rasterisation (see `_floorLightPassSig`).
      maxEdgePx: 4096,
      lightBufferVramBudgetMiB: 384,
    });

    /** @type {V3IlluminationPipeline} */
    this.illumination = new V3IlluminationPipeline();
    this.illumination.registerOcclusionTerm(
      createSkyReachOcclusionTerm({ getParams: () => this.skyLighting }),
    );
    this.illumination.registerOcclusionTerm(
      createBuildingShadowsOcclusionTerm({ getParams: () => this.buildingShadows }),
    );

    /**
     * Screen-space effect chain. Runs **after** illumination and water, and
     * **before** drawings / PIXI UI — see the pipeline placement docblock in
     * `V3EffectChain.js`. Owns two ping-pong RTs that are only allocated when
     * at least one effect is enabled (see {@link hasAnyActiveEffects}).
     *
     * @type {V3EffectChain}
     */
    this.effectChain = new V3EffectChain({
      logger: { log: this.log, warn: this.warn },
    });

    /**
     * Screen-space bloom (Unreal-style mip blur). Order 200 so it runs before
     * stylised filters such as dot-screen when both are enabled.
     *
     * @type {V3BloomEffect}
     */
    this.bloomEffect = new V3BloomEffect({
      phase: V3_EFFECT_PHASES.POST_SCENE_OVERLAY,
      order: 200,
      enabled: false,
    });
    this.effectChain.register(this.bloomEffect);

    /**
     * Disabled-by-default stylised halftone. Registered here so the chain is
     * non-empty out of the box — toggling `effectChain.getEffect('dotScreen').enabled = true`
     * (or via the Tweakpane surface) is sufficient to exercise the new path.
     *
     * @type {V3DotScreenEffect}
     */
    this.dotScreenEffect = new V3DotScreenEffect({
      phase: V3_EFFECT_PHASES.POST_SCENE_OVERLAY,
      order: 500,
      enabled: false,
    });
    this.effectChain.register(this.dotScreenEffect);

    /**
     * CMYK-style halftone post effect (V2 parity) — disabled by default.
     *
     * @type {V3HalftoneEffect}
     */
    this.halftoneEffect = new V3HalftoneEffect({
      phase: V3_EFFECT_PHASES.POST_SCENE_OVERLAY,
      order: 600,
      enabled: false,
    });
    this.effectChain.register(this.halftoneEffect);

    /**
     * Color inversion pass — disabled by default.
     *
     * @type {V3InvertEffect}
     */
    this.invertEffect = new V3InvertEffect({
      phase: V3_EFFECT_PHASES.POST_SCENE_OVERLAY,
      order: 700,
      enabled: false,
    });
    this.effectChain.register(this.invertEffect);

    /**
     * Shader warmup coordinator. Tracks staged program compilation so the
     * first composite after mount does not stall on large `RawShaderMaterial`
     * first-use compilation. See {@link V3ShaderWarmupCoordinator} for the
     * stage / progress contract.
     *
     * Per-mount lifecycle:
     *   1. {@link mount} sets the coordinator to `loading-resources` before
     *      texture / mask loads so any attached UI can surface progress.
     *   2. After the renderer exists and `_resizeToBoard` has allocated RTs,
     *      {@link _startShaderWarmup} queues core stages (sandwich →
     *      illumination → floor light buffer → building shadows → final blit)
     *      and optional stages (one per currently-enabled effect).
     *   3. {@link unmount} cancels any in-flight warmup run without disposing
     *      the coordinator; the same instance is reused on remount so
     *      persisted adaptive metrics stay visible via
     *      {@link V3ShaderWarmupCoordinator#readPersistedMetrics}.
     *
     * @type {V3ShaderWarmupCoordinator}
     */
    this.shaderWarmup = new V3ShaderWarmupCoordinator({
      logger: { log: this.log, warn: this.warn },
    });

    /**
     * Intermediate render target fed by the sandwich (albedo + checker).
     * Allocated on first resize; resized when the board pixel size changes.
     * @type {THREE.WebGLRenderTarget|null}
     */
    this._albedoRT = null;

    /**
     * Lit-scene render target. Only allocated while the effect chain has at
     * least one active effect — the illumination pass writes here instead of
     * directly to the default framebuffer so the chain can read it as input.
     * Same size / format as {@link _albedoRT}.
     * @type {THREE.WebGLRenderTarget|null}
     */
    this._litRT = null;

    /**
     * Opaque fullscreen blit used to copy the chain's final RT to the default
     * framebuffer. Preserves the "opaque lit output" invariant enforced by
     * `V3IlluminationPipeline.render` — without this the alpha could be < 1
     * after water/weather rendered into an RT, exposing the PIXI canvas
     * through the Three canvas and flashing dark one-frame gaps.
     */
    /** @type {import("./V3FullscreenPass.js").V3FullscreenQuad|null} */
    this._fbBlitQuad = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._fbBlitMaterial = null;

    /**
     * Premultiplied token sprites at drawing-buffer resolution (paired with {@link #_albedoRT}).
     * **Below-deck** = Foundry levels below the camera floor (see {@link V3TokenOverlay} layers).
     * **On-deck** = tokens on the same sorted level as the camera (drawn above upper albedo).
     * @type {THREE.WebGLRenderTarget|null}
     */
    this._tokenBelowRT = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._tokenAboveRT = null;

    /** Token sprites only — composited into the map sandwich, not the water overlay. */
    this._tokenScene = new THREE.Scene();

    /**
     * Separate scene for overlays that render **after** the illumination pass
     * (water only; tokens use {@link #_tokenScene}). Kept off the sandwich scene so
     * the resolve pass does not try to light water.
     * @type {THREE.Scene}
     */
    this._overlayScene = new THREE.Scene();
    /** Drawings routed above water when upper-floor compositing is off. */
    this._drawingOverlayScene = new THREE.Scene();

    /** Lazy fullscreen blit when {@link V3_DEBUG_SKIP_ILLUMINATION_PASS} is true. */
    this._debugAlbedoBlitScene = /** @type {THREE.Scene|null} */ (null);
    this._debugAlbedoBlitMesh = /** @type {THREE.Mesh|null} */ (null);

    this._levelTexDebug = new V3HostLevelTextureDebugController({
      loadTexture: (url) => this._loadTexture(url),
      getScene: () => this.canvas?.scene ?? null,
      getCompositorScene: () => this.compositor?.scene ?? null,
      getUpperAlbedoTex: () => this.compositor?.upperTex ?? null,
      getBoardPixelSize: () => getV3BoardPixelSize(this.canvas, this.renderer),
      syncViewportUniforms: () => this._syncViewportUniforms(),
      log: (...args) => this.log(...args),
      warn: (...args) => this.warn(...args),
    });

    /** @type {V3TokenOverlay|null} */
    this._tokenOverlay = new V3TokenOverlay({
      warn: (...args) => this.warn(...args),
    });
    /** @type {V3DrawingOverlay|null} */
    this._drawingOverlay = new V3DrawingOverlay({
      warn: (...args) => this.warn(...args),
    });
    /** @type {"deck"|"postWater"|null} */
    this._drawingOverlayPlacement = null;

    /**
     * Pixi v8 `SystemRunner` listener: `postrender(options)` after each `render()`.
     * @type {{ postrender: (opts?: unknown) => void }}
     */
    this._v3PostrenderItem = {
      postrender: (opts) => {
        this._onPixiRendererPostrender(opts);
      },
    };
    /**
     * Pixi v8 `SystemRunner` listener: `prerender` at the **start** of each
     * `render()` — re-assert transparent GL clear **before** Foundry's clear so
     * a briefly-opaque `renderer.background` cannot paint a black plate over
     * the Three canvas for one frame (see `V3FoundryCanvasIntegration.js`).
     * @type {{ prerender: (opts?: unknown) => void }}
     */
    this._v3PrerenderItem = {
      prerender: () => {
        this._onPixiRendererPrerender();
      },
    };
    /** @type {boolean} true when using `renderer.runners.prerender` */
    this._pixiPrerenderUsesRunner = false;
    /** @type {any|null} renderer we attached `on("prerender")` to */
    this._pixiPrerenderRenderer = null;
    /** @type {"none"|"postrender"|"ticker"|"raf"} */
    this._threeCompositeDrive = "none";
    /** @type {number} postrender calls skipped (not main screen RT) */
    this._diagPostrenderSkippedRt = 0;
    /** @type {number} main-screen postrender → Three composites */
    this._diagPostrenderMain = 0;
    /** @type {boolean|null} last `RenderTargetSystem.renderingToScreen` seen in postrender */
    this._diagLastRenderingToScreen = null;
    /** @type {number} largest coalesced burst size seen since mount. */
    this._diagPostrenderMaxBurst = 0;
    /** @type {number} running sum of coalesced burst sizes (for mean). */
    this._diagPostrenderBurstTotal = 0;
    /** @type {number} number of burst flushes recorded. */
    this._diagPostrenderBurstFlushes = 0;
    /** @type {number} last composite latency in ms (flush-schedule → composite). */
    this._diagPostrenderLastLatencyMs = 0;
    /** @type {number} max composite latency ms observed since mount. */
    this._diagPostrenderMaxLatencyMs = 0;
    /** @type {number} total postrender events observed (bursts + main). */
    this._diagPostrenderEvents = 0;
    /** @type {number} prerender ticks where `bg.alpha` was non-zero on entry. */
    this._diagPixiBgAlphaNonZeroObservations = 0;
    /** @type {number|null} last non-zero `bg.alpha` value observed. */
    this._diagPixiBgAlphaLastObserved = null;
    /** @type {number|null} `performance.now()` when we last ran the Three GPU composite. */
    this._v3CompositeLastRunWallMs = null;
    /** @type {number|null} last `canvas.app.ticker.lastTime` we composited for (same-tick dedupe). */
    this._v3CompositeLastPixiTickerLt = null;
    /** True while inside the Three composite (blocks nested postrender/ticker). */
    this._v3CompositeReentrant = false;

    /**
     * Reused pan/zoom payload for {@link buildV3ViewUniformPayloadInto} — avoids
     * allocating a new object + arrays every frame (GC pressure → long-session
     * stutter / perceived “worsening” flicker).
     * @type {{ pivotWorld: [number, number], invScale: number, sceneRect: [number, number, number, number] }}
     */
    this._viewUniformPayload = {
      pivotWorld: [0, 0],
      invScale: 1,
      sceneRect: [0, 0, 1, 1],
    };
    /** @type {THREE.Color} clip color scratch — {@link _syncClipColor} */
    this._scratchClipColor = new THREE.Color();
    /** @type {[number, number, number]} passed to `setClipColorRgb` without alloc */
    this._clipRgbTriplet = /** @type {[number, number, number]} */ ([0, 0, 0]);
    /** @type {THREE.Vector2} drawing-buffer size scratch — {@link _resizeToBoard} */
    this._drawingBufferSizeVec = new THREE.Vector2();
    /** Last applied board CSS size — {@link _resizeToBoard} hysteresis vs subpixel jitter */
    this._resizeStableW = /** @type {number|null} */ (null);
    this._resizeStableH = /** @type {number|null} */ (null);

    /** When true (module setting), log multi-composite-per-rAF and GL context loss. */
    this._flickerDiagEnabled = typeof flickerDiagnosticsEnabled === "function"
      ? flickerDiagnosticsEnabled
      : null;
    this._flickerDiagCompositesThisRaf = 0;
    /** @type {number|null} */
    this._flickerDiagRafHandle = null;
    /** Composites counted in the last completed animation frame (-1 before first rAF). */
    this._flickerDiagLastRafCompositeCount = -1;
    /** Number of rAF buckets where composite count was greater than one. */
    this._flickerDiagMultiCompositeEvents = 0;
    this._flickerDiagThreeGlLoss = 0;
    this._flickerDiagThreeGlRestore = 0;
    this._flickerDiagPixiGlLoss = 0;
    this._flickerDiagPixiGlRestore = 0;
    this._flickerDiagListenersAttached = false;

    this._onThreeCanvasWebglContextLost = (ev) => {
      if (!this._flickerDiagActive()) return;
      this._flickerDiagThreeGlLoss++;
      this.warn("[V3 flicker diag] webglcontextlost: Three canvas", ev?.statusMessage ?? "");
    };
    this._onThreeCanvasWebglContextRestored = () => {
      if (!this._flickerDiagActive()) return;
      this._flickerDiagThreeGlRestore++;
      this.warn("[V3 flicker diag] webglcontextrestored: Three canvas");
    };
    this._onPixiCanvasWebglContextLost = (ev) => {
      if (!this._flickerDiagActive()) return;
      this._flickerDiagPixiGlLoss++;
      this.warn("[V3 flicker diag] webglcontextlost: PIXI canvas", ev?.statusMessage ?? "");
    };
    this._onPixiCanvasWebglContextRestored = () => {
      if (!this._flickerDiagActive()) return;
      this._flickerDiagPixiGlRestore++;
      this.warn("[V3 flicker diag] webglcontextrestored: PIXI canvas");
    };
  }

  _flickerDiagActive() {
    try {
      return typeof this._flickerDiagEnabled === "function" && this._flickerDiagEnabled();
    } catch (_) {
      return false;
    }
  }

  _attachFlickerDiagListeners() {
    if (this._flickerDiagListenersAttached) return;
    const threeEl = this.renderer?.domElement;
    const pixiView = this.canvas?.app?.view;
    if (threeEl) {
      threeEl.addEventListener("webglcontextlost", this._onThreeCanvasWebglContextLost, false);
      threeEl.addEventListener("webglcontextrestored", this._onThreeCanvasWebglContextRestored, false);
    }
    if (pixiView && pixiView !== threeEl) {
      pixiView.addEventListener("webglcontextlost", this._onPixiCanvasWebglContextLost, false);
      pixiView.addEventListener("webglcontextrestored", this._onPixiCanvasWebglContextRestored, false);
    }
    this._flickerDiagListenersAttached = true;
  }

  _detachFlickerDiagListeners() {
    if (!this._flickerDiagListenersAttached) return;
    const threeEl = this.renderer?.domElement;
    const pixiView = this.canvas?.app?.view;
    if (threeEl) {
      try {
        threeEl.removeEventListener("webglcontextlost", this._onThreeCanvasWebglContextLost, false);
        threeEl.removeEventListener("webglcontextrestored", this._onThreeCanvasWebglContextRestored, false);
      } catch (_) {}
    }
    if (pixiView && pixiView !== threeEl) {
      try {
        pixiView.removeEventListener("webglcontextlost", this._onPixiCanvasWebglContextLost, false);
        pixiView.removeEventListener("webglcontextrestored", this._onPixiCanvasWebglContextRestored, false);
      } catch (_) {}
    }
    this._flickerDiagListenersAttached = false;
  }

  _cancelFlickerDiagRaf() {
    if (this._flickerDiagRafHandle == null) return;
    try {
      cancelAnimationFrame(this._flickerDiagRafHandle);
    } catch (_) {}
    this._flickerDiagRafHandle = null;
  }

  /** Count Three composites per browser animation frame when diagnostics are on. */
  _recordFlickerDiagCompositeTick() {
    if (!this._flickerDiagActive()) return;
    this._flickerDiagCompositesThisRaf++;
    if (this._flickerDiagRafHandle != null) return;
    this._flickerDiagRafHandle = requestAnimationFrame(() => {
      this._flickerDiagRafHandle = null;
      const n = this._flickerDiagCompositesThisRaf;
      this._flickerDiagCompositesThisRaf = 0;
      this._flickerDiagLastRafCompositeCount = n;
      if (n > 1) {
        this._flickerDiagMultiCompositeEvents++;
        this.warn(
          `[V3 flicker diag] ${n} Three composites in one animation frame (expected 1); ` +
            "multiple PIXI postrender/main-screen passes or ticker + postrender may be colliding.",
        );
      }
    });
  }

  /**
   * @param {any} canvas Foundry canvas
   */
  async mount(canvas) {
    if (!canvas?.scene) {
      this.warn("mount skipped: no scene");
      return;
    }
    this.canvas = canvas;
    const myToken = ++this._mountToken;

    // Reset warmup coordinator for this mount: any previous run is cancelled
    // so stale stages cannot fire against a new renderer, and the state moves
    // to `loading-resources` so any attached UI can surface early progress
    // (texture + mask loads happen below before the core shader stages run).
    try {
      this.shaderWarmup.clear();
      this.shaderWarmup.setState(V3_WARMUP_STATE.LOADING_RESOURCES);
    } catch (err) {
      this.warn("shaderWarmup reset failed", err);
    }

    THREE.ColorManagement.enabled = true;

    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
        // `preserveDrawingBuffer: true` is required for the V3 dual-canvas stack.
        // After the browser compositor samples our Three swap chain, the drawing
        // buffer contents become *undefined* if this flag is false — so any
        // frame where Three does not re-render (main-thread stall, PIXI-vs-Three
        // vsync drift between the two independent WebGL swap chains, context
        // loss recovery, Foundry skipping a PIXI tick for FPS policy, etc.)
        // presents as an empty / cleared Three canvas under the transparent
        // PIXI canvas on top → visible as a single-frame black flash.
        // The minor per-frame cost of preservation is far below the cost of
        // user-visible flicker. See `docs/archive/2026-04-20-pre-restructure/V3-flicker-investigation.md` F7.
        preserveDrawingBuffer: true,
      });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      // `autoClear: false` on the top-level renderer so the illumination pass
      // can decide per-frame whether to clear the default framebuffer. The
      // illumination fullscreen quad writes every pixel opaquely (see
      // V3IlluminationPipeline FRAG), so clearing beforehand is redundant AND
      // introduces a transient "cleared swap chain" window that the browser
      // compositor can sample if Three and PIXI present on different vsyncs.
      this.renderer.autoClear = false;
      this.renderer.setClearColor(0x000000, 0);
      // No z-index: stay in Foundry’s layer order vs HTML HUD; DOM insert is before
      // `app.view` so transparent PIXI still paints above this canvas.
      this.renderer.domElement.style.cssText =
        "position:absolute;display:block;pointer-events:none;";
    }

    // Now that the renderer / GL context exist, feed a hardware snapshot to
    // the warmup coordinator so the adaptive (`"auto"`) mode can weigh GPU
    // tier alongside persisted timing. Done *before* the core warmup is
    // queued below so `resolvedMode()` returns the informed decision the
    // overlay will display. Failures are swallowed — adaptive mode simply
    // falls back to "fast" when hardware info is absent.
    try {
      const hw = probeWarmupHardware({ renderer: this.renderer });
      this.shaderWarmup.setHardware(hw);
    } catch (err) {
      this.warn("shaderWarmup hardware probe failed", err);
    }

    const parent = resolveV3BoardMountParent(canvas);
    this._mountParent = parent;
    const pixiView = canvas?.app?.view ?? null;
    if (parent) {
      insertV3WebglCanvasUnderPixiView(parent, this.renderer.domElement, pixiView);
    }
    syncV3WebglDomElementToPixiView(pixiView, this.renderer?.domElement ?? null);

    if (!this.compositor) this.compositor = new V3ThreeSandwichCompositor();
    if (!this.loader) this.loader = new THREE.TextureLoader();

    try {
      this._tokenOverlay?.attach(this._tokenScene, canvas);
    } catch (err) {
      this.warn("V3 token overlay attach failed", err);
    }
    try {
      this._drawingOverlay?.attach(this._tokenScene, canvas);
      this._drawingOverlayPlacement = "deck";
    } catch (err) {
      this.warn("V3 drawing overlay attach failed", err);
    }

    this.maskHub.attach({
      renderer: this.renderer,
      loader: this.loader,
      getScene: () => this.canvas?.scene ?? null,
      getCompositor: () => this.compositor,
      inventory: this.assetInventory,
    });

    try {
      this.buildingShadowsPass.attach(this.renderer);
    } catch (err) {
      this.warn("buildingShadowsPass.attach failed", err);
    }
    try {
      this.floorLightBufferPass.attach(this.renderer);
    } catch (err) {
      this.warn("floorLightBufferPass.attach failed", err);
    }

    this._foundryRestore = beginV3FoundryCoexistence(canvas, this._foundryRestore, {
      stopFoundryTicker: this.stopFoundryTicker,
      log: this.log.bind(this),
      warn: this.warn.bind(this),
    });

    this.srcs = resolveTwoFloorBackgrounds(canvas.scene);
    this.log("resolved sources", this.srcs);
    this.fgSrcs = resolveTwoFloorForegrounds(canvas.scene);
    this.log("resolved foreground sources", this.fgSrcs);

    try {
      if (this.srcs.lowerSrc && !this.srcs.upperSrc) {
        const lower = await this._loadTexture(this.srcs.lowerSrc);
        if (myToken !== this._mountToken) return;
        this.compositor.setTextures(lower, null);
        this.compositor.setApplyUpper(false);
        this.log("single-level background bound (lower only)");
      } else if (!this.srcs.lowerSrc || !this.srcs.upperSrc) {
        this.warn("no valid level backgrounds", {
          totalCount: this.srcs.totalCount,
          source: this.srcs.source,
        });
        this.compositor.setTextures(null, null);
        this.compositor.setApplyUpper(false);
      } else {
        const [lower, upper] = await Promise.all([
          this._loadTexture(this.srcs.lowerSrc),
          this._loadTexture(this.srcs.upperSrc),
        ]);
        if (myToken !== this._mountToken) return;
        this.compositor.setTextures(lower, upper);
        this._syncFloorStackUniforms();
        this.log("two-level backgrounds bound");
      }
    } catch (err) {
      this.warn("texture load failed", err);
    }

    try {
      await this._bindForegroundTextures(myToken);
    } catch (err) {
      this.warn("foreground texture load failed", err);
    }

    this._installResize();
    this._resizeToBoard();
    this._startLoop();
    this._attachFlickerDiagListeners();

    try {
      await this.maskHub.compose();
    } catch (err) {
      this.warn("maskHub.compose failed", err);
    }

    this._ensureWaterOverlay();
    this._bindWaterMasks();

    // Kick off staged shader warmup. This is fire-and-forget: even in
    // `gated` mode the caller of `mount()` does not wait for GPU compiles —
    // the loading overlay renders from the coordinator's snapshot events
    // and the main composite loop can paint a minimal frame immediately
    // (the first few frames pay per-material compile cost organically while
    // the warmup queue runs in parallel, and each stage that compiles ahead
    // of an organic first-use saves that stall). Errors are swallowed and
    // reported through the coordinator's stage records.
    try {
      this._startShaderWarmup({ mountToken: myToken });
    } catch (err) {
      this.warn("_startShaderWarmup failed", err);
    }
  }

  /**
   * Queue the V3 shader warmup stages for this mount and start running them.
   *
   * Core stages compile the programs that every V3 frame needs:
   *
   *   1. **Sandwich compositor** (`V3ThreeSandwichCompositor`) — lower +
   *      upper album + token decks → `_albedoRT`.
   *   2. **Illumination pipeline** (`V3IlluminationPipeline`) — the single
   *      large resolve shader that samples occluders / direct terms / light
   *      buffers and writes the lit scene.
   *   3. **Floor light buffer** (`V3FloorLightBufferPass`) — batched radial
   *      light + cascade + occluder seed/max + init-state materials.
   *   4. **Building shadows** (`V3BuildingShadowsPass`) — project / cascade /
   *      occluder seed/max / combine / init materials.
   *   5. **Final blit** — opaque pass-through used whenever the effect
   *      chain is active.
   *
   * Optional stages compile the materials for each currently-enabled screen
   * effect. Effects that are disabled are left alone — their materials stay
   * un-instantiated (per the lazy `_initialize` contract in each effect
   * class) so users do not pay compile cost for effects they never use.
   *
   * @param {{ mountToken: number }} opts
   * @private
   */
  _startShaderWarmup(opts) {
    const mountToken = opts?.mountToken ?? this._mountToken;
    const coord = this.shaderWarmup;
    if (!coord) return;

    // The warmup must only run against the mount it was queued for; later
    // stages short-circuit via this predicate, which is cheaper than
    // cancelling the coordinator mid-run when `unmount` fires a new token.
    const isStale = () => mountToken !== this._mountToken || !this.renderer;

    // --- Core tier: required for a stable interactive frame. ---
    coord.addStage({
      id: "sandwich-compositor",
      label: "Compiling floor sandwich",
      tier: V3_WARMUP_TIER.CORE,
      skipIf: isStale,
      run: () => this._warmupCompileSandwich(),
    });
    coord.addStage({
      id: "illumination-resolve",
      label: "Compiling lighting pipeline",
      tier: V3_WARMUP_TIER.CORE,
      skipIf: isStale,
      run: () => this._warmupCompileIllumination(),
    });
    coord.addStage({
      id: "floor-light-buffer",
      label: "Compiling floor light buffers",
      tier: V3_WARMUP_TIER.CORE,
      skipIf: isStale,
      run: () => this._warmupCompileFloorLightBuffer(),
    });
    coord.addStage({
      id: "building-shadows",
      label: "Compiling building shadows",
      tier: V3_WARMUP_TIER.CORE,
      skipIf: isStale,
      run: () => this._warmupCompileBuildingShadows(),
    });
    coord.addStage({
      id: "final-blit",
      label: "Compiling final blit",
      tier: V3_WARMUP_TIER.CORE,
      skipIf: isStale,
      run: () => this._warmupCompileFinalBlit(),
    });

    // --- Optional tier: one stage per currently-enabled effect. ---
    this._queueEnabledEffectWarmupStages(isStale);

    void (async () => {
      try {
        await coord.runTier(V3_WARMUP_TIER.CORE);
        if (mountToken !== this._mountToken) return;
        await coord.runTier(V3_WARMUP_TIER.OPTIONAL);
      } catch (err) {
        this.warn("shader warmup run failed", err);
      }
    })();
  }

  /**
   * Queue a warmup stage for each currently-enabled screen effect registered
   * on {@link #effectChain}. Disabled effects are intentionally skipped: each
   * effect's `_initialize` is called lazily inside its own `render()` so the
   * first frame after a user toggles the effect on still pays the compile
   * cost organically — but the optional tier keeps the mount-time compile
   * budget proportional to what the player actually asked for.
   *
   * @param {() => boolean} isStale
   * @private
   */
  _queueEnabledEffectWarmupStages(isStale) {
    const coord = this.shaderWarmup;
    if (!coord || !this.effectChain) return;
    const snap = this.effectChain.snapshot?.();
    if (!snap) return;

    const queueFor = (effectId) => {
      if (!effectId) return;
      const effect = this.effectChain.getEffect(effectId);
      if (!effect) return;
      if (effect.enabled !== true) return;
      coord.addStage({
        id: `effect-${effectId}`,
        label: `Compiling effect: ${effectId}`,
        tier: V3_WARMUP_TIER.OPTIONAL,
        skipIf: () => isStale() || effect.enabled !== true,
        run: () => this._warmupCompileEffect(effect),
      });
    };

    const byPhase = snap.effects ?? {};
    for (const phaseName of Object.keys(byPhase)) {
      const list = byPhase[phaseName];
      if (!Array.isArray(list)) continue;
      for (const entry of list) queueFor(entry?.id);
    }
  }

  /**
   * Force compilation of the sandwich compositor program by calling
   * `renderer.compile(scene, camera)`. Three walks the scene and compiles
   * every referenced material variant; the sandwich uses one
   * `RawShaderMaterial` so this is a single program in practice.
   *
   * @private
   */
  _warmupCompileSandwich() {
    const comp = this.compositor;
    if (!this.renderer || !comp?.scene || !comp?.camera) return;
    try {
      this.renderer.compile(comp.scene, comp.camera);
    } catch (err) {
      this.warn("sandwich shader compile warmup failed", err);
    }
  }

  /**
   * Compile the illumination resolve program. This is the largest single
   * fragment shader in the V3 stack — compiling it ahead of the first
   * composite is the biggest win in the core tier.
   *
   * @private
   */
  _warmupCompileIllumination() {
    const pipeline = this.illumination;
    if (!this.renderer || !pipeline?.scene || !pipeline?.camera) return;
    try {
      this.renderer.compile(pipeline.scene, pipeline.camera);
    } catch (err) {
      this.warn("illumination shader compile warmup failed", err);
    }
  }

  /**
   * Compile each of the floor-light pass materials. The pass reuses a single
   * mesh whose material is swapped per sub-step (batch / cascade / init /
   * occluder-seed / occluder-max), so compilation is triggered by binding
   * each material onto the shared mesh and calling `renderer.compile`.
   *
   * @private
   */
  _warmupCompileFloorLightBuffer() {
    const pass = this.floorLightBufferPass;
    const mesh = pass?._mesh;
    const scene = pass?._quadScene;
    const camera = pass?._quadCamera;
    if (!this.renderer || !pass || !mesh || !scene || !camera) return;

    const materials = [
      pass._batchMaterial,
      pass._cascadeMaterial,
      pass._initStateMaterial,
      pass._occluderSeedMaterial,
      pass._occluderMaxMaterial,
    ].filter(Boolean);

    const prev = mesh.material;
    try {
      for (const mat of materials) {
        mesh.material = mat;
        try {
          this.renderer.compile(scene, camera);
        } catch (err) {
          this.warn(`floor-light material compile failed (${mat?.uuid})`, err);
        }
      }
    } finally {
      mesh.material = prev ?? null;
    }
  }

  /**
   * Compile each of the building-shadow pass materials. Same pattern as
   * {@link _warmupCompileFloorLightBuffer}: a shared mesh is re-skinned
   * per sub-step, so we swap each material in turn and ask Three to compile.
   *
   * @private
   */
  _warmupCompileBuildingShadows() {
    const pass = this.buildingShadowsPass;
    const mesh = pass?._mesh;
    const scene = pass?._quadScene;
    const camera = pass?._quadCamera;
    if (!this.renderer || !pass || !mesh || !scene || !camera) return;

    const materials = [
      pass._projectMaterial,
      pass._cascadeMaterial,
      pass._occluderSeedMaterial,
      pass._occluderMaxMaterial,
      pass._combineMaterial,
      pass._initStateMaterial,
    ].filter(Boolean);

    const prev = mesh.material;
    try {
      for (const mat of materials) {
        mesh.material = mat;
        try {
          this.renderer.compile(scene, camera);
        } catch (err) {
          this.warn(`building-shadow material compile failed (${mat?.uuid})`, err);
        }
      }
    } finally {
      mesh.material = prev ?? null;
    }
  }

  /**
   * Ensure the opaque final-FB blit material exists and compile it. Normally
   * this material is only created on demand inside {@link _ensureFbBlitResources};
   * forcing creation here means the effect-chain path can run without any
   * first-use compile surprise the moment a user toggles bloom on.
   *
   * @private
   */
  _warmupCompileFinalBlit() {
    if (!this.renderer) return;
    try {
      this._ensureFbBlitResources();
    } catch (err) {
      this.warn("final-blit resource allocation failed during warmup", err);
      return;
    }
    const quad = this._fbBlitQuad;
    if (!quad?.scene || !quad?.camera) return;
    try {
      this.renderer.compile(quad.scene, quad.camera);
    } catch (err) {
      this.warn("final-blit compile warmup failed", err);
    }
  }

  /**
   * Compile the programs used by a single V3 screen-effect. Duck-typed
   * against the chain's effect contract so custom user effects can also be
   * prewarmed if they expose a `_quad` / `_initialize` pair. Bloom composes
   * multiple internal programs and reports its own warmup status via
   * `V3BloomEffect._initialize`; we call it but do not attempt to precompile
   * every internal `UnrealBloomPass` kernel here — the first bloom frame
   * after enabling still pays a modest one-off cost.
   *
   * @param {any} effect
   * @private
   */
  _warmupCompileEffect(effect) {
    if (!this.renderer || !effect) return;
    try {
      if (typeof effect._initialize === "function") {
        const arity = effect._initialize.length;
        if (arity >= 2) {
          const bufW = Math.max(1, this._drawingBufferSizeVec.x || 1);
          const bufH = Math.max(1, this._drawingBufferSizeVec.y || 1);
          effect._initialize(bufW, bufH);
        } else {
          effect._initialize();
        }
      }
    } catch (err) {
      this.warn(`effect "${effect?.id}" _initialize failed during warmup`, err);
    }
    const quad = effect._quad;
    if (quad?.scene && quad?.camera) {
      try {
        this.renderer.compile(quad.scene, quad.camera);
      } catch (err) {
        this.warn(`effect "${effect?.id}" compile warmup failed`, err);
      }
    }
  }

  _installResize() {
    this._removeResize();
    this._onResize = () => this._resizeToBoard();
    window.addEventListener("resize", this._onResize);
    try {
      const v = this.canvas?.app?.view;
      if (v && typeof ResizeObserver !== "undefined") {
        this._boardResizeObserver = new ResizeObserver(() => {
          if (this._boardResizeRaf != null) {
            try {
              cancelAnimationFrame(this._boardResizeRaf);
            } catch (_) {}
          }
          this._boardResizeRaf = requestAnimationFrame(() => {
            this._boardResizeRaf = null;
            this._resizeToBoard();
          });
        });
        this._boardResizeObserver.observe(v);
      }
    } catch (_) {}
  }

  _removeResize() {
    if (this._boardResizeRaf != null) {
      try {
        cancelAnimationFrame(this._boardResizeRaf);
      } catch (_) {}
      this._boardResizeRaf = null;
    }
    if (this._boardResizeObserver) {
      try {
        this._boardResizeObserver.disconnect();
      } catch (_) {}
      this._boardResizeObserver = null;
    }
    if (this._onResize) {
      try { window.removeEventListener("resize", this._onResize); } catch (_) {}
    }
    this._onResize = null;
  }

  _boardPixelSize() {
    return getV3BoardPixelSize(this.canvas, this.renderer);
  }

  _resizeToBoard() {
    if (!this.renderer || !this.compositor) return;
    const pixiView = this.canvas?.app?.view ?? null;
    const { w, h } = this._boardPixelSize();
    // `getBoundingClientRect` / layout can flip ±1 CSS px between frames; repeated
    // `setSize` + albedo RT resize is a common flicker / long-session degradation path.
    // Hysteresis: skip `setSize` **and** the CSS mutation below. Rewriting Three's
    // `left/top/width/height` on every ResizeObserver tick invalidates the browser
    // compositor layer and causes visible seam shimmer during sidebar animations.
    if (
      this._resizeStableW != null &&
      this._resizeStableH != null &&
      Math.abs(w - this._resizeStableW) <= 1 &&
      Math.abs(h - this._resizeStableH) <= 1
    ) {
      return;
    }
    syncV3WebglDomElementToPixiView(pixiView, this.renderer.domElement);
    this._resizeStableW = w;
    this._resizeStableH = h;
    this.renderer.setSize(w, h, false);
    syncV3RendererPixelRatioToPixi(this.canvas, this.renderer);
    this.compositor.setOutputSize(w, h);
    this._levelTexDebug.textureDebug?.setOutputSize(w, h);
    this._waterOverlay?.setOutputSize(w, h);
    // Intermediate RT matches the drawing buffer (renderer handles DPR).
    this.renderer.getDrawingBufferSize(this._drawingBufferSizeVec);
    this._ensureAlbedoRT(this._drawingBufferSizeVec.x, this._drawingBufferSizeVec.y);
  }

  /** Push Foundry stage pan/zoom into the sandwich shader (call every frame). */
  _syncViewportUniforms() {
    const cv = this.canvas;
    const comp = this.compositor;
    if (!cv?.stage || !comp) return;
    if (!buildV3ViewUniformPayloadInto(cv, this._viewUniformPayload)) return;
    const payload = this._viewUniformPayload;
    comp.setViewUniforms(payload);
    this._levelTexDebug.textureDebug?.setViewUniforms(payload);
    this._waterOverlay?.setViewUniforms(payload);
    const flipBg = comp.uniforms?.flipBackgroundTextureY;
    if (
      this._levelTexDebug.textureDebug &&
      typeof flipBg === "boolean"
    ) {
      this._levelTexDebug.textureDebug.setDisplayOptions({ flipBackgroundTextureY: flipBg });
    }
    if (this._waterOverlay && typeof flipBg === "boolean") {
      this._waterOverlay.setDisplayOptions({ flipBackgroundTextureY: flipBg });
    }
    this._syncFloorStackUniforms();
    this._syncClipColor();
    this._updateIlluminationFrameContext();
    this._syncWaterFoundryDarknessUniforms();
  }

  /**
   * Water overlay: same Foundry environment darkness as {@link V3IlluminationPipeline}
   * (`mix(lit, lit * tint, darkness)` on linear RGB — here `lit` is the water tint).
   * @private
   */
  _syncWaterFoundryDarknessUniforms() {
    const w = this._waterOverlay;
    const ctx = this.illumination?.frameContext;
    if (!w?.setFoundryEnvironmentDarkness || !ctx) return;
    const d = Number(ctx.sceneDarkness01);
    const t = ctx.darknessTintLinear;
    if (!Array.isArray(t) || t.length < 3) return;
    w.setFoundryEnvironmentDarkness(
      Number.isFinite(d) ? Math.max(0, Math.min(1, d)) : 0,
      [Number(t[0]) || 0, Number(t[1]) || 0, Number(t[2]) || 0],
    );
  }

  /**
   * Foundry radial lights: **AmbientLight** placeables (`canvas.lighting`) and
   * **Token** light sources (`canvas.tokens` with `emitsLight`), both using the
   * same `brightRadius` / `dimRadius` semantics as Foundry’s PIXI sources.
   *
   * Returns lights grouped by floor index (the texture-driven
   * {@link V3FloorLightBufferPass} renders a buffer per floor). A light that
   * Levels assigns to multiple floors is emitted once per floor so the
   * cascade accumulates it against each floor's occluders.
   *
   * @returns {{
   *   byFloor: Map<number, Array<{ wx: number, wy: number, inner: number, outer: number, color: [number, number, number], hasColor: boolean, colorationAlpha: number, attenuation: number, coloration: number, luminosity: number, contrast: number, saturation: number, shadows: number, angleDeg: number, rotationDeg: number, priority: number, polygon?: number[] }>>,
   *   trace: Array<{ id: string, kind: string, affectsViewed: boolean, affectsAnyFloor: boolean, floors: number[], bucket: string, levels: string[], reason?: string }>,
   *   viewedIdx: number,
   *   adjacentIdx: number,
   *   totalFloors: number,
   *   totalLights: number,
   * }}
   * @private
   */
  _collectFoundryRadialIlluminationLights() {
    /** @type {{ byFloor: Map<number, any[]>, trace: any[], viewedIdx: number, adjacentIdx: number, totalFloors: number, totalLights: number }} */
    const empty = {
      byFloor: new Map(),
      trace: [],
      viewedIdx: 0,
      adjacentIdx: -1,
      totalFloors: 0,
      totalLights: 0,
    };
    const canvas = this.canvas;
    const scene = canvas?.scene;
    if (!scene) return empty;
    const sceneDark01 = readFoundrySceneDarkness01(canvas);
    const dpp = Math.max(1e-6, Number(canvas.dimensions?.distancePixels) || 100);
    /** @type {any} */
    const coll = scene.lights ?? scene.ambientLights;

    /**
     * Ambient sources: {@link canvas.lighting} placeables first (accurate radii),
     * then merge embedded `scene.lights` documents **not** already seen.
     * On stacked levels Foundry often omits other-floor lights from
     * `lighting.placeables` while they remain in the scene collection — without
     * this union, lower-floor lights never reach `throughFloor`.
     */
    /** @type {any[]} */
    const docs = [];
    /** @type {Set<string>} */
    const seenAmbientIds = new Set();
    /** @param {string|null|undefined} key @param {any} raw */
    const pushAmbient = (key, raw) => {
      if (!raw) return;
      if (key) {
        const k = String(key);
        if (seenAmbientIds.has(k)) return;
        seenAmbientIds.add(k);
      }
      docs.push(raw);
    };
    try {
      const lighting = canvas?.lighting;
      const placeables = lighting?.placeables;
      if (placeables && placeables.length > 0) {
        for (const p of placeables) {
          const id = p?.document?.id ?? p?.id;
          pushAmbient(id != null ? `a:${id}` : null, p);
        }
      }
      if (coll) {
        if (typeof coll.forEach === "function") {
          coll.forEach((/** @type {any} */ d) => {
            const id = d?.id ?? d?._id;
            pushAmbient(id != null ? `a:${id}` : null, d);
          });
        } else {
          for (const d of coll) {
            const id = d?.id ?? d?._id;
            pushAmbient(id != null ? `a:${id}` : null, d);
          }
        }
      }
      const tokLayer = canvas?.tokens;
      const tokPl = tokLayer?.placeables;
      if (tokPl && tokPl.length > 0) {
        for (const t of tokPl) {
          try {
            if (v3TokenLikeEmitsLight(t)) {
              const id = t?.document?.id ?? t?.id;
              pushAmbient(id != null ? `t:${id}` : null, t);
            }
          } catch (_) {}
        }
      }
      const tokDocs = scene?.tokens;
      if (tokDocs) {
        if (typeof tokDocs.forEach === "function") {
          tokDocs.forEach((/** @type {any} */ d) => {
            const id = d?.id ?? d?._id;
            if (v3TokenLikeEmitsLight(d)) pushAmbient(id != null ? `t:${id}` : null, d);
          });
        } else {
          for (const d of tokDocs) {
            const id = d?.id ?? d?._id;
            if (v3TokenLikeEmitsLight(d)) pushAmbient(id != null ? `t:${id}` : null, d);
          }
        }
      }
    } catch (_) {}

    const tc = this.srcs?.totalCount ?? 0;
    const totalFloors = Math.max(1, tc);
    const viewedIdx = tc < 2 ? 0 : getViewedLevelIndex(scene);
    const adjacentIdx = tc < 2
      ? -1
      : (viewedIdx > 0 ? viewedIdx - 1 : (viewedIdx + 1 < tc ? viewedIdx + 1 : -1));

    /** @type {Map<number, any[]>} */
    const byFloor = new Map();
    /**
     * Per-doc routing trace for the cascade diagnostic. One row per evaluated
     * doc; never written to the shader. Kept bounded so very dense scenes
     * don't bloat the log.
     * @type {Array<{ id: string, kind: string, affectsViewed: boolean, affectsAnyFloor: boolean, floors: number[], bucket: string, levels: string[], reason?: string }>}
     */
    const trace = [];
    let totalLights = 0;

    const traceDocId = (/** @type {any} */ d) =>
      String(d?.id ?? d?._id ?? d?.document?.id ?? d?.document?._id ?? "?");
    const traceLevelsOf = (/** @type {any} */ d) => {
      try {
        const src = d?.levels ?? d?.document?.levels ?? d?.flags?.levels?.levels;
        if (!src) return [];
        if (Array.isArray(src)) return src.map(String);
        if (typeof src.forEach === "function") {
          const out = [];
          src.forEach((/** @type {any} */ x) => out.push(String(x)));
          return out;
        }
        return [String(src)];
      } catch (_) { return []; }
    };

    for (const raw of docs) {
      if (!raw) continue;
      /** @type {any} AmbientLight placeable or AmbientLightDocument */
      const doc = raw;
      const lightDoc = doc.document ?? doc;
      const hidden = lightDoc.hidden === true || doc.hidden === true;
      if (hidden) {
        trace.push({ id: traceDocId(lightDoc), kind: String(lightDoc.documentName ?? "?"), affectsViewed: false, affectsAdjacent: false, bucket: "skip", levels: traceLevelsOf(lightDoc), reason: "hidden" });
        continue;
      }
      if (doc.disabled === true) {
        trace.push({ id: traceDocId(lightDoc), kind: String(lightDoc.documentName ?? "?"), affectsViewed: false, affectsAdjacent: false, bucket: "skip", levels: traceLevelsOf(lightDoc), reason: "disabled" });
        continue;
      }
      /** @type {any} Resolve placeable for radii/center (documents lack brightRadius/dimRadius). */
      const pl =
        typeof doc?.brightRadius === "number" && typeof doc?.dimRadius === "number"
          ? doc
          : canvas.lighting?.get?.(lightDoc.id) ?? canvas.tokens?.get?.(lightDoc.id);
      const geo = pl ?? doc;
      if (typeof geo.emitsLight === "boolean" && geo.emitsLight === false) {
        trace.push({ id: traceDocId(lightDoc), kind: String(lightDoc.documentName ?? "?"), affectsViewed: false, affectsAdjacent: false, bucket: "skip", levels: traceLevelsOf(lightDoc), reason: "emitsLight=false" });
        continue;
      }

      const isTokenRadial = String(lightDoc.documentName ?? "") === "Token";
      const affectsLevel = isTokenRadial
        ? v3TokenLightAffectsLevel
        : v3AmbientLightAffectsLevel;
      /** @type {number[]} */
      const matchedFloors = [];
      for (let fi = 0; fi < totalFloors; fi++) {
        if (affectsLevel(lightDoc, scene, fi)) matchedFloors.push(fi);
      }
      const affectsViewed = matchedFloors.includes(viewedIdx);
      if (matchedFloors.length === 0) {
        trace.push({
          id: traceDocId(lightDoc),
          kind: String(lightDoc.documentName ?? "?"),
          affectsViewed: false,
          affectsAnyFloor: false,
          floors: [],
          bucket: "skip",
          levels: traceLevelsOf(lightDoc),
          reason: "no floor match",
        });
        continue;
      }

      const cfg =
        lightDoc.light && typeof lightDoc.light === "object"
          ? lightDoc.light
          : lightDoc.config && typeof lightDoc.config === "object"
            ? lightDoc.config
            : doc.config && typeof doc.config === "object"
              ? doc.config
              : {};
      const tokenLight = isTokenRadial ? v3ReadTokenLightFields(lightDoc) : null;
      if (cfg.negative === true) continue;
      const extractShapePolygon = (/** @type {any} */ srcLike) => {
        try {
          const shape =
            srcLike?.source?.shape
            ?? srcLike?.lightSource?.shape
            ?? null;
          // Full circles are already represented analytically by the radial falloff path.
          // Using a truncated polygon for those introduces visible faceting, so only
          // return polygon gates for non-complete shapes (walls/cones/occluded lights).
          if (shape && typeof shape.isCompleteCircle === "function") {
            try {
              if (shape.isCompleteCircle()) return [];
            } catch (_) {}
          }
          const pts =
            shape?.points
            ?? null;
          if (!Array.isArray(pts) || pts.length < 6) return [];
          /** @type {number[]} */
          const out = [];
          for (let pi = 0; pi + 1 < pts.length; pi += 2) {
            const x = Number(pts[pi]);
            const y = Number(pts[pi + 1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            out.push(x, y);
          }
          // Drop duplicated closing vertex if present.
          if (
            out.length >= 8
            && Math.abs(out[0] - out[out.length - 2]) < 1e-6
            && Math.abs(out[1] - out[out.length - 1]) < 1e-6
          ) {
            out.length -= 2;
          }
          if (out.length < 6) return [];
          const vCount = Math.floor(out.length / 2);
          if (vCount <= V3_LIGHT_POLY_VERTEX_CAP) return out;
          // Keep high-corner vertices first (wall interactions usually create hard turns),
          // then fill remaining slots with uniform coverage around the loop.
          const score = (idx) => {
            const prev = (idx + vCount - 1) % vCount;
            const next = (idx + 1) % vCount;
            const ax = out[idx * 2] - out[prev * 2];
            const ay = out[idx * 2 + 1] - out[prev * 2 + 1];
            const bx = out[next * 2] - out[idx * 2];
            const by = out[next * 2 + 1] - out[idx * 2 + 1];
            const la = Math.hypot(ax, ay);
            const lb = Math.hypot(bx, by);
            if (la < 1e-6 || lb < 1e-6) return 0;
            const dax = ax / la;
            const day = ay / la;
            const dbx = bx / lb;
            const dby = by / lb;
            const dot = Math.max(-1, Math.min(1, dax * dbx + day * dby));
            const cornerness = 1 - dot; // 0 at straight line, 2 at 180-degree turn.
            return cornerness * Math.min(la, lb);
          };
          const ranked = Array.from({ length: vCount }, (_, i) => i)
            .map((i) => ({ i, s: score(i) }))
            .sort((a, b) => b.s - a.s);
          const keep = new Set();
          const cornerBudget = Math.max(4, Math.floor(V3_LIGHT_POLY_VERTEX_CAP * 0.5));
          for (let i = 0; i < ranked.length && keep.size < cornerBudget; i++) {
            keep.add(ranked[i].i);
          }
          for (let i = 0; i < V3_LIGHT_POLY_VERTEX_CAP && keep.size < V3_LIGHT_POLY_VERTEX_CAP; i++) {
            const idx = Math.floor((i * vCount) / V3_LIGHT_POLY_VERTEX_CAP);
            keep.add(Math.max(0, Math.min(vCount - 1, idx)));
          }
          const indices = Array.from(keep).sort((a, b) => a - b).slice(0, V3_LIGHT_POLY_VERTEX_CAP);
          /** @type {number[]} */
          const sampled = [];
          for (const idx of indices) {
            sampled.push(out[idx * 2], out[idx * 2 + 1]);
          }
          return sampled.length >= 6 ? sampled : [];
        } catch (_) {
          return [];
        }
      };

      const rawDmin = Number(cfg.darkness?.min);
      const rawDmax = Number(cfg.darkness?.max);
      const dmin = Number.isFinite(rawDmin) ? clamp01(rawDmin) : 0;
      const dmax = Number.isFinite(rawDmax) ? clamp01(rawDmax) : 1;
      const dLo = Math.min(dmin, dmax);
      const dHi = Math.max(dmin, dmax);
      if (sceneDark01 < dLo - 1e-6 || sceneDark01 > dHi + 1e-6) continue;

      const lumRaw = Number(tokenLight?.luminosity ?? cfg.luminosity ?? doc.luminosity ?? 0.5);
      if (lumRaw < 0) continue;

      const angleDegRaw = Number(tokenLight?.angle ?? cfg.angle);
      const angleDeg = Number.isFinite(angleDegRaw) ? angleDegRaw : 360;
      if (angleDeg <= 0) continue;

      const cRaw = Number(tokenLight?.contrast ?? cfg.contrast);
      const contrastShader = Number.isFinite(cRaw)
        ? (cRaw < 0 ? cRaw * 0.5 : cRaw)
        : 0;
      const satRaw = Number(tokenLight?.saturation ?? cfg.saturation);
      const saturation = Number.isFinite(satRaw) ? Math.max(-1, Math.min(1, satRaw)) : 0;
      const shRaw = Number(tokenLight?.shadows ?? cfg.shadows);
      const shadows = Number.isFinite(shRaw) ? Math.max(0, Math.min(1, shRaw)) : 0;
      const priority = Math.round(
        Number.isFinite(Number(cfg.priority)) ? Number(cfg.priority) : 0,
      );
      const rotDeg = Number(geo.rotation ?? lightDoc.rotation ?? cfg.rotation ?? 0);

      let innerPx = 0;
      let outerPx = 0;
      // Foundry v14 placeables expose radii already in canvas pixels (API: brightRadius, dimRadius).
      if (
        typeof geo.brightRadius === "number"
        && typeof geo.dimRadius === "number"
        && Number.isFinite(geo.dimRadius)
        && geo.dimRadius > 0
      ) {
        outerPx = Math.max(0.5, geo.dimRadius);
        innerPx = Math.max(0, Math.min(geo.brightRadius, outerPx - 1e-3));
      } else {
        const dimDist = Number(tokenLight?.dim ?? cfg.dim) || 0;
        if (dimDist <= 0) continue;
        const brightNum = Number(tokenLight?.bright ?? cfg.bright);
        const brightDistRaw = Number.isFinite(brightNum) ? brightNum : dimDist * 0.5;
        const dimU = Math.max(dimDist, brightDistRaw);
        const brightU = Math.min(dimDist, brightDistRaw);
        outerPx = Math.max(0.5, dimU * dpp);
        innerPx = Math.max(0, Math.min(brightU * dpp, outerPx - 1e-3));
      }

      const tokenCenter = isTokenRadial && !pl ? v3TokenDocCenterWorld(canvas, lightDoc) : null;
      const wx =
        Number(
          geo.center && typeof geo.center.x === "number"
            ? geo.center.x
            : tokenCenter
              ? tokenCenter[0]
              : geo.x ?? lightDoc.x,
        ) || 0;
      const wy =
        Number(
          geo.center && typeof geo.center.y === "number"
            ? geo.center.y
            : tokenCenter
              ? tokenCenter[1]
              : geo.y ?? lightDoc.y,
        ) || 0;
      const coloration = Number(tokenLight?.coloration ?? cfg.coloration ?? doc.coloration ?? 1);
      const alphaDoc = Number(tokenLight?.alpha ?? cfg.alpha ?? doc.alpha ?? 0.5);
      const colorationAlpha = v3FoundryColorationAlphaForTechnique(coloration, alphaDoc);
      const color = /** @type {[number, number, number]} */ ([0, 0, 0]);
      const hasColor = v3FoundryLightTintToLinearRgbInto(
        tokenLight?.color ?? cfg.color ?? doc.tint ?? doc.color,
        color,
      );
      const attRaw = Number(tokenLight?.attenuation ?? cfg.attenuation ?? doc.attenuation);
      const attenuation = v3FoundryShaderAttenuationFromData(
        Number.isFinite(attRaw) ? attRaw : 0.5,
      );
      const luminosity = Math.max(0, Math.min(1, lumRaw));
      const polygon = extractShapePolygon(geo);
      const entry = {
        wx,
        wy,
        inner: innerPx,
        outer: outerPx,
        color,
        hasColor,
        colorationAlpha,
        attenuation,
        coloration,
        luminosity,
        contrast: contrastShader,
        saturation,
        shadows,
        angleDeg,
        rotationDeg: Number.isFinite(rotDeg) ? rotDeg : 0,
        priority,
        polygon,
      };
      const bucketName = matchedFloors.includes(viewedIdx)
        ? (matchedFloors.length > 1 ? "primary+through" : "primary")
        : "through";
      trace.push({
        id: traceDocId(lightDoc),
        kind: String(lightDoc.documentName ?? "?"),
        affectsViewed,
        affectsAnyFloor: true,
        floors: matchedFloors.slice(),
        bucket: bucketName,
        levels: traceLevelsOf(lightDoc),
        polygonVertices: Math.floor((polygon?.length ?? 0) / 2),
      });
      for (const fi of matchedFloors) {
        let bucket = byFloor.get(fi);
        if (!bucket) { bucket = []; byFloor.set(fi, bucket); }
        bucket.push(entry);
        totalLights++;
      }
    }
    const sortKey = (/** @type {{ priority?: number, colorationAlpha: number, outer: number }} */ a) =>
      (Number(a.priority) || 0) * 1e9 + a.colorationAlpha * a.outer;
    for (const bucket of byFloor.values()) bucket.sort((a, b) => sortKey(b) - sortKey(a));
    return {
      byFloor,
      trace,
      viewedIdx,
      adjacentIdx,
      totalFloors,
      totalLights,
    };
  }

  /**
   * Cheap fingerprint for {@link V3FloorLightBufferPass#run} — when unchanged, the
   * previous light textures are reused (same GPU memory, no fill-rate cost).
   *
   * @param {any} radial result of {@link V3ThreeSceneHost#_collectFoundryRadialIlluminationLights}
   * @param {number} viewedIdx
   * @param {[number, number, number, number]} sceneRect
   * @param {import("./V3FloorLightBufferPass.js").V3FloorLightSpec[]} floorSpecs
   * @returns {number}
   * @private
   */
  _hashFloorLightInputs(radial, viewedIdx, sceneRect, floorSpecs) {
    const esc = (/** @type {any} */ t) => {
      if (!t) return "0";
      const v = t.version ?? 0;
      const id = t.uuid ?? "";
      const iw = t.image?.width ?? 0;
      const ih = t.image?.height ?? 0;
      return `${id}:${v}:${iw}x${ih}`;
    };
    const specs = [...floorSpecs].sort((a, b) => (a.floorIndex | 0) - (b.floorIndex | 0));
    const chunks = [
      viewedIdx,
      radial.totalLights,
      `${Math.round(Number(sceneRect[2]) || 0)}x${Math.round(Number(sceneRect[3]) || 0)}`,
    ];
    for (const f of specs) {
      chunks.push(`fi${f.floorIndex | 0}|L${f.lights?.length ?? 0}|o${f.occluderTexArray?.length ?? 0}`);
      chunks.push(`s${esc(f.surfaceTex)}`);
      for (const t of f.occluderTexArray ?? []) chunks.push(`oc${esc(t)}`);
      const lights = Array.isArray(f.lights) ? [...f.lights] : [];
      lights.sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
      for (const L of lights) {
        chunks.push([
          Math.round(Number(L.wx) || 0),
          Math.round(Number(L.wy) || 0),
          Number(L.inner) || 0,
          Number(L.outer) || 0,
        ].join(","));
      }
    }
    const txt = chunks.join("|");
    let h = 2166136261 >>> 0;
    for (let i = 0; i < txt.length; i++) {
      h ^= txt.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /**
   * Build the read-only frame context every tick and hand it to
   * {@link V3IlluminationPipeline}. All illumination terms consume the same
   * view transform, Foundry darkness, and viewed-floor mask lookups from
   * here so they agree on what "this frame" means.
   * @private
   */
  _updateIlluminationFrameContext() {
    const pipe = this.illumination;
    const comp = this.compositor;
    if (!pipe || !comp) return;

    const scene = this.canvas?.scene;
    const fromScene = readFoundrySceneDarkness01(this.canvas);
    const sl = this.skyLighting;
    const usingScene = sl?.useSceneDarkness !== false;
    const d01 = usingScene
      ? fromScene
      : clamp01(Number(sl?.manualDarkness01) || 0);

    const tc = this.srcs?.totalCount ?? 0;
    const viewed = tc < 2 ? 0 : getViewedLevelIndex(scene);
    const floorKey = floorKeyForIndex(viewed);

    let skyTex = null;
    try {
      skyTex = this.maskHub?.peekFloorMask?.(floorKey, "skyReach")?.texture ?? null;
    } catch (_) {}

    const shadowTex = this._runBuildingShadowsPass(viewed, tc);

    const u = comp.material?.uniforms;
    pipe.updateFrameContext((ctx) => {
      ctx.sceneDarkness01 = d01;
      readFoundryDarknessTintLinearRgbInto(this.canvas, ctx.darknessTintLinear);
      ctx.usingSceneDarkness = usingScene;
      ctx.floorKey = floorKey;
      const res = comp.uniforms?.uResolutionPx ?? [1, 1];
      ctx.resolutionPx = [res[0], res[1]];
      if (u?.uPivotWorld?.value) {
        ctx.pivotWorld = [u.uPivotWorld.value.x, u.uPivotWorld.value.y];
      }
      if (typeof u?.uInvScale?.value === "number") {
        ctx.invScale = u.uInvScale.value;
      }
      if (u?.uSceneRect?.value) {
        const r = u.uSceneRect.value;
        ctx.sceneRect = [r.x, r.y, r.z, r.w];
      }
      if (typeof u?.uFlipBackgroundY?.value === "number") {
        ctx.flipBackgroundTextureY = u.uFlipBackgroundY.value > 0.5;
      }
      ctx.setMask("skyReach", skyTex);
      ctx.setMask("buildingShadows", shadowTex);
      const la = this.lightAppearance ?? {};
      const readNum = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
      };
      ctx.foundryLightAddScale = readNum(la.addScale, 0.5);
      ctx.foundryLightDimRadiusStrength = readNum(la.dimRadiusStrength, 0.7);
      ctx.foundryLightBrightRadiusStrength = readNum(la.brightRadiusStrength, 4.0);
      ctx.foundryLightIlluminationStrength = readNum(la.illuminationStrength, 0.25);
      ctx.foundryLightColorationStrength = readNum(la.colorationStrength, 1.0);
      ctx.foundryLightColorationReflectivity = Math.max(
        0,
        Math.min(1, readNum(la.colorationReflectivity, 1.0)),
      );
      ctx.foundryLightColorationSaturation = readNum(la.colorationSaturation, 1.0);
      ctx.foundryLightGroundSaturation = readNum(la.groundSaturation, 0);
      ctx.foundryLightGroundContrast = readNum(la.groundContrast, -0.2);
      const scg = this.sceneColorGrade ?? {};
      ctx.sceneColorGradeEnabled = scg.enabled !== false;
      ctx.sceneGradeExposure = readNum(scg.exposure, 1.0);
      ctx.sceneGradeTemperature = readNum(scg.temperature, 0.0);
      ctx.sceneGradeTint = readNum(scg.tint, 0.0);
      ctx.sceneGradeBrightness = readNum(scg.brightness, 0.0);
      ctx.sceneGradeContrast = readNum(scg.contrast, 0.995);
      ctx.sceneGradeSaturation = readNum(scg.saturation, 1.4);
      ctx.sceneGradeVibrance = readNum(scg.vibrance, 0.0);
      const lift = Array.isArray(scg.liftColor) ? scg.liftColor : [0, 0, 0];
      const gamma = Array.isArray(scg.gammaColor) ? scg.gammaColor : [1, 1, 1];
      const gain = Array.isArray(scg.gainColor) ? scg.gainColor : [1, 1, 1];
      ctx.sceneGradeLift = [
        readNum(lift[0], 0),
        readNum(lift[1], 0),
        readNum(lift[2], 0),
      ];
      ctx.sceneGradeGamma = [
        readNum(gamma[0], 1),
        readNum(gamma[1], 1),
        readNum(gamma[2], 1),
      ];
      ctx.sceneGradeGain = [
        readNum(gain[0], 1),
        readNum(gain[1], 1),
        readNum(gain[2], 1),
      ];
      ctx.sceneGradeMasterGamma = readNum(scg.masterGamma, 1.05);
      ctx.sceneGradeToneMapping = Math.max(0, Math.min(2, Math.round(readNum(scg.toneMapping, 0))));
      const tcg = this.tokenColorGrade ?? {};
      ctx.tokenColorGradeEnabled = tcg.enabled !== false;
      ctx.tokenGradeExposure = readNum(tcg.exposure, 0.9);
      ctx.tokenGradeTemperature = readNum(tcg.temperature, 0.0);
      ctx.tokenGradeTint = readNum(tcg.tint, 0.0);
      ctx.tokenGradeBrightness = readNum(tcg.brightness, 0.0);
      ctx.tokenGradeContrast = readNum(tcg.contrast, 1.0);
      ctx.tokenGradeSaturation = readNum(tcg.saturation, 1.25);
      ctx.tokenGradeVibrance = readNum(tcg.vibrance, 0.0);
      ctx.tokenGradeAmount = readNum(tcg.amount, 1.0);

      const radial = this._collectFoundryRadialIlluminationLights();
      const viewedBucket = radial.byFloor.get(radial.viewedIdx) ?? [];
      const throughBucket = [];
      for (const [fi, bucket] of radial.byFloor.entries()) {
        if (fi === radial.viewedIdx) continue;
        for (const L of bucket) throughBucket.push(L);
      }
      // Keep the legacy context mirrors populated for backcompat diag, but
      // they no longer feed the shader — the per-floor texture cascade does.
      ctx.foundryRadialLights.length = 0;
      for (const L of viewedBucket) ctx.foundryRadialLights.push(L);
      ctx.foundryRadialLightsAdjacentFloor.length = 0;
      for (const L of throughBucket) ctx.foundryRadialLightsAdjacentFloor.push(L);

      // Defensive re-read: compute viewed/adjacent indices locally instead of trusting an
      // older copy so this is the single authoritative `hasAdjacentFloor` gate per frame.
      const tc2 = this.srcs?.totalCount ?? 0;
      const viewed2 = tc2 < 2 ? 0 : getViewedLevelIndex(scene);
      const adjacent2 = tc2 < 2
        ? -1
        : (viewed2 > 0 ? viewed2 - 1 : (viewed2 + 1 < tc2 ? viewed2 + 1 : -1));
      const hasAdjacentFloor = tc2 >= 2 && adjacent2 >= 0;
      const upperTex = this.compositor?.upperTex ?? null;

      // Mirror onto the frame context so `V3Shine.diag().illumination.frameContext`
      // exposes the cascade routing (viewed/adjacent indices, matte apply flag,
      // and whether the upper albedo texture was available) without callers
      // needing to poke at private pipeline uniforms.
      ctx.viewedFloorIndex = viewed2;
      ctx.adjacentFloorIndex = adjacent2;
      ctx.adjacentFloorMatteApply = hasAdjacentFloor ? 1 : 0;
      ctx.adjacentFloorHasUpperTexture = !!upperTex;

      // Render per-floor light buffers and downward cascade. Floor specs
      // include occluder arrays (albedo + foreground + tiles combined via
      // MAX into a single alpha) so upper-floor lights are clipped by every
      // intervening floor's hole map. The pass is skipped when there are no
      // lights to render; the illumination pipeline will then fall back to
      // its 1×1 zero texture via `hasLightBuffers = false`.
      const floorSpecs = this._buildFloorLightSpecs(radial, viewed2, tc2);
      let lightPassResult = null;
      if (radial.totalLights > 0 && floorSpecs.length > 0) {
        const sig = this._hashFloorLightInputs(radial, viewed2, ctx.sceneRect, floorSpecs);
        const reuse = sig === this._floorLightPassSig && this._floorLightPassCache != null;
        if (reuse) {
          lightPassResult = this._floorLightPassCache;
        } else {
          try {
            lightPassResult = this.floorLightBufferPass.run({
              floors: floorSpecs,
              viewedIndex: viewed2,
              sceneRect: ctx.sceneRect,
              flipBackgroundTextureY: ctx.flipBackgroundTextureY,
              appearance: {
                dimRadiusStrength: ctx.foundryLightDimRadiusStrength,
                brightRadiusStrength: ctx.foundryLightBrightRadiusStrength,
              },
              frame: this._frameCount,
            });
            if (lightPassResult) {
              this._floorLightPassSig = sig;
              this._floorLightPassCache = lightPassResult;
            } else {
              this._floorLightPassSig = null;
              this._floorLightPassCache = null;
            }
          } catch (err) {
            this.warn("floorLightBufferPass.run failed", err);
            this._floorLightPassSig = null;
            this._floorLightPassCache = null;
          }
        }
      } else {
        this._floorLightPassSig = null;
        this._floorLightPassCache = null;
      }
      if (lightPassResult) {
        this.illumination.setLightBufferTextures({
          localLightTex: lightPassResult.localLightTex,
          localColorTex: lightPassResult.localColorTex,
          throughLightTex: lightPassResult.throughLightTex,
          throughColorTex: lightPassResult.throughColorTex,
          bufferRange: lightPassResult.bufferRange,
          hasLightBuffers: true,
        });
      } else {
        this.illumination.setLightBufferTextures({
          localLightTex: null,
          localColorTex: null,
          throughLightTex: null,
          throughColorTex: null,
          hasLightBuffers: false,
        });
      }

      // One-shot diagnostic per viewed-floor change. Reports every floor's
      // light count, the number of floors cascaded this frame, and whether
      // the light buffer pass succeeded. If an upper-floor light does not
      // appear here it never entered the collection — check `scene.lights`
      // iteration, Levels id authorship, or `lightDoc.documentName`.
      if (this._lastIlluminationCascadeDiagFloor !== viewed2) {
        this._lastIlluminationCascadeDiagFloor = viewed2;
        try {
          /** @type {Record<string, number>} */
          const perFloorCounts = {};
          for (const [fi, bucket] of radial.byFloor.entries()) {
            perFloorCounts[`floor${fi}`] = bucket.length;
          }
          this.log("illumination cascade diag", {
            viewedIdx: viewed2,
            adjacentIdx: adjacent2,
            totalCount: tc2,
            totalLights: radial.totalLights,
            perFloorLightCounts: perFloorCounts,
            hasUpperTex: !!upperTex,
            lightPassRan: !!lightPassResult,
            lightPassDiag: lightPassResult?.diag ?? null,
            routing: radial.trace ?? [],
          });
        } catch (_) {}
      }
    });
  }

  /**
   * Build per-floor specs for {@link V3FloorLightBufferPass#run}. Every
   * floor above the viewed one that either has lights or has occluder
   * textures is included so the cascade can attenuate upper contributions
   * through the full intervening stack (a floor with no lights but with
   * solid albedo still blocks light from floors above it).
   *
   * @param {{ byFloor: Map<number, any[]>, totalFloors: number }} radial
   * @param {number} viewedIndex
   * @param {number} totalFloors
   * @returns {Array<{ floorIndex: number, lights: any[], occluderTexArray: import("../vendor/three.module.js").Texture[], surfaceTex: import("../vendor/three.module.js").Texture|null }>}
   * @private
   */
  _buildFloorLightSpecs(radial, viewedIndex, totalFloors) {
    const hub = this.maskHub;
    const comp = this.compositor;
    const count = Math.max(1, totalFloors | 0);
    /** @type {Array<{ floorIndex: number, lights: any[], occluderTexArray: any[], surfaceTex: any }>} */
    const specs = [];
    for (let i = 0; i < count; i++) {
      const lights = radial.byFloor.get(i) ?? [];
      const includeForCascade = i > viewedIndex; // floors above viewer contribute to the through cascade
      const isViewed = i === viewedIndex;
      if (!isViewed && !includeForCascade && lights.length === 0) continue;
      // Warm occluder inputs and read them synchronously; mirrors the shadow
      // pass so both cascades see the same alpha field per floor.
      try { void hub?.primeFloorOccluderInputs?.(i); } catch (_) {}
      /** @type {any[]} */
      let occluderTexArray = [];
      try {
        const occluders = hub?.peekFloorOccluderInputs?.(i);
        occluderTexArray = Array.isArray(occluders) ? occluders : [];
      } catch (_) { occluderTexArray = []; }
      let surfaceTex = null;
      if (i === 0) surfaceTex = comp?.lowerTex ?? null;
      else if (i === 1) surfaceTex = comp?.upperTex ?? null;
      if (!surfaceTex && occluderTexArray.length > 0) surfaceTex = occluderTexArray[0];
      specs.push({
        floorIndex: i,
        lights,
        occluderTexArray,
        surfaceTex,
      });
    }
    return specs;
  }

  /**
   * Run {@link V3BuildingShadowsPass} for the current frame. Gathers per-floor
   * `_Outdoors` silhouettes (caster shape) and albedo textures (alpha used for
   * cascade hole gating) from {@link V3MaskHub} for every level in the stack,
   * then invokes the pass with the viewed-floor index so it can cascade upper
   * floors' shadows down through transparent holes onto the viewed floor.
   *
   * Uses `peekFloorMask` (non-blocking) with `authoredOnly: true` so we
   * always read the raw per-floor mask rather than the viewer's stack-matte
   * composite — the cascade itself is responsible for combining floors, and
   * feeding it pre-combined matte would double-count.
   *
   * @param {number} viewedIndex 0-based index of the currently viewed floor.
   * @param {number} totalFloors Result of `this.srcs?.totalCount ?? 0`.
   * @returns {THREE.Texture|null} Scene-UV shadow field (red channel `1 - shadow`)
   *   suitable for `ctx.setMask("buildingShadows", ...)`, or `null` when the
   *   pass was skipped this frame (no renderer, disabled, missing inputs, …).
   * @private
   */
  _runBuildingShadowsPass(viewedIndex, totalFloors) {
    const pass = this.buildingShadowsPass;
    if (!pass) return null;
    const params = this.buildingShadows;
    if (!params || params.enabled === false) return null;
    const hub = this.maskHub;
    if (!hub) return null;

    const count = Math.max(1, totalFloors | 0);
    const floors = [];
    for (let i = 0; i < count; i++) {
      const key = floorKeyForIndex(i);
      let outdoorsTex = null;
      let albedoTex = null;
      let occluderTexArray = [];
      // Fire-and-forget warmup: keeps render tick non-blocking while ensuring
      // deeper floors eventually have blocker textures ready.
      try { void hub.primeFloorOccluderInputs?.(i); } catch (_) {}
      try {
        outdoorsTex = hub.peekFloorMask?.(key, "outdoors", {
          purpose: "surface",
          authoredOnly: true,
        })?.texture ?? null;
      } catch (_) {}
      try {
        albedoTex = hub.peekFloorMask?.(key, "floorAlpha", {
          authoredOnly: true,
        })?.texture ?? null;
      } catch (_) {}
      if (!albedoTex) {
        // Fall back to the compositor's bound level textures (upper/lower)
        // since `floorAlpha` is just the albedo sampled via its `.a` channel.
        if (i === 0) albedoTex = this.compositor?.lowerTex ?? null;
        else if (i === 1) albedoTex = this.compositor?.upperTex ?? null;
      }
      try {
        const occluders = hub.peekFloorOccluderInputs?.(i);
        occluderTexArray = Array.isArray(occluders) ? occluders : [];
      } catch (_) {
        occluderTexArray = [];
      }
      if (!occluderTexArray.length && albedoTex) occluderTexArray = [albedoTex];
      floors.push({ floorIndex: i, outdoorsTex, albedoTex, occluderTexArray });
    }

    try {
      return pass.run({
        params,
        viewedIndex,
        floors,
        frame: this._frameCount,
      });
    } catch (err) {
      this.warn("V3BuildingShadowsPass.run failed", err);
      return null;
    }
  }

  /**
   * Allocate (or resize) the intermediate RT that receives the sandwich
   * albedo output. The illumination composer samples this texture.
   * @private
   */
  _ensureAlbedoRT(w, h) {
    const targetW = Math.max(1, Math.round(w));
    const targetH = Math.max(1, Math.round(h));
    if (this._albedoRT) {
      if (this._albedoRT.width === targetW && this._albedoRT.height === targetH) {
        this._ensureTokenDeckRTs(targetW, targetH);
        return this._albedoRT;
      }
      this._albedoRT.setSize(targetW, targetH);
      this._ensureTokenDeckRTs(targetW, targetH);
      return this._albedoRT;
    }
    this._albedoRT = new THREE.WebGLRenderTarget(targetW, targetH, {
      // Sandwich/water emit sRGB-encoded values; the illumination composer
      // decodes them itself. Tagging the RT as NoColorSpace avoids an extra
      // Three.js-injected conversion on read.
      colorSpace: THREE.NoColorSpace,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    this.illumination.setSourceRenderTarget(this._albedoRT);
    this._ensureTokenDeckRTs(targetW, targetH);
    return this._albedoRT;
  }

  /**
   * @param {number} w
   * @param {number} h
   */
  _ensureTokenDeckRTs(w, h) {
    const targetW = Math.max(1, Math.round(w));
    const targetH = Math.max(1, Math.round(h));
    const opts = {
      colorSpace: THREE.NoColorSpace,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    if (!this._tokenBelowRT) {
      this._tokenBelowRT = new THREE.WebGLRenderTarget(targetW, targetH, opts);
      this._tokenAboveRT = new THREE.WebGLRenderTarget(targetW, targetH, opts);
      return;
    }
    if (this._tokenBelowRT.width === targetW && this._tokenBelowRT.height === targetH) return;
    this._tokenBelowRT.setSize(targetW, targetH);
    this._tokenAboveRT.setSize(targetW, targetH);
  }

  /**
   * Lazily allocate the illumination output RT used when the effect chain is
   * active. Same pixel format as {@link _albedoRT} so sampling conventions
   * match (sRGB-encoded values, tagged `NoColorSpace`).
   *
   * @param {number} w
   * @param {number} h
   * @returns {THREE.WebGLRenderTarget}
   * @private
   */
  _ensureLitRT(w, h) {
    const targetW = Math.max(1, Math.round(w));
    const targetH = Math.max(1, Math.round(h));
    if (this._litRT) {
      if (this._litRT.width !== targetW || this._litRT.height !== targetH) {
        this._litRT.setSize(targetW, targetH);
      }
      return this._litRT;
    }
    this._litRT = new THREE.WebGLRenderTarget(targetW, targetH, {
      colorSpace: THREE.NoColorSpace,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    return this._litRT;
  }

  /**
   * Ensure the opaque final-FB blit resources are built. Idempotent.
   * @private
   */
  _ensureFbBlitResources() {
    if (this._fbBlitQuad && this._fbBlitMaterial) return;
    this._fbBlitMaterial = createOpaqueBlitMaterial();
    this._fbBlitQuad = createFullscreenQuad(this._fbBlitMaterial);
  }

  /**
   * Blit `fromRT.texture` to the default framebuffer with forced opaque alpha.
   * Matches the anti-flicker policy enforced elsewhere (no autoclear of the
   * default FB; the shader writes every pixel opaquely).
   *
   * @param {THREE.WebGLRenderTarget} fromRT
   * @private
   */
  _blitRtToDefaultFramebuffer(fromRT) {
    if (!this.renderer || !fromRT) return;
    this._ensureFbBlitResources();
    const quad = this._fbBlitQuad;
    const mat = this._fbBlitMaterial;
    if (!quad || !mat) return;
    mat.uniforms.tDiffuse.value = fromRT.texture;
    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.setRenderTarget(null);
    this.renderer.autoClear = false;
    this.renderer.render(quad.scene, quad.camera);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.autoClear = prevAutoClear;
  }

  /**
   * @param {THREE.WebGLRenderTarget} rt
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {number} layerIndex 0 or 1
   */
  _renderTokenSceneToRT(rt, scene, camera, layerIndex) {
    if (!this.renderer || !rt || !scene || !camera) return;
    const _prevClear = new THREE.Color();
    this.renderer.getClearColor(_prevClear);
    const _prevClearA = this.renderer.getClearAlpha();
    const savedMask = camera.layers.mask;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(rt);
    this.renderer.autoClear = true;
    this.renderer.clear(true, true, true);
    camera.layers.disableAll();
    camera.layers.enable(layerIndex);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    camera.layers.mask = savedMask;
    this.renderer.setClearColor(_prevClear, _prevClearA);
  }

  /** Padding outside scene rect: match Foundry scene background when available. */
  _syncClipColor() {
    const scene = this.canvas?.scene;
    const comp = this.compositor;
    if (!comp?.setClipColorRgb) return;
    const [r, g, b] = readSceneBackgroundRgb01(scene);
    const c = this._scratchClipColor.setRGB(r, g, b, THREE.SRGBColorSpace);
    const tri = this._clipRgbTriplet;
    tri[0] = c.r;
    tri[1] = c.g;
    tri[2] = c.b;
    comp.setClipColorRgb(tri);
  }

  /**
   * When multiple levels are loaded, hide the upper slot while viewing the ground
   * floor (index 0) so opaque upper artwork does not cover the ground albedo.
   * Also notifies mask consumers when the viewed floor changes so the binding
   * controller re-resolves per-floor textures through {@link V3MaskHub}.
   */
  _syncFloorStackUniforms() {
    const scene = this.canvas?.scene;
    const comp = this.compositor;
    if (!comp?.setApplyUpper) return;
    const tc = this.srcs?.totalCount ?? 0;
    const v = tc < 2 ? 0 : getViewedLevelIndex(scene);
    if (tc < 2) {
      comp.setApplyUpper(false);
    } else {
      comp.setApplyUpper(v > 0);
    }
    if (typeof comp.setApplyFgUpper === "function") {
      if (tc < 2) {
        comp.setApplyFgUpper(false);
      } else {
        comp.setApplyFgUpper(v > 0);
      }
    }
    this._syncDrawingOverlayPlacement(tc >= 2 && v > 0);
    this._waterOverlay?.setApplyUpper(tc >= 2 && v > 0);
    this._waterOverlay?.setUpperAlbedo(this.compositor?.upperTex ?? null);
    this._waterOverlay?.setLowerForeground(this.compositor?.lowerFgTex ?? null);
    this._waterOverlay?.setUpperForeground(this.compositor?.upperFgTex ?? null);
    this._waterOverlay?.setApplyFgUpper(tc >= 2 && v > 0);
    if (this._lastViewedLevelIndex !== v) {
      this._lastViewedLevelIndex = v;
      try { this.maskBindings?.requestRebind(); } catch (_) {}
      try { this.maskHub?.syncForViewedLevel?.(); } catch (_) {}
    }
  }

  /**
   * Drawings should be:
   * - `deck` when upper compositing is active (so upper floor can occlude them)
   * - `postWater` when viewing ground (so they sit above water tint/effects)
   * @param {boolean} upperCompositingActive
   */
  _syncDrawingOverlayPlacement(upperCompositingActive) {
    const next = upperCompositingActive ? "deck" : "postWater";
    if (this._drawingOverlayPlacement === next) return;
    this._drawingOverlayPlacement = next;
    const target = next === "deck" ? this._tokenScene : this._drawingOverlayScene;
    try {
      this._drawingOverlay?.setScene(target);
    } catch (err) {
      this.warn("V3 drawing overlay scene reroute failed", err);
    }
  }

  _ensureWaterOverlay() {
    if (!this.compositor?.scene) return;
    if (!this._waterOverlay) {
      this._waterOverlay = new V3WaterOverlay();
      this._waterOverlay.attachTo(this._overlayScene);
      this._waterOverlay.setDisplayOptions({
        intensity: 0.45,
        tintRgb: [0.10, 0.42, 0.95],
      });
      const { w, h } = this._boardPixelSize();
      this._waterOverlay.setOutputSize(w, h);
    }
    this._waterOverlay.setUpperAlbedo(this.compositor?.upperTex ?? null);
    this._waterOverlay.setLowerForeground(this.compositor?.lowerFgTex ?? null);
    this._waterOverlay.setUpperForeground(this.compositor?.upperFgTex ?? null);
    const tc = this.srcs?.totalCount ?? 0;
    const viewed = tc < 2 ? 0 : getViewedLevelIndex(this.canvas?.scene);
    this._waterOverlay.setApplyUpper(tc >= 2 && viewed > 0);
    this._waterOverlay.setApplyFgUpper(tc >= 2 && viewed > 0);
  }

  _bindWaterMasks() {
    if (!this._waterOverlay) return;
    try { this._unregisterWaterLower?.(); } catch (_) {}
    try { this._unregisterWaterUpper?.(); } catch (_) {}
    this._unregisterWaterLower = this.maskBindings.register({
      id: "water-floor0",
      instance: this._waterOverlay,
      bindings: [{
        consumes: "water",
        singleSetter: "setLowerMask",
      }],
      getFloorKey: () => floorKeyForIndex(0),
      optional: true,
    });
    this._unregisterWaterUpper = this.maskBindings.register({
      id: "water-floor1",
      instance: this._waterOverlay,
      bindings: [{
        consumes: "water",
        singleSetter: "setUpperMask",
      }],
      getFloorKey: () => floorKeyForIndex(1),
      optional: true,
    });
    this.maskBindings.requestRebind();
  }

  /** List texture rows (configure + level docs) for the active scene. */
  getLevelTextureInventory() {
    return this._levelTexDebug.getLevelTextureInventory();
  }

  /** @param {object} [opts] Row picker + display options; see `V3HostLevelTextureDebugController`. */
  async setLevelTextureDebug(opts = {}) {
    return this._levelTexDebug.setLevelTextureDebug(opts);
  }

  /**
   * @param {string} url
   * @param {object} [opts]
   */
  async setLevelTextureDebugFromUrl(url, opts = {}) {
    return this._levelTexDebug.setLevelTextureDebugFromUrl(url, opts);
  }

  /**
   * @param {string} lowerMaskUrl
   * @param {string} upperMaskUrl
   * @param {object} [opts]
   */
  async setLevelTextureDebugDualOutdoorsOverAlbedo(lowerMaskUrl, upperMaskUrl, opts = {}) {
    return this._levelTexDebug.setLevelTextureDebugDualOutdoorsOverAlbedo(
      lowerMaskUrl,
      upperMaskUrl,
      opts,
    );
  }

  /**
   * @param {THREE.Texture|null} texture
   * @param {object} [opts]
   */
  setLevelTextureDebugFromHubTexture(texture, opts = {}) {
    return this._levelTexDebug.setLevelTextureDebugFromHubTexture(texture, opts);
  }

  /** Remove debug overlay and dispose its GPU texture. */
  clearLevelTextureDebug() {
    this._levelTexDebug.clearLevelTextureDebug();
  }

  /** Drive Three after PIXI: `runners.postrender` when available, else ticker (see `V3PixiThreeFrameBridge`). */
  _startLoop() {
    this._stopLoop();
    this._attachPixiPrerenderTransparentBg();
    this._attachPixiPrePrimarySuppressTicker();
    this._attachThreeCompositeDriver();
  }

  /**
   * Prefer Pixi v8 `renderer.runners.postrender` (same call stack as the end of
   * Foundry’s PIXI `render()`). Otherwise use the frame-bridge ticker / rAF.
   */
  _attachThreeCompositeDriver() {
    this._detachThreePostrenderOnly();
    this._frameBridge.detach();
    const pr = this.canvas?.app?.renderer?.runners?.postrender;
    if (pr && typeof pr.add === "function") {
      try {
        pr.add(this._v3PostrenderItem);
        this._setThreeCompositeDrive("postrender");
        this.log("[V3Frame] Three composite on renderer.runners.postrender");
        return;
      } catch (err) {
        this.warn("[V3Frame] postrender.add failed; using ticker bridge", err);
      }
    }
    const ok = this._frameBridge.attach(this.canvas?.app, this._onPixiTickRender, this);
    this._setThreeCompositeDrive(ok ? "ticker" : "raf");
  }

  /**
   * Log driver transitions at {@link this.log} so pipeline failovers are
   * visible in the console. Silent if the drive did not change.
   * @param {"none"|"postrender"|"ticker"|"raf"} next
   */
  _setThreeCompositeDrive(next) {
    const prev = this._threeCompositeDrive;
    if (prev === next) {
      this._threeCompositeDrive = next;
      return;
    }
    this._threeCompositeDrive = next;
    try {
      this.log(`[V3Frame] composite driver changed: ${prev} -> ${next}`);
    } catch (_) {}
  }

  /** Remove only the postrender hook (ticker bridge untouched). */
  _detachThreePostrenderOnly() {
    if (this._threeCompositeDrive !== "postrender") return;
    const pr = this.canvas?.app?.renderer?.runners?.postrender;
    if (pr && typeof pr.remove === "function") {
      try {
        pr.remove(this._v3PostrenderItem);
      } catch (_) {}
    }
    this._setThreeCompositeDrive("none");
  }

  /**
   * Runs **before** Foundry’s `UPDATE_PRIORITY.LOW` canvas render so
   * `primary.sprite` is already suppressed when PIXI draws the frame.
   */
  _attachPixiPrePrimarySuppressTicker() {
    this._detachPixiPrePrimarySuppressTicker();
    const app = this.canvas?.app;
    if (!app?.ticker?.add) return;
    const pri = v3PixiPrimarySuppressTickerPriority();
    this._pixiPrePrimarySuppressTick = () => {
      try {
        syncV3FoundryGameplayPixiSuppression(this.canvas);
      } catch (_) {}
    };
    try {
      app.ticker.add(this._pixiPrePrimarySuppressTick, undefined, pri);
      this._pixiPreSuppressTickerApp = app;
    } catch (err) {
      this.warn("V3 pre-primary PIXI ticker attach failed", err);
      this._pixiPrePrimarySuppressTick = null;
    }
  }

  _detachPixiPrePrimarySuppressTicker() {
    const app = this._pixiPreSuppressTickerApp;
    const tick = this._pixiPrePrimarySuppressTick;
    if (app?.ticker?.remove && tick) {
      try {
        app.ticker.remove(tick);
      } catch (_) {}
    }
    this._pixiPreSuppressTickerApp = null;
    this._pixiPrePrimarySuppressTick = null;
  }

  /**
   * Re-assert transparent framebuffer clear at the **start** of every PIXI
   * `render()` so Foundry cannot flash an opaque black clear over the Three
   * canvas between ticker callbacks.
   *
   * In Pixi v7 `Renderer.render()` emits `prerender` **before** the framebuffer
   * clear (`renderTexture.clear()` reads `renderer.background.colorRgba`), so
   * resetting alpha here means the next clear is transparent.
   *
   * However, `renderer.background.alpha = 0` only updates the Color instance's
   * `_alpha` — some Pixi 7.x patches and/or modules can set `background.color`
   * with a value that also stomps alpha. We therefore also zero the underlying
   * `backgroundColor` alpha directly when available, and record whether we
   * observed a non-zero value for `diag()`.
   */
  _onPixiRendererPrerender() {
    try {
      const bg = this.canvas?.app?.renderer?.background;
      if (!bg) return;
      const before = typeof bg.alpha === "number" ? bg.alpha : null;
      if (before !== null && before !== 0) {
        this._diagPixiBgAlphaNonZeroObservations++;
        this._diagPixiBgAlphaLastObserved = before;
      }
      if (typeof bg.alpha === "number") bg.alpha = 0;
      const c = bg.backgroundColor;
      if (c) {
        if (typeof c.setAlpha === "function") c.setAlpha(0);
        else if (typeof c._alpha === "number") c._alpha = 0;
        if (Array.isArray(c._arrayRgba) && c._arrayRgba.length >= 4) {
          c._arrayRgba[3] = 0;
        }
      }
    } catch (_) {}
  }

  _attachPixiPrerenderTransparentBg() {
    this._detachPixiPrerenderTransparentBg();
    const ren = this.canvas?.app?.renderer;
    if (!ren) return;
    const pr = ren.runners?.prerender;
    if (pr && typeof pr.add === "function") {
      try {
        pr.add(this._v3PrerenderItem);
        this._pixiPrerenderUsesRunner = true;
        this.log("[V3Frame] prerender hook: transparent renderer.background (runner)");
        return;
      } catch (err) {
        this.warn("[V3Frame] runners.prerender.add failed; falling back to renderer.on", err);
      }
    }
    try {
      ren.on("prerender", this._onPixiPrerenderBound);
      this._pixiPrerenderRenderer = ren;
      this.log("[V3Frame] prerender hook: transparent renderer.background (event)");
    } catch (err) {
      this.warn("[V3Frame] renderer prerender attach failed", err);
    }
  }

  _detachPixiPrerenderTransparentBg() {
    if (this._pixiPrerenderUsesRunner) {
      const pr = this.canvas?.app?.renderer?.runners?.prerender;
      if (pr && typeof pr.remove === "function") {
        try {
          pr.remove(this._v3PrerenderItem);
        } catch (_) {}
      }
      this._pixiPrerenderUsesRunner = false;
    }
    if (this._pixiPrerenderRenderer) {
      try {
        this._pixiPrerenderRenderer.off("prerender", this._onPixiPrerenderBound);
      } catch (_) {}
      this._pixiPrerenderRenderer = null;
    }
  }

  /** Ticker / rAF fallback when `runners.postrender` is unavailable. */
  _onPixiTickRender() {
    this._runV3CompositeAfterFoundryPixi();
  }

  /** Wall-clock period (ms) for one “logical” frame at the enforced FPS cap. */
  _v3CompositeFramePeriodMs() {
    try {
      const raw = getEffectiveFpsCap();
      const fps = Math.min(120, Math.max(30, typeof raw === "number" && raw > 0 ? raw : 60));
      return 1000 / fps;
    } catch (_) {
      return 1000 / 60;
    }
  }

  /**
   * Minimum ms between composites — high caps shrink `floor(now/period)` buckets so
   * two dupes could land in adjacent buckets within one browser rAF; wall spacing
   * tracks ~one logical frame instead.
   */
  _v3MinMsBetweenComposites() {
    const period = this._v3CompositeFramePeriodMs();
    return Math.max(6.5, period * 0.88);
  }

  /** @returns {number} perf.now in ms, or Date.now as fallback. */
  _nowMs() {
    try { return globalThis.performance?.now?.() ?? Date.now(); }
    catch (_) { return Date.now(); }
  }

  /**
   * `postrender` fires after **every** `renderer.render()` (screen + RTT). In
   * both Pixi v7 and v8 Foundry issues many `renderer.render(obj, {renderTexture})`
   * calls per tick (fog, visibility, loader, transitions, token capture) — each
   * emits its own `postrender`. We must only composite Three on the **final
   * screen** render of the tick, otherwise Three paints ahead of PIXI's screen
   * frame and the dual-canvas compositor reads stale/black pixels.
   *
   * - **Pixi v8**: gate via `renderer.renderTarget.renderingToScreen`.
   * - **Pixi v7** (Foundry v14 — 7.4.3): gate via `renderer.renderTexture.current`.
   *   At postrender time, `current === null` is drawing to the default framebuffer
   *   (i.e. the screen); otherwise an RT is bound and we skip.
   *
   * Before this gate existed on v7, V3 composited on **every** internal RTT
   * `postrender` then the same-tick / wall-gap dedupe **blocked the actual
   * screen render** — inverting Three vs PIXI presentation order. See
   * `docs/archive/2026-04-20-pre-restructure/V3-flicker-investigation.md` F1/F3.
   *
   * @param {unknown} _opts
   */
  _onPixiRendererPostrender(_opts) {
    this._diagPostrenderEvents++;
    const ren = this.canvas?.app?.renderer;

    // Pixi v8 gate (absent in Foundry v14 / Pixi 7.4.3).
    const rtSysV8 = ren?.renderTarget;
    if (rtSysV8 && typeof rtSysV8.renderingToScreen === "boolean") {
      this._diagLastRenderingToScreen = rtSysV8.renderingToScreen;
      if (!rtSysV8.renderingToScreen) {
        this._diagPostrenderSkippedRt++;
        return;
      }
      this._diagPostrenderMain++;
      this._recordBurstFlush(1, 0);
      this._runV3CompositeAfterFoundryPixi();
      return;
    }

    // Pixi v7 gate: `renderer.renderTexture.current` is the bound RT, or null
    // for the default framebuffer (screen).
    const rtSysV7 = ren?.renderTexture;
    if (rtSysV7 && "current" in rtSysV7) {
      const toScreen = rtSysV7.current == null;
      this._diagLastRenderingToScreen = toScreen;
      if (!toScreen) {
        this._diagPostrenderSkippedRt++;
        return;
      }
      this._diagPostrenderMain++;
      this._recordBurstFlush(1, 0);
      this._runV3CompositeAfterFoundryPixi();
      return;
    }

    // Unknown renderer: best-effort — composite on every postrender and rely on
    // the same-tick / wall-gap dedupe inside `_runV3CompositeAfterFoundryPixi`.
    this._diagLastRenderingToScreen = null;
    this._diagPostrenderMain++;
    this._recordBurstFlush(1, 0);
    this._runV3CompositeAfterFoundryPixi();
  }

  /**
   * Telemetry for burst size + composite latency.
   * @param {number} burst
   * @param {number} latencyMs
   */
  _recordBurstFlush(burst, latencyMs) {
    if (burst > this._diagPostrenderMaxBurst) this._diagPostrenderMaxBurst = burst;
    this._diagPostrenderBurstTotal += burst;
    this._diagPostrenderBurstFlushes += 1;
    this._diagPostrenderLastLatencyMs = latencyMs;
    if (latencyMs > this._diagPostrenderMaxLatencyMs) {
      this._diagPostrenderMaxLatencyMs = latencyMs;
    }
  }

  _ensureDebugAlbedoBlitPass() {
    if (this._debugAlbedoBlitMesh) return;
    const scene = new THREE.Scene();
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    this._debugAlbedoBlitScene = scene;
    this._debugAlbedoBlitMesh = mesh;
  }

  /**
   * When {@link V3_DEBUG_SKIP_ILLUMINATION_PASS}: copy albedo RT to default framebuffer
   * (same ortho camera as {@link V3IlluminationPipeline}).
   * @param {THREE.WebGLRenderTarget} albedoRT
   */
  _debugBlitAlbedoToScreen(albedoRT) {
    this._ensureDebugAlbedoBlitPass();
    const mesh = this._debugAlbedoBlitMesh;
    if (!mesh) return;
    const mat = /** @type {THREE.MeshBasicMaterial} */ (mesh.material);
    const tex = albedoRT.texture;
    if (mat.map !== tex) {
      mat.map = tex;
      mat.needsUpdate = true;
    }
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.setRenderTarget(null);
    // Do **not** clear the default framebuffer here: `autoClear: true` with a
    // transparent GL clear flashes black under the PIXI canvas every frame while
    // the fullscreen quad repaints — reads as severe flicker.
    this.renderer.autoClear = false;
    this.renderer.render(this._debugAlbedoBlitScene, this.illumination.camera);
    this.renderer.autoClear = prevAutoClear;
  }

  /**
   * One composite step:
   *
   *   1. Token scene -> `_tokenBelowRT` / `_tokenAboveRT` (layer masks 0 / 1)
   *   2. Sandwich scene -> `_albedoRT`        (map + both token decks; see compositor)
   *   3. Illumination pass -> default FB OR `_litRT` (ambient × Π occ + Σ direct)
   *   4. Effect chain (phase `postIllumination`) — only when any effect enabled
   *   5. Overlay scene (water / weather) onto the phase-A output
   *   6. Effect chain (phase `postSceneOverlay`) — default target for stylised filters
   *   7. Final blit -> default framebuffer (opaque; chain path only)
   *   8. Drawings overlay -> default framebuffer (NEVER filtered, keeps UI legible)
   *
   * When the {@link effectChain} has no enabled effects, steps 3–7 collapse
   * into the original direct "illumination -> default FB, then overlays" path
   * for zero GPU overhead.
   */
  _runV3CompositeAfterFoundryPixi() {
    if (!this.renderer || !this.compositor) return;
    if (this._v3CompositeReentrant) return;

    const now = this._nowMs();
    const tLt = this.canvas?.app?.ticker?.lastTime;
    const hasLt = typeof tLt === "number" && Number.isFinite(tLt);
    const dbgUnthrottled = v3DebugFlickerCompositeUnthrottled();
    if (!dbgUnthrottled) {
      if (hasLt && tLt === this._v3CompositeLastPixiTickerLt) {
        return;
      }
      const minGap = this._v3MinMsBetweenComposites();
      if (this._v3CompositeLastRunWallMs != null && (now - this._v3CompositeLastRunWallMs) < minGap) {
        return;
      }
      this._v3CompositeLastRunWallMs = now;
    }
    if (hasLt) this._v3CompositeLastPixiTickerLt = tLt;

    this._v3CompositeReentrant = true;
    try {
      this._frameCount++;
      this._syncViewportUniforms();
      try {
        syncV3FoundryGameplayPixiSuppressionLight(this.canvas);
      } catch (_) {}
      try {
        this._tokenOverlay?.frameUpdate(this.canvas, this.renderer, this._viewUniformPayload);
      } catch (err) {
        this.warn("V3 token overlay frameUpdate failed", err);
      }
      try {
        this._drawingOverlay?.frameUpdate(this.canvas, this.renderer, this._viewUniformPayload);
      } catch (err) {
        this.warn("V3 drawing overlay frameUpdate failed", err);
      }

      const albedoRT = this._albedoRT;
      if (!albedoRT) {
        // RT not allocated yet — `_resizeToBoard()` runs in `mount()` and
        // allocates it, so this is only possible for a composite raced in
        // before allocation completes. Skip: drawing the sandwich directly to
        // the default framebuffer paints **unlit sRGB albedo** (no darkness /
        // no lighting) which reads as a bright flash at scene mount. Losing
        // one composite is preferable to a perceptible wrong-lit frame.
        return;
      }

      const comp = this.compositor;
      const belowRt = this._tokenBelowRT;
      const aboveRt = this._tokenAboveRT;
      if (belowRt && aboveRt && comp) {
        try {
          this._renderTokenSceneToRT(
            belowRt,
            this._tokenScene,
            comp.camera,
            V3_TOKEN_LAYER_BELOW_DECK,
          );
          this._renderTokenSceneToRT(
            aboveRt,
            this._tokenScene,
            comp.camera,
            V3_TOKEN_LAYER_ON_DECK,
          );
          comp.setTokenDeckLayers({
            belowHas: true,
            belowTex: belowRt.texture,
            aboveHas: true,
            aboveTex: aboveRt.texture,
          });
          this.illumination.setTokenDeckState({
            belowHas: true,
            belowTex: belowRt.texture,
            aboveHas: true,
            aboveTex: aboveRt.texture,
          });
        } catch (err) {
          this.warn("V3 token deck RT render failed", err);
          try {
            comp.setTokenDeckLayers({
              belowHas: false,
              belowTex: null,
              aboveHas: false,
              aboveTex: null,
            });
          } catch (_) {}
          this.illumination.setTokenDeckState({
            belowHas: false,
            belowTex: null,
            aboveHas: false,
            aboveTex: null,
          });
        }
      } else {
        try {
          comp?.setTokenDeckLayers({
            belowHas: false,
            belowTex: null,
            aboveHas: false,
            aboveTex: null,
          });
        } catch (_) {}
        this.illumination.setTokenDeckState({
          belowHas: false,
          belowTex: null,
          aboveHas: false,
          aboveTex: null,
        });
      }

      const prevAutoClear = this.renderer.autoClear;
      this.renderer.setRenderTarget(albedoRT);
      this.renderer.autoClear = true;
      this.renderer.render(comp.scene, comp.camera);
      this.renderer.setRenderTarget(null);
      this.renderer.autoClear = prevAutoClear;

      try {
        comp?.setTokenDeckLayers({
          belowHas: false,
          belowTex: null,
          aboveHas: false,
          aboveTex: null,
        });
      } catch (_) {}

      // Effect-chain gating: when no effect is enabled we take the original
      // direct path (illumination -> default FB, overlays -> default FB). This
      // keeps the V3 baseline exactly as before — zero RT allocations, zero
      // extra blits — and avoids any risk of flicker regression in the common
      // case. When any effect is enabled we route illumination through
      // `_litRT`, run the chain, then blit opaquely to the default FB with
      // drawings drawn unfiltered on top.
      const chainActive =
        !V3_DEBUG_SKIP_ILLUMINATION_PASS &&
        this.effectChain?.hasAnyActiveEffects() === true;

      if (V3_DEBUG_SKIP_ILLUMINATION_PASS) {
        this._debugBlitAlbedoToScreen(albedoRT);
        if (!V3_DEBUG_SKIP_OVERLAY_PASS) {
          const prevAutoClear2 = this.renderer.autoClear;
          this.renderer.autoClear = false;
          this.renderer.render(this._overlayScene, this.compositor.camera);
          this.renderer.render(this._drawingOverlayScene, this.compositor.camera);
          this.renderer.autoClear = prevAutoClear2;
        }
      } else if (!chainActive) {
        // Fast path: no effect chain, original direct flow.
        this.illumination.render(this.renderer, null);
        if (!V3_DEBUG_SKIP_OVERLAY_PASS) {
          const prevAutoClear2 = this.renderer.autoClear;
          this.renderer.autoClear = false;
          this.renderer.render(this._overlayScene, this.compositor.camera);
          this.renderer.render(this._drawingOverlayScene, this.compositor.camera);
          this.renderer.autoClear = prevAutoClear2;
        }
      } else {
        // Chain path: illumination -> `_litRT`, optional phase-A effects,
        // water/weather into the phase-A output RT, optional phase-B effects,
        // opaque blit to default FB, drawings on top (unfiltered).
        const w = albedoRT.width;
        const h = albedoRT.height;
        const litRT = this._ensureLitRT(w, h);
        this.effectChain.ensureTargets(w, h);

        this.illumination.render(this.renderer, litRT);

        const chainCtx = {
          time:
            (typeof performance !== "undefined" && performance?.now)
              ? performance.now() * 0.001
              : Date.now() * 0.001,
          resolutionPx: [w, h],
          frame: this._frameCount,
        };

        // Phase A: post-illumination, pre-overlay. Effects here see the lit
        // scene without water/weather contributions.
        const afterA = this.effectChain.runPhase(
          V3_EFFECT_PHASES.POST_ILLUMINATION,
          this.renderer,
          { ...chainCtx, inputRT: litRT },
        );

        // Water / weather overlays composite into the phase-A output RT so
        // later effects (phase B, default for stylised filters) see them.
        if (!V3_DEBUG_SKIP_OVERLAY_PASS) {
          const prevTargetA = this.renderer.getRenderTarget();
          const prevAutoClearA = this.renderer.autoClear;
          this.renderer.setRenderTarget(afterA);
          this.renderer.autoClear = false;
          this.renderer.render(this._overlayScene, this.compositor.camera);
          this.renderer.setRenderTarget(prevTargetA);
          this.renderer.autoClear = prevAutoClearA;
        }

        // Phase B: post-scene-overlay. Default phase for stylised screen-space
        // filters — affects everything through water/weather but stops before
        // drawings and PIXI UI.
        const afterB = this.effectChain.runPhase(
          V3_EFFECT_PHASES.POST_SCENE_OVERLAY,
          this.renderer,
          { ...chainCtx, inputRT: afterA },
        );

        // Opaque blit to the default framebuffer. `autoClear=false` is kept
        // across the boundary; the blit shader writes every pixel with alpha
        // forced to 1 (see `createOpaqueBlitMaterial`).
        this._blitRtToDefaultFramebuffer(afterB);

        // Drawings drawn unfiltered so user authoring stays legible and the
        // filter cannot distort readable scene content.
        if (!V3_DEBUG_SKIP_OVERLAY_PASS) {
          const prevAutoClearD = this.renderer.autoClear;
          this.renderer.autoClear = false;
          this.renderer.render(this._drawingOverlayScene, this.compositor.camera);
          this.renderer.autoClear = prevAutoClearD;
        }

        this.effectChain.tickFrame();
      }

      // Intentionally no `gl.flush()` here: on dual-WebGL (PIXI + Three) stacks some
      // drivers/GPUs treat an extra flush as a sync point that worsens intermittent
      // black-frame compositing without improving correctness.

      this._recordFlickerDiagCompositeTick();
    } finally {
      this._v3CompositeReentrant = false;
    }
  }

  _stopLoop() {
    this._v3CompositeLastRunWallMs = null;
    this._v3CompositeLastPixiTickerLt = null;
    this._v3CompositeReentrant = false;
    this._cancelFlickerDiagRaf();
    this._detachFlickerDiagListeners();
    this._detachPixiPrerenderTransparentBg();
    this._detachPixiPrePrimarySuppressTicker();
    this._detachThreePostrenderOnly();
    this._frameBridge.detach();
    this._setThreeCompositeDrive("none");
  }

  /**
   * @param {string} url
   * @returns {Promise<THREE.Texture>}
   */
  _loadTexture(url) {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (tex) => {
          tex.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          resolve(tex);
        },
        undefined,
        reject,
      );
    });
  }

  /**
   * Load visible level foreground(s) into the sandwich (after on-deck tokens).
   * @param {number} myToken mount generation guard
   * @private
   */
  async _bindForegroundTextures(myToken) {
    const comp = this.compositor;
    if (!comp?.setForegroundTextures) return;
    const fs = this.fgSrcs;
    if (!fs || (!fs.lowerSrc && !fs.upperSrc)) {
      comp.setForegroundTextures(null, null);
      comp.setApplyFgUpper(false);
      return;
    }
    try {
      if (fs.lowerSrc && !fs.upperSrc) {
        const lower = await this._loadTexture(fs.lowerSrc);
        if (myToken !== this._mountToken) return;
        comp.setForegroundTextures(lower, null);
        comp.setApplyFgUpper(false);
        this.log("single-level foreground bound (lower only)");
      } else if (!fs.lowerSrc || !fs.upperSrc) {
        comp.setForegroundTextures(null, null);
        comp.setApplyFgUpper(false);
        this.warn("foreground sources incomplete — skipping", {
          totalCount: fs.totalCount,
          source: fs.source,
        });
      } else {
        const [lower, upper] = await Promise.all([
          this._loadTexture(fs.lowerSrc),
          this._loadTexture(fs.upperSrc),
        ]);
        if (myToken !== this._mountToken) return;
        comp.setForegroundTextures(lower, upper);
        this._syncFloorStackUniforms();
        this.log("two-level foregrounds bound");
      }
    } catch (err) {
      this.warn("_bindForegroundTextures failed", err);
      comp.setForegroundTextures(null, null);
      comp.setApplyFgUpper(false);
    }
  }

  setUniforms(partial) {
    this.compositor?.setUniforms(partial);
  }

  /**
   * Pixel readback is not wired for the raw WebGL path yet.
   * @returns {null}
   */
  probePixel() {
    return null;
  }

  diag() {
    const view = this.canvas?.app?.view;
    const st = this.canvas?.stage;
    const { w, h } = this._boardPixelSize();
    const drive = this._threeCompositeDrive ?? "none";
    const bridgeSnap = this._frameBridge?.snapshot?.() ?? null;
    /** Ticker bridge is only attached when not using `runners.postrender`. */
    const frameBridge =
      drive === "postrender"
        ? {
            attached: false,
            moduleSetting: bridgeSnap?.setting ?? null,
            note:
              "Three runs on PIXI renderer.runners.postrender — ticker bridge is not attached; " +
              "v3FrameBridgeMode only applies if the host falls back to the ticker.",
          }
        : {
            attached: drive === "ticker" || drive === "raf",
            setting: bridgeSnap?.setting ?? null,
            drive: bridgeSnap?.drive ?? "none",
            pixiPriority: bridgeSnap?.pixiPriority ?? null,
          };
    return {
      renderer: "three.js",
      mounted: !!this.renderer?.domElement?.parentElement,
      scene: this.canvas?.scene?.id ?? null,
      srcs: this.srcs,
      fgSrcs: this.fgSrcs,
      boardPixels: { w, h },
      frameCount: this._frameCount,
      uniforms: this.compositor?.snapshotUniforms?.() ?? null,
      foundryTickerStopped: this.stopFoundryTicker,
      threeCompositeDrive: drive,
      /** Same as `threeCompositeDrive` (older field name; was wrongly mirroring detached bridge). */
      threeDrive: drive,
      frameBridge,
      postrenderProfile: {
        mainScreenComposites: this._diagPostrenderMain,
        skippedNonMainPasses: this._diagPostrenderSkippedRt,
        /** Total postrender events observed since mount (skipped + main + coalesced). */
        totalPostrenderEvents: this._diagPostrenderEvents,
        /**
         * Which screen-gate is active:
         *   - `"v8-renderingToScreen"` — Pixi v8 `renderer.renderTarget.renderingToScreen`.
         *   - `"v7-renderTexture.current"` — Pixi v7 bound-RT check (Foundry v14).
         *   - `"none"` — neither available; composite fires per postrender.
         */
        screenGate: (() => {
          const r = this.canvas?.app?.renderer;
          if (r?.renderTarget && typeof r.renderTarget.renderingToScreen === "boolean") {
            return "v8-renderingToScreen";
          }
          if (r?.renderTexture && "current" in r.renderTexture) {
            return "v7-renderTexture.current";
          }
          return "none";
        })(),
        /**
         * True when a screen gate is in effect. Back-compat name; see `screenGate`
         * for the specific implementation in use.
         */
        gateUsesRenderingToScreen: (() => {
          const r = this.canvas?.app?.renderer;
          if (r?.renderTarget && typeof r.renderTarget.renderingToScreen === "boolean") return true;
          if (r?.renderTexture && "current" in r.renderTexture) return true;
          return false;
        })(),
        /** Last value sampled in postrender; expect `true` for board, `false` for RTT. */
        lastRenderingToScreen: this._diagLastRenderingToScreen,
        /** How Three is scheduled given the active screen-gate. */
        coalesceMode: (() => {
          const r = this.canvas?.app?.renderer;
          if (r?.renderTarget && typeof r.renderTarget.renderingToScreen === "boolean") {
            return "renderingToScreen-gate";
          }
          if (r?.renderTexture && "current" in r.renderTexture) {
            return "renderTexture.current-gate";
          }
          return "postrender-immediate";
        })(),
        burst: {
          max: this._diagPostrenderMaxBurst,
          flushes: this._diagPostrenderBurstFlushes,
          meanSize: this._diagPostrenderBurstFlushes > 0
            ? this._diagPostrenderBurstTotal / this._diagPostrenderBurstFlushes
            : 0,
        },
        latencyMs: {
          last: this._diagPostrenderLastLatencyMs,
          max: this._diagPostrenderMaxLatencyMs,
        },
      },
      /** True when `renderer.runners.prerender` is used; else event fallback. */
      pixiPrerenderTransparentBg: {
        usesRunner: this._pixiPrerenderUsesRunner,
        usesEventFallback: !!this._pixiPrerenderRenderer,
        /**
         * Current Pixi background alpha read from the renderer. Expected `0`.
         * Any other value means an opaque PIXI clear will land under the Three
         * canvas through any transparent pixel — F9 in the flicker audit.
         */
        currentBgAlpha: (() => {
          try {
            const a = this.canvas?.app?.renderer?.background?.alpha;
            return typeof a === "number" ? a : null;
          } catch (_) { return null; }
        })(),
        /**
         * Number of times we observed `background.alpha !== 0` at the start of
         * a prerender tick. Non-zero count identifies a module / Foundry call
         * that is resetting the alpha and points at F9.
         */
        nonZeroAlphaResets: this._diagPixiBgAlphaNonZeroObservations,
        /** Last non-zero value observed (null if never). */
        lastNonZeroAlphaValue: this._diagPixiBgAlphaLastObserved,
      },
      stage: st
        ? {
            pivot: [st.pivot?.x, st.pivot?.y],
            scale: st.scale?.x,
          }
        : null,
      mesh: this.compositor?.mesh
        ? { visible: this.compositor.mesh.visible }
        : null,
      nativeViewOpacity: view ? view.style.opacity : null,
      nativeViewZIndex: view ? view.style.zIndex : null,
      primarySpriteRenderable: this.canvas?.primary?.sprite
        ? this.canvas.primary.sprite.renderable !== false
        : null,
      primarySpriteVisible: this.canvas?.primary?.sprite
        ? this.canvas.primary.sprite.visible !== false
        : null,
      pixiPrePrimarySuppressTicker: !!this._pixiPreSuppressTickerApp,
      levelTextureDebug: this._levelTexDebug.debugPick,
      textureDebugOverlay: this._levelTexDebug.textureDebug?.snapshot?.() ?? null,
      maskHub: this.maskHub?.snapshot?.() ?? null,
      maskBindings: this.maskBindings?.snapshot?.() ?? null,
      skyLighting: { ...this.skyLighting },
      lightAppearance: { ...this.lightAppearance },
      sceneColorGrade: { ...this.sceneColorGrade },
      tokenColorGrade: { ...this.tokenColorGrade },
      foundrySceneDarkness01: readFoundrySceneDarkness01(this.canvas),
      illumination: this.illumination?.snapshot?.() ?? null,
      effectChain: this.effectChain?.snapshot?.() ?? null,
      shaderWarmup: this.shaderWarmup?.snapshot?.() ?? null,
      albedoRT: this._albedoRT
        ? { width: this._albedoRT.width, height: this._albedoRT.height }
        : null,
      litRT: this._litRT
        ? { width: this._litRT.width, height: this._litRT.height }
        : null,
      tokenDeckRTs:
        this._tokenBelowRT && this._tokenAboveRT
          ? {
              below: { width: this._tokenBelowRT.width, height: this._tokenBelowRT.height },
              above: { width: this._tokenAboveRT.width, height: this._tokenAboveRT.height },
            }
          : null,
      tokens: this._tokenOverlay?.diag?.() ?? null,
      drawings: this._drawingOverlay?.diag?.() ?? null,
      pixiContextAlpha: readV3PixiContextHasAlpha(this.canvas),
      boardCssPixels: (() => {
        try {
          const { w, h } = this._boardPixelSize();
          return { w, h, pixiResolution: this.canvas?.app?.renderer?.resolution ?? null };
        } catch (_) {
          return null;
        }
      })(),
      flickerDiagnostics: {
        settingEnabled: this._flickerDiagActive(),
        lastAnimationFrameCompositeCount: this._flickerDiagLastRafCompositeCount,
        animationFramesWithMultipleComposites: this._flickerDiagMultiCompositeEvents,
        threeCanvas: {
          webglContextLost: this._flickerDiagThreeGlLoss,
          webglContextRestored: this._flickerDiagThreeGlRestore,
        },
        pixiCanvas: {
          webglContextLost: this._flickerDiagPixiGlLoss,
          webglContextRestored: this._flickerDiagPixiGlRestore,
        },
      },
    };
  }

  unmount() {
    this._mountToken++;
    // Cancel any in-flight shader warmup so stages cannot try to compile
    // against a renderer we are about to dispose. Keep the coordinator
    // instance (and its persisted adaptive metrics) around so a subsequent
    // `mount()` can reuse them.
    try {
      this.shaderWarmup?.clear();
    } catch (_) {}
    this._frameCount = 0;
    this._drawingOverlayPlacement = null;
    this._resizeStableW = null;
    this._resizeStableH = null;
    this._diagPostrenderMain = 0;
    this._diagPostrenderSkippedRt = 0;
    this._diagPostrenderEvents = 0;
    this._diagPostrenderMaxBurst = 0;
    this._diagPostrenderBurstTotal = 0;
    this._diagPostrenderBurstFlushes = 0;
    this._diagPostrenderLastLatencyMs = 0;
    this._diagPostrenderMaxLatencyMs = 0;
    this._diagLastRenderingToScreen = null;
    this._diagPixiBgAlphaNonZeroObservations = 0;
    this._diagPixiBgAlphaLastObserved = null;
    this._flickerDiagCompositesThisRaf = 0;
    this._flickerDiagLastRafCompositeCount = -1;
    this._flickerDiagMultiCompositeEvents = 0;
    this._flickerDiagThreeGlLoss = 0;
    this._flickerDiagThreeGlRestore = 0;
    this._flickerDiagPixiGlLoss = 0;
    this._flickerDiagPixiGlRestore = 0;
    this.clearLevelTextureDebug();
    try {
      if (this._debugAlbedoBlitMesh) {
        this._debugAlbedoBlitMesh.geometry?.dispose();
        this._debugAlbedoBlitMesh.material?.dispose();
      }
    } catch (_) {}
    this._debugAlbedoBlitMesh = null;
    this._debugAlbedoBlitScene = null;
    try { this._tokenOverlay?.dispose(); } catch (_) {}
    try { this._drawingOverlay?.dispose(); } catch (_) {}
    try { this._unregisterWaterLower?.(); } catch (_) {}
    try { this._unregisterWaterUpper?.(); } catch (_) {}
    this._unregisterWaterLower = null;
    this._unregisterWaterUpper = null;
    try { this._waterOverlay?.dispose(); } catch (_) {}
    this._waterOverlay = null;
    this._stopLoop();
    this._removeResize();

    const canvas = this.canvas;
    const r = this._foundryRestore;
    this._foundryRestore = null;
    if (r && canvas) {
      restoreV3FoundryCoexistence(canvas, r, { log: this.log.bind(this), warn: this.warn.bind(this) });
    }

    try { this.maskHub?.detach(); } catch (_) {}
    try { this.buildingShadowsPass?.detach(); } catch (_) {}
    try { this.floorLightBufferPass?.detach(); } catch (_) {}
    try { this.assetInventory?.clearAll(); } catch (_) {}

    try {
      if (this.renderer?.domElement?.parentElement) {
        this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
      }
    } catch (_) {}

    try { this.illumination?.dispose(); } catch (_) {}
    try { this.buildingShadowsPass?.dispose(); } catch (_) {}
    this._floorLightPassSig = null;
    this._floorLightPassCache = null;
    try { this.floorLightBufferPass?.dispose(); } catch (_) {}
    // Effect chain: dispose registered effects (bloom, dot-screen, …) and
    // ping-pong RTs. The chain object stays allocated so `host.effectChain`
    // references do not dangle; `register()` can repopulate after remount.
    try { this.effectChain?.dispose(); } catch (_) {}
    try { this._fbBlitQuad?.dispose(); } catch (_) {}
    try { this._fbBlitMaterial?.dispose(); } catch (_) {}
    this._fbBlitQuad = null;
    this._fbBlitMaterial = null;
    try { this._litRT?.dispose(); } catch (_) {}
    this._litRT = null;
    try { this._tokenBelowRT?.dispose(); } catch (_) {}
    try { this._tokenAboveRT?.dispose(); } catch (_) {}
    this._tokenBelowRT = null;
    this._tokenAboveRT = null;
    try { this._albedoRT?.dispose(); } catch (_) {}
    try { this.compositor?.dispose(); } catch (_) {}
    try { this.renderer?.dispose(); } catch (_) {}

    this._albedoRT = null;
    this.compositor = null;
    this.renderer = null;
    this.loader = null;
    this.canvas = null;
    this.srcs = null;
    this.fgSrcs = null;
    this._mountParent = null;
  }
}
