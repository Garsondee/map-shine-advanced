/**
 * FLY BRAIN — one fly's decision-making, as a branch-free GPU kernel fragment.
 *
 * The runtime (`effects/particles/critter-runtime.js`) hands this module a slot's
 * state and gets back that slot's NEXT state; it never sees what a fly "wants".
 * Everything here is the same four-state machine V2 ran in JavaScript per fly
 * (`SmellyFliesEffect.js`'s `FlyBehavior`) — rewritten so a thousand flies cost one
 * compute dispatch and no JavaScript objects (V2's actual bottleneck).
 *
 * ============================================================================
 * HOW A STATE MACHINE RUNS ON A GPU
 * ============================================================================
 *
 * A GPU executes the same instructions for every agent in lock-step; there is no
 * "if I am landing, do this". So each agent computes ALL FOUR states' next values
 * and then SELECTS the one that matches its current state — branch-free, which is
 * also what the existing kernels do (they use no `If`/`Loop`, and are the only
 * constructs proven on both backends). The waste is a few dozen ALU ops per fly;
 * the gain is that nothing diverges and nothing needs a CPU round trip.
 *
 * The state lives in two slots of the arena (`particle-arena.js`):
 *
 *   phase = ordinal + fraction   ordinal 0 FLY · 1 LAND · 2 WALK · 3 TAKEOFF
 *                                 fraction is the animation PROGRESS for landing and
 *                                 take-off, and the walk SUB-MODE for walking
 *                                 (0.1 idle · 0.4 turning · 0.7 moving)
 *   life  (used as `timer`)      seconds until the next decision: the next dart in
 *                                 flight, the end of a pause, the end of a walk leg
 *
 * Randomness is `rnd(k)`: a hash of the fly's seed, a per-frame salt the CPU
 * refreshes, and a decision number `k`. Nothing needs to match between players and
 * nothing here affects gameplay, so the salt is plain `Math.random()` — different
 * on every client, by design.
 *
 * ============================================================================
 * WHAT IS STILL V2, WHAT IS NEW
 * ============================================================================
 *
 * V2's numbers survive as the defaults: darts of 0.05–0.25 s whose strength is
 * `buzz × (0.3 + 0.7·rand)`; direction random but biased toward home as
 * `min(1, dist/200 · tether/25)`; a soft tether `(dist − radius) · tether · 0.02`
 * beyond the swarm radius; drag `0.85`; landing/take-off as per-second hazards.
 * NEW: the zone field. V2 killed any fly that crossed the indoors/outdoors line
 * (and respawned another); here a fly KNOWS where the rim is — it steers away from
 * it before arriving, lands only well inside the paint, and picks its walking
 * targets by looking at the field, so it never has to be killed for leaving.
 *
 * @module effects/critters/fly-brain
 */
import { wrapAngle, safeAtan2 } from './critter-sdf.js';

const TAU = Math.PI * 2;

// Phase encodings (kept beside `fly-pose.js`'s WALK_*_FRAC: the pose reads them back).
const PH_FLY = 0;
const PH_LAND = 1;
const PH_IDLE = 2.1;
const PH_TURN = 2.4;
const PH_MOVE = 2.7;
const PH_TAKEOFF = 3;

/** V2's drag coefficient (`flying.drag`), applied as `1 − drag·0.5·dt`. */
const DRAG = 0.85;
/** In-place turning rate, V2's `walking.rotationSpeed`. */
const TURN_RATE = 4;
/** One walking leg is this many body lengths (V2: 15–60 px on an 18 px fly ≈ 0.8–3.3). */
const MOVE_MIN_LENGTHS = 1;
const MOVE_MAX_LENGTHS = 4;
/**
 * Stride length in body lengths: 2·S/β for the middle legs (see `fly-body.js`). It is the distance the
 * body advances per gait cycle, and it MUST agree with the legs' own stride (`STRIDE_AMPLITUDE[1]` over
 * `STANCE_DUTY`) or the planted feet slide; a Node test holds the two together.
 */
const STRIDE_LENGTHS = 0.322;

/** The numbers the body's geometry has to agree with, exposed so a test can hold them together. */
export const FLY_BRAIN = Object.freeze({ STRIDE_LENGTHS, DRAG, TURN_RATE });

/**
 * @param {*} TSL
 * @param {object} deps
 * @param {(name: string) => *} deps.u - the uniform bank's `get`.
 * @param {{nearest: Function}} deps.zone - the zone sampler.
 * @returns {{update: (s: object) => object, spawn: (s: object) => object, lost: (s: object) => *}}
 */
export function buildFlyBrain(TSL, { u, zone }) {
  const { float, vec2, select, mix, clamp, min, max, abs, sin, cos, exp, length, smoothstep, floor, pow, fract } = TSL;

  const angDiff = (a, b) => wrapAngle(TSL, b.sub(a));
  const lerpAng = (a, b, t) => a.add(angDiff(a, b).mul(clamp(t, 0, 1)));
  const dir = (a) => vec2(cos(a), sin(a));
  const ease = (t) => {
    const c = clamp(t, 0, 1);
    return c.mul(c).mul(float(3).sub(c.mul(2)));
  };
  const zero2 = vec2(0, 0);

  /**
   * The slot's next state.
   * @param {object} s - { P, V, TMR, S, C, PH, home, zs, dt, tSec, L, rnd }
   *   P/V vec2; TMR/S/PH floats; C vec4 (heading, height, gait, aux); home vec2;
   *   zs the zone sample at P; L this fly's body length in px; rnd(k) → [0,1).
   */
  function update(s) {
    const hdg = s.C.x;
    const z = s.C.y;
    const gait = s.C.z;
    const aux = s.C.w;
    const ord = floor(s.PH);
    const frac = s.PH.sub(ord);
    const isFly = ord.lessThan(0.5);
    const isLand = ord.greaterThan(0.5).and(ord.lessThan(1.5));
    const isWalk = ord.greaterThan(1.5).and(ord.lessThan(2.5));

    const flyH = u('flyHeight');
    const dist = s.zs.distance; // signed px, > 0 inside the zone
    const gradAng = safeAtan2(TSL, s.zs.grad.y, s.zs.grad.x); // the way INTO the zone
    const toHome = s.home.sub(s.P);
    const dHome = max(length(toHome), 1e-3);
    const homeDir = toHome.div(dHome);
    // THE WALL: how far past the painted rim a flying fly may go. The swarm is a cloud over the
    // paint, not a hard-edged sprite, so it overshoots a little (a fly's length or so, or a
    // quarter of the swarm radius) and then BOUNCES off the contour. V2 killed any fly that
    // crossed the indoors/outdoors line and spawned another; a fly that can see the rim never
    // has to be killed.
    const wallPx = max(u('swarmRadius').mul(0.25), s.L.mul(1.2));
    const wall = (Pn, Vn) => {
      const vOut = Vn.dot(s.zs.grad); // < 0: heading out of the zone
      const dNew = dist.add(vOut.mul(s.dt)); // where the rim will be, one step on (no second field read)
      const pen = min(max(wallPx.negate().sub(dNew), 0), s.L);
      return {
        P: Pn.add(s.zs.grad.mul(pen)),
        V: select(pen.greaterThan(0), Vn.sub(s.zs.grad.mul(min(vOut, 0)).mul(1.6)), Vn),
      };
    };

    // ───────────────────────────── FLY ─────────────────────────────
    const burstNow = s.TMR.lessThanEqual(0);
    const dur = mix(float(0.05), float(0.25), s.rnd(1));
    const rAng = s.rnd(2).mul(TAU);
    const homeAng = safeAtan2(TSL, toHome.y, toHome.x);
    const homeBias = min(float(1), dHome.div(200).mul(u('tether').div(25)));
    const angToHome = rAng.add(homeBias.mul(angDiff(rAng, homeAng)).mul(0.6));
    // Steer inward before arriving at the wall: full inward bias at it, none a wall-width inside the rim.
    const edgeBias = float(1).sub(smoothstep(wallPx.negate(), wallPx, dist));
    const dartAng = angToHome.add(angDiff(angToHome, gradAng).mul(edgeBias).mul(0.9));
    const kick = u('buzz')
      .mul(float(0.3).add(s.rnd(3).mul(0.7)))
      .mul(dur)
      .mul(0.75);
    const dart = dir(dartAng)
      .mul(kick)
      .mul(select(burstNow, float(1), float(0)));
    const tetherPull = homeDir
      .mul(
        max(dHome.sub(u('swarmRadius')), 0)
          .mul(u('tether'))
          .mul(0.02)
      )
      .mul(s.dt);
    const vRaw = s.V.add(dart).add(tetherPull);
    const vFly0 = vRaw
      .mul(min(float(1), u('maxSpeed').div(max(length(vRaw), 1e-3))))
      .mul(float(1).sub(s.dt.mul(DRAG * 0.5)));
    const flyWall = wall(s.P.add(vFly0.mul(s.dt)), vFly0);
    const vFly = flyWall.V;
    const pFly = flyWall.P;
    const bob = sin(s.tSec.mul(3.7).add(s.S.mul(1.3)))
      .mul(0.04)
      .mul(flyH);
    const zFly = mix(z, flyH.add(bob), min(float(1), s.dt.mul(3)));
    const hdgFly = select(
      length(vFly).greaterThan(10),
      lerpAng(hdg, safeAtan2(TSL, vFly.y, vFly.x), s.dt.mul(12)),
      hdg
    );
    const pLand = float(1).sub(exp(u('landChance').negate().mul(s.dt)));
    const wantLand = s
      .rnd(6)
      .lessThan(pLand)
      .and(dist.greaterThan(s.L.mul(0.3)));
    const phFly = select(wantLand, float(PH_LAND), float(PH_FLY));
    const auxFly = select(wantLand, zFly, aux);
    const tmrFly = select(burstNow, dur, s.TMR.sub(s.dt));

    // ───────────────────────────── LAND ─────────────────────────────
    const progL = frac.add(s.dt.div(max(u('landingTime'), 0.05)));
    const vLand0 = s.V.mul(pow(float(0.9), s.dt.mul(60))); // V2: ×0.9 per frame
    const pLand2 = s.P.add(vLand0.mul(s.dt).mul(0.3));
    const zLand = aux.mul(float(1).sub(ease(progL)));
    const doneL = progL.greaterThanEqual(1);
    const idleTime = mix(u('pauseMin'), max(u('pauseMax'), u('pauseMin')), s.rnd(7));
    const phLand = select(doneL, float(PH_IDLE), float(PH_LAND).add(min(progL, 0.999)));
    const tmrLand = select(doneL, idleTime, s.TMR);
    const vLand = select(doneL, zero2, vLand0);
    const zLandOut = select(doneL, float(0), zLand);

    // ───────────────────────────── WALK ─────────────────────────────
    const bucket = floor(clamp(frac, 0, 0.999).mul(3));
    const isIdle = bucket.lessThan(0.5);
    const isTurn = bucket.greaterThan(0.5).and(bucket.lessThan(1.5));
    const walkSpeed = u('walkSpeed');

    // idle: count down, then look at three candidate targets and take the first well inside the zone
    const tmrIdle = s.TMR.sub(s.dt);
    const idleDone = isIdle.and(tmrIdle.lessThanEqual(0));
    const candidate = (k) => {
      const th = s.rnd(10 + k).mul(TAU);
      const d = mix(s.L.mul(MOVE_MIN_LENGTHS), s.L.mul(MOVE_MAX_LENGTHS), s.rnd(14 + k));
      const probe = zone.nearest(s.P.add(dir(th).mul(d)));
      return { th, d, ok: probe.distance.greaterThan(s.L.mul(0.6)) };
    };
    const c0 = candidate(0);
    const c1 = candidate(1);
    const c2 = candidate(2);
    // nothing suitable: head back in (the gradient), a couple of lengths
    const thTarget = select(
      c0.ok,
      c0.th,
      select(c1.ok, c1.th, select(c2.ok, c2.th, gradAng.add(s.rnd(18).sub(0.5).mul(0.8))))
    );
    const dTarget = select(c0.ok, c0.d, select(c1.ok, c1.d, select(c2.ok, c2.d, s.L.mul(2))));

    // turn: rotate toward the target, stepping in place
    const dAng = angDiff(hdg, aux);
    const hdgTurn = hdg.add(dAng.mul(min(float(1), s.dt.mul(TURN_RATE))));
    const gaitTurn = gait.add(abs(hdgTurn.sub(hdg)).mul(0.5));
    const turnDone = isTurn.and(abs(dAng).lessThan(0.1));

    // move: walk the planned leg, easing to a stop, steering off the rim
    const tmrMove = s.TMR.sub(s.dt);
    const speedNow = walkSpeed.mul(smoothstep(float(0), float(0.25), s.TMR));
    const vMove = mix(s.V, dir(hdg).mul(speedNow), min(float(1), s.dt.mul(12)));
    const rimNear = float(1).sub(smoothstep(float(0), s.L.mul(1.5), dist));
    const hdgMove = lerpAng(hdg, gradAng, rimNear.mul(s.dt).mul(6)).add(s.rnd(30).sub(0.5).mul(1.2).mul(s.dt));
    const pMove = s.P.add(vMove.mul(s.dt));
    const gaitMove = gait.add(length(vMove).mul(s.dt).div(s.L.mul(STRIDE_LENGTHS)));
    const moveDone = tmrMove.lessThanEqual(0);

    const pTake = float(1).sub(exp(u('takeoffChance').negate().mul(s.dt)));
    const wantTake = s.rnd(8).lessThan(pTake);

    const phIdleNext = select(idleDone, float(PH_TURN), float(PH_IDLE));
    const phTurnNext = select(turnDone, float(PH_MOVE), float(PH_TURN));
    const phMoveNext = select(moveDone, float(PH_IDLE), float(PH_MOVE));
    const phWalk0 = select(isIdle, phIdleNext, select(isTurn, phTurnNext, phMoveNext));
    const phWalk = select(wantTake, float(PH_TAKEOFF), phWalk0);
    const tmrWalk = select(
      isIdle,
      select(idleDone, dTarget.div(max(walkSpeed, 1)), tmrIdle),
      select(isTurn, s.TMR, select(moveDone, idleTime, tmrMove))
    );
    const vWalk = select(isIdle.or(isTurn), zero2, select(moveDone, zero2, vMove));
    const pWalk = select(isIdle.or(isTurn), s.P, pMove);
    const hdgWalk = select(isIdle, hdg, select(isTurn, hdgTurn, hdgMove));
    const gaitWalk = select(isIdle, gait, select(isTurn, gaitTurn, gaitMove));
    const auxWalk = select(idleDone, thTarget, aux);

    // ─────────────────────────── TAKE-OFF ───────────────────────────
    const progT = frac.add(s.dt.div(max(u('takeoffTime'), 0.05)));
    const zTake = flyH.mul(ease(progT));
    const vTake0 = mix(s.V, dir(hdg).mul(u('maxSpeed')).mul(0.35).mul(ease(progT)), min(float(1), s.dt.mul(3)));
    const takeWall = wall(s.P.add(vTake0.mul(s.dt)), vTake0);
    const vTake = takeWall.V;
    const pTake2 = takeWall.P;
    const doneT = progT.greaterThanEqual(1);
    const phTake = select(doneT, float(PH_FLY), float(PH_TAKEOFF).add(min(progT, 0.999)));
    const tmrTake = select(doneT, float(0), s.TMR);

    // ─────────────────────── choose by current state ───────────────────────
    const pick = (fly, land, walk, take) => select(isFly, fly, select(isLand, land, select(isWalk, walk, take)));
    // The heading and the gait are ACCUMULATORS, and an accumulator that only ever grows loses its
    // fraction: a float32 gait that has walked ten thousand cycles resolves a cycle to a thousandth, and
    // the legs would step in quantised jumps after an hour. Both are only ever read modulo their period
    // (the body takes `fract(gait + offset)`; every use of the heading goes through sin/cos or a wrapped
    // difference), so they are kept in one period and keep full precision however long the swarm lives.
    return {
      P: pick(pFly, pLand2, pWalk, pTake2),
      V: pick(vFly, vLand, vWalk, vTake),
      TMR: pick(tmrFly, tmrLand, tmrWalk, tmrTake),
      PH: pick(phFly, phLand, phWalk, phTake),
      C: TSL.vec4(
        wrapAngle(TSL, pick(hdgFly, hdg, hdgWalk, hdg)),
        pick(zFly, zLandOut, float(0), zTake),
        fract(pick(gait, gait, gaitWalk, gait)),
        pick(auxFly, aux, auxWalk, aux)
      ),
    };
  }

  /**
   * A fresh fly: near its home, mostly on the ground (V2 spawned them walking),
   * sometimes already in the air so a scene does not open with a still swarm.
   */
  function spawn(s) {
    const offset = dir(s.rnd(1).mul(TAU)).mul(s.rnd(2).mul(u('swarmRadius')).mul(0.5));
    const cand = s.home.add(offset);
    const probe = zone.nearest(cand);
    const P = select(probe.distance.greaterThan(s.L), cand, s.home);
    const airborne = s.rnd(3).lessThan(0.3);
    return {
      P,
      V: zero2,
      TMR: select(airborne, float(0), s.rnd(5).mul(2)),
      PH: select(airborne, float(PH_FLY), float(PH_IDLE)),
      C: TSL.vec4(s.rnd(4).mul(TAU), select(airborne, u('flyHeight'), float(0)), float(0), float(0)),
    };
  }

  /**
   * A fly that has strayed so far past the rim that the zone's push-back did not
   * recover it (the paint moved under it, or a long hitch flung it) is recycled to
   * its home rather than left to wander the map. The threshold is generous: a
   * flying fly may legitimately overshoot by the swarm radius.
   */
  function lost(s) {
    const far = max(u('swarmRadius').mul(2.5), s.L.mul(8));
    return s.zs.distance.lessThan(far.negate());
  }

  return { update, spawn, lost };
}
