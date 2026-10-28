/**
 * ROOF DRIPS — the roofline sings (Precipitation.md §4.3), the sixth particle
 * runtime. REBUILT 2026-10-27 for the plan view.
 *
 * ============================================================================
 * ⭐ WHY IT WAS REBUILT: A SIDE VIEW DRAWN ONTO A PLAN VIEW
 * ============================================================================
 *
 * Author, with a screenshot: *"Drips are currently extremely ugly … imagine
 * this effect with less perspective, so it needs to look good whilst being
 * essentially mostly top down, with wind pushing things in turbulent
 * directions. It has to look good as it goes from full run off which is an
 * extremely heavy version of rain all the way down to an occasional drip."*
 *
 * The first engine drew every drip as a grey dash scattered up to 100px from
 * its eave, all falling at one speed, ending in a hollow ring. From directly
 * above, a vertical fall is the one motion you CANNOT see — so a drip that
 * only fell read as a smudge blinking on and off. What a drip does that IS
 * visible from above is four things, and the engine is now built around them:
 *
 *   1. THE BEAD — water gathers on the eave's lip and swells before it lets
 *      go. A string of glinting beads along a roofline is the quiet-weather
 *      look, and it is free: it is just a drip that has not been released yet.
 *   2. THE THROW — water leaving a roof is thrown OFF it, along the eave's
 *      outward normal (`drip-edges.js` now extracts one per point). Under a
 *      top-down camera this is the motion that says "falling off a roof".
 *   3. THE AIR — wind and coherent curl turbulence (the shared
 *      `world/curlNoise2D`, advected downwind) act on a real integrated
 *      velocity with drag, so neighbouring drops swirl TOGETHER, the way a
 *      gust moves a curtain of water, rather than each jittering alone. Gravity
 *      accelerates the fall from rest, so a released bead starts slow.
 *   4. THE SPLASH — a crown ring, a few spray droplets thrown mostly
 *      downwind, and a brief dark wet mark that gives it contrast on pale
 *      stone.
 *
 * ⭐ AND ONE DIAL SPANS THE WHOLE RANGE. Rain intensity (and the tail after it)
 * changes the CADENCE, not only the count: at an occasional-drip rate each
 * drop hangs for a second or more and slots rest at random between drips (so
 * the eaves tick irregularly instead of strobing); at full runoff the hang and
 * rest collapse to nothing, the throw strengthens and streaks lengthen into
 * ropes of water. See {@link dripCadence}.
 *
 * ============================================================================
 * ⭐ THE TAIL IS THE WHOLE POINT
 * ============================================================================
 *
 * §4.3, and V2's own tuning agrees: the map keeps dripping for MINUTES after
 * the sky clears (`legacy/core/WeatherController.js:398`). That is the
 * cheapest "the world is wet" signal there is, and it is why the decay is a
 * first-class piece of state rather than a multiplier on `precip01`. Since the
 * rebuild it decays the way runoff really does — fast from a pour to a steady
 * drip, then a long tail of occasional drops (see `setFrame`).
 *
 * ============================================================================
 * ⭐ SPAWN POINTS COME FROM A GRID, NOT FROM THE SCREEN
 * ============================================================================
 *
 * `effects/precipitation/drip-edges.js` extracts the roofline from the mask
 * authority's own per-floor `coverAbove` product, in WORLD space, on the CPU.
 * V2's drips *"never reliably worked"* because its screen→world mapping was
 * voted on at runtime between four Y-flip candidates; there is no screen space
 * in this chain at all. Each point carries its own DECK ALTITUDE and (roofline
 * only) its outward NORMAL.
 *
 * ⚠️ STORAGE BUDGET: **7** of the 8-per-stage floor in the compute stage —
 * position, velocity, age, life, seed, custom, and the spawn-point buffer
 * (6 in the vertex stage, which never reads the spawn points). `velocity` is
 * new with the rebuild: the turbulence needs a body to carry momentum.
 *
 * @module effects/particles/precip-drip-runtime
 */
import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import {
  windFlowVectorNode,
  curlNoise2D,
  windFieldPxPerSecPerUnit,
  windStrength01ForSpeed01,
  WIND_DEFAULT_PIXELS_PER_METRE,
  createWindAdvectionUniforms,
  writeWindAdvectionUniforms,
  windAdvectionDtSecNode,
} from '../../world/index.js';
import { createLogger } from '../../core/log.js';
import { eyeCameraForFixed } from '../../scene/index.js';

const log = createLogger('precip-drip');

/**
 * Per-body base size, world px, before `dripSizeScale`. §4.3's harvest ledger
 * records 1.2–2.4; V2's own 0.28–0.52 is a third of a texel at this project's
 * scale and cannot be what shipped (rain-starfield lesson, memory:
 * keyhole-precipitation-p1-built BUG 1).
 */
const SIZE_PX = Object.freeze([1.2, 2.4]);
/** Rain's mid speed and §4.3's *"slower gravity (×0.64)"* — together the
 * drip's TERMINAL speed at `dripFallSpeedScale` 1. Shared with
 * `precip-species.js`'s `rain.fall.speedPxS` by value, deliberately not by
 * import: a drip is not a row of the sky's species table. */
const RAIN_REFERENCE_SPEED = 3300;
const GRAVITY_MUL = 0.64;
/**
 * ⭐ GRAVITY, world px/s², at `dripFallSpeedScale` 1. A released bead starts
 * from REST and accelerates; the old engine dropped every drip at a constant
 * speed from its first frame, which is part of why release never read. At the
 * shipped scale (0.45) a drip from the default 300px eave takes ~0.7s — long
 * enough for the eye to follow the wind carrying it.
 */
const GRAVITY_PXS2 = 2600;
/** How quickly a drop's sideways velocity settles onto the air's, per second.
 * ~0.3s: heavy enough that a throw carries, light enough that a gust bites. */
const AIR_DRAG_PER_SEC = 3.2;
/** Fraction of `windAirSpeedPxS` a full gale pushes a drip at — more than the
 * old 0.12 because the turbulence now has momentum to spend, less than rain's
 * 1.0 because a drip has fallen a few hundred px, not from the clouds. */
const WIND_PUSH = 0.16;
/** px/s of curl turbulence at `dripTurbulence` 1, full wind. */
const TURBULENCE_PXS = 75;
/** ⭐ THE THROW, px/s off the lip along the eave's normal — a trickle barely
 * leaves the edge; a pour is flung (both × `dripThrow`). See {@link dripCadence}. */
const THROW_PXS = Object.freeze([14, 150]);
/**
 * Motion-tail "shutter", seconds: tail length = apparent speed × this. A long
 * exposure rather than rain's tiny per-px factor, because a drip moves at
 * tens-to-hundreds of px/s sideways, not thousands — the same factor would
 * leave it a dot.
 */
const TAIL_SHUTTER_SEC = 0.05;
/** ⭐ How long the tail runs after rain stops, in REAL seconds — the DEFAULT
 * only; `dripTailDurationSec` owns the live value (mythica-machina-press#316). */
const TAIL_DURATION_SEC = 560;
/** …and how strong it starts, relative to raining emission. V2's 260/300. */
const TAIL_STRENGTH = 260 / 300;
/** Default per-drop wobble, px/s (`dripCurlPx`) — the small private wander on
 * top of the shared turbulence, so two drops in one eddy still part. */
const CURL_PX = 6;
/** How long a landed drip lingers as a splash, seconds. */
const SPLASH_SEC = 0.36;
/** Diameter of a fully-grown splash (spray reach), world px, before scales. */
const SPLASH_DIAM_PX = 22;
/** The spray droplets each splash throws. Unrolled in the shader. */
const SPRAY_DROPS = 5;
/** World px of margin round a drop's quad, for its soft edge. */
const DRAW_PAD_PX = 1.5;
/** Backstop life beyond the hang, seconds — a drip that somehow never lands
 * (a deck height far above the camera clamp) still recycles. */
const LIFE_BACKSTOP_SEC = Object.freeze([5, 7]);

/**
 * ⭐ ONE RATE → THE WHOLE CHARACTER. Pure, so the range from a pour to an
 * occasional drip is legible in one place (and testable without a GPU).
 *
 * @param {number} rate - 0..1, the engine's effective emission (rain or tail).
 * @returns {{density01: number, flow01: number, hangSec: number, restSec: number}}
 *   `density01` — fraction of capacity live. Super-linear, so the low end is
 *     genuinely sparse rather than a thin copy of a storm.
 *   `flow01` — how much this is RUNOFF rather than drops: throw, tail length,
 *     splash size.
 *   `hangSec` — mean time a bead swells on the lip before letting go.
 *   `restSec` — mean pause between one drop and the next from the same slot
 *     (exponentially distributed per drop, so the rhythm is irregular).
 */
export function dripCadence(rate) {
  const r = Math.max(0, Math.min(1, Number.isFinite(rate) ? rate : 0));
  const smooth = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return {
    density01: r ** 1.25,
    flow01: smooth(0.08, 0.9, r),
    hangSec: 1.4 + (0.04 - 1.4) * smooth(0, 0.5, r),
    restSec: 1.6 * (1 - smooth(0, 0.35, r)),
  };
}

/**
 * @param {object} deps
 * @param {*} deps.THREE
 * @param {number} [deps.capacity]
 * @param {number} [deps.zDepth]
 * @param {number} [deps.renderOrder]
 * @param {number} [deps.maxSpawnPoints]
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
    exp,
    uv,
    mix,
    smoothstep,
    positionGeometry,
    instancedArray,
    mrt,
  } = TSL;

  const cap = Math.max(1, Math.floor(capacity));
  const arena = new ParticleArena({ budgetBytes: BYTES_PER_PARTICLE * cap });
  const buffers = arena.allocateBuffers(TSL);
  const position = buffers.position;
  /** Sideways velocity, world px/s. While a bead HANGS it holds the throw it
   * will be released with (so the bead knows which way to stretch). */
  const velocity = buffers.velocity;
  /** ms. NEGATIVE = resting between drops (invisible); 0..hang = a bead on
   * the lip; past the hang = released. */
  const age = buffers.age;
  const lifeBuf = buffers.life;
  const seed = buffers.seed;
  /** x = brightness · y = size px · z = CURRENT fall speed px/s (0 while
   * hanging, accelerating, then frozen at impact speed as the splash clock) ·
   * w = HEIGHT, counting down from the deck. Reaching 0 IS the landing. */
  const custom = buffers.custom;

  /**
   * ⭐ THE ROOFLINE, ON THE GPU. `vec4` per point: `(x, y, deckHeightPx, n)`.
   * `n` packs the outward normal: 0 = unused slot, 1 = no normal (an authored
   * spot), `2 + angle/2π` = an eave facing `angle`. One float rather than a
   * second buffer, because the compute stage is at 7 of 8 bindings.
   */
  const spawnPoints = instancedArray(new Float32Array(maxSpawnPoints * 4), 'vec4');
  const uSpawnCount = uniform(float(0));
  /** World px between neighbouring points along an eave (texel × stride), and
   * the texel itself — how far the lip sits outside an edge texel's centre. */
  const uSpacingPx = uniform(float(25));
  const uTexelPx = uniform(float(25));

  const uDtSec = uniform(0);
  const uTimeMs = uniform(float(0));
  /** A FLOAT, so the boundary slot fades rather than pops as the rate moves. */
  const uActiveCount = uniform(float(0));
  const uWindDirDeg = uniform(float(0));
  const uWindSpeed01 = uniform(float(0));
  /** The wind's integrated travel, copied from the handle in `step` — the eddies ride it. */
  const uAdvection = createWindAdvectionUniforms(TSL);
  const uGustiness01 = uniform(float(0));
  const uWindAirSpeed = uniform(float(2250));
  /**
   * 2026-10-27 — THE WIND'S REAL SPEED. `uWindAirSpeed` used to hold the
   * Studio `windAirSpeedPxS` (2250 px/s per dial unit) directly; it now holds
   * the REAL px/s per dial unit for this scene (`70 m/s × px/m`) times that
   * param ÷ 2250, recomputed each step, so splashes and drips drift at the
   * pace the wind overlay's gusts travel. `uWindStrength01` is the Beaufort
   * strength (`windStrength01ForSpeed01`) for the 0..1 LOOK ramps that were
   * tuned on the old dial.
   */
  let windAirGain = 1;
  const uWindStrength01 = uniform(float(0));
  /**
   * ⭐ THE PERSPECTIVE PAIR. Under a top-down camera a drop descending moves
   * AWAY from the eye, which reads as the M(h) = D / (D − h) magnification
   * collapsing to 1 about the view centre. Kept, but quiet: the author asked
   * for *"less perspective"*, and the streak's steering by it is dialled by
   * `uParallax01` (shipped low).
   */
  const uCamCentre = uniform(vec2(0, 0));
  /** The tuned camera (the `cameraHeight` dial) and the last scene eye's height; see `setEye`. */
  let camTuned = 5000;
  let eyeHeight = 0;
  const uCamHeight = uniform(float(5000));
  /** Extra isotropic scatter around a spawn point, world px (`dripEdgeJitterPx`).
   * Small since the rebuild: drips spread ALONG the eave by `uSpacingPx` now,
   * so this only roughens the lip — the old 100px disc is what scattered drips
   * across the lawn in the author's screenshot. */
  const uEdgeJitterPx = uniform(float(6));
  const uStreakScale = uniform(float(1));
  const uParallax01 = uniform(float(0.12));
  const uSizeScale = uniform(float(1.8));
  const uAlphaMul = uniform(float(1));
  const uRgbMul = uniform(float(1));
  /** The golden-hour colour of the light (`sky-access.js#lightGoldenTint`), (1,1,1) when none. */
  const uSkyTint = uniform(vec3(1, 1, 1));
  /** `dripFallSpeedScale` — scales gravity and terminal speed together. */
  const uFallSpeedScale = uniform(float(0.45));
  /** `dripCurlPx` — per-drop private wobble, px/s. */
  const uCurlPx = uniform(float(CURL_PX));
  /** `dripSplashScale`. */
  const uSplashScale = uniform(float(1));
  /** `dripTurbulence` — the shared eddies' strength. */
  const uTurbulence = uniform(float(1));
  /** ⭐ Cadence, pushed from {@link dripCadence} every frame. */
  const uFlow01 = uniform(float(0));
  const uHangMs = uniform(float(1500));
  const uRestMs = uniform(float(2200));
  /** Throw speed px/s — cadence × `dripThrow`. */
  const uThrowPxS = uniform(float(THROW_PXS[0]));

  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));

  /** Pick a roofline point for this body, from a bounded entropy. */
  const pickPoint = (entropy) => {
    const idx = hash11(entropy.mul(float(3.7)).add(float(7.1)))
      .mul(uSpawnCount.max(float(1)))
      .floor()
      .clamp(float(0), uSpawnCount.max(float(1)).sub(float(1)));
    return spawnPoints.element(idx.toInt());
  };

  /** Decode the packed normal: `(nx, ny)` unit, or `(0, 0)` for an authored spot. */
  const normalOf = (packed) => {
    const has = packed.greaterThanEqual(float(2)).select(float(1), float(0));
    const ang = fract(packed).mul(float(Math.PI * 2));
    return vec2(cos(ang), sin(ang)).mul(has);
  };

  /**
   * ⭐ WHERE ON THE GROUND A DRIP MUST BE SO THAT IT IS *DRAWN* AT ITS EDGE POINT.
   * The draw magnifies a body at height h about the camera centre by M(h), so
   * the stored position is the pre-image `C + (E − C) / M(h)`; it then starts
   * exactly on the eave as drawn and converges as it falls.
   */
  const groundUnder = (edgeXY, heightPx) => {
    const h = heightPx.max(float(0)).min(uCamHeight.mul(float(0.82)));
    return uCamCentre.add(edgeXY.sub(uCamCentre).mul(uCamHeight.sub(h).div(uCamHeight)));
  };

  /**
   * A fresh drop: where on the lip it forms, what it will be thrown with, and
   * its private constants. Shared by the seed and the respawn so the first
   * generation is drawn from exactly the distribution every later one is.
   */
  const freshDrop = (entropy) => {
    const p = pickPoint(entropy);
    const n = normalOf(p.w);
    const hasN = n.length().greaterThan(float(0.5));
    const tangent = vec2(n.y.negate(), n.x);
    const hA = hash11(entropy.mul(float(9.7)).add(float(3.3)));
    const hB = hash11(entropy.mul(float(4.1)).add(float(19.7)));
    const hC = hash11(entropy.mul(float(6.3)).add(float(2.9)));
    // ⭐ ALONG THE EAVE, ON ITS LIP. A roofline point stands for `uSpacingPx`
    // of eave, so its drops spread along that much of it (a continuous lip,
    // not a row of dots), sitting half a texel outward — on the boundary the
    // art draws, rather than under the roof at the texel's centre.
    const lip = p.xy
      .add(n.mul(uTexelPx.mul(float(0.5)).add(float(2))))
      .add(tangent.mul(hA.sub(float(0.5)).mul(uSpacingPx).mul(float(1.15))));
    // A little isotropic roughness either way; an authored spot (no normal)
    // scatters over its own texel instead, since every texel there is a source.
    const discR = hasN.select(uEdgeJitterPx, uEdgeJitterPx.max(uTexelPx.mul(float(0.5))));
    const a = hB.mul(float(Math.PI * 2));
    const xy = lip.add(vec2(cos(a), sin(a)).mul(hC.sqrt().mul(discR)));
    // ⭐ THE THROW. Off the lip along the normal, a little spread along the
    // eave; an authored spot just lets go.
    const throwV = n
      .mul(uThrowPxS.mul(mix(float(0.55), float(1.35), hC)))
      .add(tangent.mul(hA.sub(float(0.5)).mul(uThrowPxS).mul(float(0.35))));
    const brightness = mix(float(0.78), float(1.12), hash11(entropy.mul(float(1.7))));
    const sizePx = mix(float(SIZE_PX[0]), float(SIZE_PX[1]), hash11(entropy.mul(float(2.3)).add(float(11))));
    // ⭐ REST BEFORE FORMING: exponential (−ln u), so drips tick irregularly;
    // clamped at 4× the mean so no slot sleeps through a whole shower.
    const rest = hash11(entropy.mul(float(8.9)).add(float(5.5)))
      .oneMinus()
      .max(float(0.018))
      .log()
      .negate()
      .mul(uRestMs);
    const life = mix(
      float(LIFE_BACKSTOP_SEC[0] * 1000),
      float(LIFE_BACKSTOP_SEC[1] * 1000),
      hash11(entropy.mul(float(5.1)))
    ).add(uHangMs.mul(float(1.6)));
    return {
      pos: groundUnder(xy, p.z),
      vel: throwV,
      custom: vec4(brightness, sizePx, float(0), p.z),
      rest,
      life,
    };
  };

  /** This life's hang, ms — per drop around the cadence's mean, from the
   * (re-randomised every life) life length so successive drops differ. */
  const hangOf = (s, life) =>
    uHangMs.mul(mix(float(0.45), float(1.55), hash11(s.mul(float(0.17)).add(life.mul(float(0.0031)))))).max(float(1));

  const seedKernel = Fn(() => {
    const i = instanceIndex;
    const fi = float(i);
    seed.element(i).assign(fi);
    const d = freshDrop(fi);
    position.element(i).assign(d.pos);
    velocity.element(i).assign(d.vel);
    custom.element(i).assign(d.custom);
    lifeBuf.element(i).assign(d.life);
    // ⚠️ STAGGERED, not all at 0: every slot forming at once would release one
    // synchronised sheet off the whole roofline and then leave it silent.
    age.element(i).assign(
      hash11(fi.mul(float(7.3)))
        .mul(float(-1500))
        .sub(d.rest.mul(float(0.5)))
    );
  })().compute(cap);

  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const pos = position.element(i).toVar();
    const vel = velocity.element(i).toVar();
    const s = seed.element(i);
    const c = custom.element(i).toVar();
    const life = lifeBuf.element(i);
    const nextAge = age.element(i).add(uDtSec.mul(float(1000)));
    const hangMs = hangOf(s, life);
    const released = nextAge.greaterThanEqual(hangMs);
    const airborne = released.and(c.w.greaterThan(float(0)));

    // ⭐ GRAVITY FROM REST, up to this drop's own terminal speed.
    const terminal = float(RAIN_REFERENCE_SPEED * GRAVITY_MUL)
      .mul(mix(float(0.85), float(1.15), hash11(s.mul(float(1.31)).add(life.mul(float(0.0011))))))
      .mul(uFallSpeedScale);
    const vz = airborne.select(c.z.add(float(GRAVITY_PXS2).mul(uFallSpeedScale).mul(uDtSec)).min(terminal), c.z);

    // ⭐ THE AIR. The coherent wind, plus two octaves of the shared curl
    // field advected downwind — divergence-free, so neighbouring drops swirl
    // together like a gust through a curtain of water — plus a small private
    // wobble so two drops in one eddy still part.
    const tSec = uTimeMs.mul(float(0.001));
    const windVec = windFlowVectorNode(TSL, uWindDirDeg).mul(uWindSpeed01).mul(uWindAirSpeed).mul(float(WIND_PUSH));
    // The eddies sit where the air has CARRIED them — `∫ flow·speed dt`, never
    // `windVec × t`, which flung them by `t · dSpeed/dt` during a wind fade.
    const carried = uAdvection.speedFlowSec.add(
      windFlowVectorNode(TSL, uWindDirDeg)
        .mul(uWindSpeed01)
        .mul(windAdvectionDtSecNode(TSL, uTimeMs, uAdvection))
    );
    const advected = pos.sub(carried.mul(uWindAirSpeed).mul(float(WIND_PUSH * 0.6)));
    const eddy = curlNoise2D(TSL, { p: advected, timeSec: tSec, spaceFreq: 0.0035, rate: 0.45 }).add(
      curlNoise2D(TSL, { p: advected, timeSec: tSec, spaceFreq: 0.011, rate: 1.1, phaseX: 17.3, phaseY: -9.1 }).mul(
        float(0.55)
      )
    );
    // Calm air still stirs a little; a gale and gusty air stir hard.
    const turb = eddy
      .mul(float(TURBULENCE_PXS))
      .mul(uTurbulence)
      .mul(float(0.3).add(uWindStrength01.mul(float(1.4))))
      .mul(float(1).add(uGustiness01));
    const phase = s.mul(float(12.9));
    const wobble = vec2(sin(tSec.mul(float(2.3)).add(phase)), cos(tSec.mul(float(1.9)).add(phase.mul(float(1.7))))).mul(
      uCurlPx
    );
    const target = windVec.add(turb).add(wobble);
    const nextVel = vel.add(target.sub(vel).mul(float(1).sub(exp(uDtSec.mul(float(-AIR_DRAG_PER_SEC))))));

    // Waiting and hanging bodies stay put; a landed one is a splash and stays
    // where it hit; only an airborne one moves.
    const nextPos = airborne.select(pos.add(nextVel.mul(uDtSec)), pos);
    // Height counts down once released — past 0 it is the splash's clock.
    const nextH = released.select(c.w.sub(vz.mul(uDtSec)), c.w);

    const done = released
      .and(vz.greaterThan(float(0)))
      .and(nextH.lessThanEqual(vz.mul(float(SPLASH_SEC)).negate()))
      .or(nextAge.greaterThanEqual(life));

    /**
     * ⚠️ **A POSITION-ONLY ENTROPY IS A FIXED POINT HERE** (author: *"they
     * always seem to use the same exact spots"*). A drip respawns onto one of N
     * DISCRETE roofline points, so entropy from position alone re-selects the
     * same point forever. Mixing in the life length, re-randomised every
     * respawn, keeps successive lives of one slot wandering the roofline.
     */
    const entropy = s
      .mul(float(0.61))
      .add(nextPos.x.mul(float(0.011)))
      .add(nextPos.y.mul(float(0.013)))
      .add(life.mul(float(0.0007)));
    const d = freshDrop(entropy);

    position.element(i).assign(done.select(d.pos, nextPos));
    velocity.element(i).assign(done.select(d.vel, airborne.select(nextVel, vel)));
    custom.element(i).assign(done.select(d.custom, vec4(c.x, c.y, vz, nextH)));
    age.element(i).assign(done.select(d.rest.negate(), nextAge));
    lifeBuf.element(i).assign(done.select(d.life, life));
  })().compute(cap);

  // ── THE DRAW ─────────────────────────────────────────────────────────────
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.attributes.position);
  geometry.setAttribute('uv', base.attributes.uv);
  geometry.instanceCount = cap;

  /** 1 for a slot inside the live count, fading across the boundary slot. */
  const aliveOf = (i) => uActiveCount.sub(float(i)).clamp(float(0), float(1));

  /**
   * The falling drop's shape, in one place, because the position AND the
   * varyings both need it (storage reads are vertex-stage only).
   */
  const dropShape = () => {
    const i = instanceIndex;
    const c = custom.element(i);
    const centre = position.element(i);
    const v = velocity.element(i);
    const a = age.element(i);
    const hangMs = hangOf(seed.element(i), lifeBuf.element(i));
    const waiting = a.lessThan(float(0));
    const hanging = waiting.not().and(a.lessThan(hangMs));
    const hang01 = a.div(hangMs).clamp(float(0), float(1));

    // M(h) — the fall, made visible (and kept quiet; see `uParallax01`).
    const persp = uCamHeight.div(uCamHeight.sub(c.w.max(float(0)).min(uCamHeight.mul(float(0.82)))));
    const drawn = uCamCentre.add(centre.sub(uCamCentre).mul(persp));

    // ⭐ THE TAIL TRAILS WHERE THE DROP IS ACTUALLY GOING: its sideways
    // velocity, plus a dialled-down share of the inward M(h) convergence.
    const radial = drawn.sub(uCamCentre).mul(persp).mul(c.z).div(uCamHeight).mul(uParallax01).negate();
    const apparent = v.mul(persp).add(radial);
    const speed = apparent.length();
    const vLen = v.length();
    // A hanging bead stretches along the way it is about to be thrown.
    const fallback = vLen.greaterThan(float(1e-3)).select(v.div(vLen.max(float(1e-3))), vec2(0, 1));
    const dir = hanging.or(speed.lessThan(float(1e-3))).select(fallback, apparent.div(speed.max(float(1e-3))));

    // ⭐ THE BEAD SWELLS, then necks out just before it lets go.
    const swell = hanging.select(float(0.35).add(hang01.sqrt().mul(float(0.65))), float(1));
    // ⭐ AN OCCASIONAL DRIP IS A FAT DROP — it had time to gather on the lip —
    // while runoff breaks into smaller droplets. So a lone drop stays legible
    // and a pour takes its weight from numbers, not from each sprite.
    const gathered = mix(float(1.6), float(0.85), uFlow01);
    const width = c.y.mul(uSizeScale).mul(persp).mul(swell).mul(gathered);
    const neck = hanging.select(float(1).add(smoothstep(float(0.7), float(1), hang01).mul(float(0.7))), float(1));
    // Runoff draws longer ropes than an occasional drop at the same speed.
    const tail = speed
      .mul(float(TAIL_SHUTTER_SEC))
      .mul(uStreakScale)
      .mul(float(1).add(uFlow01.mul(float(1.4))));
    const length = hanging.select(width.mul(neck), width.add(tail));
    const airborne = waiting
      .not()
      .and(hanging.not())
      .and(c.w.greaterThan(float(0)));
    const visible = aliveOf(i).mul(hanging.or(airborne).select(float(1), float(0)));
    return { c, drawn, dir, width, length, hanging, hang01, visible };
  };

  /** `(aspect, brightness, visible, glint)` — the fragment needs the aspect
   * to keep the head round however long the tail is. */
  const vDrip = Fn(() => {
    const sh = dropShape();
    // A forming bead catches the light and shimmers; released drops glint
    // steadily.
    const t = uTimeMs.mul(float(0.001));
    const shimmer = float(0.85).add(sin(t.mul(float(6.5)).add(seed.element(instanceIndex).mul(float(7.7)))).mul(0.25));
    const fadeIn = sh.hanging.select(smoothstep(float(0), float(0.2), sh.hang01), float(1));
    return vec4(
      // The PADDED quad's aspect — the fragment's coordinates span the quad.
      sh.length.add(float(DRAW_PAD_PX)).div(sh.width.add(float(DRAW_PAD_PX))),
      sh.c.x,
      sh.visible.mul(fadeIn),
      sh.hanging.select(shimmer, float(1))
    );
  })().toVarying('vPrecipDrip');

  const material = new THREE.NodeMaterial();
  material.positionNode = Fn(() => {
    const sh = dropShape();
    const perp = vec2(sh.dir.y.negate(), sh.dir.x);
    // A little margin round the drop for the soft edge; collapsed to nothing
    // when there is no drop to draw, so a resting slot costs no fragments.
    const pad = float(DRAW_PAD_PX);
    const w = sh.width.add(pad).mul(sh.visible.greaterThan(float(0)).select(float(1), float(0)));
    const l = sh.length.add(pad).mul(sh.visible.greaterThan(float(0)).select(float(1), float(0)));
    const local = positionGeometry.xy;
    const offset = perp.mul(local.x.mul(w)).add(sh.dir.mul(local.y.mul(l)));
    // Anchor the HEAD on the body: the quad extends backwards along the tail.
    const headBack = sh.dir.mul(l.mul(float(0.5)).sub(w.mul(float(0.5))));
    return vec3(sh.drawn.add(offset).sub(headBack), float(zDepth));
  })();

  /**
   * ⭐ THE DROP, top-down: a round head with a soft darker rim (water's
   * refraction edge — what keeps it legible on pale stone) and a bright
   * glint at its leading edge, trailing a tapering translucent tail.
   * Coordinates in units of the drop's width; the head sits at Y = 0.
   */
  const dropLook = () => {
    const q = uv();
    const A = vDrip.x.max(float(1));
    const X = q.x.sub(float(0.5));
    const Y = q.y.sub(float(1)).mul(A).add(float(0.5));
    const R = float(0.36);
    const dHead = vec2(X, Y).length();
    const head = float(1).sub(smoothstep(R.sub(float(0.2)), R.add(float(0.04)), dHead));
    const tailLen = A.sub(float(0.5)).max(float(1e-3));
    const tt = Y.negate().div(tailLen).clamp(float(0), float(1));
    const halfW = R.mul(float(0.55)).mul(float(1).sub(tt).pow(float(1.2)));
    const behind = Y.lessThan(float(0)).select(float(1), float(0));
    const tail = float(1)
      .sub(smoothstep(halfW.sub(float(0.12)), halfW.add(float(0.04)), X.abs()))
      .mul(float(1).sub(tt).pow(float(1.6)))
      .mul(behind);
    const rim = smoothstep(R.sub(float(0.17)), R.sub(float(0.03)), dHead).mul(head);
    const glint = float(1).sub(smoothstep(float(0.05), float(0.15), vec2(X, Y.sub(float(0.08))).length()));
    return { head, tail, rim, glint };
  };

  /**
   * ⚠️ TRANSLUCENT, WITH ONE HARD GLINT — not a white disc. The first cut of
   * the rebuild drew opaque pearls and read as hail; water from above is mostly
   * see-through, and what the eye actually catches is the specular point and
   * the thin dark refraction edge. Per pixel, the strongest of the three
   * (glint, rim, body) owns the colour and its own alpha.
   */
  material.colorNode = Fn(() => {
    const L = dropLook();
    const body = vec3(0.74, 0.84, 0.96);
    const rimDark = vec3(0.06, 0.09, 0.13);
    const col = mix(body, rimDark, L.rim.mul(float(0.75)));
    const lit = mix(col, vec3(1, 1, 1), L.glint.mul(L.head));
    return lit.mul(vDrip.y).mul(vDrip.w).mul(uRgbMul).mul(uSkyTint);
  })();
  material.opacityNode = Fn(() => {
    const L = dropLook();
    const bead = L.head
      .mul(float(0.38))
      .max(L.rim.mul(float(0.5)))
      .max(L.glint.mul(L.head).mul(float(0.95)));
    const shape = bead.max(L.tail.mul(float(0.3)));
    // Lone drops a touch bolder, a pour's many a touch fainter (see `gathered`).
    return shape
      .mul(vDrip.z)
      .mul(uAlphaMul)
      .mul(mix(float(1.15), float(0.8), uFlow01))
      .min(float(1));
  })();

  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.blending = THREE.NormalBlending;
  /** ⚠️ DoubleSide — the flipped camera inverts winding and `FrontSide` draws
   * NOTHING, silently. */
  material.side = THREE.DoubleSide;
  /** The drips draw INSIDE the world pass (under the overhead tiles), which
   * writes an MRT; an overlay with no `attr` output would leave that
   * attachment undefined. A transparent zero adds nothing to it. */
  material.mrtNode = mrt({ attr: vec4(0, 0, 0, 0) });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  const scene = new THREE.Scene();
  scene.add(mesh);

  // ── THE LANDING ── crown ring, spray, wet mark, from the same instance data.
  const splashGeometry = new THREE.InstancedBufferGeometry();
  splashGeometry.index = base.index;
  splashGeometry.setAttribute('position', base.attributes.position);
  splashGeometry.setAttribute('uv', base.attributes.uv);
  splashGeometry.instanceCount = cap;

  const splashOf = () => {
    const i = instanceIndex;
    const c = custom.element(i);
    const landed = c.w.lessThanEqual(float(0)).and(age.element(i).greaterThanEqual(float(0)));
    const prog = c.w
      .negate()
      .div(c.z.mul(float(SPLASH_SEC)).max(float(1e-3)))
      .clamp(float(0), float(1));
    return { c, landed, prog, visible: aliveOf(i).mul(landed.select(float(1), float(0))) };
  };

  /** `(splash01, brightness, visible, seedHash)`. */
  const vSplash = Fn(() => {
    const sp = splashOf();
    return vec4(sp.prog, sp.c.x, sp.visible, hash11(seed.element(instanceIndex).mul(float(0.731))));
  })().toVarying('vPrecipDripSplash');
  /** `(landing direction xy, flow01, 0)` — spray leans the way the drop was going. */
  const vSplashDir = Fn(() => {
    const v = velocity.element(instanceIndex);
    const len = v.length();
    const lean = len.div(float(60)).clamp(float(0), float(1)).mul(float(0.55));
    return vec4(v.div(len.max(float(1e-3))).mul(lean), uFlow01, float(0));
  })().toVarying('vPrecipDripSplashDir');

  const splashMaterial = new THREE.NodeMaterial();
  splashMaterial.positionNode = Fn(() => {
    const sp = splashOf();
    // Scaled by the drop and by the flow — a pour throws a bigger crown.
    const diam = float(SPLASH_DIAM_PX)
      .mul(uSplashScale)
      .mul(sp.c.y.div(float(1.8)))
      .mul(mix(float(0.85), float(1.5), uFlow01))
      .mul(sp.visible.greaterThan(float(0)).select(float(1), float(0)));
    return vec3(position.element(instanceIndex).add(positionGeometry.xy.mul(diam)), float(zDepth));
  })();

  /** The splash's look: a bright part (crown + spray) and a dark wet mark. */
  const splashLook = () => {
    const p = uv().sub(float(0.5)).mul(float(2));
    const r = p.length();
    const prog = vSplash.x;
    const fade = float(1).sub(prog);
    const wet = float(1)
      .sub(smoothstep(float(0.14), float(0.32), r))
      .mul(fade.pow(float(1.5)))
      .mul(float(0.2));
    // A faint, thin crown — the first cut's bold ring read as soap bubbles
    // once a few hundred overlapped.
    const ringR = mix(float(0.08), float(0.48), prog.pow(float(0.6)));
    const ringW = mix(float(0.05), float(0.02), prog);
    const ring = float(1)
      .sub(smoothstep(float(0), ringW, r.sub(ringR).abs()))
      .mul(fade.pow(float(2)))
      // Crisp on a lone splash, faint where a pour lays hundreds side by side.
      .mul(mix(float(0.7), float(0.25), vSplashDir.z));
    // ⭐ SPRAY: a few droplets thrown outward, leaning the way the drop was
    // travelling (so a gust's splashes all spray downwind), arcing out fast
    // and slowing — `prog^0.55`.
    let spray = float(0);
    for (let k = 0; k < SPRAY_DROPS; k++) {
      const hk = hash11(vSplash.w.mul(float(37.1 + k * 11.3)).add(float(k * 1.618)));
      const ang = hk.add(float(k / SPRAY_DROPS)).mul(float(Math.PI * 2));
      const d0 = vec2(cos(ang), sin(ang)).add(vSplashDir.xy);
      const dk = d0.div(d0.length().max(float(1e-3)));
      const reach = mix(float(0.5), float(0.95), hash11(hk.mul(float(3.3)).add(float(0.7))));
      const at = dk.mul(prog.pow(float(0.55)).mul(reach));
      const dropR = mix(float(0.07), float(0.025), prog);
      spray = spray.max(float(1).sub(smoothstep(dropR.mul(float(0.4)), dropR, p.sub(at).length())));
    }
    spray = spray
      .mul(fade)
      .mul(smoothstep(float(0), float(0.08), prog))
      .mul(mix(float(0.9), float(0.5), vSplashDir.z));
    const bright = ring.max(spray);
    return { wet, bright };
  };

  splashMaterial.colorNode = Fn(() => {
    const L = splashLook();
    const brightCol = vec3(0.82, 0.9, 1.0).mul(vSplash.y).mul(uRgbMul).mul(uSkyTint);
    const wetCol = vec3(0.05, 0.07, 0.09);
    // Per pixel: whichever of the two is stronger here owns the colour.
    const k = L.bright.div(L.bright.add(L.wet).max(float(1e-4)));
    return mix(wetCol, brightCol, k);
  })();
  splashMaterial.opacityNode = Fn(() => {
    const L = splashLook();
    return L.bright.max(L.wet).mul(vSplash.z).mul(uAlphaMul);
  })();
  splashMaterial.transparent = true;
  splashMaterial.depthWrite = false;
  splashMaterial.depthTest = false;
  splashMaterial.blending = THREE.NormalBlending;
  splashMaterial.side = THREE.DoubleSide;
  splashMaterial.mrtNode = mrt({ attr: vec4(0, 0, 0, 0) });

  const splashMesh = new THREE.Mesh(splashGeometry, splashMaterial);
  splashMesh.frustumCulled = false;
  // Just under the falling drops: the splash is on the ground.
  splashMesh.renderOrder = renderOrder - 0.5;
  scene.add(splashMesh);
  // Hidden until there is something to draw: once the meshes are re-parented
  // into the world scene nothing else gates them.
  mesh.visible = false;
  splashMesh.visible = false;

  const pointData = new Float32Array(maxSpawnPoints * 4);
  let seeded = false;
  let liveCount = 0;
  let spawnCount = 0;
  /** ⭐ THE TAIL's state: the emission rate the roofs are still shedding,
   * driven up by rain and draining afterwards (see `setFrame`). */
  let tailLevel = 0;
  let lastRate = 0;
  let lastCadence = dripCadence(0);
  /** `dripTailDurationSec`'s live value — plain JS, only `setFrame` reads it. */
  let tailDurationSec = TAIL_DURATION_SEC;
  /** `dripThrow` — multiplies the cadence's throw. */
  let throwScale = 1;

  return {
    scene,
    /** The two draw meshes (drops, landings), for a caller that draws them
     * inside the WORLD scene — beneath the overhead tiles. */
    meshes: [mesh, splashMesh],
    /** Sort the drips at `order` in the world scene's flat renderOrder; the
     * landing sits just under them (it is on the ground). */
    setLayerOrder(order) {
      if (!Number.isFinite(order)) return;
      mesh.renderOrder = order;
      splashMesh.renderOrder = order - 0.2;
    },
    capacity: cap,

    /** The view's own centre — M(h) magnifies ABOUT it. Pushed per frame. */
    setCamera(centreX, centreY) {
      if (Number.isFinite(centreX) && Number.isFinite(centreY)) uCamCentre.value.set(centreX, centreY);
    },

    /**
     * The frame's scene eye (`scene/scene-eye.js`): centre AND camera. Drips fall from real eave heights, so
     * the `cameraHeight` dial is the camera they were tuned against with a 1000 px eye, and the eye scales it
     * — they recede and loom with the Table and the floors. No eye ⇒ `setCamera` and the dial's raw camera.
     * @param {{x:number,y:number,height:number}|null} eye
     */
    setEye(eye) {
      if (!eye || !(eye.height > 0)) return;
      this.setCamera(eye.x, eye.y);
      eyeHeight = eye.height;
      uCamHeight.value = eyeCameraForFixed(camTuned, eyeHeight);
    },

    /**
     * Hand the engine the roofline. Cheap and idempotent; call when the mask
     * authority's products version moves or the floor changes, NEVER per frame.
     * @param {{points: Float32Array, normals?: Float32Array|null, count: number,
     *   texelPx?: number, spacingPx?: number}} edges - from
     *   `effects/precipitation/drip-edges.js`, `points` stride 3, `normals` stride 2.
     */
    setSpawnPoints(edges) {
      const src = edges?.points ?? null;
      const nrm = edges?.normals ?? null;
      const n = Math.min(maxSpawnPoints, Math.max(0, edges?.count ?? 0));
      pointData.fill(0);
      for (let k = 0; k < n; k++) {
        pointData[k * 4] = src[k * 3];
        pointData[k * 4 + 1] = src[k * 3 + 1];
        pointData[k * 4 + 2] = src[k * 3 + 2];
        // The packed normal (see `spawnPoints`): 1 = none, 2 + angle01 = one.
        const nx = nrm ? nrm[k * 2] : 0;
        const ny = nrm ? nrm[k * 2 + 1] : 0;
        if (nx * nx + ny * ny > 0.25) {
          const a = Math.atan2(ny, nx) / (Math.PI * 2);
          pointData[k * 4 + 3] = 2 + Math.min(0.999999, a - Math.floor(a));
        } else {
          pointData[k * 4 + 3] = 1;
        }
      }
      spawnPoints.value.array.set(pointData);
      spawnPoints.value.needsUpdate = true;
      uSpawnCount.value = n;
      if (Number.isFinite(edges?.texelPx) && edges.texelPx > 0) uTexelPx.value = edges.texelPx;
      if (Number.isFinite(edges?.spacingPx) && edges.spacingPx > 0) uSpacingPx.value = edges.spacingPx;
      spawnCount = n;
      // ⚠️ RE-SEED when the roofline changes: every live body is falling from a
      // point that may no longer exist.
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
     * @param {number} precip01 - drives the tail up while it rains.
     */
    setFrame(dtRealSec, precip01, frame) {
      const p = Number.isFinite(precip01) ? Math.max(0, Math.min(1, precip01)) : 0;
      const dt = Math.max(0, dtRealSec || 0);
      /**
       * ⭐ THE TAIL. Rising is instant (a roof starts dripping as soon as rain
       * hits it). Falling drains like real runoff: fast from a pour, then a
       * long tail of occasional drops — `dL/dt = −L/τ − ε`, an exponential
       * with a small constant drain so it actually reaches zero, at exactly
       * `tailDurationSec` from a full storm (τ = duration/5, so
       * ε = TAIL_STRENGTH / ((e⁵ − 1)·τ)). A storm's eaves are a steady drip
       * after ~2 of the shipped 9⅓ minutes, and the last minutes are the
       * occasional drop — the range the author asked to look good.
       */
      const tau = tailDurationSec / 5;
      const eps = TAIL_STRENGTH / (147.41 * tau);
      const raining = p * TAIL_STRENGTH;
      tailLevel = raining >= tailLevel ? raining : Math.max(0, tailLevel - dt * (tailLevel / tau + eps));
      const rate = Math.max(p, tailLevel);
      lastRate = rate;
      const cad = dripCadence(rate);
      lastCadence = cad;
      const active = cap * cad.density01;
      liveCount = Math.ceil(active);
      uActiveCount.value = active;
      uFlow01.value = cad.flow01;
      uHangMs.value = cad.hangSec * 1000;
      uRestMs.value = cad.restSec * 1000;
      uThrowPxS.value = (THROW_PXS[0] + (THROW_PXS[1] - THROW_PXS[0]) * cad.flow01) * throwScale;
      geometry.instanceCount = Math.max(1, liveCount);
      splashGeometry.instanceCount = Math.max(1, liveCount);
      if (Number.isFinite(frame?.alphaMul)) uAlphaMul.value = frame.alphaMul;
      if (Number.isFinite(frame?.rgbMul)) uRgbMul.value = frame.rgbMul;
      if (Array.isArray(frame?.skyTintRgb) && frame.skyTintRgb.length === 3) uSkyTint.value.set(...frame.skyTintRgb);
      else uSkyTint.value.set(1, 1, 1);
      mesh.visible = splashMesh.visible = spawnCount > 0 && liveCount > 0;
    },

    step(renderer, dtSec, timeMs, wind) {
      if (spawnCount === 0) return;
      if (wind?.ambient) {
        const sp = wind.ambient.speed01?.value;
        const dg = wind.ambient.directionDeg?.value;
        const gu = wind.ambient.gustiness01?.value;
        if (Number.isFinite(sp)) {
          uWindSpeed01.value = sp;
          uWindStrength01.value = windStrength01ForSpeed01(sp);
        }
        if (Number.isFinite(dg)) uWindDirDeg.value = dg;
        if (Number.isFinite(gu)) uGustiness01.value = gu;
        const ppm = wind.ambient.pixelsPerMetre?.value;
        uWindAirSpeed.value =
          windFieldPxPerSecPerUnit(Number.isFinite(ppm) && ppm > 0 ? ppm : WIND_DEFAULT_PIXELS_PER_METRE) * windAirGain;
        writeWindAdvectionUniforms(uAdvection, wind.ambient.advection);
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
      if (Number.isFinite(t.cameraHeight)) {
        camTuned = Math.max(1, t.cameraHeight);
        uCamHeight.value = eyeCameraForFixed(camTuned, eyeHeight);
      }
      if (Number.isFinite(t.windAirSpeedPxS)) windAirGain = Math.max(0, t.windAirSpeedPxS) / 2250;
      if (Number.isFinite(t.dripFallSpeedScale)) uFallSpeedScale.value = Math.max(0.01, t.dripFallSpeedScale);
      if (Number.isFinite(t.dripCurlPx)) uCurlPx.value = Math.max(0, t.dripCurlPx);
      if (Number.isFinite(t.dripSplashScale)) uSplashScale.value = Math.max(0, t.dripSplashScale);
      if (Number.isFinite(t.dripTurbulence)) uTurbulence.value = Math.max(0, t.dripTurbulence);
      if (Number.isFinite(t.dripThrow)) throwScale = Math.max(0, t.dripThrow);
      // ⚠️ Floored well above zero: `setFrame` DIVIDES by this every frame, and
      // the schema's own min (0) is reachable from a dragged slider.
      if (Number.isFinite(t.dripTailDurationSec)) tailDurationSec = Math.max(0.001, t.dripTailDurationSec);
    },

    /** DIAGNOSTIC — set the tail directly (0..1 of a storm's), so a bench can
     * look at any rate without first waiting out the runoff of the last one.
     * Nothing in the game calls this. */
    setTailLevel(tail01) {
      if (Number.isFinite(tail01)) tailLevel = Math.max(0, Math.min(1, tail01)) * TAIL_STRENGTH;
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
        /** ⭐ THE TAIL, reported — "still dripping four minutes after the
         * rain" is a FEATURE, and a reader must be able to tell it apart from
         * "the rain axis is stuck". `tail01` is the level as a fraction of a
         * storm's; `cadence` is what that rate currently looks like. */
        tail: {
          tail01: tailLevel / TAIL_STRENGTH,
          rate: lastRate,
          durationSec: tailDurationSec,
          strength: TAIL_STRENGTH,
        },
        cadence: lastCadence,
        storageBuffers: 7,
      };
    },
  };
}
