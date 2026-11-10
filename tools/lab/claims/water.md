# Claims: water (MSA Lab, Lab · Water, 2026-11-09)

Written 2026-11-09, BEFORE measuring (expectations first). Plots are in `tools/lab/water-spec.mjs` (Lab · Water,
A, B1, B2, C1-C3). Each claim names its source and how it is judged. Bands are wide: physics is the baseline, her taste
decides inside it ("real numbers make a good baseline, then tune for looks").

**The brief (Ingram, 2026-11-09):** the Docklands water goes clear in a ring round every boat although the `_Water`
mask is white right up to the hull: "nonsense". Depth comes from the mask's brightness. Build a neutral, good default:
"a body of water from a puddle to a raging deep sea ... viewed directly from above".

**Sources.** `Physics` = cited. `MSA` = code/param help. `Author` = her words (rants archive, by date). `Maps` = her
`_Water` masks measured 2026-11-09.

## What her masks are (Maps, measured 2026-11-09)

| map | share of water pixels that are soft (8-247) | mean in water |
|---|---|---|
| Docklands, Flooded River Prison (3 masks), Monastery (7) | 1-7% | 247-255 |
| River Ford 10%, Tower Bridge Underground 21% | | 228-242 |
| Japanese Horror House 64%, Goblin Alchemist 95%, Speakeasy 100% | | 100-175 |

So most of her masks are hard silhouettes (white water, black hulls/piers/banks), and three paint real depth gradients.
A rule that reads depth from brightness gives the silhouettes one even depth and the painted ones their painted depth.

## Real-world numbers (cite these)

| quantity | value | source |
|---|---|---|
| reflectance of calm water seen straight down | 2.0% (n = 1.333) | Fresnel |
| pure-water absorption per metre | red 0.45, green 0.06, blue 0.006 | Pope & Fry 1997 |
| visibility depth (Secchi) | muddy puddle 0.05-0.2 m, harbour/river 0.3-2 m, lake 1-10 m, open ocean 20-40 m | limnology texts |
| deep water's own colour (water-leaving reflectance) | clear ocean 2-6% blue; silty coastal 5-15% green-brown | ocean colour remote sensing |
| whitecap cover W = 3.84e-6 U^3.41 | 0.1% at 5 m/s, 1% at 10, 4% at 15, 10% at 20, 22% at 25 | Monahan & O'Muircheartaigh 1980 |
| whitecaps begin | ~3-4 m/s (Beaufort 3) | Beaufort scale |
| wave slope spread (Cox-Munk) | sigma^2 = 0.003 + 0.00512 U: 0.06 rad rms calm, 0.23 at 10 m/s | Cox & Munk 1954 |
| waves are fetch-limited | puddle (1 m fetch): ripples of 1-3 cm only; pond (20 m): ~0.5-1 m waves at 10 m/s; open sea: tens of m | JONSWAP |
| caustics | brightest in clear water < ~2 m deep, gone in murky or deep water | optics |
| foam brightness | fresh whitecap albedo ~0.5-0.6, not pure white | Frouin et al. 1996 |
| scale | 98.43 px per metre (150 px = 5 ft) | MSA `core/scene-scale.js` |

## Hopes (what a GM should see)

1. Water looks like water at every size, under one neutral default, with no tuning per map.
2. A puddle reads as a wet, slightly darker, slightly glossy patch of the ground it lies on, not a coloured sticker.
3. A pond or river shows its bed in the shallows and loses it toward the middle, in a colour that belongs to water.
4. A harbour is deep right up to its quay, hulls and piles: the boats sit IN dark water.
5. Open sea is dark and deep; in a gale it is rough, streaked and capped with white, and that roughness never
   appears in a puddle.
6. Edges are soft where the author painted them soft and crisp where she painted them hard; never a ring, a halo
   or a band at a fixed distance from an edge.

## Claims

### Depth follows the mask (plots A, B1, B2, C2)

| id | claim | source | judged by |
|---|---|---|---|
| W-01 | No clear ring at a hard edge: on a uniform bed with mask 255 to the hull, the presented colour 4-32 px from the hull matches the colour 256 px away within 6/255 per channel | Author 2026-11-09 | B1 transects hullE, hullS, pierE, quay |
| W-02 | The same holds on her Docklands strips: no lighter (clearer) band hugging any boat or pier | Author 2026-11-09 | B2 shots, zoomed |
| W-03 | Depth is monotonic in mask brightness: each step of A hides more of the checker (contrast c2-c1 falls step on step) | Author 2026-11-09, physics | A step probes |
| W-04 | The 0->255 ramp shades smoothly: no visible band, kink or step along it | Author (soft falloffs) | A ramp shot |
| W-05 | A mask step from 224 to 255 is a small change, not a jump (the response has no knee near white) | physics | A probes |
| W-06 | At mask 32-64 the bed is still clearly readable (contrast >= 60% of dry) | physics (shallow film) | A probes |
| W-07 | At mask 255 the bed is mostly hidden under the default (contrast <= 35% of dry) but not a flat paint (some bed detail survives) | MSA history ("looks like paint", 2026-07-26); physics (harbour Secchi ~1 m) | A probes |
| W-08 | A sloping bank (C2, C3 beach) fades from clear at the waterline to deep with no band | physics | C2, C3 transects |

### Colour and light (plots A, C)

| id | claim | source | judged by |
|---|---|---|---|
| W-10 | Deep water's colour is a plausible water colour (dark green-brown, blue-green or navy), never grey and never saturated paint | physics; Author ("looks like paint") | A s255 swatches, C3 |
| W-11 | Red is lost first with depth (red swatch darkens fastest, blue slowest) unless pollution says brown | Pope & Fry | A swatch rows |
| W-12 | Calm water seen from above has little sky sheen: deep calm water is darker than the dry ground, not paler | Fresnel 2% | C3 deep vs dry sand |
| W-13 | Caustics: only in shallow clear water in sun, fading with depth; never over deep water | optics | A, C2, C3 |
| W-14 | Dry land is untouched: 1 px outside a hard black edge equals the bare art | MSA 631ff15f, mmp-7kx.2 | B1, B2 |

### Size and weather (plots C1-C3)

| id | claim | source | judged by |
|---|---|---|---|
| W-20 | Puddles read as wet ground: darker and glossier than dry ground, the cobbles still plain | physics | C1 |
| W-21 | Puddles and small ponds do not flow like a river (no travelling current pattern) | physics | C1, C2 motion |
| W-22 | Calm (wind 0): open water is near-glassy, no foam except where it meets an edge | physics | C3 |
| W-23 | Gale (14-20 m/s): open sea shows whitecaps of a few % cover and streaks along the wind | Monahan; Beaufort | C3 wind runs |
| W-24 | A puddle in the same gale ripples but shows no whitecaps or big waves (fetch) | JONSWAP | C1 wind run |
| W-25 | Foam is off-white and broken, never solid white blobs, and stays off unpainted land (hull ink) | Frouin; Author 2026-11-06 | B1, B2, C3 |
| W-26 | Edges: lapping foam at hard edges is thin and broken; no edge foam on a soft beach at calm | physics | B1, C3 |

### Measured afterwards

Each claim gets a verdict (pass / MSA bug / wrong claim / taste) in the session report with the shot it came from.
