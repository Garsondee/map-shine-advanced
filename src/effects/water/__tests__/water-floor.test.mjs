/**
 * Node verification for effects/water/water-floor.js — THE CROSS-FLOOR RULE.
 * Covers the S3 acceptance scene's shape ("Plank-prison over river": the
 * viewed floor has no water, the floor below does) alongside the override
 * and no-water-anywhere cases.
 */
import { resolveWaterFloor } from '../water-floor.js';

export function run(t) {
  const { ok } = t;

  // The viewed floor has its own water — the common case, no borrowing.
  {
    const r = resolveWaterFloor({ viewedFloor: 0, floorsWithWater: [0, 2] });
    ok('own water: floorIndex is the viewed floor', r.floorIndex === 0);
    ok('own water: not borrowed', r.borrowed === false);
    ok('own water: reason mentions the viewed floor', typeof r.reason === 'string' && r.reason.length > 0);
  }

  // S3 shape: "Plank-prison over river" — viewed floor 1 (the plank deck) has
  // no water of its own; floor 0 (the river) does. Borrow it.
  {
    const r = resolveWaterFloor({ viewedFloor: 1, floorsWithWater: [0] });
    ok('S3 borrow: floorIndex is the lower floor', r.floorIndex === 0);
    ok('S3 borrow: borrowed is true', r.borrowed === true);
    ok('S3 borrow: reason names the borrowed floor', r.reason.includes('0'));
  }

  // Multiple lower floors with water — nearest one wins, never the furthest.
  {
    const r = resolveWaterFloor({ viewedFloor: 3, floorsWithWater: [0, 1, 2] });
    ok('nearest lower: picks floor 2, not 0 or 1', r.floorIndex === 2);
    ok('nearest lower: borrowed', r.borrowed === true);
  }

  // Water only on a HIGHER floor — never borrowed (you don't see through a
  // solid ceiling to water above you).
  {
    const r = resolveWaterFloor({ viewedFloor: 0, floorsWithWater: [2] });
    ok('higher-only water: never borrowed from above', r.floorIndex === null);
    ok('higher-only water: not marked borrowed', r.borrowed === false);
    ok('higher-only water: reason is honest about why', r.reason.includes('no lower floor'));
  }

  // Nothing in the scene has water at all.
  {
    const r = resolveWaterFloor({ viewedFloor: 0, floorsWithWater: [] });
    ok('no water anywhere: floorIndex is null, not a fabricated 0', r.floorIndex === null);
    ok('no water anywhere: not borrowed', r.borrowed === false);
  }

  // Per-level override pins a floor outright, regardless of floorsWithWater —
  // an input to the resolve, never validated against what actually has water
  // (the author/caller is responsible for pointing it somewhere sensible).
  {
    const r = resolveWaterFloor({ viewedFloor: 0, floorsWithWater: [0], perLevelOverride: 2 });
    ok('override: wins outright even though floor 0 has its own water', r.floorIndex === 2);
    ok('override: differs from viewed floor -> borrowed', r.borrowed === true);
  }

  // Override pointing at the SAME floor as viewed — not "borrowed" (nothing
  // is actually being borrowed from elsewhere).
  {
    const r = resolveWaterFloor({ viewedFloor: 0, floorsWithWater: [5], perLevelOverride: 0 });
    ok('override matching viewed floor: not borrowed', r.borrowed === false);
    ok('override matching viewed floor: floorIndex is 0', r.floorIndex === 0);
  }

  // perLevelOverride: null/undefined both mean "no override" (the default
  // parameter and an explicit null must behave identically).
  {
    const a = resolveWaterFloor({ viewedFloor: 0, floorsWithWater: [0] });
    const b = resolveWaterFloor({ viewedFloor: 0, floorsWithWater: [0], perLevelOverride: null });
    ok('no override === explicit null override', a.floorIndex === b.floorIndex && a.borrowed === b.borrowed);
  }
}
