/**
 * THE DOOR to effects/ — every pass door and (eventually) every effect
 * declaration crosses this threshold or does not cross at all.
 */
export { registerParticleSystem, buildParticlePass, stepParticles } from './particles/particle-engine.js';
export { validateParticleSystem, EMITTER_SHAPES, BEHAVIORS, SPAWN_KINDS } from './particles/particle-system-schema.js';
export { buildLightVisibilityPass, buildLightAccumulatePass } from './lighting/lighting-pass.js';
export { buildGradePass } from './grade/grade-pass.js';
export { buildWaterPass, buildFluidSimPass } from './water/water-pass.js';
export { buildSurfaceResponsePass } from './surface-response.js';
