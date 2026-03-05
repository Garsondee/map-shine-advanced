# Editor Input Regression Incident Log (Walls/Lights/Doors/Token Drag-Select)

## Scope

This document is the single source of truth for the current editor interaction regression in gameplay mode.

### Broken behaviors (current)

- Cannot select/edit/draw walls in Walls mode.
- Cannot open/interact with door controls.
- Cannot select/move lights in Lighting mode.
- Token drag-select rectangle is not visible and selection behavior is broken.

### Key diagnostic evidence

Latest runtime dump (walls/tokens/lighting) consistently shows:

- `mode: undefined`
- `shouldThree: undefined`
- `shouldPixi: undefined`
- `forceOverlay: true` even on Tokens control
- `pixiPE: "none"`, `boardPE: "none"`, `threePE: "auto"`

Interpretation:

1. Overlay forcing logic is active.
2. Three canvas appears to own pointer events.
3. However, active router object is unresolved/undefined in global diagnostics path.
4. At least one gating system is still making incorrect assumptions about input ownership or active mode state.

---

## Attempts So Far (chronological)

> Rule for this log: after every new code attempt, append one entry with
> - What changed
> - Why
> - Files
> - Observed outcome
> - Decision (keep/revert/follow-up)

### Attempt 001 - Overlay unsuppression hardening

- **What changed**: force unsuppress PIXI canvas + board when editor overlay needed; added more suppression hooks (`activateCanvasLayer`).
- **Why**: walls/lights/doors were not visible at all.
- **Files**: `scripts/foundry/canvas-replacement.js`
- **Outcome**: visual overlays improved in some states, but interaction remained unstable.
- **Decision**: kept, required follow-up.

### Attempt 002 - Active control detection modernization

- **What changed**: prefer `ui.controls.control?.name` over deprecated `activeControl` across routing/visibility checks.
- **Why**: deprecation and stale control detection issues.
- **Files**: `scripts/foundry/input-router.js`, `scripts/foundry/controls-integration.js`, `scripts/foundry/layer-visibility-manager.js`, `scripts/foundry/canvas-replacement.js`
- **Outcome**: reduced API mismatch risk; did not fully restore interactions.
- **Decision**: kept.

### Attempt 003 - Token recursive raycast ancestry fix

- **What changed**: switched token raycast handling to scan recursive hits and walk parents for `tokenDoc` instead of early return on first child hit.
- **Why**: recursive raycast was hitting child meshes and aborting pointer flow.
- **Files**: `scripts/scene/interaction-manager.js`
- **Outcome**: correctness improvement for token hit resolution; broad regression persisted.
- **Decision**: kept.

### Attempt 004 - Route lighting to Three

- **What changed**: lighting layer mode set to Three interaction path.
- **Why**: lights hovered but could not select/drag.
- **Files**: `scripts/foundry/input-router.js`
- **Outcome**: no full recovery due to larger routing/gating desync.
- **Decision**: kept, but insufficient alone.

### Attempt 005 - Route walls to Three

- **What changed**: walls layer mode set to Three interaction path.
- **Why**: wall/door editing is Three-owned in this architecture.
- **Files**: `scripts/foundry/input-router.js`
- **Outcome**: still unstable because stale mode ownership and undefined router references remained.
- **Decision**: kept.

### Attempt 006 - Defensive force-Three override in pointer handling

- **What changed**: when router reports PIXI, force override for token/walls/lighting contexts before handling pointer down.
- **Why**: recover from stale mode transitions and layer-switch races.
- **Files**: `scripts/scene/interaction-manager.js`
- **Outcome**: partial guard, but not enough.
- **Decision**: kept.

### Attempt 007 - Fallback router discovery + global re-exposure

- **What changed**:
  - Router lookup now falls back to `controlsIntegration.inputRouter`.
  - ControlsIntegration re-assigns globals (`inputRouter`, `layerVisibility`, `controlsIntegration`) on init.
- **Why**: diagnostics showed `mode/shouldThree/shouldPixi` undefined.
- **Files**: `scripts/foundry/canvas-replacement.js`, `scripts/scene/interaction-manager.js`, `scripts/foundry/controls-integration.js`
- **Outcome**: diagnostics still reported undefined router state in user checks.
- **Decision**: follow-up required.

### Attempt 008 - Deterministic pointer ownership in overlay gates

- **What changed**:
  - Added `threeOwnedContext` (tokens/walls/lighting/select/door/light tools).
  - Overlay stays visible but input capture follows deterministic rule.
  - Explicitly sync Three canvas pointer events opposite PIXI capture state.
- **Why**: prevent overlay visibility from stealing interaction ownership.
- **Files**: `scripts/foundry/canvas-replacement.js`, `scripts/foundry/controls-integration.js`
- **Outcome**: user reports no functional recovery.
- **Decision**: follow-up required.

### Attempt 009 - Keep Three light gizmos visible in lighting context

- **What changed**: removed V2-based suppression of Three lighting gizmo visibility.
- **Why**: lighting interactions are Three-driven in this path.
- **Files**: `scripts/foundry/controls-integration.js`
- **Outcome**: user still cannot select/move lights.
- **Decision**: follow-up required.

### Attempt 010 - Create dedicated incident log and enforce append-only process

- **What changed**: created this document and structured it with symptoms, diagnostics, hypothesis, strict next steps, and mandatory per-attempt logging format.
- **Why**: stop circular debugging and preserve exact history of what has/has not worked.
- **Files**: `docs/planning/EDITOR-INPUT-REGRESSION-INCIDENT-LOG.md`
- **Outcome**: in place and ready to track every subsequent code attempt.
- **Decision**: keep as the canonical debug tracker.

### Attempt 011 - Add authoritative interaction snapshots at key lifecycle hooks

- **What changed**:
  - Added `_logInteractionSnapshot(trigger, extra)` in `ControlsIntegration`.
  - Snapshot includes router identity/equality across `window.MapShine`, `window.mapShine`, and `this.inputRouter`.
  - Logs mode/shouldThree/shouldPixi + control/tool + PE styles (`pixi/board/three`) + overlay flag.
  - Hooked snapshots on:
    - `initialize.postAutoUpdate`
    - `activateCanvasLayer.postUpdate`
    - `renderSceneControls.postUpdate`
    - `mapShineInputModeChange`
- **Why**: confirm whether regressions are due to split router instances or post-switch style writers overriding each other.
- **Files**: `scripts/foundry/controls-integration.js`
- **Outcome**: instrumentation added; runtime evidence pending user repro with fresh logs.
- **Decision**: keep; use output to drive next minimal behavioral fix.

### Attempt 012 - Foundry core pipeline research and architecture reset recommendation

- **What changed**: performed deep source-level review of Foundry control/layer/input internals and mapped them against MapShine interception points.
- **Why**: repeated regressions indicate systemic ownership conflict, not isolated per-tool bugs.
- **Files reviewed**:
  - `foundryvttsourcecode/resources/app/client/canvas/board.mjs`
  - `foundryvttsourcecode/resources/app/client/canvas/layers/base/interaction-layer.mjs`
  - `foundryvttsourcecode/resources/app/client/canvas/layers/controls.mjs`
  - `foundryvttsourcecode/resources/app/client/canvas/containers/elements/door-control.mjs`
  - `foundryvttsourcecode/resources/app/client/canvas/interaction/mouse-handler.mjs`
  - `foundryvttsourcecode/resources/app/client/canvas/layers/walls.mjs`
  - `foundryvttsourcecode/resources/app/client/canvas/layers/lighting.mjs`
- **Outcome**: research concludes best fix is an "authoritative interaction owner" model with exactly one writer for pointer ownership + no dual emulation of Foundry drag-select/door/light interaction simultaneously.
- **Decision**: proceed with architecture-level consolidation before further point fixes.

### Attempt 013 - Ownership consolidation implementation (InputRouter-first)

- **What changed**:
  1. **InputRouter mode matrix reset to Foundry-native edit workflows**
     - Tokens `select/target/ruler` => PIXI
     - Walls => PIXI
     - Lighting => PIXI
  2. **InputRouter now always re-enables board interactivity in PIXI mode**
     - `#board` display/visibility/opacity/pointer-events are restored whenever mode is PIXI (not only overlay-forced branches).
  3. **InteractionManager no longer force-overrides PIXI mode back to Three in pointerdown**
     - Removed context-based force-Three override path; if router says PIXI, Three handler exits.
  4. **ControlsIntegration overlay gate moved to visibility-only**
     - Removed pointer-event writes from `_applyPixiEditorOverlayGate`.
  5. **ControlsIntegration now reasserts InputRouter ownership after layer/tool hooks**
     - Added delayed `_reassertInputOwnership(...)` after init, `activateCanvasLayer`, and `renderSceneControls`.
  6. **Overlay force flag now remains true whenever mode is PIXI**
     - Prevents legacy suppression logic from hiding PIXI during token select and other PIXI-owned edit contexts.
- **Why**: establish a single practical source of truth for input ownership and restore Foundry-native token drag-select / wall-door-light editing flows.
- **Files**:
  - `scripts/foundry/input-router.js`
  - `scripts/scene/interaction-manager.js`
  - `scripts/foundry/controls-integration.js`
- **Outcome**: implementation complete; runtime validation pending.
- **Known limitation**: `scripts/foundry/canvas-replacement.js` could not be directly edited in this pass due transient file-decoding failure in tooling, so mitigation was applied by stronger InputRouter ownership + reassertion hooks.
- **Decision**: test immediately; if suppression still conflicts, fix `canvas-replacement.js` once file decoding is restored.

### Attempt 014 - Direct legacy V2-baseline fix (ControlsIntegration-skipped path)

- **What changed**:
  1. Patched `_enforceGameplayPixiSuppression()` fallback ownership logic to treat these as PIXI-owned when no router instance exists:
     - tokens `select/target/ruler`
     - walls + wall tools
     - lighting + light tool
  2. In that same suppression path, editor overlay pointer ownership now follows `shouldPixiReceiveInput` directly (PIXI/board auto, Three none when PIXI-owned).
  3. Patched legacy `updateInputMode()` layer/tool matrix to include Tokens/Walls/Lighting as edit contexts and synchronize board + Three pointer events accordingly.
  4. Added no-router fallback gate in `InteractionManager.onPointerDown` so Three handling exits in PIXI-owned edit contexts.
- **Why**: source inspection showed `ControlsIntegration` is skipped in V2 baseline, so fixes had to land in the active legacy `canvas-replacement` path.
- **Files**:
  - `scripts/foundry/canvas-replacement.js`
  - `scripts/scene/interaction-manager.js`
- **Outcome**: implementation complete; runtime validation pending.
- **Decision**: validate immediately against token drag-select, walls, doors, and lights.

---

## Current Hypothesis (working)

We likely have **split authority** between multiple input/overlay systems, where style state (pointer-events/visibility) and interaction state (router mode + active handlers) are being written by different hooks in different ticks.

Even though Three canvas shows `pointerEvents:auto`, interaction still fails, which implies one or more of:

1. Pointer events are not reaching the intended listener target for drag-select/wall/light handlers.
2. Pointer handlers are active but gating returns early due to stale per-context checks.
3. Another hook rewrites mode/style immediately after tool switch.
4. The router instance used by the logic is not the same instance exposed to globals/diagnostics.

---

## Next Steps (strict)

1. Add a single **authoritative interaction-state snapshot logger** called on:
   - `activateCanvasLayer`
   - `renderSceneControls`
   - `mapShineInputModeChange`
   - first `pointerdown` after tool switch
2. Log object identity for router references:
   - `window.MapShine.inputRouter`
   - `window.mapShine.inputRouter`
   - `controlsIntegration.inputRouter`
   - compare with strict equality booleans.
3. Temporarily disable one gate path at a time to identify the conflicting writer:
   - `ControlsIntegration._applyPixiEditorOverlayGate`
   - `_enforceGameplayPixiSuppression`
4. Once the conflicting writer is identified, remove duplicate ownership logic and keep one source of truth.

---

## Changelog (append-only)

- 2026-03-05: Incident log created.
