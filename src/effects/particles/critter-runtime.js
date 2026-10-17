/**
 * THE CRITTER ENGINE — flies, maggots and fireflies: GPU AGENTS, not particles.
 *
 * The fourth runtime under the particle roof (after dust, gusts and fire — see
 * `particle-engine.js`), and the first whose particles DECIDE things. Same
 * doctrine, enforced by the same walls:
 *
 *   • ONE arena for the agents' memory (`particle-arena.js`): a slot is a row
 *     across seven storage buffers, never a JavaScript object. V2's flies were a
 *     `particle.userData` bag each, updated by a JS `FlyBehavior.update()` per
 *     fly per frame; that object was its bottleneck.
 *   • ONE shared storage buffer for the perception field (`critter-zone-buffer.js`).
 *   • The mind is a COMPUTE KERNEL (`fly-brain.js` etc.), the body a MATERIAL
 *     (`fly-render.js` etc.) — both pure TSL builders under `effects/critters/`.
 *     This file is only the skeleton: it allocates nothing but the draw geometry,
 *     builds the two kernels, dispatches them and owns the uniform bank.
 *
 * ============================================================================
 * WHAT "INTELLIGENT" MEANS HERE
 * ============================================================================
 *
 * Each agent, every frame: PERCEIVES (one bilinear lookup of the zone field: how
 * far from the rim, which way is in), REMEMBERS (its state ordinal, a timer, a gait
 * phase, a target heading — a few floats), DECIDES (rolls hazards: land, take off,
 * start a dart, choose a walking target) and ACTS (integrates its own velocity).
 * That is a classic agent loop; what makes it affordable is that the loop body is
 * branch-free arithmetic over storage buffers, so ten thousand agents are one
 * dispatch. It is NOT synchronised between clients, and it never touches
 * gameplay: each client's kernel rolls its own dice (`uRand` is `Math.random()`),
 * which is what makes it free.
 *
 * ============================================================================
 * STORAGE-BUFFER BUDGET
 * ============================================================================
 *
 * WebGPU guarantees 8 storage buffers per shader stage. The compute stage binds
 * position, velocity, age, life, seed, custom, phase (7) + the zone buffer (8).
 * The vertex stage binds the seven agent buffers only. There is no room for a
 * ninth; anything new must be PACKED into these (see how `life` doubles as the
 * decision timer and `custom` carries heading / height / gait / aux).
 *
 * @module effects/particles/critter-runtime
 */
import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import { createUniformBank, CRITTER_UNIFORM_DEFAULTS, CRITTER_KIND_DEFAULTS } from '../critters/critter-uniforms.js';
import { buildZoneSampler } from '../critters/critter-zone-sample.js';
import { buildFlyBrain } from '../critters/fly-brain.js';
import { buildFlyMaterials } from '../critters/fly-render.js';
import { buildMaggotBrain } from '../critters/maggot-brain.js';
import { buildMaggotMaterials } from '../critters/maggot-render.js';
import { buildFireflyBrain } from '../critters/firefly-brain.js';
import { buildFireflyMaterials } from '../critters/firefly-render.js';

/** The CPU clock handed to shaders is wrapped so `sin()` keeps its precision all session. */
const TIME_WRAP_SEC = 1000;
/** A frame longer than this is a hitch, not time: a fly does not teleport because the tab was hidden. */
const MAX_DT_SEC = 0.05;

/**
 * Per-kind wiring: the mind, the body, and which uniforms size and pace it.
 *
 * `speedParam` is the uniform that scales the mind's clock (the author's "Tempo");
 * null leaves it on real time, for a kind whose own params already say how fast it goes.
 */
const KINDS = Object.freeze({
  fly: Object.freeze({
    brain: buildFlyBrain,
    materials: buildFlyMaterials,
    sizeParam: 'size',
    variationParam: 'sizeVariation',
    speedParam: 'speed',
    renderOrders: Object.freeze({ shadow: 1, body: 3 }),
  }),
  maggot: Object.freeze({
    brain: buildMaggotBrain,
    materials: buildMaggotMaterials,
    sizeParam: 'maggotSize',
    variationParam: 'sizeVariation',
    speedParam: null,
    renderOrders: Object.freeze({ body: 0 }),
  }),
  firefly: Object.freeze({
    brain: buildFireflyBrain,
    materials: buildFireflyMaterials,
    sizeParam: 'size',
    variationParam: 'sizeVariation',
    speedParam: 'speed',
    colonyClock: true,
    renderOrders: Object.freeze({ body: 0, glow: 1 }),
  }),
});

/**
 * Allocate a kind's agent memory. SEPARATE from {@link createCritterEngine} on
 * purpose: a tier change rebuilds the kernels and materials (a rung changes which
 * shader nodes exist), but the arena must NEVER be reallocated — a storage buffer
 * cannot be freed (`particle-arena.js`), so a rebuilt engine reuses the buffers
 * its predecessor wrote, and the swarm carries on where it was.
 *
 * @param {*} THREE @param {number} capacity
 * @returns {{arena: ParticleArena, buffers: Record<string, *>, capacity: number}}
 */
export function allocateCritterBuffers(THREE, capacity) {
  const cap = Math.max(1, Math.floor(capacity));
  const arena = new ParticleArena({ budgetBytes: BYTES_PER_PARTICLE * cap });
  return { arena, buffers: arena.allocateBuffers(THREE.TSL), capacity: cap };
}

/**
 * @param {object} deps
 * @param {*} deps.THREE - injected (this file imports none).
 * @param {'fly'|'maggot'|'firefly'} deps.kind
 * @param {{buffers: Record<string, *>, capacity: number}} deps.memory - from {@link allocateCritterBuffers}.
 * @param {{node: *}} deps.zoneBuffer - the shared zone buffer (`createCritterZoneBuffer`).
 * @param {object} deps.plan - the tier plan (`critterTierPlan`).
 * @param {number} [deps.zDepth=0] @param {number} [deps.renderOrder=0] - the MESH's order (see fire's note: not the scene's).
 * @param {*} [deps.illumTexNode] @param {*} [deps.colorationTexNode] @param {*} [deps.depthTexNode] @param {*} [deps.depthFlagsTexNode]
 * @param {() => number} [deps.random] - the per-frame salt source. `Math.random` by default; a lab injects a seeded one.
 */
export function createCritterEngine({
  THREE,
  kind,
  memory,
  zoneBuffer,
  plan,
  zDepth = 0,
  renderOrder = 0,
  illumTexNode = null,
  colorationTexNode = null,
  depthTexNode = null,
  depthFlagsTexNode = null,
  random = Math.random,
}) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`createCritterEngine: unknown kind '${kind}' (expected ${Object.keys(KINDS).join(', ')})`);
  const TSL = THREE.TSL;
  const { Fn, instanceIndex, float, vec2, select, fract, sin, min, abs, hash } = TSL;
  const { buffers, capacity } = memory;
  const bank = createUniformBank(TSL, { ...CRITTER_UNIFORM_DEFAULTS, ...CRITTER_KIND_DEFAULTS[kind] });
  const u = bank.get;
  const zoneSampler = buildZoneSampler(TSL, { buffer: zoneBuffer.node, u });
  const brain = spec.brain(TSL, { u, zone: zoneSampler });

  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));
  // 24 fresh random bits per frame from the CPU (a float holds an integer this size exactly).
  const frameSalt = u('rand').mul(16777216).floor().toUint();

  /**
   * Everything a brain needs to know about one slot, read once.
   * @param {*} i - the slot (the kernel's instance index).
   * @param {*} [seedNode] - overrides the stored seed; the seed pass uses it because the stored
   *   one is only written at the END of that pass.
   */
  function readSlot(i, seedNode = null) {
    const fi = float(i);
    const P = buffers.position.element(i).toVar();
    const V = buffers.velocity.element(i).toVar();
    const AGE = buffers.age.element(i).toVar();
    const TMR = buffers.life.element(i).toVar();
    const S = seedNode ?? buffers.seed.element(i).toVar();
    const C = buffers.custom.element(i).toVar();
    const PH = buffers.phase.element(i).toVar();
    const homeRec = zoneSampler.home(fi);
    const sizeMul = float(1).add(hash11(S.mul(1.7).add(3.1)).sub(0.5).mul(2).mul(u(spec.variationParam)));
    return {
      fi,
      P,
      V,
      AGE,
      TMR,
      S,
      C,
      PH,
      home: vec2(homeRec.x, homeRec.y),
      zoneArea: homeRec.w,
      seed01: hash11(S.mul(3.1).add(0.5)),
      L: u(spec.sizeParam).mul(sizeMul),
      // Per-frame, per-slot, per-decision randomness. Every client rolls its own.
      // PCG (`TSL.hash`) rather than `fract(sin(x)·43758)`: that hash over-fires small
      // probabilities (measured on the GPU: 28% too many hits at p = 0.0033, and a take-off
      // hazard of 0.04/s ran at 0.11/s), and a per-frame hazard is exactly a small probability.
      rnd: (k) =>
        hash(
          i
            .mul(747796405)
            .add(frameSalt.mul(2654435761))
            .add(k * 1664525 + 1013904223)
        ),
      tSec: u('timeSec'),
    };
  }

  // ── SEED: spread the population over the zone, staggered, already faded in ──
  const seedKernel = Fn(() => {
    const i = instanceIndex;
    const slot = readSlot(i, float(i).add(1));
    slot.zs = zoneSampler.sample(slot.P);
    slot.dt = float(0);
    const fresh = brain.spawn(slot);
    buffers.seed.element(i).assign(slot.S);
    buffers.position.element(i).assign(fresh.P);
    buffers.velocity.element(i).assign(fresh.V);
    buffers.life.element(i).assign(fresh.TMR);
    buffers.custom.element(i).assign(fresh.C);
    buffers.phase.element(i).assign(fresh.PH);
    buffers.age.element(i).assign(float(99));
  })().compute(capacity);

  // ── UPDATE: perceive, decide, act — every slot, branch-free ──
  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const s = readSlot(i);
    s.zs = zoneSampler.sample(s.P);
    const dtReal = u('dt');
    s.dt = spec.speedParam ? dtReal.mul(u(spec.speedParam)) : dtReal;
    const next = brain.update(s);
    const fresh = brain.spawn(s);
    // Slots past the population have no home and are never simulated.
    const simulate = s.fi.lessThan(u('population'));
    const dead = brain.lost(s).or(abs(s.P.x).greaterThan(1e7)).or(abs(s.P.y).greaterThan(1e7));
    const reborn = simulate.and(dead);
    const keep = (old, advanced, fresher) => select(simulate, select(reborn, fresher, advanced), old);
    buffers.position.element(i).assign(keep(s.P, next.P, fresh.P));
    buffers.velocity.element(i).assign(keep(s.V, next.V, fresh.V));
    buffers.life.element(i).assign(keep(s.TMR, next.TMR, fresh.TMR));
    buffers.custom.element(i).assign(keep(s.C, next.C, fresh.C));
    buffers.phase.element(i).assign(keep(s.PH, next.PH, fresh.PH));
    buffers.age
      .element(i)
      .assign(select(simulate, select(reborn, float(0), min(s.AGE.add(dtReal), float(1e5))), s.AGE));
  })().compute(capacity);

  // ── DRAW: one instanced quad per slot, built once ──
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.attributes.position);
  geometry.setAttribute('uv', base.attributes.uv);
  geometry.instanceCount = capacity;

  const mats = spec.materials(TSL, THREE, {
    buffers,
    u,
    plan,
    illumTexNode,
    colorationTexNode,
    depthTexNode,
    depthFlagsTexNode,
    zDepth,
  });
  const scene = new THREE.Scene();
  const meshes = [];
  for (const [role, material] of Object.entries(mats)) {
    if (!material) continue;
    const mesh = new THREE.Mesh(geometry, material);
    // World-space bounds vary per frame; culling is the GPU's job (fire's own note).
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder + (spec.renderOrders[role] ?? 0);
    scene.add(mesh);
    meshes.push(mesh);
  }

  let seeded = false;
  let zoneValid = false;
  /** A colony's shared flash clock (cycles). Integrated, so dragging the period slider never jumps it. */
  let colony = random();
  let lastSignature = null;

  return {
    scene,
    capacity,
    kind,
    /** True when there is something to draw: a zone, slots, and any of them showing. */
    get hasContent() {
      return zoneValid && u('population').value > 0 && u('active').value > 0.001;
    },

    /**
     * Point the engine at a zone. Cheap and idempotent; call when the field or the
     * population changes, never per frame. A NEW FIELD reseeds the swarm (the paint
     * moved under it); a population-only change does not (a slider drag must not
     * reshuffle every fly).
     *
     * @param {{field: object|null, homesOffset: number, population: number}} a
     */
    setZone({ field, homesOffset, population }) {
      if (!field || population <= 0) {
        zoneValid = false;
        bank.set('population', 0);
        return;
      }
      bank.set('zoneOrigin', [field.originX, field.originY]);
      bank.set('zoneCell', [field.cellW, field.cellH]);
      bank.set('zoneDims', [field.cols, field.rows]);
      bank.set('homesOffset', homesOffset);
      bank.set('population', population);
      if (!zoneValid || field.signature !== lastSignature) seeded = false;
      lastSignature = field.signature;
      zoneValid = true;
    },

    /** How many slots are showing, as a FLOAT (the fraction is the next slot fading in). */
    setActive(count) {
      bank.set('active', Math.max(0, Math.min(capacity, Number.isFinite(count) ? count : 0)));
    },

    /** Push author/effect params. Only uniforms some kernel actually reads are touched. */
    setParams(params) {
      bank.setMany(params);
    },

    /** The camera's world rect: the perspective centre follows the view (fire's own contract). */
    setView(rect) {
      bank.set('camCentre', [(rect.minX + rect.maxX) * 0.5, (rect.minY + rect.maxY) * 0.5]);
    },

    /** The first-seed pass, exposed so a lab can force it. */
    init(renderer) {
      if (seeded || !zoneValid) return;
      bank.set('rand', random());
      renderer.compute(seedKernel);
      seeded = true;
    },

    step(renderer, { dtSec, tMs, worldRect }) {
      if (!zoneValid) return;
      if (worldRect) this.setView(worldRect);
      bank.set('dt', Math.min(MAX_DT_SEC, Math.max(0, Number.isFinite(dtSec) ? dtSec : 0)));
      bank.set('timeSec', ((tMs || 0) / 1000) % TIME_WRAP_SEC);
      bank.set('rand', random());
      if (spec.colonyClock) {
        colony =
          (colony + (Number.isFinite(dtSec) ? Math.max(0, dtSec) : 0) / Math.max(0.5, u('flashPeriod').value)) % 1;
        bank.set('colonyPhase', colony);
      }
      if (!seeded) this.init(renderer);
      // Synchronous — never computeAsync in-frame, which awaits a readback and would stall the loop.
      renderer.compute(updateKernel);
    },

    /** Read the agents back to the CPU. DIAGNOSTIC ONLY: a GPU readback stalls the pipeline. */
    async readback(renderer, count = capacity) {
      const n = Math.min(capacity, count);
      // Floats per slot are read off the buffer rather than assumed: a vec2 storage layout
      // may come back padded to a vec4 (`particle-runtime.js#readbackVelocities` auto-detects
      // for the same reason), and a wrong stride would scramble every agent silently.
      const read = async (node, minStride) => {
        const all = new Float32Array(await renderer.getArrayBufferAsync(node.value));
        const stride = Math.max(minStride, Math.round(all.length / capacity));
        return { data: all.subarray(0, n * stride), stride };
      };
      const [position, velocity, age, life, seed, custom, phase] = await Promise.all([
        read(buffers.position, 2),
        read(buffers.velocity, 2),
        read(buffers.age, 1),
        read(buffers.life, 1),
        read(buffers.seed, 1),
        read(buffers.custom, 4),
        read(buffers.phase, 1),
      ]);
      return {
        position: position.data,
        positionStride: position.stride,
        velocity: velocity.data,
        velocityStride: velocity.stride,
        age: age.data,
        ageStride: age.stride,
        life: life.data,
        lifeStride: life.stride,
        seed: seed.data,
        seedStride: seed.stride,
        custom: custom.data,
        customStride: custom.stride,
        phase: phase.data,
        phaseStride: phase.stride,
      };
    },

    debugState() {
      const out = { kind, capacity, seeded, zoneValid, uniforms: {} };
      for (const name of bank.names()) {
        const v = u(name).value;
        out.uniforms[name] = typeof v === 'number' ? v : (v?.toArray?.() ?? null);
      }
      return out;
    },

    /** Bound meshes, for a lab or a perf probe. */
    get meshes() {
      return meshes;
    },
  };
}
