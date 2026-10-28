/**
 * TEMPERATURE EFFECTS' SURFACE — the frost frame and the heat ripple, as node
 * builders the present material folds in (`grade/grade-present.js`). THREE is
 * injected as `TSL`, never imported.
 *
 * Both layers do the cheapest thing that reads right (the author: *"higher
 * rendering performance is more important than visual fidenlity"*):
 *
 *  - FROST is two taps of the baked tile (`temperature-noise.js`) at screen
 *    UV. The frost line is a distance-from-the-frame test, pushed in and out
 *    by the tile's smooth channel and reaching further into the corners; its
 *    slope channel offsets where the present samples the scene (refraction —
 *    one tap of the scene, no blur taps), and a pale veil plus crystal glints
 *    go on top.
 *  - HEAT RIPPLE is two taps of the tile's smooth channel at WORLD position
 *    (so the shimmer sits on the ground as the camera pans), stretched
 *    vertically and scrolled upward on the CPU, scaled by the `_Outdoors`
 *    gate.
 *
 * ⚠️ COMPILED IN ONLY WHILE SHOWING (`tsl/no-uniform-gates`, Effects.md Law 4):
 * the present builds these nodes only when the viewer says frost / ripple is
 * on, so a temperate scene's present is byte-for-byte the shader it was.
 *
 * @module effects/temperature/temperature-render
 */

/**
 * The live values both layers read. Packed into vec4s where they always move
 * together, to stay well clear of the per-file uniform cap.
 * @param {*} TSL
 */
export function createTemperatureUniforms(TSL) {
  const { uniform, float, vec2, vec3, vec4 } = TSL;
  return {
    /** Eased frost coverage 0..1 (the CPU's grown amount). */
    frostCover: uniform(float(0)),
    /** (reach, raggedness, corner bias, mat softness). */
    frostShape: uniform(vec4(0.26, 0.6, 0.65, 0.45)),
    /** Crystal tiles per screen height. */
    frostScale: uniform(float(1.8)),
    /** Refraction distance in UV units, (px / width, px / height). */
    frostRefractUv: uniform(vec2(0, 0)),
    /** (opacity, glints, scene light 0..1, 0). */
    frostLook: uniform(vec4(0.4, 0.3, 1, 0)),
    frostTint: uniform(vec3(0.89, 0.95, 1)),
    /** Ripple distance in UV units, (px / width, px / height). */
    heatAmpUv: uniform(vec2(0, 0)),
    /** The two taps' rising scroll, texture space. */
    heatScroll: uniform(vec2(0, 0)),
    /** World pixels per ripple cell. */
    heatScale: uniform(float(320)),
  };
}

/**
 * The frost frame at a screen UV.
 * @param {*} TSL
 * @param {object} args
 * @param {*} args.uvNode - the screen UV (0..1, y down).
 * @param {*} args.aspectNode - screen width / height.
 * @param {*} args.noiseTexNode - the baked tile's texture node (repeat-wrapped).
 * @param {ReturnType<typeof createTemperatureUniforms>} args.u
 * @returns {{cover:*, mat:*, ferns:*, crystal:*, offsetUv:*}} coverage 0..1, the solid rim mat, the open
 *   crystals, the raw crystal value, and the refraction offset.
 */
export function buildFrostNodes(TSL, { uvNode, aspectNode, noiseTexNode, u }) {
  const { vec2, float, min, max, mix, smoothstep } = TSL;
  const x = uvNode.x;
  const y = uvNode.y;
  // Distance to the frame in screen heights; the harmonic blend of the two
  // axes halves it on the diagonal, so the corners fill first.
  const dx = min(x, float(1).sub(x)).mul(aspectNode);
  const dy = min(y, float(1).sub(y));
  const d = mix(min(dx, dy), dx.mul(dy).div(dx.add(dy).add(1e-4)), u.frostShape.z);

  const tuv = vec2(x.mul(aspectNode), y).mul(u.frostScale);
  const tap = noiseTexNode.sample(tuv);
  const broad = noiseTexNode.sample(tuv.mul(0.21).add(vec2(0.37, 0.71))).a;

  const reach = u.frostShape.x.mul(u.frostCover);
  const edge = max(reach.mul(float(1).add(broad.sub(0.5).mul(2).mul(u.frostShape.y))), float(1e-4));
  const r = d.div(edge);
  const live = reach.greaterThan(1e-4).select(float(1), float(0));
  // A dense mat hugging the frame, then open crystals out to the frost line.
  const soft = u.frostShape.w;
  const mat = float(1)
    .sub(smoothstep(float(0.2), float(0.25).add(soft.mul(0.6)), r))
    .mul(live);
  const crystal = tap.r;
  const ferns = crystal.mul(float(1).sub(smoothstep(float(0.55), float(1), r))).mul(live);
  const cover = max(mat.mul(crystal.mul(0.45).add(0.55)), ferns);

  // Refraction: the crystals' own slopes, plus a broad lens wobble from the
  // smooth channel (both already fetched) so the frozen mat bends the scene
  // like thick ice, not only along crystal edges.
  const slope = vec2(tap.g, tap.b).sub(0.5).mul(2);
  const wobble = vec2(tap.a.sub(0.5), broad.sub(0.5)).mul(1.6);
  const offsetUv = slope.mul(0.7).add(wobble.mul(mat)).mul(u.frostRefractUv).mul(cover);
  return { cover, mat, ferns, crystal, offsetUv };
}

/**
 * Lay the frost over the finished colour: the light through the ice cools,
 * a pale veil whitens where the frost is thick, and crystal edges glint. All
 * of it scales with the scene's light, so night frost stays dim.
 * @param {*} TSL @param {*} rgb @param {{cover:*, crystal:*}} frost
 * @param {ReturnType<typeof createTemperatureUniforms>} u
 */
export function applyFrostLayer(TSL, rgb, frost, u) {
  const { vec3, float, mix } = TSL;
  const light = u.frostLook.z;
  const cooled = rgb.mul(mix(vec3(1, 1, 1), u.frostTint, frost.cover.mul(0.55)));
  // White where the mat is solid, crystal-shaped where it opens out.
  const veil = frost.mat.mul(0.8).add(frost.ferns.mul(0.9)).clamp(0, 1).mul(u.frostLook.x);
  const veiled = mix(cooled, u.frostTint.mul(light), veil);
  const glint = frost.crystal.mul(frost.crystal).mul(frost.cover).mul(u.frostLook.y).mul(light);
  return veiled.add(u.frostTint.mul(glint)).max(float(0));
}

/**
 * The heat ripple's sample offset at a world position.
 * @param {*} TSL
 * @param {object} args
 * @param {*} args.worldXY - the pixel's world position.
 * @param {*} args.noiseTexNode
 * @param {*|null} args.gate - the `_Outdoors` gate (0..1), or null for "everywhere".
 * @param {ReturnType<typeof createTemperatureUniforms>} args.u
 * @param {readonly number[]} args.yFreq - `temperature.js#HEAT_TAP_Y_FREQ`, matched by the CPU scroll.
 */
export function buildHeatRippleOffset(TSL, { worldXY, noiseTexNode, gate, u, yFreq }) {
  const { vec2 } = TSL;
  const p = worldXY.div(u.heatScale);
  const a = noiseTexNode.sample(vec2(p.x, p.y.mul(yFreq[0]).add(u.heatScroll.x))).a.sub(0.5);
  const b = noiseTexNode.sample(vec2(p.x.mul(1.7).add(0.43), p.y.mul(yFreq[1]).add(u.heatScroll.y))).a.sub(0.5);
  // Mostly vertical, like shimmer over hot ground.
  const wobble = vec2(a.mul(0.6).add(b.mul(0.3)), b.add(a.mul(0.5))).mul(2.4);
  const off = wobble.mul(u.heatAmpUv);
  return gate ? off.mul(gate) : off;
}
