/**
 * @fileoverview LIGHTNING — THE PURE HALF: seeded RNG, the fractal bolt-path
 * generator, branching, the burst scheduler, the leader/return-stroke
 * envelope, anchor pairing, the origin-flash light-source builder, and the
 * batched-strand vertex-array bake. NONE of it touches THREE or TSL, which is
 * why it carries this effect's entire Node test suite — mirrors candle-flame-
 * geometry.js's own split.
 *
 * ============================================================================
 * PORTED FROM V2, WITH ONE DELIBERATE STRUCTURAL CHANGE (read before editing)
 * ============================================================================
 *
 * The path/branch/envelope MATH below is a faithful port of
 * `legacy/compositor-v2/effects/LightningEffectV2.js` (frozen/quarantined;
 * read directly for this port, not from a summary) — the recursive midpoint
 * displacement, the arc-length resample, the branch attach/angle/length
 * formulas and the leader/restrike/decay envelope are all V2's own numbers.
 *
 * What changed: V2 drew every strike's shape from a MUTABLE, POOL-SLOT-OWNED
 * rng — a strike's exact path depended on how many earlier strikes happened
 * to have occupied that same pool slot, an implementation detail of spawn/
 * reap order, not of the strike's own identity. Here, every burst's shape is
 * derived PURELY from `(source.seed, burstIndex)` via {@link mixSeed} — the
 * exact same burst always produces the exact same bolt, independent of
 * spawn/reap history, which is what makes this file Node-testable at all and
 * matches this project's own "deterministic-from-a-hash, never bare mutable
 * state" convention (effects/fluid/fluid-pump.js's own discipline).
 *
 * V2's `flickerChance` was a PER-FRAME dice roll scaled by that frame's own
 * `dt` — inherently stateful and frame-rate-dependent, which has no meaning
 * for a pure function of absolute time (and no meaning to a shader, which has
 * no "last frame" to compare against). {@link computeStrandEnvelope} replaces
 * it with a continuous, deterministic hash-based flicker keyed on
 * `(strand.seed, floor(t * FLICKER_TICK_HZ))` — visually the same "occasional
 * twitchy dim", but a pure function of `(nowMs, strand)` so the exact same
 * envelope can be asserted in a Node test AND hand-transcribed into the TSL
 * shader (lightning-render.js) with no per-frame CPU state either side.
 *
 * @module effects/lightning-geometry
 */

import { LIGHT_ELEVATION_UNCONFIGURED_SENTINEL } from './lighting/point-light-illumination.js';

// ============================================================================
// SEEDED RNG — an exact port of V2's own hash + LCG (legacy/compositor-v2/
// effects/LightningEffectV2.js `_hashStringToUint`/`_randFloat`/
// `_randFloatRange`/`_randInt`), so a V2 map-maker's tuned look ports with the
// same STYLE of randomness even though determinism now derives differently
// (see the module header). `_hashStringToUint` is FNV-1a (32-bit offset basis
// 2166136261, prime 16777619); `_randFloat` is a classic Numerical-Recipes-
// style LCG (multiplier 1664525, increment 1013904223, mod 2^32).
// ============================================================================

/** @param {string} str @returns {number} a uint32 seed. */
export function hashStringToSeed(str) {
  let h = 2166136261;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Fold a second integer into a seed, for deriving independent sub-streams
 * (a burst's shape from its source; a branch's own path from its parent
 * strike) without ever sharing mutable rng state across them. A standard
 * integer-hash finalizer (Thomas Wang / MurmurHash3-style), not V2's own —
 * V2 had no equivalent (its sub-streams were separate mutable pool-slot
 * objects, not derived seeds), so there is nothing to port here, only to
 * design well: good avalanche, fast, deterministic.
 * @param {number} seed @param {number} salt @returns {number} a uint32 seed.
 */
export function mixSeed(seed, salt) {
  let h = (seed ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** @param {number} seed @returns {{state: number}} a fresh mutable rng stream. */
export function createRng(seed) {
  return { state: seed >>> 0 };
}

/** @param {{state: number}} rng @returns {number} a float in [0, 1). */
export function randFloat(rng) {
  rng.state = (Math.imul(rng.state, 1664525) + 1013904223) >>> 0;
  return rng.state / 4294967296;
}

/** @returns {number} a float in [a, b). */
export function randFloatRange(rng, a, b) {
  return a + (b - a) * randFloat(rng);
}

/** @returns {number} an integer in [a, b] inclusive. */
export function randInt(rng, a, b) {
  const lo = Math.min(a, b) | 0;
  const hi = Math.max(a, b) | 0;
  return lo + Math.floor(randFloat(rng) * (hi - lo + 1));
}

/** A uint32 seed as a stable [0,1) float — for sin-phase uses V2 fed
 * `strike.seed` (itself a [0,1) float) into directly. */
function seedToUnitFloat(seed) {
  return (seed >>> 0) / 4294967296;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/** Cubic smoothstep of an already-nonnegative ratio, clamped at 1 — V2's own
 * `leaderT*leaderT*(3-2*leaderT)` after `Math.min(1.0, ratio)`. */
function smooth01(ratio) {
  const c = clamp01(ratio);
  return c * c * (3 - 2 * c);
}

// ============================================================================
// THE FRACTAL PATH — V2's `_buildFractalPath`/`_resamplePath`/the path half
// of `_fillStrikeGeometry`, byte-for-byte the same formulas.
// ============================================================================

/** Recursive midpoint displacement — exact port of V2's `_buildFractalPath`. */
function buildFractalPath(x0, y0, x1, y1, rng, displacement, depth, outX, outY) {
  if (depth <= 0) {
    outX.push(x0);
    outY.push(y0);
    return;
  }
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.max(1e-4, Math.hypot(dx, dy));
  const nx = -dy / len;
  const ny = dx / len;
  const disp = randFloatRange(rng, -1, 1) * displacement;
  const cmx = mx + nx * disp;
  const cmy = my + ny * disp;
  const nextDisp = displacement * 0.58;
  buildFractalPath(x0, y0, cmx, cmy, rng, nextDisp, depth - 1, outX, outY);
  buildFractalPath(cmx, cmy, x1, y1, rng, nextDisp, depth - 1, outX, outY);
}

/** Resample a polyline to an exact point count by arc length — exact port of
 * V2's `_resamplePath`. */
function resamplePath(pathX, pathY, pointCount) {
  if (pathX.length < 2 || pointCount < 2) {
    return { xs: pathX.slice(), ys: pathY.slice() };
  }
  const segCount = pathX.length - 1;
  const segLens = new Float64Array(segCount);
  let totalLen = 0;
  for (let i = 0; i < segCount; i++) {
    const dx = pathX[i + 1] - pathX[i];
    const dy = pathY[i + 1] - pathY[i];
    const len = Math.hypot(dx, dy);
    segLens[i] = len;
    totalLen += len;
  }
  if (totalLen <= 1e-4) {
    return { xs: new Array(pointCount).fill(pathX[0]), ys: new Array(pointCount).fill(pathY[0]) };
  }
  const xs = new Array(pointCount);
  const ys = new Array(pointCount);
  let segIdx = 0;
  let segStart = 0;
  for (let p = 0; p < pointCount; p++) {
    const target = (p / (pointCount - 1)) * totalLen;
    while (segIdx < segCount - 1 && segStart + segLens[segIdx] < target) {
      segStart += segLens[segIdx];
      segIdx++;
    }
    const segLen = Math.max(1e-6, segLens[segIdx]);
    const localT = clamp01((target - segStart) / segLen);
    xs[p] = pathX[segIdx] + (pathX[segIdx + 1] - pathX[segIdx]) * localT;
    ys[p] = pathY[segIdx] + (pathY[segIdx + 1] - pathY[segIdx]) * localT;
  }
  return { xs, ys };
}

/**
 * Generate one bolt (or branch) path: a big lazy arc bow, fractal-displaced
 * in two halves, resampled to `pointCount`, then a per-vertex micro-jitter
 * pass that fades toward the tip. Exact port of the path half of V2's
 * `_fillStrikeGeometry` (the ribbon-mesh vertex bake stays in
 * lightning-render.js / this file's own vertex-array builder below).
 *
 * @param {number} startX @param {number} startY @param {number} endX @param {number} endY
 * @param {number} pointCount
 * @param {{state:number}} rng
 * @param {{macroDisplacement:number, curveAmount:number, microJitter:number}} params
 * @param {number} [displacementScale=1] - a branch's own dampening (V2's `dispScale`).
 * @returns {{xs: number[], ys: number[]}}
 */
export function generateBoltPath(startX, startY, endX, endY, pointCount, rng, params, displacementScale = 1) {
  const dirX = endX - startX;
  const dirY = endY - startY;
  const dirLen = Math.max(1e-4, Math.hypot(dirX, dirY));
  const nX = -dirY / dirLen;
  const nY = dirX / dirLen;

  const s = Math.max(0, displacementScale);
  const macroNorm = Math.max(0, params.macroDisplacement) / 400;
  const curveBias = clamp01(params.curveAmount);
  const arcSign = randFloat(rng) < 0.5 ? -1 : 1;
  const bow = curveBias * (0.2 + macroNorm * 0.22);
  const midX = (startX + endX) * 0.5 + nX * dirLen * bow * arcSign;
  const midY = (startY + endY) * 0.5 + nY * dirLen * bow * arcSign;

  const chaos = 0.22 + curveBias * 0.9;
  const baseDisp = dirLen * Math.max(0.055, macroNorm * chaos) * s;
  const depth = Math.max(1, Math.round(Math.log2(Math.max(2, pointCount - 1))));

  const rawX = [];
  const rawY = [];
  buildFractalPath(startX, startY, midX, midY, rng, baseDisp, depth, rawX, rawY);
  buildFractalPath(midX, midY, endX, endY, rng, baseDisp * 0.85, depth, rawX, rawY);
  rawX.push(endX);
  rawY.push(endY);

  const resampled = resamplePath(rawX, rawY, pointCount);
  const microNorm = Math.max(0, params.microJitter) / 120;
  const micro = dirLen * Math.max(0.004, microNorm * 0.035) * s;

  const xs = new Array(pointCount);
  const ys = new Array(pointCount);
  for (let i = 0; i < pointCount; i++) {
    const t = pointCount <= 1 ? 0 : i / (pointCount - 1);
    const tipEase = t * t * (3 - 2 * t);
    const jitterFalloff = 1 - tipEase;
    const dMicro = randFloatRange(rng, -1, 1) * micro * jitterFalloff;
    xs[i] = resampled.xs[i] + nX * dMicro;
    ys[i] = resampled.ys[i] + nY * dMicro;
  }
  return { xs, ys };
}

// ============================================================================
// BURST SCHEDULING — pure, deterministic per (sourceSeed, burstIndex), so the
// subsystem can ask "when's this source's next burst" without owning any
// mutable rng itself. V2's own `nextBurstAt` write, reshaped as a pure query.
// ============================================================================

/**
 * @param {number} sourceSeed
 * @param {number} burstIndex - 0 for the source's very first burst (V2 drew
 *   that one from `[0, maxDelayMs]` specifically, to stagger freshly-seen
 *   sources across a full cycle immediately rather than always waiting at
 *   least `minDelayMs` — pass `loMs=0` for that call; every later burst uses
 *   `[minDelayMs, maxDelayMs]`, V2's own post-strike scheduling range).
 * @param {number} loMs @param {number} hiMs
 * @returns {number} milliseconds until the next burst.
 */
export function nextBurstDelayMs(sourceSeed, burstIndex, loMs, hiMs) {
  const rng = createRng(mixSeed(sourceSeed, (burstIndex ^ 0x5a17) >>> 0));
  const lo = Math.max(0, Math.min(loMs, hiMs));
  const hi = Math.max(0, Math.max(loMs, hiMs));
  return hi <= lo ? lo : randFloatRange(rng, lo, hi);
}

// ============================================================================
// ONE BURST — the main strike + its branches, fully generated from
// (source, burstIndex, spawnMs, params). Pure; same inputs, same bolt, always.
// ============================================================================

/**
 * @typedef {object} LightningStrand
 * @property {boolean} isBranch
 * @property {number} seed - this strand's own uint32 seed (flicker phase etc).
 * @property {number} spawnMs @property {number} durationMs
 * @property {number} leaderFrac @property {number} restrikeCount
 * @property {number} growthSpeed - 1 for a main strike; V2's randomized 0.84–0.96 for a branch.
 * @property {number|null} parentSpawnMs @property {number|null} parentDurationMs @property {number|null} parentLeaderFrac
 * @property {number} baseIntensity @property {number} widthScale
 * @property {number[]} xs @property {number[]} ys
 * @property {number} [startX] @property {number} [startY] @property {number} [endX] @property {number} [endY] - main strikes only (V2's flashStart/EndX/Y — origin-flash anchor points).
 */

/**
 * @param {object} args
 * @param {{seed:number, startX:number, startY:number, endX:number, endY:number}} args.source
 * @param {number} args.burstIndex
 * @param {number} args.spawnMs
 * @param {number} args.maxPointsPerStrand - the render buffer's per-strand capacity (V2's `_maxPointsPerStrike`).
 * @param {object} args.params - LIGHTNING_PARAMS' resolved values.
 * @returns {{main: LightningStrand, branches: LightningStrand[]}}
 */
export function generateBurst({ source, burstIndex, spawnMs, maxPointsPerStrand, params }) {
  const strikeSeed = mixSeed(source.seed, burstIndex);
  const strikeRng = createRng(strikeSeed);

  const isWild = randFloat(strikeRng) < params.wildArcChance;

  const restrikeCount = randInt(strikeRng, params.burstMinStrikes, params.burstMaxStrikes);
  const leaderBase = Math.max(0.1, params.leaderFraction);
  const leaderFrac = randFloatRange(strikeRng, Math.max(0.12, leaderBase - 0.05), Math.min(0.35, leaderBase + 0.05));

  const startX = source.startX;
  const startY = source.startY;
  let endX = source.endX;
  let endY = source.endY;

  if (params.endPointRandomnessPx > 0) {
    endX += randFloatRange(strikeRng, -params.endPointRandomnessPx, params.endPointRandomnessPx);
    endY += randFloatRange(strikeRng, -params.endPointRandomnessPx, params.endPointRandomnessPx);
  }

  if (isWild) {
    const dx = randFloatRange(strikeRng, -1, 1);
    const dy = randFloatRange(strikeRng, -1, 1);
    const len = Math.max(1e-4, Math.hypot(dx, dy));
    const dist = randFloatRange(strikeRng, 200, 900);
    endX = startX + (dx / len) * dist;
    endY = startY + (dy / len) * dist;
  }

  const mainDx = endX - startX;
  const mainDy = endY - startY;
  const mainLen = Math.max(1e-4, Math.hypot(mainDx, mainDy));

  const seg = Math.max(4, Math.min(maxPointsPerStrand - 1, Math.floor(params.segments)));
  const pointCount = seg + 1;

  const { xs: mainXs, ys: mainYs } = generateBoltPath(startX, startY, endX, endY, pointCount, strikeRng, params, 1);

  const baseIntensity = Math.max(0.05, source.intensity ?? 1);
  const durationMs = Math.max(20, params.strikeDurationMs);
  // THE STRIKE'S OWN HEIGHT-GATE INPUT — carried straight from `source`
  // (see `groupLightningAnchorsIntoSources`' own doc). Branches inherit the
  // SAME value below: a branch physically emanates from its parent strike,
  // so it belongs to the same floor by construction, never a second lookup.
  const elevationRank = Number.isFinite(source.elevationRank)
    ? source.elevationRank
    : LIGHT_ELEVATION_UNCONFIGURED_SENTINEL;

  const main = {
    isBranch: false,
    linkId: source.linkId,
    seed: strikeSeed,
    spawnMs,
    durationMs,
    leaderFrac,
    restrikeCount,
    growthSpeed: 1,
    parentSpawnMs: null,
    parentDurationMs: null,
    parentLeaderFrac: null,
    baseIntensity,
    elevationRank,
    widthScale: 1,
    xs: mainXs,
    ys: mainYs,
    startX,
    startY,
    endX,
    endY,
    // The ONE piece of mutable state a strand carries post-generation — see
    // checkReturnStrokeTrigger's own header. Branches never get one; V2 never
    // gave branches their own outside-flash trigger either.
    returnStrokeTriggered: false,
  };

  const branches = [];
  if (params.branchMax > 0 && randFloat(strikeRng) < params.branchChance) {
    const maxBranches = Math.max(0, Math.floor(params.branchMax));
    const branchCount = randInt(strikeRng, 1, Math.max(1, maxBranches));
    const startIdxMax = Math.max(2, pointCount - 2);

    for (let bi = 0; bi < branchCount; bi++) {
      const r = randFloat(strikeRng);
      const idx = 1 + Math.min(startIdxMax - 1, Math.floor(Math.pow(r, 1.7) * (startIdxMax - 1)));
      const iPrev = Math.max(0, idx - 1);
      const iNext = Math.min(pointCount - 1, idx + 1);
      let tx = mainXs[iNext] - mainXs[iPrev];
      let ty = mainYs[iNext] - mainYs[iPrev];
      const tlen = Math.max(1e-4, Math.hypot(tx, ty));
      tx /= tlen;
      ty /= tlen;

      const sign = randFloat(strikeRng) < 0.5 ? -1 : 1;
      const angleDeg = Math.max(10, params.branchAngleDeg) + randFloatRange(strikeRng, -8, 8);
      const angleRad = angleDeg * sign * (Math.PI / 180);
      const cosR = Math.cos(angleRad);
      const sinR = Math.sin(angleRad);
      const bx = tx * cosR - ty * sinR;
      const by = tx * sinR + ty * cosR;

      const frac = randFloatRange(strikeRng, params.branchLengthMin, params.branchLengthMax);
      const branchLen = Math.max(10, mainLen * Math.max(0.05, frac));

      const bStartX = mainXs[idx];
      const bStartY = mainYs[idx];
      const bEndX = bStartX + bx * branchLen;
      const bEndY = bStartY + by * branchLen;

      const bSeg = Math.max(3, Math.min(maxPointsPerStrand - 1, Math.floor(seg * 0.5)));
      const bPointCount = bSeg + 1;
      const dispScale = Math.max(0.42, Math.min(1, branchLen / Math.max(1, mainLen)));

      // The branch's OWN fractal-noise stream — a separate seed from the
      // parent's (V2's own separate `branch.rng`, a different pool slot),
      // so its shape is independent of how many branches came before it in
      // this same burst.
      const branchSeed = mixSeed(strikeSeed, bi + 1);
      const branchRng = createRng(branchSeed);
      const { xs: bxs, ys: bys } = generateBoltPath(
        bStartX,
        bStartY,
        bEndX,
        bEndY,
        bPointCount,
        branchRng,
        params,
        dispScale
      );

      const growthSpeed = randFloatRange(strikeRng, 0.84, 0.96);

      branches.push({
        isBranch: true,
        seed: branchSeed,
        spawnMs,
        durationMs: Math.max(20, params.strikeDurationMs * Math.max(0.1, params.branchDurationScale)),
        leaderFrac, // SAME as parent — V2's own branch.leaderFrac = strike.leaderFrac
        restrikeCount, // SAME as parent
        growthSpeed,
        parentSpawnMs: spawnMs,
        parentDurationMs: durationMs,
        parentLeaderFrac: leaderFrac,
        baseIntensity: Math.max(0.01, baseIntensity * Math.max(0.05, params.branchIntensityScale)),
        elevationRank,
        widthScale: Math.max(0.05, params.branchWidthScale),
        xs: bxs,
        ys: bys,
      });
    }
  }

  return { main, branches };
}

// ============================================================================
// THE ENVELOPE — leader growth + return-stroke restrike/decay/connect-spike,
// an exact port of V2's `_computeStrikeEnvelope`'s SHAPE (the flicker term is
// redesigned — see the module header).
// ============================================================================

/** How often the deterministic flicker re-rolls, in Hz — a continuous stand-in
 * for V2's per-frame `flickerChance * dt * rate` dice roll (see module header). */
const FLICKER_TICK_HZ = 20;

function flickerMultiplier(seed, nowMs, flickerChance, loMul, hiMul, salt) {
  if (flickerChance <= 0) return 1;
  const tick = Math.floor((nowMs / 1000) * FLICKER_TICK_HZ);
  const rollSeed = mixSeed(seed, (tick * 2 + salt) >>> 0);
  const roll = seedToUnitFloat(rollSeed);
  if (roll >= flickerChance) return 1;
  const depthSeed = mixSeed(seed, (tick * 2 + salt + 1) >>> 0);
  const depth = seedToUnitFloat(depthSeed);
  return loMul + (hiMul - loMul) * depth;
}

/**
 * @param {number} nowMs
 * @param {LightningStrand} strand
 * @returns {{env: number, growth: number, age01: number}} `env` is the
 *   brightness multiplier (V2's `envelope.env`), `growth` is the leader-reveal
 *   fraction 0..1 (drives the shader's growth mask), `age01` is `t` itself
 *   (drives width tapering with strike age).
 */
export function computeStrandEnvelope(nowMs, strand) {
  const t = clamp01((nowMs - strand.spawnMs) / Math.max(1, strand.durationMs));
  const leaderFrac = Math.max(0.08, strand.leaderFrac);

  let growth;
  if (strand.isBranch && strand.parentSpawnMs != null) {
    const parentT = (nowMs - strand.parentSpawnMs) / Math.max(1, strand.parentDurationMs);
    const parentActive = parentT >= 0 && parentT < 1;
    if (parentActive) {
      const parentLeaderFrac = Math.max(0.08, strand.parentLeaderFrac ?? leaderFrac);
      const parentGrowth = smooth01(parentT / parentLeaderFrac);
      growth =
        parentGrowth >= 1 ? Math.min(1, strand.growthSpeed) : Math.min(parentGrowth * strand.growthSpeed, parentGrowth);
    } else {
      growth = smooth01(t / leaderFrac);
    }
  } else {
    growth = smooth01(t / leaderFrac);
  }

  const age01 = t;
  let env;
  if (t < leaderFrac) {
    const leaderProgress = t / leaderFrac;
    env = 0.05 + 0.16 * leaderProgress;
    env *= flickerMultiplier(strand.seed, nowMs, strand.flickerChance ?? 0, 0.2, 0.85, 0);
  } else {
    const postT = clamp01((t - leaderFrac) / Math.max(0.001, 1 - leaderFrac));
    const restrikes = Math.max(0, Math.sin(postT * strand.restrikeCount * Math.PI));
    const decay = Math.pow(Math.max(0, 1 - postT), 2);
    const connectSpike = Math.exp(-postT * 28) * 1.75;
    env = Math.max(restrikes * decay, connectSpike);
    env = Math.max(env, decay * 0.1);
    env *= flickerMultiplier(strand.seed, nowMs, strand.flickerChance ?? 0, 0.75, 1.0, 1);
  }

  return { env, growth, age01 };
}

// ============================================================================
// THE OUTSIDE FLASH — a screen-wide flash signal, triggered when a main
// strand's return stroke connects (growth crosses ~1 for the first time in
// its life). Exact port of V2's `_updateFlash` envelope math; V2's own
// screen-space strike UV/direction publishing is dropped (it needs a camera,
// which this pure module never touches — a real gap if a future consumer
// wants "which direction did that flash come from", not a param this ports).
// ============================================================================

/**
 * Has this main strand's return stroke just connected THIS check (growth
 * reached V2's own 0.995 threshold), and it hasn't already been marked?
 * Mutates `strand.returnStrokeTriggered` in place — the one piece of mutable
 * state a strand object carries after it's generated, mirroring V2's own
 * `strike.returnStrokeTriggered` flag exactly (never reset once true; a
 * strand fires its flash-trigger at most once per lifetime).
 * @param {number} nowMs @param {LightningStrand} strand
 * @returns {{triggered:boolean, intensity:number}}
 */
export function checkReturnStrokeTrigger(nowMs, strand) {
  if (strand.isBranch || strand.returnStrokeTriggered) return { triggered: false, intensity: 0 };
  const { env, growth } = computeStrandEnvelope(nowMs, strand);
  if (growth < 0.995) return { triggered: false, intensity: 0 };
  strand.returnStrokeTriggered = true;
  return { triggered: true, intensity: env * strand.baseIntensity };
}

/**
 * The outside flash's own attack/decay/flicker envelope — exact port of V2's
 * `_updateFlash` (minus screen-space UV publishing, see this section's own
 * header). Pure: `flashState` is read, never mutated (the caller owns when
 * to update `flashStartMs`/`flashPeak`, via {@link checkReturnStrokeTrigger}).
 *
 * @param {number} nowMs
 * @param {{flashStartMs:number, flashPeak:number, flashSeed:number}} flashState
 * @param {object} params - LIGHTNING_PARAMS' resolved values.
 * @returns {number} the current flash value, 0 when inactive/disabled.
 */
export function computeOutsideFlashSignal(nowMs, flashState, params) {
  if (!params.outsideFlashEnabled || flashState.flashStartMs < 0) return 0;

  const attackMs = Math.max(0, params.outsideFlashAttackMs);
  const decayMs = Math.max(1, params.outsideFlashDecayMs);
  const curve = Math.max(0.01, params.outsideFlashCurve);
  const dtMs = Math.max(0, nowMs - flashState.flashStartMs);

  let env;
  if (attackMs > 0 && dtMs < attackMs) {
    env = dtMs / attackMs;
  } else {
    const t = (dtMs - attackMs) / decayMs;
    env = Math.pow(Math.max(0, 1 - t), curve);
  }
  if (env <= 0.0001) return 0;

  let flash = env * Math.max(0, flashState.flashPeak) * Math.max(0, params.outsideFlashGain);

  const flickAmt = clamp01(params.outsideFlashFlickerAmount);
  if (flickAmt > 0) {
    const rate = Math.max(0, params.outsideFlashFlickerRate);
    const w = 2 * Math.PI * rate;
    const flick = 0.5 + 0.5 * Math.sin((nowMs / 1000) * w + flashState.flashSeed * 31.7);
    flash *= 1 - flickAmt + flickAmt * flick;
  }

  const clampV = Math.max(0, params.outsideFlashMaxClamp);
  return clampV > 0 ? Math.min(flash, clampV) : flash;
}

// ============================================================================
// ANCHOR PAIRING — two `lightning` anchors sharing a `linkId` (one `role:
// 'start'`, one `role:'end'`) form one bolt SOURCE. `role:'waypoint'` anchors
// (imported from a V2 3+-point "wandering" group) are collected but not acted
// on — the `wandering-source` deferred rung (effects/lightning.js).
// ============================================================================

/**
 * @param {Array<{id:string, x:number, y:number, params?:object, elevationRank?:number}>} anchors
 * @returns {{
 *   sources: Array<{linkId:string, seed:number, startX:number, startY:number, endX:number, endY:number, intensity:number, elevationRank:number}>,
 *   orphaned: Array<{id:string, linkId:string, role:string}>,
 * }}
 */
export function groupLightningAnchorsIntoSources(anchors) {
  const byLink = new Map();
  for (const a of Array.isArray(anchors) ? anchors : []) {
    const linkId = typeof a?.params?.linkId === 'string' ? a.params.linkId : '';
    if (!linkId) continue;
    let bucket = byLink.get(linkId);
    if (!bucket) {
      bucket = { start: null, end: null, waypoints: [] };
      byLink.set(linkId, bucket);
    }
    const role = a.params?.role;
    if (role === 'start' && !bucket.start) bucket.start = a;
    else if (role === 'end' && !bucket.end) bucket.end = a;
    else if (role === 'waypoint') bucket.waypoints.push(a);
    else if (role === 'start' || role === 'end') {
      // A second anchor claiming the same role for this linkId — reported as
      // orphaned rather than silently overwriting the first (never guess
      // which one the author meant).
      bucket.waypoints.push(a);
    }
  }

  const sources = [];
  const orphaned = [];
  for (const [linkId, bucket] of byLink) {
    if (bucket.start && bucket.end) {
      const intensityStart = Number(bucket.start.params?.intensity);
      const intensityEnd = Number(bucket.end.params?.intensity);
      const intensity = Number.isFinite(intensityStart)
        ? intensityStart
        : Number.isFinite(intensityEnd)
          ? intensityEnd
          : 1;
      // THE BOLT'S OWN HEIGHT-GATE INPUT (2026-08-03) — the START anchor's own
      // resolved rank (`boot.js#getLightningRenderState`). A bolt visually
      // originates at its start point; using either anchor's own band would
      // be defensible, but a strike genuinely does travel start→end, so the
      // origin's own floor is the more honest single answer when the two
      // anchors disagree. Defaults to the unconfigured sentinel (never 0) if
      // absent — a hand-built test fixture predating this field gets the OLD
      // "always fully reaches" behaviour, never a silently introduced gate.
      const rankRaw = Number(bucket.start.elevationRank);
      sources.push({
        linkId,
        seed: hashStringToSeed(linkId),
        startX: bucket.start.x,
        startY: bucket.start.y,
        endX: bucket.end.x,
        endY: bucket.end.y,
        intensity,
        elevationRank: Number.isFinite(rankRaw) ? rankRaw : LIGHT_ELEVATION_UNCONFIGURED_SENTINEL,
      });
    } else {
      if (bucket.start) orphaned.push({ id: bucket.start.id, linkId, role: 'start' });
      if (bucket.end) orphaned.push({ id: bucket.end.id, linkId, role: 'end' });
      for (const w of bucket.waypoints) orphaned.push({ id: w.id, linkId, role: w.params?.role ?? 'waypoint' });
    }
  }
  return { sources, orphaned };
}

// ============================================================================
// THE ORIGIN FLASH LIGHT — a real point-light descriptor per active MAIN
// strand (never a branch — V2 never gave branches their own origin flash),
// shaped exactly like `candle-flame-geometry.js#buildCandleLightSources`'
// output so it flows through the identical point-light-pool path.
// ============================================================================

/** A closed circular polygon around (cx, cy) — the same naive-circle
 * fallback shape candle-flame-geometry.js#candleCirclePolygon provides,
 * duplicated here (a few lines) rather than imported: this effect's own
 * light-source builder should not depend on candle's for a generic N-gon.
 * Only a FALLBACK, never the final look when wall-clipping is available —
 * see buildLightningLightSources' own header. */
function lightningCirclePolygon(cx, cy, radius, segments = 24) {
  const n = Math.max(3, Math.floor(segments));
  const pts = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    pts[i * 2] = cx + Math.cos(theta) * radius;
    pts[i * 2 + 1] = cy + Math.sin(theta) * radius;
  }
  return pts;
}

/** Exported so lightning-subsystem.js can push the SAME colour decode onto
 * the material's live uniforms — one implementation, not two. */
export function hexToRgb01(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? ''));
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** V2's `_computeOriginFlashBaseColor` — outer→core lerp by intensity, then a
 * hotMix lerp toward white, scaled by the same intensity fraction. */
function computeOriginFlashBaseColor(outerRgb, coreRgb, intensityMul, hotMix) {
  const t = clamp01(intensityMul);
  const r = outerRgb[0] + (coreRgb[0] - outerRgb[0]) * t;
  const g = outerRgb[1] + (coreRgb[1] - outerRgb[1]) * t;
  const b = outerRgb[2] + (coreRgb[2] - outerRgb[2]) * t;
  const mix = clamp01(hotMix) * t;
  return [r + (1 - r) * mix, g + (1 - g) * mix, b + (1 - b) * mix];
}

/** V2's `_computeOriginFlashVisualMul` — leader precursor, intensity gain,
 * continuous sin-phase flicker (already frame-independent in V2, ported
 * verbatim), a minimum-gain floor. */
function computeOriginFlashVisualMul(strand, strikeIntensity, growth, age01, nowMs, params) {
  const leaderFrac = Math.max(0.08, strand.leaderFrac);
  const precursor = Math.max(0, params.originFlashLeaderPrecursor);
  let visual = Math.max(0, strikeIntensity) * Math.max(0, params.originFlashStrikeScale);

  if (age01 < leaderFrac && growth < 0.999) {
    const leaderT = growth / Math.max(0.001, leaderFrac);
    visual = Math.max(visual * leaderT, precursor * leaderT);
  }

  visual *= Math.max(0, params.originFlashIntensity);

  const flickAmt = clamp01(params.originFlashFlickerAmount);
  if (flickAmt > 0) {
    const rate = Math.max(0, params.originFlashFlickerRate);
    const w = 2 * Math.PI * rate;
    const flick = 0.5 + 0.5 * Math.sin((nowMs / 1000) * w + seedToUnitFloat(strand.seed) * 41.3);
    visual *= 1 - flickAmt + flickAmt * flick;
  }

  return Math.max(Math.max(0, params.originFlashMinGain), visual);
}

/**
 * Which end(s) a strand's origin flash sits at, and each target's relative
 * scale — exact port of V2's `_getOriginFlashAnchorTargets` (END first for
 * 'impact'/'both', then START for 'start'/'both' — matches V2's own order).
 */
function originFlashAnchorTargets(strand, anchorMode) {
  const targets = [];
  if (anchorMode === 'impact' || anchorMode === 'both') {
    targets.push({ role: 'end', x: strand.endX, y: strand.endY, scale: anchorMode === 'both' ? 0.85 : 1 });
  }
  if (anchorMode === 'start' || anchorMode === 'both') {
    targets.push({ role: 'start', x: strand.startX, y: strand.startY, scale: 1 });
  }
  return targets;
}

/**
 * Build the origin-flash point-light descriptors for every currently active,
 * non-branch strand. Pure (no THREE, no Foundry) — Node-testable, and the
 * viewer just merges the result into `point-light-pool.js`'s light list.
 *
 * ⚠️ `sourceId` MUST be stable per `(linkId, targetIndex)`, NEVER per-burst —
 * confirmed by reading `point-light-pool.js#update()` directly: any
 * `sourceId` not present in a given frame's light list is only ever HIDDEN
 * (`mesh.visible = false`), never disposed, so a per-burst id would leak one
 * permanent mesh/material/geometry set per strike for the rest of the
 * session. `${linkId}:${role}` (role = 'start'/'end') reuses the SAME mesh
 * burst after burst, exactly like a candle's light.
 *
 * `wallClipRadiusPx` is DELIBERATELY a separate, non-fluctuating field from
 * the visual `radius` (which jitters with strike intensity every frame) —
 * `point-light-pool.js`'s wall-clip cache keys on exact radius equality
 * (unlike V2's own >2px hysteresis band), so feeding it a jittering radius
 * would recompute the wall sweep every single frame. The two can differ
 * safely: `triangulateLightFan` normalizes `shapePoints` by `radius` and the
 * mesh is rescaled by that SAME frame's `radius`, a lossless round-trip
 * regardless of what `shapePoints` were cached at (point-light-
 * illumination.js#normalizeLightPolygon, confirmed by reading it directly).
 *
 * @param {Array<LightningStrand & {linkId?: string}>} activeStrands - live,
 *   non-expired strands (main strikes AND branches — branches are filtered
 *   out internally, matching V2's own `if (!strike.isBranch)` gate).
 * @param {number} nowMs
 * @param {object} params - LIGHTNING_PARAMS' resolved values.
 * @returns {Array<object>} light source descriptors.
 */
export function buildLightningLightSources(activeStrands, nowMs, params) {
  if (!params.originFlashEnabled) return [];
  const outer = hexToRgb01(params.outerColor);
  const core = hexToRgb01(params.coreColor);
  const targets = originFlashAnchorTargets;
  const out = [];

  for (const strand of Array.isArray(activeStrands) ? activeStrands : []) {
    if (strand.isBranch || !strand.linkId) continue;
    const { env, growth, age01 } = computeStrandEnvelope(nowMs, { ...strand, flickerChance: params.flickerChance });
    const strikeIntensity = env * strand.baseIntensity;

    const anchorTargets = targets(strand, params.originFlashAnchor);
    if (!anchorTargets.length) continue;

    const visualMul = computeOriginFlashVisualMul(strand, strikeIntensity, growth, age01, nowMs, params);
    const radiusStrikeScale = Math.max(0, params.originFlashRadiusStrikeScale);
    const radiusMul = 0.5 + Math.min(1.75, strikeIntensity * radiusStrikeScale);
    const radius = Math.max(16, params.originFlashRadiusPx * radiusMul);
    const wallClipRadiusPx = Math.max(
      32,
      params.originFlashRadiusPx * Math.max(0.1, params.originFlashWallClipRadiusScale)
    );
    const color = computeOriginFlashBaseColor(outer, core, Math.min(1.25, visualMul), params.originFlashHotMix);

    for (let i = 0; i < anchorTargets.length; i++) {
      const target = anchorTargets[i];
      const slotVisual = visualMul * Math.max(0.05, target.scale || 1);
      const slotRadius = radius * Math.max(0.35, Math.sqrt(target.scale || 1));
      out.push({
        sourceId: `lightning:${strand.linkId}:${target.role}`,
        x: target.x,
        y: target.y,
        radius: slotRadius,
        wallClipRadiusPx,
        // DARKNESS PUNCH (2026-08, honest simplification): V2 read a bespoke
        // `LightingDirector.masterDarkness` to counteract scene darkness
        // directly. The shared point-light pool already composites every
        // light darkness-aware (region-adjusted ambient, per-light exposure),
        // so instead of re-deriving a live darkness sample here, the
        // originFlashDarknessCancel/NightBoost knobs scale luminosity/alpha
        // the same way candle's own cluster-strength tuning does — punches
        // through darkness by being genuinely brighter, not by cancelling a
        // separately-sampled darkness value. Tune empirically once rendering.
        // A naive circle by default — point-light-pool.js's wall-clip cache
        // OVERWRITES this with a wall-swept polygon when one is available,
        // and otherwise leaves it alone (candle's own resilience pattern:
        // never a light that silently vanishes for lack of a wall sweep).
        shapePoints: lightningCirclePolygon(target.x, target.y, slotRadius),
        // V2's own bright-core/outer-falloff split (`innerRadiusPx`, a
        // bespoke LightMesh concept) maps directly onto Foundry-parity
        // `ratio` (bright-radius / total-radius) — the same knob candle's
        // own CANDLE_LIGHT_RATIO constant is, just live instead of fixed.
        ratio: Math.max(0.05, params.originFlashInnerRadiusScale),
        attenuation01: Math.max(0.05, params.originFlashAttenuation),
        luminosity01: clamp01(0.5 + (slotVisual * Math.max(0, params.originFlashDarknessCancel) * 0.05) / 2),
        hasColor: true,
        alpha01: clamp01(
          slotVisual *
            Math.max(0, params.originFlashDarknessCancel) *
            Math.max(1, params.originFlashDarknessNightBoost) *
            0.35
        ),
        color,
        falloffModel: 'inverseSquare',
        animation: { type: 'none', speedRaw: 0, intensityRaw: 0, reverse: false, seed: strand.seed, quality: 0 },
      });
    }
  }
  return out;
}

// ============================================================================
// THE BATCHED VERTEX-ARRAY BAKE — every active strand's ribbon geometry
// (position/prevPos/nextPos/side/uvOffset, V2's own ribbon-mesh attributes)
// plus the per-strand baked attributes the TSL shader reads to reconstruct
// {@link computeStrandEnvelope} on the GPU, packed into ONE fixed-capacity
// buffer set — the "one draw call, not N" outcome (candle-flame.js's own
// convention), reached here across a POOL of independently-timed strands
// rather than candle's population of always-visible billboards.
// ============================================================================

/**
 * @param {Array<LightningStrand>} activeStrands - main strikes AND branches, whatever is currently live.
 * @param {number} maxStrands @param {number} maxPointsPerStrand
 * @returns {{
 *   positions: Float32Array, prevPos: Float32Array, nextPos: Float32Array, side: Float32Array, uvOffset: Float32Array,
 *   spawnMs: Float32Array, durationMs: Float32Array, seed: Float32Array, leaderFrac: Float32Array,
 *   restrikeCount: Float32Array, baseIntensity: Float32Array, elevationRank: Float32Array, widthScale: Float32Array, isBranch: Float32Array,
 *   parentSpawnMs: Float32Array, parentDurationMs: Float32Array, parentLeaderFrac: Float32Array, growthSpeed: Float32Array,
 *   indices: Uint32Array, strandPointCounts: number[], vertexCount: number, indexCount: number,
 * }}
 */
export function computeLightningStrandArrays(activeStrands, maxStrands, maxPointsPerStrand) {
  const strands = (Array.isArray(activeStrands) ? activeStrands : []).slice(0, maxStrands);
  const vertCapacity = maxStrands * maxPointsPerStrand * 2;
  const positions = new Float32Array(vertCapacity * 3);
  const prevPos = new Float32Array(vertCapacity * 3);
  const nextPos = new Float32Array(vertCapacity * 3);
  const side = new Float32Array(vertCapacity);
  const uvOffset = new Float32Array(vertCapacity);
  // Per-vertex copies of the strand's own baked attributes — simplest correct
  // approach for a first version (matches candle's own "bake per-vertex, not
  // per-instance" discipline exactly, since THREE has no native per-primitive
  // uniform block for a single draw call spanning many strand lengths).
  const spawnMs = new Float32Array(vertCapacity);
  const durationMs = new Float32Array(vertCapacity);
  const seed = new Float32Array(vertCapacity);
  const leaderFrac = new Float32Array(vertCapacity);
  const restrikeCount = new Float32Array(vertCapacity);
  const baseIntensity = new Float32Array(vertCapacity);
  // THE STRIKE'S OWN HEIGHT-GATE INPUT — see `generateBurst`'s own doc. Packed
  // alongside baseIntensity/widthScale into `strandBakeB` in lightning-
  // render.js (widened vec3→vec4) rather than opened as a 7th separate
  // vertex buffer — that file's own header explains why (WebGPU's 8-buffer
  // ceiling, hit live once already).
  const elevationRank = new Float32Array(vertCapacity);
  const widthScale = new Float32Array(vertCapacity);
  const isBranch = new Float32Array(vertCapacity);
  const parentSpawnMs = new Float32Array(vertCapacity);
  const parentDurationMs = new Float32Array(vertCapacity);
  const parentLeaderFrac = new Float32Array(vertCapacity);
  const growthSpeed = new Float32Array(vertCapacity);

  const maxIndices = maxStrands * (maxPointsPerStrand - 1) * 6;
  const indices = new Uint32Array(maxIndices);

  let vBase = 0;
  let iBase = 0;
  const strandPointCounts = [];

  for (const strand of strands) {
    const pts = Math.min(strand.xs.length, maxPointsPerStrand);
    strandPointCounts.push(pts);
    const hasParent = strand.parentSpawnMs != null;

    for (let i = 0; i < pts; i++) {
      const t = pts <= 1 ? 0 : i / (pts - 1);
      const v0 = vBase + i * 2;
      const v1 = v0 + 1;
      const x = strand.xs[i];
      const y = strand.ys[i];

      positions[v0 * 3 + 0] = x;
      positions[v0 * 3 + 1] = y;
      positions[v0 * 3 + 2] = 0;
      positions[v1 * 3 + 0] = x;
      positions[v1 * 3 + 1] = y;
      positions[v1 * 3 + 2] = 0;

      side[v0] = -1;
      side[v1] = 1;
      uvOffset[v0] = t;
      uvOffset[v1] = t;

      for (const v of [v0, v1]) {
        spawnMs[v] = strand.spawnMs;
        durationMs[v] = strand.durationMs;
        seed[v] = strand.seed;
        leaderFrac[v] = strand.leaderFrac;
        restrikeCount[v] = strand.restrikeCount;
        baseIntensity[v] = strand.baseIntensity;
        // Defensive default, same posture as computeCandleFlameArrays' own
        // rank fallback — a strand from an older/hand-built fixture without
        // this field gets the OLD "always fully reaches" behaviour.
        elevationRank[v] = Number.isFinite(strand.elevationRank)
          ? strand.elevationRank
          : LIGHT_ELEVATION_UNCONFIGURED_SENTINEL;
        widthScale[v] = strand.widthScale;
        isBranch[v] = strand.isBranch ? 1 : 0;
        parentSpawnMs[v] = hasParent ? strand.parentSpawnMs : 0;
        parentDurationMs[v] = hasParent ? strand.parentDurationMs : 0;
        parentLeaderFrac[v] = hasParent ? strand.parentLeaderFrac : 0;
        growthSpeed[v] = strand.growthSpeed;
      }
    }

    // prevPos/nextPos — same "clamp at the ends" neighbour lookup V2 uses.
    for (let i = 0; i < pts; i++) {
      const iPrev = Math.max(0, i - 1);
      const iNext = Math.min(pts - 1, i + 1);
      const prevX = strand.xs[iPrev];
      const prevY = strand.ys[iPrev];
      const nextX = strand.xs[iNext];
      const nextY = strand.ys[iNext];
      const vCurr = vBase + i * 2;
      for (let k = 0; k < 2; k++) {
        const v = vCurr + k;
        prevPos[v * 3 + 0] = prevX;
        prevPos[v * 3 + 1] = prevY;
        nextPos[v * 3 + 0] = nextX;
        nextPos[v * 3 + 1] = nextY;
      }
    }

    for (let i = 0; i < pts - 1; i++) {
      const a0 = vBase + i * 2;
      const a1 = a0 + 1;
      const b0 = vBase + (i + 1) * 2;
      const b1 = b0 + 1;
      indices[iBase++] = a0;
      indices[iBase++] = a1;
      indices[iBase++] = b0;
      indices[iBase++] = a1;
      indices[iBase++] = b1;
      indices[iBase++] = b0;
    }

    vBase += pts * 2;
  }

  return {
    positions,
    prevPos,
    nextPos,
    side,
    uvOffset,
    spawnMs,
    durationMs,
    seed,
    leaderFrac,
    restrikeCount,
    baseIntensity,
    elevationRank,
    widthScale,
    isBranch,
    parentSpawnMs,
    parentDurationMs,
    parentLeaderFrac,
    growthSpeed,
    indices,
    strandPointCounts,
    vertexCount: vBase,
    indexCount: iBase,
  };
}
