# NavMesh + Multi-Floor Pathfinding Plan
**Date:** 2026-03-14  
**Status:** Planning

---

## Overview

Three separate but integrated systems:

1. **Scene NavMesh** — walkable polygon graph built from Foundry wall geometry at scene load; replaces grid-bounding-box A* for long-distance routing.
2. **Multi-floor Portal Graph** — connects per-floor navmeshes at staircase/transition portals so tokens can be routed across floors automatically.
3. **Fog-of-War Path Occlusion** — path preview line clipped/faded at fog boundary so the UI never reveals hidden geometry to players.

---

## Phase 1 — Scene NavMesh (single floor)

### Goals
- Generate a polygon walkable mesh from Foundry wall segments at scene load.
- Use the mesh as the coarse routing backbone for A*; replaces the current `searchMarginPx` grid-box expansion.
- Maintain full compatibility with the existing `findWeightedPath` / `_computeConstrainedPathWithDirectAndEscalation` pipeline.

### Architecture

#### 1.1 Wall geometry extraction
```
SceneNavMeshBuilder
  ├─ readWallSegments(scene)       → [{ax,ay,bx,by,isDoor,doorState,elevation}, ...]
  ├─ filterBlockingWalls()         → exclude open doors, one-way walls (per token direction)
  └─ buildAxisAlignedBounds()      → AABB of scene for clipping
```

Walk `canvas.walls.placeables`, extract `{c: [ax,ay,bx,by]}` and door/elevation flags.  
Doors are treated as walls when closed, removed when open.  
Wall set must be rebuilt when any door state changes.

#### 1.2 Constrained polygon decomposition
Use a **Constrained Delaunay Triangulation (CDT)** approach:

1. Insert scene bounding rectangle as outer boundary.
2. Insert all blocking wall segments as CDT constraints.
3. Flood-fill from a known free cell to mark traversable triangles.
4. Build **dual graph**: each traversable triangle is a node; shared edges become graph edges.

**Library preference**: no external dependency — implement a simple CDT using ear-clipping + constraint insertion on the convex hull, since Foundry wall scenes are typically axis-aligned or 45°-diagonal with relatively low segment counts (< 2000 segments for most scenes).

Fallback: if CDT is too expensive, use a **grid-with-clearance** approach — same pixel grid as current A*, but precomputed, shared across all moves, and indexed as a flat Uint8Array bitmask.

#### 1.3 Walkable node graph
```
NavMeshGraph
  ├─ nodes: Map<nodeId, {x, y, triangleIndex, floor}>
  ├─ edges: Map<nodeId, Array<{toId, cost}>>
  ├─ spatialIndex: BucketGrid              → fast nearest-node lookup
  └─ doorEdges: Set<edgeId>               → edges that depend on door state
```

Node placement: centroid of each traversable triangle.  
Edge cost: Euclidean distance (+ terrain cost multiplier from Foundry region data).

#### 1.4 A* over navmesh
```
NavMeshPathfinder
  ├─ findPath(startWorld, endWorld, options)
  │   ├─ snap start/end to nearest navmesh node
  │   ├─ A* over NavMeshGraph
  │   ├─ reconstruct node path
  │   └─ string-pull (funnel algorithm) → smooth waypoints
  └─ invalidateEdge(wallId | doorId)    → mark stale edges for rebuild
```

Funnel algorithm (Simple Stupid Funnel / Lee-Preparata) converts the triangle-corridor path into the minimal set of waypoints, avoiding zig-zag artefacts.

#### 1.5 Integration into existing pipeline
Replace the current `_findWeightedPathWithAdaptiveExpansion` call inside `_computeConstrainedPathWithDirectAndEscalation` with:

```
if (directCheck.ok) → return direct [start, end]       (unchanged)
else if (navMesh available) → navMeshPathfinder.findPath()
else → fallback _findWeightedPathWithAdaptiveExpansion  (unchanged)
```

If navmesh returns a path, validate endpoint reach (same `validateAStarPath` logic, no wall re-integrity check since navmesh guarantees traversable edges).

#### 1.6 Rebuild triggers
- Scene load complete → full rebuild in worker-like `requestIdleCallback` batch
- Door state change (`updateWall` hook) → partial rebuild: remove/restore door edges only
- Wall create/update/delete → full rebuild (rare)

Rebuild is async and does not block movement; existing A* continues until new mesh is ready.

#### 1.7 Cache key
`sceneId + wallRevision + doorStateHash`  
Navmesh stored in `TokenMovementManager._navMeshCache`.

---

## Phase 2 — Multi-floor Portal Graph

### Goals
- Auto-detect staircase portals on scene load using Levels data.
- Stitch per-floor navmeshes into a unified cross-floor graph.
- Token pathfinding: select end point on a different floor, get a route that includes floor transitions.

### Architecture

#### 2.1 Portal detection
Sources of portal data (in priority order):

1. **Levels module regions** — `RegionBehavior` with type `teleport` or `staircase`; extract `{fromFloor, toFloor, fromWorldXY, toWorldXY}`.
2. **Tile flags** — MapShine `_StairsUp` / `_StairsDown` mask regions (already detected by tile-manager); use mask centroid as portal location.
3. **Manual placement** — GM-placed Map Points with type `portal` (future, not required for MVP).

```
PortalDetector
  ├─ detectFromLevelsRegions(scene)
  ├─ detectFromMaskTiles(tileManager)
  └─ mergePortals()  → Array<Portal>

Portal {
  id: string
  fromFloor: {bottom, top}     // elevation band
  toFloor:   {bottom, top}
  entryWorldXY: {x, y}
  exitWorldXY:  {x, y}
  bidirectional: boolean
  travelTimeMs: number         // animation pause during transition
}
```

#### 2.2 Multi-floor graph
```
MultiFloorGraph
  ├─ floorGraphs: Map<floorKey, NavMeshGraph>
  ├─ portalNodes: Map<portalId, {floorKey, nearestNavNodeId, exitFloorKey, exitNavNodeId}>
  └─ findCrossFloorPath(start, startFloor, end, endFloor, options)
       → Array<PathSegment>

PathSegment = {
  type: 'walk' | 'portal-transition',
  floorKey: string,
  pathNodes: Array<{x,y}>,
  portalId?: string             // set when type = 'portal-transition'
}
```

Cross-floor A*:
- Expand search across portal edges.
- Each portal edge has a cost equal to `travelTimeMs * speed_factor + Euclidean(entry, exit)`.
- Standard A* heuristic: Euclidean(current_floor_pos, destination_pos) ignoring floor boundaries (optimistic lower bound).

#### 2.3 Token execution
`executeDoorAwareTokenMove` extended with multi-segment awareness:

```
for segment of pathSegments:
  if segment.type === 'walk':
    runDoorAwareMovementSequence(segment.pathNodes)
  if segment.type === 'portal-transition':
    animateTokenToPortalEntry()
    await transitionTokenToFloor(portal.toFloor, portal.exitWorldXY)
    // Triggers LevelsPerspectiveBridge to switch active floor
    await waitForFloorTransition()
```

`transitionTokenToFloor`:
- Updates `TokenDocument.elevation` to `toFloor.bottom + 1`.
- Triggers the existing `LevelsPerspectiveBridge` level-switch hook.
- Plays a brief transition animation (rise/descend).

#### 2.4 Player vs GM routing
- **GM**: full cross-floor pathfinding, all floors visible.
- **Player**: cross-floor routing allowed only to floors the player's token can legally reach (portal `fromFloor` must match current token floor AND portal must be within explored fog region — see Phase 3).

---

## Phase 3 — Fog-of-War Path Occlusion

### Goals
- Path preview (blue highlight boxes / route line) must never reveal hidden geometry.
- Players cannot see the route into unexplored fog.
- The preview should fade/clip at the fog boundary rather than hard-cut.

### Architecture

#### 3.1 Render layer ordering
Path preview geometry currently renders above everything.  
**Change**: render path preview in a dedicated THREE pass that is composited **under** the fog-of-war layer.

```
Render order (low → high):
  Scene background + tiles
  Token sprites
  ─── [NEW] Path preview layer ────────────────────────
  Fog of war (WorldSpaceFogEffect)
  Overhead tiles
  UI overlays
```

The path line and ghost-token waypoints already use Three.js objects; they just need `renderOrder` values below the fog composite pass.

#### 3.2 Fog-masked path alpha
For a softer effect, sample the fog texture in the path line shader:

```glsl
// Path line vertex shader — pass world UV
vFogUv = (worldPos.xy - uSceneBounds.xy) / uSceneBounds.zw;
vFogUv.y = 1.0 - vFogUv.y;  // Y-flip

// Fragment shader
float fogAlpha = texture2D(tFogTexture, vFogUv).a;
float pathAlpha = uPathAlpha * (1.0 - fogAlpha);
gl_FragColor = vec4(uPathColor, pathAlpha);
```

`tFogTexture` = existing `worldSpaceFogEffect` render target already published to `maskManager`.

This causes the path preview to **fade to invisible** where fog is present, not hard-clip, giving a clean look while hiding information.

#### 3.3 Ghost token occlusion
Ghost tokens (transparent copies at each waypoint) already go through the `tokenManager` render pipeline.  
Apply the same fog-UV sampling to ghost token shader alpha, or simply hide ghost tokens whose world position falls in fully-fogged area:

```javascript
// In _applyMovementPreviewResult, filter ghost tokens
for (const ghost of ghosts) {
  const fogValue = this._sampleFogAtWorldPoint(ghost.worldX, ghost.worldY);
  ghost.visible = fogValue < 0.5;  // hide if deeply fogged
}
```

CPU-side fog sampling already possible via the existing `_cpuPixelCache` in `GpuSceneMaskCompositor`.

#### 3.4 Pathfinding search respects fog
The existing `fogPathPolicy` settings already gate A* node expansion. With navmesh:
- Mark navmesh nodes as `fogBlocked` during mesh build if their world position is outside player's explored area.
- `fogBlocked` nodes are skipped during A* expansion for non-GM players (same as current `strictNoFogPath` policy).
- Rebuild `fogBlocked` flags when fog updates (hook: `sightRefresh`).

---

## Phase 4 — Token Size & Clearance

When navmesh edges are built, store **minimum clearance** (distance to nearest wall) per triangle:
- 1×1 tokens: all triangles valid.
- 2×2 tokens: only triangles with clearance ≥ `gridSize * 1.5` valid.
- Fat-token navmesh is a **subset** of the 1×1 mesh — compute once per token size class, cache.

Token size classes: 1×1, 2×2, 3×3+ (three meshes total per scene).

---

## Implementation Phases & Priority

| Phase | Feature | Priority | Complexity | Prerequisite |
|-------|---------|----------|------------|-------------|
| 1a | Wall geometry extraction | High | Low | — |
| 1b | Grid-bitmask fallback (simple CDT) | High | Medium | 1a |
| 1c | NavMesh A* + funnel smoothing | High | Medium | 1b |
| 1d | Door-edge invalidation on state change | High | Low | 1c |
| 1e | Integration into existing pipeline | High | Low | 1c |
| 2a | Portal detection (Levels regions + mask tiles) | Medium | Medium | 1c |
| 2b | Multi-floor graph + cross-floor A* | Medium | High | 2a |
| 2c | Token floor transition execution | Medium | Medium | 2b |
| 3a | Path preview render below fog layer | Medium | Low | — |
| 3b | Fog-masked path line shader | Medium | Medium | 3a |
| 3c | Ghost token fog occlusion | Low | Low | 3a |
| 3d | NavMesh fog-blocked node flagging | Medium | Low | 1c |
| 4 | Per-size-class clearance meshes | Low | Medium | 1c |

**MVP (reliably working cross-map paths)**: Phases 1a → 1e + 3a (path below fog layer).  
**Multi-floor routing**: Phases 2a → 2c.  
**Full fog protection**: Phases 3b → 3d.

---

## Key Files to Create/Modify

| File | Change |
|------|--------|
| `scripts/scene/nav-mesh-builder.js` | NEW — wall extraction + CDT + graph construction |
| `scripts/scene/nav-mesh-pathfinder.js` | NEW — A* over navmesh + funnel algorithm |
| `scripts/scene/portal-detector.js` | NEW — Level portal/staircase detection |
| `scripts/scene/multi-floor-graph.js` | NEW — cross-floor graph + A* |
| `scripts/scene/token-movement-manager.js` | Integrate navmesh into `_computeConstrainedPathWithDirectAndEscalation`; add floor-transition execution |
| `scripts/foundry/canvas-replacement.js` | Trigger navmesh build after scene load |
| `scripts/effects/path-preview-effect.js` | NEW or modified — fog-masked path line shader |

---

## Open Questions

1. **CDT library vs grid bitmask**: Grid bitmask is much simpler to implement correctly and probably fast enough at 150px grid. CDT gives smoother paths but is significantly more code. Recommend starting with grid bitmask, upgrade to CDT later if path quality is insufficient.

2. **Portal detection reliability**: Levels region behaviors are the cleanest source. If a map doesn't use Levels, manual portal placement is needed. For MVP, Levels regions + `_StairsUp`/`_StairsDown` tile masks should cover most maps.

3. **Cross-floor fog policy**: Should a player be allowed to see the path on a floor they've never visited? Default: no. The navmesh portal node should only be included in A* expansion if the player has explored the entry side of the portal.

4. **Path preview depth**: The fog layer in THREE renders as a post-process effect on a full-screen quad. Rendering path geometry "under" it requires either rendering before the fog pass or sampling the fog texture in the path shader (option 3b). Both are viable; 3b gives better UX.
