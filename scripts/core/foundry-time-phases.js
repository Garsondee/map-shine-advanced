/**
 * @fileoverview Foundry-compatible time-of-day phase helpers.
 *
 * These helpers provide a shared definition of dawn/noon/dusk/midnight on
 * Map Shine's normalized 0-24 hour axis while respecting the active Foundry
 * calendar configuration.
 */

const DEFAULT_HOURS_PER_DAY = 24;
const DEFAULT_MINUTES_PER_HOUR = 60;
const DEFAULT_SECONDS_PER_MINUTE = 60;

const toFinite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeHour24 = (hour) => {
  const n = toFinite(hour, 0);
  return ((n % 24) + 24) % 24;
};

const getCalendarUnits = () => {
  const days = game?.time?.calendar?.days;
  const hoursPerDay = Math.max(1, toFinite(days?.hoursPerDay, DEFAULT_HOURS_PER_DAY));
  const minutesPerHour = Math.max(1, toFinite(days?.minutesPerHour, DEFAULT_MINUTES_PER_HOUR));
  const secondsPerMinute = Math.max(1, toFinite(days?.secondsPerMinute, DEFAULT_SECONDS_PER_MINUTE));

  return {
    hoursPerDay,
    minutesPerHour,
    secondsPerMinute,
    secondsPerDay: hoursPerDay * minutesPerHour * secondsPerMinute,
    secondsPerHour: minutesPerHour * secondsPerMinute
  };
};

const calendarHoursToMapHour = (calendarHours, hoursPerDay) => {
  const h = toFinite(calendarHours, 0);
  return normalizeHour24((h / Math.max(1, hoursPerDay)) * 24);
};

const coercePhaseToCalendarHours = (value, units) => {
  if (value && typeof value === 'object') {
    const hour = toFinite(value.hour, NaN);
    if (Number.isFinite(hour)) {
      const minute = toFinite(value.minute, 0);
      const second = toFinite(value.second, 0);
      return hour + (minute / units.minutesPerHour) + (second / (units.minutesPerHour * units.secondsPerMinute));
    }
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;

  // Most direct case: phase already expressed in calendar hours.
  if (Math.abs(numeric) <= units.hoursPerDay * 1.5) return numeric;

  // Fallback: treat larger values as seconds within the day.
  if (Math.abs(numeric) <= units.secondsPerDay * 1.5) {
    return numeric / units.secondsPerHour;
  }

  return null;
};

const getNested = (obj, path) => {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
};

const getPf2ePhaseCalendarHour = (phaseName, units) => {
  if (game?.system?.id !== 'pf2e') return null;

  const clock = game?.pf2e?.worldClock;
  if (!clock || typeof clock !== 'object') return null;

  const candidatePaths = [
    [phaseName],
    ['timeOfDay', phaseName],
    ['times', phaseName],
    ['periods', phaseName],
    ['phases', phaseName]
  ];

  for (const path of candidatePaths) {
    const raw = getNested(clock, path);
    const coerced = coercePhaseToCalendarHours(raw, units);
    if (Number.isFinite(coerced)) return coerced;
  }

  return null;
};

/**
 * Get Foundry-compatible phase anchors on Map Shine's 0-24 hour axis.
 *
 * Defaults are quarter-day anchors (dawn/noon/dusk/midnight) derived from
 * the active Foundry calendar's `hoursPerDay`. PF2E world clock phase values
 * are used if they are explicitly available.
 *
 * @returns {{midnight:number,dawn:number,noon:number,dusk:number,sunrise:number,sunset:number,hoursPerDay:number}}
 */
export function getFoundryTimePhaseHours() {
  const units = getCalendarUnits();

  const defaults = {
    midnight: calendarHoursToMapHour(0, units.hoursPerDay),
    dawn: calendarHoursToMapHour(units.hoursPerDay * 0.25, units.hoursPerDay),
    noon: calendarHoursToMapHour(units.hoursPerDay * 0.5, units.hoursPerDay),
    dusk: calendarHoursToMapHour(units.hoursPerDay * 0.75, units.hoursPerDay)
  };

  const dawnCal = getPf2ePhaseCalendarHour('dawn', units);
  const noonCal = getPf2ePhaseCalendarHour('noon', units);
  const duskCal = getPf2ePhaseCalendarHour('dusk', units);
  const midnightCal = getPf2ePhaseCalendarHour('midnight', units);

  const dawn = Number.isFinite(dawnCal) ? calendarHoursToMapHour(dawnCal, units.hoursPerDay) : defaults.dawn;
  const noon = Number.isFinite(noonCal) ? calendarHoursToMapHour(noonCal, units.hoursPerDay) : defaults.noon;
  const dusk = Number.isFinite(duskCal) ? calendarHoursToMapHour(duskCal, units.hoursPerDay) : defaults.dusk;
  const midnight = Number.isFinite(midnightCal) ? calendarHoursToMapHour(midnightCal, units.hoursPerDay) : defaults.midnight;

  return {
    midnight,
    dawn,
    noon,
    dusk,
    sunrise: dawn,
    sunset: dusk,
    hoursPerDay: units.hoursPerDay
  };
}

export function getClockwiseHourDelta(fromHour, toHour) {
  return ((toFinite(toHour, 0) - toFinite(fromHour, 0)) % 24 + 24) % 24;
}

export function getWrappedHourProgress(hour, startHour, endHour) {
  const span = getClockwiseHourDelta(startHour, endHour);
  if (span < 0.0001) return null;
  const position = getClockwiseHourDelta(startHour, hour);
  if (position > span) return null;
  return position / span;
}

export function getFoundrySunlightFactor(hour, phases = getFoundryTimePhaseHours()) {
  const progress = getWrappedHourProgress(normalizeHour24(hour), phases.sunrise, phases.sunset);
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.sin(Math.PI * progress));
}
