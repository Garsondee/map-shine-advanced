# V2 UI/UX Featureset — Briefing

**Purpose.** Context pack for whoever (or whatever) is designing the UI/UX for Map Shine Advanced. It
describes the *complete* control surface V2 (`legacy/`) shipped, so a redesign knows what it must
cover, who each surface serves, and what data model drives it. It is a description of V2, not a
prescription — V2's renderer was abandoned for good reasons (see `docs/planning/Engine-Postmortem.md`),
but its feature surface is the reference for scope.

**Scale of what's being replaced:** ~376k lines of JS total, of which `legacy/ui/` is **67 modules /
~55,600 lines**, plus **8,528 lines of CSS** (~1,073 class selectors). Two files dominate:
`ui/tweakpane-manager.js` (11,157 lines) and `ui/control-panel-manager.js` (5,533 lines).

**Companion documents.** This is the *breadth* pass. For per-effect *depth* — every V2 parameter with
its harvested label, tooltip, and glossary prose — see `docs/reference/v2-effect-params/` (one file
per effect). For the V3 direction this is meant to inform, see `docs/planning/Effects-UI.md`
(front-of-house / rear-of-house over one schema) and `docs/planning/Control-Panel.md`.

---

## 1. What the module is, in one paragraph

Map Shine Advanced replaces Foundry VTT's PIXI map canvas with its own renderer, then layers ~44
visual effects on top (water, fire, weather, lighting, shadows, vegetation, post-processing). Because
it owns the canvas, it also had to re-implement the interaction surfaces Foundry normally provides —
token selection and movement, walls, doors, drawings, notes, templates, measurement — and add
authoring surfaces of its own (map points, levels, tile motion, camera paths). The UI therefore spans
three very different jobs: **tuning a look**, **running a session**, and **authoring a map**.

## 2. Three audiences, three postures

| Audience | Wants | V2 surface |
|---|---|---|
| **Map author / GM in prep** | Deep parameter access, every knob, per-scene persistence, presets, export | Map Shine Config (Tweakpane), ~1,880 controls |
| **GM at the table, mid-session** | Fast, tactile, low-cognition, no reading | Map Shine Control (bespoke "wand remote"), weather + time + lights |
| **Player** | Make it run; nothing else | Performance & Graphics dialog, Player Light picker |

A fourth, implicit audience: **the developer debugging a scene** — Diagnostic Center, Breaker Box,
Pixel Probe, Performance Recorder, Streaming Minimap, Effect Stack.

The postures are genuinely different and V2 correctly built separate UIs for them rather than one
panel with a "simple mode". A redesign should preserve that split.

## 3. Entry points

Everything hangs off the Foundry **Tokens** scene-control toolbar (plus Lighting for one override):

| Tool | Icon | Audience | Opens |
|---|---|---|---|
| `map-shine-config` | cog | GM | **Map Shine Config** — the big Tweakpane panel |
| `map-shine-control` | sliders | GM | **Map Shine Control** — live-play remote |
| `map-shine-gm-effect-controls` | eye | GM | Map Point Effect Controls |
| `map-shine-loading-screens` | images | GM | Loading Screen designer |
| `map-shine-graphics-options` | gauge | **everyone** | Performance & Graphics |
| `map-shine-player-light` | lightbulb | everyone (world-gated) | Player Light picker |
| Lighting → `reset` | cloud | GM | *Replaces* Foundry's fog reset to also clear V2 buffers |

Other Foundry integrations: an **Actor sheet header button** ("Movement Style"), injected fields in
**Tile Config**, a **Token HUD** hook, and a Settings-menu entry for native-rendering fallback. There
were **no keybindings** registered — all interaction went through the canvas or the panels.

## 4. The surfaces

### 4.1 Map Shine Config — the deep panel (Tweakpane, GM only)

The authoring workhorse. A single scrollable pane with these top-level sections:

- **⚡ Quick Actions** — a 2-column button grid, ~22 buttons, each with a real tooltip:
  Defaults / Undo Defaults · Texture Manager · Effect Stack · Apply to All Scenes · Scene Recovery ·
  Scene Reset · Streaming Minimap · Tile Streaming Report · Token Movement · Tile Motion · Map Points ·
  Camera Path · Levels Authoring · Diagnostic Center · Pixel Probe · Breaker Box · Performance Recorder ·
  Export Preset · Copy From Scene · Reset Effects…
- **🚀 Getting Started** — an onboarding/enable gate with repair-vs-reset recovery choices, shown
  before the module is enabled on a scene.
- **🎨 Panel Appearance** — UI colour scheme picker (5 themes, 2 flagged accessibility: Charcoal,
  Midnight Blue, Forge Amber, High Contrast, Soft Light).
- **🎬 Intros** — intro zoom on scene load.
- **🧍 Tokens & Character Rendering** (incl. token colour correction), **☀️ Sun & Shadows**,
  **🎲 Dice So Nice**, **✨ Sequencer / JB2A**, **⛓️ Rope & Chain** — cross-cutting sections that
  aren't a single effect.
- **Seven effect categories**, in fixed order:
  `🎮 Gameplay & Interaction · ☀️ Lighting & Shadows · 🌦️ Atmosphere & Weather · 🪨 Surface & Materials ·
  ✨ Particles & VFX · 📷 Camera & Post · 🔧 Developer Tools`
- **🔧 Developer Tools** subsections: UI validator · Settings copy (non-default / changed-this-session /
  all) · Scene dump + pixel probe (pick A/B/C, show report, cancel) · Paste scene settings · Copy
  effects from another scene · Colour calibration (mode, chart spec path, run scan, download report).
- **💬 Support & Links**, **branding**.

Every effect is a folder generated from a schema (§5). Roughly **44 effects × ~40 params average**.

### 4.2 Map Shine Control — the live-play remote (bespoke DOM, no Tweakpane)

A 436px-wide "wand remote" with a deliberately tactile, non-Tweakpane visual language — glass head,
mode bar, a panel "clunk" on interaction. Zones:

- **Astrolabe dial** (hero) — concentric rings combining **time of day** and **wind speed/direction/
  gustiness** in one draggable dial. Companion widgets: Smart Ring Clock (phase gradient, Dawn/Noon/
  Dusk/Midnight anchors), Wind Compass.
- **Weather "fingers"** — 14 one-tap presets flanking the dial: Clear (Dry) · Clear (Breezy) ·
  Partly Cloudy · Overcast · Mist · Drizzle · Light Rain · Rain · Heavy Rain · Thunderstorm ·
  Snow Flurries · Snow · Blizzard · Fog (Dense).
- **Mixer** — a chunky vertical **fader board** (Rain, Clouds, Fog, Wind, Temp/Freeze, Lightning, Ash),
  with a *split-bounds* variant for Dynamic Weather where each fader carries min/max handles, a
  draggable live-state tick, and a dashed preview while dragging.
- **Dynamic Weather deck** — 23 biome / scene-mood presets that set bounds rather than values, so
  weather evolves inside an authored envelope.
- **Strike row** — manual lightning triggers.
- **Tile motion transport** — Start / Pause / Resume / Stop + speed.
- **Global timing** — Time Speed (% of real time) and **Environment Fade** (how long time, weather,
  wind, fog, lightning and ash take to cross-fade; Instant → many minutes).
- **Advanced drawer** — 🌦 Weather Director (Dynamic vs Directed) · 🔳 Overhead Occlusion (hole radius,
  soft edge) · 🔦 Player Lights (per-mode allowance for 6 modes, flashlight wobble/brokenness, global
  defaults).

This is the single most distinctive piece of V2 UI and the one most worth preserving in spirit.

### 4.3 Performance & Graphics (all clients)

Per-client overrides that never touch scene data — the accessibility/perf escape hatch. Sections:
Smoothness · Render quality · Weather & particles · GPU VRAM tier · System RAM tier · then a
per-effect enable list grouped by category, where each row shows availability and a reason when
unavailable. Backed by an **Effect Capabilities Registry** where each effect declares
`performanceImpact: low|medium|high`, `supportsEnabledOverride`, `supportsIntensityOverride`, and an
`isAvailable()` predicate.

### 4.4 Player Light picker (all clients, world-gated)

Palette of 6 modes: Torch · Flashlight · Night Vision · Low-light Vision · Infravision · Active IR.
Each mode has a world-level allowance (`global` / `allowed` / `disallowed`) plus a master "allow
players to toggle" switch — so the GM controls what the palette even offers.

### 4.5 Authoring dialogs

| Dialog | What it authors |
|---|---|
| **Map Points** | Draw groups on the map — `point`, `line`, `area`, `rope` — and bind particle/effect emitters to them. Includes per-group level binding, render-layer choice, snap-to-grid, colour-coded group list, control clusters. |
| **Levels Authoring** | Multi-floor level bands, elevations, per-floor mask associations. |
| **Camera Path** | Cinematic sweeps: keyframes, presets, preview, and optional time-of-day/environment ramps along the path. |
| **Tile Motion** | Animated tile translate/rotate/scale with timing and easing. |
| **Token Movement** | Movement styles, elevation rules, door policy, fog path policy, A* pathfinding weight, right-click-move-immediate, left-click-to-move. |
| **Texture Manager** | Browse/preview/assign mask and material textures. |
| **Loading Screens** | Full designer: wallpapers (single/sequential/random), fonts (incl. Google Fonts), hints, animations, element layout/resize, presets, and 9 presentation timings (cover fade, panel in/out, min black hold, min visible, ready hold, scene reveal fade, progress settle…). |
| **Scene Presets** | 5 shipped presets in `data/presets/` (baseline, calibration-neutral, furnace-forge, lightning-storm-horror, the-mad-scientists-lair, wizards-lair) + export-to-clipboard authoring flow. |

### 4.6 Diagnostic surfaces

| Surface | What it shows |
|---|---|
| **Diagnostic Center** | Target picker + actions + report; render health, mask readiness, dependency checks, Levels wiring report. |
| **Breaker Box** | Render dependency graph — 13 declared data sources (water masks, cloud field, roof capture, window masks, fire masks, player runtime, lighting core, quark particles, sky grade, building shadow RTs, specular/`_Outdoors`) traced into effects, with pass/fail per level and direct-vs-propagated failure partitioning. Has a header indicator. |
| **Effect Stack** | Albedo/mask source summary, composite segments, tile count, warnings; filterable tile list (ground/overhead/roof) and effect list. |
| **Performance Recorder** | Start/Stop/Reset/Export, live sortable per-effect table, clean-test mode, plus specialised recorders for bloom, lighting, pacing, stutters, frame budget, quarks, weather window, world overlays. |
| **Streaming Minimap** | Scene thumb + streaming grid cells + camera frustum + VRAM stats + fault dashboard. |
| **Pixel Probe** | Click three map points (A/B/C), sample compositor colour/mask/lighting, view compressed report dialog. |
| **Mask status rows** | Per-effect inline row showing whether the required texture was found: `searching / found / missing-muted / missing-alert`, with authoring templates telling the author exactly what file to make. |
| **Loading overlay** | Weighted, honest progress stages ("Applying scene settings…") — describes the phase, never individual assets. |

## 5. The data model the UI is generated from

**This is the most important section for a redesign.** V2's panels are not hand-built — almost every
control comes from a static `getControlSchema()` on the effect class. 41 files declare one.

```js
static getControlSchema() {
  return {
    enabled: true,
    presetApplyDefaults: true,
    help: {                       // 25 effects have this; 17 have a glossary
      title: 'Bush canopy (_Bush masks)',
      summary: 'markdown…',
      glossary: { 'Canopy shadow': 'Darkening from a blurred, offset sample…' },
    },
    groups: [
      { name: 'look', label: 'Look', type: 'folder', expanded: true,
        parameters: ['intensity'] },
      { name: 'shadowCoupling', label: 'Shadow coupling', type: 'folder',
        advanced: true, expanded: false,
        subgroups: [ { label: 'Canopy shadow', parameters: [...] }, … ] },
    ],
    parameters: {
      waveSpeed: { type: 'slider', min: 0, max: 4, step: 0.01, default: 0.79,
                   label: 'Wave speed scale',
                   tooltip: 'Multiplies wind-driven Gerstner phase speed.' },
      debugView: { type: 'dropdown', default: 0, label: 'Debug View',
                   advanced: true, options: { … } },
    },
  };
}
```

**Control types in use**, by frequency: `slider` (1,581) · `boolean` (190) · `folder` (166) ·
`inline` (59) · `color` (40) · `string` (17) · `checkbox` (15) · `list` (13) · `dropdown` (13) ·
`button` (5) · `select` (4) · `gradient` (2). Plus a bespoke **canvas gradient editor** (draggable
colour stops over lifespan, click-to-add, double-click-to-edit) used for particle colour ramps.

**Per-parameter metadata a generator must honour:** `label`, `tooltip`, `min`/`max`/`step`, `default`,
`options`, `advanced` (hide behind a disclosure), `gmOnly` (hide from players entirely), and
dependency state (a param can be greyed out when its enabling param is off — see
`ui/parameter-validator.js`, which also handles specular effective-state and stripe dependencies).

**Per-group metadata:** `label`, `type` (`folder` | `inline`), `expanded`, `advanced`, `separator`,
`tooltip`, `subgroups`.

**Rough totals:** ~1,880 parameter controls in the effect schemas, plus 133 more in
`WeatherController` (which uses its own flat `{ label, default, min, max, step, group, gmOnly }`
shape — an inconsistency worth fixing). **Water alone has 376 sliders; Fire 154; Player Light 160.**

Sizes are lopsided and that is a UX fact, not a bug to normalise away: a handful of effects carry
most of the complexity, and the panel needs to survive that.

## 6. Persistence and scope — four distinct storage scopes

A redesign must make these legible, because V2's biggest confusion was "where did my setting go?"

1. **Per-scene flags** (`flags.map-shine-advanced.*`) — the default for effect parameters. Saved on
   the scene document; GM-only writes, guarded by `canPersistSceneDocument()`.
2. **World-based effects** — an opt-in per-effect toggle (`lighting` and `colorCorrection` were
   eligible) that moves that effect's params into a shared world setting so they apply everywhere.
   The panel shows a "World Based" switch inside the effect folder.
3. **Client settings** — per-user, never synced: graphics overrides, VRAM/resolution presets, UI
   theme, debug mode, intro zoom.
4. **World settings** — GM policy: player-light allowances, loading screens, token rendering mode,
   fog save quality, movement policies. 42 registrations total.

Supporting machinery: control-state sanitisation on read and export, a scene-flag repair path, a
local flag write-guard (to avoid re-render storms while editing), and clipboard-based
export/paste/copy-between-scenes.

## 7. Cross-cutting UI concerns V2 handled (and a redesign must too)

- **GM parity** — `isGmLike()` / `isUserGM()` / `canPersistSceneDocument()` gate ~17 call sites in the
  main panel alone. Assistant GMs, players with ownership, and true GMs differ.
- **Theming** — 5 schemes injected at runtime as CSS custom properties onto 7 named host roots, so a
  dropdown change re-themes every open panel immediately.
- **Event isolation** — every floating panel stops `pointerdown/mousedown/click/dblclick/wheel/
  contextmenu` from reaching the canvas. Because MSA owns the canvas, a leaked click moves a token.
- **Draggable, resizable, persistent panel geometry** with a header drag overlay.
- **Contextual help** — schema-embedded markdown summaries and glossaries rendered inline, plus real
  tooltips on nearly every button and slider. This is unusually good and worth keeping.
- **Loading and readiness** — a styled loading screen system, level-transition curtains, and honest
  staged progress. Floor switches need settle time; the UI must not lie about readiness.
- **Availability, not silence** — when an effect can't run (missing mask, unsupported GPU), the row
  says so with a reason rather than disappearing.
- **Localisation** — partial. Some strings go through `game.i18n` (`MAPSHINE.*`), most are hardcoded
  English. Emoji are used structurally as category markers throughout.

## 8. Effect inventory (what the panel must be able to express)

Grouped as the panel groups them; display titles as shipped.

**Lighting & Shadows** — 💡 Light Physics · 🌅 Sky Environment · 🪟 Window Light · ✨ Bloom Highlights ·
🌑 Shadow Caster Systems (☁️ Overhead, 🏢 Building, 🏔️ Sky Reach, 🖌️ Painted) · 🔦 Player Light.

**Atmosphere & Weather** — 🌧️ Precipitation & Global Weather · 💨 Wind · 🌁 Atmospheric Fog & Air ·
☁️ Cloud Systems · ☁️ Sprite Clouds · ⚡ Overhead Lightning Bolts · 🌩️ Atmospheric Flash Lighting ·
🌫️ Ash Ground Clouds · 🌋 Ash (Weather).

**Surface & Materials** — 💧 Water · 💎 Metallic/Specular · 💧 Fluid · 🌈 Iridescence · 🔮 Prism ·
🌿 Foliage & Vegetation (🌳 Bush, 🌲 Tree) · 🖊️ Ink & Line AO.

**Particles & VFX** — 🔥 Fire · 🕯️ Candle Flames · 🌋 Ash Disturbance · ✨ Dust Motes ·
💦 Water Splashes · 🫧 Underwater Bubbles · 🪰 Smelly Flies.

**Camera & Post** — 📷 Camera Grade · 🎨 Contextual Scene Grade · 🔭 Lens · 🔍 Floor Depth Blur ·
🎭 Stylized Post (🔪 Sharpen, ⚫ Dot Screen, 📰 Halftone, 💻 ASCII, ✨ Dazzle Overlay, 🔄 Invert,
📜 Sepia).

**Gameplay & Interaction** — 🌫️ Fog of War · 👁️ Vision Mode · 📐 Grid · movement preview · selection
box · overhead stamp/occlusion.

**Authored mask suffixes** the UI must help authors produce and verify — 16 authored:
`_Outdoors` `_Specular` `_Roughness` `_Normal` `_Water` `_Fire` `_Windows` `_Structural`
`_Iridescence` `_Prism` `_Tree` `_Bush` `_Fluid` `_Dust` `_Ash` (+ per-floor `_N` variants) — plus 2
derived internally (`floorAlpha`, `skyReach`).

## 9. Known problems worth designing away

These are the honest weak points of V2's UI, drawn from how the code is shaped:

1. **No hierarchy at the top level.** 44 effect folders in a single scroll, ordered by category but
   otherwise flat. Finding "the wetness slider" meant knowing it lived under Water.
2. **Two divergent schema shapes.** Effects use `{ groups, parameters }`; WeatherController uses a
   flat `{ label, group }` map. Anything generating UI has to handle both.
3. **`advanced: true` is the only complexity lever.** There is no notion of a "first ten knobs that
   matter" per effect — one binary disclosure for everything.
4. **Scope is invisible until it bites.** Per-scene vs world-based vs client vs world settings are
   only distinguishable by reading a toggle buried inside a folder.
5. **God objects.** 11k-line and 5.5k-line UI managers; adding a control means editing a file no one
   can hold in their head. (Same failure mode the renderer had.)
6. **Diagnostics are separate destinations.** Seven distinct debug panels, none of which surface
   anything in the panel where the problem actually shows.
7. **Tweakpane is a hard dependency** for the deep panel, and its idioms (blades, folders, disabled
   text bindings used as read-only labels) leak into the design. The Control Panel proves a bespoke
   DOM UI is viable and much nicer.
8. **Player-facing surface is thin.** Two dialogs against a GM surface of thousands of controls.

## 10. If you take three things from this document

1. **The schema is the product.** Whatever the UI looks like, it is generated from per-effect
   schemas with `groups`/`parameters`/`help`/`advanced`/`gmOnly`. Design the schema contract first;
   the panel follows.
2. **Three postures, three UIs.** Deep tuning, live play, and player accessibility are separate
   products that happen to share a data model. V2 got this right.
3. **The Control Panel's tactility is the brand.** The astrolabe dial, the fader board, the weather
   fingers, the panel clunk — that is what makes it feel like a lighting desk rather than a config
   screen. Whatever replaces it should be at least that physical.
