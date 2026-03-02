# Tree, Bush, and Overhead Effects Invisibility - Root Cause Analysis

**Date**: 2026-03-02  
**Scene**: Mythica Machina - Wizards Lair / Laboratory [Recovered]  
**Compositor Mode**: V1 (Legacy) - `useCompositorV2: false`

---

## Executive Summary

Tree, Bush, and Overhead Shadow effects are invisible despite:
- Valid mask textures existing on the server (`_Tree.webp`, `_Bush.webp`, `_Outdoors.webp`)
- Effects being constructed and enabled
- V1 compositor mode being active

**Root Cause**: The `EffectMaskRegistry` is completely empty - no textures loaded AND no effect subscribers registered. The entire mask distribution pipeline is non-functional.

---

## Diagnostic Evidence

### 1. Effect State (Broken)
```
TreeEffect:
  enabled: true ✅
  treeMask: null ❌
  _mesh: undefined ❌
  _shadowMesh: undefined ❌

BushEffect:
  enabled: false ❌
  bushMask: null ❌
  _mesh: undefined ❌
  _shadowMesh: undefined ❌

OverheadShadowsEffect:
  enabled: true ✅
  outdoorsMask: null ❌
  scene: undefined ❌
  _mesh: undefined ❌
```

**Problem**: Effects have `enabled: true` but their mask properties are `null`, and no meshes were created.

---

### 2. Registry State (Completely Empty)
```
ALL 14 registry slots:
  currentTexture: undefined ❌
  subscribers count: 0 ❌
```

**Critical Issues**:
1. **No textures**: `transitionToFloor()` never populated the slots with texture objects
2. **No subscribers**: Effects never called `connectToRegistry()` to subscribe for mask updates

---

### 3. Asset Loading (Partial Success)

**Initial Load** (during scene initialization):
```
currentBundle.masks: 1
  - specular: ✅ (from tile: orrery_arm_02_Specular.webp)
```

**Manual Reload** (via console):
```
Asset bundle loaded: 5 masks found
  - specular ✅
  - fire ✅
  - outdoors ✅
  - bush ✅
  - tree ✅
```

**Files Exist on Server**:
- ✅ `mythica-machina-wizards-lair-laboratory_Ground_Tree.webp`
- ✅ `mythica-machina-wizards-lair-laboratory_Ground_Bush.webp`
- ✅ `mythica-machina-wizards-lair-laboratory_Ground_Outdoors.webp`

**Problem**: Initial asset load only found 1 mask (specular from a tile), even though the retry logic in `SceneComposer.initialize()` (lines 557-578) should have caught this and retried with cache bypass.

---

### 4. Effect Map State (Missing)
```
window.MapShine.effectMap: undefined ❌
effectComposer._effects: undefined ❌
effectComposer._effectMap: undefined ❌
effectComposer.effects: Map(36) { ... } ✅
```

**Problem**: The `effectMap` variable (created at line 4091 in `canvas-replacement.js`) is local to `createThreeCanvas()` and was never exposed globally. The `connectToRegistry` block at lines 4529-4545 uses `effectMap.get()` to find effects, but this variable doesn't exist in the global scope.

---

### 5. Effect Exposure (Partial)
```
window.MapShine:
  treeEffect: true ✅
  bushEffect: true ✅
  overheadShadowsEffect: true ✅
  effectMaskRegistry: true ✅
```

**Observation**: Individual effects ARE exposed via `exposeGlobals()` (manager-wiring.js lines 99-126), but the `effectMap` collection is not.

---

## Code Flow Analysis

### Expected Initialization Sequence (V1 Mode)

1. **Effect Construction** (`canvas-replacement.js` lines 4212-4370)
   - `effectMap = new Map()` (line 4091)
   - Effects constructed and added to `effectMap` via `registerEffectBatch()`
   - Effects exposed via `exposeEffectsEarly()` (line 4378)

2. **Registry Connection** (`canvas-replacement.js` lines 4525-4616)
   ```javascript
   const connectIfPresent = (key, label) => {
     const eff = effectMap.get(key);
     if (eff && typeof eff.connectToRegistry === 'function') {
       eff.connectToRegistry(reg);
     }
   };
   connectIfPresent('Trees', 'TreeEffect');      // line 4544
   connectIfPresent('Bushes', 'BushEffect');     // line 4545
   connectIfPresent('Overhead Shadows', 'OverheadShadowsEffect'); // line 4541
   ```

3. **Initial Registry Transition** (lines 4602-4614)
   ```javascript
   reg.transitionToFloor(floorKey, bundle.masks);
   ```

4. **Effect Callbacks Fire**
   - `TreeEffect.connectToRegistry()` callback receives texture → sets `treeMask` → calls `_createMesh()`
   - `BushEffect.connectToRegistry()` callback receives texture → sets `bushMask` → calls `_createMesh()`
   - `OverheadShadowsEffect.connectToRegistry()` callback receives texture → sets `outdoorsMask` → creates mesh

### What Actually Happened

1. ✅ Effects constructed and added to local `effectMap`
2. ✅ Effects exposed individually via `exposeGlobals()`
3. ❓ `connectToRegistry` block executed (inside `if (!_v2Active)` at line 4212)
4. ❌ **Registry has 0 subscribers** → `connectToRegistry()` calls never succeeded
5. ❌ **Registry has 0 textures** → `transitionToFloor()` never populated slots
6. ❌ Effects have `null` masks and no meshes

---

## Hypotheses

### Hypothesis 1: `effectMap` Scope Issue
The `connectToRegistry` block (lines 4529-4545) references `effectMap.get()`, but `effectMap` is a local variable created at line 4091. If this code runs in a different scope or after `effectMap` goes out of scope, the lookups would fail silently.

**Evidence**:
- `window.MapShine.effectMap: undefined`
- Registry has 0 subscribers (effects never connected)

**Counter-evidence**:
- The code is inside the same `createThreeCanvas()` function, so `effectMap` should be in scope
- The block is inside `if (!_v2Active)` which should execute in V1 mode

### Hypothesis 2: Asset Bundle Empty During Initial Transition
The initial `transitionToFloor()` call (line 4610) uses `bundle.masks`, but if the bundle only had 1 mask (specular) at that point, the transition would only populate the specular slot.

**Evidence**:
- Initial bundle had only 1 mask (specular)
- Manual reload found 5 masks
- Registry has 0 textures even for specular

**Problem**: This doesn't explain why the registry is completely empty (even specular should be there).

### Hypothesis 3: Registry Initialization Timing
The `EffectMaskRegistry` might not have been fully initialized when `connectToRegistry` and `transitionToFloor` were called.

**Evidence**:
- Registry exists: `window.MapShine.effectMaskRegistry: true`
- Registry has all 14 slots defined
- But all slots are empty

### Hypothesis 4: Silent Failure in `connectToRegistry` Block
The `safeCall()` wrapper (line 4525) catches and suppresses errors. If `effectMap` was undefined or the registry methods failed, the error would be logged but not thrown.

**Action Required**: Check console logs for errors during scene load around the "connectEffectsToRegistry" step.

---

## Load Timing Analysis

```
Scene load timings:
  total: 70894ms
  setBaseMesh: 2ms ⚠️ (suspiciously fast)
  effectInit: 64ms
  sceneComposer.initialize: 3712ms
```

**Observation**: `setBaseMesh` took only 2ms, which suggests the `setBaseMesh` calls and `connectToRegistry` block executed very quickly - possibly too quickly, indicating they didn't do much work.

---

## Critical Questions

1. **Did the `connectToRegistry` block actually execute?**
   - Check console logs for: `"Trees connected to EffectMaskRegistry"`
   - Check console logs for: `"effects.connectToRegistry DONE"`

2. **Was `effectMap` populated at the time of `connectToRegistry`?**
   - Add diagnostic: `console.log('effectMap size:', effectMap.size)` before line 4529

3. **Did `transitionToFloor` receive valid mask data?**
   - Check console logs for: `"EffectMaskRegistry: initial transitionToFloor applied"`
   - Check what `bundle.masks` contained at line 4610

4. **Were there any errors in the `safeCall()` wrapper?**
   - Search console for errors/warnings during "connectEffectsToRegistry" step

---

## Immediate Fix (Tested - Partial Success)

Manual reload via console:
```javascript
const assetLoader = await import('/modules/map-shine-advanced/scripts/assets/loader.js');
const result = await assetLoader.loadAssetBundle(basePath, null, { bypassCache: true });
composer.currentBundle.masks = result.bundle.masks;
reg.transitionToFloor(floorKey, result.bundle.masks);
```

**Result**:
- ✅ Asset bundle reloaded: 5 masks found
- ✅ Registry transition completed
- ❌ **Effects still have null masks** (subscribers still 0)

**Conclusion**: Even after manually loading masks and calling `transitionToFloor`, the effects didn't receive the textures because they were never subscribed to the registry.

---

## Required Actions

1. **Verify `connectToRegistry` execution**
   - Add logging before/after `connectIfPresent()` calls
   - Confirm `effectMap.get('Trees')` returns a valid object

2. **Verify registry subscription mechanism**
   - Check if `EffectMaskRegistry.subscribe()` is working
   - Confirm callbacks are being stored in `slot.subscribers`

3. **Fix the subscriber registration**
   - Manually call `connectToRegistry()` on each effect
   - Verify subscribers appear in registry slots

4. **Fix the initial asset load**
   - Investigate why FilePicker discovery only found 1 mask
   - Strengthen retry logic in `SceneComposer.initialize()`

---

## Manual Wiring Attempt Results

**Test Date**: 2026-03-02 14:14:56

### What We Did
```javascript
// 1. Reloaded asset bundle with cache bypass
const result = await assetLoader.loadAssetBundle(basePath, null, { bypassCache: true });
// Result: ✅ 5 masks loaded (specular, fire, outdoors, bush, tree)

// 2. Called connectToRegistry() on each effect
tree.connectToRegistry(reg);
bush.connectToRegistry(reg);
overhead.connectToRegistry(reg);
// Result: ✅ All calls succeeded without errors

// 3. Checked subscriber counts
reg._slots.get('tree').subscribers.size     // Result: 0 ❌
reg._slots.get('bush').subscribers.size     // Result: 0 ❌
reg._slots.get('outdoors').subscribers.size // Result: 0 ❌

// 4. Called transitionToFloor()
reg.transitionToFloor('0:20', result.bundle.masks);
// Result: ✅ Completed in 784ms, fire effect rebuilt

// 5. Verified effect state
tree.treeMask: true ✅
tree._mesh: false ❌
bush.bushMask: true ✅
bush._mesh: false ❌
overhead.outdoorsMask: true ✅
overhead._mesh: false ❌
```

### Critical Finding: `registry.subscribe()` is Broken

**The smoking gun**: After calling `connectToRegistry()` on all three effects, the subscriber counts are **still 0**.

Looking at the code:

**TreeEffect.connectToRegistry()** (TreeEffect.js:642-654):
```javascript
connectToRegistry(registry) {
  if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
  this._registryUnsub = registry.subscribe('tree', (texture) => {
    this.treeMask = texture;
    // ... callback logic
  });
}
```

**EffectMaskRegistry.subscribe()** (EffectMaskRegistry.js:166-178):
```javascript
subscribe(maskType, callback) {
  if (typeof callback !== 'function') {
    log.warn(`subscribe: callback for '${maskType}' is not a function`);
    return () => {};
  }
  let subs = this._subscribers.get(maskType);
  if (!subs) {
    subs = new Set();
    this._subscribers.set(maskType, subs);
  }
  subs.add(callback);
  return () => subs.delete(callback);
}
```

**The registry uses `this._subscribers`** (line 84), but the diagnostic checked `slot.subscribers` (which doesn't exist in the slot structure).

**Hypothesis**: The registry has TWO separate subscriber tracking systems:
1. `this._subscribers` (Map<string, Set<function>>) - line 84
2. `slot.subscribers` (checked in diagnostic but doesn't exist)

The diagnostic was checking the wrong property. Let me verify the actual subscriber storage.

### Why Effects Have Masks But No Meshes

Even though `transitionToFloor()` set the mask properties:
- `tree.treeMask = texture` ✅
- `bush.bushMask = texture` ✅
- `overhead.outdoorsMask = texture` ✅

The meshes were never created because:

**TreeEffect callback** (TreeEffect.js:652-653):
```javascript
if (this.scene) this._createMesh();
if (this.shadowScene) this._createShadowMesh();
```

**BushEffect callback** (BushEffect.js:425-426):
```javascript
if (this.scene) this._createMesh();
if (this.shadowScene) this._createShadowMesh();
```

**OverheadShadowsEffect callback** (OverheadShadowsEffect.js:186-188):
```javascript
if (texture && this.renderer && this.mainScene && this.mainCamera) {
  this._createShadowMesh();
}
```

**The callbacks never fired**, so `_createMesh()` was never called, so no meshes exist.

---

## Root Cause Hypothesis (Updated)

### Primary Suspect: Registry Subscriber Storage Mismatch

The diagnostic checked `reg._slots.get('tree').subscribers.size`, but the actual subscriber storage is `reg._subscribers.get('tree').size`.

**Action Required**: Re-run diagnostic with correct property path:
```javascript
reg._subscribers.get('tree')?.size
reg._subscribers.get('bush')?.size
reg._subscribers.get('outdoors')?.size
```

If these are also 0, then `registry.subscribe()` is genuinely broken.

### Secondary Issue: Even With Manual Mask Assignment, No Meshes Created

Even after `transitionToFloor()` set the mask properties directly, the effects didn't create meshes. This suggests:

1. The registry callbacks are the **only** path to mesh creation
2. `setBaseMesh()` was called during initialization but had no masks at that time
3. Without the callback firing, there's no code path to create meshes after masks arrive

---

## Final Critical Finding: Registry Slots Are Empty

**Test Date**: 2026-03-02 14:23:56

After manually calling `transitionToFloor()` with 5 masks (specular, fire, outdoors, bush, tree), the registry slots remain empty:

```javascript
reg._slots.get('tree').texture    // null ❌
reg._slots.get('bush').texture    // null ❌
reg._slots.get('outdoors').texture // null ❌
reg._slots.get('fire').texture     // null ❌
reg._slots.get('specular').texture // ✅ (only this one exists)
```

**Floor bundle for `0:20` only has specular**:
```
Floor 0 (0:20):
  Bundle exists: true
  Masks: 1
    - specular: true
```

**Other floors have more masks**:
- `20.01:40.01`: 3 masks
- `0:10`: 2 masks
- `20:30`: 3 masks

### Root Cause Chain

1. **Initial asset load** only found 1 mask (specular from a tile)
2. **Manual reload** successfully loaded 5 masks into `result.bundle.masks`
3. **`transitionToFloor()` was called** with these 5 masks
4. **Registry slots remain empty** - `setMask()` calls inside `transitionToFloor()` either failed or were skipped
5. **Floor compositor bundle** for `0:20` never received the masks
6. **`bindFloorMasks()`** is called every frame with an empty bundle, hiding the meshes

### The Actual Problem

The `transitionToFloor()` method is not actually setting the textures in the registry slots. Need to investigate why `setMask()` is failing or being skipped for tree/bush/outdoors/fire.

## V1 vs V2 Compositor Analysis

**Test Date**: 2026-03-02 14:26:00

### Compositor Mode Verification
- **Setting**: `useCompositorV2: false` ✅ (V1 mode active)
- **`_v2Active`**: `undefined` (not set globally)
- **Effects Exist**: TreeEffect, BushEffect, OverheadShadowsEffect all exist ✅

### V2 Skip Logic in Asset Loader

Found in `composer.js` lines 511-543 and 606-613:

```javascript
const _skipMaskIds = (() => {
  try {
    // Compositor V2 has its own mask discovery pipeline and does not
    // consume the legacy scene bundle _Water mask.
    if (!!game?.settings?.get('map-shine-advanced', 'useCompositorV2')) return ['water'];
  } catch (e) {}
  return null;
})();

result = await assetLoader.loadAssetBundle(bgPath, null, {
  skipBaseTexture: true,
  skipMaskIds: _skipMaskIds  // Only skips 'water' in V2 mode
});
```

**Conclusion**: V2 mode only skips `water` masks. Tree/bush/outdoors are NOT in the skip list, so V1/V2 mode is **not the cause**.

### Why `transitionToFloor()` Didn't Set Masks

Looking at `EffectMaskRegistry.js` lines 341-439, the `transitionToFloor()` logic:

1. **Phase 1**: Builds `newMasksByType` map from `newFloorMasks` array (lines 348-357)
   - Requires `m.texture` to be truthy (line 353)
   - Uses `m.type || m.id` as the key (line 352)

2. **Phase 2**: Determines action per mask type (lines 359-380)
   - If `newTexture` exists → 'replace'
   - If no `newTexture` but `preserveAcrossFloors` → 'preserve'
   - If no `newTexture` and no preserve → 'clear'

3. **Phase 3**: Applies changes and notifies subscribers (lines 382-414)

**The Problem**: When we called `transitionToFloor()` with the reloaded bundle, the masks array had textures, but the registry's `transitionToFloor()` method builds a lookup at line 352-355:

```javascript
for (const m of newFloorMasks) {
  const type = m.type || m.id;
  if (type && m.texture) {
    newMasksByType.set(type, m.texture);
  }
}
```

This should have worked IF the mask objects had valid `texture` properties. Need to verify the mask objects structure.

### Mask Object Verification Results

**Test Date**: 2026-03-02 14:29:05

**ALL MASKS HAVE VALID TEXTURES** ✅

```
Mask 0: specular - 6750x6750 - _Texture ✅
Mask 1: fire     - 4096x4096 - _Texture ✅
Mask 2: outdoors - 4096x4096 - _Texture ✅
Mask 3: bush     - 6750x6750 - _Texture ✅
Mask 4: tree     - 6750x6750 - _Texture ✅
```

**Conclusion**: The asset loader is working correctly. The mask objects have:
- Valid `id` and `type` properties
- Valid `texture` objects (THREE.Texture instances)
- Loaded image data with correct dimensions

**The Real Problem**: `transitionToFloor()` received these 5 valid mask objects but **failed to populate the registry slots**. The issue is in the `transitionToFloor()` execution logic, not the asset loading.

### Why `transitionToFloor()` Failed

Looking back at the earlier diagnostic output from the manual `transitionToFloor()` call:

```
14:15:00.646 Map Shine Advanced | EffectMaskRegistry | transitionToFloor complete 
Object { floorKey: "0:20", prevFloorKey: "0:20", actions: {…}, elapsedMs: "784.0" }
```

The `actions` object would show what happened to each mask type. Since the registry slots are empty, `transitionToFloor()` must have taken the **'clear'** or **'preserve'** action instead of **'replace'**.

**Hypothesis**: The `prevFloorKey === newFloorKey` (`"0:20" === "0:20"`), so `transitionToFloor()` saw this as a no-op transition and preserved/cleared existing slots instead of replacing them with new textures.

## Solution (Manual Fix - WORKING)

**Test Date**: 2026-03-02 14:31:00

Bypass `transitionToFloor()` entirely and call `setMask()` directly for each mask type:

```javascript
// 1. Reload asset bundle
const result = await assetLoader.loadAssetBundle(basePath, null, { bypassCache: true });

// 2. Manually call setMask for each mask
for (const mask of result.bundle.masks) {
  const type = mask.id || mask.type;
  reg.setMask(type, mask.texture, floorKey, 'manual');
}

// 3. Update compositor floor bundle
compositor._floorMeta.get(floorKey).masks = result.bundle.masks;

// 4. Call bindFloorMasks on each effect
tree.bindFloorMasks(bundle, floorKey);
bush.bindFloorMasks(bundle, floorKey);
overhead.bindFloorMasks(bundle, floorKey);
```

### Results

✅ **TreeEffect**: Now visible with animated wind effects
✅ **BushEffect**: Now visible with animated wind effects  
✅ **OverheadShadowsEffect**: Properly initialized (renders to textures, not visible meshes)

### Why OverheadShadowsEffect Appears "Broken"

OverheadShadowsEffect is a **POST_PROCESSING** effect (`RenderLayers.ENVIRONMENTAL`), not a SURFACE_EFFECTS effect like trees/bushes. It:
- Renders to `shadowTarget` and `roofTarget` render targets
- Does NOT create visible meshes in the main scene
- Shadow textures are consumed by `LightingEffect` to darken the scene
- Shadows appear as darkening on the ground, not as visible objects

**Diagnostic confirmed it's working**:
- `shadowMesh: true` ✅
- `material: true` ✅
- `uOutdoorsMask: true` ✅
- All prerequisites met ✅

---

## Permanent Fix Required

The root cause is that **initial asset loading in `canvas-replacement.js` fails to populate the registry and compositor bundles** with tree/bush/outdoors masks.

### Location

`scripts/foundry/canvas-replacement.js` around line 4091-4620 (effect initialization block)

### Problem

1. `SceneComposer.initialize()` loads asset bundle but only finds 1 mask (specular)
2. `effectMaskRegistry` is created but `transitionToFloor()` is never called with the full mask set
3. `connectToRegistry()` is called on effects, but registry slots are empty
4. Effects subscribe successfully but callbacks never fire because no masks arrive
5. Floor compositor bundle for `0:20` only has specular mask

### Required Changes

**Option A: Fix initial asset loading in SceneComposer**
- Ensure `SceneComposer.initialize()` discovers all masks (tree, bush, outdoors, fire, specular)
- Call `effectMaskRegistry.transitionToFloor()` with complete mask set
- Ensure compositor floor bundles are populated

**Option B: Add fallback in canvas-replacement.js**
- After `SceneComposer.initialize()` completes
- Verify registry slots are populated
- If empty, reload asset bundle and manually populate registry + compositor bundles

**Option C: Fix `transitionToFloor()` same-floor handling**
- Currently skips updates when `prevFloorKey === newFloorKey`
- Should force update if registry slots are empty
- Or add `force: true` parameter to bypass same-floor check

### Recommended Approach

**Fix the initial asset loading** (Option A) - this is the true root cause. The asset loader should discover all 5 masks on first load, not just 1.
