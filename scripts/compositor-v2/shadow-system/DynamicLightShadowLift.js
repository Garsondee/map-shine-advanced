/**
 * @fileoverview Shared dynamic-light shadow lift plumbing.
 */

export function bindDynamicLightShadowLiftUniforms(uniforms, payload = null, fallbackStrength = 0.7) {
  if (!uniforms) return;
  const dynTex = payload?.texture ?? null;
  const winTex = payload?.windowTexture ?? null;
  if (uniforms.tDynamicLight) uniforms.tDynamicLight.value = dynTex;
  if (uniforms.tWindowLight) uniforms.tWindowLight.value = winTex;
  if (uniforms.uHasDynamicLight) uniforms.uHasDynamicLight.value = dynTex ? 1.0 : 0.0;
  if (uniforms.uHasWindowLight) uniforms.uHasWindowLight.value = winTex ? 1.0 : 0.0;
  if (uniforms.uDynamicLightShadowOverrideEnabled) {
    uniforms.uDynamicLightShadowOverrideEnabled.value = payload?.enabled === false ? 0.0 : 1.0;
  }
  if (uniforms.uDynamicLightShadowOverrideStrength) {
    const s = Number.isFinite(Number(payload?.strength)) ? Number(payload.strength) : fallbackStrength;
    uniforms.uDynamicLightShadowOverrideStrength.value = Math.max(0, Math.min(1, s));
  }
  const vb = payload?.viewBounds;
  if (uniforms.uDynViewBounds && vb) uniforms.uDynViewBounds.value.set(vb.x, vb.y, vb.z, vb.w);
  const sd = payload?.sceneDimensions;
  if (uniforms.uDynSceneDimensions && sd) uniforms.uDynSceneDimensions.value.set(sd.x, sd.y);
  const sr = payload?.sceneRect;
  if (uniforms.uDynSceneRect && uniforms.uHasDynSceneRect && sr) {
    uniforms.uDynSceneRect.value.set(sr.x, sr.y, sr.z, sr.w);
    uniforms.uHasDynSceneRect.value = 1.0;
  } else if (uniforms.uHasDynSceneRect) {
    uniforms.uHasDynSceneRect.value = 0.0;
  }
}

export const DYNAMIC_LIGHT_SHADOW_LIFT_GLSL = /* glsl */`
vec2 msa_sceneUvToDynScreenUv(vec2 sceneUv, vec4 dynSceneRect, vec2 dynSceneDimensions, vec4 dynViewBounds) {
  vec2 foundryPos = dynSceneRect.xy + sceneUv * max(dynSceneRect.zw, vec2(1e-5));
  vec2 threePos = vec2(foundryPos.x, dynSceneDimensions.y - foundryPos.y);
  vec2 span = max(dynViewBounds.zw - dynViewBounds.xy, vec2(1e-5));
  return (threePos - dynViewBounds.xy) / span;
}
`;
