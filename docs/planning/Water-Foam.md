# WATER FOAM — the research, and the design that comes out of it

> **⚠️ 2026-08-16 — the build plan half of this file (§4–§5) is SUPERSEDED by
> `docs/holy/Water-Testament.md`** (W0/W4 for stateless foam, W7 for the memory rung). The
> research half (§0–§3, the six kinds, the measured distributions) remains the foam register
> of record and is cited by the Testament rather than duplicated there.

**Status:** RESEARCH + DESIGN, 2026-08-16. Commissioned directly by the author:
*"The shoreline and break near obstacles foam is such an important aspect of this
effect that I would be happy for you to go online and research lots of different
approaches... it's a huge effect with a lot of different types of foam and lots of
different ways of interacting with shorelines."*
**Scope target, in the author's own words:** *"everything from small ponds to
rivers, to huge lakes, shorelines and ocean shorelines eventually."*
**Owning code:** `src/effects/water/water-shore.js`, `water-field.js`.
**Parent:** `Water.md` §6 (the tier ladder).

---

## 0. The finding that reframes everything

> **Foam is not a texture. Foam is a substance with MEMORY — it is created,
> then carried by the flow, then it decays. Every technique that looks right
> models that; every technique that looks like "noise painted on water" is a
> pure function of position and time.**

MSA's foam today is a pure function of position and time. That is the single
biggest reason it reads as surface texture rather than as foam, and it is
independent of how good the noise is.

Three independent sources converge on this:

- **Sea of Thieves** (Rare, SIGGRAPH 2018) uses *"a buffer with feedback to
  simulate foam dispersing"*, then blends the resulting mask with artist-authored
  textures. A feedback buffer is memory.
- **Houdini's whitewater solver** advects foam through the liquid's own velocity
  field, and additionally advects a set of *"repellant points"* that push foam
  apart — *"breaking up its structure and creating 'bald' patches that form a
  larger cellular pattern."* Both the foam and the thing that shapes it move
  with the water.
- **Physical oceanography**: floating tracers cluster because surface flow is
  *compressible in 2D* — foam concentrates where the surface flow **converges**.
  Foam is not evenly distributed; it collects.

This does not mean the current rung is wrong to be stateless — a stateless rung
is the correct cheap tier. It means **the memory belongs on the ladder as its own
rung**, and it is the rung that will make the largest single difference. See §5.

---

## 1. Foam is at least six different phenomena

Treating "foam" as one effect is the mistake. Each of these has a different
cause, a different lifetime, and a different look, and an author wants different
amounts of each on a pond than on an ocean shore.

| # | Kind | Physical cause | Where it lives | Lifetime | Reads as |
| --- | --- | --- | --- | --- | --- |
| 1 | **Shore swash** | Waves running up the beach and draining back | A band at the waterline | Cyclic, seconds | Broad bands that ADVANCE then RECEDE |
| 2 | **Break foam** | Flow driven INTO an obstacle or a steep bank | Upstream face of rocks, outside of bends, headlands | Persistent while flow persists | Bright, tight, high contrast, one-sided |
| 3 | **Whitecaps** | Wave steepness passes the breaking limit | Open water, wind-driven | Seconds, then decays | Scattered transient patches |
| 4 | **Persistent scum / sargassum** | Foam is buoyant and surfactant-stabilised, so it ACCUMULATES where flow converges | Eddies, slack water, inside bends, against booms and barriers | Minutes | Lacy mats, long streak lines |
| 5 | **Spray / airborne flecks** | Bubbles thrown off a breaking crest, blown by wind | Just downwind of a break | Fractions of a second | Sparse bright specks with their own motion |
| 6 | **Sub-surface bubbles** | Air entrained by a break, rising | Under and just after a break | Seconds | Soft blue-white plume BELOW the surface |

**Why sea foam persists at all** (NOAA): surfactants — proteins and fats from
decaying plankton — form micelles around air bubbles and stop them popping. This
is why real shoreline foam is *lacy and long-lived* rather than a fizz that
vanishes: it is up to 90% air held in a network of interconnected channels. That
network is the visual signature, and it is why **cellular** noise is the right
primitive and a smooth ridge is not.

---

## 2. How the field generates each one

### 2.1 Shore distance — two methods, and we already have the better one

Every shoreline-foam technique needs "how far am I from the shore".

- **Depth-based** (`saturate((sceneDepth − waterDepth) / threshold)`) — universal,
  runs anywhere, but it is a *screen-space* proxy and it cannot tell a steep bank
  from a shallow one without extra work.
- **Distance-field based** — a real SDF. Better looking, more flexible foam
  widths, historically gated on DX11+.

**MSA already bakes a real signed distance field** (`res:waterBody`, JFA). So we
get the better method for free and none of the depth-buffer caveats apply. This
is a genuine structural advantage over most of the published techniques, and it
is why several of the tutorials' workarounds are simply not needed here.

### 2.2 Swash — the travelling band (kind 1)

The consensus technique, in two equivalent spellings:

- **Alisavakis:** `saturate(sin((d01 − t·speed) · 2π·N))`, then break it with a
  panning noise texture via `step(d01 − sine, noise)`. `N` bands travel shoreward.
- **Cyanilux:** distort `d01` with gradient noise, multiply up, take `frac`/`cos`
  to make repeating lines, then `smoothstep` to thin them; combine an approaching
  wave and a swash wave with `max()`.

Both agree on the shape: **a periodic function of (shore distance − time)**,
noise-distorted, thresholded thin. Subtracting time makes bands travel *toward*
shore. Multiplying the result by `(1 − d01)` keeps them from appearing in deep
water.

### 2.3 Break foam — the one that needs no new data at all

Published advice is *"vary foam depth by the surface angle below water, so
nearly vertical surfaces like rocks get deeper foam than flat shoreline"*, and
*"compare the depth of objects behind the water with the water surface depth"*.

**MSA can do something better and cheaper, because it bakes a flow-relative
field.** The body pack's BA channel stores the shore tangent, and the shore
NORMAL is one 90° rotation away:

```
outward     = ( tangent.y, −tangent.x )     // unit, points AWAY from nearest shore
breakFoam01 = max( −dot(flowDir, outward), 0 )
```

`−dot(flow, outward)` is *"is the current heading toward my nearest shore"*. It
is **+1 on the face a rock presents to the stream, 0 in its lee, and it flips
correctly around every bend with no special-casing** — because `outward` is
defined per-pixel from whichever bank is nearest. That is exactly the author's
*"break near obstacles"*, from data already in the bake, for one dot product.

⚠️ It needs the same distance gate the bank warp needed: the tangent is
well-conditioned near a bank and meaningless at the medial axis
(`WATER_BANK_REACH_PX`'s own lesson). Foam bands are shore-tight anyway, so the
gate is already there.

### 2.4 Whitecaps — steepness, which tier 2/4 already compute

Standard practice is a **Jacobian whitecap**: foam where the surface's own
Jacobian says it is folding/steepening. MSA already computes exactly this
Jacobian at tier 4 for caustics. Whitecaps are a second read of it, free.
(Currently the crest test uses the raw noise channel instead, which is a
reasonable stand-in.)

### 2.5 Persistent scum / sargassum — the convergence insight

Floating tracers cluster where the surface flow **converges** — that is
literally why sargassum forms lines and mats rather than spreading evenly.

**MSA already has the convergence measure.** `det(I + k·J) < 1` is a converging
patch; that same determinant currently drives caustics. Foam accumulation and
caustic focusing are *the same quantity read twice* — which is a satisfying and
non-obvious economy, and it is what a scum/sargassum rung should be built on
rather than a new field.

⚠️ But accumulation is inherently **stateful** — "collects over time" cannot be
expressed as a function of the current frame. This kind belongs to the memory
rung (§5), not to a stateless one.

### 2.6 The cellular signature — why the current filaments are wrong

Houdini's repellant points produce *"bald patches forming a larger cellular
pattern"*. Real foam is a **net with holes**, not a set of veins.

- `1 − smoothstep(0, w, |noise|)` — what MSA shipped — produces **ridges**:
  bright lines where a smooth noise crosses zero. That is a vein/crack pattern.
- `smoothstep(lo, hi, worley)` produces **cell walls with dark centres** — a
  lacy net. That is foam.

**Measured on this build's own GPU** (2026-08-16), so the calibration is not
assumed:

| Field | p10 | p50 | p90 | notes |
| --- | --- | --- | --- | --- |
| `mx_fractal_noise_vec3(...,2,2,0.5).x` | — | \|x\| 0.197 | \|x\| 0.469 | RMS 0.281, range ≈ [−0.88, 0.98] |
| `mx_worley_noise_float(p, 1)` | 0.097 | 0.298 | 0.590 | range ≈ [0, 1.18], ~9.3% above 0.6 |

⚠️ **The shipped ridge width of 0.16 lights up 41.6% of the band** — a wash, not
filaments, which is exactly why the author reported *"no sign of additional
shoreline foam"*: it was there, as an even haze, indistinguishable from the
tier-2 foam beneath it. And MSA's own test asserted the band was a "minority" of
the range by assuming a **uniform** distribution over [−1, 1]. The noise is
peaked at zero, not uniform. That is a lying test of exactly the kind
`WATER_TIER3_CHOP`'s own docstring warns about three screens further up the same
file.

⚠️ **`mx_worley_noise_float` in this vendored build takes `(texcoord, jitter)`
ONLY** — the wrapper hardcodes the MaterialX distance-metric argument to `1`.
Passing a third argument is silently ignored (verified: all three "types"
returned byte-identical statistics).

---

## 3. Scale — pond to ocean, the author's explicit requirement

The failure mode is a foam whose feature size is authored in world pixels: tuned
on a river it becomes invisible speckle on a lake and a smear on a pond.

**Rule: every foam length is expressed relative to a BODY-SCALE quantity, never
as a bare pixel constant.** MSA already has one the author sets per scene —
`depthScalePx` ("how far in from the bank the water reaches full depth", i.e.
roughly half the width of the widest channel). Foam reach, cell size and band
count should default as fractions of it, with their own overrides for authors who
want to fight the default.

Practical consequence per body type:

| Body | `depthScalePx` | Wants |
| --- | --- | --- |
| Pond | small (~60) | almost pure rim foam, no swash, no whitecaps |
| River | ~150–300 | break foam dominant, swash weak, streaks along the bank |
| Lake | large (~600) | thin rim, wind-side break foam, calm elsewhere |
| Ocean shore | very large | swash dominant, many bands, heavy persistent scum at the top of the swash |

This is a strong argument for eventually shipping **foam presets keyed to body
type** rather than asking an author to find these balances by dragging six
sliders — recorded as an idea, not built.

---

## 4. What is being BUILT now (tier 4 rework)

Stateless, no new buffers, replaces the invisible ridge:

1. **Swash bands** — periodic in `(shoreDist − time)`, so they travel shoreward,
   noise-distorted, thinned by smoothstep, faded out with depth.
2. **Break foam** — `max(−dot(flowDir, outward), 0)`, from the bake's own
   tangent. One-sided foam on every obstacle face and the outside of every bend.
3. **Cellular breakup** — Worley cell walls, calibrated against the measured
   distribution above, so foam reads lacy with bald patches.
4. All three land as ONE additive contribution to the existing foam total
   (Effects.md Law 2 — a rung ADDS, never substitutes).

## 5. What is DEFERRED, and honestly named

These are real rungs, not hand-waving. Each needs something tier 4 does not have.

| Rung | Needs | Why it is not smuggled into tier 4 |
| --- | --- | --- |
| **Foam memory** (generate → advect → decay) | A ping-pong RT pair, a per-frame sim | **C7.** Ticks whether seen or not, so it needs Law 7's coverage/zoom gate as well as a tier. This is the single highest-value future rung — it is what Sea of Thieves' feedback buffer buys, and it is the difference between foam and texture. |
| **Persistent scum / sargassum mats** | The memory rung + the convergence read | Accumulation is stateful by definition. Reads `det(J)`, already computed. |
| **Spray / airborne flecks** | The one particle engine | **C8**, and the ladder already has it as tier 8 `spray`. |
| **Sub-surface bubble plumes** | The refraction rung's dependent read | A plume must sit visibly BELOW the surface; without refraction it is just more white on top. |
| **Foam-type presets by body** | All of the above, plus author time | Needs the real controls to exist before a preset over them means anything. |

---

## Sources

- [Shoreline Shader Breakdown — Cyanilux](https://www.cyanilux.com/tutorials/shoreline-shader-breakdown/)
- [My take on shaders: Stylized water shader — Harry Alisavakis](https://halisavakis.com/my-take-on-shaders-stylized-water-shader/)
- [The Technical Art of Sea of Thieves — Ang et al., SIGGRAPH 2018](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf)
- [Whitewater Solver — SideFX Houdini docs](https://www.sidefx.com/docs/houdini/nodes/dop/whitewatersolver.html)
- [Guided bubbles and wet foam for realistic whitewater simulation — Wretborn, Flynn & Stomakhin, ACM TOG 2022](https://dl.acm.org/doi/10.1145/3528223.3530059)
- [Clustering of floating tracers in weakly divergent velocity fields](https://arxiv.org/pdf/1906.10291)
- [How does sea foam form? — NOAA](https://www.noaa.gov/education/resource-collections/special-topics/hands-on-science-activities/sea-foam/explanation)
- [Sea foam — Wikipedia](https://en.wikipedia.org/wiki/Sea_foam)
- [Cellular noise — The Book of Shaders](https://thebookofshaders.com/12/)
- [Distance field based foam for water shader — Unreal Developer Community](https://forums.unrealengine.com/t/distance-field-based-foam-for-water-shader/133034)
- [A Survey of Ocean Simulation and Rendering Techniques in Computer Graphics](https://arxiv.org/pdf/1109.6494)
