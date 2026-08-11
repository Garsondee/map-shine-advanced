# Residency Streaming Audit — 2026-08-11

Full-length record for the Testament P-008 addendum. Requested by the author directly: "Launch a
full investigation into Residency streaming too... Full audit looking for performance pain points
and looking for ways to win back as much performance as possible."

**Method, stated honestly:** four parallel research agents (general-purpose, read-only, no edits)
each took a distinct slice of the residency system — phase 1's per-item load path, the frame
profiler's own timing semantics, the decode/cache/worker layer, and everything else in the pass
(outer orchestration, pre-phase steps, phase 2, stale-item cleanup). Their reports converged and
cross-corroborated independently on the central finding below without being told to look for it.
One claim central to that finding (the drawCalls/triangles sampling in `frame-profiler.js`) was
independently re-verified by direct reading before being written here — everything else rests on
four-way agreement across agents that were each given the same "cite file:line, flag uncertainty,
don't guess" brief and worked from the live tree independently.

---

## 0. A correction to P-008 first, because it changes how to read everything below

P-008 (same session, commit `bbd83e0`) called residency streaming *"the single largest **CPU
cost**"* in its headline and computed *"29.2% of ALL **wall-clock** time"* — both true individually,
inconsistent together, and the inconsistency matters. This audit resolves it:

**`residency.pass`/`residency.itemLoad`'s reported time is wall-clock elapsed time between a
`profiler.begin()` and a `profiler.end()` call, with zero adjustment for CPU-busy vs. idle-waiting
— confirmed directly in `src/diag/frame-profiler.js` (`openSlot`/`closeSlot`, `now() - start`, no
thread-time API, no suspension detection).** The loop it wraps (`updateResidencyUnguarded`'s phase
1, `src/vt/vt-pan-viewer.js:10798-10839`) is a sequential `for...of` with `await ensureItemLoaded
(item)` inside — and that `await` genuinely suspends for real network/IndexedDB round trips. Both
bracket call sites already say so in their own comments (`vt-pan-viewer.js:10783-10785`,
`:11052-11056`: *"WALL time, not pure CPU-busy time"*), and a prior, more careful audit
(`Performance-Audit-2026-08.md` §14, filed 2026-08-09 — two days before P-008) already reached this
exact conclusion with independent evidence. P-008 should have cross-referenced it and didn't.

**This is not "residency doesn't matter after all."** It fires on 462 of 463 frames, it is real, and
it is the biggest unowned system in the engine. What changes is the *shape* of the fix: this is a
**latency/scheduling problem** (how many sequential round-trips does loading incur, and can they
overlap), not a **CPU-speed problem** (nothing here needs "faster JS"). Reading it as the latter
would send an optimization effort at the wrong target.

**A second, sharper correction, found investigating the first one:** the reason `residency.itemLoad`
carries real-looking `drawCalls: 365.1` / `triangles: 428448.2` in the report — despite being a
zone declared `kind:'cpu'` with no draw calls of its own — is a genuine instrumentation artifact,
not a real cost of this zone. See §2.

---

## 1. The real shape of the cost: sequential I/O, not computation

`ensureItemLoaded` (`vt-pan-viewer.js:6110-6190`) has two branches, confirmed by direct code
reading, not inference:

- **Already-loaded item** (`existing` branch, 6111-6133): a `Map.get`, a field overwrite, and — for
  a multi-tile whole-image item — a loop over its (small, device-limit-bounded) tile list. **No
  `await` anywhere in this branch.** Genuinely O(1)-ish, sub-millisecond.
- **Genuinely new item** (6134-6190): two sequential, *real* I/O awaits — `getSourceDimensions`
  (a ranged HTTP fetch for the image header, `decode-pool.js:594-620`) then `loadExtraLayerPacks`
  (6168), which itself loops **sequentially** over that item's own mask layers (Outdoors, Fire,
  Specular, Windows, …), each mask paying its own dims-fetch + IndexedDB-backed page acquisition
  (`buildPack`, 5927+). A single new item with *k* masks pays **1 + 2k sequential round trips**
  minimum before it's usable.

The outer loop (`vt-pan-viewer.js:10798-10839`) awaits this **one item at a time** — no `Promise.
all`, no batching. The mask loop inside `loadExtraLayerPacks` (6072-6106) does the same, one level
down. Neither loop uses the concurrency the decode pipeline already has available: `decode-pool.js`
defines `SLICE_MAX_CONCURRENT_SOURCES = 3` (line 113) and a real semaphore (`_sliceSem`), currently
sitting unused by both loops. This exact gap was independently identified once already, two days
earlier (`Performance-Audit-2026-08.md`), and deliberately left unfixed at the time for the reason
in §5.

**What determines the 31.668ms mean is therefore mostly "how many NEW items appeared in that
particular pass," not a fixed per-pass tax.** The report handed to this audit did not include the
two finer zones built specifically to answer that (`residency.itemLoadDims`/`itemLoadMasks` —
`perf-zones.js:908-932`) — without them, this audit **cannot** tell whether the mean is a steady
cost across all 462 passes or a few expensive early passes dragging the average up. This is the
single highest-value number to pull from the next capture (see §7).

---

## 2. The measurement artifact: why a loading zone shows draw calls it can't have

Traced end-to-end, not inferred from the odd number alone:

1. `residency.itemLoad`'s bracket (`vt-pan-viewer.js:10798/10838`) wraps a loop that genuinely
   suspends on `await` (§1).
2. `scheduleResidencyUpdate()` — the sole entry point — is invoked **fire-and-forget** from pan
   handlers (`.catch(...)`, never awaited by the render loop itself, e.g. `vt-pan-viewer.js:11114,
   11224`). The render loop (`renderer.setAnimationLoop(renderFrame)`, `:11737`) keeps ticking
   independently while a residency pass is mid-flight.
3. `frame-profiler.js`'s `openSlot`/`closeSlot` (verified directly, lines 209-243 and 265-299)
   sample `readDrawCalls()`/`readTriangles()` **unconditionally at every zone's begin/end, with no
   check of that zone's declared `kind`** — confirmed by direct reading, not agent report:
   ```js
   // closeSlot(i):
   if (readDrawCalls !== null) {
     const d = readDrawCalls() - openDraws[i];
     if (d >= 0) { drawSum[i] += d; drawCount[i]++; }
   }
   ```
   Those callbacks read `renderer.info.render.drawCalls`/`.triangles` directly — three.js's own
   counters, which its internal `Info` object resets every real animation-loop tick (`autoReset`
   defaults `true`, never overridden in this codebase).
4. So: a `residency.itemLoad` occurrence that suspends across one or more real rendered frames
   samples `readDrawCalls()` at two essentially arbitrary points in two *different* frames'
   independent zero-based counting cycles. The delta is not "draws this zone issued" (it issues
   none — it's declared `kind:'cpu'`) — it's "however many draws some unrelated frame(s) happened
   to issue while this bracket sat open." That lands in a plausible-looking range (the reported
   365.1/428,448.2 matches what one real frame's totals could look like), which is exactly why it
   reads as data instead of noise on casual inspection. `closeSlot`'s own `if (d >= 0)` guard
   silently drops the more obviously-wrong *negative* deltas rather than counting them, which
   biases the reported numbers toward the contaminated-but-plausible-looking samples.

**Consequence, stated plainly: `residency.pass`'s wall-clock time genuinely overlaps normal frame
rendering for at least part of its span — it is concurrent time, not proven-exclusive main-thread-
blocking time.** P-008's "29.2% of wall-clock time" is real and is not nothing, but it should not be
read as "29.2% of the frame budget was stolen from rendering," because the artifact above is direct
evidence that rendering kept happening during much of that window. The honest position is: this
system costs real, measured wall-clock latency and is worth optimizing, but exactly how much of
that latency is truly exclusive vs. concurrent-with-rendering is **not yet known** — see §7.

**This is a real, cheap-to-fix instrument bug**, independent of anything else in this report — see
§6, item 1.

---

## 3. What's cheap now, and what only looks cheap because the test scene is small

Everything outside phase 1 totals roughly **0.46ms mean, combined**, in the captured run (462
occurrences) — genuinely negligible today. But two of these paths have a cost model that does not
match their trigger frequency, which will not stay invisible on a bigger map or a longer session:

- **`refreshCoarsePinBudget()` and `primeCoverAlphaGrids()` are provably invariant to camera
  movement, yet re-run on every single camera-driven pass.** Both are, by construction, functions
  of the scene's *documents* (tiles/tokens/levels), never of the current view — confirmed by
  reading `computeVisibleFloorIndices` (pure function of `(floors, viewedIndex)`,
  `active-scene-source.js:280-288`) and `refreshCoarsePinBudget`'s own loop, which iterates **every
  floor**, not the viewed one (`vt-pan-viewer.js:5906-5923`). Their own code comment already says as
  much (`perf-zones.js:814-819`: *"both iterate items independent of the current draw list"*) —
  it just hadn't been connected to "and yet run on 100% of camera-only passes" before now. Cost is
  O(floorCount × total tiles/tokens in the scene) and O(total cover items in the scene)
  respectively, paid fresh every pass, currently cheap only because the bench scene is small.
- **The stale-item release loop scans `itemStates` in full every pass — and `itemStates` only ever
  grows.** Confirmed by grep: exactly one mutator (`itemStates.set`, `6187`), zero deletions,
  anywhere in the file. This is a deliberate "hide, never dispose" design (a floor switch-and-back
  must stay free), but it means the loop's cost is O(every distinct item ever loaded this session),
  not O(current floor) or O(total scene) — a number that can only climb as a GM tours a large
  multi-floor map over a long session.
- **`rebuildSceneDepthProxies`'s mesh rebuild is still wholesale every pass** (only the *material*
  is pooled now, per DEFERRED-S1b, confirmed holding: `pipelineStats.programs: 84→84` in P-008's own
  capture). Already tracked with its own proposed fixes in `Trace-Analysis-2026-08-11.md` §2a —
  not re-litigated here, flagged only because it compounds with the frequency problem below.

**Neither of the first two has a real number attached (item/tile/token counts for the actual
production scene were not available to this audit) — see §7's open questions.**

---

## 4. Root cause of "fires on 462 of 463 frames"

`scheduleResidencyUpdate`'s do-while + in-flight guard (`vt-pan-viewer.js:11043-11075`) is
correctly designed against *concurrent* passes — proven necessary live (its header names a real,
previously-shipped pin-leak from six call sites that used to bypass it). But it has no minimum
interval and no batching between *sequential* triggers: a pass finishes, and if anything marked
`residencyDirty` during its run, the next one starts immediately with no gap, for as long as the
camera keeps moving.

The trigger itself, `syncFoundryCamera()`'s dirty check (`vt-pan-viewer.js:9973-10022`), gates on a
**1 screen-pixel** camera-delta threshold. That threshold is correctly tuned for the specific bug it
was built to fix (`9993-10008`: Foundry's eased camera kept reporting movement for seconds after the
user let go, from sub-pixel zoom easing — "236 passes for a view that is not moving"). During
*genuine* deliberate panning, the camera moves far more than one screen pixel almost every frame by
construction, so this threshold provides close to zero throttling in exactly the scenario this
audit is about. It answers "is the camera perfectly still," not "did the page/item set residency
actually cares about change enough to justify redoing the work" — two different questions with
different natural thresholds.

---

## 5. The still-open mystery: 20 worst hitches, zero decode/cache activity

P-008's captured report's 20 kept worst hitches (250ms–667ms, spread across the *entire* 40-second
tail of the run, not clustered) all carry near-identical `decodeStats`/`cacheStats` snapshots
showing **zero fresh decoding, zero cache evictions/misses, a decode worker that was never even
created.** This rules out mask-page streaming as the cause of those specific hitches — whatever is
stalling the main thread for a quarter-to-two-thirds of a second at those moments, it is not waiting
on network or IndexedDB I/O.

This audit could **not** identify the mechanism from static code reading. The cache-hit fast path
(`ensureItemLoaded`'s `existing` branch) and phase 2's dirty-checked refresh path
(`refreshWholeImageItem`, gated on `placementChanged`) both read as genuinely cheap when nothing
changed — no smoking gun found there. Two real, unconditional, currently-small per-pass costs exist
outside decode/cache (§3's two items) but sum to under half a millisecond per occurrence in this
capture, nowhere near 250-667ms.

**Honestly unresolved — flagged, not guessed at:** whether these hitches are (a) an artifact of
§2's wall-clock-spans-multiple-frames mechanism catching unrelated frame-render time, (b) a GC
pause, or (c) something structurally outside `updateResidencyUnguarded` entirely. Resolving this
needs a live Chrome trace correlated against `hitchLog` timestamps and residency in-flight windows
— the project already has the tooling for exactly this (`tools/trace-analyze.mjs`,
`chrome-performance-traces/`), just not yet pointed at this specific question.

---

## 6. Optimization menu — risk-tagged, ordered by what to do first

**1. Fix the drawCalls/triangles sampling artifact (§2). Cheap-safe, diagnostics-only, zero
runtime behavior change.** Either stop sampling `readDrawCalls`/`readTriangles` for zones not
declared `kind:'gpu'`/`'both'` in `frame-profiler.js`'s `openSlot`/`closeSlot`, or suppress/zero
those fields for `'cpu'`-kind zones at the report layer. This has already misled two separate
investigations (the 2026-08-09 audit and, briefly, this one) into treating a measurement artifact as
a real signal — worth closing so a third investigation doesn't re-spend the time. **Do this first,
before trusting any zone's drawCalls/triangles numbers in future reports.**

**2. Pull the missing numbers before deciding what to optimize next. Cheap-safe, zero code change
— run existing tools, read existing fields.** Specifically: `residency.itemLoad.maxMs` and the
`itemLoadDims`/`itemLoadMasks` occurrence counts from a fresh `perf-run-full` (resolves "steady tax
vs. front-loaded burst," §1); `itemStates.size` / `documentSync.itemCount` from a live
`getDiagnostics()` pull, not a perf report (resolves real item-count scale, §3); whether the 20
worst-hitch windows temporally overlap an in-flight residency pass at all (§5, needs
`tools/trace-analyze.mjs` against a fresh Chrome trace taken during a repeat of this exact route).

**3. Gate `refreshCoarsePinBudget`/`primeCoverAlphaGrids` to document-change triggers instead of
every camera pass (§3). Moderate — logic is sound from static reading, needs live verification
before shipping, not proof-by-code-reading alone**, per this project's own standing rule that a
defensive fix needs the same proof as the bug. Both are provably camera-invariant; a real
document-hook entry point already exists (`refreshItems(hookName)`, `vt-pan-viewer.js:14234`) to
route them through instead.

**4. Parallelize the sequential per-item / per-mask await chains in phase 1 (§1). Larger potential
win, real documented risk — do not attempt without live Foundry access to visually verify.** The
concurrency headroom already exists unused in `decode-pool.js` (`SLICE_MAX_CONCURRENT_SOURCES=3`).
This exact suspension point has caused two real, previously-shipped live regressions when touched
before (a vegetation render-order flicker; a whole-screen magenta regression from two residency
passes racing on shared pin state) — both are named, with fix commits, in the surrounding code
comments. Needs a dedicated session with a live scene open, not a benchmark-only change.

**5. Coarsen the camera-follow dirty threshold beyond 1 screen-pixel, or add a short trailing
debounce specific to the continuous-pan trigger path (§4). Risky — this project has been burned
before by mis-sized tolerances in exactly this neighborhood** (the 1px threshold itself exists to
fix a prior regression; an earlier, coarser debounce was already tried and reverted for making
panning "laggy and awkward" per its own removal comment). Any change here needs real playtesting
against actual page/tile granularity, not a guessed constant.

**6. Bound the stale-release loop to items that actually just went stale** (track the previous
pass's wanted-id set, diff against it) instead of scanning all of `itemStates` (§3). **Moderate** —
same "pin/visibility bookkeeping has a real bug history" caution as #4, lower urgency since it's not
costly yet at this scene's scale; worth doing opportunistically alongside #3, not urgently on its
own.

**Not re-litigated here, already tracked elsewhere:** `rebuildSceneDepthProxies`'s wholesale mesh
rebuild (options already proposed in `Trace-Analysis-2026-08-11.md` §2a).

---

## 7. Open questions requiring live data, not further code reading

- `residency.itemLoad.maxMs` and `itemLoadDims`/`itemLoadMasks` occurrence counts — resolves
  steady-tax vs. front-loaded-burst (§1).
- Real `itemStates.size` / `documentSync.itemCount` for an actual production scene, not just the
  small bench fixture — resolves how much §3's two O(total-scene) costs actually matter today.
- Whether the do-while's 462 `residency.pass` occurrences are mostly fresh top-level entries or
  mostly same-call re-iterations — not separable with current instrumentation.
- Whether the 20 worst hitches temporally correlate with an in-flight residency pass at all, or are
  unrelated (§5) — needs a Chrome trace, not a perf report.
- Whether view-tier mask pages are ever requested during a realistic session (`pinnedView: 0`
  throughout this entire capture) — plausible for a pan-only route that never zooms in, unconfirmed
  as expected vs. a separate gap.

None of the above are guesses standing in for measurement — they're the specific next reads that
would turn this audit's remaining uncertainty into fact.
