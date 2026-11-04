/**
 * AUTO EXPOSURE RENDER — the meter shader (auto-exposure.js has the maths and the why).
 *
 * Pure builder: THREE/TSL is INJECTED, no renderer, no targets — the boundary bloom-render.js keeps.
 * The viewer owns the 96×54 FloatType target, draws this quad into it from runPostBloomPass AFTER the
 * bloom pyramid is built and BEFORE the bloom is composited, and reads it back asynchronously.
 *
 * One output cell = one patch of the screen:
 *   R = mean luminance of scene.lit over the patch (16 taps on a 4×4 grid — the bloom has not been
 *       added yet, so this is the scene's own light)
 *   G = mean luminance the bloom composite WILL add there (4 taps of the two bands, with the SAME
 *       uniform nodes the composite uses, so it measures exactly what is drawn), × uBloomOn
 *
 * @module effects/auto-exposure-render
 */

import { METER_W, METER_H } from './auto-exposure.js';

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.litTexture scene.lit's texture (linear HDR, before bloom)
 * @param {*} args.coreTexture the bloom CORE band (mips[0])
 * @param {*} args.atmoTexture the bloom ATMOSPHERE band (mips[atmoTop]; re-point `atmoTexNode.value` on a tier change)
 * @param {object} args.bloomUniforms bloom-render.js's `uniforms` (shared nodes: strength, coreStrength, …)
 * @param {*} [args.uViewRect] the camera's world rect (x0,y0,x1,y1), shared with the outdoors gate
 * @param {*} [args.uSceneRect] the map's world rect: cells outside it (the padding) read 0 = left out
 * @returns {{material:*, atmoTexNode:*, uBloomOn:*}}
 */
export function buildExposureMeterMaterial({
  THREE,
  litTexture,
  coreTexture,
  atmoTexture,
  bloomUniforms,
  uViewRect = null,
  uSceneRect = null,
}) {
  const TSL = THREE.TSL;
  const { texture, uv, vec2, vec3, vec4, float, uniform, Fn, dot, mix, step } = TSL;
  const lum = (c) => dot(c, vec3(0.2126, 0.7152, 0.0722));

  const litNode = texture(litTexture);
  const coreNode = texture(coreTexture);
  const atmoTexNode = texture(atmoTexture);
  const uBloomOn = uniform(0.0);
  const u = bloomUniforms;
  const cellX = 1 / METER_W;
  const cellY = 1 / METER_H;

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => {
    const base = uv();
    // SCENE: 16 taps, a 4×4 grid across the cell (offsets ±1/8, ±3/8 of a cell). Each bilinear tap
    // already averages a 2×2 texel quad, so a cell sees a fair sample of its patch.
    const offs = [-0.375, -0.125, 0.125, 0.375];
    let scene = float(0);
    for (const oy of offs) {
      for (const ox of offs) {
        const c = litNode.sample(base.add(vec2(cellX * ox, cellY * oy))).rgb.max(vec3(0));
        scene = scene.add(lum(c));
      }
    }
    scene = scene.mul(1 / 16);

    // BLOOM: what the composite adds, 4 taps (the bands are already blurred).
    const boffs = [-0.25, 0.25];
    let glow = float(0);
    for (const oy of boffs) {
      for (const ox of boffs) {
        const at = base.add(vec2(cellX * ox, cellY * oy));
        const core = coreNode.sample(at).rgb.mul(u.coreTint).mul(u.coreStrength);
        const atmo = atmoTexNode.sample(at).rgb.mul(u.atmoTint).mul(u.atmoStrength);
        glow = glow.add(lum(core.add(atmo).mul(u.strength)));
      }
    }
    glow = glow.mul(0.25).mul(uBloomOn).max(0);

    // THE PADDING: grey margin around the map is not the scene and must not pull the median down.
    if (uViewRect && uSceneRect) {
      const wx = mix(uViewRect.x, uViewRect.z, base.x);
      const wy = mix(uViewRect.y, uViewRect.w, base.y);
      const inside = step(uSceneRect.x, wx)
        .mul(step(wx, uSceneRect.z))
        .mul(step(uSceneRect.y, wy))
        .mul(step(wy, uSceneRect.w));
      scene = scene.mul(inside);
      glow = glow.mul(inside);
    }
    return vec4(scene, glow, 0, 1);
  })();
  material.name = 'AutoExposure_meter';

  return { material, atmoTexNode, uBloomOn };
}
