/**
 * Node verification for effects/fluid/fluid-pump.js — THE PUMP.
 *
 * The one property that matters most: given the SAME `(tMs, tubeIndex)`, this
 * must return the SAME answer, every time, forever — that determinism is what
 * lets it be driven by the shared sim clock alone with no private RNG state to
 * keep in sync across a ping-pong swap (see the module's own header).
 */
import { hash01, fluidPumpPersonality, fluidPumpForTube, FLUID_PUMP_BASE_Q } from '../fluid-pump.js';

export function run(t) {
  const { ok } = t;

  // ── hash01: the primitive everything else is built from ─────────────────
  {
    let allInRange = true;
    let anyNaN = false;
    const seen = new Set();
    for (let n = 0; n < 500; n++) {
      const v = hash01(n);
      if (!(v >= 0 && v < 1)) allInRange = false;
      if (Number.isNaN(v)) anyNaN = true;
      seen.add(Math.round(v * 1000));
    }
    ok('hash01 stays in [0,1) over 500 seeds', allInRange);
    ok('hash01 never produces NaN', !anyNaN);
    ok('hash01 is not a constant (varies across seeds)', seen.size > 100);
    ok('hash01(0) equals hash01(0) — deterministic', hash01(0) === hash01(0));
    ok('hash01 of negative-adjacent seeds does not throw or collide trivially', hash01(-1) !== hash01(1));
  }

  // ── fluidPumpForTube: determinism, the whole point ───────────────────────
  {
    const a = fluidPumpForTube(12345.6, 3);
    const b = fluidPumpForTube(12345.6, 3);
    ok('same (tMs, tubeIndex) gives the identical Q', a.Q === b.Q);
    ok('same (tMs, tubeIndex) gives the identical inject', a.inject === b.inject);

    const c = fluidPumpForTube(12345.6, 4);
    ok('a different tube index gives a different answer', a.Q !== c.Q || a.inject !== c.inject);

    const d = fluidPumpForTube(99999.9, 3);
    ok('a different tMs gives a different answer (it is not frozen)', a.Q !== d.Q || a.inject !== d.inject);
  }

  // ── Bounds: Q and inject must never do something a shader can't shade ───
  {
    let anyNaN = false;
    let anyNegativeQ = false;
    let injectOutOfRange = false;
    let minQ = Infinity;
    let maxQ = -Infinity;
    for (let tube = 0; tube < 12; tube++) {
      const personality = fluidPumpPersonality(tube);
      for (let ms = 0; ms < 60000; ms += 137) {
        const { Q, inject } = fluidPumpForTube(ms, tube, personality);
        if (Number.isNaN(Q) || Number.isNaN(inject)) anyNaN = true;
        if (Q < 0) anyNegativeQ = true;
        if (inject < -1e-9 || inject > 1 + 1e-9) injectOutOfRange = true;
        if (Q < minQ) minQ = Q;
        if (Q > maxQ) maxQ = Q;
      }
    }
    ok('no NaN across 12 tubes x 60s of simulated time', !anyNaN);
    ok('Q never goes negative — flow is always root -> tip', !anyNegativeQ);
    ok('inject always stays within 0..1', !injectOutOfRange);
    ok(
      `Q stays within a sane multiple of its base (${minQ.toFixed(0)}..${maxQ.toFixed(0)})`,
      maxQ < FLUID_PUMP_BASE_Q * 4
    );
  }

  // ── The duty cycle actually produces GAPS, not a constant stream ─────────
  {
    const personality = fluidPumpPersonality(0);
    let sawFull = false;
    let sawEmpty = false;
    for (let ms = 0; ms < 20000; ms += 20) {
      const { inject } = fluidPumpForTube(ms, 0, personality);
      if (inject > 0.9) sawFull = true;
      if (inject < 0.1) sawEmpty = true;
    }
    ok('inject reaches near-1 (a full slug) at some point', sawFull);
    ok('inject reaches near-0 (a gap) at some point', sawEmpty);
  }

  // ── The gulp is a SPIKE, not a constant multiplier ───────────────────────
  {
    const personality = fluidPumpPersonality(1);
    let atRest = 0;
    let peak = 0;
    let samples = 0;
    for (let ms = 0; ms < 30000; ms += 25) {
      const { Q } = fluidPumpForTube(ms, 1, personality);
      atRest += Q;
      samples++;
      if (Q > peak) peak = Q;
    }
    const mean = atRest / samples;
    ok(`the gulp peak (${peak.toFixed(0)}) clears the mean (${mean.toFixed(0)}) by a real margin`, peak > mean * 1.3);
  }

  // ── Two tubes never march in lockstep (each has its own personality) ────
  {
    let identicalCount = 0;
    const total = 200;
    for (let i = 0; i < total; i++) {
      const ms = i * 311;
      const x = fluidPumpForTube(ms, 5);
      const y = fluidPumpForTube(ms, 6);
      if (Math.abs(x.Q - y.Q) < 1e-6 && Math.abs(x.inject - y.inject) < 1e-6) identicalCount++;
    }
    ok('tubes 5 and 6 essentially never agree across 200 samples', identicalCount < total * 0.05);
  }

  // ── fluidPumpPersonality: the per-tube constants stay in sane bands ──────
  {
    let allSane = true;
    for (let k = 0; k < 20; k++) {
      const p = fluidPumpPersonality(k);
      if (!(p.f1 > 0 && p.f2 > p.f1)) allSane = false;
      if (!(p.gulpPeriodS > 0 && p.dutyPeriodS > 0)) allSane = false;
      if (!(p.dutyFraction > 0 && p.dutyFraction < 1)) allSane = false;
    }
    ok('every tube`s personality is internally sane over 20 tubes', allSane);
  }
}
