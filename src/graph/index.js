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
 * `gpu-pass-timer.js` and `v3-perf.js` sat beside it until 2026-07-27 and are
 * now DELETED (docs/planning/Performance.md). The first was a hand-rolled
 * `EXT_disjoint_timer_query_webgl2` timer: WebGL2-only, so structurally unable
 * to measure the WebGPU backend this renderer actually runs, and duplicating
 * what vendored three already implements internally
 * (vendor/three/three.webgpu.js:67928). The second's `PASS_BUDGETS_MS` was keyed
 * to stage names (`streaming`, `unifiedGeometry`, `effects`) matching nothing in
 * this zone's own `STAGES`, plus a closed-loop auto-downscaler nobody asked for.
 * Per-pass timing now rides `runPassPlan`'s hooks out into `diag/`, which is
 * where `time/one-clock` allows a clock to be read.
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
