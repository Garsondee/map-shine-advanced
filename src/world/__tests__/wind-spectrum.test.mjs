/**
 * wind-spectrum.test.mjs — does the wind field actually have a spectrum?
 * (mythica-machina-press#497 Stage 2 / #499.)
 *
 * ⚠️ THIS SUITE MEASURES THE FIELD, IT DOES NOT RE-STATE ITS CONSTRUCTION.
 * Asserting "the gain constant equals 2^(−1/3)" would only prove the source
 * says what the source says. These tests sample the REAL graph through the
 * numeric TSL stub and then measure the resulting signal — its energy slope,
 * the spread of its peak heights, the spread of its peak spacings, and how
 * fast it decorrelates in time — because those four ARE the author's reported
 * symptoms, stated as numbers:
 *
 *   *"the distance between gusts is always the same"*   → peak-spacing spread
 *   *"the amplitude of waves is identical"*             → peak-height spread
 *   a breeze and a gale being the same field at two volumes → decorrelation
 *
 * A two-octave field passes none of these; that is the point.
 */
import { computeWindTurbulence } from '../wind-field.js';
import { TSL_STUB as T, values } from './tsl-numeric-stub.mjs';

/** Sample the turbulence field's x-component along a straight line. */
function sampleLine({ count, stepPx, timeMs = 5000, speed01 = 0.6, y = 0 }) {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const v = computeWindTurbulence(T, {
      centerXY: T.vec2(i * stepPx, y),
      time: T.float(timeMs),
      openness: T.float(1),
      exteriorOpenness: T.float(1),
      windSpeed01: T.float(speed01),
      // No advection for the SPATIAL tests — advection only slides the pattern,
      // and holding it still keeps the spectrum measurement about the stack
      // itself rather than about where the stack happened to be at t.
      octaves: 4,
    });
    out[i] = values(v)[0];
  }
  return out;
}

/** Power at each wavenumber index, via a plain DFT (N is small; clarity wins). */
function powerSpectrum(signal) {
  const N = signal.length;
  const mean = signal.reduce((s, v) => s + v, 0) / N;
  const power = new Float64Array(Math.floor(N / 2));
  for (let k = 1; k < power.length; k++) {
    let re = 0;
    let im = 0;
    for (let nIdx = 0; nIdx < N; nIdx++) {
      const ang = (-2 * Math.PI * k * nIdx) / N;
      const s = signal[nIdx] - mean;
      re += s * Math.cos(ang);
      im += s * Math.sin(ang);
    }
    power[k] = (re * re + im * im) / (N * N);
  }
  return power;
}

/** Least-squares slope of log(power) against log(k), over an index band. */
function logLogSlope(power, kLo, kHi) {
  const xs = [];
  const ys = [];
  for (let k = kLo; k <= kHi; k++) {
    if (power[k] <= 0) continue;
    xs.push(Math.log(k));
    ys.push(Math.log(power[k]));
  }
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return num / den;
}

/** Local maxima of |signal|, as {index, height}. */
function peaks(signal) {
  const out = [];
  for (let i = 1; i < signal.length - 1; i++) {
    const a = Math.abs(signal[i - 1]);
    const b = Math.abs(signal[i]);
    const c = Math.abs(signal[i + 1]);
    if (b > a && b >= c) out.push({ index: i, height: b });
  }
  return out;
}

function spread(list) {
  if (list.length < 2) return 0;
  const mean = list.reduce((s, v) => s + v, 0) / list.length;
  if (mean === 0) return 0;
  const variance = list.reduce((s, v) => s + (v - mean) ** 2, 0) / list.length;
  return Math.sqrt(variance) / mean; // coefficient of variation
}

export function run(t) {
  const { ok } = t;

  // ---- ⭐ THE ENERGY SLOPE --------------------------------------------------
  // The stack spans 32 m down to 4 m (base length / lacunarity^3). Sampled at
  // 32 px steps over 512 points, that band sits comfortably inside the
  // resolvable wavenumbers and well away from both the DC end and Nyquist.
  {
    const signal = sampleLine({ count: 512, stepPx: 32 });
    const power = powerSpectrum(signal);
    const slope = logLogSlope(power, 4, 48);
    // Kolmogorov is −5/3 ≈ −1.67. A four-octave stack over a short band, built
    // from curl noise rather than real Navier-Stokes, cannot land exactly
    // there — so the assertion is that the field is genuinely BROADBAND with a
    // decaying spectrum in the right neighbourhood, not that it reproduces
    // turbulence theory. White noise would read ~0; a single octave would read
    // far steeper outside its own band.
    ok(
      `⭐ the field has a decaying broadband spectrum (measured log-log slope ${slope.toFixed(2)}, Kolmogorov is -1.67)`,
      slope < -0.8 && slope > -3.2
    );
  }

  // ---- ⭐ GUSTS DIFFER FROM ONE ANOTHER ------------------------------------
  // The two reported symptoms, as numbers. A single-frequency thresholded
  // envelope produces near-identical peaks at near-identical spacing, so both
  // coefficients of variation would collapse toward 0.
  {
    const signal = sampleLine({ count: 512, stepPx: 32 });
    const found = peaks(signal);
    ok('the line contains many local peaks to compare', found.length > 20);

    const heightSpread = spread(found.map((p) => p.height));
    ok(
      `⭐ gust STRENGTHS genuinely vary (height spread ${heightSpread.toFixed(2)}) — "the amplitude of waves is identical"`,
      heightSpread > 0.35
    );

    const gaps = [];
    for (let i = 1; i < found.length; i++) gaps.push(found[i].index - found[i - 1].index);
    const gapSpread = spread(gaps);
    ok(
      `⭐ gust SPACINGS genuinely vary (gap spread ${gapSpread.toFixed(2)}) — "the distance between gusts is always the same"`,
      gapSpread > 0.35
    );
  }

  // ---- ⭐ THE STACK IS WHY, not the tuning ---------------------------------
  // The before/after, as an assertion. Two octaves is two rhythms: across the
  // same line it produces a handful of gust events, because there is almost
  // nothing there to vary. Measured at the time of writing: 2 octaves → 7
  // peaks, 4 octaves → 37. If someone later "simplifies" the stack back down,
  // this fails rather than quietly returning the original complaint.
  {
    const countPeaks = (octaves) => {
      const out = [];
      for (let i = 0; i < 512; i++) {
        const v = computeWindTurbulence(T, {
          centerXY: T.vec2(i * 32, 0),
          time: T.float(5000),
          openness: T.float(1),
          exteriorOpenness: T.float(1),
          windSpeed01: T.float(0.6),
          octaves,
        });
        out.push(values(v)[0]);
      }
      return peaks(out).length;
    };
    const two = countPeaks(2);
    const four = countPeaks(4);
    ok(`⭐ the full stack produces far more gust structure than two octaves (${two} peaks -> ${four})`, four > two * 3);
  }

  // ---- ⭐ A BREEZE AND A GALE ARE NOT THE SAME FIELD AT TWO VOLUMES ---------
  // Taylor's hypothesis: the pattern sweeps past at the wind speed, so a fixed
  // point decorrelates faster at higher speed — a gust's duration is its own
  // size divided by U. Before this stage the travel speed was a hand-tuned
  // constant with a `mix(0.4, 1, speed)` ramp, so the two ends of the dial
  // moved far more alike than they should.
  {
    const at = (speed01, timeMs) => {
      const v = computeWindTurbulence(T, {
        centerXY: T.vec2(1000, 1000),
        time: T.float(timeMs),
        openness: T.float(1),
        exteriorOpenness: T.float(1),
        windSpeed01: T.float(speed01),
        directionDeg: T.float(90),
        octaves: 4,
      });
      return values(v)[0];
    };
    // Normalised change over the same half-second, so this compares SHAPE
    // change rather than amplitude (a gale is bigger as well as faster, and
    // only the faster part is the claim being made here).
    const drift = (speed01) => {
      const a = at(speed01, 10000);
      const b = at(speed01, 10500);
      const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
      return Math.abs(b - a) / scale;
    };
    const breeze = drift(0.15);
    const gale = drift(0.75);
    ok(
      `⭐ a gale's field sweeps past faster than a breeze's (${breeze.toFixed(3)} vs ${gale.toFixed(3)} per half-second)`,
      gale > breeze
    );
  }

  // ---- turbulence intensity is a multiplier, not a clamp --------------------
  {
    const rms = (speed01) => {
      let sum = 0;
      const n = 64;
      for (let i = 0; i < n; i++) {
        const v = computeWindTurbulence(T, {
          centerXY: T.vec2(i * 137, 500),
          time: T.float(3000),
          openness: T.float(1),
          exteriorOpenness: T.float(1),
          windSpeed01: T.float(speed01),
          octaves: 4,
        });
        const c = values(v);
        sum += c[0] * c[0] + c[1] * c[1];
      }
      return Math.sqrt(sum / n);
    };
    ok('at speed01=0 the turbulence is exactly zero', rms(0) === 0);
    // σ = I·U is LINEAR in U. The old energy cap clipped above roughly half
    // dial, so doubling the speed there changed almost nothing — which is a
    // large part of why the top of the dial all looked alike.
    const half = rms(0.4);
    const full = rms(0.8);
    ok(
      `⭐ turbulence scales linearly with wind speed, not clipped (${half.toFixed(3)} -> ${full.toFixed(3)})`,
      Math.abs(full / half - 2) < 0.05
    );
  }
}
