# Stair movement regression — planning document

**Created:** 2026-03-25  
**Status:** Active investigation — **no user-visible improvement** after latest compat/movement tweaks; **document vs MapShine graphics desync** reported after stair (movement stays broken until refresh / re-selection in some cases).  
**Related work:** Fog of War per-grid updates; Foundry checkpoint / waypoint movement pipeline

## Latest validation (user report)

After successive code changes (camera suppression, region stair choreography, constrain-option sanitization, Levels-style `stopMovement` + `move(pending)` in compat):

- Tokens are still **blocked by walls on floors below** the token when movement goes through **Foundry’s** constrained / checkpoint pipeline.
- Tokens still **stop on the grid cell before the stair**; **elevation then changes**; afterward **token document and graphics do not realign** and movement remains unreliable.

**Design note — Foundry vs MapShine wall height:** MapShine’s own systems (e.g. visibility) can treat walls as having **top/bottom** bands (`readWallHeightFlags`, perspective elevation in `wall-manager.js`). **Foundry’s native token movement / collision** does not use MapShine’s 3D wall interpretation; it uses core constraints (`constrainOptions`, internal collision tests). Any path that **delegates horizontal steps to Foundry** must either: (a) pass options that make Foundry’s model match the intended floor band, (b) **pre-filter** which walls exist for that move, (c) use **`ignoreWalls`** (or equivalent) when MapShine has already validated the route at the correct elevation, or (d) avoid delegating that segment to Foundry entirely. This gap is still **largely unaddressed** in code beyond partial `destinationFloor` / `collisionElevation` plumbing.

## Problem summary

When moving a token onto a staircase (drag or pathfind), behavior is wrong in several linked ways:

1. **Floor / scene switches too early** — The active level or scene presentation changes as soon as a move *toward* the stair is started, not when the token **arrives** at the stair cell.
2. **Token position is wrong** — Document position and/or Three.js / MapShine visuals do not stay aligned with the intended grid path.
3. **Movement after the stair is broken** — Subsequent moves may start from an inconsistent state (document vs. visual token, or Foundry movement continuation).

Elevation numeric values were separately fixed to sensible integers (no more spurious `10.001` from seam-epsilon in movement payload elevation). **The timing and continuation issues above remain.**

## User-visible symptoms (checklist)

- [ ] Level / UI switches at **start** of path to stairs, not on **arrival**.
- [ ] Token appears to stay in the wrong place while elevation or floor context changes.
- [ ] After one bad stair interaction, **pathfind or drag** behaves incorrectly until refresh or re-selection.

## Context: what changed before this regressed

These improvements were made for **Fog of War** and **grid-faithful movement**:

- Movement emission aligned with **Foundry’s checkpointed** movement (`TokenDocument.move`, per-step payloads, `includeMovementPayload`, etc.).
- **Perception / sight** cadence increased (movement steps and hooks firing more often).
- **Map Shine** continues to drive token **visuals** via `TokenManager` / Three.js, with Foundry PIXI tokens largely transparent or bypassed.

**Hypothesis:** stair and level logic (region handlers, `switchToLevelForElevation`, `activeLevelContext`, token follow helpers) was tuned for **coarser** updates (fewer steps, single endpoint updates). Finer-grained movement and earlier hooks may now trigger **stair / floor side effects** at the wrong phase of the route.

## Technical findings so far

### 1. Levels region stair compatibility (`region-levels-compat.js`)

- Stairs implemented via **ExecuteScript** region behavior patch and/or **legacy drawing** stairs (`updateToken` hook).
- `_applyRegionMovement` receives `event.data.movement` when the token is moving under Foundry’s movement system.
- **Evolution of attempts (see § “Fix attempts implemented” for detail):**
  - **Earlier hypothesis:** naively nesting **`tokenDocument.move(...)`** inside a region handler **without** Foundry’s **`stopMovement` → replay `pending`** contract could corrupt continuation.
  - **Attempt A:** Wait for **`Hooks.on('updateToken')`** **`x`/`y`** (first delta), pause, then **`update({ elevation })`** + MapShine sprite sync — **rejected in practice:** “first” position change is often **not** stair arrival; elevation and floor still flipped early; pending route still wrong for Foundry collision.
  - **Attempt B (current code):** **`await movementAnimationPromise`** → **`stopMovement()`** → await animation again → pause → if **`pending.waypoints`** snapshot non-empty, **`move(adjusted, { … updateOptions, constrainOptions })`** Levels-style; else **`update({ elevation })`**; then **`updateTokenSprite`** + **`switchToLevelForElevation`** for controlled tokens.
- **User outcome after B:** stair cell still not reached reliably; **doc vs sprite desync** after elevation; movement pipeline still unhealthy — so **either** the replay snapshot / timing is still wrong for MapShine’s hybrid stack, **or** a different layer (Foundry placeable state, active tracks, region event ordering vs oversized regions) is the real bottleneck.
- **Remaining gap:** Tight **geometry / position gates** (Phase B) and a **recovery** path when document and MapShine sprite diverge are still not implemented.

### 2. Elevation seam bug (fixed separately)

- `_resolveMovementPayloadElevation` in `token-movement-manager.js` used **`min + 0.001`** (seam epsilon), producing token elevations like **`10.001`**.
- **Fixed:** band logic without that visible offset; normalization in region handler for stair targets.

### 3. Early floor / scene change (likely suspects)

Things to audit in order:

| Suspect | Why |
|--------|-----|
| **`switchToLevelForElevation`** (e.g. `toBottom + 0.001` in `_followSelectedTokenFloorTransition`) | May run on **elevation preview** or **destination floor** in movement options before the token finishes stepping. |
| **`CameraFollower`** (`scripts/foundry/camera-follower.js`) | **`Hooks.on('updateToken')`**: when **`elevation`** changes on a **controlled** token, **`_syncToControlledTokenLevel`** → **`mapShineLevelContextChanged`** if **`_shouldAutoSyncControlledTokenEvents()`** — **`true`** for **`follow-controlled-token`** lock, or for **non-GMs** with a controlled token; **`false`** for **GMs** in **manual** lock (hook skipped). **Immediate** stack sync when the hook runs — **no** built-in dwell after horizontal movement. **`update()`** also calls **`_syncToControlledTokenLevel({ emit: false })`** when **`_lockMode === 'follow-controlled-token'`** (internal active index tracks token elevation every frame without always re-emitting). Any path that writes **elevation** while the hook/policy allows sync will couple floor/camera to that write** — conflicts with “pause on the stair tile” unless **suppressed** or **deferred** (§8). |
| **Region event lifecycle** (core) | Move-related region events run from `TokenDocument._onUpdateOperation` when `operation._movement` is present — **after** that commit, not at path preview. `TOKEN_MOVE_WITHIN` can fire on **every** step while the token remains inside a region it was already in (`_priorRegions`); **oversized stair regions** can spam handlers before the stair *tile*. Prefer `CONST.REGION_EVENTS` names (`tokenMoveIn`, etc.); legacy `tokenMove` is deprecated. |
| **`Hooks.on('updateToken')`** ordering | Elevation updates interleaved with `x`/`y` from continuation can reorder vs. MapShine sprite updates. |

### 4. Wall / visibility flicker (related noise)

- Separate thread: high-frequency `sightRefresh` / `controlToken` vs. `WallManager.updateVisibility` and PIXI wall suppression. Not the root of stair position, but same “more hooks during checkpoint movement” family.

### 5. Foundry core — region events and `movement` payload (`foundryvttsourcecode`)

Verified in `resources/app/client/documents/token.mjs`:

- **When handlers run:** `TOKEN_ENTER` / `TOKEN_EXIT` / `TOKEN_MOVE_IN` / `TOKEN_MOVE_OUT` / `TOKEN_MOVE_WITHIN` are dispatched during `_onUpdateOperation`, alongside `moveToken` — i.e. after the **embedded token update** for that movement step, not when the path is only previewed.
- **`event.data` shape:** Region move handlers receive `{ token, movement }`. `movement` is the **`TokenMovementOperation`** for that update. There is **no separate “global waypoint index”** field; infer progress from **`passed.waypoints`** (committed this step), **`pending.waypoints`**, **`origin` / `destination`**, **`state`**, and per-waypoint **`checkpoint`** (Foundry can insert implicit checkpoints for region-aware splitting).
- **`#splitMovementPath`:** Core may insert **implicit checkpoints** at the first region boundary along a segment when behaviors subscribe to move-related events — long routes are split so boundary crossings align with commits.
- **`TOKEN_MOVE_WITHIN` nuance:** Emitted for regions the token **already occupied** before the update (`operation._priorRegions`). If the token starts inside a **large** stair region, the behavior can run on **early steps** while still “only walking toward” the stair footprint — overlaps the “switches too early” symptom unless Regions are tight or handlers gate on position.

### 6. Map Shine — `_followSelectedTokenFloorTransition` and group paths (`token-movement-manager.js`)

- **`_moveTokenToFoundryPoint`** (after a successful step + settle): if `options` has finite **`destinationFloorBottom` / `destinationFloorTop`**, it builds `targetFloor` and calls **`_followSelectedTokenFloorTransition`** → **`switchToLevelForElevation(toBottom + 0.001, ...)`** (for the **selected** token). So the **UI level** can follow **destination-floor options**, not only the token’s current landed band.
- **Cross-floor walk segments** (`_executeCrossFloorRouteSegments`): pass **per-segment** `floorKey` into options when walking — sensible.
- **Group timeline** (`_executeGroupTimeline`): passes the **same** `options` into **`_moveTokenToFoundryPoint`** for every **`GROUP_PATH_SEGMENT`** step. If upper layers attach **route-final** `destinationFloor*` to that object, **every grid step** can trigger floor follow after the first step — strong hypothesis for “level switches as soon as I start moving” independent of region scripts.
- **Mitigation direction:** Only pass `destinationFloor*` when the step’s intended elevation band matches, or gate **`_followSelectedTokenFloorTransition`** on **landed** elevation / segment metadata (aligns with Phase C).
- **Pointer-up drag (`interaction-manager.js`):** `executeDoorAwareTokenMove` / `executeDoorAwareGroupMove` are called with **`destinationFloorBottom` / `destinationFloorTop` = `activeLevelContext`** (the **currently viewed** floor). For a **same-floor** path, that usually matches the token’s band, so **`_followSelectedTokenFloorTransition`** often **no-ops** (`sameBand`). Early UI switch from **group `options` alone** is more likely when **cross-floor** planning injects a **different** band somewhere in the pipeline, or when **`_followSelectedTokenFloorTransition`** runs **after** an elevation change with stale vs target band mismatch — less often the primary “first step” bug than **camera-follower on `elevation`** or **region elevator firing early**.

### 7. Levels module — reference behavior (`othermodules/levels`)

For comparison only; Map Shine does not use Levels at runtime when compatibility mode replaces region scripts.

- **`RegionHandler`** (`scripts/handlers/regionHandler.js`): **`game.user !== event.user` → return** (initiator-only), same intent as compat’s `_sameUser`.
- **Elevation gating:** e.g. `stair` requires `elevation === bottom || elevation === top`; `stairUp` / `stairDown` use band checks — avoids flipping when the token is not on the edge the handler expects.
- **Continuation contract:** **`updateMovement`** calls **`tokenDocument.stopMovement()`**, awaits **`movementAnimationPromise`**, then **`tokenDocument.move(...)`** on **`movement.pending.waypoints`** (non-intermediate) with new **`elevation`** and **`action: "displace"`**, reusing **`movement.updateOptions`**, **`constrainOptions`**, **`autoRotate`**, **`showRuler`**. Levels assumes the **stock** Foundry/PIXI token pipeline; it **does not** match our **avoid nested `move()`** MapShine strategy.
- **Legacy drawing stairs:** **`preUpdateToken`** → **`DrawingHandler.executeStairs`** (controlled token, `x`/`y` changing); polygon containment + **`token.inStair`** to avoid double-fire; elevation often applied via **`Hooks.once("updateToken", ...)`** after animation; **`stairUpdate`** flag bypasses 3D collision logic on that update.

**Takeaway:** Levels’ region pattern is **stop → wait → replay pending via `move()`**. Our compat path (**wait for `x`/`y` → `update({ elevation })` → MapShine sync**) is a deliberate divergence; parity may require equivalent **continuation state** handling, not a literal copy of Levels’ `move(pending)`.

### 8. Camera / level coupling on elevation (answered — root cause family)

**File:** `scripts/foundry/camera-follower.js`

- On **`updateToken`**, if **`elevation`** is in `changes` and the token is **controlled**, **`_syncToControlledTokenLevel({ emit: true, reason: 'token-elevation-update' })`** runs subject to `_shouldAutoSyncControlledTokenEvents`.
- That updates **`_activeLevelIndex`**, sets **`window.MapShine.activeLevelContext`**, and fires **`mapShineLevelContextChanged`** — compositor, tiles, fog, etc. react **immediately**.

**Consequence:** Any stair / region / zone path that applies **`tokenDocument.update({ elevation })`** (including **`region-levels-compat`** after deferral, **`zone-manager`** `_handleStairZone`, or Foundry + MapShine sync) **forces the viewed floor to track the new elevation** without a designer-controlled **pause** after horizontal motion.

**Not** from Foundry core: region **`ExecuteScript`** runs **after** the movement commit; **Levels** module is not in the loop when MapShine compatibility handles regions.

## Target UX (product intent)

**Desired sequence:**

1. Token **visibly** walks the full horizontal path to the stair cell (document + MapShine sprite stay aligned).
2. **Short pause** (readable beat; order of ~150–400 ms or configurable).
3. **Then** apply **vertical** transition: **elevation** update, **active level / camera-follower context** (and dependent 3D stack), so floor + token read as one **deliberate** transition.

**Implication:** Elevation writes and **`switchToLevelForElevation` / `_syncToControlledTokenLevel`** must **not** run in the same conceptual frame as the last horizontal step unless we **explicitly delay** them or **suppress** auto-follow until the pause completes.

## Goals (acceptance criteria)

1. **Floor / scene (Levels) switch** only when the token **occupies** the stair cell (or region-defined arrival condition), not when the user **initiates** a path that eventually crosses the stair.
2. **Single authoritative movement pipeline** — no nested `TokenDocument.move` from compat layers during an in-flight checkpointed route unless Foundry documents a supported API for that.
3. **`x`/`y`/`elevation` and MapShine sprite** remain aligned after the transition; **next** move uses the same position the player sees.
4. Elevation remains **clean** (integers / scene-defined band values), no reintroduction of epsilon garbage on the token sheet.
5. **Stair beat (new):** After the token **reaches** the stair cell, enforce a **visible pause**, then perform **elevation + floor/camera** transition as a **single choreographed step** (see Target UX).

## Fix attempts implemented (chronological)

Concrete code changes tried **during this regression** (names refer to Map Shine modules). **User-visible outcome as of last test:** still failing (walls below block; stop short of stair; doc vs graphics desync).

| Order | Area | What was tried |
|------|------|----------------|
| 1 | **`token-movement-manager.js`** | **`_resolveMovementPayloadElevation`** — remove seam epsilon that produced elevations like `10.001` (separate numeric cleanup). |
| 2 | **`region-levels-compat.js`** | **`_normalizeStairElevation`** — snap stair targets to region `top`/`bottom` integers where appropriate. |
| 3 | **`camera-follower.js`** | **Floor-follow suppression** API (`beginFloorFollowSuppression` / `endFloorFollowSuppression` / per-token checks) so **`updateToken` elevation** does not immediately drive **`_syncToControlledTokenLevel`** during a choreographed window; wired into **`update`**, **`controlToken`**, **`updateToken`**, **`_syncToControlledTokenLevel`**. |
| 4 | **`region-levels-compat.js`** | **Stair choreography v1:** **`STAIR_TRANSITION_PAUSE_MS`** (~220 ms); wrap **`update({ elevation })`** with suppression; **`_syncMapShineTokenAfterDocElevation`** + **`switchToLevelForElevation`** after. |
| 5 | **`zone-manager.js`** | Same **pause + suppression** pattern around **`doc.update({ elevation })`** for stair/elevator zones (`_applyStairChoreographedElevationTransition`). |
| 6 | **`region-levels-compat.js`** | **Stair choreography v2:** replaced **`Hooks`-based “first `x`/`y` change”** wait (proved unreliable — fires on early path steps) with **Levels-like** flow: **`await movementAnimationPromise`** → **`stopMovement()`** → await again → pause → **`move(pendingSnapshot)`** with **`elevation`** + **`action: 'displace'`** and event’s **`updateOptions` / `constrainOptions`**, else **`update({ elevation })`**. |
| 7 | **`interaction-manager.js`** | Reduced passing **`activeLevelContext`** **`destinationFloor*`** into **`executeDoorAwareGroupMove` / `executeDoorAwareTokenMove`** on some path-walk paths (avoid wrong-floor collision *context* from the viewed floor). **Not exhaustive:** e.g. **keyboard** movement still injects **`activeLevelContext`** into `executeDoorAwareTokenMove` options. |
| 8 | **`token-movement-manager.js`** | **`_resolveCollisionElevation`** — if token **document** elevation is **clearly outside** caller **`destinationFloorBottom`/`Top`**, prefer **doc elevation** (guard against stale UI floor band in MapShine’s own collision). |
| 9 | **`token-movement-manager.js`** | **`_getFoundryConstrainOptions(options, tokenDoc)`** — omit **`destinationFloor*`** for Foundry when token doc elevation is **clearly outside** the provided band (so **`liveDoc.move`** / **`findMovementPath`** parity calls do not constrain against the wrong floor). Applied from **`_executeFoundryCheckpointMove`**, movement payload embedding, and parity helpers. |

**What these attempts do *not* cover:** they do not add a **MapShine-side wall set** (or height-aware filter) **into** Foundry’s internal collision when Foundry still tests walls in its own model; they do not implement **document ↔ sprite reconciliation** after a failed or partial `move()`; they do not add **region position gating** (only time/animation/pending-snapshot gating).

## Systems not yet meaningfully targeted (or only lightly touched)

Use this as a checklist for the **next** iteration — especially for **lower-floor wall blocks** and **post-stair desync**.

| System / file | Why it matters | Status |
|----------------|----------------|--------|
| **Foundry collision vs wall height** | MapShine **`wall-manager.js`** uses **`readWallHeightFlags`** + **`getPerspectiveElevation()`** for **line visibility**, not for **Foundry `TokenDocument.move`**. If Foundry treats segments as blocking against walls that MapShine would ignore at the token’s band, you still get **false blocks** until we **override constraints** (`ignoreWalls` after local validation), **wrap** core collision, or **stop delegating** that segment to Foundry. | **Not** systematically patched for movement. |
| **`ignoreWalls` / hybrid checkpoint policy** | **`token-movement-manager`** already sets **`ignoreWalls: true`** for some **path-walk** payload steps so Foundry does not re-clamp MapShine-validated routes; **native checkpoint move** (`preferFoundryCheckpointMove`) still uses Foundry constraints end-to-end. | **Checkpoint / drag path** not switched to “MapShine validates, Foundry only animates” as a default for multi-level scenes. |
| **`Token` placeable / movement state** | After **`stopMovement()` + partial `move()`**, Foundry may leave **`movement`**, animation contexts, or ruler state inconsistent with the document; MapShine **active tracks** may still think a route is active. | **No** dedicated **reset** or **heal** (e.g. clear **`activeTracks`**, force **`movementAnimationPromise`** settle, re-read doc → sprite). |
| **`token-manager.js`** | **`updateTokenSprite`** is called from compat after elevation; **no** full **resync from authoritative `TokenDocument`** when hooks detect **position/elevation drift** (e.g. compare last applied sprite pose to doc after stair). | **Light** touch only. |
| **`zone-manager.js`** | Stairs still use **`update({ elevation })`** after pause — **no** **`stopMovement` + `move(pending)`** parity with Levels / latest region compat. | **Different** code path from region stairs; may diverge in the same multi-level + checkpoint scenarios. |
| **Legacy drawing stairs** | **`_handleLegacyDrawingStairs`** in **`region-levels-compat.js`** (Hooks-based, **`Hooks.once`**, **`stairUpdate` flag**) — separate from **ExecuteScript** region **`movement`** contract. | Not unified with Levels-style continuation; may still race checkpoint moves. |
| **Region content + gates** | **Phase B** in this doc: tight regions, **`TOKEN_MOVE_IN` vs `TOKEN_MOVE_WITHIN`**, **token center inside footprint** before applying elevation. | **Planned**, **not** implemented as hard code guards (only informal reliance on event ordering). |
| **Group timeline / `destinationFloor*`** per step | §6 hypothesis: **same options object** passed for every group segment can over-trigger floor follow or wrong band. | **Gated** in places; **not** fully audited end-to-end for all **GROUP_PATH_SEGMENT** combinations. |
| **Compositor / FOW / perception** | More frequent **sight refresh** and hooks during checkpoint movement; could amplify **visible** desync or stall **continuation** if something waits on perception. | **Not** treated as root cause; **not** tuned for stair recovery. |
| **Core / libWrapper** | Monkey-patching **`TokenDocument#move`**, **`#*_constrainMovement`**, or collision backend to inject elevation-aware wall tests. | **Not** attempted (maintenance cost high). |
| **Nav mesh / HPA** | Offline graph vs **Foundry `findMovementPath`** parity — divergence could produce routes Foundry then **truncates**. | Parity exists for some flows; **not** re-validated under “stair + checkpoint + region” combo. |

## Are we in a good position to solve this?

**Yes.** The pipeline is **under our control** in a small set of modules; there is no missing Foundry API blocking the target UX.

| Lever | Role |
|--------|------|
| **`camera-follower.js`** | Add a **suppression flag** or **queued transition**: skip or defer **`_syncToControlledTokenLevel`** on `updateToken`/`controlToken` when a **stair choreography** is active; after **pause**, call **`setActiveLevel`** / sync once. Alternatively temporarily **`setLockMode('manual')`** for the duration of horizontal approach, then restore + step. |
| **`region-levels-compat.js`** | After **`x`/`y`** settle, **`await`** configurable **`stairTransitionPauseMs`**, then **`update({ elevation })`** and optionally call **`switchToLevelForElevation`** explicitly so floor follows **once** (camera hook may still race unless suppressed). |
| **`zone-manager.js`** | Mirror the same **pause + single sync** after `doc.update({ elevation })`; defer **`_followControlledTokenFloorTransition`** until after pause **or** rely on central helper used by both region and zone paths. |
| **`token-movement-manager.js`** | Keep refining **`_followSelectedTokenFloorTransition`** gating (§6); avoid calling floor follow on **intermediate** steps when options describe **view** band not **step** band. |
| **Content** | Tight **region** geometry or **position gates** reduce spurious **`TOKEN_MOVE_WITHIN`** (§5). |

**Risks:** MapShine **sprite** vs **document** must stay aligned through the pause; after elevation, **`updateTokenSprite`** + any **continuation** of Foundry **`move()`** must still match the compat strategy. **Update:** we **do** now call **`stopMovement()`** before replaying **`pending`** (Levels-style); **desync still observed**, so risk has shifted to **MapShine track / placeable state**, **Foundry wall model mismatch**, and/or **invalid `pending` snapshot** for the hybrid stack — see **“Systems not yet meaningfully targeted.”**

## Next steps — detailed plan (research-backed)

This section turns the open problems into **ordered work**, with **code-level rationale** from the current repo (not generic advice).

### A. Research findings that constrain the solution

1. **Two different “wall universes”**  
   - **MapShine pathfinding** (`_computeConstrainedPathWithDirectAndEscalation`, `_resolveCollisionElevation`, graph edges) can respect **per-floor** / banded collision intent.  
   - **`executeDoorAwareTokenMove`** then often delegates the **same polyline** to Foundry via **`_executeFoundryCheckpointMove` → `TokenDocument.move(...)`** with **`constrainOptions`** (`destinationFloor*`, `ignoreWalls`, etc.). Foundry’s internal tests **do not** use MapShine’s wall-height visibility model (`wall-manager.js` / `readWallHeightFlags`).  
   - **Consequence:** A route MapShine proves valid can still be **truncated** or **blocked** inside `move()` → “**stops one cell before stair**” and “**walls below the token block**” are consistent with **delegation mismatch**, not only with region timing.

2. **Native checkpoint moves bypass `TokenMovementManager` locks/tracks ownership**  
   - **`executeDoorAwareTokenMove`** acquires **`_acquireTokenMoveLock`** and computes **`pathNodes`**, but a **successful** native path calls **`liveDoc.move(routeWaypoints)`** directly. **No** `activeTracks` entry is created by that call path itself.  
   - **Instead**, each Foundry commit fires **`Hooks.callAll('updateToken', ...)` → `token-manager.js` → `updateTokenSprite` → `TokenMovementManager.handleTokenSpriteUpdate`**, which may start a **walk / pick-up-drop** track and set **`activeTracks`** for **`dragging`** (and similar) methods.

3. **`stopMovement()` + compat choreography can orphan MapShine tracks**  
   - **`region-levels-compat.js`** calls **`tokenDocument.stopMovement()`** to implement Levels-style replay.  
   - **`TokenMovementManager._cancelTrack`** (used when superseding a track) **does not snap** the Three.js sprite; the comment says the **next** update should drive the pose. If Foundry **cancels** or **reorders** commits (replay `pending`, elevation-only branch, or partial failure), there may be **no** immediate `updateToken` that matches the pose the sprite was animating toward → **document and graphics diverge** and **`activeTracks`** may still think a move is in flight (keyboard guard, etc.).

4. **Door-aware native checkpoint is already disabled when doors are on the path**  
   - **`!hasDoorSteps`** is required for **`preferFoundryCheckpointMove`**. So “**ignore Foundry walls on checkpoint**” for a validated MapShine path does **not** automatically bypass door choreography on door-heavy routes; those already fall back to **sequenced** `_moveTokenToFoundryPoint` steps.

### B. Priority 1 — Make Foundry `move()` follow MapShine-validated horizontal geometry

**Goal:** If MapShine already computed a feasible path **with** wall constraints at the correct elevation, Foundry should **not** re-close doors that only exist in Foundry’s 2D/limited-elevation world model.

**Approach (recommended first experiment):**

- In **`executeDoorAwareTokenMove`**, when **`!ignoreWalls`** was used for **`_computeConstrainedPathWithDirectAndEscalation`** (i.e. path was **wall-validated** by MapShine) **and** `!hasDoorSteps`, call **`_executeFoundryCheckpointMove`** with merged options equivalent to **`ignoreWalls: true`** in **`constrainOptions`** (exact field Foundry expects is already centralized in **`_getFoundryConstrainOptions`**).  
- **Optional refinement:** introduce an explicit flag (e.g. **`mapShinePrevalidatedPath: true`**) instead of overloading **`ignoreWalls`** on the outer options object, so callers don’t confuse “user asked to ignore walls” with “Foundry should trust MapShine’s path.”

**Safety / edge cases to verify in the same change set:**

- **Portals / cross-floor:** ensure cross-floor branch (`_executeCrossFloorRouteSegments`) still uses appropriate per-segment constraints; do not blanket-ignore on segments that haven’t been validated the same way.  
- **User toggle:** a **scene or module setting** (“Use Foundry wall checks on checkpoint moves”) allows quick A/B if GMs need core parity.

**Acceptance signal:** Drag/path to a stair **no longer stops one short** when MapShine preview shows a full path; lower-floor walls stop falsely blocking **only on Foundry-driven** segments.

### C. Priority 2 — Forced sprite ↔ document reconciliation (stair + `stopMovement`)

**Goal:** After **`stopMovement()`**, elevation-only updates, or failed replay, **Three.js pose** and **`activeTracks`** must match **`TokenDocument`** so the next move doesn’t start from a lie.

**Approach:**

- Add a **small public** API on **`TokenMovementManager`**, e.g. **`resyncSpriteToDocument(tokenId, tokenDoc?, { reason })`**, that:  
  - looks up **`activeTracks.get(tokenId)`** — if present, **`_cancelTrack`** then **`activeTracks.delete(tokenId)`** and clear **keyboard queue** for that token;  
  - resolves **live** `TokenDocument` if needed;  
  - uses **`_computeTargetTransform(liveDoc)`** (or `token-manager` equivalent) to **set sprite position/rotation/scale once** with **`animate: false`** semantics;  
  - optionally calls **`tokenManager.updateTokenSprite(liveDoc, { x, y, elevation, ... }, { animate: false })`** with **full** authoritative fields to refresh floor assignment.

- **Call sites (minimum):**  
  - **`region-levels-compat._applyRegionMovement`**: immediately **after** **`stopMovement()`** (before pause/replay), and again **after** successful **`move(adjustedWaypoints)`** or **`update({ elevation })`**.  
  - **Consider:** same hook from **`zone-manager`** stair path if it ever mixes with Foundry/native moves.

**Acceptance signal:** After a stair transition, **no** “stuck mid-walk” sprite; **keyboard** path in **`interaction-manager`** (which blocks on **`activeTracks`**) works on the first try.

### D. Priority 3 — Region **position gates** (reduce wrong-phase stair triggers)

**Goal:** Only run **stop + replay + elevation** when the token is **actually** in the stair volume you care about, not only when **`TOKEN_MOVE_WITHIN`** fires inside a huge region.

**Approach:**

- In **`region-levels-compat`**, before **`stopMovement()`**, compute **token center** from **`tokenDocument`** + grid dimensions; test **inside** region polygon (Foundry region *geometry* API if available) or tight AABB for rectangular stairs.  
- Optionally require that the **last committed waypoint** in **`movement.passed`** (or **`movement.destination`**) lies on the **stair cell** or within ε of the **implicit checkpoint** Foundry inserted.  
- **Fallback:** if gate fails, **return false** (no-op) rather than half-applying elevation.

**Content lever:** shrink scene **ExecuteScript** regions to foot-print sized cells in parallel so code gates are a backstop, not the only fix.

### E. Priority 4 — **`zone-manager`** parity

**Goal:** Same hybrid failure mode can happen for **zone** stairs if the token arrived via **Foundry checkpoint** and zone code only **`update({ elevation })`**.

**Approach:** Extract **`_applyRegionMovement`’s** “**await animation → stop → pause → replay or update → resync**” into a **shared helper** (e.g. `stair-transition-choreography.js`) used by **region compat** and **zone-manager**, or call the same **`resyncSpriteToDocument`** after zone elevation.

### F. Priority 5 — Instrumentation (make the next bug impossible to guess)

Implement **Phase A** with **structured, greppable** logs (behind **`pathfinding` debug** or a **`stairDebug`** flag):

- Per stair attempt: `tokenId`, region/zone id, event name, **`passed.waypoints.length`**, **`pending.waypoints.length`**, first/last waypoint x/y, **`tokenDocument.elevation`**, **`constrainOptions`** passed to last **`move()`**, whether **`activeTracks`** had an entry **before/after** `stopMovement`, **`switchToLevelForElevation`** reason.

### G. Priority 6 — **`interaction-manager`** keyboard options

Keyboard still passes **`destinationFloor*`** from **`activeLevelContext`** even when the **token’s band** differs. Extend **`_getFoundryConstrainOptions`**-style logic at the **call site**: pass **token’s owning floor band** from **`level-interaction-service` / flags**, or **omit** floor when mismatch (already partially done in movement manager for constrainOptions).

### H. Suggested implementation order (milestones)

| Milestone | Delivers | Risk |
|-----------|----------|------|
| **M1** | Priority **2** (`resyncSpriteToDocument`) + calls from region handler | Low — localized; should reduce “movement broken until refresh” even if wall bug remains |
| **M2** | Priority **1** (Foundry `ignoreWalls` on checkpoint when MapShine validated) + setting | Medium — needs cross-floor and door regression pass |
| **M3** | Priority **3** (geometry gates) + content tidying | Low–medium |
| **M4** | Priority **4** (zones) + Priority **5** (logs) | Low |
| **M5** | Priority **6** (keyboard floors) | Low |

### I. Definition of done (technical)

- Stair approach at **document** and **Three.js** positions match within **&lt; ½ grid** after transition.  
- **`activeTracks`** empty for that token after stair choreography completes.  
- Next **`executeDoorAwareTokenMove`** / drag does **not** require page reload.  
- No **false** wall blocks from **lower** floors when MapShine path is unobstructed at token elevation.  
- Logs can prove **in one capture** whether failure was Foundry truncation vs region gate vs track orphan.

## Proposed investigation phases

### Phase A — Instrumentation (short-lived)

- Log **once** per stair attempt: token id, region event name, `movement.passed` / `movement.pending` waypoint counts (no core “index” field), region id, current `x,y,elevation`, timestamp.
- Log when **`switchToLevelForElevation`** / **`mapShineLevelContextChanged`** fire relative to first/last step of the path.

### Phase B — Event timing

- Confirm **when** the region handler runs relative to:
  - Path **commit**
  - Each **checkpoint**
  - **Final** position at stair tile  
- **Note:** core region **`ExecuteScript`** events for movement fire **after** each committed update (`_onUpdateOperation`), not at ruler preview. “Too early” behavior is more likely **`TOKEN_MOVE_WITHIN`** + **large regions**, or **Map Shine floor follow** (§6), than core firing at path planning.
- If a **compat** or **module** handler still runs at the wrong **logical** time, gate it: e.g. only when `token` center is inside the **stair footprint** **and** last committed position matches the stair cell (or distance &lt; threshold).

### Phase C — Level switch decoupling

- Ensure **floor follow** (`_followSelectedTokenFloorTransition`, zone manager, `switchToLevelForElevation`) is driven by **post-arrival** elevation or **explicit** “token entered stair” flag, not **movement options** `destinationFloor*` for the whole path.

### Phase D — Regression tests (manual)

- Drag onto stair up/down; pathfind onto stair; **multi-segment** path through stair; cancel mid-path; second path after stair.

## Files touched historically (for grepping)

- `scripts/foundry/region-levels-compat.js` — region stair / elevator; `_applyRegionMovement`; legacy drawing stairs.
- `scripts/scene/token-movement-manager.js` — checkpoint move, `_resolveMovementPayloadElevation`, portal / floor follow, sequenced steps.
- `scripts/scene/level-interaction-service.js` — `switchToLevelForElevation`.
- `scripts/foundry/camera-follower.js` — `_syncToControlledTokenLevel`, `updateToken` / `controlToken` hooks, `mapShineLevelContextChanged`.
- `scripts/foundry/zone-manager.js` — `_handleStairZone`, `_followControlledTokenFloorTransition`.
- `scripts/scene/interaction-manager.js` — door-aware move options (`destinationFloor*` from `activeLevelContext`).
- `scripts/compositor-v2/effects/FogOfWarEffectV2.js` — perception / token hooks (cadence).
- `scripts/scene/token-manager.js` — `updateTokenSprite`, elevation → floor assignment.

**Local reference trees (gitignored / optional):**

- `foundryvttsourcecode/resources/app/client/documents/token.mjs` — region event dispatch, `#splitMovementPath`, `#handleMoveRegionEvent`.
- `othermodules/levels/scripts/handlers/regionHandler.js` — Levels `RegionHandler` / `updateMovement`.

## Open questions — resolved

1. ~~**Waypoint index / progress**~~ **Answered:** No dedicated field. Use **`movement.passed` / `movement.pending`**, **`origin` / `destination`**, **`state`**, **`checkpoint`**. Event keys: **`CONST.REGION_EVENTS`** (e.g. `tokenMoveWithin`).

2. ~~**Early scene / floor change — Map Shine vs Levels vs core**~~ **Answered:** **Map Shine**, not Levels runtime or Foundry “preview.” Primary mechanism: **`CameraFollower`** **`updateToken`** hook (**§8**) — when policy allows (**non-GM** with controlled token, or **follow-controlled-token** lock), an **`elevation`** write immediately drives **`_syncToControlledTokenLevel`** and **`mapShineLevelContextChanged`**. **GMs** in **manual** lock skip that hook but may still trigger **`switchToLevelForElevation`** from **`_followSelectedTokenFloorTransition`**, **`zone-manager`**, or follow mode’s per-frame sync. Secondary: oversized regions / early **compat** elevation before the stair **cell**. **Interaction-manager** `destinationFloor*` = **active viewed band**; same-floor drags often **no-op** `_followSelectedTokenFloorTransition` via **`sameBand`**.

3. ~~**When to apply stair elevation**~~ **Answered:** **Yes — gate on arrival**, not on “any” move-in event. Concretely: (a) **Content:** shrink region to stair footprint or use **`TOKEN_MOVE_IN`** at boundary vs **`TOKEN_MOVE_WITHIN`** in a huge area; (b) **Code:** require **token center** (or last **`passed`** waypoint) inside a **tight** stair shape **and** optional **“pending waypoints empty or last step”** before applying elevation; (c) **choreography:** **pause** then **`update({ elevation })`** so **`CameraFollower`** does not pull the floor up **during** the last horizontal perception frame — pair with **follow suppression** (§ “Are we in a good position”) for full control.

## Revision log

| Date | Note |
|------|------|
| 2026-03-25 | Initial doc: problem statement, FOW/waypoint correlation, findings on nested `move`, elevation epsilon, next investigation phases. |
| 2026-03-25 | Added Foundry core (`token.mjs`) region/movement semantics, Map Shine floor-follow / group `options` hypothesis, Levels `RegionHandler` vs compat divergence, updated open questions and suspects table. |
| 2026-03-25 | Resolved open questions; documented `CameraFollower`/`updateToken`/`elevation` as primary floor-jump driver; target UX (arrive → pause → transition); implementation levers; interaction-manager `destinationFloor` nuance. |
| 2026-03-25 | **Post-fix user validation:** no improvement; added **Latest validation**, **Fix attempts implemented** table, **Systems not yet targeted** (Foundry wall height vs MapShine, sprite/doc heal, zones, legacy stairs, etc.); refreshed §1 region compat narrative (Attempt A/B). |
| 2026-03-25 | **Next steps — detailed plan:** research-backed priorities (Foundry vs MapShine wall mismatch, `activeTracks` / `_cancelTrack` no-snap vs `stopMovement`, checkpoint `ignoreWalls` when MapShine-validated, `resyncSpriteToDocument`, region gates, zones, instrumentation, keyboard floors); milestones M1–M5. |
