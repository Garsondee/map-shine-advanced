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
 * ============================================================================
 * THE FUSION IS GONE (2026-07-17) — but the honesty rule that named it stays
 * ============================================================================
 *
 * `geometry.world` and `present.composite` used to point at the SAME function
 * with `fusedWith` naming the overlap, because a single `renderer.render()`
 * straight to the canvas is not two passes however you label it. That was the
 * truth, recorded rather than papered over.
 *
 * It is no longer the truth. `renderFrame` now does:
 *   geometry.world    : the sorted draw list → `buf:scene.color`
 *                       (a real RenderTarget, allocated through the law)
 *   present.composite : `buf:scene.color` → the canvas (a TSL fullscreen pass)
 * Two `renderer.render()` calls against two targets. So `fusedWith` is dropped
 * from both — the claim would now be false, and a stale honesty-marker is just
 * a lie with good manners.
 *
 * What is STILL true, and must not drift into being over-claimed: both entries
 * point at `startVtPanViewer` because the frame loop is still driven from
 * inside it (`renderer.setAnimationLoop(renderFrame)`), not by a graph runner
 * calling passes. The passes are now genuinely SEPARATE; they are not yet
 * separately INVOCABLE. Inverting that control — a real `graph/run-frame.js`
 * that drives the draw step rather than the reverse — is the next step, and
 * every entry's `separatelyInvocable` field says so in a form a test checks,
 * rather than leaving it implied in prose.
 *
 * `vt.residency` is different again: its real entry point already exists and
 * is already externally invoked — `refreshVtPanViewerItems()` is exported and
 * called by `boot.js`'s token-CRUD hooks today. No extraction was needed; this
 * registry just makes that fact CHECKED instead of assumed.
 *
 * The standing rule that produced `fusedWith` in the first place: when the code
 * does not match what the declaration claims, record the mismatch in a field a
 * TEST can check — never a comment, and never a wrapper that LOOKS separated
 * while changing nothing real. A wall that lies about being open is worse than
 * an honestly-locked one.
 *
 * @module graph/pass-impls
 */

import { startVtPanViewer, refreshVtPanViewerItems } from '../vt/index.js';

/**
 * @typedef {object} PassImpl
 * @property {Function} fn - the REAL function this pass's `live` claim points at.
 * @property {string} module - the door-relative specifier `fn` was imported through (informational; the import above is the enforced one).
 * @property {string} export - the real export name, so a rename is greppable.
 * @property {string[]} [fusedWith] - other pass ids whose `live` claim resolves to this SAME `fn` AND is not separable in the code. Dropped 2026-07-17 when geometry.world/present.composite genuinely split; kept in the contract because the honesty rule that produced it is permanent.
 * @property {boolean} [separatelyInvocable] - can a caller run JUST this pass? False = the pass is real and separate in the frame, but the loop is still driven from inside `fn`. An honest middle state, checked by a test rather than described in prose.
 * @property {string} note
 */

/** @type {Record<string, PassImpl>} */
export const PASS_IMPLS = Object.freeze({
  'vt.residency': {
    fn: refreshVtPanViewerItems,
    module: 'vt/index.js',
    export: 'refreshVtPanViewerItems',
    separatelyInvocable: true,
    note:
      'The real, ALREADY-SEPARATE entry point — boot.js already drives this from Foundry token-CRUD ' +
      'hooks (createToken/updateToken/deleteToken). No extraction needed; this makes the fact checked.',
  },
  'masks.occlusion': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-07-18, RADIAL-only: runMaskOcclusionPass (a private closure inside ' +
      'startVtPanViewer) renders token discs into a real screen-sized render target every frame, MIN-' +
      "blended, and refreshes every drawn item's uOcclusionElevation uniform. FADE/VISION/SURFACE " +
      "stay inert — see graph/passes.js's own note for the honest scope. Same invocability caveat as " +
      'geometry.world/present.composite: the loop lives inside startVtPanViewer, driven by the SAME ' +
      'local passImpls/framePlan graph/run-frame.js walks, not yet externally callable alone.',
  },
  'geometry.world': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-07-17: renderFrame draws the sorted list into buf:scene.color (a RenderTarget ' +
      "allocated through ThreeAllocator — the law's first caller). No longer fused with " +
      'present.composite. Not separately invocable: setAnimationLoop still drives the loop from ' +
      'inside startVtPanViewer, rather than a graph runner calling this pass.',
  },
  'light.accumulate': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-07-18 (AMBIENT/EXTERIOR only): runLightAccumulatePass fills buf:scene.illum with ' +
      "Foundry's ambient background and composites scene.color × illum → scene.lit (which present then " +
      'reads). TSL lives in effects/lighting/environmental-light.js; the RTs + draws are driven from ' +
      'renderFrame. Point lights/coloration/darkness are later rungs (passes.js note). Same invocability ' +
      'caveat as geometry.world — the loop still drives it from inside startVtPanViewer.',
  },
  'present.composite': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-07-17: a TSL fullscreen pass reading buf:scene.color → the canvas, its own ' +
      'renderer.render() against its own target. Written fresh, NOT harvested from ' +
      'graph/fullscreen-present.js (GLSL, unusable under WebGPURenderer). Same invocability caveat ' +
      'as geometry.world.',
  },
  'sims.particles': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-07-21 (first slice: ambient dust): createParticleEngine (effects/particles/' +
      'particle-runtime.js) dispatches the TSL update kernel via a DIRECT renderer.compute() in ' +
      "renderFrame, right after tickWindSim — the sims stage is out of framePlan's range, so this is " +
      'driven like the wind sim, not by runPassPlan. Not separately invocable: the loop lives inside ' +
      'startVtPanViewer, same caveat as geometry.world.',
  },
  'surface.precipitation': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-08-16 (P1: rain + snow): createPrecipitationSubsystem steps its compute kernel ' +
      'in the sims block beside fire, then the frame loop draws its scene over the lit world — after ' +
      'every additive light draw, before vision.gate, guarding the clear like the candle flame. ' +
      'Gated on `hasContent`, so a clear day submits nothing. Same invocability caveat as ' +
      'geometry.world: the loop lives inside startVtPanViewer.',
  },
  'surface.particles': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-07-21 (first slice: ambient dust): runSurfaceParticlesPass (a closure inside ' +
      'startVtPanViewer, in the local passImpls map runPassPlan walks) draws the engine scene — one ' +
      'InstancedBufferGeometry, positions straight from the arena — additively into scene.lit, guarding ' +
      'the clear like the candle flame. Same invocability caveat as geometry.world.',
  },
  'vision.gate': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-08-15 (Testament Pillar 11): runVisionGatePass (a closure inside ' +
      'startVtPanViewer, in the local passImpls map runPassPlan walks) multiplies ONE fullscreen quad ' +
      'over scene.lit, hiding everything the viewer may not see. Its ORDER is the feature — after every ' +
      'additive draw (a live run proved gating the composite alone left candle flames and fire ' +
      'particles drawing through the fog) and before post.bloom (so a hidden light cannot smear across ' +
      'it). Same invocability caveat as geometry.world.',
  },
  'surface.response': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-07-26 (tiers 0-2, docs/planning/Specular.md): runSurfaceResponsePass (a closure ' +
      'inside startVtPanViewer, in the local passImpls map runPassPlan walks) draws the specular ' +
      "subsystem's OWN dedicated scene into scene.lit — two meshes over one AABB-cropped quad, a " +
      'MULTIPLY for the diffuse a conductor replaces and an ADD for the highlights. Unlike water this ' +
      'genuinely needed to be a pass rather than a drawable: it reads buf:scene.illum, which does not ' +
      'exist until light.accumulate has run. Skips entirely (JS early-return, no GPU work) when the ' +
      'effect is off or no specular mask has loaded. Same invocability caveat as geometry.world.',
  },
  'surface.water': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-08-23 (tier 5, refraction): runWaterRefractionCapturePass (a closure inside ' +
      'startVtPanViewer, in the local passImpls map runPassPlan walks) ticks each floor`s own ' +
      'water-refraction-subsystem.js instance, capturing buf:scene.color into a small, bounded, ' +
      'previous-frame buffer for tier 5`s dependent read next frame. Tiers 0-4 STAY drawables inside ' +
      'geometry.world — this pass adds the ONE thing a drawable genuinely cannot do (a same-pass read), ' +
      'nothing else moves. Same invocability caveat as surface.response: the loop lives inside ' +
      'startVtPanViewer, driven by the same local passImpls/framePlan graph/run-frame.js walks.',
  },
  'post.bloom': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-07-23: runPostBloomPass (a closure inside startVtPanViewer, in the local ' +
      'passImpls map runPassPlan walks) reads scene.lit, runs the dual-filter bloom pyramid through ' +
      'allocator-owned mip targets (effects/bloom-render.js builds the TSL), and additively composites ' +
      'the two-band result back into scene.lit before present. Skips entirely (JS early-return, no GPU ' +
      'work) when the effect is disabled. Same invocability caveat as geometry.world — the loop lives ' +
      'inside startVtPanViewer.',
  },
  'post.dof': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-08-06 (docs/planning/Depth-of-Field.md): runPostDofPass (a closure inside ' +
      'startVtPanViewer, in the local passImpls map runPassPlan walks) reads scene.lit and ' +
      "buf:scene.depth's floor-index colour payload, builds a 4-mip downsample pyramid through " +
      'allocator-owned mip targets (effects/depth-of-field-render.js builds the TSL), and composites a ' +
      'floor-distance-driven blur back into scene.lit via NormalBlending. Skips entirely (JS early-' +
      'return, no GPU work) when the effect is disabled or the viewed floor is the ground floor. Same ' +
      'invocability caveat as geometry.world — the loop lives inside startVtPanViewer.',
  },
  'post.taaResolve': {
    fn: startVtPanViewer,
    module: 'vt/index.js',
    export: 'startVtPanViewer',
    separatelyInvocable: false,
    note:
      'REAL as of 2026-08-30 (project_albedo_zoom_out_clarity_audit_2026-08-30 Stage 5): ' +
      'runPostTaaResolvePass (a closure inside startVtPanViewer, in the local passImpls map ' +
      'runPassPlan walks) reads scene.lit + a ping-ponged history buffer pair (allocator-owned, ' +
      "vt/taa-resolve.js builds the TSL), clamps the reprojected history into the current frame's " +
      "own neighbourhood, and redirects present.composite's read target to the freshly-written " +
      'buffer (grade-present.js#setLitSource — a value swap, no rebuild). A TRUE no-op every frame ' +
      'while the setting is off (default), except the exact frame it turns off, which un-redirects ' +
      'present exactly once. Same invocability caveat as geometry.world — the loop lives inside ' +
      'startVtPanViewer.',
  },
});
