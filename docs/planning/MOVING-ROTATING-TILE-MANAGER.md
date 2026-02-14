# Moving / Rotating Tile Manager — Planning Document

## Status
First complete slice implemented through Phase 6 (runtime + dialog + sync hardening baseline).

## Goal
Create a new high-level tile animation system with a dedicated Tweakpane dialog that supports:
- per-tile opt-in (disabled by default)
- visual movement/rotation animation without mutating Foundry tile docs every frame
- custom pivots (including optional grid snapping)
- parent/child chaining for complex mechanical setups (e.g., orrery arms + planets + moons)
- repeatable periodic motion patterns (circular, ping-pong, loops) to minimize sync complexity
- optional texture-space animation (scroll/rotate UVs) as a cheaper alternative to physical transform animation

## Non-Goals (v1)
- Full deterministic lockstep sync of every frame across GM + all players
- Writing animated transforms back into Foundry tile document x/y/rotation continuously
- Physics simulation (forces, collisions, constraints)
- General timeline editor with arbitrary keyframes

## Architectural Constraints
- Three.js is the rendering authority; this system should animate Three tile sprites/meshes, not PIXI visuals.
- Coordinate conversion must respect Foundry (top-left, Y-down) vs Three (Y-up) conventions.
- Start/stop synchronization is required; continuous phase sync is optional.
- Avoid per-frame allocations in hot paths.

## Feature Summary

### 1) Per-Tile Enablement (Default OFF)
Each tile gets a motion config block under module flags:
- If no config or `enabled: false`, tile behaves normally.
- Enabled tiles are registered with the runtime motion evaluator.

### 2) Two Animation Modes
1. **Transform Mode (visual tile motion)**
   - Move/rotate the rendered tile sprite in Three.js only.
   - Foundry document remains unchanged during playback.
2. **Texture Mode (UV motion)**
   - Scroll/rotate texture coordinates for visual movement illusion.
   - Preferred for effects where physical tile movement is unnecessary.

### 3) Parenting & Hierarchies
- Support parent-child tile relationships by tile ID.
- Child local transforms are evaluated in parent space.
- Supports chained systems (arm -> planet -> moon arm -> moon).
- Detect and block cycles in parent graph.

### 4) Custom Pivot Editing
- Pivot defaults to tile center.
- User can set local pivot offsets or world pivot points.
- Optional snap-to-grid points toggle during pivot editing.

### 5) Repeatable Motion Patterns
V1 motion primitives should be periodic/reversible for easy sync:
- Rotation (constant angular speed)
- Orbit (circular path around pivot)
- Ping-pong translation between A/B
- Sinusoidal offsets (x/y/rotation)
- Texture scroll / texture rotation

All primitives expose `phase`, `speed`, `amplitude/radius`, and `loopMode` (`loop`, `pingPong`).

## Proposed Data Model (Scene Flags)

```json
flags.map-shine-advanced.tileMotion = {
  "version": 1,
  "global": {
    "playing": false,
    "startEpochMs": 0,
    "seed": 0
  },
  "tiles": {
    "<tileId>": {
      "enabled": false,
      "mode": "transform",
      "parentId": null,
      "pivot": {
        "space": "local",
        "x": 0.0,
        "y": 0.0,
        "snapToGrid": false
      },
      "motion": {
        "type": "rotation",
        "speed": 1.0,
        "phase": 0.0,
        "radius": 0.0,
        "pointA": [0, 0],
        "pointB": [0, 0],
        "loopMode": "loop"
      },
      "textureMotion": {
        "enabled": false,
        "scrollU": 0.0,
        "scrollV": 0.0,
        "rotateSpeed": 0.0,
        "pivotU": 0.5,
        "pivotV": 0.5
      }
    }
  }
}
```

## Runtime Design

### New Runtime Manager
Create `TileMotionManager` responsible for:
- loading/parsing motion config from scene flags
- registering enabled tile sprites from `TileManager`
- evaluating local + world transforms each frame using `timeInfo`
- applying transforms to tile sprites/material UV matrices
- handling start/stop and parent graph ordering

### Integration with TileManager
`TileManager` already handles create/update/delete/refresh hooks and sprite transform sync. Integrate by:
- registering/unregistering tiles with `TileMotionManager`
- allowing motion manager to apply an additional animation transform layer after base transform
- invalidating/rebinding motion state when tile doc changes (size/rotation/flags/texture)

### Update Order
1. Compute base tile transform from tile doc (existing behavior)
2. Apply motion local transform (pivot + rotation/translation)
3. Resolve parenting (topological order)
4. Apply final matrix to sprite
5. Apply texture-space animation (if enabled)

## Synchronization Plan

### Minimum Required Sync
Sync these values via scene flags/document updates:
- `global.playing`
- `global.startEpochMs`
- motion config changes

When GM presses Start/Stop:
- write new global state to scene flag
- all clients immediately pick up same start epoch and run locally

### Why this works
Periodic motion means absolute phase can be derived from:
`phaseNow = basePhase + (nowMs - startEpochMs) * speed`

This avoids heavy continuous state replication.

### Optional Nice-to-Have (Post-v1)
- periodic phase correction packets from GM (low frequency, e.g. every 5-10s)
- per-client drift diagnostics

## UI/UX Plan (New Tweakpane Dialog)

Create a dedicated dialog (similar in spirit to Map Points manager) with:

### Panel A: Tile List
- searchable list of tiles
- enable toggle per tile
- quick status indicators: Disabled / Active / Missing Parent / Invalid Cycle

### Panel B: Motion Editor
- mode selector: Transform vs Texture
- motion type dropdown
- speed/phase/radius/amplitude controls
- loop mode selector
- start/stop preview controls

### Panel C: Pivot & Parenting
- pivot editor with numeric + pick-on-canvas mode
- snap-to-grid toggle
- parent selector (tile dropdown)
- hierarchy preview (simple tree)

### Panel D: Global Transport
- Start
- Stop
- Reset phase to zero
- Play-state readout

## Suggested File Additions
- `scripts/scene/tile-motion-manager.js`
- `scripts/ui/tile-motion-dialog.js`
- `docs/planning/MOVING-ROTATING-TILE-MANAGER.md` (this file)

## Expected File Touch Points
- `scripts/scene/tile-manager.js` (register/unregister/sync into motion manager)
- `scripts/foundry/canvas-replacement.js` (initialize/dispose manager, expose on `window.MapShine`)
- `scripts/ui/tweakpane-manager.js` (button to open Tile Motion dialog)
- `scripts/settings/scene-settings.js` (flag helpers/version migration)

## Implementation Phases

### Phase 0 — Contracts & Persistence
- finalize flag schema and validation
- implement load/save helpers + migration guard

### Phase 1 — Core Runtime (No Parenting Yet)
- per-tile enable/disable
- rotation around configurable pivot
- simple start/stop sync

### Phase 2 — Parenting Graph
- parent assignment
- cycle detection + error surfacing
- hierarchical transform evaluation

### Phase 3 — Translation Primitives
- point A/B ping-pong
- circular orbit mode
- sinusoidal offsets

### Phase 4 — Texture Animation
- UV scrolling
- UV rotation around configurable UV pivot
- per-material safety checks

### Phase 5 — UI Dialog & Authoring Workflow
- complete Tweakpane dialog
- pick-on-canvas pivot workflow
- hierarchy visibility + validation messages

### Phase 6 — Sync Hardening & Polish
- robust start/stop propagation
- scene reload/state recovery
- optional drift correction hooks

## Validation & Testing Checklist
- Disabled-by-default behavior validated on existing scenes
- Start/Stop from GM propagates to all clients
- Tile create/delete/update while playing does not break graph
- Parent cycle creation is blocked and reported
- Pivot snap aligns correctly to grid points
- Texture animation works on tiles with varied scales/rotations
- No per-frame allocations in update loop
- No edits to Foundry tile document per frame

## Risks / Notes
- Parenting can become expensive if hierarchy resolution is repeated unnecessarily; cache topological order until graph changes.
- Texture animation depends on material compatibility; guard for nonstandard material states.
- Map Maker mode interactions must not fight runtime animation transforms.
- If tile transform and texture transform are both enabled, document precedence clearly in UI.

## Open Questions
1. Should per-tile animation settings be editable by GM only, or also by trusted players? - GM Only
2. Should child transforms inherit parent scale in v1, or position+rotation only? - Position + Rotation
3. For orbit mode, do we want clockwise/counterclockwise as explicit control or signed speed only? - Either is fine as long as I can spin things both ways.
4. Should Start/Stop live in the global Tweakpane controls as well as the dedicated dialog? - It can go into the 'Map Shine Control Panel' seperate small UI as a new section which just has a start/stop button and a slider to control the speed via a percentage.
5. Do we want a lightweight preset library (e.g., Orrery Arm, Conveyor Belt, Floating Sigil) in v1 or later? - No need.
