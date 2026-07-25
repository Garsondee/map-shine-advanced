/**
 * THE ONE CLOCK — the only module in `src/` allowed to touch `performance.now()`.
 *
 * V2's `core/time.js` declared itself "the single source of truth for time" and
 * carried the docstring *"CRITICAL: ALL EFFECTS MUST USE THIS TIME SYSTEM. Never
 * use performance.now() or Date.now() directly."* — comment-MUST #4 of 7, and
 * `WaterEffectV2` sampled `performance.now()` eight independent times anyway.
 * Twenty files ended up holding some notion of time-of-day, with the clock
 * itself living INSIDE the weather controller (docs/planning/Environment.md §0.1).
 *
 * This module is the same intent with teeth instead of a docstring: the
 * `time/one-clock` tripwire in `tools/verify-structure.mjs` FAILS THE BUILD on
 * `performance.now()`/`Date.now()` anywhere outside this file (and `diag/`).
 * Consumers never ask what time it is — they are HANDED the frame's time in the
 * env snapshot (`world/environment.js`), the way a shot gets a timecode rather
 * than every department wearing its own wristwatch.
 *
 * Pure by injection: the time source is a constructor argument, so every
 * behaviour below is Node-testable with a fake clock — no waiting, no flakes.
 *
 * ============================================================================
 * TWO TIMES, AND WHY THE SIM ONE KEPT THE OLD NAME (2026-07-23)
 * ============================================================================
 *
 * The clock now runs at a SCALE, so Foundry's pause can ease the whole world to
 * a standstill over five seconds and back (`setScaleTarget`). That makes two
 * genuinely different questions possible on the same frame:
 *
 *   `tMs` / `dtSec`         — SIM time. Scaled. Stops when the world stops.
 *   `realMs` / `realDtSec`  — WALL time. Never scaled. Runs while paused.
 *
 * `tMs`/`dtSec` KEEP THEIR NAMES for sim time on purpose, and that choice is
 * the whole reason "every effect responds to pause" was a change here rather
 * than at fifteen call sites. Every animated light, candle flame, particle,
 * gust ribbon and wind-sim step in this project already reads `env.time.tMs` or
 * `env.time.dtSec` (one shared `uGlobalTimeMs` write feeds all the shader-side
 * ones). Renaming the sim clock to `simMs` would have meant editing all of them
 * and would have left the OLD name pointing at the wall clock — so every future
 * consumer that reached for the obvious `tMs` would silently opt OUT of pause,
 * one file at a time, which is precisely V2's failure shape. Instead the
 * obvious name is the correct one, and the handful of callers that genuinely
 * need wall time (hitch detection, poll throttles, the GPU probe) say `realMs`
 * explicitly — a visible, deliberate opt-out rather than an invisible default.
 *
 * `tMs` therefore starts at 0 and accumulates scaled deltas; it is NOT
 * `performance.now()`'s epoch any more. Nothing downstream cared: it is used as
 * an animation phase or in `now - then` differences, never as a wall timestamp.
 *
 * @module core/frame-clock
 */

/**
 * `dtSec` is clamped to this by default. A background tab, a debugger pause or
 * a long GC otherwise delivers a single monster delta that makes every
 * simulation lurch (particles teleport, eased cameras snap). V2 fought this
 * class of bug per-effect; the clock fixes it once, at the source.
 */
export const DEFAULT_MAX_DT_SEC = 0.1;

/**
 * How long the world takes to coast to a halt when Foundry pauses, and to spool
 * back up when it resumes. FIVE SECONDS, SYMMETRIC — author-chosen 2026-07-23
 * ("if it's paused time slows down and then stops over five seconds… it creates
 * a nice effect when pausing and unpausing when all effects respond to it").
 *
 * V2 used 0.75s down / 0.45s up. The longer, symmetric ramp is a deliberate
 * change of intent, not a port: the pause is meant to READ as a held breath.
 */
export const DEFAULT_PAUSE_RAMP_SEC = 5;

/** Below this the world counts as stopped (`paused` true, `tMs` effectively frozen). */
const STOPPED_EPSILON = 1e-6;

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - milliseconds source. Injected for tests;
 *   defaults to `performance.now` (this file is the sanctioned home for it).
 * @param {number} [options.maxDtSec]
 * @param {number} [options.scale] - starting time scale (1 = normal speed).
 * @returns {{
 *   tick: () => Readonly<FrameTime>,
 *   peek: () => Readonly<FrameTime>,
 *   setScaleTarget: (target: number, rampSec?: number) => void,
 *   getScale: () => number,
 * }}
 */
export function makeFrameClock({ now = () => performance.now(), maxDtSec = DEFAULT_MAX_DT_SEC, scale = 1 } = {}) {
  let frame = 0;
  let lastMs = null;
  /** Accumulated SIM milliseconds — scaled, starts at 0. See the header. */
  let simMs = 0;
  /** Accumulated WALL milliseconds since the first tick — unscaled. */
  let realMs = 0;

  // --- the ramp -------------------------------------------------------------
  // Interpolates `scaleFrom` → `scaleTarget` as `rampT` walks 0→1 on WALL time.
  // Wall time, not sim time, is load-bearing: a ramp advanced by its own scaled
  // output would asymptote and never reach 0, and once at 0 could never come
  // back at all (dt would be 0 forever). The one place the two clocks must not
  // be interchangeable.
  let currentScale = clampScale(scale);
  let scaleFrom = currentScale;
  let scaleTarget = currentScale;
  let rampT = 1;
  let rampSec = 0;

  let snapshot = freezeTime({ frame: 0, tMs: 0, dtSec: 0, realMs: 0, realDtSec: 0, timeScale: currentScale });

  return {
    /**
     * Advance one frame and return the frozen time snapshot for it.
     * The FIRST tick reports `dtSec: 0` rather than "time since page load" —
     * a first frame with a giant delta is the same lurch bug in disguise.
     */
    tick() {
      const wallMs = now();
      const rawDt = lastMs === null ? 0 : (wallMs - lastMs) / 1000;
      lastMs = wallMs;
      frame += 1;

      // Negative deltas (clock adjustment, timer wrap) clamp to 0, not to a
      // reversal — no simulation should ever integrate backwards by surprise.
      const realDtSec = Math.min(Math.max(rawDt, 0), maxDtSec);
      realMs += realDtSec * 1000;

      // Advance the ramp BEFORE spending this frame's delta, so the frame the
      // ramp completes on already runs at its final scale (V2's own ordering).
      if (rampT < 1) {
        rampT = rampSec > 0 ? Math.min(1, rampT + realDtSec / rampSec) : 1;
        currentScale = scaleFrom + (scaleTarget - scaleFrom) * easeInOut01(rampT);
      } else {
        currentScale = scaleTarget;
      }

      const dtSec = realDtSec * currentScale;
      simMs += dtSec * 1000;

      snapshot = freezeTime({
        frame,
        tMs: simMs,
        dtSec,
        realMs,
        realDtSec,
        timeScale: currentScale,
      });
      return snapshot;
    },

    /** The current frame's snapshot, without advancing. Same frozen object. */
    peek() {
      return snapshot;
    },

    /**
     * Ease the world toward a new time scale. `0` stops it, `1` is normal
     * speed. Called by whoever watches Foundry's pause state — never by an
     * effect, which has no business deciding how fast the world runs.
     *
     * Re-targeting mid-ramp is safe and continuous: the ramp restarts from
     * wherever the scale ACTUALLY is (`scaleFrom = currentScale`), so pausing
     * and immediately unpausing eases back from the partial slowdown rather
     * than snapping to a stop first.
     *
     * @param {number} target - desired scale, clamped to [0, 4].
     * @param {number} [seconds=DEFAULT_PAUSE_RAMP_SEC] - ramp duration in WALL
     *   seconds. `0` applies instantly.
     */
    setScaleTarget(target, seconds = DEFAULT_PAUSE_RAMP_SEC) {
      const next = clampScale(target);
      const dur = Number.isFinite(seconds) ? Math.max(0, seconds) : DEFAULT_PAUSE_RAMP_SEC;
      // ALREADY HEADING THERE ⇒ NOTHING TO DO. This guard is load-bearing, not
      // an optimisation: the obvious way to wire this is to re-assert the
      // target from a per-frame `game.paused` poll, and without the guard every
      // one of those calls would reset `rampT` to 0 — so the ramp would restart
      // 60 times a second, never advance past one frame's worth of easing, and
      // the world would asymptote near full speed instead of ever stopping.
      // Caught by the "re-asserting the SAME target" test, which is exactly the
      // shape a caller writes by accident.
      //
      // Duration is part of the identity so a DELIBERATE re-time (e.g. a hard
      // `setScaleTarget(0, 0)` stop over a five-second one already in flight)
      // still takes effect, easing from wherever the scale currently is.
      if (next === scaleTarget && dur === rampSec) return;
      scaleFrom = currentScale;
      scaleTarget = next;
      rampSec = dur;
      if (dur === 0) {
        currentScale = next;
        rampT = 1;
      } else {
        rampT = 0;
      }
    },

    /** The scale in force right now (mid-ramp values included). */
    getScale() {
      return currentScale;
    },
  };
}

/**
 * @typedef {object} FrameTime
 * @property {number} frame - monotonic frame counter.
 * @property {number} tMs - SIM milliseconds, scaled, from 0. The animation clock.
 * @property {number} dtSec - SIM seconds this frame, scaled and clamped.
 * @property {number} realMs - WALL milliseconds since the first tick, unscaled.
 * @property {number} realDtSec - WALL seconds this frame, clamped, unscaled.
 * @property {number} timeScale - the scale in force this frame, 0..n.
 * @property {boolean} paused - true when the world has effectively stopped.
 */

/** @param {Omit<FrameTime,'paused'>} t @returns {Readonly<FrameTime>} */
function freezeTime(t) {
  return Object.freeze({ ...t, paused: t.timeScale <= STOPPED_EPSILON });
}

/**
 * Cosine ease-in-out on 0..1 — V2's own pause curve (`0.5 - 0.5·cos(πt)`),
 * kept because the FEEL was never the thing that was wrong with V2's clock.
 * Gentle at both ends, so the world neither jerks into the slowdown nor lands
 * hard at the stop.
 * @param {number} t @returns {number}
 */
function easeInOut01(t) {
  const x = Math.min(1, Math.max(0, t));
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/**
 * Scale is clamped to [0, 4]: negative would run the world backwards (nothing
 * here integrates safely in reverse) and an unbounded fast-forward is a hitch
 * generator, since `dtSec` is clamped BEFORE scaling and a huge scale
 * re-introduces exactly the lurch `maxDtSec` exists to prevent.
 * @param {number} v @returns {number}
 */
function clampScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(0, n));
}
