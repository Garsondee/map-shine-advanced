# Tweakpane texture status rows — developer instruction

**Concise copy-paste version:** [`tweakpane-texture-status-instruction-concise.md`](./tweakpane-texture-status-instruction-concise.md)

---

All effect sections in the **main Tweakpane config** (`TweakpaneManager.registerEffect`) must use the shared **texture status row** pattern introduced for Water. Do not add new `textureStatus` readonly string bindings or custom one-off status HTML.

**Reference implementation:** Water (`WaterEffectV2.getControlSchema()` + `scripts/ui/effect-mask-status.js` + `scripts/ui/mask-status-ui.js`).

---

## When to add texture rows

Add texture status rows when an effect **depends on authored suffixed textures** from the asset loader (`EFFECT_MASKS` in `scripts/assets/loader.js`) or equivalent per-tile / per-background discovery.

| Situation | Action |
|-----------|--------|
| Effect requires one mask (e.g. `_Water`) | One `mask-status` group |
| Effect can use several masks (e.g. `_Bush` + `_Tree` overlays) | One row per mask |
| Effect has no authored mask dependency | No texture rows |
| Legacy `textureStatus` string in schema | Remove when migrating; use `mask-status` groups instead |

---

## UI contract (must match Water)

Each required texture is a **single horizontal row** placed **directly under the effect’s Enabled checkbox** (not at the top or bottom of the folder). Layout:

| Column | Content |
|--------|---------|
| Label | `Texture` when the effect has **one** mask; otherwise the **suffix** (e.g. `_Bush`, `_Tree`) |
| Status chip | Short state text (see below) |
| Help | Square **`?`** button opening a Foundry dialog with full setup guidance |

**Status chip text** (use `formatTextureStatusMessage()` — do not invent new wording):

| Phase | Example (`_Water`) |
|-------|-------------------|
| Loaded (runtime after `populate()`) | `_Water Texture Loaded` |
| Missing, effect disabled | `No _Water Texture Found` — grey (`missing-muted`) |
| Missing, effect enabled | `No _Water Texture Found` — red (`missing-alert`) |

Do **not** use Searching, manifest-only “found”, or `maskManager` shortcuts in the Tweakpane chip. Status comes from **runtime populate state only** (`resolvePopulatedMaskStatus` in `effect-mask-status.js`). Toggling **Enabled** must call `refreshEffectMaskStatus(effectId)` so missing grey/red updates immediately.

Styling is defined in `styles/module.css` (`.ms-mask-status-row`, `.ms-mask-status-help-btn`). Do not duplicate inline styles in effects.

---

## Multiple textures

If an effect accepts **more than one** suffixed texture:

1. Declare **one `mask-status` schema group per mask**.
2. Sort groups **alphabetically by suffix** (e.g. `_Bush` before `_Tree` before `_Water`).
3. Use `createMaskStatusSchemaGroups()` so ordering stays consistent.
4. Each row gets its own `?` dialog from `MASK_STATUS_TEMPLATES[maskId]` (or registry fallback).
5. Call `refreshEffectMaskStatus(effectId)` after populate so every row updates.

Example (conceptual):

```js
import { createMaskStatusSchemaGroups } from '../../ui/effect-mask-status.js';

groups: [
  ...createMaskStatusSchemaGroups(['bush', 'tree']), // → _Bush row, then _Tree row
  { name: 'look', label: 'Look', type: 'folder', /* ... */ },
],
```

Row labels for multi-mask effects: use the **suffix** as the row label (override via `createMaskStatusSchemaGroup(id, { label: '_Bush' })` if needed). Single-mask effects keep the label **`Texture`**.

---

## Implementation checklist (per effect)

### 1. Schema (`getControlSchema()`)

```js
import {
  createMaskStatusSchemaGroup,
  createMaskStatusSchemaGroups,
} from '../../ui/effect-mask-status.js';

groups: [
  createMaskStatusSchemaGroup('water'),           // single mask
  // ...createMaskStatusSchemaGroups(['a','b']),  // multiple masks, A→Z by suffix
  // other folders follow AFTER mask-status groups in schema order;
  // DOM placement is still directly under Enabled (see TweakpaneManager).
],
```

- Group `type` must be `'mask-status'`.
- Do **not** list `mask-status` groups in `parameters` or build them via `textureStatus` strings.
- Remove obsolete `Status` folders that only existed for `textureStatus`.

### 2. Template (`MASK_STATUS_TEMPLATES` in `effect-mask-status.js`)

For each new mask id, add an entry with:

- `suffix`, `exampleBase`, `formats`
- `placement` — where files live relative to albedo art
- `authoring` — how to paint / interpret the mask (luminance, RGBA, depth, etc.)
- `extra` — optional formats or tips

Water’s `_Water` entry is the quality bar for depth-style masks (whiter = deeper water).

### 3. Probe (`resolveEffectMaskStatus`)

Extend the `switch` in `resolveEffectMaskStatus()` and delegate to `resolvePopulatedMaskStatus()` (or a thin wrapper like `resolveWaterMaskStatus` / `resolveOverlayMaskStatus`) so the chip reflects **runtime state after `populate()` only**:

- **Loaded:** read the live instance from `MapShine.floorCompositorV2` (or `effectComposer._floorCompositorV2`) — not `floorCompositor`. Water: `hasRenderableWater()` / `_floorWater`; Bush/Tree: `_overlays.size`.
- **Missing:** `resolveMissingTextureStatus()` — grey if disabled, red if enabled

Do not probe manifest, `maskManager`, or show Searching in the main config UI.

### 4. Refresh hook

After mask discovery / `populate()` finishes (success or empty), call:

```js
window.MapShine?.tweakpaneManager?.refreshEffectMaskStatus?.('yourEffectId');
```

Optionally set `_maskDiscoveryPhase` to `found` | `missing` at the **end** of `populate()` for diagnostics; notify the UI once when populate finishes.

### 5. Tweakpane wiring (already centralized)

- `TweakpaneManager.registerEffect` injects all `mask-status` groups after the panel is built and anchors them under **Enabled**.
- Do not call `createMaskStatusRow` from effect code.
- Do not push values into `effect.params.textureStatus` for the main config UI.

---

## Files to touch

| File | Role |
|------|------|
| `scripts/ui/effect-mask-status.js` | Templates, messages, probes, `createMaskStatusSchemaGroup(s)` |
| `scripts/ui/mask-status-ui.js` | DOM row, placement, `?` dialog |
| `scripts/ui/tweakpane-manager.js` | Injection under Enabled (avoid editing unless fixing shared behavior) |
| `styles/module.css` | Row + square help button |
| `scripts/compositor-v2/effects/*EffectV2.js` | Schema + populate refresh |
| `scripts/assets/loader.js` | `EFFECT_MASKS` suffix registry (reference only) |

---

## Migration map (legacy → template)

Replace these patterns when touching an effect:

| Legacy | Replacement |
|--------|-------------|
| `textureStatus: 'Searching...'` param + Status folder | `createMaskStatusSchemaGroup(maskId)` |
| `this.params.textureStatus = 'Ready...'` | `refreshEffectMaskStatus` + probe in `effect-mask-status.js` |
| Custom `_buildMaskStatusSection` / red-green X UI | Shared template only |
| `Mask status` label | `Texture` (single mask) or suffix (multi) |

**Migrated:** Water, Bush, Tree, Iridescence, Prism, Fluid, Specular (`_Outdoors` + `_Specular`), Window Light (`_Outdoors` + dynamic `_Windows`/`_Structural` row), Painted Shadows (`_Shadow`), Building Shadows (`_Outdoors`), Camera Grade (`_Outdoors`), Fire (`_Fire`), Ash (`_Ash`), Dust (`_Dust`), Water Splashes + Underwater Bubbles (both `_Water`). **Still to migrate:** any remaining legacy `textureStatus` effects.

---

## Alphabetical order rule

When multiple `mask-status` groups appear in one effect folder, their **DOM order** must match **suffix sort order** (case-insensitive string compare on the full suffix, e.g. `_Ash` < `_Bush` < `_Water`).

Always use:

```js
createMaskStatusSchemaGroups(['windows', 'specular', 'outdoors']) // auto-sorted
```

rather than manual ordering in the schema array.

---

## Texture Assets (top-level category)

**Purpose:** Scene-wide diagnostics — one status row for **every** key in `EFFECT_MASKS` (`scripts/assets/loader.js`), sorted A→Z by suffix. Not tied to any effect’s **Enabled** checkbox.

| Piece | Location |
|-------|----------|
| Category order / title | `scripts/ui/effect-categories.js` (`textureAssets` → “Texture Assets”, before Developer Tools) |
| Panel build + refresh | `scripts/ui/texture-assets-panel.js` |
| Scene probe | `resolveTextureAssetMaskStatus()` / `sceneMaskLoadedCount()` in `scripts/ui/effect-mask-status.js` |
| DOM rows | `createStandaloneMaskStatusRow()` in `scripts/ui/mask-status-ui.js` |
| Wiring | `TweakpaneManager.buildTextureAssetsSection()`; `refreshTextureAssetsStatuses()` inside `refreshAllEffectMaskStatuses()` (post-populate) |

**UI contract:** Each row label is the **suffix** (e.g. `_Water`). Missing rows always use **`missing-muted`** (grey) — no red alert. Chip still uses `formatTextureStatusMessage`. **`?`** uses the same templates as effect panels.

**Probe order:** Effect runtime state (water, overlays, particles, window light, painted shadow, outdoors) → scene manifest paths → tile mask cache → GpuSceneMaskCompositor floor textures.

Do not duplicate effect-folder mask rows here; effect panels keep their per-effect rows under **Enabled**.

---

## Review before merge

- [ ] Rows sit **immediately below Enabled**, above the first parameter folder
- [ ] Single mask → label `Texture`; multi → one row per mask, suffix order A→Z
- [ ] Status text uses `formatTextureStatusMessage` variants only
- [ ] `?` opens dialog with placement, naming, formats, and painting notes
- [ ] `refreshEffectMaskStatus` runs after populate
- [ ] No `textureStatus` string binding left in schema
- [ ] `MASK_STATUS_TEMPLATES` entry added for non-trivial masks

---

## Agent / contributor note

When adding or editing Tweakpane effect UI, **default to this pattern** for any effect that reads suffixed battlemap textures. If unsure whether a texture is required, check `EffectMaskHealthCatalog` and the effect’s `populate()` / `probeMaskFile` usage.
