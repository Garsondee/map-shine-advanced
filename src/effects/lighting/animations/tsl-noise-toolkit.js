/**
 * TSL NOISE/COLOUR TOOLKIT — the animation port's equivalent of Foundry's own
 * GLSL toolkit (`client/canvas/rendering/mixins/base-shader-mixin.mjs`;
 * docs/reference/foundry-v14-light-animations-audit.md §2 quotes Foundry's
 * originals verbatim, cross-referenced against this module).
 *
 * MOST of Foundry's noise toolkit (SIMPLEX_3D/NOISE/FBM/FBMHQ/VORONOI) has a
 * ready-made TSL equivalent already vendored in this project's own Three
 * build (r185, `src/vendor/three/three.webgpu.js` — reachable off
 * `THREE.TSL.*`: `mx_noise_float` (Perlin), `mx_fractal_noise_float/vec2/
 * vec3/vec4`, `mx_worley_noise_float/vec2/vec3`, `mx_hsvtorgb`). NOTE the
 * plain-Perlin node is `mx_noise_float`, NOT `mx_perlin_noise_float` — the
 * latter exists inside the build but is NOT exported on the TSL namespace
 * (a live `perlinNoise is not a function` crash proved this, 2026-07-20;
 * `mx_noise_float` is `mx_perlin_noise_float(p)` at amplitude=1/pivot=0, the
 * exported wrapper). These are MaterialX nodes — well-tested, GPU-native. This
 * module wraps them under Foundry-toolkit-recognizable names rather than
 * hand-porting Foundry's own bespoke GLSL hash/simplex/voronoi from scratch.
 *
 * DOCUMENTED APPROXIMATION, not silent: `mx_perlin_noise_*` is Perlin noise,
 * not Foundry's exact simplex hash — a different (though same-family) noise
 * algorithm. This is a deliberate, low-risk substitution: Foundry's own
 * animations are per-light RANDOM-SEEDED (light-animation-clock.js's own
 * `seed` mechanism), so even two real Foundry torches never show
 * bit-identical noise fields — matching Foundry's exact PRNG would buy
 * nothing a human could see. The Type-A parity CONTRACT (docs/reference/
 * foundry-v14-lighting-audit.md §18) is about the core light math
 * (radius/ratio/falloff/colour), not which PRNG drives a flame's flicker.
 *
 * `hsb2rgb`/`pie`/`rotate2d` have no Three equivalent — hand-written here.
 *
 * Every export takes `TSL` (i.e. `THREE.TSL`) as its first argument rather
 * than closing over it — same reasoning as point-light-illumination.js's
 * `makeSdPolygonEdgeDistance`: no hidden dependency on a caller's own
 * destructure.
 *
 * @module effects/lighting/animations/tsl-noise-toolkit
 */

/**
 * Fractal Brownian Motion (Foundry's `FBM`/`FBMHQ` analog) — a scalar noise
 * field built from several summed octaves of Perlin noise.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {*} p - a vec2/vec3 TSL node, the sample position (spatial xy +
 *   time as a 3rd coordinate is the standard "animate 2D noise" trick).
 * @param {object} [opts]
 * @param {number} [opts.octaves=4]
 * @param {number} [opts.lacunarity=2]
 * @param {number} [opts.diminish=0.5]
 * @param {number} [opts.amplitude=1]
 * @returns {*} a float TSL node, roughly in [-amplitude, amplitude].
 */
export function fbmFloat(TSL, p, { octaves = 4, lacunarity = 2, diminish = 0.5, amplitude = 1 } = {}) {
  return TSL.mx_fractal_noise_float(p, octaves, lacunarity, diminish, amplitude);
}

/**
 * Vector FBM — three independently-phased noise channels from one sample
 * position. Useful where an animation wants noise that varies by channel,
 * not just a single grey field.
 * @returns {*} a vec3 TSL node.
 */
export function fbmVec3(TSL, p, { octaves = 4, lacunarity = 2, diminish = 0.5, amplitude = 1 } = {}) {
  return TSL.mx_fractal_noise_vec3(p, octaves, lacunarity, diminish, amplitude);
}

/**
 * Cellular/Worley noise (Foundry's `VORONOI` analog — the "energy field"
 * family; also stands in for hand-porting a literal N×N×N cell-search loop).
 * @param {number} [jitter=1] - cell-centre jitter, 0 = a perfect grid.
 * @returns {*} a float TSL node.
 */
export function voronoiFloat(TSL, p, jitter = 1) {
  return TSL.mx_worley_noise_float(p, jitter);
}

/** Vector Worley noise — three independently-offset cellular channels. @returns {*} a vec3 TSL node. */
export function voronoiVec3(TSL, p, jitter = 1) {
  return TSL.mx_worley_noise_vec3(p, jitter);
}

/**
 * Perlin/gradient noise (Foundry's `SIMPLEX_3D` analog — Perlin, not
 * simplex; see this module's header for why that substitution is safe here).
 * @returns {*} a float TSL node, roughly in [-1, 1].
 */
export function simplexFloat(TSL, p) {
  // mx_noise_float, NOT mx_perlin_noise_float: the vendored three build
  // exports the former (Perlin at amplitude=1/pivot=0) but keeps the latter
  // internal-only — see light-animation-clock.js#buildFlickerNode's own note
  // (a live crash proved the earlier "verified present" audit was wrong).
  return TSL.mx_noise_float(p);
}

/**
 * HSB/HSV to RGB, Foundry's `HSB2RGB` toolkit function. `THREE.TSL.
 * mx_hsvtorgb` takes one packed vec3 rather than three scalars, so this
 * wraps that packing rather than reimplementing the hue-sector formula.
 * @param {*} TSL
 * @param {*} h - hue, TSL float node, wraps at [0,1].
 * @param {*} s - saturation, TSL float node, [0,1].
 * @param {*} v - value/brightness, TSL float node, [0,1].
 * @returns {*} a vec3 TSL node, RGB in [0,1].
 */
export function hsb2rgb(TSL, h, s, v) {
  return TSL.mx_hsvtorgb(TSL.vec3(h, s, v));
}

/**
 * A soft angular wedge mask — Revolving/Siren's own beam shape. NOT a
 * captured verbatim port of Foundry's toolkit `PIE` function: this doc's
 * research pass captured the ANIMATION bodies' own call sites
 * (`pie(ncoord, angularIntensity, gradientFade, beamLength)`,
 * `revolving-light.mjs`/`siren-light.mjs`) but not `PIE`'s own GLSL text
 * from `base-shader-mixin.mjs`. Per the author's own direction (favour
 * idiomatic TSL / close visual parity over a slavish translation where the
 * exact source isn't in hand), this is a reconstruction matching the call
 * site's own parameter shape: a wedge of angular half-width
 * `angularWidth/2` centred on `p`'s own angle (`p` is already rotated by
 * the caller before this runs — see revolving.js/siren.js), softened at
 * its edges by `gradientFade`, scaled by `beamLength`. Revolving/Siren are
 * both cosmetic rotating-beam animations, not core to the common case —
 * worth a live A/B once seen, not worth blocking the rest of the set on.
 *
 * @param {*} TSL
 * @param {*} p - a vec2 TSL node, position relative to the light's centre,
 *   ALREADY rotated by the caller's own current heading.
 * @param {*} angularWidth - TSL float node, radians, the wedge's total angular width.
 * @param {*} gradientFade - TSL float node, radians, edge softness.
 * @param {*} beamLength - TSL float node, a [0,1]-ish intensity scale.
 * @returns {*} a float TSL node, ~`beamLength` inside the wedge, fading to 0 outside.
 */
export function pie(TSL, p, angularWidth, gradientFade, beamLength) {
  const { atan, abs, smoothstep, float } = TSL;
  const angle = atan(p.y, p.x);
  const halfWidth = angularWidth.mul(float(0.5));
  const mask = smoothstep(halfWidth.add(gradientFade), halfWidth.sub(gradientFade), abs(angle));
  return mask.mul(beamLength);
}

/**
 * Foundry's `ROTATION` toolkit function — a standard 2D rotation matrix
 * applied to a point. Hand-written (no bare 2D-rotate TSL equivalent).
 * @returns {*} a vec2 TSL node, `p` rotated by `angle` radians.
 */
export function rotate2d(TSL, p, angle) {
  const { vec2, cos, sin } = TSL;
  const c = cos(angle);
  const s = sin(angle);
  return vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
}

/**
 * The "hemispherize" fisheye remap — `(1 - sqrt(1-dist)) / dist` — recurs
 * verbatim (own constants aside) across `dome`/`hexa`/`grid` (docs/
 * reference/foundry-v14-light-animations-audit.md's own note: "a shared
 * 'make the radial falloff read as a dome/hemisphere' trick, worth its own
 * named TSL helper"). At `dist=0` this is a genuine 0/0 in Foundry's own
 * literal formula too (not guarded there either — matches this project's
 * own `energy.js` precedent for the identical situation).
 * @param {*} TSL @param {*} dist - normalized radial distance (this
 *   project's own `dist`, matching Foundry's).
 * @returns {*} a float TSL node.
 */
export function hspherize(TSL, dist) {
  const { float, sqrt } = TSL;
  return float(1)
    .sub(sqrt(float(1).sub(dist)))
    .div(dist);
}

/**
 * The "mirror a sawtooth into a symmetric triangle wave" trick —
 * `max(x, 1-x)` — used by every angular-beam animation in this set
 * (`emanation`, `sunburst`, and darkness's `hole`/Black Hole) to turn a
 * `fract()` ramp into a beam that reads the same whether you're
 * approaching or leaving its center.
 * @param {*} TSL @param {*} x - a float TSL node, typically a `fract()` result.
 * @returns {*} a float TSL node.
 */
export function mirrorTriangle(TSL, x) {
  const { float, max } = TSL;
  return max(x, float(1).sub(x));
}
