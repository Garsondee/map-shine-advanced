# Right-Click Token HUD Issues

## Problem Summary

Two critical issues affect the right-click token HUD functionality:

1. **HUD Misalignment After Camera Movement**: The HUD is perfectly aligned when Foundry VTT first loads, but becomes misaligned as soon as the camera is moved (panned or zoomed).

2. **Rendering Freeze on Right-Click**: A noticeable freeze (pause) in the rendering system occurs when right-clicking on a token.

---

## Problem 1: HUD Misalignment After Camera Movement

### Observed Behavior

**Initial State (Correct):**
- When Foundry VTT first loads, right-clicking on a token displays the HUD perfectly aligned with the token's position.
- The HUD appears at the correct screen position and scale.

**After Camera Movement (Broken):**
- As soon as the camera is panned or zoomed, the HUD becomes misaligned.
- The HUD appears at an incorrect screen position and/or scale.
- The misalignment persists for all subsequent right-clicks until the page is refreshed.

### Root Cause Analysis

#### Foundry's HUD Architecture

Foundry VTT uses a two-layer positioning system for HUDs:

1. **`#hud` Container** (Outer Layer):
   - A `<div id="hud">` element that covers the entire canvas
   - Positioned using CSS `transform` to match the PIXI stage's global position and scale
   - Transform is set by `HeadsUpDisplayContainer` based on:
     - `canvas.primary.getGlobalPosition()` - PIXI stage screen position
     - `canvas.stage.scale.x` - PIXI stage zoom scale

2. **Individual HUD Elements** (Inner Layer):
   - Each HUD (TokenHUD, TileHUD, etc.) is a child element inside `#hud`
   - Positioned using `left`, `top`, `width`, `height` CSS properties
   - Position is calculated by `BasePlaceableHUD._updatePosition()`:
     ```javascript
     _updatePosition(position) {
       const s = canvas.dimensions.uiScale;
       const {x: left, y: top} = this.#object.position;  // PIXI token position (world coords)
       const {width, height} = this.#object.bounds;
       Object.assign(position, {left, top, width: width/s, height: height/s});
       position.scale = s;
       return position;
     }
     ```

#### Why It Works Initially

When Foundry first loads:

1. **PIXI Stage Setup**: `canvas.stage` is positioned and scaled correctly
2. **`#hud` Container Transform**: Set once during initialization to match PIXI stage
3. **Token Position**: PIXI token placeables have correct world positions
4. **HUD Positioning**: `_updatePosition()` reads token world position, `#hud` container transform converts it to screen space

**Result**: HUD appears correctly aligned.

#### Why It Breaks After Camera Movement

When the camera moves (pan/zoom):

1. **PIXI Stage Updates**: `canvas.stage.pivot` and `canvas.stage.scale` change
2. **Three.js Camera Syncs**: `CameraFollower._syncFromPixi()` updates Three.js camera to match PIXI
3. **`#hud` Container Transform**: **DOES NOT UPDATE** ❌
4. **Token Position**: PIXI token world position unchanged (still in world coords)
5. **HUD Positioning**: `_updatePosition()` still reads same token world position, but `#hud` container has stale transform

**Result**: The `#hud` container's CSS transform no longer matches the PIXI stage's screen position/scale, causing misalignment.

#### The Core Issue

**Foundry's native PIXI-based rendering** automatically keeps the `#hud` container transform synchronized with `canvas.stage` changes because PIXI's rendering loop triggers updates.

**Map Shine's Three.js rendering** replaces PIXI's rendering loop. The `CameraFollower` syncs the Three.js camera with PIXI's stage state, but **nothing updates the `#hud` container's CSS transform** when the camera moves.

### Current Implementation Attempts

#### Attempt 1: Update HUD Container in InteractionManager.update()
```javascript
// In InteractionManager.update() - called every frame
if (canvas.tokens?.hud?.rendered && canvas.tokens.hud.object) {
  this.updateHUDPosition();
  
  // Force #hud container transform update
  const hudContainer = document.getElementById('hud');
  if (hudContainer && canvas?.primary) {
    const pos = canvas.primary.getGlobalPosition();
    const scale = canvas.stage?.scale?.x || 1;
    hudContainer.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(${scale})`;
  }
}
```

**Status**: ❌ Failed - HUD still misaligned after camera movement

**Why It Failed**: Unknown - the code should work in theory. Possible issues:
- `canvas.primary.getGlobalPosition()` might not reflect the actual PIXI stage position
- The `#hud` container transform might be overwritten by Foundry elsewhere
- The update might be happening at the wrong time in the render cycle
- There might be a race condition with Foundry's own HUD positioning

#### Attempt 2: Camera Change Notification System
```javascript
// CameraFollower notifies InteractionManager when camera changes
_syncFromPixi() {
  // ... camera sync ...
  this._notifyCameraChanged();
}

// InteractionManager updates HUD on notification
onCameraChanged() {
  if (!canvas.tokens?.hud?.rendered) return;
  
  const hudContainer = document.getElementById('hud');
  if (hudContainer && canvas?.primary) {
    const pos = canvas.primary.getGlobalPosition();
    const scale = canvas.stage?.scale?.x || 1;
    hudContainer.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(${scale})`;
  }
  
  this.updateHUDPosition();
}
```

**Status**: ❌ Failed - HUD still misaligned after camera movement

**Why It Failed**: Same as Attempt 1 - the notification system works, but the transform update doesn't fix the alignment.

### Hypotheses for Why Fixes Aren't Working

1. **Foundry Overwrites Transform**: Foundry's `HeadsUpDisplayContainer` might be resetting the `#hud` container transform after we update it.

2. **Wrong Transform Values**: `canvas.primary.getGlobalPosition()` and `canvas.stage.scale` might not be the correct values to use.

3. **Timing Issue**: The transform update might need to happen at a specific point in Foundry's render cycle.

4. **PIXI Stage Desync**: The PIXI stage position/scale might not be updating correctly when Three.js camera moves.

5. **Multiple HUD Containers**: There might be multiple `#hud` elements or nested containers we're not aware of.

6. **CSS Specificity**: Our inline `style.transform` might be overridden by CSS rules with higher specificity.

### Foundry Source Code Investigation

#### HeadsUpDisplayContainer.align() Method

**Location**: `foundryvttsourcecode/resources/app/client/applications/hud/container.mjs`

```javascript
/**
 * Align the position of the HUD layer to the current position of the canvas
 */
align() {
  if ( !this.rendered ) return; // Not yet rendered
  const hud = this.element;
  const {x, y} = canvas.primary.getGlobalPosition();
  const {width, height} = canvas.dimensions;
  const scale = canvas.stage.scale.x;
  Object.assign(hud.style, {
    width: `${width}px`,
    height: `${height}px`,
    left: `${x}px`,
    top: `${y}px`,
    transform: `scale(${scale})`
  });
}
```

**Key Findings:**
- The `align()` method updates the `#hud` container's CSS properties to match PIXI stage
- It reads `canvas.primary.getGlobalPosition()` for screen position
- It reads `canvas.stage.scale.x` for zoom scale
- It sets `left`, `top`, and `transform: scale()` directly on the element's style

#### When align() is Called

**Location**: `foundryvttsourcecode/resources/app/client/canvas/board.mjs`

```javascript
/**
 * Pan the canvas to a certain position and a certain zoom level.
 * @param {Partial<CanvasViewPosition>} [position]    The canvas position to pan to
 */
pan({x, y, scale}={}) {
  
  // Constrain the resulting canvas view
  const constrained = this._constrainView({x, y, scale});
  const scaleChange = constrained.scale !== this.stage.scale.x;

  // Set the pivot point
  this.stage.pivot.set(constrained.x, constrained.y);

  // Set the zoom level
  if ( scaleChange ) {
    this.stage.scale.set(constrained.scale, constrained.scale);
    this.updateBlur();
  }

  // Update the scene tracked position
  this.scene._viewPosition = constrained;

  // Call hooks
  Hooks.callAll("canvasPan", this, constrained);

  // Update controls
  this.controls._onCanvasPan();

  // Align the HUD
  this.hud.align();  // ← CRITICAL: HUD alignment happens here

  // Invalidate cached containers
  this.hidden.invalidateMasks();
  this.effects.illumination.invalidateDarknessLevelContainer();

  // Emulate mouse event to update the hover states
  MouseInteractionManager.emulateMoveEvent();
}
```

**Key Findings:**
- **`canvas.pan()` is the central method** that updates PIXI stage position/scale
- It updates `canvas.stage.pivot` (camera position)
- It updates `canvas.stage.scale` (camera zoom)
- **It ALWAYS calls `this.hud.align()` after updating the stage**
- This is how Foundry keeps the HUD aligned in native PIXI mode

#### How Foundry Triggers canvas.pan()

**Mouse Wheel Zoom** (`board.mjs:2179-2182`):
```javascript
_onMouseWheel(event) {
  const dz = event.delta < 0 ? 1.05 : 0.95;
  this.pan({scale: dz * canvas.stage.scale.x});
}
```

**Drag Pan** (`board.mjs:2057-2063`):
```javascript
_onDragCanvasPan(event) {
  // ... edge detection logic ...
  
  // Pan the canvas
  this.pan({
    x: canvas.stage.pivot.x - (dx * CONFIG.Canvas.dragSpeedModifier),
    y: canvas.stage.pivot.y - (dy * CONFIG.Canvas.dragSpeedModifier)
  });
}
```

**Animated Pan** (`board.mjs:1515-1537`):
```javascript
async animatePan({x, y, scale, duration=250, speed, easing}={}) {
  // ... animation setup ...
  
  await CanvasAnimation.animate(attributes, {
    name: "canvas.animatePan",
    duration: duration,
    easing: easing ?? CanvasAnimation.easeInOutCosine,
    ontick: () => this.pan(position)  // ← Calls pan() every frame during animation
  });
}
```

**Key Finding**: **ALL camera movement in Foundry goes through `canvas.pan()`**, which ensures `hud.align()` is always called.

---

### THE ROOT CAUSE DISCOVERED

#### Map Shine Bypasses canvas.pan()

**Location**: `scripts/foundry/camera-follower.js:660-716`

```javascript
_syncFromPixi() {
  const stage = canvas?.stage;
  if (!stage) return;
  
  const camera = this.sceneComposer?.camera;
  if (!camera) return;
  
  // Read PIXI state
  const pixiX = stage.pivot.x;
  const pixiY = stage.pivot.y;
  const pixiZoom = stage.scale.x || 1;
  
  // ... change detection ...
  
  // Apply to Three.js camera
  camera.position.x = pixiX;
  camera.position.y = worldHeight - pixiY;
  
  // FOV-based zoom
  if (camera.isPerspectiveCamera && this.sceneComposer.baseFovTanHalf !== undefined) {
    const baseTan = this.sceneComposer.baseFovTanHalf;
    const zoom = pixiZoom || 1;
    const fovRad = 2 * Math.atan(baseTan / zoom);
    const fovDeg = fovRad * (180 / Math.PI);
    const clamped = Math.max(1, Math.min(170, fovDeg));
    camera.fov = clamped;
    this.sceneComposer.currentZoom = zoom;
    camera.updateProjectionMatrix();
  }
  
  // Notify InteractionManager that camera has changed
  this._notifyCameraChanged();
}
```

**The Problem**:
1. `CameraFollower._syncFromPixi()` **reads** `canvas.stage.pivot` and `canvas.stage.scale`
2. It updates the Three.js camera to match
3. **BUT**: It doesn't call `canvas.pan()` or `canvas.hud.align()`
4. The PIXI stage values are correct, but the `#hud` container never gets updated

#### Why This Happens

Map Shine uses a **one-way sync**: PIXI → Three.js

- User input goes to PIXI (via `PixiInputBridge`)
- PIXI stage updates normally
- `CameraFollower` reads PIXI state and syncs Three.js camera
- **But**: The normal Foundry flow that calls `canvas.pan()` → `hud.align()` is bypassed

#### Why Initial Load Works

On initial load:
1. Foundry calls `canvas.pan()` during scene setup
2. This calls `hud.align()` once
3. The `#hud` container gets the correct initial transform
4. **But**: When the camera moves later, `hud.align()` is never called again

---

### THE ACTUAL SOLUTION

The fix is simple: **Call `canvas.hud.align()` when the camera changes**.

#### Option 1: Call in CameraFollower._syncFromPixi()
```javascript
_syncFromPixi() {
  // ... existing camera sync code ...
  
  // Update HUD alignment to match PIXI stage
  if (canvas?.hud?.align) {
    canvas.hud.align();
  }
}
```

**Pros**: 
- Minimal change
- Uses Foundry's own alignment logic
- Guaranteed to work correctly

**Cons**: 
- Calls `align()` every frame (30Hz) even if HUD is closed
- Slight performance overhead

#### Option 2: Call Only When HUD is Open
```javascript
_syncFromPixi() {
  // ... existing camera sync code ...
  
  // Update HUD alignment only if HUD is rendered
  if (canvas?.hud?.rendered && canvas.hud.align) {
    canvas.hud.align();
  }
}
```

**Pros**: 
- Only runs when HUD is actually open
- More efficient
- Still uses Foundry's logic

**Cons**: 
- None - this is the optimal solution

#### Option 3: Hook into canvasPan
```javascript
// In canvas-replacement.js initialization
Hooks.on('canvasPan', (canvas, position) => {
  if (canvas?.hud?.align) {
    canvas.hud.align();
  }
});
```

**Pros**: 
- Responds to Foundry's native pan events
- Decoupled from CameraFollower

**Cons**: 
- `canvasPan` hook might not fire when PIXI stage is updated directly
- Adds another hook listener
- Less reliable than direct call

**RECOMMENDED**: **Option 2** - Call `canvas.hud.align()` in `CameraFollower._syncFromPixi()` only when HUD is rendered.

---

## Problem 2: Rendering Freeze on Right-Click

### Observed Behavior

When right-clicking on a token, there is a noticeable pause/freeze in the rendering system. The freeze occurs **after** our code completes (after console logs), suggesting it's happening in Foundry's HUD rendering.

### Root Cause Analysis

#### The Right-Click Flow

1. **Three.js Raycast**: `InteractionManager.onPointerDown()` raycasts against token sprites
2. **Token Detection**: Finds the clicked token via `raycaster.intersectObjects(tokenSprites, true)`
3. **HUD Opening**: Calls `_openTokenHudViaPixi(token, event, { immediate: true })`
4. **Token Control**: `token.control({ releaseOthers: false })` - selects the token
5. **HUD Binding**: `hud.bind(token)` - **FREEZE HAPPENS HERE** ⚠️
6. **HUD Positioning**: `hud.setPosition()` - positions the HUD

#### Why `hud.bind()` Causes a Freeze

`hud.bind(token)` is a synchronous operation that:

1. **Renders HUD Template**: Compiles and renders the Handlebars template (`token-hud.hbs`)
2. **Prepares Context**: Calls `_prepareContext()` which:
   - Reads token document data
   - Calculates bar values (HP, etc.)
   - Builds status effects list
   - Builds movement actions list
   - Queries game settings and permissions
3. **Inserts DOM**: Appends the rendered HTML to the `#hud` container
4. **Triggers Hooks**: Fires `Hooks.callAll('renderTokenHUD', ...)` which modules can hook into
5. **Initializes Form**: Sets up form event listeners and input handlers

All of this happens **synchronously on the main thread**, blocking rendering until complete.

#### Performance Bottlenecks

1. **Template Rendering**: Handlebars compilation and rendering can be slow for complex templates
2. **Status Effects**: Building the status effects palette queries `CONFIG.statusEffects` and token effects
3. **Module Hooks**: `renderTokenHUD` hooks can run expensive module code synchronously
4. **DOM Insertion**: Appending large HTML structures to the DOM triggers layout/paint
5. **Form Initialization**: Setting up event listeners for all form inputs

### Current Implementation Attempts

#### Attempt 1: Defer Pathfinding to Next Frame
```javascript
// In onPointerUp - for click-to-move
if (pendingTokenDoc && pendingWorldPos) {
  requestAnimationFrame(async () => {
    await this._handleRightClickMovePreview(pendingTokenDoc, pendingWorldPos, pendingTokenDocs);
  });
}
```

**Status**: ✓ Successful - Pathfinding no longer blocks UI

**Why It Worked**: Pathfinding is deferred to next frame, allowing the right-click event to complete immediately.

#### Attempt 2: Defer HUD Binding to Next Frame
```javascript
// In _openTokenHudViaPixi
requestAnimationFrame(() => {
  safeCall(() => {
    if (!token.controlled) {
      token.control?.({ releaseOthers: false });
    }
    
    if (this.openHudTokenId === token.id && !immediate) {
      hud.close?.();
    } else {
      hud.bind?.(token);
      hud.setPosition?.();
    }
  }, 'rightClick.openHudDirect', Severity.COSMETIC);
  
  this._syncOpenHudTokenIdFromFoundry();
  if (this.openHudTokenId) this.updateHUDPosition();
});
```

**Status**: ❌ Failed - Freeze still occurs

**Why It Failed**: The freeze happens **after** our code completes and **after** the `requestAnimationFrame` callback. This suggests:
- The freeze is not in `hud.bind()` itself, but in something triggered by it
- A hook or event listener triggered by `hud.bind()` might be blocking
- The DOM insertion/layout/paint might be the actual bottleneck
- There might be a synchronous operation in a `renderTokenHUD` hook

### Hypotheses for Why Fix Isn't Working

1. **Module Hook Blocking**: A module's `renderTokenHUD` hook is running expensive synchronous code.

2. **DOM Layout Thrashing**: The HUD insertion triggers a synchronous layout recalculation that blocks rendering.

3. **Token Control Blocking**: `token.control()` might trigger vision/lighting recalculation synchronously.

4. **Multiple Render Passes**: The HUD might be rendering multiple times due to reactive updates.

5. **CSS Animations**: Complex CSS transitions/animations on the HUD might block the main thread.

### Investigation Needed

1. **Profile HUD Rendering**: Use Chrome DevTools Performance profiler to identify the exact bottleneck during right-click.

2. **Disable Modules**: Test with all modules disabled to rule out module hook interference.

3. **Measure Hook Execution**: Add timing logs to all `renderTokenHUD` hooks to identify slow ones.

4. **Test Token Control**: Try deferring `token.control()` separately from `hud.bind()` to isolate which causes the freeze.

5. **Monitor DOM Changes**: Use Performance Monitor to track DOM node count and layout recalculations during HUD opening.

---

## Proposed Solutions

### For HUD Misalignment

#### Option A: Hook into Foundry's HUD Container Update
- Find where Foundry updates the `#hud` container transform
- Hook into that update to ensure it runs when Three.js camera moves
- Pros: Uses Foundry's own logic, more likely to be correct
- Cons: Requires finding the right hook point in Foundry's code

#### Option B: Force PIXI Stage Render
- Trigger a PIXI stage render/update when Three.js camera moves
- This might trigger Foundry's HUD container update naturally
- Pros: Leverages existing Foundry mechanisms
- Cons: Might cause performance issues or conflicts

#### Option C: Replace HUD Positioning Entirely
- Override `BasePlaceableHUD._updatePosition()` to use Three.js camera directly
- Calculate screen position from Three.js world position
- Pros: Full control over positioning logic
- Cons: High risk of breaking module compatibility

#### Option D: Investigate PIXI Stage Desync
- Verify that PIXI stage position/scale is actually updating when Three.js camera moves
- If not, fix the PIXI stage sync in `CameraFollower`
- Pros: Fixes root cause if PIXI stage is desynced
- Cons: Might not be the actual issue

### For Rendering Freeze

#### Option A: Defer All HUD Operations
- Defer `token.control()`, `hud.bind()`, and `hud.setPosition()` to separate frames
- Use multiple `requestAnimationFrame()` calls to spread work across frames
- Pros: Prevents blocking, allows rendering to continue
- Cons: HUD appears with delay, might feel laggy

#### Option B: Optimize HUD Template
- Simplify the HUD template to reduce rendering complexity
- Lazy-load status effects palette
- Pros: Reduces actual work done during `hud.bind()`
- Cons: Changes HUD appearance, might break module compatibility

#### Option C: Preload HUD Template
- Pre-render and cache the HUD template on scene load
- Swap in cached template instead of rendering from scratch
- Pros: Eliminates template rendering bottleneck
- Cons: Complex to implement, might not work with dynamic data

#### Option D: Identify and Fix Slow Hook
- Profile to find which `renderTokenHUD` hook is slow
- Contact module author or patch the hook
- Pros: Fixes actual bottleneck
- Cons: Might be a core Foundry hook, not a module

#### Option E: Use Web Workers
- Move HUD template rendering to a Web Worker
- Send rendered HTML back to main thread for insertion
- Pros: Completely non-blocking
- Cons: Very complex, might not work with Handlebars/Foundry APIs

---

## Next Steps

1. **Deep Investigation**: Use browser DevTools to profile both issues and gather concrete data
2. **Test Hypotheses**: Systematically test each hypothesis to narrow down root causes
3. **Prototype Solutions**: Implement small prototypes of promising solutions
4. **Measure Impact**: Verify that solutions actually fix the issues without breaking other functionality
5. **Document Findings**: Update this document with investigation results and final solution

---

## Related Files

- `scripts/scene/interaction-manager.js` - Right-click handling, HUD opening
- `scripts/foundry/camera-follower.js` - Camera synchronization
- `foundryvttsourcecode/resources/app/public/scripts/foundry.mjs` - Foundry's HUD implementation
- `docs/planning/PIXI-TO-THREE-INTERACTION-REPLACEMENT-PLAN.md` - Original HUD replacement plan
