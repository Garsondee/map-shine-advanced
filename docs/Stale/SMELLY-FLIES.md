# Smelly Flies Particle System – Detailed Technical Analysis

## 1. Concept & Visual Goal

The **Smelly Flies** system simulates a swarm of small flies that:

- Orbit and buzz around a “home” region (usually over a corpse / trash pile / etc.).
- Occasionally land, slow down, and shrink slightly.
- Walk around within a defined area on the ground.
- Randomly take off again into the buzzing cloud.

The effect is implemented as a **custom particle behavior** on top of `@pixi/particle-emitter`, driven by Map Shine configuration and Map Points geometry.


## 2. High-Level Architecture

The implementation is split into three primary pieces:

1. **Particle definition**  
   `PARTICLE_EFFECT_DEFINITIONS.smellyFlies` in `scripts/effects/ParticleSystem.js`:
   - Declares title/description for UI.
   - Associates a `configPath` (`"smellyFlies"`).
   - Declares `buildEmitterConfig: buildSmellyFliesEmitterConfig`.

2. **Custom behavior class**  
   `SmellyFliesBehavior` in `ParticleSystem.js`:
   - Registered via its static `type = "smellyFlies"`.
   - Implements all high-level motion logic: takeoff, flying, landing, walking.
   - Uses polygon/GeometryMaskShape sampling to stay inside the user-defined area.

3. **Canvas layer wrapper**  
   `SmellyFliesLayer` in `ParticleSystem.js`:
   - Extends `AnimatedCanvasLayer`.
   - Owns a `ParticleEffectController` instance for this effect only.
   - Connects to Map Shine’s `effectTargetManager` and masking pipeline.
   - Runs the update loop each frame.

Data flow:

1. Map Points group → `EffectTargetManager` → `targetData` + `group`
2. `buildSmellyFliesEmitterConfig(effectConfig, targetData, group)`  
   → Returns emitter JSON (behaviors, lifetime, frequency, maxParticles)
3. `ParticleEffectController` creates PIXI emitter(s)
4. `SmellyFliesBehavior` updates every fly according to its state machine
5. `SmellyFliesLayer._onAnimate` invokes controller `update(deltaTime)` each frame


## 3. Data Sources & Geometry

### 3.1 Map Points Group

- The system requires a **Point or Area group** from Map Points.
- The `group` is passed into the emitter config builder and then into the behavior.

Usage:

- **Point group**:  
  - The **first point** in the group defines the “home” point if no GeometryMaskShape is available.
- **Area group**:  
  - The **polygon points** define the walkable area on the ground.
  - GeometryMaskShape is used to pick “home” positions and to constrain walking / landing.

### 3.2 GeometryMaskShape Integration

In `SmellyFliesBehavior` constructor:

- Attempts to access `globalThis.GeometryMaskShape` (registered elsewhere).
- If available:

  ```js
  this.shape = new GMS({ group: this.group });
  ```

  Provides:
  - `getRandPos(tempParticle)` – pick random positions within polygon.
  - `_isPointInPolygon(point)` – used to keep flies inside area.

- If **not** available:
  - Logs a warning once:  
    `"SmellyFliesBehavior: GeometryMaskShape not available yet; proceeding without precompiled shape."`
  - Falls back to raw `group.points` and local `_isPointInPolygon` implementation.

### 3.3 Local Polygon Test

`_isPointInPolygon` implements a standard **ray-casting** algorithm over `group.points` to determine if a position is inside the area. It is used to:

- Validate walk targets.
- Decide whether a flying fly is allowed to transition to “landing” at its current position.


## 4. Emitter Configuration (`buildSmellyFliesEmitterConfig`)

Function signature:

```js
const buildSmellyFliesEmitterConfig = (effectConfig, targetData, group) => { ... }
```

### 4.1 Preconditions

- Reads global density multiplier:

  ```js
  const globalParticleConfig =
    game.mapShine.profileManager.activeConfig.particleSystems;
  const globalMultiplier = globalParticleConfig.globalDensityMultiplier ?? 1.0;
  ```

- Extracts `rect` from `targetData`.
- If any of these are missing:
  - `rect` missing
  - `group` missing
  - `group.points.length === 0`

  → Returns:

  ```js
  { maxParticles: 0, behaviors: [] };
  ```

  Ensures no emitter is created in invalid scenarios.

### 4.2 Spawn Shape

Defines a single spawn behavior:

```js
const spawnBehavior = {
  type: "spawnShape",
  config: {
    type: "geometryMask",
    data: {
      group,
    },
  },
};
```

- This uses the custom `GeometryMaskShape` spawn shape registered into `PIXI.particles.behaviors.ShapeSpawnBehavior` elsewhere.
- Spawn positions are **restricted to the Map Points group polygon** (for area groups), or derived from group points for simple groups.

### 4.3 Behavior Stack

The base behavior list:

```js
const behaviors = [
  {
    type: "textureSingle",
    config: {
      texture: config.particleTexture,
    },
  },
  {
    type: "scaleStatic",
    config: {
      min: 1.0,
      max: 1.0,
    },
  },
  {
    // No fade-out over lifetime – flies are persistent
    type: "alphaStatic",
    config: {
      alpha: 1.0,
    },
  },
  spawnBehavior,
  {
    type: "smellyFlies",
    config: { ...config, group },
  },
];
```

Key points:

- **`textureSingle`**:  
  - Uses user-configured `particleTexture` (e.g. small fly sprite).
- **`scaleStatic`**:  
  - Base scale of `1.0` – actual perceived size is controlled by `SmellyFliesBehavior` via `cfg.currentBaseScale` and `cfg.scaleMultiplier`.
- **`alphaStatic`**:  
  - Keeps flies visually present; lifecycle is long-lived and controlled via `lifetime` rather than fade-out curves.
- **`smellyFlies`**:  
  - Attaches the custom behavior state machine to each particle.

Blend mode behavior is appended via:

```js
const blendMode = config.blendMode ?? PIXI.BLEND_MODES.NORMAL;
addBlendModeBehavior(behaviors, blendMode);
```

### 4.4 Emitter-Level Settings

Returned emitter configuration:

```js
return {
  lifetime: { min: 60, max: 120 },    // Flies live 1–2 minutes
  frequency: 1.0 / ((config.maxParticles || 100) * 0.1),
  emitterLifetime: -1,                // Infinite emitter
  maxParticles: Math.floor(config.maxParticles * globalMultiplier),
  blendMode,
  pos: { x: 0, y: 0 },
  addAtBack: false,
  behaviors,
};
```

- **Lifetime**:  
  - Very long; effect is effectively continuous.
- **Frequency**:
  - Inversely proportional to `maxParticles`.
  - Larger swarms fill faster; smaller swarms spawn more slowly.
- **Global multiplier**:
  - Honors global `particleSystems.globalDensityMultiplier` for performance scaling.


## 5. Custom Behavior: `SmellyFliesBehavior`

### 5.1 Role & Ordering

- Declared as:

  ```js
  class SmellyFliesBehavior {
    static type = "smellyFlies";
  }
  ```

- `this.order = PIXI.particles.behaviors.BehaviorOrder.Late;`  
  Ensures it runs *after* spawn and basic behaviors so it can override position/scale as needed.

### 5.2 Global Behavior Configuration

`this.config` is the user config passed from `effectConfig`:

- `this.config.flying`:
  - `takeoffDuration`
  - `takeoffSpeedMin`, `takeoffSpeedMax`
  - `noiseStrength`
  - `tetherStrength`
  - `maxSpeed`
  - `drag`
  - `landChance`
  - `landingDuration`
- `this.config.walking`:
  - `minIdleTime`, `maxIdleTime`
  - `minMoveDistance`, `maxMoveDistance`
  - `walkSpeed`
  - `takeoffChance`
- `this.config.motionBlur`:
  - `enabled`
  - `strength`
  - `maxLength`

Internal scale anchors:

```js
this.WALKING_SCALE = 0.17;
this.FLYING_SCALE = 0.19;
```

These are multiplied per-fly by `cfg.scaleMultiplier`.

### 5.3 Emitter-Level State

`initEmitter(emitter)`:

- Sets `emitter._smellyFliesElapsedTime = 0;`.

`update(emitter, deltaSec)`:

- Ensures `_smellyFliesElapsedTime` exists.
- Increments timer by `deltaSec`.

This provides a **shared time base** for all flies in an emitter, though the final implementation mostly uses random forces rather than the simplex noise that was originally prepared.

### 5.4 Per-Fly Initialization (`initParticles`)

For each new particle:

```js
fly.config = {};
const cfg = fly.config;
cfg.id = Math.random() * 10000;
cfg.scaleMultiplier = 0.8 + Math.random() * 0.4;  // 0.8 – 1.2
cfg.updateCounter = Math.floor(Math.random() * 10);
```

Home location:

- With `this.shape` (GeometryMaskShape):

  ```js
  const tempParticle = { position: new PIXI.Point() };
  this.shape.getRandPos(tempParticle);
  cfg.home = tempParticle.position;
  ```

- Without shape:

  ```js
  cfg.home = this.group.points[0];
  ```

Velocity & initial state:

- `cfg.velocity = { x: 0, y: 0 };`
- `_prepareForTakeOff(fly, cfg);` (starts in “taking_off” state)
- `fly.oldPosition = new PIXI.Point(fly.position.x, fly.position.y);`

Result: new flies immediately perform a takeoff sequence into flying state.


## 6. Per-Frame Fly Update (`updateParticle`)

Main logic:

```js
updateParticle(particle, deltaSec) {
  const fly = particle;
  const cfg = fly.config;
  if (!cfg) return;

  // Frame-skip: run only every second frame
  if (!fly.updateFrame) fly.updateFrame = 0;
  fly.updateFrame = (fly.updateFrame + 1) % 2;
  if (fly.updateFrame !== 0) return;

  const elapsedTime = fly.emitter._smellyFliesElapsedTime ?? 0;

  const oldPosition = fly.oldPosition;
  oldPosition.copyFrom(fly.position);

  switch (cfg.state) {
    case "taking_off": this._updateTakingOff(fly, deltaSec);    break;
    case "flying":     this._updateFlying(fly, deltaSec, elapsedTime); break;
    case "landing":    this._updateLanding(fly, deltaSec);      break;
    case "walking":    this._updateWalking(fly, deltaSec);      break;
  }

  const dx = fly.position.x - oldPosition.x;
  const dy = fly.position.y - oldPosition.y;
  if (Math.hypot(dx, dy) > 0.1) {
    fly.rotation = Math.atan2(dy, dx);
  }

  // Motion blur & scale
  ...
}
```

### 6.1 State Machine Overview

Top-level states (`cfg.state`):

- `"taking_off"` – short acceleration burst from rest to flying velocity.
- `"flying"` – buzzing motion with noise + tether force + drag.
- `"landing"` – deceleration and scale blend into walking.
- `"walking"` – ground-level motion with sub-states:
  - `cfg.walkingState = "idle" | "rotating" | "moving"`.

State transitions:

- `taking_off` → `flying` after `takeoffDuration`.
- `flying` → `landing` if:
  - `this.group.type === "area"`,
  - random land chance passes,
  - current position is inside polygon.
- `landing` → `walking` after `landingDuration`.
- `walking.idle/rotating/moving`:
  - `walking` → `taking_off` if random takeoff chance passes.
  - `idle` → `rotating` → `moving` → `idle` loops within walking.

### 6.2 Takeoff (`_updateTakingOff`)

- Uses `this.config.flying.takeoffDuration` (default ~0.5s).
- `cfg.stateTimer` counts down.
- Target velocity selected randomly:

  ```js
  const takeoffSpeed =
    flyConfig.takeoffSpeedMin +
    Math.random() * (flyConfig.takeoffSpeedMax - flyConfig.takeoffSpeedMin);
  const angle = Math.random() * Math.PI * 2;
  cfg.targetVelocity = { x: Math.cos(angle)*takeoffSpeed, y: Math.sin(angle)*takeoffSpeed };
  cfg.velocity = { x: 0, y: 0 };
  ```

- Over the duration:
  - Cubic ease-out interpolation from 0 → `targetVelocity`.
  - Position integrates velocity.
  - `cfg.currentBaseScale` interpolates from `WALKING_SCALE` → `FLYING_SCALE`.

At completion:

- Snap to full flying state:
  - `cfg.velocity = cfg.targetVelocity;`
  - `cfg.currentBaseScale = FLYING_SCALE;`
  - `cfg.state = "flying"`.

### 6.3 Flying (`_updateFlying`)

Core forces:

1. **Random noise force (erratic buzzing)**

   Uses simple random per-frame, scaled by `noiseStrength`:

   ```js
   const noiseStrength = flyConfig.noiseStrength ?? 400;
   const randomForce = {
     x: (Math.random() - 0.5) * 2 * noiseStrength,
     y: (Math.random() - 0.5) * 2 * noiseStrength,
   };
   cfg.velocity.x += randomForce.x * deltaSec;
   cfg.velocity.y += randomForce.y * deltaSec;
   ```

2. **Tether force (attraction to home)**

   Pulls the fly back to its `cfg.home` anchor:

   ```js
   const tetherStrength = flyConfig.tetherStrength ?? 0.8;
   const dx = homePoint.x - fly.position.x;
   const dy = homePoint.y - fly.position.y;
   cfg.velocity.x += dx * tetherStrength * deltaSec;
   cfg.velocity.y += dy * tetherStrength * deltaSec;
   ```

3. **Speed limiting**

   Caps velocity to `maxSpeed`:

   ```js
   const maxSpeed = flyConfig.maxSpeed ?? 150;
   const speed = Math.hypot(cfg.velocity.x, cfg.velocity.y);
   if (speed > maxSpeed) {
     const ratio = maxSpeed / speed;
     cfg.velocity.x *= ratio;
     cfg.velocity.y *= ratio;
   }
   ```

4. **Drag**

   Applies friction to avoid infinite acceleration:

   ```js
   const drag = flyConfig.drag ?? 0.5;
   cfg.velocity.x *= 1 - drag * deltaSec;
   cfg.velocity.y *= 1 - drag * deltaSec;
   ```

Position + scale:

- `fly.position += cfg.velocity * deltaSec;`
- `cfg.currentBaseScale = FLYING_SCALE`.

Landing decision:

- Uses `cfg.updateCounter` to only run costly polygon checks every 10th update:

  ```js
  cfg.updateCounter++;
  if (cfg.updateCounter >= 10) {
    cfg.updateCounter = 0;
    if (this.group.type === "area" && this.group.points.length > 2) {
      if (
        Math.random() < flyConfig.landChance * deltaSec &&
        this._isPointInPolygon(fly.position)
      ) {
        cfg.state = "landing";
        cfg.stateTimer = flyConfig.landingDuration ?? 1.0;
      }
    }
  }
  ```

### 6.4 Landing (`_updateLanding`)

- Uses `landingDuration` (default ~1s).
- `cfg.stateTimer` counts down.
- Ease-out-quint (`ease = 1 - (1 - progress)^5`) drives a **strong slowdown**.
- Drag is increased over time:

  ```js
  const landingDrag = this._lerp(0.5, 0.95, ease);
  cfg.velocity.x *= 1 - landingDrag * deltaSec * 60;
  cfg.velocity.y *= 1 - landingDrag * deltaSec * 60;
  ```

- Position still integrates velocity.
- Scale interpolates from FLYING → WALKING scale.

At completion:

- Velocity reset to 0.
- State transitions to walking:

  ```js
  cfg.state = "walking";
  cfg.walkingState = "idle";
  cfg.stateTimer =
    this.config.walking.minIdleTime +
    Math.random() *
      (this.config.walking.maxIdleTime - this.config.walking.minIdleTime);
  ```

### 6.5 Walking (`_updateWalking`)

- `cfg.currentBaseScale = WALKING_SCALE`.
- At any time, a small chance per second to take off:

  ```js
  if (Math.random() < walkConfig.takeoffChance * deltaSec) {
    this._prepareForTakeOff(fly, cfg);
    return;
  }
  ```

Sub-states:

1. **`walkingState === "idle"`**

   - `cfg.stateTimer` counts down.
   - When it reaches 0:
     - Choose a random direction and distance (`minMoveDistance`→`maxMoveDistance`).
     - Try up to `MAX_ATTEMPTS` (=10) to find a target within polygon.
     - If successful:
       - Set `walkTarget`.
       - Set `targetRotation` and `startRotation`.
       - Assign rotation duration from `minRotateTime`→`maxRotateTime`.
       - Set `walkingState = "rotating"`.
     - If repeated failures, remain idle and reset idle timer.

2. **`walkingState === "rotating"`**

   - Interpolates from `startRotation` to `targetRotation` with wrap-around handling.
   - When timer expires:
     - Snap to `targetRotation`.
     - Setup `moveDuration = distance / walkConfig.walkSpeed`.
     - `startPosition = current position`.
     - `walkingState = "moving"`.

3. **`walkingState === "moving"`**

   - Interpolates position from `startPosition` → `walkTarget` over `moveDuration`.
   - If timer or duration invalid:
     - Snap to `walkTarget` (if defined).
     - Return to `idle` with a new idle timer.

Result: flies **wander** within the area with short pauses and heading changes, while being able to randomly take off back into the flying cycle.


## 7. Scale, Rotation, and Motion Blur

### 7.1 Rotation

- `updateParticle` computes `dx, dy` as the frame-to-frame motion.
- If movement magnitude > `0.1`, sets:

  ```js
  fly.rotation = Math.atan2(dy, dx);
  ```

- Ensures flies generally **face the direction of motion**, except when almost still.

### 7.2 Base Scale

- Each state sets `cfg.currentBaseScale`:
  - Taking off: interpolates between `WALKING_SCALE` and `FLYING_SCALE`.
  - Flying: `FLYING_SCALE`.
  - Landing: interpolates back down.
  - Walking: `WALKING_SCALE`.

- Each fly has a **per-fly scalar** `cfg.scaleMultiplier` (0.8–1.2) to avoid uniform sizes.

Effective base scale = `cfg.currentBaseScale * cfg.scaleMultiplier`.

### 7.3 Motion Blur

- Default config:

  ```js
  const mbConfig = this.config.motionBlur || {
    enabled: true,
    strength: 0.5,
    maxLength: 4,
  };
  ```

- Applied only when `cfg.state !== "walking"` (fast-moving states).

- Computes per-frame speed and elongation:

  ```js
  const frameSpeed = Math.hypot(dx, dy);
  let elongation = frameSpeed * mbConfig.strength;
  elongation = Math.min(elongation, mbConfig.maxLength);
  ```

- Final scales:

  ```js
  fly.scale.y = baseScale;
  fly.scale.x = baseScale + elongation;
  ```

Result: in the air, flies are slightly streaked in their direction of motion; on the ground, they are compact.


## 8. Smelly Flies Canvas Layer (`SmellyFliesLayer`)

### 8.1 Lifecycle

- Extends `AnimatedCanvasLayer` (handles ticker binding/unbinding).

#### `_draw()`

- Calls `await super._draw()`.
- Looks up `PARTICLE_EFFECT_DEFINITIONS.smellyFlies`.
- Creates `new ParticleEffectController("smellyFlies", definition, this)`.
  - Unlike other particle effects, SmellyFlies uses its **own layer** as the parent container, not the shared `ParticleManager.masterContainer`.
- Registers `Hooks.on("mapShine:masksRendered", this._onMasksRenderedBound)`
  - Ensures effect targets are updated **after** `GeometryMaskManager` has finished its work.
- Calls `this.startAnimation()` to begin ticker-driven `_onAnimate` calls.

#### `_tearDown()`

- Removes the hook.
- Destroys the controller and clears reference.
- Calls `await super._tearDown(options)`.

### 8.2 Animation Loop (`_onAnimate`)

- Early out if destroyed or controller missing.
- Waits for `game.mapShine.systemsReady` before initializing.
- Clamps delta to `MAX_DELTA_TIME` (prevents physics explosions on big frame hitches).
- Applies `game.mapShine.timeControl.timeFactor` to `deltaInSeconds`.
- If controller has `pendingTargets`, calls `processAllPendingTargets()` to ensure new/changed Map Points groups are integrated quickly.
- Finally calls `this.controller.update(deltaInSeconds)`.

### 8.3 Target Updates

#### `_onMasksRendered(data)`

- Triggered when geometry masks are done.
- Calls `effectTargetManager.refresh()`.
- Then forwards updated targets plus `changedGroupId` into `updateEffectTargets`.

#### `updateEffectTargets(targets, options)`

- Proxies to `controller.updateTargets`, passing active profile config.

#### `updateFromConfig(config, options)`

- Updates controller from config.
- If not a time-only or lighting-only update, re-applies targets to rebuild emitters as needed.


## 9. Performance Considerations

Several performance techniques are built into Smelly Flies:

- **Frame skipping**: `updateParticle` runs only every 2nd frame per fly (`% 2`), halving update cost.
- **Staggered polygon checks**: each fly has `cfg.updateCounter`; expensive `_isPointInPolygon` is only run every 10th update per fly.
- **Long particle lifetimes**: flies live for 60–120 seconds, so emitter does not constantly create/destroy particles.
- **Global density multiplier**: `maxParticles` is scaled by `particleSystems.globalDensityMultiplier` for global performance tuning.
- **Drag and speed limits**: stable motion with capped maximum speeds to avoid extreme steps and overdraw.


## 10. Tuning & Configuration Summary

User-facing config (under `smellyFlies.*`) typically includes:

- **General**
  - `smellyFlies.enabled` – master toggle.
  - `smellyFlies.maxParticles` – base swarm size (pre-multiplier).
  - `smellyFlies.blendMode` – rendering mode.
  - `smellyFlies.particleTexture` – fly sprite.

- **Flying**
  - `smellyFlies.flying.takeoffDuration`
  - `smellyFlies.flying.takeoffSpeedMin` / `takeoffSpeedMax`
  - `smellyFlies.flying.noiseStrength`
  - `smellyFlies.flying.tetherStrength`
  - `smellyFlies.flying.maxSpeed`
  - `smellyFlies.flying.drag`
  - `smellyFlies.flying.landChance`
  - `smellyFlies.flying.landingDuration`

- **Walking**
  - `smellyFlies.walking.minIdleTime` / `maxIdleTime`
  - `smellyFlies.walking.minMoveDistance` / `maxMoveDistance`
  - `smellyFlies.walking.walkSpeed`
  - `smellyFlies.walking.takeoffChance`
  - (Optionally) `minRotateTime` / `maxRotateTime` if exposed.

- **Motion Blur**
  - `smellyFlies.motionBlur.enabled`
  - `smellyFlies.motionBlur.strength`
  - `smellyFlies.motionBlur.maxLength`

These map directly to the internals described above.


## 11. Summary

The **Smelly Flies** system is a specialized particle-based AI swarm:

- Emitters are spawned via a `geometryMask` shape tied to Map Points areas.
- A long-lived particle lifetime and custom `SmellyFliesBehavior` state machine simulate:
  - random buzzing around a home region,
  - landing and walking within a polygon,
  - repeated takeoffs and landings.
- The layer and controller integrate tightly with Map Shine’s effect discovery, geometry masks, and time control.
- Performance is managed with frame skipping, staggered polygon checks, global density scaling, and long-lived particles.

This document serves as a technical reference for debugging, extending, or reimplementing the Smelly Flies effect.
