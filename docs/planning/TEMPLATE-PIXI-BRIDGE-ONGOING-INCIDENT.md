# Template Placement + PIXI Bridge Ongoing Incident

## Summary
This document tracks the ongoing performance and stability incident around measured templates and PIXI bridge compositing.

Current user-observed status:
- Zoom no longer causes long multi-second freezes, but overall performance remains lower than expected.
- Placing a template still causes an approximately 2-second freeze.
- Switching to the template tool can temporarily cause PIXI bridge content to shrink/shift, then snap back.
- Templates must remain consistently visible (same reliability expectation as drawings).

---

## Current Symptoms (Latest)

1. **Template placement freeze persists**
   - Trigger: dropping/placing measured templates.
   - Severity: high (roughly ~2s stall).
   - Expected: near-instant post-drop continuation.

2. **Template tool activation causes transient overlay transform glitch**
   - Trigger: switching to template tool/layer.
   - Behavior: bridge content briefly shrinks and moves, then restores.
   - Expected: no visible transform jump.

3. **Zoom path improved but baseline perf still lower**
   - Trigger: general play + editing flow.
   - Behavior: fewer catastrophic stalls, but sustained performance remains degraded.

---

## What Was Investigated

### Foundry post-placement lifecycle chain
Confirmed the post-drop path that runs after preview commit:
- `PlaceablesLayer._onDragLeftDrop` -> document `create(...)`
- `ClientDatabaseBackend.#handleCreateDocuments` -> `Hooks.callAll('createMeasuredTemplate', ...)`
- Bridge hook invalidation -> `PixiContentLayerBridge.update()` recapture

Relevant references:
- `foundryvttsourcecode/resources/app/client/canvas/layers/base/placeables-layer.mjs`
- `foundryvttsourcecode/resources/app/client/data/client-backend.mjs`
- `scripts/foundry/pixi-content-layer-bridge.js`

### Bridge hot path identified
Primary expensive work identified in template extraction/replay path:
- `PixiContentLayerBridge._renderFoundryTemplatesReplay(...)`
- High-cost extraction calls in loops (`renderer.extract.canvas(...)`)
- Additional post-dirty follow-up captures amplifying cost bursts

Relevant reference:
- `scripts/foundry/pixi-content-layer-bridge.js`

---

## Changes Attempted So Far

### 1) Reduce template CRUD follow-up recapture burst
**Change:** Measured template hooks use `markDirty(0)` instead of `markDirty(2)`.
- File: `scripts/foundry/pixi-content-layer-bridge.js`
- Area: hook registration (`createMeasuredTemplate`, `updateMeasuredTemplate`, `deleteMeasuredTemplate`)

**Result:**
- Reduced some repeated post-dirty captures.
- Did **not** fully eliminate placement freeze.

### 2) Initial strategy simplification for template context
**Change:** Switched template context from auto `templates-extract` to `replay-only`.
- File: `scripts/foundry/pixi-content-layer-bridge.js`
- Area: `_getCaptureStrategy()`

**Result:**
- Caused major regression: template interaction introduced visible shrink/position issues and poor usability.
- Rolled forward to a refined split strategy.

### 3) Refined template strategy: preview vs settled
**Change:**
- Added `_isTemplatesPreviewInteractive(...)`
- Use `templates-extract` only while live preview is active.
- Use `replay-only` for settled/non-preview template context.
- File: `scripts/foundry/pixi-content-layer-bridge.js`

**Result:**
- Better than broad `replay-only` approach.
- Still not fully stable: transient shrink/shift can still occur on tool switch.
- Post-placement freeze still reproducible.

### 4) Camera sync hardening during bridge capture
**Change:** Added bridge-capture guards in unified camera sync to ignore temporary stage transform mutations during extraction:
- `_isBridgeCaptureActive()` helper
- early returns in `syncFromPixi`, `update`, and `canvasPan` hook callback
- File: `scripts/foundry/unified-camera.js`

**Result:**
- Improved zoom/tool-switch behavior.
- Reduced long zoom freezes.
- Did not fully remove transient template-tool transform jump.

### 5) Zoom recapture gating restored/refined
**Change:** Added `_shouldRecaptureOnZoom()` and gated `_markDirtyForZoomIfNeeded(...)` so expensive zoom-settle recapture only runs in preview/edit contexts.
- File: `scripts/foundry/pixi-content-layer-bridge.js`

**Result:**
- Significant improvement in zoom freeze severity.
- General performance remains below target.

---

## Deep System Investigation (Mar 2026)

### Pipeline Architecture (Current)

The bridge `update()` is called **once per compositor frame** from `FloorCompositor.render()` (`scripts/compositor-v2/FloorCompositor.js` line ~1679). The full data flow for every template capture is:

```
PIXI renders object → GPU (RenderTexture)
  → renderer.extract.canvas(RT)  [GPU → CPU readback, gl.readPixels STALL]
  → ctx.drawImage(capturedCanvas) [CPU canvas blit]
  → THREE.CanvasTexture.needsUpdate = true [CPU → GPU re-upload]
  → _compositePixiWorldOverlay() samples texture in Three.js compositor
```

This means **every bridge capture involving templates is a full GPU→CPU→GPU round-trip** — the most expensive operation possible in WebGL.

---

### Root Cause Analysis: Template Placement Freeze (~2s)

**Exact execution path after `createMeasuredTemplate` hook fires:**

1. `markDirty(0)` → `_dirty = true`, `_postDirtyCapturesRemaining = 0`
2. Next frame in `update()`:
   - `_isTemplatesContextActive()` = `true` (template layer active)
   - `_isTemplatesPreviewInteractive()` = `false` (preview was cleared after drop)
   - Strategy = `replay-only`
   - `hasTemplatesUiContent = true` (newly persisted template)
   - `hasNonDrawingUiContent = true` → `shouldCompositeReplayUnderStage = true`
3. Falls into `fallback:non-drawing-content strategy=replay-only`
4. **Stage isolation path executes:**
   - Saves transform of `canvas.stage` (position, scale, pivot, skew, rotation)
   - Iterates and saves/hides every direct child of `stageRoot`
   - Iterates every shape parent container (typically `canvas.primary`, `canvas.interface`), saves/hides all non-UI siblings
   - Disables masks and filters on the entire ancestor chain + all UI shapes
   - Sets `stageRoot.position=(0,0)`, `stageRoot.scale=(uiRenderScale, uiRenderScale)`, `stageRoot.pivot=(0,0)`
   - Calls `renderer.render(stageRoot, tempRT, true)` — **full PIXI re-render of scene**
   - Calls `extract.canvas(tempRT, frame)` — **synchronous `gl.readPixels()` stall, blocking entire thread**
   - Restores all state in `finally` block

For a typical 4096×4096 map with `uiRenderScale = 0.25` (capped at `MAX_UI_RT_DIM=1024 / 4096`), the scratch RT is 1024×1024. The `gl.readPixels` call reads 4MB of RGBA pixel data synchronously, stalling the GPU pipeline for 100-500ms depending on GPU queue depth. On top of this, the stage mutation and restore loop iterates through every display object in `canvas.primary`/`canvas.interface`, which can be hundreds of items on complex scenes.

**Total stall budget:**
- Stage mutation + PIXI object loop: ~5–30ms
- `renderer.render()` on full scene: ~10–80ms  
- `gl.readPixels` GPU stall: ~100–500ms (main culprit)
- CPU canvas `drawImage` + THREE re-upload: ~5–20ms
- Total: **~200–600ms per frame** = the ~2s total across the post-dirty follow-up captures

---

### Root Cause Analysis: `_renderFoundryTemplatesReplay` Extraction Cost

When strategy is `templates-extract` (live preview active), `_renderFoundryTemplatesReplay` iterates up to **9 sub-object candidates per template**: `template`, `field`, `template.template`, `template.shape`, `template.highlight`, `template.frame`, `template.controlIcon`, `template.ruler`, `template.rulerText`. For each candidate that passes the bounds check, it calls `renderer.extract.canvas(target, frame)` — another full GPU readback per sub-object. A circle template at 30ft radius represents a ~500×500px GPU readback. Multiple templates × multiple candidates = cascading GPU stalls even during normal drag preview.

---

### Root Cause Analysis: Tool-Switch Transform Glitch

**Exact sequence when switching to template tool:**

1. `activateTemplateLayer` hook fires → `markDirty(2)` (2 follow-up captures queued)
2. `_isTemplatesContextActive()` = `true` immediately
3. `_isTemplatesPreviewInteractive()` = `false` (no preview yet)
4. Strategy = `replay-only`
5. `hasTemplatesUiContent = true` (templates on scene or layer active flag)
6. `hasNonDrawingUiContent = true` → falls into stage isolation path
7. Stage isolation sets: `stageRoot.scale.set(uiRenderScale, uiRenderScale)` where `uiRenderScale` for a large map = `0.25`

**The glitch mechanism — canvas size oscillation:**

- Before activation: world canvas was sized to `captureLogicalW × captureScale ≈ 4096 × 0.49 = 2048px`
- Stage isolation captures at `uiRtW × uiRtH = 4096 × 0.25 = 1024px`
- `capturedCanvas.width = 1024`, `_worldCanvas.width = 2048` → mismatch triggers:
  ```javascript
  this._worldCanvas.width = w;   // resizes to 1024
  this._recreateTexture('world'); // disposes old texture, creates NEW blank texture
  ```
- The new blank THREE.CanvasTexture samples as transparent for **one compositor frame** → visible pop/shift
- On the next frame, replay path runs, resizes canvas back to `~2048` → another `_recreateTexture` → another blank frame
- This canvas size oscillation repeats across the 2 queued follow-up captures from `markDirty(2)`

**Secondary mechanism — mask/filter disable side effects:**

The stage isolation disables `node.mask`, `node.filters`, `node.filterArea` on the entire ancestor chain. Foundry uses masks heavily on `canvas.primary` to clip content to scene bounds. After restoration, some PIXI containers may repaint their next frame with slightly different cull/clip state, causing a one-frame visual discontinuity in the PIXI-visible portion of the output.

---

### Root Cause Analysis: Sustained Performance Degradation

Any gameplay mode where templates exist on the scene keeps `hasTemplatesUiContent = true`. When `replay-only` falls through to `fallback:non-drawing-content`, the stage isolation path runs for EVERY dirty/follow-up capture window. This includes:

- Every drawing CRUD event (1 follow-up capture each)
- Every time another hook fires `markDirty(N)` during active play
- Recovery retries (every 1200ms when last status includes `replay-empty`)
- The startup drawings bootstrap path (2 extra captures on canvas ready)

Each of these hits the full GPU readback path because `hasNonDrawingUiContent` is true. Even with throttling, this keeps baseline performance lower than drawing-only scenes.

---

### Systems Involved

| System | File | Role | Problem |
|---|---|---|---|
| `PixiContentLayerBridge` | `scripts/foundry/pixi-content-layer-bridge.js` | Capture PIXI content → THREE texture | Stage mutation, GPU readback, canvas size oscillation |
| `FloorCompositor` | `scripts/compositor-v2/FloorCompositor.js` | Calls `bridge.update()` per frame; composites overlay | Orchestrates the hot path |
| `UnifiedCameraController` | `scripts/foundry/unified-camera.js` | PIXI↔Three camera sync | `__bridgeCaptureActive` guard prevents camera desyncs during capture; works correctly |
| `MeasuredTemplate` (Foundry) | `foundryvttsourcecode/.../template.mjs` | PIXI placeable with `template`, `field`, `ruler`, etc. sub-objects | 9 extractable children per template = many GPU readbacks |
| `TemplateLayer` (Foundry) | `foundryvttsourcecode/.../templates.mjs` | Layer that holds template placeables | `objects.visible = true` in `_deactivate()` — templates always visible |
| PIXI `renderer.extract.canvas()` | Foundry runtime | GPU→CPU pixel readback | Synchronous `gl.readPixels`, always stalls |
| `THREE.CanvasTexture` | Three.js | CPU canvas → GPU texture | Re-upload on `needsUpdate`, sensitive to canvas dimension changes |

---

## Revised Working Hypotheses

### Hypothesis 1 — Freeze: `gl.readPixels` is the primary stall
The ~2s freeze is dominated by one or more synchronous `gl.readPixels` calls inside `renderer.extract.canvas()`. This is unavoidable with the current architecture: any path that calls `extract.canvas()` will stall the GPU pipeline. For a 1024×1024 RT on a mid-range GPU under load, a single readback = 100-400ms. Multiple templates with multiple candidates during `templates-extract` multiply this cost.

### Hypothesis 2 — Glitch: canvas size oscillation between capture strategies
The world canvas resizes when switching between the replay-scale path (~2048px for 4096-wide map) and the stage-isolation path (~1024px for the same map). Each resize calls `_recreateTexture` which creates a fresh blank THREE.CanvasTexture. The compositor samples a transparent texture for one or two frames, producing the visible "shrink and snap back" artifact.

### Hypothesis 3 — Sustained cost: `hasNonDrawingUiContent` triggers isolation path every dirty cycle
Templates existing on the scene permanently routes `replay-only` frames through the expensive stage-isolation fallback. This is the correct path for rendering template visuals but the underlying cost (GPU readback) makes it unsuitable as a per-dirty-cycle operation during gameplay.

### Hypothesis 4 — The architecture is not fit for settled template rendering
Templates, once placed, have stable visual geometry that can be reconstructed entirely from document data (type, position, distance, angle, direction, colors). The current extraction-based approach treats them the same as dynamically rendered PIXI content, incurring GPU readback costs even when nothing has changed. Drawings already solve this with `_renderReplayCapture` — a zero-GPU Canvas2D replay from doc data.

---

## Alternative Approaches Considered

### Alt 1: Template Canvas2D Document Replay (Highest Priority, Lowest Risk)

Mirror `_renderReplayCapture` for templates. `MeasuredTemplateDocument` exposes all geometry needed: `t` (type: circle/cone/rect/ray), `x`, `y`, `distance`, `angle`, `direction`, `borderColor`, `fillColor`, `borderAlpha`, `fillAlpha`. Reconstruct each shape in Canvas2D:

- **circle**: `ctx.arc(x, y, r, 0, Math.PI*2)` — trivial
- **cone**: sector path from `(x,y)`, spanning `direction ± angle/2` to radius `r`
- **rect**: rotated rectangle path in world space
- **ray**: line segment with width

Benefits:
- **Zero GPU operations** for settled templates — same performance characteristics as drawings
- **No stage mutation** → no transform glitch
- **No canvas size oscillation** — same path as `_renderReplayCapture`, same canvas size
- Fully deterministic output from document state
- `templates-extract` (GPU path) retained for live preview drag only — same as current, just a much narrower window

Limitation: custom template rendering from game systems (e.g. PF2e template highlight tinting via flags) would not appear — only base geometry. Content signature caching (`_lastReplayDocsSig`) would skip re-draw when nothing changes.

### Alt 2: Static Settled Snapshot Cache (Medium Priority)

After any `createMeasuredTemplate`, `updateMeasuredTemplate`, or `deleteMeasuredTemplate` event, run ONE expensive capture to build an `ImageBitmap` snapshot of the current settled state, and cache it. On subsequent frames where no mutation occurred, blit the cached `ImageBitmap` directly to the world canvas — zero GPU cost. Only invalidate on actual CRUD events.

This converts the current "expensive every dirty cycle" pattern to "expensive once per mutation, free every frame after." The existing dirty flag already identifies mutation windows; just extend it to a cache rather than per-frame re-extraction.

### Alt 3: Per-Object Off-Screen Extraction (Medium Risk)

Instead of mutating the main `canvas.stage` to create an isolated world-space render, render each target display object into its **own small off-screen RenderTexture** sized to that object's `getBounds()`. This avoids all main-stage transform mutation and thus eliminates the transform glitch entirely. The per-object RTs are assembled via Canvas2D `drawImage` with world-space offset from `getBounds().x/y`.

Only one GPU readback per distinct display object that changed (tracked by position/scale/rotation hash). Objects that haven't moved since last capture reuse cached pixels.

Limitation: still uses GPU readback per object; reduces cost proportionally to scene complexity but doesn't eliminate it.

### Alt 4: Shared WebGL Context / Direct Texture Sharing (Highest Performance, Highest Risk)

If Three.js were initialized using the same WebGL context as PIXI's renderer (same `<canvas>` or via context sharing), PIXI `RenderTexture`s would be directly addressable as Three.js textures — no CPU round-trip at all. The capture would reduce to: PIXI renders UI pass to RT → Three.js shader samples that RT's WebGL texture directly.

Cost: architectural change to renderer initialization order. Requires that Three.js and PIXI co-exist on the same GL context, which has implications for depth buffer sharing, scissor/viewport state, etc. Feasible but invasive.

### Alt 5: CSS/HTML Overlay for Templates (Specialized, Clean)

Since templates are pure vector geometry, render them as absolutely-positioned `<svg>` or `<canvas>` elements overlaid on the Three.js canvas. Camera sync: update the SVG's CSS transform to match the Foundry canvas camera (same matrix that PIXI uses). When camera pans/zooms, one `transform: matrix(...)` CSS property update keeps templates in sync — zero GPU work per frame.

Completely decoupled from both PIXI and Three.js rendering. No bridge needed for templates at all. Templates rendered via native SVG are also crisper and resolution-independent.

Limitation: high integration complexity, especially for system-specific template rendering (custom colors, shapes, icons set by game systems).

---

## New Field Findings (Mar 20, 2026)

### Reported Runtime Behavior

- Switching to the **template tool** still causes a long interface freeze.
- Switching to the **drawing tool** shows the same class of freeze.
- Global performance remains degraded (~45 FPS vs previous ~120 FPS baseline).

### Follow-up Code Investigation

1. **Tool switches currently queue expensive captures from multiple hooks**
   - `activateDrawingsLayer` triggers `markDirty(1)`.
   - `activateTemplateLayer` triggers `markDirty(2)`.
   - `renderSceneControls` also triggers `markDirty(1)` and commonly fires around tool swaps.
   - Net effect: one UI interaction can enqueue multiple dirty/follow-up captures before the scene settles.

2. **`replay-only` still falls through to stage isolation for broad non-drawing content**
   - The replay-only early return is bypassed whenever `hasNonDrawingUiContent` is true.
   - `hasNonDrawingUiContent` includes these checks even when their layers are not actively being edited:
     - `!!lightingLayer?.placeables?.length`
     - `!!notesLayer?.placeables?.length`
     - `!!soundsLayer?.placeables?.length`
     - template/region presence checks
   - In practical scenes, one ambient light or note is enough to force stage isolation on dirty captures.

3. **Why drawing-tool switch freezes too (not just templates)**
   - Drawing-tool activation (`markDirty(1)`) enters replay path for drawings.
   - If any non-drawing overlay is present (lights/notes/sounds/templates/regions), replay path falls through into stage isolation.
   - Stage isolation still performs the expensive `renderer.extract.canvas(...)` readback path.
   - Therefore both template and drawing tool switches can freeze for the same reason.

4. **Why the prior template-doc replay fix was not sufficient by itself**
   - Settled template doc replay removed one major source of template-specific extraction.
   - But stage isolation is still entered due to *other* non-drawing content predicates and tool-switch dirty bursts.
   - So user-visible freeze can remain severe even after template replay improvements.

### Updated Hypothesis for FPS Regression

The sustained FPS drop is now likely from a combination of:

- broad dirty invalidation during UI/tool interactions (`activate*Layer` + `renderSceneControls`), and
- expensive stage-isolation capture fallback still running whenever any non-drawing placeables exist.

This makes the bridge do high-cost GPU readback work more often than intended in normal play.

---

## Foundry VTT Source-Backed Evidence

This section ties the incident behavior directly to Foundry internals from `foundryvttsourcecode`.

### A) Why `renderSceneControls` can fire during tool/layer switching

Foundry `ApplicationV2` dispatches render hooks as `render{ClassName}` by default:

- `Application._doEvent(..., hookName: "render")` and `#callHooks` appending class name placeholders (`render{}`) and calling `Hooks.callAll` for each class in inheritance chain.
- For `SceneControls`, this becomes `renderSceneControls`.

Evidence:
- `resources/app/client/applications/api/application.mjs`:
  - render lifecycle hook dispatch (`hookName: "render"`)
  - `#callHooks` dynamic class hook naming via `hookName += "{}"`

Implication for bridge:
- Our bridge listens to `renderSceneControls` and calls `markDirty(1)`.
- Tool UI transitions in Foundry can therefore enqueue bridge recaptures even before placeable state settles.

### B) Tool switch activates layers and emits activation hooks synchronously

Foundry `SceneControls.activate()` runs pre/post activation callbacks. When control/tool changes:

1. previous control/tool callbacks are run,
2. control/tool state is updated,
3. post-activate callbacks run.

Layer activation path:

- `InteractionLayer.activate()`:
  - deactivates all other interaction layers,
  - calls `ui.controls.activate({control, tool})` if needed,
  - calls layer `_activate()`, then emits:
    - `Hooks.callAll("activate{LayerName}")`
    - `Hooks.callAll("activateCanvasLayer")`

Evidence:
- `resources/app/client/applications/ui/scene-controls.mjs`
- `resources/app/client/canvas/layers/base/interaction-layer.mjs`

Implication for bridge:
- Our hooks `activateDrawingsLayer` and `activateTemplateLayer` are on the hot switch path by design.
- With current follow-up counts (`1` and `2`) and additional `renderSceneControls`, a single tool switch can create a dirty burst.

### C) Drawings/Templates scene controls force refresh across all placeables

Foundry layer scene controls define:

- Drawings: `onToolChange: () => canvas.drawings.setAllRenderFlags({refreshState: true})`
- Templates: `onToolChange: () => canvas.templates.setAllRenderFlags({refreshState: true})`

And `PlaceablesLayer.setAllRenderFlags(flags)` loops every placeable and sets flags.

Evidence:
- `resources/app/client/canvas/layers/drawings.mjs`
- `resources/app/client/canvas/layers/templates.mjs`
- `resources/app/client/canvas/layers/base/placeables-layer.mjs`

Implication for bridge:
- Tool switch is not a no-op in Foundry; it pushes broad refreshState work.
- Even if template/doc replay is cheap, the surrounding layer refresh churn still increases capture pressure.

### D) Template creation lifecycle is preview -> document create -> preview clear

Foundry template drag sequence:

1. `_onDragLeftStart` creates a preview `MeasuredTemplate` in `layer.preview`.
2. `_onDragLeftMove` mutates preview doc (`direction`, `distance`) and sets `refreshShape`.
3. Base `PlaceablesLayer._onDragLeftDrop` creates embedded document (`MeasuredTemplate.create(...)`) then clears preview container.

Evidence:
- `resources/app/client/canvas/layers/templates.mjs`
- `resources/app/client/canvas/layers/base/placeables-layer.mjs`

Implication for bridge:
- There is an intentional transition window where preview state disappears and persisted object state appears.
- If dirty triggers and strategy/fallback logic run in this window, bridge can be forced into expensive fallback/retry paths.

### E) Drawings are rendered into primary/interface groups (not just DrawingsLayer containers)

`Drawing._draw()` creates shape visuals via `#addDrawing()` which routes to `canvas.primary` or `canvas.interface` groups, while layer holds control/frame state.

Evidence:
- `resources/app/client/canvas/placeables/drawing.mjs`

Implication for bridge:
- Our stage-isolation logic traversing parents/ancestors is necessary to catch Foundry-native drawing visuals.
- But it also means expensive stage mutation paths can be hit by drawing tool switches when fallback is entered.

### F) Why this corroborates current user symptoms

Combined, Foundry internals explain observed behavior:

- Tool switch invokes synchronous control/layer activation hooks + broad render-state updates.
- Bridge currently listens to multiple of those hooks and marks dirty with follow-up captures.
- `hasNonDrawingUiContent` fallback criteria are broad enough that many scenes still enter stage isolation.
- Stage isolation still uses costly extraction/readback path.

This validates the current field report: both template and drawing tool switches can freeze, and overall FPS can stay depressed.

---

## Fix Attempt 3: Narrowing hasNonDrawingUiContent + Reducing Dirty Burst

**Changes applied:**
- All `activate*Layer` hooks now use `markDirty(0)` instead of `markDirty(1)`/`markDirty(2)`.
- Removed `renderSceneControls` as a dirty trigger (redundant with layer hooks).
- Narrowed `hasNonDrawingUiContent` to require layers be actively selected AND have content, not just passive scene presence.
- Templates only trigger stage isolation when a live preview is being dragged.

**Result: DID NOT FIX the problem.**

Template creation still causes multi-second freeze. The narrowing and burst reduction helps for tool switches but does NOT address the fundamental bottleneck: every extraction path calls `renderer.extract.canvas()` which internally calls `gl.readPixels()`.

---

## Root Cause Analysis: gl.readPixels is the Fundamental Bottleneck

### Why standard Foundry VTT is fast

In standard Foundry, everything is rendered by PIXI into a single WebGL context. There is:
- No bridge
- No cross-context texture transfer
- No CPU readback
- Just PIXI drawing to its own canvas → GPU renders directly to screen

This is why Foundry achieves 60+ FPS with templates, drawings, notes, etc. — it's all one GPU pipeline.

### Why MapShine is slow

MapShine replaces the base rendering with Three.js but needs PIXI overlay content (drawings, templates, notes, sounds, regions, lighting icons) composited into the Three.js pipeline for correct post-processing integration (lighting, water, etc.).

The current bridge architecture:
```
PIXI renders content → PIXI RenderTexture (GPU, fast)
     ↓
renderer.extract.canvas(RT) → gl.readPixels() → CPU ArrayBuffer (SYNCHRONOUS GPU STALL)
     ↓
putImageData → 2D Canvas (CPU)
     ↓
THREE.CanvasTexture → texImage2D → GPU upload (CPU→GPU)
```

The `gl.readPixels()` call is a **synchronous GPU pipeline stall**. It forces the GPU to:
1. Flush all pending commands
2. Wait for rendering to complete
3. Copy pixels from VRAM to system RAM
4. Block the main thread until complete

For a 1024×1024 RT, this is 4MB of synchronous GPU→CPU transfer. On integrated GPUs, this can take 2-15ms PER CALL. The bridge makes multiple calls per frame (per-shape extraction) or one large call (stage isolation), causing 10-100ms+ stalls.

### Every extraction path hits readPixels

| Path | readPixels calls per frame |
|------|---------------------------|
| Stage isolation | 1 large (full RT) + potentially 1 fallback |
| templates-extract | N (one per template shape) |
| notes-extract | N (one per note icon) |
| sounds-extract | N (one per sound control icon) |
| regions-extract | N (one per region overlay) |
| replay-shape | N (one per drawing shape) |
| replay-only + template doc replay | 0 (Canvas2D, fast) ✓ |

The only fast path is `replay-only` with template doc replay — pure Canvas2D, no GPU readback.

---

## Solution: GPU→GPU Texture Sharing (FoundryFogBridge Pattern)

### Existing precedent: FoundryFogBridge

`scripts/vision/FoundryFogBridge.js` already implements GPU→GPU texture sharing between PIXI and Three.js:

```js
// Get PIXI's internal WebGL texture handle
pixiRenderer.texture.bind(baseTexture);
const glTexture = baseTexture._glTextures?.[pixiRenderer.texture.CONTEXT_UID];

// Inject directly into Three.js texture property system
const properties = threeRenderer.properties.get(threeTexture);
properties.__webglTexture = glTexture.texture;
properties.__webglInit = true;
```

This works in Chromium/Electron because WebGL texture handles are valid across contexts on the same page (shared GPU process). Three.js binds the texture handle directly — **zero CPU readback, zero pixel copies**.

### New architecture

```
PIXI renders content → PIXI RenderTexture (GPU, fast)
     ↓
Get RT's WebGL texture handle from PIXI internals (instant)
     ↓
Inject handle into Three.js texture properties (instant)
     ↓
Three.js binds texture directly during render (GPU→GPU, zero copy)
```

Total cost: **one PIXI render to RT + two property assignments**. No `readPixels`, no CPU canvas, no `texImage2D` upload.

### Implementation approach

1. Add `_injectPixiRTToWorldTexture()` method following FoundryFogBridge pattern
2. In stage isolation: after rendering to scratch RT, inject GPU→GPU instead of `extract.canvas()`
3. For extraction strategies (templates-extract, notes-extract, etc.): skip per-shape readPixels extraction, fall through to GPU→GPU stage isolation
4. Keep Canvas2D replay paths for `replay-only` (drawings + template doc replay) — already fast
5. When replay content must be composited with extraction content (`shouldCompositeReplayUnderStage`), fall back to CPU path (rare edge case during active editing with drawings present)

### Expected performance

| Scenario | Before (CPU readback) | After (GPU→GPU) |
|----------|----------------------|-----------------|
| Template drag (live preview) | 10-100ms per frame (N readPixels) | <1ms (one PIXI render to RT) |
| Template drop | 2-15ms stall | <0.5ms |
| Notes/sounds/regions editing | 5-50ms per frame | <1ms |
| Stage isolation fallback | 2-15ms stall | <0.5ms |
| Replay-only (gameplay) | Already fast | No change |

---

## Next Actions (Updated)

1. ~~Narrow stage-isolation trigger scope~~ (done, insufficient alone)
2. ~~Reduce tool-switch dirty burst~~ (done, helpful but not root fix)
3. **Implement GPU→GPU texture sharing** (highest priority, addresses root cause)
4. Keep Canvas2D replay paths as fast-path for gameplay mode
5. Validate with template create/drag/drop, tool switches, zoom stress

---

## Acceptance Criteria

- No multi-second freeze after measured template placement.
- No visible shrink/offset jump when switching to template tool.
- Templates remain consistently visible in all normal modes (same reliability standard as drawings).
- Zooming remains smooth without major recapture spikes.
- Bridge never calls `gl.readPixels` during normal template/drawing workflows (GPU→GPU only).

---

## Implementation Status (Current)

### What was verified

1. **Three and PIXI are not guaranteed shared-context by default**.
   - Three bootstrap now supports optional shared context injection, but only when explicitly enabled via runtime flag.
   - Diagnostic flags:
     - `window.MapShine.__requestedPixiSharedWebGLContext`
     - renderer type suffix: `WebGL2(shared-context)` / `WebGL1(shared-context)`

2. **GPU-direct injection is now hard-gated to same-context only**.
   - Bridge checks `canvas.app.renderer.gl === threeRenderer.getContext()` before writing `__webglTexture`.
   - If false, bridge falls back safely.
   - Diagnostic flags:
     - `window.MapShine.__pixiBridgeSharedContext`
     - `window.MapShine.__pixiBridgeGpuDirectActive`

### What has already been implemented to reduce stalls

1. **Extract strategy simplification**
   - `notes/sounds/templates/regions-extract` now route directly to stage-isolation path rather than per-shape extract loops.

2. **Template finalize freeze mitigation**
   - Template doc replay now remains eligible during preview->document transition frames.
   - Template isolation is limited to truly interactive preview frames.

3. **Dirty trigger cleanup**
   - Removed activation-only dirty hooks (`activate*Layer`) so tool/layer switching alone does not schedule expensive recapture.

4. **World texture allocation stabilization**
   - Bridge world canvas now uses **grow-only allocation** to avoid repeated GPU texture recreation when switching capture modes/resolutions.

5. **Template editor overlay short-circuit**
   - While native PIXI template editor overlay is active, bridge capture is skipped and deferred, avoiding duplicate heavy work during live editing.

### Remaining permanent work

1. **Shared-context mode validation and rollout plan**
   - Validate startup/render compatibility when `__usePixiSharedWebGLContext = true`.
   - If stable, make it default for bridge-enabled scenes.

2. **Fixed-size pooled bridge target (full)**
   - Current grow-only allocation removes oscillation churn.
   - Final step is fixed max target + explicit UV windowing to fully decouple logical capture size from backing texture size.

3. **Three-native settled template rendering**
   - Move settled template visuals to native Three meshes to remove bridge dependency entirely for non-interactive templates.
