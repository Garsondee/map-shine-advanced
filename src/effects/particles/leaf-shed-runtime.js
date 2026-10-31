/**
 * LEAF SHED — runtime (the engine for {@link LEAF_SHED}, `effects/leaf-shed.js`).
 *
 * The FIFTH runtime under the particle roof (dust, gusts, fire, critters, and
 * this), for the same reason each of the others is its own: what a body IS
 * differs. A shed leaf is born somewhere SPECIFIC (under a painted canopy, in
 * that canopy's colour), so its birth is decided on the CPU, where the canopies
 * are known; everything after that — riding the air, falling, flipping,
 * skittering, fading — is a compute kernel over the arena, like every other
 * particle here. There is no per-leaf JavaScript object.
 *
 * ============================================================================
 * HOW A BIRTH REACHES THE GPU WITHOUT CLOBBERING THE FLIGHT
 * ============================================================================
 * The CPU writes a BIRTH RECORD per slot into a storage buffer only it writes
 * (`effects/leaf-shed-birth.js` has the layout and the stamp). The kernel starts
 * a new leaf in any slot whose record's stamp differs from the stamp it last
 * started from (kept in the arena's `seed` row). The CPU never writes position,
 * velocity or age, so it never overwrites what the kernel has integrated —
 * its own copy of those is stale by construction (`no-gpu-readback`). Only the
 * slots born this frame are uploaded (`addUpdateRange`; three's WebGPU backend
 * writes each range with its own `writeBuffer`).
 *
 * ============================================================================
 * THE GUST DECIDES
 * ============================================================================
 * The CPU proposes births from the PREVAILING wind at each canopy (the dial ×
 * that spot's openness) — it has no CPU twin of the gust field. Each proposal
 * carries how hard the CPU thought the wind was (`ramp`), and the kernel,
 * which DOES read the real local air (`windHandle.kernel`: gusts, turbulence,
 * walls), keeps the leaf with probability `localRamp / (OVER_PROPOSE × ramp)`.
 * So the average matches the dial, but leaves tear off in bursts as each gust
 * front crosses a tree and hardly at all in the lulls — which is what a gale
 * through a wood looks like.
 *
 * ============================================================================
 * STORAGE BUFFERS — 8 in the compute stage, the guaranteed floor
 * ============================================================================
 * position, velocity, age, life, seed (= the stamp), custom (arena: 6; `phase`
 * is never referenced so never bound) + the birth records + the wind cells.
 * The vertex stage binds position, age, life, custom and the birth records.
 *
 *   custom = (heightPx, angle, flip, kept)   kept: 1 a live leaf, 0 refused
 *   life   = −1 while airborne; on landing, the age at which it dies.
 *
 * ============================================================================
 * DRAWN AFTER LIGHTING, UNDER WHATEVER IS ABOVE IT
 * ============================================================================
 * The leaves draw into `scene.lit` in the `surface.particles` pass, lit the way
 * every critter is (`critters/critter-surface.js#litLinear`: the scene's own
 * illumination and coloration at that pixel, no second lighting model) and
 * gated by the depth authority (`occlusionGate`): canopies are drawn into
 * `buf:scene.depth`, so a leaf under a tree — born there, or blown back under
 * the next one — is hidden by it, and appears as it slides out from under the
 * painted leaves. That is the whole of "shed from below the tree graphic".
 *
 * THREE is INJECTED (never imported) so this module's top level stays
 * Node-safe; the kernel and material can only be verified on a GPU (the leaf
 * lab, `tools/shader-lab/leaf-shed-lab.html`, runs this file over the author's
 * real canopy art).
 *
 * @module effects/particles/leaf-shed-runtime
 */

import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import {
  createWindHandle,
  packWindCells,
  WIND_CELL_VEC4_STRIDE,
  deflectAroundWalls,
  WALL_MOMENTUM_GUARD_LOW,
  WALL_MOMENTUM_GUARD_HIGH,
  WIND_DEFAULT_PIXELS_PER_METRE,
  windFieldPxPerSecPerUnit,
} from '../../world/index.js';
import { createLogger } from '../../core/log.js';
import {
  BIRTH_VEC4_PER_SLOT,
  BIRTH_FLOATS_PER_SLOT,
  createBirthRing,
  unpackBirthTagNodes,
  writeBirth,
} from '../leaf-shed-birth.js';
import { buildShedLook, shedCoverage } from '../leaf-shed-shape.js';
import { OVER_PROPOSE } from '../leaf-shed-sources.js';
import { litLinear, occlusionGate } from '../critters/critter-surface.js';

const log = createLogger('leaf-shed-runtime');

const TIER0_WIND_HANDLE = createWindHandle();
/** Field magnitude → m/s (the dial is linear to 70 m/s — `world/wind-scale.js`). */
const MPS_PER_FIELD_UNIT = windFieldPxPerSecPerUnit(1);
/** A frame longer than this is a hitch, not time. */
const MAX_DT_SEC = 0.05;
/** A leaf still airborne after this long is put down (an updraft cannot keep one aloft forever). */
const MAX_AIR_SEC = 14;
/** Seconds a leaf takes to fade in once it is born (it starts under a canopy, so this is short). */
const FADE_IN_SEC = 0.15;
/** Seconds of its ground time a leaf spends fading out. */
const FADE_OUT_SEC = 1.2;

/**
 * Per-kind motion, [leaf, clump, twig]. A twig is heavy: it falls fast, barely
 * flutters, and the air carries it a fraction as far. Tuned in the leaf lab.
 */
const KIND_CARRY = [1, 0.72, 0.45];
const KIND_TAU_SEC = [0.3, 0.5, 0.9];
const KIND_FALL_MPS = [1.5, 2.4, 4.5];
const KIND_FLUTTER = [1, 0.5, 0.12];

/**
 * @param {object} opts
 * @param {*} opts.THREE - injected.
 * @param {number} opts.capacity - slots (see `leafShedCapacity`). Fixed for the engine's life.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} opts.sceneRect - a leaf leaving it dies.
 * @param {number} [opts.zDepth]
 * @param {object} [opts.windHandle] - THE wind handle; refresh with {@link updateWind}.
 * @param {*} [opts.illumTexNode] @param {*} [opts.colorationTexNode] - the scene's lighting buffers (texture nodes).
 * @param {*} [opts.depthTexNode] @param {*} [opts.depthFlagsTexNode] - the depth authority (the occlusion gate).
 * @param {number} [opts.renderOrder]
 */
export function createLeafShedEngine({
  THREE,
  capacity: requested,
  sceneRect,
  zDepth = 0,
  windHandle = TIER0_WIND_HANDLE,
  illumTexNode = null,
  colorationTexNode = null,
  depthTexNode = null,
  depthFlagsTexNode = null,
  renderOrder = 0,
}) {
  const TSL = THREE.TSL;
  const {
    Fn,
    If,
    instanceIndex,
    int,
    float,
    vec2,
    vec3,
    vec4,
    uniform,
    sin,
    cos,
    fract,
    exp,
    smoothstep,
    max,
    min,
    abs,
    floor,
    select,
    clamp,
    fwidth,
    dot,
    positionGeometry,
  } = TSL;

  const capacity = Math.max(16, Math.floor(requested || 0));
  const arena = new ParticleArena({ budgetBytes: BYTES_PER_PARTICLE * capacity });
  const buffers = arena.allocateBuffers(TSL);
  const { position, velocity, age, life, seed, custom } = buffers;

  // The birth records — CPU-written only (see the header).
  const birth = TSL.instancedArray(capacity * BIRTH_VEC4_PER_SLOT, 'vec4');
  const birthAttr = birth.value;
  const birthBacking = birthAttr.array;
  if (birthBacking.length !== capacity * BIRTH_FLOATS_PER_SLOT) {
    throw new Error(
      `leaf shed: birth buffer is ${birthBacking.length} floats, expected ${capacity * BIRTH_FLOATS_PER_SLOT} ` +
        '(instancedArray no longer exposes a flat Float32Array — the writer and the kernel would disagree)'
    );
  }
  const ring = createBirthRing(capacity);

  // The wind cells (the gust engine's own pattern: uploaded once, refreshed in place on a rebake).
  let windCells = null;
  let cellCols = 1;
  let cellRows = 1;
  let windHandleVersion = windHandle?.version ?? -1;
  if (windHandle?.grid && windHandle?.cells) {
    cellCols = windHandle.grid.cols;
    cellRows = windHandle.grid.rows;
    const n = Math.max(1, cellCols * cellRows);
    windCells = TSL.instancedArray(n * WIND_CELL_VEC4_STRIDE, 'vec4');
    packWindCells(windCells.value, windHandle.cells, n);
  }

  // ── uniforms ────────────────────────────────────────────────────────────
  const uDtSec = uniform(0);
  const uTimeMs = uniform(0);
  const uRectMin = uniform(vec2(sceneRect.minX, sceneRect.minY));
  const uRectMax = uniform(vec2(sceneRect.maxX, sceneRect.maxY));
  const uStartMps = uniform(11);
  const uFullMps = uniform(26);
  const uCarry = uniform(0.8);
  const uFlutter = uniform(1);
  const uGroundSec = uniform(4);
  const uShadow = uniform(0.45);
  const uInkPx = uniform(2.4);
  // World px of shadow throw per px of height — the sun's own projection (the viewer's `projectShadowOffset`).
  const uShadowThrow = uniform(vec2(0.25, 0.38));
  // 1 by day, 0 at night: a leaf casts no sun shadow in the dark.
  const uShadowDay = uniform(1);
  // Size gain per px of height — a gentle 'nearer is bigger' (see the draw's note).
  const uLiftScale = uniform(0);
  const uExpectedDepth = uniform(0);
  const pixelsPerMetreNode = windHandle?.ambient?.pixelsPerMetre ?? float(WIND_DEFAULT_PIXELS_PER_METRE);
  const pxPerSecPerFieldUnit = windFieldPxPerSecPerUnit(pixelsPerMetreNode);

  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));
  const byKind = (kind, table) =>
    select(kind.lessThan(0.5), float(table[0]), select(kind.lessThan(1.5), float(table[1]), float(table[2])));

  const sampleAir = (pos) => {
    const w = windHandle.kernel(TSL, { centerXY: pos, time: uTimeMs, cellBuffer: windCells });
    const air = w.coherent.mul(w.openness).add(w.turbulence);
    return { air, w };
  };

  // ── the kernel ──────────────────────────────────────────────────────────
  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const rec0 = birth.element(int(i).mul(2));
    const rec1 = birth.element(int(i).mul(2).add(1));
    const stamp = rec0.z;
    const tag = unpackBirthTagNodes(TSL, rec0.w);
    const kind = tag.kind;
    // Stable per-leaf randomness: the stamp is unique per birth.
    const r = (salt) => hash11(stamp.mul(0.6180339).add(float(salt)));

    If(stamp.notEqual(seed.element(i)), () => {
      // ── A BIRTH ──
      seed.element(i).assign(stamp);
      const pos = rec0.xy;
      const { air } = sampleAir(pos);
      const localMps = air.length().mul(float(MPS_PER_FIELD_UNIT));
      const localRamp = smoothstep(uStartMps, uFullMps, localMps);
      const keepP = clamp(localRamp.div(max(tag.ramp01, 1 / 63).mul(OVER_PROPOSE)), 0, 1);
      const kept = r(1.7).lessThan(keepP);
      position.element(i).assign(pos);
      velocity.element(i).assign(air.mul(pxPerSecPerFieldUnit).mul(uCarry).mul(byKind(kind, KIND_CARRY)).mul(0.3));
      age.element(i).assign(0);
      life.element(i).assign(select(kept, float(-1), float(0)));
      custom.element(i).assign(vec4(rec1.w, r(2.3).mul(6.2832), r(3.1).mul(6.2832), select(kept, float(1), float(0))));
    }).Else(() => {
      const a = age.element(i);
      const lf = life.element(i);
      If(lf.lessThan(0).or(a.lessThan(lf)), () => {
        // ── A FLIGHT ──
        const pos = position.element(i);
        const vel = velocity.element(i);
        const c = custom.element(i);
        const airborne = c.x.greaterThan(0);
        const dt = uDtSec;
        const { air, w } = sampleAir(pos);
        const airPx = air.mul(pxPerSecPerFieldUnit);
        const localMps = air.length().mul(float(MPS_PER_FIELD_UNIT));
        const carry = uCarry.mul(byKind(kind, KIND_CARRY));
        // On the ground the air only drags a leaf once it is properly blowing.
        const groundPush = smoothstep(uStartMps.mul(0.5), uFullMps, localMps).mul(0.35);
        const target = select(airborne, airPx.mul(carry), airPx.mul(carry).mul(groundPush));
        const tau = select(airborne, byKind(kind, KIND_TAU_SEC), float(0.18));
        const v1 = vel.add(target.sub(vel).mul(float(1).sub(exp(dt.negate().div(tau)))));
        // Flutter: a sideways swing across the direction of travel, airborne only.
        const speed = v1.length();
        const dir = select(speed.greaterThan(1e-3), v1.div(max(speed, 1e-3)), vec2(1, 0));
        const perp = vec2(dir.y.negate(), dir.x);
        const omega = float(3.5).add(r(4.7).mul(4));
        const swing = sin(a.mul(omega).add(r(5.3).mul(6.2832)));
        const flutterK = byKind(kind, KIND_FLUTTER).mul(uFlutter);
        const flutterPx = pixelsPerMetreNode
          .mul(1.1)
          .mul(flutterK)
          .mul(select(airborne, float(1), float(0)));
        let move = v1.add(perp.mul(swing).mul(flutterPx));
        if (windCells) {
          const guard = smoothstep(float(WALL_MOMENTUM_GUARD_LOW), float(WALL_MOMENTUM_GUARD_HIGH), w.wallProximity);
          move = deflectAroundWalls(TSL, {
            vector: move,
            awayDirX: w.wallAwayDirX,
            awayDirY: w.wallAwayDirY,
            proximity: guard,
            chaosDirX: float(0),
            chaosDirY: float(0),
            chaosAmount: float(0),
          });
        }
        const next = pos.add(move.mul(dt));
        // Falling: a leaf glides in pulses (it sinks fastest on each swing's turn).
        const fallMps = byKind(kind, KIND_FALL_MPS).mul(float(0.8).add(r(6.1).mul(0.4)));
        const glide = float(1).add(abs(swing).sub(0.5).mul(flutterK).mul(0.9));
        const h1 = max(c.x.sub(fallMps.mul(pixelsPerMetreNode).mul(dt).mul(glide)), 0);
        const landsNow = airborne.and(h1.lessThanEqual(0));
        const tooLong = airborne.and(a.greaterThan(MAX_AIR_SEC));
        const groundLife = uGroundSec.mul(float(0.7).add(r(7.9).mul(0.6)));
        const lf1 = select(landsNow.or(tooLong), a.add(groundLife), lf);
        const h2 = select(tooLong, float(0), h1);
        // Turning: spin and flip while airborne; on the ground it rolls with its speed and settles flat.
        const spinSign = select(r(8.3).greaterThan(0.5), float(1), float(-1));
        const spin = spinSign
          .mul(float(1.5).add(r(9.1).mul(3.5)))
          .mul(select(kind.greaterThan(1.5), float(0.4), float(1)));
        const roll = clamp(speed.div(pixelsPerMetreNode.mul(2)), 0, 1).mul(0.3);
        const angle = c.y.add(spin.mul(dt).mul(select(airborne, float(1), roll)));
        const flipRate = float(2).add(r(10.7).mul(5)).mul(flutterK);
        const settled = floor(c.z.div(Math.PI).add(0.5)).mul(Math.PI);
        const flip = select(airborne, c.z.add(flipRate.mul(dt)), c.z.add(settled.sub(c.z).mul(min(dt.mul(6), 1))));
        const out = next.x
          .lessThan(uRectMin.x)
          .or(next.y.lessThan(uRectMin.y))
          .or(next.x.greaterThan(uRectMax.x))
          .or(next.y.greaterThan(uRectMax.y));
        position.element(i).assign(next);
        velocity.element(i).assign(v1);
        custom.element(i).assign(vec4(h2, angle.mod(6.2832), flip.mod(6.2832), c.w));
        age.element(i).assign(a.add(dt));
        // Leaving the scene ends it (nothing renders in the padding).
        life.element(i).assign(select(out, a, lf1));
      });
    });
  })().compute(capacity);

  // ── the draw ────────────────────────────────────────────────────────────
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('uv', base.getAttribute('uv'));
  geometry.instanceCount = capacity;

  const corner = positionGeometry.xy; // ±0.5
  const iRec0 = birth.element(int(instanceIndex).mul(2));
  const iRec1 = birth.element(int(instanceIndex).mul(2).add(1));
  const iTag = unpackBirthTagNodes(TSL, iRec0.w);
  const iC = custom.element(instanceIndex);
  const iAge = age.element(instanceIndex);
  const iLife = life.element(instanceIndex);
  const iPos = position.element(instanceIndex);
  const alive = iLife.lessThan(0).or(iAge.lessThan(iLife)).and(iC.w.greaterThan(0.5));
  const fadeIn = clamp(iAge.div(FADE_IN_SEC), 0, 1);
  const fadeOut = select(iLife.lessThan(0), float(1), clamp(iLife.sub(iAge).div(FADE_OUT_SEC), 0, 1));
  const fade = select(alive, fadeIn.mul(fadeOut), float(0));
  const h = max(iC.x, 0);
  // NOT the critters' eye law. The canopies a leaf falls from are flat art (only the parallax layers
  // lift whole floors), and a leaf 7 m up under an 870 px eye would draw 2.4× its size, pushed
  // outward off its own tree — out from under the canopy before it had left it. A gentle size
  // lift (≈1.35× at the crown) keeps the 'nearer is bigger' cue without moving it.
  const leafCentre = iPos;
  const half = iTag.sizePx.mul(0.5).mul(float(1).add(h.mul(uLiftScale)));
  // The cast shadow lands on the ground, thrown down-sun by the leaf's height like every other
  // caster's — capped at a few leaf-lengths so a high leaf's shadow stays a depth cue, not an
  // overdraw bill (a dusk sun throws long).
  const throwPx = uShadowThrow.mul(h);
  const throwLen = throwPx.length();
  const shadowCentre = iPos.add(throwPx.mul(min(float(1), half.mul(4).div(max(throwLen, 1e-3)))));
  const pad = half.mul(1.15).add(2);
  const lo = min(leafCentre, shadowCentre).sub(pad);
  const hi = max(leafCentre, shadowCentre).add(pad);
  const quadCentre = lo.add(hi).mul(0.5);
  const quadHalf = hi
    .sub(lo)
    .mul(0.5)
    .mul(select(alive, float(1), float(0)));
  const world = quadCentre.add(corner.mul(2).mul(quadHalf));

  const vQ = Fn(() => world.sub(leafCentre).div(max(half, 0.5)))().toVarying('vLeafQ');
  const vS = Fn(() => world.sub(shadowCentre).div(max(half, 0.5)))().toVarying('vLeafS');
  const vInfo = Fn(() => vec4(iC.y, iC.z, iTag.kind, fade))().toVarying('vLeafInfo');
  const vCol = Fn(() => vec4(iRec1.xyz, half))().toVarying('vLeafCol');
  // How soft the cast shadow is: a high leaf's is a blur, a landed one's is crisp (in leaf units).
  const vShadowSoft = Fn(() => h.mul(0.06).div(max(half, 0.5)).add(0.04))().toVarying('vLeafShadowSoft');
  // Which half of the leaf faces the light (up-left, the art's own light): the
  // sign of the leaf's across-axis against it, decided per leaf, not per pixel.
  const vLight = Fn(() => {
    const ax = vec2(sin(iC.y).negate(), cos(iC.y));
    return select(dot(ax, vec2(-0.6, -0.8)).greaterThanEqual(0), float(1), float(-1));
  })().toVarying('vLeafLight');

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.toneMapped = false;
  material.positionNode = Fn(() => vec3(world.x, world.y, float(zDepth)))();

  const toLeaf = (q, angle) => {
    const ca = cos(angle);
    const sa = sin(angle);
    return vec2(q.x.mul(ca).add(q.y.mul(sa)), q.x.mul(sa).negate().add(q.y.mul(ca)));
  };
  const p = toLeaf(vQ, vInfo.x);
  const aa = max(max(fwidth(p.x), fwidth(p.y)), 1e-4);
  const look = buildShedLook(TSL, {
    p,
    aa,
    kind: vInfo.z,
    flip: vInfo.y,
    rgb: vCol.xyz,
    inkW: uInkPx.div(max(vCol.w, 0.5)),
    lightSide: vLight,
  });
  const ps = toLeaf(vS, vInfo.x);
  const shadowA = shedCoverage(TSL, ps, vInfo.z, vInfo.y, max(aa.mul(1.5), vShadowSoft))
    .mul(uShadow)
    .mul(uShadowDay);
  const leafA = look.alpha.mul(vInfo.w);
  const shA = shadowA.mul(vInfo.w).mul(float(1).sub(look.alpha));
  const outA = leafA.add(shA);
  const lit = litLinear(TSL, { rgb: look.rgb, lit: !!illumTexNode, illumTexNode, colorationTexNode });
  const gate = occlusionGate(TSL, { depthTexNode, depthFlagsTexNode, expectedDepth: uExpectedDepth });
  material.colorNode = lit.mul(leafA.div(max(outA, 1e-4)));
  material.opacityNode = outA.mul(gate);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  const scene = new THREE.Scene();
  scene.add(mesh);

  let births = 0;
  let steps = 0;
  let lastBirths = 0;

  return {
    scene,
    capacity,
    /** The storage nodes, for the leaf lab's buffer reads (`renderer.getArrayBufferAsync`). Never read in-frame. */
    labBuffers: Object.freeze({ position, velocity, age, life, custom }),

    /**
     * Write this frame's births into the ring (before {@link step}).
     * @param {Array<{x:number,y:number,kind:number,ramp:number,sizePx:number,rgb:number[],heightPx:number}>} list
     */
    writeBirths(list) {
      lastBirths = 0;
      if (!list?.length) return;
      const { slots, stamps, runs } = ring.claim(list.length);
      for (let k = 0; k < slots.length; k++) writeBirth(birthBacking, slots[k], stamps[k], list[k]);
      for (const [start, count] of runs) {
        birthAttr.addUpdateRange(start * BIRTH_FLOATS_PER_SLOT, count * BIRTH_FLOATS_PER_SLOT);
      }
      birthAttr.needsUpdate = true;
      births += slots.length;
      lastBirths = slots.length;
    },

    /**
     * One frame of flight. Synchronous compute, never a readback.
     * @param {*} renderer
     * @param {{dtSec:number, tMs:number}} frame
     */
    step(renderer, { dtSec, tMs }) {
      uDtSec.value = Math.min(MAX_DT_SEC, Math.max(0, dtSec || 0));
      uTimeMs.value = tMs || 0;
      renderer.compute(updateKernel);
      steps++;
    },

    /** @param {{minX:number,minY:number,maxX:number,maxY:number}} rect */
    setSceneRect(rect) {
      uRectMin.value.set(rect.minX, rect.minY);
      uRectMax.value.set(rect.maxX, rect.maxY);
    },

    /**
     * The floor, sun and canopy facts the draw needs each frame.
     * @param {{expectedDepth?:number, shadowThrowX?:number, shadowThrowY?:number, daylight01?:number,
     *   crownHeightPx?:number}} v - `shadowThrow*`: world px of shadow per px of height;
     *   `crownHeightPx`: a tree's height, where a leaf draws 1.35× its landed size.
     */
    setView(v = {}) {
      if (Number.isFinite(v.expectedDepth)) uExpectedDepth.value = v.expectedDepth;
      if (Number.isFinite(v.shadowThrowX) && Number.isFinite(v.shadowThrowY)) {
        uShadowThrow.value.set(v.shadowThrowX, v.shadowThrowY);
      }
      if (Number.isFinite(v.daylight01)) uShadowDay.value = Math.min(1, Math.max(0, v.daylight01));
      if (Number.isFinite(v.crownHeightPx) && v.crownHeightPx > 0) uLiftScale.value = 0.35 / v.crownHeightPx;
    },

    /**
     * Live look — uniforms only, a slider never rebuilds the kernel.
     * @param {object} p - resolved LEAF_SHED_PARAMS (+ `gridPx` for the outline's art scale).
     */
    setLook(p = {}) {
      if (Number.isFinite(p.startsAboveMps)) uStartMps.value = p.startsAboveMps;
      if (Number.isFinite(p.fullAtMps)) uFullMps.value = Math.max(p.fullAtMps, uStartMps.value + 0.5);
      if (Number.isFinite(p.carry)) uCarry.value = p.carry;
      if (Number.isFinite(p.flutter)) uFlutter.value = p.flutter;
      if (Number.isFinite(p.groundSec)) uGroundSec.value = p.groundSec;
      if (Number.isFinite(p.shadow)) uShadow.value = p.shadow;
      // The art's outline is ≈ 4 px on a 150 px grid, about half of it inside the shape.
      const gridPx = Number.isFinite(p.gridPx) && p.gridPx > 0 ? p.gridPx : 150;
      if (Number.isFinite(p.outline)) uInkPx.value = p.outline * 0.016 * gridPx * Math.max(0.6, p.leafSize ?? 1);
    },

    /** Adopt a newer wind handle after a rebake (refreshed in place; a regrid is refused loudly). */
    updateWind(next) {
      if (!windCells || !next?.grid || !next?.cells) return;
      if (next.version === windHandleVersion) return;
      if (next.grid.cols !== cellCols || next.grid.rows !== cellRows) {
        log.error(
          `leaf shed wind grid size changed (${cellCols}x${cellRows} -> ${next.grid.cols}x${next.grid.rows}) — ` +
            'ignoring this rebake (the storage buffer would need reallocating).'
        );
        return;
      }
      packWindCells(windCells.value, next.cells, cellCols * cellRows);
      windHandleVersion = next.version;
    },

    /** For the debug panel and the lab: prove the engine is alive without a screenshot. */
    debugState() {
      return {
        capacity,
        births,
        lastBirths,
        steps,
        nextSlot: ring.nextSlot,
        hasWindCells: !!windCells,
        windHandleVersion,
      };
    },
  };
}
