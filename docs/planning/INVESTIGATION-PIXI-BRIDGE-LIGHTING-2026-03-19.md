# Investigation: PIXI Bridge & Lighting Failures — 2026-03-19

## Status: FIXES IMPLEMENTED — AWAITING RUNTIME VALIDATION

## Symptoms Reported
1. **Lighting not working correctly** — light icons/controls non-functional
2. **PIXI bridge offline** — drawings, notes, templates not rendering through bridge composite

---

## Root Cause Map

### RC-1: LightIconManager / EnhancedLightIconManager classes deleted from codebase

**Severity: CRITICAL**

The class files for `LightIconManager` and `EnhancedLightIconManager` have been removed
from the codebase entirely. No files matching `*light*icon*manager*` or `*light-icon*`
exist under `scripts/`.

However, **170+ references** across 9 files still reference these managers:
- `scripts/scene/interaction-manager.js` — 100 references
- `scripts/foundry/canvas-replacement.js` — 25 references
- `scripts/scene/light-interaction.js` — 20 references
- `scripts/foundry/controls-integration.js` — 9 references
- `scripts/foundry/mode-manager.js` — 6 references
- `scripts/core/scene-context.js` — 5 references
- `scripts/foundry/manager-wiring.js` — 3 references
- `scripts/settings/scene-settings.js` — 1 reference
- `scripts/ui/tweakpane-manager.js` — 1 reference

All consumers use optional chaining (`?.setVisibility`, `?.lights?.has`) so they
silently no-op rather than throwing. This means:
- **No Three.js light icons can ever render**
- **No Three.js light interaction (select/drag/edit) can work**
- **Light placement previews are broken**
- **Radius gizmos and translate handles are dead**

### RC-2: Permanent manager nullification in canvas-replacement.js

**Severity: CRITICAL** — `canvas-replacement.js:4321-4329`

```js
// Drawings ownership test mode:
drawingManager = null;
noteManager = null;
templateManager = null;
lightIconManager = null;
enhancedLightIconManager = null;
soundIconManager = null;
```

Six managers are permanently set to `null` after the bridge is initialized. The comment
says "Drawings ownership test mode" suggesting this was temporary, but it's the
current permanent state. Even if the class files existed, the managers would never be
instantiated.

**Downstream propagation of null:**
- `InteractionManager` (line 4377) receives `null` for lightIconManager and soundIconManager
- `ModeManager` (lines 4630-4631) receives `null` for both light icon managers
- `window.MapShine` (lines 4747-4750) exposes `null` managers globally
- `ControlsIntegration._updateThreeGizmoVisibility()` reads `null` from `window.MapShine`

### RC-3: PIXI bridge replay-only mode skips non-drawing content

**Severity: HIGH**

In gameplay mode (token layer active), bridge strategy = `'replay-only'`.

The `_renderReplayCapture()` method (line 1048) **only captures drawings**. It iterates
`drawingsLayer.placeables` exclusively.

In replay-only/replay-shape mode (lines 2181-2202), if replay succeeds, the bridge
returns immediately:

```js
if (captureStrategy === 'replay-only' || captureStrategy === 'replay-shape') {
  if (replayResult.ok) {
    // Returns here — never checks hasNonDrawingUiContent
    this._lastUpdateStatus = `${replayResult.status}`;
    this._dirty = false;
    return;
  }
}
```

**Result:** Notes, templates, sounds, regions, and lighting content that exists on the
scene are **never captured** in gameplay mode. They only get captured when their
respective editing contexts are active (which changes the strategy away from replay-only).

Meanwhile, `_enforceGameplayPixiSuppression` sets the PIXI canvas to `opacity: 0`
when `shouldPixiReceiveInputEffective` is false (i.e., gameplay/token mode). So these
elements can't show through PIXI either.

**Impact:** Journal notes and measured templates that should be persistently visible
on the scene are invisible in V2 gameplay mode.

### RC-4: Missing lighting context in _enforceGameplayPixiSuppression fallback

**Severity: LOW** (mitigated by InputRouter)

`_enforceGameplayPixiSuppression` at line 6810-6812:
```js
const pixiEditContextFallback =
  tilesEditContext || drawingsEditContext || soundsEditContext
  || templatesEditContext || notesEditContext || regionsEditContext;
```

Lighting is NOT included. However, `InputRouter.determineMode()` (line 481) correctly
routes lighting to `InputMode.PIXI`, so `shouldPixiReceiveInput` returns `true` for
lighting. This means `shouldPixiReceiveInputEffective` is true, and lighting gets the
editor overlay path.

This gap only matters during transient states when `InputRouter` hasn't updated yet
after a control switch. Adding lighting to the fallback would close this race window.

### RC-5: Bridge replayEmptyWithDrawingsPresent fallback logic (previous session fix)

**Severity: MEDIUM**

The fix from the previous session added fallback logic for when replay returns empty
while drawings are present. However, this fix only engages when `replayCount <= 0`
AND `drawingsPresent` is true. If there are no drawings on the scene but there ARE
notes/templates, this fallback doesn't help — the replay returns `ok: true, count: 0`
and the bridge early-returns without capturing notes/templates.

### RC-6: LightInteractionHandler references null lightIconManager

**Severity: HIGH** — `scripts/scene/light-interaction.js`

`LightInteractionHandler` accesses `this._im.lightIconManager` which is `null`.
Methods like `getSelectedLight()`, `getSelectedLightWorldPos()`,
`updateSelectedLightOutline()` all reference `this.lightIconManager?.lights?.has()`
which silently returns `undefined`/`false`.

**Impact:** Even if PIXI light icons render, Three.js light interaction (select,
drag, radius edit) is completely non-functional because all light queries return
empty/null.

---

## PIXI Bridge Execution Trace (Gameplay Mode)

```
FloorCompositor.render()
  → bridge.update()
    → strategy = 'replay-only' (token layer active)
    → _renderReplayCapture(drawingsLayer, ...)
      → iterates drawingsLayer.placeables ONLY
      → returns { ok: true, count: N, status: ... }
    → lines 2181-2202: replay ok → EARLY RETURN
      ⚠️ Never checks hasNonDrawingUiContent
      ⚠️ Notes/templates/sounds never captured
    → worldTexture updated with drawings only
  → _compositePixiWorldOverlay(inputRT)
    → reads bridge.getWorldTexture()
    → composites into RT chain
    → Result: only drawings appear in final frame
```

## PIXI Bridge Execution Trace (Lighting Context Active)

```
FloorCompositor.render()
  → bridge.update()
    → strategy = 'stage-extract' (lighting active)
    → _renderReplayCapture(drawingsLayer, ...) → drawings captured
    → hasLightingUiContent = true → hasNonDrawingUiContent = true
    → Falls through to stage isolation at line 2393+
    → collectFromLayer(lightingLayer) → collects PIXI light placeables
    → Stage isolation render: force-shows UI shapes, hides everything else
    → PIXI renderer renders to RT → extract to canvas
    → worldTexture updated
  → _compositePixiWorldOverlay(inputRT)
    → Composites bridge output into final frame
    → Result: light icons appear composited into Three.js frame
```

## PIXI Suppression Execution Trace (Gameplay Mode)

```
_enforceGameplayPixiSuppression()
  → shouldPixiReceiveInput = false (InputRouter: THREE mode)
  → pixiEditContextFallback = false (no edit context)
  → hasPersistentPixiOverlays = check notes/templates count
  → needsEditorOverlay = hasPersistentPixiOverlays (if notes/templates exist)
  → IF needsEditorOverlay:
    → pixiVisualOpacity = '0' (not in edit context)
    → PIXI canvas: visible but opacity 0 → invisible
    → ⚠️ Notes/templates can't show through PIXI AND bridge doesn't capture them
  → ELSE:
    → PIXI canvas: display:none
```

---

## Affected File Index

| File | Impact | Issue |
|------|--------|-------|
| `scripts/foundry/canvas-replacement.js:4321-4329` | CRITICAL | Manager nullification |
| `scripts/foundry/canvas-replacement.js:6810-6812` | LOW | Missing lighting in suppression fallback |
| `scripts/foundry/pixi-content-layer-bridge.js:2181-2202` | HIGH | Replay-only early return skips non-drawing content |
| `scripts/scene/light-interaction.js` | HIGH | All methods reference null lightIconManager |
| `scripts/scene/interaction-manager.js` | HIGH | 100 references to null managers |
| `scripts/foundry/controls-integration.js:349-377` | MEDIUM | Gizmo visibility reads null managers |
| `scripts/foundry/mode-manager.js:474-485` | MEDIUM | Light icon visibility reads null managers |

---

## Fix Plan

### Fix 1: Bridge — Capture notes/templates in gameplay mode
**File:** `pixi-content-layer-bridge.js`

In replay-only mode, after successful replay, check `hasNonDrawingUiContent`. If
non-drawing content exists, do NOT early-return — instead fall through to stage
isolation to capture all content.

### Fix 2: Suppression — Add lighting to edit context fallback
**File:** `canvas-replacement.js`

Add `lightingEditContext` to `pixiEditContextFallback` to close the transient race
window.

### Fix 3: Bridge — Ensure lighting layer is visible during capture
**File:** `pixi-content-layer-bridge.js`

Already handled by `__bridgeCaptureActive` flag and force-visibility in stage
isolation path. Verify this works correctly.

### Fix 4: Dead code cleanup (deferred)
The 170+ references to deleted LightIconManager/EnhancedLightIconManager are dead
code. Since light interaction is currently PIXI-owned (InputRouter routes lighting
to PIXI), the Three.js light interaction code is dormant. Full cleanup is a separate
task.

---

## Fixes Implemented

### Fix 1: RC-3 — Bridge replay-only now falls through for non-drawing content
**File:** `scripts/foundry/pixi-content-layer-bridge.js`

Moved `hasNonDrawingUiContent` computation ABOVE the replay-only early-return gate.
When non-drawing content (notes, templates, sounds, regions, lighting) exists on
the scene, replay-only no longer early-returns. Instead it falls through to the
stage-isolation path which collects from ALL layers and renders them to the bridge
texture.

Additionally added a retry guard at the `uiShapes.size === 0` gate: when
`hasNonDrawingUiContent` is true but placeables aren't extractable yet (transient
layer churn), the bridge preserves the last valid texture and retries instead of
publishing a blank overlay.

### Fix 2: RC-4 — Lighting added to suppression fallback context
**File:** `scripts/foundry/canvas-replacement.js`

Added `lightingEditContext` detection and included it in `pixiEditContextFallback`.
This closes the transient race window where `InputRouter` hasn't updated yet after
switching to the lighting tool, ensuring the PIXI canvas remains visible during the
transition.

### Fix 3: Previous session — Lighting awareness in bridge
**File:** `scripts/foundry/pixi-content-layer-bridge.js`

(From previous session) Added:
- `createAmbientLight`/`updateAmbientLight`/`deleteAmbientLight`/`activateLightingLayer` hooks
- `_isLightingContextActive()` method
- `stage-extract` strategy routing for lighting context
- `lightingLayer` collection in default stage-isolation path
- `hasLightingUiContent` flag

### Not Fixed (Architecture Decisions)

**RC-1 / RC-2:** `LightIconManager` and `EnhancedLightIconManager` classes don't exist.
The manager variables are permanently `null`. This is an architectural state — lighting
icons are currently PIXI-native (routed by InputRouter to PIXI mode). The bridge
captures PIXI lighting placeables when the lighting tool is active. Three.js light
interaction code (170+ references) is dead code. Full cleanup is a separate task.

---

## Validation Checklist

- [ ] Drawings render in gameplay mode (token layer active)
- [ ] Journal notes render in gameplay mode
- [ ] Measured templates render in gameplay mode
- [ ] Light icons show when switching to Lighting tool
- [ ] Light icons are interactive (PIXI-driven) when Lighting tool active
- [ ] Sound icons show when switching to Sounds tool
- [ ] Region overlays show when switching to Regions tool
- [ ] No duplicate/ghost rendering from PIXI+Three conflict
- [ ] Performance: no per-frame thrashing in bridge capture
