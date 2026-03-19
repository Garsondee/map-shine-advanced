# Compendium Import Silent Failure — Investigation

## Symptom

When a user first imports a scene from a compendium (which is Map Shine Advanced based),
the scene **does not load at all** — it fails silently. No error is shown to the user.

After restarting Foundry VTT, the same scene loads normally.

---

## Key Code Paths Involved

### 1. Adventure Import Lifecycle

```
preImportAdventure hook  →  Foundry creates/updates scene documents  →  importAdventure hook
```

- **`preImportAdventure`** (`module.js:1327`): Diagnostic logging + `_injectMSASidecarData()`
  which tries to inject MSA scene/tile flags from two sources:
  - Source 1: Adventure's own top-level flags (`adventure.flags['map-shine-advanced'].sceneConfig`)
  - Source 2: Pre-fetched sidecar JSON (`modules/{id}/packs/msa-data.json`)
  - **Both require explicit authoring steps by the map author** — if neither source exists,
    no injection happens.

- **`importAdventure`** (`module.js:1361`): Post-import verification. Iterates created/updated
  scenes, calls `hasImpliedMapShineConfig(scene)`, and if true, fire-and-forget
  `scene.setFlag(NS, 'enabled', true).catch(() => {})`.

### 2. Scene Navigation After Import

```
User clicks scene  →  Canvas.draw(scene)  →  [MSA wrapper]  →  canvasReady  →  onCanvasReady  →  createThreeCanvas
```

- **Canvas.draw wrapper** (`canvas-replacement.js:2190`): Wraps Foundry's `Canvas.prototype.draw`.
  Has hang watchdog (8s), recovery for missing canvasReady, and error recovery.
  **All recovery paths are gated by `isEnabled(scene)`** — if false, no MSA recovery fires.

- **`onCanvasReady`** (`canvas-replacement.js:2898`): Checks `isEnabled(scene)`.
  If false → UI-only mode (no Three.js canvas). If true → `createThreeCanvas(scene)`.

- **`createThreeCanvas`** (`canvas-replacement.js:3409`): Full MSA initialization pipeline.
  Has `_createThreeCanvasRunning` concurrency guard. If already running, subsequent calls
  are **silently dropped**.

### 3. `isEnabled()` — The Critical Gate

```js
// scene-settings.js:208
export function isEnabled(scene) {
  const val = scene.getFlag(FLAG_NAMESPACE, 'enabled');
  if (val === true) return true;

  // Auto-detect pre-configured scenes
  if (hasImpliedMapShineConfig(scene)) {
    _silentlyPersistEnabled(scene);  // fire-and-forget
    return true;
  }

  return false;
}
```

`hasImpliedMapShineConfig()` checks for:
- `settings.mapMaker` block present
- `mapPointGroups` has entries
- `mapPointGroupsInitialized` is true

---

## Theories (Ordered by Likelihood)

### Theory 1: MSA Flags Lost During Import → `isEnabled()` Returns False → Foundry Draw Fails with No MSA Recovery

**Likelihood: HIGH — this is the most complete explanation**

**Chain of events:**

1. Map author configures MSA scene and exports to Adventure pack
2. During Foundry's server-side Adventure serialization, MSA flags on the embedded scene
   are stripped or lost (see existing investigation in `PACKAGED-MAP-ENABLE-FLAG-BUG.md` —
   empirically observed despite client source code suggesting they should survive)
3. **Neither injection source is available:**
   - Map author hasn't run the console snippet to save config to Adventure's own top-level flags
   - Map author hasn't created a `msa-data.json` sidecar file
4. `preImportAdventure` → `_injectMSASidecarData()` finds no source → no injection
5. `importAdventure` → `hasImpliedMapShineConfig(scene)` returns **false** (no flags) →
   `setFlag('enabled', true)` is **never called**
6. User navigates to the scene → `Canvas.draw()` fires
7. Foundry's internal draw may **fail or hang** because:
   - The scene was designed for MSA with specific tile layouts, overhead tile configurations,
     or mask texture references that Foundry doesn't know how to handle natively
   - Missing texture references that MSA would normally resolve via its own loader
   - Tile elevation/Levels flags that confuse vanilla Foundry rendering
8. **Canvas.draw wrapper detects the issue** (hang timeout, missing canvasReady, or throw)
9. Wrapper checks `isEnabled(scene)` → returns **false** (no flags, no implied config)
10. **Recovery path does NOT fire** — the wrapper lets Foundry keep hanging or propagates the error
11. **Result**: Scene is stuck. Loading overlay may remain, or screen goes black.

**Why restart fixes it:**

This theory alone does NOT explain why restart fixes it — unless during the failed first
attempt, some partial state is written that helps on the second try. Likely combined with
Theory 2 or 3 below.

However, if the flags DO survive import (just not reliably detected on first access), restart
causes Foundry to reload all documents fresh from the database, ensuring flags are present.

---

### Theory 2: Flags Survive Import but In-Memory Scene Object Is Stale on First Navigation

**Likelihood: HIGH — explains the "works after restart" behavior**

**Chain of events:**

1. Flags DO survive the Adventure import (consistent with Foundry source code analysis)
2. `importAdventure` hook fires → `hasImpliedMapShineConfig(scene)` returns **true** →
   `scene.setFlag(NS, 'enabled', true)` is called (fire-and-forget)
3. User immediately navigates to the scene **before** `setFlag` resolves
4. Foundry calls `Canvas.draw(scene)` — the `scene` parameter at this point is a
   Scene document from the world collection. Its in-memory flags state depends on
   whether the `setFlag` database write has completed AND propagated back to the
   in-memory document.
5. **Critical race**: `isEnabled()` runs in the `canvasConfig` hook and `onCanvasReady`.
   - `getFlag('enabled')` → may return `undefined` if setFlag hasn't completed
   - `hasImpliedMapShineConfig()` → should return true IF the scene's in-memory flags
     include the authoring data. But there's a subtle issue: Foundry's document update
     cycle from `setFlag` may trigger a document re-render that temporarily clears or
     invalidates the in-memory cache.
6. If the timing is wrong, `isEnabled()` returns **false** at the critical moment
7. MSA enters **UI-only mode** (no Three.js canvas)
8. Foundry's PIXI canvas draws the scene, but:
   - PIXI was already hidden by the `canvasConfig` hook (if MSA was detected earlier)
   - OR the scene simply doesn't render correctly without MSA's Three.js pipeline
9. User sees a blank/black screen or stuck loading overlay

**Why restart fixes it:**
After restart, the `enabled` flag (set by `setFlag` in step 2) IS persisted in the
database. Foundry loads the scene fresh from DB → `getFlag('enabled')` returns `true`
immediately → `isEnabled()` returns true on the first check → full MSA init proceeds.

---

### Theory 3: `_createThreeCanvasRunning` Concurrency Guard Gets Stuck

**Likelihood: MEDIUM — explains "silent" aspect of the failure**

```js
// canvas-replacement.js:3413
if (_createThreeCanvasRunning) {
    log.warn('[loading] createThreeCanvas already in progress — ignoring concurrent call');
    return;  // ← SILENT DROP
}
_createThreeCanvasRunning = true;
```

**Chain of events:**

1. Import completes, user navigates to scene
2. `createThreeCanvas` starts running (first call)
3. Something inside the init pipeline hangs or takes too long:
   - `sceneComposer.initialize()` waiting for texture loads
   - `_waitForFoundryCanvasReady()` polling for 15 seconds
   - `FloorCompositor.prewarmForLoading()` waiting for async populate
   - Shader compilation gate waiting for programs
4. While `createThreeCanvas` is still running, a second trigger fires:
   - Scene update from `_silentlyPersistEnabled()` triggers a canvas redraw
   - Recovery timeout fires another `onCanvasReady` call
   - The user tries navigating again
5. Second call hits `_createThreeCanvasRunning` guard → **silently dropped**
6. First call eventually fails or times out but the loading overlay doesn't dismiss
   (the `finally` block resets `_createThreeCanvasRunning` but the scene is in a broken state)

**Why restart fixes it:**
Fresh module state. `_createThreeCanvasRunning` is `false` by default. The first call
succeeds without contention.

---

### Theory 4: `_silentlyPersistEnabled()` Triggers a Canvas Redraw Mid-Initialization

**Likelihood: MEDIUM**

When `isEnabled()` auto-detects a pre-configured scene, it calls `_silentlyPersistEnabled(scene)`:

```js
function _silentlyPersistEnabled(scene) {
  Promise.resolve().then(async () => {
    try {
      await scene.setFlag(FLAG_NAMESPACE, 'enabled', true);
    } catch (_) {}
  });
}
```

`scene.setFlag()` modifies the scene document. In Foundry, modifying a scene document can
trigger `updateScene` hooks. If any hook listener or Foundry internal code calls `canvas.draw()`
in response to a scene document change, this would:

1. Trigger `Canvas.tearDown()` while MSA is mid-initialization
2. Then trigger `Canvas.draw()` again
3. `onCanvasReady` fires again → `createThreeCanvas` is already running → **silently dropped**
4. When the first `createThreeCanvas` completes, it may be operating on stale state (the
   tearDown may have cleared resources it needs)

**Why restart fixes it:**
After restart, `enabled` is already `true` in the database. `isEnabled()` returns true
immediately from `getFlag()` without calling `_silentlyPersistEnabled()`. No mid-init
document mutation occurs.

---

### Theory 5: Foundry's Canvas.draw() Hangs Due to Missing/Unresolved Asset Paths

**Likelihood: MEDIUM**

Freshly imported scenes reference asset paths (tiles, background) that point to module
directories. On first import within a session:

1. Foundry's internal file system index may not yet include newly registered module assets
2. PIXI's texture loader attempts to load the scene background → resolves the URL, but
   the server hasn't fully indexed the file yet → 404 or timeout
3. Foundry's `Canvas.#draw()` catches the error from the tile/background load and
   **returns early** → `canvasReady` never fires
4. MSA's Canvas.draw wrapper detects missing canvasReady, but if `isEnabled()` returns
   false → no recovery

This specifically affects scenes where textures are stored in the compendium module's
directory structure and the module was installed/activated in the same session as the import.

**Why restart fixes it:**
After restart, Foundry rebuilds its complete file index during startup, including all
module assets. Texture loads succeed. `Canvas.draw()` completes normally. `canvasReady`
fires. MSA initializes.

---

### Theory 6: WebGL Context Exhaustion

**Likelihood: LOW-MEDIUM — only applies if user was viewing an MSA scene before importing**

If the user imports the adventure while viewing an MSA-enabled scene:

1. Three.js WebGL renderer context is active (from current scene)
2. User navigates to the imported scene → `Canvas.tearDown()` fires
3. `destroyThreeCanvas()` should release the context, but if `renderer.forceContextLoss()`
   fails or the cleanup races with PIXI's context creation...
4. Browser hits the WebGL context limit (Three + PIXI + probe = 3 contexts)
5. PIXI's context is lost → `TextureLoader.load()` hangs forever
6. `Canvas.draw()` never completes → permanent hang

**Why restart fixes it:**
Fresh browser tab → all WebGL contexts are released → only one context at a time.

---

## Diagnostic Recommendations

### 1. Add Targeted Logging to Identify Which Theory Is Active

Add console logging at these critical decision points:

```
[MSA-IMPORT-DIAG] importAdventure: hasImpliedMapShineConfig={true/false} for scene "{name}"
[MSA-IMPORT-DIAG] importAdventure: setFlag fired for scene "{name}"
[MSA-IMPORT-DIAG] canvasConfig: isEnabled={true/false} for scene "{name}"
[MSA-IMPORT-DIAG] onCanvasReady: isEnabled={true/false} for scene "{name}"
[MSA-IMPORT-DIAG] Canvas.draw wrapper: isEnabled={true/false}, canvasReadyFired={true/false}
[MSA-IMPORT-DIAG] _createThreeCanvasRunning={true/false} at entry
```

### 2. Check If `_silentlyPersistEnabled` Is Causing a Redraw

Log inside `_silentlyPersistEnabled` before and after the `setFlag` call:
```
[MSA-IMPORT-DIAG] _silentlyPersistEnabled: about to setFlag
[MSA-IMPORT-DIAG] _silentlyPersistEnabled: setFlag completed
```

### 3. Reproduce with Browser DevTools Console Open

The existing crisis logging (`_msaCrisisLog`) should show breadcrumbs. Look for:
- Whether crisis log 94 fires (scene not enabled → UI-only mode)
- Whether crisis log 95 fires (createThreeCanvas entered)
- Whether "createThreeCanvas already in progress" warning appears
- Whether "Canvas.draw() hang watchdog" warning appears
- Whether "Canvas.draw() completed but canvasReady never fired" warning appears

---

## Proposed Fixes (Ordered by Impact)

### Fix 1: Make `importAdventure` Hook's `setFlag` Blocking (Not Fire-and-Forget)

**Addresses: Theory 2 (race condition)**

The current fire-and-forget `setFlag` creates a race where the user can navigate before
the flag is persisted. Change to blocking:

```js
Hooks.on('importAdventure', async (adventure, formData, created, updated) => {
  const NS = 'map-shine-advanced';
  const scenes = [...(created?.Scene ?? []), ...(updated?.Scene ?? [])];
  for (const scene of scenes) {
    if (!sceneSettings.hasImpliedMapShineConfig(scene)) continue;
    const enabled = scene.getFlag(NS, 'enabled');
    if (enabled !== true) {
      try {
        await scene.setFlag(NS, 'enabled', true);  // AWAIT instead of fire-and-forget
      } catch (e) {
        console.warn('Map Shine: failed to auto-enable imported scene:', e);
      }
    }
  }
});
```

**Note**: Foundry's `importAdventure` hook may or may not support async handlers. If it
doesn't await the handler, we need a different approach (e.g., showing a "preparing scenes"
dialog).

### Fix 2: Guard `_silentlyPersistEnabled` Against Mid-Init Execution

**Addresses: Theory 4 (mid-init redraw)**

Defer the `setFlag` call until AFTER `createThreeCanvas` completes:

```js
function _silentlyPersistEnabled(scene) {
  // Don't mutate the scene document while createThreeCanvas is running.
  // The setFlag can trigger updateScene hooks which re-fire Canvas.draw().
  if (_createThreeCanvasRunning) {
    // Queue for after init completes
    _pendingSilentEnable = scene;
    return;
  }
  Promise.resolve().then(async () => { /* ... existing ... */ });
}
```

And in `createThreeCanvas`'s `finally` block:
```js
if (_pendingSilentEnable) {
  const s = _pendingSilentEnable;
  _pendingSilentEnable = null;
  _silentlyPersistEnabled(s);
}
```

### Fix 3: Make Canvas.draw Recovery Work Even When `isEnabled()` Returns False

**Addresses: Theory 1 (flags lost, no recovery)**

Instead of gating recovery purely on `isEnabled()`, also check if the scene has MSA
tile content (tile texture paths with MSA suffixes like `_Specular`, `_Outdoors`, etc.):

```js
function _sceneHasMSATileContent(scene) {
  try {
    const tiles = scene?.tiles ?? [];
    for (const tile of tiles) {
      const src = tile?.texture?.src ?? '';
      if (src.includes('_Specular') || src.includes('_Outdoors') || src.includes('_Fire'))
        return true;
    }
  } catch (_) {}
  return false;
}
```

Use this as a secondary check in the Canvas.draw wrapper recovery paths.

### Fix 4: Add a Hard Timeout to `createThreeCanvas`

**Addresses: Theory 3 (stuck guard)**

If `createThreeCanvas` takes longer than 120 seconds, force-abort and dismiss the
loading overlay:

```js
const HARD_TIMEOUT_MS = 120000;
const hardTimeout = setTimeout(() => {
  log.error('createThreeCanvas hard timeout — aborting');
  _createThreeCanvasRunning = false;
  destroyThreeCanvas();
  loadingOverlay.fadeIn(500).catch(() => {});
}, HARD_TIMEOUT_MS);
```

Clear the timeout in the `finally` block.

### Fix 5: Ensure Sidecar/Adventure-Flag Injection Is the Default Workflow

**Addresses: Theory 1 at the authoring level**

If flags genuinely don't survive Foundry's Adventure serialization (server-side stripping),
the only reliable fix is ensuring map authors use the sidecar/Adventure-flag injection
workflow. Consider:
- Automating the `_msaSaveSceneConfigToAdventurePack` call during module packaging
- Adding a prominent "Prepare for Distribution" button in the MSA UI
- Making the sidecar JSON generation automatic when detecting a module pack context

---

## Most Likely Root Cause (Combined)

The silent failure is most likely a **combination of Theory 1 + Theory 2**:

1. MSA flags are unreliable during import (may be lost or may have stale in-memory state)
2. On first navigation, `isEnabled()` returns false at the critical moment
3. Foundry's draw fails or hangs (scene was designed for MSA, doesn't render well in vanilla)
4. MSA's recovery doesn't fire because `isEnabled()` returned false
5. Scene is stuck in a broken/blank state
6. After restart, flags are loaded fresh from DB (either they survived import, or the
   `importAdventure` hook's `setFlag` persisted on the first attempt), `isEnabled()` returns
   true immediately, and the full MSA pipeline initializes successfully

The **single most impactful fix** is ensuring that `isEnabled()` returns true reliably
on the very first navigation after import. This means either:
- Making the `importAdventure` hook's `setFlag` blocking (awaited)
- Adding a secondary content-based detection that doesn't depend on flags
- Deferring `_silentlyPersistEnabled` to avoid mid-init race conditions
