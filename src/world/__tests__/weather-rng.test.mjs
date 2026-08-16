/**
 * THE ALMANAC'S DICE (docs/planning/Weather-Manager.md §5.4).
 *
 * What is proven here:
 *   - determinism: same seed -> identical sequence, always;
 *   - the snapshot/restore pair genuinely clones (the forecast's whole basis);
 *   - triangular() actually concentrates around its mode, not just its bounds;
 *   - weightedPick() respects weight ratios and fails open (null, never throw)
 *     when there is nowhere to go.
 */
import { hashSeed, createRng, fromState, triangular, weightedPick } from '../weather-rng.js';

export function run(t) {
  // ---- hashSeed ----------------------------------------------------------------
  {
    t.ok('hashSeed is deterministic', hashSeed('temperate-coast', 3) === hashSeed('temperate-coast', 3));
    t.ok('different inputs usually hash differently', hashSeed('a') !== hashSeed('b'));
    t.ok('returns a 32-bit unsigned int', hashSeed('x') >= 0 && hashSeed('x') <= 0xffffffff);
    t.ok('order matters (concatenation, not commutative)', hashSeed('ab', 1) !== hashSeed('a', 'b1'));
  }

  // ---- ⭐ determinism: the whole reason this module exists ----------------------
  {
    const a = createRng('scene-42');
    const b = createRng('scene-42');
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    t.ok(
      'same seed produces the IDENTICAL sequence, every draw',
      seqA.every((v, i) => v === seqB[i])
    );

    const c = createRng('scene-43');
    const seqC = Array.from({ length: 50 }, () => c.next());
    t.ok(
      'a different seed produces a genuinely different sequence',
      seqC.some((v, i) => v !== seqA[i])
    );

    // A finite number is used AS the raw state, not re-hashed — so its initial
    // getState() is the seed itself, verbatim, which is what makes a numeric
    // seed like `sceneSeed + epochIndex` predictable rather than one more layer
    // of hashing to reason about.
    t.ok('a finite numeric seed is used directly as the initial state', createRng(12345).getState() === 12345);
    t.ok('a string seed goes through hashSeed, landing elsewhere', createRng('12345').getState() === hashSeed('12345'));
  }

  // ---- output range + basic quality ---------------------------------------------
  {
    const rng = createRng('range-check');
    const draws = Array.from({ length: 2000 }, () => rng.next());
    t.ok(
      'every draw is in [0,1)',
      draws.every((v) => v >= 0 && v < 1)
    );
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    t.ok(`2000 draws average near 0.5 (got ${mean.toFixed(3)}) — not degenerate`, mean > 0.4 && mean < 0.6);
    t.ok(
      'not every draw is identical (a stuck generator would still pass the range check)',
      new Set(draws).size > 1000
    );
  }

  // ---- ⭐ snapshot/restore: the forecast's entire mechanism ----------------------
  {
    const live = createRng('forecast-basis');
    live.next();
    live.next();
    const snap = live.getState();

    const clone = fromState(snap);
    const liveNext = [live.next(), live.next(), live.next()];
    const cloneNext = [clone.next(), clone.next(), clone.next()];
    t.ok(
      'a clone from a snapshot draws the SAME future the original would have',
      liveNext.every((v, i) => v === cloneNext[i])
    );

    // The forecast's actual promise: advancing the clone must NOT advance the
    // live generator. If this fails, "the forecast is free" is a lie.
    const liveStateAfter = live.getState();
    const clone2 = fromState(snap);
    clone2.next();
    clone2.next();
    clone2.next();
    clone2.next();
    clone2.next();
    t.ok('running a clone forward does not move the live generator', live.getState() === liveStateAfter);
  }

  // ---- triangular ---------------------------------------------------------------
  {
    const rng = createRng('dwell-shape');
    const draws = Array.from({ length: 5000 }, () => triangular(rng, 2, 4, 12));
    t.ok(
      'every draw is within [min, max]',
      draws.every((v) => v >= 2 && v <= 12)
    );

    // ⭐ THE SHAPE, not just the bounds — a triangular(2,4,12) distribution
    // should cluster near 4, not spread uniformly across the whole range. If
    // this collapsed to a uniform sample, every dwell would be as likely to be
    // near the max as near the mode, and biomes would feel randomised rather
    // than characterful.
    const near = draws.filter((v) => v >= 3 && v <= 5).length / draws.length;
    const far = draws.filter((v) => v >= 9 && v <= 11).length / draws.length;
    t.ok(
      `density concentrates near the mode (near-mode ${(near * 100).toFixed(1)}% vs far-from-mode ${(far * 100).toFixed(1)}%)`,
      near > far * 2
    );

    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    const expectedMean = (2 + 4 + 12) / 3; // the analytic mean of a triangular dist
    t.ok(
      `sample mean (${mean.toFixed(2)}) matches the analytic mean (${expectedMean.toFixed(2)})`,
      Math.abs(mean - expectedMean) < 0.3
    );

    t.ok('min === max degenerates to a fixed value, not NaN', triangular(rng, 5, 5, 5) === 5);
    t.ok('a mode outside [min,max] is clamped, not NaN', Number.isFinite(triangular(rng, 0, 999, 10)));
    t.ok('a garbage min falls back to 0 rather than throwing', Number.isFinite(triangular(rng, NaN, 2, 10)));
  }

  // ---- weightedPick ---------------------------------------------------------------
  {
    const rng = createRng('pick-check');
    t.ok('empty list -> null, not a throw', weightedPick(rng, [], () => 1) === null);
    t.ok('all-zero weights -> null', weightedPick(rng, ['a', 'b'], () => 0) === null);
    t.ok('negative weights are treated as zero, not negative mass', weightedPick(rng, ['a'], () => -5) === null);
    t.ok('a single positive-weight item always wins', weightedPick(rng, ['only'], () => 1) === 'only');

    // ⭐ Ratios, not just "picks something valid" — a 100:1 weight split
    // should land on the heavy item the overwhelming majority of the time.
    const counts = { heavy: 0, light: 0 };
    const items = [
      { id: 'heavy', w: 100 },
      { id: 'light', w: 1 },
    ];
    for (let i = 0; i < 2000; i++) {
      const pick = weightedPick(rng, items, (it) => it.w);
      counts[pick.id]++;
    }
    t.ok(`a 100:1 weight ratio lands heavy >=95% of the time (got ${counts.heavy}/2000)`, counts.heavy >= 1900);
    t.ok('the light item is still reachable at all', counts.light > 0);

    // Zero-weight items in a mixed list are excluded, not crashed on.
    const mixed = [
      { id: 'never', w: 0 },
      { id: 'always', w: 1 },
    ];
    const picks = Array.from({ length: 50 }, () => weightedPick(rng, mixed, (it) => it.w).id);
    t.ok('a zero-weight item is never picked from a mixed list', !picks.includes('never'));
  }
}
