# The Shadow Cascade — real heights, banded casters, depth-resolved receivers

**Status: BUILT, lab-verified on the real map, NOT live-confirmed.** 2026-08-05.
Plan of record for the change; the MODEL it extends is
[`Sun-Shadows-Layer-Smear.md`](Sun-Shadows-Layer-Smear.md), which is unchanged
and still correct — this adds real elevations to it, it does not replace it.

---

## 0. The brief

> *"use the depth buffer + shadows + sun angle to allow shadows to
> semi-realistically cascade downwards, getting softer and more diffuse as they
> do so. The ideal situation would allow you to find out how buildings which are
> several stories tall might cast their building, sky reach and overhead shadows
> and have a much longer larger shadow produced as a result of having access to
> the information for all floors. This means allows the black part of _Outdoors
> to cast a shadow downwards into the zero opacity gaps in the scene and have
> them cascade downwards until they hit a solid albedo surface."*
> — the author, 2026-08-05

Three asks, and they are three different mechanisms:

| # | Ask | Where it was broken | Section |
|---|-----|---------------------|---------|
| 1 | A several-storey building throws a **much longer** shadow | Every floor above the receiver was ONE merged silhouette at ONE **authored slider** height. Adding floors changed nothing. | §2 |
| 2 | Shadows get **softer and more diffuse** as they fall | Penumbra scaled with horizontal *throw*, so at a high sun a roof three storeys up read exactly as crisp as a kerbstone. | §3 |
| 3 | Shadows fall through gaps and land on **whatever solid surface is below** | Already worked, via per-floor fields + a floor match — but the match read `buf:scene.attr`, an alpha-blended MRT write, not the depth authority. | §4 |

---

## 1. What was already right, and stayed untouched

The layer-smear model is author-confirmed live (*"Absolutely perfect looking!
You have done it"*, 2026-08-03) and none of it changed:

- Four occluder layers, each a flat silhouette at ONE height, smeared toward the
  sun, `max` **within** a layer, `×` **between** unrelated layers.
- The per-floor slot pool, the bottom-up bake order, `slot index IS floor index`.
- The receiver gate, the self-shadow exclusions, the sky-reach depth gradient,
  the map-edge ramp, the tier ladder.
- THE LAW's proof and its (downgraded) sweep check.

**The whole change is: better-fed layers, at real heights, with a real receiver.**

---

## 2. Ask 1 — the caster stack becomes two REAL bands

### 2a. The decomposition

`mask-derive.js` already produces, per floor F, a `coverAbove` grid: the union
of every item's art alpha at or above floor F's ceiling. Read **across** floors,
that is already a nested ladder:

```
coverAbove(F)    = art of floors F+1, F+2, …    ⊇
coverAbove(F+1)  = art of floors F+2, …         ⊇
coverAbove(F+2)  = art of floors F+3, …
```

So band `k` for a receiver on floor F is simply **`coverAbove(F+k)`** — a grid
that already exists, for a floor the mask authority already derives, one floor
index away.

> ⚠️ `packLayerTexelData`'s own previous header called this split blocked on
> *"a per-floor cover grid `deriveFloorProducts` does not expose yet"*. That was
> wrong, and wrong in the [[feedback_negative_grep_became_architecture]] way:
> "the producer does not expose this" was a claim about a call nobody had made.

Each band carries the elevation of its **lowest member**, because its taller
members are covered — more narrowly, and so more correctly — by the next band
up. A setback falls out for free: a wide second storey under a narrow tower sits
only in band 0 and throws band 0's short shadow; the tower sits in both, and
`max` picks band 1's long one.

**The LAST band absorbs everything above it**, so it carries the top of the
stack rather than its own lowest member. With more floors than bands, it
over-estimates the storeys it swallowed — a deliberate direction to err in (the
ask is explicitly "much longer"), and `resolveShadowBandPlan` reports
`mergedFloorsAbove` so the cap is visible rather than silent.

### 2b. Elevation → pixels is a READ

`readGridDistancePixels()` → `canvas.dimensions.distancePixels`, Foundry's own
pixels-per-grid-distance-unit, already read verbatim for the light-radius
formula. Deliberately NOT re-derived from `grid.size / grid.distance`.

**The sanity check that made this trustworthy enough to replace a hand-tuned
slider:** the author's own River Town Bridge map bands its three floors
`0-20 / 20-40 / 40-∞` on Foundry's default 100px/5ft grid ⇒ 20 px per unit ⇒
one storey is **exactly 400 world px** — and `aboveHeightPx`'s hand-tuned
default was **also exactly 400**. The derivation reproduces the number the
author arrived at by eye, on their own map, before it existed.

Measured, on that map, through the real derivation:

| receiver | band 0 | band 1 | source |
|---|---|---|---|
| underground | 400 px | 1060 px | elevation |
| middle | 660 px | — | elevation |
| roof | — | — | nothing-above |

### 2c. Where the channel came from — no new memory

The layer texture is one RGBA8 per floor slot (16 MB each at the Extreme rung ×
6 slots). A second texture was not acceptable. The A channel was carrying THE
CASCADE's blend factor — the lower floor's `coverAbove`, packed in by the CPU —
which is **the same grid the lower SLOT already holds as its own band 0**. So
the lower slot publishes it itself, in its own baked field's alpha
(`uCascade`), and the slot above reads `lowerFieldTexNode.sample(uv()).a`.

Same value, same wire, published by the owner instead of copied into every floor
above. Cost: zero bytes. The field's alpha was `1` and unread — every consumer
reads `.r` (`buildSunVisibilityNode`, `point-light-illumination.js`'s
`sampleSlot`, the debug view's one-hot mask), and the bake material is opaque so
three compiles no blend state that could touch it.

**Polarity flipped with the meaning, and that is the trap worth naming:** an
absent *blockage* had to read 255 (fully blocked — the cascade must be a no-op,
not a hole), an absent *silhouette* must read 0 (nothing there casts nothing).
Same channel, opposite safe default, because they are opposite questions.
`uCascade` publishes `1` when the slot is inactive for the same reason.

### 2d. Bands UNION, they do not compound

Everything else in the model multiplies transmittances, and the argument for
that is right — a wall beside you and a deck above you are different occluders
in series. **The bands are not that.** They are one physical stack sliced at two
elevations, and they are nested by construction, so multiplying them would
double-darken every multi-storey building and keep darkening with every floor
added: a five-storey tower's shadow going blacker than a three-storey one's for
no physical reason, and *"a little light should leak through"* quietly ceasing
to be true as scenes got taller.

`max` is also what the model already uses *within* a layer, for the same stated
reason: those samples are one occluder seen from many distances. The bands are
one occluder seen at many elevations.

**Consequence worth stating: for a two-floor scene, band 1's throw is 0, so this
reduces to exactly the pre-cascade arithmetic.** The picture on short stacks is
byte-identical.

---

## 3. Ask 2 — softness follows the FALL, not the throw

The existing station blur widens with distance **along the shadow**, so at a low
sun everything is soft and at a high sun everything is crisp — regardless of how
far the light actually fell. A shadow's penumbra is set by the caster's
**vertical drop**: at noon a roof three storeys up still casts a markedly softer
edge than a kerbstone.

`layerDiffusionBlurPx(heightPx, softnessMul) = height × 0.12 × softnessMul`, a
**floor** on the station blur (`max`, never a replacement — the two answer
different questions, and adding them would double-count the near field).

`0.12` is a LOOK constant, ~13× the sun's physical `tan(0.53°) ≈ 0.0093`, and is
scaled by the shared atmospheric `softnessMul` whose shipped default
(`softnessBias` 0.25) brings it to ≈0.03 — about three times physical, which is
what makes it readable at map zoom rather than a sub-pixel technicality. Cloud
and night soften it further through the SAME multiplier every other caster reads
(`effects/shadow-access.js`), so night-under-cloud stays the softest case
without a second model saying so.

**This is what forced a per-layer texture read.** One shared fetch per station
served all four layers; they now want different mips. Paid for by scoping the
sky-reach gradient's nested reads to the band layers at BUILD time
(`LAYER_HAS_DEPTH_GRADIENT`) — a JS-time branch, since TSL cannot skip a fetch
on a runtime uniform, and only the band layers have ever been given a radius:

| | before | after |
|---|---|---|
| sharp reads / station | 1 | 4 |
| depth-gradient reads / station | 12 | 6 |
| **total** | **13** | **10** |

Strictly fewer samples, one more feature.

---

## 4. Ask 3 — the receiver comes from the depth authority

`blendSunVisibilityAcrossFloors` weights each floor slot by
`|fragmentFloorIndex − slotFloorIndex|`. That fragment floor index now comes
from **`buf:scene.depth`'s colour attachment** (`depthFlagsTexNode.r`), not
`buf:scene.attr`.

Both channels carry `floorIndex / 255`, written by the same
membership-then-band lookup — so the arithmetic is unchanged. What changed is
**who decides the winner**: the depth pass uses a hard `LessDepth` test and a
real alpha-test discard; attr used an alpha-blended MRT write. That is the
difference between *"the surface actually visible here"* and *"whatever last
blended into this texel"*, and it is what makes a shadow fall through a hole
onto exactly the floor the eye sees through it
([[keyhole-orthographic-hole-stack-model]]).

**Presence, newly available:** the depth colour clears to `(0,0,0,0)`, so a
pixel with no drawn surface reads `floorIndex = 0` — which would match floor 0's
slot and apply the ground floor's shadow to a hole in the map. `attr` had the
same latent gap, invisible there only because an empty pixel has no albedo to
darken; a point light has no such luxury (it multiplies its falloff by this, and
would carve a ground-floor silhouette out of a light shining over open nothing).
`presence = depthFlagsTexNode.a` multiplies the weight, so an absent surface
falls through the existing "matched nothing ⇒ fully lit" arm.

This brings sun shadows under
[[keyhole-depth-authority-sole-system-decision]]'s lock. `attrTexture` remains
wired as the fallback for a caller with no depth colour; the live report says
which is in use (`sunShadowFloorGateSource`).

---

## 5. What was measured, and where

`npm run verify` green — **7508 tests**, lint, format, 29 structure rules
(9 ratcheted, none moved).

**Shader Lab, real WebGPU, the real Tower Bridge art through the real
derivation** (`window.lab.run('sun-shadow', …)`):

- `all-floors-stack` — **ok, 4/4**, including the new
  `band-heights-are-derived-and-fall-with-the-receiver`:
  `underground=[400,1060] middle=[660,0] roof=[0,0]`, every floor
  `source: 'elevation'`.
- Band 1's channel is genuinely populated from real art on the ground floor:
  `coveredPct 20.2, meanByte 48.7, maxByte 255`.
- **A/B against the pre-cascade model** (band 1 muted, which is exactly the old
  single-height behaviour since band 0's derived 400 px equals the old slider
  default): at 30° elevation **5,390 texels changed, max darkening 127/255**; at
  12° **11,980 texels darker** — and **exactly 0 texels lighter, worst
  lightening 0**, across 4.2 M pixels. The `max` combiner provably cannot
  brighten an existing shadow.
- `layer-smear-real-floor` on `underground` reports the same four failures
  **byte-for-byte identical with the cascade on and off** — they are pre-existing
  (`the-law-*` is [[keyhole-layer-smear-model]]'s own downgraded check;
  `no-holes-or-halos` is the known real-architectural-detail miscount;
  `survives-the-live-floor-gate` at 98.8% is honest for the *bottom* floor of a
  bridge map, where the deck covers nearly everything).

**Honest scale note:** on THIS map the cascade touches 0.13–0.29% of the ground
floor's field, because the bridge deck already covers 74% of it and band 1 is
nested inside band 0. The new length shows up in the open river channel beside
the tall parts — exactly the *"zero opacity gaps"* geometry the brief names. A
map with a tower beside a courtyard will show far more.

---

## 6. What is deliberately NOT done

- **Not live-confirmed.** Lab-green is `BUILT (unverified)`; only the author's
  own eyes on their own scene promote it ([[keyhole-current-state]]).
- **`overheadHeightPx` is still an authored slider**, and that stays a named
  simplification: an overhead tile's height is a PER-TILE fact (an awning and a
  walkway on one floor sit at different heights), and this model carries one
  height per LAYER by construction. It would need a per-tile layer or a
  per-texel height — and per-texel heights are the model this one replaced.
- **`SHADOW_BAND_COUNT` is 2.** Three-plus storeys above one receiver merge into
  the last band, reported via `mergedFloorsAbove`. Raising it costs a second
  texture per slot (16 MB × 6 at Extreme) and should be measured, not assumed.
- **The 512 coarse-alpha cap is untouched** ([[reference_coarse_alpha_512_cap]]).
  Band silhouettes inherit it exactly as `coverAbove` always did — a small hole
  in a roofline still casts. The GPU depth pass renders real textures at real
  resolution and is the obvious eventual fix, but it only sees art that is
  currently *resident and drawn*, and the caster stack must include floors that
  are not — so it is a genuinely bigger change, not a re-point.
- **`buf:scene.depth`'s G channel is still 0** (its documented gap). Writing the
  winner's real elevation there would let a receiver's own height shorten its
  shadow (a balcony tile inside a floor's band), which the per-floor baked field
  cannot express. Deferred, named.
