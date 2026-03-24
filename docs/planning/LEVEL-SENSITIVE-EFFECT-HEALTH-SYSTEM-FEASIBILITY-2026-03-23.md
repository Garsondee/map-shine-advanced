# Level-Sensitive Effect Health System Feasibility Study — 2026-03-23

## Purpose

Assess whether MapShine can detect when effects are broken, invalid, or missing critical components,
including cases where an effect works on one level but fails on another, and then visibly alert users.

---

## Short Answer

Yes. This is feasible in the current architecture.

The most practical path is a **layered health system**:

1. **Contract validation** (does the effect have what it must have?)
2. **Runtime integrity checks** (is it actively rendering/updated as expected?)
3. **Level-sensitive checks** (does behavior remain valid per floor/level context?)
4. **Escalating alerts** (diagnostic panel + on-screen warnings + optional hard popup)

This can start lightweight and become deeper over time without destabilizing the compositor.

---

## Problem Definition

Current issue pattern:

- An effect can look correct on one level and fail on another.
- Failures can be silent (no crash), making bugs hard to detect quickly.
- Existing logs/diagnostics are useful but not always proactive.

Desired capability:

- Automatically detect broken/invalid/missing effect state.
- Detect **per-level divergences** (healthy on L0, broken on L2).
- "Loudly proclaim" when severity is high and user action is needed.

---

## Feasibility Verdict

## Technical Feasibility: **High**

Reasons:

- V2 effects already follow known archetypes and lifecycle hooks.
- Level context is already tracked in several systems.
- A diagnostic center path exists and can be extended.
- Many failures are detectable through deterministic invariants.

## Delivery Feasibility: **Medium-High**

Reasons:

- Phase 1 can be implemented without expensive GPU readbacks.
- Deeper visual correctness checks (pixel semantics) are possible but should be opt-in.
- Requires consistent health contracts per effect archetype.

---

## What "Broken" Means (Operational Definition)

An effect is considered unhealthy if one or more of these conditions occur:

1. **Missing prerequisites**
   - required textures/masks/material uniforms/resources absent.
2. **Lifecycle invalid**
   - initialized but not populated; populated but not updated; active floor not applied.
3. **Topology mismatch**
   - expected floor states/systems/overlays missing for active level set.
4. **Stale bindings**
   - references changed/disposed but effect still points to old resources.
5. **Visual-contract breach**
   - effect produces implausible output for context (optional deep checks).

---

## Proposed Architecture

## 1) Core Components

### A) Effect Health Contract (per effect)

Each effect declares:

- `requiredResources` (textures, uniforms, render targets, systems)
- `requiredLifecycleState` (init/populate/update/floor-change expectations)
- `levelAwareExpectations` (what must exist per active level)
- `severityMap` (which failures are warning vs error vs critical)

This can be declarative metadata plus optional custom validators.

### B) Health Evaluator Service

Central service evaluates all effect contracts on triggers:

- scene ready
- effect initialize/populate
- floor/level change
- periodic interval (low frequency)
- explicit debug command

Output:

- normalized health records per effect and per level
- transition events (healthy -> degraded, degraded -> critical, recovered)

### C) Level Context Adapter

Single utility that resolves effective level/floor visibility and perspective context.
All health checks should read level context from this adapter to avoid source drift.

### D) Alert Dispatcher ("Loud Proclaim")

Escalation policy:

- **Info**: diagnostic center only
- **Warning**: diagnostic center + throttled UI toast/banner
- **Error/Critical**: prominent UI notification + persistent diagnostic entry
- Optional GM-only modal for repeated critical failures

---

## 2) Health Data Model

Suggested canonical key:

- `sceneId + effectId + levelKey`

Suggested status enum:

- `healthy`
- `degraded`
- `broken`
- `critical`
- `unknown` (before first validation)

Suggested record fields:

- timestamps (`firstSeen`, `lastSeen`, `lastRecovered`)
- check results (pass/fail per rule)
- context snapshot (active level, visible floors, token perspective)
- evidence strings for UI + logs

---

## 3) Level-Sensitive Validation Strategy

Use three check tiers:

### Tier 1: Structural (cheap, always on)

- Ensure required objects exist and are non-disposed.
- Verify expected floor state entries exist for active/visible floors.
- Verify render order / registration invariants.

### Tier 2: Behavioral (moderate, always on)

- Ensure update loop activity (delta ticks observed).
- Ensure floor-change handlers are applying active/inactive transitions.
- Ensure key uniforms/textures are changing when expected (not permanently stale).

### Tier 3: Visual Semantics (expensive, debug or sampled)

- Optional probe mode to validate sampled signal semantics at representative points.
- Use only when Tier 1/2 indicates likely hidden failure or when explicit debug is enabled.

This tier is useful for cases where data is present but semantically wrong (e.g., wrong channel meaning).

---

## Detection Examples (Relevant to Current Failure Class)

1. **Per-level missing system**
   - Fire/water particles active on L0 but no systems registered on L2 despite expected masks.
2. **Invalid blocker inputs on one level**
   - blocker texture bound but not changing across overhead state transitions for level context.
3. **Stale floor activation**
   - floor visibility changed but effect active set remains old floor list.
4. **Uniform drift**
   - expected per-level uniforms never update after `onFloorChange`.

Each can trigger level-specific alerts such as:
"WindowLightEffectV2 degraded on level 2: required overlay missing."

---

## Alerting and UX Plan

## Alert Levels

- `INFO`: passive diagnostic entry
- `WARN`: yellow UI notification, throttled
- `ERROR`: red notification + persistent center entry
- `CRITICAL`: persistent top-level warning + optional modal (GM)

## Anti-Noise Controls

- per-effect throttling window
- deduplicate repeating signatures
- recovery messages only when state actually improves
- GM verbosity settings (`normal`, `verbose`, `debug`)

---

## Implementation Plan

## Phase 1 (MVP, recommended first)

Scope:

- Add health contract scaffolding for high-risk V2 effects first.
- Implement structural + behavioral checks.
- Add per-level health records and warning/error alerts.
- Integrate with diagnostic center for persistent evidence.

Expected value:

- Quickly surfaces silent regressions and level-specific breakage.

Complexity:

- Moderate.

## Phase 2 (Hardening)

Scope:

- Expand contracts to remaining effects.
- Add transition analytics (frequency, recurrence, MTTR-like telemetry).
- Add richer diagnostics export for bug reports.

Complexity:

- Moderate.

## Phase 3 (Deep visual probes, optional)

Scope:

- Add opt-in sampled semantic probes for difficult shader/data mismatches.
- Include debug visualization overlays to inspect channels quickly.

Complexity:

- Medium-High (must be guarded for performance).

---

## Required vs Optional Dependency Model

To make diagnostics intelligent, each dependency should be classified by both
**criticality** and **intent context**.

## Dependency Classes

1. **Hard Required**
   - Effect cannot operate correctly without this dependency.
   - Missing/failing should raise `ERROR` or `CRITICAL`.
2. **Soft Required**
   - Effect still runs but behavior is materially degraded.
   - Missing/failing should raise `WARN` or `ERROR` based on severity.
3. **Optional Enhancer**
   - Missing/failing should not mark effect broken; may emit `INFO`.
4. **Contextual Required**
   - Required only when a condition is true (level visible, weather enabled, feature toggle on).
   - If condition false, missing should not alert.

## Intent-Aware Missing Asset Interpretation

A missing mask file is not always a bug. Classification should consider:

- whether the source tile/background itself exists and is active on this level
- whether feature flags/presets indicate the effect should be active
- whether this scene historically had this dependency (regression signal)
- whether user/module config intentionally disables the feature

Suggested verdict states for missing files:

- `INTENTIONAL_ABSENCE` (no alert or `INFO`)
- `EXPECTED_BUT_MISSING` (`WARN`)
- `REQUIRED_BUT_MISSING` (`ERROR/CRITICAL`)
- `UNKNOWN_INTENT` (`WARN` with lower confidence)

---

## Knock-On Consequence Mapping

Each dependency should include a consequence graph so diagnostics can explain
secondary breakage, not just the first missing piece.

Suggested impact tags:

- `visual_fidelity_loss`
- `level_isolation_failure`
- `temporal_desync`
- `cross_effect_desync`
- `performance_risk`
- `legacy_bridge_degradation`

Suggested consequence metadata:

- `downstreamConsumers`: which systems consume this output
- `failureMode`: what breaks downstream
- `blastRadius`: local effect vs multi-effect pipeline
- `detectability`: structural/behavioral/visual

This allows alerts like:
"WaterEffectV2 missing active-floor water data on level 2; knock-on risk:
WeatherParticles foam gating degraded."

---

## Water Effect First Case Study (Complex Interconnected Example)

`WaterEffectV2` is a strong baseline case because it is:

- floor-sensitive (`_floorWater` map, `onFloorChange` texture swaps),
- shader-heavy (large uniform surface),
- externally fed (outdoors/cloud/building/overhead textures),
- and connected to legacy/adjacent systems (`WeatherParticles` bridge).

## Water Dependency Classification

### Hard Required (for core water pass)

1. `initialize()` completed with compose scene/material/quad created.
2. `populate()` discovered at least one valid `_Water` source and built floor water data.
3. Active floor resolves to usable `tWaterData` or `tWaterRawMask`.
4. `render()` receives valid `inputRT` and `outputRT`.

Failure consequence:

- Water pass returns false/skips or renders no water contribution.

### Soft Required (major quality/function reduction)

1. SDF packing path (GPU JFA preferred, CPU fallback acceptable).
2. Stable wind/time update flow in `update()`.
3. Floor switch application (`onFloorChange` -> `_applyFloorWaterData`).

Failure consequence:

- water appears static, wrong on floor transitions, or significantly degraded.

### Contextual Required

1. `_Water` masks are required **only for tiles/background intended to contribute water**.
2. Occluder RT (`tWaterOccluderAlpha`) required only when upper-floor occlusion should apply.
3. Outdoors mask required only when indoor damping features are enabled.
4. Weather-driven wind/rain inputs required only when weather coupling is enabled.

Failure consequence:

- incorrect indoor/outdoor damping, occlusion, or weather response on specific levels.

### Optional Enhancers

1. `setCloudShadowTexture()`
2. `setBuildingShadowTexture()`
3. `setOverheadShadowTexture()`
4. Certain debug/advanced shader toggles

Failure consequence:

- visual quality loss (specular realism/shadow modulation), not total pass failure.

---

## Water Knock-On Map (Interdependency Chain)

1. **Missing/invalid floor water data**
   - Primary: `WaterEffectV2` cannot shade active level water.
   - Knock-on: legacy foam bridge (`setWaterDataTexture`) may lose correct gating.
2. **Incorrect active floor selection**
   - Primary: wrong water texture bound for current level.
   - Knock-on: appears "works on one floor, broken on another."
3. **Outdoors mask feed absent while damping enabled**
   - Primary: indoor damping semantics wrong.
   - Knock-on: rain/wave behavior divergence vs cloud/weather effects.
4. **Occluder texture absent with overhead blockers present**
   - Primary: upper-floor masking not enforced.
   - Knock-on: depth perception conflicts with overhead/tree systems.

---

## Water-Specific Health Contract Draft (Phase 1 Candidate)

For each evaluated level key:

1. **Structure checks**
   - compose material exists
   - `_floorWater` has entry or justified absence
   - active uniforms reflect selected floor
2. **Behavior checks**
   - `update()` observed within interval
   - floor-change event updates `_activeFloorIndex` and uniforms
3. **Context checks**
   - if level has water-designated assets, absence escalates
   - if no water-designated assets, treat as intentional absence
4. **Cross-effect checks**
   - if rain/weather enabled, verify rain-related uniforms are updating
   - if occluder-producing effects enabled, verify occluder availability flag consistency

---

## Intelligent Classifier Rules (Water Example)

Given tile/background base asset `X` on level `L`:

1. If no `_Water` companion exists and no scene intent indicates water on `L`:
   - classify `INTENTIONAL_ABSENCE` (no warning).
2. If scene/preset/effect state indicates water should exist on `L`, but no mask found:
   - classify `EXPECTED_BUT_MISSING` (`WARN`).
3. If water previously existed on `L` in-session and is now missing after refresh/change:
   - classify `REGRESSION_SUSPECTED` (`ERROR`).
4. If mask exists but cannot be decoded/composited:
   - classify `REQUIRED_BUT_INVALID` (`ERROR`).
5. If data exists but floor binding is wrong (healthy on L0, broken on L2):
   - classify `LEVEL_BINDING_FAILURE` (`ERROR/CRITICAL`).

---

## Water Case Study Acceptance Tests

1. **Intentional no-water level**
   - No warning when `_Water` masks are absent by design.
2. **Expected-water missing mask**
   - Warn with effect + level + asset base path evidence.
3. **Per-level divergence**
   - Detect when water renders on L0 but not on L2 despite valid inputs.
4. **Occlusion integration**
   - Detect mismatch when occluder-producing systems active but water occluder unavailable.
5. **Recovery**
   - After fixing mask/floor binding, system emits recovered state with cleared severity.

---

## Cloud Effect Second Case Study (High Interconnection + Multi-Pass)

`CloudEffectV2` is the next most complex candidate after water because it combines:

- multi-target render pipeline (`_shadowRT`, `_shadowRawRT`, `_cloudTopRT`, density RTs),
- level-sensitive blocker logic (overhead tiles above active floor),
- weather-coupled wind simulation and cloud-cover gating,
- downstream consumers (`LightingEffectV2`, `WindowLightEffectV2`, `WaterEffectV2`),
- outdoors/floor-ID mask integration with fallback paths.

## Cloud Dependency Classification

### Hard Required (core cloud behavior)

1. `initialize(renderer, busScene, mainCamera)` completed.
2. Render targets/materials are allocated and valid for current viewport.
3. `render()` executes pass sequence without fatal state gaps.
4. `cloudShadowTexture` is produced when cloud shadows are expected.

Failure consequence:

- missing cloud shadow contribution to lighting and shadow-dependent consumers.

### Soft Required (major degradation, still runnable)

1. Blocker mask pass (`_renderBlockerMask`) and overhead filtering logic.
2. Wind simulation coherence (`advanceWind` + `update`).
3. Top-density/cloud-top passes for elevated cloud presentation.
4. View-bounds consistency (`cloudShadowViewBounds`) for consumers.

Failure consequence:

- incorrect indoor shadowing, unstable drift, or cloud-top visual mismatches.

### Contextual Required

1. Outdoors masks and floor-ID texture are required when outdoors-gated shadowing is enabled.
2. Overhead blocker data is required when overhead occlusion is expected on current level.
3. Cloud weather state is required when weather-driven cover/wind is enabled.

Failure consequence:

- cloud shadows leak into interiors or disappear where expected.

### Optional Enhancers

1. Cloud-top stylistic parameters (peak detail, slice tuning).
2. Extra parallax/depth polish settings.
3. Raw shadow output for specific secondary consumers (context-dependent).

Failure consequence:

- reduced visual richness, not total cloud failure.

---

## Cloud Knock-On Map (Interdependency Chain)

1. **`cloudShadowTexture` invalid/unavailable**
   - Primary: `LightingEffectV2` loses cloud shadow modulation.
   - Knock-on: overall scene illumination no longer tracks cloud cover.
2. **`cloudShadowRawTexture` invalid**
   - Primary: indoor/raw-shadow consumers lose intended behavior.
   - Knock-on: `WindowLightEffectV2` may desync from cloud state assumptions.
3. **Blocker pass broken**
   - Primary: active-floor/overhead occlusion semantics fail.
   - Knock-on: shadows appear inside covered areas, causing level-credibility breaks.
4. **Outdoors/floor-ID mask mismatch**
   - Primary: wrong per-floor outdoors gating.
   - Knock-on: level-specific false shadows or missing shadows.
5. **View-bounds mismatch**
   - Primary: sampled shadow UV/world mapping drift.
   - Knock-on: downstream effects sample shifted cloud shadow fields.

---

## Cloud-Specific Health Contract Draft (Phase 1 Candidate)

For each evaluated level key:

1. **Structure checks**
   - cloud effect initialized and RTs present
   - blocker RT and shadow RT dimensions match expected internal scale
   - shadow uniforms have valid scene/view bounds
2. **Behavior checks**
   - `advanceWind` + `update` observed during active weather
   - `render` writes shadow target when cloud cover is non-zero
   - neutral clears occur when weather/cloud cover disabled
3. **Level-context checks**
   - active-floor overhead exclusion in blocker pass remains functional
   - per-floor outdoors masks/floor-ID fallback path is coherent
4. **Cross-effect checks**
   - `LightingEffectV2` receives non-null cloud shadow texture when required
   - `WaterEffectV2` and `WindowLightEffectV2` cloud-shadow inputs align with cloud state

---

## Intelligent Classifier Rules (Cloud Example)

1. If weather/cloud system is intentionally disabled:
   - classify `INTENTIONAL_ABSENCE` for missing cloud outputs.
2. If cloud cover > 0 and cloud effect enabled but no shadow output:
   - classify `REQUIRED_BUT_MISSING` (`ERROR`).
3. If shadow output exists but blocker/outdoors gating signals are inconsistent:
   - classify `LEVEL_GATING_INCONSISTENT` (`ERROR`).
4. If shadow output valid but consumers report null/bad mapping state:
   - classify `CROSS_EFFECT_DESYNC` (`ERROR/CRITICAL`).
5. If issue appears only on specific levels:
   - classify `LEVEL_SENSITIVE_FAILURE` with effect+level evidence.

---

## Cloud Case Study Acceptance Tests

1. **Intentional cloud-off**
   - No warnings when weather/clouds disabled by design.
2. **Shadow dependency active**
   - With cloud cover > 0, shadow RT must be generated and consumed.
3. **Level-sensitive blocker behavior**
   - Overhead tiles on active floor do not block; above-active blockers do block.
4. **Per-floor outdoors mask routing**
   - Shadow gating differs correctly between indoor/outdoor areas per level.
5. **Cross-effect coherence**
   - Lighting + water + window-light all respond consistently to cloud shadow state.
6. **Recovery**
   - After restoring blocker/mask inputs, alert severity returns to healthy.

---

## Overhead Shadows Third Case Study (Level-Sensitive Multi-Pass Capture)

`OverheadShadowsEffectV2` is a top-tier complexity case because it combines:

- multiple capture targets (`roofTarget`, `roofBlockTarget`, `roofVisibilityTarget`, `fluidRoofTarget`, tile projection/receiver targets),
- guard-band camera capture logic and UV remap behavior,
- runtime temporary overrides (opacity, visibility, tree uniforms, layer masks),
- indoor/outdoor gating via `_Outdoors` masks,
- optional tile-projection path driven by `TileMotionManager`,
- deep downstream coupling (`LightingEffectV2`, `SkyColorEffectV2`, plus roof-blocking consumers).

## Overhead Dependency Classification

### Hard Required (core overhead shadow correctness)

1. effect initialized with renderer/scene/camera and shadow mesh/material created.
2. main render targets allocated to current buffer size.
3. roof capture pass (`roofTarget`) and final shadow factor pass (`shadowTarget`) execute.
4. camera/layer state restoration completes after temporary overrides.

Failure consequence:

- overhead shading disappears, or frame-level corruption/incorrect scene state can leak into other passes.

### Soft Required (major degradation, partial function)

1. roof visibility pass (`roofVisibilityTarget`) for suppression semantics.
2. hard blocker pass (`roofBlockTarget`) for direct light occlusion integration.
3. fluid roof capture (`fluidRoofTarget`) and fluid shadow tint controls.
4. guard-band capture math and UV scale sync (`uRoofUvScale`, zoom-dependent projection).
5. depth modulation hookup (`depthPassManager`) for caster/receiver height behavior.

Failure consequence:

- shadows still render but with incorrect clipping, softness, directionality, or light suppression behavior.

### Contextual Required

1. `_Outdoors` mask required when indoor/outdoor receiver routing is enabled.
2. tree/weather roof-layer participation required when those actors should contribute blocker semantics.
3. tile projection targets required only when tile projection contributors are configured.
4. hover-reveal handling required when runtime roof visibility differs from caster intent.

Failure consequence:

- level-specific false positives/negatives (works on one level, breaks on another due to capture context drift).

### Optional Enhancers

1. fluid color/tint enhancement controls.
2. tile sort-based projection occlusion (currently fail-open path in some conditions).
3. advanced softness and saturation tuning.

Failure consequence:

- reduced visual nuance, but base overhead shadows can still remain functional.

---

## Overhead Knock-On Map (Interdependency Chain)

1. **`roofVisibilityTarget` invalid**
   - Primary: visible-roof suppression semantics fail.
   - Knock-on: `LightingEffectV2` may over-darken/under-darken roof-covered pixels.
2. **`roofBlockTarget` invalid**
   - Primary: hard blocker semantics unavailable.
   - Knock-on: effects relying on roof block texture can leak through covered regions.
3. **override restoration failure**
   - Primary: object visibility/layers/uniforms remain mutated after pass.
   - Knock-on: cross-effect rendering regressions and hard-to-trace state contamination.
4. **guard-band mismatch**
   - Primary: projected samples pull incorrect UV neighborhoods near screen edges.
   - Knock-on: level-dependent edge artifacts and unstable behavior during zoom changes.
5. **outdoors mask mismatch**
   - Primary: indoor/outdoor receiver classification wrong.
   - Knock-on: building/indoor shadow routing diverges from intended map semantics.
6. **tile projection channel failures**
   - Primary: selected caster tiles fail to project shadow or project incorrectly.
   - Knock-on: user-authored tile shadow systems lose parity across floors.

---

## Overhead-Specific Health Contract Draft (Phase 1 Candidate)

For each evaluated level key:

1. **Structure checks**
   - all required RTs/material/mesh exist and match active resolution
   - shadow factor texture is writable and non-stale during active pass
2. **Behavior checks**
   - render pass sequence completes (roof visibility -> roof/block captures -> final shadow)
   - temporary overrides are restored (visibility/layers/uniform snapshots)
   - update path binds current outdoors mask and sun direction
3. **Level-context checks**
   - active floor context participates in capture as expected
   - tree/weather participation toggles behave per pass intent
   - hover-reveal state does not suppress required caster data
4. **Cross-effect checks**
   - `LightingEffectV2` receives coherent `shadowFactorTexture`, `roofAlphaTexture`, `roofBlockTexture`
   - roof suppression outputs remain aligned with visible overhead state

---

## Intelligent Classifier Rules (Overhead Example)

1. If overhead shadows intentionally disabled:
   - classify `INTENTIONAL_ABSENCE` for shadow factor output.
2. If enabled and roof participants exist but `roofTarget`/`shadowTarget` missing:
   - classify `REQUIRED_BUT_MISSING` (`ERROR`).
3. If roof visibility exists but blocker/caster outputs disagree materially:
   - classify `CAPTURE_SEMANTIC_MISMATCH` (`ERROR`).
4. If state-restoration checks fail after render:
   - classify `STATE_LEAK_CRITICAL` (`CRITICAL`).
5. If failure only appears on selected levels or during level transitions:
   - classify `LEVEL_SENSITIVE_CAPTURE_FAILURE` (`ERROR/CRITICAL`).
6. If `_Outdoors` missing while indoor routing disabled:
   - classify `INTENTIONAL_ABSENCE` or low-severity `INFO` (context-aware).

---

## Overhead Case Study Acceptance Tests

1. **Intentional disabled state**
   - No false alarm when overhead shadow effect disabled by configuration.
2. **Baseline roof casting**
   - With overhead roof casters present, shadow factor updates every frame.
3. **Visibility/blocker parity**
   - `roofVisibilityTarget` and `roofBlockTarget` each satisfy their intended semantics.
4. **Level-sensitive behavior**
   - Switching levels preserves correct caster/blocker behavior without stale textures.
5. **State restoration integrity**
   - Object visibility/layer/uniform values restore after each render.
6. **Outdoors routing**
   - Indoor/outdoor receiver behavior matches `_Outdoors` intent per level.
7. **Recovery**
   - After restoring missing capture dependency, severity and knock-on alerts clear.

---

## Window Light Fourth Case Study (Isolated Scene + Cross-Pass Inputs)

`WindowLightEffectV2` is the next critical complexity tier because it uses:

- an isolated scene (not bus-managed) with manual floor visibility gating,
- per-tile mask discovery (`_Windows` / legacy `_Structural`) and overlay creation,
- cloud shadow + roof alpha inputs to modulate output in screen space,
- heavy shader feature surface (rain-on-glass, RGB split, environmental modulation),
- lighting-pipeline coupling (rendered into light accumulation, not pure post-additive).

## Window Light Dependency Classification

### Hard Required (core window lighting)

1. effect initializes isolated scene + shared uniforms.
2. `populate()` resolves at least intended mask overlays for relevant tiles/background.
3. floor visibility gating (`onFloorChange`) keeps overlays aligned to active floor context.
4. lighting pipeline receives the window-light scene for composition.

Failure consequence:

- window light contribution disappears or appears on wrong floors.

### Soft Required (major quality loss, still functional)

1. cloud shadow texture/view-bounds bindings for dynamic dimming.
2. overhead roof alpha gating for roof-covered suppression semantics.
3. sky/weather coupling and rain-on-glass modulation.
4. per-effect tuning channels (falloff/intensity/color shaping).

Failure consequence:

- lights render but feel disconnected from environment/time/weather context.

### Contextual Required

1. mask files required only where window-light intent exists.
2. roof gating required only when roof suppression behavior is enabled/expected.
3. cloud shadow input required only when cloud influence is non-zero and cloud effect active.
4. rain-on-glass chain required only when precipitation features are enabled.

Failure consequence:

- silent visual mismatch that may be hard to spot without diagnostics.

### Optional Enhancers

1. advanced rain/splash/flow map controls.
2. lightning-specific window boosts.
3. higher-order aesthetic tuning controls.

Failure consequence:

- reduced style fidelity but baseline light emission can still work.

---

## Window Light Knock-On Map (Interdependency Chain)

1. **mask discovery mismatch**
   - Primary: missing overlays where authored.
   - Knock-on: apparent "dead windows" with no explicit error.
2. **floor gating mismatch**
   - Primary: overlays visible/invisible on wrong level.
   - Knock-on: classic level-sensitive false failures.
3. **cloud shadow binding mismatch**
   - Primary: window lights ignore cloud-state dimming.
   - Knock-on: divergence from cloud/water/lighting environment coherence.
4. **overhead roof alpha mismatch**
   - Primary: roof-covered windows fail to suppress or over-suppress.
   - Knock-on: inconsistent interaction with overhead systems.
5. **isolated-scene integration failure**
   - Primary: scene exists but not consumed by lighting render path.
   - Knock-on: effect looks "configured but absent."

---

## Window Light Health Contract Draft (Phase 1 Candidate)

For each evaluated level key:

1. **Structure checks**
   - isolated scene exists
   - overlay count and mask state align with discovered assets
   - shared uniforms are initialized
2. **Behavior checks**
   - `update()` observed and key uniforms advancing
   - floor-change toggles overlay visibility correctly
   - scene is passed into lighting composition when enabled
3. **Context checks**
   - if cloud influence active, cloud shadow input should be coherent
   - if roof gating allowed, roof alpha texture presence/availability should be coherent
   - if rain features enabled and precipitation above threshold, rain branch should activate
4. **Cross-effect checks**
   - cloud input path aligns with `CloudEffectV2` outputs
   - roof alpha path aligns with `OverheadShadowsEffectV2` output semantics

---

## Intelligent Classifier Rules (Window Light Example)

1. If no window masks are expected for level `L`:
   - classify `INTENTIONAL_ABSENCE`.
2. If masks expected but none discovered:
   - classify `EXPECTED_BUT_MISSING` (`WARN`).
3. If overlays exist but not visible due to floor gating mismatch:
   - classify `LEVEL_VISIBILITY_MISMATCH` (`ERROR`).
4. If cloud/roof contextual inputs are required but absent:
   - classify `CONTEXTUAL_INPUT_MISSING` (`WARN/ERROR`).
5. If effect scene is populated but not consumed by lighting:
   - classify `PIPELINE_INTEGRATION_FAILURE` (`CRITICAL`).

---

## Window Light Case Study Acceptance Tests

1. **Intentional no-window scene**
   - no warnings for absent `_Windows`/`_Structural` assets by design.
2. **Expected mask scene**
   - overlay count and active floor visibility match authored data.
3. **Level transitions**
   - no stale visibility when moving between levels.
4. **Cloud + roof coupling**
   - modulation behaves consistently with cloud and overhead state.
5. **Pipeline integration**
   - window-light scene contributes to lighting buffer when enabled.
6. **Recovery**
   - restoring missing mask/binding clears alert state.

---

## Player Light Fifth Case Study (Global-Scope, Token/Wall/Light Hybrid)

`PlayerLightEffectV2` is the next largest/complex file and is a key robustness target because it combines:

- global-scope behavior (must not duplicate per floor),
- controlled-token state coupling and user-permission gating,
- wall collision and elevation-aware blocking logic,
- hybrid outputs (mesh visuals + quarks particles + dynamic `ThreeLightSource` docs),
- optional vision/fog mask coupling and weather-driven behavior.

## Player Light Dependency Classification

### Hard Required (core player-light operation)

1. initialize path builds required scene objects and runtime hooks.
2. active/controlled token resolution succeeds for allowed user context.
3. update loop executes without state-machine lockups.
4. dynamic light source bridge (`ThreeLightSource`) remains valid when enabled.

Failure consequence:

- flashlight/torch appears absent, detached, or non-responsive to control state.

### Soft Required (major degradation, still operational)

1. wall collision + clamped targeting for physically plausible beam limits.
2. torch/flashlight mesh material updates and cookie texture path.
3. particle subsystem (`BatchedRenderer` + quarks systems) for torch/sparks behavior.
4. vision/fog mask references for contextual shading consistency.

Failure consequence:

- light still exists but feels wrong (wall leaks, jitter, missing particles, visual mismatch).

### Contextual Required

1. token-controlled state required only when player-light mode is enabled for that token.
2. wall blocking required only when `wallBlockEnabled` is true.
3. flashlight-specific branches required only in flashlight mode.
4. torch-specific branches required only in torch mode.
5. dynamic light docs required only when corresponding light toggles are enabled.

Failure consequence:

- mode-specific silent failures that can be mistaken for normal configuration.

### Optional Enhancers

1. malfunction/wobble/noise behavior layers.
2. advanced cookie/perspective shaping controls.
3. debug overlay/readout support.

Failure consequence:

- reduced realism/feedback, but baseline light can remain functional.

---

## Player Light Knock-On Map (Interdependency Chain)

1. **controlled-token resolution failure**
   - Primary: no active light target.
   - Knock-on: appears as random intermittent "light missing" bug.
2. **wall collision/elevation filter failure**
   - Primary: beam passes through walls or clips too aggressively.
   - Knock-on: trust loss in level-aware interaction and navigation readability.
3. **dynamic light bridge failure**
   - Primary: mesh beam appears but no actual scene illumination contribution.
   - Knock-on: mismatch between visual beam and gameplay lighting.
4. **particle bridge failure**
   - Primary: torch light exists but no flame/sparks behavior.
   - Knock-on: state appears partially broken and hard to diagnose.
5. **global-scope violation**
   - Primary: light appears across wrong floors.
   - Knock-on: severe level-context confusion.

---

## Player Light Health Contract Draft (Phase 1 Candidate)

For each evaluated context (global + active level metadata):

1. **Structure checks**
   - initialized core objects (group/materials/light docs) exist per active mode
   - required textures loaded or fallbacks selected
   - dynamic light source objects valid when enabled
2. **Behavior checks**
   - controlled token state transitions tracked (acquire/release)
   - update cadence healthy (no stale token lock)
   - mode branch activation consistent with params/token flags
3. **Context checks**
   - wall blocking branch only enforced when configured
   - elevation-aware wall-hit filtering returns plausible outcomes
   - global-floor scope invariant holds
4. **Cross-effect checks**
   - lighting system receives expected player light contributions
   - particle renderer registration/de-registration remains coherent

---

## Intelligent Classifier Rules (Player Light Example)

1. If feature disabled globally or for token:
   - classify `INTENTIONAL_ABSENCE`.
2. If enabled but no controlled token eligible:
   - classify `CONTEXT_NOT_AVAILABLE` (`INFO/WARN`).
3. If eligible token exists but update chain yields no active light outputs:
   - classify `REQUIRED_OUTPUT_MISSING` (`ERROR`).
4. If beam and dynamic light diverge (one active, one absent):
   - classify `HYBRID_PIPELINE_DESYNC` (`ERROR`).
5. If floor-scope/global invariant violated:
   - classify `SCOPE_VIOLATION_CRITICAL` (`CRITICAL`).

---

## Player Light Case Study Acceptance Tests

1. **Disabled by intent**
   - no warnings when feature or token mode intentionally disabled.
2. **Flashlight mode**
   - beam, cookie, and dynamic light stay coherent while aiming/moving.
3. **Torch mode**
   - torch mesh + particles + light source stay coherent and recover after disruptions.
4. **Wall blocking**
   - wall constraints apply correctly with elevation-aware filtering.
5. **Scope invariant**
   - no cross-floor ghost light behavior.
6. **Recovery**
   - regaining valid token/context clears degraded state promptly.

---

## Breaker Box UI / Health Station Design (Proposed)

This section proposes a dedicated module health surface: a "breaker box" that makes
silent failures obvious and actionable.

## UX Goals

1. detect and surface silent failures quickly
2. provide immediate, glanceable state via bulbs/lights
3. minimize false alarms and alert fatigue
4. make diagnostic export one-click for support/debug handoff

## Entry Point in Options Header

Add a compact status bulb/icon in the options header:

- **Green steady**: all monitored systems healthy
- **Amber pulse**: degraded/warning exists
- **Red flash**: error/critical exists
- **Blue scan (optional)**: actively running checks/revalidation

Behavior:

- icon animates only for active unresolved warning/error states
- clicking the bulb opens the full Breaker Box panel
- long-press/right-click opens quick actions (copy summary, silence for session)

## Breaker Box Panel Information Architecture

1. **Top Summary Rail**
   - overall status
   - affected effects count
   - current level context
   - last transition timestamp
2. **Bulb Grid (Effect Cards)**
   - one bulb/card per major effect (`Water`, `Cloud`, `Overhead`, `Window`, etc.)
   - per-card sub-bulbs for level slices where relevant
   - state color + confidence + trend (new, stable, recovered)
3. **Dependency Tree / Knock-On View**
   - upstream failure and downstream impact chain
   - highlights likely root cause vs secondary symptoms
4. **Evidence Drawer**
   - exact failed checks, context snapshot, and key uniform/resource flags
5. **Diagnostic Actions**
   - copy concise report
   - copy full JSON bundle
   - trigger re-check now
   - open related effect settings quickly

## Node Graph View (Bulbs + Dependency Lines)

Add a dedicated graph tab in the Breaker Box:

- each effect is a bulb-node (color = health state)
- directed edges represent dependency flow (upstream -> downstream)
- edge color shows propagation status:
  - neutral gray: healthy dependency
  - amber: degraded influence
  - red: active failure propagation

Recommended node groups:

1. **Sources**: mask providers, floor/level context, weather state
2. **Core effects**: Water, Cloud, Overhead, Window, PlayerLight
3. **Consumers**: Lighting compose, downstream post-effects, diagnostic sinks

Interaction behavior:

- click node: focus effect card + evidence drawer
- click edge: show "why this dependency matters" and recent propagated incidents
- isolate mode: highlight only subgraph impacted by selected failure
- timeline scrub: view propagation over recent frames/seconds

This gives immediate visual answers to:
"What broke first?" and "What broke because of it?"

## Graph Propagation Semantics

Each edge should carry:

- dependency type (`required`, `contextual`, `optional`)
- confidence score
- last healthy timestamp
- current impact severity estimate

When a node fails:

1. mark node state (source failure)
2. propagate estimated impact to downstream edges/nodes
3. tag downstream states as `secondary` until local checks confirm direct failure

UI distinction:

- **Root failure**: solid red bulb with bold border
- **Secondary impact**: red/amber bulb with chain-link badge

This avoids misidentifying symptoms as root causes.

## Bulb State Model

Per bulb/effect:

- `healthy` (green)
- `degraded` (amber)
- `broken` (red)
- `critical` (flashing red with sticky badge)
- `unknown` (dim/off before first check)

Per-level overlay:

- compact markers show level-specific divergence (e.g., L0 green, L2 red)

This directly addresses "works on one level, broken on another."

## Alerting + Attention Strategy

1. header bulb state changes only on transitions (avoid constant noise)
2. debounce repeated equivalent failures (signature-based dedupe)
3. escalating cadence:
   - warn: subtle pulse
   - error: pulse + optional toast
   - critical: stronger flash + sticky indicator until viewed
4. "acknowledge/snooze" controls without muting data capture

## Diagnostic Copy Format (Clipboard)

Provide two export formats:

1. **Support Summary (human-readable)**
   - scene + level + timestamp
   - top 3 failing checks
   - probable root cause
   - knock-on consequences
2. **Structured JSON (machine-parseable)**
   - health records by effect/level
   - check outcomes + evidence
   - runtime context snapshot
   - module version + compatibility metadata

The summary should be copyable in one click from both header quick menu and panel.

## Suggested Initial Breaker Box Scope (MVP)

1. monitor first four high-complexity effects:
   - `WaterEffectV2`
   - `CloudEffectV2`
   - `OverheadShadowsEffectV2`
   - `WindowLightEffectV2`
   - `PlayerLightEffectV2`
2. include level-sensitive bulbs and root-cause ranking
3. include one-click support summary copy
4. include persistent in-session event log with recovery transitions

## Design Notes / Implementation Thoughts

1. health evaluator should remain headless and UI-agnostic; Breaker Box only consumes emitted state.
2. keep expensive probes opt-in from panel ("deep inspect this effect now").
3. expose a minimal API for other UIs:
   - `getHealthSnapshot()`
   - `subscribeHealthEvents()`
   - `runHealthCheck(effectId?, levelKey?)`
4. store recent health history ring-buffer for copy/export and regression detection.
5. gate flashing behavior behind accessibility and intensity settings.

---

## Targeted Architecture Decisions (Answer Pack)

This section answers the implementation questions needed to bridge design to code.

## 1) Architectural Injection & Lifecycle Orchestration

### Injection Point

Recommended: instantiate `HealthEvaluatorService` during `canvasReady` **after**
`FloorCompositor` and `EffectComposer` initialization (around steps 12-13), then
arm initial full validation after floor-mask preload completion.

Why:

- evaluator can safely inspect live V2 effects and managers
- avoids bootstrap-time race conditions where compositors/effects do not exist yet
- enables first baseline scan once `GpuSceneMaskCompositor.preloadAllFloors()` completes

### Trigger Hooks

Use a hybrid trigger model:

1. direct call from `FloorCompositor.onFloorChange(maxFloorIndex)` into evaluator
2. listener on `mapShineLevelContextChanged` as fallback/context enrichment
3. wrapped effect lifecycle hooks (`initialize/populate/update/onFloorChange`) for heartbeat and transitions

This gives deterministic triggers without relying only on global hooks.

### Throttling & Scheduling

Use decoupled scheduler lanes:

- **Lane A (Tier 1 structural):** every `1000ms` (`setInterval`) + immediate on transitions
- **Lane B (Tier 2 behavioral):** every `2000ms` + per-effect heartbeat counters
- **Lane C (Tier 3 visual semantics):** on-demand or sampled (`debug` mode only)

Implementation notes:

- run checks in budgeted batches (e.g., max N effects/tick)
- prefer `requestIdleCallback` when available; fallback to `setTimeout(0)` micro-batching
- never block render loop; evaluator must be render-loop independent

### Global API Surface

Expose read-focused API at `window.MapShine.healthEvaluator`:

- `getSnapshot(opts?)`
- `getEffectHealth(effectId, levelKey?)`
- `subscribe(listener)` / returns `unsubscribe()`
- `runHealthCheck(target?)` where target can be `effectId`, `levelKey`, or both
- `acknowledge(signature, options?)`
- `exportDiagnostics(options?)`

Keep mutation APIs minimal; evaluator owns state transitions.

---

## 2) Effect Health Contract API

### Contract Rollout Strategy

For Phase 1, use a **decoupled registry** (not required abstract methods):

- `healthContractRegistry.register('WaterEffectV2', contract)`
- staged onboarding without refactoring all ~40 effects
- optionally add `getHealthContract()` later for mature effects

### Structural Validation Without GPU Stalls

Do not read pixels. Validate RTs via metadata only:

- existence of `THREE.WebGLRenderTarget`
- `width/height` and texture presence
- expected dimensions relative to drawing buffer / internal scale
- recent write timestamps (tracked via wrapped render methods)

No `readPixels`, no forced sync.

### Behavioral Observers

Use wrapper instrumentation, not TimeManager spying:

- wrap effect `update()` to increment heartbeat counters and last-tick timestamp
- wrap `render()`/key methods to mark successful write paths
- wrapper approach stays local to effect lifecycle and avoids global ambiguity

---

## 3) Level Context & Intentional Absence Resolution

### Intent Resolution Inputs

For `INTENTIONAL_ABSENCE` vs `EXPECTED_BUT_MISSING`, evaluator should cross-reference:

1. scene/tile metadata (`TileManager`, tile docs, floor assignments, effect flags)
2. mask availability/composite state (`GpuSceneMaskCompositor` floor outputs, `MaskManager` lookup)
3. effect-local discovered data (e.g., `populate()` results such as discovered masks/overlays)
4. config state (scene flags + effect params + weather toggles)

### Preload-All vs Active-Only Validation

Recommended hybrid:

- after `preloadAllFloors()`: run Tier 1 structural sweep for all floors (cheap)
- Tier 2 behavioral checks: active floor + recently visited floors
- force full-floor check on-demand from Breaker Box

### Weather & Contextual Alert Muting

Evaluator should read:

- `weatherController` current state (`cloudCover`, weather enabled, precipitation)
- effect enable toggles and scene/module flags

Contextual dependencies should be skipped or downgraded when governing feature is off.

### Outdoors Mask Behavioral Checks

Use CPU-friendly sampling strategy:

- small stratified sample points in effect-relevant bounds
- sample cached CPU mask data where available (no GPU readbacks)
- compare expected indoor/outdoor routing with effect state transitions

---

## 4) Dependency Graph & Knock-On Consequences

### Graph Representation

Use a hybrid DAG model:

1. static edges declared in contracts (authoritative dependency intent)
2. optional runtime edge enrichment from observed binding events in `FloorCompositor`

This balances robustness and adaptability.

### Severity Propagation Logic

Propagation algorithm:

1. identify failing node(s) as candidate roots
2. traverse outgoing edges (BFS/topological order)
3. mark downstream as `secondary` with severity cap based on edge type:
   - required edge: can escalate to `degraded/broken`
   - contextual edge: only when context active
   - optional edge: max `degraded`
4. stop propagation when local checks prove downstream healthy

UI must distinguish root vs secondary failures.

### Shared Resource Provenance

Maintain provenance map:

- `resourceId -> producedBy -> consumedBy[]`
- derived mask lineage (`_Water` base -> blurred/boosted/derived outputs)

If base resource invalid, emit one root failure and annotate dependent outputs as secondary.

---

## 5) Breaker Box UI & Event Streaming

### UI Framework Choice

Recommended:

- Breaker Box main panel as **Foundry `ApplicationV2`** dialog (dockable, permissions, familiar UX)
- header bulb as lightweight injected DOM control in options header via UI manager wiring

This gives stable lifecycle + easy access from existing UI.

### Anti-Noise Dedup Strategy

Normalize by signature:

- key: `effectId + levelKey + ruleId + normalizedCause`
- track `firstSeen`, `lastSeen`, `occurrenceCount`, `suppressedCount`
- emit state changes only on transition or debounce expiry (e.g., 1-2s window)

60fps repeats become one stable state record with updated counters.

### Diagnostic Export JSON Schema (Proposed)

```json
{
  "meta": {
    "moduleVersion": "string",
    "foundryVersion": "string",
    "sceneId": "string",
    "sceneName": "string",
    "timestamp": "ISO-8601"
  },
  "runtime": {
    "activeFloor": "number",
    "visibleFloors": ["number"],
    "levelContextKey": "string",
    "camera": {
      "zoom": "number",
      "position": {"x": "number", "y": "number", "z": "number"}
    },
    "frameState": {
      "elapsed": "number",
      "delta": "number",
      "fps": "number",
      "paused": "boolean"
    }
  },
  "health": {
    "overallStatus": "healthy|degraded|broken|critical|unknown",
    "effects": [
      {
        "effectId": "string",
        "status": "string",
        "rootCause": "boolean",
        "byLevel": [
          {
            "levelKey": "string",
            "status": "string",
            "checks": [
              {
                "ruleId": "string",
                "tier": "structural|behavioral|visual",
                "result": "pass|fail|skipped",
                "severity": "info|warn|error|critical",
                "message": "string",
                "evidence": {"k": "v"}
              }
            ]
          }
        ],
        "dependencies": [
          {
            "targetEffectId": "string",
            "type": "required|contextual|optional",
            "propagatedImpact": "none|degraded|broken"
          }
        ]
      }
    ]
  }
}
```

### Level Divergence UI Data Model

Represent as:

- `health.effects[i].byLevel[levelKey].status`

This makes compact indicators trivial: e.g., `L0=healthy`, `L2=broken`.

---

## 6) Phase 1 MVP Implementation Plan

### File/Folder Scaffolding

Recommended paths:

- `scripts/core/diagnostics/HealthEvaluatorService.js`
- `scripts/core/diagnostics/HealthContractRegistry.js`
- `scripts/core/diagnostics/HealthDependencyGraph.js`
- `scripts/core/diagnostics/HealthTypes.jsdoc`
- `scripts/ui/breaker-box-dialog.js`
- `scripts/ui/breaker-box-header-indicator.js`

### Class Skeletons (MVP)

1. `HealthEvaluatorService`
   - owns records, scheduling lanes, event stream, exports
2. `HealthContractRegistry`
   - contract registration and lookup
3. `BreakerBoxDialog` (ApplicationV2)
   - summary rail, bulb grid, graph tab, export actions

### WaterEffectV2 Phase 1 Contract (Example)

Contract should include:

- structural:
  - `_initialized === true`
  - `_composeMaterial` exists
  - `_floorWater` map exists and has active-floor entry or intentional absence verdict
- behavioral:
  - `update()` heartbeat within threshold window
  - `onFloorChange` updates active bindings
- contextual:
  - if water expected on level and no floor data -> fail
  - if water not expected on level -> intentional absence

### Safety Wrapper / Fault Tolerance

Evaluator must never take down rendering:

- every contract eval wrapped with existing safe-call pattern (`core/safe-call.js`)
- on evaluator failure:
  - emit internal evaluator error record
  - continue evaluating other effects
  - never throw into `FloorCompositor.render()`

Failure policy:

- "degrade diagnostics, never degrade rendering."

---

## Risks and Mitigations

1. **False positives**
   - Mitigation: severity tuning, confidence score, and staged rollout.
2. **Performance overhead**
   - Mitigation: cheap checks always on; heavy checks sampled/on-demand.
3. **Alert fatigue**
   - Mitigation: deduplication, throttling, GM verbosity settings.
4. **Context drift across systems**
   - Mitigation: single level context adapter as source of truth.
5. **Contract drift as effects evolve**
   - Mitigation: checklist enforcement in effect development workflow.

---

## Recommended Initial Coverage (Priority)

1. `WaterEffectV2` (cross-pass dependencies + floor-bound data switching)
2. `CloudEffectV2` (multi-pass shadow/top pipeline + downstream consumers)
3. `OverheadShadowsEffectV2` (blocker semantics and hover transitions)
4. `WindowLightEffectV2` (floor and mask-dependent overlays)
5. `PlayerLightEffectV2` (global token/wall/light hybrid with scope constraints)
6. `FireEffectV2` (particle system floor activation)

---

## Suggested Acceptance Criteria

System is successful when:

1. It detects and reports at least one intentionally induced per-level failure.
2. Alerts clearly identify effect + level + reason.
3. Recovery is detected and reported without manual refresh.
4. Overhead impact remains low in normal play (no noticeable frame regression).
5. Diagnostic center shows actionable evidence for troubleshooting.

---

## Recommendation

Proceed with **Phase 1 MVP** now.

This provides immediate practical value with acceptable implementation risk and creates a stable
foundation for optional deep semantic probes later.

