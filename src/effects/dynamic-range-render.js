/**
 * DYNAMIC RANGE RENDER — the meter shader and the per-pixel transform's TSL twin (dynamic-range.js has
 * the maths and the why; every function here mirrors one there, line for line).
 *
 * Pure builders: THREE/TSL injected, no renderer, no targets. ONE uniform set
 * ({@link createDynamicRangeUniforms}) is shared by the present pass (the picture) and bloom's bright
 * pass (what glows), so the two can never disagree about what reads past white.
 *
 * @module effects/dynamic-range-render
 */

import {
  METER_W,
  METER_H,
  GREY_CARD_SRGB,
  LIGHT_FLOOR_STOPS,
  DRAMA_RANGE,
  LIGHT_RANGE_RATIO,
  KNEE_SOFT,
  PUNCH_RANGE,
  DR_WHITEN,
  MATERIAL_DRAMA,
  MATERIAL_DRAMA_RANGE,
} from './dynamic-range.js';
import { buildHighlightRolloffNode } from './grade/grade-ops.js';

/**
 * The shared, packed uniforms: a = (on, ev, mid, drama), b = (punch, punchFrom, shadowDepth, colour),
 * c = (lightRange, glareThreshold, —, —). `on` 0 = the transform returns its input exactly. `c.y` is the
 * glare's threshold in exposed units (Bloom's "Glow from"), which the meter needs for the glare budget.
 * @param {*} THREE
 */
export function createDynamicRangeUniforms(THREE) {
  const { uniform } = THREE.TSL;
  return {
    a: uniform(new THREE.Vector4(0, 0, 0.05, 1)),
    b: uniform(new THREE.Vector4(1, 1.25, 1, 1)),
    c: uniform(new THREE.Vector4(3, 0, 0, 0)),
  };
}

/**
 * Write a curve (dynamic-range.js#curveFor) into the shared uniforms, or turn the transform off.
 * @param {ReturnType<typeof createDynamicRangeUniforms>} U @param {object|null} curve
 */
export function writeDynamicRangeUniforms(U, curve) {
  if (!curve) {
    U.a.value.x = 0;
    return;
  }
  const v = (key, fb) => (Number.isFinite(Number(curve[key])) ? Number(curve[key]) : fb);
  U.a.value.set(1, v('ev', 0), v('mid', 0.05), v('drama', 1));
  U.b.value.set(v('punch', 1), v('punchFrom', 1.25), v('shadowDepth', 1), v('colour', 1));
  U.c.value.x = v('lightRange', 3);
}

/** The glare threshold the meter's budget channels count against (exposed units; bloom's threshold). */
export function writeGlareThreshold(U, threshold) {
  U.c.value.y = Number.isFinite(Number(threshold)) ? Math.max(0, Number(threshold)) : 1;
}

/** What the uniforms hold now (console readout). */
export function readDynamicRangeUniforms(U) {
  const a = U.a.value;
  const b = U.b.value;
  return {
    on: a.x,
    ev: a.y,
    mid: a.z,
    drama: a.w,
    punch: b.x,
    punchFrom: b.y,
    shadowDepth: b.z,
    colour: b.w,
    lightRange: U.c.value.x,
  };
}

/** dynamic-range.js#softAbove. */
function softAbove(TSL, x) {
  const { clamp, select } = TSL;
  const t = clamp(x.add(KNEE_SOFT), 0, 2 * KNEE_SOFT);
  return select(x.greaterThan(KNEE_SOFT), x, t.mul(t).div(4 * KNEE_SOFT));
}

/** sRGB transfer → linear, one channel (TSL). */
function srgbToLinearNode(TSL, x) {
  const { select, pow } = TSL;
  return select(x.lessThanEqual(0.04045), x.div(12.92), pow(x.add(0.055).div(1.055).max(0), 2.4));
}

/**
 * dynamic-range.js#drGain — the per-pixel exposure gain `g`, curve gain `k` and exposed luminance `L`.
 * @param {*} TSL @param {*} rgb scene.lit vec3 @param {*} illumRgb scene.illum vec3
 * @param {ReturnType<typeof createDynamicRangeUniforms>} U
 */
export function buildDynamicRangeGainNode(TSL, rgb, illumRgb, U, colorationRgb = null) {
  const { vec3, float, pow, log2, dot, max, min, clamp } = TSL;
  const W = vec3(0.2126, 0.7152, 0.0722);
  const ev = U.a.y;
  const mid = U.a.z.max(1e-5);
  const drama = U.a.w;
  const punch = U.b.x;
  const punchFrom = U.b.y;
  const shadowDepth = U.b.z;
  const lightRange = U.c.x;
  const g = pow(float(2), ev);
  const L = dot(max(rgb, vec3(0)), W)
    .mul(g)
    .max(1e-6);
  // Coloration (Foundry's coloured light) counts as LIGHT — dynamic-range.js#drGain.
  const cardIllum = srgbToLinearNode(TSL, min(dot(max(illumRgb, vec3(0)), W).mul(GREY_CARD_SRGB), float(64)));
  const cardRaw = (colorationRgb ? cardIllum.add(dot(max(colorationRgb, vec3(0)), W)) : cardIllum).mul(g);
  const card = max(cardRaw, mid.mul(2 ** -LIGHT_FLOOR_STOPS));
  const lLight = log2(card.div(mid));
  const r = log2(L.div(card));
  // The light term: drama within ±DRAMA_RANGE, shadows floored, then the soft light-range cap.
  const dramatic = lLight.add(drama.sub(1).mul(clamp(lLight, -DRAMA_RANGE, DRAMA_RANGE)));
  const floored = TSL.select(lLight.lessThan(0), max(dramatic, lLight.sub(shadowDepth)), dramatic);
  const lightOut = floored.sub(softAbove(TSL, floored.sub(lightRange)).mul(1 - LIGHT_RANGE_RATIO));
  // The material term: half of drama, then the punch.
  const materialContrast = drama
    .sub(1)
    .mul(MATERIAL_DRAMA)
    .mul(clamp(r, -MATERIAL_DRAMA_RANGE, MATERIAL_DRAMA_RANGE));
  const s = softAbove(TSL, r.sub(punchFrom));
  const materialGain = materialContrast.add(punch.sub(1).mul(s.div(s.div(PUNCH_RANGE).add(1))));
  const k = pow(float(2), lightOut.sub(lLight).add(materialGain));
  return { g, k, L };
}

/**
 * dynamic-range.js#drTransform — scene.lit → display-ready linear RGB, mixed by `on` (0 = the input).
 * `glareRgb` (bloom's glow, scene-referred) joins after the curve at the exposure only, before the shoulder.
 * @param {*} TSL @param {*} rgb @param {*} illumRgb @param {ReturnType<typeof createDynamicRangeUniforms>} U
 * @param {*} [colorationRgb] @param {*} [glareRgb]
 */
export function buildDynamicRangeNode(TSL, rgb, illumRgb, U, colorationRgb = null, glareRgb = null) {
  const { vec3, float, max, clamp, log2, mix } = TSL;
  const { g, k, L } = buildDynamicRangeGainNode(TSL, rgb, illumRgb, U, colorationRgb);
  const graded = max(rgb, vec3(0)).mul(g.mul(k));
  const L2 = L.mul(k);
  const w = clamp(
    log2(L2.div(U.a.z.max(1e-5)))
      .add(1)
      .div(3),
    0,
    1
  );
  const sat = float(1).add(U.b.w.sub(1).mul(w));
  const coloured = max(vec3(L2).add(graded.sub(vec3(L2)).mul(sat)), vec3(0));
  // The glare arrives already exposed (the bloom pyramid is built at this camera's exposure). With the camera
  // off it still joins here, on the plain picture (one glare path, camera on or off).
  const glare = glareRgb ? max(glareRgb, vec3(0)) : null;
  const withGlare = glare ? coloured.add(glare) : coloured;
  const plain = glare ? rgb.add(glare) : rgb;
  return mix(plain, buildHighlightRolloffNode(TSL, withGlare, undefined, DR_WHITEN), U.a.x);
}

/**
 * The camera's exposure gain as a node: 2^ev while the camera is on, exactly 1 while it is off
 * (dynamic-range.js#drExposedBrightness). Bloom's bright pass and the meter's glare channels scale by it.
 * @param {*} TSL @param {ReturnType<typeof createDynamicRangeUniforms>} U
 */
export function buildExposureGainNode(TSL, U) {
  const { float, pow, mix } = TSL;
  return mix(float(1), pow(float(2), U.a.y), U.a.x);
}

/**
 * The meter: one cell = one patch of the screen, 16 taps on a 4×4 grid.
 *   R = mean luminance of scene.lit, G = mean luminance of scene.illum,
 *   B = mean bright EXCESS at the camera's exposure (max channel × 2^ev over the glare threshold `c.y`),
 *   A = share of taps over that threshold (B and A feed the glare budget; 0 without `dynamicRangeUniforms`).
 * Cells outside the map rect read 0 and are left out (the padding is not the scene).
 * @param {object} args
 * @param {*} args.THREE @param {*} args.litTexture @param {*} args.illumTexture
 * @param {*} [args.uViewRect] the camera's world rect @param {*} [args.uSceneRect] the map's world rect
 * @param {ReturnType<typeof createDynamicRangeUniforms>|null} [args.dynamicRangeUniforms]
 * @returns {{material:*}}
 */
export function buildDynamicRangeMeterMaterial({
  THREE,
  litTexture,
  illumTexture,
  uViewRect = null,
  uSceneRect = null,
  dynamicRangeUniforms = null,
}) {
  const TSL = THREE.TSL;
  const { texture, uv, vec2, vec3, vec4, float, Fn, dot, mix, step, max } = TSL;
  const gain = dynamicRangeUniforms ? buildExposureGainNode(TSL, dynamicRangeUniforms) : null;
  const glareT = dynamicRangeUniforms ? dynamicRangeUniforms.c.y : null;
  const lum = (c) => dot(c.max(vec3(0)), vec3(0.2126, 0.7152, 0.0722));
  const litNode = texture(litTexture);
  const illumNode = texture(illumTexture);
  const cellX = 1 / METER_W;
  const cellY = 1 / METER_H;

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => {
    const base = uv();
    const offs = [-0.375, -0.125, 0.125, 0.375];
    let lit = float(0);
    let ill = float(0);
    let excess = float(0);
    let cover = float(0);
    for (const oy of offs) {
      for (const ox of offs) {
        const at = base.add(vec2(cellX * ox, cellY * oy));
        const c = litNode.sample(at).rgb;
        lit = lit.add(lum(c));
        ill = ill.add(lum(illumNode.sample(at).rgb));
        if (gain) {
          const br = max(max(c.x, c.y), c.z).max(0).mul(gain);
          excess = excess.add(br.sub(glareT).max(0));
          cover = cover.add(step(glareT, br));
        }
      }
    }
    lit = lit.mul(1 / 16);
    ill = ill.mul(1 / 16);
    excess = excess.mul(1 / 16);
    cover = cover.mul(1 / 16);
    if (uViewRect && uSceneRect) {
      const wx = mix(uViewRect.x, uViewRect.z, base.x);
      const wy = mix(uViewRect.y, uViewRect.w, base.y);
      const inside = step(uSceneRect.x, wx)
        .mul(step(wx, uSceneRect.z))
        .mul(step(uSceneRect.y, wy))
        .mul(step(wy, uSceneRect.w));
      lit = lit.mul(inside);
      ill = ill.mul(inside);
      excess = excess.mul(inside);
      cover = cover.mul(inside);
    }
    return vec4(lit, ill, excess, cover);
  })();
  material.name = 'DynamicRange_meter';
  return { material };
}
