# Selective PIXI Layer Hybrid Implementation (Foundry V12)

## Goal

Move from "hide all PIXI output" to "hide only PIXI scene-bearing visuals" so Foundry-native non-scene layers remain available and module-compatible while Three.js keeps authority over scene presentation.

## Strategy

- Keep PIXI/board canvas present and composited above Three in gameplay.
- Suppress scene-bearing PIXI visuals surgically (background/grid/primary scene visuals/tokens/fog/visibility).
- Preserve non-scene native layers and editor overlays (drawings/templates/notes/sounds/regions/controls) for compatibility.
- Keep Three.js as default input/render authority except when InputRouter explicitly routes to PIXI.

## What Changed

### `scripts/foundry/canvas-replacement.js`

- Updated `_enforceGameplayPixiSuppression()`:
  - keeps `canvas.app.view` and `#board` visible (`pointer-events:none`, transparent background, z-index managed).
- Kept existing surgical layer suppression for scene visuals and token visual suppression.
- Updated teardown comments to reflect selective vs legacy suppression behaviors.

### `scripts/foundry/input-router.js`

- In `InputMode.THREE`, no longer forces `#board` to `display:none`.
  - board remains visible/passthrough.
- Reasserted PIXI canvas visibility in THREE mode so selective overlays are not accidentally stranded hidden by stale legacy styles.

## Compatibility Notes

### V12+ API: `canvas.grid` is **not** the GridLayer

`canvas.grid` resolves to the Scene’s **BaseGrid** (snapping / geometry). The PIXI **GridLayer** lives at **`canvas.interface.grid`**. Code that toggled `canvas.grid.visible` was mutating the wrong object; use `getConfiguredCanvasLayer('grid')` from `scripts/foundry/canvas-layer-resolve.js` (same pattern as Foundry’s `canvas.layers` getter).

### Why template fills may not show “in PIXI” during gameplay

With **`window.MapShine.__useThreeTemplateOverlays !== false`** (default) and **`templateManager`** active, steady-state template **pixels** are owned by **Three** (`TemplateAdornmentManager`). The PIXI **TemplateLayer** may still exist for interaction, but the bridge treats many template pixels as **Three-native** and may skip PIXI world capture for them (`threeTemplatesNative` in `pixi-content-layer-bridge.js`). To force PIXI-side template capture for debugging, try **`window.MapShine.__useThreeTemplateOverlays = false`** (expect possible double-draw until paths are reconciled).

- Foundry effects/visibility systems sample `canvas.primary.renderTexture`; this implementation keeps primary active and hides scene-bearing subcomponents instead of disabling primary group entirely.
- Tokens remain interactable while PIXI token visuals stay hidden via existing alpha strategy.
- Native overlay workflows remain routable through InputRouter, reducing custom interaction reimplementation burden.

## Legacy Cleanup/Contradiction Handling

- Contradiction resolved: THREE mode previously hid board regardless of context; now it respects selective-mode intent.
- Legacy hard-hide board suppression path removed from gameplay flow.

## PIXI vs Three occlusion — loud debug mode

When stacking or WebGL visibility is unclear, enable in the browser console:

```js
window.MapShine.__pixiLayerDebug = true;
```

Effects (re-applied each suppression tick until disabled):

- **`#board`**: fuchsia outline + inset glow, **z-index 60000**
- **`#map-shine-canvas`**: cyan outline, **z-index 1** (should sit under PIXI)
- **PIXI `Graphics`**: semi-transparent magenta fill + thick green stroke over `canvas.dimensions.sceneRect` (world space), on top of the stage; refreshed on the app ticker
- **Renderer background**: slight alpha so a purple wash indicates PIXI is presenting a frame

Disable:

```js
window.MapShine.__pixiLayerDebug = false;
```

Hints are mirrored on `window.MapShine.__pixiLayerDebugHint` while active.

**Console note:** composite status lives on `window.MapShine.__pixiBridgeCompositeStatus` (not a bare `__pixiBridgeCompositeStatus` variable).

## Follow-up Tasks

1. Add a user-facing setting for selective vs legacy suppression (instead of runtime global only).
2. Add debug overlay/telemetry exposing active suppression mode and board visibility state.
3. Expand regression matrix for modules that alter drawings/templates/notes/regions controls.
4. Validate post-processing partitioning (world vs UI overlays) to ensure bloom/blur never touch UI-only channels.

## Default Runtime Policy (current)

- Foundry native PIXI overlays are the default source for template/drawing/note/sound UI visuals.
- Extra PIXI world extraction/composite bridge is disabled by default:
  - `window.MapShine.__usePixiContentLayerBridge = false`
- Three-native template overlay path is disabled by default:
  - `window.MapShine.__useThreeTemplateOverlays = false`

