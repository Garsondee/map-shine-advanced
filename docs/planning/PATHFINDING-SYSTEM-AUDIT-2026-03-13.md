# Pathfinding System Audit — 2026-03-13

Full audit of `scripts/scene/token-movement-manager.js` and pathfinding entry points in
`scripts/scene/interaction-manager.js`. Covers single-token, group, HPA*, scene nav graph,
door choreography, and settings.

---

## Executive Summary

The pathfinding pipeline is architecturally sound for simple cases (single token,
short distance, open terrain) but has **five critical bugs** that cause partial
failure in the most common real-world use cases: persistent settings loss on scene
reload, step-level wall re-validation that second-guesses A*, preview/execute path
mismatch, group timeline deadlocks, and HPA fallback degrading to a box too small to
succeed.

---

## Critical Bugs (P0/P1)

### BUG-1 — Settings Not Persisted Across Scene Loads (P0)

**Files**: `scripts/scene/token-movement-manager.js`, `scripts/ui/token-movement-dialog.js`

**Root cause**: `TokenMovementManager` constructor (line ~286) hardcodes all policy
defaults:
```javascript
this.settings = {
  defaultStyle: DEFAULT_STYLE,
  weightedAStarWeight: 1.15,
  fogPathPolicy: 'strictNoFogPath',
  doorPolicy: { autoOpen: true, autoClose: 'outOfCombatOnly', ... }
};
```
`canvas-replacement.js` constructs a fresh `new TokenMovementManager(...)` every
scene load (line ~4069). The `TokenMovementDialog` writes directly to
`manager.settings.*` at runtime but those writes:
- Are lost when the canvas tears down
- Are never written to `game.settings`
- Have no corresponding `game.settings.register()` calls in `scene-settings.js`

There is NO code path that reads persisted values back into `tokenMovementManager.settings`
on canvas init.

**Effect**: Every scene transition or browser refresh resets fog path policy, A* weight,
and the entire door policy to hardcoded defaults. User configurations in the Movement
Dialog do nothing lasting.

**Fix**: Register `world`-scoped game settings for each policy field. Read and apply
them in canvas-replacement.js after constructing the manager, or add a
`loadSettingsFromGame()` method called after `initialize()`.

---

### BUG-2 — `_validateMoveStepTarget` Re-Checks Already-Pathfound Steps (P1)

**File**: `scripts/scene/token-movement-manager.js` lines ~8629, ~8719

**Root cause**: `_moveTokenToFoundryPoint` (line ~8719) calls `_validateMoveStepTarget`
on **every** path step:
```javascript
const targetTopLeftRaw = this._tokenCenterToTopLeft(point, liveDoc);
const targetCheck = this._validateMoveStepTarget(liveDoc, currentTopLeft, targetTopLeftRaw, options);
if (!targetCheck?.ok) { return { ok: false, reason: 'blocked-by-wall' }; }
```
`_validateMoveStepTarget` does a fresh `_validatePathSegmentCollision` from
`liveDoc.x/y → targetCenter`. A* already tested every edge during graph construction
and `_validatePathWallIntegrity` ran another pass after smoothing.

The issue: `liveDoc.x/y` is the Foundry **document** position (snapped to grid) but
A* worked in center-space with `_snapPointToTraversalGrid`. Small float differences
in snapping can produce a slightly different from-point, shifting the collision ray
enough to graze a wall that the A*-tested ray missed.

**Effect**: Token stops mid-path with `reason: 'blocked-by-wall'` even though the
path was fully validated. Observed as tokens stopping one or two steps before their
destination, especially near doors and diagonal walls.

**Fix**: Skip the per-step collision re-check in `_moveTokenToFoundryPoint`. The path
is already wall-integrity-validated by `_validatePathWallIntegrity`. Only do the
scene-bounds check (`_isTokenTopLeftWithinScene`) which is cheap and correct.

---

### BUG-3 — Preview Uses Sync Foundry Path, Execution Uses Async (P1)

**Files**: `scripts/scene/token-movement-manager.js` lines ~8152, ~5889

**Root cause**:
- `computeTokenPathPreview` → `_computeFoundryParityPathImmediate` (line ~8152):
  reads `job.result` synchronously; returns `{ok:false, reason:'pending-foundry-path'}`
  when Foundry's pathfinder hasn't resolved yet.
- `executeDoorAwareTokenMove` → `_computeFoundryParityPath` (line ~5889):
  awaits `job.promise` to get the actual result.

`_selectPathWithFoundryParity` behavior when foundry path is `ok:false` (pending):
always returns the custom path. When it resolves async to a different route, the
execution path selects that different route.

**Effect**: The path shown in the preview (dashed line on the map) is different from
the path the token actually walks. Most visible when Foundry's async path takes a
significantly shorter or different route than the custom A* path.

**Fix**: Either:
a) Make preview also await the Foundry path (changes signature to async — preferred).
b) Cache the foundry job promise on `computeTokenPathPreview` and return it alongside
   `pathNodes` so `executeDoorAwareTokenMove` can reuse the result without re-querying.

---

### BUG-4 — Group Timeline Deadlock on 3+ Tokens in Tight Spaces (P1)

**File**: `scripts/scene/token-movement-manager.js` lines ~7573-7801

**Root cause**: `_buildGroupMovementTimeline` simulates synchronized step-by-step
movement. Each "tick" proposes the next move for each token and accepts/rejects based
on spatial overlap. When tokens have converging paths in a corridor:
1. Token A wants to move into cell X (occupied by B)
2. Token B wants to move into cell Y (occupied by C)
3. Token C wants to move into cell Z (occupied by A's future)
→ All proposals are rejected → `consecutiveStalls` increments

The "deadlock breaker" at 3+ stalls force-accepts the token with most remaining steps.
This can create a cascade of overlap rejections on the next tick, not actually breaking
the deadlock. After 8 consecutive stalls: returns `{ok:false, reason:'group-timeline-deadlock'}`.

The reconcile path (`_reconcileGroupFinalPositions`) then tries to finish each token
individually via `executeDoorAwareTokenMove` but by this point the group operation
reports `ok:false` to the user.

**Effect**: Group moves of 3+ tokens through corridors, doorways, or areas that
require sequenced passage frequently fail silently. The tokens either don't move at
all or partially complete.

**Fix options**:
a) Reserve cells by "path reservation" — if token B's path includes cell X in a
   future tick, token A should wait rather than be rejected.
b) Reduce deadlock sensitivity: instead of failing on 8 stalls, fall back immediately
   to `_reconcileGroupFinalPositions` and report `ok:true` (reconcile already works).
c) Add a "wait" action to the timeline so blocked tokens pause a tick rather than
   being marked as failed proposals.

**Quick fix (b)**: In `executeDoorAwareGroupMove`, if `timelineResult.ok` is false with
reason `group-timeline-deadlock`, immediately call `_reconcileGroupFinalPositions`
AND still return `ok:true` with `reconciled:true`. This already happens for
`group-timeline-max-ticks` but NOT for `group-timeline-deadlock`. Line ~6386:
currently returns `ok:false` — change to attempt reconcile first.

---

### BUG-5 — HPA Segment Refinement Failure Cascades to Undersized Local Box (P1)

**File**: `scripts/scene/token-movement-manager.js` lines ~1603-1626, ~3660-3706

**Root cause**: When HPA finds a valid sector-level path and tries to refine each
segment, it calls `findWeightedPath` with `disableHpa:true` and a local `searchMarginPx`
capped to roughly the sector size (~85% of sectorSize). If any segment crosses a
corridor that is wider than this local margin, the refinement fails:
```javascript
if (!segment?.ok || ... segment.pathNodes.length < 2) {
  return { ok: false, reason: 'hpa-refine-failed', ... };
}
```
The entire HPA result is then discarded. The fallback `findWeightedPath` call uses the
options' `searchMarginPx` (default 260px). For a 5-sector path where the HPA identified
the route correctly, this 260px box cannot contain the full route → `no-path`.
`_findWeightedPathWithAdaptiveExpansion` retries with a larger box, but the expansion
factor (1.8× nodes, 1.6× iterations) may still be insufficient for very long routes.

**Effect**: Long-distance moves (>12 grid cells) that would be solvable via HPA fail
with `no-path` because HPA refinement uses a box too small to connect its own waypoints.

**Fix**: In `_findHpaPath` segment refinement loop, use a `searchMarginPx` equal to
the larger of: `options.searchMarginPx`, the sector size, AND the direct distance
between the two waypoints × 1.5. Also consider using a shared pathfinding corridor
derived from the waypoints rather than a simple bounding box.

---

## Medium Bugs (P2)

### BUG-6 — `_planDoorAwareGroupMove` Fails When Only 1 of N Tokens Resolves

**Line ~6610**: Returns `{reason:'insufficient-group-tokens'}` when `entries.length < 2`
even if `tokenMoves.length >= 2`. The 1 resolved token could be moved individually.
`executeDoorAwareGroupMove` single-token fast-path at line ~6229 only activates before
planning — not after partial resolution failure.

**Fix**: When `entries.length === 1`, delegate to `executeDoorAwareTokenMove` for
that single resolved token before returning failure.

---

### BUG-7 — Group Planning Budget 280ms Default Too Tight

**Line ~6682**: `baseBudgetMs = 280`. Complex scenes with many walls, large groups (5+
tokens), or long-distance moves frequently exceed this. When `planBudget.triggered`:
- Candidate generation stops at `budgetCandidateFloor` (min 4 per token)
- Fewer candidates → higher chance of `no-non-overlap-assignment`
- Group move fails with `group-plan-failed`

**Fix**: Increase default to 450ms. For groups of 4+, scale by token count.
Already handles `isLongDistance` (×1.6), but the base value is too low for scenes
with dense wall geometry.

---

### BUG-8 — Full-Scene Nav Graph Elevation Agnostic (null tokenObj during prewarm)

**Lines ~1184, ~4276**: During `_buildFullSceneNavGraph`, `tokenDoc` is the stub
`{ width: 1, height: 1 }` with no `.id` or `.object`. In `_validatePathSegmentCollision`:
```javascript
const tokenObj = context.tokenDoc?.object || canvas?.tokens?.get?.(context.tokenDoc?.id) || null;
```
`tokenObj` is null. `_resolveCollisionElevation` returns `docElevation = 0` (no
perspective elevation applied). The cached nav graph is built for elevation=0. Tokens
at non-zero elevation with wall-height restrictions will have incorrect nav graph
edges — passable walls may block and blocking walls may pass.

**Effect**: In Levels-enabled scenes, the precomputed nav graph gives wrong collision
answers for upper-floor tokens, causing pathfinding to route through walls or fail
where passable routes exist.

**Fix**: Accept a list of token sizes AND elevations in `_runPathfindingPrewarm` and
build a separate nav graph per elevation band (or at least per active level). Apply
active perspective elevation when building the prewarm context.

---

### BUG-9 — `_selectPathWithFoundryParity` 35% Length Rejection Too Aggressive

**Lines ~9322-9327**:
```javascript
if (lenDelta > (gridSize * 2) && lenRel > 0.35) {
  return { ok: true, pathNodes: normalizedFoundry };
}
```
This discards the custom path in favor of Foundry's if Foundry's is 35%+ shorter.
In scenes with terrain cost walls (where our system applies cost penalties but Foundry
may ignore them for path length comparison), our "longer" path may be the correct
minimum-cost route. The Foundry path could cut through cost-penalized terrain.

**Fix**: Compare path cost rather than raw Euclidean length. If Foundry's path
traverses high-cost terrain that our path avoids, prefer ours even if it's longer.
Alternatively, relax the threshold to 50% or make it configurable.

---

### BUG-10 — `_awaitSequencedStepSettle` Delay Estimation Too Conservative

**Line ~8810**: `const estMs = (gridSteps * 290) + 140;`  
For a 1-cell step: 430ms minimum wait. For a 10-step path: 3.04 seconds of forced
sequential delays even if animations complete faster.

The function does poll `activeTracks` to exit early, but if the track was never
created (e.g., `TokenManager` didn't create an animation track because the token
isn't visible on screen), it waits the full estimate.

**Effect**: Pathfound moves that complete quickly (or non-animated updates) still
block for 430ms+ per step, making 10-step paths take ~4+ seconds.

**Fix**: Reduce base estimate to `(gridSteps * 180) + 80`, or make it respect the
actual token movement speed from movement style profiles.

---

### BUG-11 — `_buildGroupMovementTimeline` Edge-Swap Detection Threshold

**Lines ~7648-7658**: Edge-swap check uses `< 0.5` pixel tolerance. Path nodes from
`_interpolatePathForWalking` are at sub-pixel precision (fractional grid positions).
Two tokens crossing paths at interpolated intermediate nodes may:
- Miss the swap detection (0.5px too tight) → tokens pass through each other in sync
- False-positive detect non-swaps for tokens moving diagonally past each other

**Fix**: Use `< gridSize * 0.1` (10% of grid cell) as the threshold, which matches
the traversal grid precision.

---

## Architecture / Design Issues

### ARCH-1 — No Settings Persistence Mechanism (duplicates BUG-1)
See BUG-1. `TokenMovementDialog` changes are session-only.

### ARCH-2 — Opaque Multi-Layer Fallback Makes Diagnosis Hard
Group moves have 4+ fallback layers (plan cache → retry → timeline → reconcile →
individual reconcile). Each layer can return `ok:true` for different reasons. The
calling code in interaction-manager just logs `warn` on failure with no user feedback.
**Recommendation**: Emit a brief UI notification (chat message or UI toast) when
group planning degrades or fails, so users know the move didn't execute as planned.

### ARCH-3 — `_validatePathWallIntegrity` Truncates but Doesn't Retry
When the post-A* wall integrity check finds a wall-crossing segment, it truncates
the path and returns a shorter path. `findWeightedPath` then returns `ok:false`
with `reason:'wall-truncated'` and triggers the adaptive retry. This is correct
in principle, but the truncated path is discarded — the token doesn't move to the
last valid node, it doesn't move at all. A token near a wall that A* incorrectly
included in the path will just fail to move.

### ARCH-4 — Group Plan Cache TTL Too Short for Slow Networks
`_groupPlanCacheTtlMs = 8000` (line ~261). On high-latency connections, the time
between preview and execute can exceed 8 seconds, causing the execute path to
re-plan from scratch. Since the re-plan runs synchronously in `_planDoorAwareGroupMove`,
on slow execution paths this adds perceptible lag.

---

## Things That Work Correctly

- Single-token A* with precomputed scene nav graph (fast, wall-correct for most cases)
- HPA sector adjacency for genuinely long-distance paths when refinement succeeds
- Door detection and `runDoorAwareMovementSequence` choreography
- `_guardKeyboardTokenUpdate` keyboard nudge wall blocking
- `_clipPathBacktrackDetours` + `_smoothPathStringPull` path optimization
- Fog policy (`strictNoFogPath`) player visibility filtering
- Movement style animation tracks (walk/fly styles)
- Group interruption via `_activeGroupCancelToken`

---

## Recommended Fix Priority

| # | Bug | Impact | Effort |
|---|-----|--------|--------|
| 1 | BUG-1 Settings not persisted | All settings UI is broken | Medium |
| 2 | BUG-4 Group timeline deadlock returns `ok:false` | Group moves fail in corridors | Low (fallback change) |
| 3 | BUG-2 Per-step re-validation blocks mid-path | Single-token stops mid-path | Low (remove check) |
| 4 | BUG-5 HPA refine box too small | Long-distance paths fail | Medium |
| 5 | BUG-3 Preview/execute path mismatch | UI shows wrong preview path | Medium |
| 6 | BUG-7 Group budget 280ms too tight | Group moves fail on complex maps | Low (constant change) |
| 7 | BUG-8 Nav graph elevation agnostic | Wrong paths in multi-level scenes | High (architecture) |
| 8 | BUG-10 Step delay too conservative | Slow multi-step moves | Low |
