/**
 * THE DOOR to graph/ — the renderer's node graph as data (`passes.js`), the
 * checked facts about it (`pass-seams.js` for `seam`, `pass-impls.js` for
 * `live`), and derived health (`pass-health.js`). One public API per zone
 * (Skeleton.md §2.1, `zones/one-door`).
 *
 * `graph/` is the ONE legitimate cross-zone importer (`pass-seams.js`'s own
 * header) — wiring passes to implementations across zone doors is precisely
 * its job, the way a Nuke script is the one place that references every node.
 *
 * `ThreeAllocator` is exported because it now has a REAL CALLER: the scene
 * renderer allocates `buf:scene.color` through it (2026-07-17). It is the ONE
 * way to get a render target — `gpu/allocator-only` fails the build on
 * `new *RenderTarget(` anywhere else — so this door is the law's front door,
 * not a convenience.
 *
 * STILL not exported on purpose: `frame-graph.js`. Real, tested, harvested V3
 * machinery with ZERO callers. Exporting it would not make it reachable
 * (nothing consumes it yet); it would just make the museum easier to browse.
 * It stays internal until something real calls it.
 *
 * `gpu-pass-timer.js` sat beside `v3-perf.js` until 2026-07-27 and is DELETED
 * (docs/planning/Performance.md) — a hand-rolled `EXT_disjoint_timer_query_
 * webgl2` timer: WebGL2-only, so structurally unable to measure the WebGPU
 * backend this renderer actually runs, and duplicating what vendored three
 * already implements internally (vendor/three/three.webgpu.js:67928).
 * Per-pass timing now rides `runPassPlan`'s hooks out into `diag/`, which is
 * where `time/one-clock` allows a clock to be read.
 *
 * `v3-perf.js` was ALSO deleted that day and is now RESTORED (2026-08-27) —
 * the "closed-loop auto-downscaler nobody asked for" objection is void: it is
 * now a direct, explicit ask (a real map ran a stuttering ~30fps mirroring
 * Foundry's own resolution setting uncapped; the SAME map ran a stable
 * 55-60fps at a lower internal resolution). `RenderScaleGovernor` and
 * `computeRenderSize`'s pure state-machine logic needed no changes to be
 * correct again — only a new caller, since `V3PerfMonitor`'s per-pass
 * `PASS_BUDGETS_MS` is still keyed to old stage names matching nothing in
 * this zone's own `STAGES` (`vt/render-scale-policy.js` is the new caller;
 * it feeds the governor a single whole-frame cost signal, not a per-pass
 * one, so `V3PerfMonitor` itself stays unused — restored for its own tests'
 * sake and because deleting half a historical file is worse than an unused
 * export).
 *
 * `fullscreen-present.js` is NOT exported and cannot be: it is GLSL
 * (`ShaderMaterial`, `gl_Position`) in an all-TSL codebase — the last GLSL in
 * `src/`, surviving only because nothing imported it. Superseded by the TSL
 * present in the scene renderer; slated for deletion.
 */
export { PASSES, STAGES, validatePassGraph } from './passes.js';
export { PASS_SEAMS } from './pass-seams.js';
export { PASS_IMPLS } from './pass-impls.js';
export { evaluatePassHealth, breakerCircuits } from './pass-health.js';
export { ThreeAllocator, LAW_MAX_WORLD_RES_DIM, LAW_MAX_SCREEN_DIM } from './three-allocator.js';
export { planFrame, runPassPlan } from './run-frame.js';
export { RenderScaleGovernor, computeRenderSize, SCALE_LADDER, FRAME_BUDGET_MS } from './v3-perf.js';
export { createFrameCostSignal } from './render-cost-signal.js';
