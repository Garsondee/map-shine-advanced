# GM-Only Restrictions and Player Load Audit Plan (2026-03-27)

## Goal

Identify every GM-only or permission-gated code path that can impact player scene loading, visibility, masks, fog, floor transitions, and core interaction readiness.

## Policy Decisions (Confirmed)

- Keep **GM-only** access for scene-authoring/admin UI (Map Shine main options panel, Control Panel, map/levels authoring tools).
- Keep **player access** for runtime essentials:
  - scene loading and mask/fog/vision rendering
  - player-owned token interactions (torch/flashlight/doors per policy)
  - player personal/client config where safe
- Keep **GM-authoritative world writes** (scene flags, world settings, global darkness/time persistence), but ensure non-GM runtime behavior fails soft and remains playable.

## Scope

- Foundry VTT v12 module runtime (`scripts/**`)
- Scene bootstrap and `canvasReady` flow
- Mask/floor compositing and asset loading
- Fog/vision and visibility controllers
- User role checks (`isGM`) and permission checks (`canUserModify`, Foundry permission APIs)
- Restricted settings that can create GM/player behavior divergence

## Search Method (Exhaustive Candidate Sweep)

Primary patterns used for candidate discovery:

- `isGM`
- `canUserModify(`
- `restricted: true`
- `game.user.can(`
- `permission-denied`
- Role/ownership conditionals in load/visibility paths

Note: this list is a complete candidate inventory for review, not all are blockers. Each file must be manually classified as:

- `Critical` = can directly break player scene load/visibility
- `Relevant` = can cause degraded or divergent player behavior
- `Context` = GM-only authoring/editor flows (unlikely to break load)

## Complete Candidate File Inventory

1. `scripts/assets/loader.js`
2. `scripts/assets/texture-policies.js`
3. `scripts/compositor-v2/effects/FogOfWarEffectV2.js`
4. `scripts/compositor-v2/effects/MovementPreviewEffectV2.js`
5. `scripts/compositor-v2/effects/PlayerLightEffectV2.js`
6. `scripts/compositor-v2/effects/VisionModeEffectV2.js`
7. `scripts/core/WeatherController.js`
8. `scripts/effects/DebugLayerEffect.js`
9. `scripts/effects/EnhancedLightsApi.js`
10. `scripts/fog/fog-exploration-store.js`
11. `scripts/foundry/camera-follower.js`
12. `scripts/foundry/canvas-replacement.js`
13. `scripts/foundry/cinematic-camera-manager.js`
14. `scripts/foundry/controls-integration.js`
15. `scripts/foundry/drop-handler.js`
16. `scripts/foundry/input-router.js`
17. `scripts/foundry/intro-zoom-effect.js`
18. `scripts/foundry/levels-api-facade.js`
19. `scripts/foundry/levels-compatibility.js`
20. `scripts/foundry/mode-manager.js`
21. `scripts/foundry/zone-manager.js`
22. `scripts/masks/GpuSceneMaskCompositor.js`
23. `scripts/module.js`
24. `scripts/scene/drawing-manager.js`
25. `scripts/scene/interaction-manager.js`
26. `scripts/scene/light-interaction.js`
27. `scripts/scene/map-point-interaction.js`
28. `scripts/scene/map-points-manager.js`
29. `scripts/scene/NoteIconManager.js`
30. `scripts/scene/TemplateAdornmentManager.js`
31. `scripts/scene/tile-manager.js`
32. `scripts/scene/tile-motion-manager.js`
33. `scripts/scene/token-manager.js`
34. `scripts/scene/token-movement-manager.js`
35. `scripts/scene/token-selection-controller.js`
36. `scripts/scene/wall-manager.js`
37. `scripts/settings/scene-settings.js`
38. `scripts/ui/camera-panel-manager.js`
39. `scripts/ui/control-panel-manager.js`
40. `scripts/ui/diagnostic-center-dialog.js`
41. `scripts/ui/effect-stack.js`
42. `scripts/ui/level-navigator-overlay.js`
43. `scripts/ui/levels-authoring-dialog.js`
44. `scripts/ui/levels-editor/levels-domain.js`
45. `scripts/ui/levels-editor/levels-editor-v2.js`
46. `scripts/ui/loading-screen/loading-screen-dialog.js`
47. `scripts/ui/state-applier.js`
48. `scripts/ui/tile-motion-dialog.js`
49. `scripts/ui/token-movement-dialog.js`
50. `scripts/ui/tweakpane-manager.js`
51. `scripts/vision/VisibilityController.js`

## High-Risk Areas to Audit First

These are most likely to break player scene load or visibility if role-gating races/fails:

1. `scripts/vision/VisibilityController.js`
2. `scripts/compositor-v2/effects/FogOfWarEffectV2.js`
3. `scripts/fog/fog-exploration-store.js`
4. `scripts/assets/loader.js`
5. `scripts/masks/GpuSceneMaskCompositor.js`
6. `scripts/foundry/canvas-replacement.js`
7. `scripts/core/WeatherController.js`
8. `scripts/ui/state-applier.js`

## Audit Progress Log (Live)

### 2026-03-27 Pass 1 (Critical runtime gates)

#### 1) `scripts/vision/VisibilityController.js` — FIXED

- **Issue:** In `_refreshAllVisibility()`, `Token.isVisible` exception path used `visible = isGM`, which means players could hard-fail to invisible during startup races while GM still saw tokens.
- **Risk:** `Critical` (direct player visibility blackout).
- **Fix applied:** Fail-soft fallback now prefers prior known token visibility, then owner/control visibility (`controlled`, `isOwner`, `document.isOwner`) instead of hard GM-only visibility.
- **Expected outcome:** Prevents "players see nothing" collapse when vision state is not yet fully ready.

#### 2) `scripts/masks/GpuSceneMaskCompositor.js` — FIXED

- **Issue:** Stale tile-mask repair/eviction behavior could either:
  - loop endlessly on players (if repeated evictions), or
  - be too GM-only and prevent player self-heal entirely.
- **Risk:** `Critical` for player load stability in bad cache states.
- **Fix applied:** Introduced balanced policy:
  - GM: can perform repeated stale-repair evictions.
  - Player: one-shot stale-repair eviction per floor band (`_nonGmStaleRepairAttempted`) to permit local recovery without infinite recompose loops.
  - Reset/cleanup of this tracking added to `clearFloorState()` and `dispose()`.
- **Expected outcome:** Player clients can recover once from stale empty-mask bundles, but cannot thrash forever.

### 2026-03-27 Pass 1 (Reviewed, no code change)

#### 3) `scripts/compositor-v2/effects/FogOfWarEffectV2.js` — REVIEWED

- Player path already includes fallback to owned tokens when no controlled token exists.
- Current gate aligns with intended behavior; no accidental GM lock found in this path.

#### 4) `scripts/fog/fog-exploration-store.js` — REVIEWED

- Player path already uses deterministic owned-token actor fallback.
- GM unresolved multi-actor context is intentional to avoid incorrect fog context collapse.

#### 5) `scripts/ui/state-applier.js` + `scripts/core/WeatherController.js` — REVIEWED

- GM-only sections are world-authoritative writes (scene flags, world time/darkness persistence).
- Runtime application paths remain available; no accidental player render lock found.

#### 6) `scripts/foundry/canvas-replacement.js` + `scripts/foundry/mode-manager.js` — REVIEWED

- GM-only gates here are Map Maker/maintenance cleanup tooling.
- Not required for baseline player scene render; no change in this pass.

#### 7) `scripts/module.js` (player light scene controls) — FIXED

- **Issue:** Player torch/flashlight scene-control visibility depended on world setting `allowPlayersToTogglePlayerLightMode`, which could accidentally remove a core player interaction path.
- **Risk:** `High` gameplay impact (not a hard load blocker, but directly blocks player light control).
- **Fix applied:** Player light control buttons are now always visible to all users; actual token flag writes remain naturally constrained by token ownership/permission.
- **Expected outcome:** Players consistently retain torch/flashlight toggles, matching runtime gameplay expectations.

#### 8) `scripts/assets/loader.js` (direct probe spam on players) — FIXED

- **Issue:** When FilePicker browse is unavailable on player clients, the loader falls back to direct URL probing for critical masks. Missing masks (e.g. `_Specular`) triggered repeated `HEAD` checks on each load pass, creating heavy 404 spam.
- **Risk:** `High` UX/perf noise (network + console spam); can amplify load churn symptoms.
- **Fix applied:** Added per-session cache for direct probe outcomes (`_probeMaskUrlCache`) keyed by `basePath+suffix`:
  - successful probe stores resolved URL
  - failed probe stores `null` (negative cache)
  - cache is cleared by `clearCache()`
- **Expected outcome:** A missing critical mask is probed once per session/cache lifecycle instead of repeatedly hammering `.png/.jpg/.jpeg` URLs.

#### 9) `scripts/assets/loader.js` (player effects collapse when `_Specular` missing) — FIXED

- **Issue:** Two behaviors combined could break player-side effects:
  1. direct-probe mode (no FilePicker browse) only probed "critical" masks, so non-critical-but-needed masks were never loaded.
  2. cache completeness enforcement treated missing critical masks as invalid, causing repeated cache churn for players.
- **Risk:** `Critical` for player visual parity/effect availability.
- **Fix applied:**
  - Direct-probe mode now probes all known mask suffixes, relying on probe-result caching to prevent repeated 404 spam.
  - Critical-mask cache invalidation is now enforced for GM only; player clients keep stable cached bundles even when critical masks are absent.
- **Expected outcome:** Player clients can load all available masks and keep a stable bundle instead of repeatedly invalidating/reloading when `_Specular` is missing.

#### 10) `scripts/scene/composer.js` (player bypass-cache retry loop) — FIXED

- **Issue:** Composer retried `loadAssetBundle(..., bypassCache:true)` whenever `outdoors/tree/bush/fire` were missing. On player clients this can repeatedly bypass caches and retrigger direct probes, creating persistent HEAD storms and unstable effect initialization.
- **Risk:** `Critical` for player load stability/effect readiness.
- **Fix applied:** Missing-mask bypass retry is now GM-only. Players keep the stable first-pass bundle and skip forced bypass retries.
- **Expected outcome:** Player clients stop re-entering probe/reload churn when optional/missing masks are detected.

#### 11) `scripts/assets/loader.js` (player-only direct probe case-sensitivity) — FIXED

- **Issue:** Player clients use direct URL probing when FilePicker browse is unavailable. On hosted Linux, mask filenames are case-sensitive, so probing only canonical suffix casing (e.g. `_Specular`) can miss valid lowercase-authored files (e.g. `_specular`), causing player-only load failure while GM browse still works.
- **Risk:** `Critical` player-only asset resolution failure.
- **Fix applied:** `probeMaskUrl()` now probes a safe suffix-case set (`suffix` and `suffix.toLowerCase()`) across supported formats, with existing positive/negative probe caching preserved.
- **Expected outcome:** Player direct probes resolve authored masks regardless of suffix case convention, matching GM behavior more closely.

#### 12) `scripts/assets/loader.js` (unified GM/player discovery pipeline) — FIXED

- **Issue:** Runtime loader still diverged by role:
  - GM path: FilePicker directory listing (authoritative filenames)
  - Player path: URL probing/guessing (non-authoritative)
- **Risk:** `Critical` role divergence and player-only failures.
- **Fix applied (single runtime system):**
  - Removed direct URL probing from `loadAssetBundle` mask resolution path.
  - Added shared scene asset-file manifest (`flags.map-shine-advanced.assetFileManifestV1`) keyed by `basePath`.
  - GM writes discovered file lists to manifest during successful FilePicker browse.
  - All users (including players) read the same discovered list from manifest when FilePicker browse returns no files.
  - Cleared manifest memory cache from `clearCache()`.
- **Expected outcome:** Player mask resolution uses the same discovered filename list as GM (authoritative list), eliminating role-specific URL-guess behavior in runtime loading.

#### 13) `scripts/assets/loader.js` (GM-assisted manifest bootstrap for players) — FIXED

- **Issue:** In scenes with no preexisting manifest, a player joining first could still fail discovery if FilePicker browse is restricted and no GM had yet persisted file lists.
- **Risk:** `High` first-load reliability gap for players.
- **Fix applied:** Added module socket manifest bootstrap:
  - player requests manifest for `basePath` over `module.map-shine-advanced`
  - online GM handles request using FilePicker discovery
  - GM responds with authoritative file list and persists to scene manifest
  - player uses returned list immediately and caches it locally
- **Expected outcome:** Even without prewarmed manifest, players can converge to GM-identical file resolution during the same session when a GM is online.

#### 14) Foundry-native FilePicker source selection (core reliability fix) — FIXED

- **Issue:** We were browsing with `FilePicker.browse('data', ...)` for module asset paths (`modules/...`). In Foundry, module/system assets are normally browsed via `public` source; forcing `data` can fail for players while still appearing to work for GM in some deployments.
- **Risk:** `Critical` player-only discovery failure even when assets exist.
- **Fix applied:**
  - `scripts/assets/loader.js` `_discoverFilesViaFilePicker(...)` now selects browse source by path prefix:
    - `modules/` and `systems/` -> try `public` first, then `data`
    - `worlds/` -> try `data` first, then `public`
    - unknown -> try both
  - `scripts/scene/tile-manager.js` `_listDirectoryFiles(...)` updated with the same source-selection strategy to keep tile-mask discovery consistent.
- **Expected outcome:** Player and GM both discover module assets through the correct Foundry source, removing the primary role-based discovery mismatch.

#### 15) Player-first direct convention load fallback (no GM required) — FIXED

- **Issue:** After removing URL probe runtime path, player-first sessions (no GM online + no preexisting manifest + restricted browse) could end up with empty file discovery and zero loaded masks, causing silent effect breakage.
- **Risk:** `Critical` player-first load failure.
- **Fix applied:** In `loadAssetBundle`, when discovered file list is empty, attempt direct mask loading by convention:
  - try `${basePath}${suffix}.${format}` using preferred format order (scene background extension first, then standard formats)
  - load attempts use actual texture load path (no separate HEAD probe path)
  - cache resolved direct path (or miss) per `basePath+suffix` to avoid repeated retries
- **Expected outcome:** Players can still load mask-dependent effects in player-first sessions without requiring a GM to log in.

#### 16) Asset loading simplification to single system (FINALIZED)

- **Problem statement:** Previous iterations introduced multiple recovery routes (manifest/socket/direct convention attempts). User requirement is one reliable system regardless of role.
- **Final architecture now:**
  - One runtime discovery mechanism for GM and player: `FilePicker.browse(...)` directory listing.
  - Source selection follows Foundry path semantics:
    - `modules/`, `systems/` -> `public` first (then `data`)
    - `worlds/` -> `data` first (then `public`)
  - Mask resolution only uses discovered files (`findMaskInFiles`).
  - Removed runtime URL-probe mask resolution path from `loadAssetBundle`.
  - Removed GM-manifest/socket branch from runtime discovery path.
- **Resulting behavior:** no role-based branching in mask resolution logic; both GM and player go through the same discovery + resolve pipeline.

#### 17) Single-system deterministic resolver when listing unavailable — FIXED

- **Issue:** If FilePicker listing returns empty (player permissions/host setup), mask-dependent effects could still fail because no concrete mask paths were resolved.
- **Fix applied:** Added `_resolveMaskPath(...)` as part of the same runtime flow:
  - uses discovered list when present
  - otherwise performs deterministic convention resolution (`${basePath}${suffix}.${ext}`) using a short, preferred format order and per-mask cache
  - same code path for GM and player (no role branch)
- **Reliability impact:** effects now wait for and attempt concrete texture loads even when directory listing is unavailable, preventing silent zero-mask startup.

#### 18) Deterministic resolver case-variant parity with GM matching — FIXED

- **Issue:** GM file-list matching is effectively case-insensitive (normalized compare), while deterministic player URL attempts were case-sensitive and could miss lowercased exported filenames on Linux hosts.
- **Fix applied:** deterministic resolver now tries controlled variants:
  - base path variants: original, full lowercase, lowercase basename
  - suffix variants: original and lowercase
  - format variants: preferred format order
- **Expected outcome:** player deterministic resolution can find the same files GM would match from listing even when filename casing differs.

## Detailed Audit Checklist (Per File)

For every file in inventory:

- [ ] Record exact guard expression(s): e.g. `if (!game.user?.isGM) return`
- [ ] Record affected code path name/function
- [ ] Mark runtime phase: startup, canvasReady, steady-state, interaction, save-only
- [ ] Determine impact on players:
  - [ ] Hard block (load fails / black scene / no visibility)
  - [ ] Soft degrade (missing masks/effects, delayed visuals)
  - [ ] Authoring-only (safe)
- [ ] Determine whether there is a non-GM fallback path
- [ ] Verify fallback is deterministic and does not loop/retry forever
- [ ] Verify logging exists and is role-aware (GM vs player)
- [ ] Define test case for player account

## Player Validation Matrix (Must Pass)

### A. Initial Scene Load

- [ ] Player cold-loads scene without infinite recomposition or preload loops
- [ ] Player receives visible scene (not all-black, not all-hidden)
- [ ] Missing FilePicker browse capability does not block scene readiness

### B. Fog and Vision

- [ ] Player sees expected LOS/FOW from owned token immediately or within bounded retry
- [ ] No permanent fail-closed state if token ownership resolution is late
- [ ] Visibility fallback behavior does not collapse to "GM only visible"

### C. Floor/Mask Pipeline

- [ ] Floor transitions do not thrash cache on player client
- [ ] Player can switch floors without repeated cache miss spam
- [ ] Player receives same critical masks as GM for active floor

### D. Runtime Sync

- [ ] GM-authoritative scene writes (darkness/time/settings) propagate cleanly to players
- [ ] Player UI gracefully handles restricted world-setting writes
- [ ] No player-only stale state requiring GM intervention mid-session

## Deliverables from This Plan

1. A reviewed matrix (`file -> gate -> impact -> risk -> fix`) for all 51 files.
2. A short remediation list:
   - Required fixes (blocker/high)
   - Recommended hardening (medium)
   - Documentation-only clarifications (low/context)
3. Regression checklist for future releases (GM + player parity smoke tests).

## Immediate Next Pass (Implementation-Oriented)

1. Add temporary diagnostics in high-risk files:
   - role
   - active token ownership count
   - vision source readiness
   - floor preload/composition state
2. Reproduce with player account on target scene(s).
3. Patch fail-closed branches to bounded retry/fail-soft behavior where safe.
4. Re-run validation matrix and capture before/after logs.

## Next Audit Batch (Pending)

Prioritize remaining runtime-adjacent files before UI-only files:

1. `scripts/assets/loader.js` (player browse fallback and mask completeness)
2. `scripts/scene/token-movement-manager.js` (door/fog path permissions)
3. `scripts/scene/wall-manager.js` (secret/visibility interactions)
4. `scripts/scene/token-manager.js` (ownership/hidden token visibility)
5. `scripts/ui/tweakpane-manager.js` (confirm player-safe personal config paths vs GM-only scene controls)

## Current Findings About "Player Config" Access

- `Map Shine Config` / `Control Panel` / authoring tools remain GM-only (intended).
- Per-client player options remain available via client settings and graphics options.
- Player effect overrides in `tweakpane-manager` currently support enable/disable at client scope (full parameter authoring remains GM-scene scope by design).
