/**
 * ui/rooms/remote/astrolabe-dial.js — pure math verification. Ported
 * verbatim from the approved mock (tools/ui-mock/index.html); this suite
 * pins the port against known values so a future edit can't silently drift
 * from what the author actually signed off on.
 */
import { skyFor, orbitXY, terrainColorFor, elevationFactors, rgb } from '../rooms/remote/astrolabe-dial.js';

export function run(t) {
  const { ok } = t;

  // ---- rgb ------------------------------------------------------------------
  {
    ok('rgb formats a triple as an rgb() string', rgb([255, 0, 128]) === 'rgb(255,0,128)');
    ok('rgb floors fractional components', rgb([1.9, 2.9, 3.9]) === 'rgb(1,2,3)');
  }

  // ---- skyFor: exact keyframe hours return that keyframe's own colours -----
  {
    const noon = skyFor(12);
    ok('noon sky top matches the mock keyframe exactly', noon.top.join(',') === '42,111,188');
    ok('noon sky mid matches the mock keyframe exactly', noon.mid.join(',') === '99,163,216');
    ok('noon sky bottom matches the mock keyframe exactly', noon.bot.join(',') === '168,205,234');

    const midnight = skyFor(0);
    ok('midnight sky top matches the mock keyframe exactly', midnight.top.join(',') === '7,12,34');

    const wrapped = skyFor(24);
    ok('hour 24 wraps to the same keyframe as hour 0', wrapped.top.join(',') === midnight.top.join(','));
    const over = skyFor(30);
    ok('an hour beyond 24 wraps correctly (30 == 6)', over.top.join(',') === skyFor(6).top.join(','));
  }

  // ---- skyFor: interpolation lands strictly between its two straddling keys -
  {
    // Between hour 0 ([7,12,34]) and hour 5 ([10,17,48]), hour 2.5 is the midpoint.
    const mid = skyFor(2.5);
    ok('interpolated hour lands between its two keyframes (top.r)', mid.top[0] > 7 && mid.top[0] < 10);
    ok('interpolated hour lands between its two keyframes (top.g)', mid.top[1] > 12 && mid.top[1] < 17);
  }

  // ---- orbitXY ----------------------------------------------------------------
  {
    const noon = orbitXY(12);
    ok('the sun/moon crests (max elevation) at hour 12', Math.abs(noon.elev - 1) < 1e-9);
    const midnight = orbitXY(0);
    ok('the sun/moon troughs (min elevation) at hour 0', Math.abs(midnight.elev - -1) < 1e-9);
    const dawn = orbitXY(6);
    ok('elevation crosses zero at hour 6 (rise)', Math.abs(dawn.elev) < 1e-9);
    const dusk = orbitXY(18);
    ok('elevation crosses zero at hour 18 (set)', Math.abs(dusk.elev) < 1e-9);
    ok('dawn sits left of centre', dawn.x < 80);
    ok('dusk sits right of centre', dusk.x > 80);
  }

  // ---- elevationFactors ------------------------------------------------------
  {
    const noonF = elevationFactors(1);
    ok('full elevation is full day', noonF.day01 === 1);
    ok('full elevation has zero night', noonF.night01 === 0);
    const midnightF = elevationFactors(-1);
    ok('trough elevation is zero day', midnightF.day01 === 0);
    ok('trough elevation is full night', midnightF.night01 === 1);
    const horizonF = elevationFactors(0);
    ok('horizon elevation is peak golden factor', horizonF.golden01 === 1);
  }

  // ---- terrainColorFor ---------------------------------------------------------
  {
    const nightGround = terrainColorFor('ground', 0, 0);
    ok('day01=0 golden01=0 returns the pure night palette', nightGround.join(',') === '8,13,24');
    const dayGround = terrainColorFor('ground', 1, 0);
    ok('day01=1 golden01=0 returns the pure day palette', dayGround.join(',') === '86,114,70');
    const warmedGround = terrainColorFor('ground', 1, 1);
    ok(
      'day01=1 golden01=1 warms the day palette toward the warm colour, not equal to pure day',
      warmedGround.join(',') !== dayGround.join(',')
    );
  }
}
