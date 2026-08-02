/**
 * SUN OCCLUSION — shared sun-geometry utilities (docs/planning/Sun-Shadows.md).
 *
 * ============================================================================
 * WHAT THIS FILE IS NOW (2026-08-02)
 * ============================================================================
 *
 * This file used to be the pure core of the sun-shadow bake itself — first a
 * column march, then an averaged-mean smear. Both are gone
 * (`docs/planning/Sun-Shadows-Layer-Smear.md` §8 has the retirement notes);
 * the model now lives in `layer-smear.js` + `layer-smear-render.js`.
 *
 * What's left is the handful of SUN-GEOMETRY and REBAKE-TIMING utilities that
 * turned out to be genuinely shared, not march-specific, and that other
 * effects import directly rather than through the bake:
 *
 *   `marchDirectionToSun` — the one azimuth→XY convention in this codebase.
 *      Used by `layer-smear.js` (the model's own back-trace direction) AND by
 *      `sky-access.js` (specular/highlight direction — nothing to do with
 *      shadows at all).
 *   `sunNeedsRebake` / `angleDeltaDeg` — the quantised-rebake decision every
 *      baked-field effect needs, so a continuously animated day clock re-bakes
 *      a few times a minute instead of every frame.
 *   `GATE_SHARPEN_LOW/HIGH` / `PENUMBRA_PER_PX` — look constants
 *      `layer-smear-render.js` still reads directly, kept here rather than
 *      duplicated because they were never conceptually march-specific either.
 *   `edgeRamp01` — the map-edge fade, shared with `vegetation-shadow-subsystem.js`.
 *
 * The name stays `sun-occlusion.js` rather than a rename: `git blame` and this
 * project's own memory records refer to it, and the module's actual exports
 * are still exactly "things about where the sun is and how a caster relates
 * to it" — a narrower file than it was, not a differently-purposed one.
 *
 * @module effects/lighting/sun-occlusion
 */

import { shadowOffsetDirection } from './light-visibility.js';

/**
 * How wide the penumbra grows per unit of distance travelled from a caster.
 * The sun's angular diameter is about half a degree, which gives a real
 * penumbra of roughly `0.009 × distance`; this is deliberately ~4× that,
 * because a battlemap's shadows read better slightly softer than physics and
 * because a caster field's own texels are coarse enough that a physically
 * tight penumbra would show the grid. Tuned by eye, stated as such.
 */
export const PENUMBRA_PER_PX = 0.035;

/**
 * Convert a compass azimuth into the world-space unit vector pointing TOWARD
 * the light — the direction a shadow-casting back-trace walks.
 *
 * ⚠️ THE Y-FLIP CLASS (memory: feedback_y_flip_recurring_risk — it bit the
 * UI-shadow twice and vegetation twice). `shadowOffsetDirection` returns the
 * direction a shadow is THROWN, in a +y-DOWN space. Foundry's canvas is also
 * +y down, so the vector transfers with no flip; and a back-trace walks the
 * OPPOSITE way (from the lit pixel back toward the sun to find what blocks
 * it), hence the negation. Both facts are asserted in this module's test on
 * all four quadrants rather than trusted to this comment.
 *
 * @param {number} azimuthDeg - the light's compass azimuth (cw from world-up).
 * @returns {{x: number, y: number}} unit vector toward the light, +y down.
 */
export function marchDirectionToSun(azimuthDeg) {
  const away = shadowOffsetDirection(azimuthDeg);
  return { x: -away.x, y: -away.y };
}

/**
 * Should a baked shadow field be re-baked for this sun?
 *
 * A continuously-animated sun (the day clock) would otherwise turn "rebake when
 * the sun changes" into "rebake every frame", which is the cost model this whole
 * design exists to avoid. Quantising the sun means the bake happens a few times
 * a minute instead of sixty times a second, and the visual difference over half
 * a degree of azimuth is nil.
 *
 * Returns true when nothing has been baked yet (`last` null), so the first frame
 * always produces a field.
 *
 * @param {{azimuthDeg: number, elevationDeg: number}|null} last - the sun the current bake used.
 * @param {{azimuthDeg: number, elevationDeg: number}} next - this frame's sun.
 * @param {number} [quantizeDeg=0.5]
 * @returns {boolean}
 */
export function sunNeedsRebake(last, next, quantizeDeg = 0.5) {
  if (!last) return true;
  const q = Number.isFinite(quantizeDeg) && quantizeDeg > 0 ? quantizeDeg : 0.5;
  const dAz = Math.abs(angleDeltaDeg(next?.azimuthDeg ?? 0, last.azimuthDeg ?? 0));
  const dEl = Math.abs((next?.elevationDeg ?? 0) - (last.elevationDeg ?? 0));
  return dAz >= q || dEl >= q;
}

/**
 * Shortest signed angular difference in degrees, wrapped to (-180, 180] — so
 * 359° and 1° are 2° apart, not 358°. Without this a sun crossing north would
 * trigger a rebake storm.
 * @param {number} a @param {number} b @returns {number}
 */
export function angleDeltaDeg(a, b) {
  const d = (((((Number(a) || 0) - (Number(b) || 0)) % 360) + 540) % 360) - 180;
  return d;
}

/**
 * THE RECEIVER-GATE SHARPENING CURVE (author, live report, on the march model:
 * *"Building shadows have a brighter area next to the actual building… the
 * shadow should be strongest next to the building and brighter as you move
 * away."*).
 *
 * ROOT CAUSE, confirmed by reading the whole chain rather than guessed: the
 * receiver gate is the `_Outdoors` mask sampled at the coarse caster-field
 * resolution — meaning a wall's true, crisp boundary is smeared across roughly
 * one grid texel (tens of world px) by the grid's own box-filtered downsample
 * plus its LINEAR texture filter. Multiplying the shadow by that same blurred
 * value weakens it exactly where contact-hardening says it should be
 * strongest. A bright halo hugging every building is the visible result.
 *
 * The fix does not touch the mask (shared with the sky light's own doorway-
 * softness use, which legitimately wants that blur — Sky.md). It sharpens
 * ONLY how a sun-shadow reads the SAME value: a `smoothstep` that treats
 * anything past {@link GATE_SHARPEN_HIGH} as fully outdoor (gate 1) and
 * anything below {@link GATE_SHARPEN_LOW} as still-indoors (gate 0, and
 * correctly so — nothing needs a cast shadow where the sun never reaches
 * anyway), collapsing the ambiguous middle band the coarse grid invents. This
 * is a contrast stretch on data that already exists, not a new mask, and not a
 * second, disagreeing copy of the shared gate (`buildOutdoorsGate`'s own
 * doctrine) — every OTHER consumer of `_Outdoors` is untouched.
 *
 * Applied in `layer-smear-render.js`, which is the ONE place a sun-shadow
 * reads the gate — point lights consume the baked FIELD, not the gate, so
 * there is no second reader to disagree with.
 */
export const GATE_SHARPEN_LOW = 0.12;
export const GATE_SHARPEN_HIGH = 0.35;

/**
 * THE MAP-EDGE RAMP (author, 2026-07-24: *"we need to address how these shadows
 * interact with the edge of the map to avoid producing a gap in the shadow as it
 * moves around the edge of the scene. I don't mind if we have a gradient at the
 * edge of the scene which prevents the shadow being offset"*).
 *
 * The gap is real and unfixable at its source: a caster standing just outside
 * the scene rect does not exist in any of our data, so the shadow it should
 * throw INTO the map cannot be computed. What we can control is what the
 * boundary looks like — and a shadow that simply stops at a straight line reads
 * as a bug, while one that fades out over a band reads as haze.
 *
 * Returns 1 well inside the map, easing to 0 at the border. Applied to the
 * shadow's STRENGTH (and, for vegetation, to the OFFSET as the author suggested,
 * which parks a shadow under its own plant rather than letting it slide off the
 * edge).
 *
 * @param {object} args
 * @param {number} args.x - world position.
 * @param {number} args.y
 * @param {{x: number, y: number, width: number, height: number}} args.rect - the scene rect.
 * @param {number} [args.bandPx=256] - how wide the ramp is.
 * @returns {number} 0..1.
 */
export function edgeRamp01({ x, y, rect, bandPx = 256 }) {
  if (!rect) return 1;
  const band = Number.isFinite(bandPx) && bandPx > 0 ? bandPx : 0;
  if (band === 0) return 1;
  const dx = Math.min(x - rect.x, rect.x + rect.width - x);
  const dy = Math.min(y - rect.y, rect.y + rect.height - y);
  const d = Math.min(dx, dy);
  if (d <= 0) return 0;
  if (d >= band) return 1;
  const t = d / band;
  return t * t * (3 - 2 * t);
}
