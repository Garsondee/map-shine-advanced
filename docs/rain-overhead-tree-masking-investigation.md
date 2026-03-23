# Rain Overhead/Tree Masking Investigation Log

## Goal

When overhead layers and tree layers fade on hover:

- Normal rain particles should be masked out under those blockers.
- Rain splashes should also be masked out.
- Roof/tree drips should **not** use that masking path.
- Existing `_Outdoors` indoor/outdoor masking should remain intact.

## Baseline Observation

- `_Outdoors` mask already works for indoor/outdoor gating of rain.
- Problem is specific to hover-faded blockers (overhead + trees) not suppressing rain/splashes correctly.

## Changes Attempted

### 1) Added rain-only hard-block uniform path in `WeatherParticles`

Files:

- `scripts/particles/WeatherParticles.js`

What was changed:

- Added `uRoofRainHardBlockEnabled` to precipitation shader uniform packs.
- Attempted to use forced roof blocker map when hover reveal was active.
- Kept roof drips excluded (`uRoofRainHardBlockEnabled = 0` for drip materials).

Result:

- Did not solve masking behavior.

Issue discovered later:

- Initial texture wiring mistakenly reused blocker texture in both visibility and blocker roles in one iteration, which made the transition equation ineffective.

---

### 2) Extended same logic to splash systems

Files:

- `scripts/particles/WeatherParticles.js`

What was changed:

- Applied rain hard-block texture/uniform selection to:
  - splash source material
  - splash batch materials
  - water-hit splash batch materials
- Added dirty-check tracking for the new hard-block state.

Result:

- Not sufficient; masking still failed in practice.

---

### 3) Added separate visibility + blocker maps in shader

Files:

- `scripts/particles/WeatherParticles.js`

What was changed:

- Added new uniforms:
  - `uRoofBlockMap`
  - `uHasRoofBlockMap`
- Fragment logic used:
  - `hiddenBlock = roofBlockAlpha * (1.0 - roofAlpha)`
  - soft transition via `smoothstep`
  - multiplied into `msWaterFade` with discard when near zero

Result:

- Still not fixing the observed behavior end-to-end.

---

### 4) Attempted to include tree overlays in roof blocker capture

Files:

- `scripts/compositor-v2/effects/TreeEffectV2.js`
- `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`

What was changed:

- Tree overlay meshes were temporarily put on roof/weather layers (20/21).
- During overhead capture, `uHoverFade` was temporarily forced to `1.0` so faded canopies still contributed full blocker silhouette.

Result:

- Introduced a visible regression: large dark offset shape under/near trees.
- This was reported by user.

Status:

- Reverted these changes.

---

### 5) Fixed rain alpha/blocker source separation

Files:

- `scripts/particles/WeatherParticles.js`

What was changed:

- Corrected texture assignment:
  - `uRoofAlphaMap` uses runtime visibility texture
  - `uRoofBlockMap` uses forced-opaque blocker texture
- Ensured hard-block path only activates when both maps are present.

Result:

- Still did not fully resolve masking.

---

### 6) Investigated shader patch persistence / migration path

Files:

- `scripts/particles/WeatherParticles.js`

What was changed:

- Extended `_migrateRoofEdgeDripShader` to also backfill blocker uniforms and blocker logic for already-patched legacy shader strings.
- Tightened `needsInject` conditions so shaders are re-injected if blocker pieces are missing, not only when the old marker is absent.
- Changed roof alpha source priority to prefer live `OverheadShadowsEffectV2` textures before mask-manager fallback.

Result:

- No linter errors.
- User still reports masking not fixed.

## Reverted / Removed

To remove regressions:

- Removed tree mesh forced layer participation change in `TreeEffectV2`.
- Removed temporary forced `uHoverFade=1.0` override in `OverheadShadowsEffectV2`.

These removals eliminated the dark offset artifact.

## Current Problem State

Current user-visible state:

- Dark tree artifact is gone.
- Rain and splashes are still not properly masked under overhead/tree blockers during hover fade.
- `_Outdoors` masking still works for indoor/outdoor.

Interpretation:

- The world-space `_Outdoors` path is healthy.
- The screen-space blocker/visibility path is still not producing effective suppression at runtime for precipitation.

## Most Likely Remaining Gaps

1. **Source texture content mismatch at runtime**
   - `roofAlphaTexture` / `roofBlockTexture` may not contain expected blocker data at the precipitation draw stage.

2. **Material/shader variant mismatch in batched draws**
   - Some active rain/splash batch materials may still be using a fragment variant where blocker logic is not applied exactly as expected.

3. **Coordinate-space mismatch**
   - `gl_FragCoord / uScreenSize` sampling may not align with the capture target dimensions in some camera/viewport configurations.

4. **Tree blockers are not authored into the roof blocker source**
   - Since tree-layer forcing was reverted to remove artifacts, tree contribution to blocker maps may now be missing again.
   - A cleaner tree blocker source (separate from shadow-caster behavior) may be required.

## Recommended Next Debug Step

Implement temporary diagnostics (non-destructive, debug toggle gated):

- Runtime logs for rain/splash uniforms:
  - `uHasRoofAlphaMap`, `uHasRoofBlockMap`, `uRoofRainHardBlockEnabled`
  - bound texture UUIDs for alpha/block maps
- Probe sample values at cursor/world test point:
  - sampled `roofAlpha`
  - sampled `roofBlockAlpha`
  - computed `hiddenBlock`

This will isolate whether failure is:

- missing/incorrect blocker textures,
- wrong sampling alignment,
- or shader path not active on the actual rendered batch.

## Full Investigation Findings (Code-Verified)

### Confirmed Working Pieces

1. **Rain/splash shader plumbing exists and is wired**
   - `WeatherParticles` now declares and assigns:
     - `uRoofAlphaMap`
     - `uRoofBlockMap`
     - `uHasRoofAlphaMap`
     - `uHasRoofBlockMap`
     - `uRoofRainHardBlockEnabled`
   - Runtime assignment paths cover both precipitation and splash material sets.

2. **Hard-block logic is present in fragment path**
   - Current equation is:
     - `hiddenBlock = rb * (1.0 - rv)`
     - smoothed and multiplied into `msWaterFade`
   - This is exactly the intended "block where silhouette exists but visibility faded" behavior.

3. **Roof drips are correctly excluded**
   - Drip materials force:
     - `uRoofRainHardBlockEnabled = 0`
     - `uHasRoofBlockMap = 0`
   - This matches requirement that roof/tree drips should not use rain hard-block masking.

4. **`_Outdoors` path is still intact**
   - No evidence of `_Outdoors` gating being removed/broken in the weather path.
   - Existing indoor/outdoor suppression remains independent of hard-block logic.

### Confirmed Constraints / Failure Points

1. **Hard-block activation is gated by `weatherController.roofMaskActive`**
   - In `WeatherParticles`, `rainHardBlockActive` only turns on when:
     - `roofMaskActive` is true
     - `roofBlockTexture` exists
     - `roofAlphaTexture` exists
   - If `roofMaskActive` is false, hard-block is fully bypassed even if textures exist.

2. **`roofMaskActive` is currently driven by overhead-tile fade state**
   - `tile-manager` sets `weatherController.setRoofMaskActive(anyHoverHidden || anyOverheadFadeInProgress)`.
   - `anyHoverHidden` / `anyOverheadFadeInProgress` are computed inside the loop over `this._overheadTileIds`.
   - This confirms activation follows overhead tile hover/fade state.

3. **Tree canopy hover state is not feeding that activation gate**
   - `TreeEffectV2` animates `uHoverFade` for tree overlays, but does not set `weatherController.roofMaskActive`.
   - Therefore tree-only hover fade can occur while hard-block remains disabled.

4. **Blocker texture source appears overhead-centric**
   - `OverheadShadowsEffectV2.roofBlockTexture` is sourced from `roofBlockTarget` (forced-opaque overhead roof pass).
   - After reverting temporary tree-layer forcing, there is no verified clean tree-authoring path back into this blocker target.
   - Net effect: tree canopy pixels likely absent from blocker silhouette used by precipitation.

### Updated Root-Cause Conclusion

Most probable primary cause is **state/source disconnect**, not shader math:

- Hard-block logic in precipitation shader is present.
- But activation + blocker authoring are tied to overhead roof systems.
- Tree overlay hover fade is currently a separate visual path (`TreeEffectV2`) that does not reliably:
  - enable `roofMaskActive`, and/or
  - contribute canopy silhouette into `roofBlockTexture`.

This explains observed behavior:

- overhead-related masking may partially respond,
- tree hover-fade masking remains incorrect,
- `_Outdoors` continues to behave normally.

### Recommended Fix Direction (Post-Investigation)

1. Introduce a dedicated "weather blocker active" signal that ORs:
   - overhead fade/hover state, and
   - tree canopy hover/fade state.
2. Provide a clean tree blocker source for precipitation (separate from shadow-caster rendering), instead of layer hacks.
3. Keep rain/splash hard-block shader as-is unless diagnostics prove sampling mismatch.

---

### 7) Tree reveal signal bridge + blocker fallback (attempted fix)

Files:

- `scripts/compositor-v2/effects/TreeEffectV2.js`
- `scripts/particles/WeatherParticles.js`

What was changed:

- Added `TreeEffectV2.isHoverRevealActive()` to report tree hover-hide/fade activity.
- Updated `WeatherParticles` hard-block activation to include tree reveal activity:
  - `hoverRevealActive = weatherController.roofMaskActive || treeHoverRevealActive`
- Added blocker fallback:
  - if dedicated `roofBlockTexture` is missing during tree reveal, use `roofAlphaTexture` as blocker source.
- Updated rain/splash uniform assignments to consistently use `rainRoofBlockTexture` (dedicated or fallback).

Result:

- **Failed in user testing**.
- User reports no improvement for both:
  - overhead layer fade masking
  - tree canopy fade masking

Interpretation after failure:

- Likely not just a state-gating issue.
- Remaining likely causes are now concentrated on:
  1. Runtime texture content not matching expectation (`roofAlpha`/`roofBlock` values not encoding blockers as assumed),
  2. screen-space sampling mismatch (`gl_FragCoord / uScreenSize` vs actual target coordinates),
  3. active rendered material path not using expected injected shader variant on the batches visible in-scene.

Next investigation now required:

- Add explicit runtime diagnostics for weather roof-mask uniforms + texture UUID/state transitions.
- Capture whether `rainHardBlockActive` and map-presence flags are true on frames where masking is expected.

---

### 8) Runtime diagnostics confirmed activation; investigated blocker content semantics

User-provided debug output (`window.MapShine.debugWeatherRoofMask = true`) confirms:

- `hoverRevealActive` becomes true during both overhead and tree tests.
- `rainHardBlockActive = true`.
- `rainHasRoofAlphaMap = true` and `rainHasRoofBlockMap = true`.
- Stable non-null texture UUIDs are bound for both alpha and blocker maps.

Implication:

- Failure is **not** from missing uniforms, missing textures, or inactive hard-block branch.
- Remaining issue is likely texture content: blocker map may still be carrying faded opacity similarly to visibility map, collapsing `hiddenBlock = rb * (1-rv)`.

### 9) New fix attempt: force shader `uOpacity` during blocker capture

Files:

- `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`

What was changed:

- In roof capture pass override logic, force both:
  - `material.opacity = 1.0` (existing behavior)
  - `material.uniforms.uOpacity = 1.0` when present (new behavior)
- Restore original `uOpacity` values after capture pass.

Why:

- Some weather-roof blocker renderables are shader-driven by `uOpacity`.
- Previously, blocker capture could still inherit hover-faded opacity even while `material.opacity` was forced to 1.0.
- That would make blocker and visibility maps too similar, preventing hard-block suppression.

Result:

- **Failed in user testing** (no visible rain/splash suppression improvement yet).

---

### 10) New suspected root cause: blocker override filtered only `ROOF_LAYER` (20)

Files:

- `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`

What was discovered:

- Blocker capture override traversal used a hard filter for layer 20 only.
- Weather blocker participants can be on `WEATHER_ROOF_LAYER` (21) and still be included in capture rendering, but were skipped by the force-opaque override pass.
- This allows fade-driven opacity to leak into blocker capture content for weather-only participants.

What was changed:

- Added a combined capture mask (`ROOF_LAYER | WEATHER_ROOF_LAYER`) for the blocker/roof capture override traversals.
- Updated both relevant traversal checks to use the combined mask.

Why this matters:

- If weather-only blocker meshes are skipped by the override pass, `roofBlockTexture` can remain too similar to runtime visibility texture.
- That collapses `hiddenBlock = rb * (1-rv)` toward zero and produces little/no suppression.

Result:

- **Failed in user testing** (still no suppression under overhead/tree blockers).

---

### 11) New suspected root cause: fade applied only to alpha channel

Files:

- `scripts/particles/WeatherParticles.js`

What was discovered:

- Mask path computes `msWaterFade` and multiplies it into `gl_FragColor.a` only.
- Many precipitation/splash materials in this pipeline are effectively additive/emissive in appearance, where alpha reduction alone does not visibly suppress RGB contribution enough.

What was changed:

- Updated both shader injection paths to apply:
  - `gl_FragColor.rgb *= msWaterFade;`
  - `gl_FragColor.a *= msWaterFade;`
- Kept discard thresholds unchanged.

Why this matters:

- Ensures hard-block fade actually attenuates visible particle color, not only alpha bookkeeping.
- If blocker math is correct but visual output ignores alpha weight, this is required for visible suppression.

Result:

- **Failed in user testing**.
- Overhead and tree hover-fade cases still do not suppress rain/splashes underneath blockers.

---

## Consolidated Detailed Investigation Record

### Executive Status

As of this log revision:

- The issue is still unresolved.
- We have repeatedly confirmed the intended hard-block path is compiled, bound, and activated.
- Despite that, user-visible suppression under overhead/tree blockers is not occurring.
- `_Outdoors` world-space behavior remains stable and should be treated as healthy baseline behavior.

### User-Observed Runtime Behavior (Persistent)

- Hover/fade overhead blockers: rain and splashes still render underneath.
- Hover/fade tree canopy blockers: rain and splashes still render underneath.
- Roof/tree drips remain present (expected by requirement).
- No new major visual artifact introduced by recent attempts (except the earlier reverted dark-offset regression).

### Runtime Diagnostics Evidence (Captured)

From `window.MapShine.debugWeatherRoofMask = true`, observed during both overhead and tree tests:

- `hoverRevealActive: true` during active hover/fade windows.
- `rainHardBlockActive: true`.
- `rainHasRoofAlphaMap: true`.
- `rainHasRoofBlockMap: true`.
- Stable non-null `roofAlphaUuid` / `roofBlockUuid`.
- Valid non-zero screen dimensions (`screenWidth`, `screenHeight`).

Meaning:

- The system is not failing due to missing textures/uniforms or disabled branch activation.
- Failure likely occurs in one of:
  1. sample content semantics (`roofAlpha` / `roofBlockAlpha` not representing what equation assumes),
  2. sample-space mismatch (screen UV mismatch at draw time),
  3. rendered material/blend path reducing the practical effect of suppression.

### Full Attempt Timeline (Expanded)

1. Added hard-block uniform path for rain only.
   - Outcome: failed.
2. Extended hard-block path to splash systems/material variants.
   - Outcome: failed.
3. Split visibility/blocker maps and introduced `hiddenBlock = rb * (1-rv)`.
   - Outcome: failed.
4. Forced tree overlays into roof capture with hover override.
   - Outcome: regression (dark offset artifact), then reverted.
5. Fixed alpha/blocker source separation after earlier assignment mistake.
   - Outcome: failed.
6. Added shader migration/reinjection robustness for legacy/patched variants.
   - Outcome: failed.
7. Bridged tree reveal state into weather activation; blocker fallback path added.
   - Outcome: failed.
8. Added runtime roof-mask diagnostics and collected active-path evidence.
   - Outcome: confirms activation/binding, does not fix behavior (diagnostic-only).
9. Forced shader `uOpacity` to 1.0 during blocker capture pass.
   - Outcome: failed.
10. Expanded blocker override traversal from layer 20-only to include layer 21.
   - Outcome: failed.
11. Changed weather fade post-multiply from alpha-only to RGB+alpha.
   - Outcome: failed.

### What Is Confirmed True in Code (Current State)

- `WeatherParticles` has hard-block uniforms and logic for rain and splash paths.
- `hiddenBlock` equation exists in fragment injection path and migration path.
- Hard-block controls are disabled for roof/tree drips as intended.
- Overhead effect exposes both:
  - runtime visibility texture (`roofVisibilityTarget` / `roofAlphaTexture`)
  - blocker texture (`roofBlockTarget` / `roofBlockTexture`)
- Capture pass now attempts force-opaque behavior with both `material.opacity` and `uniforms.uOpacity`.
- Capture override selection now includes both roof/weather layers.
- Debug telemetry confirms active branch + bound texture uuids during reproduction.

### What Is Still Unproven / High-Risk

1. **Pixel-level content validity of both textures at the same sampled fragment**
   - We still do not have direct sampled values (`rv`, `rb`, `hiddenBlock`) for affected pixels.
2. **Screen UV alignment at final precipitation draw stage**
   - `gl_FragCoord / uScreenSize` may not match producer pass assumptions in all runtime camera/compositor states.
3. **Blend/material interaction in quarks-derived particle shaders**
   - Even with RGB+alpha scaling, effective suppression may be minimized by shader/blend specifics in the actual emitted draw call.
4. **Tree contribution fidelity in blocker source**
   - Tree hover/fade state is now consulted, but blocker authoring may still be roof-centric in effective content.

### Why This Has Been Hard to Resolve

- Multiple systems intersect:
  - overhead capture pass,
  - weather shader string injection/migration,
  - quarks material variants and batching,
  - world-space `_Outdoors` + screen-space blocker gating,
  - separate tree overlay path.
- Several fixes were structurally correct but could still fail if sampled texture content is not semantically different enough at runtime.
- Existing diagnostics prove activation but not the actual sampled values at problematic pixels.

### Current Working Theory (Most Likely)

The issue is now most likely a **data semantics mismatch at sample time**, not a simple missing toggle:

- hard-block logic runs,
- textures are bound,
- but `roofBlockAlpha` and `roofAlpha` are not diverging in the way required to produce strong `hiddenBlock` suppression at the rendered particle pixels.

### Recommended Next Investigation (Documentation-Only; no fix in this step)

To break deadlock, next investigation should prioritize direct measurement:

1. Add short-lived diagnostics that report sampled `rv`, `rb`, and computed `hiddenBlock` at representative test pixels.
2. Add a temporary debug mode that hard-displays one channel at a time (`rv`, `rb`, `hiddenBlock`) to confirm texture semantics visually.
3. Validate whether sampled values differ between:
   - overhead hover test point under roof tile,
   - tree hover test point under canopy,
   - open outdoors control point.
4. If `hiddenBlock` stays near zero at blocked points, focus on blocker content authoring.
5. If `hiddenBlock` is high but particles remain visible, focus on final blend/material path at draw output.

---

### 12) Capture-path hardening for overhead/tree blocker semantics (new fix)

Files:

- `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`

What was changed:

- Added tree-overlay participation to weather capture passes by temporarily enabling tree meshes on `WEATHER_ROOF_LAYER` during capture.
- Kept tree overlays excluded from the roof shadow-caster pass (`roofTarget`) to avoid reintroducing the dark canopy underside regression.
- Forced additional shader opacity controls to `1.0` during blocker capture for non-fluid participants:
  - `material.opacity`
  - `uniforms.uOpacity`
  - `uniforms.uTileOpacity` (new)
- For tree overlays in blocker capture, temporarily forced `uHoverFade = 1.0` so blocker silhouettes remain opaque even when canopy visuals are hover-faded.
- Added full restoration of temporary layer/visibility/uniform overrides in `finally`-safe paths.

Why this is different from prior attempts:

- Prior blocker forcing focused on `material.opacity` / `uOpacity` and roof-layer participants, but missed a common V2 opacity path (`uTileOpacity`) and did not isolate tree inclusion to weather captures only.
- This change specifically targets blocker-map semantics (`roofBlockTexture`) while preserving shadow-pass behavior.

Expected outcome:

- `roofBlockTexture` should now diverge from runtime visibility alpha during hover reveal.
- Hard-block term in precipitation shader should produce stronger suppression under hovered overhead/tree blockers.
