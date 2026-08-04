# Aperture Gobo — window light, shaped by procedural window geometry

**Status: BUILT (unverified), IN LIVE DEBUGGING, 2026-08-03.** Deployed to
`src/` the same day this design was written, on the author's go-ahead
("Wonderful! Implement it!"). Five live test rounds so far, FIVE real bugs
fixed and TWO rearchitectures, all from the author's own eyes on a real
scene, none from code review or the test suite (§13.7–§13.12): the aperture
predicate matched the wrong Foundry sense type entirely (`NONE` instead of
`PROXIMITY` — see §2.1); the debug view itself was misleading (flooded a
light's whole radius with white instead of isolating the affected region);
near-field magnification, correct but unbounded, was blowing the pattern up
past legibility at ordinary torch-to-window distances; **§6's entire
"multiply into one light's own falloff" design was structurally wrong**,
found live and rebuilt the same session (§13.10): a `MAX`-blended point
light can only ever brighten a fragment above ambient, never darken it
below, so the pattern was invisible in daylight and barely visible at night
no matter how it was tuned; a second structural problem in that replacement
(§13.11): a genuine `MULTIPLY` of the whole accumulated buffer has no floor,
so it could crush bright daytime ambient toward black just as easily as it
darkened a dim room at night — fixed by blending toward each light's own
`backgroundFloor` instead, mathematically bounded on both ends; and then, on
the FIRST live look at THAT fix, a fifth finding (§13.12): being bounded by
ambient is not the same as being invisible when irrelevant — a torch's own
NATURAL corona is often still brighter than noon daylight right next to the
light, so the shadow pass was visibly reshaping that corona into a hard-
edged wedge (the window's own geometric throw region) even at noon, where
physically an interior torch's shadow pattern shouldn't be perceptible at
all. Fixed with a visibility gate — a Weber-contrast ratio between this
light's own natural brightness and ambient's — that makes the shadow pass a
COMPLETE no-op wherever ambient already outshines this light (typically
almost everywhere at noon), and shapes its reach to fade exactly where the
light's own corona does the rest of the time.

**Then, on the FIRST live look at the visibility gate: still no cookie, day
or night.** Author's own report: *"Both day and night should show the cookie
and neither does."* Rather than debug designs 1-3's pattern-generation core
further — five rounds had already found a magnification blowup, a blur/bar-
width mismatch, and a wedge/corona seam in it, and NEVER once produced a
clean pane grid — the author proposed a structurally different mechanism:
treat mullions as literal light-blocking geometry (angular spokes for
verticals, radial arcs for horizontals) instead of a projected, magnified
image. Verified against the real Foundry source before committing to it
(`clockwise-sweep.mjs`'s own `Edge#applyThreshold`, confirming
`light.shapePoints` already excludes the wedge's OUTER shape from this
effect's own problem) and then built as **design 4** (§3.6): the entire
inverse-projection/Jacobian/periodic-generator core (`MAX_MAGNIFICATION`,
`computeApertureMagnification`, `apertureWindowSdfParts`/`apertureWindowSdf`/
`apertureFloorSdf`, `distanceToNearestGridLine`) is DELETED, replaced by a
smaller set of explicit per-mullion interval tests — no Jacobian, so no
"does the blur band exceed the magnified bar width" failure mode is even
possible any more. §5's own blur law and the compositing/visibility work
(§6, §13.10-13.12) both survive completely untouched — this rewrite only
replaces WHAT the pattern-generation math computes, not where it blends or
when it's visible.

**Design 4's own first live look found a real bug (§3.7, "THE CONTRAST
FLOOR") and, after that fix, STILL no visible cookie.** Two more rounds each
found a real, verified defect — a `defaultLampHeightPx` sitting below the
window's own head, making every row boundary above the sill geometrically
unreachable at any distance (§13.13); a debug view whose OWN alpha
accidentally depended on `visibility`, making two genuinely different
failure modes ("the pattern is wrong" vs "the pattern is right but
throttled") indistinguishable from one screenshot — but NEITHER round
produced a screenshot the author called convincing, and the diagnostic loop
itself (live Foundry, screenshot, JSON dump, theorise, repeat) was the
author's own next target: *"Change your approach. I need you to build a
test in the shader lab, walls, windows and a light source on one side of the
window. Then I want you to run through the problems until you get a
convincing shape on the window panes on the other side of the window."*

**§13.13 is that pivot, and it is where this effect first produced a
measured, reproducible, genuinely convincing result** — real production code
(`buildPointLightIlluminationMaterial` + `buildApertureShadowMaterial`),
real WebGPU device, real pixel readback, zero Foundry/concurrent-edit/other-
effect confounds. The bench found ONE MORE real bug — the visibility gate
itself (§13.12's own fix) was a genuine Weber contrast ratio, which
approaches full strength only asymptotically, capping every mullion's
darkest point far short of true ambient even under an obviously-dominant
night light. Reshaped to saturate at a modest, named ratio instead (§13.13
has the measured numbers). Whole-repo suite green throughout (7119
assertions, 20 suites), `verify:structure`/`lint`/`format:check` green, AND
— for the first time — the shader-lab bench's own `night-clear-pattern`,
`visibility-diagnostic`, and `noon-is-a-no-op` scenarios all green too, with
a saved PNG that shows an actual, legible, high-contrast mullioned window
pattern. **Still BUILT (unverified), not LIVE** — this is real evidence, not
a live-Foundry confirmation, and the two are not the same claim (see this
project's own standing rule on the distinction). See §12 for exactly what
has and hasn't been checked, and §13 for every place the shipped code — or a
live test — corrected this document rather than the other way around.

Author brief, 2026-08-03, with a screenshot + a red overdraw:

> *"a light inside a building which is casting light through the window on a wall
> and outside… create a shadow which aligns with the light and which causes the
> window in the wall to project a light which is shadowed using a simple
> procedural window geometry generating system. We modify the amount of blur in
> the light the further it is away from the center of the light to the edge of
> the dim radius."*

The overdraw showed the answer as clearly as the words did: pane-shaped quads
inside the existing light fan, **widening with distance**, plus a 2×3 mullioned
window drawn in the margin as the source pattern.

---

## 0. The one-sentence model

**A window is a rectangle in a vertical plane; the ground is a horizontal plane;
a lamp is a point — so the pattern on the ground is a plane-to-plane point
projection, which has a closed form, and the direction we actually need (ground
pixel → window coordinate) is the numerically well-behaved one.**

Everything below is consequences of that sentence.

---

## 1. What this is NOT — read before anything else

This is **not** a resurrection of the aperture reading of the window mask.
[[keyhole-windows-aperture-design]] records, correctly, that an earlier draft read
the painted window mask as *a hole in a wall* and over-built jump-flood distance
packs, aperture tables, projected beam quads and a two-way valve — all of it
computing something the author already paints. That ruling stands. **The painted
window mask is the LIGHT.** Nothing here touches it.

The difference is the noun's *source*, not the noun:

| | `Windows.md` (built, tier 0) | This doc |
|---|---|---|
| What it is | a hand-painted interior gobo | a procedural exterior gobo |
| Driven by | the sky / daylight | **one point light** |
| Aperture from | nothing — no aperture exists | **a Foundry wall segment** |
| Lands as | ADD onto the illum buffer | **MULTIPLY inside one light's own falloff** |
| Author authors | a painting | ~8 numbers per window |

They are complementary and must never fight: the painted cookie is daylight
falling *into* a room; this is a lamp throwing its window's pattern *out* of one.
A scene can legitimately run both at once, on the same wall, at different hours.

Name it `apertureGobo`, not `window*`, so nothing in the existing `window` effect
namespace collides.

---

## 2. Where an aperture comes from — it is already in the data

The fan in the author's screenshot **exists because Foundry already let light
through that wall segment.** Foundry's `ClockwiseSweepPolygon` clipped the light
polygon around the solid wall and let it spill through the permeable span. MSA
then fan-triangulates *Foundry's own* clipped `shape.points`
(`point-light-illumination.js`, `triangulateLightFan`). So the angular extent of
the beam is already correct, already on screen, already parity-safe.

What Foundry does **not** give us is the *vertical* half of the window — the
sill, the head, the mullions. That is all this effect adds.

### 2.1 The predicate

> ⚠️ **CORRECTED LIVE, 2026-08-03, same session this shipped.** The first cut
> below read `light === NONE` — plausible straight from the schema, WRONG in
> practice. The author corrected it directly, from actually authoring windows
> in Foundry: **`light: PROXIMITY` is Foundry's own real convention for a
> window**, not `NONE`. Matching on `NONE` over-matched hugely on a real map
> (317 candidate aperture/light pairings found, 189 dropped by the per-light
> cap) and produced visible knock-on effects on ordinary terrain walls that
> were never meant to be windows — `NONE` is a much blunter "permanently
> transparent to light" choice used for all sorts of things (decorative
> dividers, terrain edges) that are not windows at all. Left both readings
> here, struck-through, rather than silently replaced — see
> [[feedback_membership_beats_derived_threshold]]: `NONE` LOOKED like the
> right membership test without being the authored one.

Verified against the vendored v14 source (`common/constants.mjs:1428`,
`EDGE_SENSE_TYPES.PROXIMITY = 30`; `common/documents/wall.mjs:58`, `light` is
a sense-type field):

> **A wall is an aperture iff it blocks movement and its light sense is
> `PROXIMITY`.** `move !== NONE && light === PROXIMITY`
>
> ~~A wall is an aperture iff it blocks movement but does not block light.~~
> ~~`move !== NONE && light === NONE`~~ — **WRONG, see the callout above.**

`PROXIMITY` is Foundry's real "this is a window" feature: the wall stays
opaque to light until a source sits within its own `threshold.light`
distance, then light passes. That is precisely how a GM already authors a
window in Foundry today. No new document, no new flag, no new authoring step
for tier 0 — and no re-implementation of the threshold itself needed here
either: Foundry's own sweep has already decided whether light crosses a given
wall for a given source by the time that light's mesh/fan even exists to draw
on (§2 above). This predicate only answers "is this wall the KIND that a
window pattern belongs on", never "is light passing through it right now".

`src/foundry/scene-walls.js` is the right home and already has the exact idiom —
two pure predicates over raw wall fields (`deriveWallSolid`,
`deriveWallBlocksExterior`), each Node-tested, each with a header paragraph
explaining which fields it deliberately ignores. This is a **third sibling**:

```js
export function deriveWallAperture({ move, light } = {}) { … }
```

⚠️ Note the asymmetry with its siblings, and write it in the header: those two
read `move` and deliberately ignore `sight`. This one reads `move` **and
`light`**, and still ignores `sight` — a leaded glass window that blocks sight
but passes light near it is a real thing an author will draw, and it is an
aperture.

`readSceneWallSegments()` currently returns
`{x1,y1,x2,y2,solid,blocksExterior}`; it gains `aperture: boolean`.

### 2.2 Which apertures belong to which light

Cheap CPU pass, recomputed only when walls or lights change (both already have
watchers — `watchSceneWallStructure`, `watchDoorOpenings`):

1. aperture walls whose segment intersects the light's dim radius
2. …that the light is on one side of
3. …ordered by angular width as seen from the light, keep the widest **N**

**N is a cap, so it must be reported, never silent** — see
[[feedback_silent_cap_corrupts_hard_boundary]] and the standing no-silent-caps
rule. `buildApertureGoboReport` names every light that had apertures dropped and
how many. Start at N = 4.

### 2.3 Two things that come free, and one that doesn't

**Cone lights need no special case.** There is no `angle`/`rotation` on MSA's
light snapshot at all — a cone is already a cone because `shapePoints` came out
of Foundry's sweep with the angle applied. The gobo multiplies whatever fan is
there.

**MSA-authored lights (candles, lightning) get apertures free too.** They start
as naive circles and are re-clipped by `computeCandleWallClippedShape`
(`scene-wall-clip.js:152`), which calls Foundry's own
`polygonBackends.light.create` with `type: 'light'` — so Foundry's `wall.light`
sense is applied there identically. An aperture wall is already permeable for a
candle. Nothing extra to write.

**What doesn't come free: the wall a light passes through may not be the wall
nearest that pixel.** Two windows in an L-shaped corner both illuminate the same
patch of ground. That is what the `max` in §6.1 is for, and it is why the
aperture list is per-light rather than a single nearest-wall lookup.

---

## 3-5. SUPERSEDED BY DESIGN 4 (2026-08-03) — kept as historical record, read §3.6 first

> ⚠️ **§§3-5 below describe designs 1-3's shared pattern-generation core: an
> inverse plane-to-plane projection into a virtual window-plane `(s_w, z)`
> coordinate, a Jacobian rescaling window-space distances into floor-space,
> and a periodic procedural generator authored in that window-space.** That
> whole approach is DELETED from the shipped code as of design 4 — kept here
> only as the historical record of why it was tried and what it got right
> (the blur law, §5, survives verbatim). Read §3.6 for what actually ships.

### 3.6 Design 4 — mullions as blockers, not a projected image

The author's own reframing, confirmed against the vendored Foundry source
before acting on it: `light.shapePoints` (`foundry/scene-lights.js`) is
Foundry's OWN wall-clipped light polygon, and `Edge#applyThreshold`
(`clockwise-sweep.mjs`) confirms a `light:PROXIMITY` wall is genuinely
passable to a light source within `threshold.light` of it — which an
interior lamp near its own window always is. So the beam's OUTER shape
(bounded by the solid walls either side of the window) was never this
effect's problem to solve; Foundry's own polygon sweep produces it, for
free, before this effect's mesh is even built. Five live rounds of design
1-3 never once produced a pattern that read as a clean pane grid — only
smeared fields and misaligned blobs — because the Jacobian that made this
possible (`magAlong`/`magPerp`) is exact but UNBOUNDED, and an ordinary
torch-to-window distance already sends it into the tens.

What remains, once the outer shape is someone else's problem: punch
mullion-shaped NOTCHES into a beam whose boundary is already correct.

- **A vertical mullion is an ANGULAR blocker.** It subtends a FIXED sliver
  from the light at every distance — compared directly in the SAME
  inverse-projected `sW` designs 1-3 already computed (`projectFloorPointToWindow`,
  survives design 4 with `z` removed), in wall-space units, against that
  bar's own `[lo, hi]` span. No Jacobian: the comparison never leaves
  window-space, so there is nothing to magnify.
- **A horizontal mullion (or sill/head) is a RADIAL blocker.** `z` depends on
  `x` (floor distance from the wall) ALONE — not on lateral position at all,
  the exact separability the old Jacobian's own zero `dz/ds` term already
  proved. Invert `z = h*(1-a/(a+x))` ONCE per boundary (`computeApertureRowBoundaryX`)
  to get a floor-space `x` threshold, then compare a point's own `x` directly.
- **Combine** every gate (frame, each vertical band, sill, head, each
  horizontal band) via `min`, in a consistent "positive = open" sign
  convention, SEPARATELY per axis (`computeApertureSpokeGate`/
  `computeApertureArcGate`), THEN smoothstep each axis's own combined gate in
  ITS OWN natural unit (§5's blur law, survives verbatim), THEN `min` the two
  already-normalised `[0,1]` "openness" fractions. Blur only ever compares
  like units to like — there is no "does the blur band exceed the magnified
  bar width" failure mode left, because nothing is magnified.

**Deleted, not kept alongside the new code:** `MAX_MAGNIFICATION`,
`computeApertureMagnification` (the whole Jacobian), `distanceToNearestGridLine`,
`apertureWindowSdfParts`, `apertureWindowSdf`, `apertureFloorSdf`. The
replacement is smaller than what it replaced.

**A deliberate, reasoned behaviour change:** designs 1-3 treated "lamp height
at or below the window's sill" as `applicable:false` (fail-open — this
aperture excluded from the combine, as if it weren't there). Design 4 reads
it as `applicable:true, gobo->0` instead — a lamp that physically cannot
clear its own windowsill genuinely lets NO light escape that window, which
is a real, meaningful DARK render, not "pretend this window doesn't exist."
It also falls out of the general `x_sill = Infinity` math with no special
case. `feedback_gate_polarity_must_fail_open` is about robustness to
MISSING or BROKEN data, not about how to render a valid, deliberately-
authored geometric configuration.

**`cols`/`rows` are no longer live uniforms.** They control an UNROLL COUNT
(how many mullion bands get baked into the graph) now, not a value inside an
already-fixed structure, so `aperture-gobo-render.js` treats them as
GRAPH-BUILD-TIME JS integers — part of the material's own rebuild key,
exactly like `apertureCount` — rather than reaching for a TSL
`Loop`/`uniformArray` to keep them live (`feedback_tsl_select_chain_strands_vars`'s
own landmine class). Changing "Panes across"/"Panes down" in the debug panel
now triggers a rebuild instead of a live write — cheap, and the same
mechanism every other structural param already uses.

**Full derivation, verified against a numeric CPU twin (not just re-trusted
algebra):** `aperture-gobo.js`'s own "DESIGN 4" header, and
`__tests__/aperture-gobo.test.mjs`'s spoke-gate/arc-gate/row-boundary blocks.

### 3.7 THE CONTRAST FLOOR — found on design 4's own first live look

Author's report, verbatim: *"Literally no evidence of it working at all."*
The FIRST look at design 4, live — no wedge seam this time (that part of the
fix held), but also no pattern, day or night, debug off.

**Root cause, measured against the real code, not assumed:** §5's blur law
(`SOFT_FAR_PX_BASE = 48`) was left numerically unchanged from designs 1-3 —
but that constant was calibrated for a world where a thin mullion's
FLOOR-projected width had already been scaled up by the (now-deleted)
Jacobian, by up to `MAX_MAGNIFICATION` (10x), before blur was ever compared
against it. Design 4 compares blur directly against a mullion's OWN,
un-magnified width — a few px, per the schema's own default (`mullion: 4`).
Run through the real `computeApertureSpokeGate`/`computeApertureSoftPx`:
with the schema's own defaults, a mullion's own CENTRE — the single darkest
point that exists — read `gobo = 0.415` at `dist01 = 0.5`, and never dropped
below ~0.42 anywhere past roughly a third of the way to the light's own dim
radius. The blur law was not softening the pattern's edges; at any distance
from the light beyond a small near-field ring, it was erasing the pattern
outright, and a photo-real, textured floor easily buries a 0.42-vs-0.47
gradient with no hint of a line.

**Fix:** cap the blur width used for EACH axis's own smoothstep at half that
axis's OWN thinnest relevant feature — `min(mullion, frame)` for the spoke
axis, `mullion` for the arc axis (sill/head are one-sided boundaries, not
thin bars, so not vulnerable to this same failure). This guarantees a bar's
own centre reaches the smoothstep's true zero-crossing (`gobo == 0` exactly)
regardless of `dist01` — blur still grows and softens the EDGES right up to
that cap as `dist01` rises (the author's own rule survives, unmodified in
spirit), but can never grow wide enough to swallow the feature whose edge it
is meant to be softening. `computeApertureSoftPx`'s own raw curve is
untouched; `computeApertureGoboTerm` caps its OUTPUT, per axis, before
`smoothstep01`.

**Verification:** a dedicated regression test reproduces the exact live
symptom numerically — a mullion's own centre must read `gobo < 0.05` at
EVERY `dist01` from 0 to 1, not just near the light — pinned permanently in
`__tests__/aperture-gobo.test.mjs` ("THE CONTRAST FLOOR"), not just fixed
and trusted. Still open, honestly: whether this is the ONLY remaining gap
between "the math is right" and "the picture reads as a window" — the next
live round is what answers that, this document cannot.

## 3. The geometry — SUPERSEDED, see §3.6 above

### 3.1 Wall-local frame

Wall from **A** to **B**. `dir = normalize(B − A)`, `nrm = perp(dir)`.
Flip `nrm` so the light sits on the negative side. Then for any world point **P**:

```
s = dot(P − A, dir)      // along the wall
x = dot(P − A, nrm)      // perpendicular; exterior is x > 0
```

Light **L** gives `s_l`, and `a = −dot(L − A, nrm) > 0` (its distance from the
wall plane). `h` is the lamp's height above the receiving floor (§3.5).

### 3.2 Forward projection — stated only to be discarded

A window point at along-wall `s_w`, height `z`, projects to:

```
k = h / (h − z)                    // magnification, ≥ 1
x = a·(k − 1)
s = s_l + k·(s_w − s_l)
```

Two things fall straight out, and both match the author's drawing:

- **A horizontal mullion (fixed `z`, all `s_w`) → a straight line parallel to the
  wall,** because `x` does not depend on `s_w` at all.
- **A vertical mullion (fixed `s_w`, all `z`) → a straight spoke radiating from
  the light.**

So the pattern on the ground is a grid of wall-parallel cross-bars and
light-radial spokes, and the pane cells are trapezoids that widen with distance.
That is exactly what was drawn in red.

**But `k = h/(h − z)` blows up as `z → h`, and goes negative above it.** So we
never evaluate it.

### 3.3 Inverse projection — the one we actually run

A fragment shader asks the opposite question: *given this ground pixel, which
part of the window is it looking through?* Invert:

```
inv = a / (a + x)                  // ONE divide, and it cannot blow up
z   = h · (1 − inv)
s_w = s_l + (s − s_l) · inv
```

This is the whole effect's math. Note what it buys:

- **`a + x ≥ a > 0` always** (exterior means `x ≥ 0`). Clamp `a ≥ 1px` for a lamp
  standing in the wall plane and there is no singularity anywhere.
- **`inv ∈ (0, 1]`**, so **`z ∈ [0, h)`** — the entire infinite exterior maps
  into a bounded height range, monotonically. The far field compresses toward
  the lamp height instead of diverging.
- **One divide**, shared by both outputs. ~12 ALU including the frame transform.

The badly-conditioned direction is the one we don't need. That is the single
reason this design is cheap enough to live inside an existing shader.

### 3.4 This adds no perspective

[[keyhole-orthographic-hole-stack-model]] is law: the camera is orthographic,
bird's-eye, no vanishing point. **Nothing here touches the camera.** The
projection above is *light transport* — where photons land — not a view
transform. The lit patch it produces is a genuine plan-view footprint, exactly
as flat as the floor it sits on. A real overhead photograph of a room with a
mullioned window shows precisely this figure.

The hole-stack rule does bite in one place, and it is a tier-3 rung, not tier 0:
**`z`, `h` and the receiving plane are all measured from the floor the beam
actually lands on.** If the beam crosses a hole, the light keeps travelling and
lands further out, on the floor below, from a *larger* `h`. Tier 0 evaluates
against the visible surface's own floor and accepts the seam at a hole edge;
§7 rung 3 fixes it by re-evaluating per resident floor slot, the same way
`blendSunVisibilityAcrossFloors` already does for sun shadows.

### 3.5 Where `h` comes from

Foundry's `AmbientLight` has `elevation` (`common/documents/ambient-light.mjs:39`),
in scene distance units. So:

```
h = max(minLampHeightPx, (light.elevation − floor.elevation.bottom) × pxPerUnit)
```

with `pxPerUnit = grid.size / grid.distance`, falling back to
`defaultLampHeightPx` when the light sits flat on its floor — which is what most
GMs will have, since nobody sets elevation on a torch.

⚠️ **This is not a violation of [[feedback_elevation_is_sort_key_not_offset]].**
That rule says a raised *sprite* never moves in (x, y) — elevation re-sorts draw
order, it does not translate art. Here elevation is being read as a **physical
height for a light-transport calculation**, and the lamp's own sprite still does
not move by one pixel. Write that distinction into the file header, because the
next reader will flinch at it.

Sill and head (`z0`, `z1`) are per-aperture, defaulting to fractions of the
scene's wall height — `sun-shadows.js` already carries a `wallHeightPx`, so reuse
it rather than inventing a second opinion about how tall a wall is.

**The sill is the knob that sells the whole effect.** `z0 > 0` puts the near edge
of the patch at `x0 = a·z0/(h − z0)` — a dark strip at the foot of the wall,
which is what a real window does and what a doorway does not. A plain gap
(`z0 = 0`) spills right up to the wall, matching the screenshot. `z1 ≥ h` sends
the far edge past the dim radius, which is correct and needs no special case.

---

## 4. The procedural window generator — SUPERSEDED, see §3.6 (design 4 uses explicit mullion bands, not this periodic generator)

Pure function, no texture, no geometry. Input `(s_w, z)` in wall-plane world px,
output a **signed distance in wall-plane px** — positive in glass, negative in
frame/mullion/outside.

```
cols, rows          pane counts                          default 2 × 3
frame               outer frame thickness (px)           default 6
mullion             inner bar thickness (px)             default 4
z0, z1              sill and head height (px)            default 0.35 / 0.85 × wallHeight
style               rect | arch | round | diamond | louvre | barred
arcRise             head curvature, `arch` / `round`
seed                per-wall hash → small jitter so a terrace isn't a xerox
glassTint, transmit per-pane colour and transmission
```

```
d_open = sdBox(window rect, inset by frame)
d_barS = |fract-distance to nearest vertical   bar| − mullion/2
d_barZ = |fract-distance to nearest horizontal bar| − mullion/2
d      = min(d_open, d_barS, d_barZ)
```

Styles are variations on that, not new machinery: `arch`/`round` intersect a
circle at the head, `diamond` rotates the bar lattice 45° and changes the pitch,
`louvre` drops the vertical family and tilts the horizontal one, `barred` uses
thick verticals with no horizontals.

**`glassTint` is the cheap money shot.** Per-pane hue, keyed off the pane index,
gives stained glass throwing coloured lozenges across a courtyard for the cost of
one `hash → palette` lookup. It is the single highest look-per-line item in this
whole document and it is nearly free once the pane index exists.

⚠️ **Hash the seed before it touches noise.**
[[feedback_raw_seed_into_noise_coordinate]] — `mx_noise_float` returns NaN on
billion-scale input, and a wall id is exactly that.

---

## 5. Blur — the author's rule, implemented as a widening, not a blur (SURVIVES design 4 verbatim — `computeApertureSoftPx` is unchanged)

> *"modify the amount of blur in the light the further it is away from the center
> of the light to the edge of the dim radius"*

**There is no blur pass.** The pattern is already a signed distance field, so
softening it is one `smoothstep` whose *width* is a function of radius:

```
soft = mix(softNearPx, softFarPx, pow(dist, softCurve))
gobo = smoothstep(−soft, +soft, d_floor)
```

Defaults: `softNearPx = 1`, `softFarPx = 48`, `softCurve = 1.5`.

**`dist` is free.** The light mesh lives in *local unit-radius space* —
`triangulateLightFan` builds it there, the mesh is then placed at `(x, y)` and
scaled by `radius`, and the shader's very first line is
`dist = length(positionLocal.xy)` (`point-light-illumination.js:599`). Since
`radius = max(dim, bright)`, **`dist` already is "fraction of the way from the
centre of the light to the edge of the dim radius"** — literally the author's
own phrasing, already computed, already in scope. The blur law costs one `mix`
and one `pow` and needs no new uniform at all.

Five things this buys, each of which a separable blur pass would have cost us:

1. **No extra render target, no extra pass, no cache to invalidate.**
2. **No cross-wall bleed.** The layer-smear subsystem still carries a live
   artifact where a distance-scaled blur kernel picks up an unrelated wall
   ~1–2 texels off the ray ([[keyhole-layer-smear-model]], "still open"). A pure
   function of the analytic field cannot do that — there are no neighbouring
   pixels to bleed from. This is the same argument
   `point-light-illumination.js` already makes in its own header for choosing
   `sdPolygonEdgeDistance` over a screen-space blur.
3. **Monotonic by construction.** `soft` is monotonic in `r`, so pattern contrast
   only ever decreases outward. It cannot go black → grey → black. THE LAW from
   the sun-shadow work is satisfied for free rather than swept for.
4. **The beam dissolves on its own.** Once `soft` exceeds the local pane pitch
   the pattern washes out to a smooth fan. **That is the intended behaviour and
   must be written down, or someone will "fix" it later.**
5. **It softens the edge without MOVING it** — which is the exact trap
   `layer-smear-render.js:33–58` records as a live regression (`GATE_AA_LOD` was
   `log2(4)` for one afternoon: *"blurring the gate does not soften an edge, it
   MOVES it"* — the shadow started weak at the wall and only reached full
   strength 21px out). A symmetric `smoothstep(−soft, +soft, d)` keeps its 50%
   crossing pinned at `d = 0` by construction, at every softness. Mip-blurring a
   one-sided ramp cannot make that guarantee. **Contact hardening outranks edge
   smoothness** there and here alike: the pane edge at the sill must stay sharp.

### 5.1 The Jacobian — the one easy-to-miss correctness detail

`d` comes out in **wall-plane** px, but `soft` is authored in **floor** px. The
projection magnifies, so they must be reconciled or the softness will be wrong by
a factor that grows with distance.

The magnification is anisotropic — and conveniently, so is the SDF, since both
bar families are axis-aligned in window space:

```
k          = 1 / inv = (a + x) / a
mag_along  = k                    // vertical bars → spokes
mag_perp   = a·k² / h             // horizontal bars → cross-bars
d_floor    = min(d_barS × mag_along, d_barZ × mag_perp, d_open × min(both))
```

Scale each family by its own magnification and it is exact, at a cost of two
multiplies. Using `k` for both is the tempting shortcut and it makes the
cross-bars visibly wrong in the far field.

### 5.2 A variant worth offering

Absolute-px softness (above) is what was asked for. A second mode expresses
`soft` as a **fraction of the local pane pitch**, which guarantees a clean
dissolve at a chosen radius regardless of how fine the window is. Both are one
line; ship the author's rule as default and the other as a `softnessMode` enum.

---

## 6. Where it lands — a genuine shadow pass, REWRITTEN 2026-08-03, TWICE

> ⚠️ **This section now describes the THIRD design.** Design 1 multiplied the
> gobo term into one point light's own falloff (§13.10 — structurally wrong,
> a `MAX`-blended light can never darken below ambient). Design 2 replaced
> that with a genuine `MULTIPLY` pass — correct in that it COULD darken below
> ambient, but with no floor of its own, so it could darken below ambient
> **too far**: multiplying the whole accumulated buffer crushes bright
> daytime ambient toward black in a blocked region just as readily as it
> darkens a dim room (§13.11). Design 3 (this section) blends toward each
> light's own `backgroundFloor` instead of multiplying outright — worth
> reading §13.10 AND §13.11 once, since each reads as obviously right until
> traced all the way through to the OTHER time of day.

The effect is a **third dedicated scene** (`point-light-pool.js`'s own
`apertureShadowScene`, sibling to `lightScene`/`colorationScene`), rendered
in `runLightAccumulatePass` right **after** point lights accumulate and
before the window-cookie ADD:

```
ambient fill        (OVERWRITE)
region darkness     (OVERWRITE within footprint)
point lights        (MAX)
aperture shadow      (blend toward backgroundFloor)   <-- here
window cookie        (ADD)
```

For every light with `apertureCount > 0`, TWO meshes share the SAME fan
geometry the point light's own illumination mesh already built
(`triangulateLightFan` — no duplicate triangulation):

- **`material`** — the real effect. An ordinary alpha-over blend
  (`blendSrc: SrcAlphaFactor, blendDst: OneMinusSrcAlphaFactor` on RGB).
  Fragment RGB = `backgroundFloor` — THIS light's own "as if this light
  contributed nothing here" colour, the SAME node
  `point-light-illumination.js` computes for its own material and now
  returns rather than keeping local, so the two never disagree about what
  "ambient" means at a given fragment. Fragment alpha = `1 - strengthed`
  (the blend-TOWARD weight: 0 = untouched, `strength` = fully at
  `backgroundFloor`). The target's own alpha channel passes through
  unmodified (`ZeroFactor`/`OneFactor` — the identity, matching
  `window-render.js`'s own alpha discipline): fragment alpha here is a blend
  WEIGHT, never written to the target.
- **`debugMaterial`** — unchanged by this rewrite. A genuine alpha-blended
  overlay, drawn INSTEAD of `material` (never both — `point-light-pool.js`
  toggles `mesh.visible` between the two, a CPU-side switch; blend mode is
  fixed per-material, so a uniform cannot pick between the two at runtime).
  RGB = the raw gobo term, alpha = `anyApplicable` (1 where a window
  genuinely reaches this fragment, 0 elsewhere) — invisible outside the
  affected region, opaque grey/white/black inside it, sitting naturally on
  top of the real, unmodified scene.

**Why blend-toward-`backgroundFloor`, and why it MUST be AFTER point lights:**

- `result = mix(backgroundFloor, dst, strengthed)`. At full strength and full
  occlusion, `result == backgroundFloor` EXACTLY — never brighter, never
  darker than "what would be here without this light," which is correct AT
  NOON (`backgroundFloor` is bright daylight there) and AT NIGHT
  (`backgroundFloor` is Foundry's own darkness tint, or true black under the
  darkness-realism lever) — the SAME formula, two correct answers, because
  `backgroundFloor` already carries the time-of-day distinction so this
  formula doesn't have to.
- Unlike design 2's pure multiply, **ordering is no longer mathematically
  free** — this pass needs `dst` to already hold this light's own MAX'd-in
  contribution (that's the thing being shadowed), so it must draw after
  point lights, not before. Placing it there also means a light standing
  behind its own window has **its own corona** shadowed by the pattern too,
  not only the ambient floor underneath it — true under design 2 as well, but
  now a requirement, not a free bonus.
- **A separate additive pass cannot do this at all**, because the effect is
  *subtractive* — the one thing every design so far has agreed on. Three
  other effects in this repo have already made the additive-onto-something-
  already-composed mistake; this must not be the fourth.
- **Known scope limit, not fixed by this rewrite:** `apertureShadowScene`
  draws every aperture-having light's shadow mesh in ONE render() call, after
  ALL point lights (not just this one) have already accumulated. So an
  unrelated light B, if it also reaches a pixel light A's window shadows,
  gets pulled toward A's `backgroundFloor` too — identical blind spot to
  design 2's multiply, not introduced by this rewrite. True per-light
  isolation would need a per-light offscreen buffer; nothing observed live
  points at this being a real problem (windows are sparse, overlaps rarer
  still), so it stays a documented gap.
- **The blend weight is further scaled by a VISIBILITY gate (§13.12), found
  necessary on the FIRST live look at this very design.** Being bounded by
  `backgroundFloor` stops the shadow from going PAST ambient; it does
  nothing to stop the shadow from being visible when this light's own
  UNSHADOWED corona is already brighter than ambient nearby (routine at
  noon, right next to any reasonably bright light) — which read live as a
  hard-edged wedge reshaping that corona, not a cookie shaping it.
  `buildApertureShadowMaterial` now multiplies `(1-strengthed)` by
  `visibility`, a Weber-contrast ratio between this light's own natural
  luminance (`finalColorExposed × combinedFalloff`, both shared from
  `point-light-illumination.js` the same way `backgroundFloor` is) and
  `backgroundFloor`'s own luminance — `0` wherever ambient already outshines
  this light (a genuine no-op, not merely bounded), rising toward `1` only
  where this light's own corona genuinely dominates, and smooth/monotonic in
  `combinedFalloff` so the shadow's reach automatically tapers where the
  light's own natural falloff does. See `aperture-gobo-render.js`'s own "THE
  VISIBILITY GATE" header and
  `aperture-gobo.js#computeApertureShadowVisibility` (its numerically-tested
  CPU twin) for the full derivation.

Per-light aperture uniforms are the established idiom — **there is no light
pool struct, no storage buffer, no instanced array.** Every light is its own
`Mesh` + its own `NodeMaterial` with its own TSL `uniform()` nodes, written
per-frame in `point-light-pool.js`. So this goes nowhere near the
8-buffers-per-stage WebGPU cap ([[keyhole-storage-buffer-limit-fix]]).

### 6.0 ⚠️ THE LANDMINE — still relevant, read before touching either material

`point-light-illumination.js` still carries ONE fully-built, never-enabled
term — `edgeSoftFactor`, an analytic polygon SDF via a TSL `Loop` over a
`uniformArray(vec2, 64)` bounded by a uniform (`uEdgeCount`). Wiring it in
**turned the whole scene black in a live test and the cause was never
found** — that file's own header forbids re-enabling it without a live A/B.

**Why this design is very likely not the same failure — a real structural
difference, not optimism:** `Loop`/`uniformArray`/uniform-bounded iteration
are the known hazard class here — most pointedly
[[feedback_tsl_select_chain_strands_vars]], where a TSL fold compiled to real
branches, stranded shared variables, and turned 12 of 20 outputs black. **The
aperture gobo needs none of that machinery.** No `Loop`, no `uniformArray`.
Aperture count is small (≤4) and known at graph-build time, so the fan-out is
a JS `for` loop that *unrolls* into straight-line arithmetic — the same shape
`layer-smear-render.js`'s own 32-station march already uses safely. Nothing
in it can strand a variable because nothing in it branches.

**Consequence — aperture count is a material rebuild key**, exactly like
`falloffModel`/animation type already are (`tsl/no-uniform-gates`). Lights
whose aperture count is stable — nearly all of them, nearly always — never
rebuild EITHER the illumination material or the two new shadow materials.

**The debug material IS the "ship the instrument first" mitigation** the
first design's own header called for — now a real, separate overlay rather
than a shared-material swap, so the A/B is a two-click comparison
(`MapShine.setApertureGoboDebug(true)`) with no risk of the debug path itself
perturbing the real render's own material graph.

### 6.1 Combining rules

- **Between apertures on the same light: `max`.** They are alternative paths
  for the same photons — a union. Taking the product would double-shadow a
  pixel lit through two windows. Unchanged by the rearchitecture — this
  combine happens inside `buildApertureGoboTerm`, which both the old and new
  designs share verbatim.
- **Between lights: no longer a clean algebraic law, and that is recorded
  honestly rather than papered over.** Design 2's pure multiply compounded
  two overlapping apertured lights as `illum × gobo_A × gobo_B` — independent
  occluders in series, the exact law [[keyhole-layer-smear-model]] proved for
  the sun. Design 3's blend-toward-`backgroundFloor` mesh draws once per
  light-with-apertures too, but each draw is a `mix()` toward that light's
  OWN `backgroundFloor`, not a multiply — so light B's pass, drawn after
  light A's, blends A's already-shadowed result toward B's background rather
  than compounding two transmittances. In the common case (both lights share
  the same local ambient — most of a scene, most of the time) this still
  resolves sensibly; it is a real, undemonstrated-live divergence from the
  clean product law in the uncommon case (two apertured lights, in
  DIFFERENT ambient regions, both shadowing the same pixel). Same "known
  scope limit" as §6's own closing bullet, not a separate issue.
- **Absent aperture data must decode to `gobo = 1`.** Fail open.
  [[feedback_gate_polarity_must_fail_open]] — a light with no windows
  contributes NO mesh to `apertureShadowScene` at all, so the shared buffer
  is untouched, never a stray multiply by an uninitialised value.

### 6.2 Files touched

| File | Change |
|---|---|
| `src/foundry/scene-walls.js` | `deriveWallAperture` + `aperture` on segments |
| `src/effects/lighting/aperture-gobo.js` | pure CPU twin: frame transform, inverse projection, generator SDF, blur law, aperture→light assignment, magnification cap |
| `src/effects/lighting/aperture-gobo-render.js` | TSL transcription (`buildApertureGoboTerm`) + `buildApertureShadowMaterial` (the blend-toward-`backgroundFloor`/debug material pair) + `createApertureGoboSharedUniforms` |
| `src/effects/lighting/point-light-pool.js` | a THIRD scene (`apertureShadowScene`), a mesh PAIR per light-with-apertures sharing the illumination mesh's own geometry, per-frame aperture uniform writes, mesh-visibility debug toggle, threads `backgroundFloor` from the illumination build into the shadow build |
| `src/effects/lighting/point-light-illumination.js` | apertures-UNAWARE again — the integration was reverted out entirely — but now RETURNS its own `backgroundFloor` node so the shadow pass can share it rather than re-derive a coarser guess |
| `src/vt/vt-pan-viewer.js` | one new `renderer.render(pointLights.apertureShadowScene, camera)` call in `runLightAccumulatePass`, after point lights |
| `src/vt/vt-pan-viewer-diagnostics.js` | bridges `_active.getApertureGoboInfo()` into the flat diagnostics object (found missing live — §13.8's own sibling bug) |
| `src/effects/aperture-gobo.js` + `src/effects/aperture-gobo-registration.js` | manifest, schema, cascade layer, console setter, readout — mirror `window-registration.js` |
| `src/boot.js` | `registerPanel` card + `registerReport` + `EFFECT_REAPPLIERS` entry |

**No new pass in `graph/passes.js`, no new render target, no new mask kind.**
One new Scene, one new draw call in an existing pass, one new material pair —
the smallest change that could make the effect a genuine shadow rather than a
light modifier.

There is no `-surface-subsystem.js` in that list, and that is deliberate: the
four-file effect pattern exists for effects that own a mesh and a scene in
the ordinary sense (a bounded quad cropped to mask content). This effect owns
a Scene, but not that kind of surface — it borrows the point light's own fan
geometry entirely, for every mesh it draws.

---

## 7. Tier ladder

| Rung | What | Cost |
|---|---|---|
| **0** | Foundry-derived apertures, `rect` style, global default window params, distance blur | ~15 ALU/px |
| 1 | Per-wall MSA flags: `flags.msa.window = {cols, rows, sill, head, frame, mullion, style}` | — |
| 2 | Style library + per-pane `glassTint` (stained glass) | ~6 ALU |
| 3 | Hole-stack correctness — re-evaluate per resident floor slot | one loop |
| 4 | **Wall thickness / reveal.** A thick wall's reveal narrows the aperture at oblique angles by `w·tan θ`. One extra knob, ~4 ALU, and it is what stops a beam looking painted-on when the lamp is off to one side. | ~4 ALU |
| 5 | Shutters / open casement — animate `open01`, the sash swings and its own shadow sweeps | — |
| 6 | Shared window *art*, so the drawn window and its cast pattern come from one description | — |

Rung 6 has a strong existing precedent: **`src/effects/door-graphics-*.js`
already generates procedural door art from Foundry wall documents**
(`DOOR_STYLES.SINGLE / DOUBLE_LEFT / DOUBLE_RIGHT`, swing animation, snapshots).
A window-graphics sibling reading the same aperture description is the natural
companion, and then the pattern on the ground and the window on the wall can
never disagree — which is the failure mode of authoring them separately.

Rung 4 is the one I'd argue up the list if the tier-0 result looks flat.

---

## 8. Params, FOH / ROH

One schema, validated by `validateParamsSchema` (`src/core/params-schema.js:94`).
FOH is a **small subset**, ROH is the strict **complement** via
`rohGroups(schema, fohKeys)` — [[feedback_foh_roh_must_differ]], the bug where
one param grew two never-syncing controls and the author's water panel showed
0.62 and 1 on the same frame.

**The split follows sun-shadows' own "not a knob" doctrine**
(`src/effects/sun-shadows.js:54–57`), which exposes exactly one softness param
(`softnessBias`) and deliberately hides the falloff shape and the
penumbra-widening rate. Applied here that gives a clean line:

- **Window geometry is ART, so expose it generously.** Pane counts, frame,
  mullion, style, sill and head are authored choices about how a building looks.
  An artist should be able to reach every one of them.
- **Blur physics is a MODEL, so expose one bias.** `softNearPx`, `softCurve`, the
  Jacobian, the softness mode — these are the shape of the model, not a taste.
  They live as module constants with a header paragraph, exactly as
  `PENUMBRA_PER_PX = 0.035` does.

**⚠️ SHIPPED shape, corrected from the table below** (§13 has the full list of
what changed during implementation): `enabled` is **not** a schema param at
all — it's the manifest/cascade's own concern, exactly like every other effect
in this codebase (`window`'s `WINDOW_PARAMS` doesn't carry it either; the
card's `onToggleEnabled` is a separate prop). `panes`/`style`/`arcRise`/
`jitter`/`glassTint`/`transmit`/`wallThicknessPx` don't exist yet — no dial
infrastructure exists to drive `cols`+`rows` from one preset (per
[[keyhole-effects-ui-directive]], "FOH is a curated `fohKeys` list moving real
params directly, not an authored remap curve"), and the rest are rung 1/2/4
features, correctly absent from a tier-0 schema. `sillPx`/`headPx` ship as
**absolute scene px**, not `sill01`/`head01` fractions of a shared wall-height
authority — see §13.1 for why. One genuinely NEW param exists that this table
never had: `strength` — the design's own multiply-into-falloff needed a
"how much" dial, or it would have shipped strength-less (§13.3).

| | Keys |
|---|---|
| **FOH (4)** | `strength`, `cols`, `rows`, `softness` |
| **ROH** | `frame`, `mullion`, `sillPx`, `headPx`, `defaultLampHeightPx`, `maxAperturesPerLight` |
| **Constants, not params** | `softNearPx`, `softCurve`, `MIN_WALL_DISTANCE_PX`, `minLampHeightPx`, the magnification model |
| **Readouts** (not params) | apertures found · apertures dropped by the cap · lights with ≥1 aperture (`point-light-pool.js#getApertureGoboReadout`) |

Categories must come from `CATEGORY_ORDER` (`diag/effect-controls.js:50`) —
`Presence, Look, Detail, Light, Motion, Shape, Extent, Outdoor, Response,
Technical`. Anything unrecognised is silently swept into Technical, which has
already happened to three real categories. Window geometry is `Shape`; strength
and tint are `Look`; heights and the cap are `Technical`.

⚠️ **`params/no-dead-controls` fails the build on a param nothing reads.** Every
key above must have a real consumer before it ships — including the CPU-side
ones (`maxAperturesPerLight`, `defaultLampHeightPx`). This is the wall that made
`cloudFactorNode` a JS injection seam in the window effect rather than a slider;
check each key against it rather than declaring the schema up front and
backfilling.

Manifest shape per `validateEffectManifest` (`src/effects/effect-manifest.js:92`):
`id: 'apertureGobo'`, `a11y: {photosensitive: false}`, tier 0 declaring **no**
`fromProfile`, rungs 1..N each declaring one, cost classes monotonic from tier 1.
No `authoring.paint` — there is no mask to paint.

Default **ON** — [[feedback_default_on_new_features]]. Nobody should need a
console command to see a new thing.

---

## 9. Preconditions, stated so they can't go silent

[[feedback_count_silent_preconditions]] — a long product with no floor ships
invisible. Every one of these is a place this returns nothing and looks fine:

1. **Foundry must already be letting light through.** This *shapes* light that
   exists; it cannot *create* light through a wall Foundry says is opaque. If the
   author draws a solid wall and a decorative window tile, there is no fan and
   nothing happens. **The status report must say "0 apertures found" loudly** —
   this is the single most likely first-run outcome and it is a data question,
   not a bug.
2. `h > z1` for a finite far edge; `h ≤ z0` means the lamp is below the sill and
   the patch is behind the wall. Clamp and report, don't NaN.
3. `a ≥ 1px`. A lamp inside the wall plane.
4. `cols`/`rows` ≥ 1; a zero pane count must degrade to an open aperture, not a
   solid wall.
5. Zero-length wall segments.
6. **Y-flip.** [[feedback_y_flip_recurring_risk]] — this introduces *two* new
   mappings (the sign of `nrm`, and the direction of `s` along the segment) and
   that failure has bitten five times. **Ship a debug channel that renders
   `(s_w, z)` as false colour before trusting a single pixel of the output.**
7. Whatever floor gate point lights currently carry, this inherits. Verify it,
   don't assume it — point lights had *no* floor gate at all until very
   recently.

---

## 10. Verification

Per [[feedback_smooth_output_hides_ported_bugs]] and
[[feedback_measure_the_output_not_the_equation]] — a smooth picture is not
evidence, and a correct formula in the wrong regime returns nothing:

- **CPU twin + brute force.** Forward-trace N random rays from the lamp through
  random window points, rasterize where they land, and diff against the inverse
  map's answer. They must agree inside a texel. This is the test that catches a
  wrong Jacobian, a flipped normal, and a transposed frame in one shot.
- **Monotonic contrast sweep** — pattern contrast non-increasing with `r`, across
  a grid of `h`, `a`, `z0`, `z1`.
- **Degenerate battery** — every item in §9.
- **Fail-open test** — a light with zeroed aperture uniforms renders
  byte-identical to a light with the effect off. Assert it, don't eyeball it.
- **Shader Lab scenario** `aperture-gobo`, on a real wall from a real map.
  [[feedback_bench_must_build_inputs_like_production]] — the bench must take the
  aperture list from `readSceneWallSegments`, **not assemble its own**. Three
  bugs in one day came from a lab building its own inputs.
- **Debug channels:** raw `gobo`, window-space `(s_w, z)` false colour, and the
  per-light aperture count.

- **The `edgeSoftFactor` A/B the header demands** (§6.0). Ship the debug channel
  first, confirm `gobo` alone looks right, *then* multiply it in, and screenshot
  both. If the scene blacks out, we have learned something valuable about a
  two-year-old open question at the cost of one afternoon.

⚠️ This effect reads **no mask at all**, so it has no `masks/authority-only`
exposure in code. The only remaining surface is prose: any user-facing report or
manifest string must say "the window mask", never the underscore-suffixed token
— [[keyhole-windows-aperture-design]] tripped that wall on a report string.

---

## 11. Honest cost

Per fragment, per aperture: ~10 ops frame transform, 1 divide, ~6 ops inverse,
~12 ops pattern SDF, ~4 ops Jacobian, 1 smoothstep. Call it **~35 ALU**, unrolled
at graph-build time, times the aperture count (capped at 4). A light with no
windows — which is most lights on most maps — compiles the whole thing out and
pays literally nothing.

Zero new textures. Zero new passes. Zero new render targets. Zero new scenes.
Zero storage buffers. Zero CPU per frame beyond what already runs when walls or
lights change, and both already have watchers.

**Cost class C1.** For comparison, the existing sun-shadow bake runs 32 march
stations with a texture fetch each.

The expensive parts of this feature are getting the frame orientation right and
finding out whether §6.0's landmine is real. Both are test problems, not
performance ones.

---

## 12. What "BUILT (unverified)" actually covers here

Per [[keyhole-current-state]]'s own law — two words, never one — this section
says exactly what was checked and by what means, so nobody mistakes a green
test suite for a live look.

**Checked, mechanically:**
- The inverse projection (§3.3) against an **independently-derived forward
  projection**, round-tripped through 200 random cases across four
  `(sL, a, h)` configurations, to <1e-6 px.
- The Jacobian (§5.1) against a **numerical (central-difference) derivative**
  of the same coordinate map, to <0.5% relative error — including the specific
  claim that `magAlong` is exact only directly ahead of the light and
  measurably smaller off to the side (the correction this doc's own §13.2
  records).
- The max-combine (§6.1) against a **hand-built regression case** proving an
  inapplicable aperture cannot out-vote an applicable, darker one — the exact
  bug a first draft of this reasoning got wrong (§13.4).
- Every `Aperture-Gobo.md` §9 precondition (degenerate wall, `a=0` clamp,
  sill-above-lamp cutoff, far-to-the-side bound, `cols`/`rows` under 2, huge
  world coordinates) has its own assertion.
- **The real TSL graph constructs, in Node, with the real vendored
  `three.webgpu.js`** — both `buildApertureShadowMaterial` (the multiply +
  debug materials the effect now actually lives in) and
  `buildPointLightIlluminationMaterial` on its own, at every aperture count 0
  through the cap. This also corrected a stale claim in this codebase's own
  `point-light-illumination.test.mjs`, which called the latter "browser-only"
  without ever having tried.
- `deriveWallAperture` against the vendored Foundry v14 source directly
  (`common/documents/wall.mjs`, `common/constants.mjs`) — the `light` field's
  schema default is confirmed `NORMAL`, and `PROXIMITY`'s own numeric value
  (30) confirmed against `EDGE_SENSE_TYPES` (§13.7's own correction).
- The whole-repo suite: 6919 assertions across 20 suites, zero failures,
  including everything this change did NOT touch.

**NOT checked, and this is the honest limit:**
- Whether it **looks right** — the pattern's orientation, the sill/head
  numbers, the softness curve's felt pacing, all of it — on a real scene, in
  the actual Foundry+WebGPU runtime, INCLUDING under the rewritten §6
  architecture (§13.10) — the multiply-blended shadow pass has never been
  seen live at all yet, only reasoned through and Node-constructed. Nothing
  in this project's toolchain can substitute for the author's own eyes.
- **§6.0's own open question, unchanged by the rearchitecture** — whether
  wiring a new term into ANYTHING inside this render sequence reproduces the
  unexplained black-screen failure `edgeSoftFactor` hit once. The
  architectural argument (no `Loop`, no `uniformArray`, no branch fold) is
  real, but it is an argument, not a measurement.
  `MapShine.setApertureGoboDebug(true)` shows the raw pattern alone,
  specifically so this can be checked cheaply, first, before trusting the
  multiply pass on a real scene.
- Whether `readSceneWallSegments`/`findAperturesForLight` behave correctly
  against a REAL scene's wall data at real-world scale (hundreds of walls,
  concave rooms, walls that nearly coincide) — the CPU logic is unit-tested
  against small hand-built fixtures, not fuzzed against anything resembling a
  real map. `totalFound: 96` on one real map (post-PROXIMITY-fix) is a single
  live data point, not a stress test.
- Whether the multiply-blend pass genuinely composes correctly with the
  sun-shadow field, region darkness, and the window cookie's own ADD in a
  scene using several of these at once — each was reasoned through
  individually (§6's own commutativity argument), never observed together.

## 13. Where the shipped code corrected this document

Per this project's own standing rule — a plausible diagnosis that's never
checked against code becomes load-bearing fiction — every place implementation
found this design wrong is recorded here, not silently overwritten.

**13.1 — `sillPx`/`headPx` ship as independent absolute px, not fractions of a
shared wall-height authority.** §3.5 originally proposed deriving them as
`sill01`/`head01` fractions of `sun-shadows.js`'s own `wallHeightPx` (260px
default) — "reuse, don't invent a second opinion about how tall a wall is."
Implementing that would have made this effect's schema read a DIFFERENT
effect's resolved param at render time, a cross-effect runtime coupling this
task's scope didn't budget for wiring correctly. Shipped instead: `sillPx`
(default 0) / `headPx` (default 220) as this effect's own independent ROH
sliders — a named simplification, not a silent one, and recorded as a
`deferredRungs` entry (`elevationHeight`'s sibling concern) rather than
pretended away.

**13.2 — the Jacobian's `magAlong = k` was wrong; the shipped code uses
`k / sqrt(1 + ((sW-sL)/a)²)`.** This document's OWN §5.1, written before
implementation, already flagged this as "the tempting shortcut" that's "measurably
wrong for the cross-bar family" — but that earlier pass only worked out the
correction for `magPerp`, not `magAlong`. Deriving the actual gradient
transform during implementation (not guessed — the standard
`floor_distance = window_distance / |∇(window coord wrt floor coord)|`
identity, computed via the chain rule on the closed-form inverse map) found
`magAlong` ALSO needs a correction: exact only at `s == sL` (directly ahead of
the light), where the foreshortening term is exactly 1. The CPU twin's own
finite-difference test (§12) confirms the corrected formula against a
NUMERICAL derivative, not just self-consistent algebra.

**13.3 — `strength` is a genuinely new param, not merely surviving from this
doc's original table.** The projection/generator/blur math this document
designs answers "what pattern" and "how soft" — it never specified a "how
much" dial. Multiplying the raw gobo term straight into `combinedFalloff`
(§6) with no way to blend it toward neutral would have shipped an effect an
author could only fully disable, never dial back — a real gap the params
schema (§8/§13.1's own table) would have caught as unplanned had it been
authored blind. `strength` blends the WHOLE gobo term toward `1` (never
multiplies it directly — that would darken the entire light as strength rose,
not dial the pattern), applied once, outside the per-aperture loop.

**13.4 — the max-combine's "inapplicable aperture" sentinel was wrong in an
early implementation draft, caught before it shipped.** The first pass at
§6.1's `max` combine treated an inapplicable aperture (a point on that
particular wall's own interior side) as contributing a NEUTRAL value of `1`
into the same `max()` as every applicable aperture. That is wrong the moment a
light has two or more apertures: a point genuinely lit (and mullion-shadowed)
through window B, but incidentally on the interior side of window A's own
infinite dividing line, would let A's neutral `1` win the max over B's real,
darker value — silently erasing a real shadow the instant a second window
exists on the same light. The shipped combine tracks applicability
SEPARATELY from the running max (`anyApplicable`, folded via its own `max`,
never mixed into the value channel) and falls back to `1` only when NOTHING
was applicable at all. `aperture-gobo.test.mjs` carries this as a named
regression case, not just an inline comment.

**13.5 — the generator SDF's sign convention was inconsistent in this
document's own §4 pseudocode**, mixing a raw `sdBox` (negative-inside) with
the mullion terms' positive-means-far-from-a-bar convention. Fixed during
implementation to ONE consistent convention throughout (positive = lit glass,
matching what feeds the final `smoothstep`), documented in
`aperture-gobo.js#apertureWindowSdfParts`'s own header rather than left for a
shader to inherit the ambiguity.

**13.6 — `maxAperturesPerLight` needed an explicit runtime clamp against the
shader's own hard cap**, not just a schema `max`. A future schema edit
authoring a looser range than `aperture-gobo-render.js`'s
`MAX_APERTURES_PER_LIGHT` (the actual unroll count the TSL graph builds)
would otherwise let the CPU assign more apertures than the shader has uniform
slots for — no crash (the write loop bounds itself to the smaller array), but
a silent under-write of the assigned list's tail. `point-light-pool.js` now
clamps against the imported constant directly, belt-and-braces on top of the
schema's own range.

**13.7 — the aperture predicate matched the wrong Foundry sense entirely:
`light === NONE`, not `light === PROXIMITY`.** §2.1 now carries the full
account with the wrong reading struck through rather than deleted. Found by
the author directly, from actually authoring windows in a real Foundry world
— not from re-reading the spec, and not something code review or the Node
test suite could have caught, since `light: NONE` is a completely legitimate
`EDGE_SENSE_TYPES` value and every test asserted the predicate did exactly
what it was written to do. The live symptom was unambiguous once the
diagnostics were fixed (§13.8): `totalFound: 317`, `dropped: 189` on one real
map — the predicate was matching some large fraction of that map's WHOLE wall
set, not its handful of actual windows, and the author separately reported
"knock-on effects to terrain walls." This is the load-bearing reminder that a
type that PARSES correctly against a schema is not the same claim as a type
that matches the AUTHORED convention — [[feedback_membership_beats_derived_threshold]]
in its purest form: "None" reads as the intuitively correct English word for
"doesn't block", and was wrong anyway.

**13.8 — the debug view's own design was misleading, independent of §13.7.**
The FIRST live A/B (`MapShine.setApertureGoboDebug(true)`, with 33 lights
genuinely carrying assigned apertures per the fixed readout) reported "all the
lights became a lot brighter," with no window pattern visible anywhere. The
cause: the debug swap was gated only on "does this light have ANY assigned
aperture", not on whether the gobo term was actually doing anything AT a given
fragment — so every point where NO window reached (the overwhelming majority
of any light's own radius: the entire room interior, and most of the exterior
too) displayed the term's own "nothing applies here" value, which is 1 —
**white**. A light's whole disc, normally a warm bright-centre/dim-edge
gradient, was replaced by flat white almost everywhere, with whatever real
(and possibly entirely correct) pattern existed confined to a small, easy-to-
miss region drowned in glare. Fixed by exposing a SECOND node,
`anyApplicable` (`buildApertureGoboTerm`'s own return, alongside `node`), and
gating the debug swap on it: the view now shows the light's completely normal
colour everywhere the effect does not reach, and only shows the grey/black/
white pattern where it does — the debug view now visually PROVES its own
reach instead of assuming it. This was a real design gap in the diagnostic
itself, not a bug in the projection/generator/blur math those functions
compute — nothing in §12's own math verification (round-trip, Jacobian,
regression tests) exercises how a RESULT gets DISPLAYED, only whether it is
computed correctly, and this is the gap between those two questions.

**13.9 — near-field magnification, unbounded by design, needed a ceiling.**
The SECOND live round (both §13.7/§13.8 fixes applied — `totalFound` now a
sane 96 vs. the earlier 317, `litLights` 25) showed real spatial structure in
the debug view for the first time — genuine progress — but not a recognisable
pane grid: one large, mostly-uniform curved field with a single soft dividing
edge, described live as "the UVs are a bit misaligned." The likely cause is
NOT a sign/orientation bug (those would scatter a grid incoherently, not
produce one smooth large-scale field) but §5.1's own magnification, which is
genuinely unbounded (`magPerp ~ k²`, `magAlong ~ k`, both diverging as a
light's own distance from its wall, `a`, shrinks) — and an ORDINARY torch-to-
window distance is well within the regime where this gets large: a light
merely a few tens of px from its own window can already magnify a single
mullion edge across that light's entire visible radius, exactly the way a
lamp held close to a real window throws one huge, barely-patterned blob onto
a nearby wall. Physically correct; not the readable-grid LOOK the effect
exists to produce. Fixed with `MAX_MAGNIFICATION = 10`
(`aperture-gobo.js`), clamping each axis independently so the two families
keep their own different growth rates right up to wherever each saturates —
the same "usability over exactness" trade `Sun-Shadows-Layer-Smear.md`
already made once in this codebase ("it doesn't need to be physically
accurate, it just needs to make sense"). The CPU twin's own Jacobian test
had to move its one genuinely-far-field case out of the "must match a
numerical derivative exactly" assertion (clamping is a DELIBERATE deviation
from the true derivative) into a dedicated test asserting the clamp itself
holds.

A SECOND, not-yet-ruled-out contributor to the same symptom: if the actual
window wall segment on the live map is SHORT relative to `frame` (the
default 6px inset on each side), the "open" interior could be a small
fraction of the whole aperture even before any magnification — worth
checking directly (the wall's own on-screen length) rather than assuming
§13.9's fix is the whole story.

**Still open, as of that correction:** whether the pattern now reads as a
genuine grid, with all three fixes (§13.7/§13.8/§13.9) applied, was not yet
confirmed live — and per §13.10 below, it turned out there was a FOURTH,
bigger issue waiting past that question, not a fifth confirmation of the
same three.

**13.10 — §6's entire design (multiply into one point light's own falloff)
was structurally wrong, found live and rebuilt the same session.** The THIRD
live round — all of §13.7/§13.8/§13.9 applied, `totalFound` a sane 96,
`litLights` 25, genuine spatial structure visible in the debug view for the
first time — reported: *"Window pane panel pattern is only visible when I
turn the debug mode on. During day there is no visible window pane pattern.
You need to darken the light coming out of the windows a lot more to make
this work, could this be a new shadow contribution? It could be made part of
that system?"*

The cause was not a tuning problem. `point-light-illumination.js`'s material
blends into `buf:scene.illum` via `MaxEquation` — Foundry parity requires
that a point light can only ever BRIGHTEN a fragment above whatever is
already accumulated there, never darken it below (a torch must never make a
spot darker than the scene's own ambient already makes it). §6's original
design multiplied the gobo term into that SAME light's own `falloff` — but
`falloff` only controls how far the light's OWN corona reaches BEFORE the
`MAX` comparison runs; it can never make the light's contribution read as
DARKER than whatever else (ambient, another light) is already the max at
that pixel. Concretely: wherever ambient (daylight, or any nearby light) was
already brighter than this one light's own darkened corona, the `MAX` simply
kept the ambient, unchanged, and the "shadow" vanished — which is EXACTLY
"invisible during the day, barely visible at night" and could not have been
fixed by any amount of retuning `strength` or `softness`, only by relocating
where the term lives.

The author's own proposed fix — treat this as a shadow, make it "part of that
system" — was not just plausible, it identified the precise architectural
principle already proven correct elsewhere in this codebase:
[[keyhole-layer-smear-model]]'s own law, that independent occluders in series
MULTIPLY their transmittances, never blend or average. A `MULTIPLY` (unlike
`MAX`) genuinely CAN darken a fragment below whatever is already there — that
is the whole reason it was the right redesign, not merely an appealing
metaphor. §6 (rewritten in full) is the result: the gobo term moved OUT of
`point-light-illumination.js` entirely (which reverted to being apertures-
UNAWARE, same as before this effect ever existed) and INTO its own dedicated
`apertureShadowScene`, drawn as a genuine multiply-blended pass AFTER point
lights accumulate — so it darkens ambient, every other light, and this
light's own corona alike, visible regardless of what else is lighting that
pixel.

One structural finding fell out of the redesign for free and is worth
recording on its own: a `MULTIPLY` by a non-negative factor COMMUTES with
`MAX` (`MAX(a,b)×c == MAX(a×c,b×c)` whenever `c≥0`, and `gobo` is never
negative) — so the new pass's position in the render sequence relative to
point lights is mathematically arbitrary; it was placed AFTER them by
choice, not by requirement, specifically so a light shadows its own corona
too, not only the ambient beneath it.

A second, smaller but real bug came along in the SAME live round, independent
of the falloff-vs-shadow question: the diagnostics report's own `live` block
read `unavailable: true` on a scene that was demonstrably rendering.
`getVtPanViewerDiagnostics()` does not return `_active`'s own methods
directly — it delegates entirely to `buildViewerDiagnostics({_active, ...})`
in `vt-pan-viewer-diagnostics.js`, which bridges each of `_active`'s
`getXInfo()` methods into its own flat return object ONE EXPLICIT LINE AT A
TIME (`pointLights: _active?.getPointLightsInfo?.() ?? {available:false}`).
Adding `getApertureGoboInfo` as a sibling method on `_active` (correctly, by
the same pattern `getPointLightsInfo` itself uses) is not enough on its own —
the matching bridge line in the OTHER file is what actually makes it
reachable, and it was missing. Fixed by adding it; recorded because the
"looks identical to an existing, working pattern" shape of this miss is
exactly the kind of thing worth flagging for the next per-light diagnostic
this codebase adds.

**13.11 — design 2's own `MULTIPLY` had no floor, and could over-darken
exactly the way design 1's `MAX` could never darken at all.** The FOURTH
live round — the FIRST look at design 2, freshly rebuilt after §13.10 —
reported real progress ("very close to working") but two concrete problems,
both about the SAME underlying gap: *"the darkening isn't enough to black
out the light [at night]... we also need to make sure that we're not
actually darkening the light past the point of it making sense. \[...] this
shadow would make no sense at noon if it ended up making the areas around
the window darker than the noon sun was making the outside. \[...] At night
we only want to see the panes of the windows as light and the rest needs to
be darkened to the appropriate level of darkness to act like the light was
fully occluded."*

The cause, confirmed by reading (not guessing) `runLightAccumulatePass` in
`vt-pan-viewer.js`: `buf:scene.illum` is seeded with the ambient/daylight
floor (`illumQuad`, raised by global illumination) BEFORE point lights OR
the aperture shadow pass ever draw. Design 2 multiplied the ENTIRE
accumulated buffer — ambient included — by the gobo term. At full strength
and full occlusion (`gobo → 0`), that is a multiply by zero REGARDLESS of
what's underneath: a blocked region reads as pure black whether it's local
midnight or local noon. The sun-shadow "multiply independent occluders in
series" law this design leaned on ([[keyhole-layer-smear-model]]) is correct
for occluders stacked in front of the SAME light source — it was never
license to darken a source-INDEPENDENT ambient floor that has nothing to do
with the light casting this particular shadow. This is the mirror image of
§13.10's own bug: design 1 (`MAX`) structurally COULD NOT darken below
ambient; design 2 (bare `MULTIPLY`) structurally COULD NOT STOP AT ambient.
Both are the same category of mistake — reaching for a blend primitive by
its headline property ("MAX brightens", "MULTIPLY darkens") without tracing
what it does to the specific value already sitting in the buffer at the
specific time this pass runs.

Design 3 (§6, rewritten again) replaces the multiply with a blend toward
`backgroundFloor` — this light's own "as if this light contributed nothing
here" colour, previously computed and discarded inside
`point-light-illumination.js`'s local scope, now returned from
`buildPointLightIlluminationMaterial` and threaded into
`buildApertureShadowMaterial` so the two materials, which already share this
light's geometry and transform, share the exact same idea of "ambient" too
— [[feedback_composite_only_terms_miss_shared_buffers]] in its positive
form: reuse the node a consumer already computed, don't re-derive a second,
potentially-drifting opinion. `result = mix(backgroundFloor, dst,
strengthed)` is bounded between "no effect" and "exactly backgroundFloor" in
both directions — it is now MATHEMATICALLY IMPOSSIBLE for this pass to push
a fragment past ambient in either direction, which directly satisfies the
noon half of the author's report by construction, not by tuning.
`backgroundFloor` is also per-fragment sun-shadow-aware (it samples the same
baked sun-shadow fields the light's own illumination material does), not
just the light's flat regional ambient — so the fallback a blocked pixel
lands on matches its true local neighbourhood, not a coarser scene-wide
guess.

**Left honestly open:** the noon constraint is now provably correct; the
night complaint ("not dark enough") is NOT confirmed fixed by this change,
only no-longer-explained by the one mechanism that was checked. Three
untested alternative explanations remain on the table: (a) the live test
that produced the report may not have had `strength` at its maximum — no
JSON diagnostics dump accompanied that round's screenshots, unlike every
earlier round, so the actual live param values are unknown; (b) at high
near-field magnification the softened blur band (`uSoftFarPx`, up to 48px)
can exceed a magnified mullion bar's own floor-projected width, meaning the
SDF never reaches the interior region where `smoothstep` saturates to exact
`0` — the pattern would read as merely dim rather than fully dark even at
full strength; (c) bloom or another POST-illum pass could be re-brightening
the shadowed region from the visible point-light source itself, entirely
downstream of this fix. None of these were root-caused before this
document was updated — the NEXT live round, specifically checking whether
full darkness is now reached, is what actually answers this, not a fourth
theory added here.

**13.12 — being bounded by ambient is not the same claim as being invisible
when irrelevant.** The FIFTH live round — the FIRST look at §13.11's own
fix — reported real progress ("very close to working... this is very close")
but a NEW problem, at noon, with 0 scene darkness, debug mode OFF: *"the
light is now effectively casting a darkness in a perfect radius and lighting
within that radius... During the day it makes no sense for the light polygon
wedge to darken the environment ever."* The screenshot showed a lens/diamond
shape — the aperture-shadow mesh's own `applicable` region (the window's
geometric throw wedge, intersected with the light's own dim-radius circle) —
visibly reshaping the torch's glow against the daylit ground outside, with a
hard edge where the wedge test's own boolean flips.

**Root cause, confirmed by reading `runLightAccumulatePass` and
`buildApertureShadowMaterial` together, not assumed:** `backgroundFloor`
bounds the RESULT so it can never fall below ambient — but a torch's own
NATURAL, *unshadowed* corona is very often still brighter than daylight
ambient close to the light (Foundry's own bright/dim colours are frequently
near-white, ~1.0, against a ~0.93 daylight floor) — so wherever the wedge
test said "applicable" and `gobo` was low (blocked, inside the frame/mullion
region), the pass pulled that GENUINELY BRIGHTER-THAN-AMBIENT corona back
down toward `backgroundFloor`, while immediately outside the wedge's own
hard edge — still well within the light's natural radius — the same corona
was left completely untouched. Two boundaries (the wedge's own geometric
test, and the light's own natural radial falloff) that don't coincide, and
the mismatch between them is exactly the visible seam. §13.11's fix was
necessary (the result genuinely can no longer go past ambient) but not
sufficient (nothing stopped the pass from being VISIBLE at noon in the first
place, only from being visible PAST a certain point).

**The author's own reframing was the correct diagnosis, not just a
complaint:** *"We want the light just to look like a gobo/cookie coming out
the window, not a wedge."* A cookie is a modulation of a light's OWN glow,
riding its own shape; a wedge is an independent shape with its own boundary.
The fix (§6's new "VISIBILITY gate" bullet has the mechanism) makes the
shadow pass's own alpha a function of how much THIS light's natural
brightness actually exceeds ambient at a fragment — a Weber contrast ratio,
`(lightLuma - ambientLuma) / max(lightLuma, ε)` — which is `0`, a complete
no-op, wherever ambient already dominates (correct: a candle's shadow
pattern is not perceptible in broad daylight, full stop, not merely "no
darker than the daylight already is") and rises toward `1` only where the
light's own corona genuinely wins. Because `lightLuma` is itself
`finalColorExposed × combinedFalloff` (the light's OWN radial reach field),
`visibility` is smooth and monotonic in that SAME field — proven by direct
substitution in `aperture-gobo-render.js`'s own header, not merely asserted
— so wherever the effect DOES show, its reach automatically tapers to match
the light's own natural falloff. One formula solves the stated complaint
("never darken the environment during the day") AND the stated aesthetic
goal ("look like a cookie, not a wedge") as the same consequence of one
comparison, not two separate patches.

**Two things this fix does NOT do, named rather than assumed away:**
(1) it does not soften the wedge's own `applicableX`/`applicableSpan`
boolean edges — it shrinks their VISIBLE consequence toward zero wherever
the light itself has already faded, which is not the same as removing the
hard edge outright. If a residual seam is still visible specifically AT
NIGHT (where `visibility` sits near 1 and the wedge's own edge is
essentially un-shrunk), softening those booleans directly is the next
targeted fix, deliberately not done pre-emptively here without live evidence
it's still needed. (2) The formula uses plain gamma-space luminance (Rec.
709 weights, matching `grade/grade-ops.js#luminance`), not a linearised
(EOTF) comparison — a named simplification (this module's own header has the
reasoning for why the THRESHOLD behaviour, "does this light matter here at
all," is unaffected by that choice, even though the exact shape of the ramp
between 0 and 1 would shift slightly under a linear comparison).

**What's actually verified vs. not, as of this correction:** the visibility
formula itself has a numeric CPU twin
(`aperture-gobo.js#computeApertureShadowVisibility`, `aperture-gobo.test.mjs`)
checked against hand-derived Weber-contrast values, monotonicity in
`combinedFalloff`, and the exact-zero boundary case — genuinely tested, not
merely trusted. What is NOT yet verified: whether this actually reads as
invisible-at-noon and cookie-shaped-at-night on the author's real scene —
no screenshot exists yet of this specific build. The JSON diagnostics
accompanying THIS round's report did confirm `strength: 1` was active at
capture time, which at least narrows §13.11's own open question (a) for
future reference, though that capture was from the daytime test, not a
fresh night one — the night-darkness question itself is still exactly as
open as §13.11 left it.

**13.13 — two more rounds each found a real bug and STILL no convincing
cookie; the author changed the diagnostic method itself, and THAT is what
finally produced one.** §3.7's contrast-floor fix did not end the "no
evidence of it working at all" reports. The next round found
`defaultLampHeightPx: 40` sitting BELOW `headPx: 220` — since
`computeApertureRowBoundaryX`'s inversion sends `z → h` only in the limit
`x → ∞`, a lamp height below the window's own head makes every row boundary
above the sill geometrically unreachable at ANY floor distance, present
since design 1 and masked until design 4 + the contrast-floor fix made the
rest of the math correct enough to expose it. Fixed by raising the default
to 280. The round after that showed a real pattern **only** with "Show
pattern only" (the debug material) checked, invisible with it off — a
version of `debugMaterial` that multiplied by `visibility` (matching the
real material's own alpha) made the two indistinguishable from each other,
so it was deliberately reverted to `(1 - strengthed)` alone, isolating
"is the pattern right" from "is visibility throttling it" for the next
round to tell apart. The author's report on THAT round — *"Still not
functioning as an effect"* — is what triggered the pivot below.

**The pivot.** The author, verbatim: *"Change your approach. I need you to
build a test in the shader lab, walls, windows and a light source on one
side of the window. Then I want you to run through the problems until you
get a convincing shape on the window panes on the other side of the window.
Improve the Shader Lab as you go along if you need access to more tools to
make this work."* Five consecutive live rounds had each found a genuine,
fixed, verified bug, and NONE had converged on a picture the author called
convincing — every round's diagnosis ran through a screenshot of the full
game, with the concurrent-editing hazard, the OTHER window-cookie effect,
region-aware ambient, sun-shadow attenuation, and a second in-progress
feature (the elevation gate) all sitting between "the shader under test" and
"the pixels the author sees." `tools/shader-lab/bench-aperture-gobo.js` is
the direct answer: one Foundry-shaped wall aperture, one point light, the
REAL `buildPointLightIlluminationMaterial` and `buildApertureShadowMaterial`
on a real WebGPU device, MAX-then-blend into a real target in production's
own draw order, pixels read back and measured, PNGs saved and looked at —
every one of those five confounds removed by construction. Full bench
mechanics, including three bench-side bugs found and fixed while building it
(a `scenarios` property never wired into the returned bench object; a
`RangeError` from WebGPU's 256-byte texture-row alignment at `DIM=800`,
fixed by moving to `DIM=1024`; and an early scenario that sampled the SAME
pixel for both its "open pane" and "mullion" probes because the light sits
exactly on the window's own lateral centreline), are in the bench's own file
header, not repeated here.

**The bench's first real run measured genuine contrast for the first time
all session** — pane 255, mullion 94, delta 161 — but the mullion's own
darkest point did not reach the "genuinely dark" bar the scenario expected
(≤56, against a measured ambient of 46). The author, looking at the SAME
saved PNG independently, asked the load-bearing question directly: *"Surely
point 1 [the mullion] should be as dark as point 2 [well outside the light's
own reach entirely] to be physically accurate?"* — correct, and exactly the
gap the numbers already showed.

**Root cause, isolated by adding a diagnostic material mode to the bench
rather than guessed at from the two numbers already in hand:**
`buildApertureShadowMaterial` was extended to also return its internal
`visibility` node (previously computed and discarded), so the bench could
render it as its own opaque greyscale channel and read it back directly, the
same way it already read back `debugMaterial` (raw gobo term, visibility not
a factor). Three renders of the identical scene, differing only in which
material draws the aperture-shadow pass:

| render | mullion probe | tells you |
| --- | --- | --- |
| real `material` | 94 | the actual, composited result |
| `debugMaterial` (gobo only) | 8 — genuinely black | the PATTERN geometry is correct |
| `visibility` alone (new) | 199/255 ≈ **0.78** | the GATE, not the pattern, is the gap |

`visibility` measured the identical ≈0.78 at both the mullion probe and the
open-pane probe (the two points are nearly equidistant from the light, so
this is exactly what the formula predicts) — meaning the gate was not
tapering spatially near this probe, it was **globally undershooting**: the
original formula, `1 − ambientLuma/lightLuma` (a genuine Weber contrast
ratio, §13.12's own fix), only approaches 1 asymptotically — a light 4.5×
brighter than ambient (this scene's own measured ratio, a perfectly ordinary
"obviously the dominant light source" night scenario) yields only ≈0.78, not
the ~100× ratio the formula actually needs to read as "basically 1" (0.99).
§13.12's fix was correct about WHEN the gate must be exactly 0 (preserving
the noon no-op) and wrong about how fast it should climb once the light
genuinely dominates.

**Fix:** `computeApertureShadowVisibility` (`aperture-gobo.js`) and its TSL
port (`aperture-gobo-render.js`) now smoothstep the plain brightness ratio
`lightLuma / max(ambientLuma, ε)` from 1 (parity — still exactly 0, the
noon guarantee is unchanged) up to a new named constant,
`VISIBILITY_SATURATION_RATIO = 3` (that module's own doc has the full
reasoning) — a light 3× brighter than its own local ambient is unambiguously
the dominant source and earns a true, saturated 1, not an asymptote.
Smoothstep's own zero derivative at both ends is not just cosmetic here: it
rises INTO the ramp more gently than the old formula's slope-1 start at
parity, so a light only barely brighter than ambient — the exact regime that
produced §13.12's own noon wedge/seam — is throttled harder near the
boundary, not less.

**Verified, not just derived:** the same three bench renders, after the
fix — `visibility` now reads 255/255 (exactly 1.0) at BOTH probes; the real
material's mullion reads 49 (against ambient 46 — inside the "genuinely
dark" tolerance); pane-vs-mullion delta rose from 161 to **206**.
`noon-is-a-no-op` still reports 0.000% of pixels differing — the reshape
cost nothing at the boundary it exists to protect. The whole-repo suite
(7119 assertions, 20 suites) stayed green throughout, including new
regression tests pinning the saturation ratio itself (`VISIBILITY_SATURATION_RATIO`
reaches exactly 1; the bench's own measured 4.5× ratio reaches exactly 1;
just short of the ratio is still short of 1 — the ramp is real, not a step
function) and an updated comment on the one old assertion whose NUMBER
still happens to pass under the new formula (a 2× ratio still gives exactly
0.5) but for a different reason (`VISIBILITY_SATURATION_RATIO = 3` puts a 2×
ratio exactly halfway through the smoothstep span, and `smoothstep(0.5) =
0.5` always) — flagged so a future change to the constant doesn't leave a
passing test with a now-false rationale attached to it.

**Left honestly open:** this is bench-verified, not live-verified — no
Foundry screenshot of this exact build exists yet. §7's rung-3 multi-floor
re-evaluation, the wedge's own hard `applicableX`/`applicableSpan` edges
(§13.12's "left honestly open" #1, unchanged by this fix), and whether a
residual seam is visible specifically at night now that `visibility` reaches
a true 1 there, are all still exactly as open as their own sections left
them.

**13.14 — the "left honestly open" gap above was real: the author's live
scene showed NO pattern at all, then a day/night INVERSION, then a
non-uniform mullion — five more rounds, all live-found, all the same day,
each correcting a different input to the SAME gate formula.** §13.13 shipped
bench-verified only. The very next live screenshot showed no pane pattern
whatsoever — the whole wedge just looked like an ordinary light. This section
covers what those live rounds actually found, in order, because each one
corrects a genuinely different axis and conflating them (as earlier attempts
in this same investigation did) wastes a round rediscovering ground already
covered.

*Round 3 (`combinedFalloff` dropped from the gate entirely).* The author,
against a live screenshot: *"the edges aren't as dark as night is... the only
light should be coming from the window panes themselves,"* illustrated
against a photography "shadow board" reference — stark, UNIFORM contrast,
never fading with distance from the source. `lightLuma` had been computed as
`mix(backgroundFloor, finalColorExposed, combinedFalloff)`'s own luminance
(a short-lived intermediate step, matching what the real illumination
material draws on screen) — correct about WHAT to measure, but still varying
per-fragment with `combinedFalloff`, so the gate itself faded toward the
light's own dim radius exactly where the wedge visibly softened toward its
own edges. The gate's actual job — "does this light's own intrinsic
brightness justify showing a shadow AT ALL, here" — is a property of the
light's colour and local ambient, not of how far into its own radial falloff
one fragment sits (the mullion/pane pattern already owns 100% of the
per-fragment contrast once the gate says "show it"). `combinedFalloff`
removed from the formula entirely; a new bench regression
(`visibility-is-uniform-across-distance`) built specifically to pin this down
going forward.

*Round 4 (`finalColorExposed` → `uBrightColor`).* The regression built for
round 3 caught its own claim as false within minutes: near the wall,
visibility read fully open; a few hundred px further out — still comfortably
inside the light's own radius — fully closed. `finalColorExposed` still
carried Foundry's own bright-near-centre/dim-near-edge radial cross-fade
(`switchColor(uBrightColor, uDimColor, dist)`, `point-light-illumination.js`'s
own default seed), entirely separate from `combinedFalloff`'s own outer
fade. `uBrightColor` — the raw per-frame uniform, never blended by `dist` —
is what "this light's own peak, full stop" actually has to mean.

*Round 5 (`uBrightColor` → `uLightColor`).* The author reported the pattern
visible by day, invisible by night — backwards from the formula's own
predicted direction, and specifically what triggered an `AskUserQuestion`
about a possible second light source. The answer ("No other lights... the
window shadowing doesn't work at night either, when the light outside should
be 0") reframed the daytime screenshots as the gate's own CORRECT no-op, not
a bug, leaving "doesn't work at night" as the one real, unambiguous symptom.
Read directly: `uBrightColor` is written from
`computeAmbientColors(...).bright`, which resolves to `env.ambient.brightest`
— a SCENE-WIDE brightness ceiling every light in the pool reads from the
same per-frame `env`, not this light's own authored colour at all.
`point-light-coloration.js`'s own `uLightColor`, written straight from
`light.color`, is THIS light's real Foundry-authored tint.

*Round 6 (`backgroundFloor` → `ambientAtLight`, for the gate's ambient side
only).* A live gate-inputs probe (a new debug channel packing
R=lightLuma/G=ambientLuma/B=ratio into an opaque readback — see "THE
CHANNEL-PROBE TOOLING" below) at three points across one window's own wedge,
sun shadows active, measured `ambientLuma` swinging 0.32 near the wall to
0.56 further into the SAME wedge. `backgroundFloor` multiplies a
PER-FRAGMENT sun-shadow sample onto the light-position ambient, so the same
light's shadow applied near the wall and silently stopped further out, purely
from where the sun-shadow field happened to sample at that exact fragment —
visible directly in the author's own red-marked screenshot, which circled
the outer/wide part of the wedge as the place the shadow should apply but
didn't. The gate's own question — "does this light dominate ambient at
all" — belongs to the light's position, decided ONCE per frame;
`uBackgroundColor` (set before any per-fragment sun-shadow multiply) is that
value. The blend TARGET is unchanged — `aperture-gobo-render.js`'s own
`material` still blends toward the full, per-fragment `backgroundFloor`, so
the shadow's own colour still respects sun-shadows; only the GATE's ambient
comparison now uses the light-position-only value.

*Round 7 (`VISIBILITY_SATURATION_RATIO`, 1.5 → 1.2).* Rounds 5+6 fixed WHICH
colours the gate compares; they left untouched HOW FAR apart those colours
must be before it calls itself fully open. A fresh gate-inputs probe, taken
after rounds 5+6 were live, measured a ratio of 1.43 at the point closest to
an author-confirmed "obviously dominant" lamp's own window — under §13.13's
own cutoff of 1.5, landing at visibility≈0.95, not a true 1: a small but real
residual, exactly the "not dark enough around the edges" the author's
red-marked screenshot called out (distinct from round 6's separate
across-the-wedge fix — this is the SAME point, still not reaching full
cancellation). There is no principled reason the cutoff should sit above a
real, author-confirmed "this is clearly on" data point; 1.2 clears 1.43 with
margin. The gate's lower bound (ratio≤1 stays fully closed, protecting the
noon no-op) is a different constant entirely and is untouched.

**THE CHANNEL-PROBE TOOLING**, built specifically because the author
redirected the investigation itself: *"stop assuming that this isn't a code
bug, it's a code bug... You could enhance the reporting, upgrade the pixel
probe... but stop assuming this isn't a code bug."* The original single
boolean "Show pattern only" checkbox became a 4-way debug channel picker
(`off` / `pattern` / `visibility` / `gate-inputs`), each backed by its own
mesh toggled via `.visible` in `point-light-pool.js`'s per-frame loop —
`gate-inputs` packs R=lightLuma, G=ambientLuma, B=ratio into the `illum`
buffer as opaque greyscale, so all three of the gate's own numbers can be
read back at a real clicked point on a real running scene, not inferred from
how the picture looks. `MapShine.debug.registerAction('aperture-gobo-
channel-probe', ...)` reuses the existing click-3-points pixel-probe
infrastructure to read all 4 channels at up to 3 points in one action, with a
control-albedo sanity check to rule out the instrument itself lying
(`feedback_instruments_must_not_lie`). This is what actually found rounds 5
and 6 above — both are numeric, direct reads of a live scene's own gate
inputs, not inference from a screenshot's overall look.

**Verified, not just derived — same discipline as §13.13, extended to
rounds 3-7 together:** the whole-repo suite (7170 assertions, 20 suites)
stayed green, including a new regression pinning round 7's own exact
data point (a 1.43 ratio — under the old 1.5 cutoff, over the new 1.2 one —
now reaches full visibility) and the existing regression proving a stray
`combinedFalloff` argument has zero effect (round 3's own claim, now
enforced by a test rather than merely believed). The bench's own
`night-clear-pattern` scenario, re-run after rounds 5-7 together, still shows
the same clean pane/mullion contrast as §13.13's own screenshot (pane 255,
mullion 49 against ambient 46, delta 206 — unchanged, because none of rounds
3-7 touch a scene where the light already saturates the gate) and
`noon-is-a-no-op` still reports exactly 0.000% — every round from 1 through 7
agrees the gate is closed at parity, because each one only ever changed
inputs on the "is this light dominant" side, never the ratio=1 boundary
itself.

**Left honestly open, more narrowly than §13.13's own version of this
paragraph:** rounds 3-5 and 7 are bench-verified the same way §13.13's fix
was (a saved PNG, numeric pixel readback, a dedicated regression test).
Round 6 is NOT — the bench passes `sunShadowSlotNodes: null` and has no sun
shadows to react to at all, so nothing in the bench can exercise the actual
bug round 6 fixes. Round 6 is verified by direct source reading (tracing
`backgroundFloor`'s own multiply chain back through
`buildPointLightIlluminationMaterial`) and by the live gate-inputs probe that
found the 0.32-vs-0.56 swing in the first place, but not by a bench render.
Only a fresh live Foundry test — ideally a gate-inputs probe at multiple
points across the SAME window's wedge, near the wall and in the far/
red-marked area, at both day and night — can confirm `ambientLuma` is now
uniform across that wedge and the shadow fully cancels where the author
marked it.

## §14 — ⚠️ EVERYTHING ABOVE IS HISTORY PAST ROUND 7. READ THIS FIRST.

This document was not kept current through rounds 8-11 (2026-08-04) — that
debt is named here rather than left silent. **For the actual CURRENT
architecture and status, the memory file `keyhole-aperture-gobo.md` is now
the primary record**, not this document; its own "🔥 THE SEVENTH BIG ONE"
and "ROUND 11" sections supersede everything above. Condensed pointer, so a
reader stopping here isn't misled:

- **Round 8** reverted `lightPeakColor` from `uLightColor` back to
  `uBrightColor` (× an exposure factor) after reading the vendored Foundry
  source directly — illumination never reads a light's own colour.
- **Round 9** found the visibility gate never touched `coloration` (a
  separate additive channel `scene.lit = albedo×illum + coloration` never
  gated) — added a 5th, MULTIPLY-blended coloration-shadow material.
- **Round 10 (✅ LIVE, author: "Wonderful! That's the ticket!") DELETED the
  entire separate-pass architecture §§3-13 describe**, visibility gate
  included. The gobo pattern now multiplies directly into `point-light-
  illumination.js`/`point-light-coloration.js`'s own falloff, BEFORE each
  material's existing single MAX-blend draw — never a subsequent pass, no
  matter how well-bounded. Root cause: `mix(backgroundFloor, dst,
  strengthed)` at a blocked fragment collapses to `backgroundFloor`
  regardless of what `dst` (the ALREADY-composited scene) legitimately
  contained — visible live as a lamp's wedge darkening a building's own cast
  sun-shadow it crossed. `MAX(a,b)>=a` by construction is what the whole
  visibility-gate machinery (rounds 1-8) turned out to be approximating from
  outside the blend hierarchy. See
  [[feedback_derived_effect_must_join_blend_hierarchy]] (memory) for the
  general lesson.
- **Round 11 (bench-verified, not yet live-reconfirmed)** — three author
  refinements requested the same message as the round-10 confirmation:
  (1) pane count is now PROCEDURAL, derived per-light from the real aperture
  wall's `wallLen` divided by a target pane size (`paneWidthPx`/
  `paneHeightPx`, default 80), replacing the old fixed `cols`/`rows` params —
  `aperture-gobo.js#deriveApertureGoboPaneCount`; (2) `sillPx` default raised
  0→30 for a real sheltered strip below the window; (3) the distance-
  increasing blur (§5's blur law) is now actually visible across a light's
  full reach — `mullion`/`frame` widened 4/6→6/8 (raising the "THE CONTRAST
  FLOOR" cap that guarantees a mullion's own centre stays true black) and
  `SOFT_FAR_PX_BASE` rescaled 48→3 to match that new cap instead of
  overshooting it 16x (the OLD value was a leftover from the deleted
  magnification system, never rescaled for design 4's real-world feature
  sizes — the SAME class of bug as "THE FOURTH BIG ONE" above, just not yet
  measured for this specific symptom).
- **Round 12 (bench-verified, not yet live-reconfirmed)** — the author,
  looking at a live screenshot: *"it's possible for the effect to hit the
  dim radius edge which becomes an instant cut off hard line... I think we
  might also have to add a new edge darkening / suppressing effect which is
  based around the thickness of the wall... prevent hard edges on the other
  two sides of the arc."* Investigated before coding: a light's wedge (both
  the far dim-radius edge AND the two lateral edges) is genuinely Foundry's
  own wall-clipped light POLYGON mesh (`triangulateLightFan`) — a hard
  geometric boundary no shader term can blur directly. Both fixes instead
  pull the gobo pattern's own contrast back toward NEUTRAL *before* that
  mesh edge, inside territory the existing per-axis blur already softens:
  (1) `DIM_RADIUS_FADE_START=0.75` fades `gobo` toward 1 over the last
  quarter of a light's reach; (2) `computeApertureRevealNarrowing` (new
  param `wallThicknessPx`, default 16) — the `wallThickness` deferred rung
  above, now BUILT — narrows the ALREADY-blurred frame gate asymmetrically
  on the jamb away from an off-axis light's own lean (`w·tanθ`), no new
  blur machinery, only a new input to the one that already exists.
- **Round 13 (bench-verified numerically AND visually, not yet
  live-reconfirmed)** — "have some fun with it": medieval glass quality
  (blob<->faceted warp + a `glassQuality` slider, `computeApertureGlassWarpOffset`,
  via a new zero-default `extraSpokeOffsetPx` seam on
  `computeApertureGoboTerm`) and grime (`computeApertureGrimeFactor`,
  layered fbm+worley noise darkening, `grimeAmount`) with occasional
  hash-seeded broken panes (`computeAperturePaneIsBroken` +
  `computeAperturePaneCrackGeometry`, real crack-line SDFs). Chromatic
  RGB-shift was explicitly SCOPED OUT this round — it needs
  `buildApertureGoboTerm` to return an additional vec3 fringe term
  `point-light-illumination.js`/`point-light-coloration.js` would add
  post-mix, a real cross-file contract change, not a drop-in; left for a
  follow-up round. `keyhole-aperture-gobo.md`'s own "ROUND 13" section has
  the full story, including two bench-diagnostic false alarms (both
  harness/probe mistakes, not code bugs) and the actual PNG-level visual
  confirmation (pure blob = smooth wavy glass, faceted blend = sharp offset
  panels, `grimeAmount=1` = real visible crack lines through a mottled,
  dirtied pane field).
- **Round 14 (bench-verified numerically AND visually, not yet
  live-reconfirmed)** — two items. (1) A REAL BUG, not a polish request:
  *"lights which are large and outdoors and no where near any actual
  windows are being cut off at strange angles."* `findAperturesForLight`'s
  only distance filter was `light.radius` itself — a large light swept in
  ANY `light:PROXIMITY` wall anywhere within its own huge reach, however
  unrelated to a real window near it. Fixed with a new, independent
  parameter, `maxApertureDistancePx` (default 400) — the search radius is
  `min(light.radius, maxApertureDistancePx)`. (2) The round-13 faceted
  kernel redesigned: the author, on the original random-per-cell version,
  *"you slightly misunderstood... a simple enough manner to look like
  medieval decoration"* (illustrated with a real beveled stained-glass
  photo, its extreme, not its literal target). New
  `computeApertureFacetWedgeValue` divides a pane into angular wedges
  around its own centre, alternating by parity — an ordered sunburst
  medallion, not a hash-driven shatter. `keyhole-aperture-gobo.md`'s own
  "ROUND 14" section has the full story, including a genuine regression
  (moving the pane-index computation earlier broke `night-clear-pattern`'s
  own stale probe, fixed by isolating that scenario from round 13/14
  features entirely) and the actual PNG confirmation (a striking, ordered
  sunburst at `quality=1`).
- **Round 15 (bench-verified numerically AND visually — a real WebGPU
  render, not just the CPU spec — not yet live-reconfirmed)** — two live
  reports, ONE root cause. Author: *"I wish I could make the entire effect
  much more diffused and blurred... progressively so further away from the
  window"*, and *"the window light illumination doesn't moderate itself by
  the attenuation slider correctly... always acting as if attenuation was
  0... it should be fading out softly towards the bright and dim radius
  like the light normally would."* DIAGNOSED with a Node probe against the
  real CPU math before any code changed: a light whose radius reached far
  past its own window showed brightness flat then cutting to 0 within
  ~40px, IDENTICAL at attenuation 0.0/0.3/0.7 — `dist01` (what attenuation
  shapes) never grew large enough to matter before `computeApertureArcGate`'s
  own `xHead` boundary (a hard wall in floor-space `x`, derived purely from
  the WINDOW's own geometry — the light's radius and attenuation never
  enter into it) blocked the beam outright, and the existing contrast-floor
  cap held the blur at a fixed ~3px there regardless of distance — which is
  also why the author's own `softness` slider, already tried at its 4x max,
  barely moved anything. Fixed with ONE new signal,
  `REACH_SOFT_FAR_PX_BASE`/`computeApertureReachSoftPx` — grows with
  `x/xHeadReach` (the window's own geometric reach, not the light's
  radius), `Math.max`'d against the existing near-field cap on BOTH the
  spoke and arc axes (mullions melt into the same diffuse glow the sill/
  head boundary does), scaled by the SAME `softness` dial so the author's
  own already-authored setting now finally does something dramatic. A new
  `bench-aperture-gobo.js` scenario, `attenuation-reach-fade`, confirmed it
  on real hardware via an explicit A/B (`reachSoftFarPxOverride`): the
  saved PNG without the fix shows the beam terminate at a razor-sharp
  diagonal edge; with the shipped default, the same wedge fades softly over
  a real span. `keyhole-aperture-gobo.md`'s own "ROUND 15" section has the
  full story, including a test-threshold mistake caught the same way (an
  assertion that could never pass because it assumed a near-black ambient
  floor that wasn't actually near-black at the darkness level under test).
- **Round 16 (UNRESOLVED — named honestly, not silently dropped)** — a
  LIVE screenshot round 15 did NOT fix: at maximum attenuation, a hard-
  looking edge still visible right at the light's own dim-radius polygon
  (confirmed against Foundry's own drawn outline). Wall-clipping was ruled
  out first (author confirmed open floor, nothing nearby). An extensive
  real-WebGPU investigation followed — roughly a dozen configurations,
  including the author's own exact light numbers (dim radius 35ft, bright
  1ft, luminosity 0.3, attenuation 1) extracted via a real diagnostic-probe
  run against the live scene — could NOT reproduce a genuine one-step
  cliff in isolation; every curve came back smooth. `keyhole-aperture-
  gobo.md`'s own "ROUND 16" section has the full investigation, including
  a real misstep (asking whether the build was stale — the author's own
  sharp, correct pushback) and why the mismatch between "not reproducible
  in an isolated bench" and "a real screenshot" is left OPEN, not resolved.
- **Round 17 (bench-verified numerically AND visually, real WebGPU,
  post-bloom — not yet live-reconfirmed)** — the author's own requested
  pivot away from continued root-cause chasing: *"give me good effective
  controls to softly darken from all edges and I'll tune it myself."* Two
  new, independent, opt-in (0 = exact no-op) parameters —
  `edgeSuppressPx` (the window's own frame/sill/head edges, via two new
  standalone sub-gate functions, `computeApertureFrameOnlyGate`/
  `computeApertureSillHeadOnlyGate`) and `dimRadiusSuppressFraction` (the
  light's own dim radius, guaranteed exactly 0 at `dist01==1`) — that
  DARKEN toward true black near any of this aperture's own outer edges,
  independent of whatever Foundry's own attenuation curve is or isn't
  doing. Both fold into the SAME `.node`/`.gobo` value already consumed by
  `point-light-illumination.js`/`point-light-coloration.js`, so neither
  file needed a change. Confirmed on real hardware, post-bloom: a
  genuinely soft, edge-free glow with no visible boundary anywhere. This
  is a workaround the author can tune directly, NOT a claim that round
  16's own root cause has been found.
- **Round 18 (bench-verified numerically AND visually, real WebGPU — not
  yet live-reconfirmed)** — a live report on round 17's own controls:
  `dimRadiusSuppressFraction` at its own MAX had ZERO visible effect on
  the reported edge. This session first proposed a genuine (but wrong)
  alternative — a REAL, vendored-source-verified Foundry mechanic,
  `Edge#applyThreshold` (a `light:PROXIMITY` wall's own "Proximity
  Distance" turns it into a hard geometric light-blocker once the source
  is farther than that threshold, `useThreshold: true` always active per
  `point-light-source.mjs`) — the author correctly rejected it: *"the
  light terminates in a hard edge at the dim radius outer reach, not at a
  wall."* Then the actual, direct ask: *"I need controls based on the
  percentage of the overall size of the light... a fade starts at 100% of
  the dim radius and ends at 80%."* `dimRadiusSuppressFraction`
  (round 17, one knob, its outer anchor always pinned to the true edge)
  REDESIGNED — not added alongside — into `dimRadiusFadeStartPercent`/
  `dimRadiusFadeEndPercent`, two independent, SORTED percentage anchors
  (either order produces the identical gradient), both defaulting to 100
  (a zero-width band at the true edge — off). `edgeSuppressPx` (the
  window's own boundary) stayed untouched — the author's own report named
  it as already working. Confirmed on real hardware with the author's own
  literal 100/80 example: a genuinely smooth graded fade. `keyhole-
  aperture-gobo.md`'s own "ROUND 18" section has the full story, including
  the misdiagnosis logged (not silently dropped) for a future report that
  might actually match a wall-threshold shape.
- **Round 19 (real WebGPU-confirmed — not yet live-reconfirmed)** — two
  REAL bugs, found by taking the author's own message seriously rather
  than re-litigating round 18's own (deliberately unchanged) values.
  (1) *"the main 'pattern strength' control doesn't work at all"* —
  confirmed with a plain `grep`: `uStrength` was created and updated every
  frame but never once READ by either `point-light-illumination.js` or
  `point-light-coloration.js`, despite the intended `mix(1,node,uStrength)`
  being documented since round 10. Fixed in both files (coloration needed
  `mix` re-enabled in its own TSL destructure — safe, the reason it was
  disabled was a DIFFERENT, still-open `uShadows` issue, not `mix`
  itself). (2) *"lights can be all sorts of sizes, so you need to only use
  percentages everywhere"* — `edgeSuppressPx` had the exact scale-
  invariance bug round 18 already fixed for the dim-radius control, just
  not yet generalized here. Rebuilt as `edgeSuppressPercent`, normalized
  SEPARATELY per axis against its own natural span (`wallLen/2-frame` for
  spoke, `xHead-xSill` for arc) — with an explicit CPU/TSL-parity check for
  the "head unreachable" edge case (a real divergence risk: literal
  `Infinity` on the CPU side vs. this file's own "huge sentinel" idiom on
  the GPU side, caught by asking whether the port hit the same degenerate
  case, not by symptom-chasing). Confirmed live on real WebGPU: strength=1
  reads fully dark at a mullion, strength=0 reads fully bright, exactly as
  documented. `keyhole-aperture-gobo.md`'s own "ROUND 19" section has the
  full story, including which OTHER px-based values were deliberately left
  alone and why (authored window/wall geometry, not light-relative).

If extending this effect further, start from the memory file's own round-10
through round-19 sections and the "THE GOBO IS PART OF THIS LIGHT'S OWN
FALLOFF" header in `point-light-illumination.js`, not from §§3-13 below this
line.
