/**
 * THE LIVE REGISTRY — pass id → the REAL, REACHABLE code behind a `live` claim.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * `pass-seams.js` made `seam` a CHECKED FACT: every seam-status pass has a
 * registered door, a test calls it and asserts it throws `NotBuiltError`. That
 * is real enforcement — a pass cannot claim `seam` without a door that a test
 * proves exists.
 *
 * `live` had nothing. Found 2026-07-17: all three `live`-status passes
 * (`vt.residency`, `geometry.world`, `present.composite`) were pure CLAIMS —
 * `geometry.world`'s own note in `passes.js` said it "becomes this pass by
 * rename"; it was not a rename. The status that asserts real code EXISTS was
 * the one status nothing checked — the mirror image of the `seam` drift that
 * `pass-seams.js`'s own header describes catching ("two passes claimed seam
 * with no door existing"). Same disease, opposite status value.
 *
 * ============================================================================
 * WHAT THIS REGISTRY HONESTLY CLAIMS — read before adding an entry
 * ============================================================================
 *
 * Each entry points at a REAL function reference (not a string path — a
 * genuine import, so a rename or deletion breaks the BUILD, not a comment).
 * A test (`pass-impls.test.mjs`) asserts every entry's `fn` is a real function
 * and that live-status coverage is exact in both directions, exactly like
 * `pass-seams.js`'s door check.
 *
 * What this registry does NOT yet claim, and must not be allowed to drift into
 * silently claiming: `geometry.world` and `present.composite` are NOT
 * independently invocable passes today. Both point at the SAME entry point
 * (`startVtPanViewer`, via the `vt/` door) because the real code is FUSED —
 * camera, residency-triggered streaming, mesh binding, occlusion state, and
 * the actual draw call all live inside one 1,778-line function
 * (`src/vt/vt-pan-viewer.js`, lines 304–2082), with the draw step itself
 * (`renderFrame`) driven internally by `renderer.setAnimationLoop` and never
 * exposed for external invocation.
 *
 * That fusion is NOT rebuilt here on purpose. `startVtPanViewer` took NINE
 * rounds of live, in-browser debugging to get right (Y-flip, a GL
 * texture-unit-cache staleness bug, a UV-compounding bug, a clamp-bound
 * conflation regression — see `keyhole-stage-status` memory, 2026-07-15/16
 * session). There is no way to run Foundry from this environment to verify a
 * restructuring of that function did not reintroduce one of those. Per this
 * project's own standing instruction ("if you can't test the UI, say so
 * explicitly rather than claiming success") and doctrine 5 (instruments must
 * not lie), the honest move is to register the TRUE, FUSED shape — with
 * `fusedWith` naming the passes that share it — rather than invent a fake
 * standalone wrapper that LOOKS separated but changes nothing real. A wall
 * that lies about being open is worse than an honestly-locked one.
 *
 * `vt.residency` is different: its real entry point already exists and is
 * already externally invoked — `refreshVtPanViewerItems()` is exported from
 * `vt-pan-viewer.js` and called by `boot.js`'s token-CRUD hooks today (see
 * `_active.refreshItems` in that file). No extraction was needed; it was
 * already a real, separate, reachable function. This registry just makes that
 * fact CHECKED instead of assumed.
 *
 * THE NEXT REAL STEP (tracked, not done here): separating `geometry.world`
 * from `present.composite` — and eventually inverting control so a real
 * `graph/run-frame.js` DRIVES `startVtPanViewer`'s draw step instead of the
 * reverse — requires touching `renderFrame`/`setAnimationLoop` and needs the
 * author's live verification, the same as every other change to this file has
 * (`keyhole-stage-status` memory, Round 1 through 9).
 *
 * @module graph/pass-impls
 */

import { startVtPanViewer, refreshVtPanViewerItems } from '../vt/index.js';

/**
 * @typedef {object} PassImpl
 * @property {Function} fn - the REAL function this pass's `live` claim points at.
 * @property {string} module - the door-relative specifier `fn` was imported through (informational; the import above is the enforced one).
 * @property {string} export - the real export name, so a rename is greppable.
 * @property {string[]} [fusedWith] - other pass ids whose `live` claim currently resolves to this SAME `fn` — the honest debt this registry exists to name.
 * @property {string} note
 */

/** @type {Record<string, PassImpl>} */
export const PASS_IMPLS = Object.freeze({
  'vt.residency': {
    fn: refreshVtPanViewerItems,
    module: 'vt/index.js',
    export: 'refreshVtPanViewerItems',
    note:
      'The real, ALREADY-SEPARATE entry point — boot.js already drives this from Foundry token-CRUD ' +
      'hooks (createToken/updateToken/deleteToken). No extraction needed; this makes the fact checked.',
  },
  'geometry.world': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    fusedWith: ['present.composite'],
    note:
      'FUSED with present.composite inside renderFrame() (vt-pan-viewer.js), driven by ' +
      'renderer.setAnimationLoop — not yet independently invocable. Honest debt, not a fake separation.',
  },
  'present.composite': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    fusedWith: ['geometry.world'],
    note: "Same fusion as geometry.world, same reason — see that entry and this file's header.",
  },
});
