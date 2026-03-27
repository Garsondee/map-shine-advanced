# Texture Loading System Research (2026-03-27)

## Research Scope

- Focus: how mask/texture asset loading currently works for GM vs player.
- Goal: document what is currently in place, where behavior diverges, and why player sessions can still fail.
- This document also records **implementation iterations** attempted to fix player-side loading and console 404 noise, and **user-reported outcomes** after each direction.

## Status (last update)

- **User report:** Loading as a player still shows many `GET … 404 Not Found` requests for optional mask URLs (e.g. `…-Ground_Roughness.webp`, `…-Ground_Normal.webp`, repeated across extensions and case variants). **No perceived improvement**; **mask-dependent effects remain broken** on the tested scene/module.
- **Conclusion so far:** The problem is not fully resolved. Further work likely needs verification of the true on-disk filenames for that map, alignment of effect-setting keys with which masks are requested, and/or a strategy that avoids network probing for masks that were never authored.

## Implementation iterations (what was tried)

This section records code and design attempts **in order**, independent of whether they fixed the reported player issue. File paths refer to this repository.

### Earlier session fixes (symptoms and plumbing)

- **`GpuSceneMaskCompositor`:** One-shot stale-cache repair for non-GM clients to avoid infinite `composeFloor` / empty tile-mask cache loops when directory enumeration fails.
- **`VisibilityController`:** Fail-soft path when `isVisible` throws so players do not get a full blackout during startup races.
- **`module.js`:** Player torch/flashlight controls always visible; ownership still governs writes.
- **`composer.js` (earlier):** GM-only guard on `bypassCache` retry when “critical” V1 masks were missing, to stop player clients from cache-busting loops.
- **`tile-manager.js` / `loader.js`:** FilePicker `public` vs `data` source routing for `modules/` vs `worlds/` paths; various caches and probe reductions over time.

### “Single pipeline” refactor (manifest-first)

- **`scripts/assets/loader.js`:** Moved scene bundle loading toward a **manifest keyed by suffix** (`buildMaskManifest`), with `loadAssetBundle` accepting `maskManifest`, `maskExtension`, and later `maskIds`. Iteration over masks is driven by what appears in the manifest rather than a separate FilePicker discovery path inside the same load.
- **`scripts/scene/composer.js`:** Builds manifest from resolved mask source (`_resolveMaskSourceSrc` → `extractBasePath`) and extension from the same source; passes it into `loadAssetBundle`. Removed GM-only bypass-cache retry and the initialize-time `_probeBestMaskBasePath` retry loop so initialize does not switch base paths in a second phase.
- **`scripts/scene/tile-manager.js`:** Per-tile mask URLs resolved by **inserting suffix before file extension** on the tile texture URL; removed fallback to loader `probeMaskFile` when FilePicker listing was empty. Dedicated water/specular/fluid resolvers were aligned to the same “sibling filename” idea.

**Intent:** One code path for GM and player: same URL construction, no GM-only discovery.

**User outcome:** Player still saw 404s; effects still broken. Logs showed requests like  
`https://…/modules/mythica-machina-flooded-river-prison/assets/mythica-machina-flooded-river-prison-Ground_<Suffix>.webp` failing.

### Candidate expansion and deduplication (still one loader, more URL tries)

- **`loader.js`:** Manifest entries became **arrays of candidate URLs** per suffix: variants for base path casing, suffix casing (`_Roughness` vs `_roughness`), and extensions (`webp/png/jpg/jpeg`). Sequential `loadMaskTextureDirect` attempts until one succeeds.
- **`_failedMaskUrlCache`:** Remembers URLs that failed fetch so later passes skip them.
- **Cache behavior:** Empty cached bundles (zero masks) treated as valid cache hits to avoid re-probing every initialize.
- **`CRITICAL_MASK_IDS` / cache trust:** Adjusted so missing critical masks does not cause perpetual invalidation loops for non-GM in some versions.

**Intent:** Match Linux case-sensitive hosting and reduce repeated identical 404s.

**User outcome:** **No improvement.** Console still filled with 404s for many suffixes. User noted **many of those files legitimately do not exist** and should not be required; the loader still issued requests for them because optional masks were still being attempted when the convention did not match reality.

### “Only load masks for enabled effects”

- **`scripts/scene/composer.js`:** `_collectEnabledMaskIds(foundryScene)` uses `sceneSettings.getEffectiveSettings(scene)?.effects` and maps UI effect ids (e.g. `fire-sparks`, `specular`, `tree`) to mask ids (`fire`, `specular`, etc.). Always includes `specular` in the set; adds `normal` and `roughness` when the `specular` **effect** is enabled.
- **`buildMaskManifest` / `loadAssetBundle`:** Accept `maskIds` so only selected `EFFECT_MASKS` entries are emitted and loaded.

**Intent:** Stop requesting masks for effects that are off in scene settings, reducing optional 404 noise.

**User outcome:** **No improvement** per user; effects still broken. Possible reasons to verify in code review:
- Effect ids in scene flags may not match the keys used in `_collectEnabledMaskIds` (silent `isEnabled` false vs truthy object).
- Always loading `specular` plus `normal`/`roughness` when specular effect is enabled still generates multiple requests per mask; if files use different naming than `base+_Suffix+ext`, every attempt 404s.
- Floor compositor / other paths may still call `loadAssetBundle` without `maskIds` or with a different base path.

### Evidence pattern from hosted module

- Example failing URLs (user logs):  
  `…/mythica-machina-flooded-river-prison-Ground_Roughness.webp` (and `.png`, `.jpg`, `.jpeg`, plus lowercase suffix variants).
- Implies the **base stem** in use is tied to the scene/tile background (e.g. `…-Ground`). If authored masks use a different stem (e.g. shared pack prefix only on some files), **every** conventional URL will 404 regardless of role.

### Open questions for next iteration

1. **Ground truth filenames:** List one directory’s actual mask filenames for this module on disk (or FilePicker listing as GM) and compare to constructed URLs.
2. **Single entry point audit:** Confirm every `loadAssetBundle` call site uses the same `maskIds` / manifest policy as `SceneComposer.initialize`.
3. **Avoid network proof for absent masks:** Optional masks should not require a failed `fetch` to discover absence; prefer authoritative listing once, or ship a small manifest asset with the module, or HEAD/GET only after a positive existence signal.
4. **Effect ↔ mask mapping:** Reconcile `_collectEnabledMaskIds` with `getEffectiveSettings().effects` schema (which effect keys exist and what `enabled` looks like).

## Current Runtime Entry Points

Primary callsites that load map mask bundles:

- `scripts/scene/composer.js`
  - `SceneComposer.initialize(...)` calls `assetLoader.loadAssetBundle(...)` with manifest / `maskIds` from `_collectEnabledMaskIds`.
  - `_probeBestMaskBasePath(...)` remains in the class for other flows (e.g. probing helpers); the initialize path was changed to avoid the previous multi-attempt tile base-path retry loop.
- `scripts/masks/GpuSceneMaskCompositor.js`
  - Calls `assetLoader.loadAssetBundle(...)` during floor composition fallback paths.
- `scripts/ui/effect-stack.js`
  - Calls `loadAssetBundle(...)` for diagnostics/testing workflows.
- `scripts/ui/diagnostic-center-dialog.js`
  - Calls `loadAssetBundle(...)` for diagnostics.

## Current Asset Loader Architecture

Main file: `scripts/assets/loader.js`

> **Note:** The numbered flow below mixes **historical** behavior with **current** behavior. After the iterations in [Implementation iterations](#implementation-iterations-what-was-tried), scene `loadAssetBundle` primarily uses **`buildMaskManifest` → candidate URL lists → `loadMaskTextureDirect`**, with optional `maskIds` filtering. `discoverAvailableFiles` / `probeMaskFile` still exist for diagnostics and some helpers but are not the main scene bundle path.

### High-level flow in `loadAssetBundle(basePath, ...)` (current shape)

1. Optional bundle cache check (`assetCache` keyed by basePath/options).
2. Optional base texture load (`skipBaseTexture` may bypass this).
3. Build effective manifest: caller-supplied `maskManifest`, or `buildMaskManifest(basePath, { extension, maskIds })`.
4. For each suffix present in that manifest, try candidate URLs in order until load succeeds or list is exhausted.
5. Apply fallback synthesis (`applyIntelligentFallbacks`) for roughness defaults.
6. Cache and return bundle.

### Historical mask path resolution (superseded for scene bundle)

Earlier versions used `discoverAvailableFiles` + `findMaskInFiles`, or a deterministic URL probe when listing was empty. That dual mode was the original “GM listing vs player guessing” split; the manifest-first refactor attempted to replace it with one construction rule (still failing for some hosted assets when filenames do not match the rule).

## Current File Discovery Logic

### `discoverAvailableFiles(basePath)`

- Delegates to `_discoverFilesViaFilePicker(basePath)`.
- Returns discovered file paths array or empty array.
- Logs warning when no files are discovered.

### `_discoverFilesViaFilePicker(basePath)`

- Builds directory candidates (raw, decoded, encoded).
- Selects FilePicker source candidates by path prefix:
  - `modules/` and `systems/` -> `public` then `data`
  - `worlds/` -> `data` then `public`
  - fallback -> try both
- Uses `FilePicker.browse(source, targetDir)` and takes first successful non-empty file list per dir.

## Related Parallel Discovery Logic

There is separate but similar discovery logic in:

- `scripts/scene/tile-manager.js` -> `_listDirectoryFiles(...)`
  - Also performs source switching (`public`/`data`) by path prefix.
  - Uses its own caches (`_dirFileListCache`, `_dirFileListPromises`).

This means asset discovery behavior is implemented in multiple places, not one shared service.

## Composer-Level Behavior That Affects Outcomes

In `scripts/scene/composer.js`:

- `SceneComposer.initialize(...)` can:
  - load from background-derived `bgPath`,
  - retry with `bypassCache:true` for missing critical masks (currently guarded by GM-only retry condition),
  - probe alternate base paths from tile sources (`_probeBestMaskBasePath`) when mask count is zero.

Observed behavior implication:

- If initial `basePath` naming convention does not match actual mask filenames for player sessions, loader can complete quickly with zero masks.
- Effects that require masks then silently no-op downstream.

## Why GM Can Appear to Work While Player Fails

Based on current code paths, GM/player success can diverge if any of the following differ by role/session timing:

1. **Directory listing availability**
   - GM often gets non-empty `FilePicker.browse` results.
   - Player may get empty results depending on host permissions/source/path.
2. **Resolver mode**
   - Non-empty listing -> exact filename match.
   - Empty listing -> deterministic URL convention attempts.
3. **Filename convention mismatch**
   - Deterministic mode assumes masks are `basePath + suffix + ext`.
   - If actual files do not follow that naming exactly (including base stem/case), deterministic attempts 404.
4. **Initialization timing/path selection**
   - Composer can pick different base paths across attempts and floor states.
   - Fast completion with zero masks is possible when no resolved filenames are found.

## Current Evidence From Logs (as reported)

Recent user-provided logs show repeated `GET` 404s for deterministic candidates such as:

- `...-Ground_Fire.webp/png/jpg/jpeg`
- `...-Ground_Normal.webp/png/jpg/jpeg`
- `...-Ground_Roughness.webp/png/jpg/jpeg`

Interpretation:

- Loader is currently in deterministic resolution mode (not using discovered file listing for those requests).
- Candidate names being attempted do not exist at those exact URLs.
- Bundle likely returns with no masks or insufficient masks, causing mask-dependent effects to fail silently.

## What Is In Place Right Now (Summary)

Currently implemented components relevant to texture loading reliability:

- `assetCache` and texture caches in `scripts/assets/loader.js`.
- `CRITICAL_MASK_IDS` gate (`specular`) in bundle cache trust logic.
- Source-aware FilePicker browse in loader and tile manager (`public`/`data` switching).
- Deterministic mask URL resolver when listing is empty.
- Composer fallback probes for alternate base paths.
- Effect systems consume `currentBundle.masks` and floor-mask bundles; mask-dependent effects no-op when masks absent.

## Key Structural Findings

1. There is not yet a single authoritative filename source for all sessions.
2. Runtime can switch between listing-based and deterministic naming-based resolution.
3. Multiple discovery implementations exist (`loader` and `tile-manager`), increasing drift risk.
4. Mask-dependent effect failure can be silent when bundle mask count is zero.
5. The reported 404 pattern is consistent with deterministic mode failing to match actual asset filenames.

## Foundry API Research Notes

External lookup confirms FilePicker in Foundry supports source selection (`public`, `data`, etc.), but practical behavior depends on deployment/storage configuration and path conventions. In this codebase, source selection is already attempted dynamically by path prefix; failures indicate either:

- FilePicker listing still returns empty for the effective player context, or
- deterministic filename convention does not match actual authored files for the scene/module.

## Single-system design (implemented in code; validation failed for reported scene)

The codebase was refactored toward **one construction rule** for GM and player: build URLs from base path + suffix + extension (with optional candidate variants), optionally filtered by `maskIds`, instead of branching on FilePicker success vs failure inside the same load.

**User validation:** On the user’s hosted game and module, this did **not** restore mask-dependent effects and did **not** eliminate problematic 404 noise; see [Implementation iterations](#implementation-iterations-what-was-tried).

### Intended pipeline (as coded)

1. Build a mask manifest: per suffix, a list of candidate URLs (base/suffix/extension variants).
2. Resolve loads only from that manifest (no parallel “listing mode” in the same `loadAssetBundle` path).
3. Try candidates sequentially via `loadMaskTextureDirect`; track failures in `_failedMaskUrlCache`.
4. Optional: `_collectEnabledMaskIds` in `SceneComposer` restricts which mask types are requested based on `getEffectiveSettings().effects`.

### `scripts/assets/loader.js` (representative options)

- `buildMaskManifest(basePath, { extension, maskIds })`
- `loadAssetBundle(..., { maskManifest, maskExtension, maskIds, ... })`
- `_resolveMaskCandidates(maskManifest, maskSuffix)` — returns string array of URLs

### `scripts/scene/composer.js`

- Mask source: `_resolveMaskSourceSrc` → `extractBasePath` → manifest extension from same source.
- `_collectEnabledMaskIds` + `getEffectiveSettings` for which mask ids to include.
- Initialize path no longer uses GM-only bypass retry or the multi-attempt `_probeBestMaskBasePath` loop (that helper may still exist for other call sites).

### `scripts/scene/tile-manager.js`

- `_resolveTileMaskUrl` uses `_insertSuffixBeforeExtension` on the tile texture URL.
- Dedicated tile mask resolvers simplified to the same sibling-filename policy where refactored.

## Branch Removal Matrix (attempted refactors)

Overall player/effect symptom **not** resolved per user; table reflects code removals/changes, not end-user success.

| File | Symbol / Branch | Status | Notes |
| --- | --- | --- | --- |
| `scripts/assets/loader.js` | dual resolver branch in `_resolveMaskPath` (listing vs deterministic probing) | removed | now manifest-only exact URL resolution |
| `scripts/assets/loader.js` | `_directMaskPathCache` runtime path cache | removed | no deterministic candidate loop remains |
| `scripts/scene/composer.js` | GM-only bypass retry for missing V1 masks | removed from initialize path | one pass using manifest |
| `scripts/scene/composer.js` | initialize-time `_probeBestMaskBasePath` retry loop | removed from initialize path | no alternate runtime branch switching |
| `scripts/scene/tile-manager.js` | `_resolveTileMaskUrl` FilePicker+probe fallback split | removed | now exact sibling URL only |
| `scripts/scene/tile-manager.js` | water/specular/fluid FilePicker existence gating branches | removed | now exact sibling URL policy |

## Compatibility And Risk Notes

- If authored mask files do not match base name + suffix + extension conventions, those masks will fail deterministically and visibly instead of silently succeeding on GM and failing on player.
- Existing `discoverAvailableFiles`/FilePicker helpers remain available for diagnostics paths; runtime scene/tile mask loading no longer depends on them.
- Required-mask misses are now surfaced as structured diagnostics in the loader, reducing silent no-op behavior.

## Acceptance Criteria (targets vs outcome)

**Targets:**

- GM and player execute the same mask resolution branch for scene bundles.
- Player joins before GM and executes identical manifest-driven URL requests.
- Minimal or no extension/case spray for masks that were never authored.
- Missing masks diagnosable without silent no-op.

**Observed (user report, not yet satisfied):**

- Player session still shows many 404s for optional mask URLs; user reports **no improvement** and **effects still broken**.
- Candidate lists per suffix can still multiply attempts (multiple extensions × case variants), which is noisy when the **base filename** or **stem** does not match server files.

## GM/Player Parity Validation Checklist

1. Open the same scene with one GM client and one player client.
2. Capture requested mask URLs from both clients during `SceneComposer.initialize`.
3. Confirm URL sets are identical (order-insensitive), excluding cache-busting query differences.
4. Reload as player-first (GM offline), then re-run and confirm identical URL set.
5. Verify no runtime branch divergence logs tied to user role.
6. Confirm mask-dependent effects activate when files exist and report diagnostics when absent.

## Troubleshooting Guide (Post-Migration)

- **Missing effects on both GM and player:** verify authored mask filenames match the **exact** URL the code builds (stem + suffix + extension). If the pack uses a different stem than the background image base path, every request will 404.
- **Scene loads but expected mask missing:** inspect manifest-derived URL for that suffix and confirm file exists at that exact URL on the server (case-sensitive on Linux).
- **Tile-specific mask missing:** verify tile source filename stem and sibling mask stem are identical before suffix insertion.
- **Noisy failures / many 404s:** the current manifest builder can still generate **multiple candidate URLs per suffix** (extensions and case variants). That is intentional for robustness but produces console noise when **no** file matches any candidate. Reducing noise requires either fewer candidates, authoritative listing, or a shipped filename manifest.
- **After asset rename/move:** clear module cache (`assetLoader.clearCache()`) and reload scene to rebuild resolved mask set.
- **Enabled-effect filtering did not help:** confirm `getEffectiveSettings(foundryScene).effects` actually contains the expected keys and `enabled` flags for your scene; mismatches leave defaults or wrong mask sets.

## Scene-flag mask texture manifest (implemented)

Authoritative mask paths are **persisted on the Scene** so all clients load the same Foundry paths without guessing.

### Flag schema

- **Namespace / key:** `map-shine-advanced` / `maskTextureManifest`
- **Fields:**
  - `version` — `1`
  - `basePath` — mask base path (no extension), same as `SceneComposer.extractBasePath(maskSource)`
  - `maskSourceKey` — normalized mask source URL without query string (for staleness)
  - `pathsByMaskId` — map of registry mask id (e.g. `specular`, `fire`) → full path string **only for files that exist** in the directory listing
  - `updatedAt` — epoch ms when last written

### Runtime flow

1. **`prepareSceneMaskManifestForLoad`** ([`scripts/settings/mask-manifest-flags.js`](C:/Users/Ingram/Documents/Mythica Machina Module Development/map-shine-development/map-shine-advanced/scripts/settings/mask-manifest-flags.js)):
   - If flag `basePath` matches current mask `basePath` and `pathsByMaskId` is present: build `maskManifest` (suffix → single path) **only for** [`collectEnabledMaskIds`](C:/Users/Ingram/Documents/Mythica Machina Module Development/map-shine-development/map-shine-advanced/scripts/settings/mask-manifest-flags.js)(scene).
   - If **GM** and flag missing or mismatch: `discoverMaskDirectoryFiles` + `resolveMaskPathsFromListing`, then `persistMaskTextureManifest` (debounced by JSON equality), then same filtered manifest for load.
   - If **player** and no matching flag: **empty** `maskManifest` (no convention / extension spray for scene bundle).

2. **`SceneComposer.initialize`** calls `prepareSceneMaskManifestForLoad` before `loadAssetBundle`, passing `cacheKeySuffix` so bundle cache varies when the flag updates.

3. **`GpuSceneMaskCompositor`** uses `getMaskBundleOptionsFromFlagOnly` per `basePath` so floor fallbacks match the same flag data.

4. **Loader:** [`discoverMaskDirectoryFiles`](C:/Users/Ingram/Documents/Mythica Machina Module Development/map-shine-development/map-shine-advanced/scripts/assets/loader.js) (exported), [`resolveMaskPathsFromListing`](C:/Users/Ingram/Documents/Mythica Machina Module Development/map-shine-development/map-shine-advanced/scripts/assets/loader.js), optional `cacheKeySuffix` on `loadAssetBundle`.

### Edge cases

| Situation | Behavior |
|-----------|----------|
| Player before any GM has opened the scene | No flag → empty scene mask bundle until GM lists directory and saves. |
| GM cannot browse directory | Partial or empty `pathsByMaskId`; only existing files are stored. |
| `basePath` for a tile differs from flag `basePath` | Flag not applied for that load path; player gets empty bundle for that path unless a matching flag row is added later. |
| Map Shine disabled for scene | `prepareSceneMaskManifestForLoad` returns empty manifest early. |

