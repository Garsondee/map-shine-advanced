# Fog of War Session Persistence — Full Audit & Redesign Plan (2026-03-26)

## Problem statement

**Symptom:** Fog of War (exploration memory) does not reliably persist “between sessions” from the user’s perspective.

In practice there are *two distinct* classes of failures:

1. **Persistence failure**: exploration data never gets written (or gets overwritten/reset) so the next session starts blank.
2. **Presentation failure**: exploration data *is* present in Foundry’s `FogExploration` doc, but Map Shine’s V2 fog plane is hidden/bypassed, making it look reset.

This document audits current behavior end-to-end and proposes a redesign that can be **Levels-aware** and robust across reloads, scene switches, and floor changes.

---

## Goals / non-goals

### Goals
- **G1. True persistence**: explored areas persist across reloads and reconnects for each `(scene, user)` as Foundry expects.
- **G2. Visual correctness**: GM and players see fog consistently after reload with no “it reset” confusion.
- **G3. Levels-aware exploration**: multi-floor scenes must not bleed exploration between floors/elevation bands.
- **G4. Concurrency-safe**: avoid multiple writers fighting over the same `FogExploration` payload.
- **G5. Fault-tolerant**: scene transitions must not hang or corrupt fog; saving failures should degrade gracefully.

### Non-goals (for the initial redesign spike)
- Perfect 1:1 reproduction of Foundry’s fog shader visuals.
- Perception/vision correctness for all detection modes (that’s separate; we’ll only ensure persistence is correct).

---

## Current architecture (as of 2026-03-26)

### A) Foundry core persistence model (baseline)
- Foundry persists exploration in a **FogExploration document** keyed by **`scene` + `user`**.
- The persisted payload is a `data:image/...;base64,...` in **`explored`**.
- Reset is authoritative via `canvas.fog.reset()` and/or `resetFog` socket broadcast.

### B) Map Shine V2 fog overlay (FogOfWarEffectV2)
**File:** `scripts/compositor-v2/effects/FogOfWarEffectV2.js`

Map Shine renders fog as a Three world-space plane and (currently) also owns an exploration RT:

- **Vision RT**: rasterized from LOS polygons, lights, etc.
- **Exploration RT**: GPU ping-pong accumulation:
  - `explored = max(previousExplored, currentVision)`
- **Persistence**: V2 periodically encodes the exploration RT and writes to Foundry’s `FogExploration` document via:
  - `CONFIG.FogExploration.documentClass.load/create/update`

Also:
- V2 **suppresses native fog visuals** (`canvas.fog.visible=false`, sprite hidden) but does *not* necessarily disable Foundry’s native persistence job unless explicitly patched.
- V2 listens to Foundry fog lifecycle:
  - Hooks: `createFogExploration`, `updateFogExploration`, `deleteFogExploration`
  - Socket: `resetFog` broadcast → clears V2 buffers

### C) Legacy/custom fog persistence code exists but appears unused
**File:** `scripts/vision/FogManager.js`
- Has its own save/load path into `canvas.fog.exploration`.
- Repo search suggests it’s not instantiated by current runtime wiring.

---

## Observed reality from console snapshot (2026-03-26)

The diagnostic snapshot showed:
- `canvas.fog.exploration.explored` was **non-empty** (base64 webp data URL).
- `FogOfWarEffectV2._explorationLoadedFromFoundry === true`.
- Yet fog “looked reset” because:
  - GM bypass logic hid the fog plane when no tokens were controlled.

**Key insight:** at least one “doesn’t persist” report was a **presentation-layer bypass**, not a storage-layer failure.

---

## Known failure modes (audit)

### F1) GM bypass makes fog look reset after reload
Reload clears controlled tokens; old logic bypassed fog for GM when no token was controlled.

**Fix already applied:** do not bypass fog solely because GM has no controlled tokens.

### F2) V2 save cadence + teardown can drop writes (especially reloads)
V2 persistence was debounced and rate-limited; if a reload/scene transition happens before a save completes, the latest explored area may never be persisted.

**Mitigation already applied:** best-effort flush attempt during `canvasTearDown` (non-blocking).

### F3) Multiple writers updating FogExploration
If Foundry’s native fog manager is still accumulating/saving while V2 also writes `FogExploration.explored`, we can get:
- race conditions
- transient writes derived from inconsistent canvas dimensions
- fog worker (`FogExtractor`) failures
- apparent resets/rollbacks

This is *especially* likely during scene switches and when hooks/RTs are being rebuilt.

### F4) Levels / floor transitions invalidate meaning of a single 2D exploration texture
Map Shine currently resets exploration when the elevation band changes (to mimic some Levels behaviors), but:
- The persisted storage is still a single `explored` texture per `(scene, user)`.
- That means any attempt at “persist per-floor” needs a new persistence key or layered storage.

### F5) Data shape drift across Foundry versions
FogExploration doc shapes differ (`doc.explored` vs `doc.data.explored` vs `_source`).

**Fix already applied:** tolerate multiple shapes on load.

---

## Rethink: what should own exploration persistence?

We need to decide between two clean models (and avoid hybrids).

### Option 1 — **Use Foundry native exploration as the source of truth**
**Principle:** Foundry computes + persists fog; Map Shine only renders it.

Implementation direction:
- Stop accumulating our own exploration RT entirely.
- Extract Foundry’s exploration texture for rendering:
  - `canvas.fog.sprite.texture` (PIXI texture) → share the WebGL handle with Three (like `FoundryFogBridge`).
- Never write `FogExploration.explored` ourselves.

Pros:
- Minimal persistence code.
- No concurrency (single writer).
- Matches Foundry behavior and long-term compatibility.

Cons:
- Hard to make **Levels-aware per-floor persistence** because Foundry exploration is 2D world-space and not floor-separated.
- Foundry exploration texture is sometimes tied to internal PIXI/canvas lifecycle; careful with context sharing.

When to choose:
- If we prioritize reliability and “don’t fight Foundry” over Levels floor separation.

### Option 2 — **Map Shine owns exploration persistence (custom), Foundry fog persistence is disabled**
**Principle:** Map Shine computes + persists exploration; Foundry becomes a storage backend only (or is bypassed entirely).

Implementation direction:
- Disable Foundry native fog manager persistence/accumulation (not just visuals).
- Own a dedicated persistence format that supports Levels:
  - `explorationKey = sceneId + userId + elevationBandKey`
- Persist either:
  - multiple textures (one per band), or
  - a single packed atlas + metadata.

Pros:
- Full control over Levels compatibility (per-floor exploration).
- Can design for our rendering pipeline and performance constraints.

Cons:
- We must re-implement “when/how to save” robustly (including failure recovery).
- We must handle migration, storage size, and bandwidth.
- Higher maintenance risk across Foundry versions.

When to choose:
- If per-floor exploration correctness is mandatory and we accept owning the subsystem.

### Option 3 — Hybrid (current state) — **Not acceptable**
Any model where both Foundry and Map Shine are “sort of” persisting exploration tends to:
- produce race conditions
- create intermittent resets
- be un-debuggable across modules

We should converge to Option 1 or Option 2.

---

## Levels-aware persistence design (for Option 2)

### Define a stable “elevation band key”
Use Levels context when enabled; otherwise a single default band:
- `bandKey = "default"` when Levels off.
- `bandKey = "bottom:{n}|top:{n}"` (normalized numeric range) when Levels on.

Requirements:
- Must remain stable across session reload.
- Must match the same concept used in wall-height filtering and floor navigation.

### Storage location candidates

#### S1) Store in `FogExploration` **flags**
Keep using the FogExploration doc (per user+scene) but move the Map Shine data into `flags.map-shine-advanced.*`:
- `flags.map-shine-advanced.explorationBands[bandKey] = base64Webp`
- Optionally keep `explored` either unused or set to something stable.

Pros:
- Correct scoping (already per user+scene).
- Avoids inventing a new doc type.

Cons:
- Potentially large flags payload.
- Still must ensure Foundry native persistence is disabled to avoid conflicts.

#### S2) Store on `User` document flags
`game.user.setFlag('map-shine-advanced', 'fogExploration', {...})` keyed by sceneId + bandKey.

Pros:
- Naturally per-user.

Cons:
- Data grows with number of scenes; can get very large.
- Harder to manage cleanup when scenes are deleted.

#### S3) Store on `Scene` flags (NOT OK for player exploration)
Scene flags are world-shared; fog exploration is player-specific.

Conclusion:
- If we own persistence, **S1 (FogExploration flags)** is the best fit.

### Data format options

#### D1) Base64 webp per band
Simple, similar to Foundry.

#### D2) Binary compression + chunked storage
Not recommended unless size forces it; complexity is high.

#### D3) Atlas
Pack multiple bands into one image and store metadata.
Complex and likely unnecessary until proven needed.

---

## Proposed direction (recommended next step)

### Phase 0 — Instrumentation & decision gate
Before rewriting, we must gather evidence:
- Is Foundry native fog manager still saving while V2 writes?
- How often is `FogExploration.explored` being updated and by who?
- Do scene transitions/reloads produce worker errors or failed saves?

Decision gate:
- If we can reliably run Option 1 (render Foundry textures only) and accept 2D exploration, **choose Option 1**.
- If multi-floor exploration separation is a hard requirement, **choose Option 2** and fully disable Foundry persistence.

### Phase 1A — Implement Option 1 (Foundry-as-authority) spike
- Wire `FoundryFogBridge` (or equivalent) into `FogOfWarEffectV2`:
  - Use Foundry’s vision/exploration textures directly.
  - Remove `_accumulateExploration()` and `_saveExplorationToFoundry()` calls from the runtime path (leave code behind feature-gated initially).
- Verify persistence with no Map Shine writes.

### Phase 1B — Implement Option 2 (MapShine-as-authority) spike
- Add explicit setting: `mapShine.fog.persistenceMode = 'foundry' | 'mapshine'`.
- In `mapshine` mode:
  - Disable Foundry native fog persistence/commit/save (not only visuals).
  - Persist per-band exploration in `FogExploration.flags.map-shine-advanced`.
  - Load band on elevation change; render the correct band.

---

## Test plan (must pass)

### Session persistence
- Reveal area, reload browser → explored area remains.
- Reveal area, restart Foundry server → explored area remains.

### Scene transition
- Rapidly switch between 2 fog-enabled scenes and back.
- Confirm no fog worker errors and explored areas remain consistent.

### Multi-floor (Levels)
- Reveal area on floor A → switch to floor B → exploration should be independent (if Option 2 / per-band).
- Reload → both floors retain their own exploration.

### GM vs player behavior
- GM with no controlled tokens should still see fog (unless Map Maker mode explicitly bypasses).
- Player with owned tokens but none selected should still see appropriate fog behavior.

---

## Open questions
- What is the exact desired UX for GM fog when no token is selected? (Always show fog vs show full map.)
- What is the expected behavior when switching floors: keep exploration per floor forever, or reset per-floor each time (Levels-like)?
- Storage budget: how large can `FogExploration` flags safely become in typical worlds?

---

## Research checklist (next work session)

### R1) Confirm whether Foundry native fog is still a writer
Targets:
- `foundry.canvas.perception.FogManager` (or `CONFIG.Canvas.fogManager`) methods:
  - `save()`, `commit()`, and any internal debounced save scheduling
- Observe:
  - does `updateFogExploration` fire even when MapShine hides native visuals?
  - does `canvas.fog.exploration.timestamp` update without MapShine calling its own save?

### R2) Identify all MapShine code that writes FogExploration
Targets:
- `FogOfWarEffectV2._saveExplorationToFoundry`
- Any legacy paths (verify unused):
  - `scripts/vision/FogManager.js`

### R3) Identify all MapShine code that “makes it look reset”
Targets:
- GM bypass logic in `FogOfWarEffectV2._shouldBypassFog`
- Any Map Maker mode overrides that affect fog/visibility
- `FogOfWarEffectV2._suppressNativeFogVisuals` (ensure it is visual-only)

### R4) Levels signals and persistence keying
Targets:
- `Hooks.on('mapShineLevelContextChanged', ...)` and payload shape
- `window.MapShine.activeLevelContext` fields (`bottom`, `top`)
- Existing per-floor behavior: `FogOfWarEffectV2._checkElevationBandChange()`

### R5) Decide authority model and remove hybrid behavior
Decision:
- Option 1 (Foundry-authority): rendering bridge only, no MapShine persistence writes.
- Option 2 (MapShine-authority): disable Foundry persistence + implement per-band storage.

