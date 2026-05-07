# Multi-floor rendering: infrastructure research

This document summarizes how Map Shine Advanced structures multi-floor (Levels / elevation-band) rendering today, what works well, where fragility and tech debt concentrate, and concrete opportunities to harden the system. It focuses on `FloorStack` (semantic floor bands + visibility rules), `FloorCompositor` (V2 render orchestration), and their collaboration with GPU masks, shadows, diagnostics, and Foundry integration.

---

## 1. Architecture overview (data flow)

### 1.1 Floor semantics: `FloorStack`

`FloorStack` is created during canvas/scene setup (`canvas-replacement.js`), wired to `TileManager` and `TokenManager`, and exposed as `window.MapShine.floorStack`. It rebuilds floor bands from the same merged scene bands used for level navigation (`getSceneBandsForFloorStack()`), or falls back to a single deterministic band when Levels data is absent.

Each band carries metadata aligned with the GPU mask compositor:

```116:128:scripts/scene/FloorStack.js
  rebuildFloors(sceneBands, activeLevelContext) {
    if (sceneBands?.length > 0) {
      // Build a FloorBand for each Levels scene band, sorted bottom-to-top.
      const sorted = [...sceneBands].sort((a, b) => Number(a.bottom) - Number(b.bottom));
      this._floors = sorted.map((band, i) => ({
        index: i,
        elevationMin: Number(band.bottom),
        elevationMax: Number(band.top),
        key: `floor_${i}_${band.bottom}`,
        // Matches GpuSceneMaskCompositor._floorMeta key format used in composeFloor().
        compositorKey: `${band.bottom ?? ''}:${band.top ?? ''}`,
```

**Visible floors for stacking:** `getVisibleFloors()` returns floors from ground through the **active** band (bottom→top). That matches the mental model “look down through holes in upper tiles.”

```166:176:scripts/scene/FloorStack.js
  /**
   * Returns the floors that should be rendered this frame: all floors from the
   * bottom (floor 0) up to and including the active floor, in bottom-to-top
   * order. Lower floors are visible through gaps in higher floor tiles.
   *
   * In a single-floor scene this returns exactly [floor 0].
   * @returns {FloorBand[]}
   */
  getVisibleFloors() {
    if (this._floors.length <= 1) return this._floors.slice();
    return this._floors.slice(0, this._activeFloorIndex + 1);
  }
```

Tile/token membership uses Levels range overlap, elevation bands, or (on Foundry v14 native Levels) `levelId` / document membership — see `_tileIsOnFloor` / `_tokenIsOnFloor` in the same file.

### 1.2 V2 rendering: `FloorCompositor` + `FloorRenderBus`

`EffectComposer` delegates the entire V2 frame to `FloorCompositor.render()` (see `scripts/effects/EffectComposer.js`). The compositor owns `FloorRenderBus`, which holds a **single** Three.js scene whose tile meshes are Z-ordered by floor index; visibility is controlled via `setVisibleFloors(maxFloorIndex)` so only floors `0 … active` participate unless a narrower slice is rendered.

The high-level pipeline is documented at the top of `FloorCompositor.js`: global shadow/cloud-related work, then **per-level** RT work for each visible band, **merge** via straight-alpha compositing, optional **post-merge water** when multiple floors are visible, then distortion / PIXI bridge / debug overlay / screen blit.

```9:17:scripts/compositor-v2/FloorCompositor.js
 * Render pipeline:
 *   1. Global shadow/cloud passes, then each visible level: bus slice → level RTs,
 *      full post chain **per level** (lighting … filter … per-level water **only when a single
 *      floor is visible** … color correction … bloom …) **before** merge.
 *   2. **LevelCompositePass** blends per-level final RTs bottom→top (straight-alpha).
 *      With **multiple** visible floors, **WaterEffectV2** runs **once after** this
 *      merge so `tDiffuse` is the stacked scene (holes/stacking already correct).
 *      Single-floor keeps water inside the per-level chain (bloom MRT / spec path).
 *   3. Distortion, PIXI/fog/lens, mask debug, blit to screen, late overlays.
```

The per-level loop explicitly pulls **visible** bands from `FloorStack`:

```5056:5060:scripts/compositor-v2/FloorCompositor.js
    // Collect visible levels bottom→top.
    const floorStack = window.MapShine?.floorStack;
    const visibleFloors = floorStack?.getVisibleFloors?.() ?? [];
    if (!visibleFloors.length) return null;
    const usePostMergeWater = visibleFloors.length > 1;
```

Active floor changes propagate bus visibility, effect notifications, mask compositor sync, and outdoors binding — see `_applyCurrentFloorVisibility` (coordinates `floorStack.setActiveFloor`, `GpuSceneMaskCompositor.syncActiveFloorFromFloorStack`, `_syncOutdoorsMaskConsumers({ force: true })`, etc.).

### 1.3 GPU masks: `GpuSceneMaskCompositor`

Per-floor mask textures are keyed by the same `${bottom}:${top}` strings as `FloorStack.compositorKey`. Consumers resolve textures via `getFloorTexture(floorKey, maskType)`; the compositor can align its notion of “active floor” with `FloorStack`:

```2028:2058:scripts/masks/GpuSceneMaskCompositor.js
  /**
   * Align `_activeFloorKey` with FloorStack's viewed band. `preloadAllFloors` uses
   * `composeFloor(..., { cacheOnly: true })`, which returns before updating this
   * field, so it can stay on the last precomposed band and desync from the player
   * level (breaks getCpuPixels() and diagnostics).
   */
  syncActiveFloorFromFloorStack() {
    let af = null;
    try {
      af = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    } catch (_) {
      af = null;
    }
    const fk = af?.compositorKey != null ? String(af.compositorKey) : null;
    if (!fk) return;
    if (fk === this._activeFloorKey) return;
    // ...
    this._activeFloorKey = fk;
```

`composeFloor()` (async) populates `_floorCache` / `_floorMeta`; upper-floor shelter and overhead shadows depend on those textures existing when effects sample them (see `MULTI_FLOOR_SHADOW_CASCADE.md` in-repo).

### 1.4 Outdoors resolution bridge: `resolve-compositor-outdoors.js`

`FloorCompositor._resolveOutdoorsMask` and shared helpers use `resolveCompositorOutdoorsTexture` to pick the correct `_Outdoors` RT when `activeLevelContext` and `floorStack` disagree or textures are still warming — explicit ordering of candidate keys and multi-floor guards:

```5:14:scripts/masks/resolve-compositor-outdoors.js
 * Order: **FloorStack active floor** (compositorKey + elevation band) → active level band key
 * → compositor._activeFloorKey, then sibling keys (same band bottom in _floorMeta / _floorCache),
 * then ground band.
 *
 * Rationale: GpuSceneMaskCompositor keys masks by rendered floor bands. `activeLevelContext`
 * (CameraFollower) can briefly disagree with `floorStack` (e.g. scene-background vs upper
 * tile floor). Including a stale level band in the candidate list after floor-stack keys
 * caused wrong-band _Outdoors (e.g. all-black underground) to win whenever the viewed
 * floor's texture was not found yet (async compose): tryKey(underground) succeeded before
 * the correct floor's RT existed.
```

### 1.5 Shadows and weather

- **Overhead / building / painted shadows:** Effects consult `floorStack` for multi-floor behavior and bind outdoors masks from the compositor (see `OverheadShadowsEffectV2`, `BuildingShadowsEffectV2`, wired from `_syncOutdoorsMaskConsumers` in `FloorCompositor`).
- **Shadow combine:** `ShadowManagerV2` merges cloud × overhead × building into a **lit-factor** convention consumed by lighting and water (`MULTI_FLOOR_SHADOW_CASCADE.md` diagrams this).
- **WeatherController:** `roofMap` is fed from the resolved outdoors path (`FloorCompositor` calls `weatherController.setRoofMap(outdoorsTex)` after mask sync); CPU readback paths reference `floorStack` / compositor floor keys for diagnostics-sized probes (`WeatherController.js` grep hits).

### 1.6 Diagnostics

- **HealthEvaluatorService:** Tracks `floorStackCount`, active floor index, and flags risks like multi-floor binding drift (`multiFloorBindingRisk`, etc.).
- **RenderStackSnapshotService:** Metadata-only snapshot of pass order and bus blur path vs floor index (`captureRenderStack` reads `floorCompositor._renderBus._visibleMaxFloorIndex`, blur enablement when `busMax > 0`).
- **Mask debug:** `MaskDebugOverlayPass` exposes operator-facing overlays (outdoors current level, overhead shadow debug textures, etc.).
- **Diagnostic center:** Wraps compositor `composeFloor` for rate telemetry (`diagnostic-center.js`).

---

## 2. Components inventory (multi-floor touchpoints)

| Area | Role |
|------|------|
| `scripts/scene/FloorStack.js` | Floor band array, active index, tile/token floor tests, `compositorKey`, `getVisibleFloors`. |
| `scripts/foundry/canvas-replacement.js` | Lifecycle: construct `FloorStack`, `rebuildFloors` on level hooks, assign `window.MapShine.floorStack`. |
| `scripts/compositor-v2/FloorCompositor.js` | Full V2 orchestration: strict-sync gate, outdoors sync, per-level RT pipeline, merge, post-merge water, hooks to shadow passes. |
| `scripts/compositor-v2/FloorRenderBus.js` | GPU tile bus: Z-order by floor, `setVisibleFloors`, `renderFloorRangeTo` per slice. |
| `scripts/masks/GpuSceneMaskCompositor.js` | Per-band GPU masks, `composeFloor`, `getFloorTexture`, `syncActiveFloorFromFloorStack`, cache versioning. |
| `scripts/masks/resolve-compositor-outdoors.js` | Canonical `_Outdoors` texture resolution for compositor consumers. |
| `scripts/masks/mask-binding-controller.js` | Optional unified mask fan-out (feature-flagged); uses `FloorStack` for indices / visible floors. |
| `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js` | Upper-floor mask terms + sky-reach; reads `floorStack`. |
| `scripts/compositor-v2/effects/BuildingShadowsEffectV2.js` | Multi-floor outdoor/skip-ground rules; `floorStack`. |
| `scripts/compositor-v2/effects/ShadowManagerV2.js` | Combines shadow channels for downstream lighting/water. |
| `scripts/compositor-v2/effects/PaintedShadowEffectV2.js` | Outdoors-mask-driven; synced via compositor outdoors path. |
| `scripts/compositor-v2/MaskDebugOverlayPass.js` | Debug visualization for masks / overhead intermediates. |
| `scripts/core/WeatherController.js` | `roofMap` + floor-scoped outdoors sampling for gameplay systems. |
| `scripts/core/diagnostics/HealthEvaluatorService.js` | Health signals including floor stack metrics. |
| `scripts/core/diagnostics/RenderStackSnapshotService.js` | Static render-stack description for tooling. |
| `MULTI_FLOOR_SHADOW_CASCADE.md` | Design note: current 2D mask cascade limits + future height-field cascade. |

---

## 3. Pros (what works well)

1. **Stable string keys across stack and masks:** `compositorKey` matches `GpuSceneMaskCompositor` floor keys, reducing ambiguity when debugging “wrong band” sampling.

2. **Explicit “visible stack” semantics:** `getVisibleFloors()` encodes the through-the-floor stacking model separately from “which band is the camera level,” which matches how `LevelCompositePass` merges RTs.

3. **Battle-tested outdoors routing:** `resolveCompositorOutdoorsTexture` documents real failure modes (async compose vs stale context) and orders candidates to prefer the viewed floor.

4. **Merge correctness for holes:** Per-level alpha rebind after the post chain keeps authored transparency authoritative so lower floors show through carved holes — documented inline in `_renderPerLevelPipeline`.

5. **Operational guardrails:** Strict-sync validation (`renderStrictSyncEnabled`), `_enforceBusVisibilityForActiveFloor`, `_enforceTileSpriteVisibilityForActiveFloor`, and `__v2OutdoorsRoute` / frame trace hooks give operators and developers leverage when diagnosing stuck states.

6. **Shadow pipeline documentation:** `MULTI_FLOOR_SHADOW_CASCADE.md` explains lit-factor conventions, consumer wiring, and distinguishes **upper-floor indices strictly above the viewer** from same-band geometry limits.

---

## 4. Cons, risks, and tech debt

1. **Global coupling:** Most modules reach `window.MapShine.floorStack` and `sceneComposer._sceneMaskCompositor` directly. That complicates testing, headless simulation, and future isolation of render phases.

2. **Dual sources of truth for “where am I?”:** `activeLevelContext` (CameraFollower) and `FloorStack` can diverge during transitions. `FloorCompositor` and `FloorStack` both embed overlapping “resolve index from context” logic — duplication invites edge-case drift.

3. **`FloorStack` visibility toggle API vs V2 bus path:** `setFloorVisible` / `restoreVisibility` are documented as part of a per-floor EffectComposer loop, but **there are no call sites** elsewhere in this repository (only references in comments). Meanwhile V2 relies on `FloorRenderBus.setVisibleFloors` and tile-sprite enforcement. Either the PIXI-side toggle is legacy/unwired, or callers live outside the searched tree — either way, **documentation and implementation risk diverging**.

4. **Async mask compose vs effects:** Upper-floor overhead and sky-reach need GPU textures that may appear mid-session; the codebase mitigates with cache versioning in outdoors signatures and neutral-indoor fallbacks, but transient wrong-band or all-indoor states remain user-visible.

5. **Hardcoded band limits in some paths:** Cloud per-floor outdoors binding loops floors with index capped at 3 in `_syncOutdoorsMaskConsumers` — scenes with more than four bands may silently fall back to single-mask behavior for clouds.

6. **Cost:** Rendering a **full post chain per visible level** scales with the number of stacked bands the player can see; worst-case performance and VRAM use grow with floor count and resolution.

7. **Complexity concentration:** `FloorCompositor.js` is very large; multi-floor behavior is intertwined with outdoors routing, water floor context, shadow combine, and diagnostics — high cognitive load for changes.

---

## 5. Opportunities (concrete improvements)

### 5.1 API boundaries and dependency injection

- Introduce a narrow **`FloorRenderContext`** (or similar) interface: `{ getBands(), getActiveBand(), getVisibleBands(), getCompositorKey(band) }`, injected into effects that currently read globals. Keeps Foundry-specific wiring in one module.

- Thread **`GpuSceneMaskCompositor` + `FloorStack`** references through constructors or an explicit `MaskServices` bag instead of `window` lookups inside hot paths (incremental migration starting with new code).

### 5.2 Reconcile or retire `setFloorVisible`

- **If still needed for PIXI depth or legacy passes:** Wire `setFloorVisible` / `restoreVisibility` from the actual per-floor render loop (or delete the API if the bus path fully subsumed it).
- **If retired:** Update `FloorStack` file header and `depth-pass-manager.js` comments so future readers do not assume a loop that does not exist.

### 5.3 Testing

- **Pure unit tests** for: band sorting, `compositorKey` formatting, `_resolveActiveFloorIndex` / context matching, and `resolveCompositorOutdoorsTexture` candidate ordering (table-driven fixtures).

- **Integration smoke tests** (where harness exists): single-floor vs multi-floor scene fixtures asserting `getVisibleFloors().length` and mask key alignment.

### 5.4 Performance

- Per-frame **budget telemetry**: time spent per `levelIndex` in `_renderPerLevelPipeline`, mask `composeFloor` rate (already wrapped in diagnostic center), and GPU memory per `LevelRenderTargetPool` entry.

- **Adaptive quality:** optional decimation of upper-band passes (e.g. half-res shadow masks for non-active bands) behind graphics presets.

### 5.5 Debuggability

- Extend **RenderStackSnapshot** / diagnostic exports with: floor cache version, per-key mask presence (`floorAlpha`, `outdoors`, `skyReach`), and last `_syncOutdoorsMaskConsumers` signature — mirrors console probes in `MULTI_FLOOR_SHADOW_CASCADE.md`.

- Single **`MapShine.dumpFloorState()`** helper (building on `console-helpers.js`) returning bands, active key, and `getFloorTexture` availability — reduces operator friction.

### 5.6 Authoring and product guidance

- Publish mapper-facing rules when **bridge vs water must be separate bands** vs when roof capture suffices — the shadow cascade doc already states the limitation; linking it from mapper docs reduces support burden.

---

## 6. Open questions

1. **Supported maximum floor count:** What is the official ceiling for Levels bands in Map Shine V2, given cloud binding currently emphasizes indices `0…3`?

2. **Intended use of `FloorStack.setFloorVisible`:** Should PIXI `TileManager` / `TokenManager` sprites participate in the same per-slice visibility as the bus for any remaining passes, or is full migration to bus + enforcement intended?

3. **Strict-sync policy:** When validation fails, is the “hold frame” UX acceptable for all presets, or should certain gameplay modes disable strict sync automatically?

4. **Long-term shadow model:** Will **height-aware cascades** (per `MULTI_FLOOR_SHADOW_CASCADE.md`) replace parts of the mask-only upper-floor path, and if so, which subsystem owns band-vs-sub-band geometry?

5. **Mask manifest + multi-floor:** How should `mask-manifest-flags` / bundle discovery interact when different floors use different base paths — is the current “one manifest + per-floor compose” model sufficient for commercial maps?

---

## 7. Related reading

- `MULTI_FLOOR_SHADOW_CASCADE.md` — shadow semantics, debugging checklist, future cascade notes.
- `FLOOR_RENDER_PIPELINE_AUDIT.md` (referenced from shadow doc) — broader pipeline audit if present in the tree.

---

*Generated as a research snapshot; code citations reflect the repository state at authoring time.*
