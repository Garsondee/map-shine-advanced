# MSA Lab: friction log

Ingram asked (2026-11-08) that, while building the lab, I record every frustration or limit of the
current approach, so we can plan easier ways round them. One entry per snag: what happened, what it
cost, and what would remove it. Newest at the bottom. Mark an entry **fixed** with the commit when it
stops being a problem.

| # | Snag | Cost | What would remove it |
|---|---|---|---|
| 1 | A page reload lands on the world's *active* scene, not the one I was viewing. | A confusing wrong-scene screenshot and several minutes. | Activate lab scenes (done for the rig, memory saved). `lab.mjs seed` should activate the Effects scene on the rig itself. |
| 2 | No single "Measure view". Neutral camera means switching off Dynamic Range, bloom, lens, grade and stylize one by one, and `forceEffect('lens', false)` leaves the lens vignette in place. | Many calls, and frames that still aren't neutral. | One unsaved lever, e.g. `MapShine.lab.measure(true)`: locks exposure, flat grade, no bloom, lens or vignette, no grid. Plus an honest readout of what's still on. |
| 3 | Exposure keeps adapting while I measure. The same spot read 110, 115, 117 and 122 across a minute. | Numbers from different moments aren't comparable. | A "camera settled" signal, or a fixed exposure in Measure view. |
| 4 | Turning the lens on or off moves the whole picture on screen, so fixed screenshot pixels sample the wrong thing. I sampled a gutter and thought the wedge was missing. | A false lead. | Always sample by world point. A helper that takes world points, maps them through the live camera and reads the screenshot. |
| 5 | **Fixed beab8187 (probe v2):** `MapShine.probePixels` leaves its crosshair markers on screen, and they end up in later screenshots. | Dirty frames. | A `{markers: false}` option, or clear the markers before `shot --clean`. |
| 6 | **Fixed beab8187 (probe v2):** MSA said "ready" while the screen showed a stale frame: Lens switched off left present reading Lens's last output (mmp-78u.7). `settle` checks work queues, not the picture. | The worst kind of false confidence. About 20 calls to pin down. | A "screen matches lit buffer" check: probe a few points, compare with the screenshot, flag drift above a few levels. |
| 7 | Painting 9000 × 6750 floors at WebP method 6 took 9 minutes. | Slow rebuilds. | Fixed: method 4 takes about 1 minute, with the same 128 accuracy. |
| 8 | Foundry's padding offset isn't the naive `ceil(0.25 · w / grid) · grid` (2400, not 2250). | Would have misplaced every wall. | Fixed: the builder reads `scene.dimensions` after create. |
| 9 | Looking at one plot takes about 5 calls (pan, wait, shot, probe, sample). | Slow, and each call is a chance to sample wrongly. | `lab.mjs look <plot> [--view measure\|shipped]`: pan to the plot, settle, shoot, probe its probe points, print a table. |
| 10 | Bisecting "which effect draws this" means a shot per effect and a careful metric (centre-minus-outside was confused by the vignette). | About 30 calls for one answer. | `lab.mjs bisect <plot> --metric edge\|mean`: toggles each effect off, measures, restores, ranks. |
| 11 | **Fixed beab8187 (probe v2):** Probes read right after an effect toggle can return garbage mid-rebuild (lit read 0.488 against a steady 0.184). | A false "grade/doorGraphics change lit" lead. | Probe several frames apart and keep only stable reads; `bisect` must wait for settle after each toggle. |
| 12 | Probe markers persist between calls and land on later probe points (they last 30 s). | Wrong readings for the brightest wedge steps. | Fixed in `look`: the clean-shot style hides `[data-msa-probe-overlay]`, and the shot is taken before probing. |
| 13 | Turning MSA's Grid off hands the lines back to Foundry's own grid mesh, so the grid never disappears. | Grid lines cross every probe area. | Fixed in `look` for Measure view (hides Foundry's mesh too). A real Measure lever should own this. |
| 14 | After a rebuild, the sun eases toward the pinned hour for a while, so early frames read darker (lit 0.161 against 0.184 settled). | Two "as shipped" numbers that disagree. | A settle check that includes the sun and sky ease, or `immediate` when the lab sets its sky. |
| 15 | `lab.mjs look` now does pan, settle, clean shot, probe and table in one call (closes most of #4, #5, #9). | — | Next: `bisect`, and a real in-module Measure lever. |
| 16 | **Fixed beab8187 (probe v2):** `MapShine.probePixels` answers at most 3 points per call, silently dropping the rest. | A 4-point bisect returned 3 values with no warning. | `look` batches in threes; the probe should say it truncated, or take any number. |
| 17 | I asked Ingram what an effect was instead of finding out (the halo, the bright room). | Her time. | Rule saved: investigate on the rig and compare with her modern maps first; only taste calls go to her. |
| 18 | Presented values drift between looks taken minutes apart (room centre 33 then 49) even in Measure view. | Can't compare looks without knowing what moved. | A settle that includes exposure (see #3), and `look` should log the camera state with each table. |
| 19 | Probe v2 returns buffer values for OFF-SCREEN points (read from a clamped edge pixel), so a point just off the view gives a confident wrong number. | One false "the pattern wall reads 1.0" lead. | Probe should null the buffers for off-screen points (it already knows `onScreen`). Upgrade candidate. |
| 20 | **Fixed (look waits on getSceneReady):** The first look after building a scene caught the "Warming up" screen; a fixed wait is not enough when new masks arrive. | A wasted screenshot. | `look` should wait on `MapShine.getSceneReady()` before shooting. |
