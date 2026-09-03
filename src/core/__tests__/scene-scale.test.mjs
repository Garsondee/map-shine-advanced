/**
 * scene-scale.test.mjs — pixels per real metre, from a scene's own grid.
 *
 * ⚠️ THE CENTRAL ASSERTION IS THAT TWO SCENES WITH IDENTICAL GRIDS BUT
 * DIFFERENT UNITS GIVE DIFFERENT ANSWERS. That is the whole bug
 * mythica-machina-press#485 could not pin down: `distancePixels` (pixels per
 * distance UNIT) was being used as pixels per METRE, which is only correct on
 * a scene authored in metres and is out by ~3.28× on the feet-authored scenes
 * that are nearly every real map.
 */
import {
  metresPerDistanceUnit,
  derivePixelsPerMetre,
  ASSUMED_METRES_PER_UNIT,
  ASSUMED_DISTANCE_PER_SQUARE,
} from '../scene-scale.js';

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;

  // ---- the unit table -------------------------------------------------------
  {
    ok('feet', approx(metresPerDistanceUnit('ft'), 0.3048));
    ok('metres', approx(metresPerDistanceUnit('m'), 1));
    ok('yards', approx(metresPerDistanceUnit('yd'), 0.9144));
    ok('miles', approx(metresPerDistanceUnit('mi'), 1609.344));
    ok('kilometres', approx(metresPerDistanceUnit('km'), 1000));
    // `grid.units` is FREE TEXT a GM types, so the spellings that actually turn
    // up have to match — a table that only knew the canonical token would send
    // most real scenes down the "unrecognised" path.
    ok('a trailing period is tolerated', approx(metresPerDistanceUnit('ft.'), 0.3048));
    ok('case is tolerated', approx(metresPerDistanceUnit('Feet'), 0.3048));
    ok('surrounding space is tolerated', approx(metresPerDistanceUnit('  m  '), 1));
    ok('the foot prime symbol is tolerated', approx(metresPerDistanceUnit("'"), 0.3048));
    ok('an unrecognised unit is null, never a guess', metresPerDistanceUnit('squares') === null);
    ok('a non-string is null', metresPerDistanceUnit(undefined) === null);
  }

  // ---- ⭐ the conversion, and the bug it ends -------------------------------
  {
    // The standard D&D scene: 100 px squares, 5 ft each.
    const feet = derivePixelsPerMetre({ gridSizePixels: 100, gridDistance: 5, gridUnits: 'ft' });
    ok('a feet scene resolves cleanly', feet.ok && feet.reason === null);
    // Foundry's own `distancePixels` — px per FOOT here, not per metre.
    ok('pixels per distance unit is grid.size / grid.distance', approx(feet.pixelsPerDistanceUnit, 20));
    ok('pixels per METRE divides that by metres-per-unit', approx(feet.pixelsPerMetre, 20 / 0.3048));

    // The SAME grid, authored in metres.
    const metres = derivePixelsPerMetre({ gridSizePixels: 100, gridDistance: 5, gridUnits: 'm' });
    ok('a metres scene has the same distancePixels', approx(metres.pixelsPerDistanceUnit, 20));
    ok('...but a different pixels-per-metre', approx(metres.pixelsPerMetre, 20));

    // ⭐ THE BUG, stated as an assertion: these two are NOT interchangeable.
    ok(
      '⭐ identical grids in different units give pixels-per-metre ~3.28x apart',
      approx(feet.pixelsPerMetre / metres.pixelsPerMetre, 1 / 0.3048, 1e-9)
    );
    ok(
      'using distancePixels as pixels-per-metre is wrong by exactly that factor',
      !approx(feet.pixelsPerDistanceUnit, feet.pixelsPerMetre, 1)
    );
  }

  // ---- honest fallbacks — a guess must SAY it is a guess ---------------------
  {
    const unknown = derivePixelsPerMetre({ gridSizePixels: 100, gridDistance: 5, gridUnits: 'squares' });
    ok('an unrecognised unit still returns a usable number', Number.isFinite(unknown.pixelsPerMetre));
    ok('...but reports ok:false', unknown.ok === false);
    ok('...and names the unit in the reason', unknown.reason.includes('squares'));
    ok('...having assumed feet', approx(unknown.metresPerUnit, ASSUMED_METRES_PER_UNIT));

    const noGrid = derivePixelsPerMetre();
    ok('no grid at all never throws', Number.isFinite(noGrid.pixelsPerMetre) && noGrid.pixelsPerMetre > 0);
    ok('no grid reports ok:false', noGrid.ok === false);

    const zeroDistance = derivePixelsPerMetre({ gridSizePixels: 100, gridDistance: 0, gridUnits: 'ft' });
    ok('a zero grid.distance does not divide by zero', Number.isFinite(zeroDistance.pixelsPerMetre));
    ok(
      'a zero grid.distance falls back to the standard square',
      approx(zeroDistance.pixelsPerDistanceUnit, 100 / ASSUMED_DISTANCE_PER_SQUARE)
    );
  }
}
