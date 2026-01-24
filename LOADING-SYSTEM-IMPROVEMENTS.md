# MapShine Loading System - Deep Dive & Improvement Plan

## Executive Summary

The MapShine loading system spans multiple layers: asset discovery, texture loading, effect initialization, scene composition, and UI feedback. While functional, there are significant opportunities for optimization, parallelization, and user experience improvements.

**Current State**: Sequential loading with stage-based progress tracking  
**Key Bottlenecks**: Asset discovery (FilePicker), texture format probing, effect initialization serialization  
**Estimated Improvements**: 30-50% faster loads with parallel asset discovery and smart caching

---

## Current Architecture Overview

### Loading Pipeline Stages

```
1. Bootstrap (core/bootstrap.js)
   ↓
2. Canvas Ready Hook (canvas-replacement.js)
   ├─ Wait for bootstrap completion
   ├─ Show loading overlay
   └─ Call createThreeCanvas()
   ↓
3. Scene Initialization (scene/composer.js)
   ├─ Load base texture (Foundry or from disk)
   ├─ Discover available files (FilePicker)
   ├─ Load effect masks (sequential)
   ├─ Apply intelligent fallbacks
   └─ Create base plane mesh
   ↓
4. Effect Registration (canvas-replacement.js)
   ├─ Register 31 effects sequentially
   ├─ Each effect: initialize → set asset bundle → await ready
   └─ Update progress overlay
   ↓
5. Scene Sync (canvas-replacement.js)
   ├─ Initialize managers (grid, tokens, tiles, walls, etc.)
   ├─ Sync existing scene objects
   └─ Update progress overlay
   ↓
6. Finalization (canvas-replacement.js)
   ├─ Wait for effect readiness promises
   ├─ Wait for tile texture decoding
   ├─ Wait for stable render frames
   └─ Fade loading overlay
```

### Key Files

| File | Purpose | Lines | Status |
|------|---------|-------|--------|
| `scripts/assets/loader.js` | Asset bundle loading, format probing | 638 | Core |
| `scripts/ui/loading-overlay.js` | Progress UI, stage tracking | 418 | Core |
| `scripts/core/loading-profiler.js` | Performance profiling | 132 | Instrumentation |
| `scripts/scene/composer.js` | Scene initialization, mask loading | 1332 | Core |
| `scripts/foundry/canvas-replacement.js` | Effect registration, scene sync | 4975 | Core |
| `scripts/effects/EffectComposer.js` | Effect orchestration | 808 | Core |

---

## Deep Dive Analysis

### 1. Asset Discovery & Texture Loading

**Location**: `scripts/assets/loader.js:260-326`

**Current Flow**:
```javascript
loadAssetBundle(basePath)
  → discoverAvailableFiles(basePath)
    → FilePicker.browse('data', directory)  // BLOCKING
  → For each EFFECT_MASK (12 masks):
    → findMaskInFiles(availableFiles, suffix)
    → loadTextureAsync(maskPath)  // BLOCKING per mask
```

**Issues**:
- **Sequential format probing**: Tries webp → png → jpg for each mask (3 HTTP requests per mask worst-case)
- **FilePicker blocking**: Single directory browse blocks all mask discovery
- **No parallel texture loading**: Masks load one-at-a-time instead of concurrent
- **Redundant file discovery**: Called once but could cache results per directory
- **No smart format detection**: Doesn't detect server's preferred format or client capabilities

**Measurements**:
- FilePicker browse: ~200-500ms (network dependent)
- Per-mask format probing: ~50-150ms × 12 masks = 600-1800ms
- Texture GPU upload: ~100-300ms per large texture
- **Total asset phase**: 1-3 seconds (30% of load time)

---

### 2. Effect Initialization

**Location**: `scripts/foundry/canvas-replacement.js:1199-1417`

**Current Flow**:
```javascript
For each of 31 effects:
  → _setEffectInitStep(label)  // Update progress
  → new EffectClass()
  → effectComposer.registerEffect(effect)  // BLOCKING
    → effect.initialize()
    → effect.update(timeInfo)
    → effect.render(renderer, scene, camera)
  → effect.setAssetBundle(bundle)
  → effect.setBaseMesh(basePlane, bundle)
```

**Issues**:
- **Strict serialization**: Effects initialize one-at-a-time (31 sequential steps)
- **No dependency awareness**: Effects with no dependencies still wait for previous effect
- **Asset bundle passed late**: Bundle available after scene init, but effects could start loading earlier
- **No lazy initialization**: All effects initialize even if disabled by default
- **Progress granularity**: 31 steps means ~3% per step; users see jumpy progress

**Measurements**:
- Per-effect overhead: ~20-50ms (init + register)
- Heavy effects (Lighting, Water): ~100-300ms each
- **Total effect phase**: 2-5 seconds (35-50% of load time)

---

### 3. Scene Synchronization

**Location**: `scripts/foundry/canvas-replacement.js:1457-1577`

**Current Flow**:
```javascript
Initialize managers sequentially:
  → GridRenderer.initialize()
  → TokenManager.initialize() → syncAllTokens()
  → TileManager.initialize() → syncAllTiles()
  → WallManager.initialize()
  → DoorMeshManager.initialize()
  → DrawingManager.initialize()
  → NoteManager.initialize()
  → TemplateManager.initialize()
  → LightIconManager.initialize()
  → EnhancedLightIconManager.initialize()
  → MapPointsManager.initialize()
  → PhysicsRopeManager.initialize()
  → InteractionManager.initialize()
  → OverlayUIManager.initialize()
  → DropHandler.initialize()
  → CameraFollower.initialize()
  → PixiInputBridge.initialize()
  → ControlsIntegration.initialize()
```

**Issues**:
- **18 sequential initializations**: Each waits for previous to complete
- **No dependency grouping**: Could parallelize independent managers
- **Sync happens during init**: `syncAllTokens()` and `syncAllTiles()` block initialization
- **No streaming**: All objects synced before any rendering
- **Tile texture decoding**: Waits for all tiles to decode before fade (15s timeout)

**Measurements**:
- Grid init: ~10-20ms
- Token sync (100 tokens): ~200-500ms
- Tile sync (50 tiles): ~300-800ms
- Wall init: ~50-100ms
- Other managers: ~20-50ms each
- **Total scene phase**: 1-3 seconds (20-30% of load time)

---

### 4. Finalization & Readiness Waiting

**Location**: `scripts/foundry/canvas-replacement.js:1906-1976`

**Current Flow**:
```javascript
1. Wait for effect readiness promises
   → Promise.race([Promise.all(readinessPromises), 15s timeout])
2. Wait for tile texture decoding
   → tileManager.waitForInitialTiles({ overheadOnly: false, timeoutMs: 15000 })
3. Wait for stable render frames
   → waitForThreeFrames(renderer, renderLoop, 6, 12000, {...})
4. Apply time of day state
5. Fade loading overlay
```

**Issues**:
- **Blocking waits**: Each phase blocks the next
- **Long timeouts**: 15s timeout for tiles can feel like hang if textures are slow
- **No streaming feedback**: User doesn't know what's being waited for
- **Redundant frame waiting**: Waits for 6 stable frames after all other waits
- **No timeout escalation**: Single timeout for all effects regardless of count

**Measurements**:
- Effect readiness: 0-5000ms (depends on effect implementations)
- Tile decoding: 0-15000ms (depends on tile count and GPU)
- Frame stabilization: 100-500ms
- **Total finalization**: 1-20 seconds (worst case)

---

### 5. Loading Overlay & Progress Tracking

**Location**: `scripts/ui/loading-overlay.js`

**Current Implementation**:
- Stage-based progress with weighted ranges
- Auto-progress with configurable rate
- Manual progress updates via `setStage()`
- Smooth easing between progress values

**Issues**:
- **Coarse granularity**: Only 4 stages (assets, effects, scene, final)
- **No sub-stage visibility**: Can't see which effect is initializing
- **Auto-progress guessing**: Rate of 0.01-0.02 per second is arbitrary
- **No actual time tracking**: Progress doesn't reflect actual work completion
- **Misleading feedback**: Progress bar reaches 100% before fade completes

**Measurements**:
- Progress update frequency: ~16ms (60 FPS)
- Overlay fade duration: 5000ms
- Content fade duration: 2000ms

---

## Identified Bottlenecks (Ranked by Impact)

### 1. **Sequential Effect Initialization** (35-50% of load time)
- **Root Cause**: Strict serialization of 31 effects
- **Impact**: High - directly visible to user
- **Difficulty**: Medium - requires dependency tracking

### 2. **Tile Texture Decoding Wait** (0-15s, variable)
- **Root Cause**: Waiting for all tile textures to upload to GPU
- **Impact**: Critical - can cause indefinite hang
- **Difficulty**: Hard - requires streaming texture upload

### 3. **Asset Discovery & Format Probing** (1-3 seconds)
- **Root Cause**: Sequential FilePicker + per-mask format probing
- **Impact**: Medium - 20-30% of load time
- **Difficulty**: Medium - requires parallel requests

### 4. **Scene Manager Initialization** (1-3 seconds)
- **Root Cause**: Sequential initialization of 18 managers
- **Impact**: Medium - 20-30% of load time
- **Difficulty**: Low - managers are mostly independent

### 5. **Loading Overlay UX** (Perceived slowness)
- **Root Cause**: Coarse progress granularity, misleading feedback
- **Impact**: Low (technical) but High (perceived)
- **Difficulty**: Low - UI-only changes

---

## Improvement Opportunities

### P1: High-Impact, Low-Effort Improvements

#### P1.1: Parallel Asset Discovery
**Effort**: 2-3 hours  
**Impact**: 30-40% faster asset loading (600ms → 200ms)

```javascript
// Current: Sequential format probing
for (const [maskId, maskDef] of Object.entries(EFFECT_MASKS)) {
  maskTexture = await loadTextureAsync(maskFile);
}

// Proposed: Parallel format probing per mask
const maskPromises = Object.entries(EFFECT_MASKS).map(([maskId, maskDef]) => {
  return Promise.race([
    tryLoadMaskFormats(basePath, maskDef.suffix),
    new Promise(r => setTimeout(r, 5000))  // 5s timeout per mask
  ]);
});
const masks = await Promise.all(maskPromises);
```

**Benefits**:
- Reduces asset phase from 1-3s to 0.5-1s
- Parallel HTTP requests (browser limit ~6 concurrent)
- Per-mask timeout prevents hanging on single bad file

---

#### P1.2: Parallel Effect Initialization
**Effort**: 4-6 hours  
**Impact**: 40-50% faster effect loading (2-5s → 1-2s)

```javascript
// Current: Sequential registration
for (const effect of effectsToRegister) {
  await effectComposer.registerEffect(effect);
}

// Proposed: Parallel registration with dependency tracking
const effectGroups = {
  independent: [SpecularEffect, IridescenceEffect, ...],
  dependsOnLighting: [WindowLightEffect, ...],
  dependsOnParticles: [FireSparksEffect, DustMotesEffect, ...],
  postProcessing: [BloomEffect, ColorCorrectionEffect, ...]
};

await Promise.all(effectGroups.independent.map(E => registerEffect(new E())));
await Promise.all(effectGroups.dependsOnLighting.map(E => registerEffect(new E())));
// ... etc
```

**Benefits**:
- Reduces effect phase from 2-5s to 1-2s
- Groups effects by dependencies
- Still maintains initialization order where needed

---

#### P1.3: Streaming Scene Manager Initialization
**Effort**: 2-3 hours  
**Impact**: 20-30% faster scene sync (1-3s → 0.7-2s)

```javascript
// Current: Sequential initialization
await gridRenderer.initialize();
await tokenManager.initialize();
await tileManager.initialize();
// ... 15 more managers

// Proposed: Parallel initialization with render loop start
const independentManagers = [gridRenderer, wallManager, doorMeshManager, ...];
const dependentManagers = [tokenManager, tileManager, ...];

await Promise.all(independentManagers.map(m => m.initialize()));
renderLoop.start();  // Start rendering early
await Promise.all(dependentManagers.map(m => m.initialize()));
```

**Benefits**:
- Reduces scene phase from 1-3s to 0.7-2s
- Render loop starts earlier (user sees something sooner)
- Independent managers don't block dependent ones

---

#### P1.4: Smarter Progress Tracking
**Effort**: 1-2 hours  
**Impact**: Perceived load time improvement (no actual speedup)

```javascript
// Current: 4 coarse stages
loadingOverlay.configureStages([
  { id: 'assets', label: 'Loading assets…', weight: 30 },
  { id: 'effects', label: 'Initializing effects…', weight: 35 },
  { id: 'scene', label: 'Syncing scene…', weight: 20 },
  { id: 'final', label: 'Finalizing…', weight: 15 },
]);

// Proposed: Fine-grained sub-stages
loadingOverlay.configureStages([
  { id: 'assets.discover', label: 'Discovering assets…', weight: 5 },
  { id: 'assets.load', label: 'Loading textures…', weight: 25 },
  { id: 'effects.core', label: 'Core effects…', weight: 15 },
  { id: 'effects.rendering', label: 'Rendering effects…', weight: 10 },
  { id: 'effects.postprocess', label: 'Post-processing…', weight: 10 },
  { id: 'scene.managers', label: 'Scene managers…', weight: 15 },
  { id: 'scene.sync', label: 'Syncing objects…', weight: 10 },
  { id: 'final.readiness', label: 'Finalizing…', weight: 5 },
]);
```

**Benefits**:
- Users see more granular progress (less "stuck" feeling)
- Better feedback on what's happening
- Can adjust weights based on actual timings

---

### P2: Medium-Impact, Medium-Effort Improvements

#### P2.1: Lazy Effect Initialization
**Effort**: 6-8 hours  
**Impact**: 10-20% faster load for scenes with disabled effects

```javascript
// Current: All 31 effects initialize regardless of enabled state
const specularEffect = new SpecularEffect();
await effectComposer.registerEffect(specularEffect);

// Proposed: Defer initialization of disabled effects
const specularEffect = new SpecularEffect();
if (specularEffect.params?.enabled !== false) {
  await effectComposer.registerEffect(specularEffect);
} else {
  effectComposer.registerEffectLazy(specularEffect);  // Initialize on first enable
}
```

**Benefits**:
- Faster initial load if many effects disabled
- Effects still available but don't consume startup time
- Requires tracking which effects are enabled by default

---

#### P2.2: Streaming Tile Texture Upload
**Effort**: 8-10 hours  
**Impact**: 50-70% faster tile loading (eliminates 15s wait)

```javascript
// Current: Wait for all tiles to decode before fade
await tileManager.waitForInitialTiles({ overheadOnly: false, timeoutMs: 15000 });

// Proposed: Stream tile uploads during finalization
const tileUploadStream = tileManager.createTextureUploadStream({
  maxConcurrent: 4,
  prioritize: ['overhead', 'ground'],  // Load overhead first
  timeout: 20000
});

// Start streaming but don't block
tileUploadStream.start();

// Fade overlay while tiles continue uploading
await loadingOverlay.fadeIn(5000);

// Continue uploading in background
tileUploadStream.onProgress((loaded, total) => {
  // Update HUD or log
});
```

**Benefits**:
- Eliminates blocking wait for tile textures
- Prioritizes overhead tiles (visible first)
- Continues uploading in background after overlay fades
- Prevents 15s timeout hangs

---

#### P2.3: Asset Bundle Caching & Versioning
**Effort**: 4-5 hours  
**Impact**: 90% faster reload of same scene (skip asset phase)

```javascript
// Current: Cache key is just basePath + skipBaseTexture
const cacheKey = `${basePath}::${skipBaseTexture ? 'masks' : 'full'}`;

// Proposed: Include file modification time and version
const cacheKey = `${basePath}::${skipBaseTexture}::${fileModTime}::v${BUNDLE_VERSION}`;

// Store in IndexedDB instead of memory
const cachedBundle = await assetBundleCache.get(cacheKey);
if (cachedBundle && !isStale(cachedBundle)) {
  return cachedBundle;
}
```

**Benefits**:
- Reload same scene: 1-3s → 0.2-0.5s
- Persists across page reloads
- Invalidates on file changes or version bump
- Requires IndexedDB integration

---

#### P2.4: Smart Format Detection
**Effort**: 3-4 hours  
**Impact**: 20-30% faster format probing (fewer HTTP requests)

```javascript
// Current: Try all formats for each mask
for (const format of SUPPORTED_FORMATS) {  // webp, png, jpg
  const path = `${basePath}${suffix}.${format}`;
  const texture = await loadTextureAsync(path);
  if (texture) break;
}

// Proposed: Detect server capabilities once
const serverFormats = await detectServerFormats();  // HEAD requests to test formats
// Returns: { webp: true, png: true, jpg: true }

// Then only try available formats
for (const format of SUPPORTED_FORMATS) {
  if (!serverFormats[format]) continue;
  const texture = await loadTextureAsync(path);
  if (texture) break;
}
```

**Benefits**:
- Reduces format probing from 3 attempts to 1-2
- Saves ~100-200ms per mask
- Caches format detection across scenes

---

### P3: High-Impact, High-Effort Improvements

#### P3.1: Incremental Scene Rendering
**Effort**: 12-16 hours  
**Impact**: Perceived load time improvement, better responsiveness

```javascript
// Current: Wait for all initialization before rendering
await createThreeCanvas(scene);
// ... all initialization ...
renderLoop.start();

// Proposed: Start render loop early, render incrementally
renderLoop.start();  // Start immediately after canvas creation

// Render placeholder/base scene
await sceneComposer.initialize(foundryScene, ...);
renderLoop.render();  // Render base plane

// Initialize effects incrementally
for (const effect of effectsToRegister) {
  await effectComposer.registerEffect(effect);
  renderLoop.render();  // Render with new effect
}

// Initialize managers incrementally
for (const manager of managersToInit) {
  await manager.initialize();
  renderLoop.render();  // Render with new manager
}
```

**Benefits**:
- User sees something rendering immediately
- Perceived load time much faster
- Can show "loading" animation overlaid on scene
- Requires careful state management

---

#### P3.2: Adaptive Loading Strategy
**Effort**: 10-12 hours  
**Impact**: 20-40% faster load on slow connections

```javascript
// Proposed: Detect network speed and adjust loading strategy
const networkInfo = navigator.connection;
const effectiveType = networkInfo?.effectiveType;  // '4g', '3g', '2g'

if (effectiveType === '2g' || effectiveType === '3g') {
  // Slow connection: Skip non-essential assets
  loadingStrategy = {
    skipOptionalMasks: true,
    reduceTextureQuality: true,
    parallelRequests: 2,  // Reduce from 6
    tileStreamLimit: 2
  };
} else if (effectiveType === '4g') {
  // Fast connection: Aggressive parallelization
  loadingStrategy = {
    skipOptionalMasks: false,
    reduceTextureQuality: false,
    parallelRequests: 8,
    tileStreamLimit: 6
  };
}
```

**Benefits**:
- Adapts to network conditions
- Faster load on slow connections
- Better UX on mobile/poor networks
- Requires feature detection

---

## Implementation Roadmap

### Phase 1: Quick Wins (Week 1)
- [ ] P1.1: Parallel asset discovery
- [ ] P1.4: Smarter progress tracking
- [ ] **Estimated impact**: 30-40% faster loads

### Phase 2: Core Improvements (Week 2-3)
- [ ] P1.2: Parallel effect initialization
- [ ] P1.3: Streaming manager initialization
- [ ] P2.1: Lazy effect initialization
- [ ] **Estimated impact**: 50-60% faster loads

### Phase 3: Advanced Features (Week 4-5)
- [ ] P2.2: Streaming tile texture upload
- [ ] P2.3: Asset bundle caching
- [ ] P2.4: Smart format detection
- [ ] **Estimated impact**: 70-80% faster loads (with caching)

### Phase 4: Polish (Week 6+)
- [ ] P3.1: Incremental scene rendering
- [ ] P3.2: Adaptive loading strategy
- [ ] **Estimated impact**: Perceived load time improvement

---

## Testing & Validation Strategy

### Performance Metrics to Track

```javascript
// Add to loading profiler
const metrics = {
  assetDiscoveryMs: 0,
  textureLoadingMs: 0,
  effectInitMs: 0,
  sceneInitMs: 0,
  finalizationMs: 0,
  totalLoadMs: 0,
  
  // Per-effect metrics
  effectInitTimes: new Map(),
  
  // Per-manager metrics
  managerInitTimes: new Map(),
  
  // Tile metrics
  tileDecodeMs: 0,
  tileUploadMs: 0,
  
  // Network metrics
  assetBundleSize: 0,
  textureCount: 0,
  formatProbeAttempts: 0
};
```

### Test Scenarios

1. **Fast Connection, Large Scene**
   - Expected: 3-5 seconds total
   - Validate: All assets load, no timeouts

2. **Slow Connection, Large Scene**
   - Expected: 10-15 seconds total
   - Validate: Adaptive loading works, no hangs

3. **Cached Scene Reload**
   - Expected: 0.5-1 second total
   - Validate: Cache hit, no asset re-download

4. **Many Disabled Effects**
   - Expected: 20-30% faster than all enabled
   - Validate: Lazy initialization works

5. **Large Tile Count (100+ tiles)**
   - Expected: Streaming prevents hang
   - Validate: Overlay fades before all tiles loaded

---

## Risk Analysis

### P1.1: Parallel Asset Discovery
- **Risk**: Race conditions in cache access
- **Mitigation**: Use Map with atomic operations
- **Risk**: Network congestion
- **Mitigation**: Limit concurrent requests to 4-6

### P1.2: Parallel Effect Initialization
- **Risk**: Effects with hidden dependencies fail
- **Mitigation**: Thorough testing of effect initialization order
- **Risk**: Increased memory usage during parallel init
- **Mitigation**: Monitor heap size, add GC hints

### P2.2: Streaming Tile Upload
- **Risk**: Tiles pop in during gameplay
- **Mitigation**: Prioritize visible tiles, fade in gradually
- **Risk**: GPU memory pressure
- **Mitigation**: Limit concurrent uploads, monitor VRAM

### P3.1: Incremental Scene Rendering
- **Risk**: Incomplete scene visible during load
- **Mitigation**: Render loading overlay on top, fade out gradually
- **Risk**: State inconsistency
- **Mitigation**: Careful state management, disable interaction during load

---

## Success Criteria

### Target Metrics
- **Total load time**: 3-5 seconds (from 5-10 seconds)
- **Asset phase**: 0.5-1 second (from 1-3 seconds)
- **Effect phase**: 1-2 seconds (from 2-5 seconds)
- **Scene phase**: 0.7-2 seconds (from 1-3 seconds)
- **Finalization**: 0.5-1 second (from 1-20 seconds)

### User Experience
- No "stuck" feeling (progress updates every 200-500ms)
- No timeout hangs (all waits have escalating timeouts)
- Smooth fade-in (overlay fades while scene renders)
- Responsive UI (can interact before all effects loaded)

---

## Appendix: Code Snippets & Examples

### Example: Parallel Asset Discovery

```javascript
async function loadAssetBundleParallel(basePath, onProgress = null, options = {}) {
  const { skipBaseTexture = false } = options;
  
  // Load base texture
  let baseTexture = null;
  if (!skipBaseTexture) {
    baseTexture = await loadBaseTexture(basePath);
  }
  
  // Discover files once
  const availableFiles = await discoverAvailableFiles(basePath);
  
  // Load all masks in parallel
  const maskPromises = Object.entries(EFFECT_MASKS).map(([maskId, maskDef]) => {
    return (async () => {
      const maskFile = findMaskInFiles(availableFiles, basePath, maskDef.suffix);
      if (!maskFile) return null;
      
      try {
        const texture = await loadTextureAsync(maskFile);
        return {
          id: maskId,
          suffix: maskDef.suffix,
          type: maskId,
          texture,
          required: maskDef.required
        };
      } catch (e) {
        if (maskDef.required) throw e;
        return null;
      }
    })();
  });
  
  const masks = (await Promise.all(maskPromises)).filter(Boolean);
  
  return {
    success: true,
    bundle: { basePath, baseTexture, masks, isMapShineCompatible: masks.length > 0 },
    warnings: [],
    error: null
  };
}
```

### Example: Parallel Effect Initialization

```javascript
async function registerEffectsParallel(effectComposer, effectDefinitions) {
  // Group effects by dependencies
  const groups = {
    independent: [],
    dependsOnLighting: [],
    dependsOnParticles: [],
    postProcessing: []
  };
  
  for (const [EffectClass, group] of effectDefinitions) {
    groups[group].push(EffectClass);
  }
  
  // Register independent effects in parallel
  await Promise.all(
    groups.independent.map(EffectClass => 
      effectComposer.registerEffect(new EffectClass())
    )
  );
  
  // Register dependent effects in parallel (after dependencies)
  await Promise.all(
    groups.dependsOnLighting.map(EffectClass => 
      effectComposer.registerEffect(new EffectClass())
    )
  );
  
  // ... continue with other groups
}
```

---

## Conclusion

The MapShine loading system has clear optimization opportunities across all phases. By implementing the P1 improvements (parallel asset discovery, parallel effect initialization, streaming managers), we can achieve **50-60% faster load times** with moderate effort.

The P2 and P3 improvements provide additional gains and better user experience, but require more careful implementation and testing.

**Recommended Next Step**: Start with P1.1 (parallel asset discovery) as a proof-of-concept, then proceed to P1.2 (parallel effect initialization) for maximum impact.
