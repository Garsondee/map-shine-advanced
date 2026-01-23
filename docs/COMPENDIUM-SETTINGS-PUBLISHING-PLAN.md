# Map Shine Advanced: Compendium-Friendly Scene Settings Save Button (Plan)

## Goal

Add a **GM-facing button** that explicitly saves Map Shine Advanced settings into the **current Scene document** so that:

- The Scene can be exported to a **compendium** (or as a JSON export) and the Map Shine settings **travel with it**.
- When another world imports that Scene, Map Shine Advanced **auto-uses the embedded settings**.
- The UI provides a clear **success/failure confirmation**, and we can **verify** that the settings stored are what we expect.

This document is a plan only. It does not implement the feature.

## Current Architecture (Baseline)

### Where settings already live

- **Scene flags (distributed with Scene / compendium-safe):**
  - `scene.flags['map-shine-advanced'].enabled` (boolean)
  - `scene.flags['map-shine-advanced'].settings` (object)
    - `mapMaker` tier
    - `gm` tier (nullable)
    - `player` (reserved)

- **Client settings (NOT distributed):**
  - `game.settings.get('map-shine-advanced', 'scene-{sceneId}-player-overrides')`

This is implemented in:

- `scripts/settings/scene-settings.js`
- `scripts/ui/tweakpane-manager.js` (auto-save batched)

### Important implication

Because Map Maker settings are already written to **scene flags**, they should already be **compendium-friendly** *in principle*.

However, there are two practical gaps that justify this feature:

- **Explicit “publish/snapshot” action:** Map makers want a single “this scene is ready to ship” action.
- **Verification + user feedback:** Current auto-save is background and debounced; it does not give a strong “saved and ready to export” guarantee.

## Feature Definition

### UX: New button

Add a new button under **Tweakpane → Scene Setup** (GM only), near existing:

- `Settings Mode` selector
- `Revert to Original`
- `Enable Map Shine Advanced for this Scene`

Proposed button title:

- **`Save Map Settings for Compendium`**

Optional secondary button:

- **`Verify Saved Settings`** (debug/validation)

### Who can use it

- **GM only**.
- Must require an active `canvas.scene`.

### What it saves (scope)

This button should write a *known-good, complete* payload to the scene flags:

- **Ensure `enabled` is `true`**
- **Ensure `settings` exists**
- **Ensure `settings.mapMaker` exists**
- **Write a canonical settings snapshot** into `settings.mapMaker`.

Canonical snapshot contents:

- `version` (module settings schema version)
- `effects`:
  - For every registered effect in `TweakpaneManager.effectFolders`:
    - Persist all non-readonly, non-hidden parameters (same filtering rules as current `saveEffectParameters`)
    - Include `enabled`

Notes:

- The snapshot should be **complete**, not sparse.
  - GM override tier can be sparse; Map Maker tier should be “authoritative baseline”.
- Player overrides are intentionally excluded (client-local).

### Confirmation requirements

On click, we must:

1. Flush any pending debounced UI saves so the snapshot is not stale.
2. Write to scene flags.
3. Read back from the scene flags and validate.
4. Provide feedback:
   - Success: `ui.notifications.info('Map Shine: Saved settings to scene for compendium export.')`
   - Failure: `ui.notifications.error('Map Shine: Failed to save/verify settings. See console.')`

### Verification rules

Verification should be strict enough to be meaningful but not fragile.

Minimum checks:

- `scene.getFlag('map-shine-advanced', 'enabled') === true`
- `scene.getFlag('map-shine-advanced', 'settings')` exists
- `settings.mapMaker.version` matches current
- For each effect in snapshot:
  - The effect exists in stored `settings.mapMaker.effects`

Optional deeper checks (nice to have):

- Compare a stable hash (see below)
- Validate schema compatibility (unknown params allowed, but flagged)

## Data Model / Compendium Guarantees

### Compendium behavior

Foundry compendiums store the full Scene document data, including `flags`.

Therefore, saving to:

- `scene.flags['map-shine-advanced']`

is the correct strategy.

### Versioning

Current settings version is in `scripts/settings/scene-settings.js`:

- `CURRENT_VERSION = '0.2.0'`

Plan:

- Continue writing `settings.mapMaker.version = CURRENT_VERSION`.
- When loading settings, call `migrateSettings()` as needed.

### Future safety: hash field

To make “confirm the save has worked” robust, optionally add:

- `scene.flags['map-shine-advanced'].settings.mapMaker.signature`

Where `signature` is a stable hash of the canonical JSON string of the saved snapshot.

This allows:

- Save → read back → recompute hash → compare

Implementation detail (later):

- Use Foundry’s `foundry.utils.hashCode` if available, or a small internal stable hash.

## Implementation Plan (Code Changes)

### 1) Add a canonical snapshot builder

Add a method on `TweakpaneManager`:

- `buildMapMakerSnapshot()`

Responsibilities:

- Iterate registered effects (`this.effectFolders`)
- Apply the same parameter filtering rules as existing save logic
- Return an object matching the Map Maker tier schema

### 2) Add explicit “publish” action

Add `publishMapMakerSettingsToScene()` to `TweakpaneManager`:

- Flush pending queued saves (call `flushSaveQueue()` with no debounce, or add `flushSaveQueueImmediate()`)
- Build snapshot
- Write:
  - `await scene.setFlag('map-shine-advanced', 'enabled', true)`
  - `await scene.setFlag('map-shine-advanced', 'settings', mergedSettings)`
- Read back and verify
- Notify user

### 3) Wire into UI

In `buildSceneSetupSection()` (GM-only):

- Add button:
  - `Save Map Settings for Compendium`

### 4) Ensure load path uses embedded settings

This is largely already true:

- Effects load through `loadEffectParameters()` → `scene.getFlag('map-shine-advanced', 'settings')`

Readiness checks to confirm:

- On `canvasReady`, when enabled, we must always initialize effects using `getEffectiveSettings()` or direct flag reads.

### 5) Add migration hooks (if missing)

Ensure the load path calls `migrateSettings()` when `settings.mapMaker.version !== CURRENT_VERSION`.

If not currently called anywhere, add it in a single authoritative place (likely on scene enable/load).

## Readiness / Module-Wide Checks

Before implementing, confirm:

- Scene flags are not being overwritten by “defaults” on load.
- No other system writes to `scene.flags['map-shine-advanced'].settings` unexpectedly.
- UI auto-save debounce won’t race with the publish action.

## Test Plan (Manual)

### Local world

- **Basic publish**
  - Change several effect params
  - Click `Save Map Settings for Compendium`
  - Refresh browser
  - Confirm settings persist

- **Verify snapshot completeness**
  - Disable an effect and change a non-default parameter
  - Publish
  - Inspect `canvas.scene.getFlag('map-shine-advanced','settings')` and confirm the values exist under `mapMaker.effects`.

### Compendium export/import

- Export the Scene to a compendium in World A
- Import into World B
- Open the scene
- Confirm:
  - Map Shine auto-enables (if enabled flag is true)
  - Effects load with the authored values

### Multiplayer

- GM publishes settings
- Player joins and loads the scene
- Confirm player receives the authored settings (scene flags replicate)

### Failure modes

- No active scene → button warns
- Non-GM → button hidden
- setFlag rejects (permissions) → error notification

## Open Questions

- Should publish also clear `settings.gm` overrides to avoid shipping table-specific tweaks?
  - Recommendation: Provide a checkbox or a second button:
    - `Publish (Map Maker only)` (clears gm tier)
    - `Publish (Include GM overrides)`

- Should publish also snapshot other Map Shine state such as `controlState` (time/weather)?
  - Currently weather uses `scene.flags['map-shine-advanced'].controlState`.
  - Decide if that is part of “map settings” or a separate “live play state”.

## Status

Planned.
