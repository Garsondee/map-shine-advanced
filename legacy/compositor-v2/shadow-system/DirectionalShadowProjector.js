/**
 * @fileoverview Shared directional shadow projector scaffold.
 *
 * Phase 2 introduces the common API and per-pixel floor-id receiver contract.
 * Existing effect shaders are migrated into this class incrementally.
 */

import { bindDynamicLightShadowLiftUniforms } from './DynamicLightShadowLift.js';

export class DirectionalShadowProjector {
  constructor() {
    this.caster = { kind: 'texture', texture: null, flipY: false };
    this.receiverGate = { kind: 'none' };
    this.shape = { length: 0.1, softness: 4, smear: 0.33, penumbra: 1, curve: 1 };
    this.sun = { x: 0, y: -1 };
    this.dynamicLightOverride = null;
  }

  setCasterSource(caster = {}) {
    this.caster = { ...this.caster, ...caster };
  }

  setReceiverGate(receiverGate = {}) {
    this.receiverGate = { ...receiverGate };
  }

  setFloorIdReceiver({ floorIdTexture = null, outdoorsTextures = [], floorIdFlipY = true } = {}) {
    this.receiverGate = {
      kind: 'floor-id-outdoors',
      floorIdTexture,
      outdoorsTextures: Array.isArray(outdoorsTextures) ? outdoorsTextures.slice(0, 4) : [],
      floorIdFlipY: !!floorIdFlipY,
    };
  }

  setSun(sun = null) {
    const dir = sun?.dir ?? sun;
    const x = Number(dir?.x);
    const y = Number(dir?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) this.sun = { x, y };
  }

  setShape(shape = {}) {
    this.shape = { ...this.shape, ...shape };
  }

  setDynamicLightOverride(payload = null) {
    this.dynamicLightOverride = payload && typeof payload === 'object' ? payload : null;
  }

  bindCommonUniforms(uniforms) {
    if (!uniforms) return;
    if (uniforms.uSunDir) uniforms.uSunDir.value.set(this.sun.x, this.sun.y);
    if (uniforms.uLength) uniforms.uLength.value = Number(this.shape.length) || 0;
    if (uniforms.uSoftness) uniforms.uSoftness.value = Number(this.shape.softness) || 0;
    if (uniforms.uSmear) uniforms.uSmear.value = Number(this.shape.smear) || 0;
    if (uniforms.uPenumbra) uniforms.uPenumbra.value = Number(this.shape.penumbra) || 0;
    if (uniforms.uShadowCurve) uniforms.uShadowCurve.value = Number(this.shape.curve) || 1;
    bindDynamicLightShadowLiftUniforms(uniforms, this.dynamicLightOverride);
    if (uniforms.tFloorId) uniforms.tFloorId.value = this.receiverGate?.floorIdTexture ?? null;
    if (uniforms.uHasFloorId) uniforms.uHasFloorId.value = this.receiverGate?.floorIdTexture ? 1.0 : 0.0;
    if (uniforms.uFloorIdFlipY) {
      uniforms.uFloorIdFlipY.value = this.receiverGate?.floorIdFlipY !== false ? 1.0 : 0.0;
    }
    const masks = this.receiverGate?.outdoorsTextures ?? [];
    for (let i = 0; i < 4; i++) {
      const tex = masks[i] ?? null;
      if (uniforms[`tOutdoors${i}`]) uniforms[`tOutdoors${i}`].value = tex;
      if (uniforms[`uHasOutdoors${i}`]) uniforms[`uHasOutdoors${i}`].value = tex ? 1.0 : 0.0;
      if (uniforms[`uOutdoors${i}FlipY`]) uniforms[`uOutdoors${i}FlipY`].value = tex?.flipY ? 1.0 : 0.0;
    }
  }
}

export const FLOOR_ID_OUTDOORS_RECEIVER_GLSL = /* glsl */`
float msa_readAlphaAwareOutdoors(sampler2D tex, vec2 uv, float flipY) {
  vec2 suv = clamp(uv, 0.0, 1.0);
  if (flipY > 0.5) suv.y = 1.0 - suv.y;
  vec4 m = texture2D(tex, suv);
  return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
}

float msa_readFloorIdOutdoors(
  vec2 sceneUv,
  sampler2D tFloorId,
  float hasFloorId,
  float floorIdFlipY,
  sampler2D tOutdoors0,
  sampler2D tOutdoors1,
  sampler2D tOutdoors2,
  sampler2D tOutdoors3,
  float has0,
  float has1,
  float has2,
  float has3,
  float flip0,
  float flip1,
  float flip2,
  float flip3
) {
  if (hasFloorId < 0.5) {
    return has0 > 0.5 ? msa_readAlphaAwareOutdoors(tOutdoors0, sceneUv, flip0) : 1.0;
  }
  vec2 fidUv = clamp(sceneUv, 0.0, 1.0);
  if (floorIdFlipY > 0.5) fidUv.y = 1.0 - fidUv.y;
  float idx = floor(texture2D(tFloorId, fidUv).r * 255.0 + 0.5);
  if (idx < 0.5) return has0 > 0.5 ? msa_readAlphaAwareOutdoors(tOutdoors0, sceneUv, flip0) : 1.0;
  if (idx < 1.5) return has1 > 0.5 ? msa_readAlphaAwareOutdoors(tOutdoors1, sceneUv, flip1) : 1.0;
  if (idx < 2.5) return has2 > 0.5 ? msa_readAlphaAwareOutdoors(tOutdoors2, sceneUv, flip2) : 1.0;
  return has3 > 0.5 ? msa_readAlphaAwareOutdoors(tOutdoors3, sceneUv, flip3) : 1.0;
}
`;
