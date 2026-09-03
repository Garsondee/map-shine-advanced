/**
 * ROOF DRIPS — the roofline sings (Precipitation.md §4.3), the sixth particle
 * runtime.
 *
 * ============================================================================
 * ⭐ THE TAIL IS THE WHOLE POINT
 * ============================================================================
 *
 * §4.3, and V2's own tuning agrees: emission `×300` while raining but `×260`
 * **persisting after rain stops**, decaying over `tailDurationSec: 300`
 * (`legacy/core/WeatherController.js:398`). The map keeps dripping for FIVE
 * MINUTES after the sky clears.
 *
 * That is THE STAY leaking back into THE ARRIVAL, and it is the cheapest "the
 * world is wet" signal there is — cheaper than a wetness shader, cheaper than a
 * puddle, and it works on a map with no water on it at all. It is also the one
 * thing here that would be lost by "optimising" drips to follow `precip01`,
 * which is why the decay is a first-class piece of state rather than a
 * multiplier on the axis.
 *
 * ============================================================================
 * ⭐ SPAWN POINTS COME FROM A GRID, NOT FROM THE SCREEN
 * ============================================================================
 *
 * `effects/precipitation/drip-edges.js` extracts the roofline from the mask
 * authority's own per-floor `coverAbove` product, in WORLD space, on the CPU.
 * V2's drips *"never reliably worked"* because its screen→world mapping was
 * voted on at runtime between four Y-flip candidates; there is no screen space
 * in this chain at all, so the question cannot be asked. See that module.
 *
 * Each point carries its own DECK ALTITUDE, sampled from the caster-height grid
 * at extraction time — so a bridge drips from bridge height and an awning from
 * awning height, with nothing authored (§4.3's promise, kept without baking a
 * second texture).
 *
 * ⚠️ STORAGE BUDGET: **7** of the 8-per-stage floor — 6 arena attributes plus
 * the spawn-point buffer. Exactly fire's count, and for the same reason (a
 * point emitter needs its points on the GPU). The fall binds 6, the splashes 5.
 * Separate dispatches, so the limit is never summed.
 *
 * @module effects/particles/precip-drip-runtime
 */
import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import { windFlowVectorNode } from '../../world/index.js';
import { createLogger } from '../../core/log.js';

const log = createLogger('precip-drip');

/**
 * V2's roof-drip tuning, harvested (`legacy/core/WeatherController.js:398`).
 * `emissionRainMult: 300` / `emissionTailMult: 260` become the ratio below;
 * the absolute numbers were Quarks emission rates against a different pipeline
 * and do not transfer (`feedback_a_cap_is_a_ceiling_not_a_population`).
 */
const LIFE_SEC = Object.freeze([1.9, 3.85]);
/**
 * ⚠️ V2's own `sizeMin/Max` here are **0.28–0.52**, and they are NOT used.
 * At this project's world scale that is a third of a texel — literally
 * invisible — while §4.3's harvest ledger records the size as **1.2–2.4**. Two
 * readings of the same feature, and the sub-pixel one cannot be the one that
 * shipped, because V2's drips were visible enough for the author to miss them.
 * This is the rain-starfield lesson exactly (memory:
 * keyhole-precipitation-p1-built BUG 1): a harvested number that renders
 * nothing is a transcription question, not a taste question.
 */
const SIZE_PX = Object.freeze([1.2, 2.4]);
/** §4.3 — *"slower gravity (×0.64)"*, against rain's own fall speed. */
const GRAVITY_MUL = 0.64;
/** Rain's mid speed, the reference this scales. Shared by value with
 * `precip-species.js`'s `rain.fall.speedPxS`, deliberately not by import: a
 * drip is not a rain row and giving it one would put a non-falling-from-the-sky
 * species in a table whose every consumer assumes the sky. */
const RAIN_REFERENCE_SPEED = 3300;
/** ⭐ How long the tail runs after rain stops, in REAL seconds. V2's
 * `tailDurationSec`. */
const TAIL_DURATION_SEC = 300;
/** …and how strong it starts, relative to raining emission. V2's 260/300. */
const TAIL_STRENGTH = 260 / 300;
/** A whisper of curl (§4.3) — enough that a column of drips is not a ruler. */
const CURL_PX = 7;
/**
 * World px of streak per (px/s) of apparent speed — rain's own `streakPerPxS`
 * (0.0065) scaled down, because a drip falls at 0.64× rain's speed from a few
 * hundred px rather than from 780, so the same factor would make it a dash the
 * length of the building it fell off.
 */
const STREAK_PER_PXS = 0.0034;

/**
 * @param {object} deps
 * @param {*} deps.THREE
 * @param {number} [deps.capacity]
 * @param {number} [deps.zDepth]
 * @param {number} [deps.renderOrder]
 * @param {object} [deps.windHandle]
 */
export function createPrecipDripEngine({ THREE, capacity = 6000, zDepth = 0, renderOrder = 0, maxSpawnPoints = 512 }) {
  const TSL = THREE.TSL;
  const {
    Fn,
    instanceIndex,
    float,
    vec2,
    vec3,
    vec4,
    uniform,
    sin,
    cos,
    fract,
    uv,
    mix,
    positionGeometry,
    instancedArray,
  } = TSL;

  const cap = Math.max(1, Math.floor(capacity));
  const arena = new ParticleArena({ budgetBytes: BYTES_PER_PARTICLE * cap });
  const buffers = arena.allocateBuffers(TSL);
  const position = buffers.position;
  const age = buffers.age;
  const lifeBuf = buffers.life;
  const seed = buffers.seed;
  /** x = brightness · y = size px · z = fall speed px/s · w = HEIGHT, counting
   * DOWN from the deck. Reaching 0 IS the landing, exactly as in the fall. */
  const custom = buffers.custom;

  /**
   * ⭐ THE ROOFLINE, ON THE GPU. `vec4` per point: `(x, y, deckHeightPx, 1)` —
   * the `w` is a VALIDITY flag, so a partly-filled buffer cannot spawn bodies
   * at the origin. A count uniform alone would be enough today; the flag is
   * what makes a stale tail of the buffer harmless when the roofline shrinks.
   */
  const spawnPoints = instancedArray(new Float32Array(maxSpawnPoints * 4), 'vec4');
  const uSpawnCount = uniform(float(0));

  const uDtSec = uniform(0);
  const uTimeMs = uniform(float(0));
  const uActiveCount = uniform(float(0));
  const uWindDirDeg = uniform(float(0));
  const uWindSpeed01 = uniform(float(0));
  const uWindAirSpeed = uniform(float(2600));
  /**
   * ⭐ THE PERSPECTIVE PAIR — AND THEIR ABSENCE WAS THE BIGGEST DRIP BUG.
   *
   * ⚠️ AUTHOR, LIVE: *"they spawn and then despawn without visibly moving
   * much… they don't appear to drop downwards."* Exactly right, and the cause is
   * that under a TOP-DOWN camera **falling is not a Y translation**. A drop
   * descending toward the ground moves toward the CAMERA, which reads as the
   * M(h) magnification collapsing from its birth height to 1 — the fall runtime
   * has done this since P1 and this engine simply never applied it. Its bodies
   * aged, their height counted down correctly, and they sat still while doing
   * it. A drip that does not converge is a drip that does not fall.
   */
  const uCamCentre = uniform(vec2(0, 0));
  const uCamHeight = uniform(float(2000));
  /** ⭐ *"I don't mind if the roof drip edge is a bit more fuzzy."* — how far a
   * drip may be born from its extracted edge point, in world px. The roofline
   * is a coarse grid's boundary; a line of drips exactly on it reads as a
   * dotted rule, while a real eave sheds along its whole lip. */
  const uEdgeJitterPx = uniform(float(26));
  const uStreakScale = uniform(float(1));
  /** ⭐ How much of the radial (falling-toward-you) term steers the streak.
   * *"We want perspective, just not too much of it."* See its use site. */
  const uParallax01 = uniform(float(0.3));
  const uSizeScale = uniform(float(1));
  const uAlphaMul = uniform(float(1));
  const uRgbMul = uniform(float(1));

  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));
  // Precipitation's compass is no longer this file's own (2026-09-04,
  // mythica-machina-press#497 Stage 0) — it resolves through the ONE shared
  // `windFlowVectorNode`, so a drip can never blow opposite to the rain that
  // made it. The local `(−sin, cos)` copy that used to live here was one of
  // FOUR hand-written readings of the same rule across this codebase.

  /** Pick a roofline point for this body, from a bounded entropy. */
  const pickPoint = (entropy) => {
    const idx = hash11(entropy.mul(float(3.7)).add(float(7.1)))
      .mul(uSpawnCount.max(float(1)))
      .floor()
      .clamp(float(0), uSpawnCount.max(float(1)).sub(float(1)));
    return spawnPoints.element(idx.toInt());
  };

  /** ⭐ THE FUZZY EAVE. A disc of jitter around the extracted point, so drips
   * shed along a lip rather than from a row of dots on a coarse grid boundary. */
  const jitterAround = (xy, entropy) => {
    const a1 = hash11(entropy.mul(float(9.7)).add(float(3.3))).mul(float(Math.PI * 2));
    // sqrt of the radius hash — a uniform hash would crowd the centre, which
    // would defeat the point by re-concentrating drips on the exact texel.
    const r = hash11(entropy.mul(float(4.1)).add(float(19.7)))
      .sqrt()
      .mul(uEdgeJitterPx);
    return xy.add(vec2(cos(a1), sin(a1)).mul(r));
  };

  const bodyConstants = (entropy) => {
    const brightness = hash11(entropy.mul(float(1.7))).pow(float(0.8));
    const sizePx = mix(float(SIZE_PX[0]), float(SIZE_PX[1]), hash11(entropy.mul(float(2.3)).add(float(11))));
    const speed = float(RAIN_REFERENCE_SPEED)
      .mul(float(GRAVITY_MUL))
      .mul(mix(float(0.8), float(1.25), hash11(entropy.mul(float(3.1)).add(float(29)))));
    return { brightness, sizePx, speed };
  };

  const seedKernel = Fn(() => {
    const i = instanceIndex;
    const fi = float(i);
    seed.element(i).assign(fi);
    const p = pickPoint(fi);
    const b = bodyConstants(fi);
    position.element(i).assign(jitterAround(p.xy, fi));
    // ⚠️ HEIGHTS STAGGERED ACROSS THE COLUMN, not all at the deck — otherwise
    // the whole roofline releases one synchronised sheet of drips that lands
    // together and leaves the eaves silent until the next. The fall staggers
    // height for the identical reason.
    custom.element(i).assign(vec4(b.brightness, b.sizePx, b.speed, hash11(fi.mul(float(7.3))).mul(p.z)));
    lifeBuf.element(i).assign(mix(float(LIFE_SEC[0]), float(LIFE_SEC[1]), hash11(fi.mul(float(5.1)))).mul(float(1000)));
    age.element(i).assign(float(0));
  })().compute(cap);

  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const pos = position.element(i).toVar();
    const s = seed.element(i);
    const c = custom.element(i).toVar();
    const nextAge = age.element(i).add(uDtSec.mul(float(1000)));

    // Wind carries a drip only a little — it has just left a surface and has
    // no time aloft to be blown far. Plus a whisper of curl so a row of eaves
    // does not read as a comb.
    const tSec = uTimeMs.mul(float(0.001));
    const phase = s.mul(float(12.9));
    const curl = vec2(sin(tSec.mul(float(1.7)).add(phase)), cos(tSec.mul(float(1.3)).add(phase.mul(float(1.9))))).mul(
      float(CURL_PX)
    );
    const drift = windFlowVectorNode(TSL, uWindDirDeg).mul(uWindSpeed01).mul(uWindAirSpeed).mul(float(0.12)).add(curl);
    const nextPos = pos.add(drift.mul(uDtSec));
    const nextH = c.w.sub(c.z.mul(uDtSec));

    // Landed, or outlived its life. Both end it; the life is the backstop for a
    // drip whose deck height is large enough that it would otherwise streak.
    const done = nextH.lessThanEqual(float(0)).or(nextAge.greaterThanEqual(lifeBuf.element(i)));
    /**
     * ⚠️ **A POSITION-ONLY ENTROPY IS A FIXED POINT HERE**, and the author saw
     * it: *"they spawn at very predictable spots around the sky reach perimeter
     * and always seem to use the same exact spots."*
     *
     * The fall runtime derives its respawn entropy from seed + position, which
     * is right THERE because a falling body respawns to a fresh CONTINUOUS
     * position. A drip respawns onto one of N **discrete** roofline points — so
     * the entropy computed at point P selects point P again, forever. Every
     * body converges onto one eave within a few lives and the rest of the
     * roofline goes silent.
     *
     * ⭐ GENERALISABLE: **bounded-by-position entropy stops being an entropy the
     * moment position is quantised.** The fix mixes in the body's own LIFE
     * duration, which is re-randomised on every respawn, so successive lives of
     * one slot land on different points — while staying bounded and
     * `sin()`-safe, unlike the raw clock the fall documents at length.
     */
    const entropy = s
      .mul(float(0.61))
      .add(nextPos.x.mul(float(0.011)))
      .add(nextPos.y.mul(float(0.013)))
      .add(lifeBuf.element(i).mul(float(0.0007)));
    const fresh = bodyConstants(entropy);
    const p = pickPoint(entropy);

    position.element(i).assign(done.select(jitterAround(p.xy, entropy), nextPos));
    custom
      .element(i)
      .assign(done.select(vec4(fresh.brightness, fresh.sizePx, fresh.speed, p.z), vec4(c.x, c.y, c.z, nextH)));
    age.element(i).assign(done.select(float(0), nextAge));
    lifeBuf
      .element(i)
      .assign(
        done.select(
          mix(float(LIFE_SEC[0]), float(LIFE_SEC[1]), hash11(entropy.mul(float(5.1)))).mul(float(1000)),
          lifeBuf.element(i)
        )
      );
  })().compute(cap);

  // ── THE DRAW ─────────────────────────────────────────────────────────────
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.attributes.position);
  geometry.setAttribute('uv', base.attributes.uv);
  geometry.instanceCount = cap;

  /** `(fall01, brightness, visible, 0)` — one varying, the sibling discipline:
   * storage reads are vertex-stage only, so everything the fragment needs
   * crosses packed. */
  const vDrip = Fn(() => {
    const i = instanceIndex;
    const c = custom.element(i);
    const alive = float(i).lessThan(uActiveCount).select(float(1), float(0));
    const t = age
      .element(i)
      .div(lifeBuf.element(i).max(float(1)))
      .clamp(float(0), float(1));
    // ⭐ "faint blue-white FADING TO NOTHING" (§4.3) — a drip does not land, it
    // runs out. The fade is over LIFE rather than height, so a drip from a low
    // awning fades as gently as one from a bridge.
    const fade = float(1).sub(t).pow(float(0.7));
    return vec4(t, c.x, alive.mul(fade), float(0));
  })().toVarying('vPrecipDrip');

  const material = new THREE.NodeMaterial();
  material.positionNode = Fn(() => {
    const i = instanceIndex;
    const c = custom.element(i);
    const centre = position.element(i);

    /**
     * ⭐ M(h) — THE FALL, MADE VISIBLE. Same expression the fall runtime uses:
     * a body at height h is magnified by `D / (D − h)` about the camera centre,
     * so as h counts down to 0 the sprite converges on the ground point it is
     * falling toward. THIS is what "dropping downwards" looks like from above,
     * and its absence is why the drips sat still.
     */
    const persp = uCamHeight.div(uCamHeight.sub(c.w.min(uCamHeight.mul(float(0.82)))));
    const drawn = uCamCentre.add(centre.sub(uCamCentre).mul(persp));

    /**
     * ⭐ THE STREAK POINTS WHERE THE DRIP IS ACTUALLY GOING.
     *
     * ⚠️ AUTHOR, LIVE: *"drips all currently present as stubby north/south
     * facing lines… they are moved by the wind but don't end up pointing in the
     * wind direction like rain does."* Both symptoms, one cause: the quad was
     * elongated along a FIXED local axis (`local.y × 3.2`), so every drip on
     * the map was a vertical dash no matter which way it travelled.
     *
     * The apparent velocity has two parts, exactly as rain's does: the
     * horizontal drift (wind + curl), and the RADIAL term — the outward
     * movement the M(h) collapse itself produces, which is what makes a drop
     * read as coming down at you rather than sliding sideways.
     */
    const drift = windFlowVectorNode(TSL, uWindDirDeg).mul(uWindSpeed01).mul(uWindAirSpeed).mul(float(0.12));
    /**
     * Outward from the camera centre, scaled by how fast the body is falling
     * and by the magnification it currently has.
     *
     * ⚠️ **DIALLED WELL BELOW 1, AND THE FULL-STRENGTH VERSION WAS REPORTED.**
     * Author: *"could do with a less extreme perspective angle. Moving the
     * camera currently causes them to fall at a very sharp angle which doesn't
     * make much sense with the top down view. We want perspective, just not too
     * much of it."*
     *
     * The term is proportional to DISTANCE FROM THE CAMERA CENTRE and is
     * unbounded, so a drip near the edge of a wide view gets a radial many
     * times its own fall speed and points almost straight outward — and because
     * the centre moves with the camera, panning swings every streak on screen.
     * Physically it is what a real perspective camera does; at MSA's
     * near-orthographic top-down read it is simply too much, which is the
     * author's point exactly.
     *
     * A blend rather than a smaller camera height: `uCamHeight` also sets the
     * MAGNIFICATION (how much a drip grows as it falls), and that part reads
     * well. This scales only the streak's steering, so the fall still converges
     * while the angle stays gentle.
     */
    const radial = drawn.sub(uCamCentre).mul(persp).mul(c.z).div(uCamHeight).mul(uParallax01);
    const apparent = drift.add(radial);
    const len = apparent.length().max(float(1e-4));
    const dir = vec2(apparent.x.div(len), apparent.y.div(len));
    const perp = vec2(dir.y.negate(), dir.x);

    // Length grows with apparent speed, exactly like rain's streak — a drip
    // that has just left the eave is a dot, one halfway down is a line.
    const width = c.y.mul(uSizeScale).mul(persp);
    const length = width.mul(float(1.6)).add(len.mul(float(STREAK_PER_PXS)).mul(uStreakScale).mul(persp));
    const local = positionGeometry.xy;
    const offset = perp.mul(local.x.mul(width)).add(dir.mul(local.y.mul(length)));
    return vec3(drawn.add(offset), float(zDepth));
  })();

  material.colorNode = Fn(() => vec3(0.72, 0.8, 0.95).mul(vDrip.y).mul(uRgbMul))();
  material.opacityNode = Fn(() => {
    const p = uv().sub(float(0.5)).mul(float(2));
    // Lateral falloff: the LENGTH stays crisp, the width softens — a streak's
    // own rule, the same one the fall's flake/streak split exists to honour.
    const edge = float(1).sub(p.x.abs()).clamp(float(0), float(1));
    const along = float(1)
      .sub(p.y.abs().pow(float(3)))
      .clamp(float(0), float(1));
    return edge.mul(along).mul(vDrip.z).mul(uAlphaMul).mul(float(0.55));
  })();

  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.blending = THREE.NormalBlending;
  /** ⚠️ DoubleSide — the flipped camera inverts winding and `FrontSide` draws
   * NOTHING, silently. The seventh surface in this codebase to need this line;
   * it has cost this project a debug cycle once already in P2. */
  material.side = THREE.DoubleSide;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  const scene = new THREE.Scene();
  scene.add(mesh);

  const pointData = new Float32Array(maxSpawnPoints * 4);
  let seeded = false;
  let liveCount = 0;
  let spawnCount = 0;
  /** ⭐ THE TAIL's state: 0..1, driven to 1 by rain and decaying afterwards. */
  let tail01 = 0;
  let lastRate = 0;

  return {
    scene,
    capacity: cap,

    /**
     * Hand the engine the roofline. Cheap and idempotent; call when the mask
     * authority's products version moves or the floor changes, NEVER per frame.
     * @param {{points: Float32Array, count: number}} edges - from
     *   `effects/precipitation/drip-edges.js#extractDripEdges`, stride 3.
     */
    /** The view's own centre — M(h) magnifies ABOUT it, so a stale one makes
     * every drip converge on where the camera used to be. Pushed per frame by
     * the subsystem, exactly as the fall's is. */
    setCamera(centreX, centreY) {
      if (Number.isFinite(centreX) && Number.isFinite(centreY)) uCamCentre.value.set(centreX, centreY);
    },

    setSpawnPoints(edges) {
      const src = edges?.points ?? null;
      const n = Math.min(maxSpawnPoints, Math.max(0, edges?.count ?? 0));
      pointData.fill(0);
      for (let k = 0; k < n; k++) {
        pointData[k * 4] = src[k * 3];
        pointData[k * 4 + 1] = src[k * 3 + 1];
        pointData[k * 4 + 2] = src[k * 3 + 2];
        pointData[k * 4 + 3] = 1; // the validity flag
      }
      spawnPoints.value.array.set(pointData);
      spawnPoints.value.needsUpdate = true;
      uSpawnCount.value = n;
      spawnCount = n;
      // ⚠️ RE-SEED when the roofline changes: every live body is falling from a
      // point that may no longer exist, and letting them finish would rain
      // drips off a demolished eave for a couple of seconds.
      seeded = false;
      log.info(`roofline: ${n} drip points (of ${edges?.edgeTexels ?? 0} edge texels)`);
      return { count: n };
    },

    init(renderer) {
      if (seeded || spawnCount === 0) return;
      renderer.compute(seedKernel);
      seeded = true;
    },

    /**
     * @param {number} dtRealSec
     * @param {number} precip01 - drives the tail toward 1 while it rains.
     */
    setFrame(dtRealSec, precip01, frame) {
      const p = Number.isFinite(precip01) ? Math.max(0, Math.min(1, precip01)) : 0;
      const dt = Math.max(0, dtRealSec || 0);
      // ⭐ THE TAIL. Rising is instant (a roof starts dripping as soon as rain
      // hits it); falling takes `TAIL_DURATION_SEC`. An asymmetric integrator,
      // and the asymmetry IS the feature — a symmetric ease would make the
      // roofline take five minutes to START, which is the opposite of the
      // physical fact.
      tail01 = p > tail01 ? p : Math.max(0, tail01 - dt / TAIL_DURATION_SEC);
      const rate = Math.max(p, tail01 * TAIL_STRENGTH);
      lastRate = rate;
      liveCount = Math.round(cap * rate);
      uActiveCount.value = liveCount;
      geometry.instanceCount = Math.max(1, liveCount);
      if (Number.isFinite(frame?.alphaMul)) uAlphaMul.value = frame.alphaMul;
      if (Number.isFinite(frame?.rgbMul)) uRgbMul.value = frame.rgbMul;
    },

    step(renderer, dtSec, timeMs, wind) {
      if (spawnCount === 0) return;
      if (wind?.ambient) {
        const sp = wind.ambient.speed01?.value;
        const dg = wind.ambient.directionDeg?.value;
        if (Number.isFinite(sp)) uWindSpeed01.value = sp;
        if (Number.isFinite(dg)) uWindDirDeg.value = dg;
      }
      uDtSec.value = Math.max(0, Math.min(0.1, dtSec || 0));
      uTimeMs.value = timeMs || 0;
      if (!seeded) this.init(renderer);
      if (uActiveCount.value <= 0) return;
      renderer.compute(updateKernel);
    },

    setTuning(t = {}) {
      if (Number.isFinite(t.dripSizeScale)) uSizeScale.value = t.dripSizeScale;
      if (Number.isFinite(t.dripStreakScale)) uStreakScale.value = t.dripStreakScale;
      if (Number.isFinite(t.dripParallax01)) uParallax01.value = Math.max(0, Math.min(1, t.dripParallax01));
      if (Number.isFinite(t.dripEdgeJitterPx)) uEdgeJitterPx.value = Math.max(0, t.dripEdgeJitterPx);
      if (Number.isFinite(t.cameraHeight)) uCamHeight.value = Math.max(1, t.cameraHeight);
      if (Number.isFinite(t.windAirSpeedPxS)) uWindAirSpeed.value = t.windAirSpeedPxS;
    },

    get hasContent() {
      return spawnCount > 0 && liveCount > 0;
    },

    debugState() {
      return {
        capacity: cap,
        liveCount,
        spawnCount,
        visible: this.hasContent,
        /** ⭐ THE TAIL, reported — "it is still dripping and it stopped raining
         * four minutes ago" is a FEATURE, and a reader has to be able to tell
         * it apart from "the rain axis is stuck". */
        tail: { tail01, rate: lastRate, durationSec: TAIL_DURATION_SEC, strength: TAIL_STRENGTH },
        storageBuffers: 7,
      };
    },
  };
}
