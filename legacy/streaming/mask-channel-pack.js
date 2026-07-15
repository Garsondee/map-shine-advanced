/**
 * @fileoverview RGBA channel packing for binary particle masks.
 * @module streaming/mask-channel-pack
 */

/** Binary masks that can share one RGBA atlas texture. */
export const PACKABLE_BINARY_MASKS = ['fire', 'dust', 'ash', 'outdoors'];

/** Channel assignment for packed atlas (R,G,B,A). */
export const PACKED_MASK_CHANNELS = {
  fire: 'r',
  dust: 'g',
  ash: 'b',
  outdoors: 'a',
};

/**
 * @param {string} maskType
 * @returns {boolean}
 */
export function isPackableBinaryMask(maskType) {
  return PACKABLE_BINARY_MASKS.includes(String(maskType));
}

/**
 * GLSL helper: sample packed mask channel.
 * @param {string} channel - r|g|b|a
 * @returns {string}
 */
export function glslSamplePackedMaskChannel(channel = 'r') {
  const ch = String(channel).toLowerCase();
  const swizzle = ch === 'r' ? 's.r' : ch === 'g' ? 's.g' : ch === 'b' ? 's.b' : 's.a';
  return /* glsl */`
float msSamplePackedMaskChannel(vec4 s, int channelIndex) {
  if (channelIndex == 0) return s.r;
  if (channelIndex == 1) return s.g;
  if (channelIndex == 2) return s.b;
  return s.a;
}
float msSamplePackedMask_${ch}(vec4 s) { return ${swizzle}; }
`;
}

/**
 * CPU: merge grayscale mask canvases into RGBA atlas (one channel each).
 *
 * @param {Record<string, ImageData|null>} maskDataByType
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function packBinaryMasksToRgbaAtlas(maskDataByType, width, height) {
  const out = new Uint8Array(width * height * 4);
  for (const [type, data] of Object.entries(maskDataByType)) {
    if (!data || !isPackableBinaryMask(type)) continue;
    const ch = PACKED_MASK_CHANNELS[type] ?? 'r';
    const ci = ch === 'r' ? 0 : ch === 'g' ? 1 : ch === 'b' ? 2 : 3;
    const src = data.data;
    const n = Math.min(out.length / 4, src.length / 4);
    for (let i = 0; i < n; i += 1) {
      const lum = Math.max(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]);
      const a = src[i * 4 + 3] / 255;
      out[i * 4 + ci] = Math.round(lum * a);
    }
  }
  return out;
}

/**
 * Resolve channel index for a mask type in packed atlas.
 * @param {string} maskType
 * @returns {number} 0-3 or -1 if not packed
 */
export function packedMaskChannelIndex(maskType) {
  const ch = PACKED_MASK_CHANNELS[String(maskType)];
  if (!ch) return -1;
  return ch === 'r' ? 0 : ch === 'g' ? 1 : ch === 'b' ? 2 : 3;
}
