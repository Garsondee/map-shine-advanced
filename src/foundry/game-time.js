/**
 * THE GAME-TIME READER — the one place Foundry's world clock and pause state
 * are read, and the one place their two hooks are registered.
 *
 * `game.paused`, `game.time`, `Hooks.on('pauseGame'|'updateWorldTime')` appear
 * NOWHERE else in `src/` — the `foundry/adapter-only` wall makes that a build
 * failure. V2 designated a Foundry adapter too and 107 of 128 files reached
 * around it; this is the module that earns the exception for time.
 *
 * ============================================================================
 * WHAT FOUNDRY ACTUALLY DOES WITH TIME (verified against the vendored v14
 * source, `client/helpers/time.mjs` + `client/data/calendar.mjs`)
 * ============================================================================
 *
 *   - `game.time.worldTime` is an INTEGER COUNT OF SECONDS, server-synced every
 *     30s. It is not a wall clock and has no epoch you can assume.
 *   - **Foundry never advances it on its own.** It moves only when something
 *     calls `game.time.advance()`/`.set()` — a combat round, a macro, or a
 *     calendar module. A world with none of those has a world time that never
 *     changes, which is why MSA needs its own drift for a live day cycle.
 *   - `game.time.components` expands it via the world's calendar into
 *     `{year, month, day, hour, minute, second, season, dayOfWeek, …}`.
 *   - **A day is not necessarily 24 hours.** `game.time.calendar.days`
 *     carries `hoursPerDay`/`minutesPerHour`/`secondsPerMinute`, all
 *     world-configurable. Everything below normalises onto a 0..24 axis rather
 *     than assuming Earth — harvested from V2's own
 *     `legacy/core/foundry-time-phases.js`, which got this right.
 *   - Pause is `game.paused`, changed via `game.togglePause()`, announced by
 *     `Hooks.callAll("pauseGame", paused, options)`. It stops token movement
 *     and dragging; it does not stop a single animation. Nothing in Foundry
 *     makes a paused world LOOK paused — that is what this feeds.
 *
 * ============================================================================
 * READ ONLY. THERE IS NO WRITE FUNCTION HERE, AND THAT IS THE POINT.
 * ============================================================================
 *
 * V2 wrote MSA's hour back into Foundry (`legacy/ui/state-applier.js`:
 * `game.time.set(target, {mapShineTimeSync: true})`) while also listening to
 * `updateWorldTime` — a feedback loop held together by a guard flag. That is
 * the same shape as the darkness round-trip that cost two months
 * (Environment.md §0.3), and `world/day-clock.js`'s two modes exist to make it
 * structurally impossible. So this module deliberately exposes no setter: the
 * absence is the design, not an omission to be helpfully filled in later.
 *
 * Split like every other adapter here: `deriveHourFromComponents` is pure and
 * Node-tested; the `read*`/`watch*` functions are the live gatherers around it,
 * and never throw — a broken read reports WHY rather than pretending
 * (feedback_instruments_must_not_lie).
 *
 * @module foundry/game-time
 */

/**
 * THE RECONCILE-ON-CADENCE INTERVAL (Almanac Testament §3.1/§9 A2) —
 * `watchWorldTimeOfDay`'s periodic safety net against the silent 30 s
 * sync-pull trap below. Well under Foundry's own 30 s `GameTime#sync()`
 * cadence (`client/helpers/time.mjs:24`, `SYNC_INTERVAL_MS = 1000*30`,
 * receipted in the Almanac Testament §3.1) so drift is caught promptly
 * rather than merely "eventually" — and cheap enough to not matter: each
 * tick is one `game.time.components` read, not a network call.
 */
export const RECONCILE_INTERVAL_MS = 5000;

/** Earth defaults, used when a world declares no calendar of its own. */
export const DEFAULT_CALENDAR_UNITS = Object.freeze({
  hoursPerDay: 24,
  minutesPerHour: 60,
  secondsPerMinute: 60,
});

/**
 * Fold a Foundry `TimeComponents` value onto MSA's 0..24 hour axis, using the
 * world's own calendar units.
 *
 * A world with a 20-hour day still lands correctly: its hour 10 is midday, and
 * must map to 12.0 here, not to 10.0. Scaling by `24 / hoursPerDay` is what
 * makes the sun's noon and the calendar's noon the same moment — without it,
 * every non-Earth calendar would have its sun rise at the wrong time of day and
 * no one would be able to say why.
 *
 * @param {{hour?: number, minute?: number, second?: number}|null|undefined} components
 * @param {{hoursPerDay?: number, minutesPerHour?: number, secondsPerMinute?: number}} [units]
 * @returns {number|null} 0..24, or null if the components are unusable.
 */
export function deriveHourFromComponents(components, units = DEFAULT_CALENDAR_UNITS) {
  if (!components || typeof components !== 'object') return null;
  const hour = Number(components.hour);
  if (!Number.isFinite(hour)) return null;

  const hoursPerDay = positive(units?.hoursPerDay, DEFAULT_CALENDAR_UNITS.hoursPerDay);
  const minutesPerHour = positive(units?.minutesPerHour, DEFAULT_CALENDAR_UNITS.minutesPerHour);
  const secondsPerMinute = positive(units?.secondsPerMinute, DEFAULT_CALENDAR_UNITS.secondsPerMinute);

  const minute = Number.isFinite(Number(components.minute)) ? Number(components.minute) : 0;
  const second = Number.isFinite(Number(components.second)) ? Number(components.second) : 0;

  const calendarHours = hour + minute / minutesPerHour + second / (minutesPerHour * secondsPerMinute);
  const onDayAxis = (calendarHours / hoursPerDay) * 24;
  return ((onDayAxis % 24) + 24) % 24;
}

/**
 * Read the world clock as an MSA hour.
 *
 * @returns {{todHour: number|null, source: 'world-clock'|'unavailable', reason: string|null, components: object|null}}
 *   `todHour` is null when there is no usable world clock — the caller keeps
 *   whatever hour it already had rather than snapping to a guessed noon.
 */
export function readWorldTimeOfDay() {
  try {
    const time = typeof game !== 'undefined' ? (game?.time ?? null) : null;
    if (!time) {
      return { todHour: null, source: 'unavailable', reason: 'game.time is not available yet', components: null };
    }
    const components = time.components ?? null;
    const todHour = deriveHourFromComponents(components, time.calendar?.days);
    if (todHour === null) {
      return {
        todHour: null,
        source: 'unavailable',
        reason: 'game.time.components carried no usable hour',
        components,
      };
    }
    return { todHour, source: 'world-clock', reason: null, components };
  } catch (err) {
    return {
      todHour: null,
      source: 'unavailable',
      reason: `reading game.time threw: ${err?.message ?? err}`,
      components: null,
    };
  }
}

/**
 * Read Foundry's pause state.
 *
 * Defaults to NOT paused when unreadable, deliberately: a false "paused" would
 * freeze every effect in the scene with no visible cause, which is a far worse
 * failure than a pause that quietly does not take (safety-slide doctrine).
 *
 * @returns {{paused: boolean, source: 'game'|'default', reason: string|null}}
 */
export function readGamePaused() {
  try {
    if (typeof game === 'undefined' || !game) {
      return { paused: false, source: 'default', reason: 'game is not available yet' };
    }
    const paused = game.paused;
    if (typeof paused !== 'boolean') {
      return { paused: false, source: 'default', reason: 'game.paused was not a boolean' };
    }
    return { paused, source: 'game', reason: null };
  } catch (err) {
    return { paused: false, source: 'default', reason: `reading game.paused threw: ${err?.message ?? err}` };
  }
}

/**
 * Watch Foundry's pause state.
 *
 * Fires the callback ONCE immediately with the current state, then on every
 * change. The immediate call matters: a client that loads into an
 * already-paused world must arrive with the world already stopped, not run at
 * full speed until someone happens to toggle pause.
 *
 * @param {(paused: boolean) => void} onChange
 * @returns {() => void} unsubscribe.
 */
export function watchGamePaused(onChange) {
  if (typeof onChange !== 'function') return () => {};
  try {
    onChange(readGamePaused().paused);
  } catch (err) {
    void err; // a throwing consumer must not prevent the subscription below
  }
  if (typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('pauseGame', (paused) => onChange(!!paused));
  return () => {
    try {
      Hooks.off('pauseGame', id);
    } catch (err) {
      void err; // teardown during a canvas rebuild; nothing to recover
    }
  };
}

/**
 * Watch Foundry's world clock, reported as an MSA hour.
 *
 * Fires once immediately (same reasoning as `watchGamePaused`), then on
 * every `updateWorldTime` HOOK, **and** on a periodic cadence
 * ({@link RECONCILE_INTERVAL_MS}). The cadence is not decoration — Foundry's
 * `GameTime#sync()` runs a background pull every 30 s that can overwrite
 * `worldTime` WITHOUT firing `updateWorldTime` at all (Almanac Testament
 * §3.1's receipt against the vendored source: `client/helpers/time.mjs`'s
 * `sync()` assigns `#time.worldTime` directly, never calling
 * `onUpdateWorldTime`, which is the ONLY place the hook fires from). A
 * consumer that only listens for the hook silently drifts for as long as
 * nothing else happens to touch time — this closes that gap for EVERY
 * existing caller (`vt-pan-viewer.js#setTimeMode`'s subscription included)
 * with zero call-site changes, because the fix lives at the one place this
 * value is read from, not at each place it is consumed.
 *
 * An unreadable clock does NOT fire — the caller is left holding its
 * previous hour rather than being handed a guess.
 *
 * @param {(todHour: number) => void} onChange
 * @returns {() => void} unsubscribe — tears down BOTH the hook and the interval.
 */
export function watchWorldTimeOfDay(onChange) {
  if (typeof onChange !== 'function') return () => {};
  const emit = () => {
    const read = readWorldTimeOfDay();
    if (read.todHour !== null) onChange(read.todHour);
  };
  try {
    emit();
  } catch (err) {
    void err;
  }
  if (typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('updateWorldTime', () => emit());
  const intervalId = typeof setInterval === 'function' ? setInterval(emit, RECONCILE_INTERVAL_MS) : null;
  return () => {
    try {
      Hooks.off('updateWorldTime', id);
    } catch (err) {
      void err;
    }
    if (intervalId !== null) {
      try {
        clearInterval(intervalId);
      } catch (err) {
        void err;
      }
    }
  };
}

/** @param {*} v @param {number} fallback @returns {number} */
function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
