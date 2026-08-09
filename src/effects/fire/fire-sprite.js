/**
 * FIRE — THE SPRITE. The four bird's-eye flame archetypes, the colour gradients,
 * and the life curves. **This module is where the look lives.**
 *
 * THREE is INJECTED (as `TSL`), never imported — `effects/` may not reach `vt/`,
 * and every export here is either pure data or a TSL graph builder, so the
 * constants carry a Node test suite while the graphs stay GPU-only.
 *
 * ============================================================================
 * WHY THESE FOUR SHAPES, AND WHY THEY ARE AUTHORED RATHER THAN SIMULATED
 * ============================================================================
 *
 * This is a faithful port of V2's `ProceduralTextureBuilder`
 * (`legacy/compositor-v2/effects/FireEffectV2.js:271`), whose own header states
 * the problem this whole effect exists inside:
 *
 *   "Flame frames are bird's-eye fire pools (Map Shine is top-down), not
 *    side-view teardrops."
 *
 * V2's fire was the most-loved effect in V2. The rebuild that preceded this one
 * tried to DERIVE a top-down flame silhouette from physics — a vertical slab
 * integral whose shape came out of a radial distance field — and after five
 * rounds of live feedback it could not stop looking like a circle, because a
 * radius perturbed by noise *is* a circle. V2 never had that problem because it
 * never asked physics for the silhouette: a human drew four archetypes that read
 * as fire from directly overhead, and the simulation only ever moved them
 * around. That division of labour is the single most important lesson from the
 * autopsy and it is why this module exists.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY DIFFERENT FROM V2
 * ============================================================================
 *
 * V2 baked these into an 8×4 atlas of 64 px cells on a 2D canvas at startup, and
 * a flame sprite is 150–195 world units across — so every flame in the game was
 * a 64 px image stretched over ~180 px of screen, cross-faded between eight
 * discrete flicker frames. That blur and that frame-stepping are V2's one real
 * visual weakness, and they are an artifact of the shapes being computed on a
 * CPU canvas rather than a property of the shapes themselves.
 *
 * Here they are evaluated PER FRAGMENT, with a CONTINUOUS phase instead of a
 * column index. Same maths, no resolution ceiling, no flipbook steps.
 *
 * ⚠️ THE FALLBACK IS DOCUMENTED, NOT HYPOTHETICAL. If per-fragment evaluation
 * ever proves too costly at real particle counts, baking these same functions
 * into an atlas exactly as V2 did is a known-good answer — the archetype maths
 * below is the shared part either way.
 *
 * @module effects/fire/fire-sprite
 */
import { FIRE_RAMP_WOOD, hexToRgb01 } from './fire-geometry.js';

// ─────────────────────────────────────────────────────────────────────────────
// THE COLOUR SPEC — ported verbatim from V2's fire-behaviors.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three flame gradients, blended by a single `temperature` control.
 *
 * ⚠️ THESE ARE THE REFERENCE, NOT A STARTING POINT. They are the exact stops
 * V2 shipped (`fire-behaviors.js:379/387/395`) and the author signed off on the
 * resulting look for years. Retuning them is a taste decision that belongs to
 * the author, not a correctness one.
 *
 * `t` runs 0 → 1 as a particle ages, so index 0 is the hottest (newborn).
 */
export const FLAME_GRADIENT_COLD = Object.freeze([
  Object.freeze({ t: 0.0, rgb: Object.freeze([0.9, 0.5, 0.15]) }),
  Object.freeze({ t: 0.12, rgb: Object.freeze([0.8, 0.25, 0.03]) }),
  Object.freeze({ t: 0.4, rgb: Object.freeze([0.5, 0.1, 0.02]) }),
  Object.freeze({ t: 0.65, rgb: Object.freeze([0.3, 0.05, 0.01]) }),
  Object.freeze({ t: 1.0, rgb: Object.freeze([0.15, 0.03, 0.01]) }),
]);

export const FLAME_GRADIENT_STANDARD = Object.freeze([
  Object.freeze({ t: 0.0, rgb: Object.freeze([1.0, 0.95, 0.85]) }),
  Object.freeze({ t: 0.12, rgb: Object.freeze([1.0, 0.72, 0.2]) }),
  Object.freeze({ t: 0.4, rgb: Object.freeze([1.0, 0.38, 0.05]) }),
  Object.freeze({ t: 0.65, rgb: Object.freeze([0.6, 0.12, 0.02]) }),
  Object.freeze({ t: 1.0, rgb: Object.freeze([0.15, 0.04, 0.01]) }),
]);

export const FLAME_GRADIENT_HOT = Object.freeze([
  Object.freeze({ t: 0.0, rgb: Object.freeze([0.85, 0.92, 1.0]) }),
  Object.freeze({ t: 0.12, rgb: Object.freeze([1.0, 0.95, 0.85]) }),
  Object.freeze({ t: 0.4, rgb: Object.freeze([1.0, 0.78, 0.28]) }),
  Object.freeze({ t: 0.65, rgb: Object.freeze([1.0, 0.38, 0.05]) }),
  Object.freeze({ t: 1.0, rgb: Object.freeze([0.6, 0.12, 0.02]) }),
]);

/**
 * ⚠️ THE IGNITION POP — 0 → 4.0 IN THE FIRST 12% OF LIFE. This spike is not a
 * curve-fitting artifact; it is the flame's whole sense of *catching*. A
 * particle appears dark, slams to peak emission, then decays over the remaining
 * 88% of its life. Smooth this out and the fire stops crackling and starts
 * glowing.
 *
 * ⚠️ AND IT IS THE ONLY REASON FIRE BLOOMS. MSA's bloom threshold defaults to
 * **4.0** on an HDR scene (`BLOOM_PARAMS.threshold`), and this curve × the
 * emission gains below lands the newborn core near 15 — comfortably over. The
 * previous (volumetric) fire peaked at 1.25 and could not have bloomed at any
 * setting; that was discovered only after the author asked why it did not glow.
 */
export const FLAME_EMISSION_STOPS = Object.freeze([
  Object.freeze({ t: 0.0, v: 0.0 }),
  Object.freeze({ t: 0.12, v: 4.0 }),
  Object.freeze({ t: 0.15, v: 3.2 }),
  Object.freeze({ t: 0.35, v: 2.0 }),
  Object.freeze({ t: 0.55, v: 1.0 }),
  Object.freeze({ t: 0.7, v: 0.35 }),
  Object.freeze({ t: 1.0, v: 0.0 }),
]);

export const FLAME_ALPHA_STOPS = Object.freeze([
  Object.freeze({ t: 0.0, v: 1.0 }),
  Object.freeze({ t: 0.5, v: 0.92 }),
  Object.freeze({ t: 0.7, v: 0.55 }),
  Object.freeze({ t: 1.0, v: 0.85 }),
]);

/** Embers: hot yellow-white → dark red → black. `fire-behaviors.js:449`. */
export const EMBER_COLOR_STOPS = Object.freeze([
  Object.freeze({ t: 0.0, rgb: Object.freeze([1.0, 0.9, 0.5]) }),
  Object.freeze({ t: 0.15, rgb: Object.freeze([1.0, 0.6, 0.1]) }),
  Object.freeze({ t: 0.4, rgb: Object.freeze([0.9, 0.3, 0.02]) }),
  Object.freeze({ t: 0.7, rgb: Object.freeze([0.5, 0.1, 0.01]) }),
  Object.freeze({ t: 1.0, rgb: Object.freeze([0.2, 0.02, 0.0]) }),
]);

export const EMBER_EMISSION_STOPS = Object.freeze([
  Object.freeze({ t: 0.0, v: 0.0 }),
  Object.freeze({ t: 0.12, v: 5.0 }),
  Object.freeze({ t: 0.15, v: 3.5 }),
  Object.freeze({ t: 0.3, v: 1.8 }),
  Object.freeze({ t: 0.6, v: 0.55 }),
  Object.freeze({ t: 1.0, v: 0.0 }),
]);

/**
 * ⚠️ SMOKE IS BORN HOT ORANGE AND COOLS TO GREY WITHIN ~10% OF ITS LIFE, and
 * that single fact is most of why V2's fire read as ONE OBJECT rather than
 * "sprites plus haze". Flame and smoke are separate systems sharing spawn
 * points — there is no particle that transitions between them — so the *only*
 * thing selling "the flame licks up and turns to smoke" is this colour
 * continuity at the handover. Ported from the `smokeColorGradient` param
 * (`FireEffectV2.js:882`), which overrides V2's own built-in COOL/WARM pair.
 */
export const SMOKE_COLOR_STOPS = Object.freeze([
  Object.freeze({ t: 0.0, rgb: Object.freeze([0.9, 0.45, 0.1]) }),
  Object.freeze({ t: 0.1061, rgb: Object.freeze([0.44, 0.38, 0.32]) }),
  Object.freeze({ t: 0.249, rgb: Object.freeze([0.36, 0.34, 0.32]) }),
  Object.freeze({ t: 1.0, rgb: Object.freeze([0.0, 0.0, 0.0]) }),
]);

/**
 * HDR gains. `FIRE_HDR_LINEAR_GAIN` is V2's own 2.75
 * (`fire-behaviors.js:407`), whose comment states the reason plainly:
 * "Scene light is unclamped now; fire vertex RGB must sit above night ambient
 *  to bloom and read as hot flame."
 */
export const FIRE_HDR_LINEAR_GAIN = 2.75;

/**
 * How fast a particle's AGE walks down the reference ramp's TEMPERATURE axis.
 * At 2.5 a sprite is pale-cored for roughly the first 6% of its life, golden
 * through the ignition pop, deep orange by mid-life and rust as it dies — the
 * distribution the reference image shows. Lower it and the fire goes white;
 * raise it and everything is rust.
 */
const AGE_TO_TEMPERATURE = 2.5;

/**
 * The author's reference ramp as ASCENDING stops, which is what
 * {@link piecewiseLinearRgb} needs — `FIRE_RAMP_WOOD` is authored hottest-first.
 */
function referenceFlameStops() {
  return [...FIRE_RAMP_WOOD].map((stop) => ({ t: stop.t, rgb: hexToRgb01(stop.hex) })).sort((a, b) => a.t - b.t);
}
/** Per-layer emission multipliers — the ratio is what makes each layer read. */
/**
 * ⚠️ LOWERED 1.4 → 0.65 BECAUSE OVERLAPPING SPRITES SUM. One sprite at V2's gain
 * peaks near 15 radiance; a dozen overlapping on one hearth summed past 35 under
 * additive blending, and every hue saturates to white long before that. At 0.65
 * a single sprite peaks near 7 — still clear of bloom's 4.0 threshold, so the
 * core still blooms, while a pile of them stays orange instead of going white.
 */
export const FLAME_CORE_EMISSION = 0.5;
/** ⚠️ ~8.6× the flame's. A tiny additive dot only reads as a point SOURCE if it
 * is disproportionately brighter than the mass around it. */
export const EMBER_EMISSION = 12.0;
/**
 * ⚠️ RAISED 0.19 → 0.45. V2's 0.19 assumed ~51 overlapping flame sprites building
 * the mass up between them; this runs about a dozen per fire, so each has to
 * carry more of the silhouette or the archetype shape never reads at all.
 */
export const FLAME_PEAK_OPACITY = 0.45;
export const EMBER_PEAK_OPACITY = 1.0;

/**
 * Blend a temperature control across the three flame gradients, exactly as V2
 * did (`fire-behaviors.js:1219`): below 0.5 walks COLD→STANDARD, above it walks
 * STANDARD→HOT. Pure JS so the resulting stop list can be baked into a TSL ramp
 * once at material-build time rather than evaluated per fragment.
 *
 * @param {number} temperature01 - 0 = coldest, 0.85 = V2's shipped default.
 * @returns {Array<{t:number, rgb:number[]}>} interpolated stops.
 */
export function flameGradientStops(temperature01) {
  const temp = Math.max(0, Math.min(1, Number.isFinite(temperature01) ? temperature01 : 0.85));
  const from = temp <= 0.5 ? FLAME_GRADIENT_COLD : FLAME_GRADIENT_STANDARD;
  const to = temp <= 0.5 ? FLAME_GRADIENT_STANDARD : FLAME_GRADIENT_HOT;
  const k = temp <= 0.5 ? temp / 0.5 : (temp - 0.5) / 0.5;
  return from.map((stop, i) => ({
    t: stop.t,
    rgb: stop.rgb.map((c, ch) => c + (to[i].rgb[ch] - c) * k),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// TSL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A piecewise-LINEAR ramp over `stops`, as a nested mix chain.
 *
 * ⚠️ LINEAR, NOT SMOOTHSTEP, AND THAT MATTERS FOR THE IGNITION POP. V2 built
 * these as 256-entry `Float32Array` LUTs sampled with linear interpolation, so
 * the 0 → 4.0 rise across 12% of life is a straight, hard ramp. Easing it would
 * round off exactly the transient that reads as *catching fire*.
 *
 * @param {*} TSL @param {*} t - a float node in 0..1.
 * @param {Array<{t:number, v:number}>} stops - ascending in `t`.
 * @returns {*} a float node.
 */
export function piecewiseLinear(TSL, t, stops) {
  const { float, clamp } = TSL;
  let out = float(stops[0].v);
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const span = Math.max(1e-5, b.t - a.t);
    const k = clamp(t.sub(float(a.t)).div(float(span)), float(0), float(1));
    out = out.add(k.mul(float(b.v - a.v)));
  }
  return out;
}

/**
 * The same, for colour stops. Same linear reasoning as {@link piecewiseLinear}.
 * @returns {*} a vec3 node.
 */
export function piecewiseLinearRgb(TSL, t, stops) {
  const { vec3, float, clamp } = TSL;
  let out = vec3(...stops[0].rgb);
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const span = Math.max(1e-5, b.t - a.t);
    const k = clamp(t.sub(float(a.t)).div(float(span)), float(0), float(1));
    const d = vec3(b.rgb[0] - a.rgb[0], b.rgb[1] - a.rgb[1], b.rgb[2] - a.rgb[2]);
    out = out.add(d.mul(k));
  }
  return out;
}

/**
 * V2's value noise, ported.
 *
 * ⚠️ VALUE NOISE, NOT THE PERLIN IN `tsl-noise-toolkit.js`, AND THE SUBSTITUTION
 * IS NOT FREE. These archetypes use noise only to warp a domain and to break a
 * ring, at 2 octaves — but value noise and gradient noise have visibly different
 * character at that scale (value noise is blockier and biased toward its cell
 * centres, which is part of why V2's flame edges look hand-drawn rather than
 * organic-smooth). Ported faithfully first; swapping to `fbmFloat` is a look
 * change to be A/B'd, not a cleanup (`feedback_port_faithfully_then_modernize_opportunistically`).
 *
 * Hash is `_hash12` (`FireEffectV2.js:272`) re-expressed with `fract(sin(...))`,
 * which is the standard GPU-side stand-in for an integer bit-mix — the integer
 * ops V2 used are available in TSL but produce a different (equally arbitrary)
 * pattern, and neither is more "correct" than the other.
 */
function valueNoise2(TSL, p) {
  const { vec2, float, floor, fract, dot, sin, mix } = TSL;
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(float(2))));
  const h = (ox, oy) =>
    fract(sin(dot(i.add(vec2(float(ox), float(oy))), vec2(float(127.1), float(311.7)))).mul(float(43758.5453)));
  return mix(mix(h(0, 0), h(1, 0), u.x), mix(h(0, 1), h(1, 1), u.x), u.y);
}

/**
 * V2's `_fbm`: amplitude 0.55, gain 0.55, lacunarity 2, signed to ±.
 * `octaves` is a JS number — build-time, never a uniform (Effects.md Law 4).
 */
function fbm2(TSL, p, octaves = 2) {
  const { float } = TSL;
  let sum = float(0);
  let amp = 0.55;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum = sum.add(
      valueNoise2(TSL, p.mul(float(freq)))
        .sub(float(0.5))
        .mul(float(2 * amp))
    );
    freq *= 2;
    amp *= 0.55;
  }
  return sum;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR ARCHETYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ `phase` REPLACES V2's `animCol / animCols`, AND THAT IS THE UPGRADE.
 * V2 evaluated each shape at eight discrete columns and cross-faded between
 * them; `phase` is the same angle used continuously, so the shape genuinely
 * morphs instead of stepping between eight cached stills.
 *
 * The drift terms are V2's `_fireAtlasAnimDrift` (`FireEffectV2.js:317`) —
 * a circle of radius 1.1 plus a double-frequency epicycle of 0.72, which is what
 * keeps a shape from simply rotating: the noise field it samples travels a
 * closed loop, so the silhouette returns to itself without ever spinning.
 */
function animDrift(TSL, phase) {
  const { cos, sin, float } = TSL;
  return {
    t: phase,
    tX: cos(phase).mul(float(1.1)),
    tY: sin(phase).mul(float(1.1)),
  };
}

/**
 * Shape 0 — PLASMA CORE. V2: *"Smooth, rolling metaball. Warps the domain to
 * simulate a bubbling fluid surface rather than adding spiky noise."*
 *
 * ⚠️ THE CENTRE DIP IS THE TOP-DOWN TELL, and it is the one line that makes
 * this read as fire seen from ABOVE rather than a glowing ball. V2's own words:
 * *"Slight dip in the center to simulate the hollow core of a rising thermal
 * plume."* Looking straight down a column of rising hot gas, the middle is the
 * fastest, thinnest, least luminous part — the brightness is in the shoulders.
 */
function shapePlasmaCore(TSL, nx, ny, phase, seed) {
  const { vec2, float, exp, smoothstep, pow, clamp } = TSL;
  const { tX, tY } = animDrift(TSL, phase);
  const warpX = fbm2(TSL, vec2(nx.mul(float(2.5)).add(tX).add(seed), ny.mul(float(2.5)))).mul(float(0.3));
  const warpY = fbm2(TSL, vec2(nx.mul(float(2.5)), ny.mul(float(2.5)).add(tY).add(seed))).mul(float(0.3));
  const dx = nx.sub(float(0.5)).add(warpX).mul(float(2));
  const dy = ny.sub(float(0.5)).add(warpY).mul(float(2));
  const dist = dx.mul(dx).add(dy.mul(dy)).sqrt();
  const blob = exp(dist.mul(dist).mul(float(-4.5)));
  const centerDip = float(1).sub(smoothstep(float(0), float(0.4), dist));
  const withDip = blob.mul(float(1).sub(centerDip.mul(float(0.35))));
  const edged = withDip.mul(float(1).sub(smoothstep(float(0.85), float(1), dist)));
  return pow(clamp(edged, float(0), float(1)), float(1.2));
}

/**
 * Shape 1 — CONVECTION CRESCENT. V2: *"Simulates cold air pushing into the
 * flame column, creating a sheared 'C' or horseshoe shape."* An outer gaussian
 * minus an OFFSET inner one, so the hollow sits to one side; the whole frame
 * rotates with phase, which is what makes a fire pool look like it is being
 * blown across rather than pulsing in place.
 */
function shapeConvectionCrescent(TSL, nx, ny, phase, seed) {
  const { vec2, float, exp, smoothstep, pow, clamp, cos, sin } = TSL;
  const dx = nx.sub(float(0.5)).mul(float(2));
  const dy = ny.sub(float(0.5)).mul(float(2));
  const rot = phase.add(seed);
  const c = cos(rot);
  const s = sin(rot);
  const rx = dx.mul(c).sub(dy.mul(s));
  const ry = dx.mul(s).add(dy.mul(c));
  const dist = rx.mul(rx).add(ry.mul(ry)).sqrt();
  // The hollow centre, shifted to one side — this offset IS the crescent.
  const hx = rx.sub(float(0.35));
  const hollowDist = hx.mul(hx).add(ry.mul(ry)).sqrt();
  const outer = exp(dist.mul(dist).mul(float(-4.5)));
  const inner = exp(hollowDist.mul(hollowDist).mul(float(-7)));
  // V2: "Add very low-frequency warp so the crescent isn't geometrically perfect"
  const warp = fbm2(TSL, vec2(nx.mul(float(3)).add(phase), ny.mul(float(3)))).mul(float(0.15));
  const a = outer.sub(inner.mul(float(0.85))).add(warp.mul(outer));
  const edged = a.mul(float(1).sub(smoothstep(float(0.9), float(1), dist)));
  return pow(clamp(edged, float(0), float(1)), float(1.4));
}

/**
 * Shape 2 — VORTEX SWIRL. V2: *"Twists the coordinates based on distance from
 * the center, creating an S-curve that mimics a spinning updraft."* The twist
 * grows toward the middle, so the shape shears into itself; the Y-squish turns
 * one blob into two elongated lobes.
 *
 * ⚠️ V2's VERSION IS EXACTLY 2-FOLD SYMMETRIC, AND AT THIS RESOLUTION THAT
 * READS AS A PINWHEEL. Author, seeing it rendered at 1024 px, 2026-08-09:
 * *"the second shape you created is too symmetrical. It's a spiral and might
 * look odd."* Correct, and it is provable rather than a matter of taste: the
 * twist angle depends only on `dist`, so mapping `(dx,dy) → (−dx,−dy)` leaves
 * `dist` unchanged, negates both `tx` and `ty`, and leaves `squishDist`
 * identical. `alpha(p) == alpha(−p)` for every pixel. The only thing breaking
 * it in V2 was the small additive wisp term — enough at a blurry 64 px atlas
 * cell stretched across a sprite, not enough at real resolution.
 *
 * Two fixes, both borrowed from this shape's own siblings rather than invented:
 *   1. A low-frequency domain warp BEFORE the twist — the same trick V2 itself
 *      applies to the Convection Crescent, with its own stated reason: *"Add
 *      very low-frequency warp so the crescent isn't geometrically perfect."*
 *   2. A noise-modulated lobe width sampled at the TWISTED coordinate. Because
 *      `fbm(p) ≠ fbm(−p)`, this breaks the point symmetry directly, so the two
 *      arms differ in thickness instead of being mirror twins.
 * The spinning-updraft character is untouched; only its perfection is.
 */
function shapeVortexSwirl(TSL, nx, ny, phase, seed) {
  const { vec2, float, exp, smoothstep, pow, clamp, cos, sin } = TSL;
  const { tX, tY } = animDrift(TSL, phase);
  // 1. Break the perfect circle the twist is built on.
  const warpX = fbm2(TSL, vec2(nx.mul(float(2.2)).add(tX).add(seed), ny.mul(float(2.2)))).mul(float(0.22));
  const warpY = fbm2(TSL, vec2(nx.mul(float(2.2)), ny.mul(float(2.2)).add(tY).add(seed))).mul(float(0.22));
  const dx = nx.sub(float(0.5)).add(warpX).mul(float(2));
  const dy = ny.sub(float(0.5)).add(warpY).mul(float(2));
  const dist = dx.mul(dx).add(dy.mul(dy)).sqrt();
  const twist = float(1)
    .sub(dist)
    .mul(float(3.5))
    .sub(phase.mul(float(1.5)))
    .add(seed);
  const c = cos(twist);
  const s = sin(twist);
  const tx = dx.mul(c).sub(dy.mul(s));
  const ty = dx.mul(s).add(dy.mul(c));
  const tyS = ty.mul(float(2.2));
  const squishDist = tx.mul(tx).add(tyS.mul(tyS)).sqrt();
  // 2. Unequal arms. Sampled at the twisted coordinate so it cannot be
  // centrally symmetric; widens one arm and pinches the other.
  const lobeBias = float(1).add(fbm2(TSL, vec2(tx.mul(float(1.6)), ty.mul(float(1.6)).add(phase))).mul(float(0.55)));
  const core = exp(squishDist.mul(squishDist).mul(float(-5)).mul(lobeBias));
  // V2: "Add small detached wisps orbiting the main swirl"
  const wispN = fbm2(TSL, vec2(nx.mul(float(5)), ny.mul(float(5)).add(phase)));
  const wisps = smoothstep(float(0.55), float(0.78), wispN)
    .mul(exp(dist.mul(dist).mul(float(-3))))
    .mul(float(0.5));
  const a = core.add(wisps);
  const edged = a.mul(float(1).sub(smoothstep(float(0.8), float(1), dist)));
  return pow(clamp(edged, float(0), float(1)), float(1.3));
}

/**
 * Shape 3 — THERMAL RING. V2: *"A hollow, expanding heat mushroom viewed from
 * the top."* A gaussian centred on a wobbling RIM rather than on the middle,
 * then deliberately broken: *"Use noise to 'break' the ring so it forms
 * disconnected arcs rather than a full circle"*, with *"a faint central core so
 * the middle isn't entirely black"*. The most explicitly bird's-eye of the four.
 */
function shapeThermalRing(TSL, nx, ny, phase, seed) {
  const { vec2, float, exp, smoothstep, pow, clamp, abs } = TSL;
  const { tX, tY } = animDrift(TSL, phase);
  const warpX = fbm2(TSL, vec2(nx.mul(float(3)).sub(tY), ny.mul(float(3)).add(tX).add(seed))).mul(float(0.25));
  const warpY = fbm2(TSL, vec2(nx.mul(float(3)).add(tX).add(seed), ny.mul(float(3)).sub(tY))).mul(float(0.25));
  const dx = nx.sub(float(0.5)).add(warpX).mul(float(2));
  const dy = ny.sub(float(0.5)).add(warpY).mul(float(2));
  const dist = dx.mul(dx).add(dy.mul(dy)).sqrt();
  const ringRadius = float(0.4).add(fbm2(TSL, vec2(nx.mul(float(3.5)), ny.mul(float(3.5)))).mul(float(0.15)));
  const ringDist = abs(dist.sub(ringRadius));
  const rim = exp(ringDist.mul(ringDist).mul(float(-18)));
  const breakMask = fbm2(TSL, vec2(nx.mul(float(4)).add(tX), ny.mul(float(4)).add(tY)));
  const broken = rim.mul(smoothstep(float(0.2), float(0.5), breakMask.add(float(0.15))));
  const withCore = broken.add(exp(dist.mul(dist).mul(float(-12))).mul(float(0.4)));
  const edged = withCore.mul(float(1).sub(smoothstep(float(0.85), float(1), dist)));
  return pow(clamp(edged, float(0), float(1)), float(1.2));
}

/** Archetype ids, in V2's own dispatch order (`FireEffectV2.js:451`). */
export const FLAME_ARCHETYPES = Object.freeze(['plasmaCore', 'convectionCrescent', 'vortexSwirl', 'thermalRing']);

/**
 * Evaluate ONE archetype, selected at BUILD TIME.
 *
 * ⚠️ BUILD-TIME SELECTION, NOT A RUNTIME BRANCH — Effects.md Law 4. Passing the
 * archetype as a uniform would compile all four shapes into every sprite and
 * evaluate at least one of them per fragment for no benefit. A particle's
 * archetype never changes during its life, so the choice belongs to the caller
 * and, where a system wants variety, to four cheap variants of one material.
 *
 * @param {*} TSL
 * @param {object} args
 * @param {*} args.nx @param {*} args.ny - local sprite coords, 0..1 floats.
 * @param {*} args.phase - the continuous animation angle (radians).
 * @param {*} args.seed - a per-particle constant, decorrelates neighbours.
 * @param {string} args.archetype - one of {@link FLAME_ARCHETYPES}.
 * @returns {*} a float node in 0..1 — the sprite's alpha.
 */
export function buildFlameShapeAlpha(TSL, { nx, ny, phase, seed, archetype = 'plasmaCore' }) {
  switch (archetype) {
    case 'convectionCrescent':
      return shapeConvectionCrescent(TSL, nx, ny, phase, seed);
    case 'vortexSwirl':
      return shapeVortexSwirl(TSL, nx, ny, phase, seed);
    case 'thermalRing':
      return shapeThermalRing(TSL, nx, ny, phase, seed);
    case 'plasmaCore':
    default:
      return shapePlasmaCore(TSL, nx, ny, phase, seed);
  }
}

/**
 * The flame's emissive colour at normalized age `t01`, ready for an ADDITIVE
 * draw. Colour × emission, unclamped — the HDR path that reaches bloom.
 *
 * @param {*} TSL @param {object} args
 * @param {*} args.t01 - normalized age, 0 = newborn.
 * @param {*} args.heat - per-particle `0.7 + rand*0.5` (V2's `_flameHeat`).
 * @param {*} args.brightness - the painted mask's value where this spawned.
 * @param {number} [args.temperature=0.85] - blends the three gradients.
 * @param {number} [args.hdrGain=FIRE_HDR_LINEAR_GAIN]
 * @returns {{rgb:*, alpha:*}} both nodes.
 */
export function buildFlameShading(
  TSL,
  { t01, heat, brightness, ageToTemperature = null, hdrGain = FIRE_HDR_LINEAR_GAIN }
) {
  const { float, clamp } = TSL;
  // ⚠️ THE AUTHOR'S OWN REFERENCE RAMP, NOT V2's, AND NOT INDEXED BY AGE.
  // Author, 2026-08-09: *"Flames aren't visible yet at all and I maxed out the
  // intensity... Flame brightness effects just a white blur... the same shades
  // of orange I described earlier."* Two causes, one fix:
  //   1. V2's gradient at `fireTemperature 0.85` sits 70% of the way to its HOT
  //      table, whose newborn stop is (1.0, 0.95, 0.85) — ESSENTIALLY WHITE. And
  //      emission peaks at that same instant (the 0→4.0 ignition pop), so the
  //      brightest moment of every particle was also its least saturated.
  //      Raising brightness pushed MORE of the life into saturation — exactly
  //      "a white blur", and no amount of the control could have fixed it.
  //   2. It was the wrong palette regardless. `FIRE_RAMP_WOOD` is sampled from
  //      the author's OWN reference image (#FFE9A8 pale core, #FDBA35 golden,
  //      #F79420 orange, #E06A08 rust rim) and IS "the shades of orange I
  //      described earlier".
  // That ramp is indexed by TEMPERATURE (1 = pale core, 0.1 = rust), so age is
  // mapped onto it steeply on purpose: pale for only the first few percent of
  // life, then golden through the pop and orange for the bulk of it.
  // `ageToTemperature` is a live uniform when the author is tuning; the constant
  // is the shipped default.
  const ageRate = ageToTemperature ?? float(AGE_TO_TEMPERATURE);
  const temp = clamp(float(1).sub(t01.mul(ageRate)), float(0.08), float(1));
  const rgb = piecewiseLinearRgb(TSL, temp, referenceFlameStops());
  const emission = piecewiseLinear(TSL, t01, FLAME_EMISSION_STOPS)
    .mul(float(FLAME_CORE_EMISSION * hdrGain))
    .mul(heat)
    .mul(brightness);
  const alpha = piecewiseLinear(TSL, t01, FLAME_ALPHA_STOPS).mul(float(FLAME_PEAK_OPACITY)).mul(brightness);
  return { rgb: rgb.mul(emission), alpha };
}

/**
 * V2's spawn/death fade envelope (`particleSpawnDeathFade`) — a smoothstep in
 * and a smoothstep out, so a sprite never pops into or out of existence. Flame
 * uses (0.14, 0.16); ember (0.16, 0.20).
 *
 * @returns {*} a float node in 0..1.
 */
export function buildLifeFade(TSL, t01, fadeIn = 0.14, fadeOut = 0.16) {
  const { float, smoothstep, min } = TSL;
  const rise = smoothstep(float(0), float(Math.max(1e-4, fadeIn)), t01);
  const fall = smoothstep(float(0), float(Math.max(1e-4, fadeOut)), float(1).sub(t01));
  return min(rise, fall);
}
