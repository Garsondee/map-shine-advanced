/**
 * CRITTER SDF TOOLKIT — the handful of 2D signed-distance primitives every
 * procedural body is built from, and the one compositing rule that stacks them.
 *
 * ============================================================================
 * WHY A BODY IS A FUNCTION, NOT A TEXTURE
 * ============================================================================
 *
 * V2 drew a fly as one of two baked frames (`fly.webp`, `fly_landed.webp`) and
 * picked between them by state. A frame cannot flap, cannot step, and cannot be
 * in the middle of landing: the whole animation was "snap to the other picture".
 *
 * A SIGNED DISTANCE FIELD is a function `d(p)` that returns how far a point is
 * from a shape's edge — negative inside, positive outside, zero on the outline.
 * Drawing a shape is then a one-line question per pixel ("what is `d` here?"),
 * and — the point — `d` is just arithmetic on the shape's PARAMETERS. Move a
 * capsule's endpoint and the leg moves. Change an ellipse's axis and the abdomen
 * swells. Rotate the wing's frame and it flaps. Nothing is baked, so every pose
 * between "flying" and "landed" exists for free, at any zoom, with edges that are
 * anti-aliased by construction (see {@link coverage}).
 *
 * Each primitive here is cheap (a handful of ALU ops) and EXACT or a tight
 * approximation near the edge — the only place the distance matters, because
 * `coverage` only reads it within about one pixel of the outline.
 *
 * All functions take the live `TSL` namespace as their first argument (the
 * convention `curl-noise.js` and `fire-sprite.js` set: THREE is injected, never
 * imported at module scope, so this file stays Node-safe).
 *
 * @module effects/critters/critter-sdf
 */

/**
 * Pixel coverage of a shape from its distance at this pixel. `aa` is one pixel in
 * the same units as `d`; the result ramps 0→1 across a one-pixel band centred on
 * the outline — an analytic anti-aliasing that costs nothing and never needs MSAA.
 *
 * @param {*} TSL @param {*} d - signed distance node (<0 inside).
 * @param {*} aa - one pixel, same units. @returns {*} 0..1
 */
export function coverage(TSL, d, aa) {
  const { clamp, float } = TSL;
  return clamp(float(0.5).sub(d.div(aa)), 0, 1);
}

/**
 * Coverage of a THIN stroke (a leg, an antenna, a vein) given its distance to the
 * stroke's centreline.
 *
 * ⚠️ WIDTH FLOOR. Zoomed far out, a leg 0.014 body-lengths wide is a quarter of a
 * pixel and shimmers in and out as it moves. The stroke is widened to at least
 * `floorPx` pixels and its alpha scaled down by the same ratio, so the INK is
 * conserved: far away the leg is a faint, steady line instead of a flicker, and
 * up close (width > floor) this is exactly `coverage(dCenter - radius)`.
 *
 * @param {*} TSL @param {*} dCenter - distance to the centreline (≥ 0).
 * @param {number} radius - intended half-width, in body lengths.
 * @param {*} aa - one pixel. @param {number} [floorPx=0.7]
 * @returns {*} 0..1
 */
export function stroke(TSL, dCenter, radius, aa, floorPx = 0.7) {
  const { max, min, float } = TSL;
  const floorW = aa.mul(floorPx * 0.5);
  const r = max(float(radius), floorW);
  const ink = min(float(1), float(radius).div(floorW));
  return coverage(TSL, dCenter.sub(r), aa).mul(ink);
}

/**
 * Distance to a capsule (a line segment with round ends and radius `r`) — the
 * leg, the antenna, a maggot's body segment.
 * @param {*} TSL @param {*} p @param {*} a @param {*} b @param {*} r - nodes.
 */
export function sdCapsule(TSL, p, a, b, r) {
  const { dot, clamp, length, max } = TSL;
  const pa = p.sub(a);
  const ba = b.sub(a);
  const h = clamp(dot(pa, ba).div(max(dot(ba, ba), 1e-8)), 0, 1);
  return length(pa.sub(ba.mul(h))).sub(r);
}

/**
 * Distance to an axis-aligned ellipse centred on the origin (Inigo Quilez's
 * well-conditioned approximation: `k0(k0−1)/k1`). Exact on the outline, which is
 * all anti-aliasing reads; the `max` guards the division at the exact centre.
 * @param {*} TSL @param {*} p - centred position. @param {*} ab - vec2 semi-axes.
 */
export function sdEllipse(TSL, p, ab) {
  const { abs, length, max } = TSL;
  const q = abs(p);
  const k0 = length(q.div(ab));
  const k1 = length(q.div(ab.mul(ab)));
  return k0.mul(k0.sub(1)).div(max(k1, 1e-6));
}

/**
 * Polynomial smooth minimum: blends two distances into one organic shape
 * (thorax into abdomen, one maggot segment into the next) instead of a hard seam.
 * @param {*} TSL @param {*} a @param {*} b @param {*} k - blend width, same units.
 */
export function smoothMin(TSL, a, b, k) {
  const { max, min, float } = TSL;
  const h = max(k.sub(a.sub(b).abs()), 0).div(k);
  return min(a, b).sub(h.mul(h).mul(k).mul(float(0.25)));
}

/**
 * Rotate a 2D vector by `angle` radians (counter-clockwise for +angle).
 * @param {*} TSL @param {*} v @param {*} angle
 */
export function rotate2(TSL, v, angle) {
  const { sin, cos, vec2 } = TSL;
  const c = cos(angle);
  const s = sin(angle);
  return vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));
}

/**
 * Wrap an angle into [−π, π). The branch-free form `a − 2π·floor((a+π)/2π)`.
 * @param {*} TSL @param {*} a
 */
export function wrapAngle(TSL, a) {
  const { floor, float } = TSL;
  const twoPi = float(Math.PI * 2);
  return a.sub(twoPi.mul(floor(a.add(Math.PI).div(twoPi))));
}

/**
 * A PREMULTIPLIED-ALPHA LAYER STACK. A body is several translucent layers (legs
 * under the abdomen, wings over everything); the fragment shader composites them
 * back-to-front by hand because the GPU's own blending only ever sees the final
 * pixel. Premultiplied form makes "over" two multiply-adds:
 *
 *     C = Ctop + Cbottom·(1 − Atop)        A = Atop + Abottom·(1 − Atop)
 *
 * Usage: `let layer = emptyLayer(TSL); layer = over(TSL, wings, layer)` — the
 * first argument is the layer being laid ON TOP.
 *
 * @param {*} TSL @returns {{c:*, a:*}}
 */
export function emptyLayer(TSL) {
  const { vec3, float } = TSL;
  return { c: vec3(0, 0, 0), a: float(0) };
}

/**
 * One layer from a straight (non-premultiplied) colour and its coverage.
 * @param {*} TSL @param {*} rgb @param {*} alpha
 * @returns {{c:*, a:*}}
 */
export function layer(TSL, rgb, alpha) {
  return { c: rgb.mul(alpha), a: alpha };
}

/**
 * Lay `top` over `bottom` (both premultiplied, from {@link layer}/{@link over}).
 * @param {*} TSL @param {{c:*,a:*}} top @param {{c:*,a:*}} bottom
 * @returns {{c:*, a:*}}
 */
export function over(TSL, top, bottom) {
  const { float } = TSL;
  const keep = float(1).sub(top.a);
  return { c: top.c.add(bottom.c.mul(keep)), a: top.a.add(bottom.a.mul(keep)) };
}

/**
 * Back to a straight colour for a blend mode that multiplies by alpha itself
 * (three's NormalBlending). The `max` keeps a fully transparent pixel at black
 * rather than NaN.
 * @param {*} TSL @param {{c:*,a:*}} l @returns {{rgb:*, alpha:*}}
 */
export function unpremultiply(TSL, l) {
  const { max } = TSL;
  return { rgb: l.c.div(max(l.a, 1e-5)), alpha: l.a };
}
