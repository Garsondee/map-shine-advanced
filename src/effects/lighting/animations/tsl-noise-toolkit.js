/**
 * TSL NOISE/COLOUR TOOLKIT — the animation port's equivalent of Foundry's own
 * GLSL toolkit (`client/canvas/rendering/mixins/base-shader-mixin.mjs`;
 * docs/reference/foundry-v14-light-animations-audit.md §2 quotes Foundry's
 * originals verbatim, cross-referenced against this module).
 *
 * MOST of Foundry's noise toolkit (SIMPLEX_3D/NOISE/FBM/FBMHQ/VORONOI) has a
 * ready-made TSL equivalent already vendored in this project's own Three
 * build (r185, `src/vendor/three/three.webgpu.js` — verified present:
 * `mx_perlin_noise_float/vec3`, `mx_fractal_noise_float/vec2/vec3/vec4`,
 * `mx_worley_noise_float/vec2/vec3`, `mx_hsvtorgb`, all reachable off
 * `THREE.TSL.*`). These are MaterialX nodes — well-tested, GPU-native. This
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
  return TSL.mx_perlin_noise_float(p);
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
 * Foundry's `PIE` toolkit function — a hard angular wedge mask: 1 inside a
 * `slice`-wide sector centred on `rotationAngle`, 0 outside. Used by the
 * beam-shaped animations (Revolving/Siren). Hand-written: `atan`-based angle
 * (TSL's two-argument `atan(y,x)` form, verified present in the vendored
 * build as an alias of `atan2`) + a `step`-bounded wedge, wrapped through
 * `mod` so the wedge doesn't tear at the +/-PI seam.
 *
 * @param {*} TSL
 * @param {*} p - a vec2 TSL node, position relative to the light's centre.
 * @param {*} rotationAngle - TSL float node, radians, the beam's current heading.
 * @param {*} slice - TSL float node, radians, the wedge's total angular width.
 * @returns {*} a float TSL node, 1 inside the wedge, 0 outside.
 */
export function pie(TSL, p, rotationAngle, slice) {
  const { atan, step, abs, mod, float } = TSL;
  const angle = atan(p.y, p.x).sub(rotationAngle);
  const wrapped = mod(angle.add(float(Math.PI)), float(Math.PI * 2)).sub(float(Math.PI));
  return step(abs(wrapped), slice.mul(float(0.5)));
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
