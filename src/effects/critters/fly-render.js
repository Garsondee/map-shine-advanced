/**
 * FLY RENDER — the two NodeMaterials that draw a swarm: the body, and its shadow.
 *
 * Both are ONE instanced quad per fly whose vertex stage reads the fly's state out
 * of the arena's storage buffers (the only place a storage buffer may be read on
 * this renderer is the vertex stage — a fragment that needs a value gets it as a
 * VARYING), turns it into a pose (`fly-pose.js`), and places the quad. The
 * fragment stage hands the pose to `fly-body.js` and finishes the pixel.
 *
 * ============================================================================
 * THE CAMERA IS FLAT; THE FLY IS NOT
 * ============================================================================
 *
 * MSA's camera is orthographic and looks straight down, so nothing has parallax.
 * A fly 80 px in the air should read as nearer the camera, which means bigger and
 * displaced away from the centre of the view. `fire-particle-runtime.js` solved
 * this per particle with V2's own perspective law `M(h) = D/(D − h)` (D = 1000);
 * a fly applies the same transform to itself, so a flying fly is ~9% larger than
 * a landed one and that difference IS the take-off/landing size cue V2 got from
 * its second sprite. The SHADOW, which lies on the ground, gets no such lift — it
 * slides away from the body by `height × (sun throw)`, and merges with it again
 * as the fly lands. Body and shadow converging is the strongest "it is landing"
 * cue a top-down view can give.
 *
 * ============================================================================
 * LIT, OCCLUDED
 * ============================================================================
 *
 * The draw lands on `scene.lit` AFTER lighting, so a fly would be full-bright in a
 * pitch-dark cellar. At the `lit` rung it multiplies its albedo by the scene's own
 * illumination exactly as the composite does — `lit = EOTF(OETF(albedo) × illum +
 * coloration)` (`environmental-light.js`) — so a fly in a torch pool is warm and
 * one in the dark is not. And it goes through the depth-authority occlusion gate
 * fire uses, so a swarm over a room does not draw through the roof above it.
 *
 * @module effects/critters/fly-render
 */
import { buildFlyBody, buildFlyShadow } from './fly-body.js';
import { buildFlyPose } from './fly-pose.js';
import { wrapAngle, safeAtan2 } from './critter-sdf.js';
import { buildInstance } from './critter-instance.js';
import { litLinear, occlusionGate, createCritterMaterial } from './critter-surface.js';

/** Half the quad's side, in body lengths. Covers a spread wing (reach ≈ 0.9) with margin. */
const QUAD_HALF = 0.95;
/** The shadow's quad is larger: its blur needs room to fade out. */
const SHADOW_HALF = 1.35;
/** Light direction in WORLD space (y is down): from the upper left. */
const WORLD_LIGHT = [-0.5, -0.8];

/**
 * The per-instance values every fly material derives from the arena. Built ONCE and
 * shared by the body and the shadow, so the two can never disagree about where a fly is.
 */
function flyInstance(TSL, { buffers, u }) {
  const { float, floor, clamp, select, min, max } = TSL;
  const base = buildInstance(TSL, { buffers, u, sizeParam: 'size', variationParam: 'sizeVariation' });
  const { V, C, PH } = base;

  const hdg = C.x;
  const height = max(C.y, 0);
  const gait = C.z;
  const ord = floor(PH);
  const frac = PH.sub(ord);
  const isFly = ord.lessThan(0.5);
  const isWalk = ord.greaterThan(1.5).and(ord.lessThan(2.5));

  // Turn rate, derived from what is stored: a flying fly's heading lags its velocity
  // (so the gap is its turn), a walking fly turns toward `custom.w`.
  const velAng = safeAtan2(TSL, V.y, V.x);
  const turnRate = select(
    isFly,
    wrapAngle(TSL, velAng.sub(hdg)).mul(12),
    select(isWalk, wrapAngle(TSL, C.w.sub(hdg)).mul(4), float(0))
  );

  // Perspective from the camera (fire's law): bigger and pushed outward with height.
  const camH = u('camHeight');
  const hClamped = min(height, camH.mul(0.6));
  const persp = camH.div(camH.sub(hClamped));
  const centre = u('camCentre');
  const bodyCentre = centre.add(base.P.sub(centre).mul(persp));

  return {
    ...base,
    hdg,
    height,
    height01: clamp(height.div(max(u('flyHeight'), 1)), 0, 1.2),
    gait,
    ord,
    frac,
    turnRate,
    persp,
    bodyCentre,
    timeSec: u('timeSec'),
  };
}

/**
 * @param {*} TSL @param {*} THREE
 * @param {object} deps
 * @param {Record<string, *>} deps.buffers - the arena's storage nodes.
 * @param {(name: string) => *} deps.u - uniform bank `get`.
 * @param {object} deps.plan - `critterTierPlan('fly', tier)`.
 * @param {*} [deps.illumTexNode] @param {*} [deps.colorationTexNode] - scene lighting (the `lit` rung).
 * @param {*} [deps.depthTexNode] @param {*} [deps.depthFlagsTexNode] - the occlusion gate.
 * @param {number} [deps.zDepth]
 * @returns {{body: *, shadow: *|null}} NodeMaterials.
 */
export function buildFlyMaterials(
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
  const { Fn, float, vec2, vec3, vec4, positionGeometry, fwidth, max, sin, cos } = TSL;
  const inst = flyInstance(TSL, { buffers, u });
  const rotate = (v, a) => vec2(v.x.mul(cos(a)).sub(v.y.mul(sin(a))), v.x.mul(sin(a)).add(v.y.mul(cos(a))));
  const corner = positionGeometry.xy;

  // ── the pose, computed once per instance in the vertex stage ──
  const pose = buildFlyPose(TSL, {
    ordinal: inst.ord,
    frac: inst.frac,
    timeSec: inst.timeSec,
    seed01: inst.seed01,
    turnRate: inst.turnRate,
    groomChance: u('groomChance'),
    wingBlurAmt: u('wingBlur'),
  });
  const vPose0 = Fn(() => vec4(pose.wingMean, pose.wingAmp, pose.wingBlur, pose.wingPhase))().toVarying('vPose0');
  const vPose1 = Fn(() => vec4(pose.stride, pose.turnDir, pose.tuck, pose.reach))().toVarying('vPose1');
  const vPose2 = Fn(() => vec4(pose.groom, pose.groomPhase, pose.bank, inst.gait))().toVarying('vPose2');
  const vInfo = Fn(() => vec4(inst.seed01, inst.alpha, inst.height01, inst.L))().toVarying('vInfo');
  const unpackedPose = {
    wingMean: vPose0.x,
    wingAmp: vPose0.y,
    wingBlur: vPose0.z,
    wingPhase: vPose0.w,
    stride: vPose1.x,
    turnDir: vPose1.y,
    tuck: vPose1.z,
    reach: vPose1.w,
    groom: vPose2.x,
    groomPhase: vPose2.y,
    bank: vPose2.z,
  };
  const worldLight = vec2(WORLD_LIGHT[0], WORLD_LIGHT[1]).normalize();
  const vLight = Fn(() => rotate(worldLight, inst.hdg.negate()))().toVarying('vLight');

  // ── BODY ──
  const body = createCritterMaterial(THREE);
  const vLocal = Fn(() => corner.mul(QUAD_HALF * 2))().toVarying('vLocal');
  body.positionNode = Fn(() => {
    const sizePx = inst.L.mul(inst.persp);
    const off = rotate(corner.mul(QUAD_HALF * 2), inst.hdg).mul(sizePx);
    // a zero-alpha fly collapses to a point: no fragments, no fill cost
    const live = inst.alpha.greaterThan(0.002).select(float(1), float(0));
    return vec3(inst.bodyCentre.x.add(off.x.mul(live)), inst.bodyCentre.y.add(off.y.mul(live)), float(zDepth));
  })();

  const aa = max(max(fwidth(vLocal.x), fwidth(vLocal.y)), 1e-4);
  const look = buildFlyBody(TSL, {
    p: vLocal,
    aa,
    pose: unpackedPose,
    gait: vPose2.w,
    seed01: vInfo.x,
    lightLocal: vLight,
    tint: u('tint'),
    plan,
    lookIndex: u('lookIndex'),
  });

  body.colorNode = litLinear(TSL, { rgb: look.rgb, lit: plan.lit, illumTexNode, colorationTexNode });
  const gate = occlusionGate(TSL, { depthTexNode, depthFlagsTexNode, expectedDepth: u('expectedDepth') });
  body.opacityNode = look.alpha.mul(vInfo.y).mul(gate);

  // ── SHADOW ──
  let shadow = null;
  if (plan.shadow) {
    shadow = createCritterMaterial(THREE);
    const vShadowLocal = Fn(() => corner.mul(SHADOW_HALF * 2))().toVarying('vShadowLocal');
    // soft with height: a landed fly's shadow is a tight contact shadow, a high one a broad smudge
    const vSoft = Fn(() => {
      const soft = u('shadowSoft')
        .div(inst.L)
        .mul(float(0.3).add(inst.height01.mul(0.7)))
        .add(0.03);
      return soft;
    })().toVarying('vSoft');
    shadow.positionNode = Fn(() => {
      const sizePx = inst.L;
      const off = rotate(corner.mul(SHADOW_HALF * 2), inst.hdg).mul(sizePx);
      const throwPx = u('shadowShift').mul(inst.height);
      const live = inst.alpha.greaterThan(0.002).select(float(1), float(0));
      return vec3(
        inst.P.x.add(throwPx.x).add(off.x.mul(live)),
        inst.P.y.add(throwPx.y).add(off.y.mul(live)),
        float(zDepth)
      );
    })();
    const silhouette = buildFlyShadow(TSL, {
      p: vShadowLocal,
      softness: max(vSoft, max(fwidth(vShadowLocal.x), 1e-4)),
      pose: unpackedPose,
      gait: vPose2.w,
      seed01: vInfo.x,
      plan,
      lookIndex: u('lookIndex'),
    });
    shadow.colorNode = vec3(0.01, 0.008, 0.006);
    shadow.opacityNode = silhouette
      .mul(u('shadowAmount'))
      .mul(vInfo.y)
      .mul(float(1).sub(vInfo.z.mul(0.45)).max(0.3))
      .mul(gate);
  }

  return { body, shadow };
}
