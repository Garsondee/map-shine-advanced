/**
 * wind-field.test.mjs — the PURE half of the wind field: WindContributor
 * validation, plus `computeWindTurbulence`'s own energy-cap invariant (a
 * numeric TSL stub now exists, `tsl-numeric-stub.mjs` — see its own header for
 * what it does and doesn't prove). `sampleWind` itself still has no fake-node
 * coverage here (same posture as candle-flame-render.test.mjs's own header
 * toward `buildCandleFlameMaterial`): browser-verified live, not unit-tested.
 */
import { validateWindContributor, computeWindTurbulence, curlNoise2D } from '../wind-field.js';
import { TSL_STUB as T, values } from './tsl-numeric-stub.mjs';

function steadyThermal(overrides = {}) {
  return {
    id: 'candle:1',
    kind: 'thermal',
    shape: 'point',
    at: { x: 100, y: 200 },
    radius: 40,
    updraft: 0.2,
    strength: 0.05,
    mode: 'steady',
    ...overrides,
  };
}

export function run(t) {
  const { ok } = t;

  // --- a well-formed steady contributor ------------------------------------
  {
    const r = validateWindContributor(steadyThermal());
    ok('a well-formed steady thermal validates', r.ok && r.errors.length === 0);
  }

  // --- a well-formed one-shot contributor -----------------------------------
  {
    const r = validateWindContributor({
      id: 'door:north-1',
      kind: 'impulse',
      shape: 'segment',
      at: { x: 10, y: 10 },
      radius: 90,
      impulse: { x: 1, y: 0 },
      strength: 1,
      mode: 'oneShot',
      startMs: 1000,
      lifetimeMs: 800,
      easing: 'ease-out',
    });
    ok('a well-formed one-shot door impulse validates', r.ok && r.errors.length === 0);
  }

  // --- a region-shaped contributor: `at` is an opaque ref, not {x,y} --------
  {
    const r = validateWindContributor({
      id: 'vent:great-hall',
      kind: 'vent',
      shape: 'region',
      at: { regionId: 'abc123' },
      radius: 0,
      vector: { x: 0.5, y: 0 },
      strength: 0.2,
      mode: 'steady',
    });
    ok('a region contributor accepts an opaque `at` reference (regions are not deep-validated)', r.ok);
  }

  // --- rejections, one clause at a time -------------------------------------
  ok('not an object → fails', !validateWindContributor(null).ok);
  ok('not an object (a string) → fails', !validateWindContributor('nope').ok);
  ok('missing id → fails', !validateWindContributor(steadyThermal({ id: undefined })).ok);
  ok('empty id → fails', !validateWindContributor(steadyThermal({ id: '' })).ok);
  ok('unknown kind → fails', !validateWindContributor(steadyThermal({ kind: 'gremlin' })).ok);
  ok('unknown shape → fails', !validateWindContributor(steadyThermal({ shape: 'hexagon' })).ok);
  ok('non-finite at.x → fails', !validateWindContributor(steadyThermal({ at: { x: NaN, y: 0 } })).ok);
  ok('a point shape with no at → fails', !validateWindContributor(steadyThermal({ at: undefined })).ok);
  ok('a region shape with no at → fails', !validateWindContributor(steadyThermal({ shape: 'region', at: null })).ok);
  ok('negative radius → fails', !validateWindContributor(steadyThermal({ radius: -1 })).ok);
  ok('non-finite radius → fails', !validateWindContributor(steadyThermal({ radius: NaN })).ok);
  ok('negative strength → fails', !validateWindContributor(steadyThermal({ strength: -0.1 })).ok);
  ok('a malformed optional vector → fails', !validateWindContributor(steadyThermal({ vector: { x: 1 } })).ok);
  ok('a malformed optional impulse → fails', !validateWindContributor(steadyThermal({ impulse: 'north' })).ok);
  ok('a non-finite updraft → fails', !validateWindContributor(steadyThermal({ updraft: 'warm' })).ok);
  ok('a non-finite turbulence → fails', !validateWindContributor(steadyThermal({ turbulence: 'gusty' })).ok);
  ok('unknown mode → fails', !validateWindContributor(steadyThermal({ mode: 'forever' })).ok);
  ok(
    'oneShot missing startMs → fails',
    !validateWindContributor(steadyThermal({ mode: 'oneShot', lifetimeMs: 500 })).ok
  );
  ok('oneShot missing lifetimeMs → fails', !validateWindContributor(steadyThermal({ mode: 'oneShot', startMs: 0 })).ok);
  ok(
    'oneShot with a zero lifetimeMs → fails (must be > 0)',
    !validateWindContributor(steadyThermal({ mode: 'oneShot', startMs: 0, lifetimeMs: 0 })).ok
  );
  ok(
    'a steady contributor does NOT need startMs/lifetimeMs',
    validateWindContributor(steadyThermal({ mode: 'steady' })).ok
  );

  // --- multiple simultaneous errors are all reported, not just the first ---
  {
    const r = validateWindContributor({ id: '', kind: 'nope', shape: 'nope', radius: -1, strength: -1, mode: 'nope' });
    ok('every violated clause is reported, not just the first', r.errors.length >= 5);
  }

  // ==========================================================================
  // computeWindTurbulence — THE ENERGY CAP (2026-07-23, author: "the energy of
  // turbulent wind inside a house is never higher than the actual wind speed
  // outside... at the moment 'calm' or 'light breeze' leads to higher energy
  // values inside the house than outside which doesn't make sense"). The old
  // behaviour (a `CALM_FLOOR` multiplier, never quite zero) is EXACTLY this
  // bug; this asserts the replacement invariant directly rather than trusting
  // a comment.
  // ==========================================================================

  const turbAt = (x, y, tMs, openness, exteriorOpenness, windSpeed01) =>
    computeWindTurbulence(T, {
      centerXY: T.vec2(x, y),
      time: T.float(tMs),
      openness: T.float(openness),
      exteriorOpenness: T.float(exteriorOpenness),
      windSpeed01: T.float(windSpeed01),
    });

  // --- dead calm outside → dead calm EVERYWHERE, indoors included -----------
  {
    // The doorway-transition midpoint is the amplitude constants' own PEAK —
    // exactly where the old floor multiplier produced the reported bug (real
    // motion despite zero outdoor wind). If the cap holds here, it holds.
    const indoorPeak = values(turbAt(120, 340, 5000, 0.6, 0.3, 0));
    ok(
      'windSpeed01=0 at the doorway-transition peak: turbulence is exactly zero',
      indoorPeak[0] === 0 && indoorPeak[1] === 0
    );

    const sealed = values(turbAt(10, 10, 5000, 0.0, 0.0, 0));
    ok('windSpeed01=0, sealed room: turbulence is exactly zero', sealed[0] === 0 && sealed[1] === 0);

    const outdoor = values(turbAt(500, 500, 5000, 1.0, 1.0, 0));
    ok('windSpeed01=0, genuinely outdoors: turbulence is exactly zero', outdoor[0] === 0 && outdoor[1] === 0);
  }

  // --- THE CORE INVARIANT: magnitude never exceeds windSpeed01, at any -----
  // --- position/time/openness combination — swept, not spot-checked ---------
  {
    let worstOverage = 0;
    let checked = 0;
    for (const windSpeed01 of [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0]) {
      for (const openness of [0, 0.3, 0.6, 1.0]) {
        for (const exteriorOpenness of [0, 0.5, 1.0]) {
          for (let sample = 0; sample < 6; sample++) {
            const x = sample * 137.3;
            const y = sample * 91.7;
            const tMs = sample * 733;
            const v = values(turbAt(x, y, tMs, openness, exteriorOpenness, windSpeed01));
            const mag = Math.hypot(v[0], v[1]);
            worstOverage = Math.max(worstOverage, mag - windSpeed01);
            checked++;
          }
        }
      }
    }
    ok(
      `turbulence magnitude never exceeds windSpeed01 across ${checked} samples ` +
        `(worst overage ${worstOverage.toExponential(2)}, incl. the old-bug case: calm/breeze at the doorway peak)`,
      worstOverage < 1e-9
    );
  }

  // --- a light breeze still produces SOME turbulence (the cap doesn't zero --
  // --- out real wind, only wind that isn't actually there) -------------------
  {
    const breeze = values(turbAt(120, 340, 5000, 0.6, 0.3, 0.2));
    ok('a real light breeze still moves the doorway peak (cap is a ceiling, not a mute)', Math.hypot(...breeze) > 1e-6);
    ok('and stays under its own windSpeed01 ceiling', Math.hypot(...breeze) <= 0.2 + 1e-9);
  }

  // --- windSpeed01 omitted → defaults to 1 (full strength, same convention --
  // --- every other optional float in this file uses) — so the cap is 1, not -
  // --- absent; a caller with no wind-speed concept still gets a real ceiling -
  {
    const defaulted = values(
      computeWindTurbulence(T, {
        centerXY: T.vec2(120, 340),
        time: T.float(5000),
        openness: T.float(0.6),
        exteriorOpenness: T.float(0.3),
      })
    );
    ok('windSpeed01 omitted: still produces real motion', Math.hypot(...defaulted) > 1e-6);
    ok(
      'windSpeed01 omitted: capped at the default of 1, same as passing windSpeed01=1',
      Math.hypot(...defaulted) <= 1 + 1e-9
    );
  }

  // ==========================================================================
  // curlNoise2D — DIVERGENCE-FREE, the property BOTH consumers depend on
  // (2026-07-23, extracted so vegetation's "mass preserving" leaf flutter and
  // wind turbulence share one implementation). Divergence-free ⇒ area-
  // preserving ⇒ leaves shuffle without the canopy stretching or changing
  // density; as a FLOW it means turbulence can only redirect energy, never
  // invent or delete it.
  //
  // ⚠ THE INSTRUMENT MUST MATCH THE IMPLEMENTATION. A previous session
  // measured a spurious ~0.5 divergence on a CORRECT field purely because the
  // outer finite-difference step didn't match the curl's own internal `eps`
  // (feedback_instruments_must_not_lie — an instrument that isn't built right
  // lies about working code, not just broken code). `eps` is applied in
  // ALREADY-SCALED noise space, so the matching WORLD step is `eps/spaceFreq`.
  // ==========================================================================
  {
    const SPACE_FREQ = 0.01;
    const EPS = 0.4; // the module's own WIND_TURBULENCE_CURL_EPS default
    const h = EPS / SPACE_FREQ; // noise-space eps expressed back in world px
    const at = (x, y) =>
      values(
        curlNoise2D(T, {
          p: T.vec2(x, y),
          timeSec: T.float(3.25),
          spaceFreq: SPACE_FREQ,
          rate: 0.8,
          phaseX: 17,
          phaseY: -41,
          eps: EPS,
        })
      );

    let worstDiv = 0;
    let checked = 0;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const x = 100 + i * 213.7;
        const y = -80 + j * 167.3;
        // div = dVx/dx + dVy/dy, central differences at the matched step.
        const dVxdx = (at(x + h, y)[0] - at(x - h, y)[0]) / (2 * h);
        const dVydy = (at(x, y + h)[1] - at(x, y - h)[1]) / (2 * h);
        worstDiv = Math.max(worstDiv, Math.abs(dVxdx + dVydy));
        checked++;
      }
    }
    // EXACT, not approximate: with the step matched to the curl's own eps the
    // cancellation is algebraic (the same psi samples appear with opposite
    // signs), so this is ~machine epsilon, not "small enough".
    ok(
      `curlNoise2D is divergence-free at all ${checked} probes (worst |div| ${worstDiv.toExponential(2)})`,
      worstDiv < 1e-12
    );

    // It must still be a REAL field, not a constant that trivially satisfies
    // the above — the check that makes the divergence assertion meaningful.
    const a = at(500, 500);
    const b = at(1500, 900);
    ok(
      'curlNoise2D produces non-zero, position-varying output',
      Math.hypot(...a) > 1e-6 && Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6
    );

    // Determinism + decorrelation: the same inputs repeat exactly; a different
    // phase gives a genuinely different swirl (not the same field shifted).
    ok('curlNoise2D is deterministic', at(700, 300)[0] === at(700, 300)[0]);
    const phased = values(
      curlNoise2D(T, {
        p: T.vec2(700, 300),
        timeSec: T.float(3.25),
        spaceFreq: SPACE_FREQ,
        rate: 0.8,
        phaseX: 901,
        phaseY: 55,
        eps: EPS,
      })
    );
    const base = at(700, 300);
    ok('a different phase decorrelates the octave', Math.hypot(phased[0] - base[0], phased[1] - base[1]) > 1e-6);
  }
}
