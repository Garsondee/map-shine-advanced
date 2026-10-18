/**
 * FLY POSE — the animation logic: what a fly's body is DOING, from the few numbers
 * its brain keeps (`effects/particles/critter-runtime.js`).
 *
 * The split is the whole design. The brain says WHERE the fly is and WHICH STATE
 * it is in (`phase = ordinal + progress`, see `particle-arena.js`'s phase slot);
 * this module turns that into a POSE — wing angle, wing blur, how far the legs are
 * tucked or reaching, whether it is grooming; `fly-body.js` turns a pose into
 * pixels. Three stages, each testable on its own, which is what lets the gallery
 * render any state at any progress without running the simulation at all.
 *
 * ============================================================================
 * THE FOUR STATES AND THEIR KEYFRAMES
 * ============================================================================
 *
 * Every state is a short animation parameterised by `progress` 0..1 (landing and
 * take-off) or by sub-mode (walking), and every curve below is a smoothstep
 * window over progress — a keyframe track written as arithmetic, so the same
 * code scrubs forwards, backwards and at any speed.
 *
 *   FLY       wings a translucent fan (the arcsine blur of a 200 Hz beat), legs
 *             tucked up under the body, banking into turns.
 *   LAND      the descent: wings slow, then FLARE high like an air-brake, legs
 *             drop and reach for the ground, and at touchdown the wings fold.
 *   WALK      wings folded; sub-modes IDLE (still, or grooming — the front legs
 *             rub like hands, the back legs stroke the wings), TURN (stepping in
 *             place, the two sides stepping opposite ways), MOVE (tripod gait).
 *   TAKEOFF   a push-off crouch with legs extended, the wings snapping open and
 *             beating up through a blur, then the legs tuck as it climbs.
 *
 * All angles are radians measured FROM THE BACKWARD AXIS rotating outward (0 =
 * wing laid flat along the abdomen, π/2 = straight out sideways).
 *
 * @module effects/critters/fly-pose
 */

/** Wing angle of a flying fly (mean of its beat): ~66° out from the body axis. */
export const WING_FLIGHT = 1.15;
/** Fully folded, lying along the abdomen (a hair open — wings never lie perfectly flush). */
export const WING_FOLDED = 0.04;
/** Spread wide at the instant of take-off, before the beat settles. */
export const WING_SPREAD = 1.45;
/** The landing air-brake flare, wings swept forward and up. */
export const WING_FLARE = 1.75;
/** Half-amplitude of the flight beat (~34°). */
export const WING_BEAT_AMP = 0.6;

/** Walk sub-modes ride the fractional part of `phase` in thirds (see the brain). */
export const WALK_IDLE_FRAC = 0.1;
export const WALK_TURN_FRAC = 0.4;
export const WALK_MOVE_FRAC = 0.7;

/**
 * @param {*} TSL
 * @param {object} a
 * @param {*} a.ordinal - 0 fly, 1 landing, 2 walking, 3 taking off (float node).
 * @param {*} a.frac - progress 0..1 within landing/take-off; sub-mode bucket when walking.
 * @param {*} a.timeSec - a bounded clock (seconds), for the stateless grooming rhythm.
 * @param {*} a.seed01 - per-fly stable random 0..1.
 * @param {*} a.turnRate - signed yaw rate in rad/s (for banking and in-place stepping).
 * @param {*} a.groomChance - 0..1, how often an idle spell is spent grooming.
 * @param {*} a.wingBlurAmt - 0..1 (the `wingBlur` param).
 * @param {*} [a.wingSpread] - float node, a multiplier on the flight wing angle and beat (1 = as drawn).
 * @param {*} [a.bankAmount] - float node, a multiplier on how far a fly leans into a turn (1 = as drawn).
 * @returns {{wingMean:*, wingAmp:*, wingBlur:*, wingPhase:*, stride:*, turnDir:*,
 *   tuck:*, reach:*, groom:*, groomPhase:*, bank:*}} nodes.
 */
export function buildFlyPose(
  TSL,
  { ordinal, frac, timeSec, seed01, turnRate, groomChance, wingBlurAmt, wingSpread = null, bankAmount = null }
) {
  const { float, smoothstep, mix, sin, select, abs, clamp, fract, floor, sign, max } = TSL;
  const PI = Math.PI;
  // The flight wing angle and beat, scaled by the author's spread. Landing STARTS from these and take-off ENDS
  // on them, so a change of spread cannot pop at the hand-over between flying and the other two.
  const spread = wingSpread ?? float(1);
  const flightMean = float(WING_FLIGHT).mul(spread);
  const flightAmp = float(WING_BEAT_AMP).mul(spread);
  const k = (a, b, x) => smoothstep(float(a), float(b), x);

  const isFly = ordinal.lessThan(0.5);
  const isLand = ordinal.greaterThan(0.5).and(ordinal.lessThan(1.5));
  const isWalk = ordinal.greaterThan(1.5).and(ordinal.lessThan(2.5));
  // (anything else is take-off)

  // ── WALK sub-mode, from the fractional bucket ──
  const bucket = floor(clamp(frac, 0, 0.9999).mul(3));
  const isIdle = isWalk.and(bucket.lessThan(0.5));
  const isTurn = isWalk.and(bucket.greaterThan(0.5)).and(bucket.lessThan(1.5));
  const isMove = isWalk.and(bucket.greaterThan(1.5));

  // ── FLY ──
  const wobble = sin(timeSec.mul(3.1).add(seed01.mul(40)));
  const flyMean = flightMean.add(wobble.mul(0.07)).sub(clamp(abs(turnRate).mul(0.04), 0, 0.12));
  const flyPhase = timeSec.mul(7).add(seed01.mul(2 * PI));

  // ── LAND (frac = progress) ──
  const pL = frac;
  const landMean = mix(mix(flightMean, float(1.25), k(0, 0.55, pL)), float(WING_FLARE), k(0.5, 0.78, pL));
  const landMeanFolded = mix(landMean, float(WING_FOLDED), k(0.82, 1.0, pL));
  const landAmp = mix(flightAmp, float(0.3), k(0.2, 0.6, pL)).mul(float(1).sub(k(0.8, 0.98, pL)));
  const landBlur = float(1).sub(k(0.45, 0.85, pL));
  const landPhase = pL.mul(float(2 * PI * 9)).mul(float(1).sub(pL.mul(0.5)));
  const landTuck = float(1).sub(k(0.3, 0.7, pL));
  const landReach = k(0.45, 0.8, pL).mul(float(1).sub(k(0.9, 1.0, pL)));

  // ── TAKE-OFF (frac = progress) ──
  const pT = frac;
  const takeMean = mix(mix(float(WING_FOLDED), float(WING_SPREAD), k(0, 0.2, pT)), flightMean, k(0.3, 0.7, pT));
  const takeAmp = k(0.05, 0.4, pT).mul(flightAmp).mul(0.9);
  const takeBlur = k(0.12, 0.55, pT);
  const takePhase = pT.mul(float(2 * PI * 14));
  const takeTuck = k(0.35, 0.85, pT);
  const takeReach = k(0, 0.12, pT).mul(float(1).sub(k(0.25, 0.5, pT)));

  // ── GROOMING: a stateless rhythm. An "episode" is a 3.1 s slice of time offset
  // per fly; whether it is a grooming episode is a hash of its index; an envelope
  // eases the legs in and out so they never snap. ──
  const episodePos = timeSec.add(seed01.mul(37)).div(3.1);
  const episode = floor(episodePos);
  const episodeT = fract(episodePos);
  const roll = fract(sin(episode.mul(12.9898).add(seed01.mul(78.233))).mul(43758.5453));
  const envelope = k(0, 0.12, episodeT).mul(float(1).sub(k(0.78, 0.95, episodeT)));
  const groomOn = select(roll.lessThan(groomChance), float(1), float(0));
  const groom = groomOn.mul(envelope).mul(select(isIdle, float(1), float(0)));

  // ── Select by state ──
  const pick = (fly, land, walk, take) => select(isFly, fly, select(isLand, land, select(isWalk, walk, take)));

  const wingMean = pick(flyMean, landMeanFolded, float(WING_FOLDED), takeMean);
  const wingAmp = pick(flightAmp, landAmp, float(0), takeAmp);
  const blur = pick(float(1), landBlur, float(0), takeBlur).mul(wingBlurAmt);
  const wingPhase = pick(flyPhase, landPhase, float(0), takePhase);

  // Stride amplitude: full while moving, partial while turning on the spot.
  const stride = select(isMove, float(1), select(isTurn, float(0.75), float(0)));
  const turnDir = select(isTurn, sign(turnRate), float(0));
  const tuck = pick(float(1), landTuck, float(0), takeTuck);
  const reach = pick(float(0), landReach, float(0), takeReach);
  const bank = select(isFly, clamp(turnRate.mul(0.25), -1, 1), float(0)).mul(bankAmount ?? float(1));

  // A touch of life while standing: a slow wing-twitch the eye reads as breathing.
  const idleTwitch = select(
    isIdle,
    max(float(0), sin(timeSec.mul(1.7).add(seed01.mul(9))))
      .pow(18)
      .mul(0.1),
    float(0)
  );

  return {
    wingMean: wingMean.add(idleTwitch),
    wingAmp,
    wingBlur: blur,
    wingPhase,
    stride,
    turnDir,
    tuck,
    reach,
    groom,
    groomPhase: timeSec.mul(2 * PI * 6.5).add(seed01.mul(20)),
    bank,
  };
}
