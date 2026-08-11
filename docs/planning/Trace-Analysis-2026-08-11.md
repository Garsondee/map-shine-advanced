# Chrome DevTools trace analysis — Mansion upper floor under camera stress
*2026-08-11 · Claude Sonnet 5 · source: `chrome-performance-traces/Trace-20260811T155628.json.gz`
(158.4 MB, 645,219 events, 36.41 s) · tool: `tools/trace-analyze.mjs`*

This is the long-form record. The Testament carries the short version as **P-007**.

---

## 0. Provenance and trust

Author-captured on the real production server (`https://mythicamachina.com`), Mansion upper
floor, camera moved deliberately to stress the engine. Law 11 holds: this session read only the
static file the author exported — no connection was made to any live Foundry.

**Capture conditions that qualify every number below:**
- The **astrolabe dial was OPEN** during the capture (proven: `pumpAstrolabe`'s `isConnected`
  gate is passing, §3). That inflates main-thread cost by ~6.9% versus a player's session.
- Browser extensions were active (0.3% of samples — negligible here, unlike the first capture's
  1.86%).
- No Dawn/WebGPU categories → **no per-render-pass GPU attribution is possible.** See §7.

**Profiler-attach artifact detected and excluded automatically:** an 826.9 ms main-thread task
at t=−1.9 ms containing `CpuProfiler::StartProfiling` (825.0 ms). Effective window **35,581 ms**.
Without that exclusion it would have been the largest "hitch" in the capture and pure fiction.

---

## 1. Headline numbers

| Metric | Value |
|---|---|
| Presented frames | 871 → **24.5 fps** |
| Main thread (`CrRendererMain`) busy | **78.3%** (27,873.8 ms) |
| GPU submission (`CrGpuMain`) busy | **85.8%** (30,523.1 ms) |
| Frame service p50 / p99 / max | 15.80 / 68.86 / 105.23 ms |
| Felt cadence p50 / p99 / max | 32.93 / 99.32 / **607.36** ms |
| Hitches >50 ms | **236** in 35.6 s (≈1 every 150 ms) |
| Frames ≥20 ms | 604 of 871 (69%) |

**Verdict: MIXED, not cleanly GPU-bound — and that is a change of regime worth naming.**

The idle 11 s capture (P-006) read main 54.3% vs GPU 90.6% — a 36-point gap, unambiguously
GPU-submission-bound. Under camera stress the main thread climbs to 78.3% against GPU 85.8%: a
**7.5-point gap, inside the tool's own 15-point "neither dominates" band.** The CPU stops being
the thing with headroom the moment the camera moves. Both captures are honest; they describe
two different regimes, and **the stress regime is the one the author actually plays in.**

---

## 2. FINDING 1 — TSL shader-graph rebuilds are running *during* rendering, sustained
### 3,831 ms · 10.7% of all main-thread samples · present in 44.8% of frames

This is the largest single actionable finding in the capture, and it **independently confirms a
hypothesis this project instrumented in round 6 and never got a live answer for** (memory:
`keyhole-performance-audit-2026-08` — "unwanted pipeline recompilation," the cost class
`buildSceneDepthWriterMaterial`'s own header already named at "3.4 ms mean / 43 ms max CPU";
`instrument.pipelineStats` / `pipeline-programs-grew` were added to test exactly this).

**What was measured** (a sample is counted when three.js's `NodeBuilder.build` /
`flowNodeFromShaderStage` / `analyze` / `prebuild` is anywhere on its stack):

| Attribution | ms | share |
|---|---:|---:|
| **Total TSL graph-build work** | **3,831** | 10.7% of main-thread samples |
| ↳ nearest MSA caller: `runSceneDepthPass` (vt-pan-viewer.js:4543) | 1,855 | **48.4%** |
| ↳ nearest MSA caller: `runGeometryWorldPass` (vt-pan-viewer.js:4446) | 1,775 | **46.3%** |
| ↳ everything else (wind field, vegetation sway, scene-depth anon) | ~201 | 5.3% |
| three-side entry point: `_renderScene` (three.webgpu.js:61291) | 3,630 | **94.7%** |

**It is SUSTAINED, not first-compile.** Binned into 18 × ~2 s buckets across the capture:

```
bin  window        build self ms   % of bin
  0  0.0– 2.0s          62          4.8%
  3  6.1– 8.1s         117          7.6%
  7 14.2–16.2s         166          8.6%
 10 20.2–22.2s         167          9.2%
 14 28.3–30.3s         158          8.5%
 16 32.4–34.4s         153          6.8%
first third 628 ms  ·  last third 706 ms   → FLAT
```

A one-time shader compile decays. This does not — the last third costs *more* than the first.
**44.8% of frames (390/871) contain graph-build work.**

**Why it is a genuine cache miss, not expensive cache-key computation** (these need opposite
fixes, so it was checked rather than assumed):

| three.js entry point | inclusive ms |
|---|---:|
| `getForRender` (three.webgpu.js:58505) | 3,876 |
| all `getCacheKey` variants combined | ~383 |
| `_createNodeBuilder` (three.webgpu.js:58483) | 26 |

`getForRender`'s 3,876 ms almost exactly equals the 3,831 ms of build work — so essentially all
of it is inside `getForRender`, which per the vendored source *only* builds when
`renderObjectData.nodeBuilderState` is undefined **and** `nodeBuilderCache.get(cacheKey)` misses.
Computing the key is cheap (383 ms). Allocating the builder is trivial (26 ms). **The expensive
part is rebuilding the graph itself, because the cache is being missed.**

### What this does NOT establish

The trace proves rebuilds are happening and names the two passes responsible. It **cannot** say
*why* the cache key churns. Candidate causes, in rough order of suspicion, none confirmed:
1. Material **variants** flipping as the camera moves — S1.4 shipped `interior` / `passthrough`
   / `legacy` states and `buildSceneDepthWriterMaterial` gained an `alwaysOpaque` structural
   variant. A tile changing state mid-pan is a new material → new cache key → full rebuild.
2. Residency **churn** — items loading/unloading during a pan create fresh materials.
3. A node whose hash genuinely differs per frame, defeating the cache by construction.

**This is the single highest-value next investigation**, and it is a code question now, not a
trace question. The depth pass being the *largest* contributor (48.4%) is a strong hint, because
`geometry.depthDraw`'s CPU cost has been an unexplained outlier for three rounds
(13.08 ms CPU for 9 draws — 26× worldDraw's CPU for twice the draws).

---

## 3. FINDING 2 — the debug HUD costs 2,451 ms (6.9% of the main thread), while open

DOM writes (`set textContent`, `set innerHTML`, `setAttribute`, `set innerText`,
`getBoundingClientRect`, `getComputedStyle`) total **2,617 ms**. Attributed to the nearest
non-browser caller:

| ms | share | caller |
|---:|---:|---|
| 1,415 | 54.1% | `astrolabe.js:506 update` [msa] |
| 709 | 27.1% | `astrolabe.js:350 syncTuningSummary` [msa] |
| 181 | 6.9% | `perf-strip.js:263 set` [msa] |
| 131 | 5.0% | `foundry.mjs:144772 refreshFPS` [foundry] |
| 78 | 3.0% | `perf-strip.js:395 update` [msa] |
| 68 | 2.6% | `render-fallback.js:177 describeRenderMode` [msa] |

**94% of all DOM-write cost in this capture is MSA's own diagnostic UI.**

Two things worth separating honestly:

- **This is conditional, not player-facing.** `pumpAstrolabe` (boot.js:5028) gates its repaint on
  `astrolabe?.root?.isConnected` — a closed panel costs one property read per frame. The author
  had it open. A player never would. So this is **not** 6.9% stolen from every session; it is
  6.9% stolen from *this measurement*, and from the author's own authoring sessions.
- **One piece of it is straightforwardly wasteful regardless.** `syncTuningSummary`
  (astrolabe.js:351) is called from `update()` at line 531 — **every frame** — and writes
  `tuningSummary.innerHTML` to a string whose only variable is `skyRow.value() > 0`. That is
  709 ms of HTML re-parsing across the capture to produce a value that changes when a slider
  crosses zero. A dirty-check here is near-free and unconditionally correct — the same shape as
  the point-light re-triangulation and door-leaf fixes already landed.

**This answers P-006's Finding 4 open question definitively: YES, the report builders are
live-polled**, and `describeRenderMode`'s `getComputedStyle` is genuinely running per frame
(68 ms, small but real).

---

## 4. FINDING 3 — where main-thread JS time actually goes

141,098 samples, 0.25 ms/sample.

| origin | % | ms |
|---|---:|---:|
| browser-internal | 73.1% | 26,116 |
| **three-vendor** | **19.0%** | **6,799** |
| foundry | 3.5% | 1,257 |
| **msa (our own JS)** | **3.0%** | **1,066** |
| unknown | 1.1% | 387 |
| extension | 0.3% | 123 |

⚠️ **Read this table carefully — it is the most misreadable number in the report.** MSA's *self*
time is 3.0%, which does **not** mean MSA costs 3% of the frame. Our code's job is to *drive*
three.js; the work lands in three's node/render machinery and in browser-internal native calls.
The inclusive (total) view is the honest one:

| ms | function | origin |
|---:|---|---|
| 10,778 | `update` — three's own rAF driver closure (three.webgpu.js:45346) | three-vendor |
| **9,267** | **`renderFrame` (vt-pan-viewer.js:9527)** | msa |
| **9,080** | **`runPassPlan` (run-frame.js:97)** | msa |
| 7,480 | `_renderScene` (three.webgpu.js:61291) | three-vendor |
| 6,637 | `_renderObjectDirect` (three.webgpu.js:62666) | three-vendor |
| **5,233** | **`runGeometryWorldPass` (vt-pan-viewer.js:4446)** | msa |
| **3,296** | **`runLightAccumulatePass` (vt-pan-viewer.js:4630)** | msa |
| 2,633 | `pumpAstrolabe` (boot.js:5028) | msa |
| **2,348** | **`runSceneDepthPass` (vt-pan-viewer.js:4543)** | msa |
| 1,367 | `point-light-pool.js:841 update` | msa |
| 1,024 | `scene-lights.js:327 readActiveLightSources` | msa |
| 988 | `scene-wall-clip.js:255 computeLightWallClippedShape` | msa |

*(`update` at three.webgpu.js:45346 is three's animation-loop closure that CALLS `renderFrame` —
it is the tree root, not a separate cost. Verified in the vendored source; recorded so nobody
reports it as a finding.)*

**Pass split of main-thread CPU:** world 5,233 ms · light-accumulate 3,296 ms · scene-depth
2,348 ms · post-bloom 244 ms.

**Point lights, secondary finding:** `computeLightWallClippedShape` (988 ms) is nearly as
expensive as the entire `point-light-pool` update it serves (1,367 ms), and
`readActiveLightSources` costs 1,024 ms. Wall-clipping geometry is a bigger share of light cost
than the light update itself — worth its own perf zone before anyone optimises blind.

---

## 5. FINDING 4 — the rAF question from P-006, answered

4,808 `FireAnimationFrame` callbacks against 871 frame services = **5.52 callbacks per frame**.
Grouped by the module that dominates each callback's samples:

| total ms | count | max ms | dominant module |
|---:|---:|---:|---|
| 21,315.7 | 1,147 | 100.71 | three.webgpu.js *(MSA's render loop)* |
| 1,155.0 | 2,839 | 3.51 | *(no samples — sub-sampling-interval, i.e. trivial)* |
| 235.8 | 210 | 4.32 | foundry.mjs |
| 200.8 | 76 | 4.28 | **render-fallback.js** |
| 113.9 | 146 | 2.06 | bootstrap-autofill-overlay.js *(extension)* |
| 106.6 | 136 | 1.62 | **astrolabe.js** |
| 56.5 | 21 | 5.92 | **vt-pan-viewer-diagnostics.js** |
| 36.4 / 36.2 | 15 / 47 | — | vt-pan-viewer.js / boot.js |
| 16.6 | 7 | 2.80 | **perf-strip.js** |

**Verdict: these are multiple legitimate independent loops, not one loop scheduling badly.** The
2,839 "no samples" callbacks are real but each finishes inside a single 0.25 ms sampling
interval — cheap bookkeeping, not a leak. The finding here is smaller and different from the
suspicion: **~275 ms of rAF time belongs to diagnostics** (render-fallback + diagnostics +
perf-strip), which is the same story as §3 from another angle.

---

## 6. Hitches — 236 over 35.6 s

Top hitches are 70–109 ms, and their dominant JS is consistently `(program)` (native/driver
time, not attributable JS) followed by `getDataFromNode` / `build` — i.e. **the TSL rebuild of
§2 is visible inside the hitches themselves.**

| at (ms) | dur (ms) | dominant JS |
|---:|---:|---|
| 16,532.9 | 108.8 | `(program)` 13.7 ms · `getDataFromNode` 6.1 ms · `build` 3.3 ms |
| 6,000.3 | 94.7 | `(program)` 19.1 ms · `(garbage collector)` 4.8 ms · `build` 3.8 ms |
| 4,082.3 | 91.7 | `(program)` 28.2 ms · `getDataFromNode` 4.6 ms |
| 10,526.8 | 80.1 | `(program)` 13.5 ms · `getDataFromNode` 2.8 ms |

The `607 ms` worst felt-cadence gap has no long main-thread task behind it — consistent with a
GPU-side or presentation stall the CPU-side trace cannot see (§7).

**GC is present but not a driver:** `(garbage collector)` 447 ms self (1.3%), rising to 1.98 ms
per slow frame vs 0.14 ms per fast frame — a *symptom* of the allocation churn in the rebuild
path, not an independent problem.

---

## 7. Blind spots — what this capture cannot answer

1. **No per-render-pass GPU attribution.** Dawn/WebGPU categories were not recorded. The GPU
   thread's 85.8% busy is real; splitting it into `geometry.worldDraw` vs
   `pass.light.accumulate` is structurally impossible from this file. MSA's own timestamp-query
   zone timer (`diag/perf-session.js`) remains the only instrument that can.
2. **`(program)` is 42.7% of samples** — V8's "executing, but not in a JS frame" bucket. Native
   calls, driver work, and compositing land here undifferentiated.
3. **Sampling floor.** At 0.25 ms/sample, anything under ~0.2% self-time is noise.
4. **One capture, one machine, unknown concurrent load.** Per the P-003 standing rule these are
   DIRECTIONAL. The §2 finding survives that caveat because it is a *ratio and a shape* (flat
   across bins, 44.8% of frames), not a single number.

---

## 8. Recommended next actions, in value order

1. **Chase the TSL cache miss (§2).** Highest value by a wide margin — 10.7% of the main thread,
   and it corroborates a three-round-old unexplained cost. This is now a code question: instrument
   or log `getForRenderCacheKey` churn for depth-pass materials specifically, and check whether
   S1.4's material states/`alwaysOpaque` variants flip during a pan. Start at
   `runSceneDepthPass` (48.4%).
2. **Pair the next capture with a simultaneous `perf-run-full`.** The author has agreed to this.
   It is the only way to convert "GPU 85.8% busy" into a named pass, and it closes the one blind
   spot that matters.
3. **Dirty-check `syncTuningSummary` (§3).** ~709 ms for free, trivially safe, same shape as
   fixes already landed. Consider the same for `perf-strip`/`describeRenderMode` polling cadence.
4. **Capture once with the astrolabe CLOSED** to get a clean player-representative baseline —
   ~6.9% of the main thread is the dial.
5. **Give `computeLightWallClippedShape` its own perf zone (§4)** before optimising point lights
   further; it is a bigger slice than its position in the ledger suggests.

---

## 9. The tool

`tools/trace-analyze.mjs` (+ `tools/trace-analyze.test.mjs`, 49 assertions, wired into
`npm run verify`). Reads `.json` or `.json.gz` directly.

```sh
node --max-old-space-size=8192 tools/trace-analyze.mjs <trace.json.gz> --md report.md --json report.json
node --max-old-space-size=8192 tools/trace-analyze.mjs <before.gz> --compare <after.gz>
```

It encodes three measurement bugs made by hand on the first trace so they cannot recur:
interval-**merged** busy time (a hand-summed figure produced an impossible "174.6% GPU busy",
and `assertUtilizationSane` now throws rather than emit one); breadcrumb-based trace windowing
(a `ts:0` metadata event made a naive scan report an 11.3 s trace as 428,161,450 ms); and
automatic profiler-attach-artifact detection that requires real containment of
`CpuProfiler::StartProfiling`, so a *genuine* early hitch is never silently discarded — that
sabotage case is a test.
