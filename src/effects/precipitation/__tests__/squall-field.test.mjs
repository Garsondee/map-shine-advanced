/**
 * THE SQUALL FIELD's compass and constants (docs/planning/Precipitation.md §3.4).
 *
 * ⚠️ THIS SUITE IS MOSTLY ONE ASSERTION WEARING SEVERAL HATS: that the 90°
 * rotation handed to `computeGustEnvelope` really does make its fronts travel
 * the way precipitation falls. That fact is invisible in code review, obvious
 * on a map, and this project has already paid for a precipitation compass error
 * TWICE — once a missing rotation, once a `.negate()` that fixed 180° of a 90°
 * problem. The field itself is browser-only TSL, so Node can only reach the
 * derivation; the derivation is where the bug would be.
 */
import {
  gustDirectionForPrecip,
  windFieldFlowVector,
  CURTAIN_GUST_SCALE,
  CELL_FREQ,
  CELL_ANISOTROPY,
  CELL_DRIFT_PX_PER_SEC,
  BAND_DEPTH,
} from '../squall-field.js';
import { windTowardVector } from '../precip-species.js';

export function run(t) {
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  // ---- ⭐ THE 90° RECONCILIATION ---------------------------------------------
  {
    // The claim, stated as an equation the test can actually check: the wind
    // field's flow vector at the ROTATED angle equals precipitation's own drive
    // vector at the original angle. If that holds at every cardinal and a few
    // odd angles, the squall bands travel with the rain rather than across it.
    const angles = [0, 37, 90, 143, 180, 211, 270, 359];
    t.ok(
      '⭐ the rotated gust flow IS precipitation’s drive direction, at every angle',
      angles.every((d) => {
        const flow = windFieldFlowVector(gustDirectionForPrecip(d));
        const drive = windTowardVector(d);
        return near(flow.x, drive.x) && near(flow.y, drive.y);
      })
    );
    // ⚠️ AND THE UNROTATED ONE IS NOT — the negative control. Without it this
    // suite would pass just as happily if both conventions had silently become
    // the same, which is the state that makes the rotation look unnecessary and
    // invites a future reader to delete it.
    t.ok(
      'the UNROTATED gust flow is genuinely different (the rotation is not a no-op)',
      angles.every((d) => {
        const flow = windFieldFlowVector(d);
        const drive = windTowardVector(d);
        return !(near(flow.x, drive.x) && near(flow.y, drive.y));
      })
    );
    // Named directions, so a reader can check the claim by thinking rather than
    // by trusting the algebra. Y-DOWN world: +X EAST, +Y SOUTH.
    const dir = (v) => (Math.abs(v.x) > Math.abs(v.y) ? (v.x > 0 ? 'EAST' : 'WEST') : v.y > 0 ? 'SOUTH' : 'NORTH');
    t.ok('a north wind drives the bands SOUTH', dir(windFieldFlowVector(gustDirectionForPrecip(0))) === 'SOUTH');
    t.ok('an east wind drives the bands WEST', dir(windFieldFlowVector(gustDirectionForPrecip(90))) === 'WEST');
    t.ok('a south wind drives the bands NORTH', dir(windFieldFlowVector(gustDirectionForPrecip(180))) === 'NORTH');
    t.ok('a west wind drives the bands EAST', dir(windFieldFlowVector(gustDirectionForPrecip(270))) === 'EAST');

    t.ok('the rotation is exactly −90°', near(gustDirectionForPrecip(210), 120));
    t.ok('a non-finite angle yields a finite one', Number.isFinite(gustDirectionForPrecip(NaN)));
  }

  // ---- the constants are the shape §3.4 asks for ------------------------------
  {
    // "at a larger wavelength" — the curtain must sample the gust envelope
    // COARSER than the vegetation does, or the bands are grass-sized.
    t.ok('the curtain samples gusts coarser than 1:1', CURTAIN_GUST_SCALE > 0 && CURTAIN_GUST_SCALE < 1);
    // "anisotropically stretched along the wind" — weather arrives in LINES.
    t.ok('the cell is stretched along the wind, not isotropic', CELL_ANISOTROPY > 1);
    t.ok('the cell is a slow, large-scale noise', CELL_FREQ > 0 && CELL_FREQ < 0.01);
    t.ok('the cell drifts, and slowly', CELL_DRIFT_PX_PER_SEC > 0 && CELL_DRIFT_PX_PER_SEC < 200);
    // ⚠️ SHORT OF 1 ON PURPOSE. A field that reaches zero produces gaps of
    // literally no rain, and a downpour with holes in it reads as a broken
    // effect rather than as a squall.
    t.ok('bands cut deep but never to zero', BAND_DEPTH > 0 && BAND_DEPTH < 1);
  }

  // ---- the CPU twin of the wind field's convention ----------------------------
  {
    t.ok(
      'the flow twin is a unit vector at every angle',
      [0, 45, 90, 200, 355].every((d) => {
        const v = windFieldFlowVector(d);
        return near(Math.hypot(v.x, v.y), 1);
      })
    );
    // The twin must match `wind-field.js`'s own `vec2(cos, sin).negate()`.
    // Stated as a literal so a change to that file's convention breaks HERE,
    // loudly, rather than silently rotating every squall band on every map.
    t.ok('θ=0 flows WEST, matching wind-field.js’s own negate', near(windFieldFlowVector(0).x, -1));
    t.ok('θ=90 flows NORTH by that convention', near(windFieldFlowVector(90).y, -1));
  }
}
