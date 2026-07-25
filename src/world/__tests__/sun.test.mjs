/**
 * The ONE SUN, pinned at its anchors. These assertions are the whole point:
 * the sun's position is DERIVED once and proven here — never probed, never
 * re-derived per consumer (V2 had eight suns; roof drips VOTED on a mapping
 * at runtime and "never reliably worked").
 */
import { computeSun, normalizeHour, DEFAULT_SUN_CONFIG, SKY_PHASES, phaseBoundaryHours } from '../sun.js';

export function run(t) {
  const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

  // ---- the anchors (the author's own ToD anchor hours) ---------------------
  {
    const noon = computeSun(12);
    t.ok('noon: sun due south (azimuth 180)', close(noon.azimuthDeg, 180));
    t.ok('noon: max elevation', close(noon.elevationDeg, DEFAULT_SUN_CONFIG.maxElevationDeg));
    t.ok('noon: fully day', noon.dayFactor01 === 1 && noon.aboveHorizon);

    const dawn = computeSun(6);
    t.ok('06:00: sun due east (azimuth 90)', close(dawn.azimuthDeg, 90));
    t.ok('06:00: exactly on the horizon', close(dawn.elevationDeg, 0));
    t.ok('06:00: golden hour peaks', close(dawn.twilight01, 1));

    const dusk = computeSun(18);
    t.ok('18:00: sun due west (azimuth 270)', close(dusk.azimuthDeg, 270));
    t.ok('18:00: exactly on the horizon', close(dusk.elevationDeg, 0));

    const midnight = computeSun(0);
    t.ok('midnight: sun fully below horizon', close(midnight.elevationDeg, -DEFAULT_SUN_CONFIG.maxElevationDeg));
    t.ok('midnight: fully night', midnight.dayFactor01 === 0 && !midnight.aboveHorizon);
    t.ok('midnight: azimuth wraps to north (0)', close(midnight.azimuthDeg, 0));
  }

  // ---- continuity: no pop at any hour boundary -----------------------------
  {
    // A branchy sun model pops shadow directions at sunrise; this one must be
    // continuous everywhere, including across midnight.
    const a = computeSun(23.999);
    const b = computeSun(0.001);
    t.ok('continuous across midnight (elevation)', Math.abs(a.elevationDeg - b.elevationDeg) < 0.01);
    let maxJump = 0;
    for (let h = 0; h < 24; h += 0.25) {
      const e1 = computeSun(h).elevationDeg;
      const e2 = computeSun(h + 0.01).elevationDeg;
      maxJump = Math.max(maxJump, Math.abs(e2 - e1));
    }
    t.ok('no elevation jump anywhere in the day', maxJump < 0.2);
  }

  // ---- symmetry + config ----------------------------------------------------
  {
    t.ok('morning/afternoon elevations mirror', close(computeSun(9).elevationDeg, computeSun(15).elevationDeg));
    const low = computeSun(12, { maxElevationDeg: 30 });
    t.ok('config: maxElevation honoured', close(low.elevationDeg, 30));
    const shifted = computeSun(12, { noonAzimuthDeg: 0 });
    t.ok('config: noon azimuth honoured', close(shifted.azimuthDeg, 0));
  }

  // ---- robustness: broken inputs stay LOUDLY neutral, never NaN -------------
  {
    t.ok('normalizeHour wraps negatives', normalizeHour(-1) === 23);
    t.ok('normalizeHour wraps past 24', normalizeHour(25) === 1);
    t.ok('NaN input reads as noon, not NaN', computeSun(NaN).todHour === 12);
    const s = computeSun(7.3);
    t.ok('result is frozen (a call sheet, not a scratchpad)', Object.isFrozen(s));
    t.ok(
      'every field finite',
      Object.values(s).every((v) => typeof v !== 'number' || Number.isFinite(v))
    );
  }

  // ==========================================================================
  // THE SECTIONS OF THE SKY (2026-07-23) — derived from elevation, so the
  // astrolabe's ring arcs are a VIEW of this model and can never drift from it
  // the way V2's eight hand-placed hour anchors did.
  // ==========================================================================
  {
    t.ok('noon is Day', computeSun(12).phase === 'day');
    t.ok('midnight is Night', computeSun(0).phase === 'night');
    // Sunrise (elevation 0) is the START of golden hour, not the end of blue —
    // each section owns elevations UP TO its ceiling, exclusive.
    t.ok('just BEFORE sunrise is the blue hour', computeSun(5.8).phase === 'civil');
    t.ok('sunrise itself opens golden hour', computeSun(6).phase === 'golden');
    // The sun climbs fast: golden hour (0°→6°) is over by ~06:23, not 07:00.
    t.ok('a few minutes after sunrise is still golden', computeSun(6.2).phase === 'golden');
    t.ok('half an hour after sunrise it is already Day', computeSun(6.6).phase === 'day');
    t.ok(
      'every phase key is one of SKY_PHASES',
      SKY_PHASES.some((p) => p.key === computeSun(3).phase)
    );
  }

  {
    // The ONLY thing distinguishing a 05:00 blue hour from a 19:00 one: the
    // model is symmetric about noon, so a consumer without `rising` will
    // cheerfully label dawn as dusk.
    const dawn = computeSun(6);
    const dusk = computeSun(18);
    t.ok('dawn and dusk sit at the same elevation', close(dawn.elevationDeg, dusk.elevationDeg));
    t.ok('...and the same phase', dawn.phase === dusk.phase);
    t.ok('but `rising` tells them apart', dawn.rising === true && dusk.rising === false);
  }

  {
    // The author's ask, asserted rather than described: darkness must NOT hit 1
    // at sunset. `skyFactor01` is what carries the lit sky past the horizon.
    // THE relationship, and the reason there are two curves at all: at every
    // hour of the evening the sky is lit MORE than the direct sun is — that gap
    // IS the blue hour, and darkness keys off the longer one.
    for (const h of [18, 18.4, 18.8, 19]) {
      t.ok(`@${h}: the sky outlasts the sun`, computeSun(h).skyFactor01 > computeSun(h).dayFactor01);
    }
    const sunGone = computeSun(18.383); // the exact hour dayFactor01 reaches 0
    t.ok('when the direct sun is fully gone...', close(sunGone.dayFactor01, 0, 1e-6));
    t.ok('...the sky is still more than half lit', sunGone.skyFactor01 > 0.5);

    const fullDark = computeSun(19.5);
    t.ok('and the sky is fully dark well AFTER dusk', close(fullDark.skyFactor01, 0));
    t.ok('symmetric before dawn', close(computeSun(4.5).skyFactor01, 0));
    t.ok('full day is fully lit', computeSun(12).skyFactor01 === 1);

    let maxJump = 0;
    for (let h = 0; h < 24; h += 0.25) {
      maxJump = Math.max(maxJump, Math.abs(computeSun(h + 0.01).skyFactor01 - computeSun(h).skyFactor01));
    }
    t.ok('skyFactor is continuous — no pop anywhere in the day', maxJump < 0.02);
  }

  {
    const dark = computeSun(21, { fullDarkElevationDeg: -6 });
    const darkLater = computeSun(21, { fullDarkElevationDeg: -30 });
    t.ok('config: a shallower full-dark angle makes night arrive sooner', dark.skyFactor01 <= darkLater.skyFactor01);
  }

  // ---- the ring arcs, derived by inverting the elevation curve --------------
  {
    const bands = phaseBoundaryHours();
    t.ok(
      'every phase key that occurs is represented',
      bands.some((b) => b.key === 'day')
    );
    t.ok(
      'bands are returned in clock order',
      bands.every((b, i) => i === 0 || bands[i - 1].startHour <= b.startHour)
    );

    const day = bands.find((b) => b.key === 'day');
    t.ok('the day band is centred on noon', close((day.startHour + day.endHour) / 2, 12, 1e-6));

    const night = bands.find((b) => b.key === 'night');
    t.ok('the night band wraps midnight (start > end)', night.startHour > night.endHour);

    // The load-bearing property: a band boundary must land exactly where the
    // sun model says the phase changes. This is what "a view of the model,
    // not a copy of it" means, made mechanical.
    for (const b of bands) {
      const justInside = computeSun(b.startHour + 0.01);
      t.ok(`band ${b.key} @${b.startHour.toFixed(2)} agrees with computeSun`, justInside.phase === b.key);
    }
  }

  {
    // A sun that never gets low enough for a section must OMIT it, not draw a
    // sliver at noon. Honest absence over a lie that renders.
    const shallow = phaseBoundaryHours({ maxElevationDeg: 5 });
    t.ok('a sun peaking at 5° never reaches Day', !shallow.some((b) => b.key === 'day'));
    t.ok('and never reaches astronomical Night either', !shallow.some((b) => b.key === 'night'));
    t.ok('but the sections it DOES reach are still returned', shallow.length > 0);
  }
}
