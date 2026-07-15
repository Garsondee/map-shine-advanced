/**
 * @fileoverview Shared screen-space sun direction for shadow stamp/projection effects.
 */

import {
  getUnifiedShadowLatitudeScale,
  resolveShadowSunAnglesDeg,
} from './SunDirection.js';

const ZENITH_EPS = 0.02;
const MIN_DIR_LEN_SQ = 1e-8;
/** Minimum shadow length factor at high sun (short underfoot shadows, not off). */
const MIN_SHADOW_LENGTH_FACTOR = 0.15;

/**
 * @param {object} opts
 * @param {number} opts.azimuthRad
 * @param {number|null|undefined} opts.elevationDeg
 * @param {number} opts.latitudeScale 0..1 (sunLatitude)
 * @param {import('three').Vector2|null} opts.previousDir
 * @returns {{ x: number, y: number, lengthSq: number, atZenith: boolean }}
 */
export function computeShadowSunDirection2D({
  azimuthRad,
  elevationDeg = null,
  latitudeScale = 0.1,
  previousDir = null,
}) {
  const lat = Math.max(0, Math.min(1, Number(latitudeScale) || 0));

  if (Number.isFinite(elevationDeg)) {
    const el = (Number(elevationDeg) * Math.PI) / 180;
    const cosEl = Math.cos(el);
    const sinEl = Math.sin(el);
    const latClamped = Math.max(lat, 0.05);
    // Near zenith the horizontal component vanishes — keep a stable azimuth hint
    // instead of zeroing direction (which hard-disables all projected shadows).
    const horizScale = Math.max(Math.abs(cosEl), 0.001);
    let x = -Math.sin(azimuthRad) * horizScale;
    let y = -Math.cos(azimuthRad) * horizScale * latClamped;
    let lengthSq = (x * x) + (y * y);
    if (lengthSq < MIN_DIR_LEN_SQ) {
      x = -Math.sin(azimuthRad);
      y = -Math.cos(azimuthRad) * latClamped;
      lengthSq = (x * x) + (y * y);
    }
    const atZenith = sinEl > 1 - ZENITH_EPS;
    if (lengthSq < MIN_DIR_LEN_SQ) {
      const prevX = Number(previousDir?.x);
      const prevY = Number(previousDir?.y);
      const prevLenSq = (prevX * prevX) + (prevY * prevY);
      if (Number.isFinite(prevLenSq) && prevLenSq > MIN_DIR_LEN_SQ) {
        x = prevX;
        y = prevY;
        lengthSq = prevLenSq;
      } else {
        x = Math.cos(azimuthRad) >= 0 ? -1 : 1;
        y = 0;
        lengthSq = 1;
      }
    }
    const invLen = 1 / Math.sqrt(lengthSq);
    // Length fades toward zenith but never snaps to zero (avoids noon pop-off).
    const lengthFactor = Math.max(MIN_SHADOW_LENGTH_FACTOR, sinEl);
    return {
      x: x * invLen,
      y: y * invLen,
      lengthSq: lengthFactor * lengthFactor,
      atZenith,
    };
  }

  let x = -Math.sin(azimuthRad);
  let y = -Math.cos(azimuthRad) * lat;
  let lengthSq = (x * x) + (y * y);

  if (lengthSq < MIN_DIR_LEN_SQ) {
    const prevX = Number(previousDir?.x);
    const prevY = Number(previousDir?.y);
    const prevLenSq = (prevX * prevX) + (prevY * prevY);
    if (Number.isFinite(prevLenSq) && prevLenSq > MIN_DIR_LEN_SQ) {
      x = prevX;
      y = prevY;
      lengthSq = prevLenSq;
    } else {
      x = Math.cos(azimuthRad) >= 0 ? -1 : 1;
      y = 0;
      lengthSq = 1;
    }
  }

  const invLen = lengthSq > MIN_DIR_LEN_SQ ? 1 / Math.sqrt(lengthSq) : 1;
  return {
    x: x * invLen,
    y: y * invLen,
    lengthSq: lengthSq > MIN_DIR_LEN_SQ ? 1 : 0,
    atZenith: false,
  };
}

/**
 * @param {import('three').Vector2} out
 * @param {ReturnType<typeof computeShadowSunDirection2D>} dir
 */
export function applyShadowSunDirection(out, dir) {
  out.set(dir.x, dir.y);
}

/**
 * Build the canonical 2D sun vector for any shadow consumer from azimuth/elevation.
 * @param {object} opts
 * @param {number|null|undefined} opts.azimuthDeg
 * @param {number|null|undefined} opts.elevationDeg
 * @param {number} [opts.latitudeScale]
 * @param {{x:number,y:number}|null} [opts.previousDir]
 * @returns {ReturnType<typeof computeShadowSunDirection2D> & { azimuthDeg: number, elevationDeg: number }}
 */
export function resolveEffectShadowSun2D({
  azimuthDeg = null,
  elevationDeg = null,
  latitudeScale = null,
  previousDir = null,
} = {}) {
  const angles = resolveShadowSunAnglesDeg(azimuthDeg, elevationDeg);
  const lat = Number.isFinite(Number(latitudeScale))
    ? Number(latitudeScale)
    : getUnifiedShadowLatitudeScale();
  const sun2d = computeShadowSunDirection2D({
    azimuthRad: angles.azimuthDeg * (Math.PI / 180.0),
    elevationDeg: angles.elevationDeg,
    latitudeScale: lat,
    previousDir,
  });
  return { ...sun2d, azimuthDeg: angles.azimuthDeg, elevationDeg: angles.elevationDeg };
}

/**
 * Copy resolved sun direction into an effect's `sunDir` Vector2.
 * @param {import('three').Vector2|null} sunDir
 * @param {ReturnType<typeof resolveEffectShadowSun2D>} sun2d
 * @param {typeof import('three')} THREE
 */
export function writeEffectSunDir(sunDir, sun2d, THREE) {
  if (!THREE) return sunDir;
  if (!sunDir) return new THREE.Vector2(sun2d.x, sun2d.y);
  sunDir.set(sun2d.x, sun2d.y);
  return sunDir;
}

/**
 * Legacy alias — unified with {@link resolveEffectShadowSun2D}.
 * @param {number|null|undefined} azimuthDeg
 * @param {number|null|undefined} elevationDeg
 * @param {number} [latitudeScale=0.1]
 * @param {{x:number,y:number}|null} [fallback=null]
 */
export function computeSunDirection2D(azimuthDeg, elevationDeg, latitudeScale = 0.1, fallback = null) {
  const sun2d = resolveEffectShadowSun2D({
    azimuthDeg,
    elevationDeg,
    latitudeScale,
    previousDir: fallback,
  });
  return {
    x: sun2d.x,
    y: sun2d.y,
    azimuthDeg: sun2d.azimuthDeg,
    elevationDeg: sun2d.elevationDeg,
    lengthSq: sun2d.lengthSq,
  };
}
