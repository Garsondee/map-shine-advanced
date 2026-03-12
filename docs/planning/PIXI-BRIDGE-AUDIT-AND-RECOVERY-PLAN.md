---
description: Full audit and staged recovery plan for the PIXI content bridge, input ownership, and overlay suppression interactions
---

# PIXI Bridge Audit and Recovery Plan

## Scope

This document audits the current PIXI bridge stack and proposes a phased recovery plan.

Audited components:

- `scripts/foundry/pixi-content-layer-bridge.js`
- `scripts/compositor-v2/FloorCompositor.js`
- `scripts/foundry/input-router.js`
- `scripts/foundry/controls-integration.js`
- `scripts/foundry/canvas-replacement.js`
- `scripts/foundry/layer-visibility-manager.js`
- Existing planning context in `docs/planning/PIXI-CONTENT-LAYER-BRIDGE-PLAN.md`

## Executive Summary

The PIXI bridge is currently carrying too many responsibilities:

1. Drawings replay and stage extraction
2. Cross-layer UI capture (sounds, templates, notes, regions)
3. Runtime suppression bypass coordination
4. Input and CSS arbitration side-effects

The main stability issue is not a single shader/pass bug. It is ownership drift:

- Input ownership, visual ownership, and suppression ownership are each controlled in multiple places.
- Bridge capture mutates stage/container state while other systems concurrently mutate visibility and pointer behavior.
- Multiple fallback paths make behavior unpredictable and hard to reason about.

The right fix is to reduce moving parts first, then re-add compatibility in strict phases.

## Current Architecture Map (Observed)

### 1) Capture and texture publication

`PixiContentLayerBridge.update()` currently attempts multiple capture modes:

1. Deterministic doc replay (`_renderReplayCapture`)
2. Optional shape replay (`_renderFoundryShapeReplay`)
3. Stage isolation render-to-texture extraction
4. Non-isolated fallback extraction
5. `app.view` fallback copy path (feature-flagged)

It also toggles global coordination flags:

- `window.MapShine.__bridgeCaptureActive`
- debug toggles (`__pixiBridgeUseShapeReplay`, `__pixiBridgeAllowViewFallback`, etc.)

### 2) Compositor integration

`FloorCompositor.render()`:

- calls `bridge.update()` every frame
- composites world texture late in post chain (`_compositePixiWorldOverlay`)
- has world reprojection uniforms based on `canvas.stage.worldTransform`
- renders UI channel last (`_renderPixiUiOverlay`) but UI texture is currently cleared-only

### 3) Input and overlay ownership

Ownership is split across:

- `InputRouter` (`setMode`, `determineMode`)
- `ControlsIntegration` (layer activation hooks, force activate, pointerEvents)
- `canvas-replacement` legacy arbitration (`setupInputArbitration`, `updateInputMode`)
- suppression loop (`_enforceGameplayPixiSuppression` + hook/ticker reassertion)

### 4) Visibility ownership

Visibility is split across:

- `LayerVisibilityManager.update()`
- ControlsIntegration visual guards
- canvas-replacement suppression reassertions
- bridge capture temporary visibility mutations

## Foundry VTT Source Research (Deep-Dive)

This section records concrete behavior verified in `foundryvttsourcecode` and how it should shape bridge design decisions.

### A) Canvas lifecycle and control activation are hook-driven and ordered

Observed in:

- `foundryvttsourcecode/resources/app/client/canvas/board.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/layers/base/interaction-layer.mjs`

Key facts:

1. Foundry creates/replaces `#board` with the PIXI canvas and emits `canvasConfig` before app creation.
2. Scene draw calls `canvasInit`, then draws groups from `CONFIG.Canvas.groups`, then emits `canvasReady`.
3. Active layer activation routes through `InteractionLayer.activate()`, which deactivates other layers and emits `activateCanvasLayer`.

Implication for MapShine:

- Bridge and suppression logic must align with this lifecycle ordering (especially between `canvasInit`, group draw, `canvasReady`, and `activateCanvasLayer`).
- Reassertion loops should be minimized because Foundry already has deterministic activation events.

### B) Scene controls are generated from InteractionLayer classes

Observed in:

- `foundryvttsourcecode/resources/app/client/applications/ui/scene-controls.mjs`

Key facts:

1. Controls are built by iterating `CONFIG.Canvas.layers` and calling each InteractionLayer subclass `prepareSceneControls()`.
2. Tool/control changes run layered callbacks (`onChange`, `onToolChange`) and can cancel active drag workflows.
3. Drawings control registration is native and explicit (`DrawingsLayer.prepareSceneControls`).

Implication for MapShine:

- Any custom control arbitration must treat SceneControls as authoritative metadata/state, not a secondary signal.
- Tool/layer transitions are expected to mutate interaction state; custom routing should avoid duplicating this state machine.

### C) Placeables preview model is first-class and layered above objects

Observed in:

- `foundryvttsourcecode/resources/app/client/canvas/layers/base/placeables-layer.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/layers/drawings.mjs`

Key facts:

1. `PlaceablesLayer` creates three key containers:
   - `objects` (persistent placeables)
   - `_configPreview`
   - `preview` (transient drag/create previews)
2. Preview lifecycle is integrated into drag handlers (`_onDragLeftStart/Move/Drop/Cancel`) and is explicitly cleared on deactivation/cancel.
3. Drawings creation relies on this preview flow before document creation.

Implication for MapShine:

- Bridge capture must preserve preview visibility semantics; missing preview support is a direct UX regression.
- A drawings-only bridge should target the native preview contract first before adding other layers.

### D) Drawings visuals are not owned by DrawingsLayer objects container

Observed in:

- `foundryvttsourcecode/resources/app/client/canvas/placeables/drawing.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/groups/primary.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/groups/interface.mjs`

Key facts:

1. `Drawing._draw()` calls private `#addDrawing()`.
2. `#addDrawing()` routes drawing shape to `canvas.primary` or `canvas.interface` based on `document.interface`.
3. Primary and interface groups own drawing render objects via group-level `addDrawing/removeDrawing` management.

Implication for MapShine:

- Capturing only `canvas.drawings.objects` is structurally incomplete.
- Bridge strategies should be explicit about whether they replay document data or ingest from primary/interface draw owners.

### E) Foundry already uses render-texture caching and framebuffer snapshots

Observed in:

- `foundryvttsourcecode/resources/app/client/canvas/containers/advanced/cached-container.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/framebuffer-snapshot.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/board.mjs` (`Canvas.getRenderTexture`)

Key facts:

1. `CachedContainer` is a native pattern that renders container contents into RTs and supports dirty/auto render modes.
2. `FramebufferSnapshot` performs direct framebuffer blits to RT with explicit Y handling.
3. Foundry APIs already expose RT-centric utilities for canvas workflows.

Implication for MapShine:

- A bridge design based on RT compositing is aligned with Foundry internals.
- We should prefer bounded, explicit RT capture contracts over aggressive stage graph mutation.

### F) Stage transforms are canonical for coordinate conversion

Observed in:

- `foundryvttsourcecode/resources/app/client/canvas/board.mjs`

Key facts:

1. Canvas pan mutates stage pivot/scale and triggers `canvasPan` hooks.
2. Foundry provides explicit conversion helpers using stage world transform (`clientCoordinatesFromCanvas`, `canvasCoordinatesFromClient`).
3. HUD alignment is coupled to pan (`hud.align()` on pan).

Implication for MapShine:

- Bridge world reprojection should continue to derive from stage transform, but must lock dimension/source assumptions.
- Any camera sync approach that bypasses Foundry pan semantics must independently maintain HUD and transform parity.

## Foundry-Informed Design Constraints (Added)

From this source review, the bridge recovery work must enforce:

1. One ownership path for input state transitions (respect SceneControls + InteractionLayer activation flow).
2. Explicit preview support as a non-negotiable parity requirement.
3. Drawings capture contract that acknowledges primary/interface ownership.
4. RT-first capture/composite design with minimal stage mutation.
5. Transform parity contract tied to stage world transform and canvas pan lifecycle.

## Findings (Severity-ranked)

## Critical-1: Multi-owner input/visibility state machine causes race conditions

Symptoms:

- First click misses after tool/layer switch
- wrong pointerEvents target during transitional frames
- hidden-but-interactive and visible-but-noninteractive states

Root cause:

- `InputRouter`, `ControlsIntegration`, and `canvas-replacement` all set `pointerEvents`, `opacity`, and board/canvas visibility.
- Multiple hooks (`activateCanvasLayer`, `renderSceneControls`) plus timeouts plus settle watcher all reassert ownership.

Impact:

- Non-deterministic editor behavior
- hard-to-reproduce regressions after compatibility changes

## Critical-2: Bridge capture mutates stage graph under concurrent suppression system

Symptoms:

- transparent captures despite valid drawing data
- fallback churn (`captured-fallback`, `captured-view-fallback`)

Root cause:

- Bridge isolation path mutates `canvas.stage` transform, visibility, renderable, alpha, masks, filters.
- At the same time, suppression hooks/ticker can hide/re-show related containers unless bypass flags are perfectly timed.

Impact:

- Capture instability
- high maintenance burden and fragile timing dependencies

## High-1: Bridge scope drift (drawings-only intent vs multi-layer runtime behavior)

Symptoms:

- Drawings bridge now reacts to sounds and other preview states.
- World/UI channels are conceptually separate but only world path is meaningfully used.

Root cause:

- The bridge expanded from a targeted drawings solution into a generic overlay capture without a finalized contract.

Impact:

- Increased complexity and capture cost
- difficult debugging because failures mix concerns

## High-2: Legacy and modern arbitration paths both active

Symptoms:

- duplicate hook-driven updates
- repeated style churn every control render

Root cause:

- ControlsIntegration path and legacy `setupInputArbitration` path coexist.

Impact:

- difficult to identify source of truth
- regressions when one path is updated without the other

## Medium-1: Coordinate/reprojection coupling is correct in principle but brittle in practice

Symptoms:

- overlay appears but can misalign under transform edge-cases

Root cause:

- world composite relies on inverse stage matrix + screen-size assumptions while capture dimensions can vary by mode.

Impact:

- subtle drift/misalignment bugs under zoom/pan and fallback paths

## Medium-2: Bridge includes expensive/debug pathways in primary runtime path

Symptoms:

- heavy extraction logic and probes in frame loop

Root cause:

- investigation code paths remain in core update method.

Impact:

- unnecessary runtime complexity
- harder performance tuning

## What to Keep vs Remove

Keep:

- `FloorCompositor` late world composite stage (`_compositePixiWorldOverlay`) concept
- deterministic doc replay path for drawings (`_renderReplayCapture`) as primary foundation
- dirty/throttle behavior (but simplify trigger sources)

Remove or quarantine:

- stage isolation extraction as default runtime path
- app.view fallback path from normal runtime
- legacy `setupInputArbitration` once ControlsIntegration/InputRouter ownership is finalized
- cross-layer capture concerns in drawings bridge phase

## Target Architecture (Recovery)

Single ownership contract:

1. Input owner: `InputRouter` only
2. Visual suppression owner: one module (`ControlsIntegration` or dedicated suppression manager), not both
3. Bridge owner: drawings capture only (phase 1 recovery)
4. Compositor owner: consume bridge textures only; no business logic

Hard rule:

- Bridge capture must not mutate global stage/container graph in normal mode.

## Phased Recovery Plan

## Phase 0 - Freeze and Instrument (no feature expansion)

- Freeze bridge feature scope to drawings-only.
- Add runtime diagnostic snapshot function returning:
  - router mode
  - pointerEvents/opacity on `canvas.app.view`, `#board`, `#map-shine-canvas`
  - suppression flags (`__bridgeCaptureActive`, `__forcePixiEditorOverlay`)
  - bridge status (`_lastUpdateStatus`, dimensions, dirty state)
- Add one consolidated debug logger (single source) for mode transitions.

Exit criteria:

- One log line per ownership transition, not many competing logs.

## Phase 1 - Single-path Drawings Bridge

- Make `_renderReplayCapture` the only production capture path.
- Move shape replay, stage isolation, and app.view fallback behind explicit debug-only gates.
- Remove sounds/templates/notes/regions from bridge dirty triggers in this phase.
- Keep world texture output only; UI channel remains disabled.

Exit criteria:

- Drawings create/edit/preview render deterministically via replay path.
- No stage graph mutations in production mode.

## Phase 2 - Ownership Consolidation

- Retire legacy `setupInputArbitration` path once ControlsIntegration+InputRouter covers all required contexts.
- Ensure only one system writes pointerEvents/opacity per frame.
- Convert `_enforceGameplayPixiSuppression` to honor a single ownership state object rather than recalc from many heuristics.

Exit criteria:

- No duplicate hook registrations for mode toggling.
- No style thrash across control switches.

## Phase 3 - Re-introduce Additional PIXI Layers (optional)

- Add templates/notes/sounds capture as separate bridge modules or channels, one at a time.
- Each layer gets explicit policy:
  - capture source
  - coordinate space (world/screen)
  - update trigger
  - composition order

Exit criteria:

- Each added layer has isolated tests and can be toggled independently.

## Phase 4 - Hardening

- Remove deprecated fallback code paths once parity is confirmed.
- Add regression harness scenes for:
  - rapid tool switching
  - pan/zoom while drawing
  - level switches during editing
  - module-heavy stacks

Exit criteria:

- Stable behavior under stress without bridge-specific toggles.

## Concrete Task List

1. Add `PIXI bridge runtime mode` setting:
   - `replay-only` (default)
   - `debug-shape-replay`
   - `debug-stage-isolation`
   - `debug-view-fallback`
2. Refactor `pixi-content-layer-bridge.update()` into strategy dispatch + small strategy methods.
3. Remove non-drawing dirty hooks from default strategy.
4. Introduce central ownership state object consumed by InputRouter and suppression logic.
5. Decommission `setupInputArbitration` after parity checks.
6. Add docs page with ownership matrix and hook responsibility map.

## Validation Matrix

Functional:

- Drawings: rectangle, ellipse, polygon, freehand, text
- Preview states during drag/chain creation
- No missed first click after control switch

Behavioral:

- Router mode changes are deterministic
- No conflicting pointerEvents between canvases in same frame

Visual:

- Bridge overlay aligns during pan/zoom at multiple zoom levels
- No double-render artifacts from PIXI primary

Performance:

- No continuous heavy capture when idle
- No major frame hitch during drawings edit

## Risks and Mitigations

Risk: replay path diverges from Foundry rendering parity.
Mitigation: keep debug shape replay for comparison and parity snapshots.

Risk: removing legacy arbitration uncovers hidden dependencies.
Mitigation: feature flag + staged rollout + fallback toggle for one release cycle.

Risk: module compatibility regressions on non-drawings overlays.
Mitigation: defer those layers until drawings-only core is stable.

## Recommended Immediate Action Order

1. Ship replay-only bridge mode as default.
2. Consolidate ownership (disable legacy arbitration path under V2).
3. Validate drawings end-to-end in this reduced system.
4. Only then re-open multi-layer compatibility work.

---

## Progress Update (Implemented)

This section records what has already been implemented after this plan was written.

### Completed and Verified

1. **Replay-first bridge behavior is now the default**
   - Production behavior prioritizes deterministic replay paths.
   - Stage-isolation and other risky extraction paths are no longer the default runtime behavior.

2. **Debug/advanced capture paths are explicitly gated**
   - Non-primary capture modes are behind debug strategy toggles.
   - Day-to-day runtime behavior is now more predictable.

3. **Sound layer support was reintroduced in a controlled way**
   - Added dedicated sounds replay handling.
   - Sound radius rendering uses `PointSoundSource.shape` polygon replay for wall-clipped geometry parity.
   - Sound icon positioning and world reprojection were corrected.

4. **Major rendering correctness fixes were landed**
   - Black overlay/fullscreen artifact risk reduced by extracting explicit sound visuals and clamping anomalous blits.
   - Water shader validation issue fixed (`zoomNorm` declaration path corrected).

5. **Sound placement performance regression was resolved to basic working state**
   - Introduced preview fast-path behavior for sounds placement.
   - Added settled-sounds cache reuse during drag preview.
   - Added interactive preview gating + preview signature checks to prevent stale preview states from forcing continuous recapture.
   - Result: sound placement now works in a basic form with restored usable performance.

### Current Status Snapshot

- **Drawings bridge:** Stable in replay-first mode.
- **Sounds bridge:** Functional with wall-clipped radius; existing ambient sounds can be moved by left-drag without forcing create-path behavior.
- **Templates bridge:** Templates are visible again with improved drag-preview performance under replay-first capture.
- **Journals/Notes bridge:** Remaining active regression was journals not consistently visible in token mode when templates content was present.
- **Known quality direction:** Keep ownership paths consolidated and prioritize visibility parity before deeper styling parity tweaks.

### March 2026 Runtime Recovery Update (Notes + Templates Coexistence)

Observed issue:

- Notes/journal icons could disappear in token mode while templates remained visible.

Root cause (active runtime path):

- `PixiContentLayerBridge` selected `templates-extract` whenever templates content existed.
- In that strategy branch, template replay was treated as terminal success and notes replay was not composited in the same frame.
- Result: templates rendered, notes did not, despite valid scene notes content.

Implemented fix:

1. In `templates-extract`, replay success now composites notes replay when notes UI content is present (no clear between passes).
2. If notes replay fails after template replay success, the strategy now falls through to stage-isolation fallback instead of returning early.
3. Stage-isolation fallback collection for `templates-extract` now includes both templates and notes layers.

Verification target:

- In token mode, with both templates and journals present, both overlays should remain visible simultaneously.

### Journals Follow-up (Known Gap + Theories)

Known gap:

- Journal note icon + square are still visibly too small compared to native Foundry notes.

What we learned:

1. Getting notes to render at all required explicit extraction target ownership (`controlIcon`/note display objects) and robust visibility handling (including parent-chain visibility during extraction).
2. Notes are sensitive to layer-state/toggle semantics (`NotesLayer` display toggle and non-active behavior), so strategy selection must account for scene notes content, not only active tool mode.
3. World-stable reprojection is working for notes; the remaining issue is predominantly a parity/scaling mismatch rather than coordinate drift.

Why sounds icons look correct but journal icons may not:

1. **Different visual composition primitives**
   - Sounds primarily use a simpler, explicit `controlIcon` extraction path and custom field replay.
   - Notes use `ControlIcon` + tooltip + visibility/permission-dependent behavior that can alter effective bounds and rendered content.
2. **Bounds contract differences**
   - Notes rely on `Note` + `ControlIcon` internals where border padding (`iconSize + 4*uiScale`) and parent-chain transforms can affect measured/extracted bounds.
   - Sounds extraction has been exercised longer in the bridge and appears to align better with current world-rect projection assumptions.
3. **Visibility and state coupling**
   - `NotesLayer` has a client toggle and non-active deactivation behavior that can produce different render-time object states than sounds.
   - These states can influence extracted target dimensions if not normalized identically to native draw timing.

Next targeted parity step (deferred):

- Add one-frame comparative diagnostics for notes vs sounds icon extraction (`screen bounds`, `extracted canvas size`, `projected world rect`) under identical zoom/pan to isolate the exact scaling factor mismatch.

---

## Success Stories

These are concrete wins that proved the recovery direction was correct.

### 1) Drawings stability was recovered by shrinking scope first

When drawings were made replay-first and deterministic, stability immediately improved. This confirmed that reducing runtime mutation and fallback churn was the right first principle.

**Why this was correct:** it reduced ownership conflicts and made behavior explainable frame-to-frame.

### 2) Sound radius parity improved by using Foundry source geometry

Switching from generic circles to replay of `sound.source.shape` restored wall-clipped behavior.

**Why this was correct:** it aligned bridge output with Foundry's own source-of-truth geometry instead of approximating it.

### 3) Black-overlay artifacts were solved by narrowing extraction intent

Restricting extraction targets and rejecting anomalous world blit sizes removed a class of catastrophic capture failures.

**Why this was correct:** broad stage extraction is fragile; explicit visual ownership is safer and easier to reason about.

### 4) Persistent FPS collapse was fixed by preview lifecycle control

The critical breakthrough was treating sounds preview as interactive only while the preview geometry is actively changing, and ignoring stale `_creating`-style states for continuous recapture decisions.

**Why this was correct:** performance failures were lifecycle-state bugs as much as rendering-cost bugs; fixing liveness detection removed runaway work.

### 5) Fast-path + cache architecture enabled usable placement performance

By compositing a cached settled pass with a lightweight live preview pass, placement remained responsive without abandoning quality in settled frames.

**Why this was correct:** it matches real user interaction patterns (high-frequency drag updates vs low-frequency settled updates) and keeps expensive work off the hot path.

### 6) Journals were recovered to a working, world-stable baseline

Journal note icons/squares now render through the bridge in a stable world-anchored way, and the system can proceed without blocking on complete visual parity.

**Why this was correct:** it converts a full compatibility failure into a known, bounded parity issue (size mismatch), which is much safer to iterate on than continuing broad architectural churn.

---

## Recent Attempt Log — Tokens Invisible + Drawings Invisible (Mar 12, 2026)

This section records all recent work attempted to resolve:

1. Three-native tokens not visible.
2. PIXI-bridge drawings not visible.

### User-reported status during this sequence

- Marquee selection recovered.
- Tokens still invisible.
- Drawings still invisible.
- Multiple patches reported as “no change or improvement”.

### Questions asked and investigated

Token system questions:

1. Is token rendering mode incorrectly set to Foundry (which hides Three sprites)?
2. Is `VisibilityController` active and forcing sprites hidden?
3. Are token sprites parented to the V2 render bus scene?
4. Are canvas/input ownership gates hiding or bypassing token visuals?

Drawing bridge questions:

1. Are drawing shapes discovered from Foundry display objects (`PrimaryCanvasGroup`) correctly?
2. Is bridge strategy selection (`replay-only` vs `templates-extract`) erasing drawing content?
3. Is the compositing pipeline drawing bridge textures to final output in V2?

### Runtime diagnostics collected

#### Token diagnostics snapshot (from user console)

- `tokenModeSetting`: `three`
- `tokenManagerExists`: `true`
- `visibilityControllerInitialized`: `false`
- `threeTokenCount`: `3`
- `firstSpriteVisible`: `false`
- `firstSpriteOpacity`: `1`
- `firstSpriteParent`: `FloorBusScene`
- `firstNativeMeshAlpha`: `1`
- Canvas styles showed PIXI canvas visible/interactive (`opacity=1`, `pointerEvents=auto`), Three canvas `pointerEvents=none` while in drawings context.

Interpretation at time of capture:

- Three token sprites existed and were correctly attached to bus scene.
- They were still hidden at sprite visibility level.
- `VisibilityController` not initialized was a critical red flag.

#### Drawing/bridge diagnostics snapshot (from user console)

- `bridgeExists`: `true`
- `bridgeDirty`: `false`
- `bridgeLastStatus`: `skip:idle`
- `bridgeStrategy`: `templates-extract`
- `drawingsLayerPlaceables`: `5`
- `drawingShapeRefsFound`: `5`
- `drawingShapeParentTypes`: `PrimaryCanvasGroup`
- `worldCanvasExists`: `true`
- `worldCanvasSize`: `10350x10800`
- `worldCanvasCenterPixelRGBA`: `0,0,0,0`

Interpretation at time of capture:

- Drawings were discovered, but effective world capture remained transparent for sampled center pixel.
- Strategy remained in template-extract path during test window.

### Code changes attempted in this phase

1. **InteractionManager crash fix**
   - Added missing context helpers used by pointer guard path:
     - `_isNotesContextActive`
     - `_isTemplatesContextActive`
     - `_isRegionsContextActive`
   - File: `scripts/scene/interaction-manager.js`
   - Result: Removed `TypeError` spam and restored marquee interactions.

2. **PIXI suppression + primary visibility adjustments**
   - Multiple edits attempted in `scripts/foundry/canvas-replacement.js` to:
     - keep `canvas.primary` logically visible,
     - hide only primary subcontainers,
     - preserve overlay ownership semantics.
   - Some intermediary edits introduced syntax breakage and were reverted/fixed during the sequence.

3. **VisibilityController visibility-source correction**
   - Updated visibility sync to preserve computed visibility from Foundry patch timing and avoid reading only mutable `visible` state after token is force-kept interactive.
   - File: `scripts/vision/VisibilityController.js`
   - Key adjustments:
     - capture `computedVisibility` early in `_refreshVisibility` patch,
     - pass it through `_syncSingleToken(...)`,
     - prefer `isVisible` in bulk refresh fallback path.

4. **Templates extraction clear behavior**
   - Updated template replay call to avoid unnecessary clears over successful replay base:
     - `clear: !replayResult.ok`
   - File: `scripts/foundry/pixi-content-layer-bridge.js`

5. **Token visibility pipeline initialization restored**
   - Added explicit V2 startup initialization for:
     - `visibilityController = new VisibilityController(tokenManager); visibilityController.initialize();`
     - `detectionFilterEffect = new DetectionFilterEffect(tokenManager, visibilityController); detectionFilterEffect.initialize();`
     - registration with `effectComposer.addUpdatable(detectionFilterEffect)`.
   - File: `scripts/foundry/canvas-replacement.js`
   - This was added because diagnostics confirmed `visibilityControllerInitialized: false`.

### Validation steps executed during this phase

- Syntax checks run on modified files:
  - `scripts/foundry/canvas-replacement.js`
  - `scripts/foundry/pixi-content-layer-bridge.js`
  - `scripts/vision/VisibilityController.js`
- No syntax errors after final edits in this phase.

### Net outcome at end of this logged sequence

- Marquee: recovered.
- Tokens: still reported invisible by user after earlier rounds; additional initialization and visibility fixes were then applied.
- Drawings: still reported invisible by user after earlier rounds; template-extract clear behavior was then patched and additional investigation continued.

### Open unresolved risk at this point in timeline

- Runtime verification still required after the final two patches above (VisibilityController initialization + template-extract clear preservation) to confirm whether tokens/drawings are restored in the user scene.

---

## Deep Research Addendum (Mar 12, 2026)

This section separates the two systems explicitly:

1. **Native Three token rendering** (TokenManager + VisibilityController)
2. **PIXI bridge drawing rendering** (PixiContentLayerBridge + FloorCompositor composite)

No fixes are proposed here; this is architecture and failure-surface research only.

## System A — Native Three Token Rendering (Not the PIXI Bridge)

### A1) Ownership and startup chain

Token visibility/render ownership is distributed across three components:

1. `TokenManager` creates and updates Three sprites (`createTokenSprite`, `updateTokenSprite`, hook wiring).
2. `VisibilityController` is intended to be the sole authority for `sprite.visible` once initialized.
3. `canvas-replacement` controls native PIXI token visual suppression (alpha 0) while keeping PIXI tokens interactive.

Observed wiring:

- Token manager init: `canvas-replacement.js` creates `TokenManager`, registers it as updatable, and exposes `window.MapShine.tokenManager`.
- Visibility init: `canvas-replacement.js` creates `VisibilityController`, initializes it, then creates `DetectionFilterEffect` and registers updatable.
- Native PIXI token visual mode: `_applyPixiTokenVisualMode()` sets `token.mesh/icon/border.alpha` according to token rendering mode (`three` vs `foundry`).

Relevant code references:

- `scripts/foundry/canvas-replacement.js` (TokenManager + VisibilityController startup block)
- `scripts/scene/token-manager.js` (hooks, creation/update, visibility fallback rules)
- `scripts/vision/VisibilityController.js` (patched `_refreshVisibility` + `sightRefresh` bulk path)
- `scripts/settings/scene-settings.js` (`TOKEN_RENDERING_MODES`, `getTokenRenderingMode()`)

### A2) Token render path (frame lifecycle)

1. On `canvasReady` / `syncAllTokens`, TokenManager creates sprites for placeables.
2. `createTokenSprite`:
   - builds `THREE.SpriteMaterial` (initially no map)
   - calls transform + visibility setup
   - adds sprite to V2 FloorRenderBus scene if available, otherwise main scene fallback
   - if VC is already initialized: forces `sprite.visible = false`
   - forces `sprite.material.opacity = 0`
3. Async texture load sets `material.map`; if VC is initialized, opacity restore is conditional on `sprite.visible` already being true.
4. At runtime, TokenManager `update()` reparents sprites to bus scene defensively and reapplies V2 render order.
5. VisibilityController should later set `sprite.visible` based on Foundry visibility (patch + hooks).

### A3) Visibility authority contract

TokenManager explicitly yields authority once VC is active:

- `updateSpriteVisibility()` early-returns when `window.MapShine.visibilityController._initialized` is true.
- VC owns per-token and bulk visibility synchronization:
  - Path A: patched `Token._refreshVisibility`
  - Path B: `sightRefresh`, `visibilityRefresh`, deferred bulk refresh

If VC is inactive, TokenManager fallback logic controls visibility (`hidden` + level filter).

### A4) Critical token invisibility failure surfaces (research)

1. **Initialization gap / ordering race**
   - Sprites start hidden+opacity=0 in VC mode, but depend on VC hooks/patch to unhide.
   - Any missed timing window before first visibility sync can leave tokens invisible.

2. **Render-mode gate mismatch**
   - If token mode resolves to `foundry`, Three sprites are intentionally hidden (`updateSpriteVisibility` and VC both honor this).

3. **Scene ownership mismatch (V2 vs fallback)**
   - If bus scene is unavailable during creation, sprites go to main scene fallback.
   - In V2, only bus-scene content is part of primary floor render path.

4. **PIXI counterpart dependency in VC bulk pass**
   - VC bulk path hides sprite if no matching PIXI placeable is found in map lookup.

5. **Level-based filter hides at shared boundary**
   - VC and fallback both hide tokens when `tokenElev >= levelContext.top - 0.01`.
   - Boundary semantics can look like “missing token” during floor transitions.

6. **Texture-load + opacity recovery dependence on visibility state**
   - Texture callback only restores opacity immediately in VC mode when sprite is already visible.

### A5) Token diagnostics checklist (research workflow)

For each failed scene capture:

1. Confirm mode and managers:
   - token rendering mode (`three`/`foundry`)
   - `window.MapShine.tokenManager` exists
   - `window.MapShine.visibilityController?._initialized`
2. Confirm sprite residency:
   - sprite count in `tokenManager.tokenSprites`
   - parent scene (`FloorBusScene` vs main scene)
3. Confirm visibility state source:
   - `sprite.visible`, `sprite.material.opacity`, `sprite.material.map`
   - matching `canvas.tokens.placeables` presence by id
4. Confirm level gate inputs:
   - `window.MapShine.activeLevelContext`
   - token elevation vs context top

---

## System B — PIXI Bridge Drawings Rendering (Not TokenManager)

### B1) Explicit ownership in current runtime

Current startup intentionally disables Three-native drawings for this test path:

- `drawingManager = null` in `canvas-replacement.js`
- PIXI bridge becomes the sole drawing visual source:
  - `pixiContentLayerBridge = new PixiContentLayerBridge(); initialize();`
  - exposed at `window.MapShine.pixiContentLayerBridge`

This is a hard separation: **drawings visibility issues are in bridge/compositor strategy, not TokenManager**.

### B2) Bridge-to-screen pipeline

1. `FloorCompositor.render()` calls `bridge.update()` once per frame.
2. Bridge writes world canvas/texture (`getWorldTexture()`), status in `_lastUpdateStatus`.
3. Late in post chain, `_compositePixiWorldOverlay(currentInput)` alpha-composites bridge world texture into the RT chain.
4. UI channel exists but is effectively secondary; drawings are routed through world overlay path.

### B3) Bridge strategy model (important)

Bridge is not strictly “drawings-only replay” at runtime today.

`_getCaptureStrategy()` can auto-select:

- `replay-only`
- `replay-shape`
- `sounds-extract`
- `notes-extract`
- `templates-extract`
- `stage-extract`

Selection can drift to `templates-extract`/`notes-extract` based on scene content or active context, even when debugging drawings.

### B4) Drawing capture path

Primary drawing path is deterministic replay:

- `_renderReplayCapture(drawingsLayer, width, height)`
  - collects from drawings placeables + preview + configPreview
  - traces shape path from drawing document data
  - draws fill/stroke/text to world canvas
  - marks world texture dirty

If strategy is not replay-only, branch behavior may include:

- extra layer replay (templates/notes/sounds)
- stage-isolation fallback with temporary stage/container visibility and transform mutation
- fallback clears on failure (`_clearChannel('world')`/`_clearChannel('ui')`)

### B5) High-risk drawing invisibility surfaces (research)

1. **Strategy drift away from replay-only**
   - Drawings can be overshadowed by templates/notes extraction branch logic.

2. **Idle/throttle state suppresses recapture**
   - Bridge can remain `skip:idle` when `_dirty` is false and no live preview signatures change.

3. **Failure branches clear world channel**
   - Multiple strategy failures explicitly clear world/ui textures, yielding transparent overlays.

4. **Stage-isolation fallback complexity**
   - Stage mutation path hides/shows ancestors/siblings, strips masks/filters, alters transforms.
   - This remains a fragile path when branch falls through beyond replay logic.

5. **Single-source fallback disabled**
   - Three-native DrawingManager is intentionally disabled in this mode, so bridge failure has no local visual fallback.

### B6) Compositor-side verification points

For every frame where drawings are missing, inspect:

1. `window.MapShine.__pixiBridgeCompositeStatus`:
   - `ran`, `reason`, `bridgeStatus`
2. Bridge internals:
   - `_lastUpdateStatus`
   - strategy selected (`_getCaptureStrategy` result)
3. Texture presence:
   - `bridge.getWorldTexture()` exists
   - world canvas dimensions + sampled alpha
4. Composite path reached:
   - `_compositePixiWorldOverlay` executes after post chain in `FloorCompositor.render()`

---

## Combined Triage Matrix (Keep systems separate)

When both “tokens invisible” and “drawings invisible” occur in the same report:

1. **Token path first** (Three-native)
   - VC initialized?
   - token mode set to `three`?
   - sprites in bus scene?
   - visibility sync events firing?
2. **Drawing path second** (PIXI bridge)
   - bridge strategy?
   - bridge status (`skip:*` vs `captured:*`)
   - world texture non-empty?
   - compositor world-overlay composite ran?

This split avoids cross-system misdiagnosis:

- TokenManager/VisibilityController issues should not be debugged as bridge extraction issues.
- Bridge strategy/composite issues should not be debugged as token visibility issues.

---

## User Runtime Evidence Log (Mar 12, 2026, 21:30 UTC)

This section records direct console output provided by the user and the interpretation of that evidence.

### Token system evidence (Three-native path)

Observed snapshot:

- `tokenRenderingModeSetting: "three"`
- `tokenManagerExists: true`
- `visibilityControllerInitialized: true`
- `tokenSpriteCount: 3`
- `floorBusSceneExists: true`
- each token row shows:
  - `spriteVisible: false`
  - `opacity: 0`
  - `hasMap: true`
  - `parent: FloorBusScene`
  - `pixiExists: true`
  - `pixiIsVisible: true`
  - `tokenHidden: false`
  - `tokenElevation: 0`

Active level context during capture:

- `bottom: -14.75`
- `top: -13.25`
- `count: 28`
- `index: 0`

Most important inference:

- `VisibilityController` level gate hides tokens when `tokenElev >= levelContext.top - 0.01`.
- With `tokenElevation = 0` and `top = -13.25`, condition is true (`0 >= -13.26`).
- Therefore all tokens are filtered as “above current level”, which is fully consistent with all-three-tokens hidden (`visible=false`, `opacity=0`) despite valid sprite setup.

This is currently the strongest evidence-backed cause of token invisibility.

### PIXI bridge drawings evidence (bridge/compositor path)

Observed snapshot:

- `bridgeExists: true`
- `floorCompositorV2Exists: true`
- `bridgeLastStatus: "skip:idle"`
- `bridgeDirty: false`
- `bridgeStrategyNow: "templates-extract"`
- `hasWorldTexture: true`
- `worldCanvasSize: "10350x10800"`
- `sceneDrawingsCount: 6`
- `drawLayerPlaceables: 6`
- compositor status:
  - `ran: true`
  - `reason: "rendered"`
  - `hasOverlay: true`
  - `bridgeStatus: "skip:idle"`
- world-canvas sampled RGBA at center/q1/q2/q3/q4 all `0,0,0,0`

Most important inferences:

1. **Compositor path is active** (overlay composite pass is running), so this is not a "compositor not called" failure.
2. **Bridge world texture exists but contains transparent pixels** at probe points.
3. **Bridge is idle** (`skip:idle`, `dirty=false`), so capture did not refresh during the snapshot.
4. **Strategy drift to `templates-extract` while active control is `tokens/select`** indicates bridge is not in deterministic drawings replay mode for this runtime state.

Together this points to a stale/empty bridge world canvas state being composited successfully but containing no visible drawing content.

### Evidence-backed likely causes ranking

1. **Token invisibility:** level-context filter mismatch (very high confidence from numeric condition).
2. **Drawings invisibility:** bridge strategy + idle capture state leaves transparent world canvas while compositor still blends overlay (high confidence from status + pixel probes).
3. **Drawings secondary risk:** non-replay strategy selection (`templates-extract`) in non-template context increases likelihood of branch-specific capture non-updates.

