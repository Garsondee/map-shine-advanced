# Token Movement Manager Plan (Map Shine Advanced)

## Status
- Phase: Planning Session 1 + Session 2 Addendum (door choreography + fog-safe pathing)
- Priority: High (core gameplay feel + movement correctness)
- Scope in this document: manager architecture, motion styles, weighted A* planning, Foundry integration strategy, advanced door traversal, fog-safe player path visibility

---

## 1) Goal
Create a new `TokenMovementManager` that controls how token movement is presented and validated when a player or GM moves a token from one grid space to another.

This manager should provide:
1. Better movement visuals (multiple animation styles)
2. Strong movement correctness (walls, grid, terrain/cost)
3. A robust pathfinding core (weighted A* with Foundry-aware collision checks)
4. Safe integration with server-authoritative Foundry token updates
5. Intelligent door choreography (pause, open, pass through, optional close)
6. Fog-of-war-safe path planning and path preview behavior for players

Primary movement style goals from request:
- "Walk" style between A -> B (path-following on the board)
- "Pick Up and Drop" style (3D arc through space, then settle)
- API placeholders for "flying" tokens (hover, gentle rock, plus ground line + circle marker)

---

## 2) Product Requirements (Session 1 Capture)

1. New runtime manager dedicated to token movement behavior.
2. Support multiple animation profiles selectable at runtime.
3. Movement must still be compatible with Foundry token update authority.
4. Add a weighted A* pathfinding system that is robust with:
   - Foundry wall constraints
   - grid snapping and grid types
   - movement cost/terrain rules where available
5. Design for phased delivery (we will continue planning in multiple sessions).
6. Add advanced door-aware movement:
   - stop before door
   - open door (if allowed)
   - continue through doorway
   - optional close behavior after crossing, with combat-aware policies
7. Player path previews must not leak hidden map information through fog-of-war.

---

## 3) Current Baseline (Repo Research)

### 3.1 Current local drag commit path (Map Shine)
In current Three-side interaction flow, token drag commit sends direct document updates:
- `canvas.scene.updateEmbeddedDocuments('Token', tokenUpdates, updateOptions)`
- with optional unconstrained movement options for GM unrestrained mode.

Current location:
- `scripts/scene/interaction-manager.js`

### 3.2 Current token animation path (Map Shine)
Token sprite movement currently happens in `TokenManager` on Foundry `updateToken` hook:
- Hook registration in `setupHooks()`
- `updateTokenSprite(...)` merges `changes` with doc
- `updateSpriteTransform(...)` does straight transform animation (distance-based duration)
- `startAnimation(...)` stores active attribute tweens

Current location:
- `scripts/scene/token-manager.js`

### 3.3 Foundry movement internals relevant to planning
Foundry already has robust movement concepts we should align with, not fight:
- Drag context and waypoint workflows
- movement payload includes waypoints + constrain options
- constrain/collision uses polygon backends and movement source context
- cost/terrain-aware path constraints
- `findMovementPath(...)` and movement path recalculation logic

### 3.4 Foundry door model and permissions (research addendum)
Foundry has explicit door data and interaction primitives that we should reuse:
1. Door typing and state are built-in constants:
   - `CONST.WALL_DOOR_TYPES`: NONE / DOOR / SECRET
   - `CONST.WALL_DOOR_STATES`: CLOSED / OPEN / LOCKED
2. Door controls toggle by updating wall document `ds`.
3. Player door permissions are constrained in `BaseWall`:
   - non-GM can update only `ds`
   - and only when neither current nor target state is LOCKED
   - so players can open/close unlocked doors, but cannot lock/unlock.
4. Door interaction UI checks `game.user.can("WALL_DOORS")` and pause restrictions.
5. Open doors remove movement/sight/sound blocking at edge creation time.

Planning implication:
- door traversal should be modeled as explicit wall state transitions in movement sequencing, not as custom phantom pass-through logic.

### 3.5 Foundry fog-aware movement preview behavior (research addendum)
Relevant current Foundry behavior:
1. Drag pathfinding uses preview mode (`preview: true`) with delayed recalculation jobs.
2. In preview collision checks, only collisions at explored/visible points block preview movement.
3. Terrain preview pathing subdivides segments by explored/visible status.
4. There is an existing TODO in Foundry token collision code: non-visible open doors should be considered closed for preview.

Planning implication:
- we should implement explicit fog-safe policies so player path previews never reveal hidden walls/doors via path shape or failure details.

Current reference locations:
- `foundryvttsourcecode/resources/app/client/canvas/placeables/token.mjs`
- `foundryvttsourcecode/resources/app/public/scripts/foundry.mjs`
- `foundryvttsourcecode/resources/app/client/_types.mjs`
- `foundryvttsourcecode/resources/app/common/constants.mjs`
- `foundryvttsourcecode/resources/app/common/documents/wall.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/placeables/wall.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/containers/elements/door-control.mjs`

---

## 4) Architecture Proposal

### 4.1 New manager
Create:
- `scripts/scene/token-movement-manager.js`

### 4.2 Responsibilities
`TokenMovementManager` owns:
1. Movement intent intake
   - drag commits
   - programmatic moves
   - remote user moves (via authoritative updates)
2. Path planning
   - weighted A* primary search
   - Foundry collision and movement rule checks
3. Motion profile application
   - walk, pick-up-drop, future profiles
4. Runtime animation state
   - active motion tracks per token
   - interruption/replacement policy
5. Movement event lifecycle
   - movement-start, movement-progress, movement-complete, movement-cancel
6. Visual extras for special modes
   - flying placeholder line + circle marker

### 4.3 Separation of concerns
- `InteractionManager`: user input + preview drag geometry, no final movement style logic.
- `TokenManager`: token sprite ownership + texture/selection/visibility.
- `TokenMovementManager`: pathing + animation track generation + runtime pose updates.

### 4.4 Authority model (critical)
Keep Foundry as authoritative source of token state.

Rule set:
1. No optimistic permanent token position writes in Three scene.
2. Use authoritative `updateToken` updates to confirm movement.
3. Visual interpolation/animation is local presentation of authoritative change.

This avoids classic desync and "one move behind" classes of bugs.

---

## 5) Movement Data Model

### 5.1 Movement intent
```js
{
  tokenId,
  source: 'drag' | 'api' | 'remote' | 'script',
  from: { x, y, elevation, width, height, shape },
  to: { x, y, elevation, width, height, shape },
  waypoints: [],
  options: {
    snap: true,
    ignoreWalls: false,
    ignoreCost: false,
    action: 'walk'
  },
  style: 'walk' | 'pick-up-drop' | 'flying-glide'
}
```

### 5.2 Movement track (runtime)
```js
{
  tokenId,
  movementId,
  style,
  pathNodes: [ ... ],
  durationMs,
  elapsedMs,
  state: 'active' | 'complete' | 'cancelled',
  pose: {
    x, y, z,
    rotation,
    tilt,
    scale,
    shadowOpacity
  }
}
```

### 5.3 Manager settings (initial)
- Scene-level defaults (GM-authoritative):
  - default movement style
  - default speed profile
  - pathfinding quality mode
  - collision strictness
- Client-level display preferences:
  - local animation quality cap
  - optional reduced motion mode

---

## 6) Weighted A* Pathfinding Design

## 6.1 Why weighted A*
Weighted A* (f = g + w*h, w > 1) gives:
- faster route finding than strict A* in many practical maps
- tunable quality/performance tradeoff
- predictable behavior for real-time movement UX

Initial target:
- `w = 1.15` default
- optional presets: exact-ish (1.0), balanced (1.15), fast (1.35)

### 6.2 Node graph
Graph generation by grid type:
1. Square grid: 4-way or 8-way neighbor mode (configurable)
2. Hex grid: axial neighbors according to Foundry grid orientation
3. Gridless fallback: sampled lattice graph with configurable step

Node payload:
```js
{
  x, y, elevation,
  cellId,
  terrainCost,
  occupied,
  blocked
}
```

### 6.3 Edge validity (walls and blockers)
Each candidate step must pass Foundry-aware collision checks.

Primary checks:
1. Movement collision type: `move` backend first
2. Fallback checks if needed for odd scenes: `sight`, then `light`
3. Token shape/size aware endpoint and center adjustments

Integration target APIs:
- `tokenObj.checkCollision(...)` when available
- `CONFIG.Canvas.polygonBackends[type].testCollision(...)` for explicit backend checks

### 6.4 Cost function (g)
Base movement cost components:
1. Distance cost
   - cardinal, diagonal, or hex distance
2. Terrain cost
   - use Foundry terrain/region effect data where available
3. Door/wall interaction penalty
   - soft penalty for passable interactions, infinite for blocked
4. Occupancy penalty
   - avoid clustering and body overlap where possible
5. Turn penalty (optional)
   - slight preference for smoother paths

### 6.5 Heuristic (h)
- Square: octile or Manhattan depending on neighbor mode
- Hex: axial hex distance
- Gridless lattice: Euclidean

Heuristic should remain admissible when `w = 1.0` and intentionally bounded-suboptimal when weighted.

### 6.6 Constrain options parity
Path planner must mirror Foundry movement flags:
- `ignoreWalls`
- `ignoreCost`
- history/preview considerations when needed

### 6.7 Foundry parity guardrail
After path result is found:
1. Validate segments against Foundry collision backend.
2. If major mismatch with Foundry-constrained result, defer to Foundry path output.

This keeps behavior reliable across systems/rulesets.

### 6.8 Door-aware path augmentation
When a candidate path intersects a door wall segment:
1. Insert synthetic waypoints:
   - `preDoorHold` (safe stand point before crossing)
   - `postDoorEntry` (first valid point after crossing)
2. Treat door transition as an action step with explicit state requirements.
3. Cost model additions:
   - open unlocked door: finite interaction cost + pause duration
   - locked door without unlock capability: infinite cost
   - secret door not detected/visible for player: blocked in strict mode
4. Mark path segments with metadata for choreography:
   - `segment.requiresDoorOpen`
   - `segment.doorWallId`
   - `segment.closeAfterCrossingCandidate`

### 6.9 Door choreography state machine
Add a movement-door sequencer for execution-time control:

1. `APPROACH_DOOR`
2. `PRE_DOOR_HOLD`
3. `REQUEST_DOOR_OPEN`
4. `WAIT_FOR_DOOR_OPEN`
5. `CROSS_DOOR`
6. `POST_DOOR_POLICY_EVAL`
7. `REQUEST_DOOR_CLOSE` (optional)
8. `RESUME_PATH`

Door policy configuration (planning contract):
```js
doorPolicy: {
  autoOpen: true,
  autoClose: "never" | "always" | "outOfCombatOnly" | "combatOnly",
  closeDelayMs: 0,
  playerAutoDoorEnabled: false,
  requireDoorPermission: true
}
```

### 6.10 Combat-aware door close rules
Requested behavior example is supported as policy:
- if token is in active combat, keep door open (default for `outOfCombatOnly`).

Policy evaluation inputs:
1. combat active state (`game.combat?.started`)
2. token combatant participation
3. door ownership/permission
4. whether another token currently occupies doorway zone

### 6.11 Door operation authority and safety
Door actions must remain permission-safe:
1. never bypass Foundry document permission checks
2. submit normal wall `ds` updates and accept rejection
3. if open fails (locked/permission/race), stop at `preDoorHold` and emit non-leaking feedback
4. detect external door state races and replan from current node if needed

### 6.12 Fog-of-war-safe player path policy
Add explicit per-scene/player policy modes:

1. `strictNoFogPath`:
   - players cannot pathfind into unexplored/unseen regions
   - hidden nodes are treated as blocked for planning
2. `allowButRedact`:
   - planner may search beyond visible frontier
   - preview only renders visible/explored prefix
   - hidden continuation is represented as unknown marker, not geometry
3. `gmUnrestricted`:
   - GM bypass for authoring/administration

Leak-prevention rules:
1. never render hidden collision points for players
2. never render "path bends" caused only by hidden walls
3. hidden door state should be treated conservatively (closed) in player preview
4. failure messages in hidden areas remain generic (no structural hints)

---

## 7) Animation Style System

### 7.1 Profile contract
Each style implements a shared profile interface:
```js
{
  id,
  label,
  buildTrack(intent, context),
  samplePose(track, tNorm),
  supportsFlight: boolean
}
```

### 7.2 Style A: Walk
Characteristics:
- follows computed path node-by-node
- remains near board plane (ground + elevation)
- slight bob/heading interpolation for life-like movement

Controls:
- speed (cells/sec)
- turn smoothing
- bob amount/frequency

### 7.3 Style B: Pick Up and Drop
Characteristics:
- starts at origin, lifts into Z arc, traverses, drops to destination
- good for tactical "move piece" readability

Track shape:
1. Lift phase
2. Travel phase (bezier arc)
3. Settle phase

Controls:
- arc peak height (distance-scaled)
- hang time ratio
- settle easing

### 7.4 Style C: Flying Placeholder API
Initial placeholder behavior:
- token hovers above board with constant offset
- gentle side-to-side rock
- ground indicator line (vertical tether)
- ground indicator circle (which tile/point token is over)

Placeholder API:
```js
setTokenFlightState(tokenId, {
  enabled,
  hoverHeight,
  rockAmplitude,
  rockFrequency,
  showGroundLine,
  showGroundCircle
});

getTokenFlightState(tokenId);
```

Note: This is intentionally an API and visualization placeholder in early phases, not full flight combat logic.

---

## 8) Coordinate and Rendering Rules

### 8.1 Coordinate conversions
All movement calculations must respect:
- Foundry data: top-left origin, Y-down
- Three world: Y-up

Use existing coordinate helper conventions for consistency.

### 8.2 Token anchoring
Token docs are top-left anchored.
For world placement, operate from token center where needed for path and visual arc math.

### 8.3 Layering and indicators
Ground line/circle indicators for flying placeholders should:
- use explicit render order above ground
- avoid unintended roof bleed-through
- keep depth behavior intentional and stable

---

## 9) Runtime Flow (Planned)

### 9.1 Drag move flow
1. User drags token preview (existing InteractionManager flow).
2. On commit, movement intent is built and submitted.
3. Foundry authoritative update arrives.
4. `TokenMovementManager` resolves path + style track.
5. Token sprite animates through track.
6. Movement complete event fires; state is cleaned.

### 9.2 Programmatic/API move flow
1. Script or GM command requests move.
2. Manager builds intent and options.
3. Foundry document update is requested.
4. On authoritative update, track animation runs.

### 9.3 Interrupt/replace behavior
If a token receives a new move while already moving:
1. Cancel or blend-out old track (policy setting)
2. Start new track from current rendered pose toward new target
3. Ensure final snap is still authoritative and exact

### 9.4 Door-aware traversal flow (new)
1. Path execution reaches a `preDoorHold` node.
2. Token pauses using selected style's hold animation.
3. Manager requests wall `ds` transition to OPEN.
4. On authoritative wall update success, token crosses doorway.
5. Post-crossing policy decides whether close is attempted.
6. If close is attempted, manager updates `ds` to CLOSED when safe.
7. On failure to open/close, manager degrades gracefully and replans/halts based on policy.

### 9.5 Fog-safe player preview flow (new)
1. Planner classifies path segments as visible vs hidden.
2. UI renderer receives redacted path payload for players.
3. Hidden segment geometry is withheld.
4. Server-authoritative move still validates full path on execution.

---

## 10) Integration Points

### 10.1 Initial file touchpoints (expected future implementation)
- `scripts/scene/interaction-manager.js`
  - route token movement commit through manager APIs
- `scripts/scene/token-manager.js`
  - delegate movement animation handling to TokenMovementManager
- `scripts/foundry/canvas-replacement.js`
  - initialize/dispose manager and register as updatable
- `scripts/foundry/manager-wiring.js`
  - expose manager in debug/runtime registry

### 10.2 Event hooks
- consume `updateToken` as authoritative movement trigger
- listen for wall/grid scene updates to invalidate path caches
- support token create/delete for occupancy graph refresh
- listen for wall updates (`updateWall`, `createWall`, `deleteWall`) to refresh door graph state
- listen for combat lifecycle updates to evaluate door close policies
- listen for visibility/fog refresh events to update player path-redaction boundaries

---

## 11) Phased Delivery Plan

### Phase TM-1: Contracts and scaffolding
- define manager interface and lifecycle
- add no-op movement style registry
- wire manager into runtime and update loop

### Phase TM-2: Pathfinding foundation (weighted A*)
- implement graph generation (square + hex)
- implement weighted A* core + cancellation
- implement collision validation against Foundry wall checks

### Phase TM-3: Door intelligence and choreography
- build door intersection detection and synthetic hold nodes
- implement door state machine (open/wait/cross/optional close)
- implement permission-safe wall `ds` update flow and fallback behavior

### Phase TM-4: Foundry parity and fog-safe player constraints
- map `ignoreWalls` and `ignoreCost` options
- add path parity fallback to Foundry-constrained outputs
- harden with terrain/cost compatibility
- implement `strictNoFogPath` and `allowButRedact` policy modes
- ensure player previews do not leak hidden wall/door topology

### Phase TM-5: Animation profile system
- implement walk profile
- implement pick-up-drop profile
- expose style selection defaults

### Phase TM-6: Flying placeholder API
- add hover/rock state
- add ground line + circle indicator visuals
- expose placeholder API methods

### Phase TM-7: UI and settings integration
- add panel controls for style and path settings
- add per-token override hooks (future-facing)
- add door policy controls (GM + optional player availability)
- add fog-path policy controls for player view safety

### Phase TM-8: QA and hardening
- multiplayer movement desync tests
- stress tests with many simultaneous token moves
- path correctness regression suite across wall-heavy maps
- door race/permission/locked-door scenarios
- fog-of-war leakage regression tests (path geometry and error messaging)

---

## 12) Acceptance Criteria (Session 1 Target)

### Functional
1. Manager architecture and contracts are clearly defined.
2. Weighted A* strategy is defined with Foundry wall/grid compatibility plan.
3. Walk and pick-up-drop style behavior is fully specified at planning level.
4. Flying placeholder API and indicator behavior are specified.
5. Delivery is broken into concrete implementation phases.
6. Door-aware movement includes pause-open-pass and policy-driven optional close.
7. Door automation can be optionally available to players with permission gating.
8. Player path previews have explicit fog-safe anti-leak policy.

### Quality
1. Plan preserves server-authoritative token truth.
2. Plan avoids coordinate-system mistakes between Foundry and Three.
3. Plan includes explicit fallback strategy when custom pathfinding conflicts with Foundry constraints.
4. Plan includes explicit handling for multi-user door race conditions.
5. Plan includes explicit hidden-information leak prevention in path UX.

---

## 13) Risks and Mitigations

1. Risk: Custom pathfinder diverges from Foundry rules.
   - Mitigation: parity validation + fallback to Foundry-constrained path.

2. Risk: Movement animation introduces desync/jitter under latency.
   - Mitigation: authoritative-update trigger model, track interruption policy, exact final snap.

3. Risk: Pathfinding cost too high on large scenes.
   - Mitigation: weighted heuristic tuning, incremental budgets, cache invalidation by hooks.

4. Risk: Visual clutter from flying indicators.
   - Mitigation: per-token toggle and style controls, sensible defaults.

5. Risk: Complex systems (terrain/doors/elevation) produce edge-case failures.
   - Mitigation: phased rollout with focused regression maps and fail-safe fallback behavior.

6. Risk: Door state race conditions in multiplayer (another user changes door mid-path).
   - Mitigation: authoritative wall update checks + local state machine replan/abort logic.

7. Risk: Player path preview leaks hidden walls/doors via geometry shape.
   - Mitigation: segment redaction, generic hidden-area failures, conservative hidden-door assumptions.

8. Risk: Auto-door behavior feels noisy or disruptive in combat.
   - Mitigation: policy presets with out-of-combat default close behavior and per-scene tuning.

---

## 14) Open Decisions for Session 2

1. Path authority mode:
   - A) Custom weighted A* primary + Foundry fallback
   - B) Foundry path primary + custom weighted A* only for style/preview enhancements

2. Style default policy:
   - global default only
   - per-token override
   - per-user display override

3. Movement commit payload strategy:
   - submit only final destination
   - submit full waypoint path to Foundry when available

4. Combat strictness:
   - always cost strict
   - GM override strictness in live play

5. Gridless scenes:
   - sampled lattice pathing resolution and performance cap

6. Door close policy default:
   - never close
   - always close
   - close out of combat only (recommended default)

7. Door close timing:
   - immediate close after crossing
   - delayed close window
   - close only when doorway cell is clear

8. Fog-path default for players:
   - strict no-fog path
   - allow but redact hidden path segments

9. Hidden door behavior in player planning:
   - always treated as blocked unless discovered
   - system/module-discovery integration later

10. Player feature scope:
   - scene-level toggle enabling player auto-door traversal
   - per-user opt-in/opt-out for automation

---

## 15) Reference Files

Map Shine source:
- `scripts/scene/interaction-manager.js`
- `scripts/scene/token-manager.js`
- `scripts/foundry/canvas-replacement.js`

Foundry source references:
- `foundryvttsourcecode/resources/app/client/canvas/placeables/token.mjs`
- `foundryvttsourcecode/resources/app/public/scripts/foundry.mjs`
- `foundryvttsourcecode/resources/app/client/_types.mjs`
- `foundryvttsourcecode/resources/app/common/constants.mjs`
- `foundryvttsourcecode/resources/app/common/documents/wall.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/placeables/wall.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/containers/elements/door-control.mjs`

Related in-repo collision pattern reference:
- `scripts/effects/PlayerLightEffect.js`

---

## 16) Implementation Status

### Completed
| Phase | Feature | File(s) | Notes |
|-------|---------|---------|-------|
| TM-1 | Manager class, lifecycle, constructor, deps | `token-movement-manager.js` | Core scaffolding |
| TM-1 | Style registry (walk, pick-up-drop, flying-glide) | `token-movement-manager.js` | Default styles + `registerStyle()` |
| TM-1 | Per-token style override + flag-based selection | `token-movement-manager.js` | `getStyleForToken()` |
| TM-1 | Canvas lifecycle wiring (init, update, dispose) | `canvas-replacement.js` | Registered as updatable |
| TM-1 | TokenManager integration (delegation + fallback) | `token-manager.js` | `handleTokenSpriteUpdate()` delegates with fallback |
| TM-1 | Global exposure via `window.MapShine` | `manager-wiring.js` | `tokenMovementManager` property |
| TM-1 | Hook subscriptions (wall CRUD, combat lifecycle) | `token-movement-manager.js` | Door revision + combat state tracking |
| TM-5 | Pick-up-drop animation track | `token-movement-manager.js` | Arc animation, duration scaling, rotation lerp |
| TM-6 | Flying placeholder API | `token-movement-manager.js` | `setFlyingState()`, `clearFlyingState()`, `isFlying()` |
| TM-6 | Ground indicator visuals (ring + dashed tether) | `token-movement-manager.js` | Three.js Group with Ring + LineDashed |
| TM-6 | Rock animation in update loop | `token-movement-manager.js` | Sine-wave rotation oscillation per frame |
| TM-6 | Flying-glide style runtime integration | `token-movement-manager.js` | Custom glide track + hover-state maintenance in `handleTokenSpriteUpdate()` |
| TM-3 | Door detection helpers | `token-movement-manager.js` | `findDoorsAlongSegment()`, `findDoorsAlongPath()` |
| TM-3 | Door-aware plan builder | `token-movement-manager.js` | `buildDoorAwarePlan()` with hold/entry points + close policy |
| TM-3 | Permission-safe door state update helpers | `token-movement-manager.js` | `requestDoorStateByWallId()`, `requestDoorOpen()`, `requestDoorClose()`, `awaitDoorState()` |
| TM-3 | Door choreography execution helpers (scaffold) | `token-movement-manager.js` | `executeDoorStepOpen()` and `executeDoorStepClose()` |
| TM-3 | Door state-machine movement coupling | `token-movement-manager.js` | `runDoorStateMachineForPlan()` now traverses path nodes, executes hold/open/cross/close, and rejoins remaining path |
| TM-3 | Door-step execution wiring into movement sequencer | `token-movement-manager.js`, `interaction-manager.js` | `executeDoorAwareTokenMove()` uses real `moveToPoint` document updates; drag commit calls sequencer with fallback path |
| TM-4 | Foundry parity fallback path | `token-movement-manager.js` | Uses `token.findMovementPath()` parity check and fallback selection; maps `ignoreWalls`/`ignoreCost` into Foundry constrain options |
| TM-5 | Walk animation profile | `token-movement-manager.js` | Custom walk track with smoothstep interpolation, heading lerp, and configurable bob motion |
| TM-7 | UI/settings panel integration | `tweakpane-manager.js`, `token-movement-dialog.js` | Added Token Movement dialog launcher and controls for style, fog path policy, weighted A* weight, and door policy |
| TM-4 | Fog-safe visibility check | `token-movement-manager.js` | `isPointVisibleToPlayer()` using `canvas.fog` + `canvas.visibility` |
| TM-4 | Path redaction with native fog APIs | `token-movement-manager.js` | `redactPathForPlayer()` wired to Foundry fog/visibility |
| TM-2 | Weighted A* pathfinding core | `token-movement-manager.js` | `findWeightedPath()` + `generateMovementGraph()` with square/hex/gridless neighbor generation, weighted scoring, and search cancellation |
| TM-2 | Collision-aware edge validation | `token-movement-manager.js` | Uses `token.checkCollision()` with Foundry backend fallback (`CONFIG.Canvas.polygonBackends`) during graph edge acceptance |
| TM-1 | Door/fog policy setters | `token-movement-manager.js` | `setDoorPolicy()`, `setFogPathPolicy()` |
| TM-1 | Diagnostics snapshot | `token-movement-manager.js` | `getImplementationStatus()` |

### Not Yet Implemented
| Phase | Feature | Notes |
|-------|---------|-------|
| TM-8 | QA and hardening | Multiplayer, stress, regression tests |

---

## 17) Planning Session Closeout
This document is Planning Session 1 for Token Movement Manager.

Next planning session should focus on:
1. selecting the authority model (custom A* vs Foundry-first hybrid)
2. finalizing door policy matrix and defaults (including combat handling)
3. locking fog-of-war player path policy default (strict vs redacted)
4. finalizing path payload schema (token + door action metadata)
5. locking walk vs pick-up-drop parameter ranges
6. defining first implementation cut (TM-1 and TM-2)
