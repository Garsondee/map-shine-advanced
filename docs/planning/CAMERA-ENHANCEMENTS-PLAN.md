# Camera Enhancements Plan (Map Shine Advanced)

## Status
- Phase: Planning (Final Scope Locked)
- Priority: High (live-play UX + cinematic presentation)
- Scope: Optional camera enhancements, including a dedicated cinematic mode

---

## 1) Goal
Create a new optional camera feature set, launched from a new left-palette scene control button:

**`Map Shine Advanced Camera`**

This feature set should make camera behavior:
- smoother
- more cinematic
- still responsive and playable
- safe to opt in/out of during active sessions

Primary headline feature:
- **Cinematic Mode** with animated letterbox bars, GM-driven shared camera, and player UI fade-out with an always-available top-right toggle to exit/rejoin cinematic view.

---

## 2) Product Requirements (from request)

1. Add a new scene control button in the left palette:
   - Label: `Map Shine Advanced Camera`
   - Opens camera controls (panel/dialog) for optional enhancements.

2. Add a Cinematic Mode that, when enabled by GM:
   - animates black bars in from top and bottom (letterbox)
   - locks player camera to GM camera view
   - fades out player UI (map-first immersion)
   - leaves a single top-right button to exit cinematic view
   - after exit, that same top-right control remains available so users can re-enter cinematic view

3. Preserve responsiveness:
   - camera should feel smooth, but never sluggish or delayed

4. Keep this optional and safe:
   - default behavior remains current baseline unless explicitly enabled

---

## 3) Current Architecture Baseline (Repo Research)

### 3.1 Scene controls are already injected in `module.js`
Current left-palette tools are registered via `Hooks.on('getSceneControlButtons', ...)` in:
- `scripts/module.js`

Existing tools include:
- `map-shine-config`
- `map-shine-control`
- `map-shine-graphics-settings`

This is the correct insertion point for a new `map-shine-camera` tool.

### 3.2 Current camera stack
Current runtime camera flow is:
1. `PixiInputBridge` handles pan/zoom input on Three canvas
2. PIXI stage (`canvas.stage.pivot/scale`) is source of truth
3. `CameraFollower` mirrors PIXI camera state into Three camera each frame

Files:
- `scripts/foundry/pixi-input-bridge.js`
- `scripts/foundry/camera-follower.js`
- initialization in `scripts/foundry/canvas-replacement.js`

### 3.3 Coordinate and zoom model
- Foundry coordinates: top-left origin, Y-down
- Three camera conversion uses `threeY = worldHeight - foundryY`
- Zoom is FOV-based for perspective camera (`sceneComposer.currentZoom`)

### 3.4 UI layering and mode controls
- `ModeManager` already manages global UI/canvas layering and input routing concerns
- this is the best place to integrate cinematic UI-hide/show policy safely

---

## 4) Three.js Camera Research Summary (Planning-Relevant)

This section captures practical camera techniques relevant to Map Shine’s top-down perspective setup.

### 4.1 Projection + zoom strategy
- Perspective camera with FOV-based zoom is valid for top-down map rendering and preserves depth/parallax.
- Keep near/far planes stable when possible to avoid precision churn.
- Use one canonical zoom value (`currentZoom`) and derive FOV deterministically.

### 4.2 Smooth motion models
Useful models for optional smoothing:
1. **Exponential damping**
   - simple and stable
   - good default for optional smoothing
2. **Critically damped spring**
   - more “cinematic” feel
   - requires careful tuning to avoid overshoot sickness
3. **Hybrid model**
   - instant response during active input
   - smoothing only on release/settle

### 4.3 Camera blending techniques
- Position blend: `lerp` on camera pivot target
- Orientation blend (if ever used): quaternion `slerp`
- Zoom blend: interpolate logical zoom value, then recalc FOV

### 4.4 Constraint systems
For tactical maps, camera should support:
- scene-bound clamping (never drift into padded dead space unless intentionally allowed)
- optional soft edge resistance near bounds
- min/max zoom envelope

### 4.5 Cinematic language elements
High-value camera language for VTT:
- letterbox transitions
- guided focus moves (snap-to token/group with easing)
- subtle impact impulses (optional micro shake/zoom pulse)
- shot presets/bookmarks

### 4.6 Performance guidance
- all smoothing must be time-delta driven and allocation-free in hot paths
- avoid per-frame DOM churn; animate one persistent overlay element
- throttle network sync payloads (for GM lock mode)

### 4.7 Fog-of-war bounds research (player camera constraints)

#### What Foundry gives us today
1. `canvas.fog.isPointExplored({x, y})` gives point-level explored checks from extracted fog pixels.
2. `canvas.visibility.refreshVisibility()` builds current visibility and commits to fog when vision changes.
3. `canvas.masks.vision.renderTexture` is the current LOS/light visibility mask texture.
4. `canvas.fog.sprite.texture` is the persistent explored texture.
5. Canvas panning and zoom are constrained by `canvas._constrainView({x,y,scale})`.

#### Key implications
1. We can compute a **player-only camera bounds rectangle** from:
   - currently visible region
   - explored region
   - optional padding
2. We should avoid hard dependencies on Foundry private fields where possible.
3. Texture readback is accurate but potentially expensive; event-driven/coarse updates are safer.

#### Existing Map Shine alignment
1. Map Shine already uses scene/canvas rect distinctions correctly (`sceneRect` vs full dimensions).
2. Current camera authority is PIXI stage pivot/scale; this is the right place to apply bounds.
3. Player-only logic should sit in camera/input bridge layer, not render-layer effects.

---

## 5) Proposed Feature Set

## 5.1 New panel entry point
Add a new left-palette tool:
- `name`: `map-shine-camera`
- `title`: `Map Shine Advanced Camera`
- `icon`: camera/video icon
- `button: true`
- GM-visible initially (player visibility optional later)

Click action:
- open/toggle **Camera Panel** (new manager)

### 5.2 Camera Panel sections (initial)
1. **Camera Mode**
   - Default / Cinematic
2. **Motion Feel**
   - smooth pan
   - smooth zoom
   - response profile (snappy, balanced, cinematic)
3. **Cinematic Session**
   - Start Cinematic (GM)
   - End Cinematic (GM)
   - Lock players to GM camera toggle
   - UI fade strength
   - bar size/animation speed
4. **Utility**
   - reset camera enhancements
   - emergency unlock all players

---

## 6) Cinematic Mode Spec (Core Requirement)

### 6.1 Activation behavior (GM)
When GM enables Cinematic Mode:
1. Animate top/bottom black bars sliding in.
2. Start GM camera broadcast lock session.
3. Player clients enter cinematic-follow state.
4. Player UI fades out (except cinematic toggle button).

### 6.2 Player experience during lock
- Camera follows GM camera position + zoom.
- Manual pan/zoom input is ignored while in cinematic-follow state.
- UI is hidden/faded to map-first presentation.
- A top-right button remains available:
  - `Exit Cinematic View`

### 6.3 Player opt-out and rejoin
When player clicks exit:
- local camera lock disengages for that player only
- local UI is restored
- persistent top-right button remains, now labeled e.g.:
  - `Rejoin Cinematic View`

This preserves player agency while allowing GM-directed cinematic presentation.

### 6.4 Deactivation behavior (GM)
When GM ends cinematic session:
- stop camera broadcast lock
- bars animate out
- restore UI defaults for all still-locked players
- clear forced follow state cleanly

---

## 7) Technical Architecture Proposal

### 7.1 New runtime manager
Create:
- `scripts/foundry/cinematic-camera-manager.js`

Responsibilities:
- own cinematic session state machine
- animate and manage letterbox overlay
- manage player lock/follow state
- coordinate UI fade policy
- expose API for Camera Panel and scene controls

### 7.2 State model
Scene-level (authoritative, GM-controlled):
- `flags.map-shine-advanced.camera.cinematic.active`
- `flags.map-shine-advanced.camera.cinematic.lockPlayers`
- `flags.map-shine-advanced.camera.cinematic.style` (barHeight, transitionMs, uiFade)

Client-level (player preference/override):
- `game.settings` or local state for:
  - `cinematicOptOut`
  - `cinematicButtonPinned`

### 7.3 Camera sync transport
Use Foundry socket/module channel for live GM camera replication.

Payload (throttled):
- `{x, y, zoom, t, sceneId, seq}`

Policy:
- send at fixed rate (10–20 Hz)
- include deadband thresholds to avoid tiny updates
- client-side interpolation between packets for smoothness

### 7.4 Input lock integration
Integrate with existing input stack:
- disable/ignore pan-zoom in `PixiInputBridge` when local cinematic-follow is active
- keep lock local and reversible per user

### 7.5 UI fade + overlay strategy
DOM overlay approach (recommended):
- one root cinematic overlay container
- two bar elements (top/bottom) animated via CSS transforms
- one persistent top-right control button

UI fade:
- apply class to `#ui` and related HUD layers
- avoid display:none; use opacity + pointer-events policy for safe restoration

### 7.6 Coordinate handling
Preserve existing camera conventions:
- authoritative payload in Foundry camera coordinates (pivot x/y + zoom)
- conversion to Three remains in `CameraFollower`
- do not introduce an alternate coordinate schema

### 7.7 Player-only fog-bounded camera constraint (new)
Goal: limit player pan/zoom-out to the union of:
- currently visible area
- explored area
- configurable padding ring

Constraint should be active only when:
- optional improved camera mode is enabled
- user is non-GM (or GM simulation toggle is enabled for testing)

#### Constraint math (camera center + zoom)
Given allowed world bounds `(minX, minY, maxX, maxY)` and viewport size:
1. `viewW = window.innerWidth / scale`
2. `viewH = window.innerHeight / scale`
3. clamp center:
   - `x in [minX + viewW/2, maxX - viewW/2]`
   - `y in [minY + viewH/2, maxY - viewH/2]`
4. clamp minimum scale (prevents over-zooming out past bounds):
   - `scale >= max(window.innerWidth / boundsW, window.innerHeight / boundsH, sceneMinScale)`

### 7.8 Bounds acquisition strategy options

#### Option A (Recommended first): API/grid-sampled bounds (low risk)
Method:
1. Build a coarse sampling grid over `canvas.dimensions.sceneRect`.
2. Mark sample points valid if either:
   - `canvas.fog.isPointExplored(point)` is true, or
   - `canvas.visibility.testVisibility(point)` is true.
3. Compute AABB of valid points; expand by padding.

Pros:
- avoids direct private pixel buffers
- stable across Foundry updates
- straightforward to tune resolution/performance

Cons:
- approximate at coarse sampling resolutions

#### Option B: Texture extraction bounds (high accuracy, medium risk)
Method:
1. Use Foundry texture extraction (`TextureExtractor`) on fog/vision textures.
2. Threshold pixels and compute exact AABB from bitmap.

Pros:
- highest geometric fidelity

Cons:
- GPU readback cost/stalls
- more coupled to low-level texture lifecycle

#### Option C: Incremental bounds growth (fastest, least precise)
Method:
1. Initialize bounds from first visible region.
2. On each visibility refresh, union with new visible bounds.
3. Persist per-user scene bounds.

Pros:
- minimal runtime overhead

Cons:
- drifts toward over-large bounds over long sessions
- weaker "current explored + visible" fidelity

### 7.9 Enforcement integration options

#### E1. Clamp inside `PixiInputBridge` (recommended)
- Clamp right-drag and wheel zoom before writing pivot/scale.

#### E2. Post-pan correction hook
- On `canvasPan`, re-clamp if view moved out of bounds from non-bridge actions.

#### E3. Patch `canvas._constrainView` at runtime (not recommended initially)
- Most complete, but high compatibility risk.

---

## 8) Optional Enhancement Backlog (Beyond Initial Cinematic)

### 8.1 Motion quality
1. Snappy smoothing preset
2. Balanced smoothing preset
3. Cinematic smoothing preset
4. pan/zoom settle curves

### 8.2 Camera direction tools
1. Focus selected token
2. Focus controlled group (fit bounds)
3. Save/load camera bookmarks
4. Smart beat transitions (slow push, fast snap, hold)

### 8.3 Cinematic flavor
1. Optional subtle camera impulse (shake/zoom pulse)
2. Transition easing library (linear, cubic, quintic)
3. Optional vignette or edge treatment (future)

### 8.4 Multiplayer control options
1. GM force-follow (strict)
2. Soft-follow (players can break free by moving camera)
3. Per-player allow/deny cinematic lock

### 8.5 Player visibility-bounded camera (new)
1. Enable player-only fog-bounded pan clamp
2. Enable player-only fog-bounded zoom-out clamp
3. Padding presets (tight / normal / generous)
4. Bounds source mode:
   - sampled API bounds (recommended)
   - texture extraction bounds
   - incremental bounds
5. Recompute cadence:
   - event-driven (token move, perception refresh, fog explored)
   - fixed interval fallback

---

## 9) Implementation Work Packages

### WP-CAM-1: Planning + contracts
- finalize state schema (scene flags + client prefs)
- define socket event contract
- define cinematic UI CSS contract

### WP-CAM-2: Scene control button + panel shell
- add `map-shine-camera` tool in `module.js`
- scaffold `CameraPanelManager` with read-only status section

### WP-CAM-3: Cinematic manager core
- implement `CinematicCameraManager` lifecycle
- add APIs: `startCinematic()`, `endCinematic()`, `setPlayerLock()`

### WP-CAM-4: Letterbox + UI fade
- implement overlay root and bar animation
- implement robust UI hide/show restoration
- implement persistent top-right button

### WP-CAM-5: GM camera lock sync
- implement socket broadcast + receive handlers
- apply throttled interpolation on client
- add sequence/timestamp safety checks

### WP-CAM-6: Input lock and opt-out flow
- integrate with `PixiInputBridge` lock guard
- implement player opt-out/rejoin toggle behavior

### WP-CAM-7: Optional smoothing profiles
- add profile presets and tuning sliders
- ensure “responsive while smooth” feel

### WP-CAM-8: Player fog-bounded camera limits
- implement bounds provider service (Option A first)
- add player-only pan clamp against bounds + padding
- add player-only zoom-out clamp against bounds envelope
- add fallback when no explored/visible area is available
- add settings toggles under optional improved camera mode

### WP-CAM-9: Focus tools + impulse foundation + group cohesion force
- implement focus selected token and focus controlled group actions
- implement camera impulse API (foundation only, disabled by default) for future gameplay-triggered shake events
- implement emergency unlock all players action in camera panel
- implement group cohesion force:
  - soft attraction toward center of player-controlled tokens
  - optional auto-fit behavior to keep group visible
  - always preserve manual override responsiveness

### WP-CAM-10: QA hardening
- multiplayer edge cases
- reconnect/reload behavior
- scene switch cleanup
- emergency unlock paths
- cohesion-force conflict checks (manual pan, cinematic lock, fog bounds)

---

## 10) Acceptance Criteria

### Functional
1. A new `Map Shine Advanced Camera` scene control button exists and opens camera controls.
2. GM can start/stop Cinematic Mode from the camera panel.
3. Letterbox bars animate in/out reliably.
4. While cinematic lock is active, player cameras follow GM camera.
5. Players can exit cinematic view locally.
6. Players can rejoin cinematic view via persistent top-right button.
7. UI restoration is complete and deterministic after exit or session end.
8. When player-bounds mode is enabled, players cannot pan outside explored+visible bounds (+padding).
9. When player-bounds mode is enabled, players cannot zoom out far enough to exceed allowed bounds.
10. GM view remains unconstrained unless explicitly testing player constraints.
11. Focus selected token works with smooth, interruptible motion.
12. Focus controlled group keeps owned/controlled tokens in frame.
13. Emergency unlock immediately clears all player follow locks.
14. Group cohesion force keeps player-controlled group near center while allowing immediate manual override.
15. Camera impulse system exists as a reusable API and can be invoked by future gameplay events.

### Quality
1. Camera lock appears smooth with no visible jitter at normal pan speeds.
2. Local input latency feels immediate outside lock mode.
3. No stuck input states when toggling cinematic rapidly.
4. No camera desync after scene change, reconnect, or sidebar resize.
5. Bounds recomputation does not cause perceptible frame hitches during normal play.
6. Cohesion force does not produce oscillation/jitter when party is spread out.

### Safety
1. GM has an emergency “unlock all players” action.
2. Player opt-out never breaks game controls permanently.
3. Fallback to baseline camera behavior on manager failure.
4. Cohesion force never hard-locks camera controls; user input always wins.

---

## 11) Risk Register

1. **Network jitter causes choppy follow**
   - Mitigation: interpolation buffer + deadband + fixed broadcast cadence.

2. **UI fade may hide critical controls unintentionally**
   - Mitigation: explicit allowlist for persistent cinematic button and emergency restore routine.

3. **Conflicts with existing mode switching (Gameplay/Map Maker)**
   - Mitigation: integrate mode guards in `ModeManager`; cinematic unavailable in Map Maker mode.

4. **Camera authority conflicts (PIXI vs Three)**
   - Mitigation: keep PIXI stage as canonical camera authority during sync sessions.

5. **Bounds algorithm too strict (players feel trapped)**
   - Mitigation: configurable padding presets + optional soft-edge resistance.

6. **Bounds algorithm too loose (fails product goal)**
   - Mitigation: expose stricter thresholds and optional texture-accurate mode.

7. **Texture extraction mode causes hitches on large scenes**
   - Mitigation: keep Option A as default, throttle Option B updates heavily.

8. **Group cohesion force can fight player intent**
   - Mitigation: treat as soft force with low gain, active-input suppression, and fast settle cancellation.

9. **Future camera shake integration can create motion sickness if misused**
   - Mitigation: ship only an impulse API foundation first; keep amplitudes gated and disabled by default.

---

## 12) Final Scope Decisions (Locked)

The following features are confirmed for implementation in optional improved camera mode:

1. **Camera feel + cinematic core**: options 1, 2, 3, 4, 5, 6, 7.
2. **Player fog-bounded constraints**: options 8, 9, 10, 11.
3. **Camera direction tools**: options 12 and 13.
4. **Cinematic impulse foundation**: option 16, scoped as an extensible API for future gameplay-triggered camera shake.
5. **Safety control**: option 19 (emergency unlock all players).
6. **Option 21 redefined and selected**: group cohesion force that keeps camera near player-controlled token center and keeps group visible.

Deferred for later unless requested:
- option 14 (bookmarks)
- option 15 (scene beat transitions)
- option 17 (easing library expansion)
- option 18 (vignette)
- option 20 (boundary hint UI)
- previous option 21 meaning (auto-reset baseline) moved to fallback safety policy outside picklist

---

## 13) Final Rollout Plan (Phased)

### Phase A - Foundation + cinematic core
1. Add scene control button + camera panel shell
2. Implement cinematic overlay (bars + UI fade)
3. Implement GM->player lock, opt-out/rejoin, strict force-follow toggle

### Phase B - Camera quality + player visibility constraints
4. Add smoothing presets and response profiles
5. Implement player fog-bounded pan/zoom constraints (Option A default)
6. Add bounds padding presets and algorithm selector

### Phase C - Tactical direction + extensibility + safety
7. Implement focus selected token and focus controlled group actions
8. Implement group cohesion force (soft center/fit behavior)
9. Implement camera impulse API foundation for future hit-reaction shake events
10. Add emergency unlock tooling and hardening pass

---

## 14) Reference Files (Current System)

- Scene controls registration:
  - `scripts/module.js`
- Camera sync/runtime:
  - `scripts/foundry/camera-follower.js`
  - `scripts/foundry/pixi-input-bridge.js`
  - `scripts/foundry/canvas-replacement.js`
- Mode/UI lifecycle:
  - `scripts/foundry/mode-manager.js`
- Fog and visibility in Map Shine:
  - `scripts/effects/WorldSpaceFogEffect.js`
  - `scripts/vision/FoundryFogBridge.js`
- Foundry internals (reference source):
  - `foundryvttsourcecode/resources/app/client/canvas/perception/fog.mjs`
  - `foundryvttsourcecode/resources/app/client/canvas/groups/visibility.mjs`
  - `foundryvttsourcecode/resources/app/client/canvas/board.mjs`
- Existing planning style reference:
  - `docs/planning/TWEAKPANE-INTERFACE-REVAMP-PLAN.md`

---

## 15) Optional Improved Camera Mode - Feature Picklist

Everything in this section is **off by default** and only activates when optional improved camera mode is enabled.

### A. Core camera feel
1. Smooth pan interpolation
2. Smooth zoom interpolation
3. Motion profile presets (snappy/balanced/cinematic)

### B. Cinematic mode
4. Letterbox bars (animated)
5. GM camera lock to players
6. Player UI fade with persistent top-right exit/rejoin toggle
7. GM strict force-follow mode (optional)

### C. Player-only map-awareness constraints
8. Player pan bounds = explored + visible + padding
9. Player zoom-out bounds tied to allowed bounds envelope
10. Bounds padding presets
11. Bounds algorithm mode selector (API-sampled / texture-accurate / incremental)

### D. Camera direction tools
12. Focus selected token
13. Focus controlled group
14. Camera bookmarks (save/load)
15. Scene beat transitions

### E. Cinematic polish
16. Optional micro shake/impact pulse
17. Transition easing library
18. Optional vignette/edge treatment

### F. Safety and UX helpers
19. Emergency unlock all players
20. Player boundary feedback hint when reaching limits
21. Group cohesion force (softly keep camera near player-controlled token center and keep group visible)
22. Auto-reset to baseline camera mode on manager failure

### Selected in final planning lock
- Selected: 1,2,3,4,5,6,7,8,9,10,11,12,13,16,19,21
- Deferred: 14,15,17,18,20
- Safety baseline (non-optional fallback): 22
