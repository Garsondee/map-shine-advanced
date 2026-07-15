/**
 * @fileoverview Integer cache signatures for overhead stamp capture (zero alloc).
 */

/** @param {number} h @param {number} v @returns {number} */
export function hashFold(h, v) {
  return (Math.imul(h, 31) + (v | 0)) | 0;
}

/** @param {number} h @param {number} v @returns {number} */
export function hashFoldFloat(h, v) {
  return hashFold(h, Math.round((Number(v) || 0) * 10000));
}

/**
 * @param {import('three').Camera|null} cam
 * @param {number} effectiveZoom
 * @returns {number}
 */
export function hashCamera(cam, effectiveZoom) {
  let h = 0x811c9dc5;
  if (!cam) return hashFold(h, 0);
  cam.updateMatrixWorld?.(true);
  const p = cam.position;
  h = hashFoldFloat(h, p.x);
  h = hashFoldFloat(h, p.y);
  h = hashFoldFloat(h, p.z);
  h = hashFoldFloat(h, cam.zoom);
  h = hashFoldFloat(h, effectiveZoom);
  h = hashFold(h, cam.layers?.mask ?? 0);
  const e = cam.projectionMatrix?.elements;
  if (e) {
    h = hashFoldFloat(h, e[0]);
    h = hashFoldFloat(h, e[5]);
    h = hashFoldFloat(h, e[12]);
    h = hashFoldFloat(h, e[13]);
  }
  return h;
}

/**
 * @param {{ list: object[], hasFluid: boolean, hasTrees: boolean }} frameCasters
 * @returns {number}
 */
export function hashCasterLive(frameCasters) {
  const list = frameCasters.list;
  const n = list.length;
  let h = hashFold(n, (frameCasters.hasFluid ? 1 : 0) | (frameCasters.hasTrees ? 2 : 0));
  for (let i = 0; i < n; i++) {
    const entry = list[i];
    const mat = entry.mat;
    if (mat && typeof mat.opacity === 'number' && mat.opacity < 0.999) {
      return hashFold(h, 1 + i);
    }
    const uniforms = entry.uniforms;
    const hf = uniforms?.uHoverFade?.value;
    if (typeof hf === 'number' && hf < 0.999) return hashFold(h, 100 + i);
    const uOpacity = uniforms?.uOpacity?.value;
    if (typeof uOpacity === 'number' && uOpacity < 0.999) return hashFold(h, 200 + i);
    const uTileOpacity = uniforms?.uTileOpacity?.value;
    if (typeof uTileOpacity === 'number' && uTileOpacity < 0.999) return hashFold(h, 300 + i);
  }
  if (n > 0) {
    h = hashFold(h, list[0].object?.id ?? 0);
    h = hashFold(h, list[n - 1].object?.id ?? 0);
  }
  return h;
}

/**
 * @param {number} w
 * @param {number} h
 * @param {number} roofCaptureScale
 * @param {number} enabled
 * @param {number} camHash
 * @param {number} casterHash
 * @param {number} motionHash
 * @returns {number}
 */
export function hashRoofMaskCapture(w, h, roofCaptureScale, enabled, camHash, casterHash, motionHash) {
  let sig = hashFold((w << 16) ^ h, enabled);
  sig = hashFoldFloat(sig, roofCaptureScale);
  sig = hashFold(sig, camHash);
  sig = hashFold(sig, casterHash);
  sig = hashFold(sig, motionHash);
  return sig;
}

/**
 * @param {Array<string|number>} ids
 * @returns {number}
 */
export function hashTileProjectionIds(ids) {
  let h = 0x811c9dc5;
  const sorted = ids.slice().sort((a, b) => String(a).localeCompare(String(b)));
  for (let i = 0; i < sorted.length; i++) {
    const s = String(sorted[i]);
    for (let j = 0; j < s.length; j++) h = hashFold(h, s.charCodeAt(j));
  }
  return h;
}

/**
 * @param {number} roofSig
 * @param {number} tileIdsHash
 * @param {number} motionHash
 * @returns {number}
 */
export function hashTileProjectionCapture(roofSig, tileIdsHash, motionHash) {
  return hashFold(hashFold(roofSig, tileIdsHash), motionHash);
}
