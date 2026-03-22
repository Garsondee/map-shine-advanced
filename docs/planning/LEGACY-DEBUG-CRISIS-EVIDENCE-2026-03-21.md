# Legacy, debugging, and crisis-era rendering evidence

**Purpose:** Living **tidying backlog** and **progress record**: evidence of legacy / debug / crisis-era code (§§1–9), plus **checklists and a completion log** (§§10–12) to track what is done. Check items off as you go; add dated notes in §12.

**Traversal:** Started at `scripts/module.js`, then outward through bootstrap and `canvas-replacement.js`, plus repo-wide greps. **Second pass:** mode manager, loader, stubs, profilers, PIXI bridge. **Third pass:** `manager-wiring`, `effect-wiring`, `render-loop`, `scene-settings`, bridge debug flags, vision TODOs, masks. **Fourth pass:** input/camera/resize stack, orphan circuit-breaker, Levels region compat, `languages/en.json`. **Fifth pass:** orphan `scene-controls`, `EffectComposer` batch `console.log`, **`controls-integration` InputSnapshot** `log.warn` volume, `diagnostic-center-dialog` console wrapping, `FloorCompositor` “legacy” comments, `canvas-replacement` hook surface note.

---

## 1. `scripts/module.js`

| Item | Notes |
|------|--------|
| `_suppressDiagConsoleLogs()` | Wraps `console.log` / `warn` / `error` to drop messages whose args include the substring `Diag #`. Strong signal of **diagnostic log suppression** layered on top of other code. |
| `_msaCrisisLog(id, message)` | **No-op:** body only pads `id` inside `try` and never logs or stores. Dozens of call sites still run (init/ready hooks, scene controls, etc.) — **dead crisis instrumentation**. |
| `_msaCrisisInspectScene` | Large function computing JSON sizes, per-module flag sizes, and “suspicious” numeric fields; several inner branches end in **empty `if (suspicious.length)` blocks** — partially stripped logging. Still registered on `canvasConfig`, `canvasInit`, `drawCanvas`, `preUpdateScene`, and `ready`. |
| Global `error` / `unhandledrejection` listeners | Call `_msaCrisisLog` — currently **silent** due to no-op. |
| localStorage scrub | Removes `msa-disable-texture-loading` and `msa-disable-water-effect`; **5s interval scrub** for 10 iterations — documented as deprecated kill-switches from **0%/98% load-stall** investigation. |
| `MapShine.__pixiVisibilityState`, `__pixiWorldCompositeMapping`, `__pixiBridgeCompositeStatus` | Placeholder objects with `note` fields; comments say **diagnostics / V2 compositor** integration. |
| `MapShine.__usePixiContentLayerBridge`, `__useThreeTemplateOverlays` | Default `false`; comment: **diagnostics** unless explicitly enabled. |
| `getPlayerLightEffectInstance()` | Resolution order: `playerLightEffectV2` → `floorCompositorV2._playerLightEffect` → **`playerLightEffect`** (non-V2 name retained for compatibility). |
| `__msaEnabledFlagWatchInstalled` | `Hooks.on('updateScene', …)` with comment “Diagnostic logging removed intentionally” — **empty handler** left wired. |
| `__msaCrisisCorruptionDiagInstalled` | Hooks that invoke `_msaCrisisInspectScene` at many canvas lifecycle points. |
| `preImportAdventure` | **`console.log` with `Map Shine DIAG:`** for every create/update scene payload (flag keys) — noisy in production. |
| `[MSA BOOT]` | `console.log` in `ready` hook (fired + bootstrap complete). |
| GNU Terry Pratchett `console.log` | Styled multi-line `console.log` — **easter egg / always-on console noise**, not functional. |
| Empty `try { } catch` at module top (~551) | No-op block after `_msaCrisisLog(1, …)`. |

---

## 2. `scripts/core/bootstrap.js`

| Item | Notes |
|------|--------|
| `_msaCrisisLog` | **Duplicate no-op** (same pattern as `module.js`). |
| Many `_msaCrisisLog(...)` calls | Trace bootstrap steps; all **silent** today. |
| `[MSA BOOT]` | Multiple unconditional `console.log` lines (start, three.js, capabilities, renderer). **Verbose boot tracing** overlapping `logger.info`. |
| `window.THREE = THREE` | Comment: “Expose globally for **debugging**”. |
| `TODO` (line ~145) | “extracted to scene/ module in next milestone” — **stale milestone comment** on inline scene/camera creation. |

---

## 3. `scripts/foundry/canvas-replacement.js` (high density)

| Item | Notes |
|------|--------|
| `_isCrisisNuclearBypassEnabled()` | **Always `return false`.** Branches in `initialize()` and hook registration still exist — **stubbed crisis bypass** (nuclear path disabled but structure retained). |
| `_isSceneCleanModeEnabled()` | **Always `return false`** — companion to scene-flag wipe tooling; `MapShine.setAutoClean` still toggles `localStorage` but mode check is hard-disabled. |
| `initialize()` opening | `try { const n = String(80).padStart(3, '0'); } catch` — **dead code** (same idiom as crisis log remnants). |
| `_installNetworkDiagnostics()` | Monkey-patches **`globalThis.fetch`** and **`HTMLImageElement.prototype.src`**; stores pending maps on `globalThis.__msaCrisisNetworkDiag`. **Global side effects** for stall diagnosis. |
| `_collectCanvasStateDiagnostic()` | Reads `__msaCrisisNetworkDiag` for stalled fetches/images >1s. |
| `installCanvasDrawWrapper()` | Calls `_installNetworkDiagnostics()`. Contains **2s `setInterval`** that calls `_collectCanvasStateDiagnostic()` but **does not use the return value** in the callback — possible **wasted work** every 2s while draw is pending. Multiple `schedule()` timeouts with **empty bodies** (only `String(id).padStart` in try/catch). |
| Hang / `canvasReady` recovery | **Watchdog** (`HANG_TIMEOUT_MS = 8000`), `_msaRecoveryMode`, forced `onCanvasReady` — **documented crisis behavior** for Foundry draw never resolving or `canvasReady` skipped. |
| `_installFoundryTextureLoaderTrace()` | **`msa-diagnostic-safe-textures`** localStorage gate; default fail-open to “safe” texture behavior — **load-stall mitigation** for bad assets. |
| Comments / logs | Frequent **`->->`** markers; `console.log(' -> Step: …')` style **step tracing** during `createThreeCanvas`; `dlp.event('effect pipeline: legacy V1 paths bypassed')`. |
| V2 vs legacy | Explicit log: **“Compositor V2 active ->-> skipping legacy effect construction, masks, and pre-warming”**; empty `effectMap`; DepthPassManager noted as unused in V2 — **V1 pipeline largely bypassed but scaffolding remains**. |
| Mode / PIXI | References to **“legacy”** hybrid configuration, `ModeManager` vs legacy restore, `configureFoundryCanvas` **legacy** path — multiple **fallback layers** for PIXI/Three coexistence. |

**Additional `canvas-replacement.js` items (second pass)**

- **`__msaPixiAssetTraceInstalled` / `__msaLastPixiAssetTrace`** — Wraps PIXI `Assets.load`, `Texture.from`, `BaseTexture.from` (duplicated install paths ~1577 and ~1802). **Asset-load tracing** for stall hunts; global mutation (`__msaPatched` on wrappers).
- **`__msaWebglCanvasObserver` / `__msaWebglListenersInstalled`** — Observes / listens on WebGL canvas for **context loss** diagnostics.
- **Loading heartbeat watchdog** (`WATCHDOG_INTERVAL_MS = 15000`, stuck threshold **5 minutes**): logs `[loading] createThreeCanvas heartbeat [diag=step-tracker-v1]` every 15s — **always-on verbose telemetry** during long loads (comment still says “60s” in one place while threshold is 300000ms).
- **`MapShine.__msaSceneLoading`** — Boolean flag toggled around scene load lifecycle (diagnostics / external introspection).
- **`MapShine.__msaAshDisturbanceHookId`** — Stores `Hooks.on('updateToken', …)` id for teardown; pattern of **globals for hook bookkeeping**.
- **`_msaRecoveryReason`** — Declared at module scope in `canvas-replacement.js` but **never assigned or read** (grep: declaration only) — **dead variable**, safe removal candidate.
- **`_teardownPixiLayerDebugMode`** — Called from `onCanvasTearDown`; pairs with PIXI layer debug / hybrid diagnostics.
- **`console.group('EffectMaskRegistry')`** (~6564) — Debug-style grouping in console during init (confirm intent; gate or remove for production cleanliness).
- **Dead `String(N).padStart(3,'0')` try blocks** — Dozens of occurrences (roughly lines 1427–3898): same pattern as crisis log IDs, **no side effect** — bulk delete candidate when touching this file.
- **Ticket-style comments** — `P0.3`, `P0.4`, `P1.3`, `MS-LVL-0xx` scattered through the file: useful for history but **noisy** if you want a cleaner codebase (optional rename to short prose or move to docs).

---

## 4. V1 render compositor vs current architecture (evidence)

**Clarification:** The old “V1 compositor” in comments is the **`EffectComposer`-centric post stack** (registered effects in `EffectComposer.effects`, mask pre-warm paths, etc.). **V2** is **`FloorCompositor` + per-floor passes**, still **reachable through** `EffectComposer._getFloorCompositorV2()` and `window.MapShine.effectComposer._floorCompositorV2`.

| Location | Evidence |
|----------|----------|
| `scripts/effects/EffectComposer.js` | Comments: effects **not** in legacy `effects` map in V2 mode; exposes `floorCompositorV2`, `playerLightEffectV2`, and **`playerLightEffect` alias** (“Back-compat for call sites not yet migrated”). Replay map comment: **V1 water UI schema defaults** must not be replayed into V2 water. |
| `scripts/foundry/canvas-replacement.js` | `new EffectComposer(...)` still constructed; **legacy effect construction removed**, `effectMap = new Map()` empty; WeatherController update path described as V1 vs V2 split. |
| `scripts/ui/graphics-settings-manager.js` | `applyOverrides()` still has branch comment **“Legacy/direct instance path (V1 or hybrid instances)”** after `_applyV2Enabled`. |
| `scripts/scene/tile-manager.js` | Comments: **V2-only**, “legacy V1 water occluder path removed”, skip **V1 elevation-based visibility** when V2 active. |
| `scripts/compositor-v2/effects/*.js` | Many file headers say **“adapted from V1”** or “no reliance on V1 …” — documentation of migration, not necessarily dead code. |
| `scripts/scene/composer.js` | **`SceneComposer`** (battlemap / camera / masks) is **not** the same as `EffectComposer`; it owns **`GpuSceneMaskCompositor`** for mask atlases — still **active** for V2 mask data, not obsolete “V1 compositor” in the effect-pass sense. |

---

## 5. Other scripts (spot checks)

| File | Notes |
|------|--------|
| `scripts/compositor-v2/effects/WaterEffectV2.js` | `log.warn` with **`[crisis]`** prefix when reporting slow `ShaderMaterial` creation — crisis-era wording. |
| `scripts/utils/console-helpers.js` | Large **diagnostic / perf** surface (`[MS-PERF-10S]`, snapshots) — intentional tooling; overlaps with loading profilers. |
| `scripts/utils/scene-debug.js` | **`SceneDebug`** helpers (axes, grid, test meshes) — explicit debug utilities. |
| `scripts/core/debug-loading-profiler.js` | Wired from `module.js` init — **feature-flagged** loading diagnostics (settings-sync). |
| `scripts/ui/diagnostic-center-dialog.js` | Header mentions **“v1 scope”**; references `maskCompositor` / floor checks — mixed diagnostic UI. |

---

## 6. Second-pass additions (wider sweep)

### `scripts/foundry/mode-manager.js`

- File header explicitly lists **“Input arbitration (legacy path)”** among responsibilities — parity / PIXI mode still carries **legacy-named** behavior split from `canvas-replacement.js`.
- **`setMapMakerMode`** naming vs “native Foundry rendering” — historical “Map Maker” wording may confuse; tidying could align names with current UX (documentation / rename only if behavior unchanged).

### `scripts/assets/loader.js`

- **`forceModuleReload()`** — Documented as **“nuclear option for debugging”**; clears caches and reloads. Confirm exposure (console / MapShine) and whether still needed.
- **“Structural (legacy window) mask”** — Mask type metadata; **data compatibility**, not dead code.
- Comments: **legacy PIXI path** when `createImageBitmap` missing; **Compositor V2** avoids loading legacy bundle masks — keep until minimum browser target drops fallback.

### `scripts/scene/map-points-manager.js`

- **Legacy module namespace** for map point groups + **migration logs** (`fromLegacy`, `LEGACY_MODULE_ID`) — real backward compatibility; tidying = eventual removal only after migration window closes.

### V1-style / `EffectBase` artifacts (still in tree)

| File | Notes |
|------|--------|
| `scripts/effects/stubs/StubEffects.js` | **`StubEffect extends EffectBase`** — **§7:** no imports from other `scripts/**/*.js`; likely **orphan**. |
| `scripts/effects/LensflareEffect.js` | Full **`EffectBase`** effect — **§7:** no imports from other `scripts/**/*.js`; **README** still mentions it; V2 port pending per migration docs. |
| `scripts/effects/MaskDebugEffect.js` | **`EffectBase`** mask visualizer; UI hooks in `effect-stack.js` (`_openMaskDebug`, `_getMaskDebugOptions`). **Intentional debug**, consider gating behind debug setting only. |
| `scripts/particles/DebugParticles.js` | Named **debug** particle helper — keep or fold into diagnostic tooling. |

### `scripts/ui/tweakpane-manager.js`

- **`console.warn('MapShine: EffectMaskRegistry not available')`** / **`TileEffectBindingManager not available`** — Defensive messages that may fire during **ordering / timing** windows; candidates to downgrade to `log.debug` or remove if never legitimate.

### `scripts/ui/effect-stack.js`

- **Mask debug** UI paths and **`debugLoadingProfiler.debugMode`**-gated spans — overlaps with `debug-loading-profiler`; fine for tidying **consistency** (one pattern for “verbose UI build” logging).

### `scripts/core/loading-profiler.js` + `scripts/core/profiler.js`

- **`LoadingProfiler`** is **opt-in** (`enabled` flag) — low noise unless something calls `start()`. Worth noting alongside **`globalLoadingProfiler`** / **`globalProfiler`** usage when consolidating perf tooling.

### `scripts/foundry/pixi-content-layer-bridge.js`

- Large integration surface; **`MapShine.__usePixiContentLayerBridge`** defaults false in `module.js`. **Tidying:** audit for unreachable branches when bridge is permanently off, or document as supported experimental path.

### Vendor bundles (`scripts/vendor/**`)

- **Not Map Shine debt:** `three.*.js`, `tweakpane`, quarks, etc. **Exclude** from “remove legacy” passes unless upgrading vendor versions.

---

## 7. Third-pass additions (wiring · settings · bridge · vision)

### `scripts/foundry/manager-wiring.js`

- **`exposeGlobals()`** still defines **`EFFECT_EXPOSURES`** (Specular, Overhead Shadows, Water, etc.) and fills `mapShine.*` from **`effectMap`**. Under V2, `createThreeCanvas` passes an **empty `effectMap`** — this loop is a **no-op**; live V2 effect handles are set elsewhere (`EffectComposer._getFloorCompositorV2` → `window.MapShine.*V2` and aliases). **Tidying:** remove the dead `EFFECT_EXPOSURES` block or gate it behind a “legacy effectMap populated” check so the story is obvious.

### `scripts/foundry/effect-wiring.js`

- Comment: **“V2-only runtime: no legacy effectMap instances…”** — good; one **`log.debug('P2.1: Could not pre-read graphics settings…')`** — ticket-style label (optional rename).

### `scripts/core/render-loop.js`

- References **`window.MapShine?.debugLoadingProfiler`** in the render path.
- **`log.debug`** for “Frame … no composer” / “Effect composer set” — normal logger noise at DEBUG level; no action unless consolidating.

### `scripts/core/safe-call.js`

- **Infrastructure** (severity + `safeCall` / `safeCallAsync`) — not cruft; large **`canvas-replacement`** usage is why warnings appear; tidying is about **call-site severity**, not this file.

### `scripts/foundry/pixi-content-layer-bridge.js` (flags & fallbacks)

- **`MapShine.__debugSkipBridgeDirtyOnWall`** — early-return guard in multiple places; **opt-in debug** for wall dirty churn.
- **`MapShine.__pixiBridgeForceTestPattern`** — **compositor sanity / test pattern** (`_isCompositorSanityPatternEnabled`).
- **`MapShine.__pixiBridgeUseShapeReplay`** — expensive **shape-replay debug** (`_isShapeReplayDebugEnabled`).
- Comment ~4134: **“Fallback path (legacy): GPU→CPU readback extraction”** — keep for compatibility; document next to other bridge toggles.

### `scripts/settings/scene-settings.js`

- **`LOADING_SCREEN_MODES.LEGACY`** — user-facing **legacy loading screen mode** (real feature, not dead code).
- **`LEVELS_COMPATIBILITY_MODES.DIAGNOSTIC_INTEROP`** — labeled **“migration debugging”** in UI strings.
- World settings: **`debug-mode`**, **`debugLoadingMode`** — intentional **diagnostic toggles** (synced to `debugLoadingProfiler`).

### `scripts/foundry/controls-integration.js` + `scripts/foundry/unified-camera.js`

- Comments reference **legacy input mode** / **legacy fallback** (camera paths).
- Many **`log.debug`** traces (layer hide/show, hook registration) — fine at default log level; optional consolidation.

### `scripts/core/load-session.js`

- **`log.debug` when session stale** — useful for race debugging during fast scene switches.

### `scripts/core/frame-coordinator.js`

- Frame counter documented **“for debugging”** — low priority.

### `scripts/masks/GpuSceneMaskCompositor.js`

- Comment ~1346: **“legacy single-key cache”** from old `getCpuPixels` path — **compatibility layer** inside active V2 mask pipeline.

### `scripts/vision/VisionPolygonComputer.js` / `scripts/vision/FogManager.js`

- **`TODO`** comments (one-way walls, limited sight/light, Foundry thresholds, resample) — **known feature gaps**, not debug cruft; good for a **roadmap** bucket separate from “delete”.

### `scripts/core/game-system.js`

- **`legacy`** variable names for reading **`actor.system.attributes`** — **system compatibility** (e.g. D&D5e), unrelated to render compositor.

### Orphan V1 files (grep verification, third pass)

- **`scripts/effects/LensflareEffect.js`** — **no other file under `scripts/` imports it** (only self + docs/`README.md`). Migration docs already mark flares as **not yet ported to V2**.
- **`scripts/effects/stubs/StubEffects.js`** — **no imports from rest of `scripts/`**; large catalog of stub classes — **orphan / sample surface** unless build pipeline pulls it in (module.json does not list it separately). **Strong delete-or-archive candidate** after confirming no dynamic import.

---

## 8. Fourth-pass additions (input stack · dead modules · i18n)

### Input / camera / resize pipeline

- **`scripts/foundry/input-router.js`** — **Mode change history** and **`getState` / history getters “for debugging”**; routine **`log.debug`** on mode transitions and PIXI interactive layers. No crisis markers; optional trim of debug-only APIs if you want a smaller public surface on `MapShine`.
- **`scripts/foundry/camera-sync.js`** — **“Sync statistics for debugging”**; **`log.debug`** on sync paths and manual sync. Low noise at default log level.
- **`scripts/foundry/camera-follower.js`** — Comment: keep a listener as **“legacy fallback only”** when newer sync path missing — real compatibility, not dead code.
- **`scripts/foundry/resize-handler.js`** — Verbose **`log.debug`** for attach/detach, dimension validation, skip reasons — fine; no `console.*`.
- **`scripts/foundry/cinematic-camera-manager.js`** — Sparse **`log.debug`** (e.g. impulse registration).
- **`scripts/foundry/drop-handler.js`** — **`log.debug`** including **“Drop position fallback”** (viewport → canvas) — documents coordinate fallbacks; not cruft.
- **`scripts/foundry/levels-perspective-bridge.js`** — **`log.debug`** for elevation / level index sync — interoperability tracing.

### `scripts/core/circuit-breaker.js` + `scripts/ui/circuit-breaker-panel.js`

- Explicitly labeled **“Legacy … compatibility shim”** / **“decommissioned”**: all mutators **no-op**, **`isDisabled` always false**, **`CIRCUIT_BREAKER_EFFECTS`** empty array.
- **Grep:** no file under `scripts/` **imports** either module; **`openCircuitBreakerPanel` is never called** from JS. Files are **orphan source** (not in `module.json` as separate entries — only reachable if something imported them).
- **`docs/ARCHITECTURE-SUMMARY.md`** still describes **`circuit-breaker.js`** as active subsystem — **stale doc**.
- **`docs/planning/V2-EFFECT-DESIGN-CONTRACT.md`** still shows **`this._circuitBreaker.isDisabled(...)`** pattern — **out of date** vs current V2 code.
- **Tidying:** delete both files **or** keep one short README under `docs/` explaining kill-switches removed; update architecture + contract docs.

### `scripts/foundry/region-levels-compat.js`

- **“Legacy stair drawings”** collection + **`updateToken` hook** (MS-LVL-083) — **real migration / compat** for drawing-based stairs, not debug-only.
- **`log.info`** when hook installed — fires once per install; acceptable or downgrade to `log.debug` if noisy in multi-hook scenarios.

### `scripts/foundry/zone-manager.js`

- Many **`log.debug`** branches when zones skipped (missing data, non-finite center, etc.) — useful for **authoring mistakes**; no change needed unless consolidating “zone diagnostics”.

### `languages/en.json`

- **Minimal** (hello + `MAPSHINE.ToolTitle` / `ToolDescription`). **No** “Map Maker”, “legacy loading”, or diagnostic strings here — scene/settings strings live in **`scene-settings.js`** / Foundry `game.i18n` keys. **No i18n debt** spotted in this file for the legacy-rename theme.

---

## 9. Fifth-pass additions (orphan scene-controls · console noise · compositor comments)

### `scripts/foundry/scene-controls.js` — **orphan module**

- Exports **`openDiagnosticPanel()`** (HTML dialog + embedded console snippets) and **`toggleEffects()`**.
- **Grep:** **no** `import` from any other file under `scripts/` — same class as **`circuit-breaker`**: **dead source** in the current module graph.
- Overlaps conceptually with **`diagnostic-center-dialog.js`**. **Tidying:** delete **or** wire from UI **or** merge unique content into Diagnostic Center; update **`docs/ARCHITECTURE-SUMMARY.md`** (still lists scene-controls).

### `scripts/effects/EffectComposer.js` — unconditional `console.log` during batch init

- Parallel init path (~353, ~370): **`console.log`** **`▶ Effect INIT START`** / **`✔ Effect INIT DONE`** per legacy effect, **in addition to** `log.debug`.
- **Tidying:** gate behind **`globalLoadingProfiler.enabled`**, **`debugLoadingProfiler.debugMode`**, or log level so default loads stay quiet.

### `scripts/foundry/controls-integration.js` — **`[InputSnapshot #…]` uses `log.warn`**

- **`_logInteractionSnapshot`** dumps mode, pointer-events, active control/tool, etc. via **`log.warn`** on **routine** hooks (`renderSceneControls.postUpdate`, `initialize.postAutoUpdate`, …).
- **`renderSceneControls`** fires often → **warn-level spam** can look like failures. **High-value tidy:** **`log.debug`** or **`MapShine.__debugInputSnapshots`** (default off).

### `scripts/ui/diagnostic-center-dialog.js` — console wrapping

- While open, **replaces `console.warn` / `console.log`** to copy lines into the UI (~33–67). Surprising for macros/other modules. **Tidying:** document clearly; optional **opt-in** or **narrow** wrap.

### `scripts/compositor-v2/FloorCompositor.js` — “legacy” in comments

- Several **legacy** labels (foam bridge, RGB captures, DoorMeshManager, single-texture outdoors, single-mask mode, fire safety net, debug override). **Compatibility paths**, not deletions — optional **rename** to “compat” for clarity.

### `scripts/foundry/canvas-replacement.js` — hook density

- On the order of **~32** `Hooks.on` / `Hooks.once` / wrapper registrations in one file (grep count). **Tidying:** separate **hook inventory** doc if you trim recovery/staging code.

### Fifth-pass quick negatives

- **`overlay-ui-manager.js`** — init `log.info` only.
- **`pixi-input-bridge.js`** — `log.debug` on enable/disable only.

---

## 10. Cleanup checklist — progress

**Convention:** `- [ ]` = not done · `- [x]` = done. Optionally add *italic note* after an item (e.g. *2026-03-22: merged in …*).

> **Guiding principle:** The module is working well. Prune dead ends and silence noisy diagnostics **without** disturbing the wiring that keeps the **V2 compositor** stable. For **canvas lifecycle / recovery hooks**, prefer **gate or document** over aggressive removal until behavior is well understood.

### Phase 1 — Noise reduction and safe dead-code

- [x] **`controls-integration.js`:** Change `_logInteractionSnapshot` from `log.warn` to `log.debug` or gate behind e.g. `MapShine.__debugInputSnapshots` (§9, §3). *2026-03-21: switched snapshot emission to `log.debug` to avoid warn-level spam on routine hooks.*
- [x] **`module.js`:** Remove or gate `preImportAdventure` `Map Shine DIAG:` `console.log` loops. *2026-03-21: gated behind `MapShine.__debugAdventureImport === true`.*
- [x] **`EffectComposer.js`:** Gate batch `▶ Effect INIT START` / `✔ Effect INIT DONE` `console.log` (profiler or `log.debug`). *2026-03-21: replaced unconditional `console.log` with `log.debug`.*
- [x] **Boot noise:** Consolidate or gate `[MSA BOOT]` (`bootstrap.js`, `module.js`) and the GNU Terry Pratchett `console.log`. *2026-03-21: removed `[MSA BOOT]` console lines from bootstrap/module; GNU Terry Pratchett line intentionally remains always-on.*
- [x] **No-op crisis plumbing:** Remove `_msaCrisisLog` (and duplicates in `bootstrap.js`), strip empty `try { String(n).padStart… }` blocks in `canvas-replacement.js`, remove or gut `_msaCrisisInspectScene` + related hooks if no longer needed (§1, §3). *2026-03-21: completed across `bootstrap.js`, `module.js`, and `canvas-replacement.js` (all crisis no-op log scaffolding and `padStart` no-op blocks removed).*
- [x] **Orphan modules (verify then delete or archive):** `StubEffects.js`, `LensflareEffect.js`, `circuit-breaker.js`, `circuit-breaker-panel.js`, `scene-controls.js` — confirm no dynamic import; update `README` / architecture if removed (§7–9). *2026-03-21: confirmed no static/dynamic imports under `scripts/`, removed all five files, updated `README.md` (Lensflare list) and `docs/ARCHITECTURE-SUMMARY.md` (circuit-breaker/scene-controls references).*
- [x] **`canvas-replacement.js`:** Remove `_isCrisisNuclearBypassEnabled` / `_isSceneCleanModeEnabled` **and** dead branches (`return false` stubs). *2026-03-21: deleted both helpers and inlined always-active path where branches were dead.*
- [x] **`module.js`:** Remove empty `updateScene` watcher (`__msaEnabledFlagWatchInstalled`). *2026-03-21: removed inert hook + install flag block (no side effects remained).*
- [x] **`canvas-replacement.js`:** Gate ` -> Step: …` `console.log` in `createThreeCanvas` behind debug loading mode (or single flag). *2026-03-21: routed step traces through a `stepLog` helper gated by `debugLoadingProfiler.debugMode` or `MapShine.__debugLoadingSteps`.*

### Phase 2 — Global overrides, intervals, watchdogs

- [x] **Decision:** `_installNetworkDiagnostics` (`fetch` / `Image.src`) — remove, or **opt-in debug only** (§3). *2026-03-21: kept implementation but made install opt-in only (`debugLoadingProfiler.debugMode` or `MapShine.__debugNetworkDiagnostics`).*
- [x] **`diagnostic-center-dialog.js`:** Document console wrapping; optional **opt-in** or narrower wrap (§9). *2026-03-21: narrowed to opt-in only — shader probe console capture now requires `MapShine.__debugDiagnosticConsoleCapture === true`; default diagnostics no longer monkey-patch global console.*
- [x] **Intervals / watchdogs:** Review 2s draw poller (discarded snapshot), repeated localStorage kill-switch scrub, 15s `[diag=step-tracker-v1]` heartbeat — remove or **debug-gated** (§3). *2026-03-21: debug-gated heartbeat logs + 2s draw poller in `canvas-replacement.js`, and removed repeated localStorage kill-switch scrub loop from `module.js` (kept single startup cleanup pass).*
- [x] **`__msaPixiAssetTrace*`:** Remove or gate PIXI `Assets.load` / `Texture.from` patches (§3). *2026-03-21: install path now gated to debug mode/flag only (`debugLoadingProfiler.debugMode` or `MapShine.__debugPixiAssetTrace`).*
- [x] **`_suppressDiagConsoleLogs`:** Revisit once `Diag #` / DIAG logs are gone — may become redundant (§1). *2026-03-21: removed global console wrapper from `module.js` (redundant and potentially surprising cross-module side effect).*
- [x] **Pathfinding warn flood (`TokenMovementManager`):** Triage `_validatePathSegmentCollision blocked (...)` warn volume (`scripts/scene/token-movement-manager.js`); likely downgrade to `debug` and/or dedupe/throttle. *2026-03-21: downgraded collision-blocked diagnostics (`nearest hit`, `all hits`, `endpoint probe`, `fallback checkCollision`) from warn -> debug.*
- [x] **Pathfinding flow warns (`InteractionManager`):** Triage confirmation-flow warns (`waiting for confirmation click`, `movement not executed`, `movement execution succeeded`) in `scripts/scene/interaction-manager.js`; likely `debug` level. *2026-03-21: downgraded routine confirmation-flow logs (and "executing move") from warn -> debug; kept failure paths at warn.*
- [x] **Movement preview deprecations (Foundry v13):** Replace deprecated grid API usage in `scripts/compositor-v2/effects/MovementPreviewEffectV2.js` (`getTopLeft` chain) with current equivalents to stop Foundry compatibility warnings. *2026-03-21: switched snapping to prefer `getOffset` + `getTopLeftPoint`, keeping `getTopLeft` only as legacy fallback.*

### Phase 3 — Architecture and V1/V2 scaffolding

- [x] **`canvas-replacement.js`:** Produce a **hook / libWrapper inventory** (what each registration does) before unwiring recovery paths (~32 sites) (§9). *2026-03-21: added §14 inventory with `Hooks.on/once` + wrapper surfaces and behavior notes.*
- [x] **`manager-wiring.js`:** Remove or document **`EFFECT_EXPOSURES`** no-op loop (empty V2 `effectMap`) (§7). *2026-03-21: removed legacy `EFFECT_EXPOSURES` loop and `effectMap` dependency from `exposeGlobals`; V2 globals are exposed via direct manager/compositor refs.*
- [ ] **Legacy input / camera:** Audit `mode-manager.js`, `camera-follower.js`, `controls-integration.js` fallbacks vs minimum Foundry version (§6, §8).
- [ ] **`EffectComposer` facade:** Align docs with V2-only reality; confirm whether more **V1 effect-map** code can be stripped (§4, §7).
- [ ] **`graphics-settings-manager.js`:** Confirm **legacy/direct instance** path still needed; trim if V2-only (§4).

### Phase 4 — Documentation, naming, cosmetics

- [ ] **`ARCHITECTURE-SUMMARY.md` + `V2-EFFECT-DESIGN-CONTRACT.md`:** Remove stale **circuit breaker** / obsolete patterns (§7–8).
- [ ] **PIXI bridge debug globals:** Single developer doc for `__debugSkipBridgeDirtyOnWall`, `__pixiBridgeForceTestPattern`, `__pixiBridgeUseShapeReplay`, etc. (§7, §9).
- [ ] **Optional:** `playerLightEffect` alias deprecation path; comment / ticket-ID hygiene (`P0.3`, `MS-LVL-*`); move **Vision** `TODO`s to external roadmap (§5, §7).

---

## 11. Files touched in this review (cumulative, non-exhaustive)

- `scripts/module.js`
- `scripts/core/bootstrap.js`
- `scripts/foundry/canvas-replacement.js` (partial read; file is very large)
- `scripts/effects/EffectComposer.js` (partial)
- `scripts/ui/graphics-settings-manager.js` (partial)
- `scripts/scene/composer.js` (header / mask compositor)
- `scripts/foundry/mode-manager.js` (header / API)
- `scripts/assets/loader.js` (partial)
- `scripts/scene/map-points-manager.js` (grep / legacy flags)
- `scripts/effects/stubs/StubEffects.js`, `scripts/effects/LensflareEffect.js`, `scripts/effects/MaskDebugEffect.js`
- `scripts/particles/DebugParticles.js`
- `scripts/ui/tweakpane-manager.js` (warn strings)
- `scripts/ui/effect-stack.js` (mask debug / dlp)
- `scripts/core/loading-profiler.js`
- `scripts/foundry/manager-wiring.js` (`exposeGlobals`, `EFFECT_EXPOSURES`)
- `scripts/foundry/effect-wiring.js` (grep)
- `scripts/core/render-loop.js` (grep)
- `scripts/core/safe-call.js` (header / role)
- `scripts/settings/scene-settings.js` (partial)
- `scripts/foundry/controls-integration.js`, `scripts/foundry/unified-camera.js` (grep)
- `scripts/core/load-session.js`, `scripts/core/frame-coordinator.js` (grep)
- `scripts/masks/GpuSceneMaskCompositor.js` (grep)
- `scripts/vision/VisionPolygonComputer.js`, `scripts/vision/FogManager.js` (TODOs)
- `scripts/core/game-system.js` (grep — system compat)
- `scripts/foundry/input-router.js`, `scripts/foundry/camera-sync.js`, `scripts/foundry/camera-follower.js`, `scripts/foundry/resize-handler.js`, `scripts/foundry/cinematic-camera-manager.js`, `scripts/foundry/drop-handler.js`, `scripts/foundry/levels-perspective-bridge.js` (grep)
- `scripts/core/circuit-breaker.js`, `scripts/ui/circuit-breaker-panel.js` (orphan shim)
- `scripts/foundry/region-levels-compat.js`, `scripts/foundry/zone-manager.js` (grep)
- `languages/en.json` (minimal)
- `docs/ARCHITECTURE-SUMMARY.md`, `docs/planning/V2-EFFECT-DESIGN-CONTRACT.md` (stale circuit-breaker mentions)
- `scripts/foundry/scene-controls.js` (orphan), `scripts/effects/EffectComposer.js` (batch `console.log`), `scripts/foundry/controls-integration.js` (`_logInteractionSnapshot`), `scripts/ui/diagnostic-center-dialog.js` (console wrap), `scripts/compositor-v2/FloorCompositor.js` (grep), `scripts/ui/overlay-ui-manager.js`, `scripts/foundry/pixi-input-bridge.js` (fifth pass)
- Grep-led: `WaterEffectV2.js`, `console-helpers.js`, `scene-debug.js`, `diagnostic-center-dialog.js`, `tile-manager.js`, `PlayerLightEffectV2.js`, `levels-api-facade.js`, etc.

**Still useful to scan:** Remainder of **`EffectComposer.js`** (dispose, render order, V2-only branches); **`MaskManager.js`** / **`scene-mask-compositor.js`** if still linked from loader; **`scripts/lib/lib.js`** + **`scripts/build/`** (packaging); **`.gitignore` for `tests/playwright-artifacts`**; **README** vs actual exposed effects (Lensflare, etc.).

---

## 12. Progress log

Add a row when you complete a meaningful slice (merge, release, or milestone). Keeps the evidence doc useful long after the initial audit.

| Date | Phase (§10) | Summary | Commit / PR |
|------|-------------|---------|-------------|
| *—* | *—* | *Example: Phase 1 — InputSnapshot → log.debug* | *—* |
| 2026-03-21 | Phase 1 | Reduced startup/import console noise: InputSnapshot warn→debug, preImport DIAG gated, EffectComposer init logs moved to debug, and `[MSA BOOT]` console lines removed from bootstrap/ready flow. | *—* |
| 2026-03-21 | Phase 1 | Restored always-on GNU Terry Pratchett console line; removed empty `updateScene` diagnostic watcher; removed dead crisis bypass/clean-mode stubs and branches in `canvas-replacement`. | *—* |
| 2026-03-21 | Phase 1 | Gated `createThreeCanvas` step-trace console noise (` -> Step: ...`) behind debug loading mode / `MapShine.__debugLoadingSteps`. | *—* |
| 2026-03-21 | Phase 1 | Began no-op crisis plumbing cleanup: removed `_msaCrisisLog` dead shim and all call sites from `bootstrap.js` (remaining crisis cleanup tracked as in-progress in checklist). | *—* |
| 2026-03-21 | Phase 1 | Removed orphan modules: `StubEffects.js`, `LensflareEffect.js`, `circuit-breaker.js`, `circuit-breaker-panel.js`, `scene-controls.js`; aligned README + architecture docs to current runtime graph. | *—* |
| 2026-03-21 | Phase 1 | Continued no-op crisis cleanup in `module.js`: removed `_msaCrisisInspectScene` helper and its lifecycle hook registrations (`canvasConfig/canvasInit/drawCanvas/preUpdateScene/ready`). | *—* |
| 2026-03-21 | Phase 1 | Finished `module.js` crisis-log removal: deleted `_msaCrisisLog` helper and all call sites; remaining crisis no-op cleanup is now isolated to `canvas-replacement.js` `padStart` blocks. | *—* |
| 2026-03-21 | Phase 1 | Completed crisis no-op cleanup in `canvas-replacement.js`: removed remaining `String(...).padStart(...)` try/catch blocks and dead scheduling snippets; §10 crisis-plumbing item now complete. | *—* |
| 2026-03-21 | Phase 2 | Made network diagnostics monkey-patching opt-in: `_installNetworkDiagnostics` now installs only in debug loading mode or with `MapShine.__debugNetworkDiagnostics`. | *—* |
| 2026-03-21 | Phase 2 | Added warning-source triage section from live logs; identified Map Shine-owned warnings/deprecations and queued new checklist items for warning suppression/fixes. | *—* |
| 2026-03-21 | Phase 2 | Reduced low-value warning spam: downgraded DustEffectV2 "no spawn points" and high-frequency pathfinding flow/collision diagnostics from warn to debug. | *—* |
| 2026-03-21 | Phase 2 | Addressed Foundry v13 grid deprecation chain in movement preview: migrated snap logic to `getOffset` + `getTopLeftPoint` with legacy fallback. | *—* |
| 2026-03-21 | Phase 2 | Reduced loading telemetry noise: `createThreeCanvas` heartbeat and draw-state poller now run only in debug mode or explicit debug flags. | *—* |
| 2026-03-21 | Phase 2 | Completed interval/watchdog tidy item by removing repeated kill-switch scrub timers from `module.js` (single startup cleanup retained). | *—* |
| 2026-03-21 | Phase 2 | Narrowed Diagnostic Center console wrapping to opt-in debug capture only (`__debugDiagnosticConsoleCapture`); default run no longer replaces global console methods. | *—* |
| 2026-03-21 | Phase 2 | Finished remaining debug-surface items: gated PIXI asset trace monkey-patches behind explicit debug mode/flag and removed `_suppressDiagConsoleLogs` global console wrapper. | *—* |
| 2026-03-21 | Phase 3 | Removed `manager-wiring` legacy `EFFECT_EXPOSURES` no-op loop tied to empty V2 `effectMap`; globals now come from direct refs only. | *—* |
| 2026-03-21 | Phase 3 | Produced `canvas-replacement` hook/wrapper inventory (30 `Hooks.on/once` registrations + draw/tearDown wrapper surfaces) to de-risk future recovery-path unwiring. | *—* |

---

## 13. Warning source triage (live log sample)

Goal: separate **Map Shine-owned** warnings from **engine/browser/system** output so the tidy-up targets the right items.

| Sample warning | Source classification | Evidence | Tidy-up ownership |
|---|---|---|---|
| `Map Shine Advanced | TokenMovementManager | [Pathfinding] _validatePathSegmentCollision blocked (...)` | **Map Shine module** | Emitted by `scripts/scene/token-movement-manager.js` via `_pathfindingLog('warn', ...)` | **Yes** (convert to debug/throttle/dedupe) |
| `Map Shine Advanced | InteractionManager | [Pathfinding] _handleRightClickMovePreview ...` (`waiting`, `not executed`, `succeeded`) | **Map Shine module** | Emitted by `scripts/scene/interaction-manager.js` via `_pathfindingLog('warn', ...)` | **Yes** (likely debug-level flow tracing) |
| `Map Shine Advanced | DustEffectV2 | no spawn points found ...` | **Map Shine module** | Emitted by `scripts/compositor-v2/effects/DustEffectV2.js` `log.warn(...)` | **Yes** (decide: expected condition -> debug/info) |
| `Map Shine Advanced | FloorCompositor | warmupAsync: shader compilation timed out ...` | **Map Shine module** | Emitted by `scripts/compositor-v2/FloorCompositor.js` `log.warn(...)` | **Yes** (rate-limit, gate, or keep as high-signal warn) |
| `Map Shine Advanced | Canvas | [loading] createThreeCanvas heartbeat [diag=step-tracker-v1] ...` | **Map Shine module** | Emitted by `scripts/foundry/canvas-replacement.js` heartbeat log lines | **Yes** (gate to debug mode / reduce cadence) |
| `Error: BaseGrid#getTopLeft is deprecated ...` (+ `getGridPositionFromPixels`, `getPixelsFromGridPosition`) | **Foundry deprecation triggered by Map Shine call path** | Stack traces point into `scripts/compositor-v2/effects/MovementPreviewEffectV2.js` line using `grid.getTopLeft(...)` | **Yes** (code fix in Map Shine call site) |
| `THREE.WebGLRenderer: KHR_parallel_shader_compile extension not supported.` | **three.js / driver capability report** | Logged by three vendor runtime when extension unavailable | **No direct suppression target** (can optionally document once) |
| `THREE.WebGLProgram: Program Info Log: ... potentially uninitialized variable ...` | **GPU shader compiler / three.js** | Logged by three WebGL program compile path | **Usually no** (investigate only if rendering defect) |
| `Invalid URI. Load of media resource failed.` | **Browser/asset URL/runtime data** | Browser media loader error; not uniquely attributable in sample | **Not module-specific by default** (triage broken asset path separately) |

**Net result for this tidy-up pass:** treat the `Map Shine Advanced | ...` warnings and the Foundry deprecation chain rooted in `MovementPreviewEffectV2` as in-scope; keep pure three.js/browser capability logs out of warning-cleanup scope unless they correlate with user-visible breakage.

---

## 14. `canvas-replacement.js` hook / wrapper inventory (Phase 3)

This inventory is for safe unwiring later: what is registered, where, and what role it plays.

### A) Foundry hook registrations (`Hooks.on/once`)

- **Total current registrations in this file:** `30` (`Hooks.on/once` grep count).
- **Core canvas lifecycle**
  - `canvasConfig` -> PIXI config setup + early diagnostics/bootstrap.
  - `canvasInit` -> texture-loader trace retry, PIXI trace retry (now debug-gated), WebGL listener attach.
  - `drawCanvas` / `canvasDraw` / `canvasDrawn` -> lifecycle breadcrumbs and hang context.
  - `canvasReady` -> main MSA bring-up (`onCanvasReady`) plus template/drawing hydration schedules.
  - `canvasTearDown` -> cleanup/dispose path (`onCanvasTearDown`).
  - `updateScene` -> resize/rebuild path (`onUpdateScene`).
- **Template/drawing/wall hydration hooks**
  - `createDrawing`, `updateDrawing`, `deleteDrawing`
  - `createMeasuredTemplate`, `updateMeasuredTemplate`, `deleteMeasuredTemplate`
  - `createWall`, `updateWall`, `deleteWall`
  - `sightRefresh`
  - Purpose: deferred native overlay/template sync after scene mutations.
- **Input/mode integration hooks**
  - `changeSidebarTab`, `renderSceneControls`, `activateCanvasLayer`
  - Purpose: keep input mode arbitration in sync with Foundry UI/layer changes.
- **Level/elevation hooks**
  - `mapShineLevelContextChanged` (multiple callbacks)
  - `pauseGame`
  - `updateToken` (stored in `MapShine.__msaAshDisturbanceHookId` for teardown)
  - Purpose: elevation-aware updates, ambience refresh, ash disturbance, pause time sync.
- **Dynamic layer hook batch**
  - `_layerHookNames` loop (`canvasPan`, `lightingRefresh`, `initializeVisionSources`, etc.).
  - Purpose: extra breadcrumbs around draw/layer activity for incident diagnosis.
- **Sentinel one-shot**
  - `Hooks.once('canvasReady', _canvasReadySentinel)` inside draw wrapper.
  - Purpose: detect missing `canvasReady` and trigger recovery path.

### B) Wrapper / interception surfaces

- **`Canvas.prototype.draw` wrapper**
  - Installed by `installCanvasDrawWrapper()`.
  - Prefers `libWrapper.register(... 'Canvas.prototype.draw' ...)`, falls back to direct prototype wrap.
  - Role: hang watchdog + recovery when Foundry draw stalls/skips `canvasReady`.
- **`Canvas.prototype.tearDown` wrapper**
  - Installed by `installCanvasTransitionWrapper()`.
  - Prefers `libWrapper.register(... 'Canvas.prototype.tearDown' ...)`, falls back to direct prototype wrap.
  - Role: transition fade handling + non-fatal shielding around teardown exceptions.
- **Internal draw method wraps (version-dependent)**
  - `_draw`, `_drawBlank` wrapped when present (`_wrapInternal` path).
  - Role: extra diagnostics around internal draw path timing/failures.
- **Non-hook monkey patches in this file (now mostly debug-gated)**
  - Network diagnostics (`fetch`, `HTMLImageElement.src`) -> debug-gated.
  - PIXI asset trace (`PIXI.Assets.load`, `Texture.from`, `BaseTexture.from`) -> debug-gated.
  - Ambient sound audibility getter patch, Levels region behavior compat patch, etc. (functional compat patches; not just diagnostics).