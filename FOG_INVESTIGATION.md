# Fog of War Investigation

## Symptoms
1. **Token selected → entire screen goes black** (full opaque fog covers everything)
2. **Token deselected → fog vanishes, screen works** (bypass logic correctly hides fog for GM with no token)
3. This means vision extraction returns **all-zero data** → shader sees `vision=0` everywhere → `fogAlpha=1.0` → full black

## Architecture Overview

### Rendering Pipeline
```
PIXI Ticker (priority -50, AFTER Foundry updates):
  1. Foundry internal: vision/lighting/fog updates → sightRefresh hook fires
  2. Our _onPixiTick → post-PIXI callbacks:
     - syncVisionFromPixi() → flushPixi() [full PIXI stage render]
     - Sets countdown for extraction

Three.js RAF (requestAnimationFrame):
  3. RenderLoop.render() → EffectComposer.render():
     - WorldSpaceFogEffect.update() → _extractPixiTexture() [ACTUAL EXTRACTION]
     - Scene render (layer 31 disabled)
     - Post-processing
     - _renderOverlayToScreen() → renders fog plane (layer 31) to screen
```

### Texture Extraction Flow
```
Source: canvas.masks.vision.renderTexture (PIXI.FORMATS.RED, screen-sized)
  → Create temp RGBA RenderTexture
  → Render sprite(source) into temp RT via pixiRenderer.render()
  → extract.pixels(tempRT) → Uint8Array (RGBA)
  → Upload to THREE.DataTexture
  → Shader samples tVision.r channel
```

### Key Source Textures
- **Vision**: `canvas.masks.vision.renderTexture` — RED format, screen-space, CachedContainer with `autoRender=false`
- **Exploration**: `canvas.fog.sprite.texture` — persistent explored areas

## Potential Issues to Investigate

### 1. PIXI `extract.pixels()` Not Working for Our tempRT
**Hypothesis**: After `pixiRenderer.render(sprite, { renderTexture: tempRT })`, the batch might not be fully flushed, so `extract.pixels()` reads stale/empty data from the framebuffer.

**Test**: Add logging of pixel values immediately after extraction. Check if ALL values are 0 or if some have data.

### 2. Sprite-of-RenderTexture Rendering Issue
**Hypothesis**: Creating `new PIXI.Sprite(visionRT)` where `visionRT` is a RED-format RenderTexture might not render correctly via PIXI's sprite shader. The RED format causes the sprite to sample as `(r, 0, 0, 1)`, but PIXI's sprite shader might handle this differently (e.g., premultiplied alpha issues).

**Test**: Log the vision RT's format, dimensions, validity. Try extracting directly from the vision RT (without sprite conversion) and check if that returns data.

### 3. CachedContainer `autoRender=false` + Our `flushPixi()` Interaction
**Hypothesis**: `CanvasVisionMask.autoRender = false` means `flushPixi()` (which calls `canvas.app.renderer.render(canvas.stage)`) does NOT re-render the vision mask content. It only renders the bound sprite to screen. The RT retains its content from the last Foundry render. This should be fine, but if Foundry hasn't rendered since the last perception update, the RT could be stale or empty.

**Test**: Log `canvas.masks.vision.renderDirty` before extraction to see if Foundry thinks the vision needs re-rendering.

### 4. Timing: Extraction Runs Before Vision Is Rendered
**Hypothesis**: The Three.js RAF tick might run BEFORE the PIXI ticker in a given browser frame. If so, `update()` extracts pixels before Foundry has rendered vision for this frame. On the first frame after token selection, the vision RT might not have LOS data yet.

**Test**: Log timestamps of sightRefresh hook vs. extraction to verify ordering.

### 5. `uScreenSize` Mismatch
**Hypothesis**: The shader uses `gl_FragCoord.xy / uScreenSize` for vision UV. `uScreenSize` comes from `renderer.getDrawingBufferSize()` (Three.js). If the Three.js and PIXI canvases have different sizes or DPI scaling, the UV mapping is wrong — the shader samples outside the [0,1] range or from the wrong region.

**Test**: Log Three.js drawing buffer size vs. PIXI renderer screen size. Compare dimensions.

### 6. Y-Flip is Wrong
**Hypothesis**: The shader applies `1.0 - screenUv.y` for vision sampling. This might be incorrect depending on the actual data layout from readPixels.

Analysis of data flow:
- PIXI RenderTexture projection: PIXI Y=0 (top) → framebuffer top
- `gl.readPixels`: reads from framebuffer bottom → row 0 = PIXI Y=height (screen bottom)
- DataTexture `flipY=false` + `texImage2D` without UNPACK_FLIP_Y: row 0 → V=0 (texture bottom)
- So: V=0 = screen bottom, V=1 = screen top
- `gl_FragCoord.y=0` = screen bottom
- `screenUv.y = gl_FragCoord.y / uScreenSize.y` → 0 at bottom, 1 at top
- `1.0 - screenUv.y` → 1 at bottom, 0 at top
- Sampling at (x, 1.0 - screenUv.y): at screen bottom → V=1 → screen top of data

This means the Y-flip might be **WRONG** — inverting the vision mask relative to the screen.

**BUT**: For PIXI RenderTextures specifically, the projection is flipped compared to the default framebuffer. So readPixels row 0 might actually be screen TOP (PIXI Y=0). Need to verify experimentally.

**Test**: Try removing the Y-flip (`vec2(screenUv.x, screenUv.y)`) and see if vision appears correctly.

### 7. `extract.pixels()` API Differences
**Hypothesis**: PIXI v7's `extract.pixels()` might not work correctly with `RenderTexture.create()` render targets. The internal `renderer.renderTexture.bind()` call might not properly set up the framebuffer for reading.

**Test**: Use `renderer.gl.readPixels()` directly instead of `extract.pixels()` to bypass any PIXI abstraction issues.

### 8. WebGL State Corruption Between Contexts
**Hypothesis**: Calling `pixiRenderer.render()` from the Three.js RAF callback might leave some shared browser state in an unexpected condition, even though they're separate WebGL contexts.

**Test**: Move the extraction to happen entirely within the PIXI ticker callback (post-PIXI phase) instead of during Three.js update().

## Alternative Approaches (If Extraction Can't Be Fixed)

### A. Direct LOS Polygon Rendering
Use `canvas.effects.visionSources` to get LOS polygon data. Render these polygons directly as a Three.js stencil/mask. Avoids cross-context texture copying entirely.

**Pros**: No pixel extraction, no format issues, no timing issues
**Cons**: Need to handle polygon rendering, multiple vision sources, explored area separately

### B. Move Extraction to PIXI Ticker
Instead of extracting during Three.js update(), extract in the post-PIXI callback (same tick as sightRefresh). The DataTexture is updated once and the Three.js shader reads from it during its own render.

**Pros**: Extraction happens when PIXI state is "clean" and vision is guaranteed to be fresh
**Cons**: Still requires cross-context pixel copy

### C. Hide Three.js Fog, Use Foundry's Native
Don't render a Three.js fog plane at all. Let Foundry's native PIXI fog rendering handle it. The PIXI canvas (#board) is behind the Three.js canvas (#map-shine-canvas), so this requires making the Three.js canvas transparent where fog should show through.

**Pros**: No extraction needed, uses Foundry's proven fog system
**Cons**: Layering/compositing complexity, may not work with post-processing

## Changes Made (Approach B — Move Extraction to PIXI Tick)

### Root Cause Hypothesis
The extraction (`pixiRenderer.render()` + `extract.pixels()`) was happening during the Three.js `requestAnimationFrame` callback (inside `update()`). At that point:
- The PIXI renderer's internal state was indeterminate (between ticks)
- The vision RenderTexture might not have been freshly rendered yet
- Calling `pixiRenderer.render(sprite, { renderTexture: tempRT })` from outside the PIXI tick could produce empty/stale data

### Fix Applied
Moved all pixel extraction to the **post-PIXI callback** (`syncVisionFromPixi()` for WorldSpaceFogEffect, `frameCoordinator.onPostPixi()` for FoundryFogBridge). This runs after:
1. Foundry's perception flags have been processed (`applyRenderFlags`)
2. Vision has been rendered into the RT (`canvas.visibility.refresh`)
3. `sightRefresh` hook has fired
4. `flushPixi()` has done a final stage render

### Files Changed

1. **`WorldSpaceFogEffect.js`**:
   - `syncVisionFromPixi()`: Now calls `_getVisionTexture()` / `_getExploredTexture()` after `flushPixi()`
   - `update()`: No longer does extraction — just reads cached `_visionDataTexture` / `_exploredDataTexture`
   - Enhanced diagnostic logging: logs first 3 extractions with pixel data samples, source format, dimensions
   - Screen size diagnostic: one-time comparison of Three.js drawing buffer vs PIXI screen size
   - Initialized `_visionDiagLogged`, `_exploredDiagLogged`, `_screenSizeDiagLogged` in constructor

2. **`FoundryFogBridge.js`**:
   - `initialize()`: Registers `frameCoordinator.onPostPixi()` callback for extraction
   - `sync()`: No longer extracts — uses cached textures (fallback to extraction if post-PIXI callback isn't registered)
   - Added diagnostic logging matching WorldSpaceFogEffect
   - Proper cleanup of post-PIXI unsub in `dispose()`

3. **`PlayerLightEffect.js`**:
   - `_updateVisionMaskRefs()`: First tries to reuse `WorldSpaceFogEffect._visionDataTexture` (already extracted during PIXI tick)
   - Falls back to its own extraction only if fog effect isn't available

### Y-Flip Analysis (Confirmed Correct)
The shader's `vec2(screenUv.x, 1.0 - screenUv.y)` IS correct because:
- PIXI RenderTexture projection: framebuffer row 0 = PIXI Y=0 = screen top
- `readPixels` row 0 = screen top
- DataTexture `flipY=false`: row 0 → V=0 (GL texture bottom)
- So V=0 = screen top data, V=1 = screen bottom data
- `gl_FragCoord.y=0` at screen bottom → needs V=1 → `1.0 - 0 = 1.0` ✓
- `gl_FragCoord.y=H` at screen top → needs V=0 → `1.0 - 1.0 = 0.0` ✓

## ROOT CAUSE FOUND

### The Problem
Foundry's raw vision mask (`canvas.masks.vision.renderTexture`) does NOT include global illumination.
In `visibility.mjs` line 578:
```javascript
if ( (visionSource.radius > 0) && !blinded && !visionSource.isPreview ) {
    vision.sight.drawShape(visionSource.shape);
```
With `sight.range: 0`, the token's vision source has `radius: 0`, so this condition is **false** and the
LOS polygon is NOT drawn into the main vision mask. Global light IS drawn into a sub-container
(`vision.light.global.source`), but the compositing that makes it visible happens in Foundry's PIXI
layer stack — NOT in the raw renderTexture we extract.

Result: vision RT is legitimately all-zero → our fog shader reads vision=0 → full black screen.

### The Fix
Added `_isGlobalIlluminationActive()` to all three vision-consuming files:
- **WorldSpaceFogEffect.js**: When global illumination is active, uses white (fully visible) vision
  texture instead of the empty extracted one. Exploration fog still applies normally.
- **FoundryFogBridge.js**: `getVisionTexture()` returns white fallback when global light is active.
- **PlayerLightEffect.js**: Skips setting vision mask entirely when global light is active.

Detection logic checks `canvas.environment.globalLightSource.active` (V13+) with darkness range
validation, plus a fallback check on `canvas.scene.globalLight` for older versions.

### What to Check After Testing
1. Look at console logs for `[WorldSpaceFogEffect]` extraction diagnostics
2. Check if `hasNonZeroData=true` and `nonZeroSamples > 0`
3. Check screen size diagnostic for Three.js vs PIXI mismatch
4. If still black: the extraction data is all-zero → investigate WHY the PIXI vision RT is empty
5. If extraction has data but still wrong: UV mapping issue → check screen size mismatch
