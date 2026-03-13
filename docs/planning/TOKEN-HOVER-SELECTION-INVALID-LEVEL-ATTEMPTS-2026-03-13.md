---
title: Token Hover/Selection + Invalid Level Incident Log
date: 2026-03-13
status: open
owner: map-shine
---

# Token Hover/Selection + Invalid Level Incident Log

## Current Unresolved Problems

1. Tokens cannot be reliably hovered and left-click selected immediately after being dropped, or right after initial scene load.
2. Certain tokens (most often NPC tokens) still trigger an invalid-level render state when selected (especially via marquee selection), while some PC tokens do not.

## What Has Been Tried So Far (No Final Resolution Yet)

### A) Token creation/drop elevation seeding
- Added token level defaults on create via `preCreateToken` to seed missing floor data.
- Added actor drop elevation seeding in drop handler before native Foundry token creation.
- Updated drop seeding to prefer runtime perspective elevation first, then active-band fallback.
- Result: did not resolve invalid-level behavior.

### B) Token level metadata strategy
- Introduced token `applyTokenLevelDefaults` helper.
- Seeded token `elevation`, `flags.levels.rangeBottom`, and `flags.levels.rangeTop` initially.
- Later changed token defaults to elevation-only (no range flags).
- Added single-level safeguard to strip token range flags in create payload.
- Result: diagnostics looked cleaner in some cases but invalid-level issue still reproduced for certain NPC tokens.

### C) Selection-time level sync policy (camera follower)
- Patched `controlToken` and controlled-token `updateToken(elevation)` hooks to respect lock-mode policy.
- Intended behavior: manual GM floor selection should not be overwritten by token control.
- Result: issue still reproduced.

### D) Levels perspective bridge hardening
- Added manual-mode reassertion on `levelsPerspectiveChanged`.
- Added deferred reassertion on `controlToken` to restore manual perspective after control settles.
- Reassertion includes restoring wall-height elevation and clearing `CONFIG.Levels.currentToken` in manual mode.
- Result: diagnostics showed manual context retained, but invalid-level issue still reproduced.

### E) Selection bridge reassertion
- Added manual perspective reassertion inside controlled-set application after token control/release sync.
- Result: no final fix.

### F) Hover/select interaction flow and raycast availability
- Made newly created token sprites raycastable immediately (`visible=true`, `opacity=0`) to avoid first-frame non-interactive state.
- Queued immediate visibility refresh from VisibilityController after token creation.
- Limited overhead tile hover suppression so it only blocks deeper hover while Tiles workflow is active.
- Result: improved behavior in some scenarios, but left-click token selection remained unreliable.

### G) PointerDown UI-gate false-positive mitigation
- Adjusted InteractionManager UI gate to allow canvas-originated clicks even when UI stack probing flags `isUiEvent`.
- Added additional diagnostics (`targetHitsCanvas`, `insideCanvas`) to pointer-down UI gate logs.
- Result: selection still intermittently blocked or inconsistent.

### H) Token snapping / movement parity (related but not root cause)
- Updated token snap logic for multi-cell tokens to use top-left anchoring (`TOP_LEFT_CORNER`) in drag preview and movement manager.
- Result: improved placement alignment, but did not solve hover/selection invalid-level incident.

## Observed Pattern Worth Investigating Next

- PC vs NPC behavior diverges:
  - Some PC tokens eventually work with fewer side effects.
  - NPC tokens (copied from actor drops, often with fresh token docs each time) are more likely to trigger invalid-level rendering when selected.
- Marquee selection can trigger invalid-level behavior even when direct hover/click is unreliable.
- Latest diagnostics show:
  - `lockMode: manual`
  - single active level context (`count: 1`, `0..10`)
  - `CONFIG.Levels.currentToken: null`
  - token elevation appears valid
  - yet invalid-level rendering still occurs for certain selected NPCs.

## Resolution & Findings

### 1. "Invalid Level" Render State on NPC Selection
**Root Cause:**
The failure was a **vision-capability mismatch inside `FogOfWarEffectV2`**:

1. `_shouldBypassFog()` used game-system-aware checks (`gameSystem.hasTokenVision(token)`) and therefore treated certain NPCs as having vision capability.
2. `_renderVisionMask()` used `token.document.sight.enabled` directly when deciding whether to render LOS polygons.

For systems like PF2e, these checks can disagree. Result: fog bypass stays **off** (because token is considered vision-capable), but the token is simultaneously treated as **no-sight** during mask generation, so no LOS polygon is rendered. That yields a black/empty vision mask, i.e. full fog over the scene.

This plunged the GM into sudden fog. While it might be expected for fog to be black, the visual symptom was actually a **solid canvas grey with grid lines and other UI elements still visible**. This exactly mimics an "invalid floor" render breakdown, but is in fact the correct architectural behavior of the V2 compositor:
1. Foundry's default unexplored fog color (or scene background blend) is often grey, not black.
2. The fog completely covers all scene geometry (tiles, background image, tokens).
3. `FloorCompositor` intentionally renders the PIXI UI overlay (which contains the grid lines, token borders, and controls) *last*, directly on top of all post-processing including fog.

Thus, selecting those NPCs drew a solid grey fog plane over the entire map, while the UI overlay continued drawing the grid/selection/door icons on top. This matches the reported symptom: scene color pass appears gone while overlay/fog remains.

**Fix:**
Standardized fog token vision checks to use one shared helper (`_tokenHasVisionCapability`) in both places:
- `_shouldBypassFog()`
- `_renderVisionMask()` token classification

This keeps fog bypass policy and vision-mask generation in sync for all systems/adapters.

### 2. Token Hover/Selection Failing Immediately After Drop
**Root Cause:**
In the V2 compositor architecture, tokens are isolated to specific floor layers (e.g., layers 1–19) using `FloorLayerManager.assignTokenToFloor()`. However, the Three.js hit-testing logic in `InteractionManager` (`onPointerDown` and `_handleHoverThreeTokens`) was manually enabling only layer 0 and `OVERLAY_THREE_LAYER` (layer 31) for the raycaster. This meant the raycaster was completely blind to tokens rendered on V2 floor layers.

**Fix:**
Updated the raycaster setup in `InteractionManager` for token left-click, right-click, and hover events to use a full bitmask (`this.raycaster.layers.mask = 0xffffffff`), allowing it to successfully intersect tokens regardless of which V2 floor layer they are assigned to.

## Conclusion

The core incident now resolves into two independent causes:
1. Raycast layer filtering caused initial hover/selection misses.
2. Fog vision-capability mismatch caused full-fog scene suppression when selecting certain NPCs.

Both are now addressed in code and should be re-validated in-scene.
