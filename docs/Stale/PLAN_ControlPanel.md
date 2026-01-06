# PLAN: GM Control Panel (Time of Day + Weather)

## 1. Goal
Create a **new, primary GM-facing “Control Panel”** (Tweakpane-based) optimized for **live play**.

This panel must:
- Prioritize **speed** and **clarity** over completeness.
- Provide **high-impact, low-complexity** controls.
- Keep the most-used controls at the top (Time of Day, Weather), with rarely-used controls lower.
- Drive **authoritative, scene-wide changes** (GM actions propagate to all connected clients).

This panel is distinct from the existing Tweakpane UI, which will become the **Configuration Panel** (authoring + tuning). The two panels must not duplicate controls.

## 2. Non-Goals (v1)
- Exposing per-effect deep tuning knobs (rain streak length, shader micro params, etc.) in the Control Panel.
- Replacing Foundry’s own time/calendar system in v1.
- Building the full event system in v1 (but we must reserve space/architecture for it).

## 3. Current State (Code Reality)
### 3.1 Existing UI
- `scripts/ui/tweakpane-manager.js` creates the current Tweakpane panel (`#map-shine-ui`).
- It currently includes **Global Controls**, including `timeOfDay`, and forwards time-of-day to:
  - `weatherController.setTime(value)`
  - `canvas.scene.update({ darkness: targetDarkness })` (derived from time-of-day)

### 3.2 Weather UI
- `scripts/core/WeatherController.js` already supports:
  - `timeOfDay`
  - `dynamicEnabled` + biome preset + evolution speed + pause
  - A “GM Transition” queue concept (`queued*`, `queueFromCurrent`, `startQueuedTransition`)
  - Manual target state sliders and many advanced simulation/render parameters
- `scripts/foundry/canvas-replacement.js` registers WeatherController into the current UI as the `weather` effect (“Weather System”).

### 3.3 Left Palette Button
- `scripts/module.js` injects a single scene control tool `map-shine-ui` into the Foundry scene controls (currently under `tokens`).

## 4. Product Direction: Two Panels
We will explicitly split into:

### 4.1 Configuration Panel (existing, refocused)
**Purpose:** map authoring + GM tuning + debug.

**Keeps:**
- Per-effect advanced controls (specular, cloud, rain/snow appearance, distortion tuning, etc.).
- “Map Maker mode” / authoring workflows.
- Texture tools / diagnostics.

**Removes / avoids:**
- Live-play controls that are also present in the Control Panel (especially Time of Day + Weather state selection).

### 4.2 Control Panel (new)
**Purpose:** compact live-play controls.

**Contains (v1):**
- Time of Day clock control (primary)
- Weather mode + quick weather selection / transitions (primary)

**Reserved (future):**
- Event triggers (one-shot and scheduled)
- Player-facing screen-space “moments” (flash, vignette, camera shake, etc.)

## 5. UX Plan (Control Panel)
### 5.1 Layout Principles
- **One screen** at common resolutions: avoid long scrolling.
- **Large hit targets** (buttons) where speed matters.
- **Minimal labels**; rely on grouping + consistent ordering.
- **Default collapsed** for advanced/rare sections.

### 5.2 Section Order (Top → Bottom)
1. **Time of Day**
2. **Weather**
3. **Events (Reserved / Disabled in v1)**
4. **Player FX (Reserved / Disabled in v1)**
5. **Utilities** (small: “reset”, “copy current weather”, etc.)

### 5.3 Time of Day (Clock)
**Requirement:** use a clock UI to select time-of-day.

#### Controls
- **Analog clock (primary input)**
  - Dragging the hand sets `timeOfDay` (0–24).
  - Display: `HH:MM` readout.
- **Quick buttons** (single click):
  - Dawn, Noon, Dusk, Midnight
- **Transition (optional in v1, likely v1.1)**
  - “Transition Minutes” + “Apply” to animate time-of-day change over a period.

#### Implementation approach (Tweakpane)
We likely need a small custom view embedded in Tweakpane:
- Option A: a lightweight custom HTML element inserted into the pane/folder.
- Option B: a formal Tweakpane plugin blade.

We already have an asset candidate: `assets/clock-face.webp`.

### 5.4 Weather (Two Modes)
The Control Panel will present weather as a **mode switch** with concise controls.

#### Mode A: Dynamic Weather
- Toggle: **Dynamic: ON/OFF**
- Biome preset dropdown (existing list)
- Evolution speed slider
- Pause toggle
- Optional: “Clamp to bounds” (GM-only), but consider leaving bounds editing to Configuration Panel.

#### Mode B: Directed Weather (GM chooses next state)
Directed weather is a GM workflow:
- Select “next weather” (likely via **named presets**) and set a **transition duration**.
- Press **Apply/Start Transition**.

Proposed controls:
- Preset dropdown: `Clear`, `Overcast`, `Rain`, `Thunderstorm`, `Snow`, `Blizzard`, etc.
- Slider: “Transition (min)” (maps to existing `presetTransitionDurationMinutes` or `transitionDuration` depending on final design)
- Buttons:
  - “Queue From Current”
  - “Start Transition”
  - Optional “Snap Now” (duration = 0)

We already have the underlying wiring concept in WeatherController’s schema: `queued*` + `startQueuedTransition`.

## 6. Knock-on Effects (Time + Weather)
Time-of-day and weather changes must be treated as **high-level environment inputs** that ripple into dependent systems.

### 6.1 Time of Day must drive
- `WeatherController.timeOfDay`
- Foundry scene darkness (`canvas.scene.darkness`) via a defined mapping
- Effects that read `weatherController.timeOfDay`:
  - `OverheadShadowsEffect`
  - `LightingEffect` (sun dir fallback)
  - `SkyColorEffect`
  - `TreeEffect` (wind + time-of-day response)
  - `CloudEffect` (time-of-day tint)

### 6.2 Centralization Requirement
Today, time-of-day logic is partly in `TweakpaneManager.onGlobalChange()`.

For this split to be maintainable:
- Introduce a **single “apply environment” API** (likely on WeatherController or a new EnvironmentController) so:
  - Control Panel calls one method
  - Configuration Panel does not duplicate logic
  - The rest of the pipeline has one source of truth

## 7. Persistence + Networking Model (Authoritative GM)
Control Panel changes must propagate to all clients.

### 7.1 Do NOT store live-play state inside authoring settings
The existing three-tier settings system (`scene flags: mapMaker/gm + player client overrides`) is optimized for configuration, not for runtime.

### 7.2 Proposed new scene flag for runtime control
Add a new scene flag namespace block, separate from `settings`:
- `scene.flags['map-shine-advanced'].controlState`

Example (draft):
- `timeOfDay`
- `timeOfDayTransition` (optional)
- `weatherMode`: `dynamic` | `directed`
- `directedPresetId`
- `directedTransitionMinutes`
- `dynamicEnabled`, `dynamicPresetId`, `dynamicEvolutionSpeed`, `dynamicPaused`

### 7.3 Client sync mechanism
- GM updates `controlState` via `canvas.scene.setFlag(...)`.
- All clients respond via `Hooks.on('updateScene', ...)` and apply changes to WeatherController / environment outputs.

This avoids one-shot event replay problems for v1 (events are reserved for future).

## 8. Left Palette Integration (Two Buttons)
We need to differentiate:
- **Configuration Panel** (existing TweakpaneManager)
- **Control Panel** (new)

### 8.1 Proposed Scene Controls tools
In `scripts/module.js` (hook: `getSceneControlButtons`):
- Add `map-shine-config` tool:
  - Title: “Map Shine Config”
  - Opens Configuration Panel
- Add `map-shine-control` tool:
  - Title: “Map Shine Control”
  - Opens Control Panel

### 8.2 Visibility
- Control Panel: GM-only.
- Configuration Panel: GM-only (and potentially Map Maker role later), but avoid exposing to players by default.

## 9. Implementation Plan (Milestones)
### Milestone A: Planning + Architectural Split
- Define `ControlPanelManager` (new) vs `TweakpaneManager` (existing) responsibilities.
- Decide where the authoritative runtime `controlState` lives and how it maps to WeatherController.

### Milestone B: Control Panel v1 (Time of Day)
- Implement clock UI + quick time buttons.
- Implement authoritative persistence + sync (`controlState.timeOfDay`).
- Centralize time-of-day application so it updates:
  - WeatherController
  - Scene darkness

### Milestone C: Control Panel v1 (Weather)
- Add mode switch: Dynamic vs Directed.
- Dynamic controls (toggle, preset, speed, pause).
- Directed preset selection + transition duration + apply.
- Ensure UI disables irrelevant controls depending on mode.

### Milestone D: Scene Controls (Two Buttons) + Config Panel Cleanup
- Add new left palette button(s).
- Remove duplicated live-play controls from Configuration Panel.

## 10. Acceptance Criteria (v1)
- GM can open Control Panel from left palette and change time-of-day via a clock.
- Time-of-day change reliably updates dependent effects (shadows/sky) and scene darkness.
- GM can select dynamic weather OR directed transitions, and changes propagate to all clients.
- Configuration Panel no longer contains the same “live play” controls, avoiding confusion.

## 11. Open Questions
- Time-of-day → darkness mapping: keep current mapping or formalize a curve/profile?
- Should directed weather be preset-only (simple) or allow a compact “intensity” slider (precip/cloud/wind) too?
- Do we want Control Panel actions to persist across reloads as “campaign state” (likely yes), or reset per session?
- Should players be allowed a local “visual intensity” reduction separate from GM’s authoritative weather state? (Likely yes, via existing player override concepts.)
- Best Tweakpane approach for the clock: custom DOM vs plugin blade.
