# Map Shine Advanced — Beta Readiness Plan

## Executive Summary

This document outlines the pathway from current development state to a stable early beta release. The focus is on **robustness, reliability, and graceful degradation** rather than new features. A beta-ready module must handle edge cases, unusual startup conditions, blank maps, scene transitions, and unexpected user behavior without crashing or leaving the system in a broken state.

---

## Current Architecture Assessment

### Strengths ✅

1. **Solid Foundation**
   - Clean separation: `module.js` → `bootstrap.js` → `canvas-replacement.js`
   - Centralized time management via `TimeManager`
   - GPU capability detection with tiered fallback (WebGL2 → WebGL1)
   - Comprehensive dispose/cleanup chain in `destroyThreeCanvas()`
   - Hook-based lifecycle (`canvasReady`, `canvasTearDown`)

2. **Effect System**
   - Well-structured `EffectComposer` with layer ordering
   - Effects properly implement `initialize()`, `update()`, `render()`, `dispose()`
   - GPU tier gating prevents crashes on low-end hardware
   - Post-processing ping-pong buffer system

3. **Foundry Integration**
   - Scene flag system for opt-in (`map-shine-advanced.enabled`)
   - Three-tier settings hierarchy (Map Maker → GM → Player)
   - Managers for tokens, tiles, walls, drawings, notes, templates, lights
   - Hybrid mode toggle for Map Maker editing

4. **Asset System**
   - Suffix-based texture discovery
   - Intelligent fallbacks for missing masks
   - Caching to prevent redundant loads

### Gaps & Risks ⚠️

| Area | Issue | Severity |
|------|-------|----------|
| **Blank Maps** | `composer.js:74` accesses `foundryScene.background.src` without null check | 🔴 Critical |
| **Scene Transitions** | No explicit state reset between scenes; stale references possible | 🔴 Critical |
| **Bootstrap Race** | 5-second timeout in `onCanvasReady` may not be enough on slow systems | 🟡 Medium |
| **Effect Errors** | Individual effect errors disable the effect but don't notify user | 🟡 Medium |
| **Missing Hooks** | No `updateScene` hook to handle mid-session scene config changes | 🟡 Medium |
| **Memory Leaks** | Some effects may not fully dispose GPU resources | 🟡 Medium |
| **Error Recovery** | No mechanism to retry initialization after transient failures | 🟡 Medium |
| **UI State** | Tweakpane UI not disposed/recreated on scene change | 🟡 Medium |
| **Vision Edge Cases** | VisionManager assumes canvas.dimensions exists | 🟡 Medium |
| **Resize Handling** | Not all effects implement `onResize()` | 🟢 Low |

---

## Beta Readiness Checklist

### Phase 1: Critical Robustness (Must Have)

#### 1.1 Blank Map / No Background Handling
**Problem**: Scenes without a background image will crash at `foundryScene.background.src`.

**Solution**:
```javascript
// In composer.js initialize()
if (!foundryScene.background?.src) {
  log.warn('Scene has no background image, creating fallback');
  // Create solid color plane using scene.backgroundColor
  this.createFallbackBackground();
  return { scene: this.scene, camera: this.camera, bundle: { masks: [] } };
}
```

**Test Cases**:
- [ ] Scene with no background image
- [ ] Scene with background set to `null`
- [ ] Scene with empty string background path

#### 1.2 Scene Transition Safety
**Problem**: Switching scenes may leave stale references or fail to reinitialize.

**Solution**:
1. Ensure `destroyThreeCanvas()` is called before `createThreeCanvas()`
2. Add explicit null checks in all managers before accessing scene data
3. Clear all hook registrations on teardown to prevent duplicate handlers

**Implementation**:
```javascript
// In canvas-replacement.js onCanvasTearDown()
function onCanvasTearDown(canvas) {
  log.info('Tearing down Map Shine canvas');
  
  // CRITICAL: Clear pending operations
  if (effectComposer?.timeManager) {
    effectComposer.timeManager.pause();
  }
  
  // Dispose in reverse initialization order
  destroyThreeCanvas();
  
  // Clear global references
  if (window.MapShine) {
    window.MapShine.sceneComposer = null;
    window.MapShine.effectComposer = null;
    // ... etc
  }
}
```

**Test Cases**:
- [ ] Switch from enabled scene to enabled scene
- [ ] Switch from enabled scene to disabled scene
- [ ] Switch from disabled scene to enabled scene
- [ ] Rapid scene switching (stress test)
- [ ] Scene switch during effect initialization

#### 1.3 Bootstrap Timeout & Recovery
**Problem**: 5-second timeout may fail on slow systems; no recovery path.

**Solution**:
```javascript
// Increase timeout and add retry logic
const MAX_WAIT_MS = 10000;
const RETRY_INTERVAL_MS = 200;

let waited = 0;
while (!window.MapShine?.initialized && waited < MAX_WAIT_MS) {
  await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
  waited += RETRY_INTERVAL_MS;
}

if (!window.MapShine?.initialized) {
  log.error('Bootstrap timeout - attempting lazy bootstrap');
  // Lazy bootstrap already exists, but add user notification
  ui.notifications.warn('Map Shine: Initialization delayed, retrying...');
}
```

**Test Cases**:
- [ ] Slow system startup (simulate with artificial delay)
- [ ] Module load order conflicts
- [ ] Foundry ready before module ready
- [ ] Module ready before Foundry ready

#### 1.4 Null Safety in Core Paths
**Problem**: Multiple locations assume objects exist without checking.

**Locations to Audit**:
- `composer.js`: `foundryScene.background.src`, `canvas.primary.background.texture`
- `VisionManager.js`: `canvas.dimensions`, `canvas.tokens.placeables`
- `TokenManager.js`: `token.document`, `token.texture.src`
- `TileManager.js`: `tile.document`, `tile.texture.src`
- All effects: `bundle.masks`, `basePlane.geometry`

**Solution**: Add defensive null checks with early returns and logging.

**Test Cases**:
- [ ] Scene with no tokens
- [ ] Scene with no tiles
- [ ] Scene with no walls
- [ ] Scene with no lights
- [ ] Token with missing texture

---

### Phase 2: Graceful Degradation (Should Have)

#### 2.1 Effect Error Isolation
**Problem**: Effect errors disable the effect silently; user doesn't know why.

**Solution**:
```javascript
// In EffectComposer.render()
try {
  effect.update(timeInfo);
  effect.render(this.renderer, this.scene, this.camera);
} catch (error) {
  log.error(`Effect ${effect.id} failed:`, error);
  effect.enabled = false;
  effect.errorState = error.message;
  
  // Notify user once per effect
  if (!effect._userNotified) {
    ui.notifications.warn(`Map Shine: ${effect.id} effect disabled due to error`);
    effect._userNotified = true;
  }
}
```

**Test Cases**:
- [ ] Effect with invalid shader
- [ ] Effect with missing texture
- [ ] Effect with NaN uniform values
- [ ] Multiple effects failing simultaneously

#### 2.2 Memory Leak Prevention
**Problem**: Some effects may not fully dispose GPU resources.

**Solution**: Audit all effects for proper disposal:

```javascript
// Standard dispose pattern for effects
dispose() {
  // Dispose materials
  if (this.material) {
    if (this.material.map) this.material.map.dispose();
    if (this.material.uniforms) {
      for (const uniform of Object.values(this.material.uniforms)) {
        if (uniform.value?.dispose) uniform.value.dispose();
      }
    }
    this.material.dispose();
  }
  
  // Dispose geometries
  if (this.geometry) this.geometry.dispose();
  
  // Dispose render targets
  if (this.renderTarget) this.renderTarget.dispose();
  
  // Remove from scene
  if (this.mesh && this.mesh.parent) {
    this.mesh.parent.remove(this.mesh);
  }
  
  // Clear references
  this.material = null;
  this.geometry = null;
  this.mesh = null;
}
```

**Test Cases**:
- [ ] Switch scenes 10 times, monitor GPU memory
- [ ] Enable/disable effects repeatedly
- [ ] Resize window repeatedly

#### 2.3 UI State Management
**Problem**: Tweakpane UI may not properly reset on scene change.

**Solution**:
```javascript
// In destroyThreeCanvas()
if (uiManager) {
  uiManager.dispose();
  uiManager = null;
  log.debug('UI manager disposed');
}
```

**Test Cases**:
- [ ] Scene switch preserves effect settings
- [ ] Scene switch resets to new scene's settings
- [ ] UI reflects correct state after scene change

#### 2.4 Resize Robustness
**Problem**: Not all effects implement `onResize()`.

**Solution**: Add default implementation in `EffectBase`:
```javascript
onResize(width, height) {
  // Update any render targets
  if (this.renderTarget) {
    this.renderTarget.setSize(width, height);
  }
  
  // Update resolution uniforms
  if (this.material?.uniforms?.uResolution) {
    this.material.uniforms.uResolution.value.set(width, height);
  }
}
```

**Test Cases**:
- [ ] Resize window during rendering
- [ ] Fullscreen toggle
- [ ] Multi-monitor drag

---

### Phase 3: Edge Case Handling (Nice to Have)

#### 3.1 Scene Configuration Changes
**Problem**: No handling for mid-session scene config changes (grid size, padding, etc.).

**Solution**: Add `updateScene` hook handler:
```javascript
Hooks.on('updateScene', (scene, changes) => {
  if (!sceneSettings.isEnabled(scene)) return;
  
  // Check for changes that require reinitialization
  const requiresReinit = ['grid', 'padding', 'background', 'dimensions']
    .some(key => key in changes);
  
  if (requiresReinit) {
    log.info('Scene configuration changed, reinitializing');
    destroyThreeCanvas();
    createThreeCanvas(scene);
  }
});
```

#### 3.2 Module Conflict Detection
**Problem**: Other modules may interfere with canvas rendering.

**Solution**: Add compatibility checks:
```javascript
function checkModuleCompatibility() {
  const conflicts = [];
  
  // Check for known conflicting modules
  if (game.modules.get('some-conflicting-module')?.active) {
    conflicts.push('some-conflicting-module');
  }
  
  if (conflicts.length > 0) {
    log.warn('Potential module conflicts detected:', conflicts);
    ui.notifications.warn(`Map Shine: Potential conflicts with: ${conflicts.join(', ')}`);
  }
}
```

#### 3.3 Performance Monitoring
**Problem**: No automatic performance degradation.

**Solution**: Add FPS monitoring with automatic quality reduction:
```javascript
// In RenderLoop
if (this.fps < 20 && this.frameCount > 60) {
  log.warn('Low FPS detected, reducing quality');
  this.effectComposer?.reduceQuality();
}
```

---

## Testing Strategy

### Unit Tests (Automated)
Create test harness for core functions:
- [ ] `isEnabled()` with various scene states
- [ ] `migrateSettings()` version upgrades
- [ ] `extractBasePath()` edge cases
- [ ] `GeometryConverter` coordinate transforms

### Integration Tests (Manual Checklist)

#### Startup Scenarios
| Scenario | Expected Behavior | Status |
|----------|-------------------|--------|
| Fresh install, first scene load | Initializes cleanly | ⬜ |
| Module update, existing scene | Migrates settings | ⬜ |
| Foundry update, existing scene | Continues working | ⬜ |
| Browser refresh mid-scene | Reinitializes | ⬜ |

#### Scene Types
| Scenario | Expected Behavior | Status |
|----------|-------------------|--------|
| Standard map with masks | Full effects | ⬜ |
| Standard map without masks | Base render only | ⬜ |
| Blank scene (no background) | Fallback color | ⬜ |
| Very large map (8000x8000+) | Renders (may reduce quality) | ⬜ |
| Very small map (500x500) | Renders correctly | ⬜ |
| Non-square aspect ratio | No distortion | ⬜ |

#### Scene Transitions
| Scenario | Expected Behavior | Status |
|----------|-------------------|--------|
| Enabled → Enabled | Clean transition | ⬜ |
| Enabled → Disabled | Falls back to PIXI | ⬜ |
| Disabled → Enabled | Initializes Three.js | ⬜ |
| Rapid switching (5x in 10s) | No crashes | ⬜ |

#### Token Operations
| Scenario | Expected Behavior | Status |
|----------|-------------------|--------|
| Create token | Appears in Three.js | ⬜ |
| Move token | Animates smoothly | ⬜ |
| Delete token | Removed cleanly | ⬜ |
| Token with missing image | Fallback sprite | ⬜ |
| 50+ tokens | Acceptable performance | ⬜ |

#### Effect Edge Cases
| Scenario | Expected Behavior | Status |
|----------|-------------------|--------|
| All effects enabled | Renders (may be slow) | ⬜ |
| All effects disabled | Base render only | ⬜ |
| Effect with invalid mask | Effect disabled, others work | ⬜ |
| Shader compilation failure | Effect disabled, notification | ⬜ |

#### Browser/System
| Scenario | Expected Behavior | Status |
|----------|-------------------|--------|
| Chrome latest | Full support | ⬜ |
| Firefox latest | Full support | ⬜ |
| Edge latest | Full support | ⬜ |
| Safari (if applicable) | Graceful fallback | ⬜ |
| Low-end GPU | Reduced effects, stable | ⬜ |
| Integrated graphics | Basic effects, stable | ⬜ |

---

## Implementation Priority

### Sprint 1: Critical Fixes (Week 1)
1. ✅ Blank map handling in `composer.js` - **DONE**
2. ✅ Null safety audit for core paths - **DONE** (VisionManager, TokenManager already safe)
3. ✅ Scene transition state cleanup - **DONE**
4. ✅ Bootstrap timeout increase - **DONE** (15s with progress logging)

### Sprint 2: Graceful Degradation (Week 2)
1. ✅ Effect error isolation and user notification - **DONE**
2. ✅ Memory leak audit and fixes - **DONE** (EffectBase.dispose() default impl)
3. ⬜ UI state management on scene change
4. ✅ Resize robustness - **DONE** (EffectBase.onResize() default impl)

### Sprint 3: Testing & Polish (Week 3)
1. ⬜ Execute full manual test matrix
2. ⬜ Fix issues discovered in testing
3. ⬜ Performance profiling and optimization
4. ⬜ Documentation updates

### Sprint 4: Beta Release Prep (Week 4)
1. ⬜ Final test pass
2. ⬜ Version bump to 0.8.0-beta
3. ⬜ Release notes
4. ⬜ Known issues documentation

---

## Success Criteria for Beta

A beta release is ready when:

1. **Zero Critical Bugs**: No crashes or data loss scenarios
2. **Graceful Degradation**: All edge cases handled with user feedback
3. **Clean Transitions**: Scene switching works reliably
4. **Performance Acceptable**: 30+ FPS on mid-range hardware
5. **Memory Stable**: No leaks over extended sessions
6. **User Feedback**: Clear notifications for all error states
7. **Documentation**: Updated README, TESTING.md, and CHANGELOG

---

## Appendix: Code Locations for Key Changes

| Change | File | Line/Function |
|--------|------|---------------|
| Blank map handling | `scripts/scene/composer.js` | `initialize()` |
| Scene transition cleanup | `scripts/foundry/canvas-replacement.js` | `onCanvasTearDown()` |
| Bootstrap timeout | `scripts/foundry/canvas-replacement.js` | `onCanvasReady()` |
| Effect error isolation | `scripts/effects/EffectComposer.js` | `render()` |
| Memory leak fixes | All effect files | `dispose()` |
| UI state management | `scripts/foundry/canvas-replacement.js` | `destroyThreeCanvas()` |
| Resize robustness | `scripts/effects/EffectComposer.js` | `EffectBase.onResize()` |
| Scene config changes | `scripts/foundry/canvas-replacement.js` | `onUpdateScene()` ✅ |
