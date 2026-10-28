/**
 * MOTE RENDER — the one NodeMaterial that draws a cloud of dust, and the whole of
 * what makes it look like dust caught in a window's light.
 *
 * One instanced quad per mote, ADDITIVE, in HDR so the bloom pass spreads the
 * brightest glints. The vertex stage reads the mote's row out of the arena
 * (position, height, tumble phase), places the quad with fire's perspective law
 * `M(h) = D/(D − h)` and works out everything that is a property of the mote
 * itself; the fragment stage decides how brightly the LIGHT is on it.
 *
 * ============================================================================
 * HOW A MOTE KNOWS IT IS IN THE LIGHT
 * ============================================================================
 *
 * The `_Window` effect does not draw into a buffer of its own: it ADDS its light
 * into `scene.illum` (`illum += fill · (target − indoor)`, signed), alongside the
 * ambient fill and every lamp. So the window light at any floor point is "what
 * `scene.illum` holds there, above what the room holds on its own". That is all the
 * mote needs, and it buys every property of the window for free, because they are
 * all already in the buffer: the golden hour's gold and the moon's blue, a cloud
 * dimming the patch, the rain-waves darkening it, the glass's caustics, the sun
 * breaks. The dust cannot disagree with the window about the weather, because it is
 * reading the window's own answer.
 *
 *   excess = max(illum − roomLight, 0)          per channel; roomLight = the indoor ambient
 *   beam   = (luma(excess) / range) ^ contrast  0 in the shade, 1 in the full beam
 *   tint   = excess ÷ luma(excess)              the light's own hue, unit luminance
 *
 * The mote samples that at the floor point ITS SUNBEAM LANDS ON, not the floor point
 * under it: `P + sunShift · height`, where `sunShift` is the same per-pixel-of-height
 * throw a fly's shadow uses. High motes therefore look up-sun for their light, and
 * the lit ones form a leaning column that stretches at a low sun.
 *
 * ============================================================================
 * THE LOOK, BY RUNG
 * ============================================================================
 *
 *   0  specks    a steady gaussian pinpoint, lit by the beam
 *   1  glints    + a flake turning over (a brief flare as its face catches the light)
 *   2  depth     + depth of field (a mote off the focal height spreads into a soft, fainter disc)
 *                + a faint glow by the room's own light and lamps
 *   3  sparkle   + a four-point star on the brightest glints, and a halo
 *
 * @module effects/critters/mote-render
 */
import { buildInstance } from './critter-instance.js';
import { occlusionGate, createCritterMaterial } from './critter-surface.js';
import { safeAtan2 } from './critter-sdf.js';

/** The quad reaches this many in-focus mote diameters from the mote. */
const QUAD_REACH = 1.7;
/** No mote is drawn smaller than this many device pixels across: below it a speck aliases and crawls. */
/** The bokeh disc's amplitude relative to the gaussian it replaces, so the two carry the same light. */
const DISC_ENERGY = 0.3;
/** Seconds for a respawned mote to fade in. */
const LUMA = [0.2126, 0.7152, 0.0722];

/**
 * The glint's brightest multiple for a sharpness `n`: the flare is `cos(θ)ⁿ` for the half of the cycle the
 * flake's face is toward the light, whose mean is about `0.4/√n`, so a peak of `2√n` over a floor of 0.2
 * keeps the long-run average at 1. A glint adds sparkle without making the cloud brighter or dimmer.
 * @param {number} sharpness
 * @returns {number}
 */
export function glintPeak(sharpness) {
  return 2 * Math.sqrt(Math.max(sharpness, 1));
}

/**
 * @param {*} TSL @param {*} THREE
 * @param {object} deps
 * @param {Record<string, *>} deps.buffers @param {(name: string) => *} deps.u
 * @param {object} deps.plan - `critterTierPlan('mote', tier)`.
 * @param {*} [deps.illumTexNode] @param {*} [deps.colorationTexNode] - the scene's lighting buffers.
 * @param {*} [deps.depthTexNode] @param {*} [deps.depthFlagsTexNode]
 * @param {*} [deps.viewRectNode] - the viewer's `uViewRect` (vec4 minX, minY, maxX, maxY); absent reads the
 *   engine's own `viewMin`/`viewSize` uniforms.
 * @param {number} [deps.zDepth]
 * @returns {{glow: *}}
 */
export function buildMoteMaterials(
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
    viewRectNode = null,
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
    viewportSize,
    max,
    min,
    sin,
    cos,
    exp,
    fract,

    pow,
    sqrt,
    abs,
    dot,
    clamp,
    mix,
    smoothstep,
    sRGBTransferEOTF,
  } = TSL;
  const inst = buildInstance(TSL, {
    buffers,
    u,
    sizeParam: 'size',
    variationParam: 'sizeVariation',
    fadeInSec: max(u('fadeInTime'), float(0.05)),
  });
  const TAU = Math.PI * 2;
  const corner = positionGeometry.xy;
  const rotate = (v, a) => vec2(v.x.mul(cos(a)).sub(v.y.mul(sin(a))), v.x.mul(sin(a)).add(v.y.mul(cos(a))));

  const height = max(inst.C.x, 0);
  const tumble = inst.C.y;

  // perspective: bigger and displaced outward with height (fire's law), the author's `perspective` as the strength
  const camH = u('camHeight').div(max(u('perspective'), 0.05));
  const persp = camH.div(camH.sub(min(height, camH.mul(0.6))));
  const centre = u('camCentre');
  const drawAt = centre.add(inst.P.sub(centre).mul(persp));

  // depth of field: 0 at the focal height, 1 a full air-depth away from it
  const defocus = plan.depth
    ? clamp(
        abs(height.sub(u('focusHeight'))).div(max(u('hoverHeight').mul(0.6).add(u('focusHeight').mul(0.4)), 30)),
        0,
        1
      )
    : float(0);
  const discMix = clamp(u('bokeh'), 0, 1).mul(defocus);
  const spread = float(1).add(u('bokeh').mul(defocus).mul(u('bokehSize')));

  // never under MIN_SCREEN_PX across, and give back brightness for the size it did not have
  const viewSize = viewRectNode
    ? vec2(max(viewRectNode.z.sub(viewRectNode.x), float(1)), max(viewRectNode.w.sub(viewRectNode.y), float(1)))
    : max(u('viewSize'), vec2(1, 1));
  const viewMin = viewRectNode ? vec2(viewRectNode.x, viewRectNode.y) : u('viewMin');
  const pxPerWorld = viewportSize.x.div(viewSize.x);
  const sizeWorld = inst.L.mul(persp);
  const boost = max(float(1), u('minScreenSize').div(max(sizeWorld.mul(pxPerWorld), 1e-3)));
  const sizeEff = sizeWorld.mul(boost);
  const quadHalf = sizeEff.mul(spread).mul(QUAD_REACH);
  // Zoomed out, the same world holds more motes per screen pixel (1/zoom²) while each boosted sprite only loses
  // 1/boost (∝ zoom), so the cloud's brightness would grow as 1/zoom. Below one screen pixel per world pixel the
  // sprite also gives up brightness in proportion to the zoom, which holds the cloud's overall light level steady.
  const zoomHold = min(float(1), pxPerWorld);
  const energy = pow(spread, float(-2)).div(boost).mul(zoomHold);

  // the flake: a flare once a cycle as its face catches the light, the mean brightness held at 1
  let bright = float(1);
  let glint = float(0);
  if (plan.glint) {
    const sharp = max(u('sparkleSharpness'), 1);
    glint = pow(max(cos(tumble.mul(TAU)), 0), sharp);
    const peak = sqrt(sharp).mul(2);
    bright = mix(float(1), peak.mul(glint).add(u('glintFloor')), clamp(u('sparkle'), 0, 1));
  }

  // where this mote's sunbeam lands on the floor (world px)
  const samplePt = inst.P.add(u('sunShift').mul(height).mul(u('beamSlant')));

  const hashN = (k) => fract(sin(inst.seed01.mul(k).add(k)).mul(43758.5453));
  const live = inst.alpha.greaterThan(0.002).select(float(1), float(0));
  // the air carries a mote out of the room by fading it (`C.z`, the brain's edge fade) before it is recycled
  const edgeFade = clamp(inst.C.z, 0, 1);
  const vInfo = Fn(() =>
    vec4(
      inst.alpha
        .mul(energy)
        .mul(edgeFade)
        .mul(max(float(1).add(u('brightnessVariation').mul(hashN(41.3).sub(0.5)).mul(2)), 0)),
      bright,
      discMix,
      glint
    )
  )().toVarying('vInfo');
  const vSample = Fn(() => samplePt)().toVarying('vSample');
  const vSeed = Fn(() => inst.seed01)().toVarying('vSeed');
  // (orientation 0..1, aspect, lobe phases): the flake's own shape, and how edge-on it is as it tumbles
  const vShape = Fn(() =>
    vec4(
      hashN(17.3),
      mix(u('flakeThinness'), float(1), hashN(5.1)).mul(
        mix(
          float(1),
          abs(cos(tumble.mul(TAU)))
            .mul(u('edgeOnSquash'))
            .add(float(1).sub(u('edgeOnSquash'))),
          clamp(u('sparkle'), 0, 1)
        )
      ),
      hashN(9.7).mul(TAU),
      hashN(23.9).mul(TAU)
    )
  )().toVarying('vShape');
  const vQ = Fn(() => corner.mul(2))().toVarying('vQ');
  const gate = occlusionGate(TSL, { depthTexNode, depthFlagsTexNode, expectedDepth: u('expectedDepth') });

  const glow = createCritterMaterial(THREE, { blending: THREE.AdditiveBlending });
  glow.positionNode = Fn(() => {
    const off = corner.mul(2).mul(quadHalf);
    return vec3(drawAt.x.add(off.x.mul(live)), drawAt.y.add(off.y.mul(live)), float(zDepth));
  })();

  // ── the light on the mote ──
  const lumaOf = (c) => dot(c, vec3(LUMA[0], LUMA[1], LUMA[2]));
  const night = clamp(u('night'), 0, 1);
  const nightColour = night.mul(clamp(u('nightLightColour'), 0, 1));
  let moteLight = float(1);
  let tint = vec3(1, 1, 1);
  let ambient = vec3(0, 0, 0);
  if (illumTexNode) {
    const uv = clamp(vSample.sub(viewMin).div(viewSize), vec2(0, 0), vec2(1, 1));
    const illum = illumTexNode.sample(uv).rgb;
    const excess = max(illum.sub(u('lightBase').mul(u('roomCutoff'))).sub(0.004), vec3(0, 0, 0));
    const ex = lumaOf(excess);
    moteLight = pow(clamp(ex.div(max(u('beamRef'), 0.05)), 0, 1), u('beamContrast')).mul(
      float(1).add(u('lowSunGlow').mul(u('sunLow')))
    );
    // the light's own hue (unit luminance), fading to plain white where there is too little light to have a hue
    const hue = mix(vec3(1, 1, 1), excess.div(max(ex, 1e-3)), clamp(ex.mul(24), 0, 1));
    // after dark the dust is the light's colour outright (the moon's, or the sun's last glow), not its own
    tint = mix(
      vec3(1, 1, 1),
      min(hue, vec3(u('hueLimit'))),
      mix(clamp(u('colorFromLight'), 0, 1), float(1), nightColour)
    );
    if (plan.depth) {
      const lamps = colorationTexNode ? colorationTexNode.sample(uv).rgb : vec3(0, 0, 0);
      ambient = clamp(illum.add(lamps), vec3(0, 0, 0), vec3(1.5, 1.5, 1.5)).mul(u('ambientGlow'));
    }
  }
  // each mote's own slight warm/cool lean
  const lean = fract(sin(vSeed.mul(53.1).add(53.1)).mul(43758.5453))
    .sub(0.5)
    .mul(2)
    .mul(u('colorVariation'));
  const dust = mix(u('color'), vec3(1, 1, 1), nightColour).mul(
    vec3(float(1).add(lean.mul(0.25)), 1, float(1).sub(lean.mul(0.25)))
  );
  const radiance = sRGBTransferEOTF(dust.mul(tint))
    .mul(moteLight.mul(u('intensity')).mul(mix(float(1), u('nightOpacity'), night)))
    .add(
      sRGBTransferEOTF(dust.mul(ambient))
        .mul(u('intensity'))
        .mul(mix(float(1), u('nightOpacity'), night))
    );

  // ── the mote's shape: a gaussian pinpoint in focus, a soft disc out of it ──
  // Irregular on purpose: each mote is a flake with its own orientation and aspect, squashed further as it
  // tumbles edge-on, and its outline is warped by a few angular lobes so a defocused one is a ragged polygon
  // and not a perfect disc.
  const qr0 = rotate(vQ, vShape.x.mul(TAU));
  const q = vec2(qr0.x, qr0.y.div(vShape.y));
  const theta = safeAtan2(TSL, q.y, q.x);
  const wobble = float(1)
    .add(sin(theta.mul(3).add(vShape.z)).mul(float(0.22).mul(u('shapeIrregularity'))))
    .add(sin(theta.mul(5).add(vShape.w)).mul(float(0.12).mul(u('shapeIrregularity'))))
    .add(sin(theta.mul(2).sub(vShape.z)).mul(float(0.1).mul(u('shapeIrregularity'))));
  const r2 = dot(q, q).div(wobble.mul(wobble));
  const r = sqrt(r2);
  const focusShape = exp(r2.mul(u('pinpointTightness').negate()));
  // a soft lens disc: full at the middle and easing to nothing at the rim, so no ring shows
  const rim = float(1).sub(smoothstep(0.1, 0.95, r));
  const discShape = rim.mul(rim).mul(DISC_ENERGY);
  let shape = mix(focusShape, discShape, vInfo.z);
  if (plan.sparkle) {
    const qr = rotate(q, vSeed.mul(TAU));
    const star = exp(abs(qr.x).mul(-3).sub(abs(qr.y).mul(40)))
      .add(exp(abs(qr.y).mul(-3).sub(abs(qr.x).mul(40))))
      .mul(0.5);
    const halo = exp(r2.mul(-2.2)).mul(u('haloAmount'));
    shape = shape
      .add(
        star
          .mul(vInfo.w)
          .mul(vInfo.w)
          .mul(clamp(u('sparkle'), 0, 1))
          .mul(u('starAmount'))
      )
      .add(halo);
  }
  glow.colorNode = radiance.mul(shape).mul(vInfo.y);
  glow.opacityNode = vInfo.x.mul(gate);

  return { glow };
}
