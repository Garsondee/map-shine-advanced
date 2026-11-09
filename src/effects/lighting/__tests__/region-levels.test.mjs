/**
 * Node verification for the darkness-Region gates the viewer applies each frame
 * (2026-11-09): Foundry's Levels scope (mmp-78u.19) on top of MSA's per-floor
 * elevation band, and Foundry's min rule across several behaviours of ONE Region
 * (mmp-78u.22). Fixtures are the MSA Lab's Interiors & Regions scene (plots R4,
 * STAIR, R2b): Basement [-20,0), Ground [0,20), Upper [20,40).
 *
 * Namespace import, so this file still runs against an older region-geometry.js
 * (the failing-on-old-code proof): a missing export is a failed check, not a crash.
 */
import * as RG from '../region-geometry.js';

const SQUARE = [{ type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }];
const FLOORS = {
  basement: { id: 'LB', bottom: -20, top: 0 },
  ground: { id: 'LG', bottom: 0, top: 20 },
  upper: { id: 'LU', bottom: 20, top: 40 },
};
const reg = (key, levels, bottom, top, modifier) => ({
  key,
  regionId: key,
  mode: 0,
  modifier,
  shapes: SQUARE,
  levels,
  elevationBottom: bottom,
  elevationTop: top,
});
// The lab scene's Regions (interiors-spec.mjs R4 + STAIR + the basement-wide indoor Region).
const LAB = [
  reg('R4.A', ['LG'], null, null, 0.5), // levels [Ground], elevation open
  reg('R4.B', [], 0, 20, 0.5), // levels [], elevation [0,20)
  reg('R4.D', [], null, null, 0.5), // levels [], elevation open: every floor
  reg('basement', ['LB'], -20, 0, 0.9),
  reg('STAIR.below', [], -20, 0, 0.9),
];

export function run(t) {
  const { ok } = t;
  const select = RG.selectRegionsForViewedFloor;
  const included = RG.regionIncludedInLevel;
  ok('selectRegionsForViewedFloor is exported', typeof select === 'function');
  ok('regionIncludedInLevel is exported', typeof included === 'function');

  if (typeof included === 'function') {
    ok('an empty Levels list is included on every Level (Foundry includedInLevel)', included([], 'LG') === true);
    ok('an absent Levels list reads as empty', included(undefined, 'LG') === true);
    ok('a listed Level is included', included(['LB', 'LG'], 'LG') === true);
    ok('an unlisted Level is not', included(['LG'], 'LB') === false);
    ok('no viewed Level identified fails OPEN (never darkness-mutes a scene)', included(['LG'], null) === true);
  }

  if (typeof select === 'function') {
    const view = (f) =>
      select(LAB, { floorBottom: f.bottom, floorTop: f.top, viewedLevelId: f.id })
        .map((r) => r.key)
        .sort()
        .join(',');
    ok('from Ground: A, B, D (the basement Regions are below its band)', view(FLOORS.ground) === 'R4.A,R4.B,R4.D');
    // IR-22: Foundry never views A on the Basement; MSA used to leak it there (open elevation).
    ok(
      "from the Basement: A (levels [Ground]) is NOT applied, the basement's own Regions are",
      view(FLOORS.basement) === 'R4.D,STAIR.below,basement'
    );
    // IR-23 (A half): A is not viewed from Upper either.
    ok('from Upper: A (levels [Ground]) is NOT applied; only D (every floor) is', view(FLOORS.upper) === 'R4.D');
    ok(
      'an unidentified floor fails open on BOTH gates (every Region active), as before',
      select(LAB, { floorBottom: null, floorTop: null, viewedLevelId: null }).length === LAB.length
    );
    ok(
      'a Region with no levels field at all (an older reader) still passes the Levels gate',
      select([{ ...LAB[2], levels: undefined }], { floorBottom: 0, floorTop: 20, viewedLevelId: 'LG' }).length === 1
    );
    ok(
      'a non-array input reads as no Regions, never throws',
      Array.isArray(select(null, {})) && !select(null, {}).length
    );
  }

  // ---- several behaviours on one Region: the minimum wins, whatever the order (IR-26) ----
  {
    const both = (a, b) => [
      { key: 'R2b#a', regionId: 'R2b', mode: 0, modifier: a, shapes: SQUARE },
      { key: 'R2b#b', regionId: 'R2b', mode: 0, modifier: b, shapes: SQUARE },
    ];
    const at = (regions) => RG.computeRegionAdjustedDarkness(50, 50, 0, regions);
    ok('OVERRIDE .9 then .4 reads 0.4 (Foundry: one mesh each, min wins)', Math.abs(at(both(0.9, 0.4)) - 0.4) < 1e-9);
    ok('OVERRIDE .4 then .9 reads 0.4 too', Math.abs(at(both(0.4, 0.9)) - 0.4) < 1e-9);
    const mixed = [
      { key: 'm#o', regionId: 'm', mode: 0, modifier: 0.9, shapes: SQUARE },
      { key: 'm#d', regionId: 'm', mode: 2, modifier: 0.4, shapes: SQUARE },
    ];
    ok(
      'mixed modes at noon: DARKEN .4 (0.4) beats OVERRIDE .9',
      Math.abs(RG.computeRegionAdjustedDarkness(50, 50, 0, mixed) - 0.4) < 1e-9
    );
    ok(
      'mixed modes at night (base .9): OVERRIDE .9 beats DARKEN .4 (0.94)',
      Math.abs(RG.computeRegionAdjustedDarkness(50, 50, 0.9, mixed) - 0.9) < 1e-9
    );
  }
}
