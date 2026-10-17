/**
 * THE NUMBERS THE ANIMATION RESTS ON, held to each other in Node.
 *
 * The bodies are TSL graphs that only a GPU can evaluate, but what makes them LOOK right is a
 * handful of constants that have to agree with one another — and a constant that drifts out of
 * step with its partner produces an animation that is subtly wrong, not an error. Each section
 * below states one such agreement and checks it:
 *
 *   • a fly's legs can always reach where the gait asks them to put a foot (the two-bone solver has
 *     no solution otherwise, and the knee goes to NaN);
 *   • the body advances exactly as far per gait cycle as a planted foot travels (or the feet skate);
 *   • the maggot's profile has a radius for every point of its spine;
 *   • the firefly colony's synchrony dial means what the author is told it means.
 */
import { FLY_GEOMETRY } from '../fly-body.js';
import { FLY_BRAIN } from '../fly-brain.js';
import { WING_FLIGHT, WING_FOLDED, WING_SPREAD, WING_FLARE, WING_BEAT_AMP } from '../fly-pose.js';
import { MAGGOT_GEOMETRY } from '../maggot-body.js';
import { FIREFLY_SYNC } from '../firefly-brain.js';
import { activeSlotCount } from '../critter-activity.js';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function run(t) {
  const { HIP, REST_FOOT, SEGMENTS, STRIDE_AMPLITUDE, STANCE_DUTY, WING_HINGE, WING_LENGTH, WING_WIDTH } = FLY_GEOMETRY;

  // ── LEGS: every foot the gait can ask for is reachable by a two-bone limb ──
  for (let kind = 0; kind < 3; kind++) {
    const [l1, l2] = SEGMENTS[kind];
    const hip = [HIP[kind][0], HIP[kind][1]];
    const label = ['front', 'middle', 'hind'][kind];
    // The solver clamps the far end to l1 + l2 − 0.006 and has no solution inside |l1 − l2|; the
    // swing foot lifts 0.035 and the whole stride runs ±amp, so check the worst of each.
    const amp = STRIDE_AMPLITUDE[kind];
    let nearest = Infinity;
    let farthest = 0;
    for (const dx of [-amp, 0, amp]) {
      for (const dy of [0, 0.035]) {
        const foot = [REST_FOOT[kind][0] + dx, REST_FOOT[kind][1] - dy];
        const d = dist(hip, foot);
        nearest = Math.min(nearest, d);
        farthest = Math.max(farthest, d);
      }
    }
    t.ok(
      `${label} leg: the farthest stride position (${farthest.toFixed(3)}) is within reach (${(l1 + l2).toFixed(3)})`,
      farthest < l1 + l2 - 0.006
    );
    t.ok(
      `${label} leg: the nearest stride position (${nearest.toFixed(3)}) is beyond the fold-up limit (${Math.abs(l1 - l2).toFixed(3)})`,
      nearest > Math.abs(l1 - l2) + 0.02
    );
    // the legs splay outward from a hip that is on the body, never through the other side
    t.ok(
      `${label} leg: the foot rests outside its hip (a leg on the body's left stays on the left)`,
      REST_FOOT[kind][1] > HIP[kind][1]
    );
  }
  t.ok(
    'the three legs of a tripod step through the same duty cycle (stance fraction is in (0.5, 1))',
    STANCE_DUTY > 0.5 && STANCE_DUTY < 1
  );
  t.ok(
    'with a duty above one half, the two tripods overlap in stance (the fly is never airborne mid-stride)',
    2 * STANCE_DUTY - 1 > 0
  );

  // ── PLANTED FEET: the body advances as far per gait cycle as a stance foot travels ──
  // A foot in stance moves +amp → −amp (2·amp) over `duty` of a cycle, and the ground does not move,
  // so the body advances 2·amp/duty per cycle. The brain integrates the gait phase by distance at
  // STRIDE_LENGTHS per cycle; if the two disagree the feet slide.
  const planted = (2 * STRIDE_AMPLITUDE[1]) / STANCE_DUTY;
  t.ok(
    `the brain's stride (${FLY_BRAIN.STRIDE_LENGTHS}) matches the middle legs' (${planted.toFixed(4)}) — the feet are planted`,
    Math.abs(FLY_BRAIN.STRIDE_LENGTHS - planted) / planted < 0.01
  );
  for (const kind of [0, 2]) {
    const own = (2 * STRIDE_AMPLITUDE[kind]) / STANCE_DUTY;
    t.ok(
      `${['front', 'hind'][kind / 2]} legs slide by under a fifth of their own stride (${((Math.abs(own - FLY_BRAIN.STRIDE_LENGTHS) / own) * 100).toFixed(0)}%) — their stride differs on purpose`,
      Math.abs(own - FLY_BRAIN.STRIDE_LENGTHS) / own < 0.2
    );
  }

  // ── WINGS: the whole wing, at every pose, fits inside the quad the renderer draws ──
  // Tip position for an angle ψ measured from the backward axis, rotating outward.
  const QUAD_HALF = 0.95; // fly-render.js
  const tip = (psi) => [WING_HINGE[0] - WING_LENGTH * Math.cos(psi), WING_HINGE[1] + WING_LENGTH * Math.sin(psi)];
  for (const [name, psi] of [
    ['folded', WING_FOLDED],
    ['flight', WING_FLIGHT + WING_BEAT_AMP],
    ['take-off spread', WING_SPREAD],
    ['landing flare', WING_FLARE],
    ['flare at the top of a beat', WING_FLARE + 0.2],
  ]) {
    const [x, y] = tip(psi);
    t.ok(
      `wing tip stays inside the quad when ${name} (${x.toFixed(2)}, ${y.toFixed(2)})`,
      Math.abs(x) < QUAD_HALF && Math.abs(y) < QUAD_HALF
    );
  }
  t.ok('a wing is longer than it is wide (a blade, not a disc)', WING_LENGTH > 2.5 * WING_WIDTH);
  t.ok(
    'the flare is the widest angle and the folded wing the narrowest',
    WING_FLARE > WING_SPREAD && WING_SPREAD > WING_FLIGHT && WING_FLIGHT > WING_FOLDED
  );

  // ── MAGGOT: a radius for every point of the spine, fattest in the middle, never fatter than the quad allows ──
  const { segments, rMax, profile } = MAGGOT_GEOMETRY;
  t.ok('the radius profile has one entry per spine point', profile.length === segments + 1);
  t.ok('the profile peaks at exactly 1 (so R_MAX is the true half-width)', Math.max(...profile) === 1);
  t.ok(
    'the snout is much narrower than the body, the tail blunt (not a point)',
    profile[0] < 0.3 && profile.at(-1) > 0.6
  );
  t.ok(
    'the fattest point is in the middle third of the body',
    (() => {
      const at = profile.indexOf(Math.max(...profile)) / segments;
      return at > 0.3 && at < 0.7;
    })()
  );
  t.ok(
    `a maggot is a few times as long as it is wide (${(1 / (2 * rMax)).toFixed(1)}:1)`,
    1 / (2 * rMax) > 3.5 && 1 / (2 * rMax) < 7
  );

  // ── FIREFLIES: what the synchrony dial means, on the oscillator the kernel runs ──
  // dφ/dt = 1/T_i + (K·s²/2π)·sin(2π(Φ − φ)), with T_i = T·(0.85 + 0.3·u) and Φ the colony clock.
  // Run it as the kernel does, in float32-ish steps, and measure the Kuramoto order parameter.
  const order = (synchrony) => {
    const N = 120;
    const T = 3.6;
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const phase = Array.from({ length: N }, rnd);
    const rate = Array.from(
      { length: N },
      () => 1 / (T * (FIREFLY_SYNC.PERIOD_MIN + FIREFLY_SYNC.PERIOD_SPAN * rnd()))
    );
    let colony = 0;
    const dt = 1 / 30;
    const gain = (synchrony * synchrony * FIREFLY_SYNC.COUPLING) / (2 * Math.PI);
    let sumR = 0;
    let count = 0;
    for (let step = 0; step < 30 * 120; step++) {
      colony = (colony + dt / T) % 1;
      for (let i = 0; i < N; i++) {
        phase[i] = (((phase[i] + dt * (rate[i] + gain * Math.sin(2 * Math.PI * (colony - phase[i])))) % 1) + 1) % 1;
      }
      if (step > 30 * 60) {
        let c = 0;
        let s = 0;
        for (let i = 0; i < N; i++) {
          c += Math.cos(2 * Math.PI * phase[i]);
          s += Math.sin(2 * Math.PI * phase[i]);
        }
        sumR += Math.hypot(c, s) / N;
        count++;
      }
    }
    return sumR / count;
  };
  const r0 = order(0);
  const r25 = order(0.25);
  const r50 = order(0.5);
  const r100 = order(1);
  t.ok(`synchrony 0: strangers (order ${r0.toFixed(2)} — a finite colony is never exactly 0)`, r0 < 0.35);
  t.ok(`synchrony 0.25: patchy (${r25.toFixed(2)}), above strangers, well short of unison`, r25 > r0 && r25 < 0.6);
  t.ok(`synchrony 0.5: mostly locked (${r50.toFixed(2)})`, r50 > r25 && r50 > 0.55);
  t.ok(`synchrony 1: unison (${r100.toFixed(2)})`, r100 > 0.95);
  t.ok('the dial is monotonic from strangers to unison', r0 < r25 && r25 < r50 && r50 < r100);

  // ── the head-count law the sky drives ──
  t.ok('activeSlotCount ramps by fractions, so one firefly fades in at a time', activeSlotCount(0.37, 100) === 37);
  t.ok('…and clamps to the population', activeSlotCount(2, 100) === 100 && activeSlotCount(-1, 100) === 0);
}
