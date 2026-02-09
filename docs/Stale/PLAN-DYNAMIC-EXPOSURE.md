# PLAN: Dynamic Exposure (Token-Based Eye Adaptation)

## Goals

- Add **Dynamic Exposure**: a per-player “eye adaptation” system driven by the brightness **under a token**.
- When a token transitions:
  - **Dark -> Bright**: exposure remains high briefly (blown-out / overexposed feel), then smoothly settles back to neutral.
  - **Bright -> Dark**: exposure remains low briefly (too-dark feel), then smoothly ramps up to neutral.
- Compute the brightness measurement **efficiently**.
- Determine whether the token is **outdoors** (and optionally distance-to-indoors edge), and make this contextual data available to other systems.
- Provide **Tweakpane UI**:
  - User controls for exposure adaptation bounds and timing.
  - A live **debug panel** showing the current measured/derived values for the *selected token*.

## Non-Goals (Initial)

- HDR histogram / full-screen auto-exposure (camera-style) across the entire viewport.
- Per-pixel exposure / local tone mapping.
- Per-token separate exposure *applied simultaneously* on-screen (that would be visually conflicting). We will choose a single “subject token” per client.

## Current Architecture Fit (Existing Systems)

- **Time**: All time-driven systems must use the centralized `TimeManager` (`update(timeInfo)`), not `performance.now()`.
- **Outdoors / Roof mask**:
  - `WeatherController` already extracts `_Outdoors` once to a CPU `Uint8Array` and exposes `getRoofMaskIntensity(u, v)`.
  - This is ideal for a fast “is this position outdoors?” query.
- **Selection / controlled token**:
  - `VisionManager` uses Foundry’s `controlToken` hook to track controlled tokens.
  - We can reuse this pattern to pick the “exposure subject”.
- **Color correction**:
  - `ColorCorrectionEffect` is a post-processing pass with an `exposure` parameter.
  - Token sprites also have an independent `TokenManager.tokenColorCorrection.exposure`, but Dynamic Exposure is conceptually a *camera/eye* effect and should affect the whole view.

## Proposed High-Level Design

### 1) New service: `DynamicExposureManager`

A new manager that:

- Selects a **subject token** (per client)
- Samples brightness beneath it (throttled)
- Computes an exposure multiplier with temporal lag (eye adaptation)
- Applies that multiplier to post-processing color correction
- Publishes an API for other effects

Recommended location:

- `scripts/core/DynamicExposureManager.js` (or `scripts/core/dynamic-exposure-manager.js`, match existing naming conventions)

Expose for debugging:

- `window.MapShine.dynamicExposureManager`

Register as an updatable:

- `effectComposer.addUpdatable(dynamicExposureManager)`

### 2) Subject token selection rule

Per client, define:

- `subjectTokenId` =
  - `canvas.tokens.controlled[0]?.id`, else
  - `game.user.character?.getActiveTokens()?.[0]?.id`, else
  - `null` (feature inactive)

This ensures Dynamic Exposure behaves like “your eyes/camera”, not like a per-token visual filter.

### 3) Shared exposure context API (for future effects)

The manager maintains a small, allocation-free context per token:

```js
{
  tokenId,
  world: { x, y },            // Foundry coords (px)
  outdoors: 0..1,             // from _Outdoors mask (CPU)
  measuredLuma: 0..inf,       // scene brightness sample (linear)
  targetExposure: min..max,   // computed from luma
  appliedExposure: min..max,  // smoothed over time
  debug: {
    screenUv: { u, v },
    lastProbeAt: elapsedSeconds
  }
}
```

Public methods:

- `getContextForToken(tokenId)`
- `getSubjectContext()`
- `getOutdoorsAtWorld(x, y)` (thin wrapper over `WeatherController.getRoofMaskIntensity`)

## Brightness Measurement (“Probe”)

### Requirements

- Must be **cheap** (no full-screen readbacks).
- Must be stable enough to drive a smoothing model (noise is OK; smoothing will handle it).
- Must represent *what the token is exposed to*, so it should include lighting.

### Recommended approach (Phase 1): tiny GPU probe + low-frequency readback

Create a 1x1 (or 4x4) `WebGLRenderTarget` and a simple full-screen quad shader that samples from the post-light scene texture at the token’s screen UV.

- **Input texture**: the lighting-composited buffer *before* `ColorCorrectionEffect`.
  - This avoids a feedback loop (auto-exposure shouldn’t read its own output).
- **Update rate**:
  - `probeHz = 10` (configurable)
  - Only when a subject token exists.

Readback strategy:

- `renderer.readRenderTargetPixels(probeTarget, 0, 0, 1, 1, outRGBA8)`
- Convert RGB to luminance on CPU:
  - `luma = dot(rgb, [0.2126, 0.7152, 0.0722])`

**Important**: readback can stall the GPU pipeline, so we keep it at 1x1 and 5–10Hz.

### Computing the token’s screen UV

Use the same pattern as token HUD positioning:

- Convert token center world position to a `THREE.Vector3` in Three world space
- `project(camera)` to NDC
- Convert NDC to screen UV:
  - `u = ndc.x * 0.5 + 0.5`
  - `v = ndc.y * 0.5 + 0.5`

Clamp UV into a safe range (avoid sampling outside the render target).

### Alternative approach (Phase 2): multi-tap / neighborhood sampling

To avoid a single bright pixel (torch highlight) dominating:

- Sample 4–9 offsets around the token center in the probe shader
- Output average luminance

Still 1x1 readback, but a slightly heavier shader.

## Outdoors Detection

Use `_Outdoors` via `WeatherController.getRoofMaskIntensity(u, v)`.

We need a clear coordinate contract:

- Compute world-space UV relative to `canvas.dimensions.sceneRect`.
- Follow the module’s established convention: **flip V** for world→mask sampling.

Proposed helper:

- `DynamicExposureManager._worldToRoofUv(foundryX, foundryY)`

That helper should be used by Dynamic Exposure and any future “context probes” to avoid duplicated conversion logic.

## Exposure Adaptation Model (Eye Lag)

### Key idea

We compute the **target exposure** from the *current* measured brightness, but we apply it with a time lag.

That lag produces the desired effect:

- If you were in a dark space (target exposure high) then step into bright outdoors, the applied exposure remains high for a moment → the scene blows out → then adapts down.
- Vice versa when stepping into darkness.

### Math

- `measuredLuma` is assumed linear-ish (from HDR/float pipeline). Clamp to a floor.
- Choose a mid-grey reference:
  - `MID = 0.18`

Target exposure multiplier:

- `target = clamp(MID / max(measuredLuma, 1e-4), minExposure, maxExposure)`

Smoothing (in log space for perceptual stability):

- `logE = log2(exposure)`
- `logTarget = log2(target)`
- Use two time constants:
  - `tauBrighten` when `target > current` (going into dark)
  - `tauDarken` when `target < current` (going into bright)

Update:

- `alpha = 1 - exp(-dt / tau)`
- `logE = mix(logE, logTarget, alpha)`
- `exposure = 2^logE`

### Outdoors coupling (optional)

Outdoors can be used to slightly bias adaptation so the system behaves more “cinematic”:

- Outdoors tends to be higher dynamic range, so we can optionally:
  - clamp exposure tighter outdoors (smaller max)
  - adapt faster when outdoors

This should be optional and default-off until tuned.

## Applying the Result to Rendering

### Recommended: integrate into `ColorCorrectionEffect`

Add a new uniform multiplier, e.g.:

- `uDynamicExposure` (default `1.0`)

Final exposure becomes:

- `color *= uExposure * uDynamicExposure`

This avoids adding another post-processing pass.

The manager sets `colorCorrectionEffect.params.dynamicExposure = appliedExposure` (or calls a setter), and the effect copies it into uniforms.

### Avoid feedback loops

The probe must sample from the buffer *before* dynamic exposure is applied.

## Tweakpane UI Requirements

### 1) Controls

Add a new folder under Global (or under Color Correction):

- `Dynamic Exposure`
  - `enabled` (boolean)
  - `minExposure` (slider, e.g. 0.25 .. 2.0)
  - `maxExposure` (slider, e.g. 0.25 .. 4.0)
  - `probeHz` (slider/list, e.g. 1, 2, 5, 10)
  - `tauBrighten` (seconds, e.g. 0.05 .. 5)
  - `tauDarken` (seconds, e.g. 0.05 .. 5)

### 2) Debug readouts (selected token)

Add a subfolder `Debug (Selected Token)` with read-only fields:

- `subjectTokenId`
- `measuredLuma`
- `outdoors`
- `targetExposure`
- `appliedExposure`
- `screenUv.u`, `screenUv.v`
- `lastProbeAgeSeconds`

Implementation note:

- Tweakpane supports “monitor” / read-only style bindings; if not available in current version, we can:
  - bind to a small `debugState` object
  - periodically update it
  - mark bindings as readonly/disabled where possible

## Performance Considerations

- Throttle probe to 5–10Hz.
- Only probe when a subject token exists.
- Avoid allocations in `update()`:
  - reuse vectors
  - reuse readback buffers (`Uint8Array(4)`)
- If readback is still too expensive on some GPUs, add an automatic fallback:
  - reduce probeHz
  - or disable Dynamic Exposure when FPS is below a threshold.

## Implementation Plan (Phases)

### Phase 1 (MVP)

- Add `DynamicExposureManager` with:
  - subject token selection
  - probe rendering + 1x1 readback at 5–10Hz
  - outdoors query
  - smoothing model
- Integrate with `ColorCorrectionEffect` via a single multiplier uniform.
- Add Tweakpane controls + debug readouts.

### Phase 2 (Quality)

- Multi-tap probe sampling to reduce noise.
- Basic hysteresis / deadzone (avoid tiny exposure oscillations).
- Optional outdoors coupling.

### Phase 3 (API reuse)

- Formalize as a more general `SceneProbeRegistry` or `EnvironmentContextManager` if other systems begin consuming these signals.

## Proposed File Touch List

- `docs/PLAN-DYNAMIC-EXPOSURE.md` (this file)
- `scripts/core/DynamicExposureManager.js` (new)
- `scripts/effects/ColorCorrectionEffect.js` (add `uDynamicExposure` and param wiring)
- `scripts/foundry/canvas-replacement.js` (instantiate + expose manager)
- `scripts/ui/tweakpane-manager.js` (UI folder + debug monitor)

## Open Questions

- Should the “subject token” be:
  - controlled token,
  - player character token,
  - or camera center when no token is selected?
- Should Dynamic Exposure be a **player-only override**, or also authored per-scene (Map Maker / GM tiers)?
- Do we want to incorporate Foundry darkness level into target exposure, or purely rely on measured luma?
