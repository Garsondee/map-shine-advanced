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
 * ⚠️ SLICE 1 SHIPS DIRECTOR ONLY. `setMode('almanac')` is REJECTED (returns
 * false) rather than silently accepted, because a mode that is stored but does
 * nothing is `feedback_seam_default_hides_unwired` wearing a mode's clothes: the
 * UI would read back "almanac" and the sky would sit perfectly still. A loud
 * refusal is the honest state until the walk lands. This mirrors
 * `world/day-clock.js#setHour`, which refuses in `synced` mode for the same
 * reason.
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
});

/** @type {readonly string[]} */
export const WEATHER_AXIS_NAMES = Object.freeze(Object.keys(WEATHER_AXES));

/**
 * The archetype label carried through to `env.weather.preset`.
 *
 * ⚠️ LAW 2: this is a LABEL OF INTENT for the UI and for diagnostics. No
 * shader, effect or handle may branch on it — they read axes, which are numbers
 * that can also be 0.3. Slice 2's archetype shelf sets it; slice 1 only carries
 * it so the field has one home rather than two.
 */
export const DEFAULT_PRESET = 'clear';

/**
 * Create the weather manager.
 *
 * @param {object} [options]
 * @param {string} [options.mode] - 'director' (only mode built in slice 1).
 * @param {string} [options.transitionSpeed] - key of {@link TRANSITION_SPEEDS}.
 * @param {object} [options.initial] - starting axis values; each falls back
 *   INDEPENDENTLY to its own default, so one bad stored field cannot discard a
 *   scene's whole authored sky (`world/sky-settings.js#normalizeSky`'s rule).
 * @param {string} [options.preset] - starting archetype label.
 * @returns {object} the manager.
 */
export function createWeatherManager({
  mode = 'director',
  transitionSpeed = 'brisk',
  initial = null,
  preset = DEFAULT_PRESET,
} = {}) {
  let currentMode = normalizeMode(mode);
  let speedName = normalizeSpeed(transitionSpeed);
  let currentPreset = normalizePreset(preset);

  /** Where each axis is HEADED (the GM's hand, or slice 3's walk). */
  const targets = {};
  /** Where each axis actually IS this frame — what consumers read. */
  const state = {};

  for (const name of WEATHER_AXIS_NAMES) {
    const v = clampAxis(name, initial?.[name]);
    targets[name] = v;
    state[name] = v;
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
    });
  }

  return {
    /**
     * Advance one frame.
     *
     * @param {number} dtRealSec - the WALL delta (`env.time.realDtSec`). See
     *   this module's header for why it is not the sim delta, and why that is
     *   not the sim-clock throttle trap.
     * @returns {Readonly<object>} the same value as {@link read}.
     */
    tick(dtRealSec) {
      const dt = Number.isFinite(dtRealSec) && dtRealSec > 0 ? dtRealSec : 0;
      const scale = TRANSITION_SPEEDS[speedName];

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
        const next = clampAxis(key, raw);
        if (next !== targets[key]) {
          targets[key] = next;
          applied.push(key);
        }
      }
      if (applied.length > 0) version++;
      return Object.freeze({ applied, rejected, version });
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
        const next = clampAxis(key, raw);
        if (next !== targets[key] || next !== state[key]) touched = true;
        targets[key] = next;
        state[key] = next;
      }
      if (touched) version++;
      return read();
    },

    /**
     * @param {string} m
     * @returns {boolean} whether the mode was accepted. `almanac` is refused
     *   until slice 3 builds the walk — see this module's header.
     */
    setMode(m) {
      const next = normalizeMode(m);
      if (next === 'almanac') return false;
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

    /**
     * Set the archetype LABEL. Carries intent for the UI; nothing renders from
     * it (LAW 2). Slice 2's shelf sets this alongside the axes it applies.
     * @param {string} name
     * @returns {string} the label in force.
     */
    setPreset(name) {
      const next = normalizePreset(name);
      if (next !== currentPreset) {
        currentPreset = next;
        version++;
      }
      return currentPreset;
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
     * @returns {Readonly<object>}
     */
    toSnapshotWeather() {
      return Object.freeze({
        preset: currentPreset,
        ...state,
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
        almanacBuilt: false,
        axes: Object.freeze(axes),
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

/** @param {*} name @returns {string} */
function normalizePreset(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  return s.length > 0 ? s : DEFAULT_PRESET;
}
