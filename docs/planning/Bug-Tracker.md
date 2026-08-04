# Bug Tracker — author-reported, live

The author's running list of defects found **on a real scene, with their own eyes**.
This file is the register of record for "what is currently wrong". It is not a
session log and not a design doc — each entry links out to the design doc that
owns the subsystem.

## Status vocabulary

Two words, never one (see `MEMORY.md`):

| Status | Means |
| --- | --- |
| `OPEN` | Reported, not fixed. |
| `BUILT (unverified)` | Code changed, tests green, **nobody has seen it work**. |
| `LIVE` | The author looked at a real scene and confirmed it. Only they can promote to this. |
| `CLOSED` | Confirmed fixed and unlikely to regress. Keep the entry — regressions rhyme. |

**Rule:** I never promote an entry past `BUILT (unverified)`. The author does that.

## Diagnosis discipline

Every "Likely cause" below is tagged. `⚠ HYPOTHESIS` means **I have not proven it
against the code** — it is a starting point for an investigation, not a finding.
Per the named bug class *"🧟 A PLAUSIBLE DIAGNOSIS ROTS"*, an unverified theory that
sits in a doc long enough starts getting treated as fact. Check the tag before
building on any of this.

---

## Index

| # | Bug | Subsystem | Status |
| --- | --- | --- | --- |
| 1 | Tile/scene image path changes don't re-ingest | ingest / compression | `OPEN` |
| 2 | Tiles render over `_Bush` / `_Tree` regardless of elevation | vegetation sort | `LIVE` ✅ |
| 3 | No wind shadow; wind doesn't route around obstacles | wind | `BUILT (unverified)` — shadow only |
| 4 | Vegetation liquifies at high wind | vegetation flutter | `BUILT (unverified)` |
| 5 | Candles vanish when viewed from the floor above | candles / anchors | `BUILT (unverified)` |

---

## 1. Changing a tile's graphic path doesn't update its visuals

**Status:** `OPEN` · **Reported:** 2026-08-01 · **Docs:** `Keyhole.md`, `Authoring-and-Distribution.md`

### Symptom

Changing a tile's texture path leaves the old image on screen. A full Foundry
refresh is the only way to see the new art — so tiles can't be iterated on
during a session.

### Scope (all three parts must land)

1. **Tile texture path change** → re-ingest and redraw immediately.
2. **New graphics loaded mid-session** → must go through BC1/BC7 compression,
   not get served uncompressed or not at all.
3. **Scene `background` / `foreground` images** added or changed → same
   noticed → compressed → updated path, immediately.

Part 3 is separately worth checking because scene-level images travel a
different route than tiles.

### Grounding

- `src/boot.js:5528` — `redrawOn(hook)` registers `create`/`update`/`delete`
  for every entry in `DRAW_LIST_DOCUMENTS`, so **the hook almost certainly does
  fire** on a tile update. The gap is downstream of the hook, not the hook
  itself.
- `src/boot.js:5560` — the comment states a redundant refresh is free because
  *"refreshItemPlacement compares a placementKey and returns false when nothing
  moved"*.
- `src/boot.js:5507` — `refreshMaskAuthorityItems` handles the scene-layer
  documents separately, gated on `MASK_AUTHORITY_HOOKS`.

### Likely cause — ⚠ HYPOTHESIS, not checked against code

`placementKey` is built from **geometry** (position / size / sort / elevation)
and does **not** include the texture path. Changing only the path therefore
reads as "nothing moved", the early-return fires, and no re-ingest is ever
requested. This would explain the symptom exactly — the redraw runs, decides
it's a no-op, and returns.

**First thing to check:** find where `placementKey` is built and see whether the
texture path is a component of it.

Second, unrelated thing to confirm: whether `Scene` is actually a member of
`DRAW_LIST_DOCUMENTS` at all, which decides whether part 3 has *any* hook
coverage today.

### Related known bug class

*"✅🗄️ A URL-KEYED CACHE NEEDS A CONTENT VALIDATOR"* — a same-name re-upload with
different bytes served the old encode forever. **Not the same bug** (here the
path itself changes, so a URL-keyed cache should miss cleanly) but the same
neighbourhood, and part 2 of this scope will run straight into it.

### Fixed when

Author changes a tile's path, a scene background, and a scene foreground on a
live scene and each updates on screen without a Foundry refresh — with the new
art compressed, not raw.

---

## 2. Tiles render over `_Bush` / `_Tree` vegetation regardless of elevation

**Status:** `LIVE` ✅ — author-confirmed 2026-08-01: *"Trees and bushes now render
above tiles. Good work."* · **Reported:** 2026-08-01 · **Docs:** `Vegetation.md`

> The confirmed half is the reported symptom (low tiles no longer cover
> vegetation). The *other* half of the model — a tile at the floor top going
> back OVER a tree — was not separately called out as checked. Unit-tested, and
> worth an eye next time someone is on a multi-elevation floor.

### Symptom

A tile at **elevation 0, sort 1** draws on top of `_Bush` and `_Tree`
vegetation effects. There is currently no elevation at which a tile can be
placed *underneath* vegetation.

### Grounding — this one is confirmed, not a hypothesis

`src/effects/vegetation.js:68` documents `renderOrderNudge` as *"added to the
owning item's own `renderOrder`"*, and the two kinds set it at
`src/effects/vegetation.js:95` (`tree: 0.6`) and `:105` (`bush: 0.5`).

So vegetation's draw order is **host renderOrder + 0.5/0.6**. A separate tile
that sorts above the vegetation's host item beats it by a whole integer step,
and a sub-1.0 nudge can never claw that back. The behaviour is structural, not
a tuning miss.

### Author's proposed fix

Give vegetation a **passive elevation at the midpoint of its floor's range**:
for a floor with `bottom = 0`, `top = 20`, `_Bush` sits at elevation 10. Then a
tile at elevation 9 renders under the bush; a tile at 10 renders over it,
because it ties on elevation and wins on priority. Natural, authorable, no
per-tile fiddling.

### Decisions — RULED BY THE AUTHOR 2026-08-01, do not relitigate

**(a) Vegetation is an explicit, sanctioned exception** to the CLOSED bug class
*"✅🎯➡️🎯 EFFECT RENDER ORDER MUST BE HOST-RELATIVE"*. Author's words: *"vegetation
is a good exception so let's make an exception for it."*

The reasoning that justifies it: specular-on-a-tile is a **surface property** of
its host and must follow it; a tree canopy is a **world object with its own
height** that merely happens to be painted onto a host. The doctrine still
stands for every other effect — this is a carve-out, not a repeal.

**(b) Tree sits at the floor top; bush at the midpoint.** Author: *"trees sit at
the floor top −1 so that a tile on a floor can be above trees but only by being
at the top of that floor."*

⚠️ **Reconciliation, recorded so nobody "fixes" it later.** "Tree at top − 1" and
"a tile at 10 ties with the bush and *wins*" use **opposite tie-break
conventions** and cannot both be encoded literally. The stated *outcomes*,
however, are fully consistent and unambiguous, so those are what shipped:

| tile elevation | vs bush (floor 0–20) | vs tree |
| --- | --- | --- |
| 9 | under | under |
| 10 | **over** | under |
| 19 | over | under |
| 20 | over | **over** |

Encoded as: vegetation sorts at `SORT_LAYERS.SCENE_EFFECTS` (250), which is
below `TILES` (500), so a tie on elevation always goes to the tile. Tree's
fraction is therefore `1.0` (the floor top) rather than a literal `top − 1` —
`top − 1` plus tile-wins-ties would have put a tile at 19 *over* the tree,
contradicting the author's own worked example.

### What was built — 2026-08-01

Vegetation overlays now sort at their **own** elevation through THE law
(`scene/layer-order.js`), instead of `host.renderOrder + nudge`.

- `passiveElevationFraction` added to each kind in
  [vegetation.js](../../src/effects/vegetation.js) — tree `1.0`, bush `0.5`.
- `vegetationPassiveElevation()` + `vegetationOverlayRenderOrder()` in
  [vegetation-render.js](../../src/effects/vegetation-render.js) — pure,
  Node-tested. The second asks the **real comparator** where the overlay's key
  belongs in the already-sorted list: if `n` drawables sort below it, it takes
  `n − 0.5`. No band, no capacity, no second ordering scheme to drift.
- `stampVegetationRenderOrders()` in
  [vt-pan-viewer.js](../../src/vt/vt-pan-viewer.js) runs once per draw-list
  rebuild, right after `sortByLayer`. Solved once per (floor, kind) pair, not
  per item, so a big scene doesn't go quadratic.

**Deliberately NOT changed:**

- **The vegetation shadow stays on the ground** (`VEG_SHADOW_RENDER_ORDER_
  MAGNITUDE`, just above the host). A canopy floats to canopy height; the shadow
  it casts belongs on the floor. Moving both would have lifted the shadow off
  the ground with it.
- **Case 1 (a tile whose own texture is the vegetation) is untouched.** That
  tile has its own author-set elevation already — the author controls it
  directly, and overriding it would be surprising.

### Known consequence to eyeball on the live check

A tree now sits at its floor's **top**, and `SCENE_EFFECTS` (250) is above
`SCENE` (0) — so **a tree draws over that floor's foreground/roof art**, where
before it sat far below it. That may well be desirable (overhanging canopy). If
it isn't, roof art on a *tile* at the floor top (`TILES` 500) beats the canopy.

### The escape hatch — a floor with no declared band

`elevation.top` is `+Infinity` for any Level with no declared ceiling (Foundry's
own normalisation, and what the synthetic single-floor fallback gets). There is
no meaningful midpoint of an unbounded band, so those floors **keep the old
host-relative behaviour** and the viewer logs a warning naming them. An author
seeing "tiles still draw over my bushes" should check that warning first — the
fix needs a bottom/top on the Level.

### Fixed when

On a live scene with a 0–20 floor: a tile at elevation 9 sits under the bush, a
tile at 10 sits over it, and trees still draw above bushes.

### Follow-up — 2026-08-04: the sparse-floor tie (a gap the live test above didn't cover)

**Status of this specific gap:** `BUILT (unverified)` — code changed, `npm run
verify` green (7230 tests), **not yet re-confirmed live.** The 2026-08-01 LIVE
confirmation above still stands for what it actually tested (tiles vs.
vegetation, with real drawables sitting between them); this is a narrower case
that test never exercised.

**Report:** a screenshot showing a `_Bush` overlay fully covering canopy that
should read as `_Tree` above it — *"Currently the _Bush effect renders above
the _Tree effect."*

**Root cause — confirmed against the code, not a hypothesis.**
`vegetationOverlayRenderOrder` (`vegetation-render.js`) places a kind by
counting how many REAL (non-vegetation) drawables sort below its computed
elevation, then landing at the exact midpoint of that gap, `below - 0.5`, for
every kind. That count only ever compares a kind against real scene
drawables — it never compares bush's slot against tree's. On a floor where
nothing real sits strictly between bush's elevation (its band's midpoint) and
tree's (its band's top) — **an ordinary floor: background art, a tree, a
bush, nothing else at an in-between elevation** — both kinds count the
identical number of real items below them and land on the identical
`below - 0.5`. Two different meshes with numerically equal `renderOrder` have
no defined winner in this renderer's own model (the entire point of sorting
by the law instead of THREE's incidental tie-break), so whichever painted on
top came down to scene-graph/creation order, not "trees are taller than
bushes". The existing regression fixture never caught this because it always
seeded a tile at elevation 19 — between bush's 10 and tree's 20 in the
author's own 0–20 worked example — which broke the tie by accident; a floor
with nothing between them (the more ordinary case, not the exception) was
never exercised.

**What was built.** `vegetationOverlayRenderOrder` no longer bisects every
kind's gap at a fixed `-0.5`. It places each kind at a fixed point INSIDE the
gap, ordered by that kind's own `passiveElevationFraction` — the same field
that already says tree (1.0) belongs above bush (0.5) — so two kinds sharing
one gap now get two distinct numbers in the correct relative order, margined
away from both edges (`VEG_KIND_SLOT_MARGIN`) so neither can newly collide
with a real drawable either. Kinds that don't share a gap are unaffected —
still separated by whatever real drawables sit between them, exactly as
before.

**The other possible cause — rule this out first if the live check doesn't
change.** This fix only touches **Case 2** (a plain tile with a discovered
sibling `_Tree`/`_Bush` file — the swaying overlay mesh). **Case 1 — a tile
whose OWN art file is `_Tree`/`_Bush`-suffixed — is untouched, by design**
(see "Deliberately NOT changed" above): that tile's `renderOrder` is exactly
its own author-set Foundry elevation/sort, same as any other tile. If the
bush and tree in the screenshot are each their own tile (the PNG alpha IS the
plant, not a mask painted onto a separate background), this fix changes
nothing there — the fix is raising the tree tile's elevation/sort above the
bush tile's in Foundry itself, the same as ordering any two ordinary tiles.

### Fixed when (follow-up)

On an ordinary floor with just background art — no tiles at elevations
between the bush's midpoint and the tree's top — a `_Bush` and `_Tree`
overlay painted so they visually overlap show the tree's canopy on top, every
time, not incidentally.

---

## 3. Wind: no wind shadow, no routing around obstacles

**Status:** `BUILT (unverified)` — **shadow only; routing NOT done** · **Reported:**
2026-08-01 · **Docs:** `Wind.md`, `Wind-Rethink.md`

### What was built — 2026-08-01

`upwindShelter()` in [wind-enclosure.js](../../src/world/wind-enclosure.js) —
**the first directional field in that module.** For every open cell it marches
upwind and reports how close the first solid is, 0..1.

- **Baked, not sampled per frame.** It depends on wind direction, and
  `setWindAmbient` already re-bakes on a direction change (its own comment
  predicted this: *"the bake depends on the SAME direction/speed it was last
  computed from"*). The one input that moves this term was already a rebake
  trigger.
- **Free channel, no new buffer.** It rides in the wall-avoidance texture's
  alpha, which was a constant `1`, unused. No new texture, no new binding, and
  crucially no new storage-buffer slot.
- **Both GPU paths.** `sampleWind` (materials) *and* `kernel()` (the particle +
  gust compute kernels). The second one is why the per-cell storage packing had
  to widen from 1 vec4 to 2 — every original slot was taken. Without it the wind
  diagnostic particles would have flowed straight through every shadow, i.e. the
  author's own instrument would have denied the feature was working.
- Scaled by `WIND_SHADOW_DEPTH` (0.85), not gated to zero — a lee is slack air,
  not a vacuum, and a hard 0 reads as a geometric hole punched in the field.
- The wind probe reports the raw occlusion *and* the shelter factor it becomes.

**A pre-existing node↔kernel parity test caught the first, one-sided version of
this.** That test earned its keep; do not weaken it.

### Still open: routing around obstacles

Deliberately not attempted — the author chose "cheap shadow first". Note that
`wallAvoidanceDirectionFromDistance` + `deflectAroundWalls` already exist and
already deflect the coherent wind away from nearby walls, so "route around
obstacles" may be partly present and mistuned rather than absent. **Check what
those two actually do on a live map before building anything new.**

### Symptom

Indoors vs outdoors behaviour isn't quite right, and two things are missing
outright:

1. **Wind shadows** on the leeward (downwind) side of buildings.
2. **Routing** — the wind vector field should flow *around* obstacles, not
   through or simply stop at them.

### Grounding — confirmed

`src/world/wind-enclosure.js:2-41` documents what the current model actually
is: `openness` is an **isotropic flood-fill** answering *"is this cell connected
to the map's open exterior through open space?"*, seeded from the grid border,
plus a distance-from-open-door falloff.

**There is no direction term anywhere in it.** A leeward shadow is therefore not
mistuned — it is *structurally unrepresentable* in today's model. A cell behind
a building and a cell in front of it are, by construction, given the same
answer.

### The trap — read before proposing a fix

The Wind Rethink (2026-07-22) **deliberately deleted five mechanisms**,
including a potential-flow relaxation and an exposure multiplier. Requesting
"route wind around obstacles" is asking for a flow solve, which is adjacent to
what was just torn out. Do not walk back into it blindly.

**But the distinction matters, and it's favourable:** what made the old model
wrong was that it was seeded from the *painted `_Outdoors` mask* — the author
proved it by deleting every wall and watching wind still die where the painting
went dark. A **geometry-seeded** directional solve is a genuinely different
animal and does not inherit that defect. The lesson was "don't let a painting
decide where wind can be", not "never compute flow".

### Decision — RULED BY THE AUTHOR 2026-08-01

**Cheap directional shadow FIRST**, then reassess. Author: *"cheap shadow
first."* A directional ray-cast shelter term is a far smaller build than a real
flow solve and may buy most of the look; routing around obstacles is a separate,
later decision that this does not commit to.

Whatever lands must be **geometry-seeded**, never seeded from the painted
`_Outdoors` mask — that seeding is the actual defect the Rethink removed.

### Note

Per `MEMORY.md`, wind is *"Mostly NOT live-tested"* — so treat neighbouring wind
behaviour as unverified too while working here.

### Fixed when

Author sees a wind shadow on the downwind side of a building, and sees wind
deflect around an obstacle rather than through it.

---

## 4. Vegetation liquifies at high wind

**Status:** `BUILT (unverified)` · **Reported:** 2026-08-01 · **Docs:** `Vegetation.md`
**Evidence:** author screenshot at 100% wind (attached to the 2026-08-01 report)

### ROOT CAUSE — confirmed, and it was a units mismatch, not a mistuned number

The earlier `⚠ HYPOTHESIS` was right about the mechanism and understated the
cause. Flutter is a domain warp, and the shipped safety cap was
`VEG_FLUTTER_UV_CAP = 0.005` — **a fixed number in UV space, while the noise's
wavelength is set in WORLD space** by `flutterSpaceFreq × flutterScale`. The two
were never coupled, so the real safety margin silently depended on how big the
tile happened to be. On a large canopy tile 0.005 UV is ~17 texels, several
times past the folding threshold.

That is why the previous round of this same complaint (2026-07-23, "alien
blobs") did not close it: that round lowered the *amplitude* dials, which
narrows the window without fixing the units.

**The claim that protected it was also false.** `curlNoise2D` is
divergence-free, and `flutterAmount`'s own help text promised "the distortion
preserves area, so foliage never visibly stretches or thins." Divergence-free is
an INFINITESIMAL property — it says nothing about a finite displacement. Once
the displacement gradient nears 1 the map `x → x + d(x)` stops being injective
and the image folds onto itself. That help text has been corrected.

### What was built — 2026-08-01

- `flutterFoldFreeAmplitudePx()` +`VEG_FLUTTER_FOLD_SAFETY` in
  [vegetation-render.js](../../src/effects/vegetation-render.js) — the cap is
  now **derived from the frequency actually in use** (`A < λ/2π`, with margin),
  so cranking "Flutter frequency" tightens the amplitude automatically. Fold-free
  at every dial setting, not just at the one the default was safe at.
- The shader mirrors it with the live frequency node, and needs the item's world
  size to convert — a new `uUvPerWorldPx` uniform, re-pushed on placement change
  (the material is deliberately not rebuilt on a resize).
- `VEG_FLUTTER_UV_CAP` survives as the absolute backstop, whichever is tighter.
  It is still load-bearing: the coarse-mip foliage gate's "visually lossless"
  proof rests on it, and at the low end of the frequency dial the fold-free
  bound alone resolves to a large fraction of a small tile.
- **Motion rebalanced into sway**, per *"I'd rather we get a lot more sway"*:
  `swayAmount` 14 → 34, `galeBendAmount` 1.0 → 1.8. Not a reversal of the
  2026-07-23 cut — that complaint was about the per-pixel warp, and sway is a
  smooth per-vertex displacement of a tessellated mesh, pinned at the root, that
  cannot fold the texture.

### The test is a CPU twin, not a restatement

Asserting `cap === SAFETY / f` would pass forever including on the day the bound
is wrong. Instead the test builds the warp on the CPU and measures the Jacobian
determinant of `x → x + d(x)` across every frequency the dials can reach,
checking it never goes non-positive — **and separately proves the detector fires
at 10× the cap**, so the check cannot be vacuous.

### Symptom

At 100% wind, trees and bushes stop reading as foliage and turn into flowing
liquid — outlines smear into ribbons, the canopy loses its silhouette, and the
ink linework dissolves into swirls. The screenshot shows a bush whose interior
detail has been stirred into brown/green streaks with no recoverable leaf
structure.

### What the author wants instead

- **Much more bulk sway** from trees and bushes — big, legible motion.
- High-frequency flutter reworked into a method that **preserves mass and
  topology** where possible: leaves should move, not melt.

### Grounding

Per-kind knobs live at `src/effects/vegetation.js:91-109`:

| Kind | `swayMultiplier` | `flutterSpaceFreq` |
| --- | --- | --- |
| tree | 1.3 | 0.035 |
| bush | 0.8 | 0.06 |

`src/effects/vegetation.js:64-67` notes the sway multipliers were carried from
V2's `bulkSway` relationship (`0.029` tree vs `0.013` bush).

### Likely cause — ⚠ HYPOTHESIS, not checked against code

Flutter is a **per-pixel domain warp** (UV displacement by a noise field). That
is fine while displacement stays well below the size of the features being
displaced. Once amplitude approaches or exceeds feature scale, neighbouring
pixels cross over each other, the mapping stops being injective, and the image
shears into exactly the liquid smear in the screenshot. Turning wind to 100%
scales the amplitude past that threshold. This failure mode is characteristic
of domain warping, and the screenshot's swirls match it well.

### Directions worth trying (unranked, not yet evaluated)

- **Split the budget.** Carry most of the motion in low-frequency bulk sway
  (which is topology-safe by construction — it's close to a rigid transform)
  and hard-clamp flutter amplitude below feature scale so it can never
  self-intersect, no matter the wind value.
- **Transform, don't warp.** Move each blob with a rotation/shear about a base
  pivot rather than displacing pixels independently. Mass and topology are
  preserved for free.
- **Scale amplitude to feature size**, so `flutterSpaceFreq` and the amplitude
  cap stay coupled instead of drifting apart at the top of the range.

### Fixed when

Author runs wind to 100% and sees trees and bushes swaying hard while still
looking like trees and bushes — silhouette and linework intact.

---

## 5. Candles vanish when viewed from the floor above

**Status:** `BUILT (unverified)` · **Reported:** 2026-08-01 · **Docs:** `Light-and-Shadow.md`

### ROOT CAUSE — the mechanism existed; nothing author-facing drove it

The earlier `⚠ HYPOTHESIS` (anchors inherit their host item's culling) was
**wrong**. Anchors carry their own `floorBinding` — an elevation band ported
from V2's `LevelBinding` — and `anchorsForEffect(effectId, floorContext)` has
always filtered on it. A V2-imported candle arrives `locked` to its floor's
band, and the viewed floor's elevation (the band MIDPOINT,
`boot.js#updateActiveFloorContext`) leaves that band the moment you go up.

The real gap: `floorBinding` is set by the importer and **the edit UI only ever
reached `params`**, so there was no way for an author to say "this one should be
visible through the stairwell." The light vanished with the flame because
`buildCandleLightSources` reads the same served anchor list — one filter, both
symptoms.

### What was built — 2026-08-01

- `floorVisibility` on the candle anchor kind: `own-floor` (default) /
  `own-and-above` / `all-floors`.
- `floorMatches()` extended — it can only ever WIDEN a locked band, never hide
  something the binding would have shown, so lightning (which declares no such
  param) is byte-identical.
- Widens **upward only** for `own-and-above`: you cannot see a candle on the
  floor above through its own ceiling, and widening downward would have been a
  guess nobody asked for.
- The row is added to `buildCandleEditForm` by hand — that form is laid out
  explicitly, NOT generated from the schema, so a catalog entry alone would have
  been a control that validates, persists and is read by the authority while
  being completely unreachable.

### Why the default stays `own-floor`

The flame draws in its **own scene** (`candleFlameScene`), outside the draw
list's sort law — so a candle shown from another floor is **not occluded by that
floor's artwork**. It would shine through solid stone. Defaulting to anything
wider would trade a missing candle for a candle visible through a floor, on
every existing scene, unasked. This is exactly the author's own framing: *"we put
the onus on getting this right into the user hand rather than complex code."*

### Symptom

Candles attached to a ground-floor element look great from the ground floor.
Move up a floor and — even where there's a **hole in the upper floor** that
should expose them — the candles render neither their light nor their shape.

### Grounding

- `src/effects/candle-flame.js:17-18` — candles are anchors of kind
  `candleFlame`, served by `anchorsForEffect('candleFlame', …)`.
- `src/scene/anchor-catalog.js` — grep for `levelId` / `floorId` /
  `viewedLevelId` / `visibleLevelIds` returns **no matches**. The anchor
  catalog has no concept of floors at all.
- `visibleLevelIds` / `viewedLevelId` live only in `src/boot.js`,
  `src/foundry/scene-layers.js`, `src/foundry/scene-tokens.js`, and
  `src/foundry/paint-adapter.js` — i.e. at the **item** level.

### Likely cause — ⚠ HYPOTHESIS, not checked against code

Anchors inherit their host item's floor culling. When you move up a floor, the
ground-floor host item is culled from the visible set, and its anchors go with
it. Nothing ever asks "should this candle be visible from *here*?" — the
question isn't representable, because the anchor carries no floor data.

### Author's proposed fix — good, and cheap

Mirror how Foundry VTT handles lights: add an **option on the candle** for which
floors it's visible from. Consequences the author called out and I agree with:

- Candles that aren't visible from the current view are **never rendered** —
  a performance win, not just a correctness one.
- It puts the onus on the user to get it right, which **avoids complex code**
  trying to infer hole-visibility geometrically. Inferring "is there a hole
  above this candle" correctly is a hard geometry problem; letting the author
  declare it is a schema field.

Build note: this needs a new field on the anchor schema plus a control in the
candle editing UI. Per the standing rule *"Debug UI: one action = one control"*,
and *"Default new features ON"* — pick a default that keeps existing candles
behaving as they do today on their own floor.

### Fixed when

Author stands on an upper floor, looks through a hole, and sees the ground-floor
candles' light and shape — with a per-candle control deciding which floors see
them.

---

## Changelog

- **2026-08-01** — Tracker created. Bugs 1-5 filed from the author's live report.
- **2026-08-01** — Author ruled on bug 2 (vegetation is a sanctioned exception
  to host-relative render order; tree at floor top, bush at midpoint) and on
  bug 3 (cheap directional shadow first, routing deferred). Bug 2 built and
  `npm run verify` green (6462 tests) — **awaiting the author's live look.**
- **2026-08-01** — Bug 2 **CONFIRMED LIVE** by the author. Bugs 3 (shadow half),
  4 and 5 built; `npm run verify` green (6568 tests). Two diagnoses from the
  original filing were corrected against the code rather than left standing:
  bug 4's cause is a units mismatch (UV cap vs world-space frequency), not
  merely a large amplitude; bug 5's guessed cause (anchors inherit host culling)
  was **wrong** — the floor filter was always there, the control for it was not.
  **All three await the author's live look.**
- **2026-08-04** — Author screenshot: `_Bush` drawing over `_Tree`. Traced to a
  real gap in bug 2's own fix — two vegetation kinds sharing a floor with no
  real drawable between their elevations landed on the identical
  `renderOrder` number (the regression fixture happened to always seed one).
  Fixed in `vegetationOverlayRenderOrder`; `npm run verify` green (7230
  tests). **Awaiting the author's live look** — see bug 2's follow-up section.

---

## 6. `_Specular` has been invisible since the tile-occlusion gate landed

**Status:** `BUILT (unverified)` · **Reported:** 2026-07-29, re-raised 2026-08-01 ·
**Docs:** `Specular.md` §4.5 + §11

### Symptom

The shine worked, then stopped. Nothing visible anywhere metal is painted, and
`strength` at any value — including maximum — changes nothing. That last part is
the diagnostic one: it means a factor of the composite is exactly zero, not that
the effect is too dim.

### What was found (2026-08-01, Shader Lab)

Two separate things, one of which is proven and one of which is not.

**PROVEN — the debug channels were lying, and had been all along.** The debug
material picked a channel with a fold of TSL `select()`s, which compiles to real
WGSL branches; every `.toVar()` in the shared subgraph was assigned in one branch
and read as an unassigned zero in all the others. 12 of 20 channels could only
ever be black. Channel 8's blue — the exact reading three live rounds used to
diagnose this bug — was structurally black regardless of what `buf:scene.attr`
contained. Confirmed by dumping the compiled shader, fixed in
`effects/debug-channel-select.js`, and re-verified channel-by-channel on a real
WebGPU device. **Any conclusion drawn from a specular debug channel before
2026-08-01 is void.**

**NOT PROVEN — the gate's polarity.** `PRESENCE_BIT_BACKGROUND_ART` meant "my
background is still topmost", and `buf:scene.attr` clears to `(0,0,0,0)` — so
"a Tile is on top" and "attr was never written here" were byte-identical and
**both switched the whole effect off**. That is the only candidate whose failure
mode matches the symptom exactly (invisible everywhere, unresponsive to
`strength`). Inverted to `PRESENCE_BIT_OCCLUDES_BACKGROUND` so an unwritten
buffer fails OPEN.

### What would close this

The author looking at a real scene. If the shine is back, the polarity was the
cause. If it is not, channel 8 (floor gate) and channel 20 (attr, raw) now mean
what they say for the first time, and the ladder in `tools/shader-lab`'s
specular bench names which term is zero.
