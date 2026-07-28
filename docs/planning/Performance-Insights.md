# Performance Insights — the working target list

**What this document is:** the measured, ranked list of where MSA's frame time actually goes, and
what to do about each item. Written to be _acted on_ — every entry says what was measured, how
confident we are, and what the fix would be.

**What it is NOT:** a design doc or a changelog. `docs/planning/Performance.md` describes the
instrument and its bug ledger; this describes what the instrument FOUND. If an entry here has no
measurement behind it, it is labelled **HYPOTHESIS** and says what would settle it.

**Standing rule for this document (author, 2026-07-28):**

> _"We fix performance, we don't just hide performance problems."_

Disabling an effect is not a fix and does not close an entry here. Making it cheap does.

---

## 0. How to reproduce every number below

**🏁 Benchmark: N→S map sweep (60s)** — debug panel, Lab zone.

The route is **generated from the scene's own dimensions**, not recorded: a full-width framing
dragged from the north edge to the south edge at a steady rate over 60 seconds. It needs no setup,
it is identical on every run, on every scene and on every machine, and it is deliberately the
worst case — every frame pages in new virtual-texture content with every effect live.

Read these three, in this order:

| Field                                       | Question it answers                                                  |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `frame.fps.avgFps` / `worstFps` / `bestFps` | what the sweep felt like                                             |
| `frame.fps.p1LowFps` / `p5LowFps`           | the bad moments, without one freak frame defining the run            |
| `frame.hangs`                               | where it stalled, in seconds-into-the-sweep, so it can be reproduced |

⚠️ `avgFps` is **frames ÷ elapsed time**, not the mean of per-frame fps. Those differ, and only the
first is the rate a person experienced.

**Before trusting a comparison:** run the benchmark twice with no code change. Back-to-back runs of
the same scene have moved frame GPU by ~7% (23.13 → 21.63 ms) and individual light zones by ~30%.
Any "win" smaller than that is noise.

---

## 1. Baseline (2026-07-27, 600-frame window, coverage 0.962)

**7.32 Mpx (3840×1906 @ DPR 1.5). 24.9 ms/frame = 40 fps. GPU 21.63 ms, CPU encode 3.32 ms.**

Hard GPU-bound — the CPU is not close to being the limit, and there were zero hitches. VRAM is
88 MB against a measured ~2500 MB device-loss wall: **ruled out as a concern.**

| Zone                       |    GPU ms | % of frame GPU |
| -------------------------- | --------: | -------------: |
| **`geometry.worldDraw`**   | **13.29** |      **61.4%** |
| **`surface.specularDraw`** |  **3.33** |      **15.4%** |
| `light.drawColoration`     |      1.41 |           6.5% |
| `light.drawPointLights`    |      1.18 |           5.4% |
| `present.blit`             |      0.64 |           3.0% |
| bloom (all six zones)      |      0.46 |           2.1% |
| `light.drawComposite`      |      0.28 |           1.3% |
| illum fill + window light  |      0.22 |           1.0% |
| _unattributed_             |      0.82 |           3.8% |

**Two zones are 77% of the frame.** Everything else combined is under 15%. Bloom — the effect
everyone assumes is expensive — is **2%**.

---

## 2. FIRST 60-SECOND SWEEP (moving camera, 2026-07-28, route `n_to_s:2kf/60000ms`)

**The first run after fixing the benchmark route (Performance.md bug #12/#13) — a real, verified
north-to-south traverse: 2,268 frames, 59.30s elapsed (target 60s), coverage 0.967.** This is the
number to treat as the real-world reference from here on; the static baseline above understates it.

### The headline: it moved, and it moved cleanly

|                        |                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| **avgFps**             | 38.2 (median 40)                                                                                        |
| **bestFps / worstFps** | 61 / 20                                                                                                 |
| **p1Low / p5Low**      | 29.9 / 29.9 — identical, meaning the worst ~5% of frames sit on a flat ~33.4ms plateau, not a long tail |
| **frame time**         | best 16.4ms · median 25ms · p95 33.4ms · p99 33.5ms · worst 50ms                                        |
| **histogram**          | 30–60fps 84.7% · 20–30fps 10.8% · 60–120fps 4.5% · 10–20fps 1 frame                                     |

**Hangs — the author's specific ask, answered directly: ZERO across all four bands (stutter, hitch,
stall, freeze), for the entire 60-second continuous sweep.** Every frame paged in new virtual-texture
content the whole way, and nothing stalled. This scene's residency/decode path is not producing
visible hitches under continuous panning — a real, positive finding, not an absence of testing.

⚠️ One instrument-precision note, not a renderer defect: the single worst frame measured **exactly**
50.0ms, and the "hitch" band's threshold is `> 50ms` (strict), so it did not increment that counter.
`frame.fps.worstFps` and `frame.gapMs.max` both still show it honestly — nothing is hidden — but a
boundary this exact is worth knowing about if the hitch band ever needs a `>=`.

Two mild bumps interrupt an otherwise dead-flat 33.3–33.5ms cadence, located from `frame.shape`
(60 buckets × 988ms ≈ the whole route): **~26s in** (50ms, the run's worst) and **~33s in** (41.7ms).
Both in the middle third of the sweep. Not severe enough to be a "hang" by any band, but worth
watching if they recur at the same map location on a re-run — that would suggest a specific region
rather than a random GC/driver blip.

### Confirms and sharpens the static baseline

| Zone                       | Static (600f, still) | Sweep (2268f, moving) |                                                Change |
| -------------------------- | -------------------: | --------------------: | ----------------------------------------------------: |
| **`geometry.worldDraw`**   |     13.29 ms (61.4%) |  **17.97 ms (68.6%)** |                      **+35%, and its SHARE grew too** |
| **`surface.specularDraw`** |      3.33 ms (15.4%) |       2.96 ms (11.3%) | −11%, but still **5.05× declared budget** (was 5.69×) |
| `light.drawColoration`     |              1.41 ms |               1.47 ms |            ratio to `drawPointLights` holds at ~1.18× |
| `light.drawPointLights`    |              1.18 ms |               1.25 ms |                                              (steady) |
| `present.blit`             |              0.64 ms |               0.67 ms |                                              (steady) |
| bloom (all six)            |       0.46 ms (2.1%) |        0.48 ms (1.8%) |                                 (steady, still cheap) |
| **Frame GPU total**        |             21.63 ms |          **26.21 ms** |                                              **+21%** |

**Two findings this run adds, not just confirms:**

1. **Real motion costs meaningfully more than sitting still — +21% frame GPU.** The static baseline
   was measuring a best case. Every fix's expected win in sections 3–5 below should be validated
   against the SWEEP number, not the static one, or a fix will look better on paper than it feels in
   play.
2. **`geometry.worldDraw` doesn't just stay dominant under motion, it gets MORE dominant** — 61.4% →
   68.6% of frame GPU, a +35% absolute jump against the frame's own +21%. Whatever it's paying for
   scales worse than pixel count alone when the view is actually moving across the map — consistent
   with a fill-rate/overdraw cause (different regions of the map may carry different overdraw
   density) but this alone does not prove it; the two-resolution test in §4 is still the deciding
   measurement.

Specular's 5.05×/5.69× budget overrun across two independent sessions with different absolute
numbers is exactly the kind of repeatability that turns a suspicion into a fact worth fixing.

### A genuine instrument puzzle, not a renderer fact

**`gpuTimer.unattributedPasses` was 750 in the 600-frame static run AND 750 in this 2,268-frame sweep
— identical, despite ~3.8× more frames.** If this scaled with frames it would be ~2,850 here. It
didn't move at all. That is strong evidence this is a **fixed, one-time cost** (something during
startup/settle, not a per-frame recurring one) rather than "a small unbracketed render happening
every frame." Worth a dedicated look — see §7.

---

## 3. TARGET 1 — `surface.specularDraw`, 3.33 ms static / 2.96 ms sweep

**Status: CAUSE IDENTIFIED by code reading. Confidence HIGH. Not yet fixed.**

### Evidence

- **3.33 ms measured by the zone timer, 3.9 ms measured independently by the effect sweep,
  `agreement: 'agree'`.** The only effect large enough for the sweep to resolve, and the two
  methods concur — this number is solid.
- **0.455 ms/Mpx — 5.69× its own highest declared tier** (`cost.estMsPerMp: 0.08`, classes up to
  C3). The manifest's estimate has never been checked against reality until now.
- **Reproduced in a second, independent session (§2): 2.96 ms, 0.404 ms/Mpx, 5.05× budget.** The
  absolute number moved with scene motion; the "~5× over its own declared budget" verdict did not.
  That consistency is what makes this a fact, not a fluke of one run.
- Two draw calls, four triangles: **one fullscreen quad**. So the entire cost is fragment work.

### Cause

`specular-render.js` evaluates, **per pixel, unconditionally**:

- `mx_worley_noise_float(basePos, 1)` where `basePos` is a **`vec3`** — a 3D Worley is a
  **3×3×3 = 27-cell** neighbourhood search, each cell a hash plus a distance.
- `mx_noise_float(basePos)` — 3D Perlin, 8 corners.
- `shimmerLayer()` × `SPECULAR_LAYER_COUNT` (**3**), each an `anisotropicBlob`.

Then `presence` (derived from the `_Specular` mask) is multiplied in **at the end**.

**There is no `If()`, no `discard`, and no early-out anywhere in the shader.** So all of the above
runs on all 7.32 million pixels, and on the large majority of the map — everywhere there is no metal
— the entire result is multiplied by zero. We are paying full price for work that is thrown away.

### Fixes, cheapest-first

1. **Early-out on `presence`.** Wrap the noise in a TSL `If(presence.greaterThan(0), …)`. GPUs
   execute both sides of a divergent branch, so this only pays off when whole tiles agree — which is
   exactly the case here, since painted metal is sparse and spatially clustered. **Expected: most of
   the 3.33 ms on a typical map.** Cheapest change, biggest win, no visual difference whatsoever.
2. **Drop the Worley from 3D to 2D.** The third coordinate is only `tSec * 0.02` — slow time. A 2D
   Worley is 9 cells against 27. Animate instead by offsetting the 2D coordinate over time.
   **Expected: ~3× cheaper on the dominant term.** Needs an eye on the result: 2D+offset drifts
   rather than evolving, which may or may not read the same.
3. **Render the pass at half resolution and upsample.** The module's own header says the tuned look
   is _"HUGE SOFT SHAPES drifting over the metal, not micro-glitter"_ — a deliberately low-frequency
   effect does not need 7.32 Mpx. **Expected: ~4×.** Highest risk to the look; try after 1 and 2.

⚠️ Do 1 first and **re-measure before doing 2 or 3** — if the early-out lands the expected win, the
other two may be unnecessary, and each carries visual risk that 1 does not.

---

## 4. TARGET 2 — `geometry.worldDraw`, 13.29 ms static / **17.97 ms under motion (68.6% of frame GPU)**

**Status: MEASURED, cause NOT yet established, PRIORITY RAISED by §2. Confidence in the number
HIGH, in any cause LOW.**

### What we know

- 44 draw calls (static) / ~39 (sweep, varies with what's on screen), ~204,400 triangles,
  **1.82 ms/Mpx static, ~2.45 ms/Mpx under motion.**
- It is ONE `renderer.render(scene, camera)` call — one timestamped pass — so **per-pass timestamps
  cannot split it further.** Any breakdown needs a different technique.
- The triangle count is fully explained: vegetation tiles tessellate for wind
  (`VEGETATION_MAX_SEGMENTS = 128` ⇒ 32,768 triangles per overlay ⇒ ~6 overlays at the cap).
- **Under the 60s sweep this zone's share of the frame GREW (61.4% → 68.6%)**, a bigger jump than
  the frame's own +21% — see §2. It is not just the dominant cost sitting still, it dominates more
  as you actually play.

### What we have RULED OUT

**The vegetation effect is not the cost.** Its sweep reading fell inside the noise floor, bounding
it under 1.1 ms.

⚠️ **Read that precisely.** It bounds vegetation's _sway_ — the wind displacement — **not** the cost
of drawing those tiles. Vegetation tiles are map artwork; they draw inside `geometry.world` whether
the effect is on or off. So this rules out the _vertex/uniform_ work and vindicates
`vegetation-render.js:175`'s claim that 204k triangles is "trivial for a vertex stage". It says
nothing about their fill cost.

### The one measurement that would settle it

**Profile at two clearly different window sizes and compare `geometry.worldDraw`'s ms/Mpx**
(the report records `megapixels`; no code needed):

- **ms/Mpx roughly constant** ⇒ fill-rate bound. Then the cause is overdraw across layers or a heavy
  per-fragment VT shader, and the fixes are real: reduce overlapping full-coverage layers, or cut
  work in the tile fragment shader.
- **absolute ms roughly constant** ⇒ NOT pixel-bound, and the cause is per-draw or per-vertex
  instead. Different fixes entirely.

Until that runs, any specific fix here is guesswork. **Do not start optimising this zone before
taking that measurement** — now 68.6% of the frame under real play, too much to attack blind.

---

## 5. TARGET 3 — point lights, ~2.7 ms combined (~10.4% under motion)

**Status: a specific anomaly identified. Confidence MEDIUM, now backed by THREE independent
readings. Small but clean.**

`light.drawColoration` and `light.drawPointLights` render **identical geometry** — 17 draw calls,
550 triangles each — into different targets. Coloration is consistently more expensive:

| Run         | Coloration |  Points | Premium |
| ----------- | ---------: | ------: | ------: |
| static #1   |    2.01 ms | 1.71 ms |    +18% |
| static #2   |    1.41 ms | 1.18 ms |    +20% |
| sweep (60s) |    1.47 ms | 1.25 ms |    +18% |

Same meshes, same count, three separate sessions, the same ~18–20% premium every time. Worth one
look at the difference in blend mode, target format, or whichever early-out the illumination path
has and the coloration path does not.

Both are fill-bound rather than geometry-bound: 550 triangles is nothing, but each light mesh covers
a large screen area and overlapping lights multiply that.

---

## 6. The meta-lever — 7.32 Mpx at DPR 1.5

Every GPU number above scales with pixel count. DPR 1.5 → 1.0 is ~55% fewer pixels: static
**21.6 ms → ~9.6 ms** (roughly 40 → 85 fps); under real motion (§2) the starting point is **26.2 ms**,
so the same 55% cut lands closer to **~11.8 ms, roughly 38 → ~85 fps** — with no code change at all.

**This was a deliberate decision, not an oversight** — `vt-pan-viewer.js:1103`, _"MSA mushes the
artwork's pen outlines"_. Recorded here because it is by far the largest single lever available and
should be a conscious ongoing choice, not because it should be reversed.

A middle path exists and is worth considering once targets 1–3 are done: **render effects at reduced
resolution while keeping the map layer at full resolution.** The map is where the pen-outline
crispness lives; the shimmer, bloom and light falloff are all low-frequency. That is an architecture
change, not a setting.

---

## 7. Known gaps in the instrument itself

Carried here so they are not mistaken for facts about the renderer:

- **`geometry.worldDraw` cannot be sub-zoned** — one `render()` call, one timestamp. Splitting it
  needs either per-object passes or a different measurement technique.
- **The sweep cannot resolve anything under ~1.1 ms** on this machine (self-measured from its own
  negative readings). It diffs two whole-frame medians. Use the zone timer for anything smaller.
- **~750 render passes per run are unattributed, and — new in §2 — this count did NOT scale with
  frame count** (750 at 600 frames, still 750 at 2,268 frames). That rules out "a small unbracketed
  render every frame" and points at a fixed, one-time source instead — most likely something in the
  30-frame settle window or the arm sequence (shader compile, first residency pass) running one or a
  few genuinely un-bracketed render calls. Supporting evidence: `residualGpuMs` shrank as a
  FRACTION on the longer run (3.8% static → 3.3% sweep), consistent with a fixed cost being
  amortised over more frames. Worth a direct look rather than continuing to assume it is benign.
- **Bake costs are still unmeasured.** `sunShadows` and `water` bakes did not fire during either
  static window OR the full 60s sweep; the zones timed the per-frame _check_, not a bake. To measure
  one, change the sun angle or repaint the mask **while profiling**.
- **The hitch band's `>50ms` threshold is strict**, and a frame measuring exactly 50.0ms (§2) did not
  count toward it — visible regardless in `frame.fps.worstFps`/`frame.gapMs.max`, so nothing is
  hidden, but a `>=` may be worth considering if a borderline frame like this should register.
- `masks.occlusionDraw` and `light.drawRegions` report exactly 0.000 ms with 0 draw calls — genuinely
  empty passes, not measurement failures.

---

## 8. Ledger

| Date       | Change                                                                   | Measured effect                                                               |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 2026-07-27 | baseline established (600 frames, static, coverage 0.962)                | 21.63 ms GPU / 40 fps @ 7.32 Mpx                                              |
| 2026-07-28 | benchmark route fixed (Performance.md #12/#13); first real 60s N→S sweep | 26.21 ms GPU / 38.2 fps avg, 20 fps worst, ZERO hangs @ 7.32 Mpx, 2268 frames |

_Add a row per landed change, with a before/after from the benchmark route. A change with no
measurement is not a performance fix — it is a hope._
