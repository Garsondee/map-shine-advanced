/**
 * THE PEN — the only place `game.time.advance()` is ever called. Almanac
 * Testament §6/§9 A2: *"gestures write; nothing loops."*
 *
 * ============================================================================
 * EVERY GATE LIVES INSIDE `advance()` ITSELF, NOT JUST IN A CALLER'S UI CHECK
 * ============================================================================
 *
 * The astrolabe (or any future caller) SHOULD check `isPenArmed`/combat/GM
 * status before offering a control at all — a disabled slider that explains
 * itself is Law 5 of the UI Testament (*"nothing broken is silent"*). But
 * `advance()` re-checks every one of those gates itself, unconditionally,
 * because a caller that forgets is not a hypothetical: it is exactly the
 * failure class this whole project exists to wall off by construction, not
 * by discipline. A UI bug can make a control clickable when it should not
 * be; it cannot make `game.time.advance()` fire when this file refuses.
 *
 * ============================================================================
 * WHY `advance()` TAKES `posture` AS AN ARGUMENT
 * ============================================================================
 *
 * Whether the Pen is armed depends on the RESOLVED Almanac posture — world
 * setting vs. scene override, `world/sky-settings.js#resolveSky`'s job. But
 * `foundry/` cannot import `world/` (confirmed empirically, zero existing
 * `src/foundry/**` file does — same finding `core/gregorian-math.js` and
 * `foundry/calendar-install.js` already documented for the calendar engine
 * and its data). `boot.js` already keeps the resolved sky live in its own
 * `skyScope` closure (`resolveAndApplySky`) — so it is the natural, and only
 * cheap, supplier of the current posture. `advance()` takes it as a plain
 * argument rather than trying to resolve it, exactly the same shape as
 * `installActiveCalendar({calendars, moduleId})` in the sibling file.
 *
 * ============================================================================
 * THE AUDIT LOG PROVES "ONE GESTURE, ONE ADVANCE" WITHOUT A CLOCK
 * ============================================================================
 *
 * The exit gate asks for a flag "if any gesture writes more than one
 * advance." A wall-clock timestamp would be the obvious way to correlate log
 * entries to a single human interaction — but `time/one-clock`
 * (`tools/verify-structure.mjs`) restricts `Date.now()`/`performance.now()`
 * to `diag/` and `core/frame-clock.js`, and neither this file nor `boot.js`
 * (confirmed: boot.js's own pre-existing `Date.now()` call is itself a
 * ratchet violation in the tree right now, not a sanctioned pattern to copy)
 * is on that list. A monotonic SEQUENCE NUMBER answers the same question —
 * "did exactly one entry get added for this one interaction" — without
 * sampling a clock at all: incrementing a counter is not reading time.
 *
 * @module foundry/time-authority
 */
import { readIsGM } from './scene-vision.js';
import { readCombatActive } from './combat-state.js';

/** Ring buffer capacity — enough to see "the last few gestures", not a log. */
const AUDIT_LOG_CAPACITY = 50;

/** @type {Array<{seq: number, delta: number, source: string, reason: string|null, ok: boolean, resultReason: string|null, worldTimeAfter: number|null}>} */
const auditLog = [];
let seqCounter = 0;

/**
 * Is the Pen armed for the given (already-resolved) posture?
 * @param {string} posture - one of `world/day-clock.js#ALMANAC_POSTURES`.
 * @returns {boolean}
 */
export function isPenArmed(posture) {
  return posture === 'almanac';
}

/** @param {object} entry */
function recordAudit(entry) {
  seqCounter += 1;
  auditLog.push({ seq: seqCounter, ...entry });
  while (auditLog.length > AUDIT_LOG_CAPACITY) auditLog.shift();
}

/**
 * The last (up to) {@link AUDIT_LOG_CAPACITY} advance attempts, successful
 * AND refused alike — a refused attempt (combat holding the pen, a non-GM
 * client, an unarmed posture) is itself useful diagnostic evidence that the
 * gate actually fired, not noise to filter out.
 * @returns {typeof auditLog} a frozen copy — callers cannot mutate history.
 */
export function getAdvanceAuditLog() {
  return Object.freeze(auditLog.map((e) => Object.freeze({ ...e })));
}

/**
 * THE ONE WRITE. Whole-second, gated, audited.
 *
 * @param {number} deltaSeconds - signed; rounded to the nearest whole second
 *   (Foundry's own server truncates fractional worldTime within ~30s of a
 *   sync pull regardless — Almanac Testament §3.1 — so committing anything
 *   but an integer is a promise this system cannot keep).
 * @param {object} options
 * @param {string} options.posture - the CURRENT resolved Almanac posture
 *   (caller-supplied — see this module's header for why).
 * @param {string} [options.source] - a short tag identifying the caller
 *   ('astrolabe-drag', 'jump-button', 'report-test', …) — shows up in the
 *   audit log so a reviewer can tell which gesture produced which entry.
 * @param {string} [options.reason] - free-text context, logged verbatim.
 * @returns {Promise<{ok: boolean, reason: string|null, delta: number, worldTimeAfter: number|null}>}
 */
export async function advance(deltaSeconds, { posture, source = 'unspecified', reason = null } = {}) {
  const rounded = Math.round(Number(deltaSeconds));

  const refuse = (resultReason) => {
    recordAudit({ delta: rounded, source, reason, ok: false, resultReason, worldTimeAfter: readWorldTimeSafe() });
    return { ok: false, reason: resultReason, delta: rounded, worldTimeAfter: readWorldTimeSafe() };
  };

  if (!Number.isFinite(rounded)) return refuse('deltaSeconds was not a finite number');
  if (!isPenArmed(posture)) return refuse(`the Pen is not armed (posture is '${posture}', not 'almanac')`);
  if (!readIsGM()) return refuse('only a GM-role client may hold the Pen');
  const combat = readCombatActive();
  if (combat.active) return refuse('combat holds the Pen — an encounter is running');

  if (rounded === 0) {
    // Nothing to do — a legitimate no-op (a gesture that resolved to zero
    // change), not an error. Still audited: a run of zero-delta entries is
    // itself a diagnostic fact (a control firing on every pixel of a drag
    // that never crossed a whole second, say).
    recordAudit({
      delta: 0,
      source,
      reason,
      ok: true,
      resultReason: 'no-op (zero delta)',
      worldTimeAfter: readWorldTimeSafe(),
    });
    return { ok: true, reason: null, delta: 0, worldTimeAfter: readWorldTimeSafe() };
  }

  try {
    if (typeof game === 'undefined' || !game?.time || typeof game.time.advance !== 'function') {
      return refuse('game.time.advance is not available');
    }
    await game.time.advance(rounded);
    const worldTimeAfter = readWorldTimeSafe();
    recordAudit({ delta: rounded, source, reason, ok: true, resultReason: null, worldTimeAfter });
    return { ok: true, reason: null, delta: rounded, worldTimeAfter };
  } catch (err) {
    return refuse(`game.time.advance threw: ${err?.message ?? err}`);
  }
}

/** @returns {number|null} never throws. */
function readWorldTimeSafe() {
  try {
    return typeof game !== 'undefined' && typeof game?.time?.worldTime === 'number' ? game.time.worldTime : null;
  } catch {
    return null;
  }
}

/** @returns {{hoursPerDay: number}} the active calendar's day length, Earth default on any failure. */
function readDaysPerYearUnits() {
  try {
    const days = game?.time?.calendar?.days;
    const hoursPerDay = Number(days?.hoursPerDay);
    return { hoursPerDay: Number.isFinite(hoursPerDay) && hoursPerDay > 0 ? hoursPerDay : 24 };
  } catch {
    return { hoursPerDay: 24 };
  }
}

/** @returns {number} the active calendar's weekday-cycle length, 7 on any failure. */
function readWeekLength() {
  try {
    const len = game?.time?.calendar?.days?.values?.length;
    return Number.isInteger(len) && len > 0 ? len : 7;
  } catch {
    return 7;
  }
}

/**
 * Advance to the NEXT occurrence of a clock hour (always forward — "next
 * dawn", never "the most recent one"). A generic primitive: the CALLER
 * decides what hour it wants (dawn/dusk/noon/midnight computed from
 * `world/sun.js#phaseBoundaryHours`, or any other hour) — this file has no
 * sun-model awareness at all, for the same leaf-boundary reason as
 * `posture` above.
 *
 * @param {number} targetHour - 0..24.
 * @param {object} options - same as {@link advance}'s `options`.
 * @returns {Promise<ReturnType<typeof advance>>}
 */
export async function jumpToHour(targetHour, options) {
  const worldTime = readWorldTimeSafe();
  if (worldTime === null) {
    return { ok: false, reason: 'game.time.worldTime is not available', delta: 0, worldTimeAfter: null };
  }
  const { hoursPerDay } = readDaysPerYearUnits();
  const secondsPerDay = hoursPerDay * 3600;
  const secondsPerHour = secondsPerDay / 24; // 24 = MSA's own normalised hour axis (game-time.js)
  const currentHour = (((worldTime / secondsPerHour) % 24) + 24) % 24;
  let deltaHours = (((Number(targetHour) - currentHour) % 24) + 24) % 24;
  if (deltaHours === 0) deltaHours = 24; // "next" dawn when it IS currently dawn means tomorrow's
  return advance(deltaHours * secondsPerHour, options);
}

/**
 * Advance by whole calendar days (the active calendar's own day length —
 * `readDaysPerYearUnits`), same hour, N days later.
 * @param {number} n - whole days, may be negative (a correction — Almanac
 *   Testament §6.3: "backwards is a correction, not a mechanic").
 * @param {object} options - same as {@link advance}'s `options`.
 * @returns {Promise<ReturnType<typeof advance>>}
 */
export async function advanceDays(n, options) {
  const { hoursPerDay } = readDaysPerYearUnits();
  return advance(Number(n) * hoursPerDay * 3600, options);
}

/**
 * Advance by whole calendar weeks (the active calendar's own weekday-cycle
 * length, `readWeekLength` — 7 for every shipped calendar today).
 * @param {number} n @param {object} options
 * @returns {Promise<ReturnType<typeof advance>>}
 */
export async function advanceWeeks(n, options) {
  const { hoursPerDay } = readDaysPerYearUnits();
  return advance(Number(n) * readWeekLength() * hoursPerDay * 3600, options);
}
