# Render Sync Deep Audit

## Scope and trigger

This audit focuses on:

- `scripts/core/render-loop.js`
- `scripts/core/frame-coordinator.js`
- `scripts/foundry/canvas-replacement.js`
- `scripts/compositor-v2/FloorCompositor.js`
- `scripts/masks/GpuSceneMaskCompositor.js`
- `_Outdoors` consumers (`WaterEffectV2`, `CloudEffectV2`, `SkyColorEffectV2`, `FilterEffectV2`, `AtmosphericFogEffectV2`, `OverheadShadowsEffectV2`, `BuildingShadowsEffectV2`)

Observed behavior from field test:

- Flicker disappears when forcing `effectComposer.render()` on every rAF.
- This confirms the current adaptive frame-skip path is not safe for this runtime state.


## Current frame pipeline (what happens today)

1. Foundry runs PIXI ticker callbacks.
2. `FrameCoordinator` runs on PIXI ticker (`-50`) and captures camera state.
3. `canvas-replacement` post-PIXI callback calls:
   - `renderLoop.requestRender()`
   - `renderLoop.requestContinuousRender(120)` when camera moved
4. Browser rAF calls `RenderLoop.render()`.
5. `RenderLoop` may skip `effectComposer.render()` due adaptive/idle gating.
6. If not skipped, `EffectComposer.render()` runs `FloorCompositor.render()`, which:
   - updates many effects/uniforms
   - performs `_syncOutdoorsMaskConsumers` only under specific conditions
   - runs all actual Three.js passes

Key issue: Foundry/PIXI and MapShine compose/render are still separate clocks. The code "nudges" them together, but does not guarantee lockstep.


## Findings

## 1) Primary confirmed issue: composer frame skipping breaks sync

`RenderLoop` owns whether `effectComposer.render()` runs at all. In the non-diagnostic path, idle/adaptive logic can skip many rAF ticks. During those skipped ticks:

- no `EffectComposer.render()`
- no `FloorCompositor.render()`
- no per-frame effect update path
- no per-frame outdoors re-evaluation path

Meanwhile Foundry ticker continues updating state. That produces phase drift and visible instability.

This is consistent with the reproduction: forcing every-rAF composer render removes flicker.


## 2) `_Outdoors` sync is not frame-robust after fallback binding

`FloorCompositor._syncOutdoorsMaskConsumers()` currently short-circuits on:

- `if (!force && outdoorsTex === this._lastOutdoorsTexture) return;`

That guard ignores:

- `waterOutdoorsTex` (water-specific resolution)
- `skyOutdoorsFinal` (strict sky-specific resolution)
- source quality/route changes (neutral fallback -> real compositor RT)
- floor key transition details

Result: consumers can stay on fallback/old textures even after better textures become available.


## 3) Ordering bug on floor change for water outdoors binding

In `FloorCompositor._applyCurrentFloorVisibility()`:

1. `_syncOutdoorsMaskConsumers({ force: true })` is called
2. `this._waterEffect.onFloorChange(maxFloorIndex)` is called later

But `_syncOutdoorsMaskConsumers()` computes `waterOutdoorsTex` from `this._waterEffect._activeFloorIndex`. At that moment, water floor index is still old. This can bind wrong/outdated outdoors mask for water immediately after floor switches.

If later sync is skipped (finding #2), this stale bind can persist.


## 4) Per-frame outdoors resync gate is too narrow

`FloorCompositor.render()` only triggers outdoors resync when:

- context key changed, or
- `!this._lastOutdoorsTexture`, or
- explicit debug force flag

In multi-floor scenes, `_lastOutdoorsTexture` can be a neutral/bundle fallback (non-null), so the gate closes before compositor floor RTs are ready. Once real floor outdoors arrives asynchronously, no guaranteed resync path promotes the bind.


## 5) FrameCoordinator currently only requests rendering; it does not guarantee render-after-pixi semantics

`onPostPixi` callback only asks `RenderLoop` for render/continuous window. If the subsequent rAF chooses not to render, state still diverges for that tick.

Also, `FrameCoordinator.onSync()` is not used elsewhere today, so no synchronized pre-render pull stage is active.


## 6) Diagnostic flag currently proving the problem is intentionally brute-force

Current temporary flag in `RenderLoop`:

- `DIAG_FORCE_EFFECT_COMPOSER_EVERY_RAF = true`

is good for bisecting, but not a production strategy by itself.


## Probable root cause chain for "effects not correctly served _Outdoors"

1. Adaptive skip prevents some compose frames from running.
2. Outdoors sync uses coarse identity guard (`outdoorsTex` only).
3. Floor-change path syncs outdoors before water floor state updates.
4. Fallback/neutral texture can become sticky because per-frame rebind gate closes.

This combination explains:

- flicker/stability differences with adaptive skip on/off
- wrong or stale outdoors-dependent behavior in effects (especially water family)


## Hardening plan (recommended)

## A) Make render cadence deterministic with PIXI (without always maxing FPS)

Introduce a lockstep condition:

- Track last consumed `frameCoordinator.frameNumber`.
- Require at least one `effectComposer.render()` for each new PIXI frame in V2 runtime.
- Allow skipping extra display rAFs that do not correspond to a new PIXI frame.

Effectively:

- render rate follows Foundry state rate
- avoids stale-state frames
- avoids brute-force rendering at very high display refresh when PIXI has not advanced


## B) Fix floor-change ordering for outdoors/water

In `_applyCurrentFloorVisibility()`:

- call `waterEffect.onFloorChange(maxFloorIndex)` before `_syncOutdoorsMaskConsumers(...)`

or run a second forced outdoors sync immediately after water floor update.


## C) Replace single-texture change guard with a binding signature

For `_syncOutdoorsMaskConsumers`, compute a signature over:

- `outdoorsTex`
- `waterOutdoorsTex`
- `skyOutdoorsFinal`
- resolved floor key(s)
- maybe water active floor index

Only skip if full signature unchanged.


## D) Keep resync open while on fallback routes

Track resolution route (`direct`, `sibling`, `ground`, `bundle`, `maskManager`, `registry`, `neutral`, `weatherController`, `null`) and keep trying until route reaches an acceptable steady state for the current floor context.

At minimum:

- if last route is neutral/bundle in multi-floor scene, retry periodically (or each compose frame) until compositor direct/sibling resolves.


## E) Add explicit sync telemetry for runtime confidence

Add lightweight counters/state exposed in diagnostics:

- last PIXI frame number seen
- last compositor frame number rendered
- skipped compositor frames count
- last outdoors binding signature
- last outdoors route per consumer (global/water/sky)
- timestamp of last successful direct compositor outdoors resolve

This makes regressions obvious and debuggable.


## F) Keep adaptive performance, but move throttling inside passes

Instead of skipping entire compositor frames under idle:

- keep frame sync cadence (A)
- decimate expensive internals by pass/effect where safe
- preserve uniform/buffer freshness each synced frame


## Implementation order (low risk -> high impact)

1. Ordering fix in `_applyCurrentFloorVisibility` (B).
2. Binding-signature guard in `_syncOutdoorsMaskConsumers` (C).
3. Fallback retry policy/route tracking (D).
4. Frame lockstep in `RenderLoop` (A).
5. Telemetry additions (E).
6. Refined adaptive policy (F).


## Acceptance criteria

- No visual flicker when diagnostic force flag is OFF.
- `effectComposer.render()` executes at least once per PIXI frame in V2.
- On floor switch, water/sky/cloud/shadows receive correct `_Outdoors` within same frame budget.
- No persistent neutral/bundle fallback when compositor floor outdoors is available.
- Diagnostics show stable frame parity and outdoors route transitions.


## Notes

- Keep the current diagnostic force flag until lockstep solution is in place and validated.
- Do not assume "non-null outdoors texture" means "correct outdoors texture."
