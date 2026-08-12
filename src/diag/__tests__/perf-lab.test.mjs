/**
 * perf-lab.test.mjs — the sweep's config sequence, the per-effect delta math, and the
 * two-phase orchestration (felt: natural cadence; GPU: throttled + polled), with an
 * injected fake harness + immediate frame-waiter, incl. the always-restore-on-error
 * guarantee. The DOM panel is browser-verified (CONVENTIONS §4).
 */
import {
  SWEEP_AB_SIGNIFICANCE_FACTOR,
  buildSweepConfigs,
  compareSweepPair,
  formatCost,
  formatMs,
  formatOther,
  runSweep,
  runSweepStructuralAB,
  summarizeSweep,
  waitForGpuSamples,
} from '../perf-lab.js';

const EFFECTS = [
  { id: 'candleFlame', label: 'Candle flames' },
  { id: 'uiWindowShadow', label: 'UI window shadows' },
];

/**
 * A harness that scripts felt + GPU readings per config (keyed by sweep order) and
 * records every call. Mirrors the REAL harness's semantics precisely, since that's
 * exactly what caught the original bug:
 *   - `resetFrameStats()` marks "now entering config N" (called once per config, right
 *     before its felt phase) — advances `ci`.
 *   - `setGpuProbe(true)` clears accumulated GPU samples (the real probe's OFF→ON edge).
 *   - Each `readCost()` while armed simulates ONE more completed sample landing, up to
 *     the config's scripted `samplesNeeded` (so `waitForGpuSamples` needs exactly that
 *     many polls) — and, like the real probe, GPU stats PERSIST after disarming until
 *     the next arm (never silently reset to null just because armed→false).
 */
function fakeHarness(effects, script, { throwOnConfigKey } = {}) {
  const calls = { forced: [], probe: [], reset: 0 };
  const orderedKeys = buildSweepConfigs(effects).map((c) => c.key);
  let ci = -1;
  let pollsSinceArm = 0;
  let gpuCount = 0;
  return {
    calls,
    listEffects: () => effects,
    setForcedEnabled: (id, en) => calls.forced.push([id, en]),
    setGpuProbe: (on) => {
      calls.probe.push(on);
      if (on) {
        pollsSinceArm = 0;
        gpuCount = 0; // rising-edge clear, mirrors gpu-probe.js
      }
    },
    resetFrameStats: () => {
      calls.reset += 1;
      ci += 1;
    },
    readCost: () => {
      const key = orderedKeys[ci];
      if (throwOnConfigKey && key === throwOnConfigKey) throw new Error('boom');
      const s = script[key] ?? {};
      pollsSinceArm += 1;
      gpuCount = Math.min(pollsSinceArm, s.samplesNeeded ?? 1);
      return {
        gpuProbe: {
          gpuMsMedian: gpuCount > 0 ? (s.gpuMs ?? null) : null,
          gpuMsP95: gpuCount > 0 ? (s.gpuP95 ?? null) : null,
          sampleCount: gpuCount,
        },
        hitchStats: {
          frameGapP50Ms: s.feltP50 ?? null,
          frameGapP95Ms: s.feltP95 ?? null,
          hitchCount: s.hitchCount ?? null,
        },
      };
    },
  };
}

const immediate = () => Promise.resolve();

export async function run(t) {
  const { ok } = t;

  // --- buildSweepConfigs ---------------------------------------------------
  {
    ok('no effects → just the baseline, nothing to bracket', buildSweepConfigs([]).length === 1);
    const one = buildSweepConfigs([{ id: 'candleFlame', label: 'Candle' }]);
    ok(
      'one effect → baseline + solo + closing baseline, NO redundant all-on',
      one.length === 3 && one[1].key === 'candleFlame'
    );
    const two = buildSweepConfigs(EFFECTS);
    ok('two effects → baseline + each solo + all-on + closing baseline', two.length === 5);
    ok('baseline turns everything off', two[0].on.length === 0);
    ok('a solo config turns on exactly its one effect', two[1].on.length === 1 && two[1].on[0] === 'candleFlame');
    ok('the all-on config lists every effect', two[3].on.length === 2);
    ok('garbage entries are dropped', buildSweepConfigs([null, { label: 'no id' }, { id: 5 }]).length === 1);

    // THE BRACKET — the closing config must be byte-identical in what it turns on, or
    // its difference from the opening one is not a noise measurement at all.
    ok('the closing baseline is LAST', two[two.length - 1].key === '__baseline2__');
    ok('the closing baseline turns everything off, exactly like the opening one', two[4].on.length === 0);
  }

  // --- summarizeSweep — the delta math -------------------------------------
  {
    const raw = {
      __baseline__: { gpuMs: 5, gpuSampleCount: 20 },
      candleFlame: { gpuMs: 17, gpuP95: 22, gpuSampleCount: 20 },
      uiWindowShadow: { gpuMs: 6, gpuP95: 7, gpuSampleCount: 20 },
      __all__: { gpuMs: 18, gpuSampleCount: 20, feltP50: 25, feltP95: 40, hitchCount: 3 },
    };
    const s = summarizeSweep(raw, EFFECTS);
    ok('effect cost = solo − baseline (candle 17−5=12)', s.perEffect[0].costMs === 12);
    ok('the fat effect sorts first', s.perEffect[0].id === 'candleFlame');
    ok('the cheap effect is second (shadow 6−5=1)', s.perEffect[1].costMs === 1);
    ok('% of the effect stack (12/13 ≈ 92.3%)', s.perEffect[0].pctOfEffects === 92.3);
    ok('effect stack total = all − baseline (18−5=13)', s.totalEffectGpuMs === 13);
    ok('implied Foundry/other = felt − MSA gpu (25−18=7)', s.impliedOtherMs === 7);
    ok('per-effect P95 carried through', s.perEffect[0].gpuP95 === 22);
    ok('sample counts carried through', s.perEffect[0].gpuSampleCount === 20 && s.all.gpuSampleCount === 20);
    ok('no closing baseline → floor is null (unknown), not a fake 0', s.noiseFloorMs === null);
    ok('no closing baseline → resolution is UNKNOWN, never a clean bill of health', s.perEffect[0].resolved === null);
  }

  // --- summarizeSweep — the bracketed baseline: bias removal + measured floor ---
  {
    // The closing baseline reads 2ms HIGHER than the opening one — the machine drifted
    // over the run. Averaging is what stops that drift landing on every effect's cost.
    const raw = {
      __baseline__: { gpuMs: 10, gpuSampleCount: 40 },
      candleFlame: { gpuMs: 18, gpuSampleCount: 40 },
      uiWindowShadow: { gpuMs: 11.5, gpuSampleCount: 40 },
      __all__: { gpuMs: 19, gpuSampleCount: 40, feltP50: 25 },
      __baseline2__: { gpuMs: 12, gpuSampleCount: 40 },
    };
    const s = summarizeSweep(raw, EFFECTS);
    ok('baseline is the MEAN of the bracketing pair ((10+12)/2 = 11)', s.baseline.gpuMs === 11);
    ok('both ends stay visible for inspection', s.baselineOpenMs === 10 && s.baselineCloseMs === 12);
    ok('drift keeps its SIGN (the machine got slower, +2)', s.baselineDriftMs === 2);
    ok('the noise floor is the drift MAGNITUDE', s.noiseFloorMs === 2);
    ok('costs are measured from the averaged baseline (candle 18−11=7)', s.perEffect[0].costMs === 7);
    ok('a cost clear of the floor is resolved', s.perEffect[0].resolved === true);

    // uiWindowShadow: 11.5 − 11 = 0.5 ms, inside a 2 ms floor. This is the row that used
    // to print "0.50 ms / 6.3% of effects" as though it were a finding.
    const shadow = s.perEffect.find((e) => e.id === 'uiWindowShadow');
    ok('a cost inside the floor is NOT resolved', shadow.resolved === false);
    ok('an unresolved cost keeps its raw number — nothing is hidden', shadow.costMs === 0.5);
    ok('but its share of the stack is suppressed — no percentage of noise', shadow.pctOfEffects === null);
    ok('a resolved effect still gets its share', s.perEffect[0].pctOfEffects === 87.5);
  }

  // --- summarizeSweep — a NEGATIVE cost is noise, and is caught by the floor ---
  {
    // The exact shape of the 2026-07-29 live report: nine of eleven effects reading
    // BELOW an over-warm opening baseline, several of them negative.
    const raw = {
      __baseline__: { gpuMs: 10.8 },
      candleFlame: { gpuMs: 11.8 },
      uiWindowShadow: { gpuMs: 9.0 }, // −1.8ms: physically impossible as a cost
      __all__: { gpuMs: 13.6, feltP50: 8.4 },
      __baseline2__: { gpuMs: 9.4 },
    };
    const s = summarizeSweep(raw, EFFECTS);
    const shadow = s.perEffect.find((e) => e.id === 'uiWindowShadow');
    ok('a negative cost is flagged unresolved rather than ranked', shadow.resolved === false && shadow.costMs < 0);
    ok('a negative cost gets NO percentage of the stack', shadow.pctOfEffects === null);
    ok('averaging the bracket shrinks the impossible negative (−1.8 → −1.1)', shadow.costMs === -1.1);
  }

  // --- summarizeSweep — THIRD post-mortem: a negative cost BIGGER than the floor used to
  // --- read as "resolved" (magnitude-only check). This is the exact shape of the live
  // --- report that caught it: doorGraphics/grade both negative AND past the floor.
  {
    const raw = {
      __baseline__: { gpuMs: 19.8 },
      candleFlame: { gpuMs: 18.9 }, // -1.5ms — same shape as the live 'grade' row
      uiWindowShadow: { gpuMs: 22.2 }, // +1.8ms — a real, resolved positive cost
      __all__: { gpuMs: 23.1, feltP50: 20.7 },
      __baseline2__: { gpuMs: 21.0 }, // drift +1.2 → noiseFloor 1.2, baseGpu (avg) 20.4
    };
    const s = summarizeSweep(raw, EFFECTS);
    const candle = s.perEffect.find((e) => e.id === 'candleFlame'); // cost = 18.9-20.4 = -1.5
    const shadow = s.perEffect.find((e) => e.id === 'uiWindowShadow'); // cost = 22.2-20.4 = 1.8

    // The reconciled floor now folds candle's own -1.5 INTO itself (it IS this
    // sweep's worst negative reading), so it can only ever TIE candle's own
    // magnitude, never be exceeded by it — which is exactly why `resolved`
    // uses this floor but `suspiciousNegative` deliberately does not (see its
    // own comment in summarizeSweep).
    ok('the reconciled floor absorbs the worst negative reading itself', s.noiseFloorMs === 1.5);
    ok(
      'a negative reading past the BASELINE-PAIR floor is NOT "resolved" — confidently wrong, not a saving',
      candle.resolved === false
    );
    ok(
      'it IS flagged as suspicious drift (compared against the bracketing pair, 1.2, not the reconciled 1.5)',
      candle.suspiciousNegative === true
    );
    ok('its percentage share is still suppressed, same as any unresolved row', candle.pctOfEffects === null);

    ok('a genuine positive cost past the RECONCILED floor stays resolved', shadow.resolved === true);
    ok('and is never flagged suspicious', shadow.suspiciousNegative === false);

    ok(
      'a run with a resolved effect explains what the percentages mean',
      s.notes.some((n) => n.includes('share'))
    );
    ok(
      'a run with a suspicious-negative effect gets an explicit warning about it',
      s.notes.some((n) => n.toLowerCase().includes('drift'))
    );
  }

  // --- summarizeSweep — FOURTH post-mortem (2026-08-06): the floor ITSELF used to be
  // --- computed two different ways in two places. This reproduces the live report that
  // --- caught it: a small POSITIVE reading (like 'grade': 0.35ms) cleared this function's
  // --- OWN bracketing-pair-only floor (0.1ms that run) and printed resolved:true, while
  // --- perf-report.js's separately-reconciled floor (1.35ms, from a DIFFERENT effect's
  // --- worse negative reading) rejected the exact same number — one report, two verdicts.
  {
    const raw = {
      __baseline__: { gpuMs: 20.0 }, // baseGpu (avg of 20.0/20.1) = 20.05
      candleFlame: { gpuMs: 20.4 }, // cost = 20.4-20.05 = +0.35ms — clears the tiny bracket-only floor (0.1), but shouldn't survive reconciliation
      uiWindowShadow: { gpuMs: 18.7 }, // cost = 18.7-20.05 = -1.35ms — a much worse negative from ANOTHER effect, sets the real floor
      __all__: { gpuMs: 20.2, feltP50: 25 },
      __baseline2__: { gpuMs: 20.1 }, // drift 0.1 → bracketing-pair-alone floor would be 0.1
    };
    const s = summarizeSweep(raw, EFFECTS);
    const grade = s.perEffect.find((e) => e.id === 'candleFlame');
    ok(
      "the reconciled floor is the OTHER effect's worse negative (1.35), not the tiny bracket drift (0.1)",
      s.noiseFloorMs === 1.35
    );
    ok(
      'a small positive reading that would have cleared the bracket-alone floor is correctly REJECTED once reconciled',
      grade.resolved === false && grade.costMs === 0.35
    );
    ok(
      'a positive-but-unresolved reading is never mislabelled "suspicious" (only negatives are)',
      grade.suspiciousNegative === false
    );
  }

  // --- summarizeSweep — the "what do percentages mean" note only appears once there is
  // --- at least one resolved effect for it to explain -----------------------------------
  {
    // Both effects land INSIDE a 0.5ms floor, one from each side of zero, and neither
    // clears it — nothing here is "resolved", so there is nothing yet for a percentage
    // note to explain.
    const raw = {
      __baseline__: { gpuMs: 20.0 },
      candleFlame: { gpuMs: 20.4 }, // cost +0.15, inside the floor
      uiWindowShadow: { gpuMs: 20.1 }, // cost -0.15, inside the floor (not suspicious — too small to be confident either way)
      __all__: { gpuMs: 20.6, feltP50: 25 },
      __baseline2__: { gpuMs: 20.5 }, // drift 0.5 → noiseFloor 0.5
    };
    const s = summarizeSweep(raw, EFFECTS);
    ok(
      'neither effect resolves',
      s.perEffect.every((e) => e.resolved === false)
    );
    ok(
      'a small negative inside the floor is NOT flagged suspicious — that needs magnitude too',
      !s.perEffect.some((e) => e.suspiciousNegative)
    );
    // "rough ranking" is unique to the anyResolved-gated note — "share" alone also appears
    // in the separate totalEffectGpuMs-unresolvable note, which CAN legitimately fire here.
    ok('nothing resolved → no "what percentages mean" note', !s.notes.some((n) => n.includes('rough ranking')));
    ok('nothing suspicious → no drift-warning note', !s.notes.some((n) => n.toLowerCase().includes('systematically')));
  }

  // --- formatCost — the suspicious-negative label is distinct from "< noise" -------------
  {
    ok(
      'a suspicious-negative reading gets its own label, not folded into "< noise"',
      formatCost({ costMs: -1.5, resolved: false, suspiciousNegative: true }) === '⚠ drift, not cost (-1.50 ms)'
    );
    ok(
      'an ordinary unresolved reading (not flagged suspicious) still reads as noise',
      formatCost({ costMs: 0.3, resolved: false, suspiciousNegative: false }) === '< noise (0.30 ms)'
    );
  }

  // --- summarizeSweep — felt and GPU are different clocks, not subtractable ---
  {
    // 2026-07-29 live: felt P50 8.4ms beside 13.6ms of MSA GPU work. The old code
    // reported "Foundry / other: −5.2 ms" — an impossible negative, unflagged.
    const s = summarizeSweep({ __baseline__: { gpuMs: 9 }, __all__: { gpuMs: 13.6, feltP50: 8.4 } }, EFFECTS);
    ok('GPU frame longer than the felt gap is FLAGGED, not differenced', s.feltUnderstated === true);
    ok('and the meaningless subtraction is suppressed, not printed as a negative', s.impliedOtherMs === null);

    // The regime where the subtraction IS valid: GPU fits inside the observed gap.
    const okRegime = summarizeSweep({ __baseline__: { gpuMs: 4 }, __all__: { gpuMs: 6, feltP50: 25 } }, EFFECTS);
    ok('when GPU fits inside the felt gap the difference is still reported', okRegime.impliedOtherMs === 19);
    ok('and nothing is flagged', okRegime.feltUnderstated === false);
  }

  // --- summarizeSweep — honest nulls, never a lying 0 ----------------------
  {
    const s = summarizeSweep({ candleFlame: { gpuMs: 9 } }, EFFECTS); // no baseline, no all
    ok(
      'missing baseline → cost is null, not 0',
      s.perEffect.every((e) => e.costMs === null)
    );
    ok('missing all-on → implied other is null', s.impliedOtherMs === null);
    ok('empty raw does not throw', typeof summarizeSweep(null, EFFECTS) === 'object');
    ok(
      'a config with no reading defaults sample count to 0',
      s.perEffect.find((e) => e.id === 'uiWindowShadow').gpuSampleCount === 0
    );
  }

  // --- formatMs / formatOther ------------------------------------------------------------
  {
    ok('null → em dash (not 0)', formatMs(null) === '—' && formatMs(undefined) === '—');
    ok('rounds to 2dp with unit', formatMs(8.334) === '8.33 ms');
    ok('formatOther null → em dash', formatOther(null) === '—');
    ok(
      'a small negative reads as noise, not an impossible negative cost',
      formatOther(-0.3) === '≈0 ms (within noise)'
    );
    ok('a large negative is shown plainly, not hidden', formatOther(-33.5) === '-33.50 ms');
    ok('a real positive formats normally', formatOther(5.1) === '5.10 ms');

    ok('a resolved cost formats plainly', formatCost({ costMs: 6.9, resolved: true }) === '6.90 ms');
    ok(
      'an unresolved cost keeps its number but says it is noise',
      formatCost({ costMs: -1.8, resolved: false }) === '< noise (-1.80 ms)'
    );
    ok(
      'an unknown floor is stated as unverified, NOT silently accepted',
      formatCost({ costMs: 0.5, resolved: null }) === '0.50 ms (unverified floor)'
    );
  }

  // --- waitForGpuSamples — polls until the target lands, never hangs -------
  {
    let calls = 0;
    const h = { readCost: () => ({ gpuProbe: { sampleCount: Math.min(++calls, 3) } }) };
    const count = await waitForGpuSamples(h, 3, { waitFrames: immediate, pollFrames: 1, maxPolls: 50 });
    ok('stops as soon as the target is reached', count === 3 && calls === 3);

    let stuckCalls = 0;
    const stuck = { readCost: () => ({ gpuProbe: { sampleCount: (stuckCalls++, 0) } }) };
    const gaveUp = await waitForGpuSamples(stuck, 10, { waitFrames: immediate, pollFrames: 1, maxPolls: 5 });
    // maxPolls loop iterations + one final re-check after the last wait (a real chance
    // for a late sample to land, not a redundant call) = maxPolls + 1 reads.
    ok('a probe that never yields samples gives up after maxPolls, does not hang', gaveUp === 0 && stuckCalls === 6);
  }

  // --- runSweep — two-phase read order, probe arming, raw assembly ---------
  {
    const script = {
      __baseline__: { feltP50: 8.3, feltP95: 9, hitchCount: 0, gpuMs: 5, gpuP95: 6, samplesNeeded: 3 },
      candleFlame: { feltP50: 8.3, feltP95: 9, hitchCount: 0, gpuMs: 17, gpuP95: 20, samplesNeeded: 3 },
      uiWindowShadow: { feltP50: 8.3, feltP95: 9, hitchCount: 0, gpuMs: 6, gpuP95: 7, samplesNeeded: 3 },
      __all__: { feltP50: 25, feltP95: 40, hitchCount: 3, gpuMs: 18, gpuP95: 21, samplesNeeded: 3 },
      // The closing baseline reads 1ms above the opening one — a run that warmed up.
      __baseline2__: { feltP50: 8.3, feltP95: 9, hitchCount: 0, gpuMs: 6, gpuP95: 7, samplesNeeded: 3 },
    };
    const h = fakeHarness(EFFECTS, script);
    const out = await runSweep(h, {
      settleFrames: 0,
      feltFrames: 0,
      gpuSampleTarget: 3,
      pollFrames: 0,
      waitFrames: immediate,
      warmupFrames: 0, // this block tests the measured loop, not warm-up — see its own tests below
    });
    ok('raw captured every config, incl. the closing baseline', Object.keys(out.raw).length === 5);
    ok('baseline GPU + felt both recorded', out.raw.__baseline__.gpuMs === 5 && out.raw.__baseline__.feltP50 === 8.3);
    ok('the closing baseline is measured like any other config', out.raw.__baseline2__.gpuMs === 6);
    ok('a config reaches its scripted sample count', out.raw.candleFlame.gpuSampleCount === 3);
    // Baseline averages to 5.5, so candle costs 11.5 — NOT the 12 a first-only baseline
    // would have claimed. That 0.5ms is exactly the drift the bracket exists to remove.
    ok('summary uses the averaged baseline (candle 17−5.5=11.5)', out.summary.perEffect[0].costMs === 11.5);
    ok('and the run reports the floor it measured', out.summary.noiseFloorMs === 1);
    // once per config (5) + once more in the sweep's finally cleanup (6 total).
    ok('resetFrameStats called once per config, before its felt phase', h.calls.reset === 6);
    ok('probe armed once per config (5 configs → 5 trues)', h.calls.probe.filter((x) => x === true).length === 5);
    // restore: the LAST setForcedEnabled for each effect is null
    const lastCandle = [...h.calls.forced].reverse().find((f) => f[0] === 'candleFlame');
    const lastShadow = [...h.calls.forced].reverse().find((f) => f[0] === 'uiWindowShadow');
    ok('every effect restored to the real cascade (null) at the end', lastCandle[1] === null && lastShadow[1] === null);
  }

  // --- runSweep — onProgress reports both sub-phases ------------------------
  {
    const script = {
      __baseline__: { samplesNeeded: 1 },
      candleFlame: { samplesNeeded: 1 },
      uiWindowShadow: { samplesNeeded: 1 },
      __all__: { samplesNeeded: 1 },
      __baseline2__: { samplesNeeded: 1 },
    };
    const h = fakeHarness(EFFECTS, script);
    const phases = [];
    await runSweep(h, {
      settleFrames: 0,
      feltFrames: 0,
      gpuSampleTarget: 1,
      pollFrames: 0,
      waitFrames: immediate,
      warmupFrames: 0, // this block tests per-config phases, not warm-up — see its own tests below
      onProgress: (pr) => phases.push(pr.phase),
    });
    ok('every config reports a felt phase then a gpu phase', phases.includes('felt') && phases.includes('gpu'));
    ok('felt is reported before gpu for the same config', phases.indexOf('felt') < phases.indexOf('gpu'));
  }

  // --- runSweep — ALWAYS restores, even when a read throws -----------------
  {
    const script = { __baseline__: { samplesNeeded: 1, gpuMs: 5 }, candleFlame: { samplesNeeded: 1, gpuMs: 17 } };
    const h = fakeHarness(EFFECTS, script, { throwOnConfigKey: 'uiWindowShadow' }); // throw mid-sweep
    let threw = false;
    try {
      await runSweep(h, {
        settleFrames: 0,
        feltFrames: 0,
        gpuSampleTarget: 1,
        pollFrames: 0,
        waitFrames: immediate,
        warmupFrames: 0,
      });
    } catch {
      threw = true;
    }
    ok('a mid-sweep error propagates', threw === true);
    const lastCandle = [...h.calls.forced].reverse().find((f) => f[0] === 'candleFlame');
    const lastShadow = [...h.calls.forced].reverse().find((f) => f[0] === 'uiWindowShadow');
    ok('the scene is STILL restored after an error (finally)', lastCandle[1] === null && lastShadow[1] === null);
    ok('the probe is disarmed after an error', h.calls.probe[h.calls.probe.length - 1] === false);
    ok('frame stats reset one final time on the way out', h.calls.reset > 0);
  }

  // --- runSweep — GPU warm-up: forces everything on, off the measured clock -----------
  {
    const script = {
      __baseline__: { samplesNeeded: 1, gpuMs: 5 },
      candleFlame: { samplesNeeded: 1, gpuMs: 17 },
      uiWindowShadow: { samplesNeeded: 1, gpuMs: 6 },
      __all__: { samplesNeeded: 1, gpuMs: 18, feltP50: 25 },
      __baseline2__: { samplesNeeded: 1, gpuMs: 6 },
    };
    const h = fakeHarness(EFFECTS, script);
    let warmupFrameArg = null;
    let waitCallCount = 0;
    const phases = [];
    const waitFramesSpy = (n) => {
      // The warm-up's own `await waitFrames(warmupFrames)` is the FIRST waitFrames call in
      // the whole sweep — before any config's settle/felt/poll waits.
      waitCallCount += 1;
      if (waitCallCount === 1) warmupFrameArg = n;
      return Promise.resolve();
    };
    await runSweep(h, {
      settleFrames: 0,
      feltFrames: 0,
      gpuSampleTarget: 1,
      pollFrames: 0,
      warmupFrames: 42,
      waitFrames: waitFramesSpy,
      onProgress: (pr) => phases.push(pr),
    });
    ok('the warm-up reports its own progress phase, before any config', phases[0].phase === 'warmup');
    ok('waits the requested warm-up frame count', warmupFrameArg === 42);
    ok(
      'every effect is forced ON for warm-up (the first N sets, before the baseline turns them back off)',
      h.calls.forced.slice(0, 2).every(([, en]) => en === true)
    );

    // warmupFrames: 0 skips the phase entirely — no wasted wait, no phantom progress event.
    const h2 = fakeHarness(EFFECTS, script);
    const phases2 = [];
    await runSweep(h2, {
      settleFrames: 0,
      feltFrames: 0,
      gpuSampleTarget: 1,
      pollFrames: 0,
      warmupFrames: 0,
      waitFrames: immediate,
      onProgress: (pr) => phases2.push(pr.phase),
    });
    ok('warmupFrames: 0 skips warm-up entirely', !phases2.includes('warmup'));
  }

  // --- runSweep — context is read once and carried on the report, absent gracefully ----
  {
    const script = {
      __baseline__: { samplesNeeded: 1, gpuMs: 5 },
      candleFlame: { samplesNeeded: 1, gpuMs: 17 },
      uiWindowShadow: { samplesNeeded: 1, gpuMs: 6 },
      __all__: { samplesNeeded: 1, gpuMs: 18, feltP50: 25 },
      __baseline2__: { samplesNeeded: 1, gpuMs: 6 },
    };
    const withContext = fakeHarness(EFFECTS, script);
    withContext.getContext = () => ({ sceneName: 'Torture Fixture', floorIndex: 1, msaVersion: '0.6.0-dev.0' });
    const out = await runSweep(withContext, {
      settleFrames: 0,
      feltFrames: 0,
      gpuSampleTarget: 1,
      pollFrames: 0,
      warmupFrames: 0,
      waitFrames: immediate,
    });
    ok('the report carries whatever the harness reports as context', out.context?.sceneName === 'Torture Fixture');

    const noContext = fakeHarness(EFFECTS, script); // no getContext at all — an older/minimal harness
    const out2 = await runSweep(noContext, {
      settleFrames: 0,
      feltFrames: 0,
      gpuSampleTarget: 1,
      pollFrames: 0,
      warmupFrames: 0,
      waitFrames: immediate,
    });
    ok('a harness without getContext still returns a full report, context is null not a throw', out2.context === null);
  }

  // ======================================================================
  // compareSweepPair — two independent full sweeps, on vs off
  // ======================================================================
  // The real shape this answers: does a structural toggle (early-Z) cost
  // anything on the CLEANEST possible reading (all-effects-off baseline),
  // and does the effect stack agree.
  {
    const sweepResult = (baselineGpu, allGpu, floor, perEffect) => ({
      summary: { baseline: { gpuMs: baselineGpu }, all: { gpuMs: allGpu }, noiseFloorMs: floor, perEffect },
    });
    const eff = (id, costMs, resolved = true) => ({ id, label: id, costMs, resolved });

    // ON costs 5ms more on the bare baseline; both runs' floors are tiny (0.05),
    // so 5ms clears 0.05 * 1.5 comfortably. Per-effect costs identical on both
    // sides — the toggle should not be seen to move any individual effect.
    const on = sweepResult(25, 25.4, 0.05, [eff('candleFlame', 0.3), eff('uiWindowShadow', 0.1)]);
    const off = sweepResult(20, 20.4, 0.05, [eff('candleFlame', 0.3), eff('uiWindowShadow', 0.1)]);
    const cmp = compareSweepPair(on, off);
    ok('a real baseline delta clearing the floor earns a verdict', cmp.verdict === 'costs-more-than-it-saves');
    ok('...the delta is signed ON minus OFF', cmp.baselineDeltaMs === 5);
    ok('...the floor used is the LARGER of the two runs own floors', cmp.noiseFloorMs === 0.05);
    ok(
      '...per-effect deltas read ~0 for effects unaffected by the toggle',
      cmp.perEffect.every((e) => e.deltaMs === 0)
    );
    ok('...the all-on reading is checked against the baseline reading', cmp.agreesWithAllOn === true);
    ok('...and the note says so, not silently', cmp.note.includes('agrees within noise'));
    ok('...the significance factor is the same value the module exports', SWEEP_AB_SIGNIFICANCE_FACTOR === 1.5);

    // The opposite sign: OFF costs more, so the toggle pays for itself.
    const cheaperOn = sweepResult(18, 18.4, 0.05, [eff('candleFlame', 0.3)]);
    const pricier = sweepResult(25, 25.4, 0.05, [eff('candleFlame', 0.3)]);
    ok('a negative delta reads as pays-for-itself', compareSweepPair(cheaperOn, pricier).verdict === 'pays-for-itself');

    // A delta that does NOT clear the floor earns no verdict — same discipline
    // as the same-run A/B: "could not tell" must never masquerade as a result.
    const close1 = sweepResult(25, 25.4, 0.5, [eff('candleFlame', 0.3)]);
    const close2 = sweepResult(25.3, 25.7, 0.5, [eff('candleFlame', 0.3)]);
    const noVerdict = compareSweepPair(close1, close2);
    ok('a delta inside the conservative floor earns no verdict', noVerdict.verdict === 'within-noise');
    ok('...the note says "could not tell", not "no difference"', noVerdict.note.includes('could not tell'));

    // A real, UNRESOLVED disagreement between baseline and all-on readings —
    // the effect stack costs something the bare baseline does not predict —
    // must be surfaced, not smoothed into the baseline-only verdict.
    const onDisagree = sweepResult(25, 40, 0.05, []); // all-on jumped 15ms more than baseline alone explains
    const offDisagree = sweepResult(20, 20.4, 0.05, []);
    const disagreeCmp = compareSweepPair(onDisagree, offDisagree);
    ok('a baseline/all-on disagreement is detected', disagreeCmp.agreesWithAllOn === false);
    ok('...and flagged with a warning in the note, not silently averaged away', disagreeCmp.note.includes('⚠️'));

    // A zone/effect present only on one side must not crash the diff — it is
    // simply excluded from perEffect (no meaningful delta exists for it).
    const onlyOnOne = sweepResult(25, 25.4, 0.05, [eff('candleFlame', 0.3), eff('onlyOnThisSide', 1)]);
    const missing = sweepResult(20, 20.4, 0.05, [eff('candleFlame', 0.3)]);
    ok(
      'an effect present on only one side is excluded, not a crash',
      compareSweepPair(onlyOnOne, missing).perEffect.every((e) => e.id !== 'onlyOnThisSide')
    );

    // Missing summaries entirely — an absence, never a fabricated comparison.
    const blind = compareSweepPair({ summary: null }, off);
    ok('a missing summary on either side yields unmeasured, not a throw', blind.verdict === 'unmeasured');
  }

  // ======================================================================
  // runSweepStructuralAB — the sweep, run twice, one toggle flip apart
  // ======================================================================
  // `ci` (config index) in this fixture resets on every toggle flip, mirroring
  // the real control flow: runSweepStructuralAB always flips the toggle
  // immediately before starting a FRESH runSweep pass over every config.
  function fakeAbHarness(effects, scriptByState, { initial = true, canToggle = true, canRead = true } = {}) {
    const orderedKeys = buildSweepConfigs(effects).map((c) => c.key);
    let state = initial;
    let ci = -1;
    let pollsSinceArm = 0;
    let gpuCount = 0;
    const flips = [];
    const harness = {
      flips,
      listEffects: () => effects,
      setForcedEnabled: () => {},
      setGpuProbe: (on) => {
        if (on) {
          pollsSinceArm = 0;
          gpuCount = 0;
        }
      },
      resetFrameStats: () => {
        ci += 1;
      },
      readCost: () => {
        const key = orderedKeys[ci];
        const s = (scriptByState[state ? 'on' : 'off'] ?? {})[key] ?? {};
        pollsSinceArm += 1;
        gpuCount = Math.min(pollsSinceArm, s.samplesNeeded ?? 1);
        return {
          gpuProbe: {
            gpuMsMedian: gpuCount > 0 ? (s.gpuMs ?? null) : null,
            gpuMsP95: gpuCount > 0 ? (s.gpuP95 ?? null) : null,
            sampleCount: gpuCount,
          },
          hitchStats: { frameGapP50Ms: s.feltP50 ?? null, frameGapP95Ms: s.feltP95 ?? null, hitchCount: null },
        };
      },
    };
    // `canRead:false` means the ACCESSOR EXISTS but cannot resolve a real
    // value (e.g. an id the harness doesn't recognise, or the viewer not
    // started) — the DIFFERENT refusal path from omitting the method
    // entirely, which `harness-cannot-toggle` already covers below.
    harness.readStructuralToggle = canRead ? () => state : () => null;
    if (canToggle) {
      harness.setStructuralToggle = (id, on) => {
        flips.push([id, on]);
        state = on;
        ci = -1; // a fresh runSweep pass starts right after every flip
        return { changed: true };
      };
    }
    return harness;
  }

  const AB_EFFECTS = [{ id: 'candleFlame', label: 'Candle flames' }];
  // __baseline__ and __baseline2__ are IDENTICAL within each state — summarizeSweep
  // averages the pair (see its own header), so a deliberate difference between them
  // would blur the ON-vs-OFF numbers this fixture exists to keep clean; that
  // averaging behaviour already has its own coverage above.
  const abScript = {
    on: {
      __baseline__: { gpuMs: 25, samplesNeeded: 1 },
      candleFlame: { gpuMs: 25.3, samplesNeeded: 1 },
      __baseline2__: { gpuMs: 25, samplesNeeded: 1 },
    },
    off: {
      __baseline__: { gpuMs: 20, samplesNeeded: 1 },
      candleFlame: { gpuMs: 20.3, samplesNeeded: 1 },
      __baseline2__: { gpuMs: 20, samplesNeeded: 1 },
    },
  };
  const FAST_AB_OPTS = { settleFrames: 0, feltFrames: 0, gpuSampleTarget: 1, pollFrames: 0, waitFrames: immediate };

  {
    {
      const h = fakeAbHarness(AB_EFFECTS, abScript, { initial: true });
      const r = await runSweepStructuralAB(h, 'earlyZComposition', FAST_AB_OPTS);
      ok('a live A/B sweep reports that it ran', r.ran === true);
      ok('...flipped ON first', h.flips[0][1] === true);
      ok('...then OFF', h.flips[1][1] === false);
      ok(
        '...then restored the toggle to what it found, as a THIRD flip',
        h.flips.length === 3 && h.flips[2][1] === true
      );
      ok('...carrying the live state it started from', r.liveState === true);
      ok('...both full sweeps actually ran', r.on?.summary != null && r.off?.summary != null);
      ok('...the ON sweep saw the ON-state numbers', r.on.summary.baseline.gpuMs === 25);
      ok('...the OFF sweep saw the OFF-state numbers', r.off.summary.baseline.gpuMs === 20);
      ok('...a comparison was computed from both', r.comparison?.baselineDeltaMs === 5);
      ok('...settle-frames used is reported', Number.isFinite(r.settleFrames));
    }

    // A throw partway through the SECOND sweep must not strand the toggle off.
    {
      const h = fakeAbHarness(AB_EFFECTS, abScript, { initial: true });
      const realReadCost = h.readCost;
      let calls = 0;
      h.readCost = (...args) => {
        calls++;
        // The ON sweep (3 configs x 3 readCost calls each = felt, one GPU
        // poll, final GPU read = 9 total) must complete fully before this
        // fires, so the throw lands partway through OFF's own 9 calls.
        if (calls > 10) throw new Error('boom mid-OFF-sweep');
        return realReadCost(...args);
      };
      let threw = false;
      try {
        await runSweepStructuralAB(h, 'earlyZComposition', FAST_AB_OPTS);
      } catch {
        threw = true;
      }
      ok('a throw mid-second-sweep propagates', threw === true);
      ok('...but the toggle is still restored to what it was found as', h.flips[h.flips.length - 1][1] === true);
    }

    // An originally-OFF toggle must be restored to OFF, not left ON (the ON
    // pass always runs first regardless of the live starting state).
    {
      const h = fakeAbHarness(AB_EFFECTS, abScript, { initial: false });
      const r = await runSweepStructuralAB(h, 'earlyZComposition', FAST_AB_OPTS);
      ok('originally-off is restored to off', h.flips[h.flips.length - 1][1] === false);
      ok('...even though liveState correctly recorded it as the starting point', r.liveState === false);
    }

    // Refusals must be NAMED, never a silent "ran and found nothing".
    {
      const noHooks = { listEffects: () => AB_EFFECTS };
      const r1 = await runSweepStructuralAB(noHooks, 'earlyZComposition', FAST_AB_OPTS);
      ok('a harness with no toggle hooks refuses rather than throwing', r1.ran === false);
      ok('...naming the reason as a wiring gap', r1.skipped === 'harness-cannot-toggle');

      const unreadable = fakeAbHarness(AB_EFFECTS, abScript, { canRead: false });
      const r2 = await runSweepStructuralAB(unreadable, 'earlyZComposition', FAST_AB_OPTS);
      ok('an unreadable toggle is never flipped blind', r2.ran === false);
      ok('...because there would be nothing to restore it to', r2.skipped === 'toggle-not-readable');
    }
  }
}
