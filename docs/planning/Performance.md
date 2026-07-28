# Performance — the instrument that aims an optimisation

**ALL SIX PHASES BUILT, 2026-07-27. Node-verified and structurally clean. NOT live-verified.**

| Phase | What landed |
|---|---|
| 0 | `graph/v3-perf.js` + `graph/gpu-pass-timer.js` deleted; `graph/reachable-from-boot` **3 → 1**, `no-silent-catch` **29 → 27**; the false `trackTimestamp` diagnosis corrected in both places it was written |
| 1 | `diag/perf-zones.js` (46 zones), `diag/perf-report.js` (the brain), `diag/vram-inventory.js` |
| 2 | `runPassPlan(ids, impls, ctx, hooks)` — per-pass brackets that pair even under a throwing pass |
| 3 | `diag/frame-profiler.js`, wired as a viewer seam; **43 balanced brackets** across `renderFrame`, `light.accumulate`, `post.bloom`, geometry, surface, masks and present |
| 4 | `diag/gpu-zone-timer.js` — real per-render-pass GPU time via timestamp queries, attributed through the profiler's open-zone stack |
| 5 | `diag/perf-session.js` — the orchestrator, with the sweep consumed as an independent cross-check |
| 6 | `diag/perf-hud.js` (live rolling overlay) + the fixed camera-path benchmark route |

**Four debug-panel controls**, all in the Lab zone:

| Control | Does |
|---|---|
| 🔬 **Profile (per-zone)** *(primary)* | ~10s window, per-zone GPU+CPU, report to clipboard |
| 🔬 **Profile + effect sweep (slow)** | the above plus the on/off sweep, so each effect gets two independent measurements and the report says where they disagree |
| 🏁 **Benchmark run (fixed route)** | drives the scene's saved camera path so two runs are comparable; **fails loud** if no route is saved |
| 📊 **Live zone HUD (toggle)** | top-10 zones, rolling quarter-second window, 4 Hz |

Plus the **Performance profile** report, a pure readout of the last completed run.

**Test count: 5810 passing, 0 failing** (`npm run verify` green: lint + format + 28 structure rules
+ tests), of which ~480 are this instrument's own.

**Nothing here has been seen working by the author.** Every number shown below is an illustrative
shape, not a measurement. This codebase has a measured record of fully-green test suites meaning
nothing about whether a thing draws — and an instrument is worse than a feature in that respect,
because a broken instrument produces confident numbers instead of a blank screen.

### Deliberate simplification: no flight-recorder snapshot diff

The plan called for deriving the measurement window by diffing two flight-recorder snapshots. That
is not needed and was dropped: the viewer already keeps `frameGapTimes` with a `resetFrameStats()`,
which is the exact mechanism `runSweep` uses, so the window comes from the viewer's own ring
directly. This also leaves the recorder's session-wide histogram untouched, which was the reason
the diff was proposed in the first place. One fewer moving part, same data.

**Owns:** per-zone CPU/GPU attribution, the profile report, the live HUD, the benchmark run.
**Does not own:** the whole-frame GPU number (`diag/gpu-probe.js`), the effect on/off sweep
(`diag/perf-lab.js`), frame gaps and hitches (`vt-pan-viewer.js` + `diag/flight-recorder.js`).
Those already exist and are consumed here, not replaced.
**Prerequisite reading:** `feedback_instruments_must_not_lie`, `feedback_plausible_diagnosis_rots`,
`feedback_measure_the_output_not_the_equation`, `keyhole-diagnostic-tools`.

---

## The brief, verbatim (author, 2026-07-27)

> We now have a few effects working and the performance costs are starting to bite. We need a new
> tool for V3 and this is a critical bit of infrastructure so it deserves a lot of thought. We need
> to be able to understand the performance cost of every effect and even break down those effect
> performance costs where possible to target optimisations in the correct place. […] a powerful,
> well thought out performance tool with minimal performance cost when not active and maximum
> information in a report that is useful, concise, precise and which attempts to do things like
> provide a concise sampling of frame times without trying to export too much information. It needs
> to be good at providing the right amount of useful information.

---

## 0. The one sentence

> Three instruments already say **how much**; none says **where** — and the one that could say
> where has been sitting behind a constructor argument nobody passed.

---

## 1. What we had, measured

| Instrument | Measures | Blind to |
|---|---|---|
| `renderMsAvgLast120` (`vt-pan-viewer.js:7081`, `:7166`) | CPU command **encoding** of the pass plan | all GPU cost; everything outside the `t0` window |
| `diag/gpu-probe.js` | whole-frame GPU via `queue.onSubmittedWorkDone()` | which pass, which effect |
| `diag/perf-lab.js` sweep | per-effect **marginal** cost, off vs on | anything inside one effect |
| `frameGapTimes` / `hitchLog` (`:7041-7055`) | felt cadence, stalls > 50 ms | cause |

Every one is whole-frame or whole-effect. The single heaviest pass, `light.accumulate`
(`:3816-4029`), is **ten CPU syncs and seven draws** reported as one opaque block. An optimisation
aimed at it today is aimed by guesswork.

**Credit where it is due:** none of these instruments is wrong. `gpu-probe.js` in particular carries
a hard-won post-mortem about measuring queue depth instead of frame cost, and the throttle at
`renderFrame:7034` exists because that mistake was caught live. This is not a mess. It is a
resolution ceiling.

---

## 2. The finding that changed the design

`diag/gpu-probe.js` claimed three's `trackTimestamp` GPU timer "reported `supported:false`", and
`vt-pan-viewer.js:7013` repeated it. Both read as *the hardware cannot do timestamp queries*.

It can. The flag was never passed.

| What the vendored three actually does | Line |
|---|---|
| `this.trackTimestamp = parameters.trackTimestamp === true` — **constructor-only, defaults false** | `three.webgpu.js:64637` |
| `this.trackTimestamp = this.trackTimestamp && this.hasFeature(TimestampQuery)` — false stays false regardless of hardware | `:75258` |
| The device already requests **every** feature the adapter reports | `:75217-75228` |
| The viewer constructed its renderer without the flag | `vt-pan-viewer.js:1100` |

So a flag left at its default reported `false` on a GPU that supports timestamp queries perfectly
well, and that reading was written into a header as a hardware fact. It stood for one week
(2026-07-20 → 2026-07-27) and steered every session away from the best instrument available.

**Lesson:** `feedback_plausible_diagnosis_rots`. A negative capability result is only as good as the
line that produced it. Ask which line makes it true *before* writing it into a header, because a
header is where the next session stops looking.

Two consequences beyond the fix:
- Per-render-pass GPU timing is real, and works on **both** backends —
  `WebGLBackend.initTimestampQuery` (`:67928`) runs the same path through
  `EXT_disjoint_timer_query_webgl2`. That is what made `graph/gpu-pass-timer.js`, a hand-rolled
  WebGL2-only timer, deletable rather than harvestable.
- Granularity is per `renderer.render()` call, because three submits one command buffer per call
  (`Renderer._renderScene` → `backend.finishRender` → `queue.submit`, `:75866`). **Pass granularity
  is exactly the granularity we want** — it was never a compromise.

---

## 3. Four tiers, one report

| Tier | What | Cost when off | Real-time? |
|---|---|---|---|
| 0 Passive | frame gaps, hitches, fps histogram | already paid | yes |
| 1 CPU zones | ~30 named brackets, aggregate-only | one boolean read | yes |
| 2 GPU zones | per-render-pass GPU ms | one boolean *inside three* | yes |
| 3 Sweep | per-effect off/on marginal cost | nil | no, by design |

Tier 3 is kept **as an independent cross-check of Tier 2**, not as a legacy path. Two methods that
disagree about the same effect is information; the report prints both and classifies the
disagreement rather than picking a winner.

### Free when off, mechanically

```js
const renderer = new THREE.WebGPURenderer({ …, trackTimestamp: true });
await renderer.init();
const gpuTimingCapable = renderer.backend.trackTimestamp === true;  // survives the hasFeature() AND
renderer.backend.trackTimestamp = false;                            // dormant until armed
```

Disarmed, `initTimestampQuery` returns on its first line (`:76493`) and the query pool is never
allocated. Tier 1 is `if (!armed) return;` before any clock read, array write or allocation.
**No clock is read and no memory is touched until something arms it.**

### Three things deliberately NOT built

1. **No serialized `onSubmittedWorkDone()` per pass.** ~25 awaits/frame is 25 pipeline drains, each
   diff carrying a round-trip latency charged to whichever zone came next — the same "queue depth,
   not cost" trap already recorded at `renderFrame:7020-7033`. When timestamps are unavailable the
   honest degradation is `zones[].gpuMs: null` + `method.gpu: 'frame-only'`, and lean on the sweep.
2. **No third frame-gap ring.** Two exist (`vt-pan-viewer.js:7041`, `flight-recorder.js`). A third
   would be two instruments disagreeing about what a stall is. The missing piece — a compact shape
   series — is a *pure reducer over data already kept*.
3. **No hand-listed pass zones.** Pass zones derive from `framePlan.ids` at runtime. A second
   hand-kept copy of the frame order is exactly what `graph/passes.js` exists to prevent, and this
   repo has already paid for hand-kept lists going stale three times.

---

## 4. Zones

**Pass level — derived, never listed.** `runPassPlan`'s hooks yield `pass.<id>` per live pass; a
pass going live later is instrumented for free. Same "discovery, never a list" rule as the flight
exporter.

**Sub-zones — hand-declared in `diag/perf-zones.js`, each one a real call site.** ~52 measured,
~24 reported by default. Two clock reads is cheap: **measure generously, report selectively.**

The taxonomy carries `cadence: steady | conditional | bake | event` as a first-class field, because
a bake that ran 3 times in 612 frames must not report a median of 0:

```jsonc
{ "id": "light.sunShadowBake", "cadence": "bake",
  "gpuMs": { "mean": 4.80, "max": 5.4, "sampleCount": 3 },
  "occurrenceRate": 0.0049, "amortisedMsPerFrame": 0.029,
  "note": "Ran 3 times in 612 frames. Not a per-frame cost — but 5.4 ms is a real one-frame spike." }
```

Cost-per-occurrence × occurrence-rate is how you decide whether a 40 ms bake matters.

---

## 5. What makes the report precise rather than plausible

- **The residual is printed.** `frameGpuMs − Σ zoneGpuMs`, plus `coverage`. Below 0.85 the verdict
  flips to `indicative` and the note *says* to lean on the sweep column instead. A breakdown that
  cannot account for a third of the frame must not look confident.
- **`method` per effect** — `zone | sweep | both | unmeasured`. Vegetation and water tier-0 render
  inside a shared scene and **cannot** be zone-isolated; those rows say why rather than showing 0.
- **Measured ms/Mpx against the manifest's declared `cost.estMsPerMp`.**
  `effects/effect-manifest.js` has validated a declared cost model per tier since it was written and
  **it has never once been checked against reality.** A wrong declaration becomes a ranked finding.
- **Clock honesty.** Foundry sets no COOP/COEP, so the page is not cross-origin-isolated and
  `performance.now()` is clamped by every major browser. Therefore: measure the real step at arm
  time and publish it; accumulate sums across the window and divide, never store per-frame CPU
  deltas as the primary statistic; and any zone whose mean is under the measured step goes to
  `belowClockResolution` rather than printing noise. *Reporting a number the clock cannot resolve
  is the same lie as reporting 0 for "not measured".*
- **Frame times are sampled, never dumped** — percentiles + an 8-bucket fps histogram + **60
  numbers** of worst-per-bucket shape + every hitch (capped, with `dropped`). ~20 KB total.

---

## 6. Traps ledger

| Trap | Evidence | Consequence |
|---|---|---|
| `zones/one-door` exempts `diag/` as a **target**, not a **source** | ratchet 8 | `perf-zones.js` must import `PASSES`/`STAGES` from `graph/index.js` |
| `time/one-clock` ratcheted at 35 | `verify-structure.mjs:478` | no new `performance.now()` in `vt/` or `graph/`; `renderFrame` already receives `nowMs` from rAF |
| Timestamp pool is 2048 queries = 1024 passes ≈ **40 frames** | `:76495`, `:74938` | past that `allocateQueriesForContext` returns null, rendering continues, **measurement silently stops**. Resolve every frame; make overflow a stated finding |
| `getTimestamp(uid)` warns and returns **0** for a missing uid | `:67476` | a lying zero *and* console noise the flight recorder captures. Gate on `hasTimestampQuery(uid)` |
| `backend.trackTimestamp` is vendor-internal | `:64637`, `:75258` | exactly one line in the repo may touch it, in `gpu-zone-timer.js`, dated and cited |
| GPU probe throttle vs zone timer | `renderFrame:7034` | armed together, the early-return drops zone frames and corrupts occurrence rates. **Hard error, not a comment** |
| Compressed textures count as **1 byte** | `:46624` | `info.memory` cannot see the BC-compressed VT atlas — the largest VRAM consumer here. Combine with the viewer's own `mipChainByteLength` estimate and say so inline |
| Two rAF loops are live | `boot.js:4721` + `vt-pan-viewer.js:8376` | `flight-recorder.recordFrame` is fed only by the *heartbeat*. Any `frames` number must name its loop |
| Settle frames | `runSweep` uses 20 | shader compile, first residency pass and first bake all land in the opening frames. Discard 30 and **report the count discarded** |

---

## 7. Bug ledger

Kept from the first line, per house rule — every shipped-invisible round, its cause, and what
caught it.

| # | Date | Symptom | Cause | Caught by |
|---|---|---|---|---|
| 1 | 2026-07-20 → 07-27 | "three's GPU timer is unsupported on this device" | a constructor-only flag defaulting to `false` was never passed; the result was written into two headers as a hardware fact | reading `three.webgpu.js:64637` instead of trusting the comment |
| 2 | 2026-07-27 | `water` reported `cost=0.067ms, declared=within` | its bake is zoned but its draw is not; the partial zone sum was promoted to a total and then graded against a budget | building a preview harness and LOOKING at a rendered report — 160 green assertions had not caught it |
| 3 | 2026-07-27 | `sunShadows` reported `declared=under` | a bake amortised over 612 frames was compared against a per-megapixel steady-state estimate — two different quantities | same preview pass; all-bake effects now get no ms/Mpx at all |
| 4 | 2026-07-27 | zones could stop getting GPU numbers indefinitely | `collect()` guarded the WHOLE method on `resolveInFlight`, so folding stalled behind a slow readback | a test written against a fake renderer, which failed on the second `collect()` |
| 5 | 2026-07-27 | **"waited 30s for 30 frames but only 4 were counted"** on a viewer rendering happily at ~40fps | the live HUD was on. It re-arms the profiler 4×/sec for its rolling window, resetting the frame counter the session was waiting on. **Two consumers, one profiler** | the author's first live run — the error blamed the renderer, the cause was the instrument |
| 6 | 2026-07-27 | every pass row showed `gpu: —` beside children with real numbers; `attribution.coverage` would have come out ~0 on any real run | **GPU and CPU nest in opposite directions.** GPU is attributed to the INNERMOST open zone (exclusive); CPU brackets wrap their children (inclusive). `computeAttribution` summed pass rows only — right for CPU, catastrophic for GPU | the author's first live HUD screenshot |
| 7 | 2026-07-27 | the clipboard held a 5-field summary object, never the full report, on every click of 🔬 Profile + effect sweep | the three perf actions called `MapShine.debug.copyToClipboard(fullReport)` **and then returned a small summary**. `debug-panel-controls.js`'s `makeRunnable` — the click handler wired to EVERY action button — awaits the action, then stringifies and copies **its return value**, unconditionally, after the action's own manual copy. The two writes race in name only; the panel's always loses last. Deterministic on every click, not a race in practice | the author testing the sweep and asking "did you overwrite the clipboard?" |
| 8 | 2026-07-27 | **the sweep ran and delivered nothing** — every `effects[].sweepMarginalGpuMs` null while `method.sweepIncluded` said `true` | the report read `sweep.effects[].gpuMsDelta`. `runSweep` returns costs at **`summary.perEffect[].costMs`**; `sweep.effects` exists but is the id/label list with no numbers on it. A guessed field on a real array = silent `undefined`. **The unit tests used the same invented fixture, so they validated the fiction against itself and passed** | the author's first working full-sweep run — a column of nulls |
| 9 | 2026-07-27 | `sunShadows.sparse.occurrences: 600` read as "baked 600 times, cheaply" | a `maybeBake()` bracket times the **check**, not the bake. The check runs every frame and early-returns; the bake never fired during the window. An expensive bake can hide behind the cost of its own early return | reading the first real report |
| 10 | 2026-07-27 | a finding printed the literal text `"pass.surface.particles is null% of frame GPU"` | the skip guard was `if (share !== null && share < 10) continue` — a NULL share fell straight through. The report doing the one thing it tells every other number not to do | reading the first real report |
| 11 | 2026-07-27 | **the working sweep reported NEGATIVE costs** — vegetation −0.9 ms, doorGraphics −1.1 ms, water −0.8 ms — and the report laundered them into verdicts like *"comfortably under the declared estimate"*. `uiWindowShadow`, DISABLED and with no draw call by design, was charged +0.6 ms | the sweep diffs two whole-frame medians (~21.6 ms each, ~20 samples). Sub-millisecond effects are far below its resolution, so the readings were pure noise. A negative GPU cost is impossible and was the tell | reading the first working full-sweep report |

**Round 11 is the one that matters most for how this tool is used.** The fix is not a tuned constant:
`estimateSweepNoiseFloor()` derives the floor **from the sweep's own most-negative reading** — the
magnitude of an impossible result is a direct, self-calibrating lower bound on that run's noise, and
it scales with machine, scene and frame cost as it must (`feedback_probed_constants_vs_derived`).
Anything inside ±that band is rejected, kept as `sweepRawMs` with a `sweepUnresolvable` reason so the
reader sees *why* the column is empty, and a `sweep-below-resolution` finding names the floor and
says which column to trust. **The sweep can only see effects that are large relative to the whole
frame; the per-zone GPU timer is finer and more direct for everything else.**

**Rounds 8–10 all came from reading one real report.** Round 8 is the expensive one and has its own
memory (`feedback_read_the_producer_never_invent_its_shape`): a guessed shape produces a silent null,
and a fixture written from the same guess makes the test suite complicit in the lie. The fix is a
**contract test that drives the real producer** — `perf-report.test.mjs` now imports `summarizeSweep`
from `perf-lab.js` directly and asserts its output flows through — plus a hard rule that an expensive
step which was *requested* and yielded *nothing* becomes a high-severity finding, never a quiet
column of nulls. `method` now separates `sweepRequested` from `sweepIncluded` for exactly that reason.

| 12 | 2026-07-28 | 🏁 Benchmark: "the camera didn't start at the north, it just moved down and to the right and finished" — a ~1s snap instead of a 60s sweep | **the SAME bug class as a 2026-07-21 regression already in `camera-path.test.mjs`, hit again.** A north-to-south sweep spans ~1.0 of the map's height; `DEFAULT_SETTINGS.longJumpFadeCut` defaults `true`, and `LONG_JUMP_FADE_RATIO = 0.33` classified the whole route as an ACCIDENTAL long jump — fade to black, instant snap straight to the south end (skipping north entirely), fade back in, done in ~1s. `generateKeyframePreset` already returns `suggestedLongJumpFadeCut: false` for exactly this reason; the benchmark action built its own `settings` object and dropped that field | the author watching the sweep and describing exactly what they saw |
| 13 | 2026-07-28 | (found while fixing #12) even with a real sweep, the pan would start from wherever the camera already was, not the north edge — breaking both "starts at north" and run-to-run repeatability | `canvas.animatePan` interpolates from the CURRENT camera position; there is no implicit "snap to keyframe 0" in the player (correct for a hand-authored cinematic path, wrong for a fixed benchmark route) | reading the player code while fixing #12 |

**Round 12 is the sharpest lesson of this whole build: a codebase can document a bug class in a
regression test and still repeat it in the very next file that touches the same API**, because
`feedback_read_the_producer_never_invent_its_shape` was written *after* the sweep-shape bug and
evidently not re-applied to the camera-path integration written in the same session. Fixed by
reading `preset.suggestedLongJumpFadeCut` instead of guessing settings, snapping to the start
keyframe with `previewCameraKeyframe()` before the timed window opens, and — the test that should
have existed before the bug shipped — a new `n_to_s`-specific regression in
`camera-path.test.mjs` mirroring the existing `full`-preset one, so the next caller that forgets
this cannot ship unnoticed.

**The lesson from 5 and 6:** both were invisible to 480 green assertions and obvious in one screenshot.
Round 5 in particular is the shape to remember — **the error message accused the renderer and the
fault was in the instrument**. An instrument that can misdiagnose the thing it measures is worse
than none, so the guard now lives in the profiler itself (`arm({owner})` throws) rather than at one
call site, and the thrown message cites this incident by name so nobody re-derives it.

**Round 7 is a different class entirely — not a math bug, a house-convention violation.** Every OTHER
action already registered in `boot.js` (`orientation-self-test`, `particle-diagnostics`,
`vt-live-decode`, …) just `return`s its payload; none calls `copyToClipboard` manually. That
convention was sitting in plain sight and these three actions were written against a design that
never checked it. See memory `feedback_action_return_value_is_the_clipboard_payload`.

**The lesson from rounds 2–4, which is the same lesson three times:** the tests proved the
arithmetic and missed the *semantics*. What caught all three was rendering one realistic report and
reading it as a person would. `feedback_measure_the_output_not_the_equation` applies to the
instrument itself, and it applies before the author sees it, not after.

## 9. FIRST TRUSTWORTHY MEASUREMENT (2026-07-27, 600 frames, sweep included)

**7.32 Mpx (3840×1906 @ DPR 1.5). 24.9 ms frame = 40 fps. GPU 21.63 ms, CPU encode 3.32 ms.
Coverage 0.962, zero hitches, zero unbalanced brackets. VRAM 88 MB against a 2500 MB wall — a
non-issue.** This is hard GPU-bound; the CPU is not close to being the limit.

| Zone | GPU ms | % of frame GPU |
|---|---:|---:|
| **`geometry.worldDraw`** | **13.29** | **61.4%** |
| `surface.specularDraw` | 3.33 | 15.4% |
| `light.drawColoration` | 1.41 | 6.5% |
| `light.drawPointLights` | 1.18 | 5.4% |
| `present.blit` | 0.64 | 3.0% |
| bloom (all six zones) | 0.46 | 2.1% |
| `light.drawComposite` | 0.28 | 1.3% |
| illum + window light | 0.22 | 1.0% |
| *unattributed* | 0.82 | 3.8% |

**Confirmed by BOTH methods: specular = 3.33 ms** (zone) / 3.9 ms (sweep), `agreement: 'agree'` — the
only effect large enough for the sweep to resolve, and **5.69× its own declared cost class**.

**Ruled out: the vegetation EFFECT is under 1.1 ms.** Its sweep reading fell inside the noise floor.
⚠️ Read that precisely: it bounds the cost of vegetation's *sway/motion*, NOT the cost of drawing
those tiles — vegetation tiles are map artwork and draw inside `geometry.world` whether the effect is
on or off. The 204,376 triangles are their tessellation (`VEGETATION_MAX_SEGMENTS = 128` ⇒ 32,768
triangles per overlay), and `vegetation-render.js:175`'s claim that this is "trivial for a vertex
stage" now has measurement behind it.

**Still open: what makes `geometry.worldDraw` cost 13.3 ms (1.82 ms/Mpx)?** It is ONE
`renderer.render(scene, camera)` — 44 draw calls, one timestamped pass — so timestamps cannot split
it further. The decisive next measurement needs no code: **profile at two window sizes and compare
`ms/Mpx`.** Constant ms/Mpx ⇒ fill-rate bound (overdraw across layers, or a heavy VT fragment
shader); constant absolute ms ⇒ something that does not scale with pixels.

**Run-to-run variance is real and worth respecting:** frame GPU moved 23.13 → 21.63 ms between two
back-to-back runs of the same scene, and the point-light zones moved ~30%. That is the argument for
the fixed camera-path benchmark route before any A/B claim.

## 9b. First live findings (2026-07-27, ~10-frame HUD window)

| Zone | GPU ms | Note |
|---|---|---|
| `geometry.worldDraw` | **15.85** | 4× the next zone, ~2× the entire 8.33 ms budget on its own |
| `light.drawColoration` | 4.02 | one scene of light meshes — expensive for what it does |
| `surface.specularDraw` | 3.77 | |
| `light.drawPointLights` | 3.72 | |
| `present.blit` | 0.73 | |
| `light.drawComposite` | 0.38 | |
| `bloom.downsample` | 0.09 | the mip chain is nearly free |

**The dominant cost is the world scene render, not any effect** — and everyone's instinct (this
document's author included) would have been to hunt bloom or specular first. Note that
`geometry.worldDraw` wraps the whole `renderer.render(scene, camera)`, so **vegetation and water
tier-0 are hiding inside that number** — exactly what `EFFECT_ZONING` declares. Splitting them out
needs the sweep (`🔬 Profile + effect sweep`), which is what bug 5 was blocking.

---

## 8. Verification — what promotes this to LIVE

Node tests prove the report brain's arithmetic and that it never fabricates a zero. They prove
nothing about whether the instrument measures the right thing. Only these do:

1. **🔬 Performance → Profile.** `method.gpu` must read `timestamp-query` and
   `attribution.coverage` > 0.85. If it degrades to `frame-only`, *that is the finding* and the
   report must say so plainly instead of showing a confident breakdown.
2. **The instrument's own self-test.** Toggle bloom off, re-run, and confirm the `bloom.*` zones
   drop out *and* frame GPU falls by roughly what the previous run attributed to them. This is
   `feedback_measure_the_output_not_the_equation` applied to the instrument itself — a correct
   formula in the wrong regime returns nothing, and a profiler is not exempt.
3. **The HUD.** Pan and zoom; top zones must re-rank live, and the HUD's own overhead must appear in
   the profile. The monitor never becomes the thing worth monitoring.
4. **The benchmark route, twice, with no code change.** The two reports' `frame.gpuMs.p50` should
   agree within a few percent. If they don't, the route or the settle window is wrong and **no A/B
   comparison built on it is trustworthy** — which makes this the gate for every "did my
   optimisation work?" claim that follows.
