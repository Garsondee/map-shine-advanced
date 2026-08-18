/**
 * THE DAY CLOCK — the ONE owner of "what time of day is it", and the only thing
 * allowed to move that number.
 *
 * ============================================================================
 * WHY THIS IS ITS OWN MODULE (docs/planning/Environment.md §0.1)
 * ============================================================================
 *
 * V2's clock lived INSIDE the weather controller — `WeatherController.js:184`,
 * `this.timeOfDay = 12.0`. Time was a *field of* weather, so the two systems
 * that should have composed were hierarchically entangled, and twenty files
 * grew their own notion of the hour. The fix is not a better comment; it is a
 * module that owns the number, a `world/sun.js` that is a pure function OF that
 * number, and a `time/one-tod` tripwire that fails the build if the concept
 * appears anywhere else.
 *
 * Arrows point one way, and only one:
 *
 *     day-clock (owns todHour) → sun = f(todHour) → env snapshot → everything
 *
 * ============================================================================
 * TWO MODES, AND WHY NEITHER WRITES BACK (author-decided 2026-07-23, LOCKED)
 * ============================================================================
 *
 *   'aesthetic' — MSA owns the hour. The astrolabe's ring drags it. Foundry's
 *                 `game.time.worldTime` is neither read nor written. *"If they
 *                 just want to change the scene to look like night time."*
 *   'synced'    — Foundry's world clock is the ONLY thing allowed to move the
 *                 hour. The ring goes read-only. *"If users want the clock to
 *                 change automatically they should use the inbuilt Foundry time
 *                 controls."*
 *
 * **Neither mode ever writes to `game.time`.** That is the entire point. V2 DID
 * write back (`legacy/ui/state-applier.js`: `game.time.set(t, {mapShineTimeSync:
 * true})`) while also listening to `updateWorldTime` — a feedback loop held
 * together by a guard flag, which is the same shape as the darkness disaster
 * that cost two months (Environment.md §0.3). Two modes with opposite READ
 * directions and no WRITE direction removes the loop by construction: there is
 * no flag anyone can forget, because there is nothing to guard.
 *
 * ⚠️ SUPERSEDED, LAWFULLY, 2026-08-17 (`docs/holy/Almanac-Testament.md` §1) —
 * the author re-asked, in so many words, for MSA to hold a pen on `game.time`
 * after all. What survives here UNCHANGED is the loop-proofing, not the
 * blanket "never write" rule: this file itself STILL never writes (that
 * would reintroduce exactly the guard-flag shape above) — the write now
 * lives entirely separately, in `foundry/time-authority.js`, gated to fire
 * ONLY on a GM gesture or a cadence tick, NEVER from inside a time-read hook.
 * `'synced'` is renamed `'follow'` at the ALMANAC POSTURE layer (see
 * `ALMANAC_POSTURES` below); THIS module's own two-value `DAY_CLOCK_MODES`
 * stays exactly as it was — day-clock.js still knows only two READ postures,
 * on purpose, per the Testament's own §1: *"the pen is a separate faculty."*
 *
 * ============================================================================
 * EASED, NOT SNAPPED
 * ============================================================================
 *
 * `syncTo` sets a TARGET, not the hour. Foundry's world time moves in discrete
 * jumps (a combat round is +6 seconds; a GM's "advance 8 hours" is a single
 * step), and slamming `todHour` would make the sun, every shadow in the scene
 * and the whole ambient palette teleport in one frame. The clock always walks
 * to its target the short way round the dial, at a bounded rate.
 *
 * Pure and Node-testable: it holds state but takes every input as an argument
 * and touches nothing global — no Foundry, no clock, no DOM.
 *
 * @module world/day-clock
 */

import { normalizeHour } from './sun.js';

/** The two authority modes THIS module knows. See the header for why there is
 * still no third HERE — the third posture lives one layer up. */
export const DAY_CLOCK_MODES = Object.freeze(['aesthetic', 'synced']);

/**
 * THE THREE ALMANAC POSTURES (`docs/holy/Almanac-Testament.md` §1/§4) — a
 * superset of {@link DAY_CLOCK_MODES}, owned one layer above this file
 * (`world/sky-settings.js`'s `sky.mode` field carries it; `foundry/time-
 * authority.js` reads it to decide whether the Pen is armed). `'follow'` and
 * `'almanac'` BOTH read `worldTime` — day-clock's own `'synced'` mode — and
 * only `'almanac'` additionally arms writes. day-clock.js itself never sees
 * this 3-way value; {@link postureToDayClockMode} is the one translation
 * point, called at the one boundary that needs day-clock's narrower
 * vocabulary (`vt-pan-viewer.js#setTimeMode`) — never upstream of it, so
 * every OTHER consumer (the astrolabe's own display, the Pen's arming check)
 * keeps seeing the true posture.
 *
 * ⚠️ Unrelated name collision, noted so nobody "fixes" it: `world/sky-
 * settings.js`'s `weatherMode` field ALSO has a value literally spelled
 * `'almanac'` (the Weather Manager's own director/almanac split, Weather-
 * Manager.md §5 — whether weather is GM-directed or auto-walking a climate).
 * Two different fields, two unrelated concepts, one shared English word. The
 * Almanac Testament names this posture `'almanac'` explicitly; that is not a
 * worker's call to rename.
 */
export const ALMANAC_POSTURES = Object.freeze(['aesthetic', 'follow', 'almanac']);

/**
 * The one translation point from a 3-way posture to day-clock's 2-way mode.
 * By the time this is called, `posture` will already have passed through
 * `sky-settings.js#normalizeSky`'s own coercion (the ONE boundary where
 * garbage gets a default) — the unrecognised-input branch below is a
 * defensive belt-and-braces case, not a path real input should reach.
 * @param {string} posture - one of {@link ALMANAC_POSTURES}, or anything.
 * @returns {'aesthetic'|'synced'} `'follow'`/`'almanac'` both read
 *   worldTime (day-clock's `'synced'`); unrecognised input fails to
 *   `'aesthetic'` — the SAME direction `normalizeMode` already fails in,
 *   deliberately kept consistent rather than picking a second convention.
 */
export function postureToDayClockMode(posture) {
  if (posture === 'follow' || posture === 'almanac') return 'synced';
  return 'aesthetic';
}

/**
 * Default hour for a scene nobody has set — noon, the same "canonical
 * fresh-scene default: clear noon" V2 used, and what `normalizeHour` already
 * falls back to for a broken input.
 */
export const DEFAULT_TOD_HOUR = 12;

/**
 * Default progression rate: ZERO. Time of day does not drift on its own until
 * somebody asks it to.
 *
 * This is a deliberate, logged exception to `feedback_default_on_new_features`
 * ("ship default-on"). A default-on drift would silently change how every
 * EXISTING scene looks the moment this ships — a scene the author lit at noon
 * would wander into dusk while they worked on it. Motion of the sun is a
 * creative choice per scene, not a rendering feature that is simply better on.
 */
export const DEFAULT_RATE_HOURS_PER_MINUTE = 0;

/**
 * How fast the clock is allowed to WALK toward a sync target, in game-hours per
 * real second. Fast enough that a combat round's few seconds land within a
 * frame or two, slow enough that a GM jumping eight hours reads as a sweep
 * rather than a cut. Tunable per instance.
 */
export const DEFAULT_SYNC_HOURS_PER_SECOND = 6;

/**
 * Below this many hours of separation, a sync target counts as reached and the
 * clock snaps the remainder — otherwise it asymptotes forever and `isSyncing`
 * never goes false.
 */
const SYNC_ARRIVAL_HOURS = 1 / 3600; // one game-second

/**
 * @param {object} [options]
 * @param {number} [options.todHour] - starting hour.
 * @param {string} [options.mode] - 'aesthetic' | 'synced'.
 * @param {number} [options.rateHoursPerMinute] - drift rate (aesthetic mode only).
 * @param {number} [options.syncHoursPerSecond] - how fast `syncTo` walks.
 * @returns {object} the day clock.
 */
export function createDayClock({
  todHour = DEFAULT_TOD_HOUR,
  mode = 'aesthetic',
  rateHoursPerMinute = DEFAULT_RATE_HOURS_PER_MINUTE,
  syncHoursPerSecond = DEFAULT_SYNC_HOURS_PER_SECOND,
} = {}) {
  let hour = normalizeHour(todHour);
  let currentMode = normalizeMode(mode);
  let rate = clampRate(rateHoursPerMinute);
  const walkRate = Math.max(0, Number(syncHoursPerSecond) || DEFAULT_SYNC_HOURS_PER_SECOND);
  /** Where `synced` mode is walking to, or null when settled / not syncing. */
  let targetHour = null;

  return {
    /**
     * Advance one frame.
     *
     * `dtSec` is the SIM delta (`env.time.dtSec`, core/frame-clock.js) — scaled,
     * so the day clock decelerates with the rest of the world when Foundry
     * pauses, and the sun visibly slows to a stop along with every flame and
     * mote. That is not incidental: handing this the WALL delta instead would
     * make time-of-day the one system that ignores the pause, which is exactly
     * the "one system that answers to a different sky" shape this project keeps
     * finding in V2.
     *
     * @param {number} dtSec
     * @returns {number} the new hour, 0..24.
     */
    tick(dtSec) {
      const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;

      // Walking toward a sync target beats drifting: while a jump is landing,
      // that IS the motion. Both modes may walk — `aesthetic` uses it for the
      // astrolabe's own time-stop buttons ("jump to dawn" should sweep).
      if (targetHour !== null) {
        const remaining = shortestHourDelta(hour, targetHour);
        const step = walkRate * dt;
        if (step <= 0 || Math.abs(remaining) <= Math.max(step, SYNC_ARRIVAL_HOURS)) {
          hour = targetHour;
          targetHour = null;
        } else {
          hour = normalizeHour(hour + Math.sign(remaining) * step);
        }
        return hour;
      }

      // Free drift — aesthetic mode only. In `synced` mode Foundry's clock is
      // the sole authority, so a local rate would be a second, disagreeing
      // source of motion: precisely the thing the mode exists to prevent.
      if (currentMode === 'aesthetic' && rate !== 0) {
        hour = normalizeHour(hour + (rate * dt) / 60);
      }
      return hour;
    },

    /**
     * Set the hour outright (the astrolabe ring drag, mid-gesture). Rejected in
     * `synced` mode: the ring is read-only there, and a silent accept would let
     * the UI and Foundry's clock disagree with no way to tell which won.
     * @param {number} h
     * @returns {boolean} true if it was accepted.
     */
    setHour(h) {
      if (currentMode !== 'aesthetic') return false;
      targetHour = null;
      hour = normalizeHour(h);
      return true;
    },

    /**
     * Walk to an hour rather than snapping (a time-stop button; a Foundry world
     * time change in `synced` mode). Always accepted — in `synced` mode this is
     * the ONLY way the hour moves, so it must work regardless of mode.
     * @param {number} h
     */
    syncTo(h) {
      const next = normalizeHour(h);
      if (Math.abs(shortestHourDelta(hour, next)) <= SYNC_ARRIVAL_HOURS) {
        hour = next;
        targetHour = null;
        return;
      }
      targetHour = next;
    },

    /**
     * Jump with no walk at all — for a scene load, where easing from the
     * previous scene's hour would be a visible artefact of nothing.
     * @param {number} h
     */
    jumpTo(h) {
      hour = normalizeHour(h);
      targetHour = null;
    },

    /** @param {string} m @returns {string} the mode actually in force. */
    setMode(m) {
      const next = normalizeMode(m);
      if (next === currentMode) return currentMode;
      currentMode = next;
      // Abandon any walk in flight: it was authorised under the old mode's
      // rules and may no longer be legal (an aesthetic time-stop sweep must not
      // keep running after the world clock takes over).
      targetHour = null;
      return currentMode;
    },

    /** @param {number} r hours of game time per real minute. @returns {number} */
    setRate(r) {
      rate = clampRate(r);
      return rate;
    },

    /**
     * The clock's whole state, frozen — what the env snapshot and the astrolabe
     * both read. One shape, so the dial can never show something the render
     * disagrees with.
     */
    read() {
      return Object.freeze({
        todHour: hour,
        mode: currentMode,
        rateHoursPerMinute: rate,
        /** True while a `syncTo` walk is in flight — the dial shows it moving. */
        isSyncing: targetHour !== null,
        targetHour,
        /** False when the ring must render read-only (synced mode). */
        canSetHour: currentMode === 'aesthetic',
      });
    },
  };
}

/**
 * Signed hours from `from` to `to`, taking the SHORT way round the 24-hour dial
 * (result in −12..+12). 23:00 → 01:00 is +2, not −22 — so a sync across
 * midnight sweeps forward through midnight rather than backwards through the
 * entire day, and the sun does not run the wrong way for twenty-two hours.
 * @param {number} from @param {number} to @returns {number}
 */
export function shortestHourDelta(from, to) {
  const d = (((normalizeHour(to) - normalizeHour(from)) % 24) + 24) % 24;
  return d > 12 ? d - 24 : d;
}

/** @param {string} m @returns {string} */
function normalizeMode(m) {
  return DAY_CLOCK_MODES.includes(m) ? m : 'aesthetic';
}

/**
 * Drift rate, clamped to ±60 game-hours per real minute (a full day in 24 real
 * seconds — already absurd; beyond it the sun moves far enough per frame to
 * alias against the shadow/ambient updates that follow it). Negative runs the
 * day backwards, which is deliberately allowed: it is a legitimate look, and
 * nothing downstream of `todHour` integrates, so it is safe in a way the FRAME
 * clock's own scale is not.
 * @param {number} r @returns {number}
 */
function clampRate(r) {
  const n = Number(r);
  if (!Number.isFinite(n)) return 0;
  return Math.min(60, Math.max(-60, n));
}
