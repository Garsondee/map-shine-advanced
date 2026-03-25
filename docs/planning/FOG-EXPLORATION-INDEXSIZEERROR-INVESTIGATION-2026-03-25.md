# Fog Exploration `IndexSizeError` Investigation (Scene Switch)

## Symptom
When switching scenes (not consistently), Foundry logs errors like:
- `IndexSizeError: Index or size is negative or greater than the allowed amount worker.js:138:13`
- `FogExtractor | Buffer compression has failed! foundry.mjs:123761:13`
- `Failed to save fog exploration foundry.mjs:115132:18`
- `DOMException: Index or size is negative or greater than the allowed amount foundry.mjs:160535:15`

This appears to originate from Foundry’s fog exploration save/compression pipeline running in a worker (`FogExtractor`).

## What Map Shine does (relevant code-paths)

### V2 fog overlay + *Map Shine-owned* exploration persistence
Map Shine’s scene rendering uses the V2 fog overlay effect:
`scripts/compositor-v2/effects/FogOfWarEffectV2.js`

Key behaviors:

1. **Vision -> exploration accumulation (GPU)**
   - `_accumulateExploration()` ping-pongs two WebGLRenderTargets and accumulates:
     `explored = max(previousExplored, currentVision)` (per pixel).

2. **Save scheduling**
   - `_markExplorationDirty()` is called when exploration should be updated.
   - It increments `_explorationCommitCount` and triggers a save when:
     `this._explorationCommitCount >= canvas?.fog?.constructor?.COMMIT_THRESHOLD ?? 70`
   - Saves are debounced:
     `this._saveExplorationDebounced = foundry.utils.debounce(this._saveExplorationToFoundry.bind(this), 2000)`

3. **Save implementation into Foundry FogExploration doc**
   - `_saveExplorationToFoundry()` (async) performs:
     - Guards: `_initialized`, `canvas.scene.tokenVision`, `canvas.scene.fog.exploration`, `_explorationDirty`, `_isSavingExploration`
     - Captures `sceneIdAtStart = canvas?.scene?.id`
     - Determines render-target size (`width`, `height`) from the current RT/texture
     - **GPU->CPU readback** via `_readRenderTargetPixelsTiled(...)`
     - **Encode** into `data:image/webp;base64,...` using `_encodeExplorationBase64(...)`
       - OffscreenCanvas path prefers `convertToBlob({ type: 'image/webp' })`
       - Fallback uses HTMLCanvas `toBlob` / `toDataURL`
     - Updates/creates a FogExploration doc:
       - `CONFIG.FogExploration.documentClass.update(...)` or `create(...)`
       - `updateData = { scene, user, explored: base64, timestamp }`
     - **Stale-scene safety**:
       - After readback and after encoding it checks:
         `if (sceneIdAtStart !== canvas?.scene?.id) return;`

4. **Readback tiled helper**
   - `_readRenderTargetPixelsTiled(renderTarget, width, height, outBuffer)`:
     - Uses `safeWidth = Math.min(width, rtWidth)` and similarly for `safeHeight`
     - Reads in tiles and writes into `outBuffer` at offsets derived from *original* `width`
     - On `readRenderTargetPixels` exception (RT disposed mid-save), it returns `false`.
   - Potential subtlety:
     - If `safeWidth < width` or `safeHeight < height`, parts of `outBuffer` may remain from a previous allocation (not explicitly zero-filled).
     - This affects encoded pixel content (should still be a valid WebP), but could be relevant if Foundry’s decoder/compressor is sensitive to inconsistencies.

### V2 resets / reloads exploration when Foundry fog resets or doc changes
In `FogOfWarEffectV2.js`:
- `resetExploration()` clears the ping-pong RTs, sets `_explorationDirty = false`, and increments `_explorationLoadGeneration`.
- It also listens to Foundry lifecycle:
  - Hooks: `deleteFogExploration`, `createFogExploration`, `updateFogExploration`
  - Socket: `resetFog` (`game.socket.on('resetFog', ...)`)

This means V2 tries to stay in sync with the authoritative `FogExploration` document.

### V2 hides native fog *visuals* but does not disable native fog persistence (from what we can see)
Two hiding/suppression paths:
1. `FogOfWarEffectV2._suppressNativeFogVisuals()`:
   - sets `canvas.fog.visible = false`
   - sets `canvas.fog.sprite.visible = false` and `canvas.fog.sprite.alpha = 0`
   - (visual suppression only; no obvious changes to fog saving behavior)
2. `scripts/foundry/canvas-replacement.js`:
   - `applyMapMakerFogOverride()` hides `canvas.fog.visible` only in Map Maker mode.

No repo code found that:
- disables Foundry’s fog exploration saving, or
- replaces/blocks `CONFIG.Canvas.fogManager` save logic in gameplay mode.

### `FogManager.js` exists but appears unused by Map Shine runtime
There is a custom `scripts/vision/FogManager.js` that also mimics `canvas.fog.save()` and saves to `canvas.fog.exploration`.
However, repo-wide search did not show it being instantiated/imported by the runtime wiring.

So the persistent save path we *do* see is V2’s `_saveExplorationToFoundry()` into `FogExploration`, plus Foundry’s native fog manager (likely still active for persistence).

## Likely root-cause hypotheses (ranked)

### Hypothesis A: **Concurrent writers** to `FogExploration` during scene switches
- Map Shine V2 writes to `FogExploration` docs via `_saveExplorationToFoundry()`.
- Foundry’s native fog manager likely continues to accumulate and persist exploration even if Map Shine hides `canvas.fog.visible`.
- During scene changes, both writers may update the same `FogExploration.explored` field close together.
- If one update supplies a transient/invalid/partial payload or if updates interleave in a way Foundry’s worker can’t handle, `FogExtractor | Buffer compression has failed!` could be thrown.

Why intermittent:
- Concurrency timing windows depend on user actions and scene-switch timing.

### Hypothesis B: **Scene switch race** where V2 saves RT data for the *previous* scene into the *new* scene
V2’s stale-scene guard checks `sceneIdAtStart` against `canvas.scene.id` after readback + encode, but does not validate that the exploration RTs being read correspond to the same scene that `canvas.scene.id` represents at save start.

If, during scene transition, RTs are not yet recreated (or are in-flight) while `canvas.scene.id` already changed:
- V2 might encode and write exploration from an RT built for a different scene’s dimensions/state.
- That encoded WebP would still be structurally valid, but if Foundry’s save/compression expects certain invariants, the worker could fail.

### Hypothesis C: Readback buffer packing inconsistency leading to decoder/compressor failure
`_readRenderTargetPixelsTiled()` clamps to `safeWidth/safeHeight`, but may not zero unused bytes when `safeWidth < width`.

This should still produce a valid encoded image, but if Foundry’s decoding/compression pipeline has an edge case (e.g., it assumes certain monotonic relationships between decoded dimensions and buffer lengths), corrupt pixel content could trigger internal arithmetic errors.

### Hypothesis D: Save cadence too aggressive or miscalibrated during transitions
V2 sets the commit threshold based on:
`canvas?.fog?.constructor?.COMMIT_THRESHOLD ?? 70`

If Foundry swaps fog manager state during scene switching, the threshold could briefly become unexpectedly small/large (or NaN).

That would change how often V2 writes FogExploration and amplify the concurrency/race likelihood.

## When these errors would likely trigger

These signatures are most consistent with Foundry’s fog extraction/compression worker being asked to encode pixel data when the implied dimensions or required buffer sizes are temporarily invalid during a scene transition. In practice, the error should correlate with:

1. A scene switch that runs `Canvas.prototype.tearDown` while fog exploration persistence is enabled (`canvas?.scene?.tokenVision` and `canvas?.scene?.fog?.exploration`).
2. Moments where Foundry is saving/loading/resetting exploration for the old/new scene lifecycle (the same window where your console notes: “save fog exploration” + “fog extraction can fail with invalid canvas dimensions during scene switches”).
3. Concurrency where multiple writers update `FogExploration.explored` near-simultaneously (native fog manager + Map Shine V2 `_saveExplorationToFoundry()`), so one write payload is derived from unstable/transitioning assumptions.
4. Disposes/resizes happening mid-readback or mid-encode. Even if Map Shine skips/aborts its own readback, Foundry’s worker can still observe invalid canvas/fog state derived on the main thread at the start of the worker job.
5. Larger scene configurations that increase pixel payload size, making internal size/buffer invariants easier to violate when dimensions are wrong for even a short interval.
6. V2’s debounce firing near transitions (2s debounce), especially if `_saveExplorationDebounced` is not cancelled early enough for the outgoing scene before Foundry starts its own extraction/compression path.

## Evidence collected in this investigation
1. V2’s persistence implementation is in:
   - `scripts/compositor-v2/effects/FogOfWarEffectV2.js`
   - save scheduling: `_saveExplorationDebounced` (debounce 2s)
   - dirty marking: `_markExplorationDirty` (commit threshold from `canvas.fog.constructor.COMMIT_THRESHOLD ?? 70`)
   - persistence target: `CONFIG.FogExploration.documentClass` (`load/create/update`)
2. V2 intentionally hides native fog visuals:
   - `canvas.fog.visible = false`
   - does not obviously disable native persistence in the code we searched.
3. No evidence that the repo disables Foundry fog persistence in gameplay mode:
   - `scripts/foundry/canvas-replacement.js` only hides fog visuals for Map Maker and for V2 suppression.
4. `FogManager.js` (custom) exists but appears unused by runtime wiring (not instantiated/imported in other modules).
5. Map Shine wraps `Canvas.prototype.tearDown` during scene transitions and explicitly treats these fog errors as non-fatal:
   - in `scripts/foundry/canvas-replacement.js`, the wrapper catches exceptions and notes that:
     - “fog save IndexSizeError/DOMException” can occur
     - “Foundry's fog extraction can fail with invalid canvas dimensions during scene switches”
   - This suggests the `FogExtractor` worker failure is triggered in the scene-teardown timing window.

## Concrete next steps / experiments

### 1. Instrument the V2 save path (high priority)
Add debug logging (temporary) around `_saveExplorationToFoundry()`:
- At save start:
  - `sceneIdAtStart`, `canvas.scene.id` current
  - `width/height` computed
  - `explorationTarget.width/height` and/or texture image dimensions (whichever is used)
  - `buffer.byteLength`
  - `_explorationDirty`, `_isSavingExploration`, `_explorationCommitCount`, commit threshold used
- After encoding:
  - `base64.length`
  - first ~20 chars of base64 string (to ensure it looks like a data URL)
- Before calling `doc.update/create`:
  - doc identity (id present/absent)

Also instrument V2’s fog hooks:
- log when `updateFogExploration` fires and whether V2 resetExploration runs.

Goal:
Correlate worker failures with the exact payload dimensions and with concurrency (frequency / overlap).

### 2. Detect concurrent writers
From V2 logs, estimate how often `updateFogExploration` fires within the 2s debounce window and during scene switches.

If `updateFogExploration` is firing at a rate consistent with native fog manager saves *in addition to* V2 saves, Hypothesis A becomes much stronger.

### 3. Add a stronger scene/RT consistency guard
Modify `_saveExplorationToFoundry()` to early-return if:
- `this._rtSceneIdAtCreation !== canvas.scene.id`, where `_rtSceneIdAtCreation` is recorded when the exploration RTs are created

Implementation idea:
- In `_createExplorationRenderTarget()` store `this._rtSceneIdAtCreation = canvas?.scene?.id`
- In `_saveExplorationToFoundry()`, verify that current scene id matches.

Goal:
Prevent any save that reads from RTs created under a different scene.

### 4. Make readback buffer fill deterministic
In `_readRenderTargetPixelsTiled()`, explicitly clear `outBuffer` before tiled reads (e.g., `outBuffer.fill(0)`), so unused regions cannot contain prior data.

Goal:
Eliminate ambiguity if safeWidth/safeHeight clamping ever occurs.

### 5. Try disabling V2 persistence to validate the core hypothesis
Temporary toggle:
- Disable V2’s `_saveExplorationToFoundry()` (or make it return early when a debug flag is set)

Then verify:
- Do `FogExtractor` / `IndexSizeError` errors stop during scene switches?

If yes, V2 persistence write path is implicated (Hypothesis A/B/C).

### 6. Implement teardown guard (current mitigation)
Implemented in `scripts/compositor-v2/effects/FogOfWarEffectV2.js`:
- On `canvasTearDown`, cancel the debounced exploration-save timer and suspend future persistence writes.
- `_saveExplorationToFoundry()` captures an incrementing `saveGeneration` and re-checks it after readback/encode, preventing `FogExploration` doc writes once teardown begins.
- On `canvasReady`, persistence is resumed.

This should reduce worker-triggered compression failures if they are caused by Map Shine’s own persistence writes racing scene teardown.

## Open questions
- Does Foundry native fog persistence continue running while Map Shine hides `canvas.fog` visuals in gameplay mode? (Most likely yes, but needs confirmation via logs.)
- During scene switches, is V2’s exploration effect instance disposed/reinitialized reliably every time, or can it persist across transitions and leave debounced saves in-flight?
- Are the worker errors tied to specific scene sizes (e.g., scenes with larger dimensions produce larger WebP images)?

## Acceptance criteria for the fix
- No `FogExtractor` worker compression failures on scene switches.
- No regression to fog exploration persistence behavior (explored areas should persist correctly per scene/user).
- Confirm by repeated scene switching under stress conditions (rapid changes, floor navigation if relevant).

## Full scene-change audit (implemented hardening)

Audit scope reviewed:
- `Canvas.prototype.tearDown` wrapper (`installCanvasTransitionWrapper`)
- `canvasTearDown` hook (`onCanvasTearDown`)
- `canvasReady` hook (`onCanvasReady`)
- V2 fog persistence (`FogOfWarEffectV2._saveExplorationToFoundry`)

Key finding:
- The blocking error path is still consistent with **Foundry native fog persistence** during teardown, not only Map Shine V2 writes.
- Prior mitigation only gated V2 writes; native `FogManager` save/compression could still run and throw during transition.

Implemented fix:
1. **Native FogManager safety patch**
   - Added `installFogSaveSafetyPatch()` in `scripts/foundry/canvas-replacement.js`.
   - Wraps `FogManager.prototype.save`/`commit` (core and configured class variants when available).
   - Behavior:
     - skips save/commit when `window.MapShine.__sceneTransitionActive === true`
     - catches/suppresses known fog size/compression errors (`IndexSizeError`, `FogExtractor`, `Buffer compression has failed`, `DOMException`) so they cannot abort the transition.

2. **Transition-state signaling**
   - `window.MapShine.__sceneTransitionActive = true` on teardown start (`Canvas.tearDown` wrapper + `onCanvasTearDown`).
   - Flag reset to `false` on `onCanvasReady`.
   - Patch install is retried from both teardown and ready paths to handle lifecycle ordering.

3. **Per-canvas teardown suppression**
   - In `Canvas.tearDown` wrapper, temporarily no-op `fog.save` / `fog.commit` on the active fog manager instance and cancel debounced fog save functions while teardown runs.
   - Restores original methods immediately after wrapped teardown returns.

Expected outcome:
- Scene transitions should no longer fail/hang due to fog worker compression exceptions, even if Foundry native fog state is temporarily invalid during teardown.

