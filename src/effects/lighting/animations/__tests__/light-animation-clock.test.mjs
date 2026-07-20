/**
 * Node verification for effects/lighting/animations/light-animation-clock.js
 * — the pure CPU drivers (`computeAnimationTime`, `SmoothNoise`,
 * `computeFlickerUniforms`, `computePulseUniforms`). All four are pure
 * functions/classes, so every formula is asserted exactly against Foundry's
 * own source (base-light-source.mjs), not just "runs without throwing".
 */
import {
  computeAnimationTime,
  SmoothNoise,
  computeFlickerUniforms,
  computePulseUniforms,
} from '../light-animation-clock.js';

export function run(t) {
  const { ok, throws } = t;

  // ---- computeAnimationTime — Foundry's animateTime, verbatim -------------
  ok(
    'time = (speed * tMs) / 5000 + seed, the base case',
    computeAnimationTime({ speedRaw: 5, reverse: false, tMs: 10000, seed: 0 }) === (5 * 10000) / 5000 + 0
  );
  ok(
    'seed offsets time directly (desyncs identical lights)',
    computeAnimationTime({ speedRaw: 5, reverse: false, tMs: 0, seed: 42 }) === 42
  );
  ok(
    'reverse negates tMs before the formula, not the whole result',
    computeAnimationTime({ speedRaw: 5, reverse: true, tMs: 10000, seed: 0 }) === (5 * -10000) / 5000 + 0
  );
  ok(
    'speed 0 holds time at exactly the seed (frozen animation)',
    computeAnimationTime({ speedRaw: 0, reverse: false, tMs: 99999, seed: 7 }) === 7
  );

  // ---- SmoothNoise — construction validation -------------------------------
  throws('non-power-of-2 maxReferences throws', () => new SmoothNoise({ maxReferences: 100 }));
  throws('zero maxReferences throws', () => new SmoothNoise({ maxReferences: 0 }));
  throws('negative maxReferences throws', () => new SmoothNoise({ maxReferences: -8 }));
  throws('non-integer maxReferences throws', () => new SmoothNoise({ maxReferences: 2.5 }));
  ok(
    "power-of-2 maxReferences (2048, torch's own value) does not throw",
    (() => {
      new SmoothNoise({ maxReferences: 2048 });
      return true;
    })()
  );
  throws('zero amplitude throws', () => new SmoothNoise({ amplitude: 0, maxReferences: 4 }));
  throws('non-finite amplitude throws', () => new SmoothNoise({ amplitude: NaN, maxReferences: 4 }));
  throws('non-positive scale throws', () => new SmoothNoise({ scale: 0, maxReferences: 4 }));
  throws('negative scale throws', () => new SmoothNoise({ scale: -1, maxReferences: 4 }));

  // ---- SmoothNoise — deterministic generate() via an injected constant RNG.
  // Every table reference becomes the SAME value, so mixing two identical
  // values returns that value regardless of x/scale — a fully predictable
  // case that still exercises the real interpolation code path. -------------
  {
    const noise = new SmoothNoise({ amplitude: 2, scale: 3, maxReferences: 2 }, () => 0.5);
    ok('a constant-reference table generates amplitude * 0.5 at x=0', noise.generate(0) === 1);
    ok(
      'a constant-reference table generates amplitude * 0.5 at any x (table has no variation)',
      noise.generate(123.456) === 1
    );
    noise.amplitude = 4;
    ok('changing amplitude changes future output', noise.generate(0) === 2);
  }
  {
    // A two-value table lets us assert the smoothstep interpolation exactly.
    // references = [0, 1] (index 0 and 1, maxReferences=2). At x=0: xFloor=0,
    // t=0, tSmooth=0, i0=0&1=0, i1=1&1=1 -> y = ref[0] + (ref[1]-ref[0])*0 = 0.
    // At x=0.5 (scale=1): xFloor=0, t=0.5, tSmooth=0.5^2*(3-1)=0.5 -> y=0.5.
    let i = 0;
    const table = [0, 1];
    const noise = new SmoothNoise({ amplitude: 1, scale: 1, maxReferences: 2 }, () => table[i++]);
    ok('generate(0) returns exactly the first table reference', noise.generate(0) === 0);
    ok('generate(0.5) returns the cubic-smoothstep midpoint (0.5, by symmetry)', noise.generate(0.5) === 0.5);
  }

  // ---- computeFlickerUniforms — Foundry's animateFlickering, verbatim -----
  // `amplification` is explicit (default 1, matching animateFlickering's own
  // JS default) — see this function's own header for why: flame calls the
  // primitive directly (amplification stays 1 regardless of intensity),
  // while torch/siren's animateTorch wrapper passes intensity/5. This test
  // suite exercises the PRIMITIVE; the intensity/5 wrapping is the
  // registry's own `flickerAmplification` field, tested in registry.test.mjs
  // once torch.js registers it.
  {
    // Constant-reference noise (see above) makes n fully predictable:
    // n = 0.5 * amplitude = 0.5 * (1 * 0.45) at the default amplification.
    const noise = new SmoothNoise({ amplitude: 1, scale: 3, maxReferences: 2 }, () => 0.5);
    const result = computeFlickerUniforms({ time: 0, ratio: 0.6, noise });
    const expectedN = 0.5 * (1 * 0.45); // default amplification=1, amplitude=0.45, n=0.225
    ok('brightnessPulse = 0.55 + n', Math.abs(result.brightnessPulse - (0.55 + expectedN)) < 1e-12);
    ok('ratio = ratio*0.9 + n*0.222', Math.abs(result.ratio - (0.6 * 0.9 + expectedN * 0.222)) < 1e-12);
  }
  {
    // Explicit amplification (torch/siren's intensity/5 wrapping, computed
    // by the CALLER per this function's own header) — higher amplification
    // widens the noise range.
    const noiseLow = new SmoothNoise({ amplitude: 1, scale: 3, maxReferences: 2 }, () => 0.5);
    const low = computeFlickerUniforms({ time: 0, amplification: 1 / 5, ratio: 0.5, noise: noiseLow });
    const noiseHigh = new SmoothNoise({ amplitude: 1, scale: 3, maxReferences: 2 }, () => 0.5);
    const high = computeFlickerUniforms({ time: 0, amplification: 10 / 5, ratio: 0.5, noise: noiseHigh });
    ok(
      'higher amplification produces a bigger brightnessPulse swing (bigger noise amplitude)',
      high.brightnessPulse - 0.55 > low.brightnessPulse - 0.55
    );
  }
  ok(
    "brightnessPulse mutates the SAME noise instance's amplitude in place (reused across frames, never recreated)",
    (() => {
      const noise = new SmoothNoise({ amplitude: 1, scale: 3, maxReferences: 2 }, () => 0.5);
      computeFlickerUniforms({ time: 0, amplification: 1, ratio: 0.5, noise });
      return noise.amplitude === 1 * 0.45;
    })()
  );
  ok(
    "flame's fixed amplification=1 default requires no explicit param (matches animateFlickering's own JS default, not torch's intensity/5 wrapper)",
    (() => {
      const noise = new SmoothNoise({ amplitude: 1, scale: 3, maxReferences: 2 }, () => 0.5);
      computeFlickerUniforms({ time: 0, ratio: 0.5, noise }); // no amplification passed
      return noise.amplitude === 1 * 0.45;
    })()
  );

  // ---- computePulseUniforms — Foundry's animatePulse, verbatim ------------
  {
    // time=0 -> cos(0)=1 -> w=1 -> wave(a,b,1) = a (the "peak" side).
    const atZero = computePulseUniforms({ time: 0, intensityRaw: 5, ratio: 0.6 });
    ok('at time=0 (w=1), pulse reads its peak value (1.2)', Math.abs(atZero.pulse - 1.2) < 1e-12);
    ok('at time=0 (w=1), ratio reads its own unmodified value', Math.abs(atZero.ratio - 0.6) < 1e-12);
  }
  {
    // time*2.5 = PI -> cos(PI)=-1 -> w=0 -> wave(a,b,0) = b (the "trough" side).
    const atTrough = computePulseUniforms({ time: Math.PI / 2.5, intensityRaw: 5, ratio: 0.6 });
    const i = (10 - 5) * 0.1; // 0.5
    ok('at the trough (w=0), pulse reads i = (10-intensity)*0.1', Math.abs(atTrough.pulse - i) < 1e-9);
    ok('at the trough (w=0), ratio reads ratio*i', Math.abs(atTrough.ratio - 0.6 * i) < 1e-9);
  }
  ok(
    'intensityRaw=10 makes i=0, so the trough touches zero brightness/ratio',
    (() => {
      const r = computePulseUniforms({ time: Math.PI / 2.5, intensityRaw: 10, ratio: 0.6 });
      return Math.abs(r.pulse) < 1e-9 && Math.abs(r.ratio) < 1e-9;
    })()
  );
}
