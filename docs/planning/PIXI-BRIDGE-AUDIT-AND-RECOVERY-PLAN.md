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
- **Sounds bridge:** Functional with wall-clipped radius and basic placement workflow working.
- **Journals/Notes bridge:** Functionally working in world-stable mode (icons/squares now render), but icon/square sizing is still smaller than native Foundry parity.
- **Known quality direction:** Continue refining visual parity/quality while preserving the new performance guardrails.

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
