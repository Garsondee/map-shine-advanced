/**
 * FLY BODY — a fly drawn from nothing but arithmetic: the pixels of one fly,
 * given its POSE (`fly-pose.js`) and where this pixel sits relative to it.
 *
 * Pure TSL node-builders (THREE injected via `TSL`), no allocation, no state. The
 * caller hands in a position `p` in BODY-LENGTH UNITS — origin at the thorax,
 * +x toward the head, +y to the fly's left — and gets back a straight sRGB colour
 * and an alpha. Everything is a signed-distance primitive (`critter-sdf.js`)
 * stacked back-to-front: legs, abdomen, thorax, head, eyes, wings.
 *
 * ============================================================================
 * THE THREE PIECES OF ANIMATION THAT MAKE IT READ AS A FLY
 * ============================================================================
 *
 * 1. THE WING BEAT IS INTEGRATED, NOT SAMPLED. A fly beats its wings at ~200 Hz;
 *    a 60 Hz screen sees roughly three beats per frame. Drawing the wing at "the
 *    current angle" would strobe at random. What the eye (and a camera with an
 *    exposure) really sees is the TIME AVERAGE of the wing over a frame: a
 *    translucent fan, densest at the two ends of the stroke, where the wing turns
 *    round and lingers. For a sinusoidal beat ψ(t) = ψ₀ + A·sin(φ), the wing
 *    covers a point at angular offset Δ from its mean direction for exactly the
 *    fraction of the cycle where |Δ + A·sin φ| < hw, which has a CLOSED FORM:
 *
 *        (asin((hw − Δ)/A) − asin((−hw − Δ)/A)) / π      (the arcsine law)
 *
 *    — two `asin`s per pixel, no loop, no jitter, and the dense rim falls out of
 *    the maths. `wingBlur` crossfades that fan into a crisp wing at the beat's
 *    instantaneous angle for the slow flaps of take-off and landing.
 *
 * 2. THE FEET ARE PLANTED. A walking insect moves three legs at once — a TRIPOD
 *    (front-left, middle-right, hind-left, then the other three). A leg's foot is
 *    either in STANCE (on the ground, fixed in the world, so sliding BACKWARD
 *    along the body at exactly the body's speed) or in SWING (lifted and thrown
 *    forward). The gait phase advances with DISTANCE travelled, not time
 *    (`custom.z` in the brain), and a stance foot's body-frame x runs
 *    +S → −S as the phase goes 0 → β: at any speed the stance feet do not slide,
 *    the thing that makes a cartoon walk look like ice-skating when it is wrong.
 *    Each leg is then a two-bone chain solved from hip to foot (the knee is the
 *    intersection of two circles — closed form, no iteration).
 *
 * 3. HEIGHT IS READ FROM THE SHADOW. A top-down orthographic camera has no
 *    parallax to say "this one is in the air"; the shadow does (`buildFlyShadow`).
 *
 * ⚠️ EVERY TIER FLAG IS A JS `if` THAT DECIDES WHICH NODES ARE BUILT
 * (`tsl/no-uniform-gates`): `plan.legs === false` constructs no leg nodes at all,
 * rather than running them at zero.
 *
 * @module effects/critters/fly-body
 */
import {
  coverage,
  stroke,
  sdCapsule,
  sdEllipse,
  wrapAngle,
  safeAtan2,
  emptyLayer,
  layer,
  over,
} from './critter-sdf.js';

const PI = Math.PI;

/** The brightest un-premultiplied channel the body may emit (a wet catch-light is ~2; see the end of `buildFlyBody`). */
const RGB_CEILING = 4;

// ── Geometry, in body lengths. Head at +x. Hips, resting feet and segment lengths
// are listed front → middle → hind, for the LEFT side (+y); the right side mirrors.
const HIP = [
  [0.215, 0.085],
  [0.105, 0.122],
  [-0.015, 0.118],
];
const REST_FOOT = [
  [0.345, 0.285],
  [0.135, 0.345],
  [-0.205, 0.335],
];
const SEGMENTS = [
  [0.175, 0.175],
  [0.19, 0.2],
  [0.215, 0.225],
];
const STRIDE_AMPLITUDE = [0.085, 0.1, 0.115];
/** Tie-break for which way the knee bows when the foot is straight out: front legs forward, hind back. */
const KNEE_FORWARD_BIAS = [0.6, 0, -0.6];
const STANCE_DUTY = 0.62;

const WING_HINGE = [0.15, 0.092];
const WING_LENGTH = 0.8;
const WING_WIDTH = 0.23;

/**
 * Species palettes in sRGB (the way the eye thinks of a colour). `metal` makes a
 * species glossy; `stripes`/`checker`/`sides` switch on its surface pattern.
 */
const PALETTES = [
  {
    // housefly
    thorax: [0.3, 0.29, 0.26],
    abdomen: [0.4, 0.36, 0.27],
    side: [0.6, 0.5, 0.26],
    ink: [0.06, 0.06, 0.06],
    sheen: [0.0, 0.0, 0.0],
    metal: 0,
    stripes: 1,
    checker: 0,
    sides: 1,
  },
  {
    // bluebottle
    thorax: [0.05, 0.09, 0.17],
    abdomen: [0.05, 0.14, 0.34],
    side: [0.05, 0.14, 0.34],
    ink: [0.02, 0.04, 0.09],
    sheen: [0.3, 0.5, 0.78],
    metal: 1,
    stripes: 0,
    checker: 0,
    sides: 0,
  },
  {
    // greenbottle
    thorax: [0.05, 0.17, 0.08],
    abdomen: [0.06, 0.3, 0.11],
    side: [0.06, 0.3, 0.11],
    ink: [0.02, 0.08, 0.04],
    sheen: [0.55, 0.85, 0.35],
    metal: 1,
    stripes: 0,
    checker: 0,
    sides: 0,
  },
  {
    // flesh fly
    thorax: [0.33, 0.33, 0.32],
    abdomen: [0.5, 0.5, 0.48],
    side: [0.5, 0.5, 0.48],
    ink: [0.08, 0.08, 0.08],
    sheen: [0.0, 0.0, 0.0],
    metal: 0,
    stripes: 1,
    checker: 1,
    sides: 0,
  },
];

/**
 * @param {*} TSL
 * @param {object} a
 * @param {*} a.p - vec2 node: this pixel in body lengths, +x toward the head.
 * @param {*} a.aa - float node: one pixel in body lengths (> 0).
 * @param {object} a.pose - nodes from `buildFlyPose`.
 * @param {*} a.gait - walking gait phase in CYCLES (float node).
 * @param {*} a.seed01 - per-fly random 0..1 (float node).
 * @param {*} a.lightLocal - vec2 node: unit light direction in body space.
 * @param {*} a.tint - vec3 node multiplying body colour (white = none).
 * @param {object} a.plan - `critterTierPlan('fly', n)`.
 * @param {*} a.lookIndex - float node: 0 mixed (rolled per fly from `seed01`), 1..4 housefly /
 *   bluebottle / greenbottle / fleshfly. A UNIFORM, not a build-time constant: the palettes are
 *   blended arithmetically either way, so changing species costs nothing and rebuilds nothing.
 * @returns {{rgb: *, alpha: *}} straight sRGB-space colour and alpha.
 */
export function buildFlyBody(
  TSL,
  {
    p,
    aa,
    pose,
    gait,
    seed01,
    lightLocal,
    tint,
    plan,
    lookIndex,
    wingOpacity = null,
    sheen = null,
    legWeight = null,
    eyeColor = null,
  }
) {
  const {
    float,
    vec2,
    vec3,
    abs,
    max,
    min,
    mix,
    smoothstep,
    sin,
    sqrt,
    atan,
    asin,
    clamp,
    length,
    dot,
    normalize,
    pow,
    fract,
    floor,
    select,
  } = TSL;
  const k = (a, b, x) => smoothstep(float(a), float(b), x);
  const px = p.x;
  const py = p.y;
  const absY = abs(py);
  // The author's look multipliers, each 1 (the look as drawn) when the caller supplies none — the shadow, the
  // pose gallery and the lab all build this body without a uniform bank.
  const wingOp = wingOpacity ?? float(1);
  const sheenAmt = sheen ?? float(1);
  const legW = legWeight ?? float(1);

  // ── Species weights: one-hot over the four palettes, from the `species` param or, for 'mixed', a roll of the seed ──
  const isMixed = lookIndex.lessThan(0.5);
  const rolled = floor(clamp(seed01, 0, 0.9999).mul(4));
  const weights = [0, 1, 2, 3].map((i) =>
    select(
      isMixed,
      select(abs(rolled.sub(i)).lessThan(0.5), float(1), float(0)),
      select(abs(lookIndex.sub(i + 1)).lessThan(0.5), float(1), float(0))
    )
  );
  const blend = (key) => {
    let acc = vec3(0, 0, 0);
    PALETTES.forEach((pal, i) => {
      acc = acc.add(vec3(...pal[key]).mul(weights[i]));
    });
    return acc;
  };
  const scalar = (key) => {
    let acc = float(0);
    PALETTES.forEach((pal, i) => {
      acc = acc.add(weights[i].mul(pal[key]));
    });
    return acc;
  };
  const thoraxBase = blend('thorax');
  const abdomenBase = blend('abdomen');
  const sideCol = blend('side');
  const inkCol = blend('ink');
  const sheenCol = blend('sheen');
  const metalW = scalar('metal');
  const stripeW = scalar('stripes');
  const checkerW = scalar('checker');
  const sideW = scalar('sides');

  // ── Lighting of the dome-shaped parts ──
  const L3 = normalize(vec3(lightLocal.x.mul(0.6), lightLocal.y.mul(0.6), float(0.75)));
  const H3 = normalize(L3.add(vec3(0, 0, 1)));
  /**
   * Shade of an ellipsoid-ish part: a hemispherical normal from the ellipse's own coordinates.
   *
   * The normal is only meaningful INSIDE the ellipse (|n2| ≤ 1). Outside it `nz` is 0 and |n2| keeps growing
   * with distance, and the anti-aliasing ramp reaches that far when the fly is small on screen (the ramp is
   * ±1 px, so a 3 px fly has a ramp the size of the whole body). A specular power of 36 on a "normal" five
   * units long is 10^25 — multiplied by a coverage that is merely small, and then divided back up by the
   * layer stack's `/ alpha`, it lands in the HDR buffer (and in bloom) as Inf. Folding the vector back onto
   * the unit disc makes the fringe shade like the rim, which is what the eye expects there anyway.
   */
  const dome = (q, ab) => {
    const nRaw = q.div(ab);
    const n2 = nRaw.div(max(length(nRaw), 1));
    const r2 = dot(n2, n2);
    const nz = sqrt(max(float(1).sub(r2), 0));
    const n = vec3(n2.x, n2.y, nz);
    const diff = max(dot(n, L3), 0);
    const spec = pow(max(dot(n, H3), 0), 36);
    // a wide, soft sheen for lacquered (metallic) bodies — a tight highlight on a blowfly's back reads as an LED
    const gloss = pow(max(dot(n, H3), 0), 7);
    return {
      shade: float(0.28).add(diff.mul(0.82)),
      spec,
      gloss,
      rim: smoothstep(float(0.55), float(1.0), sqrt(r2)),
    };
  };

  // ── Body parts ──
  const ABD_C = vec2(-0.235, 0);
  const ABD_AB = vec2(0.265, 0.172);
  const THO_C = vec2(0.115, 0);
  const THO_AB = vec2(0.2, 0.15);
  const HEAD_C = vec2(0.385, 0);
  const HEAD_AB = vec2(0.086, 0.115);
  const EYE_C = vec2(0.388, 0.079);
  const EYE_AB = vec2(0.062, 0.068);

  // abdomen tapers toward the tail: squeeze y as x runs aft
  const taper = float(1).sub(clamp(float(-0.235).sub(px).div(0.265), 0, 1).mul(0.24));
  const qAbd = vec2(px.sub(ABD_C.x), py.div(taper));
  const dAbd = sdEllipse(TSL, qAbd, ABD_AB).mul(taper);
  const qTho = p.sub(THO_C);
  const dTho = sdEllipse(TSL, qTho, THO_AB);
  const qHead = p.sub(HEAD_C);
  const dHead = sdEllipse(TSL, qHead, HEAD_AB);
  const pMirror = vec2(px, absY);
  const qEye = pMirror.sub(EYE_C);
  const dEye = sdEllipse(TSL, qEye, EYE_AB);

  const abdShade = dome(qAbd, ABD_AB);
  const thoShade = dome(qTho, THO_AB);
  const headShade = dome(qHead, HEAD_AB);
  const eyeShade = dome(qEye, EYE_AB);

  // surface patterns
  const abdU = px.sub(ABD_C.x);
  const segLine = float(1).sub(k(0.0, 0.07, min(fract(abdU.mul(4.6)), float(1).sub(fract(abdU.mul(4.6))))));
  const midline = float(1).sub(k(0.008, 0.03, absY));
  const sidePatch = k(0.075, 0.15, absY);
  const parity = fract(
    floor(abdU.mul(7))
      .add(floor(absY.mul(10)))
      .mul(0.5)
  ).mul(2); // 0 or 1
  const stripeAt = (c) => float(1).sub(k(0.007, 0.02, abs(absY.sub(c))));
  const thoStripes = max(stripeAt(0.045), stripeAt(0.108));

  // abdomen colour
  let abdColour = abdomenBase;
  abdColour = mix(abdColour, sideCol, sidePatch.mul(sideW).mul(0.75));
  abdColour = mix(abdColour, abdomenBase.mul(0.38), parity.mul(checkerW).mul(0.8));
  abdColour = mix(abdColour, inkCol, midline.mul(stripeW).mul(float(1).sub(checkerW)).mul(0.7));
  abdColour = mix(abdColour, inkCol, segLine.mul(float(0.3).add(stripeW.mul(0.15))));
  const abdSheen = plan.sheen
    ? sheenCol
        .mul(abdShade.gloss.mul(0.55).add(abdShade.spec.mul(0.35)))
        .mul(metalW)
        .mul(sheenAmt)
    : vec3(0, 0, 0);
  const abdRgb = abdColour
    .mul(abdShade.shade)
    .mul(float(1).sub(abdShade.rim.mul(0.4)))
    .add(abdSheen);

  // thorax colour
  const thoColour = mix(thoraxBase, inkCol, thoStripes.mul(stripeW).mul(0.8));
  const thoSheen = plan.sheen
    ? sheenCol
        .mul(thoShade.gloss.mul(0.5).add(thoShade.spec.mul(0.3)))
        .mul(metalW)
        .mul(sheenAmt)
    : vec3(0, 0, 0);
  const thoRgb = thoColour
    .mul(thoShade.shade)
    .mul(float(1).sub(thoShade.rim.mul(0.45)))
    .add(thoSheen);

  // head: a dark frons between the eyes
  const headRgb = mix(thoraxBase.mul(0.55), inkCol, float(0.5))
    .mul(headShade.shade)
    .mul(float(1).sub(headShade.rim.mul(0.4)));

  // eyes: red-brown, with a bright catch-light
  const eyeBase = eyeColor ?? vec3(0.5, 0.085, 0.05);
  const eyeRgb = eyeBase
    .mul(eyeShade.shade)
    .mul(float(1).sub(eyeShade.rim.mul(0.5)))
    .add(vec3(1, 0.85, 0.75).mul(eyeShade.spec).mul(0.9));

  // ── Layer stack, bottom → top ──
  let stack = emptyLayer(TSL);

  // legs
  if (plan.legs) {
    const stancePhase = (ph) => ph.div(STANCE_DUTY);
    const swingEase = (t) => t.mul(t).mul(float(3).sub(t.mul(2)));
    const tripodSet = [
      // [kind, side, phaseOffset]
      [0, 1, 0],
      [1, -1, 0],
      [2, 1, 0],
      [0, -1, 0.5],
      [1, 1, 0.5],
      [2, -1, 0.5],
    ];
    const legColour = inkCol.mul(0.9).add(vec3(0.04, 0.035, 0.03));
    let legsAlpha = float(0);
    for (const [kind, side, offset] of tripodSet) {
      const hip = vec2(HIP[kind][0], side * HIP[kind][1]);
      const rest = vec2(REST_FOOT[kind][0], side * REST_FOOT[kind][1]);
      const ph = fract(gait.add(offset));
      const inStance = ph.lessThan(STANCE_DUTY);
      const swingT = clamp(ph.sub(STANCE_DUTY).div(1 - STANCE_DUTY), 0, 1);
      const xStep = select(inStance, float(1).sub(stancePhase(ph).mul(2)), swingEase(swingT).mul(2).sub(1));
      const lift = select(inStance, float(0), sin(swingT.mul(PI)));
      // translation: all feet step the same way; turning in place: the two sides counter-step
      const stepDir = mix(float(1), pose.turnDir.mul(-side), abs(pose.turnDir));
      const amp = STRIDE_AMPLITUDE[kind];
      const walkFoot = vec2(
        rest.x.add(xStep.mul(stepDir).mul(pose.stride).mul(amp)),
        rest.y.sub(lift.mul(pose.stride).mul(0.035 * side))
      );
      // flight: legs tucked up and trailing
      const tuckFoot = vec2(hip.x.add(-0.07 - 0.03 * kind), hip.y.add(0.05 * side));
      // landing / take-off: legs extended for the ground
      const reachFoot = vec2(rest.x.add(0.06 * (kind === 2 ? -0.5 : 1)), rest.y.add(0.075 * side));
      let foot = mix(walkFoot, tuckFoot, pose.tuck);
      foot = mix(foot, reachFoot, pose.reach);
      if (plan.groom && kind !== 1) {
        // front legs rub together in front of the head; hind legs stroke the wings
        const phaseSign = side > 0 ? 0 : PI;
        const groomFoot =
          kind === 0
            ? vec2(0.43, side * 0.03).add(
                vec2(0.0, 0.026)
                  .mul(sin(pose.groomPhase.add(phaseSign)))
                  .mul(side)
              )
            : vec2(-0.12, side * 0.125).add(vec2(0.085, 0.0).mul(sin(pose.groomPhase.mul(0.8).add(phaseSign))));
        foot = mix(foot, groomFoot, pose.groom.mul(kind === 0 ? 1 : 0.55));
      }

      // two-bone IK: the knee is the intersection of two circles
      const [l1, l2] = SEGMENTS[kind];
      const dv = foot.sub(hip);
      const dist = max(length(dv), 1e-4);
      const dirv = dv.div(dist);
      const reachD = min(dist, float(l1 + l2 - 0.006));
      const a = reachD
        .mul(reachD)
        .add(l1 * l1 - l2 * l2)
        .div(reachD.mul(2));
      const h = sqrt(max(float(l1 * l1).sub(a.mul(a)), 0));
      let nrm = vec2(dirv.y.negate(), dirv.x);
      const outward = dot(nrm, vec2(KNEE_FORWARD_BIAS[kind], side));
      nrm = nrm.mul(select(outward.lessThan(0), float(-1), float(1)));
      const knee = hip.add(dirv.mul(a)).add(nrm.mul(h));

      const dFemur = sdCapsule(TSL, p, hip, knee, float(0));
      const dTibia = sdCapsule(TSL, p, knee, foot, float(0));
      const cov = max(stroke(TSL, dFemur, legW.mul(0.017), aa), stroke(TSL, dTibia, legW.mul(0.012), aa));
      const pad = coverage(TSL, length(p.sub(foot)).sub(legW.mul(0.017)), aa);
      legsAlpha = max(legsAlpha, max(cov, pad.mul(0.8)));
    }
    stack = over(TSL, layer(TSL, legColour, legsAlpha.mul(0.95)), stack);
  }

  // abdomen, thorax, head (each over the last — the overlap reads as segmentation)
  stack = over(TSL, layer(TSL, abdRgb, coverage(TSL, dAbd, aa)), stack);
  stack = over(TSL, layer(TSL, thoRgb, coverage(TSL, dTho, aa)), stack);
  stack = over(TSL, layer(TSL, headRgb, coverage(TSL, dHead, aa)), stack);
  stack = over(TSL, layer(TSL, eyeRgb, coverage(TSL, dEye, aa)), stack);

  // ── Wings ──
  const hingeV = vec2(WING_HINGE[0], WING_HINGE[1]);
  const wing = (pp, mean, amp) => {
    const q = pp.sub(hingeV);
    const r = max(length(q), 1e-4);
    const th = safeAtan2(TSL, q.y, q.x);
    const rn = r.sub(WING_LENGTH / 2).div(WING_LENGTH / 2);
    const env = sqrt(max(float(1).sub(rn.mul(rn)), 0));
    const halfW = env.mul(WING_WIDTH / 2).mul(float(0.35).add(k(0, 0.3, r).mul(0.65)));
    const hw = atan(halfW, max(r, 0.03));

    // crisp: the wing frozen at the beat's instantaneous angle
    const psiNow = mean.add(amp.mul(sin(pose.wingPhase)));
    const dNow = wrapAngle(TSL, th.sub(float(PI).sub(psiNow)));
    const crisp = coverage(TSL, abs(dNow).sub(hw).mul(r), aa);

    // fan: the beat integrated over a frame (the arcsine law, header §1)
    const dMean = wrapAngle(TSL, th.sub(float(PI).sub(mean)));
    const A = max(amp, 0.02);
    const hi = asin(clamp(hw.sub(dMean).div(A), -1, 1));
    const lo = asin(clamp(hw.negate().sub(dMean).div(A), -1, 1));
    const fan = hi.sub(lo).div(PI);
    const useFan = pose.wingBlur.mul(k(0.03, 0.2, amp));

    let veinAlpha = float(0);
    if (plan.veins) {
      // radial veins at fixed fractions of the half-width; the leading edge is the thick one
      const vein = (c, w) => float(1).sub(k(0, w, abs(dNow.sub(hw.mul(c))).mul(r)));
      veinAlpha = max(
        max(vein(-0.86, 0.011).mul(1.0), vein(-0.3, 0.006).mul(0.7)),
        max(vein(0.28, 0.006).mul(0.7), vein(0.78, 0.006).mul(0.5))
      );
    }
    return { crisp, fan, useFan, veinAlpha };
  };

  const wingColour = vec3(0.82, 0.86, 0.9);
  const wingInk = vec3(0.12, 0.12, 0.13);
  const wingLayer = (w) => {
    const crispA = w.crisp.mul(0.34).mul(wingOp);
    // A blurred wing can be no more opaque than the wing itself (crispA), so the fan stays at or under it.
    const fanA = w.fan.mul(0.38).mul(wingOp);
    const alpha = mix(crispA, fanA, w.useFan);
    const veinMix = w.veinAlpha.mul(w.crisp).mul(float(1).sub(w.useFan)).mul(0.55).mul(wingOp);
    return layer(TSL, mix(wingColour, wingInk, veinMix), max(alpha, veinMix.mul(0.5)));
  };
  // The fly is symmetric: one wing evaluated on the folded-to-left half-plane IS both, unless banking
  // makes them differ, in which case each side gets its own mean angle.
  if (plan.bank) {
    // Banking makes the two wings differ, so each side is evaluated in its own frame.
    const bankDelta = pose.bank.mul(0.13);
    const left = wing(vec2(px, py), pose.wingMean.add(bankDelta), pose.wingAmp);
    const right = wing(vec2(px, py.negate()), pose.wingMean.sub(bankDelta), pose.wingAmp);
    stack = over(TSL, wingLayer(left), stack);
    stack = over(TSL, wingLayer(right), stack);
  } else {
    const w = wing(vec2(px, absY), pose.wingMean, pose.wingAmp);
    stack = over(TSL, wingLayer(w), stack);
  }

  // ── Finish ──
  // The stack is premultiplied, so un-premultiplying divides by a coverage that can be arbitrarily small in
  // the anti-aliasing fringe. Anything finite that reaches here is a colour, so cap it: a brighter value
  // than a catch-light ever needs would only feed bloom.
  const alpha = stack.a;
  const rgb = min(stack.c.div(max(alpha, 1e-5)), vec3(RGB_CEILING, RGB_CEILING, RGB_CEILING)).mul(tint);
  return { rgb, alpha };
}

/**
 * The fly's shadow — its OWN silhouette, blurred. The body builder is reused with
 * a deliberately huge pixel size (`aa`), which turns every anti-aliasing ramp into
 * a wide soft edge, so the shadow is automatically the right shape (a fan of
 * wings casts a faint fan) with no second model to keep in step.
 *
 * @param {*} TSL
 * @param {object} a - as `buildFlyBody`, minus tint/lighting; `softness` is the blur in body lengths
 *   (a node: it grows with the fly's height).
 * @returns {*} alpha 0..1 (multiply by shadow strength).
 */
export function buildFlyShadow(TSL, { p, softness, pose, gait, seed01, plan, lookIndex, wingOpacity = null }) {
  const { vec2, vec3 } = TSL;
  const shadowPlan = { ...plan, legs: false, veins: false, groom: false, bank: false, sheen: false };
  const body = buildFlyBody(TSL, {
    p,
    aa: softness,
    pose,
    gait,
    seed01,
    lightLocal: vec2(0, 0),
    tint: vec3(1, 1, 1),
    plan: shadowPlan,
    lookIndex,
    wingOpacity,
  });
  return body.alpha;
}

/** Exposed for the unit tests: the geometry the legs and wings are built from. */
export const FLY_GEOMETRY = Object.freeze({
  HIP,
  REST_FOOT,
  SEGMENTS,
  STRIDE_AMPLITUDE,
  STANCE_DUTY,
  WING_HINGE,
  WING_LENGTH,
  WING_WIDTH,
});
