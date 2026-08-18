/**
 * THE CALENDAR INSTALLER — the one place a real Foundry `CalendarData` class
 * is ever built and handed to `CONFIG.time` (Almanac Testament §4/§9 A1's
 * "Foundry installation" bullet). Behind the `foundry/adapter-only` wall like
 * every other Foundry-touching file in this directory.
 *
 * ============================================================================
 * WHY THIS FILE TAKES THE CALENDAR DATA AS AN ARGUMENT, NOT AN IMPORT
 * ============================================================================
 *
 * The shipped calendars (Golarion-parity, Earth, Golarion-lore-strict) live
 * in `world/calendar/calendars/` — `world/` is where MSA's calendar DATA
 * belongs, per the Almanac Testament. But `foundry/index.js`'s own header is
 * explicit: *"foundry/ IS A LEAF. It imports nothing above itself"* —
 * confirmed empirically the same session this file was written (zero
 * existing `src/foundry/**` file imports `src/world/`). So this module never
 * reaches for the registry itself; `boot.js` (the composition root, the same
 * role it already plays wiring `world/day-clock.js` to `foundry/game-time.js`
 * and `world/environment.js` to `foundry/scene-environment.js`) imports the
 * registry through `world/index.js`'s door and HANDS it in. The one thing
 * this file DOES reach for directly is `core/gregorian-math.js` — the pure
 * engine — because `core/` is the one zone exempt from the door requirement
 * (`zones/one-door`'s own comment: "core is the standard library").
 *
 * ============================================================================
 * THE SUBCLASS — thin, self-contained, no unverified base-class internals
 * ============================================================================
 *
 * `_decomposeTimeYears`/`componentsToTime` are FULLY reimplemented in terms
 * of `core/gregorian-math.js`'s pure functions (never calling `super.*` for
 * either), per the Almanac Testament §5.2's "matched pair" instruction and
 * the research receipt that `componentsToTime` does NOT delegate to
 * `_decomposeTimeYears` in Foundry's own base class — so overriding only one
 * direction would silently break the inverse. `epochOffsetSeconds` is a
 * captured CLOSURE variable, not a DataModel schema field: Foundry's own
 * schema pruning would silently drop an undeclared field, and extending the
 * schema to carry it is a second Foundry-globals dependency this file does
 * not need when a closure already does the job.
 *
 * ⚠️ ONE ASSUMPTION THIS FILE CANNOT VERIFY WITHOUT LIVE FOUNDRY: that
 * `this.months.values[i].days`/`this.days.hoursPerDay` etc, read off a real
 * `CalendarData` instance, resolve to plain JS values (not wrapped DataField
 * objects) — matching the shape `core/gregorian-math.js`'s pure functions
 * expect. This is what the live bench check (Almanac Testament §9 A1's exit
 * gate) exists to confirm; every OTHER piece of this feature is proven in
 * Node against an independent oracle.
 *
 * @module foundry/calendar-install
 */
import { createLogger } from '../core/log.js';
import { decomposeTrueGregorianYear, composeTrueGregorianTime, isGregorianLeapYear } from '../core/gregorian-math.js';
import { registerSettings, readSetting } from './settings-adapter.js';

const log = createLogger('calendar-install');

/** MSA's own calendar-choice setting key, under whatever module id boot.js passes. */
const CALENDAR_SETTING_KEY = 'calendarId';

/** Golarion-parity's default theme when nothing else names one (no pf2e installed). */
const DEFAULT_GOLARION_THEME_ID = 'AR';

/**
 * Register MSA's own calendar-choice world setting. Call ONCE, from the
 * `init` hook — mirrors `registerSkySettings`'s shape exactly (an `onChange`
 * that re-resolves, not a hand-written mirror).
 *
 * @param {string} moduleId
 * @param {string[]} calendarIds - the registry's known ids, for the enum choices.
 * @param {{onChange?: () => void}} [options]
 */
export function registerCalendarSetting(moduleId, calendarIds, { onChange } = {}) {
  try {
    registerSettings(
      moduleId,
      [
        {
          key: CALENDAR_SETTING_KEY,
          scope: 'world',
          kind: 'enum',
          choices: Object.fromEntries(calendarIds.map((id) => [id, id])),
          default: 'earth',
          name: 'Almanac calendar',
          hint: "Which calendar MSA projects worldTime through. Ignored under pf2e — pf2e's own World Clock settings are read live instead.",
        },
      ],
      { onChange: () => onChange?.() }
    );
  } catch (err) {
    log.error('calendar setting registration failed:', err);
  }
}

/**
 * Detect an active pf2e system and read its World Clock's epoch + theme —
 * the Almanac Testament §9 A1 bullet's *"under pf2e the epoch/theme are READ
 * from pf2e.worldClock, never duplicated"*. Never throws: a missing/broken
 * pf2e setting is reported, not crashed on — a calendar install failure must
 * not be able to take the rest of boot down with it.
 *
 * @returns {{ok: true, epochOffsetSeconds: number, themeId: string}|{ok: false, reason: string}}
 */
function readPf2eWorldClock() {
  try {
    if (typeof game === 'undefined' || game?.system?.id !== 'pf2e') {
      return { ok: false, reason: 'pf2e is not the active system' };
    }
    // readSetting (not a raw game.settings.get) — settings-adapter.js's own
    // header calls itself "the ONE place game.settings is touched"; reading a
    // FOREIGN module's setting through it keeps that true in spirit, not just
    // by the wall's letter (the wall permits any foundry/ file — this doesn't
    // rely on that permission).
    const worldClock = readSetting('pf2e', 'worldClock');
    const worldCreatedOn = worldClock?.worldCreatedOn;
    const dateTheme = worldClock?.dateTheme;
    if (typeof worldCreatedOn !== 'string' || typeof dateTheme !== 'string') {
      return { ok: false, reason: `pf2e.worldClock had an unexpected shape: ${JSON.stringify(worldClock)}` };
    }
    const epochMs = Date.parse(worldCreatedOn);
    if (!Number.isFinite(epochMs)) {
      return { ok: false, reason: `pf2e.worldClock.worldCreatedOn did not parse as a date: ${worldCreatedOn}` };
    }
    return { ok: true, epochOffsetSeconds: epochMs / 1000, themeId: dateTheme };
  } catch (err) {
    return { ok: false, reason: `reading pf2e.worldClock threw: ${err?.message ?? err}` };
  }
}

/**
 * Strip MSA's own extension fields (`engine`, `epochOffsetSeconds`, `themes`,
 * `divergesFromPf2e`) down to exactly what Foundry's real `CalendarData`
 * schema declares. Defensive rather than relying on unverified DataModel
 * pruning behaviour for this specific class.
 *
 * ⚠️ LIVE-CAUGHT BUG, 2026-08-17 — `seasons` is NEVER passed through as
 * `null`, even though that is a perfectly legal value in `calendar-schema.js`
 * (and both `golarion-parity`/`golarion-lore-strict`'s own data legitimately
 * have none). This is EXACTLY the trap the Almanac Testament's own A0
 * research already receipted (§3.1: *"months/seasons are declared
 * nullable:true but dereferenced unconditionally... A months:null calendar
 * throws on construction. The nullability is a lie"*) — documented, then
 * walked into anyway, because writing this adapter never cross-checked its
 * own output against that same receipt. Live symptom: `GameTime`'s own
 * constructor threw `Cannot read properties of null (reading 'values')`
 * inside Foundry's base `CalendarData#timeToComponents`, INSIDE `Game
 * .setupGame` — a hard crash that took the ENTIRE world down before
 * anything else could load, not a calendar-only failure. An empty array is
 * the "no seasons" Foundry's own base class will actually accept.
 * @param {import('../world/calendar/calendar-schema.js').CalendarConfig} calendarShape
 */
export function toFoundryCalendarConfig(calendarShape) {
  return {
    name: calendarShape.name,
    description: calendarShape.description ?? '',
    years: calendarShape.years,
    months: calendarShape.months,
    days: calendarShape.days,
    seasons: calendarShape.seasons ?? { values: [] },
  };
}

/**
 * Build a `CalendarData` subclass whose year decomposition/composition is
 * real 4/100/400 Gregorian math (`core/gregorian-math.js`), anchored at
 * `epochOffsetSeconds` seconds before `worldTime === 0`. `CalendarDataBase`
 * is passed in rather than referenced globally — the one piece of Foundry
 * surface this function touches, kept to a single parameter.
 *
 * @param {new (...args: unknown[]) => object} CalendarDataBase - Foundry's
 *   own `foundry.data.CalendarData` class, handed in rather than referenced
 *   here by name (see this file's header on the exact global path).
 * @param {number} epochOffsetSeconds
 */
function buildTrueGregorianCalendarClass(CalendarDataBase, epochOffsetSeconds) {
  return class MsaTrueGregorianCalendar extends CalendarDataBase {
    /** @override */
    _decomposeTimeYears(time) {
      return decomposeTrueGregorianYear(time + epochOffsetSeconds, this.days);
    }
    /** @override */
    componentsToTime(components) {
      return composeTrueGregorianTime(components, this) - epochOffsetSeconds;
    }
    /** @override */
    isLeapYear(year) {
      return isGregorianLeapYear(year);
    }
    // `countLeapYears` deliberately NOT overridden: nothing in this
    // subclass's own overrides calls it (both are full reimplementations —
    // see this file's header), and its exact contract ("before" vs
    // "up to and including" `year`) is not receipted from the vendored
    // source. Leaving Foundry's own version in place is honest; guessing at
    // a contract this file cannot verify would not be.
  };
}

/**
 * THE ENTRY POINT. Resolves the active calendar (pf2e's live settings when
 * pf2e is the system; MSA's own `calendarId` setting otherwise), builds
 * `CONFIG.time.worldCalendarConfig`/`worldCalendarClass`, and re-initialises
 * `game.time` if it already exists.
 *
 * Idempotent and safe to call at MULTIPLE lifecycle points — `boot.js` calls
 * it from BOTH `init` (before `game.time` exists; setting `CONFIG.time` here
 * is what `GameTime`'s own constructor reads) and `ready` (a safety net: pf2e
 * registering `pf2e.worldClock` is not something this file can prove happens
 * before MSA's own `init` fires, so a `ready`-time re-check costs one more
 * idempotent call and closes that gap rather than hoping about hook order).
 *
 * @param {{calendars: Record<string, import('../world/calendar/calendar-schema.js').CalendarConfig>, moduleId: string}} options
 * @returns {{ok: true, calendarId: string, engine: string}|{ok: false, reason: string}}
 */
export function installActiveCalendar({ calendars, moduleId }) {
  try {
    if (typeof CONFIG === 'undefined' || !CONFIG.time) {
      return { ok: false, reason: 'CONFIG.time is not available yet' };
    }

    const pf2e = readPf2eWorldClock();
    let calendarId;
    let epochOffsetSeconds;
    let themeId;
    if (pf2e.ok) {
      calendarId = 'golarion-parity';
      epochOffsetSeconds = pf2e.epochOffsetSeconds;
      themeId = pf2e.themeId;
    } else {
      calendarId = readSetting(moduleId, CALENDAR_SETTING_KEY) ?? 'earth';
      epochOffsetSeconds = 0; // fixed, honest default — see this file's header
      themeId = calendarId === 'golarion-parity' ? DEFAULT_GOLARION_THEME_ID : undefined;
    }

    const calendarShape = calendars?.[calendarId];
    if (!calendarShape) {
      log.error(`unknown calendar id '${calendarId}' — leaving Foundry's own default calendar in place`);
      return { ok: false, reason: `unknown calendar id '${calendarId}'` };
    }

    // ⚠️ UNVERIFIED WITHOUT LIVE FOUNDRY: `foundry.data.CalendarData` is this
    // file's best-evidenced guess at the class's global access path — the
    // vendored source imports it as a namespaced `data.CalendarData`
    // (`client/config.mjs`'s own default: `worldCalendarClass: data.CalendarData`),
    // matching the namespacing every OTHER Foundry class this project has
    // verified uses (`foundry.documents.JournalEntryPage`, `foundry.applications
    // .sheets.journal.JournalEntrySheet`) — but no receipt confirms this exact
    // path is ALSO exposed as a bare global. The live bench check (this
    // Testament stage's exit gate) is where this gets its first real proof;
    // if it is wrong, Foundry will throw here, loudly, not silently misbehave.
    const CalendarDataClass = foundry?.data?.CalendarData;
    if (!CalendarDataClass) {
      log.error(
        "foundry.data.CalendarData was not found — cannot install a calendar (Foundry's own default calendar stays in place)"
      );
      return { ok: false, reason: 'foundry.data.CalendarData is unavailable' };
    }

    const foundryConfig = toFoundryCalendarConfig(calendarShape);
    CONFIG.time.worldCalendarConfig = foundryConfig;
    CONFIG.time.worldCalendarClass =
      calendarShape.engine === 'true-gregorian'
        ? buildTrueGregorianCalendarClass(CalendarDataClass, epochOffsetSeconds)
        : CalendarDataClass;

    if (typeof game !== 'undefined' && game?.time && typeof game.time.initializeCalendar === 'function') {
      game.time.initializeCalendar();
    }

    log.info(
      `installed calendar '${calendarId}' (${calendarShape.engine}${pf2e.ok ? ', epoch/theme from pf2e.worldClock' : ''})${themeId ? ` — theme '${themeId}'` : ''}`
    );
    return { ok: true, calendarId, engine: calendarShape.engine };
  } catch (err) {
    log.error('calendar installation failed:', err);
    return { ok: false, reason: `installActiveCalendar threw: ${err?.message ?? err}` };
  }
}
