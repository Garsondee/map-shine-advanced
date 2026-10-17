/**
 * FIREFLY BODY — the light, the beetle, and the clock that drives the light.
 *
 * Pure TSL node-builders, no allocation, no state. Three pieces:
 *
 *   • {@link buildFlash} — a flash PATTERN as a function of the insect's phase.
 *   • {@link buildGlow} — the emissive halo (and, at the top rung, the afterglow
 *     streak behind a flying firefly), in HDR.
 *   • {@link buildBeetle} — the dark body: wing cases, an orange shield, a lantern.
 *
 * ============================================================================
 * WHY THE GLOW IS HDR, AND ADDED
 * ============================================================================
 *
 * A firefly's light is the brightest thing in a dark scene by a wide margin. An 8-bit
 * 0..1 pixel cannot say "this is fifty times brighter than the grass", so the glow is
 * written into the scene's HDR target as values ABOVE 1 (`intensity` ≈ 5 at the core)
 * and ADDED to what is already there. The bloom pass then does the physically right
 * thing with the excess: it bleeds it into the dark around it, which is the entire
 * look of a firefly — a small point with a soft cloud — and it costs this file
 * nothing, because the glow does not draw its own cloud, it just exceeds 1 and lets
 * the post chain spread it.
 *
 * ============================================================================
 * THE AFTERGLOW IS FREE BECAUSE THE FLASH IS A FUNCTION
 * ============================================================================
 *
 * A long exposure of a firefly shows a streak that is bright where it flashed and
 * dark where it did not. A renderer that wanted that would keep a path history per
 * insect. This one does not need to: the flash is a closed-form function of phase,
 * and the phase a moment ago is just `φ − Δ`. So the streak behind the insect is the
 * glow stretched along its own velocity, with the brightness at each point along it
 * looked up with the phase from the moment the insect was there. No history buffer,
 * no extra storage binding (the arena has none to spare), exact by construction.
 *
 * ⚠️ EVERY TIER FLAG IS A JS `if` THAT DECIDES WHICH NODES ARE BUILT.
 *
 * @module effects/critters/firefly-body
 */
import { coverage, stroke, sdEllipse, rotate2, layer, over } from './critter-sdf.js';

const TAU = Math.PI * 2;

/** Seconds of flight path the afterglow shows. */
export const TRAIL_SECONDS = 0.9;

/**
 * How many separate light events one flash CYCLE holds, per style (`FIREFLY_FLASH_STYLES` order of keys):
 * a swell, a single blink, the pair of a double flash, the two shimmers riding a steady glow. Multiplied by
 * the fastest cycle rate the clock allows (`FIREFLY_SYNC`), this is the photosensitivity ceiling —
 * a Node test holds it under three a second, and {@link buildFlash} reads the shimmer count from here so
 * the table and the pattern cannot disagree.
 */
export const FLASH_EVENTS_PER_CYCLE = Object.freeze({ breathe: 1, blink: 1, double: 2, steady: 2 });

/**
 * The flash pattern: brightness 0..1 for a phase in cycles.
 *
 * `styleIndex` follows `FIREFLY_FLASH_STYLES`: 0 breathe, 1 blink, 2 double, 3 steady. All four are
 * computed and one is selected — a style is a value, not a shader variant, so changing it never
 * rebuilds anything. Distances between phases are PERIODIC (`fract(φ − c + ½) − ½`), so a flash
 * near the end of the cycle does not clip at the wrap.
 *
 * @param {*} TSL @param {object} a
 * @param {*} a.phase - float node, cycles (any real; it is wrapped).
 * @param {*} a.styleIndex - float node.
 * @returns {*} float node 0..1
 */
export function buildFlash(TSL, { phase, styleIndex }) {
  const { float, fract, exp, cos, sin, pow, select, max } = TSL;
  const near = (c) => fract(phase.sub(c).add(0.5)).sub(0.5);
  const bump = (c, w) => {
    const d = near(c).div(w);
    return exp(d.mul(d).negate());
  };
  // `max(…, 0)`: cos can come back a hair over 1 from hardware, and a negative base under a fractional power is NaN
  const breathe = pow(max(float(0.5).sub(cos(phase.mul(TAU)).mul(0.5)), 0), 1.4)
    .mul(0.96)
    .add(0.04);
  const blink = bump(0.1, 0.05).add(0.03);
  const double = bump(0.07, 0.035).add(bump(0.25, 0.035).mul(0.9)).add(0.03);
  // few enough shimmers a cycle that, at the period floor with the coupling's worst pull, they stay under 3 a second
  const steady = float(0.8).add(sin(phase.mul(TAU * FLASH_EVENTS_PER_CYCLE.steady).add(1.7)).mul(0.2));
  return max(
    select(
      styleIndex.lessThan(0.5),
      breathe,
      select(styleIndex.lessThan(1.5), blink, select(styleIndex.lessThan(2.5), double, steady))
    ),
    0
  );
}

/**
 * The emissive halo at this pixel, and the streak behind a flying firefly.
 *
 * @param {*} TSL @param {object} a
 * @param {*} a.q - vec2 node: this pixel in px, in the insect's heading frame (+x forward).
 * @param {*} a.radius - float node: the glow radius in px.
 * @param {*} a.flash - float node 0..1: the flash now.
 * @param {*} a.color - vec3 node: LINEAR glow colour.
 * @param {*} a.intensity - float node: HDR peak.
 * @param {object} a.plan
 * @param {object} [a.trail] - `{length, phase, dPhase, styleIndex}` (nodes) when `plan.trail`.
 * @returns {*} vec3 node: linear HDR radiance to ADD.
 */
export function buildGlow(TSL, { q, radius, flash, color, intensity, plan, trail = null }) {
  const { float, vec2, vec3, exp, length, smoothstep, clamp, mix, max } = TSL;
  const r = length(q).div(radius);
  const core = exp(r.div(0.14).mul(r.div(0.14)).negate());
  const halo = exp(r.div(0.55).mul(r.div(0.55)).negate());
  const window = float(1).sub(smoothstep(float(0.9), float(1.25), r));
  let level = flash.mul(core.add(halo.mul(0.32))).mul(window);

  if (plan.trail && trail) {
    // distance to the streak: a segment from the insect back along −x
    const len = max(trail.length, 1e-3);
    const s = clamp(q.x.negate().div(len), 0, 1);
    const onAxis = vec2(q.x.add(s.mul(len)), q.y);
    const width = radius.mul(0.26).mul(float(1).sub(s.mul(0.6)));
    const across = length(onAxis).div(max(width, 1e-3));
    const there = buildFlash(TSL, { phase: trail.phase.sub(s.mul(trail.dPhase)), styleIndex: trail.styleIndex });
    // Only BEHIND the insect (the halo already covers its front), and only once it is actually
    // moving: a resting firefly has no length, and without this fade the formula degenerates
    // into a bright half-disc ahead of it.
    const behind = float(1).sub(smoothstep(float(0), radius.mul(0.12), q.x));
    const moving = clamp(trail.length.div(radius.mul(0.4)), 0, 1);
    const streak = exp(across.mul(across).negate())
      .mul(there)
      .mul(float(1).sub(s).mul(float(1).sub(s)))
      .mul(behind)
      .mul(moving)
      .mul(0.55);
    level = max(level, streak);
  }

  const hot = mix(color, vec3(1.0, 0.97, 0.78), core.mul(0.55));
  return hot.mul(level).mul(intensity);
}

/**
 * The dark beetle, top-down, +x toward the head. Straight sRGB albedo + alpha, with the
 * lantern's emission returned separately (it is added AFTER lighting, never multiplied by it).
 *
 * @param {*} TSL @param {object} a
 * @param {*} a.p - vec2 node: this pixel in body lengths. @param {*} a.aa - one pixel in body lengths.
 * @param {*} a.flash - float 0..1 (already softened if resting).
 * @param {*} a.glowColor - vec3 node (sRGB) for the lantern.
 * @param {*} a.flying - float 0..1: wings out.
 * @param {*} a.lightLocal - vec2 node: unit light direction in body space.
 * @param {object} a.plan
 * @returns {{rgb: *, alpha: *, emissive: *}} emissive is a LINEAR vec3 scale to multiply by the glow colour.
 */
export function buildBeetle(TSL, { p, aa, flash, glowColor, flying, lightLocal, plan }) {
  const { float, vec2, vec3, max, mix, dot, sqrt, normalize } = TSL;
  const L3 = normalize(vec3(lightLocal.x.mul(0.6), lightLocal.y.mul(0.6), float(0.75)));
  const dome = (q, ab) => {
    const n2 = q.div(ab);
    const nz = sqrt(max(float(1).sub(dot(n2, n2)), 0));
    return float(0.35).add(max(dot(vec3(n2.x, n2.y, nz), L3), 0).mul(0.75));
  };
  const absP = vec2(p.x, p.y.abs());

  const ELY_C = vec2(-0.1, 0);
  const ELY_AB = vec2(0.37, 0.19);
  const PRO_C = vec2(0.27, 0);
  const PRO_AB = vec2(0.15, 0.16);
  const HEAD_C = vec2(0.43, 0);
  const HEAD_AB = vec2(0.07, 0.085);
  const LAN_C = vec2(-0.5, 0);
  const LAN_AB = vec2(0.1, 0.125);

  const qEly = p.sub(ELY_C);
  const dEly = sdEllipse(TSL, qEly, ELY_AB);
  const qPro = p.sub(PRO_C);
  const dPro = sdEllipse(TSL, qPro, PRO_AB);
  const dHead = sdEllipse(TSL, p.sub(HEAD_C), HEAD_AB);
  const qLan = p.sub(LAN_C);
  const dLan = sdEllipse(TSL, qLan, LAN_AB);

  let stack = { c: vec3(0, 0, 0), a: float(0) };

  if (plan.lit) {
    // legs: a thin dark pair per segment, splayed
    const leg = (x0, x1, y1) => {
      const a = vec2(x0, 0.1);
      const b = vec2(x1, y1);
      const pa = absP.sub(a);
      const ba = b.sub(a);
      const h = pa
        .dot(ba)
        .div(max(ba.dot(ba), 1e-6))
        .clamp(0, 1);
      return stroke(TSL, pa.sub(ba.mul(h)).length(), 0.012, aa);
    };
    const legs = max(leg(0.22, 0.34, 0.3), max(leg(0.0, 0.04, 0.34), leg(-0.2, -0.3, 0.32)));
    stack = over(TSL, layer(TSL, vec3(0.05, 0.04, 0.03), legs.mul(0.9)), stack);
  }

  // when flying, hindwings show past the wing cases
  const wingA = flying.mul(0.2);
  const wingP = vec2(p.x.add(0.28), p.y.abs());
  const wingD = sdEllipse(TSL, rotate2(TSL, wingP.sub(vec2(0.0, 0.2)), float(-0.9)), vec2(0.42, 0.075));
  stack = over(TSL, layer(TSL, vec3(0.75, 0.78, 0.8), coverage(TSL, wingD, aa).mul(wingA)), stack);

  // the lantern: the pale tip of the abdomen, UNDER the wing cases and showing past them, warming to the glow colour as it fires
  const lanCover = coverage(TSL, dLan, aa);
  const lanRgb = mix(vec3(0.55, 0.52, 0.28), glowColor, flash.clamp(0, 1)).mul(dome(qLan, LAN_AB).mul(0.5).add(0.5));
  stack = over(TSL, layer(TSL, lanRgb, lanCover), stack);

  const elyRgb = mix(vec3(0.09, 0.07, 0.05), vec3(0.2, 0.15, 0.1), float(1).sub(dome(qEly, ELY_AB))).mul(
    dome(qEly, ELY_AB)
  );
  stack = over(TSL, layer(TSL, elyRgb, coverage(TSL, dEly, aa)), stack);
  const proRgb = vec3(0.62, 0.24, 0.09).mul(dome(qPro, PRO_AB));
  stack = over(TSL, layer(TSL, proRgb, coverage(TSL, dPro, aa)), stack);
  const proSpot = coverage(TSL, sdEllipse(TSL, qPro, vec2(0.075, 0.07)), aa);
  stack = over(TSL, layer(TSL, vec3(0.06, 0.04, 0.03), proSpot.mul(0.85)), stack);
  stack = over(TSL, layer(TSL, vec3(0.05, 0.04, 0.03), coverage(TSL, dHead, aa)), stack);

  const alpha = stack.a;
  return {
    rgb: stack.c.div(max(alpha, 1e-5)),
    alpha,
    // the wing cases hide the part of the lantern they cover, and with it that part's emission
    emissive: lanCover.mul(float(1).sub(coverage(TSL, dEly, aa))).mul(flash),
  };
}
