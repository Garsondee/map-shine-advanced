/**
 * Tweakpane-driven defringing for upper-floor indoor/outdoor masks.
 * Strength 0 = permissive (legacy soft edges); 1 = aggressive tile-footprint gate.
 *
 * @module masks/indoor-outdoor-defringe
 */

const clamp01 = (v, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
};

const lerp = (a, b, t) => a + (b - a) * t;

const smoothstepJs = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / Math.max(1e-6, edge1 - edge0), 0);
  return t * t * (3 - 2 * t);
};

/**
 * @param {number} raw
 * @param {number} lo
 * @param {number} hi
 * @param {number} hardness
 * @returns {number}
 */
export function defringeCoverageJs(raw, lo, hi, hardness) {
  const soft = smoothstepJs(lo, hi, clamp01(raw, 0));
  const mid = lo + (hi - lo) * 0.5;
  const hard = clamp01(raw, 0) >= mid ? 1 : 0;
  return soft * (1 - clamp01(hardness, 0)) + hard * clamp01(hardness, 0);
}

/**
 * Indoor weight from stacked effective mask (R=outdoor, A=coverage).
 *
 * @param {number} outdoorClass
 * @param {number} coverage
 * @param {IndoorOutdoorDefringeParams} [params]
 * @returns {number}
 */
export function estimateStackedIndoorWeight(outdoorClass, coverage, params = null) {
  const p = params ?? getIndoorOutdoorDefringeParams();
  const outdoor = clamp01(outdoorClass, 0);
  if (outdoor >= 0.82) return 0;
  const cov = defringeCoverageJs(coverage, p.stackValidityLow, p.stackValidityHigh, p.hardness);
  if (cov < p.indoorCoverageMin) return 0;
  return (1 - outdoor) * cov;
}

/**
 * @typedef {object} IndoorOutdoorDefringeParams
 * @property {number} strength
 * @property {number} footprintLow
 * @property {number} footprintHigh
 * @property {number} indoorFootprintMin
 * @property {number} floorAlphaSharpenLow
 * @property {number} floorAlphaSharpenHigh
 * @property {number} outdoorsAlphaLow
 * @property {number} outdoorsAlphaHigh
 * @property {number} hardness
 * @property {number} edgeOutdoorBias
 * @property {number} stackValidityLow
 * @property {number} stackValidityHigh
 * @property {number} indoorCoverageMin
 */

/**
 * @param {object|null} [globalParams]
 * @returns {IndoorOutdoorDefringeParams}
 */
export function getIndoorOutdoorDefringeParams(globalParams = null) {
  const tp = globalParams ?? (typeof window !== 'undefined' ? window.MapShine?.uiManager?.globalParams : null)
    ?? (typeof window !== 'undefined' ? window.MapShine?.tweakpaneManager?.globalParams : null)
    ?? {};

  const strength = clamp01(tp.indoorOutdoorDefringeStrength, 0.95);
  const bias = clamp01(tp.indoorOutdoorDefringeIndoorCutoff, 0.75);
  const edgeBleed = clamp01(tp.indoorOutdoorDefringeEdgeOutdoor, strength);

  const footprintLow = lerp(0.04, 0.92, strength);
  const footprintHigh = lerp(0.35, 0.9995, strength);
  const indoorFootprintMin = lerp(0.35, lerp(0.94, 0.999, strength), bias);

  return {
    strength,
    footprintLow,
    footprintHigh,
    indoorFootprintMin,
    floorAlphaSharpenLow: lerp(0.08, 0.72, strength),
    floorAlphaSharpenHigh: lerp(0.72, 0.9995, strength),
    outdoorsAlphaLow: lerp(0.06, 0.65, strength),
    outdoorsAlphaHigh: lerp(0.35, 0.99, strength),
    hardness: strength,
    edgeOutdoorBias: lerp(0.5, 1.0, edgeBleed),
    stackValidityLow: lerp(0.10, 0.62, strength),
    stackValidityHigh: lerp(0.48, 0.998, strength),
    indoorCoverageMin: lerp(0.18, lerp(0.75, 0.99, strength), bias),
  };
}

/**
 * @param {IndoorOutdoorDefringeParams} p
 * @returns {string}
 */
export function defringeParamsSignature(p) {
  return [
    p.strength,
    p.footprintLow,
    p.footprintHigh,
    p.indoorFootprintMin,
    p.floorAlphaSharpenLow,
    p.floorAlphaSharpenHigh,
    p.outdoorsAlphaLow,
    p.outdoorsAlphaHigh,
    p.hardness,
    p.stackValidityLow,
    p.stackValidityHigh,
    p.indoorCoverageMin,
    p.edgeOutdoorBias,
  ].map((n) => Number(n).toFixed(4)).join('|');
}

/**
 * @param {object|null} material - THREE.RawShaderMaterial
 * @param {IndoorOutdoorDefringeParams} [params]
 */
export function applyDefringeToTileMaterial(material, params = null) {
  const p = params ?? getIndoorOutdoorDefringeParams();
  const u = material?.uniforms;
  if (!u) return;
  if (u.uDefringeFloorAlphaLo) u.uDefringeFloorAlphaLo.value = p.floorAlphaSharpenLow;
  if (u.uDefringeFloorAlphaHi) u.uDefringeFloorAlphaHi.value = p.floorAlphaSharpenHigh;
  if (u.uDefringeCovLo) u.uDefringeCovLo.value = p.outdoorsAlphaLow;
  if (u.uDefringeCovHi) u.uDefringeCovHi.value = p.outdoorsAlphaHigh;
  if (u.uDefringeHardness) u.uDefringeHardness.value = p.hardness;
}

/**
 * @param {object|null} material
 * @param {IndoorOutdoorDefringeParams} [params]
 */
export function applyDefringeToStackOutdoorsMaterial(material, params = null) {
  const p = params ?? getIndoorOutdoorDefringeParams();
  const u = material?.uniforms;
  if (!u) return;
  if (u.uDefringeFootLo) u.uDefringeFootLo.value = p.footprintLow;
  if (u.uDefringeFootHi) u.uDefringeFootHi.value = p.footprintHigh;
  if (u.uDefringeIndoorFootMin) u.uDefringeIndoorFootMin.value = p.indoorFootprintMin;
  if (u.uDefringeOdAlphaLo) u.uDefringeOdAlphaLo.value = p.outdoorsAlphaLow;
  if (u.uDefringeOdAlphaHi) u.uDefringeOdAlphaHi.value = p.outdoorsAlphaHigh;
  if (u.uDefringeHardness) u.uDefringeHardness.value = p.hardness;
  if (u.uDefringeEdgeOutdoorBias) u.uDefringeEdgeOutdoorBias.value = p.edgeOutdoorBias;
}

/**
 * @param {object|null} material
 * @param {IndoorOutdoorDefringeParams} [params]
 */
export function applyDefringeToStackPostMaterial(material, params = null) {
  const p = params ?? getIndoorOutdoorDefringeParams();
  const u = material?.uniforms;
  if (!u) return;
  if (u.uDefringeFootLo) u.uDefringeFootLo.value = p.footprintLow;
  if (u.uDefringeFootHi) u.uDefringeFootHi.value = p.footprintHigh;
  if (u.uDefringeIndoorFootMin) u.uDefringeIndoorFootMin.value = p.indoorFootprintMin;
  if (u.uDefringeStackValidLo) u.uDefringeStackValidLo.value = p.stackValidityLow;
  if (u.uDefringeStackValidHi) u.uDefringeStackValidHi.value = p.stackValidityHigh;
  if (u.uDefringeIndoorCovMin) u.uDefringeIndoorCovMin.value = p.indoorCoverageMin;
  if (u.uDefringeEdgeOutdoorBias) u.uDefringeEdgeOutdoorBias.value = p.edgeOutdoorBias;
  if (u.uDefringeHardness) u.uDefringeHardness.value = p.hardness;
}

/**
 * @param {object|null} material
 * @param {IndoorOutdoorDefringeParams} [params]
 */
export function applyDefringeToStackSkyReachMaterial(material, params = null) {
  const p = params ?? getIndoorOutdoorDefringeParams();
  const u = material?.uniforms;
  if (!u) return;
  if (u.uDefringeFootLo) u.uDefringeFootLo.value = p.footprintLow;
  if (u.uDefringeFootHi) u.uDefringeFootHi.value = p.footprintHigh;
  if (u.uDefringeHardness) u.uDefringeHardness.value = p.hardness;
}

/**
 * Camera Grade samples the stacked effective mask (R=outdoor, A=coverage).
 *
 * @param {object|null} material
 * @param {IndoorOutdoorDefringeParams} [params]
 */
export function applyDefringeToCcMaterial(material, params = null) {
  const p = params ?? getIndoorOutdoorDefringeParams();
  const u = material?.uniforms;
  if (!u) return;
  if (u.uDefringeStackValidLo) u.uDefringeStackValidLo.value = p.stackValidityLow;
  if (u.uDefringeStackValidHi) u.uDefringeStackValidHi.value = p.stackValidityHigh;
  if (u.uDefringeIndoorCovMin) u.uDefringeIndoorCovMin.value = p.indoorCoverageMin;
  if (u.uDefringeEdgeOutdoorBias) u.uDefringeEdgeOutdoorBias.value = p.edgeOutdoorBias;
  if (u.uDefringeHardness) u.uDefringeHardness.value = p.hardness;
}

/**
 * Push defringe to GPU stack materials and CC (call from Tweakpane / compositor).
 *
 * @param {object|null} compositor
 */
export function syncIndoorOutdoorDefringeConsumers(compositor) {
  if (compositor?._syncIndoorOutdoorDefringe) {
    compositor._syncIndoorOutdoorDefringe();
    return;
  }
  const p = getIndoorOutdoorDefringeParams();
  syncDefringeCacheInvalidation(compositor, p);
  applyDefringeToCcMaterial(
    window.MapShine?.floorCompositorV2?._colorCorrectionEffect?._composeMaterial,
    p,
  );
}

/**
 * Evict cached GPU masks when defringe settings change (requires floorAlpha/outdoors restack).
 *
 * @param {object|null} compositor - GpuSceneMaskCompositor
 * @param {IndoorOutdoorDefringeParams} params
 * @returns {boolean} Whether caches were invalidated
 */
export function syncDefringeCacheInvalidation(compositor, params = null) {
  if (!compositor) return false;
  const p = params ?? getIndoorOutdoorDefringeParams();
  const sig = defringeParamsSignature(p);
  if (compositor._defringeParamsSig === sig) return false;
  compositor._defringeParamsSig = sig;

  try {
    for (const key of compositor._floorCache?.keys?.() ?? []) {
      compositor._evictGpuMaskRtForFloor?.(key, 'floorAlpha');
      compositor._evictGpuMaskRtForFloor?.(key, 'outdoors');
    }
    compositor._floorCacheVersion = (Number(compositor._floorCacheVersion) || 0) + 1;
    compositor._indoorOutdoorMaskService?.invalidateCache?.();
  } catch (_) {}

  return true;
}
