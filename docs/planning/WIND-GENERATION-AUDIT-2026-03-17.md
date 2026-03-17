# Wind Generation Audit (2026-03-17)

## Scope

Audit the current wind-speed and wind-direction generation approach that feeds V2 effects (especially Tree/Bush motion), and evaluate whether the approach is directionally correct, realistic, and consistent with the desired design goal:

- no special-case gust mode,
- response driven by actual current wind speed,
- coherent large-scale wind waves across the map,
- plausible temporal behavior.

---

## Code Paths Reviewed

### Authoritative weather state and unit handling
- `scripts/core/WeatherController.js`
  - Wind units and compatibility bridge (`windSpeedMS` authoritative, `windSpeed` legacy): `_wind01FromMS`, `_windMSFrom01`, `_syncWindUnits`

### Weather simulation update loop
- `scripts/core/WeatherController.js`
  - `update(timeInfo)` pipeline
  - transition/static base state handling
  - variability application (`_applyVariability`)

### Dynamic weather generation (preset-driven latent model)
- `scripts/core/WeatherController.js`
  - `_dynamicStep(seconds)`
  - `_deriveDynamicOutputs()`

### UI-driven wind writes
- `scripts/ui/control-panel-manager.js`
  - `_applyWindState()`

---

## Current Model Summary

## 1) Core update architecture (good)

The weather loop is well-structured:
1. Build base current state from target (or transition interpolation).
2. Apply variability/noise layer.
3. Compute derived outputs (wetness, environment outputs).

This is clean and easy to reason about for effect consumers.

## 2) Wind speed is represented in both m/s and legacy normalized units (good)

The controller preserves backward compatibility while exposing physical units:
- `windSpeedMS` = authoritative value,
- `windSpeed` = derived normalized value for existing effects.

This is a strong foundation for future realism improvements.

## 3) Variability currently includes a gust state machine + noise add-ons (problematic)

Current variability path:
- toggles gusting ON/OFF via timer state machine,
- smooths gust envelope (`currentGustStrength`),
- computes meander + gust components,
- composes in normalized domain, then converts to m/s.

This creates a separate "gust mode" instead of deriving all behavior continuously from wind state.

## 4) Wind direction perturbation is bounded around target (good)

Direction is perturbed around `targetState.windDirection` (not integrated from current every frame), which avoids random-walk drift and eventual reversal.

## 5) Direction sign convention may be inconsistent across write paths (risk)

Two pathways appear to use opposite Y sign conventions when converting angle -> wind vector:
- weather preset/dynamic pathways use `y = -sin(angle)` (Y-down storage convention),
- control-panel wind application appears to use `y = +sin(angle)`.

Even if this is partially compensated elsewhere, this mismatch is high-risk and should be unified in one shared helper.

---

## Findings

## What is correct as an approach

- Having a single authoritative weather controller feeding all systems is correct.
- Maintaining both `windSpeedMS` and normalized `windSpeed` is correct for migration safety.
- Applying bounded directional variability around target direction is correct.

## What should change

1. **Remove special-case gust mode from generation logic**
   - The toggled gust state machine should be replaced by continuous multi-scale variability driven by current wind speed.

2. **Generate in physical units first (m/s), then derive normalized value**
   - Compose variability in m/s space, clamp, then map to legacy `windSpeed`.
   - Avoid composing in normalized space then converting to m/s.

3. **Unify angle/vector conversion convention globally**
   - Introduce a shared helper for direction conversion so all paths agree.

4. **Add map-scale advection field for coherence**
   - Large-scale low-frequency wind field should modulate local wind pressure so vegetation responds in traveling waves, not all at once.

---

## Recommended Refactor Plan

## Phase A — Convention and safety

- Add shared helpers in `WeatherController` (or shared weather math module):
  - `angleDegToFoundryWindDir(angleDeg)`
  - `foundryWindDirToAngleDeg(vec)`
- Replace all direct `cos/sin` conversions in control panel + presets + dynamic outputs with helpers.
- Add lightweight debug assertions to verify unit length + sign expectations.

## Phase B — Speed generation redesign (no gust mode)

Replace gust state machine with continuous process:

`windMS = baseMS + LF(t) + MF(t) + HF(t)`

Where:
- LF: large, slow synoptic drift,
- MF: normal turbulence band,
- HF: short bursts (but still continuous, not toggled ON/OFF).

All band amplitudes/frequencies should be functions of current base wind speed.

## Phase C — Direction generation redesign

- Keep slow baseline heading drift.
- Add speed-coupled directional jitter (small angle perturbation).
- Keep bounded perturbation around target heading.

## Phase D — Consumer alignment (Tree/Bush and particles)

- Tree/Bush should use current wind speed as primary driver.
- Remove downstream special gust pathways where possible.
- Keep only optional artistic multipliers, not separate gust logic branches.

---

## Expected Outcome

After refactor:
- wind behavior is continuous and speed-driven,
- no binary gust mode artifacts,
- stronger realism and coherence for vegetation,
- better cross-system consistency (particles, water drift, foliage),
- fewer sign-convention regressions.

---

## Notes

This document captures architecture-level findings only. It does not yet include implementation diffs.
