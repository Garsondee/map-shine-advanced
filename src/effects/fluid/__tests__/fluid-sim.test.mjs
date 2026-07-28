/**
 * Node verification for effects/fluid/fluid-sim.js — THE SIM's CPU TWIN.
 *
 * This suite exists BEFORE any TSL code, per `feedback_smooth_output_hides_
 * ported_bugs`'s explicit instruction for exactly this kind of rung: write
 * the twin, verify it against the actual physical claim being made, THEN
 * transcribe it to the shader. The one claim that matters most —
 * `v = Q/A`, "the goo speeds up through a constriction" — gets a real
 * numerical test (§ "SPEEDS UP THROUGH A NECK"), not just a spot check.
 */
import {
  advectTubeStep,
  buildFluidProfileBuffer,
  writeFluidTubeConstantsBuffer,
  computeFluidLengthQScale,
  FLUID_SIM_MIN_CROSS_SECTION_PX,
  FLUID_TARGET_TRAVERSAL_SECONDS,
} from '../fluid-sim.js';
import { fluidPumpForTube, fluidPumpPersonality, FLUID_PUMP_BASE_Q } from '../fluid-pump.js';

/** A uniform profile of the given cross-section, `n` bins. */
function uniformProfile(n, crossSectionPx) {
  return new Float64Array(n).fill(crossSectionPx);
}

/** Run many ticks, returning the FINAL state. */
function runTicks({ phi, crossSectionProfile, lengthPx, Q, inject, dtSec, ticks }) {
  let state = phi;
  for (let k = 0; k < ticks; k++) {
    state = advectTubeStep({ prevPhi: state, crossSectionProfile, lengthPx, Q, inject, dtSec });
  }
  return state;
}

export function run(t) {
  const { ok } = t;

  // ── Degenerate inputs never crash or produce NaN ────────────────────────
  {
    const zeroLen = advectTubeStep({
      prevPhi: new Float64Array(8),
      crossSectionProfile: uniformProfile(8, 10),
      lengthPx: 0,
      Q: 500,
      inject: 1,
      dtSec: 0.016,
    });
    ok(
      'zero-length tube: holds its input, no NaN',
      zeroLen.every((v) => Number.isFinite(v))
    );

    const empty = advectTubeStep({
      prevPhi: new Float64Array(0),
      crossSectionProfile: new Float64Array(0),
      lengthPx: 100,
      Q: 500,
      inject: 1,
      dtSec: 0.016,
    });
    ok('zero-length ARRAY tube: returns an empty array, not a crash', empty.length === 0);
  }

  // ── Unconditional stability — the whole reason for semi-Lagrangian ──────
  {
    const n = 64;
    const phi = new Float64Array(n).fill(0.3);
    const profile = uniformProfile(n, 20);
    const wild = advectTubeStep({
      prevPhi: phi,
      crossSectionProfile: profile,
      lengthPx: 640,
      Q: 1e9,
      inject: 1,
      dtSec: 5,
    });
    ok(
      'an absurd Q (1e9) and a 5-SECOND tick stay bounded and finite, never NaN/Infinity',
      wild.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
    );
    // With Q this large the velocity is enormous and POSITIVE, so every
    // bin's backtrace lands far BEHIND the root (not past the tip) — the
    // whole tube should read as `inject`, instantly, everywhere. This is
    // still the "unconditionally stable" claim: an overshoot this extreme
    // does not oscillate or diverge, it just clamps to the root boundary.
    ok(
      'the whole tube reads back as the pump`s inject value, not the stale 0.3',
      wild.every((v) => v === 1)
    );
  }

  // ── A steady pump fills the whole tube to that steady value ─────────────
  {
    const n = 100;
    const profile = uniformProfile(n, 15);
    const lengthPx = n * 10;
    let phi = new Float64Array(n).fill(0);
    const Q = 1500;
    const v = Q / 15; // world px/s
    const dtSec = 0.05;
    // Enough ticks for the front to cross the WHOLE tube at least twice over,
    // so any transient has long since left.
    const secondsToFill = lengthPx / v;
    const ticks = Math.ceil((secondsToFill * 3) / dtSec);
    phi = runTicks({ phi, crossSectionProfile: profile, lengthPx, Q, inject: 1, dtSec, ticks });
    let minV = Infinity;
    let maxV = -Infinity;
    for (const x of phi) {
      if (x < minV) minV = x;
      if (x > maxV) maxV = x;
    }
    ok(`a steady inject=1 fills the WHOLE tube to ~1 (min ${minV.toFixed(3)}, max ${maxV.toFixed(3)})`, minV > 0.95);
    ok('nothing overshoots past 1', maxV <= 1.0001);
  }

  // ── A pulse actually TRAVELS at the predicted speed ──────────────────────
  {
    const n = 200;
    const crossSection = 20;
    const profile = uniformProfile(n, crossSection);
    const binPx = 10;
    const lengthPx = n * binPx;
    const Q = 2000;
    const expectedV = Q / crossSection; // world px/s
    const expectedBinsPerSec = expectedV / binPx;
    const dtSec = 0.02;

    // Inject a brief pulse, then let it run with inject=0 (a gap behind it),
    // and track where its centroid sits over time.
    let phi = new Float64Array(n).fill(0);
    const pulseTicks = Math.round(0.15 / dtSec); // ~150ms of "full"
    for (let k = 0; k < pulseTicks; k++) {
      phi = advectTubeStep({ prevPhi: phi, crossSectionProfile: profile, lengthPx, Q, inject: 1, dtSec });
    }
    const startCentroid = centroid(phi);

    const travelTicks = Math.round(2 / dtSec); // 2 more seconds
    for (let k = 0; k < travelTicks; k++) {
      phi = advectTubeStep({ prevPhi: phi, crossSectionProfile: profile, lengthPx, Q, inject: 0, dtSec });
    }
    const endCentroid = centroid(phi);
    const measuredBins = endCentroid - startCentroid;
    const expectedBins = expectedBinsPerSec * (travelTicks * dtSec);

    ok(
      `pulse travelled ${measuredBins.toFixed(1)} bins against a predicted ${expectedBins.toFixed(1)} (within 15%)`,
      Math.abs(measuredBins - expectedBins) < expectedBins * 0.15
    );
  }

  // ── THE HEADLINE CLAIM: v = Q/A, so the goo speeds up through a neck ────
  {
    const n = 200;
    const binPx = 10;
    const lengthPx = n * binPx;
    const narrowCrossSection = 8;
    const wideCrossSection = 32;
    // First half narrow, second half wide — the pulse must cross the narrow
    // half FASTER (in world time) than the wide half, by roughly the ratio of
    // their cross-sections (wide/narrow = 4x).
    const profile = new Float64Array(n);
    for (let i = 0; i < n; i++) profile[i] = i < n / 2 ? narrowCrossSection : wideCrossSection;

    const Q = 1600;
    const dtSec = 0.01;

    let phi = new Float64Array(n).fill(0);
    // A short, sharp pulse right at the start.
    for (let k = 0; k < 5; k++) {
      phi = advectTubeStep({ prevPhi: phi, crossSectionProfile: profile, lengthPx, Q, inject: 1, dtSec });
    }

    // Step forward one tick at a time, timestamping the moment the pulse's
    // centroid crosses the midpoint (bin n/2) and the moment it reaches near
    // the tip (bin n-5, just short of the boundary-hold zone).
    let timeSec = 0.05; // the 5 injection ticks already elapsed
    let crossedMidAt = null;
    let reachedTipAt = null;
    const maxSeconds = 30;
    while (timeSec < maxSeconds && reachedTipAt === null) {
      phi = advectTubeStep({ prevPhi: phi, crossSectionProfile: profile, lengthPx, Q, inject: 0, dtSec });
      timeSec += dtSec;
      const c = centroid(phi);
      if (crossedMidAt === null && c >= n / 2) crossedMidAt = timeSec;
      if (reachedTipAt === null && c >= n - 5) reachedTipAt = timeSec;
    }

    ok('the pulse crossed the midpoint within the test window', crossedMidAt !== null);
    ok('the pulse reached the tip within the test window', reachedTipAt !== null);

    if (crossedMidAt !== null && reachedTipAt !== null) {
      const narrowLegSec = crossedMidAt - 0.05;
      const wideLegSec = reachedTipAt - crossedMidAt;
      const ratio = wideLegSec / narrowLegSec;
      // Predicted ratio is wideCrossSection/narrowCrossSection = 4 (since
      // v = Q/A, time to cross a FIXED distance is proportional to A).
      // Generous tolerance (2.5..6x): numerical diffusion from linear
      // interpolation smears the peak over many ticks, and the centroid
      // crosses each fixed marker at a slightly different moment than an
      // idealised infinitely-sharp pulse would. The claim being tested is
      // "meaningfully and correctly slower in the wide half", not agreement
      // to the percent.
      ok(
        `narrow leg took ${narrowLegSec.toFixed(2)}s, wide leg ${wideLegSec.toFixed(2)}s — ratio ${ratio.toFixed(2)} ` +
          `(predicted ~4x from crossSection ratio ${wideCrossSection / narrowCrossSection})`,
        ratio > 2.5 && ratio < 6
      );
    }
  }

  // ── The root is pump-driven, the tip holds — the two boundary conditions ─
  {
    const n = 20;
    const profile = uniformProfile(n, 10);
    const lengthPx = n * 10;
    // With Q=0 there is no advection at all: the interior must be
    // UNCHANGED tick to tick (srcBin === i exactly), and only the root
    // reflects the pump's own inject value.
    const phi0 = new Float64Array(n).fill(0.4);
    const next = advectTubeStep({
      prevPhi: phi0,
      crossSectionProfile: profile,
      lengthPx,
      Q: 0,
      inject: 0.9,
      dtSec: 0.1,
    });
    ok('with Q=0, the root instantly reflects inject (the pump, not the old value)', next[0] === 0.9);
    let interiorUnchanged = true;
    for (let i = 1; i < n - 1; i++) if (Math.abs(next[i] - phi0[i]) > 1e-9) interiorUnchanged = false;
    ok('with Q=0, the interior does not move at all', interiorUnchanged);
  }

  // ── Bounds: linear interpolation between in-range values stays in-range ──
  {
    const n = 40;
    const profile = uniformProfile(n, 14);
    const lengthPx = n * 10;
    let phi = new Float64Array(n).fill(0);
    let allBounded = true;
    const combos = [
      { Q: 100, dtSec: 0.033 },
      { Q: 5000, dtSec: 0.016 },
      { Q: 800, dtSec: 0.1 },
    ];
    for (const { Q, dtSec } of combos) {
      for (let k = 0; k < 50; k++) {
        const inject = k % 10 < 5 ? 1 : 0; // an alternating slug/gap train
        phi = advectTubeStep({ prevPhi: phi, crossSectionProfile: profile, lengthPx, Q, inject, dtSec });
        for (const v of phi) if (v < -1e-9 || v > 1 + 1e-9) allBounded = false;
      }
    }
    ok('phi stays within 0..1 across varied Q/dt/inject combinations', allBounded);
  }

  // ── The exported floor constant is really used, not decorative ─────────
  {
    const n = 4;
    const zeroProfile = new Float64Array(n).fill(0); // a pathological all-zero bake
    const result = advectTubeStep({
      prevPhi: new Float64Array(n).fill(0.5),
      crossSectionProfile: zeroProfile,
      lengthPx: 40,
      Q: 1000,
      inject: 1,
      dtSec: 0.016,
    });
    ok(
      'a zero cross-section profile does not divide-by-zero into NaN (the floor engages)',
      result.every((v) => Number.isFinite(v))
    );
    ok(
      'FLUID_SIM_MIN_CROSS_SECTION_PX is small enough to be a floor, not a real value',
      FLUID_SIM_MIN_CROSS_SECTION_PX < 1
    );
  }

  // ── `out` reuse writes in place and returns the SAME array ──────────────
  {
    const n = 8;
    const profile = uniformProfile(n, 10);
    const scratch = new Float64Array(n);
    const result = advectTubeStep({
      prevPhi: new Float64Array(n).fill(0.2),
      crossSectionProfile: profile,
      lengthPx: 80,
      Q: 200,
      inject: 0.7,
      dtSec: 0.02,
      out: scratch,
    });
    ok('passing `out` returns that SAME array (no hidden allocation)', result === scratch);
  }

  // ── buildFluidProfileBuffer: RGBA-strided, row-major, row = tube INDEX ────
  // `fluid-pack.js`'s own header states the invariant this depends on: "B
  // tubeId ... 1..tubeCount (the state texture's row + 1)" — i.e. tube array
  // index k must land in row k, matching `fluid-render.js`'s
  // `stateV = (tubeId - 0.5) / tubeCount`. A transposed or off-by-one buffer
  // would sample a DIFFERENT tube's fill entirely, silently. Stride 4
  // (RGBA), not 1: `createFluidPackTexture` is this codebase's one confirmed
  // float-DataTexture recipe and it is RGBA — a stride-1 buffer uploaded into
  // an RGBA texture would scramble every bin across the wrong channels.
  {
    const samplesPerTube = 6;
    const tubes = [
      { crossSectionProfile: new Float64Array([1, 2, 3, 4, 5, 6]) },
      { crossSectionProfile: new Float64Array([10, 20, 30, 40, 50, 60]) },
      { crossSectionProfile: new Float64Array([100, 200, 300, 400, 500, 600]) },
    ];
    const buf = buildFluidProfileBuffer(tubes, samplesPerTube);
    ok('buffer length is samplesPerTube x tubeCount x 4 (RGBA)', buf.length === samplesPerTube * tubes.length * 4);
    let rowsMatch = true;
    let unusedChannelsAreZero = true;
    for (let row = 0; row < tubes.length; row++) {
      for (let col = 0; col < samplesPerTube; col++) {
        const base = row * samplesPerTube * 4 + col * 4;
        if (buf[base] !== tubes[row].crossSectionProfile[col]) rowsMatch = false;
        if (buf[base + 1] !== 0 || buf[base + 2] !== 0 || buf[base + 3] !== 0) unusedChannelsAreZero = false;
      }
    }
    ok('tube array index k lands in row k, column-for-column (not transposed)', rowsMatch);
    ok('the value rides in R; G/B/A are left at 0, not garbage', unusedChannelsAreZero);
  }

  // ── writeFluidTubeConstantsBuffer: the RGBA upload layout the SHADER reads ─
  // `buildFluidAdvectMaterial`'s own doc names this exact function as the
  // pump texture's writer (RGBA = Q, inject, lengthPx, 1) — this is the ONE
  // pump-buffer writer with a real consumer (the RG-only sibling in
  // `fluid-pump.js` had none and was deleted, `feedback_mode_forks_
  // silently_drop_features`), so it is the one that must be proven correct.
  {
    const tubeCount = 4;
    const tubes = [{ lengthPx: 100 }, { lengthPx: 250 }, { lengthPx: 0 }, { lengthPx: 999.9 }];
    const buf = new Float32Array(tubeCount * 4);
    writeFluidTubeConstantsBuffer(buf, 4000, tubes);
    ok('buffer length matches tubeCount x 4 (RGBA interleaved)', buf.length === 16);

    let matchesPumpPerTube = true;
    for (let row = 0; row < tubeCount; row++) {
      const { Q, inject } = fluidPumpForTube(4000, row);
      // Math.fround: buf is a Float32Array, so comparing through the same
      // truncation the GPU upload itself performs — not a false failure the
      // test would otherwise introduce (matches the reasoning the deleted
      // RG-buffer test used for the identical comparison).
      if (buf[row * 4] !== Math.fround(Q) || buf[row * 4 + 1] !== Math.fround(inject)) matchesPumpPerTube = false;
    }
    ok('Q and inject in each row match calling fluidPumpForTube directly', matchesPumpPerTube);

    ok('row 0`s lengthPx channel carries the tube`s real length (100)', buf[2] === 100);
    ok('row 1`s lengthPx channel carries the tube`s real length (250)', buf[6] === 250);
    ok('row 2`s degenerate lengthPx=0 is floored to 1, not left at 0 (the shader divides by it)', buf[10] === 1);
    ok(
      'the unused 4th channel is a clean 1 in every row, never stray/undefined',
      buf[3] === 1 && buf[7] === 1 && buf[11] === 1 && buf[15] === 1
    );

    // Reused personalities must give the SAME result as recomputing them —
    // reuse exists only to skip redundant hash01 calls, never to change the
    // answer (the same invariant `fluidPumpForTube` itself guarantees).
    const personalities = Array.from({ length: tubeCount }, (_, k) => fluidPumpPersonality(k));
    const buf2 = new Float32Array(tubeCount * 4);
    writeFluidTubeConstantsBuffer(buf2, 4000, tubes, personalities);
    let sameWithReuse = true;
    for (let i = 0; i < buf.length; i++) if (buf[i] !== buf2[i]) sameWithReuse = false;
    ok('passing precomputed personalities changes nothing, only avoids recomputing them', sameWithReuse);

    // qScales must be APPLIED, not merely accepted: row 0 gets a real scale,
    // row 1 none (1×) — only row 0's Q may move.
    const qScales = [2.5, 1];
    const buf3 = new Float32Array(tubeCount * 4);
    writeFluidTubeConstantsBuffer(buf3, 4000, tubes, personalities, qScales);
    const { Q: q0 } = fluidPumpForTube(4000, 0, personalities[0]);
    const { Q: q1 } = fluidPumpForTube(4000, 1, personalities[1]);
    ok('a 2.5x qScale multiplies that row`s Q by 2.5x', Math.abs(buf3[0] - Math.fround(q0 * 2.5)) < 1e-3);
    ok('a 1x qScale leaves that row`s Q unchanged', buf3[4] === Math.fround(q1));
  }

  // ── computeFluidLengthQScale: THE BUG THIS FIXES, measured on the REAL sim ──
  // Found from a live report: the author's actual map has a tube 7,048 px
  // long with a ~294px cross-section (radius 147px, doubled) — an order of
  // magnitude wider and several times longer than `fluid-sim.test.mjs`'s own
  // fixtures (a few hundred px, 8-32px cross-section) ever measured
  // `FLUID_PUMP_BASE_Q` against. At the flat constant alone, THIS test's own
  // numbers put the front at over 1,200 SECONDS to cross that one tube —
  // never actually run here (that would make this suite itself take 20
  // minutes), but computed and asserted as a sanity floor below so the claim
  // is not just narrated.
  //
  // The fix must be proven on the ACTUAL semi-Lagrangian sim, not just
  // algebra: two wildly different tubes (matching the SMALL synthetic
  // fixture already used elsewhere in this file, and the LARGE real map's own
  // numbers) must both reach "visibly full" in close to the SAME real time
  // once `computeFluidLengthQScale` is applied — the same invariance the
  // analytic scroll it replaced had by accident (its `s` was already
  // normalised), now achieved on purpose for a sim whose native units are
  // real world px.
  {
    // Without any length-aware scale, the flat constant alone is
    // over 1,200s for the real map's own tube — measured, not assumed, so a
    // future change to FLUID_PUMP_BASE_Q that reintroduces this bug fails
    // loudly here rather than silently.
    const realTubeLengthPx = 7048;
    const realTubeCrossSection = 294; // 2 x maxRadiusPx from the live report
    const unscaledSeconds = realTubeLengthPx / (FLUID_PUMP_BASE_Q / realTubeCrossSection);
    ok(
      `sanity floor: UNSCALED Q on the real tube's own numbers takes ` +
        `${unscaledSeconds.toFixed(0)}s (over 5 minutes even at FLUID_PUMP_BASE_Q's own nominal ` +
        'value, before the pump`s drive factor — which spends most of its time BELOW 1 — makes it ' +
        'worse still), confirming the bug this rung fixes',
      unscaledSeconds > 300
    );

    /** Run `advectTubeStep` with a CONSTANT Q until phi crosses 0.9 at the
     * tip bin, returning the number of SECONDS that took (or `null` if it
     * never got there inside `maxSeconds` — a sign the scale is still wrong). */
    function measureFillSeconds({ n, crossSectionPx, lengthPx, Q, dtSec = 0.05, maxSeconds = 120 }) {
      const profile = uniformProfile(n, crossSectionPx);
      let phi = new Float64Array(n).fill(0);
      let elapsed = 0;
      while (elapsed < maxSeconds) {
        phi = advectTubeStep({ prevPhi: phi, crossSectionProfile: profile, lengthPx, Q, inject: 1, dtSec });
        elapsed += dtSec;
        if (phi[n - 1] >= 0.9) return elapsed;
      }
      return null;
    }

    const samplesPerTube = 64; // coarse — this test measures TIMING, not profile fidelity
    const smallTube = { lengthPx: 300, crossSectionProfile: uniformProfile(samplesPerTube, 12) };
    const largeTube = {
      lengthPx: realTubeLengthPx,
      crossSectionProfile: uniformProfile(samplesPerTube, realTubeCrossSection),
    };

    const smallScale = computeFluidLengthQScale(smallTube);
    const largeScale = computeFluidLengthQScale(largeTube);
    ok('a wider/longer tube gets a LARGER qScale, not a smaller one', largeScale > smallScale);

    const smallSeconds = measureFillSeconds({
      n: samplesPerTube,
      crossSectionPx: 12,
      lengthPx: smallTube.lengthPx,
      Q: FLUID_PUMP_BASE_Q * smallScale,
    });
    const largeSeconds = measureFillSeconds({
      n: samplesPerTube,
      crossSectionPx: realTubeCrossSection,
      lengthPx: largeTube.lengthPx,
      Q: FLUID_PUMP_BASE_Q * largeScale,
    });

    ok('the small tube actually fills within the test window', smallSeconds !== null);
    ok('the large (real-map-scale) tube actually fills within the test window', largeSeconds !== null);

    if (smallSeconds !== null && largeSeconds !== null) {
      // Generous tolerance: this is a DESIGN TARGET (roughly length/cross-
      // section-invariant pacing), not a physical constant with an exact
      // derivation — the claim is "both tubes are watchable on a similar
      // timescale," not "identical to the millisecond."
      ok(
        `both tubes fill near FLUID_TARGET_TRAVERSAL_SECONDS=${FLUID_TARGET_TRAVERSAL_SECONDS}s ` +
          `(small: ${smallSeconds.toFixed(1)}s, large: ${largeSeconds.toFixed(1)}s) — ` +
          'length/cross-section-invariant pacing, not a 100x-plus mismatch',
        smallSeconds < FLUID_TARGET_TRAVERSAL_SECONDS * 3 && largeSeconds < FLUID_TARGET_TRAVERSAL_SECONDS * 3
      );
      ok(
        `the two tubes' fill times stay within 3x of each other despite a 23x length and ` +
          `24x cross-section difference (ratio: ${(Math.max(smallSeconds, largeSeconds) / Math.min(smallSeconds, largeSeconds)).toFixed(2)})`,
        Math.max(smallSeconds, largeSeconds) / Math.min(smallSeconds, largeSeconds) < 3
      );
    }
  }
}

/** Weighted centroid (bin index) of a state array — a robust "where is the
 * pulse" measure that tolerates the peak broadening slightly from numerical
 * diffusion, unlike a bare argmax. */
function centroid(arr) {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    weighted += i * arr[i];
    total += arr[i];
  }
  return total > 1e-9 ? weighted / total : 0;
}
