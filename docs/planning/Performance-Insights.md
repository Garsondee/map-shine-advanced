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

## 2B. ✅ FIX ROUND 1 — MEASURED (2026-07-28, same route, author-verified visuals)

**Two presence gates shipped. Same benchmark route (`n_to_s:2kf/60000ms`), same 7.32 Mpx, same
scene. 3,227 frames / 59.50s, coverage 0.980. Author confirmed on a live scene: "Metal and
vegetation still work as they did before."**

### The headline

|                         | §2 sweep (before) | This sweep (after) |             Change |
| ----------------------- | ----------------: | -----------------: | -----------------: |
| **Frame GPU**           |          26.21 ms |       **17.83 ms** | **−8.38 (−32.0%)** |
| **avgFps**              |              38.2 |           **54.2** |           **+42%** |
| **median fps**          |                40 |           **59.9** |               +50% |
| **worstFps**            |                20 |             **30** |               +50% |
| **p1Low / p5Low**       |              29.9 |           **39.8** |               +33% |
| **bestFps**             |                61 |          **126.6** |              +108% |
| **worst single frame**  |             50 ms |        **33.3 ms** |               −33% |
| **hangs (all 4 bands)** |                 0 |              **0** |         still zero |
| frames in 59.5s         |             2,268 |          **3,227** |             +42.3% |

Frame count rose **+42.3%** while `avgFps` rose **+41.9%** over the same ~59.5s window — two
independently-computed numbers agreeing to within 0.4%, which is the run's own internal consistency
check.

### The two targeted zones, and nothing else, moved

| Zone                       |   Before |         After |              Change |
| -------------------------- | -------: | ------------: | ------------------: |
| **`geometry.worldDraw`**   | 17.97 ms | **12.135 ms** | **−5.835 (−32.5%)** |
| **`surface.specularDraw`** |  2.96 ms |  **0.675 ms** | **−2.285 (−77.2%)** |
| `light.drawColoration`     |  1.47 ms |      1.534 ms |               +4% ᴺ |
| `light.drawPointLights`    |  1.25 ms |      1.355 ms |               +8% ᴺ |
| `present.blit`             |  0.67 ms |       0.71 ms |               +6% ᴺ |
| bloom (all six)            |  0.48 ms |      0.492 ms |               +2% ᴺ |

ᴺ = inside this document's own stated noise band (§0: back-to-back runs move zones by up to ~30%).
Nothing untargeted moved outside noise, in either direction.

**The instrument's own self-test passes.** The two targeted zones gave up **8.12 ms** between them;
the whole frame fell by **8.38 ms**. The targeted savings account for **96.9%** of the total — the
frame did not get faster for some other reason, and no cost silently relocated to a neighbouring
zone.

### Specular is now inside its own declared budget — for the first time

| Metric               |         Before |        After |
| -------------------- | -------------: | -----------: |
| `measuredMsPerMp`    |          0.404 |    **0.092** |
| vs declared max 0.08 |      **5.05×** |    **1.15×** |
| verdict              | massively over | **`within`** |

Two sessions had independently measured this effect at ~5× its manifest declaration. **The
declaration was right all along; the implementation was wrong.** That is the manifest-vs-measurement
loop (§1's original reason for existing) closing properly for the first time.

### 🔴 THE MOST ACTIONABLE NEW FINDING: we are sitting exactly on a vsync step

Frame gaps quantise to **~8.33 ms** — this is a **120 Hz display**, and every frame lands on a
multiple of the refresh interval. Both runs show the same ladder:

| Intervals | Frame time | fps | Before (§2) | After       |
| --------- | ---------: | --: | ----------- | ----------- |
| 1         |     8.3 ms | 120 | never       | best 7.9 ms |
| 2         |    16.7 ms |  60 | best only   | **median**  |
| 3         |    25.0 ms |  40 | **median**  | p90         |
| 4         |    33.3 ms |  30 | p95         | worst       |
| 6         |    50.0 ms |  20 | worst       | gone        |

**The median frame moved up one whole vsync step, 40 → 60 fps.** That is the entire felt difference,
and it is why +32% GPU bought +42% fps: crossing a step is worth more than the raw ms suggests.

**And we are now straddling the next one.** Measured on every frame (not a subsample): gap
`p50 = 16.7 ms` but `p90 = 25.0 ms` — roughly half the frames make the 60 fps deadline and half miss
it and fall to the next interval. Frame GPU `p50` is **17.83 ms** against a **16.67 ms** deadline.

⚠️ Stated honestly: the GPU figure is from a **735-frame subsample** (23% — only frames whose async
timestamp resolve landed) while the gap distribution is every frame, so treat "~1.2 ms over" as
approximate. The _qualitative_ conclusion needs no subsample: the gap distribution alone shows the
run split across the 2- and 3-interval buckets.

⇒ **The next ~1–2 ms of GPU is worth far more than the previous 8.** It converts a large mass of
40 fps frames into 60 fps frames. Any target below is worth ranking by "does it get us under
16.67 ms", not by raw ms saved.

---

## 2C. 🔬 THE EFFECT SWEEP WAS PRESENTING NOISE AS A RANKING (2026-07-29) — INSTRUMENT FIXED

**Two live sweeps, two different scenes, pasted by the author. Between them they contain ONE
resolvable measurement and twenty-one unresolvable ones — and the tool printed all twenty-two to
0.1 ms with a share-of-stack percentage beside each.** Fixed in `src/diag/perf-lab.js`; 6,059 tests
green.

### What the two reports actually said

| Reading                                            | Scene A               | Scene B                    |
| -------------------------------------------------- | --------------------- | -------------------------- |
| baseline GPU                                       | 11.9 ms               | 10.8 ms                    |
| all-effects GPU                                    | 18.4 ms               | 13.6 ms                    |
| **effects reading NEGATIVE cost**                  | 4 of 11               | **7 of 11** (−1.3…−1.8 ms) |
| solo configs reading _cheaper than the all-off_ run | 4                     | **9**                      |
| `feltP50`, every single config                     | 8.4 ms                | 8.3–8.4 ms                 |
| `impliedOtherMs` ("Foundry / other")               | **−10.0 ms**          | **−5.2 ms**                |
| GPU samples per config                             | 20–21                 | 20–22                      |

### Three defects, each now fixed

**1. The baseline — the shared divisor on all eleven answers — was measured ONCE, FIRST.**
That is the worst possible slot for it: the opening config is the only one that pays cold-pipeline
costs (forced-toggle shader rebuilds, first residency pass, a cold thermal state), and whatever bias
it carries is subtracted from **every** effect. Scene B is that shape exactly — nine of eleven solo
configs read *lower* than the all-off baseline, seven clustered at −1.3…−1.8 ms. Random noise
scatters both ways; a seven-strong one-sided cluster is a systematic offset.

⇒ **The same all-off config is now re-measured at the END of the sweep.** The pair averages (the
one-sided bias cancels instead of landing on all eleven effects), and — the part that matters more —
their **difference is a measured noise floor**, `noiseFloorMs`. Two runs of a by-construction
identical config can differ only by noise, so that gap is the smallest cost the run is entitled to
claim. Derived from the run's own evidence, not a guessed threshold.

**2. Nothing knew what the tool could resolve.** `perf-report.js` already had a floor estimator
(`estimateSweepNoiseFloor`, "the worst negative reading is a lower bound on the noise") — but the
perf-lab panel and its JSON never used it, and the estimator has a hole: it can only see noise that
happened to land negative on an effect that happened to be cheap. Apply it to these two reports and
the result is stark:

| Scene | Floor from its own worst negative | What survives                                |
| ----- | --------------------------------: | -------------------------------------------- |
| A     |                            0.6 ms | candle flames (6.9 ms), fluid (1.0 ms)       |
| B     |                        **1.8 ms** | **nothing — not even candles' own 1.0 ms**   |

The floor differs 3× between two runs minutes apart, which is itself the argument for measuring it
directly rather than inferring it from whichever effect got unlucky.

⇒ Costs now carry `resolved`; a share-of-stack that would be **a percentage of noise** is
suppressed (Scene B printed `−64.3% of effects`); unresolved rows are dimmed in the panel but keep
their raw number, so nothing is hidden — only the false precision goes. `resolved: null` means no
floor was measured, which reads as **unverified, not healthy**. The report's estimator now takes the
larger of the derived and the measured floor, so the two authorities cannot disagree.

**3. `impliedOtherMs` subtracted two clocks that do not commute.** `feltP50` is read
**unthrottled** (frames pipeline freely); `gpuMs` is read **throttled** to one frame in flight. Once
MSA's GPU frame exceeds the felt gap, that gap is no longer presentation — the queue is absorbing
the overrun while the rAF cadence keeps ticking at the display's rate — so `felt − gpu` is negative
**by construction**.

🔴 **This is the same signature this file's own header records as the tell of the original
queue-depth bug** (`-33.50 ms Foundry/other`, 2026-07-20). It came back at −10.0 and −5.2 and
nothing flagged it, because `formatOther` only excused the band −2…0.

⇒ Now returns `null` + `feltUnderstated`, and the panel states the useful conclusion outright
instead: _"Felt P50 8.4 ms is SHORTER than MSA's own GPU frame (18.4 ms), so it is not presentation
time — frames are pipelining. Real throughput is nearer 18.4 ms/frame (~54 fps)."_

⚠️ **The consequence for `feltP50` generally: it is the rAF/display cadence, not the presented frame
rate, and it reads 8.3–8.4 ms in twenty-six consecutive configs across two scenes because that is
the 120 Hz refresh interval.** It is saturated and carries no signal in a GPU-bound regime — which
is the only regime this project has ever measured. Do not quote it as fps. The benchmark route
(§2/§2B) is unaffected: it reads the same gap distribution under real motion, where the numbers do
move.

**Also raised: `gpuSampleTarget` 20 → 40.** The median's error falls as ~1/√n, so this buys ~1.4×
tighter costs for ~1 s more per config. `noiseFloorMs` is now the signal for whether even that is
enough — if the floor comes back larger than the effect being chased, raise it rather than squint.

---

## 3. TARGET 1 — `surface.specularDraw` — ✅ **FIXED** (2.96 → 0.675 ms)

**Status: FIXED and MEASURED (2026-07-28). 4.4× cheaper, visually unchanged (author-confirmed).
Kept in full below because the reasoning that got here was wrong twice and the corrections are the
valuable part.**

### The fix that landed

`presence` (from the `_Specular` mask) was computed cheaply and multiplied in at the **end**, after
the 27-cell 3D Worley, the 3D Perlin and three shimmer layers had already been paid for on every
covered pixel. It now gates them.

**The part that was NOT obvious, and would have silently failed:** wrapping the existing graph in
`Fn()` + `If()` is not enough. The shimmer terms had to be **constructed inside the `If` callback** —
leaving the `.toVar()` terms outside and merely wrapping the assignment hoists the maths straight
back out of the branch. It would have compiled, rendered identically, measured identically, and
looked exactly like a fix. The gated and debug paths share one `buildShimmerTerms()` builder so the
two cannot drift (`feedback_mode_forks_silently_drop_features`).

### ⚠️ CONSEQUENCE: the per-island quad plan is now OBSOLETE — do not build it

This was the shelf-ready ~1.45 ms win. **The gate superseded it, and beat it.**

| Approach                    |    Predicted / measured | What it skips                                                            |
| --------------------------- | ----------------------: | ------------------------------------------------------------------------ |
| Per-island quads (designed) |         ~1.45 ms (est.) | pixels outside every island's bbox                                       |
| **Presence gate (shipped)** | **2.285 ms (measured)** | **every zero-presence pixel, including those _inside_ an island's bbox** |

The gate is strictly the larger set — it delivered **1.6× more than per-island quads were predicted
to**, for one `If()` instead of ~34 materials and a bounds-threading rewrite. What remains for
per-island quads is only the rasterisation and the (already cheap) presence lookup on skipped
pixels, bounded above by the pass's whole remaining 0.675 ms against a measured fixed floor of
~0.31 ms. **Best case ~0.2 ms, for N materials. Not worth it. This lever is closed.**

### The original analysis, kept

**Status when written: CAUSE IDENTIFIED by code reading. Confidence HIGH. Not yet fixed.**

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

### ⚠️ CORRECTION (2026-07-28 audit) — an earlier version of this section was WRONG

This section previously claimed the shader "runs on all 7.32 million pixels" and proposed a TSL
`If()` early-out as the fix. **Both were wrong, and reading the code rather than trusting the note is
what found it.**

1. **An AABB crop already exists.** `specular-surface-subsystem.js#cropGeometry` rewrites the quad to
   the mask's painted bounding box every time the mask loads, and that module's header already cites
   _"Effects.md Law 6: cost scales with COVERED pixels"_. The pass does NOT draw fullscreen.
2. **A TSL `If()` cannot be bolted on here anyway.** `specularMaterial.colorNode` is a **flat node
   graph** — `colorNode = vec4(shine, 1)`, with no `Fn()` anywhere in the builder. Per this
   project's own recorded trap (`keyhole-region-discard-noop-bug`), `If()`/`discard()` outside
   `Fn()` is a **silent no-op** — it would have compiled, changed nothing, measured nothing, and
   looked like a fix. Using control flow here means wrapping a ~500-line node graph in `Fn()` first.

**So the real question is not "does it early-out" but "is the AABB tight?"** — and that depends
entirely on how clustered the paint is:

- A brass door alone → AABB is small, the crop works, and the per-pixel shader is the only remaining
  cost.
- A brass door in one corner + a coin pile in the opposite corner → **the AABB covers most of the
  map** while actual metal is a few percent. Every pixel in between pays the full 27-cell Worley to
  be multiplied by a `presence` of zero.

Those two cases produce the **same measured cost** and need **opposite fixes**. Guessing between them
is exactly what this instrument exists to prevent.

### FIXED THIS AUDIT: the measurement that decides it

`getStatus().coverage` reports, computed from numbers both producers already return (zero per-frame
cost, derived only when the report is read):

| Field                              | Meaning                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `paintedFraction`                  | metal texels ÷ mask grid — how much metal there really is                         |
| `aabbFractionOfItem`               | what the CURRENT single cropped quad actually shades                              |
| `cropWasteRatio`                   | `aabbFractionOfItem ÷ paintedFraction` — the crude "is any of this wasted" signal |
| `estimatedPerIslandFractionOfItem` | what N separate per-island quads WOULD shade instead (bake-time estimate)         |
| `estimatedIslandWinRatio`          | `aabbFractionOfItem ÷` that — **the real, computed upper bound on the win**       |

### MEASURED (2026-07-28, live, `wizards-lair-laboratory`, floor 0)

`paintedFraction 0.1946` · `aabbFractionOfItem 0.6358` · `cropWasteRatio 3.3` · 35 islands, 1
dropped-small. **This scene's metal is unusually dense** (a lab full of apparatus, not one door —
~19% of the mask grid is metal, far more than "a few percent" this section originally assumed).

⚠️ **`cropWasteRatio` sat BELOW the "~4" threshold this section originally proposed — and that
threshold was a guess, made with zero real data, at the same time this section was wrong about the
crop existing at all.** Rather than eyeball a round number against a real one, the instrument was
extended to compute the actual achievable win instead of guessing at a cutoff.

**`estimatedPerIslandFractionOfItem 0.2848`, `estimatedIslandWinRatio 2.2` — THE REAL MEASURED WIN.**
Per-island quads would shade 28.5% of the item instead of the current 63.6%, a genuine 2.2× reduction
in covered pixels. Naive proportional scaling gives 2.96 ms → ~1.35 ms (~1.6 ms saved) — **but §4's
two-resolution test measured this pass's actual fixed/variable split** (fixed ≈ 0.31 ms, variable ≈
0.44 ms/Mpx): only the VARIABLE part shrinks with covered pixels, so the real number is **2.96 ms →
~1.51 ms, saving ~1.45 ms, ≈ 5.5% of the current 26.21 ms sweep frame.** Real, worth taking — and
clearly secondary to §4 (68.6% of the frame, completely unaddressed) in priority order.

Computed from a second bake-time pass already added (`specular-islands.js`, JS-only, zero render-time
cost): the sum of each surviving island's OWN true-paint bounding box, using the exact same "true
painted texels" criterion the combined AABB already uses (not the clustered or dilated footprints the
same bake also produces — verified by two hand-checked test fixtures, including a worst-case
scattered coin pile where the estimate correctly reports the CLUSTER's bbox rather than the smaller
true-paint count, so it cannot overstate the win for scattered small objects).

### Opportunities, with the ones NOT taken and why

1. **Per-island quads — MEASURED at ~1.45 ms / ~5.5% of frame, real but secondary to §4.** The islands
   module already computes connected components (`labelComponents`), so the labels needed to emit one
   quad per metal object instead of one quad over their combined bbox already exist, and
   `estimatedIslandWinRatio` (above, 2.2×) is the actual expected win, not a guess. **Zero visual
   change** (outside an island `presence` is 0, and the pass is additive, so an undrawn pixel and a
   drawn-but-zero pixel are identical).
   - **The engineering approach, corrected 2026-07-28.** `maskUv` is derived from the mesh's LOCAL
     `uv()` remapped through ONE uniform (`uMaskUvBounds`, `specular-render.js:314`) — an earlier
     version of this note claimed N quads would need to "share one draw call" via a vertex attribute,
     stated as fact without checking the alternative. **This codebase already has the proven, lower-
     risk pattern**: `point-light-pool.js` gives every light its own dedicated material + mesh ("each
     light gets its OWN geometry"). For ~34 islands, N small materials — zero shader changes, only JS-
     side orchestration — is almost certainly the right model, not a shared-material rewrite. Verify
     against the real per-light pattern before building either way.
   - ⚠️ NOT TAKEN YET: the pack returns per-island BOUNDS _estimates_ for the report (bake-grid
     resolution) but not the precise bounds themselves wired to render (would need re-deriving from
     the full-resolution mask, same as the current single AABB, plus the existing edge padding). On a
     file under active rework — worth doing, but sequence against §4 (68.6% of frame, ~11× bigger,
     CONFIRMED not just suspected) rather than treating this as the priority.
2. **3D → 2D Worley** — the third coordinate is only `tSec * 0.02`, so a 2D Worley (9 cells vs 27) on
   a slowly-offset coordinate would be **~3× cheaper on the single dominant term**. ⚠️ NOT TAKEN:
   this **changes the animation's character** — 3D Worley makes cells evolve and morph in place, 2D +
   scroll makes the pattern slide. That is a visual trade, and the standing rule here is not to make
   those silently.
3. **Half-resolution pass + upsample** — the module's own header calls the tuned look _"HUGE SOFT
   SHAPES drifting over the metal, not micro-glitter"_, and a deliberately low-frequency effect does
   not need full resolution. **Expected ~4×.** ⚠️ NOT TAKEN: highest visual risk of the three.
4. **Hoisting `sunGrainBias` to the CPU** — it is provably uniform-only (`L.uGrain`, `uSunDir`,
   `SUN_BIAS_MIN` are all uniforms; only the final `mix` with `outdoors` is per-pixel), so ~15 ALU
   ops × 3 layers are recomputed per pixel for a value that never varies. ⚠️ **DELIBERATELY NOT
   TAKEN.** It would couple two independent setters (grain angle and sun direction) that must BOTH
   recompute or the effect silently desyncs — a brand-new silent precondition
   (`feedback_count_silent_preconditions`) traded for an uncertain win, since GPU scalar units
   generally hoist uniform arithmetic already. Not worth it.

---

## 4. TARGET 2 — `geometry.worldDraw` — ⚠️ **PARTLY FIXED** (17.97 → 12.135 ms). STILL THE WHALE.

**Status: −32.5% shipped and measured. Still 68.1% of frame GPU — its SHARE barely moved
(68.6% → 68.1%), because it was so dominant that a third off it barely dents its ranking.**

### The fix that landed: a coarse-mip foliage-presence gate

`buildVegetationMaterial`'s fragment stage ran `curlNoise2D` (4 noise evals) **plus a full wind-field
sample** on every pixel of a full-screen layer, then folded the result into a UV offset that does
nothing where there is no foliage. One extra fetch at **mip 6** now gates the whole block.

**Lossless by construction, not by eyeball:** flutter displaces the UV by at most
`VEG_FLUTTER_UV_CAP` (0.005). At mip 6 one texel spans 64 base texels — on a 3375 px tile that is
~0.019 UV, **~4× the cap** — and the fetch is bilinear so it straddles two. A fragment the gate skips
has no foliage within several times the furthest flutter could reach.

### ❌ WHAT'S LEFT — the VEGETATION SHADOW was the prime suspect, and it is **REFUTED**

**Status: HYPOTHESIS RAISED AND KILLED, same day, by the measurement it demanded. Measured cost
0.644 ms raw / ~1.24 ms noise-normalised — not the ~4 ms that would have justified building the gate.
Everything below the fold is kept because the traced facts are still true and the refutation is the
valuable part.** Jump to "THE VERDICT" for what it cost and what it means.

After the gate, the non-shadow vegetation path is down to roughly the trivial whole-image material —
one texture fetch, a tint, three alpha multiplies — plus the gate's own coarse fetch. That cannot be
12 ms. **But the gate deliberately skipped the `asShadow` branch, and that branch is the expensive
one.** Traced 2026-07-28:

| Fact                                                                                            | Where                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **15 texture fetches per fragment**, unrolled, no early-out, no discard                         | `vt-pan-viewer.js:6210-6235`                                  |
| Draws in the **same `renderer.render()`** the zone brackets — charged here                      | `vegetation-shadow-subsystem.js:252`, `vt-pan-viewer.js:6947` |
| **One mesh covering the WHOLE background**, never split into per-plant pieces                   | `vt-pan-viewer.js:6764-6767, 6935-6947`                       |
| Quad is **padded 274 px per side** for trees ⇒ ~1.29× the background's fill area                | `vegetation-shadow-subsystem.js:186`                          |
| **One shadow mesh per (item × kind)** — a background with both `_Tree` and `_Bush` gets **two** | `vt-pan-viewer.js:6884`                                       |
| `depthTest:false`, `depthWrite:false`, `frustumCulled:false` — nothing rejects it               | `vt-pan-viewer.js:5946-5949`                                  |
| On by default: `shadowStrength` default **0.45**, no separate enable flag                       | `effects/vegetation.js:364-373`                               |
| **`shadowStrength = 0` does NOT stop the draw** — full quad, all 15 fetches, alpha 0            | `vegetation-shadow-subsystem.js:302`                          |

Two padded full-screen quads at 15 fetches each ≈ **38 screen-blits of texture fetch per frame**.
That is the right order of magnitude for the remaining 12 ms.

⚠️ **That last sentence was the error, and it is instructive.** Counting _fetches_ is not counting
_cost_ — 11 of those 15 taps read mip 3–5 (the ladder fix's own LOD), where the whole working set is
a few hundred KB and every tap is a cache hit. The measurement below priced them at roughly a
**twentieth** of what this estimate assumed. A fetch is not a unit of time.

**Supporting evidence from the existing measurements:** §4's isolate test kept 204,316 of 204,376
triangles while dropping 30 draw calls — i.e. the "one item = 97%" result **included the vegetation
canopy and shadow overlays**, not just the background quad. And 204,366 ÷ 32,768 ≈ **6.2 tessellated
full-quad overlays at the 128-segment cap**, consistent with `_Tree` + `_Bush` canopies _and_ their
shadows all being live.

### ⚠️ The counter-evidence, and why it is void

§4 previously recorded "the vegetation effect's sweep reading fell inside the noise floor, bounding
it under 1.1 ms" — which would contradict the above, since `vegState.enabled` **does** gate shadow
mesh visibility. **That bound cannot be trusted.** The visibility assignments live in a residency
pass (`vt-pan-viewer.js:6738`, `:7131`), and a residency pass only re-runs on pan/zoom — the exact
bug class this project already has a name for (`feedback_residency_sync_vs_render_loop`). During a
**static** sweep the meshes never change visibility, so the sweep measured the uniform sync and
nothing else. It bounds vegetation's _sway_, as already stated, and says nothing about the draws.

### ⚠️ The naive gate does NOT transfer here — the arithmetic says so

The obvious move is to reuse the mip gate. **It is not safe at the radius the shadow needs**, and the
reason is worth writing down before someone tries it:

- Flutter reaches ≤ 20 art texels, so a **mip-6** gate (64-texel footprint) covers it with margin.
- A **tree shadow** throws up to 175 px + penumbra ⇒ the gate must cover **~274 texels**, i.e. mip 8.
- A blob of K×K opaque texels reads back as `K²/4ᴸᴼᴰ` from the coarse mip. To survive 8-bit
  quantisation (≥ ~0.002) at mip 8 needs **K ≥ ~11 texels**. Below that the gate reads exactly zero
  and **silently drops that plant's shadow entirely.**
- Worse: throw is a per-KIND constant (`shadowHeightPx`), not per-blob — so a 6 px speck painted
  `_Tree` casts a **175 px** streak the gate would delete.

A workable version exists (per-kind LOD; 1 tap at mip 6 covers a bush's whole 69-texel throw, ~2 taps
at mip 7 cover a tree's, with the eps derived from a **stated** minimum caster size rather than
guessed) — but it is a real design with a real regression mode, and it should not be built on an
unmeasured hypothesis. **Measure first.**

⇒ **MOOT. The measurement came back at ~1 ms, so this design is not worth its regression mode and
will not be built.** Kept only so the next person can see the arithmetic rather than re-derive it.

### ✅ THE VERDICT — MEASURED 2026-07-28, hypothesis REFUTED

The threshold was set in advance, in this document, before the run: _"above ~4 ms the per-kind gate is
clearly worth its regression risk; near ~1 ms it is not, and the remaining 12 ms is somewhere else
entirely and this section is wrong."_ **It came back near 1 ms. This section is wrong.**

`shadowStrength === 0` now removes the mesh from the draw instead of drawing a fully transparent one,
which turned the author's existing slider into the instrument. Same route, same 7.32 Mpx:

|                      | Shadows 0.45 | Shadows 0 |                      Change |
| -------------------- | -----------: | --------: | --------------------------: |
| `geometry.worldDraw` |    12.135 ms | 11.491 ms |       **−0.644 ms (−5.3%)** |
| draw calls           |         39.1 |      36.2 |                        −2.9 |
| **triangles**        |      204,366 |   131,827 | **−72,539 (−2.2 overlays)** |
| Frame GPU p50        |     17.83 ms |  17.83 ms |               **no change** |

**The change unambiguously worked** — draw calls and triangles fell by exactly what the code
predicted (72,539 ÷ 32,768 = 2.21 tessellated full-quad overlays at the 128-segment cap). This is not
a case of "the toggle did nothing"; the meshes definitively stopped drawing, and removing them saved
0.644 ms.

⚠️ **Two honesty notes on the number:**

1. **−5.3% is at this document's own noise floor** (§0: ~7% frame GPU between identical runs). Taken
   alone it would not be conclusive. It is trusted here because the triangle and draw-call deltas
   confirm the mechanism independently, which no amount of thermal noise can fake.
2. **This run ran ~5% hotter across the board.** Every zone that could not possibly have changed rose
   together: specular +5.5%, `present.blit` +5.5%, `drawPointLights` +5.7%, `drawComposite` +4.8%,
   `drawColoration` +3.0%. Normalising `geometry.worldDraw` by that median (+4.9%) puts the true
   saving nearer **1.24 ms**. Both figures are given; neither reaches 4 ms.

**⚠️ A CONFOUND AT FRAME LEVEL, declared rather than buried.** Frame GPU did not move at all
(17.83 → 17.83 ms), and the reason is a scene-side change, not the code: **`light.drawRegions` went
from 0.000 ms / 0 draw calls to 0.515 ms / 2 draw calls** — a darkness region became active between
runs (`light.regionSetup` CPU rose 3.2× too, 0.015 → 0.048 ms, corroborating it). That new 0.515 ms
plus the ~5% thermal drift consumed the shadow saving exactly. Nothing in this change touches
darkness regions. **The zone-level result stands; the frame-level "no change" is the confound's
doing, and the two must not be read as one number.**

### What this refutation actually bought

**A session not spent building the per-kind gate** — and a correction to the model that produced the
wrong estimate. The error was counting texture _fetches_ as if they were units of time. 11 of the
shadow's 15 taps read mip 3–5, where the working set is small enough to stay in cache; they turn out
to cost roughly a **twentieth** of a mip-0 tap.

⇒ **The remaining ~11.5 ms is therefore NOT in the number of layers or the number of fetches.** If a
full-screen 15-fetch overlay costs ~0.3 ms, then the four remaining tessellated canopy overlays
(131,827 ÷ 32,768 = 4.02) — which do 2–3 fetches each — cannot be more than a few tenths between
them. The cost has to be in the small number of taps that read **mip 0 of the 6750² BC7 atlas at
arbitrary zoom**, where cache locality is poor, plus the per-fragment `buf:scene.attr` MRT write
every layer pays. **That is branch (b) from this section's own original table — flagged at the start,
never tested, and now the only branch left standing.**

**Should the zero-strength skip be kept? Yes.** It is correct on its own merits and free when shadows
are off. But it must not be logged as a default-config win: at the default `shadowStrength` of 0.45
it changes nothing at all.

**How it was built** (both traps in this document avoided by construction):

- The verdict reads the shadow handle's **effective** strength, not `params.shadowStrength`, so
  anything the handle zeroes (night, a future per-caster cutoff) stops costing fill for free.
- Residency keeps owning "on screen AND effect enabled" (stored as `residentVisible`); the
  **per-frame** sync ANDs in "has strength to draw with". Putting the whole decision on the residency
  path would have made the slider look dead until the user pans — the same trap that voided the sweep
  bound above.
- The uniforms are still synced on the frames the verdict says "no", so raising the slider restores a
  correct shadow on the very next frame rather than a stale one.

Locked by 13 assertions in `src/effects/__tests__/vegetation-shadow-subsystem.test.mjs`, including
the one that matters: a handle returning strength 0 must beat a raw param of 1.

### The original analysis, kept

**Status when written: MEASURED and CAUSE CONFIRMED (2026-07-28, two-resolution test). This is the
single largest, best-understood lever in the whole audit, and it is still unfixed.**

### ✅ CONFIRMED: 93% fill-rate, 7% fixed overhead, at native resolution

Two live profiles at deliberately different window sizes, same scene/content (triangle counts
204,376 vs 204,368 — confirms an apples-to-apples comparison, not less map in view):

| Run   | Resolution     | Megapixels | `geometry.worldDraw` |
| ----- | -------------- | ---------: | -------------------: |
| Large | 3298×1906 @1.5 |       6.29 |            11.962 ms |
| Small | 1669×1285 @1.5 |       2.14 |             4.622 ms |

Fitting `cost = fixed + variable × megapixels` from these two points lands almost exactly on both:
**fixed ≈ 0.84 ms, variable ≈ 1.77 ms/Mpx.** At native 6.29 Mpx that is **93% fill-rate cost, 7%
fixed overhead** — not a rough correlation, a clean linear fit. **This zone is FILL-BOUND, confirmed.**

⚠️ **Fill-bound is not the same as overdraw** — see "WHAT IS CONFIRMED vs WHAT IS STILL INFERRED"
below before acting on the overdraw reading.

**Specular cross-checked the same way, same runs**: 3.084 ms @ 6.29 Mpx / 1.253 ms @ 2.14 Mpx → fixed
≈ 0.31 ms, variable ≈ 0.44 ms/Mpx — also fill-dominated, which **revises §3's per-island estimate
down slightly**: accounting for this fixed floor, the real expected saving is **~1.45 ms** (not the
naive ~1.6 ms that ignored it) — same conclusion, still secondary to this target.

### 🔴 THE FINDING: it is not the shader, it is OVERDRAW

The world tile material (`vt-pan-viewer.js`, the whole-image `NodeMaterial`) is **trivially cheap**:

```js
material.colorNode = Fn(() => {
  const c = texture(tex, uv().mul(uUvScale)).toVar();
  c.rgb.mulAssign(uTint);
  c.a.mulAssign(uAlpha);
  c.a.mulAssign(occlusionAlphaFactor(occ));
  return c;
})();
```

One texture fetch and three multiplies. At ~40 draw calls that cannot account for 18 ms — **unless
each pixel is shaded many times over.** And it is, by construction:

```js
material.transparent = true;
material.depthTest = false; // ← nothing is ever rejected
material.depthWrite = false; // ← nothing ever occludes anything
```

**Every world quad is alpha-blended with depth testing and depth writes both disabled.** There is no
early-Z, no occlusion culling, and no way for a layer to reject fragments that a later layer will
completely paint over. Backgrounds, foregrounds, tiles, vegetation and water tier-0 all draw in
painter's order, and **every one of them shades every pixel it covers, whether or not it survives to
the final image.** Total fragment work is `screen area × number of overlapping layers`, and each of
those fragments also writes the `scene.attr` MRT.

That is a textbook fill-rate/overdraw profile, and it independently explains §2's other observation:
**the zone's share GREW under motion (61.4% → 68.6%)**, because panning across the map changes how
many layers overlap the visible region — a shader-bound cost would have scaled flat with pixels.

### Why this is NOT simply "turn depth testing on"

Recorded so the obvious fix is not attempted blind:

- Alpha-blended content **must** draw back-to-front; depth rejection only helps genuinely opaque
  layers, and `uAlpha` + occlusion mean few layers here are reliably opaque.
- Flipping `transparent` changes three.js's render list and sort order, which would collide with
  Foundry's layering law (`reference_foundry_v14_layering_law` — one flat sort law, occlusion as one
  RGBA mask). Getting that wrong reorders the map's artwork.
- A depth pre-pass for the opaque subset is the real technique, but it interacts with the MRT
  attr-writing contract and needs its own design pass.

**The measurement that confirms it** is still §4's two-resolution test — under this hypothesis
`ms/Mpx` stays roughly constant while absolute ms scales with pixel count.

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

### ✅✅ RESOLVED (2026-07-28) — NOT overdraw. ONE ITEM, and its FRAGMENT SHADER.

The `Isolate draw item` test ran. **It killed the depth-pre-pass plan outright**, which is exactly
what it was for:

|                      |  Baseline | Background only |                Change |
| -------------------- | --------: | --------------: | --------------------: |
| Draw calls           |        44 |              14 |        **−30 (−68%)** |
| Triangles            |   204,376 |         204,316 |          −60 (−0.03%) |
| `geometry.worldDraw` | 13.617 ms |       13.226 ms | **−0.391 ms (−2.9%)** |

**Removing 68% of the draw calls saved 2.9% of the cost.** The 30 removed items carried 60 triangles
between them (~0.013 ms each — noise). **One item is 97% of this zone**, and it retains essentially
every triangle in the scene.

⇒ **Branch (a), overdraw, is RULED OUT. A depth pre-pass would buy ≈ nothing.** Branch (b) confirmed:
one full-screen item at **~1.81 ms/Mpx**, roughly 12–35× what a plain textured blit costs.

### 🔴 THE CAUSE: a full-screen layer running per-fragment noise + a wind sample

204k triangles in that one item means it is **tessellated**, which only happens for vegetation — so
the map background carries painted `_Tree`/`_Bush` and draws through `buildVegetationMaterial`
(`vt-pan-viewer.js`, `colorNode` at ~:6006), not the trivial whole-image material. Its **fragment**
stage runs, per pixel:

- **`curlNoise2D(...)`** — the leaf-flutter UV shuffle. Its own comment: _"ONE octave — the stated
  fragment-cost ceiling (**4 noise evals**)"_.
- **`windHandle.node(...)`** — a full wind-field sample, per fragment, for `localSpeed`.
- plus `length()`, `clamp`, `smoothstep`, gale damping and a scene-edge fade.

~4 noise evaluations plus a wind-field sample per pixel, **on a layer covering the whole screen** —
and crucially **on every pixel of the item, including the overwhelming majority with no foliage on
them at all.** That is the same shape as §3's specular problem: expensive per-pixel work gated only
at the END, after it has already been paid for.

⚠️ **Consistent with the earlier sweep result, not contradicting it.** The sweep bounded the
vegetation EFFECT (its sway/motion) under 1.1 ms — that toggles wind response, it does not stop the
tiles drawing through this material. The fragment cost stays whether the effect is "on" or not.

### Fix directions (NOT yet designed — measure each, do not assume)

1. **Gate the flutter/wind fragment work on actual foliage presence.** The `_Tree`/`_Bush` mask is
   already sampled; if the per-fragment noise ran only where foliage exists, most of the screen would
   skip it. Same structural fix as §3's per-island idea, different effect. ⚠️ Needs the same care:
   check whether the material is a flat node graph (TSL `If()` is a silent no-op outside `Fn()`) —
   **this one IS inside `Fn()`**, so control flow is genuinely available here, unlike specular.
2. **Vertex-stage the wind sample.** `localSpeed` drives flutter amplitude; at 128-segment
   tessellation there is already a dense vertex grid, and a per-vertex wind sample interpolated to
   fragments may be visually indistinguishable at a fraction of the cost.
3. **Skip flutter for non-vegetation tiles entirely** — if a tile carries no painted foliage it
   should use the trivial whole-image material, not the vegetation one.

**None of these are measured yet.** The next step is to confirm which of the three fragment terms
dominates before changing any of them.

### ⚠️ SUPERSEDED — the reasoning that led here (kept, it was nearly a costly mistake)

The two-resolution test proves this zone is **FILL-RATE BOUND** (cost ∝ covered pixels, 93/7 split).
It does **NOT** prove _overdraw_ specifically. Corrected 2026-07-28, when the design work below was
about to start on the unproven half:

**Two different causes fit the measurement equally well, and they need OPPOSITE fixes:**

|         | Cause                                                                                                                                   | Fits fill-bound? | Fix                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| **(a)** | **Overdraw** — ~40 layered draws, `depthTest:false`, nothing rejected                                                                   | ✅ yes           | depth pre-pass / fewer full-coverage layers                                  |
| **(b)** | **One expensive layer** — 6750² BC7 sampled at arbitrary zoom (poor cache locality), plus per-fragment `scene.attr` MRT write bandwidth | ✅ **equally**   | mip bias, texture format, working-set reduction — _nothing to do with depth_ |

The `depthTest:false` + ~40-draw evidence makes (a) plausible, but that is **code reading, not
measurement**. Committing to a depth pre-pass — which is real architecture touching the Foundry
layering law and the MRT contract — on an unmeasured sub-hypothesis is exactly the mistake this
document exists to prevent.

### THE DECISIVE MEASUREMENT — zero code, tool already exists

**Lab → `Isolate draw item`** (a live select, `vt-isolate-item`). It hides every draw item except
one (`vt-pan-viewer.js#isolateItemId`).

1. 🔬 Profile (per-zone) with **All items (normal)** — baseline `geometry.worldDraw`.
2. 🔬 Profile again with **one item isolated** (pick the base map background).
3. Compare, **at the same window size** (the cost is pixel-proportional, so resolution must not vary):

- **Cost drops roughly in proportion to the number of layers removed** ⇒ **(a) overdraw confirmed.**
  Proceed to the depth-pre-pass design.
- **Cost stays high with one layer** ⇒ **(b) confirmed** — a single layer is doing nearly all the
  work, the depth pre-pass would buy almost nothing, and the real target is texture
  sampling/bandwidth for that one item.

Until that runs, the depth pre-pass is a fix for a cause that has not been isolated. **Do not start
it.**

### The design constraint already found (relevant to branch (a) only)

Researching the pre-pass surfaced a hard constraint worth recording now, because it makes (a)'s fix
substantially more involved than "enable depth testing":

**`buf:scene.attr` depends on NormalBlending semantics.** `scene-attr.js`'s whole safe-default
mechanism is that a fragment output of exact `vec4(0,0,0,0)` **leaves the attr attachment
untouched**, because the blend equation reads that attachment's own alpha as its source factor
(`dst*(1-0) + 0*0 = dst`). **Opaque rendering disables blending**, so the identical output would
WRITE ZEROS instead of skipping — silently clearing floor attributes for every non-writer material
moved into an opaque pass. Any opaque/transparent split has to handle the attr contract explicitly,
not inherit it.

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

Same meshes, same count, three separate sessions, the same ~18–20% premium every time.

### ✅ EXPLAINED (2026-07-28 audit) — CLOSE THIS TARGET, it is not a defect

`point-light-pool.js` builds two materials over one shared geometry, and the coloration one takes an
argument the illumination one does not:

```js
buildPointLightColorationMaterial({
  THREE,
  albedoTexture: sceneColor.texture,   // ← illumination has no equivalent
  ...
});
```

**The coloration pass does everything the illumination pass does, plus a full-resolution albedo
fetch per pixel.** One extra dependent texture read over the light's covered area accounts for a
consistent ~18–20% premium, and it is _necessary_ work — coloration tints by the art underneath it,
which is the entire point of the pass. Both are fill-bound rather than geometry-bound (550 triangles
is nothing; each light mesh covers a large screen area and overlapping lights multiply it).

**There is no waste here to remove.** The asymmetry that looked like a smell is the feature. Anyone
returning to this should spend their time on §3 or §4 instead — recorded precisely so the next person
does not re-derive it. The only lever would be reducing light **coverage/overlap**, which is a
scene-authoring question, not a code defect.

---

## 5B. 🕯️ TARGET 4 — CANDLE FLAMES — ✅ **CAUSE CONFIRMED. It is the LIGHTS, not the flames.**

**Status: MEASURED 2026-07-29, prediction upheld against the pre-registered threshold. The cost is
`light.drawPointLights` + `light.drawColoration`, and the fix shipped as the first real rung of the
performance-tier ladder (§5C), not as a hardcoded cheapening.**

### The verdict, against a threshold written down BEFORE the run

The threshold was: _"if `light.drawCandleFlame` accounts for more than 2 ms of the delta, the
per-fragment noise hoist is worth building and the derivation is wrong. If under 0.5 ms, the flame
shader is closed as a non-target."_

| Zone                                       |     GPU ms | Draw calls | % of frame GPU |
| ------------------------------------------ | ---------: | ---------: | -------------: |
| **`light.drawPointLights`**                | **6.571**  |     **91** |      **32.2%** |
| **`light.drawColoration`**                 | **6.541**  |     **91** |      **32.1%** |
| `geometry.worldDraw`                       |      4.201 |         12 |          20.6% |
| **`light.drawCandleFlame`** (every flame)  | **0.022**  |          2 |       **0.1%** |
| Frame GPU total                            |      20.38 |            |                |

**0.022 ms.** Twenty-three times under the "closed" threshold. Meanwhile the two light zones are
**13.1 ms of a 20.4 ms frame — 64%.** The effect sweep, run separately and by a different method,
put candles' marginal cost at **13.15 ms**: agreement to 0.3% with the two zones' sum.

⚠️ **The report calls that a "method disagreement" (zone sum 0.022 vs sweep 13.15) and it is not
one — both are right, and the gap between them is an ATTRIBUTION defect worth fixing.** The two
light zones carry `ownerEffectId: null`, so candle lights are billed to nobody; the zone timer is
measuring precisely what it brackets, and the sweep is measuring what disappears when candles are
turned off. **An effect whose cost lands inside a shared pool cannot be zoned by bracketing alone.**
Until that is fixed, `light.drawPointLights` should be read as "all lights, Foundry's and MSA's
together" and never as a per-effect number.

### Why the arithmetic beat the code-reading

The flame shader **looks** far more expensive than the light: nine `mx_noise_float` evaluations plus
a full wind-field sample per fragment, of which seven noises and the whole wind sample are per-candle
constants being recomputed per pixel. It is a genuine inefficiency. **It is also completely
irrelevant**, because a `sizePx` 24 billboard covers ~576 world px² and a `lightRadiusPx` 400
(×1.25 boost ⇒ r = 500) light covers ~785,000 — **≈1,363×, drawn twice.**

⇒ **This is §4's fetch-counting lesson a second time, and the area arithmetic caught it before a
session was spent on the wrong file.** Shader complexity per pixel is worthless without the pixel
count beside it. The per-fragment constant hoist stays recorded and unbuilt: bounded above by
0.022 ms.

### §5's closure was right about Foundry's lights and wrong about the scene

§5 closed the point-light zones as "explained, not a defect — the only lever would be reducing light
coverage/overlap, which is a scene-authoring question." That reasoning was reached on a scene with
**17** lights. This scene has **91 draw calls** through the same pool, and the extra ones are not
authored: **MSA generates a light per candle cluster**, at a code-default 400 px radius. Coverage is
a code lever after all, wherever MSA is the one creating the lights.

---

## 5C. ⚙️ THE PERFORMANCE TIERS ARE NOW REAL (2026-07-29)

**The author's directive, and the right frame for everything above:**

> _"The goal isn't to remove expensive parts of effects, it's to make them into optional parts of the
> effect enabled/disabled by selecting a performance profile… If I change my performance tier to low
> I'd expect the candle flame to simplify, the light to cluster and so on."_

### What was actually wrong: the ladders had no reader

`Effects.md` §2 has specified tier ladders as manifest data for a long time, and **fourteen effects
declared one. Nothing read them.** `PERFORMANCE_PROFILES`, `profileRank` and `enabledFromProfile`
existed and were wired — but only to decide **whether** an effect runs, never **how much** of it.
There was no `profile → rung` function anywhere in the codebase.

Unread declarations rot, and this one had: **candle flames declared a single rung, _"a simple
teardrop marker at each imported candle anchor — placement proof, not a finished flame"_, and listed
`animated-flicker` under `deferredRungs` as NOT BUILT** — while the shipped effect ran a nine-noise
chaotic life envelope with wind lean, gutter and snuff, and cast `lavish`-flicker point lights. The
manifest described an effect that had not existed for weeks (`feedback_unconsumed_api_rots_silently`).

### What shipped

| Piece                                                        | Where                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `resolveEffectTier(manifest, layers)` — profile → rung        | `effects/effect-cascade.js`, pure + total, beside its `enabled`/`params` siblings |
| `tier.fromProfile` — **required** on rungs 1..N, Node-checked | `effects/effect-manifest.js` (+ profile monotonicity, + forbidden on rung 0) |
| Resolved once, for EVERY effect, at the one door             | `effects/registry.js` → `resolved.perfTier` / `maxPerfTier` / `perfTierSource` |
| The three shipped multi-rung ladders migrated                | water, specular, fluid — `fromProfile` derived from each rung's own declared cost class |
| The candle ladder rewritten to match reality — 5 real rungs   | `effects/candle-flame.js`                                                   |
| `candleTierPlan(tier)` → flame quality · light quality · **cluster factor** | `effects/candle-flame-geometry.js`                            |

**Three rules, each taken from Effects.md rather than invented:** tier 0 is unconditional (§6 step 2
— the weakest machine still gets the effect, correctly placed); rungs are **cumulative**, so the
resolver takes the highest *contiguous* affordable rung and a mis-declared ladder degrades to a rung
that exists rather than compiling a combination nobody has drawn; an explicit pin beats the profile
(Law 5), which is also what §7's per-rung verification harness will need.

**Law 4 is honoured** — every one of these is a graph-BUILD-time JS value that changes which nodes
get constructed (or how many light meshes exist), never a uniform multiplied to zero.

### The candle ladder, and the 13 ms dial

| Rung | `fromProfile` | Class | Flame | Light | **Cluster ×** | What it adds                                          |
| ---- | ------------- | ----- | ----- | ----- | ------------: | ----------------------------------------------------- |
| 0 `ember`     | — (floor)   | C0    | calm  | plain |      **2.0**  | a flame at every candle, one merged pool per room     |
| 1 `flicker`   | low         | C1    | calm  | 2-oct |      **1.5**  | two-octave flicker + warm/cool temperature shift      |
| 2 `life`      | performance | C2    | life  | 2-oct |      **1.0**  | chaotic guttering, wind lean, snuff-out               |
| 3 `boil`      | standard    | C2    | warp  | lavish|      **0.5**  | boiling silhouette, breathing core, wavering edge     |
| 4 `perCandle` | extreme     | C8    | warp  | lavish|     **0.25**  | candles stop sharing a light                          |

`clusterFactor` multiplies the light radius to get the merge cell, and **cell AREA goes as the
factor squared** — so tier 0 covers **16×** tier 3's area and collapses a candle-lit room into one or
two pools instead of dozens of full-cost Foundry-parity meshes. That is the dial that moves 13 ms.

### 🔒 Turning this on changes nothing at the default — by test, not by hope

**Tier 3 reproduces today's shipped behaviour exactly** (flame quality 2, `lavish` light, cluster
0.5), and the default `standard` profile resolves to tier 3. A test asserts the fallback constant
`CANDLE_DEFAULT_TIER` **equals what the default profile actually resolves the real ladder to**, so
retuning a rung's `fromProfile` cannot leave the constant behind pointing at a different look — two
authorities on one number is its own bug class. Further tests pin that cluster factor and both
qualities are monotonic down the ladder (a better machine never merges more, or looks plainer).

`animationQuality` gained an `auto` default meaning "follow the profile"; any explicit value still
pins it and beats the profile (Law 5).

⚠️ **NOT YET MEASURED: how much tier 1 actually saves on the candle-heavy scene.** The prediction is
large — 91 light draw calls is the input, and cluster area scales quadratically — but this document's
own standing rule is that a change with no before/after is a hope, not a fix. **The measurement is
one profile run at `low` vs `standard`, and it belongs in the ledger before this entry is called
done.**

---

## 5D. Appendix — the sweep signal that started §5B, and the shader lever it did NOT justify

### The original sweep reading

| Scene | candle solo | baseline | **cost**    | share of the whole effect stack |
| ----- | ----------: | -------: | ----------: | ------------------------------: |
| A     |     18.8 ms |  11.9 ms | **+6.9 ms** |            **106.2%** (of 6.5)  |
| B     |     11.8 ms |  10.8 ms |     +1.0 ms |                           35.7% |

In Scene A, candles cost **more than every other effect combined** — `__all__` (18.4 ms) is within
0.4 ms of candles-alone (18.8 ms), so the other ten effects sum to approximately nothing. It is also
the only effect to move the felt tail: `feltP95` 41.7 ms, identical to `__all__`'s, against 16.7 ms
at baseline. Scene B's 1.0 ms is **inside that run's own noise floor** (§2C) and proves only that the
cost scales with candle count, not that it is 1.0 ms.

### Noted and deprioritised — the per-fragment constants in the flame shader

Real, and recorded so nobody rediscovers it as a theory: seven of the nine noise evaluations and the
whole wind-field sample in `buildCandleFlameMaterial` are per-candle constants computed per fragment,
and TSL `varying()` would move them to the vertex stage **losslessly** (a value constant across the
quad interpolates exactly). **Bounded above by the entire flame draw, MEASURED at 0.022 ms.** Do not
build it for performance. It becomes relevant only if `sizePx` is ever raised dramatically.

---

## 6. The meta-lever — 7.32 Mpx at DPR 1.5

Every GPU number above scales with pixel count. DPR 1.5 → 1.0 is ~55% fewer pixels: static
**21.6 ms → ~9.6 ms** (roughly 40 → 85 fps); under real motion (§2) the starting point is **26.2 ms**,
so the same 55% cut lands closer to **~11.8 ms, roughly 38 → ~85 fps** — with no code change at all.

⚠️ **Updated after §2B:** the motion starting point is now **17.83 ms**, so the same 55% cut lands at
**~8.0 ms**. More usefully — given §2B's vsync finding, DPR 1.5 → 1.0 would clear the 16.67 ms step
with room to spare and pin the median at 60 fps, and on a 120 Hz panel it would put the 8.33 ms step
(120 fps) genuinely in reach. This lever got _more_ attractive, not less, because the frame is now
close enough to a step boundary for it to change which step you land on.

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
- ~~**The sweep cannot resolve anything under ~1.1 ms**~~ — ✅ **NO LONGER A GAP, it is now a
  reported number.** The sweep re-runs its all-off baseline at the end and publishes the drift as
  `summary.noiseFloorMs`; per-effect costs carry `resolved`, and a share-of-stack is suppressed
  rather than printed as a percentage of noise (§2C). The floor is per-run, not a constant — two
  runs minutes apart measured 0.6 ms and 1.8 ms. Still diff-of-two-medians, so still use the zone
  timer for anything smaller than the floor it reports.
- 🔴 **`feltP50` is the rAF/display cadence, NOT the presented frame rate.** It read 8.3–8.4 ms in
  twenty-six consecutive sweep configs across two scenes — the 120 Hz refresh interval — while MSA's
  own GPU frame was 10.8–18.8 ms. When GPU work exceeds the frame gap the queue absorbs the overrun
  and rAF keeps ticking at the display's rate, so the metric saturates. **Never quote it as fps in a
  GPU-bound regime**, which is the only regime this project has measured. The sweep now detects this
  (`feltUnderstated`), says so, and suppresses the `felt − gpu` subtraction that it invalidates
  (§2C). The 60 s benchmark route is unaffected — under real motion those gaps do move (§2B's vsync
  ladder).
- 🔴 **NEW, and it invalidates past sweep readings: the effect sweep is BLIND to any effect whose
  meshes are shown/hidden in a residency pass.** A residency pass only re-runs on pan/zoom, so during
  a static sweep window the toggle flips the effect's `enabled` flag, the uniform sync notices, and
  **the meshes keep drawing regardless** — the sweep then reports only the sync cost and calls the
  effect cheap. Confirmed for vegetation (`vt-pan-viewer.js:6738`, `:7131`), which is exactly how
  "vegetation is under 1.1 ms" survived as a fact next to "vegetation is 68% of the frame" (§4).
  This is `feedback_residency_sync_vs_render_loop` wearing a new hat. **Any effect that owns meshes
  should have its sweep number re-checked against this before it is trusted**, and the sweep should
  arguably force a residency refresh on toggle rather than hoping the window contains a pan.
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

| Date       | Change                                                                                                                                                                                           | Measured effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-27 | baseline established (600 frames, static, coverage 0.962)                                                                                                                                        | 21.63 ms GPU / 40 fps @ 7.32 Mpx                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-07-28 | benchmark route fixed (Performance.md #12/#13); first real 60s N→S sweep                                                                                                                         | 26.21 ms GPU / 38.2 fps avg, 20 fps worst, ZERO hangs @ 7.32 Mpx, 2268 frames                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-07-28 | **code audit** of the three targets; specular `coverage` instrumentation added                                                                                                                   | no perf change yet — §4 cause identified (overdraw), §5 closed as explained, §3's stated cause corrected and its deciding measurement now instrumented                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-07-28 | first LIVE `coverage` read: `cropWasteRatio 3.3`; per-island estimate instrumentation added same day                                                                                             | real measurement replaced the guessed "~4" threshold                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-07-28 | re-measured with the estimate live: `estimatedIslandWinRatio 2.2`                                                                                                                                | per-island quads ≈ **1.45 ms saved, ~5.5% of frame** — real, but ~11× smaller than §4's still-unaddressed 68.6%; sequence accordingly                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-07-28 | **§4 two-resolution test run**: geometry.worldDraw fixed+variable fit                                                                                                                            | **CONFIRMED fill-bound: 93% / 7% fixed at native res.** ⚠️ Fill-bound ≠ overdraw — the `Isolate draw item` test is still needed to pick between the two opposite fixes                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-07-28 | **§4 `Isolate draw item` test run**: 44→14 draws saved only 2.9%                                                                                                                                 | **Overdraw RULED OUT — depth pre-pass abandoned before any code was written.** ONE item = 97% of the zone; cause is `buildVegetationMaterial`'s per-fragment curl-noise + wind sample on a full-screen layer                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-07-28 | **A zero-strength vegetation shadow no longer draws** (was: a fully transparent padded quad still paying 15 fetches/fragment). Verdict on effective strength, applied on the per-frame sync path | ✅ **MEASURED same day — and it REFUTED the hypothesis it was built to test.** `geometry.worldDraw` 12.135 → 11.491 ms (−0.644 raw, ~−1.24 noise-normalised), with −2.9 draws / −72,539 triangles confirming the mechanism independently. **Not the ~4 ms that would have justified the per-kind gate, so the gate will not be built.** Frame GPU unchanged (17.83 → 17.83) — a darkness region appeared between runs (`light.drawRegions` 0 → 0.515 ms) and ate the saving; declared as a confound, not a code effect. Keep the change (free when shadows are off), log NO default-config win |
| 2026-07-28 | **FIX SHIPPED — presence gates on BOTH `_Tree`/`_Bush` and `_Specular`** (vegetation coarse-mip foliage gate; specular presence gate with the maths moved inside `Fn()`)                         | ✅ **MEASURED, same route: 26.21 → 17.83 ms GPU (−32.0%), 38.2 → 54.2 avgFps (+42%), worst 20 → 30 fps, still ZERO hangs.** `geometry.worldDraw` −5.835 ms, `surface.specularDraw` −2.285 ms; the two targets are **96.9%** of the total frame saving. Author confirmed visuals unchanged. See §2B                                                                                                                                                                                                                                                                                             |

| 2026-07-29 | **Effect-sweep instrument fixed** (`perf-lab.js`): baseline re-measured at the END of the sweep → costs use the averaged pair, and the pair's drift is published as a real `noiseFloorMs`; per-effect `resolved` flag; share-of-stack suppressed when it would be a percentage of noise; `impliedOtherMs` no longer differences the unthrottled felt gap against the throttled GPU median (returns `null` + `feltUnderstated` + a stated pipelining conclusion); `gpuSampleTarget` 20 → 40; `perf-report.js`'s own floor estimator now takes the larger of derived and measured | ✅ **No renderer change — the two pasted live sweeps contained ONE resolvable measurement and twenty-one unresolvable ones, all printed to 0.1 ms with percentages.** Scene B: 7 of 11 effects negative, 9 of 11 cheaper than the all-off baseline, `Foundry / other −5.2 ms` (Scene A: −10.0 ms) — the same signature the file's own header records as the 2026-07-20 queue-depth bug, unflagged because the excuse band was only −2…0. 6,059 tests green. See §2C |
| 2026-07-29 | **Candle flames identified as the one resolvable target** (Scene A: +6.9 ms, 106.2% of the whole effect stack, the only effect to move `feltP95`: 41.7 ms vs 16.7 baseline)                                                                                                                                                                                                                                                                                                                                                                              | ⏳ **Cost CONFIRMED, cause DERIVED not measured.** Area arithmetic puts the point light at ~1,363× the flame billboard's covered pixels and drawn twice ⇒ the cost is predicted to be in `drawPointLights`/`drawColoration`, not `light.drawCandleFlame`. **Threshold pre-registered before the run** (§5B). Nothing built yet — deliberately                                                                                                                                                                             |

| 2026-07-29 | **Candle prediction TESTED against its pre-registered threshold** — zone profile, candle-heavy scene                                                                                                                                                                                                                        | ✅ **UPHELD, decisively.** `light.drawCandleFlame` = **0.022 ms** (threshold for "flame shader is a real target" was 2 ms; for "closed" was 0.5 ms). `light.drawPointLights` 6.571 + `light.drawColoration` 6.541 = **13.1 ms of a 20.4 ms frame, 64%, 91 draw calls**; the sweep independently put candles' marginal cost at **13.15 ms** — agreement to 0.3%. The flame shader is CLOSED as a target; §5's "not a defect" closure held only for a 17-light scene. See §5B |
| 2026-07-29 | **PERFORMANCE TIERS BUILT** — `resolveEffectTier` (profile → rung), `fromProfile` required + Node-validated per rung, resolved for every effect at the registry door, three shipped ladders migrated, candle ladder rewritten to 5 real rungs with clustering as its top dial                                                | ⏳ **BUILT + Node-tested (6,118 green), NOT yet live-measured.** Tier 3 reproduces today's look exactly and the default profile resolves to tier 3, pinned by a test tying the fallback constant to the ladder — **so the default is unchanged by construction.** The `low` ladder merges candle lights with a 16× larger cell. **The `low` vs `standard` profile run is the missing measurement and this entry is not done without it.** See §5C |

---

## 9. Audit summary (2026-07-28) — what changed in our understanding

**The frame is 32% cheaper and 42% smoother, measured on the same route, with the author confirming
the picture is unchanged (§2B).** All three original targets are now measured facts, not guesses —
two are closed and one is half-done.

| Target          | Before this audit                      | After                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3 specular     | "no early-out, runs fullscreen"        | ✅ **FIXED, 2.96 → 0.675 ms (4.4×).** Both original claims were wrong; the real fix was gating `presence` with the maths built _inside_ `Fn()`. Now `within` its declared budget (5.05× → 1.15×)                                                                                                                                                                                           |
| §4 world draw   | "cause unknown, do not optimise blind" | ⚠️ **PARTLY FIXED, 17.97 → 12.135 ms (−32.5%).** Overdraw RULED OUT; flutter gate shipped. Now 64.4% of the frame at 11.491 ms. Overdraw ruled out, flutter gate shipped, and the **vegetation-shadow hypothesis raised and REFUTED the same day (0.6–1.2 ms, not 4+)**. Only branch (b) survives: mip-0 fetches of the 6750² BC7 at arbitrary zoom, plus per-fragment MRT write bandwidth |
| §5 point lights | "~18–20% asymmetry, worth a look"      | **Closed — explained, not a defect.** Coloration samples the albedo texture; illumination does not                                                                                                                                                                                                                                                                                         |

**The single most valuable thing this round produced is not a millisecond, it is a target:** the
frame now straddles the 16.67 ms vsync step (§2B). The next 1–2 ms is worth more than the last 8.

**Three fixes were explicitly declined**, each recorded in §3 with its reason: the `sunGrainBias` CPU
hoist (introduces a silent desync precondition), 3D→2D Worley (changes the animation's character),
and the half-resolution pass (highest visual risk). **A fourth is now closed by obsolescence:
per-island quads, the designed ~1.45 ms win, were superseded and out-performed by the presence gate
(§3) — best remaining case ~0.2 ms for ~34 materials. Do not build it.**

**§4's vegetation-shadow hypothesis was raised and killed on the same day, by the measurement it
demanded — and that is the single most useful thing in this section.** It looked strong from code
reading (15 fetches/fragment, padded full-screen quads, ungated, drawing inside the measured zone),
and it was wrong: 0.6–1.2 ms, not the 4+ ms that would have justified the gate. The threshold was
written down **before** the run, so the verdict was not negotiable after it.

**The lesson is sharper than the result.** The estimate failed because it counted texture _fetches_
as units of time; 11 of the shadow's 15 taps read mip 3–5 and cost roughly a twentieth of a mip-0
tap. Which also collapses the follow-on theory before anyone builds it: if a 15-fetch full-screen
overlay is ~0.3 ms, the four remaining canopy overlays at 2–3 fetches each cannot be the missing
11.5 ms either. **Layer count and fetch count are both exonerated. What is left is mip-0 sampling of
the 6750² BC7 atlas at arbitrary zoom plus per-fragment MRT write bandwidth** — branch (b), flagged
in §4 from the start and still never directly tested.

Two near-misses belong in the declined list. **The depth pre-pass design was started and stopped**
on discovering the evidence supported only the fill-bound half. And `buf:scene.attr`'s safe default
was believed to depend on NormalBlending — ⚠️ **that belief is now itself in doubt**: a read of the
vendored three suggests the `attr` attachment is built with `blend: undefined` (no blending), which
would mean `vec4(0,0,0,0)` **overwrites** rather than skips. Untraced to a consumer, flagged for its
own investigation, and **not a performance question** — but it would change what an opaque pass
costs to get right.

**Method note worth keeping:** the specular section had been written from a plausible reading rather
than from the code, and stated the opposite of the truth in two places. Both were caught by opening
the file. A performance document is exactly as trustworthy as its least-verified claim
(`feedback_plausible_diagnosis_rots`).

_Add a row per landed change, with a before/after from the benchmark route. A change with no
measurement is not a performance fix — it is a hope._
