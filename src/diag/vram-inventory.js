/**
 * vram-inventory.js — what is actually resident on the GPU, and how much of that
 * three can and cannot see. Pure arithmetic; no THREE, no DOM.
 *
 * ============================================================================
 * WHY THIS IS NOT JUST `renderer.info.memory`
 * ============================================================================
 *
 * three's own accounting has a hole big enough to hide this project's single
 * largest VRAM consumer in. `Info._getTextureMemorySize`
 * (vendor/three/three.webgpu.js:46623) opens with:
 *
 *     if ( texture.isCompressedTexture ) { return 1; }
 *
 * ONE BYTE, for any compressed texture. The virtual-texture atlas pages are
 * BC1/BC7 compressed — that compression is the fix for the ~2.5 GB device-loss
 * wall (keyhole-device-loss-large-map) — so `info.memory.texturesSize`
 * under-reports the thing most likely to kill the device by several orders of
 * magnitude. A report that quoted three's number alone would be at its most
 * confident exactly where it was most wrong.
 *
 * So this module combines three sources and LABELS each one:
 *   1. named render targets, from the allocator's own `onCreate` hook — exact,
 *      because we know the dimensions and the format we asked for;
 *   2. `renderer.info.memory` — three's view, carrying the caveat above;
 *   3. the viewer's own honest atlas estimate (`mipChainByteLength`, which
 *      already computes real per-format sizes for the BC accounting).
 *
 * @module diag/vram-inventory
 */

/** Bytes per channel, by a stable string key the glue maps THREE's constants to. */
export const TYPE_BYTES = Object.freeze({
  unsignedByte: 1,
  byte: 1,
  halfFloat: 2,
  float: 4,
  unsignedInt: 4,
  int: 4,
  unsignedShort: 2,
  short: 2,
});

/** Channels per pixel, by format key. */
export const FORMAT_CHANNELS = Object.freeze({ r: 1, rg: 2, rgb: 3, rgba: 4, depth: 1 });

const MB = 1024 * 1024;
const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

/**
 * Bytes per pixel for a type/format pair.
 * @returns {number|null} null for an unrecognised pair — an unknown size must
 *   not silently become 0 and vanish from the total.
 */
export function bytesPerPixel(typeKey, formatKey) {
  const bytes = TYPE_BYTES[typeKey];
  const channels = FORMAT_CHANNELS[formatKey];
  if (!Number.isFinite(bytes) || !Number.isFinite(channels)) return null;
  return bytes * channels;
}

/**
 * Size one render target, including its extra MRT attachments.
 * @param {{name:string,width:number,height:number,attachments?:number,typeKey:string,formatKey:string,samples?:number}} rt
 */
export function sizeRenderTarget(rt) {
  const bpp = bytesPerPixel(rt.typeKey, rt.formatKey);
  const px = Number.isFinite(rt.width) && Number.isFinite(rt.height) ? rt.width * rt.height : null;
  const attachments = Number.isFinite(rt.attachments) && rt.attachments > 0 ? rt.attachments : 1;
  const samples = Number.isFinite(rt.samples) && rt.samples > 0 ? rt.samples : 1;
  const bytes = bpp === null || px === null ? null : px * bpp * attachments * samples;
  return {
    name: rt.name,
    width: rt.width ?? null,
    height: rt.height ?? null,
    attachments,
    typeKey: rt.typeKey ?? null,
    formatKey: rt.formatKey ?? null,
    bytesPerPixel: bpp,
    mb: bytes === null ? null : round(bytes / MB),
    // An unsized target is reported as unsized, never as free.
    unsized: bytes === null,
  };
}

/**
 * Build the inventory.
 *
 * @param {object} input
 * @param {Array} [input.targets] plain descriptors from the allocator registry
 * @param {object} [input.rendererInfo] `renderer.info` (we read `.memory` only)
 * @param {object} [input.vtEstimate] `{estTextureVramMB, bc1IfAllMB, bc7IfAllMB}`
 * @param {number} [input.ceilingMb] the measured device-loss wall, if known
 */
export function buildVramInventory({ targets = [], rendererInfo = null, vtEstimate = null, ceilingMb = null } = {}) {
  const items = targets.map(sizeRenderTarget).sort((a, b) => (b.mb ?? 0) - (a.mb ?? 0));
  const sized = items.filter((i) => !i.unsized);
  const namedMb = sized.length === 0 ? null : round(sized.reduce((a, i) => a + i.mb, 0));
  const unsizedCount = items.length - sized.length;

  const mem = rendererInfo?.memory ?? null;
  const threeInfo = mem
    ? {
        textures: mem.textures ?? null,
        texturesSizeMb: Number.isFinite(mem.texturesSize) ? round(mem.texturesSize / MB) : null,
        renderTargets: mem.renderTargets ?? null,
        uniformBuffersMb: Number.isFinite(mem.uniformBuffersSize) ? round(mem.uniformBuffersSize / MB) : null,
        attributesMb: Number.isFinite(mem.attributesSize) ? round(mem.attributesSize / MB) : null,
        totalMb: Number.isFinite(mem.total) ? round(mem.total / MB) : null,
        caveat:
          'three counts a COMPRESSED texture as ONE BYTE (Info._getTextureMemorySize). The BC-compressed virtual-texture ' +
          'atlas is therefore invisible in these numbers. Use vtEstimateMb below for it — not this.',
      }
    : null;

  const vtMb = Number.isFinite(vtEstimate?.estTextureVramMB) ? round(vtEstimate.estTextureVramMB) : null;
  const parts = [namedMb, vtMb, threeInfo?.uniformBuffersMb, threeInfo?.attributesMb].filter((v) => Number.isFinite(v));
  const estimatedTotalMb = parts.length === 0 ? null : round(parts.reduce((a, b) => a + b, 0));

  const headroom =
    Number.isFinite(estimatedTotalMb) && Number.isFinite(ceilingMb) && ceilingMb > 0
      ? round(1 - estimatedTotalMb / ceilingMb, 3)
      : null;

  return {
    renderTargets: {
      count: items.length,
      namedMb,
      unsizedCount,
      unsizedNote:
        unsizedCount > 0
          ? `${unsizedCount} target(s) could not be sized (unrecognised type/format) and are EXCLUDED from namedMb. They are not free — they are unmeasured.`
          : null,
      items,
    },
    threeInfoMemory: threeInfo,
    vtEstimateMb: vtMb,
    vtEstimateNote:
      vtMb === null
        ? 'No virtual-texture estimate supplied — the largest single consumer is missing from estimatedTotalMb.'
        : "From the viewer's own per-format mip-chain accounting, which understands BC compression. This is the honest figure for the atlas.",
    estimatedTotalMb,
    ceilingMb,
    headroomFraction: headroom,
    verdict: headroom === null ? 'unknown' : headroom < 0.15 ? 'critical' : headroom < 0.3 ? 'tight' : 'ok',
    note:
      'An ESTIMATE against a MEASURED wall, and it says so. Nothing here queries actual driver allocation — WebGPU ' +
      'exposes no such API — so treat it as a ranking of consumers plus an order-of-magnitude total, not a budget.',
  };
}
