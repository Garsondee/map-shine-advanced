export class WaterSurfaceModel {
  constructor() {
    this.texture = null;
    this.transform = null;
    this.resolution = 0;
    this.threshold = 0.0;
    this._hasWater = false;
    this._useAlpha = false;
  }

  get hasWater() {
    return this._hasWater;
  }

  buildFromMaskTexture(maskTexture, {
    resolution = 512,
    threshold = 0.15,
    sdfRangePx = 64,
    exposureWidthPx = 24
  } = {}) {
    const THREE = window.THREE;
    if (!THREE) throw new Error('three.js not available');

    this.dispose();

    this.resolution = Math.max(8, Math.floor(resolution));
    this.threshold = threshold;

    const w = this.resolution;
    const h = this.resolution;

    const img = maskTexture?.image;
    if (!img) {
      this._hasWater = false;
      this.transform = new THREE.Vector4(0, 0, 1, 1);
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      this._hasWater = false;
      this.transform = new THREE.Vector4(0, 0, 1, 1);
      return null;
    }

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const { data } = ctx.getImageData(0, 0, w, h);

    this._useAlpha = this._detectUseAlpha(data);

    const mask = new Uint8Array(w * h);
    let hasWater = false;
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4];
      const a = data[i * 4 + 3];
      const v = this._useAlpha ? a : r;
      const on = v >= threshold * 255 ? 1 : 0;
      mask[i] = on;
      if (on) hasWater = true;
    }
    this._hasWater = hasWater;

    const distToLand = this._distanceTransform(mask, w, h, false);
    const distToWater = this._distanceTransform(mask, w, h, true);

    const out = new Uint8Array(w * h * 4);
    const sdfScale = Math.max(1e-3, sdfRangePx);
    const exposureScale = Math.max(1e-3, exposureWidthPx);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const isWater = mask[idx] === 1;
        const sdfPx = isWater ? -distToLand[idx] : distToWater[idx];

        const sdf01 = this._clamp01(0.5 + (sdfPx / (2.0 * sdfScale)));
        const shoreDistInside = Math.max(0.0, -sdfPx);
        const exposure01 = this._clamp01(shoreDistInside / exposureScale);

        const gx = this._sdfAt(distToLand, distToWater, mask, w, h, x + 1, y) - this._sdfAt(distToLand, distToWater, mask, w, h, x - 1, y);
        const gy = this._sdfAt(distToLand, distToWater, mask, w, h, x, y + 1) - this._sdfAt(distToLand, distToWater, mask, w, h, x, y - 1);
        let nx = gx;
        let ny = gy;
        const nlen = Math.hypot(nx, ny);
        if (nlen > 1e-6) {
          nx /= nlen;
          ny /= nlen;
        } else {
          nx = 0.0;
          ny = 0.0;
        }

        const o = idx * 4;
        out[o] = Math.round(sdf01 * 255);
        out[o + 1] = Math.round(exposure01 * 255);
        out[o + 2] = Math.round(this._clamp01(nx * 0.5 + 0.5) * 255);
        out[o + 3] = Math.round(this._clamp01(ny * 0.5 + 0.5) * 255);
      }
    }

    const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.flipY = false;
    if ('colorSpace' in tex && THREE.NoColorSpace) {
      tex.colorSpace = THREE.NoColorSpace;
    }
    tex.needsUpdate = true;

    this.texture = tex;
    this.transform = new THREE.Vector4(0, 0, 1, 1);

    return {
      texture: this.texture,
      transform: this.transform,
      resolution: this.resolution,
      threshold: this.threshold,
      hasWater: this._hasWater
    };
  }

  dispose() {
    if (this.texture && typeof this.texture.dispose === 'function') {
      this.texture.dispose();
    }
    this.texture = null;
    this.transform = null;
    this._hasWater = false;
  }

  _detectUseAlpha(rgba) {
    let rMin = 255;
    let rMax = 0;
    let aMin = 255;
    let aMax = 0;

    for (let i = 0; i < rgba.length; i += 16) {
      const r = rgba[i];
      const a = rgba[i + 3];
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (a < aMin) aMin = a;
      if (a > aMax) aMax = a;
    }

    const rRange = rMax - rMin;
    const aRange = aMax - aMin;
    return aRange > rRange + 8;
  }

  _distanceTransform(mask01, w, h, toWater) {
    const INF = 1e9;
    const SQRT2 = 1.41421356237;
    const dist = new Float32Array(w * h);

    for (let i = 0; i < w * h; i++) {
      const isWater = mask01[i] === 1;
      const feature = toWater ? isWater : !isWater;
      dist[i] = feature ? 0.0 : INF;
    }

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const idx = row + x;
        let d = dist[idx];

        if (x > 0) d = Math.min(d, dist[idx - 1] + 1.0);
        if (y > 0) d = Math.min(d, dist[idx - w] + 1.0);
        if (x > 0 && y > 0) d = Math.min(d, dist[idx - w - 1] + SQRT2);
        if (x < w - 1 && y > 0) d = Math.min(d, dist[idx - w + 1] + SQRT2);

        dist[idx] = d;
      }
    }

    for (let y = h - 1; y >= 0; y--) {
      const row = y * w;
      for (let x = w - 1; x >= 0; x--) {
        const idx = row + x;
        let d = dist[idx];

        if (x < w - 1) d = Math.min(d, dist[idx + 1] + 1.0);
        if (y < h - 1) d = Math.min(d, dist[idx + w] + 1.0);
        if (x < w - 1 && y < h - 1) d = Math.min(d, dist[idx + w + 1] + SQRT2);
        if (x > 0 && y < h - 1) d = Math.min(d, dist[idx + w - 1] + SQRT2);

        dist[idx] = d;
      }
    }

    return dist;
  }

  _sdfAt(distToLand, distToWater, mask01, w, h, x, y) {
    const ix = Math.max(0, Math.min(w - 1, x));
    const iy = Math.max(0, Math.min(h - 1, y));
    const idx = iy * w + ix;
    const isWater = mask01[idx] === 1;
    return isWater ? -distToLand[idx] : distToWater[idx];
  }

  _clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }
}
