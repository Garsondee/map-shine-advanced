/**
 * fire-billow-bloom.test.mjs — THE FLAME COUNTERS THE SCENE'S BLOOM.
 *
 * Measured in the real viewer (2026-10-20): the default bloom turned the painted cream (0.99, 0.73, 0.16) into (3.2, 2.1, 0.3)
 * in `scene.lit`, so every flame came out flat acid yellow; a flat (0.5, 0.25, 0.1) patch came out at exactly 2.25x with the
 * bloom on and exactly itself with it off. The fix paints the inverse. These tests pin the maths of that inverse against the
 * bloom's own formulas (bloom-render.js), so a change to either side is caught here and not on someone's screen, and hold the
 * shader's nine-step bisection to the converged answer.
 */
import {
  FILL_RADIUS_PX,
  BLOOM_SOLVE_STEPS,
  bloomContribution,
  bloomCounterParams,
  bloomCounterUniforms,
  bloomGain,
  inverseBloomScale,
  regionFill,
} from '../fire-billow-bloom.js';

// the schema defaults of effects/bloom.js (the author's live-tuned ones)
const DEFAULTS = {
  threshold: 0.33,
  knee: 0.5,
  strength: 1,
  coreStrength: 1.01,
  coreTint: '#ffffff',
  atmoStrength: 0.24,
  atmoTint: '#fff0dc',
};

export function run(t) {
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
  const c = bloomCounterParams({ enabled: true, params: DEFAULTS });

  // ── THE BRIGHT PASS, LINE FOR LINE ───────────────────────────────────────────────────────────────────────────
  t.ok(
    'nothing dark blooms (a max channel well under the knee keeps next to nothing)',
    bloomContribution(0.05, 0.33, 0.5) < 0.001
  );
  t.ok(
    'a mid colour blooms a little (the soft knee, a hand-worked value: br 0.5 keeps 0.34)',
    near(bloomContribution(0.5, 0.33, 0.5), 0.34, 5e-3)
  );
  t.ok(
    'a bright colour blooms most of itself (br 1.0 keeps 1 - 0.33/1 = 0.67)',
    near(bloomContribution(1.0, 0.33, 0.5), 0.67, 1e-6)
  );
  t.ok(
    'the share kept only ever rises with brightness',
    (() => {
      let prev = -1;
      for (let br = 0; br <= 4; br += 0.05) {
        const v = bloomContribution(br, 0.33, 0.5);
        if (v < prev - 1e-9) return false;
        prev = v;
      }
      return true;
    })()
  );
  t.ok(
    'the knee is continuous (no jump where it hands over to the linear part)',
    (() => {
      const kneeW = 0.33 * 0.5;
      const a = bloomContribution(0.33 + kneeW - 1e-6, 0.33, 0.5);
      const b = bloomContribution(0.33 + kneeW + 1e-6, 0.33, 0.5);
      return Math.abs(a - b) < 1e-4;
    })()
  );

  // ── THE LIVE BLOOM, REDUCED ────────────────────────────────────────────────────────────────────────────────
  t.ok(
    'a bloom that is off has nothing to counter',
    bloomCounterParams(null) === null && bloomCounterParams({ enabled: false, params: DEFAULTS }) === null
  );
  t.ok(
    'a bloom with no strength has nothing to counter',
    bloomCounterParams({ enabled: true, params: { ...DEFAULTS, strength: 0 } }) === null
  );
  t.ok(
    'at the author’s defaults the broad-region gain constant is 3 x (1.01 + 0.24 x tint) = about 3.7 (the measured 2.25x at br 0.5)',
    near(c.K, 3 * (1.01 + 0.24 * ((255 + 240 + 220) / (3 * 255))), 1e-9) && near(bloomGain(0.5, c, 1), 2.25, 0.05)
  );
  t.ok('the threshold and the knee ride along', c.threshold === 0.33 && c.knee === 0.5);
  t.ok(
    'a missing parameter falls back to the viewer’s own defaults (threshold 1, strength 1, core 1, atmosphere 0.5)',
    (() => {
      const d = bloomCounterParams({ enabled: true, params: {} });
      return d.threshold === 1 && near(d.K, 3 * (1 + 0.5 * ((255 + 240 + 220) / (3 * 255))), 1e-9);
    })()
  );
  t.ok(
    'the master strength scales K',
    near(bloomCounterParams({ enabled: true, params: { ...DEFAULTS, strength: 2 } }).K, 2 * c.K, 1e-9)
  );
  t.ok(
    'garbage never poisons it',
    (() => {
      const d = bloomCounterParams({
        enabled: true,
        params: { threshold: 'x', strength: NaN, coreStrength: null, atmoStrength: undefined, knee: 9 },
      });
      return d && Number.isFinite(d.K) && Number.isFinite(d.threshold) && d.knee <= 1;
    })()
  );

  // ── HOW MUCH OF THE BLOOM A FLAME-SIZED REGION GETS ────────────────────────────────────────────────────────────
  t.ok('a speck gets none and a hall gets all of it', regionFill(0) === 0 && regionFill(1e6) > 0.999);
  t.ok('half of it at the fitted radius', near(regionFill(FILL_RADIUS_PX), 0.5, 1e-9));
  t.ok(
    'the fill only ever grows with the flame’s on-screen size',
    (() => {
      let prev = -1;
      for (let r = 0; r < 600; r += 5) {
        const v = regionFill(r);
        if (v < prev) return false;
        prev = v;
      }
      return true;
    })()
  );
  t.ok('a bad radius is a speck', regionFill(NaN) === 0 && regionFill(-5) === 0);

  // ── THE INVERSE: s * T, once bloomed, is T ─────────────────────────────────────────────────────────────────────
  t.ok(
    'with no bloom the scale is exactly 1',
    inverseBloomScale(0.9, null) === 1 && inverseBloomScale(0, c) === 1 && inverseBloomScale(0.9, c, 0) === 1
  );
  {
    let worst = 0;
    for (const fill of [0.1, 0.3, 0.5, 0.8, 1]) {
      for (let br = 0.05; br <= 3.5; br += 0.05) {
        const s = inverseBloomScale(br, c, fill);
        const back = s * bloomGain(s * br, c, fill);
        worst = Math.max(worst, Math.abs(back - 1));
      }
    }
    t.ok(
      `painting s x T and letting the bloom add its share gives T back (worst error ${worst.toExponential(1)})`,
      worst < 1e-6
    );
  }
  t.ok(
    'the brighter the wanted colour the more it is darkened (cream needs ~0.47, a dim red hardly any)',
    inverseBloomScale(1.0, c, 1) < inverseBloomScale(0.6, c, 1) &&
      inverseBloomScale(0.6, c, 1) < inverseBloomScale(0.2, c, 1) &&
      inverseBloomScale(1.0, c, 1) < 0.5 &&
      inverseBloomScale(0.2, c, 1) > 0.9
  );
  t.ok(
    'a hand-worked value: the brightest cream (max channel 1) in a hall is painted at about 0.47',
    near(inverseBloomScale(1, c, 1), 0.47, 0.01)
  );
  t.ok(
    'a small flame is darkened less than a big one',
    inverseBloomScale(1.0, c, 0.2) > inverseBloomScale(1.0, c, 0.9)
  );
  t.ok(
    'the scale is never above 1 and never below 0',
    (() => {
      for (let br = 0; br < 10; br += 0.1) {
        const s = inverseBloomScale(br, c, 1);
        if (!(s > 0 && s <= 1)) return false;
      }
      return true;
    })()
  );
  t.ok(
    'a stronger bloom darkens the flame more',
    inverseBloomScale(1, bloomCounterParams({ enabled: true, params: { ...DEFAULTS, strength: 2 } }), 1) <
      inverseBloomScale(1, c, 1)
  );

  // ── THE SHADER'S ALGORITHM: nine bisection steps, returning the upper end ───────────────────────────────────────
  t.ok('the shader unrolls nine steps', BLOOM_SOLVE_STEPS === 9);
  {
    let worst = 0;
    for (const fill of [0.05, 0.2, 0.5, 0.9, 1]) {
      for (let br = 0.02; br <= 4; br += 0.04) {
        const shader = inverseBloomScale(br, c, fill, BLOOM_SOLVE_STEPS);
        const exact = inverseBloomScale(br, c, fill);
        worst = Math.max(worst, Math.abs(shader - exact));
      }
    }
    t.ok(
      `nine steps land within 2^-9 of the converged scale, and never below it (worst ${worst.toExponential(1)})`,
      worst <= 1 / 512 + 1e-9
    );
    t.ok(
      'and with a bloom of 0 the shader’s scale is exactly 1 (it returns the upper end, which never moves)',
      inverseBloomScale(0.8, { threshold: 0.33, knee: 0.5, K: 0 }, 1, BLOOM_SOLVE_STEPS) === 1
    );
  }

  // ── WHAT THE RENDERER'S UNIFORMS ARE SET TO ────────────────────────────────────────────────────────────────────
  t.ok(
    'no bloom is K 0 with the author’s dial out of the way',
    (() => {
      const u = bloomCounterUniforms(null, 1);
      return u.k === 0 && u.mix === 0;
    })()
  );
  t.ok(
    'a live bloom carries its K, threshold and knee, and the dial',
    (() => {
      const u = bloomCounterUniforms(c, 0.5);
      return u.k === c.K && u.threshold === 0.33 && u.knee === 0.5 && u.mix === 0.5;
    })()
  );
  t.ok(
    'the dial is clamped and a bad one falls back to all of it',
    bloomCounterUniforms(c, 7).mix === 1 &&
      bloomCounterUniforms(c, -2).mix === 0 &&
      bloomCounterUniforms(c, NaN).mix === 1
  );
}
