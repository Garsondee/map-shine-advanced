/**
 * wind-advection.test.mjs — the wind's INTEGRATED advection (2026-10-27).
 *
 * The author faded 0 → 100% wind and rain over Fade Time 1m: *"wind thrashes
 * vegetation to insane amounts very quickly, the rain darkening of the window
 * effect goes berserk, it becomes a strobing nightmare."* Every travelling wind
 * pattern was placed at `x − U·t`; with `U` moving and `t` an hour of seconds,
 * the patterns moved at `t · dU/dt` — white noise. These tests replay that fade
 * through the numeric TSL stub (`tsl-numeric-stub.mjs` — its header says what it
 * does and does not prove: AGREEMENT and CONTINUITY are meaningful, absolute
 * values are not) and pin three things:
 *
 *   1. at a CONSTANT wind the integrated placement is the old one (no look moved);
 *   2. DURING a fade, frame-to-frame change stays small — and the old placement,
 *      replayed the same way, is shown to be the strobe it was;
 *   3. the pieces around it: the integrator, the clamp, the uniform copier and
 *      the perceptual fade space.
 */
import {
  computeGustEnvelope,
  computeWindTurbulence,
  stepWindAdvection,
  createWindAdvectionState,
  writeWindAdvectionUniforms,
  windAdvectionDtSecNode,
  windGustPhaseRate,
  WIND_ADVECTION_LOOKBACK_MAX_S,
  WIND_ADVECTION_LEAD_MAX_S,
  WIND_ADVECTION_STEP_MAX_S,
} from '../wind-field.js';
import { windFlowVector } from '../wind-bake.js';
import { windPerceived01ForSpeed01, speed01ForWindPerceived01, windStrength01ForSpeed01 } from '../wind-scale.js';
import { TSL_STUB as T, values } from './tsl-numeric-stub.mjs';

const PPM = 65.6;
const DIR = 90; // blowing east
const FRAME_S = 1 / 60;

/** The state as the node bag the shaders read. */
const asNodes = (s) => ({
  clockMs: T.float(s.clockMs),
  speedFlowSec: T.vec2(s.speedFlowSec[0], s.speedFlowSec[1]),
  strengthFlowSec: T.vec2(s.strengthFlowSec[0], s.strengthFlowSec[1]),
  flowSec: T.vec2(s.flowSec[0], s.flowSec[1]),
  strengthSec: T.float(s.strengthSec),
  gustPhase: T.float(s.gustPhase),
});

const gustAt = (x, y, tMs, speed01, advection) =>
  values(
    computeGustEnvelope(T, {
      centerXY: T.vec2(x, y),
      time: T.float(tMs),
      directionDeg: T.float(DIR),
      gustiness01: T.float(1),
      speed01: T.float(speed01),
      pixelsPerMetre: T.float(PPM),
      advection,
    })
  )[0];

const turbAt = (x, y, tMs, speed01, advection) =>
  values(
    computeWindTurbulence(T, {
      centerXY: T.vec2(x, y),
      time: T.float(tMs),
      directionDeg: T.float(DIR),
      windSpeed01: T.float(speed01),
      advectSpeed01: T.float(speed01),
      pixelsPerMetre: T.float(PPM),
      octaves: 2,
      advection,
    })
  );

/** Sample points spread across a map, so a lull at one point cannot hide a strobe. */
const POINTS = Array.from({ length: 40 }, (_, i) => [173 + i * 211, 97 + ((i * 389) % 3100)]);

/**
 * Replay a fade: integrate frame by frame from `startS`, ramping speed `from`→`to`
 * over `overS`, and measure the MEAN frame-to-frame change of `sample` across
 * the middle half of the fade — once with the integrated advection, once with
 * the old `speed × t` placement.
 */
function replayFade({ startS, overS, from, to, sample, magnitude }) {
  let state = { ...createWindAdvectionState(), clockMs: startS * 1000 };
  // Pre-roll an hour of calm-to-`from` so the integrals hold real history.
  state.gustPhase = windGustPhaseRate(from) * startS;
  const f = windFlowVector(DIR);
  state.speedFlowSec = [f.x * from * startS, f.y * from * startS];
  const frames = Math.round(overS / FRAME_S);
  let prevNew = null;
  let prevOld = null;
  let sumNew = 0;
  let sumOld = 0;
  let n = 0;
  for (let k = 1; k <= frames; k++) {
    const tMs = (startS + k * FRAME_S) * 1000;
    const speed = from + (to - from) * (k / frames);
    state = stepWindAdvection(state, { tMs, dtSec: FRAME_S, speed01: speed, directionDeg: DIR });
    const inMiddle = k > frames * 0.25 && k < frames * 0.75 && k % 6 === 0;
    const needPrev = k > frames * 0.25 - 1 && k < frames * 0.75 && (k % 6 === 0 || (k + 1) % 6 === 0);
    if (!needPrev) continue;
    const adv = asNodes(state);
    const now = POINTS.map(([x, y]) => sample(x, y, tMs, speed, adv));
    const old = POINTS.map(([x, y]) => sample(x, y, tMs, speed, undefined));
    if (inMiddle && prevNew && prevOld) {
      for (let i = 0; i < POINTS.length; i++) {
        sumNew += magnitude(now[i], prevNew[i]);
        sumOld += magnitude(old[i], prevOld[i]);
        n++;
      }
    }
    prevNew = now;
    prevOld = old;
  }
  return { meanNew: sumNew / n, meanOld: sumOld / n };
}

export function run(t) {
  const { ok } = t;
  const near = (a, b, eps) => Math.abs(a - b) <= eps;

  // ── 1. CONSTANT WIND: the integrated placement IS the old one ─────────────
  {
    const speed = 0.3;
    const tS = 600;
    let state = createWindAdvectionState();
    const steps = Math.round(tS / FRAME_S);
    for (let k = 1; k <= steps; k++) {
      state = stepWindAdvection(state, { tMs: k * FRAME_S * 1000, dtSec: FRAME_S, speed01: speed, directionDeg: DIR });
    }
    const adv = asNodes(state);
    const tMs = state.clockMs;
    let worstGust = 0;
    let worstTurb = 0;
    for (const [x, y] of POINTS) {
      worstGust = Math.max(worstGust, Math.abs(gustAt(x, y, tMs, speed, adv) - gustAt(x, y, tMs, speed, undefined)));
      const a = turbAt(x, y, tMs, speed, adv);
      const b = turbAt(x, y, tMs, speed, undefined);
      worstTurb = Math.max(worstTurb, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    ok(
      `constant wind: gust envelope unchanged by integration (worst Δ ${worstGust.toExponential(1)})`,
      worstGust < 1e-6
    );
    ok(`constant wind: turbulence unchanged by integration (worst Δ ${worstTurb.toExponential(1)})`, worstTurb < 1e-6);
  }

  // ── 2. THE REPORTED FADE: 0 → 100% over 60 s, an hour into the session ────
  {
    const gust = replayFade({
      startS: 3600,
      overS: 60,
      from: 0,
      to: 1,
      sample: gustAt,
      magnitude: (a, b) => Math.abs(a - b),
    });
    ok(
      `fade: the OLD gust placement strobes (mean per-frame Δ ${gust.meanOld.toFixed(3)}) — the bug, reproduced`,
      gust.meanOld > 0.05
    );
    ok(
      `fade: the integrated gust envelope stays smooth (mean per-frame Δ ${gust.meanNew.toFixed(4)})`,
      gust.meanNew < 0.02 && gust.meanNew < gust.meanOld / 5
    );

    const turb = replayFade({
      startS: 3600,
      overS: 60,
      from: 0,
      to: 1,
      sample: turbAt,
      magnitude: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
    });
    ok(
      `fade: integrated turbulence changes far less per frame than the old placement (${turb.meanNew.toExponential(1)} vs ${turb.meanOld.toExponential(1)})`,
      turb.meanNew < turb.meanOld / 5
    );
  }

  // ── 3. THE INTEGRATOR ─────────────────────────────────────────────────────
  {
    let s = createWindAdvectionState();
    s = stepWindAdvection(s, { tMs: 1000, dtSec: 0.5, speed01: 0.4, directionDeg: 0 }); // clamped to STEP_MAX
    const f = windFlowVector(0);
    ok(
      'a stalled frame advances at most WIND_ADVECTION_STEP_MAX_S',
      near(s.flowSec[1], f.y * WIND_ADVECTION_STEP_MAX_S, 1e-12) &&
        near(s.gustPhase, windGustPhaseRate(0.4) * WIND_ADVECTION_STEP_MAX_S, 1e-12)
    );
    ok(
      'strength integrates the Beaufort strength, not the dial',
      near(s.strengthSec, windStrength01ForSpeed01(0.4) * WIND_ADVECTION_STEP_MAX_S, 1e-12)
    );
    const back = stepWindAdvection(s, { tMs: 2000, dtSec: -1, speed01: 1, directionDeg: 0 });
    ok('a negative dt never runs the pattern backwards', back.gustPhase === s.gustPhase && back.clockMs === 2000);
    ok('dead calm: the gust phase holds still', windGustPhaseRate(0) === 0);
    ok(
      'the gust phase rate rises with the wind and stays bounded (≤ 70 m/s ÷ 60 m)',
      windGustPhaseRate(0.2) < windGustPhaseRate(1) && windGustPhaseRate(1) <= 70 / 60 + 1e-9
    );
  }

  // ── 4. THE CLAMP: a consumer on another clock is a bounded constant off ───
  {
    const adv = { clockMs: T.float(100000) };
    const at = (ms) => values(windAdvectionDtSecNode(T, T.float(ms), adv))[0];
    ok('same time → 0 s', at(100000) === 0);
    ok('a candle look-back 8 s ago → −8 s', near(at(92000), -8, 1e-9));
    ok('a far-behind clock clamps to the look-back limit', at(0) === -WIND_ADVECTION_LOOKBACK_MAX_S);
    ok('a far-ahead clock clamps to the lead limit', at(1e7) === WIND_ADVECTION_LEAD_MAX_S);
  }

  // ── 5. THE COPIER (renderers copy the ambient into their own uniforms) ────
  {
    const f = () => ({ value: 0 });
    const v = () => ({
      value: {
        x: 0,
        y: 0,
        set(x, y) {
          this.x = x;
          this.y = y;
        },
      },
    });
    const dst = {
      clockMs: f(),
      speedFlowSec: v(),
      strengthFlowSec: v(),
      flowSec: v(),
      strengthSec: f(),
      gustPhase: f(),
    };
    const src = { ...createWindAdvectionState(), clockMs: 5, speedFlowSec: [1, 2], gustPhase: 3, strengthSec: 4 };
    writeWindAdvectionUniforms(dst, src);
    ok(
      'copies a plain state into uniforms',
      dst.clockMs.value === 5 &&
        dst.speedFlowSec.value.x === 1 &&
        dst.speedFlowSec.value.y === 2 &&
        dst.gustPhase.value === 3
    );
    const dst2 = {
      clockMs: f(),
      speedFlowSec: v(),
      strengthFlowSec: v(),
      flowSec: v(),
      strengthSec: f(),
      gustPhase: f(),
    };
    writeWindAdvectionUniforms(dst2, dst);
    ok(
      'copies one uniform bag into another',
      dst2.clockMs.value === 5 && dst2.speedFlowSec.value.y === 2 && dst2.strengthSec.value === 4
    );
    writeWindAdvectionUniforms(dst2, undefined);
    ok('a missing source leaves the uniforms as they were', dst2.gustPhase.value === 3);
  }

  // ── 6. THE PERCEPTUAL FADE SPACE ──────────────────────────────────────────
  {
    let worst = 0;
    for (let i = 0; i <= 20; i++) {
      const s = i / 20;
      worst = Math.max(worst, Math.abs(speed01ForWindPerceived01(windPerceived01ForSpeed01(s)) - s));
    }
    ok('perceived ↔ dial round-trips across the whole dial', worst < 1e-12);
    ok(
      'perceived space reaches the ends exactly',
      windPerceived01ForSpeed01(0) === 0 && windPerceived01ForSpeed01(1) === 1
    );
    // Linear in the perceived space ⇒ the LOOK (Beaufort strength) rises in a
    // near-straight line below hurricane force, instead of front-loading.
    const strengthAtFraction = (p) => windStrength01ForSpeed01(speed01ForWindPerceived01(p));
    const linearDialAt10 = windStrength01ForSpeed01(0.1);
    ok(
      `10% into a 0→100% fade the look is gentler than a dial-linear fade (${strengthAtFraction(0.1).toFixed(2)} vs ${linearDialAt10.toFixed(2)})`,
      strengthAtFraction(0.1) < linearDialAt10 * 0.6
    );
    ok(
      'below hurricane the look rises ~linearly with fade progress',
      near(strengthAtFraction(0.4) / strengthAtFraction(0.2), 2, 0.05)
    );
  }
}
