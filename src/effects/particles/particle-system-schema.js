/**
 * THE PARTICLE SYSTEM CONTRACT — what a particle system IS.
 *
 * **A particle system is DATA, not a class.** Rain and snow are two config
 * objects handed to one engine. Adding hail is a file, not a subsystem.
 *
 * This is not a stylistic preference; it is the direct lesson of
 * `WeatherParticles.js`: **11,777 lines, 355 private fields**, holding rain, ash,
 * snow and embers in ONE class and one mutable namespace, because each weather
 * type was *code*. Any field could touch any system, so every bug hunt walked
 * the whole file. That is the god-object pattern recursed down into a single
 * effect — proof the disease is scale-free unless structurally blocked.
 *
 * Pleasant confirmation the model is right: this is **quarks' own model**. Its
 * renderer-agnostic core (`quarks.core`) exports exactly this vocabulary —
 * emitters, behaviors, generators, and `*FromJSON` deserializers. The author's
 * "weather as data" instinct and the best particle library in the ecosystem
 * independently arrived at the same shape. We harvest that vocabulary and the
 * tuned values; we cannot harvest the library (memory:
 * `keyhole-particles-tsl-decision`).
 *
 * Unlike the engine itself, this file WORKS TODAY — a declaration is plain data,
 * so it can be written, validated and unit-tested months before anything renders
 * a pixel. That is `keyhole-stage6-effects-approach`'s "declaration first,
 * implementation second", made executable.
 *
 * @module effects/particles/particle-system-schema
 */

/**
 * Emitter shapes. Harvested from `quarks.core`'s export list — a vocabulary
 * already proven against real content, so we are not inventing one.
 * @readonly
 */
export const EMITTER_SHAPES = Object.freeze(['point', 'circle', 'cone', 'donut', 'grid', 'hemisphere', 'shell']);

/**
 * Behaviors — the composable units that make particles *feel* like something.
 * Also harvested from `quarks.core`. V2's own `SmartWindBehavior` /
 * `SmartUpdraftBehavior` / `world-volume-kill` were small, composable and
 * conceptually right — they belong here as behaviors, not as bespoke classes.
 * @readonly
 */
export const BEHAVIORS = Object.freeze([
  'applyForce',
  'applyCollision',
  'colorOverLife',
  'sizeOverLife',
  'forceOverLife',
  'orbitOverLife',
  'limitSpeedOverLife',
  'colorBySpeed',
  'turbulenceField',
  'curlNoiseField',
  'changeEmitDirection',
  'emitSubParticle',
  'smartWind',
  'smartUpdraft',
  'worldVolumeKill',
]);

/**
 * How a system decides WHERE to spawn.
 *
 * - `area` — an emitter shape in world space, optionally gated by an attribute
 *   (e.g. rain only outdoors, read from `scene.attr`).
 * - `extracted` — points computed **at decode time, per page, in the worker**
 *   (Keyhole.md §4.1) — fire spawn points, water splash sites, roof-drip edges.
 *
 * **`extracted` is not an optimisation, it is a bug fix.** V2 found spawn points
 * by reading pixels back off the GPU and by full-res `getImageData` scans. Roof
 * drips went further: they *voted at runtime* between four screen→world flip
 * combinations and took whichever won a loose poll — which is exactly why the
 * author reported they "never reliably worked" (memory:
 * `feedback_probed_constants_vs_derived`). Extracted spawn points live in
 * world-space PAGE coordinates, where no screen is involved, so there is no
 * transform to guess. The question stops being askable.
 * @readonly
 */
export const SPAWN_KINDS = Object.freeze(['area', 'extracted']);

/**
 * @typedef {object} ParticleSystemDecl
 * @property {string} id - e.g. `'weather.rain'`. Namespaced, stable.
 * @property {number} visualWeight - 0..1. How hard the governor defends this
 *   system's tiers when the frame budget shrinks (see Effects.md §6).
 * @property {{shape: string, gate?: string}} emitter - shape from {@link EMITTER_SHAPES};
 *   optional `gate` names an attribute-buffer condition (e.g. `'outdoors'`).
 * @property {Array<{type: string, params?: object}>} behaviors - each `type` from {@link BEHAVIORS}.
 * @property {{kind: string, extractor?: string}} spawn - `kind` from {@link SPAWN_KINDS};
 *   `extracted` requires the `extractor` id that produces the points at decode time.
 * @property {string[]} reads - declared resources ONLY (`res:windField`, `buf:scene.attr`, …).
 *   If it is not listed here the system cannot touch it — there is no global to reach through.
 * @property {Array<object>} tiers - the ladder (Effects.md). Contiguous from 0.
 * @property {object} [params] - the tuned values (curves, rates, lifetimes) — the author's taste.
 */

/**
 * Validate a particle system declaration.
 *
 * Every rule below is a V2 corpse. This runs in Node, so a bad declaration is a
 * failing test — not a silent no-op discovered in play six months later, which
 * is how V2's `?.setOutdoorsMask?.()` misses behaved.
 *
 * @param {ParticleSystemDecl} decl
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateParticleSystem(decl) {
  const errors = [];
  const fail = (m) => errors.push(m);

  if (!decl || typeof decl !== 'object') {
    return { ok: false, errors: ['declaration must be an object'] };
  }

  if (typeof decl.id !== 'string' || !decl.id.includes('.')) {
    fail(`id must be a namespaced string like 'weather.rain' (got ${JSON.stringify(decl.id)})`);
  }
  if (typeof decl.visualWeight !== 'number' || decl.visualWeight < 0 || decl.visualWeight > 1) {
    fail('visualWeight must be a number in 0..1 — the governor needs it to arbitrate tiers');
  }

  // --- emitter ---
  if (!decl.emitter || !EMITTER_SHAPES.includes(decl.emitter.shape)) {
    fail(`emitter.shape must be one of: ${EMITTER_SHAPES.join(', ')}`);
  }

  // --- behaviors: data, not code ---
  if (!Array.isArray(decl.behaviors)) {
    fail('behaviors must be an array (a system is DATA — 355 private fields is what code looks like)');
  } else {
    for (const b of decl.behaviors) {
      if (!b || !BEHAVIORS.includes(b.type)) {
        fail(`unknown behavior ${JSON.stringify(b?.type)} — must be one of: ${BEHAVIORS.join(', ')}`);
      }
    }
  }

  // --- spawn ---
  if (!decl.spawn || !SPAWN_KINDS.includes(decl.spawn.kind)) {
    fail(`spawn.kind must be one of: ${SPAWN_KINDS.join(', ')}`);
  } else if (decl.spawn.kind === 'extracted' && !decl.spawn.extractor) {
    fail(
      "spawn.kind 'extracted' requires an extractor id — spawn points are computed at DECODE time, " +
        'per page, in the worker (Keyhole §4.1). Never by reading the GPU back.'
    );
  }

  // --- reads: the contract's whole point ---
  if (!Array.isArray(decl.reads)) {
    fail('reads must be an array — if it is not declared, the system cannot touch it');
  } else {
    for (const r of decl.reads) {
      if (typeof r !== 'string' || !/^(vt|buf|res):/.test(r)) {
        fail(`read ${JSON.stringify(r)} must be namespaced 'vt:' | 'buf:' | 'res:'`);
      }
      // The rule that dissolves V2's Lighting<->Fire knot: name a RESOURCE, never an effect.
      if (typeof r === 'string' && /^res:(lighting|fire|water|cloud|tree|specular)Effect/i.test(r)) {
        fail(
          `read ${JSON.stringify(r)} names an EFFECT, not a resource. Never name another effect: ` +
            "that is how V2 got Lighting reading Fire's private _glowBucketsByFloor through a global."
        );
      }
    }
  }

  // --- tiers: the ladder must be a ladder ---
  if (!Array.isArray(decl.tiers) || decl.tiers.length === 0) {
    fail('tiers must be a non-empty array — every system declares its ladder (Effects.md)');
  } else {
    decl.tiers.forEach((t, i) => {
      if (t?.n !== i) fail(`tiers[${i}].n must equal ${i} — the ladder is contiguous from 0`);
    });
  }

  return { ok: errors.length === 0, errors };
}
