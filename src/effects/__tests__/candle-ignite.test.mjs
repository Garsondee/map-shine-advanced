/**
 * candle-ignite.test.mjs — the day/night dice-roll math, pinned against the
 * author's own stated boundary conditions (2026-08-06 clarification):
 * "Reliability scales the odds down" — 100% Reliability applies the
 * configured Day/Night % exactly; 0% Reliability never lights a candle.
 */
import { stableUnit01, shouldAutoIgnite } from '../candle-ignite.js';

export function run(t) {
  const { ok } = t;

  // --- stableUnit01: deterministic, in range, and not a constant ----------
  {
    const a = stableUnit01('authored:abc123');
    const b = stableUnit01('authored:abc123');
    const c = stableUnit01('authored:xyz789');
    ok('same id always returns the same roll', a === b);
    ok('roll is in [0,1)', a >= 0 && a < 1 && c >= 0 && c < 1);
    ok('different ids (almost always) roll differently', a !== c);
    ok('empty/undefined id does not throw and stays in range', stableUnit01(undefined) >= 0);
  }

  // --- shouldAutoIgnite: the two literal edge cases from the author's ask -
  {
    // 100% Reliability => the configured Day/Night % applies EXACTLY, so a
    // roll just under the day chance (25%) ignites, and one just over does not.
    ok(
      'day, 100% reliability, roll just under 25% => lit',
      shouldAutoIgnite({ isDay: true, dayChancePct: 25, nightChancePct: 85, reliabilityPct: 100, roll01: 0.24 })
    );
    ok(
      'day, 100% reliability, roll just over 25% => unlit',
      !shouldAutoIgnite({ isDay: true, dayChancePct: 25, nightChancePct: 85, reliabilityPct: 100, roll01: 0.26 })
    );
    ok(
      'night, 100% reliability, roll just under 85% => lit',
      shouldAutoIgnite({ isDay: false, dayChancePct: 25, nightChancePct: 85, reliabilityPct: 100, roll01: 0.84 })
    );
    ok(
      'night, 100% reliability, roll just over 85% => unlit',
      !shouldAutoIgnite({ isDay: false, dayChancePct: 25, nightChancePct: 85, reliabilityPct: 100, roll01: 0.86 })
    );

    // 0% Reliability => NEVER lit, day or night, no matter how low the roll.
    ok(
      'day, 0% reliability, roll 0 => still unlit',
      !shouldAutoIgnite({ isDay: true, dayChancePct: 100, nightChancePct: 100, reliabilityPct: 0, roll01: 0 })
    );
    ok(
      'night, 0% reliability, roll 0 => still unlit',
      !shouldAutoIgnite({ isDay: false, dayChancePct: 100, nightChancePct: 100, reliabilityPct: 0, roll01: 0 })
    );

    // 50% reliability halves the effective chance.
    ok(
      'day, 50% reliability halves a 40% day chance to 20% — a 0.30 roll misses it',
      !shouldAutoIgnite({ isDay: true, dayChancePct: 40, nightChancePct: 0, reliabilityPct: 50, roll01: 0.3 })
    );
    ok(
      'day, 50% reliability halves a 40% day chance to 20% — a 0.10 roll clears it',
      shouldAutoIgnite({ isDay: true, dayChancePct: 40, nightChancePct: 0, reliabilityPct: 50, roll01: 0.1 })
    );

    // Out-of-range/non-finite inputs degrade to their nearer bound rather than throwing or going negative.
    ok(
      'out-of-range percentages clamp instead of throwing',
      shouldAutoIgnite({ isDay: true, dayChancePct: 500, nightChancePct: -20, reliabilityPct: 200, roll01: 0.5 }) ===
        true
    );
    ok(
      'non-finite percentages degrade to 0, never NaN-compares true',
      shouldAutoIgnite({ isDay: true, dayChancePct: NaN, nightChancePct: 85, reliabilityPct: 100, roll01: 0 }) === false
    );
  }
}
