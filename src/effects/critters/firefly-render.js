/**
 * FIREFLY RENDER — the two NodeMaterials that draw a colony: the beetle, and its light.
 *
 * One instanced quad per firefly in each material. The vertex stage reads the
 * insect's row out of the arena (position, height, flash phase, state), works out how
 * bright it is flashing RIGHT NOW (`firefly-body.js#buildFlash`) and how big it
 * looks, and places the quad; the fragment stage draws.
 *
 *   • BODY — a small dark beetle, normal blending, lit by the scene at the `lit`
 *     rung. Drawn first.
 *   • GLOW — the halo (and, at the top rung, the afterglow streak), ADDITIVE and in
 *     HDR so the bloom pass spreads it. Not lit by the scene: it IS a light.
 *
 * Like a fly, a firefly in the air is nearer the camera than one on the ground, so
 * it is larger and pushed away from the view's centre by fire's perspective law
 * `M(h) = D/(D − h)`; unlike a fly it throws no shadow (it is dusk, and a shadow the
 * size of a grain of rice is not worth a draw).
 *
 * @module effects/critters/firefly-render
 */
import { buildFlash, buildGlow, buildBeetle, TRAIL_SECONDS } from './firefly-body.js';
import { FIREFLY_SYNC } from './firefly-brain.js';
import { buildInstance } from './critter-instance.js';
import { litLinear, occlusionGate, createCritterMaterial } from './critter-surface.js';

/** Half the body quad's side, in body lengths (antennae and wings reach about 0.65). */
const BODY_HALF = 0.85;
/** The glow quad reaches this many glow radii from the insect (the profile is windowed to 0 at 1.25). */
const GLOW_REACH = 1.3;
/** Light direction in WORLD space (y is down): from the upper left. */
const WORLD_LIGHT = [-0.5, -0.8];
/** Rest-glow shimmer rate, radians per second (a slow breath). */
const TAU_REST = Math.PI * 2 * 0.7;

/**
 * @param {*} TSL @param {*} THREE
 * @param {object} deps
 * @param {Record<string, *>} deps.buffers @param {(name: string) => *} deps.u
 * @param {object} deps.plan - `critterTierPlan('firefly', tier)`.
 * @param {*} [deps.illumTexNode] @param {*} [deps.colorationTexNode]
 * @param {*} [deps.depthTexNode] @param {*} [deps.depthFlagsTexNode]
 * @param {number} [deps.zDepth]
 * @returns {{body: *|null, glow: *}}
 */
export function buildFireflyMaterials(
  TSL,
  THREE,
  {
    buffers,
    u,
    plan,
    illumTexNode = null,
    colorationTexNode = null,
    depthTexNode = null,
    depthFlagsTexNode = null,
    zDepth = 0,
  }
) {
  const {
    Fn,
    float,
    vec2,
    vec3,
    vec4,
    positionGeometry,
    fwidth,
    max,
    min,
    sin,
    cos,
    floor,
    length,
    clamp,
    select,
    dot,
    cross,
    sRGBTransferEOTF,
  } = TSL;
  const inst = buildInstance(TSL, { buffers, u, sizeParam: 'size', variationParam: 'sizeVariation' });
  const rotate = (v, a) => vec2(v.x.mul(cos(a)).sub(v.y.mul(sin(a))), v.x.mul(sin(a)).add(v.y.mul(cos(a))));
  const corner = positionGeometry.xy;

  const hdg = inst.C.x;
  const height = max(inst.C.y, 0);
  const fph = inst.C.z;
  const ord = floor(inst.PH);
  const frac = inst.PH.sub(ord);
  const smooth01 = (t) => {
    const c = clamp(t, 0, 1);
    return c.mul(c).mul(float(3).sub(c.mul(2)));
  };
  // 1 on the ground (resting), 0 in the air; eased through a landing and a lift-off
  const restAmt = select(
    ord.lessThan(0.5),
    float(0),
    select(ord.lessThan(1.5), smooth01(frac), select(ord.lessThan(2.5), float(1), float(1).sub(smooth01(frac))))
  );

  // perspective: bigger and displaced outward with height (fire's law)
  // the author's `perspective` strengthens or weakens the law (a farther or nearer camera); floored so 0 stays finite
  const camH = u('camHeight').div(max(u('perspective'), 0.05));
  const persp = camH.div(camH.sub(min(height, camH.mul(0.6))));
  const centre = u('camCentre');
  const bodyCentre = centre.add(inst.P.sub(centre).mul(persp));

  // the flash now; a resting firefly glows low and steady, like a female waiting for a signal
  const flashStyle = u('flashStyleIndex');
  const flashAir = buildFlash(TSL, { phase: fph, styleIndex: flashStyle });
  const restGlow = u('restGlow').mul(
    float(1).add(sin(u('timeSec').mul(TAU_REST).add(inst.seed01.mul(6.28))).mul(0.33))
  );
  const flash = flashAir.add(restGlow.sub(flashAir).mul(restAmt));

  const sizePx = inst.L.mul(persp);
  const glowPx = u('glowRadius').mul(persp);
  // each firefly's own period — the SAME law the brain's flash clock uses (`FIREFLY_SYNC`)
  const period = max(
    float(0.5),
    u('flashPeriod').mul(float(FIREFLY_SYNC.PERIOD_MIN).add(inst.seed01.mul(FIREFLY_SYNC.PERIOD_SPAN)))
  );
  const trailSeconds = float(TRAIL_SECONDS).mul(u('afterglow'));
  const trailLen = plan.trail ? length(inst.V).mul(trailSeconds).mul(persp) : float(0);
  const worldLight = vec2(WORLD_LIGHT[0], WORLD_LIGHT[1]).normalize();

  const vInfo = Fn(() => vec4(inst.alpha, flash, float(1).sub(restAmt), sizePx))().toVarying('vInfo');
  const vFlashA = Fn(() => vec4(fph, flashStyle, trailSeconds.div(period), trailLen))().toVarying('vFlashA');
  const vLight = Fn(() => rotate(worldLight, hdg.negate()))().toVarying('vLight');
  const live = inst.alpha.greaterThan(0.002).select(float(1), float(0));
  const gate = occlusionGate(TSL, { depthTexNode, depthFlagsTexNode, expectedDepth: u('expectedDepth') });
  // Each firefly's own colour: the author's glow colour with its hue rotated by a per-insect amount about the grey
  // axis (Rodrigues), so a colony mixes yellow-green and blue-green individuals. `colorVariation` 0 is one hue.
  const hueAngle = inst.seed01.sub(0.5).mul(2).mul(u('colorVariation')).mul(0.9);
  const axis = vec3(0.57735, 0.57735, 0.57735);
  const vGlowColor = Fn(() => {
    const c = u('color');
    const rotated = c
      .mul(cos(hueAngle))
      .add(cross(axis, c).mul(sin(hueAngle)))
      .add(axis.mul(dot(axis, c)).mul(float(1).sub(cos(hueAngle))));
    return max(rotated, vec3(0, 0, 0));
  })().toVarying('vGlowColor');
  const glowColor = vGlowColor;

  // ── BODY ──
  let body = null;
  if (plan.body) {
    body = createCritterMaterial(THREE);
    const vP = Fn(() => corner.mul(BODY_HALF * 2))().toVarying('vP');
    body.positionNode = Fn(() => {
      const off = rotate(corner.mul(BODY_HALF * 2), hdg).mul(sizePx);
      return vec3(bodyCentre.x.add(off.x.mul(live)), bodyCentre.y.add(off.y.mul(live)), float(zDepth));
    })();
    const aa = max(max(fwidth(vP.x), fwidth(vP.y)), 1e-4);
    const look = buildBeetle(TSL, {
      p: vP,
      aa,
      flash: vInfo.y,
      glowColor,
      flying: vInfo.z,
      lightLocal: vLight,
      plan,
    });
    const lit = litLinear(TSL, {
      rgb: look.rgb,
      lit: plan.lit,
      illumTexNode,
      colorationTexNode,
      influence: u('lightInfluence'),
    });
    // the lantern's own light is added AFTER lighting: it is not reflected, it is made
    body.colorNode = lit.add(sRGBTransferEOTF(glowColor).mul(look.emissive).mul(float(1.2)));
    body.opacityNode = look.alpha.mul(u('bodyVisibility')).mul(vInfo.x).mul(gate);
  }

  // ── GLOW ──
  const glow = createCritterMaterial(THREE, { blending: THREE.AdditiveBlending });
  const halfH = max(glowPx.mul(GLOW_REACH), sizePx.mul(0.8));
  // the quad in the insect's heading frame, px: stretched behind it by the afterglow streak
  const qLocal = vec2(
    corner.x.add(0.5).mul(halfH.mul(2).add(trailLen)).sub(halfH.add(trailLen)),
    corner.y.mul(2).mul(halfH)
  );
  const vQ = Fn(() => qLocal)().toVarying('vQ');
  glow.positionNode = Fn(() => {
    const off = rotate(qLocal, hdg);
    return vec3(bodyCentre.x.add(off.x.mul(live)), bodyCentre.y.add(off.y.mul(live)), float(zDepth));
  })();
  const radiance = buildGlow(TSL, {
    q: vQ,
    radius: glowPx,
    flash: vInfo.y,
    color: sRGBTransferEOTF(glowColor),
    intensity: u('intensity'),
    plan,
    coreSize: u('coreSize'),
    haloAmount: u('haloAmount'),
    afterglow: u('afterglow'),
    trail: plan.trail ? { length: vFlashA.w, phase: vFlashA.x, dPhase: vFlashA.z, styleIndex: vFlashA.y } : null,
  });
  glow.colorNode = radiance;
  glow.opacityNode = vInfo.x.mul(gate);

  return { body, glow };
}
