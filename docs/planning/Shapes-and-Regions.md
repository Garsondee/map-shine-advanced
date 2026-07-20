# SHAPES & REGIONS — points, lines, polygons, and Map Groups

**Status:** DESIGN SPEC, authored 2026-07-20 from an author directive. The vector half of the Map Points successor — precise points/lines/polygons, plus a Foundry-Region bridge — the sibling of the paint half already building in `Authoring-and-Distribution.md`.
**Audience:** the author, and a fresh session. Read `Authoring-and-Distribution.md` (the paint tool + mask-authority + persistence model this reuses wholesale) and `keyhole-input-model-decision` / `keyhole-interface-seam` first.
**Companions:** `Authoring-and-Distribution.md` (painting; the shared mask authority + scene-flag persistence + self-containment doctrine), `Effects-UI.md` (the effect-binding UI patterns), `docs/reference/v2-effect-params/` (what the point-driven effects did).

---

## 0. THE ASK, AND THE TWO-CHANNEL ANSWER

The painter handles *areas you fill*. It does not handle a single candle, a rope between two points, a stream, or a precisely-bounded pond edge. Those want **vectors: points, lines, polygons.** The author's decision (2026-07-20), and it is the right one:

> **Two complementary channels, each used for what it is actually good at — never one pretending to be the other.**

| Channel | What it is | Good at | Weak at |
|---|---|---|---|
| **A — Foundry Region** (`Map Shine Advanced Map Group` behavior) | A custom Region *behavior type* MSA registers; the GM draws with Foundry's **native Region tool** and tags the region for MSA | Whole grid-spaces affected by something; zero MSA UI to build; GMs already know the tool; travels as a Region document | **Imprecise by design** — grid-snappy, coarse; area-only (no points, no lines) |
| **B — MSA-native vectors** | MSA's own point/line/polygon editor, vertices placed to the **exact pixel, no grid snapping** | Precision; points and lines Foundry can't express; fine polygon edges | It's UI we build and maintain |

**Neither alone is enough.** Use Channel A when "this whole room is a greenhouse" is precise enough and you'd rather not fuss. Use Channel B when the shape has to sit exactly where you mean it, or when it's a point or a line. **A single `Map Group` (the author's name) can draw shapes from both** — that is the unifying abstraction (§5).

---

## 1. WHAT V2'S MAP POINTS WAS — and the UX we must beat

**8 files, 7,480 lines** to place discrete `{x,y}` points that spawn an effect (`legacy/scene/map-points-manager.js`: fire/candle/dust/flies/lightning/water…), with emission-sampling, wall-clustering, control-clusters, and level-binding machinery on top, persisted to `scene.flags.mapPointGroups`. Author's verdict: *"clunky, slow, inorganic, awkward."*

**The UX failures to design against — named so we don't repeat them:**

| V2 failure | The fix here |
|---|---|
| **Placement-only** — you dropped points; you couldn't *draw* a line or a shape | Real point/line/polygon primitives with direct drawing |
| **No direct manipulation** — editing a point meant re-opening dialogs and tuning emission | Grab a vertex and move it; drag an edge; the shape IS the control |
| **A separate tool silo** — Map Points was its own subsystem, disconnected from everything | One authoring surface shared with the brush (§4) — vectors and paint are tools, not separate apps |
| **Machinery over intent** — 7,480 lines of clustering/sampling for "there is fire here" | Intent is the shape; the effect reads the shape; no sampling machinery |
| **Grid-fighting** — points landed where the tooling let them, not where you meant | Precision-first: no snap unless you ask (§4) |

**What V2 got RIGHT (keep):** scene-flag persistence (it travelled with the scene), the group→effect mapping concept, and per-floor binding. Those survive; the machinery does not.

---

## 2. THE PRIMITIVES — one model, three shapes

Every shape is a list of vertices in **precise world coordinates** (Foundry canvas space, +Y down — the painter's exact coordinate model, so screen→world is already solved and snap-free).

| Primitive | Is | Drives (examples) | Becomes |
|---|---|---|---|
| **Point** | one vertex | a candle flame, a single lightning strike, one emitter | a **placement** (discrete anchor) |
| **Line** | ≥2 vertices, open | a rope, a wall of flame, a stream, a light strip | a **placement path** (emitter along it) OR a stroked mask (a thick line rasterized) |
| **Polygon** | ≥3 vertices, closed (+ optional holes) | a pond, a fire zone, a fog pocket, a greenhouse | a **filled mask** (rasterized into the grid) |

### The unification that makes this cheap: a polygon IS a painted mask

**A filled polygon rasterizes into the SAME `MaskGrid` a brush paints** (`scene/paint-mask.js`) — so a precise polygon edge and a brushstroke are two ways to author *the same mask*, served by the same **mask authority** (`Authoring-and-Distribution.md` — one authority for areas). You can rough-in a fire zone with the polygon tool and soften its edge with the spray brush, on one layer, because they are the same data underneath. This is the payoff of building the painter first.

- **Areas (polygons, stroked lines)** → rasterize into the mask authority. One authority.
- **Discrete (points, emitter-path lines)** → a **placements registry** (scene flags) — the honest successor to V2's map points, for things that are genuinely not masks.

---

## 3. THE TWO CHANNELS, IN DETAIL

### 3A. Channel A — the `Map Shine Advanced Map Group` Region behavior

**Mechanism (confirmed against v14 source, not guessed):** a custom `RegionBehaviorType` subclass registered in `CONFIG.RegionBehavior.dataModels['map-shine-advanced.mapGroup']` — structurally identical to Foundry's own `adjustDarknessLevel` behavior (`client/data/region-behaviors/adjust-darkness-level.mjs`). Its fields declare **which effect(s) the region drives + their params**. The GM draws a region with Foundry's native tool, adds the "Map Shine Advanced Map Group" behavior, picks an effect — done.

**MSA reads the region's shapes** (`rectangle` / `ellipse` / `polygon`, each with a `hole` flag — `client/data/region-shapes/`), exactly as this project **already does live**: `src/foundry/scene-regions.js` reads `region.shapes` + `region.behaviors` and `effects/lighting/region-darkness.js` analytically tests them per-fragment. So Channel A is a *small, proven-shape extension* of an existing reader, not new architecture.

- **Pros:** no MSA drawing UI; the GM's existing muscle memory; the area travels as a Region document (with the MSA behavior) inside an adventure automatically.
- **Cons/limits:** grid-snappy and coarse (Foundry's design); **area-only** — no points, no lines. That is precisely why Channel B exists.

### 3B. Channel B — MSA-native precise vectors

MSA's own editor: place vertices to the exact pixel, **no grid snap by default**, all three primitives. Stored in scene flags (travels in adventures); polygons rasterize into the mask authority; points/lines land in the placements registry. This is the channel that does what the Region tool structurally cannot.

---

## 4. THE UX — the heart of this document

The author asked twice to *improve on V2's UX especially*. The design goal: it should feel like a **modern vector tool** (the pen-tool directness of Illustrator/Figma) tuned for VTT authoring — not a dialog-driven placement system.

### 4.1 ONE authoring surface — vectors and paint are tools, not silos
Paint Mode becomes **Author Mode**: the same full-viewport overlay + board-gated input (`event.target === boardElement`, the fix from the painter) + the same coordinate transforms, with a **tool switcher**:

```
[ Select ]  [ 🖌 Brush ]  [ • Point ]  [ ╱ Line ]  [ ⬠ Polygon ]
```

Switching tools never leaves the map. The brush and the polygon feed the same mask; the point and line feed the placements registry. **No context-switch to a separate "Map Points" application** — that silo was half of V2's awkwardness.

### 4.2 Direct manipulation — the shape IS the control
- **Draw:** click to drop vertices; for a polygon, click back on the first vertex (or Enter) to close; Esc cancels.
- **Edit:** grab any vertex and drag it; drag an **edge** to insert a vertex there; **double-click** a vertex to delete it; drag the shape's interior to move the whole thing; corner **handles** to rotate/scale a selection.
- **No dialogs for geometry.** Editing a shape is editing the shape, live, on the map.

### 4.3 Precision-first — snapping is OPTIONAL and off by default
The explicit ask: *finely pick the exact pixels… without it snapping to grid points.* So:
- **Default: no snapping.** A vertex lands exactly where the cursor is (we already map screen→world precisely for the brush).
- **Opt-in snaps**, as toggles + live modifiers: snap-to-grid, snap-to-vertex (this shape's or a neighbour's), snap-to-wall-endpoint, and **angle-lock** (hold Shift → constrain the segment to 15° steps). Each is a choice, never a default that fights you.

### 4.4 Live preview
The shape draws as you place it; a filled polygon shows its **rasterized mask** (in the mask's preview tint, reusing the painter's preview) as it closes; when the bound effect exists, the effect itself previews. You see the result, not an abstraction.

### 4.5 Selection, editing, and safety
- Click to select a shape; marquee to multi-select; handles appear on selection.
- **Delete / duplicate / nudge** (arrow keys) a selection.
- **Undo is shared with the brush** — one history for the whole authoring session (Ctrl+Z steps back through paint strokes *and* shape edits alike).

### 4.6 Always-visible controls (the painter's legend pattern)
The keycap-chip legend the painter got stays: the active tool's gestures and shortcuts are shown on-screen the whole time (`LMB` add point · `RMB` pan · `Enter` close · `Esc` cancel · `Shift` angle-lock · `Del` delete · `Ctrl+Z` undo). Never a hidden shortcut you have to remember.

### 4.7 Binding to an effect
A shape (or a whole Map Group) is bound to an effect via a small panel that reuses `Effects-UI.md`'s generated-control patterns: pick the effect from the catalog, set its params. This replaces V2's emission-sampling machinery with one declarative binding.

---

## 5. THE DATA MODEL — the `Map Group` unifies everything

```
MapGroup {
  id, name,
  members: [                         // shapes from EITHER channel
    { source: 'native', shape: { type:'polygon'|'line'|'point', vertices:[...], holes?:[...], fill:'area'|'stroke'|'path' } }
    { source: 'region', regionId }   // a Foundry Region tagged with the MSA behavior
  ],
  effect: { id, params },            // what this group drives (Effects-UI binding)
  floors: [...]                      // per-floor binding (V2 kept this; it was right)
}
```

A `Map Group` is the direct successor to V2's "map point group" — a **named collection of shapes bound to an effect** — but its members can be precise native vectors *or* Foundry regions, in one group, driving one effect. That is how the two channels reconcile: not two parallel systems, but two *sources* under one abstraction the author already named.

**Persistence & distribution (reuses `Authoring-and-Distribution.md` wholesale):**
- **Native shapes + Map Groups** → `scene.flags` (sibling of `paintedMasks`) → travel in an adventure automatically.
- **Region-sourced members** → the Region document itself (with its MSA behavior) → travels automatically.
- **Filled areas** → the mask authority (rasterized), same as paint.
- The **self-containment doctrine** and the **package-readiness gate** (`Authoring-and-Distribution.md` §4.3–4.4) already cover this — a Map Group is just more authored state that must live in `(scene document + files beside the map)`.

---

## 6. ARCHITECTURE — it fits the doctrine, and it's mostly built already

**Reused, already built:** the authoring overlay + board-gating + coordinate transforms (the painter); the `MaskGrid` + mask authority (areas); scene-flag persistence; the region reader (`scene-regions.js`); the effect-binding UI patterns (`Effects-UI.md`).

**New pure core (Node-testable — the load-bearing half, per this project's discipline):**
- The shape model + hit-testing: point-in-polygon, nearest-vertex, nearest-edge, segment-intersection. Pure geometry, one right answer each (`feedback_probed_constants_vs_derived` — derive, don't probe).
- **Rasterize-polygon-to-grid**: a scanline fill into the same `MaskGrid` the brush writes (with the same anti-Y-flip cross-check the brush has — paint a polygon, sample it through the authority's own reader, prove they agree).
- Snapping math (grid/vertex/angle), each a pure function.

**New browser glue (verified live):** the tool switcher, vertex handles, drag interactions.

**New Foundry adapter:** register the `mapGroup` RegionBehaviorType; extend `scene-regions.js` to read `mapGroup` behaviors (its darkness reader is the template).

**Walls / tripwires (candidates):** filled areas rasterize **only** through the mask authority (one authority); shape/group state written **only** through the placements/group owner (no V2 map-points god-object — that was 7,480 lines of exactly this disease); no grid-snap-as-a-default.

---

## 7. ROADMAP & TIERS

Sits in the **authoring layer** (`Roadmap-to-Parity.md` §3 step 3 — before/with the effect families; you author the shape an effect consumes), alongside the painter.

- **Tier 0 — the polygon, because it proves the unification.** The polygon tool → rasterize into the mask authority → save → reload. Draw a *precise* fire zone, watch it become the same mask a brush paints, persisted. One tool, end-to-end, and it validates the whole "areas are one authority" claim on real geometry.
- **Then:** points + lines → the placements registry; Channel A (the `Map Group` RegionBehaviorType + reader); the effect-binding panel; snapping options; the `Map Group` abstraction spanning both sources.
- **Later polish:** bezier/smooth segments; boolean ops on polygons (union/subtract — holes are already in the model); shape libraries/stamps.

---

## 8. OPEN QUESTIONS — decisions for the author

1. **Lines:** a line as an *emitter path* (fire runs along it) vs a *stroked mask* (a thick painted line) — support both via a per-line `fill` mode, or pick one for tier 0?
2. **Map Group scope:** does a group bind ONE effect (simpler) or can it drive several? V2 was one-per-group.
3. **Snapping defaults:** confirmed off — but which snaps ship first (grid, vertex, wall-endpoint, angle-lock), and which key toggles each?
4. **Region ↔ native precedence:** if a Map Group has both a native polygon and a Foundry region for the same area, do they union, or is that just author error to warn on?
5. **Curves:** straight segments only for tier 0, or bezier handles from the start? (Straight-first is the cheaper, testable path.)

---

*V2 made you place points and tune emission machinery to say "fire is here." MSA lets you draw exactly where it is — to the pixel when it matters, with Foundry's own tool when it doesn't — and a polygon you draw is the very same mask a brush would paint.*
