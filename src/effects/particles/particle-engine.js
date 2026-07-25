/**
 * THE PARTICLE ENGINE — the ONE place particles come from. (The door, now open.)
 *
 * ============================================================================
 * WAS A LOCKED DOOR (Skeleton.md §2.2); NOW THE ENGINE'S FRONT DOOR (2026-07-21).
 * ============================================================================
 *
 * This module used to export three functions that all threw {@link NotBuiltError}
 * — a deliberately-locked door with the design taped to it, guarded so nobody
 * could hand-roll particles behind it. Stage 6 arrived: the engine is built
 * (particle-runtime.js), and the `sims.particles` / `surface.particles` passes
 * are `live` in graph/passes.js, driven from the vt-pan-viewer render loop (the
 * pragmatic "viewer closure" shape wind/candle use, backed now by real code).
 *
 * So the door opens onto the real thing. The doctrine the throwing version
 * defended still holds, and is still enforced by walls, not comments:
 *
 *   • ONE engine. V2 had FIVE particle architectures at once because using the
 *     good one was OPTIONAL (docs/planning/Particles.md §2). `particles/one-
 *     engine` fails the build if THREE.Sprite/Points/InstancedMesh/three.quarks
 *     appear outside this directory.
 *   • A system is DATA, never a class — {@link validateParticleSystem}. Rain and
 *     snow are two configs handed to one engine; adding hail is a file.
 *   • Storage buffers have ONE door (the arena) — `particles/allocator-only`.
 *   • Simulation is GPU compute (TSL), proven on both backends by the throwaway
 *     diag/compute-spike.js. There is NO per-particle JS object, by construction
 *     — that object was V2's actual bottleneck, present in 11 files.
 *
 * WHY NOT three.quarks (asked and answered — do not re-litigate): memory
 * `keyhole-particles-tsl-decision`. Quarks builds raw-GLSL ShaderMaterials via
 * `onBeforeCompile`, a hook the node renderer NEVER calls; its DESIGN is
 * harvested, the library is not.
 *
 * @module effects/particles/particle-engine
 */

export { createParticleEngine } from './particle-runtime.js';
// The ribbon-trail sibling (Wind Gusts) — a SECOND runtime that reuses this
// engine's arena + wind door, not a fifth architecture: it lives under the same
// roof and obeys the same walls. See gust-runtime.js's header for why a ribbon
// needs its own runtime rather than a draw-mode branch on the dot engine.
export { createGustEngine } from './gust-runtime.js';
