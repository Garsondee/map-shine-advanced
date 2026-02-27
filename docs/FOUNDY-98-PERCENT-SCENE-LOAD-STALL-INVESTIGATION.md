# Foundry 98% Scene Load Stall — Investigation Log

## Summary
Foundry stalls at ~98% while loading the scene when Map Shine Advanced is enabled.

Key observation: **`Canvas.prototype.draw(scene)` is entered and returns quickly, but its returned Promise never resolves**. Because it never resolves, downstream lifecycle hooks (`drawCanvas`, `canvasReady`, `canvasDraw`/`canvasDrawn`) never fire, and Map Shine never reaches `onCanvasReady()` nor `createThreeCanvas()`.

This currently looks like a **Foundry draw pipeline hang** (or another module/wrapper deadlocking inside Foundry’s draw path).

## Repro Context
- **Scene**: `Levels Test`
- **Symptom**: Scene loading progress bar stops at ~98%
- **Module state**: Map Shine Advanced enabled

## Crisis Trace (latest)
```
Crisis #001 - module.js: module evaluation started
Crisis #007 - module.js: installed global error handlers
Crisis #002 - module.js: MODULE_ID set (map-shine-advanced)
Crisis #003 - module.js: MapShine global state object prepared
Crisis #004 - module.js: MapShine state exposed on window
Crisis #010 - Hooks.once('init'): handler entered
Crisis #011 - init: dynamic imports resolved
Crisis #012 - init: loading overlay + debug loading profiler assigned
Crisis #013 - init: scene settings registerSettings() about to run
Crisis #014 - init: scene settings registered
Crisis #015 - init: loadingOverlay.initialize() about to run
Crisis #016 - init: loadingOverlay.initialize() completed
Crisis #018 - init: loadingOverlay.showBlack() about to run
Crisis #019 - init: loadingOverlay.showBlack() completed
Crisis #021 - init: registerLevelNavigationKeybindings() completed
Crisis #022 - init: debugLoadingProfiler.debugMode synced
Crisis #023 - init: registerUISettings() completed
Crisis #030 - init: calling canvasReplacement.initialize()
Crisis #031 - init: canvasReplacement.initialize() about to run
Crisis #080 - canvas-replacement.js: initialize() entered
Crisis #085 - canvas-replacement.js: Hooks(canvasReady) handler registered
Crisis #086 - canvas-replacement.js: Hooks(canvasTearDown) handler registered
Crisis #087 - canvas-replacement.js: Hooks(updateScene) handler registered
Crisis #032 - init: canvasReplacement.initialize() returned
Crisis #024 - init: getSceneControlButtons hook fired
Crisis #082 - canvas-replacement.js: Hooks(canvasConfig) fired
Crisis #098 - canvas-replacement.js: canvasConfig safeCall: scene enabled; applying transparency config
Crisis #101 - Canvas.draw: entered (scene=Levels Test)
Crisis #114 - Canvas.draw: calling wrapped()
Crisis #115 - Canvas.draw: wrapped() returned (dtMs=1.0)
Crisis #083 - canvas-replacement.js: Hooks(canvasInit) fired
```

Notably missing:
- No `Crisis #040` (`Hooks.once('ready')`)
- No `Crisis #060+` (bootstrap entry)
- No `Crisis #084/#099/#100` (drawCanvas / canvasDraw / canvasDrawn)
- No `Crisis #088` (onCanvasReady)
- No `Crisis #102` (Canvas.draw resolved)

## Interpretation
### What we know
- `Canvas.draw(...)` is called.
- The wrapper’s `wrapped()` call returns in ~1ms (`dtMs=1.0`), so the hang is **not synchronous**.
- The returned promise is the thing that never resolves.

### Most likely
- Some awaited stage inside Foundry’s draw pipeline never resolves.
- This could be:
  - an asset load (image/texture) promise that never resolves
  - a module wrapper conflict
  - a deadlock due to an exception swallowed internally
  - a browser request blocked by a policy (fonts/remote assets)

## Current Instrumentation
### Map Shine
- `scripts/module.js`
  - Crisis logs #001..#059
  - Global handlers:
    - `window.onerror` → Crisis #005
    - `window.onunhandledrejection` → Crisis #006

- `scripts/core/bootstrap.js`
  - Crisis logs #060..#084

- `scripts/foundry/canvas-replacement.js`
  - Crisis logs #080..#100 for hook lifecycle
  - `Canvas.prototype.draw` wrapper:
    - Enter: #101
    - Pre-call: #114
    - Return-from-call: #115
    - Resolve: #102
    - Throw: #104
    - Hang timers: #103/#110/#111/#112
  - Optional internal wrappers (when present):
    - `Canvas._draw` (#105/#106/#107)
    - `Canvas._drawBlank` (#108/#109/#113)

---

## Deep Investigation — Round 2

### Code Audit Results

**What Map Shine does during Canvas.draw for enabled scenes:**

The ONLY thing Map Shine injects into the draw pipeline for enabled scenes is in the `canvasConfig` hook:
```js
config.transparent = true;
config.backgroundAlpha = 0;
```

Everything else (Canvas.draw wrapper, canvasInit breadcrumb, etc.) is logging-only and runs for ALL scenes.

**What Map Shine does NOT do during draw:**
- No hooks registered that fire between canvasInit and canvasReady
- No libWrapper registrations on internal draw methods (they're private `#` methods in v13)
- No texture loading or GPU work — bootstrap hasn't run yet (ready hook hasn't fired)
- `ControlsIntegration` hooks all guard on `state === ACTIVE`, which is false during draw
- `LevelsSnapshotStore` hooks (createTile, etc.) just set a variable to null — harmless

**Lifecycle ordering confirmed:**
1. `init` hook → canvas-replacement.js `initialize()` runs
2. Foundry calls canvasConfig → Map Shine sets transparency (for enabled scenes only)
3. `Canvas.draw` → our wrapper enters, calls `wrapped()` which returns a Promise
4. `canvasInit` fires (inside the async draw pipeline)
5. **HANG POINT** — Foundry's internal draw pipeline stops here
6. Never reaches: drawCanvas, canvasDraw, canvasDrawn, canvasReady
7. Never reaches: `ready` hook, bootstrap, Three.js initialization

### Suspect Theories (ranked by likelihood)

1. **Stalled texture/asset load** — Foundry's draw pipeline loads the scene background
   texture and tile textures. If any image request hangs (bad path, CORS, infinite
   redirect, oversized file), the draw Promise will never resolve. The new network
   diagnostics intercept `fetch()` and `Image.src` to detect this.

2. **`config.transparent = true` incompatible with PIXI v8** — Foundry v13 uses PIXI v8,
   which does NOT have a `transparent` config option. Setting an unexpected property
   could cause PIXI's initialization to behave unexpectedly. `backgroundAlpha: 0` is
   the correct v8 approach and is already set. The `transparent = true` may be a
   red herring or could cause subtle issues depending on how Foundry processes the
   config object.

3. **Scene data corruption** — If Map Shine saved extremely large flag data to the
   scene (e.g., map points, effect settings), the scene document could be slow to
   process. The new diagnostics log flag sizes to detect this.

4. **WebGL context conflict** — Unlikely at this stage since Map Shine's Three.js
   renderer hasn't been created yet (bootstrap hasn't run). PIXI is creating its
   own context during draw.

5. **Another module conflict** — Possible but less likely since "it just stopped
   working." The draw wrapper uses libWrapper WRAPPER mode which should chain
   correctly with other modules.

### New Evidence (Feb 26)

Captured trace shows a **hard freeze** immediately after `canvasInit`.

Key observations:
- `Canvas.draw` wrapper logs `wrapped() returned (dtMs=0.0)`.
- We log `Crisis #116` (immediate snapshot) and `Crisis #083a` (canvasInit snapshot).
- **No further logs** occur after a single `Hooks(canvasPan)` breadcrumb.
- Importantly: **no periodic `Crisis #200` poll ever fires** (first tick is at 2s).

Interpretation:
- This is consistent with a **synchronous freeze / GPU driver stall / PIXI renderer initialization crash**.
- It is *not* consistent with "awaited image promise never resolves" (in that case, the 2s interval poller would keep printing).

Follow-up result:
- Disabling all Map Shine V2 effects via the new Circuit Breaker Panel did **not** change the freeze behavior.
- This strongly suggests the failure occurs **before Map Shine effects initialize** (i.e., within Foundry/PIXI canvas init or core asset loading).

Additional notes from the captured `canvasConfig` diagnostics:
- `config keys BEFORE modify`: includes `transparent` (currently `false`) plus PIXI-ish fields (`resolution`, `autoDensity`, `powerPreference`).
- `scene bg` printed as `null` (scene has no background src at that stage), so this freeze is unlikely to be a blocked background image request.
- `MSA flags size` ~28KB — not a corruption-sized payload.

### New Instrumentation Added

**`scripts/foundry/canvas-replacement.js`:**

- **Crisis #098a-c** — Config object state before/after transparency modification
- **Crisis #098d** — Scene data diagnostics: background path, MSA flag keys + sizes, total flag sizes
- **Crisis #098e** — Warning for any MSA flag > 100KB (corruption detection)
- **Crisis #098f-h** — Background image accessibility test (fires async, reports load/error/stall)
- **Crisis #098i** — Error reading scene diagnostics
- **Crisis #098j** — Bypass transparency notification
- **Crisis #083a** — Full canvas state snapshot at canvasInit time
- **Crisis #116** — Full canvas state snapshot immediately after wrapped() returns
- **Crisis #200** — Periodic state poller (every 2s while draw is pending):
  - Canvas loading/ready state
  - All layer existence + child counts
  - PIXI app/renderer state
  - WebGL context lost check
  - Primary canvas texture state (background sprite, texture valid/dimensions)
  - Pending fetch count + stalled fetch URLs (>1s old)
  - Pending image count + stalled image URLs (>1s old)
  - JS heap usage (Chrome only)
- **Crisis #210** — Layer-level hooks: canvasPan, lightingRefresh, sightRefresh,
  initializeVisionSources, initializeLightSources, drawGridLayer, refreshTile,
  refreshToken, drawTile, drawToken, drawWall, drawLight

**Network diagnostics (global):**
- `fetch()` interceptor: tracks all pending fetches with URL + start time
- `Image.src` interceptor: tracks all pending image loads with src + start time
- Both clean up on resolve/reject/load/error

### Bypass Mechanism

To test whether the transparency config is the cause:
```js
// Run in browser console BEFORE loading the scene:
localStorage.setItem('msa-crisis-skip-transparent', '1');
// Then reload. Map Shine will skip config.transparent and config.backgroundAlpha.
// To re-enable:
localStorage.removeItem('msa-crisis-skip-transparent');
```

When active, logs `Crisis #098j` and skips the transparency config entirely.

### Mitigation Applied (Code Change)

Because the freeze correlates with the enabled-scene-only `canvasConfig` mutation, we changed the default behavior:

- Always set `config.backgroundAlpha = 0`.
- **Do NOT set `config.transparent = true` when PIXI v8+ is detected** (Foundry v13).

Debug overrides:
```js
// Skip ALL transparency config:
localStorage.setItem('msa-crisis-skip-transparent', '1');

// Force config.transparent=true anyway (for A/B testing):
localStorage.setItem('msa-crisis-force-transparent', '1');
```

Expected outcome:
- If the freeze disappears, the root cause is very likely **PIXI/driver instability triggered by `transparent=true`**.

## Immediate Next Steps

1. **Reproduce and collect new diagnostics**

---

## Deep Investigation — Round 3 (Feb 27)

### Scene/world data sanity

Added early diagnostics in `scripts/module.js` to inspect the active scene during `canvasConfig` and `canvasInit`.

Observed (Levels Test):
- Counts are small and normal: `tokens=1`, `tiles=2`, `walls=59`, `lights=0`.
- Flag payload is modest: `all=28413 bytes`, `msa=28140 bytes`.
- No suspicious numeric values detected (no NaN/Infinity/extreme coordinates).

Conclusion: this does **not** look like corrupted scene/world JSON.

### Asset pipeline hypothesis strengthened

Installed a wrapper on Foundry’s texture loader:

- `Crisis #084c - TextureLoader trace installed (wrapped foundry.canvas.TextureLoader.loader.load)`

On repro, Foundry enters:

- `Crisis #085a - TextureLoader.load: entered (count=57, message=SCENE.Loading)`

And we capture the full list of 57 texture sources (including module scene textures, `canvas/tokens/rings-bronze.json`, tokenizer asset, svg icons, PF2e condition icons).

However:
- `TextureLoader.load(...)` never logs `resolved` (`Crisis #085d` is absent)
- Per-asset tracing via `TextureLoader.loader.loadTexture` is still not active (no `Crisis #084d` / `Crisis #086*` logs)

Conclusion: the hang is likely inside the per-asset loading path, but we still need to determine *which* asset is stalling.

### Next instrumentation step

- Add explicit diagnostics to explain why `loader.loadTexture` wrapping is not occurring (method missing or not a function).
- Ensure PIXI `Assets.load` start/resolve/stall tracing is active and visible so we can pinpoint the exact asset.
   - Load the failing scene and copy the FULL console output
   - Key things to look for:
     - **Crisis #200 polls**: Do they fire? (async hang) Or does the tab freeze? (sync hang/crash)
     - **Crisis #098d**: Are MSA flags unusually large? (>1MB = corruption)
     - **Crisis #098f/g/h**: Does the background image load, fail, or stall?
     - **Stalled fetches/images**: What URLs are pending?
     - **WebGL context lost**: Is the GL context dying?
     - **JS heap**: Is memory growing unbounded?

2. **Test the transparency bypass**
   - Set `localStorage.setItem('msa-crisis-skip-transparent', '1')` in console
   - Reload — if the scene loads, the transparency config is the culprit
   - This would point to a PIXI v8 incompatibility with `config.transparent = true`

3. **Test with a fresh Map Shine–enabled scene**
   - Create a new scene, enable Map Shine, set a simple background image
   - If this loads fine, the original scene's data is likely corrupted

4. **Check browser Network tab**
   - Before loading the scene, open DevTools → Network tab
   - Look for pending/stalled requests (red or grey entries)
   - Pay special attention to image requests with no response

5. **Disable other modules**
   - Load with ONLY Map Shine + libWrapper enabled to rule out conflicts

6. **Enable Safe PIXI Mode (new)**
   - Purpose: reduce GPU pressure during Foundry's PIXI init + "Loading Assets" phase.
   - In console BEFORE loading the scene:
```js
localStorage.setItem('msa-crisis-safe-pixi', '1');
location.reload();
```
   - Look for `Crisis #097a` in console.
   - If this stabilizes loading, the root is likely **GPU/driver instability** during PIXI init.

7. **Watch for WebGL context loss events (new)**
   - We now attach `webglcontextlost` / `webglcontextrestored` listeners to the PIXI canvas at `canvasInit`.
   - Look for:
     - `Crisis #320 - PIXI webglcontextlost fired`
     - `Crisis #321 - PIXI webglcontextrestored fired`
   - If #320 occurs prior to freeze, the failure is definitively WebGL-context-related.

---

## Deep Investigation — Round 4 (Feb 27): ROOT CAUSE FOUND

### Symptom (updated)

Loading freezes at **0%** — the pill-shaped loading elements never appear. The
browser tab hard-freezes (event loop blocked). This only affects scenes where
Map Shine Advanced is enabled.

### Differential analysis

Traced every code path that runs between module evaluation and `canvasReady`.
The **only** code that differs for MSA-enabled scenes before `canvasReady` is
the `canvasConfig` hook handler. Specifically, the "Safe PIXI Mode" block
(lines 725-765) which was hardcoded ON as a temporary crisis measure.

For enabled scenes it applied:
- `config.antialias = false`
- `config.autoDensity = false`
- `config.resolution = 1`
- **`config.powerPreference = 'low-power'`** ← ROOT CAUSE

For non-enabled scenes: none of these applied.

### Root cause: `powerPreference = 'low-power'`

On Windows with dual GPUs (integrated Intel + discrete NVIDIA/AMD), setting
`powerPreference: 'low-power'` tells the browser to create the WebGL context
on the **integrated GPU**. This causes:

1. **Driver-level GPU switch stall** during context creation or first texture upload
2. **VRAM exhaustion** on the weaker GPU when loading scene textures
3. **Synchronous driver hang** that blocks the event loop entirely

This is consistent with ALL observed evidence:
- Hard freeze (Crisis #200 polls never fire → event loop blocked)
- Only MSA-enabled scenes affected (only they get canvasConfig modifications)
- Occurs before any MSA effects initialize (during Foundry's PIXI texture loading)
- Circuit Breaker (disabling V2 effects) had no impact (those run much later)

The Safe PIXI mode was intended as a temporary crisis mitigation but was left
hardcoded-on, ironically causing the exact class of freeze it was designed to prevent.

### Fix applied

Removed from `canvasConfig`:
- `config.powerPreference = 'low-power'` (dangerous GPU switch)
- `config.autoDensity = false` (breaks PIXI v8 canvas sizing)
- `config.resolution = 1` clamp (may conflict with Foundry's DPI handling)

Kept:
- `config.antialias = false` (harmless, reduces GPU work)
- `config.backgroundAlpha = 0` (essential for MSA transparency)

File: `scripts/foundry/canvas-replacement.js`

### Verification

Syntax check passes: `node --experimental-default-type=module --check scripts/foundry/canvas-replacement.js`

Manual test needed: load an MSA-enabled scene and confirm it no longer freezes at 0%.

---

## Deep Investigation — Round 5 (Feb 27): Foundry Source Code Analysis

### Previous WebGL context loss hypothesis — DISMISSED

WebGL context loss messages (`isWebGLSupported.ts:43:37`) are **normal** in Foundry VTT
and appear on every session. They are NOT the cause of the loading stall. The real root
cause is somewhere in the asset loading pipeline itself.

### Foundry's asset loading pipeline (from source)

Traced through Foundry's own source code (`client/canvas/board.mjs` + `client/canvas/loader.mjs`):

```
Canvas.#draw(scene)
  → tearDown()
  → canvasInit hook
  → #loadTextures()
      → TextureLoader.loadSceneTextures(scene, options)
          → loader.load(toLoad, { message: "SCENE.Loading", expireCache: true, ... })
              → De-dupe sources into Set
              → console.groupCollapsed("... Loading N Assets")
              → For each src: create promise via internal loadTexture closure
              → await Promise.allSettled(promises)   ← HANGS HERE
              → console.groupEnd()
              → expireCache / enforceMemoryLimit
```

Each individual `loadTexture` closure:
```js
const loadTexture = async src => {
    try {
        await this.loadTexture(src);   // calls PIXI.Assets.load(src) internally
        TextureLoader.#onProgress(src, progress);
    } catch(err) {
        TextureLoader.#onError(src, progress, err);
    }
};
```

**Critical finding**: `Promise.allSettled` only resolves when ALL promises settle. Each
promise has try/catch, so rejections are handled. The ONLY way to hang is if at least one
`PIXI.Assets.load(src)` returns a promise that **never resolves or rejects**.

### Per-asset sources (from previous logs)

The 57 assets include:
- Module scene textures (`modules/mythica-machina-flooded-river-prison/assets/...`)
- `canvas/tokens/rings-bronze.json` (spritesheet)
- Tokenizer images (`tokenizer/pc-images/...`)
- PF2e condition icons (`systems/pf2e/icons/conditions/*.webp`)
- SVG icons (`icons/svg/*.svg`)
- Control icons

### New instrumentation added

The `TextureLoader.load()` wrapper now **temporarily monkey-patches `loader.loadTexture`**
directly inside the load wrapper, guaranteeing per-asset visibility regardless of whether
the standalone loadTexture wrapper installs. Each asset gets:

- `Crisis #086a - loadTexture START: {url}` — asset load begins
- `Crisis #086b - loadTexture RESOLVED in {ms}ms: {url}` — asset loaded OK
- `Crisis #086c - loadTexture STALLED after 15000ms: {url}` — asset hung for 15s
- `Crisis #086d - loadTexture REJECTED in {ms}ms: {url}: {error}` — asset failed

The 10-second stall warning (`Crisis #085i`) now shows the **count and names** of still-
pending assets. The 60-second safety timeout (`Crisis #085j`) logs the **exact list** of
assets that never completed.

### What to look for in the console

1. Expand the collapsed group `"Foundry VTT | Loading N Assets"`
2. Look for `Crisis #086a` (START) without a matching `Crisis #086b` (RESOLVED)
3. After 15s, `Crisis #086c` will fire for the stalled asset(s)
4. After 60s, `Crisis #085j` will list ALL pending assets and force-resolve

The stalled asset URL(s) will tell us whether this is:
- A missing file (404 that PIXI doesn't reject)
- A spritesheet with a bad base texture reference
- A CORS issue on a specific domain
- A malformed URL from scene data

### Also applied (defense-in-depth, kept regardless)

- **FIX C**: Three.js renderer disposed + WebGL context released during teardown
  (`forceContextLoss()` + `dispose()` + clear `MapShine.renderer`)
- **FIX A**: PIXI WebGL context health check before loading (wait up to 5s if lost)
- **FIX B**: 60-second safety timeout that force-resolves to prevent permanent freeze

## Notes
- This log is intentionally an evolving document. Add new crisis traces and outcomes of each next-step test.
- The diagnostic poller interval is cleaned up automatically when draw resolves/throws, so it won't leak on successful loads.
- The network interceptors are installed once globally and persist for the session (no cleanup needed, minimal overhead).

---

## Root Cause Identified — Feb 27 2026

### Stalling asset confirmed

The `Crisis #085j - SAFETY TIMEOUT` trace finally produced an actionable result:

```
Crisis #085j - 1 assets still pending:
  ["modules/mythica-machina-flooded-river-prison/assets/mythica-machina-flooded-river-prison-FirstFloor.png"]
```

Only **one** of the 57 assets Foundry tried to load never resolved. All 56 others completed successfully. The stall was 100% attributable to this single file.

### Why a missing file causes a hang (not a fast-fail)

The fundamental issue is that **Foundry's PIXI-based `TextureLoader.loadTexture()` does not reliably reject on 404 or server errors**. The observed failure mode is:

1. Foundry calls `TextureLoader.load([...57 assets...])`, which internally calls `loadTexture(src)` for each asset.
2. `loadTexture` uses PIXI's `Assets.load()` pipeline for image formats.
3. When the file is missing (404), some code paths in PIXI v8's asset loader return a **pending promise that never settles** — neither resolved nor rejected. This is a PIXI loader edge case with 404s on some asset types/formats.
4. `TextureLoader.load()` awaits all per-asset promises before resolving. One hung promise means the whole batch hangs forever.
5. Foundry's `Canvas.#loadTextures()` awaits `TextureLoader.load()`. It too hangs.
6. `Canvas.#draw()` awaits `#loadTextures()`. It too hangs.
7. The scene never reaches `canvasReady`, so Map Shine's `onCanvasReady()` and `createThreeCanvas()` never run.

The loading bar stalls at ~98% because everything else in the draw pipeline has completed — only the texture batch is still blocked.

### Why the file was missing

The file `...FirstFloor.png` was intentionally deleted from the server as part of content management. The scene document still references it. Foundry has no pre-flight check for missing assets before calling `TextureLoader.load()`.

### Why this went unnoticed previously

- In most browser + server combinations, a 404 on an image eventually rejects or fires an `onerror` event that PIXI catches, causing a fast-fail.
- In this environment (Firefox + specific server config), the 404 response triggers a path in PIXI's asset loader that creates a promise which **silently never settles**. There is no timeout built into PIXI's `Assets.load()` for individual assets.
- The lack of a per-asset timeout meant the global scene load could stall indefinitely.

---

## Fix Applied

### Safe texture boot mode (`canvas-replacement.js`)

Added a permanent, **default-on** guard inside the `_installFoundryTextureLoaderTrace()` wrapper that intercepts every individual `loadTexture(src)` call:

- Each asset load is wrapped in a `Promise.race([originalLoad, timeout])`.
- **Timeout: 12 seconds per asset** (safe mode), **60 seconds per asset** (raw mode).
- On timeout: logs `Crisis #086c - loadTexture STALLED` and returns `PIXI.Texture.WHITE` placeholder.
- On rejection (error thrown): logs `Crisis #086d - loadTexture FAIL` and returns `PIXI.Texture.WHITE` placeholder.
- The scene continues loading with a white/empty placeholder where the missing texture would have been.
- The global `TextureLoader.load()` safety timeout is also reduced from 60s → 20s when safe mode is active (belt-and-suspenders).

Safe mode is **enabled by default**. To disable (e.g. to reproduce original hang for diagnostics):

```js
localStorage.setItem('msa-crisis-safe-textures', '0');
location.reload();
```

### What this means in practice

- A GM can delete or move a referenced tile/token/scene image and the scene will still boot.
- The missing asset renders as white/blank rather than blocking the entire session.
- All existing `Crisis #086*` diagnostic logs remain in place and will fire with the URL of any problematic asset, making future triage fast.

### What this does NOT fix

- The underlying PIXI v8 bug where a 404 produces a never-settling promise. That is a PIXI/Foundry issue, not something we can patch from a module.
- Stale scene document references to deleted files — those should be cleaned up via the scene/tile editor.
- The Map Shine safe-boot only guards Foundry's `TextureLoader` batch. If other module code or Foundry systems directly await PIXI `Assets.load()` outside this wrapper, those can still hang. This is mitigated by the overall 20s global fallback.
