/**
 * @fileoverview Camera-view ash spawn picking from composited _Ash mask (brightness-weighted).
 * @module compositor-v2/effects/ash-cloud-sprites/ash-cloud-spawn-picker
 */

/** Minimum _Ash luminance to count as a spawn site. */
export const ASH_SPAWN_BRIGHTNESS_THRESHOLD = 0.12;

/**
 * Convert Three world view AABB to scene norm UV (matches AshCloudEffect normU/normV).
 * @param {number} minX
 * @param {number} minY
 * @param {number} maxX
 * @param {number} maxY
 * @param {{ sceneX: number, sceneY: number, sceneW: number, sceneH: number, minY: number }} geom
 */
export function worldBoundsToNormUv(minX, minY, maxX, maxY, geom) {
  const u0 = (minX - geom.sceneX) / Math.max(1e-6, geom.sceneW);
  const u1 = (maxX - geom.sceneX) / Math.max(1e-6, geom.sceneW);
  const v0 = 1.0 - ((maxY - geom.minY) / Math.max(1e-6, geom.sceneH));
  const v1 = 1.0 - ((minY - geom.minY) / Math.max(1e-6, geom.sceneH));
  return {
    uMin: Math.max(0, Math.min(1, Math.min(u0, u1))),
    uMax: Math.max(0, Math.min(1, Math.max(u0, u1))),
    vMin: Math.max(0, Math.min(1, Math.min(v0, v1))),
    vMax: Math.max(0, Math.min(1, Math.max(v0, v1))),
  };
}

/**
 * Expand norm UV rect with padding (clamped 0..1).
 * @param {{ uMin: number, uMax: number, vMin: number, vMax: number }} rect
 * @param {number} pad
 */
export function padNormUvRect(rect, pad) {
  const p = Math.max(0, Number(pad) || 0);
  return {
    uMin: Math.max(0, rect.uMin - p),
    uMax: Math.min(1, rect.uMax + p),
    vMin: Math.max(0, rect.vMin - p),
    vMax: Math.min(1, rect.vMax + p),
  };
}

/**
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} px
 * @param {number} py
 */
function sampleMaskBrightness(rgba, width, height, px, py) {
  const x = Math.max(0, Math.min(width - 1, px));
  const y = Math.max(0, Math.min(height - 1, py));
  const idx = (y * width + x) * 4;
  const lum = Math.max(rgba[idx], rgba[idx + 1], rgba[idx + 2]) / 255;
  return lum * (rgba[idx + 3] / 255);
}

/**
 * Scan composited scene-space _Ash mask inside a norm-UV view rect.
 * Returns packed (u, v, brightness) triples in scene UV (= ash cloud normU/normV).
 *
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{ uMin: number, uMax: number, vMin: number, vMax: number }} viewUv
 * @param {object} [options]
 * @param {number} [options.threshold]
 * @param {Uint8Array|null} [options.outdoorsRgba]
 * @param {number} [options.outdoorsW]
 * @param {number} [options.outdoorsH]
 * @param {number} [options.outdoorsMin=0.45]
 * @returns {Float32Array|null}
 */
export function scanAshMaskPointsInView(rgba, width, height, viewUv, options = {}) {
  if (!rgba || !(width > 1) || !(height > 1)) return null;

  const threshold = Number(options.threshold) || ASH_SPAWN_BRIGHTNESS_THRESHOLD;
  const outdoorsRgba = options.outdoorsRgba ?? null;
  const outdoorsW = Number(options.outdoorsW) || 0;
  const outdoorsH = Number(options.outdoorsH) || 0;
  const outdoorsMin = Number(options.outdoorsMin) || 0.45;

  const px0 = Math.floor(Math.max(0, Math.min(width - 1, viewUv.uMin * (width - 1))));
  const px1 = Math.ceil(Math.max(0, Math.min(width - 1, viewUv.uMax * (width - 1))));
  const py0 = Math.floor(Math.max(0, Math.min(height - 1, viewUv.vMin * (height - 1))));
  const py1 = Math.ceil(Math.max(0, Math.min(height - 1, viewUv.vMax * (height - 1))));

  const regionW = Math.max(1, px1 - px0 + 1);
  const regionH = Math.max(1, py1 - py0 + 1);
  const stride = Math.max(1, Math.floor(Math.max(regionW, regionH) / 72));

  const coords = [];
  for (let py = py0; py <= py1; py += stride) {
    for (let px = px0; px <= px1; px += stride) {
      const b = sampleMaskBrightness(rgba, width, height, px, py);
      if (b <= threshold) continue;

      const u = px / (width - 1);
      const v = py / (height - 1);

      if (outdoorsRgba && outdoorsW > 1 && outdoorsH > 1) {
        const ox = Math.floor(u * (outdoorsW - 1));
        const oy = Math.floor(v * (outdoorsH - 1));
        const outdoor = sampleMaskBrightness(outdoorsRgba, outdoorsW, outdoorsH, ox, oy);
        if (outdoor < outdoorsMin) continue;
      }

      coords.push(u, v, b);
    }
  }

  return coords.length >= 3 ? new Float32Array(coords) : null;
}

/**
 * Brightness-weighted random pick from packed (u,v,brightness) triples.
 * @param {Float32Array|null} points
 * @returns {{ u: number, v: number, brightness: number }|null}
 */
export function pickWeightedAshSpawnPoint(points) {
  if (!points || points.length < 3) return null;

  const n = points.length / 3;
  let total = 0;
  for (let i = 2; i < points.length; i += 3) {
    total += Math.max(0, points[i]);
  }

  if (total <= 1e-6) {
    const idx = Math.floor(Math.random() * n) * 3;
    return { u: points[idx], v: points[idx + 1], brightness: points[idx + 2] };
  }

  let r = Math.random() * total;
  for (let i = 0; i < points.length; i += 3) {
    r -= Math.max(0, points[i + 2]);
    if (r <= 0) {
      return { u: points[i], v: points[i + 1], brightness: points[i + 2] };
    }
  }

  const last = (n - 1) * 3;
  return { u: points[last], v: points[last + 1], brightness: points[last + 2] };
}

/**
 * @param {number} u
 * @param {number} v
 * @param {{ uMin: number, uMax: number, vMin: number, vMax: number }} viewUv
 * @param {number} [pad=0]
 */
export function isNormUvInView(u, v, viewUv, pad = 0) {
  const p = Math.max(0, Number(pad) || 0);
  return u >= viewUv.uMin - p && u <= viewUv.uMax + p
    && v >= viewUv.vMin - p && v <= viewUv.vMax + p;
}
