# Live Weather Overrides — Full Problem & Code Audit

**Date:** 2026-03-22  
**Scope:** The five Tweakpane controls under **Map Shine Control → Live Weather Overrides** (Rain, Clouds, Temp/Freeze, Wind, Wind Dir).  
**Status:** Persistent failure across multiple fix attempts; symptoms reportedly uniform across all five (values become **NaN** in the control; related readouts often **0** / **0.0**).

This document describes the problem in depth, maps the runtime architecture, and records **code-level findings** from a repository audit. It is a research artifact, not a fix checklist.

---

## 1. Symptom description (as reported)

- **Uniform failure mode:** Every slider in the Live Weather Overrides section fails the same way; there is no “one bad parameter.”
- **Primary UI symptom:** Numeric fields show **`NaN`** (Not a Number).
- **Secondary symptom:** Other displays in or near the panel show **0** or **0.0** (e.g. header summary like “Rain 0% · Clouds 0% · Wind 0m/s”, footer-style wind readouts).
- **Interpretation:** The user sees a **split** between (a) what Tweakpane is bound to / displaying for those five blades and (b) what other code paths think the weather is. That split is a strong hint of **multiple sources of truth** or **stale object references**, not a single typo in one parameter.

---

## 2. What these controls are supposed to do

Per `scripts/ui/weather-param-bridge.js` and `scripts/ui/control-panel-manager.js`:

- **Runtime authority** for simulation values is **`WeatherController.targetState`** (and mirrored **`currentState`**).
- **Live Weather Overrides** are meant to write into WC via **`applyWeatherManualParam`** (per-slider) or **`applyDirectedCustomPresetToWeather`** (bulk), optionally mirroring the main config Tweakpane weather folder via **`syncWeatherEffectFolderParam`** / `syncMainTweakpane`.
- The compact panel’s five sliders are documented as binding only to **`controlState.directedCustomPreset`**, *not* to `effectFolders.weather.params`, to avoid **two Tweakpane blades** mutating the same property (historically associated with sync loops and corrupted values).

So the intended data flow is:

```text
directedCustomPreset (UI) → WeatherController (target/current) → optional mirror → main Weather Tweakpane params
```

Any break in **object identity** (which `directedCustomPreset` instance the sliders read) or **initialization order** (WC vs UI vs flags) can produce “zeros in WC / status” while the bound object holds garbage, or the reverse.

---

## 3. Architecture map (files and responsibilities)

| Area | Primary files |
|------|----------------|
| Compact GM panel, preset merge, `addBinding` for the five sliders | `scripts/ui/control-panel-manager.js` (`_buildRapidWeatherOverrides`, `_wireLiveWeatherOverrideBindingsIfReady`, `_ensureDirectedCustomPreset`, `_sanitizeDirectedCustomPresetNumbers`, `destroy`) |
| WC ↔ UI bridge, hydrate/sync | `scripts/ui/weather-param-bridge.js` (`hydrateMainWeatherTweakpaneFromController`, `hydrateControlPanelLiveOverridesFromController`, `syncDirectedCustomPresetFromWeatherController`, `applyWeatherManualParam`, …) |
| Main Map Shine weather Tweakpane registration and initial callback ordering | `scripts/ui/tweakpane-manager.js` (`registerEffect` path around weather `effectId === 'weather'`) |
| Scene flag merge into `controlPanel.controlState`, reconcile preset | `scripts/foundry/canvas-replacement.js` (`updateScene` handler for `controlState`) |
| Weather simulation state | `scripts/core/WeatherController.js` |

---

## 4. Initialization and ordering (audit findings)

### 4.1 Control panel `initialize()` sequence

From `ControlPanelManager.initialize` (`control-panel-manager.js`):

1. Wait for global **`Tweakpane`**.
2. **`_loadControlState()`** — shallow **`Object.assign(this.controlState, saved)`** when scene flags contain `controlState`. This **replaces** nested objects such as **`directedCustomPreset`** with **new object references** from JSON.
3. **`_buildPhaseALayout()`** — creates the Live Weather Overrides folder and calls **`_wireLiveWeatherOverrideBindingsIfReady()`** once (`_rapidWeatherBindingsWired` guard).
4. **`_applyControlState()`** — applies time/weather via `stateApplier`; **does not** continuously re-apply full `directedCustomPreset` on every call (by design, to avoid clock ticks clobbering WC).

**Finding:** Any code that replaces `controlState.directedCustomPreset` **after** bindings are created must go through **`_ensureDirectedCustomPreset()`** (or equivalent) so the **Tweakpane binding target** remains the same object the blades were constructed with. Otherwise sliders observe **stale** state while saves/applies read the **new** nested object from flags.

### 4.2 Weather effect registration vs control panel

In **`canvas-replacement.js`** (full canvas path), a comment states weather should register **before** the GM control panel so shared UI state exists early. The block calls **`uiManager.registerEffect('weather', …)`** with a guard **`if (uiManager.effectFolders?.weather) return`** to avoid double registration.

In **`tweakpane-manager.js`**, when `effectId === 'weather'`:

1. **`hydrateMainWeatherTweakpaneFromController`** runs **before** the initial per-parameter callback loop (so schema defaults do not wipe WC).
2. After that loop: **`hydrateControlPanelLiveOverridesFromController`**, then **`controlPanel._wireLiveWeatherOverrideBindingsIfReady()`**.

**Finding:** **`_wireLiveWeatherOverrideBindingsIfReady` is idempotent.** If the control panel already ran `_buildPhaseALayout` and set **`_rapidWeatherBindingsWired = true`**, the call from `tweakpane-manager` **returns immediately** and does **not** re-bind. Hydration still runs and may **`refresh`** existing bindings—so the **first** wire’s choice of **`preset` reference** is definitive for the session.

### 4.3 UI-only mode

When Map Shine is **not** enabled on the scene, **`canvas-replacement.js`** still initializes **`TweakpaneManager`** and **`ControlPanelManager`** (“UI-only mode”).

**Finding:** In that mode, **`WeatherController`** may be absent, uninitialized, or not wired the same way as full canvas init. **`hydrateControlPanelLiveOverridesFromController`** and **`syncDirectedCustomPresetFromWeatherController`** early-out if WC or `targetState` is missing, but the **five bindings still exist** and read **`directedCustomPreset`**. Repro scenarios should record whether the problem happens **only** in full-canvas mode, **only** UI-only, or both.

---

## 5. Scene flag sync (`updateScene`) — stale binding risk

In **`canvas-replacement.js`**, when scene flags update **`controlState`**:

- **`Object.assign(cp.controlState, cs)`** runs.
- A comment documents that shallow assign **replaces `directedCustomPreset`** with a **new object** from the network/flags.
- Mitigation in code: **`cp._ensureDirectedCustomPreset()`** to merge back into the stable target.
- Then **`cp.pane?.refresh()`** is invoked on the **entire** compact pane.

**Findings:**

1. **`_ensureDirectedCustomPreset`** merges flag data into **`_rapidWeatherBindingTarget`** when set, then assigns **`controlState.directedCustomPreset = target`**. This is the correct pattern **if** `_rapidWeatherBindingTarget` was established at wire time and never cleared unexpectedly.
2. **Full `pane.refresh()`** re-reads **all** bindings on that pane, not only the five weather blades. Historically, broad refresh has been associated with **re-entrancy** and **`change`** storms; Live overrides specifically try to use **per-binding `refresh()`** in `syncDirectedCustomPresetFromWeatherController` when possible. **`updateScene` still does a full refresh** after flag merge—this is a **candidate** for hard-to-reproduce glitches if any blade’s `change` handler writes non-finite values during refresh.

---

## 6. Tweakpane 4.0.3 behavior (vendor audit)

Bundled library: **`scripts/vendor/tweakpane.js`** (header: Tweakpane **4.0.3**).

### 6.1 Number input plugin accepts `NaN`

`NumberInputPlugin.accept`:

- Returns a controller only if **`typeof value === 'number'`**.
- In JavaScript, **`typeof NaN === 'number'`**.

**Finding:** If the bound property is ever **`NaN`**, Tweakpane will still treat it as a valid numeric binding and the UI can literally display **“NaN”**. This is **not** a Map Shine bug per se, but it means **any** upstream `NaN` (wind math, corrupted state, bad refresh) surfaces visibly and **survives** until the underlying object is corrected and the blade is refreshed.

### 6.2 Plugin order and non-number initial values

`createDefaultPluginPool` registers **input** plugins in this order (excerpt): **Point2d, Point3d, Point4d, String, Number, …, Boolean, …**

**Finding:** If **`directedCustomPreset.precipitation`** (etc.) were ever a **string** at **`addBinding`** time, **`StringInputPlugin`** would match **before** **`NumberInputPlugin`**. That would create the **wrong blade type** (text / list), not a slider—worth checking in DevTools if the DOM/classes match `tp-sldv` vs `tp-txtv`. Reported screenshots describe slider-like rows; if the class names differ, that would indicate **wrong plugin selection** from bad initial types.

### 6.3 `createBinding` and `undefined`

`PluginPool.createBinding` throws if **`target.read()`** is **`null` or `undefined`** (`isEmpty`). **The number `0` is not empty.**

**Finding:** Initial **zero** is valid. **Missing properties** at bind time would throw during layout—unlikely if the user sees five rows at all, unless errors are swallowed elsewhere.

---

## 7. Why “all five” and “zeros elsewhere” can coexist

### 7.1 Status strip vs sliders

`_updateStatusPanel` / `_formatWeatherLine` in **`control-panel-manager.js`** format the header line from **`WeatherController.getCurrentState()` / `currentState`**, **not** from `directedCustomPreset`.

**Finding:** It is **expected** that the header can show **Rain 0% · Clouds 0% · Wind 0m/s** when WC’s state is actually zero-like, **while** the five Tweakpane blades show **`NaN`** if they are bound to a **different object** or their internal controller has **desynchronized** from WC. This is **not** proof that WC is “right” and sliders “wrong,” or the opposite—it proves **two read paths** are diverging.

### 7.2 Single merge bug affects all five keys

`_ensureDirectedCustomPreset` writes **all** scalar keys on the **same** `target` object. If that object is wrong, **all** bindings (same object, five keys) skew together—matching “every slider breaks the same way.”

### 7.3 `syncDirectedCustomPresetFromWeatherController` writes all five

After mirroring WC into `preset`, the code refreshes **each** of **`LIVE_WEATHER_OVERRIDE_PARAM_IDS`**. A bad **`refresh()`** sequence or a shared broken internal state in Tweakpane could theoretically affect **all** numeric blades on that pane—not yet proven; listed as hypothesis.

---

## 8. Contradictory / stale documentation in repo

In **`canvas-replacement.js`** (~5370), a comment claims Live Weather Overrides use the same **`effectFolders.weather.params`** object as the main Weather folder.

**Actual implementation** in **`control-panel-manager.js`** explicitly binds the five sliders to **`directedCustomPreset`** only and comments that **sharing** `weather.params` caused **NaN** and loops.

**Finding:** Onboarding and future refactors may reintroduce **shared bindings** if maintainers trust the **`canvas-replacement`** comment over **`control-panel-manager`**. The audit recommends **aligning comments** with code to reduce regression risk.

---

## 9. Hypotheses ranked (for targeted investigation)

These are **not** confirmed root causes; they are where the code and symptoms point next.

1. **Stale `directedCustomPreset` reference** after `Object.assign` / flag sync without a successful `_ensureDirectedCustomPreset` merge (or with `_rapidWeatherBindingTarget` cleared or wrong). *Explains uniform NaN/stale reads on all five.*
2. **Full `pane.refresh()`** after `updateScene` re-entering `change` handlers and writing **non-finite** values into the preset or WC. *Explains intermittent NaN after multiplayer / flag echo.*
3. **`hydrate` / `sync` ordering** vs **`WeatherController.targetState`** not ready (partial init, UI-only, or race). *Mirrors zeros into preset then refresh amplifies bad state.*
4. **Wrong Tweakpane plugin** for initial value types (string in JSON). *Would usually look like non-slider controls; verify DOM.*
5. **Foundry or module serialization** storing **non-numeric** or **unexpected** shapes under `controlState.directedCustomPreset` that survive `JSON.parse` but break assumptions after refresh.

---

## 10. Recommended next research steps (no code changes required)

1. **Browser DevTools on a broken session**
   - In console: `MapShine.controlPanel.controlState.directedCustomPreset` and `MapShine.controlPanel._rapidWeatherBindingTarget` — **strict equality** `===` should be **true** after a good init.
   - Log **each key** (`precipitation`, `cloudCover`, `freezeLevel`, `windSpeed`, `windDirection`) with **`Number.isFinite`**.
2. **DOM inspection** of the five rows: confirm classes (`tp-sldv` vs `tp-nmbv` vs `tp-txtv` vs `tp-ckbv`) match **numeric slider** expectations.
3. **Repro matrix**
   - Full canvas enabled vs UI-only.
   - Fresh scene vs scene with persisted `controlState` flag.
   - Single client vs two GMs / flag echo (`updateScene` path).
4. **Temporary instrumentation** (when development resumes): one log line in `_ensureDirectedCustomPreset`, `_wireLiveWeatherOverrideBindingsIfReady`, `syncDirectedCustomPresetFromWeatherController`, and the `updateScene` `controlState` branch with **object ids** (e.g. `preset` reference) and **flag revision**.

---

## 11. Related code references (for navigation)

- Live overrides wiring: `scripts/ui/control-panel-manager.js` — `_wireLiveWeatherOverrideBindingsIfReady`, `_ensureDirectedCustomPreset`, `_sanitizeDirectedCustomPresetNumbers`, `destroy` (resets wiring flags).
- WC mirror: `scripts/ui/weather-param-bridge.js` — `hydrateControlPanelLiveOverridesFromController`, `syncDirectedCustomPresetFromWeatherController`.
- Weather registration order: `scripts/ui/tweakpane-manager.js` — weather branch in `registerEffect`.
- Flag assign + pane refresh: `scripts/foundry/canvas-replacement.js` — `updateScene` / `controlState` / `_ensureDirectedCustomPreset` / `pane.refresh`.
- Tweakpane numeric acceptance: `scripts/vendor/tweakpane.js` — `NumberInputPlugin.accept`, `PluginPool.createBinding`.

---

## 12. Summary

The Live Weather Overrides are **not** “just sliders”: they sit at the intersection of **scene-persisted control state**, a **stable binding target** meant to survive reference swaps, **WeatherController** as runtime authority, **a second Tweakpane surface** (main weather folder), and **Foundry scene flag updates**. The reported **uniform NaN on all five** plus **zero-like summaries elsewhere** matches **systemic desynchronization** (object identity, refresh ordering, or numeric corruption) more than a single mis-typed parameter. The bundled **Tweakpane 4** behavior **explicitly allows `NaN`** as a “valid” number binding, which makes any upstream corruption highly visible.

Further progress depends on **runtime evidence** (reference equality, finite checks, DOM blade types, repro matrix) rather than incremental clamp tweaks alone.
