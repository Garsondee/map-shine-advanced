# Tweakpane Interface Revamp Plan (Map Shine Advanced)

## Status
- Phase: Implementation Complete (WP-1 through WP-5 done; WP-6 QA pending)
- This document now covers:
  1. Session 1: Basics + full UI overview
  2. Session 2: Important UX improvements
  3. Session 3: Optional/nice-to-have enhancements
- Implementation status:
  - WP-1: ✅ Shared UI Shell Standards (all panels normalized)
  - WP-2: ✅ Main Config Re-Arrangement
  - WP-3: ✅ Control Panel Live-Play Upgrade
  - WP-4: ✅ Space Optimization Pass
  - WP-5: ✅ Trust and Feedback Pass
  - WP-6: ⏳ QA + Regression Verification

---

## 1) Goal
Create a cohesive, scalable, and easier-to-use Tweakpane ecosystem across Map Shine Advanced.

This revamp is not a single panel tweak. It is a full interface-system upgrade covering:
- Information architecture
- Cross-panel consistency
- Control discoverability
- Runtime clarity (live-play vs authoring vs diagnostics)

---

## 2) Scope Strategy (3 Major Areas)

### Area A — Foundation & UI Overview (this output)
Define the current interface map, panel roles, baseline structure, and core standards.

### Area B — UX Improvements (next output)
Prioritize interaction quality, speed-of-use, cognitive load reduction, and onboarding clarity.

### Area C — Optional Enhancements (final output)
Advanced quality-of-life and premium features that are valuable but not required for core usability.

---

## 3) Current Interface Landscape (Baseline Inventory)

Map Shine currently uses multiple Tweakpane-based interfaces, each with partially overlapping patterns.

### 3.1 Primary Panels

| Panel | Class | Purpose | Current Structure (high-level) |
|---|---|---|---|
| Main Config Panel | `TweakpaneManager` | Global settings + effect authoring + debug links | Branding, Scene Setup, Global, Environment, Ropes, Debug, effect/category folders |
| GM Live Control Panel | `ControlPanelManager` | In-session control for time/weather/environment/tile motion | Time, Weather, Environment, Tile Motion, Utilities |
| Graphics Settings | `GraphicsSettingsDialog` | Per-client effect enable/disable + resolution presets | Global + Effects |
| Effect Stack | `EffectStackUI` | Runtime inspection/debug for effects and tiles | Summary, Mask Debug, Effects, Tiles |
| Texture Manager | `TextureManagerUI` | Texture diagnostics/discovery/inspection | Multi-pane texture management |
| Tile Motion Manager Dialog | `TileMotionDialog` | Tile motion authoring controls | Dedicated management panel |
| Light Editor Pane | `light-editor-tweakpane` | Light editing workflow | Dedicated editor pane |
| Diagnostic Center | `DiagnosticCenterDialog` | Diagnostics and troubleshooting | Dedicated diagnostic pane |

### 3.2 Immediate Architectural Observation
The product has evolved into a **multi-panel Tweakpane suite**, not a single panel. The revamp should treat this as a platform and standardize shared behavior across all panes.

---

## 4) Core Problems to Solve (Overview Level)

1. **Fragmented mental model**
   - Users must learn several panel patterns instead of one consistent language.

2. **Inconsistent hierarchy and naming**
   - Similar controls are grouped and titled differently across panels.

3. **Intent mixing**
   - Live-play actions, authoring controls, and diagnostics are not always clearly separated.

4. **Variable interaction quality**
   - Some panes have strong custom affordances; others rely on default Tweakpane behavior.

5. **Scalability pressure**
   - As more effects and systems are added, discoverability and navigation burden will increase.

---

## 5) Design Direction (Foundation)

### 5.1 Product-level IA (single shared language)
Every control belongs to one primary intent:
- **Live Play** (fast, high-impact, low-cognitive controls)
- **Authoring** (detailed scene/effect setup)
- **Inspection** (readability of current runtime state)
- **Diagnostics** (debug/repair/profiling)

### 5.2 Standardized Panel Role Definitions
- **Main Config** = Authoring-first control center
- **Control Panel** = Live-play runtime command surface
- **Graphics Settings** = Per-client performance/visibility overrides
- **Effect Stack / Texture / Diagnostic** = Inspection + diagnostics only

### 5.3 Progressive Disclosure by Default
- Keep critical controls visible
- Collapse advanced groups by default
- Preserve open/closed states persistently

### 5.4 Consistency Rules (to be enforced in implementation)
- Shared section naming conventions
- Shared status vocabulary (Enabled/Disabled/Unavailable/Runtime-only)
- Shared button semantics (`Apply`, `Start`, `Reset`, `Copy`, `Refresh`)
- Shared warning style for Map Shine-dependent features

---

## 6) Foundation Deliverables (Area A)

### A1. Interface Map + Ownership Matrix
Document each pane’s exact ownership and responsibility boundaries.

### A2. Taxonomy & Naming Contract
Define canonical section names and when each category is used.

### A3. Shared Pane Shell Standard
Baseline for:
- Drag behavior
- z-index layering
- event capture behavior
- show/hide lifecycle
- state persistence behavior

### A4. Baseline Information Architecture Draft
Create first-pass top-level section order for all major panels.

### A5. Control Type Guidelines (Overview Level)
Define when to use:
- Slider vs dropdown vs button set
- Inline status text vs folder-level status
- Toggle + dependent groups

---

## 7) Proposed Top-Level IA (v1 Draft)

### 7.1 Main Config Panel (Authoring)
1. Scene Setup
2. Environment
3. Effects (grouped by category)
4. Materials / Surfaces
5. Particles / Weather Authoring
6. Ropes / Specialized Systems
7. Debug & Validation
8. Support / Links

### 7.2 Control Panel (Live Play)
1. Time
2. Weather
3. Environment (live-relevant subset)
4. Tile Motion (runtime transport controls)
5. Utilities

### 7.3 Graphics Settings (Per-Client)
1. Global Overrides
2. Effect Overrides
3. Quick Presets

### 7.4 Diagnostics Suite
- Effect Stack
- Texture Manager
- Diagnostic Center

(Each remains separate, but follows one shared visual/interaction language.)

---

## 8) Success Criteria for Area A

This overview phase is complete when:
- A shared panel-role model is agreed
- Core IA labels are stable
- Separation between Live Play / Authoring / Diagnostics is explicit
- A baseline implementation checklist exists for Session 2 work

---

## 9) Session Hand-off Notes

### What comes next (Session 2)
Deep UX improvements:
- Navigation speed and search/filter strategy
- Reducing slider overload
- Better status communication
- Better defaults, grouping, and affordances
- Error prevention and safety rails

### What follows (Session 3)
Optional enhancements:
- Presets/templates systems
- Cross-panel quick actions
- Advanced onboarding overlays
- Accessibility/power-user extensions

---

## 10) References (Current Implementation)
- Main panel composition and section bootstrapping: `scripts/ui/tweakpane-manager.js`
- Live control panel section bootstrapping: `scripts/ui/control-panel-manager.js`
- Graphics settings panel structure: `scripts/ui/graphics-settings-dialog.js`
- Runtime effect inspection panel structure: `scripts/ui/effect-stack.js`
- Texture diagnostics panel shell: `scripts/ui/texture-manager.js`

---

## 11) Session 2 — Important UX Improvements (High Priority)

This section translates the overview into concrete UX priorities and implementation direction.

### 11.1 Findings from Current UI Behavior

1. **Navigation is panel-local, not system-level**
   - Users can search/filter inside some panels (for example, Effect Stack), but there is no shared wayfinding model across all panes.

2. **Cross-panel consistency is uneven**
   - Section naming, status signaling, and control grouping vary by panel, which increases context-switch cost.

3. **Live controls and authoring controls still feel related but separate**
   - Role separation exists conceptually, but users do not get a clear "you are in runtime control" vs "you are in authoring" mental boundary.

4. **Control semantics differ between similar interactions**
   - Some controls apply continuously, others apply on release, others apply via explicit action buttons.
   - This is functional, but predictability can be improved.

5. **Status feedback is present but fragmented**
   - Status dots, inline summaries, and custom text outputs exist, but there is no universal status language shared across all panes.

6. **Scalability risk is now UX, not rendering**
   - As effect count and feature depth increase, discoverability and decision speed become the primary bottleneck.

### 11.2 UX Objectives for Session 2

- Reduce time-to-first-correct-adjustment during live play.
- Reduce misconfiguration risk during authoring.
- Make panel transitions feel coherent and intentional.
- Standardize feedback so users trust what changed, where, and when.
- Preserve power-user depth while improving first-pass usability.

### 11.3 UX Workstream A — Navigation & Wayfinding

#### A1. Shared navigation model across all panes
- Define one canonical hierarchy language:
  - **Primary sections** (always visible)
  - **Advanced groups** (collapsed by default)
  - **Diagnostics groups** (collapsed by default)

#### A2. Introduce unified search strategy
- Minimum baseline:
  - Search in Main Config effects (parity with Effect Stack search utility)
  - Search by effect name, effect id, and parameter label aliases

#### A3. Add "recently touched" and "favorites"
- Improve repeat workflows by exposing recently edited controls and pinned favorites.

### 11.4 UX Workstream B — Layout, Grouping, and Information Density

#### B1. Standard section skeleton
Every major folder should follow a stable sequence when applicable:
1. Status/summary
2. Primary runtime controls
3. Advanced tuning
4. Diagnostics
5. Reset/export utilities

#### B2. Reduce slider wall density
- Prefer grouped micro-panels and subfolders over long flat slider lists.
- Keep no more than ~5-7 primary controls visible before nesting advanced sets.

#### B3. Label clarity pass
- Normalize naming to user-facing language and avoid duplicate meanings across panels.
- Keep terms consistent across Main Config, Control Panel, and Graphics Settings.

### 11.5 UX Workstream C — Control Semantics & Interaction Predictability

#### C1. Standard commit model
- Define and enforce 3 control semantics:
  1. **Live preview** (continuous)
  2. **Commit-on-release** (`ev.last` style)
  3. **Explicit apply** (button-triggered)
- Each parameter class should have one default behavior.

#### C2. Paired controls for precision
- Any critical slider should support precise numeric entry or stepped adjustment.

#### C3. Reset behavior standardization
- Normalize "Reset" scopes:
  - Parameter reset
  - Folder reset
  - Effect reset
  - Panel reset

### 11.6 UX Workstream D — Status, Feedback, and Trust

#### D1. Universal status vocabulary
- Use shared states everywhere:
  - `Active`
  - `Disabled`
  - `Unavailable`
  - `Overridden`
  - `Runtime-only`

#### D2. Dependency visibility
- If a control is disabled due to prerequisite state, show why inline (not only by disabling input).

#### D3. Action feedback policy
- Any action with scene/client persistence should provide visible confirmation and scope:
  - Saved to scene
  - Saved client-local
  - Runtime-only change

### 11.7 UX Workstream E — Responsiveness & Performance Perception

#### E1. Event-driven over polling where possible
- Reduce recurring UI polling loops where event subscriptions can provide equivalent updates.

#### E2. Lazy construction for heavy groups
- Build expensive content when folder is opened first time, not on pane bootstrap.

#### E3. Visible-state refresh policy
- Keep existing good pattern: heavy refresh only when panel is visible.
- Extend to other panes where currently missing.

### 11.8 UX Workstream F — Accessibility & Ergonomics

#### F1. Input ergonomics baseline
- Improve keyboard navigation order for frequent controls.
- Ensure clear focus styling for interactive elements.

#### F2. Readability baseline
- Ensure compact-but-legible spacing and high-contrast status indicators.

#### F3. Motor-control safety
- Avoid destructive adjacent actions without spacing/visual distinction.

### 11.9 Prioritized Implementation Plan (Session 2 Outcomes)

#### P0 — Immediate UX wins (first pass)
1. Add shared status vocabulary and visual chips to Main Config, Control Panel, Graphics Settings.
2. Introduce search/filter in Main Config effect area.
3. Normalize section ordering for top-level folders in each primary panel.
4. Document and enforce commit semantics per control type.

#### P1 — Structural UX improvements
1. Add favorites + recent-controls model.
2. Add dependency reason messaging for disabled controls.
3. Refactor dense folders using standard skeleton (summary → primary → advanced → diagnostics).

#### P2 — Hardening and consistency
1. Cross-panel reset behavior consistency pass.
2. Accessibility pass (focus, keyboard flow, spacing).
3. Audit persistent-state messaging for scene/client/runtime scope clarity.

### 11.10 UX Acceptance Criteria (Session 2)

- Users can locate major controls in < 10 seconds without prior panel-specific knowledge.
- Similar controls across panes use consistent labels and behavior patterns.
- Disabled controls communicate why they are disabled.
- Common live-play actions require fewer clicks/scroll than current baseline.
- No regression in UI responsiveness during scene load and first-open interactions.

### 11.11 Risks and Mitigations

1. **Risk:** Over-standardization harms specialized workflows.
   - **Mitigation:** Keep shared shell + semantics, allow specialized inner controls.

2. **Risk:** UX changes break existing user muscle memory.
   - **Mitigation:** Preserve naming where possible; stage major shifts behind clear release notes.

3. **Risk:** More UI logic increases maintenance burden.
   - **Mitigation:** Centralize shared behaviors (status chips, section templates, commit policy) in reusable helpers.

### 11.12 Handoff to Session 3 (Optional Enhancements)

Session 3 should focus on optional but high-value layers on top of this foundation:
- Presets/templates and quick scene profiles
- Advanced onboarding/help overlays
- Power-user tools (macro hooks, batch ops, custom control decks)
- Cross-panel quick actions and workflow shortcuts

---

## 12) Session 2 Addendum — Research-Driven Re-Arrangement Plan

This addendum goes deeper on spatial layout, section ownership, and accordion strategy based on current implementation details.

### 12.1 Research Notes (Current Reality)

1. **Main Config panel has a dense "Global Controls" section**
   - It currently combines mode toggles, UI scale, light-authoring visibility toggles, token rendering controls (color correction + dynamic exposure), and multiple tool-launch buttons.
   - This creates high control density in a single early section.

2. **Top-level panel order is partially role-mixed**
   - Main panel bootstraps Branding, Scene Setup, Global, Environment, Ropes, Debug, then effect categories.
   - This means support links and setup controls can visually precede deeper working controls.

3. **Effect category system already exists and is strong**
   - Categories (`surface`, `atmospheric`, `particle`, `water`, `global`, etc.) are already used when registering effects.
   - This is a good foundation for a stronger IA without changing effect-level schemas.

4. **Control Panel is functionally rich but vertically heavy**
   - It includes a custom status card, custom clock block, weather mode + mode-specific controls + wind controls, environment, tile motion, and utilities.
   - Time and Weather start expanded, which can push key live controls below fold on smaller screens.

5. **Control Panel currently uses hidden/show control toggling for mode swaps**
   - Dynamic vs Directed controls are hidden in-place rather than organized into explicit mode sub-accordions.
   - This works but weakens discoverability and spatial predictability.

6. **Live-play and authoring boundaries are present but still improvable**
   - Main Config still contains some runtime-adjacent controls and tool launchers.
   - Control Panel includes some controls that are not always "first-minute live-play critical."

### 12.2 Re-Arrangement Principles (Space-First)

#### Principle A — One-screen-first design
- Prioritize "critical now" actions in the first viewport.
- Anything not commonly used in active play should require one deliberate expansion.

#### Principle B — Role-pure top-level sections
- Main Config: authoring and system setup.
- Control Panel: runtime scene direction.
- Diagnostic panels: inspection/debug only.

#### Principle C — Accordion depth discipline
- Keep top-level folders shallow.
- Use nested folders only when there are >5 related controls or different intent modes.

#### Principle D — Consistent section skeleton
- Summary → Primary controls → Advanced controls → Dangerous/reset actions.

### 12.3 Main Config Panel Re-Arrangement (Authoring)

#### 12.3.1 Proposed top-level order
1. Scene Setup
2. Authoring Workflow (new, replaces overloaded Global behavior)
3. Environment
4. Surface & Material
5. Atmosphere & Weather Authoring
6. Particles & VFX
7. Water
8. Tokens & Character Rendering
9. Diagnostics & Developer Tools
10. Utilities (panel launchers)
11. Support & Links

#### 12.3.2 Move/merge recommendations

1. **Extract tool launch buttons from Global Controls**
   - Move Texture Manager / Effect Stack / Diagnostic Center / Map Points / Tile Motion Manager launchers into a dedicated **Utilities** section.
   - Rationale: frees high-value parameter space and clarifies intent.

2. **Split token controls into dedicated top-level section**
   - Move token color correction + dynamic exposure from Global into **Tokens & Character Rendering**.
   - Rationale: these are not global scene authoring in the same sense as map-maker mode and time rate.

3. **Keep Global minimal and rename**
   - Suggested rename: **Authoring Workflow**.
   - Include only: Map Maker Mode, Time Rate, UI Scale, light authoring visibility toggles.

4. **Move Support & Links to bottom and default collapsed**
   - Keep it accessible but non-competing for vertical space.

#### 12.3.3 Accordion defaults for Main Config

- Expanded by default: Scene Setup, Authoring Workflow, first category with active effect.
- Collapsed by default: Diagnostics/Developer Tools, Support & Links, deep debug subfolders.
- Rule: only one top-level category auto-expands at startup after Scene Setup.

### 12.4 Main Config Space Optimization Tactics

1. **Control compression budget**
   - Hard rule: no section should expose more than 7 primary controls before first nested group.

2. **Use 2-column button grids for utility actions**
   - Tool launch buttons consume disproportionate vertical space in single-column flow.

3. **Inline summary chips on section headers**
   - Example chips: `3 Active`, `1 Overridden`, `2 Warnings`.
   - Reduces need to open sections only to inspect status.

4. **Accordion "single-open" mode (optional per panel)**
   - For high-density categories, opening one closes siblings at same depth.
   - Keeps navigation vertical span bounded.

5. **Use separators less; use semantic subfolders more**
   - Prevents long unstructured slider runs.

### 12.5 Map Shine Control Panel (Live-Play) — Enhancement Blueprint

This panel should optimize GM speed during active play, not authoring depth.

#### 12.5.1 Proposed Control Panel section order
1. **Live Snapshot** (status card + now/target + transition progress)
2. **Quick Scene Beats** (button deck for most common actions)
3. **Time Director** (clock + transition control + presets)
4. **Weather Director** (mode switch + mode-specific controls)
5. **Wind** (quick + advanced fold)
6. **Tile Motion Transport**
7. **Utilities (Advanced)**

#### 12.5.2 Quick Scene Beats (new high-value section)

Add a compact action deck for rapid scene changes:
- Time beats: Dawn / Noon / Dusk / Midnight
- Weather beats: Clear / Rain / Storm / Snow
- Wind beats: Calm / Breezy / Strong
- Optional one-click macros: "Storm Incoming (5m)", "Clear Skies (2m)"

Design note: these should be above deep controls and visible without scrolling.

#### 12.5.3 Weather Director re-structure

Current approach uses hidden controls in a shared folder. Proposed:
- Top-level mode toggle stays visible.
- Two explicit sub-accordions:
  - **Dynamic Mode** (preset, speed, pause)
  - **Directed Mode** (preset, transition, start)
- Only active mode expands automatically.

Benefits:
- Better spatial memory
- Clearer onboarding for GMs switching modes
- Less control flicker/jump when mode changes

#### 12.5.4 Wind section split

- **Quick Wind** (speed, direction, gustiness presets)
- **Advanced Wind** (if expanded later for expert tuning)

The wind arrow indicator should remain visible in the compact status area to avoid opening deep controls just for heading confirmation.

#### 12.5.5 Utilities should be intentionally de-emphasized

Move potentially disruptive actions (`Reset to Defaults`) into a collapsed **Utilities (Advanced)** section.
Keep `Copy Current Weather` in utilities, but consider duplicating as a small icon action near status.

### 12.6 Control Panel Space Budget Targets

- Target no-scroll state on 1080p for core live controls.
- Keep first viewport dedicated to:
  1. current status
  2. quick beats
  3. immediate time/weather controls
- Tile motion and utilities can remain one fold lower.

### 12.7 Accordion Behavior Matrix (Recommended)

| Panel | Top-level Default | Nested Default | Special Rule |
|---|---|---|---|
| Main Config | Scene Setup + first active category expanded | collapsed | Optional single-open at top level |
| Control Panel | Live Snapshot + Quick Scene Beats + Time Director expanded | collapsed | Auto-expand active weather mode subfolder |
| Graphics Settings | Global expanded, Effects collapsed | collapsed | Expand only effects with overrides |
| Diagnostics | Summary expanded | collapsed | Never auto-expand deep debug folders |

### 12.8 Section Ownership Matrix (Authoring vs Live)

| Capability | Primary Home | Secondary Access |
|---|---|---|
| Scene enablement/publish/mode | Main Config | none |
| Effect micro-tuning | Main Config | none |
| Runtime time/weather direction | Control Panel | limited quick actions only |
| Runtime wind steering | Control Panel | none |
| Tile motion runtime transport | Control Panel | Tile Motion Dialog for deep editing |
| Texture/effect diagnostics | Tool panels | launch links from Main Config |

### 12.9 Phased Execution for Re-Arrangement

#### Phase R1 — Low-risk structure pass
1. Reorder top-level sections in Main Config.
2. Move tool launch buttons into Utilities folder.
3. Set accordion defaults per matrix.

#### Phase R2 — Control Panel live-play pass
1. Add Quick Scene Beats section.
2. Split Weather Director into explicit mode sub-accordions.
3. Move utilities into collapsed advanced section.

#### Phase R3 — Density and discoverability pass
1. Add section chips/status summaries.
2. Add favorites/recent controls.
3. Add selective single-open accordion mode where useful.

### 12.10 Acceptance Criteria for Re-Arrangement

- GM can perform time + weather shift in <= 3 interactions from control panel open.
- Main Config no longer requires opening Global Controls for tool launches.
- New users can distinguish authoring vs live-play panels without docs.
- Average vertical scroll in primary workflows is reduced from current baseline.
- Section ownership conflicts (same control in multiple places) are minimized and intentional.

---

## 13) Session 3 — Optional Enhancements (Nice-to-Have, High Value)

These are explicitly optional for first implementation waves, but strongly improve long-term usability and polish.

### 13.1 Optional Enhancement Track A — Presets, Snapshots, and Reuse

1. **Control Panel Scene Beats Library**
   - User-defined quick actions (time + weather + wind bundles) with named entries.
   - Example: `Storm Front`, `Golden Hour`, `Dead Calm`.

2. **Main Config Authoring Profiles**
   - Save/restore profile bundles for effect stacks by map type (dungeon, city, arctic, desert).

3. **A/B Snapshot Compare Mode**
   - Capture current panel state as Snapshot A/B and instantly toggle for visual comparison.

### 13.2 Optional Enhancement Track B — Advanced Navigation

1. **Command Palette (Ctrl/Cmd+K style)**
   - Jump directly to sections, effects, or commands (`Open Control Panel`, `Set Dusk`, `Enable Fog`).

2. **Cross-Panel Quick Actions Rail**
   - Tiny persistent strip for fast panel switching and most-used commands.

3. **Pinned Global Favorites Bar**
   - User pins controls from any panel into a compact always-available list.

### 13.3 Optional Enhancement Track C — Layout Personalization

1. **Panel docking presets**
   - `Authoring Layout`, `Live Play Layout`, `Debug Layout`.

2. **Compact mode / Dense mode toggle**
   - Reduced paddings and smaller control footprints for experienced users.

3. **Adaptive initial expansion**
   - Auto-expand sections with warnings/overrides while keeping others collapsed.

### 13.4 Optional Enhancement Track D — Contextual Guidance

1. **Inline micro-help toggles**
   - Per section explanation rows that can be collapsed permanently per user.

2. **First-run live-play checklist**
   - One-time guided flow for GMs opening Map Shine Control Panel.

3. **Dependency explainers**
   - Rich hover/tooltip explanations for controls affected by prerequisites.

### 13.5 Optional Enhancement Track E — Power-User Operations

1. **Batch apply to selected effects**
   - Multi-select enable/disable, intensity scaling, reset scopes.

2. **Export/import partial settings bundles**
   - Export only selected sections or categories.

3. **Hotkey binding editor for live-play actions**
   - Direct hotkeys for common Scene Beats and weather transitions.

### 13.6 Optional Feature Gate Strategy

- All optional features should be behind capability flags so core workflows remain stable.
- Prefer opt-in toggles in a dedicated `UI Experimental` area.
- No optional feature should block baseline panel performance or startup time.

---

## 14) Final Target IA (Post-Planning Baseline)

### 14.1 Main Config (Authoring) — Final structure target
1. Scene Setup *(expanded)*
2. Authoring Workflow *(expanded)*
3. Environment
4. Surface & Material
5. Atmosphere & Weather Authoring
6. Particles & VFX
7. Water
8. Tokens & Character Rendering
9. Utilities *(panel launchers)*
10. Diagnostics & Developer Tools
11. Support & Links

### 14.2 Map Shine Control Panel (Live Play) — Final structure target
1. Live Snapshot *(expanded)*
2. Quick Scene Beats *(expanded)*
3. Time Director *(expanded)*
4. Weather Director
   - Dynamic Mode (sub-accordion)
   - Directed Mode (sub-accordion)
5. Wind
   - Quick Wind
   - Advanced Wind
6. Tile Motion Transport
7. Utilities (Advanced)

### 14.3 Graphics Settings — Final structure target
1. Global Overrides *(expanded)*
2. Effect Overrides *(collapsed; expand overridden items first)*
3. Optional Presets / Performance modes

### 14.4 Diagnostics Suite — Final structure target
- Keep as separate panels, but standardized shell and status language.
- Default to summary-first, deep sections collapsed.

---

## 15) Implementation-Ready Work Packages (Handoff)

This planning stage is complete when implementation can proceed in clear, low-risk slices.

### WP-1: Shared UI Shell Standards ✅
- Normalized compact 2-column button grids across all panels.
- Added persistence scope notes to all panels (scene/client/runtime).
- Added folder tag chips to Tile Motion Dialog, Control Panel, and Graphics Settings.
- Panels covered: Main Config, Control Panel, Graphics Settings, Effect Stack, Diagnostic Center, Tile Motion Dialog.
- Light Editor intentionally excluded (specialized workflow with its own overlay system).

### WP-2: Main Config Re-Arrangement ✅
- Split overloaded Global Controls into Authoring Workflow.
- Moved tool launchers into dedicated Utilities section with compact grid.
- Introduced Tokens & Character Rendering top-level section.
- Applied new top-level order and single-open accordion defaults.
- Made Support & Links collapsible and default-collapsed.

### WP-3: Control Panel Live-Play Upgrade ✅
- Introduced Quick Scene Beats section with time/weather quick actions.
- Rebuilt weather section into explicit Dynamic/Directed sub-accordions with auto-expand.
- Moved wind controls to dedicated Wind section with Quick/Advanced folds.
- Reorganized utilities with compact grid and de-emphasis.
- Added folder tag badges for section summaries.

### WP-4: Space Optimization Pass ✅
- Compact 2-column button grids in Main Config, Control Panel, Graphics Settings, Diagnostic Center, Effect Stack, Tile Motion Dialog.
- Section summary chips (folder tags) in Control Panel and Tile Motion Dialog.
- Single-open accordion behavior in Main Config and Control Panel.
- Active-count tag on Graphics Settings Effects folder.

### WP-5: Trust and Feedback Pass ✅
- Persistence scope display in Control Panel status panel (Scene GM authoritative / Runtime only).
- Save-scope notes in Control Panel utilities, Graphics Settings, Tile Motion Dialog, Diagnostic Center, Effect Stack.
- Disabled-state reason messaging in Control Panel Tile Motion section.
- Disabled controls for non-GM / unavailable tile motion.

### WP-6: QA + Regression Verification ⏳
- Validate no startup regressions.
- Validate live-play speed goals and reduced-scroll objectives.
- Validate persistence consistency (accordion state and control state).

---

## 16) Planning Closeout

### 16.1 Planning Completion Checklist
- [x] Session 1 complete (overview and baseline inventory)
- [x] Session 2 complete (high-priority UX improvements)
- [x] Session 2 addendum complete (research-driven re-arrangement and space strategy)
- [x] Session 3 complete (optional enhancements)
- [x] Final IA and work-package handoff documented

### 16.2 Definition of Planning Done
Planning is considered complete and implementation-ready because:
- Panel ownership boundaries are clear.
- Re-arrangement targets are explicit.
- Control Panel live-play strategy is clearly separated from authoring.
- Priority and optional tracks are separated.
- Execution can start in discrete work packages without reopening core planning questions.

### 16.3 Implementation Entry Point (Next Output)
Begin implementation with **WP-2 + WP-3 first**:
1. Main Config re-arrangement
2. Control Panel live-play restructuring

These two packages deliver the highest practical UX impact immediately while preserving existing systems.

---

## 17) Plugin Research Addendum — Tweakpane Essentials + Camerakit

This addendum captures the research phase for evaluating two upstream Tweakpane plugins for Map Shine UI enhancement.

### 17.1 Research scope and compatibility check

Reviewed:
- `@tweakpane/plugin-essentials` (README + compatibility table)
- `@tweakpane/plugin-camerakit` (README + compatibility table)

Compatibility result:
- Map Shine vendors **Tweakpane 4.0.3** (`scripts/vendor/tweakpane.js`), and both plugins are compatible with Tweakpane 4.x.
- Essentials target for 4.x: `0.2.x`
- Camerakit target for 4.x: `0.3.x`

### 17.2 Current integration constraints in Map Shine

Current module architecture uses vendored, browser-loaded ES modules:
- `module.json` loads `scripts/vendor/tweakpane-loader.js` before `scripts/module.js`
- `tweakpane-loader.js` imports local `./tweakpane.js` and exposes `window.Tweakpane`

Implication:
- We should prefer a **vendored plugin loading path** first (same pattern as existing Tweakpane integration), rather than introducing a bundler requirement.

### 17.3 Installation options (recommended path first)

#### Option A (Recommended): Vendored plugin modules (no build pipeline change)
1. Add vendored plugin files under `scripts/vendor/` (ESM builds):
   - `tweakpane-plugin-essentials.js`
   - `tweakpane-plugin-camerakit.js`
2. Extend `scripts/vendor/tweakpane-loader.js`:
   - Import each plugin module
   - Expose references on `window` (for non-module UI classes)
3. In each pane manager after `new Tweakpane.Pane(...)`, register only if available:
   - `pane.registerPlugin(window.TweakpaneEssentialsPlugin)`
   - `pane.registerPlugin(window.TweakpaneCamerakitPlugin)`
4. Keep registration defensive (`try/catch`) so UI still works when plugin file is missing.

Why this fits current architecture:
- Matches existing `window.Tweakpane` exposure strategy.
- Avoids dependency on package install/build steps for Foundry runtime.

#### Option B (Secondary): NPM package path
1. Add dependencies in `package.json`:
   - `@tweakpane/plugin-essentials@^0.2.x`
   - `@tweakpane/plugin-camerakit@^0.3.x`
2. Add a build step that emits browser-consumable ESM into `scripts/vendor/` for release.

Caveat:
- Current project is not relying on a front-end bundle pipeline for UI runtime, so this option adds maintenance overhead.

### 17.4 What we can use these controls for

#### Essentials plugin

1. `radiogrid`
   - Best for compact preset picks where vertical space matters.
   - Candidate uses:
     - Quick Scene Beats (time/weather/wind presets)
     - Graphics settings resolution scale presets
     - UI scale presets in Authoring Workflow

2. `buttongrid`
   - Best for directional or matrix actions.
   - Candidate uses:
     - Wind direction quick picks (8-way compass)
     - Time jumps (dawn/noon/dusk/midnight) as compact deck
     - Utility action clusters in diagnostics/control panel

3. `fpsgraph`
   - Best for diagnostics/perf visibility.
   - Candidate uses:
     - Diagnostic Center live frame pacing snapshot
     - Optional Effect Stack perf lane for heavy scenes

4. `interval`
   - Best for min/max bounded pairs.
   - Candidate uses:
     - Randomized parameter ranges in authoring tools
     - Day/night active window controls for weather/effects

5. `cubicbezier`
   - Best for transition/easing authoring UX.
   - Candidate uses:
     - Weather transition easing profile
     - Tile motion interpolation/ease tuning

#### Camerakit plugin

1. `cameraring`
   - Best for cyclic/angular values.
   - Candidate uses:
     - Wind direction heading
     - Sun azimuth / light direction controls
     - Circular time-of-day scrubber

2. `camerawheel`
   - Best for tactile scrubbing of scalar values.
   - Candidate uses:
     - Transition duration
     - Time rate / speed multipliers
     - Wind speed or gustiness fine control

### 17.5 UX placement guidance (where to use “nicest controls”)

Use richer controls where they improve speed/clarity, not everywhere:

1. Control Panel (highest value)
   - Quick Scene Beats -> `radiogrid`/`buttongrid`
   - Wind heading -> `cameraring`
   - Time scrub/duration -> `camerawheel`

2. Main Config (targeted upgrades)
   - Authoring presets -> `radiogrid`
   - Advanced easing -> `cubicbezier` (only in advanced folders)

3. Diagnostics (optional)
   - Perf visualization -> `fpsgraph`

Guideline:
- Keep default flows simple.
- Gate advanced controls behind expanded folders.
- Avoid replacing standard sliders where precision text input is already efficient.

### 17.6 Rollout proposal (research-phase outcome)

#### Pilot slice (low risk)
1. Register both plugins globally (defensive).
2. Add `radiogrid` to one Quick Scene Beats section.
3. Add `cameraring` to one wind-direction control.
4. Add optional `fpsgraph` in Diagnostic Center.

Success criteria:
- No pane init regressions.
- Reduced vertical scroll in live controls.
- Faster selection for preset-heavy actions.

#### Expansion slice
- Scale plugin controls to additional high-value locations after pilot validation.

### 17.7 UI clipping issue follow-up (pill chips)

Observed issue:
- Recently introduced pill chips/tags in folder headers can clip due tight header line box.

Mitigation applied in shared CSS:
- Added compact chip sizing rules to reduce vertical footprint and align content centrally for:
  - `.map-shine-folder-tag`
  - `.map-shine-effects-count-tag`

Validation checklist:
1. Open Main Config, Control Panel, Tile Motion Dialog, Graphics Settings.
2. Verify tag chips are fully visible in expanded/collapsed folder states.
3. Verify no overlap at UI scale extremes.

