/**
 * The ONE SUN, pinned at its anchors. These assertions are the whole point:
 * the sun's position is DERIVED once and proven here — never probed, never
 * re-derived per consumer (V2 had eight suns; roof drips VOTED on a mapping
 * at runtime and "never reliably worked").
 */
import { computeSun, normalizeHour, DEFAULT_SUN_CONFIG } from '../sun.js';

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
}
