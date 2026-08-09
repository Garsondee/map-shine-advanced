/**
 * Shader Lab driver — CANDLE FLAME. Imports the REAL production material and
 * geometry builders (`src/effects/candle-flame-render.js`), unmodified, and
 * draws a grid of flames at three sizes so the silhouette, the colour ramp and
 * the per-candle desync can all be judged at once — same doctrine as
 * `lightning-lab.js`, see `docs/planning/Shader-Lab.md`.
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS (2026-08-06)
 * ============================================================================
 *
 * The candle flame is a LOOK, and until now the only way to see one was to
 * boot Foundry, open a scene, and squint at a 24px sprite. Every constant in
 * `candle-flame-render.js`'s shape/colour block was therefore tuned blind and
 * annotated "tuned by eye… NOT live-verified". `feedback_shader_lab_
 * investment_priority` (project memory) is explicit that the tool itself is
 * the thing worth building — so a colour/shape pass on the flame starts by
 * making the flame VISIBLE at a size a human can actually judge.
 *
 * ⚠️ WHAT THIS BENCH DOES *NOT* PROVE. It renders the flame BILLBOARD only.
 * The candle's cast POINT LIGHT (`candle-flicker.js` + the shared light-mesh
 * pool) is a different subsystem that needs Foundry wall data, and the scene
 * this draws over is a flat backdrop, not `buf:scene.lit` with a real
 * tonemapper behind it. So this answers "what shape and what colours does the
 * flame emit" honestly and answers "how does it sit in a finished frame" only
 * approximately (`feedback_instruments_must_not_lie` — say which half is
 * real). The backdrop selector exists precisely so the additive blend can be
 * sanity-checked against something other than pure black.
 *
 * @module tools/shader-lab/candle-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { buildCandleFlameGeometry, buildCandleFlameMaterial } from '../../src/effects/candle-flame-render.js';

const statusEl = document.getElementById('candleStatus');
const log = (msg) => {
  console.log('[candle-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

/** World extent the camera frames — matches the canvas aspect so nothing squashes. */
const WORLD_W = 1024;
const WORLD_H = 768;

/**
 * The candle layout: three size bands, so a change can be judged at the size
 * it will actually ship at (the ~24-30px in-game default, bottom row) AND at
 * a size where the silhouette's own detail is legible (top row). Per-anchor
 * `useCustomSize` is the REAL production override path (`resolveAnchorSizePx`),
 * not a lab-only shortcut — so this exercises that code too.
 */
const LAYOUT = [
  { y: 250, size: 300, xs: [190, 512, 834] },
  { y: 540, size: 130, xs: [140, 326, 512, 698, 884] },
  { y: 690, size: 56, xs: [140, 250, 360, 470, 580, 690, 800, 910] },
];

class CandleLab {
  constructor() {
    this.renderer = null;
    this.camera = null;
    this.scene = null;
    this.mesh = null;
    this.material = null;
    this.uniforms = null;
    this.uGlobalTimeMs = null;
    this._rafId = null;
    this._active = false;
    this._virtualNowMs = 0;
    this._lastRafRealMs = null;
    this._queryRt = null;

    this.state = {
      quality: 2,
      colorHex: '#ffaa00',
      sizePx: 30, // the effect-wide fallback; every anchor below overrides it
      wind: true,
      paused: false,
      backdrop: 0x000000,
    };
  }

  async init(canvas) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
    await this.renderer.init();
    log(`renderer backend: ${this.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
    this.renderer.setClearColor(this.state.backdrop, 1);

    // ⚠️ THE Y-FLIP, COPIED FROM PRODUCTION ON PURPOSE. `vt-pan-viewer.js#
    // updateCamera` sets `top = minY` (top < bottom), which is what makes the
    // flame's own `-Y` spine point UP on screen. A lab camera with the
    // conventional top > bottom would render every flame upside-down and send
    // me hunting a shape bug that does not exist — exactly the recurring trap
    // `feedback_y_flip_recurring_risk` names.
    this.camera = new THREE.OrthographicCamera(0, WORLD_W, 0, WORLD_H, 0.1, 1000);
    this.camera.position.set(0, 0, 100);
    this.camera.updateProjectionMatrix();

    this.scene = new THREE.Scene();
    this.uGlobalTimeMs = THREE.TSL.uniform(THREE.TSL.float(0));

    this._rebuildMaterial();
    this._rebuildGeometry();

    this._frame = this._frame.bind(this);
    this._rafId = requestAnimationFrame(this._frame);
  }

  /** The anchor list the REAL `computeCandleFlameArrays` consumes. */
  _anchors() {
    const out = [];
    for (const band of LAYOUT) {
      for (const x of band.xs) {
        out.push({
          id: `lab:${x}:${band.y}`,
          x,
          y: band.y,
          windExposure: 1, // fully open to the wind, so the lean/gutter is visible
          params: { intensity: 1, useCustomSize: true, customSizePx: band.size },
        });
      }
    }
    return out;
  }

  /** Quality is a BUILD-time tier (Effects.md Law 4 — a tier that is off must
   * never be constructed), so changing it rebuilds the material rather than
   * flipping a uniform. */
  _rebuildMaterial() {
    const built = buildCandleFlameMaterial({
      THREE,
      uGlobalTimeMs: this.uGlobalTimeMs,
      quality: this.state.quality,
    });
    this.material = built.material;
    this.uniforms = built;
    this.uniforms.uWindResponse.value = this.state.wind ? 1 : 0;
    if (this.mesh) {
      this.mesh.material = this.material;
    }
  }

  _rebuildGeometry() {
    const { geometry, quadCount } = buildCandleFlameGeometry(THREE, this._anchors(), {
      sizePx: this.state.sizePx,
      colorHex: this.state.colorHex,
    });
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this._quadCount = quadCount;
  }

  setQuality(n) {
    this.state.quality = Math.max(0, Math.min(2, Math.round(Number(n) || 0)));
    this._rebuildMaterial();
    this._rebuildGeometry();
  }

  setColor(hex) {
    this.state.colorHex = hex;
    this._rebuildGeometry();
  }

  setSize(px) {
    this.state.sizePx = Number(px) || 30;
    this._rebuildGeometry();
  }

  setWind(on) {
    this.state.wind = !!on;
    if (this.uniforms) this.uniforms.uWindResponse.value = on ? 1 : 0;
  }

  setPaused(v) {
    this.state.paused = !!v;
  }

  setBackdrop(hex) {
    this.state.backdrop = hex;
    this.renderer.setClearColor(hex, 1);
  }

  setActive(v) {
    this._active = !!v;
    if (!this._active) this._lastRafRealMs = null;
    if (this._active && this._rafId === null) this._rafId = requestAnimationFrame(this._frame);
  }

  /** THE ONE place time advances — a VIRTUAL clock, deliberately decoupled from
   * wall time. `requestAnimationFrame` is FULLY PAUSED (not throttled) while the
   * Browser pane is not the displayed one, so a driver that can only animate via
   * rAF silently does nothing whenever nobody is watching. Every scripted
   * verification calls `advance()` directly instead. (The identical note, and
   * the measurement behind it, is in `lightning-lab.js`.) */
  advance(deltaMs) {
    this._virtualNowMs += Math.max(0, Number(deltaMs) || 0);
    this.uGlobalTimeMs.value = this._virtualNowMs;
    this.renderer.render(this.scene, this.camera);
    return this._virtualNowMs;
  }

  _frame(realMs) {
    if (this._active) {
      const delta = this._lastRafRealMs === null ? 16 : realMs - this._lastRafRealMs;
      this._lastRafRealMs = realMs;
      this.advance(this.state.paused ? 0 : Math.max(0, Math.min(250, delta)));
      this._updateLegend();
    }
    this._rafId = requestAnimationFrame(this._frame);
  }

  _updateLegend() {
    const el = document.getElementById('candleLegend');
    if (!el) return;
    const names = ['0 low (calm)', '1 standard (life+wind+gutter)', '2 lavish (+domain warp)'];
    el.textContent =
      `CANDLE bench — quality=${names[this.state.quality]}  candles=${this._quadCount}  ` +
      `colour=${this.state.colorHex}  wind=${this.state.wind ? 'on' : 'off'}  ` +
      `t=${(this._virtualNowMs / 1000).toFixed(1)}s\n` +
      `sizes: ${LAYOUT.map((b) => `${b.xs.length}×${b.size}px`).join('  ')}`;
  }

  /**
   * Read back the average linear RGB inside a box around one world point —
   * the numeric half of this bench, so a colour claim can be CHECKED rather
   * than eyeballed off a screenshot (`feedback_measure_the_output_not_the_
   * equation`). Renders one extra offscreen frame at the query resolution;
   * never touches the on-screen loop.
   */
  async samplePatch(worldX, worldY, halfPx = 24) {
    const dim = 512;
    if (!this._queryRt) {
      this._queryRt = new THREE.RenderTarget(dim, dim, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    }
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._queryRt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);

    const sx = dim / WORLD_W;
    const sy = dim / WORLD_H;
    // Camera is Y-FLIPPED (top = world minY), so world +y already maps DOWN the
    // render target's own rows — no second inversion here, which is the exact
    // spot a Y-flip bug would hide.
    const x0 = Math.max(0, Math.min(dim - 1, Math.round((worldX - halfPx) * sx)));
    const y0 = Math.max(0, Math.min(dim - 1, Math.round((worldY - halfPx) * sy)));
    const w = Math.max(1, Math.min(dim - x0, Math.round(halfPx * 2 * sx)));
    const h = Math.max(1, Math.min(dim - y0, Math.round(halfPx * 2 * sy)));
    const buf = await this.renderer.readRenderTargetPixelsAsync(this._queryRt, x0, y0, w, h);
    const bytes = ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
    let r = 0;
    let g = 0;
    let b = 0;
    let lit = 0;
    let peak = { r: 0, g: 0, b: 0, sum: -1 };
    for (let i = 0; i < bytes.length; i += 4) {
      const sum = bytes[i] + bytes[i + 1] + bytes[i + 2];
      if (sum <= 12) continue; // background / far-field glow — not the flame body
      lit++;
      r += bytes[i];
      g += bytes[i + 1];
      b += bytes[i + 2];
      if (sum > peak.sum) peak = { r: bytes[i], g: bytes[i + 1], b: bytes[i + 2], sum };
    }
    const hex = (a, bb, c) => `#${[a, bb, c].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    return {
      litPixels: lit,
      meanHex: lit ? hex(r / lit, g / lit, b / lit) : null,
      peakHex: lit ? hex(peak.r, peak.g, peak.b) : null,
    };
  }

  /**
   * Render one frame OFFSCREEN and POST it to `/__lab/artifact` as a PNG.
   *
   * ⚠️ WHY NOT JUST SCREENSHOT THE CANVAS. Confirmed live in this environment:
   * when the Browser pane is not the displayed one the page stops compositing
   * entirely, so a screenshot times out and `canvas.toBlob()` has no
   * guaranteed swap-chain contents to read. This path never touches the
   * on-screen canvas at all — it renders into its own RenderTarget, reads the
   * pixels back on the GPU queue, and rebuilds the image in a plain 2D canvas.
   * It therefore produces identical bytes whether or not anybody is watching,
   * which is the whole point (`feedback_instruments_must_not_lie`).
   *
   * Alpha is forced opaque: the flame's own alpha IS its emission (additive
   * blending), so an honest RGBA PNG would come out mostly transparent and
   * read as "the flame is missing" in any viewer that mattes it onto white.
   */
  async capture({ width = 1024, height = 768, run = 'candle', file = 'frame.png', flipY = false } = {}) {
    const rt = new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    const raw = await this.renderer.readRenderTargetPixelsAsync(rt, 0, 0, width, height);
    const src = ArrayBuffer.isView(raw) ? raw : new Uint8Array(raw);

    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const sy = flipY ? height - 1 - y : y;
      for (let x = 0; x < width; x++) {
        const si = (sy * width + x) * 4;
        const di = (y * width + x) * 4;
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
        out[di + 3] = 255;
      }
    }
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d').putImageData(new ImageData(out, width, height), 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    rt.dispose();
    const res = await fetch(`/__lab/artifact?run=${run}&file=${file}`, { method: 'POST', body: blob });
    return res.json();
  }

  /** Mean/peak colour of each size band's middle candle — the one call a
   * verification pass needs to say "the palette landed" with numbers. */
  async paletteReport() {
    const out = [];
    for (const band of LAYOUT) {
      const x = band.xs[Math.floor(band.xs.length / 2)];
      out.push({
        size: band.size,
        ...(await this.samplePatch(x, band.y - band.size * 0.12, band.size * 0.32)),
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------
const lab = new CandleLab();
window.candleLab = lab;

const canvas = document.getElementById('candleView');
if (canvas) {
  lab
    .init(canvas)
    .then(() => log('Candle Lab ready (window.candleLab).'))
    .catch((err) => log(`INIT FAILED: ${err.stack || err.message}`));

  document.getElementById('candleWind')?.addEventListener('change', (e) => lab.setWind(e.target.checked));
  document.getElementById('candlePaused')?.addEventListener('change', (e) => lab.setPaused(e.target.checked));
  document.getElementById('candleColor')?.addEventListener('input', (e) => lab.setColor(e.target.value));
  document.getElementById('candleBackdrop')?.addEventListener('change', (e) => lab.setBackdrop(Number(e.target.value)));

  const sizeEl = document.getElementById('candleSize');
  const sizeVal = document.getElementById('candleSizeVal');
  if (sizeEl) {
    const show = () => {
      if (sizeVal) sizeVal.textContent = sizeEl.value;
    };
    show();
    sizeEl.addEventListener('input', () => {
      lab.setSize(Number(sizeEl.value));
      show();
    });
  }

  document.querySelectorAll('#candlePanel button[data-cqual]').forEach((btn) => {
    btn.addEventListener('click', () => {
      lab.setQuality(Number(btn.dataset.cqual));
      document
        .querySelectorAll('#candlePanel button[data-cqual]')
        .forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  document.querySelector(`#candlePanel button[data-cqual="${lab.state.quality}"]`)?.classList.add('active');

  // This driver's own CONTROLS panel + rAF loop. The VIEW column belongs to
  // view-visibility.js (its header explains why that is one file's job).
  const effectSelect = document.getElementById('effect');
  const panel = document.getElementById('candlePanel');
  const apply = (value) => {
    const isCandle = value === 'candle';
    if (panel) panel.style.display = isCandle ? '' : 'none';
    lab.setActive(isCandle);
  };
  effectSelect?.addEventListener('change', (e) => apply(e.target.value));
  apply(effectSelect?.value ?? 'sun-shadow');
}
