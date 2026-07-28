/**
 * THE PUMP — what makes the goo behave like something is HAPPENING, not
 * scrolling (`docs/planning/Fluid.md` §5.3, §6). Pure, no THREE, no GPU.
 *
 * Every tube gets a flow rate `Q(t)` (world px²/s — divided by the tube's own
 * cross-section this drives the advection velocity, so the same Q makes the
 * goo move faster through a narrow neck) and an `inject(t)` value (0..1, what
 * enters at the tube's root bin this instant). `fluid-sim.js`'s advection
 * step carries both downstream; this module only decides what a tube's own
 * apparatus is doing at a given moment.
 *
 * ============================================================================
 * WHY THIS IS THE ONE PLACE A FUTURE SESSION SHOULD REACH TO CHANGE HOW THE
 * GOO BEHAVES
 * ============================================================================
 * Everything that makes the goo interesting — never quite repeating, gulping
 * occasionally, distinct slugs separated by gaps — is right here, in ~60 lines
 * of ordinary arithmetic. Nothing about "is this fun to watch" lives in the
 * sim (which only transports whatever this hands it) or the shader (which
 * only shades whatever the sim produces). Fixing the pace, adding a new kind
 * of surge, or wiring a Foundry event (a door slams, a token walks past) all
 * mean editing THIS function's inputs, never the physics.
 *
 * ============================================================================
 * WHY DETERMINISTIC-FROM-A-HASH, NOT `Math.random()`
 * ============================================================================
 * `time/one-clock` bans a private clock read in an effect, and the same
 * discipline applies to a private RNG: a stateful `Math.random()` stream
 * cannot be re-derived from `tMs` alone, so it would force this module to
 * carry mutable state across ticks in lockstep with the ping-pong swap — the
 * exact "two things that must stay in sync or drift silently" shape this
 * project keeps finding and re-banning. Instead, every tube's personality
 * (its frequencies, phases, gulp timing, duty cycle) is a DETERMINISTIC hash
 * of its own index, and the only INPUT that ever changes is `tMs` — the
 * shared sim clock, already paused/resumed/ramped correctly by
 * `core/frame-clock.js`. Call this function twice with the same `(tMs,
 * tubeIndex)` and it returns the identical answer, which is also what makes
 * it a one-line Node test instead of a flaky one.
 *
 * The brief's own freedoms make this legitimate rather than a shortcut: the
 * author does not need two clients to agree pixel-for-pixel
 * ("doesn't need to be exactly the same for all users"), so a per-tube hash
 * seed never needs to be authored, synced, or persisted — it falls straight
 * out of the tube's own id, which is already stable within a session.
 *
 * @module effects/fluid/fluid-pump
 */

/** World px²/s — the flow-rate scale a "typical" tube pulses around. Chosen so
 * the RESULTING velocity (Q / a typically-sized tube's cross-section) lands
 * near the old analytic scroll's default pace (`FLUID_TIER2_SPEED_PX`, 90
 * world px/s) on an ordinarily-sized tube, so replacing the prescribe scroll
 * with the real sim does not also surprise the author with a new pace. */
export const FLUID_PUMP_BASE_Q = 3000;

/** How much the two incommensurate wobble frequencies can vary per tube, Hz. */
const FREQ_MIN_HZ = 0.05;
const FREQ_SPREAD_HZ = 0.07;
/** The second frequency's ratio to the first is golden-ratio-ish plus jitter,
 * which is what keeps a TWO-sine sum from ever completing a shared period
 * within any timescale a player would sit and watch. */
const SECOND_FREQ_RATIO = 1.618;
const SECOND_FREQ_JITTER = 0.3;

/** How often a tube gulps, seconds, and how sharp the gulp's spike is (as a
 * fraction of its own period — small = a brief surge, not a slow swell). */
const GULP_PERIOD_MIN_S = 6;
const GULP_PERIOD_SPREAD_S = 10;
const GULP_WIDTH_FRACTION = 0.03;
/** How much a gulp multiplies Q at its peak, on top of the steady wobble. */
const GULP_STRENGTH = 1.5;

/** How often a slug-and-gap cycle repeats at the root, seconds, and what
 * fraction of each cycle is "full" rather than "gap". */
const DUTY_PERIOD_MIN_S = 1.2;
const DUTY_PERIOD_SPREAD_S = 1.8;
const DUTY_FRACTION_MIN = 0.35;
const DUTY_FRACTION_SPREAD = 0.3;
/** How soft the full/gap transition is, as a fraction of the duty cycle —
 * a hard step would read as a digital blink rather than a meniscus passing. */
const DUTY_SOFT_EDGE = 0.08;

/**
 * A stable pseudo-random value in [0, 1) from an integer seed. The standard
 * "sine-hash" — not cryptographic, not needed to be: this exists only to give
 * each tube an apparently-unrelated personality from its own index, and the
 * classic large-multiplier-then-fract trick is more than uniform enough for
 * that over a few dozen tubes.
 *
 * @param {number} n
 * @returns {number}
 */
export function hash01(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** @param {number} edge0 @param {number} edge1 @param {number} x @returns {number} */
function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Wrap `x` into `[0, 1)`. `x % 1` alone is wrong for negative `x` in JS
 * (`-0.2 % 1 === -0.2`, not `0.8`), and `tMs` is never negative here but a
 * tube's own phase OFFSET can push the argument below zero before wrapping. */
function fract(x) {
  return x - Math.floor(x);
}

/**
 * One tube's own stable "personality" — its frequencies, phases and cycle
 * lengths — derived once from its index. Split out from {@link fluidPumpForTube}
 * so a caller ticking many tubes every frame computes this ONCE per tube
 * (e.g. when a mask bakes) rather than re-deriving eight `hash01` calls' worth
 * of constants on every single frame for every tube.
 *
 * @param {number} tubeIndex - 0-based, stable within a bake (the pack's own
 *   `tubeId - 1`).
 * @returns {{f1: number, f2: number, phase1: number, phase2: number,
 *   gulpPeriodS: number, gulpPhaseOffset: number, dutyPeriodS: number,
 *   dutyPhaseOffset: number, dutyFraction: number}}
 */
export function fluidPumpPersonality(tubeIndex) {
  const k = Math.max(0, tubeIndex | 0);
  const f1 = FREQ_MIN_HZ + hash01(k * 7 + 1) * FREQ_SPREAD_HZ;
  const f2 = f1 * (SECOND_FREQ_RATIO + hash01(k * 7 + 2) * SECOND_FREQ_JITTER);
  return {
    f1,
    f2,
    phase1: hash01(k * 7 + 3) * Math.PI * 2,
    phase2: hash01(k * 7 + 4) * Math.PI * 2,
    gulpPeriodS: GULP_PERIOD_MIN_S + hash01(k * 7 + 5) * GULP_PERIOD_SPREAD_S,
    gulpPhaseOffset: hash01(k * 7 + 6),
    dutyPeriodS: DUTY_PERIOD_MIN_S + hash01(k * 7 + 7) * DUTY_PERIOD_SPREAD_S,
    dutyPhaseOffset: hash01(k * 7 + 8),
    dutyFraction: DUTY_FRACTION_MIN + hash01(k * 7 + 9) * DUTY_FRACTION_SPREAD,
  };
}

/**
 * `Q(t)` and `inject(t)` for one tube at one instant. Deterministic in
 * `(tMs, tubeIndex)` — the whole point (see the module header).
 *
 * @param {number} tMs - the SHARED sim clock (`core/frame-clock.js`), never a
 *   private one.
 * @param {number} tubeIndex
 * @param {{f1:number,f2:number,phase1:number,phase2:number,gulpPeriodS:number,
 *   gulpPhaseOffset:number,dutyPeriodS:number,dutyPhaseOffset:number,
 *   dutyFraction:number}} [personality] - reuse {@link fluidPumpPersonality}'s
 *   output across ticks rather than recomputing it; defaults to computing it
 *   fresh (fine for a one-off call or a test, wasteful in a per-frame loop
 *   over many tubes).
 * @returns {{Q: number, inject: number}}
 */
export function fluidPumpForTube(tMs, tubeIndex, personality = fluidPumpPersonality(tubeIndex)) {
  const tSec = tMs / 1000;
  const { f1, f2, phase1, phase2, gulpPeriodS, gulpPhaseOffset, dutyPeriodS, dutyPhaseOffset, dutyFraction } =
    personality;

  // THE WOBBLE — two incommensurate sines, so the pair does not complete a
  // shared period on any timescale a player sits and watches.
  const s1 = Math.sin(2 * Math.PI * f1 * tSec + phase1);
  const s2 = Math.sin(2 * Math.PI * f2 * tSec + phase2);
  const drive = Math.max(0.05, 0.5 + 0.25 * s1 + 0.25 * s2);

  // THE GULP — a brief, occasional surge. `d` is the wrapped distance to the
  // nearest cycle boundary (0..0.5), so the spike is symmetric around each
  // gulp rather than only approaching it from one side.
  const gulpPhase = fract(tSec / gulpPeriodS + gulpPhaseOffset);
  const d = Math.min(gulpPhase, 1 - gulpPhase);
  const gulp = Math.exp(-(d * d) / (2 * GULP_WIDTH_FRACTION * GULP_WIDTH_FRACTION));

  const Q = FLUID_PUMP_BASE_Q * drive * (1 + gulp * GULP_STRENGTH);

  // THE DUTY CYCLE — what's entering the root bin right now. Independent of
  // the wobble above on purpose: this is what makes DISTINCT slugs-and-gaps
  // rather than one continuous stream that merely speeds up and slows down.
  const dutyPhase = fract(tSec / dutyPeriodS + dutyPhaseOffset);
  const inject =
    smoothstep(0, DUTY_SOFT_EDGE, dutyPhase) * (1 - smoothstep(dutyFraction, dutyFraction + DUTY_SOFT_EDGE, dutyPhase));

  return { Q, inject };
}
