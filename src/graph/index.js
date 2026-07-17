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
 * NOT exported here on purpose: `frame-graph.js`, `three-allocator.js`,
 * `gpu-pass-timer.js`, `v3-perf.js`, `fullscreen-present.js`. They are real,
 * tested, harvested V3 machinery — and as of 2026-07-17 they have ZERO
 * callers anywhere in `src/`. Exporting them from this door would not make
 * them reachable (nothing outside graph/ consumes them yet); it would just
 * make the museum easier to browse. They stay internal until something real
 * calls them — see `keyhole-stage-status` memory, the 2026-07-17 session
 * entry, for the full audit.
 */
export { PASSES, STAGES, validatePassGraph } from './passes.js';
export { PASS_SEAMS } from './pass-seams.js';
export { PASS_IMPLS } from './pass-impls.js';
export { evaluatePassHealth, breakerCircuits } from './pass-health.js';
