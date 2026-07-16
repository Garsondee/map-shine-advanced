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
  registerParticleSystem,
  buildLightVisibilityPass,
  buildLightAccumulatePass,
  buildGradePass,
  buildWaterPass,
  buildFluidSimPass,
  buildSurfaceResponsePass,
} from '../effects/index.js';
import { buildOcclusionMaskPass } from '../scene/index.js';

/**
 * Every 'seam'-status pass MUST appear here; every entry here MUST be a
 * seam-status pass. (Both directions are asserted in pass-declarations.test.)
 * @type {Record<string, (ctx: object) => never>}
 */
export const PASS_SEAMS = Object.freeze({
  'sims.particles': registerParticleSystem,
  'sims.fluids': buildFluidSimPass,
  'masks.occlusion': buildOcclusionMaskPass,
  'light.visibility': buildLightVisibilityPass,
  'light.accumulate': buildLightAccumulatePass,
  'surface.response': buildSurfaceResponsePass,
  'surface.water': buildWaterPass,
  'surface.particles': registerParticleSystem, // draw half shares the engine door
  'post.grade': buildGradePass,
});
