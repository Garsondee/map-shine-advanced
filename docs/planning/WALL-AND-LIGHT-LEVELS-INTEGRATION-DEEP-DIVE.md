# Wall + Light Tools Levels Integration Deep Dive

## Status
- Date: 2026-02-18
- Scope: Wall creation, light creation, and multi-level light masking behavior in gameplay mode
- Goal: Define how new walls/lights should default from active level context and how cross-level light bleed should be handled

---

## 1) Executive Summary

The current runtime already has **strong Levels visibility support** for rendering and LOS, but wall/light **creation flows are not yet level-aware by default**.

### What is already true
- Light runtime visibility is elevation-gated via `isLightVisibleForPerspective` in `LightingEffect`.
- Wall height flags are already respected by LOS and door interaction checks.
- Active level context (`window.MapShine.activeLevelContext`) is mature and used by other systems.

### What is missing
- New walls drawn in gameplay mode do not seed `flags['wall-height']` from active level.
- New ambient lights drawn in gameplay mode do not seed `elevation` + `flags.levels.rangeTop` from active level.
- Ambient light copy/paste path also does not seed missing Levels defaults.
- Light icon visibility does not currently appear to be level-filtered.

### Recommendation
Adopt the same pattern used in template creation:
1. Add centralized create-default helpers for walls/lights from active level.
2. Apply them at creation callsites (draw, paste) and optionally via preCreate hooks for parity.
3. Add a staged plan for "light above through floor gaps" using floor alpha masks + level-aware occlusion.

---

## 2) Current Architecture and Evidence

## 2.1 Active level context (already available)
`CameraFollower` publishes active level context globally and emits `mapShineLevelContextChanged`.
- `window.MapShine.activeLevelContext` carries `bottom/top/center/index/count/lockMode`.

Evidence:
- `scripts/foundry/camera-follower.js` publishes global context + hook payload.

## 2.2 Canonical elevation API (already available)
`getPerspectiveElevation()` is the canonical resolver (controlled token > active level > background).

Evidence:
- `scripts/foundry/elevation-context.js` (`getPerspectiveElevation`).

## 2.3 Light runtime visibility is already Levels-aware
`LightingEffect` calls `isLightVisibleForPerspective(rawDoc)` during active-light filtering.

Evidence:
- `scripts/effects/LightingEffect.js` (`_isLightActiveForDarkness`).
- `scripts/foundry/elevation-context.js` (`isLightVisibleForPerspective`).

## 2.4 Wall vertical bounds are already consumed at runtime
- Vision/LOS: wall-height bounds filter in `VisionPolygonComputer`.
- Door interactions: non-GM door toggle/lock checks wall height vs token elevation.

Evidence:
- `scripts/vision/VisionPolygonComputer.js` (wall-height filtering in `wallsToSegments`).
- `scripts/scene/interaction-manager.js` (`_isDoorWallAtTokenElevation`).

## 2.5 Creation flows are not level-aware yet
### Walls
Gameplay wall draw end builds data via `getWallData(tool, coords)` and creates document with no wall-height flags.

Evidence:
- `scripts/scene/interaction-manager.js` (wall draw end -> `createEmbeddedDocuments('Wall', [data])`).
- `scripts/scene/interaction-manager.js` (`getWallData`) currently sets only wall behavior fields.

### Ambient lights
Gameplay light draw end creates `AmbientLight` with `x/y/config` only, no explicit `elevation` or Levels range flags.

Evidence:
- `scripts/scene/interaction-manager.js` (light placement end -> `createEmbeddedDocuments('AmbientLight', [data])`).

### Ambient light paste
Paste path duplicates existing document payload and re-creates it; no active-level seeding for missing range fields.

Evidence:
- `scripts/scene/interaction-manager.js` (Ctrl/Cmd+V light paste flow).

## 2.6 Existing pattern to copy
Measured templates already implement pre-create defaults from active level context.

Evidence:
- `scripts/scene/template-manager.js` (`_onPreCreateMeasuredTemplate`) seeds:
  - default `elevation`
  - `flags.levels.rangeBottom/rangeTop`
  - `flags.levels.special`

This is the exact design pattern we should reuse for walls and lights.

---

## 3) Foundry + Levels Data Model Constraints

## 3.1 Foundry wall schema
Core Wall document has no native `elevation` or `rangeTop`; verticality comes from extension flags.

Evidence:
- `foundryvttsourcecode/resources/app/public/scripts/foundry.mjs` (`BaseWall.defineSchema`).

## 3.2 Foundry ambient light schema
AmbientLight has core `elevation` field.

Evidence:
- `foundryvttsourcecode/resources/app/public/scripts/foundry.mjs` (`BaseAmbientLight.defineSchema`).

## 3.3 Current Levels compatibility readers
Map Shine already normalizes:
- doc ranges: `flags.levels.rangeBottom/rangeTop` (with `elevation` fallback)
- wall heights: `flags['wall-height'].bottom/top`

Evidence:
- `scripts/foundry/levels-scene-flags.js` (`readDocLevelsRange`, `readWallHeightFlags`).

Implication:
- **Walls** should write `flags['wall-height']` defaults.
- **Lights** should write core `elevation` + `flags.levels.rangeTop` defaults.

---

## 4) Gap Analysis

## G1. Wall creation lacks vertical defaults
New walls are effectively unbounded unless manually edited later.
- Result: floors can accidentally block/occlude across all elevations.

## G2. Light creation lacks level defaults
New lights do not inherit active floor band.
- Result: easy cross-floor bleed and confusing visibility outcomes.

## G3. Light authoring parity gaps
Paste and potential non-draw create paths can bypass level defaults.

## G4. Light icon UX can diverge from light runtime visibility
If icons remain unfiltered by level, users can edit lights not currently relevant to viewed floor, which may be desirable for GM tooling but should be deliberate and configurable.

## G5. "Light above through floor gaps" is not explicitly modeled
Current lighting pass composes roof alpha/outdoor/shadow masks, but does not include a per-floor occlusion volume from level tiles.

Evidence:
- `scripts/effects/LightingEffect.js` composite logic uses masks (`roofAlphaRaw`, outdoors, shadow passes) and multiplies lighting in screen-space.

---

## 5) Target Behavior (Product Semantics)

## 5.1 Wall tool behavior
When drawing a wall while a finite active level band exists:
- Default wall-height bottom = active `bottom`
- Default wall-height top = active `top`

Fallbacks:
- If no active band, keep current behavior (no wall-height flags).

## 5.2 Light tool behavior
When placing a light while a finite active level band exists:
- Default light `elevation` = active level center (or bottom; see decision D1)
- Default `flags.levels.rangeBottom` omitted (reader already falls back to `elevation`)
- Default `flags.levels.rangeTop` = active `top`

Fallbacks:
- If no active band, keep current behavior.

## 5.3 Non-tool creation parity
Apply same defaults for:
- light paste flow
- optional preCreate hooks for AmbientLight and Wall to catch macro/native creation

## 5.4 Cross-level light masking (future)
When evaluating lighting on a lower floor, upper-floor tile opacity should be able to attenuate/block light projection where graphics are opaque, while transparent gaps allow transmission.

---

## 6) Proposed Technical Design

## 6.1 New helper module
Create a shared helper, e.g.:
- `scripts/foundry/levels-create-defaults.js`

Suggested API:
- `getFiniteActiveLevelBand()` -> `{bottom, top, center}|null`
- `applyWallLevelDefaults(data, {source})`
- `applyAmbientLightLevelDefaults(data, {source})`
- `shouldApplyLevelCreateDefaults(scene)` (checks compat mode + scene enabled)

This avoids copy/paste logic in InteractionManager.

## 6.2 Wall create integration points
1. `InteractionManager.getWallData(...)`
   - after tool fields are set, call `applyWallLevelDefaults(data)`.

2. Optional hook path for parity:
   - `Hooks.on('preCreateWall', ...)` in a central foundry integration file
   - only patch when no explicit wall-height flags were provided.

Data shape to write:
```js
{
  flags: {
    'wall-height': {
      bottom: active.bottom,
      top: active.top
    }
  }
}
```

## 6.3 Ambient light create integration points
1. Interaction draw-create (`onPointerUp`, light placement)
   - call `applyAmbientLightLevelDefaults(data)` before create.

2. Interaction paste-create (`onKeyDown` paste, foundry light branch)
   - call helper only when pasted payload lacks explicit elevation/range.

3. Optional parity hook:
   - `Hooks.on('preCreateAmbientLight', ...)` to catch non-InteractionManager creates.

Data shape to write:
```js
{
  elevation: active.center, // or bottom per policy
  flags: {
    levels: {
      rangeTop: active.top
    }
  }
}
```

(Do not force `rangeBottom`; `readDocLevelsRange` already treats `elevation` as bottom fallback.)

## 6.4 Guardrails
- Never overwrite explicit author-provided values.
- Only seed defaults when fields are missing/null.
- Respect compatibility mode `off` and non-level scenes.

---

## 7) "Light Above Through Gaps" Research Direction

This is the harder, high-value rendering problem.

## 7.1 Problem definition
A light on level N+1 should not uniformly illuminate level N if an opaque floor tile blocks it; but it should leak through transparent holes/gaps.

## 7.2 Why current pipeline is insufficient
Current LightingEffect is screen-space and uses roof/outdoor/shadow masks, but lacks explicit per-level floor-transmission masks.

## 7.3 Phase plan
### Phase A (near-term, low risk)
- Enforce strict light level defaults + visibility filtering.
- Add optional setting to hide/edit only lights in active level in icon manager.

### Phase B (mid-term, targeted)
- Build per-level "floor opacity mask" atlas from tile alpha (world-space aligned).
- At lighting composite, compute source level vs viewer level and sample intermediate floor masks.
- Attenuate or block based on accumulated opacity.

### Phase C (long-term)
- Full vertical light transport model (token/light elevation-aware attenuation + floor stack traversal), potentially shared with fog/vision vertical logic.

## 7.4 Important coordinate note
All world-space mask sampling must respect existing scene bounds + Y flip conventions already used in Map Shine contracts.

---

## 8) Open Decisions

### D1. Light default elevation source
- Option A: active `center` (balanced default)
- Option B: active `bottom` (strict floor anchor)
- Option C: user setting (recommended)

### D2. Wall default height policy
- Option A: always [bottom, top] of active band (recommended)
- Option B: full-height by default unless user opts in

### D3. GM editing behavior for off-level lights
- Show all lights (current-style GM power)
- Show active-level lights only (clean floor-focused workflow)
- Toggle setting

### D4. PreCreate hooks ownership
- InteractionManager-only patch (simpler)
- Global hook + InteractionManager helper (best parity)

---

## 9) Implementation Work Packages

## WP-WL-1: Shared defaults helper
- Add `levels-create-defaults.js`.
- Unit-test pure helpers (if test harness available) or add deterministic debug logs.

## WP-WL-2: Wall draw integration
- Update `getWallData` to seed wall-height defaults.
- Verify wall draw, chain draw, endpoint drag preserve flags.

## WP-WL-3: Light placement integration
- Update light drag-create payload defaults.
- Update light paste payload defaults.

## WP-WL-4: Optional preCreate parity hooks
- Add `preCreateWall` and `preCreateAmbientLight` guarded handlers.
- Ensure no double-write if InteractionManager already seeded values.

## WP-WL-5: Light icon level filtering policy
- Add optional icon filtering by `isLightVisibleForPerspective`.
- Add setting for GM behavior.

## WP-WL-6: Cross-level light masking design spike
- Prototype per-level floor opacity mask extraction and shader hookup.
- Validate perf + visual correctness on multi-floor scenes with holes.

---

## 10) QA Matrix

1. Draw wall on Level 2 -> verify `flags['wall-height']` seeded to Level 2 band.
2. Place light on Level 1 -> verify `elevation/rangeTop` seeded from active band.
3. Paste light missing levels flags -> verify defaults seeded.
4. Paste light with explicit levels fields -> verify no override.
5. Toggle level and verify light runtime visibility still follows `isLightVisibleForPerspective`.
6. Door interaction by player at wrong elevation still blocked.
7. LOS on token at different elevation still respects wall-height bounds.
8. Non-level scene behavior unchanged.

---

## 11) Risks

1. Over-seeding legacy scenes where users expect full-height walls.
   - Mitigation: setting to disable auto wall-height defaults.

2. Inconsistent defaults between tool paths.
   - Mitigation: centralized helper + optional preCreate hooks.

3. Performance risk for per-level floor-mask light attenuation.
   - Mitigation: staged rollout with cache invalidation and bounded resolution.

---

## 12) Recommended Next Step

Implement **WP-WL-1 through WP-WL-3** first (small, high-impact, low risk), then run focused Foundry QA before Phase B rendering work.
