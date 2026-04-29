# Floor Render Pipeline Audit

Date: 2026-04-29  
Scope:
- `scripts/scene/FloorStack.js`
- `scripts/compositor-v2/FloorRenderBus.js`
- `scripts/compositor-v2/FloorCompositor.js`
- `scripts/compositor-v2/FloorLayerManager.js`

## Audit Focus

This audit targets potential correctness, lifecycle, and maintainability risks in the floor rendering pipeline (floor discovery, visibility gating, layer assignment, and compositor orchestration). Findings are "potential issues" for triage unless otherwise noted.

## Findings (Prioritized)

### High

1) `FloorCompositor` tile-sprite guard is one-way and depends on external recovery paths  
File: `scripts/compositor-v2/FloorCompositor.js`

- In `_enforceTileSpriteVisibilityForActiveFloor`, sprites are only changed when they are currently visible but should not be:
  - `if (currentlyVisible && !shouldBeVisible) { sprite.visible = false; ... }`
- There is no local branch to re-enable sprites when `shouldBeVisible === true`.
- Recovery currently depends on `TileManager.updateSpriteVisibility(...)` call sites (runtime update loop and hook-driven refresh/update paths) to set visibility back to true.
- Risk: usually self-heals, but if those recovery paths are delayed/paused, this guard can create transient "stuck hidden until next tile refresh/update tick" behavior.

2) Layer assignment can early-return without safe fallback when floor index exceeds supported layer budget  
File: `scripts/compositor-v2/FloorLayerManager.js`

- In `assignTileToFloor`, out-of-range floor index logs and returns:
  - `if (floorLayer === undefined) { log.warn(...); return; }`
- The code does not clamp/reassign to last valid floor layer in this branch, even though the log message implies clamping.
- Risk: tile can keep stale previous layer membership or remain on unintended layers, causing unexpected visibility leaks.

### Medium

3) `FloorStack.getFloors()` exposes mutable internal array by reference  
File: `scripts/scene/FloorStack.js`

- `getFloors()` returns `this._floors` directly.
- Any external mutation can corrupt floor state (`isActive`, ordering, bounds), which then cascades into bus visibility and layer resolution.
- Risk: hard-to-debug state corruption from accidental writes.

4) Boundary logic differs across floor resolution paths (`<` vs `<=`)  
Files:
- `scripts/compositor-v2/FloorRenderBus.js`
- `scripts/scene/FloorStack.js`
- `scripts/compositor-v2/FloorLayerManager.js`

- `FloorRenderBus._resolveFloorIndex` mid-match uses `tileMid < f.elevationMax`.
- Other places (token/elevation helpers and various checks) include upper bound on final/top floor or use inclusive checks.
- Risk: elevation exactly on boundary can map to different floors depending on code path (bus vs stack vs layer manager), leading to mismatched tile/sprite placement and flicker at floor edges.

5) `FloorRenderBus.renderTo` intentionally forces clear alpha to 1 on restore  
File: `scripts/compositor-v2/FloorRenderBus.js`

- After render, it restores previous color but hard-sets alpha opaque:
  - `renderer.setClearColor(prevColor, 1);`
  - `renderer.setClearAlpha(1);`
- This is intentional per comments, but it overrides caller state contract.
- Risk: integration surprises if other render passes rely on non-opaque clear alpha.

6) `FloorCompositor` relies heavily on private internals of `FloorRenderBus`  
File: `scripts/compositor-v2/FloorCompositor.js`

- Multiple direct accesses to `_tiles`, `_visibleMaxFloorIndex`, `_applyTileVisibility`, `_scene`.
- Risk: tight coupling and fragile refactors (small internal bus changes can silently break compositor behavior).

### Low

7) Extremely verbose debug logging inside hot lifecycle paths  
File: `scripts/compositor-v2/FloorRenderBus.js`

- `clear()` logs per preserved token/object and summary at info level.
- On large scenes or frequent repopulates, this can spam logs and impact profiling clarity/perf.
- Risk: noisy diagnostics, potential runtime overhead on heavy maps.

8) Background decode path can cause large transient memory spikes  
File: `scripts/compositor-v2/FloorRenderBus.js`

- `_loadBgImageStraightAlpha` allocates full RGBA buffer copies for large maps.
- Risk: transient memory pressure (especially for very large scene backgrounds), with potential stutters on lower-memory systems.

## Cross-File Risk Themes

- **State authority split**: floor state is inferred in multiple places (`FloorStack`, `FloorRenderBus`, `FloorLayerManager`, compositor guards), increasing drift risk.
- **Redundant enforcement**: both bus visibility and tile sprite visibility are enforced each frame, indicating defensive layering but also potential ownership ambiguity.
- **Tight global coupling**: frequent dependency on `window.MapShine` internals and cross-object private fields raises breakage risk during incremental rewrites.

## Deep Dive: Finding 1 (Tile Visibility Guard)

What was checked:
- `FloorCompositor._enforceTileSpriteVisibilityForActiveFloor` hides leaked sprites above active floor but does not directly re-show.
- `TileManager.updateSpriteVisibility` explicitly sets `sprite.visible` through normal visibility gates and is called from:
  - tile runtime update flow (`TileManager.update(...)`)
  - refresh/update hooks and transform sync pathways
  - several immediate repair paths (hover eligibility changes, refresh handlers)

What this means in practice:
- In normal runtime, hidden sprites are likely restored by TileManager soon after floor changes.
- The guard therefore acts as an aggressive "hide leak now" fallback, with restoration delegated elsewhere.

Residual risk:
- The behavior is still asymmetrical in one function (hide-only), so recovery timing is dependent on other subsystems.
- If update cadence is throttled or specific refresh hooks do not fire, users can observe short-lived visual desync (hidden tile persists longer than expected).

Recommended hardening:
- Add symmetric restore logic in `_enforceTileSpriteVisibilityForActiveFloor`:
  - `if (!currentlyVisible && shouldBeVisible) sprite.visible = true;`
- Keep existing hide path (it is useful for leak suppression), but remove reliance on unrelated subsystems for re-show timing.
- This is a low-risk defensive change and improves deterministic behavior.

## Suggested Next Steps

1) Harden `FloorCompositor._enforceTileSpriteVisibilityForActiveFloor` with symmetric re-show logic so recovery does not depend on TileManager timing.  
2) Harden layer overflow handling in `FloorLayerManager.assignTileToFloor` (actual clamp + deterministic reassignment).  
3) Unify floor-boundary semantics into a shared helper to eliminate `<` vs `<=` divergence.  
4) Introduce a small public API surface on `FloorRenderBus` for compositor diagnostics instead of private field reach-through.  
5) Downgrade or gate repetitive `[V2 DEBUG]` logs behind a debug flag.

