# Packaged Map Enable Flag Bug — Investigation & Fix Plan

## Problem Statement

When a map is fully configured for Map Shine Advanced (effects, masks, map points set up by
the author) and packaged as a Foundry module (compendium / Adventure), importing that map still
shows the **"Enable Map Shine Advanced for this Scene"** onboarding button. Customers are
confused — the map requires Map Shine (listed as a module dependency) and is clearly
pre-configured for it, yet they must press an enable button before anything works.

---

## Code Path Investigation

### Activation gate: `isEnabled()` — `scripts/settings/scene-settings.js:149`

```js
export function isEnabled(scene) {
  const val = scene.getFlag(FLAG_NAMESPACE, 'enabled');
  const result = val === true;   // strict boolean — anything else is false
  return result;
}
```

Single flag: `flags['map-shine-advanced']['enabled'] === true`. If absent or any other
value, `isEnabled` returns `false`.

### Where the enable button appears — `scripts/ui/tweakpane-manager.js:764`

```js
const sceneIsEnabled = !!scene && sceneSettings.isEnabled(scene);
const showOnboardingOnly = (game.user?.isGM ?? false) && !sceneIsEnabled;

if (game.user.isGM) {
  if (showOnboardingOnly) this.buildFirstTimeEnableSection();  // enable button
  else this.buildSceneSetupSection();
}
```

`buildFirstTimeEnableSection()` renders "Getting Started" with the button
**"Enable Map Shine Advanced for this Scene"**.

### Canvas init gate — `scripts/foundry/canvas-replacement.js:2962`

```js
if (!sceneSettings.isEnabled(scene)) {
  // UI-only mode: no Three.js canvas, no effects
  return;
}
```

Map Shine entirely skips its rendering pipeline when `isEnabled()` is false.

### What `enable()` does when clicked — `scripts/settings/scene-settings.js:363`

```js
export async function enable(scene) {
  await scene.setFlag(FLAG_NAMESPACE, 'enabled', true);
  await setSceneSettings(scene, createDefaultSettings());  // OVERWRITES existing settings
}
```

`enable()` writes `enabled = true` AND overwrites scene settings with defaults. For a
pre-configured packaged map this **destroys the author's effect parameters**.

---

## Root Cause

### Primary: `enabled` is a world-activation flag, not authoring data

The `enabled` flag answers "Has the GM in THIS world activated Map Shine for this scene?"
It is world-local state, not map content.

When a map author:
1. Enables Map Shine in their world → `enabled = true`
2. Configures effects, map points, tile masks, all stored in other flags
3. Exports the scene to a module compendium pack

Foundry's compendium / Adventure export stores the scene document. The `enabled` flag
**may or may not survive** depending on import path:

- **Adventure import (v11/v12)**: The importer runs sanitization. World-activation flags
  are candidates for being treated as world-local state and stripped.
- **Manual pack authoring**: Authors writing packs directly (editing JSON or using build
  scripts) may not know to include `enabled: true` since it is not "content".
- **Author intent**: The `enabled` flag was designed as a "consent switch" for GMs setting
  up blank scenes from scratch. There was no distinction between "this scene is brand new"
  and "this scene came pre-configured from a module".

### Secondary: All actual authoring data DOES survive packaging

These flags are **map content** and survive compendium/Adventure export intact:

| Flag key | Content |
|---|---|
| `settings` | Full effect parameters, `mapMaker` block with per-effect config |
| `mapPointGroups` | All map point groups (fire, candles, dust, etc.) |
| `mapPointGroupsInitialized` | Explicit init marker (set when author first opens map points) |
| Tile `flags` | Per-tile mask texture paths, effect bindings |

### Secondary bug: `enable()` overwrites author settings

When a customer presses the enable button, `enable()` calls `setSceneSettings(scene,
createDefaultSettings())` which **replaces the author's carefully tuned effect params** with
blank defaults. The map then loads with no effects active even though the author configured
them. This makes the problem worse after the button is pressed.

---

## Proposed Fix

### Core principle

If a scene carries Map Shine authoring data but lacks the `enabled` flag, it was
pre-configured by a map author and should activate without user intervention.

### Step 1: Add `hasImpliedMapShineConfig(scene)` to `scene-settings.js`

Check for unambiguous evidence of Map Shine authorship using flags that DO survive packaging:

```js
export function hasImpliedMapShineConfig(scene) {
  if (!scene) return false;
  try {
    const msaFlags = scene.flags?.[FLAG_NAMESPACE] ?? {};

    // Evidence 1: settings block with a mapMaker section
    const settings = msaFlags['settings'];
    if (settings && typeof settings === 'object' && settings.mapMaker) return true;

    // Evidence 2: map point groups have been populated
    const groups = msaFlags['mapPointGroups'];
    if (groups && typeof groups === 'object' && Object.keys(groups).length > 0) return true;

    // Evidence 3: map points system was explicitly initialized by author
    if (msaFlags['mapPointGroupsInitialized'] === true) return true;

    return false;
  } catch (_) {
    return false;
  }
}
```

### Step 2: Update `isEnabled()` to auto-detect pre-configured scenes

```js
export function isEnabled(scene) {
  const val = scene.getFlag(FLAG_NAMESPACE, 'enabled');
  if (val === true) return true;

  // Auto-detect: if the scene has Map Shine authoring data, treat as enabled
  // and silently persist the flag so future loads skip this check.
  if (hasImpliedMapShineConfig(scene)) {
    _silentlyPersistEnabled(scene);  // fire-and-forget
    return true;
  }

  return false;
}
```

### Step 3: Silent flag persistence helper

```js
function _silentlyPersistEnabled(scene) {
  // Fire-and-forget: persist enabled=true without blocking the canvas init.
  // Use scene.flags access (no getFlag) to avoid any registration issues.
  Promise.resolve().then(async () => {
    try {
      const current = scene.flags?.[FLAG_NAMESPACE]?.['enabled'];
      if (current === true) return;  // already set, nothing to do
      if (typeof scene.setFlag !== 'function') return;
      await scene.setFlag(FLAG_NAMESPACE, 'enabled', true);
    } catch (_) {}
  });
}
```

### Step 4: Fix `enable()` to not overwrite existing settings

When called on a scene that already has settings (pre-configured map), `enable()` should
only set the `enabled` flag and leave settings untouched:

```js
export async function enable(scene) {
  await scene.setFlag(FLAG_NAMESPACE, 'enabled', true);

  // Only write default settings when the scene has NO existing settings.
  // Pre-configured packaged maps already have author-tuned settings.
  const existing = scene.getFlag(FLAG_NAMESPACE, 'settings');
  if (!existing || typeof existing !== 'object') {
    await setSceneSettings(scene, createDefaultSettings());
  }
}
```

---

## Files to Change

| File | Change |
|---|---|
| `scripts/settings/scene-settings.js` | Add `hasImpliedMapShineConfig()`, `_silentlyPersistEnabled()`, update `isEnabled()`, fix `enable()` |

No other files need changes. The UI logic in `tweakpane-manager.js` derives from
`isEnabled()` so it will naturally show the full controls once `isEnabled()` returns true.

---

## Test Cases

| Scenario | Expected result after fix |
|---|---|
| Fresh blank scene, no MSA flags | Enable button still shown (correct onboarding flow) |
| Scene imported from module compendium, has `settings.mapMaker` but no `enabled` flag | Auto-activates, no enable button, author settings intact |
| Scene imported from module compendium, has `mapPointGroups` but no `enabled` flag | Auto-activates, no enable button |
| Scene imported from module compendium, has `mapPointGroupsInitialized` but no `enabled` flag | Auto-activates, no enable button |
| Scene with `enabled = true` (legacy working case) | Unchanged — still works |
| GM presses enable button on a pre-configured scene | `enabled` set, existing settings preserved (not overwritten) |
| Scene with only residual/empty MSA flags (e.g. settings={}) | Enable button still shown (no false-positive) |

---

## Risks

- **False-positive activation**: A scene with an empty `settings` object (from a partial
  prior setup) could trigger auto-activation. Mitigation: check `settings.mapMaker` exists,
  not just `settings`.
- **Silent flag persistence race**: If `_silentlyPersistEnabled` fails (e.g. GM permissions
  issue), the flag isn't set. The scene still renders correctly via the implied check — just
  runs the check on every load. Acceptable.
- **`enable()` settings preservation**: The check for existing settings uses a plain object
  check. Malformed stored settings (e.g. a string) will still cause defaults to write, but
  that is the safe fallback.

---

## Implementation Order

1. Add `hasImpliedMapShineConfig()` to `scene-settings.js` ✅
2. Add `_silentlyPersistEnabled()` to `scene-settings.js` ✅
3. Update `isEnabled()` to call the above ✅
4. Fix `enable()` to preserve existing settings ✅
5. Add `preImportAdventure` sidecar hook to `module.js` ✅

---

## Addendum: Adventure EmbeddedDataField Discovery

During live investigation we found the root cause is **deeper** than the `enabled` flag.

### What was discovered

After confirming the source scene was fully configured, the Adventure pack (post fresh
re-export) was inspected directly. Result:

```json
{ "msaSceneFlagKeys": [], "rawMSASceneFlags": null }
```

Even after a fresh re-export (remove scene → re-add scene → Adventure Exporter submit),
the embedded scene in the Adventure had **no MSA flags at all**.

### Why embedded scene flags are lost

Foundry Adventure stores scenes as `EmbeddedDataField(BaseScene)` (see
`common/documents/adventure.mjs`). This is a DataModel, not a full ClientDocument.

The exact mechanism is still under investigation. Candidate causes:
- `TypedObjectField._cleanType()` silently deletes keys where `validateKey` returns `false`
  (source-confirmed). `DocumentFlagsField` delegates to `BasePackage.validateId(k)`, which
  uses `/^[A-Za-z0-9-_]+$/` — `map-shine-advanced` **passes** this check, so this alone is
  not the cause.
- The Adventure Exporter calls `scene.toCompendium({ clearFlags: false })` which should
  preserve flags. Source confirmed `clearFlags: false` path does NOT call `delete data.flags`.
- Root cause is likely server-side: when `adventure.update({ scenes: [...] })` is processed
  by the Foundry server, the embedded BaseScene DataModel schema may apply additional
  filtering in the server-side DataModel context that strips third-party module flags.

**Practical result**: Module-namespaced flags inside embedded Adventure scenes are
unreliable regardless of export settings. We work around this entirely rather than trying
to fix Foundry's serialization pipeline.

---

## Fix Strategy: Two-Source Injection via `preImportAdventure`

The `preImportAdventure` hook fires before `createDocuments` / `updateDocuments` is called.
It receives the raw payload arrays for every document type. MSA intercepts this hook and
injects MSA scene/tile flags from a reliable source into the create/update payloads.

Two sources are tried in priority order:

### Source 1 (Primary): Adventure's own top-level flags

The Adventure document's **own** `flags` field is at the TOP LEVEL of the document, not
inside `EmbeddedDataField`. It goes through the Adventure's `DocumentFlagsField` directly.
`map-shine-advanced` passes `BasePackage.validateId()`, so the data survives the full
LevelDB round-trip (write from client → server validates → store → distribute → load →
customer imports).

Map authors write the MSA config into the Adventure's top-level flags once via a console
snippet. This is self-contained — no extra files, no HTTP requests, works on any server.

In the `preImportAdventure` hook:
```js
const sceneConfig = adventure.flags?.['map-shine-advanced']?.sceneConfig;
```

### Source 2 (Fallback): `packs/msa-data.json` sidecar file

A JSON file shipped alongside the module at `modules/{moduleId}/packs/msa-data.json`.
Pre-fetched on `ready` and cached in `_msaSidecars`. Only fires for modules that list
`map-shine-advanced` in `relationships.requires`.

Useful if an author prefers file-based config or can't run the console snippet approach.
**Note**: requires the file to actually exist in the module distribution. A 404 from the
module server (`GET modules/.../packs/msa-data.json 404`) simply means the file hasn't been
created and deployed yet — it is not an error in MSA's code.

### Shared data format (used by both sources)

```json
{
  "<sceneId>": {
    "flags": {
      "map-shine-advanced": { "enabled": true, "settings": { ... }, "mapPointGroups": { ... } }
    },
    "tiles": {
      "<tileId>": {
        "flags": {
          "map-shine-advanced": { "overheadIsRoof": true }
        }
      }
    }
  }
}
```

For Source 1 this object is stored at `adventure.flags['map-shine-advanced'].sceneConfig`.
For Source 2 this object is stored at the top-level `scenes` key of the JSON file.

---

## Changes Made in MSA (`scripts/module.js`)

- `_msaSidecars` — module-level `Map<string, object>` cache for sidecar files
- `_prefetchMSASidecars()` — async, called on `ready`, fetches each MSA-dependent module's
  sidecar JSON (silently skips 404s)
- `_injectMSASidecarData(adventure, toCreate, toUpdate)` — synchronous; checks Adventure
  flags first, sidecar second; merges MSA flags into scene/tile payloads
- `preImportAdventure` hook — registered in `init`, calls `_injectMSASidecarData`

---

## Developer Workflow: Primary (Adventure Flags)

**No extra file needed. Everything lives inside the Adventure pack.**

### Step 1 — Write MSA config into the Adventure's own flags

Run this in the browser console **on your author world** with the fully-configured scene
active. Replace `PACK_ID` with your module's Adventure pack ID.

```js
(async () => {
  const NS = 'map-shine-advanced';
  const PACK_ID = 'your-module-id.adventure'; // <-- update this

  const scene = canvas?.scene;
  if (!scene) { console.error('No active scene'); return; }

  const msaSceneFlags = scene.flags?.[NS];
  if (!msaSceneFlags) { console.error('No MSA flags on active scene'); return; }

  // Collect tile-level MSA flags
  const tiles = {};
  for (const tile of scene.tiles ?? []) {
    const f = tile.flags?.[NS];
    if (f && Object.keys(f).length) tiles[tile.id] = { flags: { [NS]: f } };
  }

  const sceneConfig = {
    [scene.id]: {
      flags: { [NS]: msaSceneFlags },
      ...(Object.keys(tiles).length ? { tiles } : {})
    }
  };

  // Unlock the pack, write config into Adventure's own flags, re-lock
  const pack = game.packs.get(PACK_ID);
  if (!pack) { console.error('Pack not found:', PACK_ID); return; }

  await pack.configure({ locked: false });
  const adv = (await pack.getDocuments())[0];
  if (!adv) { console.error('No Adventure document found in pack'); return; }

  await adv.setFlag(NS, 'sceneConfig', sceneConfig);

  // Verify the data survived the write
  const verify = adv.flags?.[NS]?.sceneConfig;
  console.log(verify ? '✓ Config written OK. Scene IDs stored:' : '✗ Write failed');
  if (verify) console.log(Object.keys(verify));

  await pack.configure({ locked: true });
  console.log('Pack re-locked. Now package and ship your module as normal.');
})();
```

### Step 2 — Package and deploy

The Adventure's LevelDB files now contain the MSA config inside the Adventure document's
own flags. Package the module as normal. Customers will get the correct MSA setup
automatically on import — no manual enable button needed.

### Step 3 — Ensure `module.json` has the dependency (required for sidecar fallback only)

The Adventure flags approach does NOT require the `relationships.requires` gate — it reads
from `adventure.flags` directly and any Adventure can be processed. The sidecar fallback
DOES require the declaring the dependency:

```json
{
  "relationships": {
    "requires": [{ "id": "map-shine-advanced", "type": "module" }]
  }
}
```

---

## Developer Workflow: Fallback (Sidecar File)

Use this if you can't run the console snippet or prefer an external file.

### Step 1 — Generate the sidecar JSON

```js
(async () => {
  const NS = 'map-shine-advanced';
  const scene = canvas?.scene;
  if (!scene) { console.error('No active scene'); return; }
  const msaSceneFlags = scene.flags?.[NS];
  if (!msaSceneFlags) { console.error('No MSA flags on active scene'); return; }
  const tiles = {};
  for (const tile of scene.tiles ?? []) {
    const f = tile.flags?.[NS];
    if (f && Object.keys(f).length) tiles[tile.id] = { flags: { [NS]: f } };
  }
  const json = JSON.stringify({
    version: 1,
    scenes: {
      [scene.id]: { flags: { [NS]: msaSceneFlags }, ...(Object.keys(tiles).length ? { tiles } : {}) }
    }
  }, null, 2);
  console.log('=== msa-data.json ===\n', json);
  try { await navigator.clipboard.writeText(json); console.log('(Copied to clipboard)'); } catch (_) {}
})();
```

### Step 2 — Save as `modules/{your-module-id}/packs/msa-data.json`

Include this file in the module distribution. MSA silently ignores a 404 if it's absent.

---

## Latest Attempt Log (Unsolved)

### Attempt: Tweakpane "Save Config to Adventure Pack" workflow + hash verification

#### What was attempted

1. Added a Scene Setup button to save active scene MSA config into Adventure top-level flags.
2. Added deterministic hash utilities and embedded `_expectedHash` into saved scene flags.
3. Added load-time hash verification on scene load and a UI button to show current hash.
4. Fixed an initial pack-selection bug where `pack.id` could be undefined in some Foundry runtimes by using `pack.collection ?? pack.metadata?.id ?? pack.id`.

#### Observed results from latest user test

- Author-side token/hash: `7875b6cb`
- Loaded-scene token/hash: `7f5e2487`
- Result: **Hash mismatch** (config is not round-tripping exactly).
- Additional symptom: imported scene is still not recognized as Map Shine Advanced enabled.

#### Current status

**Not solved yet.**

The pack-selection fix removed one UI/runtime failure mode, but did not solve the core import correctness problem.

---

## Deep Source Code Analysis (Foundry VTT v13)

### Question: Does Foundry strip module flags from embedded Adventure scenes?

A full audit of the Foundry VTT client source was conducted to trace the entire
data pipeline for Adventure export and import. **The answer appears to be NO** —
there is no client-side mechanism that strips valid module flags.

### Export Pipeline — `AdventureExporter._processSubmitData`

```
adventure-exporter.mjs:300-357
```

For each world scene, the exporter calls:
```js
data = doc.toCompendium(adventure.collection, {
  clearSort: false,
  clearFolder: false,
  clearFlags: false,    // ← flags explicitly preserved
  clearSource: false,
  clearOwnership: true,
  clearState: true,
  keepId: true
});
```

Then submits with `{diff: false, recursive: false, keepId: true, keepEmbeddedIds: true}`.

**Result**: Scene data sent to the server includes `flags['map-shine-advanced']`.

### Import Pipeline — `Adventure.import` → `prepareImport` → `importContent`

```
client/documents/adventure.mjs:43-178
```

1. `prepareImport()` calls `this.toObject()` → raw adventure data including scene flags
2. Partitions into `toCreate` / `toUpdate` by checking `collection.has(d._id)`
3. **IDs are preserved** — `importContent()` uses `cls.createDocuments(createData, {keepId: true})`
4. Imported scenes go through the **full BaseScene schema** (not EmbeddedDataField), which
   includes `DocumentFlagsField` that preserves module flags.

### Schema Validation — `DocumentFlagsField._cleanType`

```
common/data/fields.mjs:1552-1571 (TypedObjectField._cleanType)
common/data/fields.mjs:3114-3136 (DocumentFlagsField)
```

```js
class DocumentFlagsField extends TypedObjectField {
  static get _defaults() {
    return Object.assign(super._defaults, {
      validateKey: k => {
        try { foundry.packages.BasePackage.validateId(k); }
        catch { return false; }
        return true;
      }
    });
  }
}
```

`BasePackage.validateId` uses regex `/^[A-Za-z0-9-_]+$/`.
**`map-shine-advanced` passes this check.** Keys that fail are deleted; ours does not fail.

The inner value goes through `ObjectField.clean()` which does `deepClone` — preserves
arbitrary nested objects without modification.

### Adventure's Scene Storage — `SetField(EmbeddedDataField(BaseScene))`

```
common/documents/adventure.mjs:45
```

Scenes are stored as `SetField(EmbeddedDataField(BaseScene))`. The `EmbeddedDataField`
delegates to `SchemaField.clean` which processes each field in the BaseScene schema.
The `flags` field is handled by `DocumentFlagsField` as described above — it validates
the key and preserves the value.

### What fromCompendium Does (NOT used by Adventure import)

```
client/documents/abstract/world-collection.mjs:106-137
```

`fromCompendium()` does NOT touch flags. It only clears: `_id`, `folder`, `sort`,
`ownership`, `active`. **Importantly, Adventure imports do NOT use `fromCompendium` at all** —
they call `cls.createDocuments(data, {keepId: true})` directly.

### Hook Signatures

```
client/hooks.mjs:1087-1109
```

- `preImportAdventure(adventure, formData, toCreate, toUpdate)` — fires BEFORE import.
  `toCreate`/`toUpdate` are `Record<string, object[]>` keyed by documentName.
  Returning `false` prevents import entirely.
- `importAdventure(adventure, formData, created, updated)` — fires AFTER import.
  `created`/`updated` are `Record<string, Document[]>` — actual Document instances.

### Conclusion

**There is no client-side code path in Foundry v13 that strips module-namespaced flags
from embedded Adventure scenes.** The `DocumentFlagsField` validates the namespace key
via regex and `map-shine-advanced` passes. The inner ObjectField preserves nested data.

The only unverifiable element is server-side processing. Since the `common/` directory
is shared between client and server, the same validation logic should apply server-side.
However, the actual server `dist/` code is compiled and not inspectable.

---

## Revised Root Cause Assessment

### The original diagnosis was likely wrong

The planning doc previously stated:
> "Foundry's EmbeddedDataField(BaseScene) schema strips module-namespaced flags from
> embedded scenes during serialization."

**This is not supported by the source code.** The `DocumentFlagsField._cleanType` method
validates keys via `BasePackage.validateId(k)` which is a simple regex. Our module ID passes.

### Probable explanations for the empty-flags observation

1. **Diagnostic bug**: The inspection code read the wrong property (e.g., the initialized
   DataModel instance instead of `_source` data), or ran before data was fully loaded.
2. **The Adventure document wasn't properly re-exported**: The export may have failed
   silently, or an older cached version was inspected.
3. **Server-side behavior we can't verify**: Although unlikely given shared common code,
   the compiled server dist _could_ behave differently.

### What IS definitely broken

Even if flags DO survive, two real problems remain:

1. **The `enabled` flag is a world-activation gate, not authoring data.** It answers
   "Has the GM in THIS world activated Map Shine?" — not "Is this scene configured for
   Map Shine?" A map author's `enabled=true` flag is irrelevant in a customer's world.

2. **`enable()` overwrites author settings.** When a customer presses the enable button
   on a pre-configured scene, `setSceneSettings(scene, createDefaultSettings())` destroys
   the author's effect parameters.

---

## Revised Solution — Foundry-Idiomatic Approach

### Core Principle

**Stop treating `enabled` as authoring data. Detect MSA content and auto-activate.**

This aligns with how Foundry VTT expects modules to work: store configuration in flags,
detect the configuration at runtime, and activate accordingly. The `preImportAdventure`
hook exists for edge cases, not as the primary mechanism.

### Strategy Overview

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Auto-Detection (Primary — already implemented) │
│   isEnabled() checks hasImpliedMapShineConfig()         │
│   Silently persists enabled=true on first detection     │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Settings Preservation (Primary)                │
│   enable() preserves existing author settings           │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Post-Import Verification (New)                 │
│   importAdventure hook verifies + repairs MSA state     │
│   on freshly imported scenes                            │
├─────────────────────────────────────────────────────────┤
│ Layer 4: Pre-Import Safety Net (Simplified)             │
│   preImportAdventure logs diagnostics                   │
│   Name-based fallback matching if ID lookup fails       │
├─────────────────────────────────────────────────────────┤
│ Layer 5: Diagnostic Verification (Temporary)            │
│   One-time logging to confirm flags survive export      │
│   Remove after confirmed                                │
└─────────────────────────────────────────────────────────┘
```

### Layer 1: Auto-Detection — `isEnabled()` + `hasImpliedMapShineConfig()`

**Status: Already implemented** in `scene-settings.js`.

`isEnabled()` returns true when:
- `flags['map-shine-advanced']['enabled'] === true` (explicit), OR
- `hasImpliedMapShineConfig(scene)` finds authoring evidence (settings.mapMaker,
  mapPointGroups, or mapPointGroupsInitialized).

On auto-detection, silently persists `enabled=true` via fire-and-forget `setFlag`.

**No changes needed.** This is correct and Foundry-idiomatic.

### Layer 2: Settings Preservation — `enable()` does not overwrite

**Status: Needs verification/fix** in `scene-settings.js`.

Current `enable()`:
```js
export async function enable(scene) {
  await scene.setFlag(FLAG_NAMESPACE, 'enabled', true);
  await setSceneSettings(scene, createDefaultSettings()); // DESTRUCTIVE
}
```

Fix:
```js
export async function enable(scene) {
  await scene.setFlag(FLAG_NAMESPACE, 'enabled', true);
  const existing = scene.getFlag(FLAG_NAMESPACE, 'settings');
  if (!existing || typeof existing !== 'object') {
    await setSceneSettings(scene, createDefaultSettings());
  }
}
```

### Layer 3: Post-Import Verification — `importAdventure` hook (NEW)

This is the key new addition. After Adventure import completes, Foundry provides the
actual created/updated Scene documents. We can inspect them directly and fix any issues.

```js
Hooks.on('importAdventure', (adventure, formData, created, updated) => {
  const NS = 'map-shine-advanced';
  const scenes = [...(created?.Scene ?? []), ...(updated?.Scene ?? [])];
  for (const scene of scenes) {
    // Check if this scene has MSA authoring data
    if (!hasImpliedMapShineConfig(scene)) continue;

    // Ensure enabled flag is set
    const enabled = scene.getFlag(NS, 'enabled');
    if (enabled !== true) {
      scene.setFlag(NS, 'enabled', true).catch(() => {});
      console.log(`Map Shine: auto-enabled imported scene "${scene.name}"`);
    }
  }
});
```

This is the most robust layer because:
- It operates on REAL Scene documents, not raw payloads
- It uses the same `hasImpliedMapShineConfig()` detection as `isEnabled()`
- It works regardless of whether flags survived the Adventure round-trip
- It's a standard Foundry hook pattern

### Layer 4: Pre-Import Safety Net — Simplified `preImportAdventure`

Keep the existing `preImportAdventure` hook but simplify it:
- Remove hash verification (adds complexity, doesn't solve the problem)
- Add scene name matching as fallback when ID lookup fails
- Add diagnostic logging (can be removed later)

### Layer 5: Diagnostic Verification — One-Time Logging

Add temporary logging to definitively answer whether flags survive:

```js
Hooks.on('preImportAdventure', (adventure, formData, toCreate, toUpdate) => {
  const NS = 'map-shine-advanced';
  for (const sceneData of (toCreate?.Scene ?? [])) {
    const msaFlags = sceneData.flags?.[NS];
    console.log(`Map Shine DIAG: preImport scene "${sceneData.name}" (${sceneData._id})`,
      'MSA flags present:', !!msaFlags,
      'keys:', msaFlags ? Object.keys(msaFlags) : 'none');
  }
});
```

If this logging shows flags ARE present in `toCreate.Scene`, we can confirm the original
diagnostic was wrong and simplify the entire approach. If flags are genuinely absent,
the injection mechanism is needed.

---

## What to Remove

The following complexity can be removed once Layer 3 is confirmed working:

1. **Hash verification** (`msaComputeHash`, `_expectedHash` embedding) — Adds complexity
   without solving the core problem.
2. **Sidecar JSON file approach** (`_prefetchMSASidecars`, `msa-data.json`) — Fragile,
   requires map authors to manage extra files.
3. **Adventure top-level flags config** (`_msaSaveSceneConfigToAdventurePack`) — Fragile,
   requires console snippets.

These were built under the assumption that flags don't survive. If flags DO survive
(as the source code suggests), Layers 1-3 handle everything.

If flags DON'T survive, Layer 4 (preImportAdventure injection) remains as a safety net,
but Layer 3 (post-import detection) is the primary fix.

---

## Files to Change

| File | Change |
|---|---|
| `scripts/settings/scene-settings.js` | Fix `enable()` to preserve existing settings |
| `scripts/module.js` | Add `importAdventure` hook (Layer 3), add diagnostic logging (Layer 5), simplify `preImportAdventure` hook (Layer 4) |

---

## Test Cases

| Scenario | Expected result |
|---|---|
| Fresh blank scene, no MSA flags | Enable button shown (correct onboarding flow) |
| Imported scene with MSA settings, `enabled` flag present | Works immediately, no button |
| Imported scene with MSA settings, `enabled` flag absent | Auto-detected by `isEnabled()`, works immediately |
| Imported scene with MSA settings, ALL flags absent | `importAdventure` hook detects tile MSA masks or `hasImpliedMapShineConfig()` returns false → enable button shown (correct for genuinely unconfigured scenes) |
| GM presses enable on pre-configured scene | `enabled` set, existing settings preserved |
| Re-import same Adventure (update path) | Settings preserved, `enabled` ensured |

---

## Implementation Order

1. Fix `enable()` to preserve existing settings (Layer 2) — prevents destructive overwrites
2. Add `importAdventure` hook (Layer 3) — post-import auto-enable
3. Add diagnostic logging in `preImportAdventure` (Layer 5) — determine if flags survive
4. Test with a real Adventure export/import cycle
5. Based on diagnostic results:
   - If flags survive → remove injection complexity (sidecar, Adventure flags, hash)
   - If flags don't survive → keep simplified injection, add name-based fallback matching

