# B0 — Golden-Scene Expectations per V3 Milestone

**Status:** DRAFT (B0 exit artifact). Companion to [acceptance-scenes.md](../acceptance-scenes.md) (the *how to run* checklist); this file says **what must be observed** at each Stage B milestone, per scene archetype, with the flag on (`__v3Pipeline`) vs off.
**Standing rule:** V2-off runs must be pixel-identical to pre-B baseline at every milestone — the flag isolates all risk. Every "parity" below means the acceptance-scenes.md pass bar (identical within streaming-LOD noise, diagnostics ±10% unless intended).

> **Prerequisite (blocking, user task from A2):** S1/S3/S4/S5 scene names and baseline screenshots are still unfilled in acceptance-scenes.md. B1 cannot claim its exit without them. Also run the five scenes once on `0.5.4.34` first — the §13 fixes were only validated on Mansion variants.

## Per-milestone expectations

### B1 — frame graph + unified albedo + attribute buffer
- **All scenes (V3 on, lighting off):** geometry/albedo parity with V2-with-lighting-off. Authored WebP holes show the floor below (the alpha-rebind invariant, now via depth + alphaTest).
- **S2 Mansion:** both floors + overheads correct from each viewed floor; floor-switch shows no band misassignment. Attribute-buffer debug overlay: R decodes to the expected floor index per region, 255 outside geometry; B bit 0 lights up on roofs/overheads; no LinearFilter-style ID bleeding at floor edges (B0-1 defect 2 must not reproduce).
- **Diagnostics:** V3 pass list + per-pass timings appear in `collectDiagnostics()`; RT pool count is O(1) in floor count for the albedo path.
- **New instrument:** A/B diff command (B0-2 §4) produces a heat map; residual diff confined to known-noise (streaming LOD, dithering).

### B2 — clustered forward lighting
- **S1 (lighting canary):** point/ambient light parity; light drag updates without one-frame swimming.
- **S2:** per-floor light isolation — a ground-floor torch does not light the upper floor through the ceiling; `_perFloorLightSnapshotRts` and stacked-light-buffer entries absent from V3 diagnostics.
- **All:** fill-rate independence spot check — 20+ lights in view at Native res without the per-light cost cliff (compare frame time V2 vs V3 on S2's 20-light set).

### B3 — shadows onto the forward pass
- **S2:** building/painted/skyReach/overhead shadows match V2 per floor; shadow producers still run once (P1), only *application* is per-fragment. Lightning strike re-render (the §12.2 double-render) still works on whichever scene exercises weather lightning.
- **Attr check:** shadow floor-pick consumers (BuildingShadows/PaintedShadow/WindowLight) read `attr.r` — world-space `floorIdTarget` reads gone from V3 frame captures.

### B4 — Class B transparents + fire-glow fold
- **S4 (fire-heavy):** fire glow correctly *under* overhead roofs (this is a **deliberate divergence** from V2 — TODO §7 item 20's "glow above roof" bug must NOT reproduce; record the corrected look as the new baseline). Heat shimmer gated by `attr` matches presence-mask behavior. Candles/dust/ash sort correctly against upper floors (depth-reject instead of mask-gate).
- **S3:** splashes still clipped under the deck (M4 path untouched at this milestone).
- **OIT triggers O1/O2 (B0-3 §3):** explicitly checked and recorded as pass/fail on S2 stairwell + S4 candle clusters.

### B5 — water as geometry (the plank-prison gate)
- **S3 (THE gate):** river below visible through plank gaps, occluded by planks, simulated while viewed from the upper floor; splashes clipped under deck; wave damping honors the water-shelter outdoors mask. Parity against V2 water on S1 (simple shore) *and* S3 before `_resolvePostMergeWaterOccluderRT` machinery is allowed to die. V2 water stays flag-reachable until this passes.
- **Semi-transparent deck edge case (B0-1 §4.1):** a test tile at ~50% alpha over water — record V2 vs V3 behavior; V3 must not be *worse* (binary pop where V2 soft-occluded).

### B6 — mask residency / SVT
- **S5 (144 MP + 3-floor):** fixed mask budget honored (report shows cap, not `O(world)`); pan/zoom shows only known-LOD popping; no `webglcontextlost` on the 8 GB laptop at High.

### B7 — flip and delete
- **All five scenes:** V3 default-on parity sweep; §14.2 memory target (<1 GB total GPU @1080p per diagnostics) on every scene; V2 per-level pipeline files deleted; LOC and crash-report RT counts materially down. Soak: author plays a real session per archetype before the release that removes the flag.

## Recording
Each milestone gets rows in acceptance-scenes.md §4's run log (date, scenes, V2-off check, V3-on results, diff-heat-map notes, diagnostics snapshot). A milestone is not "done" until its rows exist — same discipline as §13's "no fix without an instrument naming it."
