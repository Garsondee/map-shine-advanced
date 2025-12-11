# Smart Particles System - Planning Document

## Overview

This document outlines the architecture for implementing **Smart Particles** in Map Shine Advanced. This includes:

1. **Map Points System v2** - A new Three.js-native point/area/line management system
2. **Smelly Flies Effect** - The first "smart" particle system using three.quarks with AI-like behavior

The existing v1.x documents (`MAP-POINTS.md`, `SMELLY-FLIES.md`) serve as **inspiration**, not requirements. We are building a modern, Three.js-native system that leverages three.quarks' full capabilities.

---

## Part 1: Map Points System v2

### 1.1 Current State

The existing `MapPointsManager` (`scripts/scene/map-points-manager.js`) provides:
- Reading v1.x scene flags (`map-shine.mapPointGroups`)
- Migration to v2 format
- Query methods: `getGroupsByEffect()`, `getPointsForEffect()`, `getLinesForEffect()`
- Visual helpers for debugging
- Change listeners for reactive updates

**What's Missing:**
- Interactive point placement in Three.js canvas
- Real-time visual feedback during editing
- Area polygon rendering and validation
- Integration with InteractionManager for point manipulation

### 1.2 Architecture Decision: Thin Wrapper + Effect-Specific Logic

Rather than building a complex geometry mask system (like v1.x's PIXI-based `GeometryMaskManager`), we will:

1. **Keep MapPointsManager as a data layer** - Reads/writes scene flags, provides query API
2. **Effects own their spawn logic** - Each effect (flies, dust, steam) samples points directly
3. **Visual editing via InteractionManager** - Point placement/dragging uses existing Three.js interaction system

### 1.3 Enhanced MapPointsManager API

```javascript
// Existing (keep)
getGroupsByEffect(effectTarget: string): MapPointGroup[]
getPointsForEffect(effectTarget: string): MapPoint[]
getLinesForEffect(effectTarget: string): LineSegment[]
getRopeConfigurations(): RopeConfig[]

// New additions
getAreasForEffect(effectTarget: string): AreaPolygon[]
isPointInArea(groupId: string, point: {x, y}): boolean
getRandomPointInArea(groupId: string): {x, y} | null
getAreaBounds(groupId: string): {minX, minY, maxX, maxY} | null
```

### 1.4 Interactive Editing Mode

When Map Maker mode is active and the "Map Points" tool is selected:

1. **Point Placement**: Click to add points to the active group
2. **Point Dragging**: Drag existing points to reposition
3. **Point Deletion**: Right-click or Delete key to remove points
4. **Group Selection**: Click on visual helpers to select groups

Integration with `InteractionManager`:
- Add `mapPointsMode` to interaction modes
- Render point handles as Three.js sprites
- Use existing grid snapping infrastructure

### 1.5 Visual Representation

For each group type, render Three.js objects:

| Type | Visual | THREE Object |
|------|--------|--------------|
| Point | Colored sphere/circle | `THREE.Points` or `THREE.Sprite` |
| Line | Colored line segments | `THREE.Line` |
| Area | Filled polygon + outline | `THREE.Mesh` (ShapeGeometry) + `THREE.LineLoop` |
| Rope | Catenary curve preview | `THREE.Line` (CatmullRomCurve3) |

Colors follow effect type (existing `getEffectColor()` method).

---

## Part 2: Smelly Flies Effect

### 2.1 Design Philosophy

The v1.x Smelly Flies used PIXI particle-emitter with a custom behavior class. For Map Shine Advanced, we will:

1. **Use three.quarks ParticleSystem** - Consistent with Fire, Weather, etc.
2. **Implement CPU-side AI behaviors** - three.quarks behaviors for state machine logic
3. **Leverage existing patterns** - Follow FireSparksEffect's structure for masks, roof awareness, etc.

### 2.2 Behavior State Machine

Each fly particle maintains state via `particle.userData`:

```
┌─────────────┐
│  SPAWNING   │ (Initial burst from spawn point)
└──────┬──────┘
       │ after 0.3s
       ▼
┌─────────────┐     landChance      ┌─────────────┐
│   FLYING    │ ──────────────────► │   LANDING   │
│  (buzzing)  │                     │ (slowing)   │
└──────┬──────┘                     └──────┬──────┘
       ▲                                   │
       │ takeoffChance                     │ after landingDuration
       │                                   ▼
       │                            ┌─────────────┐
       └─────────────────────────── │   WALKING   │
                                    │  (ground)   │
                                    └─────────────┘
```

### 2.3 Class Structure

```javascript
// scripts/particles/SmellyFliesEffect.js

export class SmellyFliesEffect extends EffectBase {
  // Lifecycle
  async initialize(renderer, scene, camera)
  update(timeInfo)
  dispose()
  
  // Configuration
  setMapPointsSources(mapPointsManager)
  applyParamChange(paramId, value)
  
  // Internal
  _createFlySystem(areaGroup)
  _updateFlyBehaviors(delta)
}

// Custom three.quarks behavior
class FlyBehavior {
  static type = 'smellyFly';
  
  initialize(particle, system)  // Set initial state
  update(particle, delta, system)  // State machine tick
}
```

### 2.4 Spawn Strategy

Unlike Fire (which uses mask textures), Flies spawn from **geometry**:

**Point Groups:**
- Single spawn location
- Flies orbit around this point (tether center)

**Area Groups:**
- Random spawn within polygon bounds
- Validate spawn point is inside polygon (ray-casting)
- Walking state constrained to polygon

```javascript
class AreaSpawnShape {
  constructor(polygon) {
    this.polygon = polygon;  // [{x, y}, ...]
    this.bounds = this._computeBounds();
  }
  
  initialize(particle) {
    // Rejection sampling: pick random point in bounds, check if inside polygon
    let attempts = 0;
    while (attempts < 20) {
      const x = this.bounds.minX + Math.random() * (this.bounds.maxX - this.bounds.minX);
      const y = this.bounds.minY + Math.random() * (this.bounds.maxY - this.bounds.minY);
      if (this._isPointInPolygon(x, y)) {
        particle.position.set(x, y, groundZ);
        particle.userData.home = { x, y };
        return;
      }
      attempts++;
    }
    // Fallback: use centroid
    particle.position.set(this.bounds.centerX, this.bounds.centerY, groundZ);
  }
}
```

### 2.5 Flying Behavior Physics

Each frame for a flying fly:

```javascript
update(particle, delta) {
  const cfg = particle.userData;
  
  // 1. Random noise force (buzzing)
  const noiseForce = {
    x: (Math.random() - 0.5) * 2 * this.noiseStrength,
    y: (Math.random() - 0.5) * 2 * this.noiseStrength
  };
  
  // 2. Tether force (attraction to home)
  const dx = cfg.home.x - particle.position.x;
  const dy = cfg.home.y - particle.position.y;
  const tetherForce = {
    x: dx * this.tetherStrength,
    y: dy * this.tetherStrength
  };
  
  // 3. Apply forces
  cfg.velocity.x += (noiseForce.x + tetherForce.x) * delta;
  cfg.velocity.y += (noiseForce.y + tetherForce.y) * delta;
  
  // 4. Speed limit
  const speed = Math.hypot(cfg.velocity.x, cfg.velocity.y);
  if (speed > this.maxSpeed) {
    const ratio = this.maxSpeed / speed;
    cfg.velocity.x *= ratio;
    cfg.velocity.y *= ratio;
  }
  
  // 5. Drag
  cfg.velocity.x *= (1 - this.drag * delta);
  cfg.velocity.y *= (1 - this.drag * delta);
  
  // 6. Integrate position
  particle.position.x += cfg.velocity.x * delta;
  particle.position.y += cfg.velocity.y * delta;
}
```

### 2.6 Walking Behavior

When landed, flies walk within the area polygon:

```javascript
// Walking sub-states
const WALK_STATES = {
  IDLE: 'idle',       // Paused, waiting
  ROTATING: 'rotating', // Turning to face target
  MOVING: 'moving'    // Walking toward target
};

updateWalking(particle, delta) {
  const cfg = particle.userData;
  
  switch (cfg.walkState) {
    case WALK_STATES.IDLE:
      cfg.idleTimer -= delta;
      if (cfg.idleTimer <= 0) {
        // Pick new walk target inside polygon
        cfg.walkTarget = this._pickWalkTarget(particle);
        cfg.walkState = WALK_STATES.ROTATING;
      }
      break;
      
    case WALK_STATES.ROTATING:
      // Rotate toward target
      const targetAngle = Math.atan2(
        cfg.walkTarget.y - particle.position.y,
        cfg.walkTarget.x - particle.position.x
      );
      particle.rotation = this._lerpAngle(particle.rotation, targetAngle, delta * 5);
      if (Math.abs(particle.rotation - targetAngle) < 0.1) {
        cfg.walkState = WALK_STATES.MOVING;
      }
      break;
      
    case WALK_STATES.MOVING:
      // Move toward target
      const dx = cfg.walkTarget.x - particle.position.x;
      const dy = cfg.walkTarget.y - particle.position.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 5) {
        cfg.walkState = WALK_STATES.IDLE;
        cfg.idleTimer = this.minIdleTime + Math.random() * (this.maxIdleTime - this.minIdleTime);
      } else {
        const moveSpeed = this.walkSpeed * delta;
        particle.position.x += (dx / dist) * moveSpeed;
        particle.position.y += (dy / dist) * moveSpeed;
      }
      break;
  }
  
  // Random takeoff chance
  if (Math.random() < this.takeoffChance * delta) {
    this._transitionToTakingOff(particle);
  }
}
```

### 2.7 Visual Properties

| State | Scale | Motion Blur | Z Offset |
|-------|-------|-------------|----------|
| Flying | 0.19 | Enabled (stretch) | +50-150 |
| Landing | 0.19→0.17 | Fading | +50→0 |
| Walking | 0.17 | Disabled | 0 |
| Taking Off | 0.17→0.19 | Ramping | 0→+50 |

**Rotation:** Flies face their movement direction (computed from velocity or walk target).

**Motion Blur:** Implemented via scale.x stretching based on velocity magnitude.

### 2.8 Configuration Parameters

```javascript
const DEFAULT_FLY_CONFIG = {
  enabled: true,
  maxParticles: 15,
  particleTexture: 'modules/map-shine-advanced/assets/fly.webp',
  
  flying: {
    takeoffDuration: 0.5,
    noiseStrength: 2000,
    tetherStrength: 15.0,
    maxSpeed: 1000,
    drag: 0.8,
    landChance: 0.05,
    landingDuration: 1.0
  },
  
  walking: {
    walkSpeed: 60,
    minIdleTime: 0.5,
    maxIdleTime: 2.5,
    minMoveDistance: 20,
    maxMoveDistance: 100,
    takeoffChance: 0.05
  },
  
  motionBlur: {
    enabled: true,
    strength: 0.03,
    maxLength: 4
  }
};
```

### 2.9 Performance Optimizations

Following patterns from existing effects:

1. **Frame Skipping**: Update each fly every 2nd frame (`updateCounter % 2`)
2. **Staggered Polygon Checks**: Only check `isPointInPolygon` every 10th update
3. **Object Pooling**: Reuse Vector3/Vector2 objects in hot paths
4. **Long Particle Lifetime**: 60-120 seconds (minimize spawn/destroy overhead)
5. **Aggregated Systems**: One ParticleSystem per area group, not per fly

### 2.10 Integration Points

| System | Integration |
|--------|-------------|
| MapPointsManager | Query `smellyFlies` groups on init and change |
| WeatherController | Optional: reduce fly activity in rain/wind |
| TileManager | Optional: flies avoid overhead tiles |
| EffectComposer | Register as PARTICLES layer effect |
| TweakpaneManager | UI controls for all parameters |

---

## Part 3: Implementation Phases

### Phase 1: MapPointsManager Enhancements
- [ ] Add `getAreasForEffect()` method
- [ ] Add `isPointInArea()` with ray-casting
- [ ] Add `getRandomPointInArea()` with rejection sampling
- [ ] Add `getAreaBounds()` helper
- [ ] Test with existing fire map points

### Phase 2: SmellyFliesEffect Core
- [ ] Create `scripts/particles/SmellyFliesEffect.js`
- [ ] Implement `AreaSpawnShape` class
- [ ] Implement `FlyBehavior` class with state machine
- [ ] Basic flying behavior (noise + tether + drag)
- [ ] Register with EffectComposer

### Phase 3: Walking & Landing
- [ ] Implement landing transition
- [ ] Implement walking sub-state machine
- [ ] Implement takeoff transition
- [ ] Polygon constraint for walking

### Phase 4: Visual Polish
- [ ] Motion blur via scale stretching
- [ ] Rotation facing movement direction
- [ ] Scale transitions between states
- [ ] Z-offset for flying vs walking

### Phase 5: UI & Integration
- [ ] Tweakpane controls
- [ ] MapPointsManager change listener
- [ ] Weather integration (optional)
- [ ] Performance profiling

---

## Part 4: File Structure

```
scripts/
├── particles/
│   ├── SmellyFliesEffect.js    # Main effect class
│   ├── behaviors/
│   │   └── FlyBehavior.js      # three.quarks behavior
│   └── shapes/
│       └── AreaSpawnShape.js   # Polygon spawn shape
├── scene/
│   └── map-points-manager.js   # Enhanced with area methods
```

---

## Part 5: Open Questions

1. **Indoor/Outdoor Awareness**: Should flies be affected by roof masks like fire?
   - *Suggestion*: Optional, default off. Flies are typically placed intentionally.

2. **Multiple Swarms**: One system per area group, or aggregate all?
   - *Suggestion*: One system per group for independent home points.

3. **Fly Texture**: Use existing `fly.webp` or create new?
   - *Suggestion*: Use existing, add as module asset.

4. **Sound Integration**: Buzzing sound effect?
   - *Suggestion*: Out of scope for initial implementation.

---

## Part 6: three.js + three.quarks Superpowers (vs PIXI)

This section captures ideas that were difficult or impractical with the old PIXI-based emitter stack but are natural fits for the new three.js + three.quarks pipeline. These are **options**, not requirements, but we should design Smelly Flies (and future smart particles) so they can take advantage of them over time.

### 6.1 True 3D Space & Altitude

- **Z-aware swarms**: Flies can have real altitude over the ground plane (e.g. hover at `groundZ + 50..200`) instead of being purely 2D sprites.
- **Layer-aware behavior**: Different behaviors by height band (near ground = walking/landing, mid-air = buzzing, high = "dispersed" state).
- **3D avoidance**: Future systems could steer around 3D props or volumes (e.g. avoid tall pillars or roofs) using real 3D distances.

Smelly Flies v1 was effectively 2D-on-surface; in v2 we can cleanly separate ground vs air motion using Z without fighting a 2D renderer.

### 6.2 Depth, Shadows, and Lighting Integration

- **Depth-tested interactions**: three.js depth buffer lets particles go behind tokens/geometry in a physically consistent way.
- **Lighting-aware particles**: We can sample the lighting buffers (or approximate them) to darken flies in shadows and brighten them near lights.
- **Roof-aware compositing**: We already use `_Outdoors` and roof alpha maps for fire/weather; flies can optionally:
  - Dim when under solid roofs.
  - Stay fully visible in roof cutouts/transparent patches.

In PIXI, mixing particles with lighting/fog was fragile; here we can design particles as first-class 3D scene citizens.

### 6.3 Massive Counts via BatchedRenderer

- **Sprite batching**: three.quarks consolidates many flies into a few draw calls.
- **Cheaper overdraw management**: We can tune texture, blending, and renderOrder per effect to manage overdraw in 3D.
- **Future: LOD per swarm**: Since each swarm is its own ParticleSystem, we can:
  - Drop particle counts or update frequency by distance from camera.
  - Fade out distant swarms entirely.

The PIXI emitter setup discouraged many small, independent swarms; BatchedRenderer makes that much more feasible.

### 6.4 Custom Behaviors & Shared Infrastructure

- **Reusable behavior classes**: three.quarks behaviors like `SmartWindBehavior` already integrate with WeatherController and roof masks; Smelly Flies can:
  - Inherit common helpers for wind, world bounds, and masking.
  - Share object-pooling and delta-clamping strategies from other effects.
- **Per-system tuning via `system.userData`**: Each swarm can expose knobs (e.g. windInfluence, chaos, density) without needing separate emitters or layers.

This was possible but cumbersome in PIXI where behaviors and config JSON were tightly coupled to a specific emitter implementation.

### 6.5 Screen-Space Tricks without Fighting PIXI

- **Better motion blur**: Stretching flies along velocity in 3D, with optional camera-dependent scaling.
- **Camera-aware LOD**: Because Smelly Flies live in the same camera space as the rest of the scene, we can:
  - Reduce spawn rate when zoomed far out.
  - Increase subtlety (smaller scale, less blur) when zoomed in.
- **Post-processing friendliness**: Particles participate naturally in Bloom/Color Grading/ASCII/etc. as part of the Three render pipeline.

### 6.6 Concrete Ideas to Consider for Smelly Flies v2

- **Altitude variance per swarm**: Some swarms hover low to the ground, others buzz higher (e.g. around hanging meat).
- **Light-seeking or light-avoiding behavior**: Flies might prefer darker corners or be attracted to bright sources.
- **Weather-aware behavior**: Tie into WeatherController to reduce activity in heavy rain or strong wind (shelter behavior).
- **Dynamic density by camera distance**: More flies when camera is close, fewer when far, using maxParticles scaling.
- **Optional roof occlusion**: Use the same roof mask pipeline as Fire/Weather to hide or dim flies indoors when roofs are visible.

These should be treated as a **feature backlog**: we will start with a faithful v1-style swarm and gradually fold in 3D, lighting, and weather awareness as needed.

---

## Summary

This plan adapts the v1.x Smelly Flies concept to Map Shine Advanced's three.quarks architecture while:

- Keeping the proven state machine design (flying/landing/walking/takeoff)
- Using modern three.quarks behaviors instead of PIXI custom behaviors
- Leveraging existing MapPointsManager for data storage
- Following established patterns from FireSparksEffect and WeatherParticles
- Prioritizing performance with frame skipping and object pooling

The result will be a robust, performant "smart particle" system that serves as a template for future AI-driven effects (dust motes, fireflies, birds, etc.).
