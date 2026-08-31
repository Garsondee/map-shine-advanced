/**
 * ui/astrolabe-geometry.js — the astrolabe's pure math + vocabulary, split out
 * of `ui/astrolabe.js` (2026-08-27, UI parity plan Phase 7b: the old panel's
 * own dial — `createAstrolabe()` — is deleted along with the rest of the old
 * UI). These functions and tables are NOT old-panel-only: `ui/rooms/remote/
 * astrolabe-dial.js` (hourToDialDeg/formatClock/compassLabel/TIME_STOPS),
 * `ui/rooms/remote/astrolabe-panel.js` (TIME_RATE_STEPS), and `boot.js`
 * (phaseDisplayName, via `ui/index.js`) all depend on them — deleting
 * `astrolabe.js` whole would have taken real, live dependents down with it.
 *
 * Everything here is a pure function or frozen table: no DOM, no state, no
 * caller-specific opinion — the same "pure core, Node-tested" split
 * `scene/paint-mask.js` uses relative to `ui/paint-mode.js`. See
 * `ui/__tests__/astrolabe-geometry.test.mjs` for the arc-geometry and
 * round-trip assertions this split was originally built to protect.
 *
 * @module ui/astrolabe-geometry
 */

/** Ring geometry, in the dial's own 0..300 coordinate space. */
const FACE = 300;
const C = FACE / 2;
const R_OUTER = 146;
const R_INNER = 104;

/** The clickable time stops. Labels are the author's own from V2's dial. */
export const TIME_STOPS = Object.freeze([
  { hour: 0, label: 'Midnight' },
  { hour: 3, label: 'Pre-dawn' },
  { hour: 6, label: 'Dawn' },
  { hour: 9, label: 'Morning' },
  { hour: 12, label: 'Noon' },
  { hour: 15, label: 'Afternoon' },
  { hour: 18, label: 'Dusk' },
  { hour: 21, label: 'Night' },
]);

/** Rate presets, in game-hours per real minute. 0 is the default (frozen). */
export const TIME_RATE_STEPS = Object.freeze([0, 0.25, 1, 4, 12, 24]);

/**
 * Hour → the angle on the dial, in SVG degrees (0 = up, clockwise).
 * Midnight at the bottom, noon at the top — V2's own orientation, kept because
 * "the sun is at the top when it is overhead" is the whole readability of it.
 * @param {number} hour @returns {number}
 */
export function hourToDialDeg(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  return (h / 24) * 360 + 180;
}

/**
 * The inverse — a dial angle back to an hour. Used by the ring drag.
 * @param {number} deg @returns {number} 0..24
 */
export function dialDegToHour(deg) {
  const d = (((Number(deg) - 180) % 360) + 360) % 360;
  return (d / 360) * 24;
}

/** @param {number} hour24 @returns {string} `HH:MM` */
export function formatClock(hour24) {
  const h = ((Number(hour24) % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** @param {number} deg @returns {string} */
export function compassLabel(deg) {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return labels[Math.round((((Number(deg) % 360) + 360) % 360) / 45) % 8];
}

/**
 * The SVG path for one ring arc between two hours. Exported for its own test:
 * an arc that silently degenerates is invisible, and an invisible band is
 * indistinguishable from a band that was never computed.
 * @param {number} startHour @param {number} endHour
 * @param {number} rOuter @param {number} rInner
 * @returns {string}
 */
export function ringArcPath(startHour, endHour, rOuter = R_OUTER, rInner = R_INNER) {
  // A band that wraps midnight arrives as start > end; adding a day makes the
  // sweep positive without the caller having to split it into two arcs.
  const span = endHour > startHour ? endHour - startHour : endHour + 24 - startHour;
  const a0 = hourToDialDeg(startHour);
  const a1 = a0 + (span / 24) * 360;
  const large = span > 12 ? 1 : 0;
  const p = (deg, r) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [C + Math.cos(rad) * r, C + Math.sin(rad) * r];
  };
  const [x0o, y0o] = p(a0, rOuter);
  const [x1o, y1o] = p(a1, rOuter);
  const [x1i, y1i] = p(a1, rInner);
  const [x0i, y0i] = p(a0, rInner);
  return (
    `M ${x0o.toFixed(2)} ${y0o.toFixed(2)} ` +
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o.toFixed(2)} ${y1o.toFixed(2)} ` +
    `L ${x1i.toFixed(2)} ${y1i.toFixed(2)} ` +
    `A ${rInner} ${rInner} 0 ${large} 0 ${x0i.toFixed(2)} ${y0i.toFixed(2)} Z`
  );
}

/** @param {string} phase @param {boolean} rising @returns {string} */
export function phaseDisplayName(phase, rising) {
  const names = {
    night: 'Night',
    astronomical: rising ? 'Astronomical dawn' : 'Astronomical dusk',
    nautical: rising ? 'Nautical dawn' : 'Nautical dusk',
    civil: rising ? 'Blue hour (dawn)' : 'Blue hour (dusk)',
    golden: rising ? 'Golden hour (dawn)' : 'Golden hour (dusk)',
    day: 'Day',
  };
  return names[phase] ?? 'Day';
}

/**
 * Meteorological degrees (the direction wind comes FROM) → the arrow's own
 * rotation (it points where the wind GOES). One conversion, one place.
 * @param {number} windDeg @returns {number}
 */
export function windDegToVisualDeg(windDeg) {
  return ((((Number(windDeg) || 0) + 180) % 360) + 360) % 360;
}

/** The inverse. @param {number} visualDeg @returns {number} */
export function visualDegToWindDeg(visualDeg) {
  return ((((Number(visualDeg) || 0) + 180) % 360) + 360) % 360;
}

/** @param {number} hoursPerMinute @returns {number} index into TIME_RATE_STEPS */
export function nearestRateIndex(hoursPerMinute) {
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < TIME_RATE_STEPS.length; i++) {
    const gap = Math.abs(TIME_RATE_STEPS[i] - (Number(hoursPerMinute) || 0));
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

/** @param {number} hoursPerMinute @returns {string} */
export function formatRate(hoursPerMinute) {
  const r = Number(hoursPerMinute) || 0;
  if (r === 0) return 'frozen';
  // How long one game-day takes in real minutes — far more legible to a GM than
  // "0.25 h/min", which nobody can turn into a session length in their head.
  const minutesPerDay = 24 / r;
  if (minutesPerDay >= 90) return `${(minutesPerDay / 60).toFixed(1)} h/day`;
  if (minutesPerDay >= 1.5) return `${Math.round(minutesPerDay)} min/day`;
  return `${Math.round(minutesPerDay * 60)} s/day`;
}
