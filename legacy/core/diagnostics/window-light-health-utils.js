/**
 * Shared helpers for WindowLightEffectV2 health / render-stack diagnostics.
 * Compositor-mode window light registers `__compositor_floor_N__` shim entries
 * (no mesh/material) while drawing via scene-UV emit RT.
 *
 * @module core/diagnostics/window-light-health-utils
 */

export const COMPOSITOR_OVERLAY_ID_RE = /^__compositor_floor_(\d+)__$/;

/** @param {string} tileId */
export function isCompositorOverlayShim(tileId) {
  return COMPOSITOR_OVERLAY_ID_RE.test(String(tileId ?? ''));
}

/**
 * @param {Map<string, object>|null|undefined} overlays
 * @returns {{ tileOverlays: [string, object][], compositorShims: [string, object][] }}
 */
export function partitionWindowLightOverlays(overlays) {
  const tileOverlays = /** @type {[string, object][]} */ ([]);
  const compositorShims = /** @type {[string, object][]} */ ([]);
  if (!overlays || typeof overlays.forEach !== 'function') {
    return { tileOverlays, compositorShims };
  }
  overlays.forEach((entry, tileId) => {
    const id = String(tileId ?? '');
    if (isCompositorOverlayShim(id)) compositorShims.push([id, entry]);
    else if (id && id !== '__bg_image__') tileOverlays.push([id, entry]);
  });
  return { tileOverlays, compositorShims };
}

/**
 * @param {object|null|undefined} instance WindowLightEffectV2
 * @param {number} activeFloor
 */
export function evaluateCompositorWindowLightReadiness(instance, activeFloor) {
  const active = Number(activeFloor) || 0;
  const hasValid = typeof instance?._hasValidWindowMask === 'function'
    ? instance._hasValidWindowMask(active)
    : false;
  const hasEmit = !!instance?._emitMaterial;
  const pass = hasValid && hasEmit;
  const litWindowSlots = [];
  if (typeof instance?._hasValidWindowMask === 'function') {
    for (let i = 0; i < 4; i += 1) {
      if (instance._hasValidWindowMask(i)) litWindowSlots.push(i);
    }
  }
  return {
    pass,
    message: pass
      ? `Compositor window-light slot ${active} mask ready (scene-UV emit path)`
      : !hasValid
        ? `Compositor window-light slot ${active} has no valid lit mask`
        : 'Compositor window-light emit material missing',
    evidence: {
      mode: 'compositor',
      activeFloor: active,
      maskReady: hasValid,
      hasEmitMaterial: hasEmit,
      litWindowSlots,
    },
  };
}

/**
 * @param {object|null|undefined} instance
 * @param {Map<string, object>|null|undefined} overlays
 */
export function windowLightUsesCompositorPath(instance, overlays) {
  const { tileOverlays, compositorShims } = partitionWindowLightOverlays(overlays ?? instance?._overlays);
  if (compositorShims.length === 0) return false;
  if (tileOverlays.length === 0) return true;
  return !!instance?._emitMaterial && typeof instance?._hasValidWindowMask === 'function';
}
