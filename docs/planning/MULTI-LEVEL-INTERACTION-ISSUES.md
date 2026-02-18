# Multi-Level Token Interaction Issues

## Overview

With tokens now existing on multiple elevation levels (floors), many VTT interactions
that previously assumed a flat 2D world can produce incorrect or confusing results.
This document catalogs every interaction surface affected, the current state of
level-awareness in each, and recommended fixes.

**Core concept**: `window.MapShine.activeLevelContext` defines the currently viewed
floor via `{ bottom, top, center, count, index, lockMode }`. Tokens with elevation
outside the active band should be treated as "not on this floor" for most
interaction purposes.

---

## 1. Current Level-Awareness Inventory

### What Already Works

| System | File(s) | Status |
|---|---|---|
| Token **visibility** (rendering) | `VisibilityController._isTokenAboveCurrentLevel`, `token-manager.js` L1314-1326 | ✅ Hides tokens above active level top |
| Tile **visibility** | `tile-manager.js` `isElevationWithinActiveBand` | ✅ Filters tiles by active level band |
| Template **visibility** | `template-manager.js` `_isTemplateVisible` | ✅ Elevation range gating via Levels flags |
| Template **creation defaults** | `template-manager.js` `_onPreCreateMeasuredTemplate` | ✅ Seeds elevation + range from active level |
| **Level navigation** (floor switching) | `camera-follower.js` | ✅ Full: keyboard, dropdown, follow-token mode |
| **Perspective elevation** (canonical) | `elevation-context.js` `getPerspectiveElevation()` | ✅ Controlled token > active level > background |
| Fog **exploration reset** on floor change | `WorldSpaceFogEffect.js` | ✅ Via `mapShineLevelContextChanged` hook |
| Vision **wall-height LOS** | `VisionPolygonComputer.js` | ✅ Walls filtered by viewer elevation |
| Token **elevation scale** | `token-manager.js` `updateSpriteTransform` | ✅ Scales by distance from viewer elevation |
| Pathfinding **wall-height** | `token-movement-manager.js` `_collisionResultBlocksAtElevation` | ✅ Skips walls outside token elevation |

### What Does NOT Work (Gaps)

These are the interactions that currently have **no level filtering** and will
produce incorrect behavior in multi-level scenes.

---

## 2. Gap Analysis — Interaction-by-Interaction

> **Important — Revised Interaction Philosophy (see §8)**:
> Click-select and raycast interactions should allow selecting ANY visible token,
> even on a different floor. If you can see it, you can click it.
> Drag-select is the bulk action that must be floor-aware to prevent accidents.
> For tokens on other floors, drag-select uses **tile occlusion testing** (§9)
> to determine if the token is visible through a transparent area of the floor
> graphic — if it is, include it; if covered by an opaque tile, skip it.

### 2.1 DRAG SELECT (P0 — Critical)

**File**: `interaction-manager.js` L4698-4724

**Problem**: Drag selection iterates `tokenManager.getAllTokenSprites()` and selects
every token whose sprite center falls within the 2D selection box — regardless of
elevation. A user drag-selecting on Floor 1 will accidentally select tokens on Floor 0
that happen to overlap in XY position.

**Current code** (no elevation check):
```js
for (const sprite of tokens) {
  const x = sprite.position.x;
  const y = sprite.position.y;
  if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
    if (tokenDoc.canUserModify(game.user, "update")) {
      this.selectObject(sprite);
    }
  }
}
```

**Revised fix** (tile occlusion approach — see §9 for full design):
For tokens NOT on the active level, check if any floor tile on the current or
higher floor covers the token's XY position with opaque pixels. If occluded by
a solid floor tile → skip. If NOT occluded (transparent area, hole, no tile
covering that spot) → include, because the user can see the token.

```js
if (!sprite.visible) continue;
const tokenDoc = sprite.userData.tokenDoc;

// Always include tokens on the active level
if (!isTokenOnActiveLevel(tokenDoc)) {
  // Token is on a different floor — check tile occlusion
  if (isTokenOccludedByFloorAbove(tokenDoc, sprite.position.x, sprite.position.y)) {
    continue; // solid floor covers this token, skip it
  }
  // else: token is visible through a gap/hole, include it
}

if (tokenDoc.canUserModify(game.user, "update")) {
  this.selectObject(sprite);
}
```

**Why not a simple elevation filter?**
A naive "skip all non-active-level tokens" would break maps with balconies,
open stairwells, multi-level outdoor terrain, or any scene where floor tiles
have transparent regions. Tile occlusion testing makes drag-select match
what the user actually sees.

---

### 2.2 CLICK SELECT / RAYCAST HIT (No change needed)

**File**: `interaction-manager.js` L2862-2934

**Original concern**: Left-click token selection raycasts against all token sprites.

**Revised assessment**: Three.js `Raycaster` already skips objects with
`visible=false`. Since `_isTokenAboveCurrentLevel` sets `sprite.visible = false`
for tokens above the active level, those tokens cannot be clicked. Tokens
**below** the current level remain visible (by design — you're looking down
at them). The user explicitly wants to be able to click any visible token,
even one on a lower floor: **"I want to be able to click on a token if I can
see it and select it even if it's on the floor below."**

**Status**: ✅ Already works correctly. No filtering needed.

**Edge case**: If two visible tokens from different floors overlap in XY, the
raycaster returns the one with the highest Z (closest to camera). This is
correct behavior — the top-floor token occludes the bottom-floor one visually,
so clicking should select the top one.

---

### 2.3 HOVER / TOOLTIP (No change needed)

**File**: `interaction-manager.js` L3590-3631 (`handleHover`)

**Original concern**: Token hover raycasting might show tooltips for wrong-floor tokens.

**Revised assessment**: Same logic as 2.2 — raycaster already skips `visible=false`
sprites. Tokens below are visible by design and the user should be able to hover
them. The raycaster's Z-depth sorting ensures the topmost (closest to camera) token
wins, which is the correct visual behavior.

**Status**: ✅ Already works correctly. No filtering needed.

---

### 2.4 RIGHT-CLICK TOKEN HUD (No change needed)

**File**: `interaction-manager.js` L2548-2569

**Original concern**: Right-click may open HUD for wrong-floor token.

**Revised assessment**: Same as 2.2/2.3 — raycaster skips invisible sprites, and
right-clicking a visible token on a lower floor is valid. If you can see it, you
can right-click it.

**Status**: ✅ Already works correctly.

---

### 2.5 TOKEN TARGETING (T key) (No change needed)

**File**: `interaction-manager.js` L5172-5196

**Original concern**: T-key targeting could target wrong-floor tokens.

**Revised assessment**: Targeting relies on `this.hoveredTokenId`, which comes
from the hover raycast. Since hover already works correctly (2.3) — only visible
tokens can be hovered, and the raycaster picks the topmost Z — targeting naturally
follows the same "if you can see it, you can target it" rule.

**Status**: ✅ Already works correctly via hover path.

**Future consideration**: 3D distance checks for targeting (e.g., preventing
targeting through solid floors) could be a later enhancement but is not a
regression from current behavior.

---

### 2.6 PATHFINDING — STATIC OCCUPANCY (P1 — Important)

**File**: `token-movement-manager.js` L7565-7578

**Problem**: `_collectStaticTokenOccupancyRects` collects ALL tokens in the scene
as obstacles for group movement planning. Tokens on other floors should not be
treated as occupying the same space — a token on Floor 2 should not block a
movement destination on Floor 0.

**Fix**: Filter by elevation — only include tokens whose elevation falls within the
same level band as the moving token(s), or within some tolerance.

```js
for (const doc of tokenDocs.values()) {
  if (movingIds?.has?.(doc.id)) continue;
  const docElev = Number(doc?.elevation ?? 0);
  // Skip tokens on different floors
  if (Math.abs(docElev - movingTokenElev) > floorThreshold) continue;
  out.push(this._buildTokenRect(...));
}
```

---

### 2.7 PATHFINDING — NAVIGATION GRAPH (P2 — Medium)

**File**: `token-movement-manager.js` `_buildFullSceneNavGraph`, `generateMovementGraph`

**Problem**: The precomputed scene navigation graph (`_sceneNavGraphCache`) is keyed
by token collision size but **not by elevation**. Walls with `wall-height` flags
that only exist at certain elevations are evaluated at collision time via
`_collisionResultBlocksAtElevation`, which correctly reads the moving token's
elevation. However, the **cached graph** assumes all walls always apply, so a graph
built for Floor 0 (where certain walls exist) may incorrectly block paths on Floor 2
(where those walls have no height range), or vice versa.

**Fix**: Key the cache by `sizeKey + elevationBand`, or invalidate when the active
level changes. The `_validatePathSegmentCollision` already passes `collisionElevation`
to wall-height checks, so the dynamic graph path is correct — but the cache is not.

---

### 2.8 GROUP MOVEMENT — CROSS-FLOOR SELECTION (P1 — Important)

**File**: `interaction-manager.js` `_getSelectedTokenDocs`, `_executeTokenGroupMoveToTopLeft`

**Problem**: When a group of tokens is selected (potentially including tokens from
multiple floors due to bug 2.1), the group movement system will try to move ALL
selected tokens to the destination. This can cause tokens on other floors to
teleport to unexpected positions.

**Fix**: This is indirectly fixed by fixing drag-select (2.1). Additionally,
`_getSelectedTokenDocs` could defensively filter to only include tokens on the
active level.

---

### 2.9 CLICK-TO-MOVE DESTINATION (P2 — Medium)

**File**: `interaction-manager.js` `_armMoveClickState`

**Problem**: Click-to-move (right-click or left-click) always targets the ground
plane (groundZ). In a multi-level scene, the destination should respect the active
floor's elevation for tokens that have vertical displacement, but currently there's
no elevation awareness in the destination calculation.

**Note**: This is mostly a concern for 3D-adjacent workflows (e.g., flying tokens).
For standard multi-floor maps where all floors share the same XY plane, the 2D
destination is correct.

---

### 2.10 LIGHTING — CROSS-FLOOR LIGHT BLEED (P2 — Medium)

**File**: `LightingEffect.js`

**Problem**: Light sources placed on one floor may illuminate tokens/areas on
another floor if they overlap in XY. The current `LightingEffect` renders all
lights in a screen-space post-process pass without elevation filtering.

**Current mitigation**: Indoor/outdoor masking via `_Outdoors` mask and wall
occlusion already handles most cases where walls separate floors. However, if a
light on Floor 2 has no wall between its XY position and a Floor 0 area, it will
bleed through.

**Levels approach**: `LightHandler._isLightSourceDisabled` wraps light sources to
disable them when their elevation range doesn't overlap the viewer's elevation.
`SightHandler.testInLight` checks 3D spherical light range.

**Fix**: Filter active lights by elevation range overlap with the active level band.
This could be done at the uniform-building stage (skip lights outside the active
band) or via a per-light elevation check in the shader.

---

### 2.11 AMBIENT SOUND — CROSS-FLOOR AUDIO (P2 — Medium)

**Problem**: Ambient sounds placed on one floor may play on other floors. Foundry
+ Levels wraps `AmbientSound.isAudible` to check elevation ranges.

**Current state**: Not explicitly handled in Map Shine's sound system.

**Fix**: If Map Shine handles sound rendering, filter by elevation range.

---

### 2.12 NOTES/PINS — CROSS-FLOOR VISIBILITY (P3 — Low)

**Problem**: Map notes/pins at specific elevations should only show on the
appropriate floor.

**Levels approach**: `NoteHandler.isVisible` wraps `Note.isVisible` to check
elevation range.

**Fix**: If Map Shine renders note markers, filter by elevation.

---

### 2.13 DETECTION FILTERS (Tremorsense/etc.) (P2 — Medium)

**File**: `DetectionFilterEffect.js`

**Problem**: Detection filter indicators (glow/outline for tremorsense, etc.) are
rendered based on `VisibilityController.detectionState`. If a token on Floor 0 is
detected via tremorsense by a token on Floor 2, the indicator would render even
though the detected token should be invisible on the current view.

**Fix**: Gate indicator creation on `sprite.visible` or active level band.

---

### 2.14 TOKEN OVERLAY BORDERS & NAMEPLATES (P1 — Important)

**File**: `token-manager.js` `_updateTokenBorderVisibility`, `_updateNameLabelVisibility`

**Problem**: When a token on another floor is selected (due to bug 2.1 or Foundry
`controlToken` hook from another source), its selection border and nameplate may
render even though the token sprite is hidden. The border/nameplate visibility should
respect the same level filtering as the sprite.

**Fix**: In `_updateTokenBorderVisibility`, check `spriteData.sprite.visible` and
gate border/nameplate accordingly.

---

### 2.15 COMBAT TRACKER — TURN ORDER (P2 — Medium)

**Problem**: In combat, the tracker displays all combatants regardless of floor.
When it becomes a token's turn on a different floor, the camera should potentially
switch to that floor. Currently, `controlToken` hook triggers
`_syncToControlledTokenLevel` in `camera-follower.js`, which should handle this
for the GM.

**Residual issue**: Players may see turn-order highlights for tokens they can't
see (different floor). The combat tracker itself is Foundry-native and outside
Map Shine's control, but target indicators (2.5) appearing for cross-floor
targets could confuse things.

---

### 2.16 DRAG-AND-DROP ACTORS (P3 — Low)

**File**: `drop-handler.js`

**Problem**: When dropping an actor onto the canvas to create a token, the token
should default to the active floor's elevation. Currently unclear if this is
handled.

**Fix**: In the drop handler, set `elevation` from `activeLevelContext.center` or
the active band's bottom when creating the token document.

---

### 2.17 FLYING TOKENS — INDICATOR BADGE (P3 — Low)

**File**: `token-movement-manager.js` flying indicator system

**Problem**: Flying tokens may cross between floor bands during flight. The
flying indicator badge shows elevation and support surface. If the token crosses
into a different floor's band, the level navigator should update accordingly
(this already works via `updateToken` hook → `_syncToControlledTokenLevel`).

**Residual concern**: The support-surface resolver checks tile geometry at the
token's XY position, which may find tiles from the wrong floor if they overlap.

---

## 3. Levels Module Reference — How They Solve These Problems

The Levels module addresses multi-floor interaction via several key patterns:

### 3.1 `CONFIG.Levels.currentToken`
A global reference to the "perspective token" (usually the first controlled token).
All visibility decisions reference this token's `losHeight` (elevation + token
height) to determine what's visible.

**Map Shine equivalent**: `getPerspectiveElevation()` in `elevation-context.js`.

### 3.2 `isVisible` Wrappers
Levels wraps `Token.isVisible`, `Tile.isVisible`, `Drawing.isVisible`,
`Note.isVisible`, and `AmbientSound.isAudible` via libWrapper. These wrappers
check elevation range (`rangeBottom`/`rangeTop` flags) against the current token's
LOS height.

**Map Shine approach**: Since we bypass PIXI rendering, we must implement equivalent
checks in our Three.js managers. We already do this for tiles and templates but
**not** for token interaction (selection/hover/targeting).

### 3.3 `_getOccludableTokens` Override
Levels overrides `TokenLayer._getOccludableTokens` to return only `currentToken`
for non-GM users. This prevents tokens on other floors from participating in
Foundry's native occlusion calculations.

**Map Shine relevance**: We should ensure our token sprite list for interaction
(raycasting, selection) is similarly filtered.

### 3.4 3D Collision Testing
`SightHandler.testCollision` performs true 3D ray-plane intersection against
tile elevation planes and wall-height extruded rectangles. This prevents
cross-floor vision and light bleed.

**Map Shine relevance**: Our `VisionPolygonComputer` already does wall-height
filtering but doesn't check tile planes as collision surfaces.

### 3.5 UI Range Filtering
The Levels UI tool allows GMs to set a visible range `[bottom, top]`. All
placeables outside this range are hidden. This is the authoring-mode equivalent
of our level navigation system.

---

## 4. Revised Implementation Order

> Items marked ✅ were found to already work correctly after deeper analysis.
> The main new work is drag-select tile occlusion and the shared utility module.

### Phase 1 — Core Infrastructure + Critical Fix (P0)
1. **ML-001**: Create `LevelInteractionService` utility module (§10)
2. **ML-002**: Implement `isTokenOccludedByFloorAbove()` tile occlusion query (§9)
3. **ML-003**: Wire tile-occlusion drag-select filtering (2.1)

### Phase 2 — Important Interaction Fixes (P1)
4. ~~ML-004~~: ✅ Click-select already works (2.2)
5. ~~ML-005~~: ✅ Hover already works (2.3)
6. ~~ML-006~~: ✅ Right-click HUD already works (2.4)
7. ~~ML-007~~: ✅ Token targeting already works (2.5)
8. **ML-008**: Static occupancy elevation filter (2.6)
9. **ML-009**: Group movement cross-floor guard (2.8)
10. **ML-010**: Token overlay border/nameplate level gating (2.14)

### Phase 3 — Medium Priority (P2)
11. **ML-011**: Scene nav graph elevation-keyed cache (2.7)
12. **ML-012**: Light source elevation filtering (2.10)
13. **ML-013**: Detection filter level gating (2.13)
14. **ML-014**: Combat tracker floor-switch (2.15)

### Phase 4 — Low Priority / Polish (P3)
15. **ML-015**: Ambient sound elevation filtering (2.11)
16. **ML-016**: Notes/pins elevation filtering (2.12)
17. **ML-017**: Actor drop elevation default (2.16)
18. **ML-018**: Flying token support-surface floor filtering (2.17)

---

## 5. Shared Helper: `isTokenOnActiveLevel(tokenDoc)`

Most fixes share the same core check. A single utility function should be
created and reused across all interaction paths:

```js
/**
 * Check whether a token belongs to the currently active level band.
 * Returns true (allow interaction) if:
 *   - There is no multi-level context (single-floor scene)
 *   - The token's elevation falls within [bottom, top) of the active band
 *
 * @param {TokenDocument|object} tokenDoc
 * @returns {boolean}
 */
function isTokenOnActiveLevel(tokenDoc) {
  const levelCtx = window.MapShine?.activeLevelContext;
  if (!levelCtx || (levelCtx.count ?? 0) <= 1) return true;

  const tokenElev = Number(tokenDoc?.elevation ?? 0);
  if (!Number.isFinite(tokenElev)) return true;

  const bottom = Number(levelCtx.bottom);
  const top = Number(levelCtx.top);

  // Shared-boundary semantics: elevation == top belongs to the UPPER level.
  if (Number.isFinite(top) && tokenElev >= top - 0.01) return false;
  if (Number.isFinite(bottom) && tokenElev < bottom) return false;

  return true;
}
```

This mirrors the existing `_isTokenAboveCurrentLevel` logic in
`VisibilityController` but also checks the bottom boundary.

---

## 6. Testing Scenarios

### Manual Test Cases
- **TC-1**: Place 4 tokens on Floor 0, 4 on Floor 1 (overlapping XY). Drag-select
  on Floor 0 → only Floor 0 tokens selected.
- **TC-2**: Same setup. Click a Floor 0 token position while viewing Floor 0 →
  Floor 0 token selected (not Floor 1 token above).
- **TC-3**: Hover over overlapping position on Floor 0 → tooltip shows Floor 0
  token name only.
- **TC-4**: Right-click overlapping position → HUD opens for Floor 0 token.
- **TC-5**: T-key target while hovering Floor 0 token → targets Floor 0 token.
- **TC-6**: Group-select 3 tokens on Floor 0, right-click move → no tokens from
  Floor 1 included in group.
- **TC-7**: Switch to Floor 1 → repeat TC-1 through TC-6 with Floor 1 tokens.
- **TC-8**: Group pathfind on Floor 0 → Floor 1 tokens not treated as obstacles.
- **TC-9**: Place light on Floor 1 → should not illuminate Floor 0.
- **TC-10**: Combat with tokens on both floors → floor switches on turn change.

---

## 7. Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Breaking single-floor scenes | High | Low | All checks are gated on `count > 1` |
| Performance of per-token elevation checks | Low | Low | O(1) per token, no allocations |
| Edge case at shared boundaries (elev == top) | Medium | Medium | Epsilon comparison, same as existing VC logic |
| Stale `activeLevelContext` during transitions | Medium | Low | Context is set before hook fires (camera-follower.js L629) |
| Modules that set elevation externally | Medium | Medium | Fail-open: non-finite elevation → allow interaction |
| Tile occlusion alpha mask memory | Low | Low | Already cached by TileManager for hover; no new allocation |
| Tile occlusion false negatives (no tile = visible) | Low | Medium | Fail-open: no covering tile → token is selectable |

---

## 8. Revised Interaction Philosophy (IMPLEMENTED)

The correct model separates **point interactions** from **bulk interactions** and
adds **auto-floor-switching** for cross-floor token selection.

### Point Interactions (click, hover, right-click, target)

**Rule**: If you can see a token, you can interact with it — regardless of floor.
Clicking a token on a different floor **auto-switches** the level view to that
token's floor.

- Three.js `Raycaster` already skips `visible=false` sprites
- `_isTokenAboveCurrentLevel` hides tokens above the active level → not clickable
- Tokens below the active level remain visible (by design — you're looking down)
- Z-depth sorting ensures the topmost token wins when XY positions overlap
- **Implemented**: `interaction-manager.js` `onPointerDown` → after selecting a
  cross-floor token, calls `switchToLevelForElevation()` to change the view

### Bulk Interactions (drag-select)

**Rule**: Only select tokens the user intends to interact with as a group.
If ALL drag-selected tokens end up on the same different floor, auto-switch to it.

Drag-select uses **tile occlusion testing** (§9): for tokens not on the active
level, check if they're covered by an opaque floor tile. This prevents accidentally
grabbing tokens hidden under solid floor graphics while allowing tokens visible
through transparent areas (holes, stairwells, balconies) to be drag-selected.

After selection completes, if every selected token is on the same non-active floor,
the view auto-switches to that floor — letting users drag-select a visible group
on a lower floor and seamlessly transition.

- **Implemented**: `interaction-manager.js` `onPointerUp` drag-select loop now
  calls `isTokenDragSelectable()` per token and `getAutoSwitchElevation()` after

### Three Rules Summary

1. **Click a visible cross-floor token** → select it, auto-switch to its floor
2. **Drag-select a group all on the same different floor** → select them,
   auto-switch to that floor
3. **Drag-select on the current floor** → tokens on other floors that are
   hidden under opaque floor tiles are excluded from selection

### Why This Is Better Than Strict Level Filtering

- Maps with **balconies** — you can look down and see tokens on the floor below
  through the railing. Click-select works and switches floor. Drag-select skips
  them only where the floor tile is solid.
- Maps with **stairwell holes** — tokens visible through the opening are
  drag-selectable. Tokens under solid floor are not.
- Maps with **outdoor multi-level terrain** — no floor tile means tokens below
  are always visible and always selectable (correct behavior).
- **Single-floor scenes** — no change at all (gated on `count > 1`).

---

## 9. Tile Occlusion Testing — Design

### Concept

Given a token on a floor below the active level, determine if it is visually
obscured by a floor tile on the active level (or between the token and the
viewer). If a solid, opaque tile covers the token's position → the token is
"hidden under the floor" and should be excluded from drag-select.

### Existing Infrastructure

`TileManager` already has everything needed:

- **`isWorldPointOpaque(data, worldX, worldY)`** — Tests if a world-space point
  hits an opaque pixel (alpha > 0.5) of a specific tile's texture. Handles
  rotation, scale, flip. Already used by `token-movement-manager.js` for
  flight support-surface detection.
- **`alphaMaskCache`** — CPU-side alpha masks built from tile textures, keyed
  by image URL. Already populated for overhead hover detection. No new
  allocation needed.
- **`tileSprites` Map** — All tile sprite data including `tileDoc` with
  elevation and Levels range flags.
- **`readTileLevelsFlags(tileDoc)`** — Reads `rangeBottom`/`rangeTop` from
  tile documents.

### Algorithm: `isTokenOccludedByFloorAbove(tokenDoc, worldX, worldY)`

```
Input: tokenDoc (with elevation), worldX, worldY (Three.js world coords)
Output: boolean — true if a floor tile above the token covers this position

1. Get activeLevelContext. If none or count <= 1, return false (not occluded).

2. tokenElev = tokenDoc.elevation
   If tokenElev is within active band, return false (same floor, not occluded).

3. For each tile in tileManager.tileSprites:
   a. Get tile elevation range (rangeBottom, rangeTop from Levels flags,
      or tileDoc.elevation as fallback).
   b. Skip tiles that are:
      - Below or at the token's elevation (can't occlude from below)
      - Above the active level top (not visible, can't occlude)
      - Not visible (sprite.visible === false)
   c. The tile must be BETWEEN the token and the viewer:
      tileBottom > tokenElev AND tileBottom <= activeLevelContext.top
   d. Call tileManager.isWorldPointOpaque(tileData, worldX, worldY)
   e. If opaque → return true (this tile covers the token)

4. No covering tile found → return false (token is visible through gap)
```

### Performance

- **When it runs**: Only during drag-select mouseup, not per-frame
- **Which tokens**: Only tokens NOT on the active level (majority are same-floor)
- **Per token cost**: O(tiles) × alpha lookup (cached, O(1) per tile)
- **Typical scene**: 5-20 tiles, 2-10 off-floor tokens → negligible cost
- **Worst case**: 100 tiles × 50 off-floor tokens = 5000 alpha lookups = ~1ms

### Edge Cases

| Case | Behavior |
|---|---|
| No floor tile at token position | Not occluded → selectable (outdoor gap) |
| Floor tile with hole/transparency | Not occluded at transparent pixel → selectable |
| Floor tile fully opaque | Occluded → excluded from drag-select |
| Multiple overlapping floor tiles | Any single opaque tile occludes |
| Token partially under tile edge | Test at token center only (simple, fast) |
| Tile with rotation/scale/flip | Handled by `isWorldPointOpaque` coordinate transform |
| Single-floor scene | Entire check skipped (`count <= 1`) |

### Future Enhancement: Multi-Point Sampling

Testing only the token center means a token half-under a tile edge might be
incorrectly included or excluded. A future improvement could sample 4-5 points
(center + corners of token footprint) and use majority vote. This is not needed
for v1 — center-only is a good-enough heuristic.

---

## 10. Do We Need a "Levels Manager"?

### Analysis

Level-related logic is currently distributed across:

| Component | Responsibility |
|---|---|
| `camera-follower.js` | Level band building, navigation, context emission |
| `VisibilityController.js` | `_isTokenAboveCurrentLevel()` |
| `token-manager.js` L1310-1326 | Fallback level-based visibility |
| `tile-manager.js` | Tile visibility by elevation band |
| `template-manager.js` | Template visibility/creation by elevation |
| `elevation-context.js` | Perspective elevation canonical source |
| `levels-scene-flags.js` | Flag reading utilities |

### Verdict: No Full Manager — A Lightweight Service Module

A full lifecycle manager (with constructor, dispose, hooks, update loop) would
add complexity without clear benefit. The existing systems already handle their
own level-aware rendering correctly. What's missing is the **interaction-filtering
logic** and the **tile occlusion query** — both of which are stateless functions
that read existing data.

**Recommendation**: Create a `LevelInteractionService` — a thin utility module
(not a class with lifecycle) that provides:

```js
// scripts/scene/level-interaction-service.js

/**
 * Check if a token is on the currently active level band.
 */
export function isTokenOnActiveLevel(tokenDoc) { ... }

/**
 * Check if a token position is visually occluded by a floor tile
 * between the token and the viewer. Used by drag-select to skip
 * tokens hidden under solid floor graphics.
 *
 * Requires a reference to TileManager for tile data + alpha masks.
 */
export function isTokenOccludedByFloorAbove(tokenDoc, worldX, worldY, tileManager) { ... }

/**
 * Filter a list of token sprites for drag-select eligibility.
 * Combines active-level check + tile occlusion for off-floor tokens.
 */
export function filterTokensForDragSelect(sprites, tileManager) { ... }
```

### Why Not a Full Manager?

- **No state to manage** — all queries read `window.MapShine.activeLevelContext`
  and `tileManager.tileSprites` which are maintained by their respective owners
- **No hooks to register** — the service doesn't need to listen to anything;
  it's called on-demand by InteractionManager
- **No lifecycle** — no init/dispose needed; pure functions
- **No update loop** — nothing to compute per-frame
- **Alpha mask cache** — already owned by TileManager; the service just reads it

### What Would Justify a Full Manager Later?

If we later need:
- Per-token cached "occluded" state that updates reactively when tiles change
- A precomputed "visibility grid" per floor (like a 2D bitmask of which cells
  are covered by opaque tiles)
- Cross-floor interaction rules that are configurable per-scene
- A "floor membership" cache that tracks which tokens belong to which floor

Then a `LevelInteractionManager` class with lifecycle hooks would make sense.
For now, the stateless utility module is the right scope.

---

## 11. Updated Testing Scenarios

### Drag-Select with Tile Occlusion
- **TC-1a**: Floor 1 has a solid floor tile. Tokens on Floor 0 under the solid
  area → drag-select on Floor 1 does NOT grab them.
- **TC-1b**: Floor 1 tile has a transparent hole (stairwell). Token on Floor 0
  positioned under the hole → drag-select on Floor 1 DOES grab it.
- **TC-1c**: Outdoor area with no Floor 1 tile. Token on Floor 0 → drag-select
  on Floor 1 DOES grab it (no occluding tile).
- **TC-1d**: Floor 1 tile with partial transparency (balcony railing texture).
  Token center on opaque part → NOT grabbed. Token center on transparent
  part → grabbed.

### Click-Select Across Floors
- **TC-2a**: Token on Floor 0 is visible (no floor tile above, or transparent
  area). Click it while viewing Floor 1 → selected. ✅ Already works.
- **TC-2b**: Token on Floor 0 is hidden by sprite visibility logic (above
  current level). Click its position → no selection. ✅ Already works.

### Single-Floor Scenes
- **TC-3**: Scene with only 1 level. All interactions unchanged. No occlusion
  checks run. ✅ Already works (gated on `count > 1`).

### Existing Test Cases (from §6) Remain Valid
- TC-5 through TC-10 unchanged.
