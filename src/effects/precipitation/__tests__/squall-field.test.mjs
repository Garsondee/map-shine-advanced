/**
 * THE SQUALL FIELD's compass and constants (docs/planning/Precipitation.md §3.4).
 *
 * ⚠️ THIS SUITE IS MOSTLY ONE ASSERTION WEARING SEVERAL HATS: that the gust
 * fronts handed to `computeGustEnvelope` really do travel the way precipitation
 * falls. That fact is invisible in code review, obvious on a map, and this
 * project has already paid for a precipitation compass error TWICE — once a
 * missing rotation, once a `.negate()` that fixed 180° of a 90° problem. The
 * field itself is browser-only TSL, so Node can only reach the derivation; the
 * derivation is where the bug would be.
 *
 * ⚠️ THE 90° ROTATION THIS SUITE USED TO PIN IS GONE (2026-09-04,
 * mythica-machina-press#497 Stage 0). It existed because `world/wind-field.js`
 * and `effects/precipitation` held two different readings of `directionDeg`;
 * both now resolve through the ONE shared `world/wind-bake.js#windFlowVector`,
 * so there is no gap left to bridge and `gustDirectionForPrecip` /
 * `windFieldFlowVector` are deleted. What this suite pins now is the stronger
 * claim: that there is exactly one implementation, and everything reads it.
 */
import { CURTAIN_GUST_SCALE, CELL_FREQ, CELL_ANISOTROPY, CELL_DRIFT_PX_PER_SEC, BAND_DEPTH } from '../squall-field.js';
import { windTowardVector } from '../precip-species.js';
import { windFlowVector } from '../../../world/index.js';

export function run(t) {
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  // ---- ⭐ ONE CONVENTION, NO RECONCILIATION ---------------------------------
  {
    // The claim, stated as an equation the test can actually check: the angle
    // the gust envelope travels along and the direction precipitation drives
    // are now the SAME vector, with nothing rotated in between. If that holds
    // at every cardinal and a few odd angles, the squall bands travel with the
    // rain rather than across it.
    const angles = [0, 37, 90, 143, 180, 211, 270, 359];
    t.ok(
      '⭐ precipitation’s drive direction IS the shared wind flow vector, at every angle',
      angles.every((d) => {
        const flow = windFlowVector(d);
        const drive = windTowardVector(d);
        return near(flow.x, drive.x) && near(flow.y, drive.y);
      })
    );
    // Named directions, so a reader can check the claim by thinking rather than
    // by trusting the algebra. Y-DOWN world: +X EAST, +Y SOUTH. `directionDeg`
    // is a compass bearing naming where the wind blows TOWARD, so a bearing of
    // 0 (north) drives the bands north — not south, which is what the old
    // meteorological reading produced.
    const dir = (v) => (Math.abs(v.x) > Math.abs(v.y) ? (v.x > 0 ? 'EAST' : 'WEST') : v.y > 0 ? 'SOUTH' : 'NORTH');
    t.ok('a bearing of north drives the bands NORTH', dir(windFlowVector(0)) === 'NORTH');
    t.ok('a bearing of east drives the bands EAST', dir(windFlowVector(90)) === 'EAST');
    t.ok('a bearing of south drives the bands SOUTH', dir(windFlowVector(180)) === 'SOUTH');
    t.ok('a bearing of west drives the bands WEST', dir(windFlowVector(270)) === 'WEST');
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

  // ---- the shared convention itself -------------------------------------------
  {
    t.ok(
      'the flow vector is a unit vector at every angle',
      [0, 45, 90, 200, 355].every((d) => {
        const v = windFlowVector(d);
        return near(Math.hypot(v.x, v.y), 1);
      })
    );
    t.ok('a non-finite angle still yields a finite vector', Number.isFinite(windFlowVector(NaN).x));
  }
}
