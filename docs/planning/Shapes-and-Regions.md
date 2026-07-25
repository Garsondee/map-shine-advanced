# SHAPES & REGIONS — points, lines, polygons, and Map Groups

**Status:** DESIGN SPEC, authored 2026-07-20 from an author directive. The vector half of the Map Points successor — precise points/lines/polygons, plus a Foundry-Region bridge — the sibling of the paint half already building in `Authoring-and-Distribution.md`.
**Audience:** the author, and a fresh session. Read `Authoring-and-Distribution.md` (the paint tool + mask-authority + persistence model this reuses wholesale) and `keyhole-input-model-decision` / `keyhole-interface-seam` first.
**Companions:** `Authoring-and-Distribution.md` (painting; the shared mask authority + scene-flag persistence + self-containment doctrine), `Effects-UI.md` (the effect-binding UI patterns), `docs/reference/v2-effect-params/` (what the point-driven effects did).

---

## 0. THE ASK, AND THE TWO-CHANNEL ANSWER

The painter handles _areas you fill_. It does not handle a single candle, a rope between two points, a stream, or a precisely-bounded pond edge. Those want **vectors: points, lines, polygons.** The author's decision (2026-07-20), and it is the right one:

> **Two complementary channels, each used for what it is actually good at — never one pretending to be the other.**

| Channel                                                          | What it is                                                                                                                    | Good at                                                                                                                | Weak at                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **A — Foundry Region** (`Map Shine Advanced Map Group` behavior) | A custom Region _behavior type_ MSA registers; the GM draws with Foundry's **native Region tool** and tags the region for MSA | Whole grid-spaces affected by something; zero MSA UI to build; GMs already know the tool; travels as a Region document | **Imprecise by design** — grid-snappy, coarse; area-only (no points, no lines) |
| **B — MSA-native vectors**                                       | MSA's own point/line/polygon editor, vertices placed to the **exact pixel, no grid snapping**                                 | Precision; points and lines Foundry can't express; fine polygon edges                                                  | It's UI we build and maintain                                                  |

**Neither alone is enough.** Use Channel A when "this whole room is a greenhouse" is precise enough and you'd rather not fuss. Use Channel B when the shape has to sit exactly where you mean it, or when it's a point or a line. **A single `Map Group` (the author's name) can draw shapes from both** — that is the unifying abstraction (§5).

---

## 1. WHAT V2'S MAP POINTS WAS — and the UX we must beat

**8 files, 7,480 lines** to place discrete `{x,y}` points that spawn an effect (`legacy/scene/map-points-manager.js`: fire/candle/dust/flies/lightning/water…), with emission-sampling, wall-clustering, control-clusters, and level-binding machinery on top, persisted to `scene.flags.mapPointGroups`. Author's verdict: _"clunky, slow, inorganic, awkward."_

**The UX failures to design against — named so we don't repeat them:**

| V2 failure                                                                                | The fix here                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Placement-only** — you dropped points; you couldn't _draw_ a line or a shape            | Real point/line/polygon primitives with direct drawing                                            |
| **No direct manipulation** — editing a point meant re-opening dialogs and tuning emission | Grab a vertex and move it; drag an edge; the shape IS the control                                 |
| **A separate tool silo** — Map Points was its own subsystem, disconnected from everything | One authoring surface shared with the brush (§4) — vectors and paint are tools, not separate apps |
| **Machinery over intent** — 7,480 lines of clustering/sampling for "there is fire here"   | Intent is the shape; the effect reads the shape; no sampling machinery                            |
| **Grid-fighting** — points landed where the tooling let them, not where you meant         | Precision-first: no snap unless you ask (§4)                                                      |

**What V2 got RIGHT (keep):** scene-flag persistence (it travelled with the scene), the group→effect mapping concept, and per-floor binding. Those survive; the machinery does not.

---

## 2. THE PRIMITIVES — one model, three shapes

Every shape is a list of vertices in **precise world coordinates** (Foundry canvas space, +Y down — the painter's exact coordinate model, so screen→world is already solved and snap-free).

| Primitive   | Is                                     | Drives (examples)                                                 | Rasterizes to                                                                                                                    |
| ----------- | -------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Point**   | one vertex                             | a fire spot, a candle flame, a lightning strike                   | a **dab** in the mask — or its raw position, for a placement effect                                                              |
| **Line**    | ≥2 vertices, open, with a **width**    | a wall of fire across a corridor, a stream, a light strip, a rope | a **stroked mask** (rasterized at its width — identical to painting that line) — or its raw path, for a placement/physics effect |
| **Polygon** | ≥3 vertices, closed (+ optional holes) | a pond, a fire zone, a fog pocket, a greenhouse                   | a **filled mask** — or its raw outline, for a placement effect                                                                   |

### The unification (author-confirmed 2026-07-20): draw it or paint it — same mask

**Every shape rasterizes into the SAME `MaskGrid` a brush paints** (`scene/paint-mask.js`), served by the same **mask authority**. The author's own worked test: to block a corridor with fire you can **draw a line across it OR paint a line across it — either way you get fire across the whole thing**, because both just land in the `_Fire` mask. A polygon is a filled region; a line is a stroked region carrying a width (exactly like a brush); a point is a dab. Vectors and paint are two ways to author one mask — you can block in a fire zone with the polygon tool and soften its edge with the spray brush, on one layer, because underneath they are the same data. This is the payoff of having built the painter first.

- **Coverage is the default and the common case** (fire, water, fog, dust, outdoors): the effect reads/emits wherever the mask is set, so _how_ it got set — brush, line, or polygon — is invisible to it. There is **no separate "emitter path" concept**; a line of fire is just fire-mask along a stroke.
- **The raw vector geometry is ALSO retained** in the shape's scene-flag record, for the minority of effects that want a discrete _placement_ rather than coverage — a candle billboard at a point, a rope's physics along a line, a lightning arc between two vertices. Those read the shape's vertices, not the mask. **One shape store; two ways to consume it** — no separate placements registry to keep in sync.

---

## 3. THE TWO CHANNELS, IN DETAIL

### 3A. Channel A — the `Map Shine Advanced Map Group` Region behavior

**Mechanism (confirmed against v14 source, not guessed):** a custom `RegionBehaviorType` subclass registered in `CONFIG.RegionBehavior.dataModels['map-shine-advanced.mapGroup']` — structurally identical to Foundry's own `adjustDarknessLevel` behavior (`client/data/region-behaviors/adjust-darkness-level.mjs`). Its fields declare **which effect(s) the region drives + their params**. The GM draws a region with Foundry's native tool, adds the "Map Shine Advanced Map Group" behavior, picks an effect — done.

**MSA reads the region's shapes** (`rectangle` / `ellipse` / `polygon`, each with a `hole` flag — `client/data/region-shapes/`), exactly as this project **already does live**: `src/foundry/scene-regions.js` reads `region.shapes` + `region.behaviors` and `effects/lighting/region-darkness.js` analytically tests them per-fragment. So Channel A is a _small, proven-shape extension_ of an existing reader, not new architecture.

- **Pros:** no MSA drawing UI; the GM's existing muscle memory; the area travels as a Region document (with the MSA behavior) inside an adventure automatically.
- **Cons/limits:** grid-snappy and coarse (Foundry's design); **area-only** — no points, no lines. That is precisely why Channel B exists.

### 3B. Channel B — MSA-native precise vectors

MSA's own editor: place vertices to the exact pixel, **no grid snap by default**, all three primitives. Stored in scene flags (travels in adventures); polygons rasterize into the mask authority; points/lines land in the placements registry. This is the channel that does what the Region tool structurally cannot.

---

## 4. THE UX — the heart of this document

The author asked twice to _improve on V2's UX especially_. The design goal: it should feel like a **modern vector tool** (the pen-tool directness of Illustrator/Figma) tuned for VTT authoring — not a dialog-driven placement system.

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

The explicit ask: _finely pick the exact pixels… without it snapping to grid points._ So:

- **Default: no snapping.** A vertex lands exactly where the cursor is (we already map screen→world precisely for the brush).
- **Snap-to-grid, when ON, snaps to a 4×4 SUB-grid** (author decision, 2026-07-20): each grid square is subdivided into a 4×4 lattice — **quarter-cell spacing, 16 snap points per cell** — so snap mode keeps edges aligned while still giving fine freedom, instead of the blunt whole-intersection snap that makes Foundry's own region tool feel imprecise. Quarter-cell is the shipped subdivision (a chosen number, not derived from anything).
- **Additional opt-in snaps**, as toggles + live modifiers: snap-to-vertex (this shape's or a neighbour's), snap-to-wall-endpoint, and **angle-lock** (hold Shift → constrain the segment to fixed angle steps). Each is a choice, never a default that fights you.

### 4.4 Live preview

The shape draws as you place it; a filled polygon shows its **rasterized mask** (in the mask's preview tint, reusing the painter's preview) as it closes; when the bound effect exists, the effect itself previews. You see the result, not an abstraction.

### 4.5 Selection, editing, and safety

- Click to select a shape; marquee to multi-select; handles appear on selection.
- **Delete / duplicate / nudge** (arrow keys) a selection.
- **Undo is shared with the brush** — one history for the whole authoring session (Ctrl+Z steps back through paint strokes _and_ shape edits alike).

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
    { source: 'native', shape: {
        type: 'polygon'|'line'|'point',
        vertices: [...],             // exact world coords — no snap baked in, straight segments only
        holes?: [...],               // polygon only
        width?: number,              // line only — its stroked thickness (like a brush size)
    } }
    { source: 'region', regionId }   // a Foundry Region tagged with the MSA behavior
  ],
  effect: { id, params },            // what this group drives (Effects-UI binding)
  floors: [...]                      // per-floor binding (V2 kept this; it was right)
}
```

A `Map Group` is the direct successor to V2's "map point group" — a **named collection of shapes bound to an effect** — but its members can be precise native vectors _or_ Foundry regions, in one group, driving one effect. That is how the two channels reconcile: not two parallel systems, but two _sources_ under one abstraction the author already named.

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

- **Tier 0 — the polygon, because it proves the unification.** The polygon tool → rasterize into the mask authority → save → reload. Draw a _precise_ fire zone, watch it become the same mask a brush paints, persisted. One tool, end-to-end, and it validates the whole "areas are one authority" claim on real geometry.
- **Then:** points + lines → the placements registry; Channel A (the `Map Group` RegionBehaviorType + reader); the effect-binding panel; snapping options; the `Map Group` abstraction spanning both sources.
- **Later polish:** boolean ops on polygons (union/subtract — holes are already in the model); shape libraries/stamps. **Curves are deliberately NOT planned** — a curve is authored as a fine polygon with snapping off (§8), so there is no bezier machinery to build.

---

## 8. DECISIONS — resolved, and still open

**Resolved by the author (2026-07-20):**

1. **Lines = stroked masks.** A line carries a width and rasterizes into the mask exactly like a painted line — _"draw a line of fire OR paint a line of fire, either way fire across the whole thing."_ No separate emitter-path type; the raw path stays retained for the rare placement/physics effect (rope). (§2)
2. **Snap-to-grid = a 4×4 sub-grid** (quarter-cell, 16 points/cell), off by default. (§4.3)
3. **Straight segments only.** No bezier/curves — a curve is authored as a fine polygon with snapping off. (§7)

**Still open (decide when we build the effect binding, not before):** 4. **Map Group scope:** does a group bind ONE effect (simpler; V2 was one-per-group) or several? Leaning one-per-group. 5. **Region ↔ native precedence:** if a Map Group has both a native polygon and a Foundry region over the same area, do they union (likely — both just add mask coverage) or is overlap an author-error to warn on?

---

_V2 made you place points and tune emission machinery to say "fire is here." MSA lets you draw exactly where it is — to the pixel when it matters, with Foundry's own tool when it doesn't — and a polygon you draw is the very same mask a brush would paint._
