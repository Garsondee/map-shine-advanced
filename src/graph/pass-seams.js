/**
 * THE SEAM REGISTRY — pass id → its locked door.
 *
 * `graph/passes.js` marks passes as 'seam', meaning "a throwing NotBuilt door
 * exists" (Skeleton.md §2.2). This registry is what makes that STATUS a checked
 * fact instead of a claim: the Node test walks every seam-status pass, looks it
 * up here, calls it, and asserts a `NotBuiltError` that cites its design doc.
 *
 * Why that matters: this very session, two passes were marked 'seam' while no
 * door existed — an honest-looking lie the tests could not see. Statuses drift
 * exactly like everything else drifts; now they cannot (a seam without a door,
 * or a door without its pass, is a red test).
 *
 * The graph zone is the ONE legitimate cross-zone importer — wiring passes to
 * implementations is precisely its job, the way a Nuke script is the one place
 * that references every node.
 *
 * @module graph/pass-seams
 */

// Through the DOORS, exemplifying zones/one-door: the wiring registry imports
// each zone's index.js, never its internals.
import {
  buildLightVisibilityPass,
  buildGradePass,
  buildWaterPass,
  buildFluidSimPass,
  buildSurfaceResponsePass,
} from '../effects/index.js';

/**
 * Every 'seam'-status pass MUST appear here; every entry here MUST be a
 * seam-status pass. (Both directions are asserted in pass-declarations.test.)
 *
 * 'masks.occlusion' is NOT here (2026-07-18): it flipped to 'live' — see
 * graph/pass-impls.js. scene/occlusion-mask.js's throwing door is deleted;
 * a real (RADIAL-only) producer replaced it in vt-pan-viewer.js.
 *
 * 'light.accumulate' is NOT here either (2026-07-18): it flipped to 'live'
 * (AMBIENT/EXTERIOR only) — see graph/pass-impls.js. Its throwing door
 * (`buildLightAccumulatePass`) is deleted from effects/lighting/lighting-pass.js;
 * a real producer runs in vt-pan-viewer.js (effects/lighting/environmental-
 * light.js does the TSL). 'light.visibility' STAYS a seam — shadows aren't built.
 *
 * 'sims.particles' + 'surface.particles' are NOT here either (2026-07-21): both
 * flipped to 'live' — see graph/pass-impls.js. The engine is real
 * (effects/particles/particle-runtime.js#createParticleEngine); the sim is
 * stepped directly in renderFrame (sims stage is out of the plan range, like
 * tickWindSim) and the instanced draw runs as a viewer closure. The old shared
 * `registerParticleSystem` door is gone (particle-engine.js now opens onto the
 * engine). First slice: ambient dust on the wind field.
 * @type {Record<string, (ctx: object) => never>}
 */
export const PASS_SEAMS = Object.freeze({
  'sims.fluids': buildFluidSimPass,
  'light.visibility': buildLightVisibilityPass,
  'surface.response': buildSurfaceResponsePass,
  'surface.water': buildWaterPass,
  'post.grade': buildGradePass,
});
