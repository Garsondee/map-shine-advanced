---
description: Plan for a dedicated PIXI Content Layer bridge that ingests Foundry PIXI output into the Three.js pipeline while preserving Three renderer ownership
---

# PIXI Content Layer Bridge Plan

## 1) Goal

Design and implement a dedicated **PIXI Content Layer** system that:

1. Lets Foundry-native PIXI workflows (drawings/templates/notes/etc.) keep working.
2. Routes PIXI visuals into the Three.js render pipeline in a controlled, explicit way.
3. Avoids ad-hoc CSS toggling (`opacity`, `pointer-events`) as the long-term source of truth.
4. Preserves project direction: **Three.js is the final renderer**.

---

## 2) Non-Goals

- Do not revert to PIXI-first rendering.
- Do not keep permanent dual full-canvas overlays as final architecture.
- Do not re-implement all Foundry placeables in one step.

---

## 3) Architectural Constraints

- Foundry remains authoritative for document creation/edit workflows.
- Three remains authoritative for final scene composition.
- Coordinate conversions must respect existing MapShine conventions:
  - Foundry top-left/Y-down vs Three bottom-left/Y-up.
  - Scene bounds and screen-space vs world-space separation.
- Must coexist with current `InputRouter`, `ControlsIntegration`, and V2 compositor.

## 3.1) Foundry Source Validation (why this approach fits)

Research in `foundryvttsourcecode` validates the bridge direction:

1. Foundry canvas is explicitly layer/group-driven from `CONFIG.Canvas.layers`, so integrating by layer/container capture is aligned with core architecture.
2. Foundry editing relies on `PlaceablesLayer` preview workflows (`_onDragLeftStart/_Move/_Drop`) and per-layer tool handlers. Replacing these interactions wholesale in Three would be high-risk and drift-prone.
3. Foundry already uses render textures and cached container rendering (`Canvas.getRenderTexture`, `CachedContainer`, framebuffer snapshot patterns), so RT-based bridging follows established internal patterns.

Conclusion: **PIXI Render-Texture Bridge** is a compatibility-first, maintainable strategy. It preserves Foundry authoring behavior while moving final composition control into Three.

---

## 4) Candidate Approaches

## A. Keep current CSS arbitration only
- Pros: Minimal work.
- Cons: Already fragile; race conditions and invisible interactive states recur.
- Verdict: **Not sufficient long-term**.

## B. World-space per-layer mesh reconstruction from PIXI display tree
- Pros: Strong Three ownership, potentially precise depth placement.
- Cons: Very high complexity; tight coupling to Foundry internals; expensive to maintain.
- Verdict: **Too costly for first bridge**.

## C. PIXI Render-Texture Bridge (recommended)
- Render selected PIXI containers to one or more textures.
- Composite those textures inside Three (post pass and/or world-plane pass).
- Keep Foundry editing behavior while gaining deterministic visual ownership in Three.
- Verdict: **Best first architecture**.

---

## 5) Recommended Design: `PixiContentLayerBridge`

Create a new subsystem responsible for taking specific PIXI content and publishing it as Three-consumable textures.

## 5.1 Core responsibilities

1. **Source selection**
   - Select PIXI containers/layers to ingest (initially drawings, templates, notes).

2. **Capture**
   - Render sources into dedicated render textures (RTs), separated by semantic type where needed.

3. **Publish**
   - Expose textures + metadata (bounds, UV mapping, dirty state) through a stable API.

4. **Compose in Three**
   - Inject textures into V2 compositor as explicit passes.
   - Use the right sampling space:
     - Screen-space overlay content -> screen UV pass.
     - World-anchored content -> scene/world UV pass.

5. **Lifetime management**
   - Allocate/dispose RTs on scene init/teardown and resize.

## 5.2 Proposed module locations

- `scripts/foundry/pixi-content-layer-bridge.js` (new)
- `scripts/compositor-v2/effects/PixiContentCompositeEffect.js` (new)
- Wiring touchpoints:
  - `scripts/foundry/canvas-replacement.js`
  - `scripts/foundry/controls-integration.js`
  - `scripts/compositor-v2/FloorCompositor.js` (or equivalent V2 pass registration point)

## 5.3 Foundry-facing integration touchpoints

Bridge implementation should explicitly hook these behavior points:

1. **Canvas lifecycle**
   - Initialize bridge after Foundry canvas draw is stable.
   - Dispose/recreate bridge resources on scene draw/teardown and renderer resize.

2. **Layer preview semantics**
   - Preserve `PlaceablesLayer.preview` behavior (do not bypass/replace it in Phase 1).
   - Capture preview visuals so polygon/freehand/text in-progress states are visible.

3. **Tool-driven activation paths**
   - Respect per-layer `prepareSceneControls` and active tool logic (`game.activeTool`).
   - Do not assume Drawings-only; templates/notes follow different handlers.

4. **Render order ownership**
   - Define explicit ownership matrix per subsystem:
     - Foundry PIXI owns authoring interaction.
     - Bridge owns ingestion.
     - Three owns final composition to screen.

---

## 6) Rendering Model

## 6.1 Initial layer scopes

Phase 1 ingestion targets:
- Drawings
- Templates
- Notes

Optional future:
- Sounds UI hints
- Additional module-provided PIXI overlays

## 6.2 Texture outputs

Recommended initial outputs:
- `pixiOverlayScreenRT` (screen-space content)
- `pixiWorldOverlayRT` (world-anchored content when needed)

Each output should include metadata:
- `kind` (`screen` | `world`)
- `width/height`
- `sceneBounds` for world UV conversion
- `dirtyFrameId`

## 6.3 Composition order in Three

Baseline order:
1. Main scene render
2. Lighting and core post stack
3. PIXI content composite pass (or split passes)
4. Final stylization passes that should affect overlays (configurable)

Need configurable policy for whether overlays are affected by bloom/grain/etc.

---

## 7) Input Ownership Strategy

Bridge is visual-composition architecture, not input replacement by itself.

Short-term input model:
- Keep `InputRouter` and `ControlsIntegration` for event ownership.
- Remove reliance on visibility hacks for correctness.
- During PIXI edit contexts, keep PIXI input active while visuals are sourced via bridge.

Long-term:
- Gradually reduce PIXI direct interaction dependence where Three-native replacements exist.

---

## 8) Migration Plan (Phased)

## Phase 0: Design + instrumentation
- Define bridge API and debug telemetry.
- Add diagnostics panel entries:
  - Active pixi sources
  - RT dimensions
  - Last update timestamp
  - Composition mode
  - Source layer/tool snapshot (control name + active tool)

Exit criteria:
- Bridge spec finalized and agreed.
- Ownership matrix documented and signed off for Drawings/Templates/Notes.

## Phase 1: Minimal capture + display
- Capture Drawings PIXI output into RT.
- Composite in a simple fullscreen pass in Three.
- Keep existing fallback path behind flag.

Exit criteria:
- Rect/ellipse/text/freehand/polygon visibly render via bridge in gameplay mode.
- In-progress preview states (polygon chain, freehand stroke, text pending text) are visible.
- No regression in Foundry document creation flow (`DrawingDocument.create` path remains authoritative).

## Phase 2: Multi-layer support
- Add Templates and Notes ingestion.
- Split screen-space vs world-space outputs where needed.
- Add pass ordering controls.

Exit criteria:
- Drawings/templates/notes stable across tool switches and scene transitions.
- Template drag preview and note journal placement continue to use native Foundry tool semantics.

## Phase 3: Ownership hardening
- Reduce CSS-based arbitration for visibility.
- Keep CSS changes only for emergency fallback mode.
- Add automatic fallback if bridge fails.

Exit criteria:
- No invisible-interactive PIXI states in normal operation.

## Phase 4: Optional Three-native replacements
- For selected systems, replace PIXI authoring visuals with native Three equivalents.
- Keep bridge for compatibility and third-party module integration.

Exit criteria:
- Documented per-subsystem owner (PIXI bridge vs Three-native).

---

## 9) Risk Register

1. **Performance overhead (extra RT passes)**
   - Mitigation: dirty-frame updates, resolution scaling, selective layer capture.

2. **Foundry internals drift across versions**
   - Mitigation: minimize deep internals coupling; use container-level capture APIs.

3. **Double-render artifacts**
   - Mitigation: strict ownership table and runtime assertions.

4. **Color-space mismatches**
   - Mitigation: explicit texture color-space handling and compositor tests.

5. **Pass ordering regressions**
   - Mitigation: fixed ordering contract + visual regression test scenes.

---

## 10) Validation Matrix

Functional:
- Create/edit/delete for rect/ellipse/polygon/freehand/text.
- Template and note visibility during gameplay and edit contexts.
- Tool switching stability (no stale hidden states).

Visual:
- Parity screenshots against native Foundry for key drawing styles.
- Text legibility, fill/stroke alpha parity, rotation parity.

Technical:
- No console errors across canvasReady/teardown cycles.
- No leaked render targets after scene transitions.
- No FPS collapse on heavy drawing scenes.

Compatibility:
- Baseline module stack smoke-test with common overlay-related modules.

---

## 11) Feature Flag + Rollout

Add a world setting:
- `pixiContentLayerBridgeMode`
  - `off` (legacy behavior)
  - `drawings-only`
  - `drawings-templates-notes` (target default)

Rollout:
1. Default `off` for initial merge.
2. Enable for internal QA scenes.
3. Promote to default after parity + perf acceptance.

---

## 12) Implementation Checklist

- [ ] Add `PixiContentLayerBridge` class and lifecycle wiring.
- [ ] Add `PixiContentCompositeEffect` pass in V2 compositor.
- [ ] Add bridge debug telemetry and diagnostics view.
- [ ] Implement Drawings capture path.
- [ ] Add parity test scene and screenshot references.
- [ ] Add Templates + Notes capture.
- [ ] Add fallback + auto-disable on bridge failure.
- [ ] Document ownership matrix in `ARCHITECTURE-SUMMARY.md` once stable.

---

## 13) Immediate Next Step

Build Phase 1 (drawings-only bridge) behind feature flag, then validate against current drawing regression cases before expanding to templates/notes.

Immediate implementation order:
1. Add bridge skeleton + telemetry + feature flag.
2. Wire Drawings preview/container capture.
3. Composite in V2 pass with explicit ordering contract.
4. Run parity checks for rect/ellipse/polygon/freehand/text (including in-progress previews).
