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
 * DUST MOTES are the fourth kind and the odd one out: they are not creatures, but they are the same
 * machine (a painted zone, agents that steer, a procedural body), and their brain wants the wind grid.
 * That is the eighth storage buffer, so a mote leaves two arena buffers it has no use for (`life`,
 * `phase`) unbound; see `KINDS.mote.unused`.
 *
 * @module effects/particles/critter-runtime
 */
import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import { createUniformBank, CRITTER_UNIFORM_DEFAULTS, CRITTER_KIND_DEFAULTS } from '../critters/critter-uniforms.js';
import { buildZoneSampler } from '../critters/critter-zone-sample.js';
import { readSeed, MIN_LENGTH_PX } from '../critters/critter-instance.js';
import { STAMP_STEPS } from '../critters/critter-zone.js';
import { buildFlyBrain } from '../critters/fly-brain.js';
import { buildFlyMaterials } from '../critters/fly-render.js';
import { buildMaggotBrain } from '../critters/maggot-brain.js';
import { buildMaggotMaterials } from '../critters/maggot-render.js';
import { buildFireflyBrain, FIREFLY_SYNC } from '../critters/firefly-brain.js';
import { buildFireflyMaterials } from '../critters/firefly-render.js';
import { buildMoteBrain } from '../critters/mote-brain.js';
import { buildMoteMaterials } from '../critters/mote-render.js';
import { packWindCells, WIND_CELL_VEC4_STRIDE } from '../../world/index.js';

/** The CPU clock handed to shaders is wrapped so `sin()` keeps its precision all session. */
const TIME_WRAP_SEC = 1000;
/** A frame longer than this is a hitch, not time: a fly does not teleport because the tab was hidden. */
const MAX_DT_SEC = 0.05;
/** Any state component beyond this is not a state, it is a fault (NaN fails the `< FAR` test too). */
const FAR = 1e7;
/** Two stamps differ when they are at least a step apart; half a step is the line between "same" and "not". */
const STAMP_TOLERANCE = 0.5 / STAMP_STEPS;

/**
 * Per-kind wiring: the mind, the body, and which uniforms size and pace it.
 *
 * `speedParam` is the uniform that scales the mind's clock (the author's "Tempo"); every kind has one,
 * and the weather's own `tempo` (cold slows everything) multiplies it. Null would leave a kind on real
 * time, for one whose own params already say how fast it goes.
 */
const KINDS = Object.freeze({
  fly: Object.freeze({
    unused: Object.freeze([]),
    brain: buildFlyBrain,
    materials: buildFlyMaterials,
    sizeParam: 'size',
    variationParam: 'sizeVariation',
    speedParam: 'speed',
    renderOrders: Object.freeze({ shadow: 1, body: 3 }),
  }),
  maggot: Object.freeze({
    unused: Object.freeze([]),
    brain: buildMaggotBrain,
    materials: buildMaggotMaterials,
    sizeParam: 'size',
    variationParam: 'sizeVariation',
    speedParam: 'speed',
    renderOrders: Object.freeze({ body: 0 }),
  }),
  firefly: Object.freeze({
    unused: Object.freeze([]),
    brain: buildFireflyBrain,
    materials: buildFireflyMaterials,
    sizeParam: 'size',
    variationParam: 'sizeVariation',
    speedParam: 'speed',
    colonyClock: true,
    renderOrders: Object.freeze({ body: 0, glow: 1 }),
  }),
  // A mote keeps no decision timer and no state ordinal, so `life` and `phase` are never touched and never
  // bound: five arena buffers + the zone buffer + the wind cells = 7 of the 8 a compute stage may bind.
  mote: Object.freeze({
    unused: Object.freeze(['life', 'phase']),
    wind: true,
    brain: buildMoteBrain,
    materials: buildMoteMaterials,
    sizeParam: 'size',
    variationParam: 'sizeVariation',
    speedParam: 'speed',
    renderOrders: Object.freeze({ glow: 0 }),
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
 * The wind handle's per-cell storage buffer for a kind that reads the wind grid (`windHandle.kernel`),
 * rounded UP to a bucket of cells so that a scene with a slightly different grid reuses it. Like every
 * storage buffer it can never be freed, so the caller keeps the result for the session (see
 * `critter-subsystem.js`'s `shared`).
 *
 * @param {*} THREE @param {number} cellCount
 * @returns {{node: *, cells: number}}
 */
export function allocateWindCells(THREE, cellCount) {
  const BUCKET = 16384;
  const cells = Math.max(1, Math.ceil(Math.max(1, cellCount) / BUCKET)) * BUCKET;
  return { node: THREE.TSL.instancedArray(cells * WIND_CELL_VEC4_STRIDE, 'vec4'), cells };
}

/** The grid a wind handle's kernel closes over, as a key: a different one needs a different kernel. */
export function windGridKey(handle) {
  const g = handle?.grid;
  if (!g || !handle?.cells) return 'none';
  return `${g.originX},${g.originY},${g.cellSize},${g.cols},${g.rows}|${handle.ambient ? 1 : 0}`;
}

/**
 * @param {object} deps
 * @param {*} deps.THREE - injected (this file imports none).
 * @param {'fly'|'maggot'|'firefly'|'mote'} deps.kind
 * @param {{buffers: Record<string, *>, capacity: number}} deps.memory - from {@link allocateCritterBuffers}.
 * @param {{node: *}} deps.zoneBuffer - the shared zone buffer (`createCritterZoneBuffer`).
 * @param {object} deps.plan - the tier plan (`critterTierPlan`).
 * @param {number} [deps.zDepth=0] @param {number} [deps.renderOrder=0] - the MESH's order (see fire's note: not the scene's).
 * @param {*} [deps.illumTexNode] @param {*} [deps.colorationTexNode] @param {*} [deps.depthTexNode] @param {*} [deps.depthFlagsTexNode]
 * @param {*} [deps.viewRectNode] - motes only: the viewer's `uViewRect`, for mapping a floor point to the lighting buffers.
 * @param {object|null} [deps.windHandle] @param {{node: *}|null} [deps.windCells] - motes only: the wind grid and
 *   the storage buffer its cells are packed into (`allocateWindCells`). Absent, a mote reads the map-wide wind.
 * @param {() => number} [deps.random] - the per-frame salt source. `Math.random` by default; a lab injects a seeded one.
 * @param {{seeded: boolean, signature: number|null, colony: number}|null} [deps.resume] - a predecessor's
 *   {@link resumeToken}: a tier change rebuilds the engine around the SAME arena, and the swarm in it is
 *   still a good swarm, so the successor carries on from it instead of reseeding.
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
  viewRectNode = null,
  windHandle = null,
  windCells = null,
  random = Math.random,
  resume = null,
}) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`createCritterEngine: unknown kind '${kind}' (expected ${Object.keys(KINDS).join(', ')})`);
  const TSL = THREE.TSL;
  const { Fn, instanceIndex, float, vec2, select, min, max, abs, hash } = TSL;
  const { buffers, capacity } = memory;
  const bank = createUniformBank(TSL, { ...CRITTER_UNIFORM_DEFAULTS, ...CRITTER_KIND_DEFAULTS[kind] });
  const u = bank.get;
  const zoneSampler = buildZoneSampler(TSL, { buffer: zoneBuffer.node, u });
  const unused = new Set(spec.unused);
  // The wind grid, for a kind that reads it: only when the handle has real cells AND a buffer was supplied.
  // Anything less is "no wind data" and the brain falls back to the map-wide wind, exactly as fire's does.
  const wind =
    spec.wind && windCells?.node && windHandle?.grid && windHandle?.cells
      ? { handle: windHandle, cellBuffer: windCells.node }
      : null;
  let windVersion = -1;
  const pushWindCells = (handle) => {
    if (!wind || !handle?.cells || handle.version === windVersion) return;
    packWindCells(windCells.node.value, handle.cells, handle.grid.cols * handle.grid.rows);
    windVersion = handle.version;
  };
  pushWindCells(windHandle);
  const brain = spec.brain(TSL, { u, zone: zoneSampler, wind });

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
    // A buffer a kind never touches is not read here either: a storage buffer that is bound but unused still
    // counts against the stage's eight.
    const TMR = unused.has('life') ? float(0) : buffers.life.element(i).toVar();
    const Sraw = seedNode ?? buffers.seed.element(i).toVar();
    const C = buffers.custom.element(i).toVar();
    const PH = unused.has('phase') ? float(0) : buffers.phase.element(i).toVar();
    const homeRec = zoneSampler.home(fi);
    const look = readSeed(TSL, Sraw, u(spec.variationParam));
    return {
      fi,
      P,
      V,
      AGE,
      TMR,
      C,
      PH,
      Sraw,
      // The slot's IDENTITY: what a brain hashes for a per-individual phase. The seed's fractional part is the
      // stamp of the home it last spawned under, which is the runtime's business and nobody else's.
      S: look.id,
      stamp: look.stamp,
      homeStamp: homeRec.z,
      home: vec2(homeRec.x, homeRec.y),
      zoneArea: homeRec.w,
      seed01: look.seed01,
      L: max(u(spec.sizeParam).mul(look.sizeMul), MIN_LENGTH_PX),
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
    buffers.seed.element(i).assign(slot.S.add(slot.homeStamp));
    buffers.position.element(i).assign(fresh.P);
    buffers.velocity.element(i).assign(fresh.V);
    if (!unused.has('life')) buffers.life.element(i).assign(fresh.TMR);
    buffers.custom.element(i).assign(fresh.C);
    if (!unused.has('phase')) buffers.phase.element(i).assign(fresh.PH);
    buffers.age.element(i).assign(float(99));
  })().compute(capacity);

  // ── UPDATE: perceive, decide, act — every slot, branch-free ──
  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const s = readSlot(i);
    s.zs = zoneSampler.sample(s.P);
    const dtReal = u('dt');
    s.dtReal = dtReal;
    // The pace of every decision: the author's Tempo, slowed by the cold (`tempo`). The firefly's FLASH clock
    // deliberately reads `dtReal` instead — it is a promise about flashes a second, not a pace.
    s.dt = (spec.speedParam ? dtReal.mul(u(spec.speedParam)) : dtReal).mul(u('tempo'));
    // The weather's hand on the ones that stayed (see `critter-weather.js#weatherDrive`). The wind carries only the
    // slots that are SHOWING: a slot the sky has sent in (`active` counts the ones out) is out of the world, and a
    // gale must not blow it to the far wall of the zone so that it reappears there when the air calms.
    s.windPush = u('windPush').mul(min(max(u('active').sub(s.fi), 0), 1));
    s.agitation = u('agitation');
    s.shelter = u('shelter');
    const next = brain.update(s);
    const fresh = brain.spawn(s);
    // Slots past the population have no home and are never simulated.
    const simulate = s.fi.lessThan(u('population'));
    // Three reasons to start over: the brain says the agent is lost (the paint moved under it); some part
    // of its state is not a number any more (NaN fails `abs(x) < FAR`, and a NaN is permanent: it poisons
    // every later step); or its home has changed hands (the stamp it spawned under is not the home's).
    const sound = [s.P.x, s.P.y, s.V.x, s.V.y, s.C.x, s.C.y, s.C.z, s.C.w, s.PH, s.TMR]
      .map((x) => abs(x).lessThan(FAR))
      .reduce((all, ok) => all.and(ok));
    const homeChanged = abs(s.stamp.sub(s.homeStamp)).greaterThan(STAMP_TOLERANCE);
    const dead = brain.lost(s).or(sound.not()).or(homeChanged);
    const reborn = simulate.and(dead);
    const keep = (old, advanced, fresher) => select(simulate, select(reborn, fresher, advanced), old);
    buffers.position.element(i).assign(keep(s.P, next.P, fresh.P));
    buffers.velocity.element(i).assign(keep(s.V, next.V, fresh.V));
    if (!unused.has('life')) buffers.life.element(i).assign(keep(s.TMR, next.TMR, fresh.TMR));
    buffers.custom.element(i).assign(keep(s.C, next.C, fresh.C));
    if (!unused.has('phase')) buffers.phase.element(i).assign(keep(s.PH, next.PH, fresh.PH));
    buffers.age
      .element(i)
      .assign(select(simulate, select(reborn, float(0), min(s.AGE.add(dtReal), float(1e5))), s.AGE));
    // The agent now answers to the home it is simulated under (a slot out of play keeps what it had, so
    // that coming back reads as a change).
    buffers.seed.element(i).assign(select(simulate, s.S.add(s.homeStamp), s.Sraw));
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
    viewRectNode,
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

  let seeded = Boolean(resume?.seeded);
  let zoneValid = false;
  /** A colony's shared flash clock (cycles). Integrated, so dragging the period slider never jumps it. */
  let colony = Number.isFinite(resume?.colony) ? resume.colony : random();
  let lastSignature = resume?.signature ?? null;
  let disposed = false;

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
     * reshuffle every fly) — the few slots whose zone changed hands notice through
     * their home's stamp and respawn themselves (`critter-zone.js#createSlotStamper`).
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
      if (field.signature !== lastSignature) seeded = false;
      lastSignature = field.signature;
      zoneValid = true;
    },

    /** What a successor engine needs to carry on from this one (see `deps.resume`). */
    resumeToken() {
      return { seeded, signature: lastSignature, colony };
    },

    /** How many slots are showing, as a FLOAT (the fraction is the next slot fading in). */
    setActive(count) {
      bank.set('active', Math.max(0, Math.min(capacity, Number.isFinite(count) ? count : 0)));
    },

    /** Push author/effect params. Only uniforms some kernel actually reads are touched. */
    setParams(params) {
      bank.setMany(params);
    },

    /**
     * The camera's world rect, and the frame's scene eye (`scene/scene-eye.js`). The perspective centre and
     * height are the SHARED eye's — the one the Table, Parallax, the clouds and the rain are drawn by — so a
     * firefly at height h slides exactly like a floor layer at height h. The kind's own `perspective` dial
     * then scales how tall it is drawn against that eye. No eye (a lab): the rect's centre and the 1000 px
     * camera the critters were tuned at.
     */
    setView(rect, eye = null) {
      if (eye && Number.isFinite(eye.height) && eye.height > 0) {
        bank.set('camCentre', [eye.x, eye.y]);
        bank.set('camHeight', eye.height);
      } else {
        bank.set('camCentre', [(rect.minX + rect.maxX) * 0.5, (rect.minY + rect.maxY) * 0.5]);
      }
      // Where a world point lands in the lighting buffers, for a kind with no viewer-owned `viewRectNode`.
      bank.set('viewMin', [rect.minX, rect.minY]);
      bank.set('viewSize', [Math.max(1, rect.maxX - rect.minX), Math.max(1, rect.maxY - rect.minY)]);
    },

    /** Refresh the wind cells in place after a rebake (same grid; a regrid needs a new engine, see `windGridKey`). */
    updateWind(handle) {
      pushWindCells(handle);
    },

    /**
     * Give back what the renderer holds for this engine: its draw geometry, its materials and the pipelines
     * both kernels compiled into. The ARENA is not touched — a storage buffer cannot be freed, and the next
     * engine is handed the same one (`allocateCritterBuffers`). Safe to call twice.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      seedKernel.dispose();
      updateKernel.dispose();
      geometry.dispose();
      for (const material of Object.values(mats)) material?.dispose?.();
      zoneValid = false;
    },

    /** The first-seed pass, exposed so a lab can force it. */
    init(renderer) {
      if (seeded || !zoneValid) return;
      bank.set('rand', random());
      renderer.compute(seedKernel);
      seeded = true;
    },

    step(renderer, { dtSec, tMs, worldRect, eye = null }) {
      if (!zoneValid || disposed) return;
      if (worldRect) this.setView(worldRect, eye);
      // ONE step length for everything that keeps time. The colony's clock must advance by exactly what the
      // fireflies' own clocks do, or a hitch (a hidden tab) would leave them a long way from the beat.
      const dt = Math.min(MAX_DT_SEC, Math.max(0, Number.isFinite(dtSec) ? dtSec : 0));
      bank.set('dt', dt);
      bank.set('timeSec', ((tMs || 0) / 1000) % TIME_WRAP_SEC);
      // The wind field's noise runs on the unwrapped clock: wrapping it would jump every eddy once per wrap.
      if (wind) bank.set('windTimeMs', tMs || 0);
      bank.set('rand', random());
      if (spec.colonyClock) {
        colony = (colony + dt / Math.max(FIREFLY_SYNC.PERIOD_FLOOR, u('flashPeriod').value)) % 1;
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
      // A buffer the kind never binds has no GPU backing to read (`KINDS.mote.unused`): it reads as empty.
      const skipped = (stride) => ({ data: new Float32Array(0), stride });
      const [position, velocity, age, life, seed, custom, phase] = await Promise.all([
        read(buffers.position, 2),
        read(buffers.velocity, 2),
        read(buffers.age, 1),
        unused.has('life') ? skipped(1) : read(buffers.life, 1),
        read(buffers.seed, 1),
        read(buffers.custom, 4),
        unused.has('phase') ? skipped(1) : read(buffers.phase, 1),
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
