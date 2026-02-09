# Light Cookie Reset Issue (Foundry Refresh)

## Summary
When a light has a configured cookie (gobo) with custom settings, refreshing Foundry VTT causes the light to revert to a different visual state. The cookie may still be marked as enabled, but the rendered result does not match the previously authored look. The cookie only appears correctly again after a manual tweak (e.g., adjusting cookie strength).

## Expected Behavior
- A light with a configured cookie should render identically after a Foundry VTT refresh.
- Cookie texture, strength, contrast, gamma, rotation, scale, tint, invert, and colorize settings should persist and be applied without any user interaction.

## Actual Behavior
- After a refresh, the cookie is not visible or appears reset to a default/incorrect state.
- The light renders with a different look than what was saved.
- The cookie effect typically “wakes up” only after changing a cookie parameter (like strength), indicating that the config is not being applied at startup or is being overwritten after initial application.

## Reproduction Steps
1. Create or select an Ambient Light.
2. Enable a cookie texture and set an obvious/high-contrast configuration (e.g., high strength/contrast).
3. Verify the cookie looks correct.
4. Refresh Foundry VTT (F5 or reload client).
5. Observe that the light no longer matches the saved cookie look.
6. Adjust cookie strength slightly.
7. Observe the cookie instantly reappears or returns to the correct look.

## Observations
- The issue is consistent and has been present for a long time.
- The cookie is often still marked enabled, but uniforms/textures don’t seem fully applied.
- A manual update triggers correct rendering, suggesting missing or clobbered state during startup.

## Likely Root Causes (Hypotheses)
- **Startup race:** Light renderables are built before Foundry lighting placeables are fully available.
- **Enhancement application timing:** Cookie enhancements may be applied before the enhancement store finishes loading or before lighting placeables are ready.
- **Post-startup rebuild:** A later lighting refresh/LOS rebuild might recreate the mesh/material and drop the cookie uniforms/textures.

## Current Mitigations Attempted
- Added a resilient `syncAllLights()` with fallback to scene documents and retry/backoff.
- Added forced render after sync to ensure changes become visible.
- Added cookie texture retry/backoff inside `ThreeLightSource`.

These mitigations did not eliminate the reset issue in practice.

## Impact
- Users cannot rely on light cookies retaining their authored look after refresh.
- Lights appear “broken” until manually adjusted, reducing usability and confidence.

## Next Investigation Targets
- Verify whether `ThreeLightSource` materials are rebuilt after cookie load and lose uniforms.
- Instrument the startup sequence to detect when cookie config is applied vs. overwritten.
- Force a cookie re-apply after any geometry/material rebuild (e.g., on lightingRefresh).
- Trace if enhancement config is being overwritten by stale defaults from Foundry light docs.

---

## Investigation Findings

### Finding 1: `onLightingRefresh` Uses Stale Document

**Location**: `LightingEffect.js:1645-1662`

```javascript
onLightingRefresh() {
  for (const [id, source] of this.lights) {
    if (source && source.document) {
      source.updateData(source.document, true);  // <-- Uses source.document directly!
    }
  }
}
```

**Issue**: `onLightingRefresh()` calls `source.updateData(source.document, true)` using the document stored on the `ThreeLightSource` instance. However, this document may be stale if:
1. The Foundry `updateAmbientLight` hook fired and passed a raw document without enhancements
2. The enhancement store wasn't loaded when the document was first stored

**Why this matters**: The `lightingRefresh` hook fires during Foundry startup after LOS computation completes. If the document stored on `source` doesn't have cookie enhancements merged, the rebuild will use default/missing cookie values.

**Contrast with `onLightUpdate`**: The `onLightUpdate()` method correctly applies enhancements via `_applyFoundryEnhancements()` before calling `updateData()`:
```javascript
onLightUpdate(doc, changes) {
  const mergedDoc = this._mergeLightDocChanges(doc, changes);
  const targetDoc = this._applyFoundryEnhancements(mergedDoc);  // <-- Enhancements applied
  // ...
  src.updateData(targetDoc);  // <-- Enhanced doc used
}
```

**Proposed Fix**: `onLightingRefresh()` should re-apply enhancements before updating:
```javascript
onLightingRefresh() {
  for (const [id, source] of this.lights) {
    if (source && source.document) {
      const enhancedDoc = this._applyFoundryEnhancements(source.document);
      source.updateData(enhancedDoc, true);
    }
  }
}
```

---

### Finding 2: Critical Initialization Order Race Condition

**Location**: `canvas-replacement.js:1658-1659` vs `canvas-replacement.js:2157-2170`

**Sequence of Events**:
```
Line 1658: lightingEffect = new LightingEffect();
Line 1659: await effectComposer.registerEffect(lightingEffect);
           ↳ Calls lightingEffect.initialize()
           ↳ Calls syncAllLights()
           ↳ For each light, calls _applyFoundryEnhancements()
           ↳ _applyFoundryEnhancements() tries to read window.MapShine.lightEnhancementStore
           ↳ BUT: lightEnhancementStore DOES NOT EXIST YET!

... ~500 lines of other initialization ...

Line 2157: mapShine.lightEnhancementStore = new LightEnhancementStore();
Line 2158: loadPromise = mapShine.lightEnhancementStore.load();
Line 2164-2168: loadPromise.then(() => lightingEffect.syncAllLights());  // <-- Resync attempt
```

**Issue**: The `LightEnhancementStore` is created ~500 lines AFTER `LightingEffect.initialize()` runs. This means:
1. First `syncAllLights()` call has NO enhancement store → cookies NOT applied
2. `_applyFoundryEnhancements()` returns doc unchanged (store is null)
3. Lights render without cookies
4. Later resync (line 2164-2168) attempts to fix this, but...

**Why the resync doesn't fully work**: The resync calls `syncAllLights()` which:
1. Disposes all existing lights (line 1343-1351)
2. Recreates them with enhancements

However, Foundry's `lightingRefresh` hook can fire AFTER this resync, and `onLightingRefresh()` uses `source.document` which may be stale (see Finding 1).

**Root Cause Chain**:
```
1. LightingEffect.initialize() → syncAllLights() [NO STORE YET]
2. Lights created WITHOUT cookie enhancements
3. LightEnhancementStore.load() completes → syncAllLights() [STORE EXISTS]
4. Lights recreated WITH cookie enhancements ✓
5. Foundry lightingRefresh hook fires → onLightingRefresh()
6. onLightingRefresh() calls source.updateData(source.document, true)
7. source.document might be the OLD doc without enhancements
8. Cookies disappear again ✗
```

**Proposed Fix Options**:
1. **Move LightEnhancementStore creation before LightingEffect registration**
2. **Make LightingEffect.initialize() await the enhancement store load**
3. **Always re-fetch enhancements in onLightingRefresh (see Finding 1 fix)**

---

### Finding 3: Multiple Code Paths Use `source.document` Without Enhancements

**Affected Code Paths**:

| Location | Code | Issue |
|----------|------|-------|
| `LightingEffect.js:1650` | `source.updateData(source.document, true)` | `onLightingRefresh()` |
| `LightingEffect.js:1657` | `source.updateData(source.document, true)` | `onLightingRefresh()` (MapShine lights) |
| `ThreeLightSource.js:1562` | `this.updateData(this.document, true)` | Wall inset recalculation |
| `ThreeLightSource.js:1793` | `this.updateData(this.document, true)` | LOS polygon upgrade |

**Why this causes cookie reset**:

In `_updateCookieFromConfig()` (ThreeLightSource.js:885-895):
```javascript
if (!path) {
  // If no cookieTexture in config, CLEAR the cookie!
  this._cookiePath = null;
  this._cookieTexture = null;
  u.tCookie.value = null;
  u.uHasCookie.value = 0.0;  // <-- Cookie disabled!
  return;
}
```

If `source.document` doesn't have `config.cookieTexture` (because enhancements weren't merged), the cookie gets actively cleared - not just "not applied", but **deleted**.

**The Reset Mechanism**:
1. Light is created with cookie enhancements via `onLightUpdate()` ✓
2. Cookie texture loads successfully ✓
3. `lightingRefresh` hook fires
4. `onLightingRefresh()` calls `source.updateData(source.document, true)`
5. `source.document` doesn't have `cookieTexture` (stale doc)
6. `_updateCookieFromConfig()` sees no cookie path → clears cookie ✗

**Key Insight**: The cookie isn't "not being applied" - it's being **actively cleared** because the stale document has no cookie config.

---

### Finding 4: `_applyFoundryEnhancements` Fallback May Fail During Early Startup

**Location**: `LightingEffect.js:1428-1442`

```javascript
_applyFoundryEnhancements(doc) {
  const store = window.MapShine?.lightEnhancementStore;
  const enhancement = store?.getCached?.(doc.id);
  let config = enhancement?.config;

  // Fallback to scene flags if store not ready
  if (!config || typeof config !== 'object') {
    config = this._getFoundryEnhancementConfigFallback(doc.id);
  }

  if (!config || typeof config !== 'object') return doc;  // <-- Returns unchanged doc!
  // ...
}
```

**The fallback `_getFoundryEnhancementConfigFallback`** (line 191-227) reads directly from `canvas.scene.getFlag()` or `canvas.scene.flags`.

**Potential failure points**:
1. `canvas?.scene` may be null/undefined during very early initialization
2. `scene.getFlag()` may throw if scene not fully initialized
3. `scene.flags['map-shine-advanced']` may not be materialized yet

If both the store AND the fallback fail, `_applyFoundryEnhancements()` returns the document **unchanged** - without cookie config.

---

### Finding 5: Startup Sequence Timeline Analysis

**Reconstructed startup sequence**:

```
T0: createThreeCanvas() starts
T1: LightingEffect created and registered
    ↳ initialize() called
    ↳ syncAllLights() called
    ↳ window.MapShine.lightEnhancementStore = undefined (NOT CREATED YET)
    ↳ canvas.scene MAY be available (depends on Foundry startup)
    ↳ _applyFoundryEnhancements() tries store → fails
    ↳ _applyFoundryEnhancements() tries fallback → MAY fail if scene not ready
    ↳ Lights created WITHOUT cookie enhancements

T2: ... more effects registered ...

T3: LightEnhancementStore created and load() called
    ↳ loadPromise.then(() => lightingEffect.syncAllLights())
    ↳ This resync SHOULD fix cookies IF:
       - It runs before any lightingRefresh
       - AND no other code path overwrites source.document

T4: Foundry lightingRefresh hook fires (can happen multiple times)
    ↳ onLightingRefresh() uses source.document
    ↳ If T4 < T3: source.document has NO enhancements → cookie cleared
    ↳ If T4 > T3: source.document SHOULD have enhancements (unless other issue)

T5: User sees the scene
```

**Critical Race Window**: Between T1 and T3+resync, any `lightingRefresh` will use stale documents.

---

### Finding 6: `syncAllLights()` Disposes and Recreates, But Timing is Async

**Location**: `LightingEffect.js:1343-1372`

```javascript
syncAllLights() {
  // ...
  this.lights.forEach(l => l.dispose());
  this.lights.clear();
  // ...
  canvas.lighting.placeables.forEach(p => this.onLightUpdate(p.document));
}
```

The resync after enhancement store load (T3) **disposes all lights and recreates them**. This should work, BUT:

1. The resync is triggered via `.then()` - it's async
2. Foundry's `lightingRefresh` hook can fire during this async gap
3. If `lightingRefresh` fires DURING the resync (after some lights disposed but before all recreated), state can be inconsistent

---

## Root Cause Summary

The cookie reset is caused by a **multi-factor timing issue**:

1. **Initialization Order Bug**: `LightEnhancementStore` is created ~500 lines AFTER `LightingEffect.initialize()` runs, so the first sync has no enhancements.

2. **Stale Document Usage**: `onLightingRefresh()` and internal ThreeLightSource methods use `source.document` directly without re-applying enhancements.

3. **Active Cookie Clearing**: `_updateCookieFromConfig()` actively clears cookie state when `cookieTexture` is missing from config (not just "doesn't apply" but "deletes").

4. **Async Resync Race**: The post-load resync is async (`.then()`), allowing Foundry hooks to fire during the gap.

---

## Recommended Fixes

### Fix A: Move Enhancement Store Creation Before LightingEffect (PREFERRED)

In `canvas-replacement.js`, move lines 2155-2174 to BEFORE line 1658:

```javascript
// BEFORE creating LightingEffect:
mapShine.lightEnhancementStore = new LightEnhancementStore();
await mapShine.lightEnhancementStore.load();

// THEN create LightingEffect:
lightingEffect = new LightingEffect();
await effectComposer.registerEffect(lightingEffect);
```

**Pros**: Simplest fix, eliminates race condition entirely.
**Cons**: Adds slight startup delay.

### Fix B: Always Re-Apply Enhancements in `onLightingRefresh()`

```javascript
onLightingRefresh() {
  for (const [id, source] of this.lights) {
    if (source && source.document) {
      const enhancedDoc = this._applyFoundryEnhancements(source.document);
      source.updateData(enhancedDoc, true);
    }
  }
  // ... same for mapshineLights
}
```

**Pros**: Defensive fix, handles any stale document scenario.
**Cons**: Slightly more overhead per refresh.

### Fix C: Preserve Cookie State in `_updateCookieFromConfig()`

Add logic to preserve existing cookie if config doesn't explicitly disable it:

```javascript
_updateCookieFromConfig(config) {
  // If config has no cookie info but we already have a loaded cookie,
  // preserve it (don't clear)
  const hasConfigCookie = (typeof config?.cookieTexture === 'string' && config.cookieTexture.trim());
  const explicitlyDisabled = config?.cookieEnabled === false;
  
  if (!hasConfigCookie && !explicitlyDisabled && this._cookieTexture) {
    // Preserve existing cookie - don't clear
    return;
  }
  // ... rest of method
}
```

**Pros**: Most defensive, preserves cookies through any stale-doc scenario.
**Cons**: Could mask other bugs, makes cookie state less predictable.

### Recommended Implementation Order

1. **Fix A** - Move enhancement store creation (primary fix)
2. **Fix B** - Defensive re-enhancement in onLightingRefresh (belt-and-suspenders)
3. Consider **Fix C** only if issues persist

---

## Additional Notes

### `lightingRefresh` Hook Sources

The `lightingRefresh` hook is triggered by multiple sources:

| Source | Location | When |
|--------|----------|------|
| Foundry Core | Internal | After LOS/lighting computation |
| WallManager | `wall-manager.js:91,101,111,471` | After wall create/update/delete |
| VisionManager | `VisionManager.js:168` | Listens for updates |
| WorldSpaceFogEffect | `WorldSpaceFogEffect.js:922` | Listens for updates |

This means `lightingRefresh` can fire multiple times during startup and is almost guaranteed to fire at least once after initial scene setup.

### Code Locations Summary

| File | Lines | Relevant Code |
|------|-------|---------------|
| `canvas-replacement.js` | 1658-1659 | LightingEffect creation |
| `canvas-replacement.js` | 2155-2170 | LightEnhancementStore creation (500 lines later!) |
| `LightingEffect.js` | 1645-1662 | `onLightingRefresh()` - uses stale document |
| `LightingEffect.js` | 1428-1502 | `_applyFoundryEnhancements()` |
| `LightingEffect.js` | 1280-1381 | `syncAllLights()` |
| `ThreeLightSource.js` | 849-1009 | `_updateCookieFromConfig()` - active cookie clearing |
| `ThreeLightSource.js` | 672-837 | `updateData()` - sets `this.document` |

### Verification Steps

To verify this diagnosis is correct:

1. **Add console logging** to `_applyFoundryEnhancements()` to see when it's called and whether it finds enhancement config
2. **Add console logging** to `onLightingRefresh()` to see when it fires relative to store load
3. **Add console logging** to `_updateCookieFromConfig()` to see when cookies are being cleared

Example diagnostic patch:
```javascript
// In LightingEffect._applyFoundryEnhancements
console.log(`[COOKIE DEBUG] _applyFoundryEnhancements(${doc.id}):`, {
  storeExists: !!window.MapShine?.lightEnhancementStore,
  configFound: !!config,
  cookieTexture: config?.cookieTexture
});

// In LightingEffect.onLightingRefresh
console.log(`[COOKIE DEBUG] onLightingRefresh called, lights:`, 
  [...this.lights.keys()].map(id => ({
    id,
    hasCookieInDoc: !!this.lights.get(id)?.document?.config?.cookieTexture
  }))
);
```

---

## Implementation Status

### ✅ Fix A Implemented (2026-02-04)
**Location**: `canvas-replacement.js:1656-1668`

Moved `LightEnhancementStore` initialization to BEFORE `LightingEffect` creation:
```javascript
// Step 3.13.5: Initialize LightEnhancementStore BEFORE LightingEffect
_setEffectInitStep('Light Enhancement Store');
try {
  mapShine.lightEnhancementStore = new LightEnhancementStore();
  await mapShine.lightEnhancementStore.load?.();
  log.info('LightEnhancementStore loaded before LightingEffect');
} catch (e) {
  log.warn('Failed to initialize LightEnhancementStore early:', e);
  mapShine.lightEnhancementStore = null;
}
```

### ✅ Fix B Implemented (2026-02-04)
**Location**: `LightingEffect.js:1650-1658`

Updated `onLightingRefresh()` to re-apply enhancements before calling `updateData()`:
```javascript
for (const [id, source] of this.lights) {
  if (source && source.document) {
    const enhancedDoc = this._applyFoundryEnhancements(source.document);
    source.updateData(enhancedDoc, true);
  }
}
```

This ensures cookies aren't cleared by stale documents even if the `lightingRefresh` hook fires after initial sync.

---

## Ongoing Issue (2026-02-04)

**User Report**: Light cookies still completely break light rendering when enabled. No cookie settings make the effect visible. The issue persists even after Fix A + Fix B and after adding cookie texture retry/backoff.

**Symptoms**:
- Enabling cookies produces no visible gobo effect.
- In some cases the light appears to “break” (no visible change or a fully suppressed light).
- After Foundry restart, cookie settings still fail to load/render correctly.

### Recent Changes Applied (Still Not Resolving)

1. **Fallback cookie texture loading** (Three.js `TextureLoader`) when Foundry `loadTexture` fails.
2. **Cookie modulation applied to both alpha and color output** in the light shader to prevent compositing stages from discarding alpha-only modulation.

### New Hypotheses to Investigate

1. **Compositing path ignores light alpha**: If the light buffer is being sampled in a way that only uses RGB (or clamps alpha), cookieFactor in alpha may have no effect. The shader now multiplies `outColor` by `cookieFactor` as a defensive fix, but the effect is still invisible → suggests either the cookie texture never loads or the cookie mask is always ~1.0.

2. **Cookie texture never reaches GPU**: `uHasCookie` may remain `0.0` or `tCookie` may stay null if the texture load fails silently. The new fallback loader should cover this, but we need to confirm it fires by tracing load completion and uniform values.

3. **Cookie mask sampling resolves to white**: If the texture uses premultiplied alpha or an unexpected color space, `cookieMask` can resolve to ~1.0 across the board (no visible modulation). Inspect cookie texture decoding path, colorSpace, and `flipY` behavior.

4. **Shader path not executing**: If the light shader is swapped/rebuilt without cookie uniforms or if a different material is used in certain render paths (e.g., sunlight/light buffers), the cookie block may never execute. Validate material instance and uniforms in `ThreeLightSource.init()` during render.

### Next Investigation Steps

1. **Trace the cookie pipeline end-to-end** (UI → LightEnhancementStore → LightingEffect → ThreeLightSource → shader uniforms → light buffer).
2. **Instrument cookie load completion** (log `uHasCookie`, texture size, `cookieMask` sample statistics) to determine if the cookie texture actually influences shader output.
3. **Inspect light buffer compositing** in `LightingEffect` to confirm that RGB is sourced from the light buffer and not overridden later (sun/darkness/composite shader).
4. **Check restart persistence**: confirm scene flags contain cookie config after reload, and whether `_applyFoundryEnhancements()` is called post-restart with valid cookie data.
