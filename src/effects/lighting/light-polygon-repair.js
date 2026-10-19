/**
 * LIGHT POLYGON REPAIR — removes the hair-thin spikes of light Foundry's wall sweep leaves where a window or wall
 * meets a post.
 *
 * THE SYMPTOM (2026-10-19, author: "thin lines of light escaping from where wall points join"): long straight
 * lines about a pixel wide, a few hundred px long, running out from the corner of a post or wall end through the
 * shadow it should be casting.
 *
 * THE CAUSE (measured on the Mad Scientist's Compound, a fire at (6940, 6645)): a light's shape is a closed polygon
 * of corner points going round the light in angle order. Foundry's sweep also casts a ray a tiny angle past each wall
 * end to see what lies beyond. Where the wall end is the corner of a post beside a transparent window, that extra
 * point can land on the wrong side of the corner: the polygon steps FORWARD in angle to the far point, then BACK to the
 * corner. Walking back over ground it just covered folds the shape over itself, and the folded sliver (here 0.098
 * degrees wide, 807 px long) is drawn as light inside the post's shadow.
 *
 * THE FIX: a fold is a step against the polygon's winding direction. Where one is small (under
 * {@link MAX_FOLD_RAD}), the FARTHER of the two points is slid round onto the other point's ray, keeping its distance
 * from the light. The two now sit on one ray: a zero-width edge that covers nothing. The step is so small that the
 * shape's real outline moves by less than a pixel.
 *
 * Pure and allocation-free apart from the angle scratch; works in the polygon's own local coordinates.
 *
 * @module effects/lighting/light-polygon-repair
 */

/** The largest backward step, in radians, treated as a fold rather than real geometry (0.35 degrees). */
export const MAX_FOLD_RAD = 0.006;

const TWO_PI = Math.PI * 2;

/**
 * @param {number} d an angle difference
 * @returns {number} the same difference wrapped into [-pi, pi]
 */
function wrapAngle(d) {
  if (d > Math.PI) return d - TWO_PI;
  if (d < -Math.PI) return d + TWO_PI;
  return d;
}

/**
 * Repair folds in a closed polygon given as separate x / y arrays, centred on the light. Edits the arrays in place.
 * @param {Float64Array|number[]} lx
 * @param {Float64Array|number[]} ly
 * @param {number} n how many vertices
 * @returns {number} how many points were moved
 */
export function repairLightPolygonFolds(lx, ly, n) {
  if (n < 4) return 0;
  // Winding direction from the signed area (shoelace) about the light, which is the origin of these coordinates.
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    area2 += lx[i] * ly[j] - lx[j] * ly[i];
  }
  const dir = area2 >= 0 ? 1 : -1;
  let fixed = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ri = Math.hypot(lx[i], ly[i]);
    const rj = Math.hypot(lx[j], ly[j]);
    if (ri < 1e-9 || rj < 1e-9) continue;
    const d = wrapAngle(Math.atan2(ly[j], lx[j]) - Math.atan2(ly[i], lx[i])) * dir;
    // A step AGAINST the winding, and a small one: a fold.
    if (!(d < 0 && d > -MAX_FOLD_RAD)) continue;
    // Slide the farther point onto the nearer point's ray, keeping its own distance.
    if (ri >= rj) {
      const s = ri / rj;
      lx[i] = lx[j] * s;
      ly[i] = ly[j] * s;
    } else {
      const s = rj / ri;
      lx[j] = lx[i] * s;
      ly[j] = ly[i] * s;
    }
    fixed++;
  }
  return fixed;
}
