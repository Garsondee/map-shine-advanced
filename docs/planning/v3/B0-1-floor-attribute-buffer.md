# B0-1 — The Floor-Attribute Buffer

**Status:** DRAFT for author review (B0, no code). Written 2026-07-10 against current source; all file:line pointers verified that day.
**Parent:** [Forward+.md](../Forward+.md) §14.3 (proposal), §12.3 (Class D resolution), §14.1 (principles).
**Decides:** the single screen-space primitive that replaces today's four overlapping "which floor owns this pixel" mechanisms in the V3 unified pass.

---

## 1. What exists today (verified) — four sibling mechanisms, one concern

The codebase answers "which floor / what coverage is at this pixel?" four different ways. This is §14.1 principle 3's disease (N bespoke solutions per concern) in its purest form:

| #   | Mechanism                                                                                                                                                                              | Space / cost class                                                | Owner + build site                                                                                                                                                                                                                                          | Consumers (verified)                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | `floorAlpha` per-floor mask — R=1 where the floor has opaque tile coverage (MAX-blend union of tile base-texture alpha)                                                                | **World** (scene rect × `_highDetailMaskTarget()`, budget-scaled) | `GpuSceneMaskCompositor._composeFloorAlpha` ([GpuSceneMaskCompositor.js:4463](../../../scripts/masks/GpuSceneMaskCompositor.js)) at floor composition                                                                                                       | skyReach derivation, M2 input; effects via mask bundles                                                                                                                                                                              |
| M2  | `floorIdTarget` — R = topmost floor index / 255, painter's algorithm over each floor's M1                                                                                              | **World** (same res class)                                        | `buildFloorIdTexture` ([GpuSceneMaskCompositor.js:2019](../../../scripts/masks/GpuSceneMaskCompositor.js)); rebuilt on floor change via `rebuildFloorIdFromVisibleFloorKeys` ([canvas-replacement.js:3734](../../../scripts/foundry/canvas-replacement.js)) | `BuildingShadowsEffectV2:1201`, `PaintedShadowEffectV2:2297` ("pick painted/outdoors by floorIdTarget per pixel"), `WindowLightEffectV2:2433`, `ShadowMaskBindings:39`, `indoor-outdoor-mask-api:210`, `mask-binding-controller:413` |
| M3  | `floorPresenceTarget` (layer 23) + `belowFloorPresenceTarget` (layer 24) — half-res screen-space alpha quads per tile                                                                  | **Screen** (half-res), re-rendered per frame                      | Scenes populated by `TileManager` ([tile-manager.js:1337,1366](../../../scripts/scene/tile-manager.js)); rendered by `DistortionManager._renderFloorPresence` ([DistortionManager.js:3350](../../../scripts/compositor-v2/effects/DistortionManager.js))    | DistortionManager (heat-shimmer floor gating), CandleFlamesEffectV2, water-screen-occlusion, specular-shader, GpuSceneMaskCompositor (per Forward+ §12.3)                                                                            |
| M4  | Water occluder family — `waterOccluderTarget` (layer 22), `tOverheadRoofBlock`, `tSliceAlpha`, `tWaterBgAlphaMask`, shared GLSL with **soft** thresholds (`smoothstep(0.34, 0.66, …)`) | **Screen**, per frame                                             | `FloorCompositor._resolvePostMergeWaterOccluderRT` + [water-screen-occlusion.js:18–57](../../../scripts/compositor-v2/effects/water-screen-occlusion.js)                                                                                                    | WaterEffectV2, WaterSplashesEffectV2 shaders                                                                                                                                                                                         |

Plus the **stacked per-floor aggregates** that only exist because the per-level RT stack exists:

- `_buildStackedOutdoorsForPostMerge` ([FloorCompositor.js:6952](../../../scripts/compositor-v2/FloorCompositor.js)) → stacked outdoors + skyReach consumed by AtmosphericFog (:9617), Bloom (:9635), ColorCorrection (:9727–9728).
- `_stackedLevelLitSnapshots` (:848) and `beginStackedLightBuffer`/`accumulateStackedLightBuffer` ([LightingEffectV2.js:1543,1564](../../../scripts/compositor-v2/effects/LightingEffectV2.js)) consumed by CC via `getLocalLightBufferBinding`/`getSceneLightBufferBinding` (:9744–9754).

### Known defects in the current mechanisms (the buffer fixes these for free)

1. **M2 violates the screen-bound invariant** (§14.1 #1): world-sized, rebuilt per floor change, budget-scaled but still `O(world)`.
2. **M2 uses `LinearFilter`** ([GpuSceneMaskCompositor.js:2043](../../../scripts/masks/GpuSceneMaskCompositor.js)) on an _ID_ encoding — sampling between floor 0 and floor 2 texels interpolates to floor 1. Consumers survive via thresholds; it is still wrong by construction.
3. **M3's scene fallback is a layer collision.** `_getFloorPresenceScene()` falls back to the main scene ([tile-manager.js:1356](../../../scripts/scene/tile-manager.js)), where layers 23/24 are _also_ `TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER/CLOUD_TOP_BLOCKER` ([render-layers.js:31–34](../../../scripts/core/render-layers.js)). In fallback mode a presence render picks up cloud-blocker quads. Layer 25 is likewise double-booked (`ROPE_MASK_LAYER` and `MSA_ABOVE_OVERHEAD_LIGHT_LAYER`).
4. **M1/M3 disagree about what "presence" means** (authored-alpha union in world space vs live sprite quads in screen space), and M4 is deliberately _soft_ where M1–M3 are binary — consumers pick whichever semantic happens to be wired in.

## 2. The design

One screen-sized MRT attachment written by the V3 unified geometry pass. Nothing about it is speculative — it is M2's semantics, moved to screen space, written for free during the pass that already draws every floor's geometry at real Z (`FloorRenderBus` is already Z-unified, Forward+ §12.1).

### 2.1 Format and channels

> **Attribute buffer:** RGBA8, screen-sized (same dims as the unified color RT), `NearestFilter` min+mag, no mipmaps, `NoColorSpace`, cleared each frame to `(255, 0, 0, 0)`.

| Ch  | Content                                               | Encoding                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R   | **Floor index** of topmost attribute-writing fragment | `index / 255`                                                                                 | 255 = "no geometry" (clear value). Real floors 0–19 today (`camera.layers` allocation); 255-floor headroom is plenty. Exact-match decode: `int(round(r * 255.0))` — never threshold-compare.                                                                                                                                                |
| G   | **Outdoors / skyReach** value of that fragment        | 0–1                                                                                           | Sampled in the unified pass's fragment shader from the owning floor's _low-res_ outdoors texture (outdoors is area classification; does not need world resolution — Forward+ §14.3). Because "topmost fragment wins," G _is_ the stacked skyReach: a lower floor visible through an authored hole correctly reports its own outdoors value. |
| B   | **Presence flags** (bitfield)                         | bit 0: overhead/roof fragment · bit 1: `levelsHidden` (below-viewed) tile · bits 2–7 reserved | Bit 1 is what lets `belowFloorPresence` be derived without a second pass.                                                                                                                                                                                                                                                                   |
| A   | **Authored solidity** (the alpha-rebind invariant)    | 0–1                                                                                           | The authored albedo alpha that `_levelAlphaRebindPass` ([FloorCompositor.js:9352](../../../scripts/compositor-v2/FloorCompositor.js)) treats as the authoritative per-floor solidity mask today. Written so downstream consumers keep the same "authored holes stay holes" contract.                                                        |

### 2.2 Write convention

- **Opaque and alphaTest fragments write attributes.** Discarded (alphaTest-failed) fragments write nothing — the hole reveals the floor below, whose fragment owns the pixel. This is what makes R the "topmost _solid_" floor automatically.
- **Transparent fragments (Class B, water surface, token glows) do not write attributes** — they read them. Enforced without extensions via the **alpha-zero blend trick** (§3.1).
- Only the unified geometry pass writes the buffer. Post passes, particles, and composites read it as a plain texture.

### 2.3 Consumer migration map

| Today's source                      | Consumer                                                                                                                            | V3 replacement                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| M2 `floorIdTarget` (world)          | BuildingShadows / PaintedShadow / WindowLight per-pixel floor pick                                                                  | `attr.r` exact-match (screen space — consumers already work in screen space at these call sites) |
| M3 `floorPresenceTarget`            | Distortion / candle / specular current-floor gating                                                                                 | `decodeFloor(attr.r) == viewedFloor`                                                             |
| M3 `belowFloorPresenceTarget`       | Distortion `belowFloorPresenceTarget` ([DistortionManager.js:488–498](../../../scripts/compositor-v2/effects/DistortionManager.js)) | `attr.b` bit 1, or `decodeFloor(attr.r) < viewedFloor`                                           |
| Stacked outdoors/skyReach builds    | CC, Bloom, AtmosphericFog post-merge masks                                                                                          | `attr.g` directly — the per-floor-aggregate builds retire                                        |
| M1 `floorAlpha` (as _screen_ query) | any effect asking "is the floor solid here"                                                                                         | `attr.a`                                                                                         |
| M4 soft water occluders             | Water / splash shaders                                                                                                              | **Not migrated in B1–B3.** See §4.1 — water keeps its soft path until B5.                        |

Consumers needing soft edges blur their _derived_ mask (a cheap separable blur of a screen-sized single channel), never the buffer itself.

## 3. Mechanics (three r170 / WebGL2)

### 3.1 MRT and the blending constraint

- three r170 exposes MRT as `new THREE.WebGLRenderTarget(w, h, { count: 2, … })`; per-texture params via `rt.textures[1]` (`WebGLMultipleRenderTargets` is gone — do not design against it). Materials need `glslVersion: THREE.GLSL3` with `layout(location = 0) out vec4 gColor; layout(location = 1) out vec4 gAttr;`.
- **WebGL2 has no per-attachment blend state** (that needs `OES_draw_buffers_indexed`, not guaranteed on the 8 GB laptop class). Blending applies to _all_ attachments. Consequences:
  - Opaque/alphaTest draws run with blending off → both attachments write cleanly. No problem.
  - Any transparent draw _inside_ the unified pass outputs `gAttr = vec4(0.0)`. Under `NormalBlending` (`src·a + dst·(1−a)`) and `AdditiveBlending` (`+ src·a` or `+ src`), an all-zero source leaves the destination attachment untouched. **Rule: every material drawn while the attribute attachment is bound must either write real attributes (opaque path) or output exact zeros to `gAttr` (transparent path).** Custom/premultiplied blend modes must be audited against this rule before joining the pass (B0-3 carries the blend-mode inventory).
  - Fallback if an audited blend mode can't satisfy the rule: split the draw list and rebind with `gl.drawBuffers([COLOR_ATTACHMENT0, NONE])` for that batch (per-FBO state, cheap, no extension needed).
- Depth: single shared depth buffer on the MRT target; Class B reads it (`depthTest: true, depthWrite: false` — B0-3).

### 3.2 Precision and filtering rules

- `NearestFilter` everywhere; R is an ID, G/A are masks that consumers may blur _after_ derivation.
- Never scale/resample the attribute buffer as a texture; on resize, it is reallocated with the color RT by the frame graph (B0-2).
- Debug overlay (B1 exit criterion): a visualizer mapping R to a color ramp, G/B/A to toggles — added to the existing diagnostics surface, per §14.1 principle 6.

## 4. Edge cases — the two §14.3 validation items

### 4.1 Semi-transparent decks (the water constraint)

M4's occluders are **soft**: `msaWaterDeckMaskOcc` runs `smoothstep(0.34, 0.66, deckAlpha)` — a 50%-alpha deck half-occludes the river below. The attribute buffer is **binary by construction** (a fragment either owns the pixel or discarded). It cannot and should not encode partial ownership.

**Resolution:** the attribute buffer replaces the _binary_ consumers (M2, M3). Water's soft occlusion path (M4) — including `tSliceAlpha`, `tWaterBgAlphaMask`, and `_resolvePostMergeWaterOccluderRT` — **stays as-is through B1–B4** and is the explicit Class D exception branch in the frame graph (B0-2 pass `WaterSeeThrough`). It shrinks only at B5 (water as geometry), where plank-over-river becomes depth testing for the opaque deck portion and the soft path reduces to splash gating. The `attr.a` channel (authored solidity) exists partly so B5 has the deck-alpha signal available in screen space when that migration happens.

### 4.2 The water surface itself

Until B5, the water surface is a screen-space composite (post-merge), not geometry — it never writes attributes; pixels over open water report the floor beneath the water (correct: splashes/foam gate on floor identity, not on "is water here", which stays `uWaterMask` world-sampled). At B5 the water mesh joins the transparent set: reads attributes, writes none, and its occlusion comes from depth.

### 4.3 Overheads and elevation-band membership

Overhead/roof tiles are fragments of their owning floor (bit 0 in B distinguishes them). Consumers that today distinguish "roof of my floor" vs "floor above me" (`tOverheadRoofBlock` semantics) derive it as `sameFloor && overheadBit` vs `floorAbove`. The elevation→floor routing itself stays owned by `FloorRenderBus`/`LayerOrderPolicy` — the buffer records the _decision_, never re-derives it.

## 5. What this retires (accounting)

Once B2–B4 land and consumers are migrated: M2 (`buildFloorIdTexture` + rebuild plumbing), M3 (both presence scenes, per-tile presence quads in TileManager, DistortionManager's two RTs + render passes), the stacked-outdoors post-merge builds, and the A-minus caveat of Forward+ §12.3. M1 remains (it is a world-space _mask compositor_ product with non-screen consumers — skyReach bake) until Phase 3 folds outdoors into per-pixel attributes entirely. M4 remains until B5, then shrinks.

## 6. Open questions for B1 (carry into implementation, do not block B0)

1. **Resolution:** full render resolution vs half-res (M3 is half-res today and nobody complained). Recommendation: full-res first (it's RGBA8 — 8 MB at 1440p; the win of exact ID edges outweighs the memory), measure, then decide.
2. **MSAA:** the unified pass is currently non-MSAA (post stack does its own AA). If MSAA ever lands, ID attachments must resolve via "any sample" not average — flag now, ignore until relevant.
3. **Tokens/doors/map-points:** do token sprites write attributes (they are floor-owned geometry) or stay transparent readers? Recommendation: readers in B1 (matches today's compositing), revisit when token lighting moves per-fragment in B2.
4. **Blend-mode audit:** confirm every material that will draw inside the unified pass satisfies the §3.1 zero-write rule — the inventory in B0-3 §2 is the checklist.
