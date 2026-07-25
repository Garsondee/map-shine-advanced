# THE CONTROL PANEL — one shell, five zones, permission-aware

**Status:** DESIGN SPEC, authored 2026-07-20 from an author directive. This is the plan for the **single primary control surface** that replaces the temporary debug panel (`src/diag/debug-panel.js`) and becomes the product face of V3 MSA — one panel, gated so a GM sees the whole thing and a player sees only what is theirs to change.
**Author directive (intent):** the previous module had _"lots and lots of different dialogue interfaces."_ Replace them with **one** panel, different for GMs vs. sub-GM players, built around a reborn **astrolabe** as the primary way a GM changes the visual appearance of the world. It must split into sections easily. Five jobs to house: (1) GM quick-play controls, compact, most-used-only, the rest folded into accordions, with a Quick Actions area and an Advanced-View toggle; (2) GM effect authoring, approachable — _"need some fire… click a fire button… straight to the painting tool… paint some fire and activate it immediately"_; (3) misc GM tools; (4) the author's own building tools (camera, debugging suites); (5) our own graphics-settings interface for players and GMs. Plus: per-effect **presets dropdowns** as an easy on-ramp for non-technical users.
**Foundations this builds on (settled — do not relitigate):** `Effects-UI.md` (FOH/ROH split, the dial layer, the dead-control cure), `UI.md` (Tweakpane for expert lookdev, ApplicationV2 for product, generate-never-handwrite), `Effect-Registration.md` (the registry is the ONE door; the cascade Creator→Scene→World→Player; a11y hard-override; performance profiles Low…Extreme), `Authoring-and-Distribution.md` + `Shapes-and-Regions.md` (Author Mode: paint/vector into the mask authority — **built**), and the debug panel's own reports/actions/selects registry (**built**, and the correct shape to generalise).

---

## 0. THE ONE-LINE THESIS

> V2's UI failure was **too many windows and too much hand-mirroring**, not too many controls. This spec fixes _windows_ with a single permission-aware shell, and fixes _mirroring_ by making every zone a **generated view of a declared registry** — the same schema-driven discipline `Effects-UI.md` already applies inside a single effect, lifted up to the whole panel.

The knob count is already addressed elsewhere (tiers absorb perf sliders — `Effects.md`; FOH dials tame the rest — `Effects-UI.md`). This document is about the **container**: how five audiences share one surface without re-growing the dialog zoo.

---

## 1. WHERE V2 FAILED AT THE PANEL LEVEL — named, because the shell is the antidote

| #   | V2 failure                           | Mechanism                                                                                                                                                                                      | Answered by                                                                                                                            |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **The dialog zoo**                   | Many independent dialogs/menus (tweakpane, control-panel, texture manager, effect stack, graphics-settings, camera-path, streaming-minimap, recovery…) each its own window, discovered by luck | §2–§3 ONE shell, zones are _views_ not _windows_; pop-out is opt-in, never default                                                     |
| P2  | **Three hand-mirrored surfaces**     | tweakpane-manager (11,157) / control-panel-manager (5,533) / graphics-settings (1,607) rendered overlapping subsets of the same 938 params, synced by ~140 hand-written functions (`UI.md` §2) | §8/§10 one cascade, N generated views; the Foundry-settings dialog and the in-panel settings view are two renderings of the SAME store |
| P3  | **No approachable face**             | Every surface pitched at an expert; a non-technical player had nowhere sized for them                                                                                                          | §3 the player face is a _strict subset_; §9 presets are the on-ramp                                                                    |
| P4  | **Everything visible at once**       | No promotion model — the useful three controls drowned in the other three hundred                                                                                                              | §4 the "earn your slot" rule (declared `primary`) + Advanced-View toggle + accordions                                                  |
| P5  | **Quick Actions that weren't quick** | V2's Quick Actions grid mixed one-tap live tools with confirm-first destructive rebuilds (Scene Reset, Recovery, Apply-to-All)                                                                 | §4 quick = live & cheap only; heavy/destructive tools demote to §6 Toolbox                                                             |

> **The core lesson:** the panel is not a place to _put_ controls, it is a place that _derives_ them. A zone that hand-maintains its own list of buttons is a mirror waiting to drift (P2) and a minefield waiting to form (`Effects-UI.md` F1). Every zone below reads from a declared registry so that adding a control, an effect, or a report is one declaration — and appears in the right place, for the right audience, for free.

---

## 2. THE SHAPE — five zones are NOT peers; they stratify

The five jobs feel like five tabs, but they are really three axes: **who** may see it, **when** it is used, and **how often**. Stratifying by those axes is what stops the shell from becoming five apps in a trench coat.

| Zone             | Job                       | WHO                        | WHEN                | HOW OFTEN                                   | Home                                                          |
| ---------------- | ------------------------- | -------------------------- | ------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| **1 · Bridge**   | quick-play world control  | GM                         | live play           | constant                                    | the default view; the astrolabe is its hero                   |
| **2 · Workshop** | effect authoring          | GM (creator)               | prep / authoring    | occasional bursts                           | a view you enter; hands off to Author Mode                    |
| **3 · Toolbox**  | misc GM utilities         | GM                         | occasional          | rare                                        | a view, mostly accordioned                                    |
| **4 · Lab**      | camera + debugging suites | **author/dev only**        | building the module | constant _for the author_, never for a user | a dev-gated drawer; **this is today's debug panel, re-homed** |
| **5 · Settings** | graphics & performance    | **everyone** (player + GM) | set-and-forget      | rare                                        | a view; also mirrored into Foundry's own Settings dialog      |

**Two faces, from one filter.** The shell is one component; permission is a filter over which zones render, not a second codebase (P2's lesson applied to the shell itself — **no `if (isGM)` ladder duplicating layout**):

- **Player face** = **Settings only** (Zone 5), scoped to _their_ machine — the client-scope end of the cascade (`Effect-Registration.md`): performance profile, per-effect on/off within GM-allowed bounds, accessibility, presets. This is "make it run well and look how I like it on **my** computer," and nothing else. It is deliberately small — that smallness is the P3 fix.
- **GM face** = Bridge + Workshop + Toolbox + Settings (with the world-default layer exposed). The astrolabe, authoring, the lot.
- **Author/dev face** = the GM face **plus** the Lab (Zone 4), unlocked by a dev flag (never shipped visible to players or ordinary GMs). The Lab is where the module gets built; it must not be a thing a customer can wander into.

```
        ┌─────────────────────────────────────────────────────────┐
        │  THE SHELL  (one window · draggable/dockable · themed)   │
        │  ┌────┐  ┌──────────────────────────────────────────┐   │
        │  │ 🧭 │  │                                          │   │
        │  │ 🔥 │  │   ACTIVE ZONE BODY                       │   │
        │  │ 🧰 │  │   (Bridge shown by default:             │   │
        │  │ 🔬 │  │    the ASTROLABE + Quick Actions +      │   │
        │  │ ⚙  │  │    accordions for the rest)             │   │
        │  └────┘  └──────────────────────────────────────────┘   │
        │  rail: permission-filtered · icons = the five zones     │
        └─────────────────────────────────────────────────────────┘
   player sees only ⚙  ·  GM sees 🧭🔥🧰⚙  ·  author also sees 🔬
```

---

## 3. NAVIGATION — a vertical icon rail (recommendation), accordions within

**Recommendation: a permission-filtered vertical icon rail** down one edge of the shell, one icon per zone, click to swap the body. One window, one body, N rails — the most direct expression of _"a single panel that splits into sections easily."_ Precedent every user already knows: VS Code's activity bar, Blender's tab strip, Photoshop's tool column.

- **Home is the Bridge**, always the default and always one click back — so dipping into the Workshop never loses the astrolabe you steer play with.
- **Accordions live _inside_ a zone**, never as the top-level nav. The author explicitly praised accordions and the Advanced-View toggle for _hiding secondary controls within a busy area_ — that is exactly their job here (Bridge and Lab are the busy zones). They are the wrong tool for separating five audiences; the rail is right for that.
- **One shell by default; pop-out is opt-in per view.** A view may detach into its own floating window **only** when the workflow needs it beside the canvas (authoring, an A/B preset compare). Detaching is never the default and never proliferates on its own — that is the P1 discipline. The rule of thumb: if two surfaces must be watched _at the same time as the map_, one may pop out; otherwise it is a rail click.

_Alternatives considered — logged so the fork is honest (see §12):_ **all-accordions-in-one-scroll** (what the debug panel does today) is fine within a zone but collapses five audiences into one undifferentiated column — it cannot give the player a small face without showing them the scaffolding. **A window per zone** is literally the V2 dialog zoo. The rail is the middle path: one window, clean sections, trivially extended.

**Chrome technology.** The shell chrome and the product zones (Bridge/Workshop/Toolbox/Settings) want Foundry's **ApplicationV2** — themed, permission-aware, native, and it gives tabbed single-window layout for free (`UI.md` §3, `Effects-UI.md` §5: ApplicationV2 is the product-facing choice). The **Lab** can keep the existing plain-DOM debug registry mounted inside its rail slot (it is a dev tool; it need not be pretty). The **ROH** per-effect pane stays **Tweakpane in `src/ui/renderers/`** (the only place the `ui/no-handwritten-controls` wall permits it). So: ApplicationV2 shell, generated FOH widgets, Tweakpane behind "Advanced →", plain-DOM Lab. _Plain-DOM-for-everything is the fallback the debug panel already proves works and stays draggable — noted as a fork._

---

## 4. ZONE 1 · THE BRIDGE — the GM's live cockpit (astrolabe + Quick Actions)

The home view. Everything here is **live, cheap, and reached without thinking** — the author's stated goal: _"things available at a moment's notice."_

### 4.1 The astrolabe, reborn

V2's astrolabe (`legacy/ui/control-panel/widgets/astrolabe-dial.js`) was a gorgeous concentric-ring hero dial combining **time of day** (outer ring, eight stops Midnight→Night) and **wind** (inner windsock: drag-out = speed, angle = direction). It is exactly the right centrepiece: one beautiful control that sets the _mood_ of the world, not a wall of sliders.

**V3 rules for it — the non-obvious, load-bearing ones:**

- **A ring may only exist if it drives something live.** Time-of-day and darkness are live today (`light.accumulate`). Wind, weather, and particles are _seams_ — not built yet (`Roadmap-to-Parity.md` §2). **So the astrolabe ships driving time + darkness, and each further ring lights up as its pass lands.** A wind ring that drives nothing is a dead control — the precise class `Effects-UI.md` exists to prevent. The dial is _designed_ for more axes; it does not _render_ an axis with no engine behind it.
- **It drives through the cascade, not a bespoke path.** Turning the dial writes the same validated params/settings the rest of the system reads (`params-schema.js` validate-at-write; the scene/world/client cascade). No `astrolabe → renderer` shortcut — that shortcut is how V2 grew seven homes per value (`Environment.md` §0.4).
- **Foundry-parity at rest.** The dial's default position looks like well-tuned Foundry (`keyhole-two-light-types-decision`). It moves the world _away_ from a good baseline; it does not build the baseline.

### 4.2 Quick Actions — carry V2's pattern, it genuinely worked

A compact grid of grouped one-tap buttons (V2's `ms-quick-actions-grid`: headings + buttons, each optionally `advanced`). The author named this _"genuinely very useful."_ Keep the shape; apply P5's discipline:

- **Quick = live & cheap only.** Toggle a lever, jump the camera, flip a floor, show/hide the minimap. Anything that rebuilds the scene, confirms first, or is destructive (Scene Reset, Recovery, Apply-to-All-Scenes) **demotes to the Toolbox (§6)** — a Quick Action must be safe to fat-finger.
- **The Advanced-View toggle** (V2's `advancedModeEnabled`) hides the secondary buttons behind one switch. Carry it verbatim — it is the "compact by default, deep on demand" the directive asks for.
- **"Only the most important controls appear here" is a promotion model, not a curated list.** A control earns a Bridge slot by **declaring `primary`** — the exact mechanism the debug panel already uses (`{ primary }` overrides, `PRIMARY` set). Everything else defaults into accordions. No one hand-maintains "the important list"; a control nominates itself, and the default is _folded away, never lost_ (the debug panel's "unlisted → More, visible, never a wrong folder" rule).

---

## 5. ZONE 2 · THE WORKSHOP — effect authoring (the crown jewel)

This is the flow the directive dwells on, and every piece it needs **already exists** — the Workshop is the assembly point, not new machinery.

### 5.1 The generated effect catalog

The Workshop opens on a friendly **gallery of effect types** — big labelled tiles (🔥 Fire · 💧 Water · 🌫️ Fog · 🕯️ Candles · ✨ Dust · …). **The gallery is generated from the effect registry** (`effects/registry.js` `list()`), never a hand-written list. Register an effect → it appears in the Workshop for free. That is the velocity test (`Skeleton.md` law 2) applied to the authoring UI, and it is the P2 fix: no second place that enumerates effects and drifts.

### 5.2 The "need fire" flow — click → paint → alive

The directive, made concrete. GM thinks _"need some fire,"_ clicks **🔥 Fire**, and the Workshop runs one scripted path:

1. **Ensure + enable.** Register/enable Fire for this scene through the registry (the one door) and the cascade — a scene-flag deviation the map travels with (`Authoring-and-Distribution.md`).
2. **Straight to the brush.** Enter **Author Mode** (`src/ui/paint-mode.js` — built, live-tested) with the tool pre-selected to the **`_Fire`** mask. No mask-picker detour; the button already knew the mask.
3. **A minimal FOH strip, right there.** Beside the brush: a **preset dropdown** (§9) + 3–6 **dials** (`Effects-UI.md` §3) for fire — "Intensity," "Liveliness," "Warmth." Approachable, bounded, cannot break the look.
4. **Paint → live → done.** The GM paints where fire belongs; the effect consumes the mask **live** (paint fire, see fire — the mask authority is the shared truth). Save embeds the mask in the scene flag (Mode A) or bakes a sibling file (Mode B).

The whole flow is: **registry (one door) + Author Mode (built) + FOH dials (Effects-UI) + mask authority (built)**, sequenced by one button. The Workshop's only new code is the _choreography_ — and even that is data: a `{ effectId, mask, presetSet }` per gallery tile, read from the registry.

### 5.3 Beyond fire

The same tile choreography covers anything that paints into a mask (Shapes-and-Regions: brush _or_ vector, one authority). Point/emitter effects (a single candle, one lightning strike) route to the placements registry rather than the brush — same gallery, a different declared tool per tile. The gallery does not special-case them; the tile's declared `tool` does.

---

## 6. ZONE 3 · THE TOOLBOX — misc GM utilities

The _"useful sometimes, not others"_ drawer. Mostly accordioned, nothing on the hair-trigger. Natural residents (several are V2 Quick Actions that were never really _quick_ — P5): Texture Manager, Effect Stack / render-stack inspector, **Apply current look to all scenes**, **Scene Reset** (confirm-first), **Scene Recovery** (confirm-first), package-readiness / self-containment check (`Authoring-and-Distribution.md` §gate), import a V2 scene's map-points (`foundry/v2-anchor-import.js`). These are GM-level but heavy or rare — they belong one deliberate step away from the live Bridge.

---

## 7. ZONE 4 · THE LAB — the author's building tools (dev-gated)

**This is today's `src/diag/debug-panel.js`, re-homed as a permission-gated zone — not thrown away.** Its reports/actions/selects registry, the flight-recorder "Export everything," the Pixel Probe, the Performance Lab, the camera tools, the stress/soak fixtures — all keep working, mounted inside the Lab rail slot.

- **Gated behind a dev flag.** Players and ordinary GMs never see the Lab. It is the module-building surface; a customer wandering into "Zoom thrash (torture)" is a bug.
- **Its registry is the shell's contribution API, generalised (§10).** `registerReport`/`registerAction`/`registerSelect` with `{ group, primary }` is _already_ the right shape — declare an entry, it lands in the right folder, self-nominate to be primary, unknown → visible-not-lost. The shell lifts this exact pattern to all five zones. The Lab is where the pattern was proven; it does not change.
- **The reports/actions split keeps its teeth** (the debug panel's load-bearing contract): the flight recorder runs every _report_ on export and never an _action_ — so an export can't restart the author's scene. That contract survives the move unchanged.

---

## 8. ZONE 5 · THE SETTINGS — graphics & performance (the player-facing face)

The one zone everyone sees, and the whole of the player face. It is **our own** interface onto settings that mostly **already exist** (`foundry/settings-adapter.js` — the only place `game.settings` lives; `effects/effect-settings.js` derives descriptors from the registry). This zone renders those descriptors nicely; it does not invent a parallel store.

- **Leads with the performance profile** — Low / Performance / Standard / Quality / Extreme (`Effect-Registration.md` §3): the ultimate FOH dial, the games-industry front door. One choice sets every effect's tier.
- **Then per-effect enable**, within GM-allowed bounds. An effect the GM disabled world-wide isn't offered; an effect forced off by **accessibility** (reduce-photosensitive) shows **locked**, because a11y is a hard override even a GM can't defeat (`Effect-Registration.md`; safety always slides — `feedback_safety_slide_outranks_doctrine`).
- **Then presets per effect** (§9) — the low-effort path to a nicer look without touching a dial.
- **Cascade-aware from one surface.** A **player** here writes **client scope** — their machine, their final say. A **GM** sees the same surface plus the **world-default** layer they set for their table. Same generated view, two layers exposed by permission — the P2 fix made literal.
- **It is the same store as Foundry's Settings dialog.** The descriptors already register with `config:true`, so they appear in Foundry's native Settings too. The in-panel Settings zone and the Foundry dialog are **two renderings of one cascade**, not two surfaces to keep in sync. (This is the direct antidote to V2's `graphics-settings-manager.js` being a third mirror.)

---

## 9. PRESETS — the easy on-ramp, as declared data

The author's ask: give each effect _"a dropdown with presets… a way of making the experience easier for less technical users."_ `Effects-UI.md` §3.1 already frames a preset as **the discrete cousin of a dial: a named snapshot of ROH values** (`serializeParams` output) — "Golden hour," "Menacing," "Faint embers."

- **Declared beside the effect, validated against its schema** — the same anti-rot discipline as dials (`dials/valid-reference` wall). A preset that sets a param the schema doesn't have **fails the build**. Presets cannot become the new dead-control minefield because they are checked data, not free-form blobs.
- **One dropdown, two homes.** The preset dropdown sits atop each effect's FOH strip and appears in **both** the Workshop (§5.3) and Settings (§8) — one declaration, rendered wherever that effect's FOH renders. A preset sets a starting point; dials nudge from there (Effects-UI §3.1).
- **Presets travel.** Because a preset resolves to param values and values live in scene flags / settings, a scene shipped in an adventure carries its chosen preset for free (`Authoring-and-Distribution.md` self-containment doctrine).

---

## 10. THE CONTRIBUTION API — how zones stay un-rotted

Generalise the debug panel's registry so **every** zone is fed by declarations, not hand-placed widgets:

```js
// A zone entry, declared once, wherever it belongs (an effect, a tool, a report).
// The shell reads these; nobody hand-writes a zone's layout.
{
  zone: 'bridge' | 'workshop' | 'toolbox' | 'lab' | 'settings',
  audience: 'player' | 'gm' | 'dev',   // permission filter, declared not if-laddered
  primary?: true,                       // earn a Bridge/quick slot (else accordioned)
  group?: 'camera',                     // sub-folder within the zone (presentation only)
  // …the entry's own payload: a dial set, an action, a report, an effect tile
}
```

**What this forbids, by construction — each a V2 corpse (`Effect-Registration.md` §6 shape):**

- **A second settings surface** that re-lists params → impossible; Settings renders the registry-derived descriptors (P2).
- **A hardcoded effect list** in the Workshop gallery → impossible; the gallery _is_ `registry.list()`.
- **A permission `if`-ladder** duplicating layout per role → impossible; `audience` is a filter over one layout.
- **A hand-maintained "important controls" list** → impossible; `primary` is self-declared (P4).

**The velocity test governs (as ever).** Adding a control, effect, tool, or report must be **one declaration that appears in the right zone for the right audience** — strictly less work than hand-placing it. If routing an entry into the shell is more work than dropping a button somewhere ad hoc, the next feature drops a button ad hoc, and the zoo regrows exactly as it did in V2 (`UI.md` §0: seven correct designs, seven bypasses, because structure that is slower than velocity always loses).

---

## 11. SEQUENCING — what to build, in what order (deliberately de-risked)

**The key insight: the shell is separable from the per-effect FOH/ROH renderers.** The renderers (Tweakpane ROH, ApplicationV2 FOH dials) are `Effects-UI.md` §6's own build order and are **not yet built** (Tweakpane isn't even vendored). The _shell_ does not wait on them — it can ship on what exists today and let the detail surfaces plug in as they land.

- **Tier 0 — the shell on today's parts.** ApplicationV2 shell + permission-filtered icon rail + the **Bridge** (astrolabe driving **time + darkness only**, Quick Actions carried from V2 with the primary/Advanced discipline) + the **Lab** (re-home the existing debug registry, dev-gated) + the **Settings** zone rendering the **already-built** profile + per-effect-enable cascade. **No new renderer needed** — every dependency here is built. This alone replaces the debug panel with something the directive recognises.
- **Tier 1 — the Workshop.** The generated effect catalog (registry `list()`) + the "need fire" choreography, wiring the built **Author Mode** to registry enable. The gallery tiles are data.
- **Tier 2 — the detail surfaces.** `Effects-UI.md` §6's renderers fill in: the FOH dial strip + ROH Tweakpane behind "Advanced →," and **presets** (§9). These enrich the Workshop and Settings zones already standing.
- **Tier 3 — the astrolabe grows.** As `frame.snapshot` → wind → weather → particles land (`Roadmap-to-Parity.md`), the astrolabe's further rings light up — each only once it drives a live engine.

**Walls to queue** (media ladder, `Skeleton.md`; each a build failure, sabotage-tested per `feedback_walls_must_be_passable_and_wired`):

1. **`ui/zone-from-registry`** — a zone's contents come from declared entries; no zone hand-enumerates effects/params/tools. Extends `ui/generated-only`.
2. **`ui/one-settings-store`** — the Settings zone reads only registry-derived descriptors (`effect-settings.js`); no second param enumeration. Extends the `foundry/adapter-only` fence.
3. **`ui/no-dead-astrolabe-axis`** — an astrolabe axis must bind to a live driver; a ring with no engine fails the build (the dead-control cure at the hero-dial level).
4. Existing walls already cover the rest: `ui/no-handwritten-controls` (Tweakpane only in `ui/renderers/`), `registry-is-the-only-door`, `params/one-owner`.

---

## 12. OPEN FORKS — the author's taste decides these

1. **Navigation model** — the vertical **icon rail** (recommended, §3) vs. all-accordions-in-one-scroll (simplest, what the debug panel does) vs. a home + slide-in drawers (most app-like). The rail is the recommendation; this is the biggest single call.
2. **Chrome technology** — ApplicationV2 shell (recommended: native, themed, permission-aware, free tabs) vs. plain-DOM themed panel (what the debug panel already proves: draggable, zero Foundry-window friction). Mixed is allowed (ApplicationV2 product zones + plain-DOM Lab).
3. **The player face's floor** — Settings-only (recommended: smallest, safest) vs. Settings + a slim read-only "world status" (current time/weather the GM chose), if that is useful to a player.
4. **Naming** — the panel and its zones. Working names here: the panel = **the Astrolabe** (hero dial as namesake); zones = **Bridge / Workshop / Toolbox / Lab / Settings**. A nautical/navigational metaphor (Bridge=steer, Engineering=dev) is available if you want coherence. Purely a taste call.
5. **Docking** — a toggle button in Foundry's left scene-controls toolbar (native muscle memory) vs. a floating draggable panel (V2/debug-panel behaviour) vs. edge-dock. Not mutually exclusive: a toolbar button that opens a floating shell is likely the answer.
6. **Astrolabe launch axes** — time + darkness only (recommended: no dead rings) vs. stub the wind/weather rings visibly-disabled with a "coming soon" affordance so the shape is legible early.
7. **A visual mockup next?** — I can render a clickable HTML mock of the proposed shell (rail, Bridge with the astrolabe, the Workshop gallery, the "need fire" flow) so you can _see_ it before a line of build. Say the word.

---

## 13. THE LESSONS, CARRIED FORWARD

- **The failure was windows and mirrors, not knobs.** One shell kills the windows; one registry per zone kills the mirrors. The knob count was always a symptom (`UI.md` §0), addressed by tiers and dials elsewhere.
- **A zone derives its contents; it never curates them.** The gallery _is_ the registry, Settings _is_ the cascade, the important list _is_ the `primary` flags. Nothing hand-maintained can drift, because nothing is hand-maintained.
- **The shell is separable from the renderers.** Ship it on what's built (Tier 0), let FOH/ROH plug in. That is what keeps this from blocking on Tweakpane vendoring — and what lets the debug panel retire _now_.
- **Permission is a filter, not a fork.** Player, GM, and author see one layout through one lens. The moment layout is duplicated per role, P2 has already won.
- **A control that drives nothing must not be drawn.** The astrolabe earns its rings; every zone earns its entries. The minefield never forms because a dead control can't be built.

---

_V2 gave the GM a maze of windows and the player nowhere to stand. V3 gives everyone one shell: the GM steers the world from the astrolabe, authors fire by painting it, and reaches the deep tools when they want them; the player gets one honest page sized for them; the author gets the whole lab behind a flag — and no zone holds a single control that was hand-placed, mirrored, or left to die in silence._
