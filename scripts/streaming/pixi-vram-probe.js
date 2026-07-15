/**
 * @fileoverview Shared probe for Foundry/PIXI-side GPU texture memory.
 *
 * MSA's own budgets (TextureBudgetTracker, the compositor-RT estimate) only see
 * the Three.js side. Foundry's PIXI renderer independently holds full-resolution
 * source images (scene background, tiles) in the SAME GPU memory — a 12000x12000
 * background alone is ~576 MB — invisible to every MSA counter. Historically this
 * was measured only inside the crash report (`_safePixiTextureStats`), so the
 * live budgeting path never accounted for it.
 *
 * This module is the single source of truth for that measurement. The VRAM ledger
 * ({@link module:streaming/vram-ledger}) sums it into the resident total so the
 * dynamic render-resolution budget reserves room for PIXI, and the crash report
 * reuses the same walk so the two never disagree.
 *
 * @module streaming/pixi-vram-probe
 */

/**
 * @typedef {object} PixiTextureStats
 * @property {number} managedCount  Total managed BaseTextures (including zero-sized).
 * @property {number} sizedCount    Count with resolvable dimensions.
 * @property {number} estTotalMB    Estimated RGBA8 VRAM in MB (mipmaps +33%).
 * @property {Array<{mb:number,w:number,h:number,src:(string|null)}>} top  Largest 10.
 */

/**
 * Walk Foundry's PIXI `managedTextures` once and estimate GPU bytes.
 * RGBA8 assumption (4 B/px), +33% when the texture reports mipmaps.
 *
 * @returns {PixiTextureStats|null} Null when PIXI is unreachable (bootstrap, teardown).
 */
export function samplePixiTextureStats() {
  try {
    const pixiRenderer = globalThis.canvas?.app?.renderer ?? null;
    const managed = pixiRenderer?.texture?.managedTextures;
    if (!Array.isArray(managed)) return null;

    let totalBytes = 0;
    let counted = 0;
    const entries = [];
    for (const bt of managed) {
      const w = Number(bt?.realWidth ?? bt?.width) || 0;
      const h = Number(bt?.realHeight ?? bt?.height) || 0;
      if (!(w > 0 && h > 0)) continue;
      let bytes = w * h * 4;
      if (bt?.mipmap != null && Number(bt.mipmap) > 0) bytes = Math.round(bytes * 1.33);
      totalBytes += bytes;
      counted++;
      entries.push({
        mb: Math.round(bytes / 1048576),
        w,
        h,
        src: typeof bt?.resource?.src === 'string' ? bt.resource.src.slice(-96) : null,
      });
    }
    entries.sort((a, b) => b.mb - a.mb);
    return {
      managedCount: managed.length,
      sizedCount: counted,
      estTotalMB: Math.round(totalBytes / 1048576),
      top: entries.slice(0, 10),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Estimated Foundry/PIXI-side GPU texture VRAM in MB. Fails soft to 0 so callers
 * on the live budgeting path never throw during early bootstrap or teardown.
 * @returns {number} MB (0 when PIXI is unreachable).
 */
export function samplePixiTextureMB() {
  const stats = samplePixiTextureStats();
  return stats ? stats.estTotalMB : 0;
}
