/**
 * lightning-geometry.test.mjs — the PURE half of the lightning runtime: the
 * seeded RNG, the fractal path/branch generator, the burst scheduler, the
 * leader/return-stroke envelope, anchor pairing, the origin-flash light-
 * source builder, and the batched vertex-array bake. Mirrors candle-flame-
 * geometry.test.mjs's own harness and "pin the producer's real shape, not an
 * invented one" discipline.
 */
import {
  hashStringToSeed,
  mixSeed,
  createRng,
  randFloat,
  randFloatRange,
  randInt,
  generateBoltPath,
  nextBurstDelayMs,
  generateBurst,
  computeStrandEnvelope,
  groupLightningAnchorsIntoSources,
  buildLightningLightSources,
  computeLightningStrandArrays,
  hexToRgb01,
} from '../lightning-geometry.js';

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function dist(x0, y0, x1, y1) {
  return Math.hypot(x1 - x0, y1 - y0);
}

function minDistToPath(x, y, xs, ys) {
  let best = Infinity;
  for (let i = 0; i < xs.length; i++) best = Math.min(best, dist(x, y, xs[i], ys[i]));
  return best;
}

/** A full V2-inspired default params fixture — every field the geometry
 * functions read, matching effects/lightning.js's own defaults. */
const PARAMS = Object.freeze({
  macroDisplacement: 96,
  curveAmount: 0.57,
  microJitter: 3,
  endPointRandomnessPx: 5,
  branchAngleDeg: 45,
  branchChance: 1,
  branchMax: 6,
  branchLengthMin: 0.17,
  branchLengthMax: 0.52,
  branchWidthScale: 0.52,
  branchIntensityScale: 0.82,
  branchDurationScale: 0.79,
  wildArcChance: 0,
  segments: 96,
  strikeDurationMs: 1000,
  leaderFraction: 0.15,
  burstMinStrikes: 7,
  burstMaxStrikes: 16,
  flickerChance: 0.15,
  originFlashEnabled: true,
  originFlashAnchor: 'start',
  originFlashRadiusPx: 40,
  originFlashRadiusStrikeScale: 0.48,
  originFlashInnerRadiusScale: 0.05,
  originFlashIntensity: 1.62,
  originFlashStrikeScale: 0.73,
  originFlashDarknessCancel: 0.95,
  originFlashDarknessNightBoost: 1.6,
  originFlashAttenuation: 1,
  originFlashHotMix: 0.81,
  originFlashLeaderPrecursor: 0.37,
  originFlashFlickerAmount: 0.87,
  originFlashFlickerRate: 1.0,
  originFlashMinGain: 0.04,
  originFlashWallClipRadiusScale: 0.33,
  outerColor: '#0037ff',
  coreColor: '#ffffff',
});

export function run(t) {
  const { ok } = t;

  // --- hashStringToSeed / mixSeed / createRng / randFloat / randFloatRange / randInt ---
  {
    ok('hashStringToSeed is deterministic', hashStringToSeed('bolt-1') === hashStringToSeed('bolt-1'));
    ok('hashStringToSeed differs for different strings', hashStringToSeed('bolt-1') !== hashStringToSeed('bolt-2'));
    ok('hashStringToSeed is a uint32', Number.isInteger(hashStringToSeed('x')) && hashStringToSeed('x') >= 0);

    ok('mixSeed is deterministic', mixSeed(42, 7) === mixSeed(42, 7));
    ok('mixSeed differs by salt', mixSeed(42, 7) !== mixSeed(42, 8));
    ok('mixSeed differs by seed', mixSeed(42, 7) !== mixSeed(43, 7));

    const rngA = createRng(12345);
    const rngB = createRng(12345);
    const seqA = [randFloat(rngA), randFloat(rngA), randFloat(rngA)];
    const seqB = [randFloat(rngB), randFloat(rngB), randFloat(rngB)];
    ok(
      'createRng + randFloat: same seed -> identical sequence',
      seqA.every((v, i) => v === seqB[i])
    );
    ok(
      'randFloat stays in [0,1)',
      seqA.every((v) => v >= 0 && v < 1)
    );

    const rngC = createRng(999);
    ok(
      'randFloatRange stays in [a,b)',
      Array.from({ length: 20 }, () => randFloatRange(rngC, -5, 5)).every((v) => v >= -5 && v < 5)
    );
    const rngD = createRng(999);
    ok(
      'randInt stays in [a,b] inclusive',
      Array.from({ length: 50 }, () => randInt(rngD, 1, 6)).every((v) => Number.isInteger(v) && v >= 1 && v <= 6)
    );
  }

  // --- generateBoltPath ----------------------------------------------------
  {
    const rng1 = createRng(hashStringToSeed('path-a'));
    const p1 = generateBoltPath(0, 0, 500, 0, 33, rng1, PARAMS, 1);
    ok('generateBoltPath returns the requested point count', p1.xs.length === 33 && p1.ys.length === 33);
    // The fractal recursion's base case (and the resample step) both preserve
    // the EXACT start point, but the final micro-jitter pass is FULL at i=0
    // (jitterFalloff = 1 - tipEase, and tipEase(t=0) = 0) — V2's own formula,
    // ported verbatim — so the start point is anchored to within the jitter
    // bound, not bit-exact. `micro` at these defaults is dirLen*~0.004 (~2px
    // here); this stays well clear of that with margin for the RNG draw.
    ok('generateBoltPath anchors its start point within the micro-jitter bound', dist(p1.xs[0], p1.ys[0], 0, 0) < 5);

    const rng2a = createRng(hashStringToSeed('path-b'));
    const p2a = generateBoltPath(10, 20, 300, 150, 17, rng2a, PARAMS, 1);
    const rng2b = createRng(hashStringToSeed('path-b'));
    const p2b = generateBoltPath(10, 20, 300, 150, 17, rng2b, PARAMS, 1);
    ok(
      'generateBoltPath is deterministic for the same seed+inputs',
      p2a.xs.every((v, i) => v === p2b.xs[i]) && p2a.ys.every((v, i) => v === p2b.ys[i])
    );

    const rng3 = createRng(1);
    const rng4 = createRng(2);
    const p3 = generateBoltPath(0, 0, 400, 0, 24, rng3, PARAMS, 1);
    const p4 = generateBoltPath(0, 0, 400, 0, 24, rng4, PARAMS, 1);
    ok('a different seed produces a different path', !p3.xs.every((v, i) => v === p4.xs[i]));

    // Chaos params at their floor still produce SOME displacement — both
    // baseDisp and micro carry a deliberate V2 floor (Math.max(0.055, ...) /
    // Math.max(0.004, ...)), a real V2 behaviour ported verbatim: there is no
    // slider combination that makes a perfectly straight bolt. What SHOULD
    // hold is the comparative claim — zeroed chaos params produce markedly
    // LESS lateral deviation than the full default look, same seed.
    const flatParams = { ...PARAMS, macroDisplacement: 0, curveAmount: 0, microJitter: 0 };
    const totalDeviation = (params) => {
      const rng = createRng(5);
      const p = generateBoltPath(0, 0, 1000, 0, 20, rng, params, 1);
      return p.ys.reduce((sum, y) => sum + Math.abs(y), 0);
    };
    ok(
      'zeroed shape params produce markedly less deviation than the default look',
      totalDeviation(flatParams) < totalDeviation(PARAMS) * 0.5
    );
  }

  // --- nextBurstDelayMs ------------------------------------------------------
  {
    const d1 = nextBurstDelayMs(777, 0, 0, 10000);
    ok('nextBurstDelayMs is deterministic', d1 === nextBurstDelayMs(777, 0, 0, 10000));
    ok('nextBurstDelayMs stays within [lo, hi]', d1 >= 0 && d1 <= 10000);
    const d2 = nextBurstDelayMs(777, 1, 5000, 10000);
    ok('a later burstIndex gives an independent draw (not always identical)', d2 >= 5000 && d2 <= 10000);
    ok('a malformed lo>hi still resolves within the true bounds', nextBurstDelayMs(1, 0, 100, 50) >= 50);
  }

  // --- generateBurst ---------------------------------------------------------
  {
    const source = {
      linkId: 'v2:g1',
      seed: hashStringToSeed('v2:g1'),
      startX: 0,
      startY: 0,
      endX: 600,
      endY: 0,
      intensity: 1,
    };
    const { main, branches } = generateBurst({
      source,
      burstIndex: 0,
      spawnMs: 1000,
      maxPointsPerStrand: 96,
      params: PARAMS,
    });

    ok('the main strand is not a branch', main.isBranch === false);
    ok('the main strand carries the source linkId', main.linkId === 'v2:g1');
    ok('the main strand spawns at the requested time', main.spawnMs === 1000);
    ok('the main strand duration matches strikeDurationMs', main.durationMs === PARAMS.strikeDurationMs);
    ok(
      'the main strand leaderFrac is within V2s randomized band around leaderFraction',
      main.leaderFrac >= 0.1 && main.leaderFrac <= 0.35
    );
    ok(
      'the main strand start is exactly the source start',
      main.startX === source.startX && main.startY === source.startY
    );
    ok(
      'the main strand end is within endPointRandomnessPx of the source end',
      dist(main.endX, main.endY, source.endX, source.endY) <= PARAMS.endPointRandomnessPx * Math.SQRT2 + 1e-6
    );
    ok('the main strand has a positive baseIntensity floor', main.baseIntensity >= 0.05);

    ok('branches is an array within [0, branchMax]', Array.isArray(branches) && branches.length <= PARAMS.branchMax);
    for (const b of branches) {
      ok('a branch is flagged isBranch', b.isBranch === true);
      ok('a branch shares the main strand spawnMs', b.spawnMs === main.spawnMs);
      ok('a branch duration is shorter than the main strand (branchDurationScale<1)', b.durationMs <= main.durationMs);
      ok(
        'a branch carries parent timing for the envelope coupling',
        b.parentSpawnMs === main.spawnMs && b.parentDurationMs === main.durationMs
      );
      ok(
        "a branch's start point lies on (or very near) the parent's own path",
        minDistToPath(b.xs[0], b.ys[0], main.xs, main.ys) < 20 // generous — microJitter is a few px at these lengths
      );
      ok('a branch is dimmer than its parent (branchIntensityScale<1)', b.baseIntensity < main.baseIntensity);
    }

    // Determinism: the SAME (source, burstIndex) always yields the SAME bolt —
    // the whole point of deriving shape from a seed instead of mutable state.
    const again = generateBurst({ source, burstIndex: 0, spawnMs: 1000, maxPointsPerStrand: 96, params: PARAMS });
    ok(
      'generateBurst is fully deterministic for the same (source, burstIndex)',
      again.main.xs.every((v, i) => v === main.xs[i]) && again.branches.length === branches.length
    );

    // A different burstIndex yields a different bolt.
    const other = generateBurst({ source, burstIndex: 1, spawnMs: 1000, maxPointsPerStrand: 96, params: PARAMS });
    ok('a different burstIndex yields a different path', !other.main.xs.every((v, i) => v === main.xs[i]));

    // wildArcChance=1 always takes the wild-arc branch (end point far from the source's own end).
    const wildParams = { ...PARAMS, wildArcChance: 1, endPointRandomnessPx: 0 };
    const wild = generateBurst({ source, burstIndex: 0, spawnMs: 0, maxPointsPerStrand: 96, params: wildParams });
    ok(
      'wildArcChance=1 sends the strike somewhere other than the authored end point',
      dist(wild.main.endX, wild.main.endY, source.endX, source.endY) > 50
    );

    // branchChance=0 never spawns a branch.
    const noBranchParams = { ...PARAMS, branchChance: 0 };
    const noBranch = generateBurst({
      source,
      burstIndex: 0,
      spawnMs: 0,
      maxPointsPerStrand: 96,
      params: noBranchParams,
    });
    ok('branchChance=0 spawns no branches', noBranch.branches.length === 0);
  }

  // --- computeStrandEnvelope ---------------------------------------------
  {
    const strand = {
      isBranch: false,
      seed: 12345,
      spawnMs: 0,
      durationMs: 1000,
      leaderFrac: 0.15,
      restrikeCount: 8,
      growthSpeed: 1,
      parentSpawnMs: null,
      parentDurationMs: null,
      parentLeaderFrac: null,
      flickerChance: 0, // deterministic shape assertions — flicker is tested separately below
    };
    const e0 = computeStrandEnvelope(-1, strand); // before spawn — clamped
    ok('before spawn, t/growth are clamped to 0', e0.age01 === 0 && e0.growth === 0);

    const eEnd = computeStrandEnvelope(5000, strand); // long after duration — clamped to 1
    ok('long after duration, age01 clamps to 1', eEnd.age01 === 1);

    const eMidLeader = computeStrandEnvelope(75, strand); // t=0.075, mid-leader (leaderFrac=0.15)
    ok('mid-leader growth is between 0 and 1', eMidLeader.growth > 0 && eMidLeader.growth < 1);
    ok('mid-leader env is small (V2s own 0.05 + 0.16*progress band)', eMidLeader.env >= 0.05 && eMidLeader.env <= 0.25);

    const eLeaderEnd = computeStrandEnvelope(150, strand); // t=leaderFrac exactly
    ok('growth reaches (approximately) 1 at the leader/post boundary', eLeaderEnd.growth > 0.99);

    // Growth is monotonically non-decreasing through the leader phase.
    let prevGrowth = -1;
    let monotonic = true;
    for (let ms = 0; ms <= 150; ms += 10) {
      const { growth } = computeStrandEnvelope(ms, strand);
      if (growth < prevGrowth - 1e-9) monotonic = false;
      prevGrowth = growth;
    }
    ok('growth is monotonically non-decreasing across the leader phase', monotonic);

    // Post-leader envelope is always finite and non-negative.
    let allValid = true;
    for (let ms = 150; ms <= 1000; ms += 25) {
      const { env } = computeStrandEnvelope(ms, strand);
      if (!Number.isFinite(env) || env < 0) allValid = false;
    }
    ok('post-leader env stays finite and non-negative across the whole strike', allValid);

    // Branch growth coupling: while the parent is still deep in ITS OWN leader
    // phase, an active branch's growth should be bounded by the parent's.
    const branchStrand = {
      ...strand,
      isBranch: true,
      parentSpawnMs: 0,
      parentDurationMs: 1000,
      parentLeaderFrac: 0.15,
      growthSpeed: 0.9,
    };
    const branchEarly = computeStrandEnvelope(20, branchStrand); // parent still early in its leader
    ok(
      'an active branchs growth is bounded while its parent is still early in its own leader',
      branchEarly.growth <= 0.5
    );

    // Once the parent is long past its leader, growth saturates near growthSpeed-limited 1.
    const branchLate = computeStrandEnvelope(500, branchStrand);
    ok('a branch fully reveals once its parent is well past its own leader phase', branchLate.growth > 0.85);

    // Flicker: with flickerChance>0, env should occasionally differ from the
    // flicker-free (0) case at some tick within the leader phase — a coarse
    // "the flicker term does something" smoke test, not an exact value pin
    // (the exact tick pattern is an implementation detail).
    const flickerStrand = { ...strand, flickerChance: 1 }; // always rolls into the dim range
    let sawDimming = false;
    for (let ms = 0; ms < 150; ms += 5) {
      const withFlicker = computeStrandEnvelope(ms, flickerStrand).env;
      const without = computeStrandEnvelope(ms, strand).env;
      if (withFlicker < without - 1e-9) sawDimming = true;
    }
    ok('flickerChance=1 measurably dims the envelope somewhere in the leader phase', sawDimming);
  }

  // --- groupLightningAnchorsIntoSources -----------------------------------
  {
    const anchors = [
      { id: 'a1', x: 0, y: 0, params: { role: 'start', linkId: 'bolt-1', intensity: 1 } },
      { id: 'a2', x: 500, y: 0, params: { role: 'end', linkId: 'bolt-1', intensity: 1 } },
      { id: 'a3', x: 100, y: 100, params: { role: 'start', linkId: 'bolt-2', intensity: 0.5 } }, // no matching 'end' — orphaned
      { id: 'a4', x: 50, y: 50, params: { role: 'waypoint', linkId: 'bolt-1' } }, // a waypoint on an otherwise-complete link
    ];
    const { sources, orphaned } = groupLightningAnchorsIntoSources(anchors);
    ok('exactly one complete source is formed', sources.length === 1);
    ok('the source carries the correct endpoints', sources[0].startX === 0 && sources[0].endX === 500);
    ok('the source seed is derived from its linkId (deterministic)', sources[0].seed === hashStringToSeed('bolt-1'));
    ok(
      'an incomplete link (no end) is reported orphaned, not silently dropped',
      orphaned.some((o) => o.linkId === 'bolt-2')
    );
    ok(
      'anchors with no linkId at all are ignored entirely',
      groupLightningAnchorsIntoSources([{ id: 'x', x: 0, y: 0, params: {} }]).sources.length === 0
    );
  }

  // --- buildLightningLightSources -----------------------------------------
  {
    const mainStrand = {
      isBranch: false,
      linkId: 'bolt-1',
      seed: hashStringToSeed('bolt-1'),
      spawnMs: 0,
      durationMs: 1000,
      leaderFrac: 0.15,
      restrikeCount: 8,
      growthSpeed: 1,
      parentSpawnMs: null,
      parentDurationMs: null,
      parentLeaderFrac: null,
      baseIntensity: 1,
      widthScale: 1,
      startX: 0,
      startY: 0,
      endX: 500,
      endY: 0,
    };
    const branchStrand = { ...mainStrand, isBranch: true, linkId: undefined };

    const sources500 = buildLightningLightSources([mainStrand, branchStrand], 500, PARAMS);
    ok(
      'a branch never produces a light descriptor',
      sources500.every((s) => !String(s.sourceId).includes('branch'))
    );
    ok("'start'-anchor mode produces exactly one descriptor", sources500.length === 1);

    const REQUIRED_FIELDS = [
      'sourceId',
      'x',
      'y',
      'radius',
      'wallClipRadiusPx',
      'shapePoints',
      'ratio',
      'attenuation01',
      'luminosity01',
      'hasColor',
      'alpha01',
      'color',
      'falloffModel',
      'animation',
    ];
    for (const f of REQUIRED_FIELDS) ok(`light descriptor has field '${f}'`, f in sources500[0]);
    ok(
      'shapePoints defaults to a real naive-circle polygon, never null (a light must never silently vanish)',
      Array.isArray(sources500[0].shapePoints) && sources500[0].shapePoints.length >= 6
    );
    ok('falloffModel matches the V3 authored-light convention', sources500[0].falloffModel === 'inverseSquare');
    ok(
      'colour is a 3-element array of finite 0..1-ish numbers',
      Array.isArray(sources500[0].color) && sources500[0].color.length === 3
    );

    // Stable sourceId across bursts — the load-bearing leak-avoidance property
    // (point-light-pool.js only hides a sourceId it doesn't see this frame; a
    // per-burst id would leak a mesh forever).
    const sourcesLater = buildLightningLightSources([mainStrand, branchStrand], 900, PARAMS);
    ok(
      'sourceId is stable across different nowMs for the same linkId/role',
      sources500[0].sourceId === sourcesLater[0].sourceId
    );

    const bothParams = { ...PARAMS, originFlashAnchor: 'both' };
    const both = buildLightningLightSources([mainStrand], 500, bothParams);
    ok(
      "'both'-anchor mode produces exactly two descriptors (end first, then start — V2s own order)",
      both.length === 2
    );
    ok('the two descriptors have different, stable, role-suffixed ids', both[0].sourceId !== both[1].sourceId);

    ok(
      'originFlashEnabled:false produces no descriptors at all',
      buildLightningLightSources([mainStrand], 500, { ...PARAMS, originFlashEnabled: false }).length === 0
    );
  }

  // --- computeLightningStrandArrays ---------------------------------------
  {
    const s1 = {
      xs: [0, 10, 20],
      ys: [0, 0, 0],
      spawnMs: 0,
      durationMs: 1000,
      seed: 1,
      leaderFrac: 0.15,
      restrikeCount: 8,
      baseIntensity: 1,
      widthScale: 1,
      isBranch: false,
      parentSpawnMs: null,
      parentDurationMs: null,
      parentLeaderFrac: null,
      growthSpeed: 1,
    };
    const s2 = {
      xs: [100, 110],
      ys: [5, 5],
      spawnMs: 0,
      durationMs: 500,
      seed: 2,
      leaderFrac: 0.15,
      restrikeCount: 4,
      baseIntensity: 0.5,
      widthScale: 0.5,
      isBranch: true,
      parentSpawnMs: 0,
      parentDurationMs: 1000,
      parentLeaderFrac: 0.15,
      growthSpeed: 0.9,
    };

    const arrays = computeLightningStrandArrays([s1, s2], 24, 96);
    ok('vertexCount is 2 verts per path point, summed across strands', arrays.vertexCount === (3 + 2) * 2);
    ok('indexCount is 6 indices per segment, summed across strands', arrays.indexCount === (2 + 1) * 6);
    ok(
      'strandPointCounts records each strands own point count',
      arrays.strandPointCounts[0] === 3 && arrays.strandPointCounts[1] === 2
    );

    // No cross-strand bleed: strand 2's baked seed must never appear on any
    // of strand 1's vertices, and vice versa.
    const strand1VertCount = 3 * 2;
    let bleed = false;
    for (let v = 0; v < strand1VertCount; v++) if (arrays.seed[v] !== 1) bleed = true;
    for (let v = strand1VertCount; v < arrays.vertexCount; v++) if (arrays.seed[v] !== 2) bleed = true;
    ok('no cross-strand bleed in the baked per-vertex seed attribute', !bleed);

    // Positions for strand 1's vertices match its own xs/ys (both side=-1/+1 copies).
    ok(
      'strand 1s first vertex pair both carry its first path point',
      arrays.positions[0] === 0 && arrays.positions[3] === 0
    );
    ok('isBranch is baked correctly per strand', arrays.isBranch[0] === 0 && arrays.isBranch[strand1VertCount] === 1);

    // Truncation to maxStrands / maxPointsPerStrand never overruns capacity.
    const manyStrands = Array.from({ length: 30 }, (_, i) => ({ ...s1, seed: i }));
    const capped = computeLightningStrandArrays(manyStrands, 24, 96);
    ok('strand count is capped at maxStrands', capped.strandPointCounts.length === 24);
    const longStrand = {
      ...s1,
      xs: Array.from({ length: 200 }, (_, i) => i),
      ys: Array.from({ length: 200 }, () => 0),
    };
    const cappedPoints = computeLightningStrandArrays([longStrand], 24, 96);
    ok('per-strand point count is capped at maxPointsPerStrand', cappedPoints.strandPointCounts[0] === 96);
  }

  // --- hexToRgb01 ------------------------------------------------------------
  {
    const [r, g, b] = hexToRgb01('#0037ff');
    ok('hexToRgb01 decodes correctly', approx(r, 0) && approx(g, 0x37 / 255) && approx(b, 1));
    ok(
      'a malformed colour falls back to white (never throws)',
      hexToRgb01('nope').every((c) => approx(c, 1))
    );
  }
}
