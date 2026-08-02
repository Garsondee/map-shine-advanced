/**
 * SUN OCCLUSION — the shared sun-geometry utilities, asserted rather than
 * admired (docs/planning/Sun-Shadows.md).
 *
 * This file used to also pin the march's own maths (`marchVisibility`) and
 * the old averaged-mean smear (`marchVisibilitySmear`) — both retired
 * 2026-08-02 with `sun-occlusion.js`'s own march/smear code
 * (`docs/planning/Sun-Shadows-Layer-Smear.md` §8; the current model's own
 * math lives in `layer-smear.test.mjs`). What's left here is the handful of
 * utilities `sun-occlusion.js` still exports and other effects still import
 * directly.
 *
 * The direction tests are the load-bearing ones. Sky-reach shadows falling on
 * the WRONG SIDE of every building is a bug that looks plausible on screen
 * (there ARE shadows, they move with the sun, they are just mirrored), and this
 * project has shipped exactly that class twice for the UI-shadow and twice for
 * vegetation (feedback_y_flip_recurring_risk). All four quadrants, explicitly.
 */

import { marchDirectionToSun, sunNeedsRebake, angleDeltaDeg, edgeRamp01 } from '../sun-occlusion.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** @param {{ok:(name:string, cond:boolean)=>void}} t */
export function run(t) {
  // ── THE DIRECTION THE RAY WALKS ──────────────────────────────────────
  // Convention (light-visibility.js#shadowOffsetDirection): azimuth is compass
  // degrees clockwise from UP, in a +y-DOWN space. The light is IN that
  // direction; a back-trace walks TOWARD it, so it is the negation of the throw.
  {
    const n = marchDirectionToSun(0); // light due "north" (screen up)
    t.ok('sun at azimuth 0 → the back-trace walks UP (−y)', near(n.x, 0) && near(n.y, -1));

    const e = marchDirectionToSun(90); // light to the right
    t.ok('sun at azimuth 90 → the back-trace walks RIGHT (+x)', near(e.x, 1) && near(e.y, 0));

    const s = marchDirectionToSun(180); // Foundry/world noon = south
    t.ok('sun at azimuth 180 → the back-trace walks DOWN (+y)', near(s.x, 0) && near(s.y, 1));

    const w = marchDirectionToSun(270);
    t.ok('sun at azimuth 270 → the back-trace walks LEFT (−x)', near(w.x, -1) && near(w.y, 0));

    t.ok(
      'every quadrant returns a UNIT vector (a non-unit one silently rescales every step)',
      [0, 37, 90, 143, 180, 250, 270, 355].every((a) => {
        const d = marchDirectionToSun(a);
        return near(Math.hypot(d.x, d.y), 1, 1e-9);
      })
    );
  }

  // ── THE REBAKE QUANTISER ─────────────────────────────────────────────
  // Without this a running day clock re-bakes every frame and hands back the
  // exact cost model this design exists to avoid.
  {
    t.ok('nothing baked yet always bakes', sunNeedsRebake(null, { azimuthDeg: 0, elevationDeg: 0 }) === true);
    t.ok(
      'a sun that has barely moved does NOT rebake',
      sunNeedsRebake({ azimuthDeg: 100, elevationDeg: 40 }, { azimuthDeg: 100.2, elevationDeg: 40.1 }, 0.5) === false
    );
    t.ok(
      'a sun that has moved past the step DOES rebake',
      sunNeedsRebake({ azimuthDeg: 100, elevationDeg: 40 }, { azimuthDeg: 100.6, elevationDeg: 40 }, 0.5) === true
    );
    t.ok(
      'elevation alone can trigger it (a sun rising straight up still moves the shadows)',
      sunNeedsRebake({ azimuthDeg: 100, elevationDeg: 40 }, { azimuthDeg: 100, elevationDeg: 41 }, 0.5) === true
    );
    // Crossing north: 359° → 1° is 2° of movement, not 358°. Without the wrap
    // this fires a rebake storm every time the sun passes due north.
    t.ok(
      'crossing 0/360 is a SMALL move, not a full circle',
      sunNeedsRebake({ azimuthDeg: 359.9, elevationDeg: 40 }, { azimuthDeg: 0.1, elevationDeg: 40 }, 0.5) === false
    );
    t.ok('angleDeltaDeg wraps to (−180, 180]', near(angleDeltaDeg(1, 359), 2) && near(angleDeltaDeg(359, 1), -2));
  }

  // ── THE MAP-EDGE RAMP ────────────────────────────────────────────────
  {
    const rect = { x: 0, y: 0, width: 1000, height: 1000 };
    t.ok('dead centre is fully un-ramped', near(edgeRamp01({ x: 500, y: 500, rect, bandPx: 200 }), 1));
    t.ok('right on the boundary is fully ramped out', edgeRamp01({ x: 0, y: 500, rect, bandPx: 200 }) === 0);
    t.ok(
      'the ramp is monotonic across the band (a non-monotonic one shows as a band of its own)',
      [10, 50, 100, 150, 199].every((d, i, arr) =>
        i === 0
          ? true
          : edgeRamp01({ x: d, y: 500, rect, bandPx: 200 }) > edgeRamp01({ x: arr[i - 1], y: 500, rect, bandPx: 200 })
      )
    );
    t.ok(
      'a zero band disables it entirely (opt-out stays available)',
      edgeRamp01({ x: 0, y: 500, rect, bandPx: 0 }) === 1
    );
    t.ok(
      'every corner ramps, not just two of them',
      [
        [0, 0],
        [1000, 0],
        [0, 1000],
        [1000, 1000],
      ].every(([x, y]) => edgeRamp01({ x, y, rect, bandPx: 200 }) === 0)
    );
  }
}
