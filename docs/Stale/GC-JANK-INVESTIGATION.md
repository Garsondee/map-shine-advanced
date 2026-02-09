# GC / Jank Investigation Log (Map Shine Advanced)

## Goal
Identify the most likely sources of **garbage collection (GC) spikes** and/or **memory growth** that produce a pattern of:
- accumulating small stutters
- followed by a larger stutter after some time

This document began as investigation-only, but now also tracks **fixes attempted/applied** as we triage and reduce GC/jank.

## Observed pattern (hypothesis)
The “builds up then spikes” profile strongly matches one (or more) of:
- **unbounded memory growth** (caches, retained objects) until GC runs a major collection
- **lifecycle leaks** (hooks/timers/RAF) that multiply work and allocations over time (e.g., per scene reset)
- **periodic heavy allocations** (image readback, geometry rebuilds, array churn) that trigger GC in bursts

## Current most likely culprits (ranked)

## Fixes attempted / applied (so far)

### Hook lifecycle leaks (CRITICAL)

**Applied fix pattern**:
- Store hook registrations as `this._hookIds = Array<[hookName, hookId]>`
- Unregister in `dispose()` via `Hooks.off(hookName, hookId)`

**Updated to this pattern**:
- `scripts/vision/VisionManager.js`
- `scripts/scene/token-manager.js`
- `scripts/scene/tile-manager.js`
- `scripts/scene/wall-manager.js`
- `scripts/scene/drawing-manager.js`
- `scripts/scene/note-manager.js`
- `scripts/scene/template-manager.js`
- `scripts/scene/light-icon-manager.js`
- `scripts/scene/enhanced-light-icon-manager.js`
- `scripts/scene/DoorMeshManager.js`
- `scripts/scene/grid-renderer.js`
- `scripts/effects/WorldSpaceFogEffect.js`
- `scripts/effects/IridescenceEffect.js`

Additional hook cleanup applied:
- `scripts/scene/light-icon-manager.js`
- `scripts/scene/enhanced-light-icon-manager.js`
- `scripts/scene/DoorMeshManager.js`
- `scripts/scene/grid-renderer.js`

### TileManager cache retention

**Applied fix**:
- `scripts/scene/tile-manager.js`: `dispose(clearCache=true)` now clears:
  - `alphaMaskCache`
  - `_tileWaterMaskCache` + related URL/promise maps
  - `_tileSpecularMaskCache` + related URL/promise maps

### LightingEffect per-frame allocation

**Applied fix**:
- `scripts/effects/LightingEffect.js`: removed `gl.getParameter(gl.COLOR_WRITEMASK)` call in the token mask pass and restored `gl.colorMask(true,true,true,true)` directly to avoid per-frame array allocations.

### Fog exploration save allocation churn

**Applied fix**:
- `scripts/effects/WorldSpaceFogEffect.js`: reuse buffers during exploration saves:
  - reuse `Uint8Array` for `readRenderTargetPixels`
  - read back the exploration render target in smaller tiles with yields (reduces worst-case single-frame stall)
  - reuse `OffscreenCanvas`/`canvas` + `ImageData` for encoding
  - reduce yield/promise churn during pixel copy

### WeatherParticles mask pixel readback caching

**Applied fix**:
- `scripts/particles/WeatherParticles.js`: added a reusable mask pixel cache (`_maskPixelCache`) and scratch canvas/context so mask scans reuse the same `Uint8ClampedArray` buffers instead of allocating new `ImageData` per call.
- Updated point-generation functions to use cached pixel data instead of creating a fresh canvas + calling `getImageData()` every time.

### WeatherParticles tile foam scan key churn

**Applied fix**:
- `scripts/particles/WeatherParticles.js`: replaced `texture.uuid`-based keys with stable URL-based keys (query string stripped) for:
  - tile alpha mask caching into `tileManager.alphaMaskCache`
  - tile foam `scanKey` generation
- `scripts/scene/tile-manager.js`: `isUvOpaque` now uses stable image `src` (query stripped) as the `alphaMaskCache` key (instead of `texture.uuid`).

### Status (what is fixed vs not fixed)

**Fixed / mitigated**:
- Hook lifecycle leaks from managers/effects listed above (unregistration should now occur on dispose)
- TileManager cache disposal gaps (alpha/water/specular caches cleared on dispose)
- LightingEffect per-frame `gl.getParameter` allocation
- WorldSpaceFogEffect: reduced allocation churn during exploration save
- WorldSpaceFogEffect: reduced worst-case save hitch by tiling `readRenderTargetPixels` with yields
- WeatherParticles: reduced rescans caused by `texture.uuid` key churn in tile foam pipeline
- WeatherParticles: reduced repeated `getImageData()` allocations by caching mask pixel readbacks

**Not fixed yet**:
- Fog exploration persistence: still does periodic GPU→CPU readback (stall remains), but work is spread across frames via tiled readback
- WeatherParticles: first-time mask readback still allocates `ImageData` for each unique mask texture (but is now cached and reused)

### 1) Hook lifecycle leaks in multiple managers (CRITICAL - verified)
**Why it fits**:
- Hook leaks cause *work to multiply over time* (each scene rebuild / enable cycle adds more listeners).
- Hook callbacks capture `this`, keeping entire manager graphs alive and growing retained memory.

**Root cause confirmed (Round 5)**:
Two distinct failure modes discovered:

**A) BROKEN cleanup pattern** - `Hooks.off(id)` with single argument:
- `VisionManager.dispose()` and `TokenManager.dispose()` call `Hooks.off(id)` with only the ID
- Foundry's `Hooks.off(hook, fn)` expects TWO arguments; when called with one arg, the ID is treated as a hook name
- Result: **cleanup silently fails**, hooks remain registered

**B) MISSING cleanup** - no unregistration at all:
- 9+ managers/effects register hooks but never unregister in `dispose()`
- Includes: TileManager, DrawingManager, NoteManager, TemplateManager, WallManager, LightIconManager, DoorMeshManager, WorldSpaceFogEffect, IridescenceEffect

**Impact per scene reset**: ~15-20 new hook listeners added, each keeping old manager instances alive.

**See Round 5 section below for full audit table and runtime verification steps.**

**Why this is especially dangerous**:
- `canvas-replacement.destroyThreeCanvas()` calls `*.dispose()` and then clears globals, but if hooks remain registered, the old instances remain reachable (and will continue responding to events).

### 2) `TileManager.alphaMaskCache` growth + large typed-array retention (high confidence)
**Why it fits**:
- `alphaMaskCache` stores `{width,height,data: Uint8ClampedArray}` per key.
- The key uses `texture.uuid || image.src || texture.id || tileDoc.id`. If textures are recreated (new `uuid`) during reloads or scene resets, the cache can grow without bound.
- Large `Uint8ClampedArray` allocations are classic “slow buildup then major GC” triggers.

**Evidence found**:
- `TileManager` defines `alphaMaskCache = new Map()`.
- Cache entries are created by drawing to a `canvas` and calling `getImageData`, which allocates a full RGBA buffer.
- `TileManager.dispose(clearCache=true)` clears `textureCache` but does **not** clear `alphaMaskCache`.

**Additional evidence (round 2)**:
- `WeatherParticles` also creates and stores alpha masks into `tileManager.alphaMaskCache` when generating foam/shoreline spawn points.
- Multiple systems now depend on alpha mask caching; if the cache key churns (e.g. `tileTex.uuid` changes), the retained memory growth could be larger than originally suspected.

### 3) Additional TileManager caches that appear unbounded (medium-high confidence)
`TileManager` contains multiple `Map` caches that are not cleared in `dispose()`:
- `_tileWaterMaskCache`, `_tileWaterMaskPromises`, `_tileWaterMaskResolvedUrl`, `_tileWaterMaskResolvePromises`
- `_tileSpecularMaskCache`, `_tileSpecularMaskPromises`, `_tileSpecularMaskResolvedUrl`, `_tileSpecularMaskResolvePromises`

If keys are derived from URLs with cache-busters or recreated objects, this is another memory growth vector.

### 4) Fog exploration persistence causes periodic GPU→CPU readback + encoding (high confidence for “big hitch”)
**Why it fits**:
- This is a classic periodic hitch source: synchronous `readRenderTargetPixels` + large `Uint8Array` allocations + image encoding + base64 conversion.
- Even if rate-limited, it can create a noticeable periodic “big stutter” when it triggers.

**Evidence found**:
- `WorldSpaceFogEffect._saveExplorationToFoundry()` allocates a new `Uint8Array(width * height * 4)` and calls `renderer.readRenderTargetPixels(...)`.
- It then encodes to WebP via `OffscreenCanvas.convertToBlob` (async) or `canvas.toBlob`/`toDataURL` (fallback), and converts to base64 via `FileReader`.
- Save triggering mechanism:
  - `_markExplorationDirty()` increments a commit counter every frame exploration accumulates.
  - When commit count reaches `canvas.fog.constructor.COMMIT_THRESHOLD ?? 70`, it triggers a debounced save.
  - There is also an explicit `this._minExplorationSaveIntervalMs = 30000` rate limit.

**Key nuance**:
- The readback itself is synchronous and can stall regardless of async encoding.
- If scene dimensions (or fog targets) are large, this becomes a high-amplitude hitch.

### 5) WeatherParticles: CPU mask scans using `canvas.getImageData()` (medium-high confidence for GC churn)
**Why it fits**:
- `getImageData()` creates large `Uint8ClampedArray` buffers and tends to be GC-heavy.
- WeatherParticles performs multiple mask scans to produce spawn point sets (water edges / interior / tile-local masks).

**Evidence found**:
- `WeatherParticles._generateWaterHardEdgePoints(...)` creates a DOM `canvas`, draws the mask, then calls `ctx.getImageData(0,0,w,h)`.
- Tile foam pipeline does similar `getImageData` scans in:
  - `_generateTileLocalWaterHardEdgePoints(...)`
  - `_generateTileLocalWaterEdgePoints(...)`
  - plus other related helper paths

**Mitigating factor (still needs confirmation)**:
- There is a cache layer (`this._tileWaterFoamCache`) that tries to re-scan only when `scanKey` changes.
- However, `scanKey` includes `maskTex.uuid` and `tileTex.uuid` which can churn across rebuilds/reloads and cause re-scans.

### 6) Hook cleanup API mismatch risk (medium confidence)
Some code uses `Hooks.off(id)` patterns (e.g., `TokenManager.dispose()` / `VisionManager.dispose()` seen in previous scans). Depending on Foundry version, `Hooks.off` may require `(hookName, fn)` or `(hookName, id)`.

If the signature is wrong in the running Foundry version, hook cleanup might be silently failing even in modules that attempt to unregister.

**Why it fits**:
- would create “slowly worsening” performance across sessions / resets.

## Notable non-culprits (so far)
- `TweakpaneManager` uses a RAF-based UI loop but has `stopUILoop()` and `dispose()` cancels RAF. This looks lifecycle-safe *assuming `dispose()` is always called on teardown*.

## Notes on effects investigated (round 2)
- `CloudEffect` appears to avoid obvious per-frame JS allocations (uses persistent render targets/materials and typed arrays for uniform sets). It may be GPU-heavy but is not currently a top GC-suspect.
- `MaskManager` maintains internal maps (`_masks`, `_derived`) and has a `dispose()` that clears derived targets and materials. It appears lifecycle-safe; main concern would be whether callers keep registering new ids/textures without clearing (needs runtime confirmation).

## Hook audit snapshot (round 3)

This is a first-pass classification based on code inspection (not runtime confirmation yet).

### Scene-side managers

#### Likely leaks (registers hooks, no unregistration seen)
- `scripts/scene/tile-manager.js`
- `scripts/scene/wall-manager.js`
- `scripts/scene/drawing-manager.js`
- `scripts/scene/note-manager.js`
- `scripts/scene/template-manager.js`
- `scripts/scene/light-icon-manager.js`
- `scripts/scene/DoorMeshManager.js`
- `scripts/scene/grid-renderer.js`
- `scripts/scene/enhanced-light-icon-manager.js`

#### Appears lifecycle-safe (explicit unregistration)
- `scripts/scene/surface-registry.js` (stores `[hook, fn]` and calls `Hooks.off(hook, fn)`)
- `scripts/scene/map-points-manager.js` (stores `{hook, fn}` and calls `Hooks.off(hook, fn)`)

#### Needs confirmation (attempts cleanup, but API signature risk)
- `scripts/scene/token-manager.js` (stores hook ids and calls `Hooks.off(id)`)

### Effect-side systems

#### Likely leaks (registers hooks, no unregistration seen)
- `scripts/effects/WorldSpaceFogEffect.js` (registers multiple hooks, no `Hooks.off` in `dispose()`)
- `scripts/effects/IridescenceEffect.js` (registers `create/update/deleteAmbientLight`, dispose does not unregister)

#### Appears lifecycle-safe (explicit unregistration)
- `scripts/effects/LightingEffect.js` (uses `_hookRegistrations` and unregisters)
- `scripts/effects/SpecularEffect.js` (calls `Hooks.off(hook, boundFn)` in `dispose()`)
- `scripts/effects/LensflareEffect.js` (stores hook ids and calls `Hooks.off(hook, hookId)` in `dispose()`)
- `scripts/effects/PlayerLightEffect.js` (stores hook ids and unregisters)

## InteractionManager allocation churn suspects (round 3)

### A) Light preview geometry rebuilds during drag
`InteractionManager._updateLightPlacementPreviewGeometry(...)`:
- allocates a new JS array `local = []` per call
- pushes `new THREE.Vector2(...)` for each vertex
- builds `new THREE.Shape(...)` and `new THREE.ShapeGeometry(...)` (or `new THREE.CircleGeometry(...)`)
- builds `new THREE.EdgesGeometry(...)` for the border
- disposes/replaces geometries each update

This is likely *very allocation-heavy* during light placement drag/resize.

### B) UI hit-testing on pointer events
`InteractionManager._isEventFromUI(event)`:
- calls `event.composedPath()` and then (if available) `document.elementsFromPoint(cx, cy)`.

These DOM APIs can allocate arrays/DOMLists and may create steady GC pressure during high-frequency pointermove.

### C) Per-frame update is small, but pointer-driven code can be hot
`InteractionManager.update(timeInfo)` itself is minimal (HUD positioning + light gizmo updates), but many pointer handlers can run at high frequency.

## Round 4 findings (LightingEffect / TokenManager / TileManager)

### LightingEffect: per-frame WebGL state queries may allocate (medium-high confidence)
**Why it fits**:
- `gl.getParameter(...)` often returns a fresh array/typed-array, which becomes garbage.
- Called every frame, this can create persistent GC pressure (“many small stutters”).

**Evidence found**:
- `LightingEffect.render()` calls:
  - `const prevMask2 = gl.getParameter(gl.COLOR_WRITEMASK);`
  - then restores via `gl.colorMask(prevMask2[0], prevMask2[1], prevMask2[2], prevMask2[3]);`

**Notes**:
- This path appears to run regardless of token count (it is inside the token mask render block).
- This is separate from the fog persistence “big hitch” and could contribute to frequent small GC events.

### TokenManager: name label canvas + CanvasTexture churn (medium confidence)
**Why it fits**:
- `createNameLabel()` allocates:
  - a new DOM `canvas`
  - `CanvasTexture`
  - sprite material + sprite
- If label visibility toggles often (hover/selection changes), this can create a steady stream of allocations.

**Evidence found**:
- `TokenManager._updateNameLabelVisibility()` calls `createNameLabel()` when the computed visibility becomes true and no label exists.
- `TokenManager._refreshNameLabel()` disposes the prior label texture and material.

**Notes**:
- This is likely smaller than the fog persistence readback, but could be a contributor to the “build-up” if many tokens are being hovered/selected over time.

### TokenManager: per-frame update loop exists (low-medium confidence)
**Evidence found**:
- `TokenManager.update(timeInfo)` iterates `activeAnimations` each frame.
- Most allocation appears to occur at animation start (`attributes.map(...)`), not per frame.

**Potential amplification**:
- If debug logging is enabled (log level DEBUG), `TokenManager.updateSpriteTransform` produces multiple `log.debug(...)` statements per transform update, which can allocate strings/args.

### TokenManager: hook cleanup signature risk persists (medium confidence)
**Evidence found**:
- Hooks are stored as ids via `this._hookIds.push(Hooks.on(...))`.
- `dispose()` calls `Hooks.off(id)`.

Depending on Foundry version, this may be incorrect and could cause hook leaks even though teardown is attempted.

### TileManager: caches not cleared on dispose (confirmed)
**Evidence found**:
- `TileManager` defines multiple long-lived caches:
  - `alphaMaskCache`
  - `_tileWaterMaskCache`, `_tileWaterMaskResolvedUrl`, etc.
  - `_tileSpecularMaskCache`, `_tileSpecularMaskResolvedUrl`, etc.
- There are some invalidation paths that clear water caches in response to events, but `dispose(clearCache=true)` does not clear `alphaMaskCache` or the water/specular caches.

## Runtime verification checklist (copy/paste into Foundry console)

### A) Hook listener counts (before/after scene reset)
```js
Object.fromEntries(Object.entries(Hooks.events).map(([k,v]) => [k, v.length]))
```

### B) Quick MapShine cache sizes
```js
({
  tileAlphaMasks: window.MapShine?.tileManager?.alphaMaskCache?.size,
  tileTextures: window.MapShine?.tileManager?.textureCache?.size,
  tileWaterMasks: window.MapShine?.tileManager?._tileWaterMaskCache?.size,
  tileSpecularMasks: window.MapShine?.tileManager?._tileSpecularMaskCache?.size,
  tokenTextures: window.MapShine?.tokenManager?.textureCache?.size,
  tokenCount: window.MapShine?.tokenManager?.tokenSprites?.size,
})
```

### C) Fog exploration save / rate-limit state
```js
({
  minSaveIntervalMs: window.MapShine?.fogEffect?._minExplorationSaveIntervalMs,
  lastSaveMs: window.MapShine?.fogEffect?._lastExplorationSaveMs,
  dirty: window.MapShine?.fogEffect?._explorationDirty,
  commitCount: window.MapShine?.fogEffect?._explorationCommitCount,
  threshold: canvas?.fog?.constructor?.COMMIT_THRESHOLD,
})
```

### D) Memory sampling (Chrome-based)
```js
performance?.memory ? {
  usedMB: (performance.memory.usedJSHeapSize/1048576).toFixed(1),
  totalMB: (performance.memory.totalJSHeapSize/1048576).toFixed(1),
  limitMB: (performance.memory.jsHeapSizeLimit/1048576).toFixed(1),
} : 'performance.memory not available'
```

## Immediate next investigation steps
- Confirm the Foundry hook API in your target version: what does `Hooks.on` return and what does `Hooks.off` accept?
- Enumerate all managers/effects that register hooks and verify they unregister on `destroyThreeCanvas()` / scene transitions.
- Inspect `TileManager` mask generation callsites to see how often alpha masks are computed and whether cache keys churn.
- Look for other unbounded caches and periodic heavy CPU readbacks (e.g., `readRenderTargetPixels`, `getImageData`, repeated `toDataURL`, etc.).

## Files touched / inspected (round 1)
- `scripts/foundry/canvas-replacement.js` (teardown path)
- `scripts/scene/tile-manager.js` (hooks + caches)
- `scripts/ui/tweakpane-manager.js` (RAF loop)
- `scripts/scene/drawing-manager.js`
- `scripts/scene/note-manager.js`
- `scripts/scene/template-manager.js`
- `scripts/scene/wall-manager.js`
- `scripts/vision/VisionManager.js`

## Files touched / inspected (round 2)
- `scripts/effects/WorldSpaceFogEffect.js` (hook registrations + exploration persistence readback)
- `scripts/vision/FogManager.js` (legacy persistence path; no instantiation found yet)
- `scripts/particles/WeatherParticles.js` (mask scanning + alpha mask usage)
- `scripts/scene/physics-rope-manager.js` (contains `readRenderTargetPixels` sampling for window light)
- `scripts/masks/MaskManager.js` (mask registry + derived RT lifecycle)

## Files touched / inspected (round 3)
- `scripts/scene/interaction-manager.js` (update loop + allocation suspects)
- `scripts/scene/surface-registry.js` (confirmed hook cleanup pattern)
- `scripts/scene/DoorMeshManager.js` (hook registration without cleanup)
- `scripts/scene/light-icon-manager.js` (hook registration without cleanup)
- `scripts/effects/SpecularEffect.js` (confirmed hook cleanup)
- `scripts/effects/IridescenceEffect.js` (hook registration without cleanup)
- `scripts/effects/LensflareEffect.js` (confirmed hook cleanup)
- `scripts/effects/PlayerLightEffect.js` (confirmed hook cleanup)

## Files touched / inspected (round 4)
- `scripts/effects/LightingEffect.js` (token mask pass: `gl.getParameter(gl.COLOR_WRITEMASK)`)
- `scripts/scene/token-manager.js` (per-frame animation loop + name label allocations + hook cleanup pattern)
- `scripts/scene/tile-manager.js` (cache declarations + dispose gaps)

---

# Round 5: Hook Lifecycle Deep-Dive

## Foundry Hooks API Contract (verified from source)

**Source**: `foundryvttsourcecode/resources/app/client/helpers/hooks.mjs`

### `Hooks.on(hook, fn, options?)` → `number`
```js
static on(hook, fn, {once=false}={}) {
  const id = this.#id++;           // Auto-incrementing numeric ID
  // ... stores {hook, id, fn, once} in #events[hook] array
  this.#ids.set(id, entry);        // Also stores in #ids Map for fast lookup
  return id;                       // Returns the numeric ID
}
```

### `Hooks.off(hook, fn)` → `void`
```js
static off(hook, fn) {
  // Path A: If fn is a NUMBER, lookup by ID (ignores hook param!)
  if ( typeof fn === "number" ) {
    const id = fn;
    entry = this.#ids.get(id);     // Direct lookup by ID
    if ( !entry ) return;          // Silent no-op if not found
    this.#ids.delete(id);
    const event = this.#events[entry.hook];  // Uses entry.hook, not the passed hook!
    event.findSplice(h => h.id === id);
  }
  // Path B: If fn is a FUNCTION, lookup by function reference
  else {
    const event = this.#events[hook];
    if ( !event ) return;
    const entry = event.findSplice(h => h.fn === fn);
    if ( !entry ) return;
    this.#ids.delete(entry.id);
  }
}
```

### Critical Insight

**`Hooks.off(id)` with ONE argument is BROKEN!**

When you call `Hooks.off(id)` with only the numeric ID:
- JavaScript passes `id` as the **first** argument (`hook`)
- The second argument (`fn`) is `undefined`
- `typeof undefined === "undefined"`, not `"number"`
- Foundry takes **Path B** and tries to find `this.#events[id]` (treating the number as a hook name)
- This silently fails because there's no hook named `42` (or whatever the ID is)
- **The hook remains registered!**

**Correct patterns**:
- `Hooks.off(hookName, id)` - two args, ID as second arg → Path A (works)
- `Hooks.off(hookName, fn)` - two args, function as second arg → Path B (works)

---

## MapShine Hook Pattern Audit

### Category 1: BROKEN - `Hooks.off(id)` with one argument

| File | Pattern | Why it's broken |
|------|---------|----------------|
| `scripts/vision/VisionManager.js:471` | `Hooks.off(id)` | Single arg; `id` becomes `hook` param; silent no-op |
| `scripts/scene/token-manager.js:1050` | `Hooks.off(id)` | Single arg; `id` becomes `hook` param; silent no-op |

**Impact**: These managers **think** they're cleaning up hooks but actually aren't. Every scene reset / enable-disable cycle adds duplicate listeners.

### Category 2: MISSING - No unregistration at all

| File | Hooks registered | dispose() unregisters? |
|------|------------------|------------------------|
| `scripts/scene/tile-manager.js` | `canvasReady`, `createTile`, `updateTile`, `deleteTile` | ❌ No |
| `scripts/scene/drawing-manager.js` | `createDrawing`, `updateDrawing`, `deleteDrawing`, `canvasReady`, `activateDrawingsLayer`, `deactivateDrawingsLayer` | ❌ No |
| `scripts/scene/note-manager.js` | `createNote`, `updateNote`, `deleteNote`, `canvasReady`, `activateNotesLayer`, `deactivateNotesLayer` | ❌ No |
| `scripts/scene/template-manager.js` | `createMeasuredTemplate`, `updateMeasuredTemplate`, `deleteMeasuredTemplate`, `canvasReady`, `activateTemplateLayer`, `deactivateTemplateLayer` | ❌ No |
| `scripts/scene/wall-manager.js` | `createWall`, `updateWall`, `deleteWall` | ❌ No |
| `scripts/scene/light-icon-manager.js` | `createAmbientLight`, `updateAmbientLight`, `deleteAmbientLight`, `canvasReady`, `activateLightingLayer`, `deactivateLightingLayer` | ❌ No |
| `scripts/scene/DoorMeshManager.js` | Various door/wall hooks | ❌ No |
| `scripts/effects/WorldSpaceFogEffect.js` | `controlToken`, `updateToken`, `sightRefresh`, `lightingRefresh` | ❌ No |
| `scripts/effects/IridescenceEffect.js` | `createAmbientLight`, `updateAmbientLight`, `deleteAmbientLight` | ❌ No |

**Impact**: Every scene reset / enable-disable cycle adds duplicate listeners. Callbacks capture `this`, keeping entire object graphs alive.

### Category 3: CORRECT - Proper two-argument unregistration

| File | Pattern | Storage |
|------|---------|--------|
| `scripts/effects/LightingEffect.js` | `Hooks.off(hook, fn)` | `_hookRegistrations = [{hook, fn}, ...]` |
| `scripts/effects/SpecularEffect.js` | `Hooks.off(hook, boundFn)` | Stores bound functions as properties |
| `scripts/effects/PlayerLightEffect.js` | `Hooks.off(hookName, hookId)` | `_hookIds = [[hookName, id], ...]` |
| `scripts/effects/CandleFlamesEffect.js` | `Hooks.off(hook, id)` | `_hookIds = [[hook, id], ...]` |
| `scripts/effects/LensflareEffect.js` | `Hooks.off(hook, hookId)` | `hookIdCreate`, `hookIdUpdate`, `hookIdDelete` |
| `scripts/scene/surface-registry.js` | `Hooks.off(hook, fn)` | `_hooks = [[hook, fn], ...]` |
| `scripts/scene/map-points-manager.js` | `Hooks.off(hook, fn)` | `_hookRegistrations = [{hook, fn}, ...]` |
| `scripts/foundry/controls-integration.js` | `Hooks.off(hookName, id)` | `_hookIds = [[hookName, id], ...]` |

---

## Leak Mechanism Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     SCENE RESET / ENABLE CYCLE                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. destroyThreeCanvas() calls manager.dispose()                │
│     - Managers with BROKEN/MISSING cleanup leave hooks behind   │
│     - Old callbacks still reference old manager instances       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. initializeThreeCanvas() creates NEW manager instances       │
│     - NEW hooks registered via setupHooks()                     │
│     - OLD hooks still exist in Hooks.events                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Hook fires (e.g., createTile)                               │
│     - OLD callback runs → operates on stale/disposed manager    │
│     - NEW callback runs → operates on current manager           │
│     - Work is DOUBLED (or more after multiple resets)           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Memory impact                                               │
│     - Old manager instances kept alive by hook closures         │
│     - Their textures, geometries, render targets NOT GC'd       │
│     - Heap grows with each reset cycle                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Runtime Verification: Hook Leak Detection

### Step 1: Count hooks before/after scene reset

```js
// Run BEFORE scene reset
const before = Object.fromEntries(
  Object.entries(Hooks.events)
    .filter(([k,v]) => v.length > 0)
    .map(([k,v]) => [k, v.length])
);
console.log('Hooks BEFORE:', before);

// ... reset scene (e.g., switch scenes and back) ...

// Run AFTER scene reset
const after = Object.fromEntries(
  Object.entries(Hooks.events)
    .filter(([k,v]) => v.length > 0)
    .map(([k,v]) => [k, v.length])
);
console.log('Hooks AFTER:', after);

// Compare
for (const [hook, count] of Object.entries(after)) {
  const diff = count - (before[hook] || 0);
  if (diff > 0) console.warn(`LEAK: ${hook} grew by ${diff} listeners`);
}
```

### Step 2: Identify MapShine-specific hooks

```js
// Look for hooks with MapShine-related callbacks
for (const [hook, entries] of Object.entries(Hooks.events)) {
  for (const entry of entries) {
    const fnStr = entry.fn?.toString?.() || '';
    if (fnStr.includes('MapShine') || 
        fnStr.includes('TileManager') || 
        fnStr.includes('TokenManager') ||
        fnStr.includes('syncAll') ||
        fnStr.includes('createTileSprite')) {
      console.log(`${hook} [id=${entry.id}]:`, entry.fn.name || '(anonymous)');
    }
  }
}
```

### Step 3: Count total hook registrations over time

```js
// Snapshot total hook count
const totalHooks = () => Object.values(Hooks.events).reduce((sum, arr) => sum + arr.length, 0);
console.log('Total hooks:', totalHooks());

// Run this periodically or after each scene change to see if it grows
```

---

## Severity Assessment

| Category | Files affected | Severity | Why |
|----------|---------------|----------|-----|
| BROKEN `Hooks.off(id)` | 2 | **CRITICAL** | Developers think cleanup works; it silently fails |
| MISSING unregistration | 9+ | **CRITICAL** | Every reset multiplies work and retains memory |
| CORRECT patterns | 8 | N/A | These are fine |

**Estimated impact per scene reset**:
- ~15-20 new hook listeners added (from BROKEN + MISSING categories)
- Each listener captures `this` → keeps manager + all its resources alive
- After 5 resets: 75-100 extra listeners, 5x memory for affected managers

---

## Files touched / inspected (round 5)
- `foundryvttsourcecode/resources/app/client/helpers/hooks.mjs` (Foundry Hooks implementation)
- `scripts/vision/VisionManager.js` (BROKEN: `Hooks.off(id)` single-arg)
- `scripts/scene/token-manager.js` (BROKEN: `Hooks.off(id)` single-arg)
- `scripts/scene/tile-manager.js` (MISSING: no unregistration)
- `scripts/scene/drawing-manager.js` (MISSING: no unregistration)
- `scripts/scene/wall-manager.js` (MISSING: no unregistration)
- `scripts/effects/WorldSpaceFogEffect.js` (MISSING: no unregistration)
- `scripts/effects/IridescenceEffect.js` (MISSING: no unregistration)
- `scripts/effects/LightingEffect.js` (CORRECT: two-arg pattern)
- `scripts/effects/SpecularEffect.js` (CORRECT: two-arg pattern)
- `scripts/effects/PlayerLightEffect.js` (CORRECT: two-arg pattern)
- `scripts/effects/CandleFlamesEffect.js` (CORRECT: two-arg pattern)
- `scripts/scene/surface-registry.js` (CORRECT: two-arg pattern)
- `scripts/scene/map-points-manager.js` (CORRECT: two-arg pattern)

---

# Round 6: Deep-Dive on Other Top Culprits

## 1) TileManager Cache Analysis (Culprits #2 and #3)

### `alphaMaskCache` - CONFIRMED UNBOUNDED

**Location**: `scripts/scene/tile-manager.js:73`

```js
/** @type {Map<string, {width: number, height: number, data: Uint8ClampedArray}>} */
this.alphaMaskCache = new Map();
```

**How entries are created**:
- `isWorldPointOpaque()` and `isUvOpaque()` create masks on-demand (lines 916-926, 954-965)
- `WeatherParticles` also populates this cache (line 5708)

**Cache key**: `texture.uuid || image.src || texture.id || tileDoc.id`

**Problem**: 
- `texture.uuid` is a THREE.js-generated UUID that changes when textures are recreated
- If a tile's texture is reloaded (scene reset, texture swap), a NEW cache entry is created
- OLD entries are never removed

**Disposal gap**:
```js
dispose(clearCache = true) {
  // ...
  if (clearCache) {
    // Only clears textureCache!
    for (const texture of this.textureCache.values()) { ... }
    this.textureCache.clear();
  }
  // alphaMaskCache is NEVER cleared!
}
```

**Memory impact per entry**: `width * height * 4` bytes (RGBA)
- A 2048x2048 tile = **16 MB** per mask entry
- A 4096x4096 tile = **64 MB** per mask entry

### Water/Specular Mask Caches - PARTIALLY BOUNDED

**Caches**:
- `_tileWaterMaskCache` - stores THREE.Texture objects
- `_tileWaterMaskResolvedUrl` - stores URL strings
- `_tileSpecularMaskCache` - stores THREE.Texture objects
- `_tileSpecularMaskResolvedUrl` - stores URL strings

**Partial invalidation exists** (line 203):
```js
// Conservative approach: clear all per-tile water mask caches
this._tileWaterMaskCache?.clear?.();
this._tileWaterMaskPromises?.clear?.();
```

**But**: This only runs in `_invalidateTileWaterMaskCachesForTile()` which is called on tile CRUD events. It does NOT run in `dispose()`.

**Disposal gap**: Same as alphaMaskCache - `dispose()` does not clear these caches.

### Runtime Verification

```js
// Check TileManager cache sizes
({
  alphaMaskCache: window.MapShine?.tileManager?.alphaMaskCache?.size,
  alphaMaskTotalBytes: (() => {
    let total = 0;
    const cache = window.MapShine?.tileManager?.alphaMaskCache;
    if (cache) for (const v of cache.values()) total += v?.data?.byteLength || 0;
    return total;
  })(),
  waterMaskCache: window.MapShine?.tileManager?._tileWaterMaskCache?.size,
  specularMaskCache: window.MapShine?.tileManager?._tileSpecularMaskCache?.size,
})
```

---

## 2) WorldSpaceFogEffect GPU→CPU Readback (Culprit #4)

### Save Trigger Mechanism

**Location**: `scripts/effects/WorldSpaceFogEffect.js`

**Trigger chain**:
1. `_markExplorationDirty()` (line 1369) increments `_explorationCommitCount` every frame exploration accumulates
2. When count reaches `COMMIT_THRESHOLD` (default 70), triggers debounced save
3. `_saveExplorationToFoundry()` performs the actual readback

**Rate limiting** (line 1512):
```js
const minInterval = Number(this._minExplorationSaveIntervalMs) || 0; // Default: 30000ms
if (minInterval > 0 && (nowMs - lastSave) < minInterval) return;
```

### Allocation Analysis in `_saveExplorationToFoundry()`

**Line 1528**: GPU→CPU readback
```js
const buffer = new Uint8Array(width * height * 4);
this.renderer.readRenderTargetPixels(explorationTarget, 0, 0, width, height, buffer);
```

**Allocation size**: `explorationRTWidth * explorationRTHeight * 4` bytes
- For a 4096x4096 scene: **64 MB** allocation
- For a 2048x2048 scene: **16 MB** allocation

**Additional allocations in `_encodeExplorationBase64()`** (line 1570):
```js
const offscreen = new OffscreenCanvas(width, height);  // Canvas allocation
const imgData = ctx.createImageData(width, height);    // Another width*height*4 buffer
```

**Total per save**: ~2-3x the render target size in temporary allocations

### Hitch Characteristics

- **Synchronous stall**: `readRenderTargetPixels()` blocks until GPU→CPU transfer completes
- **Frequency**: Every 30 seconds minimum (when exploration is active)
- **Amplitude**: Proportional to scene size; large scenes = large hitches

### Runtime Verification

```js
// Monitor fog save state
({
  lastSaveMs: window.MapShine?.fogEffect?._lastExplorationSaveMs,
  timeSinceLastSave: Date.now() - (window.MapShine?.fogEffect?._lastExplorationSaveMs || 0),
  minIntervalMs: window.MapShine?.fogEffect?._minExplorationSaveIntervalMs,
  dirty: window.MapShine?.fogEffect?._explorationDirty,
  commitCount: window.MapShine?.fogEffect?._explorationCommitCount,
  rtWidth: window.MapShine?.fogEffect?._explorationRTWidth,
  rtHeight: window.MapShine?.fogEffect?._explorationRTHeight,
  estimatedSaveAllocationMB: ((window.MapShine?.fogEffect?._explorationRTWidth || 0) * 
                              (window.MapShine?.fogEffect?._explorationRTHeight || 0) * 4 * 3 / 1048576).toFixed(1),
})
```

---

## 3) WeatherParticles Mask Scanning (Culprit #5)

### `getImageData()` Call Sites

Found **9 distinct `getImageData()` calls** in WeatherParticles.js:
- Line 4817: `_generateWaterHardEdgePoints()`
- Line 5378: `_generateTileLocalWaterHardEdgePoints()`
- Line 5467: `_generateTileLocalWaterEdgePoints()`
- Line 5706: Tile alpha mask creation
- Line 6187: `_generateWaterInteriorPoints()`
- Line 6274: `_generateTileLocalWaterInteriorPoints()`
- Line 6472: `_generateWaterEdgePoints()`
- Line 6544: `_generateShorelinePoints()`
- Line 6613: Another shoreline variant

### Cache Key Churn Risk

**Location**: Line 5750
```js
const tileTexKey = (tileTex && typeof tileTex.uuid === 'string') ? tileTex.uuid : '';
const scanKey = `${maskTex.uuid}|${tileTexKey}|${this._waterMaskThreshold}|${this._waterMaskStride}`;
```

**Problem**: `maskTex.uuid` and `tileTex.uuid` are THREE.js UUIDs that change when textures are recreated.

**When textures are recreated**:
- Scene reset
- Tile texture swap
- Module reload

**Impact**: Cache miss → full re-scan → multiple `getImageData()` calls → large `Uint8ClampedArray` allocations

### Per-Scan Allocation Size

Each `getImageData()` allocates: `width * height * 4` bytes

For a 2048x2048 mask: **16 MB** per scan

With 9 potential scan sites and multiple tiles, a full re-scan could allocate **100+ MB** of temporary buffers.

### Mitigating Factor

The `_tileWaterFoamCache` (line 1519) does cache results:
```js
this._tileWaterFoamCache = new Map(); // tileId -> { scanKey, transformKey, ... }
```

But cache is invalidated when `scanKey` changes (line 5776):
```js
if (entry.scanKey !== scanKey) {
  entry.scanKey = scanKey;
  entry.localHardPts = this._generateTileLocalWaterHardEdgePoints(...);  // Re-scan!
  entry.localEdgePts = this._generateTileLocalWaterEdgePoints(...);      // Re-scan!
  entry.localInteriorPts = this._generateTileLocalWaterInteriorPoints(...); // Re-scan!
}
```

---

## 4) LightingEffect Per-Frame Allocations (Culprit from Round 4)

### `gl.getParameter()` Allocation

**Location**: `scripts/effects/LightingEffect.js:1872`

```js
const gl = renderer.getContext();
const prevMask2 = gl.getParameter(gl.COLOR_WRITEMASK);  // Returns new array!
try {
  gl.colorMask(false, false, false, false);
  renderer.render(scene, this.mainCamera);
} finally {
  gl.colorMask(prevMask2[0], prevMask2[1], prevMask2[2], prevMask2[3]);
}
```

**Problem**: `gl.getParameter(gl.COLOR_WRITEMASK)` returns a **new `Array(4)`** every call.

**Frequency**: Every frame (inside the token mask render block)

**Impact**: 
- Small allocation (32 bytes for array + 4 booleans)
- But at 60 FPS = **1920 allocations/second**
- Contributes to "many small stutters" pattern

### Other Per-Frame Patterns (Acceptable)

The render loop reuses:
- `_tmpEnabledTokenMaskLayer` array (line 1852): Reused via `.length = 0`
- Render targets: Created once, resized as needed

---

## 5) InteractionManager Allocation Patterns

### Light Translate Gizmo - One-Time Creation

**Location**: `scripts/scene/interaction-manager.js:3357`

The gizmo geometries (`BoxGeometry`, `ConeGeometry`) are created once in `_createLightTranslateGizmo()` and reused. **Not a per-frame issue.**

### Light Radius Preview During Drag

**Location**: Lines 4821-4870

During enhanced light drag, `refreshRadiusGeometry()` is called at ~90 Hz:
```js
const hz = Math.max(1, Number(this._enhancedLightDragRadiusHz) || 90);
```

This rebuilds LOS-clipped geometry while dragging. **Only active during drag operations**, not idle.

### Debug Map Allocation (Minor)

**Location**: Line 4847
```js
if (!this._enhancedLightDragDebug) this._enhancedLightDragDebug = new Map();
```

Created lazily, persists. Not a significant issue.

### Overall Assessment

InteractionManager is **not a major GC contributor** during normal operation. Allocation-heavy paths only run during active user interaction (dragging, placing lights).

---

## Summary: Severity Ranking Update

| Culprit | Severity | Confidence | Notes |
|---------|----------|------------|-------|
| Hook lifecycle leaks | **CRITICAL** | Very High | Verified broken cleanup; multiplies work per reset |
| TileManager.alphaMaskCache | **HIGH** | High | Never cleared; 16-64 MB per entry; keys churn |
| Fog exploration readback | **HIGH** | High | 30s periodic; 64-192 MB allocation spike |
| WeatherParticles mask scans | **MEDIUM-HIGH** | Medium | Cached but keys churn; 100+ MB on full re-scan |
| TileManager water/specular caches | **MEDIUM** | Medium | Partial invalidation exists; not cleared on dispose |
| LightingEffect gl.getParameter | **LOW-MEDIUM** | High | Small per-frame allocation; contributes to baseline GC |
| InteractionManager | **LOW** | High | Only allocates during active interaction |

---

## Files touched / inspected (round 6)
- `scripts/scene/tile-manager.js` (cache declarations, disposal, alphaMaskCache usage)
- `scripts/effects/WorldSpaceFogEffect.js` (save trigger, readback, encoding)
- `scripts/particles/WeatherParticles.js` (getImageData calls, cache key construction)
- `scripts/effects/LightingEffect.js` (gl.getParameter in render loop)
- `scripts/scene/interaction-manager.js` (gizmo creation, drag handlers)
