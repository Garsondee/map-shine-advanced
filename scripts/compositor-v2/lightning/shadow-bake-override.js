/**
 * @fileoverview Temporary sun/length/smear overrides for lightning shadow baking.
 */

/**
 * @param {object} effect
 * @returns {object|null}
 */
export function captureShadowBakeState(effect) {
  if (!effect) return null;
  return {
    azimuthDeg: effect._sunAzimuthDeg,
    elevationDeg: effect._sunElevationDeg,
    driverLengthScale: effect._driverShadowLengthScale,
    driverSmearScale: effect._driverShadowSmearScale,
    driverSoftnessScale: effect._driverShadowSoftnessScale,
    length: effect.params?.length,
    smear: effect.params?.smear,
    dynamicLightOverride: effect._dynamicLightOverride ?? null,
    bakeOverride: effect._lightningBakeOverride ?? null,
  };
}

/**
 * @param {object} effect
 * @param {object|null} snap
 */
export function restoreShadowBakeState(effect, snap) {
  if (!effect || !snap) return;
  if (typeof effect.setSunAngles === 'function') {
    effect.setSunAngles(snap.azimuthDeg, snap.elevationDeg);
  }
  effect._driverShadowLengthScale = snap.driverLengthScale;
  effect._driverShadowSmearScale = snap.driverSmearScale;
  effect._driverShadowSoftnessScale = snap.driverSoftnessScale;
  if (snap.length != null && effect.params) effect.params.length = snap.length;
  if (snap.smear != null && effect.params) effect.params.smear = snap.smear;
  if (typeof effect.setDynamicLightOverride === 'function') {
    effect.setDynamicLightOverride(snap.dynamicLightOverride);
  }
  effect._lightningBakeOverride = snap.bakeOverride ?? null;
}

/**
 * @param {object} effect
 * @param {{ azimuthDeg: number, elevationDeg: number, lengthMul?: number, smearMul?: number, lengthScale?: number, smearScale?: number }} opts
 */
export function applyShadowBakeOverride(effect, opts) {
  if (!effect || !opts) return;
  const az = Number(opts.azimuthDeg);
  const el = Number(opts.elevationDeg);
  if (typeof effect.setSunAngles === 'function') {
    effect.setSunAngles(az, el);
  }
  effect._driverShadowLengthScale = Number.isFinite(Number(opts.lengthScale)) ? Number(opts.lengthScale) : 1.0;
  effect._driverShadowSmearScale = Number.isFinite(Number(opts.smearScale)) ? Number(opts.smearScale) : 1.0;
  effect._driverShadowSoftnessScale = 1.0;
  if (typeof effect.setDynamicLightOverride === 'function') {
    effect.setDynamicLightOverride(null);
  }
  effect._lightningBakeOverride = {
    lengthMul: Math.max(0.05, Number(opts.lengthMul) || 1.0),
    smearMul: Math.max(0.05, Number(opts.smearMul) ?? 1.0),
  };
}

/**
 * Shortest-path azimuth interpolation (degrees).
 * @param {number} fromDeg
 * @param {number} toDeg
 * @param {number} t 0..1
 * @returns {number}
 */
export function lerpAzimuthDeg(fromDeg, toDeg, t) {
  let a = Number(fromDeg) || 0;
  let b = Number(toDeg) || 0;
  a = ((a % 360) + 360) % 360;
  b = ((b % 360) + 360) % 360;
  let delta = b - a;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return (a + delta * Math.max(0, Math.min(1, Number(t) || 0)) + 360) % 360;
}

/**
 * Blend captured sun state toward lightning bake target (1 = full lightning).
 * @param {object} effect
 * @param {object|null} snap from {@link captureShadowBakeState}
 * @param {{ azimuthDeg: number, elevationDeg: number, lengthMul?: number, smear?: number, lengthScale?: number, smearScale?: number }} lightning
 * @param {number} blend01
 */
export function applyPartialShadowBakeOverride(effect, snap, lightning, blend01) {
  if (!effect || !snap || !lightning) return;
  const t = Math.max(0, Math.min(1, Number(blend01) || 0));
  if (t <= 0) return;
  if (t >= 0.999) {
    applyShadowBakeOverride(effect, lightning);
    return;
  }
  const lengthMulLight = Math.max(0.05, Number(lightning.lengthMul) || 1.0);
  const smearMulLight = Math.max(0.05, Number(lightning.smearMul) ?? 1.0);
  applyShadowBakeOverride(effect, {
    azimuthDeg: lerpAzimuthDeg(snap.azimuthDeg, lightning.azimuthDeg, t),
    elevationDeg: (Number(snap.elevationDeg) || 0)
      + ((Number(lightning.elevationDeg) || 0) - (Number(snap.elevationDeg) || 0)) * t,
    lengthMul: 1 + (lengthMulLight - 1) * t,
    smearMul: 1 + (smearMulLight - 1) * t,
    lengthScale: 1 + ((Number(lightning.lengthScale) || 1) - 1) * t,
    smearScale: 1 + ((Number(lightning.smearScale) || 1) - 1) * t,
  });
}

/**
 * @param {object} effect
 * @param {number} baseLength
 * @returns {number}
 */
export function resolveBakeRayLength(effect, baseLength) {
  const ov = effect?._lightningBakeOverride;
  if (!ov) return baseLength;
  return baseLength * Math.max(0.05, Number(ov.lengthMul) || 1.0);
}

/**
 * @param {object} effect
 * @param {number} baseSmear
 * @returns {number}
 */
export function resolveBakeSmear(effect, baseSmear) {
  const ov = effect?._lightningBakeOverride;
  if (!ov) return baseSmear;
  const mul = Math.max(0.05, Number(ov.smearMul) || 1.0);
  return Math.max(0, Math.min(1, baseSmear * mul));
}
