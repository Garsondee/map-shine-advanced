# PLAN: Activating Legacy Lightning Map Points (Backwards Compatibility)

## Goal

Enable existing v1.x "Lightning" map point groups (stored in scene flags) to automatically drive a new Three.js lightning effect in Map Shine Advanced.

This plan focuses on:
- preserving the legacy data shape (`flags.map-shine.mapPointGroups`)
- consuming lightning groups from the current `MapPointsManager`
- wiring the effect into the current Three.js render pipeline and UI

## What v1.x Did (Source of Truth)

Legacy module behavior (from `oldmapshinemodulecode/scripts/module.js`, `LightningLayer`):
- **[storage]** Lightning points were stored as Map Point groups under `flags.map-shine.mapPointGroups`.
- **[eligibility]** A group produced lightning if:
  - `group.type === "line"`
  - `group.isEffectSource === true`
  - `group.effectTarget === "lightning"`
  - `group.points.length >= 2`
- **[endpoints]** The v1.x `LightningLayer` treated:
  - `group.points[0]` as the origin
  - `group.points[group.points.length - 1]` as the destination
  - intermediate points were not used for path shaping.
- **[timing]** A per-group burst scheduler ran using `requestAnimationFrame` + `performance.now()`.
- **[rendering]** Lightning was drawn with `PIXI.Graphics` using 3-layer strokes (outer glow, mid glow, core).

## Current v2 State

- `scripts/scene/map-points-manager.js` already provides backwards compatibility by loading:
  - `flags.map-shine-advanced.mapPointGroups` (preferred)
  - falling back to `flags.map-shine.mapPointGroups` (legacy)
- `MapPointsManager` exposes:
  - `getGroupsByEffect(effectTarget)`
  - `getLinesForEffect(effectTarget)`
- Current runtime wiring exists for:
  - Fire map points → `FireSparksEffect.setMapPointsSources(mapPointsManager)`
  - Smelly flies map points → `SmellyFliesEffect.setMapPointsSources(mapPointsManager)`
- Lightning is currently **not implemented** in v2 (per `docs/BACKWARDS-COMPATABILITY.md`).

## Activation Plan (High Level)

### 1) Implement a Three.js lightning effect class

- **[new file]** `scripts/effects/LightningEffect.js`
- **[base class]** Extend `EffectBase` from `scripts/effects/EffectComposer.js`
- **[layer]** Use `RenderLayers.ENVIRONMENTAL` (preferred) or `RenderLayers.PARTICLES`.
  - The effect should be a world-space mesh that gets rendered in the main scene pass.
- **[no PIXI]** Do not use `PIXI.Graphics`.

Implementation note:
- Prefer a **GPU-side thick-line / vertex expansion** approach ("MeshLine" technique) so we do not compute billboard quads on the CPU.
- See `docs/PLAN_TeslaCoilLightningEffect.md` for the updated rendering spec (noise-flow plasma, vertex extrusion, etc.).

### 2) Map point consumption

- **[source]** Consume lightning groups via `mapPointsManager.getGroupsByEffect('lightning')`.
- **[filter]** Only accept groups matching legacy eligibility:
  - `type === 'line'`
  - `isEffectSource === true`
  - `points.length >= 2`
  - `!isBroken`
- **[coordinate conversion]** Convert Foundry scene coords to Three world coords consistently.
  - Follow the existing convention used in `FireSparksEffect`:
    - `worldX = point.x`
    - `worldY = canvas.dimensions.height - point.y`

### 3) Live updates when map points change

- **[listener]** `LightningEffect` should expose `setMapPointsSources(mapPointsManager)`.
- **[pattern]** Mirror `SmellyFliesEffect`:
  - store a `changeListener`
  - call `_rebuildSources()` when map points change
- **[rebuild output]** The rebuild step should produce a stable in-memory list like:
  - `this.sources = [{ groupId, origin, dest, intensity, ... }, ...]`

### 4) Scheduling and time

- **[TimeManager only]** All scheduling must use `timeInfo.elapsed`/`timeInfo.delta`.
  - Do **not** use `performance.now()`.
- **[per-group timers]** Maintain per-source `nextBurstAt` and active strike list.
- **[minimum viable timing]** Replicate v1.x semantics:
  - random delay between bursts (`minDelay`, `maxDelay`)
  - each burst spawns N strikes (`burstMinStrikes`, `burstMaxStrikes`)
  - per strike lifetime (`burstStrikeDuration`)
  - delay between strikes (`burstStrikeDelay`)

Juice upgrades (planned):
- Add "plasma" feel via scrolling noise texture along the bolt UVs.
- Add `wildArcChance` so some strikes fail to ground (corona discharge).
- Add an audio hook (e.g. `onStrikeAudio(...)`) for zap/buzz.
- Add an environmental lighting contribution synced to strike intensity.

### 5) Wire the effect into canvas initialization

- **[registration]** In `scripts/foundry/canvas-replacement.js`:
  - instantiate `const lightningEffect = new LightningEffect()`
  - `await effectComposer.registerEffect(lightningEffect)`
  - after `mapPointsManager.initialize()`, call:
    - `lightningEffect.setMapPointsSources(mapPointsManager)`
- **[UI]** Register a new control section in `initializeUI(...)`:
  - `const lightningSchema = LightningEffect.getControlSchema()`
  - `uiManager.registerEffect('lightning', 'Lightning (Map Points)', lightningSchema, onLightningUpdate, 'particle')`

### 6) Parameters and UI schema

- **[schema contract]** Follow existing patterns (`LightingEffect.getControlSchema`, `BloomEffect.getControlSchema`).
- **[core params]** Start with the v1.x config surface area:
  - `enabled`
  - `minDelay`, `maxDelay`
  - `burstMinStrikes`, `burstMaxStrikes`
  - `burstStrikeDuration`, `burstStrikeDelay`
  - `flickerChance`
  - visual: `color`, `coreColor`, `brightness`, widths
  - path: segments/jaggedness controls
- **[defaults]** Provide safe defaults so the effect is visually obvious but not overwhelming.

### 7) Minimal acceptance criteria

- **[legacy data]** A scene with only `flags.map-shine.mapPointGroups` lightning lines produces visible arcs.
- **[v2 data]** A scene with `flags.map-shine-advanced.mapPointGroups` lightning lines produces the same.
- **[no crashes]** If no lightning groups exist, effect remains idle.
- **[time correctness]** Pausing/time-scaling via `TimeManager` behaves correctly.

## Open Questions

- **[polyline semantics]** If a line group has >2 points:
  - Option A: keep strict v1.x behavior (first→last only).
  - Option B: treat intermediate points as control points for the arc path.
  - Recommendation: start with Option A for compatibility, then add Option B as an enhancement.

- **[occlusion]** Should lightning be occluded by overhead tiles/walls?
  - Recommendation: not in MVP. Add later using roof alpha map or depth.

## File Touch List (Implementation Phase)

- `scripts/effects/LightningEffect.js` (new)
- `scripts/foundry/canvas-replacement.js` (register effect + UI + wiring)
- `docs/MAP-POINTS.md` (optional update: clarify polyline behavior for lightning)

