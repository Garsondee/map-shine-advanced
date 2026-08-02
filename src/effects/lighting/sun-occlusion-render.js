/**
 * SUN OCCLUSION, ON THE GPU — the read side of the baked shadow field.
 *
 * BROWSER-ONLY (builds TSL; verified live against real Foundry data, never a
 * mocked THREE — CONVENTIONS.md §4, the same split `buildUiShadowVisibility` and
 * `buildPointLightIlluminationMaterial` already draw).
 *
 * ============================================================================
 * WHAT THIS FILE IS NOW (2026-08-02)
 * ============================================================================
 *
 * This file used to hold two bake materials as well — a height-field march
 * and an averaged-mean smear. Both are retired
 * (`docs/planning/Sun-Shadows-Layer-Smear.md` §8 has the retirement notes);
 * the model now lives in `layer-smear.js` + `layer-smear-render.js`, which
 * builds its own bake material directly rather than through this file. What
 * remains is the one piece that was always model-agnostic:
 *
 * {@link buildSunVisibilityNode} — the READ. One clamped texture fetch,
 * folded into the ambient-fill shader that already runs. That is the entire
 * per-frame cost of every cast shadow in the scene, regardless of which model
 * baked the field it's reading.
 *
 * ⚠️ THE PLACEMENT RULE, stated because a future session WILL be tempted to
 * "unify" it with the UI-window shadow: this multiplies the AMBIENT FILL, before
 * the point lights accumulate. The UI shadow multiplies in the COMPOSITE, after
 * them. Both are correct, for opposite reasons — the UI shadow is a decorative
 * key over the whole picture, while this gates ONE light (the sun) and nothing
 * else. Moving this after the lights would make a torch standing inside a
 * building's shadow read DIMMER than the same torch outside it: the
 * `DynamicLightShadowLift` bug, in mirror image, rebuilt by accident. The author
 * stated the model independently on 2026-07-24 — *"passive light is the sunlight
 * which cannot overpower these shadows because it's the light that produces
 * these shadows, then 'active' lights are ones brought in afterwards which
 * overpower these shadows"* — and MAX-after-multiply is exactly that sentence.
 *
 * @module effects/lighting/sun-occlusion-render
 */

/**
 * THE READ — a scalar 0..1 sun-visibility node for a fullscreen pass, sampled at
 * the world position under this screen pixel.
 *
 * Deliberately takes the CALLER's `uViewRect` (the camera's world rect) rather
 * than building its own: `environmental-light.js` already owns that uniform and
 * updates it once per frame beside `setAmbient`. A second copy is precisely how
 * the outdoors gate and the shadow field would end up covering different halves
 * of the map — the drift `buildOutdoorsGate` exists to prevent, one buffer over.
 *
 * Returns `null` when no field texture is supplied, so the whole lookup is
 * compiled OUT rather than multiplied by a one (`tsl/no-uniform-gates`, and the
 * same JS-time-branch shape the sky gate uses).
 *
 * @param {*} TSL - THREE.TSL.
 * @param {object} args
 * @param {*} args.uViewRect - vec4 uniform, the camera world rect.
 * @param {*} args.uShadowRect - vec4 uniform, the rect the shadow field covers.
 * @param {*} args.shadowTexNode - the baked field's texture node, or null.
 * @returns {*|null} scalar node, 1 = full sun.
 */
export function buildSunVisibilityNode(TSL, { uViewRect, uShadowRect, shadowTexNode }) {
  if (!shadowTexNode) return null;
  const { uv, vec2, mix } = TSL;
  const worldX = mix(uViewRect.x, uViewRect.z, uv().x);
  const worldY = mix(uViewRect.y, uViewRect.w, uv().y);
  const u = worldX.sub(uShadowRect.x).div(uShadowRect.z.sub(uShadowRect.x));
  const v = worldY.sub(uShadowRect.y).div(uShadowRect.w.sub(uShadowRect.y));
  return shadowTexNode.sample(vec2(u.clamp(0, 1), v.clamp(0, 1))).r;
}
