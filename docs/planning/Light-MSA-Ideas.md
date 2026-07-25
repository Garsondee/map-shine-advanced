# MSA LIGHT IDEAS — the Type-B menu (what WebGPU/TSL unlocks beyond Foundry)

**Status:** IDEA BANK, 2026-07-17. The "Type-B / MSA-native" half of [[keyhole-two-light-types-decision]] — lights that only render in MSA and do what Foundry can't. Parity (Type-A) is a different doc (`Light-Parity.md`); this is the playground.
**Grounded in:** the C0–C8 cost ladder (`Effects.md` §1), the authored material masks (`src/scene/mask-catalog.js`), and the GI note already banked in `Forward+.md` §16.4.
**How to read:** every idea is tagged **risk** and **cost class**, and rated for **2D fit** — because this is a top-down plane, not a 3D world, and honesty about that is the point.

---

## 0. The lens — what a top-down 2D plane actually gives us

The instinct "we're 2D so we can't do the fancy lighting" is **half wrong**, and the half that's wrong is the important half:

**What we GIVE UP vs a 3D engine** (no apology, just true): no real geometry, so no geometric ambient occlusion, no screen-space reflections of a scene, no volumetric shadows cast through 3D, no parallax from a mesh, no camera-orbit specular. Anything that needs _depth complexity_ or _a third axis to move the eye through_ is either out or faked.

**What we UNIQUELY HAVE, that most renderers don't** (this is the exciting half): **per-pixel, artist-authored material data.** The mask catalog already carries `_Normal`, `_Roughness`, `_Specular` (coloured), `_Iridescence`, `_Prism`, plus `_Water`/`_Fire`/`_Tree`/`_Bush`. That is a **hand-painted G-buffer.** A 3D engine derives normals from geometry it has to build and pay for; we get them _for free from the artist_, exactly where they want relief, at whatever detail they painted. In Maya terms: every map ships with its own bump, spec, and roughness network already wired — we just have to light it.

And critically for the item you flagged: **we are already a screen-space, single-plane, emissive-buffer renderer.** That is the _ideal_ substrate for modern 2D global illumination. Bounced light is not a stretch for this architecture — it's a natural fit (§B).

**Backend note:** V3 is WebGPU now, so **compute shaders and indirect dispatch are available.** Several "rejected — no compute in WebGL2" notes in `Forward+.md` (e.g. §16 GPU-culling) are WebGL2-era and reopen under WebGPU. GI and compute-driven particles are on the table because of it.

---

## Legend

**Risk** — 🟢 **Mature** (shipped, well-understood, low unknowns) · 🟡 **Proven-recent** (real and shipping somewhere, but newer / fewer reference impls / needs care) · 🔴 **Experimental** (research-grade; may not reach real-time at quality — build only as a spike).

**Cost** — the highest class it touches (`Effects.md` §1): C1 ALU · C2 resident tiling read · C3 graph-buffer read (`scene.illum`/`scene.attr`) · C4 VT sample · C5 dependent read (coord from a read — ray march, refraction) · C6 extra RT · C7 per-frame sim. Everything here is a **tier rung**, never tier 0 — Type-B is opt-in flair by definition.

---

## A. Surface response from the authored G-buffer — 🟢 the biggest mature win

**Do this first.** It's the cheapest path to "holy cow it's actually lit," it's low-risk, and it's uniquely ours because the maps already exist. Much of it lands in the already-declared `surface.response` pass (which absorbs the V2 Specular/Normal/Roughness/Iridescence/Prism effects), so it's partly a port, not an invention.

| Idea                                        | Risk | Cost | What it looks like                                                                                                                                                                                                                                            |
| ------------------------------------------- | ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Normal-mapped relief**                    | 🟢   | C4   | Sample `_Normal`, do `N·L` per light against the screen light direction. Flat flagstones get _depth_; a torch rakes across brickwork and the mortar lines pop. **The single highest-impact Type-B feature** — it converts "a lit photo" into "a lit surface." |
| **GGX / Blinn specular**                    | 🟢   | C4   | `_Specular` (tint) × `_Roughness` (spread) → a highlight that **tracks the light**. Wet cobbles glint, a sword blade catches the candle, gold trim sparks. Same GGX lobe Water.md already specs for water — one shared node.                                  |
| **Emissive materials feed the light field** | 🟢   | C3   | `_Fire`/lava/glowing runes write into the illumination buffer as real emitters — they light their surroundings, not just themselves. Prerequisite for GI (§B) to have something to bounce.                                                                    |
| **Iridescence / thin-film**                 | 🟡   | C4   | `_Iridescence` → hue shifts with light angle (oil sheen, beetle carapace, magic ice). Known shader; medium because the angle basis in 2D needs a convention.                                                                                                  |
| **Fake crevice AO from normals**            | 🟡   | C4   | Derive a cheap cavity term from `_Normal` curvature (or an authored `_AO`) to darken creases — recovers _some_ of the geometric AO we give up, artist-directed.                                                                                               |

> Maya framing: this is just plugging the authored bump/spec/roughness maps into a light. The novelty is only that the "geometry" is a painting.

---

## B. Bounced / indirect light — 🟡 the one you flagged, and it's real-time-viable

You asked for bounced light **only if it's real time.** Good news: real-time 2D GI is a solved-and-improving area, it's _already the banked direction_ (`Forward+.md` §16.4 calls radiance cascades "the single biggest AAA-look unlock" for this renderer), and our screen-space emissive+occluder buffers are exactly what it consumes. Even better, it **ladders** — the cheap rung is trivial and the top rung is the shiny thing, same _term_ the whole way up (Effects.md Law 2).

### The ladder (cheapest → best)

**B0 · Screen-space colour bleed — 🟢 Mature, C6 (cheap, bloom-class).**
Take the lit buffer, blur it down a mip chain (the bloom pyramid we already have), tint the blur by local albedo, add a fraction back. The red rug throws a faint red wash on the near wall; a green torch bleeds green onto the floor. **Not** directional or accurate — but it reads as "the light bounced," costs almost nothing, and gives _everyone_ (down to the floor card) a taste of indirect. This is the tier-1 rung under the real thing.

**B1 · 2D SDF global illumination — 🟡 Proven-recent, C5+C6.**
Build a signed-distance field of occluders/emitters (jump-flood, a couple of passes), then per pixel march a handful of rays toward the emissive buffer, accumulating radiance _coloured by the surfaces it crosses_. Gives **directional single-bounce colour bleed with soft shadows** — a doorway spills a warm fan of torchlight across the corridor floor, softening as it goes. Widely implemented (the "2D GI" blog/shadertoy genre), so reference material is plentiful. Cost scales with ray count; needs temporal accumulation or a denoise to stay smooth. **This is the mature fallback if B2 feels too bleeding-edge.**

**B2 · Radiance Cascades — 🟡 Proven-recent, C5+C6(+C7). THE one.**
A hierarchy of radiance probes at increasing angular / decreasing spatial resolution, each cascade ray-marching a short interval and merging into the next. Designed _by_ Alexander Sannikov _for 2D_ and shipping in **Path of Exile 2** — this is not a research toy, it's in a AAA game right now. It delivers **penumbra-correct soft shadows, multi-directional bounced colour, and near-_constant_ cost at screen resolution** (it scales with pixels, not lights or occluders — which is exactly the `O(screen)` invariant Keyhole is built around; `Forward+.md` §14.1). For a scene of many torches in a stone dungeon it's transformative: warm pools that bleed into each other, coloured light wrapping around pillars, shadows with real softness.

- **Why it fits us specifically:** it eats a screen-space emissive buffer + an occluder/distance field. We already produce the first (illum/coloration/emissive) and can derive the second from walls + the `scene.attr` coverage + the darkness field. It's almost purpose-built for our pipeline, and §16.4 already earmarked it.
- **Honest risk (why 🟡 not 🟢):** it's 2024-era, so fewer battle-tested open ports than B1; it has known artifacts (ringing/banding, light leaking through thin occluders) that take care to tame; and it's a real chunk of work (multiple cascade RTs, careful merging). It is **not** tier 0 and never will be — it's a top-rung, capable-hardware feature. But it _is_ real-time and it _is_ proven. This is the "fun but mature-enough" sweet spot you asked for.

**Explicitly EXCLUDED by your real-time bar (so you know I filtered):**

- **Baked radiosity / lightmaps — 🟢 but not real-time-dynamic.** Gorgeous bounce, but it bakes; dynamic torches/spells can't move. A _hybrid_ (bake static sun/room bounce, add dynamic direct on top) is a mature middle ground if a scene is mostly static — worth one experiment, but it's not "real-time bounced light," it's "precomputed bounce + real-time direct."
- **Per-pixel path tracing (many bounces) — 🔴.** Won't hit real-time at quality in-browser; radiance cascades is the pragmatic substitute that gets ~90% of the look for a fraction of the cost. Build only as a reference "ground truth" to compare RC against, never as the shipping path.

> Recommendation for this track: **ship B0 early** (cheap, universal, sells the idea), **prototype B2 directly** (it's the banked direction and the payoff is huge), and keep **B1 in your pocket** as the derisking fallback if B2's artifacts prove stubborn. All three are the same `illum` term at different tiers.

---

## C. Projected & patterned light — 🟢 mature, huge charm-per-watt

The cheapest "wow" in the whole doc. A light samples a texture in _its own_ space and multiplies it into its contribution. Trivial shader, enormous atmosphere, deeply VTT-appropriate.

| Idea                          | Risk | Cost  | What it looks like                                                                                                                                                                                     |
| ----------------------------- | ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Gobo / cookie projection**  | 🟢   | C4    | A light projects a pattern: window mullions, prison bars, a cathedral rose window in full colour, a magic sigil. The classic Maya light-cookie, and it instantly explains a light's _source_.          |
| **Animated caustics**         | 🟢   | C2+C1 | Scrolling caustic noise where `_Water` says water — dancing light on a submerged floor or a cavern ceiling. (Shares the caustic node Water.md already ladders.)                                        |
| **Dappled foliage / canopy**  | 🟢   | C4    | A `_Tree`-driven breakup pattern so sunlight through leaves flickers on the ground. Ties to the existing canopy/tree-dapple grade modifier (B2 doc §1.3) — now as _real_ projected light, not a grade. |
| **Stained-glass colour cast** | 🟢   | C4    | A window light carries an RGBA gobo → coloured shafts land on the floor. Marries C (gobo) with D (shafts) for one of the most atmospheric shots a VTT can produce.                                     |

---

## D. Volumetrics & atmosphere (faked in 2D, reads great) — mostly 🟡

True volumetrics need a third axis; in top-down these are 2D fakes that nonetheless read convincingly because the viewer never sees the "side."

| Idea                             | Risk | Cost  | What it looks like                                                                                                                                                                                                                                              |
| -------------------------------- | ---- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Light shafts / god rays**      | 🟡   | C6    | Screen-space radial blur from bright sources, occluded by walls/coverage → light spilling through a doorway or window as a soft fan. Mature post-effect; `Forward+.md` §16.4 already lists it off skyReach+sun. Reads as "dusty air," fits dungeons/cathedrals. |
| **Dust / motes in the beam**     | 🟡   | C2+C7 | Particles lit by the light field, brightest where a beam passes — the floating specks in a sunbeam. Compute-particles (WebGPU) make this cheap.                                                                                                                 |
| **Fog that glows near light**    | 🟡   | C3    | A haze layer brightened by `scene.illum` → torches get a soft halo in mist, distant lights bloom through fog. Cheap (reads the buffer we have).                                                                                                                 |
| **Height-fog gradient by floor** | 🟡   | C3    | Use `scene.attr` floorId to tint/thicken atmosphere per level — lower floors mistier. Cheap, sells multi-floor depth.                                                                                                                                           |

---

## E. Material exotica — 🟡/🔴, save for when the basics sing

Fun, but lower priority and higher risk; several are "spike it and see."

| Idea                                    | Risk | Cost | Note                                                                                                                                                                                                                      |
| --------------------------------------- | ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chromatic dispersion through prisms** | 🟡   | C5   | `_Prism` splits a light into a spectrum — a rainbow thrown across the floor. The `_Prism` mask already exists. Dependent-read cost.                                                                                       |
| **Refraction through glass/water**      | 🟡   | C5   | Offset the background sample by a normal — heat-haze, warped view through a potion. Water.md ladders this for water; generalizes to any `_Normal` region.                                                                 |
| **Planar reflection**                   | 🔴   | C6   | In _top-down_, "reflection" has no natural up-axis — a still pool reflecting the ceiling is odd without authored intent. Only works as an artist-authored `_Reflect` gobo, not a real SSR. Low priority, flag as odd-fit. |
| **Spectral / polarised light**          | 🔴   | —    | Overkill for a VTT. Not recommended; listed so it's explicitly parked.                                                                                                                                                    |

---

## F. The honest "probably not worth it in 2D" pile

So you can see the filter, not just the picks:

- **Geometric SSAO / HBAO** — no depth complexity to occlude. Fake it from `_Normal` curvature (§A) instead.
- **Screen-space reflections of the scene** — nothing 3D to reflect; see E-planar-reflection.
- **Volumetric shadow _rays_ through geometry** — no geometry; the god-ray fake (§D) is the substitute.
- **Subsurface scattering of real meshes** — no meshes; a per-material `_SSS` wrap-lighting fake is possible but low ROI.
- **Coupling anything fancy to "has WebGPU"** — banned by tier Law 5; power comes from the governor's _measurements_, not the backend.

---

## G. If you build three things (the recommendation)

1. **Normal-mapped relief + GGX specular (§A)** — 🟢, mostly a port into `surface.response`, and it's the biggest per-effort jump in "it looks lit." Start here.
2. **Gobo / stained-glass projection (§C)** — 🟢, a weekend's work for outsized atmosphere, and it makes lights feel _sourced_.
3. **Bounced light, laddered (§B)** — ship **B0 colour-bleed** cheaply now for everyone, and **prototype B2 radiance cascades** as the marquee capability. This is your flagged interest, it's the banked GI direction, and it's genuinely real-time.

Everything else is a rung to add once these three sing. And the discipline from [[keyhole-two-light-types-decision]] holds throughout: **all of this is opt-in Type-B flair** — a GM's plain Foundry light still renders as faithful parity (Type-A) unless someone deliberately reaches for the fun.

---

*2D took away the third axis and handed us a painted G-buffer and a screen-space emissive field in exchange. That trade is *good* for exactly the things you want: authored-normal relief, projected light, and real-time bounced GI. The catalogue is long; the tier ladder means we never have to choose all at once.*
