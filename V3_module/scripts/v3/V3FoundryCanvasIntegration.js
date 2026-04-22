/**
 * @fileoverview Foundry canvas / DOM integration for V3 — board mount parent,
 * pixel sizing, scene rect, and coexistence with the native PIXI view.
 *
 * ### Research (Foundry V14 client, `foundryvttsourcecode_v14`)
 *
 * - **Layer tree** — `resources/app/client/canvas/board.mjs` documents the canvas
 *   groups: `environment` (holds `primary` + `effects`), `visibility` (FoW /
 *   vision consolidation), `interface` (interaction + **grid**), `overlay`.
 *   The **grid** is not `canvas.grid` (that is `BaseGrid` data); the drawable grid
 *   lives on the interface group as `canvas.interface.grid` — see
 *   `resources/app/client/canvas/layers/grid.mjs` (`GridLayer.instance` →
 *   `canvas.interface.grid`).
 * - **Ticker order** — Foundry’s main PIXI render uses `PIXI.UPDATE_PRIORITY.LOW`
 *   (-25); V3’s Three pass was registered at `UTILITY` (-50), i.e. **after** that
 *   render (`V3PixiThreeFrameBridge.js`). Hiding `primary.sprite` only in that late
 *   callback leaves the sprite visible for the whole Foundry draw; register a
 *   second ticker listener at **`UPDATE_PRIORITY.NORMAL` (0)**, which runs **before**
 *   `LOW`, to suppress the sprite each frame before the canvas is painted.
 * - **Legacy Map Shine parity (`v13_module/scripts/foundry/canvas-replacement.js`)**
 *   — `_enforceGameplayPixiSuppression` / `createThreeCanvas` do **not** rely on
 *   hiding `primary.sprite` alone. They (1) set `canvas.app.renderer.background.alpha = 0`
 *   so Foundry’s GL clear does not paint an opaque plate over Three (Foundry resets
 *   this on many paths), (2) set `canvas.background.visible = false`, (3) in v13
 *   also set `primary` map children `visible = false` **and** disable
 *   `canvas.visibility` (Three replaces fog). **V3 differs:** we keep
 *   `CanvasVisibility` off in V3 (see “FoW vs Three” above). Primary map children
 *   can stay hidden like v13 (`background` / `foreground` / `tiles` /
 *   `levelTextures` → `visible = false`) because the fog filter is not presented.
 *   (4) hide `canvas.weather` and
 *   **`canvas.effects`** during gameplay (not `canvas.environment` — that would skip `primary.render()`
 *   and stall `primary.renderTexture`, breaking FoW which samples that texture). **Exception:**
 *   `EffectsCanvasGroup` stays **off** in V3 (including while editing lights): it is
 *   not where `LightingLayer` lives, and enabling it tints the board via
 *   `CanvasIlluminationEffects` + vision masks. `canvas.background` stays off during
 *   lighting so Three stays visible through transparent PIXI. (5)
 *   zero alpha on **`canvas.tiles.placeables`** (native
 *   tile meshes — separate from `primary.tiles`), (6) keep token **layers**
 *   interactive while forcing **mesh alpha** to 0 so PIXI does not draw token art.
 *   V3 follows the same rules but **does not** hide
 *   `canvas.visibility` / FoW (V3 wants Foundry fog); v13 disables those for its own
 *   Three fog path.
 * - **Primary cache + sprite** — `PrimaryCanvasGroup` / `CachedContainer` still
 *   update `renderTexture` for shaders; we also keep `primary.sprite` suppressed
 *   (`renderable`/`visible`) per `cached-container.mjs`.
 * - **FoW vs Three under PIXI** — `CanvasVisibility` applies a fullscreen filter
 *   (`visibility.mjs`) that composites fog using `primaryTexture` + vision data.
 *   That pass is effectively **opaque across the board** in normal GM view, so a
 *   Three.js canvas **under** the PIXI `#board` view never shows through (grey +
 *   grid is typical). **V3 therefore disables the native visibility + fog draw**
 *   while the stack is active (same trade-off as `v13_module` gameplay suppression).
 *   Native Foundry FoW would require a separate Three-side implementation or a
 *   different compositing architecture.
 * - **Seeing WebGL through PIXI** — `Canvas.#configureCanvasSettings` passes
 *   `transparent` into `PIXI.Application` (`board.mjs` ~713–724) and emits
 *   `Hooks.callAll("canvasConfig", config)` before the app is constructed. For a
 *   second canvas (Three) **under** the PIXI `#board` view to show through “empty”
 *   pixels (grid lines, transparent fog blend), the PIXI surface must be able to
 *   preserve alpha; set `config.transparent = true` from a `canvasConfig` hook
 *   **before** the first canvas build (reload required if the app was already
 *   created with `transparent: false`).
 */
import { getViewedLevelIndex } from "./V3ViewedLevel.js";

/**
 * @typedef {{
 *   tickerWasStarted: boolean,
 *   weStoppedTicker: boolean,
 *   viewVisibility: string,
 *   viewPointerEvents: string,
 *   viewOpacity: string,
 *   viewZIndex: string,
 *   primarySpriteRenderable: boolean,
 *   primarySpriteVisible: boolean,
 *   rendererBackgroundAlpha: number,
 *   weatherWasVisible: boolean,
 *   canvasBackgroundWasVisible: boolean,
 *   effectsWasVisible: boolean,
 *   visibilityWasVisible: boolean,
 *   visibilityFilterWasEnabled: boolean,
 *   visibilityVisionWasVisible: boolean,
 *   fogWasVisible: boolean,
 * }} V3FoundryCoexistenceRestore
 */

/**
 * Whether the Foundry PIXI view was created with a WebGL color buffer that has an
 * alpha channel (`getContextAttributes().alpha`). If `false`, clearing with
 * `renderer.background.alpha = 0` may still not reveal the DOM/WebGL layer below.
 * @param {any} canvas
 * @returns {boolean|null} null if unknown
 */
export function readV3PixiContextHasAlpha(canvas) {
  try {
    const gl = canvas?.app?.renderer?.gl ?? canvas?.app?.renderer?.context;
    if (!gl || typeof gl.getContextAttributes !== "function") return null;
    return gl.getContextAttributes().alpha === true;
  } catch (_) {
    return null;
  }
}

/**
 * PIXI ticker priority at which to hide `canvas.primary.sprite` **before** Foundry’s
 * canvas render (`UPDATE_PRIORITY.LOW` in PixiJS v7+).
 * @returns {number}
 */
export function v3PixiPrimarySuppressTickerPriority() {
  const P = globalThis.PIXI;
  if (P?.UPDATE_PRIORITY && typeof P.UPDATE_PRIORITY.NORMAL === "number") {
    return P.UPDATE_PRIORITY.NORMAL;
  }
  return 0;
}

/**
 * @param {any} canvas Foundry canvas
 * @returns {HTMLElement|null}
 */
export function resolveV3BoardMountParent(canvas) {
  try {
    const view = canvas?.app?.view;
    if (view?.parentElement) return view.parentElement;
  } catch (_) {}
  try {
    return document.getElementById("board");
  } catch (_) {}
  return null;
}

/**
 * Position/size the Three.js canvas to the same **layout box** as Foundry’s PIXI
 * `app.view` (CSS pixels). `inset:0` + `width:100%` can diverge when the board
 * uses transforms, scroll, or non-uniform scaling; this matches v13’s sibling
 * `top/left/width/height` alignment to `#board`.
 *
 * @param {HTMLElement|null} pixiView Foundry `canvas.app.view`
 * @param {HTMLElement|null} threeCanvas `renderer.domElement`
 */
export function syncV3WebglDomElementToPixiView(pixiView, threeCanvas) {
  if (!pixiView || !threeCanvas) return;
  try {
    const s = threeCanvas.style;
    s.position = "absolute";
    s.boxSizing = "border-box";
    s.margin = "0";
    s.padding = "0";
    s.inset = "auto";
    s.right = "auto";
    s.bottom = "auto";
    const parent = pixiView.parentElement;
    const pr = parent?.getBoundingClientRect?.();
    const vr = pixiView.getBoundingClientRect?.();
    if (pr && vr && vr.width >= 1 && vr.height >= 1) {
      s.left = `${Math.round(vr.left - pr.left)}px`;
      s.top = `${Math.round(vr.top - pr.top)}px`;
      s.width = `${Math.round(vr.width)}px`;
      s.height = `${Math.round(vr.height)}px`;
      return;
    }
    s.left = `${pixiView.offsetLeft}px`;
    s.top = `${pixiView.offsetTop}px`;
    s.width = `${Math.max(1, Math.round(pixiView.clientWidth))}px`;
    s.height = `${Math.max(1, Math.round(pixiView.clientHeight))}px`;
  } catch (_) {}
}

/**
 * Insert the Three.js `<canvas>` **before** Foundry’s PIXI view in the board
 * stacking context so the PIXI layer paints on top (grid / FoW / UI) while
 * transparent pixels reveal the WebGL layer below.
 *
 * @param {HTMLElement|null} parent
 * @param {HTMLCanvasElement|null} webglCanvas
 * @param {HTMLCanvasElement|null} pixiView
 */
export function insertV3WebglCanvasUnderPixiView(parent, webglCanvas, pixiView) {
  if (!parent || !webglCanvas) return;
  try {
    if (pixiView && pixiView.parentElement === parent) {
      parent.insertBefore(webglCanvas, pixiView);
    } else {
      parent.appendChild(webglCanvas);
    }
  } catch (_) {
    try {
      parent.appendChild(webglCanvas);
    } catch (_) {}
  }
}

/**
 * Hide portrait mesh on native tiles/tokens only — **do not** blanket-zero every
 * `placeable.children` alpha (that hid `token.border`, selection frames, ruler
 * anchors, and other Foundry UI that lives under token/tile display objects).
 *
 * @param {any} canvas
 */
export function applyV3TokenTileAlphaForThreeMode(canvas) {
  const controlledIds = new Set(
    (Array.isArray(canvas?.tokens?.controlled) ? canvas.tokens.controlled : [])
      .map((t) => String(t?.id ?? t?.document?.id ?? "").trim())
      .filter((id) => id.length > 0),
  );

  try {
    const tps = canvas?.tiles?.placeables;
    if (tps) {
      for (const tile of tps) {
        if (!tile) continue;
        try {
          tile.visible = true;
          if (tile.mesh && typeof tile.mesh.alpha === "number") tile.mesh.alpha = 0;
          if (tile.texture && typeof tile.texture.alpha === "number") {
            tile.texture.alpha = 0;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  try {
    const placeables = canvas?.tokens?.placeables;
    if (placeables) {
      for (const token of placeables) {
        if (!token) continue;
        try {
          token.visible = true;
          if (token.mesh && typeof token.mesh.alpha === "number") token.mesh.alpha = 0;
          if (token.icon && token.icon !== token.mesh && typeof token.icon.alpha === "number") {
            token.icon.alpha = 0;
          }
          if (token.texture && typeof token.texture.alpha === "number") {
            token.texture.alpha = 0;
          }
          if (token.border) {
            const tid = String(token.id ?? token.document?.id ?? "").trim();
            const show =
              !!token.hover ||
              !!token.controlled ||
              !!(tid && controlledIds.has(tid));
            token.border.alpha = show ? 1 : 0;
            const prevShow = token.__v3BorderUiShow;
            token.__v3BorderUiShow = show;
            // `_refreshBorder` rebuilds geometry every call — running it every PIXI
            // tick fights Foundry and flickers rings; only refresh on edge to shown.
            if (show && show !== prevShow) {
              try {
                token.border.visible = true;
                token.border.renderable = true;
              } catch (_) {}
              try {
                if (typeof token._refreshBorder === "function") token._refreshBorder();
              } catch (_) {}
            }
          }
          // Keep Foundry token-vision helper displays suppressed in Three mode.
          // On control/select these helpers may become visible and can visually
          // flatten scene darkness over the board if left active.
          const visionHelpers = [
            token.vision,
            token.fov,
            token.los,
            token.detectionFilter,
            token.light,
          ];
          for (const helper of visionHelpers) {
            if (!helper || typeof helper !== "object") continue;
            try {
              if ("visible" in helper) helper.visible = false;
              if ("renderable" in helper) helper.renderable = false;
              if (typeof helper.alpha === "number") helper.alpha = 0;
            } catch (_) {}
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
}

/**
 * @param {any} drawingDoc
 * @param {any} scene
 * @param {string|null} viewedLevelId
 * @returns {boolean}
 */
function v3DrawingIncludedForViewedLevel(drawingDoc, scene, viewedLevelId) {
  if (!drawingDoc || !scene || !viewedLevelId) return true;
  const sorted = scene?.levels?.sorted;
  if (!Array.isArray(sorted) || sorted.length < 2) return true;

  const levelId = drawingDoc?.level;
  if (typeof levelId === "string" && levelId && levelId !== viewedLevelId) {
    if (typeof drawingDoc.includedInLevel === "function") {
      try {
        return !!drawingDoc.includedInLevel(viewedLevelId);
      } catch (_) {}
    }
    return false;
  }
  return true;
}

/**
 * Keep Foundry drawings visible in V3 while respecting viewed-level gating.
 * In stacked scenes, drawings from other levels are hidden via native
 * `includedInLevel` when present (fallback: strict `doc.level` match).
 *
 * @param {any} canvas
 */
export function applyV3DrawingVisibilityForThreeMode(canvas) {
  const layer = canvas?.drawings;
  if (!layer) return;

  // During gameplay, V3 composites drawings in Three (token deck pass) so hide
  // native PIXI drawings to avoid duplicate un-occluded art. Keep native layer
  // visible while actively editing drawings for handles/controls.
  const drawingsEditMode = !!layer?.active;
  try {
    layer.visible = drawingsEditMode;
    if ("renderable" in layer) layer.renderable = drawingsEditMode;
  } catch (_) {}
  if (!drawingsEditMode) return;

  const scene = canvas?.scene;
  const sorted = scene?.levels?.sorted;
  const multiFloor = Array.isArray(sorted) && sorted.length >= 2;
  let viewedLevelId = null;
  if (multiFloor) {
    try {
      const viewedIdx = getViewedLevelIndex(scene);
      const viewed = sorted[viewedIdx];
      viewedLevelId = viewed?.id ?? viewed?.document?.id ?? null;
    } catch (_) {}
  }

  const placeables = Array.isArray(layer?.placeables) ? layer.placeables : [];
  for (const drawing of placeables) {
    if (!drawing) continue;
    const doc = drawing.document ?? drawing;
    let visible = true;
    try {
      if ("isVisible" in drawing) visible = !!drawing.isVisible;
    } catch (_) {}
    if (visible && multiFloor) {
      visible = v3DrawingIncludedForViewedLevel(doc, scene, viewedLevelId);
    }
    try {
      drawing.visible = visible;
      if ("renderable" in drawing) drawing.renderable = visible;
    } catch (_) {}
  }
}

/**
 * Foundry v14 `EffectsCanvasGroup` (`groups/effects.mjs`) is separate from
 * `LightingLayer`: layers are parented by `CONFIG.Canvas.layers[].group` via
 * `canvas-group-mixin.mjs` (`canvas.lighting` is typically under `interface`, not
 * under `effects`). V3 keeps `canvas.effects` **hidden** during gameplay and
 * lighting placement so `CanvasIlluminationEffects` does not run its MULTIPLY
 * filter against a stale `canvas.masks.vision` texture (V3 suppresses
 * `canvas.visibility`), which otherwise tints the whole board grey.
 *
 * Call this before setting `effects.visible = false` so child layers are left in
 * a sane state if Foundry later toggles the group again.
 *
 * @param {any} effects `canvas.effects`
 */
function v3RestoreEffectsCanvasChildren(effects) {
  if (!effects) return;
  const keys = ['darkness', 'illumination', 'coloration', 'background'];
  for (const k of keys) {
    const layer = effects[k];
    if (!layer || typeof layer !== 'object') continue;
    try {
      layer.visible = true;
      if ('renderable' in layer) layer.renderable = true;
    } catch (_) {}
  }
}

/**
 * Whether the GM is in a Foundry-native PIXI workflow that must stay interactive
 * while V3 suppresses the rest of the board (lights, walls, ruler, templates, …).
 *
 * `LightingLayer` (`canvas/layers/lighting.mjs`) is a normal `CanvasLayer` parented
 * by `CONFIG.Canvas.layers.lighting.group` (see `canvas-group-mixin.mjs`), usually
 * **interface**, not `canvas.effects`. V3 must **not** turn `canvas.effects` on for
 * placement: `CanvasIlluminationEffects` multiplies against `canvas.masks.vision`
 * while V3 hides `canvas.visibility`, which reads as a flat grey board.
 *
 * To **brighten Three** from Foundry lights, read `canvas.scene.lights` (AmbientLight
 * documents) and feed `V3IlluminationPipeline` direct terms (`registerDirectTerm`) —
 * do not sample the PIXI effects pass. Hooks: `createAmbientLight`, `updateAmbientLight`,
 * `deleteAmbientLight`, `lightingRefresh`.
 *
 * `canvas.background` stays off during lighting so the Three canvas stays visible
 * through transparent PIXI. Ruler and other tools use `showBackdrop` where needed.
 *
 * The returned `nativeToolLayers` list names the `canvas.<name>` layers that must
 * be re-asserted visible + interactive each frame for the user's active tool to
 * work. The per-frame `syncV3FoundryGameplayPixiSuppression` loop toggles
 * `canvas.effects` / `canvas.visibility` / `canvas.fog` / `canvas.weather` off
 * aggressively; without this explicit allow-list only `canvas.lighting` got the
 * defensive re-enable, which is why lights could be placed but walls (and
 * templates, drawings, sounds, notes, regions, tiles) could not — Foundry
 * refresh-flag rebuilds and the backdrop toggle kept clobbering
 * `visible` / `interactiveChildren` on those layers between frames.
 *
 * @param {any} canvas
 * @returns {{
 *   lightingPlacementMode: boolean,
 *   showBackdrop: boolean,
 *   nativeToolLayers: string[],
 * }}
 */
export function v3FoundryNativePixiToolPolicy(canvas) {
  const policy = {
    lightingPlacementMode: false,
    showBackdrop: false,
    nativeToolLayers: /** @type {string[]} */ ([]),
  };
  try {
    if (!canvas?.ready) return policy;

    const activeControl = String(
      ui?.controls?.control?.name ?? ui?.controls?.activeControl ?? "",
    ).toLowerCase();
    const activeControlLayer = String(ui?.controls?.control?.layer ?? "").toLowerCase();
    const activeTool = String(
      ui?.controls?.tool?.name ?? ui?.controls?.activeTool ?? game?.activeTool ?? "",
    ).toLowerCase();

    const layer = canvas.activeLayer;
    const ctor = String(layer?.constructor?.name ?? "").toLowerCase();
    const optName = String(layer?.options?.name ?? "").toLowerCase();
    const layerName = String(layer?.name ?? "").toLowerCase();

    const nameHits = (values) =>
      values.some(
        (v) =>
          v === optName
          || v === layerName
          || v === activeControl
          || v === activeControlLayer,
      );

    const lightingContext =
      !!canvas.lighting?.active
      || ctor === "lightinglayer"
      || ctor.includes("ambientlight")
      || nameHits(["lighting", "light", "lights", "illumination"]);

    const rulerLike =
      activeTool === "ruler" || activeTool === "measure" || activeTool === "distance";

    const nativeBackdropEdit =
      rulerLike
      || !!canvas.walls?.active
      || !!canvas.templates?.active
      || !!canvas.drawings?.active
      || !!canvas.sounds?.active
      || !!canvas.notes?.active
      || !!canvas.regions?.active
      || !!canvas.tiles?.active
      || nameHits([
        "walls",
        "wall",
        "templates",
        "template",
        "drawings",
        "drawing",
        "sounds",
        "sound",
        "notes",
        "note",
        "regions",
        "region",
        "tiles",
        "tile",
      ])
      || ctor === "wallslayer"
      || ctor === "walllayer"
      || ctor === "templatelayer"
      || ctor === "drawingslayer"
      || ctor === "soundslayer"
      || ctor === "noteslayer"
      || ctor === "regionlayer"
      || ctor === "tileslayer";

    policy.lightingPlacementMode = !!lightingContext;
    policy.showBackdrop = !!nativeBackdropEdit;

    // Identify which `canvas.<name>` layers need defensive re-enable this frame.
    // Parity with the lighting carve-out — any native tool whose layer is active
    // must keep `visible` + `interactiveChildren` true despite the per-frame
    // suppression pass.
    const toolLayerCandidates = [
      "lighting",
      "walls",
      "templates",
      "drawings",
      "sounds",
      "notes",
      "regions",
      "tiles",
    ];
    const nameHitMap = {
      lighting: ["lighting", "light", "lights", "illumination"],
      walls: ["walls", "wall"],
      templates: ["templates", "template"],
      drawings: ["drawings", "drawing"],
      sounds: ["sounds", "sound"],
      notes: ["notes", "note"],
      regions: ["regions", "region"],
      tiles: ["tiles", "tile"],
    };
    const ctorHitMap = {
      lighting: ["lightinglayer"],
      walls: ["wallslayer", "walllayer"],
      templates: ["templatelayer"],
      drawings: ["drawingslayer"],
      sounds: ["soundslayer"],
      notes: ["noteslayer"],
      regions: ["regionlayer"],
      tiles: ["tileslayer"],
    };
    for (const key of toolLayerCandidates) {
      const active =
        !!canvas[key]?.active
        || nameHits(nameHitMap[key])
        || ctorHitMap[key].includes(ctor);
      if (active) policy.nativeToolLayers.push(key);
    }
  } catch (_) {
  }
  return policy;
}

/**
 * Cheap re-assert after Foundry’s LOW render: PIXI resets `renderer.background`
 * and token meshes often; **do not** re-hide whole visibility stack here (fights
 * Foundry mid-tick). Runs from the Three frame bridge (UTILITY / post-PIXI).
 *
 * @param {any} canvas
 */
export function syncV3FoundryGameplayPixiSuppressionLight(canvas) {
  try {
    const bg = canvas?.app?.renderer?.background;
    if (bg && typeof bg.alpha === "number") bg.alpha = 0;
  } catch (_) {}

  try {
    const spr = canvas?.primary?.sprite;
    if (spr) {
      spr.renderable = false;
      spr.visible = false;
    }
  } catch (_) {}

  applyV3TokenTileAlphaForThreeMode(canvas);
  applyV3DrawingVisibilityForThreeMode(canvas);
}

/**
 * Gameplay PIXI suppression: transparent clear, hide backdrop/weather/effects,
 * hide **CanvasVisibility** + **fog** (otherwise opaque over Three), hide primary
 * map children + sprite presentation, zero native tile/token **portrait** art
 * without destroying token/tile **chrome** (borders, HUD, measurements).
 *
 * When the user switches into native tools (walls, ruler, templates, …), we may
 * **re-show** `canvas.background` for empty-board hit targets and defensively
 * re-assert `visible` / `renderable` / `interactiveChildren` on the active
 * tool layer(s) — lighting, walls, templates, drawings, sounds, notes, regions,
 * tiles — so placement works for all of them (see
 * `v3FoundryNativePixiToolPolicy.nativeToolLayers`). Lighting placement keeps
 * `canvas.effects` **off**.
 *
 * @param {any} canvas
 */
export function syncV3FoundryGameplayPixiSuppression(canvas) {
  const nativePolicy = v3FoundryNativePixiToolPolicy(canvas);
  const isGm = !!game?.user?.isGM;
  const controlledTokens = Array.isArray(canvas?.tokens?.controlled) ? canvas.tokens.controlled : [];
  const gmHasControlledTokenWithVision = isGm && controlledTokens.some((t) => {
    try {
      const token = t?.document ? t : canvas?.tokens?.get?.(t?.id ?? t?.document?.id);
      const doc = token?.document ?? t?.document ?? t ?? {};
      const vision = doc?.vision && typeof doc.vision === "object" ? doc.vision : null;
      const brightSight = Number(vision?.bright ?? doc?.brightSight ?? 0);
      const dimSight = Number(vision?.dim ?? doc?.dimSight ?? 0);
      const hasRange = brightSight > 0 || dimSight > 0;
      const hasSightFlag = token?.hasSight === true || doc?.hasSight === true || vision?.enabled === true;
      return !!(hasSightFlag || hasRange);
    } catch (_) {
      return false;
    }
  });
  const showNativeFog = !isGm || gmHasControlledTokenWithVision;

  try {
    const bg = canvas?.app?.renderer?.background;
    if (bg && typeof bg.alpha === "number") bg.alpha = 0;
  } catch (_) {}

  try {
    if (canvas?.background) {
      canvas.background.visible = !!nativePolicy.showBackdrop;
    }
  } catch (_) {}

  try {
    const primary = canvas?.primary;
    if (primary) {
      // Never set `primary.displayed = true` while the map sprite is suppressed:
      // PrimaryCanvasGroup (CachedContainer) would still composite its RT (opaque
      // clear) over the Three canvas. **Do** keep `primary.visible = true` even in
      // lighting placement: Foundry's light chrome (icon / labels) often depends on
      // the primary group staying in the update graph; hiding the whole group made
      // only the radius (pure graphics) show.
      primary.visible = true;
      if (primary.background) primary.background.visible = false;
      if (primary.foreground) primary.foreground.visible = false;
      if (primary.tiles) primary.tiles.visible = false;
      if (Array.isArray(primary.levelTextures)) {
        for (const lt of primary.levelTextures) {
          if (lt) lt.visible = false;
        }
      }
      if (primary.tokens && typeof primary.tokens.forEach === "function") {
        primary.tokens.forEach((/** @type {any} */ mesh) => {
          if (!mesh) return;
          try {
            mesh.visible = true;
            if (typeof mesh.alpha === "number") mesh.alpha = 0;
          } catch (_) {}
        });
      }
      const spr = primary.sprite;
      if (spr) {
        spr.renderable = false;
        spr.visible = false;
      }
      if (primary.displayed === true) primary.displayed = false;
    }
  } catch (_) {}

  try {
    if (canvas?.weather) canvas.weather.visible = false;
  } catch (_) {}

  try {
    const effects = canvas?.effects;
    if (effects) {
      v3RestoreEffectsCanvasChildren(effects);
      effects.visible = false;
    }
    // Defensive re-enable for the active native-tool layer(s). Without this,
    // only lighting survived the per-frame suppression pass — walls, templates,
    // drawings, sounds, notes, regions, and tiles could not be placed because
    // something (Foundry refresh flags, our backdrop toggle, or child traversal
    // on other groups) clobbered `visible` / `interactiveChildren` between
    // ticks. This loop is the exact pattern the lighting carve-out used, just
    // generalised.
    const toolLayerNames = Array.isArray(nativePolicy.nativeToolLayers)
      ? nativePolicy.nativeToolLayers
      : [];
    for (const name of toolLayerNames) {
      const lyr = canvas?.[name];
      if (!lyr) continue;
      try {
        lyr.visible = true;
        if ('renderable' in lyr) lyr.renderable = true;
        lyr.interactiveChildren = true;
      } catch (_) {}
    }
  } catch (_) {}

  // GM UX policy:
  // - GM + controlled token(s) with vision: show native FoW/vision (LOS preview).
  // - GM + no controlled tokens or only visionless tokens: hide FoW so the GM can inspect whole map.
  // - Players: always show native FoW/vision.
  try {
    const vis = canvas?.visibility;
    if (vis) {
      vis.visible = showNativeFog;
      if ("renderable" in vis) vis.renderable = showNativeFog;
      if (vis.filter) vis.filter.enabled = showNativeFog;
      if (vis.vision) {
        vis.vision.visible = showNativeFog;
        if ("renderable" in vis.vision) vis.vision.renderable = showNativeFog;
      }
      if (Array.isArray(vis.children)) {
        for (const ch of vis.children) {
          if (ch && typeof ch.visible !== "undefined") ch.visible = showNativeFog;
          if (ch && typeof ch.renderable !== "undefined") ch.renderable = showNativeFog;
        }
      }
    }
  } catch (_) {}

  try {
    if (canvas?.fog) {
      canvas.fog.visible = showNativeFog;
      if ("renderable" in canvas.fog) canvas.fog.renderable = showNativeFog;
    }
  } catch (_) {}

  applyV3TokenTileAlphaForThreeMode(canvas);
  applyV3DrawingVisibilityForThreeMode(canvas);
}

/** @deprecated Use {@link syncV3FoundryGameplayPixiSuppression}; kept for call-site clarity. */
export function syncV3FoundryPrimarySpriteSuppression(canvas) {
  syncV3FoundryGameplayPixiSuppression(canvas);
}

/**
 * Logical viewport size in **CSS pixels** (same basis as Foundry’s stage / screen).
 * Do not use `HTMLCanvasElement.width` / `.height` here — those are backing-store
 * dimensions (`resolution` × layout) and will skew Three vs PIXI.
 *
 * @param {any} canvas Foundry canvas
 * @param {THREE.WebGLRenderer|null} renderer
 * @returns {{ w: number, h: number }}
 */
export function getV3BoardPixelSize(canvas, renderer) {
  const view = canvas?.app?.view;
  if (view) {
    const r = view.getBoundingClientRect?.();
    if (r && r.width >= 1 && r.height >= 1) {
      return {
        w: Math.max(1, Math.round(r.width)),
        h: Math.max(1, Math.round(r.height)),
      };
    }
    const cw = Math.round(view.clientWidth || 0);
    const ch = Math.round(view.clientHeight || 0);
    if (cw >= 1 && ch >= 1) return { w: cw, h: ch };
  }
  const el = renderer?.domElement?.parentElement;
  if (el) {
    const r2 = el.getBoundingClientRect();
    const w = Math.max(1, Math.round(r2.width));
    const h = Math.max(1, Math.round(r2.height));
    return { w, h };
  }
  return { w: 800, h: 600 };
}

/**
 * Match Three.js `setPixelRatio` to Foundry’s PIXI renderer `resolution` when available.
 * @param {any} canvas
 * @param {THREE.WebGLRenderer|null} renderer
 */
export function syncV3RendererPixelRatioToPixi(canvas, renderer) {
  if (!renderer?.setPixelRatio) return;
  try {
    const pr = Number(canvas?.app?.renderer?.resolution);
    const dpr = window.devicePixelRatio || 1;
    const v = Number.isFinite(pr) && pr > 0 ? pr : dpr;
    renderer.setPixelRatio(Math.min(Math.max(v, 0.25), 3));
  } catch (_) {}
}

/**
 * @param {any} canvas Foundry canvas
 * @returns {[number, number, number, number]}
 */
export function readV3SceneRectVec4(canvas) {
  const out = [0, 0, 1, 1];
  readV3SceneRectVec4Into(canvas, out);
  return out;
}

/**
 * Write scene rect into a pre-allocated length-4 array (avoids per-frame alloc).
 *
 * @param {any} canvas
 * @param {number[]} out length ≥ 4
 */
export function readV3SceneRectVec4Into(canvas, out) {
  const cv = canvas;
  const r = cv?.dimensions?.sceneRect ?? cv?.scene?.dimensions?.sceneRect;
  if (r && Number.isFinite(r.width) && r.width > 0 && Number.isFinite(r.height) && r.height > 0) {
    out[0] = Number(r.x) || 0;
    out[1] = Number(r.y) || 0;
    out[2] = Math.max(1, r.width);
    out[3] = Math.max(1, r.height);
    return;
  }
  const dw = cv?.dimensions?.width ?? cv?.scene?.dimensions?.width ?? 1000;
  const dh = cv?.dimensions?.height ?? cv?.scene?.dimensions?.height ?? 1000;
  out[0] = 0;
  out[1] = 0;
  out[2] = Math.max(1, dw);
  out[3] = Math.max(1, dh);
}

/**
 * Fill `target` with pan/zoom uniforms (reuses arrays on `target` — no new objects).
 *
 * @param {any} canvas Foundry canvas
 * @param {{
 *   pivotWorld: [number, number],
 *   invScale: number,
 *   sceneRect: [number, number, number, number],
 * }} target
 * @returns {boolean} false if stage missing
 */
export function buildV3ViewUniformPayloadInto(canvas, target) {
  const cv = canvas;
  const st = cv?.stage;
  if (!st) return false;
  const px = Number(st.pivot?.x);
  const py = Number(st.pivot?.y);
  const sc = Math.max(1e-6, Number(st.scale?.x) || 1);
  target.pivotWorld[0] = Number.isFinite(px) ? px : 0;
  target.pivotWorld[1] = Number.isFinite(py) ? py : 0;
  target.invScale = 1 / sc;
  readV3SceneRectVec4Into(cv, target.sceneRect);
  return true;
}

/**
 * Pan/zoom payload for sandwich + overlays (call every frame).
 *
 * @param {any} canvas Foundry canvas
 * @returns {{ pivotWorld: [number, number], invScale: number, sceneRect: [number, number, number, number] }|null}
 */
export function buildV3ViewUniformPayload(canvas) {
  const target = {
    pivotWorld: /** @type {[number, number]} */ ([0, 0]),
    invScale: 1,
    sceneRect: /** @type {[number, number, number, number]} */ ([0, 0, 1, 1]),
  };
  return buildV3ViewUniformPayloadInto(canvas, target) ? target : null;
}

/**
 * Snapshot native view + ticker state; show PIXI on top of Three; apply gameplay
 * PIXI suppression while leaving grid / interface (native FoW draw is disabled; see fileoverview).
 *
 * @param {any} canvas
 * @param {V3FoundryCoexistenceRestore|null} existing
 * @param {{ stopFoundryTicker: boolean, log: Function, warn: Function }} opts
 * @returns {V3FoundryCoexistenceRestore|null}
 */
export function beginV3FoundryCoexistence(canvas, existing, opts) {
  const { stopFoundryTicker, log, warn } = opts;
  try {
    const view = canvas?.app?.view;
    const ticker = canvas?.app?.ticker;
    /** @type {V3FoundryCoexistenceRestore} */
    let restore = existing;
    if (!restore) {
      const spr = canvas?.primary?.sprite;
      const rb = canvas?.app?.renderer?.background;
      const rba = rb && typeof rb.alpha === "number" ? rb.alpha : 1;
      restore = {
        tickerWasStarted: ticker?.started === true,
        weStoppedTicker: false,
        viewVisibility: view ? (view.style.visibility || "") : "",
        viewPointerEvents: view ? (view.style.pointerEvents || "") : "",
        viewOpacity: view ? (view.style.opacity || "") : "",
        viewZIndex: view ? (view.style.zIndex || "") : "",
        primarySpriteRenderable: spr ? spr.renderable !== false : true,
        primarySpriteVisible: spr ? spr.visible !== false : true,
        rendererBackgroundAlpha: Number.isFinite(Number(rba)) ? Number(rba) : 1,
        weatherWasVisible: canvas?.weather?.visible !== false,
        canvasBackgroundWasVisible: canvas?.background?.visible !== false,
        effectsWasVisible: canvas?.effects?.visible !== false,
        visibilityWasVisible: canvas?.visibility?.visible !== false,
        visibilityFilterWasEnabled: !!(canvas?.visibility?.filter?.enabled),
        visibilityVisionWasVisible: canvas?.visibility?.vision?.visible !== false,
        fogWasVisible: canvas?.fog?.visible !== false,
      };
    }
    if (view) {
      view.style.visibility = "visible";
      view.style.opacity = "1";
      view.style.pointerEvents = "auto";
      // Do **not** raise `view.style.zIndex` into the tens (e.g. 40): the board and
      // Foundry’s HTML HUD / sidebar / chat often share a parent stacking context,
      // and a high z-index on this canvas steals pointer events from those layers.
      // Three is inserted before this view with `pointer-events:none`; DOM paint
      // order already keeps PIXI above the WebGL sibling without beating Foundry UI.
    }
    syncV3FoundryGameplayPixiSuppression(canvas);

    const pixiAlpha = readV3PixiContextHasAlpha(canvas);
    if (pixiAlpha === false) {
      warn(
        "Foundry PIXI WebGL context has alpha:false — cleared PIXI pixels may not show the Three canvas underneath. " +
          "The module registers canvasConfig at load with backgroundAlpha:0 and transparent:true (v13 parity). " +
          "Do a full page reload (F5) after enabling V3 so PIXI.Application is recreated; check V3Shine.diag().pixiContextAlpha.",
      );
    }

    if (stopFoundryTicker && ticker?.stop) {
      ticker.stop();
      restore.weStoppedTicker = true;
      log("Foundry PIXI ticker stopped (setting enabled)");
    } else {
      log("Foundry PIXI ticker left running; Three render piggybacks ticker (UTILITY priority)");
    }
    return restore;
  } catch (err) {
    warn("begin Foundry coexistence failed", err);
    return existing;
  }
}

/**
 * @param {any} canvas
 * @param {V3FoundryCoexistenceRestore|null} restore
 * @param {{ log: Function, warn: Function }} logger
 */
export function restoreV3FoundryCoexistence(canvas, restore, logger) {
  const { log, warn } = logger;
  if (!restore || !canvas?.app) return;
  try {
    const view = canvas.app.view;
    if (view) {
      view.style.visibility = restore.viewVisibility || "";
      view.style.pointerEvents = restore.viewPointerEvents || "";
      view.style.opacity = restore.viewOpacity || "";
      view.style.zIndex = restore.viewZIndex || "";
    }
    const spr = canvas.primary?.sprite;
    if (spr) {
      spr.renderable = restore.primarySpriteRenderable;
      spr.visible = restore.primarySpriteVisible;
    }

    try {
      const rb = canvas.app?.renderer?.background;
      const a = restore.rendererBackgroundAlpha;
      if (rb && typeof rb.alpha === "number" && typeof a === "number" && Number.isFinite(a)) {
        rb.alpha = a;
      }
    } catch (_) {}

    try {
      if (canvas.weather) canvas.weather.visible = restore.weatherWasVisible !== false;
    } catch (_) {}

    try {
      if (canvas.background) canvas.background.visible = restore.canvasBackgroundWasVisible !== false;
    } catch (_) {}

    try {
      if (canvas.effects) canvas.effects.visible = restore.effectsWasVisible !== false;
    } catch (_) {}

    try {
      const vis = canvas.visibility;
      if (vis) {
        vis.visible = restore.visibilityWasVisible !== false;
        if (vis.filter) vis.filter.enabled = !!restore.visibilityFilterWasEnabled;
        if (vis.vision) vis.vision.visible = restore.visibilityVisionWasVisible !== false;
        if (Array.isArray(vis.children)) {
          for (const ch of vis.children) {
            if (ch && typeof ch.visible !== "undefined") ch.visible = true;
          }
        }
      }
    } catch (_) {}

    try {
      if (canvas.fog) canvas.fog.visible = restore.fogWasVisible !== false;
    } catch (_) {}

    try {
      const p = canvas.primary;
      if (p) {
        if (p.background) p.background.visible = true;
        if (p.foreground) p.foreground.visible = true;
        if (p.tiles) p.tiles.visible = true;
        if (Array.isArray(p.levelTextures)) {
          for (const lt of p.levelTextures) {
            if (lt) lt.visible = true;
          }
        }
        if (p.tokens && typeof p.tokens.forEach === "function") {
          p.tokens.forEach((/** @type {any} */ mesh) => {
            if (mesh && typeof mesh.alpha === "number") mesh.alpha = 1;
          });
        }
      }
    } catch (_) {}

    try {
      const placeables = canvas.tokens?.placeables;
      if (placeables) {
        for (const token of placeables) {
          if (!token) continue;
          try {
            if (token.mesh && typeof token.mesh.alpha === "number") token.mesh.alpha = 1;
            if (token.texture && typeof token.texture.alpha === "number") token.texture.alpha = 1;
            if (Array.isArray(token.children)) {
              for (const ch of token.children) {
                if (ch && typeof ch.alpha === "number") ch.alpha = 1;
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    try {
      const tps = canvas.tiles?.placeables;
      if (tps) {
        for (const tile of tps) {
          if (!tile) continue;
          try {
            if (tile.mesh && typeof tile.mesh.alpha === "number") tile.mesh.alpha = 1;
            if (tile.texture && typeof tile.texture.alpha === "number") tile.texture.alpha = 1;
            if (Array.isArray(tile.children)) {
              for (const ch of tile.children) {
                if (ch && typeof ch.alpha === "number") ch.alpha = 1;
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    if (restore.weStoppedTicker && restore.tickerWasStarted && canvas.app.ticker?.start) {
      canvas.app.ticker.start();
    }
    log("Foundry native view / ticker restore complete");
  } catch (err) {
    warn("restore Foundry rendering failed", err);
  }
}
