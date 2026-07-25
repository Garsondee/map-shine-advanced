/**
 * Node verification for effects/lighting/animations/light-animation-clock.js
 * — GPU-ONLY REWRITE (2026-07-20): the module's real logic now lives in TSL
 * node graphs (`buildAnimationTimeNode`/`buildFlickerNode`/
 * `buildFlickerRatioNode`/`buildPulseNode`), built and executed entirely on
 * the GPU — genuinely untestable in Node without a browser/WebGPU context,
 * matching this project's own "GPU/TSL material-building code is browser-
 * only" convention (verified live via the debug panel).
 *
 * What CAN still be verified in Node is that each formula is wired up
 * correctly — same arithmetic shape as Foundry's own CPU source
 * (base-light-source.mjs), asserted via a minimal NUMERIC stand-in for
 * THREE.TSL: a thin wrapper around plain JS numbers exposing exactly the
 * chainable methods (`.mul`/`.add`/`.sub`/`.div`/`.negate`) and free
 * functions (`float`/`cos`/`vec2`) each builder actually calls. This is not
 * a GPU-shader test — it exercises the SAME formula with real numbers
 * standing in for TSL nodes, catching an arithmetic/wiring mistake without
 * needing a browser.
 */
import {
  buildAnimationTimeNode,
  buildFlickerNode,
  buildFlickerRatioNode,
  buildPulseNode,
} from '../light-animation-clock.js';

// ---- a minimal numeric stand-in for THREE.TSL ------------------------------
class N {
  constructor(v) {
    this.v = v;
  }
  mul(o) {
    return new N(this.v * val(o));
  }
  add(o) {
    return new N(this.v + val(o));
  }
  sub(o) {
    return new N(this.v - val(o));
  }
  div(o) {
    return new N(this.v / val(o));
  }
  negate() {
    return new N(-this.v);
  }
}
function val(o) {
  return o instanceof N ? o.v : o;
}
const float = (x) => new N(x);
const cos = (n) => new N(Math.cos(val(n)));
const vec2 = (a, b) => ({ x: val(a), y: val(b) });
// The flicker formula's own noise call — fixed at a known value so the
// SURROUNDING arithmetic (amplitude scaling, the 0.55 offset, the
// ratio-jitter weighting) is what gets asserted, not a real Perlin lattice.
// mx_noise_float is the EXPORTED Perlin node the real code destructures (NOT
// mx_perlin_noise_float, which the vendored build keeps internal-only — see
// light-animation-clock.js#buildFlickerNode). The stub name must match the
// source's destructure or the test would silently pass on a dead reference.
const mx_noise_float = () => new N(0);
const TSL = { float, cos, vec2, mx_noise_float };

export function run(t) {
  const { ok } = t;

  // ---- buildAnimationTimeNode — Foundry's animateTime, verbatim -----------
  ok(
    'time = speed*reverseSign*globalTimeMs/5000 + seed, the base case',
    val(
      buildAnimationTimeNode(TSL, {
        uSpeedRaw: float(5),
        uReverseSign: float(1),
        uSeed: float(0),
        uGlobalTimeMs: float(10000),
      })
    ) ===
      (5 * 1 * 10000) / 5000 + 0
  );
  ok(
    'seed offsets time directly (desyncs identical lights)',
    val(
      buildAnimationTimeNode(TSL, {
        uSpeedRaw: float(5),
        uReverseSign: float(1),
        uSeed: float(42),
        uGlobalTimeMs: float(0),
      })
    ) === 42
  );
  ok(
    'reverseSign=-1 negates the globalTimeMs term, not the whole result',
    val(
      buildAnimationTimeNode(TSL, {
        uSpeedRaw: float(5),
        uReverseSign: float(-1),
        uSeed: float(0),
        uGlobalTimeMs: float(10000),
      })
    ) ===
      (5 * -1 * 10000) / 5000 + 0
  );
  ok(
    'speed 0 holds time at exactly the seed (frozen animation)',
    val(
      buildAnimationTimeNode(TSL, {
        uSpeedRaw: float(0),
        uReverseSign: float(1),
        uSeed: float(7),
        uGlobalTimeMs: float(99999),
      })
    ) === 7
  );

  // ---- buildFlickerRatioNode — ratio = baseRatio*0.9 + n*0.222 ------------
  {
    const ratio = buildFlickerRatioNode(TSL, float(0.6), float(0.5));
    ok('flicker ratio-jitter formula', Math.abs(val(ratio) - (0.6 * 0.9 + 0.5 * 0.222)) < 1e-12);
  }

  // ---- buildFlickerNode — Foundry's animateFlickering, verbatim -----------
  // mx_noise_float is fixed at 0 above, so raw=0 -> n = (0+1)*0.5*amplitude = 0.5*amplitude.
  {
    const { n, brightnessPulse } = buildFlickerNode(TSL, { time: float(0), amplification: float(1) });
    const expectedN = 0.5 * (1 * 0.45); // amplitude = amplification*0.45
    ok('n = 0.5 * amplitude at the fixed-noise stand-in', Math.abs(val(n) - expectedN) < 1e-12);
    ok('brightnessPulse = 0.55 + n', Math.abs(val(brightnessPulse) - (0.55 + expectedN)) < 1e-12);
  }
  {
    // torch/siren's own amplification = intensity/5 wrapping — higher
    // amplification must widen the brightnessPulse swing.
    const low = buildFlickerNode(TSL, { time: float(0), amplification: float(1 / 5) });
    const high = buildFlickerNode(TSL, { time: float(0), amplification: float(10 / 5) });
    ok(
      'higher amplification produces a bigger brightnessPulse swing',
      val(high.brightnessPulse) - 0.55 > val(low.brightnessPulse) - 0.55
    );
  }
  ok(
    "flame's fixed amplification=float(1) needs no intensity-derived scaling — matches animateFlickering's own default, not torch's intensity/5 wrapper",
    (() => {
      const { n } = buildFlickerNode(TSL, { time: float(0), amplification: float(1) });
      return Math.abs(val(n) - 0.5 * (1 * 0.45)) < 1e-12;
    })()
  );

  // ---- buildPulseNode — Foundry's animatePulse, verbatim -------------------
  {
    // time=0 -> cos(0)=1 -> w=1 -> wave(a,b,1) = a (the "peak" side).
    const { pulse, ratio } = buildPulseNode(TSL, { time: float(0), uIntensityRaw: float(5), baseRatio: float(0.6) });
    ok('at time=0 (w=1), pulse reads its peak value (1.2)', Math.abs(val(pulse) - 1.2) < 1e-12);
    ok('at time=0 (w=1), ratio reads its own unmodified baseRatio', Math.abs(val(ratio) - 0.6) < 1e-12);
  }
  {
    // time*2.5 = PI -> cos(PI)=-1 -> w=0 -> wave(a,b,0) = b (the "trough" side).
    const { pulse, ratio } = buildPulseNode(TSL, {
      time: float(Math.PI / 2.5),
      uIntensityRaw: float(5),
      baseRatio: float(0.6),
    });
    const i = (10 - 5) * 0.1; // 0.5
    ok('at the trough (w=0), pulse reads i = (10-intensity)*0.1', Math.abs(val(pulse) - i) < 1e-9);
    ok('at the trough (w=0), ratio reads baseRatio*i', Math.abs(val(ratio) - 0.6 * i) < 1e-9);
  }
  ok(
    'intensityRaw=10 makes i=0, so the trough touches zero pulse/ratio',
    (() => {
      const { pulse, ratio } = buildPulseNode(TSL, {
        time: float(Math.PI / 2.5),
        uIntensityRaw: float(10),
        baseRatio: float(0.6),
      });
      return Math.abs(val(pulse)) < 1e-9 && Math.abs(val(ratio)) < 1e-9;
    })()
  );
}
