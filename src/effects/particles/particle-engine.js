/**
 * THE PARTICLE ENGINE — the ONE place particles come from.
 *
 * ============================================================================
 * NOT BUILT YET. This is a DOOR, deliberately locked, with the map taped to it.
 * ============================================================================
 *
 * Every function here throws {@link NotBuiltError}. That is not an oversight —
 * it is the design (docs/planning/Skeleton.md §2.2). Particles are Stage 6 work
 * (Keyhole.md §8), months out. But the *door* and the *walls around it* are
 * worth building today, because today is the only moment when nothing has been
 * poured yet.
 *
 * WHY THIS EXISTS AT ALL — the thing that killed the last module:
 *
 * V2 had FIVE particle architectures at once (docs/planning/Particles.md):
 * three.quarks for weather, THREE.Points in one file, InstancedMesh in three,
 * a `new THREE.Sprite()` PER PARTICLE in eight (N particles = N scene-graph
 * objects = N draw calls), and per-particle JS-object callbacks in eleven.
 * Every one of those re-solved emission, lifetime, wind, culling, pooling and
 * disposal from scratch — which is why splashes, dust, ash, flies, drips and
 * candles each cost a thousand-plus lines.
 *
 * The cause was NOT that nobody built a good engine. Somebody did: quarks,
 * batched, behavior-driven — the right instinct. **It lost because using it was
 * OPTIONAL.** That is the same mechanism that beat V2's EffectComposer (5
 * importers vs the god-object's 92) and its Foundry adapter (21 of 128 files).
 * Optional structure always loses, because bypassing it is always cheaper today.
 *
 * So this door is not defended by a comment asking nicely. It is defended by
 * `tools/verify-structure.mjs`, which FAILS THE BUILD if `THREE.Sprite`,
 * `THREE.Points`, `InstancedMesh` or `three.quarks` appear anywhere outside this
 * directory. A comment cannot fail a build. That check can.
 *
 * WHY NOT three.quarks (asked and answered — do not re-litigate):
 * see memory `keyhole-particles-tsl-decision`. Verified at HEAD, not inferred:
 * quarks builds raw-GLSL `ShaderMaterial`s patched via `onBeforeCompile`, a hook
 * the node renderer NEVER CALLS. Feeding one to our renderer logs
 * `NodeBuilder: Material "ShaderMaterial" is not compatible` and draws a BLANK
 * material. Running it would require a second WebGLRenderer — the exact root
 * blunder that cost V2 1,838 lines of sync code that never worked
 * (docs/planning/Engine-Postmortem.md §1). Quarks' *design* is harvested; the
 * library is not.
 *
 * WHAT REPLACES IT — and it is an upgrade, not a consolation:
 * TSL compute. Our vendored build exports `TSL.compute`, `TSL.storage`,
 * `TSL.instanceIndex` and `TSL.instancedArray` (three.js's purpose-built GPGPU
 * particle helper), and `WebGLBackend.compute()` is a REAL implementation via
 * transform feedback — so ONE TSL source gives GPU-simulated particles on
 * WebGPU *and* WebGL2. Quarks simulated on the CPU with a JS object per
 * particle, which was V2's actual particle bottleneck. This deletes it rather
 * than porting around it.
 *
 * @module effects/particles/particle-engine
 */

import { NotBuiltError } from '../../core/not-built.js';

/** Where the design lives. Cited in every error thrown from this module. */
const OWNS = 'docs/planning/Particles.md §7 + memory keyhole-particles-tsl-decision';

/**
 * Register a particle system so the engine can run it.
 *
 * A particle system is **data, not a class** — see {@link validateParticleSystem}.
 * `WeatherParticles.js` was 11,777 lines holding rain, snow, ash and embers in
 * ONE class with 355 private fields, because each weather type was code. Here,
 * rain and snow are two config objects handed to one engine. Adding hail is a
 * file, not a subsystem.
 *
 * @param {import('./particle-system-schema.js').ParticleSystemDecl} decl
 * @returns {never} always throws — not built yet
 * @throws {NotBuiltError}
 */
export function registerParticleSystem(decl) {
  void decl;
  throw new NotBuiltError('particle-engine.registerParticleSystem', {
    owns: OWNS,
    gate:
      'Stage 6 (Keyhole.md §8). Blocked on: the ~10 pass declarations, and the ' +
      'decode-time extractor API (spawn sources read pages, never the GPU).',
    instead:
      'Do NOT hand-roll particles elsewhere — tools/verify-structure.mjs will fail the build. ' +
      'Write the declaration here and validate it with validateParticleSystem(); the shape is ' +
      'testable long before the engine exists.',
  });
}

/**
 * Build the engine's frame-graph pass. Called once by the graph, never by an effect.
 *
 * @param {object} ctx - exactly the declared reads (see Effects-API.md §5) — no renderer, no globals.
 * @returns {never} always throws — not built yet
 * @throws {NotBuiltError}
 */
export function buildParticlePass(ctx) {
  void ctx;
  throw new NotBuiltError('particle-engine.buildParticlePass', {
    owns: OWNS,
    gate: 'Stage 6. Needs the frame graph to exist first (Keyhole.md §4.2).',
    instead:
      'The pass is GPU-simulated via TSL.compute/instancedArray and runs in the sims stage. ' +
      'It must NEVER create a scene-graph object per particle — that was V2 in 8 files.',
  });
}

/**
 * Advance every registered system by `dt`. Called once per frame by the graph.
 *
 * Simulation is GPU-side (TSL compute / transform-feedback). There is no
 * per-particle JS object, by construction: that was V2's bottleneck, present in
 * 11 files.
 *
 * @param {number} dt - seconds since last frame, from the frame's time snapshot.
 * @returns {never} always throws — not built yet
 * @throws {NotBuiltError}
 */
export function stepParticles(dt) {
  void dt;
  throw new NotBuiltError('particle-engine.stepParticles', {
    owns: OWNS,
    gate: 'Stage 6.',
    instead:
      'Time is an INPUT (the frame snapshot), never sampled privately. V2 had 8 independent ' +
      'performance.now() reads in one effect.',
  });
}
