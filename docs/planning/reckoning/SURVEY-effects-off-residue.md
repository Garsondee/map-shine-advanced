# Reckoning survey — WHAT STILL RUNS WITH EVERY EFFECT DISABLED

*Captured 2026-08-15 (second sweep, post effects-off A/B) by Claude Fable 5 via a read-only
scout. Prompted by the author's live measurement: ALL effects disabled → ground ≈120 fps,
upper floor ≈20 fps. Treat as a map; re-verify lines you build on (vt-pan-viewer.js is under
live edit — some cites may drift a few lines).*

## 1. The enable machinery — and the fact there is NO "all effects" switch

- Resolver: `effect-cascade.js:101` `resolveEffectEnabled` (profile → GM world → player client →
  photosensitive force-off; 'auto' inherits). Keys: `effect-settings.js:47` `${id}.gmEnable`/`.playerEnable`.
- Globals: `msaEnabled` (client, reload — the ONLY master switch: MSA off entirely, Foundry renders),
  `performanceProfile` (default **standard**), `reducePhotosensitiveEffects`.
- **No master "disable all effects" exists** — the control panel builds one checkbox per effect
  (`diag/effect-controls.js:724-740`). The author's test = 15 per-effect toggles off.
- The 15 registered effects: uiWindowShadow, candleFlame, lightning, fire, vegetation, bloom,
  depthOfField, sunShadows, grade, doorGraphics, water, fluid, specular, window, apertureGobo.
- **NOT effects (no toggle reaches them):** region darkness · point lights (Foundry lights) ·
  occlusion mask · depth authority + early-Z prepass · albedo clarity (CAS) · token sync · env
  snapshot · wind sim · residency/streaming. Structural toggles exist separately:
  `earlyZComposition` (default true), `pointLightMrtMerge` (default false).

## 2. What still executes per frame, effects off

- The 8-pass plan is FIXED: `planFrame` filters on `status==='live'` only; computed once
  (`:5497`); no effect can remove a pass — every skip must be a JS early-return inside a pass.
- Unconditional every frame: hitch bookkeeping · `updateContinuousInputs` · `syncTokenPlacements`
  (all itemStates) · `updateEnvSnapshot` (+grade identity push) · `updateCamera` · `runPassPlan`.
- `masks.occlusion`: **no gate** — full clear + `render(occlusionScene)` even with zero occluders,
  plus a uOcclusionElevation refresh over EVERY itemStates entry × tiles.
- `geometry.world`: **no gate** — depth pass render, prepass clear+render (earlyZComposition only),
  world render, doors (leafCount gate).
- `light.accumulate`, still running with effects off:
  `getActiveSceneFloors` per frame (allocating walk+sort) · ambient resolve · sun-shadow
  maybeBake loop collapses cheaply when off (JSON.stringify NOT reached) BUT the 6-slot uniform
  push loop always runs · region darkness reconcile (**not an effect**) · `pointLights.update`
  (**not an effect** — wall-clip cache, source builds) · `syncAllVegetationMotionForFrame`
  (**no enable gate** — walks all itemStates × tiles even with zero vegetation) ·
  `syncAllFloorAttrUniformsForFrame` (**no gate, deliberately UNZONED**, O(items×tiles),
  per-item floor-band re-resolves) · specular `sync` incl. **`JSON.stringify(layerParams)` every
  frame even when disabled** (`specular-surface-subsystem.js:512`) · window per-floor loop:
  rank lookups + `ensureMaskImage` (**loads `_Window` masks with the effect off**) + subsystem
  CONSTRUCTION on demand + an 18-field string key with 3× toFixed per floor per frame — only
  the draw is gated · then the unconditional GPU tail: illum quad, regionScene render,
  lightScene render, apertureShadowScene render (documented always-rendered), coloration
  render, composite quad (uiShadow visNode always evaluated), present quad (grade math at
  identity uniforms).
- Correctly skipped when off (zero GPU): bloom, DoF, specular draw, particles, candle/lightning/
  fire draws, doors, sun-shadow bake, window/water/fluid draws.

## 3. Why the upper floor is still 6× with effects off

- The draw list is a function of the viewed floor: `computeVisibleFloorIndices`
  (`active-scene-source.js:280-288`) = viewed floor + every floor its `visibility.levels` names.
  Upper view composites BOTH floors' art+tiles; ground view only its own.
- The project's own audit already measured it (Performance-Audit-2026-08 §15, effects unchanged,
  floor changed): `geometry.worldDraw` **133.093 ms** GPU/22 draws upper vs ~11 ms/16 lower;
  `geometry.depthDraw` **44.287 ms**/9 vs ~1 ms/6. §19 latest: worldDraw 26.7 ms + depthDraw
  7.9 ms, **avgFps 18.1** on the upper floor — matching the author's ~20 fps.
- Per-fragment driver is gated by PROFILE, not effects: `shouldUseFullAlbedoClarity` = rank≥2 →
  **standard default keeps the full 5-tap CAS** + 1 solidity tap (6 taps/fragment/layer), decided
  ONCE at material build. **Fails OPEN to the expensive path on a settings-read throw** (:16025-16036
  region) — a scene built before game.settings is ready keeps 5-tap forever regardless of profile.

## 4. Suspect table (runs with effects off AND floor-scaled), by weight

1. `geometry.world` colour draw — O(stacked layers) fill · 2. depth pass render · 3. early-Z
prepass clear+render (structural flag, not effect) · 4. `syncAllFloorAttrUniformsForFrame`
(unzoned) · 5. occlusion uOcclusionElevation loop · 6. `syncAllVegetationMotionForFrame` ·
7. `syncTokenPlacements` · 8. window per-floor CPU loop (draw gated, sync not) ·
9. `getActiveSceneFloors` per frame · 10. sun-shadow maybeBake loop (weak) · 11. 6-slot uniform push.

## 5. Oddities flagged (O-numbers cited in the Reckoning doc)

O1 floor-attr sweep deliberately unzoned · O2 specular JSON.stringify per frame while disabled ·
O3 `lastRegionGating` diagnostic rebuilt per frame unconditionally · O4 `windSpawnRect` allocated
per frame with both consumers default-off · O5/O6/O7 per-frame `new Set()` in window prune /
occlusion / region reconcile beside scratch-reuse patterns · O8 four separate `viewToWorldRect`
allocations per frame · O9 `renderer.getClearColor(new THREE.Color())` allocations · O10 three
always-rendered empty scenes · O11 uiShadow visNode + grade compiled-in, uniform-gated (documented
exceptions) · O12 unproven colour-only reclear kept in the hot early-Z path · **O13 Case-1
self-vegetation tiles KEEP their wind material after the effect is disabled until scene reload —
"all effects off" ≠ no vegetation shader** · O14 window masks load + subsystems construct while
off · O15 framePlan cached for the session · **O16 albedo clarity fails OPEN + read-once** ·
**O17 `reapplyById` hand-map missing lightning/fire/sunShadows — the EFFECT_REAPPLIERS class
again (7th strike)** · O18 sun-shadow JSON.stringify per floor per frame on the ENABLED path.
