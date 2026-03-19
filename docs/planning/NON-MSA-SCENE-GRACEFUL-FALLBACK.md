# Non-MSA Scene Graceful Fallback — Audit & Plan

## Problem Statement

When Map Shine Advanced is installed but a scene is **not configured** for it (no `enabled` flag, no authoring data), the module should completely step aside and let Foundry's native PIXI rendering work without interference, performance cost, or visual artifacts.

---

## Current Architecture: What Happens Today

### 1. Scene Enablement Gate ✅ GOOD

The primary activation gate is solid. In `canvas-replacement.js → onCanvasReady()`:

```
if (!sceneSettings.isEnabled(scene)) {
    // → UI-only mode
    return;
}
```

`sceneSettings.isEnabled(scene)` (`scripts/settings/scene-settings.js:208`) checks:
1. Explicit `enabled` flag on scene (`scene.getFlag('map-shine-advanced', 'enabled')`)
2. Implicit authoring data (`hasImpliedMapShineConfig`) — mapMaker settings, mapPointGroups, mapPointGroupsInitialized

**When neither is present → returns `false` → no Three.js canvas is created.**

### 2. UI-Only Mode on Non-MSA Scenes ✅ MOSTLY GOOD

When `isEnabled()` returns false, `onCanvasReady` enters a **UI-only mode** that:
- Creates `TweakpaneManager` (UI panel) — so GMs can configure/enable MSA
- Creates `ControlPanelManager` — control panel available
- Creates `CinematicCameraManager` + `CameraPanelManager` — cinematic features
- Creates `GraphicsSettingsManager` — settings dialog accessible
- Dismisses loading overlay via `loadingOverlay.fadeIn(500)`
- **Does NOT** create: Three.js canvas, SceneComposer, EffectComposer, RenderLoop, any effects, TileManager, TokenManager, etc.

**This is correct behavior — Foundry PIXI renders the scene normally.**

### 3. Teardown: MSA Scene → Non-MSA Scene ✅ GOOD

When navigating from an MSA-enabled scene to a non-MSA scene:
1. `onCanvasTearDown` fires → `destroyThreeCanvas()` runs full disposal:
   - All managers disposed (token, tile, wall, interaction, etc.)
   - Effect composer disposed
   - Three.js canvas DOM element removed
   - `ModeManager.restoreFoundryRendering()` restores all PIXI layers, visibility, opacity, pointer events
   - WebGL context force-released via `forceContextLoss()` (only if canvas was active)
   - Board suppression observer disconnected
   - PIXI ticker hooks removed
2. `onCanvasReady` fires for new scene → enters UI-only mode (see above)

**The transition path is well-handled.**

---

## Identified Concerns & Risks

### 🐛 BUG (FIXED): PIXI Suppression Hooks Survive Teardown → Black Screen on Non-MSA Scenes

**Root Cause:** When an MSA scene loads, `createThreeCanvas()` installs `Hooks.on` listeners
for `sightRefresh`, `controlToken`, `refreshToken`, `updateToken`, `activateCanvasLayer`,
and `renderSceneControls`. Each fires `_enforceGameplayPixiSuppression()` which hides `#board`,
the PIXI canvas, fog, visibility, and primary layers.

During `onCanvasTearDown`, only the PIXI suppression **ticker** was removed. The six
`Hooks.on` registrations stored in `_pixiSuppressionHookIds` were **not** unregistered —
they were only cleaned up at the start of the *next* `createThreeCanvas()` call, which
never runs for a non-MSA scene.

Additionally, `_enforceGameplayPixiSuppression()` checked `isMapMakerMode` but did **not**
check `sceneSettings.isEnabled(scene)`, so it happily suppressed Foundry rendering on any
scene.

**Symptoms:** MSA scene → non-MSA scene transition → permanent black screen. Fresh page
reload works fine because the hooks aren't registered yet.

**Fix (applied):**
1. `onCanvasTearDown` now removes all `_pixiSuppressionHookIds` via `Hooks.off()` before
   calling `destroyThreeCanvas()`.
2. `_enforceGameplayPixiSuppression()` now has an early `isEnabled(canvas?.scene)` guard
   as defense-in-depth.
3. `_updateFoundrySelectRectSuppression()` also got the same guard.

**Files changed:** `scripts/foundry/canvas-replacement.js`

---

### ⚠️ RISK 1: Bootstrap Always Creates a WebGL Renderer (MEDIUM)

**Issue:** `bootstrap()` in `scripts/core/bootstrap.js` always creates a Three.js WebGL renderer (`rendererStrategy.create()`) during the `ready` hook, regardless of whether the current scene needs it.

**Impact:**
- An extra WebGL context is created on page load even for non-MSA scenes
- This context persists in `window.MapShine.renderer` until teardown
- On GPU-constrained systems, this occupies one of the browser's limited WebGL context slots
- The renderer is only disposed during `destroyThreeCanvas()` if `_threeCanvasWasActive` is true — on a non-MSA scene, the renderer is **never disposed** (intentional, for lazy re-use if user navigates to an MSA scene later)

**Severity:** Medium — The idle renderer consumes GPU memory (~10-50MB depending on driver) but doesn't cause functional issues. On systems with WebGL context limits (typically 8-16), it could contribute to context exhaustion if other modules also create contexts.

### ⚠️ RISK 2: Loading Overlay Shown During Init on ALL Scenes (LOW-MEDIUM)

**Issue:** During the `init` hook, `module.js` unconditionally calls:
```javascript
loadingOverlay.showBlack('Initializing...');
```

This shows a black loading overlay **before** the module knows which scene will load. It persists until:
- `canvasReady` fires → UI-only mode dismisses it, OR
- `ready` hook detects no active scene and dismisses it

**Impact:**
- Brief black flash during page load on all scenes (MSA or not)
- If bootstrap is slow (GPU detection, renderer creation), the overlay can be visible for 2-5 seconds
- Users on non-MSA scenes see "Map Shine loading" visuals unnecessarily

**Severity:** Low-Medium — Cosmetic annoyance but not a functional problem. The overlay always gets dismissed.

### ⚠️ RISK 3: Node.prototype Monkey-Patching (LOW)

**Issue:** `module.js → _installGlobalPasswordManagerInsertGuard()` wraps `Node.prototype.appendChild`, `Node.prototype.insertBefore`, `Node.prototype.replaceChild`, and `Element.prototype.insertAdjacentHTML` globally.

**Impact:**
- These wraps run on **every** DOM insertion in the entire page, not just MSA scenes
- Each wrap adds a try/catch + querySelectorAll check for password manager attributes
- Could interact poorly with other modules that also wrap these prototypes

**Severity:** Low — The wraps are lightweight (attribute setting only) and well-guarded with try/catch. But they represent unnecessary global pollution on non-MSA scenes.

### ⚠️ RISK 4: Global Hooks Always Registered (LOW)

**Issue:** Several hooks are registered during `init` that fire on every scene, not gated by enablement:
- `updateScene` — flag watch diagnostic
- `canvasConfig`, `canvasInit`, `drawCanvas`, `preUpdateScene` — corruption diagnostics
- `getSceneControlButtons` — adds MSA tools to scene controls
- `getActorSheetHeaderButtons` — adds movement style button
- `renderTileConfig` — adds MSA tile config UI
- `renderTokenHUD` — password manager guard
- `preUpdateAdventure`, `preCreateAdventure`, `preImportAdventure`, `importAdventure` — adventure flag preservation

**Impact:**
- Minor CPU overhead on every hook invocation
- MSA scene control buttons appear even on non-MSA scenes (this is **intentional** — needed for enabling MSA)
- Adventure hooks run unnecessarily if no MSA scenes exist

**Severity:** Low — All handlers are wrapped in try/catch, lightweight, and most exit quickly when no MSA data is present.

### ⚠️ RISK 5: Diagnostic Console Log Suppression (LOW)

**Issue:** `_suppressDiagConsoleLogs()` wraps `console.log`, `console.warn`, `console.error` globally to filter "Diag #" messages. This runs regardless of scene type.

**Impact:** Every console call goes through an extra filter function. Negligible performance impact but could interfere with debugging other modules if their messages happen to contain "Diag #".

**Severity:** Low.

### ⚠️ RISK 6: MSA→Non-MSA Scene Switch: Stale UI Panels (LOW)

**Issue:** When switching from an MSA scene to a non-MSA scene:
1. `destroyThreeCanvas()` disposes `uiManager`, `controlPanel`, `cameraPanel`
2. `onCanvasReady` UI-only mode recreates them

But there's a gap where the old UI is disposed and new UI is being created. If user interacts during this window, buttons may dead-end.

**Severity:** Low — The gap is typically <100ms.

### ⚠️ RISK 7: `_enforceGameplayPixiSuppression` During Transitions (LOW)

**Issue:** PIXI suppression hooks (`sightRefresh`, `controlToken`, `refreshToken`, etc.) are installed inside `createThreeCanvas()` and only removed during `destroyThreeCanvas()`. They are not active on non-MSA scenes.

**Verified safe:** These hooks are cleaned up in teardown and not re-installed in UI-only mode.

---

## What Works Well ✅

| Area | Status | Notes |
|------|--------|-------|
| Scene enablement gate | ✅ Solid | `isEnabled()` checks flag + implied config |
| UI-only mode | ✅ Solid | Only UI components created, no rendering replacement |
| Three.js canvas lifecycle | ✅ Solid | Only created for enabled scenes, properly removed |
| PIXI restoration on teardown | ✅ Solid | `restoreFoundryRendering()` restores all layers |
| WebGL context management | ✅ Solid | `forceContextLoss()` frees GPU slot on transition |
| PIXI suppression hooks | ✅ Solid | Only installed during MSA scene, cleaned up on teardown |
| Board suppression observer | ✅ Solid | Disconnected during teardown |
| Foundry layer visibility | ✅ Solid | All layers restored to visible on teardown |
| Loading overlay dismissal | ✅ Solid | Always dismissed for non-MSA scenes |
| Token/tile PIXI state | ✅ Solid | Alpha/visibility/interactive restored |

---

## Recommended Improvements

### Priority 1: Defer Renderer Creation (MEDIUM effort, MEDIUM impact)

**Goal:** Don't create the Three.js WebGL renderer until the first MSA-enabled scene is actually loaded.

**Approach:**
- In `bootstrap()`, skip Steps 4-5 (renderer creation, scene creation) entirely
- Set `state.initialized = true` (bootstrap succeeded) but `state.renderer = null`
- In `createThreeCanvas()`, detect null renderer and create it lazily (the lazy bootstrap path already exists: "If MapShine.renderer is null, re-create it")
- This saves a WebGL context slot and ~10-50MB GPU memory on non-MSA worlds

**Risks:** First MSA scene load would be slightly slower (adds renderer creation time). The lazy path already exists and works.

### Priority 2: Skip Loading Overlay on Non-MSA Worlds (LOW effort, LOW impact)

**Goal:** Don't show black loading overlay during init if the world has no MSA-enabled scenes.

**Approach:**
- During `init`, check if `game.scenes` has any scene with MSA flags before showing overlay
- If no MSA scenes exist, skip `loadingOverlay.showBlack()` entirely
- If MSA scenes exist but current scene is non-MSA, show a lighter/shorter overlay

**Risks:** `game.scenes` may not be populated during `init` hook. May need to defer to `ready` hook check. Edge case: world has MSA scenes but user navigates to non-MSA scene first.

### Priority 3: Gate Node.prototype Wraps Behind First MSA Scene (LOW effort, LOW impact)

**Goal:** Only install password manager DOM wraps when an MSA scene is first activated.

**Approach:**
- Move `_installGlobalPasswordManagerInsertGuard()` call from `init` hook to `createThreeCanvas()` (first MSA scene load)
- Keep `_installTokenHudPasswordManagerGuard()` in `renderTokenHUD` hook (already lazy)

**Risks:** Password manager interference could still affect non-MSA token HUDs. The `renderTokenHUD` hook handler already handles this case separately.

### Priority 4: Add `enabled` Flag to Scene Config Header (LOW effort, HIGH UX impact)

**Goal:** Make it obvious and easy for GMs to enable/disable MSA per scene from the scene configuration dialog.

**Approach:**
- Hook `renderSceneConfig` to inject a checkbox at the top of the sheet
- Reads/writes `flags.map-shine-advanced.enabled`
- Visual indicator (icon/badge) on scene navigation bar for MSA-enabled scenes

**Risks:** None — purely additive UI.

### Priority 5: Diagnostic / Smoke Test (NO code, HIGH confidence)

**Goal:** Verify the current fallback behavior works correctly in practice.

**Test matrix:**
| Scenario | Expected | Test |
|----------|----------|------|
| Fresh world, no MSA scenes | Foundry renders normally, no visual artifacts | Navigate scenes |
| World with mix of MSA + non-MSA scenes | Non-MSA scenes render via PIXI, MSA via Three | Switch between scenes |
| MSA scene → non-MSA scene | PIXI fully restored, no stale Three elements | Navigate away from MSA scene |
| Non-MSA scene → MSA scene | Three canvas created, PIXI suppressed | Navigate to MSA scene |
| Non-MSA scene: Foundry tools | All tools work normally (walls, lighting, templates, drawings, notes, regions, tokens) | Use each tool |
| Non-MSA scene: Other modules | No interference from MSA hooks | Test with popular modules |
| Non-MSA scene: Performance | No measurable FPS/memory overhead vs MSA uninstalled | Profile with dev tools |

---

## Summary

**The module currently handles non-MSA scenes quite well.** The core architecture has a solid enablement gate that prevents the Three.js rendering pipeline from activating. The teardown path properly restores Foundry's native rendering. The main areas for improvement are:

1. **Bootstrap renderer eagerness** — an unnecessary WebGL context is created on every page load
2. **Loading overlay flash** — brief black overlay on non-MSA scene loads
3. **Global DOM wrapping** — minor unnecessary overhead

None of these are breaking issues, but addressing P1 and P2 would make the module feel more lightweight and professional on non-MSA scenes.
