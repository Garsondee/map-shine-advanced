# 2026-08-25 — Town River Bridge, Roof floor — live perf sweep

Companion synthesis to `2026-08-25-town-river-bridge-roof-sweep.json` (condensed archive of the
full `perf-run-full` report pasted into chat this session). Full uncondensed JSON lives in that
session's transcript if a field here needs the original.

**Scene:** `modules/mythica-machina-town-river-bridge` (Tower Bridge Town/River map), floor index 2
("Roof"). This is **not** the internal `msa-bench` Mansion — asset paths and mask filenames
(`Tower_Bridge_Underground_Water.webp`, etc.) point at what reads as real product-map content.
Captured at Ingram's own reference resolution: 3840×1906, DPR 1.5 (`project-mission-and-hardware`).

## Headline

- **26.6 fps avg / 41.5ms median frame** (p1-low 23.9fps) — well under the 60fps locked target.
- **GPU-bound, cleanly**: 85.9% of the median frame and 87.3% of the tail is explained by
  timestamped render passes (`attribution.verdict:'good'`, 95.8% coverage) — this is a trustworthy
  breakdown, not a guess.
- **Remarkably stable pacing**: frame times sit in a 41.5–41.8ms band for the whole 180-frame
  window, only 1 hitch >50ms. This is a *steady, identifiable* cost, not a stuttering mess.
- **`geometry.worldDraw` is 70.4% of the frame** (25.11ms of 35.65ms GPU) from just 28 draw calls —
  low draw-call count + huge per-draw cost is the exact fill-rate/overdraw signature
  `keyhole-performance-audit-2026-08` diagnosed on the 12K Mansion floor before coverage meshing.
- **`geometry.worldDraw` (25.11ms) sits at the OLD historical ballpark (26.6ms), not the ~2.9ms
  post-coverage-mesh/Early-Z number** the V4 Testament's Stage 1 gate measured on Mansion Redux
  content. Whether Stage 1/coverage-meshing is actually paying off on THIS map's content is now
  the single highest-value open question — see finding below.
- **Window light: 2.486ms, 5.67× its own declared budget (0.34 vs 0.06 ms/Mpx)** — first real
  measurement ever taken against that budget (`declared.verdict` had never resolved before this
  run). Fully and cleanly zoned (`zoneCoverage:'full'`), so this number is trustworthy, not partial.
  Closes the data half of Testament Pillar 2's open "window light LIVE" checklist item — with a
  number that says tune it, not check it off.
- Confirmed whole-map, not Roof-specific: floor 1 and floor 2 read near-identical worldDraw
  (25.11ms vs 25.123ms) in the independent multi-floor comparison pass.
- Under rapid camera movement, both of the above get worse: worldDraw 25.11→28.629ms, window light
  2.486→3.414ms, 2 hitches appear (vs 0 steady), p1-low fps drops 23.9→20.

## What's fine (no action needed)

Bloom (0.463ms, 21% of its declared budget), Depth of Field (0.353ms, 32%), door graphics
(0.001ms) are all comfortably under their declared costs. The declarations themselves read as
stale/pessimistic for these three, not the implementations being a problem.

## Open questions / structural gaps (not this run's fault, standing)

- **Early-Z composition A/B came back inconclusive on this map** (`liveState:true`,
  `verdict:'within-noise'` — ON/OFF delta 2.534ms vs a 2.452ms noise floor, didn't clear the
  required 1.5×). This is the exact lever the Testament's Stage 1 gate was built around; on Mansion
  Redux content it measured a confirmed 1.55× win on `geometry.worldDraw`. Here, with worldDraw at
  70% of the frame, nobody currently knows if it's helping, hurting, or neutral. Report's own
  recommendation: re-run on an idle machine or with more measure frames before concluding either
  way.
- **fire, grade, water, apertureGobo still can't be individually priced** — each draws inside a
  shared scene/material with no bracket of its own. Named as a standing instrumentation gap in
  `project_perf_instrumentation_buildout_2026-08-12`; unchanged this run.
- **`describeRenderMode` diagnostic cache: 37.1% hit rate** (49 hits/83 misses) — its invalidation
  key looks like it's changing more often than the underlying content does. Diagnostic-only, not
  render-path, so low urgency.
- Two duplicate-geometry pairs submit identical draw shapes twice (`geometry.depthDraw` +
  `geometry.earlyZPrepass`, same 15 draws/8542 triangles; `light.drawPointLights` +
  `light.drawColoration`, same 10 draws/614 triangles). Same open question as the Early-Z A/B above
  — can't tell from zone data alone whether the second submission earns its keep.

## Links

- [[keyhole-performance-audit-2026-08]] — the fill-rate/overdraw signature and coverage-meshing
  history this report's #1 finding connects to.
- [[project_perf_instrumentation_buildout_2026-08-12]] — why fire/water/grade/apertureGobo can't be
  priced yet.
- `docs/holy/V4-Testament.md` Stage 1 ("Shade every pixel once") — the Early-Z gate this map's own
  live A/B just came back inconclusive on. Pillar 2 — window light's open "LIVE" DoD item.
