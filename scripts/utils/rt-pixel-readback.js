/**
 * @fileoverview WebGL render-target pixel readback (HalfFloat + UnsignedByte).
 * @module utils/rt-pixel-readback
 */

/**
 * @param {number} c linear 0–1+
 * @returns {number}
 */
export function linearToSrgbByte(c) {
  const v = Math.max(0, Math.min(1, Number(c)));
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * @returns {(n: number) => number}
 */
function getHalfFloatDecoder() {
  const fromHalf = globalThis.THREE?.DataUtils?.fromHalfFloat;
  if (typeof fromHalf === 'function') return fromHalf;
  return (val) => {
    const m = val >> 10;
    const exponent = (m & 0x1f) - 15;
    const mantissa = val & 0x3ff;
    if (exponent === 16) return mantissa ? NaN : (val & 0x8000 ? -Infinity : Infinity);
    if (exponent === -15) return mantissa ? (mantissa / 1024) * Math.pow(2, -14) * (val & 0x8000 ? -1 : 1) : 0;
    return Math.pow(2, exponent) * (1 + mantissa / 1024) * (val & 0x8000 ? -1 : 1);
  };
}

const fromHalfFloat = getHalfFloatDecoder();

/**
 * @param {import('three').WebGLRenderTarget} rt
 * @returns {number}
 */
export function getRtTextureType(rt) {
  const t = rt?.texture?.type;
  if (t != null) return t;
  return globalThis.THREE?.UnsignedByteType ?? 1009;
}

/**
 * @param {import('three').WebGLRenderTarget} rt
 * @returns {boolean}
 */
export function isHalfFloatRt(rt) {
  return getRtTextureType(rt) === globalThis.THREE?.HalfFloatType;
}

/**
 * @param {import('three').WebGLRenderTarget} rt
 * @param {number} pixelCount
 * @returns {Uint8Array|Uint16Array}
 */
export function allocateRtReadbackBuffer(rt, pixelCount) {
  const n = Math.max(4, pixelCount * 4);
  return isHalfFloatRt(rt) ? new Uint16Array(n) : new Uint8Array(n);
}

/**
 * Decode one RGBA texel from a readback buffer (linear RT → sRGB bytes).
 *
 * @param {Uint8Array|Uint16Array} raw
 * @param {import('three').WebGLRenderTarget} rt
 * @param {number} [offset]
 * @returns {{ srgb: [number, number, number], linear: [number, number, number, number] }}
 */
export function decodeReadbackPixel(raw, rt, offset = 0) {
  if (isHalfFloatRt(rt)) {
    const lr = fromHalfFloat(raw[offset]);
    const lg = fromHalfFloat(raw[offset + 1]);
    const lb = fromHalfFloat(raw[offset + 2]);
    const la = fromHalfFloat(raw[offset + 3]);
    return {
      srgb: [linearToSrgbByte(lr), linearToSrgbByte(lg), linearToSrgbByte(lb)],
      linear: [lr, lg, lb, la],
    };
  }
  const lr = raw[offset] / 255;
  const lg = raw[offset + 1] / 255;
  const lb = raw[offset + 2] / 255;
  const la = raw[offset + 3] / 255;
  return {
    srgb: [linearToSrgbByte(lr), linearToSrgbByte(lg), linearToSrgbByte(lb)],
    linear: [lr, lg, lb, la],
  };
}

/**
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget} rt
 * @param {number} x GL origin bottom-left
 * @param {number} y GL origin bottom-left
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} [out] optional w×h×4 sRGB buffer (bottom-left row order)
 * @returns {Uint8Array|null}
 */
export function readRtRegionToSrgb8(renderer, rt, x, y, w, h, out = null) {
  if (!renderer?.readRenderTargetPixels || !rt || w <= 0 || h <= 0) return null;
  const raw = allocateRtReadbackBuffer(rt, w * h);
  try {
    renderer.readRenderTargetPixels(rt, x, y, w, h, raw);
  } catch (_) {
    return null;
  }
  const pixels = out && out.length >= w * h * 4 ? out : new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const off = i * 4;
    const { srgb } = decodeReadbackPixel(raw, rt, off);
    pixels[off] = srgb[0];
    pixels[off + 1] = srgb[1];
    pixels[off + 2] = srgb[2];
    pixels[off + 3] = 255;
  }
  return pixels;
}

/**
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget} rt
 * @param {number} px
 * @param {number} pyGl bottom-left GL row
 * @returns {{ srgb: [number, number, number], rgba: number[], linear: number[] }|null}
 */
export function readRtPixelSrgb(renderer, rt, px, pyGl) {
  if (!renderer?.readRenderTargetPixels || !rt) return null;
  const raw = allocateRtReadbackBuffer(rt, 1);
  try {
    renderer.readRenderTargetPixels(rt, px, pyGl, 1, 1, raw);
  } catch (_) {
    return null;
  }
  const { srgb, linear } = decodeReadbackPixel(raw, rt, 0);
  return {
    srgb,
    rgba: [srgb[0] / 255, srgb[1] / 255, srgb[2] / 255, linear[3]],
    linear,
  };
}

/**
 * Scene rect in drawing-buffer pixels (bottom-left GL origin).
 *
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget} [rt]
 * @param {{ preferFoundrySceneRect?: boolean }} [options]
 * @returns {{ x: number, y: number, w: number, h: number, source: string }|null}
 */
export function resolveSceneRectInRtPixels(renderer, rt = null, options = {}) {
  const fd = globalThis.MapShine?.sceneComposer?.foundrySceneData ?? null;
  const preferFoundrySceneRect = options.preferFoundrySceneRect !== false;

  const bufW = rt?.width | 0 || (() => {
    try {
      const v = new globalThis.THREE.Vector2();
      renderer?.getDrawingBufferSize?.(v);
      return v.x | 0;
    } catch (_) {
      return 0;
    }
  })();
  const bufH = rt?.height | 0 || (() => {
    try {
      const v = new globalThis.THREE.Vector2();
      renderer?.getDrawingBufferSize?.(v);
      return v.y | 0;
    } catch (_) {
      return 0;
    }
  })();

  if (preferFoundrySceneRect && fd) {
    const canvasW = Number(fd.width) || Number(fd.sceneWidth) || 0;
    const canvasH = Number(fd.height) || Number(fd.sceneHeight) || 0;
    const sceneX = Number(fd.sceneX) || 0;
    const sceneY = Number(fd.sceneY) || 0;
    const sceneW = Number(fd.sceneWidth) || canvasW;
    const sceneH = Number(fd.sceneHeight) || canvasH;
    if (bufW >= 1 && bufH >= 1 && canvasW > 0 && canvasH > 0 && sceneW > 0 && sceneH > 0) {
      const scaleX = bufW / canvasW;
      const scaleY = bufH / canvasH;
      const x = Math.floor(sceneX * scaleX);
      const right = Math.ceil((sceneX + sceneW) * scaleX);
      const w = Math.max(1, right - x);
      const bottomInset = canvasH - sceneY - sceneH;
      const topInset = canvasH - sceneY;
      const y = Math.floor(bottomInset * scaleY);
      const topGl = Math.ceil(topInset * scaleY);
      const h = Math.max(1, topGl - y);
      return { x, y, w, h, source: 'foundrySceneData' };
    }
  }

  return null;
}

/**
 * Map chart patch UV (0–1 within scene rect, v from top) to RT pixel coords.
 *
 * @param {number} u
 * @param {number} vTop
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget} rt
 * @param {{ preferFoundrySceneRect?: boolean }} [options]
 * @returns {{ px: number, pyGl: number, sceneRect: object|null }}
 */
export function sceneNormUvToRtPixel(u, vTop, renderer, rt, options = {}) {
  const w = rt.width | 0;
  const h = rt.height | 0;
  const rect = resolveSceneRectInRtPixels(renderer, rt, options);
  if (rect && rect.w > 0 && rect.h > 0) {
    const px = Math.max(0, Math.min(w - 1, Math.floor(rect.x + u * rect.w)));
    const pyGl = Math.max(0, Math.min(h - 1, Math.floor(rect.y + (1 - vTop) * rect.h)));
    return { px, pyGl, sceneRect: rect };
  }
  const px = Math.max(0, Math.min(w - 1, Math.floor(u * w)));
  const pyGl = Math.max(0, Math.min(h - 1, Math.floor((1 - vTop) * h)));
  return { px, pyGl, sceneRect: null };
}
