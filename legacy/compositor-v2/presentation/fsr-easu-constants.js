/**
 * CPU-side FSR 1.0 EASU constants (from AMD FidelityFX FSR, MIT license).
 * @module compositor-v2/presentation/fsr-easu-constants
 */

/**
 * @param {number} inputViewportX
 * @param {number} inputViewportY
 * @param {number} inputSizeX
 * @param {number} inputSizeY
 * @param {number} outputX
 * @param {number} outputY
 * @returns {{ con0: number[], con1: number[], con2: number[], con3: number[] }}
 */
export function computeEasuConstants(
  inputViewportX,
  inputViewportY,
  inputSizeX,
  inputSizeY,
  outputX,
  outputY,
) {
  const ivx = Number(inputViewportX) || 1;
  const ivy = Number(inputViewportY) || 1;
  const isx = Number(inputSizeX) || ivx;
  const isy = Number(inputSizeY) || ivy;
  const ox = Number(outputX) || ivx;
  const oy = Number(outputY) || ivy;

  const con0 = [
    ivx / ox,
    ivy / oy,
    0.5 * ivx / ox - 0.5,
    0.5 * ivy / oy - 0.5,
  ];
  const con1 = [
    1 / isx,
    1 / isy,
    1 / isx,
    -1 / isy,
  ];
  const con2 = [
    -1 / isx,
    2 / isy,
    1 / isx,
    2 / isy,
  ];
  const con3 = [
    0,
    4 / isy,
    0,
    0,
  ];
  return { con0, con1, con2, con3 };
}
