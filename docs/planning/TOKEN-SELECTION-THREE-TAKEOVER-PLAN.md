# Token Selection Takeover Plan (Three.js-Only, No PIXI Input Dependency)

## Date: 2026-03-06

---

## 1. Goal

Remove Foundry PIXI token-selection dependency from gameplay mode and make token selection fully owned by MapShine Three.js interaction.

### Explicit outcomes

1. Token click-select works on first scene load without tool toggles, alt-tab, or keyboard nudges.
2. Drag-marquee selection works entirely through existing Three.js selection box rendering.
3. Selection behavior does not depend on PIXI canvas `pointerEvents`, board visibility, or startup timing races.
4. Foundry still receives correct controlled-token state for compatibility with sheets, ownership, targeting, movement, and other systems.

---

## 2. Why this is needed

The recurring regression pattern shows startup/tool/input arbitration between Foundry PIXI and Three.js keeps drifting over time:

- A fix restores startup selection.
- Another change in suppression/routing/tool logic re-breaks token select.
- Wall/light edit workflows remain stable while token workflows regress.

Root issue: token selection is currently split across two ownership models (PIXI-native + Three route). We need one authoritative path.

---

## 3. Architecture decision

## Decision: **Three.js owns token selection and marquee in gameplay mode**

PIXI is no longer used as the authority for token selection in gameplay. Foundry is treated as a **state sink** (controlled token state is synchronized into Foundry APIs), not as the interactive source.

### Keep from current system

- Existing SelectionBox visuals/effects (already implemented and good).
- Existing Three raycasting/token hit-testing.
- Existing token overlay rendering pipeline.

### Remove from token-select path

- Any need for PIXI token layer interactivity during gameplay token tool.
- Startup dependency on `activeLayer`/`activeTool` settling to allow token control.
- Foundry marquee (`controls.drawSelect`) as a required feature for token selection.

---

## 4. Proposed system design

## 4.1 Selection authority module

Create a dedicated service:

- `scripts/scene/token-selection-controller.js` (new)

Responsibilities:

1. Own token selection state in gameplay mode.
2. Handle click select, additive/subtractive modifiers, and marquee selection set operations.
3. Emit selection-change events.
4. Sync authoritative selection into Foundry controlled-token state.

Core methods:

- `selectSingle(tokenId, { additive, toggle, range })`
- `selectByMarquee(worldRect, { additive, subtractive })`
- `clearSelection({ preserveIfOwned })`
- `getSelectedTokenIds()`
- `syncToFoundry()`

## 4.2 Integration points

1. `InteractionManager`
   - Pointer down/move/up for click and marquee should always route to `TokenSelectionController` when token tool is active in gameplay mode.
   - Existing selection box visuals stay where they are; geometric selection result delegates to controller.

2. `TokenManager`
   - Provide token lookup helpers needed by controller:
     - world bounds for each token
     - visibility/selectability checks
     - token id -> sprite/document mapping

3. Foundry bridge layer
   - Programmatically apply selection via Foundry token APIs (control/release), not via PIXI pointer interaction.
   - Ensure compatibility with external modules that watch controlled token changes.

---

## 5. Selection behavior spec (parity target)

## 5.1 Click selection

- Left click token: single select (release others).
- Shift+click token: additive select.
- Ctrl/Cmd+click token: toggle token in set.
- Empty click: clear selection (unless dragging started).

## 5.2 Marquee selection

- Drag rectangle in screen space; convert to world bounds for intersection testing.
- Default drag: replace selection with tokens intersecting marquee.
- Shift+drag: additive union.
- Ctrl/Cmd+drag: subtractive (remove intersecting).

## 5.3 Filtering

Only selectable tokens participate:

- User has at least observer/control permission according to existing gameplay rules.
- Token on active visible floor (respect current Levels filtering rules).
- Token is visible/selectable according to MapShine visibility model.

## 5.4 Non-goals (phase 1)

- Targeting ring parity with Foundry target tool (can be phase 2).
- Measurement/ruler replacement.
- HUD redesign.

---

## 6. Foundry compatibility strategy

Even with Three-owned interaction, we preserve Foundry compatibility:

1. On selection change, call Foundry control/release APIs on token placeables.
2. Avoid direct mutation of private internals where possible.
3. Keep controlled state mirrored so external modules/sheets/hotkeys continue to work.
4. Add a small guard to avoid infinite loop if Foundry emits control hooks back to us.

Suggested bridge utility:

- `scripts/foundry/selection-bridge.js` (new)
  - `applyControlledSet(tokenIds)`
  - diff current vs desired controlled set
  - minimal control/release calls

---

## 7. Input ownership simplification

After token takeover:

1. Token tool in gameplay mode never needs PIXI pointer routing.
2. PIXI arbitration table only keeps true PIXI-edit tools (walls, lighting, templates, drawings, etc.).
3. Remove token-specific branches from:
   - `updateInputMode()` token edit checks
   - gameplay PIXI suppression token exceptions
   - select-rect suppression token-native assumptions

This significantly reduces startup race surface area.

---

## 8. Implementation phases

## Phase A — Build controller behind feature flag

1. Add setting: `threeTokenSelectionAuthority` (default ON in dev, OFF in fallback until validated).
2. Implement `TokenSelectionController` with unit-like runtime diagnostics.
3. Hook InteractionManager click/marquee path to controller when flag ON.
4. Keep legacy path available for rollback while testing.

Acceptance:

- Click and marquee work in fresh load without PIXI input ownership.

## Phase B — Foundry sync hardening

1. Implement `selection-bridge.js` diff-based controlled-set sync.
2. Validate compatibility with:
   - token HUD opening
   - actor sheet interactions
   - movement commands on selected group
   - common control hooks

Acceptance:

- Controlled token behavior matches expected Foundry side effects.

## Phase C — Remove token dependence from arbitration

1. Delete token-specific PIXI arbitration branches in gameplay mode.
2. Keep walls/lights/tool overlays routed as needed.
3. Keep startup settle watcher only for true PIXI-edit tools.

Acceptance:

- Token selection remains stable while walls/lights still function.

## Phase D — Cleanup and docs

1. Remove dead token-native suppression code.
2. Document final ownership matrix (tool -> input owner).
3. Update incident log with final resolution and retired failure modes.

---

## 9. Risks and mitigations

1. **Risk:** Foundry module expects PIXI-origin token control events.
   - Mitigation: use official control/release APIs and hook parity checks.

2. **Risk:** Selection desync between Three state and Foundry state.
   - Mitigation: single authority + diff sync + post-apply verification logs in dev mode.

3. **Risk:** Floor filtering mismatch (Levels).
   - Mitigation: reuse existing active-level helpers from interaction/visibility services.

4. **Risk:** Regression in right-click group movement.
   - Mitigation: ensure movement pipeline consumes selected token docs from authority state (or Foundry mirrored state) consistently.

---

## 10. Test matrix (must pass)

## Startup stability

- Fresh load -> immediate click-select
- Fresh load -> immediate marquee select
- No alt-tab/tool-toggle workaround needed

## Tool transitions

- Token -> Walls -> Token
- Token -> Lighting -> Token
- Selection still stable after switching back

## Floors / Levels

- Ground floor selection
- Upper floor selection
- Mixed visibility scene (only active floor selectable)

## Multi-user basics

- GM and player ownership boundaries respected
- Controlled token state updates visible to client systems

## Performance

- No measurable hitch on marquee over 100+ tokens
- No repeated control/release spam when selection unchanged

---

## 11. Definition of done

1. Token selection in gameplay has zero runtime dependence on PIXI input routing.
2. Startup regressions tied to token selection arbitration are eliminated.
3. Foundry controlled-token compatibility remains intact.
4. Token selection path is documented as Three-authoritative in code + planning docs.
