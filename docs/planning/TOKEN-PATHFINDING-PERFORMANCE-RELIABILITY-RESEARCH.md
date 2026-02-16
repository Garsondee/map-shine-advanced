# Token Pathfinding Performance & Reliability Research

## Status
- Date: 2026-02-16
- Scope: investigate pathfinding reliability and multi-token move freezes (especially ~5 selected tokens)
- Focus files:
  - `scripts/scene/token-movement-manager.js`
  - `scripts/scene/interaction-manager.js`

### Implementation Progress Update (latest)

Completed so far:

1. Preview->execute group-plan cache reuse with signature validation and TTL/size bounds.
2. Planning budget controls + adaptive candidate defaults for common group sizes.
3. Weighted-path and planning instrumentation (calls, fail reasons, graph stats, timings).
4. Door-segment memoization for traversal cost checks.
5. Assignment guardrails (time/node caps + greedy fallback).
6. Two-phase candidate pipeline (coarse geometric pass, then bounded path-evaluation pass).
7. One-shot expanded retry matrix on group planning failures.

Latest incident findings from live logs:

- Repeated preview-time `findWeightedPath ended with no path` warnings were emitted for candidate probes.
- Many failures showed tiny, non-truncated graphs (for example `nodeCount ~17`, `edgeCount ~84`), which indicates repeated probing in a disconnected local region rather than a graph budget truncation failure.
- Repeated per-candidate warning logs materially increased main-thread pressure and made right-click freezes worse.

Latest code adjustments (in progress validation):

1. Candidate probe no-path logs are now suppressed during group candidate evaluation (`suppressNoPathLog: true`) while still recording stats.
2. Group preview path now mirrors execute behavior by attempting a one-shot expanded retry before returning failure.
3. Candidate evaluation now tracks repeated low-connectivity no-path probes and bails earlier for that token when signals indicate likely disconnected local search space.
4. When `enforceAnchorSide` is enabled, planner now performs a cheap anchor reachability probe per token and selectively relaxes anchor-side enforcement for tokens that appear disconnected from the anchor region (tiny non-truncated no-path graph).
5. Added adaptive weighted-path expansion helper (`_findWeightedPathWithAdaptiveExpansion`) that does one bounded retry with increased margin/nodes/iterations for retryable no-path outcomes.
6. Added shared-corridor seeding: planner computes one anchor-token corridor path and injects candidates from the corridor tail for all group tokens before radial candidate expansion.
7. Top-ranked and corridor-seeded candidates now use adaptive expansion path probing to improve long-detour reliability.
8. Preview/execute retry diagnostics now preserve the retry result reason/metrics when retry fails, improving root-cause visibility.
9. Added map-load pathfinding prewarm: on manager initialize/canvasReady/wall topology changes, we schedule idle-time cache warmup.
10. Added persistent per-scene door spatial index (bucketed) used by `findDoorsAlongSegment` so door intersection checks avoid scanning every wall each time.
11. Added RTS-inspired ring formation slot seeding around anchor destination; each token gets a preferred slot and nearby alternatives to reduce `no-non-overlap-assignment` pressure.
12. Implemented an HPA*-style hierarchical overlay for long routes:
    - scene is partitioned into coarse sectors,
    - sector adjacency gateways are collision-validated,
    - long routes first solve coarse sector path then refine with local weighted A* segments.

Interpretation: this implements a practical "single leader path + follower join" strategy (anchor token finds corridor first, others preferentially target corridor-tail positions), while preserving collision-safe assignment and timeline choreography.

13. **BinaryMinHeap for A* open-set**: Replaced O(n) linear-scan `_selectOpenSetBestNode` with a proper binary min-heap (`BinaryMinHeap` class) for both the main weighted A* search and the HPA sector-level A*. This reduces per-iteration extraction cost from O(n) to O(log n), which is significant for graphs with 6,000–24,000 nodes and 12,000+ iterations. Uses lazy deletion with a closed set to handle duplicate pushes from score updates.
14. **Multi-gateway HPA border sampling**: `_buildHpaGatewayBetweenSectors` now scans ALL sample points along a shared sector border and picks the most central passable crossing (closest to border midpoint), instead of returning the first valid sample. This produces higher-quality gateways that route more naturally through sector centers. Denser sampling step (0.5× grid instead of 0.75×).
15. **Diagonal HPA sector adjacency**: The HPA adjacency graph now includes diagonal neighbor pairs (8-connected instead of 4-connected). `_buildHpaGatewayBetweenSectors` supports diagonal adjacency via corner-point crossing validation. This allows HPA to route around large wall complexes that block all cardinal crossings between two sectors.
16. **Enhanced pathfinding prewarm**: `_runPathfindingPrewarm` now also pre-builds the HPA adjacency graph for 1×1 tokens (the most common size) during idle time, so the first pathfinding request after scene load or wall change doesn't pay the full gateway scan cost. Prewarm diagnostics now include `hpaAdjacencyEdgeCount`.
17. **Group planning HPA warm-up**: `_planDoorAwareGroupMove` eagerly builds HPA adjacency for all unique token sizes in the group at the start of planning, before candidate evaluation begins. This ensures every `findWeightedPath` call during per-token candidate path evaluation hits the adjacency cache.
18. **Adaptive long-distance group budget**: For group moves where anchor travel distance exceeds 10 grid cells, the planning budget is automatically increased by 60% to accommodate HPA multi-segment local refinement without premature budget cutoff.

Next targets:

1. Optional chunk/yield path for preview planning to further reduce right-click lockups under heavy selection.
2. Corridor lane reservation in assignment/timeline to reduce `no-non-overlap-assignment` and deadlock-breaker usage.
3. Additional timeline/reconcile profiling hooks for post-plan phase freezes.
4. Consider Web Worker offloading for the heaviest planning phases (graph generation + A* search).

---

## 1) Problem Statement

Current behavior is functionally correct most of the time, but:

1. Group movement pathfinding can become unreliable (frequent fallback/degraded paths).
2. Group movement with around 5 selected tokens can freeze the main thread for multiple seconds.
3. UX feels clunky because planning, preview, and execution can all perform expensive synchronous work.

---

## 2) Current Execution Flow (What Actually Runs)

### 2.1 Right-click group preview path (planning-only)

- Entry point: `InteractionManager._handleRightClickMovePreview(...)` @scripts/scene/interaction-manager.js#1482-1625
- For groups, this calls:
  - `computeDoorAwareGroupMovePreview(...)` @scripts/scene/token-movement-manager.js#2538-2625
  - which calls `_planDoorAwareGroupMove(...)` @scripts/scene/token-movement-manager.js#2845-2981

Important: this is synchronous planning work on the UI thread.

### 2.2 Group execution path

- Group execute entry point: `executeDoorAwareGroupMove(...)` @scripts/scene/token-movement-manager.js#2640-2835
- Phases:
  1. `_planDoorAwareGroupMove(...)` (again) @scripts/scene/token-movement-manager.js#2845-2981
  2. `_buildGroupMovementTimeline(...)` @scripts/scene/token-movement-manager.js#3199-3444
  3. `_executeGroupTimeline(...)` @scripts/scene/token-movement-manager.js#3454-3524
  4. `_reconcileGroupFinalPositions(...)` @scripts/scene/token-movement-manager.js#1578-1691

Important: preview + execute both run full planning unless explicitly reused.

### 2.3 Drag-commit path also routes through group sequencer

- Pointer-up drag commit routes multi-token updates through `executeDoorAwareGroupMove(...)` @scripts/scene/interaction-manager.js#4632-4651

So freezes can happen from both right-click group move flow and drag-commit flow.

---

## 2.4 Strategy Update (2026-02-16): Long-Range Reliability + Cohesion + Startup Freeze

### Problem signals from latest playtests

1. Long map traversals (inside building -> outside / across scene) still fail too often.
2. Group arrivals still spread into strings/gaps instead of a cohesive endpoint cluster.
3. Right-click planning still causes perceptible frame stalls in worst-case scenes.

### Key conclusion

Current weighted-grid A* plus per-token endpoint assignment is still workable for short/medium moves, but long-range reliability and group cohesion likely need a **hybrid approach**:

- **Global route first** (coarse path over a reduced search space),
- **Local detail second** (short-range refinement near each token and near destination),
- **Group control layer** (formation/lane reservation),
- **Time-sliced planning** (no long blocking bursts).

### Candidate architectural options

#### Option A (recommended first): Hierarchical pathfinding (HPA*-style)

1. Build a coarse sector graph (clustered grid / region graph) at scene load.
2. Route long-distance travel over sectors first.
3. Run local weighted A* only for:
   - start -> entry sector gateway,
   - between gateways,
   - final gateway -> destination neighborhood.

Why this helps:
- Long-range requests no longer force huge fine-grained graph search from scratch.
- Coarse route gives deterministic global direction around large wall complexes.
- Costly edge checks stay local and bounded.

Risk/effort:
- Medium implementation effort.
- Needs sector invalidation when walls/doors change.

#### Option B: Door/room portal graph (topological path) + local path stitching

1. Build graph nodes for rooms/outdoor regions and portal edges for doors/openings.
2. Plan topological route room->room first.
3. Stitch local paths per segment.

Why this helps:
- Building inside/outside transitions become robust because routing understands door topology explicitly.

Risk/effort:
- Higher complexity than Option A in irregular scenes.

#### Option C: Navigation mesh/baked walkable polygons

1. Build navmesh from walkable space and wall blockers.
2. Run funnel/string-pulling for smooth long routes.

Why this helps:
- Very strong long-distance behavior and cleaner corridor movement.

Risk/effort:
- Highest implementation and maintenance cost.

### Multi-token management options (formation quality)

#### Formation Manager Layer (recommended)

1. Leader route is authoritative (already partially implemented via shared corridor).
2. Followers get lane/slot reservations along corridor and destination envelope.
3. Destination assignment uses slot neighborhoods instead of unconstrained per-token global candidates.
4. Timeline scheduling consumes lane priorities to reduce deadlock breaker usage.

Expected gain:
- Fewer `no-non-overlap-assignment` failures.
- Reduced strung-out arrivals.
- More deterministic compact endpoint shape.

#### Flow-field style following (RTS-like)

1. Build one distance/flow field from destination over local corridor region.
2. All followers move by descending field with local collision separation.

Expected gain:
- Very scalable for large groups.

Risk:
- Requires significant rewrite of movement/timeline logic.

### Freeze mitigation options beyond current optimizations

1. **Mandatory time slicing for preview planning**
   - Hard cap per frame (e.g. 4-6ms budget), continue planning next tick.
   - Preview UI can show provisional route then refine.

2. **Planner workerization** (if practical in Foundry constraints)
   - Offload candidate scoring/assignment search orchestration to a worker-like boundary.
   - Keep collision/Foundry-sensitive calls on main thread through batched requests.

3. **Progressive quality planning**
   - Fast pass: small candidate set + coarse route only.
   - Refinement pass: expand only if user confirms move or holds click.

### Proposed phased plan (next)

Phase 1 (short term):
1. Add corridor lane reservation in assignment + timeline consumption.
2. Add explicit destination envelope target (compact ring/arc) with strict max spread.
3. Add frame-budgeted chunking in preview planner loops.

Phase 2 (medium):
1. Implement hierarchical coarse sector graph for long routes.
2. Route long moves via coarse graph + local stitching.
3. Add sector graph prewarm on scene load and invalidate on wall/door topology updates.

Phase 3 (optional advanced):
1. Evaluate portal graph or navmesh path backend.
2. Keep weighted A* as fallback backend for compatibility.

### Success criteria for this strategy update

1. Inside->outside and cross-map routes resolve reliably without manual retries.
2. Group endpoint compactness improves (tight formation spread threshold).
3. Right-click preview no longer causes multi-second stalls even in dense scenes.

---

## 3) Deep Findings: Performance Hotspots

## 3.1 Candidate generation multiplies pathfinding calls

Candidate build: `_buildGroupMoveCandidates(...)` @scripts/scene/token-movement-manager.js#2988-3113

- Defaults:
  - `groupMaxRadiusCells` default 10 (clamped up to 16)
  - `groupMaxCandidatesPerToken` default 24 (clamped up to 60)
- For each candidate, when walls are respected, it calls `findWeightedPath(...)` @scripts/scene/token-movement-manager.js#3046-3058

For 5 selected tokens at default settings, worst-case candidate path calls are roughly:
- `5 tokens * 24 candidates = 120 weighted path searches`

That is already enough to stall the frame if each search is moderately expensive.

## 3.2 Each weighted path search is itself heavy

Path search: `findWeightedPath(...)` @scripts/scene/token-movement-manager.js#1074-1228

Graph build: `generateMovementGraph(...)` @scripts/scene/token-movement-manager.js#909-1061

- Graph node budget default: `maxGraphNodes = 6000` @scripts/scene/token-movement-manager.js#942-943
- Every edge validation does collision checks:
  - `_validatePathSegmentCollision(...)` @scripts/scene/token-movement-manager.js#1481-1550
- Every traversal cost checks door intersections:
  - `_computeTraversalCost(...)` @scripts/scene/token-movement-manager.js#1699-1748
  - `findDoorsAlongSegment(...)` (iterates walls) @scripts/scene/token-movement-manager.js#4614-4666

This creates a multiplicative cost profile:

`candidate count * path searches * graph expansion * collision checks * wall scans`

That is the main freeze driver.

## 3.3 Door cost currently scans walls per edge

Door penalty is computed in `_computeTraversalCost(...)` @scripts/scene/token-movement-manager.js#1722-1734

- It calls `findDoorsAlongSegment(from, to)` for each candidate edge.
- `findDoorsAlongSegment(...)` loops all walls and does segment intersection @scripts/scene/token-movement-manager.js#4626-4643

This can become very expensive on wall-heavy scenes and is repeated many times per graph.

## 3.4 Assignment solver can go combinatorial

Assignment: `_assignGroupDestinations(...)` @scripts/scene/token-movement-manager.js#3121-3191

- For token counts <= `groupBacktrackTokenLimit` (default 8), it uses recursive branch-and-bound backtracking.
- With 5 tokens and up to 24 candidates each, theoretical search space is large.
- Overlap pruning helps, but in cluttered scenes this still contributes measurable stalls.

## 3.5 Timeline scheduling is O(ticks * n^2) and allocates heavily

Timeline build: `_buildGroupMovementTimeline(...)` @scripts/scene/token-movement-manager.js#3199-3444

- Repeated overlap checks compare proposals against accepted + stationary token states.
- Frequent rect builds and overlap tests in nested loops.
- Deadlock breaker helps correctness, but the scheduler itself is still CPU-heavy in congested paths.

## 3.6 Reconciliation can re-run full token pathing repeatedly

Reconcile pass: `_reconcileGroupFinalPositions(...)` @scripts/scene/token-movement-manager.js#1578-1691

- For unresolved tokens, it calls `executeDoorAwareTokenMove(...)` again @scripts/scene/token-movement-manager.js#1627-1634
- That can trigger fresh pathfinding + door choreography multiple passes.
- In failure/deadlock scenarios, this can amplify stalls after the initial group execute.

## 3.7 Per-step settle waits increase end-to-end latency

Movement node settle waits in `_awaitSequencedStepSettle(...)` @scripts/scene/token-movement-manager.js#4248-4273

- Polling waits for track start/finish or fallback delay.
- This is not the primary freeze source, but does contribute to clunky perceived responsiveness under heavy group moves.

## 3.8 Duplicate planning between preview and execute

Preview does full plan @scripts/scene/token-movement-manager.js#2586-2612

Execution does full plan again @scripts/scene/token-movement-manager.js#2677-2690

No plan reuse by selection+destination key means duplicated expensive work for common UX flow (preview then confirm).

---

## 4) Deep Findings: Reliability/Fallback Behavior

## 4.1 Graph truncation likely causes false negatives

`generateMovementGraph(...)` truncates at node budget and logs warning @scripts/scene/token-movement-manager.js#971-1019

When truncated, path quality/reliability drops; in some scenes this can produce `no-path` even when a path exists.

## 4.2 Search bounds can be too narrow for detours

Search bounds come from `_buildPathContext(...)` using margin defaults @scripts/scene/token-movement-manager.js#1260-1266

Large detours around wall clusters may require expansion beyond this margin; otherwise pathfinding fails and triggers fallback behavior.

## 4.3 Candidate elimination can be too strict under congestion

Candidates are filtered by:
- static occupancy overlap @scripts/scene/token-movement-manager.js#3028-3030
- optional anchor-side wall check @scripts/scene/token-movement-manager.js#3033-3043
- path-over-static occupancy @scripts/scene/token-movement-manager.js#3069-3071

Combined constraints can produce `no-group-candidate-*` failures in tight scenes.

## 4.4 Group timeline deadlocks already recognized in code

Scheduler has deadlock breaker + hard bail @scripts/scene/token-movement-manager.js#3384-3416

This protects against infinite loops, but also indicates current coordination model can become unstable in constrained flows.

## 4.5 Recovery paths can mask root-cause reliability issues

`executeDoorAwareGroupMove(...)` has timeline/reconciliation fallback recovery @scripts/scene/token-movement-manager.js#2705-2731 and #2766-2784

Good for robustness, but expensive recoveries can hide planner/scheduler root issues and increase user-visible delays.

---

## 5) Why 5 Tokens Feels Like a Cliff

A practical worst-case profile for 5-token group moves:

1. Preview plan computes (up to) ~120 path searches.
2. Confirm/execute plan recomputes similar work.
3. Each path search may scan thousands of graph nodes.
4. Each graph edge does collision checks and door intersection cost scans.
5. Assignment and timeline add extra n^2/backtracking overhead.
6. Reconciliation can trigger additional full token path execution.

This is enough to block the main thread for seconds in dense scenes.

---

## 6) Recommendations (Performance + Reliability)

## 6.1 Priority 0 (highest impact, lowest risk)

1. **Plan reuse between preview and execute**
   - Cache preview plan keyed by `(selectionKey, destinationTopLeft, movement options, door revision)`.
   - On confirm click, execute directly from cached plan if key matches.
   - Avoids immediate duplicate planning cost.

2. **Add hard per-plan CPU budget + graceful degradation**
   - Budget by candidate count and elapsed ms.
   - If budget exceeded, reduce candidate count dynamically and continue with best-known plan.

3. **Reduce default candidate fan-out for common group sizes**
   - Adaptive defaults (example):
     - 2-3 tokens: 10-14 candidates
     - 4-5 tokens: 12-16 candidates
     - 6+ tokens: raise gradually only as needed
   - Current default 24 per token is expensive for common 5-token moves.

4. **Cache door-intersection checks during one planning call**
   - Memoize `findDoorsAlongSegment(from,to)` by quantized segment key + door revision.
   - Removes repeated full wall scans for identical segment checks.

5. **Add group planning cancellation token and stale-plan abort**
   - There is cancel-token support in pathfinding core, but group planner doesn’t actively thread it through all heavy loops.
   - Abort stale previews when user re-clicks elsewhere.

## 6.2 Priority 1 (medium implementation effort)

1. **Two-phase candidate pipeline**
   - Phase A: cheap geometric candidate generation/filtering only.
   - Phase B: run weighted pathfinding only for top-K candidates per token (not all).

2. **Assignment solver guardrails**
   - Add recursion node/time cap for backtracking.
   - Fall back earlier to greedy+repair rather than long recursive search.

3. **Adaptive graph expansion when truncation occurs**
   - If no path and graph truncated, rerun once with larger bounds or node budget.
   - Improves reliability for detour-heavy maps.

4. **Spatial index for walls during door intersection checks**
   - Broadphase (grid buckets/quadtree) before segment intersection math.

## 6.3 Priority 2 (deeper architecture)

1. **Chunk planning over multiple ticks**
   - Yield to event loop every N candidates/N node expansions (`await Promise.resolve()` style).
   - Prevents long UI locks.

2. **Persistent path/cache layer per movement request**
   - Reuse path prefixes and graph neighborhoods across tokens with similar starts/goals.

3. **Alternative assignment formulation for medium groups**
   - Explore min-cost matching with overlap-aware post-pass, rather than deep branch-and-bound.

---

## 7) Reliability Enhancements Specific to Fallback Frequency

1. **Surface explicit failure reason metrics**
   - Distinguish: graph-truncated, max-iterations, no-candidate, assignment-failed, timeline-deadlock.

2. **Prefer single retry with altered parameters before hard fail**
   - Example retry matrix:
     - +search margin
     - +maxGraphNodes (bounded)
     - relaxed anchor-side check

3. **Use Foundry parity more selectively for performance**
   - Keep parity for correctness-sensitive paths, but avoid unnecessary duplicate expensive checks in non-critical phases.

---

## 8) Instrumentation Plan (Needed Before/With Fixes)

Add stage timers and counters with `[Pathfinding]` tag:

1. Group plan total ms
2. Candidate generation ms per token
3. Weighted path stats (calls, avg nodes, avg edges, avg iterations)
4. Door-segment scan calls/cache hit-rate
5. Assignment recursion node count + ms
6. Timeline build ticks, stalls, deadlock-breaker count
7. Reconciliation passes and token repair count

This makes regressions measurable and helps tune defaults per scene complexity.

---

## 9) Suggested Implementation Order

1. **Immediate quick win**: preview-plan reuse + adaptive candidate count.
2. Add planning timers/counters and baseline profiling on problem scenes.
3. Add door-segment memoization + candidate two-phase filtering.
4. Add assignment caps and retry strategy for reliability.
5. Add chunked planning/yield if freezes remain above target.

---

## 10) Success Criteria for This Issue

1. 5-token grouped move no longer freezes UI for multiple seconds.
2. Path planning remains reliable in wall-dense scenes.
3. Fallback/deadlock/reconciliation rates are reduced and measurable.
4. Preview-confirm flow does not duplicate full expensive planning work.

---

## 11) Key Code References

- Group preview entry: @scripts/scene/interaction-manager.js#1482-1625
- Group drag commit entry: @scripts/scene/interaction-manager.js#4591-4651
- Group execute pipeline: @scripts/scene/token-movement-manager.js#2640-2835
- Group planning: @scripts/scene/token-movement-manager.js#2845-2981
- Candidate generation: @scripts/scene/token-movement-manager.js#2988-3113
- Assignment solver: @scripts/scene/token-movement-manager.js#3121-3191
- Timeline scheduler: @scripts/scene/token-movement-manager.js#3199-3444
- Timeline executor: @scripts/scene/token-movement-manager.js#3454-3524
- Reconciliation pass: @scripts/scene/token-movement-manager.js#1578-1691
- Weighted path core: @scripts/scene/token-movement-manager.js#909-1228
- Collision edge validation: @scripts/scene/token-movement-manager.js#1481-1550
- Door segment scanning: @scripts/scene/token-movement-manager.js#4614-4666
