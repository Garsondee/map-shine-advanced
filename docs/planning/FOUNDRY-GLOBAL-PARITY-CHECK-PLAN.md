# Foundry Global Interface Parity Check Plan

## Status
In progress - deep-dive baseline + launch-readiness round 2 completed; implementation started

## Goal
Run a global parity check for Foundry VTT interface behavior now that Map Shine owns gameplay rendering and most gameplay interaction.

This plan focuses on interface-critical features that must be complete before adventures are safe to run (targeting, ruler, ping, notes/templates interaction, HUD parity, and keyboard parity).

## 0) Implementation Progress

### WP-1 Token Targeting parity (code complete — pending live validation)
- [x] Added gameplay `T` key targeting bridge in Three interaction flow (`InteractionManager.onKeyDown`).
- [x] Added Three token target indicators mirrored from Foundry target state.
- [x] Hooked Foundry `targetToken` updates to refresh Three target indicators.
- [x] Visual parity polish: replaced ring with corner arrows (matching Foundry `_drawTargetArrows`), colored with user color.
- [x] Per-user colored pips (matching Foundry `_drawTargetPips` per-user colors), signature-based efficient update.
- [x] Cleaned up dead code (`_countOtherTokenTargeters` replaced by `_getOtherTargetUsers`).
- [ ] Validate Shift+T and multi-user targeting behavior in live session.

### WP-2 Gameplay Ruler Parity (code complete — pending live validation)
- [x] Added "ruler" tool exception to `InputRouter.determineMode()` so tokens-layer ruler routes to PIXI for pointer events.
- [x] Verified `R` key not consumed by Three `InteractionManager.onKeyDown` — Foundry keybinding system handles toggle.
- [x] Verified `renderSceneControls` hook calls `autoUpdate()` to switch input mode when tool changes.
- [ ] Validate ruler drag-to-measure and waypoint (F key) in live session.

### WP-3 Ping Parity (code complete — pending live validation)
- [x] Implemented long-press ping detection (500ms, matching Foundry `MouseInteractionManager.LONG_PRESS_DURATION_MS`).
- [x] Converts Three screen→world→Foundry coords and calls `canvas.ping(origin)`.
- [x] Timer cancelled on pointer move (>5px threshold), pointer up, and dispose.
- [x] Permission check (`PING_CANVAS`), Ctrl guard, and tokens-layer check match Foundry `_onLongPress`.
- [ ] Validate ping broadcast, Shift (pull), and Alt (alert) modifiers in live session.

### WP-7 Multiplayer Activity API Parity (code complete — pending live validation)
- [x] Throttled cursor broadcast from Three `onPointerMove` (100ms interval).
- [x] Converts pointer position to Foundry canvas coords via `viewportToWorld` + `Coordinates.toFoundry`.
- [x] Syncs `canvas.mousePosition` so Foundry features reading it stay correct.
- [x] Broadcasts via `game.user.broadcastActivity({cursor})` with `SHOW_CURSOR` permission check.
- [ ] Validate other users see cursor movement in live multiplayer session.

### WP-5 Notes Gameplay Interaction (code complete — pending live validation)
- [x] Double-click on Three note sprites opens journal entry, matching Foundry `Note._onClickLeft2`.
- [x] Permission check: `OBSERVER` required (or GM), `LIMITED` for image pages.
- [x] `activateNote` hook called before opening, supporting module overrides.
- [x] Image pages open via `ImagePopout`, others via `entry.sheet.render`.
- [x] Exposed `noteManager` on `window.MapShine` for InteractionManager access.
- [ ] Validate journal open behavior and tooltip display in live session.

### WP-6 Notes/Template Visibility+Permission Parity (code complete — pending live validation)
- [x] `NoteManager._isNoteVisible(doc)`: mirrors Foundry `Note#isVisible` (journal permission + token vision test).
- [x] `syncAllNotes()` and `create()` now filter by visibility; invisible notes removed.
- [x] `refreshVisibility()` added, hooked to `sightRefresh` for token-movement-driven vision changes.
- [x] `TemplateManager._isTemplateVisible(doc)`: mirrors Foundry `MeasuredTemplate#isVisible` (`!hidden || isAuthor || isGM`).
- [x] `syncAllTemplates()` and `create()` filter by visibility; `update()` re-checks on hidden flag change.
- [ ] Validate non-GM player cannot see hidden templates or permission-gated notes in live session.

### GameSystemManager — Adapter-Based System Abstraction (code complete)
- [x] Refactored `scripts/core/game-system.js` into adapter pattern architecture.
- [x] `BaseSystemAdapter`: generic Foundry-standard fallbacks for all API methods.
- [x] `DnD5eAdapter`: vision (senses), movement (`attributes.movement.walk`), HP, AC, initiative (`init.total`), cone angle (53.13°), defeated state.
- [x] `PF2eAdapter`: vision (perception.vision boolean + senses), movement (`attributes.speed.value`), HP, AC, initiative (perception), cone angle (90°), defeated state (dying/dead conditions), PF2e condition registry.
- [x] `ADAPTER_REGISTRY` maps system IDs to adapter constructors; unknown systems get generic fallback.
- [x] `GameSystemManager` singleton: auto-detects system, creates adapter, proxies all API calls.
- [x] Wired `getDefaultConeAngle()` into `TemplateManager.create()` for system-correct cone geometry.
- [x] Exposed `noteManager` on `window.MapShine` + cleanup on dispose.
- [x] VisionManager already uses GSM correctly (no changes needed).
- [ ] Validate DnD5e adapter paths with live 5e world.
- [ ] Validate PF2e adapter paths with live PF2e world.

### WP-8 Delete key safety parity (code complete — pending live validation)
- [x] Routed token delete through Foundry `_confirmDeleteKey` API (confirmed present in TokenLayer with `confirmDeleteKey: true`).
- [x] Falls back to `_onDeleteKey` then direct deletion as resilience layers.
- [ ] Validate combatant delete confirmation parity in combat and non-combat scenarios.
- [ ] Validate mixed selection delete behavior (token + wall/light selections).

---

## 1) Deep-Dive Findings (Foundry baseline vs current Map Shine behavior)

## 1.1 Targeting (T key + hover + visual markers)

### Foundry baseline
- Core keybinding `target` (`KeyT`) resolves the currently hovered token from `canvas.activeLayer.hover` and toggles target state.
  - `ClientKeybindings.#onTarget(...)` in `client-keybindings.mjs`.
- Token targeting state is applied through `Token#setTarget(...) -> canvas.tokens.setTargets(...)`.
- Visual feedback is rendered by token target arrows and pips:
  - `Token#_refreshTarget`, `_drawTargetArrows`, `_drawTargetPips`.

### Map Shine current behavior
- Three-side hover exists (`InteractionManager.hoveredTokenId`) and drives nameplate hover only.
- There is no targeting flow in `InteractionManager.onKeyDown(...)` (copy/paste/delete only).
- There is no call path to `setTarget` / `setTargets` from Three gameplay interactions.
- Three token rendering has selection borders and name labels, but no target arrow/pip equivalent.

### Parity verdict
**Missing (critical).**

---

## 1.2 Ruler (R key toggle + drag measure + waypoint labels)

### Foundry baseline
- `R` toggles ruler tool from token layer (`ClientKeybindings.#onToggleRuler`).
- Ruler workflow depends on pointer drag handlers in ruler classes (`BaseRuler`, `Ruler`) and renders:
  - path lines,
  - waypoint markers,
  - HUD labels.

### Map Shine current behavior
- Input routing forces token layer to Three mode (`InputRouter.determineMode` returns Three for token layer).
- In gameplay mode PIXI pointer events are disabled for token layer routing.
- `InteractionManager` has path preview visuals for move-to, but no Foundry ruler parity workflow.

### Parity verdict
**Missing in gameplay (critical).**

---

## 1.3 Ping (long-press ping and broadcast)

### Foundry baseline
- Long press on controls layer triggers `canvas.ping(origin)` in token-layer context.
- `canvas.ping(...)` broadcasts activity and draws ping via controls layer ping renderer.

### Map Shine current behavior
- No gameplay-side ping initiation in Three interaction manager.
- No explicit `canvas.ping(...)` call in Map Shine gameplay interaction flow.
- Remote pings may still render through Foundry controls layer if activity arrives, but local initiation parity is not implemented.

### Parity verdict
**Missing locally in gameplay (high).**

---

## 1.4 Token HUD parity

### Foundry baseline
- Token HUD binds to token and includes target toggle.

### Map Shine current behavior
- Right-click token in Three opens/closes Foundry Token HUD (`token.layer.hud.bind(token)`),
- HUD is manually screen-positioned each frame (`updateHUDPosition`).

### Parity verdict
**Implemented (good), but depends on remaining targeting parity.**

---

## 1.5 Notes interaction (click/hover/open journal)

### Foundry baseline
- Notes layer and Note placeable provide hover/view/configure and open-on-double-click behavior (`_onClickLeft2`).

### Map Shine current behavior
- `NoteManager` syncs and renders note sprites in Three.
- `InteractionManager` does not implement note hit-testing/click-open behavior.
- Gameplay input routing keeps token layer in Three mode, so native PIXI note interactions are not guaranteed as a gameplay fallback.

### Parity verdict
**Partial rendering, missing gameplay interaction parity (high).**

---

## 1.6 Measured templates parity

### Foundry baseline
- Template layer supports full create/drag/rotate/edit workflow in PIXI (`TemplateLayer`, `MeasuredTemplate`).

### Map Shine current behavior
- `TemplateManager` mirrors templates into Three for visibility.
- Creation/editing is still Foundry tool driven when TemplateLayer is active via InputRouter PIXI mode.
- Gameplay parity for template interaction without layer-switch (if expected) is not implemented.

### Parity verdict
**Partial (tool-layer parity present, gameplay parity not complete).**

---

## 1.7 Keyboard action parity (global)

### Foundry baseline
- Core keyboard manager handles target, ruler toggle, dismiss, select all, cycle view, delete, pan, etc.

### Map Shine current behavior
- Three `onKeyDown` handles only a narrow set (copy/paste lights, delete, map point keys).
- No explicit bridge for core gameplay actions requiring hovered token and token-layer semantics (target/ruler/ping).

### Parity verdict
**Partial with major gameplay gaps.**

---

## 1.8 Control overlays and doors

### Foundry baseline
- Controls layer hosts doors/cursors/pings/ruler paths.

### Map Shine current behavior
- Walls layer remains visible for door controls, with wall visuals hidden and door controls preserved.
- Three interaction has explicit door click/right-click handling.

### Parity verdict
**Implemented/partial-good.**

---

## 1.9 Multiplayer activity APIs (cursor/ruler/ping broadcast)

### Foundry baseline
- Controls layer pointer move broadcasts cursor activity (`game.user.broadcastActivity({cursor})`).
- Ruler broadcasts path activity through `BaseRuler` broadcast flow.
- Ping uses `canvas.ping(...)` and broadcasts activity (`cursor` + `ping`).

### Map Shine current behavior
- Gameplay input is routed to Three while PIXI pointer events are disabled on token layer.
- No Three-side `broadcastActivity` bridge was found for cursor or ruler activity in gameplay mode.
- Ping initiation parity is already missing (covered in 1.3).

### Parity verdict
**Missing in gameplay for multiplayer activity parity (high).**

---

## 1.10 Delete key parity and combat safety

### Foundry baseline
- Core delete key delegates to active interaction layer (`_onDeleteKey`).
- Token layer includes combat-aware delete confirmation (`_confirmDeleteKey`) before removing combatant tokens.

### Map Shine current behavior
- Three `InteractionManager.onKeyDown` intercepts delete/backspace and directly calls `canvas.scene.deleteEmbeddedDocuments('Token'|'Wall'|'AmbientLight', ...)`.
- This bypasses the token-layer combat delete confirmation path.

### Parity verdict
**Missing safety parity (critical).**

---

## 1.11 Notes/templates visibility and permission parity

### Foundry baseline
- Note visibility is permission + vision aware (`Note.isVisible`) and open behavior is gated through note access checks.
- Measured templates have user-facing visibility semantics (`hidden` + author/GM visibility behavior).

### Map Shine current behavior
- `NoteManager.syncAllNotes()` mirrors all scene notes and currently does not apply Foundry note visibility/permission checks.
- `TemplateManager.syncAllTemplates()` mirrors all templates and currently does not apply hidden/author visibility semantics.

### Parity verdict
**Partial with potential information leak risk (critical for launch safety).**

---

## 1.12 Template geometry/API fidelity

### Foundry baseline
- Template geometry is computed from canonical Foundry shape APIs (`_computeShape`, `getCircleShape`, `getConeShape`, `getRectShape`, `getRayShape`) and honors grid/euclidean settings.

### Map Shine current behavior
- Three template geometry is manually approximated in `TemplateManager` (including TODO-style comments for cone/rect behavior and fallback geometry).
- This risks visual/rules mismatch for AoE adjudication.

### Parity verdict
**Partial with correctness risk (high).**

---

## 1.13 System compatibility pass (D&D 5e + PF2e)

### D&D 5e findings (`gamesystemsourcecode/dnd5e`)
- Uses `game.user.targets` for target descriptors and target-aware workflows.
- Uses `canvas.tokens.controlled` for scene target selection fallback.
- Registers `Hooks.on('targetToken', Token5e.onTargetToken)` and multiple HUD/target list flows that assume core targeting/control semantics.
- Adds system keybindings (including drag behavior modifiers) that rely on keyboard/keybinding parity.

### PF2e findings (`gamesystemsourcecode/pf2e`)
- Uses `canvas.tokens.controlled` in encounter/macro utilities (example: XP utility path).
- Includes multiple macro/action paths that hard-fail with `NoTokenSelected` style errors when control state is wrong.

### Map Shine implication
- Targeting parity and controlled-token synchronization are launch-critical not only for core Foundry behavior, but for top systems' encounter/chat/macro workflows.

### Parity verdict
**High-risk dependency area (must regression-test per system).**

---

## 1.14 Canvas drag-and-drop parity

### Foundry baseline
- Layer-specific drop handlers (`_onDropData` / `_onDropActorData`) implement canonical behavior and permissions.

### Map Shine current behavior
- Three `DropHandler` supports a limited type set (`Actor`, `Tile`, `JournalEntry`, `JournalEntryPage`, `PlaylistSound`) and delegates only some types back to Foundry layers.
- Dragover currently forces `dropEffect='copy'`, which may diverge from system-specific drag semantics.

### Parity verdict
**Partial (medium-high).**

---

## 2) Global Parity Matrix (adventure safety)

- **Targeting (T + hover + indicators):** ✅ Implemented (WP-1) — pending live validation
- **Ruler in gameplay token flow:** ✅ Implemented (WP-2) — input router routes to PIXI for ruler tool
- **Ping (local initiation):** ✅ Implemented (WP-3) — long-press ping from Three
- **Multiplayer cursor/ruler activity broadcast:** ✅ Implemented (WP-7) — throttled cursor broadcast
- **Token HUD open/position:** Implemented - **OK**
- **Notes gameplay interaction:** ✅ Implemented (WP-5) — double-click opens journal
- **Notes visibility/permission parity:** ✅ Implemented (WP-6) — journal permission + vision check
- **Templates gameplay visibility:** ✅ Implemented (WP-6) — hidden/author visibility filtering
- **Template hidden/author visibility parity:** ✅ Implemented (WP-6)
- **Template geometry fidelity vs Foundry:** ✅ System-specific cone angles via GameSystemManager (53.13° DnD5e, 90° PF2e)
- **Templates edit workflow (template layer):** Implemented via PIXI routing
- **Core keyboard parity in gameplay:** ✅ Targeting (T) and delete safety implemented; ruler (R) routed
- **Delete key combat-safe confirmation parity:** ✅ Implemented (WP-8) — `_confirmDeleteKey` flow
- **D&D5e/PF2e target/control workflow compatibility:** ✅ GameSystemManager adapter pattern — vision, HP, AC, movement, initiative, conditions, defeated state
- **Canvas drag/drop parity across document types:** ✅ Improved (XM-2) — canonical drag parser + canonical coordinate mapping + native Actor/Tile delegation + Macro support
- **Door controls and interaction:** Implemented
- **Cross-module hook parity (hoverToken):** ✅ Implemented (XM-1) — layer.hover, hoverToken hook, combat tracker sync
- **Cross-module hook parity (dropCanvasData):** ✅ Implemented (XM-2) — modules can intercept/modify drops
- **libWrapper compatibility:** ✅ Implemented (XM-3) — Canvas.tearDown uses libWrapper if available
- **Token drag workflow (PIXI path):** Not applicable — Map Shine uses pathfinding, not PIXI drag
- **Alt highlight objects:** ✅ Implemented (XM-5) — Three token borders now mirror Foundry highlight-all state

---

## 2.5) Cross-Module Compatibility Investigation

### XM-1 hoverToken hook + layer.hover sync (CRITICAL — fixed)

**Problem:** When Three.js InteractionManager handles token hover, it set `this.hoveredTokenId` and called `tokenManager.setHover()` for Three.js visuals, but never:
- Fired `Hooks.callAll('hoverToken', token, true/false)` — breaking all modules listening to this hook
- Set `canvas.tokens.hover = token` (Foundry's `PlaceablesLayer.hover`) — breaking modules that read hover state
- Set `token.hover = true` on the PIXI placeable — breaking Foundry's internal hover tracking
- Called `ui.combat.hoverCombatant()` — breaking combat tracker hover highlighting
- Called `canvas.perception.update({refreshOcclusion: true})` — breaking hover-based occlusion mode

**Modules broken:** Token Info, Health Estimate, PF2e hover effects, combat tracker hover, any module using `hoverToken` hook.

**Fix:** Added `_syncFoundryHoverIn(tokenId)` and `_syncFoundryHoverOut(tokenId)` to `InteractionManager`. These mirror `PlaceableObject._onHoverIn/Out`:
- Set/clear `layer.hover` and `token.hover` on the PIXI placeable
- Fire `Hooks.callAll('hoverToken', fvttToken, true/false)`
- Call `ui.combat.hoverCombatant()` for combat tracker sync
- Call `canvas.perception.update({refreshOcclusion: true})` for hover occlusion mode

### XM-2 dropCanvasData hook not fired (CRITICAL — fixed)

**Problem:** `DropHandler.onDrop()` intercepted drops on the Three.js canvas and processed them directly without firing `Hooks.call('dropCanvasData', canvas, data, event)`. Foundry fires this hook in `Canvas._onDrop` *before* processing any drop, allowing modules to intercept or modify the drop.

**Modules broken:** Item Piles, Monk's Active Tiles, Loot Sheet NPC, any module that hooks `dropCanvasData`.

**Fix:**
- Added `Hooks.call('dropCanvasData', canvas, data, event)` check before the drop type switch. If any hook returns `false`, the drop is prevented (matching Foundry's behavior).
- Switched to Foundry's canonical drag parser (`TextEditor.implementation.getDragEventData`) before JSON fallback.
- Switched to Foundry's canonical client→canvas coordinate conversion (`canvas.canvasCoordinatesFromClient`) before fallback math.
- Delegated Actor and Tile drops to native Foundry layer handlers when available:
  - `canvas.tokens._onDropActorData(event, data)`
  - `canvas.tiles._onDropData(event, data)`
- Added Macro drop handling (`game.user.assignHotbarMacro`) to match Foundry's canvas drop switch.

### XM-3 Canvas.tearDown wrapped without libWrapper (HIGH — fixed)

**Problem:** `canvas-replacement.js` wrapped `Canvas.prototype.tearDown` directly by replacing it on the prototype. If libWrapper is installed, other modules' wrappers might not chain correctly since we bypass libWrapper's wrapper chain.

**Fix:** Now checks for `globalThis.libWrapper` and uses `libWrapper.register('map-shine-advanced', 'Canvas.prototype.tearDown', wrapper, 'WRAPPER')` if available. Falls back to direct prototype wrap if libWrapper is not installed.

### XM-4 Token drag workflow not available (KNOWN LIMITATION — by design)

**Status:** Not fixable / by design.

When Map Shine handles token movement (click-to-move pathfinding), it updates token documents directly via `updateEmbeddedDocuments`. This fires document hooks (`updateToken`) but NOT the PIXI drag workflow events (`_onDragLeftStart`, `_onDragLeftMove`, `_onDragLeftDrop`). Modules that specifically hook into the PIXI drag workflow (like Drag Ruler) won't see Map Shine movements. However, since Map Shine uses a fundamentally different movement model (pathfinding), this is expected.

**Mitigation:** Modules should use `updateToken` / `preUpdateToken` hooks (which fire correctly) rather than PIXI drag events for movement detection.

### XM-5 Alt key highlight objects (MEDIUM — fixed)

**Status:** Implemented.

Foundry's `ClientKeybindings.#onHighlight` fires on Alt press/release → `canvas.highlightObjects(active)` → iterates all layers and calls `layer._highlightObjects(active)` → fires `Hooks.callAll('highlightObjects', active)`.

Map Shine now mirrors this in Three token overlays via `TokenManager`:
- Tracks `highlightObjects` hook state
- Refreshes token overlay visibility when highlight toggles
- Shows token borders for selected/hovered/highlighted states
- Uses Foundry disposition colors (`CONFIG.Canvas.dispositionColors`) for parity

This closes the previous visual gap where PIXI highlight borders were invisible due to transparent PIXI token meshes.

### XM-6 Tab key token cycling (MEDIUM — Foundry-handled)

**Status:** Working via Foundry keybindings.

Tab key is handled by Foundry's `ClientKeybindings.#onCycleView` → `canvas.activeLayer._onCycleViewKey()` → `TokenLayer.cycleTokens()`. Map Shine's `onKeyDown` only consumes specific keys (T, Delete, Backspace, copy/paste) and lets Tab pass through to Foundry's keybinding system. `cycleTokens()` calls `token.control()` which fires `controlToken` hook and syncs with Three.js selection.

### XM-7 Custom module layers (LOW — preserved)

**Status:** Working.

`LayerVisibilityManager.detectCustomLayers()` scans `CONFIG.Canvas.layers` for non-standard layers added by modules and preserves their visibility (always visible). This ensures modules that add custom canvas layers (like weather overlays, grid overlays, etc.) continue to render.

---

## 3) Work Packages (implementation plan)

## WP-1 (P0): Token Targeting Parity

### Scope
- Implement Three gameplay targeting to match Foundry semantics:
  1. `T` on hovered token toggles target.
  2. Shift behavior preserves existing targets.
  3. Broadcast path uses Foundry target APIs.
  4. Visual target indicators are present in Three.

### Implementation notes
- Add `target` key handling to `InteractionManager.onKeyDown`.
- Resolve hovered token from Three hover state (`hoveredTokenId`) and call Foundry API (`token.setTarget(...)` or `canvas.tokens.setTargets(...)`).
- Add a Three target indicator renderer in `TokenManager` (arrows/pips equivalent), keyed off authoritative target state.
- Hook target updates from Foundry user activity to refresh Three indicator state.

### Implementation status
- **Started (partial complete).**
- Completed code paths:
  - `scripts/scene/interaction-manager.js` key handler now bridges `T` targeting to Foundry token APIs.
  - `scripts/scene/token-manager.js` now creates/refreshes Three target indicators and listens to `targetToken` hook updates.
- Remaining:
  - Live multiplayer validation and visual parity tuning.

### Acceptance
- With token layer active in gameplay, `T` targets hovered token with immediate visual feedback.
- Shift+T adds/removes without clearing others.
- Multi-user pips equivalent visible.

---

## WP-2 (P0): Gameplay Ruler Parity

### Scope
- Restore ruler usability when token layer is in Three mode.

### Implementation options
1. **Bridge approach (recommended):**
   - Keep token-layer input in Three, but proxy ruler interactions into Foundry ruler APIs.
2. **Routing approach (fallback):**
   - When active tool is `ruler`, route token layer to PIXI mode.

### Acceptance
- `R` toggles ruler and drag-to-measure works in gameplay.
- Waypoints and labels match Foundry behavior.
- No regression to token move interaction.

---

## WP-3 (P1): Ping Parity

### Scope
- Implement local ping initiation from Three gameplay interaction.

### Implementation notes
- Add long-press or explicit ping trigger in Three interaction path and call `canvas.ping(worldPos)`.
- Respect Foundry permissions and token-layer constraints where needed.

### Acceptance
- Local ping works in gameplay mode.
- Other users see ping; local user sees same visual style/timing.

---

## WP-4 (P1): Notes Gameplay Interaction Parity

### Scope
- Note hover/click/open journal parity while in gameplay mode.

### Implementation notes
- Add note hit-test channel in `InteractionManager` and map to Foundry note open behavior (page/image handling delegated to Foundry docs/sheets where possible).
- Keep permissions and visibility checks aligned with Foundry.

### Acceptance
- Players can interact with visible notes in gameplay without switching to notes layer.

---

## WP-5 (P1): Keyboard Parity Audit + Bridge

### Scope
- Build explicit bridge for high-value core actions that currently assume PIXI hover/layer state.

### Initial list
- Target, ruler, ping, cycle view interactions dependent on active layer/hover semantics.

### Acceptance
- Core keys relevant to encounter play work in gameplay mode.

---

## WP-6 (P2): Templates and overlay interaction policy cleanup

### Scope
- Decide and document expected gameplay behavior for templates/notes/drawings:
  - view-only in gameplay vs interactable in gameplay,
  - edit-only in corresponding layer.

### Acceptance
- Behavior is explicit, documented, and consistent with input routing rules.

---

## WP-7 (P1): Multiplayer activity bridge (cursor + ruler)

### Scope
- Restore gameplay-mode parity for user activity channels that normally flow through ControlsLayer:
  - cursor broadcast,
  - ruler broadcast/updates.

### Implementation notes
- Add a Three gameplay bridge that delegates to Foundry activity APIs (`game.user.broadcastActivity`) in the same schema expected by core consumers.
- Keep Foundry as source-of-truth for drawing remote cursors/rulers where possible.

### Acceptance
- Other connected users see live cursor and ruler updates from gameplay-mode users.

---

## WP-8 (P0): Delete key safety parity

### Scope
- Ensure gameplay delete behavior preserves Foundry safety/confirmation semantics.

### Implementation notes
- Route token delete through Foundry token-layer delete pipeline (or call equivalent confirmation API) instead of direct unconditional document deletion.
- Preserve combatant delete warning behavior.

### Implementation status
- **Started (partial complete).**
- Completed code paths:
  - `scripts/scene/interaction-manager.js` now routes token delete through Foundry token-layer confirmation flow (`_confirmDeleteKey`) before deleting selected token docs.
- Remaining:
  - Validate combat warning prompt parity and mixed-object selection edge cases.

### Acceptance
- Deleting tokens involved in combat prompts the same warning/confirmation behavior as core Foundry.

---

## WP-9 (P1): System compatibility hardening (dnd5e/pf2e)

### Scope
- Validate and harden launch-critical interoperability against bundled top systems.

### Focus checks
- dnd5e target-aware chat/HUD flows (`game.user.targets`, `targetToken` hook paths).
- dnd5e selected-token workflows (`canvas.tokens.controlled`).
- pf2e selected-token macro/action workflows.

### Acceptance
- Core encounter workflows in dnd5e and pf2e run in gameplay mode without target/control regressions.

---

## WP-10 (P2): Drop behavior parity expansion

### Scope
- Expand/normalize Three-side drag/drop handling to better match Foundry layer behavior.

### Implementation notes
- Audit unsupported drop types and either:
  1. delegate to native layer `_onDropData` paths, or
  2. implement equivalent Foundry API-backed creation flow.
- Revisit dragover `dropEffect` policy to avoid forcing copy semantics globally.

### Acceptance
- Common canvas drag/drop workflows used in adventures/systems behave consistently in gameplay mode.

---

## 4) Regression Test Plan

## Manual adventure-ready scenarios
1. Select token A, hover token B, press `T` (and Shift+T variants).
2. Use ruler in gameplay without switching to map maker.
3. Send pings during active encounter movement.
4. Open token HUD in gameplay and toggle target from HUD button.
5. Open notes in gameplay (observer and non-observer permission cases).
6. Verify door controls continue to work after parity changes.
7. Confirm delete-key behavior for tokens in combat shows Foundry-equivalent safety confirmation.
8. Two-user test: verify remote cursors and ruler paths are visible in gameplay mode.
9. Verify hidden templates and non-owned notes follow Foundry visibility/permission behavior.
10. dnd5e: validate target-aware chat flows using `game.user.targets` and selected-token fallback.
11. pf2e: validate selected-token-dependent utility/macro workflows.

## Instrumentation
- Add focused `[Parity]` debug logs for target, ruler, ping, note visibility/open, delete safety, and activity broadcast flows.
- Keep logs low-noise and keyed by token/note id.

---

## 5) Risks and mitigations

- **Risk:** Fighting Foundry state by re-implementing too much logic in Three.
  - **Mitigation:** Delegate authoritative state transitions to Foundry APIs; Three renders mirrors.
- **Risk:** Input routing conflicts between PIXI and Three.
  - **Mitigation:** Keep a single source-of-truth routing policy per tool; add explicit tests for tool switches.
- **Risk:** Multiplayer desync in targeting/pings.
  - **Mitigation:** Use Foundry broadcast paths (`setTargets`, `canvas.ping`) rather than local-only state.
- **Risk:** Information leakage from note/template visibility mismatch.
  - **Mitigation:** Reuse Foundry visibility/permission predicates (or direct placeable visibility state) as authoritative gate.
- **Risk:** System-level regressions (dnd5e/pf2e) despite core parity.
  - **Mitigation:** Add explicit system compatibility test matrix before launch tag.

---

## 6) Recommended execution order

1. WP-1 Targeting parity (blocker)
2. WP-2 Ruler parity (blocker)
3. WP-8 Delete safety parity (blocker)
4. WP-4 Notes gameplay interaction + visibility parity
5. WP-3 Ping parity
6. WP-7 Multiplayer activity bridge
7. WP-5 Keyboard bridge hardening
8. WP-9 System compatibility hardening (dnd5e/pf2e)
9. WP-6/WP-10 policy + drop parity cleanup

---

## 7) Source anchors used for this deep dive

### Foundry VTT source
- `foundryvttsourcecode/resources/app/client/helpers/interaction/client-keybindings.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/placeables/token.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/layers/tokens.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/layers/controls.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/board.mjs`
- `foundryvttsourcecode/resources/app/client/documents/user.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/interaction/ruler/base-ruler.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/interaction/ruler/ruler.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/layers/templates.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/placeables/template.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/layers/notes.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/placeables/note.mjs`
- `foundryvttsourcecode/resources/app/client/applications/hud/token-hud.mjs`

### Map Shine code
- `scripts/scene/interaction-manager.js`
- `scripts/scene/token-manager.js`
- `scripts/scene/token-movement-manager.js`
- `scripts/foundry/input-router.js`
- `scripts/foundry/controls-integration.js`
- `scripts/foundry/layer-visibility-manager.js`
- `scripts/foundry/drop-handler.js`
- `scripts/foundry/mode-manager.js`
- `scripts/scene/template-manager.js`
- `scripts/scene/note-manager.js`

### Game systems source
- `gamesystemsourcecode/dnd5e/dnd5e.mjs`
- `gamesystemsourcecode/dnd5e/system.json`
- `gamesystemsourcecode/pf2e/pf2e.mjs`
- `gamesystemsourcecode/pf2e/system.json`
