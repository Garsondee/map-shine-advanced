/**
 * WATER SPRAY — runtime (2026-11-06, mmp-7kx.1). The SIXTH runtime under the particle roof (dust, gusts, fire,
 * critters, leaf shed, and this), and a close sibling of leaf shed: the CPU decides each birth
 * (`effects/water/water-spray-shore.js#planSprayBirths` — where the current drives into a hard face, a Poisson count,
 * each fleck's own throw), and a compute kernel flies every fleck on its own from then on. No per-fleck JS object.
 *
 * The author: *"The particles are still spawning in groups, all on the same frame, moving all in the same exact
 * direction, landing at the same exact frame, fading out at the exact same time. We need a LOT more randomness."* Here
 * every fleck has its own birth frame, direction, speed, air time, arc height, size, ride and fade.
 *
 * A FLECK'S LIFE: thrown off the face (velocity from its birth, slowed by the air, nudged by the wind), arcing up the
 * page and back (`apexPx`, a parabola over its own air time). It lands where it lands: the kernel reads the water mask
 * there — on water it rides the current for a few seconds and fades; on ground (allowed: flecks may land outside the
 * water) it fades in a moment.
 *
 * BIRTHS reach the GPU through a CPU-only birth ring (`effects/leaf-shed-birth.js#createBirthRing`, reused), stamped:
 * the kernel starts a fleck in any slot whose stamp differs from the one it last started from (kept in `seed`).
 *
 *   birth rec0 = (x, y, stamp, airSec)    rec1 = (vx, vy, apexPx, sizePx)
 *   custom     = (heightPx, apexPx, airSec, wet)   wet: −1 airborne, 1 landed on water, 0 landed on ground
 *   life       = −1 while airborne; on landing, the age at which it dies.
 *
 * STORAGE BUFFERS — compute: position, velocity, age, life, seed, custom + births = 7 (inside the guaranteed 8).
 *
 * THREE is INJECTED (never imported), so the module's top level stays Node-safe.
 *
 * @module effects/particles/water-spray-runtime
 */

import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import { createBirthRing } from '../leaf-shed-birth.js';
import { litLinear, occlusionGate } from '../critters/critter-surface.js';

const MAX_DT_SEC = 0.05;
/** vec4s / floats per slot in the birth buffer. */
const SPRAY_BIRTH_VEC4 = 2;
const SPRAY_BIRTH_FLOATS = SPRAY_BIRTH_VEC4 * 4;
/** How long a fleck rides the current once it lands on water, seconds (its own, between these). */
const RIDE_MIN_SEC = 1.2;
const RIDE_MAX_SEC = 4.2;
/** How long a fleck lasts after landing on ground, seconds (its own, between these). */
const GROUND_MIN_SEC = 0.15;
const GROUND_MAX_SEC = 0.55;
/** Air drag: a thrown fleck keeps exp(−k·t) of its speed. */
const AIR_DRAG = 0.9;
/** How fast a landed fleck takes up the current, 1/s. */
const RIDE_GRIP = 1.6;
/** Each landed fleck's own sideways drift on the current, up to ± this, world px/s. */
const RIDE_SCATTER_PX = 14;
/** Fade at the end of a ride, seconds. */
const FADE_OUT_SEC = 0.7;

/**
 * @param {object} o
 * @param {*} o.THREE
 * @param {number} o.capacity - the most flecks alive at once.
 * @param {*} o.maskTexNode - a texture node (the caller owns it) over the water mask; `.value` is repointed with
 *   {@link setMask}. Read with `.load` at a texel (crisp: water is where the paint is).
 * @param {*} [o.illumTexNode] @param {*} [o.colorationTexNode] - the scene's light, so spray is lit like everything else.
 * @param {*} [o.depthTexNode] @param {*} [o.depthFlagsTexNode] - the depth authority: a roof over the water hides it.
 * @param {number} [o.renderOrder]
 */
export function createWaterSprayEngine({
  THREE,
  capacity: requested,
  maskTexNode,
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
    fract,
    exp,
    smoothstep,
    max,
    min,
    floor,
    select,
    clamp,
    fwidth,
    length,
    ivec2,
    textureSize,
    positionGeometry,
  } = TSL;

  const capacity = Math.max(64, Math.floor(requested || 0));
  const arena = new ParticleArena({ budgetBytes: BYTES_PER_PARTICLE * capacity });
  const { position, velocity, age, life, seed, custom } = arena.allocateBuffers(TSL);

  const birth = TSL.instancedArray(capacity * SPRAY_BIRTH_VEC4, 'vec4');
  const birthAttr = birth.value;
  const birthBacking = birthAttr.array;
  if (birthBacking.length !== capacity * SPRAY_BIRTH_FLOATS) {
    throw new Error(
      `water spray: birth buffer is ${birthBacking.length} floats, expected ${capacity * SPRAY_BIRTH_FLOATS}`
    );
  }
  const ring = createBirthRing(capacity);

  const uDtSec = uniform(0);
  const uCurrent = uniform(vec2(0, 0)); // world px/s, the bulk current a landed fleck rides
  const uWind = uniform(vec2(0, 0)); // world px/s, the wind's push on a fleck in the air
  const uMaskRect = uniform(vec4(0, 0, 1, 1)); // minX, minY, maxX, maxY
  const uExpectedDepth = uniform(0);
  const uOpacity = uniform(0.85);

  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));
  const waterAt = (p) => {
    const size = vec2(textureSize(maskTexNode, int(0)));
    const span = max(uMaskRect.zw.sub(uMaskRect.xy), vec2(1, 1));
    const uvn = clamp(p.sub(uMaskRect.xy).div(span), 0, 0.9999);
    const inside = p.x
      .greaterThanEqual(uMaskRect.x)
      .and(p.y.greaterThanEqual(uMaskRect.y))
      .and(p.x.lessThan(uMaskRect.z))
      .and(p.y.lessThan(uMaskRect.w));
    return select(inside, maskTexNode.load(ivec2(floor(uvn.mul(size)))).r, float(0));
  };

  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const rec0 = birth.element(int(i).mul(2));
    const rec1 = birth.element(int(i).mul(2).add(1));
    const stamp = rec0.z;
    const r = (salt) => hash11(stamp.mul(0.6180339).add(float(salt)));
    If(stamp.notEqual(seed.element(i)), () => {
      // ── A BIRTH ──
      seed.element(i).assign(stamp);
      position.element(i).assign(rec0.xy);
      velocity.element(i).assign(rec1.xy);
      age.element(i).assign(0);
      life.element(i).assign(-1);
      custom.element(i).assign(vec4(0, rec1.z, max(rec0.w, 0.05), -1));
    }).Else(() => {
      const a = age.element(i);
      const lf = life.element(i);
      If(lf.lessThan(0).or(a.lessThan(lf)), () => {
        const dt = uDtSec;
        const pos = position.element(i);
        const vel = velocity.element(i);
        const c = custom.element(i);
        const a1 = a.add(dt);
        If(lf.lessThan(0), () => {
          // ── IN THE AIR: its own throw, slowed by the air, nudged by the wind, up and down its own arc ──
          const v1 = vel.mul(exp(dt.mul(-AIR_DRAG)));
          const p1 = pos.add(v1.add(uWind).mul(dt));
          const f = clamp(a1.div(c.z), 0, 1);
          const h = c.y.mul(f.mul(float(1).sub(f)).mul(4));
          const lands = a1.greaterThanEqual(c.z);
          const wet = waterAt(p1).greaterThan(127.5 / 255);
          // landed: on water it takes its own ride; on ground it is gone in a moment
          const ride = float(RIDE_MIN_SEC).add(r(3.1).mul(RIDE_MAX_SEC - RIDE_MIN_SEC));
          const ground = float(GROUND_MIN_SEC).add(r(4.7).mul(GROUND_MAX_SEC - GROUND_MIN_SEC));
          const lifeAt = a1.add(select(wet, ride, ground));
          position.element(i).assign(p1);
          velocity.element(i).assign(select(lands, select(wet, v1.mul(0.25), vec2(0, 0)), v1));
          life.element(i).assign(select(lands, lifeAt, float(-1)));
          custom
            .element(i)
            .assign(
              vec4(select(lands, float(0), h), c.y, c.z, select(lands, select(wet, float(1), float(0)), float(-1)))
            );
        }).Else(() => {
          // ── LANDED ── on water: ride the current with its own sideways drift; on ground: stay put
          const onWater = c.w.greaterThan(0.5);
          const side = vec2(uCurrent.y.negate(), uCurrent.x)
            .normalize()
            .mul(
              r(5.3)
                .sub(0.5)
                .mul(2 * RIDE_SCATTER_PX)
            );
          const target = uCurrent
            .mul(float(0.75).add(r(6.9).mul(0.4)))
            .add(select(uCurrent.length().greaterThan(0.01), side, vec2(0, 0)));
          const v1 = select(onWater, vel.add(target.sub(vel).mul(min(dt.mul(RIDE_GRIP), 1))), vec2(0, 0));
          position.element(i).assign(pos.add(v1.mul(dt)));
          velocity.element(i).assign(v1);
        });
        age.element(i).assign(a1);
      });
    });
  })().compute(capacity);

  // ── the draw: a soft round dot per fleck, lifted up the page by its height ──
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('uv', base.getAttribute('uv'));
  geometry.instanceCount = capacity;

  const corner = positionGeometry.xy; // ±0.5
  const iRec1 = birth.element(int(instanceIndex).mul(2).add(1));
  const iC = custom.element(instanceIndex);
  const iAge = age.element(instanceIndex);
  const iLife = life.element(instanceIndex);
  const iPos = position.element(instanceIndex);
  const born = iC.z.greaterThan(0);
  const airborne = iLife.lessThan(0);
  const alive = born.and(airborne.or(iAge.lessThan(iLife)));
  const hFrac = clamp(iC.x.div(max(iC.y, 1)), 0, 1);
  const radius = iRec1.w.mul(float(1).add(hFrac.mul(0.35)));
  const fadeIn = clamp(iAge.div(0.04), 0, 1);
  const onGround = iC.w.lessThan(0.5).and(airborne.not());
  const fadeOutLen = select(onGround, float(GROUND_MIN_SEC), float(FADE_OUT_SEC));
  const fadeOut = select(airborne, float(1), clamp(iLife.sub(iAge).div(fadeOutLen), 0, 1));
  const fade = select(alive, fadeIn.mul(fadeOut).mul(float(0.8).add(hFrac.mul(0.2))), float(0));
  // up the page by its height (world −y is up the screen)
  const centre = iPos.add(vec2(0, iC.x.negate()));
  const half = select(alive, radius.add(1.5), float(0));
  const world = centre.add(corner.mul(2).mul(half));
  const vQ = Fn(() => world.sub(centre))().toVarying('vSprayQ');
  const vR = Fn(() => vec2(radius, fade))().toVarying('vSprayRF');
  const vWorld = Fn(() => world)().toVarying('vSprayWorld');

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.toneMapped = false;
  material.positionNode = Fn(() => vec3(world.x, world.y, float(0)))();
  const aa = max(fwidth(vWorld.x), float(0.3));
  const d = length(vQ);
  const dot = float(1).sub(smoothstep(vR.x.sub(aa.mul(0.5)), vR.x.add(aa.mul(0.5)), d));
  // zoomed far out a fleck is smaller than a pixel and would only sparkle
  const zoomFade = smoothstep(float(2.5), float(1), fwidth(vWorld.x));
  const foam = vec3(0.93, 0.96, 1.0);
  const lit = litLinear(TSL, { rgb: foam, lit: !!illumTexNode, illumTexNode, colorationTexNode });
  const gate = occlusionGate(TSL, { depthTexNode, depthFlagsTexNode, expectedDepth: uExpectedDepth });
  material.colorNode = lit;
  material.opacityNode = dot.mul(vR.y).mul(zoomFade).mul(uOpacity).mul(gate);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  const scene = new THREE.Scene();
  scene.add(mesh);

  let births = 0;
  let lastBirths = 0;
  let steps = 0;
  let hasMask = false;

  return {
    scene,
    capacity,
    get hasContent() {
      return hasMask && births > 0;
    },
    /**
     * This frame's births (before {@link step}).
     * @param {Array<{x:number,y:number,vx:number,vy:number,airSec:number,apexPx:number,sizePx:number}>} list
     */
    writeBirths(list) {
      lastBirths = 0;
      if (!list?.length) return;
      const { slots, stamps, runs } = ring.claim(list.length);
      for (let k = 0; k < slots.length; k++) {
        const b = list[k];
        const o = slots[k] * SPRAY_BIRTH_FLOATS;
        birthBacking[o] = b.x;
        birthBacking[o + 1] = b.y;
        birthBacking[o + 2] = stamps[k];
        birthBacking[o + 3] = b.airSec;
        birthBacking[o + 4] = b.vx;
        birthBacking[o + 5] = b.vy;
        birthBacking[o + 6] = b.apexPx;
        birthBacking[o + 7] = b.sizePx;
      }
      for (const [start, count] of runs)
        birthAttr.addUpdateRange(start * SPRAY_BIRTH_FLOATS, count * SPRAY_BIRTH_FLOATS);
      birthAttr.needsUpdate = true;
      births += slots.length;
      lastBirths = slots.length;
    },
    /** One frame of flight: synchronous compute, never a readback. */
    step(renderer, dtSec) {
      uDtSec.value = Math.min(MAX_DT_SEC, Math.max(0, dtSec || 0));
      renderer.compute(updateKernel);
      steps++;
    },
    /** The water mask the kernel lands flecks on, and the world rect it covers. */
    setMask(texture, rect) {
      if (!texture || !rect) return;
      maskTexNode.value = texture;
      uMaskRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
      hasMask = true;
    },
    /** @param {{currentPx?:number[], windPx?:number[], expectedDepth?:number, opacity?:number}} v */
    setView(v = {}) {
      if (Array.isArray(v.currentPx)) uCurrent.value.set(v.currentPx[0] || 0, v.currentPx[1] || 0);
      if (Array.isArray(v.windPx)) uWind.value.set(v.windPx[0] || 0, v.windPx[1] || 0);
      if (Number.isFinite(v.expectedDepth)) uExpectedDepth.value = v.expectedDepth;
      if (Number.isFinite(v.opacity)) uOpacity.value = v.opacity;
    },
    debugState() {
      return { capacity, births, lastBirths, steps, hasMask, nextSlot: ring.nextSlot };
    },
  };
}
