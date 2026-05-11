# Success Story: Trees and Bushes Floor Leakage

## Problem We Saw

- `_Tree` / `_Bush` visuals appeared on floors where they did not belong (most visibly: underground).
- On floor changes, canopies sometimes appeared briefly for a few frames and then disappeared.
- During some transitions, this happened twice before stabilizing.

## What Was Wrong At The Start

This issue was not a single bug. It was a stack of smaller floor-context bugs that combined into one symptom:

1. **Wrong floor assignment path in V14 scenes**  
   Tree/Bush floor resolution initially relied on legacy range/elevation checks before V14-native level assignment, causing incorrect floor mapping in mixed/migrated content.

2. **Background mask handling was floor-agnostic**  
   Background `_Tree`/`_Bush` overlays were initially treated too globally (hardcoded floor assumptions and non-authoritative background source usage), so a valid canopy mask could leak into the wrong floor context.

3. **Scene/floor repopulate sequencing caused transient stale renders**  
   During level-context changes, effect repopulation could happen in overlapping phases. Old overlays could remain visible briefly while async populate jobs progressed.

4. **Background canopy overlays were being rebuilt even for non-active floors**  
   This allowed short-lived wrong-floor overlays during transition windows, even when they were eventually hidden.

## What Fixed It Ultimately

### 1) Correct floor identity for tile overlays

- Added/standardized V14-native floor resolution support (`resolveV14NativeDocFloorIndexMin`) in Tree/Bush effects.
- Ensured floor metadata is attached to overlay meshes (`userData.floorIndex`).

### 2) Correct background canopy sourcing and floor mapping

- Switched from simple `scene.background.src` assumptions to level-aware background handling.
- Mapped level backgrounds against FloorStack floor indices.
- Most importantly: **during populate, only build background canopy overlays for the currently active floor**.

### 3) Remove transition-time stale overlay windows

- Cleared Tree/Bush overlays at `forceRepopulate` start so old canopies cannot linger while async jobs run.
- Added repopulate coalescing in `FloorCompositor.forceRepopulate()` to avoid duplicate rebuild waves during the same transition burst.

### 4) Harden visibility enforcement

- Added explicit floor-clamp visibility enforcement in Tree/Bush lifecycle points (`update`, `onFloorChange`, creation, enabled-state changes), using safe floor index fallback logic.

## Key Diagnostic Insight

The most useful clue was:

- `TreeEffectV2 populated: 1 overlays` while `tileDocCount: 0`.

That proved the leakage source was **background canopy overlay construction**, not tile canopy masks.

## Final Outcome

- Trees/Bushes no longer persist on wrong floors.
- Underground transitions no longer show transient canopy leaks.
- Floor changes now stabilize with correct per-floor canopy behavior.

## Success Story: Specular Not Working Across Floor Changes

### Problem We Saw

- Specular could look great on the first floor loaded, but disappear when switching floors.
- In some runs, specular was completely non-functional even with high intensity settings.
- Diagnostics looked structurally healthy, but visuals did not match expected output.

### What Was Wrong At The Start

This was also a layered failure, not one bug:

1. **Shared uniforms were not returned during deferred shader upgrade**  
   Deferred compile logic expected `_buildSharedUniforms()` to return uniforms. It only assigned `this._sharedUniforms`, causing upgrade path failures.

2. **Background specular overlay was floor-pinned incorrectly**  
   The background `_Specular` overlay was initially treated as floor 0, which mismatched active floor context in multi-floor scenes and caused wrong `_Outdoors` slot sampling.

3. **Specular effect was not floor-change aware in lifecycle wiring**  
   `SpecularEffectV2` was not notified on floor changes, so background overlay floor binding could drift from active floor state.

4. **Repopulate lifecycle reused placeholder overlays without re-upgrade**  
   After first successful compile, floor-triggered repopulates created black placeholder overlays, but skipped deferred upgrade because compile state was already marked done.

5. **Deferred compile monitoring produced misleading timeout/hung signals**  
   Compile monitor timeout behavior around deferred material setup created false “fallback/hung” signals, obscuring root cause analysis.

### What Fixed It Ultimately

### 1) Fix deferred shader plumbing correctness

- Made `_buildSharedUniforms()` return the uniform object.
- Added guardrails around deferred compile state transitions so failures cannot silently leave effect in dead-placeholder mode.

### 2) Make background specular truly floor-aware

- Assigned background overlay to active floor in multi-floor scenes (not hardcoded floor 0).
- Updated background overlay Z band and `uOutdoorsFloorIdx` to match active floor context.

### 3) Wire floor-change lifecycle explicitly

- Added `SpecularEffectV2.onFloorChange(...)` and invoked it from `FloorCompositor` floor-change flow (including fallback flow).
- Rebound background overlay registration in `FloorRenderBus` on floor changes so visibility rules stay aligned.

### 4) Make repopulate safe after first shader compile

- Stored a compiled shader template material once compile succeeds.
- On later repopulates, created new overlays directly from compiled shader template instead of black placeholders.
- Kept placeholder path only for true pre-compile startup.

### 5) Stabilize methodology for shader effects

- Treat “healthy structure, broken visuals” as a lifecycle/state bug until proven otherwise.
- Verify creation-time floor assignment, floor-change rebinding, and repopulate behavior separately.
- Distinguish compile-monitor telemetry from actual material state on overlays.
- Add effect-level diagnostics for material type and uniform presence to catch silent fallback paths quickly.

### Key Diagnostic Insights

- Overlay count alone was insufficient; floor histogram and per-overlay material state were required.
- The decisive signal was “works on initial floor only” — that pointed to repopulate + floor-change lifecycle drift, not mask authoring.

### Final Outcome

- Specular now survives floor changes instead of being limited to initial load context.
- Background `_Specular` follows active floor and samples the correct per-floor `_Outdoors` texture slot.
- Repopulate no longer leaves overlays in persistent black placeholder state.

## Success Story: Map Shine Control Clock Triggered Scene Reload

### Account

- Codex 5.3 (Cursor agent)

### Problem We Saw

- Changing time of day from the `Map Shine Control` clock caused the full loading screen to appear and the currently viewed scene to reload.
- This made time scrubbing disruptive and looked like a hard refresh instead of a local lighting/time update.

### What Was Wrong At The Start

- Clock actions (drag release and quick-time buttons) always queued `debouncedSave()`.
- That save path still wrote Scene flags via `scene.setFlag('map-shine-advanced', 'controlState', ...)`.
- In Foundry V12/V14 behavior, those same-scene document writes can trigger redraw/teardown paths that surface as full loading/reload transitions.

### What Fixed It

- Added a dedicated time-only save path for clock/quick-time actions that skips Scene `controlState` flag persistence.
- Kept one debounced darkness sync (`stateApplier.syncFoundryDarknessFromMapShineTime()`) so visual darkness still updates after time changes.
- Left existing weather-slider skip-persist behavior intact (including weather snapshot scheduling), so only time-driven saves changed.

### Final Outcome

- Time changes from `Map Shine Control` no longer trigger loading-screen scene reload behavior.
- Clock interactions remain responsive while still updating darkness correctly.

### Addendum: Clouds Slider Follow-Up

- A second trigger remained: changing `Clouds` could still surface the same reload behavior.
- Root cause was the skipped-persist branch still calling weather snapshot scheduling, which could write Scene flags and re-enter same-scene redraw/reload paths.
- Final fix: for skipped-persist saves, avoid all Scene document writes; keep only explicit time-only darkness sync where needed.
- Result: both clock changes and clouds slider changes now apply live without loading-screen scene reload transitions.

## Success Story: Dry Scene Loaded as Permanently Wet

### Account

- Codex 5.3 (Cursor agent)

### Problem We Saw

- Entering a scene with rain set to `0` still rendered wet-looking specular across the scene.
- Wet sheen persisted immediately on load, even though no rain was active in that scene.

### What Was Wrong At The Start

- The first attempted fix switched specular wet driving from `weather.wetness` to live rain intensity.
- That was incorrect for product intent, because wetness lag is desired during active weather transitions.
- The real issue was load/restore lifecycle behavior: serialized weather state could restore stale `wetness` into a scene that was otherwise dry at load time.

### What Fixed It

- Restored `SpecularEffectV2` to use `weather.wetness`, preserving intended lag behavior.
- Added restore-time normalization in `WeatherController`:
  - After applying serialized state, if there is no active rain in both current/target state and no transition in progress, clamp wetness to dry.
  - Applied to `currentState`, `startState`, and `targetState` to keep internal transition state coherent.

### Final Outcome

- Scenes that load with rain `0` now start visually dry.
- Wetness lag still works as designed during actual rain and dry-down transitions.

## Success Story: Roof Background Failed to Occlude Lower-Floor Fire

### Account

- Codex 5.3 (Cursor agent)

### Problem We Saw

- On an upper roof level, fire particles authored on the floor below appeared on top of roof background art that should occlude them.
- A first attempted fix over-corrected and hid lower-floor fire entirely when viewing above floors.

### What Was Wrong At The Start

This issue was a layered ordering/slice interaction, not just one render-order value:

1. **Fire had stacked per-level visibility by design**  
   In per-level prepass, `ms_fire_batch_*` could be injected into every higher slice (`fi <= L`) so lower-floor fire remained visible from above.

2. **Background planes were not floor-band ordered**  
   `__bg_image__*` planes had no explicit floor-aware `renderOrder`, so they could fail to sort above lower-floor fire overlays in the relevant slices.

3. **Blunt disable of stacked fire visibility was incorrect**  
   Removing stacked-fire prepass inclusion made occlusion look “fixed” only by fully suppressing below-floor fire in upper views, which is not intended behavior.

### What Fixed It

1. **Keep intended stacked fire visibility (do not suppress lower-floor fire globally)**

- Kept `topVisibleFloorIndexForFire` in per-level bus rendering so lower-floor fire still appears from upper views where intended.

2. **Make roof backgrounds truly occluding**

- Assigned floor-aware `renderOrder` to bus background planes (`__bg_image__*`) using `tileAlbedoOrder(bgFloorIndex, 0)`.
- Pinned solid background fill behind floor content with a stable low albedo-band order.

3. **The decisive fix: constrain alpha widening in LevelAlphaRebindPass**

- Root cause of the "middle floor turns lower floor black" regression was alpha widening being accepted too broadly in `LevelAlphaRebindPass`.
- Fire/effect passes on the middle level could trigger widened alpha preservation, making that slice too opaque and hiding the ground floor in source-over composite.
- Final fix:
  - Added an explicit `uAllowAlphaWiden` gate in `LevelAlphaRebindPass`.
  - Enabled that gate only when the level water pass actually wrote output (`_waterPassWrote === true`) from `FloorCompositor`.
  - All non-water passes (including fire) now remain clamped to authored alpha, preserving holes/reveal to lower floors.

### Final Outcome

- Lower-floor fire is visible from upper floors where it should be.
- Roof/background art now correctly occludes that fire where authored alpha is opaque.
- Middle (fire) floor no longer blacks out the floor below.
- Multi-floor rendering now behaves correctly on all tested floors (roof, fire floor, ground).

## Success Story: Iridescence Mask Looked Inverted (Shine on Padding, Not on Props)

### Problem We Saw

- Iridescence appeared strongest in **transparent padding / bounding-box corners** and on **opaque black unused UV**, while the actual mesh surfaces (brighter mask regions) showed little or no shimmer.
- Visually this read as **inverted masking**: effect where the mask was black, none where it was brighter than black.

### What Was Wrong At The Start

- The fragment shader had a special path for **“alpha-only”** masks: when RGB was near zero, it treated **`rawMask` as opacity alone** (`rawMask ≈ a`).
- Typical `_Iridescence` authoring uses **opaque black** in empty padding and **colored/lighter** values on props.
- That branch gave **full strength** on opaque black padding and **`luminance × α`** on colored pixels — exactly the inverted look users reported.

### What Fixed It

- Removed the alpha-only branch so **one rule applies everywhere**: **`rawMask = luminance(rgb) × alpha`**, with optional **Invert mask** flipping luminance before the multiply (not after), so transparent texels still discard correctly.
- Users who paint **light = shine** get shimmer on props; black RGB regions no longer steal the effect via opacity alone.

### Final Outcome

- Iridescence aligns with mask intent: **bright mask regions shimmer**, **dark regions do not**, and **fully transparent** areas stay empty.
- Confirmed in-session on vault-style props after the change.

## Success Story: Rain Not Masked by Tree Canopy (Overhead Shadows Off)

### Account

- Composer (Cursor agent)

### Problem We Saw

- Roofs and overhead tiles correctly masked precipitation (rain disappeared when the roof faded for hover-reveal).
- **`_Tree` canopies did not**: rain stayed visible in the tree silhouette when the canopy faded out.
- With **Overhead shadow projection disabled** (`OverheadShadowsEffectV2.params.enabled === false`), behavior stayed broken even after earlier rain-occlusion work.

### What Was Wrong At The Start

Several issues stacked; the last one only showed up when shadows were off:

1. **Rain occlusion render targets could stay uninitialized**  
   `OverheadShadowsEffectV2.render()` only called `onResize()` when older RTs were missing or mismatched. New `rainOcclusionVisibilityTarget` / `rainOcclusionBlockTarget` were not in that guard, so `_renderRainOcclusionTargets` could no-op forever and weather fell back without a reliable dedicated mask.

2. **Tree meshes were not on the weather roof layer**  
   Capture cameras use **ROOF_LAYER (20) + WEATHER_ROOF_LAYER (21)**. Canopy meshes from `TreeEffectV2` lived on layer **0** only unless temporarily patched. They needed **21** in addition to **0** so the main bus pass (camera enables 0–19) still drew them.

3. **Disabled overhead path: live fade was wiped before rain occlusion**  
   For the roof-**block** RT, the code forced tree uniforms (e.g. **`uHoverFade = 1`**) so `rb` stayed a full silhouette. It then called **`_renderRainOcclusionTargets` before restoring** those overrides. The **visibility** sub-pass therefore always saw the tree fully opaque (`rv ≈ 1`), so **`hiddenBlock = rb × (1 − rv)`** stayed ~0 and rain never hid on fade.  
   The **enabled** shadow path accidentally did the right thing: **`treeBlockerUniformOverrides` were restored in a `finally` before** `_renderRainOcclusionTargets`.

4. **Diagnostics were misleading**  
   `roofTargetTreeParticipants` / `roofBlockTreeParticipants` were only incremented on the full enabled capture path, so probes showed **`0`** during `overhead-disabled-roofBlock` even when **`treeSeen: 1`**.

### What Fixed It

1. **Resize / init guard** includes rain occlusion RTs and size checks so targets always exist when other roof RTs do.

2. **`TreeEffectV2`** enables **layer 21** on canopy meshes after creation (keeps layer **0** for normal bus rendering).

3. **Disabled overhead branch** restores roof-block / tree **uniform and opacity overrides immediately after** `roofBlockTarget` render and **before** `_renderRainOcclusionTargets`, matching the enabled path’s ordering. Rain occlusion’s internal **block** pass still forces full opacity where needed.

4. **Probe improvements**: optional `globalThis.__MSA_DEBUG_TREE_RAIN_MASK__`, heartbeat / early-out logs, payload field `disabledPathRestoredBeforeRainOcclusion`, and counting trees in the disabled blocker prep traverse.

### Key Diagnostic Insight

- Heartbeat showed **`paramsEnabled: false`** and **`path: 'overhead-disabled-roofBlock'`** while **`treeSeen: 1`** but **`roofBlockTreeParticipants: 0`** — that split pointed to **ordering and probe coverage**, not “no tree in the scene.”

### Final Outcome

- Rain masking follows **tree hover-fade** the same way as roofs, including when **overhead shadow projection is disabled**.
- Dedicated rain occlusion RTs reliably initialize; debug flags can confirm capture path and tree participation.

## Success Story: Foundry “Restrict Light” Roofs — Leaks, Then Over-Blocking on Fade

### Account

- Composer (Cursor agent)

### Problem We Saw

- Overhead tiles with Foundry **Restrict light** still let **same-floor** dynamic lights “leak” through the roof in the V2 lighting composite (torch wash where the roof should block).
- After an initial fix, behavior improved when the roof was opaque, but **hover/fade reveal** still went wrong: lights stayed suppressed even when the roof had faded away, so exploration under roofs felt incorrectly dark.

### What Was Wrong At The Start

Several pipeline gaps stacked:

1. **LOS / vision alone did not match the screen-space lighting composite**  
   Restrict-light behavior needed a **screen-space stamp** aligned with overhead capture, plus compositor wiring so relief and visibility gates respected that mask (including when `uApplyRoofOcclusionToSources` is low).

2. **Overhead shadow projection off → restrict RT never updated**  
   With `OverheadShadowsEffectV2.params.enabled === false`, the early return path filled `roofBlockTarget` but **skipped** the restrict-light render target. Lighting always saw an empty stamp, so either leaks returned or fixes appeared to “do nothing” in that configuration.

3. **Restrict capture reused full-opacity caster setup**  
   Pass **1** correctly forces **opacity 1** on roof casters so shadow masks stay stable while hovering. Pass **1c** (restrict-light only) ran in that same forced-opaque state and used **post-force** visibility (`visible === true`) for filtering. The restrict mask stayed **fully strong** while the roof **visually faded**, so lighting stayed blocked when it should have returned. The **disabled** overhead path had the same ordering issue: restrict ran **before** restoring roof-block opacity / tree uniforms.

### What Fixed It

1. **End-to-end restrict-light plumbing** (earlier in the same effort): LOS segments for light sense, `tileDocRestrictsLight` / `userData.restrictsLight`, dedicated `roofRestrictLightTarget`, `LightingEffectV2` sampling and gating, optional light elevation for native Levels, FloorRenderBus sync from documents.

2. **Disabled overhead path** renders the restrict-only pass after `roofBlockTarget` so the RT stays valid when projection is off.

3. **Fade-correct restrict capture**  
   - **Enabled path:** after Pass **1**, restore saved **material opacity** and `uOpacity` / `uTileOpacity`, then run Pass **1c**. Use **pre–Pass-1** visibility from `roofSpriteVisibilityOverrides` so hidden tiles do not stamp.  
   - **Disabled path:** run the restrict pass **after** restoring roof-block opacity and tree uniforms so the capture matches **live** fade.

### Key Diagnostic Insight

- “**No visual change**” with projection off pointed to **early return** skipping the restrict RT, not shader math.
- “**Leak fixed but fade still wrong**” pointed to **capture state** (forced opaque + forced visible), not Foundry flags.

### Final Outcome

- Same-floor lights no longer wash through **opaque** restrict-light roofs.
- When the roof **fades or hides** (hover-reveal / opacity), the restrict stamp **weakens with it**, and dynamic light **returns** as expected.
- Behavior is consistent whether overhead **shadow projection** is on or off.

## Success Story: V2 Bus — Foundry-Style Radial Overhead Occlusion (Replica Mask)

### Account

- Composer (Cursor agent)

### Problem We Saw

- On the V2 floor compositor **bus**, overhead token occlusion (the circular “cutout” / radial hole Foundry uses for occludable tokens) did not line up with the 3D scene, felt **wrong under parallax**, or looked **binary** no matter how soft the control tried to be.
- **Map Shine Control** sliders for hole **radius** and **soft edge** could show **NaN** or refuse to drag.
- Chrome logged hundreds of **`GL_INVALID_OPERATION: glDrawElements: Feedback loop formed between Framebuffer and active Texture`** per frame while the feature was active.

### What We Wanted (Product / Parity)

- **Same semantics as Foundry’s overhead occlusion** for occludable tokens: radial falloff encoded in the mask, consumed by existing bus “Foundry occlusion” uniforms (`uMsBusFoundryOccl`, `uMsFoundryOccTex`, elevation / alpha weights), without PIXI `extract.canvas` readback every frame.
- **GM-tunable** radius and soft rim, persisted where other Map Shine controls live (`controlState` + sanitize), with sane defaults (radius default **35** on the scale used in-panel; **40 / 40** radius+soft reported as a sweet spot in playtests).

### What Was Wrong At The Start

Several independent issues stacked:

1. **Wrong coordinate space for the hole**  
   Token positions were derived from **2D stage / client canvas** style mapping while the bus samples the mask with **`gl_FragCoord`** in the **same resolution and projection as the Three.js scene render target**. That mismatch read as a sliding / parallax offset between the token sprite and the hole.

2. **Bus shader threw away smooth mask green**  
   The replica pass intentionally writes a **smooth green** channel (`smoothstep` rim). The bus path still treated radial occlusion like a hard mask (e.g. heavy **`step`**-style use on the channel that should stay graded), so the **soft edge** never showed on screen.

3. **Control UI bound badly through Tweakpane**  
   Range widgets for the new tunables did not stay numeric end-to-end, so the panel could produce **NaN** or unusable sliders.

4. **WebGL feedback loop**  
   The mask lived in a **render target** sampled while drawing **another** render target (scene RT). On many drivers that is reported as a **feedback loop** (same logical texture lifecycle as FBO + sampler), and **each bus tile draw** could emit another console warning — hence **250+** lines per frame.

### What Fixed It

1. **Option B: Map Shine–owned replica mask pass** (`ReplicaOcclusionMaskPass`)  
   One fullscreen fragment pass per frame: up to **8** occludable tokens, **radial distance** in **mask pixel space** matching bus `gl_FragCoord` layout (`canvasY = uResolution.y - frag.y`), **G** channel = occlusion weight, **B** = map elevation hint for the existing bus decode path. Tunables **`uRadiusScale`** and **`uEdgeSoftness`** with a widened feather curve so “100” soft is meaningfully softer than legacy.

2. **Align tokens with the same camera as the bus**  
   Collect token centers from Foundry’s occludable set, but map world position using the **FloorCompositor Three camera** and the **token sprite world position** (via `worldToReplicaMaskPx`), not stage-only coordinates. **`pass.update(renderer, floorCompositor.camera)`** so mask and bus share one projection.

3. **Bus: preserve smooth green into the radial blend**  
   After elevation masking, drive the radial factor from the **replica green** in a **continuous** way (ratio from `(1 − mask.g)` against the elevation band) instead of re-thresholding it to a hard step, so the **soft rim** from the mask survives into the final mix.

4. **Map Shine Control: DOM sliders**  
   Implemented **plain `<input type="range">`** (same pattern as other reliable controls such as live weather), plus **`control-state-sanitize`** clamps/defaults, and a **`_syncReplicaOcclDomFromControlState()`** path after sanitize so UI and state stay finite.

5. **Resolve RT to kill the feedback loop**  
   Render the mask into an internal **`_rt`**, then a second **fullscreen copy** into **`_rtResolved`**. **`getTexture()`** returns **`_rtResolved.texture`** for `uMsFoundryOccTex`. The bus only ever samples a texture that is **not** the color attachment of the framebuffer it is drawing into. **`try` / `finally`** restores the renderer’s previous render target around the pass.

6. **Diagnostics**  
   `probeReplicaOcclusionV2` (and readbacks) target the **resolved** RT so probes match what shaders sample.

### Key Diagnostic Insights

- **Parallax / offset** with an otherwise “correct”-looking circle → almost always **camera / RT space vs canvas space**, not radius math.
- **Soft control does nothing** while the mask texture looks smooth in isolation → **downstream shader** was collapsing gradients, not the mask pass.
- **Hundreds of identical WebGL warnings** → **per-draw** issue; trace **sampler2D bound to an RT** used during **scene RT** draws, then **decouple** with a copy/resolve texture.

### Final Outcome

- Radial overhead occlusion on the V2 bus **tracks tokens in world space** consistently with the scene camera.
- **Soft rim** and **radius** are both visible and tunable; validated feel around **40 / 40** on the panel scale alongside defaults in sanitize.
- **Console spam from feedback loops** is addressed by the **mask resolve** path; bus materials keep using the same uniform names Foundry parity code already expected.

