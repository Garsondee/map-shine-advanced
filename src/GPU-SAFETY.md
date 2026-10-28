# GPU safety — how a shader is kept from taking the GPU down

Epic `mmp-fpu`, 2026-10-27. Read this before adding a per-frame effect, a wind consumer, or anything that makes a shader bigger.

## What went wrong

A cold load of one scene lost the whole GPU device three times in a day (`WebGL context lost` ×3, then WebGPU `A valid external Instance reference no longer exists`). Every diagnosis was a guess until the compile was *measured* on the real compiler:

- one candle pipeline was **58,014 characters of WGSL and took 19.7 s to compile**, synchronously;
- three's ordinary `renderer.render()` creates a missing pipeline with the synchronous `device.createRenderPipeline`, which runs on the **GPU process's main thread**;
- Chrome's GPU watchdog kills that thread after ~15 s — and with it **every WebGL/WebGPU context on the page**, including Foundry's own.

The candle, its two light buckets and the rest of that burst summed to ~54 s of synchronous compile. The cause was inlined wind noise: every consumer re-evaluated Perlin noise (~18 `mx_noise_float` call sites per `sampleWind`, +28 for the 14-tap candle memory ladder), and the driver inlines each one.

## The four layers

| Layer | What it does | Where |
| --- | --- | --- |
| **1. Smaller shaders** | `sampleWind` is evaluated **once per frame** into a grid-sized field (a "now" and a "lagged" slice) and every consumer *reads* it. The candle's memory ladder reads a **recorded gust-history atlas** (one grid every 0.6 s of sim time) instead of re-sampling the wind 14 times. Same look; measured error: field mean 0.3 %, history vs analytic ladder mean 0.0001. | `world/wind-field-bake.js`, `world/wind-gust-history.js`, `world/wind-access.js` (`node(..., {baked})`, `gustHistory()`) |
| **2. The pipeline governor** | The one door through which this renderer creates a render pipeline. A flagged or ≥45k-char pipeline is created with `createRenderPipelineAsync` (a worker thread); three already skips drawing an object whose pipeline is not ready. A per-task budget of 80k synchronously compiled characters turns the rest of a burst async. `blocking()` (the floor-prepare warm-up) keeps *light* pipelines synchronous but never a heavy one. Every compile is written to the crash breadcrumbs **before** it starts. | `vt/pipeline-governor.js`, `core/compile-policy.js` |
| **3. The crash ladder** | A load that loses the device is remembered (`localStorage` `msa.crashGuard.v1`, heartbeat + breadcrumbs). The next load steps **one rung down**: 0 full → 1 careful (candle memory off) → 2 minimal (turbulence octaves 2, light wind off, performance profile `low`) → 3 foundry (MSA does not start; Foundry draws the scene). A stable load is remembered; a new build id resets it. After a loss MSA asks Foundry to redraw the scene to start again one rung lower. | `core/safe-mode.js`, `diag/crash-guard.js`, `boot.js` |
| **4. Budgets and a bench** | `npm test` enforces noise call sites, graph nodes and textures per material, and that the baked wind stays several times cheaper than the analytic path. The lab bench compiles every budgeted scenario **cold** on the real compiler and compares it with the numbers stored beside the budget. | `src/effects/__tests__/shader-budget.test.mjs`, `shader-budgets.json`, `tools/shader-lab/cost-probe.js` |

Nothing here removes a feature or changes the picture at full quality. The safe rungs (layer 3) only apply *after* a crash.

## Measured (cold, dev workstation, WebGPU/D3D12)

| Shader | Before | Now |
| --- | --- | --- |
| candle flame | 19.7 s (58k chars, 58 noise sites) | **1.1 s** (34k, 12) |
| candle illumination bucket | 16.6 s | **0.12 s** |
| candle coloration bucket | 17.2 s | **0.19 s** |
| storm fog / curtain / torrent | — | 0.4 s / 0.2 s / 1.8 s |
| window (2 pipelines) | — | 0.8 s each |
| water tiers 0–3 | — | ≤ 3.6 s per pipeline |
| **water tier 4 / 5** | — | **13.1 s / 12.2 s** for ONE 138k-char pipeline |

On the real GPU, the *pre-fix* 58k-char candle through the governor: first `render()` returned in 130 ms and the worst GPU-process stall was **276 ms** (it was ~20 s). Water tier 4 is the largest thing left: it is deferrable and so cannot trip the watchdog, but a first-ever load waits ~13 s for it (`mmp-fpu.5`).

## Adding or changing a shader — checklist

1. **Is it drawn every frame?** Then `markCompileDeferrable(material, 'why')` (`core/compile-policy.js`). It may appear a few frames late; it can never block the GPU process.
2. **Does it do one-shot GPU work** (a bake, a derivation that marks itself done)? Then `markCompileSyncOnly(material, 'why')` — skipping its first draw would lose the result. Keep it small; it counts against the per-task budget and can be killed by the watchdog.
3. **Does it read the wind?** Pass `baked: 'now'` (or `'lagged'`) to the wind handle's `node()` / `strengthNode()`. Never call `sampleWind` analytically from a per-pixel material.
4. **Add it to the lab** (`SCENARIOS` in `tools/shader-lab/cost-probe.js`) and to `shader-budgets.json`, run the bench, and paste the `proposed` numbers.
5. A shader past `HEAVY_PIPELINE_CHARS` (45,000) that carries no flag is still compiled async — and **named in the log** (`heavyUnflagged`) so someone decides which flag it should have.
6. `Fn(() => …)()` bodies are invisible to the Node census (they only exist once a renderer builds them). Those entries carry `budget: null`; the flag and the bench are what protect them.

## Reading a load

- Console, once per load: `shader compiles: N pipelines (A off-thread, S on the GPU main thread, F failed); slowest: label ms/chars/mode, …`
- `getVtPanViewerDiagnostics().shaders.governor` — the full census (`created`, `sync`, `async`, `overBudget`, `heavyInBlocking`, `slowest`, `heavyUnflagged`, `compiling`).
- Any compile past 2.5 s logs `slow shader compile: <label> took … ms (… chars, async|sync/<reason>)` with its name — a *sync* one that long is a near-miss for the 15 s watchdog.
- `MapShine.safeMode.status()` — the recorded state, the last decision, and any compile that was in flight when a page died.
- The warm-up waits up to 90 s for the async compiles it started (`settleCompiles` in `vt-pan-viewer.js`, then carries on with a warning), and the curtain's readiness check `pipelineCompiles` ("large shaders still compiling", stage COMPILE) holds the reveal until none is left or the curtain's own deadline passes.

## Operating

- Setting **Safe mode** (client): `auto` (default), `off` (ignore the ladder), `careful`, `minimal`.
- `MapShine.safeMode.reset()` forgets every recorded crash; the next reload is full quality.
- **Run the bench** (Shader Lab pane, `http://localhost:8934/` from `.claude/launch.json`):

  ```js
  const probe = await import('/tools/shader-lab/cost-probe.js?v=' + Date.now());
  (await probe.bench()).table                       // every scenario, cold
  await probe.governorCheck({ scenario: 'candle-flame', field: false, history: false, salt: 7 })  // governor on the real GPU
  ```

  The browser pane caches modules: reload it after editing `src/vt/pipeline-governor.js` or the lab will run the old governor. A `salt` changes one literal so the driver's disk cache (which survives devices and sessions) cannot turn a 12 s shader into a 12 ms one.
- Refresh a budget only after reading the `measured.gpu` line beside it. A budget that is far above the real census fails the test ("ceiling, not cushion") so the number in the file is always the actual limit.

## Known gaps

`mmp-fpu.5` water tier 4/5 · `mmp-fpu.6` fire, billow, lightning, specular, fluid, iridescence, prism, vegetation and **compute** pipelines are not yet in the lab (the governor wraps render pipelines only) · `mmp-fpu.7` the Node census cannot see inside `Fn()` · `mmp-fpu.8` live verification in Foundry.
