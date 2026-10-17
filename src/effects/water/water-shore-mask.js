/**
 * SHORE FOAM FROM THE MASK, AND ONE FOAM TEXTURE FOR EVERY SOURCE (2026-10-17).
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Author, live, Tower Bridge east bank: *"the white is the foam at a shoreline.
 * It's very ugly... a hard lumpy pixelated grey white edge"* — and, after a
 * first fix that only blurred the sim pack's read: *"still obviously
 * texels/pixelated with holes in it... look at the rock further to the south
 * and you'll see the horribly distorted way that the foam can end up looking...
 * use the _Water map to produce this foam but not use a system which creates
 * ugly blocky grainy pixelated foam."*
 *
 * The foam the author saw came from the sim pack (`water-sim.js`): a ~7 world
 * px grid whose foam is emitted on the last open texel and hard-zeroed in every
 * solid one, so its land edge IS the grid's staircase — and whose SHAPE was
 * then drawn by thresholding that coarse field, so every blob kept the grid's
 * lumps. Blurring the read rounds the staircase off but cannot add detail the
 * grid never held.
 *
 * So the job is split in two, and neither half ever shows a texel:
 *
 *   DENSITY — WHERE foam is, as a smooth 0..1 field. Two sources:
 *     · the SHORE, from the full-resolution mask (`buildMaskShoreDensity`): a
 *       Gaussian-blurred read (25 taps, σ = soft px) gives a smooth value AND
 *       its analytic gradient from the same taps, and `(m − level) / |∇m|` is a
 *       sub-pixel signed distance, in world px, to the waterline `m = level`.
 *       A hard-painted edge only has gradient within ~2σ of itself, so past
 *       that the body SDF takes over (it is exact there, and its own staircase
 *       sits inside the 2σ floor). A soft painted ramp keeps its gradient for
 *       hundreds of px and never needs it.
 *     · the SIM pack's wakes, soft-gathered (`water-render.js`), faded out near
 *       the shore so the two never stack.
 *   TEXTURE — WHAT foam looks like (`buildFoamTexture`), procedural in world
 *     px: a domain-warped fractal noise thresholded by density (dense → solid,
 *     thin → separate clumps), with lace holes punched by a warped Worley net,
 *     every edge antialiased by `fwidth`. Density only moves the threshold, so
 *     a coarse density field shows up as where the clumps are, never as the
 *     clumps' own outline.
 *
 * THREE is INJECTED, never imported. Uniforms live HERE (the builder-per-concern
 * split `effects/uniform-budget` asks for), packed two to a vec4/vec2.
 *
 * @module effects/water/water-shore-mask
 */

/** Overall strength of the shoreline foam, 0 = off. */
export const WATER_SHORE_FOAM_AMOUNT = 1;
/** The mask value the foam line sits on — the "waterline" of a painted ramp. On
 * a hard-painted edge every level is the same place, so this only matters for
 * soft ramps: lower pushes the line toward the dry end. */
export const WATER_SHORE_FOAM_LEVEL = 0.2;
/** How far the foam reaches into the water, world px (1/e distance of its density). */
export const WATER_SHORE_FOAM_WIDTH_PX = 30;
/** How far the line travels up and back as the swash comes and goes, world px. */
export const WATER_SHORE_FOAM_SWASH_PX = 8;
/** Gaussian σ of the mask read, world px. Melts 8-bit terraces and the painted
 * edge's own pixels into a smooth contour; rounds corners off by about this much. */
export const WATER_SHORE_FOAM_SOFT_PX = 4;
/** The foam texture's clump size, world px (the lace is about a third of it). */
export const WATER_FOAM_TEXTURE_PX = 26;

/** How uneven the shoreline foam is, 0..1: 0 is an even band everywhere; 1 lets
 * every stretch of shore have its own reach (~0.2× to ~1.9×), its own coverage
 * (real gaps open and close) and its own line weight, all drifting over tens of
 * seconds. Author: *"Make sure that the foam isn't an even band everywhere, it
 * should be highly variable in width and coverage and that should evolve over time
 * too."* */
export const WATER_SHORE_FOAM_VARIATION = 0.85;
/** Break spray strength, 0 = off — see `buildBreakSpecks`. */
export const WATER_BREAK_SPRAY = 1;

/** The solid band right behind the leading edge, world px (varies ±50% along the shore). */
const LINE_PX = 4;
/** Along-shore scale of the width / coverage / line-weight variation, world px. */
const VARIATION_SCALE_PX = 240;
/** One full swash cycle, seconds. */
const SWASH_PERIOD_SEC = 7;
/** Along-shore scale of the swash phase and density patches, world px. */
const BREAKUP_SCALE_PX = 190;
/** Along-shore wobble of the line: scale and amplitude, world px. */
const WOBBLE_SCALE_PX = 55;
const WOBBLE_PX = 4;
/** Where |∇m| is below this (per world px) the mask has no gradient to measure. */
const MIN_GRADIENT = 1e-4;
/** Clamp on the distance estimate, world px. */
const MAX_DIST_PX = 4096;
/** The binomial kernel — [1 4 6 4 1]/16 has variance 1, so σ = tap spacing. */
const KERNEL = [1, 4, 6, 4, 1];

/**
 * CPU twin of the distance estimate, so its edge cases are Node-assertable.
 * @param {number} m - blurred mask value 0..1
 * @param {number} gradLen - |∇m| per world px
 * @param {number} level - the waterline level
 * @param {number|null} [farDistPx] - the SDF's distance into the water (null: none)
 * @param {number} [sigmaPx]
 * @returns {number} signed world px, positive into the water
 */
export function maskShoreDistance(m, gradLen, level, farDistPx = null, sigmaPx = WATER_SHORE_FOAM_SOFT_PX) {
  const raw = (m - level) / Math.max(gradLen, MIN_GRADIENT);
  const dMask = Math.min(MAX_DIST_PX, Math.max(-MAX_DIST_PX, raw));
  if (farDistPx === null) return dMask;
  return Math.min(dMask, Math.max(farDistPx + 0.9 * sigmaPx, 2 * sigmaPx));
}

/**
 * The shoreline's foam DENSITY (0..1) from the mask.
 * @param {*} THREE
 * @param {object} args
 * @param {*} args.maskTexNode - the surface's own mask `texture()` node. Every tap
 *   is a `.sample()` clone of it, so re-pointing it re-points them all.
 * @param {(offsetWorld: *) => *} args.maskUvAt - vec2 world-px offset → clamped mask UV.
 * @param {*} args.worldXY - vec2 world position.
 * @param {*|null} [args.shoreDist] - the body SDF's distance into the water (≥ 0).
 * @param {*} args.tSec - seconds.
 */
export function buildMaskShoreDensity(THREE, { maskTexNode, maskUvAt, worldXY, shoreDist = null, tSec }) {
  const {
    uniform,
    vec2,
    vec3,
    vec4,
    float,
    exp,
    sin,
    max,
    min,
    clamp,
    smoothstep,
    fwidth,
    length,
    mix,
    mx_fractal_noise_float,
  } = THREE.TSL;

  const uA = uniform(
    vec4(WATER_SHORE_FOAM_AMOUNT, WATER_SHORE_FOAM_LEVEL, WATER_SHORE_FOAM_WIDTH_PX, WATER_SHORE_FOAM_SWASH_PX)
  );
  const uB = uniform(
    vec4(WATER_SHORE_FOAM_SOFT_PX, WATER_FOAM_TEXTURE_PX, WATER_SHORE_FOAM_VARIATION, WATER_BREAK_SPRAY)
  );
  const amount = uA.x;
  const level = uA.y;
  const widthPx = max(uA.z, float(1));
  const swashPx = uA.w;
  const sigma = max(uB.x, float(0.5));
  const variation = clamp(uB.z, float(0), float(1));

  // ── WHERE: blurred value + analytic gradient, one set of taps ───────────
  let m = null;
  let gx = null;
  let gy = null;
  for (let iy = -2; iy <= 2; iy++) {
    for (let ix = -2; ix <= 2; ix++) {
      const w = (KERNEL[ix + 2] * KERNEL[iy + 2]) / 256;
      const tap = maskTexNode.sample(maskUvAt(vec2(float(ix), float(iy)).mul(sigma))).r;
      m = m ? m.add(tap.mul(float(w))) : tap.mul(float(w));
      if (ix !== 0) gx = gx ? gx.add(tap.mul(float(w * ix))) : tap.mul(float(w * ix));
      if (iy !== 0) gy = gy ? gy.add(tap.mul(float(w * iy))) : tap.mul(float(w * iy));
    }
  }
  // ∇(G∗m) = Σ wᵢ mᵢ oᵢ / σ², with oᵢ = (ix, iy)·σ — so one σ cancels.
  const gradLen = length(vec2(gx, gy)).div(sigma);
  const dMask = clamp(m.sub(level).div(max(gradLen, float(MIN_GRADIENT))), float(-MAX_DIST_PX), float(MAX_DIST_PX));
  const dist = shoreDist ? min(dMask, max(shoreDist.add(sigma.mul(float(0.9))), sigma.mul(float(2)))) : dMask;

  // ── MOTION: swash, wobble ───────────────────────────────────────────────
  const breakupUv = worldXY.div(float(BREAKUP_SCALE_PX));
  const phaseNoise = mx_fractal_noise_float(vec3(breakupUv.x, breakupUv.y, tSec.mul(float(0.02))), 2, 2.0, 0.5);
  const swash = sin(tSec.mul(float((2 * Math.PI) / SWASH_PERIOD_SEC)).add(phaseNoise.mul(float(9))))
    .mul(float(0.5))
    .mul(swashPx);
  const wobbleUv = worldXY.div(float(WOBBLE_SCALE_PX));
  const wobbleNoise = mx_fractal_noise_float(vec3(wobbleUv.x, wobbleUv.y, tSec.mul(float(0.06))), 2, 2.0, 0.5);
  // Distance from the foam's LEADING EDGE, world px, positive into the water.
  const x = dist.sub(swash).sub(wobbleNoise.mul(float(WOBBLE_PX * 2.5)));

  // ── VARIATION: every stretch of shore its own reach, coverage and line weight ──
  // Three independent world-anchored noises at a few hundred px, each drifting on
  // its own clock, so the band changes shape over tens of seconds instead of being
  // an offset copy of the waterline. `variation` = 0 collapses all three to 1.
  const varUv = worldXY.div(float(VARIATION_SCALE_PX));
  const widthNoise = mx_fractal_noise_float(vec3(varUv.x, varUv.y, tSec.mul(float(0.035))), 2, 2.0, 0.5);
  const coverNoise = mx_fractal_noise_float(
    vec3(varUv.x.add(float(41.7)), varUv.y.sub(float(13.1)), tSec.mul(float(0.045))),
    2,
    2.0,
    0.5
  );
  const weightNoise = mx_fractal_noise_float(
    vec3(varUv.x.mul(float(2.3)).add(float(7.1)), varUv.y.mul(float(2.3)), tSec.mul(float(0.08))),
    2,
    2.0,
    0.5
  );
  const widthMul = mix(
    float(1),
    mix(float(0.2), float(1.9), smoothstep(float(-0.32), float(0.32), widthNoise)),
    variation
  );
  const coverage = mix(float(1), smoothstep(float(-0.18), float(0.28), coverNoise), variation);
  // The line itself only breaks in the deepest gaps; elsewhere it thins and thickens.
  const lineGate = mix(float(1), smoothstep(float(-0.45), float(-0.15), coverNoise), variation);
  const weightMul = mix(
    float(1),
    mix(float(0.25), float(2.2), smoothstep(float(-0.3), float(0.3), weightNoise)),
    variation
  );

  // ── DENSITY PROFILE: a solid line, then a decaying tail ─────────────────
  const aa = max(fwidth(x), float(1.5));
  const lead = smoothstep(aa.negate(), aa, x);
  const xp = max(x, float(0));
  const lineW = float(LINE_PX)
    .mul(float(1).add(wobbleNoise.mul(float(1.8))))
    .mul(weightMul);
  const line = float(1)
    .sub(smoothstep(lineW.sub(aa), lineW.add(aa), xp))
    .mul(lineGate);
  const tail = exp(xp.div(widthPx.mul(widthMul)).negate()).mul(float(0.85));
  const patchNoise = mx_fractal_noise_float(
    vec3(breakupUv.x.add(float(17.3)), breakupUv.y, tSec.mul(float(0.015))),
    2,
    2.0,
    0.5
  );
  const patches = float(0.55).add(smoothstep(float(-0.25), float(0.35), patchNoise).mul(float(0.45)));
  const density = clamp(lead.mul(max(line, tail.mul(patches).mul(coverage))).mul(amount), float(0), float(1));

  // ── HARDNESS: is this water deep RIGHT AGAINST its shore? ───────────────
  // A hard-painted edge reaches full depth within ~2σ of the waterline; a soft ramp
  // is still shallow tens of px in. So "the blurred mask is already high, and the
  // waterline is close" picks out exactly the shores water can break against.
  const hardness = smoothstep(float(0.55), float(0.95), m)
    .mul(float(1).sub(smoothstep(float(10), float(40), dist)))
    .mul(smoothstep(float(-2), float(2), dist));

  return {
    density,
    dist,
    hardness,
    uTexturePx: uB.y,
    uSpray: uB.w,
    setters: {
      setShoreFoam(v) {
        uA.value.x = v;
      },
      setShoreFoamLevel(v) {
        uA.value.y = v;
      },
      setShoreFoamWidthPx(v) {
        uA.value.z = v;
      },
      setShoreFoamSwashPx(v) {
        uA.value.w = v;
      },
      setShoreFoamSoftPx(v) {
        uB.value.x = v;
      },
      setFoamTexturePx(v) {
        uB.value.y = v;
      },
      setShoreFoamVariation(v) {
        uB.value.z = v;
      },
      setBreakSpray(v) {
        uB.value.w = v;
      },
    },
  };
}

/** Spray cell size, world px — at most one speck per cell per generation. */
const SPECK_CELL_PX = 8;
/** One speck's life, seconds. Two generations half a life apart overlap. */
const SPECK_LIFE_SEC = 1.6;
/** Fraction of cells holding a speck where the gate is fully open. */
const SPECK_DENSITY = 0.9;
/** The author's own number: *"simple 2x2 and 1x1 75% opacity foam pixels"*. */
const SPECK_OPACITY = 0.75;

/**
 * BREAK SPRAY — 1×1 and 2×2 world-pixel specks of foam, 75% opaque, jittering
 * where the water breaks against a hard edge and riding the current downstream.
 * Author: *"simple 2x2 and 1x1 75% opacity foam pixels bouncing around where the
 * water smashes into a hard edge... carried by the water downstream. It should only
 * happen where the water is breaking against sharp edges though."*
 *
 * STATELESS, so nothing here has a grid to show: space is cut into
 * `SPECK_CELL_PX` cells in a frame that moves WITH the local current for one
 * speck life, every (cell, generation) hashes whether it holds a speck, where,
 * how big and which way it bursts; at the end of a life the frame snaps back and a
 * new generation hashes fresh specks. Two generations half a life apart overlap, so
 * there is never a moment with none. The test against the speck is done on the
 * integer pixel of the moving frame, so a speck is always exactly 1×1 or 2×2 map
 * pixels and steps a whole pixel at a time as it travels — crisp, never smeared.
 *
 * @param {*} THREE
 * @param {object} args
 * @param {*} args.worldXY - vec2 world px.
 * @param {*} args.tSec
 * @param {*} args.velocityPx - vec2 world px/s, the local current.
 * @param {*} args.gate - 0..1, where spray may exist (the caller's break test).
 * @param {*} args.uSpray - strength, 0 = off.
 * @returns {*} coverage 0..`SPECK_OPACITY`
 */
export function buildBreakSpecks(THREE, { worldXY, tSec, velocityPx, gate, uSpray }) {
  const { vec2, vec3, float, floor, fract, sin, cos, step, max, clamp, smoothstep, fwidth, mx_cell_noise_float } =
    THREE.TSL;
  const cellPx = float(SPECK_CELL_PX);
  let out = float(0);
  for (let g = 0; g < 2; g++) {
    const phase = tSec.div(float(SPECK_LIFE_SEC)).add(float(g * 0.5));
    const generation = floor(phase);
    const age = fract(phase);
    // The frame rides the current for this generation's whole life.
    const q = worldXY.sub(velocityPx.mul(age.mul(float(SPECK_LIFE_SEC))));
    const cell = floor(q.div(cellPx));
    const seed = vec3(cell.x, cell.y, generation.add(float(g * 977)));
    const hExist = mx_cell_noise_float(seed);
    const hX = mx_cell_noise_float(seed.add(vec3(13, 0, 0)));
    const hY = mx_cell_noise_float(seed.add(vec3(0, 29, 0)));
    const hSize = mx_cell_noise_float(seed.add(vec3(0, 0, 71)));
    const hDir = mx_cell_noise_float(seed.add(vec3(41, 17, 5)));
    // Spawn in the cell's middle, burst outward (fast, then slowing), and jitter —
    // all inside the cell, so no speck is ever clipped by a neighbour it cannot see.
    const spawn = vec2(hX, hY).mul(float(0.4)).add(float(0.3)).mul(cellPx);
    const angle = hDir.mul(float(2 * Math.PI));
    const ease = float(1).sub(float(1).sub(age).mul(float(1).sub(age)));
    const burst = vec2(cos(angle), sin(angle))
      .mul(cellPx.mul(float(0.17)))
      .mul(ease);
    const jitter = vec2(
      sin(tSec.mul(float(19)).add(hX.mul(float(50)))),
      cos(tSec.mul(float(15)).add(hY.mul(float(50))))
    ).mul(float(0.7));
    const corner = floor(spawn.add(burst).add(jitter));
    const size = float(1).add(step(float(0.45), hSize)); // 1 or 2 px, a little over half 2×2
    const pix = floor(q.sub(cell.mul(cellPx)));
    const inside = step(corner.x.sub(float(0.5)), pix.x)
      .mul(step(pix.x, corner.x.add(size).sub(float(0.5))))
      .mul(step(corner.y.sub(float(0.5)), pix.y))
      .mul(step(pix.y, corner.y.add(size).sub(float(0.5))));
    const alive = step(hExist, gate.mul(float(SPECK_DENSITY)).mul(uSpray))
      .mul(smoothstep(float(0), float(0.06), age))
      .mul(float(1).sub(smoothstep(float(0.8), float(1), age)));
    out = max(out, inside.mul(alive));
  }
  // Zoomed far out a speck is smaller than a screen pixel and would only sparkle.
  const fadeOut = smoothstep(float(2.5), float(1), fwidth(worldXY.x));
  return clamp(out.mul(fadeOut), float(0), float(1)).mul(float(SPECK_OPACITY));
}

/**
 * WHAT foam looks like, for any density 0..1: domain-warped fractal clumps,
 * thresholded by density, with lace holes. Returns coverage 0..1.
 * @param {*} THREE
 * @param {object} args
 * @param {*} args.worldXY @param {*} args.density @param {*} args.tSec
 * @param {*} args.texturePx - clump size, world px (a node).
 */
export function buildFoamTexture(THREE, { worldXY, density, tSec, texturePx }) {
  const { vec2, vec3, float, max, clamp, smoothstep, fwidth, mix, mx_worley_noise_vec2, mx_fractal_noise_float } =
    THREE.TSL;
  const scale = max(texturePx, float(4));
  const p = worldXY.div(scale);
  // Warp: two low-frequency noises push the domain around by ~a third of a clump,
  // so neither the clumps nor the lace line up into a visible lattice.
  const warp = vec2(
    mx_fractal_noise_float(vec3(p.x.mul(float(0.35)), p.y.mul(float(0.35)), tSec.mul(float(0.04))), 2, 2.0, 0.5),
    mx_fractal_noise_float(
      vec3(p.x.mul(float(0.35)).add(float(31.7)), p.y.mul(float(0.35)), tSec.mul(float(0.04))),
      2,
      2.0,
      0.5
    )
  ).mul(float(0.9));
  const q = p.add(warp);
  // Clumps: fbm (RMS ≈ 0.28) stretched to roughly 0..1.
  const clumpN = mx_fractal_noise_float(vec3(q.x, q.y, tSec.mul(float(0.07))), 3, 2.0, 0.5);
  const nn = clamp(clumpN.mul(float(1.7)).add(float(0.5)), float(0), float(1));
  // The cut slides from above the noise's ceiling (density 0 → nothing, even where
  // `nn` saturates at 1) to below its floor (density 1 → solid).
  const k = max(float(0.14), fwidth(nn).mul(float(1.5)));
  const cut = mix(float(1).add(k), k.negate(), clamp(density, float(0), float(1)));
  const clumps = smoothstep(cut.sub(k), cut.add(k), nn);
  // Bubbles: ROUND holes (Worley F1 discs around each feature point) at two scales —
  // big and many where the foam is thin, small and few where it is dense. Round on
  // purpose: the F2−F1 cell walls the first version punched holes with are straight-
  // sided polygons, and polygons read as shards, not foam.
  const bubbleRad = mix(float(0.42), float(0.12), smoothstep(float(0.3), float(0.95), density));
  const f1a = mx_worley_noise_vec2(q.mul(float(2.8)), float(1)).x;
  const f1b = mx_worley_noise_vec2(q.mul(float(6.1)).add(vec2(13.7, 5.1)), float(1)).x;
  const aaA = max(float(0.05), fwidth(f1a).mul(float(1.5)));
  const aaB = max(float(0.05), fwidth(f1b).mul(float(1.5)));
  const holeA = float(1).sub(smoothstep(bubbleRad.sub(aaA), bubbleRad.add(aaA), f1a));
  const holeB = float(1).sub(smoothstep(bubbleRad.mul(float(0.8)).sub(aaB), bubbleRad.mul(float(0.8)).add(aaB), f1b));
  const hole = max(holeA, holeB.mul(float(0.8)));
  const shade = float(0.82).add(clumpN.mul(float(0.5)));
  // Thin foam is a translucent fleck, dense foam is solid: opacity follows density too,
  // so the tail fades into the water instead of ending in hard white specks.
  const opacity = mix(float(0.3), float(1), smoothstep(float(0.05), float(0.8), density));
  return clamp(
    clumps
      .mul(float(1).sub(hole.mul(float(0.75))))
      .mul(shade)
      .mul(opacity),
    float(0),
    float(1)
  );
}
