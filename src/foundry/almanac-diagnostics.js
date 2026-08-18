/**
 * THE ALMANAC DIAGNOSTIC REPORT — one button, everything this Testament's
 * exit gates need a live GM's eyes on, in one clipboard-ready object. Built
 * at the author's own direction (2026-08-17): *"build a button which will
 * output a report/test the system so that when I do get a chance to
 * actually test it I can use that to get you the data you need."*
 *
 * Follows the SAME "diagnostics file, separate from what it diagnoses"
 * shape as `vt/vt-pan-viewer-diagnostics.js` and `foundry/vision-
 * diagnostics.js` — a report is its own concern, not a side-channel bolted
 * onto the functional module. `boot.js` registers this via `MapShine.debug
 * .registerReport`; this file only builds the object.
 *
 * ============================================================================
 * WHY SO MANY OPTIONS ARE "HANDED IN" RATHER THAN READ DIRECTLY
 * ============================================================================
 *
 * `foundry/` cannot import `world/` (the leaf-boundary finding this whole
 * Testament stage kept re-confirming — `core/gregorian-math.js`, `calendar-
 * install.js`, `time-authority.js` all document the same thing). This
 * report needs the calendar REGISTRY and the ALMANAC's own projection/
 * format functions to build its PF2E-parity comparison, and it needs the
 * day clock's own current hour to check reconcile health — none of which
 * `foundry/` can reach on its own. `boot.js`, which already holds all of
 * these (the calendar registry via `world/index.js`'s door, the resolved
 * `skyScope` for posture, `getVtPanViewerTimeDialState()` for the day
 * clock), hands them in. Every field is OPTIONAL and defaulted gracefully —
 * a gap in boot.js's own wiring should shrink what the report can show,
 * never crash the whole panel (`feedback_instruments_must_not_lie`: an
 * absent section is a measurement, not a bug to paper over).
 *
 * @module foundry/almanac-diagnostics
 */
import { readCombatActive } from './combat-state.js';
import { readPf2eDarknessSyncStatus } from './pf2e-darkness-standdown.js';
import { isPenArmed, getAdvanceAuditLog } from './time-authority.js';
import { readWorldTimeOfDay, readGamePaused } from './game-time.js';
import { readIsGM } from './scene-vision.js';
import { readSetting } from './settings-adapter.js';

/** @returns {object} what CONFIG.time currently holds, read-only. */
function readCalendarInstallStatus() {
  try {
    if (typeof CONFIG === 'undefined' || !CONFIG.time) {
      return { ok: false, reason: 'CONFIG.time is not available' };
    }
    const cls = CONFIG.time.worldCalendarClass;
    const worldCalendarClassName = cls?.name ?? (cls === undefined ? '(undefined)' : String(cls));
    // A true-Gregorian install names our own factory-built class; a
    // declarative install hands Foundry's OWN stock class through
    // unmodified — 'CalendarData' itself is a CORRECT outcome there, not a
    // sign the install never ran. Anything else (Foundry's shipped default,
    // e.g. a class named differently) means installActiveCalendar has not
    // taken effect on this client yet.
    const looksInstalled =
      worldCalendarClassName === 'MsaTrueGregorianCalendar' || worldCalendarClassName === 'CalendarData';
    return {
      ok: true,
      worldCalendarClassName,
      looksInstalled,
      configName: CONFIG.time.worldCalendarConfig?.name ?? null,
      calendarDayUnits: game?.time?.calendar?.days
        ? {
            hoursPerDay: game.time.calendar.days.hoursPerDay,
            minutesPerHour: game.time.calendar.days.minutesPerHour,
            secondsPerMinute: game.time.calendar.days.secondsPerMinute,
          }
        : null,
    };
  } catch (err) {
    return { ok: false, reason: `reading CONFIG.time threw: ${err?.message ?? err}` };
  }
}

/**
 * PF2E's own live WorldClock app getters, probed defensively. `game.pf2e.
 * worldClock` is NOT a receipted global path this session verified from
 * source (unlike `pf2e.worldClock` the SETTING, which is) — this is exactly
 * the kind of probe a diagnostic tool is allowed to attempt speculatively
 * that production code should not: it reports "found" or "not found", never
 * asserts the path exists.
 * @returns {object}
 */
function readPf2eLiveWorldClockDisplay() {
  try {
    if (typeof game === 'undefined' || game?.system?.id !== 'pf2e') {
      return { ok: false, reason: 'pf2e is not the active system' };
    }
    const wc = game.pf2e?.worldClock;
    if (!wc) {
      return {
        ok: false,
        reason:
          'game.pf2e.worldClock was not found at this path — UNVERIFIED global, this probe exists to confirm or refute it live, not to assert it',
      };
    }
    const out = { ok: true };
    for (const key of ['year', 'month', 'day', 'era', 'weekday', 'dateTheme']) {
      try {
        out[key] = wc[key];
      } catch (err) {
        out[key] = `(reading .${key} threw: ${err?.message ?? err})`;
      }
    }
    return out;
  } catch (err) {
    return { ok: false, reason: `probing game.pf2e.worldClock threw: ${err?.message ?? err}` };
  }
}

/** @returns {object} pf2e.worldClock's raw stored setting, or why not. */
function readPf2eWorldClockSettingRaw() {
  try {
    if (typeof game === 'undefined' || game?.system?.id !== 'pf2e') {
      return { ok: false, reason: 'pf2e is not the active system' };
    }
    const worldClock = readSetting('pf2e', 'worldClock');
    return {
      ok: true,
      worldCreatedOn: worldClock?.worldCreatedOn ?? null,
      dateTheme: worldClock?.dateTheme ?? null,
      syncDarkness: worldClock?.syncDarkness === true,
    };
  } catch (err) {
    return { ok: false, reason: `reading pf2e.worldClock setting threw: ${err?.message ?? err}` };
  }
}

/**
 * @param {object} [options]
 * @param {Record<string, object>} [options.calendars] - the calendar registry
 *   (`world/index.js#CALENDARS`).
 * @param {(worldTimeSeconds: number, calendarConfig: object, themeId?: string) => object} [options.projectWorldTime]
 *   `world/almanac.js#projectWorldTime`.
 * @param {string} [options.posture] - the CURRENT resolved Almanac posture
 *   (boot.js's `skyScope.sky.mode`).
 * @param {number|null} [options.dayClockTodHour] - the day clock's own
 *   current hour (`getVtPanViewerTimeDialState()?.todHour`), for the
 *   reconcile-health comparison.
 * @returns {object} the full report — never throws.
 */
export function buildAlmanacDiagnosticsReport({ calendars, projectWorldTime, posture, dayClockTodHour } = {}) {
  const report = { report: 'almanac-diagnostics', generatedAt: new Date().toISOString() };

  // ---- 1. Calendar install status ------------------------------------------
  report.calendarInstall = readCalendarInstallStatus();
  const worldTimeRead = readWorldTimeOfDay();
  report.worldTime = {
    raw: typeof game !== 'undefined' ? (game?.time?.worldTime ?? null) : null,
    todHour: worldTimeRead.todHour,
    components: worldTimeRead.components,
  };

  // ---- 2. PF2E parity comparison --------------------------------------------
  const pf2eSetting = readPf2eWorldClockSettingRaw();
  report.pf2e = { worldClockSetting: pf2eSetting, liveWorldClock: readPf2eLiveWorldClockDisplay() };
  if (
    pf2eSetting.ok &&
    typeof calendars?.['golarion-parity'] === 'object' &&
    typeof projectWorldTime === 'function' &&
    report.worldTime.raw !== null
  ) {
    try {
      const epochOffsetSeconds = Date.parse(pf2eSetting.worldCreatedOn) / 1000;
      const calendarConfig = { ...calendars['golarion-parity'], epochOffsetSeconds };
      report.pf2e.ourProjection = projectWorldTime(report.worldTime.raw, calendarConfig, pf2eSetting.dateTheme);
    } catch (err) {
      report.pf2e.ourProjection = { ok: false, reason: `projectWorldTime threw: ${err?.message ?? err}` };
    }
  } else {
    report.pf2e.ourProjection = {
      ok: false,
      reason: 'not computed — pf2e inactive, calendars/projectWorldTime not supplied, or worldTime unavailable',
    };
  }

  // ---- 3. The Pen's status --------------------------------------------------
  const combat = readCombatActive();
  report.pen = {
    posture: posture ?? null,
    armed: typeof posture === 'string' ? isPenArmed(posture) : null,
    currentUserIsGM: readIsGM(),
    combatActive: combat.active,
    combatSource: combat.source,
    paused: readGamePaused().paused,
    auditLog: getAdvanceAuditLog(),
  };

  // ---- 4. syncDarkness stand-down status ------------------------------------
  report.pf2eDarknessStanddown = readPf2eDarknessSyncStatus();

  // ---- 5. Day-clock reconcile health -----------------------------------------
  if (typeof dayClockTodHour === 'number' && typeof report.worldTime.todHour === 'number') {
    // Shortest-way-round-the-dial delta — a naive subtraction would read a
    // healthy clock near midnight (23.9 vs 0.1) as "12 hours adrift".
    const raw = Math.abs(dayClockTodHour - report.worldTime.todHour);
    const deltaHours = Math.min(raw, 24 - raw);
    report.dayClockReconcile = {
      dayClockTodHour,
      worldTimeTodHour: report.worldTime.todHour,
      deltaHours,
      healthy: deltaHours < 0.05,
    };
  } else {
    report.dayClockReconcile = { ok: false, reason: 'dayClockTodHour not supplied or worldTime unavailable' };
  }

  return report;
}
