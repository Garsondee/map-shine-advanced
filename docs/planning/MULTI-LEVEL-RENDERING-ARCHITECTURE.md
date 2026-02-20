# Multi-Level Rendering Architecture

## Problem Statement

The current rendering system was designed for single-floor scenes. Multi-level support (via the Levels module) was bolted on as a series of hooks and redistributions. This has led to a fragile state management problem where:

1. **Effects own mutable mask state** that any external code path can destroy
2. **Foundry hooks fire unpredictably** — the Levels module fires `updateTile` with `flags` changes continuously during and after floor switches, and MapShine has no control over when or how often these fire
3. **Level changes trigger cascading side effects** through debounced timers, async rebuilds, and hook-driven invalidations that race against each other
4. **Each effect manages its own mask lifecycle independently** — there is no central authority that owns mask state, leading to N different failure modes for N effects
5. **The "preserve vs replace" decision is scattered** across per-effect special cases in a 150-line redistribution block

The specific recurring bug: water effect data gets destroyed when switching to an upper floor that has no water mask. Despite multiple fix attempts (suppress flags, UUID guards, timer-based protection, relevance filter changes), external code paths keep finding ways to null out the water data.

## Current Architecture (What We Have)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Foundry VTT (PIXI)                           │
│  Hooks: createTile, updateTile, deleteTile,                     │
│         mapShineLevelContextChanged                             │
└──────────────┬──────────────────────────────────────────────────┘
               │ (hooks fire unpredictably)
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  canvas-replacement.js  (orchestrator)                           │
│                                                                  │
│  mapShineLevelContextChanged hook:                               │
│    1. Set suppress flags (synchronous)                           │
│    2. await rebuildMasksForActiveLevel()    ← async, slow        │
│    3. Per-effect redistribution block       ← 150+ lines         │
│       - WeatherController.setRoofMap()                           │
│       - LightingEffect.setBaseMesh()                             │
│       - WindowLightEffect.setBaseMesh()                          │
│       - SpecularEffect.setBaseMesh()                             │
│       - FireSparksEffect.setAssetBundle()                        │
│       - WaterEffectV2 (conditional)         ← special case       │
│       - DustMotesEffect.setAssetBundle()                         │
│       - AshDisturbanceEffect.setAssetBundle()                    │
│       - MaskManager.setTexture()                                 │
│       ...                                                        │
└──────────────┬───────────────────────────────────────────────────┘
               │ (each effect called individually)
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Individual Effects (each owns its own mask state)               │
│                                                                  │
│  WaterEffectV2:                                                  │
│    this.waterMask = texture                                      │
│    this._waterData = sdf result                                  │
│    this._lastWaterMaskUuid = uuid                                │
│    this._suppressExternalCacheClear = flag                       │
│    clearCaches() ← called by TileManager, UI, resetScene         │
│                                                                  │
│  SpecularEffect:                                                 │
│    this.specularMask = texture                                   │
│    this._savedAlbedoTexture = texture                            │
│                                                                  │
│  (etc. for each of ~12 mask-consuming effects)                   │
└──────────────────────────────────────────────────────────────────┘
               ▲
               │ (also called independently via hooks)
┌──────────────┴───────────────────────────────────────────────────┐
│  TileManager                                                     │
│    updateTile hook → _scheduleWaterCacheInvalidation(150ms)      │
│                    → waterEffect.clearCaches()                   │
│    (fires for ANY tile change including Levels flag updates)     │
└──────────────────────────────────────────────────────────────────┘
```

### Key Weaknesses

| Problem | Description |
|---|---|
| **No central mask ownership** | Each effect stores its own copy of mask references. Any code path that calls `setBaseMesh` or `clearCaches` can destroy an effect's state. There is no single source of truth for "what masks are currently active." |
| **Hook-driven invalidation is too broad** | `TileManager._scheduleWaterCacheInvalidation` fires on ANY tile update with geometry OR flag changes. Levels visibility toggles are flag changes. There's no way to distinguish "user moved a tile" from "Levels toggled visibility." |
| **Async timing races** | `rebuildMasksForActiveLevel` is async. Foundry hooks fire synchronously. The 150ms debounce timer in TileManager can fire during the async rebuild, before the redistribution block has decided what to do with each effect. |
| **Per-effect special cases** | Water needs "preserve if no mask on new floor." Fire needs "clean up if no mask." Windows needs "re-enable if mask returns." Each special case is hand-coded in the redistribution block. Adding a new effect or changing behavior requires editing the redistribution block. |
| **`setBaseMesh` is destructive by design** | Most effects treat `setBaseMesh` as "replace everything." There's no concept of "update masks only" vs "full rebuild." Redistribution calls `setBaseMesh` even when only mask textures changed, potentially triggering expensive shader recompilation. |

## Proposed Architecture: Level-Aware Effect State Manager

### Core Principle

**Separate mask ownership from effect consumption.** Effects should not own mask textures — they should read them from a central registry. Level changes update the registry; effects observe the registry.

### Design

```
┌─────────────────────────────────────────────────────────────────┐
│                    Foundry VTT (PIXI)                           │
│  Hooks: createTile, updateTile, deleteTile,                     │
│         mapShineLevelContextChanged                             │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  EffectMaskRegistry  (NEW — single source of truth)              │
│                                                                  │
│  Per-mask-type slots:                                            │
│    registry.get('water')     → { texture, floor, frozen }        │
│    registry.get('outdoors')  → { texture, floor, frozen }        │
│    registry.get('specular')  → { texture, floor, frozen }        │
│    registry.get('windows')   → { texture, floor, frozen }        │
│    registry.get('fire')      → { texture, floor, frozen }        │
│    ...                                                           │
│                                                                  │
│  Per-mask-type policies:                                         │
│    'water':    { preserveAcrossFloors: true,  rebuildOn: [] }    │
│    'fire':     { preserveAcrossFloors: false, rebuildOn: [] }    │
│    'outdoors': { preserveAcrossFloors: false, rebuildOn: [] }    │
│    'windows':  { preserveAcrossFloors: false, rebuildOn: [] }    │
│    'specular': { preserveAcrossFloors: false, rebuildOn: [] }    │
│                                                                  │
│  Methods:                                                        │
│    setMasks(floor, maskArray)  — bulk update from compositor     │
│    getMask(type)               — read current mask               │
│    freeze(type)                — prevent external changes        │
│    unfreeze(type)              — allow changes again             │
│    onChange(type, callback)    — subscribe to mask changes        │
│    onFloorChange(callback)    — subscribe to floor transitions   │
│                                                                  │
│  Tile invalidation:                                              │
│    onTileChange(tileDoc, changes) — filters irrelevant changes   │
│    Only propagates to effects when mask-relevant properties      │
│    actually changed (geometry/texture, NOT flags)                │
└──────────────┬───────────────────────────────────────────────────┘
               │ (observer pattern — effects subscribe)
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Effects (consumers — read-only access to masks)                 │
│                                                                  │
│  WaterEffectV2:                                                  │
│    constructor: registry.onChange('water', this._onWaterMask)    │
│    _onWaterMask(texture):                                        │
│      if (texture === this._currentWaterMask) return; // no-op    │
│      this._rebuildSDF(texture);                                  │
│    // No more clearCaches() called externally                    │
│    // No more _suppressExternalCacheClear flag                   │
│    // No more setBaseMesh() for mask updates                     │
│                                                                  │
│  SpecularEffect:                                                 │
│    constructor: registry.onChange('specular', this._onSpecMask)  │
│    _onSpecMask(texture):                                         │
│      this.material.uniforms.uSpecularMask.value = texture;       │
│    // Direct uniform update, no shader recompilation             │
│                                                                  │
│  (etc.)                                                          │
└──────────────────────────────────────────────────────────────────┘
```

### Key Concepts

#### 1. Mask Slots with Policies

Each mask type has a **slot** in the registry and a **policy** that controls its behavior during floor transitions:

```javascript
// Policy definition
const MASK_POLICIES = {
  water:     { preserveAcrossFloors: true,  disposeOnClear: false },
  fire:      { preserveAcrossFloors: false, disposeOnClear: true  },
  outdoors:  { preserveAcrossFloors: false, disposeOnClear: false },
  windows:   { preserveAcrossFloors: false, disposeOnClear: false },
  specular:  { preserveAcrossFloors: false, disposeOnClear: false },
  tree:      { preserveAcrossFloors: false, disposeOnClear: false },
  bush:      { preserveAcrossFloors: false, disposeOnClear: false },
  iridescence: { preserveAcrossFloors: false, disposeOnClear: false },
  prism:     { preserveAcrossFloors: false, disposeOnClear: false },
};
```

- **`preserveAcrossFloors: true`** — When switching to a floor that has no mask of this type, keep the existing mask. Only replace when the new floor provides one. This solves the water problem: water is a ground-plane effect visible from all floors.
- **`preserveAcrossFloors: false`** — Clear the mask when the new floor doesn't have one. Fire, outdoors, etc. are floor-specific.
- **`disposeOnClear: true`** — Dispose derived GPU resources (like fire position maps) when clearing. Most effects just null the texture reference.

#### 2. Floor Transition Protocol

Instead of the current scattered redistribution, floor transitions follow a single protocol:

```javascript
// In EffectMaskRegistry
async transitionToFloor(newFloorMasks, floorContext) {
  this._transitioning = true;
  
  // Phase 1: Determine what changes
  const changes = new Map();
  for (const [type, policy] of this._policies) {
    const newMask = newFloorMasks.find(m => m.type === type)?.texture ?? null;
    const current = this._slots.get(type)?.texture ?? null;
    
    if (newMask) {
      // New floor provides this mask — always use it
      changes.set(type, { action: 'replace', texture: newMask });
    } else if (policy.preserveAcrossFloors && current) {
      // No mask on new floor, but policy says preserve — keep current
      changes.set(type, { action: 'preserve' });
    } else {
      // No mask on new floor, policy says clear
      changes.set(type, { action: 'clear' });
    }
  }
  
  // Phase 2: Apply changes atomically
  for (const [type, change] of changes) {
    if (change.action === 'replace') {
      this._setSlot(type, change.texture, floorContext);
    } else if (change.action === 'clear') {
      this._clearSlot(type);
    }
    // 'preserve' — do nothing, slot stays as-is
  }
  
  // Phase 3: Notify subscribers (effects rebuild as needed)
  for (const [type, change] of changes) {
    if (change.action !== 'preserve') {
      this._notifySubscribers(type);
    }
  }
  
  this._transitioning = false;
}
```

#### 3. Tile Change Filtering

The registry owns the tile-change relevance logic, not TileManager:

```javascript
// In EffectMaskRegistry
onTileChange(tileDoc, changes) {
  // During floor transitions, ignore all tile changes
  if (this._transitioning) return;
  
  // Only mask-relevant properties trigger invalidation
  const keys = changes ? Object.keys(changes) : [];
  const maskRelevant = keys.some(k => 
    k === 'x' || k === 'y' || k === 'width' || 
    k === 'height' || k === 'rotation' || k === 'texture'
  );
  if (!maskRelevant) return;
  
  // Debounce and rebuild only affected mask types
  this._scheduleRebuild(tileDoc);
}
```

This eliminates the current problem where Levels flag changes trigger water invalidation.

#### 4. Effect Subscription API

Effects subscribe to mask changes instead of being pushed state via `setBaseMesh`:

```javascript
class WaterEffectV2 {
  connectToRegistry(registry) {
    this._maskRegistryUnsub = registry.onChange('water', (texture) => {
      if (texture === this.waterMask) return; // Same texture, no-op
      if (!texture) {
        // Mask cleared — dispose SDF data
        this._disposeSDF();
        return;
      }
      // New mask — rebuild SDF
      this.waterMask = texture;
      this._rebuildWaterDataIfNeeded(true);
    });
  }
  
  // No more external clearCaches() calls needed
  // No more _suppressExternalCacheClear flag
  // No more UUID guards
}
```

#### 5. Override System

For edge cases and future extensibility, the registry supports per-mask overrides:

```javascript
// Force a specific mask to stay even when floor changes
registry.override('water', {
  preserveAcrossFloors: true,  // override default policy
  lockTexture: someTexture,     // force a specific texture
});

// Clear override — revert to policy defaults
registry.clearOverride('water');
```

This handles weird edge cases without modifying the core transition logic.

### Migration Path

The registry can be introduced incrementally:

| Phase | Scope | Risk |
|---|---|---|
| **Phase 0: Registry + Water only** | Create `EffectMaskRegistry`. Migrate water mask management. Other effects unchanged. | Low — single effect, reversible |
| **Phase 1: Tile change filtering** | Move tile-change relevance logic from TileManager to registry. Registry owns `onTileChange`. | Low — logic already exists, just relocating |
| **Phase 2: Observer pattern for all masks** | Migrate remaining effects (specular, windows, fire, outdoors, tree, bush, etc.) to subscribe to registry. Remove per-effect `setBaseMesh` mask extraction. | Medium — many effects touched |
| **Phase 3: Remove redistribution block** | The `mapShineLevelContextChanged` handler calls `registry.transitionToFloor()` instead of per-effect redistribution. | Medium — large code removal |
| **Phase 4: Override system** | Add per-mask overrides for edge cases. Expose in UI for map makers. | Low — additive |

### Phase 0 Detail: Fix Water NOW

Before building the full registry, we can fix the immediate water bug with a minimal version of the registry concept:

**Create a `WaterMaskGuard`** — a thin wrapper that:
1. Holds the authoritative water mask reference
2. Is the ONLY thing that can set `waterEffect.waterMask`
3. Ignores external `clearCaches()` calls entirely during floor transitions
4. Has a `_transitioning` flag that is set synchronously at level-change hook entry and cleared after the async redistribution completes (not on a timer)

```javascript
class WaterMaskGuard {
  constructor(waterEffect) {
    this._effect = waterEffect;
    this._transitioning = false;
    this._preservedMask = null;
  }
  
  beginFloorTransition() {
    this._transitioning = true;
    // Snapshot current state
    this._preservedMask = this._effect.waterMask;
  }
  
  endFloorTransition(newFloorHasWater, newBundle) {
    if (newFloorHasWater) {
      // New floor provides water — use it
      this._effect.setBaseMesh(this._effect.baseMesh, newBundle);
    } else if (this._preservedMask) {
      // No water on new floor — restore preserved mask
      // (it was never actually removed, but ensure consistency)
      this._effect.waterMask = this._preservedMask;
    }
    this._transitioning = false;
    this._preservedMask = null;
  }
  
  // Called by TileManager via _scheduleWaterCacheInvalidation
  externalClearCaches() {
    if (this._transitioning) return; // Blocked during transitions
    // Delegate to actual clearCaches only if mask genuinely changed
    this._effect.clearCaches();
  }
}
```

The key difference from the current approach: **the guard is synchronous, has no timers, and uses a simple boolean `_transitioning` flag that is set/cleared at well-defined points in the floor transition lifecycle.** No race conditions possible because:
- Set synchronously at hook entry (before any async work)
- Cleared synchronously at the end of the redistribution block (after all decisions made)
- No timers, no debounce, no async gaps

## Files Affected

| File | Current Role | Proposed Change |
|---|---|---|
| `scripts/core/EffectMaskRegistry.js` | NEW | Central mask state manager |
| `scripts/foundry/canvas-replacement.js` | Orchestrator + redistribution | Replace 150-line redistribution block with `registry.transitionToFloor()` |
| `scripts/scene/tile-manager.js` | Tile hooks + water invalidation | Delegate tile-change filtering to registry |
| `scripts/effects/WaterEffectV2.js` | Owns water mask state + clearCaches | Subscribe to registry, remove external clearCaches |
| `scripts/effects/SpecularEffect.js` | Owns specular mask state | Subscribe to registry |
| `scripts/effects/WindowLightEffect.js` | Owns window/outdoors/specular masks | Subscribe to registry |
| `scripts/particles/FireSparksEffect.js` | Owns fire mask state | Subscribe to registry |
| `scripts/effects/TreeEffect.js` | Owns tree mask state | Subscribe to registry |
| `scripts/effects/BushEffect.js` | Owns bush mask state | Subscribe to registry |
| `scripts/effects/IridescenceEffect.js` | Owns iridescence mask state | Subscribe to registry |
| `scripts/effects/PrismEffect.js` | Owns prism mask state | Subscribe to registry |
| `scripts/foundry/effect-wiring.js` | BASE_MESH_EFFECTS + wireBaseMeshes | Registry wiring replaces setBaseMesh for masks |

## Success Criteria

1. **Water persists on upper floor** — switching floors never destroys ground-floor water
2. **No suppress flags, timers, or UUID guards** — the architecture prevents the problem instead of patching it
3. **Adding a new mask-consuming effect** requires only: define a policy + subscribe to registry
4. **Floor transitions are atomic** — no intermediate states where some effects have new masks and others have old
5. **Tile flag changes from Levels** never trigger mask invalidation
6. **Override system** allows map makers or future features to customize per-mask behavior

## Open Questions

1. Should the registry also own the compositor's output textures (preventing double-dispose)?
2. Should `setBaseMesh` be split into `setGeometry` (mesh/plane) vs `setMasks` (textures only)?
3. Should effects that don't use masks at all (FilmGrain, Sharpen, etc.) skip registry entirely?
4. How does this interact with the per-tile overlay system (SpecularEffect tile overlays)?

---

# Part 2: The Big Picture — Universal Multi-Tile Effect Rendering

## Vision Statement

The goal is a rendering architecture where **any number of tiles can independently contribute any number of effects, layered and masked correctly**, regardless of how many floors exist, how many tiles overlap, or how effects interact with each other.

The current system was designed for a single battlemap image with a matching set of suffix masks. The proposed system treats every tile as a first-class rendering entity that can host its own effects, participate in scene-wide composites, and be correctly ordered relative to other tiles, tokens, and post-processing.

### Key Principles

1. **Tiles are the atomic rendering unit** — not scenes, not floors. Every visible tile can contribute masks, host effects, and participate in the rendering pipeline.
2. **Scene-space composites are derived, not primary** — the compositor aggregates per-tile masks into scene-space textures for effects that need them, but per-tile data is the source of truth.
3. **Tokens are elevation-aware entities** — they exist at a specific elevation, interact with the floor they stand on, and must be correctly occluded by overhead geometry above them.
4. **Effects are consumers, not owners** — effects read from the EffectMaskRegistry and render based on what the registry provides. They don't manage mask lifecycle.
5. **Render order is deterministic and elevation-aware** — the Z-sorting pipeline must correctly handle multi-floor scenes where ground-floor water is visible under an upper-floor building.

---

## Section 3: Token Rendering Architecture

### 3.1 Current Token Rendering Model

Tokens are rendered as `THREE.Sprite` objects added directly to the scene graph. Key characteristics:

```
Token Rendering Pipeline (Current):
  ┌─────────────────────────────────────────────────────────────┐
  │  TokenManager                                                │
  │                                                              │
  │  Per Token:                                                  │
  │    THREE.Sprite with SpriteMaterial                          │
  │    - texture loaded async from tokenDoc.texture.src          │
  │    - transparent=true, alphaTest=0.1                         │
  │    - depthTest=false, depthWrite=false                       │
  │    - sizeAttenuation=true (perspective scaling)              │
  │    - layers.set(0)  (main scene, included in post-processing)│
  │    - matrixAutoUpdate=false (manual transform)               │
  │                                                              │
  │  Z Position:                                                 │
  │    groundZ + TOKEN_BASE_Z(3.0) + tokenDoc.elevation          │
  │                                                              │
  │  Visibility:                                                 │
  │    - VisibilityController is sole authority when active       │
  │    - Syncs from Foundry's isVisible + level-band filtering   │
  │    - Tokens above active level's top boundary are hidden     │
  │                                                              │
  │  Color Correction:                                           │
  │    - onBeforeCompile injects CC uniforms into SpriteMaterial │
  │    - Window light sampling in screen-space                   │
  │    - Underground saturation reduction                        │
  │    - Global lighting tint from scene darkness level           │
  │                                                              │
  │  Overlays (children of sprite):                              │
  │    - Selection border (LineLoop on OVERLAY_THREE_LAYER=31)   │
  │    - Name label (Sprite on OVERLAY_THREE_LAYER)              │
  │    - Target indicators (arrows + pips on OVERLAY_THREE_LAYER)│
  └─────────────────────────────────────────────────────────────┘
```

### 3.2 Token Rendering Gaps

| Gap | Description | Impact |
|---|---|---|
| **No per-floor token lighting** | Token color correction uses a global darkness tint. When LightingEffect is active, tokens are set to white (neutral) and rely on the post-processing composite. But the lighting composite is scene-wide — it doesn't distinguish between light hitting a ground-floor token vs an upper-floor token. | A token on Floor 2 could be lit by Floor 1's campfire if the campfire light has enough radius. |
| **No token shadow casting** | Tokens don't cast shadows onto the ground plane or onto other tokens. Overhead shadows exist for tiles but not for tokens. | Tokens feel "pasted on" rather than inhabiting the world. |
| **No token depth interaction** | `depthTest=false, depthWrite=false` means tokens always render on top of everything in their Z-band. A token standing behind a foreground pillar tile is still fully visible. | Breaks spatial immersion in scenes with foreground architectural elements. |
| **No token-to-effect interaction** | Tokens don't interact with water (no ripples, no reflection, no distortion masking), fire (no heat shimmer around tokens), or specular (no shadow on wet ground). | Effects feel disconnected from token presence. |
| **Elevation scale is crude** | Level-aware token scaling uses `max(0.3, min(1.0 / (abs(tokenElev-viewerElev)/8), 1))` — a simple inverse-distance formula. Tokens on the same floor always render at scale 1.0, tokens far above/below shrink. | Adequate for multi-floor but doesn't support fine-grained perspective depth (e.g., a flying token at +5 elevation should be slightly smaller). |
| **Token mask not used by all effects** | `LightingEffect` renders a `tokenMask.screen` render target, but not all effects that should exclude tokens actually sample it. Water distortion can warp tokens. | Visual artifacts where post-processing effects bleed into token rendering. |

### 3.3 Proposed Token Rendering Improvements

#### 3.3.1 Token Depth Integration

Enable selective depth interaction so tokens can be occluded by foreground tiles:

```
New Token Depth Model:
  ┌────────────────────────────────────────────────────┐
  │  Token Sprite:                                      │
  │    depthTest = true   (read depth buffer)           │
  │    depthWrite = true  (write to depth buffer)       │
  │    renderOrder = 100  (after tiles, before overlay) │
  │                                                     │
  │  Foreground Tile:                                    │
  │    depthTest = true                                 │
  │    depthWrite = true                                │
  │    Z = groundZ + Z_FOREGROUND_OFFSET + sortOffset   │
  │                                                     │
  │  Result:                                            │
  │    Token behind a foreground pillar → occluded      │
  │    Token on top of foreground tile → visible         │
  │    Token at same Z as foreground tile → depth test   │
  └────────────────────────────────────────────────────┘
```

**Challenges:**
- THREE.Sprite depth testing against 3D geometry requires careful Z positioning
- Tokens are billboards; their depth footprint is a single depth value at their center
- Need to ensure token overlays (borders, labels) are NOT depth-tested (they must always be visible)
- Alpha-tested tokens need `alphaTest` or alpha-to-coverage to produce correct depth writes

**Recommendation:** Introduce a `tokenDepthInteraction` setting (default off for backwards compat). When enabled:
1. Token sprites get `depthTest=true, depthWrite=true`
2. Foreground tiles get `depthWrite=true` (already the case)
3. Token overlays stay on `OVERLAY_THREE_LAYER` with `depthTest=false`
4. Optional: render tokens in a pre-pass to the depth buffer for effects that need token silhouettes

#### 3.3.2 Per-Floor Token Lighting

Tokens should receive lighting appropriate to their floor:

```
Per-Floor Token Lighting:
  ┌─────────────────────────────────────────────────────┐
  │  LightingEffect already renders:                     │
  │    - lightTarget (scene-space light accumulation)    │
  │    - roofAlphaTarget (overhead transparency)         │
  │                                                      │
  │  Proposed:                                           │
  │    - Token CC shader samples lightTarget at token    │
  │      screen-space position                           │
  │    - Applies floor-aware light intensity:            │
  │      if token is UNDER a roof (outdoors mask < 0.5)  │
  │        → use indoor lighting from lightTarget        │
  │      if token is OUTDOORS                            │
  │        → use outdoor ambient + dynamic lights        │
  │    - Roof alpha modulates token visibility for       │
  │      tokens under partially-transparent roofs        │
  └─────────────────────────────────────────────────────┘
```

This can be done by extending the existing `tWindowLight` sampling in the token CC shader to also sample `tLightingTarget` and `tOutdoorsMask`.

#### 3.3.3 Token-Effect Interactions

Future token-effect interactions, ordered by visual impact:

| Interaction | Mechanism | Priority |
|---|---|---|
| **Water distortion exclusion** | Token mask (already exists) sampled by WaterEffectV2 to skip distortion over tokens | P0 — prevents visual artifacts |
| **Token shadow on ground** | Projected shadow sprite (child of token) rendered into shadow buffer, sampled by LightingEffect | P1 — major immersion boost |
| **Water ripples at token position** | TokenManager notifies WaterEffectV2 of token world positions; water shader generates concentric ripple displacement | P2 — nice-to-have |
| **Heat shimmer around tokens near fire** | DistortionManager checks token proximity to heat sources; applies shimmer to tokens within range | P3 — polish |
| **Token reflection in water** | Render token sprites flipped into a reflection buffer below the water plane; WaterEffectV2 composites reflection | P3 — advanced |

#### 3.3.4 Token Render Order in Multi-Level Scenes

The critical ordering requirement:

```
Correct render order (bottom to top):
  1. Scene background (groundZ + 0)
  2. Background tiles (groundZ + 1.0 + sort offset)
  3. Ground-level effects (water, specular, etc.)
  4. Foreground tiles (groundZ + 2.0 + sort offset)
  5. Tokens (groundZ + 3.0 + elevation)
  6. Overhead tiles / roofs (groundZ + 4.0 + sort offset)
  7. Particles (fire, rain, snow — various Z)
  8. Post-processing (screen-space: lighting, bloom, fog, etc.)
  9. Overlay layer (token borders, labels, UI — OVERLAY_THREE_LAYER)

Multi-floor extension:
  - Each floor's tiles get an elevation offset: groundZ + layerOffset + tileElevation
  - Tokens at elevation E render at groundZ + 3.0 + E
  - Floor 1 token (elev=0) at Z=3.0, Floor 2 token (elev=10) at Z=13.0
  - Floor 2 tile (elev=10) at Z=14.0 (overhead) or Z=12.0 (foreground)
  - Depth buffer naturally resolves occlusion between floors
```

---

## Section 4: Per-Tile Effect Rendering Architecture

### 4.1 The Dual Pipeline Model

Effects need TWO rendering pathways, depending on whether they operate in scene-space or tile-space:

```
┌─────────────────────────────────────────────────────────────┐
│  Pipeline A: Scene-Space Effects                             │
│  (Post-processing / full-screen)                             │
│                                                              │
│  Input: Scene-space composite masks from EffectMaskRegistry  │
│  Render: Full-screen quad with scene texture as input        │
│  Examples: LightingEffect, WaterEffectV2, BloomEffect,       │
│            AtmosphericFogEffect, AsciiEffect, CloudEffect    │
│                                                              │
│  These effects operate on the entire frame. They sample       │
│  scene-space mask textures (from the compositor) to           │
│  determine where their effect applies.                        │
│                                                              │
│  Multi-tile support: Compositor aggregates per-tile masks     │
│  into a single scene-space texture. The effect doesn't know   │
│  or care about individual tiles.                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Pipeline B: Per-Tile Effects                                │
│  (Overlay meshes attached to individual tiles)               │
│                                                              │
│  Input: Per-tile mask textures from TileManager._tileEffectMasks│
│  Render: Overlay mesh positioned/scaled/rotated to match tile │
│  Examples: SpecularEffect (per-tile overlays),               │
│            FluidEffect (per-tile flow overlays),              │
│            Future: per-tile normal mapping, per-tile emission │
│                                                              │
│  These effects render an overlay mesh for EACH tile that has  │
│  the relevant mask. The overlay inherits the tile's transform │
│  (position, rotation, scale, flip).                           │
│                                                              │
│  Multi-tile support: Natural — one overlay per tile,          │
│  positioned correctly in world space.                         │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Which Effects Should Be Per-Tile vs Scene-Space?

| Effect | Current | Proposed | Rationale |
|---|---|---|---|
| **SpecularEffect** | Scene-space base + per-tile overlays | Per-tile overlays (primary) + scene-space fallback | Per-tile is already working well; scene composite is only for base plane |
| **FluidEffect** | Per-tile only | Per-tile only | Fluid flow is inherently per-tile |
| **WaterEffectV2** | Scene-space only | Scene-space (compositor) | Water is a ground-plane phenomenon; SDF generation requires contiguous scene-space data |
| **LightingEffect** | Scene-space only | Scene-space (compositor) | Lighting is global |
| **FireSparksEffect** | Scene-space only | Scene-space (compositor) + per-tile spawn zones | Particles spawn from scene-space fire mask, but could benefit from per-tile fire intensity data |
| **WindowLightEffect** | Scene-space only | Scene-space (compositor) | Window glow is projected across scene space |
| **BuildingShadowsEffect** | Scene-space only | Scene-space (compositor) | Shadow projection is global |
| **TreeEffect** | Scene-space only | **Per-tile candidate** | Tree canopy RGBA textures could render as per-tile overlays for correct transform/layering |
| **BushEffect** | Scene-space only | **Per-tile candidate** | Same reasoning as TreeEffect |
| **IridescenceEffect** | Scene-space only | **Per-tile candidate** | Iridescence is a surface effect; per-tile overlays would match tile transforms correctly |
| **PrismEffect** | Scene-space only | Scene-space (compositor) | Refraction samples the scene texture, needs full-screen access |
| **DustMotesEffect** | Scene-space only | Scene-space (compositor) | Particle spawning from scene-space mask |
| **AshDisturbanceEffect** | Scene-space only | Scene-space (compositor) | Same as dust |

### 4.3 Per-Tile Effect Overlay Architecture

For effects that should be per-tile, the pattern is:

```javascript
// In TileManager, when a tile's masks are loaded:
for (const [maskType, maskData] of tileMasks) {
  const effect = effectRegistry.getEffectForMaskType(maskType);
  if (effect && typeof effect.bindTileSprite === 'function') {
    effect.bindTileSprite(tileDoc, sprite, maskData.texture);
  }
}

// In the Effect class:
bindTileSprite(tileDoc, sprite, maskTexture) {
  // Create overlay mesh matching tile transform
  const overlay = this._createOverlayMesh(tileDoc, maskTexture);
  // Position overlay at tile's world position
  this._syncOverlayTransform(overlay, sprite);
  // Add to scene
  this.scene.add(overlay);
  // Track for cleanup
  this._tileOverlays.set(tileDoc.id, overlay);
}
```

**Key requirements for per-tile overlays:**
1. Transform sync — overlay must match tile position, rotation, scale, and flip
2. Elevation — overlay Z must match tile Z (layer offset + elevation + sort offset)
3. Visibility — overlay visible only when tile is visible (level-band, hidden, alpha)
4. Cleanup — overlay disposed when tile is removed or mask changes
5. Animation — TileMotionManager must be able to update overlay transforms each frame
6. Depth — overlay must use correct depth settings to interact with other tiles and tokens

### 4.4 Scene-Space Compositor Architecture

The `SceneMaskCompositor` (already partially implemented) needs these capabilities:

```
SceneMaskCompositor
  │
  ├── Input: List<{tileDoc, masks: Map<maskType, texture>}>
  │
  ├── Per mask type:
  │     ├── Determine composition mode (lighten / source-over)
  │     ├── Create scene-sized canvas at target resolution
  │     ├── Sort tiles by Z-order (sort key + elevation)
  │     ├── For each tile:
  │     │     ├── Skip if not on active floor (level-band check)
  │     │     ├── Skip if not visible
  │     │     ├── Apply tile transform (x, y, width, height, rotation, flip)
  │     │     ├── Blit tile's mask into scene-space position
  │     │     └── Use composition mode for layering
  │     └── Output: THREE.Texture with .image (canvas) for CPU consumers
  │
  ├── Cache: per-floor-key → Map<maskType, texture>
  │
  ├── Invalidation triggers:
  │     ├── Level switch (different tile set)
  │     ├── Tile CRUD (tile added/removed/moved)
  │     ├── Tile texture change (mask reloaded)
  │     └── NOT: Levels flag changes (filtered out)
  │
  └── Output: feeds into EffectMaskRegistry slots
```

### 4.5 Compositor-to-Registry Flow

```
Scene Load / Level Switch
  │
  ├── TileManager: load per-tile masks for all visible tiles
  │
  ├── SceneMaskCompositor: compose scene-space masks
  │     ├── _Fire composite → lighten mode
  │     ├── _Water composite → lighten mode
  │     ├── _Outdoors composite → source-over mode
  │     ├── _Windows composite → source-over mode
  │     ├── _Specular composite → source-over mode
  │     └── (etc.)
  │
  ├── EffectMaskRegistry: receive composited masks
  │     ├── registry.setMasks(floor, compositorOutput)
  │     ├── Apply preserve/clear policies
  │     └── Notify subscribers
  │
  ├── Scene-Space Effects: receive notifications
  │     ├── LightingEffect._onMaskChanged('outdoors', tex)
  │     ├── WaterEffectV2._onMaskChanged('water', tex)
  │     ├── FireSparksEffect._onMaskChanged('fire', tex)
  │     └── (etc.)
  │
  └── Per-Tile Effects: bind directly from TileManager
        ├── SpecularEffect.bindTileSprite(tileDoc, sprite, specTex)
        ├── FluidEffect.bindTileSprite(tileDoc, sprite, fluidTex)
        └── (etc.)
```

---

## Section 5: Unified Render Order & Layer System

### 5.1 Current Layer System

The current system uses THREE.js layers and Z-offsets to control render order:

| Layer | ID | Purpose |
|---|---|---|
| Default (0) | 0 | Main scene objects — tiles, tokens, surface effects |
| ROOF_LAYER | 20 | Overhead/roof tiles — used by LightingEffect for roof alpha capture |
| WEATHER_ROOF_LAYER | 21 | Weather-blocking roofs — used by particle systems for indoor suppression |
| WATER_OCCLUDER_LAYER | 22 | Water occluder meshes — used by DistortionManager |
| CLOUD_SHADOW_BLOCKER | 23 | Tiles that block cloud shadows |
| CLOUD_TOP_BLOCKER | 24 | Tiles that block cloud rendering |
| ROPE_MASK_LAYER | 25 | Rope physics mask |
| BLOOM_HOTSPOT_LAYER | 30 | Bloom hotspot meshes |
| OVERLAY_THREE_LAYER | 31 | UI overlays (borders, labels, indicators) — rendered AFTER post-processing |

### 5.2 Z-Layer Ordering (Current)

```
Z Position = groundZ + layerOffset + elevationOffset + sortOffset

Where:
  groundZ          = camera-derived ground plane Z (typically 0)
  layerOffset      = Z_BACKGROUND_OFFSET (1.0) | Z_FOREGROUND_OFFSET (2.0) |
                     TOKEN_BASE_Z (3.0) | Z_OVERHEAD_OFFSET (4.0)
  elevationOffset  = tileDoc.elevation (maps directly to Z units)
  sortOffset       = tileDoc.sort * 0.001 (sub-layer ordering within a band)
```

### 5.3 Proposed Unified Render Order

The rendering pipeline needs a clear, deterministic order for all objects:

```
Frame Rendering Order:
  ═══════════════════════════════════════════════════════════
  PHASE 0: PRE-RENDER PASSES (off-screen)
  ───────────────────────────────────────────────────────────
  0a. Depth Pre-Pass (DepthPassManager)
      - Renders all depth-writing objects to a depth texture
      - Used by effects for depth-aware sampling

  0b. Roof Alpha Capture (LightingEffect)
      - Renders ROOF_LAYER tiles to roofAlphaTarget
      - Used by particle occlusion, lighting indoor/outdoor gating

  0c. Token Mask Capture (LightingEffect)
      - Renders token silhouettes to tokenMask.screen
      - Used by effects that should exclude tokens (water distortion)

  0d. Light Accumulation (LightingEffect)
      - Renders point/cone light meshes to lightTarget
      - Accumulates dynamic light contributions

  0e. Shadow Passes (OverheadShadowsEffect, BuildingShadowsEffect)
      - Renders shadow geometry to shadow render targets
      - Used by lighting composite

  ═══════════════════════════════════════════════════════════
  PHASE 1: SCENE RENDER (to sceneRenderTarget or screen)
  ───────────────────────────────────────────────────────────
  1a. Scene Effects UPDATE + RENDER (sorted by layer.order)
      - BASE (0): ground plane with albedo
      - MATERIAL (100): SpecularEffect, NormalEffect overlays
      - SURFACE_EFFECTS (200): Water, Iridescence, Prism overlays
      - PARTICLES (300): Fire, dust, ash, weather particles
      - ENVIRONMENTAL (400): Clouds, atmospheric fog
      Each effect: update(timeInfo) → render(renderer, scene, camera)

  1b. Main Scene Render
      - renderer.render(scene, camera) with OVERLAY_THREE_LAYER disabled
      - Renders: background, BG tiles, FG tiles, tokens, overhead tiles,
        surface overlays, particles — all in one draw call
      - THREE.js depth buffer handles occlusion naturally
      - Object renderOrder used for fine-grained control within same Z

  ═══════════════════════════════════════════════════════════
  PHASE 2: POST-PROCESSING (ping-pong buffers)
  ───────────────────────────────────────────────────────────
  2a. Lighting composite (LightingEffect)
      - Combines scene texture + light accumulation + shadows
      - Applies indoor/outdoor ambient + darkness

  2b. Water distortion (WaterEffectV2 / DistortionManager)
      - UV distortion based on water mask + SDF
      - Token mask exclusion

  2c. Bloom (BloomEffect)
      - Extracts bright regions, blurs, composites

  2d. Color grading / film grain / sharpen / etc.
      - Final aesthetic passes

  2e. Last effect renders to screen (null target)

  ═══════════════════════════════════════════════════════════
  PHASE 3: OVERLAY RENDER (directly to screen)
  ───────────────────────────────────────────────────────────
  3a. _renderOverlayToScreen()
      - Renders OVERLAY_THREE_LAYER (31) objects directly to screen
      - Token borders, name labels, target indicators
      - NOT affected by post-processing (bloom, color grading, etc.)

  3b. _renderDepthDebugOverlay() (debug only)
  ═══════════════════════════════════════════════════════════
```

### 5.4 Multi-Floor Render Order Correctness

For multi-floor scenes, the critical question is: **what happens when objects from different floors are visible simultaneously?**

```
Example: Floor 1 (elev 0-10) has water + tokens. Floor 2 (elev 10-20) has a building.
User is viewing Floor 1 (active level).

Objects in scene:
  - Floor 1 background tile:    Z = 0 + 1.0 + 0 = 1.0
  - Floor 1 water effect:       Z ≈ 0 (ground plane, surface effect)
  - Floor 1 token (elev=0):     Z = 0 + 3.0 + 0 = 3.0
  - Floor 2 building tile:      HIDDEN by updateSpriteVisibility (not on active floor)
  - Floor 2 overhead tile:      Z = 0 + 4.0 + 10 = 14.0 (rendered as roof, captured in roofAlpha)

Result: Floor 1 water renders on ground. Token renders above water.
        Floor 2 building is invisible. Floor 2 overhead provides roof occlusion
        for particles and lighting.  ✅ CORRECT
```

**Edge case: simultaneous floor visibility (peeling away roofs)**

When a user hover-hides a roof, the floor beneath becomes visible. If both floors have tokens:

```
Floor 1 token (elev=0):  Z = 3.0  → visible
Floor 2 token (elev=10): Z = 13.0 → hidden by VisibilityController (above active level top)
```

This is correct — the VisibilityController hides tokens above the active level's top boundary. But what if we want to show a "preview" of upper-floor tokens (e.g., transparent silhouettes)?

**Future enhancement:** Add a `ghostUpperFloorTokens` option that renders above-level tokens at reduced opacity on a separate render pass.

---

## Section 6: Effect-Tile Binding System

### 6.1 The Binding Problem

Currently, effects are bound to the scene, not to individual tiles. When a tile moves (TileMotionManager), its per-tile overlays must move with it. When a tile is hidden (level switch), its overlays must be hidden. When a tile's mask changes, its overlays must be rebuilt.

This creates N synchronization points for N per-tile effects, each independently tracking tile state.

### 6.2 Proposed: TileEffectBindingManager

A centralized manager that owns the binding between tiles and their per-tile effects:

```
TileEffectBindingManager (NEW)
  │
  ├── Per tile:
  │     ├── tileId → {
  │     │     tileDoc,
  │     │     sprite,
  │     │     masks: Map<maskType, texture>,
  │     │     bindings: Map<effectId, overlayMesh>,
  │     │     visible: boolean,
  │     │     floorKey: string
  │     │   }
  │     │
  │     ├── On tile create/load:
  │     │     1. Load per-tile masks via TileManager.loadAllTileMasks()
  │     │     2. For each mask, find matching effect
  │     │     3. Call effect.bindTileSprite(tileDoc, sprite, mask)
  │     │     4. Store overlay reference in bindings map
  │     │
  │     ├── On tile transform change:
  │     │     1. Sync all overlay transforms from sprite
  │     │     2. effect.syncTileSpriteTransform(tileId, sprite)
  │     │
  │     ├── On tile visibility change:
  │     │     1. Set all overlays visible/hidden to match tile
  │     │     2. effect.syncTileSpriteVisibility(tileId, sprite)
  │     │
  │     ├── On tile delete:
  │     │     1. Call effect.unbindTileSprite(tileId) for each binding
  │     │     2. Dispose overlay meshes
  │     │     3. Clear bindings map
  │     │
  │     └── On level switch:
  │           1. For newly hidden tiles: set overlays hidden
  │           2. For newly visible tiles: ensure bindings exist, set visible
  │           3. Recompose scene-space masks via compositor
  │
  ├── API:
  │     registerEffect(maskType, effect)    — register effect for a mask type
  │     onTileReady(tileId, tileDoc, sprite, masks) — tile is ready for binding
  │     onTileTransformChanged(tileId, sprite)      — sprite transform updated
  │     onTileVisibilityChanged(tileId, visible)    — tile shown/hidden
  │     onTileRemoved(tileId)                       — tile deleted
  │     onLevelChanged(newFloorContext)              — active floor changed
  │
  └── Integration:
        - Created in canvas-replacement.js alongside TileManager
        - TileManager calls binding manager at appropriate lifecycle points
        - Effects register themselves during initialization
```

### 6.3 Effect Interface for Tile Binding

Effects that support per-tile rendering implement this interface:

```javascript
// In EffectBase (optional interface)
class TileBindableEffect {
  /** Called when a tile with a matching mask is ready */
  bindTileSprite(tileDoc, sprite, maskTexture) {}

  /** Called when a bound tile's transform changes */
  syncTileSpriteTransform(tileId, sprite) {}

  /** Called when a bound tile's visibility changes */
  syncTileSpriteVisibility(tileId, sprite) {}

  /** Called when a bound tile is removed */
  unbindTileSprite(tileId) {}

  /** Returns the mask type(s) this effect binds to */
  getTileBindingMaskTypes() { return []; }
}
```

This is already partially implemented by `SpecularEffect` and `FluidEffect`. The proposal standardizes the pattern.

---

## Section 7: EffectMaskRegistry — Detailed Design

### 7.1 Registry Slot Model

```javascript
class EffectMaskRegistry {
  // Per-mask-type slot
  _slots = new Map();  // maskType → { texture, floorKey, source, timestamp }

  // Per-mask-type policy
  _policies = new Map();  // maskType → MaskPolicy

  // Per-mask-type subscribers
  _subscribers = new Map();  // maskType → Set<callback>

  // Global floor transition state
  _transitioning = false;
  _activeFloorKey = null;

  // Compositor reference
  _compositor = null;  // SceneMaskCompositor
}

// Slot data
interface MaskSlot {
  texture: THREE.Texture | null;   // Current scene-space composite texture
  floorKey: string | null;         // "${bottom}:${top}" of the floor this mask belongs to
  source: 'compositor' | 'bundle' | 'override';  // How this mask was set
  timestamp: number;               // When this mask was last updated
}

// Policy definition
interface MaskPolicy {
  preserveAcrossFloors: boolean;   // Keep mask when switching to a floor without this type
  disposeOnClear: boolean;         // Dispose GPU resources when clearing slot
  recomposeOnTileChange: boolean;  // Trigger recomposition when a tile changes
  compositionMode: 'lighten' | 'source-over';  // How per-tile masks combine
  resolutionClass: 'data' | 'visual' | 'color'; // Determines max resolution
}
```

### 7.2 Floor Transition Lifecycle

```
Floor Transition (detailed):
  ┌────────────────────────────────────────────────────────┐
  │ 1. SYNCHRONOUS: Set _transitioning = true              │
  │    (Blocks all external tile-change-driven invalidation)│
  │                                                         │
  │ 2. SYNC: Update tile visibility for new floor           │
  │    (TileManager._refreshAllTileElevationVisibility)     │
  │                                                         │
  │ 3. ASYNC: Compositor composes masks for new floor       │
  │    - Collect visible tiles on new floor                  │
  │    - Load per-tile masks (cached or from disk)           │
  │    - Compose scene-space masks per type                  │
  │                                                         │
  │ 4. SYNC: Registry applies new masks                      │
  │    For each mask type:                                   │
  │      - new mask exists → replace slot, notify            │
  │      - no mask, policy.preserveAcrossFloors → keep slot  │
  │      - no mask, !preserve → clear slot, notify           │
  │                                                         │
  │ 5. SYNC: Update per-tile bindings                        │
  │    - Hide overlays for tiles no longer visible           │
  │    - Show/create overlays for newly visible tiles        │
  │                                                         │
  │ 6. SYNC: Set _transitioning = false                      │
  │    (Re-enables external tile-change invalidation)        │
  └────────────────────────────────────────────────────────┘
```

### 7.3 Tile Change Filtering Logic

```javascript
// In EffectMaskRegistry
onTileChange(tileDoc, changes) {
  // During floor transitions, ignore all tile changes
  if (this._transitioning) return;

  // Classify the change
  const keys = changes ? Object.keys(changes) : [];

  // Geometry/texture changes → recompose affected mask types
  const geometryChanged = keys.some(k =>
    k === 'x' || k === 'y' || k === 'width' || k === 'height' ||
    k === 'rotation' || k === 'texture'
  );

  // Elevation/sort changes → re-evaluate Z ordering in compositor
  const elevationChanged = keys.some(k =>
    k === 'elevation' || k === 'sort' || k === 'z'
  );

  // Visibility changes → tile may enter/leave the composition set
  const visibilityChanged = keys.some(k =>
    k === 'hidden' || k === 'alpha'
  );

  // Flag-only changes (Levels, tile motion, etc.) → IGNORE
  // This is the critical filter that prevents Levels flag updates
  // from triggering mask invalidation.
  if (!geometryChanged && !elevationChanged && !visibilityChanged) return;

  // Debounce and recompose
  this._scheduleRecompose(tileDoc, { geometryChanged, elevationChanged, visibilityChanged });
}
```

---

## Section 8: Memory & Performance Architecture

### 8.1 Memory Budget Model

With per-tile mask loading, memory usage scales with `tiles × maskTypes × resolution²`:

```
Memory estimation for a multi-tile scene:

Scene: 4 tiles × 12 mask types average
Per-tile mask: 1024×1024 RGBA = 4 MB
Total per-tile: 4 × 12 × 4 MB = 192 MB  (worst case, all tiles have all masks)

Scene-space composites: 12 types × 2048×2048 = 12 × 16 MB = 192 MB

Total: ~384 MB (theoretical maximum)

Realistic: Most tiles have 3-5 masks → 4 × 4 × 4 MB + 12 × 16 MB = 256 MB
```

### 8.2 Memory Management Strategy

```
Memory Management:
  ┌────────────────────────────────────────────────────────┐
  │ Tier 1: Active Floor (always in memory)                 │
  │   - Per-tile masks for all tiles on active floor        │
  │   - Scene-space composites for active floor             │
  │   - Total: ~128 MB typical                              │
  │                                                         │
  │ Tier 2: Preloaded Floors (cached, evictable)            │
  │   - Per-tile masks for other visited floors              │
  │   - Scene-space composites from _levelMaskCache          │
  │   - Eviction: LRU when cache exceeds _levelMaskCacheMax │
  │   - Total: ~128 MB per cached floor                     │
  │                                                         │
  │ Tier 3: Unused Masks (not loaded)                        │
  │   - Mask types for disabled effects → not loaded         │
  │   - Tiles with bypassEffects → not loaded                │
  │   - Tiles too small to meaningfully contribute → skipped │
  │                                                         │
  │ Budget Enforcement:                                      │
  │   - Track total allocated texture memory                 │
  │   - When approaching budget (default 1 GB):              │
  │     1. Evict oldest non-active floor cache entries        │
  │     2. Downscale visual masks from 8192→4096              │
  │     3. Skip non-critical mask types (iridescence, prism)  │
  │   - Hard cap: refuse to load new masks until space freed  │
  └────────────────────────────────────────────────────────┘
```

### 8.3 Lazy Effect Initialization

Effects that have no mask on the active floor should not compile shaders:

```
Lazy Effect Lifecycle:
  1. Scene load: compositor produces masks for ground floor
  2. FireSparksEffect: no _Fire mask → effect stays disabled, no shader compile
  3. User switches to Floor 2 which has _Fire mask
  4. Registry notifies FireSparksEffect with new texture
  5. FireSparksEffect: lazy-initializes (compiles shader, builds position map)
  6. User switches back to Floor 1 (no fire)
  7. Registry notifies with null texture
  8. FireSparksEffect: disposes position map, keeps shader compiled (cheap)
```

This prevents unnecessary GPU work on scene load when many effects have no masks.

---

## Section 9: Diagnostic & Debug Architecture

### 9.1 Mask Debug Overlay

A visual diagnostic mode that shows which tile contributed each region of each mask:

```
Debug Overlay Modes:
  ┌────────────────────────────────────────────────────────┐
  │ Mode 1: Mask Source Visualization                       │
  │   - Each tile's contribution to the composite is        │
  │     tinted a unique color                               │
  │   - Overlap regions show the dominant tile's color       │
  │   - Renders as a screen overlay with alpha blend         │
  │                                                         │
  │ Mode 2: Per-Mask-Type Toggle                            │
  │   - Show/hide individual mask types in the composite     │
  │   - Toggle _Fire, _Water, _Outdoors, etc. independently │
  │   - Useful for diagnosing "why does fire appear here?"   │
  │                                                         │
  │ Mode 3: Registry State Inspector                         │
  │   - Tweakpane panel showing:                             │
  │     - Active floor key                                   │
  │     - Per-mask-type: texture resolution, source tile,    │
  │       subscriber count, last update timestamp            │
  │     - Cache entries and memory usage                     │
  │     - Transition state (transitioning / idle)            │
  │                                                         │
  │ Mode 4: Tile Effect Binding Inspector                    │
  │   - Per-tile: which effects are bound, overlay visibility│
  │   - Per-effect: which tiles have overlays                │
  │   - Highlight orphaned overlays (binding leak detection) │
  └────────────────────────────────────────────────────────┘
```

### 9.2 Performance Metrics

The registry should track and expose:

```javascript
registry.getMetrics() → {
  activeFloorKey: string,
  transitioning: boolean,
  slots: {
    [maskType]: {
      hasTexture: boolean,
      resolution: { w, h },
      source: string,
      subscriberCount: number,
      lastUpdateMs: number
    }
  },
  compositor: {
    lastComposeMs: number,
    tileCount: number,
    maskTypesProduced: string[],
    cacheHitRate: number
  },
  memory: {
    perTileMasksMB: number,
    compositesMB: number,
    totalMB: number,
    budgetMB: number
  }
}
```

---

## Section 10: Migration & Phased Rollout

### 10.1 Phase 0: EffectMaskRegistry (Foundation)

**Scope:** Create the registry, migrate water mask management only.

| Task | Description | Risk |
|---|---|---|
| Create `EffectMaskRegistry` class | Slots, policies, subscription API | Low |
| Migrate water mask to registry | WaterEffectV2 subscribes instead of receiving via setBaseMesh | Low |
| Wire registry into level-switch hook | `registry.transitionToFloor()` replaces water-specific redistribution | Low |
| Remove `_suppressExternalCacheClear` | Registry prevents the race condition that required it | Low |

### 10.2 Phase 1: All Masks Through Registry

**Scope:** Migrate all mask-consuming effects to subscribe to the registry.

| Task | Description | Risk |
|---|---|---|
| Migrate fire, outdoors, windows, specular, etc. | Each effect subscribes to its mask type(s) | Medium |
| Move tile-change filtering to registry | Registry owns `onTileChange` logic, TileManager delegates | Low |
| Remove per-effect redistribution from canvas-replacement.js | `transitionToFloor()` replaces 150+ line block | Medium |
| Verify backwards compatibility | Single-tile scenes produce identical output | Low |

### 10.3 Phase 2: Per-Tile Compositor

**Scope:** SceneMaskCompositor produces scene-space masks from per-tile data.

| Task | Description | Risk |
|---|---|---|
| Generic per-tile mask loading in TileManager | All suffix types, not just water/specular/fluid | Medium |
| Compositor composition pipeline | Per-mask-type modes, tile transforms, Z-sorting | Large |
| Replace `rebuildMasksForActiveLevel` internals | Compositor feeds into registry instead of direct distribution | Medium |
| Cache management and preloading | Per-floor compositor cache, background preload | Medium |

### 10.4 Phase 3: TileEffectBindingManager

**Scope:** Centralized per-tile effect binding and lifecycle management.

| Task | Description | Risk |
|---|---|---|
| Create `TileEffectBindingManager` | Owns tile-to-effect overlay lifecycle | Medium |
| Migrate SpecularEffect per-tile overlays | Use binding manager instead of direct TileManager calls | Medium |
| Migrate FluidEffect per-tile overlays | Same pattern | Low |
| Add per-tile binding for TreeEffect, BushEffect | Convert from scene-space to per-tile overlays | Medium |

### 10.5 Phase 4: Token Rendering Improvements

**Scope:** Token depth interaction, per-floor lighting, token-effect interactions.

| Task | Description | Risk |
|---|---|---|
| Token depth integration (optional setting) | depthTest/depthWrite for token sprites | Medium |
| Token lighting from lightTarget | CC shader samples light accumulation texture | Medium |
| Water distortion token exclusion | WaterEffectV2 samples tokenMask.screen | Low |
| Token shadow projection | Shadow sprite per token, rendered to shadow buffer | Large |

### 10.6 Phase 5: Memory & Performance

**Scope:** Budget enforcement, lazy initialization, diagnostic tooling.

| Task | Description | Risk |
|---|---|---|
| VRAM budget tracking and enforcement | Track allocations, enforce cap, graceful degradation | Medium |
| Lazy effect initialization from registry | Effects compile shaders only when mask arrives | Medium |
| Diagnostic overlay and metrics | Tweakpane debug panels, mask source visualization | Low |
| Performance regression testing | Benchmark single-tile and multi-tile scenes | Low |

---

## Section 11: Architecture Diagram — Complete System

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Foundry VTT (PIXI)                                │
│  Hooks: createTile, updateTile, deleteTile, refreshToken,                │
│         mapShineLevelContextChanged, sightRefresh                        │
└─────────────┬────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  TileManager                                                              │
│    - Loads tile textures + per-tile suffix masks                          │
│    - Manages tile sprites (transform, visibility, Z-ordering)            │
│    - Delegates to TileEffectBindingManager for per-tile effects          │
│    - Delegates to SceneMaskCompositor for scene-space mask composition   │
│    - _tileEffectMasks: Map<tileId, Map<maskType, {url, texture}>>        │
└─────────────┬──────────────────┬─────────────────────────────────────────┘
              │                  │
     ┌────────┘                  └──────────┐
     ▼                                      ▼
┌─────────────────────────┐   ┌──────────────────────────────────────────┐
│ TileEffectBindingManager │   │ SceneMaskCompositor                      │
│                          │   │                                          │
│ Per-tile overlay lifecycle│  │ Composes per-tile masks → scene-space    │
│ - bindTileSprite()       │   │ - Per-type composition modes             │
│ - syncTransform()        │   │ - Z-sorted tile blitting                 │
│ - syncVisibility()       │   │ - Level-band filtering                   │
│ - unbindTileSprite()     │   │ - Cache per floor key                    │
│                          │   │                                          │
│ Registered effects:      │   │ Output: Map<maskType, THREE.Texture>     │
│ - SpecularEffect         │   └────────────────┬─────────────────────────┘
│ - FluidEffect            │                     │
│ - TreeEffect (future)    │                     ▼
│ - BushEffect (future)    │   ┌──────────────────────────────────────────┐
│ - IridescenceEffect (fut)│   │ EffectMaskRegistry                       │
└──────────────────────────┘   │                                          │
                                │ Slots: water, fire, outdoors, windows,   │
              ┌─────────────────│   specular, tree, bush, iridescence, ... │
              │                 │ Policies: preserve/clear/dispose          │
              │                 │ Subscribers: per-type callback sets       │
              │                 │                                          │
              │                 │ Tile change filtering:                    │
              │                 │   geometry/texture → recompose            │
              │                 │   flags-only → IGNORE                     │
              │                 │   during transition → BLOCK ALL           │
              │                 └────────────────┬─────────────────────────┘
              │                                  │ (observer pattern)
              │                                  ▼
              │                 ┌──────────────────────────────────────────┐
              │                 │ Scene-Space Effects (subscribers)         │
              │                 │                                          │
              │                 │ LightingEffect      ← outdoors           │
              │                 │ WaterEffectV2        ← water              │
              │                 │ WindowLightEffect    ← windows, outdoors  │
              │                 │ FireSparksEffect     ← fire               │
              │                 │ BuildingShadowsEffect← outdoors           │
              │                 │ CloudEffect          ← outdoors           │
              │                 │ DustMotesEffect      ← dust, outdoors     │
              │                 │ AshDisturbanceEffect ← ash                │
              │                 │ WeatherController    ← outdoors (roof map)│
              │                 │ MaskManager          ← all types          │
              │                 │ DistortionManager    ← fire, water        │
              │                 └──────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  EffectComposer                                                           │
│                                                                           │
│  render(deltaTime):                                                       │
│    0. Pre-render passes (depth, roof alpha, token mask, lights, shadows)  │
│    1. Scene effects update + render (sorted by layer order)               │
│    2. Main scene render (all objects on layer 0 + ROOF_LAYER)             │
│    3. Post-processing chain (lighting → water → bloom → color → screen)  │
│    4. Overlay render (OVERLAY_THREE_LAYER → screen, no post-processing)  │
│                                                                           │
│  TokenManager (updatable):                                                │
│    - Token sprites at Z = groundZ + 3.0 + elevation                      │
│    - Color correction shader with lighting/window sampling                │
│    - Visibility controlled by VisibilityController                       │
│    - Overlays on OVERLAY_THREE_LAYER (borders, labels, targets)          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Section 12: Success Criteria (Expanded)

### Foundation Criteria (must achieve)
1. **Water persists on upper floor** — ground-floor water never destroyed by floor switch
2. **No suppress flags, timers, or UUID guards** — architecture prevents the problem
3. **Adding a new mask-consuming effect** requires only: define a policy + subscribe to registry
4. **Floor transitions are atomic** — no intermediate states
5. **Tile flag changes from Levels never trigger mask invalidation**

### Multi-Tile Criteria (target)
6. **Foreground tile masks work** — a building tile's _Fire mask produces fire on the building
7. **Multiple overlapping tiles compose correctly** — terrain _Outdoors overridden by building _Outdoors in overlap
8. **Per-tile effects transform correctly** — rotated, flipped, scaled tiles have correct overlays
9. **Compositor output matches single-tile output** — zero regression for single-tile scenes

### Token Criteria (stretch)
10. **Tokens occluded by foreground tiles** — optional depth integration
11. **Tokens receive floor-appropriate lighting** — indoor tokens darker, outdoor tokens lit
12. **Water distortion doesn't affect tokens** — token mask exclusion in water shader
13. **Token shadows on ground plane** — projected shadow sprites

### Performance Criteria (guardrails)
14. **Scene load time not regressed** — lazy loading + preload ensures no additional stall
15. **Level switch < 100ms** — cached compositor output, no disk I/O
16. **VRAM usage under 1 GB** — budget enforcement with graceful degradation
17. **60 FPS maintained** — no per-frame compositor work; composition is event-driven

---

## Section 13: Relationship to Existing Plans

| Document | Relationship |
|---|---|
| `LEVELS-TILE-EFFECT-MASKING-PLAN.md` | **Subsumed** — the per-tile compositor and mask loading from that plan are incorporated here as Phase 2. The detailed appendices (A-J) remain the authoritative reference for mask consumer inventory and water/particle isolation analysis. |
| `WALLS-LEVEL-SCOPING-AUDIT-PLAN.md` | **Complementary** — wall scoping is orthogonal to tile/effect rendering. Walls affect LOS/fog/pathfinding, not the mask composition pipeline. |
| `CEL-SHADED-INK-FILTER-PLAN.md` | **Complementary** — cel shading is a post-processing effect that benefits from the clean scene render produced by this architecture. It subscribes to the depth buffer and scene texture, not to mask slots. |
| `TOKEN-MOVEMENT-MANAGER-PLAN.md` | **Complementary** — token movement affects token positions, which interact with this architecture through the Z-ordering and visibility systems. Flying tokens at non-zero elevation benefit from the per-floor token rendering model. |
| `FOUNDRY-GLOBAL-PARITY-CHECK-PLAN.md` | **Complementary** — parity items (targeting, ruler, delete safety) are UI/interaction concerns. This plan focuses on rendering. |

---

## Section 14: Design Decisions (Resolved)

### D1: Compositor — **GPU render targets for all mask types**

**Decision**: Use GPU `THREE.WebGLRenderTarget` for all compositor output.

**Rationale**: CPU canvas 2D has a hard ceiling — compositing a 4096×4096 scene with 8 tiles and 12 mask types requires sequential CPU pixel manipulation that is measurably slow (50–200ms) at high resolutions. GPU render targets execute in parallel, are already the native format for shader consumption, and eliminate the `texture.needsUpdate` upload stall. The `.image` requirement for CPU consumers (e.g. `FireSparksEffect` position map scanning) is addressed by a **one-time CPU readback** via `renderer.readRenderTargetPixels()` at composition time, cached until the next recompose.

- Data masks: `RGBAFormat, UnsignedByteType`
- Visual masks (specular, normal): `RGBAFormat, HalfFloatType`
- CPU readback cached as `compositor._cpuPixels[maskType]` — a `Uint8Array`

### D2: Trees/Bushes/Iridescence — **Per-tile overlay meshes**

**Decision**: Convert `TreeEffect`, `BushEffect`, and `IridescenceEffect` to per-tile `THREE.Mesh` overlays managed by `TileEffectBindingManager`.

**Rationale**: Scene-space composition of RGBA color textures requires color-preserving alpha compositing — a different operation from the lighten/source-over modes used for data masks. Per-tile overlays are architecturally cleaner: each tile's texture renders as a `PlaneGeometry` mesh positioned exactly at the tile's world transform. This naturally handles rotation, flip, scale, and elevation. `TileMotionManager` already calls `syncTileAttachedEffects()` — extending this to new overlay types requires only registering them with the binding manager.

### D3: Token Depth Integration — **On by default**

**Decision**: Enable `depthTest: true, depthWrite: true` on token sprites by default. Provide a Graphics Settings toggle to disable for users who prefer legacy "always on top" behavior.

**Rationale**: The "always on top" behavior is a legacy artifact of the PIXI rendering model. In a 3D scene with foreground architectural tiles, tokens that ignore depth are visually incorrect. The depth buffer already exists and is populated by tiles; enabling depth testing costs nothing. Tokens at `groundZ + 3.0 + elevation` are above all foreground tiles (`groundZ + 2.0 + elevation`) so regression risk is low. Token overlays (borders, labels) remain on `OVERLAY_THREE_LAYER` with `depthTest: false` — always visible.

### D4: Registry Persistence — **Per-scene with warm handoff**

**Decision**: Registry is created fresh per scene and fully destroyed on `dispose()`. Implement a **warm handoff**: the new registry begins preloading ground-floor masks before the old registry is destroyed, so the first frame of the new scene has masks available.

**Rationale**: Cross-scene persistence requires tracking which masks are still valid after a scene change (different dimensions, tiles, floors). The complexity is not worth the marginal gain. The warm handoff addresses the only real cost — first-frame stall — without cross-scene state management complexity.

### D5: Compositor Trigger Policy — **Event-driven, 100ms debounce, change-classified**

**Decision**: Compositor re-runs only in response to classified change events, debounced at 100ms. Per-frame composition is never permitted.

| Event | Recompose? | Debounce |
|---|---|---|
| Level switch | Always, all types | Immediate |
| Tile texture/geometry/elevation/visibility changed | Yes, affected types | 100ms |
| Tile flags changed (Levels, TileMotion, etc.) | **No** | — |
| Effect enabled/disabled | **No** | — |
| Tile created / deleted | Yes, all types | 100ms |

---

## Section 15: Implementation Checklist

Items are ordered by dependency. Complete each phase before starting the next.

---

### Phase 0 — EffectMaskRegistry Foundation

- [x] **P0-01** Create `scripts/assets/EffectMaskRegistry.js` with slot model, policy map, subscriber map
- [x] **P0-02** Implement `registry.definePolicy(maskType, policy)`
- [x] **P0-03** Implement `registry.subscribe(maskType, callback)` — returns unsubscribe fn
- [x] **P0-04** Implement `registry.setMask(maskType, texture, floorKey, source)` — updates slot, notifies subscribers
- [x] **P0-05** Implement `registry.clearMask(maskType)` — respects preserve policy, notifies subscribers
- [x] **P0-06** Implement `registry.getMask(maskType)` — returns current texture or null
- [x] **P0-07** Implement `registry.beginTransition()` / `registry.endTransition()` — blocks tile-change invalidation
- [x] **P0-08** Implement `registry.dispose()` — disposes owned textures, clears subscribers
- [x] **P0-09** Implement `registry.getMetrics()` — diagnostic snapshot
- [x] **P0-10** Wire registry creation into `canvas-replacement.js` — after `SceneComposer`, before `EffectComposer`
- [x] **P0-11** Expose `registry` on `window.MapShine`
- [x] **P0-12** Define water mask policy: `{ preserveAcrossFloors: true, disposeOnClear: false, compositionMode: 'lighten', resolutionClass: 'data' }`
- [x] **P0-13** Migrate `WaterEffectV2` — subscribe to `'water'` via `connectToRegistry()`; `_floorTransitionActive` kept as defense-in-depth
- [x] **P0-14** In `mapShineLevelContextChanged` hook: call `registry.beginTransition()` before rebuild, `registry.endTransition()` after
- [x] **P0-15** In `mapShineLevelContextChanged` hook: call `registry.setMask('water', ...)` instead of direct `WaterEffectV2` redistribution
- [x] **P0-16** `_floorTransitionActive` retained as secondary safety net; `_suppressExternalCacheClear` already absent
- [ ] **P0-17** Verify: single-tile water scene — floor switch preserves water, no visual regression
- [ ] **P0-18** Verify: multi-tile scene — floor with no water preserves ground-floor water (preserveAcrossFloors)

**Implementation Notes (Phase 0):**
- Registry created in `scripts/assets/EffectMaskRegistry.js` with 14 mask type policies (DEFAULT_POLICIES)
- Registry seeded with initial bundle masks during scene load (Step 1b in createThreeCanvas)
- WaterEffectV2 gains `connectToRegistry(registry)` method — subscribes to `'water'` mask type
- Registry subscriber callback handles: new mask → clearCaches + rebuild SDF; null mask → dispose SDF; same texture → no-op
- `_floorTransitionActive` lock kept as defense-in-depth alongside registry's `beginTransition()`/`endTransition()`
- TileManager hooks (create/update/delete) delegate to `registry.onTileChange()` for change classification
- Registry filters out flag-only changes (Levels visibility toggles) — only geometry/texture/visibility/elevation changes trigger recompose
- `transitionToFloor()` atomic API implemented but not yet used (Phase 1 will replace the per-effect redistribution block)
- All non-water mask types also synced to registry during floor transitions via `registrySync` block
- All 4 modified files pass `node --check`: EffectMaskRegistry.js, canvas-replacement.js, WaterEffectV2.js, tile-manager.js

---

### Phase 1 — All Masks Through Registry

- [x] **P1-01** Define policies for all mask types — done in Phase 0 (DEFAULT_POLICIES covers all 14 types)
- [x] **P1-02** Migrate `FireSparksEffect` — subscribe to `'fire'` (extracted `_applyFireMask` for shared logic)
- [x] **P1-03** Migrate `LightingEffect` — subscribe to `'outdoors'`
- [x] **P1-04** Migrate `WindowLightEffect` — subscribe to `'windows'`, `'outdoors'`, `'specular'` (multi-mask with `pushMask` helper)
- [x] **P1-05** Migrate `BuildingShadowsEffect` — subscribe to `'outdoors'`
- [x] **P1-06** Migrate `CloudEffect` — subscribe to `'outdoors'`
- [x] **P1-06b** Migrate `OverheadShadowsEffect` — subscribe to `'outdoors'`
- [x] **P1-06c** Migrate `AtmosphericFogEffect` — subscribe to `'outdoors'`
- [x] **P1-06d** Migrate `TreeEffect` — subscribe to `'tree'`
- [x] **P1-06e** Migrate `BushEffect` — subscribe to `'bush'`
- [x] **P1-06f** Migrate `IridescenceEffect` — subscribe to `'iridescence'`
- [x] **P1-06g** Migrate `PrismEffect` — subscribe to `'prism'`
- [x] **P1-06h** Migrate `SpecularEffect` — subscribe to `'specular'`, `'roughness'`, `'normal'` (multi-mask with `updateUniform` factory)
- [x] **P1-07** Migrate `DustMotesEffect` — subscribe to `'dust'` and `'outdoors'`
- [x] **P1-08** Migrate `AshDisturbanceEffect` — subscribe to `'ash'`
- [x] **P1-09** Migrate `WeatherController` — subscribe to `'outdoors'` for roof map
- [x] **P1-10** `MaskManager` — N/A (texture registry for derived masks, not a mask consumer)
- [x] **P1-11** `DistortionManager` — N/A (receives masks via `registerSource` from FireSparksEffect)
- [x] **P1-12** Implement `registry.transitionToFloor(floorKey, compositorOutput)` — done in Phase 0
- [x] **P1-13** Replace `mapShineLevelContextChanged` redistribution block with single `registry.transitionToFloor()` call
- [x] **P1-14** Wire all `connectToRegistry()` calls in `canvas-replacement.js` (`connectIfPresent` helper)
- [x] **P1-14b** Move tile-change filtering into registry — done in Phase 0 (`registry.onTileChange`)
- [x] **P1-15** `TileManager` hooks delegate to `registry.onTileChange()` — done in Phase 0
- [x] **P1-16** `TileManager.createTileSprite()` calls `registry.onTileChange()` — done in Phase 0
- [x] **P1-17** `TileManager.removeTileSprite()` calls `registry.onTileChange()` — done in Phase 0
- [ ] **P1-18** Verify: adding a new mask-consuming effect requires only `registry.subscribe()` + policy — no changes to `canvas-replacement.js`
- [ ] **P1-19** Verify: all existing single-tile and multi-tile scene behaviors unchanged

---

### Phase 2 — GPU SceneMaskCompositor

- [x] **P2-01** Create `scripts/masks/GpuSceneMaskCompositor.js` — GPU WebGL render target compositor replacing CPU canvas compositor
- [x] **P2-02** Implement render target pool: `Map<floorKey, Map<maskType, WebGLRenderTarget>>` — one RT per mask type per floor
- [x] **P2-03** Implement tile-to-scene UV transform shader (`TILE_VERT`) — maps tile (x, y, w, h, rotation, scaleSign) in Foundry UV space into scene-space RT; fragments outside tile rect are discarded
- [x] **P2-04** Implement composition mode as shader uniform: `uMode` — 0=lighten (MAX blend), 1=source-over (normal alpha)
- [x] **P2-05** Implement `compositor.compose(tileMaskEntries, scene, options)` — iterates all mask types, renders all tile contributions per type into RT
- [x] **P2-06** `composeAll` is implicit in `compose()` — all mask types present across tiles are composited in one call
- [x] **P2-07** Implement `compositor.getCpuPixels(maskType)` — `renderer.readRenderTargetPixels()` readback, cached per compose call; `SceneComposer.getCpuPixels()` accessor added
- [x] **P2-08** `FireSparksEffect._generatePoints` prefers GPU compositor readback, falls back to CPU canvas `drawImage`
- [x] **P2-09** `DustMotesEffect._generatePoints` and `AshDisturbanceEffect._generatePoints`/`_cacheMaskData` similarly updated
- [x] **P2-10** Per-floor render target cache: `_floorCache: Map<floorKey, Map<maskType, WebGLRenderTarget>>`
- [x] **P2-11** LRU eviction at `_maxCachedFloors` (8) — oldest floor's render targets disposed on overflow
- [x] **P2-12** `compositor.preloadFloor(floorKey, tileMaskEntries, scene)` — composes and caches without activating
- [x] **P2-13** `SceneComposer` now instantiates `GpuSceneMaskCompositor` (drop-in replacement for `SceneMaskCompositor`)
- [x] **P2-14** `SceneComposer.preloadMasksForAllLevels()` unchanged — already calls `compose()` via `rebuildMasksForActiveLevel(cacheOnly=true)`, which now uses GPU compositor
- [x] **P2-15** `TileManager.loadAllTileMasks()` already generic — unchanged (was already implemented)
- [ ] **P2-16** Verify: compositor output pixel-identical to previous CPU canvas output for single-tile scenes (runtime comparison)
- [ ] **P2-17** Verify: compositor handles tiles with rotation and flip correctly (runtime testing)
- [ ] **P2-18** Verify: compositor handles overlapping tiles with correct Z-order compositing (runtime testing)
- [ ] **P2-19** Benchmark: floor switch < 100ms for 4-tile, 12-mask-type scene (runtime profiling)

**Implementation notes:**
- GPU compositor falls back to `SceneMaskCompositor` (CPU canvas) automatically when `window.MapShine.renderer` is unavailable
- Shared `_quadGeo`, `_tileMaterial`, `_quadMesh`, `_quadScene`, `_orthoCamera` — created once, reused for all tile draws
- `THREE.CustomBlending` with `MaxEquation` for lighten mode; `NormalBlending` for source-over
- All 5 modified files pass `node --experimental-default-type=module --check`

---

### Phase 3 — TileEffectBindingManager

- [x] **P3-01** Create `scripts/scene/TileEffectBindingManager.js`
- [x] **P3-02** Implement `bindingManager.registerEffect(maskType, effect)`
- [x] **P3-03** Implement `bindingManager.onTileReady(tileId, tileDoc, sprite, masks)` — calls `effect.bindTileSprite()` for each matching mask type
- [x] **P3-04** Implement `bindingManager.onTileTransformChanged(tileId, sprite)` — calls `effect.syncTileSpriteTransform()` for all bound effects
- [x] **P3-05** Implement `bindingManager.onTileVisibilityChanged(tileId, visible)` — calls `effect.syncTileSpriteVisibility()`
- [x] **P3-06** Implement `bindingManager.onTileRemoved(tileId)` — calls `effect.unbindTileSprite()`, cleans up binding record
- [x] **P3-07** Implement `bindingManager.onLevelChanged(newFloorContext)` — hides/shows overlays per floor
- [x] **P3-08** Implement `bindingManager.dispose()` — unbinds all tiles, disposes all overlay meshes
- [x] **P3-09** Wire `TileEffectBindingManager` creation into `canvas-replacement.js`
- [x] **P3-10** Wire `TileManager` lifecycle calls into binding manager at all relevant points
- [x] **P3-11** Wire `TileMotionManager.syncTileAttachedEffects()` to call `bindingManager.onTileTransformChanged()` for animated tiles
- [x] **P3-12** Migrate `SpecularEffect` per-tile overlays to binding manager — implement full `TileBindableEffect` interface
- [x] **P3-13** Migrate `FluidEffect` per-tile overlays to binding manager
- [x] **P3-14** Convert `TreeEffect` to per-tile overlay model — `PlaneGeometry` mesh at tile world transform
- [x] **P3-15** Convert `BushEffect` to per-tile overlay model
- [x] **P3-16** Convert `IridescenceEffect` to per-tile overlay model — additive blending at tile Z + 0.0005
- [x] **P3-17** Remove direct `TileManager → SpecularEffect` and `TileManager → FluidEffect` calls
- [ ] **P3-18** Verify: rotating a tile in map maker mode — all per-tile overlays rotate with it in real time
- [ ] **P3-19** Verify: hiding a tile (level switch) — all per-tile overlays hide immediately
- [ ] **P3-20** Verify: deleting a tile — all per-tile overlays disposed, no memory leak

---

### Phase 4 — Token Rendering Improvements

- [x] **P4-01** Enable `depthTest: true, depthWrite: true` on `SpriteMaterial` in `TokenManager.createTokenSprite()`
- [x] **P4-02** Add `tokenDepthInteraction: boolean` to Graphics Settings (default `false`, persisted via localStorage)
- [x] **P4-03** Apply setting to all existing token sprites on settings change via `TokenManager.setDepthInteraction()`
- [ ] **P4-04** Verify token overlays (borders, labels, targets) remain `depthTest: false` — always visible
- [ ] **P4-05** Verify tokens correctly occluded by elevated foreground tiles
- [ ] **P4-06** Verify tokens NOT occluded by background tiles
- [x] **P4-07** Extend token CC shader to sample `tLightingTarget` at token screen-space position
- [x] **P4-08** Extend token CC shader to sample `tOutdoorsMask` at token world-space position — gate indoor/outdoor light intensity
- [x] **P4-09** Add uniforms `tLightingTarget`, `uHasLightingTarget`, `tOutdoorsMask`, `uHasOutdoorsMask` to `_ensureTokenColorCorrection()`
- [x] **P4-10** Update `TokenManager.update()` to push `LightingEffect.lightTarget.texture` and outdoors mask into token CC uniforms each frame
- [x] **P4-11** Wire `WaterEffectV2` distortion pass to sample `tokenMask.screen` — skip distortion where token mask is opaque (pre-existing in DistortionManager apply shader)
- [ ] **P4-12** Verify: token standing in water — not distorted by water UV warp
- [ ] **P4-13** Verify: token indoors — darker than outdoor token at same darkness level
- [ ] **P4-14** Verify: token outdoors — receives full ambient + dynamic light contribution

---

### Phase 5 — Memory Management & Performance

- [x] **P5-01** Implement `TextureBudgetTracker` in `scripts/assets/TextureBudgetTracker.js` — tracks allocated texture VRAM by source
- [x] **P5-02** `TextureBudgetTracker.register(texture, label, sizeBytes)` — called on allocation
- [x] **P5-03** `TextureBudgetTracker.unregister(texture)` — called on dispose
- [x] **P5-04** Wire budget tracker into compositor render target allocation (`LightingEffect.onResize`)
- [x] **P5-05** Wire budget tracker into per-tile mask loading in `TileManager.loadTileTexture`
- [x] **P5-06** Implement budget enforcement: `evictStaleFloorCaches()` evicts oldest non-active floor entries when >80%
- [x] **P5-07** Implement resolution downscaling fallback: `getDownscaleFactor()` returns 0.5 when budget >80%
- [x] **P5-08** Implement lazy effect initialization: `EffectMaskRegistry._notifySubscribers` fires `onMaskArrived` on null→non-null transitions
- [x] **P5-09** `EffectBase` gains `onMaskArrived(maskType, texture)` hook — triggers `ensureEffectInitialized` via `window.MapShine.effectComposer`
- [x] **P5-10** Add Tweakpane debug panels: "Mask Registry" + "VRAM Budget" under Developer Tools — dump state to console
- [x] **P5-11** Mask source visualization: "Dump Tile Contributions" button shows per-tile mask presence table
- [x] **P5-12** Per-mask-type toggles in debug overlay — 14 mask types individually enable/disable via `setMaskTypeDebugEnabled()`
- [x] **P5-13** Tile effect binding inspector: "Dump Tile Binding Inspector" button — per-tile overlay count, orphan detection
- [ ] **P5-14** Benchmark: scene load time regression — compare before/after for standard single-tile scene
- [ ] **P5-15** Benchmark: floor switch < 100ms for 4-tile, 12-mask-type scene with warm cache
- [ ] **P5-16** Benchmark: 60 FPS maintained — no per-frame compositor work

---

### Phase 6 — Cleanup & Hardening

- [x] **P6-01** Remove `_suppressExternalCacheClear` and all associated timer logic from `WaterEffectV2` — already removed in a prior pass; `_floorTransitionActive` is intentional defense-in-depth, not the old suppress flag
- [x] **P6-02** Remove dead `_windowMaskData`/`_outdoorsMaskData` clear block from `canvas-replacement.js` `mapShineLevelContextChanged` hook — those fields no longer exist on `TileManager`; the `safeCall` block was a no-op
- [x] **P6-03** Remove `SceneComposer._activeLevelBasePath` — now `GpuSceneMaskCompositor._activeFloorBasePath`
- [x] **P6-04** Remove `SceneComposer._levelMaskCache` — now `GpuSceneMaskCompositor._floorMeta` (per-floor metadata cache)
- [x] **P6-05** Remove `SceneComposer.rebuildMasksForActiveLevel()` — replaced by `compositor.composeFloor()`; hook in `canvas-replacement.js` now calls compositor directly
- [x] **P6-06** Remove `SceneComposer.preloadMasksForAllLevels()` — replaced by `compositor.preloadAllFloors()`; preload call in `canvas-replacement.js` updated
- [x] **P6-07** Remove `SceneComposer._buildCompositeSceneMasks()`, `_buildCompositeSceneAlbedo()`, `_computeSceneMaskCompositeLayout()`, `_getFullSceneMaskTileBasePaths()`, `_buildUnionMaskForBasePaths()` — CPU fallback paths removed; GPU compositor is now the sole composition path
- [x] **P6-08** Remove `SceneComposer._getLargeSceneMaskTiles()`, `_getActiveLevelTiles()`, `_isTileInLevelBand()` — moved to `GpuSceneMaskCompositor` as private helpers; `SceneComposer` retains thin delegation stubs for `_resolveMaskSourceSrc`
- [x] **P6-09** Remove direct `TileManager._windowMaskData` / `_outdoorsMaskData` cache clear calls from `canvas-replacement.js` — already removed (fields never existed on TileManager in current codebase)
- [x] **P6-10** Remove `_windowMaskExtractFailed` / `_outdoorsMaskExtractFailed` flags from `TileManager` — already absent; fields were never added
- [x] **P6-11** Audit all `setBaseMesh()` calls — confirmed initial-seeding only; `wireBaseMeshes` runs once at scene load before `connectToRegistry`; registry owns all subsequent floor-transition updates. No double-extraction.
- [x] **P6-12** Audit all `setAssetBundle()` calls — confirmed initial-seeding only for `FireSparksEffect`, `DustMotesEffect`, `AshDisturbanceEffect`; all three have `connectToRegistry` for subsequent updates. No stale-seed risk.
- [ ] **P6-13** Regression test: 4-tile scene on 2 floors — all 12 mask types compose correctly on each floor
- [ ] **P6-14** Regression test: rapid floor switching (10 switches in 2 seconds) — no visual artifacts, no memory leak
- [ ] **P6-15** Regression test: tile CRUD during active scene — compositor recomposes correctly, no orphaned overlays
- [ ] **P6-16** Regression test: single-tile scene — output identical to pre-refactor baseline

---

## Section 16: Post-Load Startup Lag — Root Cause Analysis & Fixes

### 16.1 The Problem

After the loading overlay fades out, Map Shine Advanced exhibits ~12 seconds of lag before the scene settles into smooth rendering. This is distinct from the loading phase itself (which has a progress bar). The lag manifests as:

- Dropped frames / stuttering in the first 5–15 seconds after the overlay disappears
- GPU driver spikes visible in browser devtools
- Particle systems, water, and lighting effects appearing to "warm up" gradually
- Possible main-thread blocking during the first few camera pans

### 16.2 Root Causes (Identified)

The existing `progressiveWarmup()` in `EffectComposer` runs **before** the render loop starts and correctly compiles most shaders during the loading phase. However, several categories of work escape this warmup and execute on the first live frames instead:

#### Cause 1: Shader Variant Explosion (Highest Impact)

WebGL compiles a **new shader program** for every unique combination of `#define` values, material properties, and render state. Three.js defers this to the first draw call with that combination. Effects with many conditional uniforms (water murk, lighting, bloom) generate dozens of variants. `progressiveWarmup()` only exercises the variant active at warmup time — any variant triggered by a different scene state (darkness level, water depth, roof visibility) compiles on the first live frame that needs it.

**Evidence**: The `MAPSHINE_SHADER_VARIANT_TEST` flag in `EffectComposer` was disabled because it added ~170 seconds of extra compilations — confirming the variant count is very large.

#### Cause 2: `preloadMasksForAllLevels()` Runs Post-Fade

`preloadMasksForAllLevels()` is intentionally deferred to run **after** the overlay fades in. This is correct for avoiding load-time delays, but it means the first level switch after load triggers disk I/O and CPU canvas composition on the main thread — causing a visible freeze. With the GPU compositor (Phase 2), this becomes GPU work, but it still needs to be scheduled correctly.

#### Cause 3: Token Sprite Shader Compilation

Token sprites use `onBeforeCompile` to inject the color correction shader. This callback fires on the **first render** of each token, not during warmup. With 20+ tokens on a scene, each with a unique material instance, this produces 20+ shader compilations spread across the first few seconds of rendering.

#### Cause 4: Pathfinding Nav Graph Build

`_runPathfindingPrewarm()` builds the scene navigation graph after scene load. This is a CPU-intensive BFS over all grid cells + wall collision tests. On large scenes (200×200 grid) this can take 500ms–2s and runs on the main thread, causing dropped frames.

#### Cause 5: `preloadMasksForAllLevels()` CPU Canvas Work

The current CPU canvas compositor runs synchronously during `preloadMasksForAllLevels()`. For a 4-floor scene with 4 tiles each, this is 16 canvas draw operations × 12 mask types = 192 canvas operations, all on the main thread. This is the primary cause of the freeze that can occur 1–3 seconds after the overlay fades.

#### Cause 6: Particle System First-Frame Position Map Scan

`FireSparksEffect` and similar particle effects scan the fire mask pixel data on the first frame to build the `_firePositionMap` (a `DataTexture` of spawn positions). This is a CPU loop over potentially millions of pixels. It runs lazily on the first update after the mask is received, not during warmup.

#### Cause 7: Water SDF Generation

`WaterEffectV2` generates a Signed Distance Field from the water mask on first use. This is a multi-pass GPU operation but it runs on the first frame that needs it, not during warmup, causing a visible frame spike.

### 16.3 Proposed Fixes

#### Fix 1: Shader Variant Pre-Compilation via `compileAsync()`

Three.js r152+ exposes `renderer.compileAsync(scene, camera)` which triggers shader compilation for all materials currently in the scene graph **without rendering**. This is the correct tool for pre-compiling token sprite shaders and any other materials added after `progressiveWarmup()`.

```
Proposed warmup sequence:
  1. progressiveWarmup()          — existing, compiles effect shaders
  2. syncAllTokens()              — creates all token sprites (currently happens later)
  3. renderer.compileAsync(scene, camera)  — NEW: compiles all scene-graph materials
                                             including token SpriteMaterials
  4. renderLoop.start()           — first frame has zero new compilations
```

The key change is moving `tokenManager.syncAllTokens()` (or at least creating placeholder token sprites) **before** `progressiveWarmup()`, so `compileAsync()` can see and compile the token materials.

#### Fix 2: Chunked Post-Load Work via `requestIdleCallback`

All post-load background work should use `requestIdleCallback` with a deadline, not `setTimeout(fn, 0)` or fire-and-forget async. This ensures the work only runs when the main thread is genuinely idle (between frames), preventing it from stealing time from the render loop.

```javascript
// Current (bad): runs immediately after overlay fade, competes with render loop
safeCallAsync(async () => {
  await c.preloadMasksForAllLevels();
}, 'levelMaskPreload');

// Proposed (good): yields to render loop, runs in idle slices
scheduleIdleWork('levelMaskPreload', async (deadline) => {
  await c.preloadMasksForAllLevels({ deadline });
}, { priority: 'background' });
```

`preloadMasksForAllLevels()` should accept a `deadline` parameter and yield between floor bands when `deadline.timeRemaining() < 5`.

#### Fix 3: Particle Position Map Pre-Scan During Warmup

`FireSparksEffect`, `DustMotesEffect`, and `AshDisturbanceEffect` should pre-scan their position maps during `progressiveWarmup()` rather than lazily on first update. The warmup already calls `effect.update(timeInfo)` and `effect.render()` — the position map scan should be triggered by the first `update()` call, not deferred.

This requires removing the lazy-scan guard (`if (!this._firePositionMap)`) and instead ensuring the scan runs synchronously during the first `update()` call in warmup.

#### Fix 4: Water SDF Pre-Generation During Warmup

`WaterEffectV2` should generate its SDF during `progressiveWarmup()`. The warmup already calls `effect.render()` — the SDF generation pass should be triggered on the first render call, not deferred to the first live frame.

Add a `forceSDFGeneration()` method that runs the SDF pass immediately, called from `progressiveWarmup()` after the water effect's warmup step.

#### Fix 5: Pathfinding Prewarm on Idle Thread

`_runPathfindingPrewarm()` should be split into chunks and run via `requestIdleCallback`. The BFS graph build can be chunked by grid row — process N rows per idle slice until complete. This spreads the 500ms–2s cost across many idle frames instead of one blocking call.

#### Fix 6: Post-Load Render Burst

After the overlay fades, force 60 consecutive frames of rendering regardless of idle throttle. This "burns in" any remaining shader variants that only appear under real scene conditions (camera at actual position, actual lighting state, actual token positions).

```javascript
// After overlay.fadeIn() completes:
renderLoop.requestContinuousRender(3000); // 3 seconds of forced full-rate rendering
```

This is a cheap safety net that ensures any remaining lazy compilations happen immediately after load rather than on the first user interaction.

### 16.4 Startup Timing Target

| Phase | Current | Target |
|---|---|---|
| Loading overlay visible | ~8–15s | ~8–15s (unchanged — this is acceptable) |
| Overlay fade-out | 2s | 2s |
| **Post-fade lag (stuttering)** | **~12s** | **< 1s** |
| First smooth frame | ~14–27s after scene start | ~10–17s after scene start |

---

### Phase 7 — Startup Lag Elimination

- [ ] **P7-01** Move `tokenManager.syncAllTokens()` (or a lightweight "create sprite materials without textures" pass) to **before** `progressiveWarmup()` in the load sequence
- [ ] **P7-02** Add `renderer.compileAsync(scene, camera)` call after `progressiveWarmup()` and after token sprites are created — compiles all scene-graph materials including token `SpriteMaterial` instances
- [ ] **P7-03** Add `renderer.compileAsync()` progress reporting to the loading overlay ("Compiling scene materials…")
- [ ] **P7-04** Remove lazy position-map scan guard from `FireSparksEffect` — ensure `_buildFirePositionMap()` runs on the first `update()` call during warmup, not deferred
- [ ] **P7-05** Remove lazy position-map scan guard from `DustMotesEffect` and `AshDisturbanceEffect` — same pattern
- [ ] **P7-06** Add `WaterEffectV2.forceSDFGeneration()` — runs the SDF generation pass immediately; call from `progressiveWarmup()` after the water warmup step
- [ ] **P7-07** Create `scheduleIdleWork(id, fn, opts)` utility in `scripts/core/` — wraps `requestIdleCallback` with fallback to `setTimeout`, supports deadline-aware chunking
- [ ] **P7-08** Replace `preloadMasksForAllLevels()` fire-and-forget call with `scheduleIdleWork()` — yields between floor bands when deadline is approaching
- [ ] **P7-09** Update `preloadMasksForAllLevels()` (and the new GPU compositor equivalent) to accept a `deadline` parameter and yield between floor iterations
- [ ] **P7-10** Replace `_runPathfindingPrewarm()` synchronous BFS with chunked idle-work version — process N grid rows per idle slice, resume on next idle callback
- [ ] **P7-11** After `loadingOverlay.fadeIn()` completes, call `renderLoop.requestContinuousRender(3000)` — forces 3 seconds of full-rate rendering to burn in remaining shader variants
- [ ] **P7-12** Add post-load shader variant stress test (debug mode only): after overlay fade, render the scene from 8 different camera positions and darkness levels to trigger all common shader variants — log any new compilations detected
- [ ] **P7-13** Add `window.MapShine.postLoadLagMs` metric — measures time from overlay fade-complete to first frame where `renderer.info.programs` count stops increasing; expose in Tweakpane diagnostics
- [ ] **P7-14** Verify: after all fixes, `postLoadLagMs` < 1000ms on a scene with 20+ tokens, water, fire, and lighting effects
- [ ] **P7-15** Verify: first camera pan after overlay fade is smooth (no dropped frames in browser devtools performance trace)
