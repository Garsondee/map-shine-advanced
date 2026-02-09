# Tweakpane UI Reorganization Plan (Map Shine Advanced)

## Goals
- Make **Support & Links** a persistent, always-open section **at the very top** of the panel.
- Move **non-user-facing / developer** buttons currently living in **Global Controls** into a dedicated **Debug** section.
- Keep the UI logical for non-technical users (progressive disclosure).
- Preserve existing behavior:
  - Accordion expansion state persists via `ui-state.accordionStates`.
  - Buttons still call the same handlers.
  - Avoid heavy UI rebuild work.

## Current Build Order (as of `scripts/ui/tweakpane-manager.js`)
In `TweakpaneManager.initialize()` the panel is built in this order:
1. `buildGlobalControls()`
2. `buildRopesSection()`
3. `buildSceneSetupSection()` (GM only)
4. `buildBrandingSection()` (**Support & Links**)

This results in “Support & Links” being near the bottom of the root panel.

## Proposed Top-Level Order
At the **root** level of the Tweakpane, build folders in this order:
1. **Support & Links** (always expanded)
2. **Scene Setup** (GM only, expanded by default)
3. **Global Controls** (expanded by default)
4. **Effects** categories (existing behavior via `ensureCategoryFolder()` and effect registration)
5. **Debug** (collapsed by default)

Notes:
- “Effects” categories are not explicitly built as a single section today; they appear as effects register and call `ensureCategoryFolder(categoryId, title)`.
- “Ropes & Chain” currently nests under `Particles & VFX` and is created in `buildRopesSection()`. This should remain there.

## Support & Links (Top + Always Open)
### Requirement
- The **Support & Links** folder should be the first folder created.
- It should be **expanded: true** (not dependent on saved accordion state).

### Behavior / Persistence
- We can still record fold state into `accordionStates['branding']`, but the plan is to **always force expanded**.
- If we keep the fold listener, user interactions will be saved but ignored on next boot (since we force expanded).

## Global Controls: What Stays vs What Moves
### Keep in Global Controls (user-facing)
- `mapMakerMode` toggle (Map Maker workflow)
- `timeRate` slider (time scaling)
- `UI Scale` slider (panel UX)
- Tool entry points that are plausibly user-facing:
  - `Open Texture Manager`
  - `Open Effect Stack`
  - `🎯 Manage Map Points`
- Settings operations that are explicitly user-facing and safe:
  - `Master Reset to Defaults`
  - `Undo Last Master Reset`

### Move from Global Controls to Debug (developer-facing)
- `Run UI Validator`
- `Copy Non-Default Settings`
- `Copy Changed This Session`
- `Copy Current Settings`
- `Dump Surface Report`

Rationale:
- These are diagnostic/dev workflows, not something a typical GM/player should see.

## Debug Section Design
### Root-level folder
Create a new `buildDebugSection()` which adds a root folder:
- Title: `Debug`
- Expanded: `accordionStates['debug'] ?? false`

### Contents
- A sub-folder `UI` for the validator and UI state reporting.
- A sub-folder `Settings` for copy/export operations.
- A sub-folder `Scene/Surfaces` for `Dump Surface Report`.

(Exact sub-folder naming can be adjusted after seeing it in the UI.)

## Implementation Steps
1. **Add a plan doc** (this file).
2. Update `initialize()` build order to create **Support & Links** first.
3. Modify `buildBrandingSection()` to default `expanded: true`.
4. Add `buildDebugSection()` and move the debug-only buttons from `buildGlobalControls()` into it.
5. Verify accordion persistence still works:
   - `branding` state may be recorded but should not override forced-open behavior.
   - `global` and `debug` fold states should persist.
6. Quick regression pass:
   - Buttons still call the same functions.
   - No duplicate folders.

## Open Questions (Confirm)
- Should **Support & Links** be completely non-collapsible (ignore folding entirely), or just **default expanded** on every load?
- Should `Copy Current Settings` remain accessible to GMs (some might use it for support tickets), or is it strictly dev-only?
