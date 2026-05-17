/**
 * Collect per-floor _Outdoors textures indexed by FloorStack index (0..3) for
 * floor-id-aware receiver sampling (matches PaintedShadowEffectV2 wiring).
 *
 * @param {object|null} compositor GpuSceneMaskCompositor
 * @param {number} [maxSlots=4]
 * @returns {{ textures: (import('three').Texture|null)[], floorIdTex: import('three').Texture|null }}
 */
export function collectOutdoorsTexturesByFloorIndex(compositor, maxSlots = 4) {
  const textures = Array.from({ length: maxSlots }, () => null);
  if (!compositor) {
    return { textures, floorIdTex: null };
  }
  try {
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    for (const floor of floors) {
      const idx = Number(floor?.index);
      if (!Number.isFinite(idx) || idx < 0 || idx >= maxSlots) continue;
      let key = floor?.compositorKey != null ? String(floor.compositorKey) : '';
      if (!key) {
        const b = Number(floor?.elevationMin);
        const t = Number(floor?.elevationMax);
        if (Number.isFinite(b) && Number.isFinite(t)) key = `${b}:${t}`;
      }
      if (!key) continue;
      textures[idx] = compositor.getFloorTexture?.(key, 'outdoors') ?? null;
    }
    // Floor-id RT is independent: GpuSceneMaskCompositor may publish it even when
    // FloorStack entries omit compositorKey (we still resolve `b:t` keys above).
    const floorIdTex = compositor.floorIdTarget?.texture ?? null;
    return { textures, floorIdTex };
  } catch (_) {
    return { textures, floorIdTex: null };
  }
}
