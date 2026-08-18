import { moonPhaseAt, PHASE_NAMES } from '../moon.js';

const LUNA = { synodicDays: 29.530588, phaseAnchorSeconds: 0 };

export function run(t) {
  t.ok('PHASE_NAMES has exactly the 8 standard names', PHASE_NAMES.length === 8);

  {
    const at = moonPhaseAt(0, LUNA);
    t.ok('at the anchor, phase01 is exactly 0', at.phase01 === 0);
    t.ok('at the anchor, phaseName is New Moon', at.phaseName === 'New Moon');
    t.ok('at the anchor, ageDays is 0', at.ageDays === 0);
  }

  {
    const halfway = moonPhaseAt((LUNA.synodicDays / 2) * 86400, LUNA);
    t.ok('at half the synodic period, phase01 is ~0.5', Math.abs(halfway.phase01 - 0.5) < 1e-9);
    t.ok('at half the synodic period, phaseName is Full Moon', halfway.phaseName === 'Full Moon');
  }

  {
    // A FULL cycle later must land back at New — the whole point of a
    // periodic projection over an accumulator.
    const fullCycle = moonPhaseAt(LUNA.synodicDays * 86400 * 3, LUNA);
    t.ok('three full cycles later, phase01 wraps back to ~0', fullCycle.phase01 < 1e-9 || fullCycle.phase01 > 1 - 1e-9);
  }

  {
    // BEFORE the anchor — must not go negative or throw. This is the exact
    // shape of bug JS's signed `%` produces if the wrap is forgotten.
    const before = moonPhaseAt(-3600, LUNA);
    t.ok('worldTime before the anchor still yields phase01 in [0,1)', before.phase01 >= 0 && before.phase01 < 1);
    t.ok(
      'worldTime before the anchor is CLOSE to New from the far side (waning crescent)',
      before.phaseName === 'Waning Crescent' || before.phaseName === 'New Moon'
    );
  }

  {
    // Monotonic within one cycle: sampling forward in time should never
    // decrease phase01 until it wraps.
    let prev = 0;
    let monotonic = true;
    for (let days = 0; days < LUNA.synodicDays; days += 1) {
      const { phase01 } = moonPhaseAt(days * 86400, LUNA);
      if (phase01 < prev) monotonic = false;
      prev = phase01;
    }
    t.ok('phase01 is monotonically non-decreasing across one full cycle', monotonic);
  }

  {
    // A non-zero anchor shifts the whole projection but stays periodic —
    // proves the anchor is genuinely just a phase offset, not a special case.
    const shifted = { synodicDays: 10, phaseAnchorSeconds: 5 * 86400 };
    const atAnchor = moonPhaseAt(5 * 86400, shifted);
    const oneCycleLater = moonPhaseAt(15 * 86400, shifted);
    t.ok('a non-zero anchor is exactly New at itself', atAnchor.phase01 === 0);
    t.ok('a non-zero anchor is exactly New one cycle later too', oneCycleLater.phase01 === 0);
  }

  {
    // Different clients, same worldTime → identical result. This IS the
    // whole design point (Law 1: no accumulator, no per-client drift).
    const a = moonPhaseAt(123456789, LUNA);
    const b = moonPhaseAt(123456789, LUNA);
    t.ok(
      'the same worldTime always yields the identical phase (pure, no hidden state)',
      JSON.stringify(a) === JSON.stringify(b)
    );
  }
}
