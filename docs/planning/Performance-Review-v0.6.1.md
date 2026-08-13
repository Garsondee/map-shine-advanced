# Performance Review — v0.6.1 baseline

**Status:** designated baseline, by author instruction · **Captured:** 2026-08-13T17:54:36Z (4 minutes
before the `Release 0.6.1` commit, 9d9c76c) · **Raw data:** `docs/planning/perf-reports/2026-08-13-v0.6.1-baseline.json`
· **Conditions:** bench Mansion, Ground floor primary + First Floor comparison, 3840×1906 @ 1.5 DPR,
60s north-to-south touring route (`n_to_s:2kf/60000ms`), 3376 frames.

This is the reference point every future `perf-run-full` capture should be read against. The report's
own `msaVersion` field reads `0.6.0-dev.0` because the capture predates the version-bump commit by
minutes — not a tool defect, just a timing coincidence. This file is what makes the v0.6.1 link explicit.

---

## 1. Headline

Ground floor, the run's primary subject, is **healthy**: 57.8fps average, GPU-bound (the GPU is the
bottleneck, not CPU coordination), zero hitches/stalls/freezes across a full minute of touring, VRAM at
46% headroom. If this were the whole story it would be an easy green light.

It isn't. The same report's own multi-floor comparison — a secondary section, not the headline — shows
**First Floor runs at essentially half the framerate** (30.5fps vs 57.8fps avg, GPU p50 31.39ms vs
15.93ms). That gap, and its likely cause, is the single most important thing in this report and it does
not appear anywhere in the top-line "top offenders" list, because that list is Ground-floor-only.

## 2. Where the frame actually goes (Ground floor)

One cost dominates: `geometry.worldDraw` (the main scene draw — floor art, tiles, everything the camera
sees painted in one pass) is **8.904ms of every 16.7ms frame — 55.9%** of the whole frame's GPU budget,
from 13 draw calls / 266,398 triangles. Everything else in the top-10 is small change by comparison — the
next nine items combined don't add up to one worldDraw.

`attribution.verdict: "good"` (92.4% of the frame's GPU time is accounted for in named zones) — this
breakdown is trustworthy, with one caveat (§4.1).

## 3. The real finding: First Floor vs Ground Floor

From `multiFloor.ranked`:

| Zone | Ground (floor-0) | First Floor (floor-1) | Ratio |
| --- | --- | --- | --- |
| `geometry.worldDraw` | 8.904ms | 12.492ms | 1.40× |
| `geometry.depthDraw` | 0.722ms | 6.866ms | **9.51×** |
| `geometry.earlyZPrepass` | 0.66ms | 6.446ms | **9.77×** |

`geometry.depthDraw` builds the depth-authority buffer every other occlusion/height-gate system queries
([[keyhole-depth-authority-sole-system-decision]] — the sole occlusion system by design).
`geometry.earlyZPrepass` is Stage 1's "shade once" optimisation (Testament S1.6) — a second, cheaper
submission of the same opaque geometry to buy early-depth rejection in the real shading pass. Both being
~10× more expensive on First Floor, while the main `worldDraw` only grows 1.4×, points at something
specific to what's being submitted into those two passes on that floor — not a general "First Floor has
more stuff" story, since the pass that would show that most directly (`worldDraw`) barely moved.

**Not yet known:** the exact mechanism. `multiFloor.ranked` is a top-25 comparison, not the full
second-floor report — `MapShine.getMultiFloorReport()` from the console gets the rest without paying for
a second capture. That full report is the direct next step before guessing further.

## 4. What I'm suspicious about

### 4.1 — The instrument hit its own ceiling this run
`instrument.gpuTimer.poolOverflowed: true`, `maxPendingSize: 2020` against a cap of 1024. Past that
point in the window, zone GPU numbers go missing rather than reading zero — so the numbers above,
including `worldDraw`'s 8.904ms, are probably a slight undercount, not exact. `attribution.verdict` still
reads "good" (92.4% coverage), so this doesn't invalidate the picture, but it's worth knowing the ceiling
exists. Cheap fix: raise the pool size, or keep captures under whatever frame count keeps it under 1024
outstanding passes.

### 4.2 — `getGeometryComposition()`'s own numbers don't reconcile
Built this same week (Testament Track B.1) specifically to answer "what's actually in the biggest draw."
This run: 4 meshes, 2,130 triangles total (`tile` + `levelBackground` only). The zone sitting right next
to it, `geometry.worldDraw`, reports **13 draw calls and 266,398 triangles for the same pass** — a ~125×
gap. The tool only walks a closed list of VT item kinds (`tile`/`levelBackground`/`vegetationOverlay`/
`token`) and explicitly counts anything else as `unresolvedItems` rather than dropping it silently — but
this run shows zero unresolved items and zero of the other kinds too, which doesn't square with a pass
that's clearly drawing far more geometry than 4 meshes' worth. Built in good faith; not trustworthy yet.
Needs walking down before the next "what's heavy inside worldDraw" claim leans on it.

### 4.3 — The p95 tail's "unexplained" 5.21ms might just be §4.1
`bottleneck.tail.verdict: "mixed"` (79.2% explained vs the median's 95.4%) is real and worth investigating
either way, but given the timestamp pool overflow above, some — maybe most — of that gap could be
missing samples rather than a genuine separate CPU-side cost. Can't separate the two from this data
alone; the report itself says the same ("three candidates, not one").

### 4.4 — The early-Z A/B came back inconclusive on THIS scene specifically
`structuralAB.toggles[0]` (earlyZComposition): delta -0.125ms against a 0.103ms noise floor — under the
required 1.5× significance bar, so "could not tell," not "no difference." Testament history matters here:
the previously-measured 1.55× win (~19% net) for this same mechanism (S1.6, P-008) was measured on "the
far lighter First-Floor scene" per the Testament's own words — i.e. a *different, lighter* test than
today's full touring route. This run's inconclusive result on the heavier route is a genuinely open data
point, not noise obscuring an already-settled answer. `diag/perf-structural-ab.js` already exists to
re-run this cleanly (Testament, 2026-08-12) — needs an idle machine or more measured frames.

## 5. What's already known-good (don't re-litigate)

- **Uniform buffer growth** (1118→11568, 10.35×) — already confirmed benign for a touring route by a
  dedicated parked-camera test the same day; only worth a second look on a window that was NOT touring
  new ground.
- **Depth-proxy material pool** — 100% hit rate, 10,450 hits / 0 misses. Reusing materials correctly.
- **`geometry.depthDraw`'s own historical "unexplained outlier" flag is resolved** (Testament, a labelling
  bug where GPU time landed on the wrong zone — fixed; the attributed total was always correct, only the
  label was wrong).
- **The `duplicate-geometry` pairing of `depthDraw`+`earlyZPrepass`** is a known, previously-flagged
  shape (Testament names an earlier, much heavier capture of the same pair) — the two passes serve
  different purposes (depth-authority buffer vs. early-Z rejection) and submitting the same source
  geometry to both is expected, not obviously wasteful. The `light.drawPointLights`+`light.drawColoration`
  pairing is the same story: two channels (brightness vs. tint) of the same batched-light draw.
- **Rapid panning recovered cleanly this run** — `rapidStressSweep.recovery.elapsedMs: 0`, only 1 hitch in
  the whole 4.6s stress sweep. Doesn't reproduce the multi-second felt hitch from earlier reports under
  these specific conditions; doesn't rule it out under others.
- **Residency streaming** — the release notes for 0.6.1 itself cite a "677× residency-streaming
  reduction" already shipped. This run's residency zones all read small/sparse (little new content
  streamed in during a revisit-heavy touring route), consistent with that fix holding, not evidence the
  system is now free of risk — see §6.4.

## 6. Ranked priorities

1. **Find out why First Floor's depth-authority and early-Z passes cost ~10× Ground floor's**, when the
   main scene draw only costs 1.4× more. Pull `MapShine.getMultiFloorReport()` for the full picture; this
   is the single biggest, most concrete, most actionable lead in the whole report and it's invisible
   unless you go looking for it.
2. **`geometry.worldDraw` is the single largest individual cost on both floors**, but its SHARE of the
   frame shrinks on First Floor even as its own ms rises — 55.9% of Ground floor's frame vs only 39.8% of
   First Floor's, because `depthDraw`+`earlyZPrepass` together (13.312ms) actually outweigh `worldDraw`
   itself (12.492ms) there. Any real global win still starts with `worldDraw` since it's the biggest single
   line either way — fix §4.2's diagnostic before trusting it, then use it (once trustworthy) plus a
   WebGPU Inspector capture to find out what inside that draw is actually expensive — the standing Track
   B plan.
3. **Re-run the early-Z on/off A/B on an idle machine**, specifically on the full touring route (not just
   the lighter scene it was previously proven on). The tool already exists; this run's attempt just
   couldn't clear its own noise floor.
4. **Design a capture that deliberately stresses residency streaming** (touring genuinely new content,
   not revisiting loaded ground) before trusting that it's no longer a concern — this run's quiet
   residency zones are evidence the 0.6.1 fix is holding under THESE conditions, not proof the system has
   no remaining cost anywhere.
5. **Small, free fixes**: raise the GPU timestamp query pool ceiling above 1024 (§4.1) so long captures
   stop silently losing samples; look at why `describeRenderMode`'s diagnostic-panel cache is only
   hitting 41.5% of the time (low stakes — debug panel only — but cheap to check).

## 7. What NOT to do yet

Don't act on §4.2's diagnostic numbers for anything real until it's been walked down — it would be easy
to mistake "4 meshes, 2130 triangles" for "there's almost nothing in the main draw" and go looking for
cost somewhere else entirely, when the much more likely explanation is the tool undercounting what's
really there.
