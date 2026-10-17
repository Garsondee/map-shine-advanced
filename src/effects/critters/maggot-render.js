/**
 * MAGGOT RENDER — the NodeMaterial that draws a crowd of maggots.
 *
 * One instanced quad per maggot. The vertex stage reads the maggot's row out of the
 * arena (heading, wave phase, excitement), bends the spine into this instant's pose
 * (`maggot-body.js#buildMaggotRig`) and passes the nine spine points to the
 * fragment stage as varyings; the fragment stage only has to draw a tapered tube
 * through them. A maggot lies on the ground, so unlike a fly it has no height, no
 * perspective lift and no separate shadow pass — its contact shadow is part of its
 * own pixels.
 *
 * @module effects/critters/maggot-render
 */
import { buildMaggotRig, buildMaggotBody } from './maggot-body.js';
import { buildInstance } from './critter-instance.js';
import { litLinear, occlusionGate, createCritterMaterial } from './critter-surface.js';

/** Half the quad's side, in body lengths: covers the body (±0.5) and a deep curl, plus the contact shadow. */
const QUAD_HALF = 0.72;
/** Light direction in WORLD space (y is down): from the upper left. */
const WORLD_LIGHT = [-0.5, -0.8];

/**
 * @param {*} TSL @param {*} THREE
 * @param {object} deps
 * @param {Record<string, *>} deps.buffers - the arena's storage nodes.
 * @param {(name: string) => *} deps.u - uniform bank `get`.
 * @param {object} deps.plan - `critterTierPlan('fly', tier)`.
 * @param {*} [deps.illumTexNode] @param {*} [deps.colorationTexNode]
 * @param {*} [deps.depthTexNode] @param {*} [deps.depthFlagsTexNode]
 * @param {number} [deps.zDepth]
 * @returns {{body: *}} NodeMaterials.
 */
export function buildMaggotMaterials(
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
  const inst = buildInstance(TSL, { buffers, u, sizeParam: 'maggotSize', variationParam: 'sizeVariation' });
  const hdg = inst.C.x;
  const rotate = (v, a) => vec2(v.x.mul(cos(a)).sub(v.y.mul(sin(a))), v.x.mul(sin(a)).add(v.y.mul(cos(a))));
  const corner = positionGeometry.xy;

  // ── the spine, once per instance, in the vertex stage ──
  const rig = buildMaggotRig(TSL, {
    wave: inst.C.y,
    excite: inst.C.z,
    wriggle: u('maggotWriggle'),
    seed01: inst.seed01,
  });
  const varyPoints = rig.points.map((pt, i) => Fn(() => pt)().toVarying(`vSpine${i}`));
  const vInfo = Fn(() => vec4(inst.seed01, inst.alpha, inst.L, 0))().toVarying('vInfo');
  const worldLight = vec2(WORLD_LIGHT[0], WORLD_LIGHT[1]).normalize();
  const vLight = Fn(() => rotate(worldLight, hdg.negate()))().toVarying('vLight');
  const vLocal = Fn(() => corner.mul(QUAD_HALF * 2))().toVarying('vLocal');

  const body = createCritterMaterial(THREE);
  body.positionNode = Fn(() => {
    const off = rotate(corner.mul(QUAD_HALF * 2), hdg).mul(inst.L);
    // a zero-alpha maggot collapses to a point: no fragments, no fill cost
    const live = inst.alpha.greaterThan(0.002).select(float(1), float(0));
    return vec3(inst.P.x.add(off.x.mul(live)), inst.P.y.add(off.y.mul(live)), float(zDepth));
  })();

  const aa = max(max(fwidth(vLocal.x), fwidth(vLocal.y)), 1e-4);
  const look = buildMaggotBody(TSL, {
    p: vLocal,
    aa,
    points: varyPoints,
    lightLocal: vLight,
    colour: u('maggotColor'),
    seed01: vInfo.x,
    plan,
  });
  body.colorNode = litLinear(TSL, { rgb: look.rgb, lit: plan.lit, illumTexNode, colorationTexNode });
  const gate = occlusionGate(TSL, { depthTexNode, depthFlagsTexNode, expectedDepth: u('expectedDepth') });
  body.opacityNode = look.alpha.mul(vInfo.y).mul(gate);

  return { body, shadow: null };
}
