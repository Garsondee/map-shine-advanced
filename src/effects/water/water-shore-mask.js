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
/** Along-shore scale of the slow in-and-out drift of the whole foam profile, world px (2026-11-09, mmp-78u.30.1). */
const DRIFT_SCALE_PX = 150;
/** Where |∇m| is below this (per world px) the mask has no gradient to measure. */
const MIN_GRADIENT = 1e-4;
/** Clamp on the distance estimate, world px. */
const MAX_DIST_PX = 4096;
/** The binomial kernel — [1 4 6 4 1]/16 has variance 1, so σ = tap spacing. */
const KERNEL = [1, 4, 6, 4, 1];

/**
 * THE SHORE PATTERN RIDES THE CURRENT (2026-11-10, mmp-78u.30.11 — Ingram: "we need foam on the water surface which flows
 * along with the flow"). Every along-shore noise that decides where the foam is thick, thin, broken or absent (reach,
 * coverage, line weight, patches, the swash phase) used to be anchored to the WORLD and only drifted in time, so the foam
 * sat on the bank like paint while the water ran past it and only the small clumps drawn on top of it moved. Now each
 * noise is read through a two-phase flow map: two copies slid downstream by the local current, half a cycle apart, each
 * faded out at its own reset, so the patches themselves slide along the bank and thin out and break up as they go.
 */
export const SHORE_FLOW_CYCLE_SEC = 4;
/** The fastest the shore pattern slides, world px/s. A fast rapid would shear the patches into rays inside one cycle; the
 * clumps drawn on top (`buildFoamTexture`) still travel at the water's own speed. */
export const SHORE_SLIDE_MAX_PX = 60;

/**
 * CPU twin of the flow map's phase weights, so the cross-fade is Node-assertable.
 * @param {number} tSec
 * @param {number} [cycleSec]
 * @returns {{ph0:number, ph1:number, w0:number, w1:number, norm:number}} the two phases (0..1), their triangle weights
 *   (sum 1; each is 0 at its own reset) and the variance-preserving divisor `sqrt(w0² + w1²)`.
 */
export function shoreFlowPhases(tSec, cycleSec = SHORE_FLOW_CYCLE_SEC) {
  const cyc = tSec / cycleSec;
  const ph0 = cyc - Math.floor(cyc);
  const c1 = cyc + 0.5;
  const ph1 = c1 - Math.floor(c1);
  const w0 = 1 - Math.abs(ph0 * 2 - 1);
  const w1 = 1 - w0;
  return { ph0, ph1, w0, w1, norm: Math.max(Math.sqrt(w0 * w0 + w1 * w1), 1e-3) };
}

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
 * @param {*|null} [args.flowDir] - vec2 unit, which way the water is going here.
 * @param {*|null} [args.farOutward] - vec2 unit pointing away from the nearest shore, for
 *   where the mask has no gradient to give one (the body pack's rotated tangent).
 * @param {*|null} [args.slidePx] - vec2 world px/s, the current the foam pattern rides (see `SHORE_FLOW_CYCLE_SEC`).
 *   Null = the pattern stays where it is and only drifts in time (the old behaviour).
 */
export function buildMaskShoreDensity(
  THREE,
  { maskTexNode, maskUvAt, worldXY, shoreDist = null, tSec, flowDir = null, farOutward = null, slidePx = null }
) {
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
    dot,
    fract,
    abs,
    sqrt,
    Fn,
    If,
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

  // ── THE SHORE NORMAL, from the same taps ────────────────────────────────
  // ∇m points into the water, and here it is smooth to the pixel. The body pack's
  // tangent is NOT, right at a wall: it is the jump flood's nearest-seed direction,
  // which flips between the staircase's orientations texel by texel — anything
  // steered by it there (facing, along-bank drift) comes out as ~7 px squares.
  // Where the mask has no gradient (deep water past a hard edge) the body pack's is
  // used, and it is smooth that far from the boundary.
  const maskNormal = vec2(gx, gy).div(max(length(vec2(gx, gy)), float(1e-6)));
  const normalTrust = smoothstep(float(0.0015), float(0.006), gradLen);
  const outwardRaw = farOutward ? mix(farOutward, maskNormal, normalTrust) : maskNormal;
  const outward = outwardRaw.div(max(length(outwardRaw), float(1e-4)));

  // ── THE CURRENT'S SAY (2026-10-17, author: "make it react to the stream movement"): a face the current drives into piles
  // foam up wider and heavier and keeps a solid line; a wall the current merely runs past gets streaks and a line broken
  // about half the time; the lee side, where the water pulls away, keeps only scraps.
  const flowIntoShore = flowDir ? dot(flowDir, outward) : float(0);
  const frontN = max(flowIntoShore.negate(), float(0));
  const leeN = max(flowIntoShore, float(0));

  // ── THE PATTERN RIDES THE CURRENT (see `SHORE_FLOW_CYCLE_SEC`) ──────────
  // Two copies of every along-shore noise, slid downstream by `slidePx`, half a cycle apart and each invisible at its own
  // reset; a plain linear blend (weights sum to 1), because the two copies are the SAME field a little apart, not
  // independent ones. With no current given the pattern stays put and costs one copy.
  // `uSlide` (0..1, the `shoreFoamFlow` dial): 0 pins the pattern to the bank again.
  const uSlide = uniform(float(1));
  const slide = slidePx
    ? slidePx.mul(min(float(1), float(SHORE_SLIDE_MAX_PX).div(max(length(slidePx), float(1e-3))))).mul(uSlide)
    : null;
  const rideCyc = tSec.div(float(SHORE_FLOW_CYCLE_SEC));
  const ridePh0 = fract(rideCyc);
  const ridePh1 = fract(rideCyc.add(float(0.5)));
  const rideW0 = float(1).sub(abs(ridePh0.mul(float(2)).sub(float(1))));
  const rideW1 = float(1).sub(rideW0);
  const rideAt0 = slide ? worldXY.sub(slide.mul(ridePh0.mul(float(SHORE_FLOW_CYCLE_SEC)))) : worldXY;
  const rideAt1 = slide ? worldXY.sub(slide.mul(ridePh1.mul(float(SHORE_FLOW_CYCLE_SEC)))) : worldXY;
  // A 2-octave fractal noise anchored to the pattern: `scalePx` world px per noise unit, a shift in noise units, a time rate.
  const rideNoise = (scalePx, shiftX, shiftY, rate) => {
    const at = (w) =>
      mx_fractal_noise_float(
        vec3(
          w.x.div(float(scalePx)).add(float(shiftX)),
          w.y.div(float(scalePx)).add(float(shiftY)),
          tSec.mul(float(rate))
        ),
        2,
        2.0,
        0.5
      );
    return slide ? at(rideAt0).mul(rideW0).add(at(rideAt1).mul(rideW1)) : at(worldXY);
  };

  // ── THE FOAM ITSELF, only near enough to a shore to matter ──────────────
  // Eight noises and a profile are a lot to run on every pixel of an open sea, so the whole block sits inside an `If` on the
  // distance: past ~9 reach-widths the tail has decayed far below anything the foam texture can draw. The derivative the
  // edge's antialiasing needs is taken from `dist` BEFORE the branch (WGSL forbids `fwidth` under non-uniform control flow).
  const density = Fn(() => {
    const aa = max(fwidth(dist), float(1.5)).toVar('shoreAa');
    const out = float(0).toVar('shoreDensity');
    If(dist.greaterThan(float(-40)).and(dist.lessThan(widthPx.mul(float(9)).add(float(60)))), () => {
      // ── MOTION: swash, wobble ─────────────────────────────────────────────
      const phaseNoise = rideNoise(BREAKUP_SCALE_PX, 0, 0, 0.02);
      const swash = sin(tSec.mul(float((2 * Math.PI) / SWASH_PERIOD_SEC)).add(phaseNoise.mul(float(9))))
        .mul(float(0.5))
        .mul(swashPx);
      const wobbleNoise = rideNoise(WOBBLE_SCALE_PX, 0, 0, 0.06);
      // Distance from the foam's LEADING EDGE, world px, positive into the water.
      // ⚠️ NOT ONE RING PER EDGE (2026-11-09, mmp-78u.30.1 — Ingram: "I see three rings around the boats"). The leading edge
      // only wobbled +-10 px, so the line, the tail's end and the open water sat at fixed offsets round every hull: three
      // concentric rings. A second, slower warp (`DRIFT_SCALE_PX`) pushes the whole profile in and out along the shore by up
      // to ~0.8 of the local reach, so where the foam starts and where it ends wander independently of the hull's outline.
      const driftNoise = rideNoise(DRIFT_SCALE_PX, 3.7, 0, 0.05);
      const x = dist
        .sub(swash)
        .sub(wobbleNoise.mul(float(WOBBLE_PX * 2.5)))
        .sub(driftNoise.mul(widthPx).mul(float(1.6)));

      // ── VARIATION: every stretch of shore its own reach, coverage and line weight ──
      // Three independent noises at a few hundred px, each drifting on its own clock, so the band changes shape over tens
      // of seconds instead of being an offset copy of the waterline. `variation` = 0 collapses all three to 1.
      const widthNoise = rideNoise(VARIATION_SCALE_PX, 0, 0, 0.035);
      const coverNoise = rideNoise(VARIATION_SCALE_PX, 41.7, -13.1, 0.045);
      const weightNoise = rideNoise(VARIATION_SCALE_PX / 2.3, 7.1, 0, 0.08);
      const widthMul = mix(
        float(1),
        mix(float(0.2), float(1.9), smoothstep(float(-0.32), float(0.32), widthNoise)),
        variation
      );
      const coverage = mix(float(1), smoothstep(float(-0.1), float(0.32), coverNoise), variation).mul(
        mix(float(1), float(0.3), leeN)
      );
      // The line itself only breaks in the deepest gaps; elsewhere it thins and thickens.
      const lineGate = mix(
        mix(float(1), smoothstep(float(0.02), float(0.3), coverNoise.add(weightNoise.mul(float(0.6)))), variation),
        float(1),
        frontN
      ).mul(mix(float(1), float(0.4), leeN));
      const weightMul = mix(
        float(1),
        mix(float(0.25), float(2.2), smoothstep(float(-0.3), float(0.3), weightNoise)),
        variation
      );

      // ── DENSITY PROFILE: a solid line, then a decaying tail ───────────────
      const lead = smoothstep(aa.negate(), aa, x);
      const xp = max(x, float(0));
      const patchNoiseEarly = rideNoise(BREAKUP_SCALE_PX / 2.7, 9.1, 0, 0.03);
      const lineW = float(LINE_PX)
        .mul(float(1).add(wobbleNoise.mul(float(1.8))))
        .mul(weightMul)
        .mul(float(1).add(frontN.mul(float(0.8))));
      const line = float(1)
        .sub(smoothstep(lineW.sub(aa), lineW.add(aa), xp))
        .mul(lineGate);
      const reach = widthPx
        .mul(widthMul)
        .mul(float(1).add(frontN.mul(float(1.4))))
        .mul(float(1).sub(leeN.mul(float(0.6))));
      const tailReach = reach.mul(
        float(0.55).add(smoothstep(float(-0.4), float(0.4), wobbleNoise.add(patchNoiseEarly)).mul(float(0.9)))
      );
      const tail = exp(xp.div(max(tailReach, float(1))).negate()).mul(float(0.85));
      const patchNoise = rideNoise(BREAKUP_SCALE_PX, 17.3, 0, 0.015);
      const patches = float(0.55).add(smoothstep(float(-0.25), float(0.35), patchNoise).mul(float(0.45)));
      // ⚠️ NO HOOPS (2026-11-10, Ingram: "do you see the 'loops/hoops' that are appearing. Could we fill them in please").
      // `lead` is 0 shoreward of the leading edge, so wherever the swash, wobble or drift pushed the edge out from the
      // waterline the strip between the shore and the foam was left as bare water: dark arches between foam and wall.
      // That strip is now filled with the line's own foam (the same `lineGate`, so the line still breaks where it breaks).
      const fill = float(1).sub(lead).mul(lineGate);
      out.assign(
        clamp(max(lead.mul(max(line, tail.mul(patches).mul(coverage))), fill).mul(amount), float(0), float(1))
      );
    });
    return out;
  })();

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
    outward,
    front: frontN,
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
      setShoreFoamFlow(v) {
        uSlide.value = v;
      },
      setBreakSpray(v) {
        uB.value.w = v;
      },
    },
  };
}

/** Fleck cell size, world px — at most one fleck per cell per (direction, generation) frame. (2026-11-06: 8 -> 6, with 30
 * frames instead of 12, about four times the flecks — Ingram: "a lot more of these dots flying around".) */
const FLECK_CELL_PX = 6;
/** One fleck's whole life, seconds: a short flight, then a long ride on the current. */
const FLECK_LIFE_SEC = 4.5;
/** Time in the air, seconds — each frame has its own, between these. */
const FLECK_AIR_MIN_SEC = 0.45;
const FLECK_AIR_MAX_SEC = 0.95;
/** A fleck that lands on dry ground is gone this long after landing, seconds. */
const FLECK_GROUND_FADE_SEC = 0.35;
/** Launch directions per generation (each a shared flight frame), and generations (staggered launch times). */
const FLECK_DIRECTIONS = 10;
const FLECK_GENERATIONS = 3;
/** Fraction of cells that throw a fleck where the emitter is fully on. */
const FLECK_DENSITY = 1;
/** Launch speed range, world px/s. */
const FLECK_SPEED_MIN = 40;
const FLECK_SPEED_MAX = 150;
/** Once on the water, each launch group also slides sideways at up to ± this, world px/s,
 * so a batch thrown together spreads out instead of travelling as a sheet. */
const FLECK_SCATTER_PX = 18;
/** Each fleck's launch point sits up to this far BACK along its own flight path, world
 * px, so a batch leaves the wall as a cloud rather than a dotted line. */
const FLECK_LEAD_PX = 30;
/** THE ARC (2026-11-06): the highest a fleck rises up the page at the top of its flight, world px (seen from above at the
 * map's slight tilt, a ballistic throw climbs up the screen and falls back). Each frame reaches 40-100% of it. */
const FLECK_APEX_PX = 22;
/** The wind's push on a fleck in the air, world px/s at full wind — a nudge, not a gale. */
const FLECK_WIND_PX = 45;
/** Fleck radius range, world px (round dots, 2026-11-06 — Ingram: "small circles, not squares"). */
const FLECK_RADIUS_MIN = 0.55;
const FLECK_RADIUS_MAX = 1.25;
/** At the top of its arc a fleck is a little brighter (and a little bigger). */
const FLECK_OPACITY = 0.75;

/**
 * BREAK SPRAY — small round flecks of foam, thrown up where the current smashes into a hard edge, flying a ballistic arc
 * (nudged by the wind), then riding the current downstream if they land on water, or fading out if they land on ground —
 * which they may: flecks are allowed outside the water.
 * Author: *"flecks of foam which got launched up into the air then which glide back down and land on the water then get
 * carried down stream or land on the ground outside the water and fade out."*
 *
 * STATELESS, and BORN AT THE SOURCE: every (direction, generation) is a frame that carries all its flecks the same way —
 * out along its launch direction and up its arc for the flight, then (for a pixel on water) with the current — so a pixel
 * finds the one fleck that can be on it by undoing that frame's displacement, and then asks the EMITTER at that fleck's own
 * spawn point (`sprayAt`) whether it was ever thrown. Whether it landed on water or ground is asked at its landing point
 * (`waterAt`). 2026-11-06 (mmp-7kx.1 — Ingram: same size, same speed, same distance, a whole unit ejected at once in one
 * direction): 30 frames instead of 12, each with its own speed, air time and arc height, staggered over three launch
 * generations, so neighbours no longer travel as one sheet; and each fleck is a soft round dot of its own radius.
 *
 * @param {*} THREE
 * @param {object} args
 * @param {*} args.worldXY - vec2 world px.
 * @param {*} args.tSec
 * @param {*} args.velocityPx - vec2 world px/s, the current the flecks ride once landed.
 * @param {*} args.insideHere - 0..1, is this pixel water.
 * @param {(w: *) => *} args.sprayAt - world vec2 → emitter 0..1 there.
 * @param {(w: *) => *} args.waterAt - world vec2 → water presence 0..1 there.
 * @param {*} args.uSpray - strength, 0 = off.
 * @param {*} [args.windVec] - vec2, wind direction x strength 0..1 (world axes). Absent = still air.
 * @param {*} [args.shoreAbsDist] - |signed distance| to the nearest shore, world px. Given, the fleck loop only runs within
 *   reach of a shore (see {@link fleckReachPx}) — `sprayAt`/`waterAt` must then sample at an EXPLICIT level.
 * @param {*} [args.emitterBandPx] - how far from the SDF's own zero contour a spray emitter can sit, world px.
 * @returns {*} coverage 0..1
 */
export function buildBreakSpecks(
  THREE,
  {
    worldXY,
    tSec,
    velocityPx,
    insideHere,
    sprayAt,
    waterAt,
    uSpray,
    windVec = null,
    shoreAbsDist = null,
    emitterBandPx = null,
  }
) {
  const {
    vec2,
    vec3,
    float,
    floor,
    fract,
    sin,
    cos,
    step,
    max,
    min,
    mix,
    clamp,
    smoothstep,
    fwidth,
    length,
    mx_cell_noise_float,
    Fn,
    If,
  } = THREE.TSL;
  const cellPx = float(FLECK_CELL_PX);
  const inWater = step(float(0.5), insideHere);
  const windPx = windVec ? windVec.mul(float(FLECK_WIND_PX)) : vec2(0, 0);
  // the edge of a dot: about one screen pixel of soft edge, never sharper than a third of a world px
  const aa = max(fwidth(worldXY.x), float(0.35));
  const fleckCoverage = () => {
    let out = float(0);
    for (let g = 0; g < FLECK_GENERATIONS; g++) {
      for (let k = 0; k < FLECK_DIRECTIONS; k++) {
        const phase = tSec.div(float(FLECK_LIFE_SEC)).add(float(g / FLECK_GENERATIONS + k * 0.137));
        const generation = floor(phase);
        const age = fract(phase);
        const tau = age.mul(float(FLECK_LIFE_SEC));
        // This frame's own throw: a direction turned differently every generation, a speed, an air time and an arc height.
        const turn = fract(generation.mul(float(0.618034)).add(float(k * 0.271 + g * 0.113)));
        const angle = float(k / FLECK_DIRECTIONS)
          .add(turn.mul(float(1 / FLECK_DIRECTIONS)))
          .mul(float(2 * Math.PI));
        const hSpeed = fract(generation.mul(float(0.3719)).add(float(k * 0.4142 + g * 0.29)));
        const hAir = fract(generation.mul(float(0.5521)).add(float(k * 0.3317 + g * 0.61)));
        const speed = mix(float(FLECK_SPEED_MIN), float(FLECK_SPEED_MAX), hSpeed);
        const airSec = mix(float(FLECK_AIR_MIN_SEC), float(FLECK_AIR_MAX_SEC), hAir);
        const apex = float(FLECK_APEX_PX).mul(float(0.4).add(hSpeed.mul(0.3)).add(hAir.mul(0.3)));
        const dir = vec2(cos(angle), sin(angle));
        const tAir = min(tau, airSec);
        const airFrac = tAir.div(airSec);
        const airborne = step(tau, airSec);
        // Out along the launch direction (slowing as it falls), up and back down its arc, and a nudge downwind.
        const flight = dir
          .mul(speed)
          .mul(tAir)
          .mul(float(1).sub(airFrac.mul(float(0.4))));
        const height = airFrac.mul(float(1).sub(airFrac)).mul(float(4)).mul(airborne);
        const lift = vec2(0, apex.mul(height).negate());
        const windDrift = windPx.mul(tAir);
        const landOffset = dir
          .mul(speed)
          .mul(airSec.mul(float(0.6)))
          .add(windPx.mul(airSec));
        const afterAir = max(tau.sub(airSec), float(0));
        const scatter = vec2(dir.y.negate(), dir.x).mul(
          fract(generation.mul(float(0.7311)).add(float(k * 0.1913 + g * 0.37)))
            .sub(float(0.5))
            .mul(float(2 * FLECK_SCATTER_PX))
        );
        const drift = velocityPx.add(scatter).mul(afterAir).mul(inWater);
        const q = worldXY.sub(flight).sub(lift).sub(windDrift).sub(drift);

        const cell = floor(q.div(cellPx));
        const seed = vec3(cell.x, cell.y, generation.add(float(k * 131 + g * 977)));
        const hExist = mx_cell_noise_float(seed);
        const hX = mx_cell_noise_float(seed.add(vec3(13, 0, 0)));
        const hY = mx_cell_noise_float(seed.add(vec3(0, 29, 0)));
        const hSize = mx_cell_noise_float(seed.add(vec3(0, 0, 71)));
        const hLead = mx_cell_noise_float(seed.add(vec3(53, 0, 19)));
        // Spawn in the middle of the cell, so even the biggest dot is never clipped by a neighbour.
        const spawn = cell.add(vec2(hX, hY).mul(float(0.4)).add(float(0.3))).mul(cellPx);
        // Waves come in sets: a whole stretch of wall throws, or doesn't, per generation.
        const hBurst = mx_cell_noise_float(
          vec3(floor(spawn.x.div(float(48))), floor(spawn.y.div(float(48))), generation.add(float(k * 7 + g * 3)))
        );
        const launchedAt = spawn.sub(dir.mul(hLead.mul(float(FLECK_LEAD_PX))));
        const thrown = step(hExist, sprayAt(launchedAt).mul(float(FLECK_DENSITY)).mul(uSpray)).mul(
          step(float(0.35), hBurst)
        );

        const landedWet = step(float(0.25), waterAt(spawn.add(landOffset)));
        const riding = inWater.mul(landedWet).mul(float(1).sub(smoothstep(float(0.65), float(1), age)));
        const grounded = float(1)
          .sub(inWater)
          .mul(float(1).sub(landedWet))
          .mul(float(1).sub(smoothstep(airSec, airSec.add(float(FLECK_GROUND_FADE_SEC)), tau)));
        const visible = airborne
          .add(float(1).sub(airborne).mul(riding.add(grounded)))
          .mul(smoothstep(float(0), float(0.02), age));

        // A soft round dot of its own size, a touch bigger and brighter near the top of its arc.
        const radius = mix(float(FLECK_RADIUS_MIN), float(FLECK_RADIUS_MAX), hSize).mul(
          float(1).add(height.mul(float(0.3)))
        );
        const d = length(q.sub(spawn));
        const dot = float(1).sub(smoothstep(radius.sub(aa.mul(0.5)), radius.add(aa.mul(0.5)), d));
        const bright = mix(float(FLECK_OPACITY), float(0.95), height);
        out = max(out, dot.mul(thrown).mul(visible).mul(bright));
      }
    }
    return out;
  };
  // Zoomed far out a fleck is smaller than a screen pixel and would only sparkle.
  if (!shoreAbsDist) {
    const fadeOut = smoothstep(float(2.5), float(1), fwidth(worldXY.x));
    return clamp(fleckCoverage().mul(fadeOut), float(0), float(1));
  }
  // ⚠️ ONLY WHERE A FLECK CAN BE (2026-10-25, Water-Performance-Audit W-06): every pixel a fleck can ever cover lies within
  // `fleckReachPx` of a shore; past that, zoomed out past the fade, or with spray at 0, the result is exactly 0. `fadeOut`'s
  // derivative is ASSIGNED before the `If` (uniform control flow).
  const reach = fleckReachPx(THREE.TSL, { velocityPx, emitterBandPx: emitterBandPx ?? float(64) });
  return Fn(() => {
    const fadeOut = smoothstep(float(2.5), float(1), fwidth(worldXY.x)).toVar('fleckFadeOut');
    const result = float(0).toVar('fleckCoverage');
    If(
      fadeOut
        .greaterThan(float(0))
        .and(uSpray.greaterThan(float(0)))
        .and(shoreAbsDist.lessThan(reach)),
      () => {
        result.assign(clamp(fleckCoverage().mul(fadeOut), float(0), float(1)));
      }
    );
    return result;
  })();
}

/** The flight's own worst-case reach, world px: lead + fastest throw over the longest air time + wind + arc + a cell. */
const FLECK_FLIGHT_REACH_PX =
  FLECK_LEAD_PX +
  FLECK_SPEED_MAX * FLECK_AIR_MAX_SEC +
  FLECK_WIND_PX * FLECK_AIR_MAX_SEC +
  FLECK_APEX_PX +
  FLECK_CELL_PX +
  2;

/**
 * The farthest a break-spray fleck can be drawn from the SDF's zero contour, world px — a CONSERVATIVE bound, summed term
 * by term from `buildBreakSpecks`' own motion: the emitter's offset from the contour, the lead, the flight (≤ max speed ×
 * longest air time), the wind and the arc, the ride on the current after landing (≤ (|velocity| + scatter) × the rest of
 * the longest life), and one cell plus a dot. Exported for the Node test that checks it against brute force.
 * @param {*} TSL @param {{velocityPx: *, emitterBandPx: *}} args
 * @returns {*} a float node
 */
export function fleckReachPx(TSL, { velocityPx, emitterBandPx }) {
  const { float, length } = TSL;
  const ride = length(velocityPx)
    .add(float(FLECK_SCATTER_PX))
    .mul(float(FLECK_LIFE_SEC - FLECK_AIR_MIN_SEC));
  return emitterBandPx.add(float(FLECK_FLIGHT_REACH_PX)).add(ride);
}

/** {@link fleckReachPx} in plain numbers, for tests and reports. */
export function fleckReachPxNumber({ speedPx, emitterBandPx }) {
  return (
    emitterBandPx +
    FLECK_FLIGHT_REACH_PX +
    (Math.abs(speedPx) + FLECK_SCATTER_PX) * (FLECK_LIFE_SEC - FLECK_AIR_MIN_SEC)
  );
}

/** The fleck motion constants, for the reach test's brute force. */
export const FLECK_MOTION = Object.freeze({
  LIFE: FLECK_LIFE_SEC,
  AIR_MIN: FLECK_AIR_MIN_SEC,
  AIR_MAX: FLECK_AIR_MAX_SEC,
  SPEED_MIN: FLECK_SPEED_MIN,
  SPEED_MAX: FLECK_SPEED_MAX,
  SCATTER: FLECK_SCATTER_PX,
  LEAD: FLECK_LEAD_PX,
  APEX: FLECK_APEX_PX,
  WIND: FLECK_WIND_PX,
  CELL: FLECK_CELL_PX,
  RADIUS_MAX: FLECK_RADIUS_MAX,
  DIRECTIONS: FLECK_DIRECTIONS,
  GENERATIONS: FLECK_GENERATIONS,
});

/** One flow-map cycle, seconds: how long the foam texture rides the current before it
 * is cross-faded to a fresh copy. Short enough that shear along a wall streaks it
 * rather than shredding it. */
const FLOW_CYCLE_SEC = 1.6;
/** Streaks: the current speed (world px/s) where the smear starts and where it is full. */
const FOAM_STREAK_SPEED_LO_PX = 8;
const FOAM_STREAK_SPEED_HI_PX = 45;
/** Streaks: how far up and down stream the two extra noise taps sit, in clump units (a clump is `texturePx`). ~1 is one
 * noise period, so the three taps are nearly independent and the smear is about three clumps long. */
const FOAM_STREAK_TAP_UNITS = 0.95;
/** Streaks: restores the contrast the three-tap average loses (weights 0.5/1/0.5 of near-independent noise: std 0.61). */
const FOAM_STREAK_GAIN = 1.35;
/** How soft the edge of a clump is, in noise units (was 0.14 - a ~2 px cut-paper edge; foam is feathered). */
const FOAM_EDGE_SOFT = 0.26;

/**
 * WHAT foam looks like, for any density 0..1: domain-warped fractal clumps,
 * thresholded by density, with round bubble holes — and, given a velocity, CARRIED
 * BY THE CURRENT (a two-phase flow map: two copies scrolling with the local flow,
 * half a cycle apart, each faded out at its own reset). Returns coverage 0..1.
 *
 * Only evaluated where there is foam: the noise lives inside a per-pixel `If` on
 * the density, and every `fwidth` it needs is taken from the domain BEFORE the
 * branch (WGSL forbids derivatives under non-uniform control flow).
 * @param {*} THREE
 * @param {object} args
 * @param {*} args.worldXY @param {*} args.density @param {*} args.tSec
 * @param {*} args.texturePx - clump size, world px (a node).
 * @param {*|null} [args.velocityPx] - vec2 world px/s; null = still water.
 */
export function buildFoamTexture(THREE, { worldXY, density, tSec, texturePx, velocityPx = null }) {
  const {
    vec2,
    vec3,
    float,
    max,
    abs,
    sqrt,
    length,
    clamp,
    smoothstep,
    fwidth,
    mix,
    fract,
    Fn,
    If,
    mx_worley_noise_vec2,
    mx_fractal_noise_float,
  } = THREE.TSL;
  const scale = max(texturePx, float(4));
  const p = worldXY.div(scale);
  const d = clamp(density, float(0), float(1));
  const vel = velocityPx ? velocityPx.div(scale) : vec2(0, 0);
  const cyc = tSec.div(float(FLOW_CYCLE_SEC));
  const ph0 = fract(cyc);
  const ph1 = fract(cyc.add(float(0.5)));
  // Triangle weights: each copy is invisible at its own reset.
  const w0 = float(1).sub(abs(ph0.mul(float(2)).sub(float(1))));
  const w1 = float(1).sub(w0);

  // STREAKS ALONG THE CURRENT (2026-11-10, mmp-78u.30.11): a clump is smeared along the way the water is going - the noise is
  // read a little upstream and downstream of the pixel and the three averaged - so foam in moving water draws as filaments and
  // rafts lying with the current instead of round blotches. Still water has none (strength 0, a pond keeps its round clumps).
  // (A linear stretch of the coordinates would be cheaper, but it pivots on the world origin and every degree the heading
  // changes would swing the pattern by hundreds of px; taps are local.)
  const speedPx = velocityPx ? length(velocityPx) : float(0);
  const streakDir = velocityPx ? velocityPx.div(max(speedPx, float(1e-3))) : vec2(0, 0);
  const streakAmt = smoothstep(float(FOAM_STREAK_SPEED_LO_PX), float(FOAM_STREAK_SPEED_HI_PX), speedPx);
  const layer = (q, aaA, aaB) => {
    // Warp: two low-frequency noises push the domain around by ~a third of a clump,
    // so neither the clumps nor the bubbles line up into a visible lattice.
    const warp = vec2(
      mx_fractal_noise_float(vec3(q.x.mul(float(0.35)), q.y.mul(float(0.35)), tSec.mul(float(0.04))), 2, 2.0, 0.5),
      mx_fractal_noise_float(
        vec3(q.x.mul(float(0.35)).add(float(31.7)), q.y.mul(float(0.35)), tSec.mul(float(0.04))),
        2,
        2.0,
        0.5
      )
    ).mul(float(0.9));
    const qw = q.add(warp);
    const clumpAt = (c) => mx_fractal_noise_float(vec3(c.x, c.y, tSec.mul(float(0.07))), 3, 2.0, 0.5);
    const clump0 = clumpAt(qw);
    let clumpN = clump0;
    if (velocityPx) {
      const tapOff = streakDir.mul(float(FOAM_STREAK_TAP_UNITS));
      const smeared = clumpAt(qw.sub(tapOff))
        .mul(float(0.5))
        .add(clump0)
        .add(clumpAt(qw.add(tapOff)).mul(float(0.5)))
        .mul(float(FOAM_STREAK_GAIN));
      clumpN = mix(clump0, smeared, streakAmt);
    }
    // Bubbles: ROUND holes (Worley F1 discs) at two scales — big and many where the
    // foam is thin, small and few where it is dense. Round on purpose: holes punched
    // along F2−F1 cell walls are straight-sided polygons, and read as shards.
    // (dense foam keeps a lace of 0.2 now, was 0.12: a thick patch drew as flat white)
    const bubbleRad = mix(float(0.42), float(0.2), smoothstep(float(0.3), float(0.95), d));
    const f1a = mx_worley_noise_vec2(qw.mul(float(2.8)), float(1)).x;
    const f1b = mx_worley_noise_vec2(qw.mul(float(6.1)).add(vec2(13.7, 5.1)), float(1)).x;
    const holeA = float(1).sub(smoothstep(bubbleRad.sub(aaA), bubbleRad.add(aaA), f1a));
    const rb = bubbleRad.mul(float(0.8));
    const holeB = float(1).sub(smoothstep(rb.sub(aaB), rb.add(aaB), f1b));
    return { clumpN, hole: max(holeA, holeB.mul(float(0.8))) };
  };

  return Fn(() => {
    // Screen-space AA widths, from the domain's own derivative, OUTSIDE the branch.
    // ⚠️ ASSIGNED HERE, INSIDE THE `Fn` (fixed 2026-10-25). These used to be
    // built above the `Fn`, which does not decide where they are EMITTED: TSL
    // writes a node at its first use, which was inside the `If`, so the
    // generated WGSL ran `fwidth` per-pixel-branched (seen in the shader dump)
    // and a quad straddling `d > 0.002` differentiated against lanes that
    // never computed `p`. A `toVar` made in the body is assigned at this
    // statement, in uniform control flow.
    const fwP = fwidth(p.x).add(fwidth(p.y)).toVar('foamTextureFw');
    const k = max(float(FOAM_EDGE_SOFT), fwP.mul(float(4)));
    const aaA = max(float(0.05), fwP.mul(float(2.8 * 1.5)));
    const aaB = max(float(0.05), fwP.mul(float(6.1 * 1.5)));
    const out = float(0).toVar('foamTextureOut');
    If(d.greaterThan(float(0.002)), () => {
      const l0 = layer(p.sub(vel.mul(ph0.mul(float(FLOW_CYCLE_SEC)))), aaA, aaB);
      const l1 = layer(p.sub(vel.mul(ph1.mul(float(FLOW_CYCLE_SEC)))).add(vec2(37.1, 11.3)), aaA, aaB);
      // Variance-preserving blend of the two noises BEFORE the threshold, so clumps
      // stay crisp mid-fade instead of becoming a double exposure.
      const norm = sqrt(w0.mul(w0).add(w1.mul(w1)));
      const clumpN = l0.clumpN
        .mul(w0)
        .add(l1.clumpN.mul(w1))
        .div(max(norm, float(1e-3)));
      const nn = clamp(clumpN.mul(float(1.7)).add(float(0.5)), float(0), float(1));
      // The cut slides from above the noise's ceiling (density 0 → nothing, even where
      // `nn` saturates at 1) to below its floor (density 1 → solid).
      const cut = mix(float(1).add(k), k.negate(), d);
      const clumps = smoothstep(cut.sub(k), cut.add(k), nn);
      const hole = l0.hole.mul(w0).add(l1.hole.mul(w1));
      const shade = float(0.82).add(clumpN.mul(float(0.5)));
      // Thin foam is a translucent fleck, dense foam is solid: opacity follows density
      // too, so the tail fades into the water instead of ending in hard white specks.
      const opacity = mix(float(0.3), float(1), smoothstep(float(0.05), float(0.8), d));
      out.assign(
        clamp(
          clumps
            .mul(float(1).sub(hole.mul(float(0.75))))
            .mul(shade)
            .mul(opacity),
          float(0),
          float(1)
        )
      );
    });
    return out;
  })();
}
