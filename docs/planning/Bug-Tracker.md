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
| 7 | Vegetation had no real height; its shadow could float above a floor above it | vegetation sort / shadow | `BUILT (unverified)` |
| 8 | Candle flames go transparent/invisible at low elevation | candles / height gate | `LIVE` ✅ — author-confirmed 2026-08-13 |
| 9 | Doors render above overhead tiles (no depth-authority participation) | doors | `OPEN` |
| 10 | Level background/foreground image doesn't refresh after a path change mid-session | ingest / VT viewer lifecycle | `OPEN` — supersedes bug 1's hypothesis |
| 11 | Feature: a scene-wide door-config audit/edit tool | doors / UI | `OPEN` — needs a design call |
| 12 | Loading screen's stall note never expired | UI | `BUILT (unverified)` |
| 13 | Candle vs. a "Restrict Lighting" tile: absolute block instead of elevation-aware, flames don't render, stale flag on toggle | candles / lighting | `OPEN` (layering) — stale-flag half `BUILT (unverified)` |
| 14 | Anchor View Mode showed every candle/lightning icon regardless of floor | candles / lightning / UI | `BUILT (unverified)` |
| 15 | A sun shadow bleeds through an occluding roof on the floor above | sun shadows / layer smear | `OPEN` — needs a live repro to pin the exact item |
| 16 | WebGPU crash: `_Specular` mask on a 12000² map exceeds `maxBufferSize` | specular / renderer limits | `BUILT (unverified)` — immediate fix only, adaptive system still open |
| 17 | Feature: shared sun-brightness ceiling for `_Window` + a moonlight floor for night | window / lighting / design | `OPEN` — design proposal, no code yet |
| 18 | Selecting a token shows a frozen, screen-locked second copy of the map inside explored fog | fog-of-war / art suppression | `BUILT (unverified)` — fix live-tested, author hasn't looked yet |
| 19 | Painted `_Fire` region doesn't register on First Floor even with visible white paint | fire / mask extraction | `OPEN` (root cause) — workaround `BUILT`, live-tested |
| 20 | First Floor runs at ~half Ground floor's framerate — `geometry.depthDraw`/`geometry.earlyZPrepass` cost ~10x more there | depth authority / early-Z | `BUILT (unverified)` — pixel-diff clean, author hasn't looked yet |

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

### CORRECTION — 2026-08-08, checked against the current code: the hypothesis above is wrong

This `placementKey` theory does **not** hold for the current on-disk code, for
either part (tile path or Level background/foreground). Filed in full as **bug
10** below (part 3 — a Level background specifically — is what the author
re-reported live); summary for this entry:

- `Level` **is** a `DRAW_LIST_DOCUMENTS` member (`SCENE_LAYER_DOCUMENTS =
  ['Level', 'Tile']`) and `updateLevel` **does** fire `refreshVtPanViewerItems`
  correctly — the hook reaches the ingest loop every time. (Bare top-level
  `Scene.background`/`Scene.foreground` — the pre-Level-migration fallback —
  genuinely has zero hook coverage, a real but narrower gap than what was
  reported.)
- `placementKey` (confirmed texture-path-free, as guessed) only ever gates
  whether the QUAD GEOMETRY is re-stamped. It is never consulted by whatever
  decides if the TEXTURE reloads — so even a fix that added a src-hash to
  `placementKey` would not have closed this bug on its own.
- The actual gate is one level deeper: `ensureWholeImageMeshes` (`vt/vt-pan-
  viewer.js:7351-7352`) is **idempotent forever** — `if (state.wholeImage)
  return state.wholeImage;` — and never re-reads `item.src` once built. This
  is true for a plain Tile's texture too, not just a Level background; the
  "different route" instinct in this entry's own text was directionally right
  (Level items ARE a separate id-space from Tiles) but the actual blocking
  mechanism turned out to be shared by both.

See bug 10 for the full grounding, the proposed fix (a real "reload on source
change" lifecycle feature — this is not a one-line patch), and open questions.
Leaving the analysis above in place rather than deleting it, per this file's
own discipline: a corrected hypothesis is a finding too.

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

### Follow-up — 2026-08-06: the whole model replaced with a real, unbounded height (see bug 7)

**Status of this specific change:** `BUILT (unverified)`.

The worked-example table above (tile elevation 9/10/19/20 vs bush/tree) and
the "tree at the floor top, bush at the midpoint" model it encodes are now
**historical** — they described a deliberate sort-key CONVENIENCE (a fraction
clamped inside the host's own floor band), never a physical height, and it
was structurally incapable of placing a canopy above its own floor. The
author asked for exactly that capability (bug 7, below): a real tree taller
than a single-story roof. `VegetationKind#passiveElevationFraction` is gone;
a canopy's sort elevation is now `hostFloorBand.bottom + heightFt`, using a
live `treeHeightFt`/`bushHeightFt` param (defaults 25ft/2ft),
**UNCLAMPED** — see `vegetation.js`'s own "HOW A KIND SORTS" section.

**Also fixed in the same pass, a bug this bug's own "Deliberately NOT
changed" section unknowingly left behind:** the vegetation ground-shadow's
render order (`VEG_SHADOW_RENDER_ORDER_MAGNITUDE` added straight to the
host's own `renderOrder`) was EXACTLY the "a sub-1.0 nudge added to a dense
index can never claw back a whole floor's worth of items" bug class this bug
already diagnosed and fixed for the canopy — left unfixed for the shadow on
the reasoning "a canopy floats to canopy height; the shadow it casts belongs
on the floor," which correctly says WHERE (ground level) but doesn't justify
HOW ROBUSTLY the render order gets there. The shadow now goes through the
SAME `vegetationOverlayRenderOrder` comparator the canopy uses, anchored at
`heightFt: 0` (ground level) instead of the canopy's real height. Full
account: bug 7.

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
- **2026-08-06** — Author report: standing on an upper floor, a tree's ground
  shadow rendered above an opaque roof it should have hidden under (the
  canopy already did); no way to set tree/bush height at all. Filed and
  fixed as bug 7 — replaces bug 2's clamped-fraction sort model with a real,
  unbounded `treeHeightFt`/`bushHeightFt` (defaults 25ft/2ft), and routes the
  shadow's render order through the SAME robust comparator the canopy uses
  (previously exempted by bug 2's own "Deliberately NOT changed" section —
  the exact bug class that section's own fix diagnosed, left unfixed one
  door over). Lint/format/tests clean for every file this change touched
  (7732 of 7736 project tests passing — the other 4 failures are a
  concurrent, unrelated `depthOfField` effect mid-build in this same working
  tree, not from this change). `npm run verify:structure` also currently
  fails on that same unrelated effect not yet being wired into `boot.js` —
  pre-existing, not caused by this change. **Awaiting the author's live
  look** — see bug 7 and bug 2's own follow-up section.
- **2026-08-08** — Author filed a batch of 10 new reports in one sitting
  (candle flame elevation transparency, door/overhead depth ordering, a
  background-image reload gap, a door-config tool request, a stale loading-
  screen note, candle-vs-restrict-light layering, anchor-symbol floor
  filtering, a sun-shadow depth-bleed, a WebGPU `maxBufferSize` crash on the
  12K Mansion map, and a sun-brightness/moonlight design ask for `_Window`).
  Investigated all 10 in parallel (read-only agents, source-cited); filed as
  bugs 8-17 below. Four were clear, low-risk fixes built the same session —
  bug 12 (stale stall note), bug 14 (Anchor View Mode floor filtering), bug
  16's immediate crash fix (`maxBufferSize` requiredLimits), and bug 13's
  stale-flag half (a Tile's `restrictsLight` toggle now reaches an
  already-loaded item instead of needing delete+recreate) — `npm run verify`
  green (7725 tests, all touched files linted/formatted clean). The rest
  (bugs 8, 9, 10, 11, 13's layering half, 15, 17) surfaced real architecture
  or product-design forks the author needs to rule on before any code lands
  — see each entry's "Open questions". **All four built fixes await the
  author's live look**, per this file's own rule that only they promote past
  `BUILT (unverified)`.

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

---

## 7. Vegetation had no real height, and its shadow could float above a floor above it

**Status:** `BUILT (unverified)` · **Reported:** 2026-08-06 · **Docs:** `Vegetation.md`,
this file's bug 2 (the render-order model this replaces/extends)

### Symptom, in the author's own words

Standing on an upper floor, looking down at a tree on the floor below, under
an opaque rooftop (the upper floor's own Level background art):

1. The tree's canopy is correctly hidden wherever the roof is opaque (shows
   only through genuine holes) — this part already worked.
2. The tree's ground-contact shadow (the smear decal, unrelated to the sun-
   shadow cascade) rendered **on top of** the opaque roof, where it should
   have been hidden exactly like the canopy.
3. There was **no way to set a tree/bush's height** — the author wanted a
   real height in feet (tree default 25ft — tall enough to clear a single
   story, not two; bush default 2ft — real undergrowth height), globally
   live-adjustable.

### Root cause — confirmed against the code, not a hypothesis

Vegetation had no real, unbounded world-elevation concept. Bug 2's
`VegetationKind#passiveElevationFraction` (tree=1.0/floor top, bush=0.5/floor
midpoint) was a **fraction clamped inside the host's own floor band** — a
sort-key convenience from bug 2, never a physical height. It structurally
could not place a canopy above its own floor, which is symptom 3 exactly.

The shadow's render order
(`VEG_SHADOW_RENDER_ORDER_MAGNITUDE` added straight to the host's own
`renderOrder`) never went through the robust, per-floor-band-anchored
comparator (`vegetationOverlayRenderOrder`) the canopy used — bug 2's own
"Deliberately NOT changed" section left it on a bare host-relative nudge,
exactly the "a sub-1.0 nudge added to a dense index can never claw back a
whole floor's worth of items" bug class bug 2 already diagnosed and fixed
for the canopy. A Case-2 overlay hosted on an ordinary TILE (not a Level
background, which is always pinned to its floor's exact bottom) inherits
whatever raw elevation the map author gave that specific tile — which can
legitimately sit anywhere within its own floor — leaving the shadow's
`host.renderOrder + 0.2` with no real margin against a floor above it.

### What was built — 2026-08-06

- **A real, unbounded canopy elevation**: `vegetationCanopyElevation(band,
  heightFt) = band.bottom + heightFt`, deliberately NOT clamped to
  `band.top` — the whole point (`effects/vegetation-render.js`).
- **Two new live params**, `treeHeightFt` (default 25) / `bushHeightFt`
  (default 2), category `Extent` — a documented, narrow exception to
  vegetation's own "one shared param set" rule, mirroring bug 2's own
  render-order exception (`effects/vegetation.js`).
- **The shadow now uses the SAME robust comparator as the canopy**,
  generalized via a new `opts` param (`heightFt`, `role: 'canopy'|'shadow'`,
  `fallbackNudge`) — anchored at `heightFt: 0` (ground level, independent of
  caster height) with its own `VEG_SLOT_RANK` tiebreak entries so a shadow
  can never out-tiebreak a canopy on a sparse floor.
- **The point-light height/elevation gate** (`buf:scene.attr`'s
  `receiverHeightFt`, renamed from `receiverElevationFraction01`) now reads
  the live height every frame (`syncAllFloorAttrUniformsForFrame`) rather
  than a build-time snapshot — this channel was already fixed once (2026-08-03)
  to never go stale, and the live-param wiring had to preserve that, not
  regress it back to a cached value.
- Global-default-only for this pass (confirmed with the author) — no
  per-item height override yet. A single very tall tree needing to clear a
  two-story building would need the global default raised, or a future
  per-item override.

### Fixed when

On a real multi-floor scene: standing on the upper floor, the tree's shadow
hides under the roof exactly where the canopy already does; dragging "Tree
height" up/down (after a pan/zoom to trigger a residency pass) visibly
changes whether the canopy pokes above a given floor's roofline; a torch near
a tree still correctly treats the canopy as "above" it for the light-height
gate.

---

## 8. Candle flames go transparent/invisible at low elevation

**Status:** `LIVE` ✅ — author-confirmed 2026-08-13: *"Candle flames appear on
the upper floor now so that is a serious improvement."* · **Reported:**
2026-08-08 · **Docs:** `Light-and-Shadow.md`, this file's bug 5

### Symptom, in the author's own words

*"I can't see any candle flames on a map that is a single floor. I noticed
that the candle flames are more transparent the lower their elevation is, so
on my mansion map candles at elevation 14 have visible flames but candles at
elevation 0 have invisible flames."* Single-floor maps are not exempt.

### Root cause — CONFIRMED against the code

`buildCandleFlameMaterial` (`effects/candle-flame-render.js:301-540`)
multiplies the flame sprite's emission by `buildHeightGateNode(...)`
(:520-527) — the ONLY place elevation touches this shader's output (no
distance/fog term exists here; ruled out explicitly). That gate compares the
flame's own per-vertex `flameElevationRank` (baked in
`candle-flame-geometry.js:628-651`) against `buf:scene.attr` sampled at the
flame's screen position.

`flameElevationRank` comes from `resolveAnchorElevationRank`
(`lighting/point-light-pool.js:223-236`), which — unlike its sibling for real
Foundry lights, `resolveLightElevationRank` (:162-174, which treats raw
elevation `0` as "never configured" and returns a sentinel that leaves the
gate always open) — has **no such carve-out**. A candle's "Height off floor"
defaults to `0` and is documented as a legitimate, common value ("right on
the floor", `scene/anchor-catalog.js:109-131`), so most candles on a map get
the *lowest possible* rank on their floor.

`buildHeightGateNode` (`point-light-illumination.js:585-619`) only allows
~1-4 world units of headroom above a rank of 0 (`HEIGHT_GATE_TOLERANCE_UNITS`
= 1, `HEIGHT_GATE_SOFTNESS_UNITS` = 3, at ~1 unit/level per
`vt/scene-attr.js:425-476`) before anything drawn under the flame in
`buf:scene.attr` — a floor tile, a rug, furniture nudged upward for
stacking — outranks and extinguishes it. At elevation 14 the headroom
(~18 units) exceeds the whole quantizer range, so ordinary floor content
can't gate it at all — exactly the reported 0-invisible / 14-visible split.

**This is a known, named deferral, not a fresh bug.** `point-light-
illumination.js:634-671` already documents that this exact `buf:scene.attr`
gate was found unreliable and replaced everywhere else by the depth-
authority-based `buildDepthHeightGateNode`/`buf:scene.depth` — and names
`candle-flame-render.js`/`lightning-render.js` as the one deliberately
not-yet-migrated exception.

### The design call this needs

**(a) Migrate** the candle flame's height gate onto
`buildDepthHeightGateNode`/`buf:scene.depth`, closing the deferral the code
already names as the intended end state — matches [[keyhole-depth-authority-sole-system-decision]].
**(b) Narrower tune**: special-case elevation 0 for this gate specifically —
but elevation 0 is a real, intentional value ("right on the floor"), not an
unconfigured default, so sentinel-ing it away would just quietly disable the
gate for most candles rather than fix the mismatch, and doesn't touch
whatever the *other* elevations (a candle at 3-4 units, say) would still hit.

Before either: a live `buf:scene.attr` pixel probe under one of the author's
actual invisible elevation-0 flames on the Mansion map, to see exactly what
receiver content is triggering the gate there.

### Open questions

- Migrate to the depth-authority gate now (matches locked doctrine, but
  touches a shared TSL material builder + its test suite), or a narrower
  tolerance fix scoped to candles specifically?
- Do the tested candles actually have `floorBinding.mode === 'locked'`
  (imported V2 candles), or could some already be `all-levels`
  (always-sentinel, unaffected) — worth knowing which candles this even hits.
- Is this the same bug as bug 13's symptom 2 (flames invisible under a
  "Restrict Lighting" tile, independent of that tile's flag)? Likely yes —
  both go through the same `flameElevationRank`/height-gate apparatus — but
  unconfirmed; investigate together once a direction is picked.

### Fix — 2026-08-13

**(a) was built**, not (b) — migrated `candle-flame-render.js`/`candle-flame-
geometry.js` onto `buildDepthHeightGateNode`/`buf:scene.depth`, mirroring
lightning's own 2026-08-05 migration exactly: rename `elevationRank`→
`expectedDepth` throughout, swap `attrTexNode`→`depthTexNode`+
`depthFlagsTexNode`, a per-consumer `resolveCandleExpectedDepth` closure in
`vt-pan-viewer.js` (every depth-authority consumer gets its own copy, never a
shared reference). `boot.js`'s dead `resolveAnchorElevationRank` import
removed; the function itself is left in place (nothing else calls it now, but
full removal is separate cleanup). The new gate has no sentinel/tolerance
concept at all — elevation 0 is an ordinary low rank, compared the same bare-
ordinal way as every other elevation — so this closes the 0-vs-14 asymmetry
structurally rather than by special-casing it.

Matches locked depth-authority doctrine and the author's own framing ("we can
get specular to render on both floors — so why not candle"). Bug 13's symptom
2 is very likely resolved as a side effect (the new gate's `flagsHere` param
carries the same tile-restricts-light bit, now elevation-aware instead of an
absolute block) — not independently re-tested against a Restrict-Lighting
tile specifically.

`npm run verify` green (9152 tests). Live-verified in the real Foundry harness
(bench Mansion, both floors): ground floor unregressed, First Floor now shows
flame sprites at anchor positions that previously failed.

### Fixed when

On the Mansion map, an elevation-0 candle's flame is visible exactly as
reliably as one at elevation 14, on a single-floor map with no special setup.
Cross-floor half confirmed live (status line above); the single-floor
elevation-0 case follows from the same mechanism but wasn't independently
re-tested.

---

## 9. Doors render above overhead tiles — no depth-authority participation at all

**Status:** `OPEN` · **Reported:** 2026-08-08 · **Docs:** `Depth-Buffer.md`

### Symptom

*"Door rendering needs a depth buffer pass because currently it renders above
overhead tiles."*

### Root cause — CONFIRMED, and it's architectural, not a wrong number

Doors are **structurally exempt** from occlusion, not mistuned:

1. `foundry/scene-doors.js#deriveDoorSnapshot` (:117-159) never derives an
   elevation or a `LayerKey` for a door — its `levels` field scopes floor
   *visibility* only, never paint order.
2. Door leaves live in their own private `THREE.Scene` (`door-graphics-
   subsystem.js`'s `doorScene`), which is never fed into the `items` list
   [[keyhole-depth-authority-design]] sorts. `depthAuthority.rankOf()` is
   never called for a door anywhere (confirmed: zero references across all
   door files).
3. `door-graphics-render.js#buildDoorMaterial` (:314-332) sets
   `depthTest = false; depthWrite = false` and never samples
   `buf:scene.depth` — contrast `specular-material.js` (:330-381), which
   samples it and discards/fades against `depthAuthority.rankOf(item)`
   exactly the way this bug is asking doors to.
4. Doors paint via a **second, separate** `renderer.render(doorGraphics.scene,
   camera)` call (`vt-pan-viewer.js:3759-3765`, `autoClearColor=false`),
   composited unconditionally on top of whatever the main scene just
   painted — bypassing `scene/layer-order.js`'s sort law entirely, the one
   paint-order mechanism every other drawable (including a Level's
   foreground/roof art) goes through. This second call currently runs
   (`vt-pan-viewer.js:4176`) **before** `runSceneDepthPass()` (:4187)
   refreshes `buf:scene.depth` for the current frame — so even a rank-wired
   door querying depth in place today would read last frame's stale buffer.

**Not a surprise to the codebase** — `door-graphics.js`'s own `deferredRungs`
(:88-91, "roof-occlusion") and `door-graphics-subsystem.js`'s own header
("ORDERING CAVEAT", :27-32) both name this exact gap as known and
deliberately deferred; `door-graphics.test.mjs:57-58` only asserts the rung
is *documented*, not fixed.

### Proposed fix (design decision needed before implementing)

Wire doors through the existing depth-authority API, mirroring specular's
pattern: (1) resolve a real elevation/`LayerKey` per door (the blocked
precondition — a separate "per-floor-elevation" deferred rung is itself
unbuilt); (2) feed each door leaf into `depthAuthority.rebuild()`'s item
list, or at minimum use the no-geometry `depthAuthority.rankOfElevation()`
shape point-light-illumination.js already uses, for a read-only gate;
(3) add a `buf:scene.depth` query + discard/fade to `buildDoorMaterial`'s
fragment node, copying specular's `computeSpecularDepthGate` shape;
(4) reorder `renderDoorGraphicsInto()` to run *after* `runSceneDepthPass()`
within the frame.

### Open questions

- What elevation should a door resolve to — its floor's ground elevation, or
  Foundry's own `DoorMesh` placement convention (`foreground.sort-1`, cited
  in `door-graphics-subsystem.js`'s own header)? Real design decision, not
  plumbing.
- Full depth-pass proxy for doors (so a token standing in a doorway occludes
  correctly against it too — the vegetation Case-2 precedent argues for
  this), or a read-only query (door discards itself, never appears in
  `buf:scene.depth` for others)?
- Keep doors in their own scene + a shader-side depth query, or fold door
  leaves into the main `scene` so ordinary `renderOrder` (stamped by
  `depthAuthority.rebuild`) suffices — the simpler fix the roof-occlusion
  rung's own text originally proposed?

### Fixed when

A door sitting under an overhead/roof tile is hidden by it exactly like any
other drawable at that elevation; a door in the open still draws correctly
relative to everything else.

---

## 10. Level background/foreground image doesn't refresh after a path change mid-session

**Status:** `OPEN` — supersedes bug 1's `placementKey` hypothesis · **Reported:**
2026-08-08 · **Docs:** this file's bug 1 (corrected above)

### Symptom, in the author's own words

*"I have a background image set for a level. It works. I set a new
background image for a level after loading and I think we're not busting the
cache because the image doesn't change."*

### Root cause — CONFIRMED, reading the actual ingest chain end to end

The hook fires correctly — `Level` **is** a `DRAW_LIST_DOCUMENTS` member
(`SCENE_LAYER_DOCUMENTS = ['Level','Tile']`, `foundry/scene-layers.js:439`)
and `updateLevel` reaches `scheduleResidencyUpdate()`
(`vt-pan-viewer.js:12503-12507`), which every pass calls
`ensureWholeImageMeshes(state, item)` unconditionally
(`vt-pan-viewer.js:9404-9409`).

The item id is stable across a path edit (Level background/foreground items
are keyed `level:${level.id}:${which}` — the Level document id + slot, never
`cfg.src` — `scene-layers.js:297-298`), so `ensureItemLoaded`
(`vt-pan-viewer.js:5638-5680`, pre-this-session) takes the "already loaded"
fast path: `existing.item = item; return existing;` — it refreshes the item
*reference* but never re-derives anything from the new `src`.

**The actual gate:** `ensureWholeImageMeshes` (`vt-pan-viewer.js:7351-7352`)
is **idempotent forever** — `if (state.wholeImage) return state.wholeImage;`
— and its own comment (:7388-7398) says so outright. Whatever `item.src` was
current the FIRST time this item's texture was built is what stays uploaded;
every later call short-circuits before ever looking at `item.src` again.
`refreshWholeImageItem`, the only other consumer of a "did this change"
signal, is explicit too (:7718-7720): *"the textures never re-upload."*

**This means bug 1's `placementKey` hypothesis does not hold** for the
current code (see the correction on that entry) — `placementKey` only ever
gates quad geometry, never whether the texture rebuilds, so adding a
src-hash to it alone would not have fixed this. The real gap is one level
deeper and applies to both a plain Tile's texture path AND a Level
background/foreground the same way — there is no code anywhere in
`vt-pan-viewer.js` that compares an item's *current* `src` against the `src`
the loaded texture was actually built from.

**Same shape, same gap, multiple caches:** `requestItemAlphaGrid`'s de-dupe
(`:5727-5734`) is also keyed purely on `item.id`, so the cover-alpha grid
used for shadow/occlusion physics stays pinned to the OLD image too. The
whole per-item ingest pipeline (dims, masks, alpha grid, whole-image
texture) is "load once per id, never revisited."

**Ruled out:** the BC-compress worker's own cache already has a content
validator (ETag/Last-Modified/Content-Length, `bc-compress.worker.js:211-236`)
— moot here anyway, since the code path never gets far enough to re-ask it.

### Proposed fix

Belongs in the ingest layer, not `placementKey`. Give `ensureItemLoaded` a
real "has the source identity changed" check before the fast path — compare
the fresh `item.src` against what was actually built (store `state.loadedSrc`
alongside `state.wholeImage`). On a mismatch: dispose the old GPU resources
(texture/geometry/material, remove meshes from the scene) for every entry in
`wi.tiles`, clear `state.wholeImage = null`, re-run `getSourceDimensions` +
`loadExtraLayerPacks`, and clear this id from `alphaRequested` so the coarse-
alpha grid re-derives too. The load is a fire-and-forget async IIFE
(`wi.loadPromise`) — a rebuild triggered mid-flight needs a generation
counter (or promise cancellation) so an old in-flight load can't stomp the
new one after it resolves late.

This is a small real lifecycle feature (item reload / src-invalidation) —
not a one-line patch, given how many id-keyed "once forever" caches share the
shape and the async-race hazard in tearing one down safely.

### Open questions

- Should the same fix cover vegetation Case-2 overlay siblings
  (`ensureVegetationOverlay`) — likely the same one-time-forever shape, not
  traced yet.
- Is a generation-counter/cancellation guard already used elsewhere in this
  file for a similar rebuild-while-loading race, or would this be the first?
- Does the author want the legacy top-level `Scene.background`/`foreground`
  path (pre-Level-migration scenes, zero hook coverage today — `updateScene`
  is never registered) fixed in the same pass, or tracked separately?

### Fixed when

Changing a Level's background or foreground image path mid-session updates
on screen without a Foundry refresh, same for a plain tile's texture path.

---

## 11. Feature: a scene-wide door-config audit/edit tool

**Status:** `OPEN` — design decision needed, not started · **Reported:** 2026-08-08

### Ask, in the author's own words

*"Every door in my scene has an animation timer. It would be really useful
to have a tool I can access which shows me and allows me to edit the
rendered door config for every door in a scene. This will help me to make
the doors consistent on all maps."*

### What's there today — CONFIRMED

The animation timer and every other rendered-door knob already live natively
on each Wall document's `animation` schema field (type/duration/direction/
strength/double/flip/texture) — Foundry's own data, read (read-only) via
`foundry/scene-doors.js#deriveDoorSnapshot`. `effects/door-graphics.js`'s own
`DOOR_GRAPHICS_PARAMS` is deliberately narrow (just `animateMotion`/
`motionDurationScale`, effect-WIDE knobs for how MSA *plays* the motion) — by
its own comment, a door's per-door animation config is Foundry data, not an
MSA param.

**No writer exists anywhere** — grepped the whole `foundry/` tree; only
Foundry's own `DoorControl#_onMouseDown` writes `wall.document.update(...)`,
never MSA itself. **No UI surface exists either** — no card, no panel; today
there's only a console-only, effect-WIDE tuner (`MapShine.setDoors`,
`boot.js:1585-1603`).

The closest UX precedent, `ui/anchor-mode.js` (click-to-place/edit, multi-
select popup for candles), doesn't map cleanly: it's built around MSA's own
anchor store, and doors are pre-existing Foundry Wall documents scattered
across the scene, not MSA-placed points. Also: `readSceneDoors` silently
drops any wall with `door !== NONE` but no `animation.texture` set — reusing
it as-is for an audit tool would hide exactly the undecorated doors a GM
auditing for consistency would want to catch.

### Proposed shape (needs the author's sign-off before building)

A new small subsystem: (1) a guarded writer,
`canvas.scene.walls.get(wallId)?.document.update({animation: patch})`,
mirroring `camera-path-player.js#writeDarkness01`'s try/catch shape;
(2) a new lister that does NOT drop untextured doors; (3) a UI host — genuinely
open, see below.

### Open questions

- Enumerate every wall with `door !== NONE` (including untextured ones,
  matching the literal "every door" ask), or only what MSA currently renders?
- UI host: a new per-item list card under a `doorGraphics` effect card
  (none exists today), a Lab-zone bulk-editing utility, or an extension of
  `ui/anchor-mode.js`'s map-click flow? None is a clean drop-in.
- The stated goal is CROSS-map consistency, but `Wall.animation` is per-scene
  data with no cross-scene concept today — does this need a "preset" layer
  (save one door's config, batch-apply, re-import into another scene), or is
  per-scene bulk-editing enough for v1?
- Single-door editing to start, or multi-select "edit N at once" from day
  one, given the explicit consistency goal?

### Fixed when

The author can open one tool, see every door in the current scene with its
real animation config, edit one or several at once, and see it take effect
live.

---

## 12. Loading screen's "last step took Xs" note never expired

**Status:** `BUILT (unverified)` · **Reported:** 2026-08-08 · **Docs:** `ui/load-progress.js`

### Symptom

*"There is a thing in the loading screen that says 'last action took...' but
it's fairly useless, it doesn't actually inform the user of anything useful
and might be confusing."*

### Root cause — CONFIRMED

The note (`ui/load-progress.js#describeLoad`, ~:317-322) is a legitimate,
deliberately-designed liveness signal (a CSS spinner keeps animating on the
compositor thread even when the main thread is dead — this note is one of
the two honest signals that can't lie the same way). The bug was staleness,
not meaninglessness: `state.lastStallMs` is written only when a NEW stall
occurs and was never reset, so `describeLoad`'s gate
(`lastStallMs >= STALL_THRESHOLD_MS`) stayed true for the rest of the load
after the very first ≥250ms hitch — freezing that exact sentence on screen
long after the main thread had recovered.

### What was built — 2026-08-08

Added `lastStallAtMs` (the timestamp of the most recent stall) alongside
`lastStallMs`, and gated the note on recency — visible only while
`nowMs - lastStallAtMs` is within `STALL_NOTE_VISIBLE_MS` (3s) of the stall
that triggered it, instead of forever. `worstStallMs` (the post-load summary/
flight-recorder high-water mark) is untouched — that one is correctly
diagnostic, not the live note. Entirely contained in `ui/load-progress.js`
(pure module); new Node tests cover both "still visible just inside the
window" and "gone once it elapses, even though a stall did happen." `npm run
verify` green.

### Open questions

- Exact decay window (3s chosen) is a UX call — flag if the author wants it
  shorter/longer.

### Fixed when

Author loads a scene, sees one hitch's note appear and then disappear a few
seconds later rather than sticking for the whole load.

---

## 13. Candle vs. a "Restrict Lighting" tile: absolute block instead of elevation-aware, flames invisible, stale flag on toggle

**Status:** `OPEN` (the layering question) — the stale-flag half is
`BUILT (unverified)` · **Reported:** 2026-08-08 · **Docs:** `Light-and-Shadow.md`

### Symptom, in the author's own words

*"I set an overhead layer on the ground floor to restrict light. The problem
is that the candles aren't layered on top of the overhead layer even if they
are above it, currently they render behind it. If I remove 'restrict light'
the lighting does go on top but we need the layering to be correct. Either
way the actual candle flames aren't rendering for some reason regardless.
Removing and recreating the tile might fix it so that candles come back but
it's showing signs of instability."*

Three distinct symptoms, investigated separately.

### Symptom 1 (layering) — CONFIRMED, needs a design call before fixing

`vt/scene-attr.js:716`: `const overhead = isInForeground(elevation, {top})
|| (item?.kind === 'tile' && item?.restrictsLight === true);` — the
`restrictsLight` half has **no elevation comparison at all**. ANY tile with
Foundry's "Restrict Lighting" ticked sets the overhead bit unconditionally,
regardless of its own elevation relative to the light querying it. That bit
then hard-blocks BOTH the candle's cast light
(`point-light-illumination.js:585-619` and the newer :634-701, both consumed
by the shared light-pool builder every Foundry/candle/lightning light goes
through) and the flame sprite itself
(`candle-flame-render.js:301-307,520-527`, wired to the same gate). The
code's own comment calls this deliberate: "blocks light through it, full
stop, regardless of what floor band its elevation happens to land in." A
spot-check of vendored Foundry v14 source suggests real Foundry's own
restrict-lighting consumption IS elevation-compared in at least one place,
which is evidence against "elevation-blind by design" — not conclusive,
flagged as worth a deeper trace.

**This is a real behavior-semantics question, not a bug with one right
answer** — any fix changes what "Restrict Lighting" means for every ordinary
Foundry AmbientLight under a roof, not just candles, and needs the author's
call on the intended semantics (does a light directly above a restrict-light
tile always pass through, or only past some elevation gap?) before touching
either gate implementation.

### Symptom 2 (flames invisible regardless of the flag) — NOT explained by symptom 1

Doesn't depend on `restrictsLight` at all, so it isn't this mechanism. Very
likely the same bug as **bug 8** (the general elevation/height-gate issue) —
shares the same `flameElevationRank`/height-gate apparatus — but not
separately confirmed; resolve together once bug 8's direction is picked.

### Symptom 3 (stale flag; the "instability") — CONFIRMED and FIXED

`foundry/scene-layers.js#collectTiles` reads `tile.restrictions.light` fresh
every hook fire, and `updateTile` IS a registered `DRAW_LIST_DOCUMENTS` hook
— so a fresh `item` with the current flag value gets produced correctly. But
for an EXISTING tile id, `ensureItemLoaded` only ever did
`existing.item = item;` — it never touched `state.wholeImage.tiles[]`'s own
`floorAttrItem`, a SEPARATE stored reference to the item, captured once at
material-build time and read fresh every frame by
`syncAllFloorAttrUniformsForFrame`. Since that stored reference itself was
never reassigned, the `restrictsLight` bit baked into it stayed frozen at
whatever it was the first time the tile loaded — exactly why deleting and
recreating the tile (a fresh document id, full rebuild) "fixed" it, and why
that read as instability rather than a real fix.

**What was built:** `ensureItemLoaded`'s existing-item branch now also
reassigns `t.floorAttrItem = item` for every tile on that item, so
`restrictsLight` (and floor index, and anything else `buf:scene.attr` reads
off the live item) tracks the CURRENT document, no delete/recreate needed.
`npm run verify` green (7725 tests; this path isn't independently unit-tested
— it's browser/GPU-only — but nothing regressed).

### Open questions

- What should "Restrict Lighting" mean when the light is clearly above the
  tile — always pass through, or only past a threshold gap (mirroring
  `HEIGHT_GATE_TOLERANCE_UNITS`/`SOFTNESS_UNITS`)? Needed before symptom 1
  can be fixed.
- Does the same stale-material gap (symptom 3's mechanism) affect other
  tile flags baked the same way (`tint`, `alphaThreshold`, `occlusion`,
  `restrictsWeather`)? Only `restrictsLight` was fixed this pass, scoped to
  the literal report.
- Confirm symptom 2 is the same root cause as bug 8 once that direction is
  picked, rather than assuming.

### Fixed when

Toggling a tile's "Restrict Lighting" flag takes effect on the existing tile
immediately (built — verify live); a candle genuinely above a restrict-light
tile draws over it, one that's genuinely below/at the tile does not (needs
the design call above); candle flames render reliably regardless of nearby
restrict-light tiles (tracks with bug 8).

---

## 14. "MSA Anchor View" showed every candle/lightning icon regardless of floor

**Status:** `BUILT (unverified)` · **Reported:** 2026-08-08 · **Docs:** this
file's bug 5 (the `floorVisibility` field this reuses)

### Symptom

*"We should only show the anchor symbols for the floor that candles /
lightning and everything else is actually set to / visible on."*

### Root cause — CONFIRMED: two anchor-authority reads, only one floor-filtered

`anchorsForEffect(effectId, floorContext)` (`scene/anchor-authority.js:161-174`,
what actually renders) applies `floorMatches(a.floorBinding, floorContext,
a.params?.floorVisibility)` — the gate bug 5 built. `anchorsForKind(kindId)`
(:187-193) — the read "MSA Anchor View" mode uses — applies **neither** the
`enabled` filter NOR the floor filter, by design (a GM needs to see disabled
anchors to re-enable them), but the floor filter was dropped along with
`enabled` only because both filters happened to live in the one alternate
function; the reasoning that justifies skipping `enabled` never separately
argued for skipping the floor filter too.

`boot.js#enterAnchorViewMode` (:3247-3277) wires both kinds' `listAnchors` to
the unfiltered `anchorsForKind`, with no `activeFloorContext` passed — so
every candle/bolt icon in the whole scene draws on every floor, including
ones whose locked floor band would hide their actual effect entirely. (The
per-kind "Place" tool, `enterCandlePlacement`/`enterLightningPlacement`, was
already correctly floor-filtered via `anchorsForEffect` — this bug is
specifically about Anchor View Mode.)

`anchorsForKind` itself can't just gain floor filtering, because
`refreshCandleIgnition` (`boot.js:1332`, day/night auto-ignite) legitimately
needs the full-scene, floor-agnostic read.

### What was built — 2026-08-08

A new `anchorsForKindOnFloor(kindId, floorContext)` in `anchor-authority.js`
— same "keep disabled anchors visible" property as `anchorsForKind`, plus the
same `floorMatches()` gate `anchorsForEffect` uses. `boot.js`'s two Anchor
View Mode `listAnchors` callbacks now call it with `activeFloorContext`;
`refreshCandleIgnition`'s own `anchorsForKind` call is untouched. Additive —
no existing caller's contract changed. `npm run verify` green.

### Open questions

- Should Anchor View Mode keep an opt-in "show all floors" toggle for
  finding an anchor placed on the wrong floor by mistake (its original
  discovery-tool purpose), or is unconditional floor-matching correct per
  the literal report? Not built — flagged for the author.
- Confirm lightning's `floorVisibility` param shipped in the same pass as
  candle's (referenced in `anchor-catalog.js`, not separately narrated in
  bug 5's entry).

### Fixed when

Opening Anchor View Mode on a given floor shows only the candle/lightning
icons whose effect is actually visible from that floor.

---

## 15. A sun shadow bleeds through an occluding roof on the floor above

**Status:** `OPEN` — architecture gap confirmed, exact trigger needs a live
repro · **Reported:** 2026-08-08 · **Docs:** `Sun-Shadows-Layer-Smear.md`,
`Sun-Shadow-Cascade.md`

### Symptom

*"I'm on the upper floor of a building looking down at a rooftop visible on
my level. I can see an 'overhead' shadow which is caused by the floor below
but which is visible through an occluding roof which is on the upper floor
and should be covering it."*

### Root cause — CONFIRMED architecturally: two occlusion tests, one effect, no guarantee they agree

The layer-smear cascade has TWO independent occlusion checks. (1)
`environmental-light.js:446-480` picks which floor-slot a fragment reads
from — migrated to `depthFlagsTexNode`/`buf:scene.depth` on 2026-08-05
specifically "to honor the one-occlusion-system lock"
([[keyhole-depth-authority-sole-system-decision]]). (2) Inside each floor's
own bake, `layer-smear-render.js:429-450`'s cascade decides whether THAT
floor is opaque at a world (x,y) using `coverAbove` — a **mask-authority-
derived grid**, never the depth authority. `coverAbove` is built in
`mask-derive.js#deriveFloorProducts` (:811-885) by a static per-item test:
`isAbove = owner !== null ? owner > floor.index : ... item.elevation >=
floor.ceilingElevation`. None of `layer-smear.js`, `layer-smear-render.js`,
`sun-shadow-subsystem.js`, or `mask-derive.js` reference `depthAuthority` or
`buf:scene.depth` at all (confirmed by grep across all four).

So the cascade's "is this floor opaque here" answer and the depth
authority's real per-item occlusion answer — the one vegetation's
canopy-vs-roof correctly uses, and the one the sibling floor-select gate in
this SAME effect now uses — are computed by two unrelated pipelines with no
guarantee of agreement at any given pixel. When a roof reads opaque to the
depth authority but `coverAbove`'s static `ownerFloorIndex`/elevation
classification misses it (wrong/absent ownership, an elevation-fallback edge
case, a hidden/late-loaded item, staleness relative to a mask-authority
version bump), the cascade shows the floor-below's shadow bleeding through a
roof the player can see is solid.

**Could not pin the exact triggering item on the reporter's map without a
live repro** — the architectural gap is confirmed from source; which
specific roof item is misclassified is not.

### Proposed fix

(1) Instrument first — compare the sun-shadow debug band0/cascade view
against the depth authority's own per-pixel floor-flags for the specific
rooftop item, on the reporter's real map, to find exactly which item(s)
disagree (per [[feedback_instruments_must_not_lie]] — don't guess). (2) The
fix is almost certainly a `mask-derive.js` classification gap for that item
(missing/wrong `ownerFloorIndex`, a bad elevation fallback, or an item class
`coverAbove` doesn't consider that the depth authority's item-builder does),
not a resolution problem. Note: the cascade can't simply be pointed at
`buf:scene.depth` wholesale — that buffer is screen-space/per-camera-frame,
while the cascade bakes once per floor in world space (the orthographic
hole-stack model) — so a mask-grid is structurally the right kind of input;
the fix is making its classification provably match the depth authority's
for the same items, not swapping mechanisms.

### Open questions

- On the reporter's actual scene: is the offending roof explicitly
  floor-owned, or relying on the elevation-fallback path — and does that
  fallback actually clear the lower floor's ceiling elevation?
- Is the roof excluded from `coverAbove` by `item.hidden` at bake time but
  visible now (a staleness bug, not a classification bug)?
- Should `mask-derive.js`'s per-item classification be reconciled with (or
  literally sourced from) the depth authority's item list now that it's the
  locked sole occlusion system, or is keeping them as two deliberately
  different questions (screen compositing vs. world-space shadow silhouette)
  still correct, provided their answers are audited to agree?

### Fixed when

On the reporter's own scene, standing on the upper floor, the shadow that
was bleeding through the roof is fully hidden by it, matching the canopy's
own occlusion.

---

## 16. WebGPU crash: `_Specular` mask on the 12000² Mansion map exceeds `maxBufferSize`

**Status:** `BUILT (unverified)` — immediate fix only; the adaptive-resolution
system is still `OPEN` · **Reported:** 2026-08-08 · **Docs:** `Specular.md`,
`Performance.md`

### Symptom (exact error)

```
THREE.WebGPURenderer: Uncaptured WebGPU GPUValidationError: Buffer size
(324863904) exceeds the max buffer size limit (268435456). This adapter
supports a higher maxBufferSize of 2147483648, which can be specified in
requiredLimits when calling requestDevice().
 - While validating [BufferDescriptor ""Dawn_DynamicUploaderStaging""]
 - While [Failed to format error: "calling %s.WriteTexture(%s, (%u bytes), %s, %s)"]
```

Triggered by adding a `_Specular` mask to the 12000×12000px, 2-floor Mansion
map.

### Root cause — CONFIRMED, arithmetic matches the error to within 0.3%

`vt/texture-limits.js#resolveRendererRequiredLimits` requested
`maxTextureDimension2D` and `maxStorageBuffersPerShaderStage` via
`requiredLimits` but never `maxBufferSize` — so WebGPU silently stayed at the
spec floor (256MiB) even though this adapter supports 2GiB (per the error
text itself). Both renderer construction sites (`boot.js:7000-7001`,
`vt-pan-viewer.js:1203,1211`) already call the shared resolver correctly, so
the one omission affected both.

The actual oversized allocation: `_Specular` loads via `loadMaskImageTexture`
(`vt/mask-image.js:167-283`) into ONE untiled `THREE.DataTexture` — dimension-
capped (`MASK_IMAGE_MAX_DIM`) but **never byte-budget-capped**. At 12000px ×
`SPECULAR_MASK_IMAGE_SCALE` (0.75) × 4 bytes/texel (RGBA): 9000×9000×4 =
324,000,000 bytes — within ~0.3% of the reported 324,863,904 (the residual
matches WebGPU's 256-byte row-padding exactly). The base MAP ART loader
already has this exact defense (`MAX_WHOLE_TILE_DIM=8192`, added after a
12000² upload TDR'd a device on a floor switch, tiling into a 2×2 grid of
~137MB pieces instead) — `mask-image.js` was never given the same one; it
only caps pixel dimension, not bytes. (Water's mask, same loader but 1
byte/texel, sits at 144MB for the same map size — currently safe, but with
much thinner margin than the art loader's own precedent targets.)

### What was built — 2026-08-08 (immediate fix only)

`chooseBufferSizeLimit(adapterMax, desired)` added to `texture-limits.js`,
same clamp discipline as its two siblings (never exceed the adapter, never
go below the 256MiB spec floor), targeting `DESIRED_BUFFER_SIZE` = 1GiB — 4×
the floor rather than the siblings' 2×, because unlike them a `maxBufferSize`
miss is a hard crash, not a graceful degrade, and 2× (512MiB) would not have
cleared this exact 324MB case with real headroom for the next map. Wired
into `resolveRendererRequiredLimits` as a third independent branch — fixes
both construction sites via the one shared resolver. New Node tests mirror
the existing pattern. `npm run verify` green (7725 tests).

**This raises the ceiling only.** On hardware whose adapter genuinely can't
grant more than 256MiB, an oversized single upload can still crash — that's
what the system below is for.

### The adaptive-resolution system — NOT built, needs the author's numbers

The durable fix: give `mask-image.js`'s loader the SAME two-tier defense the
art loader already has — a BYTE BUDGET (not just a dimension cap) that
solves for resolution instead of guessing it: compute
`bytesPerTexel × width × height` for `maskImageTargetSize()`'s candidate
output, and scale down further before upload if it would cross the budget.
Natural seam: extend `maskImageTargetSize()` (or a pure sibling function,
mirroring how `chooseTextureLimit`/`planImageTiles` stay separate) with a
`bytesPerTexel` + `byteBudget` param. Downscaling degrades a silhouette mask
more gracefully than the art loader's multi-texture tiling would (and avoids
adding tiling complexity to two shader consumers — specular's HSV decode,
water's SDF seed — that assume one contiguous texture today).

### Open questions

- `DESIRED_BUFFER_SIZE` = 1GiB: right target, or should it track closer to
  the adapter's real reported max (2GiB) minus margin, given a miss here is
  a hard crash unlike the two siblings' graceful degrades?
- The adaptive system's byte budget: a flat constant, a fraction of the
  resolved `maxBufferSize`, or a fraction of estimated total scene VRAM
  (`estTextureVramMB` is already tracked by the flight recorder)?
- Should the byte-budget cap live in `mask-image.js` generally (covering
  water's thinner margin too) or be specular-specific?
- Is downscaling-to-budget acceptable for specular's visual target, or does
  the author want tiling (full resolution, more shader complexity) instead —
  a perceptual/artistic call, not a technical one.

### Fixed when

The Mansion map's `_Specular` mask loads without a crash (built — awaiting
live confirmation); a future, even larger map degrades resolution
automatically instead of crashing (not built).

---

## 17. Feature: a shared sun-brightness ceiling for `_Window` + a moonlight floor for night

**Status:** `OPEN` — design proposal only, no code · **Reported:** 2026-08-08
· **Docs:** `Windows-Aperture.md`, `Sky-and-Grade.md` (Grade Engine)

### Ask, in the author's own words

*"Somewhere we should track the highest value of sunlight brightness - this
needs to become the exterior brightness of outside areas at noon with no
clouds or blockers. That then needs to become the brightest that the
_Window effect can get to. The idea is that we shouldn't have internal
window light which ends up brighter than the external light. For this same
reason we need to add a night time lighting which happens around midnight
which is 'moon light' so that we can have the window lights show up at
night as long as it's not too cloudy. Clouds lower the overall light and
eventually we'll hook clouds into the window light system in a complex
fashion."*

### What's there today — CONFIRMED, and the defect is reproducible from the numbers alone

**No shared ceiling exists.** The window effect's brightness cap
(`window-cookie.js`'s `WINDOW_SHOULDER_K = 0.8`, asymptote ≈1.25 illum units)
is a hardcoded, scene-independent constant — it never reads
`env.ambient.daylight`, `darkness01`, or anything the exterior lighting
computes. MSA's own noon parity essay puts daylight ambient at ~0.93-1.0
(`DEFAULT_AMBIENT.daylight = [0.93,0.93,0.93]`). **1.25 already sits above
that** — the defect the author describes is present in the code's own
numbers, not just a hunch. `WINDOW_PARAMS.strength` (0..3, default 1.25) only
changes how fast the shoulder *approaches* that same fixed 1.25 — never what
it approaches.

**A time-of-day model already exists** and is exactly where a moonlight term
would hook in: `world/sun.js#computeSun` derives `dayFactor01`/`skyFactor01`/
`twilight01`; `world/day-clock.js` is [[keyhole-time-authority-decision]];
`world/environment.js#buildEnvSnapshot` derives one `darkness01` and carries
`env.ambient.{daylight,darkness,brightest}` through untouched.
`environmental-light.js#computeAmbientBackground` mixes daylight → darkness
by `darkness01`, gated by the locked [[keyhole-darkness-realism-lever]]
(default 0) — but there is no third "moonlight" endpoint anywhere; deep
night simply floors out at Foundry's own `ambientDarkness` colour (or black
at realism=1). `grep -r "moon"` across `src/` returns nothing.

**Clouds are confirmed DESIGN ONLY** (`docs/planning/Clouds.md`: "NOTHING
BUILT... No code exists"). `env.weather.cloudCover01` is a real scalar
already consumed for sky chroma; `window-render.js`/`window.js` already
carry a pre-wired, unfed `cloudFactorNode` seam (constant `1` today) —
exactly this codebase's "seam with a safe default" pattern, ready for
clouds to plug into later. Clouds.md's own author ruling ("read site, not
the bake") is directly relevant to how the ceiling itself should be built —
as a re-derived value, not a cached uniform, so a future cloud term is a
one-line multiply at the point of use with zero rework.

### Proposed architecture (for the author's sign-off — not implemented)

1. **Peak exterior brightness, derived not tracked**: expose
   `env.sunPeakRgb = env.ambient.daylight` (and its luminance) on the env
   snapshot each frame — it's already the closed-form noon/no-cloud/no-
   blocker peak, self-updates if a GM edits scene ambient, no reset/decay
   logic needed. (A literal running-max would need its own decay rule if
   that's actually what's wanted instead — see open questions.)
2. **A moonlight endpoint**, night's counterpart to daylight — a tunable
   colour constant (mirroring `sky-access.js`'s `FILL_NIGHT_RGB`) driven by
   the SAME `skyFactor01`/`darkness01` curve the ambient floor already mixes
   on, so the two ramps can never disagree.
3. **Two real forks for where the moon floor plugs in** — (A) MAX-blend it
   into the shared ambient floor scene-wide (reuses
   `computeGlobalLightFloor`'s existing precedent — a genuinely lit exterior
   at night), or (B) a window-only ceiling (bounds only the window's own
   contribution). The brief's wording leans toward needing (A) regardless
   (a moonlit window against a scene crushed to true black would look
   wrong), but they're likely not mutually exclusive.
4. **The window's clamp becomes dynamic**: `WINDOW_SHOULDER_K`'s fixed
   asymptote becomes `k = 1 / ceilingIllumUnits`, where `ceilingIllumUnits`
   mixes moon-peak → sun-peak on the same darkness/day curve — this is the
   mechanism that actually enforces "windows never outshine the sun."
   Touches both the CPU twin (`window-cookie.js`) and its TSL transcription,
   CPU twin first, per this codebase's own convention.
5. **Clouds' hook stays a one-line multiply** at the ceiling's point of use
   once the real system lands — `env.weather.cloudCover01` could be wired in
   now as a cheap interim dimmer if the author wants a first cut ahead of the
   full procedural field.

### Open questions

- "Track the highest value" — a derived-per-frame constant (recommended:
  self-updating, no reset logic) or an actual stateful running max sampled
  during play (needs a decay/reset rule for when a GM edits the scene)?
- Moonlight as a scene-wide floor (A), a window-only ceiling (B), or both?
- Does `WINDOW_PARAMS.strength`'s felt meaning change once its asymptote is
  dynamic instead of fixed at 1.25 — worth confirming rather than assuming,
  since it's an already-shipped, author-tuned dial.
- Should moonlight interact with `darknessRealism01` — crushed to zero at
  realism=1 too (consistent with "true dark"), or a deliberate floor ABOVE
  true-black even there, since the whole point is windows staying visible?
- One physically-tuned ratio (moon = 1/20th of daylight, say), or two
  independently authored RGB endpoints with their own strengths (mirroring
  `sky-access.js`'s separately hand-picked key/fill colours)?
- Wire the interim `cloudCover01` scalar into the ceiling now, or wait for
  Clouds.md's real system?

### Fixed when

At noon, a maxed-out window never reads brighter than the exterior daylight
next to it; at night, with the moon term active, a lit window is visibly
brighter than its darkened surroundings; heavy cloud cover dims both
together once clouds are wired in.

---

## 18. Selecting a token shows a frozen, screen-locked second copy of the map inside explored fog

**Status:** `BUILT (unverified)` — root cause confirmed, fix implemented and
live-tested against the real bench-Mansion harness; author has not yet
looked at it on a real scene · **Reported:** 2026-08-13 · **Docs:**
`src/foundry/canvas-compositing.js` (the interface-seam header comment),
memory `keyhole-fog-shader-primary-texture-freeze`

### Symptom

*"When I select a token there is the black part of the fog of war which is
working correctly but the 'explored' area isn't correctly pinned to world
space. This only happens when I select tokens, essentially the black fog of
war appears but I see a double set of albedos and one of them moves when I
move the camera and the other one stays still."*

### Root cause — CONFIRMED against the vendored Foundry v14 source, not guessed

Foundry's own fog-of-war shader depends on a texture MSA's art suppression
silently freezes. Chain, each link read from source:

1. MSA hides Foundry's own map art via `canvas.environment.renderable =
   false` (`canvas-compositing.js:311`) — intentional, MSA owns drawing the
   map.
2. `canvas.environment` is the literal PIXI **parent** of `canvas.primary`
   (`groups/environment.mjs:21`), and neither it nor `CanvasGroupMixin`
   override `render()` — it's the stock `PIXI.Container#render()`, which
   early-returns on `!renderable` **before walking children**. So
   suppression doesn't just hide `canvas.primary` — it stops PIXI from ever
   calling its `render()` at all.
3. `canvas.primary` is a `CachedContainer` (`groups/primary.mjs:29`), and
   `CachedContainer#render()` (`containers/advanced/cached-container.mjs:
   209-221`) is where its children get re-rendered into its own internal
   `renderTexture` — gated by that same `!renderable` early-return (line
   211). Never reached ⇒ **`canvas.primary.renderTexture` freezes solid**,
   holding whatever it had at the instant suppression engaged (effectively
   scene boot).
4. Foundry's `VisibilityFilter` (Foundry's fog-of-war shader) unconditionally
   samples that exact texture: `primaryTexture: canvas.primary.renderTexture`
   (`groups/visibility.mjs:336`). Its fragment shader
   (`rendering/filters/visibility.mjs:140,149`) uses it as `baseColor` for
   the **explored-but-not-currently-visible** zone's whole formula — a
   normal 0.5-alpha blend, so MSA's live render underneath shows through
   double-exposed against this frozen snapshot. The pure-black
   **unexplored** zone's formula doesn't read `baseColor` at all
   (`vec4(unexploredColor, 1.0)`), which is exactly why the author sees the
   black zone as correct and only the grey/explored zone as broken.
5. The sample UV is screen-space (`filterMaskTextureCoord`,
   `rendering/filters/visibility.mjs:91`), not world-space — so the frozen
   snapshot always fills the current viewport regardless of camera position:
   it reads as camera-locked ("stays still") while MSA's own live,
   world-tracked render pans normally ("moves"). Two renders of the map, two
   different apparent behaviours.
6. Why only on token select: `CanvasVisibility#refresh()` sets
   `this.visible = canvas.effects.visionSources.some(s => s.active) ||
   !game.user.isGM` (`groups/visibility.mjs:489`). For a GM with no
   controlled token this whole group — filter included — never runs, so the
   frozen-texture dependency is never exercised until a vision source goes
   active. Players (never GM) have it active essentially always.

### Proposed fix — scoped, not built

Stop suppressing `canvas.primary` at the parent (`environment`) level, which
inseparably bundles "stop the cache" with "stop the screen output". Instead:

- Leave `canvas.primary.renderable` at its default `true` so
  `CachedContainer#render`'s cache-refresh keeps running every frame,
  feeding Foundry's own fog shader (and anything else reading
  `canvas.primary.renderTexture`) correctly.
- Suppress only the screen output: `canvas.primary.sprite.renderable =
  false` (the bound `SpriteMesh`, always present from construction) — stops
  the unconditional on-screen blit without touching the cache-refresh half.
- `canvas.effects` is a plain `PIXI.Container`, not a `CachedContainer`
  (`groups/effects.mjs:31`) — no freeze failure mode, so it keeps being
  suppressed the simple way: `canvas.effects.renderable = false` directly.
- The safety-slide revert path needs the mirrored update
  (`canvas.primary.sprite.renderable = true; canvas.effects.renderable =
  true;`) so the fallback-to-Foundry mechanism stays correct.

**Rejected alternative:** suppressing `canvas.visibility` entirely would
kill the ghost by killing ALL of Foundry's fog rendering, including the
black zone the author confirmed works — trades a visual bug for losing a
wanted feature, and edges toward the separate, already-known non-GM
visibility gap (bug tracked in memory `keyhole-fog-of-war-gap`).

### Open questions

- **Perf cost, unmeasured.** This gives back some of the render-to-texture
  cost MSA currently skips by suppressing at the parent level — the same
  cost vanilla Foundry pays every frame with no MSA at all. Likely small
  against V3's own budget, but not yet run through the perf harness.
- **Patch now vs. fold into the larger "MSA owns fog+vision rendering"
  project** (already the locked long-term direction — see
  `Point-Light-Batching-Design.md`'s sibling doc for the fog equivalent, not
  yet written). The bigger project would obsolete this entire shader
  dependency at once, and also closes the non-GM visibility gap in the same
  motion. The scoped patch above doesn't block or contradict that project —
  it's a correct stopgap, not a hack destined for rework — but which to do
  first is the author's call, not a technical one.

### Fixed when

With a token controlled (or as any player) and the camera panned across
explored-but-not-currently-visible territory, only one copy of the map is
visible and it tracks the camera exactly — no ghosted second image, static
or otherwise.

### Live-tested, 2026-08-13 — `tests/playwright-artifacts/look/fog-shader-primary-freeze-verify.mjs`

Ran against the real bench-Mansion Foundry harness (not just Node unit
tests). Confirmed live: `canvas.primary.renderable:true` (cache stays
active) with `canvas.primary.sprite.renderable:false` and
`canvas.effects.renderable:false` (output still suppressed) — the intended
new state. THE DECISIVE CHECK: read back `canvas.primary.renderTexture`'s
actual pixel content before and after a real camera pan (9000,9000 →
12000,12000 world units, confirmed via `canvas.stage.pivot`) — content
genuinely changed (checksum 11351663→12169478, center pixel
[140,67,67,255]→[137,71,57,255]). Before this fix that texture would have
been frozen at whatever it held from scene boot, byte-identical regardless
of camera movement — this is direct, live proof the cache is no longer
frozen, not just a source-level argument.

**Gap, honestly noted:** the bench Mansion scene has no tokens placed on
it, so an actual "control a token, watch the ghost disappear" screenshot
could not be captured — only the underlying mechanism. Full visual
confirmation still needs the author's own eyes on a real scene with a real
token, per this project's own BUILT-vs-LIVE convention.

**Perf, honestly noted:** a settled (post-`waitForSceneSettled` + 8s dwell),
no-token-controlled fps read came back **53fps** vs. the harness's own
prior **67fps** baseline (memory `reference_live_foundry_harness`,
2026-08-10, same scene/resolution). Suggestive of a real but moderate cost
from keeping `canvas.primary`'s cache alive — but NOT a controlled A/B (the
two readings differ in camera framing at minimum, and that memory's own
baseline already cautions it isn't directly comparable across runs). A true
flag-toggle-in-one-session measurement (same shape as `s2-15-pixel-diff.mjs`)
would isolate this precisely if it matters enough to chase further.

---

## 19. Painted `_Fire` region doesn't register on First Floor even with visible white paint

**Status:** `OPEN` (root cause) — a live-tunable workaround is `BUILT`,
live-tested against the real bench-Mansion harness · **Reported:** 2026-08-13
· **Docs:** `Fire.md`, `src/effects/fire/fire-mask.js`,
`src/effects/fire/fire-spawn-points.js`

### Symptom, in the author's own words

*"The fireplace has this in the `_Fire` mask. If I make this much bigger a
fire appears but then the fire is too large for the fireplace. There are
plenty of fully white pixels in this yet no fire. Not fixed yet and this
problem only happens on the upper floor."* Then, decisively: *"I copied the
exact same block of pixels into the ground floor and they work perfectly
fine on the ground floor and fail completely on the upper floor. Proven."*

### What was ruled out, one at a time

Native texture resolution (both Levels 12000×12000), per-Level texture
placement config (`scaleX`/`scaleY`=1, offset=0, `fit`='fill', rotation=0 —
identical on both), source count (exactly one `_Fire` source on both floors),
and grid emptiness (25 real above-threshold texels confirmed present in
First Floor's own derived grid via `fireTexelsAtOrAbovePaintThreshold`). None
of these explained the asymmetry.

### Two real bugs found and fixed along the way — neither is the full answer

1. **Stale packed-page cache with no content awareness**
   (`vt/pyramid-store.js#pageStoreKey`) — the cache key was URL-only, a
   documented never-finished TODO (Keyhole.md §4.1 said "URL+mtime"). Fixed:
   a ranged-GET content-validator now folds real byte size into the cache
   key (`decode-pool.js`), `PACK_RECIPE_VERSION` 2→3.
2. **Packed-channel alpha attenuation** — `compositePackedTexels`'s
   non-owner-channel resolution (`_Fire`/`_Shadow` share one packed RGBA
   texture with `_Outdoors`, only one channel keeps real alpha) was a
   *linear blend* toward the channel's `absentValue`, not a threshold — so
   antialiased/soft-edged paint got dimmed proportionally to its own alpha,
   disproportionately punishing small strokes. Fixed: a hard
   `PACKED_CHANNEL_ALPHA_GATE` (byte ≥8) replaces the blend,
   `PACK_RECIPE_VERSION` 3→4.

Both are real, verified improvements (`npm run verify` green throughout),
but the author's own same-bytes-different-floor test proved neither was the
full explanation — the exact floor-specific mechanism is still not found.

### The workaround shipped instead, per direct author request

*"Give me a way to change the sensitivity so that I can boost the chance of
fire appearing but please make sure that the system once I stop moving the
control rebuilds the fire effect so that I can test it immediately without
having to refresh Foundry."*

- New `maskSensitivity` param (`FIRE_PARAMS`, 'Presence' category, range
  0.02–0.6, default 0.25 — unchanged behaviour until moved) drives the paint
  threshold both `getMaskDrivenFires` (`extractFiresFromMask`'s
  `paintThreshold`) and `getFireSpawnCloud` (`extractFireSpawnPoints`'s
  `threshold`, kept at the same shipped ratio to the fire threshold) read
  every call.
- Rides in both caches' key alongside signature/version
  (`fireMaskCache`/`fireSpawnCache` in `boot.js`), so a slider move forces a
  genuine re-extraction on the very next frame — never a stale read.
- Added to the Fire panel's front-of-house strip (`boot.js`'s
  `buildFirePanel`) — a session-tuning control the author will reach for
  repeatedly while diagnosing a specific fireplace, not set-once detail.

### Live-tested, 2026-08-13 — `tests/playwright-artifacts/look/fire-sensitivity-live-verify.mjs`

Against the real bench-Mansion harness, First Floor, driving
`MapShine.setFire({maskSensitivity})` (the exact call the new slider's
`onChange` makes):

| Sensitivity | Fires found | Fresh extraction logged? |
| --- | --- | --- |
| 0.25 (default) | **0** | — (baseline) |
| 0.05 (low) | **1** | ✅ yes, timestamped after the call |
| 0.55 (high) | 0 | ✅ yes, timestamped after the call |
| 0.25 (back to default) | 0 | ✅ yes, timestamped after the call |

Confirms both halves of the ask: the control genuinely finds a fire on First
Floor that the default threshold misses (directly addressing the reported
symptom), and every change produces a real, immediate re-extraction with no
Foundry reload — never a stale or skipped result.

### Fixed when

Root cause: identical painted bytes yield the same fire count on every
floor at the SAME sensitivity setting, with no slider needed. Not yet true —
still open. Workaround: confirmed live above; author's own eyes on the real
scene (not the harness) is the remaining step to promote this to `LIVE`.

### Open questions

- What is actually different about First Floor's extraction path at the
  *default* threshold specifically? The 1-fire-at-0.05 result proves the
  paint is real and locatable — so the remaining asymmetry is about how
  close that specific blob sits to the threshold on each floor, not about
  data being missing. Worth a direct `chamferDistance` peak-value probe on
  the same blob, both floors, at the SAME sensitivity, next time this is
  picked back up.
- Should `maskSensitivity` eventually apply per-floor or globally? Today
  it's one global override — raising it to solve a First Floor problem also
  raises the bar on Ground floor.

---

## 20. First Floor runs at ~half Ground floor's framerate — depth-authority passes cost ~10x more there

**Status:** `BUILT (unverified)` — pixel-diff clean and the fix confirmed genuinely
engaged, not just present; author has not yet looked at it live · **Reported:**
2026-08-13 (v0.6.1 performance review) · **Docs:** `docs/planning/Performance-Review-v0.6.1.md`,
`docs/planning/Stage-1-Shade-Once.md`, `docs/planning/perf-reports/2026-08-13-v0.6.1-baseline.json`

### Symptom

The v0.6.1 baseline perf capture: Ground floor 57.8fps avg, First Floor 30.5fps
avg — roughly half. `multiFloor.ranked` isolated it to two specific zones, not
a general "more stuff" story: `geometry.depthDraw` 9.51x more expensive on
First Floor, `geometry.earlyZPrepass` 9.77x more, while the main colour draw
(`geometry.worldDraw`) only cost 1.4x more.

### Root cause — CONFIRMED against the real art, not guessed

A canvas-based alpha-channel decode of the actual source files: `Ground.webp`
reads alpha=255 (fully opaque) at every sampled point, including four
native-resolution edge strips. `First-Floor.webp` is **66.7% fully
transparent overall**, with a genuine, solid 300px-wide border of alpha=0 on
all four edges — confirmed by the author independently ("the upper floor is
the main upper floor of a building with a gap of transparency around the
edges of the map").

A `discard()` anywhere in a fragment shader disables hardware early-fragment-
tests for that whole shader (already known and exploited elsewhere in this
codebase — it's the reason the depth-authority system's own `alwaysOpaque`
fast path exists at all). Ground's background never needs a discard and gets
free hardware occlusion; First Floor's background structurally cannot pass
the whole-item `alwaysOpaque` check (`alphaStats.min` is 0, nowhere near the
threshold), so its full-map-footprint shader pays full fragment cost across
its entire on-screen area, in both `runSceneDepthPass` and its early-Z
prepass twin, every frame.

### What was already half-built, and what was actually missing

The colour draw already has a per-cell interior/boundary split for exactly
this case (S1a — `splitCoverageCellMask` in `vt/coverage-mesh.js`,
`applyEarlyZTileState`/`ensureSplitInteriorMaterial` in `vt-pan-viewer.js`),
shipped and live since S1.4-S1.7 (`docs/planning/Stage-1-Shade-Once.md`).
`rebuildSceneDepthProxies`'s own comment already named why it doesn't help
`geometry.depthDraw`/`geometry.earlyZPrepass`: the depth-authority proxy and
its prepass twin **share the same split geometry** (`t.geometry`, the same
object the colour tile uses) but were still drawn with **one** material
covering both index groups — a non-array material draws every group with
itself regardless of how many groups the geometry has.

### The fix

`rebuildSceneDepthProxies` now builds a SECOND writer material
(`alwaysOpaque:true`) for a tile's interior cells whenever `earlyZComposition`
is on and the colour draw already split that tile (`t.cellSplit`), and
assigns `[interior, boundary]` to match the geometry's own two groups.
`addDepthPrepassTwin` gained a matching optional parameter. Both pool through
the existing `depthProxyMaterialPool`, which already disambiguates by
`alwaysOpaque` — no new pooling logic. An interior cell's certification
(every min-alpha-grid texel reads exactly 255) is strictly stronger than
`alwaysOpaque`'s own bar, so this is provably safe, not a new risk.

**Two real, pre-existing bugs found and fixed along the way** — S1a's own
min-grid consumption was silently dead without them, on EVERY floor, not
just First Floor:
1. `wi.alphaMinGrid`/`wi.alphaStats` were assigned to the item state AFTER
   that tile's first `setTileGeometry()` call, not before — so the very
   first geometry build for every item always read `undefined`, regardless
   of how fresh the compressed-texture cache record actually was.
2. `refreshWholeImageItem`'s re-mesh trigger only fired on a placement
   change or the coverage grid changing — nothing re-triggered when the
   min-grid arrived asynchronously after that first build (the normal case),
   so a tile meshed before it landed stayed on `splitDeclined:'noMinGrid'`
   for the rest of the session, permanently. Fixed by tracking
   `t.alphaMinGrid` the same way `t.coverageGrid` already is.

### Verification so far

`npm run verify` green throughout. Live pixel-diff on First Floor
(`stage1-earlyz-pixel-diff.mjs`, flag OFF vs ON, same session/camera): **0 of
2,073,600 pixels differ**. Confirmed genuinely engaged, not vacuous — before
the two timing bugs above were fixed, every candidate tile declined with
`noMinGrid` despite real min-grid data being present (`getEarlyZComposition()`
itself read it fine; `setTileGeometry` had captured a stale `undefined` and
nothing ever asked it to look again). After: `splitInteriorCells: 1233`,
`splitBoundaryCells: 773`, zero `noMinGrid` declines remaining.

**Not yet done:** a fresh multi-floor perf capture to confirm the actual
framerate gap narrowed (the pixel-diff proves correctness, not speed) — the
author asked to stop the live-test loop and will verify this themselves.

### Fixed when

First Floor's frame time approaches Ground floor's for equivalent content,
and the author's own eyes confirm nothing looks different on either floor.
