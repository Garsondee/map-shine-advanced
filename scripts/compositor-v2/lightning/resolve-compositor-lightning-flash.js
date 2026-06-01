/**
 * @fileoverview Read landscape + map-point lightning flash from MapShine environment.
 * @module compositor-v2/lightning/resolve-compositor-lightning-flash
 */

/**
 * @param {object|null|undefined} [env]
 * @returns {number} 0..1
 */
export function resolveCompositorLightningFlash01(env = null) {
  let bag = env;
  if (!bag) {
    try { bag = window.MapShine?.environment; } catch (_) { bag = null; }
  }
  const landscape01 = Math.max(0, Math.min(1, Number(bag?.landscapeLightningFlash01) || 0));
  const mapPoint01 = Math.max(0, Math.min(1, Number(bag?.lightningFlash01) || 0));
  return Math.max(landscape01, mapPoint01);
}

/**
 * Flash color + contrast weight for shader brightening (landscape wins over map-point).
 * @param {object|null|undefined} [env]
 * @returns {{ flash01: number, landscape01: number, mapPoint01: number, colorR: number, colorG: number, colorB: number, contrastMul: number }}
 */
export function resolveCompositorLightningFlash(env = null) {
  let bag = env;
  if (!bag) {
    try { bag = window.MapShine?.environment; } catch (_) { bag = null; }
  }

  const landscape01 = Math.max(0, Math.min(1, Number(bag?.landscapeLightningFlash01) || 0));
  const mapPoint01 = Math.max(0, Math.min(1, Number(bag?.lightningFlash01) || 0));
  const flash01 = Math.max(landscape01, mapPoint01);

  let colorR = 0.43;
  let colorG = 0.5;
  let colorB = 0.67;
  if (landscape01 >= mapPoint01 && landscape01 > 0) {
    const lr = Number(bag?.landscapeLightningFlashColorR);
    const lg = Number(bag?.landscapeLightningFlashColorG);
    const lb = Number(bag?.landscapeLightningFlashColorB);
    if (Number.isFinite(lr)) colorR = lr;
    if (Number.isFinite(lg)) colorG = lg;
    if (Number.isFinite(lb)) colorB = lb;
  } else if (mapPoint01 > 0) {
    colorR = 0.55;
    colorG = 0.62;
    colorB = 0.82;
  }

  const envContrast = Math.max(0, Number(bag?.landscapeLightningFlashContrast) || 0);
  const contrastMul = 1.0 + envContrast * 0.35;

  return {
    flash01,
    landscape01,
    mapPoint01,
    colorR: Math.max(0.01, colorR),
    colorG: Math.max(0.01, colorG),
    colorB: Math.max(0.01, colorB),
    contrastMul,
  };
}
