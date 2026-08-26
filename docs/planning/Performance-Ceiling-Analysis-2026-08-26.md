# Is 60fps Dead? — The Ceiling Analysis, 2026-08-26

Sequel to [`Performance-Priorities-2026-08-26.md`](Performance-Priorities-2026-08-26.md), which now
records SIX eliminated hypotheses for `geometry.worldDraw` and no surviving lever. The author's
question, verbatim:

> *"are dreams of hitting 60fps or at least 45fps in 4K on these sorts of maps dead? Is there any
> potential performance improvement that's been proposed but not implemented yet? ... A lot more red
> frames than yellow and few green. Surely we can get things to be more reliable? I'm throwing the
> door open to wild possibilities and big refactors."*

**Short answer: not dead. But the honest path runs through three things, and two of them are
"finish or verify what is already built" rather than "invent something new."**

**Evidence base:** the live `perf-run-full` capture `2026-08-26T18:27:42.703Z` (Town River Bridge,
3 floors, 1760 frames / 57s), **three Chrome DevTools traces the author captured of the same live
session** — the first CPU-side ground truth this investigation has ever had — plus a full
proposed-vs-implemented sweep of 13 planning docs verified against source, and targeted source
audits of the water path and the resolution path.

---

## 0. THE REFRAME: we are vsync-quantised, and "45fps" does not exist

Before any optimisation talk — **the frame times in this capture are not a distribution, they are a
staircase.** On a 4K120 display a frame can only land on a vsync multiple:

| steps | frame time | fps |
|---|---|---|
| 1 | 8.33ms | 120 |
| 2 | 16.67ms | **60** |
| 3 | 25.0ms | **40** |
| 4 | 33.3ms | **30 ← we are here** |
| 5 | 41.7ms | 24 |

The report's numbers land on those rungs and nowhere else: `bestFps: 40.3`, `medianFps: 30.0`,
`worstFps: 23.9`, `frameMs.best: 24.8`, `p99: 33.5`, `gapMs.max: 41.8`. `diag/gpu-probe.js`'s own
header already names the environment (*"the ~8.33ms vsync"*).

**Three consequences that change the goal:**

1. **"45fps" is not achievable on this display — the rungs are 60, 40, 30, 24.** The real targets
   are **40fps (GPU < 25ms)** and **60fps (GPU < 16.7ms)**. Current GPU p50 is **30.8ms**.
   **Cut 5.8ms for a rock-solid 40. Cut 14.1ms for 60.**
2. **Most of the red is "not 60", not instability.** Chrome paints anything over ~16.7ms red; at
   30fps every frame is red by that yardstick. The genuine step-drops to 41.7ms are real and are a
   separate problem with a separate cause (§3).
3. **Reliability is a HEADROOM problem.** GPU 30.8ms inside a 33.3ms budget = **2.5ms of margin
   (7.5%)**. The report says `hangs.totalStalls: 0`, `hitches.count: 0` — but its hitch threshold is
   50ms, and the traces show `Major GC` **15.3ms**, `C++ GC` **32.8ms**, and a per-frame material
   rebuild. **Any one of those blows 2.5ms of headroom and drops the frame a rung, and the perf
   report is structurally incapable of seeing it** — below the threshold, outside every GPU zone.

**So the frame-rate fix and the reliability fix are different work.** Cutting GPU ms moves us to a
better rung; cutting CPU jitter stops us falling off whichever rung we are on.

---

## 1. WHERE THE FRAME IS — one pass, and the quality ladder controls almost nothing else

`geometry.worldDraw` is **24.798ms = 80.5% of frame GPU**, from **17 draw calls and 546 triangles**,
with `rasterizedFractionPct: 3.3` (96.7% of the coverage grid already culled). **This is not a
geometry problem or a draw-call problem. It is per-fragment shading × pixel count.**

The tier sweep, read properly for the first time:

| profile | frame GPU p50 | `geometry.worldDraw` | avgFps |
|---|---|---|---|
| low | 21.04 | **17.465** | **44.1** |
| performance | 24.84 | 20.958 | 38.0 |
| standard | 25.69 | 21.802 | 36.9 |
| quality | 32.11 | 25.789 | 29.7 |
| extreme | 31.92 | 25.600 | 29.9 |

Two readings nobody has taken from this table:

1. **The quality tiers control essentially nothing except `worldDraw`.** Across the whole ladder
   `bloom` moves 0.465→0.472, `window` 0.690→0.695, `specular` 0.195→0.196, `water` 0.143→0.145,
   `vision.gate` 0.234→0.233 — every one flat. Of the 10.88ms the ladder buys,
   **8.135ms (75%) is `geometry.worldDraw` alone.**
2. **`worldDraw` has a ~17.5ms floor no setting touches.** And the report's own
   `tierComparison.coverageCaveats` proves the tier-responsive 8.1ms is *not* albedo clarity (that
   gate reads the persisted setting at material-build time; the sweep's transient override never
   reaches it — *"Every tier in this sweep shows the CAS/sharpening material completely unchanged"*).

**We already measure 44.1fps at `low`, at full 4K.** The 40fps rung is reachable today by settings
alone. The open question is how much look that costs — and that cannot be answered while `worldDraw`
is a single opaque number.

### The instrument gap underneath everything

`runGeometryWorldPass` (`vt-pan-viewer.js:5338-5340`) brackets **one call**:

```js
profiler?.begin(Z.geomWorld);
renderer.render(scene, depthCamera);
profiler?.end(Z.geomWorld);
```

Base map art, water's tier-0 surface, vegetation, doors — all of it, one number. `diag/perf-zones.js`
says so verbatim for water: *"the tier-0 surface is a drawable at renderOrder 0.5 inside
geometry.world … so its draw cost cannot be separated."* **Six hypotheses have now been eliminated
by aiming narrow A/Bs at an opaque aggregate.** Three's timestamps are per `renderer.render()`, so a
sub-zone is impossible — but **a visibility A/B is not**: toggle `mesh.visible` per drawable class
and diff `geometry.worldDraw`. No restart, no material rebuild, and
`diag/perf-shader-variant-ab.js` (built this same day) is already the right shape.

---

## 2. THE THREE LEVERS THAT ACTUALLY AIM AT THE 81%

A full sweep of 13 planning docs found **24 unbuilt proposals carrying real numbers and ~20 more
carrying none**. Almost none of them touch `worldDraw`. The Gap Analysis's own meta-finding stands
and is the most important sentence in the corpus: ***"`geometry.worldDraw` … has no proposed fix
anywhere in any document."*** These three are the exceptions.

### 2a. Render resolution — proposed, quantified, rejected on aesthetics, and now the door is open

**This is not a new idea and I am not presenting it as one.** `Performance-Insights.md` §6
(2026-07-28) already proposed it with a number:

> *"DPR 1.5 → 1.0: **21.6 ms → ~9.6 ms (roughly 40 → 85 fps)**"* — ~55% fewer pixels, later updated
> to *"the motion starting point is now 17.83 ms, so the same 55% cut lands at ~8.0 ms."*

It was **declined for a stated reason, and the reason is a look reason**: *"MSA mushes the artwork's
pen outlines."* `Moonshot-Plan.md` §5 then put it formally off-menu: *"Temporal upscaling / dynamic
resolution at `standard` profile — off-menu; **zoom-out clarity is a locked aesthetic.**"*

**So this is a locked decision, and reopening it needs the author's explicit say-so — which
"I'm throwing the door open to wild possibilities" is.** What has changed since it was locked:

- **We now know the frame is 81% one fill-bound pass.** That was not established in July.
- **The vsync arithmetic makes it the difference between rungs, not a marginal gain.** Recomputing
  from *this* capture's own zones: ~27.4ms of the 30.8ms frame is resolution-bound (worldDraw,
  window, bloom, illum, composite, vision gate, specular, depthDraw, regions, earlyZ, fire, point
  lights); ~3.3ms is not (`pass.surface.water`'s fixed 1536×714 sim grid + 1280×640 refraction
  capture, and `present.blit` which is output-sized by definition). At `pixelRatio 1.0` the render
  area is 2560×1271 = **44.5% of current**: `27.4 × 0.445 + 3.3 ≈ **15.5ms → the 60fps rung**`, and
  comfortably under 25ms even with generous slop — **a guaranteed 40 with 6–9ms of headroom**, which
  fixes the reliability problem in the same stroke.
- **A prior A/B measured this SUPERLINEAR** — 47% fewer pixels bought ≥4.4× on the Mansion. Linear
  is the floor of the expectation, not the ceiling.
- **CAS now exists and measures free** (0.051ms against a 0.19ms floor, A/B'd this same day) —
  which did not exist as a mitigation when the aesthetic objection was first raised.

**The zero-code experiment:** toggle Foundry's own **"Disable Resolution Scaling"** client setting
and re-run. MSA mirrors Foundry's resolution at `vt-pan-viewer.js:1462-1464`, and that block's own
comment already names this as the lever: *"if frame rate suffers, Foundry's own 'Disable Resolution
Scaling' client setting is the lever."* **Nobody has ever tried it and measured.**

**Falsifiable prediction, recorded before the fact:** GPU p50 lands **15.5–19ms**, `avgFps` reads
**40+ and plausibly ~60**, `worldDraw` drops **24.8 → 11–13ms**. If it does not, the frame is not
fill-bound and this entire section is wrong — which would be the most informative negative result
this investigation has produced.

⚠️ **The look question is the real decision and it is the author's alone.** The measurement only
tells us what it costs; it cannot tell us whether the pen outlines survive. Run it, then *look*.

**If the look holds, the build is unusually clean.** `renderScale` becomes a multiplier on line 1463;
every screen-sized target already derives from `renderer.getDrawingBufferSize()` and re-allocates
through one existing function, `reallocateScreenSizedTargets()` (`:14878-14956`). ~665MB of targets
follow it — at 0.75 that is **−291MB / −44% VRAM**, P2's other stated payoff. The present pass
already upscales for free (`scene.lit` is `filter:'linear'`, `grade-present.js` is per-pixel with no
kernel). **And a tuned governor already exists in our own history**: `git show 2ebd161^:src/graph/v3-perf.js`
— 474 lines plus a 204-line test, deleted 2026-07-28 as a *"superseded dead perf module"*, carrying
hardware-bought tuning (ladder 1.0→0.85→0.7→0.6→0.5, 15-frame down-streaks, 180-frame up-streaks,
90-frame cooldown, held during scene load, and the `max(cpu, gpu × r²)` insight that CPU submission
cost is resolution-independent). **Harvest, do not import** — `verify-structure` forbids `legacy/`
imports. A dead UI for it even ships already (`templates/performance-graphics-menu.hbs:16-22`).

**Real blockers, in order:** (1) **CAS is on the wrong side of the seam** — it is compiled *into the
world-draw material* (`:9314-9318`) with a derivative-based kernel tapping *"exactly one OUTPUT pixel
away"*; under a scale that becomes one *internal* pixel, so it sharpens harder and then the bilinear
present blurs it away — **the exact inverse of FSR1, where RCAS sharpens AFTER the upscale.** Fixable
(`albedo-clarity.js` is deliberately THREE-only and Foundry-free; `grade-present.js` is the natural
host) but it is a second piece of work, not a free rider. (2) `onResize` early-returns on an
unchanged CSS box (`:14964`) so the realloc must be called directly. (3) Camera math must stay in
CSS px (`:12718`) — a documented 1.76× over-span bug lives there. (4) `vision.mask` and `scene.depth`
are deliberately `filter:'nearest'` (*"Linear filtering would invent half-revealed pixels along a
wall edge"*) so fog and occlusion edges get blockier — **a genuine quality cost, the honest
counterweight to "only the map softens."** No Foundry-seam coupling at all; picking and
depth-authority are already normalized.

### 2b. Early-Z "opaque EQUAL resolve" — designed for 26.6 → 4–8ms, ~90% built, delivering ~0.5ms, and NOTHING measures whether it engages

`Moonshot-Plan.md` §2 (2026-08-10) set the target explicitly: ***"Target: `worldDraw` 26.6 → 4–8 ms"***,
destination frame *"≈12ms worst, 8–10 typical."* Source verification says far more of it shipped than
any doc records: the interior/boundary index split is live (`coverage-mesh.js#splitCoverageCellMask`,
wired at `vt-pan-viewer.js:10530`), `applyEarlyZTileState` is called every residency pass (`:13539`),
and interior spans really do get `depthFunc: EqualDepth` + `transparent:false` + `maskNode:null`
(`:12968-12975`, `:13032-13045`).

**What did not happen:** boundary/`passthrough` tiles still run `transparent:true` / `depthTest:false`
with `maskNode` restored (`:12991-12994`), and `material.side = THREE.DoubleSide` is still
unconditional (`:9277`).

**Measured delivery: ~0.5ms against an 18–22ms target.** Moonshot-Plan's own abort clause —
*"If early-Z lands under 2× predicted win → stop, reconcile"* — **fired at S1.6 (1.55× against a 2×
bar) and has never been discharged.** This is the single largest gap between paper and reality in
the entire corpus.

🚨 **And there is no live readout for how many tiles actually reach `interior`/`split` state.**
Grepping both saved reports for `splitDeclined` / `earlyZState` / `cellSplit` returns zero hits. The
shipping commit's own message calls it *"honest no-op"*. **So the biggest designed win in the project
is built, unmeasured, and may simply not be engaging on real content — and nobody can tell.**

That is precisely the failure mode the author's own standing rule was written against: *"if you build
something don't hide the enabling of it behind a console command or flag because then you can build a
fix that sits there silently not working."* **Surfacing `earlyZState` counts in the perf report is
small, cheap, and owed.**

### 2c. The mip-0 solidity pin — the ONLY unbuilt lever aimed directly at the 81%

`vt-pan-viewer.js:9271`, inside `buildWholeImageMaterial`, per fragment:

```js
const physicalSolidityAlpha = texture(tex, uv().mul(uUvScale)).level(float(0)).a.mul(uAlpha);
```

A **forced LOD-0 sample of the full 10650×4950 map texture**, on a pass where the camera is zoomed
out far enough to fit the whole map on 3840 screen px — a ~2.8× minification. Adjacent screen pixels
therefore read texels ~2.8 apart in the source, which is a textbook cache-thrashing access pattern.
`Performance-Audit-2026-08.md` §4.1 states it plainly: these taps *"touch a working set 16–500×
larger than the correctly-mipped taps beside them in the same shader"*, and *"explicit-LOD sampling
also bypasses anisotropic filtering."* The surrounding texture setup is otherwise correct
(`LinearMipmapLinearFilter` + `ART_TEXTURE_ANISOTROPY`, `:10758-10760`).

**Why the CAS result does not exonerate this.** The corpus already ruled out fetch-*counting*
(`Performance-Insights.md` §9: *"Layer count and fetch count are both exonerated… A fetch is not a
unit of time"*), and the CAS A/B confirmed it — but CAS's 5 taps are **correctly mipped and
cache-friendly**. This one is not. **It is a working-set problem, not a count problem**, and no
measurement taken so far has touched it.

**A control I got wrong, corrected here for the record.** I initially reasoned that
`geometry.depthDraw` (0.184ms) proves fill and LOD-0 sampling are cheap, since the depth writer also
samples at `.level(float(0))` (`scene-depth.js:476`). **That control is invalid** — the depth
writer's tap was already removed for opaque tiles via `alwaysOpaque`. The depth pass is cheap partly
*because* it does not do this. The 135× gap between the two passes is now **consistent with** the
mip-0 pin mattering, not evidence against it.

**Why it was not done, quoted honestly:** *"The level-0 choice is load-bearing in both places — a
coarse implicit mip once averaged a padded tile's alpha to a wrong value… The fix is not 'delete the
`.level(0)`'; it is finding a formulation that keeps the alpha correct without pinning mip 0."* The
doc **deliberately refuses to size it in ms.**

**But it is now cheaply MEASURABLE without solving the correctness problem.** Add a third toggle to
`diag/perf-shader-variant-ab.js` — the restart-based A/B built this same day — that drops the
`.level(float(0))` and lets the implicit mip run. **Visually wrong while armed, exactly like the
`maskNode` toggle already is, and for the same reason: it is a measurement, not a fix.** ~20 lines
against machinery that already exists. **This is the single highest-value thing I can build right
now**, because it is the only unmeasured hypothesis left pointing at the 81%.

### 2d. Free, byte-identical: a dead texture fetch in the world material

`occlusionAlphaFactor` (`vt-pan-viewer.js:9152-9159`) unconditionally does
`texture(occlusionMask.texture, screenUV)` with no early return — and `foundry/scene-layers.js:314`
gives the viewed floor's own background and foreground exactly `modes: 0`. `modes` is a plain JS
number at material-build time, so `if (modes === 0) return float(1)` **removes the fetch, the
binding, and the arithmetic from the compiled shader** for the base map art.

Corroboration that the mask is genuinely empty on this content: the live report reads
`masks.occlusionDraw: 0.000ms, drawCalls: 0`. `Performance-Audit-2026-08.md` §4.5 sizes the waste at
*"~7.3M dead fetches per NONE-mode layer per frame; with a background + 2 canopies + 2 shadows,
~37M/frame."* Unbuilt, byte-identical output, one guard clause.

---

## 3. THE RELIABILITY STORY — four causes, all confirmed, none visible to the perf report

### 3a. A water tier gate that structurally cannot converge — PROVEN, and firing right now

`water-surface-subsystem.js:694-698` rebuilds when the resolved tier differs from what was built,
and `:725` records what was **actually** built:

```js
if (resolvedTier !== builtForTier) { surface = buildSurfaceForTier(resolvedTier); … }
…
builtForTier = surface.tier;
```

But `surface.tier` is not what was requested — `water-render.js:1029` **clamps** it:

```js
const activeTier = bodyTexture ? (requestedTier >= 5 && !capturedTexture ? 4 : requestedTier) : 0;
```

**The moment a clamp engages, `builtForTier !== resolvedTier` at the instant of the build — so the
next frame sees the same mismatch and rebuilds again. Forever. No throttle, no backoff, no attempt
counter, no terminal state.** Each pass allocates four fresh `THREE.NodeMaterial()` objects and
reconstructs the entire ~2800-line TSL graph. The design is deliberate and correct for a *race*
(`:706-724`); its failure mode for a precondition that never becomes true was never costed.

**The author's own pasted report already proves it is firing.** `instrument.cacheStats.
waterBodyBakeGate[]` carries one entry per floor:

| floor | `surface.perfTier` | `maskImage` | |
|---|---|---|---|
| 0 | **5** | loaded | converged ✅ |
| 1 | **0** | `"not loaded"` | 🚨 clamped |
| 2 | **0** | `"not loaded"` | 🚨 clamped |

`floorsWithWater: [0,1,2]` — all three floors are registered as having water, but floors 1 and 2
never loaded their mask, so `bodyTexture === null` pins `activeTier` at 0 permanently against a
profile asking for 5. And `sync()` runs **unconditionally for every floor, every frame**
(`vt-pan-viewer.js:5803` iterates the full floor list, not floors with water), with the tier gate at
the *top* of `sync()`, before its `if (!bounds) return;` bail.

**So two of three floors are rebuilding four TSL materials every single frame.** That is a complete
mechanical explanation for the traces:

| trace entry | cost | share of scripting |
|---|---|---|
| `sync water-surface-subsystem.js:673` | 79.3ms | 15.8% |
| ↳ `buildSurfaceForTier :324` | 72.6ms | 14.4% |
| ↳ `buildWaterSurfaceMaterial water-render.js:904` | **70.9ms** | **14.1%** |

**Severity, calibrated honestly.** Two independent cross-checks date the trace window at **~50–65
frames (~2s)**: `updateEnvSnapshot` 13.8ms ÷ 0.278ms/frame ≈ 50; `sync fire-subsystem.js:273` 23.9ms
÷ 0.369ms/frame ≈ 65. So `buildWaterSurfaceMaterial`'s 70.9ms is **~1.1–1.4ms per frame** — which
lands exactly on the report's independently-measured `light.waterSurfaceSync` **1.1ms mean / 3.1ms
max / 1936.6ms total**, the single largest CPU zone in the whole capture and about half of
`pass.light.accumulate`'s entire 2.153ms CPU budget. **Two instruments, one number, agreeing.**

**On a frame with 2.5ms of headroom, a 1.1ms floor with 3.1ms spikes is the step-drop.**

*Bonus dead weight in the same file:* the whole tier-4 `buildWaterShoreFoam` graph — including four
body-pack tail taps — is constructed on every build but reaches only the debug-channel readout
(`water-render.js:2429`); its own comment at `:1897` confirms `shore.foam` *"no longer reaches"* the
composite, superseded 2026-08-18. It should be DCE'd from both shipping shaders.

**And there is a second, unconditional cost in the same zone that has nothing to do with the rebuild
loop.** `sync`'s very first line calls `ensureMaskImage(floorIndex)`, whose early-out sits *after*
the lookup (`:624-626`), so `getWaterMaskUrl` → `mask-authority.js#authoredStatus` →
`backgroundItemOf` runs every frame — and that is **an uncached linear scan of the entire scene item
map, per water floor, per frame** (`mask-authority.js:585-590`). It is the only O(scene) thing on the
unconditional path. Alongside it, `water-registration.js:151-162` allocates a **fresh `new Proxy` per
frame** whose `get` trap fires ~42 times building the change key (`:813-857`), plus ~40 more on any
frame the key changes. Neither is proven to dominate the 1.2ms — that needs a sub-zone — but both
run on a completely quiet frame.

### 3b. THE INSTRUMENT BUG — two findings that can never fire, in any report, ever

⚠️ **I got this one wrong on the first pass and the corrected version is more useful.** My initial
read was "the shader-rebuild probe is dead." It is not. Both probes **are** armed automatically on
every `perf-run-full` (`perf-session.js:463`/`:470`, wired through `boot.js:4113-4121`). The real
defect is sharper:

`stats().installed` is a **live flag**, not a record of the window — `uninstall()` sets it `false`
(`shader-rebuild-probe.js:205-211`, and identically in `pipeline-rebuild-probe.js:201-213`).
`perf-session.js` deliberately disarms at `:543`/`:548` and *then* reads the stats at `:587-593`
(its own comment: *"read AFTER disarm — disarm() uninstalls the hook but does not clear the
counters"*). But `perf-report.js` gates both findings on the flag:

```js
if (shaderRebuildStats?.installed === true && …)   // :1280
if (pipelineRebuildStats?.installed === true && …) // :1331
```

**`installed` is false by construction on every path `perf-session` uses. The `shader-rebuild-churn`
and `pipeline-rebuild-churn` findings are structurally unreachable in any `perf-run-full` report
that has ever been produced or ever will be.** The proof is in the report itself:
`pipelineRebuildStats: {installed: false, calls: 144320}` — 136k–144k calls with `installed: false`,
i.e. demonstrably live all window while flagged as absent. **The unit tests miss it because every
fixture hand-feeds `installed: true`** (`perf-report.test.mjs:1365`, `:1453`).

This is `[[feedback_instruments_must_not_lie]]` in its purest form, and the fix is small: gate on
`Array.isArray(labels)` / a `wasInstalled` record rather than the live flag, and add a fixture that
does *not* hand-feed the flag.

### 3c. What the shader probe's `calls: 0` actually means — a genuine negative that RECONCILES the picture

`shaderRebuildStats` read `calls: 0` in the same window the pipeline probe read 144,320. That is not
a broken hook: `Nodes.getForRender` has exactly one caller
(`three.webgpu.js:45587-45589`), `renderer._nodes` is the same object handed to `RenderObjects` and
`Pipelines`, and the long explanatory `note` in the report can only come from a real `probe.stats()`
— the never-armed placeholder returns a different string. **The probe existed, was installed, and
genuinely counted zero. So no `NodeBuilder.build()` ran during the measured window at all.**

At first that looks like it contradicts §3a. It does not — **it completes it.** Floors 1 and 2 have
`surface.visible: false`. Their materials are reconstructed in JS every frame by the tier-gate loop,
but they are **never drawn**, so three is never asked to build them and `getForRender` is never
called. **We are paying full JS construction and GC cost, every frame, for shaders that never reach
the GPU.** That is worse than a normal rebuild, not better.

### 3d. Two trace readings I had wrong, corrected for the record

Both were plausible and both were false, and this project has been burned by plausible-and-false
before:

- **`mix fire-mask.js:629:15` is not TSL.** It is an FNV-1a hash mixer — `const mix = (v) => { hash ^= v|0; … }` inside `fireMaskSignature`. It runs ~4,106 times per invocation, **twice per frame per fire floor** (`boot.js:3270`, `:3311`) ≈ **8,200 calls/frame**, which fully accounts for its 7.5ms. Real cost, nothing to do with node graphs — and it is a *second* guard alongside `getMaskAuthorityVersion()`, which is already in the same cache key.
- **`get value three.webgpu.js:55299` is not build-time.** It is `NodeUniform.get value()`, on the
  normal per-frame uniform dirty-check/upload path (`WebGPUUniformsGroup.update()` → … → this
  getter). With 230 uniform buffers, a high call count is expected steady-state cost.

Only `VarNode:35510`, `In:33653` and `_getChildren:32472` are genuine node construction — consistent
with §3a's JS-side rebuild. Calibrated against the ~50–65 frame window, that cluster is
**~0.12–0.19ms/frame each, ~0.5–0.9ms/frame including GC** — real, but roughly *half* of item 3a
alone. The `Major GC` 15.3ms / `C++ GC` 32.8ms figures are window totals, not per-frame.

### 3e. The rest, all cheap, all already priced

- **The arity-1 CRUD hook** (`boot.js:11984`, `Hooks.on(hook, (doc) => {`) discards Foundry's
  `(document, changes, options, userId)`, so **any** write to any Tile/Level — a rename, a lock, a
  permissions change, a foreign module's flag — fires the full mask-authority cascade. This capture
  prices it directly: `editCascadeStress` delta **57.043ms/frame**, `bakeRuns: 76`. Known-good
  one-line templates exist two files away (`scene-walls.js#watchDoorOpenings`,
  `sky-persistence.js#watchSceneSky`). **Smallest effort, highest measured impact on the whole
  unbuilt list.**
- **The sun-shadow bake throttle is already written and sitting uncommitted** in the working tree
  (`sun-shadow-subsystem.js`, +124/−15, with an untracked test file) — mirroring water's shipped
  `ae737ff`. The same stress test prices what it fixes at **`light.sunShadowBake +25.086ms`**.
  It needs committing and a live look, not building.
- 🚨 **Precipitation's entire per-frame CPU sync has NO perf zone at all.**
  `vt-pan-viewer.js:12408-12415` calls `precipitationSubsystem.sync(...)` with no
  `profiler?.begin/end` around it — unlike `fireSubsystem.sync` immediately above (`:12391-12398`).
  Of 56 zones, the only precipitation entry is `pass.surface.precipitation` (the *draw*, 0.003ms).
  **The report cannot see this subsystem's CPU cost at all**, which is exactly why the next item was
  invisible until a Chrome trace found it.
- **A forced synchronous layout inside the render loop, on a clear day.**
  `getPrecipRenderState` (`:3199`) reads `renderer.domElement.clientWidth`, forcing a style+layout
  flush. It is **unconditional**: the function hardcodes `enabled: true` (`:3178`), so
  `precip-subsystem.js:539`'s `if (!st || st.enabled === false) return` can never short-circuit it —
  the read happens with `precip01 === 0` and no weather. A cached equivalent (`canvasW`, `:1284`,
  same CSS-pixel units, updated on resize) already exists in the same closure and is already used
  per frame three lines away. ~0.07ms/frame in the trace — small, but it buys one integer that is
  already sitting there.
- **`weather.getStatus()` runs every frame with exactly one consumer, and that consumer is a
  diagnostics accessor.** `world/weather.js:1310` allocates **~11 `Object.freeze` calls** per frame
  (one per weather axis, plus almanac/events/precipitation wrappers, plus a frozen array per active
  event). `Object.freeze` forces a V8 map transition, so this is a genuine allocation/GC source.
  Its only reader is `vt-pan-viewer.js:17632`, inside the diagnostics path — **nothing in the render
  path touches it.** Pure cost, 30×/second.

---

## 4. The rest of the unbuilt inventory, honestly summarised

24 proposals with numbers, ~20 without. The ones worth knowing that are **not** covered above:

- **Half-res `scene.illum` + `scene.coloration`** — *"2.72ms → ~0.7ms typical, 13.1ms → ~3.3ms on the
  candle scene."* Unbuilt. On *this* map `light.drawIllum` is 0.275ms, so it is a candle-scene lever,
  not a Town River Bridge one.
- **Merged illumination+coloration MRT draw** — *"0.6–0.9ms typical."* **Built, ships OFF**
  (`vt-pan-viewer.js:12026`, `let pointLightMrtMerge = false;`), never live-verified — and the target
  is allocated in both flag states, so its VRAM is being paid for a feature that is off.
- **Sun-shadow slots 6 → real floor count** — every fragment of the ambient quad *and* every
  point-light material pays 6 dependent texture fetches with no branch and no early-out, regardless
  of floor count, by explicit design. *"~1ms guess, one-constant A/B settles it."* Never run.
- **JS-gate the identity grade stacks** — *"~0.25–0.45ms recoverable, every frame of every scene,
  with byte-identical output."* `grade-present.js:113-127` composes the grade node twice and always
  binds the LUT with no identity check. ~40–65% of `present.blit`, for free.
- **Tight rotated AABB for darkness-region quads** — *"exactly 8× for a square… ~80× for a 1000×50
  line."* `region-geometry.js:443` returns a diagonal-sized box; excess fragments run the shape test
  then `discard()`.
- **Door leaf camera culling** (`frustumCulled = false` project-wide — 34 sites, zero `true`),
  **mask mipmaps** (`mask-image.js:264-265`, `generateMipmaps` never set), **a 4Hz diagnostics
  heartbeat with no visibility gate** running outside every profiler bracket (`boot.js:12612-12617`)
  — *"0.7–6ms landing as a spike on 4 frames per second."*
- **Load-time (seconds, not ms):** BC encode is single-threaded (`compressed-textures.js:82`,
  `MAX_IN_FLIGHT = 1`, one worker) against a claimed *"~1s on 8 threads"*; `loadMaskImageTexture`
  still does a 211MB `getImageData` + 52.7M-iteration loop **on the main thread**.

**Closed — do not re-propose:** per-island specular quads (superseded by the presence gate, which
*beat* it; the live `estimatedIslandWinRatio: 63.6` is a real ratio on a 0.20ms pass — a rounding
error), `ensureItemLoaded` `Promise.all` (measured dead: *"Parallelising those awaits would have
changed nothing on that window"*), RenderBundles (a real 1.80–2.60× **CPU** win, but we are
`gpu-bound` at 92.5% and the probe used 300 quads against this map's 17), and overdraw / alpha-blend
/ `maskNode` / CAS taps (all four measured negligible this same day).

**Also worth recording: the Gap Analysis doc written this morning is already wrong in five places**
(it calls the per-cell split "zero live call sites" when it is wired at `:10530`; calls early-Z
"inconclusive" when two floors both read `pays-for-itself` the same day; calls a fixed blind spot
NOT-STARTED; reports a structure violation that `verify:structure` says is clean; and says the BC
worker pool is 2 when it is 1). Consistent with `[[feedback_holy_docs_go_stale]]`.

---

## 5. THE ANSWER, RANKED

| # | Move | Cost | Predicted win | Confidence |
|---|---|---|---|---|
| 1 | **Foundry "Disable Resolution Scaling" ON → re-run** | **zero code** | GPU 30.8 → ~15.5ms; 30 → 40–60fps | High arithmetic; rests on one untested assumption (is it fill-bound?) — **and the look decision is the author's** |
| 2 | **Add a `solidityMip0` toggle to the shader-variant A/B** | ~20 lines on existing machinery | measures the last unmeasured hypothesis aimed at the 81% | Certain as a measurement |
| 3 | **Surface `earlyZState` counts in the perf report** | small | reveals whether an 18–22ms designed win engages at all | Certain as a measurement |
| 4 | **Fix the water tier gate's non-convergence** | small — a terminal state on the guard | kills an unbounded per-frame rebuild on 2 of 3 floors | **Proven from source + report + traces** |
| 5 | **Field-filter the arity-1 CRUD hook** | one line | 57ms/frame edit bursts | Measured this capture |
| 6 | **Commit the sun-shadow bake throttle** | already written | 25ms/frame edit bursts | Measured this capture |
| 7 | **Split `worldDraw` by drawable class (visibility A/B)** | small, no restart | ends six rounds of guessing | Certain as a measurement |
| 8 | **Fix the `installed === true` finding gate** | ~one line + a non-cheating fixture | un-hides two churn findings that can currently NEVER fire | **Proven** |
| 9 | **`modes === 0` guard on `occlusionAlphaFactor`; DCE the dead shore-foam graph; identity-gate the grade stacks** | small, byte-identical | ~0.3–0.5ms/frame plus dead fetches | High |
| 10 | **Zone precipitation's sync; cache the `clientWidth` read; gate `weather.getStatus()`; cache `backgroundItemOf`** | small | closes a blind spot + ~0.5–1ms of quiet-frame CPU | High |

**Are the dreams dead? No.** We already measure **44.1fps at `low` at full 4K**; the vsync rungs
that matter are 40 and 60, not 45; and the arithmetic says a resolution change alone reaches 40
comfortably and 60 plausibly. What killed the last six investigations was not the absence of a
lever — it was firing narrow A/Bs at a 24.8ms number nobody had ever split, while the single largest
designed win in the corpus sat built, unmeasured, and possibly inert.

---

## What the next live session must answer — in this order, one variable at a time

1. **Foundry "Disable Resolution Scaling" ON, then `perf-run-full`.** Compare `frame.gpuMs.p50`,
   `avgFps`, `geometry.worldDraw`. Then **look at the map** and decide whether the pen outlines
   survive. That second half is the actual decision; the numbers only price it.
2. Whether `worldDraw` falls roughly in proportion to pixel count — the one assumption everything in
   §2a rests on.
3. After any fix to §3a: whether `instrument.cacheStats.waterBodyBakeGate[]` still shows floors 1
   and 2 at `perfTier: 0`, and whether `light.waterSurfaceSync` drops off the top of the CPU zones.

That discipline — one variable, measured, written down — is what made the last six eliminations
trustworthy even though every one of them was negative.
