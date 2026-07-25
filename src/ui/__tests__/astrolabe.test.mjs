/**
 * THE ASTROLABE's pure core — the maths behind the dial, split out from the DOM
 * exactly the way `scene/paint-mask.js` splits from `ui/paint-mode.js`.
 *
 * The arc-geometry assertions are the ones that earn their keep: a ring band
 * that silently degenerates renders as nothing, and "nothing" is
 * indistinguishable from "the band was never computed" — the lying-instrument
 * failure at the level of a shape.
 */
import {
  hourToDialDeg,
  dialDegToHour,
  formatClock,
  compassLabel,
  ringArcPath,
  windDegToVisualDeg,
  visualDegToWindDeg,
  nearestRateIndex,
  formatRate,
  TIME_RATE_STEPS,
} from '../astrolabe.js';

export function run(t) {
  const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

  // ---- the dial's orientation ----------------------------------------------
  {
    t.ok('noon sits at the top of the dial', close(hourToDialDeg(12) % 360, 0));
    t.ok('midnight sits at the bottom', close(hourToDialDeg(0), 180));
    t.ok('06:00 is a quarter turn from midnight', close(hourToDialDeg(6), 270));
    t.ok('18:00 is the other quarter', close(hourToDialDeg(18) % 360, 90));
  }

  {
    // Round-tripping matters: the ring drag reads an angle and writes an hour,
    // and the handle then draws from that hour. A lossy pair makes the handle
    // creep away from the cursor over a long drag.
    for (const h of [0, 3.25, 6, 11.99, 12, 17.5, 23.75]) {
      t.ok(`round-trip @${h}`, close(dialDegToHour(hourToDialDeg(h)), h, 1e-9));
    }
  }

  // ---- readouts -------------------------------------------------------------
  {
    t.ok('noon', formatClock(12) === '12:00');
    t.ok('quarter past', formatClock(9.25) === '09:15');
    t.ok('midnight pads', formatClock(0) === '00:00');
    t.ok('wraps past 24', formatClock(25.5) === '01:30');
    t.ok('negative wraps forward', formatClock(-0.5) === '23:30');
    t.ok('compass N', compassLabel(0) === 'N');
    t.ok('compass E', compassLabel(90) === 'E');
    t.ok('compass wraps', compassLabel(359) === 'N');
  }

  // ---- the wind convention, which has bitten this project before -----------
  {
    // `world/wind-field.js` uses METEOROLOGICAL degrees — the direction wind
    // comes FROM. The arrow points where it GOES. Exactly one 180° flip, in
    // exactly one place; a second copy anywhere is how a dial ends up pointing
    // backwards and nobody can find the sign.
    t.ok('a northerly wind draws pointing south', close(windDegToVisualDeg(0), 180));
    t.ok('and back again', close(visualDegToWindDeg(180), 0));
    for (const d of [0, 45, 90, 180, 270, 359]) {
      t.ok(`wind↔visual round-trip @${d}`, close(visualDegToWindDeg(windDegToVisualDeg(d)), d));
    }
    t.ok('both stay inside 0..360', windDegToVisualDeg(-90) >= 0 && windDegToVisualDeg(-90) < 360);
  }

  // ---- the ring arcs --------------------------------------------------------
  {
    const day = ringArcPath(6.383, 17.617);
    t.ok('an arc is a closed path', day.startsWith('M ') && day.trim().endsWith('Z'));
    t.ok('an arc has both radii', (day.match(/ A /g) ?? []).length === 2);
    t.ok('no NaN reaches the DOM', !day.includes('NaN'));

    // A band that wraps midnight arrives as start > end. It must still produce
    // a real sweep — computing a NEGATIVE span here is what silently collapses
    // the whole night band to an invisible sliver.
    const night = ringArcPath(19.163, 4.837);
    t.ok('a midnight-wrapping band still draws', !night.includes('NaN') && night.length > 40);
    // 19:10 → 04:50 is 9.7 hours ≈ 145°, so the SHORT arc is correct. Getting
    // the span sign wrong here yields −14.3h, which renders as nothing at all.
    t.ok('a sub-180° wrap takes the short way', / A 146 146 0 0 1 /.test(night));

    const sliver = ringArcPath(5.6, 6.0);
    t.ok('a short band takes the short way too', / A 146 146 0 0 1 /.test(sliver));

    // A band wider than half the dial genuinely needs the large-arc flag, or
    // SVG draws its complement — the band inverts.
    const longDay = ringArcPath(5, 19); // 14 hours = 210°
    t.ok('a >180° band sets the large-arc flag', / A 146 146 0 1 1 /.test(longDay));
    const longWrap = ringArcPath(20, 10); // 14 hours, wrapping midnight
    t.ok('...including one that wraps midnight', / A 146 146 0 1 1 /.test(longWrap));
  }

  // ---- the rate ladder ------------------------------------------------------
  {
    t.ok('frozen is the first step', TIME_RATE_STEPS[0] === 0);
    t.ok('exact match', nearestRateIndex(TIME_RATE_STEPS[3]) === 3);
    t.ok('snaps to the nearest step', nearestRateIndex(0.9) === nearestRateIndex(1));
    t.ok('a wild value clamps to the top step', nearestRateIndex(1e6) === TIME_RATE_STEPS.length - 1);
    t.ok('a non-finite rate reads as frozen', nearestRateIndex(NaN) === 0);

    // The readout is in "how long is a day", not "hours per minute" — a GM can
    // turn the former into a session length and cannot do that with the latter.
    t.ok('frozen says so', formatRate(0) === 'frozen');
    t.ok('24 h/min is one day per minute', formatRate(24) === '60 s/day');
    t.ok('1 h/min is a 24-minute day', formatRate(1) === '24 min/day');
    t.ok('a slow drift reads in hours', formatRate(0.25).endsWith('h/day'));
  }
}
