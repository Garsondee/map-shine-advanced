/**
 * THE MANTLE — the world's memory of weather, as pure arithmetic
 * (Precipitation.md §5).
 *
 * ============================================================================
 * LAW 4 — THE STAY IS DERIVED STATE, NEVER AUTHORED ART
 * ============================================================================
 *
 * Every number here is computed from weather history. Nothing in this module
 * reads, writes or overwrites an authored texture, and the buffer it describes
 * rebuilds from scratch on load (§5.5). The one authored input the whole
 * subsystem admits is PLACEMENT guidance (the optional `_Puddle` mask), which
 * positions what the mantle fills — derived never overwrites authored, and
 * authored never becomes derived.
 *
 * ============================================================================
 * ⭐ GAME TIME, AND THEREFORE A PAUSED GAME FREEZES THE MANTLE
 * ============================================================================
 *
 * Every rate here is PER GAME HOUR, and the caller integrates them against a
 * game-hour delta. That is the **integrator pattern** and it is correct: a
 * paused game has `dtGameHours = 0`, so the snow simply stops accumulating and
 * nothing melts.
 *
 * ⚠️ IT IS STATED HERE SO NOBODY "FIXES" IT INTO THE SIM-CLOCK-THROTTLE LATCH
 * (`feedback_throttle_on_sim_clock_latches_when_paused`) — the bug where a
 * throttle keyed to a stopped clock never fires again once the clock stops. The
 * difference is which side of the comparison the clock is on: a throttle asks
 * *"has enough sim time passed"* and deadlocks; an integrator asks *"how much
 * sim time passed"* and correctly answers zero. The Almanac walk got the same
 * ruling.
 *
 * ⚠️ AND THE **CADENCE** IS REAL TIME WHILE THE **AMOUNT** IS GAME TIME. Those
 * are two different clocks doing two different jobs and conflating them is how
 * the above goes wrong: the buffer is stepped a few times a second (real, so
 * the GPU work is bounded) and each step integrates whatever game time has
 * actually elapsed (game, so a fast clock deposits more per step rather than
 * more often).
 *
 * ============================================================================
 * WHY THIS FILE IS PURE
 * ============================================================================
 *
 * No THREE, no GPU, no clock of its own. The whole accumulation/melt/dry model
 * is a Node test long before a texel is written — which matters more here than
 * anywhere else in precipitation, because a mantle bug takes GAME HOURS to
 * become visible and is therefore the one thing nobody can iterate on by
 * looking. `mantle-runtime.js` is the thin GPU shell that uploads these numbers
 * as uniforms.
 *
 * @module effects/precipitation/mantle-model
 */

/**
 * The four channels of one RGBA8 texel — **one byte, one quantity, named**
 * (`feedback_one_byte_two_quantities`, a named bug class in this project).
 *
 * ⚠️ `dust01` IS ONE CHANNEL FOR ASH **AND** SAND, and that is a considered
 * merge rather than an oversight: they are the same physical thing (a blanket
 * that dims and desaturates) differing only in tint, two dust species do not
 * co-occur in practice, and the EVENT that summons one owns the palette while
 * it runs. Snow gets its own channel because it is a different BLEND OP, not a
 * different colour — snow brightens, dust darkens
 * (`feedback_blend_neutral_element_is_per_blend`).
 */
export const MANTLE_CHANNELS = Object.freeze({
  snow01: 'r',
  dust01: 'g',
  puddle01: 'b',
  trample01: 'a',
});

/**
 * Where `auto` precipitation is cold enough to lie as snow rather than run as
 * water — the SAME band `world/weather.js#derivePrecipKind` uses to decide what
 * falls.
 *
 * ⚠️ IMPORTED THROUGH THE ZONE DOOR (`world/index.js`), NOT RESTATED, and
 * both halves of that matter. Two copies of
 * "what counts as freezing" is `feedback_shared_field_two_meanings_two_
 * registries` waiting to happen: a map could then fall snow that instantly
 * melted, or rain that piled up, because the faller and the mantle disagreed
 * about the same temperature by 0.05.
 */
import { PRECIP_SLEET_BAND } from '../../world/index.js';

/**
 * How hot it has to get before snow melts at its full rate.
 *
 * The melt ramp STARTS at the sleet band's warm edge — the exact temperature
 * above which the sky stops sending snow — so there is no window where snow
 * both falls and melts at once. It reaches full melt well below boiling because
 * `temperature01` is a game-feel axis, not degrees.
 */
const MELT_FULL_AT = 0.72;

/**
 * Snow depth lost per game hour at `MELT_FULL_AT` and above — a covered
 * courtyard is bare in well under a game hour of real warmth.
 *
 * ⚠️ IT MUST EXCEED THE HEAVIEST DEPOSIT (`SNOW_RATE_PER_HOUR`), and the
 * first value did not — 0.68 against a 0.8/hour blizzard, which left the
 * equilibrium depth ABOVE 1 and made "warm" and "freezing" seed the identical
 * saturated drift. That is not a tuning miss but a broken STATE: if melt cannot
 * out-run accumulation there is no temperature at which snow fails to lie, and
 * the temperature axis stops meaning anything spatially. Pinned by an assertion
 * rather than left to arithmetic nobody re-checks.
 */
const MELT_PER_HOUR_MAX = 1.5;

/**
 * ⭐ Snow depth lost per game hour directly inside a fire's own footprint.
 *
 * ⚠️ MUCH FASTER THAN AMBIENT MELT, deliberately: a hearth should hold its
 * ground against a blizzard, which means fire melt has to out-run the
 * accumulation rate rather than merely subtract from it. At 3.5/hour against
 * snow's 0.8/hour deposit, a lit hearth stays bare through the heaviest
 * snowfall the table can produce — and the halo is free, because the fire
 * mask's own falloff shapes it. Nobody authors a melt ring.
 */
const FIRE_MELT_PER_HOUR = 3.5;

/** Puddle depth lost per game hour, at the driest (hot + clear). */
const DRY_PER_HOUR_MAX = 0.42;
/** …and at the wettest (cold + fully overcast). Never zero: a puddle under a
 * grey sky still drains, it just takes most of a day. */
const DRY_PER_HOUR_MIN = 0.06;

/** How long a footprint takes to heal, in game hours, once nothing renews it.
 * ⚠️ Consumed by the runtime's recover term; the STAMP that creates a
 * footprint is not built (see `mantle-runtime.js`'s scope note). */
const TRAMPLE_RECOVER_HOURS = 3;

/**
 * Snow's accumulation rate at `precip01 = 1`, in depth per game hour.
 * A hard snowfall whitens open ground in a little over an hour, which is the
 * pace that reads as weather rather than as a fade-in.
 */
export const SNOW_RATE_PER_HOUR = 0.8;
/** Rain's puddle fill rate at `precip01 = 1`. Slower than snow settles,
 * because water runs off before it pools. */
export const PUDDLE_RATE_PER_HOUR = 0.55;

/**
 * ⭐ HOW FAST SNOW BURIES A FOOTPRINT, relative to how fast it accumulates.
 *
 * §5.2: *"fresh snowfall buries footprints — the mantle HEALS, which is what
 * makes disturbing it delicious."* Faster than 1× on purpose: a print is a
 * shallow dent, so it fills before the surrounding depth visibly rises, which
 * is both true and the more satisfying order of events.
 */
const BURY_RATE_MUL = 2.5;

/**
 * ⭐ HOW MUCH GAME TIME PASSED, from a clock that WRAPS.
 *
 * ⚠️ `todHour` IS 0..24 AND WRAPS AT MIDNIGHT, so the obvious `now - prev`
 * is wrong twice a session: crossing midnight reads as **−23.98 hours**, which
 * an accumulator clamps to zero (the mantle silently stalls for one step) and a
 * melt term would run backwards on. Foundry's clock can also run BACKWARDS —
 * `rateHoursPerMinute` is legal from −60 to 60 — so "just add 24 when negative"
 * turns a small rewind into a 24-hour leap forward, which is worse.
 *
 * The shortest SIGNED delta is the only reading that is right in both
 * directions: map the difference into (−12, 12]. A real jump larger than half a
 * day is indistinguishable from a wrap by any method — the information is
 * genuinely not in the two numbers — and reading it as the small delta is the
 * safe half of that ambiguity, because the alternative deposits half a day of
 * snow in one step.
 *
 * @param {number|null} prevHour - null on the first call (nothing elapsed yet).
 * @param {number} nowHour
 * @returns {number} game hours elapsed, never negative.
 */
export function gameHourDelta(prevHour, nowHour) {
  if (prevHour === null || !Number.isFinite(prevHour) || !Number.isFinite(nowHour)) return 0;
  // ⚠️ `+ 24`, AND THE FIRST CUT WROTE `+ 36`, WHICH SILENTLY RETURNED ZERO
  // FOREVER. 36 mod 24 is 12, so every delta came back shifted half a day: an
  // ordinary 0.2-hour tick landed at 12.2, tripped the `> 12` wrap branch, and
  // resolved to −1.8 → clamped to 0. The mantle integrated nothing at all
  // while every rate beside it was correct and every Node assertion stayed
  // green — because the suite tested `resolveMantleStep` and the SEED, and not
  // this function, which existed precisely because the wrap was the subtle
  // part. The bench found it in one readback. Pinned by assertions now.
  const signed = (((nowHour - prevHour) % 24) + 24) % 24;
  const shortest = signed > 12 ? signed - 24 : signed;
  // A clock running backwards does not un-melt snow. The mantle integrates
  // forward only; rewinding is the GM's business, not the weather's.
  return Math.max(0, shortest);
}

/**
 * Everything the integrator needs for one step, from the weather axes.
 *
 * PURE. Returns RATES (per game hour) and one DELTA (`dtGameHours`), never a
 * new depth — the depth lives in the buffer and only the GPU touches it. That
 * split is what keeps this file testable: a rate is checkable arithmetic, a
 * texel is not.
 *
 * @param {object} inputs
 * @param {object|null} inputs.stay - the active species' `stay` block, or null
 *   when nothing is falling. Null is a legitimate, common answer — a clear day
 *   still runs the integrator so melt and drying continue.
 * @param {number} inputs.precip01
 * @param {number} inputs.temperature01
 * @param {number} [inputs.cloudCover01=0] - drying is slower under an overcast
 *   sky. Upstream and free (`world/weather.js` already eases it).
 * @param {number} inputs.dtGameHours - game hours since the last step. ZERO on
 *   a paused game, which is exactly why nothing moves then.
 * @returns {Readonly<object>} the uniform set, all finite, all clamped.
 */
export function resolveMantleStep({ stay, precip01, temperature01, cloudCover01 = 0, dtGameHours }) {
  const p = clamp01(precip01);
  const temp = clamp01(temperature01);
  const cover = clamp01(cloudCover01);
  // ⚠️ CLAMPED AT BOTH ENDS. Negative is nonsense (time does not run backwards
  // here), and an unbounded positive — a scene resumed after hours away, or a
  // GM spinning the clock — would deposit a whole winter in one step and read
  // as a bug. The cap is a game HOUR, so a fast clock still moves fast; it just
  // cannot teleport.
  const dt = Number.isFinite(dtGameHours) ? Math.min(1, Math.max(0, dtGameHours)) : 0;

  const channel = stay?.channel ?? null;
  const rate = Number.isFinite(stay?.ratePerHour) ? stay.ratePerHour : 0;
  const puddleRate = Number.isFinite(stay?.puddleRatePerHour) ? stay.puddleRatePerHour : 0;

  return Object.freeze({
    dtGameHours: dt,
    /** Depth per hour added to `snow01` where sky reaches. Zero unless the
     * ACTIVE species feeds that channel — rain falling in a snowy scene must
     * not thicken the drifts it is washing away. */
    snowGainPerHour: channel === 'snow' ? rate * p : 0,
    /** Same, for `dust01` (ash/sand — P6's species, the channel is ready). */
    dustGainPerHour: channel === 'dust' ? rate * p : 0,
    /** Puddle fill. Read off the species row rather than assumed from `rain`,
     * so sleet and (later) hail can pool at their own rates without a branch
     * appearing here. */
    puddleGainPerHour: puddleRate * p,
    /** Ambient melt, from the manager's temperature axis — its first VISIBLE
     * SPATIAL consumer (until now temperature only chose what fell). */
    meltPerHour: meltPerHour(temp),
    /** ⭐ Melt inside a fire's footprint, scaled by the fire mask. Snow
     * retreats in a halo around every burning hearth and nobody authored it. */
    fireMeltPerHour: FIRE_MELT_PER_HOUR,
    /** Puddles outlive the rain; sun dries them faster than overcast does. */
    dryPerHour: dryPerHour(temp, cover),
    /** Footprints heal. */
    trampleRecoverPerHour: 1 / TRAMPLE_RECOVER_HOURS,
    /** Falling snow fills prints faster than it raises the surface. */
    trampleBuryPerHour: channel === 'snow' ? rate * p * BURY_RATE_MUL : 0,
  });
}

/**
 * Ambient melt rate. Flat zero below the sleet band's warm edge — snow that is
 * still cold enough to be FALLING must not simultaneously be melting, or a
 * blizzard would fight itself to a standstill at some middling depth and the
 * ground would never whiten.
 * @param {number} temp01 @returns {number}
 */
export function meltPerHour(temp01) {
  const t = clamp01(temp01);
  const lo = PRECIP_SLEET_BAND.warmEdge;
  if (t <= lo) return 0;
  const x = Math.min(1, (t - lo) / Math.max(1e-6, MELT_FULL_AT - lo));
  // Smoothstep rather than linear: the interesting temperatures are the ones
  // near freezing, and a linear ramp makes the first degree above the band melt
  // as hard as the tenth.
  return MELT_PER_HOUR_MAX * x * x * (3 - 2 * x);
}

/**
 * Drying rate for standing water. Hot and clear dries fastest; cold and
 * overcast slowest, but NEVER zero — a puddle that literally cannot dry is a
 * permanent scar on a map, and "it rained here once, three months ago" is not a
 * feature.
 * @param {number} temp01 @param {number} cover01 @returns {number}
 */
export function dryPerHour(temp01, cover01) {
  const t = clamp01(temp01);
  const c = clamp01(cover01);
  const warmth = t * (1 - 0.65 * c);
  return DRY_PER_HOUR_MIN + (DRY_PER_HOUR_MAX - DRY_PER_HOUR_MIN) * warmth;
}

/**
 * ⭐ §5.5 PERSISTENCE — what depth the mantle should be seeded to on load,
 * from the weather that has recently been in force.
 *
 * ⚠️ THE MANTLE IS NOT SERIALIZED, AND THAT IS A DECISION RATHER THAN A GAP.
 * Writing it to the scene costs a save-format commitment the current goal
 * (release maps frequently, reliably) does not want yet — it is parked in the
 * idea notebook. So a reload REDERIVES: the same axes that produced the snow
 * produce it again, which is what LAW 4 promised when it said the buffer
 * rebuilds from scratch.
 *
 * ⚠️ IT IS A **UNIFORM** DEPTH, and the honest consequence is that footprints
 * and melt halos do not survive a reload. They are ephemeral and proudly so;
 * pretending otherwise would need the serialization this deliberately refuses.
 * The runtime multiplies this by `skyReach` per texel, so the SHAPE of the
 * cover is still right on the first frame — only its history is gone.
 *
 * @param {object} inputs
 * @param {object|null} inputs.stay
 * @param {number} inputs.precip01
 * @param {number} inputs.temperature01
 * @param {number} [inputs.hoursOfWeather=3] - how long the current sky is
 *   assumed to have been in force. Not a guess dressed as data: three game
 *   hours is *"long enough for this weather to have done its work"*, and the
 *   equilibrium below dominates it for any longer window anyway.
 * @returns {Readonly<{snow01: number, dust01: number, puddle01: number}>}
 */
export function seedMantleDepth({ stay, precip01, temperature01, hoursOfWeather = 3 }) {
  const step = resolveMantleStep({ stay, precip01, temperature01, dtGameHours: 0 });
  const hours = Number.isFinite(hoursOfWeather) ? Math.max(0, hoursOfWeather) : 0;
  return Object.freeze({
    snow01: equilibrium(step.snowGainPerHour, step.meltPerHour, hours),
    dust01: equilibrium(step.dustGainPerHour, 0, hours),
    puddle01: equilibrium(step.puddleGainPerHour, step.dryPerHour, hours),
  });
}

/**
 * Where a gain/loss pair settles after `hours`, clamped to a real depth.
 *
 * `d(t) = (gain/loss)·(1 − e^(−loss·t))` is the closed form of the same
 * integrator the GPU runs — so a seeded scene lands exactly where a scene that
 * had actually been running would be, rather than somewhere plausible.
 *
 * ⚠️ THE `loss ≈ 0` BRANCH IS NOT DEFENSIVE PADDING: it is the physically
 * common case (dust never melts, and snow below freezing has NO ambient sink at
 * all), where the exponential degenerates to plain linear accumulation and the
 * closed form would divide by zero.
 */
function equilibrium(gainPerHour, lossPerHour, hours) {
  if (!(gainPerHour > 0)) return 0;
  if (!(lossPerHour > 1e-6)) return Math.min(1, gainPerHour * hours);
  const settled = gainPerHour / lossPerHour;
  return Math.min(1, settled * (1 - Math.exp(-lossPerHour * hours)));
}

/** @param {*} v @returns {number} */
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
