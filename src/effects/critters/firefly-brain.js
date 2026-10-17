/**
 * FIREFLY BRAIN — a firefly's decisions, as a branch-free GPU kernel fragment.
 *
 * Same contract as `fly-brain.js` (the runtime hands over a slot, takes back its
 * next state), a different temperament: a firefly is a lazy, looping flier that
 * stays over its colony's paint, now and then settles on the ground, and above all
 * KEEPS TIME. Its light is the thing the player sees, so the most important state
 * a firefly carries is not where it is but WHERE IT IS IN ITS FLASH.
 *
 *   phase    ordinal 0 FLY · 1 LAND · 2 REST · 3 LIFT; the fraction is the progress
 *            of a landing or a lift-off
 *   custom   (heading, height, flash phase 0..1, aux = height a landing started at)
 *   life     unused (hazards are per-frame probabilities, nothing counts down)
 *
 * ============================================================================
 * THE FLASH CLOCK — A PHASE OSCILLATOR, WEAKLY PULLED TOWARD THE COLONY
 * ============================================================================
 *
 * Every firefly is a little oscillator: its flash phase φ advances by 1/period
 * cycles per second, its own period a few percent off the author's. Left alone a
 * colony drifts out of step and twinkles at random — which is what a colony of
 * independent fireflies looks like. Some real species (Pteroptyx, in Southeast
 * Asia) instead converge to a single beat, each insect nudging its phase when it
 * sees a neighbour flash: the Kuramoto model of coupled oscillators,
 *
 *     dφ/dt = 1/T + (K/2π) · sin(2π(Φ − φ))        Φ = the coupling target
 *
 * A GPU agent cannot see its neighbours (that would be a neighbour query this
 * kernel does not have), so Φ is a COLONY CLOCK the CPU supplies (`colonyPhase`),
 * a mean field every insect is coupled to. The mathematics of locking then does the
 * rest: a firefly whose own rate is within K/2π of the colony's LOCKS to it, the
 * rest drift past. `synchrony` is K, so 0 is a colony of strangers, 1 is a colony
 * in unison, and the 0.25 between is the interesting regime — a few locked
 * patches and a drifting remainder, which is exactly how partial synchrony looks.
 *
 * ============================================================================
 * THE FLIGHT: A LOOPING WANDER, NOT A RANDOM WALK
 * ============================================================================
 *
 * A firefly's heading turns at a rate that is a sum of two slow sines with
 * unrelated periods (and per-insect phases). Integrating a smooth, never-quite-
 * repeating turn rate gives the slow looping arcs real fireflies fly, with none of
 * the angular jitter a per-frame random heading produces. The edge of the colony
 * is handled the way a fly's is — a soft inward steer starting half a roaming range
 * out and a hard bounce at the range — so they drift OVER the paint and a little
 * beyond it, and never leave.
 *
 * @module effects/critters/firefly-brain
 */
import { wrapAngle, safeAtan2 } from './critter-sdf.js';

const TAU = Math.PI * 2;
const PH_FLY = 0;
const PH_LAND = 1;
const PH_REST = 2;
const PH_LIFT = 3;

/** Seconds a landing / a lift-off takes (fireflies have no author knob for it: they are slow and graceful). */
const LAND_SEC = 1.0;
const LIFT_SEC = 0.8;
/** Colony coupling strength K at `synchrony = 1`, radians per second (see the header; the dial is squared). */
const COUPLING = 1.1;

/**
 * @param {*} TSL
 * @param {object} deps
 * @param {(name: string) => *} deps.u - the uniform bank's `get`.
 * @param {{nearest: Function}} deps.zone - the zone sampler.
 * @returns {{update: (s: object) => object, spawn: (s: object) => object, lost: (s: object) => *}}
 */
export function buildFireflyBrain(TSL, { u, zone }) {
  const { float, vec2, vec4, select, clamp, min, max, sin, cos, exp, fract, floor, smoothstep, pow } = TSL;

  const angDiff = (a, b) => wrapAngle(TSL, b.sub(a));
  const dir = (a) => vec2(cos(a), sin(a));
  const zero2 = vec2(0, 0);
  const ease = (t) => {
    const c = clamp(t, 0, 1);
    return c.mul(c).mul(float(3).sub(c.mul(2)));
  };

  function update(s) {
    const hdg = s.C.x;
    const z = s.C.y;
    const fph = s.C.z;
    const aux = s.C.w;
    const ord = floor(s.PH);
    const frac = s.PH.sub(ord);
    const isFly = ord.lessThan(0.5);
    const isLand = ord.greaterThan(0.5).and(ord.lessThan(1.5));
    const isRest = ord.greaterThan(1.5).and(ord.lessThan(2.5));

    const dist = s.zs.distance; // signed px, > 0 inside the paint
    const gradAng = safeAtan2(TSL, s.zs.grad.y, s.zs.grad.x); // the way back in
    const range = max(u('range'), s.L.mul(3));
    const hover = u('hoverHeight');
    const t = s.tSec;
    const a1 = s.seed01.mul(TAU);
    const a2 = s.seed01.mul(TAU * 2.3);
    const a3 = s.seed01.mul(TAU * 3.7);

    // ── the flash clock (every state keeps time) ──
    // It runs on REAL time (`s.dtReal`), never on the author's Tempo (`s.dt`): Tempo is how fast they fly,
    // and a flash that sped up with it would break two promises at once — the colony clock the coupling
    // pulls toward runs on real time too, so a scaled oscillator would never lock to it; and the
    // "no faster than a flash a second" ceiling (`FIREFLY_SYNC.PERIOD_FLOOR`) would be a function of a slider.
    const period = max(
      float(FIREFLY_SYNC.PERIOD_FLOOR),
      u('flashPeriod').mul(float(FIREFLY_SYNC.PERIOD_MIN).add(s.seed01.mul(FIREFLY_SYNC.PERIOD_SPAN)))
    );
    // Quadratic in the author's dial: the lock range grows with K, so a linear dial would jump from
    // "strangers" to "locked" over its first quarter. Squared, 0.25 stays loosely patchy and 1 is unison.
    const pull = u('synchrony')
      .mul(u('synchrony'))
      .mul(COUPLING / TAU)
      .mul(sin(u('colonyPhase').sub(fph).mul(TAU)));
    const fphNext = fract(fph.add(s.dtReal.mul(float(1).div(period).add(pull))));

    // ── the wall: bounce off the contour `range` px beyond the paint ──
    const wall = (Pn, Vn) => {
      const vOut = Vn.dot(s.zs.grad);
      const dNew = dist.add(vOut.mul(s.dt));
      const pen = min(max(range.negate().sub(dNew), 0), range);
      return {
        P: Pn.add(s.zs.grad.mul(pen)),
        V: select(pen.greaterThan(0), Vn.sub(s.zs.grad.mul(min(vOut, 0)).mul(1.6)), Vn),
      };
    };

    // ── FLY ──
    const speed = u('driftSpeed').mul(float(0.7).add(sin(t.mul(0.8).add(a1)).mul(0.3)));
    const turn = u('wander').mul(
      sin(t.mul(0.37).add(a1))
        .mul(0.9)
        .add(sin(t.mul(0.91).add(a2)).mul(0.6))
    );
    const edge = float(1).sub(smoothstep(range.negate(), range.mul(-0.5), dist));
    const hdgFly = hdg.add(turn.mul(s.dt)).add(angDiff(hdg, gradAng).mul(edge).mul(s.dt).mul(4));
    const vFly0 = dir(hdgFly).mul(speed);
    const flyWall = wall(s.P.add(vFly0.mul(s.dt)), vFly0);
    const hoverNow = hover.mul(float(1).add(sin(t.mul(0.5).add(a3)).mul(0.3)));
    const zFly = z.add(hoverNow.sub(z).mul(min(float(1), s.dt.mul(1.5))));
    const pRest = float(1).sub(exp(u('restChance').negate().mul(s.dt)));
    const wantRest = s.rnd(6).lessThan(pRest).and(dist.greaterThan(s.L));
    const phFly = select(wantRest, float(PH_LAND), float(PH_FLY));
    const auxFly = select(wantRest, zFly, aux);

    // ── LAND ── slow to a stop and sink
    const progL = frac.add(s.dt.div(LAND_SEC));
    const zLand = aux.mul(float(1).sub(ease(progL)));
    const vLand = s.V.mul(pow(float(0.04), s.dt));
    const doneL = progL.greaterThanEqual(1);
    const phLand = select(doneL, float(PH_REST), float(PH_LAND).add(min(progL, 0.999)));

    // ── REST ── glowing on the ground until the urge to fly returns
    const pLift = float(1).sub(exp(u('liftChance').negate().mul(s.dt)));
    const wantLift = s.rnd(8).lessThan(pLift);
    const phRest = select(wantLift, float(PH_LIFT), float(PH_REST));
    const hdgRest = select(wantLift, s.rnd(9).mul(TAU), hdg);

    // ── LIFT ── rise and pick up speed
    const progT = frac.add(s.dt.div(LIFT_SEC));
    const zLift = hover.mul(ease(progT));
    const vLift0 = dir(hdg).mul(u('driftSpeed')).mul(ease(progT));
    const liftWall = wall(s.P.add(vLift0.mul(s.dt)), vLift0);
    const doneT = progT.greaterThanEqual(1);
    const phLift = select(doneT, float(PH_FLY), float(PH_LIFT).add(min(progT, 0.999)));

    const pick = (fly, land, rest, lift) => select(isFly, fly, select(isLand, land, select(isRest, rest, lift)));
    return {
      P: pick(flyWall.P, s.P.add(vLand.mul(s.dt)), s.P, liftWall.P),
      V: pick(flyWall.V, vLand, zero2, liftWall.V),
      TMR: s.TMR,
      PH: pick(phFly, phLand, phRest, phLift),
      C: vec4(
        wrapAngle(TSL, pick(hdgFly, hdg, hdgRest, hdg)),
        pick(zFly, zLand, float(0), zLift),
        fphNext,
        pick(auxFly, aux, aux, aux)
      ),
    };
  }

  /** A fresh firefly: near its home, mostly in the air, at a random point in its flash. */
  function spawn(s) {
    const offset = dir(s.rnd(1).mul(TAU)).mul(s.rnd(2).mul(u('range')).mul(0.5));
    const cand = s.home.add(offset);
    const probe = zone.nearest(cand);
    const P = select(probe.distance.greaterThan(s.L), cand, s.home);
    const airborne = s.rnd(3).lessThan(0.75);
    return {
      P,
      V: zero2,
      TMR: float(0),
      PH: select(airborne, float(PH_FLY), float(PH_REST)),
      C: vec4(s.rnd(4).mul(TAU), select(airborne, u('hoverHeight'), float(0)), s.rnd(7), float(0)),
    };
  }

  /** Far beyond the roaming range (the paint moved under it): recycle at home. */
  function lost(s) {
    return s.zs.distance.lessThan(max(u('range').mul(2), s.L.mul(8)).negate());
  }

  return { update, spawn, lost };
}

/** The ordinals, so the renderer and the tests read the same numbers the brain writes. */
export const FIREFLY_PHASES = Object.freeze({ fly: PH_FLY, land: PH_LAND, rest: PH_REST, lift: PH_LIFT });

/**
 * The flash clock's constants — the coupling, how far an individual's period strays from the author's, and
 * the FLOOR no period may go under (seconds) — exported so the renderer (which needs each firefly's period
 * for its afterglow), the engine's colony clock and a Node model of the oscillator read the SAME numbers
 * the kernel does.
 *
 * The floor is the photosensitivity guarantee. At one second per cycle a single-flash style flashes once a
 * second; the colony coupling can pull an insect ahead by at most `COUPLING/2π` ≈ 0.18 cycles a second; and
 * the busiest style (two flashes a cycle) therefore never exceeds three flashes in any one-second window —
 * the line WCAG 2.3.1 draws, which holds whatever area the flashes cover.
 */
export const FIREFLY_SYNC = Object.freeze({ COUPLING, PERIOD_MIN: 0.85, PERIOD_SPAN: 0.3, PERIOD_FLOOR: 1 });
