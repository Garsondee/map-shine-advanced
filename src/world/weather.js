/**
 * THE WEATHER MANAGER — the ONE owner of "what is the weather doing", and the
 * only thing allowed to move those numbers.
 *
 * ============================================================================
 * WHY THIS MODULE EXISTS (docs/planning/Weather-Manager.md — the plan it builds)
 * ============================================================================
 *
 * `world/environment.js#buildEnvSnapshot` has taken a `weather` argument since
 * the day it was written, and until now NOBODY OWNED IT. `effects/sky-access.js`
 * and `effects/shadow-access.js` both carry dated headers saying so ("a real
 * source" / "the last acknowledged gap in the env snapshot"), and the viewer
 * passed a single bare scalar it called an override. So the atmospheric half of
 * two shipped light models could only ever be driven by hand, one number at a
 * time, with no easing and no other axis reachable at all.
 *
 * This module is that owner. Arrows still point one way, and the direction is
 * the whole reason V2's weather is a cautionary tale rather than a feature:
 *
 *     day-clock (owns todHour) → sun = f(todHour) ─┐
 *                                                  ├→ env snapshot → consumers
 *     weather manager (owns the axes) ─────────────┘
 *
 * Time is UPSTREAM of weather and never inside it. V2 put the clock INSIDE
 * `WeatherController.js` (`this.timeOfDay = 12.0`) and the two systems that
 * should have composed became hierarchically entangled. This module READS an
 * hour when it needs one (slice 3's walk) and never advances it.
 *
 * ============================================================================
 * LAW 1 — TWO MODES, ONE WRITE PATH (Weather-Manager.md §1)
 * ============================================================================
 *
 * `director` — the GM's exact sky. Targets are set by hand and then HELD.
 * `almanac`  — a biome table walks the SAME targets on its own (slice 3).
 *
 * The walk is an automated hand on the same sliders. There is exactly one
 * `setTargets` and exactly one ease engine, so no consumer can tell which mode
 * is running and no axis can exist in one mode but not the other. That is
 * `feedback_mode_forks_silently_drop_features` pre-empted rather than survived —
 * the same discipline that keeps the cloud design's zoom regimes a ladder rung
 * instead of a fork.
 *
 * ⚠️ SLICES 1-2 SHIPPED DIRECTOR ONLY. `setMode('almanac')` was REJECTED
 * (returned false) through slice 2, because a mode that is stored but does
 * nothing is `feedback_seam_default_hides_unwired` wearing a mode's clothes.
 * Slice 3 (below) is what makes the refusal no longer necessary — `almanac` is
 * now a real, ticking walk, not a label. The refusal shape survives as the
 * pattern for the NEXT half-built mode this project ever adds: `setMode` for
 * an unbuilt option should say so loudly, exactly as `day-clock.js#setHour`
 * does for `synced`, rather than accept a value that does nothing.
 *
 * ============================================================================
 * SLICE 3 — THE ALMANAC: a semi-Markov walk over the archetype table
 * (Weather-Manager.md §5.2-§5.4)
 * ============================================================================
 *
 * A biome (`world/weather-biomes.js`) is a GRAPH over the 13 archetypes
 * (`world/weather-data.js`): edges, each with a weight and an optional
 * time-of-day curve. On entering a node the walk draws a DWELL (a triangular
 * sample from that archetype's `{min, mean, max}` game-hours) from a seeded,
 * snapshot/restore-able generator (`world/weather-rng.js`); when the dwell
 * expires it re-rolls among the outgoing edges, weighted by `weight ×
 * todCurve(hour)`, and applies the winner's axes through the SAME
 * `setTargets`/ease pipeline director mode always used (LAW 1, unbroken).
 *
 * ⚠️ PINS are the one place Almanac and Director diverge in BEHAVIOUR, never
 * in MECHANISM: dragging an axis slider in Almanac mode marks that axis
 * pinned, and the walk's own automatic transitions then skip it — the GM's
 * hand-tuned value survives until explicitly released. A GM's shelf click is
 * the opposite gesture (a full, deliberate override): it clears every pin and
 * tells the walk to adopt the clicked archetype as its new current node
 * immediately, redrawing a fresh dwell — "the Almanac takes requests."
 *
 * ⚠️ THE FORECAST IS A CLONE, NEVER A PEEK AT LIVE STATE. `forecast()` snapshots
 * the live RNG (`fromState(rng.getState())`) and replays the identical walk
 * logic on the CLONE — the live generator, current node and dwell are never
 * touched. That is what makes "running the walk ahead without applying it"
 * free rather than a second, parallel implementation that could disagree with
 * the real one. One function, `advanceWalk` below, drives both the live tick
 * and every forecast call.
 *
 * ============================================================================
 * SLICE 4 — EVENTS: A READ-TIME OVERLAY, NEVER A SECOND WRITE PATH
 * (Weather-Manager.md §6.1-§6.2, `world/weather-events.js`)
 * ============================================================================
 *
 * An event (`ash-storm`, `eclipse`, ...) is a closed-list drama that rides on
 * top of whatever `state` already is, for a while. It is deliberately NOT
 * implemented by writing into `targets`/`state` the way the walk and the GM's
 * own hand do: `weather-events.js#applyEventOverrides` is a PURE function
 * called only at snapshot/status read time, and this module's own `state` is
 * never touched by an event. Two reasons:
 *
 *   1. If an event wrote into `state`, ending it early (`removeEvent`, or a
 *      release cut short) would need the ease engine to "catch up" from
 *      wherever the event left the axis back to the walk/director's true
 *      target — a second kind of motion the arrival-snap/epsilon logic above
 *      was never built to reason about, and a discontinuity waiting to happen.
 *   2. `feedback_composite_only_terms_miss_shared_buffers`'s own lesson,
 *      generalised: compose at the READ site, never corrupt the STORED value.
 *      The walk's own continuity (and a GM's pinned slider) must stay exactly
 *      as true while an ash-storm is blowing as the moment before it started.
 *
 * So `read()` (what the astrolabe's sliders show) stays pure — a GM dragging
 * `cloudCover01` during an ash-storm is editing the BASE value, not fighting
 * a temporarily event-inflated number. Only `toSnapshotWeather()` (what
 * shaders/consumers read) and `getStatus()` (diagnostics) show the composed,
 * re-clamped view. `version` does not bump on an event's own envelope ramp,
 * for the identical reason it does not bump on the ease: that is motion, not
 * a configuration change (see `version`'s own doc below).
 *
 * ============================================================================
 * ⚠️ THE CLOCK RULING — EASES RUN ON REAL TIME (Weather-Manager.md §4.1)
 * ============================================================================
 *
 * `tick(dtRealSec)` takes the WALL delta (`env.time.realDtSec`), not the sim
 * delta every effect reads. Two reasons, and the distinction matters enough
 * that getting it backwards would be a real bug in either direction:
 *
 *   1. An ease is PRESENTATION PACING — the same family as V2's
 *      `SPRITE_FADE_DURATION_SEC = 10`, whose one universally-praised property
 *      was that clouds never popped. Pacing should not stretch because a GM
 *      slowed the world down.
 *   2. It is NOT the `feedback_throttle_on_sim_clock_latches_when_paused` trap.
 *      That bug is a THROTTLE comparing `now - last` against an interval on a
 *      clock that stops. This is an INTEGRATOR consuming a delta; handed a sim
 *      delta of 0 it would simply stop advancing, which is a different (still
 *      wrong) failure. Real time is correct here for reason 1, and stating both
 *      halves stops a future session from "fixing" this into the actual bug.
 *
 * ⚠️ THE WALK (slice 3) IS THE OPPOSITE and deliberately so: it integrates GAME
 * time, so a paused session's sky holds still and a GM running the clock at 60
 * game-hours per real minute gets a week of weather. Two different clocks for
 * two different jobs, both written down before either was built.
 *
 * ============================================================================
 * THE EASE — exponential, direction-dependent, and it actually ARRIVES
 * ============================================================================
 *
 * Every axis walks toward its target as `x += (target - x) * (1 - e^(-dt/tau))`.
 * Frame-rate independent, monotone, and incapable of overshoot because the
 * blend factor is bounded to [0,1) — so a cover slider can never ring past its
 * target and come back, which on a full-screen ambient multiply would read as a
 * flicker rather than as weather.
 *
 * ⚠️ AXES DECLARE A **DURATION**, NOT A TAU (author-instructed retune,
 * 2026-08-16). The first cut of this table stored the exponential time constant
 * directly, and the numbers Weather-Manager.md §4.1 proposed were read as if
 * they were durations — they are not. A tau of 120s means ~63% of the way
 * there in two minutes and roughly SIX before the change looks finished; a GM
 * clearing an overcast sky waited about twenty minutes for it to land exactly.
 * That is not "clouds never pop", it is a control that looks broken.
 *
 * So the table now declares `durationUpSec`/`durationDownSec` — *how long the
 * transition takes to LOOK done* — and the engine derives `tau = duration /
 * SETTLE_TAUS`. A config number now means what a reader assumes it means, which
 * is the same honesty rule this codebase applies to its instruments
 * (`feedback_instruments_must_not_lie`), applied to a tuning table.
 *
 * The DIRECTION asymmetry survives the retune unchanged, because it was never
 * the problem: skies build a little faster than they scrub clean, and V2's one
 * genuinely great dynamic (wind accelerating fast and decelerating ~7x lazier,
 * `cloud-wind-advection.js`) is this same asymmetry. Only the magnitudes moved.
 *
 * An exponential asymptotes and never technically arrives, so each axis declares
 * an `epsilon` and snaps the remainder — otherwise `settling` would never go
 * false and any consumer gated on "has the weather stopped moving" would hang
 * forever. `world/day-clock.js#SYNC_ARRIVAL_HOURS` solved the identical problem
 * for the same reason. ⚠️ Those epsilons are now PERCEPTUAL rather than
 * arbitrary: `1/500` on a unit axis is half a step of 8-bit output, so the
 * snap is provably invisible. The first cut used `1e-4`, which is ~25x below
 * anything renderable and bought nothing but a longer tail of `settling: true`.
 *
 * Pure and Node-testable: it holds state but takes every input as an argument
 * and touches nothing global — no Foundry, no clock, no DOM.
 *
 * @module world/weather
 */

import { resolveArchetype, matchArchetype } from './weather-data.js';
import { resolveBiome, evalTodCurve } from './weather-biomes.js';
import { createRng, fromState, triangular, weightedPick } from './weather-rng.js';
import { normalizeHour } from './sun.js';
import { resolveEventKind, envelopePhase, applyEventOverrides, OVERRIDE_OPS } from './weather-events.js';

/**
 * The two authority modes. A CLOSED LIST — an unknown mode string falls back to
 * `director` rather than producing a fourth, undocumented behaviour
 * (`feedback_category_string_must_be_in_closed_list`).
 */
export const WEATHER_MODES = Object.freeze(['director', 'almanac']);

/**
 * How many time constants count as "the transition has visibly finished".
 *
 * Three is the standard engineering answer — `1 - e^-3` is 95%, and the last 5%
 * of a cloud-cover change is not something an eye can find on a lit map. This is
 * the ONE place the duration→tau conversion lives, so a future change to what
 * "done" means cannot land in one axis and miss the others.
 */
export const SETTLE_TAUS = 3;

/**
 * How fast transitions run, as a multiplier on every axis's declared duration.
 *
 * `instant` is not a small number, it is ZERO — a genuine snap, for scene setup
 * and for `jumpTo`'s own path. A "very small duration" would still take frames
 * to land and would make a scene load visibly settle, which is an artefact of
 * nothing.
 *
 * ⚠️ `brisk` is the DIRECTOR default and it is deliberately the fast one. The
 * GM authoring a map needs to see the sky they clicked; the GM running a session
 * wants weather to arrive inside a scene beat. `realistic` is there for the
 * Almanac, where nobody is waiting on the result and a sky taking its time is
 * the whole point.
 */
export const TRANSITION_SPEEDS = Object.freeze({
  instant: 0,
  brisk: 1,
  realistic: 3,
});

/** @type {readonly string[]} */
export const TRANSITION_SPEED_NAMES = Object.freeze(Object.keys(TRANSITION_SPEEDS));

/**
 * Perceptual arrival thresholds — how close counts as arrived.
 *
 * `UNIT` is half a step of 8-bit output: a 0..1 axis this close to its target
 * cannot change a rendered pixel, so snapping the remainder is invisible by
 * construction rather than by taste. `LENGTH_PX` is one world pixel, which is
 * below the resolution of anything that consumes an altitude or a feature size.
 */
export const AXIS_EPSILON_UNIT = 1 / 500;
export const AXIS_EPSILON_LENGTH_PX = 1;

/**
 * THE AXIS TABLE — the state vector, as data.
 *
 * Slice 1 carries the four CLOUD axes (Weather-Manager.md §13). The engine
 * itself is generic over this table, so slices 2-7 add rows rather than code.
 *
 * `consumerStatus` is not decoration and it is not a comment: it is the
 * machine-readable half of `feedback_unconsumed_api_rots_silently`. `'live'`
 * means something in `src/` reads this axis TODAY; `'pending'` means the axis
 * is carried on the call sheet but nothing consumes it yet. The status report
 * prints it, so "this axis does nothing" is a fact a diagnostic can state
 * rather than a thing somebody has to remember. An axis whose consumer lands
 * flips its own row in the same commit that wires it.
 *
 * ⚠️ `cloudCover01`'s default MUST stay 0. `world/environment.js`'s
 * `DEFAULT_WEATHER` is a clear sky, three shipped consumers already read it,
 * and Weather-Manager.md LAW 5 turns on this file agreeing: manager-on +
 * director + clear must be a mathematical no-op against today's frame.
 */
export const WEATHER_AXES = Object.freeze({
  cloudCover01: Object.freeze({
    min: 0,
    max: 1,
    fallback: 0,
    // A front arriving overhead: fast enough to land inside a scene beat, slow
    // enough that the light visibly CHANGES rather than cutting. Clearing is
    // lazier than building — the asymmetry V2's wind advection got right.
    durationUpSec: 45,
    durationDownSec: 60,
    epsilon: AXIS_EPSILON_UNIT,
    consumerStatus: 'live',
    /** effects/shadow-access.js (softens + fades every caster),
     *  effects/sky-access.js (kills the key, lifts the fill, raises the veil),
     *  effects/grade (the environmental ToD/weather look). */
    consumers: 'shadow-access, sky-access, env grade',
  }),
  cloudType01: Object.freeze({
    min: 0,
    max: 1,
    fallback: 0.5,
    // The SHAPE axes move at half the speed of cover, in both directions. A sky
    // does not change genus as readily as it fills in, and keeping these slower
    // is what stops an archetype switch reading as one instantaneous restyle.
    durationUpSec: 90,
    durationDownSec: 90,
    epsilon: AXIS_EPSILON_UNIT,
    consumerStatus: 'pending',
    /** The cirrus(0) → cumulus(0.5) → stratus(1) ramp, Clouds.md §3.1. */
    consumers: 'world/cloud-field.js (not built)',
  }),
  cloudAltitudePx: Object.freeze({
    min: 100,
    max: 6000,
    fallback: 1400,
    durationUpSec: 90,
    durationDownSec: 90,
    epsilon: AXIS_EPSILON_LENGTH_PX,
    consumerStatus: 'pending',
    /** Clouds.md's ONE knob: shadow offset, softness, parallax, drift, sky hidden. */
    consumers: 'world/cloud-field.js (not built)',
  }),
  cloudScalePx: Object.freeze({
    min: 50,
    max: 8000,
    fallback: 1100,
    durationUpSec: 90,
    durationDownSec: 90,
    epsilon: AXIS_EPSILON_LENGTH_PX,
    consumerStatus: 'pending',
    consumers: 'world/cloud-field.js (not built)',
  }),

  // ── PRECIPITATION (P1, docs/planning/Precipitation.md) ────────────────────
  // The unconsumed-axis rule discharged: these ship in the slice that wires
  // their first real consumer, which is `effects/particles/precip-runtime.js`.
  precip01: Object.freeze({
    min: 0,
    max: 1,
    fallback: 0,
    // Weather-Manager.md §4.1's own row: rain arrives brisk and tapers long.
    // A shower that took as long to start as the cloud deck does would read as
    // the sky deciding rather than as weather arriving.
    durationUpSec: 30,
    durationDownSec: 60,
    epsilon: AXIS_EPSILON_UNIT,
    consumerStatus: 'live',
    consumers: 'effects/precipitation (the FALL), wetness integrator (P3)',
  }),
  temperature01: Object.freeze({
    min: 0,
    max: 1,
    fallback: 0.55,
    // ⚠️ THE SLOWEST AXIS IN THE TABLE, and deliberately: thermal mass is real.
    // A map does not go from snowing to raining inside a scene beat, and the
    // derived `precipKind` flip that rides this axis would otherwise strobe
    // between species every time a GM nudged the slider.
    durationUpSec: 240,
    durationDownSec: 240,
    epsilon: AXIS_EPSILON_UNIT,
    consumerStatus: 'live',
    consumers: 'precipKind derivation (below), wetness dry-rate (P3)',
  }),
});

/** @type {readonly string[]} */
export const WEATHER_AXIS_NAMES = Object.freeze(Object.keys(WEATHER_AXES));

/**
 * WHAT IS FALLING — a closed list (`Precipitation.md` §2.2 + Weather-Manager.md
 * §2.1's `precipKindAuthored` enum).
 *
 * ⚠️ THIS IS DELIBERATELY **NOT** AN ENTRY IN {@link WEATHER_AXES}, and the
 * reason is structural rather than stylistic: every axis in that table is
 * EASED, and `easeToward` interpolates a NUMBER. There is no meaningful value
 * 40% of the way between `snow` and `ash`. Storing an enum in a table whose
 * whole contract is "this value slews continuously toward its target" would be
 * `feedback_one_byte_two_quantities` in its purest form — so the kind lives
 * beside the axes as its own setting, and the BLEND between two kinds is
 * expressed the way a blend should be: as a weight (see
 * {@link derivePrecipKind}'s `mixWeight`).
 */
export const PRECIP_KINDS = Object.freeze(['auto', 'rain', 'snow', 'sleet', 'hail', 'ash', 'embers']);

/**
 * The temperature band across which `auto` yields SLEET.
 *
 * ⚠️ A BAND, NOT A THRESHOLD, and this is a recorded amendment rather than a
 * choice made here: Weather-Manager.md §2.2 originally derived `precipKind` as
 * `temperature01 < 0.25 ? snow : rain` — one hard edge. `Precipitation.md` §2.5
 * asked for a band, and §2.2 was amended to match. A single threshold means a
 * GM dragging temperature past 0.25 sees the entire sky change species between
 * one frame and the next; a band gives the mix weight somewhere to ramp, which
 * is what makes sleet a real state rather than a label.
 *
 * ⚠️ THE BAND IS CLOSED AT BOTH ENDS (`<=` / `>=` below), because
 * `feedback_half_open_band_excludes_its_own_member` is a named bug class here:
 * a half-open band would make `temperature01 === 0.30` yield pure rain with a
 * mix weight of 1, i.e. the one input that should be MOST sleet-like reading as
 * not sleet at all.
 */
export const PRECIP_SLEET_BAND = Object.freeze({ coldEdge: 0.2, warmEdge: 0.3 });

/**
 * Derive what is actually falling, and (inside the sleet band) how the two
 * species mix.
 *
 * ONE derivation, ONE place (Weather-Manager.md §2.2's rule) — the runtime,
 * the UI and any future front script all read this rather than each re-deriving
 * from temperature, which is how two consumers end up disagreeing about what
 * the weather is.
 *
 * @param {string} authored - a member of {@link PRECIP_KINDS}. Anything but
 *   `auto` WINS OUTRIGHT: a GM who said "snow" gets snow at any temperature,
 *   because `feedback_derived_never_overwrites_authored` is LAW 4 upstream and
 *   an authored kind is the author's hand on the wheel.
 * @param {number} temperature01
 * @returns {Readonly<{kind: string, mixWeight: number, authored: boolean}>}
 *   `mixWeight` is how much of the COLD species is in the mix: 1 = all snow,
 *   0 = all rain, and only ever between the two inside the band. It is 0 for
 *   every non-sleet answer, so a consumer can multiply by it unconditionally.
 */
export function derivePrecipKind(authored, temperature01) {
  const t = Number.isFinite(temperature01) ? Math.min(1, Math.max(0, temperature01)) : 0.55;
  if (PRECIP_KINDS.includes(authored) && authored !== 'auto') {
    return Object.freeze({ kind: authored, mixWeight: authored === 'snow' ? 1 : 0, authored: true });
  }
  const { coldEdge, warmEdge } = PRECIP_SLEET_BAND;
  if (t < coldEdge) return Object.freeze({ kind: 'snow', mixWeight: 1, authored: false });
  if (t > warmEdge) return Object.freeze({ kind: 'rain', mixWeight: 0, authored: false });
  // Inside the band, inclusive of both edges. The weight runs 1 (all snow) at
  // the cold edge to 0 (all rain) at the warm one.
  const span = warmEdge - coldEdge;
  const w = span > 0 ? 1 - (t - coldEdge) / span : 0.5;
  return Object.freeze({ kind: 'sleet', mixWeight: Math.min(1, Math.max(0, w)), authored: false });
}

/**
 * The archetype label carried through to `env.weather.preset`.
 *
 * ⚠️ LAW 2: this is a LABEL OF INTENT for the UI and for diagnostics. No
 * shader, effect or handle may branch on it — they read axes, which are numbers
 * that can also be 0.3.
 *
 * ⚠️ It is DERIVED, never stored independently (slice 2). See the note where
 * `setPreset` used to be.
 */
export const DEFAULT_PRESET = 'clear';

/**
 * Fallback dwell used only if a biome row and the shared defaults both somehow
 * miss an archetype (cannot happen through the validated table in
 * `weather-biomes.js`, but a manager must not throw over a malformed biome
 * some future caller hands it directly).
 */
const FALLBACK_DWELL_HOURS = Object.freeze({ min: 1, mean: 3, max: 8 });

/** Volatility multiplier bounds — a quarter-speed to 4x-speed dwell scale. */
const VOLATILITY_MIN = 0.25;
const VOLATILITY_MAX = 4;

/**
 * Create the weather manager.
 *
 * @param {object} [options]
 * @param {string} [options.mode] - 'director' | 'almanac'.
 * @param {string} [options.transitionSpeed] - key of {@link TRANSITION_SPEEDS}.
 * @param {object} [options.initial] - starting axis values; each falls back
 *   INDEPENDENTLY to its own default, so one bad stored field cannot discard a
 *   scene's whole authored sky (`world/sky-settings.js#normalizeSky`'s rule).
 *
 *   ⚠️ There is no `preset` option, deliberately: the label is derived from
 *   these axes, so restoring a persisted sky restores its NAME for free and
 *   there is no second stored field that could contradict the first.
 * @param {number|string} [options.seed] - the Almanac's RNG seed. Fixed by
 *   default so two managers created identically draw the identical walk —
 *   deterministic unless a caller supplies its own `hashSeed(sceneId, epoch)`
 *   (`world/weather-rng.js`) for genuine per-scene variety.
 * @param {string} [options.biome] - starting biome id, if any.
 * @param {number} [options.volatility] - starting dwell-time multiplier.
 * @returns {object} the manager.
 */
export function createWeatherManager({
  mode = 'director',
  transitionSpeed = 'brisk',
  initial = null,
  seed = 'msa-weather-default-seed',
  biome = null,
  volatility = 1,
} = {}) {
  let currentMode = normalizeMode(mode);
  let speedName = normalizeSpeed(transitionSpeed);

  /** Where each axis is HEADED (the GM's hand, or the Almanac's walk). */
  const targets = {};
  /** Where each axis actually IS this frame — what consumers read. */
  const state = {};

  for (const name of WEATHER_AXIS_NAMES) {
    const v = clampAxis(name, initial?.[name]);
    targets[name] = v;
    state[name] = v;
  }

  /** The archetype these axes sit on, derived — see the `setPreset` note. */
  let currentPreset = matchArchetype(targets);

  // ── THE ALMANAC'S OWN STATE ──────────────────────────────────────────────
  /** Which axes the GM's own hand is currently protecting from the walk. */
  const pinnedAxes = new Set();
  /** The active climate, or `null` — Almanac mode with no biome chosen is a
   * legitimate idle state (the walk simply never advances), not an error. */
  let activeBiome = null;
  let almanacVolatility = clampVolatility(volatility);
  let almanacSeed = seed;
  let almanacRng = createRng(seed);
  /** The graph node the walk currently considers itself standing on — may
   * differ from `currentPreset` the moment a pin holds one axis away from
   * that node's own row; `currentPreset` is honest about the pixel, this is
   * honest about where the WALK thinks it is for transition purposes. */
  let almanacCurrentNodeId = null;
  /** Game-hours until the walk reconsiders. `null` before the first node is
   * ever chosen. */
  let almanacDwellRemainingHours = null;

  if (biome) {
    const res = resolveBiome(biome);
    activeBiome = res.biome;
  }

  // ── SLICE 4 — EVENTS' OWN STATE ──────────────────────────────────────────
  /** Real seconds since this manager was created — the events' own clock
   * (envelopes are presentation pacing, same family as the ease; see this
   * module's SLICE 4 header for why events use `dtRealSec`, not game time). */
  let elapsedRealSec = 0;
  /** id → { spec, startedAtRealSec, releasedAtRealSec }. A `Map` so insertion
   * order is preserved — `applyEventOverrides` folds events in that order. */
  const activeEvents = new Map();
  let nextAutoEventId = 1;

  /**
   * What the GM said is falling, or `auto` to let temperature decide. Beside
   * the axes rather than in them — see {@link PRECIP_KINDS}' own note on why an
   * enum cannot be an eased axis.
   */
  let precipKindAuthored = 'auto';

  /**
   * ⚠️ A CLOSURE, NOT A `this` METHOD — see {@link read}'s own note just below
   * for why: `getStatus` below calls THIS directly rather than
   * `this.getActiveEvents()`.
   * @returns {Array<{id: string, kind: string, intensity01: number, phase: string, progress01: number, elapsedRealSec: number}>}
   */
  function listActiveEvents() {
    const out = [];
    for (const [id, ev] of activeEvents) {
      const elapsedSinceStart = elapsedRealSec - ev.startedAtRealSec;
      const elapsedSinceRelease = ev.releasedAtRealSec == null ? null : elapsedRealSec - ev.releasedAtRealSec;
      const { phase, progress01 } = envelopePhase(ev.spec.envelope, elapsedSinceStart, elapsedSinceRelease);
      if (phase === 'done') continue;
      out.push(
        Object.freeze({
          id,
          kind: ev.spec.kind,
          intensity01: ev.spec.intensity01,
          phase,
          progress01,
          elapsedRealSec: elapsedSinceStart,
        })
      );
    }
    return out;
  }

  /**
   * Bumped on CONFIGURATION changes (a target moved, the mode or speed changed,
   * a jump landed) — NOT on eased motion.
   *
   * That distinction is the whole contract, and it is the one
   * `windHandle.version`/`shadowHandleVersion` already established: a consumer
   * caching something DERIVED from the weather wants to know when the intent
   * changed. Bumping every frame while an ease runs would make the version
   * useless as a cache key for exactly the two minutes it matters most, and a
   * consumer that needs the moving value already re-reads it from the frozen
   * snapshot every frame anyway.
   */
  let version = 0;

  /** @returns {boolean} true while any axis is still walking to its target. */
  function isSettling() {
    for (const name of WEATHER_AXIS_NAMES) {
      if (state[name] !== targets[name]) return true;
    }
    return false;
  }

  /**
   * The ONE place a raw value becomes a real target: axis range/fallback
   * first (`clampAxis`), then the active biome's `clamps` on top if Almanac
   * mode has one bound for this axis. "Clamps bound everything"
   * (Weather-Manager.md §5.2) means every write path funnels through here —
   * the walk's own picks, a GM's shelf click, and a GM's own slider drag
   * while a gloom-locked biome like `shadowfell-verge` is active.
   * @param {string} name @param {*} raw @returns {number}
   */
  function resolveTargetValue(name, raw) {
    let v = clampAxis(name, raw);
    const clamp = currentMode === 'almanac' ? activeBiome?.clamps?.[name] : null;
    if (clamp) {
      const spec = WEATHER_AXES[name];
      const lo = Number.isFinite(clamp.min) ? clamp.min : spec.min;
      const hi = Number.isFinite(clamp.max) ? clamp.max : spec.max;
      v = Math.min(hi, Math.max(lo, v));
    }
    return v;
  }

  /**
   * Draw one dwell, in game-hours, for `nodeId` under the active biome (or
   * the shared defaults, or the last-resort fallback — see
   * {@link FALLBACK_DWELL_HOURS}'s own note on why a manager must not throw
   * over a malformed biome).
   * @param {{next: () => number}} rng @param {string} nodeId @returns {number}
   */
  function sampleDwell(rng, nodeId) {
    const d = activeBiome?.dwellHours?.[nodeId] ?? FALLBACK_DWELL_HOURS;
    const hours = triangular(rng, d.min, d.mean, d.max);
    // Floored well above zero: volatility scales dwell, and a caller passing
    // an extreme value must not be able to produce a zero/negative dwell that
    // would spin the transition loop.
    return Math.max(0.05, hours * almanacVolatility);
  }

  /**
   * Apply one archetype's axes to `targets`, optionally skipping pinned ones.
   * The single place BOTH the walk's automatic picks and a GM's shelf click
   * write axis values, so `resolveTargetValue`'s clamp logic runs exactly once
   * per write regardless of which caller triggered it.
   * @param {string} nodeId @param {boolean} skipPinned
   */
  function applyNodeAxes(nodeId, skipPinned) {
    const res = resolveArchetype(nodeId);
    for (const [key, raw] of Object.entries(res.archetype.axes)) {
      if (!Object.hasOwn(WEATHER_AXES, key)) continue;
      if (skipPinned && pinnedAxes.has(key)) continue;
      targets[key] = resolveTargetValue(key, raw);
    }
  }

  /**
   * ⚠️ A CLOSURE, NOT A `this` METHOD — and `tick`/`jumpTo` below call THIS
   * rather than `this.read()`. `world/day-clock.js` is destructured at its call
   * site in `vt-pan-viewer.js`, and a `this.`-dependent method that survives
   * every Node test (where it is always called as `mgr.tick()`) would throw the
   * first time somebody wrote `const { tick } = weather`. Cheap to make
   * impossible; expensive to debug live.
   */
  function read() {
    return Object.freeze({
      mode: currentMode,
      transitionSpeed: speedName,
      preset: currentPreset,
      state: Object.freeze({ ...state }),
      targets: Object.freeze({ ...targets }),
      settling: isSettling(),
      version,
      // Which axes the GM's own hand is protecting from the walk — the
      // astrolabe's pin icons read this directly.
      pinnedAxes: Object.freeze([...pinnedAxes]),
    });
  }

  /**
   * Advance the Almanac's walk by `dtGameHours`, starting the graph search at
   * `hour` (for time-of-day-biased transitions) — internal, called from
   * {@link tick} on the LIVE rng/node/dwell, and from {@link forecast} on a
   * CLONE of them. One function drives both, so the live sky and its own
   * forecast can never silently disagree about what the walk would do.
   *
   * Loops rather than applying a single step, because a large `dtGameHours`
   * (a GM fast-forwarding the clock, or a forecast projecting hours ahead)
   * can cross more than one dwell boundary in a single call. Capped at
   * `maxSteps` as a defensive bound, not a realistic one — reaching it would
   * mean dwells averaging under a few minutes over the whole horizon.
   *
   * @param {object} args
   * @param {{next: () => number}} args.rng
   * @param {string|null} args.currentNodeId
   * @param {number} args.dwellRemainingHours
   * @param {number} args.startHour
   * @param {number} args.dtGameHours
   * @param {number} [args.maxSteps]
   * @returns {{currentNodeId: string|null, dwellRemainingHours: number, transitions: Array<{archetypeId: string, atGameHoursFromNow: number}>}}
   */
  function advanceWalk({ rng, currentNodeId, dwellRemainingHours, startHour, dtGameHours, maxSteps = 50 }) {
    const transitions = [];
    let nodeId = currentNodeId;
    let dwell = dwellRemainingHours;

    if (!activeBiome) return { currentNodeId: null, dwellRemainingHours: 0, transitions };

    if (nodeId == null) {
      nodeId = weightedPick(rng, Object.keys(activeBiome.archetypeWeights), (id) => activeBiome.archetypeWeights[id]);
      if (nodeId == null) return { currentNodeId: null, dwellRemainingHours: 0, transitions };
      dwell = sampleDwell(rng, nodeId);
      transitions.push({ archetypeId: nodeId, atGameHoursFromNow: 0 });
    }

    let remaining = Math.max(0, dtGameHours);
    let hoursElapsed = 0;
    let steps = 0;
    while (remaining > 0 && steps < maxSteps) {
      if (dwell > remaining) {
        dwell -= remaining;
        remaining = 0;
        break;
      }
      remaining -= dwell;
      hoursElapsed += dwell;
      const hourAtTransition = normalizeHour(startHour + hoursElapsed);
      const edges = activeBiome.transitions.filter((e) => e.from === nodeId);
      const next = weightedPick(rng, edges, (e) => e.weight * evalTodCurve(e.todCurve, hourAtTransition));
      if (next == null) {
        // No live edge right now — should not happen on a validated,
        // strongly-connected graph, but fail open by holding on the same
        // node and redrawing rather than spinning or throwing.
        dwell = sampleDwell(rng, nodeId);
        steps++;
        continue;
      }
      nodeId = next.to;
      dwell = sampleDwell(rng, nodeId);
      transitions.push({ archetypeId: nodeId, atGameHoursFromNow: hoursElapsed });
      steps++;
    }
    dwell -= remaining;

    return { currentNodeId: nodeId, dwellRemainingHours: dwell, transitions };
  }

  return {
    /**
     * Advance one frame.
     *
     * @param {number} dtRealSec - the WALL delta (`env.time.realDtSec`). See
     *   this module's header for why it is not the sim delta, and why that is
     *   not the sim-clock throttle trap.
     * @param {object} [almanacInputs] - present only for a caller that wants
     *   the Almanac to actually walk. Absent entirely, the walk simply never
     *   advances (safe for every Director-only call site, and LAW 5's spirit:
     *   no wiring, no surprise motion) — it is not almanac mode alone that
     *   drives the walk, it is almanac mode PLUS these inputs.
     * @param {number} [almanacInputs.dtGameHours] - GAME time elapsed this
     *   tick (the walk's own clock — see this module's header for why it is
     *   deliberately not `dtRealSec`). Negative/backward time is taken as its
     *   magnitude: the walk still counts down, it does not count UP.
     * @param {number} [almanacInputs.hour] - the current hour of day, 0..24,
     *   for time-of-day-biased transitions.
     * @returns {Readonly<object>} the same value as {@link read}.
     */
    tick(dtRealSec, almanacInputs) {
      const dt = Number.isFinite(dtRealSec) && dtRealSec > 0 ? dtRealSec : 0;
      const scale = TRANSITION_SPEEDS[speedName];
      elapsedRealSec += dt;

      // Sweep events whose envelope has fully finished (attack+sustain+release
      // all elapsed, or a release ramp that has run out) — otherwise a scene
      // that fires a lot of one-shot sky-flashes would grow `activeEvents`
      // forever. Reads the SAME `envelopePhase` the read-time overlay uses, so
      // "still active" can never disagree between the sweep and the snapshot.
      if (activeEvents.size > 0) {
        for (const [id, ev] of activeEvents) {
          const elapsedSinceStart = elapsedRealSec - ev.startedAtRealSec;
          const elapsedSinceRelease = ev.releasedAtRealSec == null ? null : elapsedRealSec - ev.releasedAtRealSec;
          if (envelopePhase(ev.spec.envelope, elapsedSinceStart, elapsedSinceRelease).phase === 'done') {
            activeEvents.delete(id);
          }
        }
      }

      // ⭐ THE WALK — game time, strictly separate from the real-time ease
      // below. Only runs with a real biome active; an Almanac mode with no
      // biome chosen is an intentional idle state, not a bug to work around.
      if (currentMode === 'almanac' && activeBiome) {
        const dtGameHours = Number.isFinite(almanacInputs?.dtGameHours) ? Math.abs(almanacInputs.dtGameHours) : 0;
        if (dtGameHours > 0) {
          const hour = Number.isFinite(almanacInputs?.hour) ? normalizeHour(almanacInputs.hour) : 12;
          const result = advanceWalk({
            rng: almanacRng,
            currentNodeId: almanacCurrentNodeId,
            dwellRemainingHours: almanacDwellRemainingHours ?? 0,
            startHour: hour,
            dtGameHours,
          });
          almanacCurrentNodeId = result.currentNodeId;
          almanacDwellRemainingHours = result.dwellRemainingHours;
          if (result.transitions.length > 0) {
            // Only the FINAL node in a multi-step jump needs to render — the
            // intermediate ones are real (a forecast projecting the same
            // horizon would show them), they just never became the live sky.
            const finalId = result.transitions[result.transitions.length - 1].archetypeId;
            applyNodeAxes(finalId, true);
            currentPreset = matchArchetype(targets);
            version++;
          }
        }
      }

      for (const name of WEATHER_AXIS_NAMES) {
        const target = targets[name];
        const current = state[name];
        if (current === target) continue;
        const spec = WEATHER_AXES[name];
        const duration = (target > current ? spec.durationUpSec : spec.durationDownSec) * scale;
        state[name] = easeToward(current, target, tauForDuration(duration), dt, spec.epsilon);
      }
      return read();
    },

    /**
     * Set where one or more axes are HEADED. The single write path both modes
     * use (LAW 1) — slice 3's walk calls exactly this.
     *
     * Unknown keys are REPORTED, never silently dropped: a typo'd axis name
     * that vanishes quietly is how a control ends up wired to nothing while
     * every test stays green (`feedback_seam_default_hides_unwired`).
     *
     * ⚠️ IN ALMANAC MODE THIS PINS EVERY AXIS NAMED IN `patch`. Dragging a
     * slider is the GM's hand on the wheel — the walk will not touch that
     * axis again until {@link unpinAxis}/{@link unpinAllAxes} releases it.
     * Pins regardless of whether the value actually moved: releasing a
     * slider back to where the walk already had it is still a deliberate
     * touch, not a no-op.
     *
     * @param {object} patch - axis name → value.
     * @returns {Readonly<{applied: string[], rejected: string[], version: number}>}
     */
    setTargets(patch) {
      const applied = [];
      const rejected = [];
      const p = patch && typeof patch === 'object' ? patch : {};

      for (const [key, raw] of Object.entries(p)) {
        if (!Object.hasOwn(WEATHER_AXES, key)) {
          rejected.push(key);
          continue;
        }
        const next = resolveTargetValue(key, raw);
        if (next !== targets[key]) {
          targets[key] = next;
          applied.push(key);
        }
        if (currentMode === 'almanac') pinnedAxes.add(key);
      }
      if (applied.length > 0) {
        // ⚠️ THE LABEL IS DERIVED, NEVER REMEMBERED. A hand edit that moves the
        // sky off its named row must stop calling it that row — otherwise a
        // scene sits at cover 0.2 still claiming to be `overcast`, the shelf
        // lights the wrong button, and the stored label and the stored axes are
        // two authorities for one fact (`feedback_shared_field_two_meanings_two_registries`,
        // in miniature). Recomputing from TARGETS is cheap and cannot drift.
        currentPreset = matchArchetype(targets);
        version++;
      }
      return Object.freeze({ applied, rejected, version, preset: currentPreset, pinnedAxes: [...pinnedAxes] });
    },

    /**
     * Apply a named sky (docs/planning/Weather-Manager.md §3.2) — the
     * astrolabe shelf's one gesture in EITHER mode.
     *
     * Sets every axis the row declares AND the label, together, so the two can
     * never disagree. Fails OPEN to `clear` on an unknown id and reports it: a
     * typo must not storm-lock a scene, but it must not be silent either.
     *
     * ⚠️ IN ALMANAC MODE THIS IS "THE ALMANAC TAKES REQUESTS"
     * (Weather-Manager.md §5.2): a full, deliberate override. It clears EVERY
     * pin — there is nothing left to protect once the whole sky was just
     * hand-picked — and tells the walk to adopt the clicked archetype as its
     * new current graph node immediately, redrawing a fresh dwell, rather than
     * waiting for whatever dwell was already in flight to expire.
     *
     * @param {string} id
     * @param {object} [options]
     * @param {boolean} [options.immediate] - land it now instead of easing
     *   (scene load). Same argument `jumpTo` makes for the hour.
     * @returns {Readonly<{ok: boolean, preset: string, reason: string|null, version: number}>}
     */
    applyArchetype(id, { immediate = false } = {}) {
      const res = resolveArchetype(id);
      const axes = res.archetype.axes;
      pinnedAxes.clear();
      for (const [key, raw] of Object.entries(axes)) {
        if (!Object.hasOwn(WEATHER_AXES, key)) continue;
        const next = resolveTargetValue(key, raw);
        targets[key] = next;
        if (immediate) state[key] = next;
      }
      if (currentMode === 'almanac') {
        almanacCurrentNodeId = res.archetype.id;
        almanacDwellRemainingHours = activeBiome ? sampleDwell(almanacRng, res.archetype.id) : null;
      }
      // Derived from the targets just written, exactly like `setTargets` — one
      // rule for what the label means, not two.
      currentPreset = matchArchetype(targets);
      version++;
      return Object.freeze({ ok: res.ok, preset: currentPreset, reason: res.reason, version });
    },

    /**
     * Set targets AND land on them immediately, with no ease at all.
     *
     * For a scene load: easing from the previous scene's weather would be a
     * visible artefact of nothing, exactly as `day-clock.js#jumpTo` argues for
     * the hour. Also the honest implementation of `transitionSpeed: 'instant'`
     * for a caller that wants one jump without changing the mode's speed.
     *
     * @param {object} patch
     * @returns {Readonly<object>} the same value as {@link read}.
     */
    jumpTo(patch) {
      const p = patch && typeof patch === 'object' ? patch : {};
      let touched = false;
      for (const [key, raw] of Object.entries(p)) {
        if (!Object.hasOwn(WEATHER_AXES, key)) continue;
        const next = resolveTargetValue(key, raw);
        if (next !== targets[key] || next !== state[key]) touched = true;
        targets[key] = next;
        state[key] = next;
      }
      if (touched) {
        currentPreset = matchArchetype(targets);
        version++;
      }
      return read();
    },

    /**
     * @param {string} m - 'director' | 'almanac'.
     * @returns {boolean} whether the mode was accepted. Both are real as of
     *   slice 3 — this always returns true for a recognised mode name now,
     *   kept boolean because `world/day-clock.js#setMode` shaped this and a
     *   future half-built mode should refuse the exact same way slice 1-2's
     *   `almanac` once did.
     */
    setMode(m) {
      const next = normalizeMode(m);
      if (next === currentMode) return true;
      currentMode = next;
      version++;
      return true;
    },

    /**
     * @param {string} s - key of {@link TRANSITION_SPEEDS}.
     * @returns {string} the speed actually in force.
     */
    setTransitionSpeed(s) {
      const next = normalizeSpeed(s);
      if (next !== speedName) {
        speedName = next;
        version++;
      }
      return speedName;
    },

    // ⚠️ THERE IS DELIBERATELY NO `setPreset`. Slice 1 had one; slice 2 deleted
    // it the moment archetypes became real. The label is DERIVED from where the
    // axes are (`matchArchetype`), so a setter could only ever be used to make
    // it lie — to claim `overcast` over a sky sitting at cover 0.2. Removing
    // the setter makes that state unrepresentable rather than merely
    // discouraged, which is the V2 autopsy's own prescription: make the wrong
    // move unavailable.

    /**
     * Choose the Almanac's climate. Fails OPEN — an unknown id clears the
     * biome to `null` (the walk goes idle) rather than keeping a stale one or
     * inventing a fake default, since "no biome chosen" is itself a
     * legitimate, honest state. `null`/`undefined` explicitly clears it.
     *
     * Always resets the walk's own node/dwell: a fresh biome means a fresh
     * starting point, drawn (on the next {@link tick}) from ITS OWN
     * `archetypeWeights`, not inherited from whatever climate was active
     * before.
     *
     * @param {string|null} id
     * @returns {Readonly<{ok: boolean, biomeId: string|null, reason: string|null}>}
     */
    setBiome(id) {
      almanacCurrentNodeId = null;
      almanacDwellRemainingHours = null;
      if (id === null || id === undefined) {
        activeBiome = null;
        version++;
        return Object.freeze({ ok: true, biomeId: null, reason: null });
      }
      const res = resolveBiome(id);
      activeBiome = res.biome;
      version++;
      return Object.freeze({ ok: res.ok, biomeId: activeBiome?.id ?? null, reason: res.reason });
    },

    /**
     * How fast the Almanac's dwells pass — a multiplier, clamped to
     * [{@link VOLATILITY_MIN}, {@link VOLATILITY_MAX}]. 1 = the biome's own
     * authored pacing; 2 = twice as restless; 0.5 = twice as settled.
     * @param {number} v @returns {number} the value actually in force.
     */
    setVolatility(v) {
      const next = clampVolatility(v);
      if (next !== almanacVolatility) {
        almanacVolatility = next;
        version++;
      }
      return almanacVolatility;
    },

    /**
     * Reseed the Almanac's RNG. Two payoffs (Weather-Manager.md §5.4): a
     * reproducible bug report ("seed 8829102 did this at hour 14"), and a
     * GM-facing "reshuffle" gesture that doesn't require touching the biome.
     * Does NOT reset the walk's current node/dwell — only the FUTURE draws
     * change; the sky does not jump the instant this is called.
     * @param {number|string} seed
     * @returns {number|string} the seed now in force.
     */
    setSeed(seed) {
      almanacSeed = seed;
      almanacRng = createRng(seed);
      version++;
      return almanacSeed;
    },

    /**
     * Pin one axis explicitly, without touching its value — the same
     * protection {@link setTargets} grants a dragged slider, for a ROH
     * control (or a test) that wants to protect an axis without also moving
     * it.
     * @param {string} name @returns {boolean} true if it is a real axis.
     */
    pinAxis(name) {
      if (!Object.hasOwn(WEATHER_AXES, name)) return false;
      if (!pinnedAxes.has(name)) {
        pinnedAxes.add(name);
        version++;
      }
      return true;
    },

    /**
     * Release the GM's hand from one axis, letting the walk touch it again on
     * its next transition (not immediately — pinning/unpinning is a bookkeeping
     * change, not a target change, so it does not itself move anything).
     * @param {string} name @returns {boolean} true if it had been pinned.
     */
    unpinAxis(name) {
      const had = pinnedAxes.delete(name);
      if (had) version++;
      return had;
    },

    /** Release every pin at once. @returns {number} how many were released. */
    unpinAllAxes() {
      const n = pinnedAxes.size;
      if (n > 0) {
        pinnedAxes.clear();
        version++;
      }
      return n;
    },

    /**
     * Project the walk forward WITHOUT touching live state — "the forecast is
     * free" (Weather-Manager.md §5.4). Clones the live RNG
     * (`fromState(rng.getState())`) and replays {@link advanceWalk} on the
     * clone; the live generator, node and dwell are never advanced by this
     * call, so calling it every frame for a UI readout costs nothing the live
     * sky will ever notice.
     *
     * Honestly empty (`available: false`, with a reason) rather than
     * fabricated when there is nothing to project — no biome chosen, not in
     * Almanac mode, or a non-positive horizon. A frozen clock's forecast
     * should read "—", not a guess.
     *
     * @param {number} gameHoursAhead
     * @param {object} [options]
     * @param {number} [options.hour] - the CURRENT hour of day (0..24) to
     *   start the projection from.
     * @param {number} [options.maxSteps] - defensive cap, see `advanceWalk`.
     * @returns {Readonly<{available: boolean, reason: string|null, transitions: ReadonlyArray<Readonly<{archetypeId: string, atGameHoursFromNow: number}>>}>}
     */
    forecast(gameHoursAhead, { hour = 12, maxSteps = 20 } = {}) {
      if (currentMode !== 'almanac') {
        return Object.freeze({ available: false, reason: 'not in almanac mode', transitions: Object.freeze([]) });
      }
      if (!activeBiome) {
        return Object.freeze({ available: false, reason: 'no biome selected', transitions: Object.freeze([]) });
      }
      if (!(gameHoursAhead > 0)) {
        return Object.freeze({ available: false, reason: 'non-positive horizon', transitions: Object.freeze([]) });
      }
      const clone = fromState(almanacRng.getState());
      const result = advanceWalk({
        rng: clone,
        currentNodeId: almanacCurrentNodeId,
        dwellRemainingHours: almanacDwellRemainingHours ?? 0,
        startHour: normalizeHour(hour),
        dtGameHours: gameHoursAhead,
        maxSteps,
      });
      return Object.freeze({
        available: true,
        reason: null,
        transitions: Object.freeze(result.transitions.map((t) => Object.freeze({ ...t }))),
      });
    },

    // ── SLICE 4 — EVENTS (Weather-Manager.md §6.1-§6.2) ──────────────────────

    /**
     * Start an event. Fails OPEN on a bad `kind` or a duplicate `id` — the
     * same shape {@link setBiome}/{@link applyArchetype} use for an unknown
     * archetype/biome id: `ok:false` with a reason, never a throw, because a
     * typo in a GM macro or a front script must not be able to crash a scene.
     *
     * Every field of `spec` besides `kind` is optional and falls back
     * INDEPENDENTLY to `EVENT_KIND_DEFAULTS[kind]`'s own value — identical to
     * how `initial` axis values fall back per-field in this function's own
     * options. An `overrides` array the caller supplies REPLACES the kind's
     * default wholesale (they are recipes, not patches — merging two override
     * arrays item-by-item has no sensible meaning when their `axis`es differ).
     * Any override naming an axis outside {@link WEATHER_AXIS_NAMES} is
     * dropped and reported in `droppedOverrides`, not silently ignored
     * (`feedback_seam_default_hides_unwired`).
     *
     * @param {object} spec
     * @param {string} spec.kind - one of {@link EVENT_KINDS}.
     * @param {string} [spec.id] - defaults to an auto-generated `"kind-N"`.
     * @param {number} [spec.intensity01]
     * @param {{attackSec?: number, sustainSec?: number|'held', releaseSec?: number}} [spec.envelope]
     * @param {Array<{axis: string, op: string, value: number}>} [spec.overrides]
     * @param {boolean} [spec.a11yFlash]
     * @param {string} [spec.precipKindOverride]
     * @param {string} [spec.particleArchetype]
     * @param {object} [spec.illuminant]
     * @returns {Readonly<{ok: boolean, id: string|null, reason: string|null, droppedOverrides: string[], version: number}>}
     */
    addEvent(spec) {
      const s = spec && typeof spec === 'object' ? spec : {};
      const resolved = resolveEventKind(s.kind);
      if (!resolved.ok) {
        return Object.freeze({ ok: false, id: null, reason: resolved.reason, droppedOverrides: [], version });
      }
      const id = typeof s.id === 'string' && s.id.length > 0 ? s.id : `${s.kind}-${nextAutoEventId++}`;
      if (activeEvents.has(id)) {
        return Object.freeze({
          ok: false,
          id: null,
          reason: `event id '${id}' already active`,
          droppedOverrides: [],
          version,
        });
      }
      const d = resolved.defaults;
      const envelope = {
        attackSec: Number.isFinite(s.envelope?.attackSec) ? s.envelope.attackSec : d.envelope.attackSec,
        sustainSec:
          s.envelope?.sustainSec === 'held' || Number.isFinite(s.envelope?.sustainSec)
            ? s.envelope.sustainSec
            : d.envelope.sustainSec,
        releaseSec: Number.isFinite(s.envelope?.releaseSec) ? s.envelope.releaseSec : d.envelope.releaseSec,
      };
      const rawOverrides = Array.isArray(s.overrides) ? s.overrides : d.overrides;
      const droppedOverrides = [];
      const overrides = [];
      for (const ov of rawOverrides) {
        if (
          !ov ||
          !Object.hasOwn(WEATHER_AXES, ov.axis) ||
          !OVERRIDE_OPS.includes(ov.op) ||
          !Number.isFinite(Number(ov.value))
        ) {
          droppedOverrides.push(ov?.axis ?? '?');
          continue;
        }
        overrides.push({ axis: ov.axis, op: ov.op, value: Number(ov.value) });
      }
      const eventSpec = Object.freeze({
        kind: s.kind,
        intensity01: clamp01(Number.isFinite(s.intensity01) ? s.intensity01 : d.intensity01),
        envelope: Object.freeze(envelope),
        overrides: Object.freeze(overrides),
        illuminant: s.illuminant ?? d.illuminant,
        precipKindOverride: s.precipKindOverride ?? d.precipKindOverride,
        particleArchetype: s.particleArchetype ?? d.particleArchetype,
        a11yFlash: typeof s.a11yFlash === 'boolean' ? s.a11yFlash : d.a11yFlash,
      });
      activeEvents.set(id, { spec: eventSpec, startedAtRealSec: elapsedRealSec, releasedAtRealSec: null });
      version++;
      return Object.freeze({ ok: true, id, reason: null, droppedOverrides, version });
    },

    /**
     * Begin an event's release ramp early — works from ANY phase (attack,
     * sustain, or an already-numeric-sustain event that hasn't reached it
     * yet), not just a `'held'` one: a GM cutting an ash-storm short mid-build
     * should not need to know which phase it was in. Idempotent — releasing
     * an already-releasing event does not restart its ramp.
     * @param {string} id
     * @returns {boolean} true if `id` is active and this call started (or had
     *   already started) its release; false if `id` is not active.
     */
    releaseEvent(id) {
      const ev = activeEvents.get(id);
      if (!ev) return false;
      if (ev.releasedAtRealSec == null) {
        ev.releasedAtRealSec = elapsedRealSec;
        version++;
      }
      return true;
    },

    /**
     * Remove an event immediately, with no release ramp — for programmatic
     * cleanup (tests, a scene unload) rather than a dramatic end.
     * @param {string} id
     * @returns {boolean} true if it had been active.
     */
    removeEvent(id) {
      const had = activeEvents.delete(id);
      if (had) version++;
      return had;
    },

    /**
     * Say what is falling, or `'auto'` to let `temperature01` decide (the
     * default). Fails OPEN to `auto` on an unknown kind and reports it — the
     * same shape every other closed-list setter here uses.
     * @param {string} kind - a member of {@link PRECIP_KINDS}.
     * @returns {Readonly<{ok: boolean, kind: string, reason: string|null}>}
     */
    setPrecipKindAuthored(kind) {
      if (!PRECIP_KINDS.includes(kind)) {
        precipKindAuthored = 'auto';
        version++;
        return Object.freeze({ ok: false, kind: 'auto', reason: `unknown precip kind '${kind}' — fell back to auto` });
      }
      if (kind !== precipKindAuthored) {
        precipKindAuthored = kind;
        version++;
      }
      return Object.freeze({ ok: true, kind: precipKindAuthored, reason: null });
    },

    /**
     * Diagnostics/UI list of every active event and where its envelope
     * currently is. `intensity01` (the authored dial) and `progress01` (the
     * envelope's own ramp) are reported SEPARATELY rather than pre-multiplied
     * — `feedback_count_silent_preconditions`'s "print every factor" applied
     * here too: a mild-but-fully-ramped-in event and a strong-but-still-
     * attacking one can share one product while meaning opposite things.
     * @returns {ReadonlyArray<Readonly<{id: string, kind: string, intensity01: number, phase: string, progress01: number, elapsedRealSec: number}>>}
     */
    getActiveEvents() {
      return Object.freeze(listActiveEvents());
    },

    /**
     * The manager's whole state, frozen — what the snapshot and the astrolabe
     * both read, so the dial can never show something the render disagrees with.
     *
     * Carries BOTH halves on purpose: `state` is where the weather actually is
     * (consumers read this), `targets` is where the GM pointed it (the UI reads
     * this, so a slider shows intent immediately while the sky catches up
     * behind it).
     */
    read,

    /**
     * The eased axes shaped for `buildEnvSnapshot({weather})`.
     *
     * `hasOwner` is the point of this method existing separately from
     * {@link read}. It is the `windHandle.hasBake` contract applied to weather:
     * without it, `cloudCover01 === 0` is ambiguous between *"the sky is
     * genuinely clear"* and *"nobody ever wired a weather owner"* — the same
     * pixel, two completely different bugs, and this project has already paid
     * for that ambiguity once (`feedback_seam_default_hides_unwired`).
     *
     * ⚠️ THIS is where events actually apply (see this module's SLICE 4
     * header) — `applyEventOverrides` composes onto a COPY of `state`, then
     * every axis is re-clamped into its own declared range (an `add`/`mul`
     * override, or two events stacking, can walk an axis past its bound; the
     * ease engine's own writes never can, so only this path needs the pass).
     * `preset` stays the pure, un-composed label — LAW 2 already forbids any
     * consumer branching on it, and an ash-storm boosting cover must not make
     * the UI believe the GM picked `overcast`.
     * @returns {Readonly<object>}
     */
    toSnapshotWeather() {
      const composed = applyEventOverrides(state, [...activeEvents.values()], elapsedRealSec);
      for (const name of WEATHER_AXIS_NAMES) {
        composed[name] = clampAxis(name, composed[name]);
      }
      // ⚠️ DERIVED FROM THE COMPOSED TEMPERATURE, not the base one — an event
      // that drives the map cold must actually change what falls out of the
      // sky, or the overlay would be visible in every term except the one a
      // player would name first.
      const precip = derivePrecipKind(precipKindAuthored, composed.temperature01);
      return Object.freeze({
        preset: currentPreset,
        ...composed,
        // What is FALLING (Precipitation.md §2.5's band). `precipKind` is the
        // species id a consumer renders; `precipMixWeight` is how much of the
        // COLD species is in it, which is only ever non-trivial for `sleet`.
        precipKind: precip.kind,
        precipMixWeight: precip.mixWeight,
        precipKindAuthored,
        hasOwner: true,
        ownerVersion: version,
      });
    },

    /**
     * Diagnostics — what the env-diagnostics block and the perf report print.
     * Includes each axis's consumer status so "this axis is carried but nothing
     * reads it" is a reported fact rather than tribal knowledge.
     */
    getStatus() {
      const axes = {};
      for (const name of WEATHER_AXIS_NAMES) {
        const spec = WEATHER_AXES[name];
        axes[name] = Object.freeze({
          value: state[name],
          target: targets[name],
          settling: state[name] !== targets[name],
          consumerStatus: spec.consumerStatus,
          consumers: spec.consumers,
        });
      }
      return Object.freeze({
        mode: currentMode,
        transitionSpeed: speedName,
        preset: currentPreset,
        version,
        settling: isSettling(),
        almanacBuilt: true,
        // The Almanac's own state — biome, pace, the walk's current graph
        // node and dwell countdown, and every pinned axis. `seed` is included
        // deliberately: the whole point of a reproducible bug report
        // (Weather-Manager.md §5.4) is that this number is visible somewhere
        // a report can quote it.
        almanac: Object.freeze({
          biomeId: activeBiome?.id ?? null,
          volatility: almanacVolatility,
          seed: almanacSeed,
          currentNodeId: almanacCurrentNodeId,
          dwellRemainingHours: almanacDwellRemainingHours,
          pinnedAxes: Object.freeze([...pinnedAxes]),
        }),
        axes: Object.freeze(axes),
        // SLICE 4 — every event still active, and which axes it is actually
        // touching right now (empty for the six kinds still waiting on
        // slice 5/6's machinery — see `weather-events.js`'s own header for
        // exactly which, and why that is honest rather than a gap).
        events: Object.freeze({
          active: Object.freeze(listActiveEvents()),
        }),
        // P1 — what is falling, and every factor that decided it. Printed
        // separately rather than as one answer because
        // `feedback_count_silent_preconditions` applies to a derivation too:
        // "it is raining" and "it is raining BECAUSE temperature is 0.55 and
        // nobody authored a kind" are different amounts of information.
        precipitation: Object.freeze({
          ...derivePrecipKind(precipKindAuthored, state.temperature01),
          authoredKind: precipKindAuthored,
          temperature01: state.temperature01,
          sleetBand: PRECIP_SLEET_BAND,
        }),
      });
    },
  };
}

/**
 * The exponential time constant that makes a transition LOOK finished after
 * `durationSec`. The single home of the duration→tau conversion — see
 * {@link SETTLE_TAUS}.
 * @param {number} durationSec @returns {number}
 */
export function tauForDuration(durationSec) {
  return durationSec > 0 ? durationSec / SETTLE_TAUS : 0;
}

/**
 * One exponential step toward a target, with an arrival snap.
 *
 * Exported for the test suite and for slice 3's walk, which eases the same way:
 * one ease function in the codebase, never two that could disagree about what
 * `tau` means.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} tauSec - already scaled by the transition speed. `<= 0` snaps.
 * @param {number} dtSec
 * @param {number} epsilon - closer than this counts as arrived.
 * @returns {number}
 */
export function easeToward(current, target, tauSec, dtSec, epsilon) {
  if (!(tauSec > 0)) return target;
  if (!(dtSec > 0)) return current;
  const k = 1 - Math.exp(-dtSec / tauSec);
  const next = current + (target - current) * k;
  return Math.abs(target - next) <= epsilon ? target : next;
}

/**
 * Clamp a raw value into an axis's declared range, falling back to that axis's
 * own default when it is not a usable number.
 * @param {string} name @param {*} raw @returns {number}
 */
export function clampAxis(name, raw) {
  const spec = WEATHER_AXES[name];
  if (!spec) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return spec.fallback;
  return Math.min(spec.max, Math.max(spec.min, n));
}

/** @param {string} m @returns {string} */
function normalizeMode(m) {
  return WEATHER_MODES.includes(m) ? m : 'director';
}

/** @param {string} s @returns {string} */
function normalizeSpeed(s) {
  return Object.hasOwn(TRANSITION_SPEEDS, s) ? s : 'brisk';
}

/** @param {*} v @returns {number} */
function clampVolatility(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(VOLATILITY_MAX, Math.max(VOLATILITY_MIN, n)) : 1;
}

/** @param {*} v @returns {number} */
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// (`normalizePreset` lived here in slice 1 and was deleted in slice 2 along with
// `setPreset` — with the label derived from the axes there is no longer any
// path by which an arbitrary string reaches it, so a normaliser for one would
// be an API with no caller.)
