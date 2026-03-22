# Scene A: grey on cold load, fixed by scene round-trip, broken again by time change

**Date:** 2026-03-21  
**Status:** Open — Layered mitigations for cold viewport + `updateScene` echo; user still saw grey after reload / time (2026-03-21); **re-test** after write-guard + `options.userId` + weather snapshot echo skip  
**Module context:** Map Shine Advanced (Foundry VTT V12)

---

## Code investigation findings (2026-03-21)

Static review of the current tree (no Foundry session run in this pass). These items narrow where to instrument or bisect next.

### A. Init / ordering (cold load vs revisit)

- **Viewport fallback (2026-03-21):** `_resolveInitialViewportCssPixels` avoids initializing WebGL / `SceneComposer` at **0×0** when `#map-shine-canvas` is not laid out yet; **ResizeHandler** is registered **before** `RenderLoop.start()` with a sync `resize()` when possible. See **Hypothesis A — deep dive** in this doc.
- **`onCanvasReady`** (`scripts/foundry/canvas-replacement.js`) can block on bootstrap: if `canvasReady` fires before `MapShine.initialized`, it polls up to **15s** (100ms interval) before calling `createThreeCanvas`. A **second** scene activation later in the session usually skips that wait because the global is already initialized — timing relative to PIXI stage, `canvas.ready`, and mask preload can differ from the **first** scene.
- **`MapShine.__msaSceneLoading`** is set `true` at the start of `createThreeCanvas` and cleared in a **`finally`** block (including after errors), so it is a reliable “load in progress” signal for diagnostics, not a stuck flag.
- **Concurrent `createThreeCanvas`:** a second call while the first is running is **dropped** with a warning (`_createThreeCanvasRunning`). If two legitimate triggers race (e.g. recovery + hook), one path never runs — worth logging if grey correlates with that warning.
- **V2 load pipeline** (same file, late in `createThreeCanvas`): awaits `prewarmForLoading({ awaitPopulate: true })`, mask preload, optional multi-floor step prewarm, then `warmupAsync` and **`openShaderGate()`**. If `warmupAsync` **times out**, code still opens the gate and fades the overlay; shaders may compile lazily on first frames (possible hitching or incomplete first paint, depending on GPU).
- **`FloorCompositor.render`**: if populate never completed, it kicks `_ensureBusPopulated({ source: 'render' })` without awaiting — first frames could theoretically run with an incomplete bus (mitigated by loading-time await when the main path succeeds).

### B. Persisted scene state / `updateScene`

- **Local echo fix (layered 2026-03-21):** (1) **`userId`** from the 4th hook arg **or** `options.userId` / `options.user` (`_resolveUpdateSceneUserId`). (2) **`extendMsaLocalFlagWriteGuard()`** (`scripts/utils/msa-local-flag-guard.js`) — set immediately before **every** `setFlag` for `controlState` / `weather-snapshot` from Control Panel, **StateApplier** (time + weather saves), and **WeatherController** snapshot save; while the guard window is active, **GMs** skip authoritative `updateScene` resync when the diff is **only** `controlState` and/or `weather-snapshot`. (3) **WeatherController** returns early from `_loadWeatherSnapshotFromScene` when `stored.updatedAt` matches `_lastLocalWeatherSnapshotUpdatedAt` from the last local save (belt-and-suspenders if the hook still runs). Without this, echoed updates re-ran `applyTimeOfDay` and full snapshot reload, stacking `canvas.scene.update` / darkness and breaking V2 (grey).
- **Levels snapshot (2026-03-21):** `LevelsSnapshotStore` no longer calls `invalidate()` when `changes.flags` contains **only** the `map-shine-advanced` key (control UI / weather saves). That snapshot drives floor/levels consumers; invalidating it on every Map Shine flag write was unnecessary and could contribute to desync.
- **`onUpdateScene`** (for **other** clients / when user id differs) still re-reads `controlState` from flags when present: it applies **time** via `stateApplier` and, for **dynamic** mode only, pushes dynamic fields into `weatherController`. It **`Object.assign`s** the full flag payload into `controlPanel.controlState` and refreshes the pane. It does **not** call `_applyRapidWeatherOverrides` or `applyDirectedCustomPresetToWeather` for **directed / Custom** scalars in that hook — directed runtime values still depend on **`weather-snapshot`** (or local UI apply). Flag ordering on the wire still matters for **players** receiving GM updates.
- **Full Map Shine reinit** from `onUpdateScene` runs only when `changes` includes dimension/background-type keys or **grid geometry** (`type` / `size` / `distance`). Updates to **`environment.darknessLevel`** (from `StateApplier._updateSceneDarkness`) are **not** in that list, so darkness writes should **not** trigger `createThreeCanvas` by themselves.

### C. Fingerprint gate (time vs “live five” overrides)

- **Confirmed:** `_weatherControlFingerprint()` explicitly builds a payload from weather/directed/dynamic fields and **excludes** time-of-day (`scripts/ui/control-panel-manager.js`).
- **`_applyControlState`** applies time, then `applyWeatherState`, then calls `_applyRapidWeatherOverrides` only when `weatherMode === 'directed'`, `directedPresetId === 'Custom'`, and the fingerprint **changed** — with an inline comment that time-only updates must not re-run rapid apply.
- **`applyDirectedCustomPresetToWeather`** is **only** referenced from `control-panel-manager.js` in `scripts/` (definition in `weather-param-bridge.js`). No other module callers in-tree.

### D. Time / darkness / async cadence

- **`startTimeOfDayTransition`** uses **`setInterval(..., 100)`** — each tick calls `applyTimeOfDay(hour, false, true)` until completion; the final tick persists with `saveToScene` as passed. This matches a **~10 Hz** burst of time + darkness scheduling while a transition runs.
- **`_updateSceneDarkness`** (GM-only: returns immediately if `!game.user.isGM`) debounces writes with **`setTimeout(..., 100)`** and can chain another flush if updates arrive while `canvas.scene.update` is in flight. **Non-GMs never hit** `canvas.scene.update` for darkness from this path — useful when interpreting **player vs GM** repros.
- **Shipped:** Control panel, `onUpdateScene` controlState sync, and weather-snapshot restore use **`applyDarkness` / `applyFoundryDarkness: false`** for live/stacked paths; GM darkness is consolidated via **`syncFoundryDarknessFromMapShineTime()`** where needed (after `_saveControlState`, after snapshot time apply).

### Open questions — partial answers from code

| Question | Code-level note |
|----------|-----------------|
| Transition minutes > 0 required? | **Instant** time applies once per target change; **transition** adds 100ms interval traffic and a different save pattern on the final frame. Either path stresses darkness debounce; not mutually exclusive. |
| GM vs players? | Darkness updates from `StateApplier` are **GM-only**. Time still flows to `WeatherController.setTime` for whoever runs the control path; flag replication affects clients via `updateScene`. |
| Whole canvas vs Map Shine only? | Not determined from code; `canvas.scene.update({ environment })` is Foundry-wide for that document update. |

---

## Latest observations (2026-03-21)

| Step | Result |
|------|--------|
| **F5 / fresh reload** | Grey canvas (cold load still failing for this user after earlier viewport work). |
| **Scene Reset** (`Map Shine` → Scene Reset → `resetScene` → full `createThreeCanvas` on **same** scene) | Scene looks correct (full Three.js rebuild). |
| **Change time** | Grey again. |

**UI distinction (do not confuse):**

- **Scene Reset** — `window.MapShine.resetScene()` → `createThreeCanvas` on the **current** scene document; same flags, full GPU/teardown path like switching scenes.
- **Attempt Scene Recovery** — `attemptSceneRecovery()` creates a **new** scene, copies geometry/placeables, **strips** `flags['map-shine-advanced']` / `map-shine` so Map Shine starts from a **clean flag surface** (then user re-enables Map Shine). That is a different hypothesis (corrupt or pathological **persisted** MSA payload vs **transient** init).

---

## Working theories (ranked for investigation)

These are **compatible**; more than one may contribute.

### 1. `updateScene` double-apply (time / weather flags)

**Idea:** Moving time persists `controlState` and debounced **`weather-snapshot`**. Foundry fires **`updateScene`** on the authoring client. Re-applying from flags runs **`applyTimeOfDay`** again and **`_loadWeatherSnapshotFromScene`** (which can call **`applyTimeOfDay` again**). That stacks **`canvas.scene.update({ environment.darknessLevel })`** and Foundry-side refresh with Map Shine’s render loop.

**Why Scene Reset helps:** Full `createThreeCanvas` replaces WebGL + compositor state; you get a clean first frame even if Foundry’s environment document is noisy afterward — until the **next** flag write from the time UI retriggers the echo path.

**Mitigation in tree:** userId + options userId, time-windowed write guard, snapshot `updatedAt` echo skip, Levels invalidation narrowed (see §B).

### 2. `StateApplier` saves bypassed the first echo skip

**Idea:** `applyTimeOfDay(..., saveToScene: true)` and `applyWeatherState(..., saveToScene: true)` call **`scene.setFlag('controlState', …)` directly** in `state-applier.js`, not only via Control Panel `debouncedSave`. Any fix that only wrapped the panel never armed a guard for those writes.

**Mitigation:** `extendMsaLocalFlagWriteGuard()` before both `setFlag` sites in `state-applier.js`.

### 3. Hook arity / missing `userId`

**Idea:** If a wrapper or version passes **`updateScene(scene, changes)`** without the 4th argument, **`userId` is `undefined`** and the original “skip if local author” branch never fires. **`options.userId`** is documented on `updateDocument` and is now checked as a fallback.

### 4. Cold reload grey — viewport vs flags vs ordering

**Idea A — layout:** `#map-shine-canvas` still **0×0** at attach on some setups (fallback to `#board` / window should log a warning if used).

**Idea B — persisted flags:** `controlState` / `weather-snapshot` / `settings` may encode a combination that **first init** mishandles (e.g. transition minutes + darkness), while **second init** after reset has warmer caches or different ordering.

**Idea C — bootstrap vs lazy renderer:** First world load uses **`ready`** bootstrap; after teardown, **lazy bootstrap** (`skipSceneInit: true`) — different internal state (usually OK but worth logging).

### 5. Foundry darkness / environment refresh (**mitigation shipped 2026-03-21**)

**Idea:** Map Shine’s clock drives **`StateApplier._updateSceneDarkness`** → debounced **`canvas.scene.update({ 'environment.darknessLevel' })`**. That runs **on every instant `applyTimeOfDay`** from the control panel and **every 100 ms** during **`startTimeOfDayTransition`**, even when **Foundry world time is not linked**. Repeated Foundry scene document updates can destabilize the canvas / V2 pipeline (grey screen) independent of the `updateScene` flag-echo issue.

**Mitigation:** From **`ControlPanelManager._applyControlState`**, call **`applyTimeOfDay(..., saveToScene, false)`** and **`startTimeOfDayTransition(..., saveToScene, false)`** (third/fourth args) so live UI **does not** touch Foundry darkness. After **`_saveControlState`** (debounced), call **`stateApplier.syncFoundryDarknessFromMapShineTime()`** once so GMs still get darkness aligned to Map Shine time without hammering updates.

**Bisect (if grey persists):** confirm whether grey still correlates with **`syncFoundryDarknessFromMapShineTime`** (single write after save) vs other paths.

### 6. “Attempt Scene Recovery” vs “Scene Reset”

If the user actually used **Recovery** (new scene, **no** MSA flags), a good scene proves **document-level MSA data** may be implicated. **Scene Reset** on the **same** document proves **transient GPU/pipeline** state can be healed without changing flags.

---

## Purpose

Capture a **high-signal repro** that separates:

1. **Cold-start / first scene** failure (grey, does not render),
2. **Recovery** after navigating away and back,
3. **Regression** triggered specifically by **time-of-day** changes,

and to drive targeted code inspection (control panel, `StateApplier`, `WeatherController`, compositor init order, scene flags).

---

## Reproduction (observed)

| Step | Scene | Result |
|------|--------|--------|
| 1 | Start Foundry; **Scene A** loads first (or is active on load) | **Grey** — fails to render correctly |
| 2 | Switch to **Scene B** | (expected: B renders) |
| 3 | Switch back to **Scene A** | **Scene A renders correctly** (“fixed”) |
| 4 | On **Scene A**, change **time of day** (Map Shine Control / linked systems) | **Scene A breaks** again (grey / broken render) |
| 5 | Reload / restart | Problem **persists** for Scene A (per prior reports — confirm during investigation) |

**Secondary timing note (from earlier discussion):** breakdown may appear after **a few frames** of time changing, not only on the first instant — suggests **async** work (timers, debounced saves, transitions, GL passes, or `await` chains).

---

## What this pattern suggests (working hypotheses)

### A. Init / ordering (cold load vs revisit)

**Scene B → Scene A** forces a **second** Map Shine canvas / compositor / bridge initialization path for Scene A that **does not** match the **first** activation on cold boot.

- Possible causes: race with Foundry `canvasReady`, `createThreeCanvas`, `FloorCompositor` bus population, shader warmup gate, `WeatherController.initialize()`, PIXI ↔ Three bridge, or `activeLevelContext` / floor stack not ready on first paint.
- **Grey** often reads as **clear color only** (nothing drawn) or **stuck RT state** — keep WebGL clear-color / render-target restore on the checklist.

**Investigate:** diff code paths for **first scene after ready** vs **scene change** (`canvas-replacement.js`, hooks on `canvasReady` / scene activation, `MapShine.__msaSceneLoading`).

See **Hypothesis A — deep dive** below for a concrete cold vs round-trip diff and the **0×0 viewport** failure mode.

### B. Persisted scene state (Scene A only)

Scene A may carry **flags** (`map-shine-advanced` `controlState`, `weather-snapshot`, settings) that are **valid enough** after a **full re-init** (round-trip) but are **applied** or **saved** in a bad combination when **time** updates.

- Time changes run `StateApplier.applyTimeOfDay` → `WeatherController.setTime`, optional Foundry world time sync, **`_updateSceneDarkness`** → `canvas.scene.update({ environment.darknessLevel })`, then **`applyWeatherState`** from `ControlPanelManager._applyControlState`, plus debounced `setFlag('controlState', …)`.
- Any bug that **writes zeros or invalid weather** into flags on time tweak would explain **“fixed until time moves”** if round-trip **re-reads** flags once correctly but a **later save** corrupts them — **verify after step 4** what Scene A flags contain vs after step 3.

**Investigate:** export `scene.getFlag('map-shine-advanced', 'controlState')` and any weather snapshot **before** time change, **after** time change, and compare to Scene B / a clean scene.

### C. Map Shine Control — Live Weather Overrides / directed Custom

The **top five** sliders (rain, clouds, freeze, wind, wind dir) funnel through `_applyRapidWeatherOverrides` → `applyDirectedCustomPresetToWeather`, which also **forces** `weatherMode = 'directed'`, `directedPresetId = 'Custom'`, **dynamic off**.

- A **fingerprint gate** was added so **time-only** updates do not re-apply `directedCustomPreset` every tick (avoids clobbering wind / snapshot with stale UI).
- **If** an old build runs without the gate, or another path still re-applies rapid overrides, time drags would **overwrite** runtime weather and persisted snapshot — consistent with **secondary** grey / wrong lighting if shaders depend on those values.

**Investigate:** confirm deployed code includes fingerprint gating; grep for other callers of `_applyRapidWeatherOverrides` / `applyDirectedCustomPresetToWeather`.

### D. Foundry darkness / `updateScene` interaction

Changing time triggers **debounced** scene darkness updates (`state-applier.js` ~100 ms timer). That can cascade **Foundry** lighting and canvas updates **in parallel** with Map Shine’s render loop.

- **Weak** direct link to the five sliders; **strong** correlation with the **same user action** (time UI).
- Could expose ordering bugs (PIXI vs Three, visibility, dimensions).

**Investigate:** temporary test build with **`applyDarkness: false`** on `applyTimeOfDay` (GM only) to see if grey disappears — isolate Foundry side vs Map Shine side.

---

## Hypothesis A — deep dive: cold load vs scene round-trip

Same document, same flags, **different lifecycle** — so the bug is almost certainly **order / dimensions / GPU lifecycle**, not “Scene A data is permanently invalid.”

### What “grey” is in this codebase

In `createThreeCanvas`, after the Three canvas is attached, the DOM element gets **`backgroundColor` from `scene.backgroundColor`**, with fallback **`#999999`** (`scripts/foundry/canvas-replacement.js`). The WebGL clear path is forced to **opaque black** so the GL buffer is not accidentally fully transparent. So a **flat medium grey** often means either:

1. You are mostly seeing the **CSS background** on `#map-shine-canvas` (scene tint) while **nothing useful is being drawn** in GL, or  
2. The GL path is clearing but **albedo / compositor output** never lands (camera size 0, wrong RT, etc.).

That matches “grey” more than “black empty GL.”

### Cold boot (Scene A first) vs return visit (B → A)

| Factor | First MSA scene after page / world load | After `canvasTearDown` + second `createThreeCanvas` |
|--------|----------------------------------------|-----------------------------------------------------|
| **`onCanvasReady` vs `ready`** | May **poll up to 15s** waiting for `MapShine.initialized` if `canvasReady` wins the race (`canvas-replacement.js`). | Bootstrap already done — **no wait**. |
| **Renderer object** | Uses renderer from **`Hooks.once('ready')` bootstrap** (`module.js` → `bootstrap({ verbose: false })` — full bootstrap including minimal `THREE.Scene`). | If the prior scene was MSA-active, tearDown **disposes** the WebGL renderer (`destroyThreeCanvas` + `forceContextLoss` when `_threeCanvasWasActive`). Next load uses **`lazy bootstrap`** with `skipSceneInit: true` (`createThreeCanvas`). |
| **Layout timing** | Foundry UI / `#board` may still be settling; **`getBoundingClientRect()` on `#map-shine-canvas` can be 0×0** briefly. | Layout and layers usually **stable**; rect almost always non-zero. |
| **Asset cache** | In-memory bundle cache **cold** (see debug profiler text in `createThreeCanvas`). | Same session: **warm** cache for paths you already touched. |
| **`LoadSession`** | Normal completion; `session.finish()` at end. | Prior session aborted when switching away; new session for A. |

### Strongest mechanical hypothesis: 0×0 (or invalid) initial viewport

At renderer attach, the code used to do:

- `const rect = threeCanvas.getBoundingClientRect()`
- `renderer.setSize(rect.width, rect.height, …)`
- `sceneComposer.initialize(scene, rect.width, rect.height, …)`

There was **no fallback** if width/height were 0. **`ResizeHandler._debouncedResize` explicitly ignores `width <= 0 || height <= 0`** (`scripts/foundry/resize-handler.js`), so a bad first size could **never self-heal** from observer callbacks if the first notifications were also zero-sized.

**Why a scene round-trip “fixes” it:** `createThreeCanvas` runs again when the board already has real dimensions → non-zero `setSize` → camera and compositor initialize coherently → first visible frame is correct.

**In-session check:** On a grey cold load, in the console run  
`document.getElementById('map-shine-canvas')?.getBoundingClientRect()`  
and compare to after round-trip. Also watch for  
`[loading] map-shine-canvas was 0x0` (or board/window fallback) in logs after the mitigation below.

### Other cold-only risks (secondary)

- **`_createThreeCanvasRunning`:** concurrent second call **dropped** — if logs show “already in progress,” one init path may never complete.  
- **Shader warmup timeout** still opens the time gate; first frames may be sparse (usually stutter, not permanent grey).  
- **`session.isStale()`** mid-init aborts and calls `destroyThreeCanvas` — more likely when **rapidly** switching scenes than on a single idle cold load.

### Mitigation implemented (2026-03-21)

1. **`_resolveInitialViewportCssPixels`** in `canvas-replacement.js` — if `#map-shine-canvas` is below **1×1** CSS px, use **`#board`** rect, then **window** fallback, so `setSize` and `SceneComposer.initialize` never start from zero.  
2. **ResizeHandler `setup()` + `resize()`** moved to run **before** `RenderLoop.start()`, plus an immediate **`resizeHandler.resize()`** when the canvas rect is already valid — ResizeObserver is live before the first rAF frame.

If grey persists after this, next suspects are **context loss**, **stale session abort**, or **time/darkness** paths (hypotheses C/D), not raw viewport 0.

### Time-change regression (2026-03-21)

Moving the time slider persists `controlState` and (debounced) **`weather-snapshot`**. Each `setFlag` triggers **`updateScene`**. On the **authoring** client, that is a **local echo** with `userId === game.user.id`. Previously, Map Shine treated it like a **remote** sync:

1. **`controlState`** → `applyTimeOfDay` again + `pane.refresh()`.
2. **`weather-snapshot`** → `_loadWeatherSnapshotFromScene()` → serialized state re-applied and **`applyTimeOfDay` again** (see `WeatherController.js` when `stored.timeOfDay` is finite).

That stacked Foundry **`canvas.scene.update`** / darkness work and redundant weather application on top of the UI path already applied — consistent with **grey / broken V2** right after changing time.

**Mitigation:** skip the entire `map-shine-advanced` authoritative block in `onUpdateScene` when the update originated from the **current user**. **Players** still run the block when the GM’s user id differs. **`LevelsSnapshotStore`** no longer invalidates the Levels import snapshot when the only top-level changed flag namespace is `map-shine-advanced`.

---

## Related code (starting points)

| Area | File(s) | Notes |
|------|---------|--------|
| Time + weather apply order | `scripts/ui/control-panel-manager.js` — `_applyControlState` | Time → `applyWeatherState` → gated `_applyRapidWeatherOverrides` |
| Time, darkness, flags | `scripts/ui/state-applier.js` — `applyTimeOfDay`, `_updateSceneDarkness`, `startTimeOfDayTransition` | Darkness uses `canvas.scene.update`; transition uses 100 ms interval |
| Live five + rapid apply | `scripts/ui/control-panel-manager.js` — `_buildRapidWeatherOverrides`, `_applyRapidWeatherOverrides` | Forces directed Custom + WC init await |
| Bridge | `scripts/ui/weather-param-bridge.js` — `applyDirectedCustomPresetToWeather`, `syncDirectedCustomPresetFromWeatherController` | Main Tweakpane weather ↔ compact preset |
| Scene flag reactions | `scripts/foundry/canvas-replacement.js` — `onUpdateScene` | Skip authoritative resync when local author **or** GM + echo-only diff + `_msaLocalFlagWriteGuardUntil` window; `_resolveUpdateSceneUserId` |
| Flag write guard | `scripts/utils/msa-local-flag-guard.js` — `extendMsaLocalFlagWriteGuard` | Called before `setFlag` from panel, StateApplier, WeatherController snapshot |
| Weather snapshot echo | `scripts/core/WeatherController.js` — `_loadWeatherSnapshotFromScene` | No-op if `updatedAt` matches last local save |
| Levels snapshot cache | `scripts/core/levels-import/LevelsSnapshotStore.js` — `updateScene` hook | Invalidate only when flag keys other than sole `map-shine-advanced` |
| Compositor frame path | `scripts/compositor-v2/FloorCompositor.js` — `render`, `_shaderWarmupGateOpen`, `_ensureBusPopulated` | Lazy population / warmup may differ first frame vs later |

---

## Investigation checklist (next actions)

- [ ] **Confirm persistence:** After step 4, does **F5 reload** on Scene A stay grey? Export flags for Scene A vs B.
- [ ] **Minimal repro:** New empty Scene A′ with Map Shine enabled — same cold-load grey? If only one scene, points to **data** not **generic init**.
- [ ] **Console / WebGL:** Any context loss, shader compile errors, or repeated warnings on first load vs after round-trip? After the viewport fix, confirm whether `[loading] map-shine-canvas was 0x0` (or board/window fallback) appears on cold load.
- [ ] **Binary search on time path:** (1) time slider only, (2) transition minutes 0 vs >0, (3) “link time to Foundry” on/off.
- [ ] **Diff flag payload:** `controlState` + weather snapshot after step 3 (working) vs after step 4 (broken).
- [x] **Code audit (partial):** Documented bootstrap wait on first `canvasReady`, `__msaSceneLoading` / concurrent guard, V2 prewarm + shader gate + timeout behavior, `updateScene` controlState vs directed weather paths, darkness debounce and GM gate, fingerprint + rapid-override callers. Still need **runtime** confirmation of which branch matches the grey frame.

---

## Open questions

1. Does Scene A **always** load grey when it is the **initial** scene, or only sometimes (race)?
2. Is **any** time change sufficient, or only when **transition minutes** > 0?
3. Does the issue reproduce for **players** or **GM only** (darkness updates are GM-gated)?
4. After round-trip fix, does **only** Map Shine view fail or the **whole** Foundry canvas?

---

## Changelog

| Date | Note |
|------|------|
| 2026-03-21 | Document created from user repro (cold grey → B→A fix → time breaks). Linked to control panel / state applier / weather bridge hypotheses. |
| 2026-03-21 | Added **Code investigation findings**: bootstrap/`createThreeCanvas` ordering, `updateScene` controlState vs directed weather, fingerprint gate verification, 100ms time transition + darkness debounce, GM-only darkness, partial checklist closure. |
| 2026-03-21 | **Hypothesis A deep dive** in doc: grey ≈ CSS `#999999` + empty GL; cold vs round-trip table; **0×0 viewport** + ResizeHandler ignore as primary mechanical theory; mitigation: `_resolveInitialViewportCssPixels` + ResizeHandler before `RenderLoop.start()` in `canvas-replacement.js`. |
| 2026-03-21 | **Time-change grey:** skip Map Shine `updateScene` authoritative resync when `userId === game.user.id`; narrow Levels snapshot invalidation to ignore updates whose only top-level flag key is `map-shine-advanced`. |
| 2026-03-21 | **Echo hardening:** `_resolveUpdateSceneUserId` (options fallbacks); `extendMsaLocalFlagWriteGuard` + GM echo-only skip; StateApplier `setFlag` sites arm guard; WeatherController skip snapshot load when `updatedAt` matches local save. Doc: **Latest observations**, **Working theories**. |
| 2026-03-21 | **Foundry darkness decouple:** Control panel time / transition uses `applyFoundryDarkness: false`; `syncFoundryDarknessFromMapShineTime()` once after `_saveControlState`. Targets grey from hammering `canvas.scene.update` (unlinked Foundry time still hit darkness path before). |
| 2026-03-21 | **Hook + snapshot alignment:** `onUpdateScene` controlState time uses `applyTimeOfDay(..., false, false)` and `startTimeOfDayTransition(..., false, false)` so flag sync does not re-drive darkness. `_loadWeatherSnapshotFromScene` applies time with `applyDarkness: false`, then GM `syncFoundryDarknessFromMapShineTime()` once (avoids stacking with controlState + snapshot in one update). |
