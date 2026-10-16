/**
 * PLAYER TORCH FIRE — THE PURE HALF. A held torch emits world-space flame and ember
 * particles using the same bird's-eye flame sprites as Fire (`fire/fire-sprite.js`).
 * Particles keep their own positions, velocity, rotation, size and lifetime after spawn;
 * the moving token is only their emitter, as in V2. No THREE, no Foundry.
 *
 * WHY THIS REPLACED THE CANDLE FLAME + FIVE EMBERS. The first torch (Stage 2a) drew a
 * 26 px candle flame and five glow dots that all rose toward screen-north. It read as a
 * candle with sparkles, nothing like the Fire effect the author loves, and nothing like
 * V2's torch (a plume of 32-65 px flame particles, 90-170 a second, plus sparks). The
 * Fire effect's GPU particle engine cannot host a torch (its spawn points are extracted
 * from a painted mask at decode time), but the SPRITE look it is made of can: each flame
 * sprite here is the same archetype shape and the same colour ramp, restarted on its own
 * cycle at a random spot in a small disc, which is also how Fire reads (V2's "95% of
 * flame particles never move: the pool flickers, the embers do the moving").
 *
 * THE QUADS ARE DUMB. Each flame sprite and each spark is one fixed, oversized quad
 * centred on the torch; where the sprite is, how big it is and when it restarts are all
 * worked out in the shader from time and the baked per-sprite `seed`, so a torch costs no
 * CPU per frame and N torches are one draw call each for flame and sparks.
 *
 * @module effects/player-torch-fire-geometry
 */

import { resolveTorchEmberMix01 } from './lighting/player-light-geometry.js';

/**
 * The flame is built in three LAYERS, each its own batch and material, because the Fire effect's
 * archetype shapes are not interchangeable: `plasmaCore` and `convectionCrescent` are soft blobs
 * (stacked, they go to a cream cloud), while `vortexSwirl` and `thermalRing` carry the swirling
 * tongues and broken orange rim that read as fire. A small bright core sits under swirling tongues
 * and a ragged ring. `sizeScale` multiplies the sprite size; `gain` the emission (overlapping
 * sprites sum, so each layer is turned down to keep the total orange rather than white).
 */
export const TORCH_FIRE_FLAME_VARIANTS = Object.freeze([
  Object.freeze({ key: 'core', archetype: 'plasmaCore', count: 6, sizeScale: 0.55, gain: 0.7 }),
  Object.freeze({ key: 'swirl', archetype: 'vortexSwirl', count: 10, sizeScale: 1.0, gain: 0.8 }),
  Object.freeze({ key: 'ring', archetype: 'thermalRing', count: 6, sizeScale: 0.9, gain: 0.6 }),
]);
/** Flame sprites per torch, all layers. */
export const TORCH_FIRE_FLAME_COUNT = TORCH_FIRE_FLAME_VARIANTS.reduce((n, v) => n + v.count, 0);
/** Sparks per torch. */
export const TORCH_FIRE_SPARK_COUNT = 20;
/**
 * The flame quad's side, px. Must contain a sprite at its largest, offset to the edge of
 * its disc: (`TORCH_FIRE_FLAME_SIZE_MAX_PX` + 2 * `TORCH_FIRE_FLAME_SPREAD_PX`) with margin.
 * The shader's own constants (`player-torch-fire-render.js`) are these.
 */
export const TORCH_FIRE_FLAME_BOX_PX = 100;
/**
 * The spark quad's side, px: must contain a spark's whole flight, from the flame's edge
 * (`TORCH_FIRE_SPARK_START_PX`) out `TORCH_FIRE_SPARK_REACH_MAX_PX`, plus its sideways wobble (5) and its dot (up to ~5).
 */
export const TORCH_FIRE_SPARK_BOX_PX = 32;
/** Sparks leave the flame this far from the torch's centre. */
export const TORCH_FIRE_SPARK_START_PX = 16;
// The 2026-10 player feedback: halve the current 78–132 px particles.
export const TORCH_FIRE_FLAME_SIZE_MIN_PX = 39;
export const TORCH_FIRE_FLAME_SIZE_MAX_PX = 66;
export const TORCH_FIRE_FLAME_SPREAD_PX = 5;
export const TORCH_FIRE_SPARK_REACH_MIN_PX = 28;
export const TORCH_FIRE_SPARK_REACH_MAX_PX = 92;
export const TORCH_FIRE_SPARK_SIZE_START_PX = 3.6;
export const TORCH_FIRE_SPARK_SIZE_END_PX = 1.3;
export const TORCH_FIRE_FLAME_RATE_PER_SECOND = 96;
export const TORCH_FIRE_SPARK_RATE_PER_SECOND = 28;
export const TORCH_FIRE_FLAME_LIFE_MIN_S = 0.55;
export const TORCH_FIRE_FLAME_LIFE_MAX_S = 1.1;
export const TORCH_FIRE_SPARK_LIFE_MIN_S = 0.25;
export const TORCH_FIRE_SPARK_LIFE_MAX_S = 0.7;
export const TORCH_FIRE_MAX_FLAMES_PER_TORCH = 128;
export const TORCH_FIRE_MAX_SPARKS_PER_TORCH = 64;
const TORCH_FIRE_QUAD_CORNERS = Object.freeze([
  Object.freeze([-1, -1, 0, 0]),
  Object.freeze([1, -1, 1, 0]),
  Object.freeze([1, 1, 1, 1]),
  Object.freeze([-1, 1, 0, 1]),
]);
const TORCH_FIRE_QUAD_HALVES = TORCH_FIRE_QUAD_CORNERS.map(([x, y]) => ({ x, y }));

/** How much of green and blue a fully-dying torch keeps: the fire's own colours, pulled toward ember red. */
const DYING_GREEN_KEPT = 0.28;
const DYING_BLUE_KEPT = 0.14;

/**
 * A deterministic per-(token, sprite-index) phase, 0..97, folded the same way the Fire
 * and candle seeds are, so a torch's sprites desync from each other and two torches
 * desync from one another. String-keyed so the sprites of ONE torch (one position)
 * still differ.
 * @param {string} tokenId @param {number} index @param {string} [salt]
 * @returns {number}
 */
export function deriveTorchFireSeed(tokenId, index, salt = '') {
  const s = `${salt}${tokenId ?? ''}:${index}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const raw = Math.sin(h) * 43758.5453;
  return (raw - Math.floor(raw)) * 97;
}

function seedFromId(id) {
  let h = 2166136261;
  const text = String(id ?? '');
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0 || 1;
}

function nextRandom(state) {
  state.randomState = (state.randomState + 0x6d2b79f5) >>> 0;
  let t = state.randomState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function spawnFlame(state, anchor, burn01) {
  const random = () => nextRandom(state);
  const angle = random() * Math.PI * 2;
  const radius = Math.sqrt(random()) * TORCH_FIRE_FLAME_SPREAD_PX;
  const fullLife = TORCH_FIRE_FLAME_LIFE_MIN_S + random() * (TORCH_FIRE_FLAME_LIFE_MAX_S - TORCH_FIRE_FLAME_LIFE_MIN_S);
  const variantRoll = random();
  const variantKey = variantRoll < 0.24 ? 'core' : variantRoll < 0.76 ? 'swirl' : 'ring';
  const emitterVelocity = Math.hypot(state.vx, state.vy);
  const inheritScale = emitterVelocity > 900 ? 900 / emitterVelocity : 1;
  return {
    x: anchor.x + Math.cos(angle) * radius,
    y: anchor.y + Math.sin(angle) * radius,
    vx: state.vx * inheritScale * 0.55 + (random() - 0.5) * 46,
    // Canvas Y grows down; hot flame tongues drift screen-up from the hand.
    vy: state.vy * inheritScale * 0.35 - 22 - random() * 52,
    ageS: 0,
    fullLife,
    lifeS: fullLife * (0.2 + 0.8 * burn01),
    burn01,
    size: TORCH_FIRE_FLAME_SIZE_MIN_PX + random() * (TORCH_FIRE_FLAME_SIZE_MAX_PX - TORCH_FIRE_FLAME_SIZE_MIN_PX),
    rotation: random() * Math.PI * 2,
    rotationSpeed: (random() - 0.5) * 2.4,
    seed: deriveTorchFireSeed(anchor.id, state.sequence++, `flame-${variantKey}`),
    variantKey,
  };
}

function spawnSpark(state, anchor, burn01) {
  const random = () => nextRandom(state);
  const angle = random() * Math.PI * 2;
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const reach =
    TORCH_FIRE_SPARK_REACH_MIN_PX + random() * (TORCH_FIRE_SPARK_REACH_MAX_PX - TORCH_FIRE_SPARK_REACH_MIN_PX);
  const fullLife = TORCH_FIRE_SPARK_LIFE_MIN_S + random() * (TORCH_FIRE_SPARK_LIFE_MAX_S - TORCH_FIRE_SPARK_LIFE_MIN_S);
  const emitterVelocity = Math.hypot(state.vx, state.vy);
  const inheritScale = emitterVelocity > 1200 ? 1200 / emitterVelocity : 1;
  return {
    x: anchor.x + direction.x * TORCH_FIRE_SPARK_START_PX,
    y: anchor.y + direction.y * TORCH_FIRE_SPARK_START_PX,
    vx: state.vx * inheritScale * 0.7 + direction.x * reach,
    vy: state.vy * inheritScale * 0.7 + direction.y * reach,
    ageS: 0,
    fullLife,
    lifeS: fullLife * (0.15 + 0.85 * burn01),
    burn01,
    size: 3 + random() * 7,
    rotation: random() * Math.PI * 2,
    rotationSpeed: (random() - 0.5) * 5,
    seed: deriveTorchFireSeed(anchor.id, state.sequence++, 'spark'),
  };
}

/** Stateful but Foundry/THREE-free world-space particle system, sampled each frame. */
export function createTorchFireSimulation() {
  const byToken = new Map();
  return {
    /** @param {Array<{id:string,x:number,y:number,burn01?:number}>} anchors @param {number} nowMs */
    update(anchors, nowMs) {
      const list = Array.isArray(anchors) ? anchors : [];
      const flames = [];
      const sparks = [];
      const present = new Set();
      const safeNow = Number.isFinite(nowMs) ? nowMs : 0;
      for (const anchor of list) {
        const x = Number(anchor?.x);
        const y = Number(anchor?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const id = String(anchor?.id ?? '');
        present.add(id);
        const { burn01 } = resolveTorchFireLook(anchor);
        let state = byToken.get(id);
        if (!state) {
          state = {
            randomState: seedFromId(id),
            sequence: 0,
            x,
            y,
            vx: 0,
            vy: 0,
            nowMs: safeNow - 1000 / 60,
            flameCarry: 1,
            sparkCarry: 0.25,
            flames: [],
            sparks: [],
          };
          byToken.set(id, state);
        }
        const dt = Math.min(0.1, Math.max(0, (safeNow - state.nowMs) / 1000));
        if (dt > 0) {
          const rawVx = (x - state.x) / dt;
          const rawVy = (y - state.y) / dt;
          const speed = Math.hypot(rawVx, rawVy);
          const clamp = speed > 2400 ? 2400 / speed : 1;
          const response = 1 - Math.exp(-dt / 0.07);
          const velocityDecay = Math.exp(-dt / 0.22);
          state.vx = state.vx * velocityDecay + rawVx * clamp * response;
          state.vy = state.vy * velocityDecay + rawVy * clamp * response;
        }
        state.x = x;
        state.y = y;
        state.nowMs = safeNow;

        const advanceParticles = (items, flame) => {
          for (let i = items.length - 1; i >= 0; i--) {
            const particle = items[i];
            particle.burn01 = Math.min(particle.burn01, burn01);
            particle.lifeS = Math.min(
              particle.lifeS,
              particle.fullLife * (flame ? 0.2 + 0.8 * burn01 : 0.15 + 0.85 * burn01)
            );
            particle.ageS += dt;
            if (particle.ageS >= particle.lifeS || particle.burn01 < 0.03) {
              items.splice(i, 1);
              continue;
            }
            particle.x += particle.vx * dt;
            particle.y += particle.vy * dt;
            particle.vx *= Math.exp(-dt * (flame ? 1.7 : 0.85));
            particle.vy *= Math.exp(-dt * (flame ? 1.4 : 0.85));
            particle.rotation += particle.rotationSpeed * dt;
          }
        };
        advanceParticles(state.flames, true);
        advanceParticles(state.sparks, false);

        if (burn01 >= 0.03) {
          const hasSpawned = state.flames.length > 0 || state.sparks.length > 0;
          if (!hasSpawned) {
            state.flameCarry = Math.max(state.flameCarry, 1);
            state.sparkCarry = Math.max(state.sparkCarry, 1);
          }
          state.flameCarry += dt * TORCH_FIRE_FLAME_RATE_PER_SECOND * burn01;
          state.sparkCarry += dt * TORCH_FIRE_SPARK_RATE_PER_SECOND * burn01;
          while (state.flameCarry >= 1 && state.flames.length < TORCH_FIRE_MAX_FLAMES_PER_TORCH) {
            state.flames.push(spawnFlame(state, anchor, burn01));
            state.flameCarry -= 1;
          }
          while (state.sparkCarry >= 1 && state.sparks.length < TORCH_FIRE_MAX_SPARKS_PER_TORCH) {
            state.sparks.push(spawnSpark(state, anchor, burn01));
            state.sparkCarry -= 1;
          }
        } else {
          state.flameCarry = 0;
          state.sparkCarry = 0;
        }
        flames.push(...state.flames.map((particle) => ({ ...particle, id })));
        sparks.push(...state.sparks.map((particle) => ({ ...particle, id })));
      }
      for (const id of byToken.keys()) if (!present.has(id)) byToken.delete(id);
      return { flames, sparks };
    },
    reset() {
      byToken.clear();
    },
  };
}

/**
 * A torch's burn (1 = full, falling to 0 = out) and the tint a dying one takes. A burn
 * below 0.7 pulls the fire's colours toward ember red, continuously from white (no tint)
 * at 0.7 to red at the point it goes out, the same blend the light and the old flame used.
 * No burn on the anchor is a torch at full burn.
 * @param {{burn01?: number}} anchor
 * @returns {{burn01: number, tint: [number, number, number]}}
 */
export function resolveTorchFireLook(anchor) {
  const b = anchor?.burn01;
  const burn01 = Number.isFinite(b) ? Math.min(1, Math.max(0, b)) : 1;
  const mix = resolveTorchEmberMix01(burn01);
  return { burn01, tint: [1, 1 - mix * (1 - DYING_GREEN_KEPT), 1 - mix * (1 - DYING_BLUE_KEPT)] };
}

/** Build three real world-space flame batches plus detached ember sprites. */

function computeParticleBatch(particles, { boxPx, isFlame }) {
  const list = Array.isArray(particles) ? particles : [];
  const half = Math.max(1, Number(boxPx) || 1) / 2;
  const count = list.length;
  const positions = new Float32Array(count * 12);
  const uvs = new Float32Array(count * 8);
  const seeds = new Float32Array(count * 4);
  const looks = new Float32Array(count * 16);
  const ages = new Float32Array(count * 4);
  const sizes = new Float32Array(count * 4);
  const indices = new Uint32Array(count * 6);
  let quadCount = 0;
  for (const particle of list) {
    const x = Number(particle?.x);
    const y = Number(particle?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const burn01 = Math.min(1, Math.max(0, Number(particle.burn01) || 0));
    const { tint } = resolveTorchFireLook({ burn01 });
    const age01 =
      Number.isFinite(particle.ageS) && particle.lifeS > 0
        ? Math.min(1, Math.max(0, particle.ageS / particle.lifeS))
        : 0;
    const seed = Number.isFinite(particle.seed) ? particle.seed : deriveTorchFireSeed(particle.id, quadCount);
    const size = Number.isFinite(particle.size)
      ? particle.size
      : isFlame
        ? TORCH_FIRE_FLAME_SIZE_MIN_PX + (seed / 97) * (TORCH_FIRE_FLAME_SIZE_MAX_PX - TORCH_FIRE_FLAME_SIZE_MIN_PX)
        : TORCH_FIRE_SPARK_SIZE_START_PX;
    const rotation = Number.isFinite(particle.rotation) ? particle.rotation : 0;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const p = quadCount * 12;
    const u = quadCount * 8;
    for (let v = 0; v < 4; v++) {
      const corner = TORCH_FIRE_QUAD_HALVES[v];
      const at = p + v * 3;
      positions[at] = x + corner.x * half * cos - corner.y * half * sin;
      positions[at + 1] = y + corner.x * half * sin + corner.y * half * cos;
      positions[at + 2] = 0;
      uvs[u + v * 2] = corner.x < 0 ? 0 : 1;
      uvs[u + v * 2 + 1] = corner.y < 0 ? 0 : 1;
      seeds[quadCount * 4 + v] = seed;
      ages[quadCount * 4 + v] = age01;
      sizes[quadCount * 4 + v] = size;
      looks.set([tint[0], tint[1], tint[2], burn01], (quadCount * 4 + v) * 4);
    }
    const base = quadCount * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], quadCount * 6);
    quadCount++;
  }
  return { positions, uvs, seeds, looks, ages, sizes, indices, quadCount };
}

/** Convert live, detached world-space particles into their three flame batches and ember batch. */
export function computeTorchParticleArrays(flames, sparks) {
  const activeFlames = Array.isArray(flames) ? flames : [];
  return {
    flames: TORCH_FIRE_FLAME_VARIANTS.map((variant) => ({
      variant,
      batch: computeParticleBatch(
        activeFlames.filter((particle) => particle.variantKey === variant.key),
        {
          boxPx: TORCH_FIRE_FLAME_BOX_PX,
          isFlame: true,
        }
      ),
    })),
    spark: computeParticleBatch(sparks, { boxPx: TORCH_FIRE_SPARK_BOX_PX, isFlame: false }),
  };
}
