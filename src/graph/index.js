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
 * STILL not exported on purpose: `frame-graph.js`, `gpu-pass-timer.js`,
 * `v3-perf.js`. Real, tested, harvested V3 machinery with ZERO callers.
 * Exporting them would not make them reachable (nothing consumes them yet);
 * it would just make the museum easier to browse. They stay internal until
 * something real calls them.
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
