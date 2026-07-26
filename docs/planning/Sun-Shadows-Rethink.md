# SUN SHADOWS — the rethink (2026-07-26)

**Status:** AUDIT + REBUILD. Author, 2026-07-26: _"Your sun shadows are still incorrect — I think you need a complete refactor and rethink. Sky reach shadows were always damn near impossible to get working and yet their principle is so simple."_

Supersedes the tuning history in `Sun-Shadows.md` §12–13. The plan doc stays; this is why the plan's *implementation* was wrong.

---

## 0. The one sentence

> **The field packed a caster's OPACITY and its HEIGHT into the same byte, so every soft edge became a short caster — and a short caster casts a shadow that is both shorter AND fainter. Everything the author reported is that one mistake, seen from four angles.**

---

## 1. What the author reported, and what each symptom actually is

| Reported | Root cause |
| --- | --- |
| "blocky and square edged" | `compositeItemMax` NEAREST-samples the content grid. Content is the pack's coarsest mip (≤248²) → ~43 px per texel on a 10,650 px map, hard-stamped. Every mask texel is a 43 px square. |
| "the shadows have different opacities" | Three separate causes, all real — see §2. |
| "sky reach just isn't working at all" | Height is `alpha × height`, and height comes from `(elevation − bottomElevation)`. If a floor declares no `bottomElevation`, **every sky-reach height is silently 0** while the report still counts the items. A zero-height caster casts nothing. |
| "extra dark shadows from overhead tiles on the floor above" | The shadow field is per-floor; the render composites *several* floors at once. The upper floor's own surface is darkened by the lower floor's shadow field. Structural — see §5. |

## 2. "Different opacities" — three independent causes

**(a) Two darkness scales.** `strength01` (0.55) drives the march; `skyOcclusion` (0.25) is a *separate multiply* bolted on afterwards. Two knobs, two darknesses, for what is one shadow.

**(b) Darkness varies with caster height.** The march does `smoothstep(0, feather, casterHeight − rayHeight)`. A caster that only just clears the ray is permanently PARTIAL. So a 5 ft awning (≈70 px) is faint and a 260 px building is solid. **Physically wrong: height sets a shadow's LENGTH, never its darkness.**

**(c) Opacity and height share one byte.** `compositeItemMax(grid, alpha, placement, height/scale)` multiplies them. A 50 %-alpha edge texel of a 300 px bridge deck stores "150 px caster" — so the art's antialiased edge becomes a *height ramp*, which becomes a *length ramp*, which via (b) also becomes a *darkness ramp*. One byte, three meanings.

## 3. The rethink — one march, one darkness, coverage draws the silhouette

Split the two quantities that were fighting over one byte:

```
R = floating coverage   (overhead ∪ sky-reach art alpha, MAX — NOT height-scaled)
G = occluder height     (MAX over producers — NOT alpha-scaled)
B = building coverage   (1 − outdoors)
A = receiver gate       (raw outdoors)
```

The march becomes:

```
coverage(d) = max(R, B)
blocked(d)  = coverage(d) × softstep(height(d) − rayHeight(d))
occlusion   = MAX over d of blocked(d)
```

Three consequences, each fixing a reported symptom:

1. **Darkness is uniform.** `coverage` is the art's own antialiased alpha — a genuinely soft, high-quality silhouette. `softstep` only fades the shadow's *tip*. A 5 ft awning and a 40 ft tower now cast equally dark shadows of different lengths, which is what shadows do.
2. **The silhouette comes from the source art, not from a height gradient.** This is `feedback_sdf_does_not_draw_the_edge` applied one system over: _silhouette from source art, distance from the field_.
3. **`skyOcclusion` is deleted.** The "under a bridge is dark" term is not a separate mechanism — it is what the march already returns once `d = 0` is sampled (a floating caster directly overhead blocks the ray at every station until the ray climbs past its height). One term, one strength.

**⚠️ `d = 0` samples FLOATING coverage only (R), never `max(R,B)`.** A grounded wall occupies its own footprint — there is no ground under it to shade. A bridge deck has air beneath it. That distinction is the entire reason `B` is a separate channel rather than folded into `R`.

## 4. The debug view — the actual deliverable

Author: _"a dropdown in the ROH controls, allowing me to see just a single shadow at a time… Render the shadow onto a white background… You can also put debug things into that list so that I can help tell you if an intermediate texture is actually broken."_

One dropdown, one action (`feedback_debug_ui_one_action_one_control`). It **replaces** the three `showBuilding`/`showOverhead`/`showSkyReach` bools — their own help text already said "Diagnosis", and two controls that isolate the same thing is how they end up disagreeing.

| View | Shows |
| --- | --- |
| Normal render | off |
| All shadows | the baked field, white = lit |
| Building only / Overhead only / Sky-reach only | one producer, isolated at DERIVE time (the others' channels are never written) |
| Occluder coverage | R — *is the silhouette there at all?* |
| Occluder height | G — **the sky-reach smoking gun: coverage present + height black = zero-height casters** |
| Building footprint | B |
| Receiver gate | A — the `_Outdoors` read the shadow actually uses |

The coverage/height PAIR is the diagnostic that the old single-byte packing made impossible to ask: it separates "no casters" from "casters with no height", which is exactly the distinction that made sky-reach undebuggable for months (`feedback_instruments_must_not_lie`).

## 4b. Sky-reach, round two — TWO more causes, both "the data never arrived"

The §3 march was correct and still showed nothing but tiles. Two independent
gates upstream of it, each of which alone was fatal:

**(i) Classification.** "Is this above me" was `elevation >= ceilingElevation`. A
level's **foreground** sits at its `elevation.top`; its **background** sits at
its `elevation.bottom` — the boundary it SHARES with the floor below's ceiling.
Abutting bands pass; bands overlapping by one unit drop every upper floor's
background while keeping its foreground. Fixed: level art is classified by
**floor membership** (`ownerFloorIndex > floor.index`), which is an authored fact
rather than a proxy for one. **Tiles keep the elevation rule** — a tile's level
set says which floors it *appears on* (empty = all of them), not which one it
belongs to, so elevation really is the only answer there.

**(ii) Ingest.** `boot.js` hands the mask authority an UNFILTERED item list, and
its own comment says why: *"cover physics must not depend on what the user is
currently viewing."* But the coarse **alpha** — without which an item contributes
nothing — was only requested from `ensureItemLoaded`, i.e. only for items on the
**draw list**, which IS filtered by visibility. So the authority knew about the
floor above's background and held `alpha: null` for it forever.

That also explains why tiles were the one class that worked: a tile with an empty
levels set is "present on every floor", so it is always drawn, so its alpha always
loaded. Fixed: `primeCoverAlphaGrids()` requests alpha for every cover item on
every floor, from the same unfiltered list the authority gets.

**The cost, stated:** priming a non-drawn floor's background is a real fetch of a
real file (the bridge map's are 3–9 MB). It is once per item per session,
IndexedDB-cached across sessions, fire-and-forget, and decoded at ≤512 px via
`createImageBitmap`'s resize path — but it is not free, and there is no way to
know what an upper floor covers without reading it.

**Per-floor is already correct for the camera moving up.** Products are derived
per floor, so floor N's sky-reach is "every floor above N" by construction; the
bake simply asks for `view.floorIndex`.

## 4c. A raised item must never shadow ITSELF

Author's screenshot: a standing prop on a raised tile rendered with a dark
trail painted straight through its own sprite — "shadow ABOVE the overhead
thing."

**Root cause:** the `d = 0` self-check (§4b) read `coverFloating =
max(coverOverhead, coverSkyReach)`. That is correct for sky-reach (a genuinely
different FLOOR) but wrong for overhead — an overhead item lives on **this
same floor**. Foundry's elevation is a draw-order key, not a spatial offset: a
raised tile's own sprite is drawn at the IDENTICAL (x, y) as whatever it would
notionally "shade" beneath it. There is no separate, visible ground at that
point to darken — only the item's own opaque art — so an overhead item's own
footprint read "something is floating directly over me" and painted a shadow
through itself.

**Fix:** the packing changed again. `R` now carries **`coverSkyReach` alone**
— a genuinely different floor's structure, whose art this floor never draws,
so darkening that pixel darkens real, still-visible ground. `B` becomes
`max(coverBuilding, coverOverhead)` — this floor's own solid mass, which still
marches normally (casting onto nearby ground the ordinary directional way) but
is never `d = 0`-eligible. `coverFloating` is deleted outright (no consumers
left, and a computed grid with none is exactly the rot
`feedback_unconsumed_api_rots_silently` names).

**The generalisable lesson:** any "is something directly above/below me" check
in a flat 2D renderer must ask *is the thing at this (x,y) genuinely a
different, still-visible layer* — never assume elevation implies spatial
separation. See `feedback_elevation_is_sort_key_not_offset` for the full
write-up; this bug class can bite any effect that reaches for "elevation" as a
proxy for "somewhere else."

### 4c. Round two of the SAME bug — the fix above wasn't enough

Author, live: still broken, same visual (shadow through the prop's own
sprite) after §4c's channel split. Cause: the split fixed *overhead* items,
but this specific prop is a TILE whose elevation (12) happens to exceed this
floor's own ceiling (10) — so it was classified as **sky-reach** ("a
different floor's structure"), not overhead, even though it is a tile with a
**specific `levels` set naming this exact floor**. Sky-reach was deliberately
left `d=0`-eligible (§4c) because it is *supposed* to mean "genuinely a
different, still-visible layer" — but the classifier had no way to check that
for tiles; it only ever compared the raw elevation number to the ceiling.

**Fix:** `scene-layers.js#collectTiles` already computes exactly which floors
a tile is visible on (`visibleOnLevelIds`) — that information was being
discarded before reaching the derivation. It now flows through as
`visibleFloorIndices`, and floor membership beats the elevation number: a
tile confirmed drawn on floor N can never be sky-reach *for floor N*,
regardless of its elevation, and its overhead classification is uncapped by
the ceiling (its elevation may be high purely for draw-order reasons). Same
shape as `ownerFloorIndex` for level art — this is that fix's exact sibling,
one item-kind later. Unknown visibility (no `visibleFloorIndices`) falls back
to the original elevation-only test, so this is additive, not a behaviour
swap.

**Stated simplification, not fixed:** a tile with an *empty* `levels` set
(Foundry's "visible on every floor") resolves to being visible on every floor
in the scene, so it now loses sky-reach eligibility entirely — it can never
shade a floor below it, even though genuinely-universal decorations might
want that. Narrow and untested; flagged rather than guessed at a third time.

## 5. Known-remaining, NOT fixed here (stated, not hidden)

**The shadow field is per-floor; the frame draws several floors at once.** The ambient fill is screen-space and samples one field, so an upper floor's own surface is darkened by the floor-below's shadows. The correct fix is a per-pixel floor id in `scene.attr` (the MRT already exists) so the fill can pick the right field — a real feature, not a tuning change. Flagged rather than guessed at; the "Sky-reach only" debug view will confirm or refute it in one look.

---

_The audit's own lesson: a packing that stores two physical quantities in one number cannot be tuned into correctness, and every knob added on top makes the next diagnosis harder. Four rounds of tuning failed because they were all downstream of `alpha × height`._
