# Vision, Detection & Fog of War — Full Foundry Parity Plan

## Status: Implemented
## Priority: High

---

## 1. Executive Summary

This document tracks Map Shine's parity with Foundry VTT's native perception system. **All planned phases have been implemented** (except Phase 7 which is intentionally skipped).

### What Works
- ✅ Basic LOS polygon rendering (from `token.vision.los/shape/fov`)
- ✅ Fog of war overlay (unexplored / explored / visible zones)
- ✅ Exploration persistence (save/load to `FogExploration` document)
- ✅ Global illumination fallback
- ✅ GM bypass (no fog when no tokens selected)
- ✅ Player default (combined vision of owned tokens)
- ✅ Soft edges, noise distortion, visual polish on fog
- ✅ **Token Visibility Testing** — `VisibilityController` delegates to `canvas.visibility.testVisibility()` (Phase 1)
- ✅ **Detection Modes** — all modes (basicSight, lightPerception, darkvision, tremorsense, etc.) via Foundry delegation (Phase 1)
- ✅ **Light-Grants-Vision** — lights with `vision: true` draw into the fog vision mask (Phase 2)
- ✅ **Detection Filters** — glow/outline indicators on tokens detected via special modes (Phase 3)
- ✅ **Vision Mode Rendering** — post-process pass for darkvision desaturation, light amplification tint, etc. (Phase 4)
- ✅ **Darkness Sources** — darkness-emitting lights subtract from the vision mask (Phase 5)
- ✅ **Status Effects** — BLIND, INVISIBLE, BURROW, FLY, HOVER handled via Foundry's `testVisibility()` (Phase 6)

---

## 2. Foundry's Native Architecture (Reference)

### 2.1 Core Classes

| Class | File | Purpose |
|-------|------|---------|
| `DetectionMode` | `perception/detection-mode.mjs` | Base class for all detection types. Defines `testVisibility()`, `_canDetect()`, `_testPoint()`, `_testLOS()`, `_testRange()` |
| `VisionMode` | `perception/vision-mode.mjs` | Defines canvas appearance per-token POV. Configures shaders for background, coloration, illumination, darkness channels |
| `PointVisionSource` | `sources/point-vision-source.mjs` | Represents a token's vision. Has `los`, `shape`/`fov`, `light` polygons, `visionMode`, `isBlinded`, `blinded` record |
| `CanvasVisibility` | `groups/visibility.mjs` | Central rendering hub. Draws vision/light shapes, tests visibility, commits fog, restricts asset visibility |
| `FogManager` | `perception/fog.mjs` | Manages exploration texture lifecycle: load, commit, save, pixel extraction |
| `PerceptionManager` | `perception/perception-manager.mjs` | Orchestrates refresh workflow via render flags: edges → light sources → vision sources → vision modes → sounds → lighting → vision → occlusion |

### 2.2 Detection Modes (Default Set)

| ID | Class | Type | Walls | Angle | Behavior |
|----|-------|------|-------|-------|----------|
| `basicSight` | `DetectionModeDarkvision` | SIGHT | ✅ | ✅ | Standard sight. Blocked by BLIND, INVISIBLE, BURROW |
| `lightPerception` | `DetectionModeLightPerception` | SIGHT | ✅ | ✅ | Like basicSight but also requires `testInsideLight()` — point must be illuminated |
| `seeInvisibility` | `DetectionModeInvisibility` | SIGHT | ✅ | ✅ | Detects INVISIBLE tokens. Applies `GlowOverlayFilter` (green glow) |
| `senseInvisibility` | `DetectionModeInvisibility` | OTHER | ❌ | ❌ | Detects INVISIBLE tokens through walls. `GlowOverlayFilter` |
| `feelTremor` | `DetectionModeTremor` | MOVE | ❌ | ❌ | Detects non-flying/hovering tokens through walls. Wavy `OutlineOverlayFilter` |
| `seeAll` | `DetectionModeAll` | SIGHT | ✅ | ✅ | Sees everything (not blocked by INVISIBLE). `OutlineOverlayFilter` |
| `senseAll` | `DetectionModeAll` | OTHER | ❌ | ❌ | Senses everything through walls. `OutlineOverlayFilter` |

### 2.3 Vision Modes (Default Set)

| ID | Canvas Shader | Lighting Config | Vision Defaults | Notes |
|----|--------------|-----------------|-----------------|-------|
| `basic` | None | Default | `attenuation:0, contrast:0, saturation:0, brightness:0` | Preferred mode, takes priority |
| `darkvision` | `ColorAdjustmentsSampler` (desat) | DIM→BRIGHT, background REQUIRED | `saturation:-1, darkness.adaptive:false` | Greyscale in darkness |
| `monochromatic` | `ColorAdjustmentsSampler` (desat) | Post-process SATURATION on all channels | `saturation:-1, darkness.adaptive:false` | Full monochrome everywhere |
| `blindness` | `ColorAdjustmentsSampler` | All lighting DISABLED | `brightness:-1, saturation:-1, contrast:-0.5` | Auto-assigned when blinded |
| `tremorsense` | `ColorAdjustmentsSampler` | All lighting DISABLED | `brightness:1, saturation:-0.3, contrast:0.2` | Animated wave shaders |
| `lightAmplification` | `AmplificationSampler` | DIM→BRIGHT, BRIGHT→BRIGHTEST, background REQUIRED | `saturation:-0.5, brightness:1` | Green-tinted night vision |

### 2.4 Visibility Testing Pipeline

Foundry's `CanvasVisibility.testVisibility(point, options)` runs this pipeline for each point/object:

```
1. If no active vision sources → GM sees all, players see nothing
2. For each LIGHT SOURCE with vision=true:
   → lightSource.testVisibility(config)
   → If any passes → VISIBLE
3. For each active VISION SOURCE (not blinded):
   a. Test "basicSight" detection mode
      → _canDetect (checks BLIND, INVISIBLE, BURROW status)
      → _testPoint → _testRange + _testLOS
      → If passes → VISIBLE
   b. Test "lightPerception" detection mode
      → Same as basicSight + testInsideLight(point)
      → If passes → VISIBLE
4. If object is NOT a Token → INVISIBLE (special modes only work on tokens)
5. For each active VISION SOURCE, for each SPECIAL detection mode:
   → dm.testVisibility(visionSource, mode, config)
   → If passes → set object.detectionFilter, VISIBLE
6. → INVISIBLE
```

Key details:
- `_createVisibilityTestConfig` creates 9 test points (center + 8 cardinal offsets at `tolerance` distance)
- `_testLOS` checks if the point is inside the vision source's LOS polygon
- `_testRange` checks if the point is within `mode.range` distance
- Special detection modes that pass assign a **detection filter** (`GlowOverlayFilter` or `OutlineOverlayFilter`) to the token mesh

### 2.5 Status Effects

| Status | Effect on Detection |
|--------|-------------------|
| `BLIND` | Source cannot use SIGHT-type detection modes |
| `INVISIBLE` | Target not detected by standard SIGHT modes (requires seeInvisibility/senseInvisibility) |
| `BURROW` | Source/target not detected by wall-respecting modes |
| `FLY` | Target not detected by tremorsense |
| `HOVER` | Target not detected by tremorsense |

### 2.6 Vision Source Blinding

`PointVisionSource.isBlinded` is true when:
- `radius === 0` AND (`lightRadius === 0` OR vision mode doesn't perceive light)
- OR any entry in `blinded` record is true (e.g., `blinded.darkness`, `blinded.blind`, `blinded.burrow`)

The `blinded.darkness` flag is set by `#updateBlindedState()` which checks if the vision source origin is inside a darkness source with higher priority.

### 2.7 Fog Rendering Pipeline

`CanvasVisibility.refreshVisibility()`:
1. Clears all PIXI.Graphics containers (light sources, sight, darkness, previews)
2. Iterates light sources → draws shapes into `vision.light.sources` (or cached/preview variants)
3. Draws light masks for sources with `vision: true`
4. Iterates vision sources → draws `visionSource.shape` into `vision.sight`
5. Draws `visionSource.light` polygon into `vision.light.mask`
6. Calls `canvas.fog.commit()` to accumulate exploration
7. `FogManager.commit()` composites vision into exploration RT, schedules save after COMMIT_THRESHOLD (70) refreshes

---

## 3. Gap Analysis

### 3.1 Our Current Architecture

```
WorldSpaceFogEffect._renderVisionMask()
  ├── Resolves controlled tokens (MapShine selection → Foundry controlled → owned)
  ├── For each token: reads token.vision.los/shape/fov polygon
  ├── Triangulates polygon into THREE.ShapeGeometry
  ├── Renders white shapes into visionRenderTarget
  └── Accumulates into explorationTarget via ping-pong max() shader

WorldSpaceFogEffect.update()
  ├── Checks bypass (GM no tokens, tokenVision disabled)
  ├── Renders vision mask when dirty
  ├── Accumulates exploration
  ├── Composites fog plane: vision + exploration → fog overlay
  └── Fog plane renders as THREE.Mesh in main scene
```

### 3.2 Specific Gaps

#### Gap 1: No Detection Mode Logic
**Foundry**: Each token has a `detectionModes` array. Visibility is tested per-mode with specific rules (range, walls, angle, status effects). Different modes detect different things.
**Us**: We just read the LOS polygon and render it. No concept of detection modes, no status effect checks, no per-mode range.

#### Gap 2: No Token Visibility Testing
**Foundry**: `testVisibility()` determines if each token/note/door is visible to the current viewer. This drives `token.isVisible` → `token.visible`.
**Us**: We render a fog overlay that obscures unexplored areas, but we don't actually test or control whether individual tokens are visible. A token behind fog is still clickable and its Three.js mesh is still rendered — it's just visually covered by the fog plane.

#### Gap 3: No Detection Filters
**Foundry**: Tokens detected via special modes (tremorsense, see invisible) get a visual filter (glow, outline) applied to their PIXI mesh.
**Us**: No equivalent. Tokens detected by special modes would just be fully visible or fully hidden.

#### Gap 4: No Vision Mode Rendering
**Foundry**: Each vision mode configures shaders for the canvas appearance — darkvision desaturates, tremorsense shows waves, light amplification tints green. These are per-source PIXI shaders on the vision layers.
**Us**: The scene always looks the same regardless of what vision mode the controlled token has.

#### Gap 5: No Light-Grants-Vision
**Foundry**: Light sources with `data.vision: true` grant visibility within their area. `testVisibility()` checks light sources before vision sources.
**Us**: We only check token vision polygons. Lights that grant vision are ignored.

#### Gap 6: No Darkness Source Blinding
**Foundry**: Darkness-emitting lights can blind vision sources that are inside them (if the darkness source has higher priority).
**Us**: Not implemented.

#### Gap 7: Exploration Accumulation from Full-Scene Fallback
**Foundry**: The exploration texture only accumulates from real vision polygons drawn into the vision container.
**Us**: We have a `_visionIsFullSceneFallback` guard, but it's a workaround for not properly handling global illumination + zero-range sight.

---

## 4. Implementation Strategy

### Guiding Principle: Delegate to Foundry Where Possible

Foundry's perception system already runs even when the PIXI canvas is hidden (opacity: 0). The PIXI ticker still fires, `PerceptionManager.applyRenderFlags()` still executes, vision sources are still initialized, LOS polygons are still computed, and `testVisibility()` still works. **We should leverage this rather than reimplementing it.**

Our approach splits into two categories:
1. **Things we can delegate to Foundry** (detection logic, visibility testing, status effects, fog persistence)
2. **Things we must implement in Three.js** (visual rendering of vision modes, detection filters, fog overlay)

---

### Phase 1: Token Visibility Testing (Critical)

**Goal**: Tokens in our Three.js scene correctly appear/disappear based on Foundry's visibility logic.

**Approach**: Hook into Foundry's existing `testVisibility()` and use it to drive Three.js token mesh visibility.

**Implementation**:

1. **In `TokenManager` or a new `VisibilityController`**:
   - After each vision refresh (`sightRefresh` / `visibilityRefresh` hook), iterate all token sprites
   - For each token, call `canvas.visibility.testVisibility(token.center, {tolerance, object: token})` using the Foundry placeable
   - Set `tokenSprite.visible` based on the result
   - This automatically handles ALL detection modes, status effects, range checks, and LOS tests

2. **Detection filter tracking**:
   - After `testVisibility()` returns true, check `foundryToken.detectionFilter`
   - If non-null, the token was detected via a special mode → store the filter type for Phase 3

3. **GM handling**:
   - GM with no active vision sources → all tokens visible
   - GM with controlled token → use testVisibility like players

**Files**: New `scripts/vision/VisibilityController.js` or extend `scripts/scene/token-manager.js`

**Complexity**: Low — we're calling Foundry's existing API, not reimplementing it.

---

### Phase 2: Light-Source-Grants-Vision (High)

**Goal**: Lights with `vision: true` contribute to the fog of war vision mask.

**Approach**: When rendering the vision mask in `WorldSpaceFogEffect._renderVisionMask()`, also draw shapes from light sources that have `data.vision: true`.

**Implementation**:

1. In `_renderVisionMask()`, after drawing token vision polygons:
   ```
   for each lightSource in canvas.effects.lightSources:
     if lightSource.data.vision && lightSource.active:
       draw lightSource.shape into visionScene
   ```

2. The light source shapes are available as `lightSource.shape` — same polygon format as vision sources.

3. This also affects exploration accumulation: areas lit by vision-granting lights should be marked as explored.

**Files**: `scripts/effects/WorldSpaceFogEffect.js`

**Complexity**: Low — same polygon rendering we already do for vision sources.

---

### Phase 3: Detection Filter Rendering (Medium)

**Goal**: Tokens detected via special detection modes (tremorsense, see invisible, etc.) display visual indicators (glow, outline effects).

**Approach**: Apply post-process effects to specific token meshes in our Three.js pipeline.

**Implementation**:

1. **Detection filter types** (from Foundry):
   - `GlowOverlayFilter` — used by `seeInvisibility`/`senseInvisibility`. Green glow (`[0, 0.60, 0.33, 1]`)
   - `OutlineOverlayFilter` — used by `seeAll`/`senseAll` (red outline), `feelTremor` (wavy outline)

2. **Three.js equivalents**:
   - **Glow**: Render token to a small offscreen RT, apply radial blur/glow shader, composite back with additive blending
   - **Outline**: Render token silhouette, detect edges via Sobel/jump-flood, draw colored outline
   - Both can be implemented as a selective post-process pass that only affects flagged tokens

3. **Integration with Phase 1**:
   - `VisibilityController` tracks which tokens have a detection filter and what type
   - The effect composer applies the appropriate filter during the render pass

**Files**: New `scripts/effects/DetectionFilterEffect.js`, modifications to token render pipeline

**Complexity**: Medium — requires new shader work for glow/outline, but well-understood techniques.

---

### Phase 4: Vision Mode Rendering (Medium-High)

**Goal**: The scene appearance changes based on the active token's vision mode (darkvision desaturation, tremorsense waves, light amplification green tint).

**Approach**: Implement vision mode effects as Three.js post-processing passes that activate/deactivate based on the controlled token's `sight.visionMode`.

**Implementation**:

1. **Read active vision mode**:
   ```javascript
   const controlled = canvas.tokens.controlled[0]; // or MapShine selection
   const visionMode = controlled?.document?.sight?.visionMode ?? 'basic';
   const vmConfig = CONFIG.Canvas.visionModes[visionMode];
   ```

2. **Vision mode post-process effects**:

   | Vision Mode | Three.js Effect |
   |-------------|----------------|
   | `basic` | No post-processing |
   | `darkvision` | Desaturation pass (`saturation: -1.0`) applied to areas in darkness |
   | `monochromatic` | Full desaturation pass on entire viewport |
   | `blindness` | Heavy desaturation + contrast reduction + brightness reduction |
   | `tremorsense` | Wave distortion shader (animated) + desaturation |
   | `lightAmplification` | Green tint (`[0.38, 0.8, 0.38]`) + brightness boost + desaturation |

3. **Implementation approach**:
   - Create a `VisionModeEffect` post-process pass
   - Reads `vmConfig.canvas.uniforms` and `vmConfig.vision.defaults` for shader parameters
   - Applies color adjustments (saturation, contrast, brightness, tint) in screen space
   - For mode-specific shaders (tremorsense waves), implement dedicated shader variants
   - Only affects the **vision area** (not explored-but-not-visible areas, which should look normal under fog)

4. **Lighting level remapping** (advanced):
   - Darkvision treats DIM as BRIGHT
   - Light amplification treats DIM→BRIGHT and BRIGHT→BRIGHTEST
   - This affects how our `ThreeLightSource` renders light intensities
   - Could be implemented as a uniform that scales light contribution per-channel

**Files**: New `scripts/effects/VisionModeEffect.js`, modifications to effect composer

**Complexity**: Medium-High — the basic desaturation/tint is simple, but correctly scoping effects to only the vision area (not fog) and handling lighting level remapping requires careful integration.

---

### Phase 5: Darkness Source Integration (Medium)

**Goal**: Darkness-emitting lights suppress vision and can blind tokens inside them.

**Approach**: Foundry already computes darkness blinding on the `PointVisionSource` (`blinded.darkness` flag). We need to:

1. **Render darkness into the vision mask**:
   - Darkness sources should subtract from the vision mask (make areas dark again)
   - In `_renderVisionMask()`, after drawing vision polygons in white, draw darkness source shapes in black
   - Or better: let Foundry handle this and use the composited result

2. **Token blinding**:
   - Already handled by Foundry's `PointVisionSource.#updateBlindedState()`
   - When `isBlinded` is true, the vision source's radius collapses to `externalRadius`
   - Our system reads the resulting `shape`/`los` polygon which already reflects this

3. **Visual representation**:
   - Darkness areas should appear as impenetrable dark zones in the fog overlay
   - Could render darkness source shapes as additional fog regions

**Files**: `scripts/effects/WorldSpaceFogEffect.js`

**Complexity**: Medium — the logic is in Foundry, but we need to correctly render the visual result.

---

### Phase 6: Status Effect Awareness (Low)

**Goal**: Our visibility system respects BLIND, INVISIBLE, BURROW, FLY, HOVER status effects.

**Approach**: Entirely delegated to Foundry. Since Phase 1 uses `canvas.visibility.testVisibility()`, all status effect logic is already handled by Foundry's `DetectionMode._canDetect()` methods.

**What we need**:
- When a token's status effects change, trigger a visibility refresh
- Hook into `_onApplyStatusEffect` or `updateToken` to know when to re-test visibility
- The `visibilityRefresh` / `sightRefresh` hooks already fire when Foundry detects these changes

**Files**: Handled by Phase 1's hook registrations

**Complexity**: Low — no custom implementation needed.

---

### Phase 7: Fog Exploration Changes — ⚠️ DANGEROUS — DO NOT IMPLEMENT

> **WARNING**: The current fog of war and exploration system (`WorldSpaceFogEffect.js`) is **working correctly**. Any attempt to refactor, simplify, or delegate exploration persistence to Foundry's native `FogManager` risks regressing to a non-working state. The current system was hard-won through multiple iterations of bug fixes (Y-flip, global illumination black screen, extraction timing, RED format gotchas, etc.).
>
> **Do not touch the exploration pipeline.** Leave it as-is.

---

## 5. Priority Order

| Phase | Priority | Effort | Impact |
|-------|----------|--------|--------|
| **Phase 1**: Token Visibility Testing | 🔴 Critical | Low | Tokens correctly hidden/shown based on all detection modes |
| **Phase 2**: Light-Grants-Vision | 🟠 High | Low | Lights with vision:true reveal fog |
| **Phase 6**: Status Effects | 🟡 Medium | Low | Free with Phase 1 |
| **Phase 3**: Detection Filters | 🟡 Medium | Medium | Visual feedback for special detection |
| **Phase 5**: Darkness Sources | 🟡 Medium | Medium | Darkness areas properly block vision |
| **Phase 4**: Vision Mode Rendering | 🔵 Low-Med | Medium-High | Darkvision/tremorsense visual effects |
| **Phase 7**: Fog Exploration | ⛔ DANGEROUS | N/A | DO NOT IMPLEMENT — current system works, risk of regression |

---

## 6. Technical Considerations

### 6.1 Foundry API Stability

We rely on these Foundry APIs:
- `canvas.visibility.testVisibility(point, options)` — stable, public API
- `canvas.effects.visionSources` — stable collection
- `canvas.effects.lightSources` — stable collection
- `token.vision.los/shape/fov` — stable since v10
- `token.document.detectionModes` — stable since v11
- `token.document.sight.visionMode` — stable since v11
- `CONFIG.Canvas.detectionModes` — stable registry
- `CONFIG.Canvas.visionModes` — stable registry

### 6.2 Performance

- **Token visibility testing** runs per-token per-vision-refresh. With 50 tokens and 2 vision sources, that's 100 calls to `testVisibility()`. Each call tests up to 9 offset points against all detection modes. This is already what Foundry does natively — we just call it.
- **Vision mode post-processing** is a single full-screen pass. Low cost.
- **Detection filters** only apply to the small number of tokens detected by special modes. Low cost.

### 6.3 Rendering Order

Our fog plane sits at `renderOrder: 9999` on `OVERLAY_THREE_LAYER`. Detection filters need to render on top of the fog for detected-but-not-visible tokens. This means:
- Tokens behind fog → hidden (mesh.visible = false)
- Tokens in vision → visible normally
- Tokens detected by special mode → visible with glow/outline, potentially through fog

The detection filter rendering may need its own render pass after the fog plane.

### 6.4 Separation of Concerns

```
Foundry (PIXI, hidden) ──────────────────────────────
  ├── PerceptionManager → refresh pipeline
  ├── PointVisionSource → LOS polygons, blinding
  ├── DetectionMode → visibility testing logic
  ├── VisionMode → mode configuration
  ├── CanvasVisibility → testVisibility()
  └── FogManager → exploration persistence

Map Shine (Three.js, visible) ────────────────────────
  ├── WorldSpaceFogEffect → fog overlay rendering
  │   ├── Vision mask (LOS polygon → RT)
  │   ├── Exploration accumulation
  │   └── Fog plane compositing
  ├── VisibilityController (NEW) → token visibility
  │   ├── Calls Foundry testVisibility()
  │   ├── Drives token mesh visibility
  │   └── Tracks detection filter state
  ├── DetectionFilterEffect (NEW) → glow/outline
  │   └── Renders filter effects on flagged tokens
  └── VisionModeEffect (NEW) → canvas appearance
      └── Post-process pass for active vision mode
```

---

## 7. Files Affected

### New Files
- `scripts/vision/VisibilityController.js` — Token visibility testing (Phase 1)
- `scripts/effects/DetectionFilterEffect.js` — Glow/outline rendering (Phase 3)
- `scripts/effects/VisionModeEffect.js` — Vision mode post-processing (Phase 4)

### Modified Files
- `scripts/effects/WorldSpaceFogEffect.js` — Add light-grants-vision (Phase 2), darkness rendering (Phase 5), simplify exploration (Phase 7)
- `scripts/scene/token-manager.js` — Integrate with VisibilityController for mesh visibility
- `scripts/effects/EffectComposer.js` — Register new effect passes

### Potentially Removable (after full implementation)
- `scripts/vision/VisionManager.js` — Self-computed vision polygons (unused, superseded by WorldSpaceFogEffect reading Foundry's polygons directly)
- `scripts/vision/VisionPolygonComputer.js` — Custom raycasting (unused)
- `scripts/vision/GeometryConverter.js` — Polygon→BufferGeometry (unused)
- `scripts/vision/FogManager.js` — Old fog persistence (unused, superseded by WorldSpaceFogEffect's own exploration pipeline)
- `scripts/vision/FoundryFogBridge.js` — PIXI texture bridge (unused since WorldSpaceFogEffect reads polygons directly)

---

## 8. Testing Strategy

### Manual Test Scenes
1. **Basic visibility**: Token A can see Token B. Token B moves behind a wall → disappears. Moves back → reappears.
2. **Darkvision**: Token with darkvision sees in darkness. Token without darkvision only sees lit areas.
3. **Invisible token**: Token with INVISIBLE status. Normal tokens can't see it. Token with seeInvisibility can → green glow.
4. **Tremorsense**: Token with feelTremor detects ground-contact tokens through walls → wavy outline. Flying token not detected.
5. **Light-grants-vision**: Torch with `vision: true`. Tokens in torch range visible through fog.
6. **Darkness source**: Darkness-emitting light. Token inside it becomes blinded.
7. **Global illumination**: Scene with global light. All tokens visible regardless of sight range.
8. **Mixed modes**: Token with both basicSight and feelTremor. Verify correct layering of detection results.

### Automated Verification
- Extend Playwright perf bench to include visibility testing scenarios
- Verify that `testVisibility()` calls match expected results for known token configurations

---

## 9. Migration Notes

- No data migration needed — all detection/vision mode data is stored in Foundry's token documents
- Our existing fog exploration data remains compatible
- The feature is additive — existing fog behavior is preserved, new capabilities are layered on top
- Each phase can be shipped independently without breaking existing functionality
