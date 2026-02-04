# Loading System Audit: Conditional Asset Loading

## Executive Summary

**Problem**: Map Shine loads ALL supported mask textures unconditionally during scene initialization, regardless of whether:
1. The mask file actually exists for the current map
2. The effect that uses the mask is enabled
3. The scene settings require that effect

This wastes significant loading time and memory, especially on maps that don't use advanced features.

**Solution**: Implement a two-phase loading strategy:
1. **Discovery Phase**: Quick scan to determine which masks exist
2. **Conditional Loading Phase**: Only load textures for masks that are both present AND needed by enabled effects

---

## Current Architecture Analysis

### Loading Flow (Current)

```
canvasReady
  └─► createThreeCanvas()
        └─► SceneComposer.initialize()
              └─► assetLoader.loadAssetBundle()
                    ├─► discoverAvailableFiles()     ← FilePicker browse (GOOD)
                    └─► Load ALL masks in parallel    ← PROBLEM: Unconditional
        └─► Register ALL effects                      ← PROBLEM: All effects created
        └─► Wire bundles to ALL effects               ← PROBLEM: All effects wired
```

### Mask Registry (`loader.js`)

The following masks are registered and **always attempted** to load:

| Mask ID | Suffix | Used By | Performance Impact |
|---------|--------|---------|-------------------|
| `specular` | `_Specular` | SpecularEffect | Medium (PBR calculations) |
| `roughness` | `_Roughness` | SpecularEffect | Low (optional PBR) |
| `normal` | `_Normal` | SpecularEffect | Low (optional PBR) |
| `fire` | `_Fire` | FireSparksEffect | High (particle spawning) |
| `ash` | `_Ash` | AshDisturbanceEffect | Medium (particle spawning) |
| `dust` | `_Dust` | DustMotesEffect | Medium (particle spawning) |
| `outdoors` | `_Outdoors` | **8+ effects** | High (used everywhere) |
| `iridescence` | `_Iridescence` | IridescenceEffect | Medium |
| `prism` | `_Prism` | PrismEffect | Medium |
| `windows` | `_Windows` | WindowLightEffect | Low |
| `structural` | `_Structural` | WindowLightEffect, DustMotes | Low |
| `bush` | `_Bush` | BushEffect | Medium (animated) |
| `tree` | `_Tree` | TreeEffect | Medium (animated) |
| `water` | `_Water` | WaterEffectV2 | **Very High** (SDF, blur, GPU) |

### Effect → Mask Dependencies

```
SpecularEffect
  └─► specular (required)
  └─► roughness (optional, fallback generated)
  └─► normal (optional)

IridescenceEffect
  └─► iridescence (required for effect)

PrismEffect
  └─► prism (required for effect)

WindowLightEffect
  └─► windows OR structural (required for effect)
  └─► outdoors (for indoor/outdoor gating)
  └─► specular (optional, for glint)

BushEffect
  └─► bush (required for effect)

TreeEffect
  └─► tree (required for effect)

WaterEffectV2
  └─► water (required for effect)
  └─► outdoors (for indoor damping)

FireSparksEffect
  └─► fire (optional, enables mask-based spawning)
  └─► outdoors (for wind occlusion)

AshDisturbanceEffect
  └─► ash (optional, enables mask-based spawning)
  └─► outdoors (for indoor gating)

DustMotesEffect
  └─► dust (optional, enables mask-based spawning)
  └─► structural (optional, spawning zones)
  └─► outdoors (for indoor gating)

LightingEffect
  └─► outdoors (for indoor light occlusion)

CloudEffect
  └─► outdoors (for indoor cloud shadow gating)

OverheadShadowsEffect
  └─► outdoors (for indoor/outdoor shadow difference)

BuildingShadowsEffect
  └─► outdoors (for indoor/outdoor shadow difference)

WeatherParticles (Rain/Snow)
  └─► outdoors (for roof masking - via WeatherController)
```

---

## Problems Identified

### P1: Unconditional Mask Loading

**Location**: `loader.js:177-265`

```javascript
// Current: Loads ALL masks regardless of need
const maskPromises = maskEntries.map(async ([maskId, maskDef]) => {
  // ... loads texture for every mask in EFFECT_MASKS
});
```

**Impact**:
- Water mask processing is expensive (SDF generation, blur passes)
- Fire mask CPU processing for spawn points
- All textures consume GPU memory even if unused

### P2: All Effects Created Unconditionally

**Location**: `canvas-replacement.js:1391-1420`

```javascript
// Current: Creates ALL effects regardless of scene settings
const independentPromises = [
  registerIndependentEffect('Specular', SpecularEffect),
  registerIndependentEffect('Water', WaterEffectV2),
  registerIndependentEffect('Fire', FireSparksEffect),
  // ... 25+ more effects
];
```

**Impact**:
- Effect constructors allocate GPU resources (materials, render targets)
- Even disabled effects consume memory
- Initialization time includes all effects

### P3: No Early-Out for Missing Masks

Effects that absolutely require a mask (e.g., WaterEffectV2 without `_Water`) still:
1. Get created
2. Get wired to the effect composer
3. Run per-frame update() calls
4. Consume render loop time checking if they should render

### P4: Scene Settings Not Consulted During Loading

The loading system doesn't check:
- Scene-level effect enable/disable flags
- Graphics Settings player overrides
- Effect capability registry

---

## Proposed Solution: Conditional Loading

### Phase 1: Discovery (Fast)

```javascript
// NEW: Quick mask discovery without loading textures
async function discoverAvailableMasks(basePath) {
  const files = await discoverAvailableFiles(basePath);
  const available = new Set();
  
  for (const [maskId, maskDef] of Object.entries(EFFECT_MASKS)) {
    const maskFile = findMaskInFiles(files, basePath, maskDef.suffix);
    if (maskFile) available.add(maskId);
  }
  
  return available;
}
```

### Phase 2: Settings Resolution

```javascript
// NEW: Determine which effects are actually needed
function resolveRequiredMasks(availableMasks, sceneFlags, graphicsSettings) {
  const required = new Set();
  
  // Only load masks for effects that are:
  // 1. Available (mask exists)
  // 2. Enabled in scene settings
  // 3. Not disabled by player graphics settings
  
  if (availableMasks.has('specular') && 
      !graphicsSettings.isDisabled('specular')) {
    required.add('specular');
    if (availableMasks.has('roughness')) required.add('roughness');
    if (availableMasks.has('normal')) required.add('normal');
  }
  
  if (availableMasks.has('water') && 
      !graphicsSettings.isDisabled('water')) {
    required.add('water');
  }
  
  // Always load outdoors if ANY outdoor-gated effect is enabled
  const outdoorEffects = ['clouds', 'overhead-shadows', 'building-shadows', 
                          'lighting', 'fire-sparks', 'weather'];
  if (availableMasks.has('outdoors') && 
      outdoorEffects.some(e => !graphicsSettings.isDisabled(e))) {
    required.add('outdoors');
  }
  
  // ... etc
  
  return required;
}
```

### Phase 3: Conditional Loading

```javascript
// MODIFIED loadAssetBundle
async function loadAssetBundle(basePath, onProgress, options = {}) {
  const { requiredMasks = null } = options;
  
  // Step 1: Discover available files
  const availableFiles = await discoverAvailableFiles(basePath);
  
  // Step 2: Only load masks that are both available AND required
  const maskPromises = maskEntries
    .filter(([maskId]) => {
      // Skip masks not present on disk
      const maskFile = findMaskInFiles(availableFiles, basePath, EFFECT_MASKS[maskId].suffix);
      if (!maskFile) return false;
      
      // Skip masks not required by enabled effects
      if (requiredMasks && !requiredMasks.has(maskId)) {
        log.debug(`Skipping unrequired mask: ${maskId}`);
        return false;
      }
      
      return true;
    })
    .map(async ([maskId, maskDef]) => {
      // ... load texture
    });
}
```

### Phase 4: Conditional Effect Registration

```javascript
// MODIFIED createThreeCanvas
async function createThreeCanvas(scene) {
  // ... setup code ...
  
  // Discover what masks are available
  const availableMasks = await assetLoader.discoverAvailableMasks(bgPath);
  
  // Resolve what we actually need based on settings
  const requiredMasks = resolveRequiredMasks(
    availableMasks, 
    scene.flags, 
    graphicsSettings
  );
  
  // Load only required masks
  const result = await assetLoader.loadAssetBundle(bgPath, onProgress, {
    skipBaseTexture: true,
    requiredMasks
  });
  
  // Only register effects that have their required masks
  const effectsToRegister = [];
  
  if (requiredMasks.has('specular')) {
    effectsToRegister.push(['Specular', SpecularEffect]);
  }
  
  if (requiredMasks.has('water')) {
    effectsToRegister.push(['Water', WaterEffectV2]);
  }
  
  // Always register core effects
  effectsToRegister.push(['Lighting', LightingEffect]);
  effectsToRegister.push(['Fog', WorldSpaceFogEffect]);
  
  // ... register only needed effects
}
```

---

## Implementation Roadmap

### Phase A: Foundation (Low Risk)
1. Add `discoverAvailableMasks()` to loader.js
2. Add mask availability info to asset bundle result
3. No behavior changes yet - just information gathering

### Phase B: Conditional Mask Loading (Medium Risk)
1. Add `requiredMasks` option to `loadAssetBundle()`
2. Skip texture loading for unrequired masks
3. Test with various map configurations

### Phase C: Conditional Effect Registration (Higher Risk)
1. Create effect dependency registry
2. Modify `createThreeCanvas()` to consult registry
3. Only create effects that have dependencies satisfied
4. Extensive testing required

### Phase D: Graphics Settings Integration
1. Wire player graphics settings into mask resolution
2. Allow effects to be disabled before creation
3. Dynamic enable/disable (create on demand)

---

## Expected Benefits

### Loading Time Reduction

| Scenario | Current | Proposed | Savings |
|----------|---------|----------|---------|
| Simple map (no masks) | ~2.5s | ~0.8s | 68% |
| Specular only | ~2.5s | ~1.2s | 52% |
| Full map (all masks) | ~2.5s | ~2.5s | 0% |

### Memory Reduction

| Scenario | Current | Proposed | Savings |
|----------|---------|----------|---------|
| Simple map (no masks) | ~180MB | ~80MB | 55% |
| Specular only | ~180MB | ~100MB | 44% |
| Full map (all masks) | ~180MB | ~180MB | 0% |

### CPU Reduction (Per Frame)

| Scenario | Current | Proposed | Savings |
|----------|---------|----------|---------|
| Simple map | 28+ effect updates | 8 effect updates | 71% |
| Specular only | 28+ effect updates | 10 effect updates | 64% |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Effect needed after load | Medium | Low | Lazy loading on enable |
| Mask discovery fails | Low | Medium | Fallback to full load |
| Settings change mid-scene | Medium | Low | Rebuild on setting change |
| Race conditions | Low | High | Careful async handling |

---

## Files to Modify

1. **`scripts/assets/loader.js`**
   - Add `discoverAvailableMasks()`
   - Add `requiredMasks` option to `loadAssetBundle()`
   - Skip loading for unrequired masks

2. **`scripts/scene/composer.js`**
   - Pass discovered masks to loading
   - Store mask availability info

3. **`scripts/foundry/canvas-replacement.js`**
   - Consult mask availability before effect creation
   - Create effect dependency registry
   - Only register needed effects

4. **`scripts/effects/effect-capabilities-registry.js`**
   - Add mask dependency declarations
   - Add `getMaskDependencies(effectId)` method

5. **NEW: `scripts/core/loading-strategy.js`**
   - Centralize loading decisions
   - Integrate scene settings + graphics settings + mask availability

---

## Testing Checklist

- [ ] Map with no masks loads faster
- [ ] Map with only `_Specular` doesn't load water
- [ ] Map with only `_Water` doesn't load specular
- [ ] All masks present still works
- [ ] Effect enabled mid-scene triggers lazy load
- [ ] Graphics settings disable prevents loading
- [ ] Cache invalidation works correctly
- [ ] No regressions on premium maps with composites

---

## Appendix: Current Mask Load Times (Estimated)

| Mask | Typical Size | Load Time | Processing |
|------|-------------|-----------|------------|
| specular | 2-4MB | ~50ms | Minimal |
| roughness | 2-4MB | ~50ms | Minimal |
| normal | 2-4MB | ~50ms | Minimal |
| fire | 1-2MB | ~30ms + 200ms CPU | Point extraction |
| ash | 1-2MB | ~30ms + 100ms CPU | Point extraction |
| dust | 1-2MB | ~30ms + 100ms CPU | Point extraction |
| outdoors | 2-4MB | ~50ms | Minimal |
| iridescence | 1-2MB | ~30ms | Minimal |
| prism | 1-2MB | ~30ms | Minimal |
| windows | 1-2MB | ~30ms | Minimal |
| structural | 1-2MB | ~30ms | Minimal |
| bush | 2-4MB | ~50ms | Minimal |
| tree | 2-4MB | ~50ms | Minimal |
| water | 2-4MB | ~50ms + **500ms GPU** | SDF, blur passes |

**Total worst case**: 15 masks × ~50ms = 750ms + 900ms processing = **~1.7s just for masks**
