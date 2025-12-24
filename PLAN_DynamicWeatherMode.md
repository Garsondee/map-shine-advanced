# PLAN: Dynamic Weather Mode (Evolving Biome Weather)

## 1. Goal
Create a **single-source-of-truth** weather system which can be switched into a **Dynamic Weather Mode** that evolves weather over time (minutes → hours) in a way that is:

- Plausible and consistent (no “random slider jitter”)
- Biome-constrained (desert ↔ arctic spectrum, plus named biome presets)
- Expressive (supports calm days, storms, and hurricanes)
- Friendly to creators (simple presets + optional advanced constraints)
- Authoritative (when dynamic mode is enabled, other weather controls become read-only/disabled)

This system should drive **all weather-dependent effects** (precipitation, wind, clouds, fog, wetness, freeze/snow line, etc.) so the scene’s visuals are coherent.

It must also unify:

- **Time of Day** (UI slider now, later linked to Foundry time)
- **Scene Darkness** (Foundry environment darkness, modulated by weather/time)
- A shared **Sky Color / Ambient API** which affects cloud colouration, specular/metal reflections, and overall scene grading.

## 2. Non-Goals (for first iteration)
- Full meteorological simulation (fronts, dew point, pressure maps)
- Per-region weather (this is scene-global first)
- Networked multiplayer “weather authority” beyond Foundry’s normal GM-as-authority pattern
- Real-world units correctness (we keep the “cinematic plausibility” philosophy)

## 3. Current State (as of today)
- `scripts/core/WeatherController.js` already:
  - Maintains `currentState`, `targetState`, transitions, and variability (“wanderer loop”)
  - Has an existing **gust state machine**
  - Exposes a Tweakpane schema and a small set of presets
- `scripts/foundry/canvas-replacement.js` wires WeatherController to UI updates.
- Weather-dependent systems consume `weatherController.getCurrentState()`.

Dynamic Weather Mode should **not fight** existing concepts; it should become the authoritative writer of `targetState` (and possibly the variability parameters) when enabled.

## 4. Proposed Architecture
### 4.1 High-level components
- **WeatherController** (existing): remains the central public API.
- **DynamicWeatherModel** (new, owned by WeatherController): generates evolving targets.
- **DynamicWeatherUI** (new or integrated into existing Tweakpane system): toggle + preset selection + constraint controls.

Add a shared “environment output” concept:

- **EnvironmentMixer** (new, likely owned by WeatherController or a dedicated EnvironmentController): produces a stable set of derived values used across effects:
  - `skyColor` (RGB)
  - `skyIntensity` (0..1)
  - `effectiveDarkness` (0..1)
  - Optional: `ambientLightColor`, `ambientLightIntensity`, `sunColor`, `moonColor` (future)

### 4.2 Single source of truth
When Dynamic Weather Mode is enabled:

- WeatherController’s `targetState` is **written only by** DynamicWeatherModel.
- Manual “state sliders” become disabled (read-only) in UI.
- Other effects’ weather-related controls that would conflict (e.g. independent wind overrides) are disabled or visually marked as “Driven by Dynamic Weather”.

When Dynamic Weather Mode is disabled:

- Manual controls write directly to `targetState` as today.

### 4.3 Update loop responsibility
- WeatherController continues to be updated by the centralized TimeManager (`timeInfo.delta`, `timeInfo.elapsed`).
- DynamicWeatherModel runs inside `WeatherController.update(timeInfo)` **before** transitions/variability are applied, so it can set the “authoritative” base targets.

Environment mixing runs every frame (cheap math only), but should be structured so it does not allocate objects in hot loops.

### 4.4 Concrete v1 deliverable (minimum shippable)
The first implementation should aim for a **coherent, robust v1** rather than an over-ambitious simulation.

**v1 must include:**

- **Dynamic Weather Toggle**: `dynamicEnabled` on WeatherController.
- **Biome Preset Dropdown**: select a biome which defines baselines + bounds.
- **Slow evolution** of a small latent set:
  - `temperature`, `humidity`, `storminess`, `windBase`, `windAngle`
- **Derived WeatherState outputs** written to `targetState`:
  - precipitation/cloud/fog/freeze/wind
- **Shared environment output**:
  - `skyColor` + `skyIntensity` + `effectiveDarkness`
- **Control lockout**: disable manual weather sliders while dynamic is enabled.
- **Persistence**: store dynamic mode settings + latent state in scene flags.

**v1 explicitly does NOT include (defer):**

- Regime/Markov “fronts” system (optional v2)
- Seasonal calendar integration (optional v2)
- Forecast UI / timeline (optional v3)

### 4.5 Files and ownership (expected touchpoints)
This is the likely implementation footprint:

- **`scripts/core/WeatherController.js`**
  - Add dynamic mode state + latent variables
  - Add `getEnvironment()` API
  - Add persistence helpers (load/save scene flags)
- **`scripts/ui/tweakpane-manager.js`**
  - Add top-level Dynamic Weather toggle + biome preset dropdown
  - Add a generic control disable mechanism (not just specular)
- **`scripts/foundry/canvas-replacement.js`**
  - Wire the new UI parameters to WeatherController
  - Ensure weather controller is exposed as `window.MapShine.weatherController`
- **Effects which should consume shared environment output**
  - `scripts/effects/SkyColorEffect.js`
  - Specular-related effects (for reflection tinting)
  - Cloud effect(s)

## 5. Data Model
### 5.1 Existing public weather outputs (keep)
Continue producing these as the canonical output state:

- `precipitation` (0..1)
- `precipType` (NONE/RAIN/SNOW/HAIL/ASH)
- `cloudCover` (0..1)
- `windSpeed` (0..1)
- `windDirection` (`THREE.Vector2`, Foundry/world coords, Y-down)
- `fogDensity` (0..1)
- `wetness` (derived accumulation)
- `freezeLevel` (0..1 “warm → frozen”)

Additionally treat these as first-class environment inputs:

- `timeOfDay` (0..24, already stored on WeatherController)
- `sceneDarkness` (0..1, sourced from Foundry `canvas.environment.darknessLevel` when available)

### 5.2 New “latent” dynamic variables (internal)
DynamicWeatherModel maintains a smaller set of slowly-changing hidden variables that evolve smoothly. Proposed initial set:

- **temperature** (0..1) -> maps primarily to `freezeLevel`
- **humidity** (0..1) -> limits precipitation and fog potential
- **pressure / storminess** (0..1) -> drives cloudCover, gustiness, storm probability
- **windBase** (0..1) -> baseline windSpeed
- **windAngle** (0..2π) -> windDirection

These variables are evolved, then converted to WeatherState outputs.

### 5.3 Derived Environment Outputs (shared API)
We should standardize a single place to compute and expose these outputs (read-only):

- `skyColor` (linear RGB)
- `skyExposure` / `skyIntensity` (scalar)
- `effectiveDarkness` (0..1)

These should be accessible as an API for other effects, e.g.:

- `weatherController.getEnvironment()` or `environmentController.getEnvironment()`

This is the single source of truth for “what colour is the sky/ambient light right now?”

Proposed `EnvironmentState` shape (v1):

- `timeOfDay` (0..24)
- `sceneDarkness` (0..1)
- `effectiveDarkness` (0..1)
- `skyColor` (linear RGB; recommend a cached `THREE.Color`)
- `skyIntensity` (0..1)
- `overcastFactor` (0..1)
- `stormFactor` (0..1)

The goal is to avoid each effect re-deriving these differently (which leads to visual incoherence).

## 6. Evolution Algorithm (Constrained Random Walk)
### 6.1 Core process
Use a stable random-walk variant with “memory” and soft bounds:

- Ornstein–Uhlenbeck style pull toward a biome baseline
- Small Gaussian-like noise per tick
- Time-scale parameters in **minutes**, not frames

Pseudo idea:

- `x += (baseline - x) * reversion * dt + noiseStrength * sqrt(dt) * noise()`
- Clamp to [0,1] with soft clamping to avoid hard-edge sticking.

### 6.2 Derived outputs
- `freezeLevel = 1 - temperature` (or a shaped mapping)
- `cloudCover = f(humidity, storminess)`
- `precipitation = g(humidity, storminess, temperature)`
- `precipType`:
  - if `precipitation < threshold` -> NONE
  - else if `freezeLevel > snowThreshold` -> SNOW
  - else -> RAIN
- `fogDensity = h(humidity, lowWind, temperature)`
- `windSpeed = windBase` plus existing gust system (dynamic mode can adjust gust frequency/strength)

### 6.3 Events / regimes (optional but desirable)
To avoid “always mild” weather, add occasional regime shifts:

- Clear spell
- Overcast
- Rain band
- Thunderstorm / squall
- Snowstorm / blizzard

Implementation options:

- Markov chain of regimes (simple, controllable)
- Or event triggers when storminess crosses thresholds

This can be v2 of DynamicWeatherModel; v1 can ship with continuous evolution + occasional storm “pulses”.

### 6.4 Time of Day + Scene Darkness mixing (core requirement)
We need a reliable, well-defined mix of:

- **Foundry scene darkness** (authoritative “how dark the scene wants to be”)
- **Time of day** (sun angle / day-night colour shift)
- **Cloud cover + precipitation** (overcast brightness + saturation + contrast changes)

The current behavior where “high precipitation just makes outdoors grey” is a reasonable start, but the goal is:

- Rainy noon still feels like noon (just dimmer and cooler), not like evening.
- Overcast affects colour temperature and contrast, not only desaturation.
- Darkness is not purely driven by precipitation; it’s a stable mix with Foundry’s `darknessLevel`.

Implementation direction (conceptual):

- Compute a `dayFactor` from `timeOfDay` (0 midnight → 1 noon).
- Compute `overcastFactor` from `cloudCover` and `precipitation`.
- Compute `stormFactor` from high precipitation / storminess.
- Compute `effectiveDarkness` as a blend:
  - Base: Foundry `sceneDarkness` (respects GM/scene configuration)
  - Modifier: weather/time offsets (bounded so they cannot override the scene completely)

This blending must be monotonic and predictable (no surprise inversions), with clear parameterization.

### 6.5 Update frequency, stability, and determinism
To avoid “frame-jitter weather”:

- DynamicWeatherModel should update on a **fixed low frequency** (e.g. 1 Hz or 0.2 Hz), not every frame.
- Use an accumulator (e.g. `this._dynamicSimAccumulator += dt`) and step in fixed increments.
- Use a **seeded PRNG** (scene-stored seed) so weather is stable per-scene and reproducible across reloads.
- Clamp dt steps to prevent huge jumps after tab inactivity.

## 7. Biomes and Presets
### 7.1 Preset concept
A biome preset defines:

- Baselines for latent variables (temperature/humidity/storminess/windBase)
- Allowed min/max ranges (hard constraints)
- Time scales (how fast weather changes)
- Event likelihoods (storm frequency, blizzard frequency, etc.)

### 7.2 Initial preset list (proposal)
- Desert (hot, dry, low cloud, occasional wind events)
- Temperate Plains (balanced, rain fronts)
- Tropical Jungle (hot, humid, frequent rain)
- Mediterranean (dry summers, occasional storms)
- Tundra (cold, windy, snow)
- Alpine (cold, higher wind variability)
- Monsoon (high precip season)
- Arctic Blizzard (extreme cold + high wind + high snow potential)

### 7.3 “Biome slider” extreme axis
Also offer a single “Biome Severity” slider:

- 0.0 -> Extreme Desert Heat
- 1.0 -> Arctic Blizzard

This can blend between two endpoint biome configs to produce a continuum.

## 8. UI / UX Plan
### 8.1 Top-level UI toggle
Add a prominent toggle near the top of the MapShine UI:

- **Dynamic Weather: ON/OFF**

Implementation note: this should live in the **Global** / top-level UI region (not buried inside Weather tuning folders) and should be visually discoverable.

When ON:

- Shows a dedicated “Dynamic Weather” folder/panel
- Disables conflicting controls (manual precipitation/cloud/wind/freezing sliders)

### 8.2 Dynamic Weather controls (first pass)
- Preset dropdown: Biome preset
- Biome severity slider (optional if preset-based blending is implemented)
- Evolution speed (minutes/hour multiplier) separate from particle `simulationSpeed`
- Variability / noise strength
- Storminess bias (how often it gets dramatic)
- Wind ceiling (still day ↔ hurricane max)
- Temperature range limits
- Humidity range limits

Recommended v1 additions:

- A **read-only “Now” display** (compact text) showing:
  - `precipitation`, `cloudCover`, `windSpeed`, `freezeLevel`
  - and optionally a short label (“Clear”, “Overcast”, “Storm”, “Blizzard”) derived from thresholds
- A **Pause Evolution** toggle (keeps rendering, stops evolution)

### 8.3 Control disabling strategy
We need a consistent mechanism in UI to:

- Disable bindings (read-only)
- Show “Driven by Dynamic Weather” state

Implementation likely in `scripts/ui/tweakpane-manager.js`:

- Add a per-effect `controlStateResolver(effectId, paramId) -> { disabled: boolean, reason?: string }`
- On Dynamic Weather toggle, call `updateControlStates()` across affected folders.

Important: `updateControlStates` is currently effect-specific (specular). We will need to make the disabling system generic so Weather can participate.

## 9. Persistence & Authority
### 9.1 Where to store settings
Dynamic weather settings should be stored in **scene flags** (Map Maker / GM tier), since it changes the shared scene’s look.

We likely want:

- `flags.map-shine.weather.dynamic.enabled`
- `flags.map-shine.weather.dynamic.presetId`
- `flags.map-shine.weather.dynamic.params` (ranges, speeds, ceilings)
- `flags.map-shine.weather.dynamic.seed`
- `flags.map-shine.weather.dynamic.simTime` (optional; for deterministic replay)

### 9.2 Determinism
Goal: weather should be stable across reloads.

- Store a seed
- Advance an internal “simulation clock” using `timeInfo.delta` (and persist occasionally)

We can be pragmatic initially:

- Persist dynamic parameters + current latent state on scene save
- On load, resume from the stored latent state (no need for strict deterministic replay yet)

### 9.3 Authority model (GM vs players)
Foundry scenes are typically GM-authoritative. Proposed approach:

- **GM controls dynamic weather** (scene flags).
- **Players may still locally disable weather rendering** using existing per-effect enable/disable overrides.

This preserves accessibility/performance preferences without splitting the underlying shared scene state.

## 10. Foundry Time + Darkness Integration
### 10.1 Time of day source of truth
Near-term:

- Time-of-day slider remains the primary control and writes to WeatherController.

Planned integration:

- Listen to Foundry’s world time changes via the **`updateWorldTime` hook**.
- Read canonical time from `game.time.worldTime`.
- Convert `worldTime` → `timeOfDay` using the configured calendar (initially simple modulus mapping; later calendar-aware).

### 10.2 Scene darkness source of truth
- Read `canvas.environment.darknessLevel` as the authoritative baseline.
- WeatherController / EnvironmentMixer computes `effectiveDarkness` as a bounded blend with weather/time-of-day.

Implementation note: darkness can change when scene config changes or when Foundry time-of-day/daylight cycle modules adjust it, so it must be sampled reliably.

## 11. Integration Touchpoints
Dynamic Weather Mode must drive the same outputs that existing effects already consume:

- **WeatherParticles**: precipitation intensity, precip type, wind vector/speed, roof/alpha masking behavior
- **CloudEffect**: cloudCover + wind direction/speed + cloud shadow intensity (via weather)
- **WaterEffect**: wetness + precipitation (puddles/ripples), possibly wind for ripples
- **Fire / Sparks**: precipitation + wind (guttering and wind susceptibility)
- **Lighting / Window light / sky color**: cloudCover + precipitation + timeOfDay + sceneDarkness mixed into a shared environment output.

Additionally, other rendering systems should consume the shared environment API:

- **Cloud colouring**: sky/ambient colour drives cloud tint at dawn/dusk and in storms.
- **Metal reflections / specular response**: specular highlights should be tinted by sky colour and reduced under heavy overcast.
- **Scene grading**: post effects (e.g. SkyColorEffect) should be driven by a stable `skyColor` + `effectiveDarkness` model.

Key constraint: Dynamic mode should not introduce per-frame allocations or heavy CPU work in the update loop.

## 12. Migration / Compatibility
- If a scene already has manual weather configured, enabling dynamic mode should:
  - Initialize latent variables from current `targetState`
  - Preserve manual `targetState` snapshot for restoring when dynamic mode is disabled
- Existing WeatherController presets remain; biome presets are separate.

Also consider migration for time-of-day:

- Global `timeOfDay` currently flows into WeatherController; dynamic weather should not create a second competing time source.

## 13. Debugging / Observability
Add non-invasive debug outputs:

- Read-only UI fields showing latent variables (temperature/humidity/storminess/windBase)
- Optional “Freeze dynamic state” button (pause evolution but keep rendering)
- Logging behind a debug flag only (avoid spam)

## 14. Milestones
### Milestone A (v1 foundation: dynamic mode + environment API)
- Add `dynamicEnabled` + latent state storage in WeatherController
- Implement `getEnvironment()` output (cached objects, no allocations)
- Add UI toggle + biome preset dropdown
- Disable manual weather controls when dynamic is enabled

### Milestone B (v1 quality: stability + persistence)
- Fixed-step evolution + seeded RNG
- Scene flag persistence (params + latent state)
- Hook Foundry darkness sampling into the environment output

### Milestone C (v2: storm regimes)
- Add event/regime system for storms/blizzards
- Integrate with gust tuning (frequency/strength) to sell weather severity

### Milestone D (v2: Foundry time integration)
- `updateWorldTime` hook integration
- Calendar-aware worldTime → timeOfDay mapping

### Milestone E (optional polish)
- Forecast UI (timeline)
- More biomes
- Better debugging overlays

## 15. Optional Features Backlog
- **Weather “fronts”**: a regime system which slowly moves between clear/overcast/storm states.
- **Thunder/Lightning**: storm events which can trigger light flashes and sounds.
- **Sandstorms / dust storms**: biome-specific precipitation-like particle modes.
- **Seasonal baselines**: biomes define seasonal curves; calendar drives baseline drift.
- **Local microclimates** (future): indoor courtyards, valleys, etc. (still scene-global at v1).
- **Auto-matching scene darkness**: optional setting to nudge Foundry’s `darknessLevel` toward the environment model (GM-only).
- **Wetness persistence**: wetness accumulates over longer periods, not just minutes.
- **Map author “allowed extremes” UI**: a simple 2D biome-space constraint editor.
- **Weather presets per-scene**: allow map creators to ship “recommended dynamic settings” as part of the scene flags.

## 16. Open Questions
- Should players be allowed to locally opt out of dynamic weather visuals, or is it strictly scene-authoritative? - ANSWER: Yes, players will always be able to tone down graphical elements. We should distinguish between effects that are gameplay related and ones that are purely decorative, players will be able to change only decorative effects.
- Do we want dynamic weather tied to Foundry “world time” / calendar seasons eventually? ANSWER: Yes please, eventually.
- Should precipitation transitions use `WeatherController.transitionTo()` (smooth) or direct target writes with smoothing inside the model? ANSWER: Not sure.
- How should dynamic mode interact with the existing `WeatherController.enabled` master kill switch? ANSWER: The master 'dynamic weather' toggle will force weather on, clouds on, etc etc.

## 17. Phased Implementation Checklist

### Phase 1: Core Dynamic Mode + Environment API (Milestone A)
#### 1.1 WeatherController scaffolding
- [ ] Add `dynamicEnabled: false` to WeatherController constructor
- [ ] Add latent variable container (`_dynamicLatent`) with defaults (temperature, humidity, storminess, windBase, windAngle)
- [ ] Add `_dynamicSimAccumulator` and `_dynamicSeed` fields
- [ ] Add stub `DynamicWeatherModel` class (or inline methods) with:
  - `initializeFromCurrentState()`
  - `step(dt)` (no-op for now)
  - `deriveOutputs()` (writes to `this.targetState`)
- [ ] Add `getEnvironment()` method returning cached `EnvironmentState` shape
  - Initialize cached `THREE.Color` for `skyColor`
  - For now, return current WeatherController values + placeholder `effectiveDarkness`

#### 1.2 Update loop integration
- [ ] In `WeatherController.update()`:
  - If `dynamicEnabled`: call `_dynamicModel.step(dt)` before existing variability/transition logic
  - Call `_updateEnvironmentOutputs()` after weather state updates
- [ ] Ensure `timeInfo.delta` is clamped to avoid huge jumps

#### 1.3 UI: toggle + preset dropdown
- [ ] In `tweakpane-manager.js`:
  - Add top-level Global folder control for `dynamicEnabled`
  - Add a "Dynamic Weather" subfolder with:
    - `presetId` dropdown (hardcoded initial biome list)
    - Evolution speed, variability sliders
    - Pause evolution toggle
    - Read-only "Now" display (text label)
- [ ] Wire callbacks to WeatherController
- [ ] Implement generic control disabling:
  - Extend `updateControlStates()` mechanism beyond specular
  - When `dynamicEnabled`, disable manual weather sliders (precipitation, cloudCover, windSpeed, windDirection, freezeLevel, fogDensity)
  - Show "Driven by Dynamic Weather" tooltip

#### 1.4 Persistence
- [ ] Add scene flag helpers:
  - `loadDynamicSettings()`
  - `saveDynamicSettings()`
- [ ] Store: enabled, presetId, parameters, seed, and current latent state
- [ ] Call `loadDynamicSettings()` on WeatherController init
- [ ] Call `saveDynamicSettings()` on scene save or when dynamic settings change

#### 1.5 Verification
- [ ] Toggle dynamic mode on/off; ensure manual controls lock/unlock
- [ ] Change preset; ensure UI reflects state
- [ ] Reload scene; ensure dynamic settings restore
- [ ] Call `weatherController.getEnvironment()` and ensure shape matches spec

---

### Phase 2: Stable Evolution + Environment Mixing (Milestone B)
#### 2.1 Constrained random walk implementation
- [ ] Implement Ornstein–Uhlenbeck style update for each latent variable
  - Use biome baselines, ranges, and time scales
  - Use seeded PRNG (`mulberry32` or similar)
- [ ] Fixed-step update:
  - Accumulate `dt` and step at 1 Hz (configurable)
  - Clamp max step size
- [ ] Derive outputs:
  - Map latent variables to `targetState` fields
  - Include precipType logic (rain/snow thresholds)
  - Update gust parameters optionally

#### 2.2 Environment mixing logic
- [ ] In `getEnvironment()`:
  - Sample `canvas.environment.darknessLevel` safely
  - Compute `dayFactor` from `timeOfDay`
  - Compute `overcastFactor` and `stormFactor`
  - Blend to `effectiveDarkness`
  - Compute `skyColor` and `skyIntensity` (simple day/night/storm lerp)
- [ ] Cache outputs; avoid allocating new objects each frame

#### 2.3 UI polish
- [ ] Populate biome preset dropdown with real data
- [ ] Add read-only debug fields for latent variables
- [ ] Add "Freeze evolution" toggle (stops stepping, keeps rendering)

#### 2.4 Verification
- [ ] Weather evolves smoothly over minutes
- [ ] No sudden jumps after tab inactivity
- [ ] Environment outputs change plausibly with time and weather
- [ ] Scene reload resumes from saved latent state

---

### Phase 3: Storm Regimes (Milestone C)
#### 3.1 Regime system
- [ ] Add simple Markov chain or event-trigger logic for regimes
- [ ] Define regime templates (clear, overcast, storm, blizzard)
- [ ] When regime changes:
  - Adjust gust parameters (frequency/strength)
  - Optionally trigger visual/audio events (future)

#### 3.2 Integration with gust system
- [ ] In `DynamicWeatherModel`, set `gustWaitMin/Max`, `gustDuration`, `gustStrength` based on regime
- [ ] Ensure wind gusts feel more intense during storms

#### 3.3 Verification
- [ ] Observe regime shifts every few minutes
- [ ] Storms increase gust frequency and strength
- [ ] UI shows current regime label

---

### Phase 4: Foundry Time Integration (Milestone D)
#### 4.1 Hook world time changes
- [ ] Register `updateWorldTime` hook
- [ ] In hook: convert `worldTime` → `timeOfDay` and push to WeatherController
- [ ] Ensure UI slider updates when world time changes

#### 4.2 Calendar awareness (optional)
- [ ] Read `game.time.calendar` if present
- [ ] Adjust baselines by season (if defined)

#### 4.3 Verification
- [ ] Changing Foundry time updates weather environment
- [ ] Dynamic mode respects world time as source of truth

---

### Phase 5: Polish & Optional Features (Milestone E)
#### 5.1 Forecast UI (optional)
- [ ] Add a simple timeline view showing next 1–2 hours of predicted weather
- [ ] Use regime probabilities to generate plausible forecast

#### 5.2 More biomes
- [ ] Add additional preset definitions
- [ ] Add icons/labels for presets

#### 5.3 Debugging overlays
- [ ] Optional on-screen debug view:
  - Latent variables
  - Environment outputs
  - Regime timer

#### 5.4 Optional features (pick from backlog)
- [ ] Thunder/lightning events
- [ ] Sandstorm particle mode
- [ ] Wetness persistence
- [ ] Author "allowed extremes" UI

---

### General Cross-cutting Tasks
- [ ] Update documentation and inline comments
- [ ] Add unit tests for environment math utilities
- [ ] Profile update loop for performance (no allocations)
- [ ] Test on low-end hardware
- [ ] Verify compatibility with existing scenes (manual weather still works)
- [ ] Write user-facing guide for enabling Dynamic Weather
